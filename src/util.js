import { readFileSync } from "node:fs";

export const norm = s => String(s ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();

const pad = n => String(n).padStart(2, "0");
export const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => toISO(new Date());
export const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// Emirates ID: 15 digits starting with 784, shown as 784-YYYY-NNNNNNN-N
export function formatEid(v) {
  const d = norm(v);
  if (!/^784\d{12}$/.test(d)) return null;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 14)}-${d.slice(14)}`;
}

export function loadConfig(path = new URL("../config/payers.json", import.meta.url)) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  return { payers: cfg.payers, approvalDepartments: cfg.approvalDepartments || [] };
}

export function findPayer(payers, v) {
  const k = norm(v);
  if (!k) return null;
  return payers.find(p => norm(p.code) === k || norm(p.name) === k || (p.aliases || []).some(a => norm(a) === k))
    || payers.find(p => norm(p.name).startsWith(k) || k.startsWith(norm(p.name)))
    || null;
}

// RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF line endings
export function parseCsv(txt) {
  const out = []; let row = [], cur = "", q = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) {
      if (ch === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && txt[i + 1] === "\n") i++;
      row.push(cur); out.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out.filter(r => r.some(c => c.trim()));
}
