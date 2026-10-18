import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { config } from "./config.mjs";
import { Tasks } from "./tasks.mjs";
import { defaultStore, recordsForLatest } from "./store.mjs";
import {
  categories,
  categoryMatches,
  categoryLabel,
  collectionTargets,
} from "./categories.mjs";
import { sortRows } from "./sorting.mjs";
import { freshness } from "./freshness.mjs";
import { searchSource } from "./search.mjs";
import { startWorker, withBrowser } from "./worker.mjs";
import { destination } from "./delivery.mjs";
const db = new Tasks(),
  store = defaultStore(),
  worker = startWorker(db);
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
async function body(req) {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 100000) throw Error("请求过大");
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
  if (schedulerBusy) return;
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
    "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
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
    if (req.method !== "GET" && req.headers["x-crawl-token"] !== token)
      return json(res, 403, { error: "会话过期，请刷新" });
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
      const existing = db.profile(game);
      if (
        existing &&
        Date.parse(existing.expires_at) > Date.now() &&
        !input.force
      )
        return json(res, 200, { profile: existing });
      return json(
        res,
        202,
        db.create(
          "learn",
          { game },
          input.force ? randomUUID() : new Date().toISOString().slice(0, 10),
        ),
      );
    }
    if (url.pathname === "/api/game-profile" && req.method === "GET")
      return json(res, 200, db.profile(url.searchParams.get("game")));
    if (url.pathname === "/api/creative-jobs" && req.method === "POST") {
      const input = await body(req);
      const game = gameName(input.game);
      const profile = db.profile(game);
      if (!profile || Date.parse(profile.expires_at) < Date.now())
        return json(res, 409, { error: "请先完成目标游戏学习" });
      const source = recordsForLatest(store.all()).find(
        (r) => r.source_id === input.source_id && r.kind === input.kind,
      );
      if (!source) throw Error("选题已失效，请重新查询");
      const mode = input.mode || "B",
        format = input.format || "video";
      if (!["A", "B"].includes(mode) || !["video", "image"].includes(format))
        throw Error("仅支持A/B和视频/图文");
      const output = destination(target());
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
        });
      if (req.method === "POST") {
        const input = await body(req);
        const value = destination(input.destination);
        db.setting("destination", value);
        return json(res, 200, { destination: value });
      }
    }
    if (url.pathname === "/api/categories" && req.method === "GET")
      return json(res, 200, {
        categories: categories.map(({ value, label }) => ({ value, label })),
        count: categories.length,
      });
    if (url.pathname === "/api/search" && req.method === "POST")
      return json(res, 200, await search(await body(req)));
    if (url.pathname === "/api/hotspots" && req.method === "GET") {
      let rows = recordsForLatest(store.all());
      for (const [key, param] of [
        ["sub_type", "board"],
        ["date_window", "hours"],
      ])
        if (url.searchParams.get(param))
          rows = rows.filter(
            (r) => String(r[key]) === url.searchParams.get(param),
          );
      if (url.searchParams.has("category"))
        rows = rows.filter((r) =>
          categoryMatches(r.category_filter, url.searchParams.get("category")),
        );
      const q = (url.searchParams.get("q") || "").toLowerCase();
      rows = rows.filter((r) =>
        (r.title + " " + r.author).toLowerCase().includes(q),
      );
      return json(res, 200, {
        records: sortRows(
          rows,
          url.searchParams.get("sort") || "heat_desc",
        ).map((r) => ({
          ...r,
          category_label: categoryLabel(r.category_filter),
        })),
        ...freshness(rows),
      });
    }
    if (url.pathname === "/api/subscriptions") {
      if (req.method === "GET") return json(res, 200, db.subscriptions());
      if (req.method === "POST") {
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
      return json(res, 202, { started: true });
    }
    const files = {
      "/": "index.html",
      "/app.js": "app.js",
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
    return json(res, 400, { error: String(e.message).slice(0, 600) });
  }
});
server.listen(config.port, "127.0.0.1", () => console.log("创作台 " + origin));
function stop() {
  clearInterval(timer);
  worker.stop();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
