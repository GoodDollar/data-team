https://dune.com/queries/5521377?sidebar=none

-- P2P transfers (EOA↔EOA) + OTP, de-duplicated, with daily USD conversion
-- Param: {{days_lookback}} (INTEGER)
WITH params AS (
  SELECT
    FROM_HEX('62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a') AS g_token, -- G$ on Celo
    CAST({{days_lookback}} AS INTEGER)                  AS days_lookback
),
contracts AS (
  SELECT DISTINCT address AS contract_address FROM celo.creation_traces
),

-- Direct EOA<->EOA (exclude OTP txs), windowed and excluding today
direct_p2p AS (
  SELECT
    t.evt_block_date AS date,
    COUNT(*) AS tx_count,
    SUM(t.value) * 1e-18 AS amount_gd,
    COUNT(DISTINCT t."from") AS unique_senders,
    COUNT(DISTINCT t."to")   AS unique_receivers
  FROM gooddollar_celo.supergooddollar_evt_transfer t
  LEFT JOIN contracts c_from ON t."from" = c_from.contract_address
  LEFT JOIN contracts c_to   ON t."to"   = c_to.contract_address
  CROSS JOIN params p
  WHERE c_from.contract_address IS NULL
    AND c_to.contract_address   IS NULL
    AND t."from" <> t."to"
    AND t.evt_block_date >= CURRENT_DATE - INTERVAL '1' DAY * p.days_lookback
    AND t.evt_block_date <  CURRENT_DATE
    AND NOT EXISTS (
      SELECT 1
      FROM gooddollar_celo.onetimepayments_evt_paymentwithdraw w
      WHERE w.evt_tx_hash = t.evt_tx_hash
    )
  GROUP BY t.evt_block_date
),

-- OTP aggregates (amount/tx count)
otp_p2p AS (
  SELECT
    w.evt_block_date AS date,
    COUNT(*) AS tx_count,
    SUM(w.amount) * 1e-18 AS amount_gd
  FROM gooddollar_celo.onetimepayments_evt_paymentwithdraw w
  CROSS JOIN params p
  WHERE w.evt_block_date >= CURRENT_DATE - INTERVAL '1' DAY * p.days_lookback
    AND w.evt_block_date <  CURRENT_DATE
  GROUP BY w.evt_block_date
),

-- OTP recipients via matching ERC20 Transfer in same tx
otp_receivers AS (
  SELECT
    w.evt_block_date AS date,
    COUNT(DISTINCT t."to") AS unique_receivers
  FROM gooddollar_celo.onetimepayments_evt_paymentwithdraw w
  JOIN gooddollar_celo.supergooddollar_evt_transfer t
    ON t.evt_tx_hash = w.evt_tx_hash
  CROSS JOIN params p
  WHERE w.evt_block_date >= CURRENT_DATE - INTERVAL '1' DAY * p.days_lookback
    AND w.evt_block_date <  CURRENT_DATE
  GROUP BY w.evt_block_date
),

-- Distinct daily users across direct (senders/receivers) + OTP recipients
daily_users AS (
  SELECT date, addr FROM (
    SELECT t.evt_block_date AS date, t."from" AS addr
    FROM gooddollar_celo.supergooddollar_evt_transfer t
    LEFT JOIN contracts c_from ON t."from" = c_from.contract_address
    LEFT JOIN contracts c_to   ON t."to"   = c_to.contract_address
    CROSS JOIN params p
    WHERE c_from.contract_address IS NULL
      AND c_to.contract_address   IS NULL
      AND t."from" <> t."to"
      AND t.evt_block_date >= CURRENT_DATE - INTERVAL '1' DAY * p.days_lookback
      AND t.evt_block_date <  CURRENT_DATE
      AND NOT EXISTS (SELECT 1 FROM gooddollar_celo.onetimepayments_evt_paymentwithdraw w WHERE w.evt_tx_hash = t.evt_tx_hash)

    UNION ALL
    SELECT t.evt_block_date AS date, t."to" AS addr
    FROM gooddollar_celo.supergooddollar_evt_transfer t
    LEFT JOIN contracts c_from ON t."from" = c_from.contract_address
    LEFT JOIN contracts c_to   ON t."to"   = c_to.contract_address
    CROSS JOIN params p
    WHERE c_from.contract_address IS NULL
      AND c_to.contract_address   IS NULL
      AND t."from" <> t."to"
      AND t.evt_block_date >= CURRENT_DATE - INTERVAL '1' DAY * p.days_lookback
      AND t.evt_block_date <  CURRENT_DATE
      AND NOT EXISTS (SELECT 1 FROM gooddollar_celo.onetimepayments_evt_paymentwithdraw w WHERE w.evt_tx_hash = t.evt_tx_hash)

    UNION ALL
    SELECT w.evt_block_date AS date, t."to" AS addr
    FROM gooddollar_celo.onetimepayments_evt_paymentwithdraw w
    JOIN gooddollar_celo.supergooddollar_evt_transfer t
      ON t.evt_tx_hash = w.evt_tx_hash
    CROSS JOIN params p
    WHERE w.evt_block_date >= CURRENT_DATE - INTERVAL '1' DAY * p.days_lookback
      AND w.evt_block_date <  CURRENT_DATE
  )
),
distinct_daily_users AS (
  SELECT date, COUNT(DISTINCT addr) AS unique_users
  FROM daily_users
  GROUP BY date
),

-- PRICE (daily) with forward/backfill, window-aligned
raw_price AS (
  SELECT CAST(d.timestamp AS date) AS date, d.price
  FROM prices.day d
  CROSS JOIN params p
  WHERE d.blockchain = 'celo'
    AND d.contract_address = p.g_token
),
bounds AS (
  SELECT
    LEAST(COALESCE((SELECT MIN(date) FROM direct_p2p), DATE '2099-12-31'),
          COALESCE((SELECT MIN(date) FROM otp_p2p),    DATE '2099-12-31')) AS min_day,
    GREATEST(COALESCE((SELECT MAX(date) FROM direct_p2p), DATE '1970-01-01'),
             COALESCE((SELECT MAX(date) FROM otp_p2p),    DATE '1970-01-01')) AS max_day
),
windowed AS (
  SELECT
    GREATEST(min_day, CURRENT_DATE - INTERVAL '1' DAY * (SELECT days_lookback FROM params)) AS win_min,
    LEAST  (max_day, CURRENT_DATE - INTERVAL '1' DAY)                                       AS win_max
  FROM bounds
),
all_days AS (
  SELECT day
  FROM windowed w
  CROSS JOIN UNNEST(sequence(w.win_min, w.win_max, INTERVAL '1' day)) AS t(day)
),
price_ff AS (
  SELECT
    a.day AS date,
    FIRST_VALUE(r.price) OVER (ORDER BY a.day ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS fwd_price,
    LAST_VALUE (r.price) OVER (ORDER BY a.day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS back_price
  FROM all_days a
  LEFT JOIN raw_price r ON a.day = r.date
),
daily_price AS (
  SELECT date, COALESCE(back_price, fwd_price) AS daily_price_usd
  FROM price_ff
)

-- FINAL
SELECT
  COALESCE(d.date, o.date)                                          AS date,
  p.daily_price_usd,
  COALESCE(d.tx_count, 0) + COALESCE(o.tx_count, 0)                 AS total_tx_count,
  COALESCE(d.amount_gd, 0) + COALESCE(o.amount_gd, 0)               AS total_amount_gd,
  (COALESCE(d.amount_gd, 0) + COALESCE(o.amount_gd, 0)) * p.daily_price_usd AS total_amount_usd,
  COALESCE(d.unique_senders, 0)                                     AS unique_senders,
  COALESCE(d.unique_receivers, 0) + COALESCE(orx.unique_receivers, 0) AS unique_receivers,
  COALESCE(u.unique_users, 0)                                       AS unique_users
FROM direct_p2p d
FULL OUTER JOIN otp_p2p o        ON d.date = o.date
LEFT JOIN otp_receivers orx      ON COALESCE(d.date, o.date) = orx.date
LEFT JOIN distinct_daily_users u ON COALESCE(d.date, o.date) = u.date
LEFT JOIN daily_price p          ON COALESCE(d.date, o.date) = p.date
ORDER BY date ASC;
