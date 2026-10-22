// Translates between this app and the eligibility API you connect to.
//
// The defaults below follow the simple JSON contract described in README.md
// ("Connecting a live eligibility source"). If your payer or integration partner uses a
// different format, change these two functions to match their documentation. Nothing
// else in the app needs to change.

/**
 * Build the request body sent to the eligibility API.
 * @param {object} req  { emiratesId, cardNo, payer: {code,name}|null, department, serviceDate, facilityLicense }
 */
export function buildRequest(req) {
  return {
    facilityLicense: req.facilityLicense,
    emiratesId: req.emiratesId || undefined,
    memberCardNo: req.cardNo || undefined,
    payerCode: req.payer ? req.payer.code : undefined,
    serviceDate: req.serviceDate,
    serviceCategory: req.department || undefined,
    encounterType: "outpatient",
  };
}

const STATUS = {
  active: "Eligible", eligible: "Eligible",
  inactive: "Inactive", expired: "Inactive", terminated: "Inactive",
  not_eligible: "Not eligible", ineligible: "Not eligible",
  not_found: "Not found", no_member: "Not found",
};

/**
 * Turn the API's JSON response into the app's result shape.
 * Return { status, message, payer, name, emiratesId, cardNo, plan, network, validFrom, validTo,
 *          copayPct, deductible, approvalRequired, reference }.
 * status must be one of: Eligible, Inactive, Not eligible, Not found.
 */
export function parseResponse(body) {
  const s = String(body.status ?? body.eligibilityStatus ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const m = body.member ?? {};
  const c = body.coverage ?? {};
  return {
    status: STATUS[s] ?? "Not eligible",
    message: body.message ?? body.remarks ?? "",
    payer: body.payerCode ?? c.payerCode,
    name: m.name ?? m.fullName,
    emiratesId: m.emiratesId,
    cardNo: m.cardNo ?? m.memberCardNo,
    plan: c.plan ?? c.planName,
    network: c.network ?? c.networkName,
    validFrom: c.validFrom ?? c.startDate,
    validTo: c.validTo ?? c.endDate,
    copayPct: c.copayPercent ?? c.copay,
    deductible: c.deductible,
    approvalRequired: Boolean(c.priorApprovalRequired ?? body.priorApprovalRequired),
    reference: body.transactionId ?? body.reference ?? null,
  };
}
