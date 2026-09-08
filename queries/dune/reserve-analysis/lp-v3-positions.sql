/*
GoodDollar Sep 2026 incident: Uniswap-V3-style GD LP-position discovery
(5 pools across 2 separate Celo Uniswap-V3-fork deployments)

What: find every LP position (NFT token ID) ever opened against the 5
Uniswap-V3-style GD pools, its position manager (NFPM) contract, and its
CURRENT owner.
Why: same undercounting question as the companion query lp-v2-holders.sql,
for the half of the pool list that uses NFT positions instead of a plain
ERC20 LP token. This is the part that could not be finished via public RPC
in one session (every public Celo RPC endpoint caps eth_getLogs to
50-5000 blocks/call; a full ~57M-block scan needs 11,000+ sequential calls
and does not finish in a practical session, even though the method itself
was validated against 3 known ground-truth positions in pool 0x9491d57c,
tokenIds 201874/875/876, matching an independently-posted reference exactly).
Dune has no such per-call range limit, so this should run in seconds to
minutes instead of hours.

Deliberately does NOT compute liquidity or GD amount here, that needs the
pool's LIVE current tick/price plus Uniswap V3 range math, which isn't
reliable to reconstruct in SQL against a point-in-time historical index.
Instead: take this query's (pool_address, nfpm_address, token_id) rows and
paste the token_id list into the KNOWN_TOKEN_IDS array in
projects/reserve-analysis/scripts/rpc-checks/lp-known-positions-check.mjs
(update NFPM/POOL constants per pool as needed) for a fast, exact,
already-validated GD-amount follow-up per position, no scanning needed at
that point, just direct calls, seconds per pool.

Method (mirrors the RPC script's self-discovering approach, does not assume
a hardcoded NFPM address, since two of these 5 pools use a completely
different, second Uniswap-V3-fork deployment on Celo with its own NFPM that
was never identified this session):
  1. A pool contract emits Mint(address,address,int24,int24,uint128,
     uint256,uint256) when a position is opened.
  2. In the SAME transaction, the position manager (NFPM) that routed the
     mint emits IncreaseLiquidity(uint256 indexed tokenId, uint128,
     uint256, uint256), whichever contract emits that signature in the
     same tx IS the NFPM, self-discovered from the data, not assumed.
  3. Paired by tx_hash AND by requiring the IncreaseLiquidity log to be the
     NEXT log after the Mint log within that tx (defends against a
     multicall transaction that opens more than one position at once,
     which would otherwise cross-join Mint #1 with the wrong
     IncreaseLiquidity event).
  4. Current owner = the "to" address of the MOST RECENT ERC721
     Transfer(address indexed from, address indexed to, uint256 indexed
     tokenId) event for that (nfpm, tokenId) pair. A position that was
     minted and never transferred again still has its mint-time Transfer
     as the "most recent" one, which correctly resolves to the original
     minter.

Event signature hashes (topic0) below were confirmed empirically against a
live Celoscan-decoded transaction during this investigation (the pool
0x9491d57c founding-position tx), not assumed from memory or training data.

Table/column names (celo.logs: block_time, block_number, contract_address,
topic0-3, data, tx_hash, index) are per Dune's public raw-EVM-logs schema
docs. NOT YET RUN/VERIFIED IN DUNE, paste and run before trusting the
output. If bytearray_substring/bytearray_to_uint256 aren't recognized in
your Dune workspace (they are standard Dune SQL helpers, but flagging in
case), replace with TO_HEX(topic) and strip the appropriate leading
zero-hex characters instead (24 hex chars for a padded address, any
leading zeros for a token ID).
*/

WITH pools AS (
    SELECT * FROM (
        VALUES
            (0x9491d57c5687ab75726423b55ac2d87d1cda2c3f, 'Uniswap V3 GD/cUSD'),
            (0x991f1aa7e0901f9ab3d583846bf5be0ebace1d7f, 'Uniswap V3 GD/USDGLO'),
            (0xcb037f27eb3952222810966e28e0ceb650c65cd9, 'Uniswap V3 GD/CELO'),
            (0x3d9e27c04076288ebfdc4815b4f6d81b0ed1b341, 'Ubeswap-V3 GD/USDGLO'),
            (0x8b393470bef8bb27a9a5169531b4eba5209b0b26, 'Ubeswap-V3 GD/CELO 0.3%')
    ) AS t(pool_address, pool_name)
),
mint_events AS (
    SELECT
        p.pool_address,
        p.pool_name,
        l.tx_hash,
        l.index AS mint_log_index
    FROM celo.logs l
    JOIN pools p ON l.contract_address = p.pool_address
    WHERE l.topic0 = 0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde
),
increase_liquidity_events AS (
    SELECT
        l.tx_hash,
        l.contract_address AS nfpm_address,
        l.topic1 AS token_id_topic,
        l.index AS increase_log_index
    FROM celo.logs l
    WHERE l.topic0 = 0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f
),
paired AS (
    SELECT
        m.pool_address,
        m.pool_name,
        i.nfpm_address,
        i.token_id_topic,
        ROW_NUMBER() OVER (
            PARTITION BY m.tx_hash, m.mint_log_index
            ORDER BY i.increase_log_index ASC
        ) AS pairing_rank
    FROM mint_events m
    JOIN increase_liquidity_events i
        ON m.tx_hash = i.tx_hash
       AND i.increase_log_index > m.mint_log_index
),
positions_found AS (
    SELECT DISTINCT pool_address, pool_name, nfpm_address, token_id_topic
    FROM paired
    WHERE pairing_rank = 1
),
relevant_nfpms AS (
    SELECT DISTINCT nfpm_address FROM positions_found
),
nft_transfers AS (
    SELECT
        l.contract_address AS nfpm_address,
        l.topic3 AS token_id_topic,
        l.topic2 AS to_address_topic,
        ROW_NUMBER() OVER (
            PARTITION BY l.contract_address, l.topic3
            ORDER BY l.block_number DESC, l.index DESC
        ) AS rn
    FROM celo.logs l
    WHERE l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
      AND l.contract_address IN (SELECT nfpm_address FROM relevant_nfpms)
)
SELECT
    pf.pool_name,
    pf.pool_address,
    pf.nfpm_address,
    bytearray_to_uint256(pf.token_id_topic) AS token_id,
    bytearray_substring(t.to_address_topic, 13, 20) AS current_owner
FROM positions_found pf
LEFT JOIN nft_transfers t
    ON t.nfpm_address = pf.nfpm_address
   AND t.token_id_topic = pf.token_id_topic
   AND t.rn = 1
ORDER BY pf.pool_name, token_id
