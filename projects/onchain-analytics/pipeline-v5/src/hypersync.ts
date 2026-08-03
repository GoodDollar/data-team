/**
 * hypersync.ts -- HyperSync client wrapper.
 * Streaming, chain tip resolution, day boundary binary search.
 */

// @ts-ignore -- NAPI-RS generated package has a known TS export bug
import { HypersyncClient } from "@envio-dev/hypersync-client";
import { decodeEventLog } from "viem";
import { CONFIG } from "./config.js";
import { log } from "./log.js";
import type { NetworkConfig, ContractConfig, DecodedRow, LogContext } from "./types.js";

// -- Client cache (one per URL) --

const clientCache = new Map<string, any>();

function getClient(network: NetworkConfig): any {
  const existing = clientCache.get(network.url);
  if (existing) return existing;
  const client = (HypersyncClient as any).new({
    url: network.url,
    bearerToken: CONFIG.ENVIO_API_TOKEN,
  });
  clientCache.set(network.url, client);
  return client;
}

// -- Backoff helper --

function backoffMs(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt - 1);
  return base + Math.random() * base * 0.3;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -- Chain tip --

export async function getChainTip(network: NetworkConfig): Promise<number | undefined> {
  try {
    const client = getClient(network);
    const height: number = await client.getHeight();
    return height; // No finality subtraction -- daily batch data is always hours/days past finality
  } catch (e: any) {
    log.warn(`getChainTip failed for ${network.name}: ${e.message}. Will stream to latest available.`);
    return undefined;
  }
}

// -- Day boundary resolution --

export async function resolveBlockBeforeTimestamp(
  network: NetworkConfig,
  targetTimestamp: number
): Promise<number | undefined> {
  try {
    const client = getClient(network);
    // Binary search: find the last block with timestamp < target
    let lo = 0;
    let hi: number = await client.getHeight();
    let result = lo;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const query = {
        fromBlock: mid,
        toBlock: mid + 1,
        logs: [],
        fieldSelection: { block: ["Number", "Timestamp"] },
      };
      const response = await client.sendReq(query);
      const block = response?.data?.blocks?.[0];
      if (!block || block.timestamp === undefined) {
        hi = mid - 1;
        continue;
      }
      if (Number(block.timestamp) < targetTimestamp) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  } catch (e: any) {
    log.warn(`resolveBlockBeforeTimestamp failed for ${network.name}: ${e.message}`);
    return undefined;
  }
}

/**
 * Resolve the toBlock for daily mode.
 * Uses chain tip with finality margin (sufficient for daily batch --
 * data is always 24h+ past finality).
 */
export async function resolveDailyToBlock(network: NetworkConfig): Promise<number | undefined> {
  return getChainTip(network);
}

// -- Event streaming --

export async function* streamEvents(
  network: NetworkConfig,
  contracts: string[],
  abi: readonly any[],
  fromBlock: number,
  toBlock?: number
): AsyncGenerator<DecodedRow[]> {
  const client = getClient(network);

  const query = {
    fromBlock,
    toBlock,
    logs: [{ address: contracts }],
    fieldSelection: {
      log: [
        "BlockNumber", "BlockHash", "TransactionHash", "TransactionIndex",
        "LogIndex", "Address", "Data", "Topic0", "Topic1", "Topic2", "Topic3",
      ],
      transaction: ["Hash", "From", "To", "Value", "Status", "Nonce"],
      block: ["Number", "Timestamp"],
    },
  };

  const stream = await client.stream(query, {});
  let recvAttempts = 0;

  while (true) {
    let res: any;
    try {
      res = await stream.recv();
      recvAttempts = 0; // reset on success
    } catch (e: any) {
      recvAttempts++;
      if (recvAttempts >= CONFIG.HYPERSYNC_RETRIES) {
        log.error(`HyperSync stream failed after ${recvAttempts} attempts`, { network: network.name, error: e.message });
        throw e;
      }
      const delay = backoffMs(recvAttempts);
      log.warn(`HyperSync recv error (attempt ${recvAttempts}/${CONFIG.HYPERSYNC_RETRIES}), retrying in ${Math.round(delay)}ms`, { error: e.message });
      await sleep(delay);
      continue;
    }

    if (res === null) break;

    // Build lookup maps
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

    const batch: DecodedRow[] = [];

    for (const logEntry of res.data?.logs ?? []) {
      const topics = (logEntry.topics || []).filter(
        (t: any): t is string => typeof t === "string"
      ) as [`0x${string}`, ...`0x${string}`[]];
      if (topics.length === 0) continue;

      try {
        const decoded = decodeEventLog({
          abi,
          data: ((logEntry.data as string) ?? "0x") as `0x${string}`,
          topics,
        });

        const txHash = (logEntry.transactionHash as string) ?? "";
        const block = blockByNumber.get(Number(logEntry.blockNumber));

        const logCtx: LogContext = {
          blockNumber: Number(logEntry.blockNumber),
          blockHash: (logEntry.blockHash as string) ?? (block?.hash as string) ?? "",
          blockTimestamp: block?.timestamp ? Number(block.timestamp) : 0,
          txHash,
          txIndex: logEntry.transactionIndex !== undefined ? Number(logEntry.transactionIndex) : 0,
          logIndex: Number(logEntry.logIndex),
          contractAddress: logEntry.address as string,
        };

        batch.push({ ...logCtx, _eventName: decoded.eventName, _args: decoded.args });
      } catch {
        // Event not in ABI -- skip
      }
    }

    if (batch.length > 0) yield batch;

    // Inter-batch delay to prevent 429 rate-limiting
    if (CONFIG.BATCH_DELAY_MS > 0) await sleep(CONFIG.BATCH_DELAY_MS);
  }
}
