{{ config(tags=['parity']) }}

/*
  Parity test: daily_invite_metrics
  Compares dbt mart vs production gooddollar.Marts.daily_invite_metrics
  Only compares dates present in production (production may be stale).
  Returns rows on FAILURE (metric mismatch on overlapping dates).
*/

WITH prod AS (
  SELECT
    metric_date,
    network,
    daily_total_signups,
    daily_total_bounties,
    daily_total_expenditure_g
  FROM `gooddollar.Marts.daily_invite_metrics`
),

dbt_model AS (
  SELECT
    metric_date,
    network,
    daily_total_signups,
    daily_total_bounties,
    daily_total_expenditure_g
  FROM {{ ref('daily_invite_metrics') }}
)

-- Return rows where production and dbt disagree on overlapping dates
SELECT
  p.metric_date,
  p.network,
  p.daily_total_signups AS prod_signups,
  d.daily_total_signups AS dbt_signups,
  p.daily_total_bounties AS prod_bounties,
  d.daily_total_bounties AS dbt_bounties,
  p.daily_total_expenditure_g AS prod_exp,
  d.daily_total_expenditure_g AS dbt_exp
FROM prod p
JOIN dbt_model d
  ON p.metric_date = d.metric_date
 AND p.network = d.network
WHERE p.daily_total_signups != d.daily_total_signups
   OR p.daily_total_bounties != d.daily_total_bounties
   OR p.daily_total_expenditure_g != d.daily_total_expenditure_g
