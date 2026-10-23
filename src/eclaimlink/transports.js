import { call, settings, tag, tags, xmlUnesc } from "./soap.js";

// A transport moves files to and from eClaimLink. "live" talks to the real web service,
// "mock" simulates it inside the clinic database so the whole workflow can be tried without credentials.

export function liveTransport(opts) {
  // The DHPO specification v4 spells the download parameter "fileID"; override if your WSDL differs
  const fileParam = (opts.env || process.env).ECLAIMLINK_FILE_ID_PARAM || "fileID";
  return {
    name: "live",
    async upload(fileName, xml) {
      const { result, out } = await call("UploadTransaction",
        { fileContent: Buffer.from(xml, "utf8").toString("base64"), fileName },
        ["errorMessage", "errorReport", "TransactionID"], opts);
      return { result, transactionId: out.TransactionID || null, errorMessage: out.errorMessage || null, errorReport: decodeReport(out.errorReport) };
    },
    // Claims and remittances come from GetNewTransactions. DHA advises GetNewPriorAuthorizationTransactions
    // for prior authorization replies, as it is faster; it returns 2 when there is nothing new.
    async listNew() {
      const { out } = await call("GetNewTransactions", {}, ["xmlTransactions", "errorMessage"], opts);
      const files = parseFileList(out.xmlTransactions);
      const pa = await call("GetNewPriorAuthorizationTransactions", {}, ["xmlTransaction", "xmlTransactions", "errorMessage"], opts);
      const seen = new Set(files.map(f => f.fileId));
      for (const f of parseFileList(pa.out.xmlTransaction || pa.out.xmlTransactions)) if (!seen.has(f.fileId)) files.push(f);
      return files;
    },
    async download(fileId) {
      const { out } = await call("DownloadTransactionFile", { [fileParam]: fileId }, ["fileName", "file", "errorMessage"], opts);
      return { fileName: out.fileName || null, xml: Buffer.from(out.file, "base64").toString("utf8") };
    },
    async markDownloaded(fileId) {
      await call("SetTransactionDownloaded", { [fileParam]: fileId }, ["errorMessage"], opts);
    },
    // SearchTransactions: q = { direction 1|2, type, status 1|2, from, to (dd/MM/yyyy HH:mm:ss), name, callerLicense, partner, archive }
    async search(q) {
      const s = settings(opts.env || process.env);
      const op = q.archive ? s.archiveSearchOp : "SearchTransactions";
      const { result, out } = await call(op, {
        direction: q.direction, callerLicense: q.callerLicense || null, ePartner: q.partner || null,
        transactionID: q.type, transactionStatus: q.status, transactionFileName: q.name || null,
        transactionFromDate: q.from || null, transactionToDate: q.to || null, minRecordCount: -1, maxRecordCount: -1,
      }, ["foundTransactions", "errorMessage"], { ...opts, url: q.archive ? s.archiveUrl : undefined, allow: [-10] });
      return { files: result === -10 ? [] : parseFileList(out.foundTransactions), note: result === -10 ? out.errorMessage || "No matching files" : null };
    },
    // Opens a file without flagging it as downloaded, so the inbox still offers it
    async view(fileId, { archive } = {}) {
      const s = settings(opts.env || process.env);
      const { out } = await call(archive ? s.archiveDownloadOp : "DownloadTransactionFile", { [fileParam]: fileId }, ["fileName", "file", "errorMessage"],
        { ...opts, url: archive ? s.archiveUrl : undefined });
      return { fileName: out.fileName || null, xml: Buffer.from(out.file, "base64").toString("utf8") };
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

// GetNewTransactions returns a list like <Files><File FileID='…' FileName='…' SenderID='…' … /></Files>
export function parseFileList(xml) {
  const flag = v => v == null ? null : /^true$/i.test(v);
  return [...String(xml || "").matchAll(/<File\b([^>]*?)\/?>/g)].map(m => {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(a => [a[1].toLowerCase(), xmlUnesc(a[2] ?? a[3])]));
    return { fileId: attrs.fileid, fileName: attrs.filename, sender: attrs.senderid, receiver: attrs.receiverid,
      transactionDate: attrs.transactiondate, recordCount: Number(attrs.recordcount) || null, isDownloaded: flag(attrs.isdownloaded) };
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
      <Start>${tag(a, "Start") || tag(tag(c, "Encounter") || "", "Start") || dt(new Date())}</Start>
      <Code>${tag(a, "Code")}</Code>
      <Quantity>${tag(a, "Quantity") || 1}</Quantity>
      <Net>${net.toFixed(2)}</Net>${tag(a, "Clinician") ? `\n      <Clinician>${tag(a, "Clinician")}</Clinician>` : ""}
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
        .map(r => ({ fileId: `M${r.id}`, fileName: r.file_name, sender: r.sender, receiver: r.receiver, transactionDate: r.created_at, recordCount: r.record_count }));
    },
    async download(fileId) {
      const r = db.prepare("SELECT file_name, xml FROM eclaimlink_mock_inbox WHERE id = ?").get(Number(String(fileId).replace(/^M/, "")));
      return { fileName: r.file_name, xml: r.xml };
    },
    async markDownloaded(fileId) {
      db.prepare("UPDATE eclaimlink_mock_inbox SET downloaded = 1 WHERE id = ?").run(Number(String(fileId).replace(/^M/, "")));
    },
    // Received files are the simulated inbox; sent files are the accepted uploads in the file log
    async search(q) {
      const types = { 2: "Claim.Submission", 4: "Person.Register", 8: "Remittance.Advice", 16: "Prior.Request", 32: "Prior.Authorization" };
      const want = q.type === -1 ? null : types[q.type];
      const toIso = d => d ? `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)} ${d.slice(11) || "00:00:00"}` : null;
      const from = toIso(q.from), to = toIso(q.to);
      const rows = q.direction === 2
        ? db.prepare("SELECT 'M' || id AS fid, id, file_name, sender, receiver, record_count, created_at, downloaded, xml FROM eclaimlink_mock_inbox").all()
        : db.prepare("SELECT 'S' || id AS fid, id, file_name, sender, receiver, record_count, created_at, 1 AS downloaded, xml FROM eclaimlink_files WHERE direction = 'out' AND result_code >= 0").all();
      const files = rows.filter(r => {
        const type = (r.xml.match(/<([A-Za-z][\w.]*)[\s>]/) || [])[1];
        if (want && type !== want) return false;
        if (q.status === 1 && r.downloaded) return false;
        if (q.status === 2 && !r.downloaded) return false;
        if (from && r.created_at < from) return false;
        if (to && r.created_at > to) return false;
        if (q.name && !r.file_name.toLowerCase().includes(q.name.toLowerCase())) return false;
        return true;
      }).map(r => { const [y, m, d] = r.created_at.slice(0, 10).split("-");
        return { fileId: r.fid, fileName: r.file_name, sender: r.sender, receiver: r.receiver, transactionDate: `${d}/${m}/${y} ${r.created_at.slice(11)}`, recordCount: r.record_count, isDownloaded: Boolean(r.downloaded) }; });
      return { files: q.archive ? [] : files, note: q.archive ? "The archive is empty in test mode" : null };
    },
    async view(fileId) {
      const id = Number(String(fileId).slice(1));
      const r = String(fileId)[0] === "S"
        ? db.prepare("SELECT file_name, xml FROM eclaimlink_files WHERE id = ?").get(id)
        : db.prepare("SELECT file_name, xml FROM eclaimlink_mock_inbox WHERE id = ?").get(id);
      if (!r) throw Object.assign(new Error("File not found"), { code: 404 });
      return { fileName: r.file_name, xml: r.xml };
    },
  };
}
