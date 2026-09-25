-- =================================================================================================
-- RETIRE THE v3 EVENT TABLES
-- =================================================================================================
-- SEPARATE FROM THE CONTRACT ON PURPOSE. 06_L0Contract_v4.sql destroys nothing, so it can be run
-- at any time without a decision. This file drops tables, so running it is a deliberate choice and
-- requires a maintainer to make it.
--
-- WHAT IT DROPS, AND WHY THAT IS SAFE. Every table below held ZERO rows when this was written,
-- measured directly against the live dataset rather than assumed:
--
--   IdentityContractEvents   0 rows
--   TokenTransferEvents      0 rows
--   TokenSupplyEvents        0 rows
--   TokenAdminEvents         0 rows
--   StreamEvents             0 rows
--   TokenAgreementEvents     0 rows
--   ReserveContractEvents    0 rows
--   DexPoolEvents            0 rows
--   UnknownEvents            0 rows
--
-- Nothing in the transformation project reads any of them. Their definitions remain in
-- warehouse/L1/04_L0Contract_v3.sql, so every one of them is one command away from existing again.
--
-- RE-CHECK BEFORE RUNNING. The counts above were true on the day this was written. Run section 1
-- first and read the output. If any table reports a non-zero count, STOP: Something has written to
-- it since, and that is a fact worth understanding before it is destroyed.
--
-- WHAT IT DOES NOT DROP, AND WILL NOT.
--   ClaimContractEvents  holds 2,649,450 rows
--   InviteContractEvents holds     7,093 rows
--   IngestionStatus      holds        20 rows
--   PipelineRuns         holds        22 rows
--   OracleReconciliation holds       265 rows
-- Those are altered and annotated, never dropped, and this file leaves them alone. They are
-- retired only after the v4 backfill has reconciled against the contracts themselves.
--
-- Run:  Bq query --use_legacy_sql=false < warehouse/L1/07_RetireV3EventTables.sql
-- =================================================================================================


-- -------------------------------------------------------------------------------------------------
-- 1. The check. Run this alone first and read every number.
-- -------------------------------------------------------------------------------------------------
SELECT
  table_id,
  row_count,
  size_bytes,
  TIMESTAMP_MILLIS(last_modified_time) AS last_modified
FROM `gooddollar.BlockchainEvents.__TABLES__`
WHERE table_id IN (
  'IdentityContractEvents', 'TokenTransferEvents', 'TokenSupplyEvents', 'TokenAdminEvents',
  'StreamEvents', 'TokenAgreementEvents', 'ReserveContractEvents', 'DexPoolEvents', 'UnknownEvents'
)
ORDER BY row_count DESC, table_id;


-- -------------------------------------------------------------------------------------------------
-- 2. The drops. Only after section 1 shows zero for every table listed.
-- -------------------------------------------------------------------------------------------------
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.IdentityContractEvents`;
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.TokenTransferEvents`;
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.TokenSupplyEvents`;
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.TokenAdminEvents`;
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.StreamEvents`;
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.TokenAgreementEvents`;
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.ReserveContractEvents`;
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.DexPoolEvents`;
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.UnknownEvents`;
