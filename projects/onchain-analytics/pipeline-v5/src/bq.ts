/**
 * bq.ts -- BigQuery operations. Staging + MERGE write path, state queries.
 */

import { BigQuery } from "@google-cloud/bigquery";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { CONFIG, fullTableName, stagingTableId } from "./config.js";
import { log, RUN_ID } from "./log.js";
import type { SchemaField, IngestionRecord, PipelineRunRecord, CoverageRecord } from "./types.js";

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

export async function bqQuery(sql: string, params?: Record<string, any>): Promise<any[]> {
  let lastErr: any;
  for (let attempt = 1; attempt <= CONFIG.BQ_RETRIES; attempt++) {
    try {
      const [rows] = await bigquery.query({ query: sql, params, projectId: CONFIG.GCP_PROJECT_ID });
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

export async function getLastBlock(tableId: string, network: string): Promise<number> {
  const rows = await bqQuery(
    `SELECT MAX(block_number) AS last_block FROM ${fullTableName(tableId)} WHERE network = @network`,
    { network }
  );
  const last = rows[0]?.last_block;
  if (last === null || last === undefined) return 0;
  return Number(last);
}

export async function countRows(tableId: string, network: string, fromBlock: number, toBlock: number): Promise<number> {
  const rows = await bqQuery(
    `SELECT COUNT(*) AS cnt FROM ${fullTableName(tableId)} WHERE network = @network AND block_number >= @from AND block_number <= @to`,
    { network, from: fromBlock, to: toBlock }
  );
  return Number(rows[0]?.cnt ?? 0);
}

export async function getMaxBlockTimestamp(tableId: string, network: string): Promise<Date | null> {
  const rows = await bqQuery(
    `SELECT MAX(block_timestamp) AS max_ts FROM ${fullTableName(tableId)} WHERE network = @network`,
    { network }
  );
  const ts = rows[0]?.max_ts;
  if (!ts) return null;
  return new Date(ts.value ?? ts);
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

export async function ensureInfraTables(): Promise<void> {
  await bqQuery(`
    CREATE TABLE IF NOT EXISTS ${fullTableName("IngestionStatus")} (
      network STRING,
      table_id STRING,
      ingestion_date DATE,
      status STRING,
      last_block INT64,
      row_count INT64,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      error_message STRING,
      run_id STRING
    )
    PARTITION BY ingestion_date
    CLUSTER BY network, table_id
  `);

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
      error_message STRING
    )
    PARTITION BY DATE(started_at)
  `);

  // The coverage ledger. "Did we cover blocks X to Y, and how many times" becomes a query
  // rather than a belief. IngestionStatus cannot answer it: it records one last_block per run
  // and wrote the literal value -1 with status "success" on every run that fetched nothing,
  // so it cannot tell "there was nothing to fetch" apart from "the fetch returned nothing".
  await bqQuery(`
    CREATE TABLE IF NOT EXISTS ${fullTableName("IngestionCoverage")} (
      run_id STRING,
      network STRING,
      table_id STRING,
      from_block INT64,
      to_block INT64,
      status STRING OPTIONS(description="complete, incomplete, or unconfirmed_empty. Never plain success."),
      chunks_planned INT64,
      chunks_ok INT64,
      skipped_ranges STRING,
      rows_merged INT64,
      rows_inserted INT64,
      rows_updated INT64,
      logs_seen INT64,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      error_message STRING
    )
    PARTITION BY DATE(started_at)
    CLUSTER BY network, table_id
  `);

  // Per-day reconciliation against the contract's own ledger, kept so that a regression is
  // visible as history rather than as one run's console output.
  await bqQuery(`
    CREATE TABLE IF NOT EXISTS ${fullTableName("OracleReconciliation")} (
      run_id STRING,
      network STRING,
      table_id STRING,
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
    CLUSTER BY network, table_id
  `);
}

// -- Record keeping --

export async function recordIngestionStatus(record: IngestionRecord): Promise<void> {
  await bqQuery(
    `INSERT INTO ${fullTableName("IngestionStatus")}
     (network, table_id, ingestion_date, status, last_block, row_count, started_at, completed_at, error_message, run_id)
     VALUES (@network, @tableId, @ingestionDate, @status, @lastBlock, @rowCount, TIMESTAMP(@startedAt), TIMESTAMP(@completedAt), @errorMessage, @runId)`,
    {
      network: record.network,
      tableId: record.tableId,
      ingestionDate: record.ingestionDate,
      status: record.status,
      lastBlock: record.lastBlock,
      rowCount: record.rowCount,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      errorMessage: record.errorMessage || "",
      runId: record.runId,
    }
  );
}

export async function recordPipelineRun(record: PipelineRunRecord): Promise<void> {
  await bqQuery(
    `INSERT INTO ${fullTableName("PipelineRuns")}
     (run_id, mode, started_at, completed_at, exit_code, total_rows_merged, contracts_processed, contracts_failed, host, error_message)
     VALUES (@runId, @mode, TIMESTAMP(@startedAt), TIMESTAMP(@completedAt), @exitCode, @totalRowsMerged, @contractsProcessed, @contractsFailed, @host, @errorMessage)`,
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
    }
  );
}

export async function recordCoverage(r: CoverageRecord): Promise<void> {
  await bqQuery(
    `INSERT INTO ${fullTableName("IngestionCoverage")}
     (run_id, network, table_id, from_block, to_block, status, chunks_planned, chunks_ok,
      skipped_ranges, rows_merged, rows_inserted, rows_updated, logs_seen,
      started_at, completed_at, error_message)
     VALUES (@runId, @network, @tableId, @fromBlock, @toBlock, @status, @chunksPlanned, @chunksOk,
      @skippedRanges, @rowsMerged, @rowsInserted, @rowsUpdated, @logsSeen,
      TIMESTAMP(@startedAt), TIMESTAMP(@completedAt), @errorMessage)`,
    { ...r }
  );
}

// -- Staging + MERGE (the one true write path) --

const KEY_COLS = ["network", "tx_hash", "log_index"] as const;

const keyOf = (r: Record<string, any>): string => `${r.network}|${r.tx_hash}|${r.log_index}`;

/**
 * Write rows into the production table, idempotently.
 *
 * Three properties this has to hold, each traceable to a defect that actually happened:
 *
 *   The key is (network, tx_hash, log_index). The predecessor pipeline appended through
 *   streaming inserts with a best-effort insertId, whose de-duplication window is minutes, so
 *   re-running a block range weeks later wrote every event a second time. 43,000 phantom claim
 *   rows and 2,167 phantom invite rows came from exactly that.
 *
 *   Columns are named rather than INSERT ROW. The target table has since gained 21 columns for
 *   events this pipeline does not ingest, and INSERT ROW requires the column lists to match.
 *
 *   The staging set is de-duplicated in process first. Two source rows with one key make
 *   BigQuery reject the whole MERGE, so a single repeated log would fail an entire backfill.
 *
 * Returns the real insert and update split, measured against the table, not the row count that
 * was handed in. The previous implementation reported rows.length as "merged", which is the
 * number of rows OFFERED and says nothing about what the table did with them.
 */
export async function stageAndMerge(
  tableId: string,
  rows: Record<string, any>[],
  schema: SchemaField[],
  runId: string
): Promise<{ offered: number; distinct: number; inserted: number; updated: number; reorgSuspects: number }> {
  if (rows.length === 0) return { offered: 0, distinct: 0, inserted: 0, updated: 0, reorgSuspects: 0 };

  const byKey = new Map<string, Record<string, any>>();
  for (const r of rows) byKey.set(keyOf(r), r);
  const deduped = [...byKey.values()];
  if (deduped.length !== rows.length) {
    log.warn(`Staging set carried ${rows.length - deduped.length} repeated key(s); collapsed before MERGE`, {
      tableId, offered: rows.length, distinct: deduped.length,
    });
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

  const matchedSql = `
    SELECT COUNT(*) AS n FROM ${productionRef} T
    WHERE EXISTS (
      SELECT 1 FROM ${stagingRef} S
      WHERE ${KEY_COLS.map((k) => `T.${k} = S.${k}`).join(" AND ")}
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

    // B5. Block-hash reconciliation. A key that already exists but now sits under a different
    // block hash is a reorg, and a MERGE would quietly overwrite the old row and leave no trace
    // that the chain changed its mind. Surfaced as data rather than silently applied.
    let reorgSuspects = 0;
    if (live.has("block_hash")) {
      const r = await bqQuery(`
        SELECT COUNT(*) AS n
        FROM ${productionRef} T
        JOIN ${stagingRef} S
          ON ${KEY_COLS.map((k) => `T.${k} = S.${k}`).join(" AND ")}
        WHERE T.block_hash IS NOT NULL
          AND S.block_hash IS NOT NULL
          AND T.block_hash != S.block_hash
      `);
      reorgSuspects = Number(r[0]?.n ?? 0);
      if (reorgSuspects > 0) {
        log.error(
          `REORG SUSPECTED: ${reorgSuspects} existing row(s) in ${tableId} carry a different ` +
          `block_hash than the chain now reports for the same (network, tx_hash, log_index)`,
          { tableId, runId }
        );
      }
    }

    // Provenance is written once and never churned. Re-running a backfill must leave the table
    // byte-identical, and it cannot do that if every re-run rewrites ingested_at. Who re-ran
    // what is recorded in IngestionCoverage, which is the right place for it.
    const IMMUTABLE_ON_MATCH = new Set(["ingested_at", "ingestion_run_id"]);
    const updateClause = cols
      .filter((c) => !KEY_COLS.includes(c as any) && !IMMUTABLE_ON_MATCH.has(c))
      .map((c) => `T.${c} = S.${c}`)
      .join(", ");

    await bqQuery(`
      MERGE ${productionRef} AS T
      USING ${stagingRef} AS S
        ON ${KEY_COLS.map((k) => `T.${k} = S.${k}`).join(" AND ")}
      WHEN MATCHED THEN UPDATE SET ${updateClause}
      WHEN NOT MATCHED THEN INSERT (${cols.join(", ")}) VALUES (${cols.map((c) => `S.${c}`).join(", ")})
    `);

    const after = Number((await bqQuery(matchedSql))[0]?.n ?? 0);
    const inserted = after - before;
    const updated = deduped.length - inserted;

    log.info(`MERGE complete: ${inserted} inserted, ${updated} updated`, {
      tableId, offered: rows.length, distinct: deduped.length, reorgSuspects,
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

// -- Repair operations --

export interface DuplicateReport {
  network: string;
  storedRows: number;
  distinctKeys: number;
  phantomRows: number;
  minBlock: number | null;
  maxBlock: number | null;
}

/** What the table looks like against its own natural key. */
export async function duplicateReport(tableId: string, network: string): Promise<DuplicateReport> {
  const rows = await bqQuery(`
    WITH keyed AS (
      SELECT block_number,
             COUNT(*) OVER (PARTITION BY network, tx_hash, log_index) AS copies
      FROM ${fullTableName(tableId)}
      WHERE network = @network
    )
    SELECT
      (SELECT COUNT(*) FROM ${fullTableName(tableId)} WHERE network = @network) AS stored_rows,
      (SELECT COUNT(*) FROM (
         SELECT DISTINCT network, tx_hash, log_index
         FROM ${fullTableName(tableId)} WHERE network = @network)) AS distinct_keys,
      MIN(IF(copies > 1, block_number, NULL)) AS min_dup_block,
      MAX(IF(copies > 1, block_number, NULL)) AS max_dup_block
    FROM keyed
  `, { network });

  const r = rows[0] ?? {};
  const stored = Number(r.stored_rows ?? 0);
  const distinct = Number(r.distinct_keys ?? 0);
  return {
    network,
    storedRows: stored,
    distinctKeys: distinct,
    phantomRows: stored - distinct,
    minBlock: r.min_dup_block === null || r.min_dup_block === undefined ? null : Number(r.min_dup_block),
    maxBlock: r.max_dup_block === null || r.max_dup_block === undefined ? null : Number(r.max_dup_block),
  };
}

/**
 * Collapse repeated natural keys to one row each, in place.
 *
 * MERGE stops NEW duplicates. It cannot repair rows already written, so the historical damage
 * needs its own operation. The surviving copy is chosen deterministically, so running this
 * twice produces the same table: earliest ingested_at first, then the lowest ingestion_run_id,
 * so the row that is kept is the one that was written first.
 *
 * The rewrite is a single atomic CREATE OR REPLACE from a SELECT, so the table is never
 * observed half-repaired. Partitioning and clustering are preserved explicitly, because
 * CREATE OR REPLACE TABLE does not inherit them.
 */
export async function dedupTable(
  tableId: string,
  network: string,
  dryRun: boolean
): Promise<{ before: DuplicateReport; after: DuplicateReport | null; rowsRemoved: number }> {
  const before = await duplicateReport(tableId, network);
  if (before.phantomRows === 0) {
    log.info(`${tableId}/${network}: no repeated keys, nothing to repair`);
    return { before, after: before, rowsRemoved: 0 };
  }

  log.warn(`${tableId}/${network}: ${before.phantomRows} phantom row(s) across blocks ${before.minBlock}..${before.maxBlock}`);
  if (dryRun) {
    log.info("Dry run: no rows changed");
    return { before, after: null, rowsRemoved: 0 };
  }

  const [metadata] = await dataset.table(tableId).getMetadata();
  const partition: string = metadata.timePartitioning?.field
    ? `PARTITION BY DATE(${metadata.timePartitioning.field})`
    : "";
  const cluster: string = metadata.clustering?.fields?.length
    ? `CLUSTER BY ${metadata.clustering.fields.join(", ")}`
    : "";

  // A backup before an in-place rewrite of a production table. BigQuery time travel covers
  // seven days, which is a floor rather than a plan.
  const backup = `${tableId}_predup_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  await bqQuery(`CREATE TABLE IF NOT EXISTS ${fullTableName(backup)} AS SELECT * FROM ${fullTableName(tableId)}`);
  log.info(`Backup written: ${backup}`);

  // The surviving copy is chosen deterministically, so running this twice produces the same
  // table: earliest ingested_at first, then run id, then the row's own JSON as a final
  // tiebreak. Without that last term, rows that tie on both provenance fields would be ordered
  // arbitrarily and a repeated repair would not be reproducible.
  await bqQuery(`
    CREATE OR REPLACE TABLE ${fullTableName(tableId)}
    ${partition}
    ${cluster}
    AS
    SELECT * EXCEPT(_dedup_rank) FROM (
      SELECT t.*, ROW_NUMBER() OVER (
        PARTITION BY network, tx_hash, log_index
        ORDER BY ingested_at ASC, IFNULL(ingestion_run_id, '') ASC, TO_JSON_STRING(t) ASC
      ) AS _dedup_rank
      FROM ${fullTableName(tableId)} t
    )
    WHERE _dedup_rank = 1
  `);

  // CREATE OR REPLACE TABLE ... AS SELECT carries the data and drops the documentation. Column
  // descriptions and the table description are not inherited, and losing them silently breaks
  // the dbt catalog that analysts read. They are captured above and put back here.
  try {
    await dataset.table(tableId).setMetadata({
      schema: metadata.schema,
      description: metadata.description,
    });
    log.info(`Restored column and table descriptions on ${tableId}`);
  } catch (e: any) {
    log.error(
      `Table was de-duplicated but its descriptions could not be restored: ${e.message}. ` +
      `Re-apply warehouse/L1 DDL.`,
      { tableId }
    );
  }

  const after = await duplicateReport(tableId, network);
  const removed = before.storedRows - after.storedRows;
  log.info(`${tableId}/${network}: removed ${removed} phantom row(s), ${after.phantomRows} remain`);
  return { before, after, rowsRemoved: removed };
}

/** Delete a block range outright. Used to re-ingest a range from scratch. */
export async function deleteBlockRange(
  tableId: string,
  network: string,
  fromBlock: number,
  toBlock: number
): Promise<number> {
  const before = await countRows(tableId, network, fromBlock, toBlock);
  await bqQuery(
    `DELETE FROM ${fullTableName(tableId)}
     WHERE network = @network AND block_number >= @from AND block_number <= @to`,
    { network, from: fromBlock, to: toBlock }
  );
  log.warn(`Deleted ${before} row(s) from ${tableId}/${network} blocks ${fromBlock}..${toBlock}`);
  return before;
}

/** Per-protocol-day counts and summed amounts, for reconciliation against the contract. */
export async function warehouseDailyTotals(
  tableId: string,
  network: string,
  periodStart: number,
  amountColumn: string,
  firstDay: number,
  lastDay: number
): Promise<Map<number, { stored: number; distinct: number; amountRaw: bigint }>> {
  const rows = await bqQuery(`
    WITH deduped AS (
      SELECT * EXCEPT(_rn) FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY network, tx_hash, log_index ORDER BY ingested_at ASC
        ) AS _rn
        FROM ${fullTableName(tableId)}
        WHERE network = @network
      ) WHERE _rn = 1
    ),
    stored AS (
      SELECT DIV(UNIX_SECONDS(block_timestamp) - @periodStart, 86400) AS d, COUNT(*) AS n
      FROM ${fullTableName(tableId)}
      WHERE network = @network
      GROUP BY d
    )
    SELECT
      DIV(UNIX_SECONDS(d.block_timestamp) - @periodStart, 86400) AS protocol_day,
      ANY_VALUE(s.n)                                             AS stored_rows,
      COUNT(*)                                                   AS distinct_rows,
      CAST(SUM(CAST(d.${amountColumn} AS BIGNUMERIC)) AS STRING)  AS amount_raw
    FROM deduped d
    LEFT JOIN stored s
      ON s.d = DIV(UNIX_SECONDS(d.block_timestamp) - @periodStart, 86400)
    GROUP BY protocol_day
    HAVING protocol_day BETWEEN @firstDay AND @lastDay
    ORDER BY protocol_day
  `, { network, periodStart, firstDay, lastDay });

  const out = new Map<number, { stored: number; distinct: number; amountRaw: bigint }>();
  for (const r of rows) {
    out.set(Number(r.protocol_day), {
      stored: Number(r.stored_rows ?? 0),
      distinct: Number(r.distinct_rows ?? 0),
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
