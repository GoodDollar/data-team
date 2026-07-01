{{
  config(
    materialized = 'view',
    alias = 'invitee'
  )
}}

/*
  L2 Semantic: invitee_lifecycle
  Sources: semantic.invite_signups, semantic.claim_events, semantic.invite_payouts (via ref)
  Purpose: cross-domain join. For each invitee, joins signup → post-signup claims → payout →
           post-payout retention. The core entity for funnel analysis.
  Grain:   1 row per invitee_address. Scoped to signup_type IN ('referral', 'campaign').
  Materializes as gooddollar.Semantic.invitee (alias) — preserves the production table name
  and column set (16 cols incl. post_payout_claims_7d/30d) so Looker keeps working unchanged.
  See docs/02_DATA_MODEL.md §Semantic.invitee_lifecycle
*/

-- 1. One canonical signup row per invitee. Defensive dedup: if the same wallet
--    appears as invitee twice (contract should prevent this), keep the earliest.
WITH deduped_signups AS (
  SELECT
    user_address      AS invitee_address,
    inviter_address,
    signup_type,
    network           AS signup_network,
    chain_id          AS signup_chain_id,
    tx_hash           AS signup_tx_hash,
    block_timestamp   AS signup_timestamp
  FROM (
    SELECT
      *,
      ROW_NUMBER() OVER (
        PARTITION BY user_address
        ORDER BY block_timestamp ASC
      ) AS rn
    FROM {{ ref('invite_signups') }}
    WHERE signup_type IN ('referral', 'campaign')
  )
  WHERE rn = 1
),

-- 2. Per-invitee claim aggregation on the SAME network as their signup
--    (the invite contract on each chain reads claim state only from that chain).
same_network_claims AS (
  SELECT
    s.invitee_address,
    MIN(c.block_timestamp) AS first_claim_timestamp,
    MAX(c.block_timestamp) AS latest_claim_timestamp,
    COUNT(*)               AS total_claims_on_invite_network
  FROM deduped_signups s
  JOIN {{ ref('claim_events') }} c
    ON  c.claimer_address = s.invitee_address
   AND c.network          = s.signup_network
   AND c.block_timestamp  > s.signup_timestamp
  GROUP BY s.invitee_address
),

-- 3. Cross-network claim count for broader activity signal.
all_network_claims AS (
  SELECT
    s.invitee_address,
    COUNT(*) AS total_claims_all_networks
  FROM deduped_signups s
  JOIN {{ ref('claim_events') }} c
    ON  c.claimer_address = s.invitee_address
   AND c.block_timestamp  > s.signup_timestamp
  GROUP BY s.invitee_address
),

-- 4. Bounty payout per invitee (at most one per contract design).
--    Dedup guard: if the contract emits two payouts for the same invitee,
--    keep the earliest — preserves the 1-row-per-invitee grain (EC9).
invitee_payouts AS (
  SELECT
    invitee_address,
    tx_hash         AS bounty_tx_hash,
    block_timestamp AS bounty_timestamp,
    total_amount_g  AS bounty_total_amount_g
  FROM (
    SELECT
      invitee_address,
      tx_hash,
      block_timestamp,
      total_amount_g,
      ROW_NUMBER() OVER (PARTITION BY invitee_address ORDER BY block_timestamp ASC) AS rn
    FROM {{ ref('invite_payouts') }}
  )
  WHERE rn = 1
),

-- 5. Post-payout retention: count of claim events in the 7-day and 30-day windows
--    after bounty payment. Only populated for paid invitees.
--    Joins deduped_signups to obtain signup_network for the claim filter.
post_payout_claims AS (
  SELECT
    p.invitee_address,
    COUNTIF(c.block_timestamp <= TIMESTAMP_ADD(p.bounty_timestamp, INTERVAL 7 DAY))
      AS post_payout_claims_7d,
    COUNTIF(c.block_timestamp <= TIMESTAMP_ADD(p.bounty_timestamp, INTERVAL 30 DAY))
      AS post_payout_claims_30d
  FROM invitee_payouts p
  JOIN deduped_signups ds
    ON  ds.invitee_address = p.invitee_address
  JOIN {{ ref('claim_events') }} c
    ON  c.claimer_address  = p.invitee_address
   AND c.network           = ds.signup_network
   AND c.block_timestamp   > p.bounty_timestamp
   AND c.block_timestamp   <= TIMESTAMP_ADD(p.bounty_timestamp, INTERVAL 30 DAY)
  GROUP BY p.invitee_address
)

SELECT
  s.invitee_address,
  s.inviter_address,
  s.signup_type,
  s.signup_network,
  s.signup_chain_id,
  s.signup_tx_hash,
  s.signup_timestamp,

  snc.first_claim_timestamp,
  snc.latest_claim_timestamp,
  COALESCE(snc.total_claims_on_invite_network, 0) AS total_claims_on_invite_network,
  COALESCE(anc.total_claims_all_networks,       0) AS total_claims_all_networks,

  p.bounty_tx_hash,
  p.bounty_timestamp,
  p.bounty_total_amount_g,

  -- post_payout_claims_7d / 30d:
  --   NULL  when bounty_tx_hash IS NULL (no payout; retention window undefined — not zero)
  --   0     when bounty exists but no claims fell within the window
  --   N     when bounty exists and N claims fell within the window
  -- The outer CASE WHEN is required (spec FC11): plain COALESCE would wrongly
  -- convert no-payout rows to 0.
  CASE WHEN p.bounty_tx_hash IS NOT NULL
       THEN COALESCE(ppc.post_payout_claims_7d, 0)
       ELSE NULL
  END AS post_payout_claims_7d,

  CASE WHEN p.bounty_tx_hash IS NOT NULL
       THEN COALESCE(ppc.post_payout_claims_30d, 0)
       ELSE NULL
  END AS post_payout_claims_30d

FROM deduped_signups s
LEFT JOIN same_network_claims snc ON s.invitee_address = snc.invitee_address
LEFT JOIN all_network_claims  anc ON s.invitee_address = anc.invitee_address
LEFT JOIN invitee_payouts     p   ON s.invitee_address = p.invitee_address
LEFT JOIN post_payout_claims  ppc ON s.invitee_address = ppc.invitee_address
