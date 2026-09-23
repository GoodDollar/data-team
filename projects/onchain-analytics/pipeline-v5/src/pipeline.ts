/**
 * pipeline.ts
 *
 * Ingestion for one (contract, network) binding, and the run orchestration around it.
 *
 * The two defects this file is written against, both measured in production data:
 *
 * DUPLICATION. A block range was written twice, four months apart, producing 43,000 phantom
 * claim rows and 2,167 phantom invite rows. The write path is now a MERGE on
 * (network, tx_hash, log_index), so re-running a range is free. See bq.stageAndMerge.
 *
 * OMISSION, which is independent of the duplication and was invisible until the contract was
 * asked. Four real claims are absent from the warehouse, on three days that carried no
 * duplicates at all. The mechanism is now proven rather than suspected:
 *
 *   The predecessor flushed a fixed 1,000-row batch with no regard for block boundaries, so a
 *   run that ended mid-stream left its final block PARTIALLY written. The next run resumed at
 *   MAX(block_number) + 1 and never looked at that block again, so the tail of it was lost
 *   permanently. Block 102,959,090 holds log indices 1, 4, 7, 10, 13, 16, 19 and 22 in the
 *   warehouse; the chain also has 25 and 28 at the same block. The same shape appears at
 *   103,541,459 and at 105,182,364, and each of those three blocks is the exact last block of
 *   an ingest batch.
 *
 * Two changes close it, and they only work together:
 *   1. The watermark resumes AT the last stored block, not one past it, so a partially written
 *      block is always revisited. This is only safe because the write path is a MERGE; under
 *      the append semantics it replaces it would have duplicated a block on every run.
 *   2. Buffers flush on a block boundary, so a write never splits a block in the first place.
 *
 * And one rule underneath both: a chunk that returns nothing is a NEGATIVE, not a result. An
 * identical repeated log query on this project's endpoints returned zero seven times in ten one
 * day and three times in ten the day before, with no errors raised. An unconfirmed empty range
 * does not let the watermark past it.
 */

import { CONFIG, CONTRACTS } from "./config.js";
import { log, RUN_ID } from "./log.js";
import { getChainTip, fetchRange } from "./hypersync.js";
import { confirmEmptyRange } from "./rpc.js";
import {
  getLastBlock,
  getMaxBlockTimestamp,
  ensureInfraTables,
  stageAndMerge,
  recordIngestionStatus,
  recordPipelineRun,
  recordCoverage,
} from "./bq.js";
import { alertStaleness } from "./slack.js";
import { decodeEventLog } from "viem";
import type {
  PipelineOpts, PipelineResult, ContractConfig, LogContext, ChunkResult,
} from "./types.js";

/** Decode one HyperSync chunk into rows, reporting what it could not decode. */
function decodeChunk(
  cfg: ContractConfig,
  chunk: ChunkResult,
  network: ContractConfig["networkBindings"][number]["network"]
): { rows: Record<string, any>[]; undecodable: number; noTopics: number } {
  const txByHash = new Map<string, any>();
  for (const tx of chunk.transactions ?? []) {
    const h = String(tx.hash ?? "").toLowerCase();
    if (h) txByHash.set(h, tx);
  }
  const blockByNumber = new Map<number, any>();
  for (const b of chunk.blocks ?? []) {
    const n = b.number === null || b.number === undefined ? -1 : Number(b.number);
    if (n >= 0) blockByNumber.set(n, b);
  }

  const rows: Record<string, any>[] = [];
  let undecodable = 0;
  let noTopics = 0;

  for (const entry of chunk.logs ?? []) {
    const rawTopics: (string | null)[] = [0, 1, 2, 3].map((i) => {
      const t = (entry.topics ?? [])[i];
      return typeof t === "string" ? t : null;
    });
    const decodeTopics = rawTopics.filter((t): t is string => typeof t === "string");
    if (decodeTopics.length === 0) { noTopics += 1; continue; }

    let decoded: { eventName: string; args: any };
    try {
      decoded = decodeEventLog({
        abi: cfg.abi,
        data: (String(entry.data ?? "0x")) as `0x${string}`,
        topics: decodeTopics as [`0x${string}`, ...`0x${string}`[]],
      }) as any;
    } catch {
      // Not an event this table models. Counted rather than dropped in silence: a decode that
      // fails on every row of a range is a wrong ABI, and a wrong ABI has forced a re-ingest in
      // this project twice.
      undecodable += 1;
      continue;
    }

    const txHash = String(entry.transactionHash ?? "");
    const tx = txByHash.get(txHash.toLowerCase());
    const block = blockByNumber.get(Number(entry.blockNumber));

    const ctx: LogContext = {
      blockNumber: Number(entry.blockNumber),
      blockHash: String(entry.blockHash ?? block?.hash ?? ""),
      blockTimestamp: block?.timestamp ? Number(block.timestamp) : 0,
      txHash,
      txIndex: entry.transactionIndex === undefined ? 0 : Number(entry.transactionIndex),
      logIndex: Number(entry.logIndex),
      contractAddress: String(entry.address ?? ""),
      topics: rawTopics,
      logData: String(entry.data ?? "0x"),
      txFrom: tx?.from ? String(tx.from) : null,
      txTo: tx?.to ? String(tx.to) : null,
      txValue: tx?.value === undefined || tx?.value === null ? null : String(tx.value),
      txStatus: tx?.status === undefined || tx?.status === null ? null : Number(tx.status),
      txNonce: tx?.nonce === undefined || tx?.nonce === null ? null : Number(tx.nonce),
      gasUsed: tx?.gasUsed === undefined || tx?.gasUsed === null ? null : Number(tx.gasUsed),
      effectiveGasPrice:
        tx?.effectiveGasPrice === undefined || tx?.effectiveGasPrice === null
          ? null
          : String(tx.effectiveGasPrice),
    };

    const row = cfg.decodeToRow(decoded.eventName, decoded.args, ctx, network, RUN_ID);
    if (row !== null) rows.push(row);
  }

  return { rows, undecodable, noTopics };
}

export class IncompleteFetchError extends Error {}

/**
 * Process one (contract, network) pair. Throws on an incomplete fetch rather than recording a
 * success, because a partial range recorded as a success is precisely how a gap becomes
 * permanent.
 */
async function processBinding(
  cfg: ContractConfig,
  bindingIdx: number,
  opts: PipelineOpts
): Promise<number> {
  const binding = cfg.networkBindings[bindingIdx];
  const { network, firstBlock, contracts } = binding;
  const startedAt = new Date().toISOString();

  // ---------------------------------------------------------------- resolve the block range
  let fromBlock: number;
  if (opts.fromBlock !== undefined) {
    fromBlock = opts.fromBlock;
  } else if (opts.mode === "backfill") {
    fromBlock = firstBlock;
  } else {
    const lastBlock = await getLastBlock(cfg.tableId, network.name);
    // Resume AT the last stored block, not one past it. The stored block may have been written
    // only in part, and the predecessor's "+1" is how the tail of three blocks was lost for
    // good. Re-reading one block costs one chunk and is free under MERGE.
    fromBlock = lastBlock > 0 ? lastBlock : firstBlock;
  }

  let toBlock: number | null;
  if (opts.toBlock !== undefined) {
    toBlock = opts.toBlock;
  } else {
    toBlock = await getChainTip(network);
    if (toBlock === null) {
      throw new Error(
        `Chain tip unavailable for ${network.name}. Refusing to fetch to an unknown end: ` +
        `an unbounded range cannot be reported complete.`
      );
    }
    // Stay behind the tip so a reorg cannot rewrite what was just written.
    toBlock -= network.finalityBlocks;
  }

  log.info(`Processing ${cfg.tableId}/${network.name}: blocks ${fromBlock}..${toBlock}`, {
    mode: opts.mode, runId: RUN_ID,
  });

  if (toBlock < fromBlock) {
    log.warn(`Nothing to fetch: toBlock ${toBlock} is below fromBlock ${fromBlock}`, {
      tableId: cfg.tableId, network: network.name,
    });
    await recordCoverage({
      runId: RUN_ID, network: network.name, tableId: cfg.tableId,
      fromBlock, toBlock, status: "nothing_to_fetch",
      chunksPlanned: 0, chunksOk: 0, skippedRanges: "[]",
      rowsMerged: 0, rowsInserted: 0, rowsUpdated: 0, logsSeen: 0,
      startedAt, completedAt: new Date().toISOString(), errorMessage: "",
    });
    return 0;
  }

  // --------------------------------------------------------------------- fetch and write
  let buffer: Record<string, any>[] = [];
  let lastBlockInBuffer = -1;
  let inserted = 0;
  let updated = 0;
  let distinctOffered = 0;
  let undecodable = 0;
  let reorgSuspects = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    const r = await stageAndMerge(cfg.tableId, buffer, cfg.schema, RUN_ID);
    inserted += r.inserted;
    updated += r.updated;
    distinctOffered += r.distinct;
    reorgSuspects += r.reorgSuspects;
    buffer = [];
  };

  const fetch = await fetchRange(network, contracts, fromBlock, toBlock, async (chunk) => {
    const d = decodeChunk(cfg, chunk, network);
    undecodable += d.undecodable;

    // HyperSync returns logs in block order. Flushing only when the incoming row belongs to a
    // LATER block than anything buffered guarantees a write never splits a block, which is the
    // property the resume watermark depends on.
    for (const row of d.rows) {
      if (buffer.length >= CONFIG.CHUNK_SIZE_TARGET && row.block_number > lastBlockInBuffer) {
        await flush();
      }
      buffer.push(row);
      if (row.block_number > lastBlockInBuffer) lastBlockInBuffer = row.block_number;
    }
  });

  await flush();

  // ------------------------------------------- every empty chunk is a negative to confirm
  const unconfirmed: string[] = [];
  if (CONFIG.CONFIRM_EMPTY_CHUNKS && fetch.emptyChunks.length > 0) {
    log.info(`Confirming ${fetch.emptyChunks.length} empty chunk(s) against independent endpoints`, {
      tableId: cfg.tableId, network: network.name,
    });
    for (const [lo, hi] of fetch.emptyChunks) {
      const c = await confirmEmptyRange(network, contracts, lo, hi);
      if (!c.confirmed) {
        unconfirmed.push(`${lo}..${hi}: ${c.reason}`);
        log.error(`UNCONFIRMED EMPTY RANGE ${lo}..${hi}`, {
          tableId: cfg.tableId, network: network.name, reason: c.reason, probeErrors: c.probe.errors.slice(0, 5),
        });
      }
    }
  }

  const completedAt = new Date().toISOString();
  const status =
    !fetch.complete ? "incomplete" : unconfirmed.length > 0 ? "unconfirmed_empty" : "complete";

  const notes = [...fetch.errors, ...unconfirmed];
  if (reorgSuspects > 0) {
    notes.push(`REORG_SUSPECTED: ${reorgSuspects} row(s) changed block_hash under an existing key`);
  }

  await recordCoverage({
    runId: RUN_ID, network: network.name, tableId: cfg.tableId,
    fromBlock, toBlock, status,
    chunksPlanned: fetch.chunksPlanned, chunksOk: fetch.chunksOk,
    skippedRanges: JSON.stringify(fetch.skipped),
    rowsMerged: distinctOffered, rowsInserted: inserted, rowsUpdated: updated,
    logsSeen: fetch.logsSeen,
    startedAt, completedAt,
    errorMessage: notes.join(" | ").slice(0, 4000),
  });

  await recordIngestionStatus({
    network: network.name,
    tableId: cfg.tableId,
    ingestionDate: new Date().toISOString().slice(0, 10),
    status: status === "complete" ? "success" : "partial",
    // The last block this run can VOUCH for. Never -1: a sentinel recorded as a success is
    // what made IngestionStatus unable to tell an empty range from a failed one.
    lastBlock: status === "complete" ? toBlock : fromBlock,
    rowCount: inserted + updated,
    startedAt,
    completedAt,
    errorMessage: status === "complete" ? "" : notes[0]?.slice(0, 500),
    runId: RUN_ID,
  });

  if (undecodable > 0) {
    log.warn(`${undecodable} log(s) in range did not decode against this table's ABI`, {
      tableId: cfg.tableId, network: network.name,
    });
  }

  if (status !== "complete") {
    throw new IncompleteFetchError(
      `${cfg.tableId}/${network.name} ${fromBlock}..${toBlock} is ${status}: ` +
      `${fetch.skipped.length} skipped chunk(s), ${unconfirmed.length} unconfirmed empty range(s). ` +
      `The watermark has NOT been advanced past this range.`
    );
  }

  log.info(
    `Done: ${cfg.tableId}/${network.name}, ${inserted} inserted, ${updated} updated, ` +
    `${fetch.chunksOk}/${fetch.chunksPlanned} chunks`,
    { runId: RUN_ID }
  );
  return inserted + updated;
}

/**
 * Check freshness for all tables. Alerts if data is stale.
 */
async function checkFreshness(): Promise<void> {
  const threshold = CONFIG.FRESHNESS_THRESHOLD_HOURS;
  const now = Date.now();

  for (const cfg of CONTRACTS) {
    for (const binding of cfg.networkBindings) {
      try {
        const maxTs = await getMaxBlockTimestamp(cfg.tableId, binding.network.name);
        if (!maxTs) continue;

        const hoursStale = (now - maxTs.getTime()) / (1000 * 60 * 60);
        if (hoursStale > threshold) {
          log.warn(`Data stale: ${cfg.tableId}/${binding.network.name} is ${Math.round(hoursStale)}h behind`);
          await alertStaleness(cfg.tableId, binding.network.name, maxTs, hoursStale);
        }
      } catch (e: any) {
        log.warn(`Freshness check failed for ${cfg.tableId}/${binding.network.name}: ${e.message}`);
      }
    }
  }
}

/**
 * Main pipeline entry. Processes all enabled contracts sequentially.
 */
export async function runPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  await ensureInfraTables();

  // Filter contracts if specified
  const contracts = opts.contracts
    ? CONTRACTS.filter((c) => opts.contracts!.includes(c.tableId))
    : CONTRACTS;

  if (contracts.length === 0) {
    log.error(`No contracts matched filter: ${opts.contracts?.join(", ")}`);
    return { succeeded: 0, failed: 0, totalRows: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  let totalRows = 0;

  for (const cfg of contracts) {
    for (let i = 0; i < cfg.networkBindings.length; i++) {
      const binding = cfg.networkBindings[i];
      try {
        const rows = await processBinding(cfg, i, opts);
        totalRows += rows;
        succeeded++;
      } catch (e: any) {
        log.error(`Failed: ${cfg.tableId}/${binding.network.name}: ${e.message}`, { error: e.message });
        // Record failed ingestion status
        const today = new Date().toISOString().slice(0, 10);
        try {
          await recordIngestionStatus({
            network: binding.network.name,
            tableId: cfg.tableId,
            ingestionDate: today,
            status: "failed",
            lastBlock: 0,
            rowCount: 0,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            errorMessage: e.message?.slice(0, 500),
            runId: RUN_ID,
          });
        } catch {
          // Don't let recording failure mask the original error
        }
        failed++;
      }
    }
  }

  // Freshness check (daily mode only)
  if (opts.mode === "daily") {
    await checkFreshness();
  }

  return { succeeded, failed, totalRows };
}
