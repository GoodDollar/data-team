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

## Open questions
