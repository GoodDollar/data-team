/**
 * budget.ts -- what one run is allowed to attempt before a human has to say so.
 *
 * WHY THIS EXISTS. The A4 review found a documented hazard that was not a guarded one. The resume
 * rule resolves an unknown downwards, which is correct: An absence of coverage means nobody
 * looked, and the safe reading of "nobody looked" is "start from the beginning". The consequence
 * is that on a warehouse whose coverage ledger is empty, and this one's is empty for RawLogs, a
 * bare `daily` resumes EVERY contract in the registry from its creation block. That is 148
 * contracts across four chains, genesis to head. It is a full historical backfill wearing the
 * name of an incremental run, and it is one command with no arguments away.
 *
 * This project's own history says what to do with a hazard like that. The partition guard was kept
 * over an audit's objection on exactly this reasoning: A rule people are told to follow is not the
 * same as a rule the system refuses to break, and the expensive mistake has to be impossible
 * rather than discouraged. A note in a report is the first kind. This is the second.
 *
 * WHAT IT DOES NOT DO. It does not decide that a backfill is wrong. A backfill is the point of A5.
 * It makes the backfill something you ASK for, on the command line, where it is visible in the
 * shell history and in the run record, instead of something you receive by omission.
 *
 * A REFUSAL IS A ROW, NOT A SILENCE. L0-8 is the reason. A run that quietly declines to read a
 * range leaves the warehouse in the state where an empty result cannot be told from no activity,
 * which is the one state the coverage ledger exists to prevent. So a refusal writes a coverage row
 * with status `refused_budget`, naming the span it declined and the flag that would allow it.
 */

import type { NetworkConfig, PipelineOpts } from "./types.js";

/**
 * Default span for ONE capture, expressed in days and converted with the network's own
 * `blocksPerDay`, whose declared purpose is range sizing.
 *
 * Days rather than blocks because the same block count means very different things per chain: A
 * chain producing a block a second and one producing a block every twelve seconds differ by an
 * order of magnitude for the same number. Note that this is a CAPACITY estimate and nothing else.
 * No timestamp is ever derived from a block height anywhere in this pipeline, and one chain here
 * changed cadence mid-life, which is precisely why that rule exists.
 *
 * Thirty days is chosen to be comfortably larger than any incremental run and obviously smaller
 * than any history. A daily run that has fallen a month behind still goes through untouched.
 */
export const DEFAULT_MAX_CAPTURE_DAYS = 30;

/** Default number of contracts one run may attempt. Above this, name them or raise it. */
export const DEFAULT_MAX_CAPTURES = 12;

export interface BudgetVerdict {
  allowed: boolean;
  /** Null when allowed. Otherwise the full sentence a human needs, including the way through. */
  reason: string | null;
  limit: number;
  requested: number;
}

/** The span budget for one capture on one chain, in blocks. */
export function maxCaptureBlocks(network: NetworkConfig, opts: PipelineOpts): number {
  if (opts.maxCaptureBlocks !== undefined) return opts.maxCaptureBlocks;
  return DEFAULT_MAX_CAPTURE_DAYS * network.blocksPerDay;
}

/**
 * May this capture run?
 *
 * An explicit range is always allowed. `--from` and `--to` are a person naming a span, which is
 * the acknowledgement this guard exists to require, so demanding a second one would only teach
 * people to pass the override by reflex.
 */
export function checkCaptureSpan(
  network: NetworkConfig,
  fromBlock: number,
  toBlock: number,
  opts: PipelineOpts
): BudgetVerdict {
  const requested = Math.max(0, toBlock - fromBlock + 1);
  const limit = maxCaptureBlocks(network, opts);

  if (opts.fromBlock !== undefined && opts.toBlock !== undefined) {
    return { allowed: true, reason: null, limit, requested };
  }
  if (requested <= limit) {
    return { allowed: true, reason: null, limit, requested };
  }
  return {
    allowed: false,
    limit,
    requested,
    reason:
      `Refusing a capture of ${requested.toLocaleString()} blocks on ${network.name}, ` +
      `which is above this run's limit of ${limit.toLocaleString()} ` +
      `(${DEFAULT_MAX_CAPTURE_DAYS} days at ${network.blocksPerDay.toLocaleString()} blocks per day). ` +
      `Blocks ${fromBlock} to ${toBlock}. This is a backfill, not an increment: the coverage ledger ` +
      `has no clean capture below ${fromBlock}, so the resume point fell back to the contract's ` +
      `creation block. Run it deliberately with --from and --to, or raise the limit with ` +
      `--max-capture-blocks=N. Nothing was read and no coverage is claimed.`,
  };
}

/**
 * May this run attempt this many contracts?
 *
 * Checked BEFORE any capture starts, so a run that is going to be refused is refused while it has
 * still written nothing. A refusal halfway through leaves a warehouse half covered by a run whose
 * own record says it failed, which is harder to reason about afterwards than either outcome.
 */
export function checkRunSize(targetCount: number, opts: PipelineOpts): BudgetVerdict {
  const limit = opts.maxCaptures ?? DEFAULT_MAX_CAPTURES;
  if (targetCount <= limit) {
    return { allowed: true, reason: null, limit, requested: targetCount };
  }
  return {
    allowed: false,
    limit,
    requested: targetCount,
    reason:
      `Refusing to start: this run would attempt ${targetCount} contracts, above the limit of ` +
      `${limit}. With an empty coverage ledger every one of them resumes from its creation block, ` +
      `so this is a full historical backfill rather than an incremental run. Narrow it with ` +
      `--chains or --addresses, or raise the limit with --max-captures=N. Nothing was read.`,
  };
}
