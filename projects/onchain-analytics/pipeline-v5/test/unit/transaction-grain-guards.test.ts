/**
 * Green guards for the transaction grain, mirroring the H5 red tests.
 *
 * The H5 fixtures live in the known-failures suite, which the default suite and its coverage run
 * never execute. A fix whose only exercise is a RED suite is one config change away from being
 * unexercised, and the branch it added would sit uncovered in the module it changed. So the same
 * behaviour is asserted here, green, in the suite that runs on every push.
 *
 * Same pattern as `reader-regression-guards.test.ts`: a guard is not a duplicate of a red test,
 * it is the thing that keeps the red test from being the only witness.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runPipeline } from "../../src/pipeline.js";
import { setBigQueryClient, setReaderOverride, resetAdapters } from "../../src/adapters.js";
import { BigQuerySimulator } from "../helpers/bq-simulator.js";
import { hash32, RAW_LOGS_COLUMNS, TRANSACTIONS_COLUMNS } from "../helpers/fixtures.js";
import { RAW_LOGS_TABLE, TRANSACTIONS_TABLE } from "../../src/config.js";

const ADDRESS = "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf";

/** Two logs, two distinct transaction hashes, and only ONE transaction returned. */
function chunk(transactions: unknown[]) {
  return {
    fromBlock: 1_000, toBlock: 1_010, ok: true,
    logs: [
      {
        blockNumber: 1_000, blockHash: hash32("bh1"), transactionHash: hash32("tx1"),
        transactionIndex: 0, logIndex: 0, address: ADDRESS,
        data: "0x", topics: [hash32("t0")], removed: false,
      },
      {
        blockNumber: 1_001, blockHash: hash32("bh2"), transactionHash: hash32("tx2"),
        transactionIndex: 0, logIndex: 0, address: ADDRESS,
        data: "0x", topics: [hash32("t0")], removed: false,
      },
    ],
    transactions,
    blocks: [
      { number: 1_000, hash: hash32("bh1"), timestamp: 1_781_000_000 },
      { number: 1_001, hash: hash32("bh2"), timestamp: 1_781_000_005 },
    ],
    nextBlock: 1_011, archiveHeight: 2_000, rollbackGuard: null,
    sourceKind: "index" as const, sourceId: "hypersync:xdc", attempts: [], ms: 0,
  };
}

function transaction(name: string, blockNumber: number, blockHash: string) {
  return {
    hash: hash32(name), blockNumber, blockHash, transactionIndex: 0,
    from: "0x0000000000000000000000000000000000000001", to: null, value: "0", nonce: "0",
    gas: "21000", gasUsed: "21000", effectiveGasPrice: "1", input: "0x", kind: 2, status: 1,
    contractAddress: null,
  };
}

let sim: BigQuerySimulator;

beforeEach(() => {
  sim = new BigQuerySimulator();
  sim.defineTable("RawLogs", RAW_LOGS_COLUMNS, []);
  sim.defineTable("Transactions", TRANSACTIONS_COLUMNS, []);
  setBigQueryClient(sim);
});

afterEach(() => resetAdapters());

function reader(transactions: unknown[]) {
  setReaderOverride(async (_n, _a, from, to, onChunk) => {
    await onChunk(chunk(transactions) as any);
    return {
      fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1,
      skipped: [], errors: [], emptyChunks: [], logsSeen: 2, complete: true,
      sourceKind: "index", sourceId: "hypersync:xdc", enumeratingSources: 1,
      headAtCapture: 2_000, rollbackGuards: [],
    };
  });
}

const backfill = () => runPipeline({
  mode: "backfill", chains: ["XDC"], addresses: [ADDRESS], fromBlock: 1_000, toBlock: 1_010,
});

const coverageRows = () => sim.tables.get("IngestionCoverage")?.rows ?? [];

describe("the transaction grain carries its own verdict", () => {
  it("marks ONLY the Transactions row incomplete when a transaction is missing", async () => {
    reader([transaction("tx1", 1_000, hash32("bh1"))]);
    await backfill();

    const rows = coverageRows();
    expect(rows.find((r) => r.target_table === TRANSACTIONS_TABLE)?.status).toBe("incomplete");
    // The log range genuinely completed. Marking it incomplete would be the opposite error and
    // would stall the resume point over a defect in a different grain.
    expect(rows.find((r) => r.target_table === RAW_LOGS_TABLE)?.status).toBe("complete");
  });

  it("says in the row WHY, rather than leaving a status with no account of itself", async () => {
    reader([transaction("tx1", 1_000, hash32("bh1"))]);
    await backfill();

    const tx = coverageRows().find((r) => r.target_table === TRANSACTIONS_TABLE);
    expect(tx?.error_message).toContain("MISSING_TRANSACTIONS: 1");
    expect(tx?.error_message).toContain("NOT complete for the transaction grain");
  });

  it("reaches the run counters, so the command cannot exit zero", async () => {
    reader([transaction("tx1", 1_000, hash32("bh1"))]);
    const result = await backfill();

    expect(result.failed).toBeGreaterThan(0);
    expect(result.summary.totals.incomplete).toBe(1);
    expect(result.summary.byGrain.get(TRANSACTIONS_TABLE)).toMatchObject({ incomplete: 1, completed: 0 });
    expect(result.summary.byGrain.get(RAW_LOGS_TABLE)).toMatchObject({ completed: 1, incomplete: 0 });
  });

  it("names the grain in the outcome, not just the contract", async () => {
    reader([transaction("tx1", 1_000, hash32("bh1"))]);
    const result = await backfill();

    const problem = result.summary.problems[0];
    expect(problem.grain).toBe(TRANSACTIONS_TABLE);
    expect(problem.detail).toMatch(/transaction\(s\) pointed at by a captured log were not returned/);
  });

  it("DISCRIMINATES: both grains complete when every transaction comes back", async () => {
    // Without this the tests above would also pass on a build that marks the transaction grain
    // incomplete unconditionally, which is a different defect with the same green ticks.
    reader([transaction("tx1", 1_000, hash32("bh1")), transaction("tx2", 1_001, hash32("bh2"))]);
    const result = await backfill();

    const rows = coverageRows();
    expect(rows.find((r) => r.target_table === TRANSACTIONS_TABLE)?.status).toBe("complete");
    expect(rows.find((r) => r.target_table === TRANSACTIONS_TABLE)?.error_message).toBe("");
    expect(result.failed).toBe(0);
    expect(result.summary.totals.completed).toBe(2);
  });

  it("records two rows and two outcomes, one per grain", async () => {
    reader([transaction("tx1", 1_000, hash32("bh1")), transaction("tx2", 1_001, hash32("bh2"))]);
    const result = await backfill();

    expect(coverageRows().map((r) => r.target_table).sort()).toEqual([RAW_LOGS_TABLE, TRANSACTIONS_TABLE]);
    expect(result.summary.units.map((u) => u.grain).sort()).toEqual([RAW_LOGS_TABLE, TRANSACTIONS_TABLE]);
  });

  it("keeps totalRows meaning RawLogs rows merged, not logs plus transactions", async () => {
    // It is persisted as `totalRowsMerged`. Adding the transaction rows to it would change what a
    // shipped column means rather than report a new fact.
    reader([transaction("tx1", 1_000, hash32("bh1")), transaction("tx2", 1_001, hash32("bh2"))]);
    const result = await backfill();

    expect(result.totalRows).toBe(2);
  });
});
