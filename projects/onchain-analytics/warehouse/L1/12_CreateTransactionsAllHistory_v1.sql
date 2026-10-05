-- One additive statement. IF NOT EXISTS leaves an existing view unchanged for preflight review.
CREATE VIEW IF NOT EXISTS `${PROJECT}.${DATASET}.TransactionsAllHistory`
OPTIONS(description="All Transactions rows through the supported timestamp range. Use for whole-history reads; filter the base table for a bounded window.")
AS SELECT *
FROM `${PROJECT}.${DATASET}.Transactions`
WHERE block_timestamp >= TIMESTAMP('2000-01-01 00:00:00')
  AND block_timestamp < TIMESTAMP('2100-01-01 00:00:00');