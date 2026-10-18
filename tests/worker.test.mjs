import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tasks } from "../app/tasks.mjs";
import { startWorker } from "../app/worker.mjs";
test("共享执行器推进学习与创作直至交付，证据不足不会写腾讯（受控依赖测试）", async () => {
  const db = new Tasks(await mkdtemp(join(tmpdir(), "crawl-worker-")));
  const vids = [1, 2, 3, 4, 5].map((i) => ({
    kind: "video",
    source_id: String(12345678900 + i),
    title: "测试作品",
    author: "作者" + i,
    collected_at: new Date().toISOString(),
  }));
  let published = 0;
  const profile = {
    game: "测试游戏",
    summary: "合成测试",
    relevant_video_ids: vids.slice(0, 3).map((v) => "video:" + v.source_id),
    player_interests: [
      { text: "玩家处境", evidence_ids: ["video:" + vids[0].source_id] },
    ],
    creative_methods: [
      { text: "对比", evidence_ids: ["video:" + vids[1].source_id] },
    ],
    game_facts: [{ text: "测试事实", evidence_ids: ["web:test"] }],
    unknowns: [],
    blocking_gaps: [],
  };
  const plan = {
    game: "测试游戏",
    meaning: "热点解读",
    fit: "expression",
    rationale: "视觉表达借用",
    evidence_ids: ["video:" + vids[0].source_id],
    blocking_gaps: [],
    ideas: [
      {
        title: "完整方案",
        hook: "开头",
        bridge: "游戏处境",
        evidence_ids: ["video:" + vids[0].source_id],
        script: "完整原创台词",
        shots: [
          {
            position: "0",
            visual: "实际画面",
            text: "台词",
            sound: "建议音轨",
          },
        ],
        materials: ["素材"],
        tiers: ["低", "中", "高"].map((level) => ({
          level,
          premises: [],
          method: "制作",
          viewer_value: "观看价值",
        })),
        limitations: [],
      },
    ],
  };
  const worker = startWorker(db, {
    interval: 999999,
    model: {
      identity: async () => ({ name: "mock", digest: "fixture" }),
      json: async (system) =>
        system.includes("建立游戏研究")
          ? structuredClone(profile)
          : structuredClone(plan),
    },
    search: async () => ({ records: vids, failures: [] }),
    web: async () => [
      {
        id: "web:test",
        kind: "web",
        url: "https://example.com",
        text: "测试资料",
      },
    ],
    readMedia: async (r) => ({
      id: "video:" + r.source_id,
      kind: "video",
      url: "https://www.douyin.com/video/" + r.source_id,
      analysis: { blocking_gaps: [], needs_audio_review: false },
    }),
    publish: async () => {
      published++;
      return { warnings: [], content_status: "verified" };
    },
  });
  const learn = db.create("learn", { game: "测试游戏" });
  await worker.tick();
  assert.equal(db.get(learn.id).state, "completed");
  const create = db.create("create", {
    game: "测试游戏",
    profile_version: db.profile("测试游戏").version,
    source: vids[0],
    mode: "B",
    format: "video",
    destination: {},
  });
  await worker.tick();
  assert.equal(db.get(create.id).state, "completed");
  assert.equal(published, 1);
  plan.blocking_gaps = ["需要核对声音"];
  const blocked = db.create(
    "create",
    {
      game: "测试游戏",
      source: vids[0],
      mode: "B",
      format: "video",
      destination: {},
    },
    "new",
  );
  await worker.tick();
  assert.equal(db.get(blocked.id).state, "needs_input");
  assert.equal(published, 1);
  worker.stop();
  db.close();
});
