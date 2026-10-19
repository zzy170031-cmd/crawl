import { dataURL } from "./config.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { categoryId, resolveCategory } from "./categories.mjs";
export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY, fingerprint TEXT UNIQUE, collected_at TEXT NOT NULL, payload TEXT NOT NULL);`,
  );
  return {
    import(data) {
      if (
        !Array.isArray(data.records) ||
        (!data.records.length && !data.collection_key)
      )
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
      const fp = JSON.stringify({
        records: data.records,
        // Distinct fulfilled searches can have the same timestamp and empty
        // payload. Preserve batch identity only when explicitly present; do not
        // assign request ownership to legacy snapshots.
        ...(typeof data.collection_request_id === "string"
          ? { collection_request_id: data.collection_request_id }
          : {}),
        collection_key: data.collection_key || null,
        collected_at: data.collection_key ? data.collected_at : null,
        ...(data.observed_scope ? { observed_scope: data.observed_scope } : {}),
      });
      const at = data.collected_at || data.records[0]?.collected_at;
      if (!Number.isFinite(Date.parse(at))) throw Error("采集时间无效");
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
  const scopes = new Set(),
    seen = new Set(),
    rows = [];
  for (const s of snapshots) {
    // API batches replace only their exact provider/date/filter scope, including
    // explicit empty responses. Never run Chinese API categories through the
    // legacy Douhot category normalizer or collapse them to "all".
    if (s.data.provider === "redfox") {
      const key = s.data.collection_key;
      if (!key || scopes.has(key)) continue;
      scopes.add(key);
      const ids = new Set();
      for (const row of s.data.records) {
        if (ids.has(row.source_id)) continue;
        ids.add(row.source_id);
        rows.push({...row, snapshot_id:s.id});
      }
      continue;
    }
    let collection;
    try {
      collection = JSON.parse(s.data.collection_key);
    } catch {}
    const hotspotSnapshot =
      collection?.[0] === "hotspots" ||
      s.data.records.some((r) => (r.collection || "hotspots") === "hotspots");
    // A request for every board may only have observed one board. Its request
    // key cannot invalidate the other boards from an earlier observation.
    if (s.data.collection_key && !hotspotSnapshot) {
      if (scopes.has(s.data.collection_key)) continue;
      scopes.add(s.data.collection_key);
    }
    const groups = new Map();
    for (const r of s.data.records) {
      const key =
        (r.collection || "hotspots") === "hotspots"
          ? hotspotScope(
              r.sub_type,
              r.date_window,
              categoryId(r.category_filter),
              r.search_keyword || "",
            )
          : JSON.stringify([
              r.collection || "hotspots",
              r.kind,
              r.sub_type,
              r.date_window,
              r.category_filter ?? null,
              r.search_keyword || "",
              r.source_endpoint || "",
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
    // Explicit observations cover empty results too. Legacy snapshots only
    // cover scopes evidenced by their actual rows; never infer all boards.
    const observed = s.data.observed_scope;
    const keyword =
      typeof s.data.keyword === "string"
        ? s.data.keyword
        : collection?.[0] === "hotspots" && typeof collection[1] === "string"
          ? collection[1]
          : null;
    if (
      hotspotSnapshot &&
      observed &&
      keyword !== null &&
      Array.isArray(observed.boards) &&
      Number.isFinite(observed.hours)
    ) {
      let category;
      try {
        if (typeof observed.category === "string")
          category = resolveCategory(observed.category)?.id || "all";
      } catch {}
      if (category !== undefined)
        for (const board of observed.boards)
          if (Number.isFinite(board))
            seen.add(hotspotScope(board, observed.hours, category, keyword));
    }
  }
  return rows;
}
function hotspotScope(board, hours, category, keyword) {
  return JSON.stringify(["hotspots", board, hours, category, keyword]);
}
export const dataDir = dataURL;
export function defaultStore() {
  mkdirSync(dataDir, { recursive: true });
  return openStore(fileURLToPath(new URL("hotspots.sqlite", dataURL)));
}

// A game source stays in its game; a deliberately selected general hotspot may
// be linked to any target game. Courses and related-search candidates are not
// interchangeable with selected hotspots.
export function creativeSourceFor(
  rows,
  input,
  game,
  browserMode = "side-browser",
) {
  return rows.find(
    (r) =>
      r.source_id === input.source_id &&
      r.kind === input.kind &&
      (input.snapshot_id == null || r.snapshot_id === input.snapshot_id) &&
      (browserMode !== "side-browser" ||
        (r.game === game && ["games", "learning"].includes(r.collection)) ||
        (r.game == null &&
          (r.collection === "hotspots" || r.collection == null))),
  );
}
