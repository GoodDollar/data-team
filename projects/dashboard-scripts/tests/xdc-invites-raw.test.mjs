import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const headers = ['date', 'block_number', 'block_timestamp', 'tx_hash', 'log_index', 'event', 'inviter', 'invitee', 'invite_type', 'inviter_paid_g', 'invitee_paid_g', 'campaign_returned_g', 'total_paid_g'];
const legacyHeaders = [...headers.slice(0, 8), 'invite_type_or_bounty', ...headers.slice(9, 11), 'total_paid_g', ''];
const clone = rows => rows.map(row => [...row]);
function eventRow({ bounty = false, legacy = false } = {}) {
  return ['2026-10-20', 108500001, 1792454400, `0x${(bounty ? 'b' : 'a').repeat(64)}`, 0,
    bounty ? 'InviterBounty' : 'InviteeJoined', `0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`, bounty ? '' : 'referral',
    bounty ? 1000 : 0, bounty ? 500 : 0, legacy && bounty ? 1500 : 0, legacy ? '' : bounty ? 1500 : 0];
}
function harness(rows, options = {}) {
  const data = [options.headers ?? headers, ...clone(rows)];
  const backups = [];
  const writes = [];
  const range = (row, column, height, width) => ({
    getValues: () => data.slice(row - 1, row - 1 + height).map(values => values.slice(column - 1, column - 1 + width)),
    setValues(values) {
      if (options.writeFailure) throw new Error('write failed');
      writes.push('set');
      values.forEach((valuesRow, offset) => { data[row - 1 + offset] = [...valuesRow]; });
    },
    clearContent() {
      writes.push('clear');
      data.splice(row - 1, height);
    }
  });
  const sheet = {
    getLastRow: () => data.length,
    getRange: range,
    copyTo() {
      if (options.backupFailure) throw new Error('backup failed');
      const backup = { data: clone(data), name: '', setName(name) { this.name = name; return this; }, getName() { return this.name; } };
      backups.push(backup);
      if (options.changeDuringBackup) data.push(eventRow());
      return backup;
    }
  };
  const spreadsheet = { getSheetByName: name => name === 'XDC Invites Raw' ? options.missing ? null : sheet : backups.find(backup => backup.name === name) };
  const context = { SpreadsheetApp: { openById: () => spreadsheet, flush() {} }, Logger: { log() {} } };
  vm.createContext(context);
  vm.runInContext(source('v6-daily.gs'), context, { filename: new URL('../v6-daily.gs', import.meta.url).pathname });
  vm.runInContext(source('v6-dev.gs'), context, { filename: new URL('../v6-dev.gs', import.meta.url).pathname });
  return { data, backups, writes, context, run: () => context.xdcInvitesDedupeRaw() };
}

test('deduplicates mixed-layout events and backs up original rows before writing', () => {
  const rows = [eventRow({ legacy: true }), eventRow(), eventRow({ bounty: true, legacy: true }), eventRow({ bounty: true })];
  const fixture = harness(rows, { headers: legacyHeaders });
  const result = fixture.run();
  assert.equal(result.duplicatesRemoved, 2);
  assert.equal(result.rowsAfter, 2);
  assert.deepEqual(fixture.data, [headers, eventRow(), eventRow({ bounty: true })]);
  assert.deepEqual(fixture.backups[0].data, [legacyHeaders, ...rows]);
  assert.equal(result.backupSheet, fixture.backups[0].name);
  assert.deepEqual(fixture.writes, ['set', 'clear']);
});

test('normalizes legacy payout rows even when no duplicates exist', () => {
  const fixture = harness([eventRow({ bounty: true, legacy: true })]);
  assert.equal(fixture.run().duplicatesRemoved, 0);
  assert.deepEqual(fixture.data, [headers, eventRow({ bounty: true })]);
});

test('reconstructs legacy campaign returns from the total payout', () => {
  const row = eventRow({ bounty: true, legacy: true });
  row[11] = 1750;
  const fixture = harness([row]);
  fixture.run();
  assert.equal(fixture.data[1][11], 250);
  assert.equal(fixture.data[1][12], 1750);
});

test('compares keys using lowercase transaction hash and numeric log index', () => {
  const row = eventRow();
  const duplicate = [...row];
  duplicate[3] = `0x${'A'.repeat(64)}`;
  duplicate[4] = '0';
  const fixture = harness([row, duplicate]);
  assert.equal(fixture.run().duplicatesRemoved, 1);
});

test('a second run makes no writes or additional backup', () => {
  const fixture = harness([eventRow(), eventRow()]);
  fixture.run();
  const writes = fixture.writes.length;
  const second = fixture.run();
  assert.equal(second.duplicatesRemoved, 0);
  assert.equal(second.backupSheet, null);
  assert.equal(fixture.writes.length, writes);
  assert.equal(fixture.backups.length, 1);
});

test('canonical unique rows and header-only sheets need no repair', () => {
  for (const rows of [[], [eventRow()]]) {
    const fixture = harness(rows);
    assert.equal(fixture.run().backupSheet, null);
    assert.equal(fixture.writes.length, 0);
  }
});

test('conflicting duplicate payloads abort before any backup or mutation', () => {
  const row = eventRow({ bounty: true });
  const conflict = [...row];
  conflict[9] = 1500;
  conflict[12] = 2000;
  const fixture = harness([row, conflict]);
  assert.throws(fixture.run, /conflicting/i);
  assert.equal(fixture.backups.length, 0);
  assert.equal(fixture.writes.length, 0);
});

test('invalid keys, events and payout values abort without changing raw', () => {
  for (const [column, value] of [[3, 'bad hash'], [4, -1], [4, ''], [5, 'OtherEvent'], [9, -1], [9, 'invalid'], [12, 100]]) {
    const row = eventRow({ bounty: true });
    row[column] = value;
    const fixture = harness([row]);
    assert.throws(fixture.run, /invalid|inconsistent/i);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.backups.length, 0);
  }
});

test('unknown headers and missing raw sheets fail without creating sheets', () => {
  const wrongHeaders = [...headers];
  wrongHeaders[3] = 'unknown';
  for (const options of [{ headers: wrongHeaders }, { missing: true }]) {
    const fixture = harness([eventRow()], options);
    assert.throws(fixture.run, /header|not found/i);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.backups.length, 0);
  }
});

test('backup failure prevents writes and concurrent append aborts the repair', () => {
  for (const options of [{ backupFailure: true }, { changeDuringBackup: true }]) {
    const fixture = harness([eventRow(), eventRow()], options);
    assert.throws(fixture.run, /backup failed|changed/i);
    assert.equal(fixture.writes.length, 0);
  }
});

test('write failure leaves a complete backup available', () => {
  const fixture = harness([eventRow(), eventRow()], { writeFailure: true });
  assert.throws(fixture.run, /write failed/);
  assert.equal(fixture.backups.length, 1);
  assert.deepEqual(fixture.backups[0].data, [headers, eventRow(), eventRow()]);
});