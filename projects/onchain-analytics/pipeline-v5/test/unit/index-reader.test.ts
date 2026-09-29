/**
 * The HyperSync index reader, exercised for real.
 *
 * WHY THIS FILE EXISTS. `setReaderOverride` replaces the WHOLE reader, so every test that used it
 * -- which was all of them -- flew straight over `hypersync.ts`. The module measured 7.10 percent
 * statements with a passing suite, and the parts nobody reached are not incidental: chunk
 * planning, the bounded retry, the SHORT-COLLECTION refusal, empty-chunk tracking, and the
 * rollback-guard forwarding that half of SA-C23a depends on. A reader-policy unit that leaves the
 * index reader untested has tested its policy against a stub of itself.
 *
 * `setWorkerRunner` replaces one request/response and nothing else, so what runs below is the
 * real chunking and the real retry policy against a scripted worker.
 */

import { describe, it, expect, afterEach } from "vitest";
import { fetchRange, getChainTip, hasHypersync } from "../../src/hypersync.js";
import { NETWORKS, CONFIG } from "../../src/config.js";
import { setWorkerRunner, resetAdapters } from "../../src/adapters.js";
import { hash32 } from "../helpers/fixtures.js";
import type { ChunkResult } from "../../src/types.js";

const XDC = NETWORKS.XDC;
const FUSE = NETWORKS.FUSE;

afterEach(() => resetAdapters());

/** A worker that answers `collect` with a scripted result, recording every request it saw. */
function scriptedWorker(reply: (req: any, callNumber: number) => Record<string, any>) {
  const requests: any[] = [];
  setWorkerRunner(async (request) => {
    requests.push(request);
    return reply(request, requests.length);
  });
  return requests;
}

function okCollect(req: any, logs: any[] = []): Record<string, any> {
  return {
    ok: true, ms: 1,
    logs, transactions: [], blocks: [],
    nextBlock: req.toBlock, archiveHeight: req.toBlock + 500, rollbackGuard: null,
  };
}

function logAt(blockNumber: number, address: string): any {
  return {
    blockNumber, blockHash: hash32(`b${blockNumber}`), transactionHash: hash32(`t${blockNumber}`),
    transactionIndex: 0, logIndex: 0, address, data: "0x",
    topics: [hash32("t0")], removed: false,
  };
}

const ADDR = "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf";

describe("the index reader plans chunks from the chain's own chunk size", () => {
  it("splits an inclusive range into the configured chunk size and covers it exactly", async () => {
    const requests = scriptedWorker((req) => okCollect(req));
    const seen: ChunkResult[] = [];

    const result = await fetchRange(XDC, [ADDR], 1_000, 1_000 + XDC.chunkBlocks * 3 - 1,
      async (c) => { seen.push(c); });

    expect(requests).toHaveLength(3);
    expect(result.chunksPlanned).toBe(3);
    expect(result.chunksOk).toBe(3);
    expect(result.complete).toBe(true);
    // The worker takes an EXCLUSIVE upper bound; the chunk reports an inclusive one. An off-by-one
    // here loses one block per chunk, silently, forever.
    expect(seen.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      [1_000, 1_000 + XDC.chunkBlocks - 1],
      [1_000 + XDC.chunkBlocks, 1_000 + XDC.chunkBlocks * 2 - 1],
      [1_000 + XDC.chunkBlocks * 2, 1_000 + XDC.chunkBlocks * 3 - 1],
    ]);
    expect(requests.map((r) => r.toBlock)).toEqual(seen.map((c) => c.toBlock + 1));
  });

  it("passes every address to the worker in one request, which is what makes batching possible", async () => {
    const other = "0x21eac3fe218307bee0463f77ebca3b50f452c0ce";
    const requests = scriptedWorker((req) => okCollect(req));

    await fetchRange(XDC, [ADDR, other], 1_000, 1_999, async () => { /* nothing to do */ });

    expect(requests).toHaveLength(1);
    expect(requests[0].addresses).toEqual([ADDR, other]);
  });

  it("sends the chain's own index url, not a default", async () => {
    const requests = scriptedWorker((req) => okCollect(req));

    await fetchRange(XDC, [ADDR], 1_000, 1_999, async () => { /* nothing to do */ });

    expect(requests[0].url).toBe(XDC.readers.hypersyncUrl);
  });
});

describe("a short collection is a failure, not a result", () => {
  it("refuses a chunk whose nextBlock falls below the range it was asked for", async () => {
    // Without this check a truncated range is indistinguishable from an empty one, and an empty
    // one advances the frontier over blocks nobody read.
    scriptedWorker((req) => ({ ...okCollect(req), nextBlock: req.toBlock - 10 }));
    const seen: ChunkResult[] = [];

    const result = await fetchRange(XDC, [ADDR], 1_000, 1_999, async (c) => { seen.push(c); });

    expect(result.complete).toBe(false);
    expect(result.skipped).toEqual([[1_000, 1_999]]);
    expect(result.chunksOk).toBe(0);
    expect(seen, "a refused chunk must never reach the writer").toHaveLength(0);
    expect(result.errors.join(" ")).toContain("SHORT_COLLECTION");
  });

  it("reports EVERY skipped chunk, not the first one", async () => {
    // Nine skipped chunks reported as three is a defect this project has already shipped once.
    scriptedWorker(() => ({ ok: false, error: "simulated worker failure", ms: 1 }));

    const result = await fetchRange(XDC, [ADDR], 1_000, 1_000 + XDC.chunkBlocks * 3 - 1,
      async () => { /* nothing to do */ });

    expect(result.skipped).toHaveLength(3);
    expect(result.chunksPlanned).toBe(3);
    expect(result.chunksOk).toBe(0);
    expect(result.complete).toBe(false);
  });

  it("bounds its retries by the configured count and then gives up on the chunk", async () => {
    // Asserting "a retry happens" would be asserting the test environment, which pins
    // HYPERSYNC_RETRIES to 1. The real property is that the count is BOUNDED and that exhausting
    // it produces a recorded skip rather than an unbounded loop or a silent empty chunk.
    let calls = 0;
    setWorkerRunner(async () => {
      calls += 1;
      return { ok: false, error: "simulated persistent failure", ms: 1 };
    });

    const result = await fetchRange(XDC, [ADDR], 1_000, 1_999, async () => { /* nothing to do */ });

    expect(calls).toBe(CONFIG.HYPERSYNC_RETRIES);
    expect(result.complete).toBe(false);
    expect(result.skipped).toEqual([[1_000, 1_999]]);
  });
});

describe("what the reader tells the pipeline about a range", () => {
  it("records a chunk with no logs as an empty chunk, which is a negative to confirm", async () => {
    scriptedWorker((req) => okCollect(req));

    const result = await fetchRange(XDC, [ADDR], 1_000, 1_999, async () => { /* nothing to do */ });

    expect(result.emptyChunks).toEqual([[1_000, 1_999]]);
    expect(result.logsSeen).toBe(0);
  });

  it("does not record a chunk that returned logs as empty", async () => {
    scriptedWorker((req) => okCollect(req, [logAt(1_100, ADDR)]));

    const result = await fetchRange(XDC, [ADDR], 1_000, 1_999, async () => { /* nothing to do */ });

    expect(result.emptyChunks).toEqual([]);
    expect(result.logsSeen).toBe(1);
  });

  it("forwards the rollback guard the worker reported, which is half of SA-C23a", async () => {
    // PR 71 fixed the worker dropping it. This asserts the reader still carries it up, because
    // the status decision in pipeline.ts is now built on it.
    const guard = {
      blockNumber: 990, timestamp: 0, hash: hash32("rbg"),
      firstBlockNumber: 990, firstParentHash: hash32("rbp"),
    };
    scriptedWorker((req) => ({ ...okCollect(req), rollbackGuard: guard }));

    const result = await fetchRange(XDC, [ADDR], 1_000, 1_999, async () => { /* nothing to do */ });

    expect(result.rollbackGuards).toEqual([guard]);
  });

  it("reports one source, because one index is one source however good it is", async () => {
    scriptedWorker((req) => okCollect(req));

    const result = await fetchRange(XDC, [ADDR], 1_000, 1_999, async () => { /* nothing to do */ });

    expect(result.enumeratingSources).toBe(1);
    expect(result.sourceKind).toBe("index");
    expect(result.sourceId).toContain("hypersync:");
  });

  it("lowercases identifiers at the boundary, because two spellings of one hash are two keys", async () => {
    scriptedWorker((req) => okCollect(req, [logAt(1_100, ADDR.toUpperCase().replace("0X", "0x"))]));
    const seen: ChunkResult[] = [];

    await fetchRange(XDC, [ADDR], 1_000, 1_999, async (c) => { seen.push(c); });

    expect(seen[0].logs[0].address).toBe(ADDR);
  });
});

describe("the chain tip is read, never guessed", () => {
  it("returns the height the index reported", async () => {
    scriptedWorker(() => ({ ok: true, height: 123_456, ms: 1 }));

    expect(await getChainTip(XDC)).toBe(123_456);
  });

  it("returns null rather than a guess when the index cannot answer", async () => {
    // A guessed tip is how a range silently becomes shorter than the caller believes.
    scriptedWorker(() => ({ ok: false, error: "simulated failure", ms: 1 }));

    expect(await getChainTip(XDC)).toBeNull();
  });

  it("refuses a height that parses to NaN, because NaN IS a number", async () => {
    scriptedWorker(() => ({ ok: true, height: Number.NaN, ms: 1 }));

    expect(await getChainTip(XDC)).toBeNull();
  });
});

describe("a chain with no index is not served by this reader", () => {
  it("reports Fuse as having no HyperSync index", () => {
    expect(hasHypersync(FUSE)).toBe(false);
    expect(hasHypersync(XDC)).toBe(true);
  });
});
