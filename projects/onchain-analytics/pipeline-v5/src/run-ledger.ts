/**
 * run-ledger.ts -- the nonrecursive job-ledger contract. Plan Phase 3, task 12.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT. Task 12 says "DEFINE the nonrecursive job-ledger
 * contract", and the phase's deliverables list does not include a running terminalizer. That
 * split is not a convenience: the terminalizer is a BigQuery multi-statement transaction executed
 * by the mutation broker, which Phase 5 builds, under IAM grants that Phase 14 issues and
 * revokes. Phase 3 is forbidden from touching a cloud resource at all. So this module is the
 * CONTRACT in executable form: the shapes, the encodings, the hashes and the decisions, every one
 * of them a pure function that can be exercised on a laptop with no credential. Phases 5, 8 and
 * 14 wire it to jobs.insert, jobs.get and the receipt bucket. Nothing here submits anything.
 *
 * WHY A CONTRACT AND NOT A HELPER. The failure this guards against is a run reporting that it
 * closed when it did not, which is finding C2's shape one layer up. Three specific ways that
 * happens, all named in the plan and all encoded below:
 *
 *   1. RECURSION. If the terminalizer appends itself to the ledger it is terminalizing, the
 *      ledger can never be complete, so "every work job is terminal" becomes unprovable and the
 *      implementation quietly relaxes it. The terminalizer is therefore NOT a work job, by
 *      construction, and `appendJobTerminal` refuses it.
 *
 *   2. A LABEL THAT LOOKS RIGHT. BigQuery labels are lowercase, 63 characters, and a restricted
 *      alphabet. A 64-character hex hash does not fit, so the plan encodes it as base32 and
 *      requires a byte comparison against the canonical hex rather than a prefix match. This
 *      project has already produced a false finding by comparing a TRUNCATION of a value: three
 *      different token supplies compared equal because a uint256 is left-padded. Truncation is
 *      refused here rather than discouraged.
 *
 *   3. RECOVERY THAT GUESSES. After a crash the question is whether the terminalizer transaction
 *      committed. A successful COMMIT child is the authoritative witness, and it is authoritative
 *      even when the parent job and the trailing SELECT failed or were cancelled. If the COMMIT's
 *      status cannot be established, the honest answer is to stop, not to retry: retrying a
 *      transaction that may have committed is how one run gets two terminal rows.
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------- label encoding

/** The stages a job may be submitted under. Fixed lowercase enum, per plan task 12. */
export const JOB_STAGES = [
  "capture", "stage", "merge", "coverage", "oracle", "repair", "migration", "terminalizer",
] as const;
export type JobStage = (typeof JOB_STAGES)[number];

/** BigQuery's own label rules: lowercase letters, digits, dash and underscore, 63 characters. */
const LABEL_VALUE = /^[a-z0-9_-]{1,63}$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const LOWER_SHA1_40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-([1-8])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** RFC 4648 base32, lowercase, no padding. 32 bytes encode to exactly 52 characters. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32EncodeNoPad(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32DecodeNoPad(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`LABEL_ALPHABET: '${ch}' is not RFC 4648 lowercase base32`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** The 52-character label form of a 64-character lowercase hex hash. */
export function planHashLabel(hexHash: string): string {
  if (!LOWER_HEX_64.test(hexHash)) {
    throw new Error(`PLAN_HASH_SHAPE: expected 64 lowercase hex characters, got '${hexHash}'`);
  }
  return base32EncodeNoPad(Uint8Array.from(Buffer.from(hexHash, "hex")));
}

/**
 * Decode a plan-hash label and BYTE-COMPARE it against the canonical hex.
 *
 * Not a prefix match and not a length check. The plan says "decode the label and byte-compare it
 * with the canonical 64-character lowercase hex hash in submit intent, receipt ledger and
 * PipelineRuns; truncation is forbidden", and the reason that sentence exists is that a
 * comparison of truncated values has already manufactured a false result in this project.
 */
export function planHashLabelMatches(label: string, hexHash: string): boolean {
  if (!LOWER_HEX_64.test(hexHash)) return false;
  let decoded: Uint8Array;
  try {
    decoded = base32DecodeNoPad(label);
  } catch {
    return false;
  }
  const canonical = Uint8Array.from(Buffer.from(hexHash, "hex"));
  if (decoded.length !== canonical.length) return false;
  return decoded.every((b, i) => b === canonical[i]);
}

export interface JobLabels {
  readonly run_id: string;
  readonly stage: string;
  readonly release_sha: string;
  readonly plan_hash: string;
}

export interface LabelViolation {
  readonly key: string;
  readonly value: string;
  readonly reason: string;
}

/** The UUID version, or null when the string is not a UUID this contract accepts at all. */
export function uuidVersion(id: string): number | null {
  const m = UUID.exec(id);
  return m ? Number(m[1]) : null;
}

export interface LabelContext {
  /** True only for the authenticated A5 child path described in plan task 12. */
  readonly isRootedA5Child: boolean;
  /** The canonical hex plan hash the label must decode to. */
  readonly canonicalPlanHashHex: string;
}

/**
 * Validate a job's labels before `jobs.insert`. Returns every violation rather than the first,
 * because a caller fixing labels one round trip at a time is how a submission loop gets written.
 *
 * THE UUID VERSION RULE IS THE SHARP EDGE. Ordinary, remediation and A5 PARENT runs must be
 * UUIDv7. The sole exception is an A5 child or rooted A5 control/refresh child, which must be the
 * deterministic UUIDv5 derived from its parent and plan. Every other combination refuses: a
 * UUIDv5 outside that authenticated path, a UUIDv7 A5 child, and any other version. The point is
 * that a run id carries a claim about WHAT KIND of run it is, and an unchecked claim is the same
 * as no claim.
 */
export function validateJobLabels(labels: JobLabels, ctx: LabelContext): LabelViolation[] {
  const v: LabelViolation[] = [];
  const bad = (key: string, value: string, reason: string) => v.push({ key, value, reason });

  const version = uuidVersion(labels.run_id);
  if (labels.run_id !== labels.run_id.toLowerCase() || labels.run_id.length !== 36 || version === null) {
    bad("run_id", labels.run_id, "not a 36-character lowercase RFC 9562 UUID");
  } else if (ctx.isRootedA5Child) {
    if (version !== 5) {
      bad("run_id", labels.run_id,
        `a rooted A5 child must be the deterministic UUIDv5 derived from its parent and plan, not v${version}`);
    }
  } else if (version !== 7) {
    bad("run_id", labels.run_id,
      `an ordinary, remediation or A5 parent run must be UUIDv7, not v${version}` +
      (version === 5 ? "; a UUIDv5 outside the authenticated A5 child path refuses" : ""));
  }

  if (!(JOB_STAGES as readonly string[]).includes(labels.stage)) {
    bad("stage", labels.stage, `not one of the fixed lowercase stages ${JOB_STAGES.join(", ")}`);
  }

  if (!LOWER_SHA1_40.test(labels.release_sha)) {
    bad("release_sha", labels.release_sha, "not a 40-character lowercase Git SHA");
  }

  if (!planHashLabelMatches(labels.plan_hash, ctx.canonicalPlanHashHex)) {
    bad("plan_hash", labels.plan_hash,
      "does not DECODE, byte for byte, to the canonical 64-character lowercase hex plan hash; " +
      "a prefix or truncated match is not a match");
  }

  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_VALUE.test(value)) {
      bad(key, value, "outside BigQuery's lowercase label alphabet or over its 63-character limit");
    }
  }
  return v;
}

/**
 * The deterministic child run id, RFC 9562 UUIDv5 over the canonical tuple plan task 12 fixes.
 *
 * The tuple is joined with a separator that cannot occur in any member, so two different tuples
 * cannot render to one string. That is not pedantry: a delimiter collision is how a deterministic
 * id stops being deterministic, and the whole point of this id is that the wrapper can recompute
 * it byte for byte before submitting anything.
 */
export function deterministicChildRunId(
  namespaceUuid: string,
  parts: {
    parentRunId: string;
    manifestSetId: string;
    approvalRevisionOrZero: number;
    childPlanHash: string;
    globalOrControlOrdinal: number;
    attempt: number;
  },
): string {
  if (uuidVersion(parts.parentRunId) !== 7) {
    throw new Error(
      `A5_CHILD_PARENT: the parent run id must be a UUIDv7, got '${parts.parentRunId}'. A child ` +
      `derived from a non-v7 parent would be deterministic and meaningless.`
    );
  }
  const canonical = [
    parts.parentRunId, parts.manifestSetId, String(parts.approvalRevisionOrZero),
    parts.childPlanHash, String(parts.globalOrControlOrdinal), String(parts.attempt),
  ].join("\u001f");

  const ns = Buffer.from(namespaceUuid.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error(`A5_CHILD_NAMESPACE: '${namespaceUuid}' is not a UUID`);

  const digest = createHash("sha1").update(ns).update(Buffer.from(canonical, "utf8")).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ------------------------------------------------------------------------- the ledger itself

export type JobState = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

/** Terminal means the job cannot change again. PENDING and RUNNING are not terminal. */
export function isTerminal(state: JobState): boolean {
  return state === "DONE" || state === "FAILED" || state === "CANCELLED";
}

export interface SubmitIntent {
  readonly jobId: string;
  readonly location: string;
  readonly principal: string;
  readonly statementClass: string;
  readonly targets: readonly string[];
  readonly templateHash: string;
  readonly submittedAt: string;
  readonly stage: JobStage;
  /** Set for a generated child of a multi-statement script; null for an ordinary work job. */
  readonly parentJobId: string | null;
}

export interface JobTerminal {
  readonly jobId: string;
  readonly state: JobState;
  readonly errorMessage: string | null;
  readonly transactionId: string | null;
  readonly affectedRows: number | null;
}

export type LedgerEntry =
  | { readonly kind: "submit_intent"; readonly intent: SubmitIntent }
  | { readonly kind: "job_terminal"; readonly terminal: JobTerminal }
  | { readonly kind: "reconciliation"; readonly scannedJobIds: readonly string[]; readonly at: string }
  | { readonly kind: "terminalized_snapshot"; readonly rowHash: string; readonly ledgerHash: string;
      readonly terminalizerJobId: string; readonly terminalizerState: JobState }
  | { readonly kind: "read_only_report_snapshot"; readonly reportHash: string; readonly at: string }
  | { readonly kind: "closure"; readonly scanWatermark: string; readonly revokedBindings: readonly string[] }
  | { readonly kind: "closure_invalidated"; readonly lateJobIds: readonly string[] };

export class LedgerError extends Error {}

/**
 * The append-only work-job ledger for one run.
 *
 * THE TERMINALIZER IS NOT IN IT. That is the whole meaning of "nonrecursive", and it is enforced
 * here rather than remembered: `appendSubmitIntent` and `appendJobTerminal` both refuse a job
 * whose stage is `terminalizer`. Its id lives in `PipelineRuns.terminalizer_job_id` and its state
 * lives in the snapshot, neither of which is the ledger it closes.
 */
export class JobLedger {
  private readonly entries: LedgerEntry[] = [];
  private readonly intents = new Map<string, SubmitIntent>();
  private readonly terminals = new Map<string, JobTerminal>();

  constructor(readonly runId: string) {}

  /** Before `jobs.insert`, never after. An intent recorded afterwards fixes nothing. */
  appendSubmitIntent(intent: SubmitIntent): void {
    if (intent.stage === "terminalizer") {
      throw new LedgerError(
        "LEDGER_RECURSION: the terminalizer is not a work job and is never added to the ledger it " +
        "terminalizes. Its id belongs in PipelineRuns.terminalizer_job_id."
      );
    }
    if (this.intents.has(intent.jobId)) {
      throw new LedgerError(`LEDGER_DUPLICATE_INTENT: ${intent.jobId} already has a submit intent`);
    }
    this.intents.set(intent.jobId, intent);
    this.entries.push({ kind: "submit_intent", intent });
  }

  appendJobTerminal(terminal: JobTerminal): void {
    const intent = this.intents.get(terminal.jobId);
    if (!intent) {
      throw new LedgerError(
        `LEDGER_NO_INTENT: ${terminal.jobId} reported a terminal state with no submit intent. A job ` +
        `the ledger never authorised cannot be reconciled into it after the fact.`
      );
    }
    if (!isTerminal(terminal.state)) {
      throw new LedgerError(`LEDGER_NOT_TERMINAL: ${terminal.jobId} is ${terminal.state}`);
    }
    this.terminals.set(terminal.jobId, terminal);
    this.entries.push({ kind: "job_terminal", terminal });
  }

  append(entry: LedgerEntry): void {
    this.entries.push(entry);
  }

  get all(): readonly LedgerEntry[] {
    return this.entries;
  }

  /**
   * Every job that was submitted but has not reported a terminal state, plus every job the Jobs
   * API reported that this ledger never authorised.
   *
   * The second half is the one that matters. "Parent status alone is insufficient": a
   * multi-statement script's generated children are separate jobs, and a ledger that only knows
   * about the parent will call a run terminal while a child is still running.
   */
  reconcile(jobsApiIds: readonly string[]): { nonterminal: string[]; unledgered: string[] } {
    const nonterminal = [...this.intents.keys()].filter((id) => !this.terminals.has(id));
    const known = new Set(this.intents.keys());
    const unledgered = jobsApiIds.filter((id) => !known.has(id));
    return { nonterminal, unledgered };
  }

  /** True only when every authorised job is terminal AND the Jobs API surfaced nothing extra. */
  workJobsTerminal(jobsApiIds: readonly string[]): boolean {
    const { nonterminal, unledgered } = this.reconcile(jobsApiIds);
    return nonterminal.length === 0 && unledgered.length === 0;
  }

  /** Hash over the canonical ledger. Computed before terminalization, per plan task 12. */
  hash(): string {
    return sha256Hex(canonicalJson(this.entries));
  }
}

// --------------------------------------------------------- canonical_terminal_row_v1

/** BigQuery caps a receipt object at 256 KiB. Over it, terminalization refuses. */
export const RECEIPT_CAP_BYTES = 256 * 1024;

export type TypedValue =
  | { readonly type: "STRING"; readonly value: string | null }
  | { readonly type: "INT64"; readonly value: number | null }
  | { readonly type: "BOOL"; readonly value: boolean | null }
  | { readonly type: "TIMESTAMP"; readonly value: string | null }
  | { readonly type: "JSON"; readonly value: string | null };

/**
 * The complete versioned PipelineRuns row, as typed field/value pairs, fixed at intent creation.
 *
 * EVERY NULLABLE FIELD IS PRESENT AND EXPLICITLY NULL. That is not tidiness. The BigQuery client
 * cannot infer a type from a JS null and rejects the whole statement with "Parameter types must
 * be provided for null values"; this project lost a coverage row to exactly that. It is also what
 * makes the row reconstructable after a crash: a field that is absent and a field that is null
 * are indistinguishable in JSON, and recovery has to produce a BYTE-IDENTICAL row.
 */
export interface CanonicalTerminalRow {
  readonly version: "canonical_terminal_row_v1";
  readonly runId: string;
  readonly fields: Readonly<Record<string, TypedValue>>;
}

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace, no locale, no Date.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical rows built by
 * different code paths hash differently. Recovery builds the row from the stored intent and the
 * original built it from live counters, so those ARE two different code paths, and the whole
 * proof rests on their hashes matching.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as object).sort()) out[key] = walk((v as any)[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * The row hash: over the canonical final fields, EXCLUDING the hash field itself.
 *
 * A hash that covered itself would be uncomputable, and the usual mistake is to hash the row with
 * the field set to empty string and then compare against a row where it is populated. Excluding
 * the key entirely is the only form that both sides can reproduce.
 */
export const ROW_HASH_FIELD = "terminalized_row_hash";

export function terminalRowHash(row: CanonicalTerminalRow): string {
  const fields: Record<string, TypedValue> = { ...row.fields };
  delete fields[ROW_HASH_FIELD];
  return sha256Hex(canonicalJson({ version: row.version, runId: row.runId, fields }));
}

export interface TerminalizerIntent {
  readonly terminalizerJobId: string;
  readonly runId: string;
  readonly row: CanonicalTerminalRow;
  readonly rowHash: string;
  readonly ledgerHash: string;
  /** Fixed at intent creation. The script may not call CURRENT_TIMESTAMP() to replace it. */
  readonly terminalizedAt: string;
  readonly closureReceiptUri: string;
}

export function buildTerminalizerIntent(
  args: Omit<TerminalizerIntent, "rowHash">,
): TerminalizerIntent {
  const rowHash = terminalRowHash(args.row);
  const intent: TerminalizerIntent = { ...args, rowHash };
  const size = Buffer.byteLength(canonicalJson(intent), "utf8");
  if (size > RECEIPT_CAP_BYTES) {
    throw new LedgerError(
      `RECEIPT_TOO_LARGE: the terminalizer intent is ${size} bytes against a cap of ` +
      `${RECEIPT_CAP_BYTES}. Terminalization refuses rather than truncating: a receipt that does ` +
      `not contain the whole row cannot reconstruct it.`
    );
  }
  if (args.row.fields[ROW_HASH_FIELD] !== undefined &&
      args.row.fields[ROW_HASH_FIELD].value !== null) {
    throw new LedgerError(
      `ROW_HASH_PRESET: ${ROW_HASH_FIELD} must be null in the intent. It is computed over the ` +
      `other fields, so a preset value would be hashing a claim about itself.`
    );
  }
  return intent;
}

// ------------------------------------------------------------------------------- recovery

/**
 * What the Jobs API says about a terminalizer attempt after a crash.
 *
 * The fields are deliberately separate rather than a single "did it work". The plan's whole
 * recovery rule turns on the COMMIT child being authoritative INDEPENDENTLY of the parent and the
 * trailing SELECT, so collapsing them into one boolean would erase the distinction the rule is
 * made of.
 */
export interface TerminalizerJobEvidence {
  readonly parentState: JobState | "MISSING";
  /** Terminal state of the generated DML child, or MISSING when it never appeared. */
  readonly dmlChildState: JobState | "MISSING";
  readonly dmlChildAffectedRows: number | null;
  /** Terminal state of the generated COMMIT child. UNKNOWN is a real answer and it stops. */
  readonly commitChildState: JobState | "MISSING" | "UNKNOWN";
  /** Terminal state of the trailing no-FROM SELECT that returns the canonical row. */
  readonly trailingSelectState: JobState | "MISSING";
  /** True when the result of the trailing SELECT is still retrievable. */
  readonly resultAvailable: boolean;
  /** True only if a rollback has been POSITIVELY proven, not merely assumed from a failure. */
  readonly rollbackProven: boolean;
}

export type RecoveryAction =
  /** The transaction committed. Reconstruct the row from the intent. Submit nothing. */
  | { readonly action: "reconstruct_from_intent"; readonly reason: string }
  /** The result is still there. Read it; no reconstruction and no new job. */
  | { readonly action: "read_existing_result"; readonly reason: string }
  /** Rollback is proven. One linked recovery run may submit the next deterministic attempt. */
  | { readonly action: "retry_linked_recovery"; readonly reason: string }
  /** Ambiguous. Stop. Never guess whether a transaction committed. */
  | { readonly action: "stop"; readonly reason: string };

/**
 * Decide what a crashed terminalizer may do next.
 *
 * READ THE ORDER, IT IS THE CONTRACT. A successful COMMIT child freezes the attempt as committed
 * REGARDLESS of the parent's and the trailing SELECT's status, because the transaction is what
 * changed the world and the parent job is only the thing that asked for it. Only when no
 * successful COMMIT is provable does rollback matter, and rollback must be PROVEN rather than
 * inferred from a failure: a cancelled parent tells you nothing about whether its COMMIT child
 * landed first. Everything else stops.
 */
export function decideRecovery(e: TerminalizerJobEvidence): RecoveryAction {
  if (e.commitChildState === "DONE") {
    if (e.dmlChildState !== "DONE") {
      return {
        action: "stop",
        reason:
          `a COMMIT child succeeded but its DML child is ${e.dmlChildState}. The contiguous ` +
          `prefix is broken, so the committed transaction is not the one this intent describes.`,
      };
    }
    if (e.dmlChildAffectedRows !== 1) {
      return {
        action: "stop",
        reason:
          `a COMMIT child succeeded and the DML child reports ${e.dmlChildAffectedRows} affected ` +
          `row(s), not exactly 1. One run terminalizes exactly one row.`,
      };
    }
    if (e.resultAvailable && e.trailingSelectState === "DONE" && e.parentState === "DONE") {
      return {
        action: "read_existing_result",
        reason: "the parent and every generated child succeeded and the result is still retrievable",
      };
    }
    return {
      action: "reconstruct_from_intent",
      reason:
        `the COMMIT child succeeded and the DML child affected exactly one row, so the ` +
        `transaction committed. Parent is ${e.parentState} and the trailing SELECT is ` +
        `${e.trailingSelectState}, which is recorded in the snapshot and changes nothing: the ` +
        `row is reconstructed from canonical_terminal_row_v1 and NO replacement terminalizer is ` +
        `submitted.`,
    };
  }

  if (e.commitChildState === "UNKNOWN" || e.commitChildState === "MISSING") {
    if (e.rollbackProven) {
      return {
        action: "retry_linked_recovery",
        reason:
          "no COMMIT child is provable and rollback has been positively proven, so exactly one " +
          "linked recovery run may submit the next deterministic attempt id",
      };
    }
    return {
      action: "stop",
      reason:
        `the COMMIT child is ${e.commitChildState} and rollback is NOT proven. Retrying a ` +
        `transaction that may have committed is how one run acquires two terminal rows. ` +
        `Ambiguity stops.`,
    };
  }

  // The COMMIT child exists and did not succeed.
  if (e.rollbackProven) {
    return {
      action: "retry_linked_recovery",
      reason: `the COMMIT child is ${e.commitChildState} and rollback is proven`,
    };
  }
  return {
    action: "stop",
    reason:
      `the COMMIT child is ${e.commitChildState} and rollback is not proven. A failed or ` +
      `cancelled attempt must be proven rolled back before a linked recovery run may submit the ` +
      `next deterministic attempt id.`,
  };
}

/**
 * Rebuild the exact terminal row from the intent alone, and prove it is the intended one.
 *
 * Takes NOTHING but the immutable intent. It cannot scan PipelineRuns, cannot open a Storage Read
 * session and cannot submit a query, because it is a pure function over a value: there is nothing
 * here that could. That is the point of the plan's GREEN check counting zero `tabledata.list`,
 * zero Storage Read sessions and zero replacement `jobs.insert` calls.
 */
export function reconstructTerminalRow(intent: TerminalizerIntent): {
  row: CanonicalTerminalRow;
  rowHash: string;
} {
  const rowHash = terminalRowHash(intent.row);
  if (rowHash !== intent.rowHash) {
    throw new LedgerError(
      `ROW_HASH_MISMATCH: the intent's row hashes to ${rowHash} and the intent records ` +
      `${intent.rowHash}. All hashes must match or recovery stops.`
    );
  }
  const fields: Record<string, TypedValue> = {
    ...intent.row.fields,
    [ROW_HASH_FIELD]: { type: "STRING", value: rowHash },
  };
  return { row: { ...intent.row, fields }, rowHash };
}
