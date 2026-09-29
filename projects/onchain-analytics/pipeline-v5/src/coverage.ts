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

import { bqQuery } from "./bq.js";
import { fullTableName } from "./config.js";
import { log } from "./log.js";

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
  /** The last block this contract's coverage actually vouches for, or null when none does. */
  coveredUpTo: number | null;
  reason: string;
  capturesConsidered: number;
  capturesClean: number;
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
  const clean = captures.filter(isClean);
  if (clean.length === 0) {
    return {
      resumeAt: firstBlock,
      coveredUpTo: null,
      reason:
        captures.length === 0
          ? "no coverage row exists for this contract, so no range has been read into this target"
          : `all ${captures.length} coverage row(s) are incomplete, skipped or a capability gap`,
      capturesConsidered: captures.length,
      capturesClean: 0,
    };
  }

  const merged = mergeIntervals(clean.map((c) => [c.fromBlock, c.toBlock] as [number, number]));
  const covering = merged.find(([a, b]) => a <= firstBlock && b >= firstBlock);
  if (!covering) {
    return {
      resumeAt: firstBlock,
      coveredUpTo: null,
      reason: `no clean capture covers the contract's creation block ${firstBlock}`,
      capturesConsidered: captures.length,
      capturesClean: clean.length,
    };
  }

  return {
    resumeAt: covering[1],
    coveredUpTo: covering[1],
    reason: `coverage is contiguous and clean from ${firstBlock} to ${covering[1]}`,
    capturesConsidered: captures.length,
    capturesClean: clean.length,
  };
}

/**
 * Every range that was attempted and is not now covered by a clean capture.
 *
 * This is what repair works from, and it is the thing that made the field worth writing. Before
 * this, `skipped_ranges` was written in three places and read in none, which means the pipeline
 * recorded its own holes and then had no way to act on them.
 *
 * A range appears here when a capture skipped it, or when a capture's status is anything other
 * than complete. It disappears when a LATER clean capture covers it, so a gap that has already
 * been repaired is not repaired again.
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
  if (suspect.length === 0) return [];

  const cleanCover = mergeIntervals(captures.filter(isClean).map((c) => [c.fromBlock, c.toBlock] as [number, number]));
  return subtract(mergeIntervals(suspect), cleanCover);
}
