/**
 * range-duplicate-check.test.ts -- the duplicate check that runs after every daily ingestion,
 * backfill and repair, on the keys that run wrote.
 *
 * WHAT IT HAS TO CATCH. A MERGE whose window on the target does not cover an existing row inserts
 * a second row under the same key, and BigQuery never errors on it. The twin of that duplicate
 * sits OUTSIDE the MERGE window by construction, so it also sits outside the range the run wrote.
 * The seeded case below puts the twin there, and the check has to go red on it through the real
 * capture path, not through a hand-built report.
 *
 * WHAT IT DELIBERATELY DOES NOT CATCH. A twin further out than `twinWindowFor` is left to the
 * full-history scan, which is run by hand after a migration or the first full-history load. One
 * test pins that boundary so the trade is visible rather than discovered.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runPipeline } from "../../src/pipeline.js";
import { runRepair } from "../../src/repair.js";
import { duplicateReport } from "../../src/bq.js";
import { NETWORKS, RAW_LOGS_TABLE, TRANSACTIONS_TABLE } from "../../src/config.js";
import { targetsFor } from "../../src/registry.js";
import { windowForRows, twinWindowFor, monthSlices } from "../../src/window.js";
import { captureExitCodeFor } from "../../src/outcome.js";
import { setBigQueryClient, setReaderOverride, resetAdapters } from "../../src/adapters.js";
import { BigQuerySimulator } from "../helpers/bq-simulator.js";
import { rawLogRow, RAW_LOGS_COLUMNS, TRANSACTIONS_COLUMNS, XDC_CHAIN_ID, hash32 } from "../helpers/fixtures.js";

const ADDRESS = "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf";
// 2026-06-09. The run writes into June, so its MERGE window is May to July and the twin window
// is April to August.
const BLOCK_TS = 1_781_000_000;
const JULY_TS = BLOCK_TS + 31 * 86_400;
const AUGUST_TS = BLOCK_TS + 62 * 86_400;
const TX = hash32("tx1");

let sim: BigQuerySimulator;

beforeEach(() => {
  sim = new BigQuerySimulator();
  sim.defineTable(RAW_LOGS_TABLE, RAW_LOGS_COLUMNS, []);
  sim.defineTable(TRANSACTIONS_TABLE, TRANSACTIONS_COLUMNS, []);
  setBigQueryClient(sim);
  reader(ADDRESS, [BLOCK_TS]);
});

afterEach(() => resetAdapters());

/**
 * One log per timestamp, each with the transaction it points at, so a clean run is genuinely clean
 * and exits 0. The first log carries `TX`, the key the seeded twins share.
 */
function reader(address: string, timestamps: number[]): void {
  setReaderOverride(async (_n, _a, from, to, onChunk) => {
    const txHash = (i: number) => (i === 0 ? TX : hash32(`tx${i + 1}`));
    await onChunk({
      fromBlock: from, toBlock: to,
      logs: timestamps.map((_, i) => ({
        address, blockNumber: from + i, blockHash: hash32(`bh${i}`), transactionHash: txHash(i),
        transactionIndex: 0, logIndex: 0, topics: [hash32("t0")], data: "0x", removed: false,
      })),
      transactions: timestamps.map((_, i) => ({
        hash: txHash(i), blockNumber: from + i, blockHash: hash32(`bh${i}`), transactionIndex: 0,
        from: "0x0000000000000000000000000000000000000001", to: null, value: "0", nonce: "0",
        gas: "21000", gasUsed: "21000", effectiveGasPrice: "1", input: "0x", kind: 2, status: 1,
        contractAddress: null,
      })),
      blocks: timestamps.map((timestamp, i) => ({ number: from + i, hash: hash32(`bh${i}`), timestamp })),
      sourceKind: "index", sourceId: "hypersync:xdc", archiveHeight: to + 100,
    } as any);
    return {
      fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1, logsSeen: timestamps.length,
      skipped: [], errors: [], emptyChunks: [], complete: true,
      sourceKind: "index", sourceId: "hypersync:xdc", enumeratingSources: 1,
      headAtCapture: to + 100, rollbackGuards: [],
    } as any;
  });
}

/** A row already in RawLogs under the key the run is about to write, at another timestamp. */
function seedTwinAt(blockTimestamp: string, chainId = XDC_CHAIN_ID): void {
  sim.rowsOf(RAW_LOGS_TABLE).push(rawLogRow({
    chainId, txHash: TX, logIndex: 0, blockNumber: 900, blockTimestamp,
    runId: "an-earlier-run",
  }));
}

const run = (mode: "daily" | "backfill" = "daily") => runPipeline({
  mode, chains: ["XDC"], addresses: [ADDRESS], fromBlock: 1_000, toBlock: 1_010,
});

const duplicateUnits = (r: Awaited<ReturnType<typeof run>>) =>
  r.summary.units.filter((u) => u.detail.startsWith("DUPLICATE_KEYS"));

const reportsFor = (tableId: string) => sim.statements
  .filter((s) => s.kind === "duplicate_report")
  .filter((s) => new RegExp(`\\.${tableId}\`\\s+T\\s+WHERE`).test(s.sql));

describe("the duplicate check after a daily run", () => {
  it("RED: fails the run when the twin of a written key sits outside the written range", async () => {
    // April: outside the MERGE window, so the MERGE inserts a second row instead of updating it.
    seedTwinAt("2026-04-15T00:00:00.000Z");

    const result = await run();

    const rows = sim.rowsOf(RAW_LOGS_TABLE).filter((r) => r.tx_hash === TX);
    expect(rows.length, "the seed must actually produce a duplicate, or this test proves nothing").toBe(2);
    // A check that only grouped rows inside the run's own month would see one row and pass.
    const inOwnMonth = rows.filter((r) => String(r.block_timestamp).startsWith("2026-06"));
    expect(inOwnMonth.length).toBe(1);

    const dups = duplicateUnits(result);
    expect(dups.length, "the duplicate must become a failed unit").toBe(1);
    expect(dups[0].kind).toBe("failed");
    expect(dups[0].grain).toBe(RAW_LOGS_TABLE);
    expect(dups[0].detail).toContain("1 phantom row(s)");
    expect(captureExitCodeFor(result.summary), "a duplicate must make the run exit nonzero").not.toBe(0);
  });

  it("GREEN: the same run with no twin passes and exits 0", async () => {
    const result = await run();

    expect(duplicateUnits(result)).toEqual([]);
    expect(result.summary.problems, "the clean case must have nothing else wrong either").toEqual([]);
    expect(captureExitCodeFor(result.summary)).toBe(0);
  });

  it("checks every table the run merged into, and only those", async () => {
    await run();

    expect(reportsFor(RAW_LOGS_TABLE).length).toBe(1);
    expect(reportsFor(TRANSACTIONS_TABLE).length).toBe(1);
    expect(sim.statements.filter((s) => s.kind === "duplicate_report").length).toBe(2);
  });

  it("puts a literal partition filter on both references and never reads the all-history view", async () => {
    await run();

    for (const s of sim.statements.filter((x) => x.kind === "duplicate_report")) {
      expect(s.sql).toMatch(/T\.block_timestamp >= TIMESTAMP\('[^']+'\) AND T\.block_timestamp < TIMESTAMP\('[^']+'\)/);
      expect(s.sql).toMatch(/W\.block_timestamp >= TIMESTAMP\('[^']+'\) AND W\.block_timestamp < TIMESTAMP\('[^']+'\)/);
      expect(s.sql).not.toMatch(/AllHistory/);
      // The run's own month for the keys, the wider band for their copies.
      expect(s.sql).toContain("W.block_timestamp >= TIMESTAMP('2026-06-01 00:00:00')");
      expect(s.sql).toContain("T.block_timestamp >= TIMESTAMP('2026-04-01 00:00:00')");
    }
  });

  it("fails the run when the check itself cannot run, rather than reading as clean", async () => {
    const real = sim.query.bind(sim);
    sim.query = async (req) => {
      if (/ingestion_run_id = @runId/.test(req.query)) throw new Error("simulated BigQuery error");
      return real(req);
    };

    const result = await run();

    const failed = result.summary.units.filter((u) => u.detail.startsWith("DUPLICATE_CHECK_FAILED"));
    expect(failed.length).toBe(2);
    expect(captureExitCodeFor(result.summary)).not.toBe(0);
  });
});

describe("the duplicate check after a backfill or a repair", () => {
  it("RED: fails a backfill the same way it fails a daily run", async () => {
    seedTwinAt("2026-04-15T00:00:00.000Z");

    const result = await run("backfill");

    expect(duplicateUnits(result).length).toBe(1);
    expect(captureExitCodeFor(result.summary)).not.toBe(0);
  });

  it("splits a three-month backfill into one statement per month, and still finds the twin", async () => {
    reader(ADDRESS, [BLOCK_TS, JULY_TS, AUGUST_TS]);
    seedTwinAt("2026-04-15T00:00:00.000Z");

    const result = await run("backfill");

    const own = reportsFor(RAW_LOGS_TABLE)
      .map((s) => /W\.block_timestamp >= TIMESTAMP\('([^']+)'\)/.exec(s.sql)![1]);
    expect(own).toEqual(["2026-06-01 00:00:00", "2026-07-01 00:00:00", "2026-08-01 00:00:00"]);
    // No single statement reaches further than one month's twin window.
    for (const s of reportsFor(RAW_LOGS_TABLE)) {
      const [, from, to] = /T\.block_timestamp >= TIMESTAMP\('([^']+)'\) AND T\.block_timestamp < TIMESTAMP\('([^']+)'\)/.exec(s.sql)!;
      const months = (Date.parse(to + "Z") - Date.parse(from + "Z")) / (86_400_000 * 30.4);
      expect(Math.round(months)).toBe(5);
    }
    expect(duplicateUnits(result).length).toBe(1);
    expect(duplicateUnits(result)[0].detail).toContain("1 phantom row(s)");
  });

  describe("repair", () => {
    const ethereum = NETWORKS.ETHEREUM;
    const target = () => targetsFor(ethereum, {})[0];

    /** An incomplete capture over 1000..1010, which is a gap repair will re-read. */
    function seedGap(address: string): void {
      sim.defineTable("IngestionCoverage", [], [{
        capture_id: "seed", run_id: "seed", chain_id: ethereum.chainId, target_table: RAW_LOGS_TABLE,
        contract_address: address, from_block: 1_000, to_block: 1_010, status: "incomplete",
        skipped_ranges: "[]", started_at: "2026-06-01T00:00:00.000Z",
      }]);
    }

    const repair = (address: string) => runRepair({
      mode: "repair", chains: ["ETHEREUM"], addresses: [address],
    });

    it("RED: a repair whose re-read duplicates a key does not report clean", async () => {
      const address = target().address.toLowerCase();
      seedGap(address);
      reader(address, [BLOCK_TS]);
      seedTwinAt("2026-04-15T00:00:00.000Z", ethereum.chainId);

      expect(await repair(address)).toBe(false);
      expect(reportsFor(RAW_LOGS_TABLE).length).toBe(1);
    });

    it("GREEN: the same repair with no twin reports clean", async () => {
      const address = target().address.toLowerCase();
      seedGap(address);
      reader(address, [BLOCK_TS]);

      expect(await repair(address)).toBe(true);
      expect(reportsFor(RAW_LOGS_TABLE).length).toBe(1);
    });
  });
});

describe("the bound of the lookup window", () => {
  it("leaves a twin beyond the window to the full-history scan, which finds it", async () => {
    // March: outside the twin window as well. The range check is blind here by design.
    seedTwinAt("2026-03-15T00:00:00.000Z");

    const result = await run();
    expect(duplicateUnits(result)).toEqual([]);

    const full = await duplicateReport(RAW_LOGS_TABLE, XDC_CHAIN_ID);
    expect(full.phantomRows, "the manual full-history path must still see it").toBe(1);
  });

  it("is twice the merge padding around the written rows, and never narrower than two months", () => {
    const written = windowForRows([{ block_timestamp: "2026-06-09T10:13:20Z" }], 1)!;
    expect(written.fromTs).toBe("2026-05-01 00:00:00");

    const twin = twinWindowFor(written);
    expect(twin.fromTs).toBe("2026-04-01 00:00:00");
    expect(twin.toTs).toBe("2026-09-01 00:00:00");

    // A padding of zero would collapse the lookup onto the MERGE window, which cannot see the twin.
    const unpadded = twinWindowFor(windowForRows([{ block_timestamp: "2026-06-09T10:13:20Z" }], 0)!);
    expect(unpadded.fromTs).toBe("2026-04-01 00:00:00");
  });

  it("slices a span into calendar months that together hold every written row exactly once", () => {
    const w = windowForRows([
      { block_timestamp: "2026-06-09T10:13:20Z" },
      { block_timestamp: "2026-08-20T00:00:00Z" },
    ], 1)!;

    const slices = monthSlices(w);
    expect(slices.map((s) => [s.sourceMinTs, s.sourceMaxTs])).toEqual([
      ["2026-06-09 10:13:20", "2026-06-30 23:59:59"],
      ["2026-07-01 00:00:00", "2026-07-31 23:59:59"],
      ["2026-08-01 00:00:00", "2026-08-20 00:00:00"],
    ]);
    expect(slices.every((s) => s.paddingMonths === 1)).toBe(true);
    expect(monthSlices(windowForRows([{ block_timestamp: "2026-06-09T10:13:20Z" }], 1)!).length).toBe(1);
  });
});
