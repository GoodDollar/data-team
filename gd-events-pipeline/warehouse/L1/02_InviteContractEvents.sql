-- L1: InviteContractEvents
-- Source: GoodDollar Invite contract — InviteeJoined + InviterBounty events
-- Written by: pipeline/index.ts via streaming insert
-- See: docs/02_DATA_MODEL.md

CREATE OR REPLACE TABLE `gooddollar.BlockchainEvents.InviteContractEvents` (
  network          STRING   OPTIONS(description = "Chain name: XDC, CELO, ETHEREUM"),
  chain_id         INT64    OPTIONS(description = "EVM chain id: 50, 42220, 1"),
  block_number     INT64,
  block_hash       STRING,
  block_timestamp  TIMESTAMP OPTIONS(description = "UTC. Primary time dimension."),
  tx_hash          STRING,
  tx_index         INT64,
  tx_from          STRING,
  tx_to            STRING,
  tx_value         STRING,
  tx_status        INT64,
  tx_nonce         INT64,
  log_index        INT64    OPTIONS(description = "Position in block; part of dedup key"),
  contract_address STRING   OPTIONS(description = "Lowercase hex"),
  event_name       STRING   OPTIONS(description = "'InviteeJoined' or 'InviterBounty'"),
  ingested_at      TIMESTAMP OPTIONS(description = "Pipeline write time, NOT block time"),
  inviter          STRING   OPTIONS(description = "Inviter address. See sentinel rules in 02_DATA_MODEL.md."),
  invitee          STRING   OPTIONS(description = "Invitee address (lowercase hex)"),
  bounty_paid      STRING   OPTIONS(description = "InviterBounty only — uint256 total disbursed"),
  inviter_level    STRING   OPTIONS(description = "InviterBounty only — inviter tier at payout"),
  earned_level     BOOL     OPTIONS(description = "InviterBounty only — did this payout level the inviter up")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, invitee
OPTIONS (
  description = "Raw decoded InviteeJoined + InviterBounty events from the GoodDollar Invite contract. Dedup key (network, tx_hash, log_index)."
);
