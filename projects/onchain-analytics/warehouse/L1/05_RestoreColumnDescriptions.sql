-- warehouse/L1/05_RestoreColumnDescriptions.sql
--
-- One-time repair, 2026-09-23.
--
-- The in-place de-duplication of the two production tables was a CREATE OR REPLACE TABLE ... AS
-- SELECT. That form carries the data and drops the documentation: column descriptions and the
-- table description are not inherited. The pipeline's dedup operation now captures and restores
-- them, so this file exists to put back what the first run of it removed, and is safe to re-run.
--
-- Two corrections are folded in rather than restored verbatim, because restoring a wrong
-- description is not a repair:
--
--   amount on ClaimContractEvents read "divide by 100 in L2 for G face value". That is the 1e2
--   defect this project already fixed on a live dashboard-facing mart. GD has 18 decimals on XDC
--   and on Celo, and 2 on Fuse and Ethereum, read from each token contract and corroborated
--   against real event magnitudes on two chains.
--
--   Both tables said they were written by pipeline/index.ts via streaming insert. That pipeline
--   has been retired. The write path is pipeline-v5, staging plus MERGE.

ALTER TABLE `gooddollar.BlockchainEvents.ClaimContractEvents`
  ALTER COLUMN network          SET OPTIONS(description = "Chain name: XDC, CELO, ETHEREUM"),
  ALTER COLUMN chain_id         SET OPTIONS(description = "EVM chain id: 50, 42220, 1. Taken from the network binding, never a constant"),
  ALTER COLUMN block_timestamp  SET OPTIONS(description = "UTC. Primary time dimension. The protocol day runs noon to noon UTC and is NOT this date"),
  ALTER COLUMN tx_value         SET OPTIONS(description = "Native token wei, uint256 as STRING"),
  ALTER COLUMN tx_status        SET OPTIONS(description = "1 = success, 0 = reverted"),
  ALTER COLUMN gas_used         SET OPTIONS(description = "Gas consumed by the transaction"),
  ALTER COLUMN effective_gas_price SET OPTIONS(description = "uint256 as STRING. L0-2"),
  ALTER COLUMN log_index        SET OPTIONS(description = "Position in block. Part of the natural key (network, tx_hash, log_index)"),
  ALTER COLUMN contract_address SET OPTIONS(description = "Lowercase hex"),
  ALTER COLUMN event_name       SET OPTIONS(description = "Decoded event name. UBIClaimed for every row ingested to date"),
  ALTER COLUMN ingested_at      SET OPTIONS(description = "Pipeline write time, NOT block time. Written once on insert and never rewritten by a later run"),
  ALTER COLUMN claimer          SET OPTIONS(description = "Wallet that claimed UBI"),
  ALTER COLUMN amount           SET OPTIONS(description = "UBIClaimed.amount, uint256 raw. GD has 18 decimals on XDC and Celo, and 2 on Fuse and Ethereum, so divide by 1e18 for these rows. Never assume one factor across chains"),
  ALTER COLUMN topic0           SET OPTIONS(description = "The matched selector. L0-3"),
  ALTER COLUMN topic1           SET OPTIONS(description = "First indexed field, raw. L0-1"),
  ALTER COLUMN topic2           SET OPTIONS(description = "Second indexed field, raw. L0-1"),
  ALTER COLUMN topic3           SET OPTIONS(description = "Third indexed field, raw. L0-1"),
  ALTER COLUMN log_data         SET OPTIONS(description = "The raw data blob. L0-1. Retained so a wrong ABI becomes a SQL change instead of a re-ingest"),
  ALTER COLUMN implementation_address SET OPTIONS(description = "EIP-1967 slot at this block. L0-4. UBIScheme has 4 eras"),
  ALTER COLUMN ingestion_run_id SET OPTIONS(description = "L0-6. The run that first inserted this row. NULL on rows written before provenance was recorded"),
  ALTER COLUMN account          SET OPTIONS(description = "ActivatedUser.account and InactiveUserFished.account. Era 1 only, blocks 18,006,679 to 19,276,071"),
  ALTER COLUMN caller           SET OPTIONS(description = "InactiveUserFished.caller, the fisher. NOT the fished account"),
  ALTER COLUMN fished_amount    SET OPTIONS(description = "InactiveUserFished.amount. Deliberately NOT reused from amount"),
  ALTER COLUMN fished_total     SET OPTIONS(description = "TotalFished.total"),
  ALTER COLUMN ubi_day          SET OPTIONS(description = "UBICalculated.day, UBICycleCalculated.day, DaySet.newDay. The protocol day, which runs noon to noon UTC and is NOT a calendar date"),
  ALTER COLUMN daily_ubi_raw    SET OPTIONS(description = "UBICalculated.dailyUbi. All-in-data, no indexed fields: a decoder expecting an indexed day finds nothing and must not write zero"),
  ALTER COLUMN event_block_number SET OPTIONS(description = "UBICalculated.blockNumber, the contract's own claim about its block. Kept distinct from block_number so the two can be compared"),
  ALTER COLUMN cycle_pool_raw   SET OPTIONS(description = "UBICycleCalculated.pool, the scheme balance at cycle start"),
  ALTER COLUMN cycle_length_days SET OPTIONS(description = "UBICycleCalculated.cycleLength"),
  ALTER COLUMN daily_cycle_pool_raw SET OPTIONS(description = "UBICycleCalculated.dailyUBIPool"),
  ALTER COLUMN dao_prev_balance_raw SET OPTIONS(description = "WithdrawFromDao.prevBalance"),
  ALTER COLUMN dao_new_balance_raw  SET OPTIONS(description = "WithdrawFromDao.newBalance");

ALTER TABLE `gooddollar.BlockchainEvents.ClaimContractEvents`
  SET OPTIONS(description = "Raw decoded UBIScheme events. Natural key (network, tx_hash, log_index). Written by pipeline-v5 through a staging table and a MERGE, so re-ingesting a block range is idempotent. Reconciled per protocol day against getClaimerCount and getClaimAmount on the contract; see the OracleReconciliation table.");

ALTER TABLE `gooddollar.BlockchainEvents.InviteContractEvents`
  ALTER COLUMN network          SET OPTIONS(description = "Chain name: XDC, CELO, ETHEREUM"),
  ALTER COLUMN chain_id         SET OPTIONS(description = "EVM chain id: 50, 42220, 1. Taken from the network binding, never a constant"),
  ALTER COLUMN block_timestamp  SET OPTIONS(description = "UTC. Primary time dimension"),
  ALTER COLUMN tx_value         SET OPTIONS(description = "Native token wei, uint256 as STRING"),
  ALTER COLUMN tx_status        SET OPTIONS(description = "1 = success, 0 = reverted"),
  ALTER COLUMN gas_used         SET OPTIONS(description = "Gas consumed by the transaction"),
  ALTER COLUMN effective_gas_price SET OPTIONS(description = "uint256 as STRING. L0-2"),
  ALTER COLUMN log_index        SET OPTIONS(description = "Position in block. Part of the natural key (network, tx_hash, log_index)"),
  ALTER COLUMN contract_address SET OPTIONS(description = "Lowercase hex"),
  ALTER COLUMN event_name       SET OPTIONS(description = "InviteeJoined or InviterBounty"),
  ALTER COLUMN ingested_at      SET OPTIONS(description = "Pipeline write time, NOT block time. Written once on insert and never rewritten by a later run"),
  ALTER COLUMN inviter          SET OPTIONS(description = "Inviter address. See the sentinel rules in docs/02_DATA_MODEL.md"),
  ALTER COLUMN invitee          SET OPTIONS(description = "Invitee address"),
  ALTER COLUMN bounty_paid      SET OPTIONS(description = "InviterBounty only, uint256 raw. GD has 18 decimals on XDC, so divide by 1e18. The contract's own stats() confirms 1,000 GD per paid bounty to the inviter"),
  ALTER COLUMN inviter_level    SET OPTIONS(description = "InviterBounty only, inviter tier at payout"),
  ALTER COLUMN earned_level     SET OPTIONS(description = "InviterBounty only, whether this payout levelled the inviter up"),
  ALTER COLUMN topic0           SET OPTIONS(description = "The matched selector. L0-3"),
  ALTER COLUMN topic1           SET OPTIONS(description = "First indexed field, raw. L0-1"),
  ALTER COLUMN topic2           SET OPTIONS(description = "Second indexed field, raw. L0-1"),
  ALTER COLUMN topic3           SET OPTIONS(description = "Third indexed field, raw. L0-1"),
  ALTER COLUMN log_data         SET OPTIONS(description = "The raw data blob. L0-1"),
  ALTER COLUMN implementation_address SET OPTIONS(description = "L0-4. Invites has 8 eras, the most of any contract in this system"),
  ALTER COLUMN ingestion_run_id SET OPTIONS(description = "L0-6. The run that first inserted this row. NULL on rows written before provenance was recorded");

ALTER TABLE `gooddollar.BlockchainEvents.InviteContractEvents`
  SET OPTIONS(description = "Raw decoded InviteeJoined and InviterBounty events from the GoodDollar Invite contract. Natural key (network, tx_hash, log_index). Written by pipeline-v5 through a staging table and a MERGE. Reconciled against the contract's own stats() counters.");
