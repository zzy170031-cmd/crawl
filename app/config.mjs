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
  port: Number(process.env.PORT || 4318),
  cdp: localURL(process.env.CRAWL_CDP_URL || "http://127.0.0.1:19327"),
  modelURL: localURL(process.env.CRAWL_MODEL_URL || "http://127.0.0.1:11434"),
  model: process.env.HOTSPOT_VISION_MODEL || "qwen3-vl:8b",
  python:
    process.env.CRAWL_PYTHON ||
    (process.platform === "win32" ? "python" : "python3"),
};
