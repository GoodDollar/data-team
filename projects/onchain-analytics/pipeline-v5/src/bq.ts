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
import type { SchemaField, IngestionRecord, PipelineRunRecord } from "./types.js";

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

// -- Staging + MERGE (the one true write path) --

export async function stageAndMerge(
  tableId: string,
  rows: Record<string, any>[],
  schema: SchemaField[],
  runId: string
): Promise<{ rowsMerged: number }> {
  if (rows.length === 0) return { rowsMerged: 0 };

  const staging = stagingTableId(tableId, runId);
  const stagingRef = fullTableName(staging);
  const productionRef = fullTableName(tableId);

  try {
    // Load rows as NDJSON via temp file (BQ load requires file path or GCS URI)
    const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
    const tmpFile = join(tmpdir(), `bq_staging_${runId}_${randomUUID().slice(0, 8)}.ndjson`);
    writeFileSync(tmpFile, ndjson);

    const tbl = dataset.table(staging);
    const metadata = {
      sourceFormat: "NEWLINE_DELIMITED_JSON" as const,
      writeDisposition: "WRITE_TRUNCATE" as const,
      schema: { fields: schema },
    };

    // Retry load job
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

    // Clean up temp file
    try { unlinkSync(tmpFile); } catch { /* ignore */ }

    if (loadErr) throw loadErr;

    // Build MERGE UPDATE clause (all non-key columns)
    const keyCols = new Set(["network", "tx_hash", "log_index"]);
    const updateCols = schema.filter((f) => !keyCols.has(f.name));
    const updateClause = updateCols.map((f) => `T.${f.name} = S.${f.name}`).join(", ");

    // MERGE
    await bqQuery(`
      MERGE ${productionRef} AS T
      USING ${stagingRef} AS S
        ON T.network = S.network
       AND T.tx_hash = S.tx_hash
       AND T.log_index = S.log_index
      WHEN MATCHED THEN UPDATE SET ${updateClause}
      WHEN NOT MATCHED THEN INSERT ROW
    `);

    log.info(`MERGE complete: ${rows.length} rows`, { tableId });
    return { rowsMerged: rows.length };
  } finally {
    // Always clean up staging table
    try {
      await bqQuery(`DROP TABLE IF EXISTS ${stagingRef}`);
    } catch (e: any) {
      log.warn(`Failed to drop staging table ${staging}`, { error: e.message });
    }
  }
}
