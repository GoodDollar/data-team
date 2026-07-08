-- GoodDollar Faucet: Daily Time Series (last 90 days)
-- What: Day-by-day topups, wallets, CELO, USD — for a chart
-- Why: Visual trend line showing consistent daily investment

WITH faucet_outflows AS (
    SELECT
        "to" AS recipient,
        value / 1e18 AS celo_amount,
        CAST(block_time AS DATE) AS day
    FROM celo.traces
    WHERE "from" = 0x4f93fa058b03953c851efaa2e4fc5c34afdfab84
      AND value > 0
      AND success = true
      AND (call_type NOT IN ('delegatecall', 'staticcall') OR call_type IS NULL)
      AND block_time >= NOW() - INTERVAL '90' DAY
),

celo_prices AS (
    SELECT
        CAST(timestamp AS DATE) AS day,
        price
    FROM prices.day
    WHERE blockchain = 'celo'
      AND contract_address = 0x471ece3750da237f93b8e339c536989b8978a438
      AND timestamp >= NOW() - INTERVAL '90' DAY
)

SELECT
    f.day,
    COUNT(*) AS topups,
    COUNT(DISTINCT f.recipient) AS unique_wallets,
    SUM(f.celo_amount) AS celo_distributed,
    SUM(f.celo_amount * COALESCE(p.price, 0)) AS usd_value
FROM faucet_outflows f
LEFT JOIN celo_prices p ON f.day = p.day
GROUP BY f.day
ORDER BY f.day
