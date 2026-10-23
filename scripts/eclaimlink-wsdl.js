// Fetches the eClaimLink WSDL and prints its namespace and operations, so the connector's
// ECLAIMLINK_URL and ECLAIMLINK_NAMESPACE can be confirmed from the clinic's own network.
import { settings } from "../src/eclaimlink/soap.js";

const { url, ns } = settings();
const res = await fetch(url + "?WSDL").catch(e => { console.error(`Could not reach ${url}: ${e.message}`); process.exit(1); });
const wsdl = await res.text();
const target = (wsdl.match(/targetNamespace="([^"]+)"/) || [])[1];
const ops = [...new Set([...wsdl.matchAll(/<wsdl:operation name="([^"]+)"/g)].map(m => m[1]))];
console.log(`Endpoint:          ${url} (HTTP ${res.status})`);
console.log(`WSDL namespace:    ${target || "not found"}`);
console.log(`Configured:        ${ns}${target && target !== ns ? "   <-- set ECLAIMLINK_NAMESPACE to the WSDL value" : ""}`);
console.log(`Operations:        ${ops.join(", ") || "none found"}`);
// input parameter names, which SOAP matches case-sensitively (for example fileID vs fileId)
for (const op of ["UploadTransaction", "GetNewTransactions", "GetNewPriorAuthorizationTransactions", "DownloadTransactionFile", "SetTransactionDownloaded"]) {
  if (ops.length && !ops.includes(op)) { console.log(`Missing operation: ${op}`); continue; }
  const m = wsdl.match(new RegExp(`<[\\w:]*element name="${op}">([\\s\\S]*?)</[\\w:]*element>\\s*<[\\w:]*element name="${op}Response"`));
  if (!m) continue;
  const params = [...m[1].matchAll(/name="([^"]+)"/g)].map(x => x[1]);
  console.log(`  ${op}(${params.join(", ")})`);
  const fp = params.find(p => p.toLowerCase() === "fileid"), want = process.env.ECLAIMLINK_FILE_ID_PARAM || "fileID";
  if (fp && fp !== want) console.log(`  <-- set ECLAIMLINK_FILE_ID_PARAM=${fp}`);
}
const elig = ops.filter(o => /elig|member|coverage/i.test(o));
console.log(`Eligibility-type operations: ${elig.length ? elig.join(", ") : "none"}`);
