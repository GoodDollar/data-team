-- L3: invite_funnel_snapshot (TABLE — full daily rebuild)
-- Source: Semantic.invitee
-- Grain:  8 rows (one per funnel stage)
-- Stages 7 and 8 use bounty_timestamp as the elapsed-time anchor (OQ1 confirmed 2026-06-05).
-- See docs/02_DATA_MODEL.md §Marts.invite_funnel_snapshot

CREATE OR REPLACE TABLE `gooddollar.Marts.invite_funnel_snapshot`
AS

WITH stages AS (
  SELECT 1 AS stage_order,
         'Signed Up as Invitee'                        AS stage_label,
         COUNT(*)                                       AS user_count
  FROM `gooddollar.Semantic.invitee`

  UNION ALL

  SELECT 2,
         'Claimed at Least Once (Invite Chain)',
         COUNTIF(total_claims_on_invite_network >= 1)
  FROM `gooddollar.Semantic.invitee`

  UNION ALL

  SELECT 3,
         'Claimed at Least Twice (Invite Chain)',
         COUNTIF(total_claims_on_invite_network >= 2)
  FROM `gooddollar.Semantic.invitee`

  UNION ALL

  SELECT 4,
         'Claimed 3+ Times (Invite Chain)',
         COUNTIF(total_claims_on_invite_network >= 3)
  FROM `gooddollar.Semantic.invitee`

  UNION ALL

  SELECT 5,
         'Met Eligibility Criteria (3 claims + 7 days)',
         COUNTIF(
           total_claims_on_invite_network >= 3
           AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), signup_timestamp, DAY) >= 7
         )
  FROM `gooddollar.Semantic.invitee`

  UNION ALL

  SELECT 6,
         'Bounty Paid',
         COUNTIF(bounty_tx_hash IS NOT NULL)
  FROM `gooddollar.Semantic.invitee`

  UNION ALL

  -- Stage 7: retained if they claimed at least once in the 7 days after bounty payment,
  -- AND the 7-day window has already elapsed (bounty paid >= 7 days ago).
  -- Elapsed-time anchor: bounty_timestamp (OQ1 resolved).
  SELECT 7,
         'Retained (7 Days Post-Payout)',
         COUNTIF(
           bounty_tx_hash IS NOT NULL
           AND post_payout_claims_7d >= 1
           AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), bounty_timestamp, DAY) >= 7
         )
  FROM `gooddollar.Semantic.invitee`

  UNION ALL

  -- Stage 8: retained if they claimed at least once in the 30 days after bounty payment,
  -- AND the 30-day window has already elapsed.
  SELECT 8,
         'Retained (30 Days Post-Payout)',
         COUNTIF(
           bounty_tx_hash IS NOT NULL
           AND post_payout_claims_30d >= 1
           AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), bounty_timestamp, DAY) >= 30
         )
  FROM `gooddollar.Semantic.invitee`
)

SELECT
  CURRENT_TIMESTAMP() AS snapshot_timestamp,
  'invite_funnel'     AS funnel_name,
  stage_order,
  stage_label,
  user_count,
  ROUND(SAFE_DIVIDE(user_count, MAX(user_count) OVER ()) * 100, 2) AS pct_of_top
FROM stages
ORDER BY stage_order;
