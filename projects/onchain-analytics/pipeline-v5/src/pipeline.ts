/**
 * pipeline.ts
 *
 * Ingestion for one (contract, chain) capture, and the run orchestration around it.
 *
 * THE THREE DEFECTS THIS FILE IS WRITTEN AGAINST, all measured in production data.
 *
 * DUPLICATION. A block range was written twice, four months apart, producing 43,000 phantom claim
 * rows and 2,167 phantom invite rows. The write path is a MERGE on the target's own key, so
 * re-running a range is free. Under v4 that key carries chain_id rather than a network NAME,
 * which the v4 tables do not declare: all eight of the previous statements were refused against a
 * table built from the shipping DDL, on an unguarded copy as well as a guarded one.
 *
 * OMISSION, which is independent of the duplication and was invisible until the contract was
 * asked. Four real claims are absent from the warehouse, on three days that carried no duplicates
 * at all. The predecessor flushed a fixed 1,000-row batch with no regard for block boundaries, so
 * a run that ended mid-stream left its final block PARTIALLY written, and the next run resumed at
 * MAX(block_number) + 1 and never looked at that block again. Buffers now flush on a block
 * boundary, so a write never splits a block in the first place.
 *
 * THE HOLE THE WATERMARK CANNOT SEE, which is the one this rewrite closes. A failed chunk is
 * recorded and the loop CONTINUES; later chunks are written during the fetch; the throw comes
 * after those writes; and the next run resumed from MAX(block_number), which is above the gap.
 * Measured on a seeded example: a hole at 200 to 299 between two clean captures gives a watermark
 * of 301 and a coverage frontier of 199. So resume is now computed from IngestionCoverage, which
 * can represent a hole, and never from the data. See coverage.ts.
 *
 * AND ONE RULE UNDERNEATH ALL OF IT: a chunk that returns nothing is a NEGATIVE, not a result. An
 * identical repeated log query on this project's endpoints returned zero seven times in ten one
 * day and three times in ten the day before, with no errors raised. An unconfirmed empty range
 * does not let the frontier past it.
 */

import {
  CONFIG, selectedNetworks, RAW_LOGS_TABLE, TRANSACTIONS_TABLE,
  RAW_LOGS_SCHEMA, TRANSACTIONS_SCHEMA,
} from "./config.js";
import { log, RUN_ID } from "./log.js";
import { fetchRange, getChainTip, readerFor, gradeCapture } from "./reader.js";
import { confirmEmptyRange } from "./rpc.js";
import { targetsFor, eraIndexFor } from "./registry.js";
import { rawLogRows, transactionRows, missingTransactionCount } from "./rawrow.js";
import { windowForRows, widen } from "./window.js";
import {
  ensureInfraTables, stageAndMerge, recordCoverage, getMaxBlockTimestamp, setCaptureAssurance,
} from "./bq.js";
import { loadCoverage, computeResumePoint } from "./coverage.js";
import { checkCaptureSpan, checkRunSize } from "./budget.js";
import { alertStaleness } from "./slack.js";
import type {
  PipelineOpts, PipelineResult, CaptureTarget, CoverageRecord, FetchResult, NetworkConfig,
  MergeWindow,
} from "./types.js";

export class IncompleteFetchError extends Error {}

/**
 * One capture: one source reading one contract over one block range, ONCE.
 *
 * The sequence number is not decoration and it was added because a live run exposed the defect.
 * Deriving the id from the run and the range alone makes a re-read of the same range inside one
 * run carry the IDENTICAL id, which happens every time repair re-reads a gap. Three captures then
 * share one capture_id, and RawLogs.capture_id joins IngestionCoverage.capture_id, so a row could
 * no longer name the capture that produced it. L0-6 exists precisely because a range was once
 * ingested twice and nobody could tell which run wrote which row.
 */
let captureSeq = 0;
function captureIdFor(target: CaptureTarget, fromBlock: number, toBlock: number): string {
  captureSeq += 1;
  return `${RUN_ID}:${captureSeq}:${target.chainId}:${target.address}:${fromBlock}-${toBlock}`;
}

/** The common part of a coverage row, so no call site can forget a field. */
function baseCoverage(
  target: CaptureTarget,
  captureId: string,
  fromBlock: number,
  toBlock: number,
  startedAt: string
): CoverageRecord {
  return {
    captureId, runId: RUN_ID,
    chainId: target.chainId, network: target.network.name,
    contractAddress: target.address,
    targetTable: RAW_LOGS_TABLE, tableId: RAW_LOGS_TABLE,
    fromBlock, toBlock,
    status: "incomplete",
    chunksPlanned: 0, chunksOk: 0, skippedRanges: "[]",
    rowsMerged: 0, rowsInserted: 0, rowsUpdated: 0, logsSeen: 0,
    sourceKind: "unknown", sourceId: "unknown",
    confirmingSourceKind: null, confirmingSourceId: null,
    confirmationResult: "unavailable",
    assurance: "C",
    headAtCapture: null, missRateCalibrated: null, passesRun: null, gainSeries: null,
    startedAt, completedAt: new Date().toISOString(),
    errorMessage: "",
  };
}

/**
 * Record that a chain cannot be read, rather than skipping it.
 *
 * L0-8 in its plainest form. A chain with no adequate reader produces no rows, and a query over
 * those rows returns nothing, and nothing looks exactly like "no activity". A capability gap row
 * is what separates the two, and it claims no coverage while it does so.
 */
async function recordCapabilityGap(network: NetworkConfig, reason: string): Promise<void> {
  const startedAt = new Date().toISOString();
  log.error(`CAPABILITY GAP on ${network.name}: ${reason}. No coverage is claimed for this chain.`);
  await recordCoverage({
    captureId: `${RUN_ID}:${network.chainId}:capability_gap`,
    runId: RUN_ID,
    chainId: network.chainId, network: network.name,
    contractAddress: null,
    targetTable: RAW_LOGS_TABLE, tableId: RAW_LOGS_TABLE,
    fromBlock: 0, toBlock: 0,
    status: "capability_gap",
    chunksPlanned: 0, chunksOk: 0, skippedRanges: "[]",
    rowsMerged: 0, rowsInserted: 0, rowsUpdated: 0, logsSeen: 0,
    sourceKind: "unknown", sourceId: "none",
    confirmingSourceKind: null, confirmingSourceId: null,
    confirmationResult: "unavailable",
    assurance: "C",
    headAtCapture: null, missRateCalibrated: null, passesRun: null, gainSeries: null,
    startedAt, completedAt: new Date().toISOString(),
    errorMessage: reason.slice(0, 4000),
  });
}

/**
 * Ingest one contract on one chain. Throws on an incomplete fetch rather than recording a
 * success, because a partial range recorded as a success is precisely how a gap becomes permanent.
 *
 * Exported because repair drives the SAME code path over a named range. The previous repair
 * carried its own copy of the fetch, decode and write loop, about sixty-five lines duplicated
 * almost verbatim, so a fix to one path silently left the other behind.
 */
export async function processTarget(target: CaptureTarget, opts: PipelineOpts): Promise<number> {
  const { network } = target;
  const startedAt = new Date().toISOString();
  const label = `${target.contractName} ${target.address} on ${network.name}`;

  // ---------------------------------------------------------------- resolve the block range
  let fromBlock: number;
  if (opts.fromBlock !== undefined) {
    fromBlock = opts.fromBlock;
  } else if (opts.mode === "backfill") {
    fromBlock = target.firstBlock;
  } else {
    const captures = await loadCoverage(target.chainId, RAW_LOGS_TABLE, target.address);
    const resume = computeResumePoint(captures, target.firstBlock);
    fromBlock = resume.resumeAt;
    log.info(`Resume ${label} at ${fromBlock}: ${resume.reason}`, {
      capturesConsidered: resume.capturesConsidered,
      capturesClean: resume.capturesClean,
      coveredUpTo: resume.coveredUpTo,
    });
  }

  let toBlock: number;
  if (opts.toBlock !== undefined) {
    toBlock = opts.toBlock;
  } else {
    const tip = await getChainTip(network);
    if (tip === null) {
      throw new Error(
        `Chain tip unavailable for ${network.name}. Refusing to fetch to an unknown end: ` +
        `an unbounded range cannot be reported complete.`
      );
    }
    // Stay behind the tip so a reorganisation cannot rewrite what was just written. The margin
    // and its provenance are in config.ts; on the one chain that publishes no finality tag at
    // all, the margin is a stated time budget rather than a measurement, and every row there
    // carries confirmations_at_capture so a consumer can apply its own threshold instead.
    toBlock = tip - network.finality.blocks;
  }

  const captureId = captureIdFor(target, fromBlock, toBlock);
  log.info(`Capture ${captureId}: blocks ${fromBlock}..${toBlock}`, {
    mode: opts.mode, reader: readerFor(network).id,
    finality: network.finality.blocks, finalityTag: network.finality.publishesFinalizedTag,
  });

  if (toBlock < fromBlock) {
    const row = baseCoverage(target, captureId, fromBlock, toBlock, startedAt);
    row.status = "nothing_to_fetch";
    row.sourceKind = readerFor(network).kind === "index" ? "index" : "rpc";
    row.sourceId = readerFor(network).id;
    await recordCoverage(row);
    log.warn(`Nothing to fetch for ${label}: toBlock ${toBlock} is below fromBlock ${fromBlock}`);
    return 0;
  }

  // The span budget. A refusal is a ROW, not a silence: a range nobody read and nothing recorded
  // is the one state L0-8 exists to prevent, and a guard that produced it would be trading one
  // defect for another.
  const span = checkCaptureSpan(network, fromBlock, toBlock, opts);
  if (!span.allowed) {
    const row = baseCoverage(target, captureId, fromBlock, toBlock, startedAt);
    row.status = "refused_budget";
    row.sourceKind = readerFor(network).kind === "index" ? "index" : "rpc";
    row.sourceId = readerFor(network).id;
    row.errorMessage = (span.reason ?? "").slice(0, 4000);
    await recordCoverage(row);
    log.error(`REFUSED ${label}: ${span.reason}`, {
      requestedBlocks: span.requested, limitBlocks: span.limit,
    });
    return 0;
  }

  // --------------------------------------------------------------------- fetch and write
  const eras = eraIndexFor(target.chainId, target.address);
  if (eras.length === 0) {
    // Not fatal. era_resolution 'unresolved' is a permitted and honest value, and a row that does
    // not know its era says so. It is logged because it means the seed does not describe this
    // contract, which is a registry gap rather than an ingestion one.
    log.warn(`No era map for ${label}; every row will carry era_resolution 'unresolved'`);
  }

  let logBuffer: Record<string, any>[] = [];
  let txBuffer: Record<string, any>[] = [];
  let lastBlockInBuffer = -1;
  let inserted = 0;
  let updated = 0;
  let distinctOffered = 0;
  let reorgSuspects = 0;
  let txInserted = 0;
  let txUpdated = 0;
  let missingTx = 0;
  const ingestedAt = new Date().toISOString();
  // The widest window any flush of this capture actually wrote under, kept so the grade can be
  // applied afterwards over exactly the partitions the rows landed in and no more.
  let writtenWindow: MergeWindow | null = null;

  /**
   * Write what is buffered.
   *
   * THE WINDOW IS COMPUTED HERE, FROM THE ROWS THEMSELVES, and this is the only place in the
   * system where that can happen. L0-9: the predicate on the MERGE target has to be a LITERAL,
   * because a subquery in the ON clause is refused by BigQuery outright and a predicate correlated
   * to the source row is refused by the partition guard. The timestamps come from the rows, each
   * of which carries the block timestamp its reader returned, and block_timestamp is NOT NULL, so
   * the window is undefined only when there is nothing to write.
   */
  const flush = async () => {
    if (logBuffer.length > 0) {
      const w = windowForRows(logBuffer, CONFIG.MERGE_PADDING_MONTHS);
      if (w === null) throw new Error("L0_9: rows to write but no window could be derived");
      writtenWindow = widen(writtenWindow, w);
      const r = await stageAndMerge(RAW_LOGS_TABLE, logBuffer, RAW_LOGS_SCHEMA, RUN_ID, w);
      inserted += r.inserted;
      updated += r.updated;
      distinctOffered += r.distinct;
      reorgSuspects += r.reorgSuspects;
      logBuffer = [];
    }
    if (txBuffer.length > 0) {
      const w = windowForRows(txBuffer, CONFIG.MERGE_PADDING_MONTHS);
      if (w === null) throw new Error("L0_9: transactions to write but no window could be derived");
      writtenWindow = widen(writtenWindow, w);
      const r = await stageAndMerge(TRANSACTIONS_TABLE, txBuffer, TRANSACTIONS_SCHEMA, RUN_ID, w);
      txInserted += r.inserted;
      txUpdated += r.updated;
      txBuffer = [];
    }
  };

  // THE FETCH AND THE WRITE SIT INSIDE A try, AND THAT IS NOT DEFENSIVE HABIT. If this throws
  // part way, rows are already in the table and, without the catch below, no coverage row would
  // exist for the range that produced them. That is the one state L0-8 exists to prevent: data
  // present, and nothing recording that anybody looked. A live run found this by failing here.
  let fetch: FetchResult;
  try {
    fetch = await fetchRange(network, [target.address], fromBlock, toBlock, async (chunk) => {
      const ctx = {
        chainId: target.chainId,
        captureId, runId: RUN_ID,
        sourceKind: chunk.sourceKind, sourceId: chunk.sourceId,
        // Provisional. The final grade is decided once the whole range is known, because a grade
        // is a property of the capture and not of one chunk, and it is rewritten onto the rows by
        // the MERGE if a later chunk lowers it.
        assurance: "C" as const,
        headAtCapture: chunk.archiveHeight,
        ingestedAt,
      };

      const logs = rawLogRows(chunk, ctx, eras);
      const txs = transactionRows(chunk, ctx);
      missingTx += missingTransactionCount(chunk, txs.length);

      // Readers return logs in block order. Flushing only when the incoming row belongs to a
      // LATER block than anything buffered guarantees a write never splits a block, which is the
      // property the resume point depends on.
      for (const row of logs) {
        if (logBuffer.length >= CONFIG.CHUNK_SIZE_TARGET && row.block_number > lastBlockInBuffer) {
          await flush();
        }
        logBuffer.push(row);
        if (row.block_number > lastBlockInBuffer) lastBlockInBuffer = row.block_number;
      }
      txBuffer.push(...txs);
    });

    await flush();
  } catch (e: any) {
    const failed = baseCoverage(target, captureId, fromBlock, toBlock, startedAt);
    failed.status = "incomplete";
    failed.rowsInserted = inserted;
    failed.rowsUpdated = updated;
    failed.rowsMerged = distinctOffered;
    failed.sourceKind = readerFor(network).kind === "index" ? "index" : "rpc";
    failed.sourceId = readerFor(network).id;
    failed.errorMessage =
      `CAPTURE_THREW: ${String(e?.message ?? e)}. Any rows already written for this range are ` +
      `present without a clean capture, so the resume point stays at or below ${fromBlock}.`.slice(0, 4000);
    // A failure to record the failure is worse than the failure, so it is logged rather than
    // allowed to replace the original error.
    try { await recordCoverage(failed); } catch (e2: any) {
      log.error(`Could not record the coverage row for a failed capture: ${e2.message}`, { capture: captureId });
    }
    throw e;
  }

  // ------------------------------------------- every empty chunk is a negative to confirm
  const unconfirmed: string[] = [];
  let confirmationResult = "unavailable";
  let confirmingSourceId: string | null = null;
  if (CONFIG.CONFIRM_EMPTY_CHUNKS && fetch.emptyChunks.length > 0) {
    log.info(`Confirming ${fetch.emptyChunks.length} empty chunk(s) against independent endpoints`, {
      capture: captureId,
    });
    let anyConfirmed = false;
    for (const [lo, hi] of fetch.emptyChunks) {
      const c = await confirmEmptyRange(network, [target.address], lo, hi);
      confirmingSourceId = c.probe.answeredFully[0] ?? null;
      if (!c.confirmed) {
        unconfirmed.push(`${lo}..${hi}: ${c.reason}`);
        log.error(`UNCONFIRMED EMPTY RANGE ${lo}..${hi}`, {
          capture: captureId, reason: c.reason, probeErrors: c.probe.errors.slice(0, 5),
        });
      } else anyConfirmed = true;
    }
    confirmationResult = unconfirmed.length > 0
      ? (unconfirmed.some((u) => u.includes("REFUTED")) ? "refuted_emptiness" : "disagreed")
      : anyConfirmed ? "identical" : "unavailable";
  }

  const status = !fetch.complete ? "incomplete" : unconfirmed.length > 0 ? "unconfirmed_empty" : "complete";
  const assurance = gradeCapture(network, fetch, confirmationResult);

  // The rows were written with the conservative provisional grade C, because a grade is a
  // property of the whole capture and is not known while the rows are streaming. Correct them now
  // that the range is settled. Without this the ledger and the rows disagree, which a live run
  // produced: a capture recorded as grade A over rows that every one of them said were C.
  if (assurance !== "C" && writtenWindow !== null) {
    try {
      await setCaptureAssurance(RAW_LOGS_TABLE, captureId, assurance, writtenWindow);
      await setCaptureAssurance(TRANSACTIONS_TABLE, captureId, assurance, writtenWindow);
    } catch (e: any) {
      // Leaving C in place under-claims, which is the only safe direction for this to be wrong.
      log.error(
        `Could not raise the assurance grade on the rows of ${captureId} to ${assurance}: ${e.message}. ` +
        `They keep the conservative grade C while the coverage row carries ${assurance}.`
      );
    }
  }

  const notes = [...fetch.errors, ...unconfirmed];
  if (reorgSuspects > 0) {
    notes.push(
      `REORG_APPLIED: ${reorgSuspects} row(s) changed block_hash under an existing key and were ` +
      `rewritten whole, including block_number, block_hash, block_timestamp and provenance`
    );
  }
  if (missingTx > 0) {
    notes.push(
      `MISSING_TRANSACTIONS: ${missingTx} transaction(s) were pointed at by a captured log and ` +
      `were not returned by the reader, so no Transactions row exists for them`
    );
  }
  for (const g of fetch.rollbackGuards) {
    // The reader's own reorganisation detector. It was dropped entirely by the previous worker, so
    // the disappearing-log shape was undetectable: the client offers this and nothing read it.
    if (g.firstBlockNumber <= fromBlock) {
      notes.push(
        `ROLLBACK_GUARD: the reader holds blocks from ${g.firstBlockNumber} in memory, which is at ` +
        `or below this capture's start, so part of this range is still rollback-eligible at the source`
      );
    }
  }

  const row = baseCoverage(target, captureId, fromBlock, toBlock, startedAt);
  row.status = status;
  row.chunksPlanned = fetch.chunksPlanned;
  row.chunksOk = fetch.chunksOk;
  row.skippedRanges = JSON.stringify(fetch.skipped);
  row.rowsMerged = distinctOffered;
  row.rowsInserted = inserted;
  row.rowsUpdated = updated;
  row.logsSeen = fetch.logsSeen;
  row.sourceKind = fetch.sourceKind;
  row.sourceId = fetch.sourceId;
  row.confirmingSourceKind = confirmingSourceId ? "rpc" : null;
  row.confirmingSourceId = confirmingSourceId;
  row.confirmationResult = confirmationResult;
  row.assurance = assurance;
  row.headAtCapture = fetch.headAtCapture;
  row.completedAt = new Date().toISOString();
  row.errorMessage = notes.join(" | ").slice(0, 4000);
  await recordCoverage(row);

  // The transactions written by this capture get their own coverage row, because they are a
  // different grain into a different table and an empty Transactions table for a range has to be
  // interpretable on its own terms.
  const txRow = baseCoverage(target, `${captureId}:tx`, fromBlock, toBlock, startedAt);
  txRow.targetTable = TRANSACTIONS_TABLE;
  txRow.tableId = TRANSACTIONS_TABLE;
  txRow.status = status;
  txRow.chunksPlanned = fetch.chunksPlanned;
  txRow.chunksOk = fetch.chunksOk;
  txRow.skippedRanges = JSON.stringify(fetch.skipped);
  txRow.rowsInserted = txInserted;
  txRow.rowsUpdated = txUpdated;
  txRow.rowsMerged = txInserted + txUpdated;
  txRow.logsSeen = fetch.logsSeen;
  txRow.sourceKind = fetch.sourceKind;
  txRow.sourceId = fetch.sourceId;
  txRow.confirmationResult = confirmationResult;
  txRow.assurance = assurance;
  txRow.headAtCapture = fetch.headAtCapture;
  txRow.completedAt = new Date().toISOString();
  txRow.errorMessage = missingTx > 0 ? `MISSING_TRANSACTIONS: ${missingTx}` : "";
  await recordCoverage(txRow);

  if (status !== "complete") {
    throw new IncompleteFetchError(
      `${label} ${fromBlock}..${toBlock} is ${status}: ${fetch.skipped.length} skipped chunk(s), ` +
      `${unconfirmed.length} unconfirmed empty range(s). The coverage row records the gap, so the ` +
      `next run resumes at the edge of the last clean capture rather than above it.`
    );
  }

  log.info(
    `Done ${label}: ${inserted} log(s) inserted, ${updated} updated, ${txInserted} transaction(s) ` +
    `inserted, ${fetch.chunksOk}/${fetch.chunksPlanned} chunks, assurance ${assurance}`,
    { capture: captureId }
  );
  return inserted + updated;
}

/** Alert when a chain's newest captured block is older than the threshold. */
async function checkFreshness(networks: NetworkConfig[]): Promise<void> {
  const threshold = CONFIG.FRESHNESS_THRESHOLD_HOURS;
  const now = Date.now();

  for (const network of networks) {
    try {
      const maxTs = await getMaxBlockTimestamp(RAW_LOGS_TABLE, network.chainId);
      if (!maxTs) continue;
      const hoursStale = (now - maxTs.getTime()) / (1000 * 60 * 60);
      if (hoursStale > threshold) {
        log.warn(`Data stale: ${RAW_LOGS_TABLE}/${network.name} is ${Math.round(hoursStale)}h behind`);
        await alertStaleness(RAW_LOGS_TABLE, network.name, maxTs, hoursStale);
      }
    } catch (e: any) {
      log.warn(`Freshness check failed for ${network.name}: ${e.message}`);
    }
  }
}

/**
 * Main pipeline entry. Every selected chain, every contract the registry lists on it.
 *
 * The contract list comes from the reference seed rather than from this file, which is what makes
 * "adding the 147th contract needs no code change" true rather than aspirational. The previous
 * configuration hard coded two addresses, and as a direct consequence had an entire chain
 * commented out with nothing to notice it.
 */
export async function runPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  await ensureInfraTables();

  const networks = selectedNetworks(opts.chains);
  if (networks.length === 0) {
    log.error(`No chain matched filter: ${opts.chains?.join(", ")}`);
    return { succeeded: 0, failed: 0, totalRows: 0 };
  }

  // The run size budget, checked before anything is written, including a capability gap row. A
  // refusal halfway through leaves a warehouse partly covered by a run whose own record says it
  // failed, which is harder to reason about afterwards than either outcome on its own.
  const plannedTargets = networks
    .filter((n) => n.ingestEnabled && readerFor(n).kind !== "none")
    .reduce((sum, n) => sum + targetsFor(n, { addresses: opts.addresses }).length, 0);
  const runSize = checkRunSize(plannedTargets, opts);
  if (!runSize.allowed) {
    log.error(`REFUSED: ${runSize.reason}`, {
      plannedContracts: runSize.requested, limit: runSize.limit,
      chains: networks.map((n) => n.name).join(","),
    });
    return { succeeded: 0, failed: 0, totalRows: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  let totalRows = 0;

  for (const network of networks) {
    const reader = readerFor(network);
    if (!network.ingestEnabled || reader.kind === "none") {
      await recordCapabilityGap(
        network,
        network.disabledReason ?? reader.reason
      );
      failed += 1;
      continue;
    }

    const targets = targetsFor(network, { addresses: opts.addresses });
    if (targets.length === 0) {
      log.warn(`No contract in the registry for ${network.name} matched this run's filter`);
      continue;
    }
    log.info(`${network.name}: ${targets.length} contract(s) to capture via ${reader.id}`, {
      reason: reader.reason,
    });

    for (const target of targets) {
      try {
        totalRows += await processTarget(target, opts);
        succeeded += 1;
      } catch (e: any) {
        log.error(`Failed: ${target.contractName} ${target.address} on ${network.name}: ${e.message}`, {
          error: e.message,
        });
        failed += 1;
      }
    }
  }

  if (opts.mode === "daily") await checkFreshness(networks);

  return { succeeded, failed, totalRows };
}
