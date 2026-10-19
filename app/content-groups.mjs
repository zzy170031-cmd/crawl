import { randomUUID } from "node:crypto";
const valid = (id) => typeof id === "string" && /^\d{10,25}$/.test(id);
// Content equivalence is explicit evidence, never guessed from titles. Original
// source rows remain immutable; this table only records a reversible grouping.
export class ContentGroups {
  constructor(db) {
    this.db = db;
    db.db
      .exec(`CREATE TABLE IF NOT EXISTS content_groups(id TEXT PRIMARY KEY,basis TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_group_members(source_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_group_events(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,source_ids TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);`);
  }
  lookup(sourceId) {
    return (
      this.db.db
        .prepare(
          "SELECT g.* FROM content_groups g JOIN content_group_members m ON m.group_id=g.id WHERE m.source_id=?",
        )
        .get(sourceId) || null
    );
  }
  key(rowOrId) {
    const id =
      typeof rowOrId === "string"
        ? rowOrId.replace(/^video:/, "")
        : rowOrId.source_id || rowOrId.id?.replace(/^video:/, "");
    return this.lookup(id)?.id || "source:" + id;
  }
  set(sourceIds, reason) {
    const ids = [...new Set(sourceIds)];
    if (ids.length < 2 || ids.length > 100 || ids.some((id) => !valid(id)))
      throw Error("分组需2–100个具体视频ID");
    if (typeof reason !== "string" || !reason.trim() || reason.length > 1000)
      throw Error("须记录用户确认同内容的依据");
    return this.db.transaction(() => {
      const previous = [
        ...new Set(ids.map((id) => this.lookup(id)?.id).filter(Boolean)),
      ];
      if (previous.length > 1)
        throw Error("这些来源已经属于不同内容组，需先逐组核验，不自动合并");
      const id = previous[0] || "content:" + randomUUID(),
        at = new Date().toISOString();
      if (!previous.length)
        this.db.db
          .prepare("INSERT INTO content_groups VALUES(?,?,?,?)")
          .run(id, "user_confirmed", reason.trim(), at);
      for (const sourceId of ids)
        this.db.db
          .prepare("INSERT OR IGNORE INTO content_group_members VALUES(?,?,?)")
          .run(sourceId, id, at);
      this.db.db
        .prepare("INSERT INTO content_group_events VALUES(?,?,?,?,?)")
        .run(randomUUID(), id, JSON.stringify(ids), reason.trim(), at);
      return this.get(id);
    });
  }
  get(id) {
    const group = this.db.db
      .prepare("SELECT * FROM content_groups WHERE id=?")
      .get(id);
    return group
      ? {
          ...group,
          source_ids: this.db.db
            .prepare(
              "SELECT source_id FROM content_group_members WHERE group_id=? ORDER BY created_at,source_id",
            )
            .all(id)
            .map((r) => r.source_id),
        }
      : null;
  }
  list() {
    return this.db.db
      .prepare("SELECT id FROM content_groups ORDER BY created_at")
      .all()
      .map((g) => this.get(g.id));
  }
  annotate(rows) {
    return rows.map((row) => {
      const group = row.kind === "video" ? this.lookup(row.source_id) : null;
      return {
        ...row,
        content_group_id: group?.id || `${row.kind}:${row.source_id}`,
        content_group_basis: group?.basis || null,
      };
    });
  }
  independentCount(idsOrRows) {
    return new Set(idsOrRows.map((value) => this.key(value))).size;
  }
  display(rows) {
    const grouped = new Map();
    for (const row of this.annotate(rows)) {
      const key = row.content_group_id;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    return [...grouped.values()].map((sources) => ({
      ...sources[0],
      source_count: sources.length,
      grouped_sources: sources,
    }));
  }
}
