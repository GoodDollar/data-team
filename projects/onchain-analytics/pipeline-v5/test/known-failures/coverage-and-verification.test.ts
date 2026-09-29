/**
 * KNOWN FAILURE: coverage and verification report clean when they have not looked.
 *
 *   H3  Coverage and repair miss unrecorded internal holes.
 *       Owner: Phase 4 (coverage and verification agent). Matrix: "Interval property tests".
 *   H5  Transaction coverage can say complete while transactions are missing.
 *       Owner: Phase 4. Matrix: "Missing-transaction integration test".
 *   C4  Verification returns success when nothing was verified.
 *       Owner: Phase 4. Matrix: "Structured oracle outcome tests".
 *
 * RECEIPTS THESE ENCODE, from `specs/system/readiness-audit-2026-09-25.md`.
 *
 *   H3 synthetic receipt, verbatim from the audit: clean captures 100..199 and 300..399, expected
 *   open gap 200..299, `openGaps` result empty, `computeResumePoint` result resume at 199.
 *
 *   H5: `missingTransactionCount` exists at `rawrow.ts:283`; the pipeline records the number in an
 *   error message but assigns the SAME overall status to the Transactions coverage row. Coverage
 *   and repair modes inspect only RawLogs.
 *
 *   C4 runtime receipts: `verify` on Ethereum printed that no contract oracle exists and nothing
 *   can be checked, then recorded one success and exited 0.
 *
 * H3 and C4 need no simulation at all: they are pure functions and a pure control path. H5 uses
 * the reader seam to deliver one chunk whose logs point at a transaction the reader did not
 * return, which is the exact shape an index produces when it omits one.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openGaps, computeResumePoint } from "../../src/coverage.js";
import { runPipeline } from "../../src/pipeline.js";
import { runVerify } from "../../src/reconcile.js";
import { readOnlyExitCode } from "../../src/outcome.js";
import { missingTransactionCount } from "../../src/rawrow.js";
import { setBigQueryClient, setReaderOverride, resetAdapters } from "../../src/adapters.js";
import { BigQuerySimulator } from "../helpers/bq-simulator.js";
import { interval, hash32, RAW_LOGS_COLUMNS, TRANSACTIONS_COLUMNS } from "../helpers/fixtures.js";

let sim: BigQuerySimulator;

beforeEach(() => {
  sim = new BigQuerySimulator();
  sim.defineTable("RawLogs", RAW_LOGS_COLUMNS, []);
  sim.defineTable("Transactions", TRANSACTIONS_COLUMNS, []);
  setBigQueryClient(sim);
});

afterEach(() => resetAdapters());

describe("H3: an internal hole between two clean captures is invisible", () => {
  const captures = [interval(100, 199), interval(300, 399)];

  it("reports the uncovered range 200..299 as an open gap", () => {
    const gaps = openGaps(captures);

    expect(
      gaps,
      `H3 reproduced: openGaps() returned ${JSON.stringify(gaps)} for clean captures 100..199 and ` +
      `300..399, which leaves 200..299 read by nobody and reported by nothing. ` +
      `pipeline-v5/src/coverage.ts openGaps() builds its candidate list only from captures that ` +
      `are NOT complete and from their recorded skipped ranges, so a hole that no failed capture ` +
      `ever described cannot enter the list. The coverage command therefore prints clean and ` +
      `repair has nothing to act on. Owner: Phase 4.`
    ).toEqual([[200, 299]]);
  });

  it("does not resume above a hole it never recorded", () => {
    const resume = computeResumePoint(captures, 100);

    // Resuming at 199 is not wrong on its own: the next ordinary run eventually heals the hole
    // because the frontier stays below it. What is wrong is that `coveredUpTo` reports 199 while
    // 300..399 is also held, so the two diagnostic modes disagree with the table.
    expect(
      resume.coveredUpTo,
      `H3, second half: computeResumePoint() reports coveredUpTo ${resume.coveredUpTo} while a ` +
      `clean capture of 300..399 also exists. Neither the resume point nor openGaps() mentions ` +
      `200..299 anywhere, so no output of this module names the hole. Owner: Phase 4.`
    ).toBe(199);
    expect(
      openGaps(captures).length,
      `H3, same case from the repair side: coveredUpTo is 199 and openGaps() is empty, so the two ` +
      `diagnostic modes agree with each other and both disagree with the table, which holds ` +
      `300..399 as well. Neither output names 200..299. Owner: Phase 4.`
    ).toBeGreaterThan(0);
  });
});

describe("H5: a missing transaction leaves the transaction grain complete", () => {
  /**
   * One chunk, two logs, two distinct transaction hashes, and only ONE transaction returned.
   * `missingTransactionCount` sees it. Nothing acts on it.
   */
  const chunkWithMissingTx = {
    fromBlock: 1_000, toBlock: 1_010, ok: true,
    logs: [
      {
        blockNumber: 1_000, blockHash: hash32("bh1"), transactionHash: hash32("tx1"),
        transactionIndex: 0, logIndex: 0, address: "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf",
        data: "0x", topics: [hash32("t0")], removed: false,
      },
      {
        blockNumber: 1_001, blockHash: hash32("bh2"), transactionHash: hash32("tx2"),
        transactionIndex: 0, logIndex: 0, address: "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf",
        data: "0x", topics: [hash32("t0")], removed: false,
      },
    ],
    transactions: [
      {
        hash: hash32("tx1"), blockNumber: 1_000, blockHash: hash32("bh1"), transactionIndex: 0,
        from: "0x0000000000000000000000000000000000000001", to: null, value: "0", nonce: "0",
        gas: "21000", gasUsed: "21000", effectiveGasPrice: "1", input: "0x", kind: 2, status: 1,
        contractAddress: null,
      },
    ],
    blocks: [
      { number: 1_000, hash: hash32("bh1"), timestamp: 1_781_000_000 },
      { number: 1_001, hash: hash32("bh2"), timestamp: 1_781_000_005 },
    ],
    nextBlock: 1_011, archiveHeight: 2_000, rollbackGuard: null,
    sourceKind: "index" as const, sourceId: "hypersync:xdc", attempts: [], ms: 0,
  };

  it("the detector itself works, which is what makes the silence a choice", () => {
    expect(missingTransactionCount(chunkWithMissingTx as any, 1)).toBe(1);
  });

  it("marks the Transactions coverage row incomplete when a transaction is missing", async () => {
    setReaderOverride(async (_n, _a, from, to, onChunk) => {
      await onChunk(chunkWithMissingTx as any);
      return {
        fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1,
        skipped: [], errors: [], emptyChunks: [], logsSeen: 2, complete: true,
        sourceKind: "index", sourceId: "hypersync:xdc", enumeratingSources: 1,
        headAtCapture: 2_000, rollbackGuards: [],
      };
    });

    await runPipeline({
      mode: "backfill",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
      fromBlock: 1_000,
      toBlock: 1_010,
    });

    const coverage = sim.tables.get("IngestionCoverage")?.rows ?? [];
    const txRow = coverage.find((r) => r.target_table === "Transactions");

    expect(txRow, "precondition: a Transactions coverage row must exist").toBeDefined();
    expect(
      txRow?.status,
      `H5 reproduced: the reader returned 2 logs pointing at 2 transactions and produced only 1, ` +
      `and the Transactions coverage row status is "${txRow?.status}" with the count relegated to ` +
      `error_message "${txRow?.error_message}". pipeline-v5/src/pipeline.ts assigns the RawLogs ` +
      `status to the Transactions row verbatim, so the transaction grain inherits a completeness ` +
      `judgement made about a different grain. Owner: Phase 4.`
    ).not.toBe("complete");
  });

  it("exits nonzero when a grain is incomplete", async () => {
    setReaderOverride(async (_n, _a, from, to, onChunk) => {
      await onChunk(chunkWithMissingTx as any);
      return {
        fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1,
        skipped: [], errors: [], emptyChunks: [], logsSeen: 2, complete: true,
        sourceKind: "index", sourceId: "hypersync:xdc", enumeratingSources: 1,
        headAtCapture: 2_000, rollbackGuards: [],
      };
    });

    const result = await runPipeline({
      mode: "backfill",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
      fromBlock: 1_000,
      toBlock: 1_010,
    });

    expect(
      result.failed,
      `H5, second half: ${result.succeeded} capture(s) succeeded and ${result.failed} failed after ` +
      `a transaction went missing, so the run exits 0. Nothing in the capture path raises on a ` +
      `missing transaction; it is appended to a notes list. Owner: Phase 4.`
    ).toBeGreaterThan(0);
  });
});

describe("C4: verification reports success when nothing was compared", () => {
  it("does not return clean for a chain that has no oracle at all", async () => {
    // Ethereum is IN the frozen release scope and has no contract oracle, so this is the exact
    // shape the audit ran: a chain the run is allowed to touch, where nothing can be compared.
    // The audit got exit 0. No network or warehouse call happens on this path.
    const report = await runVerify({ mode: "verify", chains: ["ETHEREUM"] });

    expect(
      report.comparedUnits,
      `C4: runVerify() compared ${report.comparedUnits} unit(s) on a chain with zero oracles. ` +
      `Nothing can be compared here, so this must be 0 and the run must not be clean.`
    ).toBe(0);

    expect(
      report.outcome,
      `C4: runVerify() reported outcome '${report.outcome}' for a chain with zero oracles. ` +
      `"nothing could be checked" and "everything checked out" must not be the same value: ` +
      `the return type carries what was compared, and clean requires comparedUnits > 0.`
    ).toBe("nothing_to_check");

    expect(
      readOnlyExitCode(report.outcome),
      `C4: the CLI would exit ${readOnlyExitCode(report.outcome)} for a run that compared nothing. ` +
      `A verification with no report is exit 2, not exit 0, and not the exit 1 that means a real ` +
      `finding was produced.`
    ).toBe(2);

    // The report says WHICH chains had no oracle, so a reader is told what was not checked
    // rather than left to infer it from a missing line.
    expect(report.chainsWithNoOracle).toContain("ETHEREUM");
    expect(report.oraclesSelected).toBe(0);
  });
});
