/**
 * KNOWN FAILURE: carried Stage A verification defects that survive in the shipping reader.
 *
 *   SA-C8  Skipped-gap undercount, uncalibrated convergence, and endpoint error counters.
 *          Owner: Phase 6. Matrix: "Full gap matrix, calibrated stopping and error counters".
 *   SA-C23a Wrong finality and a dropped HyperSync rollback guard.
 *          Owner: Phase 6. Matrix: "Per-chain finality policy and rollback-frontier test".
 *
 * READ THIS BEFORE JUDGING THE COUNT IN THIS FILE.
 *
 * Plan task 4 names six carried Stage A defects. They were established against the Stage A
 * verification library at `specs/_lib/lib.mjs`, and `PR 71` independently repaired most of the
 * same shapes inside `pipeline-v5` before this phase integrated it. Measured against the
 * integrated candidate, one by one:
 *
 *   ALREADY FIXED in the candidate, so they cannot be made red here and are kept as GREEN
 *   regression guards in `test/unit/reader-regression-guards.test.ts` instead:
 *     - a pinned `eth_getBlockByNumber` sending `latest` (reader.ts sends `hexBlock(bn)`)
 *     - `eth_getTransactionReceipt` receiving a second block parameter (reader.ts sends `[hash]`)
 *     - nine skipped chunks reported as three (rpcFetchRange pushes every skipped chunk)
 *     - uncalibrated five-pass zero-gain convergence (calibrate.ts derives k from a measured p,
 *       and the capture path uses no repetition rule at all)
 *     - a static Celo finality of 64 (config.ts carries the measured 1,930 with its source)
 *     - the worker dropping the rollback guard (hs-worker.mjs forwards it)
 *
 *   STILL PRESENT, and red below:
 *     - the five-block pin default, which ignores the measured per-chain finality beside it
 *     - one endpoint's clean pass reported as agreement between sources
 *     - no per-endpoint zero-log counter anywhere, so a false zero is invisible in the tally
 *     - a rollback guard that is read, written into a note, and changes no status
 *
 * That split is a finding, not a convenience, and it is reported to coordination as one.
 */

import { describe, it, expect, afterEach } from "vitest";
import { pinBlock } from "../../src/oracle.js";
import { probeLogsPresent, confirmEmptyRange } from "../../src/rpc.js";
import { runPipeline } from "../../src/pipeline.js";
import { NETWORKS } from "../../src/config.js";
import { setRpcTransport, setBigQueryClient, setReaderOverride, resetAdapters } from "../../src/adapters.js";
import { makeWireRecorder } from "../helpers/wire-recorder.js";
import { BigQuerySimulator } from "../helpers/bq-simulator.js";
import { RAW_LOGS_COLUMNS, TRANSACTIONS_COLUMNS, hash32 } from "../helpers/fixtures.js";

const CELO = NETWORKS.CELO;
const FUSE = NETWORKS.FUSE;

afterEach(() => resetAdapters());

describe("SA-C8: the pin margin ignores the measured finality beside it", () => {
  it("pins at least as far behind head as the chain's measured finality", async () => {
    const head = 40_000_000;
    const recorder = makeWireRecorder({
      answers: { eth_blockNumber: "0x" + head.toString(16) },
    });
    setRpcTransport(recorder.transport);

    const pin = await pinBlock(CELO);
    const margin = head - (pin.value ?? head);

    expect(
      margin,
      `SA-C8 reproduced (pin margin): pinBlock() pinned ${margin} block(s) behind head on ` +
      `${CELO.name}, whose finalized tag was measured 1,187 to 1,930 blocks behind head at one ` +
      `second per block. pipeline-v5/src/oracle.ts declares pinBlock(network, behind = 5) and ` +
      `never reads network.finality.blocks, which config.ts holds at ${CELO.finality.blocks} with ` +
      `its measurement recorded beside it. A pin inside the reorg window is not reproducible: the ` +
      `block it names can be replaced, and every reading taken at it silently changes meaning. ` +
      `The correct margin is per chain and already in the config. Owner: Phase 6.`
    ).toBeGreaterThanOrEqual(CELO.finality.blocks);
  });
});

describe("SA-C8: one endpoint's clean pass is reported as agreement between sources", () => {
  it("does not confirm an empty range from a single endpoint", async () => {
    // Fuse has two enumerating endpoints. One answers cleanly with zero logs; the other fails
    // every sub-range, which is the repeated-failure-on-one-endpoint shape the finding names.
    const recorder = makeWireRecorder({
      answers: { eth_getLogs: [] },
      failWith: { "https://fuse.liquify.com": 500 },
    });
    setRpcTransport(recorder.transport);

    const result = await confirmEmptyRange(FUSE, ["0x" + "11".repeat(20)], 1_000, 1_100);

    expect(
      result.confirmed,
      `SA-C8 reproduced (single-source confirmation): confirmEmptyRange() returned ` +
      `confirmed=${result.confirmed} with the reason "${result.reason}", after exactly one of two ` +
      `endpoints answered. pipeline-v5/src/rpc.ts requires only answeredFully.length > 0 and then ` +
      `renders the sentence "two sources agree the range is empty". One source's zero is a claim ` +
      `about that source. The binding verification standard R7 says a log scan is never evidence ` +
      `of absence at any endpoint count, and R4 says a value is a measurement only when two ` +
      `independent endpoints return it. Owner: Phase 6.`
    ).toBe(false);
  });

  it("counts every endpoint's zero-log answers separately from its failures", async () => {
    const recorder = makeWireRecorder({
      answers: { eth_getLogs: [] },
    });
    setRpcTransport(recorder.transport);

    const probe = await probeLogsPresent(FUSE, ["0x" + "11".repeat(20)], 1_000, 1_100);
    const zeroLogTally = (probe as unknown as { zeroLogAnswers?: unknown }).zeroLogAnswers;

    expect(
      zeroLogTally,
      `SA-C8 reproduced (zero-log counter): both endpoints answered with zero logs and the probe ` +
      `reports found=${probe.found}, answeredFully=${probe.answeredFully.length}, ` +
      `errors=${probe.errors.length}, and no zero-log tally of any kind. pipeline-v5/src/rpc.ts ` +
      `tracks { found, failures } per endpoint, so an endpoint that answers zero is ` +
      `indistinguishable in the tally from one that answered with rows. That is the exact signal ` +
      `a false zero produces: forno's false-zero rate on this project was measured between 20 and ` +
      `90 percent depending on range age, with no error raised on any occasion, and the only way ` +
      `to see it is to count zero answers per source. Owner: Phase 6.`
    ).toBeDefined();
  });
});

describe("SA-C23a: a rollback guard is read, noted, and changes nothing", () => {
  it("does not record a capture complete while its range is still rollback-eligible", async () => {
    const sim = new BigQuerySimulator();
    sim.defineTable("RawLogs", RAW_LOGS_COLUMNS, []);
    sim.defineTable("Transactions", TRANSACTIONS_COLUMNS, []);
    setBigQueryClient(sim);

    // The reader announces that it still holds blocks from BELOW this capture's start, which is
    // the client saying "anything from here down may be rolled back".
    setReaderOverride(async (_n, _a, from, to, onChunk) => {
      await onChunk({
        fromBlock: from, toBlock: to, ok: true,
        logs: [{
          blockNumber: from, blockHash: hash32("bh"), transactionHash: hash32("tx"),
          transactionIndex: 0, logIndex: 0,
          address: "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf",
          data: "0x", topics: [hash32("t0")], removed: false,
        }],
        transactions: [{
          hash: hash32("tx"), blockNumber: from, blockHash: hash32("bh"), transactionIndex: 0,
          from: "0x0000000000000000000000000000000000000001", to: null, value: "0", nonce: "0",
          gas: "21000", gasUsed: "21000", effectiveGasPrice: "1", input: "0x", kind: 2,
          status: 1, contractAddress: null,
        }],
        blocks: [{ number: from, hash: hash32("bh"), timestamp: 1_781_000_000 }],
        nextBlock: to + 1, archiveHeight: to + 100, rollbackGuard: null,
        sourceKind: "index", sourceId: "hypersync:xdc", attempts: [], ms: 0,
      } as any);
      return {
        fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1,
        skipped: [], errors: [], emptyChunks: [], logsSeen: 1, complete: true,
        sourceKind: "index", sourceId: "hypersync:xdc", enumeratingSources: 1,
        headAtCapture: to + 100,
        rollbackGuards: [{
          blockNumber: from - 10, timestamp: 0, hash: hash32("rbg"),
          firstBlockNumber: from - 10, firstParentHash: hash32("rbp"),
        }],
      };
    });

    await runPipeline({
      mode: "backfill",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
      fromBlock: 2_000,
      toBlock: 2_010,
    });

    const coverage = sim.tables.get("IngestionCoverage")?.rows ?? [];
    const rawRow = coverage.find((r) => r.target_table === "RawLogs");

    expect(rawRow, "precondition: a RawLogs coverage row must exist").toBeDefined();
    expect(
      rawRow?.status,
      `SA-C23a reproduced (inert guard): the reader reported a rollback guard whose first held ` +
      `block is BELOW this capture's start, and the coverage row status is "${rawRow?.status}" ` +
      `with the warning relegated to error_message. PR 71 fixed the half of this finding that ` +
      `DROPPED the guard, and pipeline-v5/src/hs-worker.mjs now forwards it. The remaining half ` +
      `is that pipeline-v5/src/pipeline.ts computes status before it reads the guards and then ` +
      `only appends a note, so a range the source itself says is still reorganisable is recorded ` +
      `as settled and the resume frontier moves past it. Owner: Phase 6.`
    ).not.toBe("complete");
  });
});
