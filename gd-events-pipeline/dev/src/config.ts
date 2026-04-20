/**
 * ============================================================================
 * config.ts — Centralized configuration
 * ============================================================================
 *
 * All environment-driven settings live here. Fails fast on import if a
 * required env var is missing, rather than surfacing the error deep inside
 * a BigQuery or HyperSync call later.
 *
 * Contract definitions live at the bottom. Adding a new contract means
 * adding an entry to CONTRACT_CONFIGS — the rest of the pipeline is
 * fully generic.
 * ============================================================================
 */

import { config as loadDotenv } from "dotenv";
import { toEventSelector } from "viem";

loadDotenv();

// ----------------------------------------------------------------------------
// ENV HELPERS
// ----------------------------------------------------------------------------

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    // eslint-disable-next-line no-console
    console.error(
      `[FATAL] Required environment variable ${key} is missing or empty.`
    );
    process.exit(1);
  }
  return v;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) {
    // eslint-disable-next-line no-console
    console.error(`[FATAL] Env ${key} is not a valid integer: "${v}"`);
    process.exit(1);
  }
  return n;
}

function envString(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() !== "" ? v : fallback;
}

// ----------------------------------------------------------------------------
// CORE CONFIG
// ----------------------------------------------------------------------------

export const CONFIG = {
  // GCP
  GCP_PROJECT_ID: envString("GCP_PROJECT_ID", "gooddollar"),
  DATASET_ID: envString("DATASET_ID", "BlockchainEvents"),

  // HyperSync
  ENVIO_API_TOKEN: requireEnv("ENVIO_API_TOKEN"),

  // Logging
  LOG_FILE: envString("LOG_FILE", "pipeline.log"),
  LOG_LEVEL: envString("LOG_LEVEL", "INFO"), // INFO | WARN | ERROR | FATAL

  // Retry posture
  BQ_RETRIES: envInt("BQ_RETRIES", 3),
  LOAD_RETRIES: envInt("LOAD_RETRIES", 3),
  HYPERSYNC_RETRIES: envInt("HYPERSYNC_RETRIES", 5),

  // Chunk sizing
  CHUNK_SIZE_LOAD_TARGET: envInt("CHUNK_SIZE_LOAD_TARGET", 50_000),
  CHUNK_SIZE_VERIFY_BLOCKS: envInt("CHUNK_SIZE_VERIFY_BLOCKS", 100_000),

  // Concurrency — number of (contract, network) fetch streams in flight
  FETCH_CONCURRENCY: envInt("FETCH_CONCURRENCY", 4),

  // Verification window for daily runs (days)
  VERIFY_WINDOW_DAYS: envInt("VERIFY_WINDOW_DAYS", 7),

  // Lock TTL (ms). If a run holds the lock longer than this and no heartbeat,
  // a subsequent run will steal it.
  LOCK_TTL_MS: envInt("LOCK_TTL_MS", 6 * 60 * 60 * 1000), // 6h

  // Infrastructure table names
  UNKNOWN_EVENTS_TABLE: envString("UNKNOWN_EVENTS_TABLE", "UnknownEvents"),
  INGESTION_STATUS_TABLE: envString(
    "INGESTION_STATUS_TABLE",
    "IngestionStatus"
  ),
  PIPELINE_LOCKS_TABLE: envString("PIPELINE_LOCKS_TABLE", "PipelineLocks"),
  VERIFY_CHECKPOINTS_TABLE: envString("VERIFY_CHECKPOINTS_TABLE", "VerifyCheckpoints"),
};

// ----------------------------------------------------------------------------
// NETWORK & CONTRACT TYPES
// ----------------------------------------------------------------------------

export interface NetworkConfig {
  /** HyperSync endpoint URL */
  url: string;
  /** Human-readable network name, used as the `network` column value */
  name: string;
  /**
   * Finality safety margin. We never ingest closer to the chain tip than
   * this many blocks, to avoid ingesting data that could be reorged out.
   * Tune per chain's finality characteristics.
   */
  finalityBlocks: number;
  /**
   * Rough upper bound on blocks produced per day. Used for verify window
   * sizing. Only needs to be accurate within 2x.
   */
  blocksPerDay: number;
}

/** Binds a network to a contract with a per-(contract, network) firstBlock. */
export interface ContractNetworkBinding {
  network: NetworkConfig;
  /** Block number just before the first known event for this contract on this network. */
  firstBlock: number;
  /** Set to false to skip this (contract, network) pair without removing the config. */
  enabled?: boolean;
}

export interface ContractConfig {
  tableId: string;
  schema: Array<{ name: string; type: string }>;
  abi: readonly any[];
  contracts: string[];
  /** Per-(contract, network) bindings replacing the old flat `networks` array. */
  networkBindings: ContractNetworkBinding[];
  /** Set to false to disable this contract across all networks. */
  enabled?: boolean;
  /** Optional tags for grouping filter (e.g. "invites", "ubi"). */
  tags?: string[];
  /**
   * Converts a decoded event log into a flat object matching the BigQuery
   * schema. Return null to skip an event that decoded but isn't relevant.
   */
  decodeToRow: (
    decoded: { eventName: string; args: any },
    log: {
      blockNumber: number;
      blockTimestamp: number; // Unix seconds
      transactionHash: string;
      address: string;
      logIndex: number;
    },
    networkName: string
  ) => Record<string, any> | null;
}

// ----------------------------------------------------------------------------
// NETWORKS
// ----------------------------------------------------------------------------

export const NETWORKS: Record<string, NetworkConfig> = {
  CELO: {
    url: "https://celo.hypersync.xyz",
    name: "CELO",
    finalityBlocks: 64,
    blocksPerDay: 17_500,
  },
  XDC: {
    url: "https://xdc.hypersync.xyz",
    name: "XDC",
    finalityBlocks: 15,
    blocksPerDay: 8_640,
  },
  FUSE: {
    url: "https://fuse.hypersync.xyz",
    name: "FUSE",
    finalityBlocks: 20,
    blocksPerDay: 86_400,
  },
};

// ----------------------------------------------------------------------------
// CONTRACT CONFIGS
// ----------------------------------------------------------------------------

const INVITE_CONFIG: ContractConfig = {
  tableId: "InviteContractEvents",
  tags: ["invites"],
  schema: [
    { name: "network", type: "STRING" },
    { name: "block_number", type: "INTEGER" },
    { name: "block_timestamp", type: "TIMESTAMP" },
    { name: "log_index", type: "INTEGER" },
    { name: "tx_hash", type: "STRING" },
    { name: "contract_address", type: "STRING" },
    { name: "event_name", type: "STRING" },
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
  contracts: [
    "0x6bd698566632bf2e81e2278f1656CB24aAF06D2e",
    "0x36829D1Cda92FFF5782d5d48991620664FC857d3",
  ],
  networkBindings: [
    { network: NETWORKS.CELO, firstBlock: 18_483_200 },
    { network: NETWORKS.XDC, firstBlock: 100_412_600 },
  ],
  decodeToRow: (decoded, log, networkName) => ({
    network: networkName,
    block_number: log.blockNumber,
    block_timestamp: new Date(log.blockTimestamp * 1000).toISOString(),
    log_index: log.logIndex,
    tx_hash: log.transactionHash,
    contract_address: log.address,
    event_name: decoded.eventName,
    inviter: decoded.args.inviter ?? null,
    invitee: decoded.args.invitee ?? null,
    bounty_paid: decoded.args.bountyPaid?.toString() ?? null,
    inviter_level: decoded.args.inviterLevel?.toString() ?? null,
    earned_level: decoded.args.earnedLevel ?? null,
  }),
};

const CLAIM_CONFIG: ContractConfig = {
  tableId: "ClaimContractEvents",
  tags: ["ubi"],
  schema: [
    { name: "network", type: "STRING" },
    { name: "block_number", type: "INTEGER" },
    { name: "block_timestamp", type: "TIMESTAMP" },
    { name: "log_index", type: "INTEGER" },
    { name: "tx_hash", type: "STRING" },
    { name: "contract_address", type: "STRING" },
    { name: "event_name", type: "STRING" },
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
  contracts: [
    "0xd253A5203817225e9768C05E5996d642fb96bA86", // Fuse
    "0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1", // Celo
    "0x22867567E2D80f2049200E25C6F31CB6Ec2F0faf", // XDC
  ],
  networkBindings: [
    { network: NETWORKS.FUSE, firstBlock: 15_747_401 },
    { network: NETWORKS.CELO, firstBlock: 18_006_679 },
    { network: NETWORKS.XDC, firstBlock: 95_249_624 },
  ],
  decodeToRow: (decoded, log, networkName) => ({
    network: networkName,
    block_number: log.blockNumber,
    block_timestamp: new Date(log.blockTimestamp * 1000).toISOString(),
    log_index: log.logIndex,
    tx_hash: log.transactionHash,
    contract_address: log.address,
    event_name: decoded.eventName,
    claimer: decoded.args.claimer ?? null,
    amount: decoded.args.amount?.toString() ?? null,
  }),
};

/**
 * All contract configs processed by the pipeline.
 * Add new contracts by creating a config above and including it here.
 */
export const CONTRACT_CONFIGS: ContractConfig[] = [INVITE_CONFIG, CLAIM_CONFIG];

// ----------------------------------------------------------------------------
// DERIVED HELPERS
// ----------------------------------------------------------------------------

export function fullTableName(tableId: string): string {
  return `\`${CONFIG.GCP_PROJECT_ID}.${CONFIG.DATASET_ID}.${tableId}\``;
}

export function stagingTableName(tableId: string, runId: string): string {
  // Underscores + short run id suffix; BQ table names cap at 1024 chars
  // and we want these easy to spot and clean up.
  return `_staging_${tableId}_${runId}`;
}

/**
 * Returns the set of topic0 hashes (as lowercase 0x-prefixed strings) for
 * all events declared in this contract's ABI. Used by verify paths to
 * count only events we actually care about.
 */
export function knownTopic0sFor(cfg: ContractConfig): string[] {
  return cfg.abi
    .filter((item: any) => item.type === "event")
    .map((item: any) => toEventSelector(item).toLowerCase());
}
