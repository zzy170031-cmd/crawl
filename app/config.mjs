import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const root = fileURLToPath(new URL("../", import.meta.url));
export const dataDir = resolve(root, process.env.CRAWL_DATA_DIR || "data");
export const dataURL = pathToFileURL(dataDir + "/");
export const mediaURL = (id) => {
  if (!/^\d{10,25}$/.test(id)) throw Error("具体视频ID无效");
  return pathToFileURL(join(dataDir, "media", id) + "/");
};
export function localURL(raw) {
  const u = new URL(raw);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error("服务地址须为本机HTTP地址");
  return u.origin;
}
export const config = {
  gameSource: process.env.CRAWL_GAME_SOURCE === 'redfox' ? 'redfox' : 'browser',
  hotspotSource: process.env.CRAWL_HOTSPOT_SOURCE === 'redfox' ? 'redfox' : 'browser',
  searchMode:
    process.env.CRAWL_SEARCH_MODE === "automatic" ? "automatic" : "manual",
  collectorProfile: resolve(dataDir, "collector-profile"),
  collectorExecutable: process.env.CRAWL_COLLECTOR_EXECUTABLE || undefined,
  collectorHeadlessExecutable: process.env.CRAWL_HEADLESS_EXECUTABLE || undefined,
  collectorTimeoutMs: Math.min(
    600000,
    // Full ranking pagination is paced and can cover several boards. Keep a
    // bounded job budget; individual navigation/response waits remain short.
    Math.max(10000, Number(process.env.CRAWL_COLLECTOR_TIMEOUT_MS) || 600000),
  ),
  browserMode:
    process.env.CRAWL_BROWSER_MODE === "side-browser" ? "side-browser" : "cdp",
  port: Number(process.env.PORT || 4318),
  cdp: localURL(process.env.CRAWL_CDP_URL || "http://127.0.0.1:19327"),
  modelURL: localURL(process.env.CRAWL_MODEL_URL || "http://127.0.0.1:11434"),
  model: process.env.HOTSPOT_VISION_MODEL || "qwen3-vl:8b-instruct",
  analysisModel: process.env.HOTSPOT_ANALYSIS_MODEL || process.env.HOTSPOT_VISION_MODEL || "qwen3-vl:8b-instruct",
  python:
    process.env.CRAWL_PYTHON ||
    (process.platform === "win32" ? "python" : "python3"),
};
