/**
 * index.ts -- CLI entry point. Arg parsing, exit codes, PipelineRun recording, alerting.
 */

import { hostname } from "os";
import { CONFIG } from "./config.js";
import { log, flushLogs, RUN_ID } from "./log.js";
import { runPipeline } from "./pipeline.js";
import { recordPipelineRun } from "./bq.js";
import { alertFailure } from "./slack.js";
import type { PipelineOpts } from "./types.js";

const VALID_MODES = ["daily", "backfill"] as const;
type Mode = (typeof VALID_MODES)[number];

function parseArgs(): PipelineOpts {
  const modeArg = (process.argv[2] || "daily").toLowerCase();
  if (!VALID_MODES.includes(modeArg as Mode)) {
    console.error(`Unknown mode: "${modeArg}". Valid: ${VALID_MODES.join(", ")}`);
    process.exit(2);
  }

  let contracts: string[] | undefined;
  let fromBlock: number | undefined;
  let toBlock: number | undefined;

  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith("--contracts=")) {
      contracts = arg.slice("--contracts=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--from=")) {
      fromBlock = parseInt(arg.slice("--from=".length), 10);
    } else if (arg.startsWith("--to=")) {
      toBlock = parseInt(arg.slice("--to=".length), 10);
    }
  }

  return { mode: modeArg as Mode, contracts, fromBlock, toBlock };
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
  });

  let exitCode = 0;
  let errorMessage: string | undefined;
  let totalRows = 0;
  let succeeded = 0;
  let failed = 0;

  try {
    const result = await runPipeline(opts);
    succeeded = result.succeeded;
    failed = result.failed;
    totalRows = result.totalRows;

    if (failed === 0) {
      exitCode = 0;
    } else if (succeeded > 0) {
      exitCode = 1; // partial
    } else {
      exitCode = 2; // complete failure
    }
  } catch (e: any) {
    exitCode = 2;
    errorMessage = e.message;
    log.error(`Pipeline crashed: ${e.message}`, { error: e.message });
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
    await alertFailure(RUN_ID, opts.mode, exitCode, errorMessage ?? `${failed} contracts failed`, totalRows);
  }

  log.info(`Pipeline complete: exit ${exitCode}`, { succeeded, failed, totalRows, runId: RUN_ID });
  await flushLogs();
  process.exit(exitCode);
}

main();
