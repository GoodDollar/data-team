# dbt adoption decisions (MVP baseline)

This document captures the architecture and operating decisions agreed in the
2026-06-22 clarification session. It is the source of truth for introducing dbt
into `gd-events-pipeline`.

---

## 1) Scope and ownership

### What stays outside dbt

- **L0 ingestion**: HyperSync/API extraction and raw writes to BigQuery stay in
  `pipeline/index.ts`.
- Raw onchain tables remain owned by the ingestion pipeline, not by dbt.

### What moves into dbt

- **L1 staging** models
- **L2 semantic** models
- **L3 marts** models

dbt owns transformation coordination after raw data lands.

---

## 2) Layer mapping for the new design

Use this naming going forward:

- **L0**: blockchain + raw ingested source tables
- **L1**: staging
- **L2**: semantic
- **L3**: marts

Current repo note: today, `warehouse/L1` is raw table DDL. In the dbt design,
raw becomes dbt `source()` declarations and L1 becomes true staging models.

---

## 3) Materialization policy

Default policy for this project:

| Layer | Default materialization | When to change |
|---|---|---|
| L1 staging | `view` | Promote specific heavy models to `table` if repeatedly expensive |
| L2 semantic | `view` | Promote hot paths to `table` or `incremental` when measured slow |
| L3 marts | `table` | Use `incremental` when volume/cost makes full rebuild inefficient |

### Additional rules

- `ephemeral` is allowed for tiny helper models not queried directly.
- Do not use `materialized_view` by default. Consider only when SQL limitations
  are acceptable and maintenance behavior is explicitly desired.
- Materialization changes require a quick benchmark note in PR description.

---

## 4) Orchestration and cadence

dbt does not replace ingestion scheduling.

Daily operation requires two ordered jobs:

1. Ingestion job (pipeline append)
2. dbt transformation job (`dbt build` or `dbt run`)

For MVP, keep manual/cron operation simple. Post-MVP can move to managed
orchestration.

---

## 5) dbt semantics (critical mental model)

- `source()` = existing raw tables created outside dbt
- `ref()` = dependency on another dbt model
- dbt models should primarily contain transformation logic (`SELECT ...`)
- Materialization config decides whether that logic builds a view/table/
  incremental relation

dbt does not invent business logic. Engineers define it.

dbt standardizes and automates the hard coordination problems around SQL
transformations (dependency ordering, lineage, tests, docs, and repeatable
builds).

---

## 6) MVP pilot conversion plan

Pilot objective: prove dbt parity on a narrow slice before full migration.

Recommended first slice:

- 1 L1 staging model
- 1 L2 semantic model (`claim_events` candidate)
- 1 L3 mart (`daily_claim_activity` candidate)

Execution mode:

- Build in a parallel target schema/dataset first
- Validate row counts and KPI parity against current warehouse outputs
- Cut over only after parity is proven

---

## 7) Dashboard tool note

Looker Studio is acceptable for MVP. Metabase is a valid candidate for future
self-serve analytics. Tool choice is decoupled from dbt adoption.

---

## 8) AI self-serve readiness (phase 3/4)

Design now for future AI query interfaces:

- stable semantic entities in L2
- strong naming conventions
- test coverage on critical KPIs
- rich model/column descriptions
- clear ownership of definitions

This is required for trustworthy natural-language analytics on top of the
warehouse.
