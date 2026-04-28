-- L1: ClaimContractEvents
-- Source: UBIScheme contract — UBIClaimed events
-- Written by: pipeline/index.ts via streaming insert
-- See: docs/02_DATA_MODEL.md

CREATE OR REPLACE TABLE `gooddollar.BlockchainEvents.ClaimContractEvents` (
  network          STRING   OPTIONS(description = "Chain name: XDC, CELO, ETHEREUM"),
  chain_id         INT64    OPTIONS(description = "EVM chain id: 50, 42220, 1"),
  block_number     INT64,
  block_hash       STRING,
  block_timestamp  TIMESTAMP OPTIONS(description = "UTC. Primary time dimension."),
  tx_hash          STRING,
  tx_index         INT64,
  tx_from          STRING,
  tx_to            STRING,
  tx_value         STRING   OPTIONS(description = "Native token wei (uint256 → STRING)"),
  tx_status        INT64    OPTIONS(description = "1 = success, 0 = reverted"),
  tx_nonce         INT64,
  log_index        INT64    OPTIONS(description = "Position in block; part of dedup key"),
  contract_address STRING   OPTIONS(description = "Lowercase hex"),
  event_name       STRING   OPTIONS(description = "Always 'UBIClaimed'"),
  ingested_at      TIMESTAMP OPTIONS(description = "Pipeline write time, NOT block time"),
  claimer          STRING   OPTIONS(description = "Wallet that claimed UBI (lowercase)"),
  amount           STRING   OPTIONS(description = "uint256 raw; divide by 100 in L2 for G$ face value")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, claimer
OPTIONS (
  description = "Raw decoded UBIClaimed events from UBIScheme contracts. Dedup key (network, tx_hash, log_index)."
);
