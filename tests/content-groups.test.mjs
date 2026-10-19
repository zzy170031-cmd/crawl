import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tasks } from "../app/tasks.mjs";
import { ContentGroups } from "../app/content-groups.mjs";
import { diversify } from "../app/media.mjs";
import { startWorker } from "../app/worker.mjs";
const samples = (n) =>
  Array.from({ length: n }, (_, i) => ({
    kind: "video",
    source_id: String(12345678900 + i),
    title: "相同标题不能自动证明相同内容",
    author: "author" + i,
    source_url: "https://www.douyin.com/video/" + String(12345678900 + i),
    game: "测试游戏",
    collection: "games",
  }));
async function setup() {
  const folder = await mkdtemp(join(tmpdir(), "crawl-content-groups-"));
  const db = new Tasks(folder);
  return { folder, db, groups: new ContentGroups(db) };
}

test("用户确认内容组持久保存而来源保留；31候选可选30独立内容", async () => {
  const { folder, db, groups } = await setup();
  try {
    const rows = samples(31);
    assert.equal(groups.independentCount(rows), 31);
    const group = groups.set(
      rows.slice(0, 2).map((r) => r.source_id),
      "用户逐条确认相同内容",
    );
    assert.equal(group.basis, "user_confirmed");
    assert.equal(groups.independentCount(rows), 30);
    assert.equal(diversify(groups.annotate(rows), 30).length, 30);
    const displayed = groups.display(rows);
    assert.equal(displayed.length, 30);
    const merged = displayed.find((r) => r.content_group_id === group.id);
    assert.equal(merged.source_count, 2);
    assert.deepEqual(
      merged.grouped_sources.map((r) => r.source_url),
      rows.slice(0, 2).map((r) => r.source_url),
    );
    assert.equal(rows.length, 31);
    assert.equal(rows[0].content_group_id, undefined);
    const secondDb = new Tasks(folder),
      reopened = new ContentGroups(secondDb);
    assert.equal(reopened.lookup(rows[1].source_id).id, group.id);
    secondDb.close();
  } finally {
    db.close();
  }
});
test("内容组不会将当前游戏之外的来源混入展示", async () => {
  const { db, groups } = await setup();
  try {
    const rows = samples(3);
    rows[1].game = "其他游戏";
    groups.set(
      rows.slice(0, 2).map((r) => r.source_id),
      "用户确认同内容",
    );
    const current = groups.display(rows.filter((r) => r.game === "测试游戏"));
    assert.equal(current.length, 2);
    assert.equal(current[0].source_count, 1);
    assert(
      current.every((r) =>
        r.grouped_sources.every((s) => s.game === "测试游戏"),
      ),
    );
  } finally {
    db.close();
  }
});
test("20个链接中的同内容双来源只算19个，学习不能ready或重复读取", { skip: '固定 experimental_quality_hold 暂停此旧执行路径；保留原算法/交付断言，门禁由 quality-policy.test.mjs 单独覆盖' }, async () => {
  const { db, groups } = await setup();
  const rows = samples(20);
  groups.set(
    rows.slice(0, 2).map((r) => r.source_id),
    "用户确认同内容",
  );
  const worker = startWorker(db, {
    interval: 999999,
    browserMode: "side-browser",
    groups,
    bridge: { request: () => ({}), wait: async () => ({ records: rows }) },
    model: {
      identity: async () => ({ name: "fixture" }),
      json: async () => assert.fail("不足独立内容不能生成ready资料"),
    },
    readMedia: async () => assert.fail("不足独立候选不开始完整学习"),
  });
  try {
    const t = db.create("learn", { game: "测试游戏" });
    await worker.tick();
    assert.equal(db.get(t.id).state, "needs_input");
    assert.equal(db.get(t.id).result.progress.candidate_count, 19);
    assert.equal(db.profile("测试游戏"), null);
  } finally {
    worker.stop();
    db.close();
  }
});

test("旧20ID资料归组后仅19内容，API在质量暂停时拒绝创作与补学并保留旧资料", async () => {
  const { folder, db, groups } = await setup(),
    rows = samples(20),
    game = "测试游戏";
  const profile = {
    game,
    status: "ready",
    version: "original-version",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    relevant_video_ids: rows.map((r) => "video:" + r.source_id),
    evidence: [],
  };
  db.profile(game, profile);
  const old = db.create(
    "learn",
    { game },
    new Date().toISOString().slice(0, 10),
  );
  db.claim("fixture");
  db.finish(old.id, "fixture", "completed", profile);
  groups.set(
    rows.slice(0, 2).map((r) => r.source_id),
    "用户确认内容重复",
  );
  const port = 14320,
    base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../app/server.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        PORT: String(port),
        CRAWL_DATA_DIR: folder,
        CRAWL_BROWSER_MODE: "side-browser",
        CRAWL_MODEL_URL: "http://127.0.0.1:1",
      },
      stdio: "pipe",
    },
  );
  try {
    let token;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(base + "/api/session");
        if (r.ok) {
          token = (await r.json()).token;
          break;
        }
      } catch {}
      await delay(50);
    }
    assert(token);
    const get = await (
      await fetch(base + "/api/game-profile?game=" + encodeURIComponent(game))
    ).json();
    assert.equal(get.independent_content_count, 19);
    assert.equal(get.status, "needs_input");
    assert.equal(db.profile(game).status, "ready");
    const post = (path, payload) =>
      fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-crawl-token": token },
        body: JSON.stringify(payload),
      });
    assert.equal(
      (
        await post("/api/creative-jobs", {
          game,
          source_id: rows[0].source_id,
          kind: "video",
        })
      ).status,
      409,
    );
    const next = await post("/api/game-research", { game });
    assert.equal(next.status, 409);
    assert.equal((await next.json()).code, "EXPERIMENTAL_QUALITY_HOLD");
    assert.equal(db.list().length, 1);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    db.close();
  }
});
