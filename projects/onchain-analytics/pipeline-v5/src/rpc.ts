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
import { getRpcTransport } from "./adapters.js";
import type { NetworkConfig } from "./types.js";

let idCounter = 0;

/**
 * R4, in one place: a value is a measurement only when at least two independent endpoints return
 * it. One endpoint's answer is a claim about that endpoint, and this project has measured what
 * such claims are worth.
 */
export const MIN_INDEPENDENT_ENDPOINTS = 2;

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
    // Through the transport adapter rather than global fetch, so a test can read the exact
    // envelope this call puts on the wire. SA-C7 was a defect that only exists on the wire: a
    // read the caller believed was pinned sent `latest`, and no return value could show it.
    const res = await getRpcTransport()(url, {
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

/**
 * What a log-scan answer is worth AS EVIDENCE, carried on the answer rather than decided by
 * whoever happens to read it.
 *
 * FINDING C6 is that an RPC absence was treated as admissible at one call site and nowhere else,
 * so the judgement lived in a conditional instead of on the value. A grade refused at one call
 * site is refused only there; a grade carried on the answer travels with it into the coverage
 * ledger, and downstream can read WHY a range is recorded the way it is.
 */
export type LogEvidenceGrade =
  /** Logs were found. A find is sound while a miss is not, so this is the one sound direction. */
  | "refutation"
  /** Two or more independent endpoints each covered the whole range without error and found nothing. */
  | "corroborated_absence"
  /** Exactly one endpoint covered the whole range without error and found nothing. */
  | "single_source_absence"
  /** No endpoint covered the whole range without an error, so nothing was established either way. */
  | "no_clean_answer";

export interface LogEvidence {
  grade: LogEvidenceGrade;
  /**
   * ALWAYS false. It is the literal type rather than `boolean` so that no consumer can ever
   * branch on a log scan having proved an absence, and so that anyone trying to gets a compile
   * error rather than a plausible run.
   *
   * R7 of the binding verification standard: log absence is not evidence of absence, at any
   * repetition count, on any endpoint. Corroboration by a second endpoint raises how well
   * attested a NON-OBSERVATION is. It never converts one into a measurement.
   */
  readonly admissibleAsAbsence: false;
  /** True only for a refutation, which is the only claim a log scan can actually support. */
  admissibleAsRefutation: boolean;
  /** Endpoints that covered EVERY sub-range without a single error. */
  cleanEndpoints: number;
  /** Of those, how many found nothing at all. */
  cleanEndpointsFindingNothing: number;
  /** The rule the grade was assigned under, so a reader can check it instead of trusting it. */
  standard: string;
}

/** One endpoint's behaviour over the probed range, with results and failures never conflated. */
export interface EndpointTally {
  url: string;
  /** Sub-ranges this endpoint answered with an empty array. A ZERO IS AN ANSWER, not a failure. */
  zeroAnswers: number;
  /** Sub-ranges this endpoint answered with at least one log. */
  nonZeroAnswers: number;
  /** Sub-ranges this endpoint failed outright. Counted separately from results, always. */
  failures: number;
  /** Logs this endpoint saw across the whole range. A floor, never a count. */
  found: number;
}

export interface LogProbe {
  ok: boolean;
  /** Total logs found across every sub-range that succeeded. A floor, never a count. */
  found: number;
  /** Endpoints that answered every sub-range without error. */
  answeredFully: string[];
  errors: string[];
  subRanges: number;
  /**
   * Sub-ranges answered with zero logs, per endpoint url.
   *
   * FINDING SA-C8. The tally used to be `{ found, failures }`, in which an endpoint answering
   * zero is indistinguishable from one answering with rows: both leave `failures` at 0 and only
   * `found` moves, and `found` is summed across endpoints. That is the exact signal a false zero
   * produces, and forno's false-zero rate on this project was measured between 20 and 90 percent
   * depending on range age with no error raised on any occasion. A tally that cannot see a false
   * zero cannot report one.
   */
  zeroLogAnswers: Record<string, number>;
  /** The full per-endpoint tally the counts above are taken from. */
  perEndpoint: EndpointTally[];
  /**
   * Endpoints that answered zero on a sub-range where another endpoint found logs, with no error
   * raised. This is a false zero caught in the act, and it is named rather than averaged away.
   */
  falseZeroSuspects: string[];
  /** What this answer is worth as evidence. See `LogEvidence`. */
  evidence: LogEvidence;
}

/**
 * Ask independent RPC sources whether a block range really is empty.
 *
 * This is used ONLY to refute an emptiness claim, never to establish one. Finding one log
 * refutes "there are none", and a refutation from a log query is sound. A second zero proves
 * nothing and is reported as such: `ok` means the probe ran cleanly, not that the range is
 * empty. The grade on `evidence` says which of those happened.
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
  const perEndpoint = new Map<string, EndpointTally>();
  // Logs seen per endpoint per sub-range, null where the sub-range failed. Kept because a false
  // zero is only visible by comparing the SAME sub-range across endpoints: an endpoint whose
  // total is zero while another's total is not may simply have been asked different questions.
  const perRange = new Map<string, (number | null)[]>();

  for (const url of network.readers.rpcUrls) {
    perEndpoint.set(url, { url, zeroAnswers: 0, nonZeroAnswers: 0, failures: 0, found: 0 });
    perRange.set(url, []);
    for (const [lo, hi] of ranges) {
      const r = await rpcCall(url, "eth_getLogs", [{
        address: addresses.length === 1 ? addresses[0] : addresses,
        fromBlock: "0x" + lo.toString(16),
        toBlock: "0x" + hi.toString(16),
      }]);
      const e = perEndpoint.get(url)!;
      if (!r.ok) {
        e.failures += 1;
        perRange.get(url)!.push(null);
        errors.push(`${url} [${lo},${hi}]: ${r.error}`);
      } else if (Array.isArray(r.result)) {
        e.found += r.result.length;
        if (r.result.length === 0) e.zeroAnswers += 1; else e.nonZeroAnswers += 1;
        perRange.get(url)!.push(r.result.length);
      } else {
        e.failures += 1;
        perRange.get(url)!.push(null);
        errors.push(`${url} [${lo},${hi}]: non-array result`);
      }
      await sleep(CONFIG.RPC_PAUSE_MS);
    }
  }

  const tallies = [...perEndpoint.values()];
  const answeredFully = tallies.filter((e) => e.failures === 0).map((e) => e.url);
  const found = Math.max(0, ...tallies.map((e) => e.found));

  const falseZeroSuspects: string[] = [];
  for (const [url, seen] of perRange) {
    const caught = seen.some((n, i) =>
      n === 0 && [...perRange.entries()].some(([other, s]) => other !== url && (s[i] ?? 0) > 0));
    if (caught) falseZeroSuspects.push(url);
  }
  if (falseZeroSuspects.length > 0) {
    log.error(
      `FALSE ZERO IN THE TALLY: ${falseZeroSuspects.join(", ")} answered a sub-range of ` +
      `${fromBlock}..${toBlock} with zero logs, raising no error, while another endpoint found logs ` +
      `in that same sub-range`,
      { network: network.name, suspects: falseZeroSuspects }
    );
  }

  const cleanFindingNothing = tallies.filter((e) => e.failures === 0 && e.found === 0);
  const grade: LogEvidenceGrade =
    found > 0 ? "refutation"
      : answeredFully.length === 0 ? "no_clean_answer"
        : cleanFindingNothing.length >= MIN_INDEPENDENT_ENDPOINTS ? "corroborated_absence"
          : "single_source_absence";

  return {
    ok: answeredFully.length > 0,
    found,
    answeredFully,
    errors,
    subRanges: ranges.length,
    zeroLogAnswers: Object.fromEntries(tallies.map((e) => [e.url, e.zeroAnswers])),
    perEndpoint: tallies,
    falseZeroSuspects,
    evidence: {
      grade,
      admissibleAsAbsence: false,
      admissibleAsRefutation: grade === "refutation",
      cleanEndpoints: answeredFully.length,
      cleanEndpointsFindingNothing: cleanFindingNothing.length,
      standard:
        "verification-standard R7 (a log scan is never evidence of absence, at any endpoint " +
        "count) and R4 (a value is a measurement only when two independent endpoints return it)",
    },
  };
}

/**
 * Confirm that an empty HyperSync chunk really is empty.
 *
 * FINDING SA-C8. This used to require only `answeredFully.length > 0` and then render the
 * sentence "two sources agree the range is empty". That sentence is false whenever one source
 * answered, and one source's zero is a claim about that source: R4 says a value is a measurement
 * only when at least two independent endpoints return it, and forno -- frequently the only Celo
 * endpoint that answers an old range -- returns false zeros between 20 and 90 percent of the time
 * with no error raised.
 *
 * So confirmation now needs two independent endpoints that each covered the whole range without
 * a single error and each found nothing, and the rendered reason states the count it actually
 * observed rather than a fixed sentence.
 *
 * AN UNCONFIRMED EMPTY RANGE IS A NORMAL RESULT, not an error. It means nobody has corroborated
 * the emptiness yet, so the coverage frontier does not move past it and the range is read again.
 * The one thing that IS an error is a refutation, because that means the primary reader missed
 * data that exists.
 */
export async function confirmEmptyRange(
  network: NetworkConfig,
  addresses: string[],
  fromBlock: number,
  toBlock: number
): Promise<{ confirmed: boolean; reason: string; evidence: LogEvidence; probe: LogProbe }> {
  const probe = await probeLogsPresent(network, addresses, fromBlock, toBlock);

  if (probe.found > 0) {
    log.error(`FALSE ZERO CAUGHT: HyperSync reported no logs for ${fromBlock}..${toBlock}, RPC found ${probe.found}`, {
      network: network.name, endpoints: probe.answeredFully,
    });
    return {
      confirmed: false,
      reason: `REFUTED: an independent endpoint found ${probe.found} log(s) in a range HyperSync reported empty`,
      evidence: probe.evidence, probe,
    };
  }

  const clean = probe.evidence.cleanEndpointsFindingNothing;
  if (clean < MIN_INDEPENDENT_ENDPOINTS) {
    return {
      confirmed: false,
      reason:
        `UNCONFIRMED: ${clean} of ${network.readers.rpcUrls.length} endpoint(s) covered ` +
        `${fromBlock}..${toBlock} without error and found nothing, and ${MIN_INDEPENDENT_ENDPOINTS} ` +
        `independent endpoints are required, so the emptiness is a claim by ` +
        `${clean === 0 ? "no source that completed the range" : "one source"} rather than a corroborated one`,
      evidence: probe.evidence, probe,
    };
  }

  return {
    confirmed: true,
    // States what was observed and nothing beyond it. The previous sentence asserted agreement
    // between two sources on evidence that could be a single endpoint's clean pass.
    reason:
      `${clean} independent endpoints each covered ${fromBlock}..${toBlock} with zero errors and ` +
      `each found no logs. This CORROBORATES the emptiness; under R7 it does not prove it, and the ` +
      `range is recorded as a corroborated non-observation rather than a measured absence`,
    evidence: probe.evidence, probe,
  };
}
