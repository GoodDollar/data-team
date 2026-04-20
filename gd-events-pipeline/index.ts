// @ts-ignore — NAPI-RS generated package has a known TS export bug
import { HypersyncClient } from "@envio-dev/hypersync-client";
import { BigQuery } from "@google-cloud/bigquery";
import { decodeEventLog } from "viem";
import { config } from "dotenv";

// Load .env file
config();

// ============================================================
// CONFIGURATION
// ============================================================

const GCP_PROJECT_ID = "gooddollar";
const DATASET_ID = "BlockchainEvents";
const TABLE_ID = "InviteContractEvents";

const CONTRACTS = [
  "0x6bd698566632bf2e81e2278f1656CB24aAF06D2e",
  "0x36829D1Cda92FFF5782d5d48991620664FC857d3",
];

// Known first blocks where these contracts emitted events
// so we skip scanning millions of empty blocks
const NETWORKS = [
  { url: "https://celo.hypersync.xyz", name: "CELO", firstBlock: 18483200 },
  { url: "https://xdc.hypersync.xyz", name: "XDC", firstBlock: 100412600 },
];

// ============================================================
// ABIs
// ============================================================

const ABIS = [
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
] as const;

// ============================================================
// BigQuery — explicit project ID on EVERY call
// ============================================================

const bigquery = new BigQuery({ projectId: GCP_PROJECT_ID });
const dataset = bigquery.dataset(DATASET_ID, { projectId: GCP_PROJECT_ID });
const table = dataset.table(TABLE_ID);

async function insertWithRetry(rows: any[], retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await table.insert(rows);
      return;
    } catch (e: any) {
      if (attempt === retries) throw e;
      console.warn(
        `  Insert failed (attempt ${attempt}/${retries}): ${e.message}. Retrying in 3s...`
      );
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ============================================================
// Get last block for a network (for append mode)
// ============================================================

async function getLastBlockForNetwork(network: string): Promise<number> {
  try {
    const query = `
      SELECT MAX(block_number) as last_block
      FROM \`${GCP_PROJECT_ID}.${DATASET_ID}.${TABLE_ID}\`
      WHERE network = @network
    `;
    const [rows] = await bigquery.query({
      query,
      params: { network },
      projectId: GCP_PROJECT_ID,
    });
    const lastBlock = rows[0]?.last_block;
    if (lastBlock !== null && lastBlock !== undefined) {
      return Number(lastBlock);
    }
  } catch (e: any) {
    console.log(
      `[${network}] Could not get last block: ${e.message}`
    );
  }
  return 0;
}

// ============================================================
// Sync events
// ============================================================

async function syncEvents(
  networkUrl: string,
  networkName: string,
  fromBlock: number = 0,
  toBlock?: number
): Promise<number> {
  const client = (HypersyncClient as any).new({
    url: networkUrl,
    bearerToken: process.env.ENVIO_API_TOKEN || "",
  });

  const query = {
    fromBlock,
    toBlock,
    logs: [{ address: CONTRACTS }],
    fieldSelection: {
      log: [
        "BlockNumber",
        "TransactionHash",
        "Address",
        "Data",
        "Topic0",
        "Topic1",
        "Topic2",
        "Topic3",
      ],
    },
  };

  console.log(
    `[${networkName}] Fetching from block ${fromBlock}${toBlock ? ` to ${toBlock}` : " to latest"}...`
  );

  const stream = await client.stream(query, {});
  let totalDecoded = 0;
  const BATCH_SIZE = 500;
  let pendingRows: any[] = [];

  while (true) {
    const res = await stream.recv();
    if (res === null) break;

    const logs = res.data?.logs ?? [];

    for (const log of logs) {
      const topics = (log.topics || []).filter(
        (t: any): t is string => typeof t === "string"
      ) as [`0x${string}`, ...`0x${string}`[]];

      if (topics.length === 0) continue;

      try {
        const decoded = decodeEventLog({
          abi: ABIS,
          data: ((log.data as string) ?? "0x") as `0x${string}`,
          topics,
        });

        pendingRows.push({
          network: networkName,
          block_number: log.blockNumber,
          tx_hash: log.transactionHash,
          contract_address: log.address,
          event_name: decoded.eventName,
          inviter: (decoded.args as any).inviter ?? null,
          invitee: (decoded.args as any).invitee ?? null,
          bounty_paid:
            (decoded.args as any).bountyPaid?.toString() ?? null,
          inviter_level:
            (decoded.args as any).inviterLevel?.toString() ?? null,
          earned_level: (decoded.args as any).earnedLevel ?? null,
          ingested_at: bigquery.timestamp(new Date().toISOString()),
        });

        totalDecoded++;

        if (totalDecoded === 1) {
          console.log(
            `[${networkName}] First event: ${decoded.eventName} at block ${log.blockNumber}`
          );
        }
      } catch (e: any) {
        // Event not in our ABI — skip
      }
    }

    // Insert in batches
    if (pendingRows.length >= BATCH_SIZE) {
      await insertWithRetry(pendingRows);
      console.log(
        `[${networkName}] Inserted ${pendingRows.length} rows (total: ${totalDecoded})`
      );
      pendingRows = [];
    }
  }

  // Insert remaining
  if (pendingRows.length > 0) {
    await insertWithRetry(pendingRows);
    console.log(
      `[${networkName}] Inserted final ${pendingRows.length} rows (total: ${totalDecoded})`
    );
  }

  console.log(`[${networkName}] Done. Total: ${totalDecoded} events.`);
  return totalDecoded;
}

// ============================================================
// Main
//   npx tsx index.ts           → append (daily)
//   npx tsx index.ts backfill  → full history
// ============================================================

async function main() {
  const mode = process.argv[2] || "append";

  console.log(`\nMode: ${mode}`);
  console.log(`Project: ${GCP_PROJECT_ID}`);
  console.log(`Table: ${DATASET_ID}.${TABLE_ID}\n`);

  let grandTotal = 0;

  for (const network of NETWORKS) {
    if (mode === "backfill") {
      // Start from known first block instead of 0
      console.log(
        `\n--- BACKFILL: ${network.name} (from block ${network.firstBlock}) ---`
      );
      const count = await syncEvents(
        network.url,
        network.name,
        network.firstBlock
      );
      grandTotal += count;
    } else {
      // APPEND: resume from last ingested block + 1
      const lastBlock = await getLastBlockForNetwork(network.name);
      const startBlock =
        lastBlock > 0 ? lastBlock + 1 : network.firstBlock;
      console.log(
        `\n--- APPEND: ${network.name} (from block ${startBlock}) ---`
      );
      const count = await syncEvents(
        network.url,
        network.name,
        startBlock
      );
      grandTotal += count;
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Total events inserted: ${grandTotal}`);
}

main().catch(console.error);