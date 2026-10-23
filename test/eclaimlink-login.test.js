import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/util.js";
import { tag } from "../src/eclaimlink/soap.js";
import { createApp } from "../server.js";

// A stand-in eClaimLink that only knows one user, nurse1 / s3cret
function fakeDhpo() {
  const calls = [];
  const srv = createServer((req, res) => { let b = ""; req.on("data", c => b += c); req.on("end", () => {
    const op = req.headers.soapaction.replace(/"/g, "").split("/").pop();
    calls.push({ op, login: tag(b, "login"), pwd: tag(b, "pwd") });
    const ok = tag(b, "login") === "nurse1" && tag(b, "pwd") === "s3cret";
    const list = "<Files><File FileID='9' FileName='ra9.xml' SenderID='A001' ReceiverID='DHA-F-1' TransactionDate='20/10/2026 08:00:00' RecordCount='2' IsDownloaded='True' /></Files>";
    const body = ok ? `<SearchTransactionsResult>0</SearchTransactionsResult><foundTransactions>${list.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</foundTransactions><errorMessage/>`
      : "<SearchTransactionsResult>-1</SearchTransactionsResult><foundTransactions/><errorMessage>Login failed</errorMessage>";
    res.end(`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${op}Response>${body}</${op}Response></soap:Body></soap:Envelope>`);
  }); });
  return { srv, calls };
}

test("staff sign in with their own eClaimLink login and browse files in their session", async () => {
  const { srv: dhpo, calls } = fakeDhpo();
  await new Promise(r => dhpo.listen(0, r));
  const env = { ECLAIMLINK_URL: `http://127.0.0.1:${dhpo.address().port}/ValidateTransactions.asmx` };
  const app = createServer(createApp({ db: openDb(":memory:"), cfg: loadConfig(), env }));
  await new Promise(r => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}/api/eclaimlink`;
  const post = (p, body, cookie) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(cookie && { cookie }) }, body: JSON.stringify(body) });
  try {
    let st = await (await fetch(base + "/status")).json();
    assert.deepEqual([st.mode, st.signedIn, st.canSignIn, st.serverLogin], ["mock", false, true, false]);

    const bad = await post("/login", { login: "nurse1", pwd: "wrong" });
    assert.equal(bad.status, 401);
    assert.match((await bad.json()).error, /did not accept/);
    assert.equal(bad.headers.get("set-cookie"), null);

    const good = await post("/login", { login: "nurse1", pwd: "s3cret" });
    assert.equal(good.status, 200);
    const setCookie = good.headers.get("set-cookie");
    assert.match(setCookie, /^rcm_ecl=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict/);
    const body = await good.json();
    assert.deepEqual([body.mode, body.signedIn, body.signedInAs], ["live", true, "nurse1"]);
    assert.ok(!JSON.stringify(body).includes("s3cret"), "the password never goes back to the browser");
    const cookie = setCookie.split(";")[0];

    calls.length = 0;
    const r = await (await fetch(base + "/search?direction=received&type=Remittance.Advice&status=downloaded&from=2026-10-01&to=2026-10-20", { headers: { cookie } })).json();
    assert.deepEqual(r.files.map(f => f.fileId), ["9"]);
    assert.deepEqual([calls[0].login, calls[0].pwd], ["nurse1", "s3cret"], "searches use the signed-in user's login");

    // Without the cookie the same server stays in test mode
    st = await (await fetch(base + "/status")).json();
    assert.equal(st.mode, "mock");

    await post("/logout", {}, cookie);
    st = await (await fetch(base + "/status", { headers: { cookie } })).json();
    assert.deepEqual([st.signedIn, st.mode], [false, "mock"]);
  } finally { app.close(); dhpo.close(); }
});

test("sign-in is throttled after five wrong passwords", async () => {
  const { srv: dhpo } = fakeDhpo();
  await new Promise(r => dhpo.listen(0, r));
  const app = createServer(createApp({ db: openDb(":memory:"), cfg: loadConfig(), env: { ECLAIMLINK_URL: `http://127.0.0.1:${dhpo.address().port}/x.asmx` } }));
  await new Promise(r => app.listen(0, r));
  const login = pwd => fetch(`http://127.0.0.1:${app.address().port}/api/eclaimlink/login`, { method: "POST", body: JSON.stringify({ login: "nurse1", pwd }) });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login("nope")).status, 401);
    assert.equal((await login("s3cret")).status, 429);
  } finally { app.close(); dhpo.close(); }
});

test("an ended session is reported instead of falling back to test mode", async () => {
  const app = createServer(createApp({ db: openDb(":memory:"), cfg: loadConfig(), env: {} }));
  await new Promise(r => app.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${app.address().port}/api/eclaimlink/files`, { headers: { cookie: "rcm_ecl=expired-or-unknown" } });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "Your eClaimLink session has ended. Sign in again.", signIn: true });
  } finally { app.close(); }
});
