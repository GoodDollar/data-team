/***** =========================================
 * GOODDOLLAR DASHBOARD — DEV v6.0
 * =========================================
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
 *  5) Facts sheet maintenance   — deleteOldInviteRows
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
