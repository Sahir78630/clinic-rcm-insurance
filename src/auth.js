import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";

// Website accounts: each member of staff signs in with their own username and password.
// Admins also manage the accounts. Passwords are stored as salted scrypt hashes, and sessions
// are kept in the database so that restarting the server does not sign everyone out.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'staff',   -- 'admin' or 'staff'
  pw TEXT NOT NULL,                     -- scrypt$salt$hash
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,                  -- sha256 of the cookie value
  user_id INTEGER NOT NULL,
  created INTEGER NOT NULL,
  last INTEGER NOT NULL
);
`;
export const ROLES = ["admin", "staff"];
export const SESSION_IDLE = 7 * 24 * 3600e3;
const MIN_PASSWORD = 8;

export function initAuth(db) { db.exec(SCHEMA); }

const hashPw = (pw, salt = randomBytes(16).toString("base64url")) => `scrypt$${salt}$${scryptSync(pw, salt, 32).toString("base64url")}`;
function checkPw(pw, stored) {
  const [, salt, h] = String(stored).split("$");
  if (!salt || !h) return false;
  const a = Buffer.from(hashPw(pw, salt).split("$")[2]), b = Buffer.from(h);
  return a.length === b.length && timingSafeEqual(a, b);
}
const bad = (msg, code = 400) => Object.assign(new Error(msg), { code });
const cleanName = u => String(u || "").trim();
function validPassword(pw) {
  if (String(pw || "").length < MIN_PASSWORD) throw bad(`The password must be at least ${MIN_PASSWORD} characters`);
}
const pub = u => u && { id: u.id, username: u.username, name: u.name || "", role: u.role, active: Boolean(u.active), createdAt: u.created_at, lastLogin: u.last_login };

export const userCount = db => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
export const listUsers = db => db.prepare("SELECT * FROM users ORDER BY role, username").all().map(pub);

export function createUser(db, { username, name, role = "staff", password }) {
  username = cleanName(username);
  if (!/^[\w.@-]{2,40}$/.test(username)) throw bad("Usernames are 2 to 40 letters, digits, dots, dashes or underscores, without spaces");
  if (!ROLES.includes(role)) throw bad("Role must be admin or staff");
  validPassword(password);
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw bad(`The username ${username} is already taken`, 409);
  const id = Number(db.prepare("INSERT INTO users (username, name, role, pw) VALUES (?,?,?,?)").run(username, String(name || "").trim(), role, hashPw(password)).lastInsertRowid);
  return pub(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
}

// Admin changes to an account. The last active admin cannot be demoted or disabled, so nobody is locked out.
export function updateUser(db, id, { name, role, active, password }, by) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!u) throw bad("Account not found", 404);
  const losingAdmin = u.role === "admin" && u.active && ((role && role !== "admin") || active === false);
  if (losingAdmin && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n <= 1)
    throw bad("This is the only admin account. Make another account admin first.");
  if (role !== undefined && !ROLES.includes(role)) throw bad("Role must be admin or staff");
  if (password !== undefined) validPassword(password);
  db.prepare("UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active), pw = COALESCE(?, pw) WHERE id = ?")
    .run(name === undefined ? null : String(name).trim(), role ?? null, active === undefined ? null : active ? 1 : 0, password === undefined ? null : hashPw(password), id);
  // A disabled account or a reset password signs that person out everywhere (except the admin's own browser)
  if (active === false || password !== undefined) db.prepare("DELETE FROM user_sessions WHERE user_id = ? AND id IS NOT ?").run(id, by?.sessionId ?? null);
  return pub(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
}

export function changeOwnPassword(db, userId, current, next) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!u || !checkPw(String(current || ""), u.pw)) throw bad("The current password is not correct", 403);
  validPassword(next);
  db.prepare("UPDATE users SET pw = ? WHERE id = ?").run(hashPw(next), userId);
}

// Returns the account on a correct, active login, otherwise null
export function checkLogin(db, username, password) {
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(cleanName(username));
  const ok = u ? checkPw(String(password || ""), u.pw) : checkPw("x", hashPw("y")); // same work either way
  if (!u || !ok || !u.active) return null;
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(u.id);
  return pub(u);
}

const sid = token => createHash("sha256").update(token).digest("base64url");
export function startSession(db, userId) {
  const token = randomBytes(32).toString("base64url"), now = Date.now();
  db.prepare("DELETE FROM user_sessions WHERE last < ?").run(now - SESSION_IDLE);
  db.prepare("INSERT INTO user_sessions (id, user_id, created, last) VALUES (?,?,?,?)").run(sid(token), userId, now, now);
  return token;
}
export function sessionUser(db, token) {
  if (!token) return null;
  const id = sid(token), now = Date.now();
  const s = db.prepare("SELECT * FROM user_sessions WHERE id = ?").get(id);
  if (!s) return null;
  if (now - s.last > SESSION_IDLE) { db.prepare("DELETE FROM user_sessions WHERE id = ?").run(id); return null; }
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(s.user_id);
  if (!u) return null;
  if (now - s.last > 60e3) db.prepare("UPDATE user_sessions SET last = ? WHERE id = ?").run(now, id);
  return { ...pub(u), sessionId: id };
}
export const endSession = (db, token) => token && db.prepare("DELETE FROM user_sessions WHERE id = ?").run(sid(token));
