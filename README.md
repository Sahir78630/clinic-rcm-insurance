# Clinic RCM: Insurance

Insurance revenue cycle console for a Dubai polyclinic, plus a small server that runs eligibility checks for every patient on the day's appointment list.

The website covers eligibility and access, prior approvals, claims, remittance and reconciliation, denials, resubmissions and insurance receivables aging by payer, in AED. When it is opened from this server, the **Eligibility & access** page uses the server for real checks. Every other page still runs on sample data stored in the browser.

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

## Before going live

- Set `APP_USERNAME` and `APP_PASSWORD`, and serve the app only over HTTPS (for example behind a reverse proxy).
- The database holds patient identifiers and insurance details. Host it where your facility's data-protection and UAE health-data rules allow, restrict access, and back it up.
- Keep API keys in environment variables or a secrets manager, never in the repository.
