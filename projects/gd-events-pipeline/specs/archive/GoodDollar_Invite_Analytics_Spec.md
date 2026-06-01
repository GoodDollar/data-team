# GoodDollar Invite Analytics — Implementation Specification
**Version:** 1.0  
**Scope:** L2 Semantic Entities + L3 Marts for Invite Campaign Analytics  
**Target System:** Google BigQuery  
**Audience:** Coding agent responsible for BigQuery implementation

---

## 1. Overview

This document specifies the complete implementation of the L2 semantic layer and L3 analytics marts for GoodDollar's invite campaign analytics. It is self-contained. The implementing agent does not need to make any design decisions — all decisions have been made here. Where an assumption is present, it is explicitly marked.

### Architecture Summary

```
L0: Blockchain (Fuse / Celo / XDC)
 ↓  [Hypersync ingestion pipeline]
L1: gooddollar.BlockchainEvents.*          ← raw decoded events, immutable
 ↓  [BigQuery views / scheduled queries]
L2: gooddollar.Semantic.*                  ← business meaning, reusable entities
 ↓  [BigQuery scheduled queries]
L3: gooddollar.Marts.*                     ← pre-aggregated, dashboard-ready
```

### What this document specifies

- Schema requirements for two L1 source tables (one existing, one new)
- Three L2 entity tables
- Three L3 mart tables
- Full SQL for every table
- Deployment order
- Scheduling configuration
- All business rules and definitions

---

## 2. L1 Source Table Requirements

These are prerequisites. The coding agent must verify these before proceeding to L2 implementation.

### 2.1 `gooddollar.BlockchainEvents.InviteContractEvents` (existing)

This table already exists. Two columns must be confirmed or added:

| Column | Type | Status | Notes |
|---|---|---|---|
| `network` | STRING | ✅ exists | Values: `'CELO'`, `'FUSE'`, `'XDC'` (uppercase) |
| `block_number` | INT64 | ✅ exists | Cast from INTEGER if needed |
| `block_timestamp` | TIMESTAMP | ⚠️ **MUST EXIST** | See note below |
| `tx_hash` | STRING | ✅ exists | Lowercase hex, `0x`-prefixed |
| `log_index` | INT64 | ⚠️ **MUST EXIST** | See note below |
| `contract_address` | STRING | ✅ exists | Lowercase hex |
| `event_name` | STRING | ✅ exists | `'InviteeJoined'` or `'InviterBounty'` |
| `inviter` | STRING | ✅ exists | Address. Zero address or contract address are sentinels (see §4) |
| `invitee` | STRING | ✅ exists | Address of the user |
| `bounty_paid` | STRING | ✅ exists | Stored as STRING — contains the total payout amount as a decimal string (in G$ wei, i.e. 2 decimal places) |
| `inviter_level` | STRING | ✅ exists | Numeric string, NULLABLE |
| `earned_level` | BOOLEAN | ✅ exists | Whether inviter earned a level-up |
| `ingested_at` | TIMESTAMP | ✅ exists | Pipeline ingestion time, not block time |

> **⚠️ CRITICAL — `block_timestamp`:** The current schema shows `ingested_at` but not `block_timestamp`. Every time-series analysis depends on when a block was mined, not when the pipeline ran. If the ingestion pipeline does not currently store `block_timestamp`, it **must be added** before L2 is implemented. This is a blocker. The pipeline engineer must resolve this and confirm the column exists before the coding agent proceeds.

> **⚠️ IMPORTANT — `log_index`:** A single transaction can emit multiple events. `tx_hash` alone is not a unique identifier for an event — `(tx_hash, log_index)` is the correct composite key. If the current pipeline does not store `log_index`, add it. For invite events specifically the risk of collision is low (one `InviteeJoined` per tx), but the absence of `log_index` will cause incorrect deduplication once claim events are ingested.

### 2.2 `gooddollar.BlockchainEvents.ClaimContractEvents` (new — must be created by pipeline)

This table does not yet exist. The ingestion pipeline must be configured to decode `UBIClaimed` events from the UBIScheme contracts on Fuse, Celo, and XDC, and write them to this schema.

**Source event (from ABI):**
```
UBIClaimed(address indexed claimer, uint256 amount)
```

**Required schema:**

| Column | Type | Source | Notes |
|---|---|---|---|
| `network` | STRING | pipeline | `'CELO'`, `'FUSE'`, or `'XDC'` (uppercase, match InviteContractEvents) |
| `chain_id` | INT64 | pipeline | Celo = 42220, Fuse = 122, XDC = 50 |
| `block_number` | INT64 | pipeline | |
| `block_timestamp` | TIMESTAMP | pipeline | **Required** |
| `tx_hash` | STRING | pipeline | Lowercase hex, `0x`-prefixed |
| `log_index` | INT64 | pipeline | Required for deduplication |
| `contract_address` | STRING | pipeline | Lowercase hex — the UBIScheme contract address for this network |
| `event_name` | STRING | pipeline | Always `'UBIClaimed'` — include for consistency with InviteContractEvents |
| `claimer` | STRING | event field | Lowercase hex wallet address |
| `amount` | NUMERIC | event field | G$ amount claimed in this event. **Store as NUMERIC, not STRING.** The raw uint256 from the contract is in G$ with 2 decimal places (G$ uses 2 decimals). Divide by 100 to get the G$ face value. |
| `ingested_at` | TIMESTAMP | pipeline | Pipeline ingestion time |

**UBIScheme contract addresses (for pipeline configuration):**

| Network | Chain ID | Contract Address |
|---|---|---|
| Fuse | 122 | `0xd253a5203817225e9768c05e5996d642fb96ba86` |
| Celo | 42220 | `0x43d72ff17701b2da814620735c39c620ce0ea4a1` |
| XDC | 50 | `0x22867567e2d80f2049200e25c6f31cb6ec2f0faf` |

> Note: UBIScheme is NOT deployed on Ethereum Mainnet. Only ingest Fuse, Celo, and XDC.

---

## 3. Contract Reference

### Invite Contract

> **Assumption:** The invite contract is only deployed on Celo. Evidence: all rows in `InviteContractEvents` show `network = 'CELO'`. If this is ever deployed on additional networks, the `INVITE_CONTRACT_ADDRESS` constant below must be updated per-network (see §4.1).

| Network | Contract Address |
|---|---|
| Celo | `0x36829d1cda92fff5782d5d48991620664fc857d3` |

**Sentinel addresses used in business logic:**

| Sentinel | Meaning |
|---|---|
| `0x0000000000000000000000000000000000000000` | Zero address — inviter field contains this when a user signs up without a referral code (becomes an inviter themselves) |
| `0x36829d1cda92fff5782d5d48991620664fc857d3` | Invite contract's own address — inviter field contains this when the invitee used the campaign invite code |

### UBIScheme Contract (Claim)

Addresses listed in §2.2 above.

---

## 4. Business Definitions

These are the canonical definitions that all L2 and L3 SQL implements. They must not be reimplemented anywhere else — downstream queries read L2 columns, never re-derive these from L1.

### 4.1 Signup Types (`signup_type`)

Every `InviteeJoined` event is classified into exactly one of three types based on the `inviter` field:

| `signup_type` value | Condition on `inviter` field | Business meaning |
|---|---|---|
| `'no_code'` | `inviter = '0x0000000000000000000000000000000000000000'` | User joined the invite program to generate their own invite code. They are becoming an **inviter**, not an invitee. |
| `'campaign'` | `inviter = '0x36829d1cda92fff5782d5d48991620664fc857d3'` | User signed up using the campaign invite code. They are an **invitee** with no specific human inviter. |
| `'referral'` | any other address | User signed up using another user's personal invite code. They are an **invitee** with a specific human inviter. |

> **Critical note on `no_code` signups:** These users appear as "invitee" in the raw event field naming, but in business reality they are signing up to *become* inviters. They are NOT part of the invite funnel. They are excluded from `invitee_lifecycle`.

### 4.2 Payout Origin (`payout_origin`)

Every `InviterBounty` event is classified into one of two types:

| `payout_origin` value | Condition | Meaning |
|---|---|---|
| `'referral'` | `inviter != contract_address` | Bounty for a referral code signup. G$1000 went to a human inviter, G$500 to the invitee. |
| `'campaign'` | `inviter = contract_address` | Bounty for a campaign code signup. G$500 went to the invitee. The G$1000 "inviter portion" returned to the contract (never left). |

### 4.3 Invitee Eligibility for Bounty

An invitee is eligible for a bounty when ALL of the following are true:
1. `signup_type IN ('referral', 'campaign')` — they joined as an invitee, not as a no-code signup
2. `total_claims_on_celo >= 3` — they have claimed at least 3 times on Celo **after** their signup date
3. At least 7 days have elapsed since their signup timestamp
4. `bounty_tx_hash IS NULL` — they have not yet been paid

> **Why Celo claims specifically:** The invite contract lives on Celo. When it triggers a bounty, it reads claim counts from the UBIScheme contract on Celo. Claims on Fuse or XDC are not visible to the invite contract and do not count toward eligibility. This is a blockchain constraint, not a design choice.

> **Why eligibility is NOT stored as a column in L2:** The condition "7 days elapsed since signup" changes value every day without any new blockchain event. Storing it would create a column that drifts with the calendar, requiring daily full-table rewrites. Instead, `signup_timestamp` and `total_claims_on_celo` are stored, and eligibility is computed at query time wherever needed. See L3 mart queries for examples.

### 4.4 Bounty Amounts

> **Assumption (must be verified with contract source):** Each `InviterBounty` event represents a single payout transaction. The `bounty_paid` field in L1 is believed to store the **total** amount disbursed in that transaction (inviter + invitee combined). This yields:
> - Referral bounty: G$1500 total (G$1000 to inviter + G$500 to invitee)
> - Campaign bounty: G$500 total (G$500 to invitee only)
>
> **If this assumption is wrong** (e.g. each event emits two rows, one per recipient), the `invite_payouts` SQL in §7.2 must be revised. Verify against contract source or a sample of raw events before deploying.

G$ uses **2 decimal places**. A raw value of `150000` = G$1500.00.

### 4.5 Claim Counting Rules

| Column | Definition |
|---|---|
| `total_claims_on_celo` | Count of distinct `UBIClaimed` events in `ClaimContractEvents` WHERE `network = 'CELO'` AND `claimer = invitee_address` AND `block_timestamp > signup_timestamp` |
| `total_claims_all_networks` | Count of distinct `UBIClaimed` events across ALL networks, same claimer and post-signup filter |

When a user presses "Claim" in the wallet, the app submits transactions to all active networks simultaneously. This means a single user action generates 3 `UBIClaimed` events (one per network) within seconds. `total_claims_all_networks` will therefore be approximately `total_claims_on_celo × 3` for most users who claim on all chains. Use `total_claims_on_celo` for all eligibility and funnel logic.

---

## 5. BigQuery Dataset Structure

```
gooddollar/
├── BlockchainEvents/              ← L1 (raw events, managed by pipeline)
│   ├── InviteContractEvents       ← exists
│   └── ClaimContractEvents        ← new, pipeline to create
│
├── Semantic/                      ← L2 (business entities, this spec)
│   ├── invite_signups             ← VIEW
│   ├── invite_payouts             ← VIEW
│   └── invitee_lifecycle          ← SCHEDULED TABLE (daily rebuild)
│
└── Marts/                         ← L3 (dashboard-ready, this spec)
    ├── daily_invite_metrics       ← SCHEDULED TABLE (daily rebuild)
    ├── invite_funnel_snapshot     ← SCHEDULED TABLE (daily rebuild)
    └── daily_claim_activity       ← SCHEDULED TABLE (daily rebuild)
```

> **Views vs Tables:** `invite_signups` and `invite_payouts` are implemented as views because they are simple single-source transforms with no expensive joins. They will always be fresh without any scheduling. `invitee_lifecycle` is implemented as a scheduled materialized table because it involves a multi-source JOIN across potentially millions of claim events — too expensive to run as a live view on every dashboard query.

---

## 6. L2 Entity Specifications

### 6.1 `Semantic.invite_signups`

**Type:** VIEW  
**Grain:** 1 row = 1 `InviteeJoined` event  
**Update pattern:** Append-only (view always reflects current L1 state)  
**Primary key:** `(network, tx_hash, log_index)`  
**Source:** `BlockchainEvents.InviteContractEvents` WHERE `event_name = 'InviteeJoined'`

**Purpose:** Canonically classifies every signup event with its business meaning. Centralizes the `signup_type` logic so no downstream query ever needs to re-implement the zero-address / contract-address CASE statement.

**Schema:**

| Column | Type | Source | Business definition |
|---|---|---|---|
| `network` | STRING | passthrough | Chain identifier |
| `chain_id` | INT64 | derived | Celo=42220, Fuse=122, XDC=50 |
| `block_number` | INT64 | passthrough | Block on source chain |
| `block_timestamp` | TIMESTAMP | passthrough | Time of the block — **primary time dimension** |
| `tx_hash` | STRING | passthrough | Lowercase hex |
| `log_index` | INT64 | passthrough | Position within tx |
| `user_address` | STRING | `LOWER(invitee)` | Wallet that signed up |
| `inviter_address` | STRING NULLABLE | `LOWER(inviter)`, NULL when `signup_type = 'no_code'` or `'campaign'` | Human inviter's wallet, NULL if none |
| `signup_type` | STRING | derived — see §4.1 | `'no_code'`, `'campaign'`, or `'referral'` |
| `inviter_level` | INT64 NULLABLE | `SAFE_CAST(inviter_level AS INT64)` | Inviter's tier at time of signup |
| `ingested_at` | TIMESTAMP | passthrough | Pipeline observability |

---

### 6.2 `Semantic.invite_payouts`

**Type:** VIEW  
**Grain:** 1 row = 1 `InviterBounty` event  
**Update pattern:** Append-only  
**Primary key:** `(network, tx_hash, log_index)`  
**Source:** `BlockchainEvents.InviteContractEvents` WHERE `event_name = 'InviterBounty'`

**Purpose:** Canonically classifies every payout event. Normalizes amount fields from STRING to NUMERIC and derives `payout_origin` so downstream queries never reference raw address fields to determine payment type.

**Schema:**

| Column | Type | Source | Business definition |
|---|---|---|---|
| `network` | STRING | passthrough | Chain identifier |
| `chain_id` | INT64 | derived | Celo=42220 (invite is Celo-only) |
| `block_number` | INT64 | passthrough | |
| `block_timestamp` | TIMESTAMP | passthrough | **Primary time dimension** |
| `tx_hash` | STRING | passthrough | Lowercase hex |
| `log_index` | INT64 | passthrough | |
| `invitee_address` | STRING | `LOWER(invitee)` | Recipient of G$500 |
| `inviter_address` | STRING NULLABLE | `LOWER(inviter)`, NULL when `payout_origin = 'campaign'` | Human inviter recipient of G$1000, NULL for campaign payouts |
| `payout_origin` | STRING | derived — see §4.2 | `'referral'` or `'campaign'` |
| `total_amount_g` | NUMERIC | `SAFE_CAST(bounty_paid AS NUMERIC) / 100` | Total G$ disbursed (face value with 2 decimals) |
| `invitee_amount_g` | NUMERIC | derived: always 500.00 (G$500) — see §4.4 assumption | G$ paid to invitee |
| `inviter_amount_g` | NUMERIC NULLABLE | derived: 1000.00 when `payout_origin = 'referral'`, NULL when campaign | G$ paid to human inviter |
| `inviter_level` | INT64 NULLABLE | `SAFE_CAST(inviter_level AS INT64)` | Inviter level at payout |
| `earned_level` | BOOLEAN | passthrough | Whether inviter leveled up |
| `ingested_at` | TIMESTAMP | passthrough | |

---

### 6.3 `Semantic.invitee_lifecycle`

**Type:** SCHEDULED TABLE (full rebuild daily)  
**Grain:** 1 row = 1 unique invitee wallet address (across all their invite events)  
**Update pattern:** Mutable state — rows are updated as new claims and payouts arrive  
**Primary key:** `invitee_address`  
**Sources:** `Semantic.invite_signups`, `BlockchainEvents.ClaimContractEvents`, `Semantic.invite_payouts`

**Purpose:** Tracks the complete funnel lifecycle of every invitee from signup through bounty receipt. This is the core entity for funnel analysis, conversion metrics, and retention. It joins across three source tables and centralizes all claim-counting logic.

**Scope restriction:** Only includes `signup_type IN ('referral', 'campaign')`. Users who signed up as `'no_code'` (future inviters) are NOT in this table — they are not invitees and have no funnel to track.

**Deduplication rule:** If the same `user_address` appears in `invite_signups` more than once with the same `signup_type` (duplicate event), keep only the earliest `block_timestamp` row. In practice this should not happen (the contract enforces one-time signup via identity verification), but the SQL handles it defensively.

**Schema:**

| Column | Type | Derived from | Business definition |
|---|---|---|---|
| `invitee_address` | STRING | `invite_signups.user_address` | Unique wallet of the invitee |
| `inviter_address` | STRING NULLABLE | `invite_signups.inviter_address` | Human inviter's wallet, NULL for campaign signups |
| `signup_type` | STRING | `invite_signups.signup_type` | `'referral'` or `'campaign'` |
| `signup_network` | STRING | `invite_signups.network` | Always `'CELO'` currently |
| `signup_tx_hash` | STRING | `invite_signups.tx_hash` | Traceability |
| `signup_timestamp` | TIMESTAMP | `invite_signups.block_timestamp` | When they joined — **funnel start** |
| `first_claim_timestamp` | TIMESTAMP NULLABLE | MIN of `ClaimContractEvents.block_timestamp` WHERE `network='CELO'` and post-signup | First Celo claim after signup |
| `latest_claim_timestamp` | TIMESTAMP NULLABLE | MAX of same | Most recent Celo claim |
| `total_claims_on_celo` | INT64 | COUNT of `ClaimContractEvents` rows WHERE `network='CELO'` and post-signup | Celo claim count — **eligibility input** |
| `total_claims_all_networks` | INT64 | COUNT across all networks post-signup | Full activity signal |
| `bounty_tx_hash` | STRING NULLABLE | `invite_payouts.tx_hash` | NULL = bounty not yet paid |
| `bounty_timestamp` | TIMESTAMP NULLABLE | `invite_payouts.block_timestamp` | When bounty was paid |
| `bounty_total_amount_g` | NUMERIC NULLABLE | `invite_payouts.total_amount_g` | G$ total paid out for this invitee |

**Computed fields (NOT stored — derived at query time in L3):**

The following are intentionally excluded from the table because they change with the passage of time or are trivially derivable:

- `days_since_signup`: Compute as `TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), signup_timestamp, DAY)`
- `is_eligible`: Compute as `total_claims_on_celo >= 3 AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), signup_timestamp, DAY) >= 7 AND bounty_tx_hash IS NULL`
- `has_claimed_once/twice/3x`: Compute as `total_claims_on_celo >= N`

---

## 7. SQL Implementation

### 7.1 Create Datasets (run once)

```sql
-- Run once via BigQuery console or API before creating any tables/views

-- L2 dataset
CREATE SCHEMA IF NOT EXISTS `gooddollar.Semantic`
  OPTIONS (location = 'US');  -- match region of BlockchainEvents dataset

-- L3 dataset  
CREATE SCHEMA IF NOT EXISTS `gooddollar.Marts`
  OPTIONS (location = 'US');
```

### 7.2 `Semantic.invite_signups` (VIEW)

```sql
CREATE OR REPLACE VIEW `gooddollar.Semantic.invite_signups` AS

WITH base AS (
  SELECT
    network,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    LOWER(invitee)  AS user_address,
    LOWER(inviter)  AS _raw_inviter,
    inviter_level,
    ingested_at
  FROM `gooddollar.BlockchainEvents.InviteContractEvents`
  WHERE event_name = 'InviteeJoined'
)

SELECT
  network,
  CASE network
    WHEN 'CELO' THEN 42220
    WHEN 'FUSE' THEN 122
    WHEN 'XDC'  THEN 50
    ELSE NULL
  END                                               AS chain_id,
  block_number,
  block_timestamp,
  tx_hash,
  log_index,
  user_address,

  -- inviter_address: NULL for no_code and campaign signups (no human inviter)
  CASE
    WHEN _raw_inviter = '0x0000000000000000000000000000000000000000' THEN NULL
    WHEN _raw_inviter = '0x36829d1cda92fff5782d5d48991620664fc857d3' THEN NULL
    ELSE _raw_inviter
  END                                               AS inviter_address,

  -- signup_type: canonical classification (see §4.1)
  CASE
    WHEN _raw_inviter = '0x0000000000000000000000000000000000000000'
      THEN 'no_code'
    WHEN _raw_inviter = '0x36829d1cda92fff5782d5d48991620664fc857d3'
      THEN 'campaign'
    ELSE 'referral'
  END                                               AS signup_type,

  SAFE_CAST(inviter_level AS INT64)                 AS inviter_level,
  ingested_at

FROM base;
```

### 7.3 `Semantic.invite_payouts` (VIEW)

```sql
CREATE OR REPLACE VIEW `gooddollar.Semantic.invite_payouts` AS

-- Assumption: bounty_paid is the total disbursed (inviter + invitee combined).
-- Referral payout = G$1500 total = raw value 150000
-- Campaign payout = G$500 total  = raw value  50000
-- If this assumption is incorrect, revise the invitee_amount_g and inviter_amount_g expressions.

WITH base AS (
  SELECT
    network,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    LOWER(invitee) AS invitee_address,
    LOWER(inviter) AS _raw_inviter,
    bounty_paid,
    inviter_level,
    earned_level,
    ingested_at
  FROM `gooddollar.BlockchainEvents.InviteContractEvents`
  WHERE event_name = 'InviterBounty'
)

SELECT
  network,
  CASE network
    WHEN 'CELO' THEN 42220
    WHEN 'FUSE' THEN 122
    WHEN 'XDC'  THEN 50
    ELSE NULL
  END                                                     AS chain_id,
  block_number,
  block_timestamp,
  tx_hash,
  log_index,
  invitee_address,

  -- inviter_address: NULL for campaign payouts (contract pays itself, no human inviter)
  CASE
    WHEN _raw_inviter = '0x36829d1cda92fff5782d5d48991620664fc857d3' THEN NULL
    ELSE _raw_inviter
  END                                                     AS inviter_address,

  -- payout_origin: canonical classification (see §4.2)
  CASE
    WHEN _raw_inviter = '0x36829d1cda92fff5782d5d48991620664fc857d3' THEN 'campaign'
    ELSE 'referral'
  END                                                     AS payout_origin,

  -- Amount fields: raw bounty_paid is decimal string in G$ centavos (2 decimals)
  SAFE_CAST(bounty_paid AS NUMERIC) / 100                 AS total_amount_g,

  -- G$500 goes to invitee in ALL payout types
  500.00                                                  AS invitee_amount_g,

  -- G$1000 goes to human inviter only on referral payouts
  CASE
    WHEN _raw_inviter = '0x36829d1cda92fff5782d5d48991620664fc857d3' THEN NULL
    ELSE 1000.00
  END                                                     AS inviter_amount_g,

  SAFE_CAST(inviter_level AS INT64)                       AS inviter_level,
  earned_level,
  ingested_at

FROM base;
```

### 7.4 `Semantic.invitee_lifecycle` (SCHEDULED TABLE)

This query runs on a schedule (see §8) and fully replaces the table on each run.

```sql
CREATE OR REPLACE TABLE `gooddollar.Semantic.invitee_lifecycle`
PARTITION BY DATE(signup_timestamp)
CLUSTER BY invitee_address
AS

-- Step 1: Get one canonical signup row per invitee.
-- Only invitees (referral + campaign), not no_code signups.
-- In case of duplicate rows for the same address, keep the earliest.
WITH invitee_signups AS (
  SELECT
    user_address          AS invitee_address,
    inviter_address,
    signup_type,
    network               AS signup_network,
    tx_hash               AS signup_tx_hash,
    block_timestamp       AS signup_timestamp,
    ROW_NUMBER() OVER (
      PARTITION BY user_address
      ORDER BY block_timestamp ASC
    ) AS rn
  FROM `gooddollar.Semantic.invite_signups`
  WHERE signup_type IN ('referral', 'campaign')
),

deduped_signups AS (
  SELECT * EXCEPT(rn)
  FROM invitee_signups
  WHERE rn = 1
),

-- Step 2: Aggregate claim activity on Celo for each invitee.
-- Only claims AFTER signup (claims before signup are unrelated to invite eligibility).
-- Claims are matched by wallet address across networks.
celo_claims AS (
  SELECT
    LOWER(c.claimer) AS claimer_address,
    MIN(c.block_timestamp)  AS first_claim_timestamp,
    MAX(c.block_timestamp)  AS latest_claim_timestamp,
    COUNT(*)                AS total_claims_on_celo
  FROM `gooddollar.BlockchainEvents.ClaimContractEvents` c
  INNER JOIN deduped_signups s
    ON LOWER(c.claimer) = s.invitee_address
  WHERE
    c.network = 'CELO'
    AND c.block_timestamp > s.signup_timestamp  -- only post-signup claims
  GROUP BY 1
),

-- Step 3: Count all-network claims for broader activity signal.
all_network_claims AS (
  SELECT
    LOWER(c.claimer) AS claimer_address,
    COUNT(*)         AS total_claims_all_networks
  FROM `gooddollar.BlockchainEvents.ClaimContractEvents` c
  INNER JOIN deduped_signups s
    ON LOWER(c.claimer) = s.invitee_address
  WHERE c.block_timestamp > s.signup_timestamp
  GROUP BY 1
),

-- Step 4: Get payout data for each invitee.
-- One invitee can receive at most one bounty payout.
invitee_payouts AS (
  SELECT
    invitee_address,
    tx_hash           AS bounty_tx_hash,
    block_timestamp   AS bounty_timestamp,
    total_amount_g    AS bounty_total_amount_g
  FROM `gooddollar.Semantic.invite_payouts`
)

-- Step 5: Assemble the final lifecycle table.
SELECT
  s.invitee_address,
  s.inviter_address,
  s.signup_type,
  s.signup_network,
  s.signup_tx_hash,
  s.signup_timestamp,

  cc.first_claim_timestamp,
  cc.latest_claim_timestamp,
  COALESCE(cc.total_claims_on_celo, 0)        AS total_claims_on_celo,
  COALESCE(anc.total_claims_all_networks, 0)   AS total_claims_all_networks,

  p.bounty_tx_hash,
  p.bounty_timestamp,
  p.bounty_total_amount_g

FROM deduped_signups s
LEFT JOIN celo_claims      cc  ON s.invitee_address = cc.claimer_address
LEFT JOIN all_network_claims anc ON s.invitee_address = anc.claimer_address
LEFT JOIN invitee_payouts  p   ON s.invitee_address = p.invitee_address;
```

---

## 8. L3 Mart Specifications and SQL

### 8.1 `Marts.daily_invite_metrics`

**Grain:** 1 row = 1 calendar date × 1 network  
**Purpose:** Answers all 17 of Meri's KPI metrics in both daily and cumulative form. Primary datasource for time-series dashboard charts.  
**Sources:** `Semantic.invite_signups`, `Semantic.invite_payouts`

```sql
CREATE OR REPLACE TABLE `gooddollar.Marts.daily_invite_metrics`
PARTITION BY metric_date
AS

WITH daily_signups AS (
  SELECT
    DATE(block_timestamp)   AS metric_date,
    network,
    COUNT(*)                AS total_signups,
    COUNTIF(signup_type = 'referral')  AS referral_signups,
    COUNTIF(signup_type = 'campaign')  AS campaign_signups,
    COUNTIF(signup_type = 'no_code')   AS no_code_signups,
    COUNT(DISTINCT CASE WHEN signup_type = 'no_code'   THEN user_address END) AS unique_inviters_joined,
    COUNT(DISTINCT CASE WHEN signup_type = 'referral'  THEN user_address END) AS unique_referral_invitees,
    COUNT(DISTINCT CASE WHEN signup_type = 'campaign'  THEN user_address END) AS unique_campaign_invitees
  FROM `gooddollar.Semantic.invite_signups`
  GROUP BY 1, 2
),

daily_payouts AS (
  SELECT
    DATE(block_timestamp)   AS metric_date,
    network,
    COUNT(*)                              AS total_bounties,
    COUNTIF(payout_origin = 'referral')   AS referral_bounties,
    COUNTIF(payout_origin = 'campaign')   AS campaign_bounties,
    SUM(total_amount_g)                   AS total_expenditure_g,
    SUM(invitee_amount_g)                 AS paid_to_invitees_g,
    SUM(COALESCE(inviter_amount_g, 0))    AS paid_to_inviters_g,
    -- "returned to campaign" = referral portion on campaign payouts = always 0 because
    -- campaign payouts never disburse the G$1000 inviter leg at all.
    -- The G$1000 never leaves the contract. This value is therefore:
    COUNTIF(payout_origin = 'campaign') * 1000.00  AS notional_campaign_retained_g,
    COUNT(DISTINCT invitee_address)                AS unique_invitees_paid,
    COUNT(DISTINCT CASE WHEN payout_origin = 'referral' THEN inviter_address END)
                                                   AS unique_inviters_paid
  FROM `gooddollar.Semantic.invite_payouts`
  GROUP BY 1, 2
),

-- Build a spine of all dates present in either source
date_spine AS (
  SELECT DISTINCT metric_date, network FROM daily_signups
  UNION DISTINCT
  SELECT DISTINCT metric_date, network FROM daily_payouts
)

SELECT
  d.metric_date,
  d.network,

  -- Daily signup metrics
  COALESCE(s.total_signups, 0)              AS daily_total_signups,
  COALESCE(s.referral_signups, 0)           AS daily_referral_signups,
  COALESCE(s.campaign_signups, 0)           AS daily_campaign_signups,
  COALESCE(s.no_code_signups, 0)            AS daily_no_code_signups,
  COALESCE(s.unique_inviters_joined, 0)     AS daily_unique_inviters_joined,
  COALESCE(s.unique_referral_invitees, 0)   AS daily_unique_referral_invitees,
  COALESCE(s.unique_campaign_invitees, 0)   AS daily_unique_campaign_invitees,

  -- Daily payout metrics
  COALESCE(p.total_bounties, 0)             AS daily_total_bounties,
  COALESCE(p.referral_bounties, 0)          AS daily_referral_bounties,
  COALESCE(p.campaign_bounties, 0)          AS daily_campaign_bounties,
  COALESCE(p.total_expenditure_g, 0)        AS daily_total_expenditure_g,
  COALESCE(p.paid_to_invitees_g, 0)         AS daily_paid_to_invitees_g,
  COALESCE(p.paid_to_inviters_g, 0)         AS daily_paid_to_inviters_g,
  COALESCE(p.notional_campaign_retained_g, 0) AS daily_notional_campaign_retained_g,
  COALESCE(p.unique_invitees_paid, 0)       AS daily_unique_invitees_paid,
  COALESCE(p.unique_inviters_paid, 0)       AS daily_unique_inviters_paid,

  -- Cumulative metrics (running totals from genesis to this date, per network)
  SUM(COALESCE(s.total_signups, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC)         AS cumulative_total_signups,
  SUM(COALESCE(s.referral_signups, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC)         AS cumulative_referral_signups,
  SUM(COALESCE(s.campaign_signups, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC)         AS cumulative_campaign_signups,
  SUM(COALESCE(s.no_code_signups, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC)         AS cumulative_no_code_signups,
  SUM(COALESCE(p.total_bounties, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC)         AS cumulative_total_bounties,
  SUM(COALESCE(p.total_expenditure_g, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC)         AS cumulative_total_expenditure_g,
  SUM(COALESCE(p.paid_to_invitees_g, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC)         AS cumulative_paid_to_invitees_g,
  SUM(COALESCE(p.paid_to_inviters_g, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC)         AS cumulative_paid_to_inviters_g

FROM date_spine d
LEFT JOIN daily_signups s USING (metric_date, network)
LEFT JOIN daily_payouts  p USING (metric_date, network)
ORDER BY d.metric_date, d.network;
```

### 8.2 `Marts.invite_funnel_snapshot`

**Grain:** 1 row = 1 funnel stage (the whole table is a single 6-row snapshot of the funnel)  
**Purpose:** The invite funnel chart. Shows how many invitees reached each stage. This is the primary deliverable for the CEO demo.  
**Source:** `Semantic.invitee_lifecycle`

```sql
CREATE OR REPLACE TABLE `gooddollar.Marts.invite_funnel_snapshot`
AS

-- Eligibility computed at query time (see §4.3 for why it is not stored)
WITH lifecycle_with_eligibility AS (
  SELECT
    *,
    CASE
      WHEN total_claims_on_celo >= 3
       AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), signup_timestamp, DAY) >= 7
       AND bounty_tx_hash IS NULL
      THEN TRUE
      ELSE FALSE
    END AS is_currently_eligible,

    CASE
      WHEN total_claims_on_celo >= 3
       AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), signup_timestamp, DAY) >= 7
      THEN TRUE
      ELSE FALSE
    END AS met_eligibility_criteria  -- includes already-paid users
  FROM `gooddollar.Semantic.invitee_lifecycle`
)

SELECT
  CURRENT_TIMESTAMP()               AS snapshot_timestamp,
  'invite_funnel'                   AS funnel_name,
  1                                 AS stage_order,
  'Signed Up as Invitee'            AS stage_label,
  COUNT(*)                          AS user_count,
  ROUND(COUNT(*) / COUNT(*) * 100, 2) AS pct_of_top
FROM lifecycle_with_eligibility

UNION ALL

SELECT
  CURRENT_TIMESTAMP(),
  'invite_funnel',
  2,
  'Claimed at Least Once (Celo)',
  COUNTIF(total_claims_on_celo >= 1),
  ROUND(COUNTIF(total_claims_on_celo >= 1) / COUNT(*) * 100, 2)
FROM lifecycle_with_eligibility

UNION ALL

SELECT
  CURRENT_TIMESTAMP(),
  'invite_funnel',
  3,
  'Claimed at Least Twice (Celo)',
  COUNTIF(total_claims_on_celo >= 2),
  ROUND(COUNTIF(total_claims_on_celo >= 2) / COUNT(*) * 100, 2)
FROM lifecycle_with_eligibility

UNION ALL

SELECT
  CURRENT_TIMESTAMP(),
  'invite_funnel',
  4,
  'Claimed 3+ Times (Celo)',
  COUNTIF(total_claims_on_celo >= 3),
  ROUND(COUNTIF(total_claims_on_celo >= 3) / COUNT(*) * 100, 2)
FROM lifecycle_with_eligibility

UNION ALL

SELECT
  CURRENT_TIMESTAMP(),
  'invite_funnel',
  5,
  'Met Eligibility Criteria (3 claims + 7 days)',
  COUNTIF(met_eligibility_criteria),
  ROUND(COUNTIF(met_eligibility_criteria) / COUNT(*) * 100, 2)
FROM lifecycle_with_eligibility

UNION ALL

SELECT
  CURRENT_TIMESTAMP(),
  'invite_funnel',
  6,
  'Bounty Paid',
  COUNTIF(bounty_tx_hash IS NOT NULL),
  ROUND(COUNTIF(bounty_tx_hash IS NOT NULL) / COUNT(*) * 100, 2)
FROM lifecycle_with_eligibility

ORDER BY stage_order;
```

### 8.3 `Marts.daily_claim_activity`

**Grain:** 1 row = 1 calendar date × 1 network  
**Purpose:** Daily claim volumes across all chains. Foundation for protocol-wide retention and activity monitoring. Not strictly required for the invite funnel MVP but adds significant value for the CEO demo with minimal additional work.  
**Source:** `BlockchainEvents.ClaimContractEvents`

```sql
CREATE OR REPLACE TABLE `gooddollar.Marts.daily_claim_activity`
PARTITION BY metric_date
AS

SELECT
  DATE(block_timestamp)                AS metric_date,
  network,
  COUNT(*)                             AS daily_claims,
  COUNT(DISTINCT LOWER(claimer))       AS daily_unique_claimers,
  SUM(amount / 100)                    AS daily_total_g_claimed,  -- convert from centavos
  AVG(amount / 100)                    AS avg_claim_amount_g,

  -- Cumulative running totals
  SUM(COUNT(*))
    OVER (PARTITION BY network ORDER BY DATE(block_timestamp))    AS cumulative_claims,
  SUM(COUNT(DISTINCT LOWER(claimer)))
    OVER (PARTITION BY network ORDER BY DATE(block_timestamp))    AS cumulative_claimers_approx,
    -- Note: cumulative_claimers_approx overcounts repeat claimers.
    -- True cumulative unique claimers requires a different approach (HLL sketch or full scan).
    -- This approximation is acceptable for trend visualization.
  SUM(SUM(amount / 100))
    OVER (PARTITION BY network ORDER BY DATE(block_timestamp))    AS cumulative_total_g_claimed

FROM `gooddollar.BlockchainEvents.ClaimContractEvents`
GROUP BY 1, 2
ORDER BY 1, 2;
```

---

## 9. Deployment Order

Execute in this exact sequence. Each step depends on the previous.

### Phase 0 — Verify Prerequisites (blocking)

Before writing any L2 or L3 SQL:

1. Confirm `block_timestamp` exists in `BlockchainEvents.InviteContractEvents`. If not, halt and fix the pipeline.
2. Confirm `log_index` exists in `BlockchainEvents.InviteContractEvents`. If not, add it (non-blocking if low-urgency, but flag as technical debt).
3. Confirm `BlockchainEvents.ClaimContractEvents` exists and contains `UBIClaimed` rows from Fuse, Celo, and XDC. If not, the pipeline engineer must deploy the claim ingestion before `invitee_lifecycle` and `invite_funnel_snapshot` can be built. `invite_signups`, `invite_payouts`, and `daily_invite_metrics` can still be built without claim data.

### Phase 1 — Create Datasets

```
Run §7.1 — CREATE SCHEMA for Semantic and Marts datasets
```

### Phase 2 — Build L2 Views (no claim data required)

```
Run §7.2 — invite_signups VIEW
Run §7.3 — invite_payouts VIEW
```

Validate:
```sql
-- Should return rows with signup_type in ('no_code', 'referral', 'campaign')
SELECT signup_type, COUNT(*) FROM `gooddollar.Semantic.invite_signups` GROUP BY 1;

-- Should return rows with payout_origin in ('referral', 'campaign')  
SELECT payout_origin, COUNT(*) FROM `gooddollar.Semantic.invite_payouts` GROUP BY 1;

-- Sanity check: every payout has a corresponding signup
SELECT COUNT(*) FROM `gooddollar.Semantic.invite_payouts` p
LEFT JOIN `gooddollar.Semantic.invite_signups` s
  ON p.invitee_address = s.user_address AND s.signup_type IN ('referral','campaign')
WHERE s.user_address IS NULL;  -- Should be 0 or very small
```

### Phase 3 — Build L3 Mart: daily_invite_metrics (no claim data required)

```
Run §8.1 — daily_invite_metrics TABLE
```

Validate:
```sql
-- Spot check: cumulative totals should be monotonically increasing
SELECT metric_date, network, cumulative_total_signups
FROM `gooddollar.Marts.daily_invite_metrics`
ORDER BY network, metric_date
LIMIT 20;
```

### Phase 4 — Build L2 Lifecycle Table (requires claim data)

```
Confirm ClaimContractEvents is populated, then:
Run §7.4 — invitee_lifecycle TABLE
```

Validate:
```sql
-- Row count should match distinct invitees in invite_signups (referral + campaign only)
SELECT COUNT(*) FROM `gooddollar.Semantic.invitee_lifecycle`;

-- Check claim distribution
SELECT total_claims_on_celo, COUNT(*) as invitees
FROM `gooddollar.Semantic.invitee_lifecycle`
GROUP BY 1 ORDER BY 1;

-- Check bounty linkage: all paid invitees should have a bounty_tx_hash
SELECT
  (SELECT COUNT(*) FROM `gooddollar.Semantic.invitee_lifecycle` WHERE bounty_tx_hash IS NOT NULL) AS lifecycle_paid,
  (SELECT COUNT(*) FROM `gooddollar.Semantic.invite_payouts`) AS total_payouts;
-- These should match (or be very close — small diff indicates data edge cases to investigate)
```

### Phase 5 — Build L3 Funnel Snapshot (requires lifecycle table)

```
Run §8.2 — invite_funnel_snapshot TABLE
Run §8.3 — daily_claim_activity TABLE
```

Validate funnel:
```sql
-- Funnel should be monotonically decreasing (each stage <= previous stage)
SELECT stage_order, stage_label, user_count, pct_of_top
FROM `gooddollar.Marts.invite_funnel_snapshot`
ORDER BY stage_order;
```

---

## 10. Scheduling Configuration

All scheduled queries run once per day after the L1 ingestion pipeline completes. If the pipeline runs at 03:00 UTC, schedule L2/L3 queries starting at 04:00 UTC with 15-minute stagger between dependent jobs.

| Query | Schedule | Depends on | Estimated runtime |
|---|---|---|---|
| `invite_signups` (view) | N/A — live view | InviteContractEvents | N/A |
| `invite_payouts` (view) | N/A — live view | InviteContractEvents | N/A |
| `invitee_lifecycle` | Daily 04:00 UTC | ClaimContractEvents, invite_signups, invite_payouts | ~1-5 min |
| `daily_invite_metrics` | Daily 04:00 UTC | invite_signups, invite_payouts | <1 min |
| `invite_funnel_snapshot` | Daily 04:15 UTC | invitee_lifecycle | <1 min |
| `daily_claim_activity` | Daily 04:00 UTC | ClaimContractEvents | <1 min |

In BigQuery, create scheduled queries via **BigQuery Studio → Scheduled Queries → Create**. Use `CREATE OR REPLACE TABLE` syntax (already in the SQL above). Set disposition to `WRITE_TRUNCATE` if using the BigQuery UI scheduler.

---

## 11. Assumptions and Open Questions

The following items require confirmation from the pipeline engineer or smart contract developer. The coding agent should implement based on the stated assumptions and flag these for verification.

| # | Assumption | Impact if wrong | Who to ask |
|---|---|---|---|
| A1 | `bounty_paid` in L1 stores the **total** disbursed per payout transaction (inviter + invitee combined) | `invite_payouts.total_amount_g`, `invitee_amount_g`, `inviter_amount_g` are wrong | Contract developer |
| A2 | The invite contract is only deployed on Celo | If deployed on other chains, the `INVITE_CONTRACT_ADDRESS` constant in `invite_signups` and `invite_payouts` SQL must be a per-network lookup rather than a hardcoded string | Protocol team |
| A3 | `block_timestamp` exists or will be added to both L1 tables | Entire system depends on it. Without it, no time-series is possible | Pipeline engineer |
| A4 | `log_index` exists or will be added to both L1 tables | Without it, events within the same tx cannot be uniquely identified | Pipeline engineer |
| A5 | G$ token uses 2 decimal places (divisor of 100 for face value) | Amount columns will show wrong values | Protocol team |
| A6 | A user can only appear once as an invitee (contract enforces this via identity check) | If not enforced, the deduplication in `invitee_lifecycle` (keep earliest signup) may hide legitimate multi-signup edge cases | Contract developer |
| A7 | Fuse network claim events should be included in `ClaimContractEvents` even though the invite contract is not on Fuse | Only matters for `total_claims_all_networks` — Celo-only counts (`total_claims_on_celo`) are unaffected | Product team |

---

## 12. What Is Intentionally Excluded From This Spec

The following are valid future additions but deliberately not in scope for the MVP:

- **`inviter_performance` mart** — Rankings of top inviters, inviter conversion rates. Derivable from `invite_signups` and `invite_payouts` with simple GROUP BY queries when the need is confirmed. Not a dedicated L2 entity.
- **`users_dim` table** — A thin identity layer tracking first_seen_at, active_networks per wallet. Useful once claim ingestion is live and cross-domain analysis is needed.
- **Cohort funnel** — The `invite_funnel_snapshot` above shows absolute counts. A cohort version (of invitees who signed up in week X, how many reached each stage by week X+N) requires a different mart structure. Add when the business asks for it.
- **Fraud detection views** — Inviters with suspiciously many invitees. Derivable from existing tables when needed.
- **Incremental updates** — All scheduled queries do full rebuilds. At current data volume this is fast and correct. Switch to incremental MERGE patterns only when rebuild runtime or cost becomes a real problem.
- **dbt** — Architecture is dbt-compatible (layered, modular, documented). Migration to dbt can happen without restructuring any tables — only the execution layer changes.
