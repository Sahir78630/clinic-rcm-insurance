import { buildRequest, parseResponse } from "./http-mapping.js";

// Calls a live eligibility API over HTTPS: a payer's provider web service or an integration
// partner that covers several UAE payers. Credentials come from environment variables, with
// per-payer overrides (PAYER_DAM_API_URL, PAYER_DAM_API_KEY, ...) for payers you connect to directly.
export const name = "http";

function settings(payerCode, env) {
  const p = payerCode ? `PAYER_${payerCode}_` : null;
  const pick = k => (p && env[p + k]) || env["ELIGIBILITY_" + k];
  return {
    url: pick("API_URL"),
    key: pick("API_KEY"),
    header: env.ELIGIBILITY_AUTH_HEADER || "Authorization",
    scheme: env.ELIGIBILITY_AUTH_SCHEME ?? "Bearer",
    timeout: Number(env.ELIGIBILITY_TIMEOUT_MS) || 15000,
  };
}

export function isConfigured(env = process.env) {
  return Boolean(env.ELIGIBILITY_API_URL) || Object.keys(env).some(k => /^PAYER_[A-Z0-9]+_API_URL$/.test(k));
}

export async function check(req, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = settings(req.payer?.code, env);
  if (!cfg.url) throw new Error(`No eligibility API URL is set${req.payer ? ` for ${req.payer.name}` : ""}. Set ELIGIBILITY_API_URL or PAYER_${req.payer?.code ?? "XXX"}_API_URL.`);
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (cfg.key) headers[cfg.header] = cfg.scheme ? `${cfg.scheme} ${cfg.key}` : cfg.key;
  const res = await fetchImpl(cfg.url, {
    method: "POST", headers, body: JSON.stringify(buildRequest(req)), signal: AbortSignal.timeout(cfg.timeout),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Eligibility API returned ${res.status} with a non-JSON body`); }
  if (res.status === 404) return { status: "Not found", message: body.message || "The payer has no member with these details." };
  if (!res.ok) throw new Error(body.message || `Eligibility API returned ${res.status}`);
  return parseResponse(body);
}
