# GoodDollar Onchain Analytics System

An analytics platform on BigQuery for questions about GoodDollar onchain activity, from raw
blockchain events through business-ready dashboards. Built for the GoodDollar data team and
leadership.

> **New to this system? Read [`docs/START_HERE.md`](docs/START_HERE.md) first.** It explains what
> is live, what is prepared, how data flows, and which documents are current.
>
> **Status, 2026-10-05:** existing dbt models and dashboards are live on the older XDC
> per-contract tables. The new ingestion pipeline and its raw-table migrations are merged and
> sandbox-tested, but **have not been applied or run in production**. There is no scheduled
> ingestion.

---

## System Architecture

The system is composed of five layers, each with a clear responsibility:

```
+-----------------------------------------------------------------------+
|                GoodDollar Onchain Analytics System                    |
+-----------------------------------------------------------------------+
|  Layer 5 | Self-Service AI          [planned]                         |
|  Layer 4 | Dashboards               Looker Studio                     |
|  Layer 3 | Marts                    Pre-aggregated, KPI-ready         |
|  Layer 2 | Semantic Models          Business logic, defined once      |
|  Layer 1 | Staging                  Normalized, filtered              |
|  Layer 0 | Ingestion Pipeline       HyperSync / RPC -> BigQuery raw   |
+-----------------------------------------------------------------------+
|  Governance | Documentation, glossary, contracts, tests               |
+-----------------------------------------------------------------------+
```

### Layer 0 -- Ingestion Pipeline

A TypeScript application that reads contract logs with
[Envio HyperSync](https://docs.envio.dev/docs/HyperSync/overview), or over JSON-RPC on chains with
no HyperSync index. It writes them **undecoded** into the BigQuery raw tables
`gooddollar.BlockchainEvents.RawLogs` and `Transactions`, together with a coverage record of every
range it read. Not yet run in production; see [`docs/START_HERE.md`](docs/START_HERE.md).

-> [`pipeline-v5/`](pipeline-v5/)

### Layers 1-3 -- dbt Warehouse (Medallion Architecture)

Managed by [dbt Core](https://docs.getdbt.com/) on BigQuery:

| Layer | Dataset | What it does | Materialization |
|---|---|---|---|
| **Staging** | `Staging` | Normalizes raw events -- lowercase addresses, type casting, filters out partial-day data | Views |
| **Semantic** | `Semantic` | Defines business entities exactly once -- signups, payouts, claims, lifecycles | Views |
| **Marts** | `Marts` | Pre-aggregated tables shaped for dashboards -- daily metrics, funnels, KPIs | Tables |

The current models read the older per-contract raw tables (`ClaimContractEvents`,
`InviteContractEvents`). Models over the new `RawLogs` and `Transactions` tables are not built yet.

-> [`gd_dbt/`](gd_dbt/)

### Layer 4 -- Dashboards

Google Looker Studio connected to the Marts. Future: Metabase for broader self-service.

### Layer 5 -- Self-Service AI (planned)

AI analyst with governed access across all layers, grounded by the semantic layer, business glossary, and disambiguation protocol.

### Governance

Documentation contracts, business glossary, and AI-readiness gates that every model must pass before production.

-> [`docs/`](docs/)

---

## How It Works -- The 2-Minute Version

### Data Flow (end to end)

```
Blockchain -> Pipeline -> BigQuery raw tables -> dbt Staging -> dbt Semantic -> dbt Marts -> Dashboards
```

1. **The pipeline captures raw logs** from the blockchain into BigQuery (`BlockchainEvents`). It
   is the only component that talks to the chain, and it does not decode anything.
2. **dbt transforms everything above raw.** One command (`dbt run`) rebuilds Staging, Semantic and
   Marts in dependency order.
3. **Dashboards read from Marts only.** Pre-aggregated, tested, documented -- what you see is what
   was defined in code.

### Who Owns What

| Concern | Where it lives | Key files |
|---|---|---|
| **Chain connection & raw capture** | Pipeline (TypeScript) | `pipeline-v5/src/`, reference in `pipeline-v5/README.md` |
| **Which contracts are captured** | dbt reference seed | `gd_dbt/seeds/contract_deployments.csv` |
| **Which chains are in scope** | Pipeline code | `pipeline-v5/src/control-plane/releaseScope.ts`, explained in `docs/release-scope.md` |
| **Raw table schemas (DDL)** | `warehouse/L1/` | Allowlisted migrations `08_` to `12_`, applied only through `scripts/deploy-warehouse.ps1` |
| **Data cleaning & normalization** | dbt Staging models | `gd_dbt/models/staging/` |
| **Business logic** (what is a signup, what is a payout) | dbt Semantic models | `gd_dbt/models/semantic/` |
| **Dashboard-ready metrics** (daily counts, funnels, KPIs) | dbt Marts | `gd_dbt/models/marts/` |
| **Tests & data quality** | dbt schema YAML + custom tests | `gd_dbt/models/*/_*.yml` |
| **Documentation** | dbt YAML (column/model descriptions) + `/docs` | Auto-published to [GitHub Pages](https://gooddollar.github.io/data-team/) |
| **Business glossary & term definitions** | `docs/06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md` | Single source of truth for "what does X mean" |

### Adding a New Contract / Event

1. Add the contract to the `contract_deployments` seed (chain, proxy address, creation block, one
   row per implementation era) and, so models can decode it, its events to the `event_surface`
   seed. No pipeline code or table schema changes. Details:
   [`pipeline-v5/README.md`](pipeline-v5/README.md#adding-a-contract).
2. Capture it with an explicit, authorized `backfill --from --to` run. Production ingestion is not
   authorized yet; see [`docs/START_HERE.md`](docs/START_HERE.md).
3. Add a dbt staging model -> optional semantic model (business logic) -> optional mart (dashboard metrics).
4. Add glossary entries for any new terms.

Each layer only reads from the layer directly below it. Logic flows up, never sideways.

### Operating the System

| Task | Command | Production status (2026-10-05) |
|---|---|---|
| Preview exactly what an ingestion would do | `cd pipeline-v5 && npx tsx src/index.ts plan --chains=XDC --addresses=0x.. --from=N --to=N` | Safe: reads no chain, writes nothing |
| Run the pipeline's automated tests | `cd pipeline-v5 && npm test` | Safe: credential-free |
| Ingest, check, repair (`daily`, `backfill`, `coverage`, `verify`, `repair`) | `cd pipeline-v5 && npx tsx src/index.ts <mode> ...` | **Not authorized against production.** Needs the migrated schema and a writer identity |
| Rebuild warehouse layers | `cd gd_dbt && dbt run` | Default target writes `dev_sandbox` |
| Run data quality tests | `cd gd_dbt && dbt test` | After any `dbt run` |
| Browse data catalog + lineage | Visit [gooddollar.github.io/data-team](https://gooddollar.github.io/data-team/) | Anytime |
| Add/modify a model | Edit SQL in `gd_dbt/models/`, run `dbt run --select model_name` | Development |

The pipeline and dbt are independent -- the pipeline writes raw tables, dbt reads them. They run in sequence (ingest first, then transform), not as a single coupled process.

---

## What's Live

Status as of 2026-10-05. Details and measured production state: [`docs/START_HERE.md`](docs/START_HERE.md#2-what-is-live-what-is-prepared-what-is-not-applied).

| Component | Status | Scope |
|---|---|---|
| dbt warehouse | Live | Staging, Semantic and Marts over the older XDC per-contract tables (`ClaimContractEvents`, `InviteContractEvents`) |
| Looker Studio dashboards | Live (not re-verified on 2026-10-05) | Invite funnel, daily metrics, claim activity, read from the Marts |
| Older XDC raw tables | Present, not refreshed | Loaded by an earlier pipeline version. The current pipeline does not write them and no job refreshes them |
| Ingestion pipeline (`pipeline-v5`) | Merged, **not run in production** | Writes `RawLogs` and `Transactions`. Tested with the automated suite and small sandbox runs only |
| Raw-table migrations `08` to `12` | Merged and sandbox-rehearsed, **not applied** | Scope and retention approved; waiting on a temporary administrator-provisioned commissioning identity |
| Staging dataset and pipeline writer identity | **Not created** | Required before any production ingestion |
| Production canary / 12-month Celo and XDC ingestion | **Not run, not authorized** | Each needs its own approval after the schema is commissioned and verified |
| Scheduled ingestion | Off | `.github/workflows/pipeline-daily.yml` is manual-only and refuses production datasets, but is not ready to dispatch: it still expects `GCP_SA_KEY`, whose absence was last measured 2026-09-28. Reconcile it with the keyless identity design before use |
| dbt models over `RawLogs`, dashboard cutover | Not built | |
| Release scope | Frozen in code | Celo, XDC, Ethereum. Fuse dropped 2026-09-28. Base and Gnosis not assessed |
| Self-service AI | Planned | |

---

## Repo Layout

| Path | What |
|---|---|
| [`gd_dbt/`](gd_dbt/) | dbt project -- all warehouse models, tests, docs, macros, reference seeds |
| [`pipeline-v5/`](pipeline-v5/) | The ingestion pipeline (TypeScript). The only one. Reference in its own README |
| [`warehouse/L1/`](warehouse/L1/) | Raw table DDL (pipeline-written tables, dbt *sources*) |
| [`scripts/`](scripts/) | Explicitly allowlisted L1 migration helper and sandbox validator |
| [`contracts/`](contracts/) | ABI files, deployment block numbers, contract reference |
| [`docs/`](docs/) | Start-here guide, system documentation, data model, operations guide, governance |

---

## Quick Start

Everything in this section is safe to run today: none of it writes to a production dataset.
Production schema changes and production ingestion need separately approved identities; see
[`docs/START_HERE.md`](docs/START_HERE.md#7-three-separate-operations-three-separate-approvals).

### Prerequisites

- Node.js LTS (v20+)
- Google Cloud SDK (`gcloud`, `bq`)
- `gcloud auth application-default login` for metadata reads, dbt development, and labelled
  sandbox validation. A personal login is **not** a production writer: as measured on
  2026-10-05 it can read `BlockchainEvents` but cannot create tables, change schemas, or write rows
- Python 3.9+ with dbt-bigquery (`pip install dbt-bigquery`)

### Run the warehouse

```bash
cd gd_dbt
dbt run              # Build all: Staging -> Semantic -> Marts (default "dev" target writes dev_sandbox)
dbt test             # Run schema + data-quality tests
dbt docs serve       # Browse lineage + docs at localhost:8080
```

First-time dbt setup is in [`docs/03_OPERATIONS.md`](docs/03_OPERATIONS.md).

### Try the pipeline locally

```bash
cd pipeline-v5
npm install
npm test                  # credential-free automated test suite
cp .env.example .env      # add your ENVIO_API_TOKEN; every mode needs it set
npx tsx src/index.ts plan --chains=XDC --addresses=0x.. --from=N --to=N   # reads no chain, writes nothing
```

Do not run `daily`, `backfill`, `verify`, `coverage`, `repair`, `dedup` or `calibrate` against
production until the schema is commissioned and a writer identity exists. Mode reference:
[`pipeline-v5/README.md`](pipeline-v5/README.md).

### Inspect the prepared L1 migration (plan-only)

```powershell
.\scripts\deploy-warehouse.ps1 -Migration 09_CreateRawLogs_v1.sql
```

This only prints the selected target. Validate migrations in a labelled sandbox first. Production
execution requires separate approval, an explicit allowlisted migration, and service-account
impersonation; see [`03_OPERATIONS.md`](docs/03_OPERATIONS.md).

---

## Documentation

| Document | Purpose |
|---|---|
| [`START_HERE.md`](docs/START_HERE.md) | **Read first.** Current status, data flow, raw design, readers, safety controls, next steps, vocabulary |
| [`pipeline-v5/README.md`](pipeline-v5/README.md) | Pipeline modes, bookkeeping tables, failure handling |
| [`03_OPERATIONS.md`](docs/03_OPERATIONS.md) | How to run everything (setup, migrations, dbt) |
| [`release-scope.md`](docs/release-scope.md) | Which chains the release covers, and why |
| [`02_DATA_MODEL.md`](docs/02_DATA_MODEL.md) | Column-level reference for the older raw tables and the Semantic/Marts models |
| [`01_ARCHITECTURE.md`](docs/01_ARCHITECTURE.md) | Layer responsibilities and naming. Raw-layer section and contract-adding steps are outdated |
| [`00_VISION.md`](docs/00_VISION.md) | Historical MVP-era motivation; not current architecture or status |
| [`04_CONTRACT_MECHANICS.md`](docs/04_CONTRACT_MECHANICS.md) | How GoodDollar smart contracts work and what events they emit |
| [`05_ANALYTICS_DOCUMENTATION_CONTRACT.md`](docs/05_ANALYTICS_DOCUMENTATION_CONTRACT.md) | Required docs/tests/AI-readiness gates for new models |
| [`06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md`](docs/06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md) | Business term definitions and AI clarification protocol |

---

## Tech Stack

- **Ingestion:** TypeScript, Envio HyperSync, JSON-RPC
- **Warehouse:** dbt Core, Google BigQuery
- **Dashboards:** Google Looker Studio
- **Infrastructure:** GCP project `gooddollar`
- **Release scope:** Celo, XDC, Ethereum (no production ingestion yet; dashboards use older XDC data)

---

*Docs current as of 2026-10-05 -- onchain-analytics@c34c4c1.*
