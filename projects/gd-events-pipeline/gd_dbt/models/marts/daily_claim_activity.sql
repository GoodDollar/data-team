{{
  config(
    materialized  = 'table',
    partition_by  = {'field': 'metric_date', 'data_type': 'date'},
    cluster_by    = ['network']
  )
}}

/*
  L3 Mart: daily_claim_activity
  Source: semantic.claim_events (via ref)
  Grain: 1 row per (metric_date, network)
  Purpose: pre-aggregated daily claims for dashboard use.
  Equivalent to the current gooddollar.Marts.daily_claim_activity table.

  NOTE: cumulative_unique_claimers_approx overcounts repeat claimers because
  it sums daily uniques. True cumulative-distinct requires HLL or full scan.
  Acceptable for trend visualization; do not use for exact KPIs.
*/

WITH daily AS (
  SELECT
    DATE(block_timestamp)           AS metric_date,
    network,
    COUNT(*)                        AS daily_claims,
    COUNT(DISTINCT claimer_address) AS daily_unique_claimers,
    SUM(amount_g)                   AS daily_total_g_claimed,
    AVG(amount_g)                   AS avg_claim_amount_g
  FROM {{ ref('claim_events') }}
  GROUP BY 1, 2
)

SELECT
  metric_date,
  network,
  daily_claims,
  daily_unique_claimers,
  daily_total_g_claimed,
  avg_claim_amount_g,

  -- Running totals per network
  SUM(daily_claims)          OVER (PARTITION BY network ORDER BY metric_date) AS cumulative_claims,
  SUM(daily_unique_claimers) OVER (PARTITION BY network ORDER BY metric_date) AS cumulative_unique_claimers_approx,
  SUM(daily_total_g_claimed) OVER (PARTITION BY network ORDER BY metric_date) AS cumulative_total_g_claimed

FROM daily
