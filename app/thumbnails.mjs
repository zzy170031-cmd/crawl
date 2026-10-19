import { realpath, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./config.mjs";
export async function thumbnailPath(id, folder = dataDir) {
  if (typeof id !== "string" || !/^\d{10,25}$/.test(id)) return null;
  try {
    const root = await realpath(folder),
      expected = join(root, "media", id, "thumbnail.jpg");
    const actual = await realpath(join(folder, "media", id, "thumbnail.jpg"));
    if (actual !== expected) return null;
    const info = await stat(actual);
    if (!info.isFile() || info.size < 3 || info.size > 10 * 1024 * 1024)
      return null;
    return actual;
  } catch {
    return null;
  }
}
export async function readThumbnail(id, folder = dataDir) {
  const path = await thumbnailPath(id, folder);
  if (!path) return null;
  try {
    const bytes = await readFile(path);
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? bytes
      : null;
  } catch {
    return null;
  }
}
export async function thumbnailProvenance(id, folder = dataDir) {
  if (typeof id !== "string" || !/^\d{10,25}$/.test(id)) return null;
  try {
    const root = await realpath(folder),
      expected = join(root, "media", id, "thumbnail.json");
    const actual = await realpath(join(folder, "media", id, "thumbnail.json"));
    if (actual !== expected || (await stat(actual)).size > 10000) return null;
    const value = JSON.parse(await readFile(actual, "utf8"));
    if (!["source_cover", "video_frame"].includes(value.kind)) return null;
    const source = new URL(value.source_url);
    if (
      source.protocol !== "https:" ||
      source.username ||
      source.password ||
      !Number.isFinite(Date.parse(value.observed_at))
    )
      return null;
    return {
      kind: value.kind,
      source_url: source.href,
      observed_at: value.observed_at,
      ...(Number.isFinite(value.frame_time) && value.frame_time >= 0
        ? { frame_time: value.frame_time }
        : {}),
    };
  } catch {
    return null;
  }
}
export function safeSourceCover(row) {
  if (row?.provider !== "redfox" || !["redfox_game_search","redfox_daily_hot"].includes(row.source_endpoint)) return null;
  try {const u=new URL(row.cover_url);return u.protocol==="https:" && !u.port && !u.username && !u.password && u.hostname.endsWith(".douyinpic.com") ? u.href : null;} catch {return null;}
}
export async function annotateThumbnails(rows, folder = dataDir) {
  return Promise.all(
    rows.map(async (row) => {
      const available =
        row.kind === "video" && (await thumbnailPath(row.source_id, folder));
      return {
        ...row,
        thumbnail_url: available
          ? `/api/media/${row.source_id}/thumbnail`
          : safeSourceCover(row),
        thumbnail_provenance: available
          ? await thumbnailProvenance(row.source_id, folder)
          : safeSourceCover(row) ? {kind:"source_cover",source_url:row.cover_url,observed_at:row.collected_at} : null,
      };
    }),
  );
}
