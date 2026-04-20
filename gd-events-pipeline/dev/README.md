# GoodDollar Blockchain Event Pipeline (v3)

BigQuery-backed mirror of on-chain event logs. One row per event, zero
duplicates, zero gaps. Self-verifying and self-repairing on a daily cron.

## Deploying v4

Before deploying v4 code, complete this checklist in order:

- [ ] **1. Run the Phase 6 migration SQL** on every existing contract event table.
  See [MIGRATIONS/001_add_block_timestamp.md](../MIGRATIONS/001_add_block_timestamp.md) for the exact `ALTER TABLE` statements.
- [ ] **2. Confirm the column exists** via `INFORMATION_SCHEMA.COLUMNS` — check that
  `block_timestamp TIMESTAMP` appears for each contract table.
- [ ] **3. Deploy the v4 code** (`npm install && npm run typecheck`).
- [ ] **4. Smoke check** — run `npm run verify` (read-only). No throws expected.
  BQ will return a schema-mismatch error if step 1 was skipped.
- [ ] **5. Monitor the next cron run** for `IngestionStatus` failures. The first run
  after deployment will populate `block_timestamp` on new rows via MERGE UPDATE.
- [ ] **6. Optional: bulk backfill** — to populate `block_timestamp` on historical rows,
  run `FETCH_CONCURRENCY=1 npm run backfill`. This re-processes full history at
  low concurrency and fills `block_timestamp` for every row via MERGE UPDATE.

---

## What's different in v3 / v4

| Concern | v1/v2 | v3 | v4 |
|---|---|---|---|
| Ingestion write path | `WRITE_APPEND` + periodic rewrite dedup | Staging table + `MERGE` on composite key | Same |
| Table layout | Flat | Partitioned on `block_number`, clustered on `(network, contract_address, event_name)` | Same + `block_timestamp TIMESTAMP` column |
| Resume point safety | Row-count chunks — block splittable | Block-aligned chunks — `MAX(block_number)` always sound | Same + hard-cap guard preserves block boundary |
| Day boundary | Wall-clock + cron timing | Block-timestamp binary search | Same |
| Reorg handling | None | Finality margin per network | Same |
| State query on error | Silent 0 (could trigger full re-ingest) | Fail-fast, operator retries | Same |
| Verify cost | Full fetch + decode | HyperSync metadata count; decode only on mismatch | Same + topic0 filter eliminates false positives from unknown events |
| Verify progress | Full re-scan every run | Same | `VerifyCheckpoints` table skips already-clean history |
| HyperSync errors | Propagate | Retry with backoff, 5 attempts | Same + rate-limit-aware 30s base jitter |
| Unknown events | Silently dropped | Logged to `UnknownEvents` table | Same + reconciliation in daily repair pass |
| Completeness signal | None | `IngestionStatus` table with per-day status per table | Same |
| Run observability | None | None | `PipelineRuns` table — per-run timing, exit code, row counts |
| Concurrent runs | Unprotected | `PipelineLocks` row, stolen if expired | Same + heartbeat extends TTL during long runs |
| Contract configuration | Flat network list, global `firstBlock` | Same | `networkBindings` — per-(contract, network) `firstBlock`; `enabled` + `tags` flags |
| Log writes | Synchronous `appendFileSync` | Same | Async stream; `flushLogs()` on every exit path |
| CLI modes | v2 broke verify/repair/dedup | All five wired and tested | Same + `--contracts=` filter flag |
| BigInt in logs | Crashes the log call | Safe replacer, plus circular-ref handling | Same |

## Directory layout

```
src/
  config.ts       # env validation + contract registry
  log.ts          # structured logger, BigInt-safe
  hypersync.ts    # stream/fetch/count/timestamp/tip
  bq.ts           # queries, staging+MERGE, status, locks
  pipeline.ts     # orchestration: all five modes
  index.ts        # CLI, lock wrap, signal handling
```

## Setup

1. `cp .env.example .env` and fill in `ENVIO_API_TOKEN`.
2. `npm install`
3. Authenticate to GCP: `gcloud auth application-default login`
4. Ensure BigQuery roles on your principal: Job User, Data Editor, Data Viewer.
5. Run once with `npm run daily` (or `backfill`) — infrastructure tables
   are created automatically; contract event tables must be created
   manually (see below).

## First-time contract table creation

The pipeline will not auto-create production tables because setting up
partitioning after data is loaded requires a deliberate rewrite. For each
contract, run the DDL the pipeline prints on first encounter — or
preempt it by running:

```sql
CREATE TABLE `gooddollar.BlockchainEvents.InviteContractEvents` (
  network STRING,
  block_number INT64,
  log_index INT64,
  tx_hash STRING,
  contract_address STRING,
  event_name STRING,
  inviter STRING,
  invitee STRING,
  bounty_paid STRING,
  inviter_level STRING,
  earned_level BOOL
)
PARTITION BY RANGE_BUCKET(block_number, GENERATE_ARRAY(0, 500000000, 1000000))
CLUSTER BY network, contract_address, event_name;
```

## Migrating an existing (unpartitioned) table from v1/v2

If you already have data from v1 or v2 in an unpartitioned table, do
this once before the first v3 run. **Run during a quiet window.**

```sql
-- 1. Create the new partitioned table alongside the old one
CREATE TABLE `gooddollar.BlockchainEvents.InviteContractEvents_new` (
  -- same schema as above
)
PARTITION BY RANGE_BUCKET(block_number, GENERATE_ARRAY(0, 500000000, 1000000))
CLUSTER BY network, contract_address, event_name
AS
SELECT * FROM `gooddollar.BlockchainEvents.InviteContractEvents`;

-- 2. Swap (atomic)
DROP TABLE `gooddollar.BlockchainEvents.InviteContractEvents`;
ALTER TABLE `gooddollar.BlockchainEvents.InviteContractEvents_new`
  RENAME TO InviteContractEvents;
```

If the table is already partitioned but not clustered, just
`CREATE OR REPLACE` with the `CLUSTER BY` clause.

## Adding a new contract

### 1. Define the config in `src/config.ts`

```typescript
const MY_CONTRACT_CONFIG: ContractConfig = {
  tableId: "MyContractEvents",        // becomes the BQ table name
  tags: ["my-tag"],                   // optional; used with --contracts=tag:my-tag
  schema: [
    { name: "network",           type: "STRING"    },
    { name: "block_number",      type: "INTEGER"   },
    { name: "block_timestamp",   type: "TIMESTAMP" },
    { name: "log_index",         type: "INTEGER"   },
    { name: "tx_hash",           type: "STRING"    },
    { name: "contract_address",  type: "STRING"    },
    { name: "event_name",        type: "STRING"    },
    // ... event-specific columns
  ],
  abi: [ /* ABI event fragments only */ ] as const,
  contracts: [
    "0xAddress1",  // one entry per deployed contract address (all networks share the list)
  ],
  networkBindings: [
    // firstBlock: block just before the first possible event on this network.
    // Set conservatively (too low is safe; too high silently loses history).
    { network: NETWORKS.CELO, firstBlock: 18_000_000 },
    { network: NETWORKS.FUSE, firstBlock: 15_000_000, enabled: false }, // skip until needed
  ],
  decodeToRow: (decoded, log, networkName) => ({
    network:          networkName,
    block_number:     log.blockNumber,
    block_timestamp:  new Date(log.blockTimestamp * 1000).toISOString(),
    log_index:        log.logIndex,
    tx_hash:          log.transactionHash,
    contract_address: log.address,
    event_name:       decoded.eventName,
    // ... map decoded.args fields
  }),
};
```

### 2. Register it

```typescript
export const CONTRACT_CONFIGS: ContractConfig[] = [
  INVITE_CONFIG,
  CLAIM_CONFIG,
  MY_CONTRACT_CONFIG,  // add here
];
```

### 3. Create the BigQuery table

```sql
CREATE TABLE `gooddollar.BlockchainEvents.MyContractEvents` (
  network STRING,
  block_number INT64,
  block_timestamp TIMESTAMP,
  log_index INT64,
  tx_hash STRING,
  contract_address STRING,
  event_name STRING
  -- add event-specific columns
)
PARTITION BY RANGE_BUCKET(block_number, GENERATE_ARRAY(0, 500000000, 1000000))
CLUSTER BY network, contract_address, event_name;
```

### 4. Backfill

```bash
npm run backfill -- --contracts=MyContractEvents
```

Idempotent and safe to re-run. Existing contracts are not re-processed.

## Operational modes

| Mode | Purpose | Safe to re-run? | Lock? |
|---|---|---|---|
| `backfill` | Load full history from `firstBlock` | Yes | Yes |
| `daily` | Cron path: ingest + verify + repair | Yes | Yes |
| `verify` | Read-only integrity check | Yes | No (read-only) |
| `repair` | Full verify + fix mismatches | Yes | Yes |
| `dedup` | Manual rewrite to remove duplicates | Yes | Yes |

## Cron setup

```cron
# 00:30 UTC daily — enough buffer for chain finality + HyperSync indexing
30 0 * * * cd /opt/pipeline && /usr/bin/npm run daily >> /var/log/pipeline.stdout 2>&1
```

## Monitoring queries

### Is yesterday's data complete?

```sql
SELECT
  network,
  table_id,
  status,
  last_block,
  row_count,
  completed_at,
  TIMESTAMP_DIFF(completed_at, started_at, SECOND) AS seconds_elapsed
FROM `gooddollar.BlockchainEvents.IngestionStatus`
WHERE ingestion_date = CURRENT_DATE() - 1
ORDER BY network, table_id;
```

### What unknown events have we seen?

Useful for detecting contract upgrades adding new events.

```sql
SELECT
  network,
  contract_address,
  topic0,
  COUNT(*) AS occurrences,
  MIN(first_seen) AS first_seen,
  MAX(block_number) AS latest_block
FROM `gooddollar.BlockchainEvents.UnknownEvents`
GROUP BY network, contract_address, topic0
ORDER BY occurrences DESC
LIMIT 50;
```

### Any stuck locks?

```sql
SELECT lock_name, holder, acquired_at, expires_at,
       expires_at < CURRENT_TIMESTAMP() AS expired
FROM `gooddollar.BlockchainEvents.PipelineLocks`;
```

### Recent pipeline runs

```sql
SELECT run_id, mode, started_at, completed_at,
       TIMESTAMP_DIFF(completed_at, started_at, SECOND) AS seconds_elapsed,
       exit_code, total_contracts, total_networks, total_rows_merged
FROM `gooddollar.BlockchainEvents.PipelineRuns`
ORDER BY started_at DESC
LIMIT 10;
```

### Runs longer than 2 hours

```sql
SELECT run_id, mode, started_at, completed_at,
       TIMESTAMP_DIFF(completed_at, started_at, MINUTE) AS minutes_elapsed
FROM `gooddollar.BlockchainEvents.PipelineRuns`
WHERE TIMESTAMP_DIFF(completed_at, started_at, MINUTE) > 120
ORDER BY started_at DESC;
```

### Runs with non-zero exit (failures)

```sql
SELECT run_id, mode, started_at, exit_code
FROM `gooddollar.BlockchainEvents.PipelineRuns`
WHERE exit_code != 0
ORDER BY started_at DESC
LIMIT 20;
```

#### Lock semantics

The distributed lock is **best-effort, not strict mutual exclusion**:

- The lock is a row in `PipelineLocks`. Acquisition uses a single MERGE whose
  match condition includes the expiry check, followed by a read-back to confirm
  ownership.
- A **heartbeat** interval (every `LOCK_TTL_MS / 3`, default 2 hours) extends
  the lock's expiry while the run is alive. A run that crashes without releasing
  the lock will have it stolen after `LOCK_TTL_MS` (default 6 hours).
- A dead process (crashed, OOM-killed) loses the lock after the TTL expires.
  The next scheduled run will steal it and log a warning.
- **Residual race**: two concurrent acquisition attempts on an absent lock row
  could theoretically both succeed if BigQuery's DML job visibility has a gap.
  This is rare in practice. For strict mutual exclusion, replace the backend
  with GCS conditional writes or Firestore transactions (tracked as future work).

### Downstream: safe-to-query filter

Consumers of the event tables should join against `IngestionStatus` to
avoid reading a day that's still in flight:

```sql
WITH safe_dates AS (
  SELECT ingestion_date
  FROM `gooddollar.BlockchainEvents.IngestionStatus`
  WHERE status = 'complete'
    AND network = 'CELO'
    AND table_id = 'InviteContractEvents'
)
SELECT e.*
FROM `gooddollar.BlockchainEvents.InviteContractEvents` e
JOIN safe_dates s
  ON DATE(e.block_timestamp) = s.ingestion_date
WHERE e.network = 'CELO';
```

## Resource consumption

### HyperSync call budget (per daily run, per (contract, network) pair)

| Step | Calls | Notes |
|---|---|---|
| Tip block lookup | 1 | `getChainHeight` |
| Daily boundary binary search | ~17 | Binary search over `VERIFY_WINDOW_DAYS` worth of blocks |
| Ingest stream | 1 streaming session | Streams from `lastBlock+1` to tip−`finalityBlocks` |
| Verify count | 1 per `CHUNK_SIZE_VERIFY_BLOCKS` chunk | Cheap metadata count; no decode |
| Repair fetch (only on mismatch) | 1 streaming session | Full decode; only fires when count differs |

Total: typically 20–25 HyperSync calls per contract/network pair per daily run. With 2 contracts × 2–3 networks = 40–75 calls/day.

### BigQuery scan budget (per daily run)

| Query | Scan |
|---|---|
| `getLastBlockInBQ` | Partition-pruned; scans last partition only |
| `stageAndMerge` MERGE | Scans staging (rows inserted) + target partition range |
| Verify `countUnknownEventsInRange` | Scans `UnknownEvents` partition range |
| Status / lock reads | Tiny infra tables, negligible |

Daily ingest volume is typically a few thousand rows per contract/network, so BQ costs are well under $1/month at standard on-demand pricing.

### Operational knobs

| Env var | Default | Effect |
|---|---|---|
| `FETCH_CONCURRENCY` | 4 | (contract, network) pairs fetched in parallel |
| `CHUNK_SIZE_LOAD_TARGET` | 50 000 | Target rows per MERGE; raise to reduce BQ jobs |
| `CHUNK_SIZE_VERIFY_BLOCKS` | 100 000 | Blocks per verify count call |
| `VERIFY_WINDOW_DAYS` | 7 | How many days back daily verify checks |
| `LOCK_TTL_MS` | 21 600 000 (6 h) | Staleness threshold before lock is stolen |
| `HYPERSYNC_RETRIES` | 5 | Per-request retry budget |

## Philosophy

The only write path is `stage → MERGE`. Every mode (backfill, daily,
repair) uses it. There is no code path that writes directly to production
tables with WRITE_APPEND — which is what let v1/v2 accumulate duplicates
that required periodic cleanup.

State queries (`getLastBlockInBQ`, lock checks, status writes) fail fast
on error. A transient network blip during state discovery is an operator
event, not a reason to assume the table is empty.

Verification uses HyperSync's cheap count endpoint. Only when a mismatch
surfaces do we pay the decode cost. This reduces daily verify work by
roughly 10× compared to v1/v2's full-fetch verification.

The pipeline takes a run-wide lock via a BigQuery row. This prevents
cron + manual operator overlap and any retry loop from racing on the
same MERGE. If a run crashes and leaves the lock, the next run steals
it once `expires_at` passes.

## Non-goals

Explicitly out of scope for v3:

- Alerting integrations (PagerDuty, Slack, etc.) — use Cloud Logging
  sinks on the structured JSON log file instead.
- Prometheus/Grafana metrics — `IngestionStatus` is the metrics story.
- Streaming/real-time ingestion — this is batch by design.
- Multi-contract-per-stream HyperSync batching — valuable at 50+
  contracts, premature at 12.
- Cross-region BQ replication — GCP-side concern, not pipeline-side.
