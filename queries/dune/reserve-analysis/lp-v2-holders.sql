/*
GoodDollar Sep 2026 incident: Ubeswap-V2-style LP-token holder enumeration
(4 pools)

What: for each of the 4 pure Ubeswap-V2-style GD pools (the pool contract IS
the LP token, a plain ERC20), list every current holder of that LP token and
their share of total supply.
Why: closes a gap in wallet-cost-list.sql's undercounting check. That list
only counts plain GD balanceOf and never accounted for GD sitting inside LP
positions. This is the V2 half of closing that gap (see the companion query
lp-v3-positions.sql for the 5 Uniswap-V3-style pools, which needs a
different method since those don't have an LP token at all).

How to use the output: this query gives LP-token balance and % share per
holder, using historical decoded transfers (accurate and Dune has full
history, no per-call range limit). It does NOT bake in a GD amount, because
each pool's live GD balance changes every block and isn't meaningful to
compute historically, take the pool_address + holder + share_of_pool
columns and multiply share_of_pool by that pool's CURRENT GD balanceOf
(grab this live via projects/reserve-analysis/scripts/rpc-checks/
lp-pool-current-state.mjs, or directly on Celoscan) to get each holder's
current GD entitlement.

Pool list and method are the same ones already verified in
projects/reserve-analysis/scripts/rpc-checks/lp-pool-current-state.mjs this
session (pool addresses + classification cross-checked live against
Celoscan). erc20_celo.evt_transfer is the same decoded table already relied
on in wallet-cost-list.sql in this same folder.

NOT YET RUN/VERIFIED IN DUNE, paste and run before trusting the output,
same as any first-draft query. Flag back any column-name mismatch (Dune's
decoded ERC20 tables occasionally use snake_case names that differ slightly
across chains).
*/

WITH pools AS (
    SELECT * FROM (
        VALUES
            (0x31f9dee850b4284b81b52b25a3194f2fc8ff18cf, 'Ubeswap GD/cUSD'),
            (0x07f86b39728be613062bc7413fc2ca7293eef022, 'Ubeswap GD/mcUSD'),
            (0x25878951ae130014e827e6f54fd3b4cca057a7e8, 'Ubeswap GD/CELO'),
            (0xa0bef7ff637c10b9ec67a00687b4d4364a7f1c55, 'Ubeswap GD/PACT')
    ) AS t(pool_address, pool_name)
),
transfers AS (
    SELECT
        p.pool_address,
        p.pool_name,
        t."from",
        t."to",
        CAST(t.value AS DOUBLE) AS amount
    FROM erc20_celo.evt_transfer t
    JOIN pools p ON t.contract_address = p.pool_address
),
deltas AS (
    SELECT pool_address, pool_name, "from" AS holder, -amount AS delta
    FROM transfers
    WHERE "from" <> 0x0000000000000000000000000000000000000000
    UNION ALL
    SELECT pool_address, pool_name, "to" AS holder, amount AS delta
    FROM transfers
    WHERE "to" <> 0x0000000000000000000000000000000000000000
),
balances AS (
    SELECT pool_address, pool_name, holder, SUM(delta) AS lp_balance
    FROM deltas
    GROUP BY pool_address, pool_name, holder
    HAVING SUM(delta) > 0
),
total_supply AS (
    SELECT pool_address, SUM(delta) AS total_supply
    FROM deltas
    GROUP BY pool_address
)
SELECT
    b.pool_name,
    b.pool_address,
    b.holder,
    b.lp_balance,
    ts.total_supply,
    b.lp_balance / ts.total_supply AS share_of_pool
FROM balances b
JOIN total_supply ts ON b.pool_address = ts.pool_address
ORDER BY b.pool_address, b.lp_balance DESC
