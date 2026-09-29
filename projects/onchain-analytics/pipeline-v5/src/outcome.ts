/**
 * outcome.ts -- what a unit of work did, and what the shell is owed because of it.
 *
 * WHY THIS IS A TYPE AND NOT AN `if`. Finding C2 is not a missing check. `processTarget` returned
 * a row count and `runPipeline` returned `{ succeeded, failed }`, and in that shape a refusal has
 * nowhere to go: returning 0 rows means "read nothing because there was nothing" and "declined to
 * read" with the same value, so the call site cannot tell them apart no matter what it asks. The
 * audit's two runtime receipts are that one fact twice. A bare `daily` planned 142 targets against
 * a limit of 12, logged REFUSED, read nothing, persisted nothing and exited 0. An XDC backfill
 * requested 12,394,045 blocks against a limit of 1,296,000, wrote one refusal row, counted the
 * contract as processed successfully and exited 0.
 *
 * So the fix is the type. Every unit of work now ends in exactly one `UnitOutcome`, the counters
 * are derived from those outcomes rather than incremented by hand at each call site, and the exit
 * code is a pure function of the counters. A new outcome cannot be added without the compiler
 * demanding that the exit mapping say what it means.
 *
 * THE ONE INVARIANT THE WHOLE PHASE EXISTS TO ENFORCE, from the plan's exit gate: no log line may
 * say refused, unsupported, incomplete or failed while the process and the run record say success.
 * `assertExitAgreesWithSummary` is that sentence as an assertion, and it runs on every real run.
 */

/**
 * What one unit of work did. One unit is one (contract, chain, grain) capture, or one read-only
 * check, or one planned work item.
 *
 * `completed` is the only value that is success. Everything else is a reason the run is not clean,
 * and each of them means something different to the next run:
 *
 *   `nothing_to_fetch`  The range was empty by arithmetic, `toBlock` below `fromBlock`. Nothing
 *                       was declined and nothing was missed. It is a no-op, not work.
 *   `refused_budget`    A guard declined before reading. The range is unread and RECORDED as
 *                       unread, so a later run can pick it up. This is the C2 case.
 *   `unsupported`       This pipeline cannot do the thing asked: no reader for the chain, no
 *                       oracle for the check, a chain outside the frozen release scope, an
 *                       address the control plane does not know.
 *   `incomplete`        Work ran and did not finish its range. Some rows may be written. The
 *                       coverage ledger holds the gap.
 *   `failed`            Work ran and threw.
 */
export type UnitOutcomeKind =
  | "completed"
  | "nothing_to_fetch"
  | "refused_budget"
  | "unsupported"
  | "incomplete"
  | "failed";

/** Every kind, in one place, so a test can prove each one is reachable and mapped. */
export const UNIT_OUTCOME_KINDS: readonly UnitOutcomeKind[] = [
  "completed", "nothing_to_fetch", "refused_budget", "unsupported", "incomplete", "failed",
] as const;

/**
 * The grain a unit targeted.
 *
 * Plan task 6: a budget refusal is recorded against BOTH RawLogs and Transactions, or against one
 * parent whose target set names both. `RawLogs+Transactions` is that parent, and it is a distinct
 * value rather than a formatting choice: a consumer filtering `target_table = 'RawLogs'` must not
 * see a run-level refusal as a claim about the RawLogs grain, because a run-level refusal covers
 * no range at all.
 */
export const PARENT_GRAIN = "RawLogs+Transactions";

export interface UnitOutcome {
  readonly kind: UnitOutcomeKind;
  /** `RawLogs`, `Transactions`, `ContractStateSnapshots`, or `PARENT_GRAIN` for a run-level unit. */
  readonly grain: string;
  /** Chain id, or null for a unit that is not bound to one chain. */
  readonly chainId: number | null;
  /** Lowercase contract address, or null where the unit covers no single contract. */
  readonly address: string | null;
  /** Inclusive block range this unit was about, where it had one. */
  readonly fromBlock: number | null;
  readonly toBlock: number | null;
  /** Rows merged. Only meaningful for `completed` and `incomplete`. */
  readonly rows: number;
  /** One sentence a human can act on. Required for everything that is not `completed`. */
  readonly detail: string;
}

export function unit(
  kind: UnitOutcomeKind,
  grain: string,
  detail: string,
  fields: Partial<Omit<UnitOutcome, "kind" | "grain" | "detail">> = {},
): UnitOutcome {
  return {
    kind,
    grain,
    detail,
    chainId: fields.chainId ?? null,
    address: fields.address ?? null,
    fromBlock: fields.fromBlock ?? null,
    toBlock: fields.toBlock ?? null,
    rows: fields.rows ?? 0,
  };
}

/** Plan task 2's counters. `planned` is set by the planner; the rest are derived from outcomes. */
export interface OutcomeCounters {
  planned: number;
  attempted: number;
  completed: number;
  noop: number;
  refused: number;
  unsupported: number;
  incomplete: number;
  failed: number;
}

export function emptyCounters(): OutcomeCounters {
  return {
    planned: 0, attempted: 0, completed: 0, noop: 0,
    refused: 0, unsupported: 0, incomplete: 0, failed: 0,
  };
}

/**
 * Which counter a kind increments, and whether it counts as ATTEMPTED.
 *
 * `attempted` means the pipeline tried to read. A refusal and an unsupported chain were never
 * attempted, which is the distinction that makes `planned - attempted` a real number rather than
 * an accounting artefact: it is exactly the work this run declined to do.
 */
const COUNTER_OF: Record<UnitOutcomeKind, { field: keyof OutcomeCounters; attempted: boolean }> = {
  completed: { field: "completed", attempted: true },
  nothing_to_fetch: { field: "noop", attempted: false },
  refused_budget: { field: "refused", attempted: false },
  unsupported: { field: "unsupported", attempted: false },
  incomplete: { field: "incomplete", attempted: true },
  failed: { field: "failed", attempted: true },
};

export class RunSummary {
  readonly units: UnitOutcome[] = [];
  readonly totals: OutcomeCounters = emptyCounters();
  readonly byGrain = new Map<string, OutcomeCounters>();

  /**
   * Declare intended work before doing any of it.
   *
   * Plan task 4 requires a globally refused run to persist the REAL planned count. That number
   * only exists if it is recorded before the refusal, which is why this is separate from `add`.
   */
  plan(grain: string, count: number): void {
    this.totals.planned += count;
    this.grain(grain).planned += count;
  }

  add(outcome: UnitOutcome): UnitOutcome {
    this.units.push(outcome);
    const { field, attempted } = COUNTER_OF[outcome.kind];
    this.totals[field] += 1;
    this.grain(outcome.grain)[field] += 1;
    if (attempted) {
      this.totals.attempted += 1;
      this.grain(outcome.grain).attempted += 1;
    }
    return outcome;
  }

  private grain(name: string): OutcomeCounters {
    let c = this.byGrain.get(name);
    if (!c) { c = emptyCounters(); this.byGrain.set(name, c); }
    return c;
  }

  /** Units that are neither completed nor a no-op. The list the exit code is really about. */
  get problems(): UnitOutcome[] {
    return this.units.filter((u) => u.kind !== "completed" && u.kind !== "nothing_to_fetch");
  }

  /** JSON for `PipelineRuns.outcome_counts_by_grain`. Sorted so the column is diffable. */
  countsByGrainJson(): string {
    const out: Record<string, OutcomeCounters> = {};
    for (const key of [...this.byGrain.keys()].sort()) out[key] = this.byGrain.get(key)!;
    return JSON.stringify(out);
  }
}

// ------------------------------------------------------------------------------ exit codes

/**
 * The exit code a CAPTURE run owes the shell. Plan task 3, first three bullets, verbatim:
 *
 *   0  at least one requested unit completed and none refused, failed or remained unsupported
 *   1  some completed and some did not
 *   2  none completed, or the scope was empty, or the run was globally refused
 *
 * A no-op is deliberately not a completion. A run whose every unit was `nothing_to_fetch` did no
 * work, and gate item 5 says empty work is not success, so it lands in the `none completed` arm
 * and exits 2. That is the whole of "a command that does no work exits nonzero".
 */
export function captureExitCodeFor(summary: RunSummary): number {
  const t = summary.totals;
  const notDone = t.refused + t.unsupported + t.incomplete + t.failed;
  if (t.completed === 0) return 2;
  return notDone === 0 ? 0 : 1;
}

/**
 * The two-number form, kept because `main` and the C2 regression tests both call it and because
 * it is the exact mapping the audit's receipt was taken against.
 *
 * ONE ARM CHANGES, and it is the defect: `(0, 0)` used to be 0. A run with nothing succeeded and
 * nothing failed is a run that did no work, and the only reasons to be in that state are a global
 * refusal, an empty scope or an unknown chain. All three are exit 2 under plan task 3.
 */
export function captureExitCode(succeeded: number, failed: number): number {
  if (succeeded === 0) return 2;
  return failed === 0 ? 0 : 1;
}

/**
 * Read-only commands get their own matrix, because plan task 3 says reporting a real finding may
 * exit nonzero BY DESIGN and must never be collapsed into the capture rules.
 *
 * The distinction that matters here is between "I looked and found a problem" (exit 1, the report
 * is the product) and "I could not look" (exit 2, there is no report). A verification that
 * compared nothing is the second kind. That was finding C4, and `runVerify` now returns a report
 * carrying `outcome` so this mapping receives the real answer instead of inferring one from a
 * boolean that cannot carry it.
 */
export type ReadOnlyOutcome = "clean" | "finding" | "nothing_to_check" | "unsupported" | "failed";

/**
 * What a read-only command returns once it can say which of the five happened.
 *
 * The minimum a command has to carry for the exit mapping to be a lookup rather than a guess.
 * Commands still returning `boolean` are mapped on two of the five and cannot express the rest.
 */
export interface ReadOnlyResult {
  outcome: ReadOnlyOutcome;
}

export function readOnlyExitCode(outcome: ReadOnlyOutcome): number {
  switch (outcome) {
    case "clean": return 0;
    case "finding": return 1;
    case "nothing_to_check": return 2;
    case "unsupported": return 2;
    case "failed": return 2;
  }
}

/** Plan task 3, fourth bullet: `plan` is complete-and-inside-budget, or it is nonzero. */
export type PlanOutcome = "complete" | "refused" | "unsupported" | "incomplete";

export function planExitCode(outcome: PlanOutcome): number {
  switch (outcome) {
    case "complete": return 0;
    case "incomplete": return 1;
    case "refused": return 2;
    case "unsupported": return 2;
  }
}

// ------------------------------------------------------------------------- the exit gate

/**
 * What `PipelineRuns.execution_status` says. A word, not a number, because `exit_code = 2` does
 * not distinguish a refusal from a crash and those need different responses.
 *
 * `success` is deliberately not one of the values. The coverage ledger already refuses that word
 * for the same reason: it is the one term that invites a reader to stop asking.
 */
export type ExecutionStatus =
  | "completed" | "partial" | "refused" | "unsupported" | "empty" | "failed";

export function executionStatusOf(exitCode: number, summary: RunSummary): ExecutionStatus {
  const t = summary.totals;
  if (exitCode === 0) return "completed";
  if (t.completed > 0) return "partial";
  if (t.refused > 0) return "refused";
  if (t.failed > 0 || t.incomplete > 0) return "failed";
  if (t.unsupported > 0) return "unsupported";
  return "empty";
}

/**
 * The plan's Phase 3 exit gate, as an assertion rather than a promise.
 *
 * "No log line can say refused, unsupported, incomplete or failed while the process and run
 * record say success." A comment cannot enforce that and a code review has already missed it
 * once, so it is checked on every real run, against the counters that are also what gets
 * persisted. If this ever throws, the bug is in the mapping above and the run stops rather than
 * reporting a success it cannot evidence.
 */
export function assertExitAgreesWithSummary(exitCode: number, summary: RunSummary): void {
  if (exitCode !== 0) return;
  const t = summary.totals;
  const notDone = t.refused + t.unsupported + t.incomplete + t.failed;
  if (notDone > 0) {
    throw new Error(
      `OUTCOME_CONTRADICTION: exit 0 with ${notDone} unit(s) not completed ` +
      `(refused ${t.refused}, unsupported ${t.unsupported}, incomplete ${t.incomplete}, ` +
      `failed ${t.failed}). ` +
      summary.problems.slice(0, 5).map((u) => `[${u.kind} ${u.grain}] ${u.detail}`).join(" | ")
    );
  }
  if (t.completed === 0) {
    throw new Error(
      `OUTCOME_CONTRADICTION: exit 0 with zero completed unit(s) out of ${t.planned} planned. ` +
      `Empty work is not success.`
    );
  }
}
