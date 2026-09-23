{{
  config(
    materialized  = 'table',
    partition_by  = {'field': 'cohort_week', 'data_type': 'date'},
    cluster_by    = ['network']
  )
}}

-- L3 Mart: weekly_claimer_retention
-- Grain: 1 row per (cohort_week, network, weeks_since_first)
-- Purpose: cohort retention matrix for heatmap visualization.
-- Shows what % of each weekly cohort is still claiming N weeks later.

WITH claimer_cohorts AS (
  SELECT
    claimer_address,
    network,
    DATE_TRUNC(DATE(block_timestamp), WEEK(MONDAY)) AS cohort_week
  FROM {{ ref('claim_events') }}
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY claimer_address, network ORDER BY block_timestamp
  ) = 1
),

claimer_weekly_activity AS (
  SELECT DISTINCT
    claimer_address,
    network,
    DATE_TRUNC(DATE(block_timestamp), WEEK(MONDAY)) AS activity_week
  FROM {{ ref('claim_events') }}
),

retention_raw AS (
  SELECT
    c.cohort_week,
    c.network,
    DATE_DIFF(a.activity_week, c.cohort_week, WEEK) AS weeks_since_first,
    COUNT(DISTINCT a.claimer_address) AS active_claimers
  FROM claimer_cohorts c
  INNER JOIN claimer_weekly_activity a
    ON c.claimer_address = a.claimer_address
    AND c.network = a.network
    AND a.activity_week >= c.cohort_week
  GROUP BY 1, 2, 3
),

cohort_sizes AS (
  SELECT
    cohort_week,
    network,
    COUNT(*) AS cohort_size
  FROM claimer_cohorts
  GROUP BY 1, 2
)

SELECT
  r.cohort_week,
  r.network,
  cs.cohort_size,
  r.weeks_since_first,
  r.active_claimers,
  ROUND(r.active_claimers / cs.cohort_size * 100, 1) AS retention_pct
FROM retention_raw r
JOIN cohort_sizes cs
  ON r.cohort_week = cs.cohort_week
  AND r.network = cs.network
WHERE r.weeks_since_first BETWEEN 0 AND 12
