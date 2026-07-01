{{ config(tags=['parity']) }}

/*
  Parity test: invitee_lifecycle (materializes as Semantic.invitee)
  Compares dbt model vs production gooddollar.Semantic.invitee.
  Guards the restored 16-column set — especially post_payout_claims_7d/30d,
  which were missing before the migration fix.
  Returns rows on FAILURE (row count or aggregate drift).
*/

WITH dbt_stats AS (
  SELECT
    COUNT(*)                              AS row_count,
    COUNTIF(bounty_tx_hash IS NOT NULL)   AS paid_count,
    SUM(total_claims_on_invite_network)   AS total_claims,
    SUM(post_payout_claims_7d)            AS sum_retained_7d,
    SUM(post_payout_claims_30d)           AS sum_retained_30d
  FROM {{ ref('invitee_lifecycle') }}
),

prod_stats AS (
  SELECT
    COUNT(*)                              AS row_count,
    COUNTIF(bounty_tx_hash IS NOT NULL)   AS paid_count,
    SUM(total_claims_on_invite_network)   AS total_claims,
    SUM(post_payout_claims_7d)            AS sum_retained_7d,
    SUM(post_payout_claims_30d)           AS sum_retained_30d
  FROM `gooddollar.Semantic.invitee`
)

SELECT
  'invitee' AS model,
  d.row_count       AS dbt_rows,       p.row_count       AS prod_rows,
  d.paid_count      AS dbt_paid,       p.paid_count      AS prod_paid,
  d.total_claims    AS dbt_claims,     p.total_claims    AS prod_claims,
  d.sum_retained_7d AS dbt_ret7,       p.sum_retained_7d AS prod_ret7,
  d.sum_retained_30d AS dbt_ret30,     p.sum_retained_30d AS prod_ret30
FROM dbt_stats d, prod_stats p
WHERE d.row_count       != p.row_count
   OR d.paid_count      != p.paid_count
   OR d.total_claims    != p.total_claims
   OR d.sum_retained_7d != p.sum_retained_7d
   OR d.sum_retained_30d != p.sum_retained_30d
