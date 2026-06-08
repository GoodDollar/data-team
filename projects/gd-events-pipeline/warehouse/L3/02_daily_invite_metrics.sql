-- L3: daily_invite_metrics (TABLE — idempotent MERGE, gap-tolerant)
-- Sources: Semantic.invite_signups, Semantic.invite_payouts
-- Grain:   1 row per (metric_date, network, chain_id)
-- Strategy: MERGE all past dates (< CURRENT_DATE) from L1 that are not yet in the table.
--           WHEN NOT MATCHED BY TARGET → INSERT only. No UPDATE, no DELETE.
--           Idempotent: re-running never creates duplicates.
--           Gap-tolerant: if ingest misses a day, the next run fills it automatically.
-- Migration: the one-time schema migration (DROP → CREATE → backfill INSERT) is an
--            out-of-band procedure documented in specs/invites/plan.md Phase 3.1.
-- See docs/02_DATA_MODEL.md §Marts.daily_invite_metrics

MERGE `gooddollar.Marts.daily_invite_metrics` T
USING (

  WITH daily_signups AS (
    SELECT
      DATE(block_timestamp)                                                     AS metric_date,
      network,
      chain_id,
      COUNT(*)                                                                  AS total_signups,
      COUNTIF(signup_type = 'referral')                                         AS referral_signups,
      COUNTIF(signup_type = 'campaign')                                         AS campaign_signups,
      COUNTIF(signup_type = 'no_code')                                          AS no_code_signups,
      COUNT(DISTINCT IF(signup_type = 'no_code',  user_address, NULL))          AS unique_inviters_joined,
      COUNT(DISTINCT IF(signup_type = 'referral', user_address, NULL))          AS unique_referral_invitees,
      COUNT(DISTINCT IF(signup_type = 'campaign', user_address, NULL))          AS unique_campaign_invitees
    FROM `gooddollar.Semantic.invite_signups`
    WHERE DATE(block_timestamp) < CURRENT_DATE()
    GROUP BY 1, 2, 3
  ),

  daily_payouts AS (
    SELECT
      DATE(block_timestamp)                                                     AS metric_date,
      network,
      chain_id,
      COUNT(*)                                                                  AS total_bounties,
      COUNTIF(payout_origin = 'referral')                                       AS referral_bounties,
      COUNTIF(payout_origin = 'campaign')                                       AS campaign_bounties,
      CAST(SUM(total_amount_g)                         AS FLOAT64)              AS total_expenditure_g,
      CAST(SUM(invitee_amount_g)                       AS FLOAT64)              AS paid_to_invitees_g,
      CAST(SUM(COALESCE(inviter_amount_g, 0))          AS FLOAT64)              AS paid_to_inviters_g,
      COUNT(DISTINCT invitee_address)                                           AS unique_invitees_paid,
      COUNT(DISTINCT IF(payout_origin = 'referral', inviter_address, NULL))     AS unique_inviters_paid
    FROM `gooddollar.Semantic.invite_payouts`
    WHERE DATE(block_timestamp) < CURRENT_DATE()
    GROUP BY 1, 2, 3
  ),

  date_spine AS (
    SELECT DISTINCT metric_date, network, chain_id FROM daily_signups
    UNION DISTINCT
    SELECT DISTINCT metric_date, network, chain_id FROM daily_payouts
  )

  SELECT
    d.metric_date,
    d.network,
    d.chain_id,
    COALESCE(s.total_signups,              0)   AS daily_total_signups,
    COALESCE(s.referral_signups,           0)   AS daily_referral_signups,
    COALESCE(s.campaign_signups,           0)   AS daily_campaign_signups,
    COALESCE(s.no_code_signups,            0)   AS daily_no_code_signups,
    COALESCE(s.unique_inviters_joined,     0)   AS daily_unique_inviters_joined,
    COALESCE(s.unique_referral_invitees,   0)   AS daily_unique_referral_invitees,
    COALESCE(s.unique_campaign_invitees,   0)   AS daily_unique_campaign_invitees,
    COALESCE(p.total_bounties,             0)   AS daily_total_bounties,
    COALESCE(p.referral_bounties,          0)   AS daily_referral_bounties,
    COALESCE(p.campaign_bounties,          0)   AS daily_campaign_bounties,
    COALESCE(p.total_expenditure_g,        0.0) AS daily_total_expenditure_g,
    COALESCE(p.paid_to_invitees_g,         0.0) AS daily_paid_to_invitees_g,
    COALESCE(p.paid_to_inviters_g,         0.0) AS daily_paid_to_inviters_g,
    COALESCE(p.unique_invitees_paid,       0)   AS daily_unique_invitees_paid,
    COALESCE(p.unique_inviters_paid,       0)   AS daily_unique_inviters_paid
  FROM date_spine d
  LEFT JOIN daily_signups s USING (metric_date, network, chain_id)
  LEFT JOIN daily_payouts  p USING (metric_date, network, chain_id)

) S
ON  T.metric_date = S.metric_date
AND T.network     = S.network
AND T.chain_id    = S.chain_id
WHEN NOT MATCHED BY TARGET THEN INSERT ROW;
