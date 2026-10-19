import test from "node:test";
import assert from "node:assert/strict";
import { destination, resolveDestination, sheetURL } from "../app/delivery.mjs";
import { probeTencent, createReadiness } from "../app/readiness.mjs";
const url = "https://docs.qq.com/sheet/DTestSheetFixture";
const file_id = "fixture-file-id";
const info = { file_id, url, type: "sheet" };
function clientWith(handler) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      return handler(name, args);
    },
  };
}

test("URL-only destination verifies an existing exact URL/ID pair through Tencent read-only metadata", async () => {
  const client = clientWith((name) => {
    assert.equal(name, "manage_query_file_info");
    return info;
  });
  const result = await resolveDestination(
    { url: url + "?tab=test-tab" },
    { client, previous: { file_id, url: url + "?tab=other" } },
  );
  assert.deepEqual(result, { file_id, url });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(destination(result), result);
});

test("new link uses official recent URL mapping, never old target ID, then verifies metadata", async () => {
  const client = clientWith((name, args) => {
    if (name === "manage_recent_online_file") {
      assert.equal(args.count, 20);
      return {
        files: [
          {
            file_id: "wrong-file",
            file_url: "https://docs.qq.com/sheet/another",
          },
          { file_id, file_url: url + "?tab=first" },
        ],
      };
    }
    assert.equal(name, "manage_query_file_info");
    assert.equal(args.file_id, file_id);
    return info;
  });
  assert.deepEqual(
    await resolveDestination(
      { url },
      {
        client,
        previous: {
          file_id: "old-file",
          url: "https://docs.qq.com/sheet/old-link",
        },
      },
    ),
    { file_id, url },
  );
  assert.deepEqual(
    client.calls.map((x) => x.name),
    ["manage_recent_online_file", "manage_query_file_info"],
  );
  assert(!JSON.stringify(client.calls).includes("old-file"));
});

test("explicit legacy ID must match provider URL and an unrelated previous ID is never reused", async () => {
  const client = clientWith(() => ({
    ...info,
    url: "https://docs.qq.com/sheet/different",
  }));
  await assert.rejects(
    resolveDestination({ file_id, url }, { client }),
    /不一致/,
  );
  const missing = clientWith((name) => {
    assert.equal(name, "manage_recent_online_file");
    return { files: [] };
  });
  await assert.rejects(
    resolveDestination(
      { url },
      {
        client: missing,
        previous: { file_id, url: "https://docs.qq.com/sheet/different" },
      },
    ),
    /先打开目标文档/,
  );
  assert.equal(missing.calls.length, 1);
});

test("opaque share IDs are never decoded and lookup is bounded to ten pages of twenty", async () => {
  const client = clientWith((name, args) => {
    assert.equal(name, "manage_recent_online_file");
    assert.equal(args.num, client.calls.length);
    return {
      files: Array.from({ length: 20 }, (_, i) => ({
        file_id: "other-" + args.num + "-" + i,
        file_url: "https://docs.qq.com/sheet/other-" + args.num + "-" + i,
      })),
    };
  });
  await assert.rejects(resolveDestination({ url }, { client }), /最近访问记录/);
  assert.equal(client.calls.length, 10);
});

test("reject malformed/foreign/credentialed URLs and non-sheet/mismatched provider identity", async () => {
  for (const value of [
    "http://docs.qq.com/sheet/abcd",
    "https://docs.qq.com.evil/sheet/abcd",
    "https://u:p@docs.qq.com/sheet/abcd",
    "https://docs.qq.com:444/sheet/abcd",
    "https://docs.qq.com/doc/abcd",
    "https://docs.qq.com/sheet/",
    "https://docs.qq.com/sheet/abcd/extra",
  ])
    assert.throws(() => sheetURL(value));
  assert.equal(sheetURL(url + "?tab=tab1#anchor"), url);
  const client = clientWith(() => ({ ...info, type: "doc" }));
  await assert.rejects(
    resolveDestination({ url, file_id }, { client }),
    /不是有效在线表格/,
  );
  const changed = clientWith(() => ({ ...info, file_id: "different" }));
  await assert.rejects(
    resolveDestination({ url, file_id }, { client: changed }),
    /不是有效在线表格/,
  );
  const ambiguous = clientWith(() => ({
    files: [
      { file_id, file_url: url },
      { file_id: "different", file_url: url },
    ],
  }));
  await assert.rejects(
    resolveDestination({ url }, { client: ambiguous }),
    /多个不一致/,
  );
});

test("authorization failures preserve their class; readiness distinguishes credentials from missing target", async () => {
  const client = clientWith(() => {
    throw Object.assign(Error("safe-message"), { code: "AUTH_REQUIRED" });
  });
  await assert.rejects(resolveDestination({ url, file_id }, { client }), {
    code: "AUTH_REQUIRED",
  });
  const missing = await probeTencent({
    client: { init: async () => {} },
    target: null,
  });
  assert.equal(missing.reauthorization_required, false);
  const noToken = {
    init: async () => {
      throw Object.assign(Error("secret"), { code: "CREDENTIAL_REQUIRED" });
    },
  };
  const needsAuth = await probeTencent({
    client: noToken,
    target: { file_id, url },
  });
  assert.equal(needsAuth.reauthorization_required, true);
  assert(!needsAuth.message.includes("secret"));
  const gate = createReadiness({
    collector: { probe: async () => ({ state: "ready" }) },
    client: noToken,
    target: { file_id, url },
  });
  gate.check();
  const state = await gate.settled();
  assert.equal(
    state.sites.find((x) => x.id === "tencent").reauthorization_required,
    true,
  );
});
