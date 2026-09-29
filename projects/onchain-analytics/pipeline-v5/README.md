# The GoodDollar ingestion pipeline

This is the **only** pipeline in this repository. It reads contract logs from Envio HyperSync,
or over JSON-RPC on the chains no index serves, and writes them into BigQuery **undecoded**, then
checks its own work against the contracts.

Two older versions existed, `pipeline/` and `future/pipeline-v4/`, and both are gone. What they
could do that this one could not has been ported, and what they did that was wrong is the reason
several of the rules below exist.

---

## Nothing is decoded here, and that is the point

The warehouse holds one row per log entry, with all four topic slots and the data blob stored
verbatim, for every contract on Celo, XDC, Fuse and Ethereum. It does not hold a column per event
field, and it does not try to match a log against an expected event at ingestion time.

That is a deliberate trade with a stated cost. A row carries no meaning until a model joins it to
the event surface reference table. In exchange, a decoding error becomes a change to a view
instead of a fresh read from the chain, a new event on an existing contract needs no schema
change, and a log can never go uncaptured because nobody had defined a column for it yet. A wrong
interface has forced a full re-ingest of this warehouse twice.

The contract list is not in this program. It comes from the `contract_deployments` reference seed,
which also supplies each contract's creation block and the block ranges of its implementation
eras. **Adding a contract is a seed change.**

---

## What makes this one different

The predecessor ingested 2.69 million rows and was wrong in two independent ways, neither of
which any test caught.

**It duplicated.** It appended through BigQuery streaming inserts, whose `insertId`
de-duplication window is minutes. Re-running a block range four months later wrote every event
in it a second time: 43,000 phantom claim rows and 2,167 phantom invite rows, an entire week
stored at exactly double, showing a fake spike followed by a fake crash in the middle of a
growth curve.

**It dropped rows, on days when it was not duplicating anything.** Four real claims are missing
from three days. The mechanism. It flushed a fixed 1,000-row batch with no regard for block
boundaries, so a run that ended mid-stream left its last block written only in part. The next
run resumed at `MAX(block_number) + 1` and never looked at that block again. Block 102,959,090
holds log indices 1, 4, 7, 10, 13, 16, 19 and 22 in the warehouse; the chain also has 25 and 28.

The same shape appears at 103,541,459 and at 105,182,364, and each of those three blocks is the
exact last block of an ingest batch.

Six properties follow from that, and every one of them is load bearing.

| Property | Why |
| - | - |
| The write path is a staging table plus a `MERGE` on the target's own key, `(chain_id, tx_hash, log_index)` for logs and `(chain_id, tx_hash)` for transactions | Re-running a range is free, which is the precondition for everything else here |
| Every `MERGE` carries a **literal window** on `block_timestamp`, derived from the rows being written, truncated to whole months and padded one month each side | An unscoped `MERGE` scans the whole target. A window that does not cover an already present row inserts a duplicate under the same merge key, which no uniqueness test can see. Both measured |
| Resume comes from the **coverage ledger**, never from `MAX(block_number)` | A watermark meaning "the furthest row I happen to hold" cannot represent a hole, and this pipeline has already created one |
| Buffers flush on a **block boundary** | A write never splits a block in the first place |
| A chunk that returns nothing is a **negative to confirm**, not a result | An identical repeated log query on these endpoints returned zero seven times in ten one day and three times in ten the day before, with no errors raised |
| A short collection is a **failure**, not an empty one | HyperSync announces truncation through `nextBlock`. A caller that ignores it reads truncation as absence |

Two more rules the write path enforces, both silent when broken. **Every hex identifier is
lowercased at the point a reader's output enters the pipeline**, because two spellings of one
transaction hash are two different merge keys, so the same log lands twice under keys a
uniqueness test on the key cannot flag. And **a matched row is rewritten whole**, including its
block number, block hash, block timestamp and the run that wrote it, because a reorganisation
changes which block a log lives in and a row keeping its old block facts is self consistent, sits
in the wrong partition, and passes every test.

And one thing that is new rather than fixed: **the contracts keep their own ledgers, and now we
ask them.** `getClaimerCount(day)` and `getClaimAmount(day)` on the UBIScheme, and `stats()` on
the Invites contract, are public getters over live mappings. `verify` reconciles the warehouse
against them per protocol day, to the raw unit. Every correctness argument this warehouse had
before that compared the warehouse against itself. Two contracts out of 146 publish a ledger of
this kind, so `verify` is the only external check available and it covers a small part of the
surface; `coverage` answers the same question for the rest.

---

## Setup, once per machine

```
cd projects/onchain-analytics/pipeline-v5
npm install
cp .env.example .env          # then fill in ENVIO_API_TOKEN
gcloud auth application-default login
```

The BigQuery tables are created by the DDL in `../warehouse/L1/`, not by the pipeline. Apply
`06_L0Contract_v4.sql` before ingesting anything. The pipeline refuses to write a column the
live table does not have, and checks at startup that the bookkeeping tables carry the columns it
is about to write, rather than failing part way into a backfill.

---

## The seven modes

```
npx tsx src/index.ts <mode> [options]
```

| Mode | What it does | Writes |
| - | - | - |
| `daily` | Ingests from each contract's coverage frontier to the chain tip, minus the finality margin | `RawLogs`, `Transactions` |
| `backfill` | Ingests a named range, or each contract's whole history from its creation block | `RawLogs`, `Transactions` |
| `verify` | Reconciles the warehouse against a contract's own ledger, per protocol day | Nothing except a reconciliation record |
| `coverage` | Reports every block range not covered by a clean capture, and every contract with no capture at all | Nothing |
| `dedup` | Collapses repeated natural keys, in place | `RawLogs`, `Transactions` |
| `repair` | Re-reads every range the coverage ledger records as not covered, then re-checks | `RawLogs`, `Transactions` |
| `calibrate` | Repeats one identical query against every source and reports each one's miss rate | Nothing |

Options: `--chains=A,B`, `--addresses=0x..`, `--from=N --to=N`, `--days=N,N`, `--dry-run`.

Exit codes: `0` everything attempted completed and reconciled, `1` partial, `2` nothing
succeeded or the arguments were wrong. Every mode fails closed. A run that skipped a chunk, or
that found an empty range it could not confirm, does **not** exit zero, and the coverage row it
leaves behind holds the next run's resume point at or below the gap.

---

## The normal day

```
npx tsx src/index.ts daily
npx tsx src/index.ts coverage
npx tsx src/index.ts verify
```

`daily` is what the scheduled workflow runs. `coverage` says what the warehouse does and does not
cover, which is the question an empty query result cannot answer on its own. `verify` is cheap
relative to being wrong, and it is the only check here that consults something outside the
warehouse.

## Adding a contract

Add a row to the `contract_deployments` seed, with the chain, the proxy address, the creation
block, and one row per implementation era with its block range. Nothing in this program changes,
and no table changes either. If the contract exposes a counter that can settle its own event
count, add it to `ORACLES` in `src/config.ts`, because a contract with an oracle can be
reconciled against the chain and one without it can only be checked for coverage.

## Adding a chain

Add an entry to `NETWORKS` in `src/config.ts` with its chain id, its readers, and a finality
margin **that states where the number came from**. A bare constant records no evidence: The
previous Celo value was wrong by a factor of thirty and nothing in the file could be used to
check it. Where a chain publishes no finality tag at all, say so in the entry, because the margin
is then a stated time budget rather than a measurement, and every row carries
`confirmations_at_capture` so a consumer can apply its own threshold instead.

A chain with no adequate reader is **not** skipped. It records a `capability_gap` capture naming
what is missing and claims no coverage, so an empty result over it can be read correctly.

## When something is wrong

| Symptom | What to run |
| - | - |
| `coverage` reports open gaps | `repair`, which re-reads exactly those ranges and re-checks the ledger afterwards |
| `coverage` reports a contract with no capture at all | `backfill --addresses=0x..`, because no range has ever been read for it |
| `verify` reports days as `missing` | `repair`, then `verify --days=...` |
| `verify` reports days as `duplicated` | `dedup --dry-run`, then `dedup` |
| `verify` reports days as `amount_unreadable` | A value in `log_data` exceeded what the decoder can represent. It is reported rather than summed as a zero |
| A run exits 1 with skipped chunks | The coverage row already holds the exact ranges. `repair` is the route; `backfill --from --to` is the manual one |
| A range looks empty and you do not believe it | `calibrate --from --to`, which repeats the identical query against every source |
| `REORG SUSPECTED` in the log | The row has already been rewritten whole, including its block facts and provenance, and the coverage row records it. Nothing manual is needed |

---

## The tables this writes besides the L0 tables

| Table | Answers |
| - | - |
| `IngestionCoverage` | Which source read which range of which contract, what it found, what it failed on, and how far the result can be trusted. Written for every attempted range including failed ones. **This is where resume comes from** |
| `OracleReconciliation` | What did the contract say, what does the warehouse hold, per protocol day, per run |
| `PipelineRuns` | One row per invocation, with its exit code and its capture counts |

`IngestionCoverage` exists because an absence of rows is not an absence of events. A block range
with no coverage row **was never scanned**, and any model that reads its emptiness as a
measurement is wrong.

`IngestionStatus` is no longer written. It recorded one row per contract per run and nothing ever
read it, so it could not answer the resume question and did not answer any other. Its existing
rows are left where they are; this program simply no longer adds to them.

---

## Scheduling

`.github/workflows/pipeline-daily.yml`, 01:00 UTC daily, plus manual dispatch.

**It has never successfully run.** `PipelineRuns` holds eight rows, every one of them from a
laptop, none from a runner, across the seven weeks since the workflow was merged. The pipeline
log shows the GCP credential setup failing four different ways on 2026-08-18. Before relying on
the schedule, dispatch it manually and confirm a row appears in `PipelineRuns` with a runner
hostname.

---

## Known limits, stated rather than discovered later

- **No historical backfill has been run.** The pipeline has been exercised over small ranges on
  XDC and Ethereum against a sandbox dataset. The full history is a separate, larger piece of
  work with its own cost and access decisions.
- **Two of the four chains have no index.** `fuse.hypersync.xyz` and `eth.hypersync.xyz` do not
  resolve, so those chains are enumerated over JSON-RPC, which costs two calls per transaction
  and one per block on top of the log query. One explorer in that set publishes a quota of ten
  reads per eleven minutes; hydration rotates across the available endpoints and backs off hard
  on a rate limit, but a wide range there is slow by construction.
- **Assurance grade A needs two independent readers that both answer.** A complete capture from a
  single index earns C, because one source is one source however good it is. That is the
  definition rather than a judgement on the reader, and it means the two chains with no index can
  reach a higher grade than the two with one. Raising the index chains to B means confirming
  non-empty ranges against a second source, which is real cost and is not done today.
- **`era_resolution` is `era_map_lookup` or `unresolved`, never `slot_read_at_block`.** The era
  is resolved from the reference seed's block ranges rather than by reading the proxy slot at
  each row's own block, which would be one archive call per log. A block the seed does not cover
  yields `unresolved` with a null era index, which is a real answer and is not era 1.
- **A reverted transaction is absent by construction.** It emits no logs, so a log filter can
  never reach it. Absence from `Transactions` means "produced no captured log", never "did not
  happen".
- **Empty-chunk confirmation is expensive on sparse ranges.** Each empty chunk costs one
  JSON-RPC query per endpoint per sub-range. `CONFIRM_EMPTY_CHUNKS=false` turns it off, and
  turning it off is how a false zero becomes a permanent gap.
- **A `daily` run over a contract with no coverage is a full backfill of that contract.** The
  coverage ledger is the only thing that can say a range was read, so a contract with no coverage
  row resumes from its creation block. That is deliberate: Inferring coverage from the rows that
  happen to be present is the defect this pipeline was rewritten to remove.
