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

## Deploying the warehouse (datasets, views, marts)

Two layers, two tools.

### L1 raw tables — one-time bootstrap (PowerShell)

The raw event tables (`BlockchainEvents.*`) are what the pipeline streams into. They are dbt
*sources* (pipeline-written, dbt-read), not dbt models, so their DDL still lives in `warehouse/L1/`.
Create them once:

```
.\scripts\deploy-warehouse.ps1        # creates the L1 raw tables
```

### Staging, Semantic, Marts — dbt

Everything above raw is managed by dbt. There are no numbered files to run by hand — dbt resolves
execution order from `ref()`/`source()`. From `gd_dbt/`:

```
cd gd_dbt
dbt run          # builds Staging + Semantic + Marts in dependency order
dbt test         # schema + data-quality checks
```

First-time setup: copy `gd_dbt/profiles.yml.example` to `~/.dbt/profiles.yml`, then `dbt deps`.
The default target is `dev` (writes to the `dev_sandbox` dataset); add `--target prod` to write to
the real `Staging`/`Semantic`/`Marts` datasets.

---

## Refreshing marts after a new ingest

L1 grows continuously as the pipeline runs. Semantic views are always live (no action needed).
Marts are tables that need a rebuild after each ingest:

```
cd gd_dbt
dbt run --select marts
```

---

## Verifying everything works

```
cd gd_dbt
dbt test
```

Runs all schema + data-quality checks and exits non-zero if any fail. Browse the lineage graph and
model/column docs with `dbt docs serve` (opens <http://localhost:8080>).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ENVIO_API_TOKEN is missing` | `pipeline/.env` not created or empty | `cp pipeline/.env.example pipeline/.env` and fill in the token |
| `Could not authenticate to Google` | gcloud ADC expired | `gcloud auth application-default login` again |
| `Table not found: gooddollar.BlockchainEvents.…` | L1 DDL not run yet | `.\scripts\deploy-warehouse.ps1` |
| `Insert failed: schema mismatch` | Pipeline writing fields not in the table schema | Re-run the L1 DDL — `CREATE OR REPLACE TABLE` will reset the schema |
| `Request Entity Too Large` (HTTP 413) | Single insert batch over 10MB | Lower `BATCH_SIZE` in `pipeline/index.ts` |
| `Unrecognized name` during `dbt run` | A Semantic model references an L1 column that doesn't exist | Check the L1 schema matches `02_DATA_MODEL.md`; re-run L1 DDL if drift |
| Mart numbers look wrong | Marts rebuilt before L1 fully backfilled. Re-run backfill, then `cd gd_dbt && dbt run --select marts`. |  |

---

## Cron / daily automation (post-MVP)

There is **no daily job set up yet** — the pipeline and dbt are run manually. When it's time to
automate, the daily flow is two ordered steps: ingest first, then dbt.

**Linux/macOS:**

```cron
30 0 * * * cd /opt/gd-events-pipeline/pipeline && /usr/local/bin/npx tsx index.ts append >> /var/log/gd-events.log 2>&1
45 0 * * * cd /opt/gd-events-pipeline/gd_dbt && /usr/local/bin/dbt run --select marts >> /var/log/gd-events.log 2>&1
```

**Windows:** use Task Scheduler. Two tasks, both daily at 00:30 / 00:45 UTC.
