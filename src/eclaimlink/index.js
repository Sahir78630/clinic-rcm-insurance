import { settings, tag } from "./soap.js";
import { liveTransport, mockTransport } from "./transports.js";

const UPLOAD_TYPES = ["Claim.Submission", "Prior.Request"];

export function mode(env = process.env) {
  const m = (env.ECLAIMLINK_MODE || "").toLowerCase();
  if (["live", "mock", "off"].includes(m)) return m;
  return env.ECLAIMLINK_LOGIN && env.ECLAIMLINK_PASSWORD ? "live" : "mock";
}

export function transport(ctx) {
  const m = mode(ctx.env);
  if (m === "off") throw Object.assign(new Error("The eClaimLink connection is switched off (ECLAIMLINK_MODE=off)"), { code: 409 });
  return m === "live" ? liveTransport({ env: ctx.env, fetchImpl: ctx.fetchImpl }) : mockTransport(ctx.db);
}

export function status(ctx) {
  const s = settings(ctx.env);
  const last = ctx.db.prepare("SELECT MAX(created_at) t FROM eclaimlink_files WHERE direction = 'in'").get().t;
  return { mode: mode(ctx.env), url: mode(ctx.env) === "live" ? s.url : null, loginSet: Boolean(s.login), lastDownload: last };
}

export const rootOf = xml => (String(xml).match(/<([A-Za-z][\w.]*)[\s>]/) || [])[1] || null;

// The website uses short payer codes and a placeholder facility licence. Swap in the real
// eClaimLink IDs from config/payers.json (eclaimlinkId) and FACILITY_LICENSE before sending.
export function localize(xml, cfg, env) {
  let out = xml;
  const fac = env.FACILITY_LICENSE;
  if (fac) out = out.replace(/(<(SenderID|ProviderID|FacilityID)>)DHA-F-0000000(<\/\2>)/g, `$1${fac}$3`);
  for (const p of cfg.payers) {
    if (!p.eclaimlinkId) continue;
    out = out.replace(new RegExp(`(<(ReceiverID|PayerID)>)${p.code}(</\\2>)`, "g"), `$1${p.eclaimlinkId}$3`);
  }
  return out;
}

export async function upload(ctx, { xml, fileName }) {
  const type = rootOf(xml);
  if (!UPLOAD_TYPES.includes(type)) throw Object.assign(new Error(`Only ${UPLOAD_TYPES.join(" and ")} files can be uploaded, this is ${type || "not XML"}`), { code: 400 });
  const body = localize(xml, ctx.cfg, ctx.env);
  const header = tag(body, "Header") || "";
  const name = fileName || `${tag(header, "SenderID") || "FACILITY"}_${type}_${Date.now()}.xml`;
  let r;
  try { r = await transport(ctx).upload(name, body); }
  catch (e) { r = { result: Number.isInteger(e.code) ? e.code : -1, errorMessage: e.eclaimMessage || e.message, transactionId: null, errorReport: null }; }
  const info = ctx.db.prepare(`INSERT INTO eclaimlink_files (direction, file_name, type, sender, receiver, record_count, result_code, transaction_id, error_message, error_report, xml)
    VALUES ('out',?,?,?,?,?,?,?,?,?,?)`).run(name, type, tag(header, "SenderID"), tag(header, "ReceiverID"), Number(tag(header, "RecordCount")) || null,
    r.result, r.transactionId, r.errorMessage, r.errorReport, body);
  return { id: Number(info.lastInsertRowid), ok: r.result >= 0, warnings: r.result > 0, fileName: name, type, resultCode: r.result,
    transactionId: r.transactionId, errorMessage: r.errorMessage, errorReport: r.errorReport };
}

// Download every new file, store it, then tell eClaimLink it was downloaded.
// A file is only marked downloaded after it is safely stored, so nothing is lost on a crash.
export async function sync(ctx) {
  const t = transport(ctx);
  const list = await t.listNew();
  const got = [], errors = [];
  for (const f of list) {
    try {
      const exists = ctx.db.prepare("SELECT id FROM eclaimlink_files WHERE direction = 'in' AND file_id = ?").get(f.fileId);
      if (!exists) {
        const d = await t.download(f.fileId);
        const header = tag(d.xml, "Header") || "";
        ctx.db.prepare(`INSERT INTO eclaimlink_files (direction, file_id, file_name, type, sender, receiver, record_count, result_code, xml) VALUES ('in',?,?,?,?,?,?,0,?)`)
          .run(f.fileId, d.fileName || f.fileName, rootOf(d.xml), tag(header, "SenderID") || f.sender, tag(header, "ReceiverID") || f.receiver,
            Number(tag(header, "RecordCount")) || f.recordCount, d.xml);
        got.push(f.fileId);
      }
      await t.markDownloaded(f.fileId);
    } catch (e) { errors.push({ fileId: f.fileId, error: e.message }); }
  }
  return { listed: list.length, downloaded: got.length, errors };
}

export function listFiles(ctx, { direction, type, unapplied, limit = 50 } = {}) {
  const where = [], args = [];
  if (direction) { where.push("direction = ?"); args.push(direction); }
  if (type) { where.push("type = ?"); args.push(type); }
  if (unapplied) where.push("direction = 'in' AND applied_at IS NULL");
  return ctx.db.prepare(`SELECT id, created_at, direction, file_id, file_name, type, sender, receiver, record_count, result_code, transaction_id, error_message, applied_at
    ${unapplied ? ", xml" : ""} FROM eclaimlink_files ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit);
}

export function getFile(ctx, id) {
  return ctx.db.prepare("SELECT * FROM eclaimlink_files WHERE id = ?").get(id);
}

export function markApplied(ctx, id) {
  return ctx.db.prepare("UPDATE eclaimlink_files SET applied_at = datetime('now') WHERE id = ? AND direction = 'in' AND applied_at IS NULL").run(id).changes > 0;
}
