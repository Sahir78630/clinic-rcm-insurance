import { upsertMember } from "./db.js";
import { checkEligibility } from "./eligibility.js";
import { findPayer, formatEid, parseCsv, today } from "./util.js";

export const CSV_COLUMNS = ["time", "patient_name", "emirates_id", "payer", "card_no", "plan", "valid_until", "department", "doctor"];

// Plan defaults used only when the export names a plan but not its co-pay terms
const PLAN_TERMS = {
  "essential benefits plan": { copayPct: 20, deductible: 0, network: "Restricted (RN3)" },
  silver: { copayPct: 20, deductible: 50, network: "General (GN)" },
  gold: { copayPct: 10, deductible: 20, network: "General Plus (GN+)" },
  platinum: { copayPct: 0, deductible: 0, network: "Comprehensive (CN)" },
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function isoDate(v) {
  v = (v || "").trim();
  if (ISO.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy, the usual UAE format
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

export function toApi(row) {
  return {
    id: row.id, date: row.date, time: row.time, patientName: row.patient_name, emiratesId: row.emirates_id,
    payer: row.payer, cardNo: row.card_no, department: row.department, doctor: row.doctor, status: row.status,
    checkedAt: row.checked_at, result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

export function listAppointments(db, date = today()) {
  return db.prepare(`SELECT a.*, c.result_json FROM appointments a LEFT JOIN eligibility_checks c ON c.id = a.last_check_id
    WHERE a.date = ? ORDER BY a.time, a.id`).all(date).map(toApi);
}

export function importCsv(ctx, csv, { date = today(), replace = true } = {}) {
  const { db, cfg } = ctx;
  const rows = parseCsv(csv);
  if (!rows.length) return { imported: 0, skipped: [], membersUpdated: 0 };
  let hdr = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, ""));
  if (hdr.includes("emirates_id") || hdr.includes("card_no")) rows.shift(); else hdr = CSV_COLUMNS;
  const col = (r, k) => { const i = hdr.indexOf(k); return i < 0 ? "" : (r[i] || "").trim(); };

  const skipped = []; let imported = 0, membersUpdated = 0;
  db.exec("BEGIN");
  try {
    if (replace) db.prepare("DELETE FROM appointments WHERE date = ?").run(date);
    const ins = db.prepare(`INSERT INTO appointments (date, time, patient_name, emirates_id, payer, card_no, department, doctor) VALUES (?,?,?,?,?,?,?,?)`);
    rows.forEach((r, i) => {
      const line = i + 2;
      const eidRaw = col(r, "emirates_id"), card = col(r, "card_no"), payerRaw = col(r, "payer");
      if (!eidRaw && !card) { skipped.push({ line, reason: "no Emirates ID or card number" }); return; }
      const eid = eidRaw ? formatEid(eidRaw) : null;
      if (eidRaw && !eid) { skipped.push({ line, reason: `"${eidRaw}" is not a valid Emirates ID (15 digits starting 784)` }); return; }
      const payer = payerRaw ? findPayer(cfg.payers, payerRaw) : null;
      if (payerRaw && !payer) { skipped.push({ line, reason: `unknown payer "${payerRaw}"` }); return; }
      const plan = col(r, "plan"), validTo = isoDate(col(r, "valid_until"));
      if (payer && (plan || validTo)) {
        const terms = PLAN_TERMS[plan.toLowerCase()] || {};
        upsertMember(db, { name: col(r, "patient_name") || "Unnamed patient", emiratesId: eid, cardNo: card, payer: payer.code, plan: plan || null,
          validTo, validFrom: null, ...terms });
        membersUpdated++;
      }
      ins.run(date, col(r, "time") || null, col(r, "patient_name") || null, eid, payer ? payer.code : null, card || null,
        col(r, "department") || null, col(r, "doctor") || null);
      imported++;
    });
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { imported, skipped, membersUpdated };
}

export async function verifyAppointment(ctx, id) {
  const { db } = ctx;
  const a = db.prepare("SELECT * FROM appointments WHERE id = ?").get(id);
  if (!a) return null;
  const res = await checkEligibility(ctx, { emiratesId: a.emirates_id, cardNo: a.card_no, payer: a.payer, department: a.department, source: "appointment", appointmentId: a.id });
  db.prepare("UPDATE appointments SET status = ?, last_check_id = ?, checked_at = ?, patient_name = COALESCE(patient_name, ?), payer = COALESCE(payer, ?) WHERE id = ?")
    .run(res.status, res.checkId, res.checkedAt, res.name || null, res.payer || null, a.id);
  return res;
}

// Checks run a few at a time so a large clinic list doesn't flood the payer API
export async function verifyAll(ctx, date = today(), { onlyUnverified = true, concurrency = 4 } = {}) {
  const ids = ctx.db.prepare(`SELECT id FROM appointments WHERE date = ? ${onlyUnverified ? "AND status = 'Not verified'" : ""} ORDER BY time, id`).all(date).map(r => r.id);
  let next = 0;
  const worker = async () => { while (next < ids.length) await verifyAppointment(ctx, ids[next++]); };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return ids.length;
}
