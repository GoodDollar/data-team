{{ config(tags=['parity']) }}

/*
  Parity test: claim_events
  Compares dbt model vs production gooddollar.Semantic.claim_events
  Returns rows on FAILURE (row count mismatch or metric drift).
*/

WITH dbt_stats AS (
  SELECT
    COUNT(*) AS row_count,
    SUM(amount_g) AS total_g
  FROM {{ ref('claim_events') }}
),

prod_stats AS (
  SELECT
    COUNT(*) AS row_count,
    SUM(amount_g) AS total_g
  FROM `gooddollar.Semantic.claim_events`
)

SELECT
  'claim_events' AS model,
  d.row_count AS dbt_rows,
  p.row_count AS prod_rows,
  d.total_g AS dbt_total_g,
  p.total_g AS prod_total_g
FROM dbt_stats d, prod_stats p
WHERE d.row_count != p.row_count
   OR d.total_g != p.total_g
