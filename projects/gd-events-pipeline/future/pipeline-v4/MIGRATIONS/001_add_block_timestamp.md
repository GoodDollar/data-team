# Migration 001 — Add block_timestamp to contract event tables

## Summary

Adds a `block_timestamp TIMESTAMP` column to every contract event table
(`InviteContractEvents`, `ClaimContractEvents`, and any future tables).

This is a schema change introduced in Phase 4 of the v3 → v4 refactor.

---

## Step 1 — Add the column (metadata-only, fast)

Run the following for each contract event table. This is a metadata-only
operation in BigQuery and completes in seconds even on large tables.

```sql
ALTER TABLE `<project>.<dataset>.InviteContractEvents`
  ADD COLUMN IF NOT EXISTS block_timestamp TIMESTAMP;

ALTER TABLE `<project>.<dataset>.ClaimContractEvents`
  ADD COLUMN IF NOT EXISTS block_timestamp TIMESTAMP;
```

Replace `<project>` and `<dataset>` with your GCP project ID and dataset name
(defaults: `gooddollar` / `BlockchainEvents`).

**This step MUST be run before deploying the v4 code.** The v4 pipeline sets
`block_timestamp` on every row it writes. If the column is absent, the staging
load job will fail with a schema mismatch.

---

## Step 2 — Backfill existing rows

Historical rows loaded before v4 will have `NULL` in `block_timestamp`.
Two options:

### Option A (preferred) — Natural backfill via MERGE

The v4 pipeline's MERGE statement includes `block_timestamp` in the UPDATE
clause. As each block range is re-processed (via repair or a new incremental
run that touches existing rows), the column is populated automatically.

**Downstream consumers must treat `NULL block_timestamp` as "not yet
backfilled" for rows ingested before v4.**

### Option B (aggressive) — One-time BQ batch job

If you need all rows populated immediately, run a single BQ UPDATE that joins
against a public block-timestamp source for the chain, or run a dedicated
backfill:

```bash
# Lower concurrency to reduce HyperSync API pressure during backfill
FETCH_CONCURRENCY=1 npm run backfill
```

This re-processes the full history using the v4 decoder, populating
`block_timestamp` for every row via the MERGE UPDATE path.

---

## Step 3 — Verify

After deployment, confirm via `INFORMATION_SCHEMA`:

```sql
SELECT column_name, data_type, is_nullable
FROM `<project>.<dataset>.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name IN ('InviteContractEvents', 'ClaimContractEvents')
  AND column_name = 'block_timestamp';
```

Expected output: one row per table, `data_type = 'TIMESTAMP'`, `is_nullable = 'YES'`.

---

## Rollback

To revert (rare): the column can simply be left NULL or ignored. The v3 code
does not reference `block_timestamp` so rolling back to v3 is safe. The column
can be dropped later via `ALTER TABLE ... DROP COLUMN block_timestamp` once
all v4 deployments are confirmed, but dropping is irreversible so confirm first.
