# Scripts

PowerShell helpers for operating the warehouse without writing BigQuery commands by hand. All scripts use the `bq` CLI (ships with the Google Cloud SDK).

## Prerequisites

- Google Cloud SDK installed: <https://cloud.google.com/sdk/docs/install>
- `gcloud auth application-default login` already run
- Authenticated user has BQ Data Editor + Job User on the `gooddollar` project

## What each script does

| Script | Purpose | When to run |
|---|---|---|
| [`deploy-warehouse.ps1`](deploy-warehouse.ps1) `<L1\|L2\|L3\|all>` | Runs every `*.sql` file in `warehouse/<layer>/` in numbered order. | Once after a clone, plus whenever a `.sql` file changes. |
| [`refresh-marts.ps1`](refresh-marts.ps1) | Re-runs only L3 `*.sql` files (delegates to `deploy-warehouse.ps1 L3`). | After every successful pipeline ingest. |
| [`verify.ps1`](verify.ps1) | Runs validation queries; prints PASS/FAIL summary and exits non-zero if any fail. | Any time you want to sanity-check the warehouse. |

## Quick recipes

**First-time deploy (after running L1 backfill):**
```
.\scripts\deploy-warehouse.ps1 all
.\scripts\verify.ps1
```

**Daily refresh (after pipeline append):**
```
.\scripts\refresh-marts.ps1
```

**Sanity check:**
```
.\scripts\verify.ps1
```

## If you don't have `bq` CLI

Use the BigQuery web console as described in [`docs/03_OPERATIONS.md`](../docs/03_OPERATIONS.md). The `.sql` files in `warehouse/L1/`, `L2/`, `L3/` are runnable verbatim in the console — copy, paste, click Run. Numbered file order = execution order.
