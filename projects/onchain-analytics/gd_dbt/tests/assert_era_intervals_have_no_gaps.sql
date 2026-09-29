-- Era intervals must leave no gap between a contract's deployment and its head.
--
-- A gap is worse than an overlap. An overlap gives two answers to "which ABI was in force at block
-- N"; a gap gives NONE, and a left join against a missing interval returns null rather than
-- raising, so every log in the gap decodes to nothing and is indistinguishable from a block range
-- that produced no logs at all.
--
-- Intervals are half-open, so "no gap" is an exact equality: era N's valid_to_block must equal
-- era N+1's valid_from_block. The first era must start at the contract's creation block, and the
-- last must be open ended (the INT64 sentinel) when the contract is live.
--
-- Returns a row (i.e. fails) for each break in the chain.

WITH intervals AS (
  SELECT
    chain,
    chain_id,
    proxy_address,
    contract_name,
    CAST(era_index AS INT64)        AS era_index,
    CAST(valid_from_block AS INT64) AS valid_from_block,
    CAST(valid_to_block AS INT64)   AS valid_to_block,
    is_live
  FROM {{ ref('era_intervals') }}
),

deployment AS (
  SELECT
    chain_id,
    proxy_address,
    CAST(era_index AS INT64)      AS era_index,
    CAST(creation_block AS INT64) AS creation_block
  FROM {{ ref('contract_deployments') }}
  WHERE era_method != 'no_code_deployed'
    AND era_index = '1'
),

-- 1. A break between one era and the next.
interior AS (
  SELECT
    a.chain,
    a.proxy_address,
    a.contract_name,
    'era_boundary_not_contiguous' AS failure,
    a.era_index                   AS era_index,
    a.valid_to_block              AS expected_next_from,
    b.valid_from_block            AS actual_next_from
  FROM intervals a
  JOIN intervals b
    ON  a.chain_id      = b.chain_id
    AND a.proxy_address = b.proxy_address
    AND b.era_index     = a.era_index + 1
  WHERE a.valid_to_block != b.valid_from_block
),

-- 2. The first era must open where the contract was created.
left_edge AS (
  SELECT
    i.chain,
    i.proxy_address,
    i.contract_name,
    'first_era_does_not_start_at_creation' AS failure,
    i.era_index,
    d.creation_block AS expected_next_from,
    i.valid_from_block AS actual_next_from
  FROM intervals i
  JOIN deployment d
    ON  i.chain_id      = d.chain_id
    AND i.proxy_address = d.proxy_address
  WHERE i.era_index = 1
    AND i.valid_from_block != d.creation_block
),

-- 3. A live contract's last era must reach the head, i.e. carry the open-ended sentinel.
right_edge AS (
  SELECT
    chain,
    proxy_address,
    contract_name,
    'live_contract_last_era_is_not_open_ended' AS failure,
    era_index,
    9223372036854775807 AS expected_next_from,
    valid_to_block      AS actual_next_from
  FROM intervals
  WHERE is_live = 'true'
    AND valid_to_block != 9223372036854775807
)

SELECT * FROM interior
UNION ALL
SELECT * FROM left_edge
UNION ALL
SELECT * FROM right_edge
