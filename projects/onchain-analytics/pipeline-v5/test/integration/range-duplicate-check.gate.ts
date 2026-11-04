/**
 * range-duplicate-check.gate.ts -- runs the duplicate check that follows every ingestion against
 * live BigQuery, in a disposable sandbox.
 *
 *     npm run gate:dup-check
 *
 * WHAT ONLY THIS CAN PROVE. The unit tests run the check's statements through a simulator, which
 * models what they mean but not whether BigQuery accepts them. This builds RawLogs and Transactions
 * with the production partitioning, clustering and require_partition_filter, creates a real
 * duplicate through a real MERGE, and runs the real check: the statements have to be accepted by
 * the partition guard, and the check has to find the duplicate and pass a clean write.
 *
 * WHAT IT DOES NOT PROVE: bytes at production scale. The sandbox holds a handful of rows, so the
 * bytes it reads say nothing about a month of RawLogs. That number comes from a dry run after the
 * trial load. What protects production until then is the per-job ceiling every statement carries:
 * an over-ceiling check is refused before it bills, and a check that cannot run fails the run.
 *
 * SAFETY. Both datasets are created through `sandbox.ts`, labelled, with tables expiring after two
 * hours, and dropped in a `finally` with absence proven by a listing.
 */

import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createSandbox, dropSandbox, type SandboxHandle } from "../../src/sandbox.js";
import { bqQuery } from "../../src/bq.js";
import {
  CONFIG, RAW_LOGS_TABLE, TRANSACTIONS_TABLE, RAW_LOGS_SCHEMA, TRANSACTIONS_SCHEMA,
} from "../../src/config.js";
import type { SchemaField } from "../../src/types.js";

const WORKER = resolve(import.meta.dirname, "range-duplicate-check.worker.ts");
const OUT = resolve(process.argv[2] ?? join(tmpdir(), "dup-check-gate-result.json"));

/** The production shape of each table, so the guard is exercised rather than assumed. */
function createTableSql(datasetId: string, tableId: string, schema: SchemaField[], cluster: string): string {
  const cols = schema.map((f) => `  ${f.name} ${f.type}${f.mode === "REQUIRED" ? " NOT NULL" : ""}`).join(",\n");
  return `
CREATE TABLE \`${CONFIG.GCP_PROJECT_ID}.${datasetId}.${tableId}\`
(
${cols}
)
PARTITION BY TIMESTAMP_TRUNC(block_timestamp, MONTH)
CLUSTER BY ${cluster}
OPTIONS(require_partition_filter = TRUE)`;
}

function runWorker(env: Record<string, string>): Promise<{ exitCode: number | null; output: string; parsed: any }> {
  return new Promise((done) => {
    // `process.execPath` with the tsx loader, for the reason two-process-merge.gate.ts gives.
    const child = spawn(process.execPath, ["--import", "tsx", WORKER], {
      env: { ...process.env, ...env }, cwd: resolve(import.meta.dirname, "../.."), shell: false,
    });
    let output = "";
    child.stdout.on("data", (d) => { output += String(d); });
    child.stderr.on("data", (d) => { output += String(d); });
    child.on("close", (exitCode) => {
      const line = output.split("\n").filter((l) => l.trim().startsWith("{\"outcome\"")).pop();
      done({ exitCode, output, parsed: line ? JSON.parse(line) : null });
    });
  });
}

async function main(): Promise<void> {
  const findings: Record<string, any> = { started_at: new Date().toISOString() };
  const target = await createSandbox({ purpose: "dup-check-target", tableExpirationHours: 2 });
  let staging: SandboxHandle | null = null;
  const lockDir = mkdtempSync(join(tmpdir(), "dup-check-lock-"));

  try {
    staging = await createSandbox({ purpose: "dup-check-staging", tableExpirationHours: 2 });
    findings.target_dataset = target.datasetId;
    findings.staging_dataset = staging.datasetId;

    await bqQuery(createTableSql(target.datasetId, RAW_LOGS_TABLE, RAW_LOGS_SCHEMA,
      "chain_id, contract_address, topic0, block_number"));
    await bqQuery(createTableSql(target.datasetId, TRANSACTIONS_TABLE, TRANSACTIONS_SCHEMA,
      "chain_id, tx_hash, from_address, block_number"));

    const worker = await runWorker({
      DATASET_ID: target.datasetId,
      STAGING_DATASET_ID: staging.datasetId,
      WRITE_LOCK_DIR: lockDir,
    });
    findings.worker_exit_code = worker.exitCode;
    findings.worker = worker.parsed ?? { outcome: "no-output", output: worker.output.slice(-2000) };
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
    findings.cleanup = {
      target: await dropSandbox(target).catch((e) => ({ error: String(e) })),
      staging: staging ? await dropSandbox(staging).catch((e) => ({ error: String(e) })) : null,
    };
  }

  const cleaned = [findings.cleanup.target, findings.cleanup.staging]
    .every((c: any) => c && c.provenAbsent === true);
  findings.passed = findings.worker?.outcome === "passed" && findings.worker_exit_code === 0 && cleaned;
  findings.sandboxes_proven_absent = cleaned;

  writeFileSync(OUT, JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2));
  console.log(`\nGATE ${findings.passed ? "PASSED" : "FAILED"}. Full result: ${OUT}`);
  process.exit(findings.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(`GATE ERRORED: ${e?.stack ?? e}`);
  process.exit(1);
});
