import { settings, tag, EClaimLinkError } from "./soap.js";
import { liveTransport, mockTransport } from "./transports.js";
import { summarize, buildReport } from "./summary.js";

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

// Checks a staff member's own eClaimLink login with a small search of today's sent claims.
// Returns true, or throws a 401 when eClaimLink rejects the login.
export async function verifyLogin(ctx, login, pwd) {
  if (!login || !pwd) throw Object.assign(new Error("Enter your eClaimLink username and password"), { code: 400 });
  if (mode(ctx.env) === "off") throw Object.assign(new Error("The eClaimLink connection is switched off (ECLAIMLINK_MODE=off)"), { code: 409 });
  const env = { ...ctx.env, ECLAIMLINK_LOGIN: login, ECLAIMLINK_PASSWORD: pwd };
  const d = new Date().toISOString().slice(0, 10);
  try {
    await liveTransport({ env, fetchImpl: ctx.fetchImpl }).search({ direction: 1, type: TYPE_CODES["Claim.Submission"], status: 1,
      callerLicense: ctx.env.FACILITY_LICENSE || null, from: dhpoDate(d) });
    return true;
  } catch (e) {
    if (e instanceof EClaimLinkError && e.code === -1) throw Object.assign(new Error("eClaimLink did not accept this username and password"), { code: 401 });
    if (e instanceof EClaimLinkError) throw Object.assign(new Error(`Could not sign in: ${e.eclaimMessage || e.message}`), { code: 502 });
    throw Object.assign(new Error(`Could not reach eClaimLink: ${e.message}`), { code: 502 });
  }
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

// ---- browsing everything on eClaimLink ----

export const TYPE_CODES = { "Claim.Submission": 2, "Remittance.Advice": 8, "Prior.Request": 16, "Prior.Authorization": 32 };
const badRequest = msg => Object.assign(new Error(msg), { code: 400 });
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dhpoDate = (iso, end) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${end ? "23:59:59" : "00:00:00"}`;

/**
 * Search sent or received files. q: { direction: "received"|"sent", type: "all"|<root name>,
 * status: "all"|"new"|"downloaded", from, to (YYYY-MM-DD), name, archive }
 * With type "all" each transaction type is searched separately, so every row carries its type.
 */
export async function search(ctx, q) {
  const direction = q.direction === "sent" ? 1 : 2;
  const archive = Boolean(q.archive);
  if (!ISO.test(q.from || "") || !ISO.test(q.to || "")) throw badRequest("Choose a from and to date");
  if (q.from > q.to) throw badRequest("The from date is after the to date");
  const days = (new Date(q.to) - new Date(q.from)) / 864e5;
  if (days > (archive ? 31 : 100)) throw badRequest(archive ? "Archive searches can cover at most one month" : "eClaimLink searches can cover at most 100 days");
  const types = q.type && q.type !== "all" ? [q.type] : Object.keys(TYPE_CODES);
  if (types.some(t => !TYPE_CODES[t])) throw badRequest(`Unknown file type ${q.type}`);
  const statuses = q.status === "new" ? [1] : q.status === "downloaded" ? [2] : [1, 2];
  const today = new Date().toISOString().slice(0, 10);
  const t = transport(ctx);
  const jobs = types.flatMap(type => statuses.map(status => ({ type, status })));
  const files = [], notes = [];
  const key = d => d ? `${d.slice(6, 10)}${d.slice(3, 5)}${d.slice(0, 2)}${d.slice(11)}` : "";
  // eClaimLink returns only so many files per search, oldest first. Search again from the newest file's time
  // until a search brings nothing new, so busy periods are not cut short.
  await Promise.all(jobs.map(async j => {
    const got = new Set();
    let from = dhpoDate(q.from);
    for (let page = 0; page < 100; page++) {
      const r = await t.search({ direction, type: TYPE_CODES[j.type], status: j.status, archive, name: q.name || null,
        callerLicense: ctx.env.FACILITY_LICENSE || null, from, to: q.to >= today ? null : dhpoDate(q.to, true) });
      if (r.note && !page) notes.push(r.note);
      let added = 0, latest = "";
      for (const f of r.files) {
        if (key(f.transactionDate) > key(latest)) latest = f.transactionDate;
        if (got.has(f.fileId)) continue;
        got.add(f.fileId); added++;
        files.push({ ...f, type: j.type, isDownloaded: f.isDownloaded ?? j.status === 2, archive });
      }
      const next = latest && (latest.length === 16 ? latest + ":00" : latest);
      if (!added || !next || key(next) <= key(from)) break;
      from = next;
    }
  }));
  const seen = new Set();
  const unique = files.filter(f => !seen.has(f.fileId) && seen.add(f.fileId));
  unique.sort((a, b) => key(b.transactionDate).localeCompare(key(a.transactionDate)));
  return { files: unique, notes: [...new Set(notes)] };
}

export async function view(ctx, fileId, { archive } = {}) {
  const f = await transport(ctx).view(fileId, { archive });
  return { fileId, fileName: f.fileName, xml: f.xml, summary: summarize(f.xml) };
}

// Opens up to 200 files (four at a time) and combines them into one report
export async function report(ctx, files) {
  if (!Array.isArray(files) || !files.length) throw badRequest("Choose files for the report");
  const list = files.slice(0, 200), out = [], errors = [];
  let next = 0;
  const worker = async () => { while (next < list.length) { const f = list[next++];
    try { out.push((await view(ctx, f.fileId, { archive: f.archive })).summary); } catch (e) { errors.push({ fileId: f.fileId, error: e.message }); } } };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return { ...buildReport(out), errors, truncated: files.length > list.length };
}

// Opens up to 200 files (four at a time) and returns each file's claim rows, for the Reports pages
export async function rows(ctx, files) {
  if (!Array.isArray(files) || !files.length) throw badRequest("Choose files");
  const list = files.slice(0, 200), out = [], errors = [];
  let next = 0;
  const worker = async () => { while (next < list.length) { const f = list[next++];
    try { const v = await view(ctx, f.fileId, { archive: f.archive });
      out.push({ fileId: f.fileId, fileName: v.fileName || f.fileName || null, transactionDate: f.transactionDate || v.summary.header.date, type: v.summary.type, header: v.summary.header, rows: v.summary.rows });
    } catch (e) { errors.push({ fileId: f.fileId, error: e.message }); } } };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return { files: out, errors, truncated: files.length > list.length };
}
