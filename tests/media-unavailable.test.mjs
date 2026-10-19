import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const folder = await mkdtemp(join(tmpdir(), "crawl-unavailable-"));
process.env.CRAWL_DATA_DIR = folder;
const { Tasks } = await import("../app/tasks.mjs");
const { SideBridge } = await import("../app/side-bridge.mjs");
const { inspectMedia } = await import("../app/media.mjs");
const { MediaUnavailableError } = await import("../app/media-unavailable.mjs");
const { prepareSideMedia } = await import("../app/prepare-side-media.mjs");
const { startWorker } = await import("../app/worker.mjs");
const unavailable = (id) => ({
  status: "unavailable",
  source_id: id,
  url: `https://www.douyin.com/video/${id}`,
  reason: "页面仅提供 blob 媒体，本次无法取得原片",
  observed_at: new Date().toISOString(),
});

test("不可读回填严格绑定原片、原因和观察时间，保留回执且重试可重新观察", async () => {
  const db = new Tasks(
    await mkdtemp(join(tmpdir(), "crawl-unavailable-bridge-")),
  );
  const bridge = new SideBridge(db);
  try {
    const task = db.create("learn", { game: "test" });
    const request = bridge.request(
      "media",
      { source_id: "12345678901" },
      { taskId: task.id },
    );
    const value = unavailable("12345678901");
    const fulfill = (result) =>
      bridge.fulfill(request.id, {
        request_id: request.id,
        task_id: task.id,
        result,
      });
    for (const invalid of [
      { ...value, source_id: "12345678902" },
      { ...value, url: "https://www.douyin.com/video/12345678902" },
      { ...value, reason: "" },
      { ...value, observed_at: "2036-01-01T00:00:00Z" },
      { ...value, source_path: "/tmp/fake.mp4" },
      { ...value, analysis: {} },
      { ...value, status: "skip" },
    ])
      assert.throws(() => fulfill(invalid));
    const result = fulfill(value);
    assert.equal(result.state, "fulfilled");
    assert.deepEqual(result.result, value);
    const next = bridge.request("media", request.payload, { taskId: task.id });
    assert.notEqual(next.id, request.id);
    assert.equal(bridge.get(request.id).result.status, "unavailable");
    await assert.rejects(
      inspectMedia(
        { kind: "video", source_id: value.source_id },
        {
          browserMode: "side-browser",
          stage: () => {},
          bridge: { request: () => request, wait: async () => result.result },
          model: { json: () => assert.fail("不可读媒体不能调用模型") },
        },
      ),
      (e) =>
        e instanceof MediaUnavailableError &&
        e.observation.source_id === value.source_id,
    );
  } finally {
    db.close();
  }
});

test("已下载原片仅明确超过900秒可跳过，ffprobe损坏错误仍抛出", async (t) => {
  const exec = promisify(execFile);
  try {
    await exec("ffmpeg", ["-version"]);
    await exec("ffprobe", ["-version"]);
  } catch (e) {
    if (e.code === "ENOENT") {
      t.skip("ffmpeg/ffprobe未安装");
      return;
    }
    throw e;
  }
  const id = "12345678998",
    dir = join(folder, "media", id);
  await mkdir(dir, { recursive: true });
  const source_path = join(dir, "source.mp4");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=16x16:r=1/901",
    "-frames:v",
    "1",
    "-c:v",
    "mpeg4",
    source_path,
  ]);
  const original = await readFile(source_path);
  const media = {
    source_id: id,
    url: `https://www.douyin.com/video/${id}`,
    source_path,
  };
  await assert.rejects(
    prepareSideMedia(media),
    (e) =>
      e instanceof MediaUnavailableError &&
      /901.*900/.test(e.observation.reason),
  );
  assert.deepEqual(await readFile(source_path), original);
  assert.deepEqual(await readdir(dir), ["source.mp4"]);
  await writeFile(source_path, "corrupt controlled fixture");
  await assert.rejects(
    prepareSideMedia(media),
    (e) => !(e instanceof MediaUnavailableError),
  );
});

function profile(ids) {
  return {
    game: "测试游戏",
    summary: "受控测试",
    relevant_video_ids: ids,
    player_interests: [{ text: "关注", evidence_ids: [ids[0]] }],
    creative_methods: [{ text: "创作方法", evidence_ids: [ids[0]] }],
    game_facts: [{ text: "事实", evidence_ids: ["web:test"] }],
    unknowns: [],
    blocking_gaps: [],
  };
}
for (const scenario of [
  "one-unavailable",
  "eleven-unavailable",
  "generic-error",
  "spoofed-code",
  "wrong-source",
]) {
  test(`学习不可读候选隔离且有效20条门槛不降：${scenario}`, async () => {
    const db = new Tasks(
      await mkdtemp(join(tmpdir(), "crawl-unavailable-worker-")),
    );
    const rows = Array.from({ length: 30 }, (_, i) => ({
      kind: "video",
      source_id: String(12345678000 + i),
      title: "fixture",
      author: "a" + i,
    }));
    const successful = [],
      calls = [];
    let modelCalls = 0;
    const worker = startWorker(db, {
      interval: 999999,
      browserMode: "side-browser",
      bridge: {
        request: (kind, payload) => ({ kind, payload }),
        wait: async () => ({ records: rows }),
      },
      fingerprintMedia: async () => null,
      model: {
        identity: async () => ({ name: "fixture" }),
        json: async () => {
          modelCalls++;
          return profile(successful);
        },
      },
      readMedia: async (row) => {
        calls.push(row.source_id);
        const index = rows.findIndex((r) => r.source_id === row.source_id);
        if (index === 0 || (scenario === "eleven-unavailable" && index < 11)) {
          if (scenario === "generic-error")
            throw Error("controlled model failure");
          if (scenario === "spoofed-code")
            throw Object.assign(Error("not a source observation"), {
              code: "MEDIA_UNAVAILABLE",
            });
          throw new MediaUnavailableError(
            unavailable(
              scenario === "wrong-source" ? "12345678999" : row.source_id,
            ),
          );
        }
        const id = "video:" + row.source_id;
        successful.push(id);
        return {
          id,
          kind: "video",
          analysis: { blocking_gaps: [], needs_audio_review: false },
          subtitle_review: { status: "reviewed_no_changes" },
        };
      },
      web: async () => [
        {
          id: "web:test",
          kind: "web",
          text: "fixture",
          url: "https://example.com",
        },
      ],
      publish: async () => assert.fail("学习不应交付"),
    });
    try {
      const task = db.create("learn", { game: "测试游戏" });
      await worker.tick();
      const outcome = db.get(task.id);
      if (
        ["generic-error", "spoofed-code", "wrong-source"].includes(scenario)
      ) {
        assert.equal(outcome.state, "failed");
        assert.equal(calls.length, 1);
        assert.equal(modelCalls, 0);
        assert.equal(outcome.result.unavailable_sources.length, 0);
      } else {
        const unavailableCount = scenario === "one-unavailable" ? 1 : 11;
        assert.equal(
          outcome.state,
          unavailableCount === 1 ? "completed" : "needs_input",
        );
        assert.equal(calls.length, 30);
        assert.equal(
          outcome.result.progress.verified_count,
          30 - unavailableCount,
        );
        assert.equal(outcome.result.progress.read_count, 30 - unavailableCount);
        assert.equal(
          outcome.result.progress.unavailable_count,
          unavailableCount,
        );
        assert.equal(
          outcome.result.unavailable_sources.length,
          unavailableCount,
        );
        assert.equal(
          outcome.result.evidence.filter((e) => e.kind === "video").length,
          30 - unavailableCount,
        );
        assert.equal(modelCalls, unavailableCount === 1 ? 1 : 0);
        assert(
          db.checkpoint(
            "unavailable-media:" + task.id + ":" + rows[0].source_id,
          ),
        );
        assert.equal(
          db.checkpoint("video-evidence:" + task.id + ":" + rows[0].source_id),
          null,
        );
      }
    } finally {
      worker.stop();
      db.close();
    }
  });
}

test("创作原片不可读直接阻止模型生成和交付", async () => {
  const db = new Tasks(
    await mkdtemp(join(tmpdir(), "crawl-unavailable-create-")),
  );
  db.profile("测试游戏", {
    ...profile(
      Array.from({ length: 20 }, (_, i) => "video:" + (12345678000 + i)),
    ),
    expires_at: new Date(Date.now() + 100000).toISOString(),
    status: "ready",
    evidence: [],
  });
  const row = { kind: "video", source_id: "12345678901", title: "fixture" };
  const worker = startWorker(db, {
    interval: 999999,
    browserMode: "side-browser",
    bridge: {
      request: (kind) => {
        assert.equal(kind, "search");
        return {};
      },
      wait: async () => ({ records: [] }),
    },
    model: {
      identity: async () => ({ name: "fixture" }),
      json: async () => assert.fail("不能生成未读原片策划"),
    },
    readMedia: async () => {
      throw new MediaUnavailableError(unavailable(row.source_id));
    },
    publish: async () => assert.fail("不可交付"),
  });
  try {
    const task = db.create("create", {
      game: "测试游戏",
      source: row,
      mode: "A",
      format: "video",
    });
    await worker.tick();
    assert.equal(db.get(task.id).state, "needs_input");
    assert.match(db.get(task.id).error, /不可读/);
  } finally {
    worker.stop();
    db.close();
  }
});
