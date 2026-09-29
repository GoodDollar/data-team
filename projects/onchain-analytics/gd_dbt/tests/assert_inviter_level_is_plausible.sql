-- The inviter-level tripwire.
--
-- `inviter_level` is an INDEX into the contract's levels array, not a token amount, so it is not
-- decimals-scaled and its plausible range is tiny. That makes it the cheapest tripwire in the
-- system and one of the most discriminating: a decoder reading one word out of step returns an
-- address-shaped or 1e18-shaped integer here, and either is caught immediately.
--
-- Measured at 0 on every InviterBounty row in the warehouse, so the level-based variation the
-- model supports has never actually occurred on this chain. The bound is set well above that
-- rather than at it, because the test exists to catch a decode error and not to freeze the
-- protocol's current configuration.
--
-- Returns a row (i.e. fails) for any level outside the band.

SELECT
  network,
  tx_hash,
  log_index,
  inviter_level
FROM {{ ref('invite_payouts') }}
WHERE inviter_level IS NOT NULL
  AND (inviter_level < 0 OR inviter_level > 100)
