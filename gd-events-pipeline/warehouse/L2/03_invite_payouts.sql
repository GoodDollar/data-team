-- L2: invite_payouts (VIEW)
-- Source: BlockchainEvents.InviteContractEvents (event_name = 'InviterBounty')
-- Purpose: classifies every payout with payout_origin and normalizes amounts to G$
-- Business rules: see docs/02_DATA_MODEL.md §Semantic.invite_payouts

CREATE OR REPLACE VIEW `gooddollar.Semantic.invite_payouts` AS

WITH base AS (
  SELECT
    network,
    chain_id,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    LOWER(invitee)          AS invitee_address,
    LOWER(inviter)          AS _raw_inviter,
    LOWER(contract_address) AS _contract_address,
    bounty_paid,
    inviter_level,
    earned_level,
    ingested_at
  FROM `gooddollar.BlockchainEvents.InviteContractEvents`
  WHERE event_name = 'InviterBounty'
)

SELECT
  network,
  chain_id,
  block_number,
  block_timestamp,
  tx_hash,
  log_index,
  invitee_address,

  -- inviter_address: NULL on campaign payouts (contract pays itself, no human inviter)
  CASE
    WHEN _raw_inviter = _contract_address THEN NULL
    ELSE _raw_inviter
  END AS inviter_address,

  -- payout_origin classification (chain-agnostic)
  CASE
    WHEN _raw_inviter = _contract_address THEN 'campaign'
    ELSE 'referral'
  END AS payout_origin,

  -- Amounts: bounty_paid is uint256 string in G$ centavos (2 decimals).
  -- Referral total = G$1500 (G$1000 inviter + G$500 invitee)
  -- Campaign total = G$500  (G$500 invitee; G$1000 retained by contract)
  SAFE_CAST(bounty_paid AS BIGNUMERIC) / 100 AS total_amount_g,

  -- G$500 always goes to the invitee
  CAST(500 AS BIGNUMERIC) AS invitee_amount_g,

  -- G$1000 only goes to a human inviter on referral payouts
  CASE
    WHEN _raw_inviter = _contract_address THEN NULL
    ELSE CAST(1000 AS BIGNUMERIC)
  END AS inviter_amount_g,

  SAFE_CAST(inviter_level AS INT64) AS inviter_level,
  earned_level,
  ingested_at
FROM base;
