/**
 * The nonrecursive job-ledger contract. Plan Phase 3, task 12, and its two RED/GREEN checks.
 *
 * THE TWO CHECKS THE PLAN NAMES, in its own words:
 *
 *   "Force the successful terminalizer query result unavailable, then reconstruct the exact
 *    snapshot solely from canonical_terminal_row_v1 plus successful parent/full-child metadata
 *    and one affected DML row. Assert byte-identical row/hash, zero tabledata.list, zero Storage
 *    Read, zero replacement jobs.insert and zero additional query jobs."
 *
 *   "Cancel once immediately after the COMMIT child succeeds but before the trailing no-FROM
 *    SELECT completes. The parent may be cancelled/failed and the result absent; recovery must
 *    recognize the successful COMMIT plus one-row DML, reconstruct the exact snapshot, close
 *    normally and submit zero replacement terminalizers. A sibling fixture cancelled before
 *    COMMIT must prove rollback before one linked retry; an ambiguous/missing COMMIT status must
 *    stop rather than guess."
 *
 * HOW THE "ZERO CALLS" HALF IS PROVEN, and why it is proven rather than asserted. Recovery is
 * handed a client whose every method THROWS. If reconstruction touched BigQuery in any way the
 * test would fail with that client's own error, not with a count. A counter that nobody
 * increments reads the same as a call that never happened, which is the failure shape this
 * project keeps finding.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { setBigQueryClient, resetAdapters } from "../../src/adapters.js";
import {
  JobLedger, LedgerError, JOB_STAGES,
  base32EncodeNoPad, base32DecodeNoPad, planHashLabel, planHashLabelMatches,
  validateJobLabels, uuidVersion, deterministicChildRunId,
  canonicalJson, sha256Hex, terminalRowHash, buildTerminalizerIntent, reconstructTerminalRow,
  decideRecovery, isTerminal, ROW_HASH_FIELD, RECEIPT_CAP_BYTES,
  type CanonicalTerminalRow, type SubmitIntent, type TerminalizerJobEvidence, type TypedValue,
} from "../../src/run-ledger.js";

/** The plan's own SHA-256, which is what a real writer binds to. */
const PLAN_HASH_HEX = "9dcde225459127c4da2beadf9094fd894fe193010f39cb70c0753dd874853e26";
const RELEASE_SHA = "17b82df3c2cd24c5601a541b44b3a2a80f09c292";
const RUN_V7 = "0199a3c4-5d6e-7f80-8123-456789abcdef";
const RUN_V5 = "0199a3c4-5d6e-5f80-8123-456789abcdef";
const RUN_V4 = "0199a3c4-5d6e-4f80-8123-456789abcdef";

function intent(jobId: string, stage: (typeof JOB_STAGES)[number] = "merge"): SubmitIntent {
  return {
    jobId, location: "US", principal: "pipeline@example.invalid",
    statementClass: "MERGE", targets: ["BlockchainEvents.RawLogs"],
    templateHash: sha256Hex("template"), submittedAt: "2026-09-28T00:00:00.000Z",
    stage, parentJobId: null,
  };
}

function row(overrides: Record<string, TypedValue> = {}): CanonicalTerminalRow {
  return {
    version: "canonical_terminal_row_v1",
    runId: RUN_V7,
    fields: {
      run_id: { type: "STRING", value: RUN_V7 },
      execution_status: { type: "STRING", value: "completed" },
      units_planned: { type: "INT64", value: 3 },
      units_completed: { type: "INT64", value: 3 },
      units_refused: { type: "INT64", value: 0 },
      work_jobs_terminal: { type: "BOOL", value: true },
      terminalized_at: { type: "TIMESTAMP", value: "2026-09-28T01:00:00.000Z" },
      closure_receipt_uri: { type: "STRING", value: "sandbox/receipts/run/closure.json" },
      bigquery_job_ledger: { type: "JSON", value: "[]" },
      // Present and explicitly null. A missing key and a null key are the same in JSON, and
      // recovery has to reproduce the row byte for byte.
      parent_run_id: { type: "STRING", value: null },
      error_message: { type: "STRING", value: null },
      [ROW_HASH_FIELD]: { type: "STRING", value: null },
      ...overrides,
    },
  };
}

describe("label encoding refuses anything that merely looks right", () => {
  it("round-trips a 32-byte hash through 52 characters of lowercase base32", () => {
    const label = planHashLabel(PLAN_HASH_HEX);
    expect(label).toHaveLength(52);
    expect(label).toMatch(/^[a-z2-7]{52}$/);
    expect(Buffer.from(base32DecodeNoPad(label)).toString("hex")).toBe(PLAN_HASH_HEX);
  });

  it("compares by DECODED BYTES, so a truncation is not a match", () => {
    const label = planHashLabel(PLAN_HASH_HEX);
    expect(planHashLabelMatches(label, PLAN_HASH_HEX)).toBe(true);
    // A prefix of the right label. A prefix comparison would accept this, and a prefix comparison
    // has already produced a false finding in this project by comparing padded uint256 values.
    expect(planHashLabelMatches(label.slice(0, 40), PLAN_HASH_HEX)).toBe(false);
    // One character different, same length.
    const flipped = (label[0] === "a" ? "b" : "a") + label.slice(1);
    expect(planHashLabelMatches(flipped, PLAN_HASH_HEX)).toBe(false);
    expect(planHashLabelMatches("not base32 at all!", PLAN_HASH_HEX)).toBe(false);
  });

  it("refuses a plan hash that is not 64 lowercase hex characters", () => {
    expect(() => planHashLabel(PLAN_HASH_HEX.toUpperCase())).toThrow(/PLAN_HASH_SHAPE/);
    expect(() => planHashLabel(PLAN_HASH_HEX.slice(0, 63))).toThrow(/PLAN_HASH_SHAPE/);
  });

  it("encodes the empty input and short inputs without padding", () => {
    expect(base32EncodeNoPad(Uint8Array.from([]))).toBe("");
    expect(Buffer.from(base32DecodeNoPad(base32EncodeNoPad(Uint8Array.from([1, 2, 3]))))
      .toString("hex")).toBe("010203");
  });
});

describe("a run id carries a claim about what kind of run it is, and the claim is checked", () => {
  const ctx = { isRootedA5Child: false, canonicalPlanHashHex: PLAN_HASH_HEX };
  const labels = (over: Partial<Record<string, string>> = {}) => ({
    run_id: RUN_V7, stage: "merge", release_sha: RELEASE_SHA,
    plan_hash: planHashLabel(PLAN_HASH_HEX), ...over,
  });

  it("accepts a well-formed ordinary parent run", () => {
    expect(validateJobLabels(labels(), ctx)).toEqual([]);
  });

  it("refuses a UUIDv5 outside the authenticated A5 child path", () => {
    const v = validateJobLabels(labels({ run_id: RUN_V5 }), ctx);
    expect(v.map((x) => x.key)).toContain("run_id");
    expect(v[0].reason).toMatch(/must be UUIDv7, not v5/);
    expect(v[0].reason).toMatch(/outside the authenticated A5 child path refuses/);
  });

  it("refuses a UUIDv7 A5 child, which is the mirror-image mistake", () => {
    const v = validateJobLabels(labels(), { ...ctx, isRootedA5Child: true });
    expect(v[0].reason).toMatch(/must be the deterministic UUIDv5/);
  });

  it("accepts a UUIDv5 on the A5 child path and nowhere else", () => {
    expect(validateJobLabels(labels({ run_id: RUN_V5 }), { ...ctx, isRootedA5Child: true })).toEqual([]);
  });

  it("refuses every other UUID version, an unknown stage and a bad release SHA", () => {
    expect(validateJobLabels(labels({ run_id: RUN_V4 }), ctx)[0].reason).toMatch(/not v4/);
    expect(validateJobLabels(labels({ stage: "whatever" }), ctx).map((x) => x.key)).toContain("stage");
    expect(validateJobLabels(labels({ release_sha: "ABCDEF" }), ctx).map((x) => x.key))
      .toContain("release_sha");
  });

  it("refuses a value outside BigQuery's label alphabet or over 63 characters", () => {
    const v = validateJobLabels(labels({ stage: "MERGE" }), ctx);
    expect(v.some((x) => x.reason.includes("63-character limit") || x.reason.includes("alphabet")))
      .toBe(true);
    // The canonical hex hash is 64 characters, which is why the base32 form exists at all.
    expect(PLAN_HASH_HEX.length).toBe(64);
    expect(planHashLabel(PLAN_HASH_HEX).length).toBeLessThanOrEqual(63);
  });

  it("reports every violation in one pass rather than the first", () => {
    const v = validateJobLabels(
      { run_id: "nope", stage: "nope", release_sha: "nope", plan_hash: "nope" }, ctx);
    expect(v.map((x) => x.key).sort()).toEqual(["plan_hash", "release_sha", "run_id", "stage"]);
  });
});

describe("the deterministic A5 child id is recomputable byte for byte", () => {
  const ns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const parts = {
    parentRunId: RUN_V7, manifestSetId: "manifest-1", approvalRevisionOrZero: 0,
    childPlanHash: sha256Hex("child-plan"), globalOrControlOrdinal: 3, attempt: 1,
  };

  it("produces a UUIDv5 and the same one every time", () => {
    const a = deterministicChildRunId(ns, parts);
    expect(uuidVersion(a)).toBe(5);
    expect(deterministicChildRunId(ns, parts)).toBe(a);
  });

  it("changes when any single component of the canonical tuple changes", () => {
    const base = deterministicChildRunId(ns, parts);
    expect(deterministicChildRunId(ns, { ...parts, attempt: 2 })).not.toBe(base);
    expect(deterministicChildRunId(ns, { ...parts, globalOrControlOrdinal: 4 })).not.toBe(base);
    expect(deterministicChildRunId(ns, { ...parts, manifestSetId: "manifest-2" })).not.toBe(base);
    // A delimiter collision would make these two tuples render identically. They must not.
    expect(deterministicChildRunId(ns, { ...parts, manifestSetId: "manifest", approvalRevisionOrZero: 10 }))
      .not.toBe(deterministicChildRunId(ns, { ...parts, manifestSetId: "manifest-1", approvalRevisionOrZero: 0 }));
  });

  it("refuses a parent that is not a UUIDv7", () => {
    expect(() => deterministicChildRunId(ns, { ...parts, parentRunId: RUN_V5 }))
      .toThrow(/A5_CHILD_PARENT/);
  });
});

describe("the ledger is append-only and NEVER contains its own terminalizer", () => {
  it("refuses a terminalizer submit intent outright", () => {
    const ledger = new JobLedger(RUN_V7);
    expect(() => ledger.appendSubmitIntent(intent("job-t", "terminalizer")))
      .toThrow(LedgerError);
    expect(() => ledger.appendSubmitIntent(intent("job-t", "terminalizer")))
      .toThrow(/LEDGER_RECURSION/);
  });

  it("refuses a terminal state for a job it never authorised", () => {
    const ledger = new JobLedger(RUN_V7);
    expect(() => ledger.appendJobTerminal({
      jobId: "ghost", state: "DONE", errorMessage: null, transactionId: null, affectedRows: 1,
    })).toThrow(/LEDGER_NO_INTENT/);
  });

  it("refuses a nonterminal state and a duplicate intent", () => {
    const ledger = new JobLedger(RUN_V7);
    ledger.appendSubmitIntent(intent("job-1"));
    expect(() => ledger.appendSubmitIntent(intent("job-1"))).toThrow(/LEDGER_DUPLICATE_INTENT/);
    expect(() => ledger.appendJobTerminal({
      jobId: "job-1", state: "RUNNING", errorMessage: null, transactionId: null, affectedRows: null,
    })).toThrow(/LEDGER_NOT_TERMINAL/);
    expect(isTerminal("RUNNING")).toBe(false);
    expect(["DONE", "FAILED", "CANCELLED"].every(isTerminal as any)).toBe(true);
  });

  it("is not terminal while a generated child the Jobs API knows about is unledgered", () => {
    const ledger = new JobLedger(RUN_V7);
    ledger.appendSubmitIntent(intent("parent-1"));
    ledger.appendJobTerminal({
      jobId: "parent-1", state: "DONE", errorMessage: null, transactionId: "tx1", affectedRows: 1,
    });

    // Parent status alone is insufficient: a multi-statement script's generated children are
    // separate jobs and the Jobs API is where they surface.
    expect(ledger.workJobsTerminal(["parent-1"])).toBe(true);
    expect(ledger.workJobsTerminal(["parent-1", "parent-1_child_0"])).toBe(false);
    expect(ledger.reconcile(["parent-1", "parent-1_child_0"]).unledgered).toEqual(["parent-1_child_0"]);
  });

  it("is not terminal while an authorised job has not reported", () => {
    const ledger = new JobLedger(RUN_V7);
    ledger.appendSubmitIntent(intent("job-1"));
    ledger.appendSubmitIntent(intent("job-2"));
    ledger.appendJobTerminal({
      jobId: "job-1", state: "DONE", errorMessage: null, transactionId: null, affectedRows: 1,
    });
    expect(ledger.reconcile(["job-1", "job-2"]).nonterminal).toEqual(["job-2"]);
    expect(ledger.workJobsTerminal(["job-1", "job-2"])).toBe(false);
  });

  it("hashes to a value that moves when the ledger does", () => {
    const ledger = new JobLedger(RUN_V7);
    const before = ledger.hash();
    ledger.appendSubmitIntent(intent("job-1"));
    expect(ledger.hash()).not.toBe(before);
  });
});

describe("canonical_terminal_row_v1 hashes the same from either code path", () => {
  it("is insensitive to key insertion order and sensitive to every value", () => {
    const a = row();
    const reordered: CanonicalTerminalRow = {
      version: a.version, runId: a.runId,
      fields: Object.fromEntries(Object.entries(a.fields).reverse()),
    };
    // Recovery builds the row from the stored intent and the original built it from live
    // counters. Those ARE two different code paths, and the whole proof rests on them agreeing.
    expect(terminalRowHash(reordered)).toBe(terminalRowHash(a));
    expect(terminalRowHash(row({ units_completed: { type: "INT64", value: 4 } })))
      .not.toBe(terminalRowHash(a));
  });

  it("excludes the hash field itself rather than blanking it", () => {
    const withNull = row();
    const withoutKey: CanonicalTerminalRow = {
      ...withNull,
      fields: Object.fromEntries(
        Object.entries(withNull.fields).filter(([k]) => k !== ROW_HASH_FIELD)),
    };
    expect(terminalRowHash(withoutKey)).toBe(terminalRowHash(withNull));
    // And a populated hash field must not change the hash either, or a row could never be
    // verified after it was written.
    const populated = row({ [ROW_HASH_FIELD]: { type: "STRING", value: "deadbeef" } });
    expect(terminalRowHash(populated)).toBe(terminalRowHash(withNull));
  });

  it("distinguishes an absent field from a null one in the canonical form", () => {
    const withNull = canonicalJson({ a: 1, b: null });
    const withoutB = canonicalJson({ a: 1 });
    expect(withNull).not.toBe(withoutB);
  });

  it("refuses an intent over the 256 KiB receipt cap instead of truncating it", () => {
    const huge = row({ bigquery_job_ledger: { type: "JSON", value: "x".repeat(RECEIPT_CAP_BYTES) } });
    expect(() => buildTerminalizerIntent({
      terminalizerJobId: "t-1", runId: RUN_V7, row: huge, ledgerHash: sha256Hex("l"),
      terminalizedAt: "2026-09-28T01:00:00.000Z", closureReceiptUri: "sandbox/c.json",
    })).toThrow(/RECEIPT_TOO_LARGE/);
  });

  it("refuses an intent whose row already claims a hash", () => {
    expect(() => buildTerminalizerIntent({
      terminalizerJobId: "t-1", runId: RUN_V7,
      row: row({ [ROW_HASH_FIELD]: { type: "STRING", value: "preset" } }),
      ledgerHash: sha256Hex("l"),
      terminalizedAt: "2026-09-28T01:00:00.000Z", closureReceiptUri: "sandbox/c.json",
    })).toThrow(/ROW_HASH_PRESET/);
  });
});

describe("recovery after the terminalizer result is gone", () => {
  const theIntent = buildTerminalizerIntent({
    terminalizerJobId: "t-1", runId: RUN_V7, row: row(), ledgerHash: sha256Hex("ledger"),
    terminalizedAt: "2026-09-28T01:00:00.000Z",
    closureReceiptUri: "sandbox/receipts/run/closure.json",
  });

  const evidence = (over: Partial<TerminalizerJobEvidence> = {}): TerminalizerJobEvidence => ({
    parentState: "DONE", dmlChildState: "DONE", dmlChildAffectedRows: 1,
    commitChildState: "DONE", trailingSelectState: "DONE",
    resultAvailable: true, rollbackProven: false, ...over,
  });

  it("reads the existing result when everything succeeded and it is still there", () => {
    expect(decideRecovery(evidence()).action).toBe("read_existing_result");
  });

  it("reconstructs the EXACT row from the intent alone when the result has expired", () => {
    const decision = decideRecovery(evidence({ resultAvailable: false }));
    expect(decision.action).toBe("reconstruct_from_intent");

    const { row: rebuilt, rowHash } = reconstructTerminalRow(theIntent);

    // Byte-identical, which is the plan's word. Not "equivalent", not "the same fields".
    expect(rowHash).toBe(theIntent.rowHash);
    expect(rebuilt.fields[ROW_HASH_FIELD]).toEqual({ type: "STRING", value: theIntent.rowHash });
    expect(canonicalJson({ ...rebuilt, fields: { ...rebuilt.fields, [ROW_HASH_FIELD]: { type: "STRING", value: null } } }))
      .toBe(canonicalJson(theIntent.row));
  });

  it("reconstructs with zero BigQuery access of any kind, proven two ways", () => {
    // ONE: the only route to a client in this codebase is `getBigQueryClient()`, so an installed
    // client whose every member throws is a real tripwire. If reconstruction reached BigQuery for
    // a tabledata.list, a Storage Read session, a replacement jobs.insert or any additional query
    // job, this fails with that client's own error rather than with a count of zero.
    setBigQueryClient({
      query: () => { throw new Error("RECOVERY_TOUCHED_BIGQUERY"); },
      dataset: () => { throw new Error("RECOVERY_TOUCHED_BIGQUERY"); },
    } as any);
    try {
      const { rowHash, row: rebuilt } = reconstructTerminalRow(theIntent);
      expect(rowHash).toBe(theIntent.rowHash);
      expect(rebuilt.runId).toBe(RUN_V7);
    } finally {
      resetAdapters();
    }

    // TWO: the tripwire only covers what the module could reach at runtime on this path, so the
    // structural claim is checked directly. `run-ledger.ts` imports node's crypto and nothing
    // else. A module that cannot see a client cannot call one on any path, not just this one.
    const source = readFileSync(new URL("../../src/run-ledger.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .*?from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["crypto"]);
  });

  it("treats the COMMIT child as authoritative even when the parent was cancelled", () => {
    // The plan's fixture: cancel immediately after COMMIT succeeds and before the trailing SELECT
    // completes. The parent may be cancelled and the result absent, and the run still closed.
    const decision = decideRecovery(evidence({
      parentState: "CANCELLED", trailingSelectState: "MISSING", resultAvailable: false,
    }));
    expect(decision.action).toBe("reconstruct_from_intent");
    expect(decision.reason).toMatch(/NO replacement terminalizer is submitted/);
  });

  it("allows exactly one linked retry when rollback is PROVEN", () => {
    const decision = decideRecovery(evidence({
      commitChildState: "CANCELLED", trailingSelectState: "MISSING",
      resultAvailable: false, rollbackProven: true,
    }));
    expect(decision.action).toBe("retry_linked_recovery");
  });

  it("stops rather than guessing when the COMMIT status is ambiguous or missing", () => {
    for (const state of ["UNKNOWN", "MISSING"] as const) {
      const decision = decideRecovery(evidence({
        commitChildState: state, resultAvailable: false, rollbackProven: false,
      }));
      expect(decision.action, state).toBe("stop");
      expect(decision.reason).toMatch(/two terminal rows|Ambiguity stops|not proven/);
    }
  });

  it("stops when a COMMIT succeeded over a broken prefix or the wrong number of rows", () => {
    expect(decideRecovery(evidence({ dmlChildState: "MISSING" })).action).toBe("stop");
    expect(decideRecovery(evidence({ dmlChildAffectedRows: 2 })).action).toBe("stop");
    expect(decideRecovery(evidence({ dmlChildAffectedRows: 0 })).reason)
      .toMatch(/not exactly 1/);
  });

  it("refuses to reconstruct a row whose hash does not match its intent", () => {
    const tampered = { ...theIntent, rowHash: sha256Hex("something else") };
    expect(() => reconstructTerminalRow(tampered)).toThrow(/ROW_HASH_MISMATCH/);
  });
});
