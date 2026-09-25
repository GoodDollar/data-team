/**
 * reader.ts -- choose a reader for a chain, and provide the one that HyperSync cannot.
 *
 * WHY THIS EXISTS. Two of the four chains in this set have no HyperSync index at all:
 * fuse.hypersync.xyz and eth.hypersync.xyz do not resolve, and because the client retries
 * internally without bound their absence presents as a timeout rather than as a 404, which is why
 * it read as "slow" for a while. That is 19.2 percent of the estimated 719 million rows. A
 * pipeline that can only speak to an index can address two chains, and the L0 contract is
 * defined over four.
 *
 * WHAT A CHAIN WITH NO ADEQUATE READER GETS. Not silence. L0-8 is explicit that an absence of
 * rows is not an absence of events, so a chain this pipeline cannot read adequately records a
 * capture with status `capability_gap` naming what is missing, and claims no coverage. The
 * difference between "nothing happened" and "nobody looked" is the entire point of the coverage
 * ledger, and a chain quietly skipped is the worst possible way to lose it.
 *
 * ASSURANCE IS DECIDED HERE, NOT GUESSED DOWNSTREAM. L0-7 grades a capture by how many
 * independent sources enumerated it:
 *   A   Two independent sources enumerated this range and returned identical results.
 *   B   One enumerated it and a second independent source confirmed it is not incomplete in a way
 *       that source could detect. A confirmer that truncates silently can REFUTE an emptiness
 *       claim; it can never establish one.
 *   C   One source only. No independent confirmation was available for this range.
 * A disagreement between two sources is a RESULT and is recorded as one. It is never resolved by
 * taking a majority quietly, and the union is kept because a find is sound while a miss is not.
 */

import { CONFIG } from "./config.js";
import { log } from "./log.js";
import { rpcCall } from "./rpc.js";
import { normaliseChunk } from "./normalise.js";
import { fetchRange as hsFetchRange, getChainTip as hsChainTip, hasHypersync } from "./hypersync.js";
import type { Assurance, ChunkResult, FetchResult, NetworkConfig } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const hexBlock = (n: number): string => "0x" + n.toString(16);

/** Which reader will be used for this chain, and why, for the run log and the coverage row. */
export function readerFor(network: NetworkConfig): { kind: "index" | "rpc" | "none"; id: string; reason: string } {
  if (hasHypersync(network)) {
    return {
      kind: "index",
      id: `hypersync:${new URL(network.readers.hypersyncUrl as string).host}`,
      reason: "a HyperSync index serves this chain",
    };
  }
  if (network.readers.rpcUrls.length > 0) {
    return {
      kind: "rpc",
      id: `rpc:${network.readers.rpcUrls.map((u) => new URL(u).host).join("+")}`,
      reason: "no HyperSync index resolves for this chain, so logs are enumerated over JSON-RPC",
    };
  }
  return { kind: "none", id: "none", reason: "no reader of any kind is configured for this chain" };
}

/** Chain head from whichever reader this chain has. */
export async function getChainTip(network: NetworkConfig): Promise<number | null> {
  if (hasHypersync(network)) return hsChainTip(network);

  const heads: number[] = [];
  for (const url of network.readers.rpcUrls) {
    const r = await rpcCall(url, "eth_blockNumber", []);
    if (!r.ok) continue;
    const n = Number(BigInt(String(r.result)));
    // Number.isFinite rather than a successful call, because an endpoint in this project has been
    // measured answering eth_blockNumber with a value that parses to NaN, and a guard counting
    // ANSWERS rather than USABLE answers produced reads at a block that does not exist.
    if (Number.isFinite(n)) heads.push(n);
    await sleep(CONFIG.RPC_PAUSE_MS);
  }
  if (heads.length === 0) return null;
  // The MINIMUM, because the head every endpoint can already serve is the only one that all of
  // them can answer about. Heads never agree exactly across endpoints: the chain advances between
  // two HTTP calls, so requiring identical heads never succeeds.
  return Math.min(...heads);
}

/** One endpoint's answer for one window, with errors counted separately from results. */
interface EndpointAnswer {
  url: string;
  ok: boolean;
  logs: any[];
  error: string | null;
}

async function getLogsFrom(
  url: string,
  addresses: string[],
  from: number,
  to: number
): Promise<EndpointAnswer> {
  const r = await rpcCall(url, "eth_getLogs", [{
    address: addresses.length === 1 ? addresses[0] : addresses,
    fromBlock: hexBlock(from),
    toBlock: hexBlock(to),
  }]);
  if (!r.ok) return { url, ok: false, logs: [], error: r.error ?? "unknown" };
  if (!Array.isArray(r.result)) return { url, ok: false, logs: [], error: "non-array result" };
  return { url, ok: true, logs: r.result, error: null };
}

/** The identity of a log, for comparing two endpoints' answers without comparing their renderings. */
const logIdentity = (l: any): string =>
  `${String(l.transactionHash).toLowerCase()}|${Number(l.logIndex)}`;

/**
 * One call, tried across the available endpoints in rotation, with bounded retries.
 *
 * WHY ROTATION RATHER THAN A PREFERRED ENDPOINT. Hydrating a chunk is two calls per transaction
 * plus one per block, so a range with a few hundred logs is hundreds of requests, and sending all
 * of them to whichever endpoint answered first exhausts that endpoint's quota and fails the whole
 * chunk. Measured: a 200-block Ethereum range holding 13 logs exhausted one explorer's published
 * limit and returned HTTP 429 part way through hydration, which correctly failed the capture but
 * for a reason that is avoidable. Rotating halves the per-endpoint rate with two endpoints and
 * gives a retry somewhere else to go.
 *
 * A NULL IS A NEGATIVE, NOT AN ANSWER, and is retried on another endpoint before being believed.
 * Several endpoints in this set PRUNE THE TRANSACTION INDEX and return null for real mined
 * transactions, and one has been measured returning the transaction while returning null for its
 * receipt. A helper that falls through only on exceptions records that null as an absence.
 */
async function callRotating(
  urls: string[],
  startAt: number,
  method: string,
  params: unknown[]
): Promise<{ ok: boolean; result: any; url: string | null; errors: string[] }> {
  const errors: string[] = [];
  const attempts = Math.max(urls.length, 1) * 2;
  for (let i = 0; i < attempts; i++) {
    const url = urls[(startAt + i) % urls.length];
    const r = await rpcCall(url, method, params);
    if (r.ok && r.result !== null && r.result !== undefined) return { ok: true, result: r.result, url, errors };
    errors.push(`${new URL(url).host}: ${r.ok ? "null result, recorded as a negative requiring confirmation" : r.error}`);
    // Back off further on a rate limit, because retrying a quota immediately is how a bounded
    // retry becomes a guaranteed failure.
    const rateLimited = !r.ok && /HTTP_429/.test(String(r.error));
    await sleep(rateLimited ? CONFIG.RPC_PAUSE_MS * 8 : CONFIG.RPC_PAUSE_MS);
  }
  return { ok: false, result: null, url: null, errors };
}

/**
 * Fetch every log for `addresses` over a block range, by JSON-RPC, for a chain with no index.
 *
 * Shaped around three measured facts about these endpoints:
 *   One chain here caps by RESULT SIZE rather than by block span, refusing a wide window with
 *   "Too many logs requested" rather than truncating, so the chunk size is a measured workable
 *   window and an over-large answer is a chunk failure rather than a silent short read.
 *   An empty answer is a NEGATIVE, never a result. Errors are counted separately from results,
 *   because a range-too-large error renders as "nothing found" to anything that does not.
 *   Two endpoints are queried where two exist, and their answers are compared by log IDENTITY
 *   rather than by raw JSON, because two correct endpoints can render the same log differently.
 */
export async function rpcFetchRange(
  network: NetworkConfig,
  addresses: string[],
  fromBlock: number,
  toBlock: number,
  onChunk: (chunk: ChunkResult) => Promise<void>
): Promise<FetchResult> {
  const urls = network.readers.rpcUrls;
  const sourceId = `rpc:${urls.map((u) => new URL(u).host).join("+")}`;
  const chunkSize = network.chunkBlocks;

  const chunks: { from: number; to: number }[] = [];
  for (let lo = fromBlock; lo <= toBlock; lo += chunkSize) {
    chunks.push({ from: lo, to: Math.min(lo + chunkSize - 1, toBlock) });
  }

  const result: FetchResult = {
    fromBlock, toBlock,
    chunksPlanned: chunks.length, chunksOk: 0,
    skipped: [], errors: [], emptyChunks: [],
    logsSeen: 0, complete: false,
    sourceKind: "rpc", sourceId,
    // Starts at the number configured and is lowered by any chunk that fewer endpoints
    // enumerated identically. The MINIMUM across chunks, because a capture is only as confirmed
    // as its worst covered chunk.
    enumeratingSources: urls.length,
    headAtCapture: await getChainTip(network),
    rollbackGuards: [],
  };

  log.info(`RPC fetch plan: ${chunks.length} chunk(s) of ${chunkSize} blocks over ${fromBlock}..${toBlock}`, {
    network: network.name, endpoints: urls, addresses,
  });

  const deadline = Date.now() + CONFIG.HS_RANGE_DEADLINE_MS;

  for (const c of chunks) {
    if (Date.now() > deadline) {
      result.skipped.push([c.from, c.to]);
      result.errors.push(`RPC_RANGE_DEADLINE: blocks ${c.from}..${c.to} not attempted`);
      continue;
    }

    const answers: EndpointAnswer[] = [];
    for (const url of urls) {
      answers.push(await getLogsFrom(url, addresses, c.from, c.to));
      await sleep(CONFIG.RPC_PAUSE_MS);
    }

    const good = answers.filter((a) => a.ok);
    if (good.length === 0) {
      result.skipped.push([c.from, c.to]);
      result.errors.push(
        `chunk ${c.from}..${c.to}: every endpoint failed | ` +
        answers.map((a) => `${a.url}: ${a.error}`).join(" | ")
      );
      continue;
    }

    // A result larger than the measured per-response cap is a truncation, not an answer. An
    // endpoint that truncates silently makes a short read indistinguishable from a real count.
    const cap = network.readers.rpcLogResultCap;
    const truncated = cap !== null && good.some((a) => a.logs.length >= cap);
    if (truncated) {
      result.skipped.push([c.from, c.to]);
      result.errors.push(
        `chunk ${c.from}..${c.to}: an endpoint returned ${Math.max(...good.map((a) => a.logs.length))} logs ` +
        `against a measured per-response cap of ${cap}, so the answer may be truncated and is refused`
      );
      continue;
    }

    // Compare by identity, take the union, and record a disagreement rather than resolving it.
    const byId = new Map<string, any>();
    for (const a of good) for (const l of a.logs) byId.set(logIdentity(l), l);
    const sets = good.map((a) => new Set(a.logs.map(logIdentity)));
    const identical = good.length >= 2 && sets.every((s) => s.size === byId.size);
    // How many sources independently enumerated THIS chunk and agreed. One endpoint answering
    // while another errors is ONE source, not two, and grading it as two would claim a
    // confirmation that never happened.
    result.enumeratingSources = Math.min(result.enumeratingSources, identical ? good.length : 1);

    // A DISAGREEMENT AND A SINGLE ANSWER ARE DIFFERENT FACTS and must not share a label. The
    // first version of this wrote ":disagreed" onto the source id whenever the answers were not
    // identical, which includes the case where only one endpoint answered at all. That is not a
    // disagreement, it is a missing second opinion, and recording it as the former puts a wrong
    // fact on every row the chunk produced. Both are now recorded, separately and by name.
    const disagreed = good.length >= 2 && !identical;
    if (disagreed) {
      result.errors.push(
        `chunk ${c.from}..${c.to}: ENDPOINT_DISAGREEMENT, ` +
        good.map((a) => `${new URL(a.url).host}=${a.logs.length}`).join(" ") +
        `, union=${byId.size}. The union is kept because a find is sound and a miss is not, ` +
        `and this capture is graded C.`
      );
    } else if (good.length < urls.length) {
      result.errors.push(
        `chunk ${c.from}..${c.to}: only ${good.length} of ${urls.length} endpoint(s) answered, so ` +
        `this range has no independent confirmation | ` +
        answers.filter((a) => !a.ok).map((a) => `${new URL(a.url).host}: ${a.error}`).join(" | ")
      );
    }

    const logs = [...byId.values()];
    const blockNumbers = [...new Set(logs.map((l) => Number(l.blockNumber)))];
    const txHashes = [...new Set(logs.map((l) => String(l.transactionHash).toLowerCase()))];

    const hydrationUrls = good.map((a) => a.url);
    const blocks: any[] = [];
    let hydrationFailed: string | null = null;
    let call = 0;

    for (const bn of blockNumbers) {
      const r = await callRotating(hydrationUrls, call++, "eth_getBlockByNumber", [hexBlock(bn), false]);
      if (!r.ok) { hydrationFailed = `block ${bn}: ${r.errors.join(" | ")}`; break; }
      blocks.push({ number: Number(r.result.number), hash: r.result.hash, timestamp: Number(r.result.timestamp) });
    }

    const transactions: any[] = [];
    if (!hydrationFailed) {
      for (const h of txHashes) {
        const tx = await callRotating(hydrationUrls, call++, "eth_getTransactionByHash", [h]);
        const rc = await callRotating(hydrationUrls, call++, "eth_getTransactionReceipt", [h]);
        if (!tx.ok || !rc.ok) {
          hydrationFailed = `tx ${h}: ${[...tx.errors, ...rc.errors].join(" | ")}`;
          break;
        }
        transactions.push({
          hash: tx.result.hash,
          blockNumber: Number(tx.result.blockNumber),
          blockHash: tx.result.blockHash,
          transactionIndex: Number(tx.result.transactionIndex),
          from: tx.result.from,
          to: tx.result.to,
          value: BigInt(tx.result.value ?? "0x0").toString(),
          nonce: BigInt(tx.result.nonce ?? "0x0").toString(),
          gas: BigInt(tx.result.gas ?? "0x0").toString(),
          input: tx.result.input,
          kind: tx.result.type === undefined || tx.result.type === null ? null : Number(tx.result.type),
          status: rc.result.status === undefined || rc.result.status === null ? null : Number(rc.result.status),
          gasUsed: BigInt(rc.result.gasUsed ?? "0x0").toString(),
          effectiveGasPrice: rc.result.effectiveGasPrice ? BigInt(rc.result.effectiveGasPrice).toString() : null,
          contractAddress: rc.result.contractAddress ?? null,
        });
      }
    }

    if (hydrationFailed) {
      // A chunk whose logs were read but whose blocks or transactions could not be is INCOMPLETE,
      // not partially usable. block_timestamp is the partitioning column and is NOT NULL, so half
      // a chunk cannot be written, and writing the logs while dropping the transactions would
      // make the Transactions table's own definition false.
      result.skipped.push([c.from, c.to]);
      result.errors.push(`chunk ${c.from}..${c.to}: HYDRATION_FAILED ${hydrationFailed}`);
      continue;
    }

    const chunk: ChunkResult = {
      fromBlock: c.from, toBlock: c.to, ok: true,
      logs: logs.map((l) => ({
        blockNumber: Number(l.blockNumber),
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
        transactionIndex: Number(l.transactionIndex),
        logIndex: Number(l.logIndex),
        address: l.address,
        data: l.data,
        topics: Array.isArray(l.topics) ? l.topics : [],
        removed: typeof l.removed === "boolean" ? l.removed : null,
      })),
      transactions, blocks,
      nextBlock: c.to + 1, archiveHeight: result.headAtCapture,
      rollbackGuard: null,
      sourceKind: "rpc",
      // The exact reader, and only the readers that actually answered. A chunk answered by one
      // endpoint names that endpoint rather than the pair, because reader behaviour is a moving
      // property and which reader answered has to be true on the row.
      sourceId: disagreed
        ? `${sourceId}:disagreed`
        : `rpc:${good.map((a) => new URL(a.url).host).join("+")}`,
      attempts: [], ms: 0,
    };
    normaliseChunk(chunk);

    result.chunksOk += 1;
    result.logsSeen += chunk.logs.length;
    if (chunk.logs.length === 0) result.emptyChunks.push([c.from, c.to]);
    await onChunk(chunk);
  }

  result.complete = result.skipped.length === 0;
  return result;
}

/** Dispatch to whichever reader this chain has. */
export function fetchRange(
  network: NetworkConfig,
  addresses: string[],
  fromBlock: number,
  toBlock: number,
  onChunk: (chunk: ChunkResult) => Promise<void>
): Promise<FetchResult> {
  if (hasHypersync(network)) return hsFetchRange(network, addresses, fromBlock, toBlock, onChunk);
  if (network.readers.rpcUrls.length > 0) return rpcFetchRange(network, addresses, fromBlock, toBlock, onChunk);
  throw new Error(`NO_READER: ${network.name} has neither a HyperSync index nor a JSON-RPC endpoint configured`);
}

/**
 * The assurance grade this capture earned.
 *
 * L0-7, applied literally, and deliberately conservative in every direction, because a grade that
 * is too high is invisible downstream: a model aggregating across grades must report the mix or
 * filter to one, and it can only do that if the grades are honest.
 *
 * TWO DEFECTS IN THE FIRST VERSION OF THIS FUNCTION, BOTH FOUND BY RUNNING IT AND BOTH RECORDED
 * HERE RATHER THAN QUIETLY CORRECTED.
 *
 *   It graded `refuted_emptiness` as B. That value means a second source FOUND logs in a range the
 *   primary reported empty, so the primary demonstrably missed data. Reading a refutation as
 *   confirmation is the most dangerous possible direction for this function to be wrong in.
 *
 *   It granted A to any RPC capture on a chain with two endpoints CONFIGURED, rather than two that
 *   actually answered every chunk identically. A configured endpoint that errors is not a second
 *   source. The reader now reports how many sources genuinely enumerated the range and this uses
 *   that number.
 *
 * A NOTE ON WHAT THIS MEANS IN PRACTICE, because it is counterintuitive and worth stating. A
 * complete HyperSync capture with nothing to confirm earns C, because one index is one source. A
 * complete RPC capture on a chain with two agreeing operators earns A. So the two chains with no
 * HyperSync index can reach a HIGHER grade than the two with one. That is not a bug, it is the
 * definition: assurance measures independent confirmation, not reader quality. Raising the index
 * chains to B means confirming non-empty ranges against a second source, which is real cost and
 * is not in this package.
 */
export function gradeCapture(
  network: NetworkConfig,
  fetch: FetchResult,
  confirmationResult: string
): Assurance {
  if (!fetch.complete) return "C";
  if (confirmationResult === "refuted_emptiness" || confirmationResult === "disagreed") return "C";
  if (!network.readers.hasIndependentConfirmingReader) return "C";
  // A: two independent sources enumerated this range and returned identical results.
  if (fetch.enumeratingSources >= 2) return "A";
  // B: one enumerated, and a second independent source confirmed the result is not incomplete in
  // a way that source could detect. That is what a confirmed empty range is, and no more.
  if (confirmationResult === "identical") return "B";
  return "C";
}
