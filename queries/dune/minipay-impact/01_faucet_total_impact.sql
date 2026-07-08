-- GoodDollar Faucet: Total Impact (all time)
-- What: Total CELO distributed, unique wallets served, total $ value
-- Why: Shows the cumulative investment GoodDollar makes in Celo gas subsidies
-- Faucet address: 0x4f93fa058b03953c851efaa2e4fc5c34afdfab84

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
),

celo_prices AS (
    SELECT
        CAST(timestamp AS DATE) AS day,
        price
    FROM prices.day
    WHERE blockchain = 'celo'
      AND contract_address = 0x471ece3750da237f93b8e339c536989b8978a438  -- wrapped CELO
),

valued_outflows AS (
    SELECT
        f.*,
        f.celo_amount * COALESCE(p.price, 0) AS usd_value
    FROM faucet_outflows f
    LEFT JOIN celo_prices p ON f.day = p.day
)

SELECT
    COUNT(*) AS total_topups,
    COUNT(DISTINCT recipient) AS unique_wallets,
    SUM(celo_amount) AS total_celo_distributed,
    SUM(usd_value) AS total_usd_value,
    MIN(block_time) AS first_topup,
    MAX(block_time) AS last_topup,
    DATE_DIFF('day', MIN(block_time), MAX(block_time)) AS days_active
FROM valued_outflows