import { observedRankingPageReceipts } from "./ranking-page-receipts.mjs";
import { matchesObservedVideoScope } from "./observed-ranking-identities.mjs";

export function scopedRankingReads(reads, target, children, page) {
  return {
    *[Symbol.iterator]() {
      for (const [promise, receipt] of reads)
        if (matchesObservedVideoScope(receipt, target, children) && receipt.request?.page === page) yield promise;
    },
    get size() { return [...this].length; },
  };
}

export const createRankingRequestEpoch = () => requestEpoch(["/douhot/v1/material/video_billboard"]);
export const createPublicRankingDiagnosticEpoch = () => requestEpoch([
  "/douhot/v1/material/video_billboard", "/douhot/v1/material/challenge_billboard", "/douhot/v1/dashboard/hot_search/query_list",
]);
function requestEpoch(paths) {
  const requests = new Map();
  let open = true, exceeded = false;
  const matching = (entry, target, children, page) => matchesObservedVideoScope(entry, target, children) && entry.request?.page === page;
  return {
    observe(request) {
      if (!open || requests.has(request)) return;
      let url, payload;
      try { url = new URL(request.url()); payload = request.postDataJSON(); } catch { return; }
      if (url.origin !== "https://douhot.douyin.com" || !paths.includes(url.pathname)) return;
      if (requests.size >= 64) { exceeded = true; return; }
      requests.set(request, { url: url.origin + url.pathname, request: payload, state: "pending" });
    },
    owns: request => open && requests.has(request),
    complete(request) { const entry = requests.get(request); if (entry?.state === "pending") entry.state = "complete"; },
    failed(request) { const entry = requests.get(request); if (entry) entry.state = "failed"; },
    pending: (target, children, page) => [...requests.values()].filter(entry => entry.state === "pending" && matching(entry, target, children, page)).length,
    hasFailure: (target, children, page) => [...requests.values()].some(entry => entry.state === "failed" && matching(entry, target, children, page)),
    isOpen: () => open,
    exceeded: () => exceeded,
    close() { open = false; },
  };
}

export function waitForRankingEpochIdle(epoch, target, children, page, { timeoutMs = 15000, signal } = {}) {
  const budget = Math.min(15000, Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : 15000));
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + budget;
    let timer;
    const finish = error => { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
    const abort = () => finish(signal.reason || Error("采集已取消"));
    const check = () => {
      if (signal?.aborted) return abort();
      if (!epoch.isOpen()) return finish(Error("本轮来源请求已结束，未提交过期结果"));
      if (epoch.exceeded()) return finish(Error("本轮来源请求超过核验上限"));
      if (epoch.hasFailure(target, children, page)) return finish(Error("当前范围及页码的页面请求失败，未提交不完整结果"));
      if (!epoch.pending(target, children, page)) return finish();
      const remaining = deadline - performance.now();
      if (remaining <= 0) return finish(Error("当前范围及页码仍有未完成页面请求，等待超时"));
      timer = setTimeout(check, Math.min(50, remaining));
    };
    signal?.addEventListener("abort", abort, { once: true }); check();
  });
}

// Normal page-emitted receipts only. The caller owns the request epoch and
// must never pass pooled history, direct fetches or replayed API responses.
export function parseObservedRankingPage(receipts, target, expectedChildIds, expectedPage) {
  const observed = observedRankingPageReceipts(receipts, target, expectedChildIds, expectedPage);
  let records = null, fingerprint = null;
  for (const receipt of observed.receipts) {
    const ids = new Set();
    const current = receipt.body.data.objs.map((row, index) => {
      const metric = key => Object.hasOwn(row || {}, key) &&
        (row[key] === null || (typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0));
      if (typeof row?.item_id !== "string" || !/^\d{10,25}$/.test(row.item_id) ||
          typeof row.item_title !== "string" || row.item_title.length > 1000 ||
          typeof row.nick_name !== "string" || row.nick_name.length > 200 ||
          !["score", "play_cnt", "like_cnt"].every(metric)) {
        const error = Error("榜单页面响应的记录字段缺失或类型不可核验");
        error.identity_schema_diagnostic = { row_index: index,
          fields: Object.fromEntries(["item_id", "item_title", "nick_name", "score", "play_cnt", "like_cnt"].map(key => [key, {
            type: row?.[key] === null ? "null" : typeof row?.[key],
            ...(typeof row?.[key] === "string" ? { length: row[key].length } : {}),
          }])),
          id_is_decimal_string: typeof row?.item_id === "string" && /^\d{10,25}$/.test(row.item_id),
        };
        throw error;
      }
      if (ids.has(row.item_id)) throw Error("同一页响应含重复视频ID，未合并或重排");
      ids.add(row.item_id);
      return { kind: "video", source_endpoint: "douhot-page-response", source_id: row.item_id,
        source_url: `https://www.douyin.com/video/${row.item_id}`,
        page: expectedPage, position_in_response: index + 1,
        title: row.item_title, author: row.nick_name,
        source_rank: null, score: row.score, play_count: row.play_cnt, like_count: row.like_cnt,
        metric_precision: "observed" };
    });
    const currentFingerprint = JSON.stringify({ metadata: observed.metadata, records: current });
    if (fingerprint !== null && fingerprint !== currentFingerprint)
      throw Error("同轮同页响应的有序记录或指标发生变化，未合并或选择任意版本");
    records = current;
    fingerprint = currentFingerprint;
  }
  return { metadata: observed.metadata, actual_count: observed.actual_count, records, fingerprint };
}

// Actual observed pager: the active item must have matching visible number and
// public aria label. Do not infer page 1 from a URL, response or missing pager.
export function observeCurrentRankingPageDOM() {
  const nodes = [...document.querySelectorAll(".arco-table-pagination li.arco-pagination-item-active")]
    .filter(node => {
      if (!node.getClientRects().length) return false;
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity || 1) > 0;
    });
  if (nodes.length !== 1) return { page: null, reason: "active_page_not_unique" };
  const text = (nodes[0].innerText || "").trim();
  const label = (nodes[0].getAttribute("aria-label") || "").trim();
  const match = /^第\s*(\d{1,7})\s*页$/.exec(label);
  if (!/^\d{1,7}$/.test(text) || !match || Number(text) < 1 || Number(text) !== Number(match[1]))
    return { page: null, reason: "active_page_label_unconfirmed" };
  return { page: Number(text), reason: "visible_active_item_and_aria_label" };
}

// One synchronous browser evaluation captures the final URL, selected scope
// and actual page together. Keep selection semantics aligned with observeScopeDOM.
export function observeFinalRankingScopeDOM() {
  const visible = node => {
    if (!node?.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity || 1) > 0;
  };
  const combos = [...document.querySelectorAll('[role="combobox"]')].filter(visible).map(node => node.innerText || node.textContent || "");
  const checked = [...document.querySelectorAll(".arco-tag-checked")].filter(visible).map(node => (node.innerText || node.textContent || "").replace(/\s/g, ""));
  const active = [...document.querySelectorAll(".arco-table-pagination li.arco-pagination-item-active")].filter(visible);
  let page = null;
  if (active.length === 1) {
    const text = (active[0].innerText || "").trim();
    const label = /^第\s*(\d{1,7})\s*页$/.exec((active[0].getAttribute("aria-label") || "").trim());
    if (/^\d{1,7}$/.test(text) && label && Number(text) > 0 && Number(text) === Number(label[1])) page = Number(text);
  }
  const next = [...document.querySelectorAll('.arco-table-pagination li[aria-label="下一页"]')].filter(visible);
  const nextDisabled = next.length === 1 ? next[0].hasAttribute("disabled") || next[0].getAttribute("aria-disabled") === "true" ||
    /(?:^|\s)arco-pagination-item-disabled(?:\s|$)/.test(next[0].getAttribute("class") || "") : null;
  return { url: location.href, page, next_disabled: nextDisabled,
    timeLabel: checked.filter(text => /^近\d+(?:天|小时)$/.test(text)).join(" "),
    boardLabel: checked.filter(text => /^(?:视频总榜|低粉爆款|高完播率|高涨粉率|高点赞率)$/.test(text)).join(" "),
    categoryLabel: combos.filter(text => !/近.*[天时]|条\/页|每页/.test(text)).join(" "),
  };
}

export function createRankingTraversal(target) {
  const pages = [], records = [], ids = new Set();
  let metadata = null, terminal = null;
  const progress = () => ({ board: target.board, hours: target.hours, category: target.category || "all",
    pages: pages.map(page => ({ ...page })), collected_count: records.length,
    metadata_total: metadata?.total ?? null,
    metadata_total_difference: metadata ? metadata.total - records.length : null,
    status: terminal ? "accessible_complete" : "partial", terminal: terminal ? { ...terminal } : null });
  return {
    append(parsed, snapshot, pageRecords) {
      if (terminal) throw Error("来源分页已确认结束，不能追加页面");
      const page = pages.length + 1;
      if (page > 50 || parsed.metadata.page !== page || snapshot.page !== page)
        throw Error("来源分页不连续或超过50页上限");
      if (typeof snapshot.next_disabled !== "boolean") throw Error("未确认来源下一页控件状态，不能推断分页结束");
      if (metadata && (metadata.page_size !== parsed.metadata.page_size || metadata.total !== parsed.metadata.total))
        throw Error("跨页page_size或total发生变化，未合并不同榜单版本");
      const expectedLastPage = Math.max(1, Math.ceil(parsed.metadata.total / parsed.metadata.page_size));
      if (page > expectedLastPage) throw Error("实际页码超过来源分页元数据末页，未继续采集");
      if (snapshot.next_disabled && page !== expectedLastPage)
        throw Error("下一页提前禁用，与分页元数据末页不一致，不能当作分页完成");
      if (pageRecords.length !== parsed.actual_count) throw Error("实际页记录数与分页收据不一致");
      if (records.length + pageRecords.length > 1500) throw Error("采集达到每榜1500条上限，分页尚未完成");
      if (records.length + pageRecords.length > parsed.metadata.total) throw Error("累计实读条数超过来源total，分页元数据不一致");
      const pageIds = new Set();
      for (const record of pageRecords) {
        if (ids.has(record.source_id) || pageIds.has(record.source_id)) throw Error("跨页视频ID重复，未合并或跳过重复页面");
        pageIds.add(record.source_id);
      }
      metadata ||= { ...parsed.metadata };
      pageIds.forEach(id => ids.add(id));
      records.push(...pageRecords);
      pages.push({ ...parsed.metadata, actual_count: parsed.actual_count });
      if (snapshot.next_disabled) terminal = { page, next_disabled: true, observed_current_page: snapshot.page };
      else if (page === 50 || records.length === 1500) throw Error("采集达到50页或1500条上限，但来源下一页仍可用，未完成该榜分页");
      else if (page === expectedLastPage) throw Error("来源元数据已到末页但下一页仍可用，未继续越界采集");
      return Boolean(terminal);
    },
    progress,
    result() {
      if (!terminal) throw Error("来源分页尚未确认结束，不能提交部分榜单");
      return { records: [...records], summary: progress() };
    },
  };
}

export async function paceRankingClick(lastActionAt, { signal, clock } = {}) {
  const now = clock?.now || (() => performance.now());
  const sleep = clock?.sleep || ((ms, signal) => new Promise((resolve, reject) => {
    let timer;
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason || Error("采集已取消")); };
    timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  }));
  while (true) {
    if (signal?.aborted) throw signal.reason || Error("采集已取消");
    const remaining = 2000 - (now() - lastActionAt);
    if (remaining <= 0) return;
    await sleep(remaining, signal);
  }
}

export function waitForObservedRankingPage(receipts, target, expectedChildIds, expectedPage, { timeoutMs = 15000, signal } = {}) {
  if (!Number.isSafeInteger(expectedPage) || expectedPage < 1) return Promise.reject(Error("预期榜单页码必须为正整数"));
  const budget = Math.min(15000, Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : 15000));
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + budget;
    let timer;
    const finish = (error, receipt) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(receipt);
    };
    const abort = () => finish(signal.reason || Error("采集已取消"));
    const check = () => {
      if (signal?.aborted) return abort();
      const receipt = receipts.find(value => matchesObservedVideoScope(value, target, expectedChildIds) && value.request.page === expectedPage);
      if (receipt) return finish(null, receipt);
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        const error = Error("等待当前榜单、时间、行业及页码的完整页面响应超时，未采用旧范围数据");
        error.code = "SOURCE_RESPONSE_TIMEOUT"; return finish(error);
      }
      timer = setTimeout(check, Math.min(50, remaining));
    };
    signal?.addEventListener("abort", abort, { once: true }); check();
  });
}
