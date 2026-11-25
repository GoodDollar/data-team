import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (date, n) => ymd(new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000));
const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const dayNum = date => Date.parse(date + 'T00:00:00Z') / 86400000;
const WEI = 10n ** 18n;

// Subgraph: one first-time claimer and 10 G$ claimed per day, from 2025-11-02 to yesterday.
function subgraphDays() {
  const days = [];
  for (let d = '2025-11-02'; d <= yesterday; d = addDays(d, 1)) days.push({ id: String(dayNum(d)), newClaimers: '1', totalUBIDistributed: String(10n * WEI) });
  return days;
}

function harness({ facts, headTimestamp, onFlush, formulas = {} } = {}) {
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
          // formulas: { sheetRowNumber: { 4: '=...' } } (column number -> formula)
          getFormulas: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, c) => (name === 'Daily Facts' && formulas[row + i]?.[column + c]) || '')),
          setValues(values) {
            values.forEach((v, i) => { const r = data[row - 1 + i] || (data[row - 1 + i] = []); v.forEach((x, c) => { r[column - 1 + c] = x; }); });
          },
          setNumberFormat() {},
        };
      },
      getRangeList: () => ({ setNumberFormat() {} }),
      deleteRows(start, count) { data.splice(start - 1, count); },
      setName(n) { delete sheets[sheet.name]; sheet.name = n; sheets[n] = sheet; return sheet; },
    };
    sheets[name] = sheet;
    return sheet;
  }
  makeSheet('Daily Facts', [['Date', 'Chain', 'Metric Key', 'Value', 'Source', 'Updated at'], ...facts.map(r => [...r])]);
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => makeSheet(n, []), getSheets: () => Object.values(sheets).map(s => ({ getName: () => s.name })), getSpreadsheetTimeZone: () => 'America/Sao_Paulo' };
  const days = subgraphDays();
  const head = headTimestamp ?? Math.floor(Date.now() / 1000);
  const context = {
    SpreadsheetApp: { openById: () => ss, flush: () => onFlush && onFlush(sheets) },
    Logger: { log() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { formatDate: (d, tz, fmt) => d.toISOString().replace('T', ' ').slice(0, 19) },
    UrlFetchApp: {
      fetch(url, options) {
        assert.match(url, /gd_xdc\/1\.4\/gn$/);
        const q = JSON.parse(options.payload).query;
        let body;
        if (q.includes('_meta')) body = { data: { _meta: { block: { number: 1000, timestamp: head }, hasIndexingErrors: false } } };
        else {
          assert.match(q, /block: \{ number: 1000 \}/);
          const after = q.match(/id_gt: "(\d*)"/)[1];
          body = { data: { dailyUBIs: days.filter(d => d.id > after).slice(0, 1000) } };
        }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source('v6-daily.gs'), context);
  vm.runInContext(source('v6-dev.gs'), context);
  return { context, sheets, facts: () => sheets['Daily Facts'].data.slice(1) };
}

const D = addDays(yesterday, -5);           // inside the 90-day USD window
const OLD = addDays(yesterday, -200);       // outside it
const lifetimeAt = date => dayNum(date) - dayNum('2025-11-02') + 1;
function baseFacts() {
  return [
    [D, 'XDC', 'xdc_lifetime_unique_claimers', 139000, 'XDC_SUBGRAPH', '2026-11-20 02:28:00'],
    [D, 'XDC', 'xdc_new_claimers', 900, 'XDC_SUBGRAPH', '2026-11-20 02:28:00'],
    [D, 'XDC', 'xdc_dau', 50, 'XDC_SUBGRAPH', '2026-11-20 02:28:00'],
    [D, 'XDC', 'xdc_returning_claimers', 0, 'COMPUTED', '2026-11-20 02:28:00'],
    [D, 'XDC', 'xdc_gd_claimed_1d', 7, 'XDC_SUBGRAPH', '2026-11-20 02:28:00'],
    [D, 'XDC', 'xdc_gd_claimed_7d', 70, 'XDC_SUBGRAPH', '2026-11-20 02:28:00'],
    [D, 'CELO', 'celo_gd_claimed_1d', 100, 'DUNE', '2026-11-20 02:28:00'],
    [D, 'AGG', 'agg_gd_claimed_1d', 107, 'AGG', '2026-11-20 02:28:00'],
    [D, 'XDC', 'xdc_gd_price', 0.5, 'XDC_RESERVE', '2026-11-20 02:28:00'],
    [D, 'CELO', 'celo_usd_claimed_1d', 40, 'DUNE', '2026-11-20 02:28:00'],
    [D, 'AGG', 'agg_usd_claimed_1d', 40, 'AGG', '2026-11-20 02:28:00'],
    [D, 'XDC', 'xdc_p2p_gd_amount', 1000, 'XDC_SUBGRAPH', '2026-11-20 02:28:00'],
    [OLD, 'XDC', 'xdc_gd_claimed_1d', 10, 'XDC_SUBGRAPH', '2026-05-01 02:28:00'],
    [OLD, 'XDC', 'xdc_usd_claimed_1d', 1.23, 'COMPUTED', '2026-05-01 02:28:00'],
    [D, 'CELO', 'celo_dau', 12345, 'DUNE', '2026-11-20 02:28:00'],
  ];
}
const valueOf = (rows, date, chain, key) => rows.find(r => r[0] === date && r[1] === chain && r[2] === key)?.[3];

test('preview computes the corrections and writes nothing', () => {
  const h = harness({ facts: baseFacts() });
  const before = JSON.stringify(h.facts());
  const summary = h.context.xdcSubgraphCorrectionPreview();
  assert.equal(JSON.stringify(h.facts()), before);
  assert.equal(Object.keys(h.sheets).length, 1);
  assert.equal(summary.write, false);
  assert.equal(summary.perKey.xdc_lifetime_unique_claimers.updated, 1);
  assert.ok(summary.perKey.xdc_lifetime_unique_claimers.added > 300);
});

test('correction rewrites stored rows, adds missing ones, logs old values, and a second run changes nothing', () => {
  const h = harness({ facts: baseFacts() });
  const summary = h.context.xdcSubgraphCorrection();
  const rows = h.facts();
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_lifetime_unique_claimers'), lifetimeAt(D));
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_new_claimers'), 1);
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_returning_claimers'), 49);
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_gd_claimed_1d'), 10);
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_gd_claimed_7d'), 70);       // already right: untouched
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_gd_claimed_30d'), 300);
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_daily_gd_minted'), 10);
  assert.equal(valueOf(rows, D, 'AGG', 'agg_gd_claimed_1d'), 110);
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_usd_claimed_1d'), 5);
  assert.equal(valueOf(rows, D, 'AGG', 'agg_usd_claimed_1d'), 45);      // Celo 40 + XDC 5
  assert.equal(valueOf(rows, D, 'XDC', 'xdc_p2p_usd_amount'), 500);
  assert.equal(valueOf(rows, OLD, 'XDC', 'xdc_usd_claimed_1d'), 1.23);  // outside the USD window: untouched
  assert.equal(valueOf(rows, D, 'CELO', 'celo_dau'), 12345);
  assert.equal(rows.filter(r => r[2] === 'xdc_gd_claimed_7d' && r[0] === D).length, 1);
  assert.equal(rows.find(r => r[0] === D && r[2] === 'xdc_gd_claimed_7d')[5], '2026-11-20 02:28:00');

  const log = h.sheets[summary.logSheet].data;
  assert.equal(log.length - 1, summary.updated + summary.added);
  const lifeLog = log.find(r => r[0] === D && r[2] === 'xdc_lifetime_unique_claimers');
  assert.deepEqual(lifeLog.slice(3, 7), ['updated', 139000, lifetimeAt(D), '2026-11-20 02:28:00']);
  assert.ok(summary.noPriceDates.length > 80);                         // only D has a price row in this fixture

  const again = h.context.xdcSubgraphCorrection();
  assert.equal(again.updated + again.added, 0);
  assert.equal(again.logSheet, null);
});

test('restore puts every old value back and removes added rows', () => {
  const h = harness({ facts: baseFacts() });
  const before = h.facts().map(r => [...r]);
  const summary = h.context.xdcSubgraphCorrection();
  const restored = h.context.xdcSubgraphCorrectionRestoreLatest();
  assert.equal(restored.notFound, 0);
  assert.deepEqual(h.facts(), before);
  assert.ok(h.sheets[summary.logSheet + ' (restored)']);
  assert.throws(() => h.context.xdcSubgraphCorrectionRestoreLatest(), /No "XDC 1.4 corrections/);
});

test('stops without touching Daily Facts if a row is appended while it runs', () => {
  const h = harness({ facts: baseFacts(), onFlush: sheets => sheets['Daily Facts'].data.push([yesterday, 'CELO', 'celo_dau', 1, 'DUNE', 'x']) });
  const before = JSON.stringify(h.facts());
  assert.throws(() => h.context.xdcSubgraphCorrection(), /Daily Facts changed during the run/);
  assert.equal(JSON.stringify(h.facts().slice(0, -1)), JSON.stringify(JSON.parse(before)));
});

test('refuses when the subgraph has not indexed the end of the last day to correct', () => {
  const h = harness({ facts: baseFacts(), headTimestamp: Date.parse(D + 'T12:00:00Z') / 1000 });
  assert.throws(() => h.context.xdcSubgraphCorrectionPreview(), /is before the end of/);
});

test('formulas elsewhere in Daily Facts are written back unchanged', () => {
  const facts = [...baseFacts(), ['2026-02-25', 'AGG', 'agg_gd_in_circulation', 9183455701.52, 'Manual input', '2026-11-24 20:28:20']];
  const row = facts.length + 1; // header is row 1
  const h = harness({ facts, formulas: { [row]: { 4: '=9183455701.52', 6: '=NOW()' } } });
  h.context.xdcSubgraphCorrection();
  const manual = h.facts().find(r => r[2] === 'agg_gd_in_circulation');
  assert.equal(manual[3], '=9183455701.52');
  assert.equal(manual[5], '=NOW()');
});

test('a row that needs a change but holds a formula stops the run before any write', () => {
  const facts = baseFacts();
  const row = facts.findIndex(r => r[2] === 'xdc_lifetime_unique_claimers') + 2;
  const h = harness({ facts, formulas: { [row]: { 4: '=139000' } } });
  const before = JSON.stringify(h.facts());
  assert.throws(() => h.context.xdcSubgraphCorrection(), /holds a formula/);
  assert.equal(JSON.stringify(h.facts()), before);
  assert.equal(Object.keys(h.sheets).length, 1);
});

test('stops at the last day the daily run has written', () => {
  const h = harness({ facts: baseFacts() });
  const summary = h.context.xdcSubgraphCorrection();
  assert.equal(summary.until, D);
  assert.equal(h.facts().filter(r => r[0] > D).length, 0);
});
