/**
 * The typed outcome model, the exit mapping and the run record, asserted rather than assumed.
 *
 * WHAT THIS FILE IS FOR. Finding `C2`'s four regression tests prove the two refusal paths are
 * fixed. They do not prove the model AROUND the fix is sound, and that is the part that has to
 * survive every later phase adding a new outcome. So:
 *
 *   * every value of `UnitOutcomeKind` is produced by something, and its exit code is asserted,
 *     not inferred from a comment
 *   * the invariant the plan states as this phase's exit gate is exercised in both directions,
 *     including the direction where it must THROW
 *   * the persisted `PipelineRuns` row is read back out of the simulator and reconciled against
 *     the exit code, because "the run record agrees with the exit code" is a claim about a row,
 *     not about a variable
 *
 * FIXTURE FIDELITY. Nothing here invents a row shape. The coverage rows are the ones
 * `recordCoverage` actually writes, read back from the simulator, and the `PipelineRuns` row is
 * bound by the real INSERT statement's own column list. A fixture that agrees with an assumption
 * instead of with the artifact is how Phase 1's registry fixtures ended up failing for the wrong
 * reason.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  RunSummary, unit, UNIT_OUTCOME_KINDS, PARENT_GRAIN,
  captureExitCode, captureExitCodeFor, readOnlyExitCode, planExitCode,
  executionStatusOf, assertExitAgreesWithSummary,
  type UnitOutcomeKind,
} from "../../src/outcome.js";
import { runPipeline } from "../../src/pipeline.js";
import { recordPipelineRun } from "../../src/bq.js";
import { RAW_LOGS_TABLE, TRANSACTIONS_TABLE, NETWORKS } from "../../src/config.js";
import { checkCaptureSpan, checkRunSize, DEFAULT_MAX_CAPTURES } from "../../src/budget.js";
import { setBigQueryClient, resetAdapters } from "../../src/adapters.js";
import { BigQuerySimulator } from "../helpers/bq-simulator.js";

let sim: BigQuerySimulator;

beforeEach(() => {
  sim = new BigQuerySimulator();
  setBigQueryClient(sim);
});

afterEach(() => resetAdapters());

/** A summary holding exactly one unit of the given kind, for the mapping assertions. */
function summaryWith(...kinds: UnitOutcomeKind[]): RunSummary {
  const s = new RunSummary();
  s.plan(RAW_LOGS_TABLE, kinds.length);
  for (const k of kinds) s.add(unit(k, RAW_LOGS_TABLE, `synthetic ${k}`));
  return s;
}

describe("every outcome kind exists, counts once, and maps to a stated exit code", () => {
  it("counts each kind into exactly one counter, and only attempts what was attempted", () => {
    const s = summaryWith(...UNIT_OUTCOME_KINDS);
    const t = s.totals;

    expect(t.planned).toBe(6);
    expect([t.completed, t.noop, t.refused, t.unsupported, t.incomplete, t.failed])
      .toEqual([1, 1, 1, 1, 1, 1]);
    // completed, incomplete and failed ran. nothing_to_fetch, refused_budget and unsupported
    // never reached a reader, which is what makes planned-minus-attempted a real number.
    expect(t.attempted).toBe(3);
    expect(s.units).toHaveLength(6);
    expect(s.problems.map((u) => u.kind))
      .toEqual(["refused_budget", "unsupported", "incomplete", "failed"]);
  });

  it("maps each kind to an exit code, one assertion per kind, no inference", () => {
    // Alone, every non-completed kind is "nothing completed", which is exit 2.
    for (const kind of UNIT_OUTCOME_KINDS) {
      const expected = kind === "completed" ? 0 : 2;
      expect(captureExitCodeFor(summaryWith(kind)), `${kind} alone`).toBe(expected);
    }
    // Paired with a completion, every not-done kind is the partial arm, exit 1.
    for (const kind of UNIT_OUTCOME_KINDS) {
      const expected = kind === "completed" || kind === "nothing_to_fetch" ? 0 : 1;
      expect(captureExitCodeFor(summaryWith("completed", kind)), `completed + ${kind}`).toBe(expected);
    }
  });

  it("refuses to call empty work a success", () => {
    // Gate item 5. A run whose every unit was a no-op did nothing, and a run that did nothing
    // must not report success even though nothing went wrong.
    expect(captureExitCodeFor(summaryWith("nothing_to_fetch", "nothing_to_fetch"))).toBe(2);
    expect(captureExitCodeFor(new RunSummary())).toBe(2);
    expect(captureExitCode(0, 0)).toBe(2);
  });

  it("keeps the two-number mapping the audit receipts were taken against", () => {
    expect(captureExitCode(5, 0)).toBe(0);
    expect(captureExitCode(5, 1)).toBe(1);
    expect(captureExitCode(0, 3)).toBe(2);
  });

  it("counts separately by target grain", () => {
    const s = new RunSummary();
    s.plan(RAW_LOGS_TABLE, 1);
    s.plan(TRANSACTIONS_TABLE, 1);
    s.add(unit("completed", RAW_LOGS_TABLE, "logs done"));
    s.add(unit("refused_budget", TRANSACTIONS_TABLE, "transactions declined"));

    expect(s.byGrain.get(RAW_LOGS_TABLE)).toMatchObject({ planned: 1, completed: 1, refused: 0 });
    expect(s.byGrain.get(TRANSACTIONS_TABLE)).toMatchObject({ planned: 1, completed: 0, refused: 1 });
    expect(JSON.parse(s.countsByGrainJson())).toHaveProperty([TRANSACTIONS_TABLE, "refused"], 1);
  });
});

describe("the read-only and plan matrices are separate from the capture rules", () => {
  it("lets a read-only command report a real finding without calling it a crash", () => {
    expect(readOnlyExitCode("clean")).toBe(0);
    expect(readOnlyExitCode("finding")).toBe(1);
    // "I could not look" is not "I looked and found nothing". This is where C4's fix lands.
    expect(readOnlyExitCode("nothing_to_check")).toBe(2);
    expect(readOnlyExitCode("unsupported")).toBe(2);
    expect(readOnlyExitCode("failed")).toBe(2);
  });

  it("exits plan mode nonzero unless the plan is complete and inside budget", () => {
    expect(planExitCode("complete")).toBe(0);
    expect(planExitCode("incomplete")).toBe(1);
    expect(planExitCode("refused")).toBe(2);
    expect(planExitCode("unsupported")).toBe(2);
  });
});

describe("the exit gate is checked, not promised", () => {
  it("throws when exit 0 is claimed over a unit that did not complete", () => {
    // This is the plan's Phase 3 exit gate, in the one direction that matters: a contradiction
    // must be loud. Every kind that is not a completion or a no-op has to trip it.
    for (const kind of ["refused_budget", "unsupported", "incomplete", "failed"] as const) {
      expect(() => assertExitAgreesWithSummary(0, summaryWith("completed", kind)), kind)
        .toThrow(/OUTCOME_CONTRADICTION/);
    }
  });

  it("throws when exit 0 is claimed over zero completed units", () => {
    expect(() => assertExitAgreesWithSummary(0, summaryWith("nothing_to_fetch")))
      .toThrow(/zero completed unit/);
  });

  it("stays silent on a genuinely clean run and on every nonzero exit", () => {
    expect(() => assertExitAgreesWithSummary(0, summaryWith("completed"))).not.toThrow();
    expect(() => assertExitAgreesWithSummary(1, summaryWith("completed", "failed"))).not.toThrow();
    expect(() => assertExitAgreesWithSummary(2, summaryWith("refused_budget"))).not.toThrow();
  });
});

describe("the persisted run record agrees with the exit code", () => {
  /**
   * Gate item 4's second half. The row is written through the REAL insert statement and read back
   * out of the simulator, so the column list, the parameter binding and the counter arithmetic
   * are all exercised rather than described.
   */
  async function persist(summary: RunSummary, exitCode: number) {
    const t = summary.totals;
    await recordPipelineRun({
      runId: "run-under-test", mode: "daily",
      startedAt: "2026-09-28T00:00:00.000Z", completedAt: "2026-09-28T00:00:01.000Z",
      exitCode,
      totalRowsMerged: 0,
      contractsProcessed: t.completed,
      contractsFailed: t.refused + t.unsupported + t.incomplete + t.failed,
      host: "test-host", errorMessage: "", chainsProcessed: "50",
      capturesPlanned: t.planned, capturesOk: t.completed,
      capturesFailed: t.refused + t.unsupported + t.incomplete + t.failed,
      pipelineVersion: "test",
      executionStatus: executionStatusOf(exitCode, summary),
      unitsPlanned: t.planned, unitsAttempted: t.attempted, unitsCompleted: t.completed,
      unitsNoop: t.noop, unitsRefused: t.refused, unitsUnsupported: t.unsupported,
      unitsFailed: t.incomplete + t.failed,
      outcomeCountsByGrain: summary.countsByGrainJson(),
      releaseSha: null, planHash: null,
    });
    return sim.tables.get("PipelineRuns")!.rows.at(-1)!;
  }

  it("writes a refused run as refused, with the real planned count and a nonzero exit", async () => {
    const summary = new RunSummary();
    summary.plan(RAW_LOGS_TABLE, 142);
    for (let i = 0; i < 142; i++) summary.add(unit("refused_budget", RAW_LOGS_TABLE, "over the run-size limit"));

    const exitCode = captureExitCodeFor(summary);
    const row = await persist(summary, exitCode);

    // The audit's receipt for this exact case was: zero planned, zero failed, exit 0.
    expect(exitCode).toBe(2);
    expect(row.execution_status).toBe("refused");
    expect(row.units_planned).toBe(142);
    expect(row.units_refused).toBe(142);
    expect(row.units_attempted).toBe(0);
    expect(row.units_completed).toBe(0);
    expect(row.exit_code).toBe(2);
    // No column may say the run was fine while another says it was refused.
    expect(row.captures_ok).toBe(0);
    expect(row.captures_failed).toBe(142);
  });

  it("reconciles the grain breakdown exactly to the unit counters", async () => {
    const summary = new RunSummary();
    summary.plan(RAW_LOGS_TABLE, 2);
    summary.plan(TRANSACTIONS_TABLE, 2);
    summary.add(unit("completed", RAW_LOGS_TABLE, "ok"));
    summary.add(unit("refused_budget", RAW_LOGS_TABLE, "declined"));
    summary.add(unit("completed", TRANSACTIONS_TABLE, "ok"));
    summary.add(unit("failed", TRANSACTIONS_TABLE, "threw"));

    const exitCode = captureExitCodeFor(summary);
    const row = await persist(summary, exitCode);
    const byGrain = JSON.parse(row.outcome_counts_by_grain);

    expect(exitCode).toBe(1);
    expect(row.execution_status).toBe("partial");
    // "PipelineRuns can be reconciled exactly to child outcomes", from the plan's GREEN checks.
    const sum = (field: string) =>
      Object.values(byGrain).reduce((a: number, c: any) => a + c[field], 0);
    expect(sum("planned")).toBe(row.units_planned);
    expect(sum("completed")).toBe(row.units_completed);
    expect(sum("refused")).toBe(row.units_refused);
    expect(sum("failed") + sum("incomplete")).toBe(row.units_failed);
  });

  it("names a crash and an empty scope differently, because they need different responses", () => {
    expect(executionStatusOf(2, summaryWith("failed"))).toBe("failed");
    expect(executionStatusOf(2, summaryWith("refused_budget"))).toBe("refused");
    expect(executionStatusOf(2, summaryWith("unsupported"))).toBe("unsupported");
    expect(executionStatusOf(2, new RunSummary())).toBe("empty");
    expect(executionStatusOf(0, summaryWith("completed"))).toBe("completed");
    expect(executionStatusOf(1, summaryWith("completed", "failed"))).toBe("partial");
  });
});

describe("the budget verdicts say what they refused and what would allow it", () => {
  const xdc = NETWORKS.XDC;

  it("allows an implicit span inside the per-chain limit and refuses one above it", () => {
    const inside = checkCaptureSpan(xdc, 1, 30 * xdc.blocksPerDay, { mode: "daily" });
    expect(inside.allowed).toBe(true);
    expect(inside.reason).toBeNull();
    expect(inside.limit).toBe(30 * xdc.blocksPerDay);

    // The audit's per-capture receipt: 12,394,045 blocks against a limit of 1,296,000.
    const over = checkCaptureSpan(xdc, 95_000_000, 107_394_045, { mode: "daily" });
    expect(over.allowed).toBe(false);
    expect(over.requested).toBe(12_394_046);
    expect(over.reason).toMatch(/--max-capture-blocks=N/);
  });

  it("honours an explicit --max-capture-blocks over the per-chain default", () => {
    const raised = checkCaptureSpan(xdc, 1, 2_000_000, { mode: "daily", maxCaptureBlocks: 3_000_000 });
    expect(raised.allowed).toBe(true);
    expect(raised.limit).toBe(3_000_000);
  });

  it("never reports a negative span for a reversed range", () => {
    // `nothing_to_fetch` is decided before the guard, but a verdict that reported a negative
    // number would make the refusal message nonsense if the order ever changed.
    expect(checkCaptureSpan(xdc, 100, 50, { mode: "daily" }).requested).toBe(0);
  });

  it("allows a run at the size limit and refuses the one above it", () => {
    expect(checkRunSize(DEFAULT_MAX_CAPTURES, { mode: "daily" }).allowed).toBe(true);
    const refused = checkRunSize(DEFAULT_MAX_CAPTURES + 1, { mode: "daily" });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toMatch(/--max-captures=N/);
    expect(checkRunSize(50, { mode: "daily", maxCaptures: 50 }).allowed).toBe(true);
  });
});

describe("a run with nothing to do says so, in the coverage ledger and in the exit code", () => {
  it("treats an address the control plane does not know as unsupported, not as a clean run", async () => {
    // Plan task 7. A lowercase 40-hex address that is in no seed. Every chain therefore yields
    // zero targets, which used to `continue` past a warning and exit 0.
    const result = await runPipeline({
      mode: "daily",
      addresses: ["0x000000000000000000000000000000000000dead"],
    });

    expect(result.summary.totals.completed).toBe(0);
    expect(result.summary.totals.unsupported).toBeGreaterThan(0);
    expect(captureExitCodeFor(result.summary)).toBe(2);
    expect(result.summary.problems.every((u) => u.kind === "unsupported")).toBe(true);
  });

  it("treats a chain name no configuration declares as unsupported", async () => {
    const result = await runPipeline({ mode: "daily", chains: ["SOLANA"] });

    expect(captureExitCodeFor(result.summary)).toBe(2);
    expect(result.summary.units).toHaveLength(1);
    expect(result.summary.units[0].kind).toBe("unsupported");
    expect(result.summary.units[0].grain).toBe(PARENT_GRAIN);
    expect(result.summary.units[0].detail).toMatch(/no configured chain matched/);
  });

  it("records a globally refused run against both grains without claiming a range", async () => {
    // 114 across 3 chains, MEASURED 2026-09-28 after Fuse left the release. It was 142 across 4
    // while Fuse was still captured. Exact on purpose: the number of contracts a bare run would
    // attempt is a consequence of the release scope, so it moving is a decision to acknowledge
    // here rather than a detail to absorb with a loose matcher.
    const verdict = checkRunSize(114, { mode: "daily" });
    expect(verdict.allowed, "precondition: the run-size guard must refuse").toBe(false);

    await runPipeline({ mode: "daily" });

    const refusals = (sim.tables.get("IngestionCoverage")?.rows ?? [])
      .filter((r) => r.status === "refused_budget");

    expect(refusals.length).toBeGreaterThan(0);
    for (const row of refusals) {
      // A run-level refusal covers no range and must not pretend to. Both grains are named in one
      // parent target set, which is the form plan task 6 allows for a parent refusal.
      expect(row.target_table).toBe(PARENT_GRAIN);
      expect(row.contract_address).toBeNull();
      expect(row.from_block).toBe(0);
      expect(row.to_block).toBe(0);
      expect(row.rows_merged).toBe(0);
      expect(row.error_message).toMatch(/RUN_REFUSED \(114 target\(s\) planned across 3 chain\(s\)\)/);
    }
  });

  it("writes a per-capture refusal as two rows, one per grain, over the real range", async () => {
    const xdc = NETWORKS.XDC;
    const span = checkCaptureSpan(xdc, 95_000_000, 107_394_045, { mode: "backfill" });
    expect(span.allowed, "precondition: the span guard must refuse").toBe(false);

    await runPipeline({
      mode: "daily",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
      toBlock: 107_394_045,
      maxCaptures: DEFAULT_MAX_CAPTURES,
    });

    const refusals = (sim.tables.get("IngestionCoverage")?.rows ?? [])
      .filter((r) => r.status === "refused_budget");

    expect(refusals.map((r) => r.target_table).sort()).toEqual([RAW_LOGS_TABLE, TRANSACTIONS_TABLE]);
    // Two coverage rows, two capture ids. A shared id would make a row unable to name the capture
    // that produced it, which is the defect L0-6 exists for.
    expect(new Set(refusals.map((r) => r.capture_id)).size).toBe(2);
    for (const row of refusals) {
      expect(row.to_block).toBe(107_394_045);
      expect(row.contract_address).toBe("0x22867567e2d80f2049200e25c6f31cb6ec2f0faf");
      expect(row.error_message).toMatch(/Refusing a capture of/);
      expect(row.rows_inserted).toBe(0);
    }
  });
});
