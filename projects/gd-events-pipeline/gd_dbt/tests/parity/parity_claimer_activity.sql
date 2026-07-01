{{ config(tags=['parity']) }}

/*
  Parity test: claimer_activity
  Compares dbt model vs production gooddollar.Semantic.claimer_activity.
  Returns rows on FAILURE (row count or aggregate drift).
*/

WITH dbt_stats AS (
  SELECT
    COUNT(*)             AS row_count,
    SUM(total_claims)    AS total_claims,
    SUM(total_amount_g)  AS total_g,
    SUM(active_days)     AS total_active_days
  FROM {{ ref('claimer_activity') }}
),

prod_stats AS (
  SELECT
    COUNT(*)             AS row_count,
    SUM(total_claims)    AS total_claims,
    SUM(total_amount_g)  AS total_g,
    SUM(active_days)     AS total_active_days
  FROM `gooddollar.Semantic.claimer_activity`
)

SELECT
  'claimer_activity' AS model,
  d.row_count         AS dbt_rows,        p.row_count         AS prod_rows,
  d.total_claims      AS dbt_claims,      p.total_claims      AS prod_claims,
  d.total_g           AS dbt_total_g,     p.total_g           AS prod_total_g,
  d.total_active_days AS dbt_active_days, p.total_active_days AS prod_active_days
FROM dbt_stats d, prod_stats p
WHERE d.row_count         != p.row_count
   OR d.total_claims      != p.total_claims
   OR d.total_g           != p.total_g
   OR d.total_active_days != p.total_active_days
