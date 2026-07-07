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

## Business Glossary

### Entities

| Term | Meaning | Source model |
|------|---------|-------------|
| **Wallet** | A blockchain address. Not guaranteed to equal one real human. | L1/L2 address columns |
| **Claimer** | Wallet that claimed UBI (emitted a `UBIClaimed` event). | `claim_events`, `claimer_activity` |
| **Active claimer** | Claimer with at least one claim in a specified time window. | `claim_events` |
| **Invitee** | Wallet that joined through the invite program as the invited participant. | `invite_signups`, `invitee_lifecycle` |
| **Inviter** | Wallet whose invite link brought another participant in. | `invite_signups`, `invite_payouts` |
| **Campaign signup** | Invite signup where the inviter is the contract address (no human inviter). | `invite_signups` |
| **Referral signup** | Invite signup where a real human wallet is the inviter. | `invite_signups` |
| **No-code signup** | Signup with zero-address inviter — joined to become an inviter, not tracked as invitee. | `invite_signups` |

### Invite Metrics

| Metric | Definition | Source |
|--------|-----------|--------|
| **Bounty paid** | Invitee completed onboarding requirements and payout was disbursed. | `invite_payouts`, `invitee_lifecycle` |
| **Invitee reward** | Fixed G$500 invitee portion of the bounty. | `invitee_amount_g` |
| **Inviter reward** | Human inviter portion (G$1000). Null for campaign payouts. | `inviter_amount_g` |
| **Met eligibility** | 3+ claims on invite network and 7+ days since signup. | `invitee_lifecycle`, funnel mart |
| **Invite conversion** | Ambiguous — specify which funnel stage (signup → first claim, → eligibility, → bounty paid). | `invite_funnel_snapshot` |

### Claim Metrics

| Metric | Definition | Source |
|--------|-----------|--------|
| **Daily claims** | Count of `UBIClaimed` events per date and network. | `daily_claim_activity` |
| **Daily unique claimers** | Distinct claimers per date. Same wallet counted once per day. | `daily_claim_activity` |
| **G$ claimed** | Human-readable amount (raw ÷ 100). | `claim_events.amount_g` |
| **Cumulative unique claimers** | Running sum of daily uniques — approximate, overcounts repeat claimers across days. | `daily_claim_activity` |

### Important Distinctions

- **Transaction** vs **Event** vs **Transfer**: One blockchain transaction (`tx_hash`) can emit multiple contract events and include token transfers. These produce different counts.
- **Conversion**: Always ask "which stage?" — signup-to-first-claim, signup-to-eligibility, and signup-to-bounty-paid are different numbers.
- **Users**: Ambiguous. Could mean claimers, invitees, active wallets, or unique wallets. Always specify.

> Full disambiguation protocol and AI operating rules: [`06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md`](https://github.com/GoodDollar/data-team/blob/master/projects/onchain-analytics/docs/06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md)

---

## Source Freshness

The HyperSync TypeScript pipeline ingests raw events into BigQuery. Source freshness is monitored:
- ⚠️ **Warn** after 36 hours without new data
- 🚨 **Error** after 72 hours without new data

## Links

- [GitHub Repository](https://github.com/gooddollar/data-team)
- [GoodDollar Protocol](https://www.gooddollar.org)

{% enddocs %}
