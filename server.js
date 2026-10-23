import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { openDb, upsertMember } from "./src/db.js";
import { checkEligibility, defaultProvider } from "./src/eligibility.js";
import { importCsv, listAppointments, verifyAll, verifyAppointment, CSV_COLUMNS } from "./src/appointments.js";
import { loadConfig, today, findPayer, formatEid } from "./src/util.js";
import * as ecl from "./src/eclaimlink/index.js";

const MAX_BODY = 5 * 1024 * 1024;

export function createApp({ db, cfg, env = process.env, fetchImpl } = {}) {
  const ctx = { db, cfg, env, fetchImpl };
  const appHtml = () => {
    const body = readFileSync(new URL("./public/app-body.html", import.meta.url), "utf8");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="rcm-api" content="/api"></head><body>${body}</body></html>`;
  };

  const user = env.APP_USERNAME, pass = env.APP_PASSWORD;
  const authorized = req => {
    if (!user || !pass) return true;
    const h = req.headers.authorization || "";
    if (!h.startsWith("Basic ")) return false;
    const given = Buffer.from(Buffer.from(h.slice(6), "base64").toString());
    const want = Buffer.from(`${user}:${pass}`);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const send = (res, code, data, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
  };
  const readJson = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("Request is too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(Object.assign(new Error("Body must be JSON"), { code: 400 })); } });
    req.on("error", reject);
  });

  const routes = [
    ["GET", /^\/api\/health$/, () => ({ ok: true, provider: defaultProvider(env), eclaimlink: ecl.mode(env), facility: env.FACILITY_LICENSE || null, today: today() })],
    ["GET", /^\/api\/config$/, () => ({ payers: cfg.payers.map(({ code, name, kind, terms, eclaimlinkId }) => ({ code, name, kind, terms, eclaimlinkId })), approvalDepartments: cfg.approvalDepartments, csvColumns: CSV_COLUMNS, provider: defaultProvider(env) })],
    ["POST", /^\/api\/eligibility$/, async req => {
      const b = await readJson(req);
      return checkEligibility(ctx, { emiratesId: b.emiratesId, cardNo: b.cardNo, payer: b.payer, department: b.department, source: "walk-in" });
    }],
    ["GET", /^\/api\/appointments$/, (req, url) => listAppointments(db, url.searchParams.get("date") || today())],
    ["POST", /^\/api\/appointments\/import$/, async req => {
      const b = await readJson(req);
      if (typeof b.csv !== "string" || !b.csv.trim()) throw Object.assign(new Error("Send the CSV text in the 'csv' field"), { code: 400 });
      const date = b.date || today();
      const r = importCsv(ctx, b.csv, { date, replace: b.replace !== false });
      const checked = b.verify === false ? 0 : await verifyAll(ctx, date);
      return { ...r, checked, appointments: listAppointments(db, date) };
    }],
    ["POST", /^\/api\/appointments\/verify-all$/, async (req, url) => {
      const date = url.searchParams.get("date") || today();
      const checked = await verifyAll(ctx, date, { onlyUnverified: url.searchParams.get("all") !== "1" });
      return { checked, appointments: listAppointments(db, date) };
    }],
    ["POST", /^\/api\/appointments\/(\d+)\/verify$/, async (req, url, m) => {
      const r = await verifyAppointment(ctx, Number(m[1]));
      if (!r) throw Object.assign(new Error("Appointment not found"), { code: 404 });
      return r;
    }],
    ["POST", /^\/api\/members$/, async req => {
      const b = await readJson(req);
      const payer = findPayer(cfg.payers, b.payer);
      if (!b.name || !payer || (!b.emiratesId && !b.cardNo)) throw Object.assign(new Error("Name, payer and an Emirates ID or card number are required"), { code: 400 });
      if (b.emiratesId && !formatEid(b.emiratesId)) throw Object.assign(new Error("Emirates ID must be 15 digits starting with 784"), { code: 400 });
      return { id: upsertMember(db, { ...b, payer: payer.code }) };
    }],
    ["GET", /^\/api\/eclaimlink\/status$/, () => ecl.status(ctx)],
    ["POST", /^\/api\/eclaimlink\/upload$/, async req => {
      const b = await readJson(req);
      if (typeof b.xml !== "string" || !b.xml.trim()) throw Object.assign(new Error("Send the XML in the 'xml' field"), { code: 400 });
      return ecl.upload(ctx, { xml: b.xml, fileName: b.fileName });
    }],
    ["POST", /^\/api\/eclaimlink\/sync$/, () => ecl.sync(ctx)],
    ["GET", /^\/api\/eclaimlink\/files$/, (req, url) => ecl.listFiles(ctx, {
      direction: url.searchParams.get("direction"), type: url.searchParams.get("type"),
      unapplied: url.searchParams.get("unapplied") === "1", limit: Math.min(200, Number(url.searchParams.get("limit")) || 50) })],
    ["GET", /^\/api\/eclaimlink\/files\/(\d+)$/, (req, url, m) => {
      const f = ecl.getFile(ctx, Number(m[1]));
      if (!f) throw Object.assign(new Error("File not found"), { code: 404 });
      return f;
    }],
    ["GET", /^\/api\/eclaimlink\/search$/, (req, url) => {
      const p = url.searchParams;
      return ecl.search(ctx, { direction: p.get("direction"), type: p.get("type") || "all", status: p.get("status") || "all",
        from: p.get("from"), to: p.get("to"), name: p.get("name"), archive: p.get("archive") === "1" });
    }],
    ["GET", /^\/api\/eclaimlink\/remote\/([\w.-]+)$/, (req, url, m) => ecl.view(ctx, m[1], { archive: url.searchParams.get("archive") === "1" })],
    ["POST", /^\/api\/eclaimlink\/report$/, async req => ecl.report(ctx, (await readJson(req)).files)],
    ["POST", /^\/api\/eclaimlink\/files\/(\d+)\/applied$/, (req, url, m) => ({ applied: ecl.markApplied(ctx, Number(m[1])) })],
    ["GET", /^\/api\/checks$/, (req, url) => {
      const limit = Math.min(500, Number(url.searchParams.get("limit")) || 50);
      return db.prepare("SELECT id, created_at, source, provider, payer, emirates_id, card_no, department, status, result_json FROM eligibility_checks ORDER BY id DESC LIMIT ?")
        .all(limit).map(r => ({ ...r, result: JSON.parse(r.result_json), result_json: undefined }));
    }],
  ];

  return async (req, res) => {
    try {
      if (!authorized(req)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="Clinic RCM", charset="UTF-8"' });
        return res.end("Sign-in required");
      }
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return send(res, 200, appHtml(), "text/html; charset=utf-8");
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return send(res, 200, await fn(req, url, m));
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      const code = Number.isInteger(e.code) ? e.code : 500;
      if (code === 500) console.error(e);
      send(res, code, { error: code === 500 ? "Server error" : e.message });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const db = openDb(env.DATABASE_FILE || "data/rcm.sqlite");
  const cfg = loadConfig();
  const port = Number(env.PORT) || 3000;
  const host = env.HOST || "127.0.0.1";
  if (!env.APP_USERNAME || !env.APP_PASSWORD) console.warn("APP_USERNAME / APP_PASSWORD are not set: anyone who can reach this server can use it. Set them before exposing it beyond this computer.");
  createServer(createApp({ db, cfg, env })).listen(port, host, () =>
    console.log(`Clinic RCM running at http://${host}:${port} (eligibility provider: ${defaultProvider(env)}, eClaimLink: ${ecl.mode(env)})`));
}
