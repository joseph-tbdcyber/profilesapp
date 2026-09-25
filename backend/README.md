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
2. **AWS SAM CLI**. The winget installer needs Administrator rights and fails
   with exit code 1602 without them. The pip install needs no elevation and is
   what this project was deployed with:
   ```bash
   python -m pip install aws-sam-cli
   sam --version          # SAM CLI, version 1.166.2
   ```
   (If you prefer a system-wide install, run
   `winget install --id Amazon.SAM-CLI -e` from an **Administrator** terminal.)
3. **Node.js 20+** (you have v24) — used to build the Lambdas and run the DB script.
4. **esbuild on your PATH.** `sam build` compiles the TypeScript with esbuild, but
   SAM's internal `npm install` step is production-only, so it never installs the
   devDependency. Put the local copy on PATH for the build:
   ```bash
   export PATH="$PWD/src/node_modules/.bin:$PATH"     # bash
   $env:PATH = "$PWD\src\node_modules\.bin;$env:PATH" # PowerShell
   ```
   Without this, `sam build` fails with *"Cannot find esbuild"*.

---

## Step 1 — Deploy

From this `backend/` directory, with esbuild on PATH (see prerequisite 4):

```bash
sam build
```

Then deploy. This is the exact command used, with every parameter supplied so
there are no interactive prompts — **paste it as a single line** (PowerShell
does not accept `\` as a line continuation; its continuation character is a
backtick):

```powershell
sam deploy --stack-name tprm-backend --region us-east-2 --capabilities CAPABILITY_IAM --resolve-s3 --no-confirm-changeset --no-fail-on-empty-changeset --parameter-overrides "DatabaseName=tprm EngineVersion=16.15 MinAcu=0 MaxAcu=1 SecondsUntilAutoPause=300 AllowedOrigin=https://main.d1jqxcw68kj5bb.amplifyapp.com"
```

What those parameters mean:

| Parameter | Value | Why |
|---|---|---|
| `MinAcu` | `0` | Enables auto-pause — the main cost saver |
| `MaxAcu` | `1` | Spend ceiling; raise it if queries feel slow |
| `SecondsUntilAutoPause` | `300` | 5 minutes, the minimum |
| `EngineVersion` | `16.15` | New enough to support scale-to-zero |
| `AllowedOrigin` | Amplify URL | CORS allowlist |
| `--resolve-s3` | — | Creates a small managed bucket for build artifacts |

The first deploy takes **10–15 minutes**, almost all of it waiting for Aurora.

> **If the deploy fails and the stack ends up in `ROLLBACK_COMPLETE`**, you must
> delete it before retrying — CloudFormation cannot update a stack in that state:
> ```bash
> aws cloudformation delete-stack --stack-name tprm-backend --region us-east-2
> ```
> Check what actually failed with:
> ```bash
> aws cloudformation describe-stack-events --stack-name tprm-backend --region us-east-2 \
>   --query "StackEvents[?ResourceStatus=='CREATE_FAILED'].{R:LogicalResourceId,Why:ResourceStatusReason}" --output text
> ```
> Running `sam validate --lint` **before** deploying catches most template
> problems in seconds rather than after a 15-minute failure.

When it finishes it prints an Outputs table. The current deployment:

```
ApiBaseUrl   https://sczs2nm4fl.execute-api.us-east-2.amazonaws.com
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

**Already done.** `../public/tprm-intake-demo.html` has the deployed URL baked in:

```js
const API_BASE_DEFAULT='https://sczs2nm4fl.execute-api.us-east-2.amazonaws.com';
```

Amplify serves it at
**https://main.d1jqxcw68kj5bb.amplifyapp.com/tprm-intake-demo.html**

To point it somewhere else without editing the file, use the **Backend** box on
the vendor step — it saves to browser local storage and overrides the default.
If you redeploy into a fresh stack, the API URL changes, so update the constant.

---

## Step 4 — Test it

Set `API=https://sczs2nm4fl.execute-api.us-east-2.amazonaws.com` first.

**Matching** — real verified responses:

```bash
curl -s -X POST "$API/vendor-match" -H 'content-type: application/json' -d '{"name":"Acme"}'
```
```json
{"topStatus":"approved","candidates":[{"legalName":"Acme Software, Inc.","domain":"acme.com","status":"approved","score":1,"confidence":"strong","items":["Acme Analytics Cloud","Acme Mail Gateway"]}]}
```

| Input | Result |
|---|---|
| `{"name":"Acme"}` | Acme Software, score **1.0**, approved |
| `{"name":"Cyberdine Systems"}` *(misspelled)* | Cyberdyne Systems, score **0.714**, rejected |
| `{"domain":"https://www.initech.com/products"}` | Initech LLC, score **1.0** (exact domain) |
| `{"name":"Zzyzx Unrelated Holdings"}` | `topStatus: "none"`, no candidates |

Scoring takes the best of three signals: whole-string `similarity()` for typos,
`word_similarity()` so a typed prefix ("Acme" → "Acme Software, Inc.") scores
full marks, and an exact domain match. Using `similarity()` alone scores "Acme"
at just 0.357 and misses the duplicate entirely.

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
banner appears and the "how do you want to proceed" panel opens. Complete the
form and the final screen shows the stored submission id.

### Warm the database up before demoing

With `MinAcu=0` the cluster pauses after 5 idle minutes. The first request then
has to wake it: **measured at ~18 seconds** end to end. The Lambdas retry
automatically so it succeeds rather than erroring, but 18 seconds of nothing
happening looks broken to an audience.

Fire one request a minute before you present:

```bash
curl -s -X POST "$API/vendor-match" -H 'content-type: application/json' -d '{"name":"Acme"}'
```

It stays warm for 5 minutes after the last query. If you would rather it never
pause, redeploy with `MinAcu=0.5` — but then it bills continuously, around
$0.06/hour, roughly $44/month.

---

## Costs

Live rates for **us-east-2**, from the AWS Pricing API:

| Item | Rate |
|---|---|
| Aurora Serverless v2 (PostgreSQL) | **$0.12 per ACU-hour** |
| Aurora storage | **$0.10 per GB-month** |

What that means with `MaxAcu=1`:

- **Worst case ≈ $88/month.** That is 1 ACU × 730 hours × $0.12 — the cluster
  never pausing and pinned at its cap. `MaxAcu=1` exists to make this the ceiling.
- **Realistic demo use: single-digit dollars.** With auto-pause at 5 idle minutes
  you only pay for minutes actually in use; an hour or two of demoing a day is
  roughly $4–7/month.
- **Storage is pennies** at this size — but it bills **even while paused**, which
  is why an idle stack is not free.
- **Secrets Manager** adds a small per-secret monthly charge.
- **Lambda / API Gateway / Data API** are negligible at demo traffic.

These are cost ceilings, not a sizing recommendation. Real sizing needs measured
metrics — watch `ACUUtilization` and `ServerlessDatabaseCapacity` in CloudWatch
before changing `MaxAcu`.

The number to watch is whether auto-pause actually engages. If it does not, you
drift toward the $88 ceiling instead of single digits. Check Cost Explorer after
the first day or two.

**A paused cluster still bills for storage.** If you are done, tear it down
rather than leaving it paused.

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

## The database console

The app's landing page (`/`) is a read-only database console:

- **Topology** — the Aurora cluster (status, engine version, ACU range, and live
  capacity from CloudWatch) with its tables, columns and row counts, plus the
  Amplify DynamoDB tables listed alongside and marked non-queryable
- **Query** — type SQL, Ctrl/⌘+Enter to run; click a table name to template a
  `SELECT`
- **Export** — CSV, TSV, JSON download, and "Copy for Excel" (tab-separated to
  the clipboard, which pastes straight into a sheet)

### It is read-only, and that is load-bearing

**The `/admin/*` endpoints are public and unauthenticated.** Anyone with the URL
can read the database. That is an accepted trade-off for a demo holding fake
data and would be unacceptable for anything real. CORS does *not* protect them —
CORS only constrains browsers, and `curl` ignores it.

Writes are blocked by three layers, in descending order of importance:

1. **A Postgres `READ ONLY` transaction that is always rolled back.** This is
   the guarantee that matters — the engine refuses writes regardless of what SQL
   reached it.
2. **A 15-second statement timeout**, so an expensive query cannot pin the
   cluster at max ACUs and run up the bill.
3. **A parser check** (single statement; must begin SELECT/WITH/TABLE/EXPLAIN/SHOW).
   The weakest layer, and never sufficient alone.

Why layer 1 is not optional — all of these were tested against the live endpoint:

| Query | Blocked by |
|---|---|
| `DELETE FROM vendors` | parser |
| `DROP TABLE vendors` | parser |
| `SELECT 1; DROP TABLE vendors` | parser (stacked statements) |
| `WITH x AS (DELETE FROM vendors RETURNING *) SELECT count(*) FROM x` | **the engine** (`SQLState 25006`) |

That last one starts with `WITH`, so it passes the parser cleanly. Without the
read-only transaction it would have emptied the table.

To make read-only a choice rather than a necessity, put a Cognito authorizer in
front of the API — see the `TODO(auth)` comments.

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
