import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb, upsertMember } from "../src/db.js";
import { checkEligibility } from "../src/eligibility.js";
import { importCsv, listAppointments, verifyAll } from "../src/appointments.js";
import { loadConfig, parseCsv, formatEid, today } from "../src/util.js";
import { createApp } from "../server.js";

const cfg = loadConfig();
const future = "2099-01-01";
const fresh = () => openDb(":memory:");

test("formatEid accepts digits, dashes and spaces", () => {
  assert.equal(formatEid("784199012345671"), "784-1990-1234567-1");
  assert.equal(formatEid("784 1990 1234567 1"), "784-1990-1234567-1");
  assert.equal(formatEid("123"), null);
});

test("parseCsv handles quotes and CRLF", () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""q"""\r\n1,2,3\r\n'), [["a", "b, c", 'd "q"'], ["1", "2", "3"]]);
});

test("mock provider finds a member by Emirates ID in any format", async () => {
  const db = fresh();
  upsertMember(db, { name: "Test Member", emiratesId: "784-1990-1234567-1", cardNo: "DM-1", payer: "DAM", plan: "Gold", validTo: future });
  const r = await checkEligibility({ db, cfg, env: { ELIGIBILITY_PROVIDER: "mock" } }, { emiratesId: "784199012345671", payer: "Daman" });
  assert.equal(r.status, "Eligible");
  assert.equal(r.name, "Test Member");
  assert.equal(r.payerName, "Daman");
});

test("payer mismatch, expiry, approval and not-found outcomes", async () => {
  const db = fresh(); const ctx = { db, cfg, env: { ELIGIBILITY_PROVIDER: "mock" } };
  upsertMember(db, { name: "A", emiratesId: "784199012345671", payer: "DAM", validTo: future });
  upsertMember(db, { name: "B", emiratesId: "784198812345672", payer: "NAS", validTo: "2020-01-01" });
  assert.equal((await checkEligibility(ctx, { emiratesId: "784199012345671", payer: "NAS" })).status, "Not eligible");
  assert.equal((await checkEligibility(ctx, { emiratesId: "784198812345672" })).status, "Inactive");
  assert.equal((await checkEligibility(ctx, { emiratesId: "784199012345671", department: "Dental" })).status, "Approval needed");
  assert.equal((await checkEligibility(ctx, { emiratesId: "784200012345679" })).status, "Not found");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM eligibility_checks").get().n, 4);
});

test("http provider sends credentials and maps the response", async () => {
  let seen;
  const fake = createServer((req, res) => {
    let b = ""; req.on("data", c => b += c); req.on("end", () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(b) };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ACTIVE", transactionId: "T-1", payerCode: "DAM",
        member: { name: "Live Member", emiratesId: "784199012345671", cardNo: "DM-9" },
        coverage: { plan: "Gold", network: "GN+", validFrom: "2026-01-01", validTo: "2026-12-31", copayPercent: 10, deductible: 20 } }));
    });
  }).listen(0);
  await new Promise(r => fake.once("listening", r));
  const env = { ELIGIBILITY_PROVIDER: "http", ELIGIBILITY_API_URL: `http://127.0.0.1:${fake.address().port}/check`, ELIGIBILITY_API_KEY: "secret", FACILITY_LICENSE: "DHA-F-1" };
  const r = await checkEligibility({ db: fresh(), cfg, env }, { emiratesId: "784-1990-1234567-1", payer: "DAM", department: "General Practice" });
  fake.close();
  assert.equal(seen.auth, "Bearer secret");
  assert.equal(seen.body.emiratesId, "784-1990-1234567-1");
  assert.equal(seen.body.payerCode, "DAM");
  assert.equal(seen.body.facilityLicense, "DHA-F-1");
  assert.equal(r.status, "Eligible");
  assert.equal(r.provider, "http");
  assert.equal(r.reference, "T-1");
  assert.equal(r.copayPct, 10);
});

test("an unreachable payer API gives 'Check failed' instead of an error", async () => {
  const env = { ELIGIBILITY_PROVIDER: "http", ELIGIBILITY_API_URL: "http://127.0.0.1:9/none", ELIGIBILITY_TIMEOUT_MS: "2000" };
  const r = await checkEligibility({ db: fresh(), cfg, env }, { emiratesId: "784199012345671" });
  assert.equal(r.status, "Check failed");
});

test("CSV import adds members, skips bad rows and verifies everyone", async () => {
  const db = fresh(); const ctx = { db, cfg, env: { ELIGIBILITY_PROVIDER: "mock" } };
  const csv = `time,patient_name,emirates_id,payer,card_no,plan,valid_until,department,doctor
09:00,"Al Mansoori, Fatima",784-1985-7654321-3,Daman,DM-100,Gold,31/12/2099,General Practice,Dr. A
09:30,No Id,,Daman,,,,General Practice,
10:00,Bad Payer,784199012345671,Unknown Co,X-1,,,ENT,
10:30,Physio Patient,784199112345670,NAS,NS-2,Silver,2099-06-30,Physiotherapy,`;
  const r = importCsv(ctx, csv);
  assert.equal(r.imported, 2);
  assert.equal(r.skipped.length, 2);
  await verifyAll(ctx);
  const list = listAppointments(db, today());
  assert.deepEqual(list.map(a => a.status), ["Eligible", "Approval needed"]);
  assert.equal(list[0].patientName, "Al Mansoori, Fatima");
  assert.equal(list[0].result.plan, "Gold");
});

test("HTTP API: website accounts, import and walk-in check", async () => {
  const db = fresh();
  const srv = createServer(createApp({ db, cfg, env: { ELIGIBILITY_PROVIDER: "mock" } })).listen(0);
  await new Promise(r => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const json = { "content-type": "application/json" };
  assert.equal((await fetch(base + "/api/health")).status, 401);
  // No accounts yet: the clinic computer itself is offered the admin set-up, a visitor through the tunnel is not
  assert.match(await (await fetch(base + "/")).text(), /const MODE = "setup"/);
  assert.match(await (await fetch(base + "/", { headers: { "cf-connecting-ip": "5.6.7.8" } })).text(), /const MODE = "closed"/);
  assert.equal((await fetch(base + "/auth/setup", { method: "POST", headers: { ...json, "cf-connecting-ip": "5.6.7.8" }, body: JSON.stringify({ username: "owner", password: "longpassword" }) })).status, 403);
  const setup = await fetch(base + "/auth/setup", { method: "POST", headers: json, body: JSON.stringify({ username: "owner", name: "Owner", password: "longpassword" }) });
  assert.equal(setup.status, 200);
  const admin = { ...json, cookie: setup.headers.get("set-cookie").split(";")[0] };
  assert.equal((await fetch(base + "/auth/setup", { method: "POST", headers: json, body: JSON.stringify({ username: "x", password: "longpassword" }) })).status, 409);
  assert.equal((await (await fetch(base + "/api/me", { headers: admin })).json()).role, "admin");
  // The admin adds a staff account; staff can work but cannot manage accounts
  assert.equal((await fetch(base + "/api/users", { method: "POST", headers: admin, body: JSON.stringify({ username: "desk", name: "Front desk", role: "staff", password: "deskpassword" }) })).status, 200);
  assert.equal((await fetch(base + "/auth/login", { method: "POST", headers: json, body: JSON.stringify({ username: "desk", password: "wrong-one" }) })).status, 401);
  const li = await fetch(base + "/auth/login", { method: "POST", headers: json, body: JSON.stringify({ username: "DESK", password: "deskpassword" }) });
  assert.equal(li.status, 200);
  const auth = { ...json, cookie: li.headers.get("set-cookie").split(";")[0] };
  assert.equal((await fetch(base + "/api/users", { headers: auth })).status, 403);
  // A form post from another website is refused
  assert.equal((await fetch(base + "/api/eligibility", { method: "POST", headers: { cookie: auth.cookie, "content-type": "text/plain" }, body: "{}" })).status, 415);
  const home = await fetch(base + "/", { headers: auth });
  assert.match(await home.text(), /name="rcm-api"/);
  const imp = await (await fetch(base + "/api/appointments/import", { method: "POST", headers: auth,
    body: JSON.stringify({ csv: "time,patient_name,emirates_id,payer,card_no,plan,valid_until,department,doctor\n09:00,Test,784199012345671,DAM,DM-1,Gold,2099-01-01,General Practice," }) })).json();
  assert.equal(imp.checked, 1);
  assert.equal(imp.appointments[0].status, "Eligible");
  const walk = await (await fetch(base + "/api/eligibility", { method: "POST", headers: auth, body: JSON.stringify({ emiratesId: "784 1990 1234567 1", payer: "Daman" }) })).json();
  assert.equal(walk.status, "Eligible");
  const log = await (await fetch(base + "/api/checks", { headers: auth })).json();
  assert.equal(log.length, 2);
  // Disabling the account signs that person out
  const users = await (await fetch(base + "/api/users", { headers: admin })).json();
  await fetch(base + `/api/users/${users.find(x => x.username === "desk").id}`, { method: "POST", headers: admin, body: JSON.stringify({ active: false }) });
  const after = await fetch(base + "/api/checks", { headers: auth });
  assert.equal(after.status, 401);
  assert.equal((await after.json()).login, true);
  // The only admin cannot remove their own admin role
  assert.equal((await fetch(base + `/api/users/${users.find(x => x.username === "owner").id}`, { method: "POST", headers: admin, body: JSON.stringify({ role: "staff" }) })).status, 400);
  srv.close();
});
