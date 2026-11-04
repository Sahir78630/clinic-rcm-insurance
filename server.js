import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { openDb, upsertMember } from "./src/db.js";
import { checkEligibility, defaultProvider } from "./src/eligibility.js";
import { importCsv, listAppointments, verifyAll, verifyAppointment, CSV_COLUMNS } from "./src/appointments.js";
import { loadConfig, today, findPayer, formatEid } from "./src/util.js";
import * as ecl from "./src/eclaimlink/index.js";
import { settings, serviceInfo } from "./src/eclaimlink/soap.js";
import * as auth from "./src/auth.js";
import * as shared from "./src/shared.js";
import * as files from "./src/files.js";
import * as facs from "./src/facilities.js";

const MAX_BODY = 50 * 1024 * 1024;
const SENT = Symbol("sent"); // a route that wrote its own response
const SESSION_IDLE = 2 * 3600e3, SESSION_MAX = 12 * 3600e3, COOKIE = "rcm_ecl", USER_COOKIE = "rcm_user";

// login: false skips website accounts (used by tests that exercise other parts of the API)
export function createApp({ db, cfg, env = process.env, fetchImpl, login = true } = {}) {
  const ctx = { db, cfg, env, fetchImpl };
  auth.initAuth(db);
  shared.initShared(db);
  files.initFiles(db);
  facs.initFacilities(db);
  const appHtml = () => {
    const body = readFileSync(new URL("./public/app-body.html", import.meta.url), "utf8");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="rcm-api" content="/api"></head><body>${body}</body></html>`;
  };

  // eClaimLink sign-in: each staff member's own login is held in server memory for the session only,
  // never written to the database or sent back to the browser. The browser gets a random session cookie.
  const sessions = new Map(), failures = new Map();
  const cookieNamed = (req, name) => (String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`)) || [])[1];
  const cookieOf = req => cookieNamed(req, COOKIE);
  const sessionOf = req => {
    const id = cookieOf(req), s = id && sessions.get(id), now = Date.now();
    if (!s) return null;
    if (now - s.last > SESSION_IDLE || now - s.created > SESSION_MAX) { sessions.delete(id); return null; }
    s.last = now;
    return s;
  };
  // A browser whose eClaimLink session ended gets an error rather than quietly falling back to test mode
  const eclCtx = (req, s = sessionOf(req)) => {
    // Locked to facilities: always the facility's own saved login, never a personal one
    const c = req.rcm;
    if (c && c.locked) {
      if (!c.f) throw Object.assign(new Error("Choose a facility first"), { code: 409, needFacility: true });
      const cr = facs.credentials(db, env, c.f.id);
      const m = ecl.mode(env) === "off" ? "off" : String(env.ECLAIMLINK_MODE || "").toLowerCase() === "mock" ? "mock" : "live";
      return { ...ctx, facility: c.lic, env: { ...env, ECLAIMLINK_MODE: m, ECLAIMLINK_LOGIN: cr.login, ECLAIMLINK_PASSWORD: cr.pwd, FACILITY_LICENSE: c.lic } };
    }
    if (!s && cookieOf(req)) throw Object.assign(new Error("Your eClaimLink session has ended. Sign in again."), { code: 401, signIn: true });
    if (!s) return ctx;
    return { ...ctx, env: { ...env, ECLAIMLINK_MODE: ecl.mode(env) === "off" ? "off" : "live", ECLAIMLINK_LOGIN: s.login, ECLAIMLINK_PASSWORD: s.pwd } };
  };
  const setCookie = (req, res, value, maxAge, name = COOKIE, same = "Strict") => {
    const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("set-cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=${same}; Max-Age=${maxAge}${secure}`);
  };
  const eclStatus = (req, s = sessionOf(req)) => {
    const c = req.rcm;
    if (c && c.locked && c.f) return { ...ecl.status(eclCtx(req)), signedIn: true, signedInAs: c.f.name, canSignIn: false, serverLogin: true, facility: c.f.licence };
    return { ...ecl.status(s ? eclCtx(req, s) : ctx), signedIn: Boolean(s), signedInAs: s?.login || null, canSignIn: ecl.mode(env) !== "off",
      serverLogin: Boolean(env.ECLAIMLINK_LOGIN && env.ECLAIMLINK_PASSWORD) };
  };

  // Website accounts. A request through Cloudflare Tunnel also arrives from this computer, but carries the visitor's
  // address in cf-connecting-ip, so it does not count as local.
  const viaProxy = req => Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
  const loopback = req => /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress || "");
  // The clinic computer may also open its own network address (http://COMPUTERNAME:3000 or 192.168.x.x)
  const ownAddress = req => { const a = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    return Object.values(networkInterfaces()).flat().some(i => i && i.address === a); };
  const isLocal = req => (loopback(req) || ownAddress(req)) && !viaProxy(req);
  const clientIp = req => (loopback(req) && String(req.headers["cf-connecting-ip"] || "").trim()) || req.socket.remoteAddress;
  const userOf = req => login ? auth.sessionUser(db, cookieNamed(req, USER_COOKIE)) : { id: 0, username: "local", name: "", role: "admin" };
  // The facility this browser works in. Locked (facilities set up): the one chosen at sign-in, or the only one allowed.
  const facOf = (req, u) => {
    if (!login || !facs.locked(db)) return { locked: false, f: null, lic: "", allowed: [] };
    const allowed = facs.allowedFor(db, u);
    let f = allowed.find(x => x.id === facs.sessionFacility(db, u.sessionId)) || null;
    if (!f && allowed.length === 1) { f = allowed[0]; facs.setSessionFacility(db, u.sessionId, f.id); }
    return { locked: true, f, lic: f ? f.licence : "", allowed };
  };
  const act = (req, u, action, detail = "") => facs.logActivity(db, { user: u ? u.username : "", facility: req.rcm?.lic || "", ip: clientIp(req), action, detail });
  const loginFails = new Map();
  const loginPage = mode => readFileSync(new URL("./public/login.html", import.meta.url), "utf8").replace("__MODE__", mode);
  const needAdmin = u => { if (u.role !== "admin") throw Object.assign(new Error("Only an admin can do this"), { code: 403 }); };
  const authRoutes = [
    ["POST", /^\/auth\/login$/, async (req, url, m, res) => {
      const ip = clientIp(req), now = Date.now();
      const f = (loginFails.get(ip) || []).filter(t => now - t < 15 * 60e3);
      if (f.length >= 10) throw Object.assign(new Error("Too many wrong passwords. Wait 15 minutes and try again."), { code: 429 });
      const b = await readJson(req);
      const u = auth.checkLogin(db, b.username, b.password);
      if (!u) { loginFails.set(ip, [...f, now]); facs.logActivity(db, { user: String(b.username || "").slice(0, 60), ip, action: "Website sign-in failed" }); throw Object.assign(new Error("Wrong username or password"), { code: 401 }); }
      loginFails.delete(ip);
      setCookie(req, res, auth.startSession(db, u.id), auth.SESSION_IDLE / 1000, USER_COOKIE, "Lax");
      facs.logActivity(db, { user: u.username, ip, action: "Website sign-in" });
      return { ok: true };
    }],
    ["POST", /^\/auth\/logout$/, (req, url, m, res) => {
      const u = auth.sessionUser(db, cookieNamed(req, USER_COOKIE));
      if (u) facs.logActivity(db, { user: u.username, facility: (facs.facilityById(db, facs.sessionFacility(db, u.sessionId)) || {}).licence || "", ip: clientIp(req), action: "Website sign-out" });
      auth.endSession(db, cookieNamed(req, USER_COOKIE));
      setCookie(req, res, "", 0, USER_COOKIE, "Lax");
      return { ok: true };
    }],
    // The first admin account can only be created on the clinic computer itself, never through the web link
    ["POST", /^\/auth\/setup$/, async (req, url, m, res) => {
      if (auth.userCount(db) > 0) throw Object.assign(new Error("The admin account already exists. Sign in instead."), { code: 409 });
      if (!isLocal(req)) throw Object.assign(new Error("Create the admin account on the clinic computer that runs the website."), { code: 403 });
      const b = await readJson(req);
      const u = auth.createUser(db, { username: b.username, name: b.name, role: "admin", password: b.password });
      auth.checkLogin(db, b.username, b.password);
      setCookie(req, res, auth.startSession(db, u.id), auth.SESSION_IDLE / 1000, USER_COOKIE, "Lax");
      return { ok: true };
    }],
  ];

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
    ["GET", /^\/api\/me$/, (req, url, m, res, u) => { const c = req.rcm;
      return { ...u, sessionId: undefined, login, locked: c.locked, facility: c.f && { id: c.f.id, name: c.f.name, licence: c.f.licence },
        facilities: c.allowed.map(f => ({ id: f.id, name: f.name, licence: f.licence })), needFacility: c.locked && !c.f }; }],
    // Choosing the facility to work in. Staff choose once per sign-in (to change, they sign out); admins may switch.
    ["POST", /^\/api\/facility$/, async (req, url, m, res, u) => {
      const c = req.rcm, id = Number((await readJson(req)).id);
      if (!c.locked) throw Object.assign(new Error("No facilities are set up"), { code: 409 });
      const f = c.allowed.find(x => x.id === id);
      if (!f) throw Object.assign(new Error("You do not have access to this facility"), { code: 403 });
      if (c.f && c.f.id !== f.id && u.role !== "admin") throw Object.assign(new Error("Sign out first, then sign in again and choose the other facility"), { code: 403 });
      facs.setSessionFacility(db, u.sessionId, f.id);
      req.rcm = { ...c, f, lic: f.licence };
      act(req, u, c.f && c.f.id !== f.id ? "Switched facility" : "Opened facility", `${f.name} (${f.licence})`);
      return { ok: true, facility: { id: f.id, name: f.name, licence: f.licence } };
    }],
    // Facilities and their eClaimLink logins (admin only). Passwords are never sent back.
    ["GET", /^\/api\/facilities$/, (req, url, m, res, u) => { needAdmin(u); return facs.listFacilities(db); }],
    ["POST", /^\/api\/facilities$/, async (req, url, m, res, u) => {
      needAdmin(u);
      const b = await readJson(req);
      const verify = async (licence, login, pwd) => {
        if (["mock", "off"].includes(String(env.ECLAIMLINK_MODE || "").toLowerCase())) return;
        await ecl.verifyLogin({ ...ctx, env: { ...env, FACILITY_LICENSE: licence } }, login, pwd);
      };
      const f = await facs.saveFacility(db, env, { id: b.id, licence: b.licence, name: b.name, login: b.login, password: b.password || undefined, active: b.active }, u.username, verify);
      act(req, u, b.id ? "Changed facility" : "Added facility", `${f.name} (${f.licence})${b.password ? ", eClaimLink password set" : ""}${b.active === false ? ", disabled" : b.active === true ? ", enabled" : ""}`);
      return f;
    }],
    // Things done in the browser that belong in the activity log (any signed-in person)
    ["POST", /^\/api\/activity$/, async (req, url, m, res, u) => {
      const b = await readJson(req);
      if (!["Made claim ready", "Cancelled ready"].includes(b.action)) throw Object.assign(new Error("Unknown activity"), { code: 400 });
      act(req, u, b.action, String(b.detail || "").slice(0, 300));
      return { ok: true };
    }],
    ["GET", /^\/api\/activity$/, (req, url, m, res, u) => {
      needAdmin(u);
      const p = url.searchParams;
      return facs.listActivity(db, { user: p.get("user"), facility: p.get("facility"), from: p.get("from"), to: p.get("to"), limit: p.get("limit") });
    }],
    ["POST", /^\/api\/me\/password$/, async (req, url, m, res, u) => {
      const b = await readJson(req);
      auth.changeOwnPassword(db, u.id, b.current, b.password);
      return { ok: true };
    }],
    ["GET", /^\/api\/users$/, (req, url, m, res, u) => { needAdmin(u); const fa = facs.userFacilities(db); return auth.listUsers(db).map(x => ({ ...x, facilities: fa[x.id] ?? null })); }],
    ["POST", /^\/api\/users$/, async (req, url, m, res, u) => {
      needAdmin(u);
      const b = await readJson(req), n = auth.createUser(db, b);
      if (b.facilities !== undefined) facs.setUserFacilities(db, n.id, b.facilities);
      act(req, u, "Added website account", `${n.username} (${n.role})`);
      return n;
    }],
    ["POST", /^\/api\/users\/(\d+)$/, async (req, url, m, res, u) => {
      needAdmin(u);
      const b = await readJson(req);
      const n = auth.updateUser(db, Number(m[1]), { name: b.name, role: b.role, active: b.active, password: b.password }, u);
      if (b.facilities !== undefined) facs.setUserFacilities(db, n.id, b.facilities);
      act(req, u, "Changed website account", `${n.username}: ${[b.role && "role " + b.role, b.active !== undefined && (b.active ? "enabled" : "disabled"), b.password && "new password", b.facilities !== undefined && "facilities " + (b.facilities === null ? "all" : (b.facilities || []).map(id => (facs.facilityById(db, id) || {}).name || id).join(", ") || "none")].filter(Boolean).join(", ")}`);
      return n;
    }],
    // Shared records: every browser pulls changes since its last revision and pushes its own edits
    ["GET", /^\/api\/data$/, (req, url) => shared.pull(db, Number(url.searchParams.get("since")) || 0, req.rcm.lic)],
    ["POST", /^\/api\/data$/, async (req, url, m, res, u) => {
      const b = await readJson(req);
      if (b.clearAll) {
        needAdmin(u);
        shared.clearAll(db, u.username, req.rcm.lic);
        act(req, u, "Cleared all data");
      }
      return shared.push(db, b, u.username, req.rcm.lic);
    }],
    // Claim attachments: uploaded as JSON (base64), opened in the browser, removed by any signed-in user
    ["POST", /^\/api\/files$/, async (req, url, m, res, u) => files.addFile(db, await readJson(req), u.username, req.rcm.lic)],
    ["GET", /^\/api\/files\/(\d+)$/, (req, url, m, res) => {
      const f = files.getFile(db, Number(m[1]), req.rcm.lic);
      if (!f) throw Object.assign(new Error("File not found"), { code: 404 });
      res.writeHead(200, files.fileHeaders(f)); res.end(f.data); return SENT;
    }],
    ["POST", /^\/api\/files\/(\d+)\/delete$/, (req, url, m) => files.removeFile(db, Number(m[1]), req.rcm.lic)],
    ["GET", /^\/api\/health$/, req => ({ ok: true, provider: defaultProvider(env), eclaimlink: req.rcm.locked ? eclStatus(req).mode : ecl.mode(env), facility: req.rcm.lic || env.FACILITY_LICENSE || null, today: today() })],
    ["GET", /^\/api\/config$/, () => ({ payers: cfg.payers.map(({ code, name, kind, terms, eclaimlinkId }) => ({ code, name, kind, terms, eclaimlinkId })), approvalDepartments: cfg.approvalDepartments, csvColumns: CSV_COLUMNS, provider: defaultProvider(env) })],
    ["POST", /^\/api\/eligibility$/, async req => {
      const b = await readJson(req);
      return checkEligibility(req.rcm.ctx, { emiratesId: b.emiratesId, cardNo: b.cardNo, payer: b.payer, department: b.department, source: "walk-in" });
    }],
    ["GET", /^\/api\/appointments$/, (req, url) => listAppointments(db, url.searchParams.get("date") || today(), req.rcm.lic)],
    ["POST", /^\/api\/appointments\/import$/, async req => {
      const b = await readJson(req);
      if (typeof b.csv !== "string" || !b.csv.trim()) throw Object.assign(new Error("Send the CSV text in the 'csv' field"), { code: 400 });
      const date = b.date || today();
      const r = importCsv(req.rcm.ctx, b.csv, { date, replace: b.replace !== false });
      const checked = b.verify === false ? 0 : await verifyAll(req.rcm.ctx, date);
      return { ...r, checked, appointments: listAppointments(db, date, req.rcm.lic) };
    }],
    ["POST", /^\/api\/appointments\/verify-all$/, async (req, url) => {
      const date = url.searchParams.get("date") || today();
      const checked = await verifyAll(req.rcm.ctx, date, { onlyUnverified: url.searchParams.get("all") !== "1" });
      return { checked, appointments: listAppointments(db, date, req.rcm.lic) };
    }],
    ["POST", /^\/api\/appointments\/(\d+)\/verify$/, async (req, url, m) => {
      const r = await verifyAppointment(req.rcm.ctx, Number(m[1]));
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
    ["GET", /^\/api\/eclaimlink\/status$/, req => eclStatus(req)],
    // What the connector read from the eClaimLink WSDL, for troubleshooting (no credentials involved)
    ["GET", /^\/api\/eclaimlink\/service$/, async () => {
      const s = settings(env), info = await serviceInfo(s.url, { fetchImpl: ctx.fetchImpl, ns: s.ns });
      return { url: s.url, namespace: info.ns, operations: Object.keys(info.actions), searchParameters: info.params?.SearchTransactions || null,
        downloadParameters: info.params?.DownloadTransactionFile || null };
    }],
    ["POST", /^\/api\/eclaimlink\/login$/, async (req, url, m, res) => {
      const ip = req.socket.remoteAddress, now = Date.now();
      const f = (failures.get(ip) || []).filter(t => now - t < 15 * 60e3);
      if (f.length >= 5) throw Object.assign(new Error("Too many failed sign-ins. Wait 15 minutes, so eClaimLink does not lock the account."), { code: 429 });
      if (req.rcm.locked) throw Object.assign(new Error("eClaimLink is used through each facility's account, saved by the admin under Account & staff. Personal eClaimLink sign-in is switched off."), { code: 403 });
      const b = await readJson(req);
      const login = String(b.login || "").trim(), pwd = String(b.pwd || "");
      try { await ecl.verifyLogin(ctx, login, pwd); }
      catch (e) { if (e.code === 401) failures.set(ip, [...f, now]); throw e; }
      failures.delete(ip);
      const old = cookieOf(req); if (old) sessions.delete(old);
      const id = randomBytes(32).toString("base64url");
      const s = { login, pwd, created: now, last: now };
      sessions.set(id, s);
      setCookie(req, res, id, SESSION_MAX / 1000);
      return eclStatus(req, s);
    }],
    ["POST", /^\/api\/eclaimlink\/logout$/, (req, url, m, res) => {
      const id = cookieOf(req); if (id) sessions.delete(id);
      setCookie(req, res, "", 0);
      return { signedIn: false };
    }],
    ["POST", /^\/api\/eclaimlink\/upload$/, async req => {
      const b = await readJson(req);
      if (typeof b.xml !== "string" || !b.xml.trim()) throw Object.assign(new Error("Send the XML in the 'xml' field"), { code: 400 });
      const r = await ecl.upload(eclCtx(req), { xml: b.xml, fileName: b.fileName });
      act(req, req.user, "eClaimLink: sent file", `${r.fileName} (${r.type}) to ${String(b.xml).match(/<ReceiverID>([^<]*)</)?.[1] || "?"}, ${String(b.xml).match(/<RecordCount>([^<]*)</)?.[1] || "?"} records: ${r.ok ? "accepted" : "rejected " + r.resultCode}`);
      return r;
    }],
    ["POST", /^\/api\/eclaimlink\/sync$/, async req => { const r = await ecl.sync(eclCtx(req)); act(req, req.user, "eClaimLink: downloaded new files", `${r.downloaded} new`); return r; }],
    ["GET", /^\/api\/eclaimlink\/files$/, (req, url) => ecl.listFiles(eclCtx(req), {
      direction: url.searchParams.get("direction"), type: url.searchParams.get("type"),
      unapplied: url.searchParams.get("unapplied") === "1", limit: Math.min(200, Number(url.searchParams.get("limit")) || 50) })],
    ["GET", /^\/api\/eclaimlink\/files\/(\d+)$/, (req, url, m) => {
      const f = ecl.getFile(eclCtx(req), Number(m[1]));
      if (!f) throw Object.assign(new Error("File not found"), { code: 404 });
      act(req, req.user, "eClaimLink: opened file", f.file_name || String(f.id));
      return f;
    }],
    ["GET", /^\/api\/eclaimlink\/search$/, (req, url) => {
      const p = url.searchParams;
      act(req, req.user, "eClaimLink: searched files", `${p.get("direction") || ""} ${p.get("type") || "all"} ${p.get("from") || ""} to ${p.get("to") || ""}${p.get("name") ? " name " + p.get("name") : ""}${p.get("archive") === "1" ? " (archive)" : ""}`);
      return ecl.search(eclCtx(req), { direction: p.get("direction"), type: p.get("type") || "all", status: p.get("status") || "all",
        from: p.get("from"), to: p.get("to"), name: p.get("name"), archive: p.get("archive") === "1" });
    }],
    ["GET", /^\/api\/eclaimlink\/remote\/([\w.-]+)$/, async (req, url, m) => { const v = await ecl.view(eclCtx(req), m[1], { archive: url.searchParams.get("archive") === "1" }); act(req, req.user, "eClaimLink: opened file", v.fileName || m[1]); return v; }],
    ["POST", /^\/api\/eclaimlink\/report$/, async req => { const f = (await readJson(req)).files; act(req, req.user, "eClaimLink: built a report", `${Array.isArray(f) ? f.length : 0} files`); return ecl.report(eclCtx(req), f); }],
    ["POST", /^\/api\/eclaimlink\/rows$/, async req => { const f = (await readJson(req)).files; act(req, req.user, "eClaimLink: read files for a report", `${Array.isArray(f) ? f.length : 0} files`); return ecl.rows(eclCtx(req), f); }],
    ["POST", /^\/api\/eclaimlink\/files\/(\d+)\/applied$/, (req, url, m) => ({ applied: ecl.markApplied(eclCtx(req), Number(m[1])) })],
    ["GET", /^\/api\/checks$/, (req, url) => {
      const limit = Math.min(500, Number(url.searchParams.get("limit")) || 50);
      return db.prepare("SELECT id, created_at, source, provider, payer, emirates_id, card_no, department, status, result_json FROM eligibility_checks WHERE facility = ? ORDER BY id DESC LIMIT ?")
        .all(req.rcm.lic, limit).map(r => ({ ...r, result: JSON.parse(r.result_json), result_json: undefined }));
    }],
  ];

  return async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      // Requests that change something must be JSON, which another website cannot send to this one
      if (req.method !== "GET" && !String(req.headers["content-type"] || "").startsWith("application/json"))
        throw Object.assign(new Error("Send the request as JSON"), { code: 415 });
      for (const [method, re, fn] of authRoutes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return send(res, 200, await fn(req, url, m, res));
      }
      const u = userOf(req);
      const page = url.pathname === "/" || url.pathname === "/index.html";
      if (!u) {
        if (req.method === "GET" && page) return send(res, 200, loginPage(auth.userCount(db) ? "login" : isLocal(req) ? "setup" : "closed"), "text/html; charset=utf-8");
        throw Object.assign(new Error("Your website sign-in has ended. Sign in again."), { code: 401, login: true });
      }
      if (req.method === "GET" && page) return send(res, 200, appHtml(), "text/html; charset=utf-8");
      const c = facOf(req, u);
      req.rcm = { ...c, ctx: { ...ctx, facility: c.lic } }; req.user = u;
      // Locked: nothing of a facility can be read or changed before a facility is chosen
      if (c.locked && !c.f && !/^\/api\/(me(\/password)?|facility|facilities|users(\/\d+)?|activity)$/.test(url.pathname))
        throw Object.assign(new Error("Choose a facility first"), { code: 409, needFacility: true });
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) { const out = await fn(req, url, m, res, u); return out === SENT ? undefined : send(res, 200, out); }
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      const code = Number.isInteger(e.code) ? e.code : 500;
      if (code === 500) console.error(e);
      send(res, code, { error: code === 500 ? "Server error" : e.message, ...(e.signIn && { signIn: true }), ...(e.login && { login: true }), ...(e.needFacility && { needFacility: true }) });
    }
  };
}

// Start only when run directly (node server.js), not when imported by the tests. Compared as paths so it works on Windows too.
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), resolve(process.argv[1]))) {
  const env = process.env;
  const dbFile = env.DATABASE_FILE || "data/rcm.sqlite";
  const db = openDb(dbFile);
  const cfg = loadConfig();
  const port = Number(env.PORT) || 3000;
  const host = env.HOST || "127.0.0.1";
  // The facility password key is kept next to the database (data/facility.key)
  const app = createApp({ db, cfg, env: { ...env, DATABASE_FILE: dbFile } });
  const daily = () => { try { const f = shared.backup(db, dbFile); if (f) console.log(`Backup: ${f}`); } catch (e) { console.error("Backup failed:", e.message); } };
  daily(); setInterval(daily, 3600e3).unref();
  if (!auth.userCount(db)) console.log(`No accounts yet: open http://127.0.0.1:${port} on this computer to create the admin account.`);
  createServer(app)
    .on("error", e => {
      if (e.code !== "EADDRINUSE") throw e;
      console.error(`\nClinic RCM is already running on port ${port} (another window, or the copy that starts with Windows).\n` +
        `Close that window first, or open http://127.0.0.1:${port} to use the copy that is running.\n` +
        `To stop every copy at once, type:  taskkill /IM node.exe /F`);
      process.exit(1);
    })
    .listen(port, host, () =>
      console.log(`Clinic RCM running at http://${host}:${port} (eligibility provider: ${defaultProvider(env)}, eClaimLink: ${ecl.mode(env)})`));
}
