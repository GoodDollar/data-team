# GoodDollar Onchain Analytics System

A production analytics platform on BigQuery that answers any question about GoodDollar onchain activity — from raw blockchain events through business-ready dashboards. Built for the GoodDollar data team and leadership.

---

## System Architecture

The system is composed of five layers, each with a clear responsibility:

```
┌─────────────────────────────────────────────────────────────────┐
│                GoodDollar Onchain Analytics System               │
├─────────────────────────────────────────────────────────────────┤
│  Layer 5 │ Self-Service AI          [planned]                   │
│  Layer 4 │ Dashboards               Looker Studio / Metabase    │
│  Layer 3 │ Marts (L3)               Pre-aggregated, KPI-ready   │
│  Layer 2 │ Semantic Models (L2)     Business logic, defined once │
│  Layer 1 │ Staging (L1)             Normalized, filtered         │
│  Layer 0 │ Ingestion Pipeline       HyperSync → BigQuery raw     │
├─────────────────────────────────────────────────────────────────┤
│  Governance │ Documentation, glossary, contracts, tests          │
└─────────────────────────────────────────────────────────────────┘
```

### Layer 0 — Ingestion Pipeline

TypeScript application using [Envio HyperSync](https://docs.envio.dev/docs/HyperSync/overview) for high-throughput historical + live indexing of blockchain events into BigQuery raw tables (`gooddollar.BlockchainEvents.*`).

→ [`pipeline/`](pipeline/)

### Layers 1–3 — dbt Warehouse (Medallion Architecture)

Managed by [dbt Core](https://docs.getdbt.com/) on BigQuery:

| Layer | Dataset | What it does | Materialization |
|---|---|---|---|
| **Staging (L1)** | `Staging` | Normalizes raw events — lowercase addresses, type casting, filters out partial-day data | Views |
| **Semantic (L2)** | `Semantic` | Defines business entities exactly once — signups, payouts, claims, lifecycles | Views |
| **Marts (L3)** | `Marts` | Pre-aggregated tables shaped for dashboards — daily metrics, funnels, KPIs | Tables |

→ [`gd_dbt/`](gd_dbt/)

### Layer 4 — Dashboards

Google Looker Studio connected to L3 Marts. Future: Metabase for broader self-service.

### Layer 5 — Self-Service AI (planned)

AI analyst with governed access across all layers, grounded by the semantic layer, business glossary, and disambiguation protocol.

### Governance

Documentation contracts, business glossary, and AI-readiness gates that every model must pass before production.

→ [`docs/`](docs/)

---

## How It Works — The 2-Minute Version

### Data Flow (end to end)

```
Blockchain → Pipeline (L0) → BigQuery raw tables → dbt Staging (L1) → dbt Semantic (L2) → dbt Marts (L3) → Dashboards
```

1. **Pipeline ingests raw events** from the blockchain into BigQuery (`BlockchainEvents.*` tables). This is the only component that talks to the chain.
2. **dbt transforms everything above raw.** One command (`dbt run`) rebuilds Staging → Semantic → Marts in the correct order, automatically.
3. **Dashboards read from Marts only.** Pre-aggregated, tested, documented — what you see is what was defined in code.

### Who Owns What

| Concern | Where it lives | Key files |
|---|---|---|
| **Chain connection & event decoding** | Pipeline (TypeScript) | `pipeline/index.ts` |
| **Raw table schemas (DDL)** | `warehouse/L1/` | `01_ClaimContractEvents.sql`, etc. |
| **Data cleaning & normalization** | dbt Staging models (L1) | `gd_dbt/models/staging/` |
| **Business logic** (what is a signup, what is a payout) | dbt Semantic models (L2) | `gd_dbt/models/semantic/` |
| **Dashboard-ready metrics** (daily counts, funnels, KPIs) | dbt Marts (L3) | `gd_dbt/models/marts/` |
| **Tests & data quality** | dbt schema YAML + custom tests | `gd_dbt/models/*/_*.yml` |
| **Documentation** | dbt YAML (column/model descriptions) + `/docs` | Auto-published to [GitHub Pages](https://gooddollar.github.io/data-team/) |
| **Business glossary & term definitions** | `docs/06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md` | Single source of truth for "what does X mean" |

### Adding a New Contract / Event

Short version (full guide in [`01_ARCHITECTURE.md`](docs/01_ARCHITECTURE.md)):

1. Register the contract (ABI + config) in the pipeline
2. Create the L1 raw table DDL and declare it as a dbt source
3. Run the pipeline to backfill historical events
4. Add a dbt staging model (normalization) → optional semantic model (business logic) → optional mart (dashboard metrics)
5. Add glossary entries for any new terms

Each layer only reads from the layer directly below it. Logic flows up, never sideways.

### Operating the System

| Task | Command | When |
|---|---|---|
| Ingest new events from chain | `cd pipeline && npx tsx index.ts` | Daily / on-demand |
| Rebuild all warehouse layers | `cd gd_dbt && dbt run` | After ingestion |
| Run data quality tests | `cd gd_dbt && dbt test` | After any `dbt run` |
| Browse data catalog + lineage | Visit [gooddollar.github.io/data-team](https://gooddollar.github.io/data-team/) | Anytime |
| Add/modify a model | Edit SQL in `gd_dbt/models/`, run `dbt run --select model_name` | Development |

The pipeline and dbt are independent — the pipeline writes raw tables, dbt reads them. They run in sequence (ingest first, then transform), not as a single coupled process.

---

## What's Live

| Component | Status | Scope |
|---|---|---|
| Ingestion pipeline | ✅ Live | XDC chain — UBIScheme + Invite contracts |
| dbt warehouse (10 models) | ✅ Live | 2 staging, 5 semantic, 3 marts |
| Looker Studio dashboards | ✅ Live | Invite funnel, daily metrics, claim activity |
| Pipeline hardening | 🔄 Next | Idempotency, dedup, gap detection, scheduling |
| Multi-chain expansion | 📋 Planned | Celo, Ethereum |
| Self-service AI | 📋 Planned | Post-pipeline hardening |

---

## Repo Layout

| Path | What |
|---|---|
| [`gd_dbt/`](gd_dbt/) | dbt project — all warehouse models, tests, docs, macros |
| [`pipeline/`](pipeline/) | HyperSync ingestion pipeline (TypeScript) |
| [`warehouse/L1/`](warehouse/L1/) | Raw table DDL (pipeline-written tables, dbt *sources*) |
| [`scripts/`](scripts/) | L1 bootstrap script (`deploy-warehouse.ps1`) |
| [`contracts/`](contracts/) | ABI files, deployment block numbers, contract reference |
| [`docs/`](docs/) | System documentation, data model, operations guide, governance |

---

## Quick Start

### Prerequisites

- Node.js LTS (v20+)
- Google Cloud SDK (`gcloud`, `bq`)
- `gcloud auth application-default login` with BigQuery Job User + Data Editor on `gooddollar`
- Python 3.9+ with dbt-bigquery (`pip install dbt-bigquery`)

### Run the warehouse

```bash
cd gd_dbt
dbt run              # Build all: Staging → Semantic → Marts
dbt test             # Run schema + data-quality tests
dbt docs serve       # Browse lineage + docs at localhost:8080
```

### Run the pipeline

```bash
cd pipeline
cp .env.example .env  # Add your ENVIO_API_TOKEN
npm install
npx ts-node index.ts  # Ingest from chain → BigQuery raw tables
```

### Bootstrap L1 raw tables (first time only)

```powershell
.\scripts\deploy-warehouse.ps1
```

---

## Documentation

| Document | Purpose |
|---|---|
| [`00_VISION.md`](docs/00_VISION.md) | Why this system exists and where it's going |
| [`01_ARCHITECTURE.md`](docs/01_ARCHITECTURE.md) | Layer responsibilities, naming, how to add contracts |
| [`02_DATA_MODEL.md`](docs/02_DATA_MODEL.md) | Column-level reference for every table |
| [`03_OPERATIONS.md`](docs/03_OPERATIONS.md) | How to run everything (setup, ingest, build, test) |
| [`04_CONTRACT_MECHANICS.md`](docs/04_CONTRACT_MECHANICS.md) | How GoodDollar smart contracts work and what events they emit |
| [`05_ANALYTICS_DOCUMENTATION_CONTRACT.md`](docs/05_ANALYTICS_DOCUMENTATION_CONTRACT.md) | Required docs/tests/AI-readiness gates for new models |
| [`06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md`](docs/06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md) | Business term definitions and AI clarification protocol |

---

## Tech Stack

- **Ingestion:** TypeScript, Envio HyperSync
- **Warehouse:** dbt Core, Google BigQuery
- **Dashboards:** Google Looker Studio
- **Infrastructure:** GCP project `gooddollar`
- **Target chains:** XDC (live), Celo + Ethereum (planned)
