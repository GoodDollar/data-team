/**
 * KNOWN FAILURE: a refusal is reported as success.
 *
 *   C2  Both budget guards refuse work and the process exits zero.
 *       Owner: Phase 3 (CLI and outcome agent). Ownership matrix: "CLI outcome tests and run rows".
 *
 * RECEIPTS THESE ENCODE, from `specs/system/readiness-audit-2026-09-25.md` section C2.
 *
 *   Global guard, runtime receipt: bare `daily` planned 142 targets against a limit of 12, logged
 *   REFUSED, read nothing, wrote no refusal coverage row, persisted zero planned and zero failed
 *   captures, and exited 0.
 *
 *   Per-capture guard, runtime receipt: one implicit XDC backfill requested 12,394,045 blocks
 *   against a 1,296,000 limit. It wrote one RawLogs `refused_budget` row, counted the contract as
 *   processed successfully, recorded one planned and one successful capture, and exited 0. It
 *   wrote no corresponding Transactions refusal row.
 *
 * These are pure control-flow defects, so nothing here is simulated away: the real `runPipeline`
 * runs, against the BigQuery simulator, and the exit code is computed by the CLI's own
 * `captureExitCode`, which `main` calls verbatim.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runPipeline } from "../../src/pipeline.js";
import { captureExitCode } from "../../src/index.js";
import { checkRunSize, checkCaptureSpan, DEFAULT_MAX_CAPTURES } from "../../src/budget.js";
import { NETWORKS } from "../../src/config.js";
import { setBigQueryClient, resetAdapters } from "../../src/adapters.js";
import { BigQuerySimulator } from "../helpers/bq-simulator.js";

let sim: BigQuerySimulator;

beforeEach(() => {
  sim = new BigQuerySimulator();
  setBigQueryClient(sim);
});

afterEach(() => resetAdapters());

describe("C2: the global run-size refusal exits zero", () => {
  it("exits nonzero when a run is refused before it reads anything", async () => {
    // Every chain, every contract in the shipped registry, against the default limit of 12. This
    // is the bare `daily` the scheduled workflow runs.
    const verdict = checkRunSize(142, { mode: "daily" });
    expect(verdict.allowed, "precondition: the guard must refuse this run").toBe(false);

    const result = await runPipeline({ mode: "daily" });
    const exitCode = captureExitCode(result.succeeded, result.failed);

    expect(
      exitCode,
      `C2 reproduced (global guard): the run was refused and the process exit code is ${exitCode}. ` +
      `pipeline-v5/src/pipeline.ts runPipeline() returns { succeeded: 0, failed: 0 } on a global ` +
      `refusal, and pipeline-v5/src/index.ts captureExitCode() reads failed === 0 as success. ` +
      `A refused run is therefore indistinguishable from a clean one to anything automatic. ` +
      `The result shape cannot express "refused" at all: it has no field for it. Owner: Phase 3.`
    ).not.toBe(0);
  });

  it("persists a refusal row so the refused range is queryable afterwards", async () => {
    await runPipeline({ mode: "daily" });

    const coverage = sim.tables.get("IngestionCoverage")?.rows ?? [];
    const refusals = coverage.filter((r) => r.status === "refused_budget");

    expect(
      refusals.length,
      `C2 reproduced (global guard, second half): the run was refused and ${coverage.length} ` +
      `coverage row(s) exist, none with status refused_budget. runPipeline() returns before the ` +
      `target loop, so no range is recorded as declined anywhere. L0-8 exists to make "nobody ` +
      `looked at this range" a queryable fact, and a global refusal is exactly that. ` +
      `Owner: Phase 3.`
    ).toBeGreaterThan(0);
  });
});

describe("C2: a per-capture budget refusal is counted as a success", () => {
  it("counts a refused capture as failed rather than succeeded", async () => {
    const xdc = NETWORKS.XDC;
    const span = checkCaptureSpan(xdc, 95_000_000, 107_394_045, { mode: "backfill" });
    expect(span.allowed, "precondition: the guard must refuse this span").toBe(false);

    // One contract, so the global guard cannot fire and the per-capture guard is what decides.
    // `--to` alone, never `--from`: an explicit from AND to is always allowed by design, so
    // supplying both would disable the guard under test. This also keeps the chain tip out of it,
    // which is what makes the test reach no network.
    const result = await runPipeline({
      mode: "daily",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
      toBlock: 107_394_045,
      maxCaptures: DEFAULT_MAX_CAPTURES,
    });
    const exitCode = captureExitCode(result.succeeded, result.failed);

    expect(
      exitCode,
      `C2 reproduced (per-capture guard): ${result.succeeded} capture(s) recorded successful, ` +
      `${result.failed} failed, exit ${exitCode}. pipeline-v5/src/pipeline.ts processTarget() ` +
      `writes a refused_budget coverage row and then RETURNS 0, and the caller at the bottom of ` +
      `runPipeline() treats any non-throwing return as a success. A zero-row return means two ` +
      `different things, "read nothing because there was nothing" and "refused to read", and the ` +
      `call site cannot tell them apart. Owner: Phase 3.`
    ).not.toBe(0);
  });

  it("records a refusal against BOTH grains, or says why one does not apply", async () => {
    await runPipeline({
      mode: "daily",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
      toBlock: 107_394_045,
    });

    const coverage = sim.tables.get("IngestionCoverage")?.rows ?? [];
    const refused = coverage.filter((r) => r.status === "refused_budget");
    const grains = new Set(refused.map((r) => r.target_table));

    expect(
      [...grains].sort(),
      `C2 reproduced (grain asymmetry): the refusal wrote ${refused.length} coverage row(s) ` +
      `covering grain(s) ${[...grains].join(", ") || "(none)"}. processTarget() returns from the ` +
      `refusal branch before it reaches the Transactions coverage row, so the transaction grain ` +
      `carries no record that its range was declined and an empty Transactions range there reads ` +
      `as "no transactions" rather than "never attempted". Owner: Phase 3.`
    ).toEqual(["RawLogs", "Transactions"]);
  });
});
