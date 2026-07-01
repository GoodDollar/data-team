{{ config(tags=['parity']) }}

/*
  Parity test: invite_signups
  Compares dbt model vs production gooddollar.Semantic.invite_signups
  Returns rows on FAILURE (row count mismatch or signup_type distribution drift).
*/

WITH dbt_stats AS (
  SELECT
    COUNT(*) AS row_count,
    COUNTIF(signup_type = 'referral') AS referral_count,
    COUNTIF(signup_type = 'campaign') AS campaign_count,
    COUNTIF(signup_type = 'no_code') AS no_code_count
  FROM {{ ref('invite_signups') }}
),

prod_stats AS (
  SELECT
    COUNT(*) AS row_count,
    COUNTIF(signup_type = 'referral') AS referral_count,
    COUNTIF(signup_type = 'campaign') AS campaign_count,
    COUNTIF(signup_type = 'no_code') AS no_code_count
  FROM `gooddollar.Semantic.invite_signups`
)

SELECT
  'invite_signups' AS model,
  d.row_count AS dbt_rows,
  p.row_count AS prod_rows,
  d.referral_count AS dbt_referral,
  p.referral_count AS prod_referral,
  d.campaign_count AS dbt_campaign,
  p.campaign_count AS prod_campaign,
  d.no_code_count AS dbt_no_code,
  p.no_code_count AS prod_no_code
FROM dbt_stats d, prod_stats p
WHERE d.row_count != p.row_count
   OR d.referral_count != p.referral_count
   OR d.campaign_count != p.campaign_count
   OR d.no_code_count != p.no_code_count
