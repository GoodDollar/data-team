/***** =========================================
 * GOODDOLLAR DASHBOARD — DEV v6.1
 * =========================================
 *
 * CHANGELOG v6.1 (2026-11-25)
 * - Section 6: xdcSubgraphCorrectionPreview / xdcSubgraphCorrection /
 *   xdcSubgraphCorrectionRestore. One-off correction of the XDC claimer
 *   and G$ claimed history after the move to gd_xdc/1.4, and of the XDC
 *   and AGG USD rows of the last 90 days.
 *
 * Companion file to v6-main.gs. Contains everything that is NOT part
 * of the daily cron path: connection tests, diagnostics, one-shot
 * repair/migration functions, manual backfills, and schema inspectors.
 *
 * Nothing in this file is called by smartBackfill(). Every function is
 * a manual entrypoint you run from the Apps Script UI when you need it.
 *
 * This file shares the same GAS project scope as v6-main.gs and can
 * call all of its functions and constants directly:
 *   CONFIG, METRICS, CHAINS, XDC_INVITES_CFG, XDC_INVITES_RAW_HEADERS,
 *   DEADLINES, addDays, dateDiffDays, formatYMD, getYesterdayYMD,
 *   ensureSheets, getExistingFactsIndex, buildRows, writeFactsAndHealth,
 *   duneFetchTable, hypersyncFetchLogs, xdcInvitesReadRaw,
 *   xdcInvitesGetCampaignOwner, xdcRpcCall, reserveGqlRequest,
 *   xdcReserveGqlRequest, xdcGqlRequest, xdcDayISOToYmd, dayISOToYmd,
 *   fetchXdcReserveLiquidity, notifySlack, lookupValue, etc.
 *
 * CRITICAL DO-NOTS
 * ----------------
 *  - Do NOT call anything here from v6-main.gs
 *  - Do NOT add cron triggers pointing to this file
 *  - Do NOT port LOOKBACK_DAYS, CARRY_FORWARD_MAX_DAYS, supplySelfHeal
 *
 * SECTIONS
 * --------
 *  1) Connection tests          — safe, no writes
 *  2) v6-specific diagnostics   — safe, no writes
 *  3) Dry-run / preview tools   — safe, no writes
 *  4) Gap and coverage reports  — safe, no writes
 *  5) Facts sheet maintenance   — deleteOldInviteRows, xdcInvitesDedupeRaw
 *  6) XDC subgraph 1.4 correction — preview (no writes), correction, restore
 *****/


/***** =========================================
 * 1) CONNECTION TESTS (safe, no writes)
 *    Ported verbatim from DEV dev v5.gs
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
      fromBlock:  XDC_INVITES_CFG.GENESIS_BLOCK,
      toBlock:    XDC_INVITES_CFG.GENESIS_BLOCK + 100000,
      addresses:  [XDC_INVITES_CFG.CONTRACT],
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
 * Resolve the GOODXDC campaign owner address from the invites contract.
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
 * 2) v6-SPECIFIC DIAGNOSTICS (safe, no writes)
 * =========================================*/

/**
 * Send a test Slack notification to verify the webhook is wired up.
 * Requires SLACK_WEBHOOK_URL in Script Properties.
 */
function testSlackNotification() {
  Logger.log('=== testSlackNotification ===');
  try {
    notifySlack('🔔 GoodDollar v6 test notification — ' + getYesterdayYMD() +
                ' — if you see this, Slack is working.');
    Logger.log('  sent (check your Slack channel)');
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}

/**
 * Verify Etherscan supply fetching and its fallback to hard-coded constants.
 *
 * Tests:
 *   1. Etherscan call returns a positive number (live check)
 *   2. Fallback constants are sane non-zero values
 *   3. Frozen supply is less than total supply
 */
function testEtherscanFallback() {
  Logger.log('=== testEtherscanFallback ===');

  // Test 1: live Etherscan call
  try {
    var liveTotal = fetchEthereumSupply(getYesterdayYMD());
    if (Array.isArray(liveTotal) && liveTotal.length > 0 && liveTotal[0].value > 0) {
      Logger.log('  live total supply: ' + liveTotal[0].value + ' G$  [ok]');
    } else {
      Logger.log('  live Etherscan returned unexpected value: ' + JSON.stringify(liveTotal) + '  [warn]');
    }
  } catch (e) {
    Logger.log('  live Etherscan failed: ' + e.message + '  (fallback will be used)');
  }

  // Test 2: live Etherscan frozen
  try {
    var liveFrozen = fetchEthereumFrozenSupply();
    if (typeof liveFrozen === 'number' && liveFrozen > 0) {
      Logger.log('  live Etherscan frozen supply: ' + liveFrozen + ' G$  [ok]');
    } else {
      Logger.log('  live Etherscan frozen returned unexpected value: ' + JSON.stringify(liveFrozen) + '  [warn]');
    }
  } catch (e) {
    Logger.log('  live Etherscan frozen failed: ' + e.message + '  (fallback will be used)');
  }

  // Test 3: fallback constants
  Logger.log('  fallback ETH_GD_TOTAL_SUPPLY_CONST  = ' + ETH_GD_TOTAL_SUPPLY_CONST);
  Logger.log('  fallback ETH_GD_FROZEN_SUPPLY_CONST = ' + ETH_GD_FROZEN_SUPPLY_CONST);
  if (ETH_GD_TOTAL_SUPPLY_CONST > 0 && ETH_GD_FROZEN_SUPPLY_CONST > 0 &&
      ETH_GD_FROZEN_SUPPLY_CONST < ETH_GD_TOTAL_SUPPLY_CONST) {
    Logger.log('  fallback constants sane: frozen < total  [ok]');
  } else {
    Logger.log('  fallback constants look wrong!  [FAIL]');
  }
}

/**
 * Verify that lookupValue() resolves correctly from both batchByKey and
 * factsValueIndex layers, and returns null for a missing key.
 */
function testCtxLookup() {
  Logger.log('=== testCtxLookup ===');

  var ctx = {
    batchByKey: {
      '2025-01-01|CELO|celo_dau': 12345
    },
    factsValueIndex: {
      '2025-01-02|CELO|celo_dau': 67890
    }
  };

  var v1 = lookupValue(ctx, '2025-01-01', 'CELO', 'celo_dau');
  var v2 = lookupValue(ctx, '2025-01-02', 'CELO', 'celo_dau');
  var v3 = lookupValue(ctx, '2025-01-03', 'CELO', 'celo_dau');

  Logger.log('  batchByKey hit:       ' + v1 + (v1 === 12345 ? '  [ok]' : '  [FAIL expected 12345]'));
  Logger.log('  factsValueIndex hit:  ' + v2 + (v2 === 67890 ? '  [ok]' : '  [FAIL expected 67890]'));
  Logger.log('  missing key → null:   ' + v3 + (v3 === null  ? '  [ok]' : '  [FAIL expected null]'));

  // batchByKey should shadow factsValueIndex for the same key
  ctx.batchByKey['2025-01-02|CELO|celo_dau'] = 99999;
  var v4 = lookupValue(ctx, '2025-01-02', 'CELO', 'celo_dau');
  Logger.log('  batch shadows facts:  ' + v4 + (v4 === 99999 ? '  [ok]' : '  [FAIL expected 99999]'));
}

/**
 * Confirm that date utilities use UTC and not the Apps Script host
 * timezone (which is São Paulo / America/Sao_Paulo).
 *
 * São Paulo is UTC-3 (or UTC-2 in DST). If we were using local time,
 * a UTC midnight date would appear as the previous calendar day.
 */
function testTimezone() {
  Logger.log('=== testTimezone ===');

  // A known UTC date: 2025-01-01 00:00:00 UTC
  var utcMidnight = new Date('2025-01-01T00:00:00Z');
  var formatted = formatYMD(utcMidnight);
  Logger.log('  formatYMD(2025-01-01 UTC midnight) = ' + formatted +
             (formatted === '2025-01-01' ? '  [ok]' : '  [FAIL — got local TZ offset!]'));

  // 2025-01-01 00:30:00 UTC → should still be 2025-01-01, not 2024-12-31
  var utcEarlyMorning = new Date('2025-01-01T00:30:00Z');
  var f2 = formatYMD(utcEarlyMorning);
  Logger.log('  formatYMD(2025-01-01 00:30 UTC)    = ' + f2 +
             (f2 === '2025-01-01' ? '  [ok]' : '  [FAIL — would be 2024-12-31 in UTC-3]'));

  // getYesterdayYMD() uses UTC
  var yesterday = getYesterdayYMD();
  var expected  = Utilities.formatDate(
    new Date(Date.now() - 86400000), 'UTC', 'yyyy-MM-dd'
  );
  Logger.log('  getYesterdayYMD() = ' + yesterday +
             (yesterday === expected ? '  [ok]' : '  [FAIL expected ' + expected + ']'));

  // Verify addDays does not drift
  var base = '2025-01-31';
  var next = addDays(base, 1);
  Logger.log('  addDays(2025-01-31, 1) = ' + next +
             (next === '2025-02-01' ? '  [ok]' : '  [FAIL expected 2025-02-01]'));
}

/**
 * Confirm that the facts sheet uses append-at-bottom and has not had
 * rows shifted by any insertRowsAfter() calls.
 *
 * Strategy: read the last 3 rows, verify they have valid YMD dates,
 * and confirm the last row is not the header.
 */
function testAppendAtBottom() {
  Logger.log('=== testAppendAtBottom ===');
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_FACTS);
    if (!sheet) {
      Logger.log('  ERROR: facts sheet not found');
      return;
    }
    var lastRow = sheet.getLastRow();
    Logger.log('  facts sheet has ' + lastRow + ' rows (incl. header)');

    if (lastRow < 2) {
      Logger.log('  sheet is empty — nothing to check');
      return;
    }

    // Read last 3 data rows
    var readCount = Math.min(3, lastRow - 1);
    var lastRows  = sheet.getRange(lastRow - readCount + 1, 1, readCount, 6).getValues();
    for (var i = 0; i < lastRows.length; i++) {
      var r = lastRows[i];
      var dateVal = r[0] instanceof Date ? formatYMD(r[0]) : String(r[0]).slice(0, 10);
      var isDate  = /^\d{4}-\d{2}-\d{2}$/.test(dateVal);
      Logger.log('  row ' + (lastRow - readCount + 1 + i) + ': date=' + dateVal +
                 ' chain=' + r[1] + ' metric=' + r[2] +
                 (isDate ? '' : '  [WARN — not a YMD date]'));
    }

    // Check row 2 is not the header (would indicate insertRowsAfter shifted everything)
    var row2 = sheet.getRange(2, 1, 1, 2).getValues()[0];
    if (String(row2[0]).toLowerCase() === 'date') {
      Logger.log('  [FAIL] Row 2 looks like a header — insertRowsAfter() may have shifted data!');
    } else {
      Logger.log('  row 2 looks like data (not a duplicate header)  [ok]');
    }

  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}


/***** =========================================
 * 3) DRY-RUN / PREVIEW TOOLS (safe, no writes)
 * =========================================*/

/**
 * Show what smartBackfill would do without actually running it. For
 * each metric/chain pair, reports the latest persisted date and how
 * many days of backfill it still needs.
 *
 * Ported from DEV dev v5.gs (previewSmartBackfill).
 */
function previewSmartBackfill() {
  Logger.log('=== previewSmartBackfill ===');
  ensureSheets();
  const indexResult = getExistingFactsIndex();
  const yesterday = getYesterdayYMD();

  var totalDays    = 0;
  var upToDate     = 0;
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

      var daysNeeded = (startFrom > yesterday) ? 0 : dateDiffDays(startFrom, yesterday) + 1;
      totalDays += daysNeeded;
      if (daysNeeded === 0) upToDate++;
      else needsBackfill++;

      var status = (daysNeeded === 0)
        ? 'up to date (last=' + lastDate + ')'
        : 'needs ' + daysNeeded + ' day(s) from ' + startFrom;
      Logger.log('  ' + metricKey + '/' + chain + ': ' + status);
    }
  }

  Logger.log('---');
  Logger.log('summary: ' + upToDate + ' up to date, ' + needsBackfill + ' need backfill, ' +
             totalDays + ' total day-metric-chains to fetch');
}


/***** =========================================
 * 4) GAP AND COVERAGE REPORTS (safe, no writes)
 * =========================================*/

/**
 * Scan the facts sheet for (chain, metric_key) pairs that have gaps
 * between their min and max dates. A gap is any calendar day between
 * the first and last known date for that pair where no row exists.
 *
 * Prints a summary of all gaps found. Does not write anything.
 */
function runGapReport() {
  Logger.log('=== runGapReport ===');
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_FACTS);
    if (!sheet) { Logger.log('  ERROR: facts sheet not found'); return; }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { Logger.log('  sheet is empty'); return; }

    Logger.log('  reading ' + (lastRow - 1) + ' data rows...');
    var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); // date, chain, metric_key

    // Build per-(chain, metricKey) set of dates
    var datesByKey = {};
    for (var i = 0; i < data.length; i++) {
      var row    = data[i];
      var rawDate = row[0];
      var ymd    = rawDate instanceof Date
        ? Utilities.formatDate(rawDate, 'UTC', 'yyyy-MM-dd')
        : String(rawDate).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
      var chain  = String(row[1]);
      var metric = String(row[2]);
      var key    = chain + '|' + metric;
      if (!datesByKey[key]) datesByKey[key] = {};
      datesByKey[key][ymd] = true;
    }

    var gapCount  = 0;
    var cleanCount = 0;
    var keys = Object.keys(datesByKey).sort();

    for (var k = 0; k < keys.length; k++) {
      var keyStr = keys[k];
      var dates  = Object.keys(datesByKey[keyStr]).sort();
      if (!dates.length) continue;

      var minDate = dates[0];
      var maxDate = dates[dates.length - 1];
      var expected = dateDiffDays(minDate, maxDate) + 1;
      var actual   = dates.length;

      if (actual < expected) {
        // Find and log the actual gap dates
        var gaps = [];
        var d = minDate;
        while (d <= maxDate) {
          if (!datesByKey[keyStr][d]) gaps.push(d);
          d = addDays(d, 1);
        }
        Logger.log('  GAP ' + keyStr + ': ' + actual + '/' + expected +
                   ' days (' + gaps.length + ' missing: ' +
                   gaps.slice(0, 5).join(', ') +
                   (gaps.length > 5 ? '... +' + (gaps.length - 5) + ' more' : '') + ')');
        gapCount++;
      } else {
        cleanCount++;
      }
    }

    Logger.log('---');
    Logger.log('gap report: ' + gapCount + ' metric/chain pairs have gaps, ' +
               cleanCount + ' are contiguous');
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}

/**
 * Check each metric in the METRICS registry and report whether it has
 * at least one row in the facts sheet within the last 7 days.
 *
 * Prints any metric/chain pairs that appear absent or stale.
 * Does not write anything.
 */
function runExpectedMetricsReport() {
  Logger.log('=== runExpectedMetricsReport ===');
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_FACTS);
    if (!sheet) { Logger.log('  ERROR: facts sheet not found'); return; }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { Logger.log('  sheet is empty'); return; }

    var since7  = addDays(getYesterdayYMD(), -6); // 7 days window incl. yesterday
    var data    = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

    // Build a set of "chain|metricKey" pairs seen in last 7 days
    var recentKeys = {};
    for (var i = 0; i < data.length; i++) {
      var row    = data[i];
      var rawDate = row[0];
      var ymd    = rawDate instanceof Date
        ? Utilities.formatDate(rawDate, 'UTC', 'yyyy-MM-dd')
        : String(rawDate).slice(0, 10);
      if (ymd < since7) continue;
      var key = String(row[1]) + '|' + String(row[2]);
      recentKeys[key] = true;
    }

    var missing = [];
    var present = 0;

    var metricKeys = Object.keys(METRICS).sort();
    for (var m = 0; m < metricKeys.length; m++) {
      var metricKey = metricKeys[m];
      var spec      = METRICS[metricKey];
      var chains    = (spec.chains || []).filter(function(c) { return CHAINS[c] || c === 'AGG'; });

      for (var c = 0; c < chains.length; c++) {
        var chain = chains[c];
        var key   = chain + '|' + metricKey;
        if (recentKeys[key]) {
          present++;
        } else {
          missing.push(key);
        }
      }
    }

    if (missing.length === 0) {
      Logger.log('  all ' + present + ' expected metric/chain pairs seen in last 7 days  [ok]');
    } else {
      Logger.log('  ' + present + ' present, ' + missing.length + ' missing in last 7 days:');
      for (var j = 0; j < missing.length; j++) {
        Logger.log('    MISSING: ' + missing[j]);
      }
    }
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }
}


/***** =========================================
 * 5) FACTS SHEET MAINTENANCE
 * =========================================*/

/**
 * Scan the facts sheet for rows with the old v4-named XdcInvites
 * metric keys and delete them. Expected to be a no-op on a v6 sheet
 * that was already populated by v5, but safe to run as a one-shot
 * cleanup after deploy.
 *
 * Old metric keys (v4 names):
 *   xdc_invites_total, xdc_invites_unique_inviters,
 *   xdc_invites_unique_invitees, xdc_invites_campaign_joins,
 *   xdc_invites_referral_joins, xdc_invites_no_code_joins,
 *   xdc_invites_per_inviter_avg, xdc_bounty_events_total,
 *   xdc_bounty_paid_inviters, xdc_bounty_paid_invitees,
 *   xdc_bounty_paid_total
 */
function deleteOldInviteRows() {
  var OLD_KEYS = [
    'xdc_invites_total', 'xdc_invites_unique_inviters', 'xdc_invites_unique_invitees',
    'xdc_invites_campaign_joins', 'xdc_invites_referral_joins', 'xdc_invites_no_code_joins',
    'xdc_invites_per_inviter_avg', 'xdc_bounty_events_total', 'xdc_bounty_paid_inviters',
    'xdc_bounty_paid_invitees', 'xdc_bounty_paid_total'
  ];
  var ss    = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_FACTS);
  if (!sheet) {
    Logger.log('deleteOldInviteRows: facts sheet not found');
    return;
  }
  var data     = sheet.getDataRange().getValues();
  var toDelete = [];
  for (var i = data.length - 1; i >= 1; i--) {
    if (OLD_KEYS.indexOf(String(data[i][2])) !== -1) toDelete.push(i + 1);
  }
  if (toDelete.length === 0) {
    Logger.log('deleteOldInviteRows: no old-named rows found (expected)');
    return;
  }
  Logger.log('deleteOldInviteRows: deleting ' + toDelete.length + ' rows');
  toDelete.forEach(function(rowNum) { sheet.deleteRow(rowNum); });
  Logger.log('deleteOldInviteRows: done');
}

function xdcInvitesDedupeRaw() {
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(XDC_INVITES_CFG.SHEET_RAW);
  if (!sheet) throw new Error('XDC Invites Raw not found');
  const lastRow = sheet.getLastRow();
  if (!lastRow) throw new Error('Raw header missing');
  const data = sheet.getRange(1, 1, lastRow, XDC_INVITES_RAW_COLS).getValues();
  const header = data[0].slice();
  if (header[8] === 'invite_type_or_bounty') header[8] = 'invite_type';
  if (header[11] === 'total_paid_g' && !header[12]) {
    header[11] = 'campaign_returned_g';
    header[12] = 'total_paid_g';
  }
  if (JSON.stringify(header) !== JSON.stringify(XDC_INVITES_RAW_HEADERS)) {
    throw new Error('Unsupported raw headers; no changes made');
  }

  const seen = {};
  const rows = [];
  var legacyRows = 0;
  for (var index = 1; index < data.length; index++) {
    const row = data[index].slice();
    row[0] = formatYMD(row[0]);
    row[1] = Number(row[1]);
    row[2] = Number(row[2]);
    row[3] = String(row[3]).trim().toLowerCase();
    if (row[4] === '' || row[4] == null) throw new Error('Invalid log index at raw row ' + (index + 1));
    row[4] = Number(row[4]);
    row[6] = String(row[6]).trim().toLowerCase();
    row[7] = String(row[7]).trim().toLowerCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row[0]) || !isFinite(row[1]) || row[1] <= 0 ||
        !isFinite(row[2]) || row[2] <= 0 || !/^0x[0-9a-f]{64}$/.test(row[3]) ||
        !Number.isInteger(row[4]) || row[4] < 0 || !/^0x[0-9a-f]{40}$/.test(row[6]) ||
        !/^0x[0-9a-f]{40}$/.test(row[7]) || ['InviteeJoined', 'InviterBounty'].indexOf(row[5]) === -1) {
      throw new Error('Invalid event at raw row ' + (index + 1));
    }
    row[9] = Number(row[9] || 0);
    row[10] = Number(row[10] || 0);
    if (row[12] === '' || row[12] == null) {
      row[12] = Number(row[11] || 0);
      row[11] = Math.max(0, row[12] - row[9] - row[10]);
      legacyRows++;
    } else {
      row[11] = Number(row[11] || 0);
      row[12] = Number(row[12]);
    }
    if (row.slice(9, 13).some(function(value) { return !isFinite(value) || value < 0; })) {
      throw new Error('Invalid payout at raw row ' + (index + 1));
    }
    if (Math.abs(row[12] - row[9] - row[10] - row[11]) > 0.000001) {
      throw new Error('Inconsistent payout at raw row ' + (index + 1));
    }
    const key = row[3] + '|' + row[4];
    const payload = JSON.stringify(row);
    if (seen[key]) {
      if (seen[key] !== payload) throw new Error('Conflicting duplicate ' + key + '; no changes made');
      continue;
    }
    seen[key] = payload;
    rows.push(row);
  }

  const summary = { rowsBefore: data.length - 1, rowsAfter: rows.length,
    duplicatesRemoved: data.length - 1 - rows.length, legacyRowsNormalized: legacyRows, backupSheet: null };
  if (!summary.duplicatesRemoved && !legacyRows && JSON.stringify(data[0]) === JSON.stringify(XDC_INVITES_RAW_HEADERS)) {
    Logger.log('xdcInvitesDedupeRaw: ' + JSON.stringify(summary));
    return summary;
  }
  summary.backupSheet = XDC_INVITES_CFG.SHEET_RAW + ' backup ' + Date.now();
  sheet.copyTo(ss).setName(summary.backupSheet);
  Logger.log('xdcInvitesDedupeRaw backup: ' + summary.backupSheet);
  if (sheet.getLastRow() !== lastRow) throw new Error('Raw changed during backup; retry between scheduled executions');
  sheet.getRange(1, 1, rows.length + 1, XDC_INVITES_RAW_COLS).setValues([XDC_INVITES_RAW_HEADERS].concat(rows));
  if (summary.duplicatesRemoved) {
    sheet.getRange(rows.length + 2, 1, summary.duplicatesRemoved, XDC_INVITES_RAW_COLS).clearContent();
  }
  SpreadsheetApp.flush();
  Logger.log('xdcInvitesDedupeRaw: ' + JSON.stringify(summary));
  return summary;
}


/***** =========================================
 * 6) XDC SUBGRAPH 1.4 CORRECTION
 * =========================================
 * gd_xdc/1.2 counted Identity whitelist events as claimers, and its day rows
 * missed the claims made before the row existed. Daily Facts never rewrites a
 * stored row, so moving XDC_SUBGRAPH_URL to 1.4 fixes new rows only. These
 * functions correct the stored rows in place:
 *
 *   xdcSubgraphCorrectionPreview()  computes everything and logs what would
 *                                   change. Writes nothing.
 *   xdcSubgraphCorrection()         first writes every row it will change or
 *                                   add, with the old value, to a new tab
 *                                   "XDC 1.4 corrections <UTC time>", then
 *                                   corrects Daily Facts. A second run
 *                                   changes nothing.
 *   xdcSubgraphCorrectionRestoreLatest()  (or ...Restore(tabName))
 *                                   puts the old values back from the newest
 *                                   log tab and removes the rows it added.
 *
 * What it recomputes:
 *   From CONFIG.XDC_GENESIS to the last day the daily run has written (at
 *   most yesterday), from the 1.4 day rows read at one pinned block: xdc_new_claimers; xdc_lifetime_unique_claimers (running
 *   total of first-time claimers to the end of each UTC day);
 *   xdc_returning_claimers (stored xdc_dau minus new claimers, floored at 0);
 *   xdc_gd_claimed_1d/7d/30d; xdc_daily_gd_minted; agg_gd_claimed_1d/7d/30d.
 *   For the last XDC_CORRECTION.USD_DAYS days (an XDC price row exists on
 *   each of them): xdc_usd_claimed_1d/7d/30d, xdc_p2p_usd_amount,
 *   xdc_lifetime_claimed_usd_amount and their agg_ rows (which, before
 *   v6.5, were written without XDC).
 * Run it between scheduled executions. It stops without changing Daily
 * Facts if a row is appended while it runs.
 *****/

const XDC_CORRECTION = {
  USD_DAYS: 90,
  LOG_PREFIX: 'XDC 1.4 corrections ',
  LOG_HEADERS: ['date', 'chain', 'metric_key', 'action', 'old_value', 'new_value', 'old_updated_at', 'subgraph_block'],
  // USD metric base -> the G$ metric base it is priced from
  USD_SOURCES: {
    usd_claimed_1d: 'gd_claimed_1d',
    usd_claimed_7d: 'gd_claimed_7d',
    usd_claimed_30d: 'gd_claimed_30d',
    p2p_usd_amount: 'p2p_gd_amount',
    lifetime_claimed_usd_amount: 'lifetime_claimed_gd_amount',
  },
};

function xdcSubgraphCorrectionPreview() {
  return xdcSubgraphCorrectionRun_(false);
}

function xdcSubgraphCorrection() {
  return xdcSubgraphCorrectionRun_(true);
}

/** Same date parsing as getExistingFactsIndex(). */
function xdcFactsDate_(value) {
  if (value instanceof Date) return formatYMD(value);
  if (value != null && String(value).length >= 10) {
    const parsed = parseDateLoose(value);
    return parsed ? formatYMD(parsed) : null;
  }
  return null;
}

/** Every 1.4 day row up to the end of untilYMD, read at one block. */
function xdcCorrectionFetchDays_(untilYMD) {
  if (XDC_SUBGRAPH_URL.indexOf('/gd_xdc/1.4/') === -1) {
    throw new Error('XDC_SUBGRAPH_URL is not gd_xdc/1.4; nothing was changed');
  }
  const meta = xdcGqlRequest('query { _meta { block { number timestamp } hasIndexingErrors } }')._meta;
  if (meta.hasIndexingErrors) throw new Error('XDC subgraph reports indexing errors; nothing was changed');
  const dayEnd = Date.parse(untilYMD + 'T00:00:00Z') / 1000 + 86400;
  if (Number(meta.block.timestamp) < dayEnd) {
    throw new Error('XDC subgraph head (block ' + meta.block.number + ') is before the end of ' + untilYMD + '; nothing was changed');
  }
  const block = meta.block.number;
  var nodes = [];
  var last = '';
  for (;;) {
    const page = xdcGqlRequest('query { dailyUBIs(first: 1000, orderBy: id, orderDirection: asc, block: { number: ' + block +
      ' }, where: { id_gt: "' + last + '" }) { id newClaimers totalUBIDistributed } }').dailyUBIs || [];
    nodes = nodes.concat(page);
    if (page.length < 1000) break;
    last = page[page.length - 1].id;
  }
  const days = nodes.map(function(n) {
    return {
      date: xdcDayISOToYmd(n.id),
      newClaimers: n.newClaimers == null ? null : Number(n.newClaimers),
      claimed: n.totalUBIDistributed == null ? null : Number(n.totalUBIDistributed) / 1e18,
    };
  }).filter(function(day) { return day.date <= untilYMD; });
  days.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return { block: block, days: days };
}

/**
 * Target values for every corrected row. Pure: days = 1.4 day rows sorted by
 * date; get(date, chain, metricKey) returns the stored value or null.
 * Rolling sums treat a missing day as 0 and AGG sums every chain that has a
 * value, as the daily pipeline does.
 */
function xdcCorrectionTargets_(days, get, untilYMD, usdSinceYMD) {
  const byDay = {};
  const lifetime = {};
  var running = 0;
  for (var i = 0; i < days.length; i++) {
    byDay[days[i].date] = days[i];
    running += days[i].newClaimers || 0;
    lifetime[days[i].date] = running;
  }
  function claimedOver(date, windowDays) {
    var sum = 0;
    for (var back = 0; back < windowDays; back++) {
      const day = byDay[addDays(date, -back)];
      sum += day && day.claimed != null ? day.claimed : 0;
    }
    return sum;
  }
  function aggOf(date, base, xdcValue) {
    var sum = xdcValue;
    Object.keys(CHAINS).forEach(function(chain) {
      if (chain === 'XDC') return;
      const value = get(date, chain, chain.toLowerCase() + '_' + base);
      if (value !== null) sum += value;
    });
    return sum;
  }
  const targets = [];
  const noPrice = [];
  function add(date, chain, metricKey, value, source) {
    targets.push({ date: date, chain: chain, metric_key: metricKey, value: value, source: source });
  }
  for (var d = CONFIG.XDC_GENESIS; d <= untilYMD; d = addDays(d, 1)) {
    const day = byDay[d];
    if (!day || day.newClaimers == null || day.claimed == null) continue;
    const gd = { gd_claimed_1d: day.claimed, gd_claimed_7d: claimedOver(d, 7), gd_claimed_30d: claimedOver(d, 30) };
    add(d, 'XDC', 'xdc_new_claimers', day.newClaimers, 'XDC_SUBGRAPH');
    add(d, 'XDC', 'xdc_lifetime_unique_claimers', lifetime[d], 'XDC_SUBGRAPH');
    const dau = get(d, 'XDC', 'xdc_dau');
    if (dau !== null) add(d, 'XDC', 'xdc_returning_claimers', Math.max(0, dau - day.newClaimers), 'COMPUTED');
    add(d, 'XDC', 'xdc_daily_gd_minted', day.claimed, 'COMPUTED');
    Object.keys(gd).forEach(function(base) {
      add(d, 'XDC', 'xdc_' + base, gd[base], 'XDC_SUBGRAPH');
      add(d, 'AGG', 'agg_' + base, aggOf(d, base, gd[base]), 'AGG');
    });
    if (d < usdSinceYMD) continue;
    const price = get(d, 'XDC', 'xdc_gd_price');
    if (price === null || price === 0) {
      noPrice.push(d);
      continue;
    }
    Object.keys(XDC_CORRECTION.USD_SOURCES).forEach(function(base) {
      const sourceBase = XDC_CORRECTION.USD_SOURCES[base];
      const amount = gd[sourceBase] !== undefined ? gd[sourceBase] : get(d, 'XDC', 'xdc_' + sourceBase);
      if (amount === null) return;
      add(d, 'XDC', 'xdc_' + base, amount * price, 'COMPUTED');
      add(d, 'AGG', 'agg_' + base, aggOf(d, base, amount * price), 'AGG');
    });
  }
  return { targets: targets, noPrice: noPrice };
}

/**
 * updated_at as the text the sheet shows ("yyyy-MM-dd HH:mm:ss" in the
 * spreadsheet's time zone). Written back as text it parses to the same
 * value; writing the Date object back was silently ignored by Sheets
 * (seen on the test copy, 2026-11-25).
 */
function xdcUpdatedAtText_(value, timeZone) {
  if (value instanceof Date) return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd HH:mm:ss');
  return value == null ? '' : String(value);
}

function xdcCorrectionReadFacts_(facts) {
  const lastRow = facts.getLastRow();
  const data = lastRow > 1 ? facts.getRange(2, 1, lastRow - 1, 6).getValues() : [];
  const rowOf = {};
  const valueOf = {};
  const lastDate = {};
  for (var i = 0; i < data.length; i++) {
    const ymd = xdcFactsDate_(data[i][0]);
    if (!ymd || !data[i][1] || !data[i][2]) continue;
    const key = ymd + '|' + data[i][1] + '|' + data[i][2];
    rowOf[key] = i;
    const value = parseFloat(String(data[i][3]).replace(/,/g, ''));
    if (isFinite(value)) valueOf[key] = value;
    const series = data[i][1] + '|' + data[i][2];
    if (!lastDate[series] || ymd > lastDate[series]) lastDate[series] = ymd;
  }
  return { lastRow: lastRow, data: data, rowOf: rowOf, valueOf: valueOf, lastDate: lastDate };
}

/**
 * Write value (D) and updated_at (F) for every row in one call each. Cells
 * that hold a formula get the same formula back; a change that would
 * replace a formula stops the run before anything is written.
 */
function xdcCorrectionWriteColumns_(facts, data, changes) {
  if (!data.length) return;
  const formulas = facts.getRange(2, 4, data.length, 3).getFormulas();
  changes.forEach(function(c) {
    if (formulas[c.idx][0] || formulas[c.idx][2]) {
      throw new Error('Daily Facts row ' + (c.idx + 2) + ' needs a change but holds a formula; nothing was changed');
    }
  });
  const colD = data.map(function(r, i) { return [formulas[i][0] || r[3]]; });
  const colF = data.map(function(r, i) { return [formulas[i][2] || r[5]]; });
  changes.forEach(function(c) {
    colD[c.idx][0] = c.value;
    colF[c.idx][0] = c.updatedAt;
  });
  facts.getRange(2, 4, colD.length, 1).setValues(colD);
  facts.getRange(2, 6, colF.length, 1).setValues(colF);
}

function xdcCorrectionAppend_(facts, rows) {
  const start = facts.getLastRow() + 1;
  facts.getRange(start, 1, rows.length, 6).setValues(rows);
  const byDecimals = {};
  rows.forEach(function(row, i) {
    const spec = METRICS[row[2]];
    const dp = spec && typeof spec.decimals === 'number' ? spec.decimals : 2;
    (byDecimals[dp] = byDecimals[dp] || []).push('D' + (start + i));
  });
  Object.keys(byDecimals).forEach(function(dp) {
    facts.getRangeList(byDecimals[dp]).setNumberFormat(dp == 0 ? '#,##0' : '#,##0.' + '0'.repeat(Number(dp)));
  });
}

function xdcSubgraphCorrectionRun_(write) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another run holds the script lock; nothing was changed');
  try {
    const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
    const facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
    if (!facts) throw new Error('Daily Facts not found');
    const stored = xdcCorrectionReadFacts_(facts);
    // Stop at the last day the daily run has written (its Celo and XDC rows
    // are needed for AGG and returning claimers), and never past yesterday.
    var untilYMD = getYesterdayYMD();
    ['CELO|celo_gd_claimed_1d', 'XDC|xdc_dau', 'XDC|xdc_gd_price'].forEach(function(k) {
      const last = stored.lastDate[k];
      if (!last) throw new Error('No ' + k + ' rows in Daily Facts; nothing was changed');
      if (last < untilYMD) untilYMD = last;
    });
    const usdSinceYMD = addDays(untilYMD, -(XDC_CORRECTION.USD_DAYS - 1));
    const fetched = xdcCorrectionFetchDays_(untilYMD);
    const computed = xdcCorrectionTargets_(fetched.days, function(date, chain, metricKey) {
      const value = stored.valueOf[date + '|' + chain + '|' + metricKey];
      return value === undefined ? null : value;
    }, untilYMD, usdSinceYMD);

    const updates = [];
    const adds = [];
    const perKey = {};
    computed.targets.forEach(function(t) {
      const spec = METRICS[t.metric_key];
      const dp = spec && typeof spec.decimals === 'number' ? spec.decimals : 2;
      const value = Number(Number(t.value).toFixed(dp));
      const key = t.date + '|' + t.chain + '|' + t.metric_key;
      const stat = perKey[t.metric_key] || (perKey[t.metric_key] = { unchanged: 0, updated: 0, added: 0, largest: null });
      const idx = stored.rowOf[key];
      if (idx === undefined) {
        adds.push({ t: t, value: value });
        stat.added++;
        return;
      }
      const old = stored.valueOf[key];
      if (old !== undefined && Math.abs(old - value) < 1e-6) {
        stat.unchanged++;
        return;
      }
      updates.push({ idx: idx, t: t, value: value, old: stored.data[idx][3], oldUpdated: stored.data[idx][5] });
      stat.updated++;
      const change = old === undefined ? null : value - old;
      if (!stat.largest || (change !== null && Math.abs(change) > Math.abs(stat.largest.change || 0))) {
        stat.largest = { date: t.date, old: old === undefined ? null : old, value: value };
        stat.largest.change = change;
      }
    });

    // Formula cells in value / source / updated_at: kept as they are (see
    // xdcCorrectionWriteColumns_), listed here so they can be checked.
    const formulas = stored.data.length ? facts.getRange(2, 4, stored.data.length, 3).getFormulas() : [];
    const formulaCells = [];
    formulas.forEach(function(r, i) {
      r.forEach(function(formula, c) {
        if (formula) formulaCells.push({ row: i + 2, date: xdcFactsDate_(stored.data[i][0]), chain: stored.data[i][1],
          metric_key: stored.data[i][2], column: 'DEF'.charAt(c), formula: String(formula).slice(0, 120) });
      });
    });
    updates.forEach(function(u) {
      if (formulas[u.idx][0] || formulas[u.idx][2]) {
        throw new Error('Daily Facts row ' + (u.idx + 2) + ' needs a change but holds a formula; nothing was changed');
      }
    });

    const summary = {
      write: write, subgraphBlock: fetched.block, until: untilYMD, usdSince: usdSinceYMD,
      updated: updates.length, added: adds.length, noPriceDates: computed.noPrice, perKey: perKey,
      formulaCellCount: formulaCells.length, formulaCells: formulaCells.slice(0, 20), logSheet: null,
    };
    if (!write || (!updates.length && !adds.length)) {
      Logger.log('xdcSubgraphCorrection (' + (write ? 'nothing to change' : 'preview, no writes') + '): ' + JSON.stringify(summary));
      return summary;
    }

    summary.logSheet = XDC_CORRECTION.LOG_PREFIX + Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm:ss');
    const timeZone = ss.getSpreadsheetTimeZone();
    const logRows = updates.map(function(u) {
      return [u.t.date, u.t.chain, u.t.metric_key, 'updated', u.old, u.value, xdcUpdatedAtText_(u.oldUpdated, timeZone), fetched.block];
    }).concat(adds.map(function(a) {
      return [a.t.date, a.t.chain, a.t.metric_key, 'added', '', a.value, '', fetched.block];
    }));
    const log = ss.insertSheet(summary.logSheet);
    // date and old_updated_at stay text so they read back exactly as written
    log.getRange(1, 1, logRows.length + 1, 1).setNumberFormat('@');
    log.getRange(1, 7, logRows.length + 1, 1).setNumberFormat('@');
    log.getRange(1, 1, 1, XDC_CORRECTION.LOG_HEADERS.length).setValues([XDC_CORRECTION.LOG_HEADERS]);
    log.getRange(2, 1, logRows.length, XDC_CORRECTION.LOG_HEADERS.length).setValues(logRows);
    SpreadsheetApp.flush();

    if (facts.getLastRow() !== stored.lastRow) {
      throw new Error('Daily Facts changed during the run, so it was not touched. Delete tab "' + summary.logSheet +
        '" and run again between scheduled executions');
    }
    const now = nowIso();
    xdcCorrectionWriteColumns_(facts, stored.data, updates.map(function(u) {
      return { idx: u.idx, value: u.value, updatedAt: now };
    }));
    if (adds.length) {
      xdcCorrectionAppend_(facts, adds.map(function(a) {
        return [a.t.date, a.t.chain, a.t.metric_key, a.value, a.t.source, now];
      }));
    }
    SpreadsheetApp.flush();
    Logger.log('xdcSubgraphCorrection: ' + JSON.stringify(summary));
    return summary;
  } finally {
    lock.releaseLock();
  }
}

/** Editor entry point: restore the newest log tab not restored yet. */
function xdcSubgraphCorrectionRestoreLatest() {
  const names = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID).getSheets()
    .map(function(s) { return s.getName(); })
    .filter(function(n) { return n.indexOf(XDC_CORRECTION.LOG_PREFIX) === 0 && !/\(restored\)$/.test(n); })
    .sort();
  if (!names.length) throw new Error('No "' + XDC_CORRECTION.LOG_PREFIX + '..." tab to restore');
  return xdcSubgraphCorrectionRestore(names[names.length - 1]);
}

/**
 * Undo xdcSubgraphCorrection(): restores the old values listed in the log
 * tab and deletes the rows it added. Renames the tab "... (restored)".
 */
function xdcSubgraphCorrectionRestore(logSheetName) {
  if (!logSheetName) throw new Error('Pass the log tab name, for example "XDC 1.4 corrections 2026-11-25 03:10:00"');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another run holds the script lock; nothing was changed');
  try {
    const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
    const log = ss.getSheetByName(logSheetName);
    if (!log) throw new Error('Tab not found: ' + logSheetName);
    const facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
    const width = XDC_CORRECTION.LOG_HEADERS.length;
    const logRows = log.getLastRow() > 1 ? log.getRange(2, 1, log.getLastRow() - 1, width).getValues() : [];
    const stored = xdcCorrectionReadFacts_(facts);
    const changes = [];
    const toDelete = [];
    var notFound = 0;
    logRows.forEach(function(r) {
      const idx = stored.rowOf[xdcFactsDate_(r[0]) + '|' + r[1] + '|' + r[2]];
      if (idx === undefined) { notFound++; return; }
      if (r[3] === 'updated') changes.push({ idx: idx, value: r[4], updatedAt: xdcUpdatedAtText_(r[6], ss.getSpreadsheetTimeZone()) });
      else if (r[3] === 'added') toDelete.push(idx + 2);
    });
    if (facts.getLastRow() !== stored.lastRow) throw new Error('Daily Facts changed during the run; nothing was changed');
    xdcCorrectionWriteColumns_(facts, stored.data, changes);
    toDelete.sort(function(a, b) { return a - b; });
    var j = toDelete.length - 1;
    while (j >= 0) {
      const end = toDelete[j];
      var start = end;
      while (j - 1 >= 0 && toDelete[j - 1] === start - 1) { start--; j--; }
      j--;
      facts.deleteRows(start, end - start + 1);
    }
    log.setName(logSheetName + ' (restored)');
    SpreadsheetApp.flush();
    const summary = { restored: changes.length, deleted: toDelete.length, notFound: notFound };
    Logger.log('xdcSubgraphCorrectionRestore: ' + JSON.stringify(summary));
    return summary;
  } finally {
    lock.releaseLock();
  }
}
