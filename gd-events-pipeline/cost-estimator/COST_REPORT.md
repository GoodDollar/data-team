# GoodDollar Data Pipeline — Cost Estimate Report

**Date:** May 4, 2026
**Prepared by:** Data Team
**Scope:** Full production cost estimate across all GoodDollar contracts (Celo, XDC, Ethereum — Fuse excluded)

---

## Executive Summary

The data pipeline is **very affordable to run.** At full production scale — ingesting all contracts across all chains — the projected monthly cost is approximately **$1/month**, growing to no more than **$8–10/month after one year** as data accumulates. There is no significant cost barrier to scaling.

| Cost item | One-time | Monthly (now) | Monthly (end of year 1) |
|---|---|---|---|
| Loading historical data (backfill) | **$0** | — | — |
| Storage (BigQuery) | — | **$0.81** | **~$1.40** |
| Daily dashboard queries | — | **$0.00** | **$0.00** |
| Data ingestion pipeline (Envio) | — | *plan-dependent* | *plan-dependent* |
| **Total (excl. Envio)** | **$0** | **~$1** | **~$1–2** |

The one external variable is Envio HyperSync — our blockchain data provider. Their pricing is plan-based and should be confirmed separately. Everything else runs on Google BigQuery, which is billed purely on what you store and query.

---

## How the system is charged

Before looking at numbers, it helps to understand the two independent ways Google BigQuery charges us. They are completely separate.

### 1. Storage — charged by how much data we keep

BigQuery charges per gigabyte of data stored per month:
- **$0.02/GB/month** for data written in the last 90 days
- **$0.01/GB/month** after 90 days (BigQuery automatically drops the rate)

This is charged on the raw size of rows sitting in L1 tables. The semantic layer (L2) and marts (L3) are either views or small aggregation tables and add negligible storage cost.

### 2. Queries — charged by how much data is read

BigQuery charges **$6.25 per terabyte (TB) of data scanned** when a SQL query runs. The first **1 TB per month is free**.

This is the cost most people expect to be the main one — and is where architecture decisions matter a lot. Our design avoids expensive full-table scans through two mechanisms:

**Partition pruning:** L1 tables are split (partitioned) by calendar day. When a daily update query runs, BigQuery reads only that day's slice — typically a few megabytes — rather than the entire table spanning years of history. This is the architectural decision that keeps query costs at or near zero.

**Incremental append pattern for marts:** Most of our daily reporting tables (L3) are designed to add only the new day's data rather than recompute everything from scratch. A mart that produces daily summaries appends one new row per day — scanning only the latest day's partition — instead of re-reading all historical data each time.

One mart — `invite_funnel_snapshot` — is an exception. It is a full point-in-time snapshot of all invitees and must recompute every day, scanning the full invite and claims history. This is by design and correct behaviour for a snapshot table. Even so, the invite data is a small fraction of total data, keeping its cost negligible.

---

## What we scanned

The estimator queried all 28 deployed GoodDollar contracts across three chains via Envio HyperSync. It counted events emitted over the last 7 days to establish a current daily rate, then extrapolated backward to estimate total historical volume.

| Contract group | Chains | Daily events (live) | Estimated historical total |
|---|---|---|---|
| G$ Token (ERC20 / SuperGoodDollar) | Celo, XDC, Ethereum | ~37,400 | ~38M |
| UBIScheme (daily UBI claims) | Celo, XDC | ~16,600 | ~11.6M |
| Faucet | Celo, XDC | ~5,300 | ~7.4M |
| Identity (user whitelisting) | Celo, XDC | ~1,000 | ~700k |
| Invite contract | XDC | ~55 | ~9k |
| Bridge, DAO, Mento, Utility | Various | ~100 | ~30k |
| **Total** | | **~60,400/day** | **~58M (estimated)** |

> **Note on historical accuracy:** The 58M figure uses the "quick" estimation method — current daily rate multiplied by days since contract deployment. Because GoodDollar has grown over time, today's rate is higher than historical average, so this number is likely an overestimate. A full scan (streaming all logs from deployment to today, which takes ~30–90 minutes) would produce the exact figure. The current estimate is intentionally conservative and suitable for financial planning.

---

## Storage cost breakdown

At 700 bytes per stored row on average (20 standard columns plus event-specific fields):

| Metric | Value |
|---|---|
| Estimated historical data size | 40.6 GB |
| Daily new data ingested | 42.3 MB/day |
| Monthly new data | ~1.27 GB/month |
| Storage cost today | $0.81/month |
| Storage cost in 12 months (cumulative) | ~$7.16 total paid over the year |

Storage costs grow slowly and linearly. Even after adding Celo's full 4-year history in backfill, the total dataset would likely be in the 15–25 GB range (the quick-mode estimate of 40 GB is conservative), costing under $0.50/month.

---

## Query cost breakdown

| Metric | Value |
|---|---|
| Daily data scanned by all mart rebuilds | 10.3 GB |
| Monthly total scanned | 0.31 TB |
| BigQuery free tier | 1 TB/month |
| Billable scan | **$0.00** (comfortably within free tier) |

The monthly scan of 0.31 TB is well under the 1 TB/month that BigQuery includes free for every account. We would need to add approximately three times the current number of marts scanning full-table data before any query cost appears on a bill.

The margin also provides headroom for:
- Analysts running ad-hoc queries in BigQuery
- Looker Studio dashboard refreshes (each widget refresh triggers a query)
- Expanding to additional contracts and chains

---

## The backfill question

Loading 4+ years of historical data from Celo is the most significant one-time operation. Here is how the cost works:

**Why it is $0:** BigQuery has two ways to insert data:

1. **Streaming inserts** — data arrives in real time, row by row, and is immediately queryable. Cost: $5.00/GB. For 40 GB of historical data this would be ~$200. **We do not use this for backfill.**

2. **Batch Load Jobs** — data is loaded from files in bulk. Cost: **$0.00**. BigQuery has always priced batch loads as free. This is what we use for backfill.

The pipeline's real-time ingestion currently uses streaming inserts, which is the correct and intended method for live data. For the one-time historical load, we switch to Load Jobs, which brings the cost to zero regardless of how many years of data we load.

---

## Scaling outlook

The following changes would affect costs, in order of impact:

| Change | Storage impact | Query impact |
|---|---|---|
| Add Celo 4-year backfill | +$0.20–0.40/month | None (backfill doesn't affect daily queries) |
| Enable Celo live ingestion | +$0.03/month | Negligible (stays within free tier) |
| Add new contract types (token transfers, governance) | Proportional to event volume | None if incremental pattern maintained |
| Materialize L2 views as tables | Small increase | Reduces downstream query cost |
| Add new L3 marts | Negligible | Negligible if incremental; +small if full-rebuild |

**The system would need to grow to roughly 160 GB of stored data and 3+ TB of monthly queries before a meaningful monthly bill appears.** At current growth rates that is multiple years away.

---

## Recommended next steps

1. **Run full historical scan** on UBIScheme and G$ Token contracts to establish precise backfill sizes before committing to that operation.
2. **Confirm Envio HyperSync plan cost** — this is the only cost not covered here.
3. **Switch daily mart rebuilds from `CREATE OR REPLACE TABLE` to `INSERT`** for additive marts — this is an architectural improvement already reflected in this model's query cost estimate, and should be implemented to match.
4. **Set a BigQuery budget alert** at $10/month — this gives early warning if query patterns change unexpectedly.

---

## Methodology notes

- **Tool:** Custom TypeScript estimator using Envio HyperSync API to count on-chain event logs directly from source. Source: `gd-events-pipeline/cost-estimator/estimate.ts`.
- **Historical estimate method:** Quick mode — 7-day event count divided by 7 gives daily rate; multiplied by days since contract deployment gives historical estimate. Likely overestimates by 20–50% due to user growth over time.
- **Row size assumption:** 700 bytes/row average (20 common columns + event-specific fields). Actual size varies by event type.
- **Query model:** Partition-aware. Additive mart scans modelled as 1 day of partition data. Full-rebuild mart (`invite_funnel_snapshot`) modelled as full projected table scan.
- **Pricing source:** Google BigQuery on-demand pricing as of mid-2025. Subject to change.
- **Fuse chain:** Excluded from all estimates. Not supported by Envio HyperSync and out of scope per team decision.
- **Mento contract addresses:** The official GoodDollar documentation lists the same address for four Mento contracts (Reserve, ExpansionController, ExchangeProvider, Broker) on both Celo and XDC. This appears to be a documentation error. The reported event counts for this group reflect all events at that shared address and should be verified before building production ingestion for these contracts.
