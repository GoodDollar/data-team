{{
  config(
    materialized = 'table'
  )
}}

/*
  L3 Mart: invite_funnel_snapshot
  Source: semantic.invitee_lifecycle (via ref)
  Grain: 6 rows (one per funnel stage)
  Purpose: invite funnel conversion snapshot for dashboard use.
  Equivalent to the current gooddollar.Marts.invite_funnel_snapshot table.
  See docs/02_DATA_MODEL.md §Marts.invite_funnel_snapshot
*/

-- Eligibility computed at query time (changes with the calendar even when no
-- new chain events arrive). See docs/02_DATA_MODEL.md for rationale.
WITH lifecycle_with_eligibility AS (
  SELECT
    *,
    -- Met eligibility = 3+ claims AND 7+ days since signup. Includes already-paid users.
    (total_claims_on_invite_network >= 3
     AND TIMESTAMP_DIFF({{ latest_closed_as_of_timestamp() }}, signup_timestamp, DAY) >= 7) AS met_eligibility_criteria
  FROM {{ ref('invitee_lifecycle') }}
),

stages AS (
  SELECT 1 AS stage_order, 'Signed Up as Invitee'                          AS stage_label, COUNT(*)                                                                          AS user_count FROM lifecycle_with_eligibility
  UNION ALL
  SELECT 2,                'Claimed at Least Once (Invite Chain)',                          COUNTIF(total_claims_on_invite_network >= 1)                                                FROM lifecycle_with_eligibility
  UNION ALL
  SELECT 3,                'Claimed at Least Twice (Invite Chain)',                         COUNTIF(total_claims_on_invite_network >= 2)                                                FROM lifecycle_with_eligibility
  UNION ALL
  SELECT 4,                'Claimed 3+ Times (Invite Chain)',                               COUNTIF(total_claims_on_invite_network >= 3)                                                FROM lifecycle_with_eligibility
  UNION ALL
  SELECT 5,                'Met Eligibility Criteria (3 claims + 7 days)',                  COUNTIF(met_eligibility_criteria)                                                           FROM lifecycle_with_eligibility
  UNION ALL
  SELECT 6,                'Bounty Paid',                                                   COUNTIF(bounty_tx_hash IS NOT NULL)                                                         FROM lifecycle_with_eligibility
)

SELECT
  CURRENT_TIMESTAMP() AS snapshot_timestamp,
  'invite_funnel'     AS funnel_name,
  stage_order,
  stage_label,
  user_count,
  ROUND(SAFE_DIVIDE(user_count, MAX(user_count) OVER ()) * 100, 2) AS pct_of_top
FROM stages
ORDER BY stage_order
