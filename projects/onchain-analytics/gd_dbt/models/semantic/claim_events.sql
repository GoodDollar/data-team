{{
  config(
    materialized = 'view'
  )
}}

/*
  L2 Semantic: claim_events
  Source: staging.stg_claim_contract_events (via ref)
  Purpose: canonical business-meaning entity for claims.
  Every L3 model touching claims reads from HERE, never from staging or raw.
  Equivalent to the current gooddollar.Semantic.claim_events view.
*/

SELECT
  network,
  chain_id,
  block_number,
  block_timestamp,
  tx_hash,
  log_index,
  contract_address,
  claimer_address,
  amount_raw,
  amount_g,
  ingested_at
FROM {{ ref('claim_contract_events') }}
