-- Every event_surface row must name a (chain, proxy_address, era_index) that exists in
-- contract_deployments.
--
-- WHY THIS IS A SINGULAR TEST AND NOT A relationships TEST. The seed's own documentation states
-- the binding rule as "bind on (chain, proxy_address, era_index), not on a contract name". dbt's
-- built-in relationships test takes one column, so the declared version checked proxy_address
-- alone. Measured against the delivered seed on 2026-09-24: an era_index corrupted to one past
-- that contract's real maximum passes the single-column test on 2,824 of 2,824 rows. It constrains
-- nothing about the era, which is the half of the key that actually varies.
--
-- WHAT THIS TEST DOES NOT CATCH, stated because a test trusted beyond its reach is worse than no
-- test. Re-derived on the delivered seed, not inherited:
--   era_index wrong   2,824 rows corrupted, 2,824 caught. Complete.
--   chain wrong         742 rows corruptible,  156 caught, which is 21 percent.
-- The residue is 14 addresses deployed at the identical address with the identical era index on
-- two chains, so a flipped chain still resolves to a real row. That is invisible to any foreign
-- key and needs a different check, most likely comparing the runtime code hash per chain.
--
-- On the seed as delivered, zero rows fail either version. This is a missing guard, not an active
-- defect.
SELECT
  s.chain,
  s.proxy_address,
  s.era_index,
  s.event_signature
FROM {{ ref('event_surface') }} s
LEFT JOIN {{ ref('contract_deployments') }} d
  ON  d.chain          = s.chain
  AND d.proxy_address  = s.proxy_address
  AND d.era_index      = s.era_index
WHERE d.proxy_address IS NULL
