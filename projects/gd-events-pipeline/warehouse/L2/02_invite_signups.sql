-- L2: invite_signups (VIEW)
-- Source: BlockchainEvents.InviteContractEvents (event_name = 'InviteeJoined')
-- Purpose: classifies every signup with signup_type (no_code | campaign | referral)
-- Business rules: see docs/02_DATA_MODEL.md §Semantic.invite_signups

CREATE OR REPLACE VIEW `gooddollar.Semantic.invite_signups` AS

WITH base AS (
  SELECT
    network,
    chain_id,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    LOWER(invitee)          AS user_address,
    LOWER(inviter)          AS _raw_inviter,
    LOWER(contract_address) AS _contract_address,
    inviter_level,
    ingested_at
  FROM `gooddollar.BlockchainEvents.InviteContractEvents`
  WHERE event_name = 'InviteeJoined'
)

SELECT
  network,
  chain_id,
  block_number,
  block_timestamp,
  tx_hash,
  log_index,
  user_address,

  -- inviter_address: NULL for no_code and campaign; otherwise the human inviter
  CASE
    WHEN _raw_inviter = '0x0000000000000000000000000000000000000000' THEN NULL
    WHEN _raw_inviter = _contract_address                            THEN NULL
    ELSE _raw_inviter
  END AS inviter_address,

  -- signup_type classification (chain-agnostic via contract_address comparison)
  CASE
    WHEN _raw_inviter = '0x0000000000000000000000000000000000000000' THEN 'no_code'
    WHEN _raw_inviter = _contract_address                            THEN 'campaign'
    ELSE 'referral'
  END AS signup_type,

  SAFE_CAST(inviter_level AS INT64) AS inviter_level,
  ingested_at
FROM base;
