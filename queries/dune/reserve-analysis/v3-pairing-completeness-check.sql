/*
GoodDollar Sep 2026 incident: V3 NFT-position pairing completeness check

Why: v3-direct-liquidity-diagnostic.sql just ran and found only 1,116 GD
total across 92 tiny tick-range rows from a single non-NFPM owner, nowhere
near the ~20.6M GD gap between the 5 pools' actual balances (43.7M,
confirmed live) and the sum of all positions lp-v3-positions.sql plus
lp-bulk-gd-amounts.mjs could attribute (23.1M). That RULES OUT "direct,
non-NFT-wrapped liquidity" as the explanation (owner IS the known NFPM for
the overwhelming majority of Mint events, confirmed by that query's own
near-empty result).

New hypothesis: the Mint-to-IncreaseLiquidity PAIRING logic in
lp-v3-positions.sql (nearest IncreaseLiquidity log after a Mint log, same
tx) is missing some real NFPM-routed mints, e.g. because a transaction's
event ordering doesn't match the simple "next log wins" assumption (a
multicall batching more than one position open in one tx could interleave
events in a way that breaks it). This query tests that directly: for the
two pools with the biggest unexplained gaps (0x9491d57c, ~12.3M
unaccounted; 0x3d9e27c0, ~7.0M of 7.3M unaccounted), count every Mint event
whose owner IS one of the two known NFPMs, and separately flag which of
those transactions do NOT have any IncreaseLiquidity event at all in the
same tx (a stronger, simpler test than the full nearest-neighbor pairing
logic, if a Mint's own transaction has zero IncreaseLiquidity events
anywhere in it, no pairing heuristic could ever have found one, proving the
gap is a real "never paired" case and not a subtler ordering bug).

If this returns rows: those are real missed positions, pull the amount0/
amount1 straight from the Mint event's data (same byte layout as
v3-direct-liquidity-diagnostic.sql) to size them, and check the tx on
Celoscan directly to understand why the standard IncreaseLiquidity event
didn't fire (possible batching/multicall pattern specific to this NFPM
fork).
If this returns nothing: the gap is not a "missing pairing" issue either,
and the next thing to check is the tick-math itself (a systematic
under-computation for certain position shapes), not covered by this query.

NOT YET RUN/VERIFIED IN DUNE, paste and run before trusting the output.
*/

WITH known_nfpms AS (
    SELECT * FROM (VALUES
        (0x3d79edaabc0eab6f08ed885c05fc0b014290d95a),
        (0x897387c7b996485c3aaa85c94272cd6c506f8c8f)
    ) AS t(nfpm_address)
),
target_pools AS (
    SELECT * FROM (VALUES
        (0x9491d57c5687ab75726423b55ac2d87d1cda2c3f, 'Uniswap V3 GD/cUSD', true),
        (0x3d9e27c04076288ebfdc4815b4f6d81b0ed1b341, 'Ubeswap-V3 GD/USDGLO', false)
    ) AS t(pool_address, pool_name, gd_is_token0)
),
mint_events AS (
    SELECT
        p.pool_address,
        p.pool_name,
        p.gd_is_token0,
        l.tx_hash,
        bytearray_substring(l.topic1, 13, 20) AS mint_owner,
        CAST(bytearray_to_uint256(bytearray_substring(l.data, 65, 32)) AS DOUBLE) / 1e18 AS amount0,
        CAST(bytearray_to_uint256(bytearray_substring(l.data, 97, 32)) AS DOUBLE) / 1e18 AS amount1
    FROM celo.logs l
    JOIN target_pools p ON l.contract_address = p.pool_address
    WHERE l.topic0 = 0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde
),
nfpm_owned_mints AS (
    SELECT m.* FROM mint_events m
    WHERE EXISTS (SELECT 1 FROM known_nfpms k WHERE k.nfpm_address = m.mint_owner)
),
increase_liquidity_tx AS (
    SELECT DISTINCT l.tx_hash
    FROM celo.logs l
    WHERE l.topic0 = 0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f
),
unpaired AS (
    SELECT m.*
    FROM nfpm_owned_mints m
    WHERE NOT EXISTS (SELECT 1 FROM increase_liquidity_tx i WHERE i.tx_hash = m.tx_hash)
)
SELECT
    pool_name,
    pool_address,
    mint_owner AS nfpm_address,
    tx_hash,
    CASE WHEN gd_is_token0 THEN amount0 ELSE amount1 END AS gd_added_this_mint,
    amount0,
    amount1
FROM unpaired
ORDER BY gd_added_this_mint DESC
