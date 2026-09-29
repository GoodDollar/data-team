# Pipeline tests

Three commands, answering three different questions.

| Command | Runs | Expected result | Needs a credential |
| - | - | - | - |
| `npm test` | `test/unit` and `test/integration` | green | no |
| `npm run test:coverage` | the same, with coverage | green, writes `coverage/` | no |
| `npm run test:known-failures` | `test/known-failures` | green once every reproduced defect is fixed | no |
| `npm run gate:write-safety` | `test/integration/two-process-merge.gate.ts` | green | **yes** |
| `npm run verify:local` | lint, typecheck, coverage, then known failures | green | no |

`npm test` is what a pull request must pass. `npm run verify:local` is what decides whether the
release candidate is releasable. `npm run gate:write-safety` is separate because it is the only
check here that needs real infrastructure -- see below.

## `test/known-failures` reproduces defects, and is green when none is open

Every test in there reproduces a defect that was real in this pipeline. Each one names the finding
it encodes and the source file and behaviour that caused it. None is skipped, none is marked
`todo`, and none inverts its expectation, because a test that passes while its defect is present
proves nothing.

The folder is currently **green**: every defect it reproduces has been fixed, and each test now
guards against the return of the one it used to demonstrate. A test is never deleted to make a
build green, and a new one is added here red whenever a defect is found.

## The write-safety gate, and why it cannot live in `npm test`

`npm run gate:write-safety` spawns **two genuinely separate OS processes** that capture the same
block range at the same time, against a real BigQuery sandbox, and checks that the table ends up
holding one row per merge key.

It is separate from `npm test` for a reason that is not convenience. The defect it covers is two
processes racing for one table, and nothing running inside a single process can demonstrate that
one of them was excluded -- a test that calls the write path twice in one process is measuring
microtask ordering. So this check needs a real shared target, which means a credential, which
means it cannot run in the credential-free suite.

It creates its own labelled sandbox datasets through `src/sandbox.ts`, drops them on the failure
path too, and proves them absent with a listing rather than trusting a delete call's return value.
It writes a JSON receipt naming each clause it checked:

```
npm run gate:write-safety -- path/to/receipt.json
```

## Nothing in `npm test` touches a network or a cloud

The suite makes zero HTTP requests, uses zero credentials and creates zero cloud objects. That is
enforced rather than intended:

- `test/setup/env.ts` overwrites the environment with obviously fake values, deletes every Google
  credential variable, and replaces `globalThis.fetch` with one that throws.
- `test/helpers/bq-simulator.ts` answers only the SQL shapes this pipeline emits and throws on
  anything else, so an unmodelled statement fails loudly instead of returning a plausible empty
  result.
- `test/helpers/wire-recorder.ts` records the exact JSON-RPC envelope each call puts on the wire
  and throws when a method has no configured answer.

This is possible because `src/adapters.ts` makes every edge replaceable: the BigQuery client, the
RPC transport, the reader, the clock, the write lock and the notifier. `resetAdapters()` in an
`afterEach` puts them all back, and the suite runs one file at a time so two files cannot fight
over them.

## What the simulator is and is not

`BigQuerySimulator` models exactly three statement behaviours, because exactly three things
depend on them:

1. A MERGE matches only target rows inside the literal partition window in its `ON` clause, so a
   row holding the same key outside that window is not a candidate and gets inserted again.
2. A MERGE matches against a snapshot of the target taken when the statement starts, so two
   overlapping statements both insert.
3. A whole-history key census through the all-history view, which is the only read that can SEE a
   duplicate created by the first behaviour -- it sits, by construction, in a partition every
   windowed check excludes.

It has no partition pruning, no cost, no types and no transactions beyond that snapshot. Anything
needing a real warehouse belongs in `npm run gate:write-safety` or in the sandbox integration
workflow, which is defined and disabled until its service account exists.

## Adding a test

Put it in `test/unit` if it is a pure function or a single module, `test/integration` if it drives
several modules through the simulator, and `test/known-failures` only if it reproduces a defect
that is genuinely present. In that last case the failure message is the deliverable: write it so
someone reading only the message knows what broke, where, and who fixes it.
