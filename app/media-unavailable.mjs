// Only explicit, source-bound observations may skip a learning candidate.
// Transport, extraction and model errors must remain ordinary failures.
export class MediaUnavailableError extends Error {
  constructor(observation) {
    const { source_id, url, reason, observed_at } = observation;
    const source = new URL(url);
    if (
      !/^\d{10,25}$/.test(source_id) ||
      source.origin !== "https://www.douyin.com" ||
      source.pathname !== `/video/${source_id}` ||
      source.username ||
      source.password ||
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > 1000 ||
      typeof observed_at !== "string" ||
      !Number.isFinite(Date.parse(observed_at)) ||
      Date.parse(observed_at) > Date.now() + 5 * 60000
    )
      throw Error("不可读原片观察缺少有效身份、原因或时间");
    super(`原片不可读 ${observation.source_id}：${observation.reason}`);
    this.name = "MediaUnavailableError";
    this.code = "MEDIA_UNAVAILABLE";
    this.observation = {
      status: "unavailable",
      source_id,
      url,
      reason,
      observed_at,
    };
  }
}
