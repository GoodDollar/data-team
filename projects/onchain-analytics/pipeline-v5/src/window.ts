/**
 * window.ts -- L0-9. The literal window every write puts on its target's partitioning column.
 *
 * THE RULE, AND WHY EACH PART OF IT IS THERE. All three facts below were measured on a fixture
 * built to the shipping column list, and each corresponds to a failure that is silent without it.
 *
 *   1. A MERGE with no predicate on the target SCANS THE WHOLE TARGET. Nothing about the
 *      statement looks wrong. At 719 million rows that is 0.3519 USD per run against 0.0280
 *      scoped, which is 3,083 USD a year against 245 at hourly ingestion. RawLogs and
 *      Transactions therefore carry require_partition_filter, which REFUSES the unscoped form.
 *
 *   2. THE WINDOW HAS TO BE A LITERAL, AND COMPUTING IT IS THE WRITING PROGRAM'S JOB. Deriving
 *      it inside the statement fails two ways and both were measured. A scalar subquery in the ON
 *      clause is refused by BigQuery itself, "Unsupported subquery with table in join predicate",
 *      on a guarded and an unguarded table alike. A predicate correlated to the source row is
 *      refused by the guard, because a filter depending on a joined row cannot eliminate a
 *      partition before the query runs. A scripting variable satisfies the guard but turns the
 *      submission into a statement of type SCRIPT, which retires the one mechanical check that
 *      catches a file that has run away into production. So the program computes it. This module
 *      is that computation.
 *
 *   3. THE PADDING IS NOT DECORATION AND IT HAS A MEASURED BOUND. A MERGE whose target window
 *      does not cover an already present row inserts a SECOND row under the same merge key. This
 *      is ordinary MERGE semantics rather than a side effect of the guard, and it reproduced on
 *      an unguarded table of the same shape. The case that makes padding necessary is a log that
 *      moves across a month boundary between two ingestions, which is what a reorganisation near
 *      a month end does: unpadded gave 2 rows under one key, padded gave 1.
 *      THE BOUND: one month of padding covers a displacement back to the start of the month
 *      BEFORE the source's own month, which is 31 to 62 days depending where in its month the
 *      source sits. A row displaced 95 days DUPLICATED. A re-read that rewrites a row's timestamp
 *      by more than that is a correction, not a reorganisation, and states its own window.
 *
 * WHERE THE TIMESTAMPS COME FROM, which is the question the window rule turns on.
 * They come from the rows being written. Every row carries the block timestamp the reader
 * returned for its own block, and `block_timestamp` is NOT NULL at L0, so a row with no timestamp
 * cannot be written at all. That makes the window undefined only when there is nothing to write,
 * which is the one case where no window is needed. There is deliberately NO block-height-to-time
 * arithmetic anywhere in this module: one chain in this set changed cadence from five seconds to
 * one second mid-life, so any such conversion is wrong across that boundary.
 */

import type { MergeWindow } from "./types.js";

/** Start of the UTC month containing `d`. */
function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** Shift a month-start by whole months. Uses Date.UTC month arithmetic, which normalises the year. */
function addMonthsUtc(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, 0, 0, 0, 0));
}

/** `2026-01-01 00:00:00` form, which is what a BigQuery TIMESTAMP literal takes. */
function sqlTs(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export const DEFAULT_PADDING_MONTHS = 1;

/**
 * The window for a set of rows about to be merged.
 *
 * Truncated to whole months so it lines up with the monthly partitioning, then padded whole
 * months each side. Returns null when there is nothing to write, which the caller must treat as
 * "do not submit a MERGE" rather than "submit one with no window".
 */
export function windowForRows(
  rows: Record<string, any>[],
  paddingMonths = DEFAULT_PADDING_MONTHS
): MergeWindow | null {
  if (rows.length === 0) return null;

  let min: number | null = null;
  let max: number | null = null;
  for (const r of rows) {
    if (r.block_timestamp === null || r.block_timestamp === undefined) {
      // block_timestamp is NOT NULL at L0, so this row could never be written. Failing here names
      // the cause; failing at the load job names a column and not the reason.
      throw new Error("L0_9: a row reached the write path with no block_timestamp, so no window can cover it");
    }
    const t = Date.parse(r.block_timestamp);
    if (Number.isNaN(t)) {
      throw new Error(`L0_9: block_timestamp ${r.block_timestamp} is unparsable, so no window can cover it`);
    }
    if (min === null || t < min) min = t;
    if (max === null || t > max) max = t;
  }

  const lo = new Date(min as number);
  const hi = new Date(max as number);
  return {
    fromTs: sqlTs(addMonthsUtc(startOfMonthUtc(lo), -paddingMonths)),
    // The upper bound is exclusive, so the month CONTAINING the latest row has to be included
    // whole: one month past its start, then the padding on top of that.
    toTs: sqlTs(addMonthsUtc(startOfMonthUtc(hi), 1 + paddingMonths)),
    sourceMinTs: sqlTs(lo),
    sourceMaxTs: sqlTs(hi),
    paddingMonths,
  };
}

/**
 * A window covering an explicit span, for a statement that deliberately rewrites history.
 *
 * The padding bound above covers a reorganisation, which moves a transaction by seconds. It does
 * NOT cover a correction that rewrites a row's timestamp by more than a month, and a rule copied
 * without its failure mode gets applied where it does not hold. Anything doing that names its own
 * range here and says so.
 */
export function windowForSpan(from: Date, to: Date, paddingMonths = DEFAULT_PADDING_MONTHS): MergeWindow {
  return {
    fromTs: sqlTs(addMonthsUtc(startOfMonthUtc(from), -paddingMonths)),
    toTs: sqlTs(addMonthsUtc(startOfMonthUtc(to), 1 + paddingMonths)),
    sourceMinTs: sqlTs(from),
    sourceMaxTs: sqlTs(to),
    paddingMonths,
  };
}

/**
 * The window rendered as the two lines that go into an ON clause, aliased to the target.
 *
 * Returned as SQL text rather than as a parameter because a required partition filter has to be
 * readable by the engine BEFORE the query runs, and a query parameter is not. That is measured,
 * not assumed: a parameterised bound is accepted by BigQuery in general, and refused here.
 */
export function windowPredicate(alias: string, w: MergeWindow): string {
  return `${alias}.block_timestamp >= TIMESTAMP('${w.fromTs}') AND ${alias}.block_timestamp < TIMESTAMP('${w.toTs}')`;
}

/** How many monthly partitions a window spans. A load or query job may modify at most 4,000. */
export function partitionsSpanned(w: MergeWindow): number {
  const a = new Date(w.fromTs + "Z");
  const b = new Date(w.toTs + "Z");
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/**
 * The smallest window covering both, for a statement that has to reach every partition a capture
 * wrote into across several flushes.
 *
 * A capture that flushes more than once writes under a different window each time, and a later
 * statement scoped to only the last of them would silently miss the rows the earlier flushes
 * wrote. That is the same shape as a MERGE window that does not cover an existing row, which is
 * the defect the padding rule exists for.
 */
export function widen(a: MergeWindow | null, b: MergeWindow): MergeWindow {
  if (a === null) return b;
  const lo = (x: string, y: string) => (Date.parse(x + "Z") <= Date.parse(y + "Z") ? x : y);
  const hi = (x: string, y: string) => (Date.parse(x + "Z") >= Date.parse(y + "Z") ? x : y);
  return {
    fromTs: lo(a.fromTs, b.fromTs),
    toTs: hi(a.toTs, b.toTs),
    sourceMinTs: lo(a.sourceMinTs, b.sourceMinTs),
    sourceMaxTs: hi(a.sourceMaxTs, b.sourceMaxTs),
    paddingMonths: Math.max(a.paddingMonths, b.paddingMonths),
  };
}
