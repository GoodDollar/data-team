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
  CONFIG, NETWORKS, selectedNetworks, RAW_LOGS_TABLE, TRANSACTIONS_TABLE,
  RAW_LOGS_SCHEMA, TRANSACTIONS_SCHEMA,
} from "./config.js";
import { log, RUN_ID } from "./log.js";
import { fetchRange, getChainTip, readerFor, gradeCapture } from "./reader.js";
import { confirmEmptyRange } from "./rpc.js";
import { targetsFor, eraIndexFor, partitionByReleaseScope } from "./registry.js";
import { rawLogRows, transactionRows, missingTransactionCount } from "./rawrow.js";
import { projectChunk, projectFetchResult, unionRange } from "./batch.js";
import { windowForRows, widen } from "./window.js";
import {
  ensureInfraTables, stageAndMerge, recordCoverage, getMaxBlockTimestamp, setCaptureAssurance,
} from "./bq.js";
import { loadCoverage, computeResumePoint } from "./coverage.js";
import { checkCaptureSpan, checkRunSize } from "./budget.js";
import { alertStaleness } from "./slack.js";
import { nowIso } from "./adapters.js";
import { RunSummary, unit, PARENT_GRAIN, type UnitOutcome } from "./outcome.js";
import type {
  PipelineOpts, PipelineResult, CaptureTarget, CoverageRecord, FetchResult, NetworkConfig,
  MergeWindow, ChunkResult, EraMapEntry,
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
    startedAt, completedAt: nowIso(),
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
  const startedAt = nowIso();
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
    startedAt, completedAt: nowIso(),
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
 *
 * RETURNS A TYPED OUTCOME, NOT A ROW COUNT. That is the C2 fix and it is the whole of it here.
 * The previous signature was `Promise<number>`, and a refusal returned 0, which is the same value
 * a clean capture of an empty range returns. Two different facts, one value, and every caller
 * downstream inherited the ambiguity: the run loop treated any non-throwing return as a success,
 * so a refused contract was counted as processed and the process exited 0.
 *
 * ONE OUTCOME PER GRAIN, WHICH IS FINDING H5. A capture writes coverage rows for two grains,
 * RawLogs and Transactions, and used to return a single outcome describing only the first. The
 * transaction grain therefore inherited a completeness judgement made about logs: the reader
 * returned two logs pointing at two transactions and produced one, the detector at
 * `rawrow.ts` counted the missing one, and the Transactions row was still written `complete` with
 * the count relegated to an error message. Both rows now carry their own status and both grains
 * now return their own outcome, so a grain that did not finish reaches the counters and the exit
 * code instead of stopping at a string nobody reads.
 *
 * PREPARATION IS SEPARATE FROM READING, and that is what closing H2 needed. Resolving a range and
 * declining it against the budget are per contract; the READ is per chain. Splitting them lets
 * many prepared targets share one batched read while each still decides its own range and writes
 * its own verdict. A target refused here never reaches the read at all, so a declined contract
 * costs nothing and still leaves the two coverage rows that say it was declined.
 */
async function prepareTarget(
  target: CaptureTarget,
  opts: PipelineOpts
): Promise<{ sink: CaptureSink } | { outcomes: UnitOutcome[] }> {
  const { network } = target;
  const startedAt = nowIso();
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
    return { outcomes: [unit(
      "nothing_to_fetch", RAW_LOGS_TABLE,
      `${label}: toBlock ${toBlock} is below fromBlock ${fromBlock}, so there was no range to read`,
      { chainId: target.chainId, address: target.address, fromBlock, toBlock },
    )] };
  }

  // The span budget. A refusal is a ROW, not a silence: a range nobody read and nothing recorded
  // is the one state L0-8 exists to prevent, and a guard that produced it would be trading one
  // defect for another.
  //
  // IT IS A ROW PER GRAIN, and that is plan task 6. The previous code returned from this branch
  // before it reached the Transactions coverage row, so the transaction grain carried no record
  // that its range had been declined. An empty Transactions range with no coverage row reads as
  // "no transactions in this range" rather than "nobody looked", which is the single state the
  // coverage ledger exists to make impossible.
  const span = checkCaptureSpan(network, fromBlock, toBlock, opts);
  if (!span.allowed) {
    const reason = (span.reason ?? "").slice(0, 4000);
    const refusals: UnitOutcome[] = [];
    for (const [grain, id] of [[RAW_LOGS_TABLE, captureId], [TRANSACTIONS_TABLE, `${captureId}:tx`]] as const) {
      const row = baseCoverage(target, id, fromBlock, toBlock, startedAt);
      row.targetTable = grain;
      row.tableId = grain;
      row.status = "refused_budget";
      row.sourceKind = readerFor(network).kind === "index" ? "index" : "rpc";
      row.sourceId = readerFor(network).id;
      row.errorMessage = reason;
      await recordCoverage(row);
      refusals.push(unit(
        "refused_budget", grain,
        `${label} blocks ${fromBlock}..${toBlock}: ${span.reason}`,
        { chainId: target.chainId, address: target.address, fromBlock, toBlock },
      ));
    }
    log.error(`REFUSED ${label}: ${span.reason}`, {
      requestedBlocks: span.requested, limitBlocks: span.limit,
      grainsRecorded: `${RAW_LOGS_TABLE},${TRANSACTIONS_TABLE}`,
    });
    return { outcomes: refusals };
  }

  // --------------------------------------------------------------------- fetch and write
  const eras = eraIndexFor(target.chainId, target.address);
  if (eras.length === 0) {
    // Not fatal. era_resolution 'unresolved' is a permitted and honest value, and a row that does
    // not know its era says so. It is logged because it means the seed does not describe this
    // contract, which is a registry gap rather than an ingestion one.
    log.warn(`No era map for ${label}; every row will carry era_resolution 'unresolved'`);
  }

  return { sink: makeSink({ target, network, captureId, fromBlock, toBlock, startedAt, label, eras }) };
}

/** Everything one target needs to consume chunks and then write its own verdict. */
interface PreparedCapture {
  target: CaptureTarget;
  network: NetworkConfig;
  captureId: string;
  fromBlock: number;
  toBlock: number;
  startedAt: string;
  label: string;
  eras: EraMapEntry[];
}

/**
 * One target's share of a capture: its buffers, its counters, and its own verdict at the end.
 *
 * WHY THIS IS AN OBJECT NOW. It used to be a page of local variables inside `processTarget`,
 * which was fine while one target owned one fetch. Closing H2 means ONE fetch feeds MANY targets,
 * so the per-target state has to be something a chunk can be handed to. Extracting it is what
 * keeps a single capture implementation: the single-target path and the batched path run this
 * same code, so a fix to one cannot leave the other behind -- which is the defect the previous
 * repair path shipped, sixty-five lines duplicated almost verbatim.
 */
function makeSink(p: PreparedCapture) {
  const { target, network, captureId, fromBlock, toBlock, startedAt, label, eras } = p;

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
  let logsSeen = 0;
  const emptyChunks: [number, number][] = [];
  const ingestedAt = nowIso();
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

  return {
    member: { address: target.address.toLowerCase(), fromBlock, toBlock },
    captureId,
    label,
    /** Per-member figures the batched FetchResult cannot carry, because they are per address. */
    tally: () => ({ logsSeen, emptyChunks }),

    /** Consume one chunk ALREADY PROJECTED onto this target. */
    accept: async (chunk: ChunkResult) => {
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

      logsSeen += chunk.logs.length;
      // Empty FOR THIS TARGET. A batched chunk full of another contract's logs is not empty for
      // the batch and is empty for this one, and it is this one that has to confirm the negative.
      if (chunk.logs.length === 0) emptyChunks.push([chunk.fromBlock, chunk.toBlock]);

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
    },

    flush,

    /**
     * Record that the capture threw part way.
     *
     * If the fetch throws, rows are already in the table and without this no coverage row would
     * exist for the range that produced them. That is the one state L0-8 exists to prevent: data
     * present, and nothing recording that anybody looked. A live run found this by failing here.
     */
    recordThrow: async (e: any) => {
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
    },

    /** Write this target's two coverage rows and return its two outcomes. */
    finish: async (fetch: FetchResult): Promise<UnitOutcome[]> => {
      // ------------------------------------------- every empty chunk is a negative to confirm
      const unconfirmed: string[] = [];
      let confirmationResult = "unavailable";
      let confirmingSourceId: string | null = null;
      // FINDING C6. The admissibility grade the reader put ON its answer, read here rather than
      // re-decided. The worst grade any empty chunk earned is what the capture carries, because a
      // capture is only as corroborated as its weakest unconfirmed range.
      const evidenceGrades: string[] = [];
      if (CONFIG.CONFIRM_EMPTY_CHUNKS && fetch.emptyChunks.length > 0) {
        log.info(`Confirming ${fetch.emptyChunks.length} empty chunk(s) against independent endpoints`, {
          capture: captureId,
        });
        let anyConfirmed = false;
        let refuted = false;
        for (const [lo, hi] of fetch.emptyChunks) {
          const c = await confirmEmptyRange(network, [target.address], lo, hi);
          evidenceGrades.push(c.evidence.grade);
          const corroborating = c.probe.perEndpoint.filter((e) => e.failures === 0 && e.found === 0);
          if (corroborating.length > 0) confirmingSourceId = corroborating.map((e) => new URL(e.url).host).join("+");
          if (c.evidence.grade === "refutation") refuted = true;
          if (!c.confirmed) {
            unconfirmed.push(`${lo}..${hi} [${c.evidence.grade}]: ${c.reason}`);
            // A REFUTATION is an error: the primary reader missed data that demonstrably exists.
            // An uncorroborated empty range is NOT. It is the ordinary result of asking endpoints
            // that this project has measured returning false zeros, and its consequence is already
            // correct and sufficient: the coverage frontier does not move past it and it is read
            // again. Logging it at error level trained readers to ignore the level.
            if (c.evidence.grade === "refutation") {
              log.error(`REFUTED EMPTY RANGE ${lo}..${hi}`, {
                capture: captureId, reason: c.reason, probeErrors: c.probe.errors.slice(0, 5),
              });
            } else {
              log.warn(`UNCORROBORATED EMPTY RANGE ${lo}..${hi}`, {
                capture: captureId, grade: c.evidence.grade, reason: c.reason,
                cleanEndpoints: c.evidence.cleanEndpoints,
                zeroLogAnswers: c.probe.zeroLogAnswers,
                falseZeroSuspects: c.probe.falseZeroSuspects,
                probeErrors: c.probe.errors.slice(0, 5),
              });
            }
          } else anyConfirmed = true;
        }
        // `disagreed` is not produced here any more, and the reason is worth stating: in an
        // emptiness probe, an endpoint finding logs where another found none IS the refutation
        // case, so the two labels named one fact. What the old code actually wrote `disagreed` on
        // was the case where a second endpoint never answered at all, which is a missing opinion,
        // not a conflict -- the same false label reader.ts already corrected on the chunk path.
        confirmationResult = refuted
          ? "refuted_emptiness"
          : unconfirmed.length > 0 ? "uncorroborated"
            : anyConfirmed ? "identical" : "unavailable";
      }

      // FINDING SA-C23a, the remaining half. PR 71 fixed the half that DROPPED the guard, and
      // hs-worker.mjs forwards it now. The half left was that the guard changed nothing: status
      // was computed before the guard was read, and all the guard did was append a sentence to
      // `error_message`. So a range the reader ITSELF says is still reorganisable was recorded
      // `complete`, and because `isClean` in coverage.ts is `status === "complete" && no skips`,
      // the resume frontier moved straight past it and nothing ever read it again.
      //
      // The guard is the reader saying "I am still holding blocks from here down, and they may be
      // replaced". When the block it names is at or below this capture's own start, the whole
      // capture sits inside that window. That is a status, not a note.
      const rollbackHeld = fetch.rollbackGuards.filter((g) => g.firstBlockNumber <= fromBlock);

      const status = !fetch.complete ? "incomplete"
        : rollbackHeld.length > 0 ? "rollback_eligible"
          : unconfirmed.length > 0 ? "unconfirmed_empty"
            : "complete";

      // FINDING H5. The transaction grain gets its own verdict, because it can fail on its own. A
      // reader that returns every log and omits one of the transactions those logs point at has
      // produced a complete RawLogs range and an incomplete Transactions range, and the previous
      // code copied the log verdict onto the transaction row verbatim. The count was detected,
      // written into `error_message`, and contradicted by the `status` column beside it -- and
      // downstream, an absent Transactions row is indistinguishable from one that does not exist.
      const txStatus = missingTx > 0 ? "incomplete" : status;
      const assurance = gradeCapture(network, fetch, confirmationResult);

      // The rows were written with the conservative provisional grade C, because a grade is a
      // property of the whole capture and is not known while the rows are streaming. Correct them
      // now that the range is settled. Without this the ledger and the rows disagree, which a live
      // run produced: a capture recorded as grade A over rows that every one of them said were C.
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
      for (const g of rollbackHeld) {
        notes.push(
          `ROLLBACK_GUARD: the reader holds blocks from ${g.firstBlockNumber} in memory, which is at ` +
          `or below this capture's start ${fromBlock}, so part of this range is still ` +
          `rollback-eligible at the source. The capture is recorded 'rollback_eligible' rather than ` +
          `complete, so the resume frontier stays at or below ${fromBlock} and this range is read ` +
          `again once it settles`
        );
      }
      if (evidenceGrades.length > 0) {
        notes.push(`EVIDENCE_GRADES: ${[...new Set(evidenceGrades)].sort().join(",")}`);
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
      row.completedAt = nowIso();
      row.errorMessage = notes.join(" | ").slice(0, 4000);
      await recordCoverage(row);

      // The transactions written by this capture get their own coverage row, because they are a
      // different grain into a different table and an empty Transactions table for a range has to
      // be interpretable on its own terms.
      const txRow = baseCoverage(target, `${captureId}:tx`, fromBlock, toBlock, startedAt);
      txRow.targetTable = TRANSACTIONS_TABLE;
      txRow.tableId = TRANSACTIONS_TABLE;
      txRow.status = txStatus;
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
      txRow.completedAt = nowIso();
      txRow.errorMessage = missingTx > 0
        ? `MISSING_TRANSACTIONS: ${missingTx} transaction(s) pointed at by a captured log were not ` +
          `returned by the reader, so this range is NOT complete for the transaction grain`
        : "";
      await recordCoverage(txRow);

      if (status !== "complete") {
        throw new IncompleteFetchError(
          `${label} ${fromBlock}..${toBlock} is ${status}: ${fetch.skipped.length} skipped chunk(s), ` +
          `${unconfirmed.length} uncorroborated empty range(s), ${rollbackHeld.length} rollback ` +
          `guard(s) holding blocks at or below the start. The coverage row records the gap, so the ` +
          `next run resumes at the edge of the last clean capture rather than above it.`
        );
      }

      if (txStatus !== "complete") {
        log.error(
          `${label} ${fromBlock}..${toBlock}: the RawLogs range is complete and the Transactions ` +
          `range is ${txStatus}. ${missingTx} transaction(s) are missing.`,
          { capture: captureId }
        );
      }

      log.info(
        `Done ${label}: ${inserted} log(s) inserted, ${updated} updated, ${txInserted} transaction(s) ` +
        `inserted, ${fetch.chunksOk}/${fetch.chunksPlanned} chunks, assurance ${assurance}`,
        { capture: captureId }
      );

      // One outcome per grain, matching the two coverage rows just written. Returning only the
      // first is what let a complete log range speak for an incomplete transaction range.
      return [
        unit(
          "completed", RAW_LOGS_TABLE,
          `${label} ${fromBlock}..${toBlock} complete at assurance ${assurance}`,
          {
            chainId: target.chainId, address: target.address, fromBlock, toBlock,
            rows: inserted + updated,
          },
        ),
        unit(
          txStatus === "complete" ? "completed" : "incomplete", TRANSACTIONS_TABLE,
          txStatus === "complete"
            ? `${label} ${fromBlock}..${toBlock}: ${txInserted + txUpdated} transaction(s) merged`
            : `${label} ${fromBlock}..${toBlock}: ${missingTx} transaction(s) pointed at by a captured ` +
              `log were not returned by the reader, so the transaction grain is incomplete`,
          {
            chainId: target.chainId, address: target.address, fromBlock, toBlock,
            rows: txInserted + txUpdated,
          },
        ),
      ];
    },
  };
}

type CaptureSink = ReturnType<typeof makeSink>;

/**
 * Read one block range ONCE for every target in it, and give each target its own verdict.
 *
 * THIS IS THE H2 FIX. Every reader in this codebase has always taken a LIST of addresses; the
 * pipeline only ever handed it one, inside a loop, so a chain with N contracts issued N chunk
 * streams over overlapping ranges. The cost model the project is budgeted against assumes one
 * batched address query per chain range, and the gap between the two was measured in tens of
 * times, not percentages.
 *
 * THE RANGE IS THE UNION of the members' ranges, and the projection back onto each member is what
 * keeps the coverage ledger honest: a contract created late is not told about blocks below its
 * own creation, and a chunk that failed is recorded against exactly the contracts whose declared
 * range it overlaps. `batch.ts` owns that projection and is tested on its own, because a
 * plausible-looking wrong attribution here is invisible in the warehouse afterwards.
 */
async function captureBatch(
  network: NetworkConfig,
  sinks: CaptureSink[],
  opts: PipelineOpts
): Promise<Map<string, UnitOutcome[]>> {
  const results = new Map<string, UnitOutcome[]>();
  if (sinks.length === 0) return results;

  const span = unionRange(sinks.map((s) => s.member))!;
  const addresses = sinks.map((s) => s.member.address);
  const chunkRanges: [number, number][] = [];

  log.info(
    `${network.name}: one batched read of ${addresses.length} address(es) over ` +
    `${span.fromBlock}..${span.toBlock}`,
    { mode: opts.mode, reader: readerFor(network).id, addresses: addresses.length }
  );

  let fetch: FetchResult;
  try {
    fetch = await fetchRange(network, addresses, span.fromBlock, span.toBlock, async (chunk) => {
      chunkRanges.push([chunk.fromBlock, chunk.toBlock]);
      // Sequentially, never in parallel. Two concurrent MERGEs into one table is finding C1, and
      // it is still open, so this loop must not be the thing that starts producing it.
      for (const s of sinks) await s.accept(projectChunk(chunk, s.member));
    });
    for (const s of sinks) await s.flush();
  } catch (e: any) {
    // The batched read failed, so EVERY member of it is incomplete. Recording the failure against
    // only the member being written when it threw would leave the others with rows in the table
    // and no coverage row saying anybody looked.
    for (const s of sinks) await s.recordThrow(e);
    throw e;
  }

  // A chunk range the reader never reported is still planned work. `skipped` carries the ranges
  // that failed before a chunk existed, so they are added here or a member could see a skip that
  // overlaps no chunk it knows about and compute chunksOk above chunksPlanned.
  for (const [a, b] of fetch.skipped) {
    if (!chunkRanges.some(([x, y]) => x === a && y === b)) chunkRanges.push([a, b]);
  }

  for (const s of sinks) {
    const mine = projectFetchResult(fetch, s.member, chunkRanges, s.tally());
    try {
      results.set(s.member.address, await s.finish(mine));
    } catch (e: any) {
      results.set(s.member.address, [unit(
        e instanceof IncompleteFetchError ? "incomplete" : "failed",
        RAW_LOGS_TABLE, `${s.label}: ${e.message}`,
        { chainId: network.chainId, address: s.member.address },
      )]);
    }
  }
  return results;
}

/**
 * Ingest ONE contract over its own range. Throws on an incomplete fetch rather than recording a
 * success, because a partial range recorded as a success is precisely how a gap becomes permanent.
 *
 * Exported because repair drives the SAME code path over a named range. The previous repair
 * carried its own copy of the fetch, decode and write loop, about sixty-five lines duplicated
 * almost verbatim, so a fix to one path silently left the other behind. This is a batch of one,
 * so it is not a second implementation either.
 */
export async function processTarget(target: CaptureTarget, opts: PipelineOpts): Promise<UnitOutcome[]> {
  const prepared = await prepareTarget(target, opts);
  if ("outcomes" in prepared) return prepared.outcomes;

  const results = await captureBatch(target.network, [prepared.sink], opts);
  const mine = results.get(prepared.sink.member.address) ?? [];
  // A batch of one that produced an incomplete outcome has to throw, because every existing
  // caller of this function reads a throw as "this target did not finish". `captureBatch` catches
  // per member so one member cannot abort the others; here there is only one, so the catch is
  // rethrown rather than swallowed into a returned outcome.
  const bad = mine.find((o) => o.kind === "incomplete" || o.kind === "failed");
  if (bad && mine.length === 1) throw new IncompleteFetchError(bad.detail);
  return mine;
}

/**
 * Ingest every target on one chain with ONE batched read per chain, which is finding H2.
 *
 * Targets that resolve to the same reader are read together; a target the budget declines never
 * reaches the read and returns its refusal outcomes directly.
 */
async function captureChain(
  network: NetworkConfig,
  targets: CaptureTarget[],
  opts: PipelineOpts
): Promise<UnitOutcome[]> {
  const outcomes: UnitOutcome[] = [];
  const sinks: CaptureSink[] = [];

  for (const target of targets) {
    try {
      const prepared = await prepareTarget(target, opts);
      if ("outcomes" in prepared) outcomes.push(...prepared.outcomes);
      else sinks.push(prepared.sink);
    } catch (e: any) {
      log.error(`Failed to prepare ${target.contractName} ${target.address} on ${network.name}: ${e.message}`);
      outcomes.push(unit(
        "failed", RAW_LOGS_TABLE,
        `${target.contractName} ${target.address} on ${network.name}: ${e.message}`,
        { chainId: target.chainId, address: target.address },
      ));
    }
  }

  if (sinks.length === 0) return outcomes;

  try {
    for (const list of (await captureBatch(network, sinks, opts)).values()) outcomes.push(...list);
  } catch (e: any) {
    // The batched read itself threw, so no member got a verdict. Every one of them has had its
    // failure recorded by `recordThrow`; this turns that into an outcome per member so the run
    // record and the exit code see the same number of failures the ledger does.
    log.error(`Batched read failed on ${network.name}: ${e.message}`, { targets: sinks.length });
    for (const s of sinks) {
      outcomes.push(unit(
        e instanceof IncompleteFetchError ? "incomplete" : "failed",
        RAW_LOGS_TABLE, `${s.label}: ${e.message}`,
        { chainId: network.chainId, address: s.member.address },
      ));
    }
  }
  return outcomes;
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
 * Record that a run declined to start, rather than returning in silence.
 *
 * The global guard's receipt in the readiness audit is that a bare `daily` planned 142 targets,
 * logged REFUSED, and left NOTHING behind: no coverage row, no run row with a real planned count,
 * exit 0. So the refusal is now a parent row per selected chain, with no contract address and no
 * block range, because a run-level refusal covers no range and must not pretend to.
 *
 * One row per chain rather than one per target: 142 targets would be 284 rows announcing a single
 * decision, and plan task 6 explicitly allows one parent refusal whose target set names both
 * grains. `PARENT_GRAIN` is that target set.
 */
async function recordGlobalRefusal(
  networks: NetworkConfig[],
  reason: string,
  plannedTargets: number,
): Promise<void> {
  const startedAt = nowIso();
  for (const network of networks) {
    await recordCoverage({
      captureId: `${RUN_ID}:${network.chainId}:refused_budget`,
      runId: RUN_ID,
      chainId: network.chainId, network: network.name,
      contractAddress: null,
      targetTable: PARENT_GRAIN, tableId: PARENT_GRAIN,
      fromBlock: 0, toBlock: 0,
      status: "refused_budget",
      chunksPlanned: 0, chunksOk: 0, skippedRanges: "[]",
      rowsMerged: 0, rowsInserted: 0, rowsUpdated: 0, logsSeen: 0,
      sourceKind: "unknown", sourceId: "none",
      confirmingSourceKind: null, confirmingSourceId: null,
      confirmationResult: "unavailable",
      assurance: "C",
      headAtCapture: null, missRateCalibrated: null, passesRun: null, gainSeries: null,
      startedAt, completedAt: nowIso(),
      errorMessage:
        `RUN_REFUSED (${plannedTargets} target(s) planned across ${networks.length} chain(s)): ${reason}`
          .slice(0, 4000),
    });
  }
}

/**
 * Main pipeline entry. Every selected chain, every contract the registry lists on it.
 *
 * The contract list comes from the reference seed rather than from this file, which is what makes
 * "adding the 147th contract needs no code change" true rather than aspirational. The previous
 * configuration hard coded two addresses, and as a direct consequence had an entire chain
 * commented out with nothing to notice it.
 *
 * EVERY EXIT FROM THIS FUNCTION NOW CARRIES A SUMMARY. It used to have three early returns that
 * each produced `{ succeeded: 0, failed: 0 }`: no chain matched, the run was globally refused,
 * and the implicit one where every chain had zero targets. All three read as a clean run to the
 * exit mapping. They are now distinct typed outcomes and every one of them is nonzero.
 */
export async function runPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  await ensureInfraTables();

  const summary = new RunSummary();
  const networks = selectedNetworks(opts.chains);
  if (networks.length === 0) {
    const asked = opts.chains?.join(", ") ?? "(none)";
    log.error(`No chain matched filter: ${asked}`);
    summary.add(unit(
      "unsupported", PARENT_GRAIN,
      `no configured chain matched --chains=${asked}; known chains are ` +
      `${Object.values(NETWORKS).map((n) => n.name).join(", ")}`,
    ));
    return resultOf(summary, 0);
  }

  // A chain outside the frozen release scope is REPORTED and skipped, never captured and never
  // silently dropped. `targetsFor` refuses it unconditionally as a backstop; this is what turns
  // that refusal into an outcome the run record carries, the same shape `plan` mode uses. Without
  // it a bare `daily` would abort on the first out-of-scope chain in the configuration and do
  // none of the work it could have done.
  const { usable: inScope, refused: outOfScope } = partitionByReleaseScope(networks);
  for (const r of outOfScope) {
    log.error(`UNSUPPORTED: ${r.detail}`, { chainId: r.network.chainId });
    summary.add(unit("unsupported", RAW_LOGS_TABLE, r.detail, { chainId: r.network.chainId }));
  }

  // The run size budget, checked before anything is written, including a capability gap row. A
  // refusal halfway through leaves a warehouse partly covered by a run whose own record says it
  // failed, which is harder to reason about afterwards than either outcome on its own.
  const plannedTargets = inScope
    .filter((n) => n.ingestEnabled && readerFor(n).kind !== "none")
    .reduce((sum, n) => sum + targetsFor(n, { addresses: opts.addresses }).length, 0);

  // Declared BEFORE the guard runs, because plan task 4 requires the persisted run record to
  // carry the REAL planned count of a refused run and that number does not exist afterwards.
  summary.plan(RAW_LOGS_TABLE, plannedTargets);

  const runSize = checkRunSize(plannedTargets, opts);
  if (!runSize.allowed) {
    log.error(`REFUSED: ${runSize.reason}`, {
      plannedContracts: runSize.requested, limit: runSize.limit,
      chains: inScope.map((n) => n.name).join(","),
    });
    await recordGlobalRefusal(inScope, runSize.reason ?? "", plannedTargets);
    // One refused unit per planned target. The run declined all of them, and a count of 1 would
    // under-report the decision by a factor of the whole registry.
    for (const network of inScope) {
      for (const target of targetsFor(network, { addresses: opts.addresses })) {
        summary.add(unit(
          "refused_budget", RAW_LOGS_TABLE,
          `${target.contractName} ${target.address} on ${network.name} was never attempted: ${runSize.reason}`,
          { chainId: target.chainId, address: target.address },
        ));
      }
    }
    return resultOf(summary, 0);
  }

  let totalRows = 0;

  for (const network of inScope) {
    const reader = readerFor(network);
    if (!network.ingestEnabled || reader.kind === "none") {
      const reason = network.disabledReason ?? reader.reason;
      await recordCapabilityGap(network, reason);
      summary.add(unit(
        "unsupported", RAW_LOGS_TABLE,
        `${network.name} has no adequate reader: ${reason}`,
        { chainId: network.chainId },
      ));
      continue;
    }

    const targets = targetsFor(network, { addresses: opts.addresses });
    if (targets.length === 0) {
      // Plan task 7: zero selected targets is not a quiet skip. An `--addresses` filter that
      // matches nothing on any chain leaves the run with nothing to do, and a run with nothing to
      // do must not report success.
      const filter = opts.addresses ? `--addresses=${opts.addresses.join(",")}` : "(no filter)";
      log.warn(`No contract in the registry for ${network.name} matched this run's filter ${filter}`);
      summary.add(unit(
        "unsupported", RAW_LOGS_TABLE,
        `no contract in the control plane for ${network.name} matched ${filter}`,
        { chainId: network.chainId },
      ));
      continue;
    }
    log.info(`${network.name}: ${targets.length} contract(s) to capture via ${reader.id}`, {
      reason: reader.reason,
    });

    // ONE batched read for the whole chain, which is finding H2. The loop that used to sit here
    // called the reader once per contract over overlapping ranges, while every reader in this
    // codebase has always accepted a list of addresses.
    for (const outcome of await captureChain(network, targets, opts)) {
      summary.add(outcome);
      // Only the log grain feeds this counter. It is persisted as `totalRowsMerged` and has
      // always meant RawLogs rows; adding the transaction rows to it would change what a
      // shipped column means rather than report a new fact.
      if (outcome.grain === RAW_LOGS_TABLE) totalRows += outcome.rows;
    }
  }

  if (opts.mode === "daily") await checkFreshness(networks);

  return resultOf(summary, totalRows);
}

/**
 * The flattened two-number projection the warehouse columns and the CLI have always used.
 *
 * DERIVED, never incremented in parallel. `succeeded` is completions and nothing else, and
 * `failed` is every unit that did not complete and was not a no-op, which is what makes a refused
 * or unsupported unit reach the exit code at all. A no-op is neither: it is counted, and the
 * "zero completed" arm of the exit mapping is what stops a run of pure no-ops exiting 0.
 */
function resultOf(summary: RunSummary, totalRows: number): PipelineResult {
  const t = summary.totals;
  return {
    succeeded: t.completed,
    failed: t.refused + t.unsupported + t.incomplete + t.failed,
    totalRows,
    summary,
  };
}

