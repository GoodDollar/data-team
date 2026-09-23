-- The tokens seed must name exactly one GoodDollar token per chain. More than one makes the
-- decimal join in claim_events ambiguous and multiplies rows; none makes the claim disappear.
-- Returns a row (i.e. fails) for any chain that does not have exactly one.

SELECT
  chain,
  COUNT(*) AS gd_token_rows
FROM {{ ref('tokens') }}
WHERE is_gd
GROUP BY chain
HAVING COUNT(*) != 1
