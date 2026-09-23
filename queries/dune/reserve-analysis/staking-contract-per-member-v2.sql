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
    -- The reviewed wallet roster is per-account data and is NOT published with
    -- this query. Paste the addresses from the local-only
    -- projects/reserve-analysis/scripts/rpc-checks/_wallet-list.json here as
    -- (0x...), (0x...) rows before running in Dune. The placeholder below keeps
    -- the query valid and returns already_on_burn_refund_list = false for everyone.
    SELECT * FROM (
        VALUES
            (0x0000000000000000000000000000000000000000)
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
