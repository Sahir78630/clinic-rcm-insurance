import { tag, tags, xmlUnesc } from "./soap.js";

const num = v => Number(String(v ?? "").replace(/,/g, "")) || 0;
const r2 = n => Math.round(n * 100) / 100;
const txt = (xml, name) => xmlUnesc(tag(xml, name) ?? "").trim();
export const rootOf = xml => (String(xml).match(/<([A-Za-z][\w.]*)[\s>]/) || [])[1] || null;

// Reads an eClaimLink transaction file into header facts, one row per claim or authorization, and totals.
export function summarize(xml) {
  const type = rootOf(xml);
  const h = tag(xml, "Header") || "";
  const header = { sender: txt(h, "SenderID"), receiver: txt(h, "ReceiverID"), date: txt(h, "TransactionDate"),
    recordCount: num(txt(h, "RecordCount")) || null, disposition: txt(h, "DispositionFlag") };
  let rows = [], totals = {};
  if (type === "Claim.Submission") {
    rows = tags(xml, "Claim").map(c => {
      const resub = tag(c, "Resubmission"), acts = tags(c, "Activity");
      const own = c.replace(/<Activity\b[\s\S]*?<\/Activity>/g, ""); // claim-level fields only, not each activity's
      const actNet = r2(acts.reduce((s, a) => s + num(txt(a, "Net")), 0));
      const enc = tag(own, "Encounter") || "";
      return { id: txt(own, "ID"), payer: txt(own, "PayerID"), member: txt(own, "MemberID"), visit: txt(enc, "Start") || txt(acts[0] || "", "Start"), clinicians: [...new Set(acts.map(a => txt(a, "Clinician")).filter(Boolean))], gross: num(txt(own, "Gross")) || actNet,
        patientShare: num(txt(own, "PatientShare")), net: tag(own, "Net") !== null ? num(txt(own, "Net")) : actNet,
        activities: acts.length, resubmission: resub === null ? null : txt(resub, "Type") || "yes", resubComment: resub === null ? null : txt(resub, "Comment") || null };
    });
    totals = { claims: rows.length, gross: r2(rows.reduce((s, r) => s + r.gross, 0)), net: r2(rows.reduce((s, r) => s + r.net, 0)),
      resubmissions: rows.filter(r => r.resubmission).length };
  } else if (type === "Remittance.Advice") {
    rows = tags(xml, "Claim").map(c => {
      const acts = tags(c, "Activity"), own = c.replace(/<Activity\b[\s\S]*?<\/Activity>/g, "");
      const net = acts.reduce((s, a) => s + num(txt(a, "Net")), 0), paid = acts.reduce((s, a) => s + num(txt(a, "PaymentAmount")), 0);
      // Visit date: the encounter start if the payer sent it, otherwise the first activity's start
      return { id: txt(own, "ID"), payerRef: txt(own, "IDPayer"), paymentRef: txt(own, "PaymentReference"), settlement: txt(own, "DateSettlement"),
        visit: txt(tag(own, "Encounter") || "", "Start") || txt(acts[0] || "", "Start"), clinicians: [...new Set(acts.map(a => txt(a, "Clinician")).filter(Boolean))],
        net: r2(net), paid: r2(paid), denied: r2(Math.max(0, net - paid)), denialCodes: [...new Set(acts.map(a => txt(a, "DenialCode")).filter(Boolean))] };
    });
    const codes = {};
    tags(xml, "Activity").forEach(a => { const k = txt(a, "DenialCode"); if (k) codes[k] = r2((codes[k] || 0) + Math.max(0, num(txt(a, "Net")) - num(txt(a, "PaymentAmount")))); });
    totals = { claims: rows.length, net: r2(rows.reduce((s, r) => s + r.net, 0)), paid: r2(rows.reduce((s, r) => s + r.paid, 0)),
      denied: r2(rows.reduce((s, r) => s + r.denied, 0)), deniedClaims: rows.filter(r => r.denied > 0).length, denialCodes: codes,
      paymentRefs: [...new Set(rows.map(r => r.paymentRef).filter(Boolean))] };
  } else if (type === "Prior.Request") {
    const own = a => a.replace(/<Activity\b[\s\S]*?<\/Activity>/g, "");
    rows = tags(xml, "Authorization").map(a => ({ id: txt(own(a), "ID"), payer: txt(a, "PayerID"), member: txt(a, "MemberID"),
      net: r2(tags(a, "Activity").reduce((s, x) => s + num(txt(x, "Net")), 0)), activities: tags(a, "Activity").length }));
    totals = { requests: rows.length, net: r2(rows.reduce((s, r) => s + r.net, 0)) };
  } else if (type === "Prior.Authorization") {
    const own = a => a.replace(/<Activity\b[\s\S]*?<\/Activity>/g, "");
    rows = tags(xml, "Authorization").map(a => ({ id: txt(own(a), "ID"), result: txt(a, "Result"), payerRef: txt(a, "IDPayer"), denialCode: txt(a, "DenialCode"),
      comments: txt(a, "Comments"), start: txt(a, "Start"), end: txt(a, "End"),
      approved: r2(tags(a, "Activity").reduce((s, x) => s + num(txt(x, "PaymentAmount")), 0)) }));
    totals = { authorizations: rows.length, approved: rows.filter(r => /^y/i.test(r.result)).length, rejected: rows.filter(r => !/^y/i.test(r.result)).length,
      approvedAmount: r2(rows.reduce((s, r) => s + r.approved, 0)) };
  }
  return { type, header, rows, totals };
}

// Combines file summaries into one report: totals per type, remittances by payer, denial codes.
export function buildReport(summaries) {
  const byType = {}, byPayer = {}, codes = {}, submittedTo = {};
  let pa = { approved: 0, rejected: 0, approvedAmount: 0 };
  for (const s of summaries) {
    const t = byType[s.type || "Unknown"] ||= { files: 0, records: 0 };
    t.files++; t.records += s.rows.length;
    if (s.type === "Remittance.Advice") {
      const p = byPayer[s.header.sender || "Unknown"] ||= { files: 0, claims: 0, net: 0, paid: 0, denied: 0 };
      p.files++; p.claims += s.totals.claims; p.net = r2(p.net + s.totals.net); p.paid = r2(p.paid + s.totals.paid); p.denied = r2(p.denied + s.totals.denied);
      for (const [k, v] of Object.entries(s.totals.denialCodes)) { const c = codes[k] ||= { amount: 0, count: 0 }; c.amount = r2(c.amount + v); c.count++; }
    }
    if (s.type === "Claim.Submission") {
      const p = submittedTo[s.header.receiver || "Unknown"] ||= { files: 0, claims: 0, net: 0, resubmissions: 0 };
      p.files++; p.claims += s.totals.claims; p.net = r2(p.net + s.totals.net); p.resubmissions += s.totals.resubmissions;
    }
    if (s.type === "Prior.Authorization") {
      pa = { approved: pa.approved + s.totals.approved, rejected: pa.rejected + s.totals.rejected, approvedAmount: r2(pa.approvedAmount + s.totals.approvedAmount) };
    }
  }
  return { files: summaries.length, byType, remittanceByPayer: byPayer, denialCodes: codes, submissionsByPayer: submittedTo, priorAuthorizations: pa };
}
