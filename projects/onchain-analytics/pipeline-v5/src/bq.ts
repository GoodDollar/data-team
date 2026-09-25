/**
 * bq.ts -- BigQuery operations. Staging + MERGE write path, state queries.
 *
 * THE WRITE CONTRACT THIS FILE IMPLEMENTS IS L0-9, AND EVERY PART OF IT IS A MEASUREMENT.
 * Read it in warehouse/L1/06_L0Contract_v4.sql before changing anything here.
 *
 *   A MERGE with no predicate on the target scans the WHOLE target. Nothing about the statement
 *   looks wrong. RawLogs and Transactions carry require_partition_filter, which refuses it.
 *   The window has to be a LITERAL, and computing it is this program's job, because a subquery in
 *   the ON clause is refused by BigQuery outright and a predicate correlated to the source row is
 *   refused by the guard.
 *   The window is padded one month each side. Unpadded, a log that moves across a month boundary
 *   between two ingestions lands TWICE under one merge key, on an unguarded table too.
 *   A matched row is rewritten WHOLE, including block_number, block_hash and block_timestamp,
 *   because a reorganisation changes which block the log lives in.
 *   Every hex identifier is lowercase before it gets here. Two spellings of one hash are two
 *   different keys, and a uniqueness test on the key cannot flag that.
 *
 * A GUARDED TABLE ALSO REFUSES SEVERAL REASONABLE THINGS: a bare COUNT(*), a GROUP BY over the
 * whole table looking for a duplicated key, and dbt's own incremental pattern. The documented
 * route for those is the all-history view, which carries the wide filter in its own definition so
 * its consumers need none. That is why `allHistory()` exists and why anything here that
 * legitimately spans all of history goes through it.
 */

import { BigQuery } from "@google-cloud/bigquery";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  CONFIG, fullTableName, stagingTableId, MERGE_KEYS, ALL_HISTORY_VIEWS, RAW_LOGS_TABLE,
} from "./config.js";
import { log } from "./log.js";
import { windowPredicate, windowForSpan, partitionsSpanned } from "./window.js";
import type { SchemaField, PipelineRunRecord, CoverageRecord, MergeWindow } from "./types.js";

export const bigquery = new BigQuery({ projectId: CONFIG.GCP_PROJECT_ID });
const dataset = bigquery.dataset(CONFIG.DATASET_ID, { projectId: CONFIG.GCP_PROJECT_ID });

// -- Retry helpers --

function isRetriable(e: any): boolean {
  const msg = String(e?.message ?? "").toLowerCase();
  return (
    msg.includes("timeout") || msg.includes("rate limit") ||
    msg.includes("backend error") || msg.includes("internal error") ||
    msg.includes("unavailable") || msg.includes("econnreset") ||
    msg.includes("socket hang up")
  );
}

function backoffMs(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt - 1);
  return base + Math.random() * base * 0.3;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -- Query with retry --

/**
 * Run a query with retries.
 *
 * `types` is not optional decoration. The client infers a parameter's BigQuery type from its
 * JavaScript value, and a null has no type to infer, so a statement carrying even one nullable
 * parameter is rejected outright with "Parameter types must be provided for null values". Every
 * call that can pass a null names its types.
 */
export async function bqQuery(
  sql: string,
  params?: Record<string, any>,
  types?: Record<string, string>
): Promise<any[]> {
  let lastErr: any;
  for (let attempt = 1; attempt <= CONFIG.BQ_RETRIES; attempt++) {
    try {
      const [rows] = await bigquery.query({
        query: sql, params, types, projectId: CONFIG.GCP_PROJECT_ID,
      });
      return rows;
    } catch (e: any) {
      lastErr = e;
      if (!isRetriable(e) || attempt === CONFIG.BQ_RETRIES) throw e;
      const delay = backoffMs(attempt);
      log.warn(`BQ query retry ${attempt}/${CONFIG.BQ_RETRIES} in ${Math.round(delay)}ms`, { error: e.message });
      await sleep(delay);
    }
  }
  throw lastErr;
}

// -- State queries (fail-fast) --

/**
 * The all-history view for a guarded table, which is the documented route for a read that
 * genuinely wants everything.
 *
 * NOT a convenience. require_partition_filter refuses a bare COUNT(*), a whole-table GROUP BY and
 * dbt's incremental subquery pattern; a view carrying the wide filter in its own definition
 * satisfies the guard and its consumers need no filter at all. Measured, including a GROUP BY
 * correctly finding a seeded duplicate through the view while the same statement straight at the
 * table is refused. The price is about 6 percent more bytes read than no filter would be.
 *
 * It is NOT the route for a read with a natural window. A caller that has a window filters the
 * TABLE, where the engine can prune. Reading everything through a view and filtering afterwards
 * gives the engine nothing to skip and is the exact mistake the guard exists to catch.
 */
export function allHistory(tableId: string): string {
  const view = ALL_HISTORY_VIEWS[tableId];
  return fullTableName(view ?? tableId);
}

/**
 * The newest block timestamp held for a chain. Used only for the freshness alert.
 *
 * Goes through the all-history view because a MAX() over the whole table has no window by
 * definition, so it is exactly the shape the guard refuses.
 */
export async function getMaxBlockTimestamp(tableId: string, chainId: number): Promise<Date | null> {
  const rows = await bqQuery(
    `SELECT MAX(block_timestamp) AS max_ts FROM ${allHistory(tableId)} WHERE chain_id = @chainId`,
    { chainId }
  );
  const ts = rows[0]?.max_ts;
  if (!ts) return null;
  return new Date(ts.value ?? ts);
}

/**
 * Rows held for a chain over a block range.
 *
 * TAKES A WINDOW, and that is not an inconvenience to route around. A block range is NOT a valid
 * partition filter and never will be, because the engine cannot turn a block height into a
 * partition without reading the table. That is why block-to-timestamp conversion sits on the
 * CORRECTNESS path in this pipeline rather than only on the cost path: every ingestion is defined
 * by a block range, and every write to a guarded table is defined by a timestamp window.
 */
export async function countRowsInRange(
  tableId: string,
  chainId: number,
  fromBlock: number,
  toBlock: number,
  window: MergeWindow
): Promise<number> {
  const rows = await bqQuery(
    `SELECT COUNT(*) AS cnt FROM ${fullTableName(tableId)} T
     WHERE T.chain_id = @chainId AND T.block_number >= @from AND T.block_number <= @to
       AND ${windowPredicate("T", window)}`,
    { chainId, from: fromBlock, to: toBlock }
  );
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Every column the live table actually has. The pipeline writes a subset: the L0 contract added
 * columns for events this pipeline does not yet ingest, and MERGE ... INSERT ROW requires the
 * source and target column lists to match exactly. Naming columns explicitly makes the write
 * path survive the table gaining columns, which it already has once.
 */
export async function liveColumns(tableId: string): Promise<Set<string>> {
  const [metadata] = await dataset.table(tableId).getMetadata();
  return new Set<string>((metadata.schema?.fields ?? []).map((f: any) => f.name));
}

// -- Infrastructure tables --

/**
 * Create the bookkeeping tables if the dataset does not have them, and CHECK the ones it does.
 *
 * Create-if-absent reaches the right shape in a fresh dataset. It does NOT migrate an existing
 * one, because CREATE TABLE IF NOT EXISTS silently skips a table that is already there, so a
 * dataset carrying the older shape would stay on it and the first write would fail on a column
 * nobody had looked for. The migration belongs to the L0 contract DDL, which carries explicit
 * ADD COLUMN IF NOT EXISTS statements.
 *
 * So this also asserts the columns the pipeline is about to write. A precondition checked once at
 * startup with a message naming what to run is worth more than an arity error thrown from inside
 * a load job an hour into a backfill.
 */
export async function ensureInfraTables(): Promise<void> {
  await bqQuery(`
    CREATE TABLE IF NOT EXISTS ${fullTableName("PipelineRuns")} (
      run_id STRING,
      mode STRING,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      exit_code INT64,
      total_rows_merged INT64,
      contracts_processed INT64,
      contracts_failed INT64,
      host STRING,
      error_message STRING,
      chains_processed STRING,
      captures_planned INT64,
      captures_ok INT64,
      captures_failed INT64,
      pipeline_version STRING
    )
    PARTITION BY DATE(started_at)
  `);

  // L0-8. The coverage ledger. "Was this range read, by whom, and what failed" becomes a query
  // rather than a belief, and a block range with no row here was never scanned. It is also the
  // RESUME record: a watermark meaning "the furthest row I happen to hold" cannot represent a
  // hole, and this pipeline has already created one.
  await bqQuery(`
    CREATE TABLE IF NOT EXISTS ${fullTableName("IngestionCoverage")} (
      run_id STRING,
      network STRING,
      table_id STRING,
      from_block INT64,
      to_block INT64,
      status STRING OPTIONS(description="complete, incomplete, unconfirmed_empty, nothing_to_fetch, refused_budget or capability_gap. Never plain success."),
      chunks_planned INT64,
      chunks_ok INT64,
      skipped_ranges STRING,
      rows_merged INT64,
      rows_inserted INT64,
      rows_updated INT64,
      logs_seen INT64,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      error_message STRING,
      capture_id STRING,
      chain_id INT64,
      contract_address STRING,
      target_table STRING,
      source_kind STRING,
      source_id STRING,
      confirming_source_kind STRING,
      confirming_source_id STRING,
      confirmation_result STRING,
      assurance STRING,
      head_at_capture INT64,
      miss_rate_calibrated FLOAT64,
      passes_run INT64,
      gain_series STRING
    )
    PARTITION BY DATE(started_at)
    CLUSTER BY chain_id, target_table
  `);

  // Per-day reconciliation against the contract's own ledger, kept so that a regression is
  // visible as history rather than as one run's console output.
  await bqQuery(`
    CREATE TABLE IF NOT EXISTS ${fullTableName("OracleReconciliation")} (
      run_id STRING,
      chain_id INT64,
      network STRING,
      contract_address STRING,
      protocol_day INT64,
      oracle_block INT64,
      oracle_count INT64,
      oracle_amount_raw STRING,
      warehouse_stored INT64,
      warehouse_distinct INT64,
      warehouse_amount_raw STRING,
      count_gap INT64,
      amount_gap_raw STRING,
      verdict STRING,
      checked_at TIMESTAMP
    )
    PARTITION BY DATE(checked_at)
    CLUSTER BY chain_id, contract_address
  `);

  await assertColumns("IngestionCoverage", [
    "capture_id", "chain_id", "contract_address", "target_table", "source_kind", "source_id",
    "confirming_source_kind", "confirming_source_id", "confirmation_result", "assurance",
    "head_at_capture", "miss_rate_calibrated", "passes_run", "gain_series",
  ]);
  await assertColumns("PipelineRuns", [
    "chains_processed", "captures_planned", "captures_ok", "captures_failed", "pipeline_version",
  ]);
}

/** Fail at startup, naming the fix, rather than at the first write, naming a column. */
async function assertColumns(tableId: string, required: string[]): Promise<void> {
  const live = await liveColumns(tableId);
  const missing = required.filter((c) => !live.has(c));
  if (missing.length > 0) {
    throw new Error(
      `SCHEMA_MISMATCH: ${tableId} has no column(s) ${missing.join(", ")}. Apply the L0 v4 contract ` +
      `DDL to this dataset before ingesting. A create-if-absent cannot migrate an existing table.`
    );
  }
}

// -- Record keeping --
//
// IngestionStatus IS NO LONGER WRITTEN, AND THAT IS A DECISION RATHER THAN AN OMISSION.
// It held one row per run per table, was written on every run, and was read by nothing: an
// exhaustive search of all 14 source files finds three writes and zero reads, and bq.ts itself
// carried a comment saying the table cannot answer the resume question. A field written and never
// read is not a record, it is a comment in a table, and keeping it would imply a second resume
// authority beside IngestionCoverage. Its 20 production rows are left exactly where they are;
// dropping a table is destructive and belongs to the retirement script, not to a pipeline.

export async function recordPipelineRun(record: PipelineRunRecord): Promise<void> {
  await bqQuery(
    `INSERT INTO ${fullTableName("PipelineRuns")}
     (run_id, mode, started_at, completed_at, exit_code, total_rows_merged, contracts_processed,
      contracts_failed, host, error_message, chains_processed, captures_planned, captures_ok,
      captures_failed, pipeline_version)
     VALUES (@runId, @mode, TIMESTAMP(@startedAt), TIMESTAMP(@completedAt), @exitCode, @totalRowsMerged,
      @contractsProcessed, @contractsFailed, @host, @errorMessage, @chainsProcessed, @capturesPlanned,
      @capturesOk, @capturesFailed, @pipelineVersion)`,
    {
      runId: record.runId,
      mode: record.mode,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      exitCode: record.exitCode,
      totalRowsMerged: record.totalRowsMerged,
      contractsProcessed: record.contractsProcessed,
      contractsFailed: record.contractsFailed,
      host: record.host,
      errorMessage: record.errorMessage || "",
      chainsProcessed: record.chainsProcessed,
      capturesPlanned: record.capturesPlanned,
      capturesOk: record.capturesOk,
      capturesFailed: record.capturesFailed,
      pipelineVersion: record.pipelineVersion,
    },
    {
      runId: "STRING", mode: "STRING", startedAt: "STRING", completedAt: "STRING",
      exitCode: "INT64", totalRowsMerged: "INT64", contractsProcessed: "INT64",
      contractsFailed: "INT64", host: "STRING", errorMessage: "STRING",
      chainsProcessed: "STRING", capturesPlanned: "INT64", capturesOk: "INT64",
      capturesFailed: "INT64", pipelineVersion: "STRING",
    }
  );
}

/**
 * Write one capture row. Written for EVERY attempted range including the failed ones, because a
 * range that was attempted and failed is the single most important thing to be able to find, and
 * because this row is what the next run's resume point is computed from.
 *
 * EVERY PARAMETER IS TYPED, and that is not tidiness. Seven of these fields are legitimately
 * null: a capture that batched several addresses names none, a chain with one reader has no
 * confirming source, and a capture that ran no calibration has no miss rate. The client cannot
 * infer a type from a null, so without this map the statement is rejected in full. A live run of
 * this pipeline against the shipping table shape found exactly that: the MERGE wrote 55 rows and
 * then the coverage row for them was refused, which leaves the warehouse in the one state L0-8
 * exists to prevent, data present and nothing recording that the range was read.
 */
export async function recordCoverage(r: CoverageRecord): Promise<void> {
  await bqQuery(
    `INSERT INTO ${fullTableName("IngestionCoverage")}
     (capture_id, run_id, chain_id, network, contract_address, target_table, table_id,
      from_block, to_block, status, chunks_planned, chunks_ok, skipped_ranges,
      rows_merged, rows_inserted, rows_updated, logs_seen,
      source_kind, source_id, confirming_source_kind, confirming_source_id, confirmation_result,
      assurance, head_at_capture, miss_rate_calibrated, passes_run, gain_series,
      started_at, completed_at, error_message)
     VALUES (@captureId, @runId, @chainId, @network, @contractAddress, @targetTable, @tableId,
      @fromBlock, @toBlock, @status, @chunksPlanned, @chunksOk, @skippedRanges,
      @rowsMerged, @rowsInserted, @rowsUpdated, @logsSeen,
      @sourceKind, @sourceId, @confirmingSourceKind, @confirmingSourceId, @confirmationResult,
      @assurance, @headAtCapture, @missRateCalibrated, @passesRun, @gainSeries,
      TIMESTAMP(@startedAt), TIMESTAMP(@completedAt), @errorMessage)`,
    { ...r },
    {
      captureId: "STRING", runId: "STRING", chainId: "INT64", network: "STRING",
      contractAddress: "STRING", targetTable: "STRING", tableId: "STRING",
      fromBlock: "INT64", toBlock: "INT64", status: "STRING",
      chunksPlanned: "INT64", chunksOk: "INT64", skippedRanges: "STRING",
      rowsMerged: "INT64", rowsInserted: "INT64", rowsUpdated: "INT64", logsSeen: "INT64",
      sourceKind: "STRING", sourceId: "STRING",
      confirmingSourceKind: "STRING", confirmingSourceId: "STRING", confirmationResult: "STRING",
      assurance: "STRING", headAtCapture: "INT64", missRateCalibrated: "FLOAT64",
      passesRun: "INT64", gainSeries: "STRING",
      startedAt: "STRING", completedAt: "STRING", errorMessage: "STRING",
    }
  );
}

// -- Staging + MERGE (the one true write path) --

/**
 * Write rows into a target table, idempotently, under the L0-9 write contract.
 *
 * FIVE properties, each traceable to a defect that actually happened here:
 *
 *   THE KEY IS PER TABLE AND INCLUDES chain_id. RawLogs is keyed (chain_id, tx_hash, log_index),
 *   Transactions (chain_id, tx_hash). The predecessor keyed on a network NAME, which the v4
 *   tables do not declare at all: measured, all eight of the pipeline's statements were refused
 *   against a table built from the shipping DDL, on an UNGUARDED copy as well as a guarded one,
 *   every one of them for the missing column. So this is not a preference.
 *
 *   THE WINDOW IS A LITERAL ON THE TARGET, AND IT IS COMPUTED HERE. Without it the MERGE scans
 *   the entire target, which measured 0.3519 USD a run against 0.0280 scoped at 719 million rows.
 *   It cannot be derived inside the statement: a subquery in the ON clause is refused by BigQuery
 *   outright and a correlated predicate is refused by the guard. See window.ts for the padding
 *   rule and its measured bound.
 *
 *   A MATCHED ROW IS REWRITTEN WHOLE. Including block_number, block_hash and block_timestamp,
 *   because a reorganisation changes which block a log lives in, and a row keeping its old block
 *   facts sits in the wrong partition, is entirely self consistent, and is invisible to every
 *   grain, referential and uniqueness test in the project.
 *
 *   PROVENANCE IS REWRITTEN TOO, WHICH REVERSES THE PREVIOUS BEHAVIOUR. ingested_at and
 *   ingestion_run_id used to be held immutable on match, on the reasoning that a re-run should
 *   leave the table byte-identical. The consequence was that a reorg-overwritten row attributed
 *   its NEW values to the run that wrote the SUPERSEDED ones, which is the exact opposite of what
 *   L0-6 exists for. First-seen provenance, if it is ever wanted, is a separate pair of columns,
 *   and IngestionCoverage already holds it.
 *
 *   THE STAGING SET IS DE-DUPLICATED IN PROCESS FIRST. Two source rows with one key make BigQuery
 *   reject the whole MERGE, so a single repeated log would fail an entire backfill.
 *
 * Returns the real insert and update split, measured against the table, not the row count handed
 * in. Reporting rows.length as "merged" says how many were OFFERED and nothing about what the
 * table did with them.
 */
export async function stageAndMerge(
  tableId: string,
  rows: Record<string, any>[],
  schema: SchemaField[],
  runId: string,
  window: MergeWindow
): Promise<{ offered: number; distinct: number; inserted: number; updated: number; reorgSuspects: number }> {
  if (rows.length === 0) return { offered: 0, distinct: 0, inserted: 0, updated: 0, reorgSuspects: 0 };

  const keyCols = MERGE_KEYS[tableId];
  if (!keyCols) {
    throw new Error(`MERGE_KEY_UNKNOWN: no merge key is declared for ${tableId}. Declare it in config.ts.`);
  }

  // The key is built from the row's own values, and buildKey refuses a mixed case hash rather
  // than repairing one. By this point normalisation has either happened at the reader boundary or
  // been skipped, and silently repairing it here would hide the skip. Two spellings of one hash
  // are two different keys, so the same log lands twice under keys a uniqueness test cannot flag.
  const buildKey = (r: Record<string, any>): string =>
    keyCols.map((k) => {
      const v = r[k];
      if (typeof v === "string" && /^0x/i.test(v) && v !== v.toLowerCase()) {
        throw new Error(`MERGE_KEY_CASE: ${tableId}.${k} = ${v} reached the merge key un-normalised`);
      }
      return String(v);
    }).join("|");

  const byKey = new Map<string, Record<string, any>>();
  for (const r of rows) byKey.set(buildKey(r), r);
  const deduped = [...byKey.values()];
  if (deduped.length !== rows.length) {
    log.warn(`Staging set carried ${rows.length - deduped.length} repeated key(s); collapsed before MERGE`, {
      tableId, offered: rows.length, distinct: deduped.length,
    });
  }

  const spans = partitionsSpanned(window);
  if (spans > 4_000) {
    // A load or query job may modify at most 4,000 partitions. Monthly partitioning makes a whole
    // history about 70, so reaching this means the window is wrong rather than the range being big.
    throw new Error(
      `L0_9_WINDOW_TOO_WIDE: ${window.fromTs} to ${window.toTs} spans ${spans} monthly partitions ` +
      `and a job may modify at most 4,000. A window this wide is a defect in its derivation.`
    );
  }

  const staging = stagingTableId(tableId, runId);
  const stagingRef = fullTableName(staging);
  const productionRef = fullTableName(tableId);

  // Only write columns the live table actually has, so a schema that has moved ahead of this
  // code fails loudly here rather than corrupting a MERGE.
  const live = await liveColumns(tableId);
  const unknown = schema.map((f) => f.name).filter((n) => !live.has(n));
  if (unknown.length > 0) {
    throw new Error(
      `SCHEMA_MISMATCH: ${tableId} has no column(s) ${unknown.join(", ")}. ` +
      `Apply the L0 contract before ingesting.`
    );
  }
  const cols = schema.map((f) => f.name);

  const keyJoin = keyCols.map((k) => `T.${k} = S.${k}`).join(" AND ");
  const onClause = `${keyJoin}\n        AND ${windowPredicate("T", window)}`;

  // The same window goes on this count. Without it the guard refuses the statement, and on an
  // unguarded table it would scan every partition to answer a question about a handful.
  const matchedSql = `
    SELECT COUNT(*) AS n FROM ${productionRef} T
    WHERE ${windowPredicate("T", window)}
      AND EXISTS (
        SELECT 1 FROM ${stagingRef} S
        WHERE ${keyJoin}
      )`;

  try {
    const ndjson = deduped.map((r) => JSON.stringify(r)).join("\n");
    const tmpFile = join(tmpdir(), `bq_staging_${runId}_${randomUUID().slice(0, 8)}.ndjson`);
    writeFileSync(tmpFile, ndjson);

    const tbl = dataset.table(staging);
    const metadata = {
      sourceFormat: "NEWLINE_DELIMITED_JSON" as const,
      writeDisposition: "WRITE_TRUNCATE" as const,
      schema: { fields: schema },
    };

    let loadErr: any;
    for (let attempt = 1; attempt <= CONFIG.BQ_RETRIES; attempt++) {
      try {
        await tbl.load(tmpFile, metadata);
        loadErr = null;
        break;
      } catch (e: any) {
        loadErr = e;
        if (!isRetriable(e) || attempt === CONFIG.BQ_RETRIES) break;
        const delay = backoffMs(attempt);
        log.warn(`BQ load retry ${attempt}/${CONFIG.BQ_RETRIES} in ${Math.round(delay)}ms`, { error: e.message });
        await sleep(delay);
      }
    }

    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    if (loadErr) throw loadErr;

    const before = Number((await bqQuery(matchedSql))[0]?.n ?? 0);

    // A key that already exists but now sits under a different block hash is a reorganisation,
    // and it is surfaced as data rather than applied in silence. Carries the window for the same
    // reason the MERGE does.
    let reorgSuspects = 0;
    if (live.has("block_hash")) {
      const r = await bqQuery(`
        SELECT COUNT(*) AS n
        FROM ${productionRef} T
        JOIN ${stagingRef} S
          ON ${onClause}
        WHERE T.block_hash IS NOT NULL
          AND S.block_hash IS NOT NULL
          AND T.block_hash != S.block_hash
      `);
      reorgSuspects = Number(r[0]?.n ?? 0);
      if (reorgSuspects > 0) {
        log.error(
          `REORG SUSPECTED: ${reorgSuspects} existing row(s) in ${tableId} carry a different ` +
          `block_hash than the chain now reports for the same (${keyCols.join(", ")}). ` +
          `They are being rewritten WHOLE, including their block facts and their provenance.`,
          { tableId, runId }
        );
      }
    }

    // Everything that is not a key column is rewritten. Nothing is held immutable: a row's values
    // and the run that produced them have to agree, and after an overwrite the producing run is
    // this one.
    const updateClause = cols
      .filter((c) => !keyCols.includes(c))
      .map((c) => `T.${c} = S.${c}`)
      .join(", ");

    await bqQuery(`
      MERGE ${productionRef} AS T
      USING ${stagingRef} AS S
        ON ${onClause}
      WHEN MATCHED THEN UPDATE SET ${updateClause}
      WHEN NOT MATCHED THEN INSERT (${cols.join(", ")}) VALUES (${cols.map((c) => `S.${c}`).join(", ")})
    `);

    const after = Number((await bqQuery(matchedSql))[0]?.n ?? 0);
    const inserted = after - before;
    const updated = deduped.length - inserted;

    log.info(`MERGE complete: ${inserted} inserted, ${updated} updated`, {
      tableId, offered: rows.length, distinct: deduped.length, reorgSuspects,
      window: `${window.fromTs} to ${window.toTs}`, partitions: spans,
    });
    return { offered: rows.length, distinct: deduped.length, inserted, updated, reorgSuspects };
  } finally {
    try {
      await bqQuery(`DROP TABLE IF EXISTS ${stagingRef}`);
    } catch (e: any) {
      log.warn(`Failed to drop staging table ${staging}`, { error: e.message });
    }
  }
}

/**
 * Write the capture's FINAL assurance grade onto the rows it produced.
 *
 * WHY A SECOND STATEMENT IS NEEDED AT ALL. A grade is a property of the whole capture: it depends
 * on whether every chunk completed and on whether an independent source confirmed anything, and
 * neither is known while the rows are streaming out of the reader. So rows are written with the
 * conservative provisional grade C and corrected here once the range is settled.
 *
 * WHY IT IS NOT LEFT TO THE COVERAGE ROW. L0-7 says assurance travels with the ROW, and the DDL
 * declares it NOT NULL on RawLogs, because a model aggregating across grades must report the mix
 * or filter to one and it cannot do either through a join it may not know to make. Leaving the
 * provisional value in place produced exactly the defect this project keeps having: a live run
 * recorded a capture as grade A in the ledger while every row it described said C, which is two
 * different answers to one question stored in two places.
 *
 * THE FAILURE DIRECTION IS DELIBERATE. If this statement fails, the rows keep the conservative C
 * and the coverage row carries the true grade, so the warehouse under-claims rather than over-
 * claims. That is the only safe way for an assurance grade to be wrong.
 */
export async function setCaptureAssurance(
  tableId: string,
  captureId: string,
  assurance: string,
  window: MergeWindow
): Promise<number> {
  const rows = await bqQuery(
    `UPDATE ${fullTableName(tableId)} T
     SET assurance = @assurance
     WHERE ${windowPredicate("T", window)}
       AND T.capture_id = @captureId
       AND T.assurance != @assurance`,
    { assurance, captureId },
    { assurance: "STRING", captureId: "STRING" }
  );
  return rows.length;
}

// -- Repair operations --

export interface DuplicateReport {
  chainId: number;
  storedRows: number;
  distinctKeys: number;
  phantomRows: number;
  minBlock: number | null;
  maxBlock: number | null;
  minTs: string | null;
  maxTs: string | null;
}

/**
 * What the table looks like against its own natural key.
 *
 * Goes through the all-history view, which is the ONLY route the guard permits for this shape: a
 * GROUP BY over the whole table looking for a repeated key has no window by definition, and the
 * same statement straight at the table is refused. Measured, including the view correctly finding
 * a duplicate seeded into a DIFFERENT partition from its twin, which is exactly how a
 * non-covering MERGE window creates one.
 */
export async function duplicateReport(tableId: string, chainId: number): Promise<DuplicateReport> {
  const keyCols = MERGE_KEYS[tableId];
  if (!keyCols) throw new Error(`MERGE_KEY_UNKNOWN: no merge key is declared for ${tableId}`);
  const keyList = keyCols.join(", ");

  const rows = await bqQuery(`
    WITH scoped AS (
      SELECT * FROM ${allHistory(tableId)} WHERE chain_id = @chainId
    ),
    keyed AS (
      SELECT block_number, block_timestamp,
             COUNT(*) OVER (PARTITION BY ${keyList}) AS copies
      FROM scoped
    )
    SELECT
      (SELECT COUNT(*) FROM scoped) AS stored_rows,
      (SELECT COUNT(*) FROM (SELECT DISTINCT ${keyList} FROM scoped)) AS distinct_keys,
      MIN(IF(copies > 1, block_number, NULL)) AS min_dup_block,
      MAX(IF(copies > 1, block_number, NULL)) AS max_dup_block,
      MIN(IF(copies > 1, block_timestamp, NULL)) AS min_dup_ts,
      MAX(IF(copies > 1, block_timestamp, NULL)) AS max_dup_ts
    FROM keyed
  `, { chainId });

  const r = rows[0] ?? {};
  const stored = Number(r.stored_rows ?? 0);
  const distinct = Number(r.distinct_keys ?? 0);
  const ts = (v: any): string | null => (v === null || v === undefined ? null : String(v.value ?? v));
  return {
    chainId,
    storedRows: stored,
    distinctKeys: distinct,
    phantomRows: stored - distinct,
    minBlock: r.min_dup_block === null || r.min_dup_block === undefined ? null : Number(r.min_dup_block),
    maxBlock: r.max_dup_block === null || r.max_dup_block === undefined ? null : Number(r.max_dup_block),
    minTs: ts(r.min_dup_ts),
    maxTs: ts(r.max_dup_ts),
  };
}

/**
 * Collapse repeated natural keys to one row each, IN PLACE.
 *
 * WHY THIS IS NO LONGER A CREATE OR REPLACE, WHICH IS WHAT IT USED TO BE. The previous version
 * rebuilt the table from a SELECT and re-applied the partitioning and clustering by hand. On a
 * guarded table that is unsafe in a way that is completely silent: CREATE OR REPLACE TABLE ... AS
 * SELECT does not inherit require_partition_filter, so a repair would remove the one control that
 * the entire cost argument rests on and leave a table that looks identical. It does not inherit
 * the table or column descriptions either, which the previous version knew and worked around.
 * A repair that quietly disarms a safety control is worse than the damage it repairs.
 *
 * So the surplus copies are DELETED instead, which cannot change the table's own options. The
 * survivor is chosen deterministically, so running this twice produces the same table: earliest
 * ingested_at, then the lowest ingestion_run_id, then the row's own JSON as a final tiebreak.
 *
 * The DELETE carries a literal window derived from the duplicates' own timestamps, for the same
 * reason every other statement here does.
 */
export async function dedupTable(
  tableId: string,
  chainId: number,
  dryRun: boolean
): Promise<{ before: DuplicateReport; after: DuplicateReport | null; rowsRemoved: number }> {
  const keyCols = MERGE_KEYS[tableId];
  if (!keyCols) throw new Error(`MERGE_KEY_UNKNOWN: no merge key is declared for ${tableId}`);

  const before = await duplicateReport(tableId, chainId);
  if (before.phantomRows === 0) {
    log.info(`${tableId}/chain ${chainId}: no repeated keys, nothing to repair`);
    return { before, after: before, rowsRemoved: 0 };
  }

  log.warn(
    `${tableId}/chain ${chainId}: ${before.phantomRows} phantom row(s) across blocks ` +
    `${before.minBlock}..${before.maxBlock}`
  );
  if (dryRun) {
    log.info("Dry run: no rows changed");
    return { before, after: null, rowsRemoved: 0 };
  }

  if (!before.minTs || !before.maxTs) {
    throw new Error(`DEDUP: duplicates were counted but their timestamps were not, so no window can cover them`);
  }
  const w = windowForSpan(new Date(before.minTs), new Date(before.maxTs));

  await bqQuery(`
    DELETE FROM ${fullTableName(tableId)} T
    WHERE ${windowPredicate("T", w)}
      AND T.chain_id = @chainId
      AND STRUCT(${keyCols.map((k) => `T.${k}`).join(", ")}, T.ingested_at, T.ingestion_run_id, TO_JSON_STRING(T)) IN (
        SELECT AS STRUCT ${keyCols.join(", ")}, ingested_at, ingestion_run_id, row_json
        FROM (
          SELECT ${keyCols.join(", ")}, ingested_at, ingestion_run_id, TO_JSON_STRING(t) AS row_json,
                 ROW_NUMBER() OVER (
                   PARTITION BY ${keyCols.join(", ")}
                   ORDER BY ingested_at ASC, IFNULL(ingestion_run_id, '') ASC, TO_JSON_STRING(t) ASC
                 ) AS _rank
          FROM ${fullTableName(tableId)} t
          WHERE ${windowPredicate("t", w)} AND t.chain_id = @chainId
        )
        WHERE _rank > 1
      )
  `, { chainId });

  const after = await duplicateReport(tableId, chainId);
  const removed = before.storedRows - after.storedRows;
  log.info(`${tableId}/chain ${chainId}: removed ${removed} phantom row(s), ${after.phantomRows} remain`);
  return { before, after, rowsRemoved: removed };
}

/**
 * Delete a block range outright, for a re-ingest from scratch.
 *
 * Takes a window as well as a block range, because a block range is not a valid partition filter:
 * a DELETE scoped only on block_number is refused by the guard, and on an unguarded table it
 * would scan every partition to delete from one.
 */
export async function deleteBlockRange(
  tableId: string,
  chainId: number,
  fromBlock: number,
  toBlock: number,
  window: MergeWindow
): Promise<number> {
  const before = await countRowsInRange(tableId, chainId, fromBlock, toBlock, window);
  await bqQuery(
    `DELETE FROM ${fullTableName(tableId)} T
     WHERE T.chain_id = @chainId AND T.block_number >= @from AND T.block_number <= @to
       AND ${windowPredicate("T", window)}`,
    { chainId, from: fromBlock, to: toBlock }
  );
  log.warn(`Deleted ${before} row(s) from ${tableId}/chain ${chainId} blocks ${fromBlock}..${toBlock}`);
  return before;
}

/**
 * A uint256 word of `log_data`, as BIGNUMERIC, decoded in SQL.
 *
 * WHY THIS EXISTS AT ALL. Under v3 the amount was a decoded column and this was a SUM. Under v4
 * nothing is decoded at L0, so a reconciliation against the contract's own ledger has to read the
 * value out of the raw data blob. That is the cost of the universal table, named rather than
 * hidden, and it is paid by a view rather than by a re-read from the chain.
 *
 * WHY IT REFUSES THE TOP 128 BITS RATHER THAN TRUNCATING THEM. BIGNUMERIC holds 38 integer
 * digits, about 5.79e38, and a uint256 reaches 1.16e77, so the type CANNOT represent the whole
 * range. The low 128 bits reach 3.40e38 and do fit. So the high half is checked and a non-zero
 * high half yields NULL, which surfaces as an unreadable day rather than as a silently wrong
 * total. A published figure of 746,346,941,824,389,497 in this project came from ignoring exactly
 * this class of limit.
 *
 * The four 8-character groups are each at most 0xFFFFFFFF, which is inside INT64, and they are
 * recombined with BIGNUMERIC multiplication so no step goes through FLOAT64.
 */
function uint256FromLogData(dataExpr: string, wordIndex: number): string {
  const start = 3 + wordIndex * 64; // 1-based SUBSTR, skipping the two characters of the 0x prefix
  const w = `SUBSTR(${dataExpr}, ${start}, 64)`;
  const g = (i: number) => `CAST(CONCAT('0x', SUBSTR(${w}, ${33 + i * 8}, 8)) AS INT64)`;
  return `
    CASE
      WHEN LENGTH(${dataExpr}) < ${start + 63} THEN NULL
      WHEN SUBSTR(${w}, 1, 32) != REPEAT('0', 32) THEN NULL
      ELSE CAST(${g(0)} AS BIGNUMERIC) * BIGNUMERIC '79228162514264337593543950336'
         + CAST(${g(1)} AS BIGNUMERIC) * BIGNUMERIC '18446744073709551616'
         + CAST(${g(2)} AS BIGNUMERIC) * BIGNUMERIC '4294967296'
         + CAST(${g(3)} AS BIGNUMERIC)
    END`;
}

/**
 * Per-protocol-day counts and summed amounts from RawLogs, for reconciliation against the
 * contract's own ledger.
 *
 * Binds on topic0, never on an event name, which is L0-3 and is not a style rule: the GD token
 * declares two different events both called Transfer, a three argument and a four argument form,
 * with different selectors. The topic0 handed in here is COMPUTED from a signature by the caller.
 *
 * Reads through the all-history view. A reconciliation against contract state legitimately spans
 * the whole chain history and therefore has no natural window, which is the one shape the guard
 * refuses and the view exists for.
 */
export async function warehouseDailyTotals(
  chainId: number,
  contractAddress: string,
  topic0: string,
  periodStart: number,
  amountWordIndex: number,
  firstDay: number,
  lastDay: number
): Promise<Map<number, { stored: number; distinct: number; amountRaw: bigint; unreadable: number }>> {
  const rows = await bqQuery(`
    WITH scoped AS (
      SELECT chain_id, tx_hash, log_index, block_timestamp, log_data
      FROM ${allHistory(RAW_LOGS_TABLE)}
      WHERE chain_id = @chainId
        AND contract_address = @address
        AND topic0 = @topic0
    ),
    deduped AS (
      SELECT * EXCEPT(_rn) FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY chain_id, tx_hash, log_index ORDER BY block_timestamp) AS _rn
        FROM scoped
      ) WHERE _rn = 1
    ),
    stored AS (
      SELECT DIV(UNIX_SECONDS(block_timestamp) - @periodStart, 86400) AS d, COUNT(*) AS n
      FROM scoped GROUP BY d
    ),
    valued AS (
      SELECT d.*, ${uint256FromLogData("d.log_data", amountWordIndex)} AS amount
      FROM deduped d
    )
    SELECT
      DIV(UNIX_SECONDS(v.block_timestamp) - @periodStart, 86400) AS protocol_day,
      ANY_VALUE(s.n)                                             AS stored_rows,
      COUNT(*)                                                   AS distinct_rows,
      COUNTIF(v.amount IS NULL)                                  AS unreadable_rows,
      CAST(IFNULL(SUM(v.amount), 0) AS STRING)                   AS amount_raw
    FROM valued v
    LEFT JOIN stored s
      ON s.d = DIV(UNIX_SECONDS(v.block_timestamp) - @periodStart, 86400)
    GROUP BY protocol_day
    HAVING protocol_day BETWEEN @firstDay AND @lastDay
    ORDER BY protocol_day
  `, { chainId, address: contractAddress.toLowerCase(), topic0: topic0.toLowerCase(), periodStart, firstDay, lastDay });

  const out = new Map<number, { stored: number; distinct: number; amountRaw: bigint; unreadable: number }>();
  for (const r of rows) {
    out.set(Number(r.protocol_day), {
      stored: Number(r.stored_rows ?? 0),
      distinct: Number(r.distinct_rows ?? 0),
      unreadable: Number(r.unreadable_rows ?? 0),
      amountRaw: BigInt(String(r.amount_raw ?? "0").split(".")[0]),
    });
  }
  return out;
}

export async function recordReconciliation(rows: Record<string, any>[]): Promise<void> {
  if (rows.length === 0) return;
  const tbl = dataset.table("OracleReconciliation");
  const tmpFile = join(tmpdir(), `bq_recon_${randomUUID().slice(0, 8)}.ndjson`);
  writeFileSync(tmpFile, rows.map((r) => JSON.stringify(r)).join("\n"));
  try {
    await tbl.load(tmpFile, {
      sourceFormat: "NEWLINE_DELIMITED_JSON" as const,
      writeDisposition: "WRITE_APPEND" as const,
    });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
