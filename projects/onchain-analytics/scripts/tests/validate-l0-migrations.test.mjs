import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const validator = readFileSync(new URL('../ops/validate-l0-migrations.mjs', import.meta.url), 'utf8');
const parserSource = validator.match(/(function runtimeTableSchema\(tableId\) \{[\s\S]*?\r?\n\})\r?\n\r?\nfunction renderMigration/);
assert.ok(parserSource, 'The runtime schema parser must be found without executing the live validator');

function parseColumns(columns) {
  const runtimeSource = [
    'CREATE TABLE IF NOT EXISTS ${fullTableName("Fixture")} (',
    ...columns.map((column) => `      ${column}`),
    '    )',
  ].join('\n');
  const fields = runInNewContext(`${parserSource[1]}; runtimeTableSchema("Fixture")`, {
    runtimeSource,
    assert: (condition, message) => assert.ok(condition, message),
  });
  return JSON.parse(JSON.stringify(fields));
}

test('retains required columns from the runtime schema', () => {
  assert.deepEqual(parseColumns(['run_id STRING NOT NULL,']), [
    { name: 'run_id', type: 'STRING', mode: 'REQUIRED' },
  ]);
});

test('keeps optional columns nullable', () => {
  assert.deepEqual(parseColumns(['chain_id INT64,']), [
    { name: 'chain_id', type: 'INTEGER', mode: 'NULLABLE' },
  ]);
});

test('handles required and optional fields together, including case-insensitive declarations', () => {
  assert.deepEqual(parseColumns(['started_at TIMESTAMP not null,', 'finished_at TIMESTAMP,']), [
    { name: 'started_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    { name: 'finished_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
  ]);
});

const preservationChecks = validator.match(/  assert\(Number\(pipelinePreservation\.rows_preserved\)[\s\S]*?(?=\r?\n\r?\n  await applyMigration)/);
assert.ok(preservationChecks, 'The live historical-row assertions must be found without executing migrations');

function checkHistoricalRows(unknownHashes) {
  runInNewContext(preservationChecks[0], {
    pipelinePreservation: {
      rows_preserved: '22',
      fixture_rows: '22',
      old_rows_without_release_sha: String(unknownHashes),
    },
    assert: (condition, message) => assert.ok(condition, message),
  });
}

test('accepts preserved historical rows with all release hashes unknown', () => {
  assert.doesNotThrow(() => checkHistoricalRows(22));
});

test('rejects a release hash populated on even one historical row', () => {
  assert.throws(() => checkHistoricalRows(21), /historical release_sha values changed/);
});

test('rejects populated release hashes even when all historical rows remain', () => {
  assert.throws(() => checkHistoricalRows(0), /historical release_sha values changed/);
});