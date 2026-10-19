import test from "node:test";
import assert from "node:assert/strict";
import { openStore, recordsForLatest } from "../app/store.mjs";
import { resolveCategory } from "../app/categories.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

function snapshot(
  sequence,
  {
    requestedBoard = null,
    boards = [1001],
    hours = 24,
    category = "all",
    keyword = "",
    ids = boards.map((board) => String(sequence * 10000 + board)),
    legacy = false,
    endpoint = "douhot-visible-page",
  } = {},
) {
  const collected_at = new Date(
    Date.UTC(2026, 9, 18, 0, sequence),
  ).toISOString();
  return {
    collected_at,
    keyword,
    collection_key: JSON.stringify([
      "hotspots",
      keyword,
      requestedBoard,
      hours,
      category,
    ]),
    ...(!legacy ? { observed_scope: { boards, hours, category } } : {}),
    records: ids.map((source_id, i) => ({
      source_id,
      collection: "hotspots",
      kind: "video",
      title: source_id,
      author: "author",
      sub_type: boards[i],
      date_window: hours,
      category_filter: resolveCategory(category)?.tags || null,
      search_keyword: keyword,
      source_endpoint: endpoint,
      collected_at,
    })),
  };
}
function latest(...snapshots) {
  const db = openStore(":memory:");
  try {
    for (const value of snapshots) db.import(value);
    return recordsForLatest(db.all());
  } finally {
    db.close();
  }
}
const ids = (rows) => rows.map((r) => r.source_id).sort();

test("全榜后单榜空观察覆盖该榜，保留原快照", () => {
  const db = openStore(":memory:");
  try {
    db.import(snapshot(1, { boards: [1001, 1002], ids: ["a", "b"] }));
    db.import(snapshot(2, { requestedBoard: 1001, ids: [] }));
    assert.deepEqual(ids(recordsForLatest(db.all())), ["b"]);
    assert.equal(db.all().length, 2);
    assert.equal(db.all()[1].data.records.length, 2);
  } finally {
    db.close();
  }
});

test("单榜后全榜部分观察只覆盖实际观察范围，重复全榜请求也不吞掉未读榜", () => {
  assert.deepEqual(
    ids(
      latest(
        snapshot(1, { requestedBoard: 1002, boards: [1002], ids: ["keep"] }),
        snapshot(2, { ids: ["replace"] }),
        snapshot(3, { ids: [] }),
      ),
    ),
    ["keep"],
  );
  assert.deepEqual(
    ids(
      latest(
        snapshot(1, { boards: [1001, 1002], ids: ["old", "unobserved"] }),
        snapshot(2, { ids: ["new"] }),
      ),
    ),
    ["new", "unobserved"],
  );
});

test("空观察精确隔离行业父子、时间和关键词，同榜不同采集渠道互相覆盖", () => {
  const old = [
    snapshot(1, { category: "628", ids: ["parent"] }),
    snapshot(2, { category: "628/62804", ids: ["child"] }),
    snapshot(3, { category: "628", hours: 72, ids: ["72hours"] }),
    snapshot(4, { category: "628", keyword: "做饭", ids: ["keyword"] }),
    snapshot(5, { ids: ["allindustry"] }),
  ];
  assert.deepEqual(
    ids(
      latest(
        ...old,
        snapshot(6, { requestedBoard: 1001, category: "628", ids: [] }),
      ),
    ),
    ["72hours", "allindustry", "child", "keyword"],
  );
  assert.deepEqual(
    ids(
      latest(
        snapshot(1, { endpoint: "legacy-cdp", ids: ["old"] }),
        snapshot(2, { requestedBoard: 1001, ids: ["new"] }),
      ),
    ),
    ["new"],
  );
});

test("无观察范围的旧全榜快照只能覆盖实际返回行，空旧快照不假定观察成功", () => {
  assert.deepEqual(
    ids(
      latest(
        snapshot(1, {
          boards: [1001, 1002],
          ids: ["old", "keep"],
          legacy: true,
        }),
        snapshot(2, { ids: ["new"], legacy: true }),
        snapshot(3, {
          requestedBoard: 1002,
          boards: [1002],
          ids: [],
          legacy: true,
        }),
      ),
    ),
    ["keep", "new"],
  );
});

test("相同时间和请求键的不同空观察范围都持久保存", () => {
  const db = openStore(":memory:");
  try {
    db.import(snapshot(1, { boards: [1001, 1002], ids: ["a", "b"] }));
    assert.equal(
      db.import(snapshot(2, { boards: [1001], ids: [] })).inserted,
      true,
    );
    assert.equal(
      db.import(snapshot(2, { boards: [1002], ids: [] })).inserted,
      true,
    );
    assert.deepEqual(recordsForLatest(db.all()), []);
  } finally {
    db.close();
  }
});

test("热点 HTTP 行业筛选精确隔离父榜、子榜和不限行业", async () => {
  const folder = await mkdtemp(join(tmpdir(), "crawl-scope-server-"));
  const store = openStore(join(folder, "hotspots.sqlite"));
  for (const [i, category] of ["all", "628", "628/62804"].entries())
    store.import(snapshot(i + 1, { category, ids: [String(12345678901 + i)] }));
  store.close();
  const port = 14322;
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
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(base + "/api/session")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(100);
    }
    assert(ready, stderr);
    for (const [category, sourceId] of [
      ["all", "12345678901"],
      ["628", "12345678902"],
      ["628/62804", "12345678903"],
      ["food-tutorial", "12345678903"],
    ]) {
      const response = await fetch(
        base +
          "/api/hotspots?board=1001&hours=24&category=" +
          encodeURIComponent(category),
      );
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(ids(result.records), [sourceId]);
      assert.equal(result.collection.latest_request, null);
      assert.equal(result.collection.unattributed_source_count, 1);
      assert.equal(result.records[0].cache_state, "unattributed");
    }
    const {token} = await (await fetch(base + "/api/session")).json();
    const submitted = await (await fetch(base + "/api/search", {
      method:"POST",headers:{"content-type":"application/json","x-crawl-token":token},
      body:JSON.stringify({keyword:"",board:1001,hours:24,category:"628"}),
    })).json();
    assert(submitted.request_id);
    const pending = await (await fetch(base + "/api/hotspots?board=1001&hours=24&category=628")).json();
    assert.equal(pending.collection.latest_request.id,submitted.request_id);
    assert.equal(pending.collection.status,"pending");
    assert.equal(pending.collection.current_source_count,0);
    assert.equal(pending.records[0].is_from_latest_request,false);
    const otherScope = await (await fetch(base + "/api/hotspots?board=1001&hours=24&category=all")).json();
    assert.equal(otherScope.collection.latest_request,null);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    await rm(folder, { recursive: true, force: true });
  }
});

test("request provenance distinguishes same-time empty batches and is never invented for legacy snapshots", () => {
  const store = openStore(":memory:");
  try {
    const legacy = snapshot(1);
    store.import(legacy);
    const legacyRow = recordsForLatest(store.all())[0];
    assert.equal(Object.hasOwn(legacyRow, "collection_request_id"), false);
    assert.equal(
      Object.hasOwn(store.all()[0].data, "collection_request_id"),
      false,
    );
    const empty = {
      ...snapshot(2, { ids: [] }),
      collection_request_id: "request-a",
    };
    assert.equal(store.import(empty).inserted, true);
    assert.equal(
      store.import({ ...empty, collection_request_id: "request-b" }).inserted,
      true,
    );
    assert.equal(
      store.import({ ...empty, collection_request_id: "request-b" }).inserted,
      false,
    );
    assert.equal(store.all().length, 3);
    assert.equal(store.all()[0].data.collection_request_id, "request-b");
    assert.equal(
      Object.hasOwn(
        store.all().find((s) => s.data.records.length).data,
        "collection_request_id",
      ),
      false,
    );
  } finally {
    store.close();
  }
});
