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
import { CONFIG } from "./config.js";
import { log, flushLogs, RUN_ID } from "./log.js";
import { runPipeline } from "./pipeline.js";
import { runVerify } from "./reconcile.js";
import { runDedup, runRepair } from "./repair.js";
import { runCalibrate } from "./calibrate.js";
import { ensureInfraTables, recordPipelineRun } from "./bq.js";
import { alertFailure } from "./slack.js";
import type { PipelineOpts } from "./types.js";

const VALID_MODES = ["daily", "backfill", "verify", "dedup", "repair", "calibrate"] as const;
type Mode = (typeof VALID_MODES)[number];

const USAGE = `
Usage: npx tsx src/index.ts <mode> [options]

Modes
  daily       Ingest from the last stored block to the chain tip.
  backfill    Ingest a named range, or the whole history of each contract.
  verify      Reconcile the warehouse against the contract's own ledger. Changes nothing.
  dedup       Collapse repeated natural keys left by the predecessor pipeline.
  repair      Re-ingest the protocol days the oracle says are short, then re-check them.
  calibrate   Repeat one identical query against every source and report each one's miss rate.

Options
  --contracts=A,B     Limit to these table ids.
  --from=N --to=N     Block range. Applies to backfill and calibrate.
  --days=N,N          Protocol days. Applies to verify and repair.
  --dry-run           Report what would change without changing it. Applies to dedup and repair.
`;

function parseArgs(): PipelineOpts {
  const modeArg = (process.argv[2] || "").toLowerCase();
  if (!VALID_MODES.includes(modeArg as Mode)) {
    console.error(`Unknown mode: "${modeArg}". Valid: ${VALID_MODES.join(", ")}`);
    console.error(USAGE);
    process.exit(2);
  }

  const opts: PipelineOpts = { mode: modeArg as Mode };

  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith("--contracts=")) {
      opts.contracts = arg.slice("--contracts=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--from=")) {
      opts.fromBlock = parseInt(arg.slice("--from=".length), 10);
    } else if (arg.startsWith("--to=")) {
      opts.toBlock = parseInt(arg.slice("--to=".length), 10);
    } else if (arg.startsWith("--days=")) {
      opts.days = arg.slice("--days=".length).split(",")
        .map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else {
      console.error(`Unrecognised argument: ${arg}`);
      console.error(USAGE);
      process.exit(2);
    }
  }

  if (opts.fromBlock !== undefined && Number.isNaN(opts.fromBlock)) {
    console.error("--from is not a number");
    process.exit(2);
  }
  if (opts.toBlock !== undefined && Number.isNaN(opts.toBlock)) {
    console.error("--to is not a number");
    process.exit(2);
  }
  if (opts.fromBlock !== undefined && opts.toBlock !== undefined && opts.toBlock < opts.fromBlock) {
    console.error(`--to (${opts.toBlock}) is below --from (${opts.fromBlock})`);
    process.exit(2);
  }

  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const startedAt = new Date().toISOString();

  log.info("Pipeline starting", {
    mode: opts.mode,
    runId: RUN_ID,
    project: CONFIG.GCP_PROJECT_ID,
    dataset: CONFIG.DATASET_ID,
    contracts: opts.contracts ?? "all",
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
    days: opts.days,
    dryRun: !!opts.dryRun,
  });

  let exitCode = 0;
  let errorMessage: string | undefined;
  let totalRows = 0;
  let succeeded = 0;
  let failed = 0;

  try {
    await ensureInfraTables();

    switch (opts.mode) {
      case "daily":
      case "backfill": {
        const result = await runPipeline(opts);
        succeeded = result.succeeded;
        failed = result.failed;
        totalRows = result.totalRows;
        exitCode = failed === 0 ? 0 : succeeded > 0 ? 1 : 2;
        break;
      }
      case "verify": {
        const clean = await runVerify(opts);
        succeeded = clean ? 1 : 0;
        failed = clean ? 0 : 1;
        exitCode = clean ? 0 : 1;
        if (!clean) errorMessage = "reconciliation against the contract oracle did not come out clean";
        break;
      }
      case "dedup": {
        const clean = await runDedup(opts);
        succeeded = clean ? 1 : 0;
        failed = clean ? 0 : 1;
        exitCode = clean ? 0 : 1;
        if (!clean) errorMessage = "repeated natural keys remain";
        break;
      }
      case "repair": {
        const clean = await runRepair(opts);
        succeeded = clean ? 1 : 0;
        failed = clean ? 0 : 1;
        exitCode = clean ? 0 : 1;
        if (!clean) errorMessage = "repair did not bring every short day into agreement with the contract";
        break;
      }
      case "calibrate": {
        const ok = await runCalibrate(opts);
        succeeded = ok ? 1 : 0;
        failed = ok ? 0 : 1;
        exitCode = ok ? 0 : 1;
        if (!ok) errorMessage = "at least one source returned no answer on any pass";
        break;
      }
    }
  } catch (e: any) {
    exitCode = 2;
    errorMessage = e.message;
    log.error(`Pipeline crashed: ${e.message}`, { error: e.message, stack: String(e.stack ?? "").slice(0, 1000) });
  }

  const completedAt = new Date().toISOString();

  // Record PipelineRun
  try {
    await recordPipelineRun({
      runId: RUN_ID,
      mode: opts.mode,
      startedAt,
      completedAt,
      exitCode,
      totalRowsMerged: totalRows,
      contractsProcessed: succeeded,
      contractsFailed: failed,
      host: hostname(),
      errorMessage,
    });
  } catch (e: any) {
    log.warn(`Failed to record PipelineRun: ${e.message}`);
  }

  // Alert on failure
  if (exitCode !== 0) {
    await alertFailure(RUN_ID, opts.mode, exitCode, errorMessage ?? `${failed} unit(s) failed`, totalRows);
  }

  log.info(`Pipeline complete: exit ${exitCode}`, { succeeded, failed, totalRows, runId: RUN_ID });
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

main();
