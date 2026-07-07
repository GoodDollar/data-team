{{
  config(
    materialized = 'view'
  )
}}

/*
  L2 Semantic: claimer_activity
  Source: semantic.claim_events (via ref)
  Purpose: per-(claimer, network) rollup. Powers retention, cohort, engagement metrics
           without re-aggregating L1 every time.
  Equivalent to the current gooddollar.Semantic.claimer_activity view.
  See docs/02_DATA_MODEL.md §Semantic.claimer_activity
*/

SELECT
  claimer_address,
  network,
  ANY_VALUE(chain_id)                          AS chain_id,
  MIN(block_timestamp)                         AS first_claim_timestamp,
  MAX(block_timestamp)                         AS latest_claim_timestamp,
  COUNT(*)                                     AS total_claims,
  SUM(amount_g)                                AS total_amount_g,
  COUNT(DISTINCT DATE(block_timestamp))        AS active_days
FROM {{ ref('claim_events') }}
GROUP BY claimer_address, network
