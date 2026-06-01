https://dune.com/queries/5608955?sidebar=none

-- G$ token on Celo
WITH params AS (
  SELECT from_hex('62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a') AS g_token
),

whitelist AS (
  SELECT DISTINCT account
  FROM gooddollar_celo.identityv2_evt_whitelistedadded
),

g_transfers AS (
  SELECT
    CAST(t.evt_block_time AS date) AS day,
    t.evt_tx_hash,
    t."from"  AS sender,
    t."to"    AS recipient,
    t.value / 1e18 AS amount_gd
  FROM gooddollar_celo.supergooddollar_evt_transfer t
),

-- Daily USD price with forward-fill (carry last known value)
raw_price AS (
  SELECT CAST(d.timestamp AS date) AS day, d.price
  FROM prices.day d
  CROSS JOIN params p
  WHERE d.blockchain = 'celo'
    AND d.contract_address = p.g_token
),
bounds AS (
  SELECT MIN(day) AS min_day, MAX(day) AS max_day FROM g_transfers
),
all_days AS (
  SELECT day
  FROM bounds b
  CROSS JOIN UNNEST(sequence(b.min_day, b.max_day, INTERVAL '1' day)) AS t(day)
),
price_with_ff AS (
  SELECT
    a.day,
    FIRST_VALUE(r.price) OVER (
      ORDER BY a.day
      ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
    ) AS fwd_price,
    LAST_VALUE(r.price) OVER (
      ORDER BY a.day
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS back_price
  FROM all_days a
  LEFT JOIN raw_price r ON a.day = r.day
),
price_final AS (
  SELECT
    day,
    COALESCE(back_price, fwd_price) AS price
  FROM price_with_ff
),

-- Labels from Dune
labels_celo AS (
  SELECT a.address, COALESCE(od.name, a.contract_name, a.account_owner) AS project_name
  FROM labels.owner_addresses a
  LEFT JOIN labels.owner_details od ON a.owner_key = od.owner_key
  WHERE a.blockchain = 'celo'
),

-- Manual overrides to match DappLooker naming
manual_labels(address, name) AS (
  VALUES
    (from_hex('b27d247f5c2a61d2cb6b6e67fee51d839447e97d'), 'OneTimePayments'),
    (from_hex('fb152fc469a3e9154f8aa60bbd6700ecbc357a54'), 'G$ microbridge (Fuse <-> Celo)'),
    (from_hex('9491d57c5687ab75726423b55ac2d87d1cda2c3f'), 'UniswapV3Pool (G$/cUSD)'),
    (from_hex('cb037f27eb3952222810966e28e0ceb650c65cd9'), 'UniswapV3Pool (G$/Celo)'),
    (from_hex('25878951ae130014e827e6f54fd3b4cca057a7e8'), 'Ubeswap'),
    (from_hex('f8477f8af998663629060d8aece0620b54198410'), 'NoExternalStrategy'),
    (from_hex('2f2dd99235cb728fc79af575f1325eaa270f0c99'), 'BKSwap (Binance)')
),

joined AS (
  SELECT
    t.day,
    t.evt_tx_hash,
    t.recipient,
    t.sender,
    t.amount_gd
  FROM g_transfers t
  JOIN whitelist sw ON t.sender    = sw.account
  LEFT JOIN whitelist rw ON t.recipient = rw.account
  WHERE rw.account IS NULL
)

SELECT
  j.recipient,
  COALESCE(ml.name, l.project_name, '(unlabeled)') AS project_name,
  SUM(j.amount_gd)                                 AS total_gd_received,
  SUM(j.amount_gd * p.price)                       AS total_usd_received,
  COUNT(*)                                         AS transfer_events,
  COUNT(DISTINCT j.evt_tx_hash)                    AS tx_count,
  COUNT(DISTINCT j.sender)                         AS unique_whitelisted_senders
FROM joined j
LEFT JOIN price_final p ON j.day = p.day
LEFT JOIN labels_celo l ON j.recipient = l.address
LEFT JOIN manual_labels ml ON j.recipient = ml.address
GROUP BY 1,2
ORDER BY total_gd_received DESC, total_usd_received DESC, transfer_events DESC
LIMIT 100;