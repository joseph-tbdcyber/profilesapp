# TPRM Intake POC — Backend

A throwaway demo backend for the third-party/vendor intake form. It stores
submissions in Aurora PostgreSQL and powers live duplicate matching as someone
types a vendor name.

**This is a proof of concept, not production.** The endpoints have no
authentication, and tearing the stack down permanently deletes the database.

---

## What gets created

| Resource | What it is | Why |
|---|---|---|
| **Aurora PostgreSQL Serverless v2** | A managed database that scales itself | Stores vendors, items, and raw submissions |
| **RDS Data API** | An HTTPS front door to that database | Lets Lambda query the DB without any VPC networking |
| **Secrets Manager secret** | Holds the DB password | Created and rotated by RDS; you never see or type it |
| **2 Lambda functions** | `vendor-match`, `submit` | The actual API logic |
| **API Gateway HTTP API** | The public URL | Routes browser requests to the Lambdas |

Everything lives in **us-east-2** (matching the Amplify app) and uses your
account's **default VPC**, so no networking resources are created.

---

## Prerequisites

1. **AWS CLI**, signed in:
   ```bash
   aws sts get-caller-identity     # should print your account; if not, run: aws login
   ```
2. **AWS SAM CLI** — *not currently installed on this machine.* Install it:
   ```bash
   winget install Amazon.SAM-CLI
   ```
   Then **restart your terminal** and confirm: `sam --version`
3. **Node.js 20+** (you have v24) — used to build the Lambdas and run the DB script.

---

## Step 1 — Deploy

From this `backend/` directory:

```bash
sam build
sam deploy --guided --stack-name tprm-backend --region us-east-2
```

`--guided` asks you a series of questions. Safe answers:

- **Stack Name** → `tprm-backend`
- **AWS Region** → `us-east-2`
- **Parameter DatabaseName** → `tprm`
- **Parameter EngineVersion** → accept the default
- **Parameter MinAcu** → `0` (lets the database pause when idle — this is the main cost saver)
- **Parameter MaxAcu** → `1` (a spend ceiling; raise it if queries feel slow)
- **Parameter SecondsUntilAutoPause** → `300`
- **Parameter AllowedOrigin** → accept the default (your Amplify URL)
- **Confirm changes before deploy** → `y`
- **Allow SAM CLI IAM role creation** → `y` (it needs to create the Lambda roles)
- **Disable rollback** → `N`
- **Save arguments to configuration file** → `y` (so future deploys are just `sam deploy`)

The first deploy takes **10–15 minutes**, almost all of it waiting for Aurora.

When it finishes it prints an Outputs table. The one you need:

```
ApiBaseUrl   https://xxxxxxxx.execute-api.us-east-2.amazonaws.com
```

---

## Step 2 — Create the tables and sample data

```bash
npm install          # first time only
npm run init-db
```

This reads the cluster details straight from the deployed stack (no ARNs to
copy), applies `db/schema.sql`, then `db/seed.sql`. It prints each statement as
it runs and finishes with a count:

```
vendors table now contains:
  approved   6
  in_review  3
  rejected   3
```

The **first run is slow** — if the database auto-paused, the script waits for it
to wake up and says so. That's expected.

Both files are safe to re-run; running `npm run init-db` twice changes nothing.
Use `npm run init-db -- --schema-only` to skip the sample vendors.

---

## Step 3 — Point the form at the API

The form is at `../public/tprm-intake-demo.html` and ships with no API URL set.
Two ways to configure it:

**Quick (no code change):** open the form, and on the first or vendor step paste
the `ApiBaseUrl` into the **Backend** box and press Save. It's remembered in
your browser's local storage.

**Permanent:** edit the file and set the default:
```js
const API_BASE_DEFAULT='https://xxxxxxxx.execute-api.us-east-2.amazonaws.com';
```
Then commit and push — Amplify serves it at
`https://main.d1jqxcw68kj5bb.amplifyapp.com/tprm-intake-demo.html`.

---

## Step 4 — Test it

**Matching** (should return the seeded Acme vendor):
```bash
curl -s -X POST "$API/vendor-match" \
  -H 'content-type: application/json' \
  -d '{"name":"Acme"}'
```
```json
{"topStatus":"approved","candidates":[{"legalName":"Acme Software, Inc.","status":"approved","score":0.55,"confidence":"possible","items":["Acme Analytics Cloud","Acme Mail Gateway"]}]}
```

Try a misspelling — `{"name":"Cyberdine Systems"}` still finds Cyberdyne. That's
`pg_trgm` doing fuzzy comparison inside Postgres.

**Submitting:**
```bash
curl -s -X POST "$API/submit" \
  -H 'content-type: application/json' \
  -d '{"vendor_legal_name":"Testco Inc.","vendor_website":"https://testco.com",
       "third_party_items":[{"item_name":"Testco Widget","item_type":"saas"}]}'
```
```json
{"submissionId":"...","vendorId":"...","vendorCreated":true,"itemIds":["..."]}
```

**Read it back** — in the AWS Console go to **RDS → Query Editor**, pick the
cluster, authenticate with the Secrets Manager secret, and run:
```sql
SELECT s.id, v.legal_name, s.created_at
FROM submissions s JOIN vendors v ON v.id = s.vendor_id
ORDER BY s.created_at DESC LIMIT 5;
```

**In the browser:** open the form, type `Acme` in the vendor name — a match
banner appears within a moment and the "how do you want to proceed" panel opens.
Complete the form and the final screen shows the stored submission id.

---

## Costs

The meaningful drivers, cheapest-first:

- **Compute (ACUs)** — billed per ACU-hour. With `MinAcu=0` the cluster pauses
  after 5 idle minutes and **stops billing compute entirely**. This is why the
  demo is cheap: it costs almost nothing when nobody is using it.
- **Storage** — billed per GB-month for what you actually use. A seeded demo
  database is tiny, but storage bills **even while the cluster is paused**.
- **Backups** — retention is set to the 1-day minimum.
- **Secrets Manager** — one secret, billed monthly.
- **Lambda / API Gateway / Data API** — per request; a demo's traffic is
  negligible and may fall inside the free tier.

I'm deliberately not quoting dollar figures — check the live
[Aurora pricing page](https://aws.amazon.com/rds/aurora/pricing/) for us-east-2,
and watch **Cost Explorer** for the first day or two.

The thing to remember: **a paused cluster still bills for storage.** If you're
done with the demo, tear it down rather than leaving it paused.

Watch `ACUUtilization` and `ServerlessDatabaseCapacity` in CloudWatch to see
whether `MaxAcu=1` is actually constraining you before raising it.

---

## Teardown — stop all billing

```bash
sam delete --stack-name tprm-backend --region us-east-2
```

> **This permanently destroys the database and every row in it.** The stack sets
> `DeletionPolicy: Delete` on purpose so nothing keeps billing after teardown.
> There is no final snapshot. If you ever want one, change `DeletionPolicy` to
> `Snapshot` in `template.yaml` first — but note snapshots themselves cost money.

Confirm it's gone:
```bash
aws cloudformation describe-stacks --stack-name tprm-backend --region us-east-2
# should error: Stack with id tprm-backend does not exist
```

The Amplify frontend is a **separate stack** and is unaffected.

---

## Layout

```
backend/
├── template.yaml            # all infrastructure, heavily commented
├── db/
│   ├── schema.sql           # tables + pg_trgm trigram index
│   └── seed.sql             # 12 sample vendors (incl. Acme)
├── scripts/init-db.mjs      # applies schema + seed via the Data API
└── src/
    ├── shared/db.ts         # Data API wrapper + transactions
    ├── shared/normalize.ts  # name/domain normalization
    ├── vendor-match/        # POST /vendor-match
    └── submit/              # POST /submit
```

---

## Adding auth later

Both endpoints are currently open to anyone with the URL. Search for
`TODO(auth)` — there are three, in `template.yaml` and both handlers. The
template comment has the exact JWT authorizer block to add once you have a
Cognito user pool (this repo's Amplify app already defines one in
`amplify/auth/`).
