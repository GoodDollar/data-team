#!/usr/bin/env node
// Applies the exact allowlisted migration files to a fresh labelled sandbox, then proves schema,
// idempotency, legacy-row preservation and cleanup. No production table is written or copied.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ENVIO_API_TOKEN ??= 'stage-a-no-chain-reader';
process.env.DATASET_ID ??= 'BlockchainEvents';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationDir = resolve(projectRoot, 'warehouse/L1');
const runtimeSource = readFileSync(resolve(projectRoot, 'pipeline-v5/src/bq.ts'), 'utf8');
const outputPath = resolve(process.argv[2] ?? resolve(projectRoot, '../../_scratch/schema-migration-validation.json'));
const allowed = [
  '08_PipelineRunsOutcome_v1.sql',
  '09_CreateRawLogs_v1.sql',
  '10_AddOracleReconciliationCompatibility_v1.sql',
  '11_CreateRawLogsAllHistory_v1.sql',
  '12_CreateTransactionsAllHistory_v1.sql',
];
const maxBytesPerJob = 10 * 1024 ** 3;
const maxBytesTotal = 50 * 1024 ** 3;

const [{ CONFIG, RAW_LOGS_SCHEMA, TRANSACTIONS_SCHEMA }, { getBigQueryClient }, sandbox] = await Promise.all([
  import('../../pipeline-v5/src/config.ts'),
  import('../../pipeline-v5/src/adapters.ts'),
  import('../../pipeline-v5/src/sandbox.ts'),
]);
await import('../../pipeline-v5/src/bq.ts');

const report = {
  project: CONFIG.GCP_PROJECT_ID,
  access_mode: 'labelled sandbox only; no production DDL, DML, or chain ingestion',
  migrations: [],
  jobs: [],
  errors: [],
};
let handle;
let cleanup;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSchemaMatches(tableId, fields, expected) {
  assert(expected.length > 0, `Runtime schema for ${tableId} could not be extracted`);
  const actualShape = fields.map((field) => `${field.name}:${field.type}:${field.mode ?? 'NULLABLE'}`);
  const expectedShape = expected.map((field) => `${field.name}:${field.type}:${field.mode ?? 'NULLABLE'}`);
  assert(JSON.stringify(actualShape) === JSON.stringify(expectedShape),
    `${tableId} schema differs from the runtime contract; expected=${JSON.stringify(expectedShape)} actual=${JSON.stringify(actualShape)}`);
}

function runtimeTableSchema(tableId) {
  const marker = 'CREATE TABLE IF NOT EXISTS ${fullTableName("' + tableId + '")} (';
  const start = runtimeSource.indexOf(marker);
  assert(start >= 0, `Runtime CREATE TABLE definition for ${tableId} was not found`);
  const bodyStart = start + marker.length;
  const bodyEnd = runtimeSource.indexOf('\n    )', bodyStart);
  assert(bodyEnd >= 0, `Runtime CREATE TABLE definition for ${tableId} is unterminated`);
  const typeMap = { INT64: 'INTEGER', BOOL: 'BOOLEAN', FLOAT64: 'FLOAT' };
  return runtimeSource.slice(bodyStart, bodyEnd).split(/\r?\n/).flatMap((sourceLine) => {
    const line = sourceLine.trim();
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(STRING|INT64|TIMESTAMP|JSON|FLOAT64|BOOL)\b/i);
    if (!match) return [];
    const sourceType = match[2].toUpperCase();
    return [{
      name: match[1],
      type: typeMap[sourceType] ?? sourceType,
      mode: /\bNOT NULL\b/i.test(match[3]) ? 'REQUIRED' : 'NULLABLE',
    }];
  });
}

function renderMigration(name, datasetId) {
  assert(allowed.includes(name), `REFUSED_UNLISTED_MIGRATION: ${name}`);
  const source = readFileSync(resolve(migrationDir, name), 'utf8');
  assert(source.includes('${PROJECT}') && source.includes('${DATASET}'), `${name} lacks identifier placeholders`);
  const rendered = source.replaceAll('${PROJECT}', CONFIG.GCP_PROJECT_ID).replaceAll('${DATASET}', datasetId);
  assert(!rendered.includes('${PROJECT}') && !rendered.includes('${DATASET}'), `${name} has unresolved placeholders`);
  return rendered;
}

async function submit(sql, label, dryRun = false) {
  const [job, apiResponse] = await getBigQueryClient().createQueryJob({
    query: sql,
    projectId: CONFIG.GCP_PROJECT_ID,
    useLegacySql: false,
    dryRun,
    maximumBytesBilled: String(maxBytesPerJob),
  });
  if (dryRun) {
    return { rows: [], metadata: apiResponse ?? job.metadata ?? {}, job };
  }
  const [rows] = await job.getQueryResults();
  const [metadata] = await job.getMetadata();
  const queryStats = metadata.statistics?.query ?? {};
  const billed = Number(queryStats.totalBytesBilled ?? 0);
  const entry = {
    label,
    job_id: job.id ?? metadata.jobReference?.jobId ?? null,
    statement_type: queryStats.statementType ?? null,
    bytes_processed: Number(queryStats.totalBytesProcessed ?? 0),
    bytes_billed: billed,
    maximum_bytes_billed: maxBytesPerJob,
  };
  report.jobs.push(entry);
  assert(billed <= maxBytesPerJob, `${label} billed ${billed} bytes above the per-job cap`);
  assert(report.jobs.reduce((sum, item) => sum + item.bytes_billed, 0) <= maxBytesTotal, 'Sandbox work exceeded the 50 GiB total cap');
  return { rows, metadata, job };
}

async function applyMigration(name, datasetId) {
  const sql = renderMigration(name, datasetId);
  let dryRun;
  try {
    const checked = await submit(sql, `${name}:dry-run`, true);
    dryRun = { supported: true, statement_type: checked.metadata.statistics?.query?.statementType ?? null };
    if (dryRun.statement_type === 'SCRIPT') throw new Error(`${name} dry-run returned SCRIPT, expected one statement`);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/dry.?run.{0,50}not supported|not supported.{0,50}dry.?run/i.test(message)) throw error;
    dryRun = { supported: false, error: message.slice(0, 500) };
  }

  const result = await submit(sql, name);
  const statementType = result.metadata.statistics?.query?.statementType ?? null;
  assert(statementType !== 'SCRIPT', `${name} submitted as SCRIPT, expected a single statement`);
  report.migrations.push({ name, dry_run: dryRun, executed_statement_type: statementType });
}

async function tableMetadata(datasetId, tableId) {
  const [metadata] = await getBigQueryClient().dataset(datasetId).table(tableId).getMetadata();
  return metadata;
}

async function scalar(sql) {
  const { rows } = await submit(sql, 'sandbox assertion');
  return rows[0];
}

try {
  handle = await sandbox.createSandbox({ purpose: 'schema-migration-validation', tableExpirationHours: 2 });
  report.sandbox_dataset = handle.datasetId;
  report.sandbox_label = handle.purposeLabel;
  assert(!sandbox.PROTECTED_DATASETS.includes(handle.datasetId), 'Sandbox guard returned a protected dataset');

  const dataset = `\`${CONFIG.GCP_PROJECT_ID}.${handle.datasetId}\``;
  const production = `\`${CONFIG.GCP_PROJECT_ID}.BlockchainEvents\``;

  const productionTransactions = await tableMetadata('BlockchainEvents', 'Transactions');
  assertSchemaMatches('Production Transactions', productionTransactions.schema?.fields ?? [], TRANSACTIONS_SCHEMA);
  const productionCoverage = await tableMetadata('BlockchainEvents', 'IngestionCoverage');
  const runtimeCoverageSchema = runtimeTableSchema('IngestionCoverage');
  assertSchemaMatches('Production IngestionCoverage', productionCoverage.schema?.fields ?? [], runtimeCoverageSchema);
  const runtimePipelineSchema = runtimeTableSchema('PipelineRuns');
  const runtimeReconciliationSchema = runtimeTableSchema('OracleReconciliation');

  await submit(`CREATE TABLE ${dataset}.PipelineRuns LIKE ${production}.PipelineRuns`, 'clone legacy PipelineRuns schema');
  await submit(`
    INSERT INTO ${dataset}.PipelineRuns
      (run_id, mode, started_at, completed_at, exit_code, total_rows_merged,
       contracts_processed, contracts_failed, host, error_message, chains_processed,
       captures_planned, captures_ok, captures_failed, pipeline_version)
    SELECT CONCAT('stage-a-', CAST(n AS STRING)), 'backfill',
      TIMESTAMP('2026-01-01 00:00:00+00'), TIMESTAMP('2026-01-01 00:01:00+00'),
      0, 0, 1, 0, 'sandbox-fixture', '', 'XDC', 1, 1, 0, 'fixture'
    FROM UNNEST(GENERATE_ARRAY(1, 22)) AS n`, 'seed PipelineRuns fixture rows');

  await submit(`CREATE TABLE ${dataset}.OracleReconciliation LIKE ${production}.OracleReconciliation`, 'clone legacy OracleReconciliation schema');
  await submit(`
    INSERT INTO ${dataset}.OracleReconciliation
      (run_id, network, table_id, protocol_day, oracle_block, oracle_count,
       oracle_amount_raw, warehouse_stored, warehouse_distinct, warehouse_amount_raw,
       count_gap, amount_gap_raw, verdict, checked_at)
    SELECT CONCAT('legacy-', CAST(n AS STRING)), 'XDC', 'legacy_fixture', n,
      1000 + n, 1, '1', 1, 1, '1', 0, '0', 'exact',
      TIMESTAMP('2026-01-01 00:00:00+00')
    FROM UNNEST(GENERATE_ARRAY(1, 265)) AS n`, 'seed OracleReconciliation legacy rows');

  await submit(`CREATE TABLE ${dataset}.Transactions LIKE ${production}.Transactions`, 'clone Transactions schema only');
  report.prepared_migrations = [
    { name: '09_CreateRawLogs_v1.sql', change: 'create RawLogs if absent' },
    { name: '08_PipelineRunsOutcome_v1.sql', change: 'add 26 nullable PipelineRuns columns' },
    { name: '10_AddOracleReconciliationCompatibility_v1.sql', change: 'add nullable chain_id and contract_address' },
    { name: '11_CreateRawLogsAllHistory_v1.sql', change: 'create RawLogsAllHistory if absent' },
    { name: '12_CreateTransactionsAllHistory_v1.sql', change: 'create TransactionsAllHistory if absent' },
  ];

  await applyMigration('09_CreateRawLogs_v1.sql', handle.datasetId);
  await applyMigration('09_CreateRawLogs_v1.sql', handle.datasetId);
  const rawLogs = await tableMetadata(handle.datasetId, 'RawLogs');
  assertSchemaMatches('RawLogs', rawLogs.schema?.fields ?? [], RAW_LOGS_SCHEMA);
  assert(rawLogs.timePartitioning?.type === 'MONTH', 'RawLogs is not monthly partitioned');
  assert(rawLogs.requirePartitionFilter === true, 'RawLogs is missing require_partition_filter');

  await applyMigration('08_PipelineRunsOutcome_v1.sql', handle.datasetId);
  await applyMigration('08_PipelineRunsOutcome_v1.sql', handle.datasetId);
  const pipelineRuns = await tableMetadata(handle.datasetId, 'PipelineRuns');
  assertSchemaMatches('PipelineRuns', pipelineRuns.schema?.fields ?? [], runtimePipelineSchema);
  const pipelinePreservation = await scalar(`
    SELECT COUNT(*) AS rows_preserved,
      COUNTIF(run_id IS NOT NULL) AS fixture_rows,
      COUNTIF(release_sha IS NULL) AS old_rows_without_release_sha
    FROM ${dataset}.PipelineRuns`);
  assert(Number(pipelinePreservation.rows_preserved) === 22, 'PipelineRuns row count changed');
  assert(Number(pipelinePreservation.fixture_rows) === 22, 'PipelineRuns fixture rows changed');

  await applyMigration('10_AddOracleReconciliationCompatibility_v1.sql', handle.datasetId);
  await applyMigration('10_AddOracleReconciliationCompatibility_v1.sql', handle.datasetId);
  const reconciliation = await tableMetadata(handle.datasetId, 'OracleReconciliation');
  const reconciliationFields = new Set((reconciliation.schema?.fields ?? []).map((field) => field.name));
  const reconciliationByName = new Map((reconciliation.schema?.fields ?? []).map((field) => [field.name, field]));
  for (const field of runtimeReconciliationSchema) {
    const actual = reconciliationByName.get(field.name);
    assert(actual && actual.type === field.type && (actual.mode ?? 'NULLABLE') === field.mode,
      `OracleReconciliation runtime field ${field.name} differs from its schema contract`);
  }
  assert(reconciliationFields.has('table_id'), 'OracleReconciliation legacy table_id was removed');
  const reconciliationPreservation = await scalar(`
    SELECT COUNT(*) AS rows_preserved,
      COUNTIF(table_id = 'legacy_fixture') AS legacy_rows,
      COUNTIF(chain_id IS NULL AND contract_address IS NULL) AS uninferred_rows
    FROM ${dataset}.OracleReconciliation`);
  assert(Number(reconciliationPreservation.rows_preserved) === 265, 'OracleReconciliation row count changed');
  assert(Number(reconciliationPreservation.legacy_rows) === 265, 'OracleReconciliation table_id history changed');
  assert(Number(reconciliationPreservation.uninferred_rows) === 265, 'Legacy reconciliation dimensions were inferred');

  const transactions = await tableMetadata(handle.datasetId, 'Transactions');
  assertSchemaMatches('Transactions', transactions.schema?.fields ?? [], TRANSACTIONS_SCHEMA);
  assert(Number(transactions.numRows ?? 0) === 0, 'Transactions schema-only clone unexpectedly contains rows');

  await applyMigration('11_CreateRawLogsAllHistory_v1.sql', handle.datasetId);
  await applyMigration('11_CreateRawLogsAllHistory_v1.sql', handle.datasetId);
  await applyMigration('12_CreateTransactionsAllHistory_v1.sql', handle.datasetId);
  await applyMigration('12_CreateTransactionsAllHistory_v1.sql', handle.datasetId);
  for (const viewId of ['RawLogsAllHistory', 'TransactionsAllHistory']) {
    const view = await tableMetadata(handle.datasetId, viewId);
    assert(view.type === 'VIEW', `${viewId} is not a view`);
    assert(view.view?.query?.includes('block_timestamp'), `${viewId} is missing its partition-bounded definition`);
  }

  report.row_preservation = { PipelineRuns: pipelinePreservation, OracleReconciliation: reconciliationPreservation };
  report.schema_checks = {
    RawLogs: { fields: rawLogs.schema?.fields?.length, matches_runtime_contract: true, partition: rawLogs.timePartitioning, require_partition_filter: rawLogs.requirePartitionFilter },
    Transactions: { fields: transactions.schema?.fields?.length, rows: Number(transactions.numRows ?? 0), matches_runtime_contract: true },
    PipelineRuns: { fields: pipelineRuns.schema?.fields?.length, matches_runtime_contract: true },
    IngestionCoverage: { fields: productionCoverage.schema?.fields?.length, matches_runtime_contract: true },
    OracleReconciliation: { fields: reconciliation.schema?.fields?.length, matches_runtime_fields: true, legacy_table_id_retained: reconciliationFields.has('table_id') },
    views: ['RawLogsAllHistory', 'TransactionsAllHistory'],
  };
} catch (error) {
  report.errors.push(String(error?.message ?? error));
} finally {
  if (handle) {
    try {
      cleanup = await sandbox.dropSandbox(handle);
      report.cleanup = cleanup;
    } catch (error) {
      report.cleanup = { provenAbsent: false, error: String(error?.message ?? error) };
      report.errors.push(`Sandbox cleanup failed: ${report.cleanup.error}`);
    }
  }
}

report.bytes_billed_total = report.jobs.reduce((sum, item) => sum + item.bytes_billed, 0);
report.finished_at_utc = new Date().toISOString();
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`sandbox dataset : ${report.sandbox_dataset ?? 'not created'}`);
console.log(`jobs            : ${report.jobs.length}`);
console.log(`bytes billed    : ${report.bytes_billed_total}`);
console.log(`cleanup proven  : ${report.cleanup?.provenAbsent === true}`);
console.log(`report          : ${outputPath}`);
for (const error of report.errors) console.error(`validation error: ${error}`);

if (report.errors.length || report.cleanup?.provenAbsent !== true) process.exit(1);