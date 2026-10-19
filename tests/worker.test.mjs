import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tasks } from "../app/tasks.mjs";
import { startWorker } from "../app/worker.mjs";
test("共享执行器推进学习与创作直至交付，证据不足不会写腾讯（受控依赖测试）", async () => {
  const db = new Tasks(await mkdtemp(join(tmpdir(), "crawl-worker-")));
  const vids = Array.from({ length: 20 }, (_, i) => i + 1).map((i) => ({
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
    relevant_video_ids: vids.slice(0, 20).map((v) => "video:" + v.source_id),
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

test("学习检索区分连接失败与空结果，且不泄露来源错误细节", async () => {
  for (const kind of ["connection", "source", "empty"]) {
    const db = new Tasks(await mkdtemp(join(tmpdir(), "crawl-search-error-")));
    const worker = startWorker(db, {
      interval: 999999,
      model: { identity: async () => ({ name: "mock" }) },
      search: async () => {
        if (kind === "empty") return { records: [], failures: [] };
        const error = Error("private-source-detail");
        if (kind === "connection") error.code = "BROWSER_UNAVAILABLE";
        throw error;
      },
      readMedia: async () => assert.fail("不能读取缺失候选"),
      publish: async () => assert.fail("不能交付"),
    });
    try {
      const task = db.create("learn", { game: "率土之滨" });
      await worker.tick();
      const result = db.get(task.id);
      assert.equal(result.state, kind === "empty" ? "needs_input" : "failed");
      assert.match(
        result.error,
        kind === "connection"
          ? /后台未连接/
          : kind === "empty"
            ? /不是抖音全站搜索/
            : /4\/4 次榜单查询失败/,
      );
      assert(!result.error.includes("private-source-detail"));
      assert.equal(db.checkpoint("samples:" + task.id), null);
    } finally {
      worker.stop();
      db.close();
    }
  }
});

test("旧版不足样本缓存不会阻止重试重新查询", async () => {
  const db = new Tasks(await mkdtemp(join(tmpdir(), "crawl-sample-retry-")));
  let calls = 0;
  const worker = startWorker(db, {
    interval: 999999,
    model: { identity: async () => ({ name: "mock" }) },
    search: async () => {
      calls++;
      return { records: [], failures: [] };
    },
  });
  try {
    const task = db.create("learn", { game: "率土之滨" });
    db.checkpoint("samples:" + task.id, []);
    await worker.tick();
    assert.equal(calls, 4);
    db.retry(task.id);
    await worker.tick();
    assert.equal(calls, 8);
    assert.equal(db.get(task.id).state, "needs_input");
  } finally {
    worker.stop();
    db.close();
  }
});

test("右侧学习池必须20条有效实读，19条候选或未核验字幕不能完成（受控依赖）", async () => {
  for (const scenario of ["nineteen", "unreviewed", "twenty"]) {
    const db = new Tasks(await mkdtemp(join(tmpdir(), "crawl-learn20-")));
    const count = scenario === "nineteen" ? 19 : 20;
    const rows = Array.from({ length: count }, (_, i) => ({
      kind: "video",
      source_id: String(12345678900 + i),
      title: "真实阅读受控替身",
      author: "author" + i,
    }));
    let mediaCalls = 0,
      modelCalls = 0;
    const bridge = {
      request: (kind, payload) => ({ kind, payload }),
      wait: async (r) => ({ records: rows, failures: [] }),
    };
    const worker = startWorker(db, {
      interval: 999999,
      browserMode: "side-browser",
      bridge,
      model: {
        identity: async () => ({ name: "controlled-fixture" }),
        json: async () => {
          modelCalls++;
          return {
            game: "率土之滨",
            summary: "受控验证",
            relevant_video_ids: rows.map((r) => "video:" + r.source_id),
            player_interests: [
              {
                text: "玩家关注",
                evidence_ids: ["video:" + rows[0].source_id],
              },
            ],
            creative_methods: [
              {
                text: "创作方法",
                evidence_ids: ["video:" + rows[0].source_id],
              },
            ],
            game_facts: [{ text: "游戏事实", evidence_ids: ["web:test"] }],
            unknowns: [],
            blocking_gaps: [],
          };
        },
      },
      readMedia: async (r) => {
        mediaCalls++;
        return {
          id: "video:" + r.source_id,
          kind: "video",
          analysis: { blocking_gaps: [], needs_audio_review: false },
          subtitle_review: {
            status:
              scenario === "unreviewed"
                ? "needs_review"
                : "reviewed_no_changes",
          },
        };
      },
      web: async () => [
        {
          id: "web:test",
          kind: "web",
          url: "https://example.com",
          text: "测试实际资料替身",
        },
      ],
    });
    try {
      const task = db.create("learn", { game: "率土之滨" });
      await worker.tick();
      const outcome = db.get(task.id);
      assert.equal(
        outcome.state,
        scenario === "twenty" ? "completed" : "needs_input",
      );
      assert.equal(mediaCalls, scenario === "nineteen" ? 0 : 20);
      assert.equal(modelCalls, scenario === "twenty" ? 1 : 0);
      assert.equal(outcome.result.progress.minimum_required, 20);
      assert.equal(outcome.result.progress.target, 30);
      if (scenario === "twenty")
        assert.equal(db.profile("率土之滨").progress.verified_count, 20);
      else assert.equal(db.profile("率土之滨"), null);
    } finally {
      worker.stop();
      db.close();
    }
  }
});

test("学习不足时重试重新补样并复核失败证据，不把旧needs_review永远缓存", async () => {
  const db = new Tasks(await mkdtemp(join(tmpdir(), "crawl-relearn-")));
  const rows = Array.from({ length: 20 }, (_, i) => ({
    kind: "video",
    source_id: String(12345678900 + i),
    title: "受控样本",
    author: "a" + i,
  }));
  let searches = 0,
    reads = 0,
    reviewed = false;
  const revisions = new Set();
  const bridge = {
    request: (kind, payload) => ({ kind, payload }),
    wait: async () => {
      searches++;
      return { records: rows, failures: [] };
    },
  };
  const worker = startWorker(db, {
    interval: 999999,
    browserMode: "side-browser",
    bridge,
    model: {
      identity: async () => ({ name: "fixture" }),
      json: async () => ({
        game: "率土之滨",
        summary: "受控复核",
        relevant_video_ids: rows.map((r) => "video:" + r.source_id),
        player_interests: [
          { text: "关注", evidence_ids: ["video:" + rows[0].source_id] },
        ],
        creative_methods: [
          { text: "方法", evidence_ids: ["video:" + rows[0].source_id] },
        ],
        game_facts: [{ text: "事实", evidence_ids: ["web:test"] }],
        unknowns: [],
        blocking_gaps: [],
      }),
    },
    readMedia: async (r, ctx) => {
      reads++;
      revisions.add(ctx.reviewRevision);
      return {
        id: "video:" + r.source_id,
        kind: "video",
        analysis: { blocking_gaps: [], needs_audio_review: !reviewed },
        subtitle_review: {
          status: reviewed ? "reviewed_no_changes" : "needs_review",
        },
      };
    },
    web: async () => [
      { id: "web:test", kind: "web", url: "https://example.com", text: "资料" },
    ],
  });
  try {
    const t = db.create("learn", { game: "率土之滨" });
    await worker.tick();
    assert.equal(db.get(t.id).state, "needs_input");
    assert.equal(reads, 20);
    reviewed = true;
    db.retry(t.id);
    await worker.tick();
    assert.equal(db.get(t.id).state, "completed");
    assert.equal(searches, 2);
    assert.equal(reads, 40);
    assert.equal(revisions.size, 2);
  } finally {
    worker.stop();
    db.close();
  }
});

test("已回读交付的任务重试直接恢复原草稿和回执，不再调用模型或来源", async () => {
  const db = new Tasks(
    await mkdtemp(join(tmpdir(), "crawl-delivery-recover-")),
  );
  const originalPlan = { text: "已交付原稿" },
    originalEvidence = [{ id: "source-original" }],
    receipt = { status: "completed", warnings: [], readback_verified: true };
  const worker = startWorker(db, {
    interval: 999999,
    browserMode: "side-browser",
    bridge: {
      completedDelivery: () => ({
        payload: { plan: originalPlan, evidence: originalEvidence },
        result: receipt,
      }),
    },
    model: {
      identity: async () => assert.fail("不得重新初始化模型"),
      json: async () => assert.fail("不得重新生成稿件"),
    },
    readMedia: async () => assert.fail("不得重读改变已交付稿件"),
  });
  try {
    const t = db.create("create", {
      game: "率土之滨",
      source: { kind: "video", source_id: "12345678901" },
    });
    await worker.tick();
    const result = db.get(t.id);
    assert.equal(result.state, "completed");
    assert.deepEqual(result.result.plan, originalPlan);
    assert.deepEqual(result.result.evidence, originalEvidence);
    assert.deepEqual(result.result.delivery, receipt);
  } finally {
    worker.stop();
    db.close();
  }
});

test("不足20的候选也保存，19条后仅补1条可合并成20条继续实读", async () => {
  const db = new Tasks(await mkdtemp(join(tmpdir(), "crawl-add-one-")));
  const rows = Array.from({ length: 20 }, (_, i) => ({
    kind: "video",
    source_id: String(12345678900 + i),
    title: "受控样本",
    author: "a" + i,
  }));
  let searches = 0,
    reads = 0;
  const worker = startWorker(db, {
    interval: 999999,
    browserMode: "side-browser",
    bridge: {
      request: () => ({}),
      wait: async () => ({
        records: ++searches === 1 ? rows.slice(0, 19) : rows.slice(19),
      }),
    },
    model: {
      identity: async () => ({ name: "fixture" }),
      json: async () => ({
        game: "率土之滨",
        summary: "受控补样",
        relevant_video_ids: rows.map((r) => "video:" + r.source_id),
        player_interests: [
          { text: "关注", evidence_ids: ["video:" + rows[0].source_id] },
        ],
        creative_methods: [
          { text: "方法", evidence_ids: ["video:" + rows[0].source_id] },
        ],
        game_facts: [{ text: "事实", evidence_ids: ["web:test"] }],
        unknowns: [],
        blocking_gaps: [],
      }),
    },
    readMedia: async (r) => {
      reads++;
      return {
        id: "video:" + r.source_id,
        kind: "video",
        analysis: { needs_audio_review: false, blocking_gaps: [] },
        subtitle_review: { status: "reviewed_no_changes" },
      };
    },
    web: async () => [{ id: "web:test", kind: "web", text: "受控资料" }],
  });
  try {
    const t = db.create("learn", { game: "率土之滨" });
    await worker.tick();
    assert.equal(db.get(t.id).state, "needs_input");
    assert.equal(db.checkpoint("samples:" + t.id).length, 19);
    db.retry(t.id);
    await worker.tick();
    assert.equal(searches, 2);
    assert.equal(reads, 20);
    assert.equal(db.get(t.id).state, "completed");
  } finally {
    worker.stop();
    db.close();
  }
});

test("跨版本滚动学习复用未变已核验证据，新来源与变更媒体重新读取", async () => {
  const db = new Tasks(await mkdtemp(join(tmpdir(), "crawl-rolling-")));
  const rows = Array.from({ length: 21 }, (_, i) => ({
    kind: "video",
    source_id: String(12345678900 + i),
    title: "受控样本",
    author: "a" + i,
  }));
  let round = 0,
    reads = 0;
  const revisions = new Map(rows.map((r) => [r.source_id, "v1"]));
  const currentRows = () => (round === 0 ? rows.slice(0, 20) : rows.slice(1));
  const worker = startWorker(db, {
    interval: 999999,
    browserMode: "side-browser",
    bridge: {
      request: () => ({}),
      wait: async () => ({ records: currentRows() }),
    },
    fingerprintMedia: async (r) =>
      r.source_id + ":" + revisions.get(r.source_id),
    model: {
      identity: async () => ({ name: "fixture" }),
      json: async () => ({
        game: "率土之滨",
        summary: "滚动受控",
        relevant_video_ids: currentRows().map((r) => "video:" + r.source_id),
        player_interests: [
          {
            text: "关注",
            evidence_ids: ["video:" + currentRows()[0].source_id],
          },
        ],
        creative_methods: [
          {
            text: "方法",
            evidence_ids: ["video:" + currentRows()[0].source_id],
          },
        ],
        game_facts: [{ text: "事实", evidence_ids: ["web:test"] }],
        unknowns: [],
        blocking_gaps: [],
      }),
    },
    readMedia: async (r) => {
      reads++;
      return {
        id: "video:" + r.source_id,
        source_id: r.source_id,
        kind: "video",
        read_at: "2026-01-01T00:00:00Z",
        analysis: { needs_audio_review: false, blocking_gaps: [] },
        subtitle_review: { status: "reviewed_no_changes" },
      };
    },
    web: async () => [{ id: "web:test", kind: "web", text: "受控资料" }],
  });
  try {
    const first = db.create("learn", { game: "率土之滨" }, "v1");
    await worker.tick();
    assert.equal(db.get(first.id).state, "completed");
    assert.equal(reads, 20);
    round = 1;
    revisions.set(rows[1].source_id, "changed-media");
    const second = db.create("learn", { game: "率土之滨" }, "v2");
    await worker.tick();
    const result = db.get(second.id);
    assert.equal(result.state, "completed");
    assert.equal(reads, 22);
    assert.equal(result.result.progress.reused_count, 18);
    assert.equal(result.result.progress.newly_read_count, 2);
    const reused = result.result.evidence.find((e) => e.reused_from);
    assert.equal(reused.read_at, "2026-01-01T00:00:00Z");
    assert.equal(reused.reused_from.task_id, first.id);
  } finally {
    worker.stop();
    db.close();
  }
});

test("独立浏览器模式同样要求20独立内容，不能保留旧3条门槛", async () => {
  const db = new Tasks(await mkdtemp(join(tmpdir(), "crawl-cdp-min20-"))),
    rows = Array.from({ length: 19 }, (_, i) => ({
      kind: "video",
      source_id: String(12345678900 + i),
      author: "a" + i,
    }));
  const worker = startWorker(db, {
    interval: 999999,
    browserMode: "cdp",
    model: { identity: async () => ({ name: "fixture" }) },
    search: async () => ({ records: rows, failures: [] }),
    readMedia: async () => assert.fail("19条不能进入正式学习"),
  });
  try {
    const t = db.create("learn", { game: "率土之滨" });
    await worker.tick();
    assert.equal(db.get(t.id).state, "needs_input");
    assert.match(db.get(t.id).error, /不足20条/);
  } finally {
    worker.stop();
    db.close();
  }
});

test('readiness blocks persisted tasks before claim and does not interrupt work already started',async()=>{
 const db=new Tasks(await mkdtemp(join(tmpdir(),'crawl-worker-ready-')));
 let allowed=false,identityCalls=0,release;
 const task=db.create('learn',{game:'连接门禁测试'});
 const worker=startWorker(db,{interval:999999,canRun:()=>allowed,browserMode:'cdp',model:{identity:async()=>{identityCalls++;await new Promise(r=>release=r);return {name:'fixture'};}},search:async()=>({records:[],failures:[]})});
 try{
  await worker.tick();assert.equal(db.get(task.id).state,'queued');assert.equal(identityCalls,0);
  allowed=true;const running=worker.tick();while(!release)await new Promise(r=>setImmediate(r));assert.equal(db.get(task.id).state,'running');
  allowed=false;await worker.tick();assert.equal(db.get(task.id).state,'running');release();await running;
  assert.equal(db.get(task.id).state,'needs_input');assert.equal(identityCalls,1);
  db.retry(task.id);await worker.tick();assert.equal(db.get(task.id).state,'queued');assert.equal(identityCalls,1);
 }finally{worker.stop();}
});
