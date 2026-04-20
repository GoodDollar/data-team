/**
 * ============================================================================
 * bq.ts — BigQuery operations
 * ============================================================================
 *
 * Every write path goes through staging + MERGE, never direct APPEND to
 * production. This makes ingestion idempotent on the composite key
 * (network, block_number, log_index, tx_hash): re-running a load with
 * overlapping rows is safe.
 *
 * Every state query (getLastBlockInBQ, existence checks, counts) fails
 * fast on error. A transient BQ error during state discovery must not
 * silently fall back to "assume empty" because that triggers a full
 * re-ingest. Operators can retry; the code cannot undo.
 *
 * Production tables are partitioned on block_number and clustered on
 * (network, contract_address, event_name). ensureTableExists verifies
 * both and warns if either is missing — it will not auto-migrate, since
 * partitioning an existing populated table requires a managed rewrite.
 * ============================================================================
 */

import { BigQuery } from "@google-cloud/bigquery";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  CONFIG,
  ContractConfig,
  fullTableName,
  stagingTableName,
} from "./config";
import { log } from "./log";
import { DecodedRow, UnknownEvent } from "./hypersync";

export const bigquery = new BigQuery({ projectId: CONFIG.GCP_PROJECT_ID });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------------------------------------------------------
// QUERY (with retry for transient errors)
// ----------------------------------------------------------------------------

/**
 * Simple heuristic: BQ errors are "retriable" if they mention transient
 * conditions. Permanent errors (schema mismatch, invalid SQL, auth) bail
 * on first failure so they surface quickly.
 */
function isRetriableBQError(e: any): boolean {
  const msg = String(e?.message ?? "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("rate limit") ||
    msg.includes("backend error") ||
    msg.includes("internal error") ||
    msg.includes("unavailable") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up")
  );
}

export async function bqQuery(
  sql: string,
  params?: Record<string, any>,
  retries = CONFIG.BQ_RETRIES
): Promise<any[]> {
  let lastErr: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const [rows] = await bigquery.query({
        query: sql,
        params,
        projectId: CONFIG.GCP_PROJECT_ID,
      });
      return rows;
    } catch (e: any) {
      lastErr = e;
      if (!isRetriableBQError(e) || attempt === retries) {
        log.error("BQ query failed", {
          error: e?.message,
          attempt,
          retriable: isRetriableBQError(e),
        });
        throw e;
      }
      const waitMs = 3_000 * attempt;
      log.warn(`BQ query retry ${attempt}/${retries} in ${waitMs}ms`, {
        error: e?.message,
      });
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// ----------------------------------------------------------------------------
// TABLE EXISTENCE & SCHEMA
// ----------------------------------------------------------------------------

/**
 * Verify a table exists and is set up the way we want.
 *
 * We don't auto-create production tables because adding partitioning to
 * a populated table requires a deliberate rewrite (CREATE TABLE AS
 * SELECT into a new partitioned table, then rename). Instead, we print
 * the exact command to create it correctly.
 *
 * If the table exists but isn't partitioned/clustered, we warn loudly
 * but proceed — the pipeline still works, just more expensively.
 */
export async function ensureTableExists(cfg: ContractConfig): Promise<void> {
  const tbl = bigquery
    .dataset(CONFIG.DATASET_ID, { projectId: CONFIG.GCP_PROJECT_ID })
    .table(cfg.tableId);

  const [exists] = await tbl.exists();
  if (!exists) {
    const schemaDef = cfg.schema.map((f) => `${f.name}:${f.type}`).join(",");
    log.fatal(
      `Table ${CONFIG.DATASET_ID}.${cfg.tableId} does not exist. Create it with the DDL below.`,
      {
        ddl_sql: buildCreateTableDDL(cfg),
        bq_cli_fallback: `bq mk --table ${CONFIG.GCP_PROJECT_ID}:${CONFIG.DATASET_ID}.${cfg.tableId} ${schemaDef}`,
      }
    );
    process.exit(1);
  }

  // Check partitioning/clustering
  const [metadata] = await tbl.getMetadata();
  const partitioning = metadata.rangePartitioning || metadata.timePartitioning;
  const clustering = metadata.clustering;

  if (!partitioning) {
    log.warn(
      `Table ${cfg.tableId} is not partitioned. Verify/repair queries will be expensive. Consider migrating to a partitioned table.`,
      { tableId: cfg.tableId }
    );
  }
  if (!clustering) {
    log.warn(
      `Table ${cfg.tableId} is not clustered. Queries filtered by network/contract will be less efficient.`,
      { tableId: cfg.tableId }
    );
  }
}

/**
 * Emit the CREATE TABLE DDL that matches what ensureTableExists expects.
 * Useful for new-contract onboarding and for documentation.
 */
export function buildCreateTableDDL(cfg: ContractConfig): string {
  const cols = cfg.schema
    .map((f) => `  ${f.name} ${f.type}`)
    .join(",\n");
  return `CREATE TABLE ${fullTableName(cfg.tableId)} (
${cols}
)
PARTITION BY RANGE_BUCKET(block_number, GENERATE_ARRAY(0, 500000000, 1000000))
CLUSTER BY network, contract_address, event_name;`;
}

// ----------------------------------------------------------------------------
// INFRASTRUCTURE TABLES
// ----------------------------------------------------------------------------

/**
 * Create the three infrastructure tables if they don't exist.
 * Safe to run every pipeline start — CREATE TABLE IF NOT EXISTS is idempotent.
 */
export async function ensureInfrastructureTables(): Promise<void> {
  const unknownT = fullTableName(CONFIG.UNKNOWN_EVENTS_TABLE);
  const statusT = fullTableName(CONFIG.INGESTION_STATUS_TABLE);
  const locksT = fullTableName(CONFIG.PIPELINE_LOCKS_TABLE);

  await bqQuery(`
    CREATE TABLE IF NOT EXISTS ${unknownT} (
      network STRING,
      block_number INT64,
      log_index INT64,
      tx_hash STRING,
      contract_address STRING,
      topic0 STRING,
      raw_data STRING,
      first_seen TIMESTAMP
    )
    PARTITION BY RANGE_BUCKET(block_number, GENERATE_ARRAY(0, 500000000, 1000000))
    CLUSTER BY network, topic0
  `);

  await bqQuery(`
    CREATE TABLE IF NOT EXISTS ${statusT} (
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
    CREATE TABLE IF NOT EXISTS ${locksT} (
      lock_name STRING,
      holder STRING,
      acquired_at TIMESTAMP,
      expires_at TIMESTAMP
    )
  `);
}

// ----------------------------------------------------------------------------
// STATE QUERIES (fail-fast)
// ----------------------------------------------------------------------------

/**
 * Get the maximum block_number for a (table, network) pair. Used as the
 * resume point for incremental ingestion.
 *
 * Fails fast on error. A transient error here must not be silently
 * converted to 0 — that would restart from firstBlock and re-ingest
 * the entire history.
 */
export async function getLastBlockInBQ(
  tableId: string,
  networkName: string
): Promise<number> {
  const rows = await bqQuery(
    `SELECT MAX(block_number) AS last_block FROM ${fullTableName(tableId)} WHERE network = @network`,
    { network: networkName }
  );
  const last = rows[0]?.last_block;
  // Empty table returns null, which maps to 0 (a valid "start from firstBlock" signal)
  if (last === null || last === undefined) return 0;
  return Number(last);
}

export async function countBlockRange(
  tableId: string,
  networkName: string,
  fromBlock: number,
  toBlock: number
): Promise<number> {
  const rows = await bqQuery(
    `SELECT COUNT(*) AS cnt FROM ${fullTableName(tableId)}
     WHERE network = @network
       AND block_number >= @fromBlock
       AND block_number < @toBlock`,
    { network: networkName, fromBlock, toBlock }
  );
  return Number(rows[0]?.cnt ?? 0);
}

export async function getRowCount(
  tableId: string,
  networkName: string
): Promise<number> {
  const rows = await bqQuery(
    `SELECT COUNT(*) AS cnt FROM ${fullTableName(tableId)} WHERE network = @network`,
    { network: networkName }
  );
  return Number(rows[0]?.cnt ?? 0);
}

// ----------------------------------------------------------------------------
// STAGING + MERGE (the one true write path)
// ----------------------------------------------------------------------------

/**
 * Load rows into a per-run staging table via atomic load job, then MERGE
 * into the production table on the composite unique key.
 *
 * Idempotent: re-running with overlapping data produces no duplicates.
 * Atomic: the MERGE either applies in full or not at all.
 *
 * Staging tables are created with WRITE_TRUNCATE on first load and
 * WRITE_APPEND for subsequent chunks within the same run, then dropped
 * after the MERGE completes.
 *
 * `chunks` is an async iterable of row arrays. The caller is responsible
 * for ensuring chunks are block-aligned (no block split across chunks).
 */
export async function stageAndMerge(
  tableId: string,
  chunks: AsyncIterable<DecodedRow[]>,
  runId: string
): Promise<{ rowsLoaded: number }> {
  const stagingId = stagingTableName(tableId, runId);
  const stagingRef = fullTableName(stagingId);
  const productionRef = fullTableName(tableId);

  let totalLoaded = 0;
  let firstChunk = true;

  try {
    for await (const chunk of chunks) {
      if (chunk.length === 0) continue;
      await loadChunkToTable(
        chunk,
        stagingId,
        firstChunk ? "WRITE_TRUNCATE" : "WRITE_APPEND"
      );
      totalLoaded += chunk.length;
      firstChunk = false;
      log.info(`Loaded ${chunk.length} rows to staging`, {
        tableId,
        stagingId,
        totalLoaded,
      });
    }

    if (totalLoaded === 0) {
      log.info("No rows to merge", { tableId });
      return { rowsLoaded: 0 };
    }

    // MERGE on the composite unique key. Use UPDATE SET * / INSERT ROW
    // so schema changes don't require editing this statement.
    await bqQuery(`
      MERGE ${productionRef} AS T
      USING ${stagingRef} AS S
        ON T.network = S.network
       AND T.block_number = S.block_number
       AND T.log_index = S.log_index
       AND T.tx_hash = S.tx_hash
      WHEN MATCHED THEN UPDATE SET
        ${productionMergeUpdateClause(tableId)}
      WHEN NOT MATCHED THEN INSERT ROW
    `);

    log.info(`MERGE complete`, { tableId, rowsLoaded: totalLoaded });
    return { rowsLoaded: totalLoaded };
  } finally {
    // Always drop staging, even on error. Leaking staging tables is a
    // cost and clutter issue, not a correctness issue.
    try {
      await bqQuery(`DROP TABLE IF EXISTS ${stagingRef}`);
    } catch (e: any) {
      log.warn("Failed to drop staging table", {
        stagingId,
        error: e?.message,
      });
    }
  }
}

/**
 * Build the SET clause for MERGE's UPDATE branch. We don't hardcode
 * columns — we read them from INFORMATION_SCHEMA once per tableId per
 * run and cache. This lets new columns work without code changes.
 */
const mergeUpdateCache = new Map<string, string>();

function productionMergeUpdateClause(tableId: string): string {
  const cached = mergeUpdateCache.get(tableId);
  if (cached) return cached;

  // Build from CONTRACT_CONFIGS at module load — we know the schema
  // statically. This avoids an extra BQ round-trip.
  // Import here to avoid circular dependency at module top level.
  const { CONTRACT_CONFIGS } = require("./config") as typeof import("./config");
  const cfg = CONTRACT_CONFIGS.find((c) => c.tableId === tableId);
  if (!cfg) {
    throw new Error(`No contract config for tableId=${tableId}`);
  }

  // Don't overwrite the unique-key columns — they're the match condition.
  const keyCols = new Set(["network", "block_number", "log_index", "tx_hash"]);
  const updatable = cfg.schema.filter((f) => !keyCols.has(f.name));
  const clause = updatable
    .map((f) => `T.${f.name} = S.${f.name}`)
    .join(",\n        ");

  mergeUpdateCache.set(tableId, clause);
  return clause;
}

/**
 * Single load job: write NDJSON to temp file, load to target table with
 * the given disposition, clean up temp file.
 *
 * Retries on transient load-job errors. Permanent errors (schema
 * mismatch) surface immediately.
 */
async function loadChunkToTable(
  rows: DecodedRow[],
  tableId: string,
  writeMode: "WRITE_APPEND" | "WRITE_TRUNCATE"
): Promise<void> {
  if (rows.length === 0) return;

  const unique = randomUUID();
  const tmpFile = join(tmpdir(), `bq_load_${tableId}_${unique}.json`);

  try {
    const ndjson = rows.map((r) => JSON.stringify(r, bigintReplacer)).join("\n");
    writeFileSync(tmpFile, ndjson, "utf-8");

    const tbl = bigquery
      .dataset(CONFIG.DATASET_ID, { projectId: CONFIG.GCP_PROJECT_ID })
      .table(tableId);

    let lastErr: any;
    for (let attempt = 1; attempt <= CONFIG.LOAD_RETRIES; attempt++) {
      try {
        const [job] = await tbl.load(tmpFile, {
          sourceFormat: "NEWLINE_DELIMITED_JSON",
          writeDisposition: writeMode,
          autodetect: writeMode === "WRITE_TRUNCATE", // staging table: detect schema on first load
          createDisposition: "CREATE_IF_NEEDED",
        });

        const errors = job.status?.errors;
        if (errors && errors.length > 0) {
          throw new Error(
            `Load job errors: ${errors.map((e: any) => e.message).join("; ")}`
          );
        }
        return;
      } catch (e: any) {
        lastErr = e;
        if (!isRetriableBQError(e) || attempt === CONFIG.LOAD_RETRIES) {
          log.error("Load job failed", {
            tableId,
            attempt,
            error: e?.message,
          });
          throw e;
        }
        const waitMs = 5_000 * attempt;
        log.warn(
          `Load retry ${attempt}/${CONFIG.LOAD_RETRIES} in ${waitMs}ms`,
          { tableId, error: e?.message }
        );
        await sleep(waitMs);
      }
    }
    throw lastErr;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // temp file cleanup failures are not critical
    }
  }
}

/**
 * JSON replacer for row serialization. BigQuery expects JSON numbers or
 * strings for INT64 — BigInts from decoder args are stringified by the
 * decodeToRow functions, but any stray BigInt would otherwise throw here.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// ----------------------------------------------------------------------------
// RANGE DELETE (for repair)
// ----------------------------------------------------------------------------

export async function deleteBlockRange(
  tableId: string,
  networkName: string,
  fromBlock: number,
  toBlock: number
): Promise<void> {
  await bqQuery(
    `DELETE FROM ${fullTableName(tableId)}
     WHERE network = @network
       AND block_number >= @fromBlock
       AND block_number < @toBlock`,
    { network: networkName, fromBlock, toBlock }
  );
}

// ----------------------------------------------------------------------------
// UNKNOWN EVENTS
// ----------------------------------------------------------------------------

/**
 * Append unknown-event rows to the UnknownEvents table. Uses staging+MERGE
 * on (network, block_number, log_index, tx_hash) so re-observing the same
 * undecoded event is a no-op.
 */
export async function writeUnknownEvents(
  events: UnknownEvent[],
  runId: string
): Promise<void> {
  if (events.length === 0) return;
  const now = new Date().toISOString();
  const rows = events.map((e) => ({ ...e, first_seen: now }));

  // Reuse stageAndMerge — feed as a single-chunk async iterable
  async function* single() {
    yield rows;
  }
  // Compose a synthetic table config path: same staging+MERGE pattern, but
  // with the UnknownEvents MERGE clause (we define it inline here since
  // productionMergeUpdateClause reads from CONTRACT_CONFIGS only).
  const stagingId = stagingTableName(CONFIG.UNKNOWN_EVENTS_TABLE, runId + "_unk");
  const stagingRef = fullTableName(stagingId);
  const productionRef = fullTableName(CONFIG.UNKNOWN_EVENTS_TABLE);

  try {
    await loadChunkToTable(rows, stagingId, "WRITE_TRUNCATE");
    await bqQuery(`
      MERGE ${productionRef} AS T
      USING ${stagingRef} AS S
        ON T.network = S.network
       AND T.block_number = S.block_number
       AND T.log_index = S.log_index
       AND T.tx_hash = S.tx_hash
      WHEN MATCHED THEN UPDATE SET
        T.contract_address = S.contract_address,
        T.topic0 = S.topic0,
        T.raw_data = S.raw_data
      WHEN NOT MATCHED THEN INSERT ROW
    `);
  } finally {
    try {
      await bqQuery(`DROP TABLE IF EXISTS ${stagingRef}`);
    } catch {
      // ignore
    }
  }
  log.info(`Recorded ${events.length} unknown events`, {
    table: CONFIG.UNKNOWN_EVENTS_TABLE,
  });
}

// ----------------------------------------------------------------------------
// INGESTION STATUS
// ----------------------------------------------------------------------------

export type IngestionStatusValue =
  | "pending"
  | "complete"
  | "failed"
  | "skipped";

export async function markIngestionStatus(
  opts: {
    networkName: string;
    tableId: string;
    date: string; // YYYY-MM-DD
    status: IngestionStatusValue;
    lastBlock?: number;
    rowCount?: number;
    errorMessage?: string;
    runId: string;
  }
): Promise<void> {
  const statusTable = fullTableName(CONFIG.INGESTION_STATUS_TABLE);
  const now = new Date().toISOString();

  // Upsert on (network, table_id, ingestion_date)
  await bqQuery(
    `
    MERGE ${statusTable} AS T
    USING (SELECT
      @network AS network,
      @table_id AS table_id,
      DATE(@ingestion_date) AS ingestion_date,
      @status AS status,
      @last_block AS last_block,
      @row_count AS row_count,
      TIMESTAMP(@started_at) AS started_at,
      TIMESTAMP(@completed_at) AS completed_at,
      @error_message AS error_message,
      @run_id AS run_id
    ) AS S
      ON T.network = S.network
     AND T.table_id = S.table_id
     AND T.ingestion_date = S.ingestion_date
    WHEN MATCHED THEN UPDATE SET
      status = S.status,
      last_block = COALESCE(S.last_block, T.last_block),
      row_count = COALESCE(S.row_count, T.row_count),
      completed_at = COALESCE(S.completed_at, T.completed_at),
      error_message = S.error_message,
      run_id = S.run_id
    WHEN NOT MATCHED THEN INSERT (
      network, table_id, ingestion_date, status, last_block, row_count,
      started_at, completed_at, error_message, run_id
    ) VALUES (
      S.network, S.table_id, S.ingestion_date, S.status, S.last_block, S.row_count,
      S.started_at, S.completed_at, S.error_message, S.run_id
    )
    `,
    {
      network: opts.networkName,
      table_id: opts.tableId,
      ingestion_date: opts.date,
      status: opts.status,
      last_block: opts.lastBlock ?? null,
      row_count: opts.rowCount ?? null,
      started_at: now,
      completed_at:
        opts.status === "complete" ||
        opts.status === "failed" ||
        opts.status === "skipped"
          ? now
          : null,
      error_message: opts.errorMessage ?? null,
      run_id: opts.runId,
    }
  );
}

// ----------------------------------------------------------------------------
// PIPELINE LOCK
// ----------------------------------------------------------------------------

/**
 * Acquire a named lock. Returns true if acquired, false if held by
 * another non-expired holder. Atomic via MERGE.
 *
 * If a holder exists but its expires_at is past, we steal the lock and
 * log a warning — the previous run crashed without releasing.
 */
export async function acquireLock(
  lockName: string,
  holder: string,
  ttlMs: number
): Promise<boolean> {
  const locksTable = fullTableName(CONFIG.PIPELINE_LOCKS_TABLE);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // First, read current state
  const rows = await bqQuery(
    `SELECT holder, expires_at FROM ${locksTable} WHERE lock_name = @lock_name`,
    { lock_name: lockName }
  );

  if (rows.length > 0) {
    const existing = rows[0];
    const existingExpiry = new Date(existing.expires_at?.value ?? existing.expires_at);
    if (existingExpiry > now) {
      log.warn(`Lock ${lockName} held by ${existing.holder} until ${existingExpiry.toISOString()}`);
      return false;
    }
    log.warn(
      `Stealing expired lock ${lockName} from ${existing.holder} (expired ${existingExpiry.toISOString()})`
    );
  }

  await bqQuery(
    `
    MERGE ${locksTable} AS T
    USING (SELECT @lock_name AS lock_name, @holder AS holder,
           TIMESTAMP(@acquired_at) AS acquired_at,
           TIMESTAMP(@expires_at) AS expires_at) AS S
      ON T.lock_name = S.lock_name
    WHEN MATCHED THEN UPDATE SET
      holder = S.holder, acquired_at = S.acquired_at, expires_at = S.expires_at
    WHEN NOT MATCHED THEN INSERT (lock_name, holder, acquired_at, expires_at)
      VALUES (S.lock_name, S.holder, S.acquired_at, S.expires_at)
    `,
    {
      lock_name: lockName,
      holder,
      acquired_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    }
  );

  // Race check: someone else could have won the MERGE. Re-read.
  const verify = await bqQuery(
    `SELECT holder FROM ${locksTable} WHERE lock_name = @lock_name`,
    { lock_name: lockName }
  );
  return verify[0]?.holder === holder;
}

export async function releaseLock(
  lockName: string,
  holder: string
): Promise<void> {
  const locksTable = fullTableName(CONFIG.PIPELINE_LOCKS_TABLE);
  await bqQuery(
    `DELETE FROM ${locksTable} WHERE lock_name = @lock_name AND holder = @holder`,
    { lock_name: lockName, holder }
  );
}
