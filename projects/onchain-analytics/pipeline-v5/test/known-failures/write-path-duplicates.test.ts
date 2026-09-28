/**
 * KNOWN FAILURE: the write path duplicates a merge key.
 *
 * Two defects, one mechanism, one owning phase.
 *
 *   C1   Two concurrent captures of the same range both insert the same keys.
 *        Owner: Phase 5 (write-safety agent). Ownership matrix: "Two-process integration test".
 *   R-XPART A guarded MERGE whose literal window does not cover an existing row inserts a second
 *        row under the same key. Owner: Phase 5. Ownership matrix: "Key directory plus cross-month
 *        guarded MERGE regression".
 *
 * SIMULATOR-BACKED, AND HERE IS THE RECEIPT EACH ONE ENCODES.
 *
 *   C1 was proven on real infrastructure. `specs/system/readiness-audit-2026-09-25.md` section
 *   "C1. Two concurrent successful runs duplicate RawLogs" records two processes capturing XDC
 *   105,201,000..105,201,500 at the same time: both exited 0, RawLogs held 149 stored rows over
 *   102 distinct keys, 47 phantoms, while every coverage row and every PipelineRuns row said
 *   complete. The fixture below uses that exact range.
 *
 *   R-XPART was proven on a faithful sandbox fixture. `specs/MASTER-PLAN.md`, the 2026-09-27
 *   coordination entry, and the repo memory note "CORRECTED 2026-09-24 (verify-2026-09-24-guard)"
 *   record 1 row becoming 2 under one merge key when the MERGE's target window did not cover the
 *   existing row, measured on an UNGUARDED table as well, which is what established it as
 *   ordinary MERGE semantics rather than a fault of `require_partition_filter`.
 *
 * Phase 1 may not reach BigQuery, so these run against `test/helpers/bq-simulator.ts`, which
 * models the two semantics the defects depend on and nothing else. Phase 5 replaces them with the
 * real two-process sandbox reproduction. Each test below is followed by a DISCRIMINATION check
 * that proves the simulator would report a correct implementation as correct, so a green here
 * would mean the defect is gone rather than that the harness is blind.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stageAndMerge } from "../../src/bq.js";
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
      `C1 reproduced: ${stored} stored rows over ${distinct} distinct merge keys ` +
      `(${stored - distinct} phantom rows). Two concurrent captures of the same range each ` +
      `matched against a target snapshot taken before the other inserted, so both inserted. ` +
      `Nothing in pipeline-v5/src/bq.ts excludes a second writer; the lock seam at stageAndMerge ` +
      `holds adapters.NO_LOCK, which grants instantly and serialises nothing. Owner: Phase 5.`
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
   * The key already exists, stored under a June timestamp. The incoming batch carries the same
   * key with an August timestamp, so the window derived from the incoming rows covers July to
   * September and the June row is not a match candidate. The MERGE inserts.
   *
   * This is the reorg-near-a-month-boundary shape, and the one-month padding is what bounds it:
   * padding covers a displacement back to the start of the month before the source month, 31 to
   * 62 days. The 95-day displacement below is outside that bound, which is exactly the case the
   * 2026-09-27 measurement recorded as duplicating.
   */
  async function mergeAcrossMonths(): Promise<void> {
    const key = { txHash: hash32("xpart-1"), logIndex: 0, chainId: XDC_CHAIN_ID };

    sim.defineTable(RAW_LOGS_TABLE, RAW_LOGS_COLUMNS, [
      rawLogRow({ ...key, blockNumber: 105_100_000, blockTimestamp: "2026-05-02T00:00:00.000Z" }),
    ]);

    const incoming = [
      rawLogRow({ ...key, blockNumber: 105_100_000, blockTimestamp: "2026-08-05T00:00:00.000Z" }),
    ];
    const w = windowForRows(incoming, 1)!;
    await stageAndMerge(RAW_LOGS_TABLE, incoming, RAW_LOGS_SCHEMA, "run-xpart", w);
  }

  it("stores one row per merge key when a row is re-merged from a distant month", async () => {
    await mergeAcrossMonths();

    const stored = sim.rowsOf(RAW_LOGS_TABLE).length;
    const distinct = sim.distinctKeys(RAW_LOGS_TABLE, KEY).size;

    expect(
      stored,
      `R-XPART reproduced: ${stored} stored rows over ${distinct} distinct merge keys. The MERGE ` +
      `target window is derived in pipeline-v5/src/window.ts windowForRows() from the INCOMING ` +
      `rows only, so an existing row outside that window is not a match candidate and WHEN NOT ` +
      `MATCHED inserts a second row under the same key. One month of padding bounds a ` +
      `displacement of 31 to 62 days; this one is 95. Nothing in the write path consults a key ` +
      `directory to find where the key already lives. Owner: Phase 5.`
    ).toBe(distinct);
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
  });
});
