# Scripts

One PowerShell helper remains. The warehouse (Semantic + Marts) is managed by **dbt** now — see [`gd_dbt/`](../gd_dbt/) and [`docs/03_OPERATIONS.md`](../docs/03_OPERATIONS.md).

## Prerequisites

- Google Cloud SDK installed: <https://cloud.google.com/sdk/docs/install>
- `gcloud auth application-default login` already run
- Authenticated user has BQ Data Editor + Job User on the `gooddollar` project

## What's here

| Script | Purpose | When to run |
|---|---|---|
| [`deploy-warehouse.ps1`](deploy-warehouse.ps1) | Creates the **L1 raw tables** (`BlockchainEvents.*`) from the DDL in [`warehouse/L1/`](../warehouse/L1/). These are dbt *sources* (pipeline-written, dbt-read), not dbt models, so their bootstrap DDL still lives here. | Once after a clone, or if a raw table schema changes. |

## Everything else is dbt

| Old script | Replaced by |
|---|---|
| `deploy-warehouse.ps1 L2/L3/all` | `dbt run` (from `gd_dbt/`) |
| `refresh-marts.ps1` | `dbt run --select marts` |
| `verify.ps1` | `dbt test` |

```
cd gd_dbt
dbt run          # build Staging + Semantic + Marts
dbt test         # schema + data-quality checks
dbt docs serve   # lineage graph + docs at http://localhost:8080
```
