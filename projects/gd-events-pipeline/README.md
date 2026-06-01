# GoodDollar Onchain Analytics

A 3-layer onchain analytics platform on BigQuery. Built to replace the legacy Apps Script + Google Sheet setup with something that lets the data team — and eventually an AI self-service skill — answer **any** question about GoodDollar onchain events without writing one-off scrapers.

## The architecture

```
L0  Blockchain (XDC, Celo, Ethereum, …)
 ↓  HyperSync ingestion pipeline (TypeScript)
L1  BlockchainEvents.*    raw decoded events, immutable, one table per contract
 ↓  BigQuery views and scheduled tables
L2  Semantic.*            reusable business entities (signups, payouts, claims, lifecycles)
 ↓  BigQuery tables
L3  Marts.*               pre-aggregated, dashboard-ready datasets
 ↓
    Dashboards · charts · AI self-service skill
```

L1 is the universal vocabulary. L2 is where business logic lives once and is reused everywhere. L3 is where dashboards plug in. Each layer is derivable from the layer below — only L1 is the source of truth, and L1 is always reproducible from chain.

## MVP scope

The XDC invites campaign. Cross-joins invite signups with UBI claim activity to produce a 17-KPI metrics table and a 6-stage funnel chart. This is the proof-of-concept that validates the architecture; once it's working, we expand to all GoodDollar contracts and chains.

## Repo layout

| Path | Purpose |
|---|---|
| [`pipeline/`](pipeline/) | The L1 ingestion pipeline (TypeScript). Reads HyperSync, writes BigQuery. |
| [`warehouse/`](warehouse/) | All BigQuery DDL, L2 views, L3 marts as numbered `.sql` files. |
| [`docs/`](docs/) | Reference documentation: vision, architecture, data model, operations. |
| [`specs/`](specs/) | Implementation contracts. Master MVP spec lives here. |
| [`scripts/`](scripts/) | PowerShell helpers for non-BQ-fluent operators. |
| [`contracts/`](contracts/) | Onchain reference data — addresses, ABIs, deployment blocks. |
| [`future/`](future/) | Post-MVP work, kept around but explicitly out of MVP scope. |

## Where to start

| You are a... | Read first |
|---|---|
| **Coding agent executing the MVP** | [`specs/MVP_IMPLEMENTATION_SPEC.md`](specs/MVP_IMPLEMENTATION_SPEC.md) |
| **Operator running the pipeline / refreshing marts** | [`docs/03_OPERATIONS.md`](docs/03_OPERATIONS.md) |
| **Engineer wanting to understand the architecture** | [`docs/00_VISION.md`](docs/00_VISION.md) → [`docs/01_ARCHITECTURE.md`](docs/01_ARCHITECTURE.md) → [`docs/02_DATA_MODEL.md`](docs/02_DATA_MODEL.md) |
| **Analyst writing dashboard queries** | [`docs/02_DATA_MODEL.md`](docs/02_DATA_MODEL.md) (column reference) + [`warehouse/L3/`](warehouse/L3/) (mart shapes) |
| **Adding a new contract or event** | [`docs/01_ARCHITECTURE.md`](docs/01_ARCHITECTURE.md) §"How to add a new contract" |

## Status

**MVP** — XDC only, two contracts (UBIScheme, Invite), three events (UBIClaimed, InviteeJoined, InviterBounty), three L3 marts. See the [master spec](specs/MVP_IMPLEMENTATION_SPEC.md) for execution checklist.

**Post-MVP** — Celo + Ethereum, full GoodDollar contract surface, scheduled refresh, AI self-service skill on top.

## License & contribution

Internal. See the GoodDollar data team for access and contribution rules.
