// The assistant fulfills observed facts through a local CLI. No cookies, CDP or
// browser execution endpoint is exposed by this bridge.
import { randomUUID } from "node:crypto";
import { assertQualityExecutionAllowed } from "./quality-policy.mjs";
import { realpathSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { dataDir } from "./config.mjs";
import { hash } from "./tasks.mjs";
import { destination } from "./delivery.mjs";
import { validatePublicationFields } from "./search-publication.mjs";
import { parseSearchCard } from "./search-card.mjs";
import { classifyGamePublication } from "./game-search-scope.mjs";
import { redfoxGameScope, validateRedfoxGameResult } from "./redfox-game-source.mjs";
import { redfoxHotspotScope, validateRedfoxHotspotResult } from "./redfox-hotspot-source.mjs";
import { isSourceErrorCode, persistedSourceErrorCode } from "./source-errors.mjs";
import {
  resolveCategory,
  categoryId,
  collectionTargets,
} from "./categories.mjs";
const kinds = new Set([
  "search",
  "web",
  "media",
  "delivery",
  "transcript-review",
]);
const terminal = new Set([
  "fulfilled",
  "failed",
  "cancelled",
  "expired",
  "unknown",
]);
const now = () => new Date().toISOString();
function fail(message, code = "BRIDGE_INVALID") {
  const e = Error(message);
  e.code = code;
  throw e;
}
function text(v, name, max = 20000) {
  if (typeof v !== "string" || !v.trim() || v.length > max) fail(`${name}无效`);
  return v.trim();
}
function gameSearchResultUpdate(update, observed) {
  if (!update || update.method !== "changed-visible-cards-and-stable-scope")
    fail("游戏搜索缺少筛选后可见列表更新证据");
  let textSize = 0;
  const cards = (items, minimum) => {
    if (!Array.isArray(items) || items.length < minimum || items.length > 200)
      fail("游戏搜索更新卡片数量无效");
    const ids = new Set();
    return items.map(item => {
      if (typeof item?.source_id !== "string" || !/^\d{10,25}$/.test(item.source_id) || ids.has(item.source_id) ||
          typeof item.text !== "string" || item.text.length > 8000 || item.text !== item.text.trim())
        fail("游戏搜索更新卡片身份或原文无效");
      ids.add(item.source_id);textSize += item.text.length;
      if (textSize > 1000000) fail("游戏搜索更新原文超过核验上限");
      return {source_id:item.source_id,text:item.text};
    });
  };
  const before = cards(update.before_cards,0), after = cards(update.after_cards,1);
  const beforeHash = hash(before), afterHash = hash(after);
  const beforeIds = new Set(before.map(card=>card.source_id)), afterIds = new Set(after.map(card=>card.source_id));
  const changed = [...beforeIds].filter(id=>!afterIds.has(id)).length + [...afterIds].filter(id=>!beforeIds.has(id)).length;
  if (update.before_fingerprint !== beforeHash || update.after_fingerprint !== afterHash || beforeHash === afterHash ||
      !changed || update.changed_identity_count !== changed || update.card_count !== after.length ||
      !Number.isSafeInteger(update.stable_observations) || update.stable_observations < 3)
    fail("游戏搜索更新指纹、身份变化或稳定观察不一致");
  const labels = {sort:["综合排序","最新发布","最多点赞"],time:["不限","一天内","一周内","半年内"]};
  if (!Array.isArray(update.transitions) || !update.transitions.length || update.transitions.length > 2)
    fail("游戏搜索缺少实际筛选选项转移");
  const groups = new Set();
  const transitions = update.transitions.map(transition => {
    const group = transition?.group;
    if (!Object.hasOwn(labels,group) || groups.has(group) || !labels[group].includes(transition.from) ||
        transition.to !== observed[`${group}_label`] || transition.from === transition.to)
      fail("游戏搜索筛选转移未匹配实际目标");
    groups.add(group);
    return {group,from:transition.from,to:transition.to};
  });
  return {method:update.method,before_cards:before,after_cards:after,before_fingerprint:beforeHash,after_fingerprint:afterHash,
    changed_identity_count:changed,card_count:after.length,stable_observations:update.stable_observations,transitions};
}
function gameCollectionBatches(value, observed, update, payload, searchedAt, requestCreatedAt) {
  if (!Array.isArray(value.collection_batches) || !value.collection_batches.length || value.collection_batches.length > 10 ||
      !Array.isArray(value.excluded_records) || value.excluded_records.length > 2000)
    fail("游戏搜索缺少有界采集批次或排除记录");
  let textSize = [...update.before_cards,...update.after_cards].reduce((sum,card)=>sum+card.text.length,0);
  // A valid old relative-date observation cannot become evidence for a new
  // request merely by receiving that request's local provenance ID.
  let previousAt = Date.parse(date(requestCreatedAt));
  const lastCards = new Map();
  const observedUrl = `https://www.douyin.com/search/${encodeURIComponent(observed.keyword)}?type=video`;
  const batches = value.collection_batches.map(batch => {
    const scope = batch?.scope;
    if (!scope || Object.keys(scope).length !== Object.keys(observed).length ||
        Object.keys(observed).some(key=>key !== "selection_evidence" && scope[key] !== observed[key]) ||
        Object.keys(scope.selection_evidence || {}).length !== 3 ||
        ["type","time","sort"].some(key=>scope.selection_evidence[key] !== observed.selection_evidence[key]))
      fail("游戏搜索批次实际范围发生变化或未核验");
    const at = date(batch.observed_at), time = Date.parse(at);
    if (time < previousAt || time > Date.parse(searchedAt)) fail("游戏搜索批次时间顺序无效");
    previousAt = time;
    if (!Array.isArray(batch.cards) || !batch.cards.length || batch.cards.length > 200)
      fail("游戏搜索批次卡片数量无效");
    const ids = new Set();
    const cards = batch.cards.map(card => {
      if (typeof card?.source_id !== "string" || !/^\d{10,25}$/.test(card.source_id) || ids.has(card.source_id) ||
          typeof card.text !== "string" || card.text.length > 8000 || card.text !== card.text.trim())
        fail("游戏搜索批次卡片身份或原文无效");
      ids.add(card.source_id);textSize += card.text.length;
      if (textSize > 1000000) fail("游戏搜索批次原文超过核验上限");
      const parsed = parseSearchCard({url:`https://www.douyin.com/video/${card.source_id}`,text:card.text},observedUrl,at);
      if (!parsed) fail("游戏搜索批次原卡不可解析，未隐去来源缺口");
      const freshness = classifyGamePublication(parsed,{hours:observed.hours,observedAt:at});
      if (freshness === "outside") fail("游戏搜索实际卡片日期超出请求范围");
      lastCards.set(card.source_id,{parsed,freshness});
      return {source_id:card.source_id,text:card.text};
    });
    return {cards,scope:observed,observed_at:at};
  });
  if (hash(batches[0].cards) !== update.after_fingerprint)
    fail("游戏搜索首批卡片与筛选后稳定列表不一致");
  const accounted = new Set();
  const limit = payload.limit || 30;
  if (!value.records.length) fail("游戏搜索没有范围内已确认视频，不能以日期未知卡片证明空结果");
  if (value.records.length > limit) fail("游戏搜索实际输出超过请求采样上限");
  const fields = ["kind","source_id","source_url","title","author","like_count","like_display","metric_precision",
    "score","source_rank","play_count","published_text","publication_precision","published_date","collected_at"];
  for (const row of value.records) {
    const last = lastCards.get(row.source_id);
    if (!last || accounted.has(row.source_id) || last.freshness !== "within" ||
        fields.some(key=>row[key] !== last.parsed[key]))
      fail("游戏搜索记录未对应最后一次同范围原卡或日期不可确认");
    accounted.add(row.source_id);
  }
  const excluded = value.excluded_records.map(row => {
    const last = lastCards.get(row?.source_id);
    if (!last || accounted.has(row.source_id) || row.published_text !== last.parsed.published_text ||
        row.publication_precision !== last.parsed.publication_precision ||
        !((row.reason === "publication_unknown" && last.freshness === "unknown") ||
          (row.reason === "sample_limit" && last.freshness === "within" && value.records.length === limit)))
      fail("游戏搜索排除原因或原卡日期证据不一致");
    accounted.add(row.source_id);
    return {source_id:row.source_id,published_text:row.published_text,publication_precision:row.publication_precision,reason:row.reason};
  });
  if (accounted.size !== lastCards.size) fail("游戏搜索批次存在未交代的原卡，不能静默丢弃");
  return {collection_batches:batches,excluded_records:excluded};
}
function observedGameSearchScope(value, payload) {
  const marker = "douyin_visible_search";
  const claimed = value.source_endpoint !== undefined || value.observed_scope !== undefined || value.result_update !== undefined ||
    value.collection_batches !== undefined || value.excluded_records !== undefined ||
    value.records.some(row=>row?.source_endpoint !== undefined);
  if (!claimed) return null; // Legacy externally supplied observations remain explicitly unverified.
  if ((value.source_endpoint !== undefined && value.source_endpoint !== marker) ||
      value.records.some(row=>row?.source_endpoint !== undefined && row.source_endpoint !== marker))
    fail("游戏搜索来源标记无效");
  const observed = value.observed_scope;
  const timeLabels = {24:"一天内",168:"一周内"};
  const sortLabels = {likes:"最多点赞",recent:"最新发布",relevance:"综合排序"};
  const evidence = new Set(["aria-checked","aria-selected","checked"]);
  if (!observed || observed.site !== "douyin" || observed.type !== "video" ||
      observed.keyword !== payload.keyword.normalize("NFKC").trim() ||
      !Object.hasOwn(timeLabels,payload.hours) || observed.hours !== payload.hours ||
      observed.sort !== payload.sort || observed.time_label !== timeLabels[payload.hours] ||
      observed.sort_label !== sortLabels[payload.sort] ||
      !(evidence.has(observed.selection_evidence?.type) || observed.selection_evidence?.type === "video-url-and-links") ||
      !["time","sort"].every(key=>evidence.has(observed.selection_evidence?.[key]) || observed.selection_evidence?.[key] === "observed-group-class"))
    fail("游戏搜索observed_scope未证明实际视频类型、时间及排序与请求一致");
  return {site:"douyin",type:"video",keyword:observed.keyword,hours:observed.hours,sort:observed.sort,
    time_label:observed.time_label,sort_label:observed.sort_label,
    selection_evidence:Object.fromEntries(["type","time","sort"].map(key=>[key,observed.selection_evidence[key]]))};
}
// Expanded limits apply only to validated, contiguous normal-page receipts.
// This validates the collector's evidence contract; it does not make requests
// or infer that the platform's stated total was actually accessible.
function rankingPagination(value, records, observed, payload) {
  if (value == null || typeof value !== "object" || Array.isArray(value) ||
      payload.purpose !== "hotspots" || !observed ||
      value.max_pages_per_board !== 50 || value.max_rows_per_board !== 1500 ||
      !Array.isArray(value.boards) || !value.boards.length || value.boards.length > 5)
    fail("分页证据结构或来源范围无效");
  const boardIds = new Set(value.boards.map(board => board?.board));
  if (boardIds.size !== value.boards.length || boardIds.size !== observed.boards.length ||
      observed.boards.some(board => !boardIds.has(board)) ||
      [...boardIds].some(board => ![1001,1002,1003,1004,1005].includes(board)) ||
      records.some(row => row.kind !== "video" || row.source_endpoint !== "douhot-page-response" || !boardIds.has(row.sub_type)))
    fail("分页证据与实际视频榜记录不匹配");
  const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
  const boards = value.boards.map(board => {
    if (board.hours !== observed.hours || board.category !== observed.category ||
        board.status !== "accessible_complete" || !Array.isArray(board.pages) ||
        !board.pages.length || board.pages.length > 50)
      fail("分页榜单范围或连续页证据无效");
    const rows = records.filter(row => row.sub_type === board.board);
    const ids = new Set(rows.map(row => row.source_id));
    if (rows.length > 1500 || ids.size !== rows.length)
      fail("同榜分页视频ID重复或超过行数上限，不能静默合并");
    const first = board.pages[0];
    const pages = board.pages.map((page, index) => {
      if (!page || page.page !== index + 1 || !integer(page.page_size,1,1000) ||
          !integer(page.total,0,Number.MAX_SAFE_INTEGER) || !integer(page.actual_count,0,page.page_size) ||
          page.actual_count > page.total || page.page_size !== first.page_size || page.total !== first.total)
        fail("分页页码必须从1连续且每页元数据一致");
      const pageRows = rows.filter(row => row.page === page.page);
      const positions = pageRows.map(row => row.position_in_response).sort((a,b)=>a-b);
      if (pageRows.length !== page.actual_count || positions.some((position,i)=>position !== i+1))
        fail("分页实际条数或行位置与页面证据不匹配");
      return {page:page.page,page_size:page.page_size,total:page.total,actual_count:page.actual_count};
    });
    const count = pages.reduce((sum,page)=>sum+page.actual_count,0);
    const last = pages.length;
    if (rows.some(row=>!integer(row.page,1,last)) || count !== rows.length ||
        board.collected_count !== count || board.metadata_total !== first.total ||
        count > first.total || board.metadata_total_difference !== first.total-count)
      fail("分页记录归属或合计与来源总数不一致");
    if (last !== Math.max(1, Math.ceil(first.total / first.page_size)) ||
        board.terminal?.page !== last || board.terminal?.observed_current_page !== last ||
        board.terminal?.next_disabled !== true)
      fail("分页终点缺少当前页与真实下一页禁用证据");
    return {board:board.board,hours:board.hours,category:board.category,pages,
      collected_count:count,metadata_total:first.total,metadata_total_difference:first.total-count,
      status:"accessible_complete",terminal:{page:last,next_disabled:true,observed_current_page:last}};
  });
  return {max_pages_per_board:50,max_rows_per_board:1500,boards};
}
function date(v) {
  if (
    typeof v !== "string" ||
    !Number.isFinite(Date.parse(v)) ||
    Date.parse(v) > Date.now() + 5 * 60000
  )
    fail("观察时间无效或在未来");
  return v;
}
function https(v, host) {
  let u;
  try {
    u = new URL(v);
  } catch {
    fail("来源URL无效");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (host && u.hostname !== host) ||
    ["localhost", "[::1]"].includes(u.hostname) ||
    /^\d+\./.test(u.hostname)
  )
    fail("来源URL无效");
  return u.href;
}
function redfoxScope(payload, at) {
  return payload.purpose === "hotspots" ? redfoxHotspotScope(payload, at) : redfoxGameScope(payload, at);
}
function redfoxScopeKey(payload, at) {
  const scope = redfoxScope(payload, at);
  return JSON.stringify([payload.purpose, "redfox", payload.keyword, payload.board,
    payload.hours, payload.category, payload.sort, scope.start_date, scope.end_date]);
}
function validateRedfoxSearchInput(input) {
  const purpose = input.purpose === "game-research" || input.scope === "game" ? "game-research" : input.purpose;
  if (!["game-research", "game-learning", "hotspots"].includes(purpose)) fail("红狐搜索用途无效");
  const keyword = input.keyword ?? "";
  if (typeof keyword !== "string" || keyword.length > 80) fail("关键词不能超过80字");
  const game = purpose !== "hotspots";
  const payload = {provider:"redfox", purpose, keyword:keyword.normalize("NFKC").trim(),
    board:input.board ?? (game ? null : "redfox_daily_hot"), hours:input.hours ?? (game ? 168 : 24),
    category:input.category ?? "all", sort:input.sort ?? "likes",
    ...(game ? {minimum_required:20,target:30,limit:30} : {})};
  if ((game && (payload.board !== null || payload.category !== "all")) ||
      !["likes", "recent", "relevance"].includes(payload.sort)) fail("红狐榜单、行业或排序无效");
  redfoxScope(payload, now()); // validates the provider's own contract, never Douhot categories
  return payload;
}
export function validateSearchInput(input = {}) {
  if (input.provider === "redfox") return validateRedfoxSearchInput(input);
  if (input.provider != null && input.provider !== "browser") fail("搜索来源无效");
  const keyword = input.keyword ?? "";
  if (typeof keyword !== "string" || keyword.length > 80)
    fail("关键词不能超过80字");
  const hours =
      input.hours ??
      (input.purpose === "game-learning"
        ? 4320
        : input.purpose === "game-research" || input.scope === "game"
          ? 168
          : 24),
    board = input.board ?? null;
  if (
    ![1, 24, 72, 168].includes(hours) &&
    !(
      (["game-learning", "game-research"].includes(input.purpose) ||
        input.scope === "game") &&
      hours === 4320
    )
  )
    fail("时间窗口无效");
  if (
    board !== null &&
    ![1001, 1002, 1003, 1004, 1005, 2001, 2002, 3001, 3002].includes(board)
  )
    fail("榜单无效");
  const purpose =
    input.purpose === "game-learning"
      ? "game-learning"
      : input.purpose === "game-research" || input.scope === "game"
        ? "game-research"
        : input.purpose === "courses"
          ? "courses"
          : input.purpose === "related-work"
            ? "related-work"
            : "hotspots";
  const category = resolveCategory(input.category)?.id || "all";
  if (purpose === "hotspots") collectionTargets({ board, hours, category });
  return {
    keyword: keyword.trim(),
    hours,
    board,
    category,
    sort: ["likes", "relevance", "recent"].includes(input.sort)
      ? input.sort
      : "likes",
    purpose,
    ...(["game-learning", "game-research"].includes(purpose)
      ? { minimum_required: 20, target: 30, limit: 30 }
      : {}),
    ...(purpose === "related-work"
      ? { target_game: text(input.target_game, "目标游戏", 40) }
      : {}),
  };
}
export class SideBridge {
  constructor(db, { folder = dataDir, timeoutMs = 30 * 60000 } = {}) {
    this.db = db;
    this.folder = resolve(folder);
    this.timeoutMs = timeoutMs;
    db.db.exec(`CREATE TABLE IF NOT EXISTS bridge_requests(
      id TEXT PRIMARY KEY, request_key TEXT, kind TEXT, task_id TEXT, state TEXT,
      payload TEXT, result TEXT, error TEXT, created_at TEXT, expires_at TEXT, updated_at TEXT);
      CREATE INDEX IF NOT EXISTS bridge_key ON bridge_requests(request_key);`);
  }
  decode(r) {
    return r
      ? {
          ...r,
          payload: JSON.parse(r.payload),
          result: r.result ? JSON.parse(r.result) : null,
          error_code: r.state === "failed" ? persistedSourceErrorCode(r.error) : null,
        }
      : null;
  }
  get(id) {
    return this.decode(
      this.db.db.prepare("SELECT * FROM bridge_requests WHERE id=?").get(id),
    );
  }
  update(id, state, result = null, error = null) {
    this.db.db
      .prepare(
        "UPDATE bridge_requests SET state=?,result=?,error=?,updated_at=? WHERE id=?",
      )
      .run(
        state,
        result === null ? null : JSON.stringify(result),
        error,
        now(),
        id,
      );
    return this.get(id);
  }
  sweep() {
    for (const raw of this.db.db
      .prepare(
        "SELECT * FROM bridge_requests WHERE state IN ('pending','awaiting_approval','approved','writing')",
      )
      .all()) {
      const task = raw.task_id ? this.db.get(raw.task_id) : null;
      if (
        raw.task_id &&
        (!task ||
          task.cancelled ||
          [
            "failed",
            "cancelled",
            "completed",
            "completed_with_warnings",
          ].includes(task.state))
      )
        this.update(
          raw.id,
          raw.state === "writing" ? "unknown" : "cancelled",
          null,
          raw.state === "writing"
            ? "外部写入期间任务结束，必须回读核验，禁止自动重发"
            : "关联任务已结束或取消",
        );
      else if (Date.parse(raw.expires_at) <= Date.now())
        this.update(
          raw.id,
          raw.state === "writing" ? "unknown" : "expired",
          null,
          raw.state === "writing"
            ? "外部写入结果未知，必须回读核验，禁止自动重发"
            : "助手协作请求已超时，请重新发起",
        );
    }
  }
  list() {
    this.sweep();
    return this.db.db
      .prepare(
        "SELECT * FROM bridge_requests ORDER BY created_at DESC LIMIT 100",
      )
      .all()
      .map((r) => this.decode(r));
  }
  public(r) {
    if (!r) return null;
    const { request_key, ...safe } = r;
    return safe;
  }
  // Public UI collections are separate from task-owned research requests. This
  // lookup is read-only: no sweep, state updates, recent-list cap, or task leak.
  latestSearchForScope(input = {}) {
    const scope = validateSearchInput(input);
    if (scope.purpose === "courses") return null;
    if (!["game-research", "hotspots"].includes(scope.purpose))
      fail("仅支持游戏广场或热点广场的搜索范围");
    let raw;
    if (scope.provider === "redfox") {
      const expected = redfoxScopeKey(scope, now());
      raw = this.db.db.prepare(`SELECT * FROM bridge_requests WHERE kind='search' AND task_id IS NULL
        AND json_extract(payload,'$.provider')='redfox' AND json_extract(payload,'$.purpose')=?
        ORDER BY created_at DESC,rowid DESC`).all(scope.purpose).find(row => {
          try { return redfoxScopeKey(JSON.parse(row.payload), row.created_at) === expected; } catch { return false; }
        });
      return this.public(this.decode(raw));
    }
    if (scope.purpose === "game-research") {
      raw = this.db.db
        .prepare(
          `SELECT * FROM bridge_requests
        WHERE kind='search' AND task_id IS NULL
          AND COALESCE(json_extract(payload,'$.provider'),'browser') != 'redfox'
          AND json_extract(payload,'$.purpose')=?
          AND json_extract(payload,'$.keyword')=?
        ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        )
        .get(scope.purpose, scope.keyword);
    } else {
      raw = this.db.db
        .prepare(
          `SELECT * FROM bridge_requests
        WHERE kind='search' AND task_id IS NULL
          AND COALESCE(json_extract(payload,'$.provider'),'browser') != 'redfox'
          AND json_extract(payload,'$.purpose')=?
          AND json_extract(payload,'$.keyword')=?
          AND json_extract(payload,'$.board') IS ?
          AND json_extract(payload,'$.hours')=?
          AND json_extract(payload,'$.category')=?
        ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        )
        .get(
          scope.purpose,
          scope.keyword,
          scope.board,
          scope.hours,
          scope.category,
        );
    }
    return this.public(this.decode(raw));
  }
  status() {
    const rows = this.list();
    return {
      mode: "side-browser",
      assistant_required: true,
      description: "由当前助手读取右侧浏览器并回填证据；助手离线时暂停等待",
      pending: rows
        .filter((r) => !terminal.has(r.state))
        .map((r) => this.public(r)),
      recent: rows
        .filter((r) => terminal.has(r.state))
        .slice(0, 20)
        .map((r) => this.public(r)),
    };
  }
  request(kind, payload, { taskId = null, reuseWithinMs = 0 } = {}) {
    if (!kinds.has(kind)) fail("不支持的助手请求");
    if (kind === "search") payload = validateSearchInput(payload);
    if (kind === "media" && !/^\d{10,25}$/.test(payload.source_id))
      fail("视频ID无效");
    if (kind === "web") payload = { game: text(payload.game, "游戏名", 40) };
    if (kind === "delivery" && taskId) {
      const prior = this.decode(
        this.db.db
          .prepare(
            "SELECT * FROM bridge_requests WHERE kind='delivery' AND task_id=? AND state IN ('writing','unknown','fulfilled') ORDER BY created_at DESC LIMIT 1",
          )
          .get(taskId),
      );
      if (prior) {
        if (hash(prior.payload.plan) !== hash(payload.plan))
          fail("此任务已有交付记录，禁止改稿后复用原交付请求");
        return prior;
      }
    }
    const requestTime = now();
    const key = hash({ kind, payload, taskId, ...(payload.provider === "redfox" ? {effective_scope:redfoxScopeKey(payload, requestTime)} : {}) });
    this.sweep();
    let previous = this.decode(
      this.db.db
        .prepare(
          "SELECT * FROM bridge_requests WHERE request_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(key),
    );
    // A prior paid attempt with an expired lease has an unknown external
    // outcome. Only this new explicit request may create another attempt.
    if (payload.provider === "redfox" && previous?.state === "pending" &&
        this.db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collection_jobs'").get()) {
      const job = this.db.db.prepare("SELECT state,attempts,lease FROM collection_jobs WHERE request_id=?").get(previous.id);
      if (job?.attempts > 0 && !(job.state === "running" && job.lease > Date.now())) {
        this.update(previous.id, "failed", null, "SOURCE_FAILED: 先前计费请求中断，结果未知；未自动重试");
        previous = null;
      }
    }
    // Reuse only an exactly matching public successful request. Keep its ID,
    // source timestamps and coverage; a cache hit is never a new observation.
    if (
      kind === "search" &&
      !taskId &&
      previous?.state === "fulfilled" &&
      Number.isFinite(reuseWithinMs) &&
      reuseWithinMs > 0
    ) {
      const age = Date.now() - Date.parse(previous.updated_at);
      if (age >= 0 && age < Math.min(reuseWithinMs, 60000)) return previous;
    }
    if (
      previous &&
      ([
        "pending",
        "approved",
        "writing",
        "awaiting_approval",
        "unknown",
      ].includes(previous.state) ||
        (taskId &&
          kind !== "search" &&
          previous.state === "fulfilled" &&
          !(kind === "media" && previous.result?.status === "unavailable") &&
          !(kind === "web" && !previous.result?.sources?.length)))
    )
      return previous;
    const id = randomUUID(),
      created = requestTime;
    this.db.db
      .prepare("INSERT INTO bridge_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        key,
        kind,
        taskId,
        kind === "delivery" ? "awaiting_approval" : "pending",
        JSON.stringify(payload),
        null,
        null,
        created,
        new Date(Date.now() + this.timeoutMs).toISOString(),
        created,
      );
    return this.get(id);
  }
  approve(id, target) {
    return this.db.transaction(() => {
      this.sweep();
      const r = this.get(id);
      if (!r || r.kind !== "delivery" || r.state !== "awaiting_approval")
        fail("该草稿当前不可批准");
      assertQualityExecutionAllowed();
      const payload = {
        ...r.payload,
        destination: destination(target),
        approved_at: now(),
      };
      this.db.db
        .prepare(
          "UPDATE bridge_requests SET payload=?,state=?,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(payload), "approved", now(), id);
      return this.public(this.get(id));
    });
  }
  beginDelivery(id) {
    return this.db.transaction(() => {
      this.sweep();
      const r = this.get(id);
      if (!r || r.kind !== "delivery" || r.state !== "approved")
        fail("交付未批准或已开始；禁止重复写入");
      assertQualityExecutionAllowed();
      return this.public(this.update(id, "writing"));
    });
  }
  completedDelivery(taskId) {
    return this.decode(
      this.db.db
        .prepare(
          "SELECT * FROM bridge_requests WHERE kind='delivery' AND task_id=? AND state='fulfilled' ORDER BY updated_at DESC LIMIT 1",
        )
        .get(taskId),
    );
  }
  reconcileDelivery(id, envelope) {
    return this.db.transaction(() => {
      const r = this.get(id);
      if (!r || r.kind !== "delivery" || r.state !== "unknown")
        fail("仅可对账结果未知的交付");
      if (envelope?.request_id !== id || envelope.task_id !== r.task_id)
        fail("对账请求身份不匹配");
      if (envelope.result?.status !== "completed")
        fail("对账必须提供实际成功回读；不会重新写入");
      const result = this.validate({ ...r, state: "writing" }, envelope.result);
      return this.public(
        this.update(id, "fulfilled", {
          ...result,
          reconciled_at: now(),
          reconciliation: "readback_only_no_republish",
        }),
      );
    });
  }
  validate(r, value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("结果必须是对象");
    if (r.kind === "search" && r.payload.provider === "redfox") {
      const game = r.payload.purpose !== "hotspots";
      const result = (game ? validateRedfoxGameResult : validateRedfoxHotspotResult)(value, r.payload, {createdAt:r.created_at});
      const observed = result.observed_scope, expected = redfoxScope(r.payload, r.created_at);
      if (observed.start_date !== expected.start_date || observed.end_date !== expected.end_date)
        fail("红狐请求跨自然日，实际日期已变化，请重新查询");
      const collection = game ? r.payload.purpose === "game-learning" ? "learning" : "games" : "hotspots";
      const collection_key = JSON.stringify([collection, ...JSON.parse(redfoxScopeKey(r.payload, result.started_at))]);
      return {...result, provider:"redfox", collection_key, collection_request_id:r.id ?? null,
        collected_at:result.searched_at, keyword:r.payload.keyword, hours:r.payload.hours,
        scope_verification:"api_receipt", applied_hours:null, applied_sort:null,
        records:result.records.map((row,index)=>({...row, provider:"redfox", collection,
          collection_request_id:r.id ?? null, collection_key, game:game ? r.payload.keyword : null,
          sub_type:0, board:r.payload.board, api_board:r.payload.board, date_window:r.payload.hours,
          category_filter:r.payload.category, search_keyword:r.payload.keyword, requested_sort:r.payload.sort,
          start_date:observed.start_date, end_date:observed.end_date, timezone:observed.timezone,
          date_semantics:observed.date_semantics, update_policy:observed.update_policy,
          scope_verification:"api_receipt", applied_hours:null, applied_sort:null,
          observed_order:index+1, sort_basis:result.sort_basis, scope:result.scope, trends:[]}))};
    }
    if (r.kind === "search") {
      const hasPagination = value.pagination !== undefined;
      if (
        !Array.isArray(value.records) ||
        value.records.length > (hasPagination && r.payload.purpose === "hotspots" ? 7500 : 200) ||
        !Array.isArray(value.failures)
      )
        fail("搜索结果结构无效");
      const scope = text(value.scope, "搜索范围", 1000),
        searched_at = date(value.searched_at);
      const gameSearchResult = ["game-research", "game-learning"].includes(r.payload.purpose);
      const gameObservedScope = gameSearchResult ? observedGameSearchScope(value,r.payload) : null;
      const gameResultUpdate = gameObservedScope ? gameSearchResultUpdate(value.result_update,gameObservedScope) : null;
      const gameBatches = gameObservedScope ? gameCollectionBatches(value,gameObservedScope,gameResultUpdate,r.payload,searched_at,r.created_at) : null;
      let observedScope = null;
      if (r.payload.purpose === "hotspots") {
        const observed = value.observed_scope;
        if (
          !observed ||
          !Array.isArray(observed.boards) ||
          !observed.boards.length
        )
          fail(
            "热点回填必须提供实际采集的 observed_scope（boards、hours、category）",
          );
        const allowed = collectionTargets(r.payload).map((t) => t.board);
        const category = resolveCategory(observed.category)?.id || "all";
        if (
          observed.category == null ||
          observed.hours !== r.payload.hours ||
          category !== r.payload.category ||
          observed.boards.some((board) => !allowed.includes(board))
        )
          fail("实际采集的榜单、时间或行业与请求不匹配");
        observedScope = {
          boards: [...new Set(observed.boards)],
          hours: observed.hours,
          category,
        };
      }
      const records = value.records.map((row, index) => {
        if (!["video", "topic", "search"].includes(row.kind))
          fail("来源种类无效");
        const id = text(row.source_id, "来源ID", 150);
        if (row.kind === "video" && !/^\d{10,25}$/.test(id)) fail("视频ID无效");
        const source_url = https(
          row.source_url || row.url,
          row.kind === "video" ? "www.douyin.com" : undefined,
        );
        if (
          row.kind === "video" &&
          new URL(source_url).pathname !== `/video/${id}`
        )
          fail("作品URL与ID不符");
        const observed_url = https(row.observed_url);
        if (
          !["www.douyin.com", "douhot.douyin.com"].includes(
            new URL(observed_url).hostname,
          )
        )
          fail("必须提供实际观察的抖音或热点宝页面");
        const pageResponse = row.source_endpoint === "douhot-page-response";
        if (pageResponse) {
          const observed = new URL(observed_url);
          if (r.payload.purpose !== "hotspots" || row.kind !== "video" ||
              observed.origin !== "https://douhot.douyin.com" || observed.pathname !== "/square/hotspot")
            fail("页面响应来源标记与热点观察页面不匹配");
          if (typeof row.title !== "string" || row.title.length > 1000 ||
              typeof row.author !== "string" || row.author.length > 200)
            fail("页面响应标题和作者必须为来源字符串，允许真实空值");
          if (!Number.isSafeInteger(row.page) || row.page < 1 ||
              !Number.isSafeInteger(row.position_in_response) || row.position_in_response < 1 || row.position_in_response > 1000)
            fail("页面响应页码或行位置无效");
          if (row.source_rank !== null || row.metric_precision !== "observed")
            fail("页面响应不得推断来源排名或舍入指标");
          for (const field of ["score", "play_count", "like_count"])
            if (row[field] !== null && (!Number.isFinite(row[field]) || row[field] < 0))
              fail("页面响应指标必须为来源数值或显式null");
        }
        const title = pageResponse ? row.title : text(row.title, "作品标题", 1000);
        const gameSearch = ["game-research", "game-learning"].includes(
          r.payload.purpose,
        );
        const visibleSearch = [
          "game-research",
          "game-learning",
          "courses",
          "related-work",
        ].includes(r.payload.purpose);
        if (visibleSearch) {
          const observed = new URL(observed_url);
          const actualKeyword = decodeURIComponent(
            observed.pathname.replace(/^\/search\//, ""),
          );
          if (
            observed.hostname !== "www.douyin.com" ||
            !observed.pathname.startsWith("/search/") ||
            actualKeyword.normalize("NFKC").trim() !==
              r.payload.keyword.normalize("NFKC").trim()
          )
            fail("观察页面与请求的搜索词不匹配");
          if (gameObservedScope && (row.kind !== "video" || observed.origin !== "https://www.douyin.com" ||
              observed.searchParams.getAll("type").length !== 1 || observed.searchParams.get("type") !== "video"))
            fail("已核验游戏范围必须来自实际视频搜索页面");
        }
        const actualBoard =
          row.sub_type ??
          (observedScope?.boards.length === 1 ? observedScope.boards[0] : null);
        if (observedScope) {
          if (
            !observedScope.boards.includes(actualBoard) ||
            (row.date_window != null &&
              row.date_window !== observedScope.hours) ||
            (row.category_filter != null &&
              categoryId(row.category_filter) !== observedScope.category)
          )
            fail("记录的榜单、时间或行业与实际采集范围不匹配");
        }
        for (const field of [
          "score",
          "play_count",
          "like_count",
          "source_rank",
        ])
          if (
            row[field] != null &&
            (!Number.isFinite(row[field]) || row[field] < 0)
          )
            fail("指标必须为可见数值或null");
        let publication;
        try {
          publication = validatePublicationFields(row);
        } catch (error) {
          fail(error.message);
        }
        return {
          collection_request_id: r.id ?? null,
          ...publication,
          kind: row.kind,
          source_id: id,
          title,
          author:
            typeof row.author === "string" ? row.author.slice(0, 200) : null,
          source_url,
          observed_url,
          sub_type: visibleSearch ? 0 : actualBoard,
          date_window: visibleSearch ? 0 : r.payload.hours,
          category_filter: observedScope
            ? resolveCategory(observedScope.category)?.tags || null
            : gameSearch
              ? null
              : (row.category_filter ?? null),
          category_label: gameSearch
            ? "抖音游戏搜索"
            : observedScope
              ? resolveCategory(observedScope.category)?.label || "不限行业"
              : row.category_label || "不限行业",
          page: pageResponse ? row.page : 1,
          position_in_response: pageResponse ? row.position_in_response : index + 1,
          observed_order: index + 1,
          source_rank: visibleSearch ? null : (row.source_rank ?? null),
          score: visibleSearch ? null : (row.score ?? null),
          play_count: row.play_count ?? null,
          like_count: row.like_count ?? null,
          like_display:
            !pageResponse && typeof row.like_display === "string"
              ? row.like_display.slice(0, 50)
              : null,
          metric_precision:
            row.metric_precision === "rounded" ? "rounded" : "observed",
          publish_count: null,
          collected_at: date(row.collected_at || searched_at),
          source_updated_at: null,
          trends: [],
          source_endpoint: visibleSearch
            ? "douyin_visible_search"
            : pageResponse ? "douhot-page-response" : "douhot-visible-page",
          search_keyword: r.payload.keyword,
          game: gameSearch ? r.payload.keyword : null,
          collection:
            r.payload.purpose === "courses"
              ? "courses"
              : r.payload.purpose === "game-learning"
                ? "learning"
                : gameSearch
                  ? "games"
                  : r.payload.purpose === "related-work"
                    ? "related"
                    : "hotspots",
          sort_basis: text(
            value.sort_basis || "observed_order",
            "实际排序依据",
            200,
          ),
          requested_sort: r.payload.sort,
          ...(gameSearchResult ? {
            scope_verification: gameObservedScope ? "source_selected" : "unverified",
            applied_hours: gameObservedScope?.hours ?? null,
            applied_sort: gameObservedScope?.sort ?? null,
          } : {}),
          scope,
        };
      });
      if (records.some((r) => !Number.isFinite(r.sub_type)))
        fail("榜单标识缺失");
      const pagination = hasPagination
        ? rankingPagination(value.pagination, records, observedScope, r.payload) : null;
      return {
        collection_request_id: r.id ?? null,
        records,
        collection_key: JSON.stringify(
          r.payload.purpose === "game-learning"
            ? ["learning", r.payload.keyword]
            : r.payload.purpose === "game-research"
              ? ["games", r.payload.keyword]
              : r.payload.purpose === "courses"
                ? ["courses"]
                : r.payload.purpose === "related-work"
                  ? ["related", r.payload.target_game, r.payload.keyword]
                  : [
                      "hotspots",
                      r.payload.keyword,
                      r.payload.board,
                      r.payload.hours,
                      r.payload.category,
                    ],
        ),
        collected_at: searched_at,
        ...(observedScope ? { observed_scope: observedScope } : {}),
        ...(gameSearchResult ? {
          scope_verification: gameObservedScope ? "source_selected" : "unverified",
          applied_hours: gameObservedScope?.hours ?? null,
          applied_sort: gameObservedScope?.sort ?? null,
          ...(gameObservedScope ? {observed_scope:gameObservedScope,source_endpoint:"douyin_visible_search",result_update:gameResultUpdate,...gameBatches} : {}),
        } : {}),
        ...(pagination ? { pagination } : {}),
        failures: value.failures.map((v) => String(v).slice(0, 200)),
        scope,
        searched_at,
        keyword: r.payload.keyword,
        hours: r.payload.hours,
      };
    }
    if (r.kind === "web") {
      if (!Array.isArray(value.sources) || value.sources.length > 10)
        fail("网页资料结构无效");
      return {
        sources: value.sources.map((s) => ({
          id: "web:" + hash(https(s.url)).slice(0, 16),
          kind: "web",
          url: https(s.url),
          title: text(s.title, "资料标题", 500),
          text: text(s.text, "实际读取正文", 20000),
          read_at: date(s.read_at),
          status: "source_claim_not_independently_verified",
        })),
      };
    }
    if (r.kind === "media") {
      const id = r.payload.source_id;
      if (
        value.source_id !== id ||
        new URL(https(value.url, "www.douyin.com")).pathname !== `/video/${id}`
      )
        fail("媒体身份不匹配");
      if (value.status === "unavailable") {
        const allowed = new Set([
          "status",
          "source_id",
          "url",
          "reason",
          "observed_at",
        ]);
        if (Object.keys(value).some((key) => !allowed.has(key)))
          fail("不可读观察不能夹带原片路径或已读证据");
        return {
          status: "unavailable",
          source_id: id,
          url: https(value.url, "www.douyin.com"),
          reason: text(value.reason, "不可读原因", 1000),
          observed_at: date(value.observed_at),
        };
      }
      if (value.status !== undefined && value.status !== "available")
        fail("媒体可用状态无效");
      const expected = join(this.folder, "media", id, "source.mp4");
      if (resolve(value.source_path || "") !== expected)
        fail("只接受托管目录中的source.mp4");
      const real = realpathSync(expected),
        realRoot = realpathSync(this.folder);
      if (
        real !== join(realRoot, "media", id, "source.mp4") ||
        !statSync(real).isFile() ||
        statSync(real).size < 1000
      )
        fail("媒体路径或文件无效");
      return {
        source_id: id,
        url: value.url,
        title: text(value.title, "原片标题", 1000),
        source_path: real,
        observed_at: date(value.observed_at),
      };
    }
    if (r.kind === "transcript-review") {
      const p = r.payload;
      if (value.source_id !== p.source_id || value.media_hash !== p.media_hash)
        fail("字幕复核媒体身份不符");
      if (
        ![
          "reviewed_no_changes",
          "reviewed_with_corrections",
          "needs_review",
        ].includes(value.status) ||
        !Array.isArray(value.corrections) ||
        !Array.isArray(value.uncertainties)
      )
        fail("字幕复核结构无效");
      const seen = new Set();
      const corrections = value.corrections.map((c) => {
        const segment = p.segments[c.segment_index];
        if (
          !Number.isInteger(c.segment_index) ||
          !segment ||
          seen.has(c.segment_index)
        )
          fail("字幕修正段落无效或重复");
        seen.add(c.segment_index);
        if (
          c.original_text !== segment.text ||
          c.corrected_text === c.original_text
        )
          fail("字幕修正必须保留对应原始转写");
        const corrected = text(c.corrected_text, "修正转写", 3000),
          subtitle = text(c.subtitle_text, "画面字幕", 1000);
        if (
          !Number.isFinite(c.frame_time) ||
          c.frame_time < segment.start - 3 ||
          c.frame_time > segment.end + 3 ||
          !p.ocr_readings.some(
            (o) => o.time === c.frame_time && o.text.includes(subtitle),
          ) ||
          !corrected.includes(subtitle)
        )
          fail("术语修正缺少同时间画面字幕支持");
        return {
          segment_index: c.segment_index,
          original_text: c.original_text,
          corrected_text: corrected,
          frame_time: c.frame_time,
          subtitle_text: subtitle,
          reason: text(c.reason, "修正依据", 1000),
        };
      });
      if (
        (value.status === "reviewed_no_changes" && corrections.length) ||
        (value.status === "reviewed_with_corrections" && !corrections.length)
      )
        fail("复核状态与修正数量不符");
      const uncertainties = value.uncertainties.map((u) =>
        text(u, "未核验内容", 1000),
      );
      if (uncertainties.length && value.status !== "needs_review")
        fail("存在未核验术语时须保留待复核状态");
      return {
        source_id: p.source_id,
        media_hash: p.media_hash,
        status: value.status,
        corrections,
        uncertainties,
        reviewed_at: now(),
        scope: "助手核对引用时间点的原始语音转写与画面字幕；非全片逐帧核验",
      };
    }
    if (r.kind === "delivery") {
      if (r.state !== "writing")
        fail("交付须先获得授权并通过begin-delivery登记");
      if (value.status === "unknown")
        return {
          status: "unknown",
          message: text(value.message, "未知结果说明", 1000),
        };
      if (value.status !== "completed" || value.readback_verified !== true)
        fail("交付必须提供实际回读核验");
      const target = r.payload.destination;
      const document_url = https(value.document_url, "docs.qq.com");
      if (
        value.file_id !== target.file_id ||
        new URL(document_url).pathname !== new URL(target.url).pathname
      )
        fail("交付目标与批准目标不一致");
      return {
        status: "completed",
        file_id: value.file_id,
        sheet_id: text(value.sheet_id, "子表ID", 150),
        url: document_url,
        document_url,
        readback_verified: true,
        content_status: "verified",
        content_verified_at: date(value.verified_at),
        warnings: Array.isArray(value.warnings)
          ? value.warnings.map((v) => String(v).slice(0, 500))
          : [],
        plan_hash: hash(r.payload.plan),
      };
    }
  }
  fulfill(id, envelope) {
    return this.db.transaction(() => {
      this.sweep();
      const r = this.get(id);
      if (!r || !["pending", "writing"].includes(r.state))
        fail("请求已失效、已消费或等待批准");
      if (envelope?.request_id !== r.id || envelope.task_id !== r.task_id)
        fail("请求身份或任务不匹配");
      if (envelope.error) {
        if (r.kind === "delivery")
          fail("交付错误必须以status:unknown回执，禁止模糊重试");
        const code = envelope.error.code ?? "SOURCE_FAILED";
        if (!isSourceErrorCode(code))
          fail("错误分类无效");
        return this.update(
          id,
          "failed",
          null,
          code + ": " + text(envelope.error.message, "错误说明", 600),
        );
      }
      const result = this.validate(r, envelope.result);
      return this.update(
        id,
        result.status === "unknown" ? "unknown" : "fulfilled",
        result,
        result.status === "unknown" ? result.message : null,
      );
    });
  }
  async wait(request, { signal, pollMs = 500 } = {}) {
    while (true) {
      signal?.throwIfAborted();
      this.sweep();
      const r = this.get(request.id);
      if (!r) fail("助手请求丢失");
      if (r.state === "fulfilled") return r.result;
      if (terminal.has(r.state))
        fail(
          r.error || "助手请求未完成",
          r.state === "unknown"
            ? "DELIVERY_UNKNOWN"
            : r.state === "failed" && r.error_code ? r.error_code : "BRIDGE_" + r.state.toUpperCase(),
        );
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
