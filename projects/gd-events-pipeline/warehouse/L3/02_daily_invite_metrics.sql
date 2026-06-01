-- L3: daily_invite_metrics (TABLE — full daily rebuild)
-- Sources: Semantic.invite_signups, Semantic.invite_payouts
-- Grain: 1 row per (metric_date, network)
-- See docs/02_DATA_MODEL.md §Marts.daily_invite_metrics

CREATE OR REPLACE TABLE `gooddollar.Marts.daily_invite_metrics`
PARTITION BY metric_date
CLUSTER BY network
AS

WITH daily_signups AS (
  SELECT
    DATE(block_timestamp) AS metric_date,
    network,
    COUNT(*)                                                                AS total_signups,
    COUNTIF(signup_type = 'referral')                                       AS referral_signups,
    COUNTIF(signup_type = 'campaign')                                       AS campaign_signups,
    COUNTIF(signup_type = 'no_code')                                        AS no_code_signups,
    COUNT(DISTINCT IF(signup_type = 'no_code',  user_address, NULL))        AS unique_inviters_joined,
    COUNT(DISTINCT IF(signup_type = 'referral', user_address, NULL))        AS unique_referral_invitees,
    COUNT(DISTINCT IF(signup_type = 'campaign', user_address, NULL))        AS unique_campaign_invitees
  FROM `gooddollar.Semantic.invite_signups`
  GROUP BY 1, 2
),

daily_payouts AS (
  SELECT
    DATE(block_timestamp) AS metric_date,
    network,
    COUNT(*)                                                                            AS total_bounties,
    COUNTIF(payout_origin = 'referral')                                                 AS referral_bounties,
    COUNTIF(payout_origin = 'campaign')                                                 AS campaign_bounties,
    SUM(total_amount_g)                                                                 AS total_expenditure_g,
    SUM(invitee_amount_g)                                                               AS paid_to_invitees_g,
    SUM(COALESCE(inviter_amount_g, 0))                                                  AS paid_to_inviters_g,
    -- Notional: G$1000 retained by contract on each campaign payout (never disbursed)
    COUNTIF(payout_origin = 'campaign') * CAST(1000 AS BIGNUMERIC)                      AS notional_campaign_retained_g,
    COUNT(DISTINCT invitee_address)                                                     AS unique_invitees_paid,
    COUNT(DISTINCT IF(payout_origin = 'referral', inviter_address, NULL))               AS unique_inviters_paid
  FROM `gooddollar.Semantic.invite_payouts`
  GROUP BY 1, 2
),

-- Spine of all dates × networks present in either source
date_spine AS (
  SELECT DISTINCT metric_date, network FROM daily_signups
  UNION DISTINCT
  SELECT DISTINCT metric_date, network FROM daily_payouts
)

SELECT
  d.metric_date,
  d.network,

  -- Daily metrics (16)
  COALESCE(s.total_signups,             0) AS daily_total_signups,
  COALESCE(s.referral_signups,          0) AS daily_referral_signups,
  COALESCE(s.campaign_signups,          0) AS daily_campaign_signups,
  COALESCE(s.no_code_signups,           0) AS daily_no_code_signups,
  COALESCE(s.unique_inviters_joined,    0) AS daily_unique_inviters_joined,
  COALESCE(s.unique_referral_invitees,  0) AS daily_unique_referral_invitees,
  COALESCE(s.unique_campaign_invitees,  0) AS daily_unique_campaign_invitees,
  COALESCE(p.total_bounties,            0) AS daily_total_bounties,
  COALESCE(p.referral_bounties,         0) AS daily_referral_bounties,
  COALESCE(p.campaign_bounties,         0) AS daily_campaign_bounties,
  COALESCE(p.total_expenditure_g,       CAST(0 AS BIGNUMERIC)) AS daily_total_expenditure_g,
  COALESCE(p.paid_to_invitees_g,        CAST(0 AS BIGNUMERIC)) AS daily_paid_to_invitees_g,
  COALESCE(p.paid_to_inviters_g,        CAST(0 AS BIGNUMERIC)) AS daily_paid_to_inviters_g,
  COALESCE(p.notional_campaign_retained_g, CAST(0 AS BIGNUMERIC)) AS daily_notional_campaign_retained_g,
  COALESCE(p.unique_invitees_paid,      0) AS daily_unique_invitees_paid,
  COALESCE(p.unique_inviters_paid,      0) AS daily_unique_inviters_paid,

  -- Cumulative metrics (8) — running totals from genesis to this date, per network
  SUM(COALESCE(s.total_signups,    0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC) AS cumulative_total_signups,
  SUM(COALESCE(s.referral_signups, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC) AS cumulative_referral_signups,
  SUM(COALESCE(s.campaign_signups, 0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC) AS cumulative_campaign_signups,
  SUM(COALESCE(s.no_code_signups,  0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC) AS cumulative_no_code_signups,
  SUM(COALESCE(p.total_bounties,   0))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC) AS cumulative_total_bounties,
  SUM(COALESCE(p.total_expenditure_g, CAST(0 AS BIGNUMERIC)))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC) AS cumulative_total_expenditure_g,
  SUM(COALESCE(p.paid_to_invitees_g,  CAST(0 AS BIGNUMERIC)))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC) AS cumulative_paid_to_invitees_g,
  SUM(COALESCE(p.paid_to_inviters_g,  CAST(0 AS BIGNUMERIC)))
    OVER (PARTITION BY d.network ORDER BY d.metric_date ASC) AS cumulative_paid_to_inviters_g

FROM date_spine d
LEFT JOIN daily_signups s USING (metric_date, network)
LEFT JOIN daily_payouts  p USING (metric_date, network)
;
