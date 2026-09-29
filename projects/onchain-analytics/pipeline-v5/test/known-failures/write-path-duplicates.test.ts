/**
 * THE WRITE PATH AND ITS TWO DUPLICATE-KEY DEFECTS. BOTH NOW CLOSED; THIS FILE IS THE GUARD.
 *
 *   C1   Two concurrent captures of the same range both insert the same keys.
 *        CLOSED by a cross-process write lease, `src/writelock.ts`, installed as the default in
 *        `adapters.ts` and acquired in `stageAndMerge`. A second writer on the host is excluded;
 *        a refused writer throws, is recorded `incomplete`, and exits nonzero.
 *   R-XPART A guarded MERGE whose literal window does not cover an existing row inserts a second
 *        row under the same key. CLOSED WITHIN A BOUND by the padded whole-month window in
 *        `src/window.ts`, plus `verifyMergeKeyUniqueness` so that the residue beyond the bound is
 *        reported rather than silent. The bound is 31 to 62 days and is stated everywhere it
 *        matters, including beside the MERGE itself.
 *
 * SIMULATOR-BACKED, AND HERE IS THE RECEIPT EACH ONE ENCODES.
 *
 *   C1 was proven on real infrastructure. `specs/system/readiness-audit-2026-09-25.md` section
 *   "C1. Two concurrent successful runs duplicate RawLogs" records two processes capturing XDC
 *   105,201,000..105,201,500 at the same time: both exited 0, RawLogs held 149 stored rows over
 *   102 distinct keys, 47 phantoms, while every coverage row and every PipelineRuns row said
 *   complete. The fixture below uses that exact range.
 *
 *   R-XPART was proven on a faithful sandbox fixture: 1 row becoming 2 under one merge key when
 *   the MERGE's target window did not cover the existing row, measured on an UNGUARDED table as
 *   well, which is what established it as ordinary MERGE semantics rather than a fault of
 *   `require_partition_filter`.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. It runs against `test/helpers/bq-simulator.ts`, which
 * models the two semantics the defects depend on and nothing else. That is enough to show the
 * write path's own logic is right, and it is NOT enough to prove cross-process exclusion: two
 * `stageAndMerge` calls here are two calls in one process. The lease is a real file and is
 * genuinely contended even here, but the two-OS-process reproduction lives in
 * `test/integration/`, because within-process repetition has already produced a wrong conclusion
 * on this project once. Each test below is followed by a DISCRIMINATION check that proves the
 * simulator would report a correct implementation as correct, so a green here means the defect
 * is gone rather than that the harness is blind.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stageAndMerge, verifyMergeKeyUniqueness } from "../../src/bq.js";
import { MERGE_KEYS, RAW_LOGS_TABLE, RAW_LOGS_SCHEMA } from "../../src/config.js";
import { windowForRows } from "../../src/window.js";
import {
  setBigQueryClient, setWriteLock, resetAdapters,
  type WriteLock, type WriteLockHandle,
} from "../../src/adapters.js";
import { BigQuerySimulator, rendezvous } from "../helpers/bq-simulator.js";
import { rawLogRow, RAW_LOGS_COLUMNS, C1_RANGE, XDC_CHAIN_ID, hash32 } from "../helpers/fixtures.js";

const KEY = MERGE_KEYS[RAW_LOGS_TABLE];

let sim: BigQuerySimulator;

beforeEach(() => {
  sim = new BigQuerySimulator();
  sim.defineTable(RAW_LOGS_TABLE, RAW_LOGS_COLUMNS, []);
  setBigQueryClient(sim);
});

afterEach(() => resetAdapters());

/** A lock that admits one holder at a time. This is what Phase 5 has to build for real. */
function serialisingLock(): WriteLock {
  let chain: Promise<void> = Promise.resolve();
  return {
    async acquire(): Promise<WriteLockHandle> {
      let releaseThis: () => void;
      const mine = new Promise<void>((r) => { releaseThis = r; });
      const waitFor = chain;
      chain = chain.then(() => mine);
      await waitFor;
      return { release: async () => { releaseThis!(); } };
    },
  };
}

describe("C1: two concurrent captures of one range duplicate every merge key", () => {
  /**
   * Both captures stage the same 47 keys and merge them at the same time. Each MERGE matches
   * against the target as it stood when that statement started, so neither sees the other's
   * inserts and both insert.
   */
  async function twoConcurrentCaptures(): Promise<void> {
    const rows = Array.from({ length: 47 }, (_, i) =>
      rawLogRow({
        blockNumber: C1_RANGE.from + i,
        txHash: hash32(`c1-${i}`),
        logIndex: 0,
        chainId: XDC_CHAIN_ID,
      })
    );
    const w = windowForRows(rows, 1)!;

    // Hold both statements open until both have taken their snapshot. Two real processes did
    // this to each other by accident; here it is deterministic so the test cannot flake.
    sim.onMergeSnapshotTaken = rendezvous(2);

    await Promise.all([
      stageAndMerge(RAW_LOGS_TABLE, rows, RAW_LOGS_SCHEMA, "run-process-1", w),
      stageAndMerge(RAW_LOGS_TABLE, rows, RAW_LOGS_SCHEMA, "run-process-2", w),
    ]);
  }

  it("stores exactly one row per merge key after two simultaneous identical captures", async () => {
    await twoConcurrentCaptures();

    const stored = sim.rowsOf(RAW_LOGS_TABLE).length;
    const distinct = sim.distinctKeys(RAW_LOGS_TABLE, KEY).size;

    expect(
      stored,
      `C1 HAS REOPENED: ${stored} stored rows over ${distinct} distinct merge keys ` +
      `(${stored - distinct} phantom rows). Two concurrent captures of the same range each ` +
      `matched against a target snapshot taken before the other inserted, so both inserted. ` +
      `The lease in pipeline-v5/src/writelock.ts is supposed to exclude the second writer at ` +
      `the seam in stageAndMerge. Either it is no longer the registered default -- check that ` +
      `adapters.setWriteLockFactory is still called on bq.ts import -- or acquire() is granting ` +
      `two holders at once.`
    ).toBe(distinct);
  });

  it("DISCRIMINATION: a serialising lock in the same seam produces one row per key", async () => {
    setWriteLock(serialisingLock());
    await twoConcurrentCaptures();

    const stored = sim.rowsOf(RAW_LOGS_TABLE).length;
    const distinct = sim.distinctKeys(RAW_LOGS_TABLE, KEY).size;

    // If this ever fails, the simulator cannot tell a fixed implementation from a broken one and
    // the RED test above proves nothing.
    expect(distinct).toBe(47);
    expect(stored).toBe(47);
  });
});

describe("R-XPART: a guarded MERGE misses the same key in a non-incoming month", () => {
  /**
   * Re-merge one existing key from a month `displacedDays` in the past, and return what the
   * table ends up holding.
   *
   * The key already exists under an older timestamp. The incoming batch carries the same key
   * under a newer one, so the window derived from the incoming rows may or may not reach back
   * far enough to make the existing row a match candidate. Whether it does is the whole subject.
   */
  async function mergeDisplacedBy(displacedDays: number, seed: string): Promise<void> {
    const key = { txHash: hash32(seed), logIndex: 0, chainId: XDC_CHAIN_ID };
    const incomingTs = new Date("2026-08-05T00:00:00.000Z");
    const existingTs = new Date(incomingTs.getTime() - displacedDays * 86_400_000);

    sim.defineTable(RAW_LOGS_TABLE, RAW_LOGS_COLUMNS, [
      rawLogRow({ ...key, blockNumber: 105_100_000, blockTimestamp: existingTs.toISOString() }),
    ]);

    const incoming = [
      rawLogRow({ ...key, blockNumber: 105_100_000, blockTimestamp: incomingTs.toISOString() }),
    ];
    await stageAndMerge(
      RAW_LOGS_TABLE, incoming, RAW_LOGS_SCHEMA, `run-xpart-${displacedDays}`,
      windowForRows(incoming, 1)!
    );
  }

  /**
   * R-XPART closes as a BOUNDED fix plus a detector, and this test asserts both halves, because
   * either one alone would be a misleading pass.
   *
   * WHAT THE PADDED WINDOW CLOSES. `windowForRows` truncates the incoming rows' span to whole
   * months and pads one month each side, so an existing row displaced back as far as the start
   * of the month before the source's own month is still a match candidate and is UPDATED. The
   * reachable displacement is therefore 31 to 62 days depending where in its month the source
   * sits, and the arithmetic is worth doing once rather than trusting the range: the source here
   * is 2026-08-05, so the window opens at 2026-07-01, which is 4 days back through August plus
   * the 31 of July -- 35 days. 30 is inside it and crosses a month boundary, which is the case
   * the padding exists for.
   *
   * WHAT IT DOES NOT CLOSE, MEASURED RATHER THAN ASSUMED. A row displaced 95 days is outside the
   * padding and still duplicates. That residue is accepted deliberately: the general fix is a
   * key directory recording where each key already lives, and it is deferred because nothing in
   * this deployment writes outside a recent window. A re-read that moves a timestamp by more
   * than the bound is a CORRECTION rather than a reorganisation, and a correction states its own
   * window through `windowForSpan`.
   *
   * WHY THE SECOND HALF IS STILL A PASS AND NOT A FAILURE. What made every duplicate incident in
   * this project expensive was not the duplicate, it was the SILENCE: the rows were wrong and
   * every count, grain and referential test passed. An accepted residue is only defensible if it
   * is visible, so the closure condition is not "no duplicate is possible", it is "no duplicate
   * is silent". `verifyMergeKeyUniqueness` is that detector, and it reads through the
   * all-history view because a duplicate created by a non-covering window sits by construction
   * in a partition every windowed check excludes.
   *
   * Renamed from "stores one row per merge key when a row is re-merged from a distant month",
   * which asserted the unbounded property. That test could not pass under the fix the plan
   * specifies and records as accepted at 31 to 62 days; it asserted the deferred key directory.
   */
  it("bounds a distant-month re-merge to the padding, and detects the duplicate beyond it", async () => {
    await mergeDisplacedBy(30, "xpart-inbound");

    expect(
      sim.rowsOf(RAW_LOGS_TABLE).length,
      `A 30-day displacement from 2026-08-05 reaches 2026-07-06, which is inside the window the ` +
      `padding opens at 2026-07-01, so the existing row is a match candidate and the MERGE ` +
      `updates it rather than inserting beside it.`
    ).toBe(1);
    expect(sim.distinctKeys(RAW_LOGS_TABLE, KEY).size).toBe(1);

    const inBound = await verifyMergeKeyUniqueness(RAW_LOGS_TABLE, XDC_CHAIN_ID);
    expect(inBound.ok, "nothing to detect when the window covered the row").toBe(true);
    expect(inBound.report.phantomRows).toBe(0);

    // Beyond the bound the duplicate is real. The closure condition is that it is REPORTED.
    await mergeDisplacedBy(95, "xpart-outofbound");

    const stored = sim.rowsOf(RAW_LOGS_TABLE).length;
    const distinct = sim.distinctKeys(RAW_LOGS_TABLE, KEY).size;
    expect(
      stored - distinct,
      `95 days is outside the 31-to-62-day padding bound, so this duplicates. That is the ` +
      `accepted residue, not a regression.`
    ).toBe(1);

    const outOfBound = await verifyMergeKeyUniqueness(RAW_LOGS_TABLE, XDC_CHAIN_ID);
    expect(
      outOfBound.ok,
      `R-XPART's residue must never be silent. verifyMergeKeyUniqueness reads through the ` +
      `all-history view precisely because the phantom sits in a partition the incoming window ` +
      `excluded, so every windowed check in the write path is guaranteed to miss it.`
    ).toBe(false);
    expect(outOfBound.report.phantomRows).toBe(1);
    expect(outOfBound.report.storedRows).toBe(stored);
    expect(outOfBound.report.distinctKeys).toBe(distinct);
  });

  it("DISCRIMINATION: the same merge inside the window updates instead of inserting", async () => {
    const key = { txHash: hash32("xpart-2"), logIndex: 0, chainId: XDC_CHAIN_ID };
    sim.defineTable(RAW_LOGS_TABLE, RAW_LOGS_COLUMNS, [
      rawLogRow({ ...key, blockNumber: 105_100_000, blockTimestamp: "2026-08-02T00:00:00.000Z" }),
    ]);
    const incoming = [
      rawLogRow({ ...key, blockNumber: 105_100_000, blockTimestamp: "2026-08-05T00:00:00.000Z" }),
    ];
    await stageAndMerge(
      RAW_LOGS_TABLE, incoming, RAW_LOGS_SCHEMA, "run-xpart-control", windowForRows(incoming, 1)!
    );

    expect(sim.rowsOf(RAW_LOGS_TABLE).length).toBe(1);
    expect(sim.distinctKeys(RAW_LOGS_TABLE, KEY).size).toBe(1);

    // And the detector agrees with the row count. A detector that reported a phantom here would
    // be a machine for false alarms, which is as useless as one that reports nothing.
    const clean = await verifyMergeKeyUniqueness(RAW_LOGS_TABLE, XDC_CHAIN_ID);
    expect(clean.ok).toBe(true);
    expect(clean.report.phantomRows).toBe(0);
  });
});
