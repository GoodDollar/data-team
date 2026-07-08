-- GoodDollar Faucet: Monthly Distribution Trend
-- What: CELO distributed per month, unique wallets per month, USD cost
-- Why: Shows growth trajectory — MiniPay benefits more as GoodDollar grows

WITH faucet_outflows AS (
    SELECT
        "to" AS recipient,
        value / 1e18 AS celo_amount,
        block_time,
        CAST(block_time AS DATE) AS day,
        DATE_TRUNC('month', block_time) AS month
    FROM celo.traces
    WHERE "from" = 0x4f93fa058b03953c851efaa2e4fc5c34afdfab84
      AND value > 0
      AND success = true
      AND (call_type NOT IN ('delegatecall', 'staticcall') OR call_type IS NULL)
),

celo_prices AS (
    SELECT
        CAST(timestamp AS DATE) AS day,
        price
    FROM prices.day
    WHERE blockchain = 'celo'
      AND contract_address = 0x471ece3750da237f93b8e339c536989b8978a438
)

SELECT
    f.month,
    COUNT(*) AS topups,
    COUNT(DISTINCT f.recipient) AS unique_wallets,
    SUM(f.celo_amount) AS celo_distributed,
    SUM(f.celo_amount * COALESCE(p.price, 0)) AS usd_value,
    AVG(f.celo_amount) AS avg_celo_per_topup
FROM faucet_outflows f
LEFT JOIN celo_prices p ON f.day = p.day
WHERE f.month < DATE_TRUNC('month', NOW())
GROUP BY f.month
ORDER BY f.month DESC
