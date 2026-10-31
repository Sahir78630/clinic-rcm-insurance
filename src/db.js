import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Members are the clinic's own record of each patient's policy, built from appointment imports.
// The mock provider checks against them; live providers ignore them and ask the payer.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emirates_id TEXT,
  payer TEXT,
  card_no TEXT,
  plan TEXT,
  network TEXT,
  copay_pct REAL,
  deductible REAL,
  valid_from TEXT,
  valid_to TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS members_eid ON members(emirates_id);
CREATE INDEX IF NOT EXISTS members_card ON members(card_no);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT,
  patient_name TEXT,
  emirates_id TEXT,
  payer TEXT,
  card_no TEXT,
  department TEXT,
  doctor TEXT,
  status TEXT NOT NULL DEFAULT 'Not verified',
  last_check_id INTEGER,
  checked_at TEXT
);
CREATE INDEX IF NOT EXISTS appointments_date ON appointments(date);

-- every file sent to or received from eClaimLink, kept for audit
CREATE TABLE IF NOT EXISTS eclaimlink_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  direction TEXT NOT NULL,            -- 'out' (uploaded) or 'in' (downloaded)
  file_id TEXT,                       -- eClaimLink FileID for downloads
  file_name TEXT,
  type TEXT,                          -- root element: Claim.Submission, Remittance.Advice, ...
  sender TEXT,
  receiver TEXT,
  record_count INTEGER,
  result_code INTEGER,
  transaction_id TEXT,
  error_message TEXT,
  error_report TEXT,
  xml TEXT,
  applied_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS eclaimlink_in_file ON eclaimlink_files(direction, file_id);

-- claim rows read from eClaimLink files for the reports; a file on eClaimLink never changes, so each is opened once
CREATE TABLE IF NOT EXISTS eclaimlink_rows_cache (
  key TEXT PRIMARY KEY,               -- format version, mode and file ID
  json TEXT NOT NULL,
  at TEXT DEFAULT (datetime('now'))
);

-- test-mode stand-in for the eClaimLink inbox
CREATE TABLE IF NOT EXISTS eclaimlink_mock_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT, sender TEXT, receiver TEXT, record_count INTEGER, created_at TEXT DEFAULT (datetime('now')),
  xml TEXT NOT NULL, downloaded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS eligibility_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  source TEXT,
  appointment_id INTEGER,
  provider TEXT,
  payer TEXT,
  emirates_id TEXT,
  card_no TEXT,
  department TEXT,
  status TEXT,
  result_json TEXT
);
`;

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

// keys are stored digits-only so lookups ignore dashes and spaces
export const key = s => String(s ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();

export function findMember(db, { emiratesId, cardNo }) {
  const e = key(emiratesId), c = key(cardNo);
  if (e) { const m = db.prepare("SELECT * FROM members WHERE emirates_id = ? ORDER BY updated_at DESC").get(e); if (m) return m; }
  if (c) { const m = db.prepare("SELECT * FROM members WHERE card_no = ? ORDER BY updated_at DESC").get(c); if (m) return m; }
  return null;
}

export function upsertMember(db, m) {
  const existing = findMember(db, { emiratesId: m.emiratesId, cardNo: m.cardNo });
  const row = [m.name, key(m.emiratesId) || null, m.payer || null, key(m.cardNo) || null, m.plan || null, m.network || null,
    m.copayPct ?? null, m.deductible ?? null, m.validFrom || null, m.validTo || null];
  if (existing) {
    db.prepare(`UPDATE members SET name=COALESCE(?,name), emirates_id=COALESCE(?,emirates_id), payer=COALESCE(?,payer), card_no=COALESCE(?,card_no),
      plan=COALESCE(?,plan), network=COALESCE(?,network), copay_pct=COALESCE(?,copay_pct), deductible=COALESCE(?,deductible),
      valid_from=COALESCE(?,valid_from), valid_to=COALESCE(?,valid_to), updated_at=datetime('now') WHERE id=?`).run(...row, existing.id);
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO members (name, emirates_id, payer, card_no, plan, network, copay_pct, deductible, valid_from, valid_to)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...row).lastInsertRowid);
}
