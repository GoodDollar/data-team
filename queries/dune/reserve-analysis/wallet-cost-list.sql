/*
GoodDollar Sep 4 Incident Delta 1: Celo large cheap buyers and current holdings

What: Rank buyers who accumulated GD cheaply since the malicious contract's
deployment and show their current GD balance on Celo.
Why: Hadar asked (2026-09-08) for a full list of wallets that bought cheap GD
and still hold it, for burn + refund. Window start moved from Sep 3 00:00 to
Sep 2 14:35:12 UTC (1 hour before the malicious SuperApp contract's verified
deployment at 2026-09-02T15:35:12Z, tx 0xc1da5a5db80108033de7dde2ba2dedc934744216c8a7ee6ebe2fda13cfe36e99,
per Lewis's concern about earlier unnoticed activity). Window end is now live
(now()) since the mispricing was never fixed and cheap-buying is still
ongoing, re-run rather than hand-edit dates.

Notes:
- "Cheap" is parameterized via cheap_price_cap_usd_per_gd.
- min_gd_bought lowered from 1,000,000 to 1 (2026-09-08): Hadar asked for
  "all wallets", the prior floor excluded small buyers. If refund processing
  cost makes tiny amounts impractical, re-raise this, it's a policy call.
- Current balance is computed from full GD transfer history for the ranked set.
- Added GD/PACT pool (0xa0bef7ff637c10b9ec67a00687b4d4364a7f1c55), the one
  active Celo GD pool found in an independent onchain re-check that wasn't
  already covered here.
- total_quote_paid_usd is TOTAL spent across every buy, not pro-rated to what
  a wallet currently holds. usd_paid_prorated_to_held scales it by
  (current_gd_balance / total_gd_bought) for wallets that partially resold,
  this is the number that should drive a refund, not the gross total.
- KNOWN EXCLUSION: 0x66582d24fead72555adac681cc621cacbb208324 is confirmed
  (2026-09-08, operator-attributed) to be an operator/treasury wallet, not an
  external buyer. Added to excluded_addresses below defensively, even though
  it hasn't shown up in this Celo query's results so far (it was found on
  XDC). Remove this note if it's ever confirmed to never touch Celo at all.
- Scope confirmed 2026-09-08 (checked the live Slack thread): this ask is
  Celo + XDC only. Fuse and Ethereum are explicitly out of scope, Fuse's
  cheap-buying was a one-time historical event already mostly resold, not an
  ongoing drain, and Ethereum never showed any cheap-buying activity in any
  phase of this investigation.
*/

WITH params AS (
    SELECT
        TIMESTAMP '2026-09-02 14:35:12 UTC' AS window_start,
        CAST(now() AS TIMESTAMP) AS window_end,
        0.00002 AS cheap_price_cap_usd_per_gd,
        1 AS min_gd_bought,
        0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A AS gd_token,
        0x471EcE3750Da237f93B8E339c536989b8978a438 AS celo_token,
        0x765DE816845861e75A25fCA122bb6898B8B1282a AS cusd_token,
        0x4f604735c1cf31399c6e711d5962b2b3e0225ad3 AS usdglo_token,
        0x918146359264C492BD6934071c6Bd31C854EDBc3 AS mcusd_token,
        0x46c9757c5497c5b1f2eb73ae79b6b67d119b0b58 AS pact_token
),
pools AS (
    SELECT * FROM (
        VALUES
            (0x991f1aa7e0901f9ab3d583846bf5be0ebace1d7f, 'Uniswap V3 GD/USDGLO', 0x4f604735c1cf31399c6e711d5962b2b3e0225ad3, 'USDGLO'),
            (0x3d9e27c04076288ebfdc4815b4f6d81b0ed1b341, 'Ubeswap GD/USDGLO', 0x4f604735c1cf31399c6e711d5962b2b3e0225ad3, 'USDGLO'),
            (0x9491d57c5687ab75726423b55ac2d87d1cda2c3f, 'Uniswap V3 GD/cUSD', 0x765DE816845861e75A25fCA122bb6898B8B1282a, 'cUSD'),
            (0x31f9dee850b4284b81b52b25a3194f2fc8ff18cf, 'Ubeswap GD/cUSD', 0x765DE816845861e75A25fCA122bb6898B8B1282a, 'cUSD'),
            (0x07f86b39728be613062bc7413fc2ca7293eef022, 'Ubeswap GD/mcUSD', 0x918146359264C492BD6934071c6Bd31C854EDBc3, 'mcUSD'),
            (0x25878951ae130014e827e6f54fd3b4cca057a7e8, 'Ubeswap GD/CELO', 0x471EcE3750Da237f93B8E339c536989b8978a438, 'CELO'),
            (0xcb037f27eb3952222810966e28e0ceb650c65cd9, 'Uniswap V3 GD/CELO', 0x471EcE3750Da237f93B8E339c536989b8978a438, 'CELO'),
            (0x8b393470bef8bb27a9a5169531b4eba5209b0b26, 'Ubeswap GD/CELO 0.3%', 0x471EcE3750Da237f93B8E339c536989b8978a438, 'CELO'),
            (0xa0bef7ff637c10b9ec67a00687b4d4364a7f1c55, 'GD/PACT', 0x46c9757c5497c5b1f2eb73ae79b6b67d119b0b58, 'PACT')
    ) AS t(pool_address, pool_name, quote_token, quote_symbol)
),
excluded_addresses AS (
    SELECT address FROM (
        VALUES
            (0x94A3240f484A04F5e3d524f528d02694c109463b),
            (0x88de45906D4F5a57315c133620cfa484cB297541),
            (0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A),
            (0x765DE816845861e75A25fCA122bb6898B8B1282a),
            (0x4f604735c1cf31399c6e711d5962b2b3e0225ad3),
            (0x918146359264C492BD6934071c6Bd31C854EDBc3),
            (0x471EcE3750Da237f93B8E339c536989b8978a438),
            (0x46c9757c5497c5b1f2eb73ae79b6b67d119b0b58),
            (0x66582d24fead72555adac681cc621cacbb208324)
    ) AS x(address)
    UNION ALL
    SELECT pool_address AS address FROM pools
),
window_transfers AS (
    SELECT
        p.pool_address,
        p.pool_name,
        p.quote_token,
        p.quote_symbol,
        DATE_TRUNC('minute', t.evt_block_time) AS minute_bucket,
        t.evt_tx_hash,
        t.contract_address,
        t."from",
        t."to",
        CAST(t.value AS DOUBLE) / 1e18 AS amount
    FROM erc20_celo.evt_transfer t
    JOIN pools p
      ON t."from" = p.pool_address
      OR t."to" = p.pool_address
    WHERE t.evt_block_time >= (SELECT window_start FROM params)
      AND t.evt_block_time <= (SELECT window_end FROM params)
      AND t.contract_address IN (
          (SELECT gd_token FROM params),
          (SELECT celo_token FROM params),
          (SELECT cusd_token FROM params),
          (SELECT usdglo_token FROM params),
          (SELECT mcusd_token FROM params),
          (SELECT pact_token FROM params)
      )
),
tx_rows AS (
    SELECT
        pool_address,
        pool_name,
        quote_token,
        quote_symbol,
        minute_bucket,
        evt_tx_hash,
        SUM(CASE
            WHEN contract_address = (SELECT gd_token FROM params)
             AND "from" = pool_address
            THEN amount ELSE 0 END) AS gd_from_pool,
        SUM(CASE
            WHEN contract_address = quote_token
             AND "to" = pool_address
            THEN amount ELSE 0 END) AS quote_to_pool,
        MAX_BY(CASE
            WHEN contract_address = (SELECT gd_token FROM params)
             AND "from" = pool_address
            THEN "to" END,
            CASE
                WHEN contract_address = (SELECT gd_token FROM params)
                 AND "from" = pool_address
                THEN amount ELSE NULL END) AS buyer
    FROM window_transfers
    GROUP BY 1,2,3,4,5,6
),
quote_prices AS (
    SELECT
        minute,
        contract_address,
        AVG(price) AS usd_price
    FROM prices.usd
    WHERE blockchain = 'celo'
      AND contract_address IN (
          (SELECT celo_token FROM params),
          (SELECT cusd_token FROM params),
          (SELECT usdglo_token FROM params),
          (SELECT mcusd_token FROM params),
          (SELECT pact_token FROM params)
      )
      AND minute >= DATE_TRUNC('minute', (SELECT window_start FROM params))
      AND minute <= DATE_TRUNC('minute', (SELECT window_end FROM params))
    GROUP BY 1,2
),
buy_trades AS (
    SELECT
        r.pool_name,
        r.pool_address,
        r.evt_tx_hash,
        r.buyer,
        r.quote_symbol,
        r.gd_from_pool AS gd_bought,
        r.quote_to_pool AS quote_paid,
        CASE
            WHEN r.gd_from_pool > 0 THEN r.quote_to_pool / r.gd_from_pool
            ELSE NULL
        END AS implied_quote_per_gd,
        CASE
            WHEN r.quote_symbol IN ('cUSD', 'USDGLO', 'mcUSD') THEN r.quote_to_pool
            ELSE r.quote_to_pool * p.usd_price
        END AS quote_paid_usd
    FROM tx_rows r
    LEFT JOIN quote_prices p
      ON p.minute = r.minute_bucket
     AND p.contract_address = r.quote_token
    WHERE r.gd_from_pool > 0
      AND r.quote_to_pool > 0
      AND r.buyer IS NOT NULL
            AND r.buyer NOT IN (SELECT address FROM excluded_addresses)
),
buyer_rank AS (
    SELECT
        buyer,
        COUNT(*) AS buy_tx_count,
        ROUND(SUM(gd_bought), 2) AS total_gd_bought,
        ROUND(SUM(quote_paid_usd), 2) AS total_quote_paid_usd,
        ROUND(SUM(quote_paid_usd) / NULLIF(SUM(gd_bought), 0), 10) AS weighted_usd_per_gd,
        ROUND(MIN(implied_quote_per_gd), 10) AS min_quote_per_gd_seen,
        ROUND(MAX(implied_quote_per_gd), 10) AS max_quote_per_gd_seen
    FROM buy_trades
    GROUP BY 1
    HAVING SUM(gd_bought) >= (SELECT min_gd_bought FROM params)
       AND (SUM(quote_paid_usd) / NULLIF(SUM(gd_bought), 0)) <= (SELECT cheap_price_cap_usd_per_gd FROM params)
),
current_balance AS (
    SELECT
        w.wallet,
        ROUND(SUM(
            CASE
                WHEN t."to" = w.wallet THEN CAST(t.value AS DOUBLE) / 1e18
                WHEN t."from" = w.wallet THEN -CAST(t.value AS DOUBLE) / 1e18
                ELSE 0
            END
        ), 2) AS current_gd_balance
    FROM (SELECT DISTINCT buyer AS wallet FROM buyer_rank) w
    JOIN erc20_celo.evt_transfer t
      ON (t."to" = w.wallet OR t."from" = w.wallet)
     AND t.contract_address = (SELECT gd_token FROM params)
    GROUP BY 1
)
SELECT
    ROW_NUMBER() OVER (ORDER BY b.total_gd_bought DESC, b.weighted_usd_per_gd ASC) AS rank_by_gd_bought,
    b.buyer AS wallet,
    b.buy_tx_count,
    b.total_gd_bought,
    b.total_quote_paid_usd,
    ROUND(b.total_quote_paid_usd * (COALESCE(c.current_gd_balance, 0) / NULLIF(b.total_gd_bought, 0)), 4) AS usd_paid_prorated_to_held,
    b.weighted_usd_per_gd,
    b.min_quote_per_gd_seen,
    b.max_quote_per_gd_seen,
    COALESCE(c.current_gd_balance, 0) AS current_gd_balance,
    CASE WHEN COALESCE(c.current_gd_balance, 0) > 0 THEN 'YES' ELSE 'NO' END AS still_holding_on_celo
FROM buyer_rank b
LEFT JOIN current_balance c
  ON c.wallet = b.buyer
ORDER BY rank_by_gd_bought
