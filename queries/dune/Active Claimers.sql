https://dune.com/queries/4834304?sidebar=none

WITH daily_users AS (
  SELECT
    DATE(evt_block_time) AS day,
    claimer
  FROM gooddollar_celo.ubischemev2_evt_ubiclaimed
  WHERE contract_address = 0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1
    AND DATE(evt_block_time) BETWEEN CURRENT_DATE - INTERVAL '119' DAY
                               AND CURRENT_DATE - INTERVAL '1' DAY
),
rolling_metrics AS (
  SELECT 
    d.day, 
    COUNT(DISTINCT d.claimer) AS dau,
    (
      SELECT COUNT(DISTINCT claimer)
      FROM daily_users
      WHERE day BETWEEN d.day - INTERVAL '6' DAY AND d.day
    ) AS wau,
    (
      SELECT COUNT(DISTINCT claimer)
      FROM daily_users
      WHERE day BETWEEN d.day - INTERVAL '29' DAY AND d.day
    ) AS mau
  FROM daily_users d
  GROUP BY d.day
)
SELECT *
FROM rolling_metrics
WHERE day >= CURRENT_DATE - INTERVAL '90' DAY
ORDER BY day DESC;
