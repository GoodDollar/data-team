# MVP Implementation Specification

**Audience:** A fresh coding agent (or human engineer) tasked with executing this MVP end-to-end.
**Scope:** Get the XDC invites campaign analytics live: pipeline ingest → L1 → L2 → L3 → demo-ready dashboards.
**Status:** Self-contained. Every decision pre-made. Execute as written; ask only if you discover a real conflict between this spec and reality.

---

## Goal

Stand up a working 3-layer onchain analytics platform on BigQuery for the GoodDollar XDC invites campaign. The MVP demonstrates a cross-domain join (invite signups × UBI claim activity) the existing Apps Script setup cannot do, by producing a 17-KPI metrics table and a 6-stage funnel chart sourced from L2 entities.

---

## Prerequisites

You will need:

- **Node.js LTS** (v20+). Verify with `node --version`.
- **Google Cloud SDK** (provides both `gcloud` and `bq` CLIs). Verify with `gcloud --version` and `bq --version`.
- **Application Default Credentials** authenticated to GCP project `gooddollar`:
  ```
  gcloud auth application-default login
  gcloud config set project gooddollar
  ```
- **BigQuery roles** on `gooddollar`: BigQuery Job User + BigQuery Data Editor.
- **HyperSync API token**: stored in `pipeline/.env` as `ENVIO_API_TOKEN=<token>`. Copy the example file:
  ```
  cp pipeline/.env.example pipeline/.env
  ```
  Then edit `pipeline/.env` and paste the real token. The token already exists; if it is missing, ask the user.
- **PowerShell 5.1+** (Windows) for the helper scripts. Linux/macOS can run the bare commands instead.

If any prerequisite is missing, stop and ask before proceeding.

---

## Inputs you will read before/during execution

- [`docs/00_VISION.md`](../docs/00_VISION.md) — the why
- [`docs/01_ARCHITECTURE.md`](../docs/01_ARCHITECTURE.md) — the layer model and naming rules
- [`docs/02_DATA_MODEL.md`](../docs/02_DATA_MODEL.md) — every entity, every column, every business rule (canonical)
- [`docs/03_OPERATIONS.md`](../docs/03_OPERATIONS.md) — operator-facing how-to
- [`contracts/README.md`](../contracts/README.md) — contract addresses, deployment blocks
- [`pipeline/index.ts`](../pipeline/index.ts) — the pipeline you will edit in Phase 1
- [`warehouse/L1/`, `L2/`, `L3/`](../warehouse/) — SQL files you will deploy verbatim

Do NOT consult the archived spec at [`specs/archive/GoodDollar_Invite_Analytics_Spec.md`](archive/GoodDollar_Invite_Analytics_Spec.md). It is preserved for history and contains a hardcoded contract address that is wrong for XDC. **This spec supersedes it.**

---

## Decisions Already Made (do not re-debate)

| Decision | Rationale |
|---|---|
| MVP is XDC only | Campaign is on XDC. Celo + Ethereum are post-MVP. |
| Drop gas columns from L1 (`tx_gas`, `tx_gas_price`, `tx_effective_gas_price`, `tx_gas_used`) | HyperSync v0.6.3 returns zeros for several. Not worth retaining at MVP. |
| Keep `tx_status`, `tx_nonce`, `tx_value`, `tx_to` | Cheap; useful when HyperSync upgrade populates them later. |
| Use `LOWER(contract_address)` in L2 to detect campaign signups (not a hardcoded address literal) | Chain-agnostic; works post-MVP when Celo + Ethereum are added without code changes. |
| Lifecycle as VIEW, not scheduled TABLE | Sub-second at MVP volume. Switch to TABLE only if measured slow. |
| `amount`/`bounty_paid` STRING at L1, BIGNUMERIC `amount_g`/`bounty_total_amount_g` at L2 | uint256 safety + analytics convenience. |
| Eligibility uses `c.network = s.signup_network` (chain-local) | Each chain's invite contract reads only that chain's UBIScheme. Future-proofs multi-chain. |
| `BATCH_SIZE = 1000`, **flush in fixed-size chunks during the loop** | Avoids the HTTP 413 on large recv batches. |
| L1, L2, L3 partition by date dimension; cluster on natural key | Standard, cheap, scales. |

If you discover a real-world reason any of these is wrong, stop and flag it. Otherwise proceed.

---

## Execution Phases

Each phase ends with a `git commit`. After all phases, push to GitHub and the user will hand the warehouse to dashboards.

### Phase 1 — Pipeline correctness fix

**Goal:** [`pipeline/index.ts`](../pipeline/index.ts) ingests UBIClaimed and Invite events on XDC into the new lean L1 schema with no errors.

Apply seven discrete edits. Run `npx tsc --noEmit` from inside `pipeline/` after each. All typecheck must remain clean.

#### Edit 1.1 — Fix the BATCH_SIZE flush bug (the cause of the HTTP 413)

Find this block (around line 387):

```ts
    if (pendingRows.length >= BATCH_SIZE) {
      await insertWithRetry(pendingRows, cfg.tableId);
      console.log(`[${network.name}] Inserted ${pendingRows.length} rows (total: ${totalDecoded})`);
      pendingRows = [];
    }
```

Replace with:

```ts
    while (pendingRows.length >= BATCH_SIZE) {
      const chunk = pendingRows.splice(0, BATCH_SIZE);
      await insertWithRetry(chunk, cfg.tableId);
      console.log(`[${network.name}] Inserted ${chunk.length} rows (total: ${totalDecoded})`);
    }
```

#### Edit 1.2 — Bump BATCH_SIZE 500 → 1000

Find (around line 312):

```ts
  const BATCH_SIZE = 500;
```

Replace with:

```ts
  const BATCH_SIZE = 1000;
```

#### Edit 1.3 — Drop gas fields from `TxContext` interface

Find the `TxContext` interface near the top of the file. Remove these four lines:

```ts
  gas: string;
  gasPrice: string;
  effectiveGasPrice: string;
  gasUsed: string;
```

Keep `from`, `to`, `value`, `status`, `nonce`.

#### Edit 1.4 — Drop the same fields from the `txCtx` constructor in `syncEvents`

Find the `txCtx` block (around line 359-369). Remove these four lines:

```ts
          gas:                tx?.gas?.toString()                ?? "0",
          gasPrice:           tx?.gasPrice?.toString()           ?? "0",
          effectiveGasPrice:  tx?.effectiveGasPrice?.toString()  ?? "0",
          gasUsed:            tx?.gasUsed?.toString()            ?? "0",
```

#### Edit 1.5 — Drop the same fields from the HyperSync `fieldSelection.transaction`

Find the `transaction` array (around line 291-302). Remove these four entries (keep `Hash`, `From`, `To`, `Value`, `Status`, `Nonce`):

```ts
        "Gas",
        "GasPrice",
        "EffectiveGasPrice",
        "GasUsed",
```

#### Edit 1.6 — Drop gas fields from both `decodeToRow` row shapes

In `CONTRACT_CONFIGS.claim.decodeToRow` (the row literal returned), remove these four properties:

```ts
      tx_gas:                 tx.gas,
      tx_gas_price:           tx.gasPrice,
      tx_effective_gas_price: tx.effectiveGasPrice,
      tx_gas_used:            tx.gasUsed,
```

Do the same in `CONTRACT_CONFIGS.invite.decodeToRow` if/when you bring it to schema parity in Edit 1.7 below.

#### Edit 1.7 — Update the `invite` config to match `claim` schema

The `invite` `decodeToRow` is currently the old narrow schema (no `block_timestamp`, `chain_id`, etc.). Bring it in line with the `claim` style — same common columns, plus the invite-specific `inviter`, `invitee`, `bounty_paid`, `inviter_level`, `earned_level`. Use the `claim` `decodeToRow` as a template; the column list must match the L1 InviteContractEvents DDL in [`warehouse/L1/02_InviteContractEvents.sql`](../warehouse/L1/02_InviteContractEvents.sql).

#### Edit 1.8 — Narrow `CONTRACT_CONFIGS` to XDC only

Inside `CONTRACT_CONFIGS.claim`:
- `contracts`: keep only the XDC address `0x22867567e2d80f2049200e25c6f31cb6ec2f0faf`. Comment out (don't delete) Celo + Fuse with `// MVP: XDC-only — re-enable post-MVP`.
- `networks`: keep only the XDC entry. Same comment marker on Celo + Fuse.

Inside `CONTRACT_CONFIGS.invite`:
- `contracts`: keep only the XDC address `0x36829d1cda92fff5782d5d48991620664fc857d3`. Comment out the Celo address.
- `networks`: keep only XDC. Comment out Celo.

#### Edit 1.9 — Tighten error logging in `insertWithRetry`

Find (around line 220):

```ts
      if (e.errors?.length > 0) {
        const firstRowErr = e.errors[0];
        console.error("  BQ rejection — first row errors:", JSON.stringify(firstRowErr.errors));
        console.error("  BQ rejection — first row data:  ", JSON.stringify(firstRowErr.row));
      }
```

Replace with:

```ts
      const firstRowErr = e.errors?.[0];
      if (firstRowErr?.errors?.length > 0) {
        console.error("  BQ rejection — first row errors:", JSON.stringify(firstRowErr.errors));
        console.error("  BQ rejection — first row data:  ", JSON.stringify(firstRowErr.row));
      }
```

This stops the noisy `undefined` lines that fire on transient (non-PartialFailure) errors.

#### Phase 1 verification

```
cd pipeline
npx tsc --noEmit
```

Expect: clean exit, no errors.

#### Phase 1 commit

```
git add pipeline/index.ts
git commit -m "pipeline: XDC-only MVP — drop gas cols, fix batch flush, lean error log, invite schema parity"
```

---

### Phase 2 — Create L1 BigQuery tables

**Goal:** Two empty L1 tables exist with the exact schema [`pipeline/index.ts`](../pipeline/index.ts) writes to.

#### Path A — `bq` CLI (recommended)

```
.\scripts\deploy-warehouse.ps1 L1
```

#### Path B — BQ console (if no `bq` CLI)

For each `.sql` file under `warehouse/L1/`, in numerical order:

1. Open <https://console.cloud.google.com/bigquery>
2. Confirm project selector (top of page) shows `gooddollar`
3. Click **+ Compose new query**
4. Open the `.sql` file in a text editor, copy the full contents, paste into the query editor
5. Click **Run**. Wait for "Query complete"
6. Verify the table appears in the left tree under `gooddollar > BlockchainEvents`

Files to run (in order): `01_ClaimContractEvents.sql`, `02_InviteContractEvents.sql`.

#### Phase 2 verification

```sql
-- In the BQ console, run:
SELECT table_name, ddl
FROM `gooddollar.BlockchainEvents.INFORMATION_SCHEMA.TABLES`
WHERE table_name IN ('ClaimContractEvents', 'InviteContractEvents');
```

Expect: two rows. The DDLs should match what's in `warehouse/L1/`.

#### Phase 2 commit

No code changes — skip the commit for this phase.

---

### Phase 3 — Backfill L1

**Goal:** L1 tables populated with full XDC history.

```
cd pipeline
npx tsx index.ts backfill claim
npx tsx index.ts backfill invite
```

Each takes a few minutes. If a backfill crashes, re-run the same command — `insertId`-based dedup makes retries safe.

#### Phase 3 verification

```sql
-- Row counts
SELECT COUNT(*) AS rows, MIN(block_timestamp) AS earliest, MAX(block_timestamp) AS latest
FROM `gooddollar.BlockchainEvents.ClaimContractEvents`;
-- Expect: rows > 0, earliest near contract deployment, latest within last day

SELECT event_name, COUNT(*) AS rows
FROM `gooddollar.BlockchainEvents.InviteContractEvents`
GROUP BY event_name;
-- Expect: at least one InviteeJoined row; InviterBounty may be 0 if no payouts yet

-- Dedup integrity
SELECT
  COUNT(*) AS total,
  COUNT(DISTINCT CONCAT(network,'|',tx_hash,'|',CAST(log_index AS STRING))) AS distinct_keys
FROM `gooddollar.BlockchainEvents.ClaimContractEvents`;
-- Expect: total == distinct_keys
```

#### Phase 3 commit

No code changes — skip.

---

### Phase 4 — Deploy L2 Semantic layer

**Goal:** Five views (`invite_signups`, `invite_payouts`, `claim_events`, `claimer_activity`, `invitee_lifecycle`) live in `gooddollar.Semantic`.

#### Path A — script

```
.\scripts\deploy-warehouse.ps1 L2
```

#### Path B — BQ console

Run each file under `warehouse/L2/` in numerical order: `01_create_dataset.sql`, `02_invite_signups.sql`, `03_invite_payouts.sql`, `04_claim_events.sql`, `05_claimer_activity.sql`, `06_invitee_lifecycle.sql`.

#### Phase 4 verification

```sql
-- Distribution by signup_type
SELECT signup_type, COUNT(*) AS n
FROM `gooddollar.Semantic.invite_signups`
GROUP BY signup_type;
-- Expect: at minimum 'campaign' and possibly 'referral' / 'no_code' rows

-- Lifecycle row count == deduped invitee count
SELECT
  (SELECT COUNT(*) FROM `gooddollar.Semantic.invitee_lifecycle`)                                                                          AS lifecycle_rows,
  (SELECT COUNT(DISTINCT user_address) FROM `gooddollar.Semantic.invite_signups` WHERE signup_type IN ('referral','campaign'))            AS expected;
-- Expect: equal

-- Spot check claim aggregation
SELECT total_claims_on_invite_network, COUNT(*) AS invitees
FROM `gooddollar.Semantic.invitee_lifecycle`
GROUP BY total_claims_on_invite_network
ORDER BY total_claims_on_invite_network;
-- Expect: a sensible distribution (most users 0-3 claims, fewer with more)
```

#### Phase 4 commit

No code changes — skip.

---

### Phase 5 — Deploy L3 Marts

**Goal:** Three mart tables (`daily_invite_metrics`, `invite_funnel_snapshot`, `daily_claim_activity`) populated.

#### Path A — script

```
.\scripts\deploy-warehouse.ps1 L3
```

#### Path B — BQ console

Run each file under `warehouse/L3/` in order.

#### Phase 5 verification

```sql
-- Cumulative monotonicity per network
SELECT network, MIN(diff) AS min_diff
FROM (
  SELECT network, cumulative_total_signups - LAG(cumulative_total_signups)
    OVER (PARTITION BY network ORDER BY metric_date) AS diff
  FROM `gooddollar.Marts.daily_invite_metrics`
)
WHERE diff IS NOT NULL
GROUP BY network;
-- Expect: min_diff >= 0 for every network (cumulative never decreases)

-- Funnel monotonicity
SELECT * FROM `gooddollar.Marts.invite_funnel_snapshot` ORDER BY stage_order;
-- Expect: user_count never increases as stage_order increases

-- Cross-check: stage 6 == invite_payouts row count
SELECT
  (SELECT user_count FROM `gooddollar.Marts.invite_funnel_snapshot` WHERE stage_order = 6)         AS funnel_paid,
  (SELECT COUNT(*) FROM `gooddollar.Semantic.invite_payouts`)                                       AS payouts_total;
-- Expect: equal
```

#### Phase 5 commit

No code changes — skip.

---

### Phase 6 — End-to-end verification + onchain spot check

**Goal:** Confirm the full stack agrees with onchain reality.

#### Run the verification script

```
.\scripts\verify.ps1
```

Expect: all 8 PASS.

If any fails, do not proceed. Diagnose and fix before continuing. Common failure causes are listed in the **Failure Modes** section below.

#### Onchain spot check

1. Pick one row from `Semantic.invitee_lifecycle` where `bounty_tx_hash IS NOT NULL`:
   ```sql
   SELECT * FROM `gooddollar.Semantic.invitee_lifecycle`
   WHERE bounty_tx_hash IS NOT NULL
   ORDER BY bounty_timestamp DESC LIMIT 1;
   ```
2. Open <https://xdcscan.io/tx/{bounty_tx_hash}>
3. Confirm the InviterBounty event in the receipt matches the row's `invitee_address`, `inviter_address`, and `bounty_total_amount_g`.

If the onchain values don't match, **stop**. The data model has a bug.

#### Phase 6 commit

No code changes — skip.

---

### Phase 7 — Final tag

```
git push origin add-events-pipeline
git tag mvp-deployed-v1
git push origin mvp-deployed-v1
```

The MVP is now live. Hand off to the user.

---

## Out of Scope

Things to **not** do, even if it seems easy:

- Ingest UBIScheme events other than `UBIClaimed` (10 admin events stay commented in the ABI).
- Add Celo or Ethereum to the contract configs.
- Add other contracts (Identity, Faucet, NameService, Mento, GoodDollar ERC20, MessagePassingBridge).
- Set up scheduled queries in BigQuery. Mart refresh is manual via `refresh-marts.ps1`.
- Build dashboards. The marts are tool-agnostic; downstream is the user's responsibility.
- Touch [`future/pipeline-v4/`](../future/pipeline-v4/). It's WIP and not part of MVP.
- Migrate to dbt.
- Build new L2 entities not listed in [`docs/02_DATA_MODEL.md`](../docs/02_DATA_MODEL.md).

If a request comes that would require any of these, ask first.

---

## Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| `npm install` fails inside `pipeline/` | Stale lockfile or wrong Node version | `rm -rf node_modules && npm install` |
| `BQ_TOKEN` / auth error from `bq` CLI | gcloud ADC not set or expired | `gcloud auth application-default login` |
| Pipeline `Insert failed (attempt 1/3)` with empty error details | Transient API hiccup | Auto-retries; safe to ignore unless all 3 attempts fail |
| Pipeline `Request Entity Too Large` (HTTP 413) | Edit 1.1 not applied (still flushing whole buffer at once) | Re-check Edit 1.1 — must be `while`-loop with `splice`, not `if` |
| Pipeline `no such field: insertId` | `table.insert(rows, { raw: true })` option missing | Already fixed in `insertWithRetry`. If you see this, you reverted that fix. |
| L2 view `Unrecognized name: <column>` | L1 schema does not match what L2 expects | Re-run the `warehouse/L1/*.sql` (CREATE OR REPLACE TABLE will reset the schema). Then re-deploy L2. |
| L3 mart numbers look stale | Mart not refreshed since last ingest | `.\scripts\refresh-marts.ps1` |
| Funnel stage 5 < stage 6 (impossible — stage 6 must be subset of stage 5) | Bounty paid to a user with < 3 claims, contradicting business rule | Sanity-check the data; this would indicate either incorrect ingestion or a contract behavior change |
| `verify.ps1` reports `lifecycle_n != invitees_n` | Lifecycle dedup incorrect, or new signups since last run not yet in lifecycle (it's a view, should be live) | Ask before fixing — likely indicates a real data anomaly |

---

## Reference Files (do not modify unless this spec says to)

- [`pipeline/index.ts`](../pipeline/index.ts) — modified in Phase 1 only
- [`warehouse/L1/`, `L2/`, `L3/`](../warehouse/) — read-only inputs for deployment phases
- [`scripts/`](../scripts/) — read-only helpers
- [`contracts/`](../contracts/), [`docs/`](../docs/) — reference; do not edit during MVP execution

If something needs to change beyond the edits above, ask.
