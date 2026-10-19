import test from "node:test";
import assert from "node:assert/strict";
import {
  createRedfoxGameSource,
  validateRedfoxGameResult,
  redfoxGameScope,
  REDFOX_GAME_ENDPOINT,
} from "../app/redfox-game-source.mjs";

const at = "2026-10-19T08:07:41.000Z";
const payload = {
  provider: "redfox",
  purpose: "game-learning",
  keyword: "率土之滨",
  hours: 168,
  sort: "likes",
  limit: 30,
};
function row(i, changes = {}) {
  const id = String(7696356432198913321n + BigInt(i));
  return {
    videoId: id,
    videoType: "0",
    content: `率土之滨 第${i}条`,
    authorName: "作者",
    opusUrl: `https://www.iesdouyin.com/share/video/${id}`,
    coverUrl: "https://p3.douyinpic.com/test.jpg",
    publishTime: "2026-10-18 12:30:00",
    duration: 123000,
    likeCount: i,
    commentCount: 0,
    shareCount: 0,
    collectCount: 0,
    ...changes,
  };
}
function page(list, total = list.length, pageNum = 1) {
  return {
    code: 2000,
    data: { list, total, pageNum, pageSize: 50 },
    msg: "ok",
  };
}
function reader(responses, extras = {}) {
  const calls = [];
  const source = createRedfoxGameSource({
    apiKey: "test-secret-not-a-real-key",
    clock: () => at,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const value = responses[calls.length - 1];
      if (value instanceof Error) throw value;
      return {
        status: 200,
        redirected: false,
        text: async () => JSON.stringify(value),
      };
    },
    ...extras,
  });
  return { source, calls };
}
test("local connection check consumes no request and does not claim live verification", async () => {
  const { source, calls } = reader([]);
  assert.deepEqual(await source.checkConnection(), {
    status: "configured",
    configured: true,
    live_verified: false,
    source: "redfox",
  });
  assert.equal(calls.length, 0);
  const empty = createRedfoxGameSource();
  assert.equal((await empty.checkConnection()).status, "unconfigured");
  await assert.rejects(empty.collect(payload), {
    code: "SOURCE_AUTH_REQUIRED",
  });
});
test("T+1 uses completed Shanghai calendar dates across UTC day and year boundary", () => {
  const seven = redfoxGameScope(payload, at);
  assert.equal(seven.start_date, "2026-10-12");
  assert.equal(seven.end_date, "2026-10-18");
  const one = redfoxGameScope(
    { ...payload, hours: 24 },
    "2026-01-01T16:00:00Z",
  );
  assert.equal(one.start_date, "2026-01-01");
  assert.equal(one.end_date, "2026-01-01");
  const three = redfoxGameScope(
    { ...payload, hours: 72 },
    "2026-01-01T01:00:00Z",
  );
  assert.equal(three.start_date, "2025-12-29");
  assert.equal(three.end_date, "2025-12-31");
  assert.throws(() => redfoxGameScope({ ...payload, hours: 1 }, at), {
    code: "SOURCE_UNSUPPORTED",
  });
  assert.throws(
    () => redfoxGameScope({ ...payload, provider: "browser" }, at),
    { code: "SOURCE_UNSUPPORTED" },
  );
});
test("50 mixed works give 30 sample-sorted videos with raw receipts, no full corpus claim", async () => {
  const rows = Array.from({ length: 50 }, (_, i) =>
    row(i, i < 17 ? { videoType: "68", duration: 0 } : {}),
  );
  const { source, calls } = reader([page(rows, 595)]);
  const result = await source.collect(payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REDFOX_GAME_ENDPOINT);
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    keyword: "率土之滨",
    exactMatch: true,
    startDate: "2026-10-12",
    endDate: "2026-10-18",
    pageNum: 1,
    pageSize: 50,
  });
  assert.equal(result.records.length, 30);
  assert.equal(result.records[0].like_count, 49);
  assert.equal(result.records[0].duration_ms, 123000);
  assert.equal(result.records[0].source_updated_at, null);
  assert.equal(
    result.excluded_records.filter((r) => r.reason === "non_video").length,
    17,
  );
  assert.equal(
    result.excluded_records.filter((r) => r.reason === "sample_limit").length,
    3,
  );
  assert.equal(result.api_pagination.status, "partial");
  assert.equal(result.api_pagination.reported_total, 595);
  assert.ok(!JSON.stringify(result).includes("test-secret-not-a-real-key"));
  assert.deepEqual(
    validateRedfoxGameResult(result, payload, { createdAt: at, now: at }),
    result,
  );
});
test("paginates only until sample budget, excludes duplicate and wrong date/game/type transparently", async () => {
  const first = Array.from({ length: 50 }, (_, i) =>
    row(i, { videoType: "68", duration: 0 }),
  );
  const second = [
    row(0),
    row(51, { content: "别的游戏" }),
    row(52, { publishTime: "2026-10-19 01:00:00" }),
    row(53, { videoType: "63" }),
    row(54, { likeCount: null }),
  ];
  const { source, calls } = reader([page(first, 55), page(second, 55, 2)]);
  const result = await source.collect(payload);
  assert.equal(calls.length, 2);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].like_count, null);
  assert.equal(result.api_pagination.stop_reason, "source_gap");
  for (const reason of [
    "duplicate",
    "keyword_mismatch",
    "outside_date_range",
    "non_video",
  ])
    assert.ok(result.excluded_records.some((r) => r.reason === reason));
});
test("three page ceiling and explicit request budget prevent unbounded charges", async () => {
  const responses = Array.from({ length: 3 }, (_, p) =>
    page(
      Array.from({ length: 50 }, (_, i) =>
        row(p * 50 + i, { videoType: "68", duration: 0 }),
      ),
      999,
      p + 1,
    ),
  );
  const { source, calls } = reader(responses);
  const result = await source.collect(payload);
  assert.equal(calls.length, 3);
  assert.equal(result.api_pagination.stop_reason, "request_budget");
  assert.equal(result.api_pagination.status, "partial");
  const limited = reader(responses, { maxRequests: 1 });
  assert.equal(
    (await limited.source.collect(payload)).api_pagination.request_count,
    1,
  );
  assert.throws(() => createRedfoxGameSource({ maxPages: 4 }));
});
test("repeated page and changing totals stop with partial evidence", async () => {
  const rows = Array.from({ length: 50 }, (_, i) =>
    row(i, { videoType: "68", duration: 0 }),
  );
  for (const [second, reason] of [
    [page(rows, 500, 2), "repeated_page"],
    [page(rows, 501, 2), "total_changed"],
  ]) {
    const { source, calls } = reader([page(rows, 500), second]);
    const result = await source.collect(payload);
    assert.equal(calls.length, 2);
    assert.equal(result.api_pagination.stop_reason, reason);
    assert.equal(result.api_pagination.status, "partial");
  }
});
test("empty success requires zero total; short nonempty pages never claim complete", async () => {
  const empty = await reader([page([], 0)]).source.collect(payload);
  assert.equal(empty.api_pagination.status, "complete");
  assert.equal(empty.records.length, 0);
  await assert.rejects(reader([page([], 500)]).source.collect(payload));
  const short = await reader([page([row(1)], 500)]).source.collect(payload);
  assert.equal(short.api_pagination.stop_reason, "short_page");
  assert.equal(short.api_pagination.status, "partial");
  const exhausted = await reader([page([row(1)], 1)]).source.collect(payload);
  assert.equal(exhausted.api_pagination.status, "complete");
});
test("unsafe IDs, dates, links, metrics and metadata fail without converting to no results", async () => {
  for (const changes of [
    { videoId: 7696356432198913321 },
    { publishTime: "2026-02-30 12:30:00" },
    { likeCount: -1 },
    { duration: 0 },
    { opusUrl: "https://evil.example/video/123" },
    { videoType: "unknown" },
  ]) {
    await assert.rejects(
      reader([page([row(1, changes)])]).source.collect(payload),
    );
  }
  for (const response of [
    { code: 403, data: { list: [] } },
    { ...page([row(1)]), data: { ...page([row(1)]).data, pageNum: 2 } },
    { ...page([row(1)]), data: { ...page([row(1)]).data, pageSize: 20 } },
  ])
    await assert.rejects(reader([response]).source.collect(payload));
});
test("receipt replay rejects changed records, selection scope, freshness, private fields and complete claims", async () => {
  const original = await reader([page([row(1)], 500)]).source.collect(payload);
  for (const edit of [
    (x) => x.records[0].like_count++,
    (x) => (x.observed_scope.keyword = "另一个游戏"),
    (x) => (x.api_pagination.status = "complete"),
    (x) => (x.api_pages[0].response.privateToken = "secret"),
    (x) => (x.api_pages[0].response.data.list[0].authorSecUid = "unnecessary"),
    (x) => (x.api_pages[0].request.startDate = "2020-01-01"),
    (x) => (x.api_pages[0].request.REDFOX_API_KEY = "secret"),
    (x) => (x.api_pages[0].received_at = "2026-10-18T00:00:00Z"),
  ]) {
    const changed = structuredClone(original);
    edit(changed);
    assert.throws(() =>
      validateRedfoxGameResult(changed, payload, { createdAt: at, now: at }),
    );
  }
  assert.throws(() =>
    validateRedfoxGameResult(original, payload, {
      createdAt: "2026-10-19T09:00:00Z",
      now: at,
    }),
  );
  assert.throws(() =>
    validateRedfoxGameResult(original, payload, {
      now: "2026-10-18T00:00:00Z",
    }),
  );
});
test("network failures, secrets echoed by upstream, redirects, timeouts and cancellation do not retry", async () => {
  const failure = reader([new Error("test-secret-not-a-real-key from server")]);
  await assert.rejects(
    failure.source.collect(payload),
    (e) => !e.message.includes("test-secret"),
  );
  assert.equal(failure.calls.length, 1);
  const echo = reader([
    page([row(1, { content: "率土之滨 test-secret-not-a-real-key" })]),
  ]);
  await assert.rejects(
    echo.source.collect(payload),
    (e) => !e.message.includes("test-secret"),
  );
  const redirect = reader([], {
    fetch: async () => ({ status: 200, redirected: true }),
  });
  await assert.rejects(redirect.source.collect(payload));
  const timeout = reader([], {
    fetch: () => new Promise(() => {}),
    timeoutMs: 5,
  });
  await assert.rejects(timeout.source.collect(payload), {
    code: "SOURCE_TIMEOUT",
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = reader([]);
  await assert.rejects(
    cancelled.source.collect(payload, { signal: controller.signal }),
    { code: "SOURCE_CANCELLED" },
  );
  assert.equal(cancelled.calls.length, 0);
  const midflight = new AbortController();
  const hung = reader([], {
    fetch: () => new Promise(() => {}),
    timeoutMs: 120000,
  });
  const pending = hung.source.collect(payload, { signal: midflight.signal });
  setTimeout(() => midflight.abort(), 5);
  await assert.rejects(pending, { code: "SOURCE_CANCELLED" });
});
test('reject URL arrays instead of silently coercing them into source links',async()=>{
  for(const key of ['opusUrl','coverUrl']) {
    const value=row(1);value[key]=[value[key]];
    const {source}=reader([page([value])]);
    await assert.rejects(source.collect(payload));
  }
});
test('request date survives async runtime boundary; mismatched scope makes zero paid calls',async()=>{
  const {source,calls}=reader([page([row(1)])]);
  await assert.rejects(source.collect(payload,{requestCreatedAt:'2026-10-18T15:59:59.999Z'}),{code:'SOURCE_SCOPE_MISMATCH'});
  assert.equal(calls.length,0);
});
