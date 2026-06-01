/***** =========================================
 * GOODDOLLAR DASHBOARD — DEV v5.0
 * =========================================
 *
 * Companion file to daily_v5.gs. Contains everything that is NOT part
 * of the daily cron path: connection tests, one-shot repair/migration
 * functions, manual backfills, schema inspectors, and the Partners
 * sheet refresher (which the team updates manually every so often).
 *
 * Nothing in this file is called by smartBackfill(). Every function is
 * a manual entrypoint you trigger yourself from the Apps Script UI when
 * you need it.
 *
 * This file depends on daily_v5.gs for all constants and helpers:
 *   CONFIG, METRICS, XDC_INVITES_CFG, XDC_INVITES_RAW_HEADERS,
 *   toYMD, addDays, getYesterdayYMD, ensureSheets, getExistingFactsIndex,
 *   buildRows, writeFactsAndHealth, duneFetchTable, hypersyncFetchLogs,
 *   xdcInvitesReadRaw, xdcInvitesGetCampaignOwner, xdcRpcCall,
 *   reserveGqlRequest, xdcReserveGqlRequest, xdcGqlRequest,
 *   buildBountyTransferIndex, parseInviteeJoined, parseInviterBounty,
 *   fetchXdcReserveLiquidity, etc.
 *
 * SECTIONS
 * --------
 *  1) Connection tests          — safe, no writes
 *  2) Dry-run / preview tools   — safe, no writes
 *  3) Manual backfills          — writes to Daily Facts
 *  4) Facts sheet maintenance   — dedupeFactsSheet, repair helpers
 *  5) XDC Invites one-shots     — relabel, schema migrate, cursor reset
 *  6) XDC Invites inspectors    — cursor status, parse sample, Transfer join test
 *  7) XDC Invites Profile sheet — rebuild + refresh
 *  8) Partners sheet refresher  — manual Dune pull
 *****/


/***** =========================================
 * 0) DEV-ONLY CONSTANTS
 * =========================================*/

// Dune query ID for the Partners sheet — kept here so the main file's
// DUNE_IDS stays lean (only the queries smartBackfill actually uses).
var DEV_DUNE_PARTNERS_ID = '5608955';

// The sheet where updatePartnersSheet() writes. Create on first run.
var DEV_SHEET_PARTNERS = 'Partners';

// List of xdc_invites_* metric_keys — used by any repair tool that
// needs to scope a wipe/recompute to just the invites domain.
var XDC_INVITES_METRIC_KEYS = [
  'xdc_invites_total_signups',           'xdc_invites_total_signups_at',
  'xdc_invites_referral_signups',        'xdc_invites_referral_signups_at',
  'xdc_invites_campaign_signups',        'xdc_invites_campaign_signups_at',
  'xdc_invites_nocode_signups',          'xdc_invites_nocode_signups_at',
  'xdc_invites_total_unique_users',      'xdc_invites_total_unique_users_at',
  'xdc_invites_unique_invitees',         'xdc_invites_unique_invitees_at',
  'xdc_invites_unique_inviters',         'xdc_invites_unique_inviters_at',
  'xdc_invites_total_bounties_count',    'xdc_invites_total_bounties_count_at',
  'xdc_invites_invitee_bounties_count',  'xdc_invites_invitee_bounties_count_at',
  'xdc_invites_inviter_bounties_count',  'xdc_invites_inviter_bounties_count_at',
  'xdc_invites_total_amount_paid',       'xdc_invites_total_amount_paid_at',
  'xdc_invites_invitee_amount_paid',     'xdc_invites_invitee_amount_paid_at',
  'xdc_invites_inviter_amount_paid',     'xdc_invites_inviter_amount_paid_at',
  'xdc_invites_campaign_amount_returned','xdc_invites_campaign_amount_returned_at'
];


/***** =========================================
 * 1) CONNECTION TESTS (safe, no writes)
 * =========================================*/

/**
 * Ping the Dune API with a tiny fetch to verify the API key works
 * and the network route is open.
 */
function testDuneConnection() {
  Logger.log('=== testDuneConnection ===');
  try {
    const result = duneFetchTable(DUNE_IDS.ACTIVE_CLAIMERS, 5);
    Logger.log('  ok — ' + result.rows.length + ' rows returned');
    if (result.rows.length) {
      Logger.log('  first row: ' + JSON.stringify(result.rows[0]));
    }
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}

/**
 * Ping the XDC Goldsky subgraph with a tiny query.
 */
function testGoldskyXdcConnection() {
  Logger.log('=== testGoldskyXdcConnection ===');
  try {
    const data = xdcGqlRequest('{ dailyUBIs(first: 3, orderBy: id, orderDirection: desc) { id activeUsers totalUBIDistributed } }');
    const nodes = (data && data.dailyUBIs) || [];
    Logger.log('  ok — ' + nodes.length + ' daily rows');
    for (var i = 0; i < nodes.length; i++) {
      Logger.log('    ' + xdcDayISOToYmd(nodes[i].id) + ' activeUsers=' + nodes[i].activeUsers +
                 ' totalUBI=' + nodes[i].totalUBIDistributed);
    }
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}

/**
 * Ping the CELO reserve subgraph.
 */
function testReserveConnection() {
  Logger.log('=== testReserveConnection ===');
  try {
    const data = reserveGqlRequest('{ reservePrices(first: 3, orderBy: timestamp, orderDirection: desc) { id day price timestamp } }');
    const nodes = (data && data.reservePrices) || [];
    Logger.log('  ok — ' + nodes.length + ' price rows');
    for (var i = 0; i < nodes.length; i++) {
      Logger.log('    ' + dayISOToYmd(nodes[i].day) + ' $' + (Number(nodes[i].price) / 1e18).toFixed(8));
    }
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}

/**
 * Ping the XDC reserve subgraph.
 */
function testXdcReserveConnection() {
  Logger.log('=== testXdcReserveConnection ===');
  try {
    const data = xdcReserveGqlRequest('{ reservePrices(first: 3, orderBy: timestamp, orderDirection: desc) { price timestamp } }');
    const nodes = (data && data.reservePrices) || [];
    Logger.log('  ok — ' + nodes.length + ' price rows');
    for (var i = 0; i < nodes.length; i++) {
      const ymd = new Date(Number(nodes[i].timestamp) * 1000).toISOString().slice(0, 10);
      Logger.log('    ' + ymd + ' $' + (Number(nodes[i].price) / 1e6).toFixed(8));
    }
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}

/**
 * Read XDC reserve liquidity via on-chain RPC (latest balances).
 */
function testXdcReserveLiquidity() {
  Logger.log('=== testXdcReserveLiquidity ===');
  try {
    const result = fetchXdcReserveLiquidity(getYesterdayYMD());
    Logger.log('  ok — total liquidity: $' + result[0].value.toFixed(2));
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}

/**
 * Hit Hypersync with a tiny query to confirm the auth token works.
 */
function testHypersyncConnection() {
  Logger.log('=== testHypersyncConnection ===');
  try {
    const result = hypersyncFetchLogs({
      fromBlock: XDC_INVITES_CFG.GENESIS_BLOCK,
      toBlock:   XDC_INVITES_CFG.GENESIS_BLOCK + 100000,
      addresses: [XDC_INVITES_CFG.CONTRACT],
      topic0List: [
        XDC_INVITES_CFG.TOPIC_INVITEE_JOINED,
        XDC_INVITES_CFG.TOPIC_INVITER_BOUNTY
      ],
      maxPages: 5
    });
    Logger.log('  ok — ' + result.logs.length + ' logs in ' + result.pages + ' page(s)');
    if (result.logs.length > 0) {
      const sample = result.logs[0];
      Logger.log('  first log: block=' + sample.block_number +
                 ' topic0=' + sample.topic0 + ' tx=' + sample.transaction_hash);
    }
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}

/**
 * Test every data source in one go. Useful after a fresh deploy or
 * when troubleshooting a failed cron run.
 */
function testAllConnections() {
  Logger.log('===== testAllConnections =====');
  testDuneConnection();
  testGoldskyXdcConnection();
  testReserveConnection();
  testXdcReserveConnection();
  testXdcReserveLiquidity();
  testHypersyncConnection();
  testXdcInvitesCampaignOwner();
  Logger.log('===== done =====');
}


/***** =========================================
 * 2) DRY-RUN / PREVIEW TOOLS (safe, no writes)
 * =========================================*/

/**
 * Run buildRows() for yesterday in memory and log what it would write,
 * without actually calling writeFactsAndHealth(). Great for sanity
 * checking after editing the METRICS registry or adapter code.
 */
function testBuildRowsDryRun() {
  const yesterday = getYesterdayYMD();
  Logger.log('=== testBuildRowsDryRun for ' + yesterday + ' ===');
  ensureSheets();
  const indexResult = getExistingFactsIndex();
  const result = buildRows(yesterday, yesterday, indexResult);

  Logger.log('would write ' + result.rows.length + ' row(s):');
  for (var i = 0; i < Math.min(result.rows.length, 50); i++) {
    const r = result.rows[i];
    Logger.log('  ' + r.date + ' | ' + r.chain + ' | ' + r.metric_key + ' = ' + r.value + ' [' + r.source + ']');
  }
  if (result.rows.length > 50) Logger.log('  ... (' + (result.rows.length - 50) + ' more)');

  Logger.log('health rows: ' + result.health.length);
  var errors = 0;
  for (var j = 0; j < result.health.length; j++) {
    if (result.health[j].status === 'error') {
      errors++;
      Logger.log('  ERR ' + result.health[j].metric_key + '/' + result.health[j].chain + ': ' + result.health[j].error);
    }
  }
  Logger.log('errors: ' + errors + ' / ' + result.health.length);
  Logger.log('=== dry run complete (NO data written) ===');
}

/**
 * Show what smartBackfill would do without actually running it. For
 * each metric, reports the latest persisted date and how many days of
 * backfill it needs.
 */
function previewSmartBackfill() {
  Logger.log('=== previewSmartBackfill ===');
  ensureSheets();
  const indexResult = getExistingFactsIndex();
  const yesterday = getYesterdayYMD();

  var totalDays = 0;
  var upToDate = 0;
  var needsBackfill = 0;

  const metricKeys = Object.keys(METRICS);
  for (var m = 0; m < metricKeys.length; m++) {
    const metricKey = metricKeys[m];
    const spec = METRICS[metricKey];
    const chains = (spec.chains || []).filter(function(c) { return CHAINS[c] || c === 'AGG'; });

    for (var c = 0; c < chains.length; c++) {
      const chain = chains[c];
      const lastDate = indexResult.maxDates[chain + '|' + metricKey];

      var startFrom;
      if (lastDate) {
        startFrom = addDays(lastDate, 1);
      } else {
        startFrom = (chain === 'XDC') ? CONFIG.XDC_GENESIS : addDays(yesterday, -90);
      }
      if (chain === 'XDC' && startFrom < CONFIG.XDC_GENESIS) startFrom = CONFIG.XDC_GENESIS;

      const daysNeeded = (startFrom > yesterday) ? 0 : dateDiffDays(startFrom, yesterday) + 1;
      totalDays += daysNeeded;
      if (daysNeeded === 0) upToDate++;
      else needsBackfill++;

      const status = (daysNeeded === 0)
        ? 'up to date (last=' + lastDate + ')'
        : 'needs ' + daysNeeded + ' day(s) from ' + startFrom;
      Logger.log('  ' + metricKey + '/' + chain + ': ' + status);
    }
  }

  Logger.log('---');
  Logger.log('summary: ' + upToDate + ' up to date, ' + needsBackfill + ' need backfill, ' +
             totalDays + ' total day-metric-chains to fetch');
}

/**
 * Dry-run the invites aggregation step without writing anything. Shows
 * what xdcInvitesAggregate() would produce for each metric for the
 * last 7 days.
 */
function testXdcInvitesAggregateDryRun() {
  Logger.log('=== testXdcInvitesAggregateDryRun ===');
  const agg = xdcInvitesAggregate();
  const since = addDays(getYesterdayYMD(), -7);
  const until = getYesterdayYMD();
  Logger.log('showing ' + since + ' .. ' + until);

  const keys = Object.keys(agg).sort();
  for (var k = 0; k < keys.length; k++) {
    const dateMap = agg[keys[k]];
    const dates = Object.keys(dateMap).filter(function(d) { return d >= since && d <= until; }).sort();
    if (!dates.length) continue;
    var parts = [];
    for (var d = 0; d < dates.length; d++) parts.push(dates[d] + '=' + dateMap[dates[d]]);
    Logger.log('  ' + keys[k] + ': ' + parts.join(', '));
  }
}


/***** =========================================
 * 3) MANUAL BACKFILLS (writes)
 * =========================================*/

/**
 * Force-fill every missing row from XDC genesis to yesterday. Useful
 * after a fresh deploy or after you wipe/rebuild a portion of the
 * facts sheet.
 *
 * This is just a wrapper around backfillRange() with the max window.
 * Does NOT touch the invites Hypersync cursor — if you also need to
 * refetch invite events from genesis, call resetXdcInvitesCursor()
 * first and then run smartBackfill() a few times.
 */
function backfillAll() {
  Logger.log('=== backfillAll: genesis → yesterday ===');
  const since = CONFIG.XDC_GENESIS;
  const until = getYesterdayYMD();
  backfillRange(since, until);
}

/**
 * Backfill a single metric across a date range. Useful when you've
 * deleted bad rows for one metric and want to refill only that metric
 * without re-running the whole pipeline.
 *
 * Example:
 *   backfillSingleMetric('xdc_gd_price', '2026-03-01', '2026-03-31');
 *
 * Works by temporarily scoping the METRICS registry, running
 * buildRows, then restoring it. Not thread-safe (but Apps Script is
 * single-threaded anyway).
 */
function backfillSingleMetric(metricKey, sinceYMD, untilYMD) {
  if (!METRICS[metricKey]) {
    throw new Error('Unknown metric: ' + metricKey);
  }
  Logger.log('=== backfillSingleMetric ' + metricKey + ' ' + sinceYMD + ' .. ' + untilYMD + ' ===');

  // Stash the full registry, replace with just this one metric + any
  // metrics it depends on.
  const fullRegistry = METRICS;
  const isolatedRegistry = {};
  isolatedRegistry[metricKey] = fullRegistry[metricKey];

  // Include price dependencies if this metric uses Computed
  const spec = fullRegistry[metricKey];
  if (spec.adapter === 'Computed' && spec.computed && spec.computed.priceSource === 'xdc') {
    isolatedRegistry.xdc_gd_price = fullRegistry.xdc_gd_price;
  }

  // Swap, run, restore
  const savedKeys = Object.keys(METRICS);
  for (var i = 0; i < savedKeys.length; i++) {
    if (!isolatedRegistry[savedKeys[i]]) delete METRICS[savedKeys[i]];
  }

  try {
    ensureSheets();
    const indexResult = getExistingFactsIndex();
    const result = buildRows(sinceYMD, untilYMD, indexResult);
    writeFactsAndHealth(result, indexResult);
  } finally {
    // Restore
    for (var k in fullRegistry) METRICS[k] = fullRegistry[k];
  }
  Logger.log('=== backfillSingleMetric done ===');
}

/**
 * Manual historical backfill — no window cap, no budget deadline.
 * Use for gaps older than CONFIG.LOOKBACK_DAYS that smartBackfill
 * won't reach due to the 30-day cap.
 *
 * Example: forceBackfill('2026-01-01', '2026-03-31');
 */
function forceBackfill(sinceYMD, untilYMD) {
  Logger.log('forceBackfill: ' + sinceYMD + ' .. ' + untilYMD);
  ensureSheets();
  var indexResult = getExistingFactsIndex();
  var result      = buildRows(sinceYMD, untilYMD, indexResult, null);
  var writeResult = writeFactsAndHealth(result, indexResult);
  Logger.log('forceBackfill complete: wrote ' + writeResult.written + ' row(s)');
}

/**
 * Audit all gaps in the Daily Facts sheet from XDC_GENESIS through yesterday,
 * then fill them in 28-day chunks. Safe to run multiple times — each run reads
 * the full sheet first so already-written rows are never duplicated, even for
 * dates outside the 3500-row tail window.
 *
 * Supply metrics (eth/fuse/celo supply) are excluded: those APIs only return
 * the current value and cannot backfill historical dates.
 *
 * If the date range is large and the GAS 6-minute limit approaches, the
 * function stops cleanly and logs where it left off. Re-run it and it will
 * pick up from the next unprocessed chunk automatically.
 */
function auditAndFillGaps() {
  var SINCE       = CONFIG.XDC_GENESIS;  // '2025-11-12'
  var UNTIL       = getYesterdayYMD();
  var CHUNK_DAYS  = 28;                  // days per buildRows call (~2-3 min each)
  var MAX_RUN_MS  = 270000;              // 4.5 min guard — stop before GAS 6-min kill
  var runStart    = Date.now();

  Logger.log('===== auditAndFillGaps ' + SINCE + ' .. ' + UNTIL + ' =====');

  // ── 1. Full sheet read (not tail-limited) for accurate dedup ─────────────
  var ss      = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var facts   = ss.getSheetByName(CONFIG.SHEET_FACTS);
  var lastRow = facts.getLastRow();
  if (lastRow < 2) { Logger.log('Sheet is empty.'); return; }

  var t0   = Date.now();
  var data = facts.getRange(2, 1, lastRow - 1, 5).getValues();
  Logger.log('Read ' + data.length + ' rows in ' + (Date.now() - t0) + 'ms');

  var existingIndex = {}, factsValueIndex = {}, maxDates = {};
  for (var i = 0; i < data.length; i++) {
    var ymd = toYMD(data[i][0]), chain = data[i][1], mk = data[i][2];
    if (!ymd || !chain || !mk) continue;
    var key = ymd + '|' + chain + '|' + mk;
    existingIndex[key] = true;
    var v = Number(data[i][3]);
    factsValueIndex[key] = isFinite(v) ? v : null;
    var cm = chain + '|' + mk;
    if (!maxDates[cm] || ymd > maxDates[cm]) maxDates[cm] = ymd;
  }

  var indexResult = { existingIndex: existingIndex, factsValueIndex: factsValueIndex, maxDates: maxDates };

  // ── 2. Audit — find earliest gap ─────────────────────────────────────────
  var supplySkip = {
    eth_gd_total_supply: true, eth_gd_frozen_supply: true,
    eth_gd_in_circulation: true, fuse_gd_in_circulation: true,
    celo_gd_in_circulation: true, agg_gd_in_circulation: true
  };

  var dates = [], d = SINCE;
  while (d <= UNTIL) { dates.push(d); d = addDays(d, 1); }

  var earliestGap = null, totalMissing = 0;
  var metricKeys = Object.keys(METRICS);
  for (var m = 0; m < metricKeys.length; m++) {
    var mkey = metricKeys[m];
    if (supplySkip[mkey]) continue;
    var spec = METRICS[mkey], chains = spec.chains || [];
    for (var c = 0; c < chains.length; c++) {
      var ch    = chains[c];
      var floor = (ch === 'XDC') ? CONFIG.XDC_GENESIS : SINCE;
      for (var di = 0; di < dates.length; di++) {
        if (dates[di] < floor) continue;
        if (!existingIndex[dates[di] + '|' + ch + '|' + mkey]) {
          totalMissing++;
          if (!earliestGap || dates[di] < earliestGap) earliestGap = dates[di];
        }
      }
    }
  }

  Logger.log('Audit: ' + totalMissing + ' missing (chain|metric|date) combination(s)');
  if (totalMissing === 0) {
    Logger.log('No gaps found — sheet is complete for ' + SINCE + ' .. ' + UNTIL + ' ✅');
    return;
  }
  Logger.log('Earliest gap: ' + earliestGap + '. Filling in ' + CHUNK_DAYS + '-day chunks...');

  // ── 3. Fill in chunks, updating in-memory indexes after each write ───────
  var totalWritten = 0, totalSkipped = 0;
  var chunkStart   = earliestGap;

  while (chunkStart <= UNTIL) {
    if (Date.now() - runStart > MAX_RUN_MS) {
      Logger.log('Approaching GAS limit — stopping at chunk start ' + chunkStart
        + '. Re-run auditAndFillGaps() to continue.');
      break;
    }

    var chunkEnd = addDays(chunkStart, CHUNK_DAYS - 1);
    if (chunkEnd > UNTIL) chunkEnd = UNTIL;
    Logger.log('  chunk ' + chunkStart + ' .. ' + chunkEnd);

    var result = buildRows(chunkStart, chunkEnd, indexResult, null);

    // Strip metrics that cannot be historically backfilled:
    //   - fuse/celo supply: live APIs return today's value only
    //   - agg supply: computed from fuse+celo, also wrong for history
    //   - xdc reserve liquidity and derived metrics: RPC always returns current
    //     on-chain balance, not the balance on a past date
    var AUDIT_WRITE_SKIP = {
      fuse_gd_in_circulation:    true,
      celo_gd_in_circulation:    true,
      agg_gd_in_circulation:     true,
      xdc_reserve_liquidity_usd: true,
      xdc_reserve_backing_ratio: true,
      xdc_daily_gd_minted:       true,
      xdc_reserve_growth_abs:    true
    };
    if (result.rows) {
      result.rows = result.rows.filter(function(r) {
        return !AUDIT_WRITE_SKIP[r.metric_key];
      });
    }

    if (result.rows && result.rows.length > 0) {
      var wr         = writeFactsAndHealth(result, indexResult);
      totalWritten  += wr.written;
      totalSkipped  += wr.skipped;

      // Update in-memory index so later chunks don't re-attempt these rows
      // and computed metrics (e.g. xdc_daily_gd_minted) can read earlier values
      for (var ri = 0; ri < result.rows.length; ri++) {
        var r    = result.rows[ri];
        var rkey = r.date + '|' + r.chain + '|' + r.metric_key;
        existingIndex[rkey]   = true;
        factsValueIndex[rkey] = r.value;
        var rcm = r.chain + '|' + r.metric_key;
        if (!maxDates[rcm] || r.date > maxDates[rcm]) maxDates[rcm] = r.date;
      }
    }

    chunkStart = addDays(chunkEnd, 1);
  }

  Logger.log('===== auditAndFillGaps done — wrote ' + totalWritten
    + ' row(s), skipped ' + totalSkipped + ' already-present =====');
  if (chunkStart <= UNTIL) {
    Logger.log('Incomplete — re-run to continue from ' + chunkStart + ' .. ' + UNTIL);
  } else {
    Logger.log('All chunks done. Sheet should be gap-free for ' + earliestGap + ' .. ' + UNTIL);
  }
}


/***** =========================================
 * 4) FACTS SHEET MAINTENANCE (writes)
 * =========================================*/

/**
 * ONE-TIME MIGRATION: sort the Daily Facts sheet into ascending date
 * order and set FACTS_SHEET_SORTED_V5 = 'true' in Script Properties.
 *
 * Must be run ONCE before v5 smartBackfill goes live. After migration,
 * the sheet is maintained in ascending order by the append-at-bottom
 * write path, so this never needs to run again.
 */
function migrateFactsSheetSortAsc() {
  var ss    = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_FACTS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('migrateFactsSheetSortAsc: sheet is empty, nothing to do');
    return;
  }
  Logger.log('migrateFactsSheetSortAsc: reading ' + (lastRow - 1) + ' rows...');
  var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  data.sort(function(a, b) {
    if (a[0] < b[0]) return -1; if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1; if (a[1] > b[1]) return 1;
    if (a[2] < b[2]) return -1; if (a[2] > b[2]) return 1;
    return 0;
  });
  sheet.getRange(2, 1, data.length, 6).clearContent();
  sheet.getRange(2, 1, data.length, 6).setValues(data);
  PropertiesService.getScriptProperties().setProperty('FACTS_SHEET_SORTED_V5', 'true');
  Logger.log('migrateFactsSheetSortAsc: complete. ' + data.length + ' rows sorted ascending.');
}

/**
 * DEDUPE THE FACTS SHEET.
 *
 * Scans the entire Daily Facts sheet for rows that share the same
 * (date, chain, metric_key) coordinate. For each such duplicate group,
 * keeps the row with the most recent `updated_at` timestamp and
 * DELETES the rest.
 *
 * This is the repair counterpart to auditFactsSheet() in daily_v5.gs:
 * audit DETECTS duplicates and logs them; dedupe REPAIRS them.
 *
 * Safety:
 *  - Makes a backup copy of the facts sheet to "Daily Facts BACKUP
 *    YYYYMMDD_HHMMSS" before deleting anything.
 *  - Logs every deletion with the old and new values so you can verify.
 *  - Idempotent: running it again does nothing if the sheet is clean.
 *
 * Run this manually whenever auditFactsSheet() reports duplicates in
 * the Health log.
 */
function dedupeFactsSheet() {
  Logger.log('=== dedupeFactsSheet ===');
  ensureSheets();
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  const lastRow = facts.getLastRow();
  if (lastRow < 2) {
    Logger.log('  facts sheet empty');
    return;
  }

  // Read the full sheet: date, chain, metric_key, value, source, updated_at
  const data = facts.getRange(2, 1, lastRow - 1, 6).getValues();

  // Group by (date|chain|metric) → list of {rowIdx, updatedAt, value, source}
  const groups = {};
  for (var i = 0; i < data.length; i++) {
    const ymd = toYMD(data[i][0]);
    const chain = data[i][1];
    const metric = data[i][2];
    if (!ymd || !chain || !metric) continue;

    const key = ymd + '|' + chain + '|' + metric;
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      rowIdx: i + 2, // sheet row number (1-indexed, skip header)
      updatedAt: String(data[i][5] || ''),
      value: data[i][3],
      source: data[i][4]
    });
  }

  // Find duplicate groups
  const rowsToDelete = [];
  const dupGroups = [];
  Object.keys(groups).forEach(function(k) {
    const group = groups[k];
    if (group.length <= 1) return;
    dupGroups.push(k + ' (×' + group.length + ')');
    // Sort by updatedAt descending so the "keeper" is first
    group.sort(function(a, b) { return b.updatedAt.localeCompare(a.updatedAt); });
    const keeper = group[0];
    Logger.log('  dup: ' + k + ' keeping row ' + keeper.rowIdx + ' updated=' + keeper.updatedAt +
               ' value=' + keeper.value);
    for (var g = 1; g < group.length; g++) {
      Logger.log('    delete row ' + group[g].rowIdx + ' updated=' + group[g].updatedAt +
                 ' value=' + group[g].value);
      rowsToDelete.push(group[g].rowIdx);
    }
  });

  if (!rowsToDelete.length) {
    Logger.log('  no duplicates found');
    return;
  }

  Logger.log('  ' + dupGroups.length + ' duplicate group(s), ' + rowsToDelete.length + ' row(s) to delete');

  // Backup first
  const backupName = 'Daily Facts BACKUP ' + generateRunId();
  const backup = facts.copyTo(ss).setName(backupName);
  Logger.log('  backup created: ' + backupName);

  // Delete from the bottom up, grouping consecutive rows
  rowsToDelete.sort(function(a, b) { return b - a; });
  var ii = 0;
  var deleted = 0;
  while (ii < rowsToDelete.length) {
    var end = rowsToDelete[ii];
    var start = end;
    var jj = ii + 1;
    while (jj < rowsToDelete.length && rowsToDelete[jj] === start - 1) {
      start = rowsToDelete[jj];
      jj++;
    }
    facts.deleteRows(start, end - start + 1);
    deleted += (end - start + 1);
    ii = jj;
  }

  Logger.log('  deleted ' + deleted + ' duplicate row(s)');
  Logger.log('=== dedupeFactsSheet done — backup at "' + backupName + '" ===');
}

/**
 * Delete Daily Facts rows written for XDC reserve-derived metrics BEFORE the
 * reserve deployment date (XDC_RESERVE_SINCE = '2026-03-08').
 *
 * These rows were created by the bad smartBackfill run of 2026-05-23 which
 * used a 191-day window from XDC_GENESIS (2025-11-12). The XDC reserve
 * contracts were not deployed until 2026-03-08, so all reserve metric rows
 * prior to that date are either zero, carry-forwarded garbage, or the same
 * current-state value stamped across every historical date.
 *
 * Metrics cleaned:
 *   xdc_gd_price, xdc_reserve_liquidity_usd, xdc_reserve_backing_ratio,
 *   gd_price_spread, xdc_daily_gd_minted, xdc_reserve_growth_abs
 *
 * Creates a backup sheet before deleting. Safe to run multiple times.
 */
function deletePreReserveXdcRows() {
  Logger.log('=== deletePreReserveXdcRows ===');

  var CUTOFF = XDC_RESERVE_SINCE;  // '2026-03-08'
  var RESERVE_METRICS = {
    'xdc_gd_price':              true,
    'xdc_reserve_liquidity_usd': true,
    'xdc_reserve_backing_ratio': true,
    'gd_price_spread':           true,
    'xdc_daily_gd_minted':       true,
    'xdc_reserve_growth_abs':    true
  };

  var ss      = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var facts   = ss.getSheetByName(CONFIG.SHEET_FACTS);
  var lastRow = facts.getLastRow();
  if (lastRow < 2) { Logger.log('  sheet is empty'); return; }

  // Read date + metric_key columns only (cols 1 and 3)
  var data = facts.getRange(2, 1, lastRow - 1, 3).getValues();

  var rowsToDelete = [];
  for (var i = 0; i < data.length; i++) {
    var ymd    = toYMD(data[i][0]);
    var metric = data[i][2];
    if (!ymd || !metric) continue;
    if (RESERVE_METRICS[metric] && ymd < CUTOFF) {
      rowsToDelete.push(i + 2);  // 1-indexed sheet row (skip header)
    }
  }

  if (!rowsToDelete.length) {
    Logger.log('  no pre-' + CUTOFF + ' XDC reserve rows found — nothing to delete');
    return;
  }

  Logger.log('  found ' + rowsToDelete.length + ' row(s) to delete (date < ' + CUTOFF + ')');

  // Backup first
  var backupName = 'Daily Facts BACKUP ' + generateRunId();
  facts.copyTo(ss).setName(backupName);
  Logger.log('  backup created: ' + backupName);

  // Delete from bottom up to avoid row-index shifting
  rowsToDelete.sort(function(a, b) { return b - a; });
  var ii      = 0;
  var deleted = 0;
  while (ii < rowsToDelete.length) {
    var end   = rowsToDelete[ii];
    var start = end;
    var jj    = ii + 1;
    while (jj < rowsToDelete.length && rowsToDelete[jj] === start - 1) {
      start = rowsToDelete[jj];
      jj++;
    }
    facts.deleteRows(start, end - start + 1);
    deleted += (end - start + 1);
    ii = jj;
  }

  Logger.log('  deleted ' + deleted + ' row(s)');
  Logger.log('=== deletePreReserveXdcRows done — backup at "' + backupName + '" ===');
}


/***** =========================================
 * 4b) AUDIT FACTS SHEET — DETECT + EMAIL ALERT
 * =========================================
 *
 * Daily integrity check. Wire this to its own time-driven trigger to
 * run shortly AFTER smartBackfill (e.g., smartBackfill at 01:00 UTC,
 * audit at 01:30 UTC).
 *
 * Detects four classes of problems:
 *   1. DUPLICATES — any (date, chain, metric_key) appearing >1 time
 *   2. GAPS — missing days within an active metric's date range
 *   3. INVALID DATA — NaN/null values, illegal negatives, illegal zeros
 *   4. SPIKES — day-over-day value change >100% (with noise filters
 *      to avoid drowning the email in meaningless small-number swings)
 *
 * If any problem is found, sends a single summary email to AUDIT_EMAIL.
 * If clean, no email — silence = peace of mind.
 *
 * Always writes a Health Runs row regardless (so you can confirm the
 * trigger ran by checking the Health sheet).
 *
 * SPIKE DETECTION RULES
 * ---------------------
 * Day-over-day change is computed as |today - yesterday| / |yesterday|.
 * Flagged when the result exceeds SPIKE_THRESHOLD (1.0 = 100%).
 *
 * Noise filters (skip the spike check entirely if):
 *   - This metric is in SPIKE_SIGNED_METRICS (legitimately swings sign)
 *   - This metric is a count (decimals=0) AND both today and yesterday
 *     are < 100 (small-count noise: 2→5 is +150% but meaningless)
 *   - This metric is a G$ amount AND both today and yesterday are
 *     < 10000 G$ (small-amount noise)
 *   - Yesterday's value is exactly 0 — flagged separately as "0 → X"
 *     since infinite percentage is meaningless
 *
 * Prices are always checked regardless of magnitude (a 100% price swing
 * is always interesting).
 *****/

/** Email recipient for audit alerts. Change here if it ever needs to move. */
var AUDIT_EMAIL = 'thalescb86@gmail.com';

/** Threshold for spike detection: 1.0 = flag any >100% day-over-day change. */
var SPIKE_THRESHOLD = 1.0;

/** Metrics that legitimately swing sign / vary wildly — skip spike check. */
var SPIKE_SIGNED_METRICS = {
  'gd_price_spread': true,        // can flip sign as relative prices move
  'xdc_reserve_growth_abs': true  // daily delta, naturally volatile
};

/** Metrics that should never be zero (zero = data quality problem). */
var NEVER_ZERO_METRICS = {
  'celo_gd_price': true,
  'xdc_gd_price': true,
  'eth_gd_total_supply': true,
  'fuse_gd_in_circulation': true,
  'celo_gd_in_circulation': true
};

/** Metrics that may legitimately be negative — skip the negative check. */
var ALLOW_NEGATIVE_METRICS = {
  'gd_price_spread': true,
  'xdc_reserve_growth_abs': true
};

/**
 * Audit the facts sheet end-to-end and email a summary if any problems
 * are found. Wire to a daily trigger.
 */
function auditFactsSheet() {
  Logger.log('===== auditFactsSheet =====');
  ensureSheets();
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  const health = ss.getSheetByName(CONFIG.SHEET_HEALTH);

  const lastRow = facts.getLastRow();
  if (lastRow < 2) {
    Logger.log('  facts sheet empty');
    writeAuditHealthRow('ok', 0, '');
    return;
  }

  // Read columns A-D only (date, chain, metric_key, value)
  const data = facts.getRange(2, 1, lastRow - 1, 4).getValues();
  Logger.log('  scanning ' + data.length + ' row(s)');

  // Pass 1: build per-key occurrence count and per-(chain,metric) timeseries
  const occurrenceCount = {};            // "date|chain|metric" → count
  const seriesByCM = {};                 // "chain|metric" → { ymd: value }
  const minByCM = {};
  const maxByCM = {};
  const invalidRows = [];                // {ymd, chain, metric, value, reason}

  for (var i = 0; i < data.length; i++) {
    const ymd = toYMD(data[i][0]);
    const chain = data[i][1];
    const metric = data[i][2];
    const rawVal = data[i][3];
    if (!ymd || !chain || !metric) continue;

    const key = ymd + '|' + chain + '|' + metric;
    occurrenceCount[key] = (occurrenceCount[key] || 0) + 1;

    const cm = chain + '|' + metric;
    if (!seriesByCM[cm]) seriesByCM[cm] = {};
    seriesByCM[cm][ymd] = rawVal;
    if (!minByCM[cm] || ymd < minByCM[cm]) minByCM[cm] = ymd;
    if (!maxByCM[cm] || ymd > maxByCM[cm]) maxByCM[cm] = ymd;

    // Invalid data check
    const v = Number(rawVal);
    if (rawVal === '' || rawVal == null) {
      invalidRows.push({ ymd: ymd, chain: chain, metric: metric, value: rawVal, reason: 'empty/null value' });
    } else if (!isFinite(v)) {
      invalidRows.push({ ymd: ymd, chain: chain, metric: metric, value: rawVal, reason: 'NaN or non-numeric' });
    } else if (v < 0 && !ALLOW_NEGATIVE_METRICS[metric]) {
      invalidRows.push({ ymd: ymd, chain: chain, metric: metric, value: v, reason: 'negative value not allowed' });
    } else if (v === 0 && NEVER_ZERO_METRICS[metric]) {
      invalidRows.push({ ymd: ymd, chain: chain, metric: metric, value: 0, reason: 'zero value not allowed for this metric' });
    }
  }

  // Pass 2: tally duplicates
  const duplicates = [];
  Object.keys(occurrenceCount).forEach(function(k) {
    if (occurrenceCount[k] > 1) duplicates.push({ key: k, count: occurrenceCount[k] });
  });

  // Pass 3: tally gaps within each (chain, metric) range
  const gaps = [];
  Object.keys(seriesByCM).forEach(function(cm) {
    const series = seriesByCM[cm];
    var d = minByCM[cm];
    while (d <= maxByCM[cm]) {
      if (series[d] == null) gaps.push({ cm: cm, ymd: d });
      d = addDays(d, 1);
    }
  });

  // Pass 4: spike detection — for each (chain, metric), compare LATEST
  // value to the most recent prior value in the series (which may not
  // be exactly latest - 1 day if there's a gap). We only check the
  // latest transition since audit runs daily — older spikes were
  // already flagged in previous runs.
  const spikes = [];
  Object.keys(seriesByCM).forEach(function(cm) {
    const parts = cm.split('|');
    const chain = parts[0];
    const metric = parts[1];
    if (SPIKE_SIGNED_METRICS[metric]) return;

    const series = seriesByCM[cm];
    const latestYMD = maxByCM[cm];
    const today = Number(series[latestYMD]);
    if (!isFinite(today)) return;

    // Walk back day-by-day from latest-1 until we find a value or hit
    // the metric's earliest date. Cap at 30 days to bound the loop.
    var prevYMD = null;
    var prevVal = null;
    var probe = addDays(latestYMD, -1);
    var hops = 0;
    while (probe >= minByCM[cm] && hops < 30) {
      if (series[probe] != null && series[probe] !== '') {
        const candidate = Number(series[probe]);
        if (isFinite(candidate)) { prevYMD = probe; prevVal = candidate; break; }
      }
      probe = addDays(probe, -1);
      hops++;
    }
    if (prevYMD == null) return; // no prior value to compare against

    // Handle 0 → X separately (avoid divide-by-zero)
    if (prevVal === 0) {
      if (today !== 0 && shouldFlagZeroToX(metric, today)) {
        spikes.push({
          cm: cm, chain: chain, metric: metric,
          yest: 0, today: today, ymd: latestYMD, prevYMD: prevYMD,
          pctChange: null,
          note: '0 → ' + today
        });
      }
      return;
    }

    const pctChange = Math.abs(today - prevVal) / Math.abs(prevVal);
    if (pctChange < SPIKE_THRESHOLD) return;

    // Apply noise filters
    if (isNoiseSpike(metric, today, prevVal)) return;

    spikes.push({
      cm: cm, chain: chain, metric: metric,
      yest: prevVal, today: today, ymd: latestYMD, prevYMD: prevYMD,
      pctChange: pctChange,
      note: (today > prevVal ? '+' : '-') + (pctChange * 100).toFixed(0) + '%'
    });
  });

  // Summarize
  const totalProblems = duplicates.length + gaps.length + invalidRows.length + spikes.length;
  Logger.log('  duplicates: ' + duplicates.length);
  Logger.log('  gaps:       ' + gaps.length);
  Logger.log('  invalid:    ' + invalidRows.length);
  Logger.log('  spikes:     ' + spikes.length);

  // Write Health row regardless
  const status = (totalProblems === 0) ? 'ok' : 'error';
  const summary = 'dup=' + duplicates.length + ' gap=' + gaps.length +
                  ' inv=' + invalidRows.length + ' spike=' + spikes.length;
  writeAuditHealthRow(status, data.length, totalProblems > 0 ? summary : '');

  // Email if there's anything to report
  if (totalProblems > 0) {
    sendAuditEmail(duplicates, gaps, invalidRows, spikes, data.length);
    Logger.log('  email sent to ' + AUDIT_EMAIL);
  } else {
    Logger.log('  no problems — no email sent');
  }
  Logger.log('===== auditFactsSheet done =====');
}

/**
 * Spike noise filter — returns true if this spike should be ignored.
 *
 * Counts (decimals=0): ignore if both today and yesterday < 100.
 * G$ amounts (anything with 'gd_amount', 'amount_paid', 'gd_claimed',
 *   'gd_in_circulation', 'gd_minted', 'amount_returned', 'reserve_in/out/volume'):
 *   ignore if both < 10,000 G$.
 * Everything else (including all prices): always check.
 */
function isNoiseSpike(metric, today, yest) {
  const spec = METRICS[metric] || {};
  const dp = (typeof spec.decimals === 'number') ? spec.decimals : 2;

  // Counts: ignore small-number noise
  if (dp === 0 && Math.abs(today) < 100 && Math.abs(yest) < 100) return true;

  // G$ amounts: ignore noise below 10k G$
  if (isGdAmountMetric(metric) && Math.abs(today) < 10000 && Math.abs(yest) < 10000) return true;

  return false;
}

/** Same noise filter for the 0 → X case. */
function shouldFlagZeroToX(metric, today) {
  const spec = METRICS[metric] || {};
  const dp = (typeof spec.decimals === 'number') ? spec.decimals : 2;
  if (dp === 0 && Math.abs(today) < 100) return false;
  if (isGdAmountMetric(metric) && Math.abs(today) < 10000) return false;
  return true;
}

/** Heuristic: does this metric represent a G$ amount? */
function isGdAmountMetric(metric) {
  return /gd_amount|amount_paid|gd_claimed|gd_in_circulation|gd_minted|amount_returned|reserve_in|reserve_out|reserve_volume|gd_total_supply|gd_frozen_supply|gd_per_user/.test(metric);
}

/**
 * Build and send the audit summary email. Plain text, easy to scan
 * on mobile. Sections only appear if they have content.
 */
function sendAuditEmail(duplicates, gaps, invalidRows, spikes, totalRows) {
  const ts = nowIso();
  var subject = '[GoodDollar Dashboard] Audit alert: ';
  const subjectParts = [];
  if (duplicates.length) subjectParts.push(duplicates.length + ' dup');
  if (gaps.length)       subjectParts.push(gaps.length + ' gap');
  if (invalidRows.length) subjectParts.push(invalidRows.length + ' invalid');
  if (spikes.length)     subjectParts.push(spikes.length + ' spike');
  subject += subjectParts.join(', ');

  var body = '';
  body += 'Daily Facts integrity audit — ' + ts + '\n';
  body += 'Spreadsheet: https://docs.google.com/spreadsheets/d/' + CONFIG.DEST_SPREADSHEET_ID + '/\n';
  body += 'Total rows scanned: ' + totalRows + '\n';
  body += '\n';
  body += '---------------------------------------------------------\n';
  body += 'SUMMARY\n';
  body += '  Duplicates:    ' + duplicates.length + '\n';
  body += '  Gaps:          ' + gaps.length + '\n';
  body += '  Invalid data:  ' + invalidRows.length + '\n';
  body += '  Spikes >100%:  ' + spikes.length + '\n';
  body += '---------------------------------------------------------\n\n';

  if (duplicates.length) {
    body += 'DUPLICATES (' + duplicates.length + ')\n';
    body += '  Same (date, chain, metric_key) appearing more than once.\n';
    body += '  Run dedupeFactsSheet() in the dev script to clean.\n\n';
    const showD = Math.min(duplicates.length, 50);
    for (var i = 0; i < showD; i++) {
      body += '  ' + duplicates[i].key + '  (×' + duplicates[i].count + ')\n';
    }
    if (duplicates.length > 50) body += '  ... and ' + (duplicates.length - 50) + ' more\n';
    body += '\n';
  }

  if (gaps.length) {
    body += 'GAPS (' + gaps.length + ')\n';
    body += '  Missing days within an active metric range.\n';
    body += '  Use backfillRange(since, until) to fill.\n\n';
    // Group gaps by metric so the email is scannable
    const byMetric = {};
    for (var g = 0; g < gaps.length; g++) {
      const k = gaps[g].cm;
      if (!byMetric[k]) byMetric[k] = [];
      byMetric[k].push(gaps[g].ymd);
    }
    const metricKeys = Object.keys(byMetric).sort();
    for (var m = 0; m < metricKeys.length; m++) {
      const dates = byMetric[metricKeys[m]];
      body += '  ' + metricKeys[m] + ' (' + dates.length + ' day(s)):\n';
      const showG = Math.min(dates.length, 10);
      for (var dd = 0; dd < showG; dd++) body += '    - ' + dates[dd] + '\n';
      if (dates.length > 10) body += '    ... and ' + (dates.length - 10) + ' more\n';
    }
    body += '\n';
  }

  if (invalidRows.length) {
    body += 'INVALID DATA (' + invalidRows.length + ')\n';
    body += '  Rows with NaN, null, illegal negative, or illegal zero values.\n\n';
    const showI = Math.min(invalidRows.length, 50);
    for (var ii = 0; ii < showI; ii++) {
      const r = invalidRows[ii];
      body += '  ' + r.ymd + ' | ' + r.chain + ' | ' + r.metric +
              ' = ' + r.value + '   [' + r.reason + ']\n';
    }
    if (invalidRows.length > 50) body += '  ... and ' + (invalidRows.length - 50) + ' more\n';
    body += '\n';
  }

  if (spikes.length) {
    body += 'SPIKES (' + spikes.length + ')\n';
    body += '  Day-over-day value change >' + (SPIKE_THRESHOLD * 100) + '%.\n';
    body += '  Could indicate a real event, a bug, or bad source data.\n\n';
    // Sort by absolute pctChange descending, with 0→X spikes at the end
    spikes.sort(function(a, b) {
      const aP = (a.pctChange == null) ? -1 : a.pctChange;
      const bP = (b.pctChange == null) ? -1 : b.pctChange;
      return bP - aP;
    });
    for (var s = 0; s < spikes.length; s++) {
      const sp = spikes[s];
      body += '  ' + sp.ymd + ' | ' + sp.chain + ' | ' + sp.metric +
              '   ' + sp.yest + ' → ' + sp.today + '   [' + sp.note + ']\n';
    }
    body += '\n';
  }

  body += '---\n';
  body += 'This email is sent only when problems are detected. A clean run\n';
  body += 'sends nothing. To stop these emails, change AUDIT_EMAIL in dev_v5.gs\n';
  body += 'or remove the trigger for auditFactsSheet().\n';

  MailApp.sendEmail({
    to: AUDIT_EMAIL,
    subject: subject,
    body: body
  });
}

/** Internal helper to write the AUDIT row to the Health Runs sheet. */
function writeAuditHealthRow(status, rowsScanned, errorMsg) {
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const health = ss.getSheetByName(CONFIG.SHEET_HEALTH);
  health.insertRowsAfter(1, 1);
  health.getRange(2, 1, 1, 9).setValues([[
    generateRunId(), nowIso(), 'AUDIT', '*', '*', status,
    rowsScanned, 0, errorMsg || ''
  ]]);
}


/***** =========================================
 * 5) AUDIT TOOLS (read-only)
 * =========================================*/

/**
 * Scan the Daily Facts sheet and report which (chain, metric_key) combinations
 * are missing dates in the given range. Logs a summary per metric showing the
 * first missing date and total missing count. Run this to know what to backfill.
 *
 * Usage: auditGaps('2025-11-12', '2026-05-21')
 *
 * XDC metrics are only expected from CONFIG.XDC_GENESIS onwards. Supply/SupplyComputed
 * metrics (eth, fuse, celo, agg) are only expected for the last ~90 days since the
 * APIs only return current state and historical fills are not possible.
 */
function auditGaps(sinceYMD, untilYMD) {
  sinceYMD  = sinceYMD  || CONFIG.XDC_GENESIS;
  untilYMD  = untilYMD  || getYesterdayYMD();
  Logger.log('auditGaps: scanning ' + sinceYMD + ' .. ' + untilYMD);

  var ss    = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  var lastRow = facts.getLastRow();
  if (lastRow < 2) { Logger.log('auditGaps: sheet is empty'); return; }

  var t0   = Date.now();
  var data = facts.getRange(2, 1, lastRow - 1, 3).getValues(); // date, chain, metric_key
  Logger.log('auditGaps: read ' + data.length + ' rows in ' + (Date.now() - t0) + 'ms');

  // Build index of what we have: "date|chain|metric" → true
  var have = {};
  for (var i = 0; i < data.length; i++) {
    var ymd = toYMD(data[i][0]);
    if (!ymd || !data[i][1] || !data[i][2]) continue;
    if (ymd < sinceYMD || ymd > untilYMD) continue;
    have[ymd + '|' + data[i][1] + '|' + data[i][2]] = true;
  }

  // Build expected date list
  var dates = [];
  var d = sinceYMD;
  while (d <= untilYMD) { dates.push(d); d = addDays(d, 1); }

  // Supply adapters only return current state — skip historical gap checks for those
  var supplySkip = {
    eth_gd_total_supply: true, eth_gd_frozen_supply: true,
    eth_gd_in_circulation: true, fuse_gd_in_circulation: true,
    celo_gd_in_circulation: true, agg_gd_in_circulation: true,
  };

  // Check each METRICS entry
  var totalMissing = 0;
  var metricKeys = Object.keys(METRICS).sort();
  for (var m = 0; m < metricKeys.length; m++) {
    var key  = metricKeys[m];
    var spec = METRICS[key];
    if (supplySkip[key]) continue; // supply APIs can't backfill history

    var chains = spec.chains || [];
    for (var c = 0; c < chains.length; c++) {
      var chain = chains[c];
      // XDC metrics only expected from genesis
      var effectiveSince = (chain === 'XDC') ? (sinceYMD < CONFIG.XDC_GENESIS ? CONFIG.XDC_GENESIS : sinceYMD) : sinceYMD;

      var missing = [];
      for (var di = 0; di < dates.length; di++) {
        if (dates[di] < effectiveSince) continue;
        if (!have[dates[di] + '|' + chain + '|' + key]) {
          missing.push(dates[di]);
        }
      }
      if (missing.length > 0) {
        totalMissing += missing.length;
        Logger.log('  MISSING ' + chain + '|' + key + ': ' + missing.length + ' date(s)'
          + '  first=' + missing[0] + '  last=' + missing[missing.length - 1]);
      }
    }

    // Check AGG rows for aggregate metrics
    if (spec.aggregate) {
      var aggMissing = [];
      for (var di = 0; di < dates.length; di++) {
        if (!have[dates[di] + '|AGG|' + key]) aggMissing.push(dates[di]);
      }
      if (aggMissing.length > 0) {
        totalMissing += aggMissing.length;
        Logger.log('  MISSING AGG|' + key + ': ' + aggMissing.length + ' date(s)'
          + '  first=' + aggMissing[0] + '  last=' + aggMissing[aggMissing.length - 1]);
      }
    }
  }

  Logger.log('auditGaps done: ' + totalMissing + ' missing (chain, metric, date) combination(s) in '
    + (Date.now() - t0) + 'ms');
  if (totalMissing === 0) Logger.log('  ✅ No gaps found in ' + sinceYMD + ' .. ' + untilYMD);
}


/***** =========================================
 * 5) XDC INVITES ONE-SHOT TOOLS (writes)
 * =========================================*/

/**
 * Reset the Hypersync cursor to the genesis block. On the next
 * smartBackfill() run, the ingest step will re-sweep every invite
 * event from genesis.
 *
 * Raw sheet dedup (by tx_hash + log_index) prevents duplicate rows
 * from being appended, so this is safe even if you've already got
 * partial data.
 *
 * Use this if you ever suspect the raw sheet is missing events —
 * e.g. after a long Hypersync outage or if the cursor got corrupted.
 */
function resetXdcInvitesCursor() {
  const props = PropertiesService.getScriptProperties();
  const oldCursor = props.getProperty(XDC_INVITES_CFG.PROP_LAST_BLOCK);
  props.setProperty(XDC_INVITES_CFG.PROP_LAST_BLOCK, String(XDC_INVITES_CFG.GENESIS_BLOCK));
  Logger.log('cursor reset: ' + oldCursor + ' → ' + XDC_INVITES_CFG.GENESIS_BLOCK);
  Logger.log('Run smartBackfill() next to re-sweep from genesis. Raw sheet dedup will prevent duplicates.');
}

/**
 * Clear the cached campaign owner address so the next run resolves it
 * fresh via codeToUser(GOODXDC). Use this if the campaign code is ever
 * reassigned to a different address on-chain.
 */
function resetXdcInvitesCampaignOwner() {
  const props = PropertiesService.getScriptProperties();
  const old = props.getProperty(XDC_INVITES_CFG.PROP_CAMPAIGN_OWNER);
  props.deleteProperty(XDC_INVITES_CFG.PROP_CAMPAIGN_OWNER);
  Logger.log('campaign owner cleared (was: ' + old + '). Next run will re-resolve via RPC.');
}

/**
 * Re-classify every InviteeJoined row in the raw sheet based on the
 * CURRENT campaign owner and the current classification rules:
 *
 *   inviter == resolved campaign owner  → 'campaign_code'
 *   inviter == 0x000...000                → 'no_code'
 *   otherwise                            → 'referral'
 *
 * Use this after:
 *  - The campaign owner address has been resolved for the first time
 *    (before that, campaign joins were misclassified as referral).
 *  - The campaign code is reassigned to a different address.
 *
 * Only touches rows where the current label doesn't match, so
 * re-running is a no-op. Logs before/after tallies for sanity checking.
 * Does NOT touch InviterBounty rows (their invite_type is always blank).
 *
 * After running this, the xdc_invites_* metrics in the facts sheet will
 * be out of date. Either:
 *   (a) delete the affected invite rows from Daily Facts and run
 *       smartBackfill(), or
 *   (b) call rebuildXdcInvitesFactsRows() below for a targeted rewrite.
 */
function xdcInvitesRelabelHistoricalRaw() {
  Logger.log('=== xdcInvitesRelabelHistoricalRaw ===');
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(XDC_INVITES_CFG.SHEET_RAW);
  if (!sheet) { Logger.log('  raw sheet does not exist'); return; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('  raw sheet is empty'); return; }

  const campaignOwner = xdcInvitesGetCampaignOwner();
  Logger.log('  campaign owner: ' + (campaignOwner || '<unresolved>'));

  const ZERO = '0x0000000000000000000000000000000000000000';

  // Read cols F (event), G (inviter), H (invitee), I (invite_type)
  const range = sheet.getRange(2, 6, lastRow - 1, 4);
  const values = range.getValues();

  const before = { campaign_code: 0, referral: 0, no_code: 0, other: 0 };
  const after  = { campaign_code: 0, referral: 0, no_code: 0, other: 0 };
  var rewritten = 0;

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) !== 'InviteeJoined') continue;
    const inviter = String(values[i][1] || '').toLowerCase();
    const current = String(values[i][3] || '');

    if      (current === 'campaign_code') before.campaign_code++;
    else if (current === 'referral')      before.referral++;
    else if (current === 'no_code')       before.no_code++;
    else                                  before.other++;

    var expected;
    if (campaignOwner && inviter === campaignOwner.toLowerCase()) expected = 'campaign_code';
    else if (inviter === ZERO)                                    expected = 'no_code';
    else                                                          expected = 'referral';

    if (current !== expected) {
      values[i][3] = expected;
      rewritten++;
    }

    if      (expected === 'campaign_code') after.campaign_code++;
    else if (expected === 'referral')      after.referral++;
    else if (expected === 'no_code')       after.no_code++;
    else                                   after.other++;
  }

  Logger.log('  before: ' + JSON.stringify(before));
  Logger.log('  after:  ' + JSON.stringify(after));
  Logger.log('  rewriting ' + rewritten + ' row(s)');
  if (rewritten > 0) range.setValues(values);
  Logger.log('=== done — now delete stale xdc_invites_* rows from Daily Facts and run smartBackfill() ===');
}

/**
 * One-shot: re-fetch G$ Transfer logs for the entire block range
 * covered by the existing raw sheet, join them to InviterBounty rows
 * by tx_hash, and rewrite the payment columns (inviter_paid_g,
 * invitee_paid_g, campaign_returned_g, total_paid_g) for every bounty row.
 *
 * Use this after a bug fix in enrichBountyWithTransfers() or after the
 * Q1 campaign-code trace shape is confirmed and the code is updated.
 * Safe to re-run — it overwrites the same cells idempotently.
 *
 * Note: may hit the Hypersync time budget if the block range is large.
 * Re-run until it logs "reached tip".
 */
function backfillXdcInvitesBountyTransfers() {
  Logger.log('=== backfillXdcInvitesBountyTransfers ===');
  ensureSheets();
  xdcInvitesEnsureRawSheet();

  const raw = xdcInvitesReadRaw();
  if (!raw.length) { Logger.log('  raw sheet empty'); return; }

  // Find block range of bounty rows
  const bountyRecords = [];
  var minBlock = Infinity, maxBlock = -Infinity;
  for (var i = 0; i < raw.length; i++) {
    if (raw[i].event !== 'InviterBounty') continue;
    bountyRecords.push(raw[i]);
    if (raw[i].block_number < minBlock) minBlock = raw[i].block_number;
    if (raw[i].block_number > maxBlock) maxBlock = raw[i].block_number;
  }
  if (!bountyRecords.length) { Logger.log('  no bounty rows'); return; }
  Logger.log('  ' + bountyRecords.length + ' bounty rows; block range [' + minBlock + ', ' + maxBlock + ']');

  const paddedInvitesContract = '0x' +
    XDC_INVITES_CFG.CONTRACT.replace(/^0x/, '').toLowerCase().padStart(64, '0');

  const sweep = hypersyncFetchLogs({
    fromBlock: minBlock,
    toBlock:   maxBlock,
    deadlineMs: Date.now() + XDC_INVITES_CFG.TIME_BUDGET_MS,
    logSelections: [{
      address: [XDC_INVITES_CFG.GD_TOKEN],
      topics: [
        [XDC_INVITES_CFG.TOPIC_TRANSFER],
        [paddedInvitesContract]
      ]
    }]
  });
  Logger.log('  fetched ' + sweep.logs.length + ' Transfer logs in ' + sweep.pages + ' page(s)' +
             (sweep.reachedTip ? ' (reached tip)' : ' (NOT at tip — re-run)'));

  const transferIndex = buildBountyTransferIndex(sweep.logs);

  // Rebuild by finding each bounty row in the sheet via (tx_hash, log_index).
  // We re-read the sheet to get row numbers.
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(XDC_INVITES_CFG.SHEET_RAW);
  const lastRow = sheet.getLastRow();
  const allRows = sheet.getRange(2, 1, lastRow - 1, XDC_INVITES_RAW_COLS).getValues();

  // Build tx_hash|log_index → sheet row number
  const rowMap = {};
  for (var r = 0; r < allRows.length; r++) {
    rowMap[String(allRows[r][3]) + '|' + Number(allRows[r][4])] = r + 2;
  }

  var updated = 0, unmatched = 0;
  const updates = []; // {row, vals:[inviter_paid, invitee_paid, campaign_returned, total_paid]}
  for (var b = 0; b < bountyRecords.length; b++) {
    const rec = bountyRecords[b];
    const transfers = transferIndex[rec.tx_hash];
    if (!transfers || !transfers.length) { unmatched++; continue; }

    var inviterPaid = 0, inviteePaid = 0, totalPaid = 0;
    for (var t = 0; t < transfers.length; t++) {
      totalPaid += transfers[t].amount;
      if      (transfers[t].to === rec.inviter) inviterPaid += transfers[t].amount;
      else if (transfers[t].to === rec.invitee) inviteePaid += transfers[t].amount;
    }
    const campaignReturned = Math.max(0, totalPaid - inviterPaid - inviteePaid);

    const sheetRow = rowMap[rec.tx_hash + '|' + rec.log_index];
    if (!sheetRow) { unmatched++; continue; }
    updates.push({ row: sheetRow, vals: [inviterPaid, inviteePaid, campaignReturned, totalPaid] });
    updated++;
  }

  // Write updates (cols 10-13 = inviter_paid, invitee_paid, campaign_returned, total_paid)
  updates.sort(function(a, b) { return a.row - b.row; });
  for (var u = 0; u < updates.length; u++) {
    sheet.getRange(updates[u].row, 10, 1, 4).setValues([updates[u].vals]);
  }

  Logger.log('  enriched ' + updated + ' bounty rows, ' + unmatched + ' unmatched');
  Logger.log('=== done — run smartBackfill() to recompute aggregate metrics ===');
}

/**
 * Delete every xdc_invites_* row from Daily Facts. The next
 * smartBackfill() run will recompute and re-append them from the raw
 * sheet.
 *
 * Use this after xdcInvitesRelabelHistoricalRaw() or
 * backfillXdcInvitesBountyTransfers() to force a clean rebuild of the
 * aggregate metrics. Backs up the facts sheet first.
 */
function wipeXdcInvitesFactsRows() {
  Logger.log('=== wipeXdcInvitesFactsRows ===');
  ensureSheets();
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  const lastRow = facts.getLastRow();
  if (lastRow < 2) { Logger.log('  facts sheet empty'); return; }

  // Build the set of metric keys to drop
  const drops = {};
  for (var k = 0; k < XDC_INVITES_METRIC_KEYS.length; k++) drops[XDC_INVITES_METRIC_KEYS[k]] = true;

  // Scan col C for metric_key matches
  const metrics = facts.getRange(2, 3, lastRow - 1, 1).getValues();
  const rowsToDelete = [];
  for (var i = 0; i < metrics.length; i++) {
    if (drops[String(metrics[i][0])]) rowsToDelete.push(i + 2);
  }

  if (!rowsToDelete.length) {
    Logger.log('  no xdc_invites_* rows found in facts sheet');
    return;
  }

  // Backup first
  const backupName = 'Daily Facts BACKUP ' + generateRunId();
  facts.copyTo(ss).setName(backupName);
  Logger.log('  backup created: ' + backupName);

  // Delete bottom-up, grouped
  rowsToDelete.sort(function(a, b) { return b - a; });
  var ii = 0, deleted = 0;
  while (ii < rowsToDelete.length) {
    var end = rowsToDelete[ii];
    var start = end;
    var jj = ii + 1;
    while (jj < rowsToDelete.length && rowsToDelete[jj] === start - 1) {
      start = rowsToDelete[jj];
      jj++;
    }
    facts.deleteRows(start, end - start + 1);
    deleted += (end - start + 1);
    ii = jj;
  }
  Logger.log('  deleted ' + deleted + ' xdc_invites_* row(s)');
  Logger.log('=== done — run smartBackfill() next to recompute ===');
}


/***** =========================================
 * 6) XDC INVITES INSPECTORS (safe, no writes)
 * =========================================*/

/**
 * Log the current Hypersync cursor, campaign owner, and the tail of
 * the raw sheet. Use this to confirm the pipeline is advancing and
 * data looks sane.
 */
function testXdcInvitesStatus() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('=== testXdcInvitesStatus ===');
  Logger.log('  cursor (last_block):  ' + (props.getProperty(XDC_INVITES_CFG.PROP_LAST_BLOCK) || '<unset>'));
  Logger.log('  campaign owner:       ' + (props.getProperty(XDC_INVITES_CFG.PROP_CAMPAIGN_OWNER) || '<unresolved>'));
  Logger.log('  hypersync token set:  ' + (props.getProperty(XDC_INVITES_CFG.PROP_HYPERSYNC_TOKEN) ? 'yes' : 'NO'));

  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const raw = ss.getSheetByName(XDC_INVITES_CFG.SHEET_RAW);
  if (!raw) { Logger.log('  raw sheet: does not exist'); return; }
  const lastRow = raw.getLastRow();
  Logger.log('  raw sheet rows:       ' + (lastRow - 1));

  if (lastRow > 1) {
    const showN = Math.min(5, lastRow - 1);
    const tail = raw.getRange(lastRow - showN + 1, 1, showN, XDC_INVITES_RAW_COLS).getValues();
    Logger.log('  last ' + showN + ' row(s):');
    for (var i = 0; i < tail.length; i++) {
      Logger.log('    ' + tail[i].slice(0, 9).join(' | '));
    }
  }
}

/**
 * Resolve the GOODXDC campaign owner via on-chain RPC and log it.
 * Reads from cache if already resolved.
 */
function testXdcInvitesCampaignOwner() {
  Logger.log('=== testXdcInvitesCampaignOwner ===');
  const owner = xdcInvitesGetCampaignOwner();
  Logger.log('  campaign owner: ' + (owner || '<unresolved>'));
  if (!owner) {
    Logger.log('  (either GOODXDC not registered yet, or RPC call failed)');
  }
}

/**
 * Verify the Transfer-join logic against the known example tx from the
 * spec (0xc511a8f4...). Expected: inviter_paid=1000, invitee_paid=500,
 * total=1500. No writes.
 */
function testXdcInvitesTransferJoin() {
  Logger.log('=== testXdcInvitesTransferJoin ===');
  const knownTx = '0xc511a8f4c9b81185e5568efe4bba354be281bdf5432a2a78445f43b47630e12e';
  const knownBlock = 101178843;

  const paddedInvitesContract = '0x' +
    XDC_INVITES_CFG.CONTRACT.replace(/^0x/, '').toLowerCase().padStart(64, '0');

  const sweep = hypersyncFetchLogs({
    fromBlock: knownBlock,
    toBlock:   knownBlock,
    maxPages:  3,
    logSelections: [{
      address: [XDC_INVITES_CFG.GD_TOKEN],
      topics: [
        [XDC_INVITES_CFG.TOPIC_TRANSFER],
        [paddedInvitesContract]
      ]
    }]
  });
  Logger.log('  found ' + sweep.logs.length + ' Transfer log(s)');
  const idx = buildBountyTransferIndex(sweep.logs);
  const txTransfers = idx[knownTx] || [];
  Logger.log('  transfers in target tx: ' + txTransfers.length);

  var total = 0;
  for (var i = 0; i < txTransfers.length; i++) {
    Logger.log('    → ' + txTransfers[i].to + ' for ' + txTransfers[i].amount + ' G$');
    total += txTransfers[i].amount;
  }
  Logger.log('  total: ' + total + ' G$ (expected 1500)');
  Logger.log((Math.abs(total - 1500) < 0.01) ? '  ✓ matches' : '  ✗ MISMATCH — investigate');
}

/**
 * Parse a synthetic InviterBounty log and verify the parser. Does not
 * hit the network.
 */
function testXdcInvitesParseSample() {
  Logger.log('=== testXdcInvitesParseSample ===');
  const sampleLog = {
    block_number: 101178843,
    transaction_hash: '0xc511a8f4c9b81185e5568efe4bba354be281bdf5432a2a78445f43b47630e12e',
    log_index: 0,
    topic0: XDC_INVITES_CFG.TOPIC_INVITER_BOUNTY,
    topic1: '0x000000000000000000000000d135c7e4593412156def2c1db3ba8d64da5b0257',
    topic2: '0x000000000000000000000000fab243c5000000000000000000000000fb416710',
    data:   '0x0000000000000000000000000000000000000000000000056bc75e2d63100000'
  };
  const blocks = {};
  blocks[101178843] = Math.floor(new Date('2026-04-06T12:10:24Z').getTime() / 1000);
  const parsed = parseInviterBounty(sampleLog, blocks);
  Logger.log('  parsed: ' + JSON.stringify(parsed));
  if (parsed && parsed.inviter && parsed.invitee && parsed.event === 'InviterBounty') {
    Logger.log('  ✓ parser OK');
  } else {
    Logger.log('  ✗ parser failed');
  }
}

/**
 * Show summary stats about the raw sheet: event counts by type, date
 * range, unique addresses.
 */
function testXdcInvitesRawStats() {
  Logger.log('=== testXdcInvitesRawStats ===');
  const raw = xdcInvitesReadRaw();
  if (!raw.length) { Logger.log('  raw sheet empty'); return; }

  var joins = 0, bounties = 0;
  var referral = 0, campaign = 0, nocode = 0;
  var firstDate = null, lastDate = null;
  const inviters = {}, invitees = {};
  var totalPaid = 0;

  for (var i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r.date && (!firstDate || r.date < firstDate)) firstDate = r.date;
    if (r.date && (!lastDate  || r.date > lastDate))  lastDate = r.date;

    if (r.event === 'InviteeJoined') {
      joins++;
      if      (r.invite_type === 'referral')      referral++;
      else if (r.invite_type === 'campaign_code') campaign++;
      else if (r.invite_type === 'no_code')       nocode++;
    } else if (r.event === 'InviterBounty') {
      bounties++;
      if (r.inviter_paid_g > 0) inviters[r.inviter] = true;
      if (r.invitee_paid_g > 0) invitees[r.invitee] = true;
      totalPaid += r.total_paid_g || 0;
    }
  }

  Logger.log('  total rows:          ' + raw.length);
  Logger.log('  date range:          ' + firstDate + ' .. ' + lastDate);
  Logger.log('  InviteeJoined:       ' + joins + ' (referral=' + referral +
             ', campaign=' + campaign + ', nocode=' + nocode + ')');
  Logger.log('  InviterBounty:       ' + bounties);
  Logger.log('  unique paid inviters: ' + Object.keys(inviters).length);
  Logger.log('  unique paid invitees: ' + Object.keys(invitees).length);
  Logger.log('  total G$ paid:       ' + totalPaid.toFixed(2));
}


/***** =========================================
 * 7) XDC INVITES PROFILE SHEET
 * =========================================
 *
 * Per-inviter cross-section sheet. Rebuilt from raw events. Useful for
 * identifying top inviters and auditing campaign effectiveness.
 *
 * Columns:
 *   rank, inviter, total_invitees, campaign_invitees, referral_invitees,
 *   total_bounty_g, first_seen_date, last_seen_date
 *****/

var DEV_SHEET_INVITER_PROFILE = 'XDC Inviter Profile';

/**
 * Rebuild the XDC Inviter Profile sheet from scratch. Safe to re-run.
 * Wipes the existing sheet and rewrites it.
 */
function rebuildXdcInviterProfile() {
  Logger.log('=== rebuildXdcInviterProfile ===');
  const raw = xdcInvitesReadRaw();
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(DEV_SHEET_INVITER_PROFILE);
  if (!sheet) sheet = ss.insertSheet(DEV_SHEET_INVITER_PROFILE);

  const profiles = {}; // inviter → stats

  for (var i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (!r.inviter || r.inviter === '0x0000000000000000000000000000000000000000') continue;

    if (!profiles[r.inviter]) {
      profiles[r.inviter] = {
        inviter: r.inviter,
        total_invitees: 0,
        campaign_invitees: 0,
        referral_invitees: 0,
        total_bounty_g: 0,
        first_seen: r.date,
        last_seen: r.date
      };
    }
    const p = profiles[r.inviter];
    if (r.date && r.date < p.first_seen) p.first_seen = r.date;
    if (r.date && r.date > p.last_seen)  p.last_seen = r.date;

    if (r.event === 'InviteeJoined') {
      p.total_invitees++;
      if      (r.invite_type === 'campaign_code') p.campaign_invitees++;
      else if (r.invite_type === 'referral')      p.referral_invitees++;
    } else if (r.event === 'InviterBounty') {
      // Only count bounties where the inviter actually got paid
      p.total_bounty_g += r.inviter_paid_g || 0;
    }
  }

  const list = Object.keys(profiles).map(function(k) { return profiles[k]; });
  list.sort(function(a, b) {
    if (b.total_invitees !== a.total_invitees) return b.total_invitees - a.total_invitees;
    return b.total_bounty_g - a.total_bounty_g;
  });

  sheet.clearContents();
  const header = ['rank', 'inviter', 'total_invitees', 'campaign_invitees',
                  'referral_invitees', 'total_bounty_g', 'first_seen_date', 'last_seen_date'];
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.setFrozenRows(1);

  if (!list.length) {
    Logger.log('  no inviters yet');
    return;
  }

  const out = [];
  for (var r2 = 0; r2 < list.length; r2++) {
    const p = list[r2];
    out.push([
      r2 + 1, p.inviter, p.total_invitees, p.campaign_invitees,
      p.referral_invitees, p.total_bounty_g, p.first_seen, p.last_seen
    ]);
  }
  sheet.getRange(2, 1, out.length, out[0].length).setValues(out);

  // Summary stats for sanity checking
  const counts = list.map(function(p) { return p.total_invitees; }).sort(function(a, b) { return a - b; });
  const median = counts.length % 2
    ? counts[(counts.length - 1) / 2]
    : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2;
  const mean = counts.reduce(function(a, b) { return a + b; }, 0) / counts.length;
  Logger.log('  rebuilt: ' + list.length + ' inviters, mean=' + mean.toFixed(2) + ', median=' + median);
  Logger.log('=== done ===');
}


/***** =========================================
 * 8) PARTNERS SHEET REFRESHER
 * =========================================
 *
 * Pulls a flat table from a Dune query and writes it to the "Partners"
 * sheet. Not called by smartBackfill — run manually when the team needs
 * fresh partner data. The team only updates this every so often.
 *****/

function updatePartnersSheet() {
  Logger.log('=== updatePartnersSheet ===');
  try {
    const result = duneFetchTable(DEV_DUNE_PARTNERS_ID, 1000);
    if (!result.rows.length) {
      Logger.log('  no data returned from Dune');
      return;
    }

    const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(DEV_SHEET_PARTNERS);
    if (!sheet) sheet = ss.insertSheet(DEV_SHEET_PARTNERS);

    sheet.clearContents();
    sheet.getRange(1, 1, 1, result.cols.length).setValues([result.cols]);
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, result.rows.length, result.cols.length).setValues(result.rows);

    Logger.log('  wrote ' + result.rows.length + ' row(s) to "' + DEV_SHEET_PARTNERS + '"');
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
  Logger.log('=== done ===');
}


/***** =========================================
 * 9) HISTORICAL DATA REPAIR — V4 IMPORT + LEGACY CLEANUP
 * =========================================
 *
 * Three one-shot repair tools to bring the v5 Daily Facts sheet to a
 * clean state after the initial auditAndFillGaps run.
 *
 * Run in this order:
 *   1. importAndNormalizeFromV4()   — import missing/wrong historical data
 *   2. deleteV4LegacyRows()         — delete superseded old-format rows
 *   3. migrateFactsSheetSortAsc()   — sort everything ascending
 *   4. dedupeFactsSheet()           — remove duplicates (keeps newest updated_at)
 *   5. fillXdcReserveWindow()       — patch any remaining XDC reserve gaps
 *****/

/**
 * ONE-TIME: Import historical rows from the v4 production spreadsheet
 * and normalize them to v5 naming conventions.
 *
 * What it imports:
 *   • ALL metrics for Aug 14 – Nov 11, 2025 (pre-XDC era; v5 has nothing
 *     for those dates since auditAndFillGaps starts at XDC_GENESIS).
 *   • For Nov 12, 2025 – May 19, 2026: only the specific metrics that
 *     v5 either got wrong or skipped:
 *       - celo_gd_price   (v5 got 0 because the CELO reserve subgraph
 *                          pruned those historical swap events by May 2026;
 *                          v4 fetched prices in real-time when they existed)
 *       - celo_gd_in_circulation, fuse_gd_in_circulation, agg_gd_in_circulation
 *                         (v5 AUDIT_WRITE_SKIP — v4 fetched daily in real-time
 *                          so these are historically accurate)
 *       - xdc_reserve_liquidity_usd, xdc_reserve_backing_ratio,
 *         xdc_daily_gd_minted, xdc_reserve_growth_abs
 *                         (same: v5 AUDIT_WRITE_SKIP, v4 has real-time values)
 *
 * All imported rows get updated_at = now so that the subsequent
 * dedupeFactsSheet() call keeps these over any v5 stale 0-valued rows
 * for the same (date, chain, metric_key).
 *
 * What it skips:
 *   • gd_usd_price (legacy one-off key, not used in v5)
 *   • Any row dated > 2026-05-19 (smartBackfill owns those)
 *   • celo_gd_price rows where value = 0 (genuine data gap — importing
 *     a zero triggers the auditFactsSheet never-zero alert)
 */
function importAndNormalizeFromV4() {
  Logger.log('=== importAndNormalizeFromV4 ===');

  var V4_SS_ID  = '1vZoUwOi9EKAABqy6TIeW1XWdChwvDPL71YJWlwy5AXo';
  var V4_SHEET  = 'Daily Facts';
  var V4_UNTIL  = '2026-05-19';  // don't touch dates that smartBackfill already owns
  var PRE_XDC   = '2025-11-11';  // import ALL metrics for dates up to and including this

  // For the XDC era (Nov 12+), only import these specific metrics.
  // These are the ones v5 either got wrong (price) or was blocked from
  // writing (AUDIT_WRITE_SKIP supply and XDC reserve metrics).
  var POST_XDC_IMPORT = {
    'celo_gd_price':             true,
    'celo_gd_in_circulation':    true,
    'fuse_gd_in_circulation':    true,
    'agg_gd_in_circulation':     true,
    'xdc_reserve_liquidity_usd': true,
    'xdc_reserve_backing_ratio': true,
    'xdc_daily_gd_minted':       true,
    'xdc_reserve_growth_abs':    true
  };

  // Metric keys to skip entirely (no v5 equivalent)
  var SKIP_METRICS = { 'gd_usd_price': true };

  // Rename v4 old-format keys to v5 canonical keys
  var KEY_RENAME = {
    'celo_celo_reserve_in':          'celo_reserve_in',
    'celo_celo_reserve_out':         'celo_reserve_out',
    'celo_celo_reserve_volume':      'celo_reserve_volume',
    'celo_lifetime_claim_TXs':       'celo_lifetime_claim_txs',
    'agg_lifetime_claim_TXs':        'agg_lifetime_claim_txs',
    'agg_lifetime_unique_claim_TXs': 'agg_lifetime_unique_claim_txs'
  };

  // Rename v4 source labels to v5 canonical source labels
  var SOURCE_RENAME = { 'RESERVE_SUBGRAPH': 'CELO_RESERVE_SUBGRAPH' };

  // ── 1. Read v4 sheet ───────────────────────────────────────────────────
  var v4ss = SpreadsheetApp.openById(V4_SS_ID);
  var v4facts = v4ss.getSheetByName(V4_SHEET);
  if (!v4facts) { Logger.log('  ERROR: v4 sheet "' + V4_SHEET + '" not found'); return; }

  var v4lastRow = v4facts.getLastRow();
  if (v4lastRow < 2) { Logger.log('  v4 sheet is empty'); return; }

  Logger.log('  reading ' + (v4lastRow - 1) + ' rows from v4...');
  var v4data = v4facts.getRange(2, 1, v4lastRow - 1, 6).getValues();

  // ── 2. Normalize and filter ────────────────────────────────────────────
  var now = nowIso();
  var toAppend = [];
  var skipped = 0;

  for (var i = 0; i < v4data.length; i++) {
    var row   = v4data[i];
    var ymd   = toYMD(row[0]);
    var chain = String(row[1] || '').trim();
    var mk    = String(row[2] || '').trim();
    var val   = row[3];
    var src   = String(row[4] || '').trim();

    if (!ymd || !chain || !mk)  { skipped++; continue; }
    if (ymd > V4_UNTIL)          { skipped++; continue; }  // smartBackfill owns these
    if (SKIP_METRICS[mk])        { skipped++; continue; }  // legacy-only key

    // For the XDC era, only import the metrics listed above
    if (ymd > PRE_XDC && !POST_XDC_IMPORT[mk]) { skipped++; continue; }

    // celo_gd_price = 0 means "no data" — skip to avoid never-zero audit alert
    if (mk === 'celo_gd_price' && Number(val) === 0) { skipped++; continue; }

    // Normalize key and source to v5 conventions
    var normMk  = KEY_RENAME[mk]   || mk;
    var normSrc = SOURCE_RENAME[src] || src;

    toAppend.push([ymd, chain, normMk, val, normSrc, now]);
  }

  Logger.log('  ' + toAppend.length + ' rows to import, ' + skipped + ' skipped');
  if (!toAppend.length) { Logger.log('  nothing to import'); return; }

  // ── 3. Backup + append ─────────────────────────────────────────────────
  var destSS    = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var destFacts = destSS.getSheetByName(CONFIG.SHEET_FACTS);
  var backupName = 'Daily Facts BACKUP ' + generateRunId();
  destFacts.copyTo(destSS).setName(backupName);
  Logger.log('  backup created: ' + backupName);

  var destLastRow = destFacts.getLastRow();
  destFacts.getRange(destLastRow + 1, 1, toAppend.length, 6).setValues(toAppend);

  Logger.log('=== importAndNormalizeFromV4 done — appended ' + toAppend.length + ' rows ===');
  Logger.log('  Next steps: deleteV4LegacyRows() → migrateFactsSheetSortAsc() → dedupeFactsSheet()');
}


/**
 * Delete old-format v4 legacy rows from Daily Facts that are now
 * superseded by correctly-named rows (either from auditAndFillGaps or
 * from importAndNormalizeFromV4 above).
 *
 * Deletes:
 *   • celo_celo_reserve_{in,out,volume}  — double "celo_" prefix; v5 uses
 *                                          celo_reserve_{in,out,volume}
 *   • celo_lifetime_claim_TXs           — uppercase TXs; v5 uses _txs
 *   • agg_lifetime_claim_TXs            — same
 *   • agg_lifetime_unique_claim_TXs     — same
 *   • celo_gd_price rows where value=0 AND source='DUNE'
 *                                        — v4 garbage zeros; real price data
 *                                          is now present from the v4 import
 *
 * Creates a backup before deleting. Safe to re-run (idempotent).
 */
function deleteV4LegacyRows() {
  Logger.log('=== deleteV4LegacyRows ===');
  ensureSheets();

  // These metric keys are unconditionally deleted (wrong names, fully superseded)
  var DELETE_KEYS = {
    'celo_celo_reserve_in':          true,
    'celo_celo_reserve_out':         true,
    'celo_celo_reserve_volume':      true,
    'celo_lifetime_claim_TXs':       true,
    'agg_lifetime_claim_TXs':        true,
    'agg_lifetime_unique_claim_TXs': true
  };

  var ss      = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var facts   = ss.getSheetByName(CONFIG.SHEET_FACTS);
  var lastRow = facts.getLastRow();
  if (lastRow < 2) { Logger.log('  sheet is empty'); return; }

  // Read date(A), chain(B), metric_key(C), value(D), source(E)
  var data = facts.getRange(2, 1, lastRow - 1, 5).getValues();

  var rowsToDelete = [];
  for (var i = 0; i < data.length; i++) {
    var mk  = String(data[i][2] || '');
    var val = Number(data[i][3]);
    var src = String(data[i][4] || '').trim();
    if (!mk) continue;

    if (DELETE_KEYS[mk]) {
      rowsToDelete.push(i + 2);  // 1-indexed sheet row, offset for header
      continue;
    }

    // celo_gd_price = 0 from DUNE — v4 Dune query returned no data for those dates
    if (mk === 'celo_gd_price' && val === 0 && src === 'DUNE') {
      rowsToDelete.push(i + 2);
    }
  }

  if (!rowsToDelete.length) {
    Logger.log('  no legacy rows found — nothing to delete');
    return;
  }

  Logger.log('  found ' + rowsToDelete.length + ' legacy row(s) to delete');

  // Backup before any deletion
  var backupName = 'Daily Facts BACKUP ' + generateRunId();
  facts.copyTo(ss).setName(backupName);
  Logger.log('  backup created: ' + backupName);

  // Delete from bottom up, grouping consecutive row numbers into single API calls
  rowsToDelete.sort(function(a, b) { return b - a; });
  var ii = 0, deleted = 0;
  while (ii < rowsToDelete.length) {
    var end   = rowsToDelete[ii];
    var start = end;
    var jj    = ii + 1;
    while (jj < rowsToDelete.length && rowsToDelete[jj] === start - 1) {
      start = rowsToDelete[jj];
      jj++;
    }
    facts.deleteRows(start, end - start + 1);
    deleted += (end - start + 1);
    ii = jj;
  }

  Logger.log('  deleted ' + deleted + ' row(s)');
  Logger.log('=== deleteV4LegacyRows done — backup at "' + backupName + '" ===');
}


/**
 * Fill XDC reserve metrics for 2026-03-08 through yesterday.
 *
 * Run this AFTER importAndNormalizeFromV4() + dedupeFactsSheet(). It
 * only writes dates that are STILL missing (existing rows are skipped
 * via existingIndex). Its purpose is to patch any gaps that the v4
 * import did not cover (e.g. if a date was missing in v4 too), and to
 * also compute gd_price_spread (which v4 did not store).
 *
 * The XDC RPC returns the CURRENT on-chain reserve balance, which is
 * not historically accurate for past dates. Run importAndNormalizeFromV4
 * first to get the historically-accurate v4 daily values; this function
 * is only a safety net for remaining gaps.
 *
 * Writes only: xdc_reserve_liquidity_usd, xdc_reserve_backing_ratio,
 *              xdc_daily_gd_minted, xdc_reserve_growth_abs, gd_price_spread
 */
function fillXdcReserveWindow() {
  var SINCE      = CONFIG.XDC_RESERVE_SINCE;  // '2026-03-08'
  var UNTIL      = getYesterdayYMD();
  var CHUNK_DAYS = 14;
  var MAX_RUN_MS = 270000;
  var runStart   = Date.now();

  Logger.log('=== fillXdcReserveWindow ' + SINCE + ' .. ' + UNTIL + ' ===');

  var WRITE_ONLY = {
    'xdc_reserve_liquidity_usd': true,
    'xdc_reserve_backing_ratio': true,
    'xdc_daily_gd_minted':       true,
    'xdc_reserve_growth_abs':    true,
    'gd_price_spread':           true
  };

  // ── 1. Full sheet read ────────────────────────────────────────────────
  var ss      = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var facts   = ss.getSheetByName(CONFIG.SHEET_FACTS);
  var lastRow = facts.getLastRow();
  if (lastRow < 2) { Logger.log('  sheet is empty'); return; }

  var data = facts.getRange(2, 1, lastRow - 1, 5).getValues();
  var existingIndex = {}, factsValueIndex = {}, maxDates = {};
  for (var i = 0; i < data.length; i++) {
    var ymd = toYMD(data[i][0]), chain = data[i][1], mk = data[i][2];
    if (!ymd || !chain || !mk) continue;
    var key = ymd + '|' + chain + '|' + mk;
    existingIndex[key] = true;
    var v = Number(data[i][3]);
    factsValueIndex[key] = isFinite(v) ? v : null;
    var cm = chain + '|' + mk;
    if (!maxDates[cm] || ymd > maxDates[cm]) maxDates[cm] = ymd;
  }
  var indexResult = { existingIndex: existingIndex, factsValueIndex: factsValueIndex, maxDates: maxDates };

  // ── 2. Count remaining gaps ───────────────────────────────────────────
  var dates = [], d = SINCE;
  while (d <= UNTIL) { dates.push(d); d = addDays(d, 1); }

  var metrics = Object.keys(WRITE_ONLY);
  var missing = 0;
  for (var m = 0; m < metrics.length; m++) {
    for (var di = 0; di < dates.length; di++) {
      if (!existingIndex[dates[di] + '|XDC|' + metrics[m]]) missing++;
    }
  }
  Logger.log('  ' + missing + ' missing XDC reserve metric-date slot(s)');
  if (missing === 0) { Logger.log('  no gaps — done'); return; }

  // ── 3. Fill in 14-day chunks ──────────────────────────────────────────
  var totalWritten = 0;
  var chunkStart   = SINCE;

  while (chunkStart <= UNTIL) {
    if (Date.now() - runStart > MAX_RUN_MS) {
      Logger.log('  approaching GAS limit — stopping at ' + chunkStart + '. Re-run to continue.');
      break;
    }
    var chunkEnd = addDays(chunkStart, CHUNK_DAYS - 1);
    if (chunkEnd > UNTIL) chunkEnd = UNTIL;
    Logger.log('  chunk ' + chunkStart + ' .. ' + chunkEnd);

    var result = buildRows(chunkStart, chunkEnd, indexResult, null);
    if (result.rows) {
      result.rows = result.rows.filter(function(r) { return WRITE_ONLY[r.metric_key]; });
    }

    if (result.rows && result.rows.length > 0) {
      var wr = writeFactsAndHealth(result, indexResult);
      totalWritten += wr.written;
      for (var ri = 0; ri < result.rows.length; ri++) {
        var r    = result.rows[ri];
        var rkey = r.date + '|' + r.chain + '|' + r.metric_key;
        existingIndex[rkey]   = true;
        factsValueIndex[rkey] = r.value;
        var rcm = r.chain + '|' + r.metric_key;
        if (!maxDates[rcm] || r.date > maxDates[rcm]) maxDates[rcm] = r.date;
      }
    }
    chunkStart = addDays(chunkEnd, 1);
  }

  Logger.log('=== fillXdcReserveWindow done — wrote ' + totalWritten + ' row(s) ===');
}