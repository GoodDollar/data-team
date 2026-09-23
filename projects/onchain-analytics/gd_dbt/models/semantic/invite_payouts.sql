{{
  config(
    materialized = 'view'
  )
}}

/*
  L2 Semantic: invite_payouts
  Source: staging.invite_contract_events (via ref, event_name = 'InviterBounty')
  Purpose: classifies every payout with payout_origin and normalizes amounts to GD
  Business rules: see docs/02_DATA_MODEL.md §Semantic.invite_payouts
  Equivalent to the current gooddollar.Semantic.invite_payouts view.
*/

WITH base AS (
  SELECT
    network,
    chain_id,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    invitee_address,
    inviter_address          AS _raw_inviter,
    contract_address         AS _contract_address,
    bounty_paid,
    inviter_level,
    earned_level,
    ingested_at
  FROM {{ ref('invite_contract_events') }}
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
  -- bounty_paid is the INVITER's portion only, stored in the InviterBounty event, encoded as
  -- uint256 in 18-decimal token units. The invitee's portion is paid as a separate GoodDollar
  -- ERC20 Transfer in the same transaction and appears in NO event field.
  --
  -- ATTRIBUTION HEALTH WARNING, added 2026-09-21.
  -- invitee_amount_g below is a HARDCODED CONSTANT, not an observation. Nothing in this model
  -- reads what the invitee was actually paid. If the protocol changes the base bounty, or a
  -- payout partially fails, every historical figure here becomes silently wrong and no test
  -- detects it. This is a known weakness, not a settled design.
  --
  -- The correct mechanism is to attribute both legs from the GD Transfer events emitted in the
  -- same transaction, matching to_address against the inviter and invitee from the event. That
  -- yields observed amounts, an explicit unattributed residual, and a free cross-check
  -- (transfer-derived inviter amount must equal bounty_paid). It is blocked only on ingesting
  -- TokenTransferEvents for this chain.
  --
  -- HOW TO VERIFY THE 500 IN THE MEANTIME, corrected 2026-09-21.
  -- A previous version of this comment said to call levels(0).bounty and divide by 1e18.
  -- THAT IS WRONG. levels(0) returns [0, 1000000000000000000000, 0]: the 1000 GD INVITER bounty
  -- at level 0, not the invitee's 500. Following that instruction would "confirm" 1000 and
  -- double reported invitee spend while feeling rigorous.
  -- The real check is to read the GD Transfer legs of a real bounty transaction and attribute
  -- them by recipient address. Verified against three transactions on 2026-09-21, each showing
  -- 1000 GD to the inviter and 500 GD to the invitee:
  --   0xb7a553c5be71ce971f56e8c3ea6b2fd949e0fbe51c6dc894657ae86abb820f30
  --   0xf95a1467fc3c88e7f96e9106b54d66869d97f972db3029d6b7d55799c8ae86a9
  --   0xa295a058b8234f8eac6681be80528812b02382e2d95d21f762c8aa7950411394
  -- Measured across every InviterBounty row in the warehouse: bounty_paid is 1000 GD and
  -- inviter_level is 0 on all 939 of them, so the level-based variation this model supports has
  -- never actually occurred on this chain.
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
FROM base
