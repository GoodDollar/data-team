# BigQuery Event Schemas

One BQ table per contract. All tables share a common set of chain/block/tx/log
columns. Event-specific columns are appended at the end of each table.

## Common columns (all tables)

| Field | BQ Type | Description |
|-------|---------|-------------|
| network | STRING | Chain name: FUSE, CELO, XDC |
| chain_id | INTEGER | EVM chain ID: 122, 42220, 50 |
| block_number | INTEGER | Block number |
| block_hash | STRING | Block hash (nullable if unavailable) |
| block_timestamp | TIMESTAMP | Block timestamp in UTC (nullable for pre-backfill rows) |
| tx_hash | STRING | Transaction hash |
| tx_index | INTEGER | Transaction index within block |
| tx_from | STRING | Transaction sender address |
| tx_to | STRING | Transaction recipient address |
| tx_value | STRING | Native token value sent with tx (wei, uint256 as STRING) |
| tx_gas | STRING | Gas limit (uint256 as STRING) |
| tx_gas_price | STRING | Gas price (wei, uint256 as STRING) |
| tx_effective_gas_price | STRING | Effective gas price post-EIP-1559 (wei, uint256 as STRING) |
| tx_gas_used | STRING | Gas consumed by this transaction (uint256 as STRING) |
| tx_status | INTEGER | 1 = success, 0 = reverted |
| tx_nonce | INTEGER | Sender nonce at time of transaction |
| log_index | INTEGER | Log index within block |
| contract_address | STRING | Contract address that emitted the event |
| event_name | STRING | Solidity event name |
| ingested_at | TIMESTAMP | Wall-clock time when this batch was written |

**Deduplication key:** `(network, tx_hash, log_index)`

---

## ClaimContractEvents

Ingests all 11 events from the UBIScheme contract (GoodDollar UBI distribution).

**Contracts:**
- Fuse: `0xd253A5203817225e9768C05E5996d642fb96bA86` (firstBlock 15,747,401)
- Celo: `0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1` (firstBlock 18,006,679)
- XDC:  `0x22867567E2D80f2049200E25C6F31CB6Ec2F0faf` (firstBlock 95,249,624)

**Event-specific columns** (all nullable; populated only for the relevant event):

| Field | BQ Type | Events |
|-------|---------|--------|
| claimer | STRING | UBIClaimed — address claiming UBI |
| amount | STRING | UBIClaimed — amount claimed (uint256 as STRING) |
| day | STRING | UBICalculated, UBICycleCalculated — scheme day number |
| daily_ubi | STRING | UBICalculated — daily UBI amount |
| ubi_block_number | INTEGER | UBICalculated — block number embedded in event |
| pool | STRING | UBICycleCalculated — pool size |
| cycle_length | STRING | UBICycleCalculated — length of UBI cycle |
| daily_ubi_pool | STRING | UBICycleCalculated — daily allocation from pool |
| previous_admin | STRING | AdminChanged |
| new_admin | STRING | AdminChanged |
| beacon | STRING | BeaconUpgraded |
| new_cycle_length | STRING | CycleLengthSet |
| new_day | STRING | DaySet |
| version | INTEGER | Initialized — proxy version |
| should_withdraw_from_dao | BOOLEAN | ShouldWithdrawFromDAOSet |
| implementation | STRING | Upgraded — new implementation address |
| prev_balance | STRING | WithdrawFromDao |
| new_balance | STRING | WithdrawFromDao |

**BQ DDL:**

```sql
CREATE OR REPLACE TABLE `gooddollar.BlockchainEvents.ClaimContractEvents` (
  network                  STRING,
  chain_id                 INT64,
  block_number             INT64,
  block_hash               STRING,
  block_timestamp          TIMESTAMP,
  tx_hash                  STRING,
  tx_index                 INT64,
  tx_from                  STRING,
  tx_to                    STRING,
  tx_value                 STRING,
  tx_gas                   STRING,
  tx_gas_price             STRING,
  tx_effective_gas_price   STRING,
  tx_gas_used              STRING,
  tx_status                INT64,
  tx_nonce                 INT64,
  log_index                INT64,
  contract_address         STRING,
  event_name               STRING,
  ingested_at              TIMESTAMP,
  -- UBIClaimed
  claimer                  STRING,
  amount                   STRING,
  -- UBICalculated / UBICycleCalculated
  day                      STRING,
  daily_ubi                STRING,
  ubi_block_number         INT64,
  pool                     STRING,
  cycle_length             STRING,
  daily_ubi_pool           STRING,
  -- AdminChanged
  previous_admin           STRING,
  new_admin                STRING,
  -- BeaconUpgraded
  beacon                   STRING,
  -- CycleLengthSet
  new_cycle_length         STRING,
  -- DaySet
  new_day                  STRING,
  -- Initialized
  version                  INT64,
  -- ShouldWithdrawFromDAOSet
  should_withdraw_from_dao BOOL,
  -- Upgraded
  implementation           STRING,
  -- WithdrawFromDao
  prev_balance             STRING,
  new_balance              STRING
);
```

---

## InviteContractEvents

Ingests `InviteeJoined` and `InviterBounty` events from the GoodDollar Invite contract.

**Contracts:**
- Celo: `0x36829D1Cda92FFF5782d5d48991620664FC857d3` (firstBlock 18,483,200)
- XDC:  `0x6bd698566632bf2e81e2278f1656CB24aAF06D2e` (firstBlock 95,144,756)

**Event-specific columns:**

| Field | BQ Type | Description |
|-------|---------|-------------|
| inviter | STRING | Inviter address (both events) |
| invitee | STRING | Invitee address (both events) |
| bounty_paid | STRING | Bounty paid (InviterBounty only, uint256 as STRING) |
| inviter_level | STRING | Inviter level (InviterBounty only, uint256 as STRING) |
| earned_level | BOOLEAN | Whether level was earned (InviterBounty only) |

**BQ DDL:**

```sql
CREATE OR REPLACE TABLE `gooddollar.BlockchainEvents.InviteContractEvents` (
  network                  STRING,
  chain_id                 INT64,
  block_number             INT64,
  block_hash               STRING,
  block_timestamp          TIMESTAMP,
  tx_hash                  STRING,
  tx_index                 INT64,
  tx_from                  STRING,
  tx_to                    STRING,
  tx_value                 STRING,
  tx_gas                   STRING,
  tx_gas_price             STRING,
  tx_effective_gas_price   STRING,
  tx_gas_used              STRING,
  tx_status                INT64,
  tx_nonce                 INT64,
  log_index                INT64,
  contract_address         STRING,
  event_name               STRING,
  ingested_at              TIMESTAMP,
  inviter                  STRING,
  invitee                  STRING,
  bounty_paid              STRING,
  inviter_level            STRING,
  earned_level             BOOL
);
```

---

## Adding a new contract

1. Add an entry to `CONTRACT_CONFIGS` in `index.ts` with `tableId`, `contracts`,
   `networks` (with `chainId` and `firstBlock` per network), `abi`, and `decodeToRow`.
2. Run the BQ DDL to create the table (common columns + event-specific columns).
3. Run `npx tsx index.ts backfill <key>` to load history.
4. After backfill: `npx tsx index.ts append all` covers it automatically.

---

## Notes

- **uint256 values** are stored as STRING to avoid INT64 overflow.
- **block_timestamp / tx_from / tx_to** come from HyperSync block and transaction
  data joined to the log by block number and tx hash. They will be NULL only if
  HyperSync omitted the parent record for that batch window (rare).
- **Deduplication** uses BQ streaming `insertId = network:tx_hash:log_index`.
  This deduplicates within the ~1-minute BQ streaming window. For longer windows,
  query `SELECT DISTINCT` on the dedup key.
- **Finality margins** — FUSE: 20, CELO: 64, XDC: 15 blocks.
