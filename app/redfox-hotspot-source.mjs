import { RedfoxSourceError, redfoxTransportDiagnostic } from "./redfox-error.mjs";
// Redfox daily hot works: one bounded response, not Douyin Hotspot Bao.
export const REDFOX_HOTSPOT_ENDPOINT =
  "https://redfox.hk/story/api/dy/search/likesRank";
export const REDFOX_HOTSPOT_CATEGORIES = Object.freeze([
  "小剧场",
  "财富理财",
  "二次元",
  "身体锻炼",
  "居家装修",
  "数码科技",
  "科学普及",
  "旅行",
  "美食",
  "动物",
  "明星娱乐",
  "汽车",
  "亲子",
  "人文",
  "三农",
  "潮流风尚",
  "游戏",
  "生活记录",
  "体育",
  "舞蹈才艺",
  "学习教育",
  "休闲玩乐",
  "影视",
  "音乐",
  "颜值造型",
  "健康医学",
  "综艺",
  "个人成长",
]);
const MARKER = "redfox_daily_hot";
const FIELDS = [
  "workId",
  "workUrl",
  "workType",
  "content",
  "title",
  "accountName",
  "category",
  "coverUrl",
  "publishTime",
  "duration",
  "likeCount",
  "commentCount",
  "collectCount",
  "shareCount",
];
function fail(message, code = "SOURCE_FAILED") {
  throw new RedfoxSourceError(message, code);
}
function iso(at) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) fail("红狐每日榜采集时间无效");
  return d.toISOString();
}
function canonical(x) {
  return Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
}
function same(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function validNumber(x) {
  return Number.isSafeInteger(x) && x >= 0;
}
export function redfoxHotspotScope(payload, at) {
  if (
    payload?.provider !== "redfox" ||
    payload.purpose !== "hotspots" ||
    payload.board !== MARKER ||
    ![24, 72, 168].includes(payload.hours) ||
    !(
      payload.category === "all" ||
      REDFOX_HOTSPOT_CATEGORIES.includes(payload.category)
    ) ||
    (payload.keyword != null &&
      (typeof payload.keyword !== "string" || payload.keyword.length > 200))
  )
    fail("红狐每日热门作品榜参数无效", "SOURCE_UNSUPPORTED");
  const day = new Date(Date.parse(iso(at)) + 8 * 3600000)
      .toISOString()
      .slice(0, 10),
    midnight = Date.parse(`${day}T00:00:00Z`);
  return {
    site: "redfox",
    platform: "douyin",
    board: MARKER,
    type: "video",
    hours: payload.hours,
    category: payload.category,
    local_keyword: (payload.keyword || "").normalize("NFKC").trim(),
    keyword_filter: "local_content_or_title_or_author",
    timezone: "Asia/Shanghai",
    start_date: new Date(midnight - (payload.hours / 24) * 86400000)
      .toISOString()
      .slice(0, 10),
    end_date: new Date(midnight - 86400000).toISOString().slice(0, 10),
    date_semantics: "complete_calendar_days_through_yesterday",
    update_policy: "T+1",
    upstream_schedule: "daily_after_10_Asia_Shanghai",
    source_updated_at: null,
  };
}
function requestFor(scope) {
  return {
    ...(scope.category === "all" ? {} : { type: scope.category }),
    startTime: scope.start_date,
    endTime: scope.end_date,
  };
}
function publicResponse(value) {
  if (
    value?.code !== 2000 ||
    !Array.isArray(value.data) ||
    value.data.length > 5000
  )
    fail(`红狐每日榜响应结构或数量不合法，未当作空结果（code=${Number.isSafeInteger(value?.code) ? value.code : "unknown"}，rows=${Array.isArray(value?.data) ? value.data.length : "non-array"}）`);
  return {
    code: 2000,
    data: value.data.map((row) =>
      Object.fromEntries(
        FIELDS.filter((k) => row?.[k] !== undefined).map((k) => [k, row[k]]),
      ),
    ),
  };
}
function parseRow(row, scope, at, position) {
  if (typeof row.workId !== "string" || !/^\d{10,25}$/.test(row.workId))
    fail("红狐作品ID必须为精度完整的字符串");
  if (
    row.workType != null &&
    !(
      (typeof row.workType === "string" && /^\d{1,4}$/.test(row.workType)) ||
      (Number.isSafeInteger(row.workType) &&
        row.workType >= 0 &&
        row.workType < 10000)
    )
  )
    fail("红狐作品类型字段无效");
  if (
    typeof row.workUrl !== "string" ||
    (row.coverUrl != null && typeof row.coverUrl !== "string")
  )
    fail("红狐作品与封面链接必须为字符串");
  for (const key of ["content", "title", "accountName", "category"])
    if (
      row[key] != null &&
      (typeof row[key] !== "string" ||
        row[key].length > (["content", "title"].includes(key) ? 10000 : 200))
    )
      fail("红狐每日榜文本字段无效");
  let url;
  try {
    url = new URL(row.workUrl);
  } catch {
    fail("红狐每日榜作品链接无效");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(
      (url.hostname === "www.iesdouyin.com" &&
        url.pathname === `/share/video/${row.workId}`) ||
      (url.hostname === "www.douyin.com" &&
        url.pathname === `/video/${row.workId}`)
    )
  )
    fail("红狐每日榜链接与作品ID不一致");
  if (row.coverUrl != null && row.coverUrl !== "") {
    let cover;
    try {
      cover = new URL(row.coverUrl);
    } catch {
      fail("红狐每日榜封面链接无效");
    }
    if (cover.protocol !== "https:" || cover.username || cover.password)
      fail("红狐每日榜封面链接无效");
  }
  if (
    typeof row.publishTime !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.publishTime)
  )
    fail("红狐每日榜发布日期无效");
  const time = Date.parse(row.publishTime.replace(" ", "T") + "+08:00");
  if (
    !Number.isFinite(time) ||
    new Date(time + 8 * 3600000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ") !== row.publishTime
  )
    fail("红狐每日榜发布日期无效");
  for (const key of [
    "likeCount",
    "commentCount",
    "collectCount",
    "shareCount",
    "duration",
  ])
    if (row[key] != null && !validNumber(row[key]))
      fail("红狐每日榜数值字段无效");
  const day = row.publishTime.slice(0, 10);
  const reason =
    day < scope.start_date || day > scope.end_date
      ? "outside_date_range"
      : scope.category !== "all" && row.category !== scope.category
        ? "category_mismatch"
        : row.workType == null ||
            !["0", "63", "68"].includes(String(row.workType))
          ? "type_unknown"
          : String(row.workType) !== "0"
            ? "non_video"
            : scope.local_keyword &&
                ![row.content, row.title, row.accountName].some(
                  (v) =>
                    typeof v === "string" &&
                    v.normalize("NFKC").includes(scope.local_keyword),
                )
              ? "local_keyword_mismatch"
              : null;
  if (reason)
    return {
      excluded: {
        source_id: row.workId,
        reason,
        position_in_response: position,
      },
    };
  return {
    record: {
      kind: "video",
      source_id: row.workId,
      source_url: `https://www.douyin.com/video/${row.workId}`,
      observed_url: REDFOX_HOTSPOT_ENDPOINT,
      source_endpoint: MARKER,
      title: row.content || row.title || "",
      content_raw: row.content ?? null,
      title_raw: row.title ?? null,
      author: row.accountName ?? null,
      category_label: row.category ?? null,
      cover_url: row.coverUrl || null,
      duration_raw: row.duration ?? null,
      duration_unit: "unknown",
      publish_time_raw: row.publishTime,
      published_at: new Date(time).toISOString(),
      published_text: day,
      published_date: day,
      publication_precision: "date",
      like_count: row.likeCount ?? null,
      comment_count: row.commentCount ?? null,
      collect_count: row.collectCount ?? null,
      share_count: row.shareCount ?? null,
      like_display: row.likeCount == null ? null : String(row.likeCount),
      metric_precision: "observed",
      score: null,
      source_rank: null,
      play_count: null,
      source_updated_at: null,
      collected_at: at,
      page: 1,
      position_in_response: position,
    },
  };
}
function rebuild(receipt, payload, startedAt, finishedAt) {
  const scope = redfoxHotspotScope(payload, startedAt),
    raw = publicResponse(receipt?.response),
    at = Date.parse(receipt.received_at);
  if (
    !same(Object.keys(receipt).sort(), [
      "received_at",
      "request",
      "response",
    ]) ||
    !same(receipt.request, requestFor(scope)) ||
    !same(raw, receipt.response) ||
    !Number.isFinite(at) ||
    at < Date.parse(startedAt) ||
    at > Date.parse(finishedAt)
  )
    fail("红狐每日榜回执范围、字段或时间无效");
  const records = [],
    excluded = [],
    ids = new Set();
  raw.data.forEach((row, index) => {
    const parsed = parseRow(row, scope, receipt.received_at, index + 1);
    if (ids.has(row.workId)) {
      excluded.push({
        source_id: row.workId,
        reason: "duplicate",
        position_in_response: index + 1,
      });
      return;
    }
    ids.add(row.workId);
    if (parsed.record) records.push(parsed.record);
    else excluded.push(parsed.excluded);
  });
  return {
    source_endpoint: MARKER,
    observed_scope: scope,
    api_receipt: receipt,
    records,
    excluded_records: excluded,
    api_pagination: {
      status: "single_response_complete",
      request_count: 1,
      response_count: raw.data.length,
      collected_unique_count: ids.size,
      returned_video_count: records.length,
      reported_total: null,
      global_completeness: "unknown",
      pagination_available: false,
    },
    failures: [],
    started_at: startedAt,
    searched_at: finishedAt,
    source_updated_at: null,
    sort_basis: "接口响应顺序；关键词仅本地过滤，不推断官方排名或全库热度排序",
    scope: `红狐每日热门作品榜，${scope.category === "all" ? "全部行业" : scope.category}；北京时间${scope.start_date}至${scope.end_date}完整自然日，T+1。完整读取本次响应${raw.data.length}条，保留${records.length}条视频；不代表全抖音或全库完整榜单。${scope.local_keyword ? `本地关键词筛选：${scope.local_keyword}。` : ""}上游实际更新时间未知。`,
  };
}
export function replayRedfoxHotspotResult(value, payload) {
  return rebuild(value.api_receipt,payload,value.started_at,value.searched_at);
}
export function validateRedfoxHotspotResult(
  value,
  payload,
  { createdAt, now = new Date() } = {},
) {
  if (value?.source_endpoint !== MARKER) fail("红狐每日榜来源标记无效");
  const startedAt = iso(value.started_at),
    finishedAt = iso(value.searched_at);
  if (
    Date.parse(startedAt) > Date.parse(finishedAt) ||
    Date.parse(finishedAt) > Date.parse(iso(now)) + 300000 ||
    (createdAt && Date.parse(startedAt) < Date.parse(iso(createdAt)))
  )
    fail("红狐每日榜回执已过期或时间无效");
  const result = rebuild(value.api_receipt, payload, startedAt, finishedAt);
  if (!same(result, value))
    fail("红狐每日榜记录、范围或完整性与原始回执不一致");
  return result;
}
export function createRedfoxHotspotSource({
  fetch: fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  apiKey,
  timeoutMs = 30000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail("红狐每日榜超时配置无效");
  async function key() {
    let value;
    try {
      value = typeof apiKey === "function" ? await apiKey() : apiKey;
    } catch {
      fail("红狐API密钥配置读取失败", "SOURCE_AUTH_REQUIRED");
    }
    return typeof value === "string" ? value.trim() : "";
  }
  return {
    async checkConnection() {
      const configured = Boolean(await key());
      return {
        status: configured ? "configured" : "unconfigured",
        configured,
        live_verified: false,
        source: "redfox",
      };
    },
    async collect(payload, { signal, requestCreatedAt } = {}) {
      const startedAt = iso(clock()),
        scope = redfoxHotspotScope(payload, startedAt),
        credential = await key();
      if (requestCreatedAt) {
        const requested = redfoxHotspotScope(payload, requestCreatedAt);
        if (requested.start_date !== scope.start_date || requested.end_date !== scope.end_date)
          fail("查询日期已变化，未调用红狐；请重新点击开始查询", "SOURCE_SCOPE_MISMATCH");
      }
      if (!credential) fail("尚未配置红狐API密钥", "SOURCE_AUTH_REQUIRED");
      if (signal?.aborted) fail("红狐每日榜采集已取消", "SOURCE_CANCELLED");
      const controller = new AbortController(),
        request = requestFor(scope);
      let timeout,
        timedOut = false,
        rejectCancellation;
      const cancelled = new Promise((_, reject) => {
        rejectCancellation = reject;
      });
      const abort = () => {
        controller.abort();
        rejectCancellation(new Error("cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("deadline"));
        }, timeoutMs);
      });
      let response;
      try {
        response = await Promise.race([
          (async () => {
            const result = await fetchImpl(REDFOX_HOTSPOT_ENDPOINT, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                REDFOX_API_KEY: credential,
              },
              body: JSON.stringify(request),
              signal: controller.signal,
              redirect: "error",
            });
            if (result.status !== 200 || result.redirected)
              fail(`红狐每日榜HTTP请求失败（status=${Number.isSafeInteger(result.status) ? result.status : "unknown"}）`);
            const body = await result.text();
            if (body.length > 10000000 || body.includes(credential))
              fail("红狐每日榜响应异常");
            try { return JSON.parse(body); }
            catch { fail("红狐每日榜返回的正文不是有效JSON，未当作空结果"); }
          })(),
          deadline,
          cancelled,
        ]);
      } catch (error) {
        if (signal?.aborted) fail("红狐每日榜采集已取消", "SOURCE_CANCELLED");
        if (timedOut) fail("红狐每日榜单次请求超时，未重试", "SOURCE_TIMEOUT");
        if (error instanceof RedfoxSourceError) throw error;
        fail(`红狐每日榜单次传输失败，未重试（${redfoxTransportDiagnostic(error)}）`);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
      const receipt = {
        request,
        received_at: iso(clock()),
        response: publicResponse(response),
      };
      return rebuild(receipt, payload, startedAt, iso(clock()));
    },
  };
}
