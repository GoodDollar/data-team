/*
GoodDollar Sep 2026 incident: direct (non-NFT-wrapped) V3 liquidity finder

What: for the 5 Uniswap-V3-style GD pools, find every Mint event whose
"owner" (the address the pool's internal accounting credits the position
to) is NOT one of the two known position managers, meaning that
liquidity was NOT opened through an NFT position at all, so it never
appeared in the companion query lp-v3-positions.sql or in
lp-bulk-gd-amounts.mjs's results.
Why: lp-bulk-gd-amounts.mjs (this session) only accounted for 23.1M of the
43.7M GD actually sitting in these 5 pools (confirmed live via balanceOf),
a ~20.6M GD gap. Uncollected trading fees were checked and ruled out (only
~3.4K GD total). The next most likely explanation is liquidity managed by a
contract that calls the pool's mint() directly, bypassing the
NonfungiblePositionManager/NFT wrapper entirely, which is invisible to
both this investigation's method AND to a standard subgraph/position-NFT
enumeration. The gap is concentrated in two pools specifically:
0x9491d57c (cUSD pool, ~12.3M unaccounted) and 0x3d9e27c0 (USDGLO pool,
~7.0M of its 7.3M total unaccounted, i.e. ~96%), start there.

This is a DIAGNOSTIC query, not a final answer: it reports GROSS GD ever
added via direct mints per (pool, owner, tick range), which is an
OVER-estimate of what's currently there if any of it was later removed
(this query does not net against Burn events, see note below). Once this
identifies WHO the direct owners are, the fast, precise follow-up is a
targeted RPC call to the POOL's own positions(bytes32) with
key = keccak256(abi.encodePacked(owner, tickLower, tickUpper)) for each
row here, mirroring the already-validated NFT-position method (see
lp-known-positions-check.mjs) but reading the pool directly instead of an
NFPM. That RPC follow-up has NOT been built yet this session; build it
once this query's owner list is in hand.

Event signature (topic0) for Mint was confirmed empirically earlier this
session (a live Celoscan-decoded transaction, the pool 0x9491d57c founding-
position tx). The known-NFPM exclusion list below is exactly the two NFPM
addresses already confirmed this session (one per Uniswap-V3-fork
deployment on Celo).

NOTE on netting: a Burn topic0 is NOT included/verified here on purpose.
The standard Uniswap V3 Burn(address indexed owner, int24 indexed
tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0,
uint256 amount1) signature is well-known and structurally this contract
family has matched the standard exactly on every other event checked so
far, but it was not empirically re-verified against a live decoded
transaction this session the way Mint/PoolCreated/IncreaseLiquidity/
Transfer were, so it is deliberately left out rather than trusted blind.
If you want net-of-burns instead of gross, the commonly-cited standard
hash is 0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c,
verify it against one real Burn transaction on one of these 5 pools
before trusting it (same method used everywhere else in this
investigation: pull a real tx, check Celoscan's own decoded event name).

NOT YET RUN/VERIFIED IN DUNE, paste and run before trusting the output.
Two more Dune helper functions used below were not independently confirmed
this session (unlike the event signatures, which were): bytearray_to_int256
for the signed tick values (ticks are two's-complement, e.g. a negative
tick is NOT zero-padded, so the unsigned variant would silently produce a
huge wrong number, this needs the signed decoder specifically) and
bytearray_to_uint256/bytearray_substring generally (same as the companion
query lp-v3-positions.sql). If bytearray_to_int256 errors, tick_lower/
tick_upper aren't needed for the headline gd_added_gross_total number
anyway, comment those two lines out and the query still answers "how
much GD, which owner, which pool."
*/

WITH pools AS (
    SELECT * FROM (
        VALUES
            (0x9491d57c5687ab75726423b55ac2d87d1cda2c3f, 'Uniswap V3 GD/cUSD', true),
            (0x991f1aa7e0901f9ab3d583846bf5be0ebace1d7f, 'Uniswap V3 GD/USDGLO', false),
            (0xcb037f27eb3952222810966e28e0ceb650c65cd9, 'Uniswap V3 GD/CELO', false),
            (0x3d9e27c04076288ebfdc4815b4f6d81b0ed1b341, 'Ubeswap-V3 GD/USDGLO', false),
            (0x8b393470bef8bb27a9a5169531b4eba5209b0b26, 'Ubeswap-V3 GD/CELO 0.3%', false)
    ) AS t(pool_address, pool_name, gd_is_token0)
),
known_nfpms AS (
    SELECT * FROM (VALUES
        (0x3d79edaabc0eab6f08ed885c05fc0b014290d95a),
        (0x897387c7b996485c3aaa85c94272cd6c506f8c8f)
    ) AS t(nfpm_address)
),
mint_events AS (
    SELECT
        p.pool_address,
        p.pool_name,
        p.gd_is_token0,
        l.tx_hash,
        l.index AS mint_log_index,
        bytearray_substring(l.topic1, 13, 20) AS mint_owner,
        bytearray_to_int256(l.topic2) AS tick_lower,
        bytearray_to_int256(l.topic3) AS tick_upper,
        -- Mint(address sender, address indexed owner, int24 indexed
        -- tickLower, int24 indexed tickUpper, uint128 amount, uint256
        -- amount0, uint256 amount1) -- data = sender(32B) | amount(32B) |
        -- amount0(32B) | amount1(32B), none of these are dynamic types so
        -- fixed byte offsets are safe.
        CAST(bytearray_to_uint256(bytearray_substring(l.data, 65, 32)) AS DOUBLE) / 1e18 AS amount0,
        CAST(bytearray_to_uint256(bytearray_substring(l.data, 97, 32)) AS DOUBLE) / 1e18 AS amount1
    FROM celo.logs l
    JOIN pools p ON l.contract_address = p.pool_address
    WHERE l.topic0 = 0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde
),
direct_mints AS (
    SELECT
        m.*,
        CASE WHEN m.gd_is_token0 THEN m.amount0 ELSE m.amount1 END AS gd_added_gross
    FROM mint_events m
    WHERE NOT EXISTS (
        SELECT 1 FROM known_nfpms k WHERE k.nfpm_address = m.mint_owner
    )
)
SELECT
    pool_name,
    pool_address,
    mint_owner,
    tick_lower,
    tick_upper,
    COUNT(*) AS mint_count,
    SUM(gd_added_gross) AS gd_added_gross_total,
    MIN(tx_hash) AS example_tx_hash
FROM direct_mints
GROUP BY pool_name, pool_address, mint_owner, tick_lower, tick_upper
ORDER BY gd_added_gross_total DESC
