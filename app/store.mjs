import { dataURL } from "./config.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY, fingerprint TEXT UNIQUE, collected_at TEXT NOT NULL, payload TEXT NOT NULL);`,
  );
  return {
    import(data) {
      if (!Array.isArray(data.records) || !data.records.length)
        throw Error("没有有效记录");
      for (const r of data.records)
        if (
          !["video", "topic", "search"].includes(r.kind) ||
          !r.source_id ||
          !Number.isFinite(r.sub_type) ||
          !Number.isFinite(r.date_window) ||
          !Number.isFinite(Date.parse(r.collected_at))
        )
          throw Error("记录缺少有效标识、榜单或采集时间");
      const fp = JSON.stringify(data.records);
      const at = data.collected_at || data.records[0].collected_at;
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO snapshots(fingerprint,collected_at,payload) VALUES(?,?,?)",
        )
        .run(fp, at, JSON.stringify(data));
      return { inserted: result.changes > 0, count: data.records.length };
    },
    all() {
      return db
        .prepare(
          "SELECT id,collected_at,payload FROM snapshots ORDER BY collected_at DESC,id DESC",
        )
        .all()
        .map((s) => ({
          ...s,
          data: JSON.parse(s.payload),
          payload: undefined,
        }));
    },
    close() {
      db.close();
    },
  };
}
export function recordsForLatest(snapshots) {
  const seen = new Set(),
    rows = [];
  for (const s of snapshots) {
    const groups = new Map();
    for (const r of s.data.records) {
      const key = JSON.stringify([
        r.kind,
        r.sub_type,
        r.date_window,
        r.category_filter ?? null,
      ]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, rs] of groups) {
      if (seen.has(key)) continue;
      seen.add(key);
      const ids = new Set();
      for (const r of rs) {
        if (ids.has(r.source_id)) continue;
        ids.add(r.source_id);
        rows.push({ ...r, snapshot_id: s.id });
      }
    }
  }
  return rows;
}
export const dataDir = dataURL;
export function defaultStore() {
  mkdirSync(dataDir, { recursive: true });
  return openStore(fileURLToPath(new URL("hotspots.sqlite", dataURL)));
}
