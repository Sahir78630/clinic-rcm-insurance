import { mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// The records every browser works on (claims, patients, remittances, approvals, settings), kept on the server
// so all staff see the same data. Each record is stored on its own, so two people editing different claims
// never overwrite each other. Every change gets the next revision number; browsers ask for changes since the
// last revision they have.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_records (
  coll TEXT NOT NULL,                  -- claims, patients, ras, auths, appts, log, or _ for settings
  id TEXT NOT NULL,
  json TEXT,                           -- null once deleted
  rev INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (coll, id)
);
CREATE INDEX IF NOT EXISTS shared_records_rev ON shared_records(rev);
`;
export const COLLECTIONS = ["patients", "claims", "ras", "auths", "appts"];
const LOG_KEEP = 500;

export function initShared(db) { db.exec(SCHEMA); }

const lastRev = db => db.prepare("SELECT COALESCE(MAX(rev), 0) AS r FROM shared_records").get().r;
const bad = msg => Object.assign(new Error(msg), { code: 400 });

// Changes since a revision. A browser starting fresh (since 0) gets every live record and the latest log entries.
export function pull(db, since = 0) {
  const rev = lastRev(db);
  const rows = since > 0
    ? db.prepare("SELECT coll, id, json, rev FROM shared_records WHERE rev > ? AND coll <> 'log' ORDER BY rev").all(since)
    : db.prepare("SELECT coll, id, json, rev FROM shared_records WHERE json IS NOT NULL AND coll <> 'log' ORDER BY rev").all();
  const log = db.prepare("SELECT json FROM shared_records WHERE coll = 'log' AND rev > ? ORDER BY rev DESC LIMIT ?").all(since, LOG_KEEP);
  return { rev, changes: rows.map(r => ({ coll: r.coll, id: r.id, data: r.json === null ? null : JSON.parse(r.json) })), log: log.map(r => JSON.parse(r.json)) };
}

// One browser's edits: records added or changed, records removed, changed settings and new log lines.
// onlyNew adds records the server does not have yet and leaves existing ones alone (copying an older browser's data in).
export function push(db, { upserts = [], deletes = [], settings = {}, log = [], onlyNew = false } = {}, by = "") {
  if (!Array.isArray(upserts) || !Array.isArray(deletes) || !Array.isArray(log) || typeof settings !== "object" || !settings) throw bad("Malformed change list");
  let rev = lastRev(db), skipped = 0;
  const get = db.prepare("SELECT json FROM shared_records WHERE coll = ? AND id = ?");
  const put = db.prepare(`INSERT INTO shared_records (coll, id, json, rev, updated_by, updated_at) VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(coll, id) DO UPDATE SET json = excluded.json, rev = excluded.rev, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const u of upserts) {
      if (!COLLECTIONS.includes(u?.coll) || u.id == null || typeof u.data !== "object" || !u.data) throw bad("Malformed record");
      const id = String(u.id);
      if (onlyNew && get.get(u.coll, id)?.json) { skipped++; continue; }
      put.run(u.coll, id, JSON.stringify(u.data), ++rev, by);
    }
    for (const d of deletes) {
      if (!COLLECTIONS.includes(d?.coll) || d.id == null) throw bad("Malformed delete");
      if (get.get(d.coll, String(d.id))?.json) put.run(d.coll, String(d.id), null, ++rev, by);
    }
    for (const [k, v] of Object.entries(settings)) {
      if (!/^\w{1,40}$/.test(k)) throw bad("Malformed setting");
      const old = get.get("_", k)?.json, prev = old ? JSON.parse(old) : undefined;
      if (onlyNew && prev !== undefined && k !== "posted") { skipped++; continue; }
      let val = v;
      // Files already posted stay posted whichever browser recorded them; the remittance counter only moves up
      if (k === "posted" && prev && typeof v === "object") val = { ...prev, ...v };
      if (k === "raSeq" && typeof prev === "number") val = Math.max(prev, Number(v) || 0);
      if (JSON.stringify(val) !== old) put.run("_", k, JSON.stringify(val), ++rev, by);
    }
    for (const l of log.slice(0, LOG_KEEP)) put.run("log", `${Date.now()}-${rev + 1}`, JSON.stringify(l), ++rev, by);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { rev, skipped };
}

// Admin only: removes every record for everyone (the log and the daily backups stay)
export function clearAll(db, by = "") {
  const rev = lastRev(db) + 1;
  db.prepare("UPDATE shared_records SET json = NULL, rev = ?, updated_by = ?, updated_at = datetime('now') WHERE json IS NOT NULL AND coll <> 'log'").run(rev, by);
  return rev;
}

// A copy of the whole database once a day in data/backups, keeping the last 30 days
export function backup(db, file, keep = 30) {
  if (!file || file === ":memory:") return null;
  const dir = join(dirname(file), "backups");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `rcm-${new Date().toISOString().slice(0, 10)}.sqlite`);
  if (!existsSync(out)) db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  readdirSync(dir).filter(f => /^rcm-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -keep).forEach(f => unlinkSync(join(dir, f)));
  return out;
}
