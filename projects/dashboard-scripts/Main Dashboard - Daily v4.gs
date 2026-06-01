/***** =========================================
 * GOODDOLLAR DASHBOARD v4.1.1
 * =========================================
 *
 * OVERVIEW
 * --------
 * This Google Apps Script fetches daily metrics from multiple data sources
 * (Dune Analytics, Goldsky subgraphs, on-chain RPC, block explorer APIs),
 * computes derived values, and writes everything into a Google Sheet
 * ("Daily Facts") as a flat fact table: one row per (date, chain, metric).
 *
 * ARCHITECTURE
 * ------------
 * The pipeline has 5 layers, each in its own numbered section below:
 *
 *   0) CONFIG / CONSTANTS / REGISTRY
 *      - CONFIG: spreadsheet IDs, timezone, genesis dates.
 *      - CHAINS: which chains are enabled (CELO, XDC, ETH, FUSE).
 *      - METRICS: the registry. Each metric declares its adapter, chains,
 *        aggregation flag, and adapter-specific fetch parameters. The
 *        registry drives the entire pipeline — add a new metric here and
 *        buildRows() picks it up automatically.
 *
 *   1-4) UTILITY + DATA-SOURCE HELPERS
 *      - Date parsing/formatting, sheet I/O, API clients.
 *      - Each data source has its own helper section:
 *          3)  Dune Analytics (SQL query results via REST API)
 *          4a) XDC Subgraph (Goldsky — UBI, claims, P2P transactions)
 *          4b) CELO Reserve Subgraph (Goldsky — G$ price, swap volumes)
 *          4c) XDC Reserve Subgraph + On-chain RPC (G$ price, reserve balances)
 *          4d) Supply helpers (Etherscan, Celo/Fuse explorers — token supply)
 *
 *   5) ADAPTERS
 *      - Adapter objects that map metric specs to the right fetch function.
 *      - Each adapter has a .fetch() method that returns [{date, value, source}].
 *      - Processing order matters: Dune → Subgraph → Reserve → Computed →
 *        Supply → SupplyComputed → XdcReserve → XdcReserveComputed.
 *        Later adapters can depend on rows produced by earlier ones.
 *
 *   6) buildRows()
 *      - Core orchestrator. Iterates the METRICS registry, routes each
 *        metric to its adapter, collects rows, and deduplicates against
 *        the existing facts index to avoid writing duplicate data.
 *
 *   7) writeFactsAndHealth()
 *      - Writes rows to the "Daily Facts" sheet (upsert: updates existing
 *        rows by date+chain+metric key, appends new ones).
 *      - Also generates "AGG" (aggregate) rows by summing chain-specific
 *        metrics that have `aggregate: true`.
 *      - Writes health/audit records to the "Health Runs" sheet.
 *
 *   8) ORCHESTRATORS
 *      - Entry points: runOneDaySinglePass() (daily cron), smartBackfill()
 *        (fills gaps), backfillRange() (manual date range).
 *
 *   9-10) TEST / DEBUG functions (safe to run; they don't write data
 *         unless noted).
 *
 * MULTI-CHAIN NAMING CONVENTION
 * -----------------------------
 * Metric keys are prefixed by chain: celo_*, xdc_*, eth_*, fuse_*, agg_*.
 * This ensures no collisions and makes it trivial to filter by chain
 * in the spreadsheet. Exception: gd_usd_price (CELO-only, legacy name).
 *
 * DATA FRESHNESS / TEMPORAL MODEL
 * --------------------------------
 * The script always reports data for YESTERDAY (T-1). This ensures a
 * complete 24-hour window. Subgraph entities are day-keyed or timestamp-
 * filtered (precise). Dune queries are pre-aggregated by day (precise).
 *
 * On-chain RPC reads (reserve liquidity, token supply) use `latest`
 * block and label the result as yesterday. This means the value reflects
 * the balance at script execution time (~01:00 UTC), not exactly at
 * midnight. For most days this is fine because reserve changes are
 * infrequent. XDC public RPC nodes do NOT support historical state
 * queries (they prune trie data), so reading at a past block is not
 * possible without an archive node.
 *
 * CHANGELOG v4.1.1
 * -----------------
 * - Added XDC reserve metrics: xdc_gd_price, xdc_reserve_liquidity_usd,
 *   gd_price_spread, xdc_reserve_backing_ratio, xdc_daily_gd_minted,
 *   xdc_reserve_growth_abs.
 * - Price fetch filters by target day's UTC timestamp range with carry-forward
 *   fallback for days with no swap activity (subgraph is timestamp-indexed,
 *   so this is precise).
 * - Fixed backfill bug: reserve_growth now uses findValue() (batch+facts)
 *   instead of findInFacts() (facts-only) for yesterday lookup.
 * - Reverted liquidity balance reads to `latest` — XDC public RPC nodes
 *   prune historical state, so eth_call at past blocks fails with
 *   "missing trie node". The `latest` approach has a known temporal
 *   imprecision (reads now, labels as yesterday) but is the only option
 *   without an archive node. See section 4c header for details.
 * - Added comprehensive code documentation.
 *****/

/***** =========================================
 * 0) CONFIG / CONSTANTS / REGISTRY
 * =========================================
 * Central configuration. Change spreadsheet IDs, enable/disable chains,
 * or add new Dune query IDs here. The METRICS registry below drives the
 * entire pipeline — each entry maps a metric key to its data source and
 * fetch parameters.
 *****/

/** Pipeline settings */
const CONFIG = {
  DEST_SPREADSHEET_ID: '1vZoUwOi9EKAABqy6TIeW1XWdChwvDPL71YJWlwy5AXo',
  SHEET_FACTS:  'Daily Facts',   // Main output: one row per (date, chain, metric)
  SHEET_HEALTH: 'Health Runs',   // Audit log: one row per (run, metric, status)
  TIMEZONE: Session.getScriptTimeZone() || 'America/Sao_Paulo',
  VERBOSE: true,                 // Log every metric result (ok/error) during runs
  XDC_GENESIS: '2025-11-12',    // First day with XDC chain data — skip earlier dates
};

/** Which chains to process. Set to false to skip a chain entirely. */
const CHAINS = { CELO: true, XDC: true, ETH: true, FUSE: true };

/** Goldsky subgraph endpoints */
const XDC_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/gd_xdc/1.2/gn';
const RESERVE_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/reserve_celo/1.0/gn';
const XDC_RESERVE_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/reserve_xdc/v1.0.0/gn';

/** G$ token contract addresses per chain — used by Supply helpers */
const SUPPLY_CONTRACTS = {
  ETH_GD: '0x67C5870b4A41D4Ebef24d2456547A03F1f3e094B',
  FUSE_GD: '0x495d133B938596C9984d462F007B676bDc57eCEC',
  CELO_GD: '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A',
  FROZEN_WALLET_1: '0xec577447d314cf1e443e9f4488216651450dbe7c', // ETH frozen supply wallet
  FROZEN_WALLET_2: '0x6738fa889ff31f82d9fe8862ec025dbe318f3fde'  // ETH frozen supply wallet
};

/**
 * XDC Reserve on-chain addresses.
 * The reserve contract holds collateral stablecoins backing the XDC G$ supply.
 * USDC (6 decimals) and USDm (18 decimals) are both USD-pegged, so
 * balances can be summed directly for total liquidity in USD.
 */
const XDC_RESERVE_CONTRACT = '0x94A3240f484A04F5e3d524f528d02694c109463b';
const XDC_COLLATERAL_TOKENS = {
  USDC:  { address: '0xfa2958cb79b0491cc627c1557f441ef849ca8eb1', decimals: 6 },
  USDm:  { address: '0x765de816845861e75a25fca122bb6898b8b1282a', decimals: 18 },
};
const XDC_RPC_URL = 'https://erpc.xinfin.network';

/** Dune Analytics query IDs — each powers one or more metrics via column indices */
const DUNE_IDS = {
  LIFETIMES:       '5966342',
  ACTIVE_CLAIMERS: '4834304',
  UBI_SUMMARIES:   '5710738',
  NEW_VS_RETURN:   '4834229',
  P2P_TRANSFERS:   '5521377',
  PARTNERS:        '5608955',
};

/**
 * METRICS REGISTRY
 * Each entry declares how to fetch one metric. The key becomes the metric_key
 * in the facts table. Properties:
 *   adapter    — which Adapter to use (Dune, Subgraph, Reserve, Computed, etc.)
 *   chains     — which chains this metric applies to
 *   aggregate  — if true, writeFactsAndHealth() sums chain values into an AGG row
 *   decimals   — rounding precision for the stored value
 *   [adapter-specific config] — e.g. dune.queryId, xdc.field, reserve.type, etc.
 *
 * To add a new metric: add an entry here, and if it uses an existing adapter
 * type, it will be picked up automatically by buildRows(). If it needs a new
 * adapter, also add the adapter to the Adapters object and wire it into buildRows().
 */
const METRICS = {
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
    aggregate: false,  // No XDC equivalent yet
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 4 },
  },
  // NEW: P2P 7-day rolling metrics
  celo_p2p_tx_count_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 5 },
  },
  celo_p2p_gd_amount_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 6 },
  },
  celo_p2p_usd_amount_7d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,  // No XDC equivalent yet
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 7 },
  },
  // NEW: P2P 30-day rolling metrics
  celo_p2p_tx_count_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 8 },
  },
  celo_p2p_gd_amount_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 9 },
  },
  celo_p2p_usd_amount_30d: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: false,  // No XDC equivalent yet
    decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 10 },
  },
  // P2P user counts - NOT aggregated (risk of double-counting across chains)
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
    aggregate: false,  // No XDC equivalent
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
  celo_lifetime_claim_txs: {
    adapter: 'Dune',
    chains: ['CELO'],
    aggregate: true,
    decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 7 },
  },
  xdc_lifetime_claim_txs: {
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
  xdc_p2p_tx_count_7d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 0,
    xdc: { type: 'transaction_rolling', field: 'transactionsCountClean', windowDays: 7 },
  },
  xdc_p2p_tx_count_30d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 0,
    xdc: { type: 'transaction_rolling', field: 'transactionsCountClean', windowDays: 30 },
  },
  xdc_p2p_gd_amount_7d: {
    adapter: 'Subgraph',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    xdc: { type: 'transaction_rolling', field: 'transactionsValueClean', windowDays: 7, divisor: 1e18 },
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
  
  // ===== PRICE (from Reserve subgraph) =====
  celo_gd_price: {
    adapter: 'Reserve',
    chains: ['CELO'],
    aggregate: false,
    decimals: 8,
    reserve: { type: 'daily_avg_price' },
  },
  
  // ===== RESERVE VOLUME METRICS =====
  celo_reserve_in: {
    adapter: 'Reserve',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    reserve: { type: 'daily_volume', field: 'amountIn' },
  },
  celo_reserve_out: {
    adapter: 'Reserve',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    reserve: { type: 'daily_volume', field: 'amountOut' },
  },
  celo_reserve_volume: {
    adapter: 'Reserve',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    reserve: { type: 'daily_volume', field: 'volume' },
  },
  
  // ===== XDC USD METRICS (computed from gd_usd_price) =====
  xdc_p2p_usd_amount: {
    adapter: 'Computed',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_p2p_gd_amount' },
  },
  xdc_lifetime_claimed_usd_amount: {
    adapter: 'Computed',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_lifetime_claimed_gd_amount' },
  },
  xdc_usd_claimed_30d: {
    adapter: 'Computed',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_gd_claimed_30d' },
  },
  xdc_usd_claimed_7d: {
    adapter: 'Computed',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_gd_claimed_7d' },
  },
  xdc_usd_claimed_1d: {
    adapter: 'Computed',
    chains: ['XDC'],
    aggregate: true,
    decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_gd_claimed_1d' },
  },
  
  // ===== SUPPLY METRICS =====
  eth_gd_total_supply: {
    adapter: 'Supply',
    chains: ['ETH'],
    aggregate: false,
    decimals: 2,
    supply: { type: 'eth_total' },
  },
  eth_gd_frozen_supply: {
    adapter: 'Supply',
    chains: ['ETH'],
    aggregate: false,
    decimals: 2,
    supply: { type: 'eth_frozen' },
  },
  eth_gd_in_circulation: {
    adapter: 'SupplyComputed',
    chains: ['ETH'],
    aggregate: false,
    decimals: 2,
    supplyComputed: { type: 'eth_circulating' },
  },
  fuse_gd_in_circulation: {
    adapter: 'Supply',
    chains: ['FUSE'],
    aggregate: false,
    decimals: 2,
    supply: { type: 'fuse_supply' },
  },
  celo_gd_in_circulation: {
    adapter: 'Supply',
    chains: ['CELO'],
    aggregate: false,
    decimals: 2,
    supply: { type: 'celo_supply' },
  },
  // xdc_gd_in_circulation is already defined above
  agg_gd_in_circulation: {
    adapter: 'SupplyComputed',
    chains: ['AGG'],
    aggregate: false,
    decimals: 2,
    supplyComputed: { type: 'total_circulating' },
  },
  
  // ===== XDC RESERVE METRICS =====
  // These read directly from the XDC reserve subgraph and on-chain RPC.
  // They run AFTER Supply/SupplyComputed so that xdc_gd_in_circulation
  // is available for the backing ratio calculation.
  
  xdc_gd_price: {
    // G$ price on the XDC reserve (day-averaged from swap events).
    // Raw subgraph price is divided by 1e6. See xdcReserveFetchGdPrice().
    adapter: 'XdcReserve',
    chains: ['XDC'],
    aggregate: false,
    decimals: 8,
    xdcReserve: { type: 'gd_price' },
  },
  xdc_reserve_liquidity_usd: {
    // Sum of all collateral token balances in the XDC reserve contract.
    // Read at historical block (end-of-day UTC) for temporal accuracy.
    adapter: 'XdcReserve',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdcReserve: { type: 'reserve_liquidity' },
  },
  
  // ===== XDC RESERVE COMPUTED METRICS =====
  // These depend on XdcReserve and other metrics already in the batch.
  // They run LAST in the pipeline (after all other adapters).
  
  gd_price_spread: {
    // xdc_gd_price - gd_usd_price (CELO). Positive = XDC price higher.
    adapter: 'XdcReserveComputed',
    chains: ['XDC'],
    aggregate: false,
    decimals: 8,
    xdcReserveComputed: { type: 'price_spread' },
  },
  xdc_reserve_backing_ratio: {
    // reserve_liquidity_usd / xdc_gd_in_circulation.
    // Values < 1 = undercollateralized; > 1 = overcollateralized.
    adapter: 'XdcReserveComputed',
    chains: ['XDC'],
    aggregate: false,
    decimals: 8,
    xdcReserveComputed: { type: 'backing_ratio' },
  },
  xdc_daily_gd_minted: {
    // Today's cumulative UBI - yesterday's. Computed from subgraph dailyUBIs.
    adapter: 'XdcReserveComputed',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdcReserveComputed: { type: 'daily_minted' },
  },
  xdc_reserve_growth_abs: {
    // Absolute USD change in reserve liquidity day-over-day.
    // Example: reserve grew from $8.33 to $50,009.32 → growth = $50,000.99
    adapter: 'XdcReserveComputed',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdcReserveComputed: { type: 'reserve_growth_abs' },
  },
  // ===== XDC INVITES (Hypersync) =====
  // Daily aggregates derived from on-chain InviteeJoined / InviterBounty
  // events ingested via Envio Hypersync. The XdcInvites adapter reads
  // from the "XDC Invites Raw" sheet (which is populated by the
  // updateXdcInvitesPipeline() orchestrator in xdc_invites.gs) rather
  // than re-fetching from Hypersync, so the daily run is fast and the
  // expensive sweep is decoupled into its own time trigger.
  xdc_invites_total: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_invites_total' },
  },
  xdc_invites_unique_inviters: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_invites_unique_inviters' },
  },
  xdc_invites_unique_invitees: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_invites_unique_invitees' },
  },
  xdc_invites_campaign_joins: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_invites_campaign_joins' },
  },
  xdc_invites_referral_joins: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_invites_referral_joins' },
  },
  xdc_invites_no_code_joins: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_invites_no_code_joins' },
  },
  xdc_invites_per_inviter_avg: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 4,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_invites_per_inviter_avg' },
  },
  xdc_bounty_events_total: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 0,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_bounty_events_total' },
  },
  xdc_bounty_paid_inviters: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_bounty_paid_inviters' },
  },
  xdc_bounty_paid_invitees: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_bounty_paid_invitees' },
  },
  xdc_bounty_paid_total: {
    adapter: 'XdcInvites',
    chains: ['XDC'],
    aggregate: false,
    decimals: 2,
    xdcInvites: { type: 'daily_metric', metricKey: 'xdc_bounty_paid_total' },
  },
};

/***** =========================================
 * 1) UTILITY HELPERS
 * =========================================
 * Date parsing, formatting, and arithmetic. All dates in this script
 * use 'YYYY-MM-DD' strings ("YMD" format) as the canonical representation.
 * The pipeline converts to/from Date objects and "dayISO" integers
 * (unix-days = seconds_since_epoch / 86400) as needed by subgraph queries.
 *****/

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
 * =========================================
 * Functions for creating sheets and building an index of existing data.
 * The existing-facts index prevents duplicate writes: before inserting
 * a row, we check if (date, chain, metric_key) already exists.
 *****/

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
  // XDC invites sheets (created by xdc_invites.gs on first write,
  // but we initialize them here so they appear in the spreadsheet
  // immediately on fresh deploys).
  if (typeof xdcInvitesEnsureRawSheet === 'function') {
    try { xdcInvitesEnsureRawSheet(); } catch (e) { Logger.log('xdc invites raw sheet init: ' + e.message); }
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
 * =========================================
 * Dune Analytics provides pre-computed SQL query results via REST API.
 * Each Dune query returns a table of rows. The METRICS registry maps
 * each metric to a (queryId, dateCol, valueCol) tuple — the adapter
 * fetches the table, then extracts the date and value from the
 * specified column indices.
 *
 * DUNE_API_KEY must be set in Script Properties.
 *****/

function duneApiKey() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('DUNE_API_KEY');
  if (!key) throw new Error('Missing DUNE_API_KEY in Script Properties');
  return key;
}

function etherscanApiKey() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ETHERSCAN_API_KEY');
  if (!key) throw new Error('Missing ETHERSCAN_API_KEY in Script Properties');
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
 * 4a) XDC SUBGRAPH HELPERS (GOLDSKY)
 * =========================================
 * The XDC GoodDollar subgraph indexes UBI claims, P2P transfers, and
 * user activity on the XDC chain. It uses "dayISO" as entity IDs:
 *   dayISO = floor(unix_timestamp / 86400)
 * This is a UTC day number, so entity ID "20000" = day 20000 since epoch.
 *
 * Main entities queried:
 *   dailyUBIs          — per-day UBI stats (activeUsers, newClaimers, etc.)
 *   globalStatistics    — lifetime totals (uniqueClaimers, totalClaims, etc.)
 *   transactionStats    — P2P transfer stats (daily + aggregated lifetime)
 *
 * The "rolling sum" and "rolling transaction" functions compute N-day
 * windows client-side by fetching extra lookback days and summing.
 *****/

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
 * 4b) CELO RESERVE SUBGRAPH HELPERS (GOLDSKY)
 * =========================================
 * The CELO reserve subgraph indexes Mento reserve swap events on Celo.
 * Used for: gd_usd_price (daily average), celo_reserve_in/out/volume.
 *
 * Entities use dayISO IDs (same format as XDC subgraph). Each
 * reservePrice record has: day, price (1e18 scale), amountIn, amountOut,
 * timestamp. Daily averages are computed by averaging all events for a day.
 *
 * NOTE: This section is NOT modified for XDC reserve support — the XDC
 * reserve uses a separate subgraph and separate helper functions (section 4c).
 *****/

// Reuse day conversion functions from XDC (same format)
function dayISOToYmd(dayISO) {
  var dayNum = Number(dayISO);
  var seconds = dayNum * 86400;
  var d = new Date(seconds * 1000);
  return d.toISOString().slice(0, 10);
}

function ymdToDayISO(ymd) {
  var d = new Date(ymd + 'T00:00:00Z');
  var seconds = Math.floor(d.getTime() / 1000);
  return String(Math.floor(seconds / 86400));
}

function reserveGqlRequest(queryStr) {
  var payload = JSON.stringify({ query: queryStr, variables: {} });
  
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    muteHttpExceptions: true,
    headers: { 'Accept': 'application/json' }
  };
  
  var res = UrlFetchApp.fetch(RESERVE_SUBGRAPH_URL, options);
  var status = res.getResponseCode();
  var text = res.getContentText();
  
  if (status < 200 || status >= 300) {
    throw new Error('Reserve Subgraph HTTP error (' + status + '): ' + text.slice(0, 500));
  }
  
  var json = JSON.parse(text);
  
  if (json.errors && json.errors.length) {
    throw new Error('Reserve Subgraph GraphQL errors: ' + JSON.stringify(json.errors));
  }
  
  return json.data;
}

function reserveFetchDailyAvgPrice(sinceDayISO, untilDayISO) {
  // Fetch the average G$ price for the target day (untilDayISO).
  // If no reservePrices entities exist for that day (no swap activity that
  // produced a price tick), fall back to the most recent prior price so we
  // NEVER return an empty array — gd_usd_price must have a value every day.
  var ymd = dayISOToYmd(untilDayISO);

  var query = 'query { reservePrices(first: 1000, orderBy: timestamp, orderDirection: desc, where: { day: "' + untilDayISO + '" }) { id day price timestamp } }';
  var data = reserveGqlRequest(query);

  if (data && data.reservePrices && data.reservePrices.length) {
    var nodes = data.reservePrices;
    var sum = 0;
    for (var i = 0; i < nodes.length; i++) {
      sum += Number(nodes[i].price) / 1e18;
    }
    var avg = sum / nodes.length;
    return [{ date: ymd, value: avg, source: 'RESERVE_SUBGRAPH' }];
  }

  // ----- Fallback: most recent reservePrice strictly before this day -----
  var fallbackQuery = 'query { reservePrices(first: 1, orderBy: timestamp, orderDirection: desc, where: { day_lt: "' + untilDayISO + '" }) { id day price timestamp } }';
  var fallbackData = reserveGqlRequest(fallbackQuery);

  if (fallbackData && fallbackData.reservePrices && fallbackData.reservePrices.length) {
    var fbPrice = Number(fallbackData.reservePrices[0].price) / 1e18;
    Logger.log('  celo_gd_price: no activity on ' + ymd + ' → carry-forward last known price $' + fbPrice.toFixed(8));
    return [{ date: ymd, value: fbPrice, source: 'RESERVE_SUBGRAPH_FALLBACK' }];
  }

  Logger.log('  celo_gd_price: no data for ' + ymd + ' and no prior price available');
  return [];
}

/**
 * Repair historical gaps in gd_usd_price.
 * - Reads existing gd_usd_price rows from the facts sheet
 * - Anchors at the earliest existing date, scans forward to yesterday
 * - For each missing date, calls reserveFetchDailyAvgPrice (which now
 *   has built-in fallback) and inserts the result
 * - Never overwrites existing rows (only missing dates are processed)
 */
function backfillGdUsdPrice() {
  Logger.log('=== backfillGdUsdPrice: scanning facts table for celo_gd_price gaps ===');
  ensureSheets();

  var ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  var lastRow = facts.getLastRow();
  if (lastRow < 2) {
    Logger.log('Facts sheet is empty — nothing to backfill.');
    return;
  }

  // Columns: A=date, B=chain, C=metric_key, D=value
  var data = facts.getRange(2, 1, lastRow - 1, 4).getValues();

  var present = {};
  var minYmd = null;
  for (var i = 0; i < data.length; i++) {
    if (data[i][2] !== 'celo_gd_price') continue;
    var d = data[i][0];
    var ymd = (d instanceof Date)
      ? Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd')
      : String(d).slice(0, 10);
    var v = data[i][3];
    if (v === '' || v === null || v === undefined) continue; // treat blanks as missing
    present[ymd] = true;
    if (!minYmd || ymd < minYmd) minYmd = ymd;
  }

  if (!minYmd) {
    Logger.log('No existing celo_gd_price rows — nothing to anchor backfill from.');
    return;
  }

  var yesterday = getYesterdayYMD();
  Logger.log('Scanning range ' + minYmd + ' → ' + yesterday);

  // Build list of missing days (strict 1 row per day, no gaps)
  var missing = [];
  var cursor = minYmd;
  while (cursor <= yesterday) {
    if (!present[cursor]) missing.push(cursor);
    cursor = addDays(cursor, 1);
  }

  Logger.log('Missing days found: ' + missing.length);
  if (!missing.length) {
    Logger.log('No gaps. celo_gd_price is continuous.');
    return;
  }

  var startedAt = nowIso();
  var runIdStr  = generateRunId();
  var rows = [];
  var realCount = 0;
  var fallbackCount = 0;

  for (var j = 0; j < missing.length; j++) {
    var ymd2 = missing[j];
    var dayISO = ymdToDayISO(ymd2);
    try {
      var results = reserveFetchDailyAvgPrice(dayISO, dayISO);
      if (!results.length) {
        Logger.log('  ' + ymd2 + ': SKIPPED (no data and no fallback available)');
        continue;
      }
      var r = results[0];
      if (r.source === 'RESERVE_SUBGRAPH_FALLBACK') fallbackCount++;
      else realCount++;
      rows.push({
        date: ymd2,
        chain: 'CELO',
        metric_key: 'celo_gd_price',
        value: r.value,
        source: r.source,
        run_id: runIdStr,
        updated_at: startedAt,
        decimals: 8
      });
      Logger.log('  ' + ymd2 + ': $' + r.value.toFixed(8) + ' [' + r.source + ']');
    } catch (e) {
      Logger.log('  ' + ymd2 + ': ERROR ' + e.message);
    }
    Utilities.sleep(150); // be gentle with the subgraph
  }

  Logger.log('Summary: ' + missing.length + ' missing, ' + rows.length + ' backfilled (' +
             realCount + ' real, ' + fallbackCount + ' fallback)');
  if (rows.length) {
    writeFactsAndHealth({ rows: rows, health: [], runId: runIdStr });
  }
  Logger.log('=== backfillGdUsdPrice complete ===');
}

function reserveFetchDailyVolume(spec, sinceDayISO, untilDayISO) {
  // Limit to last 60 days to avoid rate limits and bloat
  var sinceNum = Number(sinceDayISO);
  var untilNum = Number(untilDayISO);
  var maxDays = 60;
  
  if (untilNum - sinceNum > maxDays) {
    sinceNum = untilNum - maxDays;
    sinceDayISO = String(sinceNum);
  }
  
  // Paginate through all records for the date range
  var allNodes = [];
  var lastTimestamp = '0';
  var pageSize = 1000;
  var maxPages = 10; // Safety limit
  
  for (var page = 0; page < maxPages; page++) {
    var query = 'query { reservePrices(first: ' + pageSize + ', orderBy: timestamp, orderDirection: asc, where: { day_gte: "' + sinceDayISO + '", day_lte: "' + untilDayISO + '", timestamp_gt: "' + lastTimestamp + '" }) { id day amountIn amountOut timestamp } }';
    
    var data = reserveGqlRequest(query);
    
    if (!data || !data.reservePrices || !data.reservePrices.length) {
      break;
    }
    
    var nodes = data.reservePrices;
    allNodes = allNodes.concat(nodes);
    
    if (nodes.length < pageSize) {
      break; // No more pages
    }
    
    lastTimestamp = nodes[nodes.length - 1].timestamp;
  }
  
  if (!allNodes.length) {
    return [];
  }
  
  // Group by day and sum amounts
  var dayVolumes = {};
  for (var i = 0; i < allNodes.length; i++) {
    var n = allNodes[i];
    var day = n.day;
    var amountIn = Number(n.amountIn) / 1e18;
    var amountOut = Number(n.amountOut) / 1e18;
    
    if (!dayVolumes[day]) {
      dayVolumes[day] = { amountIn: 0, amountOut: 0, volume: 0 };
    }
    dayVolumes[day].amountIn += amountIn;
    dayVolumes[day].amountOut += amountOut;
    dayVolumes[day].volume += amountIn + amountOut;
  }
  
  var field = spec.field; // 'amountIn', 'amountOut', or 'volume'
  var out = [];
  var days = Object.keys(dayVolumes).sort();
  for (var i = 0; i < days.length; i++) {
    var day = days[i];
    var val = dayVolumes[day][field] || 0;
    var ymd = dayISOToYmd(day);
    out.push({ date: ymd, value: val, source: 'RESERVE_SUBGRAPH' });
  }
  
  return out;
}

/***** =========================================
 * 4c) XDC RESERVE SUBGRAPH + ON-CHAIN HELPERS
 * =========================================
 *
 * This section fetches data from the XDC chain reserve system. Two data
 * sources are used:
 *
 *  1. XDC Reserve Subgraph (Goldsky) — provides G$ price events from
 *     on-chain swap transactions. Each event has a `price` (raw integer)
 *     and a `timestamp`. We filter by the target day's timestamp range
 *     and average all events within it.
 *
 *  2. XDC RPC (direct on-chain reads) — provides ERC-20 token balances
 *     held by the reserve contract. We read balances of collateral
 *     stablecoins (USDC, USDm) to compute total reserve liquidity.
 *
 * TEMPORAL PRECISION — KNOWN LIMITATION:
 *   The liquidity balance is read at `latest` (current block) and labeled
 *   as untilYMD (yesterday). This means the balance reflects the state at
 *   script execution time, not the actual end-of-day state. If a large
 *   deposit/withdrawal happens between midnight UTC and the script run,
 *   the reported value will be slightly off for that day.
 *
 *   Historical block queries (eth_call at a past block) would fix this,
 *   but XDC public RPC nodes prune historical state — they are NOT archive
 *   nodes. Calling balanceOf at a past block returns "missing trie node"
 *   errors. If an archive RPC becomes available in the future, the fix is
 *   straightforward: resolve the end-of-day block number and pass it as
 *   the blockTag to fetchXdcTokenBalance().
 *
 *   In practice, the script runs at ~01:00 UTC (shortly after midnight),
 *   so the window for mislabeling is small. For the price metric, the
 *   subgraph is timestamp-indexed, so filtering by day boundaries is
 *   exact — no RPC limitation applies there.
 *****/

/**
 * Sends a GraphQL query to the XDC Reserve subgraph (Goldsky).
 * This is a separate subgraph from the main XDC GoodDollar subgraph;
 * it indexes reserve swap events (price, amountIn, amountOut, etc.).
 *
 * @param {string} queryStr - Raw GraphQL query string.
 * @returns {Object} The `data` field from the GraphQL JSON response.
 * @throws {Error} On HTTP errors or GraphQL-level errors.
 */
function xdcReserveGqlRequest(queryStr) {
  var payload = JSON.stringify({ query: queryStr, variables: {} });
  
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    muteHttpExceptions: true,
    headers: { 'Accept': 'application/json' }
  };
  
  var res = UrlFetchApp.fetch(XDC_RESERVE_SUBGRAPH_URL, options);
  var status = res.getResponseCode();
  var text = res.getContentText();
  
  if (status < 200 || status >= 300) {
    throw new Error('XDC Reserve Subgraph HTTP error (' + status + '): ' + text.slice(0, 500));
  }
  
  var json = JSON.parse(text);
  
  if (json.errors && json.errors.length) {
    throw new Error('XDC Reserve Subgraph GraphQL errors: ' + JSON.stringify(json.errors));
  }
  
  return json.data;
}

/**
 * Fetches the average G$ price on the XDC reserve for a specific day.
 *
 * The reserve subgraph stores each swap event with a `price` field
 * (raw integer, 6-decimal precision) and a `timestamp` (unix seconds).
 *
 * Strategy:
 *   1. Compute the unix timestamp range for the target day (UTC).
 *   2. Query all reservePrice events within that range.
 *   3. Average them. If no events occurred that day, fall back to the
 *      most recent event before the day (stale-but-best-available).
 *
 * This is precise because the subgraph indexes events by timestamp,
 * so we can filter to exactly the target day's boundaries — unlike
 * on-chain RPC reads, there's no "latest vs historical" limitation.
 *
 * Price conversion: `price / 1e6` → USD.
 * Example: raw price 130 → 0.000130 USD.
 *
 * @param {string} untilYMD - Target date in 'YYYY-MM-DD' format.
 * @returns {Array<{date, value, source}>} Single-element array with
 *          the average price, or empty if no data exists at all.
 */
function xdcReserveFetchGdPrice(untilYMD) {
  // Calculate unix timestamp boundaries for the target day (UTC)
  var dayStart = Math.floor(new Date(untilYMD + 'T00:00:00Z').getTime() / 1000);
  var dayEnd   = Math.floor(new Date(untilYMD + 'T23:59:59Z').getTime() / 1000);
  
  // First attempt: get all price events within the target day
  var query = '{ reservePrices(first: 1000, orderBy: timestamp, orderDirection: asc, where: { timestamp_gte: "' + dayStart + '", timestamp_lte: "' + dayEnd + '" }) { price timestamp } }';
  var data = xdcReserveGqlRequest(query);
  
  if (data && data.reservePrices && data.reservePrices.length > 0) {
    // Average all price events within the day
    var sum = 0;
    for (var i = 0; i < data.reservePrices.length; i++) {
      sum += Number(data.reservePrices[i].price) / 1e6;
    }
    var avg = sum / data.reservePrices.length;
    Logger.log('  xdc_gd_price: averaged ' + data.reservePrices.length + ' events for ' + untilYMD + ' → $' + avg.toFixed(8));
    return [{ date: untilYMD, value: avg, source: 'XDC_RESERVE_SUBGRAPH' }];
  }
  
  // Fallback: no events on target day → get the most recent event before it.
  // This handles days with no swap activity (price carries forward).
  var fallbackQuery = '{ reservePrices(first: 1, orderBy: timestamp, orderDirection: desc, where: { timestamp_lt: "' + dayStart + '" }) { price timestamp } }';
  var fallbackData = xdcReserveGqlRequest(fallbackQuery);
  
  if (fallbackData && fallbackData.reservePrices && fallbackData.reservePrices.length > 0) {
    var price = Number(fallbackData.reservePrices[0].price) / 1e6;
    Logger.log('  xdc_gd_price: no events on ' + untilYMD + ', using last known price → $' + price.toFixed(8));
    return [{ date: untilYMD, value: price, source: 'XDC_RESERVE_SUBGRAPH+CARRY_FORWARD' }];
  }
  
  // No price data exists at all
  Logger.log('  xdc_gd_price: no price data found for or before ' + untilYMD);
  return [];
}

/**
 * Sends a JSON-RPC call to the XDC network.
 *
 * @param {string} to - Contract address to call.
 * @param {string} data - ABI-encoded calldata (e.g. balanceOf selector + padded address).
 * @returns {string} The hex-encoded return data from the contract.
 * @throws {Error} On HTTP or JSON-RPC errors.
 */
function xdcRpcCall(to, data) {
  var payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: to, data: data }, 'latest']
  });
  
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    muteHttpExceptions: true,
  };
  
  var res = UrlFetchApp.fetch(XDC_RPC_URL, options);
  var status = res.getResponseCode();
  var text = res.getContentText();
  
  if (status < 200 || status >= 300) {
    throw new Error('XDC RPC HTTP error (' + status + '): ' + text.slice(0, 500));
  }
  
  var json = JSON.parse(text);
  
  if (json.error) {
    throw new Error('XDC RPC error: ' + JSON.stringify(json.error));
  }
  
  return json.result;
}

/**
 * Reads an ERC-20 token balance on the XDC chain (latest state).
 *
 * Constructs the `balanceOf(address)` calldata manually:
 *   selector = 0x70a08231 (keccak256 of "balanceOf(address)")
 *   + ABI-encoded address (left-padded to 32 bytes)
 *
 * NOTE: Always reads `latest` block. Historical queries are not supported
 * by XDC public RPC nodes (they prune state). See section header for details.
 *
 * @param {string} tokenAddress - The ERC-20 token contract address.
 * @param {string} holderAddress - The address whose balance to check.
 * @param {number} decimals - Token decimal places (e.g. 6 for USDC, 18 for USDm).
 * @returns {number} The token balance as a human-readable decimal number.
 */
function fetchXdcTokenBalance(tokenAddress, holderAddress, decimals) {
  // Build the balanceOf(address) calldata
  // Function selector: 0x70a08231
  var paddedHolder = holderAddress.replace(/^0x/, '').toLowerCase();
  while (paddedHolder.length < 64) paddedHolder = '0' + paddedHolder;
  var callData = '0x70a08231' + paddedHolder;
  
  var result = xdcRpcCall(tokenAddress, callData);
  
  if (!result || result === '0x') return 0;
  
  // Parse the hex return value as a big integer and scale by decimals
  var raw = BigInt(result);
  return Number(raw) / Math.pow(10, decimals);
}

/**
 * Computes total XDC reserve liquidity in USD.
 *
 * Reads the `latest` balance of each collateral token (USDC, USDm) held
 * by the reserve contract, and sums them. Both are USD-pegged stablecoins,
 * so 1 token ≈ $1 and balances can be summed directly.
 *
 * KNOWN LIMITATION: This reads the current balance, not the historical
 * balance at end-of-day. The value is labeled as untilYMD (yesterday),
 * so if tokens moved between midnight and the script run, the value
 * will be slightly inaccurate for that day. See section header comment
 * for full explanation and potential future fix.
 *
 * @param {string} untilYMD - Target date in 'YYYY-MM-DD' format (for labeling).
 * @returns {Array<{date, value, source}>} Single-element array with
 *          the total reserve liquidity in USD.
 */
function fetchXdcReserveLiquidity(untilYMD) {
  var totalUsd = 0;
  
  var tokenKeys = Object.keys(XDC_COLLATERAL_TOKENS);
  for (var i = 0; i < tokenKeys.length; i++) {
    var token = XDC_COLLATERAL_TOKENS[tokenKeys[i]];
    var balance = fetchXdcTokenBalance(token.address, XDC_RESERVE_CONTRACT, token.decimals);
    Logger.log('  XDC reserve ' + tokenKeys[i] + ' balance: ' + balance.toFixed(2));
    totalUsd += balance;
  }
  
  return [{ date: untilYMD, value: totalUsd, source: 'XDC_ONCHAIN_RPC' }];
}

/***** =========================================
 * 4d) SUPPLY HELPERS (Explorer APIs)
 * =========================================
 * These functions read G$ token supply from block explorer APIs:
 *   - Etherscan (ETH mainnet): total supply + frozen wallet balances
 *   - Fuse Explorer: circulating supply on Fuse
 *   - Celo Explorer: circulating supply on Celo
 *
 * TEMPORAL NOTE: These all read "latest" state, not historical.
 * Since the script runs shortly after midnight for yesterday's data,
 * the supply values are technically "now" labeled as "yesterday".
 * For supply metrics this is acceptable because G$ supply changes
 * very slowly (fractions of a percent per day). The same limitation
 * applies to XDC reserve liquidity (section 4c) — see that section's
 * header for a full discussion of the RPC state-pruning constraint.
 *****/

function fetchEthereumSupply(untilYMD) {
  // Fetch ETH G$ total supply from Etherscan
  var url = 'https://api.etherscan.io/v2/api?chainid=1&module=stats&action=tokensupply&contractaddress=' + SUPPLY_CONTRACTS.ETH_GD + '&apikey=' + etherscanApiKey();
  
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(response.getContentText());
  
  if (!json.result) {
    throw new Error('Etherscan API error: ' + JSON.stringify(json));
  }
  
  // ETH G$ has 2 decimals
  var supply = Number(json.result) / 100;
  
  return [{ date: untilYMD, value: supply, source: 'ETHERSCAN_API' }];
}

function fetchEthereumFrozenSupply(untilYMD) {
  // Fetch frozen wallet balances and sum them
  var frozenAddresses = [SUPPLY_CONTRACTS.FROZEN_WALLET_1, SUPPLY_CONTRACTS.FROZEN_WALLET_2];
  var totalFrozen = 0;
  
  for (var i = 0; i < frozenAddresses.length; i++) {
    var url = 'https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokenbalance&contractaddress=' + SUPPLY_CONTRACTS.ETH_GD + '&address=' + frozenAddresses[i] + '&tag=latest&apikey=' + etherscanApiKey();
    
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var json = JSON.parse(response.getContentText());
    
    if (json.result) {
      // ETH G$ has 2 decimals
      totalFrozen += Number(json.result) / 100;
    }
  }
  
  return [{ date: untilYMD, value: totalFrozen, source: 'ETHERSCAN_API' }];
}

function fetchFuseSupply(untilYMD) {
  // Fetch Fuse G$ supply from Fuse Explorer
  var url = 'https://explorer.fuse.io/api?module=stats&action=tokensupply&contractaddress=' + SUPPLY_CONTRACTS.FUSE_GD;
  
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(response.getContentText());
  
  if (!json.result) {
    throw new Error('Fuse Explorer API error: ' + JSON.stringify(json));
  }
  
  // Fuse G$ has 2 decimals
  var supply = Number(json.result) / 100;
  
  return [{ date: untilYMD, value: supply, source: 'FUSE_EXPLORER_API' }];
}

function fetchCeloSupply(untilYMD) {
  // Fetch Celo G$ supply from Celo Explorer
  var url = 'https://explorer.celo.org/mainnet/api?module=stats&action=tokensupply&contractaddress=' + SUPPLY_CONTRACTS.CELO_GD;
  
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(response.getContentText());
  
  if (!json.result) {
    throw new Error('Celo Explorer API error: ' + JSON.stringify(json));
  }
  
  // Celo G$ has 18 decimals
  var supply = Number(json.result) / 1e18;
  
  return [{ date: untilYMD, value: supply, source: 'CELO_EXPLORER_API' }];
}

/***** =========================================
 * 5) ADAPTERS
 * =========================================
 * Each adapter is an object with a .fetch() method that knows how to
 * retrieve data for metrics of its type. The adapter receives the
 * metric's spec (from the METRICS registry) and returns an array of
 * {date, value, source} objects.
 *
 * Processing order in buildRows() (IMPORTANT — later adapters may
 * depend on rows produced by earlier ones):
 *   1. Dune           — external SQL analytics (no dependencies)
 *   2. Subgraph       — XDC subgraph data (no dependencies)
 *   3. Reserve        — CELO reserve subgraph (no dependencies)
 *   4. Computed       — multiply G$ amounts by price (depends on Reserve)
 *   5. Supply         — token supply from explorers (no dependencies)
 *   6. SupplyComputed — aggregated supply (depends on Supply + Subgraph)
 *   7. XdcReserve     — XDC reserve price + liquidity (no dependencies)
 *   8. XdcReserveComputed — spread, backing ratio, minting, growth
 *                          (depends on XdcReserve + Reserve + Subgraph)
 *
 * The "Computed" adapter also has a fetchWithFactsLookup() variant that
 * can fall back to the persisted facts table when source metrics aren't
 * in the current batch — used for USD conversions of historical data.
 *****/

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
  },
  
  Reserve: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec) {
      if (!spec) throw new Error('Missing reserve spec for ' + metricKey);
      
      var sinceDayISO = ymdToDayISO(sinceYMD);
      var untilDayISO = ymdToDayISO(untilYMD);
      
      switch (spec.type) {
        case 'daily_avg_price':
          return reserveFetchDailyAvgPrice(sinceDayISO, untilDayISO);
        case 'daily_volume':
          return reserveFetchDailyVolume(spec, sinceDayISO, untilDayISO);
        default:
          throw new Error('Unknown Reserve spec type for ' + metricKey + ': ' + spec.type);
      }
    }
  },
  
  Computed: {
    // Computed metrics are processed after all other metrics are fetched
    // They use existing row data to calculate derived values
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec, allRows, priceMap) {
      if (!spec) throw new Error('Missing computed spec for ' + metricKey);
      
      if (spec.type !== 'multiply_by_price') {
        throw new Error('Unknown Computed spec type for ' + metricKey + ': ' + spec.type);
      }
      
      var sourceMetric = spec.sourceMetric;
      var out = [];
      
      // Find source metric rows in the current batch
      for (var i = 0; i < allRows.length; i++) {
        var row = allRows[i];
        if (row.metric_key !== sourceMetric) continue;
        
        var price = priceMap[row.date];
        if (price == null || price === 0) continue;
        
        var usdValue = row.value * price;
        out.push({
          date: row.date,
          value: usdValue,
          source: row.source + '+RESERVE_PRICE'
        });
      }
      
      return out;
    },
    
    // Enhanced fetch that also looks up from facts table
    fetchWithFactsLookup: function(metricKey, chain, sinceYMD, untilYMD, spec, allRows, priceMap, existingIndex) {
      if (!spec) throw new Error('Missing computed spec for ' + metricKey);
      
      if (spec.type !== 'multiply_by_price') {
        throw new Error('Unknown Computed spec type for ' + metricKey + ': ' + spec.type);
      }
      
      var sourceMetric = spec.sourceMetric;
      var out = [];
      var usedFallbackPrice = false;
      var fallbackPriceDate = null;
      
      // Build a map of source metric values from current batch
      var sourceFromBatch = {};
      for (var i = 0; i < allRows.length; i++) {
        var row = allRows[i];
        if (row.metric_key === sourceMetric) {
          sourceFromBatch[row.date] = row.value;
        }
      }
      
      // Get dates that need USD conversion (source metric exists but USD metric doesn't)
      var datesToProcess = [];
      var d = parseYMD(sinceYMD);
      var endD = parseYMD(untilYMD);
      
      while (d <= endD) {
        var ymd = formatYMD(d);
        var factKey = ymd + '|' + chain + '|' + metricKey;
        
        // Only process if the USD metric doesn't already exist
        if (!existingIndex[factKey]) {
          datesToProcess.push(ymd);
        }
        
        d.setDate(d.getDate() + 1);
      }
      
      if (datesToProcess.length === 0) {
        return { rows: [], warning: null };
      }
      
      // Look up source metric values from facts table for dates not in current batch
      var sourceFromFacts = {};
      if (datesToProcess.length > 0) {
        var ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
        var facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
        var lastRow = facts.getLastRow();
        
        if (lastRow > 1) {
          var data = facts.getRange(2, 1, lastRow - 1, 4).getValues(); // date, chain, metric, value
          
          for (var i = 0; i < data.length; i++) {
            var dateVal = data[i][0];
            var rowChain = data[i][1];
            var rowMetric = data[i][2];
            var rowValue = data[i][3];
            
            if (rowMetric !== sourceMetric) continue;
            
            var ymd = (dateVal instanceof Date) ? formatYMD(dateVal) : String(dateVal).slice(0, 10);
            sourceFromFacts[ymd] = Number(rowValue) || 0;
          }
        }
      }
      
      // If priceMap is empty, try to get price from facts table
      var effectivePriceMap = priceMap;
      if (Object.keys(priceMap).length === 0) {
        var ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
        var facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
        var lastRow = facts.getLastRow();
        
        if (lastRow > 1) {
          var data = facts.getRange(2, 1, lastRow - 1, 4).getValues();
          var latestPriceDate = null;
          var latestPrice = null;
          
          for (var i = 0; i < data.length; i++) {
            var rowMetric = data[i][2];
            if (rowMetric !== 'celo_gd_price') continue;
            
            var dateVal = data[i][0];
            var ymd = (dateVal instanceof Date) ? formatYMD(dateVal) : String(dateVal).slice(0, 10);
            var price = Number(data[i][3]) || 0;
            
            if (price > 0) {
              effectivePriceMap[ymd] = price;
              if (!latestPriceDate || ymd > latestPriceDate) {
                latestPriceDate = ymd;
                latestPrice = price;
              }
            }
          }
          
          if (latestPriceDate) {
            usedFallbackPrice = true;
            fallbackPriceDate = latestPriceDate;
          }
        }
      }
      
      // Process each date
      for (var i = 0; i < datesToProcess.length; i++) {
        var ymd = datesToProcess[i];
        
        // Get source value (prefer batch, fall back to facts)
        var sourceValue = sourceFromBatch[ymd];
        if (sourceValue == null) {
          sourceValue = sourceFromFacts[ymd];
        }
        
        if (sourceValue == null || sourceValue === 0) continue;
        
        // Get price (prefer same day, fall back to latest available)
        var price = effectivePriceMap[ymd];
        if (price == null || price === 0) {
          // Use latest available price
          var priceDates = Object.keys(effectivePriceMap).sort();
          if (priceDates.length > 0) {
            var latestPriceDate = priceDates[priceDates.length - 1];
            price = effectivePriceMap[latestPriceDate];
            usedFallbackPrice = true;
            fallbackPriceDate = latestPriceDate;
          }
        }
        
        if (price == null || price === 0) continue;
        
        var usdValue = sourceValue * price;
        var source = 'COMPUTED';
        if (usedFallbackPrice) {
          source = 'COMPUTED+PRICE_FROM_' + fallbackPriceDate;
        }
        
        out.push({
          date: ymd,
          value: usdValue,
          source: source
        });
      }
      
      var warning = null;
      if (usedFallbackPrice && fallbackPriceDate) {
        warning = 'Used price from ' + fallbackPriceDate + ' for some calculations';
      }
      
      return { rows: out, warning: warning };
    }
  },
  
  Supply: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec) {
      if (!spec) throw new Error('Missing supply spec for ' + metricKey);
      
      // Supply metrics only fetch the latest day (untilYMD)
      switch (spec.type) {
        case 'eth_total':
          return fetchEthereumSupply(untilYMD);
        case 'eth_frozen':
          return fetchEthereumFrozenSupply(untilYMD);
        case 'fuse_supply':
          return fetchFuseSupply(untilYMD);
        case 'celo_supply':
          return fetchCeloSupply(untilYMD);
        default:
          throw new Error('Unknown Supply spec type for ' + metricKey + ': ' + spec.type);
      }
    }
  },
  
  SupplyComputed: {
    // Computed supply metrics that depend on other supply metrics
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec, allRows, existingIndex) {
      if (!spec) throw new Error('Missing supply computed spec for ' + metricKey);
      
      var out = [];
      
      if (spec.type === 'eth_circulating') {
        // eth_gd_in_circulation = eth_gd_total_supply - eth_gd_frozen_supply
        var ethTotal = null;
        var ethFrozen = null;
        
        // Look in current batch first
        for (var i = 0; i < allRows.length; i++) {
          if (allRows[i].metric_key === 'eth_gd_total_supply' && allRows[i].date === untilYMD) {
            ethTotal = allRows[i].value;
          }
          if (allRows[i].metric_key === 'eth_gd_frozen_supply' && allRows[i].date === untilYMD) {
            ethFrozen = allRows[i].value;
          }
        }
        
        // If not in batch, look in facts table
        if (ethTotal === null || ethFrozen === null) {
          var ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
          var facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
          var lastRow = facts.getLastRow();
          
          if (lastRow > 1) {
            var data = facts.getRange(2, 1, lastRow - 1, 4).getValues();
            for (var i = 0; i < data.length; i++) {
              var dateVal = data[i][0];
              var ymd = (dateVal instanceof Date) ? formatYMD(dateVal) : String(dateVal).slice(0, 10);
              if (ymd !== untilYMD) continue;
              
              var rowMetric = data[i][2];
              var rowValue = Number(data[i][3]) || 0;
              
              if (rowMetric === 'eth_gd_total_supply' && ethTotal === null) {
                ethTotal = rowValue;
              }
              if (rowMetric === 'eth_gd_frozen_supply' && ethFrozen === null) {
                ethFrozen = rowValue;
              }
            }
          }
        }
        
        if (ethTotal !== null && ethFrozen !== null) {
          out.push({
            date: untilYMD,
            value: ethTotal - ethFrozen,
            source: 'COMPUTED'
          });
        }
        
      } else if (spec.type === 'total_circulating') {
        // agg_gd_in_circulation = eth + fuse + celo + xdc
        var ethCirc = null;
        var fuseCirc = null;
        var celoCirc = null;
        var xdcCirc = null;
        
        // Look in current batch first
        for (var i = 0; i < allRows.length; i++) {
          var row = allRows[i];
          if (row.date !== untilYMD) continue;
          
          if (row.metric_key === 'eth_gd_in_circulation') ethCirc = row.value;
          if (row.metric_key === 'fuse_gd_in_circulation') fuseCirc = row.value;
          if (row.metric_key === 'celo_gd_in_circulation') celoCirc = row.value;
          if (row.metric_key === 'xdc_gd_in_circulation') xdcCirc = row.value;
        }
        
        // If not in batch, look in facts table
        var ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
        var facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
        var lastRow = facts.getLastRow();
        
        if (lastRow > 1) {
          var data = facts.getRange(2, 1, lastRow - 1, 4).getValues();
          for (var i = 0; i < data.length; i++) {
            var dateVal = data[i][0];
            var ymd = (dateVal instanceof Date) ? formatYMD(dateVal) : String(dateVal).slice(0, 10);
            if (ymd !== untilYMD) continue;
            
            var rowMetric = data[i][2];
            var rowValue = Number(data[i][3]) || 0;
            
            if (rowMetric === 'eth_gd_in_circulation' && ethCirc === null) ethCirc = rowValue;
            if (rowMetric === 'fuse_gd_in_circulation' && fuseCirc === null) fuseCirc = rowValue;
            if (rowMetric === 'celo_gd_in_circulation' && celoCirc === null) celoCirc = rowValue;
            if (rowMetric === 'xdc_gd_in_circulation' && xdcCirc === null) xdcCirc = rowValue;
          }
        }
        
        // Calculate total if we have all values
        if (ethCirc !== null && fuseCirc !== null && celoCirc !== null && xdcCirc !== null) {
          out.push({
            date: untilYMD,
            value: ethCirc + fuseCirc + celoCirc + xdcCirc,
            source: 'COMPUTED'
          });
        } else {
          // Log which ones are missing
          var missing = [];
          if (ethCirc === null) missing.push('eth_gd_in_circulation');
          if (fuseCirc === null) missing.push('fuse_gd_in_circulation');
          if (celoCirc === null) missing.push('celo_gd_in_circulation');
          if (xdcCirc === null) missing.push('xdc_gd_in_circulation');
          Logger.log('agg_gd_in_circulation: missing components: ' + missing.join(', '));
        }
      }
      
      return out;
    }
  },
  
  /**
   * XdcReserve adapter — fetches raw data from the XDC reserve system.
   * Two data types:
   *   'gd_price'          — G$ price from XDC reserve subgraph (day-averaged)
   *   'reserve_liquidity'  — total USD value of collateral in reserve contract
   *                          (read at historical block for temporal precision)
   */
  XdcReserve: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec) {
      if (!spec) throw new Error('Missing xdcReserve spec for ' + metricKey);
      
      switch (spec.type) {
        case 'gd_price':
          return xdcReserveFetchGdPrice(untilYMD);
        case 'reserve_liquidity':
          return fetchXdcReserveLiquidity(untilYMD);
        default:
          throw new Error('Unknown XdcReserve spec type for ' + metricKey + ': ' + spec.type);
      }
    }
  },
  
  /**
   * XdcReserveComputed adapter — derives metrics from other metrics that
   * have already been computed earlier in the same pipeline run.
   *
   * DEPENDENCY ORDER: This adapter runs AFTER XdcReserve, Subgraph,
   * Reserve, Supply, and SupplyComputed have all finished. It looks up
   * dependency values in two places (in this priority order):
   *   1. allRows (the current batch — rows generated in this run)
   *   2. facts table (previously persisted rows from earlier runs)
   *
   * This dual-lookup is critical for backfill scenarios where both the
   * dependency and the derived metric are being computed in the same run
   * and neither has been persisted yet.
   */
  XdcReserveComputed: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec, allRows, existingIndex) {
      if (!spec) throw new Error('Missing xdcReserveComputed spec for ' + metricKey);
      
      var out = [];
      
      /**
       * Searches the current run's batch (allRows) for a metric value.
       * This catches values that were computed earlier in this same run
       * but haven't been written to the sheet yet.
       */
      function findInBatch(key, date) {
        for (var i = 0; i < allRows.length; i++) {
          if (allRows[i].metric_key === key && allRows[i].date === date) {
            return allRows[i].value;
          }
        }
        return null;
      }
      
      /**
       * Searches the persisted facts spreadsheet for a metric value.
       * Used when the dependency was written in a previous run.
       * Note: reads the entire facts sheet, which is fine for the single
       * daily run but could be optimized with caching if needed.
       */
      function findInFacts(key, date) {
        var ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
        var facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
        var lastRow = facts.getLastRow();
        if (lastRow < 2) return null;
        
        var data = facts.getRange(2, 1, lastRow - 1, 4).getValues();
        for (var i = 0; i < data.length; i++) {
          var dateVal = data[i][0];
          var ymd = (dateVal instanceof Date) ? formatYMD(dateVal) : String(dateVal).slice(0, 10);
          if (ymd === date && data[i][2] === key) {
            return Number(data[i][3]) || 0;
          }
        }
        return null;
      }
      
      /**
       * Combined lookup: checks the current batch first (for values computed
       * in this run), then falls back to the persisted facts table.
       * ALWAYS use this instead of findInFacts alone — the batch-first
       * lookup is essential for backfill correctness.
       */
      function findValue(key, date) {
        var v = findInBatch(key, date);
        if (v !== null) return v;
        return findInFacts(key, date);
      }
      
      if (spec.type === 'price_spread') {
        // gd_price_spread = xdc_gd_price - gd_usd_price (CELO reserve price)
        // A positive spread means the XDC price is higher than CELO.
        // Both prices are in USD, so the result is a USD delta.
        var xdcPrice = findValue('xdc_gd_price', untilYMD);
        var celoPrice = findValue('celo_gd_price', untilYMD);
        
        if (xdcPrice !== null && celoPrice !== null) {
          out.push({
            date: untilYMD,
            value: xdcPrice - celoPrice,
            source: 'COMPUTED'
          });
        } else {
          Logger.log('gd_price_spread: missing xdc_gd_price=' + xdcPrice + ' or celo_gd_price=' + celoPrice);
        }
        
      } else if (spec.type === 'backing_ratio') {
        // xdc_reserve_backing_ratio = reserve_liquidity / gd_supply_on_xdc
        // Values < 1 mean the reserve is undercollateralized.
        // Values > 1 mean the reserve holds more USD than G$ in circulation.
        var liquidity = findValue('xdc_reserve_liquidity_usd', untilYMD);
        var supply = findValue('xdc_gd_in_circulation', untilYMD);
        
        if (liquidity !== null && supply !== null && supply > 0) {
          out.push({
            date: untilYMD,
            value: liquidity / supply,
            source: 'COMPUTED'
          });
        } else {
          Logger.log('xdc_reserve_backing_ratio: missing liquidity=' + liquidity + ' or supply=' + supply);
        }
        
      } else if (spec.type === 'daily_minted') {
        // xdc_daily_gd_minted = today's cumulative UBI - yesterday's cumulative UBI
        // The XDC subgraph's dailyUBIs entity stores a running total of
        // totalUBIDistributed per day. The difference gives us the daily mint.
        var yesterdayYMD = addDays(untilYMD, -1);
        
        var todayDayISO = xdcYmdToDayISO(untilYMD);
        var yesterdayDayISO = xdcYmdToDayISO(yesterdayYMD);
        
        // These are direct subgraph fetches (not from batch/facts),
        // because dailyUBIs is a subgraph-indexed entity with day-level
        // precision — no temporal mismatch risk.
        var todayRows = xdcFetchDailyField({ field: 'totalUBIDistributed', divisor: 1e18 }, todayDayISO, todayDayISO);
        var yesterdayRows = xdcFetchDailyField({ field: 'totalUBIDistributed', divisor: 1e18 }, yesterdayDayISO, yesterdayDayISO);
        
        if (todayRows.length > 0 && yesterdayRows.length > 0) {
          var minted = todayRows[0].value - yesterdayRows[0].value;
          out.push({
            date: untilYMD,
            value: Math.max(0, minted),
            source: 'XDC_SUBGRAPH+COMPUTED'
          });
        } else {
          Logger.log('xdc_daily_gd_minted: missing daily UBI data for ' + untilYMD);
        }
        
      } else if (spec.type === 'reserve_growth_abs') {
        // xdc_reserve_growth_abs = today_liquidity - yesterday_liquidity
        // This is an ABSOLUTE delta in USD (not a percentage).
        // Example: $50,009 - $8.33 = $50,000.67
        //
        // NOTE: Uses findValue (batch + facts) for BOTH days. This is
        // critical for backfill correctness — during a backfill run,
        // yesterday's liquidity may exist only in the current batch
        // (not yet persisted to the sheet).
        var todayLiquidity = findValue('xdc_reserve_liquidity_usd', untilYMD);
        var yesterdayYMD = addDays(untilYMD, -1);
        var yesterdayLiquidity = findValue('xdc_reserve_liquidity_usd', yesterdayYMD);
        
        if (todayLiquidity !== null && yesterdayLiquidity !== null) {
          out.push({
            date: untilYMD,
            value: todayLiquidity - yesterdayLiquidity,
            source: 'COMPUTED'
          });
        } else {
          Logger.log('xdc_reserve_growth_abs: missing today=' + todayLiquidity + ' or yesterday=' + yesterdayLiquidity + ' for ' + untilYMD);
        }
        
      } else {
        throw new Error('Unknown XdcReserveComputed spec type for ' + metricKey + ': ' + spec.type);
      }
      
      return out;
    }
  },

  /**
   * XdcInvites adapter — reads daily aggregates from the "XDC Invites Raw"
   * sheet (populated by updateXdcInvitesPipeline() in xdc_invites.gs).
   *
   * This adapter does NOT call Hypersync directly. The Hypersync sweep
   * runs on its own time trigger so the daily Dune/Subgraph cron stays
   * fast. Here we just slice the in-memory aggregates by date window
   * and return them in the standard {date, value, source} shape.
   */
  XdcInvites: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec) {
      if (!spec) throw new Error('Missing xdcInvites spec for ' + metricKey);
      if (spec.type !== 'daily_metric') {
        throw new Error('Unknown XdcInvites spec type for ' + metricKey + ': ' + spec.type);
      }
      // Honor XDC genesis cutoff so we don't emit empty pre-launch rows
      var effectiveSince = sinceYMD;
      if (effectiveSince < CONFIG.XDC_GENESIS) effectiveSince = CONFIG.XDC_GENESIS;

      // xdcInvitesAggregateRaw lives in xdc_invites.gs
      var allRows = xdcInvitesAggregateRaw(effectiveSince, untilYMD);
      var out = [];
      for (var i = 0; i < allRows.length; i++) {
        if (allRows[i].metric_key === spec.metricKey) {
          out.push({
            date: allRows[i].date,
            value: allRows[i].value,
            source: allRows[i].source
          });
        }
      }
      return out;
    }
  }
};

/***** =========================================
 * 6) CORE BUILD FUNCTION
 * =========================================
 * buildRows() is the heart of the pipeline. It:
 *   1. Classifies all METRICS entries by adapter type.
 *   2. Fetches Dune data (batched by queryId to avoid redundant API calls).
 *   3. Fetches Subgraph, Reserve, Supply data (one call per metric).
 *   4. Computes derived metrics (Computed, SupplyComputed, XdcReserveComputed).
 *   5. Deduplicates against existingIndex to skip already-persisted rows.
 *   6. Returns {rows, health, runId} for writeFactsAndHealth() to persist.
 *
 * The existingIndex is a map of "date|chain|metric_key" → true, built
 * from the current facts sheet. This prevents duplicate writes during
 * reruns or overlapping backfills.
 *****/

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
  const reserveMetrics = [];
  const computedMetrics = [];
  const supplyMetrics = [];
  const supplyComputedMetrics = [];
  const xdcReserveMetrics = [];
  const xdcReserveComputedMetrics = [];
  const xdcInvitesMetrics = [];
  
  const metricKeys = Object.keys(METRICS);
  for (var m = 0; m < metricKeys.length; m++) {
    const metricKey = metricKeys[m];
    const spec = METRICS[metricKey];
    const chains = (spec.chains || []).filter(function(c) { return CHAINS[c] || c === 'AGG'; });
    if (!chains.length) continue;
    
    for (var c = 0; c < chains.length; c++) {
      const chain = chains[c];
      if (spec.adapter === 'Dune' && spec.dune) {
        duneMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      } else if (spec.adapter === 'Subgraph' && spec.xdc) {
        subgraphMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      } else if (spec.adapter === 'Reserve' && spec.reserve) {
        reserveMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      } else if (spec.adapter === 'Computed' && spec.computed) {
        computedMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      } else if (spec.adapter === 'Supply' && spec.supply) {
        supplyMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      } else if (spec.adapter === 'SupplyComputed' && spec.supplyComputed) {
        supplyComputedMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      } else if (spec.adapter === 'XdcReserve' && spec.xdcReserve) {
        xdcReserveMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      } else if (spec.adapter === 'XdcReserveComputed' && spec.xdcReserveComputed) {
        xdcReserveComputedMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
      } else if (spec.adapter === 'XdcInvites' && spec.xdcInvites) {
        xdcInvitesMetrics.push({ metricKey: metricKey, spec: spec, chain: chain });
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
  
  // Process Reserve metrics
  var priceMap = {}; // Will store date -> price for computed metrics
  
  for (var i = 0; i < reserveMetrics.length; i++) {
    var item = reserveMetrics[i];
    var metricKey = item.metricKey;
    var spec = item.spec;
    var chain = item.chain;
    var t0 = Date.now();
    
    try {
      var results = Adapters.Reserve.fetch(metricKey, chain, sinceYMD, untilYMD, spec.reserve);
      
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        var factKey = r.date + '|' + chain + '|' + metricKey;
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
        
        // Store price for computed metrics
        if (metricKey === 'celo_gd_price') {
          priceMap[r.date] = r.value;
        }
      }
      
      addHealth('RESERVE_SUBGRAPH', metricKey, chain, 'ok', count, Date.now() - t0);
      if (CONFIG.VERBOSE) {
        Logger.log('ok  ' + metricKey + '/' + chain + ': ' + count + ' row(s)');
      }
      
    } catch (e) {
      addHealth('RESERVE_SUBGRAPH', metricKey, chain, 'error', 0, Date.now() - t0, e.message);
      Logger.log('ERROR [' + metricKey + '/' + chain + ']: ' + e.message);
    }
  }
  
  // If we didn't get price from reserve (e.g., already exists), try to get from existing rows
  if (Object.keys(priceMap).length === 0) {
    // Look for gd_usd_price in the rows we already have
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].metric_key === 'celo_gd_price') {
        priceMap[rows[i].date] = rows[i].value;
      }
    }
  }
  
  // Process Computed metrics (must be after all other metrics are fetched)
  for (var i = 0; i < computedMetrics.length; i++) {
    var item = computedMetrics[i];
    var metricKey = item.metricKey;
    var spec = item.spec;
    var chain = item.chain;
    var t0 = Date.now();
    
    try {
      // Use enhanced lookup that checks facts table when batch doesn't have data
      var result = Adapters.Computed.fetchWithFactsLookup(
        metricKey, chain, sinceYMD, untilYMD, spec.computed, rows, priceMap, existingIndex
      );
      
      var computedRows = result.rows || [];
      var warning = result.warning;
      
      var count = 0;
      for (var j = 0; j < computedRows.length; j++) {
        var r = computedRows[j];
        var factKey = r.date + '|' + chain + '|' + metricKey;
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
      }
      
      var healthError = warning || '';
      addHealth('COMPUTED', metricKey, chain, 'ok', count, Date.now() - t0, healthError);
      if (CONFIG.VERBOSE) {
        var msg = 'ok  ' + metricKey + '/' + chain + ': ' + count + ' row(s)';
        if (warning) msg += ' [' + warning + ']';
        Logger.log(msg);
      }
      
    } catch (e) {
      addHealth('COMPUTED', metricKey, chain, 'error', 0, Date.now() - t0, e.message);
      Logger.log('ERROR [' + metricKey + '/' + chain + ']: ' + e.message);
    }
  }
  
  // Process Supply metrics
  for (var i = 0; i < supplyMetrics.length; i++) {
    var item = supplyMetrics[i];
    var metricKey = item.metricKey;
    var spec = item.spec;
    var chain = item.chain;
    var t0 = Date.now();
    
    try {
      var results = Adapters.Supply.fetch(metricKey, chain, sinceYMD, untilYMD, spec.supply);
      
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        var factKey = r.date + '|' + chain + '|' + metricKey;
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
      }
      
      addHealth('SUPPLY', metricKey, chain, 'ok', count, Date.now() - t0);
      if (CONFIG.VERBOSE) {
        Logger.log('ok  ' + metricKey + '/' + chain + ': ' + count + ' row(s)');
      }
      
    } catch (e) {
      addHealth('SUPPLY', metricKey, chain, 'error', 0, Date.now() - t0, e.message);
      Logger.log('ERROR [' + metricKey + '/' + chain + ']: ' + e.message);
    }
  }
  
  // Process SupplyComputed metrics (must be after Supply metrics)
  for (var i = 0; i < supplyComputedMetrics.length; i++) {
    var item = supplyComputedMetrics[i];
    var metricKey = item.metricKey;
    var spec = item.spec;
    var chain = item.chain;
    var t0 = Date.now();
    
    try {
      var results = Adapters.SupplyComputed.fetch(metricKey, chain, sinceYMD, untilYMD, spec.supplyComputed, rows, existingIndex);
      
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        var factKey = r.date + '|' + chain + '|' + metricKey;
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
      }
      
      addHealth('SUPPLY_COMPUTED', metricKey, chain, 'ok', count, Date.now() - t0);
      if (CONFIG.VERBOSE) {
        Logger.log('ok  ' + metricKey + '/' + chain + ': ' + count + ' row(s)');
      }
      
    } catch (e) {
      addHealth('SUPPLY_COMPUTED', metricKey, chain, 'error', 0, Date.now() - t0, e.message);
      Logger.log('ERROR [' + metricKey + '/' + chain + ']: ' + e.message);
    }
  }
  
  // Process XdcReserve metrics (price + liquidity from XDC reserve)
  for (var i = 0; i < xdcReserveMetrics.length; i++) {
    var item = xdcReserveMetrics[i];
    var metricKey = item.metricKey;
    var spec = item.spec;
    var chain = item.chain;
    var t0 = Date.now();
    
    try {
      var results = Adapters.XdcReserve.fetch(metricKey, chain, sinceYMD, untilYMD, spec.xdcReserve);
      
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        var factKey = r.date + '|' + chain + '|' + metricKey;
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
      }
      
      addHealth('XDC_RESERVE', metricKey, chain, 'ok', count, Date.now() - t0);
      if (CONFIG.VERBOSE) {
        Logger.log('ok  ' + metricKey + '/' + chain + ': ' + count + ' row(s)');
      }
      
    } catch (e) {
      addHealth('XDC_RESERVE', metricKey, chain, 'error', 0, Date.now() - t0, e.message);
      Logger.log('ERROR [' + metricKey + '/' + chain + ']: ' + e.message);
    }
  }
  
  // Process XdcReserveComputed metrics (must be after XdcReserve + Subgraph + Supply)
  for (var i = 0; i < xdcReserveComputedMetrics.length; i++) {
    var item = xdcReserveComputedMetrics[i];
    var metricKey = item.metricKey;
    var spec = item.spec;
    var chain = item.chain;
    var t0 = Date.now();
    
    try {
      var results = Adapters.XdcReserveComputed.fetch(metricKey, chain, sinceYMD, untilYMD, spec.xdcReserveComputed, rows, existingIndex);
      
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        var factKey = r.date + '|' + chain + '|' + metricKey;
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
      }
      
      addHealth('XDC_RESERVE_COMPUTED', metricKey, chain, 'ok', count, Date.now() - t0);
      if (CONFIG.VERBOSE) {
        Logger.log('ok  ' + metricKey + '/' + chain + ': ' + count + ' row(s)');
      }
      
    } catch (e) {
      addHealth('XDC_RESERVE_COMPUTED', metricKey, chain, 'error', 0, Date.now() - t0, e.message);
      Logger.log('ERROR [' + metricKey + '/' + chain + ']: ' + e.message);
    }
  }
  // Process XdcInvites metrics (reads from raw events sheet, not Hypersync directly).
  // Runs last so it can stand on its own — no dependencies on prior adapters.
  for (var i = 0; i < xdcInvitesMetrics.length; i++) {
    var item = xdcInvitesMetrics[i];
    var metricKey = item.metricKey;
    var spec = item.spec;
    var chain = item.chain;
    var t0 = Date.now();

    try {
      var results = Adapters.XdcInvites.fetch(metricKey, chain, sinceYMD, untilYMD, spec.xdcInvites);

      var count = 0;
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        var factKey = r.date + '|' + chain + '|' + metricKey;
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
      }

      addHealth('XDC_INVITES', metricKey, chain, 'ok', count, Date.now() - t0);
      if (CONFIG.VERBOSE) {
        Logger.log('ok  ' + metricKey + '/' + chain + ': ' + count + ' row(s)');
      }
    } catch (e) {
      addHealth('XDC_INVITES', metricKey, chain, 'error', 0, Date.now() - t0, e.message);
      Logger.log('ERROR [' + metricKey + '/' + chain + ']: ' + e.message);
    }
  }
  return { rows: rows, health: health, runId: runIdStr };
}

/***** =========================================
 * 7) WRITE FACTS AND HEALTH
 * =========================================
 * Persists buildRows() output to the Google Sheet. Two operations:
 *
 * 1. FACTS (Daily Facts sheet):
 *    - Rounds values to the metric's declared decimal precision.
 *    - Generates AGG rows by summing chain-specific metrics where
 *      aggregate=true (e.g. celo_p2p_tx_count + xdc_p2p_tx_count → agg_p2p_tx_count).
 *      The chain prefix is stripped to form the base metric name.
 *    - Upserts: if a row with the same (date, chain, metric_key) exists,
 *      it's updated in place; otherwise it's inserted at the top.
 *
 * 2. HEALTH (Health Runs sheet):
 *    - Audit log with run_id, timing, status (ok/error), and row counts.
 *    - Useful for debugging which metrics failed and why.
 *****/

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
 * =========================================
 * Entry points for running the pipeline. These are what you trigger
 * from the Apps Script UI or from time-driven triggers.
 *
 * - runOneDaySinglePass(dateStr): Fetches one day (default: yesterday).
 *   Use as the daily cron trigger. Checks existing index to skip
 *   already-written metrics.
 *
 * - smartBackfill(): Scans all metrics, finds the latest persisted date
 *   for each, and fetches everything from (latest+1) to yesterday.
 *   Safe to run anytime — fills gaps without duplicating data.
 *
 * - backfillRange(since, until): Manual backfill for a specific date range.
 *
 * - updatePartnersSheet(): Refreshes the "Partners" sheet from Dune.
 *   Independent of the facts pipeline.
 *****/

function runOneDaySinglePass(dateStr) {
  const ymd = dateStr || getYesterdayYMD();
  
  ensureSheets();
  const indexResult = getExistingFactsIndex();
  
  const result = buildRows(ymd, ymd, indexResult.index);
  writeFactsAndHealth(result);
  
  // Also advance the XDC invites pipeline. This is fast on incremental
  // runs (just a few Hypersync pages) and keeps the facts table fresh
  // without needing a separate trigger. If you'd rather decouple them,
  // delete this call and set a dedicated time trigger on
  // updateXdcInvitesPipeline() instead.
  try {
    updateXdcInvitesPipeline();
  } catch (e) {
    Logger.log('XDC invites pipeline error: ' + e.message);
  }

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
 * =========================================
 * Safe to run manually. testBuildRows() does a dry run (no writes).
 * previewSmartBackfill() shows what smartBackfill would do without
 * actually fetching or writing anything. The others test individual
 * data source connections.
 *****/

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

/***** =========================================
 * 10) RESERVE SUBGRAPH TEST FUNCTIONS
 * =========================================
 * Manual test functions for the CELO reserve subgraph and
 * computed USD metrics. Safe to run — they log results but
 * don't write to the facts sheet.
 *****/

function testReserveConnection() {
  Logger.log('Testing Reserve Subgraph connection...');
  
  try {
    var query = 'query { reservePrices(first: 3, orderBy: timestamp, orderDirection: desc) { id day price timestamp } }';
    var data = reserveGqlRequest(query);
    
    Logger.log('Success! Latest 3 prices:');
    if (data && data.reservePrices) {
      for (var i = 0; i < data.reservePrices.length; i++) {
        var p = data.reservePrices[i];
        var ymd = dayISOToYmd(p.day);
        var priceUsd = Number(p.price) / 1e18;
        Logger.log('  ' + ymd + ': $' + priceUsd.toFixed(8));
      }
    }
  } catch (e) {
    Logger.log('Error: ' + e.message);
  }
}

function testReserveDailyPrice() {
  Logger.log('Testing Reserve daily average price...');
  
  var yesterday = getYesterdayYMD();
  var weekAgo = addDays(yesterday, -7);
  
  var sinceDayISO = ymdToDayISO(weekAgo);
  var untilDayISO = ymdToDayISO(yesterday);
  
  Logger.log('Fetching prices from ' + weekAgo + ' to ' + yesterday);
  
  try {
    var results = reserveFetchDailyAvgPrice(sinceDayISO, untilDayISO);
    
    Logger.log('Got ' + results.length + ' days of prices:');
    for (var i = 0; i < results.length; i++) {
      Logger.log('  ' + results[i].date + ': $' + results[i].value.toFixed(8));
    }
  } catch (e) {
    Logger.log('Error: ' + e.message);
  }
}

function testReserveVolume() {
  Logger.log('Testing Reserve daily volume...');
  
  var yesterday = getYesterdayYMD();
  var weekAgo = addDays(yesterday, -7);
  
  var sinceDayISO = ymdToDayISO(weekAgo);
  var untilDayISO = ymdToDayISO(yesterday);
  
  Logger.log('Fetching volume from ' + weekAgo + ' to ' + yesterday);
  
  try {
    var resultsIn = reserveFetchDailyVolume({ field: 'amountIn' }, sinceDayISO, untilDayISO);
    var resultsOut = reserveFetchDailyVolume({ field: 'amountOut' }, sinceDayISO, untilDayISO);
    var resultsVol = reserveFetchDailyVolume({ field: 'volume' }, sinceDayISO, untilDayISO);
    
    Logger.log('Daily volumes:');
    for (var i = 0; i < resultsVol.length; i++) {
      var date = resultsVol[i].date;
      var volIn = resultsIn[i] ? resultsIn[i].value : 0;
      var volOut = resultsOut[i] ? resultsOut[i].value : 0;
      var volTotal = resultsVol[i].value;
      Logger.log('  ' + date + ': in=' + volIn.toFixed(2) + ', out=' + volOut.toFixed(2) + ', total=' + volTotal.toFixed(2));
    }
  } catch (e) {
    Logger.log('Error: ' + e.message);
  }
}

function testComputedUsdMetrics() {
  Logger.log('Testing Computed USD metrics...');
  
  var yesterday = getYesterdayYMD();
  
  // First get the price
  var sinceDayISO = ymdToDayISO(yesterday);
  var untilDayISO = ymdToDayISO(yesterday);
  
  try {
    var priceResults = reserveFetchDailyAvgPrice(sinceDayISO, untilDayISO);
    if (!priceResults.length) {
      Logger.log('No price data for ' + yesterday);
      return;
    }
    
    var price = priceResults[0].value;
    Logger.log('G$ price on ' + yesterday + ': $' + price.toFixed(8));
    
    // Now simulate computing XDC USD metrics
    var testGdAmount = 1000000; // 1M G$
    var usdAmount = testGdAmount * price;
    Logger.log('Example: 1,000,000 G$ = $' + usdAmount.toFixed(2) + ' USD');
    
  } catch (e) {
    Logger.log('Error: ' + e.message);
  }
}