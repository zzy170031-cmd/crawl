import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.mjs";
export const hash = (v) =>
  createHash("sha256")
    .update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest("hex");
export class Tasks {
  constructor(folder = dataDir) {
    mkdirSync(folder, { recursive: true });
    this.db = new DatabaseSync(join(folder, "tasks.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, key TEXT UNIQUE, type TEXT, state TEXT, payload TEXT, result TEXT, error TEXT, stage TEXT, owner TEXT, lease INTEGER DEFAULT 0, cancelled INTEGER DEFAULT 0, created TEXT, updated TEXT);
 CREATE TABLE IF NOT EXISTS checkpoints(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS profiles(game TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS locks(key TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
 CREATE TABLE IF NOT EXISTS subscriptions(key TEXT PRIMARY KEY,value TEXT);`);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  decode(r) {
    return r
      ? {
          ...r,
          payload: JSON.parse(r.payload),
          result: r.result ? JSON.parse(r.result) : null,
        }
      : null;
  }
  get(id) {
    return this.decode(
      this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id),
    );
  }
  list() {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY created DESC LIMIT 100")
      .all()
      .map((r) => this.decode(r));
  }
  create(type, payload, revision = "") {
    const identity =
      type === "create"
        ? {
            game: payload.game,
            profile_version: payload.profile_version,
            source: {
              kind: payload.source.kind,
              source_id: payload.source.source_id,
            },
            mode: payload.mode,
            format: payload.format,
            destination: payload.destination,
          }
        : payload;
    const key = hash({ type, identity, revision });
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO tasks(id,key,type,state,payload,stage,created,updated) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        key,
        type,
        "queued",
        JSON.stringify(payload),
        "等待执行",
        now,
        now,
      );
    return this.decode(
      this.db.prepare("SELECT * FROM tasks WHERE key=?").get(key),
    );
  }
  claim(owner) {
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE tasks SET state=CASE WHEN cancelled=1 THEN 'cancelled' ELSE 'queued' END,owner=NULL WHERE state='running' AND lease<?",
        )
        .run(Date.now());
      const r = this.db
        .prepare(
          "SELECT * FROM tasks WHERE state='queued' AND cancelled=0 ORDER BY created LIMIT 1",
        )
        .get();
      if (!r) return null;
      this.db
        .prepare(
          "UPDATE tasks SET state='running',owner=?,lease=?,updated=? WHERE id=?",
        )
        .run(owner, Date.now() + 30000, new Date().toISOString(), r.id);
      return this.get(r.id);
    });
  }
  heartbeat(id, owner) {
    return (
      this.db
        .prepare(
          "UPDATE tasks SET lease=? WHERE id=? AND owner=? AND state='running'",
        )
        .run(Date.now() + 30000, id, owner).changes > 0
    );
  }
  stage(id, owner, stage) {
    if (
      !this.db
        .prepare(
          "UPDATE tasks SET stage=?,updated=? WHERE id=? AND owner=? AND state='running'",
        )
        .run(stage, new Date().toISOString(), id, owner).changes
    )
      throw Error("任务租约已失效");
  }
  finish(id, owner, state, result = null, error = null) {
    this.db
      .prepare(
        "UPDATE tasks SET state=CASE WHEN cancelled=1 THEN 'cancelled' ELSE ? END,result=?,error=?,owner=NULL,lease=0,updated=? WHERE id=? AND owner=?",
      )
      .run(
        state,
        JSON.stringify(result),
        error,
        new Date().toISOString(),
        id,
        owner,
      );
  }
  cancel(id) {
    this.db
      .prepare(
        "UPDATE tasks SET cancelled=1,state=CASE WHEN state='running' THEN state ELSE 'cancelled' END,updated=? WHERE id=? AND state NOT IN ('completed','completed_with_warnings')",
      )
      .run(new Date().toISOString(), id);
    return this.get(id);
  }
  retry(id) {
    this.db
      .prepare(
        "UPDATE tasks SET cancelled=0,state='queued',error=NULL WHERE id=? AND state IN ('failed','needs_input','cancelled') AND owner IS NULL",
      )
      .run(id);
    return this.get(id);
  }
  checkpoint(key, value) {
    if (value !== undefined)
      this.db
        .prepare("INSERT OR REPLACE INTO checkpoints VALUES(?,?)")
        .run(key, JSON.stringify(value));
    const r = this.db
      .prepare("SELECT value FROM checkpoints WHERE key=?")
      .get(key);
    return r ? JSON.parse(r.value) : null;
  }
  profile(game, value) {
    if (value !== undefined)
      this.db
        .prepare("INSERT OR REPLACE INTO profiles VALUES(?,?)")
        .run(game, JSON.stringify(value));
    const r = this.db
      .prepare("SELECT value FROM profiles WHERE game=?")
      .get(game);
    return r ? JSON.parse(r.value) : null;
  }
  setting(key, value) {
    if (value !== undefined)
      this.db
        .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
        .run(key, JSON.stringify(value));
    const r = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return r ? JSON.parse(r.value) : null;
  }
  subscribe(input) {
    const key = hash({
      board: input.board,
      hours: input.hours,
      category: input.category,
    });
    const old = this.subscriptions().find((s) => s.key === key);
    const value = {
      ...old,
      ...input,
      key,
      next_at: input.next_at || old?.next_at || new Date().toISOString(),
    };
    this.db
      .prepare("INSERT OR REPLACE INTO subscriptions VALUES(?,?)")
      .run(key, JSON.stringify(value));
    return value;
  }
  subscriptions() {
    return this.db
      .prepare("SELECT value FROM subscriptions")
      .all()
      .map((r) => JSON.parse(r.value));
  }
  lock(key, owner, ms = 30000) {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM locks WHERE expires<?").run(Date.now());
      const row = this.db
        .prepare("SELECT owner FROM locks WHERE key=?")
        .get(key);
      if (row && row.owner !== owner) return false;
      this.db
        .prepare("INSERT OR REPLACE INTO locks VALUES(?,?,?)")
        .run(key, owner, Date.now() + ms);
      return true;
    });
  }
  unlock(key, owner) {
    this.db
      .prepare("DELETE FROM locks WHERE key=? AND owner=?")
      .run(key, owner);
  }
  close() {
    this.db.close();
  }
}
