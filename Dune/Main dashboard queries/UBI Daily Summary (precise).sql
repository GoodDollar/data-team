https://dune.com/queries/5710738?sidebar=none

-- UBI daily summary (UTC) for the last {{Last_X_Days}} days

WITH params AS (
  SELECT
    FROM_HEX('43d72ff17701b2da814620735c39c620ce0ea4a1') AS UBI_CONTRACT,
    FROM_HEX('62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a') AS G_TOKEN,
    CURRENT_DATE - INTERVAL '{{Last_X_Days}}' DAY AS start_utc,
    CURRENT_DATE - INTERVAL '1' DAY AS end_utc,
    CURRENT_DATE - INTERVAL '{{Last_X_Days}}' DAY - INTERVAL '29' DAY AS window_start_utc
),

claims AS (
  SELECT CAST(evt_block_date AS DATE) AS day_utc, claimer, amount * 1e-18 AS amt_gd
  FROM gooddollar_celo.ubischemev2_evt_ubiclaimed
  WHERE contract_address = (SELECT UBI_CONTRACT FROM params)
    AND CAST(evt_block_date AS DATE) <= (SELECT end_utc FROM params)
),

per_user_day AS (
  SELECT day_utc, claimer, SUM(amt_gd) AS claimed_gd
  FROM claims
  GROUP BY 1,2
),

daily_totals AS (
  SELECT day_utc, SUM(claimed_gd) AS gd_day
  FROM per_user_day
  GROUP BY 1
),

price_day AS (
  SELECT CAST(d.timestamp AS DATE) AS day_utc, AVG(d.price) AS gd_usd
  FROM prices.day d
  WHERE d.blockchain = 'celo'
    AND d.contract_address = (SELECT G_TOKEN FROM params)
  GROUP BY 1
),

-- FIXED: use explicit ON so dt.day_utc is resolvable
pre_all AS (
  SELECT
    COALESCE(SUM(dt.gd_day), 0.0) AS pre_all_gd,
    COALESCE(SUM(dt.gd_day * COALESCE(p.gd_usd,0)),0) AS pre_all_usd
  FROM daily_totals dt
  LEFT JOIN price_day p ON p.day_utc = dt.day_utc
  WHERE dt.day_utc < (SELECT window_start_utc FROM params)
),

all_days AS (
  SELECT d AS day_utc
  FROM params,
       UNNEST(sequence(window_start_utc, end_utc, INTERVAL '1' DAY)) AS t(d)
),

daily_filled AS (
  SELECT
    a.day_utc,
    COALESCE(dt.gd_day, 0.0) AS gd_day,
    COALESCE(p.gd_usd, 0.0)  AS gd_usd
  FROM all_days a
  LEFT JOIN daily_totals dt ON dt.day_utc = a.day_utc
  LEFT JOIN price_day   p  ON p.day_utc  = a.day_utc
),

median_by_day AS (
  SELECT day_utc, approx_percentile(claimed_gd, 0.5) AS gd_user_median
  FROM per_user_day
  WHERE day_utc BETWEEN (SELECT window_start_utc FROM params) AND (SELECT end_utc FROM params)
  GROUP BY 1
),

unique_7d AS (
  SELECT a.day_utc, COUNT(DISTINCT pud.claimer) AS uniq_7d
  FROM all_days a
  LEFT JOIN per_user_day pud
    ON pud.day_utc BETWEEN a.day_utc - INTERVAL '6' DAY AND a.day_utc
  GROUP BY 1
),
unique_30d AS (
  SELECT a.day_utc, COUNT(DISTINCT pud.claimer) AS uniq_30d
  FROM all_days a
  LEFT JOIN per_user_day pud
    ON pud.day_utc BETWEEN a.day_utc - INTERVAL '29' DAY AND a.day_utc
  GROUP BY 1
),

metrics AS (
  SELECT
    f.day_utc AS date,
    (SELECT pre_all_gd  FROM pre_all)
      + SUM(f.gd_day)            OVER (ORDER BY f.day_utc ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      AS total_gd_claimed_all_time,
    (SELECT pre_all_usd FROM pre_all)
      + SUM(f.gd_day * f.gd_usd) OVER (ORDER BY f.day_utc ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      AS total_usd_claimed_all_time,

    SUM(f.gd_day)            OVER (ORDER BY f.day_utc ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS gd_claimed_last_30d,
    SUM(f.gd_day * f.gd_usd) OVER (ORDER BY f.day_utc ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS usd_claimed_last_30d,

    SUM(f.gd_day)            OVER (ORDER BY f.day_utc ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)  AS gd_claimed_last_7d,
    SUM(f.gd_day * f.gd_usd) OVER (ORDER BY f.day_utc ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)  AS usd_claimed_last_7d,

    f.gd_day AS gd_claimed_last_1d,
    f.gd_day * f.gd_usd AS usd_claimed_last_1d,

    COALESCE(m.gd_user_median, 0.0) AS gd_per_user_day
  FROM daily_filled f
  LEFT JOIN median_by_day m ON m.day_utc = f.day_utc
)

SELECT
  me.date                                                     AS "Date",
  me.total_gd_claimed_all_time                                AS "Total G$ claimed (all time)",
  me.total_usd_claimed_all_time                               AS "total G$ claimed USD (all time)",

  me.gd_claimed_last_30d                                      AS "total G$ claimed last 30d (by all users)",
  me.usd_claimed_last_30d                                     AS "total G$ claimed USD last 30d (by all users)",
  (me.gd_claimed_last_30d / NULLIF(u30.uniq_30d, 0))          AS "G$/user/30d",

  me.gd_claimed_last_7d                                       AS "total G$ claimed last 7d (by all users)",
  me.usd_claimed_last_7d                                      AS "total G$ claimed USD last 7d (by all users)",
  (me.gd_claimed_last_7d / NULLIF(u7.uniq_7d, 0))             AS "G$/user/7d",

  me.gd_claimed_last_1d                                       AS "total G$ claimed last 1d (by all users)",
  me.usd_claimed_last_1d                                      AS "total G$ claimed USD last 1d (by all users)",
  me.gd_per_user_day                                          AS "G$/user/day"
FROM metrics me
JOIN all_days d       ON d.day_utc = me.date
LEFT JOIN unique_7d  u7  ON u7.day_utc  = me.date
LEFT JOIN unique_30d u30 ON u30.day_utc = me.date
WHERE me.date BETWEEN (SELECT start_utc FROM params) AND (SELECT end_utc FROM params)
ORDER BY me.date DESC;
