-- GoodDollar Faucet: Cross-reference with UBI Claimers
-- What: % of faucet recipients who are active claimers
-- Why: Proves the faucet ENABLES claiming (it's not wasted gas — it drives UBI activity)

WITH faucet_recipients_30d AS (
    SELECT DISTINCT "to" AS wallet
    FROM celo.traces
    WHERE "from" = 0x4f93fa058b03953c851efaa2e4fc5c34afdfab84
      AND value > 0
      AND success = true
      AND (call_type NOT IN ('delegatecall', 'staticcall') OR call_type IS NULL)
      AND block_time >= NOW() - INTERVAL '30' DAY
),

ubi_claimers_30d AS (
    SELECT DISTINCT claimer AS wallet
    FROM gooddollar_celo.ubischemev2_evt_ubiclaimed
    WHERE evt_block_time >= NOW() - INTERVAL '30' DAY
      AND contract_address = 0x43d72ff17701b2da814620735c39c620ce0ea4a1
),

overlap AS (
    SELECT
        f.wallet,
        CASE WHEN u.wallet IS NOT NULL THEN 1 ELSE 0 END AS is_claimer
    FROM faucet_recipients_30d f
    LEFT JOIN ubi_claimers_30d u ON f.wallet = u.wallet
)

SELECT
    COUNT(*) AS total_faucet_recipients,
    SUM(is_claimer) AS also_claimed_ubi,
    ROUND(100.0 * SUM(is_claimer) / COUNT(*), 1) AS pct_who_claim,
    COUNT(*) - SUM(is_claimer) AS faucet_only_no_claim
FROM overlap
