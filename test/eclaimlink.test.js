import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/util.js";
import * as ecl from "../src/eclaimlink/index.js";
import { tag, tags } from "../src/eclaimlink/soap.js";
import { parseFileList } from "../src/eclaimlink/transports.js";

const cfg = loadConfig();
// The WSDL spells one parameter TransactionStatus; the connector must follow its spelling and order
const WSDL = `<wsdl:definitions targetNamespace="http://www.eClaimLink.ae/"><wsdl:types><s:schema>
  <s:element name="SearchTransactions"><s:complexType><s:sequence>
    <s:element minOccurs="0" maxOccurs="1" name="login" type="s:string" /><s:element minOccurs="0" maxOccurs="1" name="pwd" type="s:string" />
    <s:element minOccurs="1" maxOccurs="1" name="direction" type="s:int" /><s:element minOccurs="0" maxOccurs="1" name="callerLicense" type="s:string" />
    <s:element minOccurs="0" maxOccurs="1" name="ePartner" type="s:string" /><s:element minOccurs="1" maxOccurs="1" name="transactionID" type="s:int" />
    <s:element minOccurs="1" maxOccurs="1" name="TransactionStatus" type="s:int" /><s:element minOccurs="0" maxOccurs="1" name="transactionFileName" type="s:string" />
    <s:element minOccurs="0" maxOccurs="1" name="transactionFromDate" type="s:string" /><s:element minOccurs="0" maxOccurs="1" name="transactionToDate" type="s:string" />
    <s:element minOccurs="1" maxOccurs="1" name="minRecordCount" type="s:int" /><s:element minOccurs="1" maxOccurs="1" name="maxRecordCount" type="s:int" />
  </s:sequence></s:complexType></s:element></s:schema></wsdl:types>
  <wsdl:binding name="b"><wsdl:operation name="SearchTransactions">
  <soap:operation soapAction="http://www.eClaimLink.ae/SearchTransactions" style="document" /></wsdl:operation></wsdl:binding></wsdl:definitions>`;

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
  const l = parseFileList(`<Files><File FileID='11' FileName='ra.xml' SenderID='A001' ReceiverID="DHA-F-1" TransactionDate='23/10/2026 09:00' RecordCount='3' IsDownloaded='False' /></Files>`);
  assert.deepEqual(l, [{ fileId: "11", fileName: "ra.xml", sender: "A001", receiver: "DHA-F-1", transactionDate: "23/10/2026 09:00", recordCount: 3, isDownloaded: false }]);
});

// A stand-in for the eClaimLink SOAP endpoint, answering the four post office operations
function fakeDhpo() {
  const calls = [];
  const raXml = "<Remittance.Advice><Header><SenderID>A001</SenderID><ReceiverID>DHA-F-1</ReceiverID><RecordCount>1</RecordCount></Header><Claim><ID>CLM-9</ID></Claim></Remittance.Advice>";
  const srv = createServer((req, res) => { if (req.method === "GET") return res.end(WSDL);
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
        GetNewPriorAuthorizationTransactions: "<GetNewPriorAuthorizationTransactionsResult>2</GetNewPriorAuthorizationTransactionsResult><xmlTransaction/><errorMessage>No new prior authorization transactions</errorMessage>",
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
    assert.match(calls[0].body, /<UploadTransaction xmlns="http:\/\/www\.eClaimLink\.ae\/">/, "namespace read from the service WSDL");
    assert.equal(calls[0].login, "clinic");
    assert.equal(calls[0].pwd, "p&amp;ss", "password is XML-escaped in the envelope");
    assert.match(Buffer.from(tag(calls[0].body, "fileContent"), "base64").toString(), /<ID>CLM-1<\/ID>/);

    const bad = await ecl.upload(ctx, { xml: claimXml("CLM-3"), fileName: "bad.xml" });
    assert.deepEqual([bad.ok, bad.resultCode, bad.errorMessage], [false, -4, "Invalid XML structure"]);

    const s = await ecl.sync(ctx);
    assert.deepEqual([s.listed, s.downloaded, s.errors.length], [1, 1, 0]);
    assert.deepEqual(calls.slice(2).map(c => c.op), ["GetNewTransactions", "GetNewPriorAuthorizationTransactions", "DownloadTransactionFile", "SetTransactionDownloaded"]);
    assert.equal(tag(calls[4].body, "fileID"), "55", "parameter spelled as in the DHPO v4 specification");
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

test("browse: search sent and received files, open one, build a report (test mode)", async () => {
  const ctx = { db: openDb(":memory:"), cfg, env: { ECLAIMLINK_MODE: "mock" } };
  await ecl.upload(ctx, { xml: claimXml("CLM-10") });
  await ecl.upload(ctx, { xml: claimXml("CLM-11", true) });
  const today = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const recvNew = await ecl.search(ctx, { direction: "received", type: "all", status: "new", from, to: today });
  assert.equal(recvNew.files.length, 2);
  assert.ok(recvNew.files.every(f => f.type === "Remittance.Advice" && f.isDownloaded === false));
  await ecl.sync(ctx);
  const recvDone = await ecl.search(ctx, { direction: "received", type: "Remittance.Advice", status: "downloaded", from, to: today });
  assert.equal(recvDone.files.length, 2);
  const sent = await ecl.search(ctx, { direction: "sent", type: "all", status: "all", from, to: today });
  assert.deepEqual(sent.files.map(f => f.type), ["Claim.Submission", "Claim.Submission"]);
  const v = await ecl.view(ctx, sent.files[0].fileId);
  assert.equal(v.summary.type, "Claim.Submission");
  assert.equal(v.summary.totals.net, 264);
  const rep = await ecl.report(ctx, [...recvDone.files, ...sent.files].map(f => ({ fileId: f.fileId })));
  assert.equal(rep.files, 4);
  assert.equal(rep.byType["Remittance.Advice"].records, 2);
  assert.equal(rep.submissionsByPayer.DAM.resubmissions, 1);
  assert.equal(rep.remittanceByPayer.DAM.claims, 2);
  assert.equal(rep.errors.length, 0);
  const r = await ecl.rows(ctx, recvDone.files.map(f => ({ fileId: f.fileId, fileName: f.fileName })));
  assert.equal(r.files.length, 2);
  assert.ok(r.files.every(f => f.type === "Remittance.Advice" && f.rows.length === 1 && f.header.sender === "DAM"));
  assert.deepEqual(Object.keys(r.files[0].rows[0]).sort(), ["denialCodes", "denied", "id", "net", "paid", "payerRef", "paymentRef", "settlement"]);
});

test("browse: date range limits follow the DHPO rules", async () => {
  const ctx = { db: openDb(":memory:"), cfg, env: { ECLAIMLINK_MODE: "mock" } };
  await assert.rejects(ecl.search(ctx, { direction: "received", from: "2026-01-01", to: "2026-06-30" }), /100 days/);
  await assert.rejects(ecl.search(ctx, { direction: "received", from: "2024-01-01", to: "2024-03-01", archive: true }), /one month/);
});

test("browse: live SearchTransactions sends the spec parameters and reads foundTransactions", async () => {
  const bodies = [];
  const srv = createServer((req, res) => { if (req.method === "GET") return res.end(WSDL); let b = ""; req.on("data", c => b += c); req.on("end", () => {
    bodies.push({ url: req.url, op: req.headers.soapaction.replace(/"/g, "").split("/").pop(), body: b });
    const list = tag(b, "TransactionStatus") === "1" ? "<Files><File FileID='7' FileName='ra7.xml' SenderID='A001' ReceiverID='DHA-F-1' TransactionDate='01/10/2026 08:00:00' RecordCount='4' IsDownloaded='False' /></Files>" : "<Files></Files>";
    res.end(`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><SearchTransactionsResponse><SearchTransactionsResult>0</SearchTransactionsResult><foundTransactions>${list.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</foundTransactions><errorMessage/></SearchTransactionsResponse></soap:Body></soap:Envelope>`);
  }); });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const env = { ECLAIMLINK_MODE: "live", ECLAIMLINK_URL: `${base}/ValidateTransactions.asmx`, ECLAIMLINK_ARCHIVE_URL: `${base}/ClaimsAndAuthorizationsArchive.asmx`,
    ECLAIMLINK_LOGIN: "u", ECLAIMLINK_PASSWORD: "p", FACILITY_LICENSE: "DHA-F-1" };
  try {
    const r = await ecl.search({ db: openDb(":memory:"), cfg, env }, { direction: "received", type: "Remittance.Advice", status: "all", from: "2026-09-01", to: "2026-10-01" });
    assert.deepEqual(r.files.map(f => [f.fileId, f.type, f.isDownloaded, f.recordCount]), [["7", "Remittance.Advice", false, 4]]);
    const b = bodies[0].body;
    assert.equal(tag(b, "direction"), "2");
    assert.equal(tag(b, "transactionID"), "8");
    assert.equal(tag(b, "TransactionStatus"), "1", "spelled as in the WSDL");
    assert.equal(tag(b, "transactionStatus"), null);
    assert.equal(tag(b, "callerLicense"), "DHA-F-1");
    assert.equal(tag(b, "transactionFromDate"), "01/09/2026 00:00:00");
    assert.equal(tag(b, "transactionToDate"), "01/10/2026 23:59:59");
    assert.match(b, /<ePartner xsi:nil="true" \/>/);
    assert.equal(tag(b, "minRecordCount"), "-1");
    await ecl.search({ db: openDb(":memory:"), cfg, env }, { direction: "sent", type: "Claim.Submission", status: "new", from: "2024-01-01", to: "2024-01-20", archive: true });
    assert.equal(bodies.at(-1).url, "/ClaimsAndAuthorizationsArchive.asmx");
  } finally { srv.close(); }
});
