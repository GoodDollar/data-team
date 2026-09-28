/**
 * index.ts -- CLI entry point. Arg parsing, exit codes, PipelineRun recording, alerting.
 *
 * Exit codes are the only thing anything automatic reads, so they are the only thing that gets
 * to say whether a run was fine. A script in this project once printed its failures and exited
 * zero; every mode here fails closed instead.
 *
 *   0  everything attempted completed and, where an oracle exists, reconciled
 *   1  partial: at least one unit succeeded and at least one did not
 *   2  nothing succeeded, or the arguments were wrong
 */

import { hostname } from "os";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { CONFIG, NETWORKS, selectedNetworks } from "./config.js";
import { log, flushLogs, RUN_ID } from "./log.js";
import { runPipeline } from "./pipeline.js";
import { runVerify } from "./reconcile.js";
import { runDedup, runRepair, reportCoverage } from "./repair.js";
import { runCalibrate } from "./calibrate.js";
import { loadRegistry } from "./registry.js";
import { ensureInfraTables, recordPipelineRun } from "./bq.js";
import { alertFailure } from "./slack.js";
import { buildPlan, renderPlan } from "./plan.js";
import { MAX_CAPTURES_CEILING, MAX_CAPTURE_BLOCKS_CEILING } from "./budget.js";
import {
  RunSummary, unit, captureExitCodeFor, assertExitAgreesWithSummary, readOnlyExitCode,
  executionStatusOf, PARENT_GRAIN, type ReadOnlyOutcome,
} from "./outcome.js";
import type { PipelineOpts } from "./types.js";

const VALID_MODES = [
  "daily", "backfill", "plan", "verify", "dedup", "repair", "calibrate", "coverage",
] as const;
type Mode = (typeof VALID_MODES)[number];

const USAGE = `
Usage: npx tsx src/index.ts <mode> [options]

Modes
  daily       Ingest from each contract's coverage frontier to the chain tip.
  backfill    Ingest a named range. --from and --to are both required.
  plan        Say exactly what a run would do. Reads no chain and writes no BigQuery.
  verify      Reconcile the warehouse against a contract's own ledger. Changes nothing.
  coverage    Report every block range that is not covered by a clean capture. Changes nothing.
  dedup       Collapse repeated natural keys.
  repair      Re-read every range the coverage ledger records as not covered, then re-check.
  calibrate   Repeat one identical query against every source and report each one's miss rate.

Options
  --chains=A,B        Limit to these chains, by name. Default: every configured chain.
  --addresses=0x..    Limit to these contract addresses.
  --from=N --to=N     Block range. Both or neither; one alone is refused.
  --days=N,N          Protocol days. Applies to verify and repair.
  --dry-run           Report what would change without changing it. Applies to dedup and repair.
    --max-capture-blocks=N  Raise the span one capture may attempt. Default: 30 days of blocks
                            for that chain. Maximum ${MAX_CAPTURE_BLOCKS_CEILING.toLocaleString()}.
                            An explicit --from and --to is always allowed.
    --max-captures=N        Raise the number of contracts one run may attempt. Default: 12.
                            Maximum ${MAX_CAPTURES_CEILING.toLocaleString()}.

  A run is refused, before it reads anything, when it would attempt more than those limits. With
  an empty coverage ledger every contract resumes from its creation block, so a bare run is a full
  historical backfill rather than an increment. The limits make that something you ask for.

Exit codes
  0  at least one unit completed and nothing was refused, unsupported, incomplete or failed
  1  some units completed and some did not, or a read-only command reported a real finding
  2  nothing completed, the scope was empty, the run was refused, or the arguments were wrong
`;

/**
 * An argument the parser rejected, carrying the exit code the CLI owes the shell.
 *
 * The parser used to call `process.exit` from inside itself. That made it untestable in process:
 * exercising a bad argument killed the test runner. Throwing instead moves the decision to the
 * one place that is allowed to make it, `main`, and changes no observable CLI behaviour.
 */
export class CliUsageError extends Error {
  readonly exitCode: number;
  readonly showUsage: boolean;
  constructor(message: string, opts: { exitCode?: number; showUsage?: boolean } = {}) {
    super(message);
    this.name = "CliUsageError";
    this.exitCode = opts.exitCode ?? 2;
    this.showUsage = opts.showUsage ?? true;
  }
}

/**
 * Parse CLI arguments into options, or throw.
 *
 * Takes the argument list rather than reading `process.argv`, so a caller can parse a hypothetical
 * command line. `argv` is the list AFTER the node executable and script path, i.e. mode first.
 */
export function parseArgs(argv: string[]): PipelineOpts {
  const modeArg = (argv[0] || "").toLowerCase();
  if (!VALID_MODES.includes(modeArg as Mode)) {
    throw new CliUsageError(`Unknown mode: "${modeArg}". Valid: ${VALID_MODES.join(", ")}`);
  }

  const opts: PipelineOpts = { mode: modeArg as Mode };

  for (const arg of argv.slice(1)) {
    if (arg.startsWith("--chains=")) {
      opts.chains = arg.slice("--chains=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--addresses=")) {
      opts.addresses = arg.slice("--addresses=".length).split(",")
        .map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg.startsWith("--from=")) {
      opts.fromBlock = parseInt(arg.slice("--from=".length), 10);
    } else if (arg.startsWith("--to=")) {
      opts.toBlock = parseInt(arg.slice("--to=".length), 10);
    } else if (arg.startsWith("--days=")) {
      opts.days = arg.slice("--days=".length).split(",")
        .map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg.startsWith("--max-capture-blocks=")) {
      opts.maxCaptureBlocks = parseInt(arg.slice("--max-capture-blocks=".length), 10);
    } else if (arg.startsWith("--max-captures=")) {
      opts.maxCaptures = parseInt(arg.slice("--max-captures=".length), 10);
    } else {
      throw new CliUsageError(`Unrecognised argument: ${arg}`);
    }
  }

  if (opts.fromBlock !== undefined && Number.isNaN(opts.fromBlock)) {
    throw new CliUsageError("--from is not a number", { showUsage: false });
  }
  if (opts.toBlock !== undefined && Number.isNaN(opts.toBlock)) {
    throw new CliUsageError("--to is not a number", { showUsage: false });
  }
  if (opts.fromBlock !== undefined && opts.toBlock !== undefined && opts.toBlock < opts.fromBlock) {
    throw new CliUsageError(`--to (${opts.toBlock}) is below --from (${opts.fromBlock})`, { showUsage: false });
  }

  // Plan task 7: a ONE-SIDED range is refused. Half a range is not a smaller range, it is a
  // different command: `--to` alone silently means "from wherever the ledger happens to resume",
  // and `--from` alone means "to wherever the chain happens to be", so the span the guard judges
  // is not the span the person typed. Plan section 1.1 requires every live range to carry an
  // explicit --from AND --to, which this is the enforcement of.
  const sides = [opts.fromBlock !== undefined, opts.toBlock !== undefined];
  if (sides[0] !== sides[1]) {
    throw new CliUsageError(
      `--${sides[0] ? "from" : "to"} was given without --${sides[0] ? "to" : "from"}. A block range ` +
      `is both bounds or neither: one alone leaves the other end to be resolved from the coverage ` +
      `ledger or the chain tip, so the span you typed is not the span that runs.`,
      { showUsage: false }
    );
  }

  // Plan section 1.1: bare `backfill` is forbidden. It resumes every selected contract from its
  // creation block, which is A5 wearing the name of a range read.
  if (opts.mode === "backfill" && opts.fromBlock === undefined) {
    throw new CliUsageError(
      "backfill requires an explicit --from and --to. Without them it reads from every selected " +
      "contract's creation block to the chain tip, which is a full historical backfill.",
      { showUsage: false }
    );
  }

  // Plan task 7: an unknown chain name is rejected rather than silently selecting nothing.
  // `selectedNetworks` filters by name, so a typo used to produce an empty network list, which
  // ran to completion having done nothing and exited 0.
  if (opts.chains) {
    const known = new Set(Object.values(NETWORKS).map((n) => n.name));
    const unknown = opts.chains.map((c) => c.toUpperCase()).filter((c) => !known.has(c));
    if (unknown.length > 0) {
      throw new CliUsageError(
        `Unknown chain(s): ${unknown.join(", ")}. Configured chains are ${[...known].join(", ")}.`,
        { showUsage: false }
      );
    }
  }

  // Plan task 8: a limit is a positive SAFE integer with an explicit upper bound.
  //
  // Three failure shapes, all of them turning the guard OFF while looking like an adjustment to
  // it. NaN compares false against every span. A non-integer like 1.5 compares in ways nobody
  // predicted. And a value above `Number.MAX_SAFE_INTEGER` is not the integer that was typed:
  // this project measured `Number("9223372036854775807")` producing a DIFFERENT number on 134
  // registry rows, so an unbounded limit is not a theoretical hazard here.
  for (const [flag, value, ceiling] of [
    ["--max-capture-blocks", opts.maxCaptureBlocks, MAX_CAPTURE_BLOCKS_CEILING],
    ["--max-captures", opts.maxCaptures, MAX_CAPTURES_CEILING],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CliUsageError(`${flag} must be a positive whole number`, { showUsage: false });
    }
    if (value > ceiling) {
      throw new CliUsageError(
        `${flag}=${value} is above the maximum of ${ceiling.toLocaleString()}. A limit that can be ` +
        `set to any number is not a limit. If this run genuinely needs more, it is an A5-shaped ` +
        `run and plan section 1.1 forbids executing one from here.`,
        { showUsage: false }
      );
    }
  }

  return opts;
}

/**
 * The exit code a capture run owes the shell.
 *
 * Re-exported rather than redefined: the mapping lives in `outcome.ts` next to the counters it
 * reads, so there is one place where "what does this run's result mean" is decided. `main` uses
 * the summary-shaped `captureExitCodeFor`; this two-number form is what the C2 regression tests
 * and the audit's receipts were taken against, and it is the same function underneath.
 */
export { captureExitCode } from "./outcome.js";

/** The process-level wrapper. The only place in this file allowed to end the process. */
function parseArgvOrExit(): PipelineOpts {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (e: any) {
    console.error(e.message);
    if (e instanceof CliUsageError && e.showUsage) console.error(USAGE);
    process.exit(e instanceof CliUsageError ? e.exitCode : 2);
  }
}

/**
 * Map a read-only command's boolean to the read-only matrix.
 *
 * `false` means the command found something, which is a REPORT and exits 1, not a crash. This is
 * the seam Phase 4 replaces: `runVerify` returns a boolean today, so "nothing could be checked"
 * and "everything checked out" arrive here as the same value and this function cannot tell them
 * apart either. That is finding C4 and it is Phase 4's to fix, in the return type. What this
 * phase can do, and does, is make sure the mapping exists in one place with the third state
 * already named, so the fix is a value change rather than a control-flow change.
 */
function readOnlyOutcomeOf(clean: boolean): ReadOnlyOutcome {
  return clean ? "clean" : "finding";
}

async function main(): Promise<void> {
  const opts = parseArgvOrExit();
  const startedAt = new Date().toISOString();

  // ------------------------------------------------------------------ plan mode, before anything
  //
  // Plan task 9: no chain read, no BigQuery write. So it runs BEFORE the registry log line, before
  // `ensureInfraTables`, and it never reaches `recordPipelineRun`. A read-only command does not
  // gain warehouse mutation merely to close itself.
  if (opts.mode === "plan") {
    const plan = buildPlan(opts);
    console.log(renderPlan(plan));
    console.log(JSON.stringify({
      outcome: plan.outcome,
      exitCode: plan.exitCode,
      contractsPlanned: plan.contractsPlanned,
      unitsPlanned: plan.unitsPlanned,
      counts: plan.summary.totals,
      countsByGrain: JSON.parse(plan.summary.countsByGrainJson()),
    }));
    if (plan.exitCode !== 0) {
      await alertFailure(RUN_ID, opts.mode, plan.exitCode, plan.refusals[0] ?? plan.outcome, 0);
    }
    await flushLogs();
    process.exitCode = plan.exitCode;
    return;
  }

  // The registry is loaded before anything else, so a missing or moved seed stops the run with a
  // message naming the file rather than producing an ingestion that silently covers no contracts.
  const registry = loadRegistry();
  const networks = selectedNetworks(opts.chains);

  log.info("Pipeline starting", {
    mode: opts.mode,
    runId: RUN_ID,
    version: CONFIG.PIPELINE_VERSION,
    project: CONFIG.GCP_PROJECT_ID,
    dataset: CONFIG.DATASET_ID,
    chains: networks.map((n) => `${n.name}(${n.chainId})`),
    contracts: registry.contracts.length,
    eras: registry.eras.length,
    addresses: opts.addresses ?? "all",
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
    days: opts.days,
    dryRun: !!opts.dryRun,
  });

  let exitCode = 0;
  let errorMessage: string | undefined;
  let totalRows = 0;
  // Every mode ends with one summary, so the run record is filled from the same object the exit
  // code is computed from and the two cannot drift.
  let summary = new RunSummary();

  try {
    await ensureInfraTables();

    switch (opts.mode) {
      case "daily":
      case "backfill": {
        const result = await runPipeline(opts);
        summary = result.summary;
        totalRows = result.totalRows;
        exitCode = captureExitCodeFor(summary);
        if (exitCode !== 0) {
          errorMessage = summary.problems.slice(0, 3).map((u) => `[${u.kind}] ${u.detail}`).join(" | ");
        }
        break;
      }
      case "verify":
      case "coverage":
      case "dedup":
      case "repair":
      case "calibrate": {
        const runner = {
          verify: runVerify,
          coverage: reportCoverage,
          dedup: runDedup,
          repair: runRepair,
          calibrate: runCalibrate,
        }[opts.mode];
        const message = {
          verify: "reconciliation against the contract oracle did not come out clean",
          coverage: "at least one contract has a block range no clean capture covers",
          dedup: "repeated natural keys remain",
          repair: "repair did not bring every open coverage gap under a clean capture",
          calibrate: "at least one source returned no answer on any pass",
        }[opts.mode];

        const outcome = readOnlyOutcomeOf(await runner(opts));
        exitCode = readOnlyExitCode(outcome);
        summary.plan(PARENT_GRAIN, 1);
        summary.add(unit(
          outcome === "clean" ? "completed" : "failed",
          PARENT_GRAIN,
          outcome === "clean" ? `${opts.mode} found nothing to report` : message,
        ));
        if (outcome !== "clean") errorMessage = message;
        break;
      }
    }
  } catch (e: any) {
    exitCode = 2;
    errorMessage = e.message;
    summary.add(unit("failed", PARENT_GRAIN, `${opts.mode} crashed: ${e.message}`));
    log.error(`Pipeline crashed: ${e.message}`, { error: e.message, stack: String(e.stack ?? "").slice(0, 1000) });
  }

  // THE EXIT GATE, CHECKED RATHER THAN PROMISED. Plan Phase 3's exit gate is that no log line may
  // say refused, unsupported, incomplete or failed while the process and the run record say
  // success. This is that sentence as an assertion, and it runs on every real run. If the mapping
  // above is ever wrong, the run turns into a nonzero exit naming the contradiction instead of a
  // green no-op, which is the exact defect this phase exists to remove.
  try {
    assertExitAgreesWithSummary(exitCode, summary);
  } catch (e: any) {
    log.error(e.message);
    errorMessage = e.message;
    exitCode = 2;
  }

  const completedAt = new Date().toISOString();
  const t = summary.totals;

  try {
    await recordPipelineRun({
      runId: RUN_ID,
      mode: opts.mode,
      startedAt,
      completedAt,
      exitCode,
      totalRowsMerged: totalRows,
      contractsProcessed: t.completed,
      contractsFailed: t.refused + t.unsupported + t.incomplete + t.failed,
      host: hostname(),
      errorMessage,
      chainsProcessed: networks.map((n) => n.chainId).join(","),
      capturesPlanned: t.planned,
      capturesOk: t.completed,
      // A run that finished with failed captures did NOT succeed, whatever its exit code, and this
      // column is where that is queryable. A count that appears only in console output does not
      // exist.
      capturesFailed: t.refused + t.unsupported + t.incomplete + t.failed,
      pipelineVersion: CONFIG.PIPELINE_VERSION,
      // Plan task 11. The run record now carries the same typed outcome the exit code was
      // computed from, so `PipelineRuns` reconciles exactly to child outcomes instead of to two
      // numbers that were incremented separately from them.
      executionStatus: executionStatusOf(exitCode, summary),
      unitsPlanned: t.planned,
      unitsAttempted: t.attempted,
      unitsCompleted: t.completed,
      unitsNoop: t.noop,
      unitsRefused: t.refused,
      unitsUnsupported: t.unsupported,
      unitsFailed: t.incomplete + t.failed,
      outcomeCountsByGrain: summary.countsByGrainJson(),
      releaseSha: CONFIG.RELEASE_SHA,
      planHash: CONFIG.PLAN_HASH,
    });
  } catch (e: any) {
    log.warn(`Failed to record PipelineRun: ${e.message}`);
  }

  // Plan task 10, first half: every nonzero exit reaches Slack. A globally refused run used to
  // exit 0 and therefore never alerted, which is how a scheduled workflow could turn green while
  // ingesting nothing.
  if (exitCode !== 0) {
    await alertFailure(
      RUN_ID, opts.mode, exitCode,
      errorMessage ?? `${t.refused + t.unsupported + t.incomplete + t.failed} unit(s) did not complete`,
      totalRows
    );
  }

  log.info(`Pipeline complete: exit ${exitCode}`, {
    runId: RUN_ID,
    planned: t.planned, attempted: t.attempted, completed: t.completed,
    noop: t.noop, refused: t.refused, unsupported: t.unsupported,
    incomplete: t.incomplete, failed: t.failed,
    byGrain: summary.countsByGrainJson(),
    totalRows,
  });
  await flushLogs();

  // Setting exitCode and letting the loop drain, rather than calling process.exit, which tears
  // down the log stream and the BigQuery client mid-write and produces a libuv assertion on
  // Windows. The backstop force-exits if a handle is still open after 30 seconds, so a leak
  // cannot hang a scheduled run: it is unref'd, so it never delays a clean exit.
  process.exitCode = exitCode;
  setTimeout(() => {
    process.stderr.write(`[index.ts] Forcing exit ${exitCode} after 30s: a handle is still open\n`);
    process.exit(exitCode);
  }, 30_000).unref();
}

// Run only when this file IS the command, so a test can import `parseArgs` and `captureExitCode`
// without starting an ingestion. `process.argv[1]` is the script node was asked to run.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) main();
