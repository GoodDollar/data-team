-- L2: claimer_activity (VIEW)
-- Source: Semantic.claim_events
-- Purpose: per-(claimer, network) rollup. Powers retention, cohort, engagement metrics
--          without re-aggregating L1 every time.
-- See docs/02_DATA_MODEL.md §Semantic.claimer_activity

CREATE OR REPLACE VIEW `gooddollar.Semantic.claimer_activity` AS

SELECT
  claimer_address,
  network,
  ANY_VALUE(chain_id)                          AS chain_id,
  MIN(block_timestamp)                         AS first_claim_timestamp,
  MAX(block_timestamp)                         AS latest_claim_timestamp,
  COUNT(*)                                     AS total_claims,
  SUM(amount_g)                                AS total_amount_g,
  COUNT(DISTINCT DATE(block_timestamp))        AS active_days
FROM `gooddollar.Semantic.claim_events`
GROUP BY claimer_address, network;
