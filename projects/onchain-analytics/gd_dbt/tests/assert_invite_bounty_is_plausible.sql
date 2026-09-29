-- The invite bounty decimals tripwire.
--
-- The sibling of `assert_claim_amount_is_plausible`, for the other consumed amount field. The need
-- is the same and it is not hypothetical: a wrong scale factor produces a plausible-looking number
-- off by a power of ten, and every grain, referential and domain test passes on it happily.
--
-- `bounty_paid` is the inviter's own portion, a uint256 in 18-decimal token units. Measured at
-- 1000 GD on all 939 rows in the warehouse, and the contract's levels array supports a level-based
-- bonus above that, so the upper bound leaves room for a protocol change without leaving room for
-- a factor error.
--
-- The LOWER bound is the one that catches a wrong-layout decode rather than a wrong scale. A
-- decoder reading an event against the wrong indexed layout returns a word from the wrong offset,
-- and those come back as tiny integers -- 4, for instance, being the byte length of a string read
-- as a uint256. A real bounty is never a few raw units of an 18-decimal token.
--
-- Returns a row (i.e. fails) for any payout outside the band.

SELECT
  network,
  tx_hash,
  log_index,
  payout_origin,
  inviter_amount_g,
  total_amount_g
FROM {{ ref('invite_payouts') }}
WHERE inviter_amount_g IS NOT NULL
  AND (
    -- above any plausible bounty: the divide is missing, or the factor is too small
    inviter_amount_g > 100000
    -- at or below zero: a referral payout is never free
    OR inviter_amount_g <= 0
    -- below a millionth of one token: the signature of a wrong-layout decode, not a small payout
    OR inviter_amount_g < 0.000001
  )
