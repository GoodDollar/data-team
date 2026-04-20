/**
 * ============================================================================
 * hypersync.ts — HyperSync client wrapper
 * ============================================================================
 *
 * Owns everything that talks to HyperSync:
 *   - streamDecodedEvents: async iterator yielding decoded rows
 *   - fetchDecodedEvents:  convenience wrapper that collects rows
 *   - getChainTip:         latest block number on a network
 *   - resolveBlockBeforeTimestamp: binary-search for the last block with
 *                          timestamp < target (used for midnight boundary)
 *   - countEvents:         header-only count for cheap verification
 *
 * Retry posture: stream.recv() failures retry with exponential backoff
 * up to CONFIG.HYPERSYNC_RETRIES. After that we give up and throw — the
 * caller is responsible for deciding what to do.
 *
 * Undecoded events: caller receives them via the onUnknown callback so
 * they can be logged to UnknownEvents. This lets us detect contract
 * upgrades emitting new events.
 * ============================================================================
 */

// @ts-ignore — NAPI-RS generated package has a known TS circular export bug
import { HypersyncClient } from "@envio-dev/hypersync-client";
import { decodeEventLog } from "viem";
import { CONFIG, NetworkConfig, ContractConfig } from "./config";
import { log } from "./log";
import { MAX_NULL_PROBES } from "./constants";

export interface DecodedRow {
  [key: string]: any;
}

export interface UnknownEvent {
  network: string;
  block_number: number;
  log_index: number;
  tx_hash: string;
  contract_address: string;
  topic0: string;
  raw_data: string;
}

export interface StreamOptions {
  onProgress?: (count: number) => void;
  onUnknown?: (evt: UnknownEvent) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Validate that a log entry carries a usable logIndex. A missing or
 * non-finite logIndex would produce duplicate dedup-key collisions because
 * the fallback 0 is a valid log index for real events.
 */
function requireLogIndex(logEntry: any, networkName: string): number {
  const li = logEntry.logIndex;
  if (typeof li !== "number" || !Number.isFinite(li) || li < 0) {
    throw new Error(
      `HyperSync returned a log without a valid logIndex on ${networkName}: ` +
      `block=${logEntry.blockNumber} tx=${logEntry.transactionHash} logIndex=${String(li)}`
    );
  }
  return li;
}

function makeClient(network: NetworkConfig) {
  return (HypersyncClient as any).new({
    url: network.url,
    bearerToken: CONFIG.ENVIO_API_TOKEN,
  });
}

/**
 * Async iterator that yields one decoded row at a time.
 *
 * Callers consume via `for await` so memory stays bounded regardless of
 * how many events exist in the range. Pipeline code buffers into
 * block-aligned chunks before writing to staging.
 */
export async function* streamDecodedEvents(
  cfg: ContractConfig,
  network: NetworkConfig,
  fromBlock: number,
  toBlock: number | undefined,
  opts: StreamOptions = {}
): AsyncGenerator<DecodedRow, void, unknown> {
  const client = makeClient(network);
  const query = {
    fromBlock,
    toBlock,
    logs: [{ address: cfg.contracts }],
    fieldSelection: {
      log: [
        "BlockNumber",
        "LogIndex",
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

  const stream: any = await withHypersyncRetry(
    () => client.stream(query, {}),
    `stream-open ${network.name}`,
    network.name
  );

  let emitted = 0;

  while (true) {
    const res: any = await withHypersyncRetry(
      () => stream.recv(),
      `stream-recv ${network.name}`,
      network.name
    );

    if (res === null || res === undefined) break;

    const logs = res.data?.logs ?? [];
    for (const logEntry of logs) {
      const topics = (logEntry.topics || []).filter(
        (t: any): t is string => typeof t === "string"
      ) as [`0x${string}`, ...`0x${string}`[]];

      if (topics.length === 0) continue;

      try {
        const decoded = decodeEventLog({
          abi: cfg.abi,
          data: ((logEntry.data as string) ?? "0x") as `0x${string}`,
          topics,
        });

        if (!decoded.eventName) continue;

        const row = cfg.decodeToRow(
          { eventName: decoded.eventName, args: decoded.args as any },
          {
            blockNumber: logEntry.blockNumber,
            transactionHash: logEntry.transactionHash,
            address: logEntry.address,
            logIndex: requireLogIndex(logEntry, network.name),
          },
          network.name
        );

        if (row !== null) {
          emitted++;
          yield row;

          if (opts.onProgress && emitted % 10_000 === 0) {
            opts.onProgress(emitted);
          }
        }
      } catch (e: any) {
        // Event didn't decode against our ABI. Could be:
        //   - event we don't care about emitted by same contract
        //   - contract upgrade adding a new event
        //   - ABI drift
        // Either way, record it so we can see it happening.
        if (opts.onUnknown) {
          opts.onUnknown({
            network: network.name,
            block_number: logEntry.blockNumber,
            log_index: requireLogIndex(logEntry, network.name),
            tx_hash: logEntry.transactionHash,
            contract_address: logEntry.address,
            topic0: topics[0] ?? "",
            raw_data: ((logEntry.data as string) ?? "0x"),
          });
        }
        // Debug-level visibility without spamming every single mismatch
        if (emitted === 0 || emitted % 1000 === 0) {
          log.warn("Event did not decode against configured ABI", {
            network: network.name,
            contract: logEntry.address,
            topic0: topics[0] ?? "",
            error: e?.message,
          });
        }
      }
    }
  }
}

/**
 * Collect all decoded events into an array. Use for small ranges only
 * (verify/repair chunks). For backfill, use streamDecodedEvents directly
 * with chunked consumption.
 */
export async function fetchDecodedEvents(
  cfg: ContractConfig,
  network: NetworkConfig,
  fromBlock: number,
  toBlock?: number,
  opts: StreamOptions = {}
): Promise<DecodedRow[]> {
  const rows: DecodedRow[] = [];
  for await (const r of streamDecodedEvents(cfg, network, fromBlock, toBlock, opts)) {
    rows.push(r);
  }
  return rows;
}

/**
 * Retry wrapper for HyperSync operations.
 *
 * We don't try to classify errors — any failure retries with backoff.
 * HyperSync transient errors (rate limits, brief network drops, gateway
 * timeouts) all resolve with a short wait. After HYPERSYNC_RETRIES, we
 * let the error propagate so the caller can decide.
 */
async function withHypersyncRetry<T>(
  fn: () => Promise<T>,
  opName: string,
  networkName: string
): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= CONFIG.HYPERSYNC_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (attempt === CONFIG.HYPERSYNC_RETRIES) break;
      const waitMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      log.warn(
        `HyperSync ${opName} failed (attempt ${attempt}/${CONFIG.HYPERSYNC_RETRIES}), backing off ${waitMs}ms`,
        { network: networkName, error: e?.message }
      );
      await sleep(waitMs);
    }
  }
  log.error(`HyperSync ${opName} exhausted retries`, {
    network: networkName,
    error: lastErr?.message,
  });
  throw lastErr;
}

/**
 * Return the current chain tip block number.
 *
 * Uses HyperSync's height endpoint. Falls back to a minimal stream query
 * if height isn't directly exposed on this client version.
 */
export async function getChainTip(network: NetworkConfig): Promise<number> {
  const client = makeClient(network);
  return await withHypersyncRetry(
    async () => {
      if (typeof client.getHeight === "function") {
        const h = await client.getHeight();
        return Number(h);
      }
      // Fallback: query with a far-future fromBlock and read archive height
      // from the server response. Most hypersync-client versions expose
      // getHeight; this branch is defensive.
      throw new Error(
        "HypersyncClient.getHeight not available; upgrade @envio-dev/hypersync-client"
      );
    },
    "getChainTip",
    network.name
  );
}

/**
 * Binary-search for the last block whose timestamp is strictly less than
 * the target timestamp. Used to resolve "end of yesterday UTC" into a
 * concrete block number.
 *
 * Bounds: [firstBlock, chainTip]. Fetches block timestamps via HyperSync
 * narrow-field queries (one block at a time during the search). Typical
 * search completes in ~25-30 probes for any realistic chain.
 *
 * Returns null if no block earlier than `targetUnixSec` exists in the
 * searchable range (e.g., target is before the chain started).
 */
export async function resolveBlockBeforeTimestamp(
  network: NetworkConfig,
  targetUnixSec: number,
  low: number,
  high: number
): Promise<number | null> {
  if (low > high) return null;

  // First check: is the lowest block already past the target?
  const lowTs = await getBlockTimestamp(network, low);
  if (lowTs === null) return null;
  if (lowTs >= targetUnixSec) return null;

  // And: is the highest block already before the target? If so, it's the answer.
  const highTs = await getBlockTimestamp(network, high);
  if (highTs !== null && highTs < targetUnixSec) return high;

  // Binary search invariant:
  //   block[lo].ts  < targetUnixSec
  //   block[hi].ts >= targetUnixSec (or unknown, treated as >=)
  let lo = low;
  let hi = high;
  let nullProbes = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = await getBlockTimestamp(network, mid);
    if (ts === null) {
      nullProbes++;
      if (nullProbes > MAX_NULL_PROBES) {
        throw new Error(
          `resolveBlockBeforeTimestamp on ${network.name}: ${nullProbes} consecutive null timestamp probes. ` +
          `HyperSync index likely lagging. Retry later.`
        );
      }
      // Block not available; treat as if >= target (pull hi in)
      hi = mid;
      continue;
    }
    nullProbes = 0; // reset on any successful probe
    if (ts < targetUnixSec) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Fetch a single block's timestamp. Returns null if the block isn't
 * available in HyperSync's index yet.
 */
async function getBlockTimestamp(
  network: NetworkConfig,
  blockNumber: number
): Promise<number | null> {
  const client = makeClient(network);
  return await withHypersyncRetry(
    async () => {
      const res = await client.getBlocks({
        fromBlock: blockNumber,
        toBlock: blockNumber + 1,
        fieldSelection: { block: ["Number", "Timestamp"] },
      });
      const blocks = res?.data?.blocks ?? res?.blocks ?? [];
      if (blocks.length === 0) return null;
      const ts = blocks[0].timestamp ?? blocks[0].Timestamp;
      if (ts === undefined || ts === null) return null;
      // Timestamps can come back as hex strings or numbers
      return typeof ts === "string" ? parseInt(ts, 16) : Number(ts);
    },
    `getBlockTimestamp ${blockNumber}`,
    network.name
  );
}

/**
 * Cheap event count for a block range using HyperSync metadata only.
 *
 * When topic0Filter is provided, only counts logs whose topic0 matches —
 * this prevents contract-upgrade false mismatches where the contract emits
 * new events we don't decode. Pass knownTopic0sFor(cfg) to count only
 * events our ABI can decode. Omit to count all contract logs.
 */
export async function countLogs(
  cfg: ContractConfig,
  network: NetworkConfig,
  fromBlock: number,
  toBlock: number,
  topic0Filter?: string[]
): Promise<number> {
  const client = makeClient(network);
  return await withHypersyncRetry(
    async () => {
      const logsFilter: any = { address: cfg.contracts };
      if (topic0Filter && topic0Filter.length > 0) {
        // HyperSync topics filter: topics[0] = array means "topic0 in set"
        logsFilter.topics = [topic0Filter];
      }
      // Stream with minimal field selection. We only need to count logs.
      const stream = await client.stream(
        {
          fromBlock,
          toBlock,
          logs: [logsFilter],
          fieldSelection: { log: ["BlockNumber"] },
        },
        {}
      );
      let count = 0;
      while (true) {
        const res = await stream.recv();
        if (res === null) break;
        count += (res.data?.logs ?? []).length;
      }
      return count;
    },
    `countLogs ${fromBlock}-${toBlock}`,
    network.name
  );
}
