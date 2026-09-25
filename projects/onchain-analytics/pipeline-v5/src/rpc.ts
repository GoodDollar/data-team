/**
 * rpc.ts
 *
 * Minimal JSON-RPC, used for two jobs the indexer cannot do for itself.
 *
 *   1. Confirm a NEGATIVE. HyperSync is one index. When it returns no logs for a range, that is
 *      a claim by one source, and this project has measured what such claims are worth: an
 *      identical repeated eth_getLogs returned zero on seven of ten runs one day and three of
 *      ten the day before, with no errors raised on any occasion. A zero is confirmed on an
 *      independent source before a watermark is allowed to move past it.
 *   2. Read contract state. The reconciliation oracles are eth_call reads, and a state read is
 *      deterministic where a log query is not.
 *
 * Every call carries an AbortSignal deadline. Node's fetch has no default timeout, so a hung
 * socket is indistinguishable from slow work, and one backfill in this project hung on exactly
 * that (B7).
 *
 * Nothing here returns a bare value for a read that matters. A state read returns a consensus
 * result that names how many endpoints agreed, because a single endpoint's answer is a claim
 * about that endpoint.
 */

import { CONFIG } from "./config.js";
import { log } from "./log.js";
import type { NetworkConfig } from "./types.js";

let idCounter = 0;

export interface RpcResult {
  ok: boolean;
  result?: any;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = CONFIG.RPC_TIMEOUT_MS
): Promise<RpcResult> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++idCounter, method, params });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP_${res.status} ${text.slice(0, 200)}` };
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `BAD_JSON ${text.slice(0, 200)}` };
    }
    if (json.error) return { ok: false, error: `RPC_ERROR ${JSON.stringify(json.error).slice(0, 300)}` };
    return { ok: true, result: json.result };
  } catch (e: any) {
    return { ok: false, error: `${e.name === "TimeoutError" ? "RPC_TIMEOUT" : "RPC_FETCH"} ${e.message}` };
  }
}

export interface ConsensusResult {
  ok: boolean;
  value: any;
  agreeing: string[];
  answers: { url: string; raw: string }[];
  errors: string[];
  disagreement: boolean;
}

/**
 * Read the same deterministic thing from every endpoint and require agreement.
 *
 * A null is treated as a NEGATIVE requiring confirmation, never as an answer. That is not a
 * precaution: eth_getTransactionReceipt returned null for real, mined transactions on one
 * endpoint while another returned full receipts, and a helper that only falls through on
 * exceptions records that null as an absence.
 */
export async function consensusRead(
  network: NetworkConfig,
  method: string,
  params: unknown[],
  minAgree = 2
): Promise<ConsensusResult> {
  if (method === "eth_getLogs") {
    throw new Error("consensusRead refuses eth_getLogs: log queries are not deterministic here");
  }

  // The endpoints are independent hosts, so they are queried together rather than one after
  // another. A full-window reconciliation is two calls per protocol day; sequential querying
  // made that three times longer than it needed to be and long enough to be fragile.
  //
  // Historical STATE is read from the ARCHIVE endpoints only. A pruned node answers a historical
  // call with LATEST state, silently and with no error, so including one here would not produce
  // an error, it would produce agreement on the wrong value.
  const urls = network.readers.archiveRpcUrls.length > 0
    ? network.readers.archiveRpcUrls
    : network.readers.rpcUrls;
  const results = await Promise.all(
    urls.map(async (url) => ({ url, r: await rpcCall(url, method, params) }))
  );

  const answers: { url: string; raw: string }[] = [];
  const errors: string[] = [];

  for (const { url, r } of results) {
    if (!r.ok) {
      errors.push(`${url}: ${r.error}`);
    } else if (r.result === null || r.result === undefined) {
      errors.push(`${url}: returned null, recorded as a negative requiring confirmation`);
    } else {
      answers.push({ url, raw: JSON.stringify(r.result) });
    }
  }
  await sleep(CONFIG.RPC_PAUSE_MS);

  const buckets = new Map<string, string[]>();
  for (const a of answers) buckets.set(a.raw, [...(buckets.get(a.raw) ?? []), a.url]);
  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);

  if (sorted.length > 1) {
    return {
      ok: false, value: null, agreeing: [], answers, disagreement: true,
      errors: [...errors, `ENDPOINT_DISAGREEMENT: ${sorted.length} distinct answers`],
    };
  }
  if (sorted.length === 0 || sorted[0][1].length < minAgree) {
    return {
      ok: false, value: null, agreeing: sorted[0]?.[1] ?? [], answers, disagreement: false,
      errors: [...errors, `INSUFFICIENT_AGREEMENT: ${sorted[0]?.[1].length ?? 0} endpoint(s) answered, need ${minAgree}`],
    };
  }

  return {
    ok: true, value: JSON.parse(sorted[0][0]), agreeing: sorted[0][1],
    answers, errors, disagreement: false,
  };
}

export interface LogProbe {
  ok: boolean;
  /** Total logs found across every sub-range that succeeded. A floor, never a count. */
  found: number;
  /** Endpoints that answered every sub-range without error. */
  answeredFully: string[];
  errors: string[];
  subRanges: number;
}

/**
 * Ask an independent RPC source whether a block range really is empty.
 *
 * This is used ONLY to refute an emptiness claim, never to establish one. Finding one log
 * refutes "there are none", and a refutation from a log query is sound. A second zero proves
 * nothing and is reported as such: `ok` means the probe ran cleanly, not that the range is
 * empty.
 *
 * Ranges are split to each chain's eth_getLogs cap, because a range-too-large error renders as
 * nothing found unless errors are counted separately from results.
 */
export async function probeLogsPresent(
  network: NetworkConfig,
  addresses: string[],
  fromBlock: number,
  toBlock: number
): Promise<LogProbe> {
  const cap = network.readers.rpcLogRange;
  const ranges: [number, number][] = [];
  for (let lo = fromBlock; lo <= toBlock; lo += cap) {
    ranges.push([lo, Math.min(lo + cap - 1, toBlock)]);
  }

  const errors: string[] = [];
  const perEndpoint = new Map<string, { found: number; failures: number }>();

  for (const url of network.readers.rpcUrls) {
    perEndpoint.set(url, { found: 0, failures: 0 });
    for (const [lo, hi] of ranges) {
      const r = await rpcCall(url, "eth_getLogs", [{
        address: addresses.length === 1 ? addresses[0] : addresses,
        fromBlock: "0x" + lo.toString(16),
        toBlock: "0x" + hi.toString(16),
      }]);
      const e = perEndpoint.get(url)!;
      if (!r.ok) {
        e.failures += 1;
        errors.push(`${url} [${lo},${hi}]: ${r.error}`);
      } else if (Array.isArray(r.result)) {
        e.found += r.result.length;
      } else {
        e.failures += 1;
        errors.push(`${url} [${lo},${hi}]: non-array result`);
      }
      await sleep(CONFIG.RPC_PAUSE_MS);
    }
  }

  const answeredFully = [...perEndpoint.entries()].filter(([, e]) => e.failures === 0).map(([u]) => u);
  const found = Math.max(0, ...[...perEndpoint.values()].map((e) => e.found));

  return { ok: answeredFully.length > 0, found, answeredFully, errors, subRanges: ranges.length };
}

/**
 * Confirm that an empty HyperSync chunk really is empty.
 *
 * Returns true only when at least one independent endpoint covered the whole range without a
 * single error and also found nothing. Anything else, including every endpoint failing, is
 * UNCONFIRMED, and an unconfirmed empty range does not let a watermark past it.
 */
export async function confirmEmptyRange(
  network: NetworkConfig,
  addresses: string[],
  fromBlock: number,
  toBlock: number
): Promise<{ confirmed: boolean; reason: string; probe: LogProbe }> {
  const probe = await probeLogsPresent(network, addresses, fromBlock, toBlock);

  if (probe.answeredFully.length === 0) {
    return {
      confirmed: false,
      reason: `no independent endpoint covered ${fromBlock}..${toBlock} without error, so the emptiness is a claim by one source`,
      probe,
    };
  }
  if (probe.found > 0) {
    log.error(`FALSE ZERO CAUGHT: HyperSync reported no logs for ${fromBlock}..${toBlock}, RPC found ${probe.found}`, {
      network: network.name, endpoints: probe.answeredFully,
    });
    return {
      confirmed: false,
      reason: `REFUTED: an independent endpoint found ${probe.found} log(s) in a range HyperSync reported empty`,
      probe,
    };
  }
  return {
    confirmed: true,
    reason: `two sources agree the range is empty (${probe.answeredFully.length} endpoint(s) covered it with zero errors)`,
    probe,
  };
}
