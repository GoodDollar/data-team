/***** =========================================
 * GOODDOLLAR DASHBOARD v4.0.2
 * Updated: Goldsky + XDC P2P transfer metrics
 * ========================================= *****/

/***** =========================================
 * 0) CONFIG / CONSTANTS / REGISTRY
 * ========================================= *****/

const CONFIG = {
  DEST_SPREADSHEET_ID: '1vZoUwOi9EKAABqy6TIeW1XWdChwvDPL71YJWlwy5AXo',
  SHEET_FACTS:  'Daily Facts',
  SHEET_HEALTH: 'Health Runs',
  TIMEZONE: Session.getScriptTimeZone() || 'America/Sao_Paulo',
  VERBOSE: true,
  XDC_GENESIS: '2025-11-12',
};

const CHAINS = { CELO: true, XDC: true };

const XDC_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/gd_xdc/1.2/gn';

const DUNE_IDS = {
  LIFETIMES:       '5966342',
  ACTIVE_CLAIMERS: '4834304',
  UBI_SUMMARIES:   '5710738',
  NEW_VS_RETURN:   '4834229',
  P2P_TRANSFERS:   '5521377',
  PARTNERS:        '5608955',
};

const METRICS = {
  gd_usd_price: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 8,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 1 },
  },
  celo_dau: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.ACTIVE_CLAIMERS, dateCol: 0, valueCol: 1 },
  },
  xdc_dau: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdc: { type: 'daily_field', field: 'activeUsers' },
  },
  celo_wau: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.ACTIVE_CLAIMERS, dateCol: 0, valueCol: 2 },
  },
  celo_mau: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.ACTIVE_CLAIMERS, dateCol: 0, valueCol: 3 },
  },
  celo_yau: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 9 },
  },
  celo_new_claimers: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.NEW_VS_RETURN, dateCol: 0, valueCol: 2 },
  },
  xdc_new_claimers: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdc: { type: 'daily_field', field: 'newClaimers' },
  },
  celo_returning_claimers: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.NEW_VS_RETURN, dateCol: 0, valueCol: 3 },
  },
  xdc_returning_claimers: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdc: { type: 'computed' },
  },
  celo_p2p_tx_count: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 2 },
  },
  xdc_p2p_tx_count: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 0,
    xdc: { type: 'transaction_daily', field: 'transactionsCountClean' },
  },
  celo_p2p_gd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 3 },
  },
  xdc_p2p_gd_amount: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: { type: 'transaction_daily', field: 'transactionsValueClean', divisor: 1e18 },
  },
  celo_p2p_usd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 4 },
  },
  celo_p2p_senders: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 11 },
  },
  celo_p2p_receivers: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 12 },
  },
  celo_p2p_users: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 13 },
  },
  celo_p2p_lifetime_tx_count: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 1 },
  },
  xdc_p2p_lifetime_tx_count: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 0,
    xdc: { type: 'transaction_lifetime', field: 'transactionsCountClean' },
  },
  celo_p2p_lifetime_gd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 2 },
  },
  xdc_p2p_lifetime_gd_amount: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: { type: 'transaction_lifetime', field: 'transactionsValueClean', divisor: 1e18 },
  },
  celo_p2p_lifetime_unique_users: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 5 },
  },
  celo_lifetime_unique_claimers: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 6 },
  },
  xdc_lifetime_unique_claimers: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdc: { type: 'global_total', field: 'uniqueClaimers' },
  },
  celo_lifetime_claim_TXs: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 7 },
  },
  xdc_lifetime_claim_TXs: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 0,
    xdc: { type: 'global_total', field: 'totalClaims' },
  },
  celo_lifetime_claimed_gd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 1 },
  },
  xdc_lifetime_claimed_gd_amount: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: { type: 'global_total', field: 'totalUBIDistributed', divisor: 1e18 },
  },
  celo_lifetime_claimed_usd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 2 },
  },
  celo_gd_claimed_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 3 },
  },
  xdc_gd_claimed_30d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: { type: 'rolling_sum', field: 'totalUBIDistributed', windowDays: 30, divisor: 1e18 },
  },
  celo_usd_claimed_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 4 },
  },
  celo_gd_claimed_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 6 },
  },
  xdc_gd_claimed_7d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: { type: 'rolling_sum', field: 'totalUBIDistributed', windowDays: 7, divisor: 1e18 },
  },
  celo_usd_claimed_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 7 },
  },
  celo_gd_claimed_1d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 9 },
  },
  celo_usd_claimed_1d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 10 },
  },
  xdc_gd_claimed_1d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: { type: 'daily_field', field: 'totalUBIDistributed', divisor: 1e18 },
  },
  celo_gd_per_user_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 5 },
  },
  xdc_gd_per_user_30d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdc: { type: 'rolling_sum', field: 'quota', windowDays: 30, divisor: 1e18 },
  },
  celo_gd_per_user_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 8 },
  },
  xdc_gd_per_user_7d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdc: { type: 'rolling_sum', field: 'quota', windowDays: 7, divisor: 1e18 },
  },
  celo_gd_per_user_1d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 11 },
  },
  xdc_gd_per_user_1d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdc: { type: 'daily_field', field: 'quota', divisor: 1e18 },
  },
  celo_p2p_tx_count_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 5 },
  },
  xdc_p2p_tx_count_7d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 0,
    xdc: { type: 'transaction_rolling', field: 'transactionsCountClean', windowDays: 7 },
  },
  celo_p2p_tx_count_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 8 },
  },
  xdc_p2p_tx_count_30d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 0,
    xdc: { type: 'transaction_rolling', field: 'transactionsCountClean', windowDays: 30 },
  },
  celo_p2p_gd_amount_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 6 },
  },
  xdc_p2p_gd_amount_7d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: { type: 'transaction_rolling', field: 'transactionsValueClean', windowDays: 7, divisor: 1e18 },
  },
  celo_p2p_gd_amount_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 9 },
  },
  xdc_p2p_gd_amount_30d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: { type: 'transaction_rolling', field: 'transactionsValueClean', windowDays: 30, divisor: 1e18 },
  },
  xdc_gd_in_circulation: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdc: { type: 'transaction_lifetime', field: 'totalInCirculation', divisor: 1e18 },
  },

};

/***** =========================================
 * 1) UTILITY HELPERS
 * ========================================= *****/

function nowIso() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm:ss");
}

function generateRunId() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyyMMdd_HHmmss");
}

function formatYMD(d) {
  if (d instanceof Date) {
    return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  return String(d).slice(0, 10);
}

function parseYMD(value) {
  if (value instanceof Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (value == null) {
    throw new Error('parseYMD: empty/undefined value');
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    throw new Error('parseYMD: invalid format: ' + s);
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function parseDateLoose(v) {
  if (v instanceof Date) return v;
  const s = String(v || '').trim();
  if (!s) return null;
  
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }
  
  if (/^\d+(\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (num > 40000 && num < 60000) {
      return new Date((num - 25569) * 86400 * 1000);
    }
    if (num > 1e12) return new Date(num);
    if (num > 1e9) return new Date(num * 1000);
  }
  
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  
  return null;
}

function getYesterdayYMD() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatYMD(d);
}

function addDays(ymd, n) {
  const d = parseYMD(ymd);
  d.setDate(d.getDate() + n);
  return formatYMD(d);
}

function dateDiffDays(a, b) {
  const d1 = parseYMD(a);
  const d2 = parseYMD(b);
  return Math.round((d2 - d1) / (86400 * 1000));
}

/***** =========================================
 * 2) SPREADSHEET HELPERS
 * ========================================= *****/

function ensureSheets() {
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  
  let facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  if (!facts) {
    facts = ss.insertSheet(CONFIG.SHEET_FACTS);
    facts.getRange(1, 1, 1, 6).setValues([
      ['date', 'chain', 'metric_key', 'value', 'source', 'updated_at']
    ]);
    facts.setFrozenRows(1);
  }
  
  let health = ss.getSheetByName(CONFIG.SHEET_HEALTH);
  if (!health) {
    health = ss.insertSheet(CONFIG.SHEET_HEALTH);
    health.getRange(1, 1, 1, 9).setValues([
      ['run_id', 'started_at', 'subsystem', 'metric_key', 'chain', 'status', 'records', 'duration_ms', 'error']
    ]);
    health.setFrozenRows(1);
  }
  
  return { facts, health };
}

function getExistingFactsIndex() {
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  
  if (!facts) return { index: {}, maxDates: {} };
  
  const lastRow = facts.getLastRow();
  if (lastRow < 2) return { index: {}, maxDates: {} };
  
  const data = facts.getRange(2, 1, lastRow - 1, 4).getValues();
  
  const index = {};
  const maxDates = {};
  
  for (const row of data) {
    const dateVal = row[0];
    const chain = row[1];
    const metricKey = row[2];
    
    let ymd = null;
    if (dateVal instanceof Date) {
      ymd = formatYMD(dateVal);
    } else if (dateVal != null && String(dateVal).length >= 10) {
      const parsed = parseDateLoose(dateVal);
      ymd = parsed ? formatYMD(parsed) : null;
    }
    
    if (!ymd || !chain || !metricKey) continue;
    
    const key = ymd + '|' + chain + '|' + metricKey;
    index[key] = true;
    
    const chainMetricKey = chain + '|' + metricKey;
    if (!maxDates[chainMetricKey] || ymd > maxDates[chainMetricKey]) {
      maxDates[chainMetricKey] = ymd;
    }
  }
  
  return { index, maxDates };
}

/***** =========================================
 * 3) DUNE HELPERS
 * ========================================= *****/

function duneApiKey() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('DUNE_API_KEY');
  if (!key) throw new Error('Missing DUNE_API_KEY in Script Properties');
  return key;
}

function duneFetchTable(queryId, limit) {
  limit = limit || 10000;
  const url = 'https://api.dune.com/api/v1/query/' + encodeURIComponent(String(queryId)) + '/results?limit=' + limit;
  
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { 'X-DUNE-API-KEY': duneApiKey() }
  });
  
  const status = res.getResponseCode();
  const text = res.getContentText();
  
  if (status < 200 || status >= 300) {
    throw new Error('Dune HTTP error (' + status + '): ' + text.slice(0, 500));
  }
  
  const json = JSON.parse(text);
  const result = json.result || {};
  const rowsObj = result.rows || [];
  const meta = result.metadata || {};
  const cols = meta.column_names || [];
  
  // Convert objects to arrays in columnNames order (required for numeric index access)
  var rows = [];
  for (var i = 0; i < rowsObj.length; i++) {
    var row = [];
    for (var j = 0; j < cols.length; j++) {
      row.push(rowsObj[i][cols[j]]);
    }
    rows.push(row);
  }
  
  if (!rows.length) {
    Logger.log('Dune query ' + queryId + ': 0 rows returned');
  } else {
    Logger.log('Dune query ' + queryId + ': fetched ' + rows.length + ' rows');
  }
  
  return { rows: rows, cols: cols, columnNames: cols };
}

function duneExecuteQuery(queryId) {
  const url = 'https://api.dune.com/api/v1/query/' + encodeURIComponent(String(queryId)) + '/execute';
  
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    muteHttpExceptions: true,
    headers: { 'X-DUNE-API-KEY': duneApiKey() },
    payload: JSON.stringify({}),
    contentType: 'application/json'
  });
  
  const status = res.getResponseCode();
  const text = res.getContentText();
  
  if (status < 200 || status >= 300) {
    throw new Error('Dune execute error (' + status + '): ' + text.slice(0, 500));
  }
  
  const json = JSON.parse(text);
  return json.execution_id || null;
}

function prewarmFromRegistry() {
  Logger.log('Prewarming Dune queries...');
  
  const queryIds = new Set();
  
  Object.keys(METRICS).forEach(function(metricKey) {
    const spec = METRICS[metricKey];
    if (spec.adapter !== 'Dune') return;
    if (spec.dune && spec.dune.queryId) {
      queryIds.add(spec.dune.queryId);
    }
  });
  
  if (DUNE_IDS.PARTNERS) {
    queryIds.add(DUNE_IDS.PARTNERS);
  }
  
  Logger.log('Found ' + queryIds.size + ' unique Dune queries to prewarm');
  
  queryIds.forEach(function(queryId) {
    try {
      Logger.log('  Triggering execution for query ' + queryId + '...');
      const executionId = duneExecuteQuery(queryId);
      Logger.log('  Query ' + queryId + ' executing (execution_id: ' + executionId + ')');
    } catch (e) {
      Logger.log('  Query ' + queryId + ' failed: ' + e.message);
    }
  });
  
  Logger.log('Prewarm complete!');
}

/***** =========================================
 * 4) XDC SUBGRAPH HELPERS (GOLDSKY)
 * ========================================= *****/

function xdcYmdToDayISO(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const seconds = Math.floor(d.getTime() / 1000);
  return String(Math.floor(seconds / 86400));
}

function xdcDayISOToYmd(dayISO) {
  const dayNum = Number(dayISO);
  const seconds = dayNum * 86400;
  const d = new Date(seconds * 1000);
  return d.toISOString().slice(0, 10);
}

function xdcGqlRequest(queryStr) {
  const payload = JSON.stringify({ query: queryStr, variables: {} });
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    muteHttpExceptions: true,
    headers: { 'Accept': 'application/json' }
  };
  
  const res = UrlFetchApp.fetch(XDC_SUBGRAPH_URL, options);
  const status = res.getResponseCode();
  const text = res.getContentText();
  
  if (status < 200 || status >= 300) {
    throw new Error('XDC Subgraph HTTP error (' + status + '): ' + text.slice(0, 500));
  }
  
  const json = JSON.parse(text);
  
  if (json.errors && json.errors.length) {
    throw new Error('XDC Subgraph GraphQL errors: ' + JSON.stringify(json.errors));
  }
  
  return json.data;
}

function xdcFetchDailyField(spec, sinceDayISO, untilDayISO) {
  const fieldName = spec.field;
  
  const query = 'query { dailyUBIs(first: 365, orderBy: id, orderDirection: asc, where: { id_gte: "' + sinceDayISO + '", id_lte: "' + untilDayISO + '" }) { id ' + fieldName + ' } }';
  
  const data = xdcGqlRequest(query);
  
  if (!data || !data.dailyUBIs) {
    return [];
  }
  
  const nodes = data.dailyUBIs || [];
  const out = [];
  
  for (var i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const ymd = xdcDayISOToYmd(n.id);
    var val = Number(String(n[fieldName] || 0).replace(/,/g, ''));
    
    if (spec.divisor) {
      val = val / spec.divisor;
    }
    
    out.push({ date: ymd, value: val, source: 'XDC_SUBGRAPH' });
  }
  
  return out;
}

function xdcFetchGlobalTotal(spec, untilDate) {
  const fieldName = spec.field;
  
  const query = 'query { globalStatistics_collection(first: 1) { id ' + fieldName + ' } }';
  
  const data = xdcGqlRequest(query);
  
  if (!data || !data.globalStatistics_collection || !data.globalStatistics_collection.length) {
    return [];
  }
  
  const g = data.globalStatistics_collection[0];
  var val = Number(String(g[fieldName] || 0).replace(/,/g, ''));
  
  if (spec.divisor) {
    val = val / spec.divisor;
  }
  
  return [{ date: untilDate, value: val, source: 'XDC_SUBGRAPH' }];
}

function xdcFetchRollingSum(spec, sinceDayISO, untilDayISO) {
  const windowDays = spec.windowDays || 7;
  
  const sinceNum = Number(sinceDayISO);
  var extendedSinceNum = sinceNum - (windowDays - 1);
  if (extendedSinceNum < 0) extendedSinceNum = 0;
  const extendedSinceISO = String(extendedSinceNum);
  
  const dailyRows = xdcFetchDailyField(
    { type: 'daily_field', field: spec.field, divisor: spec.divisor },
    extendedSinceISO,
    untilDayISO
  );
  
  if (!dailyRows || !dailyRows.length) {
    return [];
  }
  
  const dayToValue = {};
  for (var i = 0; i < dailyRows.length; i++) {
    const row = dailyRows[i];
    const dayISO = xdcYmdToDayISO(row.date);
    dayToValue[dayISO] = row.value;
  }
  
  const untilNum = Number(untilDayISO);
  const out = [];
  
  for (var dayNum = sinceNum; dayNum <= untilNum; dayNum++) {
    var sum = 0;
    for (var lookback = 0; lookback < windowDays; lookback++) {
      sum += dayToValue[String(dayNum - lookback)] || 0;
    }
    
    out.push({ date: xdcDayISOToYmd(String(dayNum)), value: sum, source: 'XDC_SUBGRAPH' });
  }
  
  return out;
}

function xdcFetchTransactionDaily(spec, sinceDayISO, untilDayISO) {
  const fieldName = spec.field;
  
  const sinceTs = Number(sinceDayISO) * 86400;
  const untilTs = (Number(untilDayISO) + 1) * 86400;
  
  const query = 'query { transactionStats(first: 365, orderBy: id, orderDirection: asc, where: { id_not: "aggregated", id_gte: "' + sinceTs + '", id_lt: "' + untilTs + '" }) { id ' + fieldName + ' } }';
  
  const data = xdcGqlRequest(query);
  
  if (!data || !data.transactionStats) {
    return [];
  }
  
  const nodes = data.transactionStats || [];
  const out = [];
  
  for (var i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const ts = Number(n.id);
    const d = new Date(ts * 1000);
    const ymd = d.toISOString().slice(0, 10);
    
    var val = Number(String(n[fieldName] || 0).replace(/,/g, ''));
    
    if (spec.divisor) {
      val = val / spec.divisor;
    }
    
    out.push({ date: ymd, value: val, source: 'XDC_SUBGRAPH' });
  }
  
  return out;
}

function xdcFetchTransactionLifetime(spec, untilDate) {
  const fieldName = spec.field;
  
  const query = 'query { transactionStats(where: { id: "aggregated" }) { id ' + fieldName + ' } }';
  
  const data = xdcGqlRequest(query);
  
  if (!data || !data.transactionStats || !data.transactionStats.length) {
    return [];
  }
  
  const g = data.transactionStats[0];
  var val = Number(String(g[fieldName] || 0).replace(/,/g, ''));
  
  if (spec.divisor) {
    val = val / spec.divisor;
  }
  
  return [{ date: untilDate, value: val, source: 'XDC_SUBGRAPH' }];
}

function xdcFetchTransactionRolling(spec, sinceDayISO, untilDayISO) {
  const windowDays = spec.windowDays || 7;
  
  const sinceNum = Number(sinceDayISO);
  var extendedSinceNum = sinceNum - (windowDays - 1);
  if (extendedSinceNum < 0) extendedSinceNum = 0;
  const extendedSinceISO = String(extendedSinceNum);
  
  const dailyRows = xdcFetchTransactionDaily(
    { type: 'transaction_daily', field: spec.field, divisor: spec.divisor },
    extendedSinceISO,
    untilDayISO
  );
  
  if (!dailyRows || !dailyRows.length) {
    return [];
  }
  
  const dayToValue = {};
  for (var i = 0; i < dailyRows.length; i++) {
    const row = dailyRows[i];
    const dayISO = xdcYmdToDayISO(row.date);
    dayToValue[dayISO] = row.value;
  }
  
  const untilNum = Number(untilDayISO);
  const out = [];
  
  for (var dayNum = sinceNum; dayNum <= untilNum; dayNum++) {
    var sum = 0;
    for (var lookback = 0; lookback < windowDays; lookback++) {
      sum += dayToValue[String(dayNum - lookback)] || 0;
    }
    
    out.push({ date: xdcDayISOToYmd(String(dayNum)), value: sum, source: 'XDC_SUBGRAPH' });
  }
  
  return out;
}

/***** =========================================
 * 5) ADAPTERS
 * ========================================= *****/

const Adapters = {
  Dune: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec) {
      if (!spec) throw new Error('Missing dune spec for ' + metricKey);
      
      if (spec.type !== 'timeseries') {
        throw new Error('Unknown Dune spec type for ' + metricKey + ': ' + spec.type);
      }
      
      const result = duneFetchTable(spec.queryId, 10000);
      const rows = result.rows;
      if (!rows || !rows.length) return [];
      
      const dateIdx = spec.dateCol;
      const valueIdx = spec.valueCol;
      
      const tMin = parseYMD(sinceYMD).getTime();
      const tMax = parseYMD(untilYMD).getTime();
      
      const out = [];
      for (var i = 0; i < rows.length; i++) {
        const row = rows[i];
        const dStr = String(row[dateIdx] || '').slice(0, 10);
        if (dStr.length !== 10) continue;
        
        const t = parseYMD(dStr).getTime();
        if (t < tMin || t > tMax) continue;
        
        const raw = row[valueIdx];
        const val = Number(String(raw).replace(/,/g, '')) || 0;
        out.push({ date: dStr, value: val, source: 'DUNE' });
      }
      
      return out;
    },
    
    buildDateMap: function(spec) {
      const result = duneFetchTable(spec.queryId, 10000);
      const rows = result.rows;
      const map = {};
      
      for (var i = 0; i < rows.length; i++) {
        const row = rows[i];
        const dStr = String(row[spec.dateCol] || '').slice(0, 10);
        if (dStr.length !== 10) continue;
        
        const raw = row[spec.valueCol];
        const val = Number(String(raw).replace(/,/g, '')) || 0;
        map[dStr] = val;
      }
      
      return map;
    }
  },
  
  Subgraph: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec) {
      if (!spec) throw new Error('Missing xdc spec for ' + metricKey);
      
      if (sinceYMD < CONFIG.XDC_GENESIS) {
        sinceYMD = CONFIG.XDC_GENESIS;
      }
      
      const sinceDayISO = xdcYmdToDayISO(sinceYMD);
      const untilDayISO = xdcYmdToDayISO(untilYMD);
      
      switch (spec.type) {
        case 'daily_field':
          return xdcFetchDailyField(spec, sinceDayISO, untilDayISO);
        case 'global_total':
          return xdcFetchGlobalTotal(spec, untilYMD);
        case 'rolling_sum':
          return xdcFetchRollingSum(spec, sinceDayISO, untilDayISO);
        case 'transaction_daily':
          return xdcFetchTransactionDaily(spec, sinceDayISO, untilDayISO);
        case 'transaction_lifetime':
          return xdcFetchTransactionLifetime(spec, untilYMD);
        case 'transaction_rolling':
          return xdcFetchTransactionRolling(spec, sinceDayISO, untilDayISO);
        case 'computed':
          return [];
        default:
          throw new Error('Unknown XDC spec type for ' + metricKey + ': ' + spec.type);
      }
    },
    
    buildDateMap: function(spec, sinceYMD, untilYMD) {
      const results = this.fetch(null, 'XDC', sinceYMD, untilYMD, spec);
      const map = {};
      for (var i = 0; i < results.length; i++) {
        map[results[i].date] = results[i].value;
      }
      return map;
    }
  }
};

/***** =========================================
 * 6) CORE BUILD FUNCTION
 * ========================================= *****/

function buildRows(sinceYMD, untilYMD, existingIndex) {
  existingIndex = existingIndex || {};
  
  if (!sinceYMD || !untilYMD) {
    const ymd = getYesterdayYMD();
    sinceYMD = sinceYMD || ymd;
    untilYMD = untilYMD || ymd;
  }
  
  const startedAt = nowIso();
  const runIdStr = generateRunId();
  
  const rows = [];
  const health = [];
  
  function addHealth(subsystem, metricKey, chain, status, records, durationMs, error) {
    health.push({
      run_id: runIdStr,
      started_at: startedAt,
      subsystem: subsystem,
      metric_key: metricKey,
      chain: chain,
      status: status,
      records: records,
      duration_ms: durationMs,
      error: error || ''
    });
  }
  
  Logger.log('Run ' + runIdStr + ' — window ' + sinceYMD + '..' + untilYMD);
  
  const duneMetrics = [];
  const subgraphMetrics = [];
  
  const metricKeys = Object.keys(METRICS);
  for (var m = 0; m < metricKeys.length; m++) {
    const metricKey = metricKeys[m];
    const spec = METRICS[metricKey];
    const chains = (spec.chains || []).filter(function(c) { return CHAINS[c]; });
    if (!chains.length) continue;
    
    for (var c = 0; c < chains.length; c++) {
      const chain = chains[c];
      if (spec.adapter === 'Dune' && spec.dune) {
        duneMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      } else if (spec.adapter === 'Subgraph' && spec.xdc) {
        subgraphMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      }
    }
  }
  
  // Process Dune metrics
  const duneDataCache = {};
  const duneQueryIds = [];
  
  for (var i = 0; i < duneMetrics.length; i++) {
    const qid = duneMetrics[i].spec.dune.queryId;
    if (duneQueryIds.indexOf(qid) === -1) {
      duneQueryIds.push(qid);
    }
  }
  
  for (var i = 0; i < duneQueryIds.length; i++) {
    const queryId = duneQueryIds[i];
    try {
      const result = duneFetchTable(queryId, 10000);
      duneDataCache[queryId] = result.rows;
    } catch (e) {
      Logger.log('Dune query ' + queryId + ' error: ' + e.message);
      duneDataCache[queryId] = [];
    }
  }
  
  for (var i = 0; i < duneMetrics.length; i++) {
    const item = duneMetrics[i];
    const metricKey = item.metricKey;
    const spec = item.spec;
    const chain = item.chain;
    const t0 = Date.now();
    
    try {
      const rawRows = duneDataCache[spec.dune.queryId] || [];
      const dateIdx = spec.dune.dateCol;
      const valueIdx = spec.dune.valueCol;
      
      const tMin = parseYMD(sinceYMD).getTime();
      const tMax = parseYMD(untilYMD).getTime();
      
      var count = 0;
      for (var j = 0; j < rawRows.length; j++) {
        const row = rawRows[j];
        const dStr = String(row[dateIdx] || '').slice(0, 10);
        if (dStr.length !== 10) continue;
        
        const t = parseYMD(dStr).getTime();
        if (t < tMin || t > tMax) continue;
        
        const factKey = dStr + '|' + chain + '|' + metricKey;
        if (existingIndex[factKey]) continue;
        
        const raw = row[valueIdx];
        const val = Number(String(raw).replace(/,/g, '')) || 0;
        
        rows.push({
          date: dStr,
          chain: chain,
          metric_key: metricKey,
          value: val,
          source: 'DUNE',
          run_id: runIdStr,
          updated_at: startedAt
        });
        count++;
      }
      
      addHealth('DUNE', metricKey, chain, 'ok', count, Date.now() - t0);
      if (CONFIG.VERBOSE) {
        Logger.log('ok  ' + metricKey + '/' + chain + ': ' + count + ' row(s)');
      }
      
    } catch (e) {
      addHealth('DUNE', metricKey, chain, 'error', 0, Date.now() - t0, e.message);
      Logger.log('ERROR [' + metricKey + '/' + chain + ']: ' + e.message);
    }
  }
  
  // Process Subgraph metrics
  const xdcDauData = {};
  const xdcNewData = {};
  
  for (var i = 0; i < subgraphMetrics.length; i++) {
    const item = subgraphMetrics[i];
    const metricKey = item.metricKey;
    const spec = item.spec;
    const chain = item.chain;
    const t0 = Date.now();
    
    if (spec.xdc.type === 'computed') {
      continue;
    }
    
    try {
      var effectiveSince = sinceYMD;
      if (effectiveSince < CONFIG.XDC_GENESIS) {
        effectiveSince = CONFIG.XDC_GENESIS;
      }
      
      if (untilYMD < CONFIG.XDC_GENESIS) {
        addHealth('XDC_SUBGRAPH', metricKey, chain, 'skipped', 0, Date.now() - t0, 'before XDC genesis');
        continue;
      }
      
      const results = Adapters.Subgraph.fetch(metricKey, chain, effectiveSince, untilYMD, spec.xdc);
      
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        const r = results[j];
        const factKey = r.date + '|' + chain + '|' + metricKey;
        if (existingIndex[factKey]) continue;
        
        rows.push({
          date: r.date,
          chain: chain,
          metric_key: metricKey,
          value: r.value,
          source: r.source,
          run_id: runIdStr,
          updated_at: startedAt
        });
        count++;
        
        if (metricKey === 'xdc_dau') {
          xdcDauData[r.date] = r.value;
        } else if (metricKey === 'xdc_new_claimers') {
          xdcNewData[r.date] = r.value;
        }
      }
      
      addHealth('XDC_SUBGRAPH', metricKey, chain, 'ok', count, Date.now() - t0);
      if (CONFIG.VERBOSE) {
        Logger.log('ok  ' + metricKey + '/' + chain + ': ' + count + ' row(s)');
      }
      
    } catch (e) {
      addHealth('XDC_SUBGRAPH', metricKey, chain, 'error', 0, Date.now() - t0, e.message);
      Logger.log('ERROR [' + metricKey + '/' + chain + ']: ' + e.message);
    }
  }
  
  // Compute returning claimers
  if (METRICS.xdc_returning_claimers) {
    const dauDates = Object.keys(xdcDauData);
    for (var i = 0; i < dauDates.length; i++) {
      const date = dauDates[i];
      const factKey = date + '|XDC|xdc_returning_claimers';
      if (existingIndex[factKey]) continue;
      
      const dau = xdcDauData[date] || 0;
      const newUsers = xdcNewData[date] || 0;
      const returning = Math.max(0, dau - newUsers);
      
      rows.push({
        date: date,
        chain: 'XDC',
        metric_key: 'xdc_returning_claimers',
        value: returning,
        source: 'XDC_SUBGRAPH',
        run_id: runIdStr,
        updated_at: startedAt
      });
    }
    
    if (dauDates.length > 0) {
      addHealth('XDC_SUBGRAPH', 'xdc_returning_claimers', 'XDC', 'ok', dauDates.length, 0, 'computed');
    }
  }
  
  return { rows: rows, health: health, runId: runIdStr };
}

/***** =========================================
 * 7) WRITE FACTS AND HEALTH
 * ========================================= *****/

function writeFactsAndHealth(buildResult) {
  function numberFormatFor(dp) {
    return '#,##0' + (dp > 0 ? '.' + '0'.repeat(dp) : '');
  }
  
  function roundDp(n, dp) {
    const x = Number(n);
    if (!isFinite(x)) return 0;
    return Number(x.toFixed(dp));
  }
  
  ensureSheets();
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  const health = ss.getSheetByName(CONFIG.SHEET_HEALTH);
  
  var rows = [];
  const inputRows = buildResult.rows || [];
  for (var i = 0; i < inputRows.length; i++) {
    const r = inputRows[i];
    const spec = METRICS[r.metric_key] || {};
    const dp = (typeof spec.decimals === 'number') ? spec.decimals : 2;
    rows.push({
      date: r.date,
      chain: r.chain,
      metric_key: r.metric_key,
      value: roundDp(r.value, dp),
      decimals: dp,
      source: r.source || '',
      run_id: buildResult.runId || '',
      updated_at: nowIso()
    });
  }
  
  // Generate aggregate rows
  const aggSums = {};
  
  for (var i = 0; i < rows.length; i++) {
    const r = rows[i];
    const spec = METRICS[r.metric_key];
    if (!spec || spec.aggregate !== true) continue;
    if (r.chain === 'TOTAL' || r.chain === 'AGG') continue;
    
    var baseMetric = r.metric_key;
    if (baseMetric.indexOf('celo_') === 0) baseMetric = baseMetric.slice(5);
    else if (baseMetric.indexOf('xdc_') === 0) baseMetric = baseMetric.slice(4);
    
    const k = r.date + '|' + baseMetric;
    if (!aggSums[k]) {
      const dp = (typeof spec.decimals === 'number') ? spec.decimals : 2;
      aggSums[k] = { sum: 0, dp: dp, sources: [] };
    }
    aggSums[k].sum += Number(r.value) || 0;
    if (aggSums[k].sources.indexOf(r.source) === -1) {
      aggSums[k].sources.push(r.source);
    }
  }
  
  const aggKeys = Object.keys(aggSums);
  for (var i = 0; i < aggKeys.length; i++) {
    const k = aggKeys[i];
    const parts = k.split('|');
    const date = parts[0];
    const baseMetric = parts[1];
    const agg = aggSums[k];
    
    rows.push({
      date: date,
      chain: 'AGG',
      metric_key: 'agg_' + baseMetric,
      value: roundDp(agg.sum, agg.dp),
      decimals: agg.dp,
      source: agg.sources.join('+'),
      run_id: buildResult.runId || '',
      updated_at: nowIso()
    });
  }
  
  // Index existing facts
  const lastRow = facts.getLastRow();
  const existingIndex = {};
  
  if (lastRow > 1) {
    const existing = facts.getRange(2, 1, lastRow - 1, 3).getValues();
    for (var i = 0; i < existing.length; i++) {
      const d = existing[i][0];
      const chain = existing[i][1];
      const metric = existing[i][2];
      const dateStr = (d instanceof Date) ? formatYMD(d) : String(d).slice(0, 10);
      existingIndex[dateStr + '|' + chain + '|' + metric] = 2 + i;
    }
  }
  
  // Partition updates vs appends
  const updates = [];
  const appends = [];
  
  function toRow(r) {
    return [r.date, r.chain, r.metric_key, r.value, r.source, r.updated_at];
  }
  
  for (var i = 0; i < rows.length; i++) {
    const r = rows[i];
    const key = r.date + '|' + r.chain + '|' + r.metric_key;
    const rowNum = existingIndex[key];
    
    if (rowNum) {
      updates.push({ row: rowNum, values: toRow(r), dp: r.decimals });
    } else {
      appends.push({ values: toRow(r), dp: r.decimals });
    }
  }
  
  // Apply updates
  updates.sort(function(a, b) { return a.row - b.row; });
  for (var i = 0; i < updates.length; i++) {
    const u = updates[i];
    facts.getRange(u.row, 1, 1, u.values.length).setValues([u.values]);
    facts.getRange(u.row, 4).setNumberFormat(numberFormatFor(u.dp));
  }
  
  // Append new rows
  if (appends.length) {
    facts.insertRowsAfter(1, appends.length);
    const values = [];
    for (var i = 0; i < appends.length; i++) {
      values.push(appends[i].values);
    }
    facts.getRange(2, 1, values.length, values[0].length).setValues(values);
    
    for (var i = 0; i < appends.length; i++) {
      facts.getRange(2 + i, 4).setNumberFormat(numberFormatFor(appends[i].dp));
    }
  }
  
  // Write health records
  const healthData = buildResult.health || [];
  if (healthData.length) {
    const hv = [];
    for (var i = 0; i < healthData.length; i++) {
      const h = healthData[i];
      hv.push([h.run_id, h.started_at, h.subsystem, h.metric_key, h.chain, h.status, h.records, h.duration_ms, h.error]);
    }
    health.insertRowsAfter(1, hv.length);
    health.getRange(2, 1, hv.length, hv[0].length).setValues(hv);
  }
  
  Logger.log('Wrote ' + rows.length + ' fact rows (' + updates.length + ' updates, ' + appends.length + ' appends)');
}

/***** =========================================
 * 8) ORCHESTRATORS
 * ========================================= *****/

function runOneDaySinglePass(dateStr) {
  const ymd = dateStr || getYesterdayYMD();
  
  ensureSheets();
  const indexResult = getExistingFactsIndex();
  
  const result = buildRows(ymd, ymd, indexResult.index);
  writeFactsAndHealth(result);
  
  Logger.log('Daily run complete for ' + ymd);
}

function smartBackfill() {
  ensureSheets();
  
  const yesterday = getYesterdayYMD();
  const indexResult = getExistingFactsIndex();
  const index = indexResult.index;
  const maxDates = indexResult.maxDates;
  
  Logger.log('Smart Backfill starting...');
  Logger.log('Target: fill all metrics up to ' + yesterday);
  
  var earliestNeeded = yesterday;
  
  const metricKeys = Object.keys(METRICS);
  for (var m = 0; m < metricKeys.length; m++) {
    const metricKey = metricKeys[m];
    const spec = METRICS[metricKey];
    const chains = (spec.chains || []).filter(function(c) { return CHAINS[c]; });
    
    for (var c = 0; c < chains.length; c++) {
      const chain = chains[c];
      const chainMetricKey = chain + '|' + metricKey;
      const lastDate = maxDates[chainMetricKey];
      
      var startFrom;
      if (lastDate) {
        startFrom = addDays(lastDate, 1);
      } else {
        if (chain === 'XDC') {
          startFrom = CONFIG.XDC_GENESIS;
        } else {
          startFrom = addDays(yesterday, -90);
        }
      }
      
      if (chain === 'XDC' && startFrom < CONFIG.XDC_GENESIS) {
        startFrom = CONFIG.XDC_GENESIS;
      }
      
      if (startFrom < earliestNeeded && startFrom <= yesterday) {
        earliestNeeded = startFrom;
      }
      
      Logger.log('  ' + metricKey + '/' + chain + ': last=' + (lastDate || 'none') + ', will fetch from ' + startFrom);
    }
  }
  
  if (earliestNeeded > yesterday) {
    Logger.log('All metrics are up to date!');
    return;
  }
  
  Logger.log('Fetching data from ' + earliestNeeded + ' to ' + yesterday);
  
  const result = buildRows(earliestNeeded, yesterday, index);
  writeFactsAndHealth(result);
  
  Logger.log('Smart Backfill complete!');
}

function backfillRange(sinceYMD, untilYMD) {
  ensureSheets();
  const indexResult = getExistingFactsIndex();
  
  Logger.log('Backfilling ' + sinceYMD + ' to ' + untilYMD);
  
  const result = buildRows(sinceYMD, untilYMD, indexResult.index);
  writeFactsAndHealth(result);
  
  Logger.log('Backfill complete!');
}

function updatePartnersSheet() {
  Logger.log('Updating Partners sheet...');
  
  try {
    const result = duneFetchTable(DUNE_IDS.PARTNERS, 100);
    const rows = result.rows;
    const cols = result.cols;
    
    if (!rows || !rows.length || !cols || !cols.length) {
      Logger.log('Partners: No data returned, skipping update.');
      return;
    }
    
    const dataRows = [];
    for (var i = 0; i < rows.length; i++) {
      const row = [];
      for (var j = 0; j < cols.length; j++) {
        row.push(rows[i][cols[j]] || '');
      }
      dataRows.push(row);
    }
    
    const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
    var sheet = ss.getSheetByName('Partners');
    if (!sheet) {
      sheet = ss.insertSheet('Partners');
    }
    
    sheet.clearContents();
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
    if (dataRows.length) {
      sheet.getRange(2, 1, dataRows.length, cols.length).setValues(dataRows);
    }
    
    Logger.log('Partners updated: ' + dataRows.length + ' rows, ' + cols.length + ' columns');
    
  } catch (e) {
    Logger.log('Partners update error: ' + e.message);
  }
}

/***** =========================================
 * 9) TEST / DEBUG FUNCTIONS
 * ========================================= *****/

function testGoldskyConnection() {
  Logger.log('Testing Goldsky XDC Subgraph connection...');
  
  try {
    const query = 'query { globalStatistics_collection(first: 1) { id totalClaims uniqueClaimers totalUBIDistributed } }';
    const data = xdcGqlRequest(query);
    
    Logger.log('Success! Response:');
    Logger.log(JSON.stringify(data, null, 2));
  } catch (e) {
    Logger.log('Error: ' + e.message);
  }
}

function testGoldskyDailyData() {
  Logger.log('Testing Goldsky daily data fetch...');
  
  try {
    const query = 'query { dailyUBIs(first: 5, orderBy: id, orderDirection: desc) { id activeUsers newClaimers totalClaims totalUBIDistributed quota } }';
    
    const data = xdcGqlRequest(query);
    
    Logger.log('Success! Latest 5 days:');
    if (data && data.dailyUBIs) {
      for (var i = 0; i < data.dailyUBIs.length; i++) {
        const d = data.dailyUBIs[i];
        const ymd = xdcDayISOToYmd(d.id);
        Logger.log('  ' + ymd + ': DAU=' + d.activeUsers + ', newClaimers=' + d.newClaimers);
      }
    }
  } catch (e) {
    Logger.log('Error: ' + e.message);
  }
}

function testNewP2PMetrics() {
  Logger.log('=== Testing New XDC P2P Metrics ===');
  
  const sinceYMD = '2025-12-08';
  const untilYMD = '2025-12-11';
  const sinceDayISO = xdcYmdToDayISO(sinceYMD);
  const untilDayISO = xdcYmdToDayISO(untilYMD);
  
  Logger.log('1. Daily P2P transactions:');
  const daily = xdcFetchTransactionDaily({ field: 'transactionsCountClean' }, sinceDayISO, untilDayISO);
  for (var i = 0; i < daily.length; i++) {
    Logger.log('   ' + daily[i].date + ': ' + daily[i].value + ' txs');
  }
  
  Logger.log('2. Daily P2P volume:');
  const volume = xdcFetchTransactionDaily({ field: 'transactionsValueClean', divisor: 1e18 }, sinceDayISO, untilDayISO);
  for (var i = 0; i < volume.length; i++) {
    Logger.log('   ' + volume[i].date + ': ' + volume[i].value.toFixed(2) + ' G$');
  }
  
  Logger.log('3. Lifetime stats:');
  const lifetime = xdcFetchTransactionLifetime({ field: 'transactionsCountClean' }, untilYMD);
  Logger.log('   Lifetime P2P txs: ' + (lifetime.length ? lifetime[0].value : 0));
  
  const lifetimeVol = xdcFetchTransactionLifetime({ field: 'transactionsValueClean', divisor: 1e18 }, untilYMD);
  Logger.log('   Lifetime P2P volume: ' + (lifetimeVol.length ? lifetimeVol[0].value.toFixed(2) : 0) + ' G$');
  
  const circulation = xdcFetchTransactionLifetime({ field: 'totalInCirculation', divisor: 1e18 }, untilYMD);
  Logger.log('   G$ in circulation: ' + (circulation.length ? circulation[0].value.toFixed(2) : 0) + ' G$');
  
  Logger.log('4. 7-day rolling P2P txs:');
  const rolling = xdcFetchTransactionRolling({ field: 'transactionsCountClean', windowDays: 7 }, sinceDayISO, untilDayISO);
  for (var i = 0; i < rolling.length; i++) {
    Logger.log('   ' + rolling[i].date + ': ' + rolling[i].value + ' txs (7d sum)');
  }
  
  Logger.log('=== Test Complete ===');
}

function testBuildRows() {
  const yesterday = getYesterdayYMD();
  
  Logger.log('=== TEST RUN for ' + yesterday + ' ===');
  Logger.log('Metrics enabled: ' + Object.keys(METRICS).join(', '));
  
  const result = buildRows(yesterday, yesterday, {});
  
  Logger.log('Generated ' + result.rows.length + ' rows:');
  for (var i = 0; i < result.rows.length; i++) {
    const r = result.rows[i];
    Logger.log('  ' + r.date + ' | ' + r.chain + ' | ' + r.metric_key + ' = ' + r.value);
  }
  
  Logger.log('Health records: ' + result.health.length);
  for (var i = 0; i < result.health.length; i++) {
    const h = result.health[i];
    Logger.log('  ' + h.metric_key + '/' + h.chain + ': ' + h.status + ' (' + h.records + ' rows, ' + h.duration_ms + 'ms) ' + h.error);
  }
  
  Logger.log('=== TEST COMPLETE (no data written) ===');
}

function testDuneConnection() {
  Logger.log('Testing Dune connection...');
  
  try {
    const result = duneFetchTable(DUNE_IDS.ACTIVE_CLAIMERS, 3);
    
    Logger.log('Success! Columns: ' + result.columnNames.join(', '));
    Logger.log('First 3 rows:');
    for (var i = 0; i < Math.min(3, result.rows.length); i++) {
      Logger.log('  ' + i + ': ' + JSON.stringify(result.rows[i]));
    }
  } catch (e) {
    Logger.log('Error: ' + e.message);
  }
}

function previewSmartBackfill() {
  ensureSheets();
  
  const yesterday = getYesterdayYMD();
  const indexResult = getExistingFactsIndex();
  const maxDates = indexResult.maxDates;
  
  Logger.log('=== SMART BACKFILL PREVIEW ===');
  Logger.log('Target date: ' + yesterday);
  
  const metricKeys = Object.keys(METRICS);
  for (var m = 0; m < metricKeys.length; m++) {
    const metricKey = metricKeys[m];
    const spec = METRICS[metricKey];
    const chains = (spec.chains || []).filter(function(c) { return CHAINS[c]; });
    
    for (var c = 0; c < chains.length; c++) {
      const chain = chains[c];
      const chainMetricKey = chain + '|' + metricKey;
      const lastDate = maxDates[chainMetricKey];
      
      var startFrom;
      if (lastDate) {
        startFrom = addDays(lastDate, 1);
      } else {
        startFrom = (chain === 'XDC') ? CONFIG.XDC_GENESIS : addDays(yesterday, -90);
      }
      
      if (chain === 'XDC' && startFrom < CONFIG.XDC_GENESIS) {
        startFrom = CONFIG.XDC_GENESIS;
      }
      
      const daysNeeded = startFrom <= yesterday ? dateDiffDays(startFrom, yesterday) + 1 : 0;
      
      const status = daysNeeded === 0 ? 'up to date' : 'needs ' + daysNeeded + ' days (' + startFrom + ' to ' + yesterday + ')';
      Logger.log(metricKey + '/' + chain + ': ' + status);
    }
  }
  
  Logger.log('=== END PREVIEW ===');
}

function backfillNewP2PMetrics() {
  Logger.log('Backfilling new XDC P2P metrics...');
  
  ensureSheets();
  
  const sinceYMD = CONFIG.XDC_GENESIS;
  const untilYMD = getYesterdayYMD();
  
  const sinceDayISO = xdcYmdToDayISO(sinceYMD);
  const untilDayISO = xdcYmdToDayISO(untilYMD);
  
  const startedAt = nowIso();
  const runIdStr = generateRunId();
  const rows = [];
  
  Logger.log('Fetching daily P2P tx count...');
  const dailyTxCount = xdcFetchTransactionDaily({ field: 'transactionsCountClean' }, sinceDayISO, untilDayISO);
  for (var i = 0; i < dailyTxCount.length; i++) {
    rows.push({ date: dailyTxCount[i].date, chain: 'XDC', metric_key: 'xdc_p2p_tx_count', value: dailyTxCount[i].value, source: 'XDC_SUBGRAPH', updated_at: startedAt, decimals: 0 });
  }
  Logger.log('  Found ' + dailyTxCount.length + ' days');
  
  Logger.log('Fetching daily P2P volume...');
  const dailyVol = xdcFetchTransactionDaily({ field: 'transactionsValueClean', divisor: 1e18 }, sinceDayISO, untilDayISO);
  for (var i = 0; i < dailyVol.length; i++) {
    rows.push({ date: dailyVol[i].date, chain: 'XDC', metric_key: 'xdc_p2p_gd_amount', value: dailyVol[i].value, source: 'XDC_SUBGRAPH', updated_at: startedAt, decimals: 2 });
  }
  Logger.log('  Found ' + dailyVol.length + ' days');
  
  Logger.log('Computing 7d P2P tx count...');
  const rolling7dTx = xdcFetchTransactionRolling({ field: 'transactionsCountClean', windowDays: 7 }, sinceDayISO, untilDayISO);
  for (var i = 0; i < rolling7dTx.length; i++) {
    rows.push({ date: rolling7dTx[i].date, chain: 'XDC', metric_key: 'xdc_p2p_tx_count_7d', value: rolling7dTx[i].value, source: 'XDC_SUBGRAPH', updated_at: startedAt, decimals: 0 });
  }
  Logger.log('  Computed ' + rolling7dTx.length + ' days');
  
  Logger.log('Computing 30d P2P tx count...');
  const rolling30dTx = xdcFetchTransactionRolling({ field: 'transactionsCountClean', windowDays: 30 }, sinceDayISO, untilDayISO);
  for (var i = 0; i < rolling30dTx.length; i++) {
    rows.push({ date: rolling30dTx[i].date, chain: 'XDC', metric_key: 'xdc_p2p_tx_count_30d', value: rolling30dTx[i].value, source: 'XDC_SUBGRAPH', updated_at: startedAt, decimals: 0 });
  }
  Logger.log('  Computed ' + rolling30dTx.length + ' days');
  
  Logger.log('Computing 7d P2P volume...');
  const rolling7dVol = xdcFetchTransactionRolling({ field: 'transactionsValueClean', windowDays: 7, divisor: 1e18 }, sinceDayISO, untilDayISO);
  for (var i = 0; i < rolling7dVol.length; i++) {
    rows.push({ date: rolling7dVol[i].date, chain: 'XDC', metric_key: 'xdc_p2p_gd_amount_7d', value: rolling7dVol[i].value, source: 'XDC_SUBGRAPH', updated_at: startedAt, decimals: 2 });
  }
  Logger.log('  Computed ' + rolling7dVol.length + ' days');
  
  Logger.log('Computing 30d P2P volume...');
  const rolling30dVol = xdcFetchTransactionRolling({ field: 'transactionsValueClean', windowDays: 30, divisor: 1e18 }, sinceDayISO, untilDayISO);
  for (var i = 0; i < rolling30dVol.length; i++) {
    rows.push({ date: rolling30dVol[i].date, chain: 'XDC', metric_key: 'xdc_p2p_gd_amount_30d', value: rolling30dVol[i].value, source: 'XDC_SUBGRAPH', updated_at: startedAt, decimals: 2 });
  }
  Logger.log('  Computed ' + rolling30dVol.length + ' days');
  
  Logger.log('Fetching lifetime stats...');
  const lifetimeTx = xdcFetchTransactionLifetime({ field: 'transactionsCountClean' }, untilYMD);
  for (var i = 0; i < lifetimeTx.length; i++) {
    rows.push({ date: lifetimeTx[i].date, chain: 'XDC', metric_key: 'xdc_p2p_lifetime_tx_count', value: lifetimeTx[i].value, source: 'XDC_SUBGRAPH', updated_at: startedAt, decimals: 0 });
  }
  
  const lifetimeVol = xdcFetchTransactionLifetime({ field: 'transactionsValueClean', divisor: 1e18 }, untilYMD);
  for (var i = 0; i < lifetimeVol.length; i++) {
    rows.push({ date: lifetimeVol[i].date, chain: 'XDC', metric_key: 'xdc_p2p_lifetime_gd_amount', value: lifetimeVol[i].value, source: 'XDC_SUBGRAPH', updated_at: startedAt, decimals: 2 });
  }
  
  const circulation = xdcFetchTransactionLifetime({ field: 'totalInCirculation', divisor: 1e18 }, untilYMD);
  for (var i = 0; i < circulation.length; i++) {
    rows.push({ date: circulation[i].date, chain: 'XDC', metric_key: 'xdc_gd_in_circulation', value: circulation[i].value, source: 'XDC_SUBGRAPH', updated_at: startedAt, decimals: 2 });
  }
  
  Logger.log('Writing ' + rows.length + ' rows...');
  writeFactsAndHealth({ rows: rows, health: [], runId: runIdStr });
  
  Logger.log('Backfill complete!');
}

function fixRollingSumMetrics() {
  Logger.log('Fixing rolling sum metrics with fresh Goldsky data...');
  
  ensureSheets();
  
  const sinceYMD = CONFIG.XDC_GENESIS;
  const untilYMD = getYesterdayYMD();
  
  const sinceDayISO = xdcYmdToDayISO(sinceYMD);
  const untilDayISO = xdcYmdToDayISO(untilYMD);
  
  const startedAt = nowIso();
  const runIdStr = generateRunId();
  const rows = [];
  
  const rollingSumMetrics = [
    { key: 'xdc_gd_claimed_30d', field: 'totalUBIDistributed', windowDays: 30, divisor: 1e18, decimals: 2 },
    { key: 'xdc_gd_claimed_7d', field: 'totalUBIDistributed', windowDays: 7, divisor: 1e18, decimals: 2 },
    { key: 'xdc_gd_per_user_30d', field: 'quota', windowDays: 30, divisor: 1e18, decimals: 2 },
    { key: 'xdc_gd_per_user_7d', field: 'quota', windowDays: 7, divisor: 1e18, decimals: 2 }
  ];
  
  for (var m = 0; m < rollingSumMetrics.length; m++) {
    const metric = rollingSumMetrics[m];
    Logger.log('Processing ' + metric.key + '...');
    
    const spec = { field: metric.field, windowDays: metric.windowDays, divisor: metric.divisor };
    const results = xdcFetchRollingSum(spec, sinceDayISO, untilDayISO);
    
    for (var i = 0; i < results.length; i++) {
      rows.push({
        date: results[i].date,
        chain: 'XDC',
        metric_key: metric.key,
        value: results[i].value,
        source: 'XDC_SUBGRAPH',
        run_id: runIdStr,
        updated_at: startedAt,
        decimals: metric.decimals
      });
    }
    
    Logger.log('  Generated ' + results.length + ' rows');
  }
  
  Logger.log('Writing ' + rows.length + ' rows...');
  writeFactsAndHealth({ rows: rows, health: [], runId: runIdStr });
  
  Logger.log('Fix complete!');
}