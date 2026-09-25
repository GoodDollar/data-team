-- The merge key of RawLogs is (chain_id, tx_hash, log_index) and BigQuery cannot enforce it.
--
-- WHY THIS EXISTS. A MERGE whose window on the target does not cover an already present row does
-- not update it, it INSERTS A SECOND ROW under the same merge key. That is ordinary MERGE
-- semantics and it reproduces on an unguarded table too. The duplicate is then byte identical to
-- its twin as soon as the next correctly scoped MERGE updates both copies, so it is invisible to
-- any comparison of values and to every row count that is not grouped by the key. A GROUP BY on
-- the key is the only thing that finds it.
--
-- THE WIDE FILTER IS NOT OPTIONAL. RawLogs carries require_partition_filter = TRUE, so this query
-- is refused outright without a usable filter on block_timestamp. Verified 2026-09-24 in a
-- sandbox against a table built to the shipping shape: unfiltered is REFUSED, wide filtered on
-- clean data returns zero groups, and wide filtered with a duplicate seeded into a different
-- partition from its twin returns exactly one group. A test that has never gone red is not a test.
--
-- ENABLED BY A VAR because RawLogs does not exist yet. Turn it on with the table:
--   dbt build --vars '{l0_v4_tables_exist: true}'
-- The alternative, leaving it enabled against a table that does not exist, makes every build red
-- for a reason that has nothing to do with the data.
{{ config(enabled = var('l0_v4_tables_exist', false), severity = 'error') }}

SELECT
  chain_id,
  tx_hash,
  log_index,
  COUNT(*) AS rows_under_one_merge_key
FROM {{ source('blockchain_events', 'RawLogs') }}
WHERE block_timestamp >= TIMESTAMP('2000-01-01')
  AND block_timestamp <  TIMESTAMP('2100-01-01')
GROUP BY chain_id, tx_hash, log_index
HAVING COUNT(*) > 1
