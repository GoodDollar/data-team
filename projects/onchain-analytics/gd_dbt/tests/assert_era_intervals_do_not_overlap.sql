-- Era intervals must not overlap, per (chain, contract).
--
-- An era is a Type-2 validity interval: exactly one implementation is behind a proxy at any block.
-- Two overlapping intervals mean the "which ABI was in force at block N" question has two answers,
-- and a topic0-keyed decoder would take whichever the join happened to return -- silently, and
-- differently between runs.
--
-- Intervals are HALF-OPEN, [valid_from_block, valid_to_block), which is the convention the era
-- lookup in the pipeline already implements. Two intervals therefore overlap when one starts
-- strictly before the other ends AND ends strictly after the other starts. Touching intervals
-- (a.valid_to = b.valid_from) are correct and must not be flagged.
--
-- Returns a row (i.e. fails) for each overlapping pair.

WITH intervals AS (
  SELECT
    chain,
    chain_id,
    proxy_address,
    era_index,
    CAST(valid_from_block AS INT64) AS valid_from_block,
    CAST(valid_to_block AS INT64)   AS valid_to_block
  FROM {{ ref('era_intervals') }}
)

SELECT
  a.chain,
  a.proxy_address,
  a.era_index      AS era_a,
  b.era_index      AS era_b,
  a.valid_from_block AS a_from,
  a.valid_to_block   AS a_to,
  b.valid_from_block AS b_from,
  b.valid_to_block   AS b_to
FROM intervals a
JOIN intervals b
  ON  a.chain_id      = b.chain_id
  AND a.proxy_address = b.proxy_address
  AND a.era_index     < b.era_index
WHERE a.valid_from_block < b.valid_to_block
  AND a.valid_to_block   > b.valid_from_block
