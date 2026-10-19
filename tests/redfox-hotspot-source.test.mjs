import test from "node:test";
import assert from "node:assert/strict";
import {
  createRedfoxHotspotSource,
  validateRedfoxHotspotResult,
  redfoxHotspotScope,
  REDFOX_HOTSPOT_ENDPOINT,
  REDFOX_HOTSPOT_CATEGORIES,
} from "../app/redfox-hotspot-source.mjs";
const at = "2026-10-19T08:07:41Z";
const payload = {
  provider: "redfox",
  purpose: "hotspots",
  board: "redfox_daily_hot",
  hours: 24,
  category: "游戏",
  keyword: "",
};
function row(i = 0, changes = {}) {
  const id = String(7697943133530672410n + BigInt(i));
  return {
    workId: id,
    workUrl: `https://www.iesdouyin.com/share/video/${id}`,
    workType: "0",
    content: "遐思技能介绍 #无畏契约",
    title: "遐思技能介绍",
    accountName: "无畏契约",
    category: "游戏",
    coverUrl: "https://p5.douyinpic.com/cover.webp",
    duration: 42902,
    publishTime: "2026-10-18 17:51:00",
    likeCount: 410783,
    commentCount: 8239,
    collectCount: 22045,
    shareCount: 464537,
    ...changes,
  };
}
function reader(data, extras = {}) {
  const calls = [];
  const source = createRedfoxHotspotSource({
    apiKey: "fixture-secret",
    clock: () => at,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        redirected: false,
        text: async () => JSON.stringify({ code: 2000, data, msg: "ok" }),
      };
    },
    ...extras,
  });
  return { source, calls };
}
test("configuration check is local and does not assert live capability", async () => {
  const { source, calls } = reader([]);
  assert.equal((await source.checkConnection()).live_verified, false);
  assert.equal(calls.length, 0);
  assert.equal(
    (await createRedfoxHotspotSource().checkConnection()).configured,
    false,
  );
  await assert.rejects(createRedfoxHotspotSource().collect(payload), {
    code: "SOURCE_AUTH_REQUIRED",
  });
});
test("only explicit supported daily-board scopes; complete Shanghai days end yesterday", () => {
  assert.equal(REDFOX_HOTSPOT_CATEGORIES.length, 28);
  const scope = redfoxHotspotScope({ ...payload, hours: 72 }, at);
  assert.equal(scope.start_date, "2026-10-16");
  assert.equal(scope.end_date, "2026-10-18");
  assert.equal(scope.source_updated_at, null);
  const week = redfoxHotspotScope(
    { ...payload, hours: 168 },
    "2026-01-01T16:00:00Z",
  );
  assert.equal(week.start_date, "2025-12-26");
  assert.equal(week.end_date, "2026-01-01");
  for (const edit of [
    { provider: "browser" },
    { board: 1001 },
    { category: "605" },
    { hours: 1 },
  ])
    assert.throws(() => redfoxHotspotScope({ ...payload, ...edit }, at), {
      code: "SOURCE_UNSUPPORTED",
    });
});
test("single request preserves source order, exact public receipt, and unknown duration unit", async () => {
  const { source, calls } = reader([row(), row(1, { likeCount: 500000 })]);
  const result = await source.collect(payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REDFOX_HOTSPOT_ENDPOINT);
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    type: "游戏",
    startTime: "2026-10-18",
    endTime: "2026-10-18",
  });
  assert.equal(result.records[0].like_count, 410783);
  assert.equal(result.records[0].source_rank, null);
  assert.equal(result.records[0].duration_raw, 42902);
  assert.equal(result.records[0].duration_unit, "unknown");
  assert.equal(result.records[0].duration_ms, undefined);
  assert.equal(result.records[0].title_raw, "遐思技能介绍");
  assert.equal(result.api_pagination.status, "single_response_complete");
  assert.equal(result.api_pagination.global_completeness, "unknown");
  assert.equal(result.api_pagination.reported_total, null);
  assert.equal(result.source_updated_at, null);
  assert.deepEqual(
    validateRedfoxHotspotResult(result, payload, { createdAt: at, now: at }),
    result,
  );
});
test("all category is omitted upstream; keyword is transparently local and never sent to API", async () => {
  const { source, calls } = reader([
    row(),
    row(1, {
      content: "美食教程",
      title: "吃饭",
      accountName: "料理",
      category: "美食",
    }),
  ]);
  const result = await source.collect({
    ...payload,
    category: "all",
    keyword: "无畏契约",
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    startTime: "2026-10-18",
    endTime: "2026-10-18",
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.excluded_records[0].reason, "local_keyword_mismatch");
  assert.equal(
    result.observed_scope.keyword_filter,
    "local_content_or_title_or_author",
  );
});
test("every supported category and date window sends its own scope and rejects another scope's receipt", async () => {
  for (const category of ["all", ...REDFOX_HOTSPOT_CATEGORIES]) {
    for (const hours of [24, 72, 168]) {
      const input = { ...payload, category, hours };
      const scope = redfoxHotspotScope(input, at);
      const { source, calls } = reader([
        row(0, { category: category === "all" ? "游戏" : category }),
        row(1, { publishTime: "2026-10-10 12:00:00", category }),
      ]);
      const result = await source.collect(input);
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(calls[0].init.body), {
        ...(category === "all" ? {} : { type: category }),
        startTime: scope.start_date,
        endTime: scope.end_date,
      });
      assert.equal(result.records.length, 1);
      assert.equal(result.excluded_records[0].reason, "outside_date_range");
      assert.deepEqual(validateRedfoxHotspotResult(result, input, { createdAt: at, now: at }), result);
      for (const other of [
        { ...input, hours: hours === 24 ? 72 : 24 },
        { ...input, category: category === "游戏" ? "美食" : "游戏" },
      ]) assert.throws(() => validateRedfoxHotspotResult(result, other, { createdAt: at, now: at }));
    }
  }
});
test("wrong category/date, gallery, unknown type and duplicate cannot count as requested videos", async () => {
  const { source } = reader([
    row(),
    row(),
    row(2, { category: "美食" }),
    row(3, { publishTime: "2026-10-17 12:00:00" }),
    row(4, { workType: "68" }),
    row(5, { workType: null }),
  ]);
  const result = await source.collect(payload);
  assert.equal(result.records.length, 1);
  assert.deepEqual(
    result.excluded_records.map((r) => r.reason),
    [
      "duplicate",
      "category_mismatch",
      "outside_date_range",
      "non_video",
      "type_unknown",
    ],
  );
  assert.equal(result.api_pagination.response_count, 6);
  assert.equal(result.api_pagination.collected_unique_count, 5);
});
test("empty array is real response evidence; malformed bodies do not become empty results", async () => {
  const result = await reader([]).source.collect(payload);
  assert.equal(result.records.length, 0);
  assert.equal(result.api_pagination.response_count, 0);
  for (const bad of [null, {}, "error"]) {
    await assert.rejects(reader(bad).source.collect(payload));
  }
  const badCode = reader([], {
    fetch: async () => ({
      status: 200,
      text: async () => JSON.stringify({ code: 403, data: [] }),
    }),
  });
  await assert.rejects(badCode.source.collect(payload));
});
test("replay rejects injected fields, replaced data, wrong scope, forged completeness and expired receipts", async () => {
  const original = await reader([row()]).source.collect(payload);
  for (const edit of [
    (x) => x.records[0].like_count++,
    (x) => (x.observed_scope.category = "美食"),
    (x) => (x.api_pagination.global_completeness = "complete"),
    (x) => (x.api_receipt.request.type = "美食"),
    (x) => (x.api_receipt.response.data[0].accountId = "unneeded"),
    (x) => (x.api_receipt.secret = "never"),
    (x) => (x.api_receipt.received_at = "2026-10-18T01:00:00Z"),
  ]) {
    const copy = structuredClone(original);
    edit(copy);
    assert.throws(() =>
      validateRedfoxHotspotResult(copy, payload, { createdAt: at, now: at }),
    );
  }
  assert.throws(() =>
    validateRedfoxHotspotResult(original, payload, {
      createdAt: "2026-10-19T09:00:00Z",
      now: at,
    }),
  );
  assert.throws(() =>
    validateRedfoxHotspotResult(original, payload, {
      now: "2026-10-18T00:00:00Z",
    }),
  );
});
test("invalid raw identities, URLs, dates and metrics fail closed", async () => {
  for (const changes of [
    { workId: 7697943133530672410 },
    { workUrl: "https://evil.example/video/7697943133530672410" },
    { publishTime: "2026-02-30 12:00:00" },
    { likeCount: -2 },
    { duration: "42902" },
    { coverUrl: "javascript:alert(1)" },
    { coverUrl: ["https://p5.douyinpic.com/cover.webp"] },
    { workType: { privateField: "cannot be carried in public receipts" } },
  ])
    await assert.rejects(reader([row(0, changes)]).source.collect(payload));
});
test("errors and echoed credentials never leak secrets; timeout/abort never retry", async () => {
  const error = reader([], {
    fetch: async () => {
      throw Error("fixture-secret upstream");
    },
  });
  await assert.rejects(
    error.source.collect(payload),
    (e) => !e.message.includes("fixture-secret"),
  );
  const echo = reader([row(0, { content: "fixture-secret" })]);
  await assert.rejects(
    echo.source.collect(payload),
    (e) => !e.message.includes("fixture-secret"),
  );
  assert.equal(echo.calls.length, 1);
  const redirect = reader([], {
    fetch: async () => ({ status: 200, redirected: true }),
  });
  await assert.rejects(redirect.source.collect(payload));
  const timeout = reader([], {
    timeoutMs: 5,
    fetch: () => new Promise(() => {}),
  });
  await assert.rejects(timeout.source.collect(payload), {
    code: "SOURCE_TIMEOUT",
  });
  const controller = new AbortController();
  const hung = reader([], {
    fetch: () => new Promise(() => {}),
    timeoutMs: 120000,
  });
  const pending = hung.source.collect(payload, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { code: "SOURCE_CANCELLED" });
});

test('missing titles do not discard an otherwise valid daily ranking', async () => {
  const {source}=reader([
    row(0,{content:null,title:null}),
    row(1,{content:'',title:''}),
    row(2,{content:undefined,title:undefined}),
    row(3),
  ]);
  const result=await source.collect(payload);
  assert.equal(result.records.length,4);
  assert.deepEqual(result.records.slice(0,3).map(r=>r.title),['','','']);
  assert.equal(result.records[0].content_raw,null);
  assert.equal(result.records[0].title_raw,null);
  assert.equal(result.api_receipt.response.data[0].content,null);
  assert.deepEqual(validateRedfoxHotspotResult(result,payload,{now:at}),result);
  const filtered=await reader([row(0,{content:null,title:null,accountName:null})]).source.collect({...payload,keyword:'游戏'});
  assert.equal(filtered.records.length,0);
  assert.equal(filtered.excluded_records[0].reason,'local_keyword_mismatch');
});
