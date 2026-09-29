/**
 * hypersync.ts
 *
 * Chunked, paced, deadline-bounded access to HyperSync. Replaces the streaming fetch.
 *
 * Why a chunk plan rather than a stream. A stream's batch boundaries depend on server-side
 * pagination and on timing, so two runs over the same range do not produce the same sequence of
 * writes. A fixed chunk plan over a fixed block range does, which is what makes a repeated
 * backfill byte-identical rather than merely similar. It also makes every chunk independently
 * accountable: a chunk either completed, or it is named in the skip list.
 *
 * Three defects this closes, each of which actually occurred in this project:
 *   B7  No request timeout. The native client retries internally without bound during a 429
 *       storm, so an in-process deadline never fires and the job hangs. Each chunk therefore
 *       runs in a child process that is SIGKILLed on deadline.
 *   B4  No inter-chunk pacing. A wide unpaced scan draws sustained 429s. Every chunk is paced
 *       even on success.
 *       A short collection is not an empty one. HyperSync announces a truncated range through
 *       nextBlock, and a caller that ignores it reads truncation as absence. Any chunk whose
 *       nextBlock falls short of its toBlock is a FAILURE, not a result.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { CONFIG } from "./config.js";
import { log } from "./log.js";
import { normaliseChunk } from "./normalise.js";
import type { NetworkConfig, ChunkResult, FetchResult, RollbackGuard } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "hs-worker.mjs");
const START = "<<<HS_RESULT_START>>>";
const END = "<<<HS_RESULT_END>>>";

/** Whether HyperSync can read this chain at all. Two of the four in this set have no index. */
export function hasHypersync(network: NetworkConfig): boolean {
  return network.readers.hypersyncUrl !== null;
}

function hypersyncUrl(network: NetworkConfig): string {
  const url = network.readers.hypersyncUrl;
  if (url === null) {
    throw new Error(
      `NO_HYPERSYNC: ${network.name} has no HyperSync index. fuse.hypersync.xyz and ` +
      `eth.hypersync.xyz do not resolve, and the client retries forever so their absence presents ` +
      `as a timeout rather than as a 404. Use the RPC reader for this chain.`
    );
  }
  return url;
}

/** A stable short code for the reader that answered, written onto every row it produces. */
function sourceIdFor(network: NetworkConfig): string {
  return `hypersync:${new URL(hypersyncUrl(network)).host}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  const base = 2000 * Math.pow(2, attempt - 1);
  return base + Math.random() * base * 0.3;
}

interface WorkerResult {
  ok: boolean;
  error?: string;
  timedOut?: boolean;
  ms: number;
  height?: number;
  nextBlock?: number | null;
  archiveHeight?: number | null;
  rollbackGuard?: RollbackGuard | null;
  logs?: any[];
  transactions?: any[];
  blocks?: any[];
}

/** Run one worker request under a hard wall-clock deadline. Never throws. */
function runWorker(request: Record<string, unknown>, timeoutMs: number): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [WORKER, JSON.stringify(request)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let out = "";
    let err = "";
    let settled = false;

    const done = (r: Omit<WorkerResult, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({ ...r, ms: Date.now() - t0 });
    };

    const timer = setTimeout(() => {
      done({ ok: false, timedOut: true, error: `HS_TIMEOUT after ${timeoutMs}ms, child killed` });
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += String(d).slice(0, 500); });
    child.on("error", (e) => done({ ok: false, error: `HS_SPAWN ${e.message}` }));
    child.on("close", () => {
      const i = out.indexOf(START);
      const j = out.indexOf(END);
      if (i < 0 || j < 0) return done({ ok: false, error: `HS_NO_RESULT ${err.slice(0, 200)}` });
      let parsed: any;
      try {
        parsed = JSON.parse(out.slice(i + START.length, j));
      } catch (e: any) {
        return done({ ok: false, error: `HS_BAD_JSON ${e.message}` });
      }
      if (!parsed.ok) return done({ ok: false, error: String(parsed.error) });
      done(parsed);
    });
  });
}

/**
 * Chain tip as HyperSync sees it. Returns null rather than a guess, because a guessed tip is
 * how a range silently becomes shorter than the caller believes.
 */
export async function getChainTip(network: NetworkConfig): Promise<number | null> {
  for (let attempt = 1; attempt <= CONFIG.HYPERSYNC_RETRIES; attempt++) {
    const r = await runWorker(
      { op: "height", url: hypersyncUrl(network), token: CONFIG.ENVIO_API_TOKEN },
      CONFIG.HS_CHUNK_TIMEOUT_MS
    );
    // Number.isFinite rather than typeof number, because an endpoint on one chain in this set has
    // been measured answering with a value that parses to NaN, and NaN IS a number. A guard that
    // counts answers rather than USABLE answers produced eight state reads at a block that does
    // not exist.
    if (r.ok && Number.isFinite(r.height)) return r.height as number;
    log.warn(`getChainTip attempt ${attempt}/${CONFIG.HYPERSYNC_RETRIES} failed for ${network.name}`, {
      error: r.error, timedOut: r.timedOut, height: r.height,
    });
    if (attempt < CONFIG.HYPERSYNC_RETRIES) await sleep(backoffMs(attempt));
  }
  return null;
}

/** Collect one block chunk. A chunk is ok only when the range was covered to its end. */
async function collectChunk(
  network: NetworkConfig,
  addresses: string[],
  fromBlock: number,
  toBlockExclusive: number
): Promise<ChunkResult> {
  const attempts: string[] = [];
  const sourceId = sourceIdFor(network);

  for (let attempt = 1; attempt <= CONFIG.HYPERSYNC_RETRIES; attempt++) {
    const r = await runWorker(
      { op: "collect", url: hypersyncUrl(network), token: CONFIG.ENVIO_API_TOKEN, addresses, fromBlock, toBlock: toBlockExclusive },
      CONFIG.HS_CHUNK_TIMEOUT_MS
    );

    if (!r.ok) {
      attempts.push(`attempt ${attempt}: ${String(r.error).slice(0, 300)}`);
      if (attempt < CONFIG.HYPERSYNC_RETRIES) await sleep(backoffMs(attempt));
      continue;
    }

    // A short collection is a failure, not a result. Without this check a truncated range is
    // indistinguishable from an empty one, and an empty one silently advances the watermark.
    if (r.nextBlock !== null && r.nextBlock !== undefined && r.nextBlock < toBlockExclusive) {
      attempts.push(
        `attempt ${attempt}: SHORT_COLLECTION nextBlock ${r.nextBlock} below toBlock ${toBlockExclusive} ` +
        `(archiveHeight ${r.archiveHeight ?? "unknown"})`
      );
      if (attempt < CONFIG.HYPERSYNC_RETRIES) await sleep(backoffMs(attempt));
      continue;
    }

    const chunk: ChunkResult = {
      fromBlock, toBlock: toBlockExclusive - 1, ok: true,
      logs: r.logs ?? [], transactions: r.transactions ?? [], blocks: r.blocks ?? [],
      nextBlock: r.nextBlock ?? null, archiveHeight: r.archiveHeight ?? null,
      rollbackGuard: r.rollbackGuard ?? null,
      sourceKind: "index", sourceId,
      attempts, ms: r.ms,
    };
    // Normalise at the boundary, once, before anything else touches the chunk. This is the only
    // place in the pipeline that lowercases an identifier, and it is what makes the merge key
    // sound: two spellings of one hash are two different keys, and no test on the key can see it.
    normaliseChunk(chunk);
    return chunk;
  }

  return {
    fromBlock, toBlock: toBlockExclusive - 1, ok: false,
    logs: [], transactions: [], blocks: [],
    nextBlock: null, archiveHeight: null, rollbackGuard: null,
    sourceKind: "index", sourceId,
    attempts, ms: 0,
  };
}

/**
 * Fetch every log for `addresses` over [fromBlock, toBlock] INCLUSIVE, chunk by chunk.
 *
 * The returned FetchResult reports its own completeness. `complete` is false when any chunk
 * failed, and the caller must then treat the row set as a floor rather than a population. A run
 * that advances a watermark on an incomplete fetch is the omission defect, restated.
 */
export async function fetchRange(
  network: NetworkConfig,
  addresses: string[],
  fromBlock: number,
  toBlock: number,
  onChunk: (chunk: ChunkResult) => Promise<void>
): Promise<FetchResult> {
  const chunkSize = network.chunkBlocks;
  const chunks: { from: number; to: number }[] = [];
  for (let lo = fromBlock; lo <= toBlock; lo += chunkSize) {
    chunks.push({ from: lo, to: Math.min(lo + chunkSize - 1, toBlock) });
  }

  log.info(`Fetch plan: ${chunks.length} chunk(s) of ${chunkSize} blocks over ${fromBlock}..${toBlock}`, {
    network: network.name, addresses,
  });

  const result: FetchResult = {
    fromBlock, toBlock,
    chunksPlanned: chunks.length, chunksOk: 0,
    skipped: [], errors: [], emptyChunks: [],
    logsSeen: 0, complete: false,
    sourceKind: "index", sourceId: sourceIdFor(network),
    // One index enumerated this range. HyperSync is a single source, however good it is, and the
    // grade has to say so: a second independent enumeration is what raises it and this is not one.
    enumeratingSources: 1,
    headAtCapture: null,
    rollbackGuards: [],
  };

  const deadline = Date.now() + CONFIG.HS_RANGE_DEADLINE_MS;

  for (const c of chunks) {
    if (Date.now() > deadline) {
      result.skipped.push([c.from, c.to]);
      result.errors.push(
        `HS_RANGE_DEADLINE: ${CONFIG.HS_RANGE_DEADLINE_MS}ms exceeded, blocks ${c.from}..${c.to} not attempted`
      );
      continue;
    }

    const chunk = await collectChunk(network, addresses, c.from, c.to + 1);
    if (!chunk.ok) {
      result.skipped.push([c.from, c.to]);
      result.errors.push(`chunk ${c.from}..${c.to}: ${chunk.attempts.join(" | ")}`);
      log.error(`Chunk FAILED ${c.from}..${c.to}`, { network: network.name, attempts: chunk.attempts });
    } else {
      result.chunksOk += 1;
      result.logsSeen += chunk.logs.length;
      // archiveHeight is the reader's own view of the chain head, which is what makes
      // confirmations_at_capture on each row reproducible. The highest one seen is kept, because
      // the chain advances during a long range and the newest reading is the one that describes
      // the blocks most at risk.
      if (chunk.archiveHeight !== null && (result.headAtCapture === null || chunk.archiveHeight > result.headAtCapture)) {
        result.headAtCapture = chunk.archiveHeight;
      }
      if (chunk.rollbackGuard) result.rollbackGuards.push(chunk.rollbackGuard);
      if (chunk.logs.length === 0) result.emptyChunks.push([c.from, c.to]);
      await onChunk(chunk);
    }

    // B4. Paced even on success. An unpaced scan draws sustained 429s, which the client answers
    // by retrying forever, which is how a run stops returning at all.
    await sleep(CONFIG.HS_CHUNK_PAUSE_MS);
  }

  result.complete = result.skipped.length === 0;
  return result;
}


