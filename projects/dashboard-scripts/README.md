# Dashboard Scripts

Google Apps Script files powering the GoodDollar main dashboard. These scripts run on a scheduled trigger and write metrics into the dashboard spreadsheet.

## Versions

| File | Version | Status |
|---|---|---|
| `v6-daily.gs` | v6.5 | **Production** — current scheduled script |
| `v6-dev.gs` | v6.1 | Manual diagnostics and repairs |
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

## Correcting XDC history after the move to subgraph gd_xdc/1.4

Version 1.2 of the XDC subgraph counted Identity whitelist events as claimers, and its day rows missed claims made before the row existed. v6.5 reads gd_xdc/1.4, which counts wallets that claimed and keeps every claim in its UTC day. Daily Facts never rewrites a stored row, so the stored history is corrected once with the functions in [v6-dev.gs](v6-dev.gs), section 6.

What gets corrected:

| Metrics | Window | How |
|---|---|---|
| `xdc_new_claimers`, `xdc_lifetime_unique_claimers`, `xdc_returning_claimers`, `xdc_gd_claimed_1d/7d/30d`, `xdc_daily_gd_minted`, `agg_gd_claimed_1d/7d/30d` | From XDC genesis (2025-11-12) | 1.4 day rows read at one block. Lifetime claimers = running total of first-time claimers to the end of each UTC day. Returning = stored `xdc_dau` minus new claimers, floored at 0. AGG = Celo + XDC. |
| `xdc_usd_claimed_1d/7d/30d`, `xdc_p2p_usd_amount`, `xdc_lifetime_claimed_usd_amount` and their `agg_` rows | Last 90 days | G$ amount x that day's `xdc_gd_price`. Before v6.5 the XDC USD rows were written a night late and the AGG USD rows never included XDC. |

Steps, in the Apps Script editor, after the nightly run has finished (it posts to Slack around 02:30 UTC) and with v6.5 of [v6-daily.gs](v6-daily.gs) in place:

1. Run `xdcSubgraphCorrectionPreview`. It writes nothing and logs, per metric, how many rows would be updated, added or left alone, the largest change, and any formula cells it found.
2. Run `xdcSubgraphCorrection`. It first writes every row it will touch, with the old value and old `updated_at`, to a new tab `XDC 1.4 corrections <UTC time>`, then updates the values in place and adds missing rows. It stops at the last day the nightly run has written. It refuses to run if the subgraph has not indexed that day or reports indexing errors, and it leaves Daily Facts untouched if a row is appended while it runs. Formula cells in Daily Facts are written back unchanged.
3. Run `xdcSubgraphCorrection` again: it should report nothing to change.
4. Refresh Looker Studio.

To undo, run `xdcSubgraphCorrectionRestoreLatest`. It puts back the old values from the newest corrections tab, removes the rows it added, and renames the tab `... (restored)`.

`xdc_returning_claimers` mixes two day definitions: `xdc_dau` is the contract's count for the UBI day that runs 12:00 to 12:00 UTC, while `xdc_new_claimers` is the UTC calendar day. The subgraph has no calendar-day count of distinct claimers, so returning claimers is an approximation.

Run the local regression tests with Node.js:

```text
node --test projects/dashboard-scripts/tests/xdc-invites-raw.test.mjs projects/dashboard-scripts/tests/xdc-subgraph-correction.test.mjs
```
