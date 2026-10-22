import * as mock from "./providers/mock.js";
import * as http from "./providers/http.js";
import { findPayer, formatEid, today } from "./util.js";

const PROVIDERS = { mock, http };

export function defaultProvider(env = process.env) {
  return env.ELIGIBILITY_PROVIDER || (http.isConfigured(env) ? "http" : "mock");
}

function providerFor(payer, env) {
  const n = payer && payer.provider && payer.provider !== "default" ? payer.provider : defaultProvider(env);
  const p = PROVIDERS[n];
  if (!p) throw new Error(`Unknown eligibility provider "${n}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.`);
  return p;
}

/**
 * Run one eligibility check and record it.
 * input: { emiratesId, cardNo, payer, department, source, appointmentId }
 */
export async function checkEligibility(ctx, input) {
  const { db, cfg, env = process.env, fetchImpl } = ctx;
  const payer = input.payer ? findPayer(cfg.payers, input.payer) : null;
  const req = {
    emiratesId: formatEid(input.emiratesId) || (input.emiratesId || "").trim() || null,
    cardNo: (input.cardNo || "").trim() || null,
    payer, department: input.department || null, serviceDate: today(),
    facilityLicense: env.FACILITY_LICENSE || "",
  };
  let provider = mock, result;
  if (!req.emiratesId && !req.cardNo) {
    result = { status: "Not found", message: "Enter an Emirates ID or an insurance card number." };
  } else if (input.payer && !payer) {
    result = { status: "Not found", message: `"${input.payer}" is not a payer in config/payers.json.` };
  } else {
    try {
      provider = providerFor(payer, env);
      result = await provider.check(req, { db, env, fetchImpl });
    } catch (e) {
      result = { status: "Check failed", message: `Could not reach the eligibility source: ${e.message}. Check again, or confirm cover on the payer portal.` };
    }
  }
  if (payer && result.payer && findPayer(cfg.payers, result.payer)?.code !== payer.code && result.status === "Eligible") {
    const other = findPayer(cfg.payers, result.payer);
    result = { ...result, status: "Not eligible", message: `Member is covered by ${other ? other.name : result.payer}, not ${payer.name}. Check again with the correct payer.` };
  }
  if (result.status === "Eligible" && (result.approvalRequired || cfg.approvalDepartments.includes(req.department))) {
    result = { ...result, status: "Approval needed", message: `Coverage is active. ${req.department || "This service"} needs prior approval from the payer before treatment.` };
  }
  const resolvedPayer = findPayer(cfg.payers, result.payer) || payer;
  const out = {
    ...result,
    payer: resolvedPayer ? resolvedPayer.code : result.payer || null,
    payerName: resolvedPayer ? resolvedPayer.name : result.payer || null,
    emiratesId: formatEid(result.emiratesId) || result.emiratesId || req.emiratesId,
    cardNo: result.cardNo || req.cardNo,
    department: req.department,
    provider: provider.name,
    checkedAt: new Date().toISOString(),
  };
  const info = db.prepare(`INSERT INTO eligibility_checks (source, appointment_id, provider, payer, emirates_id, card_no, department, status, result_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(input.source || "api", input.appointmentId ?? null, out.provider, out.payer, out.emiratesId, out.cardNo, out.department, out.status, JSON.stringify(out));
  out.checkId = Number(info.lastInsertRowid);
  return out;
}
