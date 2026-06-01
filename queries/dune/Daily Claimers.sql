https://dune.com/queries/4834229?sidebar=none

WITH first_claims AS (
  SELECT 
    claimer, 
    MIN(DATE(evt_block_time)) AS first_day
  FROM gooddollar_celo.ubischemev2_evt_ubiclaimed
  WHERE contract_address = {{UBI_Contract}}
  GROUP BY claimer
),

daily_activity AS (
  SELECT
    DATE(evt_block_time) AS day,
    claimer,
    CASE WHEN DATE(evt_block_time) = first_day THEN 1 ELSE 0 END AS is_new
  FROM gooddollar_celo.ubischemev2_evt_ubiclaimed
  INNER JOIN first_claims USING (claimer)
  WHERE DATE(evt_block_time) >= current_date - INTERVAL '{{Last_X_Days}}' DAY AND DATE(evt_block_time) < CURRENT_DATE
)

SELECT 
  day AS period_date,
  COUNT(DISTINCT claimer) AS unique_claimers, 
  COUNT(DISTINCT CASE WHEN is_new = 1 THEN claimer END) AS new_claimers,
  COUNT(DISTINCT CASE WHEN is_new = 0 THEN claimer END) AS returning_claimers
  
FROM daily_activity
GROUP BY 1
ORDER BY 1 DESC
LIMIT {{Last_X_Days}};
