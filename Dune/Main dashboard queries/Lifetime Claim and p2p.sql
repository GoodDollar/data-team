https://dune.com/queries/5966342?sidebar=none

WITH
params AS (
  SELECT
    FROM_HEX('0000000000000000000000000000000000000000') AS ZERO_ADDR,
    FROM_HEX('b27d247f5c2a61d2cb6b6e67fee51d839447e97d') AS OTP_CONTRACT,
    FROM_HEX('43d72ff17701b2da814620735c39c620ce0ea4a1') AS CLAIM_CONTRACT,
    CAST(CURRENT_DATE - INTERVAL '1' DAY AS DATE)       AS end_date   -- << anchor at yesterday
),

contracts AS (
  SELECT DISTINCT address
  FROM celo.creation_traces
),

whitelist AS (
  SELECT DISTINCT account
  FROM gooddollar_celo.identityv2_evt_whitelistedadded
),

-- OTP withdrawals (events imply successful txs) - capped at end_date (d-1)
withdraws AS (
  SELECT
    evt_tx_hash,
    amount * 1e-18 AS amt_gd,
    evt_block_time AS ts
  FROM gooddollar_celo.onetimepayments_evt_paymentwithdraw
  WHERE CAST(evt_block_time AS DATE) <= (SELECT end_date FROM params)
),

-- Minimal projection of transfers with predicate pushdown & scaling - capped at end_date (d-1)
transfers AS (
  SELECT
    evt_tx_hash,
    "from",
    "to",
    value * 1e-18                  AS amt_gd,
    evt_block_time                 AS ts,
    CAST(evt_block_time AS DATE)   AS d
  FROM gooddollar_celo.supergooddollar_evt_transfer
  WHERE value > 0
    AND CAST(evt_block_time AS DATE) <= (SELECT end_date FROM params)
    AND (
      "from" = (SELECT CLAIM_CONTRACT FROM params)
      OR "from" = (SELECT OTP_CONTRACT   FROM params)
      OR (
        "from" <> (SELECT ZERO_ADDR FROM params)
        AND "to" <> (SELECT ZERO_ADDR FROM params)
        AND "from" <> "to"
      )
    )
),

-- Direct EOA↔EOA transfers (exclude contracts & OTP txs to avoid double count)
direct_eoa AS (
  SELECT
    t.evt_tx_hash,
    t."from" AS sender,
    t."to"   AS recipient,
    t.amt_gd,
    t.ts
  FROM transfers t
  LEFT JOIN contracts c_from ON c_from.address = t."from"
  LEFT JOIN contracts c_to   ON c_to.address   = t."to"
  LEFT JOIN withdraws w      ON w.evt_tx_hash  = t.evt_tx_hash
  WHERE c_from.address IS NULL
    AND c_to.address   IS NULL
    AND t."from" <> (SELECT OTP_CONTRACT FROM params)
    AND w.evt_tx_hash IS NULL
    AND t."from" <> (SELECT ZERO_ADDR FROM params)
    AND t."to"   <> (SELECT ZERO_ADDR FROM params)
    AND t."from" <> t."to"
),

-- OTP P2P: count once via withdraw event; recipient from matching transfer where from = OTP contract
otp_p2p AS (
  SELECT
    w.evt_tx_hash,
    CAST(NULL AS VARBINARY) AS sender,
    tr."to"                 AS recipient,
    w.amt_gd,
    w.ts
  FROM withdraws w
  JOIN transfers tr
    ON tr.evt_tx_hash = w.evt_tx_hash
   AND tr."from"      = (SELECT OTP_CONTRACT FROM params)
),

all_p2p AS (
  SELECT * FROM direct_eoa
  UNION ALL
  SELECT * FROM otp_p2p
),

p2p_agg AS (
  SELECT
    COUNT(*)                             AS p2p_lifetime_tx_count,
    SUM(amt_gd)                          AS p2p_lifetime_gd_amount,
    COUNT(DISTINCT sender)               AS p2p_lifetime_unique_senders,
    COUNT(DISTINCT recipient)            AS p2p_lifetime_unique_receivers,
    (SELECT COUNT(DISTINCT addr) FROM (
       SELECT sender    AS addr FROM all_p2p WHERE sender    IS NOT NULL
       UNION ALL
       SELECT recipient AS addr FROM all_p2p WHERE recipient IS NOT NULL
     ))                                  AS p2p_lifetime_unique_users,
    MIN(ts)                              AS p2p_min_ts,
    MAX(ts)                              AS p2p_max_ts
  FROM all_p2p
),

-- Claim transfers (from claim contract to whitelisted EOAs)
claim_transfers AS (
  SELECT
    t."to" AS claimer,
    t.ts,
    t.d,
    t.amt_gd
  FROM transfers t
  JOIN whitelist w ON w.account = t."to"
  WHERE t."from" = (SELECT CLAIM_CONTRACT FROM params)
),

claims_agg AS (
  SELECT
    COUNT(DISTINCT claimer)                                                 AS lifetime_unique_claimers,
    COUNT(*)                                                                AS lifetime_unique_claim_TXs,
    SUM(amt_gd)                                                             AS lifetime_claimed_gd_amount,
    MIN(d)                                                                  AS first_claim_date,
    MAX(d)                                                                  AS latest_claim_date,
    COUNT(
      DISTINCT CASE
        WHEN d >= (SELECT end_date FROM params) - INTERVAL '365' DAY
        THEN claimer
      END
    )                                                                       AS last365d_unique_claimers,
    MIN(ts)                                                                 AS claims_min_ts,
    MAX(ts)                                                                 AS claims_max_ts
  FROM claim_transfers
),

final_dates AS (
  SELECT
    CAST(LEAST(p.p2p_min_ts, c.claims_min_ts) AS DATE)    AS start_date,
    CAST(GREATEST(p.p2p_max_ts, c.claims_max_ts) AS DATE) AS end_date
  FROM p2p_agg p
  CROSS JOIN claims_agg c
)

SELECT
  -- DATE FIRST (column [0]) - this will now be d-1
  f.end_date AS end_date,

  -- P2P (lifetime, as of d-1)
  CAST(p.p2p_lifetime_tx_count         AS BIGINT)  AS p2p_lifetime_tx_count,
  CAST(p.p2p_lifetime_gd_amount        AS DOUBLE)  AS p2p_lifetime_gd_amount,
  CAST(p.p2p_lifetime_unique_senders   AS BIGINT)  AS p2p_lifetime_unique_senders,
  CAST(p.p2p_lifetime_unique_receivers AS BIGINT)  AS p2p_lifetime_unique_receivers,
  CAST(p.p2p_lifetime_unique_users     AS BIGINT)  AS p2p_lifetime_unique_users,

  -- Claimers (lifetime + last 365d, as of d-1)
  CAST(c.lifetime_unique_claimers      AS BIGINT)  AS lifetime_unique_claimers,
  CAST(c.lifetime_unique_claim_TXs     AS BIGINT)  AS lifetime_unique_claim_TXs,
  CAST(c.lifetime_claimed_gd_amount    AS DOUBLE)  AS lifetime_claimed_gd_amount,
  CAST(c.last365d_unique_claimers      AS BIGINT)  AS last365d_unique_claimers,

  -- Optional: keep start_date as a trailing audit field
  f.start_date AS start_date

FROM p2p_agg p
CROSS JOIN claims_agg c
CROSS JOIN final_dates f;
