/**
 * CONTROL TEST, and it must PASS.
 *
 * Plan Section 5 task 5: "Add the current sequential-idempotency behaviour as a passing control
 * test."
 *
 * WHY THIS IS THE ONE THAT MATTERS MOST IN THIS FILE SET. The known-failure suite asserts that
 * two SIMULTANEOUS captures of one range duplicate every merge key. That assertion is worth
 * nothing unless the same two captures run one after another produce exactly one row per key,
 * because otherwise the finding is "MERGE does not work", not "there is no lock". This test is
 * what makes C1 a concurrency finding rather than a correctness-of-MERGE finding, and it is the
 * control the audit's own probe lacked: its four variants all carried the partition guard, so it
 * had nothing to compare against and blamed the guard for ordinary MERGE semantics.
 *
 * It is also the property A5 depends on. A backfill that is interrupted and restarted re-reads
 * the overlap, and if a sequential re-merge duplicated, no resume strategy could be safe.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stageAndMerge } from "../../src/bq.js";
import { MERGE_KEYS, RAW_LOGS_TABLE, RAW_LOGS_SCHEMA } from "../../src/config.js";
import { windowForRows } from "../../src/window.js";
import { setBigQueryClient, resetAdapters } from "../../src/adapters.js";
import { BigQuerySimulator } from "../helpers/bq-simulator.js";
import { rawLogRow, RAW_LOGS_COLUMNS, C1_RANGE, XDC_CHAIN_ID, hash32 } from "../helpers/fixtures.js";

const KEY = MERGE_KEYS[RAW_LOGS_TABLE];

let sim: BigQuerySimulator;

beforeEach(() => {
  sim = new BigQuerySimulator();
  sim.defineTable(RAW_LOGS_TABLE, RAW_LOGS_COLUMNS, []);
  setBigQueryClient(sim);
});

afterEach(() => resetAdapters());

function batch(count: number, tag: string, runId: string): Record<string, any>[] {
  return Array.from({ length: count }, (_, i) =>
    rawLogRow({
      blockNumber: C1_RANGE.from + i,
      txHash: hash32(`${tag}-${i}`),
      logIndex: 0,
      chainId: XDC_CHAIN_ID,
      runId,
    })
  );
}

describe("sequential idempotency: re-merging the same range changes nothing", () => {
  it("stores one row per merge key when the identical capture runs twice in a row", async () => {
    const rows = batch(47, "seq", "run-1");
    const w = windowForRows(rows, 1)!;

    const first = await stageAndMerge(RAW_LOGS_TABLE, rows, RAW_LOGS_SCHEMA, "run-1", w);
    const second = await stageAndMerge(RAW_LOGS_TABLE, rows, RAW_LOGS_SCHEMA, "run-2", w);

    expect(first.inserted).toBe(47);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(47);
    expect(sim.rowsOf(RAW_LOGS_TABLE).length).toBe(47);
    expect(sim.distinctKeys(RAW_LOGS_TABLE, KEY).size).toBe(47);
  });

  it("an overlapping resume re-reads the overlap without duplicating it", async () => {
    // The resume rule deliberately restarts AT the last covered block rather than one past it,
    // so every run overlaps its predecessor by design. That is only safe if the overlap merges.
    const firstPass = batch(30, "overlap", "run-1");
    const secondPass = [
      ...firstPass.slice(20),
      ...Array.from({ length: 10 }, (_, i) =>
        rawLogRow({
          blockNumber: C1_RANGE.from + 30 + i,
          txHash: hash32(`overlap-${30 + i}`),
          logIndex: 0,
          chainId: XDC_CHAIN_ID,
          runId: "run-2",
        })
      ),
    ];

    await stageAndMerge(RAW_LOGS_TABLE, firstPass, RAW_LOGS_SCHEMA, "run-1", windowForRows(firstPass, 1)!);
    await stageAndMerge(RAW_LOGS_TABLE, secondPass, RAW_LOGS_SCHEMA, "run-2", windowForRows(secondPass, 1)!);

    expect(sim.rowsOf(RAW_LOGS_TABLE).length).toBe(40);
    expect(sim.distinctKeys(RAW_LOGS_TABLE, KEY).size).toBe(40);
  });

  it("a repeated key inside ONE staging batch is collapsed before the MERGE", async () => {
    // BigQuery rejects a MERGE whose source offers one key twice, so this is a hard requirement
    // rather than tidiness. `stageAndMerge` de-duplicates in process and reports the collapse.
    const one = rawLogRow({ txHash: hash32("dupe"), logIndex: 0, chainId: XDC_CHAIN_ID });
    const rows = [one, { ...one }];

    const r = await stageAndMerge(RAW_LOGS_TABLE, rows, RAW_LOGS_SCHEMA, "run-1", windowForRows(rows, 1)!);

    expect(r.offered).toBe(2);
    expect(r.distinct).toBe(1);
    expect(sim.rowsOf(RAW_LOGS_TABLE).length).toBe(1);
  });

  it("a mixed-case hash is refused at the merge key rather than repaired", async () => {
    // Two spellings of one hash are two different keys, and a uniqueness test on the key cannot
    // flag that. The v4 migration lowercased contract_address and topics but not tx_hash, which
    // is IN the merge key, so this guard is the thing standing between the warehouse and a
    // duplicate no test could see.
    const row = rawLogRow({ chainId: XDC_CHAIN_ID });
    row.tx_hash = "0xAABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899";

    await expect(
      stageAndMerge(RAW_LOGS_TABLE, [row], RAW_LOGS_SCHEMA, "run-1", windowForRows([row], 1)!)
    ).rejects.toThrow(/MERGE_KEY_CASE/);
  });
});
