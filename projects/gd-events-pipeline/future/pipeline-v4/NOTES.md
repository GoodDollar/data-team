# v4 Refactor Notes

This file records observations, deviations, and open questions accumulated
during the v3 -> v4 refactor. Each entry is timestamped and dated.

## Observations

### 2026-04-20 — Phase 3, Task 3.4: HyperSync count primitive
Checked @envio-dev/hypersync-client@0.6.3 for a dedicated count-only method.
Methods checked: `client.count()`, `client.getLogsCount()`, response `totalLogs` field.
Result: none exist at this pinned version. Retained stream-with-minimal-fields approach (countLogs fallback).
Action: noted in countLogs JSDoc. Upgrade is a separate future phase.

### 2026-04-20 — Phase 2, Task 2.5: BQ streaming load
Replaced temp-file approach with createWriteStream-based streaming load.
If the `job` event proves unreliable in the current @google-cloud/bigquery version,
revert to temp-file approach and record here.

## Deviations from plan

### 2026-04-20 — Phase 12: Smoke check results

All five modes tested with ENVIO_API_TOKEN set and no GCP ADC credentials.
Expected failure point: `ensureAllTables()` → BQ auth failure → FATAL, exit 1.
Actual: exactly that. Pipeline fails fast with a clear FATAL log line; no
silent hangs, no partial writes, no lock acquisitions before auth confirmation.
Invalid mode argument also caught early (before BQ init) with correct FATAL + exit 1.
Clean typecheck after `rm -rf node_modules && npm install`.

## Open questions

## Future work / tracked issues

### FW-1: HyperSync client upgrade
`@envio-dev/hypersync-client@0.6.3` has no dedicated count primitive. A newer
version may expose one. Upgrading would let `countLogs()` skip the stream entirely
for verify, reducing HyperSync bandwidth and latency. Non-breaking change; update
pinned version in package.json and test `countLogs`.

### FW-2: Strict distributed lock
Current `PipelineLocks` MERGE has a residual race on first-insert: two concurrent
callers on an absent row could both succeed before the other's DML is visible.
For strict mutual exclusion, replace with GCS conditional PUT (`x-goog-if-generation-match: 0`)
or a Firestore transaction. Tracked as future work because the race is rare in practice
(cron + single operator) and the heartbeat/TTL mechanism bounds worst-case damage.

### FW-3: Multi-contract HyperSync batching
Each (contract, network) pair opens its own HyperSync stream. At 2 contracts × 3 networks
that's fine. At 50+ contracts, batching multiple contracts into one stream query would
reduce connection overhead and improve throughput. The `contracts` array in `ContractConfig`
already models multi-address per contract; extending to multi-contract-per-stream requires
changes to `streamDecodedEvents()` and the dispatch loop in `pipeline.ts`.

### FW-4: VerifyCheckpoints gap after schema changes
When a new column is added to a contract's schema (e.g. a new event field), the
`VerifyCheckpoints` table still holds a high checkpoint, so the repair path won't
re-process old rows to fill the new column. Mitigation: manually reset the checkpoint
row (`DELETE FROM VerifyCheckpoints WHERE table_id = '...'`) before running `repair`
after a schema change.

### FW-5: block_timestamp backfill for historical rows
Rows inserted before v4 have NULL `block_timestamp`. The deploy checklist calls for an
optional backfill via `FETCH_CONCURRENCY=1 npm run backfill`. For tables with large
history (tens of millions of rows) this can take hours. A targeted SQL UPDATE using
block-number ranges from a reference source (e.g. another table with timestamps) would
be faster than re-streaming from HyperSync.
