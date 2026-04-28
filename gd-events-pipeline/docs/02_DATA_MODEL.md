# Data Model

The canonical reference for every entity in the warehouse. If a column or business rule is documented here, it is the truth. If something downstream contradicts this doc, the downstream is wrong.

For naming conventions, partitioning rules, and layer responsibilities see [`01_ARCHITECTURE.md`](01_ARCHITECTURE.md).

---

## L1 — `gooddollar.BlockchainEvents.*`

### Common columns (every L1 table)

| Column | Type | Source | Notes |
|---|---|---|---|
| `network` | STRING | pipeline | `'XDC'`, `'CELO'`, `'ETHEREUM'`. Uppercase. |
| `chain_id` | INT64 | pipeline | XDC=50, Celo=42220, Ethereum=1 |
| `block_number` | INT64 | block | |
| `block_hash` | STRING | block | Lowercase hex |
| `block_timestamp` | TIMESTAMP | block | UTC. **Primary time dimension for all analytics.** |
| `tx_hash` | STRING | tx | Lowercase hex |
| `tx_index` | INT64 | tx | Position within block |
| `tx_from` | STRING | tx | Lowercase hex |
| `tx_to` | STRING | tx | Lowercase hex |
| `tx_value` | STRING | tx | Native token in wei (uint256 → STRING for safety) |
| `tx_status` | INT64 | tx | `1` = success, `0` = reverted |
| `tx_nonce` | INT64 | tx | Sender nonce |
| `log_index` | INT64 | log | Position within block, **part of dedup key** |
| `contract_address` | STRING | log | Lowercase hex |
| `event_name` | STRING | derived | Solidity event name |
| `ingested_at` | TIMESTAMP | pipeline | When the row was written, NOT when the block was mined |

**Dedup key everywhere:** `(network, tx_hash, log_index)`.

---

### `BlockchainEvents.ClaimContractEvents`

**Source contract:** UBIScheme — emits `UBIClaimed(address indexed claimer, uint256 amount)` whenever a user claims their daily UBI.

**Networks (MVP):** XDC only. Celo and Ethereum come post-MVP.

**XDC contract address:** `0x22867567e2d80f2049200e25c6f31cb6ec2f0faf`
**XDC deployment block (firstBlock for backfill):** 95,249,624

**Event-specific columns (in addition to common columns):**

| Column | Type | Notes |
|---|---|---|
| `claimer` | STRING | Wallet that claimed UBI. Stored lowercase. |
| `amount` | STRING | uint256 raw value. G$ uses 2 decimal places — divide by 100 in L2 to get face value. |

**Partition:** `DATE(block_timestamp)`. **Cluster:** `network, claimer`.

---

### `BlockchainEvents.InviteContractEvents`

**Source contract:** GoodDollar Invite — emits two events:
- `InviteeJoined(address indexed inviter, address indexed invitee)` — fires every time a user joins the invite program.
- `InviterBounty(address indexed inviter, address indexed invitee, uint256 bountyPaid, uint256 inviterLevel, bool earnedLevel)` — fires when a bounty is paid out.

**Networks (MVP):** XDC only.

**XDC contract address:** `0x36829d1cda92fff5782d5d48991620664fc857d3`
**XDC deployment block (firstBlock for backfill):** 100,412,600

**Event-specific columns:**

| Column | Type | Used by | Notes |
|---|---|---|---|
| `inviter` | STRING | both events | Lowercase hex. Sentinel values described below. |
| `invitee` | STRING | both events | Lowercase hex. The user being invited (or joining as a future inviter). |
| `bounty_paid` | STRING | InviterBounty | uint256 raw — total disbursed in the payout (inviter portion + invitee portion). |
| `inviter_level` | STRING | InviterBounty | Inviter's tier at time of payout |
| `earned_level` | BOOL | InviterBounty | Whether this payout caused the inviter to level up |

**Sentinel values for `inviter`:**

| Value | Meaning |
|---|---|
| `0x0000000000000000000000000000000000000000` | "no_code" — user joined the invite program to *become* an inviter, has no human inviter |
| `LOWER(contract_address)` (the invite contract's own address on the chain) | "campaign" — user signed up using the campaign invite code, has no human inviter |
| any other address | "referral" — user signed up using another user's personal invite code |

**Partition:** `DATE(block_timestamp)`. **Cluster:** `network, invitee`.

---

## L2 — `gooddollar.Semantic.*`

### `Semantic.invite_signups` (VIEW)

**Purpose:** classifies every `InviteeJoined` event with its business meaning. The single source of truth for "what is a referral signup."

**Grain:** 1 row per `InviteeJoined` event.
**Source:** `BlockchainEvents.InviteContractEvents` WHERE `event_name = 'InviteeJoined'`.

| Column | Type | Derivation |
|---|---|---|
| `network` | STRING | passthrough |
| `chain_id` | INT64 | passthrough |
| `block_number` | INT64 | passthrough |
| `block_timestamp` | TIMESTAMP | passthrough |
| `tx_hash` | STRING | passthrough |
| `log_index` | INT64 | passthrough |
| `user_address` | STRING | `LOWER(invitee)` — the user who joined |
| `inviter_address` | STRING NULLABLE | NULL when `signup_type IN ('no_code', 'campaign')`, otherwise `LOWER(inviter)` |
| `signup_type` | STRING | `'no_code'` / `'campaign'` / `'referral'` — see business rules below |
| `inviter_level` | INT64 NULLABLE | `SAFE_CAST(inviter_level AS INT64)` |
| `ingested_at` | TIMESTAMP | passthrough |

**Business rules — signup_type classification:**

```
CASE
  WHEN LOWER(inviter) = '0x0000000000000000000000000000000000000000' THEN 'no_code'
  WHEN LOWER(inviter) = LOWER(contract_address)                     THEN 'campaign'
  ELSE 'referral'
END
```

The `LOWER(contract_address)` comparison makes the rule chain-agnostic — works for any deployment without hardcoded addresses.

---

### `Semantic.invite_payouts` (VIEW)

**Purpose:** classifies every `InviterBounty` event. Normalizes amounts to G$ face values.

**Grain:** 1 row per `InviterBounty` event.
**Source:** `BlockchainEvents.InviteContractEvents` WHERE `event_name = 'InviterBounty'`.

| Column | Type | Derivation |
|---|---|---|
| `network` | STRING | passthrough |
| `chain_id` | INT64 | passthrough |
| `block_number` | INT64 | passthrough |
| `block_timestamp` | TIMESTAMP | passthrough |
| `tx_hash` | STRING | passthrough |
| `log_index` | INT64 | passthrough |
| `invitee_address` | STRING | `LOWER(invitee)` |
| `inviter_address` | STRING NULLABLE | NULL when `payout_origin = 'campaign'`, otherwise `LOWER(inviter)` |
| `payout_origin` | STRING | `'referral'` or `'campaign'` |
| `total_amount_g` | BIGNUMERIC | `SAFE_CAST(bounty_paid AS BIGNUMERIC) / 100` |
| `invitee_amount_g` | BIGNUMERIC | always `500.00` (G$500 to invitee in both payout types) |
| `inviter_amount_g` | BIGNUMERIC NULLABLE | `1000.00` for referral payouts, NULL for campaign payouts (the G$1000 inviter portion never leaves the contract on campaign payouts) |
| `inviter_level` | INT64 NULLABLE | `SAFE_CAST(inviter_level AS INT64)` |
| `earned_level` | BOOL | passthrough |
| `ingested_at` | TIMESTAMP | passthrough |

**Business rules — payout_origin classification:**

```
CASE
  WHEN LOWER(inviter) = LOWER(contract_address) THEN 'campaign'
  ELSE 'referral'
END
```

**Bounty economics (verified against contract source — see assumption A1 in `specs/archive/GoodDollar_Invite_Analytics_Spec.md`):**
- Referral payout: G$1500 total disbursed = G$1000 to inviter + G$500 to invitee
- Campaign payout: G$500 total disbursed = G$500 to invitee. The G$1000 "inviter portion" is retained by the contract and never leaves.

---

### `Semantic.claim_events` (VIEW)

**Purpose:** normalized claim events. Lower-cases the claimer address and converts the raw uint256 amount to BIGNUMERIC G$. Every L3 query that touches claims goes through this view, never raw L1.

**Grain:** 1 row per `UBIClaimed` event.
**Source:** `BlockchainEvents.ClaimContractEvents`.

| Column | Type | Derivation |
|---|---|---|
| `network` | STRING | passthrough |
| `chain_id` | INT64 | passthrough |
| `block_number` | INT64 | passthrough |
| `block_timestamp` | TIMESTAMP | passthrough |
| `tx_hash` | STRING | passthrough |
| `log_index` | INT64 | passthrough |
| `contract_address` | STRING | passthrough |
| `claimer_address` | STRING | `LOWER(claimer)` |
| `amount_raw` | STRING | passthrough — uint256 raw, useful for traceability |
| `amount_g` | BIGNUMERIC | `SAFE_CAST(amount AS BIGNUMERIC) / 100` |
| `ingested_at` | TIMESTAMP | passthrough |

---

### `Semantic.claimer_activity` (VIEW)

**Purpose:** per-(claimer, network) rollup of claim history. Useful for retention, cohort, and engagement metrics without re-aggregating L1 every time.

**Grain:** 1 row per (claimer_address, network).
**Source:** `Semantic.claim_events`.

| Column | Type | Derivation |
|---|---|---|
| `claimer_address` | STRING | GROUP BY |
| `network` | STRING | GROUP BY |
| `chain_id` | INT64 | first non-null |
| `first_claim_timestamp` | TIMESTAMP | `MIN(block_timestamp)` |
| `latest_claim_timestamp` | TIMESTAMP | `MAX(block_timestamp)` |
| `total_claims` | INT64 | `COUNT(*)` |
| `total_amount_g` | BIGNUMERIC | `SUM(amount_g)` |
| `active_days` | INT64 | `COUNT(DISTINCT DATE(block_timestamp))` |

---

### `Semantic.invitee_lifecycle` (VIEW)

**Purpose:** the cross-domain join. For each invitee, joins their signup with their post-signup claim activity and any payout they've received. The core entity for funnel analysis.

**Grain:** 1 row per unique `invitee_address` (across all their invite events).
**Scope:** only invitees with `signup_type IN ('referral', 'campaign')`. `no_code` signups are excluded (they are joining as inviters, not invitees).
**Sources:** `Semantic.invite_signups`, `Semantic.claim_events`, `Semantic.invite_payouts`.

| Column | Type | Derivation |
|---|---|---|
| `invitee_address` | STRING | from `invite_signups.user_address` |
| `inviter_address` | STRING NULLABLE | from `invite_signups.inviter_address` |
| `signup_type` | STRING | from `invite_signups.signup_type` |
| `signup_network` | STRING | from `invite_signups.network` |
| `signup_chain_id` | INT64 | from `invite_signups.chain_id` |
| `signup_tx_hash` | STRING | from `invite_signups.tx_hash` |
| `signup_timestamp` | TIMESTAMP | from `invite_signups.block_timestamp` — **funnel start** |
| `first_claim_timestamp` | TIMESTAMP NULLABLE | MIN of `claim_events.block_timestamp` WHERE same network as signup AND post-signup |
| `latest_claim_timestamp` | TIMESTAMP NULLABLE | MAX of same |
| `total_claims_on_invite_network` | INT64 | COUNT of `claim_events` rows WHERE same network as signup AND post-signup. **The eligibility-relevant claim count.** |
| `total_claims_all_networks` | INT64 | COUNT across all networks (broader activity signal) |
| `bounty_tx_hash` | STRING NULLABLE | from `invite_payouts.tx_hash` — NULL = bounty not yet paid |
| `bounty_timestamp` | TIMESTAMP NULLABLE | from `invite_payouts.block_timestamp` |
| `bounty_total_amount_g` | BIGNUMERIC NULLABLE | from `invite_payouts.total_amount_g` |

**Computed at query time, NOT stored** (because they drift with calendar time):
- `days_since_signup` = `TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), signup_timestamp, DAY)`
- `is_eligible` = `total_claims_on_invite_network >= 3 AND days_since_signup >= 7 AND bounty_tx_hash IS NULL`
- `met_eligibility_criteria` = `total_claims_on_invite_network >= 3 AND days_since_signup >= 7` (includes already-paid invitees)

**Business rules:**
- "Same network as signup" matters because the invite contract on each chain reads claim state only from the same chain's UBIScheme. Eligibility is chain-local.
- "Post-signup" means `claim.block_timestamp > signup.block_timestamp`. Claims before signup are unrelated to invite eligibility.
- Deduplication: if the same wallet appears as invitee in multiple `InviteeJoined` events (which the contract should prevent), keep the earliest signup row.

---

## L3 — `gooddollar.Marts.*`

### `Marts.daily_invite_metrics` (TABLE)

**Purpose:** the canonical daily KPI table for the invite campaign. Sourced entirely from `Semantic.invite_signups` and `Semantic.invite_payouts`.

**Grain:** 1 row per (`metric_date`, `network`).
**Refresh:** daily, full rebuild via `CREATE OR REPLACE TABLE`.
**Partition:** `metric_date`. **Cluster:** `network`.

**16 daily metrics + 8 cumulative + 2 dimensions = 26 columns total.** See [`warehouse/L3/02_daily_invite_metrics.sql`](../warehouse/L3/02_daily_invite_metrics.sql) for the full column list.

Daily metrics cover:
- Signups by type (total, referral, campaign, no_code)
- Unique inviters joined, unique invitees by type
- Bounty counts by origin (total, referral, campaign)
- G$ distributed (total, to invitees, to inviters, notional retained)
- Unique paid invitees and inviters

Cumulative metrics: running totals for the same dimensions per network.

---

### `Marts.invite_funnel_snapshot` (TABLE)

**Purpose:** point-in-time funnel chart. The CEO demo deliverable.

**Grain:** 6 rows total — one per funnel stage. Whole table is a single snapshot, rebuilt daily.
**Refresh:** daily, full rebuild.
**Source:** `Semantic.invitee_lifecycle`.

**Stages (in order):**
1. Signed Up as Invitee
2. Claimed at Least Once (Invite Chain)
3. Claimed at Least Twice (Invite Chain)
4. Claimed 3+ Times (Invite Chain)
5. Met Eligibility Criteria (3 claims + 7 days)
6. Bounty Paid

Each row has `stage_order`, `stage_label`, `user_count`, `pct_of_top` (percentage of stage 1).

Eligibility (stages 5 and 6) is **computed at query time** using `CURRENT_TIMESTAMP()` so the funnel is always accurate to today.

---

### `Marts.daily_claim_activity` (TABLE)

**Purpose:** daily UBI claim volume across networks. Foundation for protocol-wide retention and engagement metrics.

**Grain:** 1 row per (`metric_date`, `network`).
**Refresh:** daily, full rebuild.
**Source:** `Semantic.claim_events` (NOT raw L1).

| Column | Type | Notes |
|---|---|---|
| `metric_date` | DATE | `DATE(block_timestamp)` |
| `network` | STRING | |
| `daily_claims` | INT64 | |
| `daily_unique_claimers` | INT64 | |
| `daily_total_g_claimed` | BIGNUMERIC | |
| `avg_claim_amount_g` | BIGNUMERIC | |
| `cumulative_claims` | INT64 | running sum per network |
| `cumulative_unique_claimers_approx` | INT64 | running sum of daily uniques — *overcounts repeat claimers, label clearly as approximate* |
| `cumulative_total_g_claimed` | BIGNUMERIC | running sum |
