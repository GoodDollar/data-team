-- L3: invite_campaign_snapshot (TABLE — full daily rebuild)
-- Sources: Semantic.invitee, Semantic.invite_signups, Semantic.invite_payouts
-- Grain:   1 row (all-time aggregate snapshot)
-- See docs/02_DATA_MODEL.md §Marts.invite_campaign_snapshot

CREATE OR REPLACE TABLE `gooddollar.Marts.invite_campaign_snapshot`
AS

WITH invitee_stats AS (
  SELECT
    COUNT(*)                                                              AS total_invitees,
    COUNTIF(signup_type = 'referral')                                     AS total_referral_invitees,
    COUNTIF(signup_type = 'campaign')                                     AS total_campaign_invitees,
    COUNTIF(
      total_claims_on_invite_network >= 3
      AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), signup_timestamp, DAY) >= 7
      AND bounty_tx_hash IS NULL
    )                                                                     AS eligible_not_yet_paid,
    COUNTIF(bounty_tx_hash IS NOT NULL)                                   AS total_bounties_paid,
    COUNTIF(post_payout_claims_7d  >= 1 AND bounty_tx_hash IS NOT NULL)   AS retained_7d,
    COUNTIF(post_payout_claims_30d >= 1 AND bounty_tx_hash IS NOT NULL)   AS retained_30d,
    COUNTIF(total_claims_on_invite_network >= 3)                          AS total_converted
  FROM `gooddollar.Semantic.invitee`
  WHERE signup_type IN ('referral', 'campaign')
),

inviter_stats AS (
  SELECT
    COUNT(DISTINCT user_address) AS total_inviters_joined
  FROM `gooddollar.Semantic.invite_signups`
  WHERE signup_type = 'no_code'
),

payout_stats AS (
  SELECT
    CAST(SUM(total_amount_g)                AS FLOAT64) AS total_g_spent,
    CAST(SUM(invitee_amount_g)              AS FLOAT64) AS total_g_to_invitees,
    CAST(SUM(COALESCE(inviter_amount_g, 0)) AS FLOAT64) AS total_g_to_inviters
  FROM `gooddollar.Semantic.invite_payouts`
)

SELECT
  CURRENT_TIMESTAMP()                                                        AS snapshot_timestamp,
  i.total_invitees,
  i.total_referral_invitees,
  i.total_campaign_invitees,
  v.total_inviters_joined,
  i.total_bounties_paid,
  COALESCE(p.total_g_spent,        0.0)                                      AS total_g_spent,
  COALESCE(p.total_g_to_invitees,  0.0)                                      AS total_g_to_invitees,
  COALESCE(p.total_g_to_inviters,  0.0)                                      AS total_g_to_inviters,
  SAFE_DIVIDE(i.total_converted,   i.total_invitees)       * 100             AS conversion_rate_pct,
  i.eligible_not_yet_paid,
  SAFE_DIVIDE(i.retained_7d,  i.total_bounties_paid)       * 100             AS retention_rate_7d_pct,
  SAFE_DIVIDE(i.retained_30d, i.total_bounties_paid)       * 100             AS retention_rate_30d_pct
FROM invitee_stats  i
CROSS JOIN inviter_stats v
CROSS JOIN payout_stats  p;
