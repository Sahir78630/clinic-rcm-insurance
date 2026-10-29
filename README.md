# Clinic RCM: Insurance

Insurance revenue cycle console for a Dubai polyclinic, plus a small server that runs eligibility checks for every patient on the day's appointment list.

The website covers eligibility and access, prior approvals, claims, remittance and reconciliation, denials, resubmissions and insurance receivables aging by payer, in AED. The system starts empty: there is no sample data. When it is opened from this server, the **Eligibility & access** page uses the server for real checks, and claims, resubmissions, prior requests and remittances move through DHA eClaimLink. When it is opened from this server, everything (claims, payments, denials, approvals, patients, price lists, names, appointments, eligibility checks and every eClaimLink file) is kept in the server database and shared by all staff, who each sign in with their own account. Opened as a single file without the server, it keeps its records in that browser.

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

**Price list.** Under **Price list → Payer price lists**, upload each payer's contracted prices as CSV or Excel (columns: code, description, price; the headings are found automatically) with the payer code (for example INS008) and an optional discount %. Use `*` as the payer code for the facility price list used when a payer has no list of its own. The claim check then compares every activity with its payer's list: billed above the contract price is an error (likely price rejection, blocks batch submit), billed below or a code not on the list is a warning. The page also has a price look-up across all payers and a list of claims with price problems. Price lists are shared by everyone who uses the server.

**Accounts.** Each person signs in with their own username and password. The first time the website is opened **on the computer that runs it**, it asks you to create the admin account (this is only offered on that computer, never through the web link). Then, under **Account & staff**, the admin adds an account for each member of staff (username, name, role and a starting password), sets a new password when someone forgets theirs, makes someone admin or staff, and disables accounts of people who leave. Staff can use everything except the account list and **Clear all data**. Anyone can change their own password and sign out on the same page. Sign-ins last 7 days from the last use and survive a server restart; disabling an account or setting a new password signs that person out at once. After 10 wrong passwords from one place, sign-in pauses for 15 minutes. The eClaimLink login on the eClaimLink files page is separate and still personal.

**Shared records.** Every change is saved on the server within a second and reaches the other computers within about 10 seconds. Each claim, patient, remittance, approval and appointment is saved on its own, so two people working on different claims never overwrite each other; if two people change the same claim at the same moment, the later save wins. The sidebar says when changes cannot reach the server, and they are sent as soon as it is back. A browser that still has records from before they were shared offers once to copy the missing ones to the server (records already there are not changed), then removes its own copy. The server copies the whole database into `data\backups` once a day and keeps the last 30 days; to restore, stop the server and copy a backup over `data\rcm.sqlite`.

**Sharing with staff computers.** On the computer that runs the website, double-click `start-for-staff.bat` instead of `start-windows.bat`. It listens on the clinic network and prints the address to open on staff computers, for example `http://192.168.1.20:3000`. Allow Node.js on *Private networks* if Windows asks. If staff computers show "site can't be reached", double-click `open-firewall.bat` once on that computer (it asks for administrator permission and opens port 3000 in Windows Firewall), and use the `192.168.x.x` address, not a VPN address such as `26.x.x.x`. Keep that computer on and the window open while staff work. To use a clinic computer that stays on all day, unzip the folder there and double-click `setup-clinic-computer.bat` once: it makes the website start by itself whenever someone signs in to Windows on that computer (a shortcut in the Startup folder), stops the computer sleeping while plugged in, opens the firewall, and prints the address `http://COMPUTERNAME:3000`, which keeps working if the 192.168 numbers change. `remove-autostart.bat` undoes the automatic start. The computer must be signed in to Windows for the website to run; after a restart (for example a Windows update) sign in again, or set Windows to sign in automatically. The old shared login in `staff-login.env` is no longer used and can be deleted.

**Web link with Cloudflare Tunnel.** To open the website from anywhere at an address such as `https://rcm.yourclinic.ae`, without opening ports on the clinic router, use a free Cloudflare Tunnel from the clinic computer. You need a Cloudflare account (free) and a domain name added to it (a domain you own, or one bought in Cloudflare under *Domain Registration*).
1. In the main Cloudflare dashboard (not Zero Trust) open **Networking → Tunnels → Create Tunnel**, name it `clinic-rcm`, select **Create Tunnel**, then under *Setup Environment* choose **Windows**. Copy the command it shows (`cloudflared.exe service install eyJ…`). (In Zero Trust the same page is under **Networks → Connectors**.)
2. On the clinic computer double-click `setup-web-link.bat`, click Yes for administrator permission, and paste the command. It finds cloudflared (installed, or the `.msi`/`.exe` in Downloads, or installs it with winget) and installs it as a Windows service, which starts with Windows even before anyone signs in.
3. Back in the dashboard, select **Continue** once the tunnel shows *Healthy*. Open the tunnel, and under **Routes** select **Add route → Published application**: subdomain `rcm`, your domain, service URL `http://localhost:3000`. Select **Add route**.
4. Open `https://rcm.yourdomain` on any computer or phone and sign in. The connection is encrypted (HTTPS) by Cloudflare. Staff inside the clinic can keep using `http://COMPUTERNAME:3000` as well.
The website itself still runs on the clinic computer, so the link works only while that computer is on and signed in to Windows with Clinic RCM running. Do not use the temporary `trycloudflare.com` links for this: their address changes every time. For a second lock, Cloudflare Access (Zero Trust → Access → Applications) can also ask for a one-time code sent to approved email addresses before the sign-in page.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/setup` | `{ username, name, password }` → first admin account (only from the computer that runs the server, only while there are no accounts) |
| POST | `/auth/login` | `{ username, password }` → sign in (cookie) |
| POST | `/auth/logout` | Sign out |
| GET | `/api/me` | The signed-in account |
| POST | `/api/me/password` | `{ current, password }` → change own password |
| GET, POST | `/api/users`, `/api/users/:id` | Admin: list, add (`{ username, name, role, password }`) and change (`{ name?, role?, active?, password? }`) accounts |
| GET | `/api/data?since=` | Shared records changed since a revision |
| POST | `/api/data` | `{ upserts, deletes, settings, log, onlyNew?, clearAll? }` → save changes |
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

- Give each person their own account, and use the app over the internet only through HTTPS (for example the Cloudflare Tunnel above). Every API call needs a signed-in account; requests that change data must be JSON.
- The database holds patient identifiers and insurance details. Host it where your facility's data-protection and UAE health-data rules allow, restrict access, and back it up.
- Keep API keys and the eClaimLink password in environment variables or a secrets manager, never in the repository.
