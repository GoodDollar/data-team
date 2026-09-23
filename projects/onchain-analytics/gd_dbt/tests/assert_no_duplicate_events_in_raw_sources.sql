-- Keeps the L0 ingestion defect VISIBLE.
--
-- The staging models deduplicate on (network, tx_hash, log_index) so that published numbers are
-- correct today. That is a symptom fix, and a symptom fix that hides its own cause is how a
-- defect becomes permanent. This test reads the raw tables directly and reports any duplication,
-- so the dbt run surfaces the ingestion problem every time it is run.
--
-- Configured as a warning rather than an error: the downstream numbers are correct because of
-- the dedup, so this should not block a build. It should be impossible to ignore.
--
-- Known state as at 2026-09-21:
--   ClaimContractEvents   43,000 phantom rows, blocks ~95,864,458 to ~96,213,000
--                         (2025-11-10 to 2025-11-19), ingested 2026-04-28 and again 2026-06-07
--   InviteContractEvents   2,167 phantom rows of 9,260
--
-- This clears when ingestion becomes idempotent over re-run block ranges and the affected
-- ranges are rewritten.

{{ config(severity = 'warn') }}

WITH claims AS (
  SELECT
    'ClaimContractEvents' AS source_table,
    COUNT(*) AS rows_stored,
    COUNT(DISTINCT CONCAT(network, '|', tx_hash, '#', CAST(log_index AS STRING))) AS real_events
  FROM {{ source('blockchain_events', 'ClaimContractEvents') }}
),
invites AS (
  SELECT
    'InviteContractEvents',
    COUNT(*),
    COUNT(DISTINCT CONCAT(network, '|', tx_hash, '#', CAST(log_index AS STRING)))
  FROM {{ source('blockchain_events', 'InviteContractEvents') }}
),
combined AS (
  SELECT * FROM claims
  UNION ALL
  SELECT * FROM invites
)

SELECT
  source_table,
  rows_stored,
  real_events,
  rows_stored - real_events AS phantom_rows
FROM combined
WHERE rows_stored != real_events
