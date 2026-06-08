-- L2: invite_payouts (VIEW)
-- Source: BlockchainEvents.InviteContractEvents (event_name = 'InviterBounty')
-- Purpose: classifies every payout with payout_origin and normalizes amounts to G$
-- Business rules: see docs/02_DATA_MODEL.md §Semantic.invite_payouts
--
-- Payout eligibility: a payout fires once the invitee has accumulated the required number
-- of UBI claim days tracked by the contract (documented threshold: 3 UBI claims).
-- The contract tracks this via the `daysClaimed` counter in the levels struct.
-- See docs/04_CONTRACT_MECHANICS.md §3 for the full payout journey.

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

  -- Amounts
  --
  -- bounty_paid is the INVITER's portion only, stored in the InviterBounty event,
  -- encoded as uint256 in 18-decimal token units (1 G$ = 10^18 smallest units).
  -- The invitee's G$500 is paid as a separate GoodDollar ERC20 Transfer in the same
  -- transaction and does NOT appear in bounty_paid. Verified on-chain: tx
  -- 0xa295a058b8234f8eac6681be80528812b02382e2d95d21f762c8aa7950411394 shows
  -- bounty_paid = 1000000000000000000000 (G$1000) while xdcscan shows two transfers:
  -- G$1000 to inviter and G$500 to invitee in the same transaction.
  -- inviter_level varies, so inviter_amount_g must be read from chain -- not hardcoded.
  --
  -- invitee_amount_g: G$500 is the protocol-fixed base bounty (_level0Bounty constructor
  -- param) paid to every invitee. No on-chain event field exists for this transfer.
  -- G$500 is a stable, documented constant. To verify the current value:
  -- call levels(0).bounty on the invite contract and divide by 10^18.
  -- If the protocol changes this, update both CAST(500) expressions below and redeploy.
  CAST(500 AS BIGNUMERIC) AS invitee_amount_g,

  -- inviter_amount_g: actual inviter payout read from bounty_paid (chain-derived).
  -- Automatically reflects level-based bonuses. NULL for campaign payouts (no human inviter).
  CASE
    WHEN _raw_inviter = _contract_address THEN NULL
    ELSE SAFE_CAST(bounty_paid AS BIGNUMERIC) / 1000000000000000000
  END AS inviter_amount_g,

  -- total_amount_g: invitee base (500) + chain-derived inviter amount (0 for campaign).
  -- Always equals invitee_amount_g + COALESCE(inviter_amount_g, 0).
  CASE
    WHEN _raw_inviter = _contract_address
      THEN CAST(500 AS BIGNUMERIC)
    ELSE SAFE_CAST(bounty_paid AS BIGNUMERIC) / 1000000000000000000 + CAST(500 AS BIGNUMERIC)
  END AS total_amount_g,

  SAFE_CAST(inviter_level AS INT64) AS inviter_level,
  earned_level,
  ingested_at
FROM base;
