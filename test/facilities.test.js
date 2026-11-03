import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/util.js";
import { createApp } from "../server.js";
import { push } from "../src/shared.js";

const claimXml = (id, sender) => `<?xml version="1.0" encoding="utf-8"?><Claim.Submission><Header><SenderID>${sender}</SenderID><ReceiverID>INS017</ReceiverID><TransactionDate>01/11/2026 09:00</TransactionDate><RecordCount>1</RecordCount><DispositionFlag>TEST</DispositionFlag></Header>
<Claim><ID>${id}</ID><MemberID>M1</MemberID><PayerID>INS017</PayerID><ProviderID>${sender}</ProviderID><Gross>100</Gross><PatientShare>0</PatientShare><Net>100</Net>
<Activity><ID>${id}-1</ID><Start>01/11/2026 09:00</Start><Type>3</Type><Code>99213</Code><Quantity>1</Quantity><Net>100</Net><Clinician>DHA-P-1</Clinician></Activity></Claim></Claim.Submission>`;

test("facilities: saved logins, one facility at a time, staff cannot switch, activity log", async () => {
  const db = openDb(":memory:");
  const env = { ECLAIMLINK_MODE: "mock", FACILITY_KEY: "11".repeat(32) };
  const srv = createServer(createApp({ db, cfg: loadConfig(), env }));
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, body, cookie) => {
    const r = await fetch(base + p, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
  };
  try {
    let admin = (await call("/auth/setup", { username: "owner", password: "owner-pass-1", name: "Owner" })).cookie;
    // Records from before facilities exist
    await call("/api/data", { upserts: [{ coll: "claims", id: "OLD-1", data: { id: "OLD-1" } }] }, admin);
    let me = (await call("/api/me", undefined, admin)).body;
    assert.equal(me.locked, false);

    const a = await call("/api/facilities", { name: "Clinic A", licence: "DHA-F-AAA", login: "clinicA", password: "secret-A" }, admin);
    assert.equal(a.status, 200);
    assert.equal(a.body.tookOver, true, "the first facility takes over the existing records");
    assert.equal(a.body.password, undefined);
    const row = db.prepare("SELECT secret FROM facilities WHERE id = ?").get(a.body.id);
    assert.ok(!row.secret.includes("secret-A"), "the password is stored encrypted");
    const b = await call("/api/facilities", { name: "Clinic B", licence: "DHA-F-BBB", login: "clinicB", password: "secret-B" }, admin);
    assert.equal(b.body.tookOver, false);
    assert.equal((await call("/api/facilities", { name: "Dup", licence: "dha-f-aaa", login: "x", password: "y" }, admin)).status, 409);
    const list = (await call("/api/facilities", undefined, admin)).body;
    assert.ok(list.every(f => f.password === undefined && f.secret === undefined));

    // While Clinic A was the only facility the admin was placed in it; a new sign-in with two facilities must choose first
    assert.equal((await call("/api/me", undefined, admin)).body.facility.licence, "DHA-F-AAA");
    admin = (await call("/auth/login", { username: "owner", password: "owner-pass-1" })).cookie;
    me = (await call("/api/me", undefined, admin)).body;
    assert.deepEqual([me.locked, me.needFacility, me.facilities.length], [true, true, 2]);
    assert.equal((await call("/api/data?since=0", undefined, admin)).status, 409);
    assert.equal((await call("/api/facility", { id: a.body.id }, admin)).status, 200);
    let data = (await call("/api/data?since=0", undefined, admin)).body;
    assert.deepEqual(data.changes.filter(c => c.coll === "claims").map(c => c.id), ["OLD-1"]);
    await call("/api/data", { upserts: [{ coll: "claims", id: "A-1", data: { id: "A-1" } }] }, admin);

    // Staff allowed only Clinic B go straight into it and never see Clinic A
    const st = (await call("/api/users", { username: "desk1", password: "desk-pass-1", role: "staff", facilities: [b.body.id] }, admin)).body;
    assert.deepEqual((await call("/api/users", undefined, admin)).body.find(u => u.id === st.id).facilities, [b.body.id]);
    const desk = (await call("/auth/login", { username: "desk1", password: "desk-pass-1" })).cookie;
    me = (await call("/api/me", undefined, desk)).body;
    assert.deepEqual([me.needFacility, me.facility.licence, me.facilities.length], [false, "DHA-F-BBB", 1]);
    data = (await call("/api/data?since=0", undefined, desk)).body;
    assert.equal(data.changes.filter(c => c.coll === "claims").length, 0, "Clinic A's claims are not visible in Clinic B");
    assert.equal((await call("/api/facility", { id: a.body.id }, desk)).status, 403, "staff cannot open a facility they are not allowed");
    assert.equal((await call("/api/facilities", undefined, desk)).status, 403);
    assert.equal((await call("/api/activity", undefined, desk)).status, 403);
    assert.equal((await call("/api/eclaimlink/login", { login: "someone", pwd: "x" }, desk)).status, 403, "personal eClaimLink sign-in is off");
    const status = (await call("/api/eclaimlink/status", undefined, desk)).body;
    assert.deepEqual([status.signedIn, status.signedInAs, status.canSignIn], [true, "Clinic B", false]);

    // Staff allowed both: choose once, then must sign out to change
    await call(`/api/users/${st.id}`, { facilities: null }, admin);
    const desk2 = (await call("/auth/login", { username: "desk1", password: "desk-pass-1" })).cookie;
    assert.equal((await call("/api/me", undefined, desk2)).body.needFacility, true);
    assert.equal((await call("/api/facility", { id: b.body.id }, desk2)).status, 200);
    assert.equal((await call("/api/facility", { id: a.body.id }, desk2)).status, 403, "staff sign out to change facility");
    assert.equal((await call("/api/facility", { id: b.body.id }, admin)).status, 200, "an admin may switch");

    // eClaimLink files belong to the facility that sent them
    const up = (await call("/api/eclaimlink/upload", { xml: claimXml("B-1", "DHA-F-BBB") }, desk2)).body;
    assert.equal(up.ok, true);
    assert.equal((await call("/api/eclaimlink/files?direction=out", undefined, desk2)).body.length, 1);
    await call("/api/facility", { id: a.body.id }, admin);
    assert.equal((await call("/api/eclaimlink/files?direction=out", undefined, admin)).body.length, 0);
    assert.equal((await call(`/api/eclaimlink/files/${up.id}`, undefined, admin)).status, 404);

    // A disabled facility can no longer be opened
    await call("/api/facilities", { id: b.body.id, active: false }, admin);
    me = (await call("/api/me", undefined, desk2)).body;
    assert.deepEqual([me.facilities.length, me.facility.licence], [1, "DHA-F-AAA"], "only Clinic A is left, so it opens");

    const log = (await call("/api/activity", undefined, admin)).body.map(l => l.action);
    for (const want of ["Website sign-in", "Added facility", "Opened facility", "Switched facility", "eClaimLink: sent file", "Changed facility", "Added website account"])
      assert.ok(log.includes(want), `activity log has "${want}"`);
    await call("/auth/logout", {}, desk2);
    assert.ok((await call("/api/activity", undefined, admin)).body.some(l => l.action === "Website sign-out" && l.user === "desk1"));
  } finally { srv.close(); }
});

test("shared records from before facilities stay readable after the table gains a facility column", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE shared_records (coll TEXT NOT NULL, id TEXT NOT NULL, json TEXT, rev INTEGER NOT NULL, updated_by TEXT, updated_at TEXT, PRIMARY KEY (coll, id));
    CREATE INDEX shared_records_rev ON shared_records(rev);
    INSERT INTO shared_records VALUES ('claims','C1','{"id":"C1"}',1,'x',NULL);`);
  const { initShared, pull } = await import("../src/shared.js");
  initShared(db);
  assert.deepEqual(pull(db, 0).changes, [{ coll: "claims", id: "C1", data: { id: "C1" } }]);
  push(db, { upserts: [{ coll: "claims", id: "C1", data: { id: "C1", x: 1 } }] }, "", "DHA-F-X");
  assert.deepEqual(pull(db, 0, "DHA-F-X").changes.map(c => c.data), [{ id: "C1", x: 1 }]);
  assert.deepEqual(pull(db, 0).changes.map(c => c.data), [{ id: "C1" }]);
});
