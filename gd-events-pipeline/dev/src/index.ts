/**
 * ============================================================================
 * index.ts — CLI entry point
 * ============================================================================
 *
 * USAGE:
 *   npx tsx src/index.ts backfill   Full historical load (idempotent)
 *   npx tsx src/index.ts daily      Cron path: ingest + verify + repair
 *   npx tsx src/index.ts verify     Integrity check, read-only
 *   npx tsx src/index.ts repair     Verify and fix mismatches
 *   npx tsx src/index.ts dedup      Utility: safety-net deduplication
 *
 * Optional flags:
 *   --contracts=<id1,id2,...>        Filter by tableId (e.g. InviteContractEvents)
 *   --contracts=tag:<tag>,...        Filter by tag (e.g. tag:invites,tag:ubi)
 *
 * Exit codes:
 *   0   Clean success
 *   1   Run failure (any contract/network failed)
 *   2   Lock not acquired (another run is in progress)
 *   3   Required tables missing (mode needed them)
 *   130 Received SIGINT
 *
 * Acquires a named lock at start and releases on exit (including abort).
 * Prevents concurrent runs from racing on the same tables.
 * ============================================================================
 */

import { hostname } from "os";
import { CONFIG, CONTRACT_CONFIGS } from "./config";
import { log, RUN_ID, flushLogs } from "./log";
import {
  runBackfill,
  runDaily,
  runVerify,
  runRepair,
  runDedup,
  ensureAllTables,
  logFinalSummary,
  acquireLock,
  releaseLock,
  extendLock,
  startPipelineRun,
  completePipelineRun,
} from "./pipeline";

const VALID_MODES = ["daily", "append", "backfill", "verify", "repair", "dedup"] as const;
type Mode = (typeof VALID_MODES)[number];

const LOCK_NAME = "pipeline:main";
const LOCK_HOLDER = `${hostname()}:${process.pid}:${RUN_ID}`;

/** Parse --contracts=<value> from argv, returns undefined if not present. */
function parseContractsFilter(): string[] | undefined {
  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith("--contracts=")) {
      const val = arg.slice("--contracts=".length).trim();
      return val ? val.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    }
  }
  return undefined;
}

async function main() {
  const modeArg = (process.argv[2] || "daily") as Mode;
  const contractsFilter = parseContractsFilter();
  const runStart = Date.now();

  log.info("Pipeline run starting", {
    mode: modeArg,
    project: CONFIG.GCP_PROJECT_ID,
    dataset: CONFIG.DATASET_ID,
    contracts: CONTRACT_CONFIGS.map((c) => c.tableId),
    contracts_filter: contractsFilter ?? null,
    lock_holder: LOCK_HOLDER,
  });

  if (!VALID_MODES.includes(modeArg as Mode)) {
    log.fatal(`Unknown mode: "${modeArg}"`, { validModes: VALID_MODES });
    await flushLogs();
    process.exit(1);
  }

  // Ensure infrastructure tables first — needed for lock acquisition.
  // Returns the set of missing contract tables (not fatal for verify mode).
  let missingTables = new Set<string>();
  try {
    missingTables = await ensureAllTables();
  } catch (e: any) {
    log.fatal("Failed to ensure infrastructure tables", { error: e?.message });
    await flushLogs();
    process.exit(1);
  }

  // For write modes, missing tables are fatal — exit 3.
  const mode = modeArg === "append" ? "daily" : modeArg;
  const writeModes = ["backfill", "daily", "repair", "dedup"];
  if (missingTables.size > 0 && writeModes.includes(mode)) {
    log.fatal(
      `${missingTables.size} required table(s) missing; cannot run ${mode}`,
      { missing: [...missingTables] }
    );
    await flushLogs();
    process.exit(3);
  }

  // Acquire lock. Verify mode is read-only, so it can skip the lock.
  const needsLock = modeArg !== "verify";
  let lockAcquired = false;

  if (needsLock) {
    lockAcquired = await acquireLock(LOCK_NAME, LOCK_HOLDER, CONFIG.LOCK_TTL_MS);
    if (!lockAcquired) {
      log.fatal(
        `Could not acquire lock ${LOCK_NAME}; another run is in progress`
      );
      await flushLogs();
      process.exit(2);
    }
    log.info(`Acquired lock ${LOCK_NAME}`, { holder: LOCK_HOLDER });
  }

  // Release on any exit path
  const release = async () => {
    if (lockAcquired) {
      try {
        await releaseLock(LOCK_NAME, LOCK_HOLDER);
        log.info(`Released lock ${LOCK_NAME}`);
      } catch (e: any) {
        log.warn(`Failed to release lock ${LOCK_NAME}`, { error: e?.message });
      }
    }
  };

  const onSignal = async (signal: string) => {
    log.warn(`Received ${signal}; releasing lock and exiting`);
    await release();
    await flushLogs();
    process.exit(130);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let exitCode = 0;

  // Record the run start in PipelineRuns. Non-fatal if it fails.
  try {
    await startPipelineRun(RUN_ID, mode, LOCK_HOLDER);
  } catch (e: any) {
    log.warn("Failed to record run start in PipelineRuns", { error: e?.message });
  }

  // Heartbeat: extend the lock every TTL/3 so a long-running backfill
  // doesn't lose its lock before finishing. Only active when lock is held.
  const heartbeatIntervalMs = lockAcquired
    ? Math.floor(CONFIG.LOCK_TTL_MS / 3)
    : 0;
  const heartbeat = lockAcquired
    ? setInterval(async () => {
        try {
          await extendLock(
            LOCK_NAME,
            LOCK_HOLDER,
            new Date(Date.now() + CONFIG.LOCK_TTL_MS)
          );
        } catch (e: any) {
          log.warn("Lock heartbeat failed; continuing", { error: e?.message });
        }
      }, heartbeatIntervalMs)
    : null;

  try {
    switch (mode) {
      case "backfill":
        await runBackfill(contractsFilter, missingTables);
        break;
      case "daily":
        await runDaily(contractsFilter, missingTables);
        break;
      case "verify":
        await runVerify(contractsFilter, missingTables);
        break;
      case "repair":
        await runRepair(contractsFilter, missingTables);
        break;
      case "dedup":
        await runDedup(contractsFilter, missingTables);
        break;
    }

    await logFinalSummary(missingTables);

    // For verify mode: exit 1 if ALL tables were missing (nothing verified).
    if (mode === "verify" && missingTables.size > 0) {
      const allMissing = [...missingTables].length === CONTRACT_CONFIGS.filter(c => c.enabled !== false).length;
      if (allMissing) exitCode = 1;
    }
  } catch (e: any) {
    log.fatal(`Run failed: ${e?.message}`, { stack: e?.stack });
    exitCode = 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await release();
  }

  // Record run completion. Non-fatal if it fails.
  const totalJobs = CONTRACT_CONFIGS
    .filter(c => c.enabled !== false && !missingTables.has(c.tableId))
    .flatMap(c => c.networkBindings.filter(b => b.enabled !== false));
  try {
    await completePipelineRun({
      runId: RUN_ID,
      exitCode,
      totalRowsMerged: 0, // aggregate row counts tracked per-job; 0 here is acceptable
      totalContracts: new Set(totalJobs.map(j => j.network.name)).size > 0
        ? CONTRACT_CONFIGS.filter(c => c.enabled !== false && !missingTables.has(c.tableId)).length
        : 0,
      totalNetworks: new Set(totalJobs.map(j => j.network.name)).size,
    });
  } catch (e: any) {
    log.warn("Failed to record run completion in PipelineRuns", { error: e?.message });
  }

  const elapsed = ((Date.now() - runStart) / 1000).toFixed(1);
  log.info(`Pipeline complete in ${elapsed}s`, { exit_code: exitCode });
  await flushLogs();
  process.exit(exitCode);
}

main().catch(async (e) => {
  log.fatal(`Unhandled error: ${e?.message}`, { stack: e?.stack });
  try {
    await releaseLock(LOCK_NAME, LOCK_HOLDER);
  } catch {
    // best-effort
  }
  await flushLogs();
  process.exit(1);
});
