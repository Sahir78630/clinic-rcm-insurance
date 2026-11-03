import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { addColumn } from "./db.js";

// Facilities: each clinic licence with its own eClaimLink (DHPO) login, entered once by an admin.
// When at least one facility is active the website is "locked": everyone works in one facility at a time,
// eClaimLink is used only through these saved logins, and nobody can sign in to eClaimLink with another account.
// Passwords are encrypted (AES-256-GCM) with a key kept in data/facility.key next to the database; they are
// never sent back to a browser. The activity log records who did what, in which facility, from where.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  licence TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  login TEXT NOT NULL,
  secret TEXT NOT NULL,                 -- encrypted eClaimLink password
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT (datetime('now')),
  user TEXT,
  facility TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS activity_log_at ON activity_log(at);
`;
const LOG_KEEP = 50000;
const bad = (msg, code = 400) => Object.assign(new Error(msg), { code });


// Tables that hold one facility's records get a facility column ('' = from before facilities were set up)
const SCOPED = ["eclaimlink_files", "claim_files", "appointments", "eligibility_checks"];
export function initFacilities(db) {
  db.exec(SCHEMA);
  for (const t of SCOPED) addColumn(db, t, "facility", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "users", "facilities", "TEXT");          // JSON list of facility ids; null = every facility
  addColumn(db, "user_sessions", "facility_id", "INTEGER");
}

// ---- the encryption key ----
let memKey = null;
function keyOf(env) {
  if (env.FACILITY_KEY && /^[0-9a-f]{64}$/i.test(env.FACILITY_KEY)) return Buffer.from(env.FACILITY_KEY, "hex");
  // Next to the database file; a database in memory (the tests) keeps its key in memory too
  const file = env.FACILITY_KEY_FILE || (env.DATABASE_FILE && env.DATABASE_FILE !== ":memory:" ? join(dirname(env.DATABASE_FILE), "facility.key") : null);
  if (!file) return memKey ||= randomBytes(32);
  if (existsSync(file)) { const k = Buffer.from(readFileSync(file, "utf8").trim(), "hex"); if (k.length === 32) return k; throw new Error(`${file} is not a valid key`); }
  mkdirSync(dirname(file), { recursive: true });
  const k = randomBytes(32);
  writeFileSync(file, k.toString("hex") + "\n", { mode: 0o600 });
  return k;
}
export function encrypt(env, text) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", keyOf(env), iv);
  const ct = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}
export function decrypt(env, secret) {
  const [v, iv, tag, ct] = String(secret || "").split(":");
  if (v !== "v1") throw bad("The saved eClaimLink password cannot be read. Enter it again under Account & staff.", 409);
  try {
    const d = createDecipheriv("aes-256-gcm", keyOf(env), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch { throw bad("The saved eClaimLink password cannot be read (the key file data\\facility.key is missing or different). Enter it again under Account & staff.", 409); }
}

// ---- facilities ----
const pub = f => f && { id: f.id, licence: f.licence, name: f.name, login: f.login, active: Boolean(f.active), updatedAt: f.updated_at, updatedBy: f.updated_by || "" };
export const listFacilities = db => db.prepare("SELECT * FROM facilities ORDER BY active DESC, name").all().map(pub);
export const activeFacilities = db => db.prepare("SELECT * FROM facilities WHERE active = 1 ORDER BY name").all().map(pub);
export const locked = db => Boolean(db.prepare("SELECT 1 FROM facilities WHERE active = 1").get());
export const facilityById = (db, id) => pub(db.prepare("SELECT * FROM facilities WHERE id = ?").get(Number(id)));
export function credentials(db, env, id) {
  const f = db.prepare("SELECT * FROM facilities WHERE id = ? AND active = 1").get(Number(id));
  return f ? { licence: f.licence, login: f.login, pwd: decrypt(env, f.secret) } : null;
}

// Adds or changes a facility. verify(licence, login, pwd) checks the login with eClaimLink first.
// The first facility takes over every record kept before facilities were set up.
export async function saveFacility(db, env, { id, licence, name, login, password, active }, by, verify) {
  licence = String(licence ?? "").trim(); name = String(name ?? "").trim(); login = String(login ?? "").trim();
  const old = id ? db.prepare("SELECT * FROM facilities WHERE id = ?").get(Number(id)) : null;
  if (id && !old) throw bad("Facility not found", 404);
  if (!old || licence) { if (!/^[\w-]{3,40}$/.test(licence)) throw bad("Enter the facility licence number, for example DHA-F-0001234"); }
  if (!old && (!name || !login || !password)) throw bad("Enter the facility name, licence, eClaimLink username and password");
  const next = { licence: licence || old.licence, name: name || old.name, login: login || old.login };
  const dup = db.prepare("SELECT id FROM facilities WHERE licence = ? AND id IS NOT ?").get(next.licence, old ? old.id : null);
  if (dup) throw bad(`Licence ${next.licence} is already saved as another facility`, 409);
  // A new password, or a changed username, is checked with eClaimLink before it is saved
  const pwd = password ? String(password) : null;
  if (pwd || (old && next.login !== old.login)) await verify(next.licence, next.login, pwd ?? decrypt(env, old.secret));
  const secret = pwd ? encrypt(env, pwd) : old.secret;
  const first = !old && !locked(db) && !db.prepare("SELECT 1 FROM facilities").get();
  let fid;
  if (old) {
    db.prepare("UPDATE facilities SET licence = ?, name = ?, login = ?, secret = ?, active = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?")
      .run(next.licence, next.name, next.login, secret, active === undefined ? old.active : active ? 1 : 0, by, old.id);
    fid = old.id;
    // Records follow a corrected licence
    if (old.licence !== next.licence) moveRecords(db, old.licence, next.licence);
  } else {
    fid = Number(db.prepare("INSERT INTO facilities (licence, name, login, secret, updated_by) VALUES (?,?,?,?,?)").run(next.licence, next.name, next.login, secret, by).lastInsertRowid);
    if (first) moveRecords(db, "", next.licence);
  }
  return { ...pub(db.prepare("SELECT * FROM facilities WHERE id = ?").get(fid)), tookOver: first };
}
function moveRecords(db, from, to) {
  for (const t of [...SCOPED, "shared_records"]) db.prepare(`UPDATE ${t} SET facility = ? WHERE facility = ?`).run(to, from);
}

// Which facilities a person may open: an admin every active one, staff the ones ticked for them (none ticked = all)
export function allowedFor(db, user) {
  const all = activeFacilities(db);
  if (user.role === "admin") return all;
  const row = db.prepare("SELECT facilities FROM users WHERE id = ?").get(user.id);
  let ids = null; try { ids = row && row.facilities ? JSON.parse(row.facilities) : null; } catch { ids = null; }
  return Array.isArray(ids) ? all.filter(f => ids.includes(f.id)) : all;
}
export function setUserFacilities(db, userId, ids) {
  const v = ids === null ? null : JSON.stringify([...new Set((ids || []).map(Number).filter(Number.isInteger))]);
  db.prepare("UPDATE users SET facilities = ? WHERE id = ?").run(v, userId);
}
export const userFacilities = db => Object.fromEntries(db.prepare("SELECT id, facilities FROM users").all().map(r => { let v = null; try { v = r.facilities ? JSON.parse(r.facilities) : null; } catch {} return [r.id, v]; }));

// ---- the facility a browser is working in ----
export const sessionFacility = (db, sessionId) => (db.prepare("SELECT facility_id FROM user_sessions WHERE id = ?").get(sessionId) || {}).facility_id ?? null;
export const setSessionFacility = (db, sessionId, fid) => db.prepare("UPDATE user_sessions SET facility_id = ? WHERE id = ?").run(fid, sessionId);

// ---- activity log ----
export function logActivity(db, { user = "", facility = "", ip = "", action, detail = "" }) {
  db.prepare("INSERT INTO activity_log (user, facility, ip, action, detail) VALUES (?,?,?,?,?)").run(user, facility, String(ip || ""), action, String(detail || "").slice(0, 500));
  if (Math.random() < 0.01) db.prepare("DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - ?").run(LOG_KEEP);
}
export function listActivity(db, { user, facility, from, to, limit = 500 } = {}) {
  const where = [], args = [];
  if (user) { where.push("user = ?"); args.push(user); }
  if (facility) { where.push("facility = ?"); args.push(facility); }
  if (from) { where.push("at >= ?"); args.push(from); }
  if (to) { where.push("at < date(?, '+1 day')"); args.push(to); }
  return db.prepare(`SELECT * FROM activity_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(5000, Number(limit) || 500));
}
