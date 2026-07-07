{{
  config(
    materialized = 'view'
  )
}}

/*
  L1 Staging: claim_contract_events
  Source: gooddollar.BlockchainEvents.ClaimContractEvents (written by TypeScript pipeline)
  Purpose: minimal cleaning of raw events — lowercase addresses, cast amount to BIGNUMERIC.
  Nothing business-specific here; that lives in the semantic layer.
*/

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
FROM {{ source('blockchain_events', 'ClaimContractEvents') }}
WHERE DATE(block_timestamp) <= {{ latest_closed_date() }}
