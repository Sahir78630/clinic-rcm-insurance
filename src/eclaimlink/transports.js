import { call, tag, tags, xmlUnesc } from "./soap.js";

// A transport moves files to and from eClaimLink. "live" talks to the real web service,
// "mock" simulates it inside the clinic database so the whole workflow can be tried without credentials.

export function liveTransport(opts) {
  return {
    name: "live",
    async upload(fileName, xml) {
      const { result, out } = await call("UploadTransaction",
        { fileContent: Buffer.from(xml, "utf8").toString("base64"), fileName },
        ["errorMessage", "errorReport", "TransactionID"], opts);
      return { result, transactionId: out.TransactionID || null, errorMessage: out.errorMessage || null, errorReport: decodeReport(out.errorReport) };
    },
    async listNew() {
      const { out } = await call("GetNewTransactions", {}, ["xmlTransactions", "errorMessage"], opts);
      return parseFileList(out.xmlTransactions);
    },
    async download(fileId) {
      const { out } = await call("DownloadTransactionFile", { fileId }, ["fileName", "file", "errorMessage"], opts);
      return { fileName: out.fileName, xml: Buffer.from(out.file, "base64").toString("utf8") };
    },
    async markDownloaded(fileId) {
      await call("SetTransactionDownloaded", { fileId }, ["errorMessage"], opts);
    },
  };
}

// The error report comes back base64 encoded; show it as text when it is text
function decodeReport(b64) {
  if (!b64) return null;
  const buf = Buffer.from(b64, "base64");
  const txt = buf.toString("utf8");
  return /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(txt) ? txt : `(binary report, ${buf.length} bytes)`;
}

// GetNewTransactions returns a list like <Files><File FileID="…" FileName="…" SenderID="…" … /></Files>
export function parseFileList(xml) {
  return [...String(xml || "").matchAll(/<File\b([^>]*?)\/?>/g)].map(m => {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(a => [a[1].toLowerCase(), xmlUnesc(a[2])]));
    return { fileId: attrs.fileid, fileName: attrs.filename, sender: attrs.senderid, receiver: attrs.receiverid,
      transactionDate: attrs.transactiondate, recordCount: Number(attrs.recordcount) || null };
  }).filter(f => f.fileId);
}

const dt = d => { const p = n => String(n).padStart(2, "0"); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
// deterministic so tests are stable: roughly one claim in five has its last activity denied
const denies = id => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 5 === 0;

export function mockTransport(db) {
  const queue = (sender, receiver, root, body, count) => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<${root}>
  <Header>
    <SenderID>${sender}</SenderID>
    <ReceiverID>${receiver}</ReceiverID>
    <TransactionDate>${dt(new Date())}</TransactionDate>
    <RecordCount>${count}</RecordCount>
    <DispositionFlag>TEST</DispositionFlag>
  </Header>
${body}
</${root}>`;
    db.prepare("INSERT INTO eclaimlink_mock_inbox (file_name, sender, receiver, record_count, xml) VALUES (?,?,?,?,?)")
      .run(`${root === "Remittance.Advice" ? "RA" : "PA"}_${sender}_${Date.now()}_${Math.floor(Math.random() * 1e4)}.xml`, sender, receiver, count, xml);
  };
  return {
    name: "mock",
    async upload(fileName, xml) {
      const root = (xml.match(/<([\w.]+)[\s>]/g) || []).map(t => t.slice(1, -1)).find(t => !t.startsWith("?"));
      const header = tag(xml, "Header") || "";
      const facility = tag(header, "SenderID") || "FACILITY", payer = tag(header, "ReceiverID") || "PAYER";
      const ref = `TT${Date.now().toString().slice(-8)}`;
      if (root === "Claim.Submission") {
        const claims = tags(xml, "Claim");
        if (!claims.length) return { result: -2, errorMessage: "File has no Claim records", transactionId: null };
        const body = claims.map(c => {
          const id = tag(c, "ID"), resub = tag(c, "Resubmission") !== null, acts = tags(c, "Activity");
          return `  <Claim>
    <ID>${id}</ID>
    <IDPayer>${payer}${id.replace(/\D/g, "").slice(-6)}</IDPayer>
    <ProviderID>${facility}</ProviderID>
    <PaymentReference>${ref}</PaymentReference>
    <DateSettlement>${dt(new Date()).slice(0, 10)}</DateSettlement>
${acts.map((a, i) => {
    const net = Number(tag(a, "Net")) || 0, deny = !resub && denies(id) && i === acts.length - 1;
    return `    <Activity>
      <ID>${tag(a, "ID")}</ID>
      <Code>${tag(a, "Code")}</Code>
      <Quantity>${tag(a, "Quantity") || 1}</Quantity>
      <Net>${net.toFixed(2)}</Net>
      <PaymentAmount>${deny ? "0.00" : net.toFixed(2)}</PaymentAmount>${deny ? "\n      <DenialCode>MNEC-004</DenialCode>" : ""}
    </Activity>`; }).join("\n")}
  </Claim>`; }).join("\n");
        queue(payer, facility, "Remittance.Advice", body, claims.length);
        return { result: 0, transactionId: `MOCK-${ref}`, errorMessage: null, errorReport: null };
      }
      if (root === "Prior.Request") {
        const auths = tags(xml, "Authorization");
        const body = auths.map(a => `  <Authorization>
    <Result>Yes</Result>
    <ID>${tag(a, "ID")}</ID>
    <IDPayer>${payer}-${tag(a, "ID")}</IDPayer>
    <Start>${dt(new Date())}</Start>
    <End>${dt(new Date(Date.now() + 30 * 864e5))}</End>
    <Comments>Approved (test mode)</Comments>
${tags(a, "Activity").map(x => `    <Activity>
      <ID>${tag(x, "ID")}</ID>
      <Code>${tag(x, "Code")}</Code>
      <Quantity>${tag(x, "Quantity") || 1}</Quantity>
      <Net>${tag(x, "Net")}</Net>
      <PaymentAmount>${tag(x, "Net")}</PaymentAmount>
    </Activity>`).join("\n")}
  </Authorization>`).join("\n");
        queue(payer, facility, "Prior.Authorization", body, auths.length);
        return { result: 0, transactionId: `MOCK-${ref}`, errorMessage: null, errorReport: null };
      }
      return { result: -3, errorMessage: `Unsupported file type ${root || "(none)"}`, transactionId: null };
    },
    async listNew() {
      return db.prepare("SELECT id, file_name, sender, receiver, record_count, created_at FROM eclaimlink_mock_inbox WHERE downloaded = 0 ORDER BY id").all()
        .map(r => ({ fileId: String(r.id), fileName: r.file_name, sender: r.sender, receiver: r.receiver, transactionDate: r.created_at, recordCount: r.record_count }));
    },
    async download(fileId) {
      const r = db.prepare("SELECT file_name, xml FROM eclaimlink_mock_inbox WHERE id = ?").get(Number(fileId));
      return { fileName: r.file_name, xml: r.xml };
    },
    async markDownloaded(fileId) {
      db.prepare("UPDATE eclaimlink_mock_inbox SET downloaded = 1 WHERE id = ?").run(Number(fileId));
    },
  };
}
