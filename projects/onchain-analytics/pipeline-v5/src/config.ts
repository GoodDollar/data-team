/**
 * config.ts -- Centralized configuration. Fails fast on missing required env vars.
 */

import { config as loadDotenv } from "dotenv";
import type { NetworkConfig, SchemaField } from "./types.js";

loadDotenv();

// -- Env helpers --

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    console.error(`[FATAL] Required environment variable ${key} is missing or empty.`);
    process.exit(2);
  }
  return v;
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() !== "" ? v : fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) {
    console.error(`[FATAL] Env ${key} is not a valid integer: "${v}"`);
    process.exit(2);
  }
  return n;
}

// -- Core config --

export const CONFIG = {
  GCP_PROJECT_ID: env("GCP_PROJECT_ID", "gooddollar"),
  DATASET_ID: env("DATASET_ID", "BlockchainEvents"),
  ENVIO_API_TOKEN: requireEnv("ENVIO_API_TOKEN"),
  SLACK_WEBHOOK_URL: env("SLACK_WEBHOOK_URL", ""),
  LOG_FILE: env("LOG_FILE", "pipeline.log"),

  /** Written onto every PipelineRuns row, so a defect is attributable to the code that wrote it. */
  PIPELINE_VERSION: env("PIPELINE_VERSION", "6.0.0-l0v4"),

  /** Rows buffered before a write. Writes are always flushed on a BLOCK boundary regardless. */
  CHUNK_SIZE_TARGET: envInt("CHUNK_SIZE_TARGET", 50_000),

  /**
   * L0-9. Months of padding each side of the literal MERGE window.
   *
   * MEASURED, with its bound. An unpadded source-derived window duplicates the merge key when a
   * log moves across a month boundary between ingestions, which is what a reorganisation near a
   * month end does: 2 rows against 1. One month covers a displacement back to the start of the
   * month BEFORE the source's own month, which is 31 to 62 days depending where in its month the
   * source sits. A row displaced 95 days duplicated. Raising this is safe and costs partitions
   * read; lowering it to zero reintroduces the duplicate.
   */
  MERGE_PADDING_MONTHS: envInt("MERGE_PADDING_MONTHS", 1),

  BQ_RETRIES: envInt("BQ_RETRIES", 5),
  HYPERSYNC_RETRIES: envInt("HYPERSYNC_RETRIES", 5),
  FRESHNESS_THRESHOLD_HOURS: envInt("FRESHNESS_THRESHOLD_HOURS", 36),

  // B7. Every network read is time bounded. Node's fetch has no default timeout and the
  // HyperSync client retries internally without bound, so a hung socket is indistinguishable
  // from slow work. One backfill in this project hung indefinitely on exactly that.
  /** Hard wall-clock deadline per HyperSync chunk. The child process is SIGKILLed at it. */
  HS_CHUNK_TIMEOUT_MS: envInt("HS_CHUNK_TIMEOUT_MS", 120_000),
  /** Hard deadline for one contract's whole block range. Bounds a run instead of hanging it. */
  HS_RANGE_DEADLINE_MS: envInt("HS_RANGE_DEADLINE_MS", 90 * 60_000),
  /** AbortController deadline on every JSON-RPC call. */
  RPC_TIMEOUT_MS: envInt("RPC_TIMEOUT_MS", 30_000),

  // B4. Inter-chunk pacing, applied on success as well as on failure. An unpaced wide scan
  // draws sustained 429s, which the client answers by retrying forever.
  HS_CHUNK_PAUSE_MS: envInt("HS_CHUNK_PAUSE_MS", 900),
  RPC_PAUSE_MS: envInt("RPC_PAUSE_MS", 250),

  /**
   * A chunk that returns no logs is a NEGATIVE, not a result. When true, every empty chunk is
   * confirmed against an independent JSON-RPC source before the watermark is allowed to move.
   * Turning this off is how a false zero becomes a permanent gap.
   */
  CONFIRM_EMPTY_CHUNKS: env("CONFIRM_EMPTY_CHUNKS", "true") !== "false",
  /** Repetitions used by calibrate mode to measure a source's false-zero rate in session. */
  CALIBRATION_REPEATS: envInt("CALIBRATION_REPEATS", 10),
};

// -- Networks --
//
// FINALITY IS MEASURED AND CARRIES ITS SOURCE. The previous configuration held two bare numbers,
// one of which was wrong by a factor of thirty, and nothing recorded where either came from so
// nobody could check them. Every figure below states the measurement behind it, which is the only
// thing that makes it checkable rather than inheritable.
//
// blocksPerDay is used for range sizing only. The authoritative end of any range is the chain
// tip, never this number. It is NEVER used to convert a block height to a time: one chain here
// changed cadence from five seconds to one second mid-life, so that arithmetic is wrong across
// the boundary, and the block's own timestamp is carried on every row precisely so it is never
// needed.

export const NETWORKS: Record<string, NetworkConfig> = {
  XDC: {
    name: "XDC",
    chainId: 50,
    finality: {
      blocks: 15,
      publishesFinalizedTag: true,
      source:
        "A2 sampled the finalized tag 33 times over 116 minutes and found it AT head, at 2.335 " +
        "seconds per block, with zero reorganisations observed. Any positive margin is therefore " +
        "conservative; 15 blocks is about 35 seconds and is retained rather than lowered, because " +
        "re-reading a settled block is free under MERGE and missing an unsettled one is not.",
    },
    // MEASURED from the warehouse's own data: protocol day 210 spans blocks 102,909,791 to
    // 102,949,369 and day 211 spans 102,949,373 to 102,988,782, so 39,400 to 40,300 blocks a day.
    // 43,200 is the two-second bound and is used deliberately: this figure sizes ranges, so an
    // overestimate costs time while an underestimate loses data.
    blocksPerDay: 43_200,
    chunkBlocks: envInt("XDC_CHUNK_BLOCKS", 20_000),
    ingestEnabled: true,
    readers: {
      hypersyncUrl: "https://xdc.hypersync.xyz",
      // MEASURED 2026-09-23: rpc.ankr.com/xdc and xdc.public-rpc.com are archive capable and
      // agreed on every one of roughly 1,500 calls. rpc.xdcrpc.com serves head and accepts wider
      // eth_getLogs ranges than the other two.
      rpcUrls: ["https://rpc.ankr.com/xdc", "https://xdc.public-rpc.com", "https://rpc.xdcrpc.com"],
      archiveRpcUrls: ["https://rpc.ankr.com/xdc", "https://xdc.public-rpc.com"],
      rpcLogRange: envInt("XDC_RPC_LOG_RANGE", 1_000),
      rpcLogResultCap: null,
      hasIndependentConfirmingReader: true,
      notes:
        "HyperSync answers. Two archive RPC operators agreed on every call in a 1,500 call run, so " +
        "grade A is obtainable here. rpc.xinfin.network and erpc.xinfin.network now answer HTTP 403.",
    },
  },

  CELO: {
    name: "CELO",
    chainId: 42220,
    finality: {
      blocks: 1_930,
      publishesFinalizedTag: true,
      source:
        "A2 sampled the finalized tag 33 times over 116 minutes and found it 1,187 to 1,930 blocks " +
        "behind head at 1.000 second per block, which is about 32 minutes. The UPPER bound is used " +
        "because an underestimate ingests a block that can still be reorganised while an " +
        "overestimate only delays it. The previous value here was 64, wrong by a factor of thirty, " +
        "and recorded no source.",
    },
    // Roughly 86,400 since the five-second to one-second block time change at block 31,056,500.
    blocksPerDay: 86_400,
    chunkBlocks: envInt("CELO_CHUNK_BLOCKS", 20_000),
    ingestEnabled: true,
    readers: {
      hypersyncUrl: "https://celo.hypersync.xyz",
      // forno is archive capable and is frequently the ONLY endpoint that answers old ranges. It
      // also returns FALSE ZEROS on eth_getLogs, measured between 20 and 90 percent depending on
      // range age, with no error on any occasion. It is listed because it answers; it is never
      // trusted alone, and R7 forbids reading any absence from a log scan regardless.
      rpcUrls: ["https://forno.celo.org", "https://celo.drpc.org", "https://celo.blockscout.com/api/eth-rpc"],
      archiveRpcUrls: ["https://forno.celo.org", "https://celo.drpc.org", "https://celo.blockscout.com/api/eth-rpc"],
      rpcLogRange: envInt("CELO_RPC_LOG_RANGE", 5_000),
      rpcLogResultCap: null,
      hasIndependentConfirmingReader: true,
      notes:
        "HyperSync answers. forno's false-zero rate is a function of RANGE AGE, not width and not " +
        "answer size, and was measured at 30 percent one day and 70 percent the next on the " +
        "identical query. rpc.ankr.com/celo holds no state before block 31,056,500, the L1 to L2 " +
        "migration block.",
    },
  },

  FUSE: {
    name: "FUSE",
    chainId: 122,
    finality: {
      blocks: 256,
      publishesFinalizedTag: false,
      source:
        "A2 found NO finalized and NO safe tag on any Fuse endpoint, so finality cannot be read " +
        "here at all and this number is not a measurement of finality. It is a stated time budget: " +
        "256 blocks is about 21 minutes at the measured 4.997 seconds per block. Because the budget " +
        "is a choice rather than an observation, every Fuse row also carries " +
        "confirmations_at_capture, so a consumer can apply its own threshold after the fact rather " +
        "than inheriting this one.",
    },
    blocksPerDay: 17_280,
    // Fuse caps by RESULT SIZE, not block span, so the chunk is sized against the measured
    // workable window rather than against a block-count limit.
    chunkBlocks: envInt("FUSE_CHUNK_BLOCKS", 50_000),
    ingestEnabled: true,
    readers: {
      // MEASURED: fuse.hypersync.xyz does not resolve. The client retries forever, so its absence
      // presents as a timeout rather than as a 404, which is why it read as "slow" for a while.
      hypersyncUrl: null,
      rpcUrls: ["https://rpc.fuse.io", "https://fuse.liquify.com"],
      // The ONLY archive-capable Fuse endpoint in existence that this project has found. It
      // publishes its own quota in headers at 10 reads per 11.08 minutes, which is about 54
      // archive reads an hour, so it is listed for STATE reads and is not used for enumeration.
      archiveRpcUrls: ["https://explorer.fuse.io/api/eth-rpc"],
      rpcLogRange: envInt("FUSE_RPC_LOG_RANGE", 50_000),
      // MEASURED: both enumerating readers cap at 20,000 logs per RESPONSE and refuse a
      // 200,000-block window on the GD anchor with "Too many logs requested". The largest workable
      // window measured was 50,000 blocks returning 9,669 logs in about 2.5 seconds.
      rpcLogResultCap: 20_000,
      hasIndependentConfirmingReader: true,
      notes:
        "No HyperSync index exists. Enumeration is by RPC, and the two operators agreed exactly at " +
        "every workable window tested, 9669/9669, 2666/2666 and 241/241, so their independence " +
        "stands and grade A is obtainable for LOGS. Historical STATE is a different matter: exactly " +
        "one archive endpoint exists, so the two-endpoint rule is unsatisfiable and every historical " +
        "state reading here is grade C permanently. An earlier record claiming rpc.fuse.io serves " +
        "genesis to head in one request is FALSE and was refuted by measurement.",
    },
  },

  ETHEREUM: {
    name: "ETHEREUM",
    chainId: 1,
    finality: {
      blocks: 94,
      publishesFinalizedTag: true,
      source:
        "A2 sampled the finalized tag 33 times over 116 minutes and found it 63 to 94 blocks behind " +
        "head at 12.079 seconds per block. The upper bound is used, for the same reason as Celo.",
    },
    blocksPerDay: 7_200,
    chunkBlocks: envInt("ETH_CHUNK_BLOCKS", 50_000),
    ingestEnabled: true,
    readers: {
      // MEASURED: eth.hypersync.xyz does not resolve, same shape as Fuse.
      hypersyncUrl: null,
      // MEASURED: both serve the full range in one request and agreed exactly. drpc, blastapi and
      // pokt all cap between 10 and 10,000 blocks on their free tiers.
      rpcUrls: ["https://eth.blockscout.com/api/eth-rpc", "https://gateway.tenderly.co/public/mainnet"],
      archiveRpcUrls: ["https://eth.blockscout.com/api/eth-rpc", "https://gateway.tenderly.co/public/mainnet"],
      rpcLogRange: envInt("ETH_RPC_LOG_RANGE", 50_000),
      rpcLogResultCap: null,
      hasIndependentConfirmingReader: true,
      notes:
        "No HyperSync index. Two independent full-range RPC readers agreed exactly. Several " +
        "endpoints on this chain PRUNE THE TRANSACTION INDEX, returning null from both transaction " +
        "lookups on old hashes, so a transaction row here can be less assured than the log that " +
        "pointed at it. The chains seed marks this chain inactive; it is addressable and it matters " +
        "only for pre-2024 history.",
    },
  },
};

/** The chains this run may touch, honouring --chains and the per-chain enable flag. */
export function selectedNetworks(chains?: string[]): NetworkConfig[] {
  const wanted = chains?.map((c) => c.toUpperCase());
  return Object.values(NETWORKS)
    .filter((n) => (wanted ? wanted.includes(n.name) : true))
    .sort((a, b) => a.chainId - b.chainId);
}

export function networkByChainId(chainId: number): NetworkConfig | undefined {
  return Object.values(NETWORKS).find((n) => n.chainId === chainId);
}

// -- The L0 v4 target tables --
//
// ONE universal schema, not one per contract. v3 declared a column set per domain table and a
// decoder per contract, so a new event needed a schema change and ingestion depended on
// modelling. Under v4 nothing is decoded at L0 at all: the selector is stored, nothing is matched
// at ingestion time, and the 147th contract needs a seed row rather than a column.
//
// The field lists below are the SOURCE of the staging schema and of the MERGE column list, so
// they are declared once and in the target's own order. Order matters: a mismatch against the
// target is silent at review time and only surfaces as an arity error, or worse, as values
// written into the wrong columns.

export const RAW_LOGS_TABLE = "RawLogs";
export const TRANSACTIONS_TABLE = "Transactions";

export const RAW_LOGS_SCHEMA: SchemaField[] = [
  { name: "chain_id", type: "INTEGER", mode: "REQUIRED" },
  { name: "block_number", type: "INTEGER", mode: "REQUIRED" },
  { name: "block_timestamp", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "block_hash", type: "STRING", mode: "REQUIRED" },
  { name: "tx_hash", type: "STRING", mode: "REQUIRED" },
  { name: "tx_index", type: "INTEGER", mode: "REQUIRED" },
  { name: "log_index", type: "INTEGER", mode: "REQUIRED" },
  { name: "contract_address", type: "STRING", mode: "REQUIRED" },
  { name: "implementation_address", type: "STRING" },
  { name: "era_index", type: "INTEGER" },
  { name: "era_resolution", type: "STRING", mode: "REQUIRED" },
  { name: "topic0", type: "STRING" },
  { name: "topic1", type: "STRING" },
  { name: "topic2", type: "STRING" },
  { name: "topic3", type: "STRING" },
  { name: "topic_count", type: "INTEGER", mode: "REQUIRED" },
  { name: "log_data", type: "STRING", mode: "REQUIRED" },
  { name: "removed", type: "BOOLEAN" },
  { name: "source_kind", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "STRING", mode: "REQUIRED" },
  { name: "assurance", type: "STRING", mode: "REQUIRED" },
  { name: "confirmations_at_capture", type: "INTEGER" },
  { name: "capture_id", type: "STRING", mode: "REQUIRED" },
  { name: "ingestion_run_id", type: "STRING", mode: "REQUIRED" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

export const TRANSACTIONS_SCHEMA: SchemaField[] = [
  { name: "chain_id", type: "INTEGER", mode: "REQUIRED" },
  { name: "block_number", type: "INTEGER", mode: "REQUIRED" },
  { name: "block_timestamp", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "block_hash", type: "STRING", mode: "REQUIRED" },
  { name: "tx_hash", type: "STRING", mode: "REQUIRED" },
  { name: "tx_index", type: "INTEGER", mode: "REQUIRED" },
  { name: "from_address", type: "STRING", mode: "REQUIRED" },
  { name: "to_address", type: "STRING" },
  { name: "contract_created", type: "STRING" },
  { name: "value_raw", type: "STRING", mode: "REQUIRED" },
  { name: "input_selector", type: "STRING" },
  { name: "nonce", type: "INTEGER" },
  { name: "status", type: "INTEGER" },
  { name: "gas_used", type: "INTEGER" },
  { name: "gas_limit", type: "INTEGER" },
  { name: "effective_gas_price", type: "STRING" },
  { name: "tx_type", type: "INTEGER" },
  { name: "source_kind", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "STRING", mode: "REQUIRED" },
  { name: "assurance", type: "STRING", mode: "REQUIRED" },
  { name: "capture_id", type: "STRING", mode: "REQUIRED" },
  { name: "ingestion_run_id", type: "STRING", mode: "REQUIRED" },
  { name: "ingested_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

/** The merge key per target table. RawLogs is keyed per log; a transaction has one row. */
export const MERGE_KEYS: Record<string, readonly string[]> = {
  [RAW_LOGS_TABLE]: ["chain_id", "tx_hash", "log_index"],
  [TRANSACTIONS_TABLE]: ["chain_id", "tx_hash"],
};

/**
 * The all-history views. require_partition_filter refuses a bare COUNT, a GROUP BY over the whole
 * table and dbt's own incremental pattern; a view carrying the wide filter in its definition
 * satisfies the guard and its consumers need no filter at all. Measured, including the GROUP BY
 * correctly finding a seeded duplicate through the view.
 */
export const ALL_HISTORY_VIEWS: Record<string, string> = {
  [RAW_LOGS_TABLE]: "RawLogsAllHistory",
  [TRANSACTIONS_TABLE]: "TransactionsAllHistory",
};

// -- Contract oracles --
//
// The protocol keeps its own ledgers in public state, and until 2026-09-23 nobody had asked
// them. These are the first source of truth this warehouse has ever had that is external to
// itself: every correctness argument before them was internal consistency, including the one
// that drove a shipped production fix.
//
// getClaimerCount(day) and getClaimAmount(day) are public getters over live mappings on the
// UBIScheme. stats() returns lifetime totals on the Invites contract. Past protocol days are
// FROZEN, proven on both contracts at blocks 1.5 million apart, which is what makes a daily
// reconciliation reproducible rather than a moving target.
//
// WHAT CHANGED UNDER v4. An oracle used to name a decoded domain table and rely on its
// event_name column. RawLogs decodes nothing, so an oracle now names the CONTRACT and the EVENT
// SIGNATURE, and the reconciliation counts logs whose topic0 matches. The topic0 is COMPUTED from
// the signature at runtime and is never a recalled constant: a hand-written ABI with one wrong
// parameter type changes the selector completely and returns a confident zero, which has already
// produced a false "no activity" finding in this project.
//
// THE ORACLE ROUTE IS NO LONGER THE ONLY ROUTE TO A RE-READ. It covers two contracts out of 146,
// because the other 144 publish no comparable ledger. It stays because it is the only EXTERNAL
// check that exists; repair is driven by IngestionCoverage instead. See repair.ts.

export interface OracleConfig {
  network: NetworkConfig;
  /** Lowercase. */
  address: string;
  /** periodStart(), Unix seconds. Protocol day d spans [periodStart + d*86400, +86400). */
  periodStart: number;
  kind: "ubi_daily" | "invites_stats";
  /**
   * The event whose logs this oracle reconciles against. A SIGNATURE, not a hash: the hash is
   * computed from it. L0-3 binds on topic0 and never on an event name.
   */
  eventSignature: string;
  /**
   * Which 32-byte word of log_data carries the amount, for the value reconciliation. Only the
   * non-indexed parameters appear in log_data, in declaration order.
   */
  amountWordIndex: number;
}

export const ORACLES: OracleConfig[] = [
  {
    network: NETWORKS.XDC,
    address: "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf",
    periodStart: 1_761_393_600,
    kind: "ubi_daily",
    // UBIClaimed(address indexed claimer, uint256 amount): claimer is indexed so it occupies
    // topic1, and amount is the only non-indexed parameter so it is word 0 of log_data.
    eventSignature: "UBIClaimed(address,uint256)",
    amountWordIndex: 0,
  },
  {
    network: NETWORKS.XDC,
    address: "0x6bd698566632bf2e81e2278f1656cb24aaf06d2e",
    periodStart: 1_761_393_600,
    kind: "invites_stats",
    // InviterBounty(address indexed inviter, address indexed invitee, uint256 bountyPaid,
    // uint256 inviterLevel, bool earnedLevel): both addresses are indexed, so bountyPaid is
    // word 0 of log_data.
    eventSignature: "InviterBounty(address,address,uint256,uint256,bool)",
    amountWordIndex: 0,
  },
];

export function oracleFor(chainId: number, address: string): OracleConfig | undefined {
  const a = address.toLowerCase();
  return ORACLES.find((o) => o.network.chainId === chainId && o.address === a);
}

/** Every oracle whose chain is in this run's selection. */
export function oraclesFor(networks: NetworkConfig[]): OracleConfig[] {
  const ids = new Set(networks.map((n) => n.chainId));
  return ORACLES.filter((o) => ids.has(o.network.chainId));
}

// -- Helpers --

export function fullTableName(tableId: string): string {
  return `\`${CONFIG.GCP_PROJECT_ID}.${CONFIG.DATASET_ID}.${tableId}\``;
}

export function stagingTableId(tableId: string, runId: string): string {
  return `_staging_${tableId}_${runId.replace(/-/g, "")}`;
}
