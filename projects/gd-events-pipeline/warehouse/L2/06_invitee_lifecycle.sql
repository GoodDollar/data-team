-- L2: invitee_lifecycle (VIEW)
-- Sources: Semantic.invite_signups, Semantic.claim_events, Semantic.invite_payouts
-- Purpose: cross-domain join. For each invitee, joins signup → post-signup claims → payout.
--          The core entity for funnel analysis.
-- Scope:   only signup_type IN ('referral', 'campaign'). no_code signups excluded
--          (they are joining as inviters, not invitees).
-- See docs/02_DATA_MODEL.md §Semantic.invitee_lifecycle

CREATE OR REPLACE VIEW `gooddollar.Semantic.invitee_lifecycle` AS

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
    FROM `gooddollar.Semantic.invite_signups`
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
  JOIN `gooddollar.Semantic.claim_events` c
    ON c.claimer_address = s.invitee_address
   AND c.network          = s.signup_network
   AND c.block_timestamp  > s.signup_timestamp
  GROUP BY s.invitee_address
),

-- 3. Cross-network claim count for broader activity signal
all_network_claims AS (
  SELECT
    s.invitee_address,
    COUNT(*) AS total_claims_all_networks
  FROM deduped_signups s
  JOIN `gooddollar.Semantic.claim_events` c
    ON c.claimer_address = s.invitee_address
   AND c.block_timestamp  > s.signup_timestamp
  GROUP BY s.invitee_address
),

-- 4. Bounty payout per invitee (at most one)
invitee_payouts AS (
  SELECT
    invitee_address,
    tx_hash         AS bounty_tx_hash,
    block_timestamp AS bounty_timestamp,
    total_amount_g  AS bounty_total_amount_g
  FROM `gooddollar.Semantic.invite_payouts`
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
  p.bounty_total_amount_g

FROM deduped_signups s
LEFT JOIN same_network_claims snc ON s.invitee_address = snc.invitee_address
LEFT JOIN all_network_claims  anc ON s.invitee_address = anc.invitee_address
LEFT JOIN invitee_payouts     p   ON s.invitee_address = p.invitee_address;
