import test from "node:test";
import { collectionRecoveryKey } from "../app/collection-recovery.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import vm from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeCurrentRankingPageDOM, observeFinalRankingScopeDOM } from "../app/observed-ranking-page.mjs";
import {
  validateLoginInput,
  confirmOwnAccount,
  classifySourceAccess,
  associatedCategoryLabel,
  observeCategoryCheckboxDOM,
  observeRankingIdentityRowDOM,
  setCategoryCheckbox,
  observeCategorySelectionDOM,
  observeScopeDOM,
  observeCollectionStructureDOM,
  describeRankingResponse,
  visibleNumber,
  videoIdentity,
  parseSearchCard,
  hotspotURL,
  assertObservedScope,
  createAutomaticCollector,
} from "../app/automatic-collector.mjs";

test("identity row diagnostics read only bounded visible title and author nodes", () => {
  const node = (text, visible = true) => ({ tagName: "SPAN", getAttribute: () => "text___public", getClientRects: () => visible ? [{}] : [],
    get innerText() { if (!visible) throw Error("hidden text must not be read"); return text; } });
  const title = node("无标题作品"), author = node("作者".repeat(100));
  const titles = [title, node("private hidden", false), ...Array.from({length:10}, () => node("长".repeat(300)))];
  const cell = { contains: element => element === title || element === author };
  const row = { querySelectorAll: selector => selector === "td" ? [cell] : selector.includes("text___") ? titles : [author] };
  const result = vm.runInNewContext(`(${observeRankingIdentityRowDOM.toString()})(row)`, { row });
  assert.equal(result.titles.length, 5); assert.equal(result.titles[0].text, "无标题作品");
  assert.equal(result.titles[1].text, ""); assert.equal(result.titles[2].text.length, 200);
  assert.equal(result.authors[0].text.length, 100); assert.doesNotMatch(JSON.stringify(result), /private hidden/);
});

function categoryInputFixture({ labelCount = 1, hiddenLabel = false, actionError = null, noEffect = false } = {}) {
  let checked = false, labelClicks = 0, fallbackClicks = 0, disposed = 0;
  const node = (tag, shown = true) => ({ tagName: tag, disabled: false,
    getClientRects: () => shown ? [{}] : [], getBoundingClientRect: () => ({ x: 5, y: 10, width: 30, height: 20 }),
    getAttribute: name => name === "class" ? "arco-checkbox private:value" : null,
    get innerText() { throw Error("must not read label text"); },
  });
  const labels = Array.from({ length: labelCount }, () => node("LABEL", !hiddenLabel));
  const input = Object.assign(node("INPUT"), { value: "60507", labels, closest: () => labels[0] || null });
  Object.defineProperty(input, "checked", { get: () => checked });
  const evaluate = (fn, value = input) => vm.runInNewContext(`(${fn.toString()})(value)`, { value });
  const locator = {
    isChecked: async () => checked,
    evaluate: async fn => evaluate(fn),
    evaluateHandle: async fn => {
      const selected = evaluate(fn);
      return { asElement: () => selected ? { click: async options => {
        assert.deepEqual(options, { timeout: 15000 }); labelClicks++;
        if (actionError) throw Error(actionError);
        if (!noEffect) checked = !checked;
      } } : null, dispose: async () => { disposed++; } };
    },
    setChecked: async (value, options) => { assert.deepEqual(options, { timeout: 15000 }); fallbackClicks++; checked = value; },
  };
  return { locator, input, stats: () => ({ checked, labelClicks, fallbackClicks, disposed }) };
}

test("category checkbox clicks its unique associated label and verifies state without force", async () => {
  const f = categoryInputFixture();
  assert.equal(associatedCategoryLabel(f.input), f.input.labels[0], "labels and closest referring to same node are deduplicated");
  await setCategoryCheckbox(f.locator, true);
  await setCategoryCheckbox(f.locator, true);
  await setCategoryCheckbox(f.locator, false);
  assert.deepEqual(f.stats(), { checked: false, labelClicks: 2, fallbackClicks: 0, disposed: 2 });
});

test("category checkbox uses ordinary setChecked only without a unique usable associated label", async () => {
  for (const options of [{ labelCount: 0 }, { labelCount: 2 }, { hiddenLabel: true }]) {
    const f = categoryInputFixture(options); await setCategoryCheckbox(f.locator, true);
    assert.deepEqual(f.stats(), { checked: true, labelClicks: 0, fallbackClicks: 1, disposed: 1 });
  }
});

test("wrapping label bound to another control is never treated as the input's label", async () => {
  const f = categoryInputFixture();
  const unrelated = f.input.labels[0];
  unrelated.control = { type: "checkbox" };
  f.input.labels = [];
  f.input.closest = () => unrelated;
  assert.equal(associatedCategoryLabel(f.input), null);
  assert.equal(observeCategoryCheckboxDOM(f.input).labels.length, 0);
  await setCategoryCheckbox(f.locator, true);
  assert.deepEqual(f.stats(), { checked: true, labelClicks: 0, fallbackClicks: 1, disposed: 1 });
});

test("failed label actions never fall back or leak trace and preserve bounded structure", async () => {
  for (const [message, reason] of [["private-account intercepts pointer events secret", "interception"], ["Element is not visible private", "hidden"], ["Element is outside of the viewport secret", "outside_viewport"], ["Element is not enabled secret", "disabled"], ["Timeout secret", "timeout"]]) {
    const f = categoryInputFixture({ actionError: message });
    await assert.rejects(setCategoryCheckbox(f.locator, true), error => {
      assert.equal(error.code, "SOURCE_FAILED"); assert.equal(error.checkbox_diagnostic.reason, reason);
      assert.equal(error.checkbox_diagnostic.structure.input.value, "60507");
      assert.equal(error.checkbox_diagnostic.structure.labels[0].tag, "LABEL");
      assert.doesNotMatch(JSON.stringify(error), /secret|private|pointer events/); return true;
    });
    assert.equal(f.stats().fallbackClicks, 0); assert.equal(f.stats().disposed, 1);
  }
  const f = categoryInputFixture({ noEffect: true });
  await assert.rejects(setCategoryCheckbox(f.locator, true), error => error.checkbox_diagnostic.reason === "checked_state_mismatch");
  const many = categoryInputFixture({ labelCount: 30 });
  const diagnostic = observeCategoryCheckboxDOM(many.input);
  assert.equal(diagnostic.labels.length, 8); assert.equal(diagnostic.labels_truncated, true);
});

test("category failure diagnostics retain bounded numeric checkbox scope and public controls only", () => {
  const checkbox = (value, checked, shown = true) => ({ value, checked, indeterminate: false, getClientRects: () => shown ? [{}] : [] });
  const boxes = [checkbox("605", true), checkbox("60506", true), checkbox("60507", false, false), checkbox("private-token", true)];
  const button = (text, shown = true) => ({ innerText: text, getClientRects: () => shown ? [{}] : [] });
  const environment = { URL, location: { href: "https://douhot.douyin.com/square/hotspot?sub_type=1001&date_window=72&first_tag=605&second_tag=60506x60507&token=secret&keyword=private" }, document: { querySelectorAll: (selector) => selector.startsWith("input") ? boxes : [button("确定"), button("取消"), button("应用", false), button("private-account")] } };
  const result = vm.runInNewContext(`(${observeCategorySelectionDOM.toString()})({parent:605,expected:['605','60506','private']})`, environment);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { parent: "605", expected: ["605", "60506"], checkboxes: [{ value: "605", checked: true, indeterminate: false, visible: true }, { value: "60506", checked: true, indeterminate: false, visible: true }, { value: "60507", checked: false, indeterminate: false, visible: false }], url_scope: { sub_type: "1001", date_window: "72", first_tag: "605", second_tag: "60506x60507" }, controls: ["确定", "取消"] });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|token|keyword/);
  boxes.splice(0, boxes.length, ...Array.from({ length: 100 }, (_, i) => checkbox(String(60500 + i), true)));
  assert.equal(vm.runInNewContext(`(${observeCategorySelectionDOM.toString()})({parent:605})`, environment).checkboxes.length, 64);
});

test("category URL confirmation failure preserves checkbox evidence before dismissal and current scope", async () => {
  const folder = await mkdtemp(join(tmpdir(), "category-diagnostic-"));
  let url = "", dismissed = false;
  const boxes = ["605", "60506", "60507", "60504", "60508", "60509"].map(value => ({ value, checked: true, getClientRects: () => dismissed ? [] : [{}] }));
  const environment = { URL, location: { get href() { return url; } }, document: { querySelectorAll: selector => selector.startsWith("input") ? boxes : [] } };
  const clickable = { click: async () => {}, first() { return this; }, last() { return this; }, filter() { return this; }, waitFor: async () => {} };
  const page = { goto: async value => { url = value; return { status: () => 200 }; }, url: () => url, title: async () => "热点宝", close: async () => {}, on() {}, off() {}, getByRole: () => clickable, getByText: () => clickable,
    keyboard: { press: async () => { dismissed = true; } },
    locator: selector => selector === "body" ? { innerText: async () => "榜单", click: async () => {} }
      : selector.includes('value^=') ? { evaluateAll: async fn => fn(boxes) }
      : selector.startsWith('input') ? {
          isChecked: async () => boxes.find(box => box.value === selector.match(/value="(\d+)"/)[1]).checked,
          evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
          setChecked: async checked => { boxes.find(box => box.value === selector.match(/value="(\d+)"/)[1]).checked = checked; },
        }
      : selector.includes('dialog') ? { evaluateAll: async () => [] } : clickable,
    evaluate: async (fn, args) => vm.runInNewContext(`(${fn.toString()})(args)`, { ...environment, args }),
    waitForFunction: async () => { throw Error("page.waitForFunction: Timeout 15000ms exceeded."); },
  };
  const collector = createAutomaticCollector({ profileDir: folder, chromium: { launchPersistentContext: async () => ({ newPage: async () => page, close: async () => {} }) } });
  try {
    await assert.rejects(collector.collect({ purpose: "hotspots", board: 1001, hours: 72, category: "605" }), /Timeout/);
    const diagnostic = collector.status().last_error.diagnostics[0].structure.category_selection;
    assert.equal(diagnostic.stage, "confirm_url_scope");
    assert.ok(!diagnostic.before_dismiss.expected.includes("605"));
    assert.equal(diagnostic.reapplied_selection, true);
    assert.ok(diagnostic.before_dismiss.checkboxes.every(box => box.visible && box.checked));
    assert.ok(diagnostic.current.checkboxes.every(box => !box.visible));
    assert.equal(diagnostic.current.url_scope.first_tag, "605");
    assert.equal(diagnostic.current.url_scope.second_tag, undefined);
  } finally { await collector.close(); await rm(folder, { recursive: true, force: true }); }
});

test("live parent directory replaces static children once and rejects stale response scope", async () => {
  for (const scenario of ["valid", "late-response", "stale-response", "missing-requested-child"]) {
    const folder = await mkdtemp(join(tmpdir(), "live-category-"));
    let url = "", dismissed = false, handler, requestHandler;
    const mutations = [], ids = ["60507", "60504", "60508", "60509"];
    const boxes = ["605", ...ids].map(value => ({ value, checked: true, getClientRects: () => value === "605" || dismissed ? [] : [{}] }));
    const selected = () => boxes.filter(box => ids.includes(box.value) && box.checked).map(box => box.value);
    const environment = { URL, location: { get href() { return url; } }, document: { querySelectorAll: selector => selector.startsWith("input") ? boxes : [] } };
    const clickable = { click: async () => {}, first() { return this; }, last() { return this; }, filter() { return this; }, waitFor: async () => {} };
    const row = { locator: selector => selector === "td" ? { allTextContents: async () => ["1", "实际标题", "1.2万", "300"] } : { first: () => ({ innerText: async () => selector.includes("video-nick") ? "实际作者" : "实际标题" }) } };
    const page = {
      goto: async value => { url = value; return { status: () => 200 }; }, url: () => url,
      title: async () => "热点宝", close: async () => {}, on: (event, fn) => { if (event === "response") handler = fn; if (event === "request") requestHandler = fn; }, off: () => {},
      getByRole: () => clickable, getByText: () => clickable,
      keyboard: { press: async () => {
        dismissed = true;
        const children = scenario === "stale-response" ? ["60506", ...selected()] : selected();
        const sourceRequest = { url: () => "https://douhot.douyin.com/douhot/v1/material/video_billboard", postDataJSON: () => ({ sub_type: 1001, date_window: 72, page: 1, page_size: 30, tags: [{ value: 605, children: children.map(value => ({ value: Number(value) })) }] }) };
        requestHandler?.(sourceRequest);
        const response = { url: () => "https://douhot.douyin.com/douhot/v1/material/video_billboard", status: () => 200,
          request: () => sourceRequest,
          json: async () => { if (scenario === "late-response") await new Promise(resolve => setTimeout(resolve, 5)); return { code: 0, data: { page: { page: 1, page_size: 30, total: 30 }, objs: [{ item_id: "7697398053100633275", item_title: "实际标题", nick_name: "实际作者", score: null, play_cnt: 12345, like_cnt: 300 }] } }; },
        };
        if (scenario === "late-response") setTimeout(() => handler?.(response), 5);
        else handler?.(response);
      } },
      locator: selector => {
        if (selector === "body") return { innerText: async () => "榜单", click: async () => {} };
        if (selector.includes("value^=")) return { evaluateAll: async fn => fn(boxes) };
        if (selector.startsWith("input")) return {
          isChecked: async () => boxes.find(box => box.value === selector.match(/value="(\d+)"/)[1]).checked,
          evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
          setChecked: async checked => {
          const value = selector.match(/value="(\d+)"/)[1];
          const box = boxes.find(item => item.value === value);
          if (box.checked === checked) return;
          box.checked = checked; mutations.push([value, checked]);
          const updated = new URL(url); updated.searchParams.set("second_tag", selected().join("x")); url = updated.href;
        } };
        if (selector.includes("dialog")) return { evaluateAll: async () => [] };
        if (selector === "tbody tr") return { ...clickable, count: async () => 1, nth: () => row };
        if (selector === "thead th") return { allTextContents: async () => ["排名", "标题", "新增播放", "新增点赞"] };
        return clickable;
      },
      evaluate: async (fn, args) => fn === observeScopeDOM ? { url, timeLabel: "近3天", boardLabel: "视频总榜", categoryLabel: "电视剧" }
        : fn === observeCurrentRankingPageDOM ? { page: 1 }
        : fn === observeFinalRankingScopeDOM ? { url, page: 1, next_disabled: true, timeLabel: "近3天", boardLabel: "视频总榜", categoryLabel: "电视剧" }
        : fn === observeCategorySelectionDOM ? vm.runInNewContext(`(${fn.toString()})(args)`, { ...environment, args }) : {},
      waitForFunction: async (fn, args) => { assert.equal(vm.runInNewContext(`(${fn.toString()})(args)`, { ...environment, args }), true); },
    };
    const collector = createAutomaticCollector({ profileDir: folder, scopeResponseTimeoutMs: 100, chromium: { launchPersistentContext: async () => ({ newPage: async () => page, close: async () => {} }) } });
    try {
      const payload = { purpose: "hotspots", board: 1001, hours: 72, category: scenario === "missing-requested-child" ? "605/60506" : "605" };
      if (scenario === "valid" || scenario === "late-response") {
        const result = await collector.collect(payload); assert.equal(result.records.length, 1);
        assert.deepEqual(new URL(url).searchParams.get("second_tag").split("x").sort(), [...ids].sort());
      } else await assert.rejects(collector.collect(payload), scenario === "stale-response" ? /响应超时/ : /已不在来源/);
      assert.deepEqual(mutations, scenario === "missing-requested-child" ? [] : [["60507", false], ["60507", true]]);
    } finally { await collector.close(); await rm(folder, { recursive: true, force: true }); }
  }
});

test("ranking response diagnosis allowlists path and public scope/schema only", () => {
  const request = { sub_type: 1001, date_window: 24, page: 1, page_size: 20, token: "private-token", tags: [{ value: 608, children: [{ value: 60801, secret: "hidden" }] }] };
  const body = { code: 0, data: { objs: [{ item_id: "12345678901", item_title: "private-title", nick_name: "private-name" }], total: 100, cursor: "secret-cursor", page: {page:1,page_size:30,total:1000,cursor:"secret-cursor"} }, message: "private-message" };
  const result = describeRankingResponse("https://douhot.douyin.com/douhot/v1/material/video_billboard?token=hidden", request, body, 200);
  assert.equal(result.count, 1);
  assert.equal(result.paging.total, 100);
  assert.deepEqual(result.page_object,{page:1,page_size:30,total:1000,cursor:{type:"string"}});
  assert.equal(result.first_row_schema.item_id, "string");
  assert.equal(result.request.tags[0].children[0].value, 60801);
  assert.doesNotMatch(JSON.stringify(result), /private-|secret|12345678901|hidden/);
  assert.equal(describeRankingResponse("https://douhot.douyin.com/account/me", request, body, 200), null);
  assert.equal(describeRankingResponse("https://evil.test/douhot/v1/material/video_billboard", request, body, 200), null);
});

test("collection diagnostics preserve visible public structure without account or input text", () => {
  const node = (text, attrs = {}, visible = true, parent = null) => ({
    innerText: text, textContent: text, tagName: "SPAN", children: [],
    parentElement: parent,
    getAttribute: (key) => attrs[key] ?? null,
    getClientRects: () => visible ? [{}] : [],
    querySelectorAll: () => [],
  });
  const account = node("private-account-name"),
    input = node("private-token-input", { value: "secret" }),
    parent = node("private-author-name", { class: "search-result-card", "data-e2e": "search-result" }),
    board = node("视频总榜", { class: "selected-board", "aria-selected": "true" }),
    duration = node("00:15", { class: "duration" }, true, parent),
    hidden = node("近7天", {}, false),
    link = node("private-title", { href: "https://www.douyin.com/video/12345678901?secret=value" });
  const environment = {
    location: { hostname: "www.douyin.com", pathname: "/search/private-keyword" },
    document: { querySelectorAll(selector) {
      if (selector === "body *") return [account, input, parent, board, duration, hidden];
      if (selector === "a[href]") return [link];
      return [];
    } },
  };
  const result = vm.runInNewContext(`(${observeCollectionStructureDOM.toString()})()`, environment);
  assert.equal(result.path, "/search/:keyword");
  assert.equal(result.visible_video_links, 1);
  assert.equal(result.controls.length, 1);
  assert.equal(result.controls[0].label, "视频总榜");
  assert.equal(result.duration_ancestors[0][1].class, "search-result-card");
  assert.doesNotMatch(JSON.stringify(result), /private-|secret|近7天/);
});

test("visible metrics accept compact site values without inventing absent metrics", () => {
  assert.equal(visibleNumber("8.3万"), 83000);
  assert.equal(visibleNumber("1,234"), 1234);
  assert.equal(visibleNumber("点赞"), null);
  assert.equal(visibleNumber(""), null);
  assert.equal(visibleNumber("9.8%"), null);
});
test("search parses actual video cards and never turns observed order into rank", () => {
  const card = {
    url: "https://www.douyin.com/video/7697513310953999635",
    text: "合集\n01:15\n323\n新版本扛伤队推荐 #星际猎人\n@虚零始\n1天前",
  };
  const row = parseSearchCard(
    card,
    "https://www.douyin.com/search/星际猎人?type=video",
    "2026-10-18T00:00:00Z",
  );
  assert.equal(row.title, "新版本扛伤队推荐 #星际猎人");
  assert.equal(row.author, "虚零始");
  assert.equal(row.published_text, "1天前");
  assert.equal(row.publication_precision, "relative");
  assert.equal(row.published_date, null);
  assert.equal(row.like_count, 323);
  assert.equal(row.source_rank, null);
  assert.equal(row.score, null);
  assert.equal(
    parseSearchCard(
      { ...card, url: "https://evil.example/video/7697513310953999635" },
      "",
      "",
    ),
    null,
  );
  assert.equal(
    parseSearchCard({ ...card, text: "不具备身份和指标的泛泛页面" }, "", ""),
    null,
  );
  assert.equal(
    videoIdentity("https://www.douyin.com/note/7697513310953999635"),
    null,
  );
});
test("hotspot parent URLs never seed static children while explicit child URLs stay exact", () => {
  const u = new URL(hotspotURL({ board: 1001, hours: 168, category: "605" }));
  assert.equal(u.searchParams.get("first_tag"), "605");
  assert.equal(u.searchParams.has("second_tag"), false);
  assert.equal(
    new URL(
      hotspotURL({ board: 1002, hours: 72, category: "628/62804" }),
    ).searchParams.get("second_tag"),
    "62804",
  );
  const all = new URL(hotspotURL({ board: 1001, hours: 24, category: "all" }));
  assert.equal(all.searchParams.has("first_tag"), false);
  assert.equal(all.searchParams.has("second_tag"), false);
});
test("scope acceptance requires actual visible controls and URL agreement", () => {
  const expected = { board: 1001, hours: 168, category: "605" },
    actual = {
      url: hotspotURL(expected) + "&second_tag=60507x60504x60508x60509",
      expectedChildIds: ["60507", "60504", "60508", "60509"],
      timeLabel: "近7天",
      boardLabel: "视频总榜",
      categoryLabel: "电视剧",
    };
  assert.equal(assertObservedScope(expected, actual), true);
  for (const altered of [
    { timeLabel: "近1天" },
    { boardLabel: "低粉爆款" },
    { categoryLabel: "美食" },
    { url: actual.url.replace("date_window=168", "date_window=24") },
    { url: actual.url.replace("60507x60504x60508x60509", "60507") },
    { url: actual.url + "x60506" },
    { expectedChildIds: undefined },
    { expectedChildIds: [] },
  ])
    assert.throws(
      () => assertObservedScope(expected, { ...actual, ...altered }),
      { code: "SOURCE_FAILED" },
    );
});
test("collector launch is lazy and default explicit login opens native browser", async () => {
  const folder = await mkdtemp(join(tmpdir(), "auto-collector-"));
  const launches = [];
  let closed = 0;
  const page = {
    goto: async () => ({ status: () => 200 }),
    bringToFront: async () => {},
  };
  const chromium = {
    launchPersistentContext: async (profile, options) => {
      launches.push({ profile, options });
      return {
        close: async () => {
          closed++;
        },
        pages: () => [page],
      };
    },
  };
  const collector = createAutomaticCollector({ profileDir: folder, chromium });
  assert.equal(launches.length, 0);
  await assert.rejects(collector.login("https://evil.example"), {
    code: "SOURCE_FAILED",
  });
  assert.equal(launches.length, 0);
  await collector.login("douyin");
  assert.equal(launches[0].profile, folder);
  assert.equal(launches[0].options.headless, false);
  assert.equal(launches[0].options.args, undefined);
  await assert.rejects(
    collector.collect({ purpose: "game-research", keyword: "率土之滨" }),
    { code: "LOGIN_REQUIRED" },
  );
  assert.equal((await collector.probe("douyin")).state, "login_required");
  await collector.resume();
  assert.equal(closed, 1);
  assert.equal(collector.status().mode, "closed");
  await rm(folder, { recursive: true, force: true });
});
test("background refusal is an explicit verification state, never an empty success or headed retry", async () => {
  const folder = await mkdtemp(join(tmpdir(), "auto-collector-"));
  const options = [];
  const page = {
    goto: async () => ({ status: () => 403 }),
    close: async () => {},
  };
  const chromium = {
    launchPersistentContext: async (_profile, o) => {
      options.push(o);
      return { close: async () => {}, newPage: async () => page };
    },
  };
  const collector = createAutomaticCollector({ profileDir: folder, chromium });
  await assert.rejects(
    collector.collect({ purpose: "game-research", keyword: "星际猎人" }),
    { code: "VERIFICATION_REQUIRED" },
  );
  assert.equal(options.length, 1);
  assert.equal(options[0].headless, true);
  assert.equal(
    (await collector.probe("douyin")).state,
    "verification_required",
  );
  await collector.close();
  await rm(folder, { recursive: true, force: true });
});
test("visible iframe challenge blocks collection without exposing iframe query or treating shell as empty", async () => {
  const folder = await mkdtemp(join(tmpdir(), "auto-collector-"));
  let shown = true;
  let parentLogin = false;
  let frameReads = 0;
  const main = {};
  const frame = {
    frameElement: async () => ({ isVisible: async () => shown, dispose: async () => {} }),
    url: () => "https://rmc.bytedance.com/verifycenter/captcha/v2?token=private-token",
    evaluate: async () => { frameReads++; return { title: "验证码", ready_state: "complete", body_text_length: 67, public_markers: [] }; },
  };
  const locator = {
    innerText: async () => parentLogin ? "登录后继续" : "来源壳",
    evaluateAll: async () => [],
    first() { return this; },
    waitFor: async () => { throw Error("no results visible"); },
  };
  const page = {
    goto: async () => ({ status: () => 200 }), close: async () => {},
    title: async () => "抖音", url: () => "https://www.douyin.com/search/game",
    locator: () => locator, frames: () => [main, frame], mainFrame: () => main,
    evaluate: async () => ({ visible_elements: 1 }),
  };
  const collector = createAutomaticCollector({ profileDir: folder, chromium: {
    launchPersistentContext: async () => ({ close: async () => {}, newPage: async () => page }),
  } });
  try {
    await assert.rejects(collector.collect({ purpose: "game-research", keyword: "game" }), { code: "VERIFICATION_REQUIRED" });
    assert.equal(collector.status().last_error.diagnostics.embedded_frames[0].path, "/verifycenter/captcha/v2");
    assert.doesNotMatch(JSON.stringify(collector.status()), /private-token|\?token/);
    parentLogin = true;
    await assert.rejects(collector.collect({ purpose: "game-research", keyword: "game" }), { code: "VERIFICATION_REQUIRED" }, "confirmed iframe challenge must take precedence over parent login prompt");
    const visibleReads = frameReads;
    assert.ok(visibleReads > 0);
    shown = false;
    await assert.rejects(collector.collect({ purpose: "game-research", keyword: "game" }), { code: "LOGIN_REQUIRED" });
    parentLogin = false;
    await assert.rejects(collector.collect({ purpose: "game-research", keyword: "game" }), { code: "SOURCE_FAILED" });
    assert.equal(frameReads, visibleReads, "hidden challenge frames must not be read");
  } finally {
    await collector.close();
    await rm(folder, { recursive: true, force: true });
  }
});
test("abort before any work does not launch a browser", async () => {
  let calls = 0;
  const collector = createAutomaticCollector({
    chromium: {
      launchPersistentContext: async () => {
        calls++;
      },
    },
  });
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await assert.rejects(
    collector.collect({ purpose: "hotspots" }, { signal: abort.signal }),
    /cancelled/,
  );
  assert.equal(calls, 0);
});

test("known visible challenge after five ordinary frames is never truncated, with bounded unknown-frame reads", async () => {
  const folder = await mkdtemp(join(tmpdir(), "frame-budget-"));
  const main = {}; let challengeShown = true, challengeReads = 0, unknownReads = 0;
  const ordinary = () => ({
    frameElement: async () => ({ isVisible: async () => true, dispose: async () => {} }),
    url: () => "https://example.com/helper?private=secret",
    evaluate: async () => { unknownReads++; return { title: "", public_markers: [] }; },
  });
  const challenge = {
    frameElement: async () => ({ isVisible: async () => challengeShown, dispose: async () => {} }),
    url: () => "https://rmc.bytedance.com/verifycenter/captcha/v2?private=secret",
    evaluate: async (fn) => {
      challengeReads++;
      return vm.runInNewContext(`(${fn.toString()})()`, { document: {
        title: "验证码", readyState: "complete",
        get body() { throw Error("priority detection must not scan frame body"); },
      } });
    },
  };
  const frames = [main, ...Array.from({ length: 5 }, ordinary), challenge, ...Array.from({ length: 20 }, ordinary)];
  const locator = { innerText: async () => "来源壳", evaluateAll: async () => [], first() { return this; }, waitFor: async () => { throw Error("no results"); } };
  const page = { goto: async () => ({ status: () => 200 }), close: async () => {}, title: async () => "抖音", url: () => "https://www.douyin.com/search/game", locator: () => locator, frames: () => frames, mainFrame: () => main, evaluate: async () => ({}) };
  const collector = createAutomaticCollector({ profileDir: folder, chromium: { launchPersistentContext: async () => ({ close: async () => {}, newPage: async () => page }) } });
  try {
    await assert.rejects(collector.collect({ purpose: "game-research", keyword: "game" }), { code: "VERIFICATION_REQUIRED" });
    assert.ok(challengeReads > 0);
    assert.equal(unknownReads, 0, "known challenge takes priority without scanning unrelated frame bodies");
    const evidence = collector.status().last_error.diagnostics.embedded_frames;
    assert.ok(evidence.length <= 5);
    assert.ok(evidence.some((frame) => frame.access === "VERIFICATION_REQUIRED"));
    assert.doesNotMatch(JSON.stringify(evidence), /secret|\?private/);
    challengeShown = false;
    const before = challengeReads;
    await collector.probe("douyin");
    assert.equal(challengeReads, before, "hidden known frame is not read");
    assert.equal(unknownReads, 5, "unknown frame text inspection retains its budget");
  } finally { await collector.close(); await rm(folder, { recursive: true, force: true }); }
});

test("time scope reads visible checked tags, not URL or unchecked/hidden choices", () => {
  const node = (text, visible = true) => ({
    innerText: text,
    getClientRects: () => (visible ? [{}] : []),
  });
  const expected = { board: 1001, hours: 168, category: "all" };
  let checked = [node("近7天"), node("近1天", false), node("视频总榜")];
  const environment = {
    location: { href: hotspotURL(expected) },
    document: {
      querySelectorAll(selector) {
        if (selector === '[role="combobox"]') return [node("请选择垂类")];
        if (selector === ".arco-tag-checked") return checked;
        return [node("视频总榜")];
      },
    },
  };
  const observe = () =>
    vm.runInNewContext(`(${observeScopeDOM.toString()})()`, environment);
  assert.equal(observe().timeLabel, "近7天");
  assert.equal(assertObservedScope(expected, observe()), true);
  checked = [node("近1天"), node("视频总榜")];
  assert.throws(() => assertObservedScope(expected, observe()), {
    code: "SOURCE_FAILED",
  });
  checked = [node("近7天"), node("视频总榜", false), node("低粉爆款")];
  assert.equal(observe().boardLabel, "低粉爆款");
  assert.throws(() => assertObservedScope(expected, observe()), {
    code: "SOURCE_FAILED",
  });
  checked = [node("近7天")];
  assert.equal(observe().boardLabel, "");
  assert.throws(() => assertObservedScope(expected, observe()), {
    code: "SOURCE_FAILED",
  });
  checked = [];
  assert.equal(observe().timeLabel, "");
  assert.throws(() => assertObservedScope(expected, observe()), {
    code: "SOURCE_FAILED",
  });
});

test("SMS login and security verification have distinct actionable states", () => {
  assert.equal(
    classifySourceAccess({ title: "验证码中间页", text: "", url: "https://www.douyin.com/search/game" }),
    "VERIFICATION_REQUIRED",
  );
  assert.equal(
    classifySourceAccess({ title: "短信验证码登录", text: "手机号 获取验证码 登录" }),
    "LOGIN_REQUIRED",
  );
  assert.equal(
    classifySourceAccess({
      url: "https://open.douyin.com/platform/oauth/pc/auth",
      text: "手机号 登录 获取验证码",
    }),
    "LOGIN_REQUIRED",
  );
  assert.equal(
    classifySourceAccess({ text: "短信登录 手机号码 获取短信验证码 登录" }),
    "LOGIN_REQUIRED",
  );
  assert.equal(
    classifySourceAccess({
      text: "欢迎",
      dialogs: ["短信登录 手机号码 验证码"],
    }),
    "LOGIN_REQUIRED",
  );
  assert.equal(
    classifySourceAccess({
      text: "验证码登录 手机号 获取验证码 请拖动滑块完成安全验证",
    }),
    "VERIFICATION_REQUIRED",
  );
  assert.equal(
    classifySourceAccess({ text: "图形验证码 请按顺序点击" }),
    "VERIFICATION_REQUIRED",
  );
  assert.equal(
    classifySourceAccess({ text: "登录发现更多精彩 今日视频总榜" }),
    null,
  );
  assert.equal(
    classifySourceAccess({ text: "今日视频总榜 一个关于验证码的热门视频" }),
    null,
  );
});

test("markerless verification requires the exact observed visible frame, not a generic code title", () => {
  const observed = { title: "验证码", url: "https://rmc.bytedance.com/verifycenter/captcha/v2?opaque=ignored", visibleFrame: true };
  assert.equal(classifySourceAccess(observed), "VERIFICATION_REQUIRED");
  for (const changes of [
    { visibleFrame: false },
    { visibleFrame: undefined },
    { title: "短信验证码登录" },
    { url: "https://rmc.bytedance.com/login" },
    { url: "https://example.com/verifycenter/captcha/v2" },
    { url: "https://rmc.bytedance.com.evil.test/verifycenter/captcha/v2" },
    { url: "http://rmc.bytedance.com/verifycenter/captcha/v2" },
    { url: "invalid" },
  ]) assert.notEqual(classifySourceAccess({ ...observed, ...changes }), "VERIFICATION_REQUIRED");
  assert.equal(classifySourceAccess({ title: "验证码", text: "手机号 获取验证码 登录", url: "https://www.douyin.com/login", visibleFrame: true }), "LOGIN_REQUIRED");
});

function accountPage({
  site,
  avatarVisible = true,
  logoutVisible = true,
  publicRows = false,
  menuOpen = false,
  geometricImages = [],
}) {
  let avatarClicks = 0,
    avatarHovers = 0,
    logoutClicks = 0,
    opened = menuOpen;
  const collection = (visible, type, exists = true) => ({
    count: async () => (exists ? 1 : 0),
    nth: () => ({
      isVisible: async () => visible && (type !== "logout" || opened),
      hover: async () => { avatarHovers++; opened = true; },
      click: async () => {
        if (type === "logout") logoutClicks++;
        else {
          avatarClicks++;
          opened = true;
        }
      },
    }),
    first: () => ({
      waitFor: async () => {
        if (!exists || !visible || (type === "logout" && !opened))
          throw new Error("hidden");
      },
    }),
  });
  const page = {
    locator(selector) {
      if (selector === "body") return {innerText:async()=>"首页"};
      if (selector === '[role="dialog"], [aria-modal="true"]') return {evaluateAll:async()=>[]};
      if (selector === "img") return {
        evaluateAll: async fn => vm.runInNewContext(`(${fn.toString()})(nodes)`, {
          nodes:geometricImages.map(rect=>({getBoundingClientRect:()=>rect,getClientRects:()=>rect.hidden?[]:[rect],style:rect.hidden?{visibility:"hidden",display:"none",opacity:"0"}:{visibility:"visible",display:"block",opacity:"1"}})),
          getComputedStyle:node=>node.style, innerWidth:1440,
        }),
        nth:()=>collection(true,"avatar").nth(),
      };
      if (selector === "tbody tr") return collection(publicRows, "public");
      if (selector === '[data-e2e="user-avatar"]')
        return collection(avatarVisible, "avatar");
      return collection(false, "unused", false);
    },
    getByRole(role, options) {
      assert.equal(role, "img");
      assert.equal(options.name, "avatar");
      assert.equal(options.exact, true);
      return collection(avatarVisible, "avatar");
    },
    getByText(text, options) {
      assert.equal(text, site === "douhot" ? "退出帐号" : "退出登录");
      assert.equal(options.exact, true);
      return collection(logoutVisible, "logout");
    },
  };
  return { page, stats: () => ({ avatarClicks, avatarHovers, logoutClicks }) };
}

test("hidden own-account nodes cannot prove Douyin login even when present in DOM", async () => {
  const fake = accountPage({
    site: "douyin",
    avatarVisible: false,
    logoutVisible: true,
  });
  await assert.rejects(confirmOwnAccount(fake.page, "douyin", 1), {
    code: "LOGIN_REQUIRED",
  });
  assert.deepEqual(fake.stats(), { avatarClicks: 0, avatarHovers: 0, logoutClicks: 0 });
});

test("public hotspot ranking rows cannot prove login without own visible account menu", async () => {
  const fake = accountPage({
    site: "douhot",
    avatarVisible: false,
    publicRows: true,
  });
  await assert.rejects(confirmOwnAccount(fake.page, "douhot", 1), {
    code: "LOGIN_REQUIRED",
  });
  assert.deepEqual(fake.stats(), { avatarClicks: 0, avatarHovers: 0, logoutClicks: 0 });
});

test("visible avatar alone or hidden logout template cannot pass login preflight", async () => {
  for (const site of ["douyin", "douhot"]) {
    const fake = accountPage({
      site,
      avatarVisible: true,
      logoutVisible: false,
    });
    await assert.rejects(confirmOwnAccount(fake.page, site, 1), {
      code: "LOGIN_REQUIRED",
    });
    assert.deepEqual(fake.stats(), { avatarClicks: site === "douyin" ? 0 : 1, avatarHovers: site === "douyin" ? 1 : 0, logoutClicks: 0 });
  }
});

test("both sites require opening own account menu and observing visible logout without clicking it", async () => {
  for (const site of ["douyin", "douhot"]) {
    const fake = accountPage({
      site,
      avatarVisible: true,
      logoutVisible: true,
    });
    assert.equal(await confirmOwnAccount(fake.page, site, 1), true);
    assert.deepEqual(fake.stats(), { avatarClicks: site === "douyin" ? 0 : 1, avatarHovers: site === "douyin" ? 1 : 0, logoutClicks: 0 });
  }
});

test("embedded login inputs have bounded coordinates/text and no navigation or shortcuts", () => {
  for (const value of [
    { type: "click", x: 0, y: 999 },
    { type: "scroll", deltaY: -2000 },
    { type: "text", text: "登录账号 user@example.com" },
    { type: "key", key: "Enter" },
  ])
    assert.equal(validateLoginInput(value), value);
  for (const value of [
    { type: "click", x: 1440, y: 10 },
    { type: "click", x: NaN, y: 10 },
    { type: "scroll", deltaY: 2001 },
    { type: "text", text: "x".repeat(2001) },
    { type: "text", text: "https://evil.example" },
    { type: "text", text: "123\n456" },
    { type: "key", key: "Control+L" },
    { type: "key", key: "Meta+R" },
    { type: "key", key: "Delete" },
    { type: "navigate", url: "https://www.douyin.com/" },
    { type: "click", x: 10, y: 10, url: "https://evil.example" },
  ])
    assert.throws(() => validateLoginInput(value), { code: "SOURCE_FAILED" });
});

async function embeddedLoginFixture(loginPresentation = "panel") {
  const folder = await mkdtemp(join(tmpdir(), "login-view-")),
    pages = [],
    launches = [];
  function makePage(url, opener = null) {
    let current = url,
      closed = false;
    const actions = [];
    const page = {
      actions,
      bringToFront: async () => actions.push(["focus"]),
      goto: async (value) => {
        current = value;
        return { status: () => 200 };
      },
      url: () => current,
      isClosed: () => closed,
      close: async () => {
        closed = true;
      },
      opener: async () => opener,
      screenshot: async (options) => {
        actions.push(["screenshot", options]);
        return Buffer.from("only-in-memory-jpeg");
      },
      waitForLoadState: async () => {},
      mouse: {
        click: async (x, y) => actions.push(["click", x, y]),
        wheel: async (x, y) => actions.push(["scroll", x, y]),
      },
      keyboard: {
        insertText: async () => actions.push(["text"]),
        press: async (key) => actions.push(["key", key]),
      },
      setURL: (value) => {
        current = value;
      },
    };
    pages.push(page);
    return page;
  }
  const root = makePage("about:blank");
  const collector = createAutomaticCollector({
    profileDir: folder,
    loginPresentation,
    chromium: {
      launchPersistentContext: async (_folder, options) => {
        launches.push(options);
        return {
          pages: () => pages.filter((p) => !p.isClosed()),
          newPage: async () => makePage("about:blank"),
          close: async () => {
            for (const p of pages) await p.close();
          },
        };
      },
    },
  });
  return {
    collector,
    root,
    makePage,
    launches,
    cleanup: async () => {
      await collector.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test("login view requires explicit login and returns sanitized viewport image in memory", async () => {
  const fake = await embeddedLoginFixture();
  try {
    await assert.rejects(fake.collector.loginView(), {
      code: "LOGIN_REQUIRED",
    });
    await assert.rejects(
      fake.collector.loginInput({ type: "click", x: 1, y: 1 }),
      { code: "LOGIN_REQUIRED" },
    );
    await fake.collector.login("douyin");
    assert.equal(fake.launches[0].headless, true);
    assert.equal(fake.collector.status().mode, "login");
    fake.root.setURL(
      "https://open.douyin.com/platform/oauth/pc/auth?token=secret#state",
    );
    const view = await fake.collector.loginView();
    assert.equal(view.url, "https://open.douyin.com/platform/oauth/pc/auth");
    assert.equal(view.width, 1440);
    assert.equal(view.height, 1000);
    assert.ok(view.image.startsWith("data:image/jpeg;base64,"));
    assert.deepEqual(fake.root.actions[0], [
      "screenshot",
      { type: "jpeg", quality: 75, fullPage: false },
    ]);
    assert.deepEqual(
      await fake.collector.loginInput({ type: "click", x: 8, y: 9 }),
      { site: "douyin", accepted: true },
    );
    await fake.collector.resume();
    await assert.rejects(fake.collector.loginView(), {
      code: "LOGIN_REQUIRED",
    });
  } finally {
    await fake.cleanup();
  }
});

test("login only selects genuine allowed popups and closes unrelated/foreign pages", async () => {
  const fake = await embeddedLoginFixture();
  try {
    await fake.collector.login("douhot");
    const unrelated = fake.makePage("https://www.douyin.com/search/other");
    const hostile = fake.makePage("https://evil.example/", fake.root);
    const oauth = fake.makePage(
      "https://open.douyin.com/platform/oauth/pc/auth?secret=1",
      fake.root,
    );
    assert.equal(
      (await fake.collector.loginView()).url,
      "https://open.douyin.com/platform/oauth/pc/auth",
    );
    assert.equal(hostile.isClosed(), true);
    assert.equal(unrelated.isClosed(), true);
    const returned = fake.makePage(
      "https://douhot.douyin.com/passport/web/web_login_success?code=secret",
      oauth,
    );
    assert.equal(
      (await fake.collector.loginView()).url,
      "https://douhot.douyin.com/passport/web/web_login_success",
    );
    assert.equal(oauth.isClosed(), true);
    assert.equal(
      (await fake.collector.loginView()).url,
      "https://douhot.douyin.com/passport/web/web_login_success",
    );
    assert.equal(returned.isClosed(), false);
  } finally {
    await fake.cleanup();
  }
});

test("login view/input reject foreign navigation on the root before capture or actions", async () => {
  const fake = await embeddedLoginFixture();
  try {
    await fake.collector.login("douyin");
    fake.root.setURL("http://127.0.0.1:4319/api/private");
    await assert.rejects(fake.collector.loginView(), { code: "SOURCE_FAILED" });
    await assert.rejects(
      fake.collector.loginInput({ type: "click", x: 1, y: 1 }),
      { code: "SOURCE_FAILED" },
    );
    assert.equal(fake.root.actions.length, 0);
  } finally {
    await fake.cleanup();
  }
});

test("legitimate blank OAuth popup waits for destination instead of initial document readiness", async () => {
  const fake = await embeddedLoginFixture();
  try {
    await fake.collector.login("douhot");
    const popup = fake.makePage("about:blank", fake.root);
    popup.waitForURL = async (predicate, options) => {
      assert.equal(options.waitUntil, "commit");
      assert.equal(options.timeout, 8000);
      assert.equal(predicate(new URL("about:blank")), false);
      popup.setURL(
        "https://open.douyin.com/platform/oauth/pc/auth?code=private",
      );
      assert.equal(predicate(new URL(popup.url())), true);
    };
    assert.equal(
      (await fake.collector.loginView()).url,
      "https://open.douyin.com/platform/oauth/pc/auth",
    );
    assert.equal(popup.isClosed(), false);
  } finally {
    await fake.cleanup();
  }
});

test("pending OAuth popup is retained on bounded timeout with explicit loading state", async () => {
  const fake = await embeddedLoginFixture();
  try {
    await fake.collector.login("douhot");
    const popup = fake.makePage("about:blank", fake.root);
    popup.waitForURL = async () => {
      throw new Error("navigation timeout");
    };
    await assert.rejects(fake.collector.loginView(), { code: "LOGIN_LOADING" });
    assert.equal(popup.isClosed(), false);
    assert.equal(popup.actions.length, 0);
    popup.setURL("https://passport.douyin.com/login?state=private");
    assert.equal(
      (await fake.collector.loginView()).url,
      "https://passport.douyin.com/login",
    );
  } finally {
    await fake.cleanup();
  }
});

test("blank popup is rejected only after actual foreign destination is known", async () => {
  const fake = await embeddedLoginFixture();
  try {
    await fake.collector.login("douhot");
    const popup = fake.makePage("about:blank", fake.root);
    popup.waitForURL = async () => popup.setURL("https://evil.example/oauth");
    const view = await fake.collector.loginView();
    assert.equal(view.site, "douhot");
    assert.equal(popup.isClosed(), true);
    assert.equal(popup.actions.length, 0);
  } finally {
    await fake.cleanup();
  }
});

test("drag accepts bounded user endpoints only and always releases the mouse after fixed steps", async () => {
  const action = { type: "drag", fromX: 10, fromY: 20, toX: 1400, toY: 999 };
  assert.equal(validateLoginInput(action), action);
  for (const invalid of [
    { ...action, fromX: -1 },
    { ...action, toX: 1440 },
    { ...action, toY: 1000 },
    { ...action, fromY: NaN },
    { ...action, steps: 100 },
    { ...action, toY: Infinity },
  ])
    assert.throws(() => validateLoginInput(invalid), { code: "SOURCE_FAILED" });
  const fake = await embeddedLoginFixture();
  try {
    await fake.collector.login("douyin");
    const moves = [];
    fake.root.mouse.move = async (...args) => moves.push(["move", ...args]);
    fake.root.mouse.down = async () => moves.push(["down"]);
    fake.root.mouse.up = async () => moves.push(["up"]);
    await fake.collector.loginInput(action);
    assert.deepEqual(moves, [
      ["move", 10, 20],
      ["down"],
      ["move", 1400, 999, { steps: 20 }],
      ["up"],
    ]);
    moves.length = 0;
    fake.root.mouse.move = async (...args) => {
      moves.push(["move", ...args]);
      if (args.length === 3) throw new Error("gesture interrupted");
    };
    await assert.rejects(
      fake.collector.loginInput(action),
      /gesture interrupted/,
    );
    assert.deepEqual(moves.at(-1), ["up"]);
  } finally {
    await fake.cleanup();
  }
});

test("live pointer forwards only bounded actual samples with one down/up lifecycle", async () => {
  const down = { type: "pointer", phase: "down", x: 20, y: 30 };
  assert.equal(validateLoginInput(down), down);
  for (const invalid of [
    { ...down, phase: "hover" },
    { ...down, x: 1440 },
    { ...down, y: 1000 },
    { ...down, x: NaN },
    { ...down, y: -1 },
    { ...down, steps: 20 },
  ])
    assert.throws(() => validateLoginInput(invalid), { code: "SOURCE_FAILED" });
  const fake = await embeddedLoginFixture();
  try {
    await fake.collector.login("douyin");
    const events = [];
    fake.root.mouse.move = async (...args) => events.push(["move", ...args]);
    fake.root.mouse.down = async () => events.push(["down"]);
    fake.root.mouse.up = async () => events.push(["up"]);
    await assert.rejects(
      fake.collector.loginInput({ ...down, phase: "move" }),
      { code: "SOURCE_FAILED" },
    );
    assert.deepEqual(events, []);
    await fake.collector.loginInput(down);
    await assert.rejects(fake.collector.loginInput(down), {
      code: "SOURCE_FAILED",
    });
    await assert.rejects(
      fake.collector.loginInput({ type: "click", x: 50, y: 60 }),
      { code: "SOURCE_FAILED" },
    );
    await fake.collector.loginInput({ ...down, phase: "move", x: 41, y: 31 });
    await fake.collector.loginInput({ ...down, phase: "move", x: 48, y: 29 });
    await fake.collector.loginInput({ ...down, phase: "up", x: 51, y: 30 });
    await fake.collector.loginInput({ ...down, phase: "up", x: 51, y: 30 });
    assert.deepEqual(events, [
      ["move", 20, 30],
      ["down"],
      ["move", 41, 31],
      ["move", 48, 29],
      ["move", 51, 30],
      ["up"],
    ]);
  } finally {
    await fake.cleanup();
  }
});

test("pointer motion failures release mouse and reset gesture state", async () => {
  const fake = await embeddedLoginFixture();
  try {
    await fake.collector.login("douyin");
    const events = [];
    fake.root.mouse.move = async (x, y) => {
      events.push(["move", x, y]);
      if (x === 40) throw new Error("move failure");
    };
    fake.root.mouse.down = async () => events.push(["down"]);
    fake.root.mouse.up = async () => events.push(["up"]);
    await fake.collector.loginInput({
      type: "pointer",
      phase: "down",
      x: 20,
      y: 30,
    });
    await assert.rejects(
      fake.collector.loginInput({
        type: "pointer",
        phase: "move",
        x: 40,
        y: 30,
      }),
      /move failure/,
    );
    assert.deepEqual(events.at(-1), ["up"]);
    await assert.rejects(
      fake.collector.loginInput({
        type: "pointer",
        phase: "move",
        x: 41,
        y: 30,
      }),
      { code: "SOURCE_FAILED" },
    );
    await fake.collector.loginInput({
      type: "pointer",
      phase: "down",
      x: 20,
      y: 30,
    });
    await assert.rejects(
      fake.collector.loginInput({ type: "pointer", phase: "up", x: 40, y: 30 }),
      /move failure/,
    );
    assert.deepEqual(events.at(-1), ["up"]);
  } finally {
    await fake.cleanup();
  }
});

test("resume close and login-site changes release outstanding user pointer", async () => {
  for (const finish of ["resume", "close", "switch"]) {
    const fake = await embeddedLoginFixture();
    try {
      await fake.collector.login("douyin");
      const events = [];
      fake.root.mouse.move = async () => {};
      fake.root.mouse.down = async () => events.push("down");
      fake.root.mouse.up = async () => events.push("up");
      await fake.collector.loginInput({
        type: "pointer",
        phase: "down",
        x: 20,
        y: 30,
      });
      if (finish === "switch") await fake.collector.login("douhot");
      else await fake.collector[finish]();
      assert.deepEqual(events, ["down", "up"]);
    } finally {
      await fake.cleanup();
    }
  }
});

test("native login focuses existing same-site window without navigation or new profile", async () => {
  const fake = await embeddedLoginFixture("native");
  try {
    const result = await fake.collector.login("douhot");
    assert.deepEqual(result, {
      mode: "login",
      site: "douhot",
      presentation: "native",
    });
    assert.equal(fake.collector.status().presentation, "native");
    assert.equal(fake.launches[0].headless, false);
    fake.root.setURL(
      "https://open.douyin.com/platform/oauth/pc/auth?keep-state=1",
    );
    let navigations = 0;
    fake.root.goto = async () => {
      navigations++;
      throw new Error("must not reload");
    };
    await fake.collector.login("douhot");
    assert.equal(navigations, 0);
    assert.equal(fake.launches.length, 1);
    assert.equal(
      fake.root.url(),
      "https://open.douyin.com/platform/oauth/pc/auth?keep-state=1",
    );
    assert.deepEqual(fake.root.actions, [["focus"], ["focus"]]);
    await assert.rejects(fake.collector.loginView(), {
      code: "NATIVE_LOGIN_ONLY",
    });
    await assert.rejects(
      fake.collector.loginInput({ type: "click", x: 20, y: 30 }),
      { code: "NATIVE_LOGIN_ONLY" },
    );
    assert.deepEqual(fake.root.actions, [["focus"], ["focus"]]);
  } finally {
    await fake.cleanup();
  }
});

test("unspecified login presentation defaults native and rejects legacy panel APIs even before login", async () => {
  const collector = createAutomaticCollector({
    chromium: {
      launchPersistentContext: async () => {
        throw new Error("should not launch");
      },
    },
  });
  assert.equal(collector.status().presentation, "native");
  await assert.rejects(collector.loginView(), { code: "NATIVE_LOGIN_ONLY" });
  await assert.rejects(
    collector.loginInput({ type: "pointer", phase: "down", x: 1, y: 1 }),
    { code: "NATIVE_LOGIN_ONLY" },
  );
});

test("background shell and native login use separate configured executables with the same dedicated profile", async () => {
  const folder = await mkdtemp(join(tmpdir(), "collector-executables-"));
  try {
    const shell = join(folder, "headless-shell"),
      native = join(folder, "native-chrome");
    await writeFile(shell, "test fixture, never executed");
    await writeFile(native, "test fixture, never executed");
    const calls = [],
      page = {
        close: async () => {},
        goto: async () => ({ status: () => 200 }),
        bringToFront: async () => {},
      };
    const collector = createAutomaticCollector({
      profileDir: join(folder, "profile"),
      headlessExecutablePath: shell,
      executablePath: native,
      chromium: {
        launchPersistentContext: async (profile, options) => {
          calls.push({ profile, options });
          return {
            newPage: async () => page,
            pages: () => [],
            close: async () => {},
          };
        },
      },
    });
    await assert.rejects(
      collector.collect({ purpose: "game-research", keyword: "" }),
      { code: "SOURCE_FAILED" },
    );
    await collector.login("douyin");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headless, true);
    assert.equal(calls[0].options.executablePath, shell);
    assert.equal(calls[1].options.headless, false);
    assert.equal(calls[1].options.executablePath, native);
    assert.equal(calls[0].profile, calls[1].profile);
    await collector.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("configured missing headless shell fails explicitly without falling back to ordinary Chrome", async () => {
  const folder = await mkdtemp(join(tmpdir(), "collector-shell-missing-"));
  try {
    let launches = 0;
    const collector = createAutomaticCollector({
      profileDir: join(folder, "profile"),
      headlessExecutablePath: join(folder, "missing-shell"),
      executablePath: "/ordinary/chrome",
      chromium: {
        launchPersistentContext: async () => {
          launches++;
          throw new Error("must not launch fallback");
        },
      },
    });
    await assert.rejects(
      collector.collect({ purpose: "game-research", keyword: "率土之滨" }),
      /CRAWL_HEADLESS_EXECUTABLE.*不会回退/,
    );
    assert.equal(launches, 0);
    await collector.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("closed native window can reopen a different site and stale close events cannot clear the new session", async () => {
  const folder = await mkdtemp(join(tmpdir(), "native-context-close-")),
    instances = [];
  try {
    const collector = createAutomaticCollector({
      profileDir: folder,
      chromium: {
        launchPersistentContext: async () => {
          let closed = false,
            listener;
          const page = {
            isClosed: () => closed,
            url: () => "https://www.douyin.com/",
            goto: async () => ({ status: () => 200 }),
            bringToFront: async () => {},
          };
          const instance = {
            pages: () => (closed ? [] : [page]),
            newPage: async () => {
              if (closed) throw new Error("TargetClosed");
              return page;
            },
            on: (event, callback) => {
              assert.equal(event, "close");
              listener = callback;
            },
            close: async () => {
              closed = true;
              listener?.();
            },
            emitClose: () => listener?.(),
          };
          instances.push(instance);
          return instance;
        },
      },
    });
    await collector.login("douyin");
    await instances[0].close();
    assert.equal(collector.status().mode, "closed");
    const result = await collector.login("douhot");
    assert.equal(instances.length, 2);
    assert.equal(result.site, "douhot");
    assert.equal(result.mode, "login");
    instances[0].emitClose();
    assert.equal(collector.status().mode, "login");
    assert.equal(collector.status().site, "douhot");
    await collector.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("native reuse also rejects an empty closed context before a cross-site switch without a close event", async () => {
  const fake = await embeddedLoginFixture("native");
  try {
    await fake.collector.login("douyin");
    await fake.root.close();
    await fake.collector.login("douhot");
    assert.equal(fake.launches.length, 2);
    assert.equal(fake.collector.status().site, "douhot");
  } finally {
    await fake.cleanup();
  }
});

async function closingFixture({ closeTimeoutMs = 15 } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "collector-closing-")),
    contexts = [];
  const collector = createAutomaticCollector({
    profileDir: folder,
    closeTimeoutMs,
    chromium: {
      launchPersistentContext: async () => {
        let closeListener,
          resolveClose,
          closeCalls = 0;
        const pending = new Promise((resolve) => {
          resolveClose = resolve;
        });
        const page = {
          isClosed: () => false,
          url: () => "https://www.douyin.com/",
          goto: async () => ({ status: () => 200 }),
          bringToFront: async () => {},
        };
        const context = {
          pages: () => [page],
          newPage: async () => page,
          on: (event, listener) => {
            if (event === "close") closeListener = listener;
          },
          close: async () => {
            closeCalls++;
            await pending;
          },
          emitClose: () => closeListener?.(),
          finishClose: () => resolveClose(),
          calls: () => closeCalls,
        };
        contexts.push(context);
        return context;
      },
    },
  });
  return {
    collector,
    contexts,
    cleanup: async () => {
      for (const context of contexts) {
        context.finishClose();
        context.emitClose();
      }
      await collector.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test("unconfirmed close stays closing, times out, and blocks another profile launch", async () => {
  const fake = await closingFixture();
  try {
    await fake.collector.login("douyin");
    await assert.rejects(fake.collector.resume(), { code: "CLOSE_TIMEOUT" });
    assert.equal(fake.collector.status().mode, "closing");
    assert.equal(fake.contexts[0].calls(), 1);
    await assert.rejects(fake.collector.close(), { code: "CLOSE_TIMEOUT" });
    await assert.rejects(fake.collector.login("douhot"), {
      code: "CLOSE_TIMEOUT",
    });
    assert.equal(fake.contexts.length, 1);
    assert.equal(fake.contexts[0].calls(), 1);
    assert.equal(fake.collector.status().mode, "closing");
  } finally {
    await fake.cleanup();
  }
});

test("real close event recovers closing even when underlying close promise never settles", async () => {
  const fake = await closingFixture();
  try {
    await fake.collector.login("douyin");
    await assert.rejects(fake.collector.resume(), { code: "CLOSE_TIMEOUT" });
    fake.contexts[0].emitClose();
    assert.equal(fake.collector.status().mode, "closed");
    await fake.collector.login("douhot");
    assert.equal(fake.contexts.length, 2);
    assert.equal(fake.collector.status().mode, "login");
    fake.contexts[0].emitClose();
    assert.equal(fake.collector.status().mode, "login");
    assert.equal(fake.collector.status().site, "douhot");
  } finally {
    await fake.cleanup();
  }
});

test("resume abort ends waiting without pretending close completed; late completion remains recoverable", async () => {
  const fake = await closingFixture({ closeTimeoutMs: 5000 });
  try {
    await fake.collector.login("douyin");
    const controller = new AbortController();
    const pending = fake.collector.resume({ signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { code: "CLOSE_TIMEOUT" });
    assert.equal(fake.collector.status().mode, "closing");
    fake.contexts[0].finishClose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.collector.status().mode, "closed");
    assert.equal((await fake.collector.resume()).mode, "closed");
  } finally {
    await fake.cleanup();
  }
});

test("cancelled launch returning late is retained through bounded close and recovered by its real close event", async () => {
  const folder = await mkdtemp(join(tmpdir(), "late-launch-close-"));
  let signalStarted,
    completeLaunch,
    finishOldClose,
    oldListener,
    newListener,
    launches = 0,
    oldCloseCalls = 0;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const lateLaunch = new Promise((resolve) => {
    completeLaunch = resolve;
  });
  const oldClose = new Promise((resolve) => {
    finishOldClose = resolve;
  });
  const page = {
    isClosed: () => false,
    url: () => "https://www.douyin.com/",
    goto: async () => ({ status: () => 200 }),
    bringToFront: async () => {},
  };
  const oldContext = {
    pages: () => [page],
    on: (event, listener) => {
      if (event === "close") oldListener = listener;
    },
    close: async () => {
      oldCloseCalls++;
      await oldClose;
    },
  };
  const newContext = {
    pages: () => [page],
    on: (event, listener) => {
      if (event === "close") newListener = listener;
    },
    close: async () => newListener?.(),
  };
  const collector = createAutomaticCollector({
    profileDir: folder,
    closeTimeoutMs: 15,
    chromium: {
      launchPersistentContext: async () => {
        launches++;
        if (launches === 1) {
          signalStarted();
          return lateLaunch;
        }
        return newContext;
      },
    },
  });
  try {
    const pending = collector.login("douyin");
    const rejected = assert.rejects(pending, { code: "CLOSE_TIMEOUT" });
    await started;
    await collector.close(); // Cancellation happens before launch has returned.
    completeLaunch(oldContext);
    await rejected;
    assert.equal(collector.status().mode, "closing");
    assert.equal(oldCloseCalls, 1);
    await assert.rejects(collector.login("douhot"), { code: "CLOSE_TIMEOUT" });
    assert.equal(launches, 1);
    assert.equal(oldCloseCalls, 1);
    oldListener();
    assert.equal(collector.status().mode, "closed");
    await collector.login("douhot");
    assert.equal(launches, 2);
    assert.equal(collector.status().mode, "login");
    finishOldClose();
    await new Promise((resolve) => setImmediate(resolve));
    oldListener();
    assert.equal(collector.status().mode, "login");
    assert.equal(collector.status().site, "douhot");
  } finally {
    finishOldClose();
    oldListener?.();
    await collector.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Douyin account menu already opened by the user is verified without click or hover", async () => {
  const fake = accountPage({site:"douyin",avatarVisible:true,menuOpen:true});
  assert.equal(await confirmOwnAccount(fake.page,"douyin",1),true);
  assert.deepEqual(fake.stats(),{avatarClicks:0,avatarHovers:0,logoutClicks:0});
});

test("unique top-right avatar geometry only locates a hover target and still requires visible logout", async () => {
  const avatar={left:1380,right:1412,top:24,bottom:56,width:32,height:32};
  for (const logoutVisible of [false,true]) {
    const fake=accountPage({site:"douyin",avatarVisible:false,logoutVisible,geometricImages:[avatar]});
    if(logoutVisible) assert.equal(await confirmOwnAccount(fake.page,"douyin",1),true);
    else await assert.rejects(confirmOwnAccount(fake.page,"douyin",1),{code:"LOGIN_REQUIRED"});
    assert.deepEqual(fake.stats(),{avatarClicks:0,avatarHovers:1,logoutClicks:0});
  }
  for (const geometricImages of [
    [avatar,{...avatar,left:1340,right:1372}],
    [{...avatar,top:200,bottom:232}],
    [{...avatar,left:20,right:52}],
    [{...avatar,width:200,right:1580}],
    [{...avatar,hidden:true}],
  ]) {
    const fake=accountPage({site:"douyin",avatarVisible:false,geometricImages});
    await assert.rejects(confirmOwnAccount(fake.page,"douyin",1),{code:"LOGIN_REQUIRED"});
    assert.deepEqual(fake.stats(),{avatarClicks:0,avatarHovers:0,logoutClicks:0});
  }
});

test("native verification reads the current page, preserves failed session and retries without reload or closing", async () => {
  const fake=await embeddedLoginFixture("native");
  try {
    await fake.collector.login("douyin");
    fake.root.setURL("https://www.douyin.com/jingxuan");
    fake.root.goto=async()=>{throw Error("verification must not navigate");};
    Object.assign(fake.root,accountPage({site:"douyin",logoutVisible:false}).page);
    await assert.rejects(fake.collector.verifyLogin("douyin"),{code:"LOGIN_REQUIRED"});
    assert.equal(fake.root.isClosed(),false);
    assert.equal(fake.collector.status().mode,"login");
    assert.equal(fake.collector.status().phase,"idle");
    const untrusted=fake.makePage("https://unrelated.invalid/");
    Object.assign(fake.root,accountPage({site:"douyin"}).page);
    assert.deepEqual(await fake.collector.verifyLogin("douyin"),{site:"douyin",state:"ready",native_verified:true});
    assert.equal(fake.root.isClosed(),false);
    assert.equal(untrusted.isClosed(),false);
    assert.equal(fake.root.url(),"https://www.douyin.com/jingxuan");
    assert.equal(fake.launches.length,1);
    assert.equal(fake.collector.status().mode,"login"); // Never background readiness.
  } finally {await fake.cleanup();}
});

test("native verification rejects challenges and private runtime errors without closing windows", async () => {
  const fake=await embeddedLoginFixture("native");
  try {
    await fake.collector.login("douyin");
    const account=accountPage({site:"douyin"});
    Object.assign(fake.root,account.page);
    const locator=fake.root.locator;
    fake.root.locator=selector=>selector==="body"?{innerText:async()=>"请拖动滑块完成安全验证"}:locator(selector);
    await assert.rejects(fake.collector.verifyLogin("douyin"),{code:"VERIFICATION_REQUIRED"});
    assert.equal(fake.root.isClosed(),false);
    assert.deepEqual(account.stats(),{avatarClicks:0,avatarHovers:0,logoutClicks:0});
    fake.root.locator=()=>{throw Error("PRIVATE_ACCOUNT_TEXT");};
    await assert.rejects(fake.collector.verifyLogin("douyin"),error=>error.code==="LOGIN_CHECK_FAILED"&&!error.message.includes("PRIVATE"));
    assert(!JSON.stringify(fake.collector.status()).includes("PRIVATE"));
    assert.equal(fake.root.isClosed(),false);
  } finally {await fake.cleanup();}
});

test("manually closed login window yields no native proof and does not launch a replacement during verification", async () => {
  const fake=await embeddedLoginFixture("native");
  try {
    await fake.collector.login("douyin");
    await fake.root.close();
    assert.deepEqual(await fake.collector.verifyLogin("douyin"),{site:"douyin",state:"window_closed",native_verified:false});
    assert.equal(fake.launches.length,1);
  } finally {await fake.cleanup();}
});


test("visible logout wording without a uniquely located account avatar cannot prove login",async()=>{
 const fake=accountPage({site:"douyin",avatarVisible:false,menuOpen:true});
 await assert.rejects(confirmOwnAccount(fake.page,"douyin",1),{code:"LOGIN_REQUIRED"});
 assert.deepEqual(fake.stats(),{avatarClicks:0,avatarHovers:0,logoutClicks:0});
});

async function retainedNativeFixture() {
  const folder = await mkdtemp(join(tmpdir(), 'retained-native-'));
  const launches = [], contexts = [], allPages = [];
  let nextSetup = null, invalidations = 0;
  const makePage = (ctx) => {
    let url = 'about:blank', closed = false;
    const events = new Map(), accounts = { douyin: accountPage({site:'douyin'}).page, douhot: accountPage({site:'douhot'}).page };
    const account = () => accounts[url.includes('douhot.') ? 'douhot' : 'douyin'];
    const page = {
      focuses: 0, closeCalls: 0, gotoCalls: 0,
      evaluate: async (fn) => {
        if(fn.name === "observeGameFiltersDOM") return {url,controls:[
          {label:"视频",selection:{kind:"aria-selected",selected:true}},
          {label:"最多点赞",selection:{kind:"aria-checked",selected:true}},
          {label:"一周内",selection:{kind:"aria-checked",selected:true}},
        ]};
        assert.equal(fn, observeCollectionStructureDOM); return {controls: []};
      },
      isClosed: () => closed, url: () => url, opener: async () => null,
      goto: async (value) => { page.gotoCalls++;url = value; return {status:()=>200}; },
      title: async () => '公开来源', bringToFront: async () => { page.focuses++; },
      close: async () => { page.closeCalls++; closed = true; },
      on: (event, callback) => events.set(event, callback), emit: (event, value) => events.get(event)?.(value),
      locator: (selector) => selector === 'body' ? {innerText:async()=>'暂无相关结果'} : account().locator(selector),
      getByText: (...args) => account().getByText(...args), getByRole: (...args) => account().getByRole(...args),
    };
    ctx.live.push(page); allPages.push(page); return page;
  };
  const collector = createAutomaticCollector({profileDir:folder,onSessionClosed:()=>{invalidations++;},chromium:{launchPersistentContext:async(_profile, options)=>{
    launches.push(options); let closeListener;
    const ctx = { live:[], closes:0,
      pages:()=>ctx.live.filter(p=>!p.isClosed()),
      newPage: async()=> { const p = makePage(ctx), setup = nextSetup; nextSetup = null; if(setup) await setup(p); return p; },
      on:(event,cb)=>{if(event==='close')closeListener=cb;},
      close:async()=>{ctx.closes++;for(const p of ctx.live)await p.close();closeListener?.();},
      emitClose:()=>closeListener?.(),
    };
    contexts.push(ctx);makePage(ctx);return ctx;
  }}});
  return {collector,launches,contexts,allPages,invalidations:()=>invalidations,makePage:(ctx=contexts.at(-1))=>makePage(ctx),setupNext:fn=>{nextSetup=fn;},cleanup:async()=>{await collector.close();await rm(folder,{recursive:true,force:true});}};
}

test('verified native context survives resume, probes and collection without refocus or relaunch', async()=>{
  const f=await retainedNativeFixture();
  try {
    await f.collector.login('douyin');const root=f.allPages[0];
    await f.collector.verifyLogin('douyin');
    assert.equal((await f.collector.resume()).native_context_retained,true);
    assert.equal(f.collector.status().mode,'background');
    assert.equal((await f.collector.probe('douyin')).state,'ready');
    await assert.rejects(f.collector.collect({purpose:'game-research',keyword:'率土之滨'}),/结果更新信号尚未核验/);
    assert.equal(f.launches.length,1);assert.equal(f.launches[0].headless,false);
    assert.equal(f.contexts[0].closes,0);assert.equal(root.isClosed(),false);assert.equal(root.focuses,1);
    assert(f.allPages.slice(1).every(p=>p.isClosed()&&p.focuses===0));
    await f.collector.login('douhot');const hot=f.contexts[0].pages().find(p=>p!==root);
    assert.equal(root.isClosed(),false);await f.collector.verifyLogin('douhot');await f.collector.resume();
    await f.collector.login('douyin');assert.equal(root.focuses,2);assert.equal(hot.isClosed(),false);
    await f.collector.verifyLogin('douyin');await f.collector.resume();
    assert.equal(f.launches.length,1);assert.equal(f.contexts[0].pages().length,2);
    f.contexts[0].emitClose();assert.equal(f.collector.status().native_context_retained,false);
    assert.equal(f.invalidations(),1);
    await f.collector.login('douyin');const newRoot=f.contexts[1].pages()[0];
    f.contexts[0].emitClose();assert.equal(f.invalidations(),1);assert.equal(newRoot.isClosed(),false);
  } finally {await f.cleanup();}
});

test('native context is never retained by an unverified resume',async()=>{
  const f=await retainedNativeFixture();
  try {await f.collector.login('douyin');assert.equal((await f.collector.resume()).native_context_retained,false);assert.equal(f.contexts[0].closes,1);}finally{await f.cleanup();}
});

test('native search challenge retains the actual work page and same-scope recovery never navigates or opens another page',async()=>{
 const f=await retainedNativeFixture();
 const payload={purpose:'game-research',keyword:'星际猎人',hours:168,sort:'likes'};
 try {
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();
  const root=f.allPages[0];let challenged,navigations=0;
  f.setupNext(p=>{challenged=p;const navigate=p.goto;p.goto=async url=>{navigations++;return navigate(url);};p.title=async()=>'验证码中间页';});
  await assert.rejects(f.collector.collect(payload),{code:'VERIFICATION_REQUIRED'});
  assert.equal(challenged.isClosed(),false);assert.equal(root.isClosed(),false);assert.equal(challenged.focuses,0);
  assert.equal(f.collector.status().recovery_state,'waiting');
  assert.equal((await f.collector.probe('douyin')).state,'verification_required');
  await assert.rejects(f.collector.collect({...payload,keyword:'率土之滨'}),{code:'VERIFICATION_REQUIRED'});
  await assert.rejects(f.collector.login('douhot'),{code:'VERIFICATION_REQUIRED'});
  await f.collector.login('douyin');assert.equal(challenged.focuses,1);assert.equal(navigations,1);
  await assert.rejects(f.collector.verifyLogin('douyin'),{code:'VERIFICATION_REQUIRED'});
  await assert.rejects(f.collector.resume(),{code:'VERIFICATION_REQUIRED'});assert.equal(challenged.isClosed(),false);
  challenged.title=async()=>'搜索结果';
  await f.collector.verifyLogin('douyin');const handoff=await f.collector.resume();assert(handoff.retry_scope_key);
  assert.equal(root.isClosed(),false);
  await assert.rejects(f.collector.collect(payload),/结果更新信号尚未核验/);
  assert.equal(navigations,1);assert.equal(f.allPages.length,2);assert.equal(challenged.isClosed(),false);
  assert.equal(root.isClosed(),true);assert.equal(f.collector.status().recovery_scope_key,null);
  assert.equal(f.collector.status().retained_search_scope_key,collectionRecoveryKey(payload));
  for(let i=0;i<2;i++)await assert.rejects(f.collector.collect(payload),/结果更新信号尚未核验/);
  assert.equal(navigations,1);assert.equal(f.allPages.length,2);assert.equal(challenged.closeCalls,0);
 }finally{await f.cleanup();}
});

test('task-owned game learning challenges keep their verification error but never reserve a public recovery slot',async()=>{
 const f=await retainedNativeFixture();
 try {
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();const root=f.allPages[0];let challenged;
  f.setupNext(p=>{challenged=p;p.title=async()=>'验证码中间页';});
  await assert.rejects(f.collector.collect({purpose:'game-learning',keyword:'星际猎人'}),{code:'VERIFICATION_REQUIRED'});
  assert.equal(f.collector.status().recovery_scope_key,null);assert.equal(f.collector.status().recovery_state,null);
  assert.equal(challenged.isClosed(),true);assert.equal(root.isClosed(),false);
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');assert.equal((await f.collector.resume()).retry_scope_key,null);
  await assert.rejects(f.collector.collect({purpose:'game-research',keyword:'率土之滨'}),/结果更新信号尚未核验/);
 }finally{await f.cleanup();}
});

test('challenge confirmation rejects a different search and closed or replaced sessions cannot reuse its page',async()=>{
 const f=await retainedNativeFixture();const payload={purpose:'game-research',keyword:'星际猎人'};
 try {
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();let challenged;
  f.setupNext(p=>{challenged=p;p.title=async()=>'验证码中间页';});
  await assert.rejects(f.collector.collect(payload),{code:'VERIFICATION_REQUIRED'});
  await f.collector.login('douyin');challenged.title=async()=>'搜索结果';
  await challenged.goto('https://www.douyin.com/search/其他游戏?type=video');
  await assert.rejects(f.collector.verifyLogin('douyin'),{code:'VERIFICATION_REQUIRED'});
  assert.equal(challenged.isClosed(),false);assert.equal(f.collector.status().recovery_state,'waiting');
  await challenged.goto('https://www.douyin.com/search/%ZZ?type=video');
  await assert.rejects(f.collector.verifyLogin('douyin'),{code:'VERIFICATION_REQUIRED'});
  for (const query of ['type=user','type=live','','type=video&type=user']) {
   await challenged.goto('https://www.douyin.com/search/星际猎人?'+query);
   await assert.rejects(f.collector.verifyLogin('douyin'),{code:'VERIFICATION_REQUIRED'});
   assert.equal(f.collector.status().recovery_state,'waiting');
   assert.equal(challenged.isClosed(),false);
  }
  await challenged.goto('https://www.douyin.com/search/星际猎人?type=video');
  await f.collector.verifyLogin('douyin');
  await challenged.goto('https://www.douyin.com/search/星际猎人?type=user');
  await assert.rejects(f.collector.resume(),{code:'VERIFICATION_REQUIRED'});
  assert.equal(f.collector.status().recovery_state,'waiting');
  assert.equal(challenged.isClosed(),false);
  await challenged.close();await f.collector.login('douyin');assert.equal(f.collector.status().recovery_scope_key,null);
  await f.collector.close();await f.collector.login('douyin');const newRoot=f.contexts.at(-1).pages()[0];
  f.contexts[0].emitClose();assert.equal(newRoot.isClosed(),false);assert.equal(f.collector.status().recovery_scope_key,null);
 }finally{await f.cleanup();}
});

test('same-page challenge repeats do not grow tabs and cancellation during recovery cleans only that page',async()=>{
 const f=await retainedNativeFixture();const payload={purpose:'game-research',keyword:'星际猎人'};let release,startedResolve;
 try {
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();const root=f.allPages[0];let challenged;
  f.setupNext(p=>{challenged=p;p.title=async()=>'验证码中间页';});
  await assert.rejects(f.collector.collect(payload),{code:'VERIFICATION_REQUIRED'});
  for(let i=0;i<2;i++){
   await f.collector.login('douyin');challenged.title=async()=>'搜索结果';await f.collector.verifyLogin('douyin');await f.collector.resume();
   challenged.title=async()=>'验证码中间页';await assert.rejects(f.collector.collect(payload),{code:'VERIFICATION_REQUIRED'});
   assert.equal(f.allPages.length,2);assert.equal(challenged.isClosed(),false);
  }
  await f.collector.login('douyin');challenged.title=async()=>'搜索结果';await f.collector.verifyLogin('douyin');await f.collector.resume();
  const started=new Promise(r=>startedResolve=r),blocked=new Promise(r=>release=r),original=challenged.locator;
  challenged.locator=selector=>selector==='body'?{innerText:async()=>{startedResolve();await blocked;return '暂无相关结果';}}:original(selector);
  const abort=new AbortController(),running=f.collector.collect(payload,{signal:abort.signal}),rejected=assert.rejects(running);
  await started;abort.abort(Error('request timeout'));await f.collector.cancelOperation();release();await rejected;
  assert.equal(challenged.isClosed(),true);assert.equal(root.isClosed(),false);assert.equal(f.contexts[0].closes,0);
  assert.equal(f.collector.status().recovery_scope_key,null);
 }finally{release?.();await f.cleanup();}
});

test('cancelling owned work closes its popup while preserving both protected site pages',async()=>{
  const f=await retainedNativeFixture();let releaseGoto,startedResolve;
  const started=new Promise(r=>startedResolve=r), blocked=new Promise(r=>releaseGoto=r);
  try {
    for(const target of ['douyin','douhot']){await f.collector.login(target);await f.collector.verifyLogin(target);await f.collector.resume();}
    const protectedPages=f.contexts[0].pages();let work;
    f.setupNext(p=>{work=p;p.goto=async()=>{startedResolve();await blocked;return {status:()=>200};};});
    const abort=new AbortController();const running=f.collector.collect({purpose:'game-research',keyword:'率土之滨'},{signal:abort.signal});
    const rejected=assert.rejects(running);await started;
    const popup=f.makePage();work.emit('popup',popup);abort.abort(new Error('cancelled'));
    await f.collector.cancelOperation();assert(work.isClosed());assert(popup.isClosed());
    assert.equal(work.closeCalls,1);assert.equal(popup.closeCalls,1);
    assert(protectedPages.every(p=>!p.isClosed()));assert.equal(f.contexts[0].closes,0);
    const latePopup=f.makePage();work.emit('popup',latePopup);await new Promise(r=>setImmediate(r));assert(latePopup.isClosed());
    releaseGoto();await rejected;assert.equal(f.collector.status().phase,'idle');
    assert.equal((await f.collector.probe('douyin')).state,'ready');assert.equal(f.launches.length,1);
    const oldContext=f.contexts[0];await f.collector.close();await f.collector.login('douyin');
    const newRoot=f.contexts[1].pages()[0], detachedPopup=f.makePage(oldContext);
    work.emit('popup',detachedPopup);await new Promise(r=>setImmediate(r));
    assert(detachedPopup.isClosed());assert.equal(newRoot.isClosed(),false);assert.equal(f.contexts[1].closes,0);
  } finally {releaseGoto?.();await f.cleanup();}
});

test('cancel waits for late work-page creation and cleanup failure blocks new work until recovered',async()=>{
 const f=await retainedNativeFixture();let completeCreate,startedResolve;
 const started=new Promise(r=>startedResolve=r), pending=new Promise(r=>completeCreate=r);
 try {
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();const root=f.allPages[0];let work;
  f.setupNext(async p=>{work=p;startedResolve();await pending;});
  const abort=new AbortController(),running=f.collector.collect({purpose:'game-research',keyword:'率土之滨'},{signal:abort.signal});
  const rejected=assert.rejects(running);await started;abort.abort(new Error('cancelled'));let cleaned=false;
  const cancellation=f.collector.cancelOperation().then(()=>{cleaned=true;});await new Promise(r=>setImmediate(r));assert.equal(cleaned,false);
  completeCreate();await cancellation;await rejected;assert(work.isClosed());assert.equal(root.isClosed(),false);
  let broken;f.setupNext(p=>{broken=p;p.close=async()=>{throw Error('close failed');};});
  await assert.rejects(f.collector.collect({purpose:'game-research',keyword:'率土之滨'}),{code:'OPERATION_CLEANUP_FAILED'});
  assert.equal(f.collector.status().phase,'cleanup_failed');await assert.rejects(f.collector.probe('douyin'),/正忙/);
  broken.close=async()=>{};await f.collector.cancelOperation();assert.equal(f.collector.status().phase,'idle');assert.equal(root.isClosed(),false);
 }finally{completeCreate?.();await f.cleanup();}
});

test('native proof probe rechecks the protected page without navigation, new tabs or cached-ready shortcuts',async()=>{
 const f=await retainedNativeFixture();
 try {
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();
  const root=f.allPages[0], ctx=f.contexts[0];let opened=0,navigated=0;
  ctx.newPage=async()=>{opened++;throw Error('probe must reuse verified page');};
  root.goto=async()=>{navigated++;throw Error('probe must not reload verified page');};
  assert.equal((await f.collector.probe('douyin')).state,'ready');
  root.title=async()=>'验证码中间页';assert.equal((await f.collector.probe('douyin')).state,'verification_required');
  root.title=async()=>'公开来源';Object.assign(root,accountPage({site:'douyin',logoutVisible:false}).page);
  assert.equal((await f.collector.probe('douyin')).state,'login_required');
  assert.equal(opened,0);assert.equal(navigated,0);assert.equal(root.focuses,1);assert.equal(root.isClosed(),false);assert.equal(ctx.closes,0);
 }finally{await f.cleanup();}
});

test('protected-page probe cancellation and mid-check context changes never close its page or claim readiness',async()=>{
 const f=await retainedNativeFixture();let unblock,startedResolve;
 const started=new Promise(r=>startedResolve=r), blocked=new Promise(r=>unblock=r);
 try {
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();
  const root=f.allPages[0], original=root.locator;let accountChecks=0;
  const originalText=root.getByText;root.getByText=(...args)=>{accountChecks++;return originalText(...args);};
  root.locator=selector=>selector==='body'?{innerText:async()=>{startedResolve();await blocked;return '首页';}}:original(selector);
  const abort=new AbortController(), running=f.collector.probe('douyin',{signal:abort.signal}), rejected=assert.rejects(running);
  await started;abort.abort(new Error('cancelled'));await f.collector.cancelOperation();
  assert.equal(root.isClosed(),false);assert.equal(root.closeCalls,0);unblock();await rejected;
  assert.equal(accountChecks,0);assert.equal(f.collector.status().phase,'idle');
  root.locator=selector=>selector==='body'?{innerText:async()=>{f.contexts[0].emitClose();return '首页';}}:original(selector);
  assert.equal((await f.collector.probe('douyin')).state,'failed');
  assert.equal(accountChecks,0);assert.equal(f.allPages.length,1);assert.equal(f.collector.status().native_context_retained,false);
 }finally{unblock?.();await f.cleanup();}
});

test('a different site without its own native proof still gets the actual navigation probe',async()=>{
 const f=await retainedNativeFixture();
 try {
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();
  const root=f.allPages[0];assert.equal((await f.collector.probe('douhot')).state,'ready');
  assert.equal(f.allPages.length,2);assert.equal(f.allPages[1].url(),'https://douhot.douyin.com/square/hotspot?active_tab=hotspot_video&date_window=24&sub_type=1001');
  assert.equal(f.allPages[1].isClosed(),true);assert.equal(root.isClosed(),false);
 }finally{await f.cleanup();}
});

test('hotspot first-page response owns request epoch and preserves raw records with final consistency checks', async () => {
  for (const scenario of ['valid','empty-title','wrong-scope','wrong-page','wrong-dom-page','late-title','late-metric','late-failure','late-json','pending-late','old-unowned','cancel','body-scope-change','body-page-change','snapshot-url']) {
    const folder = await mkdtemp(join(tmpdir(), 'response-page-'));
    const abort = new AbortController();
    let url = '', closed = false, pageChecks = 0, rawDOMReads = 0, ignoredBodyReads = 0, currentRequest, raceInjected = false, domPage = 1;
    const handlers = new Map(), timers = [];
    const endpoint = 'https://douhot.douyin.com/douhot/v1/material/video_billboard';
    const raw = { item_id:'7697398053100633275', item_title:scenario==='empty-title'?'':' 实际标题 ', nick_name:' 作者 ', score:null, play_cnt:12345, like_cnt:300.25 };
    const request = (overrides={}) => ({url:()=>endpoint,postDataJSON:()=>({sub_type:1001,date_window:24,page:1,page_size:30,...overrides})});
    const emit = ({overrides={},fields={},code=0,delay=0,owned=true}={}) => {
      const sourceRequest=request(overrides); if(owned)handlers.get('request')?.(sourceRequest);currentRequest=sourceRequest;
      const response={url:()=>endpoint,status:()=>200,request:()=>sourceRequest,json:async()=>{
        if(!owned)ignoredBodyReads++;
        if(delay)await new Promise(resolve=>timers.push(setTimeout(resolve,delay)));
        const sourceRow={...raw,...fields};
        if(scenario.startsWith('body-')&&!raceInjected){
          Object.defineProperty(sourceRow,'score',{enumerable:false,get(){
            if(!raceInjected){raceInjected=true;emit({delay:5});timers.push(setTimeout(()=>{
              if(scenario==='body-scope-change'){const next=new URL(url);next.searchParams.set('date_window','72');url=next.href;}
              else domPage=2;
            },1));}
            return null;
          }});
        }
        return {code,data:{page:{page:overrides.page||1,page_size:30,total:30},objs:[sourceRow]}};
      }};
      handlers.get('response')?.(response);return sourceRequest;
    };
    const visible={first:()=>({waitFor:async()=>{}}),filter(){return this;},waitFor:async()=>{}};
    const page={url:()=>url,title:async()=>'热点宝',isClosed:()=>closed,close:async()=>{closed=true;},
      on:(event,fn)=>handlers.set(event,fn),off:event=>handlers.delete(event),
      goto:async value=>{
        url=value;
        if(scenario==='old-unowned')emit({owned:false,fields:{item_title:'OLD CONFLICT'}});
        emit({overrides:scenario==='wrong-scope'?{sub_type:1002}:scenario==='wrong-page'?{page:2}:{}});
        return {status:()=>200};
      },
      locator:selector=>{
        if(selector==='body')return {innerText:async()=>'视频总榜 实际内容'};
        if(selector==='[role="dialog"], [aria-modal="true"]')return {evaluateAll:async()=>[]};
        if(selector==='tbody tr')return {...visible,nth:()=>({evaluate:async()=>({titles:[],authors:[]})})};
        if(selector==='thead th'){rawDOMReads++;throw Error('must not read per-row metrics');}
        return visible;
      },
      evaluate:async fn=>{
        if(fn===observeScopeDOM)return {url,timeLabel:'近1天',boardLabel:'视频总榜',categoryLabel:'请选择垂类'};
        if(fn===observeCurrentRankingPageDOM || fn===observeFinalRankingScopeDOM){
          pageChecks++;
          if(pageChecks===1&&scenario==='late-json')emit({delay:5});
          if(pageChecks===2){
            if(scenario==='late-title')emit({fields:{item_title:'same-count changed title'}});
            if(scenario==='late-metric')emit({fields:{like_cnt:300.5}});
            if(scenario==='late-failure')emit({code:1});
            if(scenario==='pending-late')handlers.get('request')?.(request());
            if(scenario==='cancel')abort.abort(Error('cancelled during final scope check'));
          }
          const snapshot={url,timeLabel:new URL(url).searchParams.get('date_window')==='72'?'近3天':'近1天',boardLabel:'视频总榜',categoryLabel:'请选择垂类',next_disabled:true,page:scenario==='wrong-dom-page'?2:domPage};
          if(fn===observeFinalRankingScopeDOM&&scenario==='snapshot-url'){const next=new URL(url);next.searchParams.set('date_window','72');url=next.href;}
          return snapshot;
        }
        return {};
      },
      waitForEvent:async()=>{throw Error('must not open details');},
    };
    const collector=createAutomaticCollector({profileDir:folder,scopeResponseTimeoutMs:30,chromium:{launchPersistentContext:async()=>({newPage:async()=>page,close:async()=>{closed=true;}})}});
    try{
      const input={purpose:'hotspots',board:1001,hours:24,category:'all'};
      if(['valid','empty-title','late-json','old-unowned','snapshot-url'].includes(scenario)){
        const result=await collector.collect(input,{signal:abort.signal});
        const record=result.records[0];assert.equal(record.title,raw.item_title);assert.equal(record.author,raw.nick_name);
        assert.equal(record.like_count,300.25);assert.equal(record.play_count,12345);assert.equal(record.source_rank,null);
        assert.equal(record.page,1);assert.equal(record.position_in_response,1);assert.equal(record.source_endpoint,'douhot-page-response');
        assert.equal(record.metric_precision,'observed');assert.match(result.scope,/实际可访问分页/);
        assert.equal(new URL(record.observed_url).searchParams.get('date_window'),'24');
        assert.equal(ignoredBodyReads,0);
      }else{
        const expected=['wrong-scope','wrong-page'].includes(scenario)?/响应超时/:scenario==='wrong-dom-page'?/第1页/:scenario==='body-scope-change'?/筛选 date_window/:scenario==='body-page-change'?/当前页/:scenario==='late-failure'?/未成功|仍在变化或失败/:scenario==='pending-late'?/仍在变化/:scenario==='cancel'?/cancelled/:/有序记录或指标发生变化|仍在变化/;
        await assert.rejects(collector.collect(input,{signal:abort.signal}),expected);
      }
      assert.equal(rawDOMReads,0);assert.equal(closed,true);
      const early=new AbortController();early.abort(Error('new game request cancelled'));
      await assert.rejects(collector.collect({purpose:'game-research',keyword:'另一个游戏'},{signal:early.signal}),/new game request cancelled/);
      assert.deepEqual(collector.status().source_observations,[]);
    }finally{timers.forEach(clearTimeout);await collector.close();await rm(folder,{recursive:true,force:true});}
  }
});

test('unsupported topic/search boards diagnose only this page normal allowlisted responses and never return source records',async()=>{
 for(const [board,path] of [[2001,'/douhot/v1/material/challenge_billboard'],[3001,'/douhot/v1/dashboard/hot_search/query_list']]){
  const folder=await mkdtemp(join(tmpdir(),'ranking-diagnostic-'));const handlers=new Map();let url='',closed=false,bodyReads=0,oldReads=0,externalReads=0;
  const endpoint='https://douhot.douyin.com'+path;
  const emit=(address,owned=true)=>{
   const request={url:()=>address,postDataJSON:()=>({sub_type:board,date_window:24,page:1})};
   if(owned)handlers.get('request')?.(request);
   handlers.get('response')?.({url:()=>address,status:()=>200,request:()=>request,json:async()=>{
    if(!owned)oldReads++;else if(address!==endpoint)externalReads++;else bodyReads++;
    return {code:0,data:{objs:[{private_field:'DO_NOT_LOG_CONTENT'}],page:{page:1,page_size:30,total:1}}};
   }});
  };
  const visible={first(){return this;},waitFor:async()=>{}};
  const page={url:()=>url,isClosed:()=>closed,close:async()=>{closed=true;},title:async()=>'热点宝',frames:()=>[],
   on:(event,handler)=>handlers.set(event,handler),off:event=>handlers.delete(event),
   goto:async value=>{url=value;emit(endpoint,false);emit('https://evil.invalid'+path);emit(endpoint);return {status:()=>200};},
   locator:selector=>selector==='body'?{...visible,innerText:async()=>'公开榜单'}:selector==='[role="dialog"], [aria-modal="true"]'?{evaluateAll:async()=>[]}:visible,
   evaluate:async()=>({controls:[]}),waitForTimeout:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  };
  const context={pages:()=>[],newPage:async()=>page,close:async()=>{},on:()=>{}};
  const collector=createAutomaticCollector({profileDir:folder,responseTimeoutMs:10,chromium:{launchPersistentContext:async()=>context}});
  try{
   await assert.rejects(collector.collect({purpose:'hotspots',board,hours:24,category:'all'}),/公开页面适配尚未验证/);
   assert.equal(bodyReads,1);assert.equal(oldReads,0);assert.equal(externalReads,0);
   const evidence=collector.status().source_observations[0];
   assert.equal(evidence.responses[0].path,path);assert.equal(evidence.responses[0].count,1);
   assert.equal(evidence.progress.collected_count,0);assert.equal(evidence.stage,'failed');
   assert(!JSON.stringify(evidence).includes('DO_NOT_LOG_CONTENT'));
  }finally{await collector.close();await rm(folder,{recursive:true,force:true});}
 }
});

async function retainedSearchFixture() {
 const f=await retainedNativeFixture(),payload={purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes'};
 await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();
 const previous=f.allPages[0];let page;
 f.setupNext(p=>{page=p;p.title=async()=>'验证码中间页';});
 await assert.rejects(f.collector.collect(payload),{code:'VERIFICATION_REQUIRED'});
 await f.collector.login('douyin');page.title=async()=>'搜索结果';
 await f.collector.verifyLogin('douyin');await f.collector.resume();
 await assert.rejects(f.collector.collect(payload),/结果更新信号尚未核验/);
 assert.equal(page.isClosed(),false);assert.equal(previous.isClosed(),true);
 return {...f,payload,page};
}
test('verified retained search reuses only the full exact scope, never a different game/time/sort',async()=>{
 const f=await retainedSearchFixture();
 try{
  const navigations=f.page.gotoCalls,total=f.allPages.length;
  let observations=0;const evaluate=f.page.evaluate;f.page.evaluate=async fn=>{if(fn.name==='observeGameFiltersDOM')observations++;return evaluate(fn);};
  for(let i=0;i<2;i++)await assert.rejects(f.collector.collect(f.payload),/结果更新信号尚未核验/);
  assert(observations>=4);assert.equal(f.page.gotoCalls,navigations);assert.equal(f.allPages.length,total);assert.equal(f.page.closeCalls,0);
  for(const change of [{keyword:'星际猎人'},{hours:24},{sort:'recent'}]){
   const before=f.allPages.length;
   await assert.rejects(f.collector.collect({...f.payload,...change}),{code:'SOURCE_FAILED'});
   assert.equal(f.allPages.length,before+1);const work=f.allPages.at(-1);
   assert.equal(work.gotoCalls,1);assert.equal(work.isClosed(),true);assert.equal(f.page.isClosed(),false);
  }
 }finally{await f.cleanup();}
});
test('closed, replaced-context and scope-drifted retained pages fail without reopening or navigating',async()=>{
 for(const changed of ['closed','context','keyword','type']){
  const f=await retainedSearchFixture();
  try{
   if(changed==='closed')await f.page.close();
   if(changed==='context')f.contexts[0].emitClose();
   if(changed==='keyword')await f.page.goto('https://www.douyin.com/search/其他游戏?type=video');
   if(changed==='type')await f.page.goto('https://www.douyin.com/search/率土之滨?type=live');
   const total=f.allPages.length,navigations=f.page.gotoCalls,launches=f.launches.length;
   await assert.rejects(f.collector.collect(f.payload),{code:['closed','context'].includes(changed)?'LOGIN_REQUIRED':'SOURCE_FAILED'});
   assert.equal(f.allPages.length,total);assert.equal(f.page.gotoCalls,navigations);assert.equal(f.launches.length,launches);
  }finally{await f.cleanup();}
 }
});
test('retained search cancellation closes its popup and preserves verified page without later automatic navigation',async()=>{
 const f=await retainedSearchFixture(),abort=new AbortController();
 try{
  const evaluate=f.page.evaluate;let popup;
  f.page.evaluate=async fn=>{if(fn.name==='observeGameFiltersDOM'&&!popup){popup=f.makePage();f.page.emit('popup',popup);abort.abort(Error('cancelled retained read'));}return evaluate(fn);};
  const navigations=f.page.gotoCalls;
  await assert.rejects(f.collector.collect(f.payload,{signal:abort.signal}),/cancelled/);
  assert(popup.isClosed());assert.equal(f.page.isClosed(),false);assert.equal(f.page.closeCalls,0);
  f.page.evaluate=evaluate;const total=f.allPages.length;
  await assert.rejects(f.collector.collect(f.payload),/结果更新信号尚未核验/);
  assert.equal(f.allPages.length,total);assert.equal(f.page.gotoCalls,navigations);
 }finally{await f.cleanup();}
});
test('retained search auth loss or renewed challenge cannot be mistaken for menu failure or new source success',async()=>{
 for(const challenge of [false,true]){
  const f=await retainedSearchFixture();
  try{
   const total=f.allPages.length,navigations=f.page.gotoCalls;
   if(challenge)f.page.title=async()=>'验证码中间页';
   else {const locator=f.page.locator;f.page.locator=selector=>selector==='body'?{innerText:async()=>'登录后继续'}:locator(selector);}
   await assert.rejects(f.collector.collect(f.payload),{code:challenge?'VERIFICATION_REQUIRED':'LOGIN_REQUIRED'});
   assert.equal(f.allPages.length,total);assert.equal(f.page.gotoCalls,navigations);assert.equal(f.page.isClosed(),false);
   if(challenge){assert.equal(f.collector.status().recovery_state,'waiting');await f.collector.login('douyin');assert.equal(f.page.isClosed(),false);}
   else await assert.rejects(f.collector.collect(f.payload),{code:'LOGIN_REQUIRED'});
   assert.equal(f.allPages.length,total);assert.equal(f.page.gotoCalls,navigations);
  }finally{await f.cleanup();}
 }
});
test('verifying a second game replaces and retires the one retained search reference',async()=>{
 const f=await retainedSearchFixture();
 try{
  const old=f.page,nextPayload={...f.payload,keyword:'星际猎人'};let next;
  f.setupNext(p=>{next=p;p.title=async()=>'验证码中间页';});
  await assert.rejects(f.collector.collect(nextPayload),{code:'VERIFICATION_REQUIRED'});
  await f.collector.login('douyin');next.title=async()=>'搜索结果';await f.collector.verifyLogin('douyin');await f.collector.resume();
  await assert.rejects(f.collector.collect(nextPayload),/结果更新信号尚未核验/);
  assert(old.isClosed());assert.equal(next.isClosed(),false);assert.equal(f.contexts[0].pages().length,1);
  assert.equal(f.collector.status().retained_search_scope_key,collectionRecoveryKey(nextPayload));
  const count=f.allPages.length,nav=next.gotoCalls;
  await assert.rejects(f.collector.collect(nextPayload),/结果更新信号尚未核验/);
  assert.equal(f.allPages.length,count);assert.equal(next.gotoCalls,nav);
 }finally{await f.cleanup();}
});

test('unrelated source errors after verification do not grant retained-search ownership',async()=>{
 const f=await retainedNativeFixture(),payload={purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes'};
 try{
  await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();
  const root=f.allPages[0];let page;
  f.setupNext(p=>{page=p;p.title=async()=>'验证码中间页';});
  await assert.rejects(f.collector.collect(payload),{code:'VERIFICATION_REQUIRED'});
  await f.collector.login('douyin');page.title=async()=>'搜索结果';await f.collector.verifyLogin('douyin');await f.collector.resume();
  const evaluate=page.evaluate;page.evaluate=async fn=>{if(fn.name==='observeGameFiltersDOM')throw Object.assign(Error('unrelated network failure'),{code:'SOURCE_FAILED'});return evaluate(fn);};
  await assert.rejects(f.collector.collect(payload),/unrelated network failure/);
  assert.equal(f.collector.status().retained_search_scope_key,null);assert.equal(root.isClosed(),false);assert.equal(page.isClosed(),true);
 }finally{await f.cleanup();}
});

test('first menu hover or click timeout after manual verification preserves the exact page for same-scope retries',async()=>{
 for(const action of ['hover','click']){
  const f=await retainedNativeFixture(),payload={purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes'};
  try{
   await f.collector.login('douyin');await f.collector.verifyLogin('douyin');await f.collector.resume();
   const root=f.allPages[0];let page;
   f.setupNext(p=>{page=p;p.title=async()=>'验证码中间页';});
   await assert.rejects(f.collector.collect(payload),{code:'VERIFICATION_REQUIRED'});
   await f.collector.login('douyin');page.title=async()=>'搜索结果';await f.collector.verifyLogin('douyin');await f.collector.resume();
   const evaluate=page.evaluate;
   page.evaluate=async fn=>fn.name==='observeGameFiltersDOM'?{url:page.url(),controls:[{label:'筛选',selection:null}]}:evaluate(fn);
   page.getByText=()=>({count:async()=>1,first:()=>({waitFor:async()=>{}}),nth:()=>({isVisible:async()=>true,
    hover:async()=>{if(action==='hover')throw Object.assign(Error('private timeout trace'),{name:'TimeoutError'});},
    click:async()=>{throw Object.assign(Error('private timeout trace'),{name:'TimeoutError'});}})});
   const total=f.allPages.length,navigations=page.gotoCalls;
   for(let retry=0;retry<2;retry++)await assert.rejects(f.collector.collect(payload),error=>error.code==='SOURCE_FAILED'&&error.diagnostics.menu_action.action===action);
   assert.equal(page.isClosed(),false);assert.equal(page.closeCalls,0);assert.equal(root.isClosed(),true);
   assert.equal(f.allPages.length,total);assert.equal(page.gotoCalls,navigations);
   assert.equal(f.collector.status().retained_search_scope_key,collectionRecoveryKey(payload));
  }finally{await f.cleanup();}
 }
});

test('late popups from finished retained collection close, while explicit same-session login OAuth descendants stay open',async()=>{
 const f=await retainedSearchFixture();
 try{
  for(let round=0;round<2;round++){
   const late=f.makePage();f.page.emit('popup',late);await new Promise(resolve=>setImmediate(resolve));
   assert.equal(late.isClosed(),true);assert.equal(f.page.isClosed(),false);
  }
  assert.equal(f.contexts[0].pages().length,1);
  await f.collector.login('douyin');
  const oauth=f.makePage();oauth.opener=async()=>f.page;f.page.emit('popup',oauth);
  const nested=f.makePage();nested.opener=async()=>oauth;oauth.emit('popup',nested);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(oauth.isClosed(),false);assert.equal(nested.isClosed(),false);assert.equal(f.page.isClosed(),false);
  // A login for another site is not permission for this old search to spawn.
  await f.collector.login('douhot');
  const unrelated=f.makePage();f.page.emit('popup',unrelated);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(unrelated.isClosed(),true);assert.equal(f.page.isClosed(),false);
 }finally{await f.cleanup();}
});

function configureFreshManualSearch(page){
 let phase=0;const actions=[];
 const cards=(start,date)=>Array.from({length:30},(_,i)=>({source_id:String(7000000000000000000n+BigInt(start+i)),text:`00:30\n12\n公开游戏标题${start+i}\n@公开作者\n${date}`}));
 const oldEvaluate=page.evaluate;
 page.evaluate=async(fn,args)=>{
  if(fn.name!=='observeGameFiltersDOM')return oldEvaluate(fn,args);
  return {url:page.url(),controls:[{label:'最多点赞'},{label:'一周内'}],truncated:false,cards_overflow:false,card_conflicts:[],
   cards:phase===2?cards(100,'1小时前'):phase===1?cards(1,'1年前').reverse():cards(1,'1年前'),
   groups:{sort:{title:'排序依据',selected:phase?'最多点赞':'综合排序',options:['综合排序','最新发布','最多点赞'].map(label=>({label}))},
    time:{title:'发布时间',selected:phase===2?'一周内':'不限',options:['不限','一天内','一周内','半年内'].map(label=>({label}))}}};
 };
 page.evaluateHandle=async()=>({dispose:async()=>{}});
 page.waitForTimeout=async()=>{};
 page.getByText=label=>({count:async()=>1,nth:()=>({isVisible:async()=>true,click:async()=>{actions.push(label);phase=label==='最多点赞'?1:2;}})});
 return {actions};
}
test('manually searched verified dedicated page is read twice without navigation, replacement or closing',async()=>{
 const f=await retainedNativeFixture(),payload={purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes'};
 try{
  await f.collector.login('douyin');const page=f.allPages[0];
  await page.goto('https://www.douyin.com/search/率土之滨?type=video');
  await f.collector.verifyLogin('douyin');await f.collector.resume();
  const count=f.allPages.length,nav=page.gotoCalls;
  for(let i=0;i<2;i++)await assert.rejects(f.collector.collect(payload),/结果更新信号尚未核验/);
  assert.equal(f.allPages.length,count);assert.equal(page.gotoCalls,nav);assert.equal(page.closeCalls,0);
  assert.equal(f.collector.status().retained_search_scope_key,collectionRecoveryKey(payload));
 }finally{await f.cleanup();}
});
test('manually searched verified page can complete full fresh filtering and remains protected after success',async()=>{
 const f=await retainedNativeFixture(),payload={purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes',limit:30};
 try{
  await f.collector.login('douyin');const page=f.allPages[0];await f.collector.verifyLogin('douyin');await f.collector.resume();
  await page.goto('https://www.douyin.com/search/率土之滨?type=video'); // normal manual navigation after proof
  const count=f.allPages.length,nav=page.gotoCalls,model=configureFreshManualSearch(page);
  const result=await f.collector.collect(payload);assert.equal(result.records.length,30);
  assert.deepEqual(model.actions,['最多点赞','一周内']);assert.equal(result.collection_batches.length,1);
  assert.equal(f.allPages.length,count);assert.equal(page.gotoCalls,nav);assert.equal(page.closeCalls,0);
  await assert.rejects(f.collector.collect(payload),/本轮选项已相同/);
  assert.equal(f.allPages.length,count);assert.equal(page.gotoCalls,nav);assert.equal(page.closeCalls,0);
 }finally{await f.cleanup();}
});
test('manual reuse ignores unverified, unrelated and wrong-type pages instead of borrowing their ownership',async()=>{
 for(const variant of ['unverified','unrelated','wrong-type','duplicate-type','other-game']){
  const f=await retainedNativeFixture(),payload={purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes'};
  try{
   await f.collector.login('douyin');const root=f.allPages[0];
   if(variant!=='unverified')await f.collector.verifyLogin('douyin');await f.collector.resume();
   let candidate=root;
   if(variant==='unrelated')candidate=f.makePage();
   await candidate.goto('https://www.douyin.com/search/'+(variant==='other-game'?'星际猎人':'率土之滨')+'?'+(variant==='wrong-type'?'type=user':variant==='duplicate-type'?'type=video&type=video':'type=video'));
   const count=f.allPages.length,nav=candidate.gotoCalls;
   await assert.rejects(f.collector.collect(payload),{code:'SOURCE_FAILED'});
   assert.equal(f.allPages.length,count+(variant==='unverified'?2:1));assert.equal(candidate.gotoCalls,nav);
   assert.equal(f.collector.status().retained_search_scope_key,null);
  }finally{await f.cleanup();}
 }
});
test('manual navigation to a different requested game replaces the same retained page without tab growth',async()=>{
 const f=await retainedSearchFixture();try{
  const next={...f.payload,keyword:'星际猎人'};
  await f.page.goto('https://www.douyin.com/search/星际猎人?type=video');
  const count=f.allPages.length,nav=f.page.gotoCalls;
  await assert.rejects(f.collector.collect(next),/结果更新信号尚未核验/);
  assert.equal(f.allPages.length,count);assert.equal(f.page.gotoCalls,nav);assert.equal(f.page.closeCalls,0);
  assert.equal(f.collector.status().retained_search_scope_key,collectionRecoveryKey(next));
 }finally{await f.cleanup();}
});
test('manual adopted page cancellation closes owned popups and preserves the user page',async()=>{
 const f=await retainedNativeFixture(),abort=new AbortController(),payload={purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes'};
 try{
  await f.collector.login('douyin');const page=f.allPages[0];await f.collector.verifyLogin('douyin');await f.collector.resume();
  await page.goto('https://www.douyin.com/search/率土之滨?type=video');const nav=page.gotoCalls,read=page.evaluate;let popup;
  page.evaluate=async(fn,args)=>{if(fn.name==='observeGameFiltersDOM'&&!popup){popup=f.makePage();page.emit('popup',popup);abort.abort(Error('manual cancelled'));}return read(fn,args);};
  await assert.rejects(f.collector.collect(payload,{signal:abort.signal}),/manual cancelled/);
  assert(popup.isClosed());assert.equal(page.closeCalls,0);assert.equal(page.gotoCalls,nav);
 }finally{await f.cleanup();}
});

test('manual adopted search still pauses on renewed verification or revoked login without closing the user page',async()=>{
 for(const challenge of [false,true]){
  const f=await retainedNativeFixture(),payload={purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes'};
  try{
   await f.collector.login('douyin');const page=f.allPages[0];await f.collector.verifyLogin('douyin');await f.collector.resume();
   await page.goto('https://www.douyin.com/search/率土之滨?type=video');
   const count=f.allPages.length,nav=page.gotoCalls;
   if(challenge)page.title=async()=>'验证码中间页';
   else{const locator=page.locator;page.locator=selector=>selector==='body'?{innerText:async()=>'登录后继续'}:locator(selector);}
   await assert.rejects(f.collector.collect(payload),{code:challenge?'VERIFICATION_REQUIRED':'LOGIN_REQUIRED'});
   assert.equal(f.allPages.length,count);assert.equal(page.gotoCalls,nav);assert.equal(page.closeCalls,0);
   if(challenge)assert.equal(f.collector.status().recovery_state,'waiting');
   else await assert.rejects(f.collector.collect(payload),{code:'LOGIN_REQUIRED'});
  }finally{await f.cleanup();}
 }
});
