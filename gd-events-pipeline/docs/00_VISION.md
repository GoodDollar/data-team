# Vision: GoodDollar Onchain Analytics Platform

## The problem

Today's analytics setup is a Google Apps Script glued to a Google Sheet. Every new question requires a custom scraper or a manual export. We can't cross-reference invite signups with claim activity. We can't cohort users by retention. We can't run a simple "how many invitees who signed up in March made it to 3 claims" query without writing code.

## The vision

A single onchain analytics platform on BigQuery, structured in three layers, that lets the data team — and eventually an AI self-service skill — answer **any** question about GoodDollar onchain events without writing one-off code.

```
L0  Blockchain (XDC, Celo, Ethereum, …)
 ↓  HyperSync ingestion pipeline (TypeScript)
L1  BlockchainEvents.*    raw decoded events, immutable, one table per contract
 ↓
L2  Semantic.*            reusable business entities (signups, payouts, claims, lifecycles)
 ↓
L3  Marts.*               pre-aggregated, dashboard-ready datasets
 ↓
    Dashboards · charts · AI self-service skill
```

## Why three layers

- **L1 — universal vocabulary.** Every onchain event we care about, exactly as it was emitted. Add a new contract → L1 grows.
- **L2 — business meaning, defined once.** "What is a referral signup?" "What does a bounty payout look like?" Defined in L2, used everywhere downstream. No re-implementing the same CASE statement in 17 dashboard queries.
- **L3 — performance and shape for consumers.** Pre-aggregated rollups optimized for dashboard read latency. A new chart needs new shape → new mart. Logic stays in L2.

Each layer is **derivable from the layer below.** Lose L3 and you can rebuild it. Lose L2 and you can rebuild it. Only L1 is the source of truth — and L1 is always reproducible from chain.

## The MVP

The XDC invites campaign. We need to cross-join invite signups with UBI claim activity to show invitee progression through the 3-claim eligibility requirement and produce a 17-KPI mart plus a funnel chart. This is the perfect proof-of-concept because it is exactly the cross-domain question the current Apps Script setup can't answer easily.

If the MVP works — clean data, fast queries, easy to add new metrics — we will:

1. Add the rest of the GoodDollar contract surface (Identity, Faucet, NameService, Mento, GoodDollar ERC20, MessagePassingBridge, DAO Avatar/Controller).
2. Expand to all chains (Celo, XDC, Ethereum mainnet).
3. Build out richer L2 entities (user dim, retention cohorts, transfer flows).
4. Connect an AI skill on top so users can ask "how many users from the March cohort still claim weekly" in plain English.

## What this repo contains

- [`pipeline/`](../pipeline/) — the L1 ingestion code
- [`warehouse/`](../warehouse/) — all BigQuery DDL, L2 views, L3 marts as numbered SQL files
- [`docs/`](.) — reference documentation (this file, the architecture, the data model, operations)
- [`specs/`](../specs/) — implementation contracts and campaign requirements
- [`scripts/`](../scripts/) — CLI helpers for non-BigQuery-fluent operators
- [`contracts/`](../contracts/) — onchain reference data (addresses, ABIs)
- [`future/`](../future/) — work-in-progress that's not part of MVP scope

## What this MVP is *not*

- Not a streaming/realtime system. Daily batch is enough for the questions we have.
- Not multi-chain yet. XDC only for MVP. Celo and Ethereum come next.
- Not multi-contract yet. UBIScheme and the Invite contract only.
- Not an alerting system. Dashboards consume the marts; alerts come later.
- Not productionalized. Manual refresh after each ingest until we validate the architecture.
