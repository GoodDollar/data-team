-- GoodDollar's Share of Celo Activity (transaction volume perspective)
-- What: GoodDollar's share of Celo by TRANSACTIONS, not just wallets
-- Why: GoodDollar users are daily-active (claim every day). 1 GD user = ~30 txs/month.
--      Most Celo addresses transact once and disappear. Volume share tells the real story.
-- Timeframe: last 30 days

WITH celo_total_txs AS (
    SELECT COUNT(*) AS total_txs
    FROM celo.transactions
    WHERE block_time >= NOW() - INTERVAL '30' DAY
      AND success = true
),

-- GoodDollar transaction footprint: faucet topups + UBI claims + G$ transfers
gooddollar_faucet_txs AS (
    SELECT COUNT(*) AS faucet_txs
    FROM celo.traces
    WHERE "from" = 0x4f93fa058b03953c851efaa2e4fc5c34afdfab84
      AND value > 0
      AND success = true
      AND (call_type NOT IN ('delegatecall', 'staticcall') OR call_type IS NULL)
      AND block_time >= NOW() - INTERVAL '30' DAY
),

gooddollar_claim_txs AS (
    SELECT COUNT(*) AS claim_txs
    FROM gooddollar_celo.ubischemev2_evt_ubiclaimed
    WHERE evt_block_time >= NOW() - INTERVAL '30' DAY
      AND contract_address = 0x43d72ff17701b2da814620735c39c620ce0ea4a1
),

gooddollar_transfer_txs AS (
    SELECT COUNT(*) AS transfer_txs
    FROM gooddollar_celo.supergooddollar_evt_transfer
    WHERE evt_block_time >= NOW() - INTERVAL '30' DAY
),

-- Daily engagement: avg claims per user (measures "stickiness")
gooddollar_engagement AS (
    SELECT
        COUNT(*) * 1.0 / COUNT(DISTINCT claimer) AS avg_claims_per_user_30d
    FROM gooddollar_celo.ubischemev2_evt_ubiclaimed
    WHERE evt_block_time >= NOW() - INTERVAL '30' DAY
      AND contract_address = 0x43d72ff17701b2da814620735c39c620ce0ea4a1
)

SELECT
    t.total_txs AS celo_total_transactions_30d,
    f.faucet_txs,
    c.claim_txs,
    tr.transfer_txs,
    (f.faucet_txs + c.claim_txs + tr.transfer_txs) AS gooddollar_total_txs,
    ROUND(100.0 * (f.faucet_txs + c.claim_txs + tr.transfer_txs) / t.total_txs, 2) AS pct_celo_txs_are_gooddollar,
    ROUND(e.avg_claims_per_user_30d, 1) AS avg_claims_per_user_30d
FROM celo_total_txs t
CROSS JOIN gooddollar_faucet_txs f
CROSS JOIN gooddollar_claim_txs c
CROSS JOIN gooddollar_transfer_txs tr
CROSS JOIN gooddollar_engagement e
