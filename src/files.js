// Files attached to claims (ECG reports, dental X-rays, clinical notes). The file itself is kept here,
// on the clinic server, and the claim record only lists it, so the shared records stay small.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS claim_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  added_by TEXT,
  added_at TEXT DEFAULT (datetime('now')),
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS claim_files_claim ON claim_files(claim);
`;
export const MAX_FILE = 20 * 1024 * 1024;
// Shown in the browser; anything else downloads
const VIEWABLE = /^(application\/pdf|image\/(png|jpeg|gif|webp|bmp)|text\/plain)$/;

export function initFiles(db) { db.exec(SCHEMA); }
const bad = (msg, code = 400) => Object.assign(new Error(msg), { code });

export function addFile(db, { claim, name, type, data }, by = "") {
  claim = String(claim || "").trim(); name = String(name || "").replace(/[\\/:*?"<>|\r\n]+/g, "_").trim().slice(0, 200);
  if (!claim || !name || typeof data !== "string") throw bad("Send the claim, file name and file");
  const buf = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
  if (!buf.length) throw bad("The file is empty");
  if (buf.length > MAX_FILE) throw bad(`The file is larger than ${MAX_FILE / 1024 / 1024} MB`, 413);
  type = /^[\w.+-]+\/[\w.+-]+$/.test(type || "") ? type : "application/octet-stream";
  const id = Number(db.prepare("INSERT INTO claim_files (claim, name, type, size, data, added_by) VALUES (?,?,?,?,?,?)").run(claim, name, type, buf.length, buf, by).lastInsertRowid);
  const r = db.prepare("SELECT added_at FROM claim_files WHERE id = ?").get(id);
  return { id, claim, name, type, size: buf.length, by, at: r.added_at };
}

export function getFile(db, id) {
  return db.prepare("SELECT * FROM claim_files WHERE id = ? AND deleted = 0").get(id) || null;
}

// Kept in the database (and the backups) but no longer served, so a file removed by mistake can be recovered
export function removeFile(db, id) {
  if (!db.prepare("UPDATE claim_files SET deleted = 1 WHERE id = ? AND deleted = 0").run(id).changes) throw bad("File not found", 404);
  return { ok: true };
}

export function fileHeaders(f) {
  const view = VIEWABLE.test(f.type);
  const enc = encodeURIComponent(f.name);
  return {
    "content-type": view ? f.type : "application/octet-stream",
    "content-length": f.size,
    "content-disposition": `${view ? "inline" : "attachment"}; filename="${f.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${enc}`,
    "x-content-type-options": "nosniff", "cache-control": "private, no-store",
    // PDFs and images cannot run scripts, and Chrome will not show a PDF in a sandboxed page
    ...(/^(application\/pdf|image\/)/.test(f.type) ? {} : { "content-security-policy": "sandbox" }),
  };
}
