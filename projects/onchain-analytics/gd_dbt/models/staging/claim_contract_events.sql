{{
  config(
    materialized = 'view'
  )
}}

/*
  L1 Staging: claim_contract_events
  Source: gooddollar.BlockchainEvents.ClaimContractEvents (written by TypeScript pipeline)
  Purpose: minimal cleaning of raw events -- lowercase addresses, expose the raw amount.
  Nothing business-specific here; that lives in the semantic layer.

  Decimal conversion deliberately does NOT happen here. The factor is a property of
  (chain, token) and resolving it needs a join to the tokens seed, which staging does not do.
  Conversion happens in semantic/claim_events.sql.

  This model previously produced `amount_g = amount / 100`. That was wrong. GoodDollar is an
  18-decimal token on XDC and Celo and only a 2-decimal token on Fuse and Ethereum, so the
  hardcoded /100 inflated every downstream GD figure by 1e16. Measured 2026-09-21 by calling
  decimals() on each deployment and cross-checking a real UBIClaimed amount against the ERC20
  Transfer value emitted in the same transaction.

  DEDUPLICATION, added 2026-09-21. L0 contains 43,000 duplicate rows: blocks 95,864,458 to
  roughly 96,213,000 (2025-11-10 to 2025-11-19) were ingested twice, on 2026-04-28 and again on
  2026-06-07. Those seven days were therefore reported at exactly double their real activity.
  The two copies agree on every business field, so keeping one is lossless.

  This is a symptom fix. The disease is that ingestion is not idempotent over re-run block
  ranges, and it belongs to the pipeline. The source-level test in tests/ keeps it visible so it
  is not quietly papered over here.
*/

SELECT
  network,
  chain_id,
  block_number,
  block_timestamp,
  DATE(block_timestamp)                 AS block_date,
  tx_hash,
  log_index,
  event_name,
  LOWER(contract_address)               AS contract_address,
  LOWER(claimer)                        AS claimer_address,
  LOWER(tx_from)                        AS tx_sender_address,
  tx_status,
  amount                                AS claim_amount_raw,
  ingested_at
FROM {{ source('blockchain_events', 'ClaimContractEvents') }}
WHERE DATE(block_timestamp) <= {{ latest_closed_date() }}
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY network, tx_hash, log_index
  ORDER BY ingested_at ASC
) = 1
