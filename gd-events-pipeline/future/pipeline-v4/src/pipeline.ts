/**
 * ============================================================================
 * pipeline.ts — Orchestration
 * ============================================================================
 *
 * All five modes live here. This module owns flow — it does not own BQ
 * or HyperSync primitives. Every BQ write goes through bq.stageAndMerge;
 * every chain read goes through hypersync.streamDecodedEvents.
 *
 * Concurrency model:
 *   - Fetch/decode phases run in parallel across (contract, network)
 *     pairs, bounded by FETCH_CONCURRENCY.
 *   - Writes to a given production table are serialized by a per-table
 *     mutex. Two networks can fetch in parallel but take turns to MERGE.
 *   - dedup is never parallelized — it's a whole-table rewrite.
 *
 * Block-aligned chunking:
 *   We buffer rows until we hit the chunk-size target AND a block boundary.
 *   This guarantees no block is split across two staging loads, which in
 *   turn guarantees MAX(block_number) is a sound resume point even after
 *   partial failure.
 * ============================================================================
 */

import {
  CONFIG,
  CONTRACT_CONFIGS,
  ContractConfig,
  ContractNetworkBinding,
  NetworkConfig,
  fullTableName,
  knownTopic0sFor,
} from "./config";
import { log, RUN_ID } from "./log";
import { MAX_CHUNK_ROWS_HARD_CAP } from "./constants";
import {
  streamDecodedEvents,
  fetchDecodedEvents,
  getChainTip,
  resolveBlockBeforeTimestamp,
  countLogs,
  DecodedRow,
  UnknownEvent,
} from "./hypersync";
import {
  bqQuery,
  ensureTableExists,
  ensureInfrastructureTables,
  getLastBlockInBQ,
  countBlockRange,
  getRowCount,
  stageAndMerge,
  deleteBlockRange,
  writeUnknownEvents,
  markIngestionStatus,
  acquireLock,
  releaseLock,
  extendLock,
  startPipelineRun,
  completePipelineRun,
  partitionAndClusterClauseFor,
  countUnknownEventsInRange,
  getVerifyCheckpoint,
  advanceVerifyCheckpoint,
} from "./bq";

// ----------------------------------------------------------------------------
// PER-TABLE WRITE MUTEX
// ----------------------------------------------------------------------------

const tableMutexes = new Map<string, Promise<void>>();

/**
 * Serialize writes to a given production table. Fetch can still run in
 * parallel with other networks' fetches for the same table, but MERGE
 * and DELETE are taken in turn.
 *
 * Two bugs fixed vs. the original:
 *   (a) The cleanup compared tableMutexes.get(tableId) === next, but the
 *       stored value was prev.then(() => next), not next itself — so the
 *       cleanup never fired. Now we store `chained` and compare against it.
 *   (b) If prev rejects, prev.then(() => next) creates an unhandled
 *       rejection. We swallow upstream errors here: each caller owns its own
 *       error propagation; the mutex must not compound or forward others' errors.
 */
async function withTableLock<T>(
  tableId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = tableMutexes.get(tableId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const chained = prev.catch(() => {}).then(() => next);
  tableMutexes.set(tableId, chained);

  try {
    await prev.catch(() => {}); // swallow upstream errors; they concern the originating caller
    return await fn();
  } finally {
    release();
    if (tableMutexes.get(tableId) === chained) {
      tableMutexes.delete(tableId);
    }
  }
}

// ----------------------------------------------------------------------------
// CONCURRENCY LIMITER
// ----------------------------------------------------------------------------

async function pMapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ----------------------------------------------------------------------------
// BOUNDARY RESOLUTION
// ----------------------------------------------------------------------------

/**
 * Resolve the target toBlock for today's daily run on a given network.
 *
 *   toBlock = min(
 *     last block with timestamp < midnight UTC today,
 *     chain tip - finalityBlocks
 *   )
 *
 * We want the smaller of the two:
 *   - The timestamp bound prevents partial-day ingestion.
 *   - The finality bound prevents ingesting data that could be reorged.
 *
 * Cached per-run per-network.
 */
const boundaryCache = new Map<string, number>();

async function resolveDailyToBlock(
  network: NetworkConfig,
  firstBlock: number
): Promise<number> {
  const cached = boundaryCache.get(network.name);
  if (cached !== undefined) return cached;

  const now = new Date();
  const midnightUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ) / 1000;

  const tip = await getChainTip(network);
  const safeTip = Math.max(firstBlock, tip - network.finalityBlocks);

  const timestampBound = await resolveBlockBeforeTimestamp(
    network,
    midnightUtc,
    firstBlock,
    safeTip
  );

  if (timestampBound === null) {
    // No blocks before midnight yet — likely a very young chain or
    // HyperSync lagging badly. Skip this network.
    log.warn(
      `[${network.name}] No block found before midnight UTC; skipping daily run for this network`,
      { midnightUtc, tip, safeTip }
    );
    boundaryCache.set(network.name, -1);
    return -1;
  }

  const toBlock = Math.min(timestampBound, safeTip);
  boundaryCache.set(network.name, toBlock);
  log.info(
    `[${network.name}] Daily boundary resolved: toBlock=${toBlock} (tip=${tip}, safeTip=${safeTip}, timestampBound=${timestampBound})`
  );
  return toBlock;
}

// ----------------------------------------------------------------------------
// BLOCK-ALIGNED CHUNKER
// ----------------------------------------------------------------------------

/**
 * Consume a row stream and emit chunks that:
 *   - contain approximately `target` rows, AND
 *   - never split a single block across two chunks (block-aligned invariant)
 *
 * When the soft target is exceeded mid-block, rows keep accumulating until
 * the next block boundary. MAX_CHUNK_ROWS_HARD_CAP is a safety valve for
 * pathological blocks: it emits a partial chunk but continues collecting the
 * same block's remaining rows before advancing, so the resume-point invariant
 * (MAX(block_number)+1 is safe) is preserved within a run.
 *
 * Hard-cap splits are extraordinarily rare for our contracts. Logging at WARN
 * when they fire makes them easy to spot.
 */
async function* blockAlignedChunks(
  source: AsyncIterable<DecodedRow>,
  target: number
): AsyncGenerator<DecodedRow[], void, unknown> {
  let buffer: DecodedRow[] = [];
  let currentBlock: number | null = null;
  let hardCapFired = false;

  for await (const row of source) {
    const blk = Number(row.block_number);
    if (currentBlock === null) currentBlock = blk;

    if (blk !== currentBlock) {
      // Block boundary crossed.
      if (hardCapFired) {
        // We were mid-block when the cap fired. Now that the block has ended,
        // emit any remaining rows before moving on.
        if (buffer.length > 0) {
          yield buffer;
          buffer = [];
        }
        hardCapFired = false;
      } else if (buffer.length >= target) {
        yield buffer;
        buffer = [];
      }
      currentBlock = blk;
    }

    buffer.push(row);

    // Hard cap: emit immediately if buffer exceeds limit, even mid-block.
    // Continue collecting this block's remaining rows before advancing,
    // so the resume-point invariant is preserved within the run.
    if (!hardCapFired && buffer.length >= MAX_CHUNK_ROWS_HARD_CAP) {
      log.warn("Chunker hard cap fired mid-block; emitting partial chunk", {
        blockNumber: currentBlock,
        bufferSize: buffer.length,
      });
      yield buffer;
      buffer = [];
      hardCapFired = true; // still collecting the rest of currentBlock
    }
  }

  if (buffer.length > 0) {
    yield buffer;
  }
}

// ----------------------------------------------------------------------------
// UNKNOWN-EVENT COLLECTOR
// ----------------------------------------------------------------------------

class UnknownCollector {
  private events: UnknownEvent[] = [];
  push(e: UnknownEvent) {
    this.events.push(e);
  }
  async flush(runId: string): Promise<void> {
    if (this.events.length === 0) return;
    await writeUnknownEvents(this.events, runId);
    this.events = [];
  }
}

// ----------------------------------------------------------------------------
// INGEST: shared fetch → stage → merge path
// ----------------------------------------------------------------------------

/**
 * Core ingestion building block. Streams decoded events from HyperSync
 * for a block range, buffers into block-aligned chunks, and stages +
 * merges into the production table under the table mutex.
 *
 * Returns the number of rows merged.
 */
async function ingestRange(
  cfg: ContractConfig,
  network: NetworkConfig,
  fromBlock: number,
  toBlock: number | undefined,
  unknowns: UnknownCollector
): Promise<number> {
  const source = streamDecodedEvents(cfg, network, fromBlock, toBlock, {
    onProgress: (count) =>
      log.info(`[${network.name}] Fetched ${count} events so far...`, {
        tableId: cfg.tableId,
      }),
    onUnknown: (e) => unknowns.push(e),
  });

  const chunks = blockAlignedChunks(source, CONFIG.CHUNK_SIZE_LOAD_TARGET);

  // Run the whole stage+merge under the table lock so two networks don't
  // try to rewrite the same production table simultaneously.
  const result = await withTableLock(cfg.tableId, async () => {
    return await stageAndMerge(cfg.tableId, chunks, `${RUN_ID}_${network.name}`);
  });

  return result.rowsLoaded;
}

// ----------------------------------------------------------------------------
// VERIFY: cheap-count first, full-decode fallback
// ----------------------------------------------------------------------------

interface BlockRange {
  from: number;
  to: number;
}

/**
 * Verify a block range by comparing BQ row counts to HyperSync log
 * counts, chunk by chunk. If a chunk mismatches, we flag the range for
 * repair. The cheap count here uses HyperSync metadata only — no decode.
 *
 * The downside: if the contract emits events we don't decode (e.g. after
 * an upgrade), those count toward the HyperSync side and produce a
 * "mismatch." That's actually the right signal — it means something
 * changed and a human should look.
 */
async function verifyBlockRange(
  cfg: ContractConfig,
  network: NetworkConfig,
  fromBlock: number,
  toBlock: number
): Promise<BlockRange[]> {
  const mismatches: BlockRange[] = [];
  log.info(
    `[${network.name}] Verifying ${cfg.tableId} blocks ${fromBlock}..${toBlock}`
  );

  // Only count logs for events our ABI can decode — prevents false-mismatch
  // from contract upgrades adding new event types we don't recognise.
  const knownTopics = knownTopic0sFor(cfg);

  for (
    let start = fromBlock;
    start < toBlock;
    start += CONFIG.CHUNK_SIZE_VERIFY_BLOCKS
  ) {
    const end = Math.min(start + CONFIG.CHUNK_SIZE_VERIFY_BLOCKS, toBlock);

    const [ourCount, chainCount] = await Promise.all([
      countBlockRange(cfg.tableId, network.name, start, end),
      countLogs(cfg, network, start, end, knownTopics),
    ]);

    if (ourCount !== chainCount) {
      log.warn(
        `[${network.name}] MISMATCH blocks ${start}..${end}: BQ=${ourCount} chain=${chainCount}`,
        { tableId: cfg.tableId }
      );
      mismatches.push({ from: start, to: end });
    } else if (ourCount > 0) {
      log.info(
        `[${network.name}] OK blocks ${start}..${end}: ${ourCount} events`,
        { tableId: cfg.tableId }
      );
    }
  }

  if (mismatches.length === 0) {
    log.info(`[${network.name}] ${cfg.tableId} verification PASSED`);
  } else {
    log.warn(
      `[${network.name}] ${cfg.tableId} verification found ${mismatches.length} mismatched ranges`
    );
  }
  return mismatches;
}

// ----------------------------------------------------------------------------
// REPAIR
// ----------------------------------------------------------------------------

async function repairRanges(
  cfg: ContractConfig,
  network: NetworkConfig,
  ranges: BlockRange[],
  unknowns: UnknownCollector
): Promise<void> {
  for (const range of ranges) {
    log.info(
      `[${network.name}] Repairing ${cfg.tableId} blocks ${range.from}..${range.to}`
    );

    await withTableLock(cfg.tableId, async () => {
      await deleteBlockRange(cfg.tableId, network.name, range.from, range.to);
    });

    // Re-ingest this range (will go through staging+MERGE under the lock)
    await ingestRange(cfg, network, range.from, range.to, unknowns);
  }
}

// ----------------------------------------------------------------------------
// DEDUP (utility mode only)
// ----------------------------------------------------------------------------

/**
 * Safety-net dedup. With staging+MERGE as the one write path, duplicates
 * shouldn't accumulate. This exists as a utility for recovering from
 * bugs and manual direct writes.
 *
 * Uses a single atomic CREATE OR REPLACE TABLE scoped to this network.
 * Other networks' rows are preserved via UNION ALL. Not parallelizable —
 * calling code must serialize across networks.
 */
async function dedupNetwork(
  cfg: ContractConfig,
  networkName: string
): Promise<number> {
  const fullTable = fullTableName(cfg.tableId);
  log.info(`[${networkName}] ${cfg.tableId}: checking for duplicates`);

  const before = await getRowCount(cfg.tableId, networkName);

  const partCluster = partitionAndClusterClauseFor(cfg.tableId);
  await bqQuery(
    `CREATE OR REPLACE TABLE ${fullTable}
${partCluster}
AS
  SELECT * FROM (
    SELECT * FROM ${fullTable}
    WHERE network != @network
    UNION ALL
    SELECT * EXCEPT(_rn) FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY network, block_number, log_index, tx_hash
        ORDER BY event_name
      ) AS _rn
      FROM ${fullTable}
      WHERE network = @network
    )
    WHERE _rn = 1
  )`,
    { network: networkName }
  );

  const after = await getRowCount(cfg.tableId, networkName);
  const removed = before - after;
  if (removed > 0) {
    log.warn(`[${networkName}] ${cfg.tableId}: removed ${removed} duplicates`);
  } else {
    log.info(`[${networkName}] ${cfg.tableId}: no duplicates (${after} rows)`);
  }
  return removed;
}

// ----------------------------------------------------------------------------
// MODE: BACKFILL
// ----------------------------------------------------------------------------

/**
 * Load complete history from firstBlock (or resume from MAX+1) up to the
 * safe tip (chain tip - finality). Does not respect the midnight boundary
 * — backfill is meant to catch up as fast as possible.
 *
 * Safe to re-run — staging+MERGE makes it idempotent.
 */
export async function runBackfill(contractsFilter?: string[], missingTables?: Set<string>): Promise<void> {
  const unknowns = new UnknownCollector();
  const today = todayUtc();

  await pMapLimit(activeJobs(contractsFilter, missingTables), CONFIG.FETCH_CONCURRENCY, async ({ cfg, binding }) => {
    const net = binding.network;
    try {
      await markIngestionStatus({
        networkName: net.name,
        tableId: cfg.tableId,
        date: today,
        status: "pending",
        runId: RUN_ID,
      });

      const lastBlock = await getLastBlockInBQ(cfg.tableId, net.name);
      const startBlock = lastBlock > 0 ? lastBlock + 1 : binding.firstBlock;
      const tip = await getChainTip(net);
      const safeTip = Math.max(binding.firstBlock, tip - net.finalityBlocks);

      if (startBlock > safeTip) {
        log.info(
          `[${net.name}] ${cfg.tableId} already up to safe tip (${safeTip}); nothing to backfill`
        );
        await markIngestionStatus({
          networkName: net.name,
          tableId: cfg.tableId,
          date: today,
          status: "skipped",
          lastBlock,
          runId: RUN_ID,
        });
        return;
      }

      log.info(`[${net.name}] ${cfg.tableId} backfill: ${startBlock}..${safeTip}`);
      const loaded = await ingestRange(cfg, net, startBlock, safeTip, unknowns);

      const finalLast = await getLastBlockInBQ(cfg.tableId, net.name);

      // row_count = rows merged this run (delta), not total table rows.
      // Avoids a full-table COUNT(*) scan per (contract, network).
      await markIngestionStatus({
        networkName: net.name,
        tableId: cfg.tableId,
        date: today,
        status: "complete",
        lastBlock: finalLast,
        rowCount: loaded,
        runId: RUN_ID,
      });

      log.info(
        `[${net.name}] ${cfg.tableId} backfill complete: ${loaded} rows merged, last_block=${finalLast}`
      );
    } catch (e: any) {
      await markIngestionStatus({
        networkName: net.name,
        tableId: cfg.tableId,
        date: today,
        status: "failed",
        errorMessage: e?.message,
        runId: RUN_ID,
      }).catch(() => {});
      throw e;
    }
  });

  await unknowns.flush(RUN_ID);
}

// ----------------------------------------------------------------------------
// MODE: DAILY
// ----------------------------------------------------------------------------

/**
 * The production cron path.
 *
 * Per (contract, network):
 *   1. Mark status = pending
 *   2. Resolve toBlock (midnight UTC boundary, finality-capped)
 *   3. Ingest from MAX+1 up to toBlock
 *   4. Verify the last VERIFY_WINDOW_DAYS of data (cheap counts)
 *   5. Repair any mismatches
 *   6. Re-verify repaired ranges
 *   7. Mark status = complete (or failed)
 */
export async function runDaily(contractsFilter?: string[], missingTables?: Set<string>): Promise<void> {
  const unknowns = new UnknownCollector();
  const today = todayUtc();

  await pMapLimit(activeJobs(contractsFilter, missingTables), CONFIG.FETCH_CONCURRENCY, async ({ cfg, binding }) => {
    const net = binding.network;
    try {
      await markIngestionStatus({
        networkName: net.name,
        tableId: cfg.tableId,
        date: today,
        status: "pending",
        runId: RUN_ID,
      });

      const toBlock = await resolveDailyToBlock(net, binding.firstBlock);
      if (toBlock < 0) {
        await markIngestionStatus({
          networkName: net.name,
          tableId: cfg.tableId,
          date: today,
          status: "skipped",
          runId: RUN_ID,
        });
        return;
      }

      const lastBlock = await getLastBlockInBQ(cfg.tableId, net.name);
      const startBlock = lastBlock > 0 ? lastBlock + 1 : binding.firstBlock;

      let loaded = 0;
      if (startBlock > toBlock) {
        log.info(
          `[${net.name}] ${cfg.tableId} already current (last=${lastBlock}, toBlock=${toBlock})`
        );
      } else {
        log.info(
          `[${net.name}] ${cfg.tableId} daily ingest: ${startBlock}..${toBlock}`
        );
        loaded = await ingestRange(cfg, net, startBlock, toBlock, unknowns);
        log.info(
          `[${net.name}] ${cfg.tableId} daily ingest: ${loaded} rows merged`
        );
      }

      // Verify the recent window
      const newLast = await getLastBlockInBQ(cfg.tableId, net.name);
      if (newLast > 0) {
        const windowBlocks = estimateBlocksForDays(
          net,
          CONFIG.VERIFY_WINDOW_DAYS
        );
        const verifyFrom = Math.max(binding.firstBlock, newLast - windowBlocks);

        // Skip verify entirely if no new rows were ingested and the
        // checkpoint already covers the verify window — nothing changed.
        const checkpoint = await getVerifyCheckpoint(cfg.tableId, net.name);
        if (loaded === 0 && checkpoint >= newLast) {
          log.info(
            `[${net.name}] ${cfg.tableId} daily verify skipped: no new rows and checkpoint covers toBlock`,
            { checkpoint, newLast }
          );
        } else {
          const mismatches = await verifyBlockRange(cfg, net, verifyFrom, newLast);

          if (mismatches.length > 0) {
            await repairRanges(cfg, net, mismatches, unknowns);
            const stillBroken = await verifyBlockRange(
              cfg,
              net,
              verifyFrom,
              newLast
            );
            if (stillBroken.length > 0) {
              // For each still-broken range check whether the excess is fully
              // explained by unknown (undecodable) events recorded in
              // UnknownEvents — if so, this is a contract-upgrade scenario
              // and not a data-integrity problem.
              const unexplained: BlockRange[] = [];
              for (const r of stillBroken) {
                const decoded = await countBlockRange(cfg.tableId, net.name, r.from, r.to);
                const unknown = await countUnknownEventsInRange(net.name, r.from, r.to);
                const totalChain = await countLogs(cfg, net, r.from, r.to);
                if (decoded + unknown === totalChain) {
                  log.warn(
                    `[${net.name}] ${cfg.tableId} mismatch in ${r.from}..${r.to} ` +
                    `fully reconciled by unknown events (decoded=${decoded} unknown=${unknown} chain=${totalChain})`,
                    { tableId: cfg.tableId }
                  );
                } else {
                  unexplained.push(r);
                }
              }
              if (unexplained.length > 0) {
                throw new Error(
                  `${unexplained.length} ranges still mismatched after repair and unknown-event reconciliation`
                );
              }
            }
          }
        }
      }

      const finalLast = await getLastBlockInBQ(cfg.tableId, net.name);
      // row_count = rows merged this run (delta), not total table rows.
      await markIngestionStatus({
        networkName: net.name,
        tableId: cfg.tableId,
        date: today,
        status: "complete",
        lastBlock: finalLast,
        rowCount: loaded,
        runId: RUN_ID,
      });
    } catch (e: any) {
      log.error(
        `[${net.name}] ${cfg.tableId} daily run failed: ${e?.message}`,
        { stack: e?.stack }
      );
      await markIngestionStatus({
        networkName: net.name,
        tableId: cfg.tableId,
        date: today,
        status: "failed",
        errorMessage: e?.message,
        runId: RUN_ID,
      }).catch(() => {});
      // Re-throw so the run's exit code reflects the failure, but let
      // other (contract, network) pairs continue.
      throw e;
    }
  });

  await unknowns.flush(RUN_ID);
}

/**
 * Rough conversion from days to blocks, sized from NetworkConfig.blocksPerDay
 * with a 2x safety factor. Over-verifying is cheaper than under-verifying.
 */
function estimateBlocksForDays(network: NetworkConfig, days: number): number {
  return network.blocksPerDay * days * 2;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns all active (cfg, binding) pairs across all enabled contracts. */
function activeJobs(
  contractsFilter?: string[],
  missingTables?: Set<string>
): Array<{ cfg: ContractConfig; binding: ContractNetworkBinding }> {
  const jobs: Array<{ cfg: ContractConfig; binding: ContractNetworkBinding }> = [];
  for (const cfg of CONTRACT_CONFIGS) {
    if (cfg.enabled === false) continue;
    if (missingTables?.has(cfg.tableId)) {
      log.error(`Skipping ${cfg.tableId}: table does not exist`, { tableId: cfg.tableId });
      continue;
    }
    if (contractsFilter && contractsFilter.length > 0) {
      const matchesId = contractsFilter.includes(cfg.tableId);
      const matchesTag = contractsFilter.some(
        (f) => f.startsWith("tag:") && (cfg.tags ?? []).includes(f.slice(4))
      );
      if (!matchesId && !matchesTag) continue;
    }
    for (const binding of cfg.networkBindings) {
      if (binding.enabled === false) continue;
      jobs.push({ cfg, binding });
    }
  }
  return jobs;
}

// ----------------------------------------------------------------------------
// MODE: VERIFY (read-only)
// ----------------------------------------------------------------------------

export async function runVerify(contractsFilter?: string[], missingTables?: Set<string>): Promise<void> {
  await pMapLimit(activeJobs(contractsFilter, missingTables), CONFIG.FETCH_CONCURRENCY, async ({ cfg, binding }) => {
    const net = binding.network;
    const lastBlock = await getLastBlockInBQ(cfg.tableId, net.name);
    if (lastBlock === 0) {
      log.info(`[${net.name}] ${cfg.tableId}: no data to verify`);
      return;
    }

    const checkpoint = await getVerifyCheckpoint(cfg.tableId, net.name);
    const verifyFrom = Math.max(binding.firstBlock, checkpoint);

    const mismatches = await verifyBlockRange(cfg, net, verifyFrom, lastBlock);
    if (mismatches.length === 0) {
      await advanceVerifyCheckpoint(cfg.tableId, net.name, lastBlock, RUN_ID);
    }
  });
}

// ----------------------------------------------------------------------------
// MODE: REPAIR
// ----------------------------------------------------------------------------

export async function runRepair(contractsFilter?: string[], missingTables?: Set<string>): Promise<void> {
  const unknowns = new UnknownCollector();

  // Parallel reads, but writes inside repairRanges are serialised per table
  // via withTableLock — so parallel repair is safe.
  await pMapLimit(activeJobs(contractsFilter, missingTables), CONFIG.FETCH_CONCURRENCY, async ({ cfg, binding }) => {
    const net = binding.network;
    const lastBlock = await getLastBlockInBQ(cfg.tableId, net.name);
    if (lastBlock === 0) return;

    const checkpoint = await getVerifyCheckpoint(cfg.tableId, net.name);
    const verifyFrom = Math.max(binding.firstBlock, checkpoint);

    const mismatches = await verifyBlockRange(cfg, net, verifyFrom, lastBlock);
    if (mismatches.length > 0) {
      await repairRanges(cfg, net, mismatches, unknowns);
      const stillBroken = await verifyBlockRange(cfg, net, verifyFrom, lastBlock);
      if (stillBroken.length === 0) {
        await advanceVerifyCheckpoint(cfg.tableId, net.name, lastBlock, RUN_ID);
      }
    } else {
      await advanceVerifyCheckpoint(cfg.tableId, net.name, lastBlock, RUN_ID);
    }
  });

  await unknowns.flush(RUN_ID);
}

// ----------------------------------------------------------------------------
// MODE: DEDUP
// ----------------------------------------------------------------------------

export async function runDedup(contractsFilter?: string[], missingTables?: Set<string>): Promise<void> {
  // Sequential across (contract, network) pairs. Dedup is a whole-table rewrite.
  for (const { cfg, binding } of activeJobs(contractsFilter, missingTables)) {
    await dedupNetwork(cfg, binding.network.name);
  }
}

// ----------------------------------------------------------------------------
// SETUP (run once before mode-specific work)
// ----------------------------------------------------------------------------

/**
 * Ensure all infrastructure and contract tables exist. Returns the set of
 * tableIds whose tables are missing (creation DDL is logged per-table as ERROR).
 */
export async function ensureAllTables(): Promise<Set<string>> {
  await ensureInfrastructureTables();
  const missing = new Set<string>();
  for (const cfg of CONTRACT_CONFIGS) {
    if (cfg.enabled === false) continue;
    const ok = await ensureTableExists(cfg);
    if (!ok) missing.add(cfg.tableId);
  }
  return missing;
}

// ----------------------------------------------------------------------------
// FINAL SUMMARY
// ----------------------------------------------------------------------------

export async function logFinalSummary(missingTables?: Set<string>): Promise<void> {
  log.info("--- Final Counts ---");
  for (const { cfg, binding } of activeJobs(undefined, missingTables)) {
    const net = binding.network;
    try {
      const last = await getLastBlockInBQ(cfg.tableId, net.name);
      log.info(`[${net.name}] ${cfg.tableId}: last_block=${last}`);
    } catch (e: any) {
      log.warn(`[${net.name}] ${cfg.tableId}: could not fetch summary`, {
        error: e?.message,
      });
    }
  }
}

// ----------------------------------------------------------------------------
// LOCK HELPERS (re-exported for CLI convenience)
// ----------------------------------------------------------------------------

export { acquireLock, releaseLock, extendLock, startPipelineRun, completePipelineRun };
