-- =================================================================================================
-- L0 INGESTION CONTRACT v4.0
-- =================================================================================================
-- Supersedes warehouse/L1/04_L0Contract_v3.sql in full. v3 defined eleven tables for one chain and
-- a subset of contracts. This defines five for every contract on Celo, XDC, Fuse and Ethereum, and
-- for every contract added after it, without a further schema change.
--
-- Revised 2026-09-24 after review. The changes are L0-9 (the write contract), a topic_count column
-- so an anonymous event is captured losslessly and can be told apart from a named one, three
-- payload columns on the state snapshot table so a wrong decode is repairable without going back
-- to the chain, two all history views, and the removal of an unconditional DROP TABLE that ran
-- against production by accident.
--
-- Run:  Bq query --use_legacy_sql=false < warehouse/L1/06_L0Contract_v4.sql
--
--
-- WHAT CHANGED, AND WHY
-- ---------------------------------------------------------------------------------------------
-- v3 used DOMAIN tables: Claims, invites, identity, transfers, supply, admin, streams, agreements,
-- reserve, DEX. Each named the fields of the events it expected. That works while the set of
-- expected events is small and known.
--
-- The real surface is 146 addresses, 354 contract implementation eras and 301 distinct event
-- selectors across four chains. Under the domain pattern, a new contract or a new event on an
-- existing contract needs a new column or a new table. This system has already seen events added
-- late, removed mid-life, removed and then restored, and contracts upgraded 354 times. A schema
-- change per event makes ingestion depend on modelling, and the one thing this warehouse cannot
-- afford is for a log to go uncaptured because nobody had defined a column for it yet.
--
-- So L0 now stores ONE ROW PER LOG, undecoded, in RawLogs. Decoding moves to the staging layer,
-- which is a set of views and can be rewritten in an afternoon and rebuilt from raw. The event
-- surface it decodes against is a seed, not a schema.
--
-- The decoded columns v3 defined were never the only copy of anything. Rule L0-1 already required
-- the raw log to be stored alongside them, so a decoded column at L0 was a second rendering of
-- information the same row already held. Moving the rendering to a view removes the copy, not the
-- information.
--
--
-- THE SIX BINDING RULES, RESTATED. Each traces to a defect this system actually hit.
-- ---------------------------------------------------------------------------------------------
--
--   L0-1  STORE THE RAW LOG, ENTIRE. All four topic slots and the data blob, as STRING. A wrong
--         interface has cost this project a full re-ingest twice. With the raw log retained, a
--         decoding error becomes a view change instead of a re-ingest.
--         In v4 this rule is the whole table rather than an addition to it. log_data is NOT NULL:
--         An event with no data carries the two characters 0x, so "nothing was captured" can never
--         be confused with "the data section was empty".
--
--   L0-2  EVERY uint256 AND int256 IS STRING. No exceptions, including values that fit today.
--         Unix seconds fit in INT64 and one contract still declares a timestamp as uint256, so it
--         is STRING. A published figure of 746,346,941,824,389,497 came from ignoring this.
--         In v4, nothing at L0 is decoded at all, so the rule binds on the state snapshot table
--         and on the transaction value and gas price.
--
--   L0-3  BIND ON topic0, NEVER ON AN EVENT NAME, and store the topic0 that was matched. Names
--         collide across eras and within a single contract: The token declares two different
--         events both named Transfer, a three argument and a four argument form, with different
--         selectors. In v4 the selector is stored and NOTHING is matched at ingestion time, which
--         is the strongest possible form of this rule.
--
--   L0-4  EVERY ROW SELF-IDENTIFIES ITS ERA. implementation_address answers "which code emitted
--         this" without a join. era_index is the join key into the reference seeds. era_resolution
--         records HOW the era was established for that row, because there is no single upgrade
--         announcement event in this system: 179 eras announce with Upgraded(address), 66 with
--         CodeUpdated(bytes32,address), and 115 announce nothing at all. One contract has nine
--         eras and has never announced a single one.
--
--   L0-5  ONE GRAIN PER TABLE. A table is one kind of thing. v3 put transaction facts on every log
--         row, so a transaction with three captured logs stored its sender three times, in three
--         different tables. v4 separates the grains the chain itself defines: A log, a
--         transaction, and a state reading.
--
--   L0-6  EVERY ROW CARRIES ITS INGESTION RUN. Provenance is not optional after a range was
--         ingested twice in production and nobody could tell which run wrote which row. v4 adds
--         capture_id, which is finer than a run: One run reads many ranges from many sources, and
--         the source is what determines how much the row can be trusted.
--
--
-- L0-7  NEW IN v4. ASSURANCE TRAVELS WITH THE ROW.
-- ---------------------------------------------------------------------------------------------
-- What can be read, and how reliably, is not the same on every chain, and the differences are
-- large enough to change an answer:
--
--   One chain's main public node was measured dropping identical historical log queries between
--   20 and 90 percent of the time, with no error and no warning, and the rate moved from 85 to 60
--   and back to 85 percent inside 66 minutes on the same query. It has no second reader able to
--   confirm a negative on old ranges.
--
--   Another chain has two independent operators, proven independent by their different prune
--   points, that returned identical counts on forty of forty repetitions.
--
--   A third has exactly one endpoint in existence that serves historical state, so a two endpoint
--   agreement is unobtainable there at any price this project has found.
--
-- A row read under the first condition and a row read under the second are not the same kind of
-- fact. If they are stored identically, every consumer downstream averages them without knowing.
-- So every captured row carries an assurance grade, and the capture it came from records who
-- filled which role.
--
--   A   Two independent sources enumerated this range and returned identical results.
--   B   One source enumerated it, and a second independent source confirmed the result is not
--       incomplete in a way that source could detect. A confirmer that truncates silently can
--       refute an emptiness claim; it can never establish one.
--   C   One source only. No independent confirmation was available for this range.
--
-- The rule that makes the grade worth carrying: A MODEL THAT AGGREGATES ACROSS ROWS OF MIXED
-- ASSURANCE MUST EITHER REPORT THE MIX OR FILTER TO ONE GRADE. A count that silently spans A and
-- C is a count whose error bar nobody can state.
--
--
-- L0-8  NEW IN v4. AN ABSENCE OF ROWS IS NOT AN ABSENCE OF EVENTS.
-- ---------------------------------------------------------------------------------------------
-- A query returning nothing has two causes that no amount of care at query time can separate:
-- Nothing happened, or nobody looked. IngestionCoverage is what separates them. Every range that
-- was read is recorded with the source that read it, the range it covers, what it found, and what
-- it failed on. A block range with no coverage row was never scanned, and any model that treats
-- its emptiness as a measurement is wrong.
--
--
-- L0-9  ADDED 2026-09-24. EVERY WRITE NAMES ITS WINDOW, AND A MATCHED ROW IS REWRITTEN WHOLE.
-- ---------------------------------------------------------------------------------------------
-- Three measured facts, in the order they bite. Receipts in the verification pass of 2026-09-24.
--
--   1. A MERGE WITH NO PREDICATE ON THE TARGET SCANS THE WHOLE TARGET. Nothing about the query
--      looks wrong. Measured at 719 million rows: 0.3519 USD per run unscoped against 0.0280 USD
--      scoped, which is 3,083 USD a year against 245 at hourly ingestion. RawLogs and Transactions
--      therefore carry require_partition_filter = TRUE, which REFUSES the unscoped form outright.
--
--   2. THE WINDOW IS A LITERAL, AND IT IS THE WRITER'S JOB TO COMPUTE IT. A window derived inside
--      the statement does not work and both failures were measured. A scalar subquery in the ON
--      clause is refused by BigQuery itself with "Unsupported subquery with table in join
--      predicate", on a guarded and an unguarded table alike. A predicate correlated to the source
--      row is refused by the guard, because a filter that depends on a joined row cannot eliminate
--      a partition before the query runs. A scripting variable does satisfy the guard, but DECLARE
--      is legal only at the start of a script or block, so using one part way through a file needs
--      BEGIN ... END, and the whole submission then reports statement type SCRIPT. That matters:
--      "dry run and assert this is a single statement" is the one mechanical check that catches a
--      file which has run away into production, and this file gives that check up for nothing.
--      So every MERGE in THIS file carries a literal window and states the span it covers. The
--      pipeline computes its window in code and writes it in as a literal before submitting.
--
--   3. THE WINDOW IS PADDED ONE MONTH EACH SIDE, AND THE PADDING IS NOT DECORATION. A MERGE whose
--      target window does not cover an already present row inserts a SECOND row under the same
--      merge key. This is ordinary MERGE semantics, not a side effect of the guard: A predicate on
--      the target inside an ON clause decides which target rows are match candidates, and it was
--      reproduced on an unguarded table of this exact shape. The case that makes padding necessary
--      is a log that moves across a month boundary between two ingestions, which is what a chain
--      reorganisation near a month end does. Measured, source derived window, no padding: 2 rows
--      under one merge key. Padded one month each side: 1 row.
--      ITS BOUND, ALSO MEASURED, BECAUSE A RULE COPIED WITHOUT ITS FAILURE MODE GETS MISAPPLIED.
--      One month of padding covers a displacement back to the start of the month before the
--      source's own month, which is 31 to 62 days depending where in its month the source sits. A
--      row displaced 95 days duplicated. A re-read that rewrites a row's timestamp by more than
--      that is a correction rather than a reorganisation, and it states its own literal window
--      covering the range it rewrites.
--      The resulting duplicate is invisible to every comparison of values, because the next
--      correctly scoped MERGE updates both copies to identical content. BigQuery cannot enforce a
--      primary key, so only a GROUP BY on the merge key finds it. That test is in the dbt project
--      and it is the reason it exists.
--
--   4. A MATCHED ROW IS REWRITTEN WHOLE, INCLUDING block_timestamp. A reorganisation changes which
--      block a log lives in, so block_number, block_hash and block_timestamp are all part of what
--      changed. A MERGE CAN move a row across a monthly partition boundary on a guarded table;
--      that was tested and it works. What does not work is updating only the payload: The row then
--      carries a timestamp and a block hash describing a block that no longer contains it, sits in
--      the wrong partition, is entirely self consistent, and is invisible to every grain,
--      referential and uniqueness test in the project.
--   5. EVERY HEX IDENTIFIER IS LOWERCASED ON WRITE, AND ON THE MERGE KEY THAT IS A CORRECTNESS
--      RULE. tx_hash is part of the merge key of RawLogs and of Transactions. Two spellings of one
--      hash are two different keys, so the same log lands twice and a uniqueness test on the key
--      cannot flag it, because the two rows genuinely have different keys. Found on 2026-09-24
--      because the migration in section 8 lowercased contract_address and the four topics and not
--      tx_hash, and a re-ingest supplying a lowercase hash silently failed to match a migrated row
--      holding a mixed case one. Measured against the live tables the same day: all 2,649,450 claim
--      rows and all 7,093 invite rows already hold lowercase tx_hash and block_hash, so the hazard
--      is LATENT rather than active. It is guaranteed by nothing except the habits of the one
--      reader that wrote them. An RPC node and an index return lowercase; an explorer API returns
--      checksummed mixed case, and this warehouse plans to read from all three.
--
--
-- WHAT IS DELIBERATELY NOT HERE, AND WHAT THAT COSTS
-- ---------------------------------------------------------------------------------------------
--   No Blocks table. Block hash and block timestamp are carried on the log and transaction rows,
--   where partitioning and reorg reconciliation need them anyway. A separate row per block would
--   be tens of millions of rows to hold what those columns already hold. The cost: A block that
--   produced no captured log leaves no trace, which is IngestionCoverage's job and not a table's.
--
--   No transaction input calldata, only its four byte selector. Calldata is unbounded in size and
--   is re-fetchable per transaction from any archive node. The cost: Answering a question that
--   needs full calldata means going back to the chain for those specific transactions.
--
--   No reverted transactions. A reverted transaction emits no logs, so it cannot be reached by a
--   log filter, and capturing it needs a different reader that walks every block. The cost is real
--   and is named here rather than discovered later: An attempted claim that failed is invisible to
--   this warehouse. Closing that gap is a reader problem, not a schema problem, and this schema
--   already holds the column it would need, which is status.
--
--   Hex stays STRING and does not become BYTES. Storing a 32 byte hash as BYTES costs 34 bytes
--   against 68 for the hex rendering, which measures out at roughly 38 percent off the width of a
--   typical row. It is declined deliberately. Every seed, every explorer link, every model and
--   every human check in this system is lowercase hex, and this project's whole defect history is
--   plausible looking values that were wrong. A value a person can read and recognise at L0 is a
--   correctness property here, not a convenience, and storage is not the binding cost.
-- =================================================================================================


-- -------------------------------------------------------------------------------------------------
-- 1. RawLogs
--
-- One row per log entry. Every chain, every contract, every selector, undecoded.
--
-- GRAIN AND KEY. (chain_id, tx_hash, log_index) identifies a log entry uniquely and permanently.
-- log_index is the index within the BLOCK, which is what the chain reports, not an index within
-- the transaction. That triple is the merge key for every write to this table, which is what makes
-- re-running an ingestion range safe. It has to be: The previous pipeline was measured
-- non-idempotent and duplicated tens of thousands of rows over a re-run range.
--
-- ADDING THE 147TH CONTRACT REQUIRES NO CHANGE TO THIS TABLE. It requires a row in the
-- contract_deployments seed and rows in the event_surface seed. That is the property this shape
-- exists for.
--
-- PARTITIONING. MONTHLY on block_timestamp, and that is a measurement rather than a preference.
-- The first draft of this table used daily partitioning, which is the obvious choice and is wrong
-- here. BigQuery applies clustering WITHIN a partition, so a partition smaller than roughly one
-- storage block is one block, has nothing to skip inside it, and gets read in full.
--
-- The figures below replace an earlier set that was measured on a fixture with evenly spread keys,
-- one chain and one selector per contract. That fixture could not exercise the leading cluster
-- column or any real skew, and it manufactured wrong magnitudes in both directions: it reported
-- daily partitioning at 15.7 times a dedicated table where the honest figure is 8.97 times off a
-- perfect prune, and it credited a cluster ordering with a 16 percent advantage that collapsed to
-- 2 percent under real skew. These come from a 37.2 million row fixture carrying the 209 measured
-- keys in their measured proportions across four chains, with the heaviest single key holding half
-- the table. Bytes billed, MiB:
--
--   partition grain   whole history   30 day window   single day   all contracts, 30 days
--   DAY                      5801             710           13.6            543
--   MONTH                     909            84.5           84.5            543
--   YEAR                      726             138             78           1166
--   none                      690             180            117           1209
--
-- Read those two ways. Daily wins the single day query outright and loses everything else, because
-- its partitions are too small to prune inside. Monthly is 8.97 times better than daily on the
-- query that rebuilds a staging model, and the price is a single day read costing a whole month.
--
-- PARTITIONING IS NEEDED EVEN THOUGH EVERY ROW CARRIES A TIMESTAMP, which is not obvious. A
-- timestamp lets a query FILTER; a partition lets the engine SKIP. No partitioning against monthly
-- measured 2.2 times worse on a 30 day window and 2.8 times worse on a single day.
--
-- Monthly also removes a real operational limit: A load or query job may modify at most 4,000
-- partitions, and a complete history is about 70 monthly partitions against about 2,100 daily
-- ones, so a genesis to head backfill fits in one job rather than needing to be batched.
--
-- A PARTITION FILTER IS REQUIRED ON THIS TABLE, and the OPTIONS clause below enforces it. The
-- reason is L0-9: an unscoped MERGE scans the whole target, which measured 3,083 USD a year
-- against 245 scoped, and nothing about the statement looks wrong. An earlier draft of this
-- comment argued the opposite, that a hard requirement mostly teaches people to write a filter
-- spanning all of history. That turned out to be the cheap and correct answer rather than an
-- objection: an explicit all history filter costs about 6 percent more than no filter, and the two
-- views at the end of this file carry it so that a consumer who genuinely wants everything writes
-- no filter at all. What the requirement actually buys is that the expensive mistake is refused
-- rather than silently billed.
--
-- CLUSTERING. chain_id first, because an address is not unique across chains in this set and at
-- least one registry address is deployed at the identical address on two of them. Then
-- contract_address, then topic0, which together are exactly the filter every staging model
-- applies. Then block_number, so a scan within one contract and one selector reads in order.
-- Measured against contract_address first: 2 percent worse on contract plus selector, 45 percent
-- worse on one contract across chains, and 15 percent BETTER on "one chain, everything on it".
-- Note that a block_number range filter does NOT recover the single day case on a monthly table,
-- 84.5 MiB either way, because once the leading cluster columns narrow to one key its rows within
-- a partition are already contiguous and the partition is the floor.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `gooddollar.BlockchainEvents.RawLogs`
(
  chain_id                 INT64     NOT NULL OPTIONS(description="EVM chain id. 42220 Celo, 50 XDC, 122 Fuse, 1 Ethereum. The key, not a display name: The human name is resolved from the chains seed so that a name change never touches L0"),
  block_number             INT64     NOT NULL,
  block_timestamp          TIMESTAMP NOT NULL OPTIONS(description="The block's own timestamp. NEVER derived from a block rate: One chain in this set changed cadence from 5 seconds to 1 second mid-life, so any arithmetic from block height to time is wrong across that boundary"),
  block_hash               STRING    NOT NULL OPTIONS(description="Reorg reconciliation. Cannot be retrofitted, so it is NOT NULL from row one. The same (tx_hash, log_index) reappearing under a different block_hash IS the reorg. LOWERCASE HEX, normalised on write, for the same reason as tx_hash"),
  tx_hash                  STRING    NOT NULL OPTIONS(description="LOWERCASE HEX, normalised on write, and this is a correctness rule rather than a style one. tx_hash is part of the merge key, so two spellings of the same hash are two different keys and the same log would be stored twice, under keys that a uniqueness test on the key cannot flag because they genuinely differ. Every reader must normalise: an RPC node and an index return lowercase, but an explorer API returns checksummed mixed case, and this warehouse already plans to read from all three"),
  tx_index                 INT64     NOT NULL OPTIONS(description="Position of the transaction in its block"),
  log_index                INT64     NOT NULL OPTIONS(description="Position of the log in its BLOCK, as the chain reports it. Ordering by this is what pairs an event with the token transfer that settled it"),

  contract_address         STRING    NOT NULL OPTIONS(description="The address that emitted the log. Lowercase. Joins contract_deployments.proxy_address"),
  implementation_address   STRING             OPTIONS(description="L0-4. Which code was behind the proxy at this block. NULL is permitted only alongside era_resolution = 'unresolved'"),
  era_index                INT64              OPTIONS(description="L0-4. Joins (chain_id, contract_address, era_index) to the reference seeds. NULL only when era_resolution = 'unresolved'"),
  era_resolution           STRING    NOT NULL OPTIONS(description="How the era was established for THIS row. 'slot_read_at_block' read the implementation slot at this row's own block and is the strongest. 'era_map_lookup' placed the block in the known era map. 'unresolved' means neither succeeded and the era is UNKNOWN, which is not the same as era 1"),

  topic0                   STRING             OPTIONS(description="L0-3. The log's FIRST topic, verbatim and positional, exactly as the chain reported it. For all but one event in this system that is the event selector. For an ANONYMOUS event it is the first indexed VALUE, because an anonymous event emits no signature hash and its indexed values start at slot 0. Do not read this column as 'the selector' without checking topic_count, and see the note on that column. NULL only when the log carried no topics at all"),
  topic1                   STRING             OPTIONS(description="The log's second topic, verbatim and positional. NULL when the log carried fewer than two"),
  topic2                   STRING             OPTIONS(description="The log's third topic, verbatim and positional. NULL when the log carried fewer than three"),
  topic3                   STRING             OPTIONS(description="The log's fourth topic, verbatim and positional. NULL when the log carried fewer than four. The EVM allows exactly four, so no log overflows these columns"),
  topic_count              INT64     NOT NULL OPTIONS(description="How many topics the log actually carried, 0 to 4. A capture fact, not a decode. It exists because positional storage alone cannot say whether topic0 is a selector or an anonymous event's first indexed value, and a NULL topic1 cannot be told from a topic1 that was never emitted. With it, a decoder discriminates structurally: an anonymous event's topic_count does not match the topic_count any NAMED event of that contract and era can produce, which is (indexed parameter count + 1). One anonymous event exists in this system, Ethereum DAI LogNote with four indexed parameters, so it presents four topics while every named event on the same contract presents three"),
  log_data                 STRING    NOT NULL OPTIONS(description="L0-1. The data section verbatim, including the 0x prefix. NOT NULL so that an empty data section, which is the literal string 0x, can never be confused with a field that was not captured"),
  removed                  BOOL               OPTIONS(description="TRUE when the source reported this log as removed by a chain reorganisation, FALSE when it reported it as present, and NULL when the source does not report the field at all, which is the case for the index used on two of the four chains. NOT NULL here would force a NULL to be written as FALSE, which asserts 'not removed' while meaning 'unknown'. Rows are never deleted on a reorg; they are marked, so the history of what was believed remains readable"),

  source_kind              STRING    NOT NULL OPTIONS(description="L0-7. 'index', 'rpc' or 'explorer'. What class of reader produced the row, because their failure modes differ: An index reports its own completeness, an RPC node can return an empty answer with no error, and an explorer can truncate a result at a page size and report success"),
  source_id                STRING    NOT NULL OPTIONS(description="L0-7. Short stable code for the exact reader. Reader behaviour is a MOVING property, not a fixed one, so which reader answered has to be on the row"),
  assurance                STRING    NOT NULL OPTIONS(description="L0-7. 'A' two independent sources enumerated this range identically. 'B' one enumerated and a second independent source confirmed it is not incomplete. 'C' one source, no confirmation available. A model aggregating across grades must report the mix or filter to one"),
  confirmations_at_capture INT64              OPTIONS(description="Head height minus block_number at the moment of capture. How settled the block was when it was read. One chain in this set publishes no finality tag at all, so this is the only settlement signal available there"),

  capture_id               STRING    NOT NULL OPTIONS(description="L0-6, L0-8. The range read that produced this row. Joins IngestionCoverage.capture_id, which holds the range, the sources, the errors and the skips"),
  ingestion_run_id         STRING    NOT NULL OPTIONS(description="L0-6. The run the capture belonged to. One run contains many captures across many sources"),
  ingested_at              TIMESTAMP NOT NULL
)
PARTITION BY TIMESTAMP_TRUNC(block_timestamp, MONTH)
CLUSTER BY chain_id, contract_address, topic0, block_number
OPTIONS(
  require_partition_filter = TRUE,
  description="L0 raw log store. One row per log entry, undecoded, every chain and every contract. Merge key (chain_id, tx_hash, log_index). THE WRITE CONTRACT, L0-9, IN FULL. Every statement that writes here carries a LITERAL window on block_timestamp in its ON clause, derived by the writing program from the block range it ingested, truncated to whole months and PADDED ONE MONTH EACH SIDE. A window that does not cover an already present row inserts a duplicate under the same merge key, which reproduces on an unguarded table too and is invisible to any comparison of values; the padding exists because a reorganisation can move a log across a month boundary, measured. The padding covers a displacement back to the start of the month before the source's month, 31 to 62 days; anything larger is a correction and states its own window. A window derived inside the statement does not work: a subquery in the ON clause is refused by BigQuery outright and a predicate correlated to the source row is refused by the partition guard. WHEN MATCHED rewrites block_number, block_hash and block_timestamp along with the payload, because a reorganisation changes which block the log lives in and a row keeping its old block facts is wrong in a way no test can see. An unscoped MERGE scans all of this table, measured 0.3519 USD per run against 0.0280 USD scoped, or 3,083 USD a year against 245 at hourly ingestion, which is why require_partition_filter is on. A read that genuinely wants all of history uses the view RawLogsAllHistory and needs no filter of its own. Partitioned MONTHLY, not daily: clustering applies within a partition and a daily partition of this table measured too small for block pruning to have anything to skip. An empty result is only a measurement where IngestionCoverage shows the range was read.");


-- ONE NOTE ON RE-RUNNING THIS STATEMENT. RawLogs does not exist in the production dataset at the
-- time of writing, measured, so the CREATE above is the only path that has ever run. If a RawLogs
-- built from an earlier revision of this file is ever found, it cannot be brought to this shape by
-- ALTER: BigQuery can only add NULLABLE columns, and topic_count is NOT NULL because a capture
-- that does not know how many topics it saw is not a capture. Such a table has to be recreated
-- deliberately, as its own named migration, after its row count has been checked. That is named
-- here rather than papered over with an ALTER that would silently produce a different schema.


-- -------------------------------------------------------------------------------------------------
-- 2. Transactions
--
-- One row per transaction that produced at least one captured log.
--
-- WHY THIS IS A SEPARATE TABLE. The v3 tables carried the sender, recipient, value, nonce, status,
-- gas used and gas price on every log row. Those are facts about a transaction, not about a log,
-- and the domain shape hid how often they were repeated by splitting one transaction's logs across
-- several tables: A claim transaction emits the claim event, a send event and a token transfer, so
-- its sender was stored once in each of three tables rather than once anywhere.
--
-- WHAT IT DOES NOT COVER, STATED PLAINLY. A transaction that reverted emits no logs, so it can
-- never appear here. Reaching one needs a reader that walks blocks rather than filtering logs.
-- Until that exists, absence from this table means "produced no captured log", never "did not
-- happen".
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `gooddollar.BlockchainEvents.Transactions`
(
  chain_id                 INT64     NOT NULL,
  block_number             INT64     NOT NULL,
  block_timestamp          TIMESTAMP NOT NULL,
  block_hash               STRING    NOT NULL,
  tx_hash                  STRING    NOT NULL,
  tx_index                 INT64     NOT NULL,

  from_address             STRING    NOT NULL,
  to_address               STRING             OPTIONS(description="NULL when the transaction created a contract rather than calling one"),
  contract_created         STRING             OPTIONS(description="The address created, where the transaction created one"),
  value_raw                STRING    NOT NULL OPTIONS(description="uint256 as STRING. L0-2. Native currency, not the token"),
  input_selector           STRING             OPTIONS(description="First four bytes of the calldata, which names the function called. The full calldata is deliberately NOT stored: It is unbounded in size and re-fetchable per transaction from any archive node"),
  nonce                    INT64,
  status                   INT64              OPTIONS(description="1 succeeded, 0 reverted. A row here always has at least one log, so 0 would mean the receipt and the logs disagree, which is a finding rather than a value"),
  gas_used                 INT64,
  gas_limit                INT64,
  effective_gas_price      STRING             OPTIONS(description="uint256 as STRING. L0-2"),
  tx_type                  INT64              OPTIONS(description="EIP-2718 transaction type. Batched claims arrive as account abstraction bundles, so the type is how a bundle is told from a direct call"),

  source_kind              STRING    NOT NULL OPTIONS(description="L0-7"),
  source_id                STRING    NOT NULL OPTIONS(description="L0-7"),
  assurance                STRING    NOT NULL OPTIONS(description="L0-7. Independent of the log's grade: One chain prunes its transaction index on every endpoint tried, so a transaction there can be less assured than the log that pointed at it"),
  capture_id               STRING    NOT NULL,
  ingestion_run_id         STRING    NOT NULL,
  ingested_at              TIMESTAMP NOT NULL
)
PARTITION BY TIMESTAMP_TRUNC(block_timestamp, MONTH)
CLUSTER BY chain_id, tx_hash, from_address, block_number
OPTIONS(
  require_partition_filter = TRUE,
  description="L0 transaction store. One row per transaction that produced at least one captured log. Merge key (chain_id, tx_hash). The same write contract as RawLogs applies here in full, L0-9: a literal window on block_timestamp derived by the writing program from the ingested block range, truncated to whole months and padded one month each side, and WHEN MATCHED rewrites block_number, block_hash and block_timestamp along with the rest. Same partition filter requirement and the same reason. All history reads use the view TransactionsAllHistory. Partitioned monthly to match RawLogs, so a join between them prunes the same way on both sides. Reverted transactions emit no logs and are therefore absent by construction, not by choice.");


-- -------------------------------------------------------------------------------------------------
-- 3. ContractStateSnapshots  CREATE IF ABSENT, then ALTER. Nothing here drops anything.
--
-- THE TABLE THAT NO EVENT STREAM CAN REPLACE, NOW EXTENDED TO FOUR CHAINS.
--
-- A reserve ratio moves on every sell with no event. A whitelist expiry moves on a chain-wide
-- parameter change with no event on the affected wallet. A streaming token balance moves every
-- second with no transaction at all. None of those are recoverable from any event stream, at any
-- level of ingestion diligence, because the chain never emitted them.
--
-- NARROW BY DESIGN, one row per reading, not one wide row per block. If one getter succeeds and
-- another reverts, a wide row cannot say so honestly and fills with nulls that read as measured
-- zeros. That is not hypothetical: One pool getter reverts at every block before a known boundary
-- that sits inside the intended backfill range.
--
-- A FAILED READ IS A ROW, NEVER A GAP AND NEVER A FORWARD FILL.
--
-- WHAT CHANGED FROM v3. network becomes chain_id, so this table keys the same way as every other.
-- confirmed_second_endpoint, which was a two state answer to a three state question, becomes the
-- assurance grade plus a count of how many endpoints actually agreed. That distinction is load
-- bearing on one chain in this set, where exactly one endpoint in existence serves historical
-- state, so every historical reading there is grade C and always will be until that changes.
--
-- WHY THIS IS NOT A DROP AND RECREATE, WHICH IS WHAT IT USED TO BE. An earlier revision of this
-- file opened this section with an unconditional DROP TABLE followed by a CREATE, on the reasoning
-- that the table was empty. On 2026-09-24 a verification probe submitted most of this file to
-- BigQuery as a script by accident and that statement executed against production, dropping the
-- live table. Nothing was lost only because it genuinely held zero rows. A file that is safe to
-- run only while a table happens to be empty is not safe to run. The shape change is now a CREATE
-- that skips an existing table plus explicit ADD COLUMN IF NOT EXISTS statements, which reaches
-- the same schema from either starting point and destroys nothing from any starting point.
-- If a genuinely destructive change is ever needed here it goes in its own separately named
-- migration file that nobody can run by accident.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `gooddollar.BlockchainEvents.ContractStateSnapshots`
(
  chain_id                 INT64     NOT NULL,
  block_number             INT64     NOT NULL OPTIONS(description="A NUMBER, never a tag. A reading taken at 'latest' names a different block every time and cannot be reproduced by anyone, including its author"),
  block_hash               STRING             OPTIONS(description="NULL only when the read failed before a block was resolved"),
  block_timestamp          TIMESTAMP NOT NULL,

  contract_address         STRING    NOT NULL,
  contract_name            STRING    NOT NULL OPTIONS(description="Logical name, stable across eras. A label for reading, never a key"),
  implementation_address   STRING             OPTIONS(description="L0-4. Which code answered this read"),
  era_index                INT64              OPTIONS(description="L0-4. An identical getter can mean different things across an era boundary: One in this system kept its name, signature and return type and changed from reading a stored variable to reading the last element of an options array"),

  reading_key              STRING    NOT NULL OPTIONS(description="The getter, for example reserveRatio, totalSupply, getNetFlow, lastAuthenticated"),
  subject                  STRING             OPTIONS(description="The argument, where the read takes one: An address, or a bytes32 identifier. NULL for a nullary read"),
  value_raw                STRING             OPTIONS(description="uint256 or int256 as STRING. L0-2. SIGNED values keep their sign: One balance getter returns int256 and the negative IS the finding"),
  value_bool               BOOL               OPTIONS(description="For boolean reads such as paused() and isWhitelisted()"),
  value_address            STRING             OPTIONS(description="For address reads such as getWhitelistedRoot()"),
  unit                     STRING    NOT NULL OPTIONS(description="WEI_18, WEI_2, RATIO_1E8, RATIO_1E4, UNIX_SECONDS, COUNT, BOOL, ADDRESS, WEI_PER_SECOND. Names the scale so nobody divides by the wrong thing. Two similarly named ratios in this system have different denominators, one over 10,000 and one over 100,000,000"),
  denominator              STRING             OPTIONS(description="The literal denominator where one applies. Publishing a raw ratio as a percentage is a defect this system has already shipped once"),

  function_selector        STRING             OPTIONS(description="The four byte selector actually sent, computed from the signature rather than recalled. reading_key is a LABEL for humans; this is the fact. Two getters in this system share a name across an era boundary and return different things"),
  call_data                STRING             OPTIONS(description="The complete calldata sent, verbatim hex including the 0x prefix. Small and bounded for a getter, unlike a transaction's calldata, which is why it is stored here and not on Transactions"),
  return_data              STRING             OPTIONS(description="The raw return bytes, verbatim hex including the 0x prefix, before any decoding. THIS IS THE ANALOGUE OF RawLogs.log_data AND IT EXISTS FOR THE SAME REASON. Without it a wrong word offset, a wrong tuple member or a wrong sign cannot be corrected by changing a view and needs a fresh read from the chain, which on one chain in this set costs about 55 days at the free quota. That defect class has already occurred here: a documented verification instruction read the wrong member of a getter's return, so anyone following it would have confirmed a wrong number and felt rigorous doing it. NULL is permitted only when read_status is not 'ok'"),

  read_status              STRING    NOT NULL OPTIONS(description="'ok', 'revert', 'rpc_error' or 'unreadable'. NEVER null. A revert is a fact about the chain; an rpc_error is a fact about us; and a null returned with HTTP 200 is neither and must not be recorded as a value"),
  read_error               STRING             OPTIONS(description="Verbatim revert reason or transport error"),
  endpoints_queried        INT64     NOT NULL OPTIONS(description="How many endpoints were asked"),
  endpoints_agreeing       INT64     NOT NULL OPTIONS(description="How many returned the identical value. Fewer than two means the reading is not a measurement, whatever its grade"),
  endpoints                STRING             OPTIONS(description="Which endpoints answered, comma separated, so a later reader can see the run's conditions"),
  assurance                STRING    NOT NULL OPTIONS(description="L0-7. Grade C is permanent and unavoidable for historical state on one chain in this set, where exactly one endpoint in existence serves it"),

  cadence                  STRING    NOT NULL OPTIONS(description="'daily_close', 'event_block', 'event_block_minus_one', 'era_boundary' or 'backfill'. Why this block was chosen"),
  is_frozen                BOOL               OPTIONS(description="TRUE when the value at this block can never change, for example a completed protocol day. FALSE when it moves with the chain, in which case the reading is the value AT THIS BLOCK ONLY and may never be written in the present tense"),

  capture_id               STRING    NOT NULL,
  ingestion_run_id         STRING    NOT NULL OPTIONS(description="L0-6"),
  ingested_at              TIMESTAMP NOT NULL
)
PARTITION BY TIMESTAMP_TRUNC(block_timestamp, MONTH)
CLUSTER BY chain_id, contract_address, reading_key, block_number
OPTIONS(description="L0 contract state store. One row per reading of one getter at one pinned block. Holds every quantity the chain changes without emitting an event. A failed read is a row, never a gap. Keeps the raw exchange as well as the decoded value: function_selector, call_data and return_data are to this table what log_data is to RawLogs, so a wrong decode is a view change rather than a fresh read from the chain. Deliberately NOT guarded by require_partition_filter, unlike RawLogs and Transactions. The guard exists to make one specific expensive mistake impossible, this table is small enough that no such mistake is available on it, and reconciliation against contract state legitimately reads all of its history.");

-- The three payload columns, added separately so that a dataset where this table already exists
-- reaches the same schema as one where it does not. The CREATE above skips an existing table, so
-- without these statements an existing table would silently stay on the old shape. Running both is
-- idempotent and neither destroys anything.
ALTER TABLE `gooddollar.BlockchainEvents.ContractStateSnapshots`
  ADD COLUMN IF NOT EXISTS function_selector STRING OPTIONS(description="The four byte selector actually sent, computed from the signature rather than recalled"),
  ADD COLUMN IF NOT EXISTS call_data         STRING OPTIONS(description="The complete calldata sent, verbatim hex including the 0x prefix"),
  ADD COLUMN IF NOT EXISTS return_data       STRING OPTIONS(description="The raw return bytes, verbatim hex including the 0x prefix, before any decoding. The analogue of RawLogs.log_data. Without it a wrong decode needs a fresh read from the chain rather than a view change");


-- -------------------------------------------------------------------------------------------------
-- 4. IngestionCoverage  ALTER, production data present (measured 10 rows)
--
-- L0-8. What was read, by whom, over what range, and what failed. This is the table that lets an
-- empty result be interpreted at all.
--
-- The existing columns already carry the range, the chunk accounting and the skipped ranges, and
-- they are kept as they are. What is added is the identity of the capture and the assurance it was
-- read under, so that every row in RawLogs can name the read that produced it.
--
-- A capture is one source reading one contract over one block range. A run contains many.
-- -------------------------------------------------------------------------------------------------
ALTER TABLE `gooddollar.BlockchainEvents.IngestionCoverage`
  ADD COLUMN IF NOT EXISTS capture_id             STRING OPTIONS(description="Stable identifier for this capture. Every row it wrote carries it"),
  ADD COLUMN IF NOT EXISTS chain_id               INT64  OPTIONS(description="EVM chain id, replacing the network name as the key"),
  ADD COLUMN IF NOT EXISTS contract_address       STRING OPTIONS(description="The contract this capture read. NULL where the capture batched every address in one query, which is the shape one index requires to stay within its rate limit"),
  ADD COLUMN IF NOT EXISTS target_table           STRING OPTIONS(description="'RawLogs', 'Transactions' or 'ContractStateSnapshots'"),
  ADD COLUMN IF NOT EXISTS source_kind            STRING OPTIONS(description="L0-7. 'index', 'rpc' or 'explorer'"),
  ADD COLUMN IF NOT EXISTS source_id              STRING OPTIONS(description="L0-7. Which reader enumerated the range"),
  ADD COLUMN IF NOT EXISTS confirming_source_kind STRING OPTIONS(description="L0-7. The independent second reader, or NULL where none exists for this chain and range"),
  ADD COLUMN IF NOT EXISTS confirming_source_id   STRING,
  ADD COLUMN IF NOT EXISTS confirmation_result    STRING OPTIONS(description="'identical', 'refuted_emptiness', 'disagreed' or 'unavailable'. A disagreement is a RESULT and must be recorded, never resolved by taking a majority quietly"),
  ADD COLUMN IF NOT EXISTS assurance              STRING OPTIONS(description="L0-7. The grade every row this capture wrote carries"),
  ADD COLUMN IF NOT EXISTS head_at_capture        INT64  OPTIONS(description="Chain head when the capture ran, so confirmations_at_capture on each row is reproducible"),
  ADD COLUMN IF NOT EXISTS miss_rate_calibrated   FLOAT64 OPTIONS(description="The measured probability that ONE pass of this source drops a result it should return, calibrated in the same session against a range of the same shape. Without it, no number of repeated passes bounds anything"),
  ADD COLUMN IF NOT EXISTS passes_run             INT64  OPTIONS(description="How many independent passes the union of this capture is built from. Choose it from the calibrated miss rate so that rate raised to this power is under one percent, and report both"),
  ADD COLUMN IF NOT EXISTS gain_series            STRING OPTIONS(description="New rows added per pass, in order. A false plateau is visible in 12, 14, 18, 24, 26 and invisible in the word converged");


-- -------------------------------------------------------------------------------------------------
-- 5. PipelineRuns  ALTER, production data present (measured 22 rows)
--
-- One row per run. Kept as it is and extended with what a four chain pipeline needs to report.
-- -------------------------------------------------------------------------------------------------
ALTER TABLE `gooddollar.BlockchainEvents.PipelineRuns`
  ADD COLUMN IF NOT EXISTS chains_processed   STRING OPTIONS(description="Comma separated chain ids this run touched"),
  ADD COLUMN IF NOT EXISTS captures_planned   INT64,
  ADD COLUMN IF NOT EXISTS captures_ok        INT64,
  ADD COLUMN IF NOT EXISTS captures_failed    INT64  OPTIONS(description="A run that finished with failed captures did NOT succeed, whatever its exit code. A count that appears only in console output does not exist"),
  ADD COLUMN IF NOT EXISTS pipeline_version   STRING OPTIONS(description="So a defect can be attributed to the code that wrote the rows rather than to the code reading them");


-- -------------------------------------------------------------------------------------------------
-- 6. Superseded tables, marked rather than removed
--
-- Two of these hold production data and are NEVER dropped. The rest are empty, and are marked here
-- so the dataset states plainly which contract is in force. The drops live in a separate script,
-- and as of the 2026-09-24 revision there is no DROP anywhere in this file at all, so running it
-- destroys nothing from any starting point.
--
-- ClaimContractEvents holds 2,649,450 rows and InviteContractEvents holds 7,093, measured today.
-- Their migration path is section 7.
--
-- EVERY DESCRIPTION BELOW WAS REWRITTEN ON 2026-09-24 AND SAYS SO. Earlier that same day a verification
-- probe submitted most of this file to BigQuery by accident and overwrote the table level
-- description of twelve tables with text announcing a contract that is not in force. The original
-- text is not recoverable: 04_L0Contract_v3.sql sets column descriptions only and no table level
-- description anywhere, 05_RestoreColumnDescriptions.sql covers column descriptions on two tables,
-- and no probe output captured from before the incident recorded a description. So these are new
-- text describing the state the dataset is actually in, not a restoration, and each one says so
-- rather than letting a later reader mistake it for the original.
-- -------------------------------------------------------------------------------------------------
ALTER TABLE `gooddollar.BlockchainEvents.ClaimContractEvents`
  SET OPTIONS(description="v3 claim event table. LIVE DATA, 2,649,450 rows measured 2026-09-24, and never dropped by any script in this repository. Superseded in DESIGN by RawLogs under the L0 v4 contract, which is defined in warehouse/L1/06_L0Contract_v4.sql. Nothing has replaced it in DATA yet: RawLogs does not exist in this dataset. Read the migration note in section 7 of that file before using this table for anything. Only 35,862 of its rows carry the raw log, so the remaining 98.65 percent cannot be moved into RawLogs faithfully and have to be re-read from the chain. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");

ALTER TABLE `gooddollar.BlockchainEvents.InviteContractEvents`
  SET OPTIONS(description="v3 invite event table. LIVE DATA, 7,093 rows measured 2026-09-24, and never dropped by any script in this repository. Superseded in DESIGN by RawLogs under the L0 v4 contract; nothing has replaced it in DATA yet, because RawLogs does not exist in this dataset. No row in it carries the raw log, so all of them have to be re-read from the chain. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");

ALTER TABLE `gooddollar.BlockchainEvents.IdentityContractEvents` SET OPTIONS(description="v3 event table, EMPTY and no longer written. Superseded in design by RawLogs under the L0 v4 contract; RawLogs does not exist in this dataset yet, so nothing has replaced it in data. Dropped by 07_RetireV3EventTables.sql only after the backfill reconciles. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");
ALTER TABLE `gooddollar.BlockchainEvents.TokenTransferEvents`    SET OPTIONS(description="v3 event table, EMPTY and no longer written. Superseded in design by RawLogs under the L0 v4 contract; RawLogs does not exist in this dataset yet, so nothing has replaced it in data. Dropped by 07_RetireV3EventTables.sql only after the backfill reconciles. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");
ALTER TABLE `gooddollar.BlockchainEvents.TokenSupplyEvents`      SET OPTIONS(description="v3 event table, EMPTY and no longer written. Superseded in design by RawLogs under the L0 v4 contract; RawLogs does not exist in this dataset yet, so nothing has replaced it in data. Dropped by 07_RetireV3EventTables.sql only after the backfill reconciles. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");
ALTER TABLE `gooddollar.BlockchainEvents.TokenAdminEvents`       SET OPTIONS(description="v3 event table, EMPTY and no longer written. Superseded in design by RawLogs under the L0 v4 contract; RawLogs does not exist in this dataset yet, so nothing has replaced it in data. Dropped by 07_RetireV3EventTables.sql only after the backfill reconciles. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");
ALTER TABLE `gooddollar.BlockchainEvents.StreamEvents`           SET OPTIONS(description="v3 event table, EMPTY and no longer written. Superseded in design by RawLogs under the L0 v4 contract; RawLogs does not exist in this dataset yet, so nothing has replaced it in data. Dropped by 07_RetireV3EventTables.sql only after the backfill reconciles. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");
ALTER TABLE `gooddollar.BlockchainEvents.TokenAgreementEvents`   SET OPTIONS(description="v3 event table, EMPTY and no longer written. Superseded in design by RawLogs under the L0 v4 contract; RawLogs does not exist in this dataset yet, so nothing has replaced it in data. Dropped by 07_RetireV3EventTables.sql only after the backfill reconciles. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");
ALTER TABLE `gooddollar.BlockchainEvents.ReserveContractEvents`  SET OPTIONS(description="v3 event table, EMPTY and no longer written. Superseded in design by RawLogs under the L0 v4 contract; RawLogs does not exist in this dataset yet, so nothing has replaced it in data. Dropped by 07_RetireV3EventTables.sql only after the backfill reconciles. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");
ALTER TABLE `gooddollar.BlockchainEvents.DexPoolEvents`          SET OPTIONS(description="v3 event table, EMPTY and no longer written. Superseded in design by RawLogs under the L0 v4 contract; RawLogs does not exist in this dataset yet, so nothing has replaced it in data. Dropped by 07_RetireV3EventTables.sql only after the backfill reconciles. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");
ALTER TABLE `gooddollar.BlockchainEvents.UnknownEvents`          SET OPTIONS(description="v3 catch all table, EMPTY. It existed to hold a log whose selector matched no expected event. Under a universal raw log table there is no such thing, because every log is stored whether or not anything knows how to decode it, so this table becomes impossible to populate rather than merely superseded. Dropped by 07_RetireV3EventTables.sql. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");
ALTER TABLE `gooddollar.BlockchainEvents.IngestionStatus`        SET OPTIONS(description="v3 ingestion bookkeeping table. LIVE DATA, 20 rows, and never dropped. Superseded in design by IngestionCoverage, which records a capture rather than a day and names the source that read it. Note for anyone reading the pipeline: this table is written and never read, so it does not answer where an interrupted run should resume. Description rewritten 2026-09-24; the original was overwritten in error earlier the same day and is not recoverable.");


-- -------------------------------------------------------------------------------------------------
-- 7. Migration of the two tables holding production data
--
-- THE HEADLINE, AND IT IS THE ORDERING PRINCIPLE BITING RATHER THAN A SHORTCOMING OF THIS DESIGN.
--
-- ClaimContractEvents holds 2,649,450 rows. Exactly 35,862 of them, which is 1.35 percent, carry a
-- topic0 and a log data blob. InviteContractEvents holds 7,093 rows and NONE of them do. Both
-- measured today against the live tables.
--
-- The v3 contract required the raw log to be stored. The columns were added by an ALTER and were
-- never backfilled. So for 98.65 percent of the claim rows and 100 percent of the invite rows, the
-- raw log is not in the warehouse and cannot be reconstructed from what is: The decoded columns
-- are a lossy rendering, the topic layout of the era is not recorded on the row, and no
-- transformation can invent a data blob that was never captured.
--
-- Those rows therefore have to be READ AGAIN FROM THE CHAIN. That is not a migration, it is a
-- backfill, and it is the whole argument for building L0 completely before anything is modelled on
-- top of it.
--
-- THE PATH, IN ORDER:
--
--   Step 1. Run this file. Nothing is destroyed. RawLogs, Transactions and the rebuilt state table
--           are created empty, the two production tables are annotated and otherwise untouched.
--
--   Step 2. Migrate the 35,862 rows that DO satisfy the raw log rule, using section 8. They are
--           worth moving not for their volume but for their use: They are an independent baseline
--           that a re-read of the same ranges must reproduce exactly, log for log.
--
--   Step 3. Backfill both contracts from the chain into RawLogs, over the full range, under the
--           v4 rules. The merge key (chain_id, tx_hash, log_index) makes step 3 idempotent with
--           respect to step 2: A log already present from the migration is updated, never
--           duplicated.
--
--   Step 4. Reconcile. The claim schemes on both chains publish their own per day totals in
--           public state, so the backfill can be checked against the contract itself rather than
--           against the pipeline that produced it. That check has already found four real claim
--           events the previous pipeline silently dropped, on three separate days.
--
--   Step 5. Only after step 4 reconciles are the old tables retired, using the separate
--           retirement script. Nothing in this file does it.
-- -------------------------------------------------------------------------------------------------


-- -------------------------------------------------------------------------------------------------
-- 8. Migrating the rows that satisfy the raw log rule
--
-- Idempotent by construction: MERGE on (chain_id, tx_hash, log_index), which is a log's permanent
-- identity. Running it twice changes nothing the second time.
--
-- Everything these rows can honestly say about their own provenance is said. They were written by
-- a pipeline that did not record which reader produced them, so source_id is 'unknown_legacy' and
-- the assurance grade is C: One unnamed source, no confirmation. Recording them as anything better
-- would be inventing evidence. Their capture_id points at a coverage row that says exactly this.
--
-- era_resolution is 'unresolved' and implementation_address is NULL because the legacy table's
-- implementation_address column was added and never populated: It is NULL on all 2,649,450 rows.
-- A row that does not know its era says so.
--
-- AND IT CARRIES A LITERAL PREDICATE ON THE TARGET, which is L0-9 and this is its worked example.
-- Without the two lines at the end of the ON clause this statement scans every partition of the
-- table it is writing into. The window is literal rather than derived because a required partition
-- filter has to be something the engine can read before it runs the query: a subquery in the ON
-- clause is refused by BigQuery outright, and a predicate correlated to the source row eliminates
-- no partitions and is refused by the guard. Both measured.
--
-- WHAT THE WINDOW COVERS, STATED RATHER THAN CLAIMED. The legacy table's own span is blocks
-- 95,864,458 to 105,265,598, which is 2025-11-10 to 2026-07-23 measured. The window below is
-- 2025-01-01 to 2027-01-01, so it covers that span with more than ten months of margin at each
-- end, against a padding rule that asks for one, and still reads about 24 monthly partitions out
-- of a table that is empty when this runs.
--
-- THERE IS NO WHEN MATCHED BRANCH, AND THAT IS DELIBERATE RATHER THAN AN OVERSIGHT OF L0-9 RULE 4.
-- A migration from a table cannot observe a reorganisation, so it has nothing truer to write over
-- an existing row with. Re-running it is still idempotent: a log already present is skipped, never
-- duplicated. The rule binds on the pipeline's MERGE, which reads the chain and therefore can.
-- -------------------------------------------------------------------------------------------------
MERGE `gooddollar.BlockchainEvents.RawLogs` T
USING (
  SELECT
    chain_id,
    block_number,
    block_timestamp,
    LOWER(block_hash)                   AS block_hash,
    LOWER(tx_hash)                      AS tx_hash,
    tx_index,
    log_index,
    LOWER(contract_address)             AS contract_address,
    CAST(NULL AS STRING)                AS implementation_address,
    CAST(NULL AS INT64)                 AS era_index,
    'unresolved'                        AS era_resolution,
    LOWER(topic0)                       AS topic0,
    LOWER(topic1)                       AS topic1,
    LOWER(topic2)                       AS topic2,
    LOWER(topic3)                       AS topic3,
    -- Legacy rows stored topics positionally and none of them came from an anonymous event, so
    -- the count is simply how many slots are filled. Topics are a dense array on chain, so a
    -- filled slot above an empty one cannot occur.
    CASE WHEN topic3 IS NOT NULL THEN 4
         WHEN topic2 IS NOT NULL THEN 3
         WHEN topic1 IS NOT NULL THEN 2
         WHEN topic0 IS NOT NULL THEN 1
         ELSE 0 END                     AS topic_count,
    COALESCE(log_data, '0x')            AS log_data,
    CAST(NULL AS BOOL)                  AS removed,
    'unknown'                           AS source_kind,
    'unknown_legacy'                    AS source_id,
    'C'                                 AS assurance,
    CAST(NULL AS INT64)                 AS confirmations_at_capture,
    'legacy_v3_claim_rows_with_raw_log' AS capture_id,
    COALESCE(ingestion_run_id, 'unknown_legacy') AS ingestion_run_id,
    CURRENT_TIMESTAMP()                 AS ingested_at
  FROM `gooddollar.BlockchainEvents.ClaimContractEvents`
  WHERE topic0 IS NOT NULL
    AND log_data IS NOT NULL
) S
ON  T.chain_id  = S.chain_id
AND T.tx_hash   = S.tx_hash
AND T.log_index = S.log_index
AND T.block_timestamp >= TIMESTAMP('2025-01-01')
AND T.block_timestamp <  TIMESTAMP('2027-01-01')
WHEN NOT MATCHED THEN INSERT ROW;


-- -------------------------------------------------------------------------------------------------
-- 9. The coverage row for that migration, so the migrated rows are interpretable
--
-- L0-8. A capture_id on a row is worthless unless the capture exists. This is the one that says
-- what those 35,862 rows are and how far they may be trusted.
-- -------------------------------------------------------------------------------------------------
MERGE `gooddollar.BlockchainEvents.IngestionCoverage` T
USING (
  SELECT
    'legacy_v3_claim_rows_with_raw_log' AS capture_id,
    'legacy_v3_migration'               AS run_id,
    MIN(chain_id)                       AS chain_id,
    ANY_VALUE(LOWER(contract_address))  AS contract_address,
    'RawLogs'                           AS target_table,
    MIN(block_number)                   AS from_block,
    MAX(block_number) + 1               AS to_block,
    COUNT(*)                            AS rows_merged,
    COUNT(*)                            AS logs_seen,
    'migrated'                          AS status,
    'unknown'                           AS source_kind,
    'unknown_legacy'                    AS source_id,
    'unavailable'                       AS confirmation_result,
    'C'                                 AS assurance,
    CURRENT_TIMESTAMP()                 AS started_at,
    CURRENT_TIMESTAMP()                 AS completed_at,
    'Carried over from the v3 claim table. These are the only legacy rows that satisfy the raw log rule. The range they cover is NOT fully covered: They are a sparse 1.35 percent of the rows the legacy table holds for it, so this row bounds nothing and exists to make the migrated rows interpretable rather than to claim coverage.' AS error_message
  FROM `gooddollar.BlockchainEvents.ClaimContractEvents`
  WHERE topic0 IS NOT NULL AND log_data IS NOT NULL
) S
ON T.capture_id = S.capture_id
-- An explicit column list, not INSERT ROW. IngestionCoverage has thirty columns after the ALTER in
-- section 4 and this source supplies eighteen of them, so INSERT ROW would fail on the arity. The
-- twelve it leaves NULL are the chunk accounting and the calibration figures, none of which a
-- migration from a table has: They describe reading a chain.
WHEN NOT MATCHED THEN INSERT (
  capture_id, run_id, chain_id, contract_address, target_table, from_block, to_block,
  rows_merged, logs_seen, status, source_kind, source_id, confirmation_result, assurance,
  started_at, completed_at, error_message
) VALUES (
  S.capture_id, S.run_id, S.chain_id, S.contract_address, S.target_table, S.from_block, S.to_block,
  S.rows_merged, S.logs_seen, S.status, S.source_kind, S.source_id, S.confirmation_result, S.assurance,
  S.started_at, S.completed_at, S.error_message
);


-- -------------------------------------------------------------------------------------------------
-- 10. The all history views
--
-- THE DOCUMENTED ROUTE FOR A READ THAT GENUINELY WANTS EVERYTHING, and the answer to a second
-- problem that is easy to miss.
--
-- require_partition_filter refuses any query with no usable filter on block_timestamp. That is the
-- point of it, and it is what makes the expensive mistake in L0-9 impossible. It also refuses a
-- number of things that are perfectly reasonable: a bare COUNT(*), a GROUP BY that looks for a
-- duplicated merge key across the whole table, a reconciliation against contract state that
-- legitimately spans all of history, and dbt's own canonical incremental pattern, which filters on
-- a subquery over the model itself and therefore eliminates no partitions.
--
-- A VIEW THAT CARRIES THE WIDE FILTER IN ITS OWN DEFINITION SATISFIES THE GUARD, AND CONSUMERS OF
-- THE VIEW THEN NEED NO FILTER AT ALL. Measured on a guarded table of this shape: a bare COUNT(*)
-- through the view is accepted, a GROUP BY with no filter is accepted and correctly finds a seeded
-- duplicate, and the dbt incremental subquery shape is accepted. So these two views are not a
-- convenience. They are the reason the guard costs almost nothing.
--
-- WHAT THEY COST, STATED. An explicit all history filter reads about 6 percent more than no filter
-- would, because the partition column has to be read to satisfy it. That is the whole price.
--
-- WHAT THEY ARE NOT. They are not the route for a model that has a natural window. A staging model
-- that rebuilds one month should filter one month against the TABLE. Reading everything through a
-- view and then filtering in the model gives the engine nothing to prune and is the exact mistake
-- the guard exists to catch, wearing a different hat.
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW `gooddollar.BlockchainEvents.RawLogsAllHistory`
OPTIONS(description="Every row of RawLogs, with the all history partition filter carried in the view definition so a consumer needs none of its own. Use for a bare count, a merge key uniqueness check, or a reconciliation that genuinely spans the whole chain history. Do NOT use it for a model that has a natural window: filter that window against the table, where the engine can prune.")
AS SELECT * FROM `gooddollar.BlockchainEvents.RawLogs`
   WHERE block_timestamp >= TIMESTAMP('2000-01-01') AND block_timestamp < TIMESTAMP('2100-01-01');

CREATE OR REPLACE VIEW `gooddollar.BlockchainEvents.TransactionsAllHistory`
OPTIONS(description="Every row of Transactions, with the all history partition filter carried in the view definition so a consumer needs none of its own. Same purpose and the same caveat as RawLogsAllHistory. A join between the two views prunes nothing on either side and is only appropriate for a whole history reconciliation.")
AS SELECT * FROM `gooddollar.BlockchainEvents.Transactions`
   WHERE block_timestamp >= TIMESTAMP('2000-01-01') AND block_timestamp < TIMESTAMP('2100-01-01');



-- -------------------------------------------------------------------------------------------------
-- 10. Coverage of the event surface, for the record
--
-- Every one of the 301 distinct event selectors measured across the 354 contract eras on the four
-- chains lands in RawLogs, by construction, because RawLogs does not distinguish between them. The
-- one anonymous event in the set lands there too, with a NULL topic0, which the v3 tables could
-- not have stored at all: Every one of them declared topic0 as NOT NULL.
--
-- The selector to meaning mapping lives in the event_surface seed, keyed on
-- (chain, proxy_address, era_index, topic0), and is versioned in git alongside the models that
-- read it. Adding a contract or an event is a seed change and a pipeline configuration change. It
-- is not a schema change, and that is the property this whole file exists to buy.
-- =================================================================================================
