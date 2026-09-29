/**
 * two-process-merge.gate.ts -- the deterministic integration gate for `C1`, run against live
 * BigQuery sandboxes.
 *
 * WHY THIS IS NOT A VITEST FILE. It needs a credential, and `npm test` must run without one --
 * that is why the write-path tests elsewhere run against a simulator at all. Naming it `.gate.ts`
 * keeps it out of `vitest`'s glob and makes it an explicitly invoked command:
 *
 *     npm run gate:write-safety
 *
 * WHAT ONLY THIS CAN PROVE. Everything in `test/unit/write-safety.test.ts` runs in one process.
 * The lease is a real file and is genuinely contended even there, but one process cannot
 * demonstrate exclusion BETWEEN processes, and `C1` is two processes. So this spawns two, holds
 * them at a barrier so both are live before either merges, and lets them race for one table.
 *
 * WHAT IT ALSO PROVES, because the same run answers it for free: the staging split. A poller
 * watches both datasets for the whole merge and records where `_staging_*` tables appear. The
 * negative is the one that matters -- a staging table must never appear in the dataset holding
 * production rows.
 *
 * SAFETY. Every write goes to a freshly created, labelled sandbox dataset, through the guard in
 * `sandbox.ts`, which refuses `BlockchainEvents` by a hard-coded name that no configuration can
 * reach. `withSandbox` drops on the failure path too, and absence is proven by a listing rather
 * than by a delete call's return value.
 */

import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";import { createSandbox, dropSandbox, type SandboxHandle } from "../../src/sandbox.js";
import { bqQuery } from "../../src/bq.js";
import { CONFIG, RAW_LOGS_TABLE, RAW_LOGS_SCHEMA, MERGE_KEYS } from "../../src/config.js";
import { C1_KEY_COUNT } from "./c1-fixture.js";

const WORKER = resolve(import.meta.dirname, "two-process-merge.worker.ts");
const PROBE = resolve(import.meta.dirname, "cost-ceiling.probe.ts");
const OUT = resolve(process.argv[2] ?? join(tmpdir(), "c1-gate-result.json"));

interface WorkerResult {
  label: string;
  exitCode: number | null;
  stdout: string;
  parsed: Record<string, any> | null;
}

function runWorker(
  label: string, sibling: string, barrierDir: string, env: Record<string, string>
): Promise<WorkerResult> {
  return new Promise((resolveP) => {
    // `process.execPath` with the tsx loader, not `npx`. Node refuses to spawn a `.cmd` without a
    // shell on Windows, and routing this through a shell would make the child's environment and
    // quoting platform-dependent -- in a test whose entire subject is what two processes do.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", WORKER, label, barrierDir, sibling],
      { env: { ...process.env, ...env }, cwd: resolve(import.meta.dirname, "../.."), shell: false }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (exitCode) => {
      const line = stdout.split("\n").filter((l) => l.trim().startsWith("{")).pop();
      resolveP({
        label, exitCode, stdout: stdout + stderr,
        parsed: line ? JSON.parse(line) : null,
      });
    });
  });
}

/** Every table id in a dataset, read from INFORMATION_SCHEMA. Errors are not swallowed. */
async function tablesIn(datasetId: string): Promise<string[]> {
  const rows = await bqQuery(
    `SELECT table_name FROM \`${CONFIG.GCP_PROJECT_ID}.${datasetId}.INFORMATION_SCHEMA.TABLES\``
  );
  return rows.map((r: any) => String(r.table_name));
}

/**
 * Watch both datasets for the duration of the work and record every table seen in each.
 *
 * The question this answers is where staging tables physically live, and it has to be asked
 * WHILE a merge is running because the write path drops its staging table when it finishes.
 * The absence half -- no `_staging_*` ever seen in the production stand-in -- is the one the
 * permission boundary depends on.
 */
async function watchDatasets(
  target: string, staging: string, running: () => boolean
): Promise<{ seenInTarget: Set<string>; seenInStaging: Set<string>; samples: number; errors: number }> {
  const seenInTarget = new Set<string>();
  const seenInStaging = new Set<string>();
  let samples = 0;
  let errors = 0;
  while (running()) {
    try {
      for (const t of await tablesIn(target)) seenInTarget.add(t);
      for (const t of await tablesIn(staging)) seenInStaging.add(t);
      samples += 1;
    } catch {
      errors += 1;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { seenInTarget, seenInStaging, samples, errors };
}

function createRawLogsSql(datasetId: string): string {
  const cols = RAW_LOGS_SCHEMA
    .map((f) => `  ${f.name} ${f.type}${f.mode === "REQUIRED" ? " NOT NULL" : ""}`)
    .join(",\n");
  // The production shape, so the guard and the partitioning are exercised rather than assumed:
  // require_partition_filter is what refuses an unscoped MERGE, and it is the reason the window
  // has to be a literal at all.
  return `
CREATE TABLE IF NOT EXISTS \`${CONFIG.GCP_PROJECT_ID}.${datasetId}.${RAW_LOGS_TABLE}\`
(
${cols}
)
PARTITION BY TIMESTAMP_TRUNC(block_timestamp, MONTH)
CLUSTER BY chain_id, contract_address, topic0, block_number
OPTIONS(require_partition_filter = TRUE)`;
}

/** Stored rows against distinct merge keys, through a window wide enough to cover the fixture. */
async function keyCensus(datasetId: string): Promise<{ stored: number; distinct: number }> {
  const key = MERGE_KEYS[RAW_LOGS_TABLE].join(", ");
  const rows = await bqQuery(`
    WITH scoped AS (
      SELECT ${key} FROM \`${CONFIG.GCP_PROJECT_ID}.${datasetId}.${RAW_LOGS_TABLE}\`
      WHERE block_timestamp >= TIMESTAMP('2000-01-01 00:00:00')
        AND block_timestamp <  TIMESTAMP('2100-01-01 00:00:00')
    )
    SELECT (SELECT COUNT(*) FROM scoped) AS stored,
           (SELECT COUNT(*) FROM (SELECT DISTINCT ${key} FROM scoped)) AS distinct_keys`);
  return { stored: Number(rows[0].stored), distinct: Number(rows[0].distinct_keys) };
}

async function scenario(
  name: string, target: SandboxHandle, staging: SandboxHandle, waitMs: number,
  expectedKeys: number
): Promise<Record<string, any>> {
  await bqQuery(`DELETE FROM \`${CONFIG.GCP_PROJECT_ID}.${target.datasetId}.${RAW_LOGS_TABLE}\`
     WHERE block_timestamp >= TIMESTAMP('2000-01-01 00:00:00')
       AND block_timestamp <  TIMESTAMP('2100-01-01 00:00:00')`);

  const barrierDir = mkdtempSync(join(tmpdir(), `c1-barrier-${name}-`));
  const lockDir = mkdtempSync(join(tmpdir(), `c1-lock-${name}-`));
  mkdirSync(barrierDir, { recursive: true });

  const env = {
    DATASET_ID: target.datasetId,
    STAGING_DATASET_ID: staging.datasetId,
    WRITE_LOCK_DIR: lockDir,
    WRITE_LOCK_WAIT_MS: String(waitMs),
  };

  let done = false;
  const watcher = watchDatasets(target.datasetId, staging.datasetId, () => !done);
  const started = Date.now();
  const [a, b] = await Promise.all([
    runWorker("alpha", "beta", barrierDir, env),
    runWorker("beta", "alpha", barrierDir, env),
  ]);
  done = true;
  const watch = await watcher;
  const census = await keyCensus(target.datasetId);

  rmSync(barrierDir, { recursive: true, force: true });
  rmSync(lockDir, { recursive: true, force: true });

  const merged = [a, b].filter((w) => w.parsed?.outcome === "merged");
  const refused = [a, b].filter((w) => w.parsed?.outcome === "refused");
  const errored = [a, b].filter((w) => w.parsed?.outcome === "error" || w.parsed === null);

  // SERIALISATION, MEASURED FROM WHAT THE MERGES DID rather than from when they ran.
  //
  // The obvious measurement -- do the two workers' merge intervals overlap -- is WRONG here, and
  // it reported a false failure on the first run of this gate. Each worker times the whole
  // `stageAndMerge` call, which begins by WAITING for the lease, so the loser's interval starts
  // while the winner still holds it and the two always overlap no matter how perfectly they
  // serialised.
  //
  // The insert/update split is the real discriminator and is unambiguous. Serialised, the first
  // writer inserts every key and the second finds them all present and UPDATES them. Concurrent
  // -- which is the incident -- both writers match against a target snapshot taken before the
  // other inserted, so BOTH insert and the table holds two rows per key. So: exactly one worker
  // inserting everything and exactly one updating everything IS the proof of exclusion.
  const insertedAll = merged.filter((w) => w.parsed!.inserted === expectedKeys).length;
  const updatedAll = merged.filter((w) => w.parsed!.updated === expectedKeys).length;
  const serialisedBySplit = merged.length === 2 && insertedAll === 1 && updatedAll === 1;

  const intervals = merged
    .map((w) => ({ from: w.parsed!.startedAt as number, to: w.parsed!.finishedAt as number }))
    .sort((x, y) => x.from - y.from);
  const overlapped = intervals.length === 2 && intervals[0].to > intervals[1].from;

  return {
    scenario: name,
    write_lock_wait_ms: waitMs,
    elapsed_ms: Date.now() - started,
    workers: [a, b].map((w) => ({
      label: w.label, exit_code: w.exitCode, outcome: w.parsed?.outcome ?? "no-output",
      pid: w.parsed?.pid ?? null, inserted: w.parsed?.inserted ?? null,
      updated: w.parsed?.updated ?? null, message: w.parsed?.message ?? null,
      stdout_tail: w.parsed ? null : w.stdout.slice(-2000),
    })),
    merged_count: merged.length,
    refused_count: refused.length,
    errored_count: errored.length,
    serialised_by_insert_update_split: serialisedBySplit,
    workers_inserting_every_key: insertedAll,
    workers_updating_every_key: updatedAll,
    // Recorded, never gated on: this is always true when a waiter is given time, because the
    // interval includes the wait. See the note above.
    merge_intervals_overlapped: overlapped,
    stored_rows: census.stored,
    distinct_merge_keys: census.distinct,
    phantom_rows: census.stored - census.distinct,
    staging_tables_seen_in_target: [...watch.seenInTarget].filter((t) => t.startsWith("_staging_")),
    staging_tables_seen_in_staging: [...watch.seenInStaging].filter((t) => t.startsWith("_staging_")),
    tables_seen_in_target: [...watch.seenInTarget],
    watcher_samples: watch.samples,
    watcher_errors: watch.errors,
  };
}

/**
 * The cost ceiling, proven against live BigQuery rather than against a double.
 *
 * A child process runs one real statement with the ceiling set to one byte. BigQuery evaluates
 * the estimate BEFORE running the job and refuses it, so the refusal costs nothing -- which is
 * the whole property being claimed: refused rather than billed.
 */
function ceilingRefusalProbe(datasetId: string): Promise<WorkerResult> {
  return new Promise((resolveP) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", PROBE],
      {
        env: { ...process.env, DATASET_ID: datasetId, MAX_BYTES_BILLED_PER_JOB: "1" },
        cwd: resolve(import.meta.dirname, "../.."), shell: false,
      }
    );
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stdout += String(d); });
    child.on("close", (exitCode) => {
      const line = stdout.split("\n").filter((l) => l.trim().startsWith("{")).pop();
      resolveP({ label: "ceiling", exitCode, stdout, parsed: line ? JSON.parse(line) : null });
    });
  });
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const target = await createSandbox({ purpose: "unit06-c1-target", tableExpirationHours: 2 });
  let staging: SandboxHandle | null = null;
  const findings: Record<string, any> = { started_at: new Date(stamp).toISOString() };

  try {
    staging = await createSandbox({ purpose: "unit06-c1-staging", tableExpirationHours: 2 });
    findings.target_dataset = target.datasetId;
    findings.staging_dataset = staging.datasetId;
    findings.datasets_are_distinct = target.datasetId !== staging.datasetId;

    await bqQuery(createRawLogsSql(target.datasetId));

    // SERIALISE: both workers are given time to wait, so neither is refused.
    findings.serialise = await scenario("serialise", target, staging, 120_000, C1_KEY_COUNT);
    // REFUSE: neither worker waits, so the loser is told no immediately.
    findings.refuse = await scenario("refuse", target, staging, 0, C1_KEY_COUNT);

    const ceiling = await ceilingRefusalProbe(target.datasetId);
    findings.cost_ceiling = {
      outcome: ceiling.parsed?.outcome ?? "no-output",
      ceiling_bytes: ceiling.parsed?.ceiling ?? null,
      message: ceiling.parsed?.message ?? ceiling.stdout.slice(-800),
      exit_code: ceiling.exitCode,
    };
  } finally {
    findings.cleanup = {
      target: await dropSandbox(target).catch((e) => ({ error: String(e) })),
      staging: staging ? await dropSandbox(staging).catch((e) => ({ error: String(e) })) : null,
    };
  }

  // The verdict, stated as named clauses so a reader can see which one failed rather than
  // reading a boolean.
  const clauses: Record<string, boolean> = {
    "clause1 serialise or one fails nonzero":
      findings.serialise.serialised_by_insert_update_split
      || findings.serialise.refused_count === 1,
    "clause1 refusal exits nonzero":
      findings.refuse.refused_count === 1
      && findings.refuse.workers.some((w: any) => w.outcome === "refused" && w.exit_code !== 0),
    "clause2 one row per merge key after serialising":
      findings.serialise.stored_rows === C1_KEY_COUNT
      && findings.serialise.distinct_merge_keys === C1_KEY_COUNT,
    "clause2 one row per merge key after a refusal":
      findings.refuse.stored_rows === C1_KEY_COUNT
      && findings.refuse.distinct_merge_keys === C1_KEY_COUNT,
    "no worker errored":
      findings.serialise.errored_count === 0 && findings.refuse.errored_count === 0,
    "staging table appeared in the staging dataset":
      findings.serialise.staging_tables_seen_in_staging.length > 0,
    "no staging table ever appeared in the production stand-in":
      findings.serialise.staging_tables_seen_in_target.length === 0
      && findings.refuse.staging_tables_seen_in_target.length === 0,
    "over-ceiling job refused rather than billed":
      findings.cost_ceiling.outcome === "REFUSED",
    "both sandboxes proven absent":
      findings.cleanup.target?.provenAbsent === true
      && findings.cleanup.staging?.provenAbsent === true,
  };

  findings.clauses = clauses;
  findings.passed = Object.values(clauses).every(Boolean);
  findings.finished_at = new Date().toISOString();

  mkdirSync(resolve(OUT, ".."), { recursive: true });
  writeFileSync(OUT, JSON.stringify(findings, null, 2));

  for (const [name, ok] of Object.entries(clauses)) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log(`\n${findings.passed ? "GATE PASSED" : "GATE FAILED"} -- ${OUT}`);
  process.exit(findings.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
