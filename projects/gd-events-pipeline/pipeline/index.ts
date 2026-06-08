// @ts-ignore — NAPI-RS generated package has a known TS export bug
import { HypersyncClient } from "@envio-dev/hypersync-client";
import { BigQuery } from "@google-cloud/bigquery";
import { decodeEventLog } from "viem";
import { config } from "dotenv";

config();

// ============================================================
// TYPES
// ============================================================

interface NetworkConfig {
  url: string;
  name: string;
  chainId: number;
  firstBlock: number;
  finalityBlocks: number;
}

interface LogContext {
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number; // Unix seconds; 0 if unavailable
  txHash: string;
  txIndex: number;
  logIndex: number;
  contractAddress: string;
}

interface TxContext {
  from: string;
  to: string;
  value: string;   // wei, stored as STRING (uint256 range)
  status: number;  // 1 = success, 0 = reverted
  nonce: number;
}

interface ContractConfig {
  tableId: string;
  contracts: string[];
  networks: NetworkConfig[];
  abi: readonly any[];
  /**
   * Maps a decoded event to a flat BQ row. Called once per decoded log.
   * Returns null to skip an event that decoded but isn't relevant.
   */
  decodeToRow: (
    eventName: string,
    args: any,
    log: LogContext,
    tx: TxContext,
    networkName: string,
    chainId: number,
    ingestedAt: string
  ) => Record<string, any> | null;
}

// ============================================================
// CONFIGURATION
// ============================================================

const GCP_PROJECT_ID = "gooddollar";
const DATASET_ID = "BlockchainEvents";

const CONTRACT_CONFIGS: Record<string, ContractConfig> = {

  // ----------------------------------------------------------
  // UBIScheme (UBIClaimed only — MVP scope)
  //
  // To add more events later:
  //   1. Uncomment the ABI entry below
  //   2. Add the event-specific columns to the BQ table (ALTER TABLE ... ADD COLUMN ...)
  //   3. Handle the new eventName in decodeToRow
  // ----------------------------------------------------------
  claim: {
    tableId: "ClaimContractEvents",
    contracts: [
      // "0xd253A5203817225e9768C05E5996d642fb96bA86", // Fuse — disabled: FUSE not supported by HyperSync
      // "0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1", // Celo — MVP: XDC-only — re-enable post-MVP
      "0x22867567E2D80f2049200E25C6F31CB6Ec2F0faf", // XDC
    ],
    networks: [
      // { url: "https://fuse.hypersync.xyz", name: "FUSE", chainId: 122, firstBlock: 15_747_401, finalityBlocks: 20 }, // disabled: not supported by HyperSync
      // { url: "https://celo.hypersync.xyz",  name: "CELO", chainId: 42220, firstBlock: 18_006_679, finalityBlocks: 64 }, // MVP: XDC-only — re-enable post-MVP
      { url: "https://xdc.hypersync.xyz",   name: "XDC",  chainId: 50,    firstBlock: 95_249_624, finalityBlocks: 15 },
    ],
    abi: [
      // ---- Active events ----
      { anonymous: false, inputs: [{ indexed: true,  name: "claimer", type: "address" }, { indexed: false, name: "amount", type: "uint256" }], name: "UBIClaimed", type: "event" },

      // ---- Commented out — uncomment to enable ----
      // { anonymous: false, inputs: [{ indexed: false, name: "previousAdmin", type: "address" }, { indexed: false, name: "newAdmin", type: "address" }], name: "AdminChanged", type: "event" },
      // { anonymous: false, inputs: [{ indexed: true, name: "beacon", type: "address" }], name: "BeaconUpgraded", type: "event" },
      // { anonymous: false, inputs: [{ indexed: false, name: "newCycleLength", type: "uint256" }], name: "CycleLengthSet", type: "event" },
      // { anonymous: false, inputs: [{ indexed: false, name: "newDay", type: "uint256" }], name: "DaySet", type: "event" },
      // { anonymous: false, inputs: [{ indexed: false, name: "version", type: "uint8" }], name: "Initialized", type: "event" },
      // { anonymous: false, inputs: [{ indexed: false, name: "ShouldWithdrawFromDAO", type: "bool" }], name: "ShouldWithdrawFromDAOSet", type: "event" },
      // { anonymous: false, inputs: [{ indexed: false, name: "day", type: "uint256" }, { indexed: false, name: "dailyUbi", type: "uint256" }, { indexed: false, name: "blockNumber", type: "uint256" }], name: "UBICalculated", type: "event" },
      // { anonymous: false, inputs: [{ indexed: false, name: "day", type: "uint256" }, { indexed: false, name: "pool", type: "uint256" }, { indexed: false, name: "cycleLength", type: "uint256" }, { indexed: false, name: "dailyUBIPool", type: "uint256" }], name: "UBICycleCalculated", type: "event" },
      // { anonymous: false, inputs: [{ indexed: true, name: "implementation", type: "address" }], name: "Upgraded", type: "event" },
      // { anonymous: false, inputs: [{ indexed: false, name: "prevBalance", type: "uint256" }, { indexed: false, name: "newBalance", type: "uint256" }], name: "WithdrawFromDao", type: "event" },
    ] as const,
    decodeToRow: (_eventName, args, log, tx, networkName, chainId, ingestedAt) => ({
      network:                networkName,
      chain_id:               chainId,
      block_number:           log.blockNumber,
      block_hash:             log.blockHash || null,
      block_timestamp:        log.blockTimestamp > 0 ? new Date(log.blockTimestamp * 1000).toISOString() : null,
      tx_hash:                log.txHash,
      tx_index:               log.txIndex,
      tx_from:                tx.from  || null,
      tx_to:                  tx.to    || null,
      tx_value:               tx.value,
      tx_status:              tx.status,
      tx_nonce:               tx.nonce,
      log_index:              log.logIndex,
      contract_address:       log.contractAddress,
      event_name:             "UBIClaimed",
      ingested_at:            ingestedAt,
      claimer:                args.claimer ?? null,
      amount:                 args.amount?.toString() ?? null,
    }),
  },

  // ----------------------------------------------------------
  // InviteContract — InviteeJoined + InviterBounty
  // ----------------------------------------------------------
  invite: {
    tableId: "InviteContractEvents",
    contracts: [
      // "0x36829D1Cda92FFF5782d5d48991620664FC857d3", // Celo — MVP: XDC-only — re-enable post-MVP
      "0x6bd698566632bf2e81e2278f1656CB24aAF06D2e", // XDC
    ],
    networks: [
      // { url: "https://celo.hypersync.xyz", name: "CELO", chainId: 42220, firstBlock: 18_483_200, finalityBlocks: 64 }, // MVP: XDC-only — re-enable post-MVP
      { url: "https://xdc.hypersync.xyz",  name: "XDC",  chainId: 50,    firstBlock: 95_144_756, finalityBlocks: 15 },
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
          { indexed: true,  name: "inviter",      type: "address" },
          { indexed: true,  name: "invitee",      type: "address" },
          { indexed: false, name: "bountyPaid",   type: "uint256" },
          { indexed: false, name: "inviterLevel", type: "uint256" },
          { indexed: false, name: "earnedLevel",  type: "bool"    },
        ],
        name: "InviterBounty",
        type: "event",
      },
    ] as const,
    decodeToRow: (eventName, args, log, tx, networkName, chainId, ingestedAt) => ({
      network:                networkName,
      chain_id:               chainId,
      block_number:           log.blockNumber,
      block_hash:             log.blockHash || null,
      block_timestamp:        log.blockTimestamp > 0 ? new Date(log.blockTimestamp * 1000).toISOString() : null,
      tx_hash:                log.txHash,
      tx_index:               log.txIndex,
      tx_from:                tx.from  || null,
      tx_to:                  tx.to    || null,
      tx_value:               tx.value,
      tx_status:              tx.status,
      tx_nonce:               tx.nonce,
      log_index:              log.logIndex,
      contract_address:       log.contractAddress,
      event_name:             eventName,
      inviter:                args.inviter ?? null,
      invitee:                args.invitee ?? null,
      bounty_paid:            args.bountyPaid?.toString() ?? null,
      inviter_level:          args.inviterLevel?.toString() ?? null,
      earned_level:           args.earnedLevel ?? null,
      ingested_at:            ingestedAt,
    }),
  },
};

const VALID_MODES = ["backfill", "append"] as const;
type Mode = (typeof VALID_MODES)[number];

// ============================================================
// BigQuery helpers
// ============================================================

const bigquery = new BigQuery({ projectId: GCP_PROJECT_ID });
const dataset  = bigquery.dataset(DATASET_ID, { projectId: GCP_PROJECT_ID });

async function insertWithRetry(rows: any[], tableId: string, retries = 3): Promise<void> {
  const table = dataset.table(tableId);
  const rowsWithInsertId = rows.map((row) => ({
    insertId: `${row.network}:${row.tx_hash}:${row.log_index}`,
    json: row,
  }));
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await table.insert(rowsWithInsertId, { raw: true });
      return;
    } catch (e: any) {
      // PartialFailureError buries the real reason in e.errors[0].errors[0].
      // Log it clearly so schema mismatches are immediately obvious.
      const firstRowErr = e.errors?.[0];
      if (firstRowErr?.errors?.length > 0) {
        console.error("  BQ rejection — first row errors:", JSON.stringify(firstRowErr.errors));
        console.error("  BQ rejection — first row data:  ", JSON.stringify(firstRowErr.row));
      }
      if (attempt === retries) throw e;
      console.warn(`  Insert failed (attempt ${attempt}/${retries}), retrying in 3s...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function getChainTip(networkUrl: string, finalityBlocks: number): Promise<number | undefined> {
  try {
    const client = (HypersyncClient as any).new({ url: networkUrl, bearerToken: process.env.ENVIO_API_TOKEN || "" });
    const height = await client.getHeight();
    return Math.max(0, height - finalityBlocks);
  } catch (e: any) {
    console.warn(`Could not get chain tip: ${e.message}; fetching to latest`);
    return undefined;
  }
}

async function getLastBlockForNetwork(tableId: string, network: string): Promise<number> {
  try {
    const query = `SELECT MAX(block_number) as last_block FROM \`${GCP_PROJECT_ID}.${DATASET_ID}.${tableId}\` WHERE network = @network`;
    const [rows] = await bigquery.query({ query, params: { network }, projectId: GCP_PROJECT_ID });
    const lastBlock = rows[0]?.last_block;
    if (lastBlock !== null && lastBlock !== undefined) return Number(lastBlock);
  } catch (e: any) {
    console.log(`[${network}] Could not get last block: ${e.message}`);
  }
  return 0;
}

// ============================================================
// Stream and ingest events for one (contract, network) pair
// ============================================================

async function syncEvents(
  cfg: ContractConfig,
  network: NetworkConfig,
  fromBlock: number,
  toBlock?: number
): Promise<number> {
  const client = (HypersyncClient as any).new({
    url: network.url,
    bearerToken: process.env.ENVIO_API_TOKEN || "",
  });

  const query = {
    fromBlock,
    toBlock,
    logs: [{ address: cfg.contracts }],
    fieldSelection: {
      log: [
        "BlockNumber",
        "BlockHash",
        "TransactionHash",
        "TransactionIndex",
        "LogIndex",
        "Address",
        "Data",
        "Topic0",
        "Topic1",
        "Topic2",
        "Topic3",
      ],
      transaction: [
        "Hash",
        "From",
        "To",
        "Value",
        "Status",
        "Nonce",
      ],
      block: ["Number", "Timestamp"],
    },
  };

  console.log(`[${network.name}] Fetching from block ${fromBlock}${toBlock ? ` to ${toBlock}` : " to latest"}...`);

  const stream = await client.stream(query, {});
  let totalDecoded = 0;
  let totalSkipped = 0;
  const BATCH_SIZE = 1000;
  let pendingRows: any[] = [];
  const ingestedAt = new Date().toISOString();

  while (true) {
    const res = await stream.recv();
    if (res === null) break;

    // Build per-recv lookup maps so we can join log → transaction and log → block.
    const txByHash = new Map<string, any>();
    for (const tx of res.data?.transactions ?? []) {
      const h = (tx.hash as string)?.toLowerCase();
      if (h) txByHash.set(h, tx);
    }
    const blockByNumber = new Map<number, any>();
    for (const block of res.data?.blocks ?? []) {
      const n = block.number !== null && block.number !== undefined ? Number(block.number) : -1;
      if (n >= 0) blockByNumber.set(n, block);
    }

    for (const log of res.data?.logs ?? []) {
      const topics = (log.topics || []).filter(
        (t: any): t is string => typeof t === "string"
      ) as [`0x${string}`, ...`0x${string}`[]];
      if (topics.length === 0) continue;

      try {
        const decoded = decodeEventLog({
          abi: cfg.abi,
          data: ((log.data as string) ?? "0x") as `0x${string}`,
          topics,
        });

        const txHash = (log.transactionHash as string) ?? "";
        const tx    = txByHash.get(txHash.toLowerCase());
        const block = blockByNumber.get(Number(log.blockNumber));

        const logCtx: LogContext = {
          blockNumber:     Number(log.blockNumber),
          blockHash:       (log.blockHash as string) ?? (block?.hash as string) ?? "",
          blockTimestamp:  block?.timestamp ? Number(block.timestamp) : 0,
          txHash,
          txIndex:         log.transactionIndex !== undefined ? Number(log.transactionIndex) : 0,
          logIndex:        Number(log.logIndex),
          contractAddress: log.address as string,
        };

        const txCtx: TxContext = {
          from:   (tx?.from as string) ?? "",
          to:     (tx?.to   as string) ?? "",
          value:  tx?.value?.toString() ?? "0",
          status: tx?.status !== undefined ? Number(tx.status) : 1,
          nonce:  tx?.nonce  !== undefined ? Number(tx.nonce)  : 0,
        };

        const row = cfg.decodeToRow(decoded.eventName as unknown as string, decoded.args, logCtx, txCtx, network.name, network.chainId, ingestedAt);
        if (row === null) { totalSkipped++; continue; }

        pendingRows.push(row);
        totalDecoded++;

        if (totalDecoded === 1) {
          console.log(`[${network.name}] First event: ${decoded.eventName} at block ${log.blockNumber}`);
          console.log(`[${network.name}] Sample row:`, JSON.stringify(row, null, 2));
        }
      } catch {
        // Event not in ABI — skip silently
        totalSkipped++;
      }
    }

    while (pendingRows.length >= BATCH_SIZE) {
      const chunk = pendingRows.splice(0, BATCH_SIZE);
      await insertWithRetry(chunk, cfg.tableId);
      console.log(`[${network.name}] Inserted ${chunk.length} rows (total: ${totalDecoded})`);
    }
  }

  if (pendingRows.length > 0) {
    await insertWithRetry(pendingRows, cfg.tableId);
    console.log(`[${network.name}] Inserted final ${pendingRows.length} rows (total: ${totalDecoded})`);
  }

  console.log(`[${network.name}] Done. Decoded: ${totalDecoded}, skipped: ${totalSkipped}.`);
  return totalDecoded;
}

// ============================================================
// Main
//
//   npx tsx index.ts                       append, all contracts
//   npx tsx index.ts append                append, all contracts
//   npx tsx index.ts append claim          append, claim only
//   npx tsx index.ts backfill              backfill, all contracts
//   npx tsx index.ts backfill claim        backfill, claim only
//   npx tsx index.ts backfill claim,invite multiple contracts
// ============================================================

async function main() {
  const modeArg     = (process.argv[2] || "append").toLowerCase();
  const contractArg = (process.argv[3] || "all").toLowerCase();

  if (!VALID_MODES.includes(modeArg as Mode)) {
    throw new Error(`Unknown mode: "${modeArg}". Valid modes: ${VALID_MODES.join(", ")}`);
  }

  const allKeys      = Object.keys(CONTRACT_CONFIGS);
  const contractKeys = contractArg === "all"
    ? allKeys
    : contractArg.split(",").map((s) => s.trim()).filter((k) => k in CONTRACT_CONFIGS);

  if (contractKeys.length === 0) {
    throw new Error(`Unknown contract(s): "${contractArg}". Valid: ${allKeys.join(", ")}, all`);
  }

  const mode = modeArg as Mode;
  console.log(`\nMode: ${mode} | Contracts: ${contractKeys.join(", ")}`);
  console.log(`Project: ${GCP_PROJECT_ID} | Dataset: ${DATASET_ID}\n`);

  let grandTotal = 0;

  for (const key of contractKeys) {
    try {
      const cfg = CONTRACT_CONFIGS[key];
      console.log(`\n=== ${key.toUpperCase()} → ${DATASET_ID}.${cfg.tableId} ===`);

      for (const network of cfg.networks) {
        if (mode === "backfill") {
          console.log(`\n--- BACKFILL: ${network.name} (chainId ${network.chainId}) from block ${network.firstBlock} ---`);
          grandTotal += await syncEvents(cfg, network, network.firstBlock);
        } else {
          const lastBlock  = await getLastBlockForNetwork(cfg.tableId, network.name);
          const startBlock = lastBlock > 0 ? lastBlock + 1 : network.firstBlock;
          const safeTip    = await getChainTip(network.url, network.finalityBlocks);
          console.log(`\n--- APPEND: ${network.name} (chainId ${network.chainId}) from block ${startBlock}${safeTip ? ` to ${safeTip}` : ""} ---`);
          grandTotal += await syncEvents(cfg, network, startBlock, safeTip);
        }
      }
    } catch (e: any) {
      console.error(`[${key}] Error processing contract: ${e.message}`);
    }
  }

  console.log(`\n=== DONE. Total events inserted: ${grandTotal} ===`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
