import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/util.js";
import { createApp } from "../server.js";

test("claim attachments: upload, open, remove", async () => {
  const db = openDb(":memory:");
  const srv = createServer(createApp({ db, cfg: loadConfig(), env: { ECLAIMLINK_MODE: "mock" } })).listen(0, "127.0.0.1");
  await new Promise(r => srv.once("listening", r));
  const H = `http://127.0.0.1:${srv.address().port}`;
  try {
    const s = await fetch(H + "/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: "owner-pass-1" }) });
    const cookie = s.headers.get("set-cookie").split(";")[0];
    const post = (p, b) => fetch(H + p, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(b) });
    const pdf = Buffer.from("%PDF-1.4 ecg report");
    const up = await (await post("/api/files", { claim: "C-1", name: "ecg/report.pdf", type: "application/pdf", data: "data:application/pdf;base64," + pdf.toString("base64") })).json();
    assert.equal(up.size, pdf.length);
    assert.equal(up.name, "ecg_report.pdf");
    assert.equal(up.by, "owner");
    const g = await fetch(`${H}/api/files/${up.id}`, { headers: { cookie } });
    assert.equal(g.status, 200);
    assert.equal(g.headers.get("content-type"), "application/pdf");
    assert.match(g.headers.get("content-disposition"), /^inline/);
    assert.equal(g.headers.get("content-security-policy"), null);
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), pdf);
    // Not signed in: no file
    assert.equal((await fetch(`${H}/api/files/${up.id}`)).status, 401);
    // HTML is downloaded, never shown as a page
    const h = await (await post("/api/files", { claim: "C-1", name: "x.html", type: "text/html", data: Buffer.from("<script>1</script>").toString("base64") })).json();
    const hg = await fetch(`${H}/api/files/${h.id}`, { headers: { cookie } });
    assert.equal(hg.headers.get("content-type"), "application/octet-stream");
    assert.match(hg.headers.get("content-disposition"), /^attachment/);
    assert.equal(hg.headers.get("content-security-policy"), "sandbox");
    assert.equal((await post(`/api/files/${up.id}/delete`, {})).status, 200);
    assert.equal((await fetch(`${H}/api/files/${up.id}`, { headers: { cookie } })).status, 404);
    assert.equal((await post(`/api/files/${up.id}/delete`, {})).status, 404);
    assert.equal((await post("/api/files", { claim: "C-1", name: "e.pdf", data: "" })).status, 400);
  } finally { srv.close(); }
});
