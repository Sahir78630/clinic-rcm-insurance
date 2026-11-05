import { inflateRawSync, gunzipSync } from "node:zlib";
import { call, settings, tag, tags, xmlUnesc } from "./soap.js";

// A transport moves files to and from eClaimLink. "live" talks to the real web service,
// "mock" simulates it inside the clinic database so the whole workflow can be tried without credentials.

export function liveTransport(opts) {
  // The DHPO specification v4 spells the download parameter "fileID"; override if your WSDL differs
  const fileParam = (opts.env || process.env).ECLAIMLINK_FILE_ID_PARAM || "fileID";
  return {
    name: "live",
    async upload(fileName, xml) {
      let result, out;
      try { ({ result, out } = await call("UploadTransaction",
        { fileContent: Buffer.from(xml, "utf8").toString("base64"), fileName },
        ["errorMessage", "errorReport", "TransactionID"], opts)); }
      catch (e) {
        // A rejected file (for example -2, validation failed) still carries the error report: keep it so staff can see which claim failed and why
        if (!e.out || !Number.isInteger(e.code)) throw e;
        return { result: e.code, transactionId: null, errorMessage: e.out.errorMessage || null, errorReport: decodeReport(e.out.errorReport) };
      }
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

// The error report comes back base64 encoded: usually a zipped CSV, sometimes gzip or plain text
export function decodeReport(b64) {
  if (!b64) return null;
  const buf = Buffer.from(b64, "base64");
  let txt = null;
  try {
    if (buf[0] === 0x50 && buf[1] === 0x4b) txt = unzipText(buf);
    else if (buf[0] === 0x1f && buf[1] === 0x8b) txt = gunzipSync(buf).toString("utf8");
  } catch { txt = null; }
  if (txt == null) txt = buf.toString("utf8");
  txt = txt.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  return /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(txt) ? txt : `(binary report, ${buf.length} bytes)`;
}
// Reads every file in a zip (stored or deflated) from its central directory and joins their text
function unzipText(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10), parts = [];
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nLen = buf.readUInt16LE(p + 28), xLen = buf.readUInt16LE(p + 30), cLen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nLen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + size);
    if (!name.endsWith("/")) parts.push((method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    p += 46 + nLen + xLen + cLen;
  }
  return parts.join("\n");
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

// fac: the facility licence the website is working in; it only sees that facility's simulated files
export function mockTransport(db, fac = "") {
  const inbox = fac ? "receiver = ?" : "?1 = ?1", sent = fac ? "facility = ?" : "?1 = ?1";
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
        // Test mode checks a little like DHPO does: a claim whose ID contains INVALID, or an observation without a code,
        // makes the whole file fail with -2 and a CSV error report
        const errs = claims.flatMap(c => { const id = tag(c, "ID");
          return [...(/INVALID/i.test(id) ? [`${id},,Claim,Test mode: claim ${id} is marked invalid`] : []),
            ...tags(c, "Activity").filter(a => tags(a, "Observation").some(o => !(tag(o, "Code") || "").trim())).map(a => `${id},${tag(a, "ID")},Observation,Observation Code is required`),
            ...((tag(c, "IDPayer") || "").trim() && !["correction", "internal complaint"].includes((tag(tag(c, "Resubmission") || "", "Type") || "").trim().toLowerCase())
              ? [`${id},,IDPayer,IDPayer must be empty unless Resubmission.Type = 'correction' or 'internal complaint'`] : [])]; });
        if (errs.length) return { result: -2, errorMessage: "eClaim transaction validation is failed with errors", transactionId: null,
          errorReport: ["ClaimID,ActivityID,Element,Error", ...errs].join("\n") };
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
      return db.prepare(`SELECT id, file_name, sender, receiver, record_count, created_at FROM eclaimlink_mock_inbox WHERE downloaded = 0 AND ${inbox} ORDER BY id`).all(fac)
        .map(r => ({ fileId: `M${r.id}`, fileName: r.file_name, sender: r.sender, receiver: r.receiver, transactionDate: r.created_at, recordCount: r.record_count }));
    },
    async download(fileId) {
      const r = db.prepare(`SELECT file_name, xml FROM eclaimlink_mock_inbox WHERE id = ? AND ${inbox.replace("?1 = ?1", "?2 = ?2")}`).get(Number(String(fileId).replace(/^M/, "")), fac);
      if (!r) throw Object.assign(new Error("File not found"), { code: 404 });
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
        ? db.prepare(`SELECT 'M' || id AS fid, id, file_name, sender, receiver, record_count, created_at, downloaded, xml FROM eclaimlink_mock_inbox WHERE ${inbox}`).all(fac)
        : db.prepare(`SELECT 'S' || id AS fid, id, file_name, sender, receiver, record_count, created_at, 1 AS downloaded, xml FROM eclaimlink_files WHERE direction = 'out' AND result_code >= 0 AND ${sent}`).all(fac);
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
        ? db.prepare(`SELECT file_name, xml FROM eclaimlink_files WHERE id = ? AND ${sent.replace("?1 = ?1", "?2 = ?2")}`).get(id, fac)
        : db.prepare(`SELECT file_name, xml FROM eclaimlink_mock_inbox WHERE id = ? AND ${inbox.replace("?1 = ?1", "?2 = ?2")}`).get(id, fac);
      if (!r) throw Object.assign(new Error("File not found"), { code: 404 });
      return { fileName: r.file_name, xml: r.xml };
    },
  };
}
