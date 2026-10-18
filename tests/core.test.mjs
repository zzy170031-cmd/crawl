import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tasks, hash } from "../app/tasks.mjs";
import { Model } from "../app/model.mjs";
import { collectionTargets, categories } from "../app/categories.mjs";
import { sortRows } from "../app/sorting.mjs";
import {
  validatePlan,
  validateSchema,
  mediaSchema,
} from "../app/contracts.mjs";
import { deliver, composeRows } from "../app/delivery.mjs";
const folder = () => mkdtemp(join(tmpdir(), "crawl-test-"));
export const examplePlan = () => ({
  game: "测试游戏",
  meaning: "合成测试素材，不是真实热点",
  fit: "player_context",
  rationale: "测试理由",
  evidence_ids: ["video:12345678901", "web:game"],
  blocking_gaps: [],
  ideas: [
    {
      title: "原创测试方案",
      hook: "测试开头",
      bridge: "玩家处境",
      evidence_ids: ["video:12345678901", "web:game"],
      script: "甲：今晚还来吗？\n乙：忙完就来。",
      shots: [
        {
          position: "开场",
          visual: "自己的游戏画面",
          text: "原创台词",
          sound: "建议环境音",
        },
      ],
      materials: ["自录素材"],
      tiers: ["低", "中", "高"].map((level) => ({
        level,
        premises: ["自己的素材"],
        method: "独立表达完整内容",
        viewer_value: "看懂处境",
      })),
      limitations: ["合成测试"],
    },
  ],
});
const evidence = [
  {
    id: "web:game",
    kind: "web",
    role: "game",
    url: "https://example.com/game",
    title: "合成游戏资料",
    read_at: "2026-10-18",
  },
  {
    id: "video:12345678901",
    source_id: "12345678901",
    kind: "video",
    role: "hotspot",
    url: "https://www.douyin.com/video/12345678901",
    title: "合成测试",
    read_at: "2026-10-18",
    coverage: { visual: "sampled_frames" },
    analysis: { observations: [{ time: 0, text: "测试画面" }] },
  },
];
test("跨实例租约、恢复、取消及幂等不重复执行", async () => {
  const dir = await folder(),
    a = new Tasks(dir),
    b = new Tasks(dir);
  const task = a.create("learn", { game: "测试" });
  assert.equal(b.create("learn", { game: "测试" }).id, task.id);
  assert.equal(a.claim("one").id, task.id);
  assert.equal(b.claim("two"), null);
  a.db.prepare("UPDATE tasks SET lease=0").run();
  assert.equal(b.claim("two").id, task.id);
  assert.equal(a.heartbeat(task.id, "one"), false);
  b.cancel(task.id);
  b.finish(task.id, "two", "completed", {});
  assert.equal(a.get(task.id).state, "cancelled");
  a.retry(task.id);
  assert.equal(a.get(task.id).state, "queued");
  assert(a.lock("browser", "a"));
  assert(!b.lock("browser", "b"));
  a.close();
  b.close();
});
test("期望订阅与快照独立，next_at可更新", async () => {
  const db = new Tasks(await folder());
  const s = db.subscribe({
    board: 1001,
    hours: 24,
    category: "all",
    enabled: true,
  });
  const next = "2030-01-01T00:00:00.000Z";
  db.subscribe({ ...s, last_status: "failed", next_at: next });
  assert.equal(db.subscriptions()[0].next_at, next);
  db.subscribe({ ...s, enabled: false });
  assert.equal(db.subscriptions()[0].enabled, false);
  db.close();
});
test("一级行业与跨榜排序不会混为综合排行", () => {
  assert.equal(categories.length, 38);
  assert.equal(
    collectionTargets({ category: String(categories[0].value), hours: 24 })
      .length,
    5,
  );
  assert.throws(
    () =>
      collectionTargets({ category: String(categories[0].value), board: 3001 }),
    /行业/,
  );
  const rows = sortRows([
    { source_id: "a", sub_type: 1001, date_window: 24, score: 1 },
    { source_id: "b", sub_type: 3001, date_window: 24, score: 9999 },
    { source_id: "c", sub_type: 1001, date_window: 24, score: 3 },
  ]);
  assert.deepEqual(
    rows.map((r) => r.source_id),
    ["c", "a", "b"],
  );
});
test("方案必须引用实际证据，不接受空脚本或跨游戏模板", () => {
  assert(validatePlan(examplePlan(), evidence, "测试游戏"));
  assert.throws(
    () =>
      validatePlan({ ...examplePlan(), game: "另一款" }, evidence, "测试游戏"),
    /不一致/,
  );
  const p = examplePlan();
  p.ideas[0].script = "";
  assert.throws(() => validatePlan(p, evidence, "测试游戏"), /不完整/);
  const bad = examplePlan();
  bad.ideas[0].evidence_ids = ["unknown"];
  assert.throws(() => validatePlan(bad, evidence, "测试游戏"), /来源/);
});
test("完整文案与所有原片引用保留，不截成五条或5000字", () => {
  const p = examplePlan();
  p.ideas[0].script = "正文".repeat(3500);
  const draft = composeRows(
    { payload: { mode: "A" } },
    p,
    Array.from({ length: 8 }, (_, i) => ({
      ...evidence.find((e) => e.kind === "video"),
      id: "video:" + i,
    })),
  );
  assert(draft.rows.some((r) => r[1] === p.ideas[0].script));
  assert.equal(draft.links.length, 8);
});
test("模型流必须done且可跨字节，错误不可回退模板", async () => {
  const content =
    JSON.stringify({ message: { content: '{"文字":"成功"}' }, done: true }) +
    "\n";
  const bytes = new TextEncoder().encode(content);
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const b of bytes) c.enqueue(new Uint8Array([b]));
          c.close();
        },
      }),
    );
  const model = new Model({ fetchImpl });
  assert.deepEqual(await model.json("test", {}, {}), { 文字: "成功" });
  const incomplete = new Model({
    fetchImpl: async () => new Response('{"message":{"content":"{}"}}\n'),
  });
  await assert.rejects(incomplete.json("", {}, {}), /未完整/);
});
function fakeClient({ loseResponse = false, partial = false } = {}) {
  const sheets = [],
    cells = [];
  let creates = 0,
    writes = 0;
  return {
    sheets,
    cells,
    get creates() {
      return creates;
    },
    get writes() {
      return writes;
    },
    async call(name, args) {
      if (name === "sheet_get_sheet_info") return { sheets };
      if (name === "sheet_add_sheet") {
        creates++;
        const s = { sheet_id: "test", sheet_name: args.name };
        sheets.push(s);
        return s;
      }
      if (name === "sheet_get_cell_data")
        return {
          cells: cells.filter(
            (c) => c.row >= args.start_row && c.row <= args.end_row,
          ),
        };
      if (name === "sheet_set_range_value") {
        writes++;
        const values = partial ? args.values.slice(0, 2) : args.values;
        for (const c of values) {
          const old = cells.find((o) => o.row === c.row && o.col === c.col);
          if (old) Object.assign(old, c);
          else cells.push({ ...c });
        }
        if (loseResponse || partial) {
          loseResponse = false;
          partial = false;
          throw Error("response lost");
        }
      }
      return {};
    },
  };
}
test("腾讯写入丢响应可恢复，重命名/人工编辑不被重复提交覆盖", async () => {
  const db = new Tasks(await folder()),
    client = fakeClient({ loseResponse: true });
  const task = {
    id: "synthetic-task",
    payload: {
      mode: "B",
      destination: {
        file_id: "test-file",
        url: "https://docs.qq.com/sheet/test",
      },
    },
  };
  const args = {
    task,
    plan: examplePlan(),
    evidence,
    db,
    client,
    verify: async () => ({ content: true, links: true, styles: true }),
  };
  await assert.rejects(deliver(args));
  const receipt = await deliver(args);
  assert.equal(receipt.content_status, "verified");
  assert.equal(client.creates, 1);
  const count = client.writes;
  client.sheets[0].sheet_name = "人工改名";
  client.cells[0].string_value = "人工内容";
  assert((await deliver(args)).cached);
  assert.equal(client.writes, count);
  assert.equal(client.cells[0].string_value, "人工内容");
  db.close();
});
test("不明确的部分写入不会覆盖人工清空，导出正文不符不能完成", async () => {
  const db = new Tasks(await folder()),
    client = fakeClient({ partial: true });
  const task = {
    id: "partial-task",
    payload: {
      mode: "B",
      destination: {
        file_id: "test-file",
        url: "https://docs.qq.com/sheet/test",
      },
    },
  };
  const args = {
    task,
    plan: examplePlan(),
    evidence,
    db,
    client,
    verify: async () => ({ content: true, links: true, styles: true }),
  };
  await assert.rejects(deliver(args));
  await assert.rejects(deliver(args), /无法区分/);
  const db2 = new Tasks(await folder());
  await assert.rejects(
    deliver({
      ...args,
      db: db2,
      client: fakeClient(),
      verify: async () => ({ content: false, links: false, styles: false }),
    }),
    /导出正文/,
  );
  db.close();
  db2.close();
});
test("二进制哈希与真实音轨SHA一致", () => {
  assert.equal(
    hash(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("空画面观察与缺少热点引用的方案不能通过", () => {
  assert.throws(
    () =>
      validateSchema(
        {
          summary: "仅标题",
          observations: [],
          speech_notes: "",
          creative_methods: [],
          uncertainties: [],
          blocking_gaps: [],
          needs_audio_review: false,
        },
        mediaSchema,
      ),
    /实际观察/,
  );
  const p = examplePlan();
  p.evidence_ids = ["web:game"];
  assert.throws(() => validatePlan(p, evidence, "测试游戏"), /同时引用/);
});
