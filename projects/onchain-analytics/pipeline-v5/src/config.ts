/**
 * config.ts -- Centralized configuration. Fails fast on missing required env vars.
 */

import { config as loadDotenv } from "dotenv";
import type { NetworkConfig, ContractConfig, SchemaField } from "./types.js";

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
  CHUNK_SIZE_TARGET: envInt("CHUNK_SIZE_TARGET", 50_000),
  BATCH_DELAY_MS: envInt("BATCH_DELAY_MS", 200),
  BQ_RETRIES: envInt("BQ_RETRIES", 5),
  HYPERSYNC_RETRIES: envInt("HYPERSYNC_RETRIES", 5),
  FRESHNESS_THRESHOLD_HOURS: envInt("FRESHNESS_THRESHOLD_HOURS", 36),
};

// -- Networks --

export const NETWORKS: Record<string, NetworkConfig> = {
  XDC: {
    url: "https://xdc.hypersync.xyz",
    name: "XDC",
    chainId: 50,
    finalityBlocks: 15,
    blocksPerDay: 8_640,
  },
  CELO: {
    url: "https://celo.hypersync.xyz",
    name: "CELO",
    chainId: 42220,
    finalityBlocks: 64,
    blocksPerDay: 17_500,
  },
};

// -- Common schema columns (every L1 table) --

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
  { name: "log_index", type: "INTEGER" },
  { name: "contract_address", type: "STRING" },
  { name: "event_name", type: "STRING" },
  { name: "ingested_at", type: "TIMESTAMP" },
];

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
  decodeToRow: (eventName, args, logCtx, networkName) => ({
    network: networkName,
    chain_id: logCtx.blockNumber > 0 ? 50 : 42220, // derived from networkName in practice
    block_number: logCtx.blockNumber,
    block_hash: logCtx.blockHash || null,
    block_timestamp: logCtx.blockTimestamp > 0
      ? new Date(logCtx.blockTimestamp * 1000).toISOString()
      : null,
    tx_hash: logCtx.txHash,
    tx_index: logCtx.txIndex,
    tx_from: null, // Not available in v5 log-only fetch; add if tx fields needed
    tx_to: null,
    tx_value: "0",
    tx_status: 1,
    tx_nonce: 0,
    log_index: logCtx.logIndex,
    contract_address: logCtx.contractAddress,
    event_name: eventName,
    ingested_at: new Date().toISOString(),
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
  decodeToRow: (eventName, args, logCtx, networkName) => ({
    network: networkName,
    chain_id: 50,
    block_number: logCtx.blockNumber,
    block_hash: logCtx.blockHash || null,
    block_timestamp: logCtx.blockTimestamp > 0
      ? new Date(logCtx.blockTimestamp * 1000).toISOString()
      : null,
    tx_hash: logCtx.txHash,
    tx_index: logCtx.txIndex,
    tx_from: null,
    tx_to: null,
    tx_value: "0",
    tx_status: 1,
    tx_nonce: 0,
    log_index: logCtx.logIndex,
    contract_address: logCtx.contractAddress,
    event_name: eventName,
    ingested_at: new Date().toISOString(),
    inviter: args.inviter ?? null,
    invitee: args.invitee ?? null,
    bounty_paid: args.bountyPaid?.toString() ?? null,
    inviter_level: args.inviterLevel?.toString() ?? null,
    earned_level: args.earnedLevel ?? null,
  }),
};

export const CONTRACTS: ContractConfig[] = [CLAIM_CONFIG, INVITE_CONFIG];

// -- Helpers --

export function fullTableName(tableId: string): string {
  return `\`${CONFIG.GCP_PROJECT_ID}.${CONFIG.DATASET_ID}.${tableId}\``;
}

export function stagingTableId(tableId: string, runId: string): string {
  return `_staging_${tableId}_${runId.replace(/-/g, "")}`;
}
