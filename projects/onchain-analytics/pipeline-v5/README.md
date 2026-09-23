# The GoodDollar ingestion pipeline

This is the **only** pipeline in this repository. It reads decoded contract event logs from
Envio HyperSync and writes them into BigQuery, then checks its own work against the contracts.

Two older versions existed, `pipeline/` and `future/pipeline-v4/`, and both are gone. What they
could do that this one could not has been ported, and what they did that was wrong is the reason
several of the rules below exist.

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

Five properties follow from that, and every one of them is load bearing.

| Property | Why |
| - | - |
| The write path is a staging table plus a `MERGE` on `(network, tx_hash, log_index)` | Re-running a range is free, which is the precondition for everything else here |
| The watermark resumes **at** the last stored block, not one past it | A partially written block is always revisited. Only safe because of the row above |
| Buffers flush on a **block boundary** | A write never splits a block in the first place |
| A chunk that returns nothing is a **negative to confirm**, not a result | An identical repeated log query on these endpoints returned zero seven times in ten one day and three times in ten the day before, with no errors raised |
| A short collection is a **failure**, not an empty one | HyperSync announces truncation through `nextBlock`. A caller that ignores it reads truncation as absence |

And one thing that is new rather than fixed: **the contracts keep their own ledgers, and now we
ask them.** `getClaimerCount(day)` and `getClaimAmount(day)` on the UBIScheme, and `stats()` on
the Invites contract, are public getters over live mappings. `verify` reconciles the warehouse
against them per protocol day, to the raw unit. Every correctness argument this warehouse had
before that compared the warehouse against itself.

---

## Setup, once per machine

```
cd projects/onchain-analytics/pipeline-v5
npm install
cp .env.example .env          # then fill in ENVIO_API_TOKEN
gcloud auth application-default login
```

The BigQuery tables are created by the DDL in `../warehouse/L1/`, not by the pipeline. Apply
`04_L0Contract_v3.sql` before ingesting anything. The pipeline refuses to write a column the
live table does not have rather than corrupting a `MERGE`.

---

## The six modes

```
npx tsx src/index.ts <mode> [options]
```

| Mode | What it does | Writes |
| - | - | - |
| `daily` | Ingests from the last stored block to the chain tip, minus the finality margin | Event tables |
| `backfill` | Ingests a named range, or each contract's whole history | Event tables |
| `verify` | Reconciles the warehouse against the contract's own ledger, per protocol day | Nothing except a reconciliation record |
| `dedup` | Collapses repeated natural keys left behind by the predecessor | Event tables, after writing a backup copy |
| `repair` | Re-ingests the protocol days the oracle says are short, then re-checks them | Event tables |
| `calibrate` | Repeats one identical query against every source and reports each one's miss rate | Nothing |

Options: `--contracts=A,B`, `--from=N --to=N`, `--days=N,N`, `--dry-run`.

Exit codes: `0` everything attempted completed and reconciled, `1` partial, `2` nothing
succeeded or the arguments were wrong. Every mode fails closed. A run that skipped a chunk, or
that found an empty range it could not confirm, does **not** exit zero and does **not** advance
the watermark past that range.

---

## The normal day

```
npx tsx src/index.ts daily
npx tsx src/index.ts verify
```

`daily` is what the scheduled workflow runs. `verify` is cheap relative to being wrong, and it
is the only check here that consults something outside the warehouse.

## Adding a contract

Add an entry to `CONTRACTS` in `src/config.ts`, being a table id, a schema, an ABI, and one
network binding per chain. Nothing else changes. If the contract exposes a counter that can
settle its own event count, add it to `ORACLES` in the same file, because a table with an oracle
can be reconciled and a table without one can only be self-checked.

## When something is wrong

| Symptom | What to run |
| - | - |
| `verify` reports days as `missing` | `repair --days=...`, which re-ingests those days and re-checks them |
| `verify` reports days as `duplicated` | `dedup --dry-run`, then `dedup` |
| A run exits 1 with skipped chunks | Look at `IngestionCoverage` for the exact ranges, then `backfill --from --to` over them |
| A range looks empty and you do not believe it | `calibrate --from --to`, which repeats the identical query against every source |
| `REORG SUSPECTED` in the log | An existing key now sits under a different block hash. Delete and re-ingest that range |

---

## The tables this writes besides the event tables

| Table | Answers |
| - | - |
| `IngestionCoverage` | Did we cover blocks X to Y, how many times, and did every chunk succeed. Written for every attempted range including failed ones |
| `OracleReconciliation` | What did the contract say, what does the warehouse hold, per protocol day, per run |
| `IngestionStatus` | One row per contract per run. Kept for continuity; `IngestionCoverage` is the one to read |
| `PipelineRuns` | One row per invocation, with its exit code |

`IngestionCoverage` exists because `IngestionStatus` could not answer the question. It recorded
`last_block = -1` with `status = success` on every run that fetched nothing, so it cannot tell
"there was nothing to fetch" apart from "the fetch returned nothing", and those are the two
cases that matter most.

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

- **Celo is configured but not enabled.** The network entry, chain id, block time and endpoints
  are correct and the hardcoded chain id that would have mislabelled every Celo row as XDC is
  fixed, but no Celo binding is switched on and none of this has been exercised against Celo.
- **`implementation_address` is never populated.** It needs a per-block EIP-1967 slot read,
  which is snapshot work, not ingestion work.
- **Empty-chunk confirmation is expensive on sparse ranges.** Each empty chunk costs one
  JSON-RPC query per endpoint per sub-range. `CONFIRM_EMPTY_CHUNKS=false` turns it off, and
  turning it off is how a false zero becomes a permanent gap.
- **A `daily` run over a long gap is a large backfill.** The ingestion window has been stopped
  since 2026-07-23, so the first `daily` run covers roughly 2.3 million blocks. Give it a
  `--from`/`--to` in slices, or raise `HS_RANGE_DEADLINE_MS`.
