# Scripts

One PowerShell helper remains. The warehouse (Semantic + Marts) is managed by **dbt** now — see [`gd_dbt/`](../gd_dbt/) and [`docs/03_OPERATIONS.md`](../docs/03_OPERATIONS.md).

## Prerequisites

- Google Cloud SDK installed: <https://cloud.google.com/sdk/docs/install>
- `gcloud auth application-default login` already run for metadata reads and sandbox validation
- Production schema changes require a separately authorized administrator; do not grant the ordinary
	analytics identity raw-dataset write permissions

## What's here

| Script | Purpose | When to run |
|---|---|---|
| [`deploy-warehouse.ps1`](deploy-warehouse.ps1) | Applies one named migration from a fixed allowlist. Default is plan-only; production execution requires `-Execute`, `-AllowProduction`, explicit service-account impersonation, and a typed confirmation. | Only after the exact migration and production access are separately approved. |

The L1 SQL folder is not an execution queue. `04_L0Contract_v3.sql`, `06_L0Contract_v4.sql`,
`07_RetireV3EventTables.sql`, and any unlisted file are refused. Run the labelled-sandbox migration
validator from `pipeline-v5/` with `node --import tsx ..\scripts\ops\validate-l0-migrations.mjs ..\..\_scratch\unit-07a-commissioning\sandbox-validation.json`.

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
