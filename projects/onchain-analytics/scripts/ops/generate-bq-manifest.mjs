#!/usr/bin/env node
// Generates a deterministic state manifest for one or more BigQuery datasets.
//
// The manifest is the reference an operator diffs against to answer one question in a single
// command: Has anything in the warehouse changed that nobody intended to change? It records
// structure, storage and governance metadata for every table, materialized view and view.
//
// It is metadata only. No query job is submitted, no table data is read and no byte is billed.
//
// Usage:
//   node generate-bq-manifest.mjs --project gooddollar --dataset BlockchainEvents --out manifest.json
//   node generate-bq-manifest.mjs --project gooddollar --all-datasets --out manifest.json
//
// Exit codes: 0 when every requested dataset was read with zero errors, 1 otherwise. A nonzero
// exit means the manifest is incomplete and must not be used as a baseline.

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { get, listDatasetsUrl, datasetUrl, listTablesUrl, tableUrl } from './bq-metadata-client.mjs';

const MANIFEST_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const args = { project: null, datasets: [], allDatasets: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--project') args.project = argv[++i];
    else if (flag === '--dataset') args.datasets.push(argv[++i]);
    else if (flag === '--all-datasets') args.allDatasets = true;
    else if (flag === '--out') args.out = argv[++i];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.project) throw new Error('--project is required');
  if (!args.out) throw new Error('--out is required');
  if (!args.allDatasets && args.datasets.length === 0) {
    throw new Error('Pass at least one --dataset, or --all-datasets');
  }
  return args;
}

/** Canonical JSON: object keys sorted recursively, so a hash depends on content and not on order. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function epochMsToIso(ms) {
  if (ms === undefined || ms === null) return null;
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

/** Flattens a BigQuery schema to a stable, comparable field list including nested records. */
function flattenSchema(fields, prefix = '') {
  const out = [];
  for (const f of fields ?? []) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    out.push({
      path,
      type: f.type ?? null,
      mode: f.mode ?? 'NULLABLE',
      has_description: Boolean(f.description),
      description_sha256: f.description ? sha256(f.description) : null,
      precision: f.precision ?? null,
      scale: f.scale ?? null,
      max_length: f.maxLength ?? null,
    });
    if (f.fields) out.push(...flattenSchema(f.fields, path));
  }
  return out;
}

function summariseTable(meta) {
  const fields = flattenSchema(meta.schema?.fields);
  return {
    table_id: meta.tableReference?.tableId ?? null,
    type: meta.type ?? null,
    creation_time_utc: epochMsToIso(meta.creationTime),
    last_modified_time_utc: epochMsToIso(meta.lastModifiedTime),
    expiration_time_utc: epochMsToIso(meta.expirationTime),
    has_expiration: Boolean(meta.expirationTime),
    num_rows: meta.numRows !== undefined ? Number(meta.numRows) : null,
    num_bytes: meta.numBytes !== undefined ? Number(meta.numBytes) : null,
    num_long_term_bytes: meta.numLongTermBytes !== undefined ? Number(meta.numLongTermBytes) : null,
    num_active_logical_bytes: meta.numActiveLogicalBytes !== undefined ? Number(meta.numActiveLogicalBytes) : null,
    num_total_partitions: meta.numPartitions !== undefined ? Number(meta.numPartitions) : null,
    location: meta.location ?? null,
    partitioning: meta.timePartitioning
      ? {
          kind: 'time',
          type: meta.timePartitioning.type ?? null,
          field: meta.timePartitioning.field ?? null,
          expiration_ms: meta.timePartitioning.expirationMs !== undefined
            ? Number(meta.timePartitioning.expirationMs) : null,
          require_partition_filter: meta.timePartitioning.requirePartitionFilter ?? null,
        }
      : meta.rangePartitioning
        ? { kind: 'range', field: meta.rangePartitioning.field ?? null, range: meta.rangePartitioning.range ?? null }
        : { kind: 'none' },
    require_partition_filter: meta.requirePartitionFilter ?? null,
    clustering_fields: meta.clustering?.fields ?? null,
    labels: meta.labels ?? null,
    column_count: fields.length,
    schema_sha256: sha256(fields),
    schema_fields: fields,
    description_sha256: meta.description ? sha256(meta.description) : null,
    has_description: Boolean(meta.description),
    view_definition_sha256: meta.view?.query ? sha256(meta.view.query) : null,
    materialized_view_definition_sha256: meta.materializedView?.query ? sha256(meta.materializedView.query) : null,
    materialized_view_enable_refresh: meta.materializedView?.enableRefresh ?? null,
    materialized_view_refresh_interval_ms: meta.materializedView?.refreshIntervalMs !== undefined
      ? Number(meta.materializedView.refreshIntervalMs) : null,
    default_collation: meta.defaultCollation ?? null,
    encryption_kms_key: meta.encryptionConfiguration?.kmsKeyName ?? null,
    streaming_buffer_present: Boolean(meta.streamingBuffer),
  };
}

function summariseDataset(meta) {
  return {
    dataset_id: meta.datasetReference?.datasetId ?? null,
    location: meta.location ?? null,
    creation_time_utc: epochMsToIso(meta.creationTime),
    last_modified_time_utc: epochMsToIso(meta.lastModifiedTime),
    default_table_expiration_ms: meta.defaultTableExpirationMs !== undefined && meta.defaultTableExpirationMs !== null
      ? Number(meta.defaultTableExpirationMs) : null,
    default_partition_expiration_ms: meta.defaultPartitionExpirationMs !== undefined && meta.defaultPartitionExpirationMs !== null
      ? Number(meta.defaultPartitionExpirationMs) : null,
    labels: meta.labels ?? null,
    description_sha256: meta.description ? sha256(meta.description) : null,
    storage_billing_model: meta.storageBillingModel ?? null,
    max_time_travel_hours: meta.maxTimeTravelHours !== undefined ? Number(meta.maxTimeTravelHours) : null,
    access_entries: (meta.access ?? [])
      .map((a) => ({
        role: a.role ?? null,
        user_by_email: a.userByEmail ?? null,
        group_by_email: a.groupByEmail ?? null,
        special_group: a.specialGroup ?? null,
        iam_member: a.iamMember ?? null,
        view: a.view ? `${a.view.projectId}.${a.view.datasetId}.${a.view.tableId}` : null,
        routine: a.routine ? `${a.routine.projectId}.${a.routine.datasetId}.${a.routine.routineId}` : null,
        dataset: a.dataset ? `${a.dataset.dataset?.datasetId}` : null,
      }))
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
  };
}

async function listTableIds(project, dataset, errors) {
  const ids = [];
  let pageToken;
  do {
    const res = await get(listTablesUrl(project, dataset, pageToken));
    if (!res.ok) {
      errors.push({ where: `tables.list ${dataset}`, status: res.status, message: res.errorMessage });
      return ids;
    }
    for (const t of res.json?.tables ?? []) {
      const id = t.tableReference?.tableId;
      if (id) ids.push(id);
    }
    pageToken = res.json?.nextPageToken;
  } while (pageToken);
  return ids.sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];

  let datasetIds = args.datasets;
  if (args.allDatasets) {
    const res = await get(listDatasetsUrl(args.project));
    if (!res.ok) {
      errors.push({ where: 'datasets.list', status: res.status, message: res.errorMessage });
    } else {
      datasetIds = (res.json?.datasets ?? [])
        .map((d) => d.datasetReference?.datasetId)
        .filter(Boolean)
        .sort();
    }
  }

  const datasets = {};
  for (const datasetId of datasetIds) {
    const dsRes = await get(datasetUrl(args.project, datasetId));
    if (!dsRes.ok) {
      errors.push({ where: `datasets.get ${datasetId}`, status: dsRes.status, message: dsRes.errorMessage });
      continue;
    }
    const tableIds = await listTableIds(args.project, datasetId, errors);
    const tables = {};
    for (const tableId of tableIds) {
      const tRes = await get(tableUrl(args.project, datasetId, tableId));
      if (!tRes.ok) {
        errors.push({ where: `tables.get ${datasetId}.${tableId}`, status: tRes.status, message: tRes.errorMessage });
        continue;
      }
      tables[tableId] = summariseTable(tRes.json);
    }
    datasets[datasetId] = {
      ...summariseDataset(dsRes.json),
      table_count: Object.keys(tables).length,
      table_ids_listed: tableIds.length,
      tables,
    };
  }

  // The payload is what a diff compares. Everything volatile about this particular run stays
  // outside it, so re-running the generator against an unchanged warehouse produces no diff.
  const payload = {
    manifest_schema_version: MANIFEST_SCHEMA_VERSION,
    project: args.project,
    datasets,
  };

  const manifest = {
    generated_at_utc: new Date().toISOString(),
    generator: 'scripts/ops/generate-bq-manifest.mjs',
    access_mode: 'metadata read only, no query job submitted',
    requested_datasets: args.allDatasets ? 'all' : args.datasets,
    error_count: errors.length,
    errors,
    payload_sha256: sha256(payload),
    payload,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);

  const tableTotal = Object.values(datasets).reduce((n, d) => n + d.table_count, 0);
  console.log(`project        : ${args.project}`);
  console.log(`datasets       : ${Object.keys(datasets).length}`);
  console.log(`tables         : ${tableTotal}`);
  console.log(`payload sha256 : ${manifest.payload_sha256}`);
  console.log(`error count    : ${errors.length}`);
  for (const e of errors) console.log(`  error ${e.where}: ${e.status} ${e.message}`);
  console.log(`written        : ${args.out}`);

  process.exit(errors.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
