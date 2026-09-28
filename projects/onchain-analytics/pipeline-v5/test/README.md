# Pipeline tests

Two suites. They answer different questions and are run by different commands.

| Command | Runs | Expected result |
| - | - | - |
| `npm test` | `test/unit` and `test/integration` | green |
| `npm run test:coverage` | the same, with coverage | green, writes `coverage/` |
| `npm run test:known-failures` | `test/known-failures` | **red, on purpose** |
| `npm run verify:local` | lint, typecheck, coverage, then known failures | **nonzero while any known failure is red** |

`npm test` is what a pull request must pass. `npm run verify:local` is what decides whether the
release candidate is releasable, and it cannot be green while a reproduced defect is still open.

## `test/known-failures` is expected to fail

Every test in there reproduces a defect that exists in this pipeline right now. Each one names the
finding it encodes, the source file and behaviour that causes it, and the phase that owns the fix.
None is skipped, none is marked `todo`, and none inverts its expectation, because a test that
passes while the defect is present proves nothing.

A test leaves that folder when the defect is fixed. It then moves into `test/unit` or
`test/integration` and travels with the fix, so the same assertion that proved the defect becomes
the guard against its return. Do not delete one to make a build green.

## Nothing here touches a network or a cloud

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

`BigQuerySimulator` models exactly two semantics, because exactly two defects depend on them:

1. A MERGE matches only target rows inside the literal partition window in its `ON` clause, so a
   row holding the same key outside that window is not a candidate and gets inserted again.
2. A MERGE matches against a snapshot of the target taken when the statement starts, so two
   overlapping statements both insert.

It has no partition pruning, no cost, no types and no transactions beyond that snapshot. Tests that
need a real warehouse belong in the sandbox integration workflow, which is defined and disabled
until its identity exists.

## Adding a test

Put it in `test/unit` if it is a pure function or a single module, `test/integration` if it drives
several modules through the simulator, and `test/known-failures` only if it reproduces a defect
that is genuinely present. In that last case the failure message is the deliverable: write it so
someone reading only the message knows what broke, where, and who fixes it.
