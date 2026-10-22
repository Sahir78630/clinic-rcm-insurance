import { findMember } from "../db.js";
import { today } from "../util.js";

// Checks against the clinic's own member records (built from appointment imports).
// Use it for training and testing, or for payers you have no live connection to yet.
export const name = "mock";

export async function check(req, { db }) {
  const m = findMember(db, req);
  if (!m) {
    return {
      status: "Not found",
      message: "This Emirates ID or card number is not in the clinic's member records. Include the patient's insurance details in the appointment import, or connect a live payer provider.",
    };
  }
  const base = {
    payer: m.payer, name: m.name, emiratesId: m.emirates_id, cardNo: m.card_no, plan: m.plan, network: m.network,
    validFrom: m.valid_from, validTo: m.valid_to, copayPct: m.copay_pct, deductible: m.deductible, reference: `MEMBER-${m.id}`,
  };
  if (m.valid_to && m.valid_to < today()) {
    return { ...base, status: "Inactive", message: `Policy expired on ${m.valid_to}. Ask for a renewed card or treat the visit as self-pay.` };
  }
  return { ...base, status: "Eligible", message: "Coverage is active according to the clinic's member records." };
}
