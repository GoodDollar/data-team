-- GoodDollar on Celo: Total Verified Users (Identity whitelist)
-- What: Total unique humans verified by GoodDollar's face verification on Celo
-- Why: Shows the scale of Sybil-resistant identity GoodDollar brings to the Celo ecosystem
--       (MiniPay benefits: these are REAL humans, not bots)

SELECT
    COUNT(DISTINCT account) AS total_verified_users,
    MIN(evt_block_time) AS first_verification,
    MAX(evt_block_time) AS latest_verification,
    -- Recent growth
    COUNT(DISTINCT CASE WHEN evt_block_time >= NOW() - INTERVAL '30' DAY THEN account END) AS new_last_30d,
    COUNT(DISTINCT CASE WHEN evt_block_time >= NOW() - INTERVAL '90' DAY THEN account END) AS new_last_90d
FROM gooddollar_celo.identityv2_evt_whitelistedadded
WHERE contract_address = 0xc361a6e67822a0edc17d899227dd9fc50bd62f42
