/*
GoodDollar Sep 2026 incident: staking/voting-power contract per-member net
stake, CORRECTED (v2)

Supersedes staking-contract-per-member.sql. That version summed every
MemberRegisteredWithCovenant/MemberPowerIncreased amount as an incremental
delta. Running it produced a total of 247,268,256 GD across 141 members,
10.36x the contract's actual live GD balance (23,864,251.86, confirmed via
balanceOf), which is impossible if the logic were right. That proves the
assumption flagged in v1's own comments was wrong: MemberPowerIncreased's
_stakedAmount is a RESTATED ABSOLUTE TOTAL each time it fires, not an
incremental top-up, so members who called it more than once got summed
multiple times over.

Corrected model: a member's current stake is whatever their MOST RECENT
event says, not a sum of all their events ("last write wins", a state
machine, not a ledger of deltas):
  - most recent event is MemberUnregistered -> current stake = 0 (full exit)
  - most recent event is MemberRegisteredWithCovenant or MemberPowerIncreased
    -> current stake = that event's amount field (already an absolute
    total, not added to anything prior)

"Most recent" is ordered by (block_number, log index) since Dune's celo.logs
does not provide a cross-event global sequence number directly.

Same 3 event signatures as v1 (confirmed empirically against live Celoscan-
decoded transactions, unchanged): MemberRegisteredWithCovenant
(0x0bd09b1e448ffe881e884ac37014bf3e0274007308056b6469b50fa485542abf),
MemberPowerIncreased
(0x576605f9bfe8911e7508bed3763c7c5c8eb3b86e8b360b90a4bc6abe1104cb7f),
MemberUnregistered
(0xa13f4668aacb68c4e9eed8e3f6e1cbec3eca776896ec46b5eabcc3983fc8f5f4).

Sanity check to run after this: SUM(net_staked_gd) over all rows should
land close to 23,864,251.86 (the contract's live GD balance). It will not
match exactly (this is a point-in-time balance vs. a log replay, and
timing/dust differences are expected), but it should be the same order of
magnitude, not 10x off.

NOT YET RUN/VERIFIED IN DUNE, paste and run before trusting the output.
*/

WITH registered AS (
    SELECT
        bytearray_substring(l.data, 13, 20) AS member,
        CAST(bytearray_to_uint256(bytearray_substring(l.data, 33, 32)) AS DOUBLE) / 1e18 AS amount,
        l.block_number,
        l.index AS log_index
    FROM celo.logs l
    WHERE l.contract_address = 0xF42C9Ca2b10010142e2bAc34eBdDDB0b82177684
      AND l.topic0 = 0x0bd09b1e448ffe881e884ac37014bf3e0274007308056b6469b50fa485542abf
),
power_increased AS (
    SELECT
        bytearray_substring(l.data, 13, 20) AS member,
        CAST(bytearray_to_uint256(bytearray_substring(l.data, 33, 32)) AS DOUBLE) / 1e18 AS amount,
        l.block_number,
        l.index AS log_index
    FROM celo.logs l
    WHERE l.contract_address = 0xF42C9Ca2b10010142e2bAc34eBdDDB0b82177684
      AND l.topic0 = 0x576605f9bfe8911e7508bed3763c7c5c8eb3b86e8b360b90a4bc6abe1104cb7f
),
unregistered AS (
    SELECT
        bytearray_substring(l.data, 13, 20) AS member,
        CAST(0 AS DOUBLE) AS amount,
        l.block_number,
        l.index AS log_index
    FROM celo.logs l
    WHERE l.contract_address = 0xF42C9Ca2b10010142e2bAc34eBdDDB0b82177684
      AND l.topic0 = 0xa13f4668aacb68c4e9eed8e3f6e1cbec3eca776896ec46b5eabcc3983fc8f5f4
),
all_events AS (
    SELECT *, 'register_or_increase' AS kind FROM registered
    UNION ALL
    SELECT *, 'register_or_increase' AS kind FROM power_increased
    UNION ALL
    SELECT *, 'unregister' AS kind FROM unregistered
),
ranked AS (
    SELECT
        member,
        amount,
        kind,
        block_number,
        log_index,
        ROW_NUMBER() OVER (PARTITION BY member ORDER BY block_number DESC, log_index DESC) AS rn
    FROM all_events
),
known_list AS (
    SELECT * FROM (
        VALUES
            (0x22fa3239c4bf43d05cc587ff40ea3ba5841c6709), (0xa779ce177555284baf953de8a3246ba2444a2d34),
            (0x4f649e50680c16c9b73e646e4b396647fd153091), (0x62b7fd18f9bc72c8543801b31ce88289264f9869),
            (0xce029f6ee3c8d7e6c9338c04171b895a22428de3), (0x288dc841a52fca2707c6947b3a777c5e56cd87bc),
            (0xd7f3596fcf17e68bd7db2537c87cf8a969235c12), (0x2973a379b3fb2d869712b9296a7ea2c054426d47),
            (0x93f1f1e11b995a8bd3fe87afc404634ddbcf8624), (0x1df536323b382def549cb386fc128efe93e6f24f),
            (0xf2fb24a6cedca39b9c514833371aca29512d8a3f), (0x7f553faa8f4bbbbd16fe419bf9b5255d3ea01652),
            (0x61dd2ec85e168b4a06ae39b35eebfee8eaebea37), (0x9b27ac014671d006000b4546a3fb4796e2073241),
            (0x980abeb0f35db41c6ee67068f981d46de04823c7), (0xdedff708684052be37ec7cbe1de2e6e608e9447e),
            (0x8e089f5d70c5d5d1378f656ae74752bf65e00c8e), (0xce06ac2d581e80cc6ea4bc28f8bdb91ce887ff25),
            (0x0e9b063789909565ceda1fba162474405a151e66), (0x0e401c81611424eccd0428f309bcd41ba3057112),
            (0xc96e2cc0de82bbafebbd70c2a30db34e4c419fce), (0xd824212300be0555df8bb14278c1f25c975d1106),
            (0xc151fe0d8dd6b852d75e29e18f4791b2f806f2a6), (0x83525b2783fb2dccaf7ae5b2551fbd995dd27309),
            (0x58d6eb8cd983449dc4fb0d6b173be140dfdb63d0), (0x7f8946b257ad9a8fa55704120957901741a3346c),
            (0x744942ec88d88c4dcc3da48f18e824d765e9a245), (0x20a15f256f7537da4f707a196f6ddc3e2e8be9da),
            (0x55fbeae109d55b911d165a624e99d3e5abdddb54), (0x2c2b0310adcba409deb2739106a08a05cc4c0a79)
    ) AS t(addr)
)
SELECT
    r.member,
    r.amount AS net_staked_gd,
    r.kind AS last_event_kind,
    CASE WHEN k.addr IS NOT NULL THEN true ELSE false END AS already_on_burn_refund_list
FROM ranked r
LEFT JOIN known_list k ON r.member = k.addr
WHERE r.rn = 1 AND r.amount > 0.000001
ORDER BY r.amount DESC
