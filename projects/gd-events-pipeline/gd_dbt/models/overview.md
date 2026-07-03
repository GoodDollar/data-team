{% docs __overview__ %}

# GoodDollar On-Chain Analytics

Auto-generated documentation for the GoodDollar dbt data warehouse — the source of truth for all on-chain analytics powering dashboards, reporting, and strategic decisions.

## Architecture

This project follows a **medallion architecture** with three layers:

| Layer | BigQuery Dataset | Purpose |
|-------|-----------------|---------|
| **Staging** | `gooddollar.Staging` | Minimal cleaning of raw blockchain events — lowercase addresses, type casting. No business logic. |
| **Semantic** | `gooddollar.Semantic` | Business entities and cross-domain joins. The canonical source for all downstream analytics. |
| **Marts** | `gooddollar.Marts` | Pre-aggregated, dashboard-ready tables. Optimized for BI tool queries (Looker). |

## Data Flow

```
Raw Sources (HyperSync Pipeline)
  └── BlockchainEvents.ClaimContractEvents
  └── BlockchainEvents.InviteContractEvents
        │
        ▼
Staging (views — clean, typed)
  └── claim_contract_events
  └── invite_contract_events
        │
        ▼
Semantic (views — business logic)
  ├── claim_events ──────────► claimer_activity
  ├── invite_signups ────┐
  ├── invite_payouts ────┼──► invitee_lifecycle
  └── claim_events ──────┘
        │
        ▼
Marts (tables — dashboard-ready)
  ├── daily_claim_activity
  ├── daily_invite_metrics
  └── invite_funnel_snapshot
```

## Key Domains

### UBI Claims
Tracks every G$ claim event across XDC, CELO, and Ethereum. Powers daily claim dashboards and claimer retention analysis.

### Invite Program
Tracks the full invite lifecycle: signup → claiming activity → eligibility → bounty payout → post-payout retention. Powers the invite funnel dashboard and program ROI analysis.

## Networks

GoodDollar operates across three blockchains:
- **XDC** — Primary network (majority of activity)
- **CELO** — Secondary network
- **Ethereum/Fuse** — Legacy network (minimal current activity)

## How to Use This Site

- **Left sidebar**: Browse models by project structure or database schema
- **Lineage graph**: Click the blue icon (bottom-right) on any model page to see its upstream/downstream dependencies
- **Expand lineage**: Click "Expand" in the lineage pane to see the full DAG from sources to marts
- **Column details**: Click any model to see column descriptions, tests, and SQL

## Source Freshness

The HyperSync TypeScript pipeline ingests raw events into BigQuery. Source freshness is monitored:
- ⚠️ **Warn** after 36 hours without new data
- 🚨 **Error** after 72 hours without new data

## Links

- [GitHub Repository](https://github.com/gooddollar/data-team)
- [GoodDollar Protocol](https://www.gooddollar.org)

{% enddocs %}
