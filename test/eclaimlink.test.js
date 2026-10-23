import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/util.js";
import * as ecl from "../src/eclaimlink/index.js";
import { tag, tags } from "../src/eclaimlink/soap.js";
import { parseFileList } from "../src/eclaimlink/transports.js";

const cfg = loadConfig();
const claimXml = (id, resub = false) => `<?xml version="1.0" encoding="utf-8"?>
<Claim.Submission>
  <Header><SenderID>DHA-F-0000000</SenderID><ReceiverID>DAM</ReceiverID><TransactionDate>23/10/2026 10:00</TransactionDate><RecordCount>1</RecordCount><DispositionFlag>TEST</DispositionFlag></Header>
  <Claim>
    <ID>${id}</ID><MemberID>DM-1</MemberID><PayerID>DAM</PayerID><ProviderID>DHA-F-0000000</ProviderID>
    <Activity><ID>${id}-1</ID><Code>99213</Code><Quantity>1</Quantity><Net>200.00</Net></Activity>
    <Activity><ID>${id}-2</ID><Code>85025</Code><Quantity>1</Quantity><Net>64.00</Net></Activity>${resub ? "<Resubmission><Type>correction</Type><Comment>fixed</Comment></Resubmission>" : ""}
  </Claim>
</Claim.Submission>`;

test("test mode: an uploaded claim comes back as a remittance on the next download", async () => {
  const ctx = { db: openDb(":memory:"), cfg, env: { ECLAIMLINK_MODE: "mock" } };
  const up = await ecl.upload(ctx, { xml: claimXml("CLM-1") });
  assert.equal(up.ok, true);
  assert.match(up.transactionId, /^MOCK-/);
  const s = await ecl.sync(ctx);
  assert.deepEqual([s.listed, s.downloaded, s.errors.length], [1, 1, 0]);
  const [f] = ecl.listFiles(ctx, { unapplied: true });
  assert.equal(f.type, "Remittance.Advice");
  assert.equal(tag(tags(f.xml, "Claim")[0], "ID"), "CLM-1");
  assert.equal((await ecl.sync(ctx)).listed, 0, "downloaded files are not offered again");
  assert.equal(ecl.markApplied(ctx, f.id), true);
  assert.equal(ecl.listFiles(ctx, { unapplied: true }).length, 0);
});

test("upload rejects files that are not claims or prior requests", async () => {
  const ctx = { db: openDb(":memory:"), cfg, env: { ECLAIMLINK_MODE: "mock" } };
  await assert.rejects(ecl.upload(ctx, { xml: "<Remittance.Advice/>" }), /Only Claim.Submission and Prior.Request/);
});

test("facility licence and payer IDs are swapped in before upload", () => {
  const c = { payers: [{ code: "DAM", eclaimlinkId: "A001" }] };
  const out = ecl.localize(claimXml("CLM-2"), c, { FACILITY_LICENSE: "DHA-F-1234567" });
  assert.match(out, /<ReceiverID>A001<\/ReceiverID>/);
  assert.match(out, /<PayerID>A001<\/PayerID>/);
  assert.match(out, /<SenderID>DHA-F-1234567<\/SenderID>/);
  assert.doesNotMatch(out, /DHA-F-0000000/);
});

test("parseFileList reads the GetNewTransactions list", () => {
  const l = parseFileList(`<Files><File FileID="11" FileName="ra.xml" SenderID="A001" ReceiverID="DHA-F-1" TransactionDate="23/10/2026 09:00" RecordCount="3" IsDownloaded="False"/></Files>`);
  assert.deepEqual(l, [{ fileId: "11", fileName: "ra.xml", sender: "A001", receiver: "DHA-F-1", transactionDate: "23/10/2026 09:00", recordCount: 3 }]);
});

// A stand-in for the eClaimLink SOAP endpoint, answering the four post office operations
function fakeDhpo() {
  const calls = [];
  const raXml = "<Remittance.Advice><Header><SenderID>A001</SenderID><ReceiverID>DHA-F-1</ReceiverID><RecordCount>1</RecordCount></Header><Claim><ID>CLM-9</ID></Claim></Remittance.Advice>";
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", c => b += c); req.on("end", () => {
      const op = req.headers.soapaction.replace(/"/g, "").split("/").pop();
      calls.push({ op, body: b, login: tag(b, "login"), pwd: tag(b, "pwd") });
      const reply = {
        UploadTransaction: (tag(b, "fileName") || "").includes("bad")
          ? "<UploadTransactionResult>-4</UploadTransactionResult><errorMessage>Invalid XML structure</errorMessage>"
          : `<UploadTransactionResult>1</UploadTransactionResult><errorMessage>accepted with warnings</errorMessage><errorReport>${Buffer.from("Claim CLM-1: missing clinician").toString("base64")}</errorReport><TransactionID>778</TransactionID>`,
        GetNewTransactions: `<GetNewTransactionsResult>0</GetNewTransactionsResult><xmlTransactions>${'<Files><File FileID="55" FileName="RA_55.xml" SenderID="A001" ReceiverID="DHA-F-1" RecordCount="1"/></Files>'.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</xmlTransactions><errorMessage/>`,
        DownloadTransactionFile: `<DownloadTransactionFileResult>0</DownloadTransactionFileResult><fileName>RA_55.xml</fileName><file>${Buffer.from(raXml).toString("base64")}</file><errorMessage/>`,
        SetTransactionDownloaded: "<SetTransactionDownloadedResult>0</SetTransactionDownloadedResult><errorMessage/>",
      }[op];
      res.setHeader("content-type", "text/xml; charset=utf-8");
      res.end(`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${op}Response xmlns="https://www.shafafiya.org/v2/">${reply}</${op}Response></soap:Body></soap:Envelope>`);
    });
  });
  return { srv, calls };
}

test("live mode speaks SOAP to the post office: upload, list, download, mark downloaded", async () => {
  const { srv, calls } = fakeDhpo();
  await new Promise(r => srv.listen(0, r));
  const env = { ECLAIMLINK_MODE: "live", ECLAIMLINK_URL: `http://127.0.0.1:${srv.address().port}/ValidateTransactions.asmx`, ECLAIMLINK_LOGIN: "clinic", ECLAIMLINK_PASSWORD: "p&ss" };
  const ctx = { db: openDb(":memory:"), cfg, env };
  try {
    const up = await ecl.upload(ctx, { xml: claimXml("CLM-1"), fileName: "claims1.xml" });
    assert.deepEqual([up.ok, up.warnings, up.transactionId, up.errorReport], [true, true, "778", "Claim CLM-1: missing clinician"]);
    assert.equal(calls[0].op, "UploadTransaction");
    assert.equal(calls[0].login, "clinic");
    assert.equal(calls[0].pwd, "p&amp;ss", "password is XML-escaped in the envelope");
    assert.match(Buffer.from(tag(calls[0].body, "fileContent"), "base64").toString(), /<ID>CLM-1<\/ID>/);

    const bad = await ecl.upload(ctx, { xml: claimXml("CLM-3"), fileName: "bad.xml" });
    assert.deepEqual([bad.ok, bad.resultCode, bad.errorMessage], [false, -4, "Invalid XML structure"]);

    const s = await ecl.sync(ctx);
    assert.deepEqual([s.listed, s.downloaded, s.errors.length], [1, 1, 0]);
    assert.deepEqual(calls.slice(2).map(c => c.op), ["GetNewTransactions", "DownloadTransactionFile", "SetTransactionDownloaded"]);
    assert.equal(tag(calls[4].body, "fileId"), "55");
    const [f] = ecl.listFiles(ctx, { unapplied: true });
    assert.deepEqual([f.type, f.file_id, f.sender], ["Remittance.Advice", "55", "A001"]);
  } finally { srv.close(); }
});

test("live mode without credentials reports a clear error", async () => {
  const ctx = { db: openDb(":memory:"), cfg, env: { ECLAIMLINK_MODE: "live" } };
  const up = await ecl.upload(ctx, { xml: claimXml("CLM-4") });
  assert.equal(up.ok, false);
  assert.match(up.errorMessage, /ECLAIMLINK_LOGIN/);
});
