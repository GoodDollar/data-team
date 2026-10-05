-- One additive statement. Existing table_id values and historical rows are retained.
-- Legacy rows remain NULL in the new dimensions; no chain or contract is inferred.
ALTER TABLE `${PROJECT}.${DATASET}.OracleReconciliation`
  ADD COLUMN IF NOT EXISTS chain_id INT64
    OPTIONS(description="EVM chain id. NULL on historical rows written before this dimension existed."),
  ADD COLUMN IF NOT EXISTS contract_address STRING
    OPTIONS(description="Oracle contract address. NULL on historical rows written before this dimension existed.");