/**
 * coverage.ts -- the resume point and the repair list, both computed from IngestionCoverage.
 *
 * WHY THE WATERMARK WENT. Resume used to be MAX(block_number) over the data table. That number
 * means "the furthest row I happen to hold", and a number like that CANNOT REPRESENT A HOLE. This
 * pipeline has already created one: a failed chunk is recorded in `skipped` and the loop
 * CONTINUES, later chunks are written to the table during the fetch, and the throw comes after
 * those writes, so the next run resumes from a block above the gap and never looks at it again.
 * Measured on a seeded example: a hole at blocks 200 to 299 with clean captures either side gives
 * MAX(block_number) = 301, which is past the hole, while the rule below gives 199, which is at
 * the edge of the last clean capture, so the hole is re-read.
 *
 * The error message on that throw says "the watermark has NOT been advanced". It refers to
 * IngestionStatus, which an exhaustive search of all 14 source files shows is written three times
 * and read zero times, and which bq.ts itself carried a comment saying cannot answer the resume
 * question. So the reassurance was true of a table nothing consults.
 *
 * WHAT COVERAGE IS ALLOWED TO CLAIM. L0-8: a block range with no coverage row WAS NEVER SCANNED.
 * The absence of a row is therefore not "probably fine", it is "unknown", and unknown resolves
 * downwards. This is the whole reason the ledger exists and it is why no rule here ever infers
 * coverage from the presence of data.
 *
 * WHY THE INTERVAL ARITHMETIC IS IN TYPESCRIPT RATHER THAN SQL. It is a handful of rows per
 * contract, so there is no performance argument, and doing it here makes the rule testable
 * without BigQuery at all. The version of this logic that lived in a query could only ever be
 * checked by running it against a warehouse.
 */

import { bqQuery, allHistory } from "./bq.js";
import { fullTableName, RAW_LOGS_TABLE } from "./config.js";
import { log } from "./log.js";
import { countUndecodableLogs, type DecodeCandidateLog, type ParsedEventSurface } from "./control-plane/index.js";

export interface CaptureInterval {
  fromBlock: number;
  toBlock: number;
  status: string;
  skipped: [number, number][];
  captureId: string | null;
  runId: string | null;
  startedAt: string | null;
}

/** A capture may be counted as covering its range only when it completed and skipped nothing. */
export function isClean(c: CaptureInterval): boolean {
  return c.status === "complete" && c.skipped.length === 0;
}

/** Parse the skipped_ranges JSON defensively. An unparsable value is a hole, never an absence. */
function parseSkipped(raw: unknown, captureId: string | null): [number, number][] {
  if (raw === null || raw === undefined || raw === "" || raw === "[]") return [];
  try {
    const v = JSON.parse(String(raw));
    if (!Array.isArray(v)) throw new Error("not an array");
    return v.map((p: any) => [Number(p[0]), Number(p[1])] as [number, number])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  } catch (e: any) {
    // A recorded skip that cannot be read is worse than one that can, so it is reported as a
    // single all-covering hole rather than dropped. Dropping it would turn a known gap into a
    // silent one, which is the exact failure this module exists to end.
    log.error(
      `Coverage row ${captureId ?? "(no capture id)"} has an unreadable skipped_ranges value, ` +
      `so its whole range is treated as skipped: ${e.message}`
    );
    return [[-Infinity, Infinity]];
  }
}

/**
 * Every capture recorded for one contract on one chain into one target table.
 *
 * Rows with a NULL chain_id are EXCLUDED, and that is deliberate rather than incidental. The ten
 * coverage rows already in production predate the chain_id column and describe the v3 domain
 * tables, not RawLogs. Treating them as coverage of the v4 target would claim a range that was
 * never read into it.
 */
export async function loadCoverage(
  chainId: number,
  targetTable: string,
  contractAddress: string
): Promise<CaptureInterval[]> {
  const rows = await bqQuery(
    `SELECT capture_id, run_id, from_block, to_block, status, skipped_ranges,
            FORMAT_TIMESTAMP('%FT%TZ', started_at) AS started
     FROM ${fullTableName("IngestionCoverage")}
     WHERE chain_id = @chainId
       AND target_table = @targetTable
       AND contract_address = @address
       AND from_block IS NOT NULL AND to_block IS NOT NULL
     ORDER BY from_block, started_at`,
    { chainId, targetTable, address: contractAddress.toLowerCase() }
  );

  return rows.map((r: any) => ({
    fromBlock: Number(r.from_block),
    toBlock: Number(r.to_block),
    status: String(r.status ?? ""),
    skipped: parseSkipped(r.skipped_ranges, r.capture_id ?? null),
    captureId: r.capture_id ?? null,
    runId: r.run_id ?? null,
    startedAt: r.started ?? null,
  }));
}

/** Merge overlapping and adjacent inclusive intervals. */
function mergeIntervals(iv: [number, number][]): [number, number][] {
  const s = iv.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Subtract a set of holes from a set of intervals. */
function subtract(iv: [number, number][], holes: [number, number][]): [number, number][] {
  let cur = iv;
  for (const [ha, hb] of holes) {
    const next: [number, number][] = [];
    for (const [a, b] of cur) {
      if (hb < a || ha > b) { next.push([a, b]); continue; }
      if (ha > a) next.push([a, Math.min(b, ha - 1)]);
      if (hb < b) next.push([Math.max(a, hb + 1), b]);
    }
    cur = next;
  }
  return mergeIntervals(cur);
}

export interface ResumePoint {
  resumeAt: number;
  /**
   * The last block coverage vouches for CONTIGUOUSLY from the contract's creation block, or null
   * when nothing does. Deliberately not "the highest block held": a clean capture above a hole
   * vouches for its own range and for nothing between, and reading this field as a frontier is
   * what let an internal hole pass for covered ground.
   */
  coveredUpTo: number | null;
  reason: string;
  capturesConsidered: number;
  capturesClean: number;
  /** Every range inside the ledger's own envelope that no clean capture covers. */
  openGaps: [number, number][];
}

/**
 * Where an ingestion of this contract should start.
 *
 * THE RULE. The highest block below which coverage is contiguous from the contract's own creation
 * block AND carries no skip. Resume is AT that block rather than one past it, because re-reading
 * one block is free under MERGE and the predecessor's "+1" is exactly how the tail of three
 * blocks was lost permanently.
 *
 * WHAT IT DOES WHEN COVERAGE IS EMPTY, which is a real case and not a hypothetical. Production
 * holds ten coverage rows covering about 150,000 blocks of a table spanning 9.4 million, and none
 * of them names a chain id or the v4 target, so for RawLogs the ledger is empty today. The answer
 * is the contract's own creation block, and the cost of that answer is stated plainly: the first
 * run after this change wants a backfill rather than a daily increment. That is A5's job, MERGE
 * makes the re-read produce no duplicates, and the alternative, inferring coverage from the rows
 * that happen to be present, is precisely the defect this module replaces. An honest expensive
 * answer beats a cheap one that cannot represent a hole.
 */
export function computeResumePoint(captures: CaptureInterval[], firstBlock: number): ResumePoint {
  const gaps = openGaps(captures);
  const gapNote = gaps.length === 0
    ? ""
    : `. ${gaps.length} open gap(s) below the newest recorded block: ` +
      gaps.map(([a, b]) => `${a}..${b}`).join(", ");

  const clean = captures.filter(isClean);
  if (clean.length === 0) {
    return {
      resumeAt: firstBlock,
      coveredUpTo: null,
      reason:
        (captures.length === 0
          ? "no coverage row exists for this contract, so no range has been read into this target"
          : `all ${captures.length} coverage row(s) are incomplete, skipped or a capability gap`) + gapNote,
      capturesConsidered: captures.length,
      capturesClean: 0,
      openGaps: gaps,
    };
  }

  const merged = mergeIntervals(clean.map((c) => [c.fromBlock, c.toBlock] as [number, number]));
  const covering = merged.find(([a, b]) => a <= firstBlock && b >= firstBlock);
  if (!covering) {
    return {
      resumeAt: firstBlock,
      coveredUpTo: null,
      reason: `no clean capture covers the contract's creation block ${firstBlock}` + gapNote,
      capturesConsidered: captures.length,
      capturesClean: clean.length,
      openGaps: gaps,
    };
  }

  return {
    resumeAt: covering[1],
    coveredUpTo: covering[1],
    reason: `coverage is contiguous and clean from ${firstBlock} to ${covering[1]}` + gapNote,
    capturesConsidered: captures.length,
    capturesClean: clean.length,
    openGaps: gaps,
  };
}

/** A row describes a real range only when its end is at or above its start. */
function describesARange(c: CaptureInterval): boolean {
  return c.toBlock >= c.fromBlock;
}

/**
 * Every range inside the ledger's own envelope that is not covered by a clean capture.
 *
 * This is what repair works from, and it is the thing that made the field worth writing. Before
 * this, `skipped_ranges` was written in three places and read in none, which means the pipeline
 * recorded its own holes and then had no way to act on them.
 *
 * THREE REASONS A RANGE APPEARS HERE, AND THE THIRD IS FINDING H3. The first two were here
 * already: a capture SKIPPED the range, or a capture's status is anything other than complete.
 * Both are holes somebody recorded. The third is the hole nobody recorded -- a range inside the
 * span this ledger describes that NO capture row mentions at all.
 *
 * H3 is exactly that case and it was invisible: clean captures of 100..199 and 300..399 leave
 * 200..299 read by nobody, and because no failed capture ever described it, it could not enter a
 * candidate list built only from recorded failures. `coverage` printed clean and `repair` had
 * nothing to act on. The module's own rule decides it -- L0-8 says a block range with no coverage
 * row WAS NEVER SCANNED, so an unmentioned interior range is unknown, and unknown resolves
 * downwards.
 *
 * THE ENVELOPE IS THE BOUND, and it is what keeps this from reporting the whole chain. Blocks
 * above the newest recorded block are not a gap: nobody has claimed to read them and the resume
 * point is the thing that says where to start. Only the INTERIOR of what the ledger describes is
 * ground it has implicitly claimed by stepping over. Rows that describe no range at all -- a
 * `nothing_to_fetch` row records `toBlock` below `fromBlock` -- are excluded from the envelope
 * entirely, because letting one widen it would manufacture an enormous gap out of an empty read.
 *
 * A range disappears from this list when a LATER clean capture covers it, so a gap that has
 * already been repaired is not repaired again.
 */
export function openGaps(captures: CaptureInterval[]): [number, number][] {
  const suspect: [number, number][] = [];
  for (const c of captures) {
    for (const [a, b] of c.skipped) {
      // An unreadable skipped_ranges value produced an infinite hole; clamp it to the capture's
      // own range, which is the largest thing it could honestly mean.
      suspect.push([Math.max(a, c.fromBlock), Math.min(b, c.toBlock)]);
    }
    if (c.status !== "complete") suspect.push([c.fromBlock, c.toBlock]);
  }

  // H3: the interior of the envelope that no coverage row describes.
  const described = captures.filter(describesARange);
  if (described.length > 0) {
    const envelope: [number, number] = [
      Math.min(...described.map((c) => c.fromBlock)),
      Math.max(...described.map((c) => c.toBlock)),
    ];
    const covered = mergeIntervals(described.map((c) => [c.fromBlock, c.toBlock] as [number, number]));
    suspect.push(...subtract([envelope], covered));
  }

  if (suspect.length === 0) return [];

  const cleanCover = mergeIntervals(captures.filter(isClean).map((c) => [c.fromBlock, c.toBlock] as [number, number]));
  return subtract(mergeIntervals(suspect), cleanCover);
}

// --------------------------------------------------------------------------- decode coverage

/**
 * DECODE COVERAGE, WHICH IS A DIFFERENT QUESTION FROM BLOCK COVERAGE (plan 5.2.1).
 *
 * Everything above answers "what did we read". None of it answers "what could we decode". Those
 * come apart whenever a log's `topic0` matches no entry in its address's event surface: the row is
 * present, correct and raw, and every downstream model that selects on an event name skips it. An
 * undecodable log and an absent one are indistinguishable once the query has run, and the
 * magnitude tripwire does not help -- it catches a wrong value, not a missing row.
 *
 * So the count is REPORTED beside block coverage rather than inferred from it. The classifier is
 * `countUndecodableLogs` in `control-plane/decodeSurface.ts`; this is the reporting half.
 */

/** One `(chain, address, topic0)` group and how many rows carry it. */
export interface DecodeLogGroup {
  chainId: number;
  address: string;
  topic0: string | null;
  rows: number;
}

export interface DecodeCoverageRow {
  chainId: number;
  address: string;
  /** Rows whose topic0 could be compared against the surface at all. */
  rowsConsidered: number;
  rowsUndecodable: number;
  unmatchedTopic0s: readonly string[];
  addressHasNoSurface: boolean;
}

export interface DecodeCoverage {
  byContract: DecodeCoverageRow[];
  rowsConsidered: number;
  rowsUndecodable: number;
  /**
   * ROWS this report could not classify, counted separately from the result and never folded into
   * `rowsUndecodable`. A null `topic0` on a non-anonymous log means the row is unreadable, not
   * that its event is unknown. An undecodable count of zero is a measurement only when this is
   * zero too.
   */
  errors: number;
  errorDetail: string[];
}

/**
 * Turn grouped rows into a decode-coverage report.
 *
 * WHY THE GROUPS ARE WEIGHTED HERE RATHER THAN EXPANDED. `countUndecodableLogs` takes one entry
 * per log, and the warehouse holds hundreds of millions of them against at most a few hundred
 * distinct `(chain, address, topic0)` keys. Expanding a GROUP BY back into rows to feed a counter
 * that would immediately re-aggregate them is arithmetic for its own sake. So the classifier is
 * asked the question it is the authority on -- WHICH topic0 values match no surface entry -- and
 * the row weights are applied here, where they came from. The classification is not re-derived.
 */
export function weightDecodeCoverage(
  groups: readonly DecodeLogGroup[],
  surface: ParsedEventSurface,
): DecodeCoverage {
  const candidates: DecodeCandidateLog[] = groups.map((g) => ({
    chainId: g.chainId, address: g.address, topic0: g.topic0,
  }));
  const classified = countUndecodableLogs(candidates, surface);

  const key = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;
  const unmatchedByContract = new Map<string, Set<string>>();
  for (const c of classified.byContract) {
    unmatchedByContract.set(key(c.chainId, c.address), new Set(c.unmatchedTopic0s.map((t) => t.toLowerCase())));
  }

  const byContract: DecodeCoverageRow[] = [];
  let rowsConsidered = 0;
  let rowsUndecodable = 0;
  let errors = 0;
  const errorDetail: string[] = [];

  for (const c of classified.byContract) {
    const k = key(c.chainId, c.address);
    const unmatched = unmatchedByContract.get(k) ?? new Set<string>();
    const mine = groups.filter((g) => key(g.chainId, g.address) === k);

    const considered = mine.filter((g) => g.topic0 !== null).reduce((n, g) => n + g.rows, 0);
    const undecodable = mine
      .filter((g) => g.topic0 !== null && unmatched.has(g.topic0.toLowerCase()))
      .reduce((n, g) => n + g.rows, 0);
    const unreadable = mine.filter((g) => g.topic0 === null).reduce((n, g) => n + g.rows, 0);

    rowsConsidered += considered;
    rowsUndecodable += undecodable;
    errors += unreadable;
    if (unreadable > 0) {
      errorDetail.push(
        `${k}: ${unreadable} row(s) carry no topic0, so they can be neither matched nor ruled out`
      );
    }

    byContract.push({
      chainId: c.chainId,
      address: c.address,
      rowsConsidered: considered,
      rowsUndecodable: undecodable,
      unmatchedTopic0s: c.unmatchedTopic0s,
      addressHasNoSurface: c.addressHasNoSurface,
    });
  }

  return { byContract, rowsConsidered, rowsUndecodable, errors, errorDetail };
}

/**
 * Read the `(chain, address, topic0)` groups one contract's captured logs fall into.
 *
 * Through the all-history view, because this question has no natural block window and a bare
 * GROUP BY straight at a `require_partition_filter` table is refused outright.
 */
export async function loadDecodeLogGroups(
  chainId: number,
  contractAddress: string,
): Promise<DecodeLogGroup[]> {
  const rows = await bqQuery(
    `SELECT chain_id, contract_address, topic0, COUNT(*) AS rows_held
     FROM ${allHistory(RAW_LOGS_TABLE)}
     WHERE chain_id = @chainId AND contract_address = @address
     GROUP BY chain_id, contract_address, topic0`,
    { chainId, address: contractAddress.toLowerCase() }
  );

  return rows.map((r: any) => ({
    chainId: Number(r.chain_id),
    address: String(r.contract_address ?? "").toLowerCase(),
    topic0: r.topic0 === null || r.topic0 === undefined ? null : String(r.topic0).toLowerCase(),
    rows: Number(r.rows_held),
  }));
}

/**
 * Decode coverage for one contract, or a stated reason it could not be measured.
 *
 * A query failure returns an error count rather than an empty report. The distinction is the
 * whole point of this module: "zero undecodable rows" and "the question could not be asked" must
 * never be the same answer.
 */
export async function loadDecodeCoverage(
  chainId: number,
  contractAddress: string,
  surface: ParsedEventSurface,
): Promise<DecodeCoverage> {
  try {
    return weightDecodeCoverage(await loadDecodeLogGroups(chainId, contractAddress), surface);
  } catch (e: any) {
    log.error(
      `Decode coverage for ${contractAddress} on chain ${chainId} could not be measured: ${e.message}`
    );
    return {
      byContract: [], rowsConsidered: 0, rowsUndecodable: 0, errors: 1,
      errorDetail: [`${chainId}:${contractAddress.toLowerCase()}: query failed: ${e.message}`],
    };
  }
}
