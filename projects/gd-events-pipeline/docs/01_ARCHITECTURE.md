# Architecture

## The three layers

| Layer | BigQuery dataset | Owns | Cadence | Storage type |
|---|---|---|---|---|
| **L1** | `gooddollar.BlockchainEvents` | Raw decoded onchain events, one table per contract | Continuous (daily backfill + append) | Tables, partitioned by `DATE(block_timestamp)`, clustered on natural key |
| **L2** | `gooddollar.Semantic` | Business-meaning entities reused across dashboards (signup classification, payout classification, lifecycle joins) | Live for views; daily for tables | **VIEWs**, managed by dbt |
| **L3** | `gooddollar.Marts` | Pre-aggregated, dashboard-ready datasets, one table per chart family | Daily rebuild | **TABLEs**, materialized by dbt |

> **Managed by dbt.** L2 (Semantic) and L3 (Marts) — plus a thin `Staging` layer between raw and
> Semantic — are built and tested by the dbt project in [`gd_dbt/`](../gd_dbt/). L1 raw tables are
> dbt *sources* (pipeline-written, not dbt-managed). See [`04_DBT_ADOPTION.md`](04_DBT_ADOPTION.md)
> and [`03_OPERATIONS.md`](03_OPERATIONS.md).

## Layer responsibilities (and what does *not* belong)

### L1 — `gooddollar.BlockchainEvents.*`

**Owns:** the raw, immutable record of "what happened on chain." Every column traces back to a specific event log on a specific block. No business interpretation — that is L2's job.

**Naming:** one table per contract, named after the contract: `ClaimContractEvents`, `InviteContractEvents`, etc. (PascalCase per existing convention.) When the same contract is deployed on multiple chains, all rows live in the same table with `network` and `chain_id` columns.

**Schema convention (common columns, every L1 table):**
- `network` (STRING — `'XDC'`, `'CELO'`, `'ETHEREUM'`)
- `chain_id` (INT64 — 50, 42220, 1)
- `block_number` (INT64), `block_hash` (STRING), `block_timestamp` (TIMESTAMP)
- `tx_hash` (STRING), `tx_index` (INT64)
- `tx_from` (STRING), `tx_to` (STRING), `tx_value` (STRING wei)
- `tx_status` (INT64), `tx_nonce` (INT64)
- `log_index` (INT64)
- `contract_address` (STRING — lowercased)
- `event_name` (STRING — Solidity event name)
- `ingested_at` (TIMESTAMP — pipeline write time, not block time)

**Plus event-specific columns** — one column per event field. Multiple event types in the same table use nullable columns for fields not relevant to all events.

**Dedup key:** `(network, tx_hash, log_index)`. Streaming inserts use this as `insertId` for natural deduplication within the BigQuery streaming window.

**uint256 storage:** **STRING** at L1. Casts to BIGNUMERIC happen in L2 (`SAFE_CAST(amount AS BIGNUMERIC) / 1e2 AS amount_g`). This avoids overflow and keeps L1 a faithful mirror of chain state.

**What does NOT belong in L1:** business rules, classifications, derived columns, joins. If the value isn't directly in the event log or transaction receipt, it does not go in L1.

### L2 — `gooddollar.Semantic.*`

**Owns:** the canonical business definitions. "What is a referral signup?" — exactly one CASE statement, in L2, that the rest of the warehouse reads from.

**Naming:** snake_case entities named after the business concept, not the source contract: `invite_signups`, `invite_payouts`, `claim_events`, `claimer_activity`, `invitee_lifecycle`. Datasets are named for the *meaning*, not the contract.

**Storage decision rule:**
- **VIEW** by default. Always fresh, no scheduling, no rebuild cost.
- **TABLE** only when join cost makes a view too slow for interactive queries (rule of thumb: > 5 second view query, or repeated joins across millions of rows in dashboards).
- For MVP everything in L2 is a VIEW. Promote to TABLE later if measured slow.

**Cross-domain joins live here.** `invitee_lifecycle` joins `invite_signups`, `claim_events`, and `invite_payouts`. This is the kind of work L2 exists for. Downstream queries should never reach across L1 tables themselves — they read the L2 entity that already did the join.

**What does NOT belong in L2:** dashboard-specific aggregations (those are L3), one-off filters, hardcoded chain or address constants beyond what's structurally necessary.

### L3 — `gooddollar.Marts.*`

**Owns:** the exact shape a dashboard needs. One mart per chart family.

**Naming:** snake_case, prefix by family: `daily_invite_metrics`, `invite_funnel_snapshot`, `daily_claim_activity`. The grain (daily, snapshot, monthly) is in the name.

**Storage:** all TABLEs, materialized by dbt (`materialized='table'`) — a full rebuild on each `dbt run`. Partition by `metric_date` (or whatever the time dimension is) to keep queries cheap.

**Cadence:** rebuilt on each `dbt run`. Currently manual; no daily job is set up yet.

**What does NOT belong in L3:** business definitions (those are in L2), reusable joins (also L2). If the same logic appears in two L3 marts, lift it into L2.

## Naming conventions

| Concept | Convention | Example |
|---|---|---|
| L1 dataset | PascalCase singular | `BlockchainEvents` |
| L1 table | PascalCase, contract name + `Events` | `ClaimContractEvents` |
| L2 dataset | PascalCase singular | `Semantic` |
| L2 entity | snake_case, business noun | `invite_signups`, `invitee_lifecycle` |
| L3 dataset | PascalCase plural | `Marts` |
| L3 mart | snake_case, time-prefix when applicable | `daily_invite_metrics` |
| Column | snake_case | `block_timestamp`, `signup_type` |
| Address columns | always lowercase hex with `0x` prefix; store as STRING; apply `LOWER()` in views | `0x6bd698566632bf2e81e2278f1656cb24aaf06d2e` |

## Partitioning + clustering rules

| Layer | Partition by | Cluster by |
|---|---|---|
| L1 | `DATE(block_timestamp)` | `network, <natural key>` (e.g. `claimer`, `invitee`) |
| L2 | N/A for views; if a TABLE, same as the L1 it derives from | same |
| L3 | `metric_date` (or whatever the time dimension is) | `network` |

## How to add a new contract

1. Create the contract/event registry entry required by [`05_ANALYTICS_DOCUMENTATION_CONTRACT.md`](05_ANALYTICS_DOCUMENTATION_CONTRACT.md).
2. Add an entry to `CONTRACT_CONFIGS` in [`pipeline/index.ts`](../pipeline/index.ts).
3. Create the L1 BigQuery table — a numbered SQL file in [`warehouse/L1/`](../warehouse/L1/) — and declare it as a dbt source in [`gd_dbt/models/staging/_sources.yml`](../gd_dbt/models/staging/_sources.yml).
4. Run `npx tsx index.ts backfill <contract_key>`.
5. Add a staging model in [`gd_dbt/models/staging/`](../gd_dbt/models/staging/), then (optional) a Semantic model in [`gd_dbt/models/semantic/`](../gd_dbt/models/semantic/) for the new contract's business semantics.
6. Add or update glossary entries in [`06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md`](06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md) for every user-facing entity, metric, or ambiguous term.
7. (Optional) Add a mart in [`gd_dbt/models/marts/`](../gd_dbt/models/marts/) for the dashboards that depend on it.

## How to add a new metric

If the metric can be derived from existing L2 entities → add a column or table to L3.
If the metric requires new business logic → add an L2 entity first, then a column/table in L3.
If the metric requires raw data not in L1 → add an event to the pipeline first.

Every user-facing metric must have a glossary entry and satisfy the metric contract in [`05_ANALYTICS_DOCUMENTATION_CONTRACT.md`](05_ANALYTICS_DOCUMENTATION_CONTRACT.md) before it is exposed to dashboards or AI self-service.

Logic flows up the layers, never sideways. This is the single rule that keeps the system coherent as it scales.
