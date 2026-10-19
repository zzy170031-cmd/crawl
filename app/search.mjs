import { config, mediaURL } from "./config.mjs";
import { createRequire } from "node:module";
import { resolveCategory } from "./categories.mjs";
const require = createRequire(import.meta.url);
let busy = false;
export async function searchSource({
  keyword = "",
  hours = 24,
  board = null,
  category = "all",
}) {
  if (typeof keyword !== "string" || keyword.length > 80)
    throw Error("关键词不能超过80字");
  if (![1, 24, 72, 168].includes(hours)) throw Error("时间窗口无效");
  if (
    board !== null &&
    ![1001, 1002, 1003, 1004, 1005, 2001, 2002, 3001, 3002].includes(board)
  )
    throw Error("榜单无效");
  const selectedCategory = resolveCategory(category);
  if (selectedCategory && board >= 2000)
    throw Error("行业筛选仅适用于视频榜，请选择视频榜单。");
  if (busy) throw Error("另一项主动搜索正在进行，请稍后再试");
  busy = true;
  let browser;
  try {
    const { chromium } = require("playwright-core");
    try {
      browser = await chromium.connectOverCDP(config.cdp, { timeout: 10000 });
    } catch {
      const error = Error(
        "后台未连接到专用浏览器；右侧浏览器登录不等于后台采集已连接",
      );
      error.code = "BROWSER_UNAVAILABLE";
      throw error;
    }
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().startsWith("https://douhot.douyin.com/"));
    if (!page) throw Error("请打开专用 Chrome 并登录热点宝");
    const records = [],
      failures = [];
    const boards = board
      ? [board]
      : selectedCategory
        ? [1001, 1002, 1003, 1004, 1005]
        : [1001, 1002, 1003, 1004, 1005, 2001, 2002, 3001, 3002];
    for (const sub of boards) {
      const kind = sub < 2000 ? "video" : sub < 3000 ? "topic" : "search";
      const path =
        kind === "search"
          ? "/douhot/v1/dashboard/hot_search/query_list"
          : `/douhot/v1/material/${kind === "video" ? "video" : "challenge"}_billboard`;
      const request = {
        sub_type: sub,
        date_window: hours,
        page_size: 20,
        [kind === "search" ? "page_num" : "page"]: 1,
      };
      if (keyword.trim()) request.keyword = keyword.trim();
      if (kind !== "search") request.tag_version = "v2";
      if (selectedCategory) request.tags = selectedCategory.tags;
      try {
        const result = await page.evaluate(
          async ({ path, request }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            try {
              const r = await fetch(path, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
                signal: controller.signal,
              });
              return { status: r.status, body: await r.json() };
            } finally {
              clearTimeout(timer);
            }
          },
          { path, request },
        );
        if (result.status !== 200 || result.body?.code !== 0)
          throw Error("source-failed");
        const list =
          kind === "search"
            ? result.body.data?.search_list
            : result.body.data?.objs;
        if (!Array.isArray(list)) throw Error("schema");
        const at = new Date().toISOString();
        list.forEach((v, i) => {
          const id = v.item_id ?? v.challenge_id ?? v.key_word;
          if (id == null) return;
          records.push({
            kind,
            source_id: String(id),
            title: v.item_title ?? v.challenge_name ?? v.key_word ?? "",
            sub_type: sub,
            date_window: hours,
            category_filter: selectedCategory?.tags ?? null,
            category_label: selectedCategory?.label || "不限行业",
            page: 1,
            position_in_response: i + 1,
            source_rank: v.show_rank ?? null,
            score: v.score ?? v.search_score ?? null,
            play_count: v.play_cnt ?? null,
            like_count: v.like_cnt ?? null,
            publish_count: v.publish_cnt ?? null,
            author: v.nick_name ?? null,
            collected_at: at,
            source_updated_at: null,
            trends: v.trends ?? [],
            source_endpoint: path,
            search_keyword: keyword.trim(),
          });
        });
      } catch {
        failures.push(sub);
      }
    }
    if (failures.length === boards.length)
      throw Error("热点宝搜索失败，请检查专用 Chrome 的登录状态或网络");
    return {
      records,
      failures,
      keyword: keyword.trim(),
      hours,
      searched_at: new Date().toISOString(),
      scope: "热点宝榜单关键词搜索，每个榜单首屏最多 20 条，不等于抖音全站搜索",
    };
  } catch (e) {
    const error = Error(String(e.message).split("\n")[0]);
    error.code = e.code;
    throw error;
  } finally {
    busy = false;
    await browser?.close();
  }
}
