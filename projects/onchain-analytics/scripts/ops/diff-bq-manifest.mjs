#!/usr/bin/env node
// Compares two BigQuery state manifests produced by generate-bq-manifest.mjs.
//
// Answers one question: What changed in the warehouse between these two readings? It reports
// added, removed and altered datasets and tables, and for an altered table it names the exact
// fields that moved rather than printing two large objects side by side.
//
// Usage:
//   node diff-bq-manifest.mjs --baseline before.json --current after.json
//   node diff-bq-manifest.mjs --baseline before.json --current after.json --out diff.json
//
// Exit codes: 0 when the two payloads are identical, 2 when they differ, 1 on a usage or read
// error. A nonzero exit from a scheduled comparison means someone or something changed the
// warehouse outside the intended path.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function parseArgs(argv) {
  const args = { baseline: null, current: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--baseline') args.baseline = argv[++i];
    else if (flag === '--current') args.current = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.baseline || !args.current) throw new Error('--baseline and --current are both required');
  return args;
}

function load(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed.payload) throw new Error(`${path} has no payload. It was not produced by generate-bq-manifest.mjs.`);
  return parsed;
}

/** Field-level comparison of two flat-ish objects, ignoring the nested tables map. */
function compareFields(before, after, skip = []) {
  const changes = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (skip.includes(key)) continue;
    const b = JSON.stringify(before?.[key] ?? null);
    const a = JSON.stringify(after?.[key] ?? null);
    if (b !== a) changes.push({ field: key, baseline: JSON.parse(b), current: JSON.parse(a) });
  }
  return changes;
}

function diffTables(baselineTables, currentTables) {
  const added = [];
  const removed = [];
  const changed = [];
  const ids = new Set([...Object.keys(baselineTables ?? {}), ...Object.keys(currentTables ?? {})]);
  for (const id of [...ids].sort()) {
    const b = baselineTables?.[id];
    const a = currentTables?.[id];
    if (!b) { added.push(id); continue; }
    if (!a) { removed.push(id); continue; }
    // schema_fields is already summarised by schema_sha256; comparing it twice only adds noise.
    const fieldChanges = compareFields(b, a, ['schema_fields']);
    if (fieldChanges.length > 0) changed.push({ table_id: id, changes: fieldChanges });
  }
  return { added, removed, changed };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = load(args.baseline);
  const current = load(args.current);

  const identical = baseline.payload_sha256 === current.payload_sha256;

  const datasetIds = new Set([
    ...Object.keys(baseline.payload.datasets ?? {}),
    ...Object.keys(current.payload.datasets ?? {}),
  ]);

  const datasetsAdded = [];
  const datasetsRemoved = [];
  const datasetChanges = [];

  for (const id of [...datasetIds].sort()) {
    const b = baseline.payload.datasets?.[id];
    const a = current.payload.datasets?.[id];
    if (!b) { datasetsAdded.push(id); continue; }
    if (!a) { datasetsRemoved.push(id); continue; }
    const propertyChanges = compareFields(b, a, ['tables']);
    const tableDiff = diffTables(b.tables, a.tables);
    const anything = propertyChanges.length > 0
      || tableDiff.added.length > 0 || tableDiff.removed.length > 0 || tableDiff.changed.length > 0;
    if (anything) {
      datasetChanges.push({ dataset_id: id, property_changes: propertyChanges, tables: tableDiff });
    }
  }

  const report = {
    compared_at_utc: new Date().toISOString(),
    baseline: {
      path: args.baseline,
      generated_at_utc: baseline.generated_at_utc,
      payload_sha256: baseline.payload_sha256,
      error_count: baseline.error_count,
    },
    current: {
      path: args.current,
      generated_at_utc: current.generated_at_utc,
      payload_sha256: current.payload_sha256,
      error_count: current.error_count,
    },
    identical,
    datasets_added: datasetsAdded,
    datasets_removed: datasetsRemoved,
    dataset_changes: datasetChanges,
  };

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(`baseline sha256 : ${baseline.payload_sha256}`);
  console.log(`current  sha256 : ${current.payload_sha256}`);
  console.log(`identical       : ${identical}`);
  console.log(`datasets added  : ${datasetsAdded.length}`);
  console.log(`datasets removed: ${datasetsRemoved.length}`);
  console.log(`datasets changed: ${datasetChanges.length}`);
  for (const d of datasetChanges) {
    console.log(`  ${d.dataset_id}: ${d.property_changes.length} property changes, `
      + `${d.tables.added.length} tables added, ${d.tables.removed.length} removed, ${d.tables.changed.length} altered`);
    for (const t of d.tables.changed) {
      console.log(`    ${t.table_id}: ${t.changes.map((c) => c.field).join(', ')}`);
    }
  }
  if (args.out) console.log(`written         : ${args.out}`);

  // A baseline or current reading that itself had errors is incomplete, so a clean comparison
  // between two incomplete readings must not be reported as proof that nothing changed.
  if (baseline.error_count > 0 || current.error_count > 0) {
    console.log('WARNING: at least one manifest was generated with errors and is incomplete.');
  }

  process.exit(identical ? 0 : 2);
}

try {
  main();
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
