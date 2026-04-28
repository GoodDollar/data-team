# Operations Guide

How to run everything in this repo. Written for someone who has never used BigQuery before.

---

## One-time setup (do these before anything else)

### 1. Install Node.js

Download the LTS version from <https://nodejs.org>. After install, in a new terminal:

```
node --version    # should print v20 or v22
npm --version
```

### 2. Install Google Cloud CLI

Download from <https://cloud.google.com/sdk/docs/install>. The `bq` CLI tool ships with it (we'll use this for warehouse deployment).

After install:

```
gcloud --version
bq --version
```

### 3. Authenticate to GCP

Run once per machine. Opens a browser for you to log in:

```
gcloud auth application-default login
gcloud config set project gooddollar
```

The pipeline and `bq` CLI both read these credentials automatically — no passwords stored anywhere in this repo.

### 4. Install pipeline dependencies

```
cd pipeline
npm install
```

### 5. Configure environment

```
cp pipeline/.env.example pipeline/.env
```

Edit `pipeline/.env` and paste your `ENVIO_API_TOKEN` (get it at <https://envio.dev>).

---

## Running the pipeline

The pipeline is at [`pipeline/index.ts`](../pipeline/index.ts). All commands run from inside `pipeline/`.

### Backfill — load full history (run once per contract)

```
cd pipeline
npx tsx index.ts backfill claim       # UBIClaimed events from UBIScheme
npx tsx index.ts backfill invite      # InviteeJoined + InviterBounty from Invite contract
```

Each backfill takes a few minutes at MVP volume. Output looks like:

```
Mode: backfill | Contracts: claim
[XDC] Fetching from block 95249624 to latest...
[XDC] First event: UBIClaimed at block 95249701
[XDC] Inserted 1000 rows (total: 1000)
...
[XDC] Done. Decoded: 12483, skipped: 0.
```

If a backfill crashes mid-way, just rerun the same command. Insert IDs deduplicate retries automatically.

### Append — daily incremental (run after backfill, then daily going forward)

```
cd pipeline
npx tsx index.ts append claim
npx tsx index.ts append invite
```

Or all contracts at once:

```
npx tsx index.ts append
```

---

## Deploying the warehouse (BQ datasets, views, marts)

There are two ways. Use whichever is easier.

### Option A — PowerShell scripts (recommended once `bq` CLI is installed)

```
.\scripts\deploy-warehouse.ps1 L1     # creates the L1 tables (do this once)
.\scripts\deploy-warehouse.ps1 L2     # creates Semantic dataset + 5 views
.\scripts\deploy-warehouse.ps1 L3     # creates Marts dataset + 3 marts
```

Or all in one shot:

```
.\scripts\deploy-warehouse.ps1 all
```

### Option B — BigQuery console (if you don't have `bq` CLI)

For each `.sql` file in `warehouse/L1/`, then `warehouse/L2/`, then `warehouse/L3/`, in numbered order:

1. Open <https://console.cloud.google.com/bigquery>
2. Confirm the project selector at the top says `gooddollar`
3. Click **+ Compose new query**
4. Open the `.sql` file in a text editor, copy the full contents, paste into the BQ query editor
5. Click **Run** — should see "Query complete"
6. Repeat for the next file

Files are numbered in execution order (`01_…`, `02_…`, etc.) — run them strictly in that order within each layer.

---

## Refreshing marts after a new ingest

L1 grows continuously as the pipeline runs. L2 views are always live (no action needed). L3 marts are pre-computed tables that need rebuild after each ingest.

```
.\scripts\refresh-marts.ps1
```

This re-runs every `warehouse/L3/*.sql` file. Takes < 1 minute at MVP volume.

---

## Verifying everything works

```
.\scripts\verify.ps1
```

Runs the validation queries from the spec and prints PASS/FAIL for each. Use this any time you want to sanity-check the warehouse end-to-end.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ENVIO_API_TOKEN is missing` | `pipeline/.env` not created or empty | `cp pipeline/.env.example pipeline/.env` and fill in the token |
| `Could not authenticate to Google` | gcloud ADC expired | `gcloud auth application-default login` again |
| `Table not found: gooddollar.BlockchainEvents.…` | L1 DDL not run yet | `.\scripts\deploy-warehouse.ps1 L1` |
| `Insert failed: schema mismatch` | Pipeline writing fields not in the table schema | Re-run the L1 DDL — `CREATE OR REPLACE TABLE` will reset the schema |
| `Request Entity Too Large` (HTTP 413) | Single insert batch over 10MB | Lower `BATCH_SIZE` in `pipeline/index.ts` |
| `View … is invalid: Unrecognized name` | An L2 view references an L1 column that doesn't exist | Check the L1 schema matches `02_DATA_MODEL.md`; re-run L1 DDL if drift |
| L3 mart numbers look wrong | Marts refreshed against stale L2 view? L2 always live so this shouldn't happen — likely L1 not fully backfilled. Re-run backfill. |  |

---

## Cron / daily automation (post-MVP)

For MVP, run the pipeline and refresh marts manually. Once validated:

**Linux/macOS:**

```cron
30 0 * * * cd /opt/gd-events-pipeline/pipeline && /usr/local/bin/npx tsx index.ts append >> /var/log/gd-events.log 2>&1
45 0 * * * cd /opt/gd-events-pipeline && pwsh ./scripts/refresh-marts.ps1 >> /var/log/gd-events.log 2>&1
```

**Windows:** use Task Scheduler. Two tasks, both daily at 00:30 / 00:45 UTC.
