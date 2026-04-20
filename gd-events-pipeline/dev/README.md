# GoodDollar Blockchain Event Pipeline (v3)

BigQuery-backed mirror of on-chain event logs. One row per event, zero
duplicates, zero gaps. Self-verifying and self-repairing on a daily cron.

## What's different in v3

| Concern | v1/v2 | v3 |
|---|---|---|
| Ingestion write path | `WRITE_APPEND` + periodic rewrite dedup | Staging table + `MERGE` on composite key |
| Table layout | Flat | Partitioned on `block_number`, clustered on `(network, contract_address, event_name)` |
| Resume point safety | Row-count chunks — block splittable | Block-aligned chunks — `MAX(block_number)` always sound |
| Day boundary | Wall-clock + cron timing | Block-timestamp binary search |
| Reorg handling | None | Finality margin per network |
| State query on error | Silent 0 (could trigger full re-ingest) | Fail-fast, operator retries |
| Verify cost | Full fetch + decode | HyperSync metadata count; decode only on mismatch |
| HyperSync errors | Propagate | Retry with backoff, 5 attempts |
| Unknown events | Silently dropped | Logged to `UnknownEvents` table |
| Completeness signal | None | `IngestionStatus` table with per-day status per table |
| Concurrent runs | Unprotected | `PipelineLocks` row, stolen if expired |
| CLI modes | v2 broke verify/repair/dedup | All five wired and tested |
| BigInt in logs | Crashes the log call | Safe replacer, plus circular-ref handling |

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

1. Add a `ContractConfig` object to `src/config.ts`.
2. Include it in `CONTRACT_CONFIGS`.
3. Create the BigQuery table with the DDL above.
4. Run `npm run backfill` — idempotent and safe on existing contracts.

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
  ON DATE(TIMESTAMP_SECONDS((SELECT CAST(... AS INT64)))) = s.ingestion_date
WHERE e.network = 'CELO';
```

(In practice you'd add a `block_timestamp` column to the event schema to
make this join trivial; deferred to avoid scope creep on the ingestion
layer.)

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
