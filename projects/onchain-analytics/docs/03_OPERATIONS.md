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
cd pipeline-v5
npm install
```

### 5. Configure environment

```
cp pipeline-v5/.env.example pipeline-v5/.env
```

Edit `pipeline-v5/.env` and paste your `ENVIO_API_TOKEN` (get it at <https://envio.dev>).

---

## Running the pipeline

The pipeline is [`pipeline-v5/`](../pipeline-v5/), and it is the only one. Its full runbook is
[`pipeline-v5/README.md`](../pipeline-v5/README.md); this section is the short version. All
commands run from inside `pipeline-v5/`.

### Backfill, load full history

```
cd pipeline-v5
npx tsx src/index.ts backfill --contracts=ClaimContractEvents
npx tsx src/index.ts backfill --contracts=InviteContractEvents
```

Add `--from=N --to=N` to target a range. A run reports its chunk plan and, for every range it
attempted, writes a row to `BlockchainEvents.IngestionCoverage` recording whether every chunk
succeeded.

**Re-running the same range is safe and is expected.** The write path is a staging table plus a
`MERGE` on `(network, tx_hash, log_index)`, so a repeated backfill leaves the table
byte-identical. This was not true of the predecessor, which appended through streaming inserts
whose `insertId` de-duplication window is minutes rather than months; re-running a range four
months later wrote 43,000 phantom rows. If you read that older instruction anywhere, it is
wrong.

### Daily incremental

```
cd pipeline-v5
npx tsx src/index.ts daily
npx tsx src/index.ts verify
```

`verify` reconciles the warehouse against the contracts' own per-day ledgers and is the only
check here that consults something outside the warehouse. A run that does not reconcile exits
nonzero.

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
| `ENVIO_API_TOKEN is missing` | `pipeline-v5/.env` not created or empty | `cp pipeline-v5/.env.example pipeline-v5/.env` and fill in the token |
| `Could not authenticate to Google` | gcloud ADC expired | `gcloud auth application-default login` again |
| `Table not found: gooddollar.BlockchainEvents.…` | L1 DDL not run yet | Apply `warehouse/L1/04_L0Contract_v3.sql` |
| `SCHEMA_MISMATCH: <table> has no column(s) …` | The pipeline writes a column the live table lacks | Apply the L0 contract. The pipeline refuses to write rather than corrupting a MERGE |
| Run exits 1 with skipped chunks | HyperSync rate limiting or a timeout | Read `IngestionCoverage` for the exact ranges, then `backfill --from --to` over them |
| `UNCONFIRMED EMPTY RANGE` | A range came back empty and no independent endpoint could confirm it | Not an error to clear by retrying. The watermark deliberately did not advance. Re-run when the endpoints recover |
| `REORG SUSPECTED` | An existing key now sits under a different block hash | Delete and re-ingest that block range |
| `Unrecognized name` during `dbt run` | A Semantic model references an L1 column that does not exist | Check the L1 schema matches `02_DATA_MODEL.md` |
| Mart numbers look wrong | Marts rebuilt before L1 was fully ingested | Run `verify` first. If it reports short days, `repair --days=…`, then `cd gd_dbt && dbt run --select marts` |

---

## Cron / daily automation (post-MVP)

There is **no daily job set up yet** — the pipeline and dbt are run manually. When it's time to
automate, the daily flow is two ordered steps: ingest first, then dbt.

**Linux/macOS:**

```cron
30 0 * * * cd /opt/onchain-analytics/pipeline-v5 && /usr/local/bin/npx tsx src/index.ts daily >> /var/log/gd-events.log 2>&1
45 0 * * * cd /opt/gd-events-pipeline/gd_dbt && /usr/local/bin/dbt run --select marts >> /var/log/gd-events.log 2>&1
```

**Windows:** use Task Scheduler. Two tasks, both daily at 00:30 / 00:45 UTC.
