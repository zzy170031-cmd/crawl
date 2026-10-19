// Identity candidates come only from responses emitted by the normal source
// page. These helpers neither make requests nor accept credentials or aliases.
const VIDEO_PATH = "/douhot/v1/material/video_billboard";
const invalid = (message) => { throw Error(message); };
const normalizeText = (value) => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : "";

export function matchesObservedVideoScope(receipt, expected, expectedChildIds) {
  let url;
  try { url = new URL(receipt.url); } catch { return false; }
  const request = receipt.request;
  if (url.origin !== "https://douhot.douyin.com" || url.pathname !== VIDEO_PATH ||
      request?.sub_type !== expected.board || request?.date_window !== expected.hours) return false;
  const category = expected.category || "all";
  if (category === "all") return request.tags == null || (Array.isArray(request.tags) && request.tags.length === 0);
  const [parent, child] = String(category).split("/");
  if (!/^\d+$/.test(parent) || (child != null && !/^\d+$/.test(child)) || !Array.isArray(expectedChildIds) || !expectedChildIds.length) return false;
  const expectedChildren = expectedChildIds.map(String);
  if (new Set(expectedChildren).size !== expectedChildren.length || expectedChildren.some((value) => !/^\d+$/.test(value)) ||
      (child && (expectedChildren.length !== 1 || expectedChildren[0] !== child))) return false;
  if (!Array.isArray(request.tags) || request.tags.length !== 1) return false;
  const tag = request.tags[0];
  if (tag?.value !== Number(parent) || !Array.isArray(tag.children) || tag.children.length !== expectedChildren.length) return false;
  const actual = tag.children.map((item) => item?.value);
  return actual.every(Number.isSafeInteger) && new Set(actual).size === actual.length &&
    actual.map(String).sort().join(",") === [...expectedChildren].sort().join(",");
}

export function observedVideoIdentities(receipts, expected, expectedChildIds) {
  const matching = receipts.filter((receipt) => matchesObservedVideoScope(receipt, expected, expectedChildIds));
  if (!matching.length) invalid("未取得与当前榜单、时间及行业完全一致的正常页面响应，未打开详情页补猜身份");
  const identities = new Map();
  for (const receipt of matching) {
    if (receipt.status !== 200 || receipt.body?.code !== 0) invalid("当前范围榜单响应未成功，未将其作为有效身份或空结果");
    const rows = receipt.body?.data?.objs;
    if (!Array.isArray(rows) || rows.length > 1000) invalid("当前榜单响应结构未确认，无法核验视频身份");
    for (const [rowIndex, row] of rows.entries()) {
      // Numeric identifiers may already have lost precision in JSON parsing.
      // Require the source's exact decimal string rather than stringify them.
      if (typeof row?.item_id !== "string" || !/^\d{10,25}$/.test(row.item_id) ||
          !normalizeText(row.item_title) || !normalizeText(row.nick_name)) {
        const error = Error("榜单响应的视频ID、标题或作者结构不可核验（数字ID不作精确身份）");
        error.identity_schema_diagnostic = {
          row_index: rowIndex,
          fields: Object.fromEntries(["item_id","item_title","nick_name"].map(key=>[key,{
            type: row?.[key] === null ? "null" : typeof row?.[key],
            ...(typeof row?.[key] === "string" ? {length:row[key].length,normalized_length:normalizeText(row[key]).length} : {})
          }])),
          id_is_decimal_string: typeof row?.item_id === "string" && /^\d{10,25}$/.test(row.item_id),
          media_type: Number.isSafeInteger(row?.media_type) ? row.media_type : null,
          image_count: Number.isSafeInteger(row?.image_cnt) ? row.image_cnt : null,
        };
        throw error;
      }
      const identity = { source_id: row.item_id, title: normalizeText(row.item_title), author: normalizeText(row.nick_name) };
      const previous = identities.get(identity.source_id);
      if (previous && (previous.title !== identity.title || previous.author !== identity.author))
        invalid("同一视频ID的响应身份冲突，未选择任意版本");
      identities.set(identity.source_id, identity);
    }
  }
  return [...identities.values()];
}

export function matchVisibleVideoIdentity(identities, visible) {
  const title = normalizeText(visible.title), author = normalizeText(visible.author);
  if (!title || !author) invalid("榜单行标题或作者不可读取");
  // Real Hotspot video rows truncate long titles with three literal dots.
  // Accept only a substantial, explicit displayed prefix and an exact author.
  // Count exact and truncated candidates together so a literal-dots title
  // cannot hide an ambiguous second video in the same verified response.
  const rawTitle = typeof visible.title === "string" ? visible.title.trimEnd() : "";
  const prefix = rawTitle.endsWith("...") && title.slice(0,-3).trim().length >= 16 ? title.slice(0,-3).trimEnd() : null;
  const matches = identities.filter((item) => item.author === author &&
    (item.title === title || (prefix && item.title.startsWith(prefix))));
  if (matches.length !== 1) {
    const error = Error(matches.length ? "可见标题与作者对应多个视频ID，身份有歧义" : "可见标题及作者未与当前范围响应唯一对应");
    // Bounded public video metadata only; never attach a raw response object.
    const candidate = (item) => ({title:item.title.slice(0,200),author:item.author.slice(0,100)});
    error.identity_diagnostic = {
      visible: {title:title.slice(0,200),author:author.slice(0,100)},
      title_matches: identities.filter(item=>item.title===title).length,
      author_matches: identities.filter(item=>item.author===author).length,
      candidates: identities.filter(item=>item.title===title || item.author===author).slice(0,3).map(candidate),
      first_candidates: identities.slice(0,3).map(candidate),
    };
    throw error;
  }
  return matches[0].source_id;
}

// Receipts are appended only after the source page's response body has settled.
// Unlike draining existing reads, this also waits for responses whose headers
// have not arrived yet. It observes local buffers and never makes a request.
export function waitForObservedVideoScope(receipts, expected, expectedChildIds, { timeoutMs = 15000, signal } = {}) {
  const budget = Math.min(15000, Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : 15000));
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + budget;
    let timer;
    const finish = (error, receipt) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(receipt);
    };
    const abort = () => finish(signal.reason || Error("采集已取消"));
    const check = () => {
      if (signal?.aborted) return abort();
      const receipt = receipts.find(item => matchesObservedVideoScope(item, expected, expectedChildIds));
      if (receipt) return finish(null, receipt);
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        const error = Error("等待当前榜单、时间和行业的完整页面响应超时，未采用旧范围数据");
        error.code = "SOURCE_RESPONSE_TIMEOUT";
        return finish(error);
      }
      timer = setTimeout(check, Math.min(50, remaining));
    };
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}

export async function settleObservedResponses(reads, { timeoutMs = 5000, signal } = {}) {
  let timer, abort;
  const processed = new Set();
  const drain = async () => {
    while (true) {
      if (signal?.aborted) throw signal.reason || Error("采集已取消");
      const batch = [...reads].filter((read) => !processed.has(read));
      if (!batch.length) {
        // Allow completion callbacks to enqueue their next read before deciding
        // this mutable set is drained. The caller must also recheck it at commit.
        await Promise.resolve();
        if (![...reads].some((read) => !processed.has(read))) return;
        continue;
      }
      await Promise.allSettled(batch);
      batch.forEach((read) => processed.add(read));
    }
  };
  try {
    await Promise.race([
      drain(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("榜单响应正文尚未读取完成，未使用不完整身份")), timeoutMs);
        abort = () => reject(signal.reason || Error("采集已取消"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
