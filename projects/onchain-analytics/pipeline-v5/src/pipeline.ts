/**
 * pipeline.ts -- Orchestration. Daily and backfill flows.
 * Sequential processing, block-aligned chunking, freshness monitoring.
 */

import { CONFIG, CONTRACTS } from "./config.js";
import { log, RUN_ID } from "./log.js";
import { getChainTip, resolveDailyToBlock, streamEvents } from "./hypersync.js";
import {
  getLastBlock,
  countRows,
  getMaxBlockTimestamp,
  ensureInfraTables,
  stageAndMerge,
  recordIngestionStatus,
  recordPipelineRun,
} from "./bq.js";
import { alertStaleness } from "./slack.js";
import type { PipelineOpts, PipelineResult, ContractConfig, DecodedRow, LogContext } from "./types.js";

/**
 * Process one (contract, network) pair. Returns rows merged.
 */
async function processBinding(
  cfg: ContractConfig,
  bindingIdx: number,
  opts: PipelineOpts
): Promise<number> {
  const binding = cfg.networkBindings[bindingIdx];
  const { network, firstBlock, contracts } = binding;
  const startedAt = new Date().toISOString();

  // Determine block range
  let fromBlock: number;
  if (opts.fromBlock !== undefined) {
    fromBlock = opts.fromBlock;
  } else if (opts.mode === "backfill") {
    fromBlock = firstBlock;
  } else {
    const lastBlock = await getLastBlock(cfg.tableId, network.name);
    // +1 is safe because block-aligned chunking guarantees the last block was fully written
    fromBlock = lastBlock > 0 ? lastBlock + 1 : firstBlock;
  }

  let toBlock: number | undefined;
  if (opts.toBlock !== undefined) {
    toBlock = opts.toBlock;
  } else if (opts.mode === "daily") {
    toBlock = await resolveDailyToBlock(network) ?? undefined;
  } else {
    toBlock = await getChainTip(network) ?? undefined;
  }

  log.info(`Processing ${cfg.tableId}/${network.name}: blocks ${fromBlock}..${toBlock ?? "latest"}`);

  // Detect stuck indexer: if toBlock is defined and barely ahead of fromBlock, warn
  if (toBlock !== undefined && toBlock <= fromBlock) {
    log.warn(`Nothing to fetch: toBlock (${toBlock}) <= fromBlock (${fromBlock}). Indexer may be stuck.`, {
      tableId: cfg.tableId, network: network.name, fromBlock, toBlock,
    });
    // Record as success with 0 rows (not an error -- the pipeline worked, the source is stale)
    const completedAt = new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);
    await recordIngestionStatus({
      network: network.name,
      tableId: cfg.tableId,
      ingestionDate: today,
      status: "success",
      lastBlock: fromBlock,
      rowCount: 0,
      startedAt,
      completedAt,
      runId: RUN_ID,
    });
    return 0;
  }

  if (toBlock !== undefined && toBlock - fromBlock < 100) {
    log.warn(`Very small range (${toBlock - fromBlock} blocks). Data source may not be advancing.`, {
      tableId: cfg.tableId, network: network.name,
    });
  }
  // Stream and buffer into block-aligned chunks
  let buffer: Record<string, any>[] = [];
  let lastBlockInBuffer = -1;
  let totalMerged = 0;

  for await (const batch of streamEvents(network, contracts, cfg.abi, fromBlock, toBlock)) {
    for (const raw of batch) {
      const logCtx: LogContext = {
        blockNumber: raw.blockNumber,
        blockHash: raw.blockHash,
        blockTimestamp: raw.blockTimestamp,
        txHash: raw.txHash,
        txIndex: raw.txIndex,
        logIndex: raw.logIndex,
        contractAddress: raw.contractAddress,
      };
      const row = cfg.decodeToRow(raw._eventName, raw._args, logCtx, network.name);
      if (row === null) continue;

      // Block-aligned flush: flush when buffer >= target AND we've crossed a block boundary
      if (buffer.length >= CONFIG.CHUNK_SIZE_TARGET && row.block_number > lastBlockInBuffer) {
        const { rowsMerged } = await stageAndMerge(cfg.tableId, buffer, cfg.schema, RUN_ID);
        totalMerged += rowsMerged;
        log.info(`Chunk merged: ${rowsMerged} rows (total: ${totalMerged})`, { tableId: cfg.tableId, network: network.name });
        buffer = [];
      }

      buffer.push(row);
      lastBlockInBuffer = row.block_number;
    }
  }

  // Flush remaining
  if (buffer.length > 0) {
    const { rowsMerged } = await stageAndMerge(cfg.tableId, buffer, cfg.schema, RUN_ID);
    totalMerged += rowsMerged;
    log.info(`Final chunk merged: ${rowsMerged} rows (total: ${totalMerged})`, { tableId: cfg.tableId, network: network.name });
  }

  // Record ingestion status
  const completedAt = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  await recordIngestionStatus({
    network: network.name,
    tableId: cfg.tableId,
    ingestionDate: today,
    status: "success",
    lastBlock: lastBlockInBuffer,
    rowCount: totalMerged,
    startedAt,
    completedAt,
    runId: RUN_ID,
  });

  log.info(`Done: ${cfg.tableId}/${network.name} -- ${totalMerged} rows merged`);
  return totalMerged;
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
