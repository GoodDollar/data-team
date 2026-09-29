/**
 * Reader policy: batched capture, evidence grading, measured finality, and the rollback frontier.
 *
 * These cover the four defects this unit closed plus the two it was handed with no pinned test,
 * `C6` and `H2`. Each one asserts the PROPERTY rather than the implementation, so a later rewrite
 * that keeps the property keeps the test.
 *
 * The batching tests are the ones to read first. Closing `H2` naively -- widening the address
 * list and nothing else -- trades a cost defect for a coverage defect, and a wrong coverage row
 * is the more expensive of the two because a bill is visible and a silently wrong ledger is not.
 */

import { describe, it, expect, afterEach } from "vitest";
import { pinBlock } from "../../src/oracle.js";
import { probeLogsPresent, confirmEmptyRange, MIN_INDEPENDENT_ENDPOINTS } from "../../src/rpc.js";
import { projectChunk, projectFetchResult, unionRange, overlaps } from "../../src/batch.js";
import { runPipeline } from "../../src/pipeline.js";
import { computeResumePoint } from "../../src/coverage.js";
import { NETWORKS } from "../../src/config.js";
import { setRpcTransport, setBigQueryClient, setReaderOverride, resetAdapters } from "../../src/adapters.js";
import { makeWireRecorder } from "../helpers/wire-recorder.js";
import { BigQuerySimulator } from "../helpers/bq-simulator.js";
import { RAW_LOGS_COLUMNS, TRANSACTIONS_COLUMNS, hash32, interval } from "../helpers/fixtures.js";
import type { ChunkResult, FetchResult } from "../../src/types.js";

const CELO = NETWORKS.CELO;
const XDC = NETWORKS.XDC;
const FUSE = NETWORKS.FUSE;

/** Two real XDC contracts from the shipped seed, with genuinely different creation blocks. */
const AVATAR = "0x21eac3fe218307bee0463f77ebca3b50f452c0ce";
const BULK_WHITELIST = "0xe8861a20452db53df685f1d9e6b7017de3db0e46";

afterEach(() => resetAdapters());

// ---------------------------------------------------------------------------------------------
// The projection. Pure, so the attribution rules can be asserted exactly rather than inferred
// from a warehouse afterwards.
// ---------------------------------------------------------------------------------------------

function chunk(o: Partial<ChunkResult> = {}): ChunkResult {
  return {
    fromBlock: 1_000, toBlock: 1_999, ok: true,
    logs: [], transactions: [], blocks: [],
    nextBlock: 2_000, archiveHeight: 9_999, rollbackGuard: null,
    sourceKind: "index", sourceId: "hypersync:xdc", attempts: [], ms: 1,
    ...o,
  };
}

function logOf(address: string, blockNumber: number, txSeed: string): any {
  return {
    blockNumber, blockHash: hash32(`b${blockNumber}`), transactionHash: hash32(txSeed),
    transactionIndex: 0, logIndex: 0, address, data: "0x", topics: [hash32("t0")], removed: false,
  };
}

function fetchOf(o: Partial<FetchResult> = {}): FetchResult {
  return {
    fromBlock: 1_000, toBlock: 3_999, chunksPlanned: 3, chunksOk: 3,
    skipped: [], errors: [], emptyChunks: [], logsSeen: 0, complete: true,
    sourceKind: "index", sourceId: "hypersync:xdc", enumeratingSources: 1,
    headAtCapture: 9_999, rollbackGuards: [],
    ...o,
  };
}

describe("H2: one batched read is projected back onto each contract", () => {
  it("gives a contract only the logs its own address emitted", () => {
    const batched = chunk({
      logs: [logOf(AVATAR, 1_100, "ta"), logOf(BULK_WHITELIST, 1_200, "tb"), logOf(AVATAR, 1_300, "tc")],
    });

    const mine = projectChunk(batched, { address: AVATAR, fromBlock: 1_000, toBlock: 1_999 });

    expect(mine.logs).toHaveLength(2);
    expect(mine.logs.every((l) => l.address === AVATAR)).toBe(true);
  });

  it("gives a contract only the blocks its own logs are in", () => {
    const batched = chunk({
      logs: [logOf(AVATAR, 1_100, "ta"), logOf(BULK_WHITELIST, 1_200, "tb")],
      blocks: [
        { number: 1_100, hash: hash32("b1100"), timestamp: 1_781_000_000 },
        { number: 1_200, hash: hash32("b1200"), timestamp: 1_781_000_100 },
      ],
    });

    const mine = projectChunk(batched, { address: AVATAR, fromBlock: 1_000, toBlock: 1_999 });

    expect(mine.blocks.map((b) => b.number)).toEqual([1_100]);
  });

  it("gives a contract only the transactions its own logs point at", () => {
    // The Transactions grain is defined as one row per transaction that produced at least one
    // CAPTURED log. Copying the batch's transactions onto every member would make that definition
    // false for every member but the one that emitted them.
    const batched = chunk({
      logs: [logOf(AVATAR, 1_100, "ta"), logOf(BULK_WHITELIST, 1_200, "tb")],
      transactions: [{ hash: hash32("ta"), blockNumber: 1_100 }, { hash: hash32("tb"), blockNumber: 1_200 }],
    });

    const mine = projectChunk(batched, { address: AVATAR, fromBlock: 1_000, toBlock: 1_999 });

    expect(mine.transactions).toHaveLength(1);
    expect(mine.transactions[0].hash).toBe(hash32("ta"));
  });

  it("withholds a log below the contract's own declared start", () => {
    // The batched range is the UNION of the group, so a contract created later is read over
    // blocks it never asked about. Attributing one of those to it would put a row in the table
    // under a capture whose coverage row says that range was never read for it.
    const batched = chunk({ logs: [logOf(BULK_WHITELIST, 1_100, "early")] });

    const mine = projectChunk(batched, { address: BULK_WHITELIST, fromBlock: 1_500, toBlock: 1_999 });

    expect(mine.logs).toHaveLength(0);
  });

  it("matches the address case-insensitively, because a reader may return either spelling", () => {
    const batched = chunk({ logs: [logOf(AVATAR.toUpperCase().replace("0X", "0x"), 1_100, "ta")] });

    const mine = projectChunk(batched, { address: AVATAR, fromBlock: 1_000, toBlock: 1_999 });

    expect(mine.logs).toHaveLength(1);
  });

  it("reads the union of the group's ranges, not one range per contract", () => {
    expect(unionRange([
      { address: AVATAR, fromBlock: 500, toBlock: 900 },
      { address: BULK_WHITELIST, fromBlock: 700, toBlock: 1_400 },
    ])).toEqual({ fromBlock: 500, toBlock: 1_400 });
  });

  it("returns null for an empty group rather than an impossible range", () => {
    expect(unionRange([])).toBeNull();
  });
});

describe("H2: batching must not cost per-contract error attribution", () => {
  const chunkRanges: [number, number][] = [[1_000, 1_999], [2_000, 2_999], [3_000, 3_999]];

  it("attributes a failed chunk ONLY to the contracts whose range it overlaps", () => {
    const fetch = fetchOf({
      skipped: [[3_000, 3_999]],
      errors: ["chunk 3000..3999: every endpoint failed"],
      complete: false,
    });

    const early = projectFetchResult(
      fetch, { address: AVATAR, fromBlock: 1_000, toBlock: 2_999 }, chunkRanges,
      { logsSeen: 4, emptyChunks: [] });
    const late = projectFetchResult(
      fetch, { address: BULK_WHITELIST, fromBlock: 3_000, toBlock: 3_999 }, chunkRanges,
      { logsSeen: 0, emptyChunks: [[3_000, 3_999]] });

    expect(early.complete, "a failure outside a contract's range does not make it incomplete").toBe(true);
    expect(early.skipped).toEqual([]);
    expect(early.errors).toEqual([]);

    expect(late.complete, "a failure inside a contract's range is not excused by another's success").toBe(false);
    expect(late.skipped).toEqual([[3_000, 3_999]]);
    expect(late.errors).toHaveLength(1);
  });

  it("counts only the chunks that overlap a contract as planned for it", () => {
    const one = projectFetchResult(
      fetchOf(), { address: AVATAR, fromBlock: 1_000, toBlock: 1_999 }, chunkRanges,
      { logsSeen: 0, emptyChunks: [] });

    expect(one.chunksPlanned, "a contract created late did not have the whole chain's chunks planned for it").toBe(1);
    expect(one.chunksOk).toBe(1);
  });

  it("clips a skipped range to the contract's own interval", () => {
    // A skip recorded outside the contract's range reads downstream as a hole in ground the
    // contract never claimed to cover.
    const projected = projectFetchResult(
      fetchOf({ skipped: [[1_000, 3_999]], complete: false }),
      { address: AVATAR, fromBlock: 2_500, toBlock: 3_200 }, chunkRanges,
      { logsSeen: 0, emptyChunks: [] });

    expect(projected.skipped).toEqual([[2_500, 3_200]]);
  });

  it("keeps an error that names no range, rather than dropping it silently", () => {
    // An error count that reaches zero because an error could not be attributed is the exact
    // shape this project keeps finding: an absence produced by the instrument, not the chain.
    const projected = projectFetchResult(
      fetchOf({ errors: ["HS_SPAWN failed, no range known"] }),
      { address: AVATAR, fromBlock: 1_000, toBlock: 1_999 }, chunkRanges,
      { logsSeen: 0, emptyChunks: [] });

    expect(projected.errors).toEqual(["HS_SPAWN failed, no range known"]);
  });

  it("carries a rollback guard to every contract, because it is a fact about the chain", () => {
    const guard = {
      blockNumber: 900, timestamp: 0, hash: hash32("rbg"),
      firstBlockNumber: 900, firstParentHash: hash32("rbp"),
    };
    const projected = projectFetchResult(
      fetchOf({ rollbackGuards: [guard] }),
      { address: AVATAR, fromBlock: 1_000, toBlock: 1_999 }, chunkRanges,
      { logsSeen: 0, emptyChunks: [] });

    expect(projected.rollbackGuards).toEqual([guard]);
  });

  it("takes logsSeen and emptyChunks per contract, never from the batch", () => {
    // A batched chunk full of another contract's logs is not empty for the batch and IS empty for
    // this contract, and it is this contract that has to confirm that negative.
    const projected = projectFetchResult(
      fetchOf({ logsSeen: 40 }),
      { address: AVATAR, fromBlock: 1_000, toBlock: 1_999 }, chunkRanges,
      { logsSeen: 0, emptyChunks: [[1_000, 1_999]] });

    expect(projected.logsSeen).toBe(0);
    expect(projected.emptyChunks).toEqual([[1_000, 1_999]]);
  });

  it("treats touching intervals as overlapping and disjoint ones as not", () => {
    expect(overlaps(100, 200, 200, 300)).toBe(true);
    expect(overlaps(100, 200, 201, 300)).toBe(false);
  });
});

describe("H2: the pipeline issues ONE read for a chain, not one per contract", () => {
  function simulator() {
    const sim = new BigQuerySimulator();
    sim.defineTable("RawLogs", RAW_LOGS_COLUMNS, []);
    sim.defineTable("Transactions", TRANSACTIONS_COLUMNS, []);
    setBigQueryClient(sim);
    return sim;
  }

  it("calls the reader once with every address, and writes a coverage row per contract", async () => {
    const reads: { addresses: string[]; from: number; to: number }[] = [];
    setReaderOverride(async (_n, addresses, from, to, onChunk) => {
      reads.push({ addresses: [...addresses], from, to });
      await onChunk(chunk({
        fromBlock: from, toBlock: to,
        logs: [logOf(AVATAR, from, "ta")],
        transactions: [{
          hash: hash32("ta"), blockNumber: from, blockHash: hash32(`b${from}`), transactionIndex: 0,
          from: "0x0000000000000000000000000000000000000001", to: null, value: "0", nonce: "0",
          gas: "21000", gasUsed: "21000", effectiveGasPrice: "1", input: "0x", kind: 2,
          status: 1, contractAddress: null,
        }],
        blocks: [{ number: from, hash: hash32(`b${from}`), timestamp: 1_781_000_000 }],
        archiveHeight: to + 100,
      }));
      return fetchOf({
        fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1, logsSeen: 1,
        headAtCapture: to + 100,
      });
    });
    const sim = simulator();

    await runPipeline({
      mode: "backfill", chains: ["XDC"], addresses: [AVATAR, BULK_WHITELIST],
      fromBlock: 100_000_000, toBlock: 100_000_010,
    });

    expect(reads, "two contracts must produce ONE read, which is the whole of H2").toHaveLength(1);
    expect(reads[0].addresses.map((a) => a.toLowerCase()).sort())
      .toEqual([AVATAR, BULK_WHITELIST].sort());

    const coverage = sim.tables.get("IngestionCoverage")?.rows ?? [];
    const rawRows = coverage.filter((r) => r.target_table === "RawLogs");
    expect(rawRows.map((r) => r.contract_address).sort(), "one RawLogs coverage row per contract")
      .toEqual([AVATAR, BULK_WHITELIST].sort());
    expect(coverage.filter((r) => r.target_table === "Transactions"))
      .toHaveLength(2);
  });

  it("gives the emitting contract the rows and the other one an honest zero", async () => {
    // Both contracts were read. Only one emitted. The other's coverage row must say it was read
    // and found nothing, which is a different fact from not having been read at all.
    setReaderOverride(async (_n, _a, from, to, onChunk) => {
      await onChunk(chunk({
        fromBlock: from, toBlock: to,
        logs: [logOf(AVATAR, from, "ta")],
        transactions: [{
          hash: hash32("ta"), blockNumber: from, blockHash: hash32(`b${from}`), transactionIndex: 0,
          from: "0x0000000000000000000000000000000000000001", to: null, value: "0", nonce: "0",
          gas: "21000", gasUsed: "21000", effectiveGasPrice: "1", input: "0x", kind: 2,
          status: 1, contractAddress: null,
        }],
        blocks: [{ number: from, hash: hash32(`b${from}`), timestamp: 1_781_000_000 }],
        archiveHeight: to + 100,
      }));
      return fetchOf({
        fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1, logsSeen: 1,
        headAtCapture: to + 100,
      });
    });
    const sim = simulator();

    await runPipeline({
      mode: "backfill", chains: ["XDC"], addresses: [AVATAR, BULK_WHITELIST],
      fromBlock: 100_000_000, toBlock: 100_000_010,
    });

    const coverage = sim.tables.get("IngestionCoverage")?.rows ?? [];
    const avatar = coverage.find((r) => r.target_table === "RawLogs" && r.contract_address === AVATAR);
    const other = coverage.find((r) => r.target_table === "RawLogs" && r.contract_address === BULK_WHITELIST);

    expect(Number(avatar?.logs_seen)).toBe(1);
    expect(Number(avatar?.rows_inserted)).toBe(1);
    expect(Number(other?.logs_seen), "the batch's logs must not leak onto a contract that emitted none").toBe(0);
    expect(Number(other?.rows_inserted)).toBe(0);

    const written = sim.tables.get("RawLogs")?.rows ?? [];
    expect(written.map((r) => r.contract_address)).toEqual([AVATAR]);
  });

  it("records the failure against every contract when the batched read fails outright", async () => {
    // The read covered them all, so it failed for them all. Recording it against only whichever
    // contract was being written when it threw leaves the rest with rows in the table and nothing
    // saying anybody looked, which is the one state the coverage ledger exists to prevent.
    setReaderOverride(async () => { throw new Error("HS_SPAWN simulated"); });
    const sim = simulator();

    const result = await runPipeline({
      mode: "backfill", chains: ["XDC"], addresses: [AVATAR, BULK_WHITELIST],
      fromBlock: 100_000_000, toBlock: 100_000_010,
    });

    const coverage = sim.tables.get("IngestionCoverage")?.rows ?? [];
    const failed = coverage.filter((r) => r.target_table === "RawLogs" && r.status === "incomplete");
    expect(failed.map((r) => r.contract_address).sort()).toEqual([AVATAR, BULK_WHITELIST].sort());
    expect(result.failed, "a failed batch must reach the exit code once per contract").toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------
// SA-C8, the pin margin.
// ---------------------------------------------------------------------------------------------

describe("SA-C8: the pin margin comes from the chain's own measurement", () => {
  function headRecorder(head: number) {
    const recorder = makeWireRecorder({ answers: { eth_blockNumber: "0x" + head.toString(16) } });
    setRpcTransport(recorder.transport);
    return recorder;
  }

  it("uses each chain's measured finality, so two chains pin differently", async () => {
    const head = 40_000_000;
    headRecorder(head);

    const celo = await pinBlock(CELO);
    const xdc = await pinBlock(XDC);

    expect(head - (celo.value ?? head)).toBe(CELO.finality.blocks);
    expect(head - (xdc.value ?? head)).toBe(XDC.finality.blocks);
    expect(CELO.finality.blocks).not.toBe(XDC.finality.blocks);
  });

  it("refuses a caller's margin that is NARROWER than the measurement, and says so", async () => {
    const head = 40_000_000;
    headRecorder(head);

    const pin = await pinBlock(CELO, 5);

    expect(head - (pin.value ?? head), "a 5-block pin on Celo sits inside the reorg window")
      .toBe(CELO.finality.blocks);
    expect(pin.errors.join(" ")).toContain("inside CELO's measured finality");
  });

  it("honours a caller's margin that is WIDER, because further behind head is always safe", async () => {
    const head = 40_000_000;
    headRecorder(head);

    const pin = await pinBlock(CELO, CELO.finality.blocks + 1_000);

    expect(head - (pin.value ?? head)).toBe(CELO.finality.blocks + 1_000);
  });
});

// ---------------------------------------------------------------------------------------------
// SA-C8 and C6, the reader's evidence.
// ---------------------------------------------------------------------------------------------

describe("SA-C8 and C6: a log scan's answer carries what it is worth as evidence", () => {
  const ADDR = "0x" + "11".repeat(20);

  it("confirms an empty range when two independent endpoints each cover it and find nothing", async () => {
    // The fix is not "always refuse". Genuine corroboration still confirms, which is what keeps
    // an honest empty range from blocking the frontier forever.
    setRpcTransport(makeWireRecorder({ answers: { eth_getLogs: [] } }).transport);

    const result = await confirmEmptyRange(FUSE, [ADDR], 1_000, 1_100);

    expect(FUSE.readers.rpcUrls.length).toBeGreaterThanOrEqual(MIN_INDEPENDENT_ENDPOINTS);
    expect(result.confirmed).toBe(true);
    expect(result.evidence.grade).toBe("corroborated_absence");
  });

  it("never renders a sentence claiming more sources than answered", async () => {
    setRpcTransport(makeWireRecorder({
      answers: { eth_getLogs: [] },
      failWith: { "https://fuse.liquify.com": 500 },
    }).transport);

    const result = await confirmEmptyRange(FUSE, [ADDR], 1_000, 1_100);

    expect(result.reason).not.toContain("two sources agree");
    expect(result.reason).toContain("1 of 2 endpoint(s)");
  });

  it("still refuses to call a corroborated absence ADMISSIBLE, because R7 admits no exception", async () => {
    setRpcTransport(makeWireRecorder({ answers: { eth_getLogs: [] } }).transport);

    const result = await confirmEmptyRange(FUSE, [ADDR], 1_000, 1_100);

    expect(result.confirmed).toBe(true);
    expect(result.evidence.admissibleAsAbsence).toBe(false);
    expect(result.evidence.admissibleAsRefutation).toBe(false);
  });

  it("grades a find as a refutation, which is the one claim a log scan can support", async () => {
    setRpcTransport(makeWireRecorder({
      answers: { eth_getLogs: [logOf(ADDR, 1_050, "found")] },
    }).transport);

    const result = await confirmEmptyRange(FUSE, [ADDR], 1_000, 1_100);

    expect(result.confirmed).toBe(false);
    expect(result.evidence.grade).toBe("refutation");
    expect(result.evidence.admissibleAsRefutation).toBe(true);
    expect(result.reason).toContain("REFUTED");
  });

  it("grades a range no endpoint could cover as no clean answer, not as an absence", async () => {
    setRpcTransport(makeWireRecorder({
      answers: { eth_getLogs: [] },
      failWith: { "https://rpc.fuse.io": 500, "https://fuse.liquify.com": 500 },
    }).transport);

    const result = await confirmEmptyRange(FUSE, [ADDR], 1_000, 1_100);

    expect(result.evidence.grade).toBe("no_clean_answer");
    expect(result.evidence.cleanEndpoints).toBe(0);
  });
});

describe("SA-C8: an endpoint answering zero is distinguishable from one answering with rows", () => {
  const ADDR = "0x" + "11".repeat(20);

  it("counts zero answers per endpoint, separately from that endpoint's failures", async () => {
    // The old tally was { found, failures } summed across endpoints, in which an endpoint
    // answering zero and one answering with rows are the same reading. That is the exact signal a
    // false zero produces, so it was the one signal the tally could not carry.
    setRpcTransport(makeWireRecorder({
      answers: {
        eth_getLogs: (_p: unknown[], url: string) =>
          url === "https://rpc.fuse.io" ? [logOf(ADDR, 1_050, "real")] : [],
      },
    }).transport);

    const probe = await probeLogsPresent(FUSE, [ADDR], 1_000, 1_100);

    const answering = probe.perEndpoint.find((e) => e.url === "https://rpc.fuse.io")!;
    const silent = probe.perEndpoint.find((e) => e.url === "https://fuse.liquify.com")!;

    expect(answering.nonZeroAnswers).toBe(1);
    expect(answering.zeroAnswers).toBe(0);
    expect(silent.zeroAnswers).toBe(1);
    expect(silent.nonZeroAnswers).toBe(0);
    expect(silent.failures, "a zero is an ANSWER and must never be counted as a failure").toBe(0);
  });

  it("names the endpoint whose zero is contradicted by another endpoint's find", async () => {
    setRpcTransport(makeWireRecorder({
      answers: {
        eth_getLogs: (_p: unknown[], url: string) =>
          url === "https://rpc.fuse.io" ? [logOf(ADDR, 1_050, "real")] : [],
      },
    }).transport);

    const probe = await probeLogsPresent(FUSE, [ADDR], 1_000, 1_100);

    expect(probe.falseZeroSuspects, "a false zero caught in the act is named, not averaged away")
      .toEqual(["https://fuse.liquify.com"]);
  });

  it("raises no suspect when every endpoint agrees the range is empty", async () => {
    setRpcTransport(makeWireRecorder({ answers: { eth_getLogs: [] } }).transport);

    const probe = await probeLogsPresent(FUSE, [ADDR], 1_000, 1_100);

    expect(probe.falseZeroSuspects).toEqual([]);
    expect(Object.values(probe.zeroLogAnswers)).toEqual([1, 1]);
  });

  it("keeps errors out of the zero tally entirely", async () => {
    setRpcTransport(makeWireRecorder({
      answers: { eth_getLogs: [] },
      failWith: { "https://fuse.liquify.com": 500 },
    }).transport);

    const probe = await probeLogsPresent(FUSE, [ADDR], 1_000, 1_100);

    const failing = probe.perEndpoint.find((e) => e.url === "https://fuse.liquify.com")!;
    expect(failing.failures).toBe(1);
    expect(failing.zeroAnswers, "an endpoint that errored did not answer zero").toBe(0);
  });
});

describe("C6: the grade travels to the ledger, not just to the call site that refused it", () => {
  it("writes the evidence grade and an honest confirmation label onto the coverage row", async () => {
    // A judgement made in a conditional is made only there. This is the consumer: the coverage
    // row carries both what the reader concluded and the grade it concluded it under, so a reader
    // of the warehouse can see WHY a range is not settled without re-running anything.
    setRpcTransport(makeWireRecorder({
      answers: { eth_getLogs: [], eth_blockNumber: "0x" + (100_000_500).toString(16) },
      failWith: { "https://xdc.public-rpc.com": 500, "https://rpc.xdcrpc.com": 500 },
    }).transport);
    setReaderOverride(async (_n, _a, from, to, onChunk) => {
      await onChunk(chunk({ fromBlock: from, toBlock: to, logs: [], archiveHeight: to + 100 }));
      return fetchOf({
        fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1, logsSeen: 0,
        emptyChunks: [[from, to]], headAtCapture: to + 100,
      });
    });
    const sim = new BigQuerySimulator();
    sim.defineTable("RawLogs", RAW_LOGS_COLUMNS, []);
    sim.defineTable("Transactions", TRANSACTIONS_COLUMNS, []);
    setBigQueryClient(sim);

    await runPipeline({
      mode: "backfill", chains: ["XDC"], addresses: [AVATAR],
      fromBlock: 100_000_000, toBlock: 100_000_010,
    });

    const row = (sim.tables.get("IngestionCoverage")?.rows ?? [])
      .find((r) => r.target_table === "RawLogs");

    expect(row?.confirmation_result).toBe("uncorroborated");
    expect(String(row?.error_message)).toContain("EVIDENCE_GRADES: single_source_absence");
    expect(row?.status, "an uncorroborated empty range is not settled ground").not.toBe("complete");
    expect(row?.assurance, "and it cannot be graded as confirmed").toBe("C");
  });
});

// ---------------------------------------------------------------------------------------------
// SA-C23a, the rollback frontier.
// ---------------------------------------------------------------------------------------------

describe("SA-C23a: a rollback guard holds the resume frontier, it does not just annotate it", () => {
  it("does not let the frontier move past a rollback-eligible capture", () => {
    // This is the half that matters. A status nothing reads is a note with a different name, and
    // `isClean` is the one thing that decides whether the next run looks at a range again.
    const resume = computeResumePoint(
      [interval(1_000, 1_999), interval(2_000, 2_999, { status: "rollback_eligible" })],
      1_000);

    expect(resume.resumeAt).toBe(1_999);
    expect(resume.coveredUpTo).toBe(1_999);
  });

  it("moves the frontier over the same range once the capture is clean", () => {
    // The discrimination: identical intervals, one status different, and the frontier moves.
    // Without this the first test would pass on a frontier that never moves at all.
    const resume = computeResumePoint(
      [interval(1_000, 1_999), interval(2_000, 2_999)],
      1_000);

    expect(resume.resumeAt).toBe(2_999);
  });

  it("records rollback_eligible rather than complete, and the reason with it", async () => {
    setReaderOverride(async (_n, _a, from, to, onChunk) => {
      await onChunk(chunk({
        fromBlock: from, toBlock: to,
        logs: [logOf(AVATAR, from, "ta")],
        transactions: [{
          hash: hash32("ta"), blockNumber: from, blockHash: hash32(`b${from}`), transactionIndex: 0,
          from: "0x0000000000000000000000000000000000000001", to: null, value: "0", nonce: "0",
          gas: "21000", gasUsed: "21000", effectiveGasPrice: "1", input: "0x", kind: 2,
          status: 1, contractAddress: null,
        }],
        blocks: [{ number: from, hash: hash32(`b${from}`), timestamp: 1_781_000_000 }],
        archiveHeight: to + 100,
      }));
      return fetchOf({
        fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1, logsSeen: 1,
        headAtCapture: to + 100,
        rollbackGuards: [{
          blockNumber: from - 10, timestamp: 0, hash: hash32("rbg"),
          firstBlockNumber: from - 10, firstParentHash: hash32("rbp"),
        }],
      });
    });
    const sim = new BigQuerySimulator();
    sim.defineTable("RawLogs", RAW_LOGS_COLUMNS, []);
    sim.defineTable("Transactions", TRANSACTIONS_COLUMNS, []);
    setBigQueryClient(sim);

    await runPipeline({
      mode: "backfill", chains: ["XDC"], addresses: [AVATAR],
      fromBlock: 100_000_000, toBlock: 100_000_010,
    });

    const rows = (sim.tables.get("IngestionCoverage")?.rows ?? [])
      .filter((r) => r.contract_address === AVATAR);

    expect(rows.map((r) => r.status)).toEqual(["rollback_eligible", "rollback_eligible"]);
    expect(String(rows[0].error_message)).toContain("ROLLBACK_GUARD");
  });

  it("leaves a guard that holds only settled blocks alone", async () => {
    // The discrimination for the status half: a guard whose first held block is ABOVE the
    // capture's start says nothing about this range, and must not hold it.
    setReaderOverride(async (_n, _a, from, to, onChunk) => {
      await onChunk(chunk({
        fromBlock: from, toBlock: to,
        logs: [logOf(AVATAR, from, "ta")],
        transactions: [{
          hash: hash32("ta"), blockNumber: from, blockHash: hash32(`b${from}`), transactionIndex: 0,
          from: "0x0000000000000000000000000000000000000001", to: null, value: "0", nonce: "0",
          gas: "21000", gasUsed: "21000", effectiveGasPrice: "1", input: "0x", kind: 2,
          status: 1, contractAddress: null,
        }],
        blocks: [{ number: from, hash: hash32(`b${from}`), timestamp: 1_781_000_000 }],
        archiveHeight: to + 100,
      }));
      return fetchOf({
        fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1, logsSeen: 1,
        headAtCapture: to + 100,
        rollbackGuards: [{
          blockNumber: to + 50, timestamp: 0, hash: hash32("rbg"),
          firstBlockNumber: to + 50, firstParentHash: hash32("rbp"),
        }],
      });
    });
    const sim = new BigQuerySimulator();
    sim.defineTable("RawLogs", RAW_LOGS_COLUMNS, []);
    sim.defineTable("Transactions", TRANSACTIONS_COLUMNS, []);
    setBigQueryClient(sim);

    await runPipeline({
      mode: "backfill", chains: ["XDC"], addresses: [AVATAR],
      fromBlock: 100_000_000, toBlock: 100_000_010,
    });

    const row = (sim.tables.get("IngestionCoverage")?.rows ?? [])
      .find((r) => r.target_table === "RawLogs");

    expect(row?.status).toBe("complete");
  });
});
