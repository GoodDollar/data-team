-- L2: claim_events (VIEW)
-- Source: BlockchainEvents.ClaimContractEvents
-- Purpose: normalized claim events. Lower-cases claimer, converts amount to BIGNUMERIC G$.
-- Every L3 query touching claims goes through THIS view, never raw L1.
-- See docs/02_DATA_MODEL.md §Semantic.claim_events

CREATE OR REPLACE VIEW `gooddollar.Semantic.claim_events` AS

SELECT
  network,
  chain_id,
  block_number,
  block_timestamp,
  tx_hash,
  log_index,
  LOWER(contract_address)               AS contract_address,
  LOWER(claimer)                        AS claimer_address,
  amount                                AS amount_raw,
  SAFE_CAST(amount AS BIGNUMERIC) / 100 AS amount_g,
  ingested_at
FROM `gooddollar.BlockchainEvents.ClaimContractEvents`;
