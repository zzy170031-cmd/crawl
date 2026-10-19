import { mkdir } from "node:fs/promises";
import { parseSearchCard } from "./search-card.mjs";
export { visibleNumber, videoIdentity, parseSearchCard } from "./search-card.mjs";
import { applyGameSearchFilters, classifyGamePublication, fingerprintGameCards, diagnosticGameSnapshot } from "./game-search-scope.mjs";
import { collectionRecoveryKey } from "./collection-recovery.mjs";
import { observeRankingPaginationDOM } from "./ranking-pagination.mjs";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { chromium as defaultChromium } from "playwright-core";
import { settleObservedResponses } from "./observed-ranking-identities.mjs";
import { parseObservedRankingPage, observeCurrentRankingPageDOM, observeFinalRankingScopeDOM, waitForObservedRankingPage, createRankingRequestEpoch, createPublicRankingDiagnosticEpoch, waitForRankingEpochIdle, createRankingTraversal, paceRankingClick, scopedRankingReads } from "./observed-ranking-page.mjs";
import {
  categories,
  resolveCategory,
  collectionTargets,
} from "./categories.mjs";

const BOARDS = {
  1001: "视频总榜",
  1002: "低粉爆款",
  1003: "高完播率",
  1004: "高涨粉率",
  1005: "高点赞率",
  2001: "话题榜",
  2002: "飙升话题",
  3001: "搜索榜",
  3002: "飙升搜索",
};
const HOURS = { 1: "近1小时", 24: "近1天", 72: "近3天", 168: "近7天" };
const RANKING_PATHS = new Set([
  "/douhot/v1/material/video_billboard",
  "/douhot/v1/material/challenge_billboard",
  "/douhot/v1/dashboard/hot_search/query_list",
]);
// Only normal page-emitted public ranking responses are diagnosed. This does
// not replay requests, export credentials or accept the legacy schema as data.
export function describeRankingResponse(url, request, body, status) {
  const u = new URL(url);
  if (u.origin !== "https://douhot.douyin.com" || !RANKING_PATHS.has(u.pathname)) return null;
  const keys = (value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).filter((key) => /^[a-zA-Z_][a-zA-Z_0-9]{0,60}$/.test(key)).slice(0, 60) : [];
  const numeric = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const data = body?.data;
  const listKey = ["objs", "search_list"].find((key) => Array.isArray(data?.[key]));
  const rows = listKey ? data[listKey] : [];
  const paging = {};
  for (const key of ["total", "total_count", "page", "page_num", "page_size", "has_more", "next_cursor", "cursor"])
    if (data && Object.hasOwn(data, key))
      paging[key] = ["number", "boolean"].includes(typeof data[key]) ? data[key] : { type: typeof data[key] };
  return {
    path: u.pathname,
    status,
    request_schema: Object.fromEntries(keys(request).map((key) => [key, Array.isArray(request[key]) ? "array" : typeof request[key]])),
    request: {
      sub_type: numeric(request?.sub_type), date_window: numeric(request?.date_window),
      page: numeric(request?.page), page_num: numeric(request?.page_num), page_size: numeric(request?.page_size),
      tags: Array.isArray(request?.tags) ? request.tags.slice(0, 40).map((tag) => ({
        value: numeric(tag?.value),
        ...(Array.isArray(tag?.children) ? { children: tag.children.slice(0, 40).map((child) => ({ value: numeric(child?.value) })) } : {}),
      })) : null,
    },
    ...(data?.page && typeof data.page === "object" && !Array.isArray(data.page) ? {
      page_object: Object.fromEntries(keys(data.page).slice(0,20).map(key=>[key, ["number","boolean"].includes(typeof data.page[key]) ? data.page[key] : {type:typeof data.page[key]}]))
    } : {}),
    code: numeric(body?.code), response_keys: keys(body), data_keys: keys(data),
    list_key: listKey || null, count: rows.length,
    first_row_schema: Object.fromEntries(keys(rows[0]).map((key) => [key, Array.isArray(rows[0][key]) ? "array" : typeof rows[0][key]])),
    paging,
  };
}
const SITES = {
  douyin: "https://www.douyin.com/",
  douhot:
    "https://douhot.douyin.com/square/hotspot?active_tab=hotspot_video&date_window=24&sub_type=1001",
};
export class CollectionError extends Error {
  constructor(code, message, site) {
    super(message);
    this.name = "CollectionError";
    this.code = code;
    this.site = site;
  }
}
const failure = (message, site) =>
  new CollectionError("SOURCE_FAILED", message, site);
const checkAbort = (signal) => {
  if (signal?.aborted) throw signal.reason || new Error("采集已取消");
};
export function hotspotURL({ board, hours, category }) {
  const selected = resolveCategory(category);
  const u = new URL("https://douhot.douyin.com/square/hotspot");
  u.searchParams.set(
    "active_tab",
    board < 2000
      ? "hotspot_video"
      : board < 3000
        ? "hotspot_topic"
        : "hotspot_search",
  );
  u.searchParams.set("date_window", hours);
  u.searchParams.set("sub_type", board);
  if (selected) {
    const [parent, child] = selected.id.split("/").map(Number);
    u.searchParams.set("first_tag", parent);
    // Parent selection must use the current visible source directory, not
    // seed obsolete children from our local category catalog into the page.
    if (child) u.searchParams.set("second_tag", child);
  }
  return u.href;
}
export function assertObservedScope(expected, actual) {
  const category = resolveCategory(expected.category);
  if (category && !category.id.includes("/") &&
      (!Array.isArray(actual.expectedChildIds) || !actual.expectedChildIds.length))
    throw failure("未取得来源实际子行业目录，不能确认父行业范围", "douhot");
  const requested = new URL(hotspotURL(expected)),
    url = new URL(actual.url);
  for (const key of ["active_tab", "date_window", "sub_type", "first_tag"])
    if (
      (url.searchParams.get(key) || "") !==
      (requested.searchParams.get(key) || "")
    )
      throw failure(`热点宝未应用筛选 ${key}`, "douhot");
  const sorted = (u) =>
    (u.searchParams.get("second_tag") || "")
      .split("x")
      .filter(Boolean)
      .sort()
      .join(",");
  if (
    sorted(url) !==
    (actual.expectedChildIds
      ? [...actual.expectedChildIds].map(String).sort().join(",")
      : sorted(requested))
  )
    throw failure("热点宝未应用全部请求子行业", "douhot");
  if (!actual.timeLabel?.replaceAll(" ", "").includes(HOURS[expected.hours]))
    throw failure("未确认热点宝页面实际时间筛选", "douhot");
  if (!actual.boardLabel?.includes(BOARDS[expected.board]))
    throw failure("未确认热点宝页面实际榜单", "douhot");
  const label = resolveCategory(expected.category)?.label.split(" / ")[0];
  if (label && !actual.categoryLabel?.includes(label))
    throw failure("未确认热点宝页面实际行业筛选", "douhot");
  if (
    !label &&
    actual.categoryLabel &&
    !/不限|全部|请选择/.test(actual.categoryLabel)
  )
    throw failure("热点宝仍保留行业筛选", "douhot");
  return true;
}
function chromePath() {
  const paths =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [
            join(
              process.env.PROGRAMFILES || "C:/Program Files",
              "Google/Chrome/Application/chrome.exe",
            ),
            join(
              process.env.LOCALAPPDATA || "",
              "Google/Chrome/Application/chrome.exe",
            ),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  return process.env.CRAWL_CHROME_PATH || paths.find(existsSync);
}

// The SMS code is a login credential step, not by itself a CAPTCHA challenge.
export function classifySourceAccess({ text = "", title = "", url = "", dialogs = [], visibleFrame = false }) {
  // This exact visible embedded challenge was observed without body markers.
  // A generic “验证码” title, including an SMS login form, is insufficient.
  if (visibleFrame && title.trim() === "验证码") {
    try {
      const frameURL = new URL(url);
      if (frameURL.origin === "https://rmc.bytedance.com" &&
          frameURL.pathname === "/verifycenter/captcha/v2")
        return "VERIFICATION_REQUIRED";
    } catch { /* Invalid URLs provide no challenge evidence. */ }
  }
  if (
    /验证码中间页|安全验证|人机验证/.test(title) ||
    /拖动滑块|安全验证|验证身份|完成验证|访问过于频繁|403 Forbidden|Access Denied|图形验证码|图片验证码|请按顺序点击|请完成拼图/.test(
      text,
    )
  )
    return "VERIFICATION_REQUIRED";
  if (
    /\/passport\/|\/oauth\/|\/login(?:[/?]|$)/.test(url) ||
    /登录后(?:查看|使用|继续)|请先登录/.test(text) ||
    dialogs.some((x) => /扫码登录|短信登录|验证码登录/.test(x)) ||
    (/手机号|手机号码/.test(text) &&
      /获取(?:短信)?验证码/.test(text) &&
      /登录|注册/.test(text))
  )
    return "LOGIN_REQUIRED";
  return null;
}

export function associatedCategoryLabel(input) {
  const wrapper = input.closest("label");
  const labels = [...new Set([...(input.labels || []), wrapper?.control === input ? wrapper : null].filter(Boolean))];
  const usable = labels.filter(label => {
    const rect = label.getBoundingClientRect();
    return label.getClientRects().length && rect.width > 0 && rect.height > 0 &&
      !label.disabled && label.getAttribute("aria-disabled") !== "true";
  });
  return usable.length === 1 ? usable[0] : null;
}

export function observeRankingIdentityRowDOM(node) {
  const cells = [...node.querySelectorAll("td")];
  const describe = (selector, limit) => [...node.querySelectorAll(selector)].slice(0, 5).map(element => {
    const visible = Boolean(element.getClientRects().length);
    return { tag: element.tagName.toLowerCase(), class: String(element.getAttribute("class") || "").slice(0, 160),
      cell: cells.findIndex(cell => cell.contains(element)), visible,
      text: visible ? (element.innerText || "").trim().slice(0, limit) : "" };
  });
  return { titles: describe('[class*="text___"]', 200), authors: describe('[class*="video-nick"]', 100) };
}

export function observeCategoryCheckboxDOM(input) {
  const geometry = node => {
    const rect = node.getBoundingClientRect();
    return Object.fromEntries(["x", "y", "width", "height"].map(key => [key,
      Number.isFinite(rect[key]) ? Math.round(Math.max(-1000000, Math.min(1000000, rect[key])) * 10) / 10 : null]));
  };
  const structure = node => ({
    tag: /^[A-Z]{1,20}$/.test(node.tagName) ? node.tagName : null,
    class: String(node.getAttribute("class") || "").split(/\s+/).filter(value => /^[a-zA-Z0-9_-]{1,80}$/.test(value)).slice(0, 8).join(" ").slice(0, 200),
    visible: Boolean(node.getClientRects().length), disabled: Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true",
    geometry: geometry(node),
  });
  const wrapper = input.closest("label");
  const labels = [...new Set([...(input.labels || []), wrapper?.control === input ? wrapper : null].filter(Boolean))];
  return { input: { ...structure(input), value: /^\d{1,10}$/.test(input.value) ? input.value : null, checked: Boolean(input.checked) }, labels: labels.slice(0, 8).map(structure), labels_truncated: labels.length > 8 };
}

export async function setCategoryCheckbox(input, desired) {
  let handle, method = "inspect", reason;
  try {
    if (await input.isChecked({ timeout: 15000 }) === desired) return;
    handle = await input.evaluateHandle(associatedCategoryLabel);
    const label = handle.asElement();
    method = label ? "associated_label" : "input_set_checked";
    if (label) await label.click({ timeout: 15000 });
    else await input.setChecked(desired, { timeout: 15000 });
    if (await input.isChecked({ timeout: 15000 }) !== desired) {
      reason = "checked_state_mismatch";
      throw Error(reason);
    }
  } catch (cause) {
    const message = String(cause.message || "");
    reason ||= /intercept|pointer events/i.test(message) ? "interception"
      : /not visible|hidden/i.test(message) ? "hidden"
      : /outside.*viewport|out.*viewport/i.test(message) ? "outside_viewport"
      : /disabled|not enabled/i.test(message) ? "disabled"
      : /detached|not attached/i.test(message) ? "detached"
      : /timeout/i.test(message) ? "timeout" : "action_failed";
    const error = failure(`来源行业复选框操作未完成（${reason}）`, "douhot");
    error.checkbox_diagnostic = { method, desired, reason,
      structure: await input.evaluate(observeCategoryCheckboxDOM).catch(() => ({ unavailable: true })) };
    throw error;
  } finally { await handle?.dispose().catch(() => {}); }
}

// Browser-evaluated diagnostic only: preserve category selection evidence,
// never input contents, account labels, arbitrary URL parameters or full HTML.
export function observeCategorySelectionDOM({ parent, expected = [] }) {
  const prefix = String(parent);
  const safeValue = (value) => /^\d{1,10}$/.test(String(value));
  const visible = (node) => Boolean(node.getClientRects().length);
  const boxes = /^\d{1,10}$/.test(prefix)
    ? [...document.querySelectorAll(`input[type="checkbox"][value^="${prefix}"]`)].slice(0, 64)
    : [];
  const checkboxes = boxes.filter((node) => safeValue(node.value)).map((node) => ({
    value: node.value, checked: Boolean(node.checked), indeterminate: Boolean(node.indeterminate), visible: visible(node),
  }));
  const url_scope = {};
  const params = new URL(location.href).searchParams;
  for (const key of ["sub_type", "date_window", "first_tag", "second_tag"]) {
    const value = params.get(key);
    if (value !== null && /^\d{1,10}(?:x\d{1,10}){0,63}$/.test(value)) url_scope[key] = value;
  }
  const allowed = new Set(["确定", "确认", "应用", "取消", "清空", "重置"]);
  const controls = [...document.querySelectorAll('button, [role="button"]')].slice(0, 200)
    .filter(visible).map((node) => (node.innerText || node.textContent || "").trim())
    .filter((text) => allowed.has(text)).slice(0, 12);
  return { parent: safeValue(prefix) ? prefix : null, expected: expected.filter(safeValue).map(String).slice(0, 64), checkboxes, url_scope, controls };
}

// Browser-evaluated, self-contained DOM observer. Only checked visible tags
// constitute time evidence; a URL or unselected adjacent option is insufficient.
export function observeScopeDOM() {
  const visible = (n) => n && n.getClientRects().length;
  const combos = [...document.querySelectorAll('[role="combobox"]')]
    .filter(visible)
    .map((n) => n.innerText || n.textContent || "");
  // The live video boards and time ranges are checkable Arco tags. A sibling
  // label or an unrelated active navigation container is not selection proof.
  const checkedTags = [...document.querySelectorAll(".arco-tag-checked")]
    .filter(visible)
    .map((n) => (n.innerText || n.textContent || "").replace(/\s/g, ""));
  const checkedTimes = checkedTags.filter((x) => /^近\d+(?:天|小时)$/.test(x));
  const checkedBoards = checkedTags.filter((x) => /^(?:视频总榜|低粉爆款|高完播率|高涨粉率|高点赞率)$/.test(x));
  return {
    url: location.href,
    timeLabel: checkedTimes.join(" "),
    categoryLabel: combos
      .filter((x) => !/近.*[天时]|条\/页|每页/.test(x))
      .join(" "),
    boardLabel: checkedBoards.join(" "),
  };
}

// Failure diagnostics contain public UI structure only, never account text,
// form values, cookies, page HTML or arbitrary visible prose.
export function observeCollectionStructureDOM() {
  const visible = (n) => Boolean(n?.getClientRects().length);
  const shape = (n) => ({
    tag: n.tagName?.toLowerCase() || "",
    class: String(n.getAttribute?.("class") || "").slice(0, 180),
    role: n.getAttribute?.("role") || null,
    e2e: String(n.getAttribute?.("data-e2e") || "").slice(0, 100),
    selected: n.getAttribute?.("aria-selected") || null,
    checked: n.getAttribute?.("aria-checked") || null,
  });
  const ancestors = (n) => {
    const result = [];
    for (let i = 0; n && i < 4; i++, n = n.parentElement) result.push(shape(n));
    return result;
  };
  const labels = /^(?:视频总榜|低粉爆款|高完播率|高涨粉率|高点赞率|话题榜|飙升话题|搜索榜|飙升搜索|近1小时|近1天|近3天|近7天|视频|综合|筛选|排序|综合排序|最新发布|最多点赞|发布时间|不限|一天内|一周内|一个月内|半年内)$/;
  const nodes = [...document.querySelectorAll("body *")].filter(visible);
  const controls = nodes.filter((n) => labels.test((n.innerText || n.textContent || "").trim()) &&
    ![...n.querySelectorAll("*")].some(child => visible(child) && (child.innerText || child.textContent || "").trim() === (n.innerText || n.textContent || "").trim())).slice(0, 24)
    .map((n) => ({ label: (n.innerText || n.textContent).trim(), ancestors: ancestors(n) }));
  const durations = nodes.filter((n) => !n.children.length && /^\d{1,2}:\d{2}(?::\d{2})?$/.test((n.innerText || n.textContent || "").trim()))
    .slice(0, 5).map(ancestors);
  const links = [...document.querySelectorAll("a[href]")].filter(visible);
  const count = (selector) => [...document.querySelectorAll(selector)].filter(visible).length;
  const bodyText = document.body?.innerText || "";
  const publicMarkers = [
    "加载中", "正在加载", "网络异常", "网络错误", "网络不给力", "页面加载失败",
    "系统繁忙", "服务异常", "请刷新", "请重试", "暂无数据", "暂无内容", "暂无结果",
    "安全验证", "验证身份", "完成验证", "拖动滑块", "访问过于频繁",
    "请先登录", "登录后查看", "登录后使用", "登录后继续", "扫码登录", "短信登录",
    "手机号", "获取验证码", "页面不存在", "系统错误", "服务不可用", "抖音", "热点宝",
  ].filter((label) => bodyText.includes(label));
  const isDouhot = location.hostname === "douhot.douyin.com";
  const publicTable = isDouhot ? {
    headers: [...document.querySelectorAll("thead th")].filter(visible).slice(0, 16)
      .map((n) => (n.innerText || n.textContent || "").trim().slice(0, 100)),
    checked_tags: [...document.querySelectorAll(".arco-tag-checkable")].filter(visible).slice(0, 24)
      .map((n) => ({ label: (n.innerText || n.textContent || "").trim().slice(0, 40), ...shape(n) })),
    totals: nodes.filter((n) => !n.children.length && /^(?:共|总共|总计)?\s*\d+\s*条(?:数据|记录)?$/.test((n.innerText || n.textContent || "").trim()))
      .slice(0, 5).map((n) => ({ label: (n.innerText || n.textContent).trim(), ancestors: ancestors(n) })),
    pagination: nodes.filter((n) => {
      for (let p = n, i = 0; p && i < 4; i++, p = p.parentElement)
        if (/pagination/i.test(p.getAttribute?.("class") || "")) return true;
      return false;
    }).filter((n) => n.getAttribute?.("role") === "button" || n.tagName === "BUTTON" || !n.children.length)
      .slice(0, 40).map((n) => {
        const label = (n.innerText || n.textContent || "").trim();
        return { ...shape(n),
          label: /^(?:\d+|[<>…]+|上一页|下一页|首页|末页|跳至|页|每页\s*\d+\s*条|\d+\s*条\/页)$/.test(label) ? label : null,
          aria_label: /previous|next|page|上一页|下一页|分页/i.test(n.getAttribute?.("aria-label") || "") ? String(n.getAttribute("aria-label")).slice(0, 80) : null,
          disabled: Boolean(n.disabled) || n.getAttribute?.("aria-disabled") === "true",
        };
      }),
  } : null;
  return {
    host: location.hostname,
    path: location.pathname.startsWith("/search/") ? "/search/:keyword" : location.pathname,
    title: String(document.title || "").slice(0, 160),
    ready_state: document.readyState || null,
    body_text_length: bodyText.length,
    public_markers: publicMarkers,
    visible_elements: nodes.length,
    visible_main: count("main"),
    visible_iframes: count("iframe"),
    iframe_elements: [...document.querySelectorAll("iframe")].filter(visible).slice(0, 5).map((n) => {
      let src;
      try { const u = new URL(n.getAttribute("src") || "", location.href); src = { host: u.hostname, path: u.pathname }; } catch { src = null; }
      return { ...shape(n), title: String(n.getAttribute("title") || "").slice(0, 120), source: src };
    }),
    visible_video: count("video"),
    visible_video_links: links.filter((n) => /\/video\/\d{10,25}/.test(n.getAttribute("href") || "")).length,
    visible_note_links: links.filter((n) => /\/note\/\d{10,25}/.test(n.getAttribute("href") || "")).length,
    visible_result_rows: count("tbody tr"),
    visible_combos: count('[role="combobox"]'),
    controls,
    duration_ancestors: durations,
    ...(publicTable ? { table: publicTable } : {}),
  };
}

// Opening the own-account menu is read-only. Never click the logout item.
// Public result rows and hidden account DOM nodes are not session evidence.
export async function confirmOwnAccount(page, site, timeoutMs = 10000) {
  async function visibleMatches(locator) {
    const matches = [];
    for (let i = 0, count = await locator.count(); i < count; i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible()) matches.push(candidate);
    }
    return matches;
  }
  async function onlyVisible(locator) {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {});
    const matches = await visibleMatches(locator);
    return matches.length === 1 ? matches[0] : null;
  }
  const logout = page.getByText(site === "douhot" ? "退出帐号" : "退出登录", {exact:true});
  const alreadyOpen = await visibleMatches(logout);
  // The user may already have hovered/opened the account menu. Never toggle it
  // closed or click its logout action. A hidden template is not evidence.
  if (alreadyOpen.length > 1)
    throw new CollectionError("LOGIN_REQUIRED", "未确认唯一可见的本人账号退出菜单，登录状态未通过核验", site);
  let avatar;
  if (site === "douhot")
    avatar = await onlyVisible(page.getByRole("img", { name: "avatar", exact: true }));
  else {
    avatar = await onlyVisible(page.locator('[data-e2e="user-avatar"]'));
    if (!avatar) avatar = await onlyVisible(page.locator('[data-e2e="user-info"]'));
    if (!avatar) {
      const images = page.locator("img");
      const candidates = await images.evaluateAll(nodes => nodes.flatMap((node,index) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const ratio = rect.width / rect.height;
        return node.getClientRects().length && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0 &&
          rect.width >= 20 && rect.width <= 64 && rect.height >= 20 && rect.height <= 64 && ratio >= 0.8 && ratio <= 1.25 &&
          rect.top >= 0 && rect.bottom <= 120 && rect.left >= innerWidth * 0.75 && rect.right <= innerWidth && innerWidth - rect.right <= 120
          ? [index] : [];
      }));
      if (candidates.length === 1) {
        const candidate = images.nth(candidates[0]);
        if (await candidate.isVisible()) avatar = candidate;
      }
    }
  }
  if (!avatar)
    throw new CollectionError("LOGIN_REQUIRED", "尚未确认可见的本人账号入口，请保留专用窗口并将鼠标移到右上角本人头像后再次确认", site);
  if (alreadyOpen.length === 1) return true;
  // Douyin opens the account menu on hover; clicking can navigate to a profile.
  // Geometry only locates a candidate and never establishes authentication.
  if (site === "douyin") await avatar.hover({timeout:timeoutMs});
  else await avatar.click({timeout:timeoutMs});
  if (!(await onlyVisible(logout)))
    throw new CollectionError("LOGIN_REQUIRED", "本人账号菜单尚未显示唯一可见的退出入口，请保留窗口并完成登录后再次确认", site);
  return true;
}

const LOGIN_HOSTS = new Set([
  "www.douyin.com",
  "douhot.douyin.com",
  "open.douyin.com",
  "passport.douyin.com",
]);
const LOGIN_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);
function allowedLoginURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      LOGIN_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
      ? url
      : null;
  } catch {
    return null;
  }
}
export function validateLoginInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw failure("登录输入格式无效");
  const keys = Object.keys(input).sort().join(",");
  if (
    input.type === "click" &&
    keys === "type,x,y" &&
    Number.isFinite(input.x) &&
    Number.isFinite(input.y) &&
    input.x >= 0 &&
    input.x < 1440 &&
    input.y >= 0 &&
    input.y < 1000
  )
    return input;
  if (
    input.type === "pointer" &&
    keys === "phase,type,x,y" &&
    ["down", "move", "up"].includes(input.phase) &&
    Number.isFinite(input.x) &&
    input.x >= 0 &&
    input.x < 1440 &&
    Number.isFinite(input.y) &&
    input.y >= 0 &&
    input.y < 1000
  )
    return input;
  if (
    input.type === "drag" &&
    keys === "fromX,fromY,toX,toY,type" &&
    [input.fromX, input.toX].every(
      (x) => Number.isFinite(x) && x >= 0 && x < 1440,
    ) &&
    [input.fromY, input.toY].every(
      (y) => Number.isFinite(y) && y >= 0 && y < 1000,
    )
  )
    return input;
  if (
    input.type === "scroll" &&
    keys === "deltaY,type" &&
    Number.isFinite(input.deltaY) &&
    Math.abs(input.deltaY) <= 2000
  )
    return input;
  if (
    input.type === "text" &&
    keys === "text,type" &&
    typeof input.text === "string" &&
    input.text.length > 0 &&
    input.text.length <= 2000 &&
    !/[\u0000-\u001F\u007F]/.test(input.text) &&
    !/^(?:https?:|file:|javascript:|data:|chrome:|about:|www\.)/i.test(
      input.text.trim(),
    )
  )
    return input;
  if (input.type === "key" && keys === "key,type" && LOGIN_KEYS.has(input.key))
    return input;
  throw failure("登录输入超出允许范围");
}

export function createAutomaticCollector(options = {}) {
  const profileDir = resolve(options.profileDir || "data/collector-profile");
  const engine = options.chromium || defaultChromium;
  const presentation =
    options.loginPresentation === "panel" ? "panel" : "native";
  let context = null,
    opening = null,
    mode = "closed",
    site = null,
    phase = "idle",
    lastError = null,
    sourceObservations = [],
    epoch = 0,
    loginRoot = null,
    loginKnown = new WeakSet(),
    loginPopupParents = new WeakSet(),
    nativeContext = false,
    nativeProofs = new Map(),
    protectedPages = new Map(),
    pendingChallenge = null,
    retainedNativeSearch = null,
    pageOwners = new WeakMap(),
    activeOperation = null,
    pointerPage = null,
    closing = null;
  const retainedNative = () => Boolean(context && nativeContext && [...nativeProofs.values()].some(
    (proof) => proof.context === context && proof.epoch === epoch && !proof.page.isClosed(),
  ));
  const challengeCurrent = (value = pendingChallenge) => Boolean(value && value.context === context && value.epoch === epoch && nativeContext && !value.page.isClosed());
  const isProtectedPage = page => [...protectedPages.values()].includes(page) ||
    Boolean(pendingChallenge && (pendingChallenge.page === page || pendingChallenge.previousPage === page));
  function sameSearchPage(page, keyword) {
    try {
      const url = new URL(page.url());
      return url.origin === "https://www.douyin.com" && url.pathname.startsWith("/search/") &&
        decodeURIComponent(url.pathname.slice(8)).normalize("NFKC").trim() === keyword &&
        url.searchParams.getAll("type").length === 1 && url.searchParams.get("type") === "video";
    } catch { return false; }
  }
  function assertRetainedSearch(value) {
    if (value !== retainedNativeSearch || value.context !== context || value.epoch !== epoch ||
        targetNativeProof("douyin")?.page !== value.page || value.page.isClosed())
      throw new CollectionError("LOGIN_REQUIRED", "已验证搜索页已关闭或登录证明失效，请确认连接；未自动重开来源", "douyin");
    if (!sameSearchPage(value.page,value.keyword))
      throw failure("保留搜索页已离开原游戏视频范围，未自动刷新或重开来源", "douyin");
  }
  function assertChallengePage(value) {
    if (!challengeCurrent(value)) throw new CollectionError("LOGIN_REQUIRED", "保留的验证页面已失效，请重新打开验证", value?.site);
    let url, keyword;
    try { url = new URL(value.page.url()); keyword = decodeURIComponent(url.pathname.slice(8)).normalize("NFKC").trim(); } catch {}
    if (!url || url.origin !== new URL(SITES[value.site]).origin ||
        !url.pathname.startsWith("/search/") ||
        keyword !== value.keyword || url.searchParams.getAll("type").length !== 1 || url.searchParams.get("type") !== "video") {
      value.state = "waiting";
      throw new CollectionError("VERIFICATION_REQUIRED", "请在保留页面完成验证并返回原游戏搜索范围，未复用其他页面", value.site);
    }
  }
  function releaseChallenge(value, { restore = false } = {}) {
    if (pendingChallenge !== value) return;
    pendingChallenge = null;
    if (restore && value.context === context && value.epoch === epoch) {
      if (value.previousPage && !value.previousPage.isClosed()) protectedPages.set(value.site, value.previousPage);
      else if (protectedPages.get(value.site) === value.page) protectedPages.delete(value.site);
      if (value.previousProof && !value.previousProof.page.isClosed()) nativeProofs.set(value.site, value.previousProof);
      else if (nativeProofs.get(value.site)?.page === value.page) nativeProofs.delete(value.site);
    }
  }
  function targetNativeProof(target) {
    const proof = nativeProofs.get(target);
    if (!nativeContext || !context || !proof || proof.site !== target || proof.context !== context || proof.epoch !== epoch ||
        protectedPages.get(target) !== proof.page || proof.page.isClosed()) return null;
    try {
      if (new URL(proof.page.url()).origin !== new URL(SITES[target]).origin) return null;
    } catch { return null; }
    return proof;
  }
  function clearNativeProofs() {
    nativeContext = false;
    nativeProofs.clear();
    protectedPages.clear();
    pendingChallenge = null;
    // Keep a single inert scope tombstone so a closed verified search does not
    // silently turn into an automatic new navigation. Explicit fresh login
    // verification below may retire it; it never grants page ownership.
  }
  function ownPage(operation, page) {
    if (isProtectedPage(page) && operation.challenge?.page !== page && operation.search?.page !== page) throw failure("受保护登录页不能作为临时工作页");
    operation.pages.add(page);
    if (!pageOwners.has(page)) page.on?.("popup", (popup) => {
      const owner = pageOwners.get(page);
      const loginPopup = mode === "login" && owner.context === context &&
        (page === loginRoot || loginPopupParents.has(page));
      if (loginPopup) loginPopupParents.add(popup);
      ownPage(owner, popup);
      if (!loginPopup && (owner.cancelled || owner.finished)) void closeOwnedPage(owner, popup).catch(() => {});
    });
    pageOwners.set(page, operation);
    return page;
  }
  function closeOwnedPage(operation, page) {
    operation.pageClosures ??= new Map();
    if (operation.pageClosures.has(page)) return operation.pageClosures.get(page);
    const closingPage = Promise.resolve().then(async () => {
      if (!isProtectedPage(page) && !page.isClosed?.()) await page.close();
    }).catch((error) => { operation.pageClosures.delete(page); throw error; });
    operation.pageClosures.set(page, closingPage);
    return closingPage;
  }
  async function cleanOperation(operation) {
    if (!operation) return;
    if (!operation.cleanupPromise) operation.cleanupPromise = (async () => {
      await operation.creation?.catch(() => {});
      // Abort listener and worker timeout share this exact cleanup. Include
      // popups observed while the owned work page is being closed.
      const cleaned = new Set();
      while ([...operation.pages].some((page) => !cleaned.has(page))) {
        const pages = [...operation.pages].filter((page) => !cleaned.has(page));
        const results = await Promise.allSettled(pages.map((page) => closeOwnedPage(operation, page)));
        if (results.some((result) => result.status === "rejected"))
          throw new CollectionError("OPERATION_CLEANUP_FAILED", "临时采集页面关闭未确认，暂不启动下一项采集", site);
        pages.forEach((page) => cleaned.add(page));
      }
    })();
    try { await operation.cleanupPromise; }
    catch (error) { operation.cleanupPromise = null; throw error; }
  }
  async function newWorkPage(operation, ctx) {
    if (operation.cancelled) throw failure("采集已取消");
    operation.creation = Promise.resolve().then(() => ctx.newPage()).then((page) => ownPage(operation, page));
    return operation.creation;
  }
  async function cancelOperation(operation = activeOperation) {
    if (operation) operation.cancelled = true;
    if (operation?.challenge) releaseChallenge(operation.challenge, {restore:true});
    if (retainedNative() && (!operation?.context || operation.context === context)) {
      await cleanOperation(operation);
      if (operation?.finished && activeOperation === operation) { activeOperation = null; phase = "idle"; }
      return { retained_native_context: true };
    }
    // Never close a new context on behalf of an earlier, already detached job.
    if (operation?.context && operation.context !== context) {
      await cleanOperation(operation);
      return { retained_native_context: retainedNative() };
    }
    await close();
    return { retained_native_context: false };
  }
  async function releasePointer() {
    const pressed = pointerPage;
    pointerPage = null;
    if (pressed) await pressed.mouse.up();
  }
  function confirmClosed(operation) {
    if (closing !== operation) return;
    if (context === operation.context) {
      context = null;
      try { options.onSessionClosed?.(); } catch { /* readiness hooks cannot interrupt browser cleanup */ }
    }
    closing = null;
    loginRoot = null;
    loginKnown = new WeakSet();
    clearNativeProofs();
    mode = "closed";
    operation.resolve();
  }
  async function waitForClose(operation, signal) {
    const timeoutMs = Math.max(
      10,
      Math.min(options.closeTimeoutMs || 10000, 30000),
    );
    let timer, abort;
    try {
      await Promise.race([
        operation.promise,
        new Promise((_, reject) => {
          const rejectPending = () =>
            reject(
              new CollectionError(
                "CLOSE_TIMEOUT",
                "浏览器关闭尚未确认，请重启创作台后重试；不会并行打开同一登录资料",
                site,
              ),
            );
          timer = setTimeout(rejectPending, timeoutMs);
          abort = rejectPending;
          if (signal?.aborted) rejectPending();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } catch (error) {
      lastError = {
        code: error.code || "CLOSE_TIMEOUT",
        message: error.message,
        site,
      };
      throw error;
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  async function close({ signal } = {}) {
    epoch++;
    clearNativeProofs();
    if (!closing && !context) {
      loginRoot = null;
      loginKnown = new WeakSet();
      mode = "closed";
      void releasePointer().catch(() => {});
      return;
    }
    if (!closing) {
      const operation = { context, resolve: null, promise: null };
      operation.promise = new Promise((resolve) => {
        operation.resolve = resolve;
      });
      closing = operation;
      mode = "closing";
      loginRoot = null;
      loginKnown = new WeakSet();
      // Do not let an unreachable page's mouse.up prevent browser shutdown.
      void releasePointer().catch(() => {});
      // Keep this context and promise until its close resolves OR its real close
      // event arrives. A caller timeout is not evidence that it has shut down.
      Promise.resolve()
        .then(() => operation.context.close())
        .then(
          () => confirmClosed(operation),
          () => {}, // A rejected close without a close event remains unconfirmed.
        );
    }
    await waitForClose(closing, signal);
  }
  async function start(headless = true) {
    if (closing) await close();
    // A user can close the entire native window before requesting another site.
    // Do not reuse that context merely because its last mode was "login".
    if (
      context &&
      (mode === "login" || nativeContext) &&
      !context.pages().some((page) => !page.isClosed())
    )
      await close();
    if (retainedNative()) return context;
    if (context && mode === (headless ? "background" : "login")) return context;
    if (opening) return opening;
    opening = (async () => {
      const generation = epoch + 1;
      await close();
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      if (epoch !== generation) throw failure("浏览器启动已取消");
      const isolatedHeadless = headless ? options.headlessExecutablePath : null;
      if (isolatedHeadless && !existsSync(isolatedHeadless))
        throw failure(
          "后台浏览器路径不存在，请检查CRAWL_HEADLESS_EXECUTABLE；不会回退到日常Chrome",
        );
      const executablePath =
        isolatedHeadless || options.executablePath || chromePath();
      if (!executablePath && !options.channel && !options.chromium)
        throw failure("未找到Chrome，请配置CRAWL_CHROME_PATH");
      const opened = await engine.launchPersistentContext(profileDir, {
        headless,
        ...(executablePath
          ? { executablePath }
          : options.channel
            ? { channel: options.channel }
            : {}),
        viewport: { width: 1440, height: 1000 },
        locale: "zh-CN",
        acceptDownloads: false,
      });
      // Even a cancelled launch can return a live context later. Register its
      // identity and close listener before cleanup so a timeout cannot orphan it.
      context = opened;
      nativeContext = !headless;
      opened.on?.("close", () => {
        // A real close event confirms shutdown even if Playwright's close()
        // promise never settles. Old events cannot clear a newer session.
        if (closing?.context === opened) {
          confirmClosed(closing);
          return;
        }
        if (context !== opened) return;
        epoch++;
        context = null;
        try { options.onSessionClosed?.(); } catch { /* readiness hooks cannot interrupt browser cleanup */ }
        loginRoot = null;
        loginKnown = new WeakSet();
        clearNativeProofs();
        mode = "closed";
        void releasePointer().catch(() => {});
      });
      if (epoch !== generation) {
        await close();
        throw failure("浏览器启动已取消");
      }
      mode = headless ? "background" : "login";
      context.setDefaultTimeout?.(Math.min(options.timeoutMs || 15000, 15000));
      context.setDefaultNavigationTimeout?.(
        Math.min(options.timeoutMs || 45000, 45000),
      );
      return opened;
    })();
    try {
      return await opening;
    } finally {
      opening = null;
    }
  }
  async function activeLoginPage() {
    if (mode !== "login" || !context || !loginRoot)
      throw new CollectionError(
        "LOGIN_REQUIRED",
        "当前没有开启的专用登录会话",
        site,
      );
    const pages = context.pages().filter((p) => !p.isClosed());
    let active = pages.includes(loginRoot) ? loginRoot : null;
    loginKnown.add(loginRoot);
    const related = loginKnown;
    // Pages are creation-ordered. Only genuine opener descendants of this login
    // root are eligible; unrelated tabs and foreign-origin popups are closed.
    for (const page of pages) {
      if (page === loginRoot) continue;
      const opener = await page.opener();
      if (related.has(opener)) related.add(page);
      if (!related.has(page)) {
        await page.close();
        continue;
      }
      if (page.url() === "about:blank") {
        // DOMContentLoaded can already have fired for the initial blank document.
        // Wait for the destination URL, retaining a legitimate pending OAuth tab.
        try {
          await page.waitForURL((url) => url.href !== "about:blank", {
            timeout: 8000,
            waitUntil: "commit",
          });
        } catch {
          if (page.isClosed())
            throw failure("登录授权窗口已关闭，请重新打开登录", site);
          if (page.url() === "about:blank")
            throw new CollectionError(
              "LOGIN_LOADING",
              "登录授权页面仍在加载，请稍后刷新登录视图",
              site,
            );
        }
        if (page.url() === "about:blank")
          throw new CollectionError(
            "LOGIN_LOADING",
            "登录授权页面仍在加载，请稍后刷新登录视图",
            site,
          );
      }
      if (!allowedLoginURL(page.url())) {
        await page.close();
        continue;
      }
      active = page;
    }
    if (!active || !allowedLoginURL(active.url()))
      throw failure("登录页面跳转到未允许的地址，已停止展示与操作", site);
    // Keep at most the root and latest eligible popup. All content belongs to
    // this isolated login session; no ordinary-browser page is enumerated.
    for (const page of pages)
      if (page !== loginRoot && page !== active && !page.isClosed())
        await page.close();
    return active;
  }
  async function visibleFrameAccess(page) {
    const observations = [];
    if (typeof page.frames !== "function") return observations;
    const frames = page.frames().filter((frame) => frame !== page.mainFrame());
    // The diagnostic budget must never hide a known verification surface.
    // Inspect only titles on the exact observed endpoint before bounded body
    // diagnostics; unrelated frames do not incur an unbounded text scan.
    for (const frame of frames) {
      let element;
      try {
        const url = new URL(frame.url());
        if (url.origin !== "https://rmc.bytedance.com" || url.pathname !== "/verifycenter/captcha/v2") continue;
        element = await frame.frameElement();
        if (!await element.isVisible()) continue;
        const info = await frame.evaluate(() => ({ title: String(document.title || "").slice(0, 160), ready_state: document.readyState, public_markers: [] }));
        const access = classifySourceAccess({ title: info.title, url: url.origin + url.pathname, visibleFrame: true });
        if (access === "VERIFICATION_REQUIRED") return [{ host: url.hostname, path: url.pathname, ...info, access }];
      } catch {
        // A detached/unreadable candidate is not affirmative challenge proof.
      } finally {
        await element?.dispose?.().catch(() => {});
      }
    }
    for (const frame of frames) {
      if (frame === page.mainFrame() || observations.length >= 5) continue;
      let element;
      try {
        element = await frame.frameElement();
        if (!await element.isVisible()) continue;
        const info = await frame.evaluate(() => {
          const body = (document.body?.innerText || "").slice(0, 50000);
          const markers = ["拖动滑块", "安全验证", "验证身份", "完成验证", "访问过于频繁", "403 Forbidden", "Access Denied", "图形验证码", "图片验证码", "请按顺序点击", "请完成拼图", "请先登录", "登录后查看", "登录后使用", "登录后继续", "扫码登录", "短信登录", "手机号", "手机号码", "获取验证码", "获取短信验证码", "登录", "注册", "加载中", "正在加载", "网络异常", "网络错误", "页面加载失败", "系统繁忙", "服务异常"].filter((label) => body.includes(label));
          return { title: String(document.title || "").slice(0, 160), ready_state: document.readyState, body_text_length: body.length, public_markers: markers };
        });
        const url = new URL(frame.url());
        const observation = { host: url.hostname, path: url.pathname, ...info };
        observation.access = classifySourceAccess({ title: info.title, text: info.public_markers.join(" "), url: url.origin + url.pathname, visibleFrame: true });
        // A visible QR/SMS form in a frame is a login surface, not proof that
        // the enclosing page was logged in or that its ranking is empty.
        if (!observation.access && info.public_markers.some((label) => ["扫码登录", "短信登录"].includes(label))) observation.access = "LOGIN_REQUIRED";
        observations.push(observation);
      } catch {
        observations.push({ unavailable: true });
      } finally {
        await element?.dispose?.().catch(() => {});
      }
    }
    return observations;
  }
  async function collectionDiagnostics(page) {
    const structure = await page.evaluate(observeCollectionStructureDOM).catch(() => ({ unavailable: true }));
    return { ...structure, embedded_frames: await visibleFrameAccess(page) };
  }
  async function guard(page, target) {
    const text = (await page.locator("body").innerText()).slice(0, 50000);
    const title = typeof page.title === "function" ? await page.title() : "";
    const dialogs = await page
      .locator('[role="dialog"], [aria-modal="true"]')
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => n.getClientRects().length)
          .map((n) => n.innerText || ""),
      );
    const frames = await visibleFrameAccess(page);
    const mainAccess = classifySourceAccess({ text, title, url: page.url(), dialogs });
    const access = mainAccess === "VERIFICATION_REQUIRED" || frames.some((frame) => frame.access === "VERIFICATION_REQUIRED")
      ? "VERIFICATION_REQUIRED"
      : mainAccess || frames.find((frame) => frame.access)?.access;
    if (access) {
      const error = new CollectionError(
        access,
        access === "VERIFICATION_REQUIRED"
          ? "来源要求安全验证或限制访问，请在专用登录窗口完成验证"
          : "来源需要登录，请打开专用登录窗口",
        target,
      );
      error.diagnostics = { title: title.slice(0, 160), embedded_frames: frames };
      throw error;
    }
    return text;
  }
  async function navigate(page, url, target, waitUntil = "domcontentloaded") {
    let response;
    try {
      response = await page.goto(url, { waitUntil });
    } catch (error) {
      if (error.name === "TimeoutError" || /page\.goto: Timeout/.test(error.message || ""))
        throw failure("来源页面加载超时，尚不能判断登录是否有效；请稍后点击确认连接重试，无需立即重新登录", target);
      throw error;
    }
    if (response?.status() === 403)
      throw new CollectionError(
        "VERIFICATION_REQUIRED",
        "来源拒绝访问（403），请在专用登录窗口检查",
        target,
      );
    if (response?.status() >= 400)
      throw failure(`来源页面返回HTTP ${response.status()}`, target);
  }
  async function waitContent(page, selector, target) {
    try {
      await page
        .locator(selector)
        .first()
        .waitFor({
          state: "visible",
          timeout: Math.min(options.timeoutMs || 30000, 30000),
        });
    } catch {
      const body = await guard(page, target);
      if (/暂无(?:相关)?(?:数据|内容|结果)|没有找到|没有相关/.test(body))
        return false;
      const error = failure("来源页面未返回可识别内容，未将其记为空结果", target);
      error.diagnostics = await collectionDiagnostics(page);
      throw error;
    }
    await guard(page, target);
    return true;
  }
  async function game(page, payload, signal, recovery = null, retained = null) {
    if (!payload.keyword?.trim())
      throw failure("游戏搜索关键词不能为空", "douyin");
    const url = `https://www.douyin.com/search/${encodeURIComponent(payload.keyword.trim())}?type=video`;
    if (recovery) assertChallengePage(recovery);
    else if (retained) { assertRetainedSearch(retained); await guard(page,"douyin"); checkAbort(signal); assertRetainedSearch(retained); }
    else await navigate(page, url, "douyin");
    await waitContent(page, 'a[href*="/video/"]', "douyin");
    sourceObservations = [{kind: "game_search", requested_sort: payload.sort || "likes", requested_hours: payload.hours, structure: await collectionDiagnostics(page)}];
    const filterEvidence = [];
    sourceObservations[0].filter_observations = filterEvidence;
    const filters = await applyGameSearchFilters(page, payload, {signal,timeoutMs:Math.min(options.responseTimeoutMs||15000,15000),guard:()=>guard(page,"douyin"),observe:(stage,snapshot)=>{
      filterEvidence.push({stage,...diagnosticGameSnapshot(snapshot)});
      if(filterEvidence.length>8) filterEvidence.shift();
    }});
    if(!filters.result_update){
      const selected=await filters.read();
      const error=failure("结果更新信号尚未核验；未将原搜索卡片保存为新范围","douyin");
      error.diagnostics={game_filters:diagnosticGameSnapshot(selected.snapshot, {samples:true}),result_update:"unconfirmed"};throw error;
    }
    const batches=[],latest=new Map(),limit=Math.min(30,payload.limit || 30);
    let evidenceCharacters=[...filters.result_update.before_cards,...filters.result_update.after_cards].reduce((sum,card)=>sum+card.text.length,0);
    const readBatch=(snapshot,scope)=>{
      const observed_at=new Date().toISOString();
      const batch={cards:snapshot.cards,scope,observed_at};
      evidenceCharacters+=batch.cards.reduce((sum,card)=>sum+card.text.length,0);
      if(evidenceCharacters>1000000){const error=failure("实际可见卡片证据超过本轮有界容量，未截断保存","douyin");error.diagnostics={game_filters:diagnosticGameSnapshot(snapshot,{samples:true})};throw error;}
      for(const card of batch.cards){
        const row=parseSearchCard({url:`https://www.douyin.com/video/${card.source_id}`,text:card.text},snapshot.url,observed_at);
        if(!row || row.source_id!==card.source_id){const error=failure("实际卡片不可完整解析，未保存不完整来源","douyin");error.diagnostics={game_filters:diagnosticGameSnapshot(snapshot, {samples:true})};throw error;}
        const freshness=classifyGamePublication(row,{hours:payload.hours??168,observedAt:observed_at});
        if(freshness==='outside'){const error=failure("可见视频发布时间与实际请求时间范围矛盾，未保存该批结果","douyin");error.diagnostics={game_filters:diagnosticGameSnapshot(snapshot, {samples:true}),contradiction:{source_id:row.source_id,published_text:row.published_text}};throw error;}
        latest.set(row.source_id,{row:{...row,source_endpoint:'douyin_visible_search'},freshness});
      }
      batches.push(batch);
    };
    let current={snapshot:filters.initial_snapshot,scope:filters.scope},stopReason=null;
    readBatch(current.snapshot,current.scope);
    while(batches.length<10 && [...latest.values()].filter(value=>value.freshness==='within').length<limit){
      checkAbort(signal);const before=current.snapshot;
      await page.mouse.wheel(0,1100);
      current=await filters.stable(before,new Set(latest.keys()));
      readBatch(current.snapshot,current.scope);
      if(current.no_progress){stopReason='no_new_cards_observed';break;}
    }
    const final=await filters.read();
    checkAbort(signal);
    if(JSON.stringify(final.scope)!==JSON.stringify(filters.scope) || fingerprintGameCards(final.snapshot.cards)!==fingerprintGameCards(batches.at(-1).cards)){
      const error=failure("搜索范围或可见结果在最终提交前改变，未保存过期批次","douyin");error.diagnostics={game_filters:diagnosticGameSnapshot(final.snapshot, {samples:true})};throw error;
    }
    const records=[],excluded_records=[];
    for(const {row,freshness} of latest.values()){
      if(freshness==='within'&&records.length<limit)records.push(row);
      else excluded_records.push({source_id:row.source_id,published_text:row.published_text,publication_precision:row.publication_precision,reason:freshness==='unknown'?'publication_unknown':'sample_limit'});
    }
    if(!records.length){const error=failure("已读取实际视频，但发布时间无法确认在请求范围内；未作空结果成功","douyin");error.diagnostics={game_filters:diagnosticGameSnapshot(final.snapshot, {samples:true}),excluded_count:excluded_records.length,excluded_sample:excluded_records.slice(0,3)};throw error;}
    return {source_endpoint:'douyin_visible_search',records,excluded_records,collection_batches:batches,
      stop_reason:stopReason||([...latest.values()].filter(value=>value.freshness==='within').length>=limit?'sample_limit_reached':'batch_limit_reached'),
      observed_scope:final.scope,result_update:filters.result_update,failures:[],searched_at:new Date().toISOString(),
      scope:`抖音“${payload.keyword}”实际视频搜索，${final.scope.time_label}、${final.scope.sort_label}；正常筛选后可见结果身份改变并稳定，读取${latest.size}条，保留范围内${records.length}条，排除${excluded_records.length}条。${stopReason==='no_new_cards_observed'?'有界等待内未观察到新卡片，仅保留已核验样本；不代表来源末尾或无更多数据。':''}${records.length<limit?`不足请求的${limit}条。`:''}${records.length<20?'不足20条，不满足游戏学习门槛。':''}`,
      sort_basis:`来源实际${final.scope.sort_label}展示顺序，不作为官方名次`};
  }

  async function applyCategory(page, target) {
    const selected = resolveCategory(target.category);
    if (!selected) return null;
    const [parent, child] = selected.id.split("/").map(Number);
    let expected = [], stage = "open_category", beforeDismiss = null, reappliedSelection = false;
    try {
    const parentLabel = categories.find((x) => x.value === parent).label;
    const combo = page
      .getByRole("combobox")
      .filter({ hasText: new RegExp(`请选择垂类|${parentLabel}`) })
      .first();
    await combo.click();
    await page.getByText(parentLabel, { exact: true }).last().click();
    const boxes = page.locator(`input[type="checkbox"][value^="${parent}"]`);
    const values = (await boxes.evaluateAll((nodes) =>
      nodes
        .filter((n) => n.getClientRects().length)
        .map((n) => n.value)
        .filter((v) => /^\d+$/.test(v)),
    )).filter((value) => value !== String(parent));
    if (!values.length)
      throw failure("未识别来源页面实际子行业，未采用静态标签猜测", "douhot");
    if (child && !values.includes(String(child)))
      throw failure("请求子行业已不在来源页面目录中", "douhot");
    expected = child ? [String(child)] : values;
    const initialChecked = (await boxes.evaluateAll((nodes) => nodes
      .filter((node) => node.checked && node.getClientRects().length)
      .map((node) => node.value))).filter((value) => value !== String(parent)).sort();
    const urlChildren = (new URL(page.url()).searchParams.get("second_tag") || "").split("x").filter(Boolean).sort();
    if (initialChecked.join(",") === [...expected].sort().join(",") &&
        urlChildren.join(",") !== [...expected].sort().join(",")) {
      // setChecked(true) is otherwise a no-op and cannot clear a stale source
      // selection. Reapply one observed child once through the actual UI.
      stage = "reapply_visible_selection";
      reappliedSelection = true;
      await setCategoryCheckbox(page.locator(`input[type="checkbox"][value="${expected[0]}"]`), false);
    }
    stage = "set_checkboxes";
    for (const value of values) {
      await setCategoryCheckbox(page.locator(`input[type="checkbox"][value="${value}"]`), expected.includes(value));
    }
    const checked = (await boxes.evaluateAll((nodes) =>
      nodes
        .filter((n) => n.checked && n.getClientRects().length)
        .map((n) => n.value)
        .sort(),
    )).filter((value) => value !== String(parent));
    if (checked.join(",") !== [...expected].sort().join(","))
      throw failure("来源行业勾选结果未匹配请求", "douhot");
    beforeDismiss = await page.evaluate(observeCategorySelectionDOM, { parent, expected }).catch(() => ({ unavailable: true }));
    stage = "dismiss_category";
    await page.keyboard.press("Escape");
    await page.locator("body").click({ position: { x: 1400, y: 100 } });
    stage = "confirm_url_scope";
    await page.waitForFunction(
      ({ expected }) => {
        const actual = (
          new URL(location.href).searchParams.get("second_tag") || ""
        )
          .split("x")
          .filter(Boolean)
          .sort();
        return actual.join(",") === expected.sort().join(",");
      },
      { expected },
      { timeout: 15000 },
    );
    return expected;
    } catch (error) {
      const current = await page.evaluate(observeCategorySelectionDOM, { parent, expected }).catch(() => ({ unavailable: true }));
      error.diagnostics = { category_selection: { stage, reapplied_selection: reappliedSelection, before_dismiss: beforeDismiss, current,
        ...(error.checkbox_diagnostic ? { checkbox_action: error.checkbox_diagnostic } : {}) } };
      throw error;
    }
  }
  async function observedScope(page) {
    return page.evaluate(observeScopeDOM);
  }
  async function hotspots(page, payload, signal) {
    const records = [], failures = [], observed = [], diagnostics = [], paginationBoards = [];
    const targets = collectionTargets(payload);
    sourceObservations = [];
    const now = options.paginationClock?.now || (() => performance.now());
    for (const target of targets) {
      checkAbort(signal);
      const traversal = createRankingTraversal(target);
      const observation = { board: target.board, hours: target.hours, category: target.category, responses: [], pages: [], stage: "navigate" };
      const newRound = pageNumber => ({ page: pageNumber, receipts: [], reads: new Map(), epoch: target.board>=2000 ? createPublicRankingDiagnosticEpoch() : createRankingRequestEpoch(), responseCount: 0, limitReached: false });
      let round = newRound(1), lastActionAt = now();
      sourceObservations.push(observation);
      const onRequest = request => round.epoch.observe(request);
      const onRequestFailed = request => round.epoch.failed(request);
      const onResponse = response => {
        const ownedRound = round, sourceRequest = response.request();
        if (!ownedRound.epoch.owns(sourceRequest)) return;
        const read = async () => {
          let u;
          try { u = new URL(response.url()); } catch { return; }
          if (u.origin !== "https://douhot.douyin.com" || !RANKING_PATHS.has(u.pathname)) return;
          if (ownedRound.responseCount >= 64) { ownedRound.limitReached = true; return; }
          ownedRound.responseCount++;
          let request;
          try { request = sourceRequest.postDataJSON(); } catch { request = null; }
          const body = await response.json().catch(() => null);
          if (round !== ownedRound || !ownedRound.epoch.isOpen() || signal?.aborted) return;
          const summary = describeRankingResponse(u.href, request, body, response.status());
          if (summary) {
            observation.responses.push({ round_page: ownedRound.page, ...summary });
            if (observation.responses.length > 12) observation.responses.shift();
          }
          if (target.board<2000) ownedRound.receipts.push({ url: u.href, request, body, status: response.status() });
        };
        const pending = read().catch(() => ownedRound.epoch.failed(sourceRequest)).finally(() => ownedRound.epoch.complete(sourceRequest));
        let requestScope;
        try { requestScope = sourceRequest.postDataJSON(); } catch { requestScope = null; }
        ownedRound.reads.set(pending, { url: response.url(), request: requestScope });
        void pending.finally(() => ownedRound.reads.delete(pending));
      };
      page.on("request", onRequest); page.on("requestfailed", onRequestFailed); page.on("response", onResponse);
      try {
        await navigate(page, hotspotURL(target), "douhot");
        if (target.board >= 2000) {
          await waitContent(page, "body", "douhot");
          observation.stage="diagnose_unsupported_board";
          const wantedPath=target.board<3000 ? "/douhot/v1/material/challenge_billboard" : "/douhot/v1/dashboard/hot_search/query_list";
          const deadline=performance.now()+Math.min(options.responseTimeoutMs || 15000,15000);
          while(!observation.responses.some(response=>response.path===wantedPath) && performance.now()<deadline) {
            checkAbort(signal);
            await page.waitForTimeout(Math.min(100,Math.max(1,deadline-performance.now())));
          }
          await settleObservedResponses({[Symbol.iterator]:()=>round.reads.keys()},{signal,timeoutMs:Math.min(options.responseTimeoutMs || 5000,5000)});
          await guard(page,"douhot");
          checkAbort(signal);
          throw failure("该话题/搜索榜的公开页面适配尚未验证", "douhot");
        }
        await waitContent(page, '[role="combobox"]', "douhot");
        const expectedChildIds = await applyCategory(page, target);
        for (let expectedPage = 1; expectedPage <= 50; expectedPage++) {
          observation.stage = "wait_page_response";
          observation.expected_page = expectedPage;
          const currentReads = scopedRankingReads(round.reads, target, expectedChildIds, expectedPage);
          const present = await waitContent(page, "tbody tr", "douhot");
          await waitForObservedRankingPage(round.receipts, target, expectedChildIds, expectedPage, {
            signal, timeoutMs: options.scopeResponseTimeoutMs ?? 15000,
          });
          await page.locator(".arco-table-pagination li.arco-pagination-item-active")
            .filter({ hasText: new RegExp(`^\\s*${expectedPage}\\s*$`) }).waitFor({ state: "visible", timeout: 15000 });
          assertObservedScope(target, { ...(await observedScope(page)), expectedChildIds });
          observation.pagination = await page.evaluate(observeRankingPaginationDOM).catch(() => ({status:"unavailable"}));
          const currentPage = await page.evaluate(observeCurrentRankingPageDOM);
          observation.current_page = currentPage;
          if (currentPage.page !== expectedPage) throw failure(`未确认来源页面实际处于第${expectedPage}页`, "douhot");
          await settleObservedResponses(currentReads, { signal });
          if (round.limitReached || round.epoch.exceeded()) throw failure("当前页面榜单请求超过核验上限", "douhot");
          const firstPage = parseObservedRankingPage(round.receipts, target, expectedChildIds, expectedPage);
          if (!present && firstPage.records.length) throw failure("页面空结果标识与实际榜单响应不一致，未清空原结果", "douhot");
          observation.response_page = { ...firstPage.metadata, actual_count: firstPage.actual_count };
          observation.stage = "verify_page";
          await waitForRankingEpochIdle(round.epoch, target, expectedChildIds, expectedPage, { signal, timeoutMs: options.scopeResponseTimeoutMs ?? 15000 });
          await settleObservedResponses(currentReads, { signal });
          await guard(page, "douhot");
          const finalScope = await page.evaluate(observeFinalRankingScopeDOM);
          // No asynchronous work from final scope/pager snapshot to this page's
          // local acceptance and (only for confirmed terminal) board commit.
          checkAbort(signal);
          assertObservedScope(target, { ...finalScope, expectedChildIds });
          if (finalScope.page !== expectedPage) throw failure("来源当前页在读取期间发生变化，未保存过期范围", "douhot");
          const finalPage = parseObservedRankingPage(round.receipts, target, expectedChildIds, expectedPage);
          if (finalPage.fingerprint !== firstPage.fingerprint) throw failure("榜单响应在读取期间发生变化，未保存任意版本", "douhot");
          if (currentReads.size || round.limitReached || round.epoch.exceeded() || round.epoch.pending(target, expectedChildIds, expectedPage) || round.epoch.hasFailure(target, expectedChildIds, expectedPage))
            throw failure("当前范围及页码的页面请求仍在变化或失败，未保存不完整结果", "douhot");
          const at = new Date().toISOString();
          const pageRecords = finalPage.records.map(record => ({ ...record,
            observed_url: finalScope.url, sub_type: target.board, date_window: target.hours,
            category_filter: resolveCategory(target.category)?.tags || null,
            category_label: resolveCategory(target.category)?.label || "不限行业", collected_at: at,
          }));
          const terminal = traversal.append(finalPage, finalScope, pageRecords);
          round.epoch.close();
          observation.progress = traversal.progress();
          observation.pages = observation.progress.pages;
          if (terminal) {
            const result = traversal.result();
            records.push(...result.records); observed.push(target.board); paginationBoards.push(result.summary);
            observation.stage = "accessible_complete";
            break;
          }
          observation.stage = "pace_next_page";
          await paceRankingClick(lastActionAt, { signal, clock: options.paginationClock });
          await guard(page, "douhot");
          const beforeClick = await page.evaluate(observeFinalRankingScopeDOM);
          checkAbort(signal);
          assertObservedScope(target, { ...beforeClick, expectedChildIds });
          if (beforeClick.page !== expectedPage || beforeClick.next_disabled !== false)
            throw failure("下一页点击前实际页码或控件状态已变化，未继续该榜", "douhot");
          // Reset ownership before the user's normal next-page UI action.
          // An old request's late response cannot enter the new page buffers.
          round = newRound(expectedPage + 1);
          observation.stage = "click_next_page";
          lastActionAt = now();
          await page.locator('.arco-table-pagination li[aria-label="下一页"]').click({ timeout: 15000 });
        }
      } catch (error) {
        if (signal?.aborted || ["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"].includes(error.code)) throw error;
        observation.progress = traversal.progress(); observation.pages = observation.progress.pages;
        observation.failure_stage = observation.stage; observation.stage = "failed";
        if (error.identity_schema_diagnostic) {
          const index = error.identity_schema_diagnostic.row_index;
          if (Number.isInteger(index) && index >= 0 && index < 30) {
            const row = page.locator("tbody tr").nth(index);
            error.identity_schema_diagnostic.dom_row_at_response_index = typeof row.evaluate === "function"
              ? await row.evaluate(observeRankingIdentityRowDOM, undefined, { timeout: 1500 }).catch(() => ({ unavailable: true })) : { unavailable: true };
          }
        }
        failures.push(`${target.board}: ${String(error.message).split("\n")[0].slice(0, 150)}`);
        diagnostics.push({ board: target.board, structure: error.diagnostics || await collectionDiagnostics(page),
          pagination: observation.pagination || await page.evaluate(observeRankingPaginationDOM).catch(() => ({status:"unavailable"})),
          progress: observation.progress, failure_stage: observation.failure_stage, expected_page: observation.expected_page,
          responses: observation.responses,
          ...(error.identity_diagnostic ? {identity_comparison: error.identity_diagnostic} : {}),
          ...(error.identity_schema_diagnostic ? {identity_schema: error.identity_schema_diagnostic} : {}),
        });
      } finally {
        round.epoch.close();
        page.off("request", onRequest); page.off("requestfailed", onRequestFailed); page.off("response", onResponse);
      }
    }
    if (!observed.length) { const error = failure(failures.join("；") || "未读取任何请求榜单", "douhot"); error.diagnostics = diagnostics; throw error; }
    return { records, failures,
      observed_scope: { boards: observed, hours: payload.hours, category: payload.category || "all" },
      pagination: { max_pages_per_board: 50, max_rows_per_board: 1500, boards: paginationBoards },
      scope: `热点宝已核验榜单${observed.join("、")}的行业、时间及连续页码，并遍历页面实际可访问分页；来源total与实读条数差异单独记录，不推断全榜或权限原因。${failures.length ? "其余榜单失败，未导入其部分页。" : ""}`,
      sort_basis: "来源页面响应顺序，不作为官方名次，未比较跨榜热度", searched_at: new Date().toISOString(),
    };
  }
  return {
    async collect(payload, { signal } = {}) {
      if (phase !== "idle") throw failure("采集器正忙");
      const recovery = pendingChallenge;
      let retained = !recovery && payload.purpose === "game-research" && retainedNativeSearch?.scopeKey === collectionRecoveryKey(payload)
        ? retainedNativeSearch : null;
      if (retained) assertRetainedSearch(retained);
      if (recovery && !challengeCurrent(recovery)) {
        releaseChallenge(recovery, {restore:true});
        throw new CollectionError("LOGIN_REQUIRED", "原验证页面已关闭或会话已变化，请重新确认连接", recovery.site);
      }
      if (recovery && (recovery.scopeKey !== collectionRecoveryKey(payload) || recovery.state !== "verified"))
        throw new CollectionError("VERIFICATION_REQUIRED", "请先完成原游戏搜索页面验证并恢复同一范围，其他请求保持等待", recovery.site);
      if (mode === "login")
        throw new CollectionError(
          "LOGIN_REQUIRED",
          "请先完成专用窗口登录并点击继续采集",
          site,
        );
      if (!recovery && !retained && payload.purpose === "game-research") {
        const proof = targetNativeProof("douyin");
        const keyword = typeof payload.keyword === "string" ? payload.keyword.normalize("NFKC").trim() : "";
        // A user may search manually in their already verified dedicated page.
        // Reuse that exact page, never an arbitrary tab or a same-game page
        // retained for a different time/sort scope. A manually changed keyword
        // is a new explicit scope only when the current URL matches it exactly.
        const separateScope = Boolean(retainedNativeSearch && proof && retainedNativeSearch.page === proof.page && retainedNativeSearch.keyword === keyword);
        if (proof && keyword && !separateScope && sameSearchPage(proof.page,keyword)) {
          checkAbort(signal);
          retained = {context:proof.context,epoch:proof.epoch,page:proof.page,keyword,scopeKey:collectionRecoveryKey(payload)};
          retainedNativeSearch = retained;
          assertRetainedSearch(retained);
        }
      }
      phase = "collecting";
      site = payload.purpose === "hotspots" ? "douhot" : "douyin";
      lastError = null;
      sourceObservations = [];
      const operation = { context: null, pages: new Set(recovery ? [recovery.page] : retained ? [retained.page] : []), cancelled: false, challenge: recovery, search:retained };
      activeOperation = operation;
      let page;
      const onAbort = () => {
        void cancelOperation(operation).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        checkAbort(signal);
        const ctx = await start(true);
        operation.context = ctx;
        operation.epoch = epoch;
        checkAbort(signal);
        if (recovery) {
          assertChallengePage(recovery);
          recovery.state = "claimed";
          page = ownPage(operation, recovery.page);
        } else if (retained) { assertRetainedSearch(retained); page=ownPage(operation,retained.page); }
        else page = await newWorkPage(operation, ctx);
        checkAbort(signal);
        if (operation.cancelled) throw failure("采集已取消");
        const result =
          site === "douhot"
            ? await hotspots(page, payload, signal)
            : await game(page, payload, signal, recovery, retained);
        checkAbort(signal);
        if (recovery) {
          assertChallengePage(recovery);
          // The successfully read page becomes the single account page for
          // this site. Retire its superseded page only after actual recovery.
          if (recovery.previousPage && recovery.previousPage !== page) operation.pages.add(recovery.previousPage);
          releaseChallenge(recovery);
        }
        return result;
      } catch (error) {
        if (retained && error.code === "LOGIN_REQUIRED") nativeProofs.delete("douyin");
        if (error.code === "VERIFICATION_REQUIRED" && !signal?.aborted && !operation.cancelled &&
            nativeContext && context === operation.context && epoch === operation.epoch && page && !page.isClosed() &&
            payload.purpose === "game-research") {
          if (!pendingChallenge) pendingChallenge = {
            context, epoch, site: "douyin", scopeKey: collectionRecoveryKey(payload),
            keyword: payload.keyword.normalize("NFKC").trim(), page,
            previousPage: protectedPages.get("douyin"), previousProof: nativeProofs.get("douyin"), state: "waiting",
          };
          if (pendingChallenge.page === page) {
            pendingChallenge.state = "waiting";
            operation.challenge = pendingChallenge;
          }
        } else if (recovery && error.code === "SOURCE_FAILED" && Object.hasOwn(error.diagnostics || {}, "game_filters") &&
            !signal?.aborted && !operation.cancelled && context === operation.context && epoch === operation.epoch &&
            targetNativeProof("douyin")?.page === page && sameSearchPage(page,recovery.keyword)) {
          // Parsing failure does not revoke the user's successful verification.
          // Preserve only this exact verified search page, never its old cards.
          retainedNativeSearch={context,epoch,page,keyword:recovery.keyword,scopeKey:recovery.scopeKey};
          if(recovery.previousPage && recovery.previousPage!==page) operation.pages.add(recovery.previousPage);
          releaseChallenge(recovery);
        } else if (recovery) releaseChallenge(recovery, {restore:true});
        lastError = {
          code: error.code || "SOURCE_FAILED",
          message: String(error.message).split("\n")[0].slice(0, 300),
          site,
          ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
        };
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        operation.finished = true;
        try { await cleanOperation(operation); }
        catch (error) { if (activeOperation === operation) phase = "cleanup_failed"; throw error; }
        if (activeOperation === operation) { activeOperation = null; phase = "idle"; }
      }
    },
    async verifyLogin(target, { signal } = {}) {
      if (!Object.hasOwn(SITES, target)) throw failure("登录站点无效");
      checkAbort(signal);
      if (target !== site)
        throw new CollectionError("LOGIN_SITE_MISMATCH", "登录站点已切换，请确认当前平台", target);
      if (phase !== "idle") throw new CollectionError("COLLECTOR_BUSY", "当前浏览器操作尚未结束，请稍后确认", target);
      if (mode === "closing")
        throw new CollectionError("CLOSE_TIMEOUT", "登录浏览器仍在关闭，请稍后重试", target);
      // Manual window closure has no native evidence. The caller must still run
      // the independent background probe; this result never grants readiness.
      if (mode === "closed" && !context)
        return {site:target,state:"window_closed",native_verified:false};
      if (mode !== "login" || !context)
        throw new CollectionError("LOGIN_NOT_OPEN", "当前没有可核验的原生登录窗口", target);
      const generation = epoch, current = context;
      const challenge = pendingChallenge?.site === target ? pendingChallenge : null;
      phase = "verifying_login";
      try {
        const pages = current.pages().filter(page => !page.isClosed());
        if (!pages.length) return {site:target,state:"window_closed",native_verified:false};
        // Inspect only this login root and its genuine OAuth descendants. Unlike
        // panel input selection, verification never navigates or closes any tab.
        const related = new Set(loginRoot ? [loginRoot] : []);
        let page = pages.includes(loginRoot) ? loginRoot : null;
        for (const candidate of pages) {
          if (candidate === loginRoot) continue;
          if (related.has(await candidate.opener())) {
            related.add(candidate);
            page = candidate;
          }
        }
        if (challenge) {
          assertChallengePage(challenge);
          page = challenge.page;
        }
        checkAbort(signal);
        if (!page || !allowedLoginURL(page.url()))
          throw new CollectionError("LOGIN_CHECK_FAILED", "当前登录页面尚未可核验，请保留窗口并完成登录后重试", target);
        await guard(page, target);
        checkAbort(signal);
        await confirmOwnAccount(page, target, Math.min(options.timeoutMs || 5000, 5000));
        checkAbort(signal);
        await guard(page, target);
        checkAbort(signal);
        if (generation !== epoch || current !== context || mode !== "login" || page.isClosed())
          throw new CollectionError("LOGIN_CHECK_FAILED", "核验期间登录窗口发生变化，请再次确认连接", target);
        if (challenge) {
          if (pendingChallenge !== challenge) throw new CollectionError("LOGIN_CHECK_FAILED", "验证请求已变化，请重新确认", target);
          assertChallengePage(challenge);
          challenge.state = "verified";
        }
        if (presentation === "native" && nativeContext) {
          if (target === "douyin" && !challenge && retainedNativeSearch && (retainedNativeSearch.context !== current || retainedNativeSearch.epoch !== generation || retainedNativeSearch.page !== page)) retainedNativeSearch = null;
          nativeProofs.set(target, { context: current, epoch: generation, site: target, page });
          protectedPages.set(target, page);
          loginRoot = page;
          loginPopupParents = new WeakSet();
        }
        lastError = null;
        return {site:target,state:"ready",native_verified:true};
      } catch (error) {
        const safe = error instanceof CollectionError ? error : new CollectionError(
          "LOGIN_CHECK_FAILED", "未能读取当前登录页面的本人账号状态，窗口已保留，请稍后再次确认连接", target);
        lastError = {code:safe.code,message:safe.message,site:target};
        throw safe;
      } finally {
        phase = "idle";
      }
    },
    async probe(target, { signal } = {}) {
      if (!Object.hasOwn(SITES, target)) throw failure("登录站点无效");
      if (phase !== "idle")
        throw failure("采集器正忙");
      if (pendingChallenge?.site === target && (!challengeCurrent() || pendingChallenge.state !== "verified"))
        return {site:target,state:"verification_required",checked_at:new Date().toISOString(),message:"原游戏搜索页面等待手动验证，请打开该平台验证后恢复同一范围"};
      if (mode === "login")
        return {
          site: target,
          state: "login_required",
          checked_at: new Date().toISOString(),
          message: "请完成专用窗口登录并点击继续",
        };
      phase = "probing";
      site = target;
      const operation = { context: null, pages: new Set(), cancelled: false };
      activeOperation = operation;
      let page;
      const onAbort = () => {
        void cancelOperation(operation).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        checkAbort(signal);
        const proof = targetNativeProof(target);
        const checkCurrent = () => {
          checkAbort(signal);
          if (operation.cancelled) throw failure("采集已取消");
          if (proof && targetNativeProof(target) !== proof)
            throw new CollectionError("LOGIN_CHECK_FAILED", "核验期间已验证来源页面发生变化，请重新确认连接", target);
        };
        if (proof) {
          operation.context = proof.context;
          page = proof.page;
          // A valid runtime proof chooses the existing protected page, not the
          // outcome. Re-read visible access/account evidence without a reload.
          checkCurrent();
        } else {
          const ctx = await start(true);
          operation.context = ctx;
          checkCurrent();
          page = await newWorkPage(operation, ctx);
          checkCurrent();
          await navigate(page, SITES[target], target, "commit");
        }
        checkCurrent();
        await guard(page, target);
        checkCurrent();
        await confirmOwnAccount(
          page,
          target,
          Math.min(options.timeoutMs || 10000, 10000),
        );
        checkCurrent();
        await guard(page, target);
        checkCurrent();
        return {
          site: target,
          state: "ready",
          checked_at: new Date().toISOString(),
          message: "已确认来源登录后的页面可用",
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          site: target,
          state:
            error.code === "LOGIN_REQUIRED"
              ? "login_required"
              : error.code === "VERIFICATION_REQUIRED"
                ? "verification_required"
                : "failed",
          checked_at: new Date().toISOString(),
          message: String(error.message).split("\n")[0].slice(0, 300),
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        operation.finished = true;
        try { await cleanOperation(operation); }
        catch (error) { if (activeOperation === operation) phase = "cleanup_failed"; throw error; }
        if (activeOperation === operation) { activeOperation = null; phase = "idle"; }
      }
    },
    status() {
      return { mode, phase, site, presentation, recovery_scope_key: pendingChallenge?.scopeKey || null, recovery_state: pendingChallenge?.state || null, retained_search_scope_key:retainedNativeSearch?.scopeKey || null, native_context_retained: retainedNative(), session_mode: retainedNative() ? "native_retained" : nativeContext ? "native_login" : mode, last_error: lastError, source_observations: sourceObservations };
    },
    async login(target, { signal } = {}) {
      if (!Object.hasOwn(SITES, target)) throw failure("登录站点无效");
      if (phase !== "idle") throw failure("请等待或取消正在执行的采集");
      checkAbort(signal);
      if (pendingChallenge) {
        const challenge = pendingChallenge;
        if (!challengeCurrent(challenge)) releaseChallenge(challenge, {restore:true});
        else {
          if (challenge.site !== target) throw new CollectionError("VERIFICATION_REQUIRED", "请先处理原游戏搜索的验证页面，未切换或覆盖该页面", challenge.site);
          mode = "login";
          site = target;
          loginRoot = challenge.page;
          loginPopupParents = new WeakSet();
          challenge.state = "waiting";
          // The page itself is the actual challenged search, not a replacement
          // homepage. Only this explicit user action may focus it.
          await challenge.page.bringToFront();
          checkAbort(signal);
          return {mode,site,presentation,recovery_scope_key:challenge.scopeKey};
        }
      }
      if (
        presentation === "native" &&
        mode === "login" &&
        site === target &&
        context
      ) {
        const existing = context.pages().filter((page) => !page.isClosed() && allowedLoginURL(page.url()) && ![...protectedPages.entries()].some(([key, value]) => key !== target && value === page));
        const protectedPage = protectedPages.get(target);
        const current = protectedPage && !protectedPage.isClosed() ? protectedPage : existing.at(-1);
        if (current) {
          // Repeated user clicks only focus the current login/OAuth window.
          // Do not reload its QR code, interrupt verification, or discard session.
          await current.bringToFront();
          return { mode, site, presentation };
        }
        // The user may have closed the native window. Reopen the same profile;
        // never reuse a disconnected context or clear its saved session.
        await close();
      }
      await releasePointer().catch(() => {});
      const ctx = await start(presentation === "panel");
      mode = "login";
      site = target;
      const pages = ctx.pages();
      const prior = protectedPages.get(target);
      const page = prior && !prior.isClosed() ? prior : pages.find((candidate) => !candidate.isClosed?.() && ![...protectedPages.values()].includes(candidate)) || (await ctx.newPage());
      loginRoot = page;
      loginPopupParents = new WeakSet();
      nativeProofs.delete(target);
      if (presentation === "native") protectedPages.set(target, page);
      for (const extra of pages)
        if (extra !== page && ![...protectedPages.values()].includes(extra)) await extra.close();
      if (page !== prior) await navigate(page, SITES[target], target);
      if (presentation === "native") await page.bringToFront();
      return { mode, site, presentation };
    },
    async loginView({ signal } = {}) {
      if (presentation !== "panel")
        throw new CollectionError(
          "NATIVE_LOGIN_ONLY",
          "请在真实浏览器登录窗口中操作",
          site,
        );
      checkAbort(signal);
      const sessionEpoch = epoch;
      const page = await activeLoginPage();
      const bytes = await page.screenshot({
        type: "jpeg",
        quality: 75,
        fullPage: false,
      });
      checkAbort(signal);
      if (mode !== "login" || sessionEpoch !== epoch)
        throw new CollectionError("LOGIN_REQUIRED", "登录会话已关闭", site);
      const url = allowedLoginURL(page.url());
      if (!url) throw failure("登录页面已离开允许的域名，截图未返回", site);
      return {
        site,
        url: url.origin + url.pathname,
        image: "data:image/jpeg;base64," + bytes.toString("base64"),
        width: 1440,
        height: 1000,
      };
    },
    async loginInput(input, { signal } = {}) {
      if (presentation !== "panel")
        throw new CollectionError(
          "NATIVE_LOGIN_ONLY",
          "请在真实浏览器登录窗口中操作",
          site,
        );
      checkAbort(signal);
      const value = validateLoginInput(input);
      let page;
      try {
        page = await activeLoginPage();
      } catch (error) {
        await releasePointer().catch(() => {});
        throw error;
      }
      checkAbort(signal);
      if (pointerPage && pointerPage !== page) {
        await releasePointer().catch(() => {});
        throw failure("登录页面已切换，已释放上一页面指针，请重新拖动", site);
      }
      if (pointerPage && value.type !== "pointer")
        throw failure("请先结束当前手动拖动，再执行其他登录操作", site);
      if (value.type === "pointer") {
        // Only forward the user's actual pointer samples. No interpolation,
        // inferred target, synthetic trajectory, or automatic challenge solving.
        if (value.phase === "down") {
          if (pointerPage) throw failure("指针已按下，不能重复开始拖动", site);
          pointerPage = page;
          try {
            await page.mouse.move(value.x, value.y);
            await page.mouse.down();
          } catch (error) {
            await releasePointer().catch(() => {});
            throw error;
          }
        } else if (value.phase === "move") {
          if (!pointerPage)
            throw failure("指针尚未按下，不能发送拖动轨迹", site);
          try {
            await page.mouse.move(value.x, value.y);
          } catch (error) {
            await releasePointer().catch(() => {});
            throw error;
          }
        } else if (pointerPage) {
          try {
            await page.mouse.move(value.x, value.y);
          } finally {
            await releasePointer();
          }
        }
      } else if (value.type === "click")
        await page.mouse.click(value.x, value.y);
      else if (value.type === "drag") {
        // Compatibility for whole user gestures. Live pointer events above are
        // preferred when a user must see intermediate feedback.
        try {
          await page.mouse.move(value.fromX, value.fromY);
          await page.mouse.down();
          checkAbort(signal);
          await page.mouse.move(value.toX, value.toY, { steps: 20 });
        } finally {
          await page.mouse.up();
        }
      } else if (value.type === "scroll")
        await page.mouse.wheel(0, value.deltaY);
      else if (value.type === "text")
        await page.keyboard.insertText(value.text);
      else await page.keyboard.press(value.key);
      if (signal?.aborted) {
        await releasePointer().catch(() => {});
        checkAbort(signal);
      }
      if (!allowedLoginURL(page.url())) {
        await releasePointer().catch(() => {});
        throw failure("登录页面已离开允许的域名，后续操作已停止", site);
      }
      return { site, accepted: true };
    },
    async resume({ signal } = {}) {
      checkAbort(signal);
      if (phase !== "idle") throw failure("采集器正忙");
      if (pendingChallenge) assertChallengePage(pendingChallenge);
      if (pendingChallenge && (!challengeCurrent() || pendingChallenge.state !== "verified"))
        throw new CollectionError("VERIFICATION_REQUIRED", "原搜索验证尚未通过，保留页面等待手动确认", pendingChallenge.site);
      const proof = nativeProofs.get(site);
      if (retainedNative() && (mode === "background" || (mode === "login" && proof?.context === context && proof.epoch === epoch && proof.page === loginRoot && !proof.page.isClosed()))) {
        await releasePointer();
        checkAbort(signal);
        const current = context, generation = epoch;
        for (const page of current.pages())
          if (!isProtectedPage(page)) await page.close();
        checkAbort(signal);
        if (context !== current || epoch !== generation || !retainedNative()) throw failure("交接期间原生浏览器会话已变化，请重新确认连接");
        mode = "background";
      } else await close({ signal });
      lastError = null;
      return { mode, phase, native_context_retained: retainedNative(), retry_scope_key: pendingChallenge?.state === "verified" ? pendingChallenge.scopeKey : null };
    },
    cancelOperation: () => cancelOperation(),
    close,
  };
}
