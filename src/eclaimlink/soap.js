// Minimal SOAP 1.1 client for the DHA eClaimLink / Dubai Health Post Office (DHPO) web service.
// Operation names and parameters follow the post office API (UploadTransaction, GetNewTransactions,
// DownloadTransactionFile, SetTransactionDownloaded). Confirm the endpoint and namespace against
// the WSDL eClaimLink gives your facility: run `npm run eclaimlink:wsdl` from the clinic network.

export const DEFAULT_URL = "https://dhpo.eclaimlink.ae/ValidateTransactions.asmx";
// Files older than the archiving period (24 months for claims, 6 for authorizations) live here
export const DEFAULT_ARCHIVE_URL = "https://dhpo.eclaimlink.ae/ClaimsAndAuthorizationsArchive.asmx";
// Used only when the WSDL cannot be read; the service's own WSDL is checked first (see serviceInfo)
export const DEFAULT_NS = "http://www.eClaimLink.ae/";

export const xmlEsc = s => String(s ?? "").replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
export const xmlUnesc = s => String(s ?? "").replace(/&(lt|gt|amp|apos|quot|#\d+|#x[0-9a-f]+);/gi, (m, e) =>
  ({ lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' }[e.toLowerCase()] ?? (e[1] === "x" || e[1] === "X" ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(Number(e.slice(1))))));

// Text of the first <name> element, ignoring any namespace prefix. Empty or self-closing → "".
export function tag(xml, name) {
  const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name.replace(/\./g, "\\.")}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name.replace(/\./g, "\\.")}>)`));
  return m ? (m[1] ?? "") : null;
}
export function tags(xml, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name.replace(/\./g, "\\.")}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name.replace(/\./g, "\\.")}>`, "g");
  return [...xml.matchAll(re)].map(m => m[1]);
}

export class EClaimLinkError extends Error {
  constructor(op, code, message) { super(`${op} failed (${code}): ${message || "no message from eClaimLink"}`); this.op = op; this.code = code; this.eclaimMessage = message; }
}

export function settings(env = process.env) {
  return {
    url: env.ECLAIMLINK_URL || DEFAULT_URL,
    ns: env.ECLAIMLINK_NAMESPACE || null,
    login: env.ECLAIMLINK_LOGIN || "",
    pwd: env.ECLAIMLINK_PASSWORD || "",
    timeout: Number(env.ECLAIMLINK_TIMEOUT_MS) || 60000,
    archiveUrl: env.ECLAIMLINK_ARCHIVE_URL || DEFAULT_ARCHIVE_URL,
    archiveSearchOp: env.ECLAIMLINK_ARCHIVE_SEARCH_OP || "SearchTransactions",
    archiveDownloadOp: env.ECLAIMLINK_ARCHIVE_DOWNLOAD_OP || "DownloadTransactionFile",
  };
}

// Namespace and SOAPAction of each operation, read once per endpoint from its WSDL,
// so the connector follows whatever eClaimLink publishes instead of a hard-coded value.
const wsdlCache = new Map();
export async function serviceInfo(url, { fetchImpl = fetch, ns } = {}) {
  if (ns) return { ns, actions: {} };
  if (!wsdlCache.has(url)) {
    wsdlCache.set(url, (async () => {
      try {
        const res = await fetchImpl(url + "?WSDL", { signal: AbortSignal.timeout(20000) });
        const wsdl = res.ok ? await res.text() : "";
        const target = (wsdl.match(/targetNamespace="([^"]+)"/) || [])[1];
        const actions = {};
        for (const m of wsdl.matchAll(/<wsdl:operation name="([^"]+)">\s*<soap:operation soapAction="([^"]*)"/g)) actions[m[1]] = m[2];
        if (target) return { ns: target, actions };
      } catch {}
      wsdlCache.delete(url); // try again on the next call
      return { ns: DEFAULT_NS, actions: {} };
    })());
  }
  return wsdlCache.get(url);
}

/**
 * Call one operation. Returns { result, out } where out holds the response fields as text.
 * The post office returns an int result: 0 or above is success (above 0 means success with
 * warnings, for example a file accepted with an error report), negative is failure.
 */
export async function call(op, params, outFields, { env = process.env, fetchImpl = fetch, url, allow = [] } = {}) {
  const s = settings(env);
  if (!s.login || !s.pwd) throw new EClaimLinkError(op, "config", "ECLAIMLINK_LOGIN and ECLAIMLINK_PASSWORD are not set");
  const target = url || s.url;
  const info = await serviceInfo(target, { fetchImpl, ns: s.ns });
  const action = info.actions[op] || `${info.ns}${op}`;
  const body = { login: s.login, pwd: s.pwd, ...params };
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${op} xmlns="${xmlEsc(info.ns)}">
${Object.entries(body).map(([k, v]) => v === null ? `      <${k} xsi:nil="true" />` : `      <${k}>${xmlEsc(v)}</${k}>`).join("\n")}
    </${op}>
  </soap:Body>
</soap:Envelope>`;
  const res = await fetchImpl(target, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8", soapaction: `"${action}"` },
    body: envelope, signal: AbortSignal.timeout(s.timeout),
  });
  const text = await res.text();
  const fault = tag(text, "faultstring");
  if (fault !== null) throw new EClaimLinkError(op, "fault", xmlUnesc(fault));
  if (!res.ok) throw new EClaimLinkError(op, res.status, `HTTP ${res.status}`);
  const resp = tag(text, `${op}Response`);
  if (resp === null) throw new EClaimLinkError(op, "parse", "response did not contain " + op + "Response");
  const result = Number(tag(resp, `${op}Result`));
  const out = Object.fromEntries(outFields.map(f => [f, xmlUnesc(tag(resp, f) ?? "")]));
  if (!Number.isFinite(result) || (result < 0 && !allow.includes(result))) throw new EClaimLinkError(op, result, out.errorMessage);
  return { result, out };
}
