-- GoodDollar Faucet: Current Run Rate (last 30 days)
-- What: Daily averages for the last 30 days — the "current cost" number
-- Why: Hadar can say "we spend $X/month right now to keep Celo UBI working"

WITH faucet_outflows AS (
    SELECT
        "to" AS recipient,
        value / 1e18 AS celo_amount,
        block_time,
        CAST(block_time AS DATE) AS day
    FROM celo.traces
    WHERE "from" = 0x4f93fa058b03953c851efaa2e4fc5c34afdfab84
      AND value > 0
      AND success = true
      AND (call_type NOT IN ('delegatecall', 'staticcall') OR call_type IS NULL)
      AND block_time >= NOW() - INTERVAL '30' DAY
),

celo_prices AS (
    SELECT
        CAST(timestamp AS DATE) AS day,
        price
    FROM prices.day
    WHERE blockchain = 'celo'
      AND contract_address = 0x471ece3750da237f93b8e339c536989b8978a438
      AND timestamp >= NOW() - INTERVAL '30' DAY
),

daily_stats AS (
    SELECT
        f.day,
        COUNT(*) AS topups,
        COUNT(DISTINCT f.recipient) AS unique_wallets,
        SUM(f.celo_amount) AS celo_distributed,
        SUM(f.celo_amount * COALESCE(p.price, 0)) AS usd_value
    FROM faucet_outflows f
    LEFT JOIN celo_prices p ON f.day = p.day
    GROUP BY f.day
)

SELECT
    COUNT(*) AS days_measured,
    SUM(topups) AS total_topups_30d,
    SUM(unique_wallets) AS total_unique_wallets_30d,
    SUM(celo_distributed) AS total_celo_30d,
    SUM(usd_value) AS total_usd_30d,
    -- Averages
    AVG(topups) AS avg_daily_topups,
    AVG(unique_wallets) AS avg_daily_wallets,
    AVG(celo_distributed) AS avg_daily_celo,
    AVG(usd_value) AS avg_daily_usd,
    -- Projected monthly cost
    AVG(usd_value) * 30 AS projected_monthly_usd_cost
FROM daily_stats
