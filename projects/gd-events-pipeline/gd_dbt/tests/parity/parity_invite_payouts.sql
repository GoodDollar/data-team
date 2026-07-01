{{ config(tags=['parity']) }}

/*
  Parity test: invite_payouts
  Compares dbt model vs production gooddollar.Semantic.invite_payouts.
  Returns rows on FAILURE (row count or amount drift).
*/

WITH dbt_stats AS (
  SELECT
    COUNT(*)                              AS row_count,
    COUNTIF(payout_origin = 'referral')   AS referral_count,
    COUNTIF(payout_origin = 'campaign')   AS campaign_count,
    SUM(total_amount_g)                   AS total_g,
    SUM(COALESCE(inviter_amount_g, 0))    AS inviter_g
  FROM {{ ref('invite_payouts') }}
),

prod_stats AS (
  SELECT
    COUNT(*)                              AS row_count,
    COUNTIF(payout_origin = 'referral')   AS referral_count,
    COUNTIF(payout_origin = 'campaign')   AS campaign_count,
    SUM(total_amount_g)                   AS total_g,
    SUM(COALESCE(inviter_amount_g, 0))    AS inviter_g
  FROM `gooddollar.Semantic.invite_payouts`
)

SELECT
  'invite_payouts' AS model,
  d.row_count      AS dbt_rows,     p.row_count      AS prod_rows,
  d.referral_count AS dbt_referral, p.referral_count AS prod_referral,
  d.campaign_count AS dbt_campaign, p.campaign_count AS prod_campaign,
  d.total_g        AS dbt_total_g,  p.total_g        AS prod_total_g,
  d.inviter_g      AS dbt_inviter_g, p.inviter_g     AS prod_inviter_g
FROM dbt_stats d, prod_stats p
WHERE d.row_count      != p.row_count
   OR d.referral_count != p.referral_count
   OR d.campaign_count != p.campaign_count
   OR d.total_g        != p.total_g
   OR d.inviter_g      != p.inviter_g
