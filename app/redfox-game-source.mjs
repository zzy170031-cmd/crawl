import { RedfoxSourceError, redfoxTransportDiagnostic } from "./redfox-error.mjs";
// Bounded paid API reader. No browser session, retries, scheduler or credentials
// are owned here. Raw public receipts let the bridge independently replay it.
export const REDFOX_GAME_ENDPOINT =
  "https://redfox.hk/story/api/dy/data/searchWork";
const MARKER = "redfox_game_search";
const DAY = 86400000;
const RAW_FIELDS = [
  "videoId",
  "videoType",
  "content",
  "authorName",
  "opusUrl",
  "coverUrl",
  "publishTime",
  "duration",
  "likeCount",
  "commentCount",
  "shareCount",
  "collectCount",
];
function fail(message, code = "SOURCE_FAILED") {
  throw new RedfoxSourceError(message,code);
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function iso(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) fail("红狐采集时间无效");
  return d.toISOString();
}
function options(payload) {
  const keyword =
    typeof payload.keyword === "string"
      ? payload.keyword.normalize("NFKC").trim()
      : "";
  if (
    payload.provider !== "redfox" ||
    !keyword ||
    keyword.length > 200 ||
    ![24, 72, 168].includes(payload.hours) ||
    !["likes", "recent", "relevance"].includes(payload.sort) ||
    !integer(payload.limit ?? 30, 20, 30) ||
    !["game-research", "game-learning"].includes(payload.purpose)
  )
    fail(
      "红狐游戏搜索参数无效；支持1、3、7个完整自然日和20至30条视频",
      "SOURCE_UNSUPPORTED",
    );
  return {
    keyword,
    hours: payload.hours,
    sort: payload.sort,
    limit: payload.limit ?? 30,
  };
}
export function redfoxGameScope(payload, at) {
  const input = options(payload);
  const today = new Date(new Date(iso(at)).getTime() + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  return {
    site: "redfox",
    platform: "douyin",
    type: "video",
    keyword: input.keyword,
    hours: input.hours,
    sort: input.sort,
    timezone: "Asia/Shanghai",
    start_date: new Date(midnight - (input.hours / 24) * DAY)
      .toISOString()
      .slice(0, 10),
    end_date: new Date(midnight - DAY).toISOString().slice(0, 10),
    date_semantics: "complete_calendar_days_through_yesterday",
    update_policy: "T+1",
    exact_match: true,
  };
}
function requestFor(scope, page) {
  return {
    keyword: scope.keyword,
    exactMatch: true,
    startDate: scope.start_date,
    endDate: scope.end_date,
    pageNum: page,
    pageSize: 50,
  };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
function equal(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function publicResponse(response, page) {
  const data = response?.data;
  if (
    response?.code !== 2000 ||
    !data ||
    data.pageNum !== page ||
    data.pageSize !== 50 ||
    !integer(data.total) ||
    !Array.isArray(data.list) ||
    data.list.length > 50 ||
    data.list.length >
      Math.min(50, Math.max(0, data.total - (page - 1) * 50)) ||
    (data.total === 0 && (page !== 1 || data.list.length)) ||
    (data.total > 0 && (!data.list.length || (page - 1) * 50 >= data.total))
  )
    fail(`红狐返回码、页码、条数或总量不合法，未当作空结果（code=${Number.isSafeInteger(response?.code)?response.code:"unknown"}，page=${Number.isSafeInteger(data?.pageNum)?data.pageNum:"unknown"}，total=${Number.isSafeInteger(data?.total)?data.total:"unknown"}）`);
  return {
    code: 2000,
    data: {
      pageNum: page,
      pageSize: 50,
      total: data.total,
      list: data.list.map((row) =>
        Object.fromEntries(
          RAW_FIELDS.filter((k) => row?.[k] !== undefined).map((k) => [
            k,
            row[k],
          ]),
        ),
      ),
    },
  };
}
function parseRow(row, scope, receivedAt, page, position) {
  if (typeof row.videoId !== "string" || !/^\d{10,25}$/.test(row.videoId))
    fail("红狐视频ID必须为未丢失精度的字符串");
  if (![0, 63, 68, "0", "63", "68"].includes(row.videoType))
    fail("红狐返回未知作品类型");
  if (
    typeof row.content !== "string" ||
    row.content.length > 1000 ||
    typeof row.authorName !== "string" ||
    row.authorName.length > 200
  )
    fail("红狐作品正文或作者字段无效");
  if (
    typeof row.publishTime !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.publishTime)
  )
    fail("红狐发布日期无效");
  const timestamp = Date.parse(row.publishTime.replace(" ", "T") + "+08:00");
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp + 8 * 3600000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ") !== row.publishTime
  )
    fail("红狐发布日期不是有效北京时间");
  if (
    !integer(row.duration) ||
    (String(row.videoType) === "0" && !row.duration)
  )
    fail("红狐视频时长必须是正毫秒数");
  for (const key of ["likeCount", "commentCount", "shareCount", "collectCount"])
    if (row[key] !== undefined && row[key] !== null && !integer(row[key]))
      fail("红狐作品指标无效");
  if (typeof row.opusUrl !== "string") fail("红狐作品链接类型无效");
  let link;
  try {
    link = new URL(row.opusUrl);
  } catch {
    fail("红狐作品链接无效");
  }
  if (
    link.protocol !== "https:" ||
    link.username ||
    link.password ||
    !(
      (link.hostname === "www.iesdouyin.com" &&
        link.pathname === `/share/video/${row.videoId}`) ||
      (link.hostname === "www.douyin.com" &&
        link.pathname === `/video/${row.videoId}`)
    )
  )
    fail("红狐作品链接与ID不一致");
  if (row.coverUrl != null && row.coverUrl !== "") {
    if (typeof row.coverUrl !== "string") fail("红狐预览图URL类型无效");
    let cover;
    try {
      cover = new URL(row.coverUrl);
    } catch {
      fail("红狐预览图URL无效");
    }
    if (cover.protocol !== "https:" || cover.username || cover.password)
      fail("红狐预览图必须为公开HTTPS链接");
  }
  const day = row.publishTime.slice(0, 10);
  const reason =
    day < scope.start_date || day > scope.end_date
      ? "outside_date_range"
      : ![row.content, row.authorName].some((t) =>
            t.normalize("NFKC").includes(scope.keyword),
          )
        ? "keyword_mismatch"
        : String(row.videoType) !== "0"
          ? "non_video"
          : null;
  if (reason) return { excluded: { source_id: row.videoId, reason, page } };
  return {
    record: {
      kind: "video",
      source_id: row.videoId,
      source_url: `https://www.douyin.com/video/${row.videoId}`,
      observed_url: REDFOX_GAME_ENDPOINT,
      source_endpoint: MARKER,
      title: row.content,
      author: row.authorName,
      cover_url: row.coverUrl || null,
      duration_ms: row.duration,
      publish_time_raw: row.publishTime,
      published_at: new Date(timestamp).toISOString(),
      published_text: day,
      publication_precision: "date",
      published_date: day,
      like_count: row.likeCount ?? null,
      comment_count: row.commentCount ?? null,
      share_count: row.shareCount ?? null,
      collect_count: row.collectCount ?? null,
      like_display: row.likeCount == null ? null : String(row.likeCount),
      metric_precision: "observed",
      play_count: null,
      score: null,
      source_rank: null,
      source_updated_at: null,
      collected_at: receivedAt,
      page,
      position_in_response: position,
    },
  };
}
function rebuild(pages, payload, startedAt, finishedAt, maxPages, maxRequests) {
  const input = options(payload),
    scope = redfoxGameScope(payload, startedAt);
  if (
    !integer(maxPages, 1, 3) ||
    !integer(maxRequests, 1, 3) ||
    !Array.isArray(pages) ||
    !pages.length ||
    pages.length > Math.min(maxPages, maxRequests)
  )
    fail("红狐请求次数超过明确预算");
  const ids = new Set(),
    eligible = [],
    excluded = [];
  let previousAt = Date.parse(startedAt),
    stop = null,
    total = null,
    totalChanged = false;
  for (let i = 0; i < pages.length; i++) {
    if (stop) fail("红狐达到停止条件后仍请求了更多页面");
    const receipt = pages[i],
      at = Date.parse(receipt.received_at);
    if (
      !equal(receipt.request, requestFor(scope, i + 1)) ||
      !Number.isFinite(at) ||
      at < previousAt ||
      at > Date.parse(finishedAt)
    )
      fail("红狐请求范围或采集时间不一致");
    if (
      !equal(Object.keys(receipt).sort(), [
        "received_at",
        "request",
        "response",
      ])
    )
      fail("红狐页面凭据含有未允许字段");
    const raw = publicResponse(receipt.response, i + 1);
    if (!equal(raw, receipt.response)) fail("红狐页面凭据含有未允许的原始字段");
    previousAt = at;
    if (total !== null && total !== raw.data.total) totalChanged = true;
    if (total === null) total = raw.data.total;
    let newCount = 0;
    raw.data.list.forEach((row, index) => {
      const parsed = parseRow(
        row,
        scope,
        receipt.received_at,
        i + 1,
        index + 1,
      );
      if (ids.has(row.videoId)) {
        excluded.push({
          source_id: row.videoId,
          reason: "duplicate",
          page: i + 1,
        });
        return;
      }
      ids.add(row.videoId);
      newCount++;
      if (parsed.record) eligible.push(parsed.record);
      else excluded.push(parsed.excluded);
    });
    if (totalChanged) stop = "total_changed";
    else if (raw.data.total === 0) stop = "empty_result";
    else if (!newCount) stop = "repeated_page";
    else if (eligible.length >= input.limit) stop = "sample_limit";
    else if ((i + 1) * 50 >= raw.data.total)
      stop = ids.size === raw.data.total ? "source_exhausted" : "source_gap";
    else if (raw.data.list.length < 50) stop = "short_page";
    else if (i + 1 === Math.min(maxPages, maxRequests)) stop = "request_budget";
  }
  if (!stop) fail("红狐分页未到停止条件，不能宣称采集完成");
  eligible.sort(
    input.sort === "likes"
      ? (a, b) => (b.like_count ?? -1) - (a.like_count ?? -1)
      : input.sort === "recent"
        ? (a, b) => b.published_at.localeCompare(a.published_at)
        : () => 0,
  );
  const records = eligible.slice(0, input.limit);
  for (const row of eligible.slice(input.limit))
    excluded.push({
      source_id: row.source_id,
      reason: "sample_limit",
      page: row.page,
    });
  const complete = ["empty_result", "source_exhausted"].includes(stop);
  const sortBasis =
    input.sort === "likes"
      ? "已获取样本按点赞数降序，不是全库热榜"
      : input.sort === "recent"
        ? "已获取样本按发布日期降序，不是全库最新排序"
        : "API原始响应顺序，不推断相关度或官方排名";
  return {
    records,
    source_endpoint: MARKER,
    observed_scope: scope,
    api_pages: pages,
    api_pagination: {
      status: complete ? "complete" : "partial",
      stop_reason: stop,
      reported_total: total,
      collected_unique_count: ids.size,
      returned_video_count: records.length,
      request_count: pages.length,
      max_pages: maxPages,
      max_requests: maxRequests,
      total_changed: totalChanged,
    },
    excluded_records: excluded,
    failures: [],
    started_at: startedAt,
    searched_at: finishedAt,
    source_updated_at: null,
    scope: `红狐抖音广域库，T+1；北京时间${scope.start_date}至${scope.end_date}完整自然日；实际采集${ids.size}条作品，保留${records.length}条普通视频；${complete ? "已读取接口声明范围" : "有界采样，非完整全库榜单"}。上游实际更新时间未知。`,
    sort_basis: sortBasis,
  };
}
// The bridge calls this on untrusted collector output; rebuild every record and
// stop decision from narrowly whitelisted receipts, rather than trusting flags.
// Offline replay only: downstream tasks consume the saved query, never search.
export function replayRedfoxGameResult(value, payload) {
  return rebuild(value.api_pages, payload, value.started_at, value.searched_at,
    value.api_pagination?.max_pages, value.api_pagination?.max_requests);
}
export function validateRedfoxGameResult(
  value,
  payload,
  { createdAt, now = new Date() } = {},
) {
  if (!value || value.source_endpoint !== MARKER) fail("红狐来源标记无效");
  const startedAt = iso(value.started_at),
    finishedAt = iso(value.searched_at);
  if (
    Date.parse(startedAt) > Date.parse(finishedAt) ||
    Date.parse(finishedAt) > Date.parse(iso(now)) + 300000 ||
    (createdAt && Date.parse(startedAt) < Date.parse(iso(createdAt)))
  )
    fail("红狐凭据不属于当前请求或时间无效");
  const result = rebuild(
    value.api_pages,
    payload,
    startedAt,
    finishedAt,
    value.api_pagination?.max_pages,
    value.api_pagination?.max_requests,
  );
  if (!equal(value, result)) fail("红狐结果与原始响应、范围或分页证据不一致");
  return result;
}
export function createRedfoxGameSource({
  fetch: fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  apiKey,
  maxPages = 3,
  maxRequests = 3,
  timeoutMs = 30000,
} = {}) {
  if (
    !integer(maxPages, 1, 3) ||
    !integer(maxRequests, 1, 3) ||
    !integer(timeoutMs, 1, 120000)
  )
    fail("红狐请求预算或超时配置无效");
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
        scope = redfoxGameScope(payload, startedAt),
        credential = await key();
      if (requestCreatedAt) {
        const requested = redfoxGameScope(payload, requestCreatedAt);
        if (requested.start_date !== scope.start_date || requested.end_date !== scope.end_date)
          fail("查询日期已变化，未调用红狐；请重新点击开始查询", "SOURCE_SCOPE_MISMATCH");
      }
      if (!credential) fail("尚未配置红狐API密钥", "SOURCE_AUTH_REQUIRED");
      const pages = [];
      for (let page = 1; page <= Math.min(maxPages, maxRequests); page++) {
        if (signal?.aborted) fail("红狐采集已取消", "SOURCE_CANCELLED");
        const request = requestFor(scope, page),
          controller = new AbortController();
        let rejectCancellation;
        const cancellation = new Promise((_, reject) => {
          rejectCancellation = reject;
        });
        const abort = () => {
          controller.abort();
          rejectCancellation(new Error("cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        let timeout,
          didTimeout = false;
        const deadline = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            didTimeout = true;
            controller.abort();
            reject(new Error("deadline"));
          }, timeoutMs);
        });
        let response;
        try {
          response = await Promise.race([
            (async () => {
              const res = await fetchImpl(REDFOX_GAME_ENDPOINT, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  REDFOX_API_KEY: credential,
                },
                body: JSON.stringify(request),
                redirect: "error",
                signal: controller.signal,
              });
              if (res.status !== 200 || res.redirected)
                fail("红狐HTTP请求失败");
              const body = await res.text();
              if (body.length > 2000000 || body.includes(credential))
                fail("红狐响应大小异常或包含敏感字段");
              try { return JSON.parse(body); }
              catch { fail("红狐游戏查询返回的正文不是有效JSON，未当作空结果"); }
            })(),
            deadline,
            cancellation,
          ]);
        } catch (error) {
          if (signal?.aborted) fail("红狐采集已取消", "SOURCE_CANCELLED");
          if (didTimeout)
            fail("红狐单次请求超时，未自动重试", "SOURCE_TIMEOUT");
          if (error instanceof RedfoxSourceError) throw error;
          fail(`红狐游戏查询单次传输失败，未自动重试（${redfoxTransportDiagnostic(error)}）`);
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        }
        pages.push({
          request,
          received_at: iso(clock()),
          response: publicResponse(response, page),
        });
        // A temporary bounded budget of this page makes the replay expose the
        // natural stop reason, or request_budget when another page is needed.
        const probe = rebuild(
          pages,
          payload,
          startedAt,
          iso(clock()),
          page,
          page,
        );
        if (
          probe.api_pagination.stop_reason !== "request_budget" ||
          page === Math.min(maxPages, maxRequests)
        )
          return rebuild(
            pages,
            payload,
            startedAt,
            iso(clock()),
            maxPages,
            maxRequests,
          );
      }
      fail("红狐采集没有产生可核验结果");
    },
  };
}
