-- The merge key of Transactions is (chain_id, tx_hash) and BigQuery cannot enforce it.
--
-- Same hazard and same reasoning as assert_raw_logs_merge_key_is_unique. One difference worth
-- stating: a transaction appears here once no matter how many logs it produced, so a duplicate
-- here does not merely double a row, it doubles a transaction's gas and value in any model that
-- joins to it. A count of logs would still look right while a sum of fees quietly doubled.
--
-- ENABLED BY A VAR because Transactions holds zero rows and is not yet written by anything:
--   dbt build --vars '{l0_v4_tables_exist: true}'
{{ config(enabled = var('l0_v4_tables_exist', false), severity = 'error') }}

SELECT
  chain_id,
  tx_hash,
  COUNT(*) AS rows_under_one_merge_key
FROM {{ source('blockchain_events', 'Transactions') }}
WHERE block_timestamp >= TIMESTAMP('2000-01-01')
  AND block_timestamp <  TIMESTAMP('2100-01-01')
GROUP BY chain_id, tx_hash
HAVING COUNT(*) > 1
