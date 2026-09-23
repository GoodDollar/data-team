-- =================================================================================================
-- L0 INGESTION CONTRACT v3.0
-- =================================================================================================
-- The raw-event and state-snapshot tables for the Celo Phase 1 expansion. Numbered 04 because it
-- follows the two live XDC table definitions; an earlier Celo draft was discarded before release.
--
-- Binding rules it enforces, each traceable to a defect this system actually hit:
--
--   L0-1  STORE THE RAW LOG, ENTIRE. All four topic slots and the data blob, as STRING, IN ADDITION
--         to decoded columns. A wrong ABI has cost this project a full re-ingest
--         twice (ReserveRatioUpdated uint256 against uint32; Mento Swap indexed positions). With
--         the raw log retained, a decoding error becomes a SQL change instead.
--
--   L0-2  EVERY uint256 AND int256 IS STRING. No exceptions, including values that fit today.
--         Unix seconds fit in INT64 and WhitelistedAuthenticated.timestamp is still uint256, so it
--         is STRING. Audit F23. The published 746,346,941,824,389,497 came from ignoring this.
--
--   L0-3  BIND ON topic0, NEVER ON AN EVENT NAME, and store the topic0 that was matched. Names collide across eras; selectors do not. Storing it makes a decoding mistake
--         auditable after the fact rather than invisible.
--
--   L0-4  EVERY ROW SELF-IDENTIFIES ITS ERA via implementation_address, read from the EIP-1967 slot
--         at that row's own block. No downstream model should need a seed join to
--         know which contract semantics applied.
--
--   L0-5  ONE GRAIN PER TABLE. A table is one log of one kind of thing. Admin events do not live in
--         the transfer table, because a staging model cannot be simultaneously one-to-one with its
--         source, grained as a transfer, and non-null on sender and amount..
--
--   L0-6  EVERY ROW CARRIES ITS INGESTION RUN. Provenance is not optional after a range was
--         ingested twice in production and nobody could tell which run wrote which row.
--
-- Two tables carry production data and are ALTERED, never dropped: ClaimContractEvents (2,692,446
-- rows) and InviteContractEvents (9,260 rows). Added columns are nullable and backfill separately.
--
-- Run:  bq query --use_legacy_sql=false < warehouse/L1/04_L0Contract_v3.sql
-- =================================================================================================


-- -------------------------------------------------------------------------------------------------
-- 1. ContractStateSnapshots
--
-- THE TABLE THAT DID NOT EXIST, AND THE REASON ALL THREE DESIGNS NEEDED IT.
--
-- Reserve ratio moves on every sell with no event. Whitelist expiry moves on a chain-wide parameter
-- change with no event on the affected wallet. A Superfluid balance moves every second with no
-- transaction at all. None of those are recoverable from any event stream, at any level of
-- ingestion diligence, because the chain never emitted them.
--
-- NARROW BY DESIGN, one row per reading, not one wide row per block. If paused()
-- succeeds and getPoolExchange() reverts, a wide row cannot say so honestly and fills with nulls
-- that read as measured zeros. This is not hypothetical: getPoolExchange reverts at every block
-- before 31,533,481, inside the intended backfill range.
--
-- A FAILED READ IS A ROW, NEVER A GAP AND NEVER A FORWARD FILL.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `gooddollar.BlockchainEvents.ContractStateSnapshots`
(
  network                STRING    NOT NULL,
  chain_id               INT64     NOT NULL,
  block_number           INT64     NOT NULL,
  block_hash             STRING    OPTIONS(description="Null only when the read itself failed before a block was resolved"),
  block_timestamp        TIMESTAMP NOT NULL OPTIONS(description="The block's own timestamp. Never derived from a block rate; Celo went 5s to 1s in May 2025"),
  contract_name          STRING    NOT NULL OPTIONS(description="Logical name, stable across eras"),
  contract_address       STRING    NOT NULL,
  implementation_address STRING    OPTIONS(description="EIP-1967 slot at this block. L0-4"),
  reading_key            STRING    NOT NULL OPTIONS(description="e.g. reserveRatio, totalSupply, getNetFlow, lastAuthenticated"),
  subject                STRING    OPTIONS(description="The argument, where the read takes one: an address, or a bytes32 exchange id. Null for nullary reads"),
  value_raw              STRING    OPTIONS(description="uint256 or int256 as STRING. L0-2. SIGNED values keep their sign: realtimeBalanceOf returns int256 and the negative IS the finding"),
  value_bool             BOOL      OPTIONS(description="For boolean reads such as paused() and isWhitelisted()"),
  value_address          STRING    OPTIONS(description="For address reads such as getWhitelistedRoot()"),
  unit                   STRING    NOT NULL OPTIONS(description="WEI_18, RATIO_1E8, UNIX_SECONDS, COUNT, BOOL, ADDRESS, WEI_PER_SECOND. Names the scale so nobody divides by the wrong thing"),
  denominator            STRING    OPTIONS(description="The literal denominator where one applies, e.g. 100000000 for MAX_WEIGHT. Publishing a raw 40416114 as a percentage is the 1e16 defect in a new costume"),
  read_status            STRING    NOT NULL OPTIONS(description="ok | revert | rpc_error | unreadable. NEVER null. A revert is a fact about the chain; an rpc_error is a fact about us"),
  read_error             STRING    OPTIONS(description="Verbatim revert reason or transport error"),
  endpoint               STRING    NOT NULL OPTIONS(description="Which endpoint answered. Endpoint behaviour is a MOVING property, not a fixed one"),
  confirmed_second_endpoint BOOL   OPTIONS(description="TRUE only when a second endpoint returned an identical value. Required for any negative or zero-shaped result"),
  cadence                STRING    NOT NULL OPTIONS(description="daily_close | event_block | event_block_minus_one | era_boundary | backfill"),
  ingested_at            TIMESTAMP NOT NULL,
  ingestion_run_id       STRING    OPTIONS(description="L0-6")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, contract_name, reading_key;


-- -------------------------------------------------------------------------------------------------
-- 2. ClaimContractEvents  ALTER, production data present
--
-- The live table decodes UBIClaimed only and has one column for its payload. Eight
-- event types must fit. Each new column names exactly one event's one field: claimer is never
-- reused for account, and amount is never reused for fished_amount, because they are different
-- quantities paid to different parties under different rules and one column forces a null test
-- that is right for one event and wrong for the other.
-- -------------------------------------------------------------------------------------------------
ALTER TABLE `gooddollar.BlockchainEvents.ClaimContractEvents`
  ADD COLUMN IF NOT EXISTS topic0                 STRING OPTIONS(description="The matched selector. L0-3"),
  ADD COLUMN IF NOT EXISTS topic1                 STRING,
  ADD COLUMN IF NOT EXISTS topic2                 STRING,
  ADD COLUMN IF NOT EXISTS topic3                 STRING,
  ADD COLUMN IF NOT EXISTS log_data               STRING OPTIONS(description="The raw data blob. L0-1"),
  ADD COLUMN IF NOT EXISTS implementation_address STRING OPTIONS(description="EIP-1967 slot at this block. L0-4. UBIScheme has 4 eras"),
  ADD COLUMN IF NOT EXISTS gas_used               INT64,
  ADD COLUMN IF NOT EXISTS effective_gas_price    STRING OPTIONS(description="uint256 as STRING. L0-2"),
  ADD COLUMN IF NOT EXISTS ingestion_run_id       STRING OPTIONS(description="L0-6"),
  ADD COLUMN IF NOT EXISTS account                STRING OPTIONS(description="ActivatedUser.account and InactiveUserFished.account. Era 1 only, blocks 18,006,679 to 19,276,071"),
  ADD COLUMN IF NOT EXISTS caller                 STRING OPTIONS(description="InactiveUserFished.caller, the fisher. NOT the fished account"),
  ADD COLUMN IF NOT EXISTS fished_amount          STRING OPTIONS(description="InactiveUserFished.amount. Deliberately NOT reused from amount"),
  ADD COLUMN IF NOT EXISTS fished_total           STRING OPTIONS(description="TotalFished.total"),
  ADD COLUMN IF NOT EXISTS ubi_day                INT64  OPTIONS(description="UBICalculated.day, UBICycleCalculated.day, DaySet.newDay. The protocol day, which runs noon to noon UTC and is NOT a calendar date"),
  ADD COLUMN IF NOT EXISTS daily_ubi_raw          STRING OPTIONS(description="UBICalculated.dailyUbi. All-in-data, no indexed fields: a decoder expecting an indexed day finds nothing and must not write zero"),
  ADD COLUMN IF NOT EXISTS event_block_number     INT64  OPTIONS(description="UBICalculated.blockNumber, the contract's own claim about its block. Kept distinct from block_number so the two can be compared"),
  ADD COLUMN IF NOT EXISTS cycle_pool_raw         STRING OPTIONS(description="UBICycleCalculated.pool, the scheme balance at cycle start"),
  ADD COLUMN IF NOT EXISTS cycle_length_days      INT64  OPTIONS(description="UBICycleCalculated.cycleLength"),
  ADD COLUMN IF NOT EXISTS daily_cycle_pool_raw   STRING OPTIONS(description="UBICycleCalculated.dailyUBIPool"),
  ADD COLUMN IF NOT EXISTS dao_prev_balance_raw   STRING OPTIONS(description="WithdrawFromDao.prevBalance"),
  ADD COLUMN IF NOT EXISTS dao_new_balance_raw    STRING OPTIONS(description="WithdrawFromDao.newBalance");


-- -------------------------------------------------------------------------------------------------
-- 3. InviteContractEvents  ALTER, production data present
-- -------------------------------------------------------------------------------------------------
ALTER TABLE `gooddollar.BlockchainEvents.InviteContractEvents`
  ADD COLUMN IF NOT EXISTS topic0                 STRING OPTIONS(description="L0-3"),
  ADD COLUMN IF NOT EXISTS topic1                 STRING,
  ADD COLUMN IF NOT EXISTS topic2                 STRING,
  ADD COLUMN IF NOT EXISTS topic3                 STRING,
  ADD COLUMN IF NOT EXISTS log_data               STRING OPTIONS(description="L0-1"),
  ADD COLUMN IF NOT EXISTS implementation_address STRING OPTIONS(description="L0-4. Invites has 8 eras, the most of any contract in this system"),
  ADD COLUMN IF NOT EXISTS gas_used               INT64,
  ADD COLUMN IF NOT EXISTS effective_gas_price    STRING,
  ADD COLUMN IF NOT EXISTS ingestion_run_id       STRING OPTIONS(description="L0-6");


-- -------------------------------------------------------------------------------------------------
-- 4. IdentityContractEvents  REBUILD, table is empty
--
-- Was created 2026-09-21 with authenticated_timestamp as INT64. That field is uint256. Audit F23.
-- Unix seconds fitting today is not a reason to violate raw fidelity, and the failure mode is a
-- rejected insert that hard-stops a backfill.
--
-- NOTE ON SCOPE: this design does NOT replay these events to reconstruct whitelist state. That
-- approach absorbed thirteen audit findings across three passes and cannot work, because chain-wide
-- parameter changes moved every wallet's expiry six times with no wallet event. Eligibility comes
-- from claims, which are enforced proof, and from state reads. These events are ingested for
-- attribution, not for reconstruction.
-- -------------------------------------------------------------------------------------------------
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.IdentityContractEvents`;
CREATE TABLE `gooddollar.BlockchainEvents.IdentityContractEvents`
(
  network                STRING    NOT NULL,
  chain_id               INT64     NOT NULL OPTIONS(description="42220 for Celo. Pipeline defect B1 hardcoded this to 50"),
  block_number           INT64     NOT NULL,
  block_hash             STRING    NOT NULL OPTIONS(description="Reorg reconciliation. Cannot be retrofitted, so it is NOT NULL from row one"),
  block_timestamp        TIMESTAMP NOT NULL,
  tx_hash                STRING    NOT NULL,
  tx_index               INT64,
  log_index              INT64     NOT NULL,
  contract_address       STRING    NOT NULL,
  implementation_address STRING    OPTIONS(description="L0-4. Identity has 5 eras and the V4 boundary at 61,416,834 changed the meaning of whitelist expiry"),
  topic0                 STRING    NOT NULL OPTIONS(description="L0-3"),
  topic1                 STRING,
  topic2                 STRING,
  topic3                 STRING,
  log_data               STRING    OPTIONS(description="L0-1"),
  event_name             STRING    NOT NULL OPTIONS(description="Derived from topic0, never used to bind"),
  account                 STRING   OPTIONS(description="Subject address"),
  counterparty_account    STRING   OPTIONS(description="AccountConnected and AccountDisconnected only, which exist from block 61,416,834. Their absence before that is NOT evidence that no connections existed: connectedAccounts is a public mapping in every era and is readable by state"),
  authenticated_timestamp STRING   OPTIONS(description="uint256 as STRING. L0-2. Contract-supplied, NOT block_timestamp: authenticateWithTimestamp lets an admin set it to any value, so the gap is an input, not drift"),
  did                     STRING   OPTIONS(description="Raw DID string where the event carries one"),
  chain_id_claimed        STRING   OPTIONS(description="uint256 as STRING. The chain id asserted by cross-chain whitelisting paths"),
  tx_from                STRING,
  tx_to                  STRING,
  tx_status              INT64,
  gas_used               INT64,
  effective_gas_price    STRING,
  ingested_at            TIMESTAMP NOT NULL,
  ingestion_run_id       STRING    OPTIONS(description="L0-6")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, account, event_name;


-- -------------------------------------------------------------------------------------------------
-- 5. TokenTransferEvents  REBUILD, table is empty
--
-- ERC20 Transfer ONLY. L0-5. The 2026-09-21 version also held BlockedUpdated, which makes the
-- staging model simultaneously one-to-one with its source, grained as a transfer, and tested
-- non-null on sender, receiver and amount. Every blocklist row violates that. Audit F8.
--
-- READ THIS BEFORE BUILDING ANY FLOW, HOLDER OR VOLUME METRIC ON THIS TABLE.
-- GD on Celo is a live Superfluid SuperToken. Balances change every second, by agreement, with no
-- transaction and no event of any kind. MEASURED: a balance moving by exactly 2,315,940,197,129,030
-- wei per second across consecutive blocks; an account losing 516,484.018264840183908 GD in one
-- hour with zero Transfer legs in an exhausted index. At current rates streams move about 1.7
-- percent of the entire token supply per day, invisibly to this table.
--
-- THIS TABLE IS THEREFORE COMPLETE FOR DISCRETE TRANSFERS AND INCOMPLETE FOR MOVEMENT. Supply
-- reconciles from it exactly, because _totalSupply has only two writers and both emit. Balances do
-- not reconcile from it at all. Anything named total volume, holder balance or market cap needs
-- StreamEvents and ContractStateSnapshots as well.
-- -------------------------------------------------------------------------------------------------
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.TokenTransferEvents`;
CREATE TABLE `gooddollar.BlockchainEvents.TokenTransferEvents`
(
  network                STRING    NOT NULL,
  chain_id               INT64     NOT NULL,
  block_number           INT64     NOT NULL,
  block_hash             STRING    NOT NULL,
  block_timestamp        TIMESTAMP NOT NULL,
  tx_hash                STRING    NOT NULL,
  tx_index               INT64,
  log_index              INT64     NOT NULL,
  contract_address       STRING    NOT NULL,
  implementation_address STRING    OPTIONS(description="L0-4. The GD token has 7 eras and its Superfluid UUPS proxy does NOT emit Upgraded, so this column is the only per-row era evidence"),
  topic0                 STRING    NOT NULL,
  topic1                 STRING,
  topic2                 STRING,
  topic3                 STRING,
  log_data               STRING,
  event_name             STRING    NOT NULL OPTIONS(description="Transfer only in this table"),
  token_address          STRING    NOT NULL OPTIONS(description="Kept separate from contract_address so a second token needs no schema change"),
  from_address           STRING    NOT NULL,
  to_address             STRING    NOT NULL,
  value                  STRING    NOT NULL OPTIONS(description="uint256 as STRING. L0-2. Cast to BIGNUMERIC at the point of division and NEVER divide by POW(), which returns FLOAT64 and silently drops precision"),
  tx_from                STRING,
  tx_to                  STRING,
  tx_status              INT64,
  gas_used               INT64,
  effective_gas_price    STRING,
  ingested_at            TIMESTAMP NOT NULL,
  ingestion_run_id       STRING
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, from_address, to_address;


-- -------------------------------------------------------------------------------------------------
-- 6. TokenSupplyEvents  NEW
--
-- Minted, Burned, Sent, ERC777 and ERC677 variants, TransferFee. Held OUT of the transfer table so
-- that no consumer can sum them alongside Transfer by accident and double count. L0-5.
--
-- TransferFee has never been charged, re-established from source plus state reads rather than from
-- a log scan. It is ingested anyway, as a tripwire: the day it fires, transfer amounts and balance
-- deltas stop agreeing and something must notice.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `gooddollar.BlockchainEvents.TokenSupplyEvents`
(
  network                STRING    NOT NULL,
  chain_id               INT64     NOT NULL,
  block_number           INT64     NOT NULL,
  block_hash             STRING    NOT NULL,
  block_timestamp        TIMESTAMP NOT NULL,
  tx_hash                STRING    NOT NULL,
  tx_index               INT64,
  log_index              INT64     NOT NULL,
  contract_address       STRING    NOT NULL,
  implementation_address STRING,
  topic0                 STRING    NOT NULL,
  topic1                 STRING,
  topic2                 STRING,
  topic3                 STRING,
  log_data               STRING,
  event_name             STRING    NOT NULL,
  token_address          STRING,
  operator_address       STRING    OPTIONS(description="ERC777 operator"),
  from_address           STRING,
  to_address             STRING,
  amount                 STRING    OPTIONS(description="uint256 as STRING"),
  fee_amount             STRING    OPTIONS(description="TransferFee only. Has never been non-null; if it ever is, reconciliation R2 must fail"),
  operator_data          STRING,
  user_data              STRING,
  tx_from                STRING,
  tx_to                  STRING,
  tx_status              INT64,
  gas_used               INT64,
  effective_gas_price    STRING,
  ingested_at            TIMESTAMP NOT NULL,
  ingestion_run_id       STRING
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, event_name;


-- -------------------------------------------------------------------------------------------------
-- 7. TokenAdminEvents  NEW
--
-- BlockedUpdated and the access-control surface. A blocked address cannot move the token, so a
-- silent address may be prohibited rather than inactive, and an activity model that cannot tell
-- those apart reports the wrong thing.
--
-- The seed currently says 15 addresses were blocked in one transaction at block 77,233,730. That is
-- WRONG, measured: 15 addresses across THREE blocks. It is the worked example of
-- why a single-pass log scan is not evidence. Those addresses hold about 44 percent of total supply.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `gooddollar.BlockchainEvents.TokenAdminEvents`
(
  network                STRING    NOT NULL,
  chain_id               INT64     NOT NULL,
  block_number           INT64     NOT NULL,
  block_hash             STRING    NOT NULL,
  block_timestamp        TIMESTAMP NOT NULL,
  tx_hash                STRING    NOT NULL,
  tx_index               INT64,
  log_index              INT64     NOT NULL,
  contract_address       STRING    NOT NULL,
  implementation_address STRING,
  topic0                 STRING    NOT NULL,
  topic1                 STRING,
  topic2                 STRING,
  topic3                 STRING,
  log_data               STRING,
  event_name             STRING    NOT NULL,
  blocked_account        STRING    OPTIONS(description="BlockedUpdated"),
  is_blocked             BOOL      OPTIONS(description="BlockedUpdated. TRUE means the address can no longer move the token"),
  role                   STRING    OPTIONS(description="bytes32 role id, RoleGranted and RoleRevoked"),
  role_account           STRING,
  role_sender            STRING,
  paused_account         STRING    OPTIONS(description="Paused and Unpaused"),
  new_code_address       STRING    OPTIONS(description="CodeUpdated, the Superfluid UUPS upgrade path that does NOT emit a standard Upgraded event"),
  tx_from                STRING,
  tx_to                  STRING,
  tx_status              INT64,
  gas_used               INT64,
  effective_gas_price    STRING,
  ingested_at            TIMESTAMP NOT NULL,
  ingestion_run_id       STRING
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, event_name;


-- -------------------------------------------------------------------------------------------------
-- 8. StreamEvents  NEW.  The table that makes GD movement accountable at all.
--
-- CFAv1, GDAv1, IDAv1. These events mark the moments a flow rate CHANGES. They do not carry the
-- amount moved, because no event can: the amount is an integral of a rate over clock time.
-- Integrating it is a model's job; capturing every rate change is this table's job, and a missed
-- FlowUpdated corrupts every subsequent interval, not just its own.
--
-- DO NOT TAKE THE START BLOCK FROM ANY DOCUMENT, INCLUDING THIS ONE. Take it from contract
-- creation. A widely-copied declared start block was found to sit 570 real events late.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `gooddollar.BlockchainEvents.StreamEvents`
(
  network                STRING    NOT NULL,
  chain_id               INT64     NOT NULL,
  block_number           INT64     NOT NULL,
  block_hash             STRING    NOT NULL,
  block_timestamp        TIMESTAMP NOT NULL OPTIONS(description="Load bearing. The integral runs on clock time, so a wrong timestamp is a wrong amount"),
  tx_hash                STRING    NOT NULL,
  tx_index               INT64,
  log_index              INT64     NOT NULL,
  contract_address       STRING    NOT NULL OPTIONS(description="CFAv1, GDAv1 or IDAv1"),
  agreement_class        STRING    OPTIONS(description="cfa | gda | ida"),
  implementation_address STRING,
  topic0                 STRING    NOT NULL,
  topic1                 STRING,
  topic2                 STRING,
  topic3                 STRING,
  log_data               STRING,
  event_name             STRING    NOT NULL,
  token_address          STRING    OPTIONS(description="Filtered to GD at ingestion, stored so the filter is auditable"),
  sender_address         STRING,
  receiver_address       STRING,
  flow_operator          STRING,
  flow_rate              STRING    OPTIONS(description="int96 as STRING, wei per second. SIGNED. L0-2"),
  total_sender_flow_rate STRING    OPTIONS(description="int256 as STRING, signed"),
  total_receiver_flow_rate STRING  OPTIONS(description="int256 as STRING, signed"),
  deposit                STRING    OPTIONS(description="uint256 as STRING. Locked at stream open and subtracted from available balance with no Transfer, so it is a third invisible balance effect"),
  owed_deposit           STRING,
  pool_address           STRING    OPTIONS(description="GDA pools"),
  tx_from                STRING,
  tx_to                  STRING,
  tx_status              INT64,
  gas_used               INT64,
  effective_gas_price    STRING,
  ingested_at            TIMESTAMP NOT NULL,
  ingestion_run_id       STRING
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, sender_address, receiver_address;


-- -------------------------------------------------------------------------------------------------
-- 9. TokenAgreementEvents  NEW
--
-- The token's own view of agreement lifecycle, including liquidations and bailouts. Distinct from
-- StreamEvents, which is the agreement contracts' view. Keeping both means the two can be
-- reconciled against each other instead of trusted.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `gooddollar.BlockchainEvents.TokenAgreementEvents`
(
  network                STRING    NOT NULL,
  chain_id               INT64     NOT NULL,
  block_number           INT64     NOT NULL,
  block_hash             STRING    NOT NULL,
  block_timestamp        TIMESTAMP NOT NULL,
  tx_hash                STRING    NOT NULL,
  tx_index               INT64,
  log_index              INT64     NOT NULL,
  contract_address       STRING    NOT NULL,
  implementation_address STRING,
  topic0                 STRING    NOT NULL,
  topic1                 STRING,
  topic2                 STRING,
  topic3                 STRING,
  log_data               STRING,
  event_name             STRING    NOT NULL,
  agreement_class        STRING,
  agreement_id           STRING    OPTIONS(description="bytes32"),
  account                STRING,
  liquidator_account     STRING,
  penalty_account        STRING,
  bond_account           STRING,
  reward_amount          STRING    OPTIONS(description="uint256 as STRING"),
  bailout_amount         STRING    OPTIONS(description="uint256 as STRING"),
  tx_from                STRING,
  tx_to                  STRING,
  tx_status              INT64,
  gas_used               INT64,
  effective_gas_price    STRING,
  ingested_at            TIMESTAMP NOT NULL,
  ingestion_run_id       STRING
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, event_name;


-- -------------------------------------------------------------------------------------------------
-- 10. ReserveContractEvents  REBUILD, table is empty
--
-- The 2026-09-21 version specified ReserveRatioUpdated(bytes32,uint256). The deployed event is
-- (bytes32,uint32). A type change alters the selector, so a conforming decoder finds ZERO ratio
-- events forever, with no error. That is this specification's own named trap occurring inside the
-- specification.
--
-- AND EVENTS ARE NOT SUFFICIENT HERE REGARDLESS. reserveRatio, tokenSupply and reserveBalance all
-- move on ordinary sells through code paths that emit nothing, because the 10 percent exit
-- contribution burns supply without paying reserve. ExchangeCreated and ExchangeUpdated have all
-- three parameters indexed and an EMPTY data section, so they announce that something changed and
-- nothing about what. Reserve state comes from ContractStateSnapshots. This table is for
-- attribution: who traded, when, how much.
--
-- Swap indexed positions, from the DEPLOYED contract: exchangeId, trader and tokenIn are indexed;
-- exchangeProvider is in the data section. Indexed flags do not change the selector, so a
-- wrong-but-plausible ABI returns exactly the expected row count while writing four business fields
-- into the wrong columns.
--
-- Ingest from block 31,415,857, the Broker proxy creation. The widely-copied 34,100,000 truncates
-- 570 real swaps.
-- -------------------------------------------------------------------------------------------------
DROP TABLE IF EXISTS `gooddollar.BlockchainEvents.ReserveContractEvents`;
CREATE TABLE `gooddollar.BlockchainEvents.ReserveContractEvents`
(
  network                STRING    NOT NULL,
  chain_id               INT64     NOT NULL,
  block_number           INT64     NOT NULL,
  block_hash             STRING    NOT NULL,
  block_timestamp        TIMESTAMP NOT NULL,
  tx_hash                STRING    NOT NULL,
  tx_index               INT64,
  log_index              INT64     NOT NULL,
  contract_address       STRING    NOT NULL OPTIONS(description="Broker, exchange provider or reserve"),
  implementation_address STRING    OPTIONS(description="L0-4"),
  topic0                 STRING    NOT NULL,
  topic1                 STRING,
  topic2                 STRING,
  topic3                 STRING,
  log_data               STRING    OPTIONS(description="L0-1. Load bearing here: ExchangeCreated and ExchangeUpdated carry NOTHING but indexed topics, and ReserveRatioUpdated was specified with the wrong type once already"),
  event_name             STRING    NOT NULL,
  exchange_provider      STRING    OPTIONS(description="Swap. From the DATA section, NOT a topic"),
  exchange_id            STRING    OPTIONS(description="bytes32 hex. INDEXED on Swap"),
  trader                 STRING    OPTIONS(description="INDEXED on Swap"),
  token_in               STRING    OPTIONS(description="INDEXED on Swap"),
  token_out              STRING    OPTIONS(description="Swap, from DATA"),
  amount_in              STRING    OPTIONS(description="uint256 as STRING"),
  amount_out             STRING    OPTIONS(description="uint256 as STRING. NOT a price source: amount_out over amount_in is the execution rate net of the 10 percent exit contribution and sits 11.1 percent from the curve price"),
  reserve_ratio_raw      STRING    OPTIONS(description="ReserveRatioUpdated, uint32 over MAX_WEIGHT 100000000. Named _raw so nobody publishes 40416114 as a percentage"),
  exit_contribution_raw  STRING    OPTIONS(description="ExitContributionSet, uint32 over MAX_WEIGHT. Constant at 10000000 across 47 sampled blocks spanning all of history, two endpoints, but governance can move it"),
  paused_account         STRING,
  reserve_asset          STRING,
  token_address          STRING,
  tx_from                STRING,
  tx_to                  STRING,
  tx_status              INT64,
  gas_used               INT64,
  effective_gas_price    STRING,
  ingested_at            TIMESTAMP NOT NULL,
  ingestion_run_id       STRING
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, event_name, trader;


-- -------------------------------------------------------------------------------------------------
-- 11. DexPoolEvents  NEW
--
-- Pool coverage before this design was 1 of 9: eight pair-style pools across three factories, plus
-- a Uniswap V4 singleton holding 550 million GD whose pools NO ADDRESS-BASED METHOD CAN DISCOVER,
-- because V4 holds every pool inside one contract and identifies them by pool id.
--
-- V4 is therefore bound by pool id in the topics, not by address, which is why this table keeps
-- pool_id alongside pool_address and why the raw topics are mandatory.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `gooddollar.BlockchainEvents.DexPoolEvents`
(
  network                STRING    NOT NULL,
  chain_id               INT64     NOT NULL,
  block_number           INT64     NOT NULL,
  block_hash             STRING    NOT NULL,
  block_timestamp        TIMESTAMP NOT NULL,
  tx_hash                STRING    NOT NULL,
  tx_index               INT64,
  log_index              INT64     NOT NULL,
  contract_address       STRING    NOT NULL OPTIONS(description="The pool, or the V4 PoolManager singleton"),
  implementation_address STRING,
  topic0                 STRING    NOT NULL,
  topic1                 STRING,
  topic2                 STRING,
  topic3                 STRING,
  log_data               STRING,
  event_name             STRING    NOT NULL,
  dex_protocol           STRING    OPTIONS(description="uniswap_v2 | uniswap_v3 | uniswap_v4 | other"),
  pool_address           STRING    OPTIONS(description="Null for V4, which has no per-pool address"),
  pool_id                STRING    OPTIONS(description="bytes32. V4 only. The ONLY way to identify a V4 pool"),
  sender_address         STRING,
  recipient_address      STRING,
  amount0                STRING    OPTIONS(description="int256 as STRING, SIGNED. V4 sign convention is INVERTED from V3: negative means the caller owes the pool"),
  amount1                STRING    OPTIONS(description="int256 as STRING, SIGNED. Same warning"),
  liquidity_delta        STRING    OPTIONS(description="int256 as STRING, signed. NOT int128"),
  sqrt_price_x96         STRING,
  tick                   INT64,
  tx_from                STRING,
  tx_to                  STRING,
  tx_status              INT64,
  gas_used               INT64,
  effective_gas_price    STRING,
  ingested_at            TIMESTAMP NOT NULL,
  ingestion_run_id       STRING
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY network, dex_protocol, pool_address;

