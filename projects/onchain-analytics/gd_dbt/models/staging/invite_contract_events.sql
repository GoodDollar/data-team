{{
  config(
    materialized = 'view'
  )
}}

/*
  L1 Staging: invite_contract_events
  Source: gooddollar.BlockchainEvents.InviteContractEvents (written by TypeScript pipeline)
  Purpose: minimal cleaning of raw events -- lowercase addresses.
  Nothing business-specific here; that lives in the semantic layer.

  DEDUPLICATION, added 2026-09-21. L0 contains 2,167 duplicate rows out of 9,260, i.e. 23 percent
  of this table is a second copy of an event already present, from a re-ingested block range.
  For InviterBounty specifically that is 284 phantom rows of 1,223, which inflated reported
  bounty expenditure. The copies agree on every business field, so keeping one is lossless.

  Symptom fix. The ingestion defect is tracked by the source-level test in tests/.
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
  LOWER(inviter)                        AS inviter_address,
  LOWER(invitee)                        AS invitee_address,
  inviter_level,
  bounty_paid,
  earned_level,
  ingested_at
FROM {{ source('blockchain_events', 'InviteContractEvents') }}
WHERE DATE(block_timestamp) <= {{ latest_closed_date() }}
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY network, tx_hash, log_index
  ORDER BY ingested_at ASC
) = 1
