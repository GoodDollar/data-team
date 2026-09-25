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
import { CONFIG, selectedNetworks } from "./config.js";
import { log, flushLogs, RUN_ID } from "./log.js";
import { runPipeline } from "./pipeline.js";
import { runVerify } from "./reconcile.js";
import { runDedup, runRepair, reportCoverage } from "./repair.js";
import { runCalibrate } from "./calibrate.js";
import { loadRegistry } from "./registry.js";
import { ensureInfraTables, recordPipelineRun } from "./bq.js";
import { alertFailure } from "./slack.js";
import type { PipelineOpts } from "./types.js";

const VALID_MODES = ["daily", "backfill", "verify", "dedup", "repair", "calibrate", "coverage"] as const;
type Mode = (typeof VALID_MODES)[number];

const USAGE = `
Usage: npx tsx src/index.ts <mode> [options]

Modes
  daily       Ingest from each contract's coverage frontier to the chain tip.
  backfill    Ingest a named range, or each contract's whole history from its creation block.
  verify      Reconcile the warehouse against a contract's own ledger. Changes nothing.
  coverage    Report every block range that is not covered by a clean capture. Changes nothing.
  dedup       Collapse repeated natural keys.
  repair      Re-read every range the coverage ledger records as not covered, then re-check.
  calibrate   Repeat one identical query against every source and report each one's miss rate.

Options
  --chains=A,B        Limit to these chains, by name. Default: every configured chain.
  --addresses=0x..    Limit to these contract addresses.
  --from=N --to=N     Block range. Applies to backfill and calibrate.
  --days=N,N          Protocol days. Applies to verify and repair.
  --dry-run           Report what would change without changing it. Applies to dedup and repair.
    --max-capture-blocks=N  Raise the span one capture may attempt. Default: 30 days of blocks
                            for that chain. An explicit --from and --to is always allowed.
    --max-captures=N        Raise the number of contracts one run may attempt. Default: 12.

  A run is refused, before it reads anything, when it would attempt more than those limits. With
  an empty coverage ledger every contract resumes from its creation block, so a bare run is a full
  historical backfill rather than an increment. The limits make that something you ask for.
contract is a seed change.
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

  // A limit that silently became NaN would compare false against every span and disable the guard
  // it was passed to raise. That is the shape of defect this project keeps finding, so it exits.
  for (const [flag, value] of [["--max-capture-blocks", opts.maxCaptureBlocks], ["--max-captures", opts.maxCaptures]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 1)) {
      console.error(`${flag} must be a positive whole number`);
      process.exit(2);
    }
  }

  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const startedAt = new Date().toISOString();

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
      case "coverage": {
        const clean = await reportCoverage(opts);
        succeeded = clean ? 1 : 0;
        failed = clean ? 0 : 1;
        exitCode = clean ? 0 : 1;
        if (!clean) errorMessage = "at least one contract has a block range no clean capture covers";
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
        if (!clean) errorMessage = "repair did not bring every open coverage gap under a clean capture";
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
      chainsProcessed: networks.map((n) => n.chainId).join(","),
      capturesPlanned: succeeded + failed,
      capturesOk: succeeded,
      // A run that finished with failed captures did NOT succeed, whatever its exit code, and this
      // column is where that is queryable. A count that appears only in console output does not
      // exist.
      capturesFailed: failed,
      pipelineVersion: CONFIG.PIPELINE_VERSION,
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
