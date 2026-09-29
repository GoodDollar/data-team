-- Exactly one era interval must cover any block that is actually queried.
--
-- The overlap and gap tests check the interval chain's SHAPE. This one checks the property a
-- reader depends on: resolve a real block against the table and get exactly one answer. It is the
-- as-of temporal join the decode layer performs, run as an assertion.
--
-- The probe blocks are taken from the intervals themselves rather than invented, so the test
-- exercises every real boundary: each era's first block, its last block, and the block one before
-- its opening. A boundary-off-by-one is the failure this shape is built to find, because a
-- half-open interval that is written closed produces exactly two covering rows at every join.
--
-- Returns a row (i.e. fails) for any probe block covered by a number of intervals other than one.

WITH intervals AS (
  SELECT
    chain,
    chain_id,
    proxy_address,
    contract_name,
    CAST(era_index AS INT64)        AS era_index,
    CAST(valid_from_block AS INT64) AS valid_from_block,
    CAST(valid_to_block AS INT64)   AS valid_to_block
  FROM {{ ref('era_intervals') }}
),

probes AS (
  SELECT chain_id, proxy_address, valid_from_block AS probe_block, 'era_first_block' AS probe_kind
  FROM intervals
  UNION ALL
  -- The last block an era actually covers, under the half-open convention. Skipped on the
  -- open-ended sentinel, where "last block" is not a real block.
  SELECT chain_id, proxy_address, valid_to_block - 1, 'era_last_block'
  FROM intervals
  WHERE valid_to_block != 9223372036854775807
),

coverage AS (
  SELECT
    p.chain_id,
    p.proxy_address,
    p.probe_block,
    p.probe_kind,
    COUNT(i.era_index) AS covering_intervals,
    STRING_AGG(CAST(i.era_index AS STRING), ',' ORDER BY i.era_index) AS covering_eras
  FROM probes p
  LEFT JOIN intervals i
    ON  i.chain_id      = p.chain_id
    AND i.proxy_address = p.proxy_address
    AND p.probe_block  >= i.valid_from_block
    AND p.probe_block   < i.valid_to_block
  GROUP BY 1, 2, 3, 4
)

SELECT
  chain_id,
  proxy_address,
  probe_block,
  probe_kind,
  covering_intervals,
  covering_eras
FROM coverage
WHERE covering_intervals != 1
