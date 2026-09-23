{{
  config(
    materialized = 'view'
  )
}}

/*
  L2 Semantic: claim_events
  Source: staging.claim_contract_events, seed tokens (via ref)
  Purpose: canonical business-meaning entity for claims.
  Every L3 model touching claims reads from HERE, never from staging or raw.

  This is where the raw uint256 becomes a human-readable GD amount. The decimal factor is
  resolved per (chain, GD token) from the tokens seed rather than hardcoded, because the
  factor genuinely differs by chain: 18 on Celo and XDC, 2 on Fuse and Ethereum.

  The join is an INNER JOIN with no de-duplication guard, deliberately. A duplicate GD row
  for one chain in the seed is a data-entry error that must stop the build, not be silently
  resolved to one arbitrary row. Two tests protect this: a uniqueness test on the seed, and
  a row-count parity test between this model and its staging source (tests/).
*/

WITH gd_token AS (
  SELECT
    chain,
    token_address,
    symbol,
    decimals,
    decimals_source
  FROM {{ ref('tokens') }}
  WHERE is_gd
)

SELECT
  s.network,
  s.chain_id,
  s.block_number,
  s.block_timestamp,
  s.block_date,
  s.tx_hash,
  s.log_index,
  s.event_name,
  s.contract_address,
  s.claimer_address,
  s.tx_sender_address,
  s.tx_status,

  t.token_address,
  t.symbol                                            AS token_symbol,
  t.decimals                                          AS token_decimals,
  t.decimals_source                                   AS token_decimals_source,

  s.claim_amount_raw,
  SAFE_CAST(s.claim_amount_raw AS BIGNUMERIC)
    / POW(10, t.decimals)                             AS claim_amount,

  s.ingested_at
FROM {{ ref('claim_contract_events') }} s
INNER JOIN gd_token t
  ON t.chain = s.network
