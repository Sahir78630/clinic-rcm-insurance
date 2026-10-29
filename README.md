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

On Windows, install Node.js (LTS) and double-click `start-windows.bat`. The website opens at http://127.0.0.1:3000; keep the black window open while you use it.

From a terminal:

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

**Dates** are shown as dd/mm/yy everywhere, including the CSV downloads. Imports accept dd/mm/yy, dd/mm/yyyy and yyyy-mm-dd. Date boxes show and take dd/mm/yy whatever the computer's date setting. Clicking a date box (or its calendar button) opens a calendar with month and year arrows, Today and Clear.

**Uploading files.** Every upload (claims, appointment lists, price lists, payer and doctor names) takes CSV, Excel (.xlsx, .xls) or PDF; claims also take eClaimLink XML. Excel and PDF are turned into rows with the same column headings as the CSV. PDF works for table exports with selectable text (each line becomes a row, wide gaps become columns); scanned PDFs have no text to read. The Excel and PDF readers (SheetJS and pdf.js) load from cdnjs the first time they are needed, so that computer needs internet access. Remittance advice is imported as eClaimLink XML.

**Submitting and resubmitting.** Draft claims that pass the claim check are sent with **Submit N checked claims** on the Claims page (one file per payer) or **Submit to eClaimLink** in a claim. A rejected or partly paid claim has a **Resubmit claim** form: choose the type (correction, internal complaint, …), write the comment and send. Claims imported from an XML file are sent exactly as they came, with the lab results you entered, a new transaction date and, for a resubmission, a `<Resubmission>` block with the type and comment; other claims are built from the record.

**Correcting a claim.** Open a draft claim with errors in the claim check (or a rejected or partly paid claim) and choose **Correct claim**. You can change the member card number, payer code, encounter date, clinician licence, prior approval number, diagnosis codes (the first is principal), and each activity's code, quantity, gross and patient share; you can also add or remove activities. On save the claim check runs again, the change is written in the claim history, and the claim file (download, submit or resubmit) carries the corrected values while the rest of the original XML stays as it was.

**Lab results and claim XML.** Open a claim and choose **Enter lab results** to type the results from the lab report. Common tests (lipid profile, cholesterol, triglycerides, HDL, LDL, blood sugar, HbA1c, liver function profile and its parts) come with their result fields and LOINC codes ready; any activity can take extra results. Each result becomes an `<Observation>` on its activity, and the claim check's *Report missing* goes away. **Download claim XML** in the claim, or **Download XML** on the Claims page for all the claims shown, gives the eClaimLink file to upload. Claims imported from an XML file as *not sent yet* are written back exactly as they came, with only the observations changed (one file per original file); other claims are built from the record.

**Price list.** Under **Price list → Payer price lists**, upload each payer's contracted prices as CSV or Excel (columns: code, description, price; the headings are found automatically) with the payer code (for example INS008) and an optional discount %. Use `*` as the payer code for the facility price list used when a payer has no list of its own. The claim check then compares every activity with its payer's list: billed above the contract price is an error (likely price rejection, blocks batch submit), billed below or a code not on the list is a warning. The page also has a price look-up across all payers and a list of claims with price problems. Price lists are kept in that browser.

**Sharing with staff computers.** On the computer that runs the website, double-click `start-for-staff.bat` instead of `start-windows.bat`. The first time, it asks for a username and password that staff will type to open the website (saved in `staff-login.env`, which is not uploaded to GitHub; delete it to change them). It then listens on the clinic network and prints the address to open on staff computers, for example `http://192.168.1.20:3000`. Allow Node.js on *Private networks* if Windows asks. If staff computers show "site can't be reached", double-click `open-firewall.bat` once on that computer (it asks for administrator permission and opens port 3000 in Windows Firewall), and use the `192.168.x.x` address, not a VPN address such as `26.x.x.x`. Keep that computer on and the window open while staff work. To use a clinic computer that stays on all day, unzip the folder there and double-click `setup-clinic-computer.bat` once: it asks for the staff login if there is none yet, makes the website start by itself whenever someone signs in to Windows on that computer (a shortcut in the Startup folder), stops the computer sleeping while plugged in, opens the firewall, and prints the address `http://COMPUTERNAME:3000`, which keeps working if the 192.168 numbers change. `remove-autostart.bat` undoes the automatic start. The computer must be signed in to Windows for the website to run; after a restart (for example a Windows update) sign in again, or set Windows to sign in automatically. Each staff member signs in to eClaimLink with their own login on the eClaimLink files page. Claims imported in a browser, price lists and names are kept in that browser, so each computer imports its own; reports from eClaimLink are the same everywhere. The connection inside the clinic is not encrypted; use it only on the clinic's own network, and set up HTTPS (see the hosting guide) before using it over the internet.

**Overview.** The top panel, *Claims in the period*, shows claims sent in a chosen period (last 30 or 90 days, this or last month, this year, or chosen dates) with what was paid, denied, resubmitted and is still unprocessed, from eClaimLink after **Load from eClaimLink** (or from the claims in the browser without the server). The rest of the Overview covers the work in this browser: imported claims, remittances and approvals.

**Reports.** The Reports section has six pages built from eClaimLink files for any date range (searched in 90-day steps): **Remittance summary** (paid, claimed and denied by payer and by payment reference), **Rejections** (every claim with a denied amount and its codes), **Rejection reasons** (denial codes by amount and claims, with the payers using them), **Submissions** (claims and net amount sent, by payer and month, with resubmissions), **Reconciliation** and **Unprocessed claims**. Each downloads as CSV. Without the server they use the records in the browser.

- **Report by visit date.** Every report can use the file date (submission or remittance date) or the visit date (the encounter start, or the first activity's start). A visit-date report also searches claim files sent up to 120 days, and remittances received up to 180 days, after the end date, so late claims and payments for those visits are included.
- **Reconciliation** takes each claim first sent (or visited) in the period and matches it with every resubmission and remittance for it, up to 180 days after the end date. Each claim is *Paid in full*, *Partially paid*, *Rejected* (denied and not resubmitted), *Resubmitted, awaiting payment* (resubmitted after its last remittance, or resubmitted with no remittance yet, shown with the resubmission type and comment) or *Unprocessed* (no remittance at all). It shows the amounts in each status, a table by payer with the collection rate, and the claim list filtered by status.
- **Gross.** In every report and in eClaimLink file details, gross is the claim amount (net) plus the co-pay (patient share). The `<Gross>` written in the claim file is not used for reports, because some clinic systems fill it with other figures. Claim files you send are not changed.
- **Resubmitted claims count once.** A claim that is resubmitted (for example AED 1,000 claimed, AED 600 paid, AED 400 resubmitted) is never counted as AED 1,400. The submission report counts each claim once at its original amount and shows resubmissions and the resubmitted amount in their own columns. The remittance summary, rejections and rejection reasons combine all remittances for a claim in the period: claimed is the original amount, paid adds up every payment, and denied is what is still unpaid. Reconciliation, unprocessed claims, resubmission due dates and revenue by CPT already worked this way.
- **Payer code and name.** Report tables and downloads show the payer code used on eClaimLink (for example INS008) and the payer name. Add or import names with **Payer names** on any report page (one per line: code, name, or a CSV of the eClaimLink payer list). Names are kept in that browser; payers set up on the server with an `eclaimlinkId` are named automatically.
- **Summary and PDF.** Every report opens with a short written summary of its main figures. The summary is also at the top of the CSV download. **Download PDF** opens the print dialog with the report laid out on landscape A4; choose *Save as PDF*.
- **TPA and payer.** Every report can be limited to a TPA (the receiver of the claim file, or the sender of the remittance) and then to a payer under it (the claim's PayerID). Remittance files only name the TPA, so their payer is taken from the claim's submission: load Submissions or Reconciliation for the same dates first. The CSV downloads have a TPA column.
- **Doctor.** Every report can be limited to one doctor (the clinician licence on the claim's activities) and ends with a table by doctor. Add names with **Doctor names** (one per line: licence, name, or a CSV).
- **Names everywhere.** Saved payer and doctor names are used on every page, not only reports: the Claims, Denials and Resubmissions lists, claim checks, the claim details, appointments and eClaimLink files. Claim lists have a Payer / TPA column and a Doctor column; the reconciliation and rejection tables have TPA and Doctor columns.
- **Revenue by CPT** (Reports). Every activity code billed in the period (CPT, HCPCS, drug, dental and others) with claims, quantity, billed net, co-pay (the claim's patient share split across its activities), paid, denied, still awaiting a remittance, collection rate and average paid per unit, then the same figures by month. Report by submission date or visit date, use **Whole month** to pick a calendar month, and search or click a code to see only that code by month. Each code has a short name of up to two words beside it (built in for common codes such as 99213 "Est L3" or 85025 "CBC diff", otherwise the first words of its price-list description); change or add names with **Code names**. Descriptions come from your uploaded price lists. Paid amounts come from the remittances for each claim, matched by code and capped at the amount billed.
- **Resubmission due dates** (under Billing, and from the Resubmissions page). Choose **Report by** submission date, visit date or remittance (rejection) date, so you can check that nothing in a period was missed, then load from eClaimLink; every rejected or partly paid claim shows the submission date, the remittance date that rejected it, the last date to resubmit it (remittance date plus the time limit), days left, and, for resubmitted claims, the 1st and last resubmission dates and whether it was on time. The 1st and 2nd rejection dates and the number of times rejected are shown too. The reconciliation and unprocessed reports also show the 1st resubmission date and the rejection dates. "Resubmissions done up to" is the latest date for which every rejection received on or before it has been resubmitted, overall and per payer. Set the time limit (60 days unless you change it) to match your payer contracts, with **Payer exceptions** for payers that allow a different number of days. Filters, CSV and PDF work as on the other reports.
- **Co-payment.** The patient share (co-pay) is shown on the Claims list, in the reconciliation, unprocessed, rejection and submission reports (per claim, by payer, by month, in the summary) and in their downloads, and in eClaimLink file details. It comes from `PatientShare` in the claim file; when a remittance leaves it out, the amount from the claim is used.
- **Unprocessed claims** lists the unprocessed and resubmitted-awaiting claims with the days since they were last sent, grouped 0–30, 31–60, 61–90 and over 90 days, by payer.

**Signing in with your own eClaimLink login.** Each member of staff can sign in on the **eClaimLink files** page with their own eClaimLink (DHPO) username and password. The server checks the login with eClaimLink, then uses it for everything that browser does on eClaimLink: searching and opening files, reports, submitting claims and resubmissions, and downloading remittances. The password stays in the server's memory only (never on disk, never sent back to the browser) and is forgotten on sign-out, after 2 hours without use, after 12 hours, or when the server restarts. After five wrong passwords from one computer, sign-in pauses for 15 minutes so eClaimLink does not lock the account. With no one signed in, the server uses `ECLAIMLINK_LOGIN` and `ECLAIMLINK_PASSWORD` if they are set, otherwise test mode. Serve the app over HTTPS before staff sign in from other computers.

**eClaimLink files page.** Search everything sent or received on eClaimLink by type (claim submissions, remittance advice, prior requests, prior authorizations), download status, date range (up to 100 days) and file name, including the archive (up to one month per search). Open any file to see its claims, payments, denial codes or approval decisions and the raw XML, add it to your records, or build a report across the results: remittances by payer with denial rate, denial codes by value, and claims submitted by payer. Opening a file there does not mark it as downloaded on eClaimLink.

Every file sent or received is kept in the `eclaimlink_files` table with its result code, transaction ID and any error report. Downloaded files are only marked as downloaded on eClaimLink after they are safely stored.

**Modes.** `ECLAIMLINK_MODE=mock` (the default without credentials) simulates eClaimLink inside the local database. Each uploaded claim comes back as a remittance on the next download (about one in five has an activity denied with MNEC-004), and each prior request comes back approved. Use it to train staff. Set `ECLAIMLINK_LOGIN` and `ECLAIMLINK_PASSWORD` to switch to `live` for everyone, or let each person sign in with their own login.

**Going live checklist**

1. Get the facility's web service login from eClaimLink, and test on their QA environment first if they provide one (`ECLAIMLINK_URL`).
2. From a computer on the clinic network, run `npm run eclaimlink:wsdl`. It prints the service namespace and operations. The connector reads the namespace from the WSDL by itself; set `ECLAIMLINK_NAMESPACE` only to override it.
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
| GET | `/api/eclaimlink/service` | Namespace, operations and parameter names read from the eClaimLink WSDL (troubleshooting) |
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
| POST | `/api/eclaimlink/rows` | `{ files: [{ fileId, archive }] }` → each file's claim rows (Reports pages) |
| POST | `/api/eclaimlink/report` | `{ files: [{ fileId, archive }] }` → combined report |

## Before going live

- Set `APP_USERNAME` and `APP_PASSWORD`, and serve the app only over HTTPS (for example behind a reverse proxy).
- The database holds patient identifiers and insurance details. Host it where your facility's data-protection and UAE health-data rules allow, restrict access, and back it up.
- Keep API keys and the eClaimLink password in environment variables or a secrets manager, never in the repository.
