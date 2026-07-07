{{
  config(
    materialized = 'view'
  )
}}

/*
  L1 Staging: invite_contract_events
  Source: gooddollar.BlockchainEvents.InviteContractEvents (written by TypeScript pipeline)
  Purpose: minimal cleaning of raw events — lowercase addresses.
  Nothing business-specific here; that lives in the semantic layer.
*/

SELECT
  network,
  chain_id,
  block_number,
  block_timestamp,
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
