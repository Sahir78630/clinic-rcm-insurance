# Clinic RCM: Insurance

Insurance revenue cycle console for a Dubai polyclinic, plus a small server that runs eligibility checks for every patient on the day's appointment list.

The website covers eligibility and access, prior approvals, claims, remittance and reconciliation, denials, resubmissions and insurance receivables aging by payer, in AED. The system starts empty: there is no sample data. When it is opened from this server, the **Eligibility & access** page uses the server for real checks, and claims, resubmissions, prior requests and remittances move through DHA eClaimLink. Claims, payments and denials are kept in the browser of the billing workstation in this version; appointments, eligibility checks and every eClaimLink file are kept in the server database.

## Getting your records in

1. **Facility details** (sidebar): facility name and DHA licence.
2. **Claims**: on the Claims page choose **Import claims** and choose eClaimLink XML files (`Claim.Submission`, several at once; tick "not sent yet" to import them as drafts for checking) or paste a CSV from your clinic system with the columns `claim_id,patient_name,emirates_id,payer,card_no,encounter_date,department,doctor,icd10,cpt,description,quantity,gross,patient_share,prior_auth,status,submitted_date` (one row per service line). Or open **eClaimLink files**, search the claim files you have sent, and choose **Add all to my records**.
   Every claim goes through the **claim check** in the browser: missing card or Emirates ID, coverage dates, invalid ICD-10 or activity codes, amounts, duplicates, missing or expired prior approval, and late submission (`SUBMIT_LIMIT_DAYS`, 90 by default). Drafts with errors are held back from **Submit checked claims**; **Check all claims** lists every problem and copies it as CSV. Importing a draft again replaces it, so fixes made in the clinic system come through.
3. **Payments**: on **eClaimLink files**, search received remittance files and add them, or use **Download from eClaimLink** for new ones. Each file is posted once, whichever way it arrives.
4. **Today's patients**: import the appointment list on **Eligibility & access**.

## Run it

Requires Node.js 22.5 or newer. There are no npm dependencies.

```bash
cp .env.example .env        # then edit the values
set -a; . ./.env; set +a
npm start                   # http://127.0.0.1:3000
npm test
```

## Daily workflow

1. Export the day's appointments from your clinic system (HIS) as CSV with these columns:

   `time,patient_name,emirates_id,payer,card_no,plan,valid_until,department,doctor`

   `payer` can be a name (`Daman`) or a code (`DAM`), as listed in `config/payers.json`. Dates can be `2026-12-31` or `31/12/2026`. Emirates IDs can be written with or without dashes.
2. On **Eligibility & access**, choose **Import appointment list**. Every row is imported and checked. Rows with no ID, an invalid Emirates ID or an unknown payer are skipped and reported.
3. For walk-ins, enter an Emirates ID or card number. Leave the payer on "Any" to search every payer the source covers.

Each check is stored in the `eligibility_checks` table with the full result for audit.

## Eligibility sources

| Provider | What it checks | When to use |
|---|---|---|
| `mock` | The clinic's own member records, built from the plan and valid-until columns of imports | Testing, training, or payers with no live connection yet |
| `http` | A live API: a payer's provider web service, or an integration partner that covers several UAE payers | Production |

The default is `http` when `ELIGIBILITY_API_URL` (or any `PAYER_<CODE>_API_URL`) is set, otherwise `mock`. A single payer can be pinned to a provider through its `provider` field in `config/payers.json`.

### Connecting a live eligibility source

Payers only answer eligibility requests from contracted providers, so you need API access from each payer, or from an integration partner, under your facility's contract. Once you have the endpoint, credentials and documentation:

1. Set `ELIGIBILITY_API_URL` and `ELIGIBILITY_API_KEY`. For payers you connect to directly, use `PAYER_DAM_API_URL` / `PAYER_DAM_API_KEY` and so on.
2. If the API's request or response format differs from the contract below, edit the two functions in `src/providers/http-mapping.js`. Nothing else needs to change.
3. Run a few known members through the walk-in check and compare the results with the payer portal.

The default contract is a JSON `POST`:

```json
{ "facilityLicense": "DHA-F-0000000", "emiratesId": "784-1990-1234567-1", "memberCardNo": "DM-123", "payerCode": "DAM",
  "serviceDate": "2026-10-22", "serviceCategory": "Dental", "encounterType": "outpatient" }
```

The expected response:

```json
{ "status": "active", "payerCode": "DAM", "transactionId": "T-1",
  "member": { "name": "…", "emiratesId": "…", "cardNo": "…" },
  "coverage": { "plan": "Gold", "network": "GN+", "validFrom": "2026-01-01", "validTo": "2026-12-31",
                "copayPercent": 10, "deductible": 20, "priorApprovalRequired": false } }
```

`status` values `active`, `inactive`/`expired`, `not_eligible` and `not_found` are recognised. HTTP 404 is treated as not found. Timeouts and other errors show as **Check failed** so reception can confirm on the payer portal instead.

Departments listed in `approvalDepartments` (in `config/payers.json`) turn an eligible result into **Approval needed**.

## DHA eClaimLink

The server connects to the eClaimLink (Dubai Health Post Office) web service with your facility's eClaimLink login:

| From the website | What is sent or received |
|---|---|
| Claims: **Submit to eClaimLink** (one claim or all drafts) | `Claim.Submission`, one file per payer |
| Claim dialog: **Resubmit claim** | `Claim.Submission` with a `<Resubmission>` block (correction or internal complaint) |
| Prior approvals: **New request** | `Prior.Request` |
| Remittance or Prior approvals: **Download from eClaimLink** | New `Remittance.Advice` files post payments and denial codes to claims. `Prior.Authorization` replies update approval requests. |

**Signing in with your own eClaimLink login.** Each member of staff can sign in on the **eClaimLink files** page with their own eClaimLink (DHPO) username and password. The server checks the login with eClaimLink, then uses it for everything that browser does on eClaimLink: searching and opening files, reports, submitting claims and resubmissions, and downloading remittances. The password stays in the server's memory only (never on disk, never sent back to the browser) and is forgotten on sign-out, after 2 hours without use, after 12 hours, or when the server restarts. After five wrong passwords from one computer, sign-in pauses for 15 minutes so eClaimLink does not lock the account. With no one signed in, the server uses `ECLAIMLINK_LOGIN` and `ECLAIMLINK_PASSWORD` if they are set, otherwise test mode. Serve the app over HTTPS before staff sign in from other computers.

**eClaimLink files page.** Search everything sent or received on eClaimLink by type (claim submissions, remittance advice, prior requests, prior authorizations), download status, date range (up to 100 days) and file name, including the archive (up to one month per search). Open any file to see its claims, payments, denial codes or approval decisions and the raw XML, add it to your records, or build a report across the results: remittances by payer with denial rate, denial codes by value, and claims submitted by payer. Opening a file there does not mark it as downloaded on eClaimLink.

Every file sent or received is kept in the `eclaimlink_files` table with its result code, transaction ID and any error report. Downloaded files are only marked as downloaded on eClaimLink after they are safely stored.

**Modes.** `ECLAIMLINK_MODE=mock` (the default without credentials) simulates eClaimLink inside the local database. Each uploaded claim comes back as a remittance on the next download (about one in five has an activity denied with MNEC-004), and each prior request comes back approved. Use it to train staff. Set `ECLAIMLINK_LOGIN` and `ECLAIMLINK_PASSWORD` to switch to `live` for everyone, or let each person sign in with their own login.

**Going live checklist**

1. Get the facility's web service login from eClaimLink, and test on their QA environment first if they provide one (`ECLAIMLINK_URL`).
2. From a computer on the clinic network, run `npm run eclaimlink:wsdl`. It prints the service namespace and operations. If the namespace differs from `ECLAIMLINK_NAMESPACE`, set it to the printed value.
3. Fill in `FACILITY_LICENSE` and each payer's `eclaimlinkId` in `config/payers.json`. They replace the placeholder facility ID and short payer codes in outgoing files.
4. Send one claim and check it on the eClaimLink portal before sending batches.

The connector follows the DHPO Web Service Specification v4.0 (March 2026): `UploadTransaction`, `GetNewTransactions`, `GetNewPriorAuthorizationTransactions` (DHA's recommended way to collect prior authorization replies), `DownloadTransactionFile` and `SetTransactionDownloaded`, with the shared result codes (1 = accepted with warnings, 2 = nothing new, negative = error). The specification has no eligibility operation, so eligibility still goes through the providers above. Files older than the archiving period (24 months for claims, 6 for authorizations) move to DHA's separate archive service, which this connector does not call.

The claims, remittance and denial pages keep their records in the browser in this version, so use one workstation for eClaimLink billing until claims are moved into the server database. If the archive service on your account uses different operation names, set `ECLAIMLINK_ARCHIVE_SEARCH_OP` and `ECLAIMLINK_ARCHIVE_DOWNLOAD_OP`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Server status and active provider |
| GET | `/api/config` | Payers, approval departments, CSV columns |
| POST | `/api/eligibility` | `{ emiratesId?, cardNo?, payer?, department? }` → one check |
| GET | `/api/appointments?date=YYYY-MM-DD` | Appointments with their latest result |
| POST | `/api/appointments/import` | `{ csv, date?, replace?, verify? }` → import and check all |
| POST | `/api/appointments/verify-all?date=&all=1` | Check unverified (or all) appointments |
| POST | `/api/appointments/:id/verify` | Re-check one appointment |
| POST | `/api/members` | Add or update a member record (mock provider) |
| GET | `/api/checks?limit=` | Verification log |
| GET | `/api/eclaimlink/status` | Mode, endpoint, last download, who is signed in |
| POST | `/api/eclaimlink/login` | `{ login, pwd }` → check with eClaimLink and start a session (cookie) |
| POST | `/api/eclaimlink/logout` | End the eClaimLink session |
| POST | `/api/eclaimlink/upload` | `{ xml, fileName? }` → upload a Claim.Submission or Prior.Request |
| POST | `/api/eclaimlink/sync` | Download and store all new files |
| GET | `/api/eclaimlink/files?direction=&type=&unapplied=1` | File log (with XML when `unapplied=1`) |
| GET | `/api/eclaimlink/files/:id` | One file with its XML and error report |
| POST | `/api/eclaimlink/files/:id/applied` | Mark a downloaded file as posted |
| GET | `/api/eclaimlink/search?direction=received\|sent&type=all\|Claim.Submission\|…&status=all\|new\|downloaded&from=&to=&name=&archive=1` | Search eClaimLink (SearchTransactions) |
| GET | `/api/eclaimlink/remote/:fileId?archive=1` | Open one eClaimLink file with a summary, without marking it downloaded |
| POST | `/api/eclaimlink/report` | `{ files: [{ fileId, archive }] }` → combined report |

## Before going live

- Set `APP_USERNAME` and `APP_PASSWORD`, and serve the app only over HTTPS (for example behind a reverse proxy).
- The database holds patient identifiers and insurance details. Host it where your facility's data-protection and UAE health-data rules allow, restrict access, and back it up.
- Keep API keys and the eClaimLink password in environment variables or a secrets manager, never in the repository.
