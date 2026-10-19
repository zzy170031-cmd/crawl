import {experimentalQualityHold,projectQualityHeldProfile,qualityHoldResponse} from './quality-policy.mjs';
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { config, dataDir } from "./config.mjs";
import {join} from 'node:path';
import { Tasks, hash } from "./tasks.mjs";
import { defaultStore, recordsForLatest, creativeSourceFor } from "./store.mjs";
import {
  categories,
  categoryId,
  resolveCategory,
  categoryLabel,
  collectionTargets,
} from "./categories.mjs";
import { sortRows } from "./sorting.mjs";
import { freshness } from "./freshness.mjs";
import { searchSource } from "./search.mjs";
import { startWorker, withBrowser } from "./worker.mjs";
import { destination, resolveDestination } from "./delivery.mjs";
import { SideBridge } from "./side-bridge.mjs";
import { startCollectionWorker } from "./collection-worker.mjs";
import { createAutomaticCollector } from "./automatic-collector.mjs";
import { createReadiness, startReadinessScheduler } from "./readiness.mjs";
import { saveTencentCredential } from "./tencent-client.mjs";
import { ContentGroups } from "./content-groups.mjs";
import { readThumbnail, annotateThumbnails } from "./thumbnails.mjs";
import { collectionProvenance } from "./collection-provenance.mjs";
import { bindLatestGameCollection } from "./learning-snapshot.mjs";
import { createRedfoxRuntime,redfoxCredentialReader,saveRedfoxCredential } from './redfox-runtime.mjs';
import { redfoxGameScope, createRedfoxGameSource } from './redfox-game-source.mjs';
import { REDFOX_HOTSPOT_CATEGORIES, redfoxHotspotScope, createRedfoxHotspotSource } from './redfox-hotspot-source.mjs';
import { createMediaAcquisition, MediaAcquisitionError } from './media-acquisition.mjs';
import { redfoxAssets } from './redfox-assets.mjs';
import { createRedfoxMediaSource } from './redfox-media-source.mjs';
import { downloadRedfoxMedia } from './redfox-media-download.mjs';
import { prepareRedfoxMedia } from './media.mjs';
let readiness;
const db = new Tasks(),
  store = defaultStore(),
  bridge = new SideBridge(db),
  groups = new ContentGroups(db),
  worker = startWorker(db, { bridge,
    canRun: () => config.gameSource === 'redfox' || config.searchMode !== "automatic" || Boolean(readiness?.status().ready),
  });
const redfoxCredentialPath=join(dataDir,'redfox-credential.json');
const redfoxKey=redfoxCredentialReader(redfoxCredentialPath);
const mediaAcquisition = createMediaAcquisition({db,bridge,assets:redfoxAssets,
  resolver:createRedfoxMediaSource({apiKey:redfoxKey}),download:downloadRedfoxMedia,prepare:prepareRedfoxMedia});
const sourceCollector = createRedfoxRuntime({
  gameProvider:config.gameSource,
  hotspotProvider:config.hotspotSource,
  gameSource:createRedfoxGameSource({apiKey:redfoxKey}),
  hotspotSource:createRedfoxHotspotSource({apiKey:redfoxKey}),
  browser:createAutomaticCollector({
    profileDir:config.collectorProfile,executablePath:config.collectorExecutable,
    headlessExecutablePath:config.collectorHeadlessExecutable,timeoutMs:config.collectorTimeoutMs,headless:true,
    onSessionClosed:()=>{
      if(config.gameSource!=='redfox') readiness?.invalidate('douyin',{message:'来源浏览器已关闭，请重新核验连接'});
      if(config.hotspotSource!=='redfox') readiness?.invalidate('douhot',{message:'来源浏览器已关闭，请重新核验连接'});
    },
  }),
});
function collectionReady(payload) {
  if(sourceCollector.isIndependentRequest(payload)) {
    const status=readiness?.status();
    return Boolean(payload.purpose==='hotspots'?status?.hotspot_collection_ready:status?.game_collection_ready);
  }
  return Boolean(readiness?.status().ready);
}
const collector = startCollectionWorker({
  db, bridge, store,
  canRun: collectionReady,
  onConnectionFailure: (site, error) => readiness?.invalidate(site, {
    state: error.code === "VERIFICATION_REQUIRED" ? "verification_required" : "login_required",
    message: error.message,
  }),
  enabled: config.searchMode === "automatic",
  timeoutMs: config.collectorTimeoutMs,
  minRequestIntervalMs: 15000,
  collector: sourceCollector,
});
readiness = createReadiness({collector, target, onReady: () => collector.kick()});
const readinessScheduler = startReadinessScheduler({readiness,collector,enabled:config.searchMode === "automatic"});
const token = randomBytes(32).toString("hex");
const origin = `http://127.0.0.1:${config.port}`;
let schedulerBusy = false;
const stages = {
  queued: "等待执行",
  running: "处理中",
  needs_input: "需要补充资料",
  failed: "执行失败",
  cancelled: "已取消",
  completed: "已完成",
  completed_with_warnings: "正文已交付，部分核验待完成",
};
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const gameName = (v) => {
  if (typeof v !== "string" || !v.trim() || v.length > 40)
    throw Error("请输入1–40字目标游戏");
  return v.trim();
};
async function body(req, maxLength = 100000) {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (value.length > maxLength) throw Error("请求过大");
  }
  return value ? JSON.parse(value) : {};
}
function target() {
  return (
    db.setting("destination") ||
    (process.env.TENCENT_DOCS_FILE_ID
      ? {
          file_id: process.env.TENCENT_DOCS_FILE_ID,
          url: process.env.TENCENT_DOCS_URL,
        }
      : null)
  );
}
function importBridgeSearches() {
  if (config.browserMode !== "side-browser" && config.searchMode !== "automatic") return;
  for (const request of bridge.list()) {
    if (
      request.kind === "search" &&
      request.state === "fulfilled" &&
      Array.isArray(request.result?.records)
    ) {
      const key = "bridge-import:" + request.id;
      if (!db.checkpoint(key)) {
        store.import(request.result);
        db.checkpoint(key, true);
      }
    }
  }
}
async function search(args) {
  const owner = randomUUID();
  return withBrowser(db, owner, async () => {
    const result = await searchSource(args);
    if (result.records.length)
      store.import({
        records: result.records,
        collected_at: result.searched_at,
      });
    return result;
  });
}
async function refreshSubscriptions() {
  if (schedulerBusy || config.browserMode === "side-browser") return;
  schedulerBusy = true;
  try {
    const started = Date.now();
    for (const subscription of db.subscriptions()) {
      if (
        !subscription.enabled ||
        Date.parse(subscription.next_at) > Date.now()
      )
        continue;
      if (Date.now() - started > 10 * 60000) break;
      const planned = Date.parse(subscription.next_at);
      try {
        const result = await search(subscription);
        db.subscribe({
          ...subscription,
          last_status: result.failures.length ? "partial_failure" : "success",
          last_count: result.records.length,
          last_success_at: result.failures.length
            ? subscription.last_success_at
            : new Date().toISOString(),
          last_error: null,
        });
      } catch (e) {
        db.subscribe({
          ...subscription,
          last_status: "failed",
          last_error: String(e.message).slice(0, 300),
        });
      }
      const current = db
        .subscriptions()
        .find((s) => s.key === subscription.key);
      const slots = Math.max(
        1,
        Math.floor((Date.now() - planned) / 3600000) + 1,
      );
      db.subscribe({
        ...current,
        next_at: new Date(planned + slots * 3600000).toISOString(),
        skipped_slots: slots - 1,
        last_attempt_at: new Date().toISOString(),
      });
    }
  } finally {
    schedulerBusy = false;
  }
}
const timer = setInterval(() => refreshSubscriptions().catch(() => {}), 15000);
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self'; img-src 'self' data: https://*.douyinpic.com; connect-src 'self'; frame-ancestors 'none'",
  );
  if (
    ![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(
      req.headers.host,
    )
  )
    return json(res, 403, { error: "主机不允许" });
  if (
    req.headers.origin &&
    ![origin, `http://localhost:${config.port}`].includes(req.headers.origin)
  )
    return json(res, 403, { error: "来源不允许" });
  const url = new URL(req.url, origin);
  try {
    if (req.method === "GET" && url.pathname === "/api/session")
      return json(res, 200, { token });
    if ((req.method !== "GET" || url.pathname === "/api/collector/login-view") && req.headers["x-crawl-token"] !== token)
      return json(res, 403, { error: "会话过期，请刷新" });
    if(url.pathname==='/api/quality-policy'&&req.method==='GET')return json(res,200,{experimental_quality_hold:experimentalQualityHold()});
    if(req.method==='POST'&&['/api/creative-jobs','/api/game-research'].includes(url.pathname)){
      const input=await body(req);
      return json(res,409,qualityHoldResponse(typeof input.game==='string'?db.profile(input.game.normalize('NFKC').trim()):null));
    }
    if (req.method === "POST" && config.searchMode === "automatic" &&
      ((url.pathname === "/api/game-research" && config.gameSource !== 'redfox') || url.pathname === "/api/creative-jobs") && !readiness.status().ready)
      return json(res, 409, {error:"连接尚未就绪，请在连接设置中检查所需服务后再开始任务",code:"CONNECTIONS_NOT_READY",readiness:readiness.status()});
    if (url.pathname === '/api/media-acquisition/quote' && req.method === 'POST')
      return json(res,200,await mediaAcquisition.quote(await body(req)));
    if (url.pathname === '/api/media-acquisition/start' && req.method === 'POST')
      return json(res,202,mediaAcquisition.start(await body(req)));
    if (url.pathname === '/api/media-acquisition' && req.method === 'GET')
      return json(res,200,mediaAcquisition.list());
    const mediaRoute = url.pathname.match(/^\/api\/media-acquisition\/([a-f0-9-]{36})(\/cancel)?$/);
    if (mediaRoute && req.method === (mediaRoute[2] ? 'POST' : 'GET'))
      return json(res,200,mediaRoute[2] ? mediaAcquisition.cancel(mediaRoute[1]) : mediaAcquisition.status(mediaRoute[1]));
    if (url.pathname === "/api/readiness" && req.method === "GET") {
      const source=await sourceCollector.status();
      return json(res, 200, { ...readiness.status(), enabled: config.searchMode === "automatic",providers:{game:config.gameSource,hotspots:config.hotspotSource},redfox:source.capabilities });
    }
    if(url.pathname==='/api/readiness/redfox-credential' && req.method==='POST') {
      const input=await body(req);
      await saveRedfoxCredential(redfoxCredentialPath,input.token);
      sourceCollector.invalidateCredentials();
      const selected=[];
      if(config.gameSource==='redfox'){readiness.invalidate('douyin');selected.push('douyin');}
      if(config.hotspotSource==='redfox'){readiness.invalidate('douhot');selected.push('douhot');}
      return json(res,202,{saved:true,...readiness.check(selected),enabled:config.searchMode==='automatic'});
    }
    if (url.pathname === "/api/readiness/check" && req.method === "POST") {
      const value = await body(req, 4096);
      const allowed = ["douyin", "douhot", "tencent"];
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).some(key => key !== "sites") ||
          (Object.hasOwn(value, "sites") && (!Array.isArray(value.sites) ||
            value.sites.length < 1 || value.sites.length > 3 ||
            new Set(value.sites).size !== value.sites.length ||
            value.sites.some(site => !allowed.includes(site)))))
        return json(res, 400, {error:"连接检查站点参数无效",code:"READINESS_INPUT_INVALID"});
      const selected = value.sites || allowed;
      const current = await collector.status();
      if (current.state === "login_open" && selected.some(site => site !== "tencent")) {
        // Only an explicit confirmation of this site may finish its native login.
        // A background all-sites refresh must never close a user's login window.
        if (value.sites?.length !== 1 || value.sites[0] !== current.site)
          return json(res, 409, {error:"请先完成当前平台登录并确认连接，再检查其他平台",code:"COLLECTOR_BUSY",readiness:readiness.status()});
        await collector.resume(current.site, current.login_session_id);
        readiness.invalidate(current.site);
      }
      return json(res, 202, { ...readiness.check(selected), enabled: config.searchMode === "automatic" });
    }
    if (url.pathname === "/api/readiness/tencent-credential" && req.method === "POST") {
      const input = await body(req);
      if (Object.keys(input).some(key => key !== "token"))
        return json(res, 400, {error:"授权请求字段无效"});
      await saveTencentCredential(input.token);
      readiness.invalidate("tencent");
      return json(res, 202, {saved:true, ...readiness.check(["tencent"]), enabled:config.searchMode === "automatic"});
    }
    const thumbnailRoute = url.pathname.match(
      /^\/api\/media\/(\d{10,25})\/thumbnail$/,
    );
    if (req.method === "GET" && thumbnailRoute) {
      const bytes = await readThumbnail(thumbnailRoute[1]);
      if (!bytes) return json(res, 404, { error: "暂无原片预览图" });
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", bytes.length);
      return res.end(bytes);
    }
    if (url.pathname === "/api/bridge/status" && req.method === "GET") {
      importBridgeSearches();
      return json(
        res,
        200,
        config.browserMode === "side-browser" || config.searchMode === "automatic"
          ? { ...bridge.status(), search_mode: config.searchMode,
              collector: await collector.status(),
              description: config.searchMode === "automatic"
                ? "搜索由后台自动采集；原片复核和腾讯交付仍按任务边界执行"
                : bridge.status().description }
          : { mode: "cdp", assistant_required: false, pending: [], recent: [] },
      );
    }
    if (url.pathname === "/api/collector/status" && req.method === "GET")
      return json(res, 200, await collector.status());
    if (url.pathname === "/api/collector/login" && req.method === "POST") {
      const site = (await body(req)).site;
      if (!["douyin", "douhot"].includes(site)) return json(res, 400, {error:"只允许登录抖音或热点宝"});
      const result = await collector.login(site);
      readiness.invalidate(site, {state:"login_required",message:"请完成专用窗口登录后重新检测"});
      return json(res, 200, result);
    }
    if (url.pathname === "/api/collector/login-view" && req.method === "GET")
      return json(res, 200, await collector.loginView(url.searchParams.get("site"), url.searchParams.get("session_id")));
    if (url.pathname === "/api/collector/login-input" && req.method === "POST") {
      const value = await body(req, 16384);
      if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "input,session_id,site")
        return json(res, 400, {error:"登录输入格式无效",code:"LOGIN_INPUT_INVALID"});
      return json(res, 200, await collector.loginInput(value.site, value.session_id, value.input));
    }
    if (url.pathname === "/api/collector/resume" && req.method === "POST") {
      const value = await body(req, 4096);
      if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "session_id,site" || !["douyin","douhot"].includes(value.site) || typeof value.session_id !== "string")
        return json(res, 400, {error:"登录会话参数无效",code:"LOGIN_INPUT_INVALID"});
      const result = await collector.resume(value.site, value.session_id);
      readiness.invalidate(value.site);
      return json(res, 200, {...result,readiness:readiness.check([value.site])});
    }
    const bridgeRoute = url.pathname.match(
      /^\/api\/bridge\/([a-f0-9-]+)(?:\/(approve))?$/,
    );
    if (bridgeRoute) {
      const [, id, action] = bridgeRoute;
      if (!bridge.get(id)) return json(res, 404, { error: "协作请求不存在" });
      if (req.method === "POST" && action === "approve" && bridge.get(id).kind === "delivery") return json(res,409,qualityHoldResponse());
      if (req.method === "POST" && action === "approve")
        return json(
          res,
          200,
          bridge.approve(id, (await body(req)).destination),
        );
      if (req.method === "GET" && !action) {
        importBridgeSearches();
        return json(res, 200, bridge.public(bridge.get(id)));
      }
    }
    if (url.pathname === "/api/tasks" && req.method === "GET")
      return json(
        res,
        200,
        db.list().map((t) => ({ ...t, state_label: stages[t.state] })),
      );
    const taskRoute = url.pathname.match(
      /^\/api\/tasks\/([a-f0-9-]+)(?:\/(retry|cancel))?$/,
    );
    if (taskRoute) {
      const [, id, action] = taskRoute;
      if (!db.get(id)) return json(res, 404, { error: "任务不存在" });
      const existingTask = db.get(id);
      // A verified completed receipt can be recovered read-only. No retry may
      // restart learning, model work or an unfinished delivery during the hold.
      const readOnlyRecovery = existingTask.type === 'create' && Boolean(bridge.completedDelivery?.(id));
      if (req.method === 'POST' && action === 'retry' && ['learn','create'].includes(existingTask.type) && !readOnlyRecovery)
        return json(res,409,qualityHoldResponse());
      const localLearning = existingTask.type === 'learn' && existingTask.payload.source_provider === 'redfox';
      if (req.method === "POST" && action === "retry" && !readOnlyRecovery && !localLearning && config.searchMode === "automatic" && !readiness.status().ready)
        return json(res, 409, {error:"连接尚未就绪，请完成连接检查后重试任务",code:"CONNECTIONS_NOT_READY",readiness:readiness.status()});
      if (req.method === "POST" && action)
        return json(
          res,
          200,
          action === "cancel" ? db.cancel(id) : db.retry(id),
        );
      if (req.method === "GET" && !action) return json(res, 200, db.get(id));
    }
    if (url.pathname === "/api/game-research" && req.method === "POST") {
      const input = await body(req);
      const game = gameName(input.game);
      const snapshot = config.gameSource === "redfox" ? bindLatestGameCollection(bridge, game) : null;
      const existing = db.profile(game);
      if (
        existing &&
        existing.status === 'ready' &&
        (!snapshot || existing.collection_origin?.request_id === snapshot.binding.collection_request_id) &&
        groups.independentCount(existing.relevant_video_ids || []) >= 20 &&
        Date.parse(existing.expires_at) > Date.now() &&
        !input.force
      )
        return json(res, 200, { profile: projectQualityHeldProfile(existing) });
      return json(
        res,
        202,
        db.create(
          "learn",
          { game, ...(snapshot?.binding || {}) },
          input.force
            ? randomUUID()
            : existing &&
                groups.independentCount(existing.relevant_video_ids || []) < 20
              ? "content-revalidation:" +
                hash({
                  version: existing.version,
                  groups: (existing.relevant_video_ids || []).map((id) =>
                    groups.key(id),
                  ),
                })
              : new Date().toISOString().slice(0, 10),
        ),
      );
    }
    if (url.pathname === "/api/game-profile" && req.method === "GET")
      return json(
        res,
        200,
        (() => {
          const p = db.profile(url.searchParams.get("game"));
          return p
            ? projectQualityHeldProfile({
                ...p,
                independent_content_count: groups.independentCount(
                  p.relevant_video_ids || [],
                ),
                ...(groups.independentCount(p.relevant_video_ids || []) < 20
                  ? {
                      status: "needs_input",
                      readiness_note:
                        "同内容合并后不足20个独立有效样本，请补充学习",
                    }
                  : {}),
              })
            : null;
        })(),
      );
    if (url.pathname === "/api/creative-jobs" && req.method === "POST") {
      const input = await body(req);
      const game = gameName(input.game);
      const profile = db.profile(game);
      if (
        !profile ||
        profile.status !== "ready" ||
        Date.parse(profile.expires_at) < Date.now() ||
        groups.independentCount(profile.relevant_video_ids || []) < 20
      )
        return json(res, 409, { error: "请先完成目标游戏学习" });
      const source = creativeSourceFor(
        recordsForLatest(store.all()),
        input,
        game,
        config.browserMode,
      );
      if (!source)
        throw Error("选题已失效或不属于当前游戏/热点范围，请重新查询");
      const mode = input.mode || "B",
        format = input.format || "video";
      if (!["A", "B"].includes(mode) || !["video", "image"].includes(format))
        throw Error("仅支持A/B和视频/图文");
      const output =
        config.browserMode === "side-browser" ? null : destination(target());
      return json(
        res,
        202,
        db.create(
          "create",
          {
            game,
            profile_version: profile.version,
            source,
            mode,
            format,
            destination: output,
          },
          input.new_version ? randomUUID() : "",
        ),
      );
    }
    if (url.pathname === "/api/settings") {
      if (req.method === "GET")
        return json(res, 200, {
          destination: target(),
          model: config.model,
          model_url: config.modelURL,
          browser_mode: config.browserMode,
          search_mode: config.searchMode,
          game_source:config.gameSource,
          hotspot_source:config.hotspotSource,
          collector: await collector.status(),
          assistant_required: config.browserMode === "side-browser",
        });
      if (req.method === "POST") {
        const input = await body(req);
        const value = await resolveDestination(input.destination, {previous:target()});
        db.setting("destination", value);
        readiness.invalidate("tencent");
        return json(res, 200, { destination: value, readiness: readiness.check(["tencent"]) });
      }
    }
    if (url.pathname === "/api/categories" && req.method === "GET")
      return json(res, 200, {
        categories: config.hotspotSource === "redfox" ? REDFOX_HOTSPOT_CATEGORIES.map(label=>({value:label,label})) : categories.map(({ value, label }) => ({ value, label })),
        count: config.hotspotSource === "redfox" ? REDFOX_HOTSPOT_CATEGORIES.length : categories.length,
      });
    if (
      ["/api/search", "/api/game-search", "/api/course-search"].includes(
        url.pathname,
      ) &&
      req.method === "POST"
    ) {
      let input = await body(req);
      const userInitiated=input.user_initiated===true;
      if (url.pathname === "/api/game-search")
        input = {
          keyword: gameName(input.game),
          purpose: "game-research",
          hours: input.hours || 168,
          sort: input.sort || "likes",
          board: null,
          category: "all",
        };
      if (url.pathname === "/api/course-search")
        input = {
          keyword: input.keyword || "抖音创作公开课",
          purpose: "courses",
          hours: 168,
          board: null,
          sort: "relevance",
          category: "all",
        };
      input.provider = ['game-research','game-learning'].includes(input.purpose) ? config.gameSource : input.purpose==='hotspots' ? config.hotspotSource : 'browser';
      if(input.provider==='redfox' && !userInitiated)
        return json(res,409,{error:'请点击开始查询后再请求红狐，切换筛选不会自动扣费',code:'QUERY_CONFIRM_REQUIRED'});
      delete input.user_initiated;
      if (config.searchMode === "automatic" && !collectionReady(input))
        return json(res,409,{error:'当前数据源尚未就绪，请检查对应连接或 API 配置',code:'CONNECTIONS_NOT_READY',readiness:readiness.status()});
      if (config.browserMode === "side-browser" || config.searchMode === "automatic") {
        const request = bridge.request("search", input, {
          reuseWithinMs: config.searchMode === "automatic" ? 60000 : 0,
        });
        collector.kick();
        return json(res, 202, {
          queued: request.state === "pending",
          reused_recent_result: request.state === "fulfilled",
          request_id: request.id,
          search_mode: config.searchMode,
          assistant_required: config.searchMode !== "automatic",
          state: request.state,
        });
      }
      return json(res, 200, await search(input));
    }
    if (url.pathname === "/api/hotspots" && req.method === "GET") {
      importBridgeSearches();
      let rows = recordsForLatest(store.all());
      const isGame = url.searchParams.has("game");
      const isCourse = url.searchParams.get("collection") === "courses";
      if (!isCourse && (isGame ? config.gameSource : config.hotspotSource) === "redfox") {
        const requested = isGame
          ? {provider:"redfox",purpose:"game-research",keyword:url.searchParams.get("game").normalize("NFKC").trim(),hours:168,sort:"likes",limit:30,board:null,category:"all"}
          : {provider:"redfox",purpose:"hotspots",keyword:"",board:url.searchParams.get("board") || "redfox_daily_hot",hours:Number(url.searchParams.get("hours") || 24),category:url.searchParams.get("category") || "all",sort:"likes"};
        const actual = isGame ? redfoxGameScope(requested,new Date()) : redfoxHotspotScope(requested,new Date());
        rows = rows.filter(row => row.provider === "redfox" && row.collection === (isGame ? "games" : "hotspots") &&
          row.search_keyword === requested.keyword && row.date_window === requested.hours && row.requested_sort === requested.sort &&
          row.start_date === actual.start_date && row.end_date === actual.end_date &&
          (isGame ? row.game === requested.keyword : row.board === requested.board && row.category_filter === requested.category));
        const q=(url.searchParams.get("q") || "").toLocaleLowerCase();
        rows=rows.filter(row=>(row.title+" "+row.author).toLocaleLowerCase().includes(q));
        const provenance=collectionProvenance(bridge.latestSearchForScope(requested),rows);
        const ordered=isGame ? provenance.records.sort((a,b)=>a.observed_order-b.observed_order) : provenance.records.sort((a,b)=>{
          if(url.searchParams.get("sort")==="newest")return Date.parse(b.collected_at)-Date.parse(a.collected_at);
          if(a.like_count===null)return b.like_count===null?0:1;if(b.like_count===null)return -1;
          return (url.searchParams.get("sort")==="heat_asc" ? 1 : -1)*(a.like_count-b.like_count);
        });
        return json(res,200,{records:groups.display(await annotateThumbnails(ordered)),...freshness(ordered),collection:provenance.collection});
      }
      if (url.searchParams.get("collection") === "courses")
        rows = rows.filter((r) => r.collection === "courses");
      else if (url.searchParams.has("game"))
        rows = rows.filter(
          (r) =>
            r.game === url.searchParams.get("game") && r.collection === "games",
        );
      else
        rows = rows.filter(
          (r) => !r.game && (!r.collection || r.collection === "hotspots"),
        );
      for (const [key, param] of [
        ["sub_type", "board"],
        ["date_window", "hours"],
      ])
        if (url.searchParams.get(param))
          rows = rows.filter(
            (r) => String(r[key]) === url.searchParams.get(param),
          );
      if (url.searchParams.has("category")) {
        const selectedCategory =
          resolveCategory(url.searchParams.get("category"))?.id || "all";
        rows = rows.filter(
          (r) => categoryId(r.category_filter) === selectedCategory,
        );
      }
      const q = (url.searchParams.get("q") || "").toLowerCase();
      rows = rows.filter((r) =>
        (r.title + " " + r.author).toLowerCase().includes(q),
      );
      const latestSearch = url.searchParams.has("game")
        ? bridge.latestSearchForScope({purpose:"game-research",keyword:url.searchParams.get("game")})
        : url.searchParams.get("collection") === "courses" ? null
        : bridge.latestSearchForScope({
          purpose:"hotspots", keyword:"",
          board:url.searchParams.get("board") ? Number(url.searchParams.get("board")) : null,
          hours:Number(url.searchParams.get("hours") || 24),
          category:url.searchParams.get("category") || "all",
        });
      const provenance = collectionProvenance(latestSearch, rows);
      rows = provenance.records;
      return json(res, 200, {
        records: groups.display(
          await annotateThumbnails(
            (url.searchParams.has("game") ||
            url.searchParams.get("collection") === "courses"
              ? [...rows].sort(
                  (a, b) =>
                    (a.observed_order ?? a.position_in_response) -
                    (b.observed_order ?? b.position_in_response),
                )
              : sortRows(rows, url.searchParams.get("sort") || "heat_desc")
            ).map((r) => ({
              ...r,
              category_label: categoryLabel(r.category_filter),
            })),
          ),
        ),
        ...freshness(rows),
        collection: provenance.collection,
      });
    }
    if (url.pathname === "/api/subscriptions") {
      if (req.method === "GET") return json(res, 200, db.subscriptions());
      if (req.method === "POST") {
        if (config.browserMode === "side-browser")
          return json(res, 409, {
            error: "右侧浏览器模式需助手在线，不支持无人值守订阅",
          });
        const input = await body(req);
        const targets = collectionTargets(input);
        return json(
          res,
          200,
          targets.map((t) =>
            db.subscribe({ ...t, enabled: input.enabled !== false }),
          ),
        );
      }
    }
    if (url.pathname === "/api/refresh" && req.method === "POST") {
      for (const s of db.subscriptions())
        if (s.enabled)
          db.subscribe({ ...s, next_at: new Date().toISOString() });
      refreshSubscriptions().catch(() => {});
      return json(res, 202, { started: true,experimental_quality_hold:experimentalQualityHold() });
    }
    const files = {
      "/": "index.html",
      "/app.js": "app.js",
      "/login.html": "login.html",
      "/login.js": "login.js",
      "/style.css": "style.css",
    };
    if (req.method === "GET" && files[url.pathname]) {
      res.setHeader(
        "Content-Type",
        url.pathname.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : url.pathname.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/html; charset=utf-8",
      );
      return res.end(
        await readFile(
          new URL("./public/" + files[url.pathname], import.meta.url),
        ),
      );
    }
    return json(res, 404, { error: "接口不存在" });
  } catch (e) {
    if (url.pathname.startsWith('/api/media-acquisition'))
      return json(res,400,{error:e instanceof MediaAcquisitionError ? e.message : '原片获取操作未完成，请查看任务状态；未自动重试'});
    if (url.pathname === "/api/collector/login" && e.code === "LOGIN_CONFIRM_REQUIRED")
      return json(res, 409, {error:"请先回创作台确认当前平台连接，再登录另一个平台",code:"LOGIN_CONFIRM_REQUIRED"});
    if (["/api/collector/login-input", "/api/collector/login-view", "/api/collector/resume", "/api/readiness/check"].includes(url.pathname)) {
      const messages = {
        COLLECTOR_BUSY:"登录会话忙，请稍后重试",
        LOGIN_NOT_OPEN:"登录会话尚未打开或正在关闭",
        LOGIN_SITE_MISMATCH:"登录站点已切换，请重新打开对应登录页",
        LOGIN_SESSION_MISMATCH:"登录会话已更新，请重新打开登录页",
        LOGIN_LOADING:"登录授权页面仍在加载，请稍后刷新登录视图",
        RESUME_TIMEOUT:"登录会话交接超时，请稍后重试；持续未结束时请重启创作台",
        RESUME_PENDING:"登录会话仍在核验或交接，请稍后重试",
        CLOSE_TIMEOUT:"登录浏览器关闭尚未确认，请稍后重试；持续未结束时请重启创作台",
        LOGIN_REQUIRED:"未能确认当前窗口中可见的本人账号及退出菜单。窗口已保留，请将鼠标移到右上角本人头像后再次确认连接",
        VERIFICATION_REQUIRED:"当前登录页面要求安全验证，窗口已保留，请在原生窗口完成验证后再次确认连接",
        LOGIN_CHECK_FAILED:"未能读取当前登录页面的本人账号状态，窗口已保留，请稍后再次确认连接",
        LOGIN_CHECK_TIMEOUT:"当前登录页面核验超时，窗口和会话已保留，请稍后再次确认连接",
      };
      const known = Object.hasOwn(messages,e.code);
      return json(res, known ? 409 : 400, {error:known ? messages[e.code] : "登录页面操作未完成，请刷新预览后重试",code:known || e.code === "LOGIN_INPUT_INVALID" ? e.code : "LOGIN_ACTION_FAILED"});
    }
    return json(res, 400, { error: String(e.message).slice(0, 600) });
  }
});
server.listen(config.port, "127.0.0.1", () => console.log("创作台 " + origin));
function stop() {
  clearInterval(timer);
  readinessScheduler.stop();
  worker.stop();
  mediaAcquisition.stop().catch(() => {});
  collector.stop().catch(() => {});
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
