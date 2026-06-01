/***** =========================================
 * GOODDOLLAR DASHBOARD — Daily v5.0
 * =========================================
 *
 * Single-file daily pipeline. The dev/test/one-shot/troubleshooting
 * functions live in a separate `dev_v5.gs` file.
 *
 * ENTRYPOINT
 * ----------
 *   smartBackfill()  — wired to the daily cron trigger. Self-healing:
 *                      finds the gap between the latest persisted date
 *                      for each metric and yesterday, then fills it.
 *
 * Other functions in this file are either helpers called by smartBackfill,
 * or `backfillRange(since, until)` for manual gap filling.
 *
 * SMARTBACKFILL PHASES
 * --------------------
 *   PHASE 1 — XDC INVITES INGESTION
 *     Incrementally sweeps Envio Hypersync for new InviteeJoined,
 *     InviterBounty, and G$ Transfer-from-invites-contract events.
 *     Appends new rows to the "XDC Invites Raw" sheet, deduped by
 *     (tx_hash, log_index). The sweep is wrapped in try/catch — if
 *     Hypersync is down, the rest of the pipeline still runs.
 *
 *   PHASE 2 — INDEX EXISTING FACTS
 *     Reads the entire "Daily Facts" sheet once and builds three maps:
 *       existingIndex     : {date|chain|metric → true}
 *       maxDates          : {chain|metric → latest YMD}
 *       factsValueIndex   : {date|chain|metric → value}
 *     All downstream lookups use these maps. No more per-metric sheet
 *     reads inside Computed/SupplyComputed/XdcReserveComputed adapters.
 *
 *   PHASE 3 — BUILD ROWS
 *     Iterates the METRICS registry, routes each metric to its adapter,
 *     skips already-persisted rows, and computes derived metrics. Every
 *     adapter call is wrapped in try/catch and produces exactly one
 *     Health row per (metric, chain) per run, even on exception.
 *     Final step appends new rows to "Daily Facts" (append-only — never
 *     overwrites existing rows). Emits AGG rows by summing chain values.
 *
 * AUDITING
 * --------
 * Audit + email alerting was moved out of smartBackfill into
 * auditFactsSheet() in dev_v5.gs, on its own daily trigger. Keeping it
 * separate (a) keeps smartBackfill lean, (b) lets audit run even when
 * smartBackfill itself fails, (c) lets you tune cadence independently.
 *
 * APPEND-ONLY MODEL
 * -----------------
 * Once a (date, chain, metric_key) row is written, it is immutable.
 * Bad data is fixed by manually deleting the row from the sheet, then
 * re-running smartBackfill (which will see the gap and refill it).
 * This is enforced both at the buildRows level (existingIndex skip) and
 * the writeFactsAndHealth level (re-checks before each append).
 *
 * TIMEZONE
 * --------
 * Everything is UTC. Onchain timestamps are unix seconds → UTC dates.
 * Sheet dates are written as 'YYYY-MM-DD' strings, parsed back through
 * a single toYMD() helper that never depends on the script timezone.
 *
 * MULTI-CHAIN PRICE MODEL
 * -----------------------
 * Two G$/USD prices coexist:
 *   celo_gd_price — from CELO reserve subgraph
 *   xdc_gd_price  — from XDC reserve subgraph
 * Computed metrics declare which price they need via priceSource:
 *   - All Celo metrics multiply by celo_gd_price (these come from Dune
 *     pre-computed, so the Computed adapter doesn't apply to them).
 *   - All XDC USD metrics multiply by xdc_gd_price.
 *   - gd_price_spread = xdc_gd_price - celo_gd_price.
 *****/

/***** =========================================
 * 0) CONFIG / CONSTANTS / REGISTRY
 * =========================================*/

const DEADLINES = {
  DUNE: 45, ETHERSCAN: 30, SUBGRAPH: 30,
  HYPERSYNC: 25, XDC_RPC: 15, SLACK: 10,
};

const CONFIG = {
  DEST_SPREADSHEET_ID: '1oFhPG8rWsG04kgrgtJy3By-_cDtrhSveL5HzuAATKxs',
  SHEET_FACTS:  'Daily Facts',
  SHEET_HEALTH: 'Health Runs',
  TIMEZONE: 'UTC',
  VERBOSE: true,
  XDC_GENESIS: '2025-11-12',
  LOOKBACK_ROWS: 3500,
  LOOKBACK_DAYS: 30,
  CARRY_FORWARD_MAX_DAYS: 7,
  PHASE_BUDGET_MS: 330000,
  WRITE_RESERVE_MS: 45000,
};

const CHAINS = { CELO: true, XDC: true, ETH: true, FUSE: true };

/** Goldsky subgraph endpoints */
const XDC_SUBGRAPH_URL         = 'https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/gd_xdc/1.2/gn';
const RESERVE_SUBGRAPH_URL     = 'https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/reserve_celo/1.0/gn';
const XDC_RESERVE_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/reserve_xdc/v1.0.0/gn';

/** G$ token contracts per chain (used by Supply helpers) */
const SUPPLY_CONTRACTS = {
  ETH_GD:           '0x67C5870b4A41D4Ebef24d2456547A03F1f3e094B',
  FUSE_GD:          '0x495d133B938596C9984d462F007B676bDc57eCEC',
  CELO_GD:          '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A',
  FROZEN_WALLET_1:  '0xec577447d314cf1e443e9f4488216651450dbe7c',
  FROZEN_WALLET_2:  '0x6738fa889ff31f82d9fe8862ec025dbe318f3fde',
};

// ETH GD supply is frozen after the hack — hard-coded to avoid Etherscan
// rate-limit failures and to enable full historical backfill via auditAndFillGaps().
var ETH_GD_TOTAL_SUPPLY_CONST  = 11125628315;   // G$ (Etherscan result / 100)
var ETH_GD_FROZEN_SUPPLY_CONST = 9208232844;    // G$ (sum of two frozen wallets / 100)

// GoodDollar reserve was deployed on XDC on this date. No reserve-derived
// metrics (price, liquidity, backing ratio) exist before it.
var XDC_RESERVE_SINCE = '2026-03-08';

/** XDC reserve on-chain addresses */
const XDC_RESERVE_CONTRACT = '0x94A3240f484A04F5e3d524f528d02694c109463b';
const XDC_COLLATERAL_TOKENS = {
  USDC: { address: '0xfa2958cb79b0491cc627c1557f441ef849ca8eb1', decimals: 6  },
  USDm: { address: '0x765de816845861e75a25fca122bb6898b8b1282a', decimals: 18 },
};
const XDC_RPC_URL = 'https://erpc.xinfin.network';

/** Dune query IDs */
const DUNE_IDS = {
  LIFETIMES:       '5966342',
  ACTIVE_CLAIMERS: '4834304',
  UBI_SUMMARIES:   '5710738',
  NEW_VS_RETURN:   '4834229',
  P2P_TRANSFERS:   '5521377',
};

/** XDC invites (Hypersync ingestion) config */
const XDC_INVITES_CFG = {
  CONTRACT:             '0x6bd698566632bf2e81e2278f1656cb24aaf06d2e',
  GENESIS_BLOCK:        95144756,
  CAMPAIGN_CODE:        'GOODXDC',
  // bytes32 = ASCII "GOODXDC" right-padded with zeros
  CAMPAIGN_CODE_HASH:   '0x474f4f4458444300000000000000000000000000000000000000000000000000',

  // keccak256 of canonical event signatures
  TOPIC_INVITEE_JOINED: '0xd8c638d8979e2ba5dba1f0d66246ee4b1c54b838f0e0a2b601365345eb23b051',
  TOPIC_INVITER_BOUNTY: '0x6081787cd1bd02ab1576c52f03e8710d792d460e7881c3155d77d23893f3768b',
  // keccak256("Transfer(address,address,uint256)")
  TOPIC_TRANSFER:       '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',

  HYPERSYNC_URL:        'https://xdc.hypersync.xyz/query',

  // Wall-clock budget for the Hypersync sweep portion of smartBackfill.
  // Apps Script execution cap is 6 minutes total — leave headroom for
  // the rest of the pipeline (Dune fetches, sheet writes, audit).
  TIME_BUDGET_MS:       3 * 60 * 1000,
  MAX_PAGES_PER_RUN:    200,
  RAW_FLUSH_CHUNK:      5000,

  PROP_LAST_BLOCK:      'xdc_invites_last_block',
  PROP_CAMPAIGN_OWNER:  'xdc_invites_campaign_owner',
  PROP_HYPERSYNC_TOKEN: 'HYPERSYNC_TOKEN',

  SHEET_RAW:            'XDC Invites Raw',

  // G$ on XDC is an 18-decimal ERC20 (matches xdc_p2p_gd_amount divisor).
  G_DECIMALS_DIVISOR:   1e18,

  // G$ token contract on XDC. Used to fetch Transfer events emitted
  // when the invites contract pays out bounties to inviter and invitee.
  GD_TOKEN:             '0xec2136843a983885aebf2feb3931f73a8ebee50c',
};

/** Raw sheet schema — 13 columns. One row per event. */
const XDC_INVITES_RAW_HEADERS = [
  'date', 'block_number', 'block_timestamp', 'tx_hash', 'log_index',
  'event', 'inviter', 'invitee', 'invite_type',
  'inviter_paid_g', 'invitee_paid_g', 'campaign_returned_g', 'total_paid_g'
];
const XDC_INVITES_RAW_COLS = XDC_INVITES_RAW_HEADERS.length;

/**
 * METRICS REGISTRY
 * Each entry declares how to fetch one metric. Properties:
 *   adapter   — Dune | Subgraph | Reserve | XdcReserve | Computed
 *               | Supply | SupplyComputed | XdcReserveComputed | XdcInvites
 *   chains    — which chains this metric applies to
 *   aggregate — if true, writeFactsAndHealth() generates an AGG row by
 *               summing chain values for the same base metric
 *   decimals  — rounding precision
 *   [adapter-specific config]
 *
 * To add a metric: add an entry here. If it uses an existing adapter
 * type, buildRows() picks it up automatically.
 */
const METRICS = {
  // ===== CELO ACTIVE USERS / CLAIMERS (Dune) =====
  celo_dau: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.ACTIVE_CLAIMERS, dateCol: 0, valueCol: 1 } },
  celo_wau: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.ACTIVE_CLAIMERS, dateCol: 0, valueCol: 2 } },
  celo_mau: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.ACTIVE_CLAIMERS, dateCol: 0, valueCol: 3 } },
  celo_yau: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 9 } },
  celo_new_claimers: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.NEW_VS_RETURN, dateCol: 0, valueCol: 2 } },
  celo_returning_claimers: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.NEW_VS_RETURN, dateCol: 0, valueCol: 3 } },

  // ===== XDC ACTIVE USERS / CLAIMERS (Subgraph) =====
  xdc_dau: { adapter: 'Subgraph', chains: ['XDC'], aggregate: false, decimals: 0,
    xdc: { type: 'daily_field', field: 'activeUsers' } },
  xdc_new_claimers: { adapter: 'Subgraph', chains: ['XDC'], aggregate: false, decimals: 0,
    xdc: { type: 'daily_field', field: 'newClaimers' } },
  xdc_returning_claimers: { adapter: 'Subgraph', chains: ['XDC'], aggregate: false, decimals: 0,
    xdc: { type: 'computed' } },

  // ===== P2P TRANSFERS (daily) =====
  celo_p2p_tx_count: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 2 } },
  xdc_p2p_tx_count: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 0,
    xdc: { type: 'transaction_daily', field: 'transactionsCountClean' } },
  celo_p2p_gd_amount: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 3 } },
  xdc_p2p_gd_amount: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 2,
    xdc: { type: 'transaction_daily', field: 'transactionsValueClean', divisor: 1e18 } },
  celo_p2p_usd_amount: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 4 } },

  // ===== P2P TRANSFERS (rolling 7d / 30d) =====
  celo_p2p_tx_count_7d: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 5 } },
  celo_p2p_gd_amount_7d: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 6 } },
  celo_p2p_usd_amount_7d: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 7 } },
  celo_p2p_tx_count_30d: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 8 } },
  celo_p2p_gd_amount_30d: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 9 } },
  celo_p2p_usd_amount_30d: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 10 } },
  xdc_p2p_tx_count_7d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 0,
    xdc: { type: 'transaction_rolling', field: 'transactionsCountClean', windowDays: 7 } },
  xdc_p2p_tx_count_30d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 0,
    xdc: { type: 'transaction_rolling', field: 'transactionsCountClean', windowDays: 30 } },
  xdc_p2p_gd_amount_7d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 2,
    xdc: { type: 'transaction_rolling', field: 'transactionsValueClean', windowDays: 7, divisor: 1e18 } },
  xdc_p2p_gd_amount_30d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 2,
    xdc: { type: 'transaction_rolling', field: 'transactionsValueClean', windowDays: 30, divisor: 1e18 } },

  // ===== P2P USERS =====
  celo_p2p_senders: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 11 } },
  celo_p2p_receivers: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 12 } },
  celo_p2p_users: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.P2P_TRANSFERS, dateCol: 0, valueCol: 13 } },

  // ===== P2P LIFETIME =====
  celo_p2p_lifetime_tx_count: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 1 } },
  xdc_p2p_lifetime_tx_count: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 0,
    xdc: { type: 'transaction_lifetime', field: 'transactionsCountClean' } },
  celo_p2p_lifetime_gd_amount: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 2 } },
  xdc_p2p_lifetime_gd_amount: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 2,
    xdc: { type: 'transaction_lifetime', field: 'transactionsValueClean', divisor: 1e18 } },
  celo_p2p_lifetime_unique_users: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 5 } },

  // ===== CLAIMS (lifetime) =====
  celo_lifetime_unique_claimers: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 6 } },
  xdc_lifetime_unique_claimers: { adapter: 'Subgraph', chains: ['XDC'], aggregate: false, decimals: 0,
    xdc: { type: 'global_total', field: 'uniqueClaimers' } },
  celo_lifetime_claim_txs: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 0,
    dune: { type: 'timeseries', queryId: DUNE_IDS.LIFETIMES, dateCol: 0, valueCol: 7 } },
  xdc_lifetime_claim_txs: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 0,
    xdc: { type: 'global_total', field: 'totalClaims' } },
  celo_lifetime_claimed_gd_amount: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 1 } },
  xdc_lifetime_claimed_gd_amount: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 2,
    xdc: { type: 'global_total', field: 'totalUBIDistributed', divisor: 1e18 } },
  celo_lifetime_claimed_usd_amount: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 2 } },
  // XDC: USD-converted via xdc_gd_price (Computed)
  xdc_lifetime_claimed_usd_amount: { adapter: 'Computed', chains: ['XDC'], aggregate: true, decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_lifetime_claimed_gd_amount', priceSource: 'xdc' } },

  // ===== CLAIMS (rolling) =====
  celo_gd_claimed_30d: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 3 } },
  xdc_gd_claimed_30d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 2,
    xdc: { type: 'rolling_sum', field: 'totalUBIDistributed', windowDays: 30, divisor: 1e18 } },
  celo_usd_claimed_30d: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 4 } },
  xdc_usd_claimed_30d: { adapter: 'Computed', chains: ['XDC'], aggregate: true, decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_gd_claimed_30d', priceSource: 'xdc' } },
  celo_gd_claimed_7d: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 6 } },
  xdc_gd_claimed_7d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 2,
    xdc: { type: 'rolling_sum', field: 'totalUBIDistributed', windowDays: 7, divisor: 1e18 } },
  celo_usd_claimed_7d: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 7 } },
  xdc_usd_claimed_7d: { adapter: 'Computed', chains: ['XDC'], aggregate: true, decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_gd_claimed_7d', priceSource: 'xdc' } },
  celo_gd_claimed_1d: { adapter: 'Dune', chains: ['CELO'], aggregate: true, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 9 } },
  xdc_gd_claimed_1d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: true, decimals: 2,
    xdc: { type: 'daily_field', field: 'totalUBIDistributed', divisor: 1e18 } },
  celo_usd_claimed_1d: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 10 } },
  xdc_usd_claimed_1d: { adapter: 'Computed', chains: ['XDC'], aggregate: true, decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_gd_claimed_1d', priceSource: 'xdc' } },

  // ===== PER-USER CLAIM AVERAGES =====
  celo_gd_per_user_30d: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 5 } },
  xdc_gd_per_user_30d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: false, decimals: 2,
    xdc: { type: 'rolling_sum', field: 'quota', windowDays: 30, divisor: 1e18 } },
  celo_gd_per_user_7d: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 8 } },
  xdc_gd_per_user_7d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: false, decimals: 2,
    xdc: { type: 'rolling_sum', field: 'quota', windowDays: 7, divisor: 1e18 } },
  celo_gd_per_user_1d: { adapter: 'Dune', chains: ['CELO'], aggregate: false, decimals: 2,
    dune: { type: 'timeseries', queryId: DUNE_IDS.UBI_SUMMARIES, dateCol: 0, valueCol: 11 } },
  xdc_gd_per_user_1d: { adapter: 'Subgraph', chains: ['XDC'], aggregate: false, decimals: 2,
    xdc: { type: 'daily_field', field: 'quota', divisor: 1e18 } },

  // ===== XDC P2P USD (computed via xdc_gd_price) =====
  xdc_p2p_usd_amount: { adapter: 'Computed', chains: ['XDC'], aggregate: true, decimals: 2,
    computed: { type: 'multiply_by_price', sourceMetric: 'xdc_p2p_gd_amount', priceSource: 'xdc' } },

  // ===== XDC GD IN CIRCULATION (from subgraph) =====
  xdc_gd_in_circulation: { adapter: 'Subgraph', chains: ['XDC'], aggregate: false, decimals: 2,
    xdc: { type: 'transaction_lifetime', field: 'totalInCirculation', divisor: 1e18 } },

  // ===== PRICES (per-chain reserves) =====
  celo_gd_price: { adapter: 'Reserve', chains: ['CELO'], aggregate: false, decimals: 8,
    reserve: { type: 'daily_avg_price' } },
  xdc_gd_price: { adapter: 'XdcReserve', chains: ['XDC'], aggregate: false, decimals: 8,
    xdcReserve: { type: 'gd_price' } },

  // ===== CELO RESERVE VOLUMES =====
  celo_reserve_in: { adapter: 'Reserve', chains: ['CELO'], aggregate: false, decimals: 2,
    reserve: { type: 'daily_volume', field: 'amountIn' } },
  celo_reserve_out: { adapter: 'Reserve', chains: ['CELO'], aggregate: false, decimals: 2,
    reserve: { type: 'daily_volume', field: 'amountOut' } },
  celo_reserve_volume: { adapter: 'Reserve', chains: ['CELO'], aggregate: false, decimals: 2,
    reserve: { type: 'daily_volume', field: 'volume' } },

  // ===== XDC RESERVE LIQUIDITY (from RPC) =====
  xdc_reserve_liquidity_usd: { adapter: 'XdcReserve', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcReserve: { type: 'reserve_liquidity' } },

  // ===== SUPPLY METRICS =====
  eth_gd_total_supply: { adapter: 'Supply', chains: ['ETH'], aggregate: false, decimals: 2,
    supply: { type: 'eth_total' } },
  eth_gd_frozen_supply: { adapter: 'Supply', chains: ['ETH'], aggregate: false, decimals: 2,
    supply: { type: 'eth_frozen' } },
  eth_gd_in_circulation: { adapter: 'SupplyComputed', chains: ['ETH'], aggregate: false, decimals: 2,
    supplyComputed: { type: 'eth_circulating' } },
  fuse_gd_in_circulation: { adapter: 'Supply', chains: ['FUSE'], aggregate: false, decimals: 2,
    supply: { type: 'fuse_supply' } },
  celo_gd_in_circulation: { adapter: 'Supply', chains: ['CELO'], aggregate: false, decimals: 2,
    supply: { type: 'celo_supply' } },
  agg_gd_in_circulation: { adapter: 'SupplyComputed', chains: ['AGG'], aggregate: false, decimals: 2,
    supplyComputed: { type: 'total_circulating' } },

  // ===== XDC RESERVE COMPUTED (depend on prices + supply) =====
  gd_price_spread: { adapter: 'XdcReserveComputed', chains: ['XDC'], aggregate: false, decimals: 8,
    xdcReserveComputed: { type: 'price_spread' } },
  xdc_reserve_backing_ratio: { adapter: 'XdcReserveComputed', chains: ['XDC'], aggregate: false, decimals: 8,
    xdcReserveComputed: { type: 'backing_ratio' } },
  xdc_daily_gd_minted: { adapter: 'XdcReserveComputed', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcReserveComputed: { type: 'daily_minted' } },
  xdc_reserve_growth_abs: { adapter: 'XdcReserveComputed', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcReserveComputed: { type: 'reserve_growth_abs' } },

  // ===== XDC INVITES (Hypersync) — daily + cumulative pairs =====
  // All metrics derive from the "XDC Invites Raw" sheet, populated by
  // the Hypersync sweep at the start of smartBackfill().
  //
  // Naming convention: bare key = events on exactly that day;
  //                    _at suffix = cumulative through that day.

  // -- Signups (from InviteeJoined) --
  xdc_invites_total_signups:        { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_total_signups' } },
  xdc_invites_total_signups_at:     { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_total_signups_at' } },
  xdc_invites_referral_signups:     { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_referral_signups' } },
  xdc_invites_referral_signups_at:  { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_referral_signups_at' } },
  xdc_invites_campaign_signups:     { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_campaign_signups' } },
  xdc_invites_campaign_signups_at:  { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_campaign_signups_at' } },
  xdc_invites_nocode_signups:       { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_nocode_signups' } },
  xdc_invites_nocode_signups_at:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_nocode_signups_at' } },

  // -- Unique users receiving bounties (from InviterBounty) --
  xdc_invites_total_unique_users:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_total_unique_users' } },
  xdc_invites_total_unique_users_at: { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_total_unique_users_at' } },
  xdc_invites_unique_invitees:       { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_unique_invitees' } },
  xdc_invites_unique_invitees_at:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_unique_invitees_at' } },
  xdc_invites_unique_inviters:       { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_unique_inviters' } },
  xdc_invites_unique_inviters_at:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_unique_inviters_at' } },

  // -- Bounty event counts --
  xdc_invites_total_bounties_count:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_total_bounties_count' } },
  xdc_invites_total_bounties_count_at: { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_total_bounties_count_at' } },
  xdc_invites_invitee_bounties_count:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_invitee_bounties_count' } },
  xdc_invites_invitee_bounties_count_at: { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_invitee_bounties_count_at' } },
  xdc_invites_inviter_bounties_count:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_inviter_bounties_count' } },
  xdc_invites_inviter_bounties_count_at: { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 0,
    xdcInvites: { metricKey: 'xdc_invites_inviter_bounties_count_at' } },

  // -- G$ amounts paid --
  xdc_invites_total_amount_paid:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcInvites: { metricKey: 'xdc_invites_total_amount_paid' } },
  xdc_invites_total_amount_paid_at: { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcInvites: { metricKey: 'xdc_invites_total_amount_paid_at' } },
  xdc_invites_invitee_amount_paid:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcInvites: { metricKey: 'xdc_invites_invitee_amount_paid' } },
  xdc_invites_invitee_amount_paid_at: { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcInvites: { metricKey: 'xdc_invites_invitee_amount_paid_at' } },
  xdc_invites_inviter_amount_paid:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcInvites: { metricKey: 'xdc_invites_inviter_amount_paid' } },
  xdc_invites_inviter_amount_paid_at: { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcInvites: { metricKey: 'xdc_invites_inviter_amount_paid_at' } },
  xdc_invites_campaign_amount_returned:    { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcInvites: { metricKey: 'xdc_invites_campaign_amount_returned' } },
  xdc_invites_campaign_amount_returned_at: { adapter: 'XdcInvites', chains: ['XDC'], aggregate: false, decimals: 2,
    xdcInvites: { metricKey: 'xdc_invites_campaign_amount_returned_at' } },
};


function notifySlack(message) {
  var webhookUrl = PropertiesService.getScriptProperties()
                                    .getProperty('SLACK_WEBHOOK_URL');
  if (!webhookUrl) {
    Logger.log('notifySlack: SLACK_WEBHOOK_URL not configured — skipping');
    return;
  }
  try {
    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: message }),
      deadline: DEADLINES.SLACK,
      muteHttpExceptions: true,
    });
  } catch (e) {
    Logger.log('notifySlack failed: ' + e.message);
  }
}

function loadMaxDatesCache() {
  var raw = PropertiesService.getScriptProperties().getProperty('MAX_DATES_V5');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function saveMaxDatesCache(maxDates) {
  PropertiesService.getScriptProperties()
                   .setProperty('MAX_DATES_V5', JSON.stringify(maxDates));
}

function roundDpStandalone(n, dp) {
  var x = Number(n);
  if (!isFinite(x)) throw new Error('roundDpStandalone: non-finite value: ' + n);
  return Number(x.toFixed(dp));
}

/***** =========================================
 * 1) UTILITIES
 * =========================================*/

function nowIso() {
  return Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm:ss');
}

function generateRunId() {
  return Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd_HHmmss');
}

/**
 * Single canonical date-to-YMD converter. Used everywhere a sheet cell,
 * Date object, or string needs to become a 'YYYY-MM-DD' string. With the
 * UTC timezone, this is unambiguous — no DST or zone-shift bugs.
 */
function toYMD(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  }
  const s = String(value).trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  // Numeric forms (sheet serial, unix ms, unix s) — defensive fallback.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (num > 40000 && num < 60000) {
      // Sheets serial date
      const d = new Date((num - 25569) * 86400 * 1000);
      return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
    }
    if (num > 1e12) return Utilities.formatDate(new Date(num),         'UTC', 'yyyy-MM-dd');
    if (num > 1e9)  return Utilities.formatDate(new Date(num * 1000),  'UTC', 'yyyy-MM-dd');
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  return null;
}

function parseYMD(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error('parseYMD: invalid format: ' + ymd);
  // Construct in UTC so addDays/diffDays don't drift across DST.
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function getYesterdayYMD() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function addDays(ymd, n) {
  const d = parseYMD(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function dateDiffDays(a, b) {
  return Math.round((parseYMD(b).getTime() - parseYMD(a).getTime()) / 86400000);
}


/***** =========================================
 * 2) SPREADSHEET HELPERS
 * =========================================*/

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

  // Invites raw sheet — created on first run with the v5 schema.
  xdcInvitesEnsureRawSheet();

  return { facts: facts, health: health };
}

/**
 * Read the entire Daily Facts sheet once and build three indexes:
 *   existingIndex   : { "date|chain|metric": true }    (dedup check)
 *   maxDates        : { "chain|metric": "YYYY-MM-DD" }  (smartBackfill cursor)
 *   factsValueIndex : { "date|chain|metric": value }    (value lookup)
 *
 * All downstream adapters use factsValueIndex instead of re-reading the
 * sheet. This is the single biggest perf win in v5 — old code was reading
 * the entire facts sheet up to ~10× per run.
 */
function getExistingFactsIndex() {
  var ss    = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  if (!facts) return { existingIndex: {}, maxDates: {}, factsValueIndex: {} };
  var lastRow = facts.getLastRow();
  if (lastRow < 2) return { existingIndex: {}, maxDates: {}, factsValueIndex: {} };

  // Read only the tail — after migration, sheet is ascending date order,
  // so tail = most recent ~37 days of data.
  var startRow = Math.max(2, lastRow - CONFIG.LOOKBACK_ROWS + 1);
  var rowCount = lastRow - startRow + 1;
  var t0 = Date.now();
  var data = facts.getRange(startRow, 1, rowCount, 5).getValues();
  Logger.log('Phase 2: read ' + rowCount + ' rows (tail of ' + lastRow + ' total) in '
             + (Date.now() - t0) + 'ms');

  var existingIndex = {}, factsValueIndex = {}, maxDates = {};
  for (var i = 0; i < data.length; i++) {
    var ymd = toYMD(data[i][0]), chain = data[i][1], metricKey = data[i][2];
    var value = Number(data[i][3]);
    if (!ymd || !chain || !metricKey) continue;
    var key = ymd + '|' + chain + '|' + metricKey;
    existingIndex[key]   = true;
    factsValueIndex[key] = isFinite(value) ? value : null;
    var cm = chain + '|' + metricKey;
    if (!maxDates[cm] || ymd > maxDates[cm]) maxDates[cm] = ymd;
  }

  return { existingIndex: existingIndex, maxDates: maxDates, factsValueIndex: factsValueIndex };
}


/***** =========================================
 * 3) DUNE HELPERS
 * =========================================*/

function duneApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('DUNE_API_KEY');
  if (!key) throw new Error('Missing DUNE_API_KEY in Script Properties');
  return key;
}

function etherscanApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('ETHERSCAN_API_KEY');
  if (!key) throw new Error('Missing ETHERSCAN_API_KEY in Script Properties');
  return key;
}

function duneFetchTable(queryId, limit) {
  limit = limit || 10000;
  const url = 'https://api.dune.com/api/v1/query/' + encodeURIComponent(String(queryId)) + '/results?limit=' + limit;

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    deadline: DEADLINES.DUNE,
    headers: { 'X-DUNE-API-KEY': duneApiKey() }
  });

  const status = res.getResponseCode();
  const text = res.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('Dune HTTP ' + status + ': ' + text.slice(0, 500));
  }

  const json = JSON.parse(text);
  const result = json.result || {};
  const rowsObj = result.rows || [];
  const cols = (result.metadata && result.metadata.column_names) || [];

  // Convert objects to arrays in column order so adapters can use numeric indices.
  const rows = [];
  for (var i = 0; i < rowsObj.length; i++) {
    const row = [];
    for (var j = 0; j < cols.length; j++) row.push(rowsObj[i][cols[j]]);
    rows.push(row);
  }

  Logger.log('Dune ' + queryId + ': ' + rows.length + ' rows');
  return { rows: rows, cols: cols };
}


/***** =========================================
 * 4a) XDC SUBGRAPH HELPERS (Goldsky)
 * =========================================
 * The XDC GoodDollar subgraph indexes UBI claims, P2P transfers, and
 * user activity on XDC. dailyUBIs is keyed by "dayISO" = floor(unix/86400).
 *****/

function xdcYmdToDayISO(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  return String(Math.floor(d.getTime() / 1000 / 86400));
}

function xdcDayISOToYmd(dayISO) {
  const d = new Date(Number(dayISO) * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function xdcGqlRequest(queryStr) {
  const res = UrlFetchApp.fetch(XDC_SUBGRAPH_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ query: queryStr, variables: {} }),
    muteHttpExceptions: true,
    deadline: DEADLINES.SUBGRAPH,
    headers: { 'Accept': 'application/json' }
  });
  const status = res.getResponseCode();
  const text = res.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('XDC Subgraph HTTP ' + status + ': ' + text.slice(0, 500));
  }
  const json = JSON.parse(text);
  if (json.errors && json.errors.length) {
    throw new Error('XDC Subgraph GraphQL: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

function xdcFetchDailyField(spec, sinceDayISO, untilDayISO) {
  const query = 'query { dailyUBIs(first: 365, orderBy: id, orderDirection: asc, where: { id_gte: "'
    + sinceDayISO + '", id_lte: "' + untilDayISO + '" }) { id ' + spec.field + ' } }';
  const data = xdcGqlRequest(query);
  const nodes = (data && data.dailyUBIs) || [];
  const out = [];
  for (var i = 0; i < nodes.length; i++) {
    var val = Number(String(nodes[i][spec.field] || 0).replace(/,/g, ''));
    if (spec.divisor) val = val / spec.divisor;
    out.push({ date: xdcDayISOToYmd(nodes[i].id), value: val, source: 'XDC_SUBGRAPH' });
  }
  return out;
}

function xdcFetchGlobalTotal(spec, untilDate) {
  const query = 'query { globalStatistics_collection(first: 1) { id ' + spec.field + ' } }';
  const data = xdcGqlRequest(query);
  if (!data || !data.globalStatistics_collection || !data.globalStatistics_collection.length) return [];
  var val = Number(String(data.globalStatistics_collection[0][spec.field] || 0).replace(/,/g, ''));
  if (spec.divisor) val = val / spec.divisor;
  return [{ date: untilDate, value: val, source: 'XDC_SUBGRAPH' }];
}

function xdcFetchRollingSum(spec, sinceDayISO, untilDayISO) {
  const windowDays = spec.windowDays || 7;
  const sinceNum = Number(sinceDayISO);
  const extendedSince = String(Math.max(0, sinceNum - (windowDays - 1)));

  const dailyRows = xdcFetchDailyField(
    { field: spec.field, divisor: spec.divisor },
    extendedSince, untilDayISO
  );
  if (!dailyRows.length) return [];

  const dayToValue = {};
  for (var i = 0; i < dailyRows.length; i++) {
    dayToValue[xdcYmdToDayISO(dailyRows[i].date)] = dailyRows[i].value;
  }

  const untilNum = Number(untilDayISO);
  const out = [];
  for (var d = sinceNum; d <= untilNum; d++) {
    var sum = 0;
    for (var lb = 0; lb < windowDays; lb++) {
      sum += dayToValue[String(d - lb)] || 0;
    }
    out.push({ date: xdcDayISOToYmd(String(d)), value: sum, source: 'XDC_SUBGRAPH' });
  }
  return out;
}

function xdcFetchTransactionDaily(spec, sinceDayISO, untilDayISO) {
  const sinceTs = Number(sinceDayISO) * 86400;
  const untilTs = (Number(untilDayISO) + 1) * 86400;
  const query = 'query { transactionStats(first: 365, orderBy: id, orderDirection: asc, where: { id_not: "aggregated", id_gte: "'
    + sinceTs + '", id_lt: "' + untilTs + '" }) { id ' + spec.field + ' } }';
  const data = xdcGqlRequest(query);
  const nodes = (data && data.transactionStats) || [];
  const out = [];
  for (var i = 0; i < nodes.length; i++) {
    const ymd = new Date(Number(nodes[i].id) * 1000).toISOString().slice(0, 10);
    var val = Number(String(nodes[i][spec.field] || 0).replace(/,/g, ''));
    if (spec.divisor) val = val / spec.divisor;
    out.push({ date: ymd, value: val, source: 'XDC_SUBGRAPH' });
  }
  return out;
}

function xdcFetchTransactionLifetime(spec, untilDate) {
  const query = 'query { transactionStats(where: { id: "aggregated" }) { id ' + spec.field + ' } }';
  const data = xdcGqlRequest(query);
  if (!data || !data.transactionStats || !data.transactionStats.length) return [];
  var val = Number(String(data.transactionStats[0][spec.field] || 0).replace(/,/g, ''));
  if (spec.divisor) val = val / spec.divisor;
  return [{ date: untilDate, value: val, source: 'XDC_SUBGRAPH' }];
}

function xdcFetchTransactionRolling(spec, sinceDayISO, untilDayISO) {
  const windowDays = spec.windowDays || 7;
  const sinceNum = Number(sinceDayISO);
  const extendedSince = String(Math.max(0, sinceNum - (windowDays - 1)));

  const dailyRows = xdcFetchTransactionDaily(
    { field: spec.field, divisor: spec.divisor },
    extendedSince, untilDayISO
  );
  if (!dailyRows.length) return [];

  const dayToValue = {};
  for (var i = 0; i < dailyRows.length; i++) {
    dayToValue[xdcYmdToDayISO(dailyRows[i].date)] = dailyRows[i].value;
  }

  const untilNum = Number(untilDayISO);
  const out = [];
  for (var d = sinceNum; d <= untilNum; d++) {
    var sum = 0;
    for (var lb = 0; lb < windowDays; lb++) sum += dayToValue[String(d - lb)] || 0;
    out.push({ date: xdcDayISOToYmd(String(d)), value: sum, source: 'XDC_SUBGRAPH' });
  }
  return out;
}


/***** =========================================
 * 4b) CELO RESERVE SUBGRAPH (Goldsky)
 * =========================================
 * Powers celo_gd_price and celo_reserve_in/out/volume.
 *****/

function ymdToDayISO(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  return String(Math.floor(d.getTime() / 1000 / 86400));
}

function dayISOToYmd(dayISO) {
  return new Date(Number(dayISO) * 86400 * 1000).toISOString().slice(0, 10);
}

function reserveGqlRequest(queryStr) {
  const res = UrlFetchApp.fetch(RESERVE_SUBGRAPH_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ query: queryStr, variables: {} }),
    muteHttpExceptions: true,
    deadline: DEADLINES.SUBGRAPH,
    headers: { 'Accept': 'application/json' }
  });
  const status = res.getResponseCode();
  const text = res.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('Reserve Subgraph HTTP ' + status + ': ' + text.slice(0, 500));
  }
  const json = JSON.parse(text);
  if (json.errors && json.errors.length) {
    throw new Error('Reserve Subgraph GraphQL: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

/**
 * Fetch volume-weighted average G$ prices on the CELO reserve for an
 * entire window in a SINGLE subgraph call. Returns one row per day in
 * [sinceYMD, untilYMD]. Days with no swap activity carry forward the
 * most recent prior price.
 *
 * Volume weighting: each swap's price is weighted by its `amountIn`,
 * so a swap that moved 1M tokens has more weight than one that moved
 * 100. Falls back to simple average if amountIn isn't available.
 *
 * Pagination: the subgraph returns up to 1000 events per page. We
 * paginate with `timestamp_gt` until we get a partial page or hit a
 * safety cap. For typical activity windows this is 1-2 calls.
 *
 * Carry-forward: if the first day in the window has no events, we do
 * one extra query for the most recent event strictly before the
 * window. After that, days inherit the previous day's price in memory.
 */
function reserveFetchDailyAvgPriceBatch(sinceYMD, untilYMD) {
  const sinceTs = Math.floor(new Date(sinceYMD + 'T00:00:00Z').getTime() / 1000);
  const untilTs = Math.floor(new Date(untilYMD + 'T23:59:59Z').getTime() / 1000);

  // Paginated fetch of all events in the window
  const events = [];
  var lastTs = String(sinceTs - 1); // strict gt, so subtract 1 to include sinceTs itself
  for (var page = 0; page < 10; page++) {
    const query = 'query { reservePrices(first: 1000, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: "'
      + lastTs + '", timestamp_lte: "' + untilTs + '" }) { id day price timestamp amountIn } }';
    const data = reserveGqlRequest(query);
    const nodes = (data && data.reservePrices) || [];
    if (!nodes.length) break;
    for (var i = 0; i < nodes.length; i++) events.push(nodes[i]);
    lastTs = nodes[nodes.length - 1].timestamp;
    if (nodes.length < 1000) break;
  }

  // Group events by YMD and compute volume-weighted average price per day
  const byDay = {}; // ymd -> { weightedSum, weightTotal }
  for (var k = 0; k < events.length; k++) {
    const e = events[k];
    const ymd = dayISOToYmd(e.day);
    const price = Number(e.price) / 1e18;
    const weight = Number(e.amountIn) || 0;
    if (!byDay[ymd]) byDay[ymd] = { weightedSum: 0, weightTotal: 0, count: 0, simpleSum: 0 };
    byDay[ymd].count++;
    byDay[ymd].simpleSum += price;
    if (weight > 0) {
      byDay[ymd].weightedSum += price * weight;
      byDay[ymd].weightTotal += weight;
    }
  }

  // Carry-forward seed: if no events landed on sinceYMD, find the most
  // recent prior price so day 1 of the window isn't missing.
  var lastKnownPrice = null;
  if (!byDay[sinceYMD]) {
    const fbQuery = 'query { reservePrices(first: 1, orderBy: timestamp, orderDirection: desc, where: { timestamp_lt: "'
      + sinceTs + '" }) { price timestamp } }';
    const fb = reserveGqlRequest(fbQuery);
    if (fb && fb.reservePrices && fb.reservePrices.length) {
      lastKnownPrice = Number(fb.reservePrices[0].price) / 1e18;
    }
  }

  // Walk the window day by day, emitting one row per day
  const out = [];
  var d = sinceYMD;
  while (d <= untilYMD) {
    if (byDay[d]) {
      const b = byDay[d];
      const avg = (b.weightTotal > 0)
        ? b.weightedSum / b.weightTotal
        : b.simpleSum / b.count;
      out.push({ date: d, value: avg, source: 'CELO_RESERVE_SUBGRAPH' });
      lastKnownPrice = avg;
    } else if (lastKnownPrice != null) {
      out.push({ date: d, value: lastKnownPrice, source: 'CELO_RESERVE_SUBGRAPH+CARRY_FORWARD' });
    }
    // else: no events for this day AND no prior price → skip (no row)
    d = addDays(d, 1);
  }
  return out;
}

function reserveFetchDailyVolume(spec, sinceDayISO, untilDayISO) {
  // Cap window to 60 days to avoid pulling too much per call.
  var sinceNum = Number(sinceDayISO);
  const untilNum = Number(untilDayISO);
  if (untilNum - sinceNum > 60) sinceNum = untilNum - 60;
  sinceDayISO = String(sinceNum);

  const allNodes = [];
  var lastTs = '0';
  for (var page = 0; page < 10; page++) {
    const query = 'query { reservePrices(first: 1000, orderBy: timestamp, orderDirection: asc, where: { day_gte: "'
      + sinceDayISO + '", day_lte: "' + untilDayISO + '", timestamp_gt: "' + lastTs + '" }) { id day amountIn amountOut timestamp } }';
    const data = reserveGqlRequest(query);
    const nodes = (data && data.reservePrices) || [];
    if (!nodes.length) break;
    for (var i = 0; i < nodes.length; i++) allNodes.push(nodes[i]);
    lastTs = nodes[nodes.length - 1].timestamp;
    if (nodes.length < 1000) break;
  }

  // Aggregate per day
  const byDay = {};
  for (var k = 0; k < allNodes.length; k++) {
    const n = allNodes[k];
    const ymd = dayISOToYmd(n.day);
    if (!byDay[ymd]) byDay[ymd] = 0;
    var v;
    if (spec.field === 'amountIn')       v = Number(n.amountIn)  / 1e18;
    else if (spec.field === 'amountOut') v = Number(n.amountOut) / 1e18;
    else                                 v = (Number(n.amountIn) + Number(n.amountOut)) / 1e18;
    byDay[ymd] += v;
  }

  const out = [];
  const days = Object.keys(byDay).sort();
  for (var d = 0; d < days.length; d++) {
    out.push({ date: days[d], value: byDay[days[d]], source: 'CELO_RESERVE_SUBGRAPH' });
  }
  return out;
}

function reserveFetchDailyVolumeBundle(sinceDayISO, untilDayISO) {
  var sinceNum = Number(sinceDayISO), untilNum = Number(untilDayISO);
  if (untilNum - sinceNum > 60) sinceNum = untilNum - 60;
  sinceDayISO = String(sinceNum);
  var allNodes = [], lastTs = '0';
  for (var page = 0; page < 10; page++) {
    var query = 'query { reservePrices(first: 1000, orderBy: timestamp, orderDirection: asc, '
      + 'where: { day_gte: "' + sinceDayISO + '", day_lte: "' + untilDayISO
      + '", timestamp_gt: "' + lastTs + '" }) { id day amountIn amountOut timestamp } }';
    var data  = reserveGqlRequest(query);
    var nodes = (data && data.reservePrices) || [];
    if (!nodes.length) break;
    for (var i = 0; i < nodes.length; i++) allNodes.push(nodes[i]);
    lastTs = nodes[nodes.length - 1].timestamp;
    if (nodes.length < 1000) break;
  }
  var byDay = {};
  for (var k = 0; k < allNodes.length; k++) {
    var n = allNodes[k], ymd = dayISOToYmd(n.day);
    if (!byDay[ymd]) byDay[ymd] = { amountIn: 0, amountOut: 0 };
    byDay[ymd].amountIn  += Number(n.amountIn)  / 1e18;
    byDay[ymd].amountOut += Number(n.amountOut) / 1e18;
  }
  for (var ymd in byDay) byDay[ymd].volume = byDay[ymd].amountIn + byDay[ymd].amountOut;
  return byDay;
}


/***** =========================================
 * 4c) XDC RESERVE SUBGRAPH + RPC
 * =========================================
 * Two data sources:
 *  - XDC Reserve Subgraph: G$ price events from on-chain swaps. Each
 *    event has price (raw integer, /1e6 → USD) and timestamp. Filtered
 *    by day boundary timestamps for precision.
 *  - XDC RPC: ERC-20 balanceOf for collateral tokens held by the reserve
 *    contract. Reads at `latest` block — historical state is pruned by
 *    public XDC RPCs, so this is the only option without an archive node.
 *    The script runs ~01:00 UTC, so the labeling drift is minimal.
 *****/

function xdcReserveGqlRequest(queryStr) {
  const res = UrlFetchApp.fetch(XDC_RESERVE_SUBGRAPH_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ query: queryStr, variables: {} }),
    muteHttpExceptions: true,
    deadline: DEADLINES.SUBGRAPH,
    headers: { 'Accept': 'application/json' }
  });
  const status = res.getResponseCode();
  const text = res.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('XDC Reserve Subgraph HTTP ' + status + ': ' + text.slice(0, 500));
  }
  const json = JSON.parse(text);
  if (json.errors && json.errors.length) {
    throw new Error('XDC Reserve Subgraph GraphQL: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

/**
 * Fetch volume-weighted average G$ prices on the XDC reserve for an
 * entire window in a single subgraph call. Mirrors the CELO version
 * (see reserveFetchDailyAvgPriceBatch). Key difference: XDC reserve
 * subgraph returns price as a 6-decimal integer (divide by 1e6),
 * not 18-decimal like CELO.
 */
function xdcReserveFetchGdPriceBatch(sinceYMD, untilYMD) {
  // Clamp to XDC genesis — there's no data before
  if (sinceYMD < CONFIG.XDC_GENESIS) sinceYMD = CONFIG.XDC_GENESIS;
  if (untilYMD < CONFIG.XDC_GENESIS) return [];

  const sinceTs = Math.floor(new Date(sinceYMD + 'T00:00:00Z').getTime() / 1000);
  const untilTs = Math.floor(new Date(untilYMD + 'T23:59:59Z').getTime() / 1000);

  // Paginated fetch of all events in the window
  const events = [];
  var lastTs = String(sinceTs - 1);
  for (var page = 0; page < 10; page++) {
    const query = '{ reservePrices(first: 1000, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: "'
      + lastTs + '", timestamp_lte: "' + untilTs + '" }) { price timestamp amountIn } }';
    const data = xdcReserveGqlRequest(query);
    const nodes = (data && data.reservePrices) || [];
    if (!nodes.length) break;
    for (var i = 0; i < nodes.length; i++) events.push(nodes[i]);
    lastTs = nodes[nodes.length - 1].timestamp;
    if (nodes.length < 1000) break;
  }

  // Group events by YMD with volume weighting
  const byDay = {};
  for (var k = 0; k < events.length; k++) {
    const e = events[k];
    const ymd = new Date(Number(e.timestamp) * 1000).toISOString().slice(0, 10);
    const price = Number(e.price) / 1e6;
    const weight = Number(e.amountIn) || 0;
    if (!byDay[ymd]) byDay[ymd] = { weightedSum: 0, weightTotal: 0, count: 0, simpleSum: 0 };
    byDay[ymd].count++;
    byDay[ymd].simpleSum += price;
    if (weight > 0) {
      byDay[ymd].weightedSum += price * weight;
      byDay[ymd].weightTotal += weight;
    }
  }

  // Carry-forward seed for first day
  var lastKnownPrice = null;
  if (!byDay[sinceYMD]) {
    const fbQuery = '{ reservePrices(first: 1, orderBy: timestamp, orderDirection: desc, where: { timestamp_lt: "'
      + sinceTs + '" }) { price timestamp } }';
    const fb = xdcReserveGqlRequest(fbQuery);
    if (fb && fb.reservePrices && fb.reservePrices.length) {
      lastKnownPrice = Number(fb.reservePrices[0].price) / 1e6;
    }
  }

  // Walk window, emitting one row per day
  const out = [];
  var d = sinceYMD;
  while (d <= untilYMD) {
    if (byDay[d]) {
      const b = byDay[d];
      const avg = (b.weightTotal > 0)
        ? b.weightedSum / b.weightTotal
        : b.simpleSum / b.count;
      out.push({ date: d, value: avg, source: 'XDC_RESERVE_SUBGRAPH' });
      lastKnownPrice = avg;
    } else if (lastKnownPrice != null) {
      out.push({ date: d, value: lastKnownPrice, source: 'XDC_RESERVE_SUBGRAPH+CARRY_FORWARD' });
    }
    d = addDays(d, 1);
  }
  return out;
}

function xdcRpcCall(to, data) {
  const res = UrlFetchApp.fetch(XDC_RPC_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: to, data: data }, 'latest']
    }),
    muteHttpExceptions: true,
    deadline: DEADLINES.XDC_RPC
  });
  const status = res.getResponseCode();
  const text = res.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('XDC RPC HTTP ' + status + ': ' + text.slice(0, 500));
  }
  const json = JSON.parse(text);
  if (json.error) throw new Error('XDC RPC error: ' + JSON.stringify(json.error));
  return json.result;
}

function fetchXdcTokenBalance(tokenAddress, holderAddress, decimals) {
  // balanceOf(address) selector + left-padded address
  var padded = holderAddress.replace(/^0x/, '').toLowerCase();
  while (padded.length < 64) padded = '0' + padded;
  const result = xdcRpcCall(tokenAddress, '0x70a08231' + padded);
  if (!result || result === '0x') return 0;
  return Number(BigInt(result)) / Math.pow(10, decimals);
}

function fetchXdcReserveLiquidity(untilYMD) {
  var totalUsd = 0;
  const keys = Object.keys(XDC_COLLATERAL_TOKENS);
  for (var i = 0; i < keys.length; i++) {
    const t = XDC_COLLATERAL_TOKENS[keys[i]];
    totalUsd += fetchXdcTokenBalance(t.address, XDC_RESERVE_CONTRACT, t.decimals);
  }
  return [{ date: untilYMD, value: totalUsd, source: 'XDC_ONCHAIN_RPC' }];
}


/***** =========================================
 * 4d) SUPPLY HELPERS (Block Explorers)
 * =========================================*/

function fetchEthereumSupply(untilYMD) {
  var url = 'https://api.etherscan.io/v2/api?chainid=1&module=stats&action=tokensupply'
    + '&contractaddress=' + SUPPLY_CONTRACTS.ETH_GD
    + '&apikey=' + etherscanApiKey();
  var json = JSON.parse(
    UrlFetchApp.fetch(url, { muteHttpExceptions: true, deadline: DEADLINES.ETHERSCAN })
               .getContentText()
  );
  if (!json || typeof json.result !== 'string' || !/^\d+$/.test(json.result)) {
    throw new Error('Etherscan tokensupply API error: ' + JSON.stringify(json).slice(0, 300));
  }
  var value = Number(json.result) / 100;
  if (!isFinite(value) || value <= 0) {
    throw new Error('Etherscan tokensupply returned implausible value: ' + value);
  }
  return [{ date: untilYMD, value: value, source: 'ETHERSCAN_API' }];
}

function fetchEthereumFrozenSupply(untilYMD) {
  var wallets = [SUPPLY_CONTRACTS.FROZEN_WALLET_1, SUPPLY_CONTRACTS.FROZEN_WALLET_2];
  var total = 0;
  for (var i = 0; i < wallets.length; i++) {
    var url = 'https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokenbalance'
      + '&contractaddress=' + SUPPLY_CONTRACTS.ETH_GD
      + '&address=' + wallets[i]
      + '&tag=latest&apikey=' + etherscanApiKey();
    var json = JSON.parse(
      UrlFetchApp.fetch(url, { muteHttpExceptions: true, deadline: DEADLINES.ETHERSCAN })
                 .getContentText()
    );
    if (!json || typeof json.result !== 'string' || !/^\d+$/.test(json.result)) {
      throw new Error('Etherscan tokenbalance API error for wallet ' + wallets[i]
        + ': ' + JSON.stringify(json).slice(0, 300));
    }
    total += Number(json.result) / 100;
  }
  if (!isFinite(total) || total < 0) {
    throw new Error('Etherscan frozen supply returned implausible total: ' + total);
  }
  return [{ date: untilYMD, value: total, source: 'ETHERSCAN_API' }];
}

function fetchFuseSupply(untilYMD) {
  var url = 'https://explorer.fuse.io/api?module=stats&action=tokensupply&contractaddress=' + SUPPLY_CONTRACTS.FUSE_GD;
  var json = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true, deadline: DEADLINES.ETHERSCAN }).getContentText());
  if (!json || typeof json.result !== 'string' || !/^\d+$/.test(json.result)) {
    throw new Error('Fuse Explorer API error: ' + JSON.stringify(json).slice(0, 300));
  }
  var value = Number(json.result) / 100;
  if (!isFinite(value) || value <= 0) {
    throw new Error('Fuse Explorer returned implausible value: ' + value);
  }
  return [{ date: untilYMD, value: value, source: 'FUSE_EXPLORER_API' }];
}

function fetchCeloSupply(untilYMD) {
  var url = 'https://explorer.celo.org/mainnet/api?module=stats&action=tokensupply&contractaddress=' + SUPPLY_CONTRACTS.CELO_GD;
  var json = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true, deadline: DEADLINES.ETHERSCAN }).getContentText());
  if (!json || typeof json.result !== 'string' || !/^\d+$/.test(json.result)) {
    throw new Error('Celo Explorer API error: ' + JSON.stringify(json).slice(0, 300));
  }
  var value = Number(json.result) / 1e18;
  if (!isFinite(value) || value <= 0) {
    throw new Error('Celo Explorer returned implausible value: ' + value);
  }
  return [{ date: untilYMD, value: value, source: 'CELO_EXPLORER_API' }];
}


/***** =========================================
 * 5) XDC INVITES (HYPERSYNC INGESTION + AGGREGATION)
 * =========================================
 *
 * Phase 1 of smartBackfill: incrementally fetch new invite events from
 * Envio Hypersync and append them to the "XDC Invites Raw" sheet. The
 * sheet is the source of truth — all 28 xdc_invites_* metrics are derived
 * from it by walking the events and computing daily + cumulative values.
 *
 * RAW SHEET SCHEMA (v5, 13 columns)
 * ---------------------------------
 * date, block_number, block_timestamp, tx_hash, log_index, event,
 * inviter, invitee, invite_type, inviter_paid_g, invitee_paid_g,
 * campaign_returned_g, total_paid_g
 *
 * - For InviteeJoined rows: invite_type ∈ {referral, campaign_code, no_code},
 *   payment columns are 0.
 * - For InviterBounty rows: invite_type is empty, payment columns hold
 *   the G$ amounts derived from joining ERC-20 Transfer logs in the same tx.
 *
 * DEDUP
 * -----
 * Append-only. Before writing new events we read the (tx_hash, log_index)
 * set from the existing raw sheet and skip any incoming duplicate. The
 * Hypersync cursor (PropertiesService prop xdc_invites_last_block) is the
 * primary safeguard, but the dedup check makes manual cursor resets safe.
 *****/

function hypersyncToken() {
  return PropertiesService.getScriptProperties().getProperty(XDC_INVITES_CFG.PROP_HYPERSYNC_TOKEN) || '';
}

/**
 * Generic Hypersync log fetcher with pagination, retries, and time budget.
 * Used both for the live invite event sweep and (in dev script) for
 * historical Transfer-join repair.
 */
function hypersyncFetchLogs(opts) {
  const fromBlock  = opts.fromBlock;
  const toBlock    = (typeof opts.toBlock === 'number') ? opts.toBlock : null;
  const deadlineMs = opts.deadlineMs || (Date.now() + XDC_INVITES_CFG.TIME_BUDGET_MS);
  const maxPages   = opts.maxPages   || XDC_INVITES_CFG.MAX_PAGES_PER_RUN;

  var logSelections;
  if (opts.logSelections && opts.logSelections.length) {
    logSelections = opts.logSelections;
  } else {
    const addrs = (opts.addresses || []).map(function(a) { return a.toLowerCase(); });
    if (!addrs.length || !opts.topic0List || !opts.topic0List.length) {
      throw new Error('hypersyncFetchLogs: addresses+topic0List or logSelections required');
    }
    logSelections = [{ address: addrs, topics: [opts.topic0List] }];
  }

  const allLogs = [];
  const blocksByNumber = {};
  var cursor = fromBlock;
  var pages = 0;
  var reachedTip = false;
  var lastScannedBlock = fromBlock;

  while (pages < maxPages) {
    if (Date.now() > deadlineMs) {
      Logger.log('  hypersync: time budget exhausted at block ' + cursor + ' after ' + pages + ' pages');
      break;
    }

    const body = {
      from_block: cursor,
      logs: logSelections,
      field_selection: {
        block: ['number', 'timestamp'],
        log:   ['block_number', 'transaction_hash', 'log_index', 'address',
                'topic0', 'topic1', 'topic2', 'data']
      }
    };
    if (toBlock !== null) body.to_block = toBlock + 1; // exclusive

    const resp = hypersyncPostWithRetry(body);

    const chunks = resp.data || [];
    for (var i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const cb = chunk.blocks || [];
      for (var b = 0; b < cb.length; b++) {
        if (cb[b] && typeof cb[b].number === 'number') {
          blocksByNumber[cb[b].number] = cb[b].timestamp;
        }
      }
      const cl = chunk.logs || [];
      for (var j = 0; j < cl.length; j++) allLogs.push(cl[j]);
    }

    pages++;
    const nextBlock = resp.next_block;
    const archiveHeight = resp.archive_height;

    if (typeof nextBlock !== 'number') {
      Logger.log('  hypersync: missing next_block in response, stopping');
      break;
    }

    lastScannedBlock = nextBlock - 1;
    cursor = nextBlock;

    if (toBlock !== null && cursor > toBlock) {
      reachedTip = true;
      lastScannedBlock = toBlock;
      break;
    }
    if (typeof archiveHeight === 'number' && cursor > archiveHeight) {
      reachedTip = true;
      lastScannedBlock = archiveHeight;
      break;
    }
  }

  return {
    logs: allLogs,
    blocksByNumber: blocksByNumber,
    lastScannedBlock: lastScannedBlock,
    reachedTip: reachedTip,
    pages: pages
  };
}

function hypersyncPostWithRetry(body) {
  const payload = JSON.stringify(body);
  const token = hypersyncToken();
  const headers = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    muteHttpExceptions: true,
    deadline: DEADLINES.HYPERSYNC,
    headers: headers
  };

  var lastError = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) Utilities.sleep(1000 * Math.pow(3, attempt - 1));
    try {
      const res = UrlFetchApp.fetch(XDC_INVITES_CFG.HYPERSYNC_URL, options);
      const status = res.getResponseCode();
      const text = res.getContentText();
      if (status >= 200 && status < 300) return JSON.parse(text);
      if (status >= 500 || status === 429) {
        lastError = new Error('Hypersync HTTP ' + status + ': ' + text.slice(0, 300));
        continue;
      }
      throw new Error('Hypersync HTTP ' + status + ' (no retry): ' + text.slice(0, 500));
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error('Hypersync failed after retries: ' + (lastError && lastError.message));
}

// ----- Event parsers -----

function xdcInvitesAddressFromTopic(topic) {
  if (!topic || typeof topic !== 'string') return null;
  const hex = topic.replace(/^0x/, '');
  if (hex.length < 64) return null;
  return ('0x' + hex.slice(24)).toLowerCase();
}

function xdcInvitesUint256FromData(dataHex) {
  if (!dataHex || typeof dataHex !== 'string') return BigInt(0);
  const hex = dataHex.replace(/^0x/, '');
  if (hex.length < 64) return BigInt(0);
  return BigInt('0x' + hex.slice(0, 64));
}

function xdcInvitesGdFromRaw(raw) {
  const rawBig = (typeof raw === 'bigint') ? raw : BigInt(raw || 0);
  const divisor = BigInt(1e18);
  const whole = Number(rawBig / divisor);
  const frac = Number(rawBig % divisor) / Number(divisor);
  return whole + frac;
}

/**
 * Classify an InviteeJoined event:
 *   - inviter == campaign owner address  → 'campaign_code'
 *   - inviter == 0x000…000                → 'no_code' (user signed up without any code)
 *   - otherwise                            → 'referral'
 *
 * If campaignOwner is unresolved (null), we still classify zero-address
 * inviters as 'no_code' but treat all other non-zero inviters as 'referral'.
 * Once the campaign owner is resolved on a later run, the existing referral
 * rows for the campaign owner will need to be relabeled (one-shot dev fn).
 */
function parseInviteeJoined(log, blocksByNumber, campaignOwner) {
  const inviter = xdcInvitesAddressFromTopic(log.topic1);
  const invitee = xdcInvitesAddressFromTopic(log.topic2);
  if (!inviter || !invitee) return null;

  const ZERO = '0x0000000000000000000000000000000000000000';
  var inviteType;
  if (campaignOwner && inviter === campaignOwner.toLowerCase()) inviteType = 'campaign_code';
  else if (inviter === ZERO)                                    inviteType = 'no_code';
  else                                                          inviteType = 'referral';

  return {
    block_number:    log.block_number,
    block_timestamp: blocksByNumber[log.block_number] || null,
    tx_hash:         log.transaction_hash,
    log_index:       log.log_index,
    event:           'InviteeJoined',
    inviter:         inviter,
    invitee:         invitee,
    invite_type:     inviteType,
    inviter_paid_g:      0,
    invitee_paid_g:      0,
    campaign_returned_g: 0,
    total_paid_g:        0
  };
}

function parseInviterBounty(log, blocksByNumber) {
  const inviter = xdcInvitesAddressFromTopic(log.topic1);
  const invitee = xdcInvitesAddressFromTopic(log.topic2);
  if (!inviter || !invitee) return null;
  return {
    block_number:    log.block_number,
    block_timestamp: blocksByNumber[log.block_number] || null,
    tx_hash:         log.transaction_hash,
    log_index:       log.log_index,
    event:           'InviterBounty',
    inviter:         inviter,
    invitee:         invitee,
    invite_type:     '',
    // Filled in by the Transfer-join below.
    inviter_paid_g:      0,
    invitee_paid_g:      0,
    campaign_returned_g: 0,
    total_paid_g:        0
  };
}

/**
 * Group ERC-20 Transfer logs by tx_hash. Each entry is a list of
 * {to, amount} objects. The Transfer's `from` is always the invites
 * contract by construction of the Hypersync filter, so we don't store it.
 */
function buildBountyTransferIndex(transferLogs) {
  const index = {};
  for (var i = 0; i < transferLogs.length; i++) {
    const log = transferLogs[i];
    const to = xdcInvitesAddressFromTopic(log.topic2);
    if (!to) continue;
    const amount = xdcInvitesGdFromRaw(xdcInvitesUint256FromData(log.data));
    if (!index[log.transaction_hash]) index[log.transaction_hash] = [];
    index[log.transaction_hash].push({ to: to, amount: amount });
  }
  return index;
}

/**
 * Enrich an InviterBounty record with the Transfer-derived spend split.
 *
 * Q1 NOTE — campaign-code bounty handling:
 *   When an invitee joined via the GOODXDC campaign code, the contract
 *   pays the G$500 invitee bounty as a normal Transfer to the invitee
 *   address, BUT the G$1000 inviter share is "returned to the campaign
 *   pool" instead of being sent to a real inviter address. As of v5 we
 *   don't yet know exactly how the on-chain trace looks — the dev has
 *   been asked but hasn't replied yet. Three plausible cases:
 *
 *     (a) Two Transfers: G$500 → invitee + G$1000 → pool address.
 *         Once we know the pool address, classify the second Transfer
 *         by `to == pool` and credit campaign_returned_g.
 *     (b) One Transfer only: G$500 → invitee. No second Transfer at all.
 *     (c) The InviterBounty event itself encodes a flag we missed.
 *
 *   The current code handles cases (a) and (b) automatically by computing:
 *
 *       campaign_returned_g = total_paid_g - inviter_paid_g - invitee_paid_g
 *
 *   In case (a), the leftover Transfer (whose `to` is neither inviter nor
 *   invitee) lands in `total_paid_g` but neither in inviter_paid_g nor
 *   invitee_paid_g, so the subtraction yields the returned amount.
 *   In case (b), all three columns are zero except invitee_paid_g, and
 *   campaign_returned_g is also zero — which we'd need to revisit.
 *
 *   When the dev confirms the trace shape, the fix is a one-line tweak
 *   inside this function (or in the metric aggregator if classification
 *   needs to happen later).
 */
function enrichBountyWithTransfers(record, transferIndex) {
  const transfers = transferIndex[record.tx_hash];
  if (!transfers || !transfers.length) return;

  var inviterPaid = 0, inviteePaid = 0, totalPaid = 0;
  for (var i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    totalPaid += t.amount;
    if      (t.to === record.inviter) inviterPaid += t.amount;
    else if (t.to === record.invitee) inviteePaid += t.amount;
  }
  record.inviter_paid_g      = inviterPaid;
  record.invitee_paid_g      = inviteePaid;
  record.total_paid_g        = totalPaid;
  record.campaign_returned_g = Math.max(0, totalPaid - inviterPaid - inviteePaid);
}

/**
 * Resolve the address registered for the GOODXDC campaign code via
 * codeToUser(bytes32) on the invites contract. Cached in PropertiesService.
 * Returns null if the code isn't yet registered (RPC returns zero address).
 */
function xdcInvitesGetCampaignOwner() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty(XDC_INVITES_CFG.PROP_CAMPAIGN_OWNER);
  if (cached && /^0x[0-9a-f]{40}$/i.test(cached)) return cached.toLowerCase();

  // codeToUser(bytes32) selector
  const selector = '0xba6f5680';
  const calldata = selector + XDC_INVITES_CFG.CAMPAIGN_CODE_HASH.replace(/^0x/, '');
  try {
    const result = xdcRpcCall(XDC_INVITES_CFG.CONTRACT, calldata);
    if (!result || result === '0x' || result.length < 66) return null;
    const addr = ('0x' + result.replace(/^0x/, '').slice(-40)).toLowerCase();
    if (addr === '0x0000000000000000000000000000000000000000') return null;
    props.setProperty(XDC_INVITES_CFG.PROP_CAMPAIGN_OWNER, addr);
    Logger.log('  campaign owner resolved: GOODXDC → ' + addr);
    return addr;
  } catch (e) {
    Logger.log('  campaign owner resolution failed: ' + e.message);
    return null;
  }
}

// ----- Raw sheet I/O -----

function xdcInvitesEnsureRawSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(XDC_INVITES_CFG.SHEET_RAW);
  if (!sheet) {
    sheet = ss.insertSheet(XDC_INVITES_CFG.SHEET_RAW);
    sheet.getRange(1, 1, 1, XDC_INVITES_RAW_COLS).setValues([XDC_INVITES_RAW_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Read raw sheet → array of normalized event records. Each record has the
 * shape produced by parseInviteeJoined / parseInviterBounty plus a `date`
 * (YMD string) field for fast aggregation.
 */
function xdcInvitesReadRaw() {
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(XDC_INVITES_CFG.SHEET_RAW);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, XDC_INVITES_RAW_COLS).getValues();
  const out = [];
  for (var i = 0; i < data.length; i++) {
    const r = data[i];
    out.push({
      date:                toYMD(r[0]),
      block_number:        Number(r[1]),
      block_timestamp:     Number(r[2]),
      tx_hash:             String(r[3]),
      log_index:           Number(r[4]),
      event:               String(r[5]),
      inviter:             String(r[6]).toLowerCase(),
      invitee:             String(r[7]).toLowerCase(),
      invite_type:         String(r[8] || ''),
      inviter_paid_g:      Number(r[9])  || 0,
      invitee_paid_g:      Number(r[10]) || 0,
      campaign_returned_g: Number(r[11]) || 0,
      total_paid_g:        Number(r[12]) || 0
    });
  }
  return out;
}

/**
 * Build a Set of (tx_hash + '|' + log_index) keys present in the raw sheet.
 * Used to dedup before appending new events.
 */
function xdcInvitesReadExistingKeys() {
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(XDC_INVITES_CFG.SHEET_RAW);
  if (!sheet) return {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  const data = sheet.getRange(2, 4, lastRow - 1, 2).getValues(); // cols D, E
  const keys = {};
  for (var i = 0; i < data.length; i++) {
    keys[String(data[i][0]) + '|' + Number(data[i][1])] = true;
  }
  return keys;
}

/**
 * Append parsed events to the raw sheet, deduping by (tx_hash, log_index).
 * Returns the count actually written.
 */
function xdcInvitesAppendRaw(records) {
  if (!records.length) return 0;
  const sheet = xdcInvitesEnsureRawSheet();
  const existing = xdcInvitesReadExistingKeys();

  const rows = [];
  for (var i = 0; i < records.length; i++) {
    const r = records[i];
    const key = String(r.tx_hash) + '|' + Number(r.log_index);
    if (existing[key]) continue;
    existing[key] = true; // also dedup within this batch

    const ymd = r.block_timestamp
      ? Utilities.formatDate(new Date(r.block_timestamp * 1000), 'UTC', 'yyyy-MM-dd')
      : '';
    rows.push([
      ymd, r.block_number, r.block_timestamp, r.tx_hash, r.log_index,
      r.event, r.inviter, r.invitee, r.invite_type,
      r.inviter_paid_g || 0,
      r.invitee_paid_g || 0,
      r.campaign_returned_g || 0,
      r.total_paid_g || 0
    ]);
  }

  if (!rows.length) return 0;

  const startRow = sheet.getLastRow() + 1;
  var written = 0;
  while (written < rows.length) {
    const slice = rows.slice(written, written + XDC_INVITES_CFG.RAW_FLUSH_CHUNK);
    sheet.getRange(startRow + written, 1, slice.length, XDC_INVITES_RAW_COLS).setValues(slice);
    written += slice.length;
  }
  return rows.length;
}

/**
 * PHASE 1 of smartBackfill: incremental Hypersync sweep.
 * Resumes from the cursor stored in PropertiesService, fetches new events
 * within the time budget, joins Transfer logs to bounty events, and
 * appends to the raw sheet. Persists the new cursor for the next run.
 *
 * Returns { newEvents, lastBlock, reachedTip, error } so smartBackfill can
 * log a structured Health row.
 */
function xdcInvitesIngestStep() {
  ensureSheets();
  const props = PropertiesService.getScriptProperties();

  var cursor = Number(props.getProperty(XDC_INVITES_CFG.PROP_LAST_BLOCK)) || 0;
  if (cursor < XDC_INVITES_CFG.GENESIS_BLOCK) {
    cursor = XDC_INVITES_CFG.GENESIS_BLOCK;
    Logger.log('  invites cursor uninitialized → genesis ' + cursor);
  } else {
    Logger.log('  invites resuming from block ' + cursor);
  }

  const campaignOwner = xdcInvitesGetCampaignOwner();
  if (!campaignOwner) {
    Logger.log('  WARNING: campaign owner unresolved — campaign-code joins will be classified as referral until resolved');
  }

  // Build the topic1 filter for G$ Transfer events FROM the invites contract.
  const paddedInvitesContract = '0x' +
    XDC_INVITES_CFG.CONTRACT.replace(/^0x/, '').toLowerCase().padStart(64, '0');

  const result = hypersyncFetchLogs({
    fromBlock: cursor,
    deadlineMs: Date.now() + XDC_INVITES_CFG.TIME_BUDGET_MS,
    logSelections: [
      {
        // Selection 1: invites contract events
        address: [XDC_INVITES_CFG.CONTRACT],
        topics: [[
          XDC_INVITES_CFG.TOPIC_INVITEE_JOINED,
          XDC_INVITES_CFG.TOPIC_INVITER_BOUNTY
        ]]
      },
      {
        // Selection 2: G$ Transfer events where from = invites contract
        address: [XDC_INVITES_CFG.GD_TOKEN],
        topics: [
          [XDC_INVITES_CFG.TOPIC_TRANSFER],
          [paddedInvitesContract]
        ]
      }
    ]
  });

  Logger.log('  fetched ' + result.logs.length + ' logs across ' + result.pages +
             ' page(s); scanned through block ' + result.lastScannedBlock +
             (result.reachedTip ? ' (reached tip)' : ' (more pending)'));

  // Split logs by source
  const inviteAddr = XDC_INVITES_CFG.CONTRACT.toLowerCase();
  const tokenAddr  = XDC_INVITES_CFG.GD_TOKEN.toLowerCase();
  const transferLogs = [];
  const records = [];

  for (var i = 0; i < result.logs.length; i++) {
    const log = result.logs[i];
    const addr = (log.address || '').toLowerCase();
    const t0 = log.topic0;
    if (addr === tokenAddr && t0 === XDC_INVITES_CFG.TOPIC_TRANSFER) {
      transferLogs.push(log);
      continue;
    }
    if (addr === inviteAddr) {
      if (t0 === XDC_INVITES_CFG.TOPIC_INVITEE_JOINED) {
        const rec = parseInviteeJoined(log, result.blocksByNumber, campaignOwner);
        if (rec) records.push(rec);
      } else if (t0 === XDC_INVITES_CFG.TOPIC_INVITER_BOUNTY) {
        const rec = parseInviterBounty(log, result.blocksByNumber);
        if (rec) records.push(rec);
      }
    }
  }

  // Join Transfer logs to bounty records by tx_hash
  const transferIndex = buildBountyTransferIndex(transferLogs);
  for (var e = 0; e < records.length; e++) {
    if (records[e].event === 'InviterBounty') {
      enrichBountyWithTransfers(records[e], transferIndex);
    }
  }
  Logger.log('  matched ' + transferLogs.length + ' Transfer logs across ' +
             Object.keys(transferIndex).length + ' tx(es)');

  // Stable order
  records.sort(function(a, b) {
    if (a.block_number !== b.block_number) return a.block_number - b.block_number;
    return a.log_index - b.log_index;
  });

  const appended = xdcInvitesAppendRaw(records);
  Logger.log('  appended ' + appended + ' new row(s) to ' + XDC_INVITES_CFG.SHEET_RAW);

  // Persist new cursor
  const newCursor = result.lastScannedBlock + 1;
  props.setProperty(XDC_INVITES_CFG.PROP_LAST_BLOCK, String(newCursor));

  return {
    newEvents: appended,
    lastBlock: result.lastScannedBlock,
    reachedTip: result.reachedTip
  };
}

/**
 * Aggregate the entire raw sheet into per-day metric rows.
 *
 * Walks events grouped by date, maintaining running cumulative state for
 * the _at variants. For uniques, we keep growing sets of distinct addresses
 * (paid as inviter / paid as invitee / paid in any role).
 *
 * Returns an object keyed by metric_key:
 *   { metric_key: { 'YYYY-MM-DD': value, ... }, ... }
 *
 * The XdcInvites adapter calls this once per buildRows() invocation and
 * filters by date range.
 */
function xdcInvitesAggregate() {
  const raw = xdcInvitesReadRaw();
  if (!raw.length) return {};

  // Sort by (block_number, log_index) to guarantee deterministic order.
  raw.sort(function(a, b) {
    if (a.block_number !== b.block_number) return a.block_number - b.block_number;
    return a.log_index - b.log_index;
  });

  // Group by date for daily counts
  const byDay = {};
  var firstDay = null;
  for (var i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (!r.date) continue;
    if (!firstDay || r.date < firstDay) firstDay = r.date;
    if (!byDay[r.date]) byDay[r.date] = [];
    byDay[r.date].push(r);
  }

  if (!firstDay) return {};

  const lastDay = getYesterdayYMD();
  if (firstDay > lastDay) return {};

  // Cumulative state
  const inviterCumSet = {};   // addresses that received >0 G$ as inviter, ever
  const inviteeCumSet = {};   // addresses that received >0 G$ as invitee, ever
  const totalUserCumSet = {}; // union of the two sets

  var cum_total_signups          = 0;
  var cum_referral_signups       = 0;
  var cum_campaign_signups       = 0;
  var cum_nocode_signups         = 0;
  var cum_total_bounties_count   = 0;
  var cum_invitee_bounties_count = 0;
  var cum_inviter_bounties_count = 0;
  var cum_total_amount_paid      = 0;
  var cum_invitee_amount_paid    = 0;
  var cum_inviter_amount_paid    = 0;
  var cum_campaign_amount_returned = 0;

  // Output: { metric_key: { ymd: value } }
  const out = {};
  function emit(metric_key, ymd, value) {
    if (!out[metric_key]) out[metric_key] = {};
    out[metric_key][ymd] = value;
  }

  var day = firstDay;
  while (day <= lastDay) {
    const events = byDay[day] || [];

    // ----- Daily counters -----
    var d_total_signups = 0;
    var d_referral_signups = 0;
    var d_campaign_signups = 0;
    var d_nocode_signups = 0;

    var d_total_bounties_count = 0;
    var d_invitee_bounties_count = 0;
    var d_inviter_bounties_count = 0;

    var d_total_amount_paid = 0;
    var d_invitee_amount_paid = 0;
    var d_inviter_amount_paid = 0;
    var d_campaign_amount_returned = 0;

    // Daily uniques (distinct addresses paid in any role on this exact day)
    const dayInviterSet = {};
    const dayInviteeSet = {};
    const dayTotalSet = {};

    for (var k = 0; k < events.length; k++) {
      const e = events[k];

      if (e.event === 'InviteeJoined') {
        d_total_signups++;
        if      (e.invite_type === 'referral')      d_referral_signups++;
        else if (e.invite_type === 'campaign_code') d_campaign_signups++;
        else if (e.invite_type === 'no_code')       d_nocode_signups++;
        else                                        d_referral_signups++; // fallback for unlabeled historical rows
        continue;
      }

      if (e.event === 'InviterBounty') {
        d_total_bounties_count++;
        d_total_amount_paid       += e.total_paid_g       || 0;
        d_invitee_amount_paid     += e.invitee_paid_g     || 0;
        d_inviter_amount_paid     += e.inviter_paid_g     || 0;
        d_campaign_amount_returned += e.campaign_returned_g || 0;

        // Count an invitee as paid if they actually received G$.
        if ((e.invitee_paid_g || 0) > 0) {
          d_invitee_bounties_count++;
          dayInviteeSet[e.invitee] = true;
          dayTotalSet[e.invitee] = true;
          inviteeCumSet[e.invitee] = true;
          totalUserCumSet[e.invitee] = true;
        }
        // Count an inviter as paid if they actually received G$. This
        // automatically excludes campaign-code joins where the G$1000
        // was returned to the pool — those events have inviter_paid_g==0.
        if ((e.inviter_paid_g || 0) > 0) {
          d_inviter_bounties_count++;
          dayInviterSet[e.inviter] = true;
          dayTotalSet[e.inviter] = true;
          inviterCumSet[e.inviter] = true;
          totalUserCumSet[e.inviter] = true;
        }
      }
    }

    // ----- Update cumulative running totals -----
    cum_total_signups          += d_total_signups;
    cum_referral_signups       += d_referral_signups;
    cum_campaign_signups       += d_campaign_signups;
    cum_nocode_signups         += d_nocode_signups;
    cum_total_bounties_count   += d_total_bounties_count;
    cum_invitee_bounties_count += d_invitee_bounties_count;
    cum_inviter_bounties_count += d_inviter_bounties_count;
    cum_total_amount_paid      += d_total_amount_paid;
    cum_invitee_amount_paid    += d_invitee_amount_paid;
    cum_inviter_amount_paid    += d_inviter_amount_paid;
    cum_campaign_amount_returned += d_campaign_amount_returned;

    // ----- Emit one row per metric -----
    // Daily values (events on exactly this day)
    emit('xdc_invites_total_signups',           day, d_total_signups);
    emit('xdc_invites_referral_signups',        day, d_referral_signups);
    emit('xdc_invites_campaign_signups',        day, d_campaign_signups);
    emit('xdc_invites_nocode_signups',          day, d_nocode_signups);

    emit('xdc_invites_total_unique_users',      day, Object.keys(dayTotalSet).length);
    emit('xdc_invites_unique_invitees',         day, Object.keys(dayInviteeSet).length);
    emit('xdc_invites_unique_inviters',         day, Object.keys(dayInviterSet).length);

    emit('xdc_invites_total_bounties_count',    day, d_total_bounties_count);
    emit('xdc_invites_invitee_bounties_count',  day, d_invitee_bounties_count);
    emit('xdc_invites_inviter_bounties_count',  day, d_inviter_bounties_count);

    emit('xdc_invites_total_amount_paid',       day, d_total_amount_paid);
    emit('xdc_invites_invitee_amount_paid',     day, d_invitee_amount_paid);
    emit('xdc_invites_inviter_amount_paid',     day, d_inviter_amount_paid);
    emit('xdc_invites_campaign_amount_returned',day, d_campaign_amount_returned);

    // Cumulative (_at) values (running totals through this day)
    emit('xdc_invites_total_signups_at',           day, cum_total_signups);
    emit('xdc_invites_referral_signups_at',        day, cum_referral_signups);
    emit('xdc_invites_campaign_signups_at',        day, cum_campaign_signups);
    emit('xdc_invites_nocode_signups_at',          day, cum_nocode_signups);

    emit('xdc_invites_total_unique_users_at',      day, Object.keys(totalUserCumSet).length);
    emit('xdc_invites_unique_invitees_at',         day, Object.keys(inviteeCumSet).length);
    emit('xdc_invites_unique_inviters_at',         day, Object.keys(inviterCumSet).length);

    emit('xdc_invites_total_bounties_count_at',    day, cum_total_bounties_count);
    emit('xdc_invites_invitee_bounties_count_at',  day, cum_invitee_bounties_count);
    emit('xdc_invites_inviter_bounties_count_at',  day, cum_inviter_bounties_count);

    emit('xdc_invites_total_amount_paid_at',       day, cum_total_amount_paid);
    emit('xdc_invites_invitee_amount_paid_at',     day, cum_invitee_amount_paid);
    emit('xdc_invites_inviter_amount_paid_at',     day, cum_inviter_amount_paid);
    emit('xdc_invites_campaign_amount_returned_at',day, cum_campaign_amount_returned);

    day = addDays(day, 1);
  }

  return out;
}


/***** =========================================
 * 6) ADAPTERS
 * =========================================
 * Each adapter has a .fetch() method returning an array of {date, value, source}.
 *
 * Processing order in buildRows() — dependencies cascade downward:
 *   1. Dune              (no deps)
 *   2. Subgraph          (no deps)
 *   3. Reserve           (no deps) — produces celo_gd_price
 *   4. XdcReserve        (no deps) — produces xdc_gd_price + liquidity
 *   5. Computed          (depends on prices)
 *   6. Supply            (no deps)
 *   7. SupplyComputed    (depends on Supply + Subgraph)
 *   8. XdcReserveComputed (depends on prices + supply)
 *   9. XdcInvites        (reads pre-aggregated raw sheet from Phase 1)
 *****/

const Adapters = {

  Dune: {
    /** Filtering by date is done by the caller using cached batched results. */
    extractFromCache: function(spec, sinceYMD, untilYMD, cache) {
      const rawRows = cache[spec.queryId] || [];
      const out = [];
      for (var i = 0; i < rawRows.length; i++) {
        const dStr = String(rawRows[i][spec.dateCol] || '').slice(0, 10);
        if (dStr.length !== 10) continue;
        if (dStr < sinceYMD || dStr > untilYMD) continue;
        const raw = rawRows[i][spec.valueCol];
        const val = Number(String(raw).replace(/,/g, '')) || 0;
        out.push({ date: dStr, value: val, source: 'DUNE' });
      }
      return out;
    }
  },

  Subgraph: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec) {
      if (sinceYMD < CONFIG.XDC_GENESIS) sinceYMD = CONFIG.XDC_GENESIS;
      if (untilYMD < CONFIG.XDC_GENESIS) return [];
      const sinceDayISO = xdcYmdToDayISO(sinceYMD);
      const untilDayISO = xdcYmdToDayISO(untilYMD);
      switch (spec.type) {
        case 'daily_field':          return xdcFetchDailyField(spec, sinceDayISO, untilDayISO);
        case 'global_total':         return xdcFetchGlobalTotal(spec, untilYMD);
        case 'rolling_sum':          return xdcFetchRollingSum(spec, sinceDayISO, untilDayISO);
        case 'transaction_daily':    return xdcFetchTransactionDaily(spec, sinceDayISO, untilDayISO);
        case 'transaction_lifetime': return xdcFetchTransactionLifetime(spec, untilYMD);
        case 'transaction_rolling':  return xdcFetchTransactionRolling(spec, sinceDayISO, untilDayISO);
        case 'computed':             return []; // handled inline in buildRows for xdc_returning_claimers
        default: throw new Error('Unknown Subgraph spec type: ' + spec.type);
      }
    }
  },

  Reserve: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec, ctx) {
      switch (spec.type) {
        case 'daily_avg_price':
          // Single batched call over the window — see reserveFetchDailyAvgPriceBatch
          return reserveFetchDailyAvgPriceBatch(sinceYMD, untilYMD);
        case 'daily_volume': {
          var bundle = (ctx && ctx.reserveVolumeBundle) || {};
          var out = [], d = sinceYMD;
          while (d <= untilYMD) {
            var dayData = bundle[d];
            if (dayData) {
              var v = (spec.field === 'amountIn') ? dayData.amountIn
                    : (spec.field === 'amountOut') ? dayData.amountOut
                    : dayData.volume;
              out.push({ date: d, value: v, source: 'CELO_RESERVE_SUBGRAPH' });
            }
            d = addDays(d, 1);
          }
          return out;
        }
        default: throw new Error('Unknown Reserve spec type: ' + spec.type);
      }
    }
  },

  XdcReserve: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec) {
      // Clamp to reserve deployment date — no data exists before this
      if (sinceYMD < XDC_RESERVE_SINCE) sinceYMD = XDC_RESERVE_SINCE;
      if (untilYMD < XDC_RESERVE_SINCE) return [];

      if (spec.type === 'gd_price') {
        // Single batched call over the window
        return xdcReserveFetchGdPriceBatch(sinceYMD, untilYMD);
      }
      if (spec.type === 'reserve_liquidity') {
        // ONE on-chain RPC call per run. The XDC public RPC prunes
        // historical state, so we can only read `latest`. We reuse that
        // one value for every day in the window — the value is
        // technically "right now" labeled as each historical day, but
        // since we can't query historical balances anyway this is the
        // honest best we can do without an archive node. Daily run = 1
        // call for 1 day. Backfill = still 1 call for N days, all with
        // the same value.
        const liquidityToday = fetchXdcReserveLiquidity(untilYMD);
        if (!liquidityToday.length) return [];
        const value = liquidityToday[0].value;
        const out = [];
        var d = sinceYMD;
        while (d <= untilYMD) {
          out.push({ date: d, value: value, source: 'XDC_ONCHAIN_RPC' });
          d = addDays(d, 1);
        }
        return out;
      }
      throw new Error('Unknown XdcReserve spec type: ' + spec.type);
    }
  },

  /**
   * Computed adapter: multiply a source metric by the appropriate price.
   * priceSource ∈ {'celo', 'xdc'} chooses celo_gd_price vs xdc_gd_price.
   *
   * Looks up source values and prices from BOTH the current batch (rows
   * computed earlier in this run) AND factsValueIndex (already-persisted).
   */
  Computed: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec, ctx) {
      if (spec.type !== 'multiply_by_price') {
        throw new Error('Unknown Computed spec type: ' + spec.type);
      }
      const priceMetric = (spec.priceSource === 'xdc') ? 'xdc_gd_price' : 'celo_gd_price';
      const priceChain  = (spec.priceSource === 'xdc') ? 'XDC' : 'CELO';

      const out = [];
      var d = sinceYMD;
      while (d <= untilYMD) {
        // Skip dates before XDC genesis for XDC-priced metrics
        if (spec.priceSource === 'xdc' && d < CONFIG.XDC_GENESIS) {
          d = addDays(d, 1);
          continue;
        }

        const sourceVal = lookupValue(ctx, d, chain, spec.sourceMetric);
        const priceVal  = lookupValue(ctx, d, priceChain, priceMetric);

        if (sourceVal != null && priceVal != null && priceVal > 0) {
          out.push({
            date: d,
            value: sourceVal * priceVal,
            source: 'COMPUTED+' + (spec.priceSource === 'xdc' ? 'XDC_RESERVE' : 'CELO_RESERVE')
          });
        }
        d = addDays(d, 1);
      }
      return out;
    }
  },

  Supply: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec) {
      // ETH supply is hard-coded (frozen after the hack). Emit one row per
      // day in the full window so auditAndFillGaps() can backfill history.
      if (spec.type === 'eth_total' || spec.type === 'eth_frozen') {
        var val = (spec.type === 'eth_total') ? ETH_GD_TOTAL_SUPPLY_CONST : ETH_GD_FROZEN_SUPPLY_CONST;
        var out = [];
        var d = sinceYMD;
        while (d <= untilYMD) {
          out.push({ date: d, value: val, source: 'HARDCODED' });
          d = addDays(d, 1);
        }
        return out;
      }
      // Live APIs (FUSE, CELO) only return current state — emit untilYMD only.
      var rowTemplate;
      switch (spec.type) {
        case 'fuse_supply': rowTemplate = fetchFuseSupply(untilYMD)[0];  break;
        case 'celo_supply': rowTemplate = fetchCeloSupply(untilYMD)[0];  break;
        default: throw new Error('Unknown Supply spec type: ' + spec.type);
      }
      if (!rowTemplate) return [];
      return [{ date: untilYMD, value: rowTemplate.value, source: rowTemplate.source }];
    }
  },

  SupplyComputed: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec, ctx) {
      const out = [];
      var d = sinceYMD;
      while (d <= untilYMD) {
        if (spec.type === 'eth_circulating') {
          const total  = lookupValue(ctx, d, 'ETH', 'eth_gd_total_supply');
          const frozen = lookupValue(ctx, d, 'ETH', 'eth_gd_frozen_supply');
          if (total == null || frozen == null) { d = addDays(d, 1); continue; }
          if (total <= 0 || frozen < 0) {
            Logger.log('SupplyComputed: SKIPPING eth_circulating for ' + d
              + ' — implausible values total=' + total + ' frozen=' + frozen);
            d = addDays(d, 1); continue;
          }
          out.push({ date: d, value: total - frozen, source: 'COMPUTED' });
        } else if (spec.type === 'total_circulating') {
          // Skip XDC contribution before genesis
          const ethC  = lookupValue(ctx, d, 'ETH',  'eth_gd_in_circulation');
          const fuseC = lookupValue(ctx, d, 'FUSE', 'fuse_gd_in_circulation');
          const celoC = lookupValue(ctx, d, 'CELO', 'celo_gd_in_circulation');
          const xdcC  = (d >= CONFIG.XDC_GENESIS)
            ? lookupValue(ctx, d, 'XDC', 'xdc_gd_in_circulation')
            : 0;
          if (ethC != null && fuseC != null && celoC != null && xdcC != null) {
            if (ethC <= 0 || fuseC <= 0 || celoC <= 0) {
              Logger.log('SupplyComputed: SKIPPING total_circulating for ' + d
                + ' — zero/negative chain component: eth=' + ethC + ' fuse=' + fuseC + ' celo=' + celoC);
              d = addDays(d, 1); continue;
            }
            if (d >= CONFIG.XDC_GENESIS && (xdcC == null || xdcC < 0)) {
              Logger.log('SupplyComputed: SKIPPING total_circulating for ' + d
                + ' — bad xdc component: xdcC=' + xdcC);
              d = addDays(d, 1); continue;
            }
            out.push({ date: d, value: ethC + fuseC + celoC + xdcC, source: 'COMPUTED' });
          }
        } else {
          throw new Error('Unknown SupplyComputed spec type: ' + spec.type);
        }
        d = addDays(d, 1);
      }
      return out;
    }
  },

  XdcReserveComputed: {
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec, ctx) {
      const out = [];
      if (untilYMD < XDC_RESERVE_SINCE) return out;
      var d = (sinceYMD < XDC_RESERVE_SINCE) ? XDC_RESERVE_SINCE : sinceYMD;
      while (d <= untilYMD) {

        if (spec.type === 'price_spread') {
          const xdcP = lookupValue(ctx, d, 'XDC',  'xdc_gd_price');
          const celoP = lookupValue(ctx, d, 'CELO', 'celo_gd_price');
          if (xdcP != null && celoP != null) {
            out.push({ date: d, value: xdcP - celoP, source: 'COMPUTED' });
          }

        } else if (spec.type === 'backing_ratio') {
          const liq = lookupValue(ctx, d, 'XDC', 'xdc_reserve_liquidity_usd');
          const sup = lookupValue(ctx, d, 'XDC', 'xdc_gd_in_circulation');
          if (liq != null && sup != null && sup > 0) {
            out.push({ date: d, value: liq / sup, source: 'COMPUTED' });
          }

        } else if (spec.type === 'daily_minted') {
          // today's cumulative UBI - yesterday's cumulative UBI
          const today = lookupValue(ctx, d,                  'XDC', 'xdc_lifetime_claimed_gd_amount');
          const yest  = lookupValue(ctx, addDays(d, -1),     'XDC', 'xdc_lifetime_claimed_gd_amount');
          if (today != null && yest != null) {
            out.push({ date: d, value: Math.max(0, today - yest), source: 'COMPUTED' });
          }

        } else if (spec.type === 'reserve_growth_abs') {
          const today = lookupValue(ctx, d,              'XDC', 'xdc_reserve_liquidity_usd');
          const yest  = lookupValue(ctx, addDays(d, -1), 'XDC', 'xdc_reserve_liquidity_usd');
          if (today != null && yest != null) {
            out.push({ date: d, value: today - yest, source: 'COMPUTED' });
          }

        } else {
          throw new Error('Unknown XdcReserveComputed spec type: ' + spec.type);
        }
        d = addDays(d, 1);
      }
      return out;
    }
  },

  XdcInvites: {
    /**
     * Reads pre-aggregated invite metrics from ctx.invitesAggregates,
     * which is built once per buildRows() call by xdcInvitesAggregate().
     */
    fetch: function(metricKey, chain, sinceYMD, untilYMD, spec, ctx) {
      const agg = ctx.invitesAggregates || {};
      const dateMap = agg[spec.metricKey];
      if (!dateMap) return [];
      const out = [];
      const dates = Object.keys(dateMap).sort();
      for (var i = 0; i < dates.length; i++) {
        const d = dates[i];
        if (d < sinceYMD || d > untilYMD) continue;
        if (d < CONFIG.XDC_GENESIS) continue;
        out.push({ date: d, value: dateMap[d], source: 'XDC_HYPERSYNC' });
      }
      return out;
    }
  }
};

/**
 * Lookup a metric value for a (date, chain, metric) coordinate. Checks
 * the in-batch row list first (most recent computation wins), then falls
 * back to the persisted facts index.
 *
 * `ctx` is the context object passed through buildRows: { batchByKey,
 * factsValueIndex, invitesAggregates }.
 */
function lookupValue(ctx, date, chain, metric) {
  const key = date + '|' + chain + '|' + metric;
  if (ctx.batchByKey && ctx.batchByKey[key] != null) return ctx.batchByKey[key];
  if (ctx.factsValueIndex && ctx.factsValueIndex[key] != null) return ctx.factsValueIndex[key];
  return null;
}


/***** =========================================
 * 7) buildRows — CORE ORCHESTRATOR
 * =========================================*/

function buildRows(sinceYMD, untilYMD, indexResult, deadlineMs) {
  const existingIndex   = indexResult.existingIndex   || {};
  const factsValueIndex = indexResult.factsValueIndex || {};

  if (!sinceYMD || !untilYMD) {
    const ymd = getYesterdayYMD();
    sinceYMD = sinceYMD || ymd;
    untilYMD = untilYMD || ymd;
  }

  const startedAt = nowIso();
  const runIdStr  = generateRunId();
  const rows = [];
  const health = [];

  // batchByKey: rolling map of (date|chain|metric → value) for everything
  // produced so far in this run. Read by lookupValue() so later adapters
  // can depend on values computed by earlier ones.
  const batchByKey = {};

  function pushRow(date, chain, metricKey, value, source) {
    const key = date + '|' + chain + '|' + metricKey;
    if (existingIndex[key]) return false;       // already persisted
    if (batchByKey[key] != null) return false;  // already in this batch
    rows.push({
      date: date,
      chain: chain,
      metric_key: metricKey,
      value: value,
      source: source,
      run_id: runIdStr,
      updated_at: startedAt
    });
    batchByKey[key] = value;
    return true;
  }

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

  Logger.log('buildRows window ' + sinceYMD + ' .. ' + untilYMD + ' (run ' + runIdStr + ')');

  // Pre-compute the invites aggregates ONCE for this run.
  var invitesAggregates = {};
  try {
    invitesAggregates = xdcInvitesAggregate();
  } catch (e) {
    Logger.log('xdcInvitesAggregate failed: ' + e.message);
    addHealth('XDC_INVITES_AGG', '*', 'XDC', 'error', 0, 0, e.message);
  }

  const ctx = {
    batchByKey: batchByKey,
    factsValueIndex: factsValueIndex,
    invitesAggregates: invitesAggregates,
    reserveVolumeBundle: null,
    deadlineMs: deadlineMs,
    skippedMetrics: [],
    failedMetrics: [],
  };

  // ----- Classify metrics by adapter -----
  var dune = [], subgraph = [], reserve = [], xdcReserve = [],
      computed = [], supply = [], supplyComputed = [],
      xdcReserveComputed = [], xdcInvites = [];

  const metricKeys = Object.keys(METRICS);
  for (var m = 0; m < metricKeys.length; m++) {
    const metricKey = metricKeys[m];
    const spec = METRICS[metricKey];
    const chains = (spec.chains || []).filter(function(c) { return CHAINS[c] || c === 'AGG'; });
    if (!chains.length) continue;

    for (var c = 0; c < chains.length; c++) {
      const item = { metricKey: metricKey, spec: spec, chain: chains[c] };
      switch (spec.adapter) {
        case 'Dune':                if (spec.dune)                dune.push(item);                break;
        case 'Subgraph':            if (spec.xdc)                 subgraph.push(item);            break;
        case 'Reserve':             if (spec.reserve)             reserve.push(item);             break;
        case 'XdcReserve':          if (spec.xdcReserve)          xdcReserve.push(item);          break;
        case 'Computed':            if (spec.computed)            computed.push(item);            break;
        case 'Supply':              if (spec.supply)              supply.push(item);              break;
        case 'SupplyComputed':      if (spec.supplyComputed)      supplyComputed.push(item);      break;
        case 'XdcReserveComputed':  if (spec.xdcReserveComputed)  xdcReserveComputed.push(item);  break;
        case 'XdcInvites':          if (spec.xdcInvites)          xdcInvites.push(item);          break;
      }
    }
  }

  // ===== 1. DUNE — batched =====
  // Each Dune query is fetched once and shared across all metrics that use it.
  if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
    Logger.log('BUDGET EXHAUSTED before dune — skipping ' + dune.length + ' metric(s)');
    for (var _bi = 0; _bi < dune.length; _bi++) ctx.skippedMetrics.push(dune[_bi].metricKey);
    dune = [];
  }
  const duneQueryIds = {};
  for (var i = 0; i < dune.length; i++) duneQueryIds[dune[i].spec.dune.queryId] = true;
  const duneCache = {};
  Object.keys(duneQueryIds).forEach(function(qid) {
    if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
      Logger.log('BUDGET EXHAUSTED before Dune query ' + qid + ' — skipping');
      duneCache[qid] = [];
      return;
    }
    try {
      duneCache[qid] = duneFetchTable(qid, 10000).rows;
    } catch (e) {
      Logger.log('Dune query ' + qid + ' fetch failed: ' + e.message);
      duneCache[qid] = [];
    }
  });

  for (var i = 0; i < dune.length; i++) {
    runAdapter(dune[i], 'DUNE', function(item) {
      const results = Adapters.Dune.extractFromCache(item.spec.dune, sinceYMD, untilYMD, duneCache);
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        if (pushRow(results[j].date, item.chain, item.metricKey, results[j].value, results[j].source)) count++;
      }
      return count;
    }, addHealth);
  }

  // ===== 2. SUBGRAPH (XDC) =====
  // Track xdc_dau / xdc_new_claimers for the inline computed xdc_returning_claimers.
  if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
    Logger.log('BUDGET EXHAUSTED before subgraph — skipping ' + subgraph.length + ' metric(s)');
    for (var _bi = 0; _bi < subgraph.length; _bi++) ctx.skippedMetrics.push(subgraph[_bi].metricKey);
    subgraph = [];
  }
  const xdcDauData = {};
  const xdcNewData = {};

  for (var i = 0; i < subgraph.length; i++) {
    const item = subgraph[i];
    if (item.spec.xdc.type === 'computed') continue; // handled below

    runAdapter(item, 'XDC_SUBGRAPH', function(item) {
      const results = Adapters.Subgraph.fetch(item.metricKey, item.chain, sinceYMD, untilYMD, item.spec.xdc);
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        if (pushRow(results[j].date, item.chain, item.metricKey, results[j].value, results[j].source)) {
          count++;
        }
        if (item.metricKey === 'xdc_dau')          xdcDauData[results[j].date] = results[j].value;
        if (item.metricKey === 'xdc_new_claimers') xdcNewData[results[j].date] = results[j].value;
      }
      return count;
    }, addHealth);
  }

  // Inline xdc_returning_claimers = xdc_dau - xdc_new_claimers
  if (METRICS.xdc_returning_claimers) {
    const t0 = Date.now();
    var rcount = 0;
    try {
      const dates = Object.keys(xdcDauData);
      for (var i = 0; i < dates.length; i++) {
        const date = dates[i];
        const dau = xdcDauData[date] || 0;
        const nu  = xdcNewData[date] || 0;
        if (pushRow(date, 'XDC', 'xdc_returning_claimers', Math.max(0, dau - nu), 'XDC_SUBGRAPH')) rcount++;
      }
      addHealth('XDC_SUBGRAPH', 'xdc_returning_claimers', 'XDC', 'ok', rcount, Date.now() - t0);
    } catch (e) {
      addHealth('XDC_SUBGRAPH', 'xdc_returning_claimers', 'XDC', 'error', 0, Date.now() - t0, e.message);
    }
  }

  // ===== 3. CELO RESERVE (celo_gd_price + volumes) =====
  if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
    Logger.log('BUDGET EXHAUSTED before reserve — skipping ' + reserve.length + ' metric(s)');
    for (var _bi = 0; _bi < reserve.length; _bi++) ctx.skippedMetrics.push(reserve[_bi].metricKey);
    reserve = [];
  }
  if (!ctx.reserveVolumeBundle) {
    try {
      ctx.reserveVolumeBundle = reserveFetchDailyVolumeBundle(ymdToDayISO(sinceYMD), ymdToDayISO(untilYMD));
      Logger.log('Reserve volume bundle: ' + Object.keys(ctx.reserveVolumeBundle).length + ' day(s)');
    } catch (e) {
      Logger.log('Reserve volume bundle failed: ' + e.message);
      ctx.reserveVolumeBundle = {};
    }
  }
  for (var i = 0; i < reserve.length; i++) {
    runAdapter(reserve[i], 'CELO_RESERVE', function(item) {
      const results = Adapters.Reserve.fetch(item.metricKey, item.chain, sinceYMD, untilYMD, item.spec.reserve, ctx);
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        if (pushRow(results[j].date, item.chain, item.metricKey, results[j].value, results[j].source)) count++;
      }
      return count;
    }, addHealth);
  }

  // ===== 4. XDC RESERVE (xdc_gd_price + liquidity) =====
  if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
    Logger.log('BUDGET EXHAUSTED before xdcReserve — skipping ' + xdcReserve.length + ' metric(s)');
    for (var _bi = 0; _bi < xdcReserve.length; _bi++) ctx.skippedMetrics.push(xdcReserve[_bi].metricKey);
    xdcReserve = [];
  }
  for (var i = 0; i < xdcReserve.length; i++) {
    runAdapter(xdcReserve[i], 'XDC_RESERVE', function(item) {
      const results = Adapters.XdcReserve.fetch(item.metricKey, item.chain, sinceYMD, untilYMD, item.spec.xdcReserve);
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        if (pushRow(results[j].date, item.chain, item.metricKey, results[j].value, results[j].source)) count++;
      }
      return count;
    }, addHealth);
  }

  // ===== 5. COMPUTED (multiply by price) =====
  // Runs after Reserve + XdcReserve so prices are available in batchByKey.
  if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
    Logger.log('BUDGET EXHAUSTED before computed — skipping ' + computed.length + ' metric(s)');
    for (var _bi = 0; _bi < computed.length; _bi++) ctx.skippedMetrics.push(computed[_bi].metricKey);
    computed = [];
  }
  for (var i = 0; i < computed.length; i++) {
    runAdapter(computed[i], 'COMPUTED', function(item) {
      const results = Adapters.Computed.fetch(item.metricKey, item.chain, sinceYMD, untilYMD, item.spec.computed, ctx);
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        if (pushRow(results[j].date, item.chain, item.metricKey, results[j].value, results[j].source)) count++;
      }
      return count;
    }, addHealth);
  }

  // ===== 6. SUPPLY =====
  if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
    Logger.log('BUDGET EXHAUSTED before supply — skipping ' + supply.length + ' metric(s)');
    for (var _bi = 0; _bi < supply.length; _bi++) ctx.skippedMetrics.push(supply[_bi].metricKey);
    supply = [];
  }
  for (var i = 0; i < supply.length; i++) {
    runAdapter(supply[i], 'SUPPLY', function(item) {
      const results = Adapters.Supply.fetch(item.metricKey, item.chain, sinceYMD, untilYMD, item.spec.supply);
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        if (pushRow(results[j].date, item.chain, item.metricKey, results[j].value, results[j].source)) count++;
      }
      return count;
    }, addHealth);
  }

  // ===== 7. SUPPLY COMPUTED =====
  if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
    Logger.log('BUDGET EXHAUSTED before supplyComputed — skipping ' + supplyComputed.length + ' metric(s)');
    for (var _bi = 0; _bi < supplyComputed.length; _bi++) ctx.skippedMetrics.push(supplyComputed[_bi].metricKey);
    supplyComputed = [];
  }
  for (var i = 0; i < supplyComputed.length; i++) {
    runAdapter(supplyComputed[i], 'SUPPLY_COMPUTED', function(item) {
      const results = Adapters.SupplyComputed.fetch(item.metricKey, item.chain, sinceYMD, untilYMD, item.spec.supplyComputed, ctx);
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        if (pushRow(results[j].date, item.chain, item.metricKey, results[j].value, results[j].source)) count++;
      }
      return count;
    }, addHealth);
  }

  // ===== 8. XDC RESERVE COMPUTED =====
  if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
    Logger.log('BUDGET EXHAUSTED before xdcReserveComputed — skipping ' + xdcReserveComputed.length + ' metric(s)');
    for (var _bi = 0; _bi < xdcReserveComputed.length; _bi++) ctx.skippedMetrics.push(xdcReserveComputed[_bi].metricKey);
    xdcReserveComputed = [];
  }
  for (var i = 0; i < xdcReserveComputed.length; i++) {
    runAdapter(xdcReserveComputed[i], 'XDC_RESERVE_COMPUTED', function(item) {
      const results = Adapters.XdcReserveComputed.fetch(item.metricKey, item.chain, sinceYMD, untilYMD, item.spec.xdcReserveComputed, ctx);
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        if (pushRow(results[j].date, item.chain, item.metricKey, results[j].value, results[j].source)) count++;
      }
      return count;
    }, addHealth);
  }

  // ===== 9. XDC INVITES =====
  if (ctx.deadlineMs && Date.now() > ctx.deadlineMs - CONFIG.WRITE_RESERVE_MS) {
    Logger.log('BUDGET EXHAUSTED before xdcInvites — skipping ' + xdcInvites.length + ' metric(s)');
    for (var _bi = 0; _bi < xdcInvites.length; _bi++) ctx.skippedMetrics.push(xdcInvites[_bi].metricKey);
    xdcInvites = [];
  }
  for (var i = 0; i < xdcInvites.length; i++) {
    runAdapter(xdcInvites[i], 'XDC_INVITES', function(item) {
      const results = Adapters.XdcInvites.fetch(item.metricKey, item.chain, sinceYMD, untilYMD, item.spec.xdcInvites, ctx);
      var count = 0;
      for (var j = 0; j < results.length; j++) {
        if (pushRow(results[j].date, item.chain, item.metricKey, results[j].value, results[j].source)) count++;
      }
      return count;
    }, addHealth);
  }

  if (ctx.skippedMetrics && ctx.skippedMetrics.length > 0) {
    addHealth('BUDGET', ctx.skippedMetrics.join(','), 'ALL', 'skipped',
              0, Date.now() - Date.parse(startedAt), 'budget exhausted');
  }
  return { rows: rows, health: health, runId: runIdStr, skippedMetrics: ctx.skippedMetrics || [] };
}

/**
 * Wraps an adapter call with timing, error handling, and a guaranteed
 * Health row. This is the fix for "the cron silently fails" — every
 * adapter call now produces exactly one Health row, even on exception.
 */
function runAdapter(item, subsystem, fn, addHealth) {
  const t0 = Date.now();
  try {
    const count = fn(item);
    addHealth(subsystem, item.metricKey, item.chain, 'ok', count || 0, Date.now() - t0);
    if (CONFIG.VERBOSE) {
      Logger.log('  ok  [' + subsystem + '] ' + item.metricKey + '/' + item.chain + ': ' + (count || 0) + ' row(s)');
    }
  } catch (e) {
    addHealth(subsystem, item.metricKey, item.chain, 'error', 0, Date.now() - t0, e.message);
    Logger.log('  ERR [' + subsystem + '] ' + item.metricKey + '/' + item.chain + ': ' + e.message);
  }
}

function isSupplyMetric_(metricKey) {
  return metricKey.indexOf('_gd_in_circulation') !== -1
      || metricKey.indexOf('_lifetime_claimed_gd') !== -1;
}


/***** =========================================
 * 8) writeFactsAndHealth — APPEND-ONLY PERSISTENCE
 * =========================================
 *
 * Appends new rows to "Daily Facts" — never overwrites. Re-checks the
 * existing index right before each append (defensive against races).
 * Also generates AGG rows by summing chain values for metrics declared
 * with aggregate=true.
 *
 * AGG rows pull component values from BOTH the current batch AND the
 * factsValueIndex, so backfilling old AGG rows after fixing a chain
 * metric works correctly.
 *****/

function writeFactsAndHealth(buildResult, indexResult) {
  const factsValueIndex = (indexResult && indexResult.factsValueIndex) || {};
  const existingIndex   = (indexResult && indexResult.existingIndex)   || {};

  function numberFormatFor(dp) {
    return '#,##0' + (dp > 0 ? '.' + '0'.repeat(dp) : '');
  }
  function roundDp(n, dp) {
    const x = Number(n);
    if (!isFinite(x)) throw new Error('roundDp received non-finite value: ' + n);
    return Number(x.toFixed(dp));
  }

  ensureSheets();
  const ss = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
  const facts = ss.getSheetByName(CONFIG.SHEET_FACTS);
  const health = ss.getSheetByName(CONFIG.SHEET_HEALTH);

  // Round values to declared precision
  const inputRows = buildResult.rows || [];
  const rows = [];
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

  // ----- Generate AGG rows -----
  // For each aggregate=true metric, group by date+baseMetric. Sum component
  // values from both batch and facts (so partial backfills produce correct AGG).
  const aggSums = {};
  const aggDatesAndBases = {}; // "date|baseMetric" → true (for the second pass)

  // First pass: collect dates and base metric names from the current batch
  for (var i = 0; i < rows.length; i++) {
    const r = rows[i];
    const spec = METRICS[r.metric_key];
    if (!spec || spec.aggregate !== true) continue;
    if (r.chain === 'AGG') continue;
    var base = r.metric_key;
    if (base.indexOf('celo_') === 0) base = base.slice(5);
    else if (base.indexOf('xdc_') === 0) base = base.slice(4);
    aggDatesAndBases[r.date + '|' + base] = { dp: (typeof spec.decimals === 'number') ? spec.decimals : 2 };
  }

  // Second pass: for each (date, base), sum the component values from both
  // the current batch and factsValueIndex.
  const baseToComponents = {}; // base → [{chain, fullMetric}, ...]
  Object.keys(METRICS).forEach(function(mk) {
    const spec = METRICS[mk];
    if (!spec || spec.aggregate !== true) return;
    var base = mk;
    if (base.indexOf('celo_') === 0) base = base.slice(5);
    else if (base.indexOf('xdc_') === 0) base = base.slice(4);
    if (!baseToComponents[base]) baseToComponents[base] = [];
    spec.chains.forEach(function(ch) {
      baseToComponents[base].push({ chain: ch, metric: mk });
    });
  });

  // Build batch lookup
  const batchByKey = {};
  for (var i = 0; i < rows.length; i++) {
    batchByKey[rows[i].date + '|' + rows[i].chain + '|' + rows[i].metric_key] = rows[i].value;
  }

  Object.keys(aggDatesAndBases).forEach(function(k) {
    const parts = k.split('|');
    const date = parts[0];
    const base = parts[1];
    const dp = aggDatesAndBases[k].dp;
    const components = baseToComponents[base] || [];

    var sum = 0;
    var ok = true;
    var sources = [];
    for (var c = 0; c < components.length; c++) {
      const lk = date + '|' + components[c].chain + '|' + components[c].metric;
      var v = batchByKey[lk];
      if (v == null) v = factsValueIndex[lk];
      if (v == null) { ok = false; break; }
      if (v <= 0 && isSupplyMetric_(components[c].metric)) { ok = false; break; }
      sum += v;
    }
    if (!ok) return; // missing component → skip AGG for this date

    rows.push({
      date: date,
      chain: 'AGG',
      metric_key: 'agg_' + base,
      value: roundDp(sum, dp),
      decimals: dp,
      source: 'COMPUTED',
      run_id: buildResult.runId || '',
      updated_at: nowIso()
    });
  });

  // ----- APPEND-ONLY WRITE -----
  // Re-check existing index before each row (defensive — the index was
  // built at the start of the run, but if the same metric appears twice
  // in the rows array we still want to dedup).
  const seenInWrite = {};
  const toAppend = [];
  for (var i = 0; i < rows.length; i++) {
    const r = rows[i];
    const key = r.date + '|' + r.chain + '|' + r.metric_key;
    if (existingIndex[key]) continue;
    if (seenInWrite[key])   continue;
    seenInWrite[key] = true;
    toAppend.push(r);
  }

  if (toAppend.length) {
    toAppend.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var appendStartRow = facts.getLastRow() + 1;
    var values = toAppend.map(function(r) {
      return [r.date, r.chain, r.metric_key, r.value, r.source, r.updated_at];
    });
    facts.getRange(appendStartRow, 1, values.length, values[0].length).setValues(values);

    // Batch setNumberFormat by decimal precision group (3-5 API calls instead of 94)
    var byDecimals = {};
    for (var i = 0; i < toAppend.length; i++) {
      var dp = toAppend[i].decimals;
      if (!byDecimals[dp]) byDecimals[dp] = [];
      byDecimals[dp].push(appendStartRow + i);
    }
    Object.keys(byDecimals).forEach(function(dp) {
      var fmt    = numberFormatFor(Number(dp));
      var a1list = byDecimals[dp].map(function(rowNum) { return 'D' + rowNum; });
      facts.getRangeList(a1list).setNumberFormat(fmt);
    });
  }

  // ----- Write Health rows -----
  const healthData = buildResult.health || [];
  if (healthData.length) {
    var hv = healthData.map(function(h) {
      return [h.run_id, h.started_at, h.subsystem, h.metric_key, h.chain,
              h.status, h.records, h.duration_ms, h.error];
    });
    health.getRange(health.getLastRow() + 1, 1, hv.length, hv[0].length).setValues(hv);
  }

  Logger.log('Wrote ' + toAppend.length + ' new fact row(s); skipped ' + (rows.length - toAppend.length) + ' duplicate(s)');
  return { written: toAppend.length, skipped: rows.length - toAppend.length };
}


/***** =========================================
 * 9) ORCHESTRATORS
 * =========================================*/

/**
 * MAIN ENTRYPOINT — wire this to a daily time-driven trigger.
 *
 * Self-healing: scans every metric, finds the latest persisted date,
 * and fills the gap from there to yesterday. Safe to run any number of
 * times — append-only, idempotent.
 */
function smartBackfill() {
  Logger.log('===== smartBackfill starting (v5) =====');
  var runStartMs = Date.now();
  var deadlineMs = runStartMs + CONFIG.PHASE_BUDGET_MS;

  try {
    ensureSheets();

    // Phase 1: XDC invites Hypersync sweep
    Logger.log('--- Phase 1: XDC invites ingestion ---');
    try {
      var ingestResult = xdcInvitesIngestStep();
      Logger.log('  ingest: +' + ingestResult.newEvents + ' events, lastBlock='
                 + ingestResult.lastBlock + (ingestResult.reachedTip ? ' (tip)' : ' (more pending)'));
    } catch (e) {
      Logger.log('  ingest FAILED: ' + e.message + ' — continuing');
      var ss_     = SpreadsheetApp.openById(CONFIG.DEST_SPREADSHEET_ID);
      var health_ = ss_.getSheetByName(CONFIG.SHEET_HEALTH);
      health_.getRange(health_.getLastRow() + 1, 1, 1, 9).setValues([[
        generateRunId(), nowIso(), 'XDC_INVITES_INGEST', '*', 'XDC',
        'error', 0, Date.now() - runStartMs, e.message
      ]]);
    }

    // Phase 2: Index existing facts
    Logger.log('--- Phase 2: Index existing facts ---');
    var indexResult = getExistingFactsIndex();
    Logger.log('  indexed ' + Object.keys(indexResult.existingIndex).length + ' keys from tail');

    if (Date.now() > deadlineMs - CONFIG.WRITE_RESERVE_MS) {
      var timeoutMsg = 'Phase 2 consumed budget — aborting. Consider reducing LOOKBACK_ROWS.';
      Logger.log(timeoutMsg);
      notifySlack('🚨 GoodDollar Dashboard TIMEOUT on ' + getYesterdayYMD() + ': ' + timeoutMsg);
      throw new Error(timeoutMsg);
    }

    // Phase 3: Determine window and build rows
    Logger.log('--- Phase 3: Build rows ---');
    var yesterday = getYesterdayYMD();
    var earliestNeeded = yesterday;
    var metricKeys_ = Object.keys(METRICS);
    for (var m = 0; m < metricKeys_.length; m++) {
      var metricKey_ = metricKeys_[m];
      var spec_      = METRICS[metricKey_];
      var chains_    = (spec_.chains || []).filter(function(c) { return CHAINS[c] || c === 'AGG'; });
      for (var c = 0; c < chains_.length; c++) {
        var chain_    = chains_[c];
        var cmKey_    = chain_ + '|' + metricKey_;
        var lastDate_ = indexResult.maxDates[cmKey_];
        var startFrom_;
        if (lastDate_) {
          startFrom_ = addDays(lastDate_, 1);
        } else {
          startFrom_ = addDays(yesterday, -CONFIG.LOOKBACK_DAYS);
        }
        var backfillCap_ = addDays(yesterday, -CONFIG.LOOKBACK_DAYS);
        if (startFrom_ < backfillCap_) startFrom_ = backfillCap_;
        if (chain_ === 'XDC' && startFrom_ < CONFIG.XDC_GENESIS) startFrom_ = CONFIG.XDC_GENESIS;
        if (startFrom_ <= yesterday && startFrom_ < earliestNeeded) earliestNeeded = startFrom_;
      }
    }

    if (earliestNeeded > yesterday) {
      Logger.log('All metrics up to date — nothing to fetch');
    } else {
      Logger.log('  window: ' + earliestNeeded + ' .. ' + yesterday);
      var result      = buildRows(earliestNeeded, yesterday, indexResult, deadlineMs);
      var writeResult = writeFactsAndHealth(result, indexResult);
      var skippedCount = (result.skippedMetrics || []).length;
      if (skippedCount > 0) {
        notifySlack('⚠️ GoodDollar Dashboard: partial run for ' + yesterday
          + '. ' + skippedCount + ' metric(s) skipped due to time budget.\n'
          + 'Skipped: ' + result.skippedMetrics.join(', '));
      }
      Logger.log('Wrote ' + writeResult.written + ' row(s), skipped ' + writeResult.skipped + ' duplicate(s)');
    }

    Logger.log('===== smartBackfill complete in ' + (Date.now() - runStartMs) + 'ms =====');

  } catch (e) {
    var elapsed = Math.round((Date.now() - runStartMs) / 1000);
    Logger.log('smartBackfill FAILED after ' + elapsed + 's: ' + e.message);
    notifySlack('🚨 GoodDollar Dashboard FAILED on ' + getYesterdayYMD()
      + ' after ' + elapsed + 's.\nError: ' + e.message);
    throw e;
  }
}

/**
 * Manual backfill for a specific date range. Same code path as smartBackfill
 * but with explicit since/until bounds. Use for filling specific gaps after
 * deleting bad rows from the facts sheet.
 *
 * Does NOT run the Hypersync ingestion step — that's controlled by its own
 * cursor and shouldn't be re-run on a per-range basis. If you need to
 * refetch invite events for a specific block range, use the dev script.
 */
function backfillRange(sinceYMD, untilYMD) {
  Logger.log('===== backfillRange ' + sinceYMD + ' .. ' + untilYMD + ' =====');
  ensureSheets();
  const indexResult = getExistingFactsIndex();
  const result = buildRows(sinceYMD, untilYMD, indexResult);
  writeFactsAndHealth(result, indexResult);
  Logger.log('===== backfillRange complete =====');
}