# Operations Guide

How to run everything in this repo. Written for someone who has never used BigQuery before.

> **Status, 2026-10-05.** The raw-table migrations in this guide are approved but **not applied
> to production**, and the pipeline has **not been run against production**. Commands that write
> to `BlockchainEvents` are documented for when that is authorized; until then, use the plan-only
> and sandbox paths. Read [`START_HERE.md`](START_HERE.md) for current status and the next step.

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

A personal login is enough for metadata reads, dbt development in `dev_sandbox`, and the labelled
sandbox validator. It is **not** a production writer: on 2026-10-05 the account that prepared this
release could read `BlockchainEvents` but could not create tables, change schemas, or write rows.
Production schema changes and ingestion use separately approved service-account identities.

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

### Preview a run (safe now)

```
cd pipeline-v5
npx tsx src/index.ts plan --chains=XDC --addresses=0x.. --from=N --to=N
```

`plan` reads no chain and writes nothing to BigQuery. It lists the exact work units and the budget
verdict, and exits nonzero if anything would be refused.

### Backfill a named range (needs production authorization)

```
cd pipeline-v5
npx tsx src/index.ts backfill --chains=XDC --addresses=0x.. --from=N --to=N
```

`backfill` requires both `--from` and `--to`; a bare `backfill` is refused. There is no
`--contracts` option. Always pass `--chains`, because the default selection includes a chain
outside the release scope and the run then cannot exit 0. A run reports its chunk plan and, for
every range it attempted, writes a row to `BlockchainEvents.IngestionCoverage` recording whether
every chunk succeeded.

**Re-running the same range is safe and is expected.** The write path is a staging table plus a
`MERGE` on `(chain_id, tx_hash, log_index)`, so a repeated backfill leaves one row per log.
This was not true of the predecessor, which appended through streaming inserts whose `insertId`
de-duplication window is minutes rather than months.

### Daily incremental (needs production authorization)

```
cd pipeline-v5
npx tsx src/index.ts daily --chains=CELO,XDC
npx tsx src/index.ts coverage --chains=CELO,XDC
npx tsx src/index.ts verify --chains=CELO,XDC
```

`daily` resumes each contract from its coverage record. While that record is empty, every contract
would resume from its creation block, so the run-size and span limits refuse it; capture history
with explicit `backfill` ranges first. `verify` reconciles the warehouse against the contracts' own
per-day ledgers and is the only check here that consults something outside the warehouse. A run
that does not reconcile exits nonzero.

Every mode except `plan` starts by checking the bookkeeping tables and records a `PipelineRuns`
row, so even `verify` and `coverage` need the migrated schema and write access.

---

## Deploying the warehouse (datasets, views, marts)

Two layers, two tools.

### L1 raw tables -- allowlisted additive migrations

Raw tables are pipeline-written dbt sources, not dbt models. `scripts/deploy-warehouse.ps1` accepts
one named migration from a fixed allowlist; it never scans `warehouse/L1/`. Its default mode only
prints the target and migration name:

```powershell
.\scripts\deploy-warehouse.ps1 -Migration 09_CreateRawLogs_v1.sql
```

Before any production change, validate the same migration files against a fresh labelled sandbox.
From `pipeline-v5/`:

```powershell
node --import tsx ..\scripts\ops\validate-l0-migrations.mjs
```

The report is written to `_scratch/schema-migration-validation.json` at the repository root; pass a
different path as the first argument to change it.

This sandbox check exercises the old `PipelineRuns` and `OracleReconciliation` shapes, repeats the
migrations, checks their statement types and byte caps, verifies historical fixture rows remain,
and proves the sandbox is absent after cleanup. It does not write production tables or ingest chain
data.

Production DDL is a separate operation and is not authorized by running the validator or plan mode.
Only after separate approval of the exact migration and access list may the named administrator run
one migration at a time:

```powershell
.\scripts\deploy-warehouse.ps1 -Migration 09_CreateRawLogs_v1.sql -Execute -AllowProduction `
	-ImpersonateServiceAccount schema-commissioner@gooddollar.iam.gserviceaccount.com
```

The service-account address above is illustrative; replace it only with the approved identity. The
helper refuses production execution without an explicit account. It sets
`CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT` only in the query child process's environment;
persistent gcloud configuration and the caller's environment are never modified. Separate
deployments therefore cannot overwrite each other's selected identity. The
helper also requires a typed confirmation for `gooddollar.BlockchainEvents` and applies a 10 GiB
per-job bytes cap. Stop if a live object differs from the measured schema baseline, an object that
should be absent already exists, a migration returns `SCRIPT`, a legacy row count changes, or an
effective permission is broader than the approved list. Never run `04_L0Contract_v3.sql`,
`06_L0Contract_v4.sql`, or `07_RetireV3EventTables.sql` through this path.

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
| `Table not found: gooddollar.BlockchainEvents.…` | The prepared L1 schema migration has not been commissioned | Stop and check the approved migration list; do not run a historical contract file |
| `SCHEMA_MISMATCH: <table> has no column(s) …` | The live schema differs from the runtime contract | Stop ingestion. Re-measure the schema and approve a new additive migration; do not recreate the table |
| Run exits 1 with skipped chunks | HyperSync rate limiting or a timeout | Read `IngestionCoverage` for the exact ranges, then `backfill --from --to` over them |
| `UNCONFIRMED EMPTY RANGE` | A range came back empty and no independent endpoint could confirm it | Not an error to clear by retrying. The watermark deliberately did not advance. Re-run when the endpoints recover |
| `REORG SUSPECTED` / `REORG_APPLIED` | An existing key now sits under a different block hash | No manual action. The MERGE has already rewritten the row whole, including its block facts, and the coverage row records it |
| `Unrecognized name` during `dbt run` | A Semantic model references an L1 column that does not exist | Check the L1 schema matches `02_DATA_MODEL.md` |
| Mart numbers look wrong | Marts rebuilt before L1 was fully ingested | Run `verify` first. If it reports short days, `repair --days=…`, then `cd gd_dbt && dbt run --select marts` |

---

## Cron / daily automation (post-MVP)

There is **no daily job set up yet** — the pipeline and dbt are run manually. The GitHub workflow
`.github/workflows/pipeline-daily.yml` runs only on manual dispatch and refuses production
datasets. It is not ready to dispatch: it still expects a `GCP_SA_KEY` secret, whose absence was
last measured on 2026-09-28. Reconcile the workflow with the keyless identity design and verify its
authentication before using it. Do not add a long-lived service-account key for convenience, and
do not schedule ingestion until production ingestion is authorized. When it is time to automate,
the daily flow is two ordered steps: ingest first, then dbt. The examples below are illustrative.

**Linux/macOS:**

```cron
30 0 * * * cd /opt/onchain-analytics/pipeline-v5 && /usr/local/bin/npx tsx src/index.ts daily >> /var/log/gd-events.log 2>&1
45 0 * * * cd /opt/gd-events-pipeline/gd_dbt && /usr/local/bin/dbt run --select marts >> /var/log/gd-events.log 2>&1
```

**Windows:** use Task Scheduler. Two tasks, both daily at 00:30 / 00:45 UTC.
