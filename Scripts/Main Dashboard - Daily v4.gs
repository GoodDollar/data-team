/***** =========================================
 * GOODDOLLAR DASHBOARD v4.0.1
 * Updated: Goldsky subgraph integration for XDC
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
  
  // XDC genesis date (claiming started Nov 13, 2025)
  XDC_GENESIS: '2025-11-12',
};

const CHAINS = { CELO: true, XDC: true };

// NEW: Goldsky subgraph URL (replaces OnFinality)
const XDC_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/gd_xdc/1.2/gn';

const DUNE_IDS = {
  LIFETIMES:       '5966342',
  ACTIVE_CLAIMERS: '4834304',
  UBI_SUMMARIES:   '5710738',
  NEW_VS_RETURN:   '4834229',
  P2P_TRANSFERS:   '5521377',
  PARTNERS:        '5608955',
};

const PARTNERS_ID = {
PARTNERS:        '5608955',
};

/***** =========================================
 * METRICS REGISTRY
 * Updated field mappings for Goldsky schema:
 *   OnFinality             -> Goldsky
 *   dailyUniqueClaimers    -> activeUsers
 *   newUsers               -> newClaimers
 *   amountSum              -> totalUBIDistributed
 *   dailyUbi               -> quota
 *   totalUniqueUsers       -> uniqueClaimers (GlobalStatistics)
 *   totalClaims            -> totalClaims (GlobalStatistics)
 *   totalDistributed       -> totalUBIDistributed (GlobalStatistics)
 * ========================================= *****/

const METRICS = {  
  celo_dau: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.ACTIVE_CLAIMERS,
      dateCol: 0,
      valueCol: 1,
    },
  },
  xdc_dau: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdc: {
      type: 'daily_field',
      field: 'activeUsers',  // Changed from dailyUniqueClaimers
    },
  },
  celo_wau: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.ACTIVE_CLAIMERS,
      dateCol: 0,
      valueCol: 2,
    },
  },  
  celo_mau: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.ACTIVE_CLAIMERS,
      dateCol: 0,
      valueCol: 3,
    },
  },  
  celo_yau: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.LIFETIMES,
      dateCol: 0,
      valueCol: 9,
    },
  },  
  celo_new_claimers: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.NEW_VS_RETURN,
      dateCol: 0,
      valueCol: 2,
    },
  },  
  xdc_new_claimers: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdc: {
      type: 'daily_field',
      field: 'newClaimers',  // Changed from newUsers
    },
  },  
  celo_returning_claimers: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.NEW_VS_RETURN,
      dateCol: 0,
      valueCol: 3,
    },
  },  
  xdc_returning_claimers: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdc: {
      type: 'computed',
      // Computed as: xdc_dau - xdc_new_claimers
    },
  },  
  celo_p2p_tx_count: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.P2P_TRANSFERS,
      dateCol: 0,
      valueCol: 2,
    },
  },
  celo_p2p_gd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.P2P_TRANSFERS,
      dateCol: 0,
      valueCol: 3,
    },
  },
  celo_p2p_usd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.P2P_TRANSFERS,
      dateCol: 0,
      valueCol: 4,
    },
  },
  celo_p2p_senders: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.P2P_TRANSFERS,
      dateCol: 0,
      valueCol: 5,
    },
  },
  celo_p2p_receivers: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.P2P_TRANSFERS,
      dateCol: 0,
      valueCol: 6,
    },
  },
  celo_p2p_users: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.P2P_TRANSFERS,
      dateCol: 0,
      valueCol: 7,
    },
  },
  celo_p2p_lifetime_tx_count: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.LIFETIMES,
      dateCol: 0,
      valueCol: 1,
    },
  },
  celo_p2p_lifetime_gd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.LIFETIMES,
      dateCol: 0,
      valueCol: 2,
    },
  },
  celo_p2p_lifetime_unique_users: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.LIFETIMES,
      dateCol: 0,
      valueCol: 5,
    },
  },
  celo_lifetime_unique_claimers: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.LIFETIMES,
      dateCol: 0,
      valueCol: 6,
    },
  },
  xdc_lifetime_unique_claimers: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdc: {
      type: 'global_total',
      field: 'uniqueClaimers',  // Changed from totalUniqueUsers
    },
  },
  celo_lifetime_unique_claim_TXs: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.LIFETIMES,
      dateCol: 0,
      valueCol: 7,
    },
  },
  xdc_lifetime_claim_txs: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 0,
    xdc: {
      type: 'global_total',
      field: 'totalClaims',  // Same name in Goldsky
    },
  },
  celo_lifetime_claimed_gd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 1,
    },
  },
  xdc_lifetime_claimed_gd_amount: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: {
      type: 'global_total',
      field: 'totalUBIDistributed',  // Changed from totalDistributed
      divisor: 1e18,
    },
  },
  celo_lifetime_claimed_usd_amount: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 2,
    },
  },
  celo_gd_claimed_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 3,
    },
  },
  xdc_gd_claimed_30d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: {
      type: 'rolling_sum',
      field: 'totalUBIDistributed',  // Changed from amountSum
      windowDays: 30,
      divisor: 1e18,
    },
  },
  celo_usd_claimed_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 4,
    },
  },
  celo_gd_claimed_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 6,
    },
  },
  xdc_gd_claimed_7d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: {
      type: 'rolling_sum',
      field: 'totalUBIDistributed',  // Changed from amountSum
      windowDays: 7,
      divisor: 1e18,
    },
  },
  celo_usd_claimed_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 7,
    },
  },
  celo_gd_claimed_1d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 9,
    },
  },
  celo_usd_claimed_1d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 10,
    },
  },
  xdc_gd_claimed_1d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: {
      type: 'daily_field',
      field: 'totalUBIDistributed',  // Changed from amountSum
      divisor: 1e18,
    },
  },
  celo_gd_per_user_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 5,
    },
  },
  xdc_gd_per_user_30d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdc: {
      type: 'rolling_sum',
      field: 'quota',  // Changed from dailyUbi
      windowDays: 30,
      divisor: 1e18,
    },
  },
  celo_gd_per_user_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 8,
    },
  },
  xdc_gd_per_user_7d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdc: {
      type: 'rolling_sum',
      field: 'quota',  // Changed from dailyUbi
      windowDays: 7,
      divisor: 1e18,
    },
  },
  celo_gd_per_user_1d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.UBI_SUMMARIES,
      dateCol: 0,
      valueCol: 11,
    },
  },
  xdc_gd_per_user_1d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdc: {
      type: 'daily_field',
      field: 'quota',  // Changed from dailyUbi
      divisor: 1e18,
    },
  },
  gd_usd_price: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,
    decimals: 8,
    dune: {
      type: 'timeseries',
      queryId: DUNE_IDS.P2P_TRANSFERS,
      dateCol: 0,
      valueCol: 1,
    },
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
  // Format a Date object to YYYY-MM-DD string
  if (d instanceof Date) {
    return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  return String(d).slice(0, 10);
}
function parseYMD(value) {
  // Parse YYYY-MM-DD string or Date to midnight Date object
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
  // Flexible date parser for various formats
  if (v instanceof Date) return v;
  const s = String(v || '').trim();
  if (!s) return null;
  
  // Try direct ISO parse first
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }
  
  // Try Google Sheets / Date number
  if (/^\d+(\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (num > 40000 && num < 60000) {
      // Excel date serial
      return new Date((num - 25569) * 86400 * 1000);
    }
    // Unix timestamp check
    if (num > 1e12) return new Date(num);
    if (num > 1e9) return new Date(num * 1000);
  }
  
  // Fallback to native Date
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
  
  // Daily Facts sheet
  let facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  if (!facts) {
    facts = ss.insertSheet(CONFIG.SHEET_FACTS);
    facts.getRange(1, 1, 1, 6).setValues([
      ['date', 'chain', 'metric_key', 'value', 'source', 'updated_at']
    ]);
    facts.setFrozenRows(1);
  }
  
  // Health sheet
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
    
    const key = `${ymd}|${chain}|${metricKey}`;
    index[key] = true;
    
    const chainMetricKey = `${chain}|${metricKey}`;
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
  const rows = result.rows || [];
  const meta = result.metadata || {};
  const cols = meta.column_names || [];
  
  if (!rows.length) {
    Logger.log('Dune query ' + queryId + ': 0 rows returned');
  } else {
    Logger.log('Dune query ' + queryId + ': fetched ' + rows.length + ' rows');
  }
  
  return { rows, cols, columnNames: cols };
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
  
  Object.keys(METRICS).forEach((metricKey) => {
    const spec = METRICS[metricKey];
    if (spec.adapter !== 'Dune') return;
    
    const duneSpec = spec.dune;
    if (!duneSpec) return;
    
    if (duneSpec.queryId) {
      queryIds.add(duneSpec.queryId);
    }
  });
  
  // Also add Partners query
  if (DUNE_IDS.PARTNERS) {
    queryIds.add(DUNE_IDS.PARTNERS);
  }
  
  Logger.log('Found ' + queryIds.size + ' unique Dune queries to prewarm');
  
  // Trigger execution for each query
  queryIds.forEach((queryId) => {
    try {
      Logger.log('  Triggering execution for query ' + queryId + '...');
      const executionId = duneExecuteQuery(queryId);
      Logger.log('  ✓ Query ' + queryId + ' executing (execution_id: ' + executionId + ')');
    } catch (e) {
      Logger.log('  ✗ Query ' + queryId + ' failed: ' + e.message);
    }
  });
  
  Logger.log('Prewarm complete! Queries are now executing on Dune.');
  Logger.log('Results will be ready in ~5-15 minutes.');
}

/***** =========================================
 * 4) XDC SUBGRAPH HELPERS (GOLDSKY)
 * ========================================= *****/

// Convert YYYY-MM-DD to dayISO (days since Unix epoch)
// Goldsky uses standard Unix epoch (Jan 1, 1970), same dayISO format as before
function xdcYmdToDayISO(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const seconds = Math.floor(d.getTime() / 1000);
  // Goldsky uses days since epoch, matching the id field format
  return String(Math.floor(seconds / 86400));
}

// Convert dayISO back to YYYY-MM-DD
function xdcDayISOToYmd(dayISO) {
  const dayNum = Number(dayISO);
  const seconds = dayNum * 86400;
  const d = new Date(seconds * 1000);
  return d.toISOString().slice(0, 10);
}

function xdcGqlRequest(queryStr) {
  const payload = JSON.stringify({
    query: queryStr,
    variables: {}
  });
  
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

// Fetch daily field from Goldsky's dailyUBIs entity
function xdcFetchDailyField(spec, sinceDayISO, untilDayISO) {
  const fieldName = spec.field;
  
  // Goldsky uses different query syntax than OnFinality/SubQuery
  const query = `query {
    dailyUBIs(
      first: 365,
      orderBy: id,
      orderDirection: asc,
      where: {
        id_gte: "${sinceDayISO}",
        id_lte: "${untilDayISO}"
      }
    ) {
      id
      ${fieldName}
    }
  }`;
  
  const data = xdcGqlRequest(query);
  
  if (!data || !data.dailyUBIs) {
    return [];
  }
  
  const nodes = data.dailyUBIs || [];
  const out = [];
  
  for (const n of nodes) {
    const ymd = xdcDayISOToYmd(n.id);
    let val = Number(String(n[fieldName] || 0).replace(/,/g, ''));
    
    if (spec.divisor) {
      val = val / spec.divisor;
    }
    
    out.push({
      date: ymd,
      value: val,
      source: 'XDC_SUBGRAPH'
    });
  }
  
  return out;
}

// Fetch global totals from Goldsky's globalStatistics_collection
function xdcFetchGlobalTotal(spec, untilDate) {
  const fieldName = spec.field;
  
  const query = `query { 
    globalStatistics_collection(first: 1) { 
      id
      ${fieldName} 
    } 
  }`;
  
  const data = xdcGqlRequest(query);
  
  if (!data || !data.globalStatistics_collection || !data.globalStatistics_collection.length) {
    return [];
  }
  
  const g = data.globalStatistics_collection[0];
  let val = Number(String(g[fieldName] || 0).replace(/,/g, ''));
  
  if (spec.divisor) {
    val = val / spec.divisor;
  }
  
  return [{
    date: untilDate,
    value: val,
    source: 'XDC_SUBGRAPH'
  }];
}

// Fetch rolling sum (7d, 30d) by fetching daily values and computing
function xdcFetchRollingSum(spec, sinceDayISO, untilDayISO) {
  const windowDays = spec.windowDays || 7;
  
  // Extend backwards to compute first full window
  const sinceNum = Number(sinceDayISO);
  let extendedSinceNum = sinceNum - (windowDays - 1);
  if (extendedSinceNum < 0) extendedSinceNum = 0;
  const extendedSinceISO = String(extendedSinceNum);
  
  // Fetch daily values for the extended range
  const dailyRows = xdcFetchDailyField(
    { type: 'daily_field', field: spec.field, divisor: spec.divisor },
    extendedSinceISO,
    untilDayISO
  );
  
  if (!dailyRows || !dailyRows.length) {
    return [];
  }
  
  // Map dayISO -> value
  const dayToValue = {};
  for (const row of dailyRows) {
    const dayISO = xdcYmdToDayISO(row.date);
    dayToValue[dayISO] = row.value;
  }
  
  const untilNum = Number(untilDayISO);
  const out = [];
  
  // Build rolling sums for [sinceDayISO .. untilDayISO]
  for (let dayNum = sinceNum; dayNum <= untilNum; dayNum++) {
    let sum = 0;
    for (let lookback = 0; lookback < windowDays; lookback++) {
      sum += dayToValue[String(dayNum - lookback)] || 0;
    }
    
    out.push({
      date: xdcDayISOToYmd(String(dayNum)),
      value: sum,
      source: 'XDC_SUBGRAPH'
    });
  }
  
  return out;
}

/***** =========================================
 * 5) ADAPTERS
 * ========================================= *****/

const Adapters = {
   //Dune Adapter - fetches timeseries data from Dune Analytics
  Dune: {
    fetch(metricKey, chain, sinceYMD, untilYMD, spec) {
      if (!spec) throw new Error('Missing dune spec for ' + metricKey);
      
      if (spec.type !== 'timeseries') {
        throw new Error('Unknown Dune spec type for ' + metricKey + ': ' + spec.type);
      }
      
      const { rows } = duneFetchTable(spec.queryId, 10000);
      if (!rows || !rows.length) return [];
      
      const dateIdx = spec.dateCol;
      const valueIdx = spec.valueCol;
      
      const tMin = parseYMD(sinceYMD).getTime();
      const tMax = parseYMD(untilYMD).getTime();
      
      const out = [];
      for (const row of rows) {
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
    
    // Build a date->value map for efficient lookups (used by single-pass)
    buildDateMap(spec) {
      const { rows } = duneFetchTable(spec.queryId, 10000);
      const map = {};
      
      for (const row of rows) {
        const dStr = String(row[spec.dateCol] || '').slice(0, 10);
        if (dStr.length !== 10) continue;
        
        const raw = row[spec.valueCol];
        const val = Number(String(raw).replace(/,/g, '')) || 0;
        map[dStr] = val;
      }
      
      return map;
    }
  },
  
  // Subgraph Adapter - fetches data from XDC Goldsky subgraph
  Subgraph: {
    fetch(metricKey, chain, sinceYMD, untilYMD, spec) {
      if (!spec) throw new Error('Missing xdc spec for ' + metricKey);
      
      // Enforce XDC genesis date
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
          
        case 'computed':
          // Computed metrics are handled separately
          return [];
          
        default:
          throw new Error('Unknown XDC spec type for ' + metricKey + ': ' + spec.type);
      }
    },
    
    // Build a date->value map for XDC metrics
    buildDateMap(spec, sinceYMD, untilYMD) {
      const results = this.fetch(null, 'XDC', sinceYMD, untilYMD, spec);
      const map = {};
      for (const r of results) {
        map[r.date] = r.value;
      }
      return map;
    }
  }
};

/***** =========================================
 * 6) CORE BUILD FUNCTION
 * ========================================= *****/

function buildRows(sinceYMD, untilYMD, existingIndex) {
  const tz = CONFIG.TIMEZONE;
  existingIndex = existingIndex || {};
  
  // Default to yesterday
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
      subsystem,
      metric_key: metricKey,
      chain,
      status,
      records,
      duration_ms: durationMs,
      error: error || ''
    });
  }
  
  Logger.log('Run ' + runIdStr + ' — window ' + sinceYMD + '..' + untilYMD);
  
  // Group metrics by adapter for efficient fetching
  const duneMetrics = [];
  const subgraphMetrics = [];
  
  for (const [metricKey, spec] of Object.entries(METRICS)) {
    const chains = (spec.chains || []).filter(c => CHAINS[c]);
    if (!chains.length) continue;
    
    for (const chain of chains) {
      if (spec.adapter === 'Dune' && spec.dune) {
        duneMetrics.push({ metricKey, spec, chain });
      } else if (spec.adapter === 'Subgraph' && spec.xdc) {
        subgraphMetrics.push({ metricKey, spec, chain });
      }
    }
  }
  
  // ===== PROCESS DUNE METRICS =====
  // Pre-fetch all Dune data to minimize API calls
  const duneDataCache = {};
  const duneQueryIds = new Set();
  
  for (const { spec } of duneMetrics) {
    duneQueryIds.add(spec.dune.queryId);
  }
  
  // Fetch each unique query once
  for (const queryId of duneQueryIds) {
    try {
      const { rows: rawRows } = duneFetchTable(queryId, 10000);
      duneDataCache[queryId] = rawRows;
    } catch (e) {
      Logger.log('Dune query ' + queryId + ' error: ' + e.message);
      duneDataCache[queryId] = [];
    }
  }
  
  // Process each Dune metric
  for (const { metricKey, spec, chain } of duneMetrics) {
    const t0 = Date.now();
    
    try {
      const rawRows = duneDataCache[spec.dune.queryId] || [];
      const dateIdx = spec.dune.dateCol;
      const valueIdx = spec.dune.valueCol;
      
      const tMin = parseYMD(sinceYMD).getTime();
      const tMax = parseYMD(untilYMD).getTime();
      
      let count = 0;
      for (const row of rawRows) {
        const dStr = String(row[dateIdx] || '').slice(0, 10);
        if (dStr.length !== 10) continue;
        
        const t = parseYMD(dStr).getTime();
        if (t < tMin || t > tMax) continue;
        
        // Skip if already exists
        const factKey = dStr + '|' + chain + '|' + metricKey;
        if (existingIndex[factKey]) continue;
        
        const raw = row[valueIdx];
        const val = Number(String(raw).replace(/,/g, '')) || 0;
        
        rows.push({
          date: dStr,
          chain,
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
  
  // ===== PROCESS SUBGRAPH METRICS =====
  // Track DAU and new users for computing returning claimers
  const xdcDauData = {};
  const xdcNewData = {};
  
  for (const { metricKey, spec, chain } of subgraphMetrics) {
    const t0 = Date.now();
    
    // Skip computed metrics for now
    if (spec.xdc.type === 'computed') {
      continue;
    }
    
    try {
      // Enforce XDC genesis
      let effectiveSince = sinceYMD;
      if (effectiveSince < CONFIG.XDC_GENESIS) {
        effectiveSince = CONFIG.XDC_GENESIS;
      }
      
      // Skip if entire range is before genesis
      if (untilYMD < CONFIG.XDC_GENESIS) {
        addHealth('XDC_SUBGRAPH', metricKey, chain, 'skipped', 0, Date.now() - t0, 'before XDC genesis');
        continue;
      }
      
      const results = Adapters.Subgraph.fetch(metricKey, chain, effectiveSince, untilYMD, spec.xdc);
      
      let count = 0;
      for (const r of results) {
        // Skip if already exists
        const factKey = r.date + '|' + chain + '|' + metricKey;
        if (existingIndex[factKey]) continue;
        
        rows.push({
          date: r.date,
          chain,
          metric_key: metricKey,
          value: r.value,
          source: r.source,
          run_id: runIdStr,
          updated_at: startedAt
        });
        count++;
        
        // Track for returning claimers calculation
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
  
  // ===== COMPUTE RETURNING CLAIMERS =====
  // xdc_returning_claimers = xdc_dau - xdc_new_claimers
  if (METRICS.xdc_returning_claimers && Object.keys(xdcDauData).length) {
    for (const date of Object.keys(xdcDauData)) {
      const factKey = date + '|XDC|xdc_returning_claimers';
      if (existingIndex[factKey]) continue;
      
      const dau = xdcDauData[date] || 0;
      const newUsers = xdcNewData[date] || 0;
      const returning = Math.max(0, dau - newUsers);
      
      rows.push({
        date,
        chain: 'XDC',
        metric_key: 'xdc_returning_claimers',
        value: returning,
        source: 'XDC_SUBGRAPH',
        run_id: runIdStr,
        updated_at: startedAt
      });
    }
    
    addHealth('XDC_SUBGRAPH', 'xdc_returning_claimers', 'XDC', 'ok', 
              Object.keys(xdcDauData).length, 0, 'computed');
  }
  
  return { rows, health, runId: runIdStr };
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
  
  // 1) Normalize rows with per-metric decimals
  let rows = (buildResult.rows || []).map(r => {
    const spec = METRICS[r.metric_key] || {};
    const dp = (typeof spec.decimals === 'number') ? spec.decimals : 2;
    return {
      date: r.date,
      chain: r.chain,
      metric_key: r.metric_key,
      value: roundDp(r.value, dp),
      decimals: dp,
      source: r.source || '',
      run_id: buildResult.runId || '',
      updated_at: nowIso()
    };
  });
  
  // 2) Generate aggregate rows for metrics with aggregate:true
  const aggSums = {};
  
  rows.forEach(r => {
    const spec = METRICS[r.metric_key];
    if (!spec || spec.aggregate !== true) return;
    if (r.chain === 'TOTAL' || r.chain === 'AGG') return;
    
    let baseMetric = r.metric_key;
    if (baseMetric.startsWith('celo_')) baseMetric = baseMetric.slice(5);
    else if (baseMetric.startsWith('xdc_')) baseMetric = baseMetric.slice(4);
    
    const k = r.date + '|' + baseMetric;
    if (!aggSums[k]) {
      const dp = (typeof spec.decimals === 'number') ? spec.decimals : 2;
      aggSums[k] = { sum: 0, dp, sources: new Set() };
    }
    aggSums[k].sum += Number(r.value) || 0;
    aggSums[k].sources.add(r.source);
  });
  
  Object.entries(aggSums).forEach(([k, agg]) => {
    const [date, baseMetric] = k.split('|');
    rows.push({
      date,
      chain: 'AGG',
      metric_key: 'agg_' + baseMetric,
      value: roundDp(agg.sum, agg.dp),
      decimals: agg.dp,
      source: Array.from(agg.sources).join('+'),
      run_id: buildResult.runId || '',
      updated_at: nowIso()
    });
  });
  
  // 3) Index existing facts
  const lastRow = facts.getLastRow();
  const existingIndex = {};
  
  if (lastRow > 1) {
    const existing = facts.getRange(2, 1, lastRow - 1, 3).getValues();
    for (let i = 0; i < existing.length; i++) {
      const [d, chain, metric] = existing[i];
      const dateStr = (d instanceof Date)
        ? formatYMD(d)
        : String(d).slice(0, 10);
      existingIndex[dateStr + '|' + chain + '|' + metric] = 2 + i;
    }
  }
  
  // 4) Partition updates vs appends
  const updates = [];
  const appends = [];
  
  const toRow = r => [r.date, r.chain, r.metric_key, r.value, r.source, r.updated_at];
  
  rows.forEach(r => {
    const key = r.date + '|' + r.chain + '|' + r.metric_key;
    const rowNum = existingIndex[key];
    
    if (rowNum) {
      updates.push({ row: rowNum, values: toRow(r), dp: r.decimals });
    } else {
      appends.push({ values: toRow(r), dp: r.decimals });
    }
  });
  
  // 5) Apply updates
  updates.sort((a, b) => a.row - b.row);
  for (const u of updates) {
    facts.getRange(u.row, 1, 1, u.values.length).setValues([u.values]);
    facts.getRange(u.row, 4).setNumberFormat(numberFormatFor(u.dp));
  }
  
  // 6) Append new rows
  if (appends.length) {
    facts.insertRowsAfter(1, appends.length);
    const values = appends.map(a => a.values);
    facts.getRange(2, 1, values.length, values[0].length).setValues(values);
    
    for (let i = 0; i < appends.length; i++) {
      facts.getRange(2 + i, 4).setNumberFormat(numberFormatFor(appends[i].dp));
    }
  }
  
  // 7) Write health records
  const hv = (buildResult.health || []).map(h => [
    h.run_id, h.started_at, h.subsystem, h.metric_key, h.chain,
    h.status, h.records, h.duration_ms, h.error
  ]);
  
  if (hv.length) {
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
  const { index } = getExistingFactsIndex();
  
  const result = buildRows(ymd, ymd, index);
  writeFactsAndHealth(result);
  
  Logger.log('Daily run complete for ' + ymd);
}

function smartBackfill() {
  ensureSheets();
  
  const yesterday = getYesterdayYMD();
  const { index, maxDates } = getExistingFactsIndex();
  
  Logger.log('Smart Backfill starting...');
  Logger.log('Target: fill all metrics up to ' + yesterday);
  
  let earliestNeeded = yesterday;
  
  for (const [metricKey, spec] of Object.entries(METRICS)) {
    const chains = (spec.chains || []).filter(c => CHAINS[c]);
    
    for (const chain of chains) {
      const chainMetricKey = chain + '|' + metricKey;
      const lastDate = maxDates[chainMetricKey];
      
      let startFrom;
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
  const { index } = getExistingFactsIndex();
  
  Logger.log('Backfilling ' + sinceYMD + ' to ' + untilYMD);
  
  const result = buildRows(sinceYMD, untilYMD, index);
  writeFactsAndHealth(result);
  
  Logger.log('Backfill complete!');
}

function updatePartnersSheet() {
  const PARTNERS_LIMIT = 100;
  
  Logger.log('Updating Partners sheet...');
  
  try {
    const { rows, cols } = duneFetchTable(DUNE_IDS.PARTNERS, PARTNERS_LIMIT);
    
    if (!rows || !rows.length || !cols || !cols.length) {
      Logger.log('Partners: No data returned, skipping update.');
      return;
    }
    
    const dataRows = rows.map(r => cols.map(c => r[c] ?? ''));
    
    const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
    let sheet = ss.getSheetByName('Partners');
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
    const query = `query {
      dailyUBIs(first: 5, orderBy: id, orderDirection: desc) {
        id
        activeUsers
        newClaimers
        totalClaims
        totalUBIDistributed
        quota
      }
    }`;
    
    const data = xdcGqlRequest(query);
    
    Logger.log('Success! Latest 5 days:');
    if (data && data.dailyUBIs) {
      data.dailyUBIs.forEach(d => {
        const ymd = xdcDayISOToYmd(d.id);
        Logger.log('  ' + ymd + ': DAU=' + d.activeUsers + ', newClaimers=' + d.newClaimers);
      });
    }
  } catch (e) {
    Logger.log('Error: ' + e.message);
  }
}

function testBuildRows() {
  const yesterday = getYesterdayYMD();
  
  Logger.log('=== TEST RUN for ' + yesterday + ' ===');
  Logger.log('Metrics enabled: ' + Object.keys(METRICS).join(', '));
  
  const result = buildRows(yesterday, yesterday, {});
  
  Logger.log('\nGenerated ' + result.rows.length + ' rows:');
  for (const r of result.rows) {
    Logger.log('  ' + r.date + ' | ' + r.chain + ' | ' + r.metric_key + ' = ' + r.value);
  }
  
  Logger.log('\nHealth records: ' + result.health.length);
  for (const h of result.health) {
    Logger.log('  ' + h.metric_key + '/' + h.chain + ': ' + h.status + ' (' + h.records + ' rows, ' + h.duration_ms + 'ms) ' + h.error);
  }
  
  Logger.log('\n=== TEST COMPLETE (no data written) ===');
}

function testDuneConnection() {
  Logger.log('Testing Dune connection...');
  
  try {
    const { rows, columnNames } = duneFetchTable(DUNE_IDS.ACTIVE_CLAIMERS, 3);
    
    Logger.log('Success! Columns: ' + columnNames.join(', '));
    Logger.log('First 3 rows:');
    rows.slice(0, 3).forEach((r, i) => Logger.log('  ' + i + ': ' + JSON.stringify(r)));
  } catch (e) {
    Logger.log('Error: ' + e.message);
  }
}

function previewSmartBackfill() {
  ensureSheets();
  
  const yesterday = getYesterdayYMD();
  const { maxDates } = getExistingFactsIndex();
  
  Logger.log('=== SMART BACKFILL PREVIEW ===');
  Logger.log('Target date: ' + yesterday + '\n');
  
  for (const [metricKey, spec] of Object.entries(METRICS)) {
    const chains = (spec.chains || []).filter(c => CHAINS[c]);
    
    for (const chain of chains) {
      const chainMetricKey = chain + '|' + metricKey;
      const lastDate = maxDates[chainMetricKey];
      
      let startFrom;
      if (lastDate) {
        startFrom = addDays(lastDate, 1);
      } else {
        startFrom = (chain === 'XDC') ? CONFIG.XDC_GENESIS : addDays(yesterday, -90);
      }
      
      if (chain === 'XDC' && startFrom < CONFIG.XDC_GENESIS) {
        startFrom = CONFIG.XDC_GENESIS;
      }
      
      const daysNeeded = startFrom <= yesterday ? dateDiffDays(startFrom, yesterday) + 1 : 0;
      
      const status = daysNeeded === 0 ? '✓ up to date' : 'needs ' + daysNeeded + ' days (' + startFrom + ' to ' + yesterday + ')';
      Logger.log(metricKey + '/' + chain + ': ' + status);
    }
  }
  
  Logger.log('\n=== END PREVIEW ===');
}