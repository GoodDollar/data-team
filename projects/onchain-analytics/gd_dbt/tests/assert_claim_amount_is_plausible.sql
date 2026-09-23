-- The decimals tripwire.
--
-- A wrong decimal factor does not produce an error, a null or a negative. It produces a
-- plausible-looking number that is off by a power of ten, which every grain, referential and
-- domain test passes happily. The only cheap defence is a magnitude assertion: a single UBI
-- claim is a small quantity of GD, and any value far outside that band means the factor is wrong.
--
-- Bounds are deliberately generous. The historical Celo daily amount has ranged from roughly
-- 74 to 333 GD per claim, and the point is to catch errors of 1e2 or more, not to police
-- protocol changes. If a legitimate change ever breaches these, widen them in one place and
-- say why in the commit.
--
-- Returns a row (i.e. fails) for any claim outside the band.

SELECT
  network,
  tx_hash,
  log_index,
  claim_amount_raw,
  claim_amount,
  token_decimals
FROM {{ ref('claim_events') }}
WHERE claim_amount IS NOT NULL
  AND (claim_amount <= 0 OR claim_amount > 100000)
