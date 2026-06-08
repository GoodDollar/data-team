-- L3: top_inviters (TABLE — full daily rebuild)
-- Sources: Semantic.invitee, Semantic.invite_payouts
-- Grain:   1 row per inviter_address (referral inviters only; campaign signups excluded
--          because campaign invitees have no human inviter — inviter_address IS NULL)
-- See docs/02_DATA_MODEL.md §Marts.top_inviters

CREATE OR REPLACE TABLE `gooddollar.Marts.top_inviters`
AS

SELECT
  i.inviter_address,
  COUNT(*)                                                          AS total_invitees,
  COUNTIF(i.total_claims_on_invite_network >= 3)                    AS converted_invitees,
  SAFE_DIVIDE(
    COUNTIF(i.total_claims_on_invite_network >= 3),
    COUNT(*)
  ) * 100                                                           AS conversion_rate_pct,
  CAST(SUM(COALESCE(p.inviter_amount_g, 0)) AS FLOAT64)             AS total_g_earned
FROM `gooddollar.Semantic.invitee` i
LEFT JOIN `gooddollar.Semantic.invite_payouts` p
  ON p.invitee_address = i.invitee_address
WHERE i.inviter_address IS NOT NULL
GROUP BY i.inviter_address
ORDER BY converted_invitees DESC, total_invitees DESC;
