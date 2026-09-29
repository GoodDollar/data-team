/**
 * two-process-merge.worker.ts -- one of the two captures in the `C1` reproduction.
 *
 * Runs as a GENUINELY SEPARATE OS PROCESS. That is not a detail of the setup, it is the subject:
 * `C1` is two processes, and a test that calls `stageAndMerge` twice in one process is testing
 * microtask ordering. This project has already recorded one wrong conclusion drawn from
 * within-process repetition.
 *
 * The worker takes its target and staging datasets from the environment, so the parent points it
 * at sandboxes. It reads no chain and plans nothing: it stages a fixed set of rows and merges
 * them, which is exactly the part of a capture the defect lives in.
 *
 * Two files coordinate the start, because both MERGEs have to be in flight at once for the
 * defect to be reachable at all. Each worker writes its own ready marker and waits for its
 * sibling's, so neither can start before the other exists.
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { stageAndMerge } from "../../src/bq.js";
import { RAW_LOGS_TABLE, RAW_LOGS_SCHEMA } from "../../src/config.js";
import { windowForRows } from "../../src/window.js";
import { C1_ROWS } from "./c1-fixture.js";

const label = process.argv[2];
const barrierDir = process.argv[3];
const siblingLabel = process.argv[4];

async function main(): Promise<void> {
  mkdirSync(barrierDir, { recursive: true });
  writeFileSync(join(barrierDir, `${label}.ready`), String(process.pid));

  // Wait for the sibling process to exist. Bounded, because a barrier that can hang turns a
  // failed test into a stuck one.
  const deadline = Date.now() + 60_000;
  while (!existsSync(join(barrierDir, `${siblingLabel}.ready`))) {
    if (Date.now() > deadline) throw new Error(`BARRIER_TIMEOUT: ${siblingLabel} never started`);
    await new Promise((r) => setTimeout(r, 10));
  }

  const rows = C1_ROWS();
  const startedAt = Date.now();
  const result = await stageAndMerge(
    RAW_LOGS_TABLE, rows, RAW_LOGS_SCHEMA, `c1-${label}`, windowForRows(rows, 1)!
  );
  process.stdout.write(JSON.stringify({
    outcome: "merged", label, pid: process.pid,
    startedAt, finishedAt: Date.now(), ...result,
  }) + "\n");
}

main().then(
  () => process.exit(0),
  (e: any) => {
    // A refused lease is the DESIGNED outcome for the losing writer, and it has to be
    // distinguishable from a crash by the exit code and by the reason, not by reading a log.
    const refused = String(e?.message ?? e).includes("WRITE_LOCK_REFUSED");
    process.stdout.write(JSON.stringify({
      outcome: refused ? "refused" : "error", label, pid: process.pid,
      message: String(e?.message ?? e),
    }) + "\n");
    process.exit(refused ? 3 : 1);
  }
);
