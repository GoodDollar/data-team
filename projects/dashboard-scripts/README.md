# Dashboard Scripts

Google Apps Script files powering the GoodDollar main dashboard. These scripts run on a scheduled trigger and write metrics into the dashboard spreadsheet.

## Versions

| File | Version | Status |
|---|---|---|
| `v6-daily.gs` | v6 | **Production** — current scheduled script |
| `v6-dev.gs` | v6 | Manual diagnostics and repairs |
| `DEV Dashboard v5.gs` | v5 | Archived |
| `DEV dev v5.gs` | v5 | Archived |
| `Main Dashboard - Daily v4.gs` | v4 | Archived |

## Reference docs

- `v6-master-reference.md` — complete field reference and data model for v6
- `v6-audit-findings.md` — audit results and resolved issues for v6

## How these scripts work

The scripts are deployed via [Google Apps Script](https://script.google.com). They:

1. Pull on-chain and off-chain data from multiple sources (Dune, Etherscan, etc.)
2. Process and aggregate the metrics
3. Write results into the GoodDollar dashboard Google Sheet

API keys are stored in **Script Properties** (not in code). See `v6-master-reference.md` for the full list of required properties.

## Repairing XDC invite raw history

Load the updated [v6-dev.gs](v6-dev.gs) into the existing Apps Script project alongside the daily script. Keep scheduled executions from overlapping this manual repair. Do not create a trigger for the repair function.

1. Run `xdcInvitesDedupeRaw` from the editor. It validates the raw rows, creates a timestamped backup tab, normalizes legacy payout columns, and removes repeated `(tx_hash, log_index)` event keys. The execution log reports the backup name and the number of removed rows. Conflicting duplicates or invalid records abort before writing to the raw tab.
2. After successful cleanup, run `xdcInvitesRebuildFacts` to replace historical invite facts from the corrected raw data. Rebuilding facts alone preserves existing raw duplicates.
3. Refresh Looker Studio and compare figures at the same date cutoff. Facts end at yesterday; the raw tab can also contain today's events.

A second cleanup run makes no changes when the schema is already canonical and the event keys are unique. Cleanup leaves facts and the ingestion cursor unchanged. If a write fails, the backup tab preserves the original data for recovery; stop before rebuilding facts.

Run the local regression tests with Node.js:

```text
node --test projects/dashboard-scripts/tests/xdc-invites-raw.test.mjs
```
