/**
 * config.ts -- Centralized configuration. Fails fast on missing required env vars.
 */

import { config as loadDotenv } from "dotenv";
import type { NetworkConfig, ContractConfig, SchemaField, LogContext } from "./types.js";

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

  /** Rows buffered before a write. Writes are always flushed on a BLOCK boundary regardless. */
  CHUNK_SIZE_TARGET: envInt("CHUNK_SIZE_TARGET", 50_000),

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
// B2. blocksPerDay was 8,640 for XDC and 17,500 for Celo. Both were wrong, and wrong in the
// dangerous direction: they believe a day is covered when a few hours are.
//
//   XDC    MEASURED from the warehouse's own data. Protocol day 210 spans blocks 102,909,791 to
//          102,949,369 and day 211 spans 102,949,373 to 102,988,782, so roughly 39,400 to 40,300
//          blocks per day, which is a block every 2.1 to 2.2 seconds. 43,200 is the 2-second
//          bound and is used deliberately, because this figure sizes ranges and an overestimate
//          costs time while an underestimate loses data.
//   CELO   Roughly 86,400 since the 5-second to 1-second block time change.
//
// blocksPerDay is used for range sizing only. The authoritative end of any range is the chain
// tip, never this number.

export const NETWORKS: Record<string, NetworkConfig> = {
  XDC: {
    url: "https://xdc.hypersync.xyz",
    name: "XDC",
    chainId: 50,
    finalityBlocks: 15,
    blocksPerDay: 43_200,
    chunkBlocks: envInt("XDC_CHUNK_BLOCKS", 20_000),
    // MEASURED 2026-09-23: rpc.ankr.com/xdc and xdc.public-rpc.com are archive capable and agree.
    // rpc.xdcrpc.com serves head and accepts wider eth_getLogs ranges than the other two.
    rpcUrls: ["https://rpc.ankr.com/xdc", "https://xdc.public-rpc.com", "https://rpc.xdcrpc.com"],
    rpcLogRange: envInt("XDC_RPC_LOG_RANGE", 1_000),
  },
  CELO: {
    url: "https://celo.hypersync.xyz",
    name: "CELO",
    chainId: 42220,
    finalityBlocks: 64,
    blocksPerDay: 86_400,
    chunkBlocks: envInt("CELO_CHUNK_BLOCKS", 20_000),
    // MEASURED 2026-09-23: forno is archive capable and is frequently the only endpoint that
    // answers old ranges. It also returns FALSE ZEROS on eth_getLogs at a rate measured between
    // 30 and 70 percent, with no errors. It is listed because it answers, never trusted alone.
    rpcUrls: ["https://forno.celo.org", "https://celo.drpc.org", "https://celo.blockscout.com/api/eth-rpc"],
    rpcLogRange: envInt("CELO_RPC_LOG_RANGE", 5_000),
  },
};

// -- Common schema columns (every L1 table) --
//
// L0-1. All four topic slots and the data blob are stored verbatim alongside the decoded
// columns. A wrong ABI has forced a re-ingest twice in this project. With the raw log retained
// it becomes a SQL change instead.
// L0-6. ingestion_run_id on every row. A block range was ingested twice in production and
// nobody could say which run wrote which row.

const COMMON_SCHEMA: SchemaField[] = [
  { name: "network", type: "STRING" },
  { name: "chain_id", type: "INTEGER" },
  { name: "block_number", type: "INTEGER" },
  { name: "block_hash", type: "STRING" },
  { name: "block_timestamp", type: "TIMESTAMP" },
  { name: "tx_hash", type: "STRING" },
  { name: "tx_index", type: "INTEGER" },
  { name: "tx_from", type: "STRING" },
  { name: "tx_to", type: "STRING" },
  { name: "tx_value", type: "STRING" },
  { name: "tx_status", type: "INTEGER" },
  { name: "tx_nonce", type: "INTEGER" },
  { name: "gas_used", type: "INTEGER" },
  { name: "effective_gas_price", type: "STRING" },
  { name: "log_index", type: "INTEGER" },
  { name: "contract_address", type: "STRING" },
  { name: "event_name", type: "STRING" },
  { name: "topic0", type: "STRING" },
  { name: "topic1", type: "STRING" },
  { name: "topic2", type: "STRING" },
  { name: "topic3", type: "STRING" },
  { name: "log_data", type: "STRING" },
  { name: "ingestion_run_id", type: "STRING" },
  { name: "ingested_at", type: "TIMESTAMP" },
];

/**
 * The columns every row carries, filled from the log context rather than from constants.
 *
 * B1. chain_id comes from the network binding. It was hardcoded to 50 in both contract configs,
 * so every Celo row would have been labelled XDC, on a table whose primary key does not include
 * the chain. That is not a mislabelling, it is a collision.
 * B3. Transaction fields are captured. They were null on every row before this.
 */
function commonRow(
  eventName: string,
  c: LogContext,
  network: NetworkConfig,
  runId: string
): Record<string, any> {
  return {
    network: network.name,
    chain_id: network.chainId,
    block_number: c.blockNumber,
    block_hash: c.blockHash || null,
    block_timestamp: c.blockTimestamp > 0 ? new Date(c.blockTimestamp * 1000).toISOString() : null,
    tx_hash: c.txHash,
    tx_index: c.txIndex,
    tx_from: c.txFrom,
    tx_to: c.txTo,
    tx_value: c.txValue,
    tx_status: c.txStatus,
    tx_nonce: c.txNonce,
    gas_used: c.gasUsed,
    effective_gas_price: c.effectiveGasPrice,
    log_index: c.logIndex,
    contract_address: c.contractAddress,
    event_name: eventName,
    topic0: c.topics[0] ?? null,
    topic1: c.topics[1] ?? null,
    topic2: c.topics[2] ?? null,
    topic3: c.topics[3] ?? null,
    log_data: c.logData ?? null,
    ingestion_run_id: runId,
    ingested_at: new Date().toISOString(),
  };
}

// -- Contract configs --

const CLAIM_CONFIG: ContractConfig = {
  tableId: "ClaimContractEvents",
  schema: [
    ...COMMON_SCHEMA,
    { name: "claimer", type: "STRING" },
    { name: "amount", type: "STRING" },
  ],
  abi: [
    {
      anonymous: false,
      inputs: [
        { indexed: true, name: "claimer", type: "address" },
        { indexed: false, name: "amount", type: "uint256" },
      ],
      name: "UBIClaimed",
      type: "event",
    },
  ] as const,
  networkBindings: [
    {
      network: NETWORKS.XDC,
      firstBlock: 95_249_624,
      contracts: ["0x22867567E2D80f2049200E25C6F31CB6Ec2F0faf"],
    },
    // Celo: re-enable post-MVP
    // { network: NETWORKS.CELO, firstBlock: 18_006_679, contracts: ["0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1"] },
  ],
  decodeToRow: (eventName, args, logCtx, network, runId) => ({
    ...commonRow(eventName, logCtx, network, runId),
    claimer: args.claimer ?? null,
    amount: args.amount?.toString() ?? null,
  }),
};

const INVITE_CONFIG: ContractConfig = {
  tableId: "InviteContractEvents",
  schema: [
    ...COMMON_SCHEMA,
    { name: "inviter", type: "STRING" },
    { name: "invitee", type: "STRING" },
    { name: "bounty_paid", type: "STRING" },
    { name: "inviter_level", type: "STRING" },
    { name: "earned_level", type: "BOOLEAN" },
  ],
  abi: [
    {
      anonymous: false,
      inputs: [
        { indexed: true, name: "inviter", type: "address" },
        { indexed: true, name: "invitee", type: "address" },
      ],
      name: "InviteeJoined",
      type: "event",
    },
    {
      anonymous: false,
      inputs: [
        { indexed: true, name: "inviter", type: "address" },
        { indexed: true, name: "invitee", type: "address" },
        { indexed: false, name: "bountyPaid", type: "uint256" },
        { indexed: false, name: "inviterLevel", type: "uint256" },
        { indexed: false, name: "earnedLevel", type: "bool" },
      ],
      name: "InviterBounty",
      type: "event",
    },
  ] as const,
  networkBindings: [
    {
      network: NETWORKS.XDC,
      firstBlock: 95_144_756,
      contracts: ["0x6bd698566632bf2e81e2278f1656CB24aAF06D2e"],
    },
    // Celo: re-enable post-MVP
    // { network: NETWORKS.CELO, firstBlock: 18_483_200, contracts: ["0x36829D1Cda92FFF5782d5d48991620664FC857d3"] },
  ],
  decodeToRow: (eventName, args, logCtx, network, runId) => ({
    ...commonRow(eventName, logCtx, network, runId),
    inviter: args.inviter ?? null,
    invitee: args.invitee ?? null,
    bounty_paid: args.bountyPaid?.toString() ?? null,
    inviter_level: args.inviterLevel?.toString() ?? null,
    earned_level: args.earnedLevel ?? null,
  }),
};

export const CONTRACTS: ContractConfig[] = [CLAIM_CONFIG, INVITE_CONFIG];

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

export interface OracleConfig {
  tableId: string;
  network: NetworkConfig;
  address: string;
  /** periodStart(), Unix seconds. Protocol day d spans [periodStart + d*86400, +86400). */
  periodStart: number;
  kind: "ubi_daily" | "invites_stats";
}

export const ORACLES: OracleConfig[] = [
  {
    tableId: "ClaimContractEvents",
    network: NETWORKS.XDC,
    address: "0x22867567E2D80f2049200E25C6F31CB6Ec2F0faf",
    periodStart: 1_761_393_600,
    kind: "ubi_daily",
  },
  {
    tableId: "InviteContractEvents",
    network: NETWORKS.XDC,
    address: "0x6bd698566632bf2e81e2278f1656CB24aAF06D2e",
    periodStart: 1_761_393_600,
    kind: "invites_stats",
  },
];

export function oracleFor(tableId: string, networkName: string): OracleConfig | undefined {
  return ORACLES.find((o) => o.tableId === tableId && o.network.name === networkName);
}

// -- Helpers --

export function fullTableName(tableId: string): string {
  return `\`${CONFIG.GCP_PROJECT_ID}.${CONFIG.DATASET_ID}.${tableId}\``;
}

export function stagingTableId(tableId: string, runId: string): string {
  return `_staging_${tableId}_${runId.replace(/-/g, "")}`;
}
