-- L3: daily_claim_activity (TABLE — full daily rebuild)
-- Source: Semantic.claim_events (NOT raw L1)
-- Grain: 1 row per (metric_date, network)
-- See docs/02_DATA_MODEL.md §Marts.daily_claim_activity

CREATE OR REPLACE TABLE `gooddollar.Marts.daily_claim_activity`
PARTITION BY metric_date
CLUSTER BY network
AS

WITH daily AS (
  SELECT
    DATE(block_timestamp)              AS metric_date,
    network,
    COUNT(*)                           AS daily_claims,
    COUNT(DISTINCT claimer_address)    AS daily_unique_claimers,
    SUM(amount_g)                      AS daily_total_g_claimed,
    AVG(amount_g)                      AS avg_claim_amount_g
  FROM `gooddollar.Semantic.claim_events`
  GROUP BY 1, 2
)

SELECT
  metric_date,
  network,
  daily_claims,
  daily_unique_claimers,
  daily_total_g_claimed,
  avg_claim_amount_g,

  -- Cumulative (running totals per network)
  SUM(daily_claims)              OVER (PARTITION BY network ORDER BY metric_date) AS cumulative_claims,
  -- NOTE: cumulative_unique_claimers_approx overcounts repeat claimers because
  --       it sums daily uniques. True cumulative-distinct requires HLL or full
  --       scan. Acceptable for trend visualization; do not use for exact KPIs.
  SUM(daily_unique_claimers)     OVER (PARTITION BY network ORDER BY metric_date) AS cumulative_unique_claimers_approx,
  SUM(daily_total_g_claimed)     OVER (PARTITION BY network ORDER BY metric_date) AS cumulative_total_g_claimed

FROM daily
;
