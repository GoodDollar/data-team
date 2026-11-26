import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

const P2P_COLUMNS = ['date', 'daily_price_usd', 'total_tx_count', 'total_amount_gd', 'total_amount_usd', 'tx_count_7d', 'amount_gd_7d',
  'amount_usd_7d', 'tx_count_30d', 'amount_gd_30d', 'amount_usd_30d', 'unique_senders', 'unique_receivers', 'unique_users'];
const UBI_COLUMNS = ['Date', 'all_gd', 'all_usd', 'gd_30d', 'usd_30d', 'per_user_30d', 'gd_7d', 'usd_7d', 'per_user_7d', 'gd_1d', 'usd_1d', 'per_user_1d'];
const toRow = (columns, values) => Object.fromEntries(columns.map((c, i) => [c, values[i] ?? null]));

const D = '2026-11-19';
const NO_ROW = '2026-11-18'; // in the Dune results, not in the sheet

function harness({ facts, gd = 2277975.5, usd = 261.9, formulas = {}, onFlush } = {}) {
  const sheets = {};
  function makeSheet(name, rows) {
    const data = rows;
    const sheet = {
      name,
      data,
      getLastRow: () => data.length,
      getRange(row, column, height = 1, width = 1) {
        return {
          getValues: () => data.slice(row - 1, row - 1 + height).map(r => { const out = []; for (let c = 0; c < width; c++) out.push(r[column - 1 + c] ?? ''); return out; }),
          getFormulas: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, c) => (name === 'Daily Facts' && formulas[row + i]?.[column + c]) || '')),
          setValues(values) {
            values.forEach((v, i) => { const r = data[row - 1 + i] || (data[row - 1 + i] = []); v.forEach((x, c) => { r[column - 1 + c] = x; }); });
          },
          setNumberFormat() {},
        };
      },
      setName(n) { delete sheets[sheet.name]; sheet.name = n; sheets[n] = sheet; return sheet; },
    };
    sheets[name] = sheet;
    return sheet;
  }
  makeSheet('Daily Facts', [['Date', 'Chain', 'Metric Key', 'Value', 'Source', 'Updated at'], ...facts.map(r => [...r])]);
  const ss = {
    getName: () => 'test copy',
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => makeSheet(n, []),
    getSheets: () => Object.values(sheets).map(s => ({ getName: () => s.name })),
    getSpreadsheetTimeZone: () => 'America/Sao_Paulo',
  };
  const tables = {
    5521377: [P2P_COLUMNS, [
      [NO_ROW, 0.0001, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [`${D} 00:00:00.000 UTC`, 0.0001, 143, gd, usd, 4477, 10190000, 1170.25, 17128, 75270000, 8596.32, 136, 56, 188],
    ]],
    5710738: [UBI_COLUMNS, [[D, 1, 1, 1, 1, 3637.434, 1, 1, 866.214, 1, 1, 120.796]]],
  };
  const context = {
    SpreadsheetApp: { openById: () => ss, flush: () => onFlush && onFlush(sheets) },
    Logger: { log() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'key' }) },
    Utilities: { formatDate: d => d.toISOString().replace('T', ' ').slice(0, 19) },
    UrlFetchApp: {
      fetch(url) {
        const id = url.match(/query\/(\d+)\/results/)[1];
        const [columns, rows] = tables[id];
        const body = { result: { rows: rows.map(r => toRow(columns, r)), metadata: { column_names: columns } } };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source('v6-daily.gs'), context);
  vm.runInContext(source('v6-dev.gs'), context);
  return { context, sheets, facts: () => sheets['Daily Facts'].data.slice(1) };
}

const OLD_AT = '2026-11-20 02:28:00';
function baseFacts() {
  return [
    [D, 'CELO', 'celo_p2p_gd_amount', 25547692.41, 'DUNE', OLD_AT],
    [D, 'XDC', 'xdc_p2p_gd_amount', 362183.31, 'XDC_SUBGRAPH', OLD_AT],
    [D, 'AGG', 'agg_p2p_gd_amount', 25909875.72, 'AGG', OLD_AT],
    [D, 'CELO', 'celo_p2p_tx_count', '143', 'DUNE', OLD_AT],
    [D, 'CELO', 'celo_gd_per_user_30d', 1722.99, 'DUNE', OLD_AT],
    [D, 'CELO', 'celo_gd_per_user_1d', 120.8, 'DUNE', OLD_AT],
    [D, 'CELO', 'celo_p2p_lifetime_gd_amount', 6893486986.17, 'DUNE', OLD_AT],
    [D, 'CELO', 'celo_dau', 11562, 'DUNE', OLD_AT],
  ];
}
const valueOf = (rows, date, chain, key) => rows.find(r => r[0] === date && r[1] === chain && r[2] === key)?.[3];

test('preview reports the changes and writes nothing', () => {
  const h = harness({ facts: baseFacts() });
  const before = JSON.stringify(h.facts());
  const summary = h.context.celoDuneCorrectionPreview();
  assert.equal(JSON.stringify(h.facts()), before);
  assert.equal(Object.keys(h.sheets).length, 1);
  assert.equal(summary.write, false);
  assert.equal(summary.spreadsheet, 'test copy');
  assert.equal(summary.updated, 3); // Celo volume, AGG volume, per user 30d
  assert.equal(summary.perKey.celo_p2p_tx_count.unchanged, 1);
});

test('rewrites changed Celo rows and their AGG row, adds nothing, and a second run changes nothing', () => {
  const h = harness({ facts: baseFacts() });
  const summary = h.context.celoDuneCorrection();
  const rows = h.facts();
  assert.equal(rows.length, baseFacts().length);
  assert.equal(valueOf(rows, D, 'CELO', 'celo_p2p_gd_amount'), 2277975.5);
  assert.equal(valueOf(rows, D, 'AGG', 'agg_p2p_gd_amount'), 2640158.81); // new Celo + stored XDC
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_p2p_gd_amount'), 362183.31);
  assert.equal(valueOf(rows, D, 'CELO', 'celo_gd_per_user_30d'), 3637.43);
  assert.equal(valueOf(rows, D, 'CELO', 'celo_gd_per_user_1d'), 120.8);
  assert.equal(valueOf(rows, D, 'CELO', 'celo_p2p_lifetime_gd_amount'), 6893486986.17); // other query: untouched
  assert.equal(valueOf(rows, D, 'CELO', 'celo_dau'), 11562);
  assert.equal(rows.find(r => r[2] === 'celo_dau')[5], OLD_AT);

  const log = h.sheets[summary.logSheet].data;
  assert.equal(log.length - 1, summary.updated);
  const entry = log.find(r => r[2] === 'celo_p2p_gd_amount');
  assert.deepEqual(entry.slice(3, 7), ['updated', 25547692.41, 2277975.5, OLD_AT]);

  const again = h.context.celoDuneCorrection();
  assert.equal(again.updated, 0);
  assert.equal(again.logSheet, null);
});

test('restore puts every old value back', () => {
  const h = harness({ facts: baseFacts() });
  const before = h.facts().map(r => [...r]);
  const summary = h.context.celoDuneCorrection();
  const restored = h.context.celoDuneCorrectionRestoreLatest();
  assert.equal(restored.notFound, 0);
  assert.deepEqual(h.facts(), before);
  assert.ok(h.sheets[summary.logSheet + ' (restored)']);
  assert.throws(() => h.context.celoDuneCorrectionRestoreLatest(), /No "Celo Dune corrections/);
});

test('keeps a stored USD amount when the query has no price for the day', () => {
  const h = harness({ facts: [...baseFacts(), [D, 'CELO', 'celo_p2p_usd_amount', 2900.5, 'DUNE', OLD_AT], [D, 'AGG', 'agg_p2p_usd_amount', 2941.5, 'AGG', OLD_AT]], usd: 0 });
  h.context.celoDuneCorrection();
  assert.equal(valueOf(h.facts(), D, 'CELO', 'celo_p2p_usd_amount'), 2900.5);
  assert.equal(valueOf(h.facts(), D, 'AGG', 'agg_p2p_usd_amount'), 2941.5);
});

test('refuses old transfer results', () => {
  const h = harness({ facts: baseFacts(), gd: 25547692.41 });
  const before = JSON.stringify(h.facts());
  assert.throws(() => h.context.celoDuneCorrection(), /still returns the old results/);
  assert.equal(JSON.stringify(h.facts()), before);
});

test('stops without touching Daily Facts if a row is appended while it runs', () => {
  const h = harness({ facts: baseFacts(), onFlush: sheets => sheets['Daily Facts'].data.push([D, 'CELO', 'celo_wau', 1, 'DUNE', 'x']) });
  const before = JSON.stringify(h.facts());
  assert.throws(() => h.context.celoDuneCorrection(), /Daily Facts changed during the run/);
  assert.equal(JSON.stringify(h.facts().slice(0, -1)), before);
});

test('a row that needs a change but holds a formula stops the run before any write', () => {
  const h = harness({ facts: baseFacts(), formulas: { 2: { 4: '=25547692.41' } } });
  const before = JSON.stringify(h.facts());
  assert.throws(() => h.context.celoDuneCorrection(), /holds a formula/);
  assert.equal(JSON.stringify(h.facts()), before);
  assert.equal(Object.keys(h.sheets).length, 1);
});
