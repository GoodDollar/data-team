-- Fan-out guard: claim_events joins the tokens seed, and a duplicate GD row for a chain
-- would multiply every claim. A row-count mismatch against staging is the only check that
-- catches that, because uniqueness on (tx_hash, log_index) would also fail but only after
-- the numbers had already been wrong in any model that aggregates before deduplicating.
--
-- Returns a row (i.e. fails) when the counts differ.

WITH staged AS (
  SELECT COUNT(*) AS n FROM {{ ref('claim_contract_events') }}
),
semantic AS (
  SELECT COUNT(*) AS n FROM {{ ref('claim_events') }}
)

SELECT
  staged.n   AS staging_row_count,
  semantic.n AS semantic_row_count,
  semantic.n - staged.n AS difference
FROM staged
CROSS JOIN semantic
WHERE staged.n != semantic.n
