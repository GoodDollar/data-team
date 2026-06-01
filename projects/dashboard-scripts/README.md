# Dashboard Scripts

Google Apps Script files powering the GoodDollar main dashboard. These scripts run on a scheduled trigger and write metrics into the dashboard spreadsheet.

## Versions

| File | Version | Status |
|---|---|---|
| `v6-daily.gs` | v6 | **Production** — current scheduled script |
| `v6-dev.gs` | v6 | Development / staging variant |
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
