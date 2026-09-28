/**
 * GREEN regression guards for Stage A defects PR 71 already repaired.
 *
 * WHY THESE ARE GREEN AND NOT RED, stated plainly because the plan lists them among the
 * regressions Phase 1 must turn red. Plan Section 5 task 4 names six carried Stage A defects.
 * They were established against the Stage A verification library at `specs/_lib/lib.mjs`. The
 * shipping pipeline in the integrated candidate does not have them: PR 71 independently repaired
 * the same shapes, and each repair is verified below by exercising the code rather than by
 * reading its comments.
 *
 * A defect that is already fixed cannot be made red for its intended reason, and coordination's
 * own rule is that a test which passes whether or not the defect is present is worthless. So
 * each one becomes what it can honestly be: a guard that fails the moment the fix is undone.
 * Phase 6 owns the repair of anything still outstanding, and what IS still outstanding is red in
 * `test/known-failures/reader-evidence.test.ts`.
 *
 * The split between this file and that one is a finding in the Phase 1 report, not a quiet
 * narrowing of scope.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { rpcFetchRange } from "../../src/reader.js";
import { NETWORKS } from "../../src/config.js";
import { setRpcTransport, resetAdapters } from "../../src/adapters.js";
import { makeWireRecorder } from "../helpers/wire-recorder.js";
import { hash32 } from "../helpers/fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");

const ETH = NETWORKS.ETHEREUM;

afterEach(() => resetAdapters());

/** One log and its block and transaction, enough for a chunk to hydrate cleanly. */
function oneLogAt(block: number) {
  return {
    blockNumber: "0x" + block.toString(16),
    blockHash: hash32("bh"),
    transactionHash: hash32("tx"),
    transactionIndex: "0x0",
    logIndex: "0x0",
    address: "0x" + "11".repeat(20),
    data: "0x",
    topics: [hash32("t0")],
    removed: false,
  };
}

describe("SA-C7: verification and hydration calls name a block, never `latest`", () => {
  it("sends a hex block number on eth_getBlockByNumber and never the string latest", async () => {
    const block = 21_000_000;
    const recorder = makeWireRecorder({
      answers: {
        eth_blockNumber: "0x" + (block + 500).toString(16),
        eth_getLogs: [oneLogAt(block)],
        eth_getBlockByNumber: {
          number: "0x" + block.toString(16), hash: hash32("bh"), timestamp: "0x6800_0000".replace("_", ""),
        },
        eth_getTransactionByHash: {
          hash: hash32("tx"), blockNumber: "0x" + block.toString(16), blockHash: hash32("bh"),
          transactionIndex: "0x0", from: "0x" + "22".repeat(20), to: "0x" + "11".repeat(20),
          value: "0x0", nonce: "0x1", gas: "0x5208", input: "0x", type: "0x2",
        },
        eth_getTransactionReceipt: {
          status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
        },
      },
    });
    setRpcTransport(recorder.transport);

    await rpcFetchRange(ETH, ["0x" + "11".repeat(20)], block, block + 10, async () => {});

    const blockCalls = recorder.of("eth_getBlockByNumber");
    expect(blockCalls.length).toBeGreaterThan(0);
    for (const call of blockCalls) {
      expect(call.params[0], "a pinned read must name a numeric block").toMatch(/^0x[0-9a-f]+$/);
      expect(call.body).not.toContain("latest");
      expect(call.body).not.toContain("pending");
    }

    // Every log query is bounded by explicit hex block numbers too.
    for (const call of recorder.of("eth_getLogs")) {
      const filter = call.params[0] as { fromBlock: string; toBlock: string };
      expect(filter.fromBlock).toMatch(/^0x[0-9a-f]+$/);
      expect(filter.toBlock).toMatch(/^0x[0-9a-f]+$/);
    }
  });

  it("sends eth_getTransactionReceipt exactly one parameter, the transaction hash", async () => {
    const block = 21_000_000;
    const recorder = makeWireRecorder({
      answers: {
        eth_blockNumber: "0x" + (block + 500).toString(16),
        eth_getLogs: [oneLogAt(block)],
        eth_getBlockByNumber: { number: "0x" + block.toString(16), hash: hash32("bh"), timestamp: "0x68000000" },
        eth_getTransactionByHash: {
          hash: hash32("tx"), blockNumber: "0x" + block.toString(16), blockHash: hash32("bh"),
          transactionIndex: "0x0", from: "0x" + "22".repeat(20), to: "0x" + "11".repeat(20),
          value: "0x0", nonce: "0x1", gas: "0x5208", input: "0x", type: "0x2",
        },
        eth_getTransactionReceipt: {
          status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
        },
      },
    });
    setRpcTransport(recorder.transport);

    await rpcFetchRange(ETH, ["0x" + "11".repeat(20)], block, block + 10, async () => {});

    const receipts = recorder.of("eth_getTransactionReceipt");
    expect(receipts.length).toBeGreaterThan(0);
    for (const call of receipts) {
      // A second parameter here is not merely redundant: the method takes one, and an endpoint
      // that validates its arity rejects the whole call, which renders as a missing receipt.
      expect(call.params).toHaveLength(1);
      expect(call.params[0]).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe("SA-C8: every skipped chunk is reported, not a sample of them", () => {
  it("reports all nine skipped chunks when every endpoint fails on every one", async () => {
    // Nine chunks, both endpoints failing every time. The Stage A library tallied only the first
    // three per (pass, endpoint) and reported three gaps where nine chunks had failed.
    const recorder = makeWireRecorder({
      answers: { eth_blockNumber: "0x1400000" },
      failWith: {
        "https://eth.blockscout.com/api/eth-rpc": 500,
        "https://gateway.tenderly.co/public/mainnet": 500,
      },
    });
    setRpcTransport(recorder.transport);

    const chunk = ETH.chunkBlocks;
    const from = 1_000_000;
    const to = from + chunk * 9 - 1;

    const result = await rpcFetchRange(ETH, ["0x" + "11".repeat(20)], from, to, async () => {});

    expect(result.chunksPlanned).toBe(9);
    expect(result.skipped).toHaveLength(9);
    expect(result.complete).toBe(false);
    // Errors are counted separately from results, so an all-failure run is never an empty answer.
    expect(result.errors.length).toBeGreaterThanOrEqual(9);
    expect(result.logsSeen).toBe(0);
  });
});

describe("SA-C23a: finality and the rollback guard are wired, not assumed", () => {
  it("carries a measured per-chain finality depth with its source, never a bare 64 on Celo", () => {
    // A2 measured Celo's finalized tag 1,187 to 1,930 blocks behind head. The predecessor held 64.
    expect(NETWORKS.CELO.finality.blocks).toBeGreaterThanOrEqual(1_187);
    expect(NETWORKS.CELO.finality.source).toMatch(/\S/);

    for (const network of Object.values(NETWORKS)) {
      expect(network.finality.blocks, `${network.name} must declare a positive margin`).toBeGreaterThan(0);
      expect(
        network.finality.source,
        `${network.name} must record where its finality figure came from, so it is checkable`
      ).toMatch(/\S/);
      // The one chain with no finality tag must say so rather than imply a measurement.
      if (!network.finality.publishesFinalizedTag) {
        expect(network.finality.source).toMatch(/not a measurement|time budget/i);
      }
    }
  });

  it("requests the rollback guard from the index client and forwards it to the caller", () => {
    // Asserted on the worker source because the client itself cannot run here: it is a native
    // module driven in a child process against a live index. What is checkable without one is
    // that the worker reads the field and puts it in the message, which is the half that was
    // dropped.
    const worker = readFileSync(join(SRC, "hs-worker.mjs"), "utf8");
    expect(worker).toMatch(/rollbackGuard:\s*res\.rollbackGuard/);
    expect(worker).toMatch(/nextBlock:/);

    const hypersync = readFileSync(join(SRC, "hypersync.ts"), "utf8");
    expect(hypersync).toMatch(/rollbackGuards\.push/);
  });
});

describe("SA-C8: convergence is calibrated from a measured rate, not a fixed pass count", () => {
  it("derives the pass count k from the measured miss rate p", async () => {
    const { __testing } = await import("../../src/calibrate.js");
    expect(__testing, "calibrate.ts must expose its summariser for this assertion").toBeDefined();

    // p measured at 0.7, which is what this project actually measured on one endpoint in one
    // afternoon. A five-pass rule stops falsely about one time in six at that rate. The modal
    // answer is the full count; the short answers vary, which is what a false zero and a partial
    // read actually look like next to each other.
    const short = __testing.summarise("src", "CELO", 1, 100, [10, 10, 10, 0, 1, 2, 3, 4, 5, 6], 0);
    expect(short.modeAnswer).toBe(10);
    expect(short.p).toBeCloseTo(0.7, 5);
    expect(short.kForOnePercent).toBe(Math.ceil(Math.log(0.01) / Math.log(0.7)));
    expect(short.kForOnePercent).toBeGreaterThan(5);

    // Zero short answers is a fact about the session, reported with its n, not a property.
    const clean = __testing.summarise("src", "CELO", 1, 100, [10, 10, 10], 0);
    expect(clean.p).toBe(0);
    expect(clean.verdict).toMatch(/fact about this session/i);
  });
});
