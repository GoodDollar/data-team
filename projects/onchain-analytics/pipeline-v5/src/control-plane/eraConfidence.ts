/**
 * eraConfidence.ts -- the confidence grade an era interval carries, and the rule that assigns it.
 *
 * WHAT A GRADE IS FOR. It answers "how wrong could this interval be", never "may I proceed".
 * The shipped control previously refused every `raw_only_unproven` interval, which is all of them,
 * because the bar it enforced demanded an invariant EIP-1967 declined to require: upgrade events
 * SHOULD be emitted, not MUST, and OpenZeppelin's own `_upgradeToAndCallUUPS` reaches
 * `_setImplementation` through a branch that writes the slot and emits nothing. Applying that bar
 * honestly produced 0 provable eras out of 41. A standard that cannot discriminate a
 * well-understood contract from an unknown one moves no decision; it only hides the difference.
 * So the grade propagates and the refusals live elsewhere, on conditions that are actually
 * actionable -- no ABI, an undeclared ambiguity, a failed magnitude tripwire.
 *
 * THE RULE IS PUBLISHED, NOT INFERRED. The field-to-grade mapping implemented here was written
 * down and hashed BEFORE a single grade was assigned, so no grade is a post-hoc rationalisation of
 * whatever the data happened to look like. A grade nobody can re-derive is not evidence.
 *
 * TWO SOURCES, DELIBERATELY UNEQUAL. Rule A reads a promoted boundary-evidence row, which carries
 * a second reader's verdict. Rule B reads only the registry seed, which does not -- so Rule B is
 * CAPPED at `slot_bisected` by construction. A grade claiming two agreeing voices has to be able
 * to name both.
 */

import { join } from "path";
import { readStrictCsv } from "./csv.js";
import { SEEDS_DIR } from "./chains.js";
import type { RegistryRow } from "./contractRegistry.js";

export const CONFIDENCE_GRADES = ["corroborated", "slot_bisected", "announced", "inferred"] as const;
export type ConfidenceGrade = (typeof CONFIDENCE_GRADES)[number];

/** Strongest first. Used for ordering and for the Rule B cap; never for a refusal. */
export const GRADE_STRENGTH: Readonly<Record<ConfidenceGrade, number>> = {
  corroborated: 4,
  slot_bisected: 3,
  announced: 2,
  inferred: 1,
};

/**
 * One era's promoted boundary evidence -- the flattened Phase 2B manifest, as it ships in
 * `gd_dbt/seeds/era_boundary_evidence.csv`.
 *
 * Every field here is one the published rule names. Fields the rule does NOT read are still
 * carried when they let a reader judge the evidence for themselves; `obligatorilyEmits` is the
 * clearest case -- it is false on every manifest, so it cannot discriminate between eras, but it
 * is the reason no era reaches `complete` and hiding it would make the grades look arbitrary.
 */
export interface EraBoundaryEvidence {
  readonly chain: string;
  readonly chainId: number;
  readonly proxyAddress: string;
  readonly eraIndex: number;
  readonly implementationAddress: string | null;
  readonly validFromBlock: number;
  readonly openEnded: boolean;
  /** The transition that OPENS this era, from `transitions[]`. Null when none was recorded. */
  readonly openingTransitionKind: string | null;
  readonly openingEventImplementation: string | null;
  readonly openingBothMeasured: boolean | null;
  readonly openingAddressAgrees: boolean | null;
  readonly openingOrderAgrees: boolean | null;
  /** `architecture.slots.eip1967Implementation`, contract level. */
  readonly slotOutcome: string | null;
  readonly slotAddress: string | null;
  readonly slotAgreeing: number | null;
  readonly slotErrorCount: number | null;
  /** `slotCrossCheck`, contract level. */
  readonly crossCheckBlocked: boolean;
  readonly checkPointsMeasured: number;
  readonly checkPointsDisagreeing: number;
  /** `baseline`, contract level. */
  readonly claimedEvents: number;
  readonly independentlyConfirmedEvents: number;
  readonly baselineSkippedChunks: number;
  /** `tail`, contract level. */
  readonly tailComplete: boolean;
  readonly tailSkippedChunks: number;
  readonly tailErrorChunks: number;
  /** Carried for the reader, not read by the rule. See the note above. */
  readonly obligatorilyEmits: boolean;
  readonly frozenSafeHead: number;
  readonly boundaryCheckedThroughBlock: number;
  readonly sourceManifest: string;
  readonly manifestSha256: string;
}

export interface GradeVerdict {
  readonly grade: ConfidenceGrade;
  /** The clause that decided it: A1-A5 or B1-B4. Named so any grade is re-derivable. */
  readonly clause: string;
  readonly reason: string;
  readonly source: "boundary_evidence" | "registry_seed";
}

/**
 * A slot reading is admissible when it is a positive answer agreed by two or more readers.
 *
 * A ZERO reading is admissible as a measured absence only when its error count is zero, because
 * an absence is a measurement only when nothing failed while measuring it. A non-zero error count
 * alongside a positive answer that two readers agree on does not void the answer -- it is carried
 * into the receipt so a reader can weigh it.
 */
export function slotReadingAdmissible(e: Pick<EraBoundaryEvidence, "slotOutcome" | "slotAgreeing" | "slotErrorCount">): boolean {
  if (e.slotOutcome === "answer") return (e.slotAgreeing ?? 0) >= 2;
  if (e.slotOutcome === "zero") return (e.slotAgreeing ?? 0) >= 2 && e.slotErrorCount === 0;
  return false;
}

/**
 * Rule A. The grade of an era the Phase 2B manifests cover.
 *
 * Clauses are evaluated in order and the first match wins.
 */
export function gradeFromBoundaryEvidence(e: EraBoundaryEvidence): GradeVerdict {
  const announced = e.openingEventImplementation !== null;
  const bisectedHere = e.openingBothMeasured === true && e.openingAddressAgrees === true;
  const allEventsConfirmed = e.claimedEvents > 0 && e.independentlyConfirmedEvents === e.claimedEvents;

  // A1. Two structurally different instruments agree: contract state at the boundary, and a second
  // reader of the log. Requiring BOTH is what makes the name mean what it says -- either one alone
  // is a single voice, which is the tier below.
  if (announced && bisectedHere && e.openingOrderAgrees === true && e.checkPointsDisagreeing === 0 && allEventsConfirmed) {
    return {
      grade: "corroborated",
      clause: "A1",
      source: "boundary_evidence",
      reason:
        `the opening transition is announced by ${e.openingEventImplementation}, the EIP-1967 slot was read either ` +
        `side of block ${e.validFromBlock} and agrees on both address and order with no disagreeing checkpoint, and all ` +
        `${e.claimedEvents} claimed upgrade event(s) were independently re-read`,
    };
  }

  // A2. The boundary itself was bisected, but the second voice is missing or only partial. A
  // partial event-confirmation count is a CONTRACT-level number and cannot be attributed to one
  // era, so it buys nothing here rather than being rounded up.
  if (bisectedHere) {
    return {
      grade: "slot_bisected",
      clause: "A2",
      source: "boundary_evidence",
      reason:
        `the EIP-1967 slot was read either side of block ${e.validFromBlock} and agrees on address, but the second ` +
        `independent reader does not close: ${e.independentlyConfirmedEvents} of ${e.claimedEvents} claimed event(s) confirmed`,
    };
  }

  // A3. The live era only. A head slot read names the implementation currently behind the proxy,
  // which binds this interval's right edge. It says nothing about any closed interval, so it is
  // deliberately unavailable to them.
  if (e.openEnded && slotReadingAdmissible(e) && e.slotAddress !== null && e.implementationAddress !== null
      && e.slotAddress.toLowerCase() === e.implementationAddress.toLowerCase()) {
    return {
      grade: "slot_bisected",
      clause: "A3",
      source: "boundary_evidence",
      reason:
        `the live era: the EIP-1967 implementation slot read ${e.slotAddress} with ${e.slotAgreeing} agreeing reader(s), ` +
        `matching this era's implementation. The boundary itself was not bisected (${e.checkPointsMeasured} checkpoint(s) measured)`,
    };
  }

  // A4. An on-chain record bounds the interval, the record has no known hole, and an independent
  // check was at least POSSIBLE. Without that last clause a chain where no second reader can run
  // at any level of patience would grade the same as one where the check ran and agreed.
  const recordWhole = e.baselineSkippedChunks === 0 && e.tailComplete && e.tailSkippedChunks === 0 && e.tailErrorChunks === 0;
  const checkWasPossible = !e.crossCheckBlocked || e.independentlyConfirmedEvents > 0;
  if (announced && recordWhole && checkWasPossible) {
    return {
      grade: "announced",
      clause: "A4",
      source: "boundary_evidence",
      reason:
        `an on-chain transition (${e.openingTransitionKind}) bounds the interval at block ${e.validFromBlock}, the ` +
        `announcement record has no skipped or errored chunk, and an independent check was available. No state read binds this era`,
    };
  }

  return {
    grade: "inferred",
    clause: "A5",
    source: "boundary_evidence",
    reason:
      `the interval edge rests on a single unchallenged source: ` +
      `${announced ? "announced" : "no opening transition recorded"}, ` +
      `cross-check ${e.crossCheckBlocked ? "BLOCKED" : "available"}, ` +
      `${e.independentlyConfirmedEvents} of ${e.claimedEvents} event(s) independently confirmed, ` +
      `record ${recordWhole ? "whole" : "has a hole"}`,
  };
}

/** The era-evidence vocabulary the registry seed carries. */
const REGISTRY_BISECTED = new Set(["slot_bisection_and_announcement_log", "slot_bisection_only"]);
const REGISTRY_TWO_VOICE_CREATION = new Set([
  "explorer_index_and_state_read_agree",
  "explorer_creation_tx_plus_receipt_two_endpoints_agreeing",
]);

/**
 * Rule B. The grade of an in-scope era with no promoted boundary evidence.
 *
 * CAPPED AT `slot_bisected`. The registry records how an era was found; it does not carry a second
 * reader's verdict, so `corroborated` is unreachable from it and saying so in the code is what
 * stops a future edit quietly promoting a whole column.
 */
export function gradeFromRegistryRow(row: RegistryRow): GradeVerdict {
  if (REGISTRY_BISECTED.has(row.eraEvidence)) {
    return {
      grade: "slot_bisected",
      clause: "B1",
      source: "registry_seed",
      reason: `era_evidence is '${row.eraEvidence}': the implementation slot was read and binds this interval, from one voice`,
    };
  }
  if (row.eraEvidence === "announcement_log_only") {
    return {
      grade: "announced",
      clause: "B2",
      source: "registry_seed",
      reason: "era_evidence is 'announcement_log_only': an upgrade log bounds the interval and no state read binds it",
    };
  }
  if (row.eraEvidence === "contract_creation" && REGISTRY_TWO_VOICE_CREATION.has(row.creationMethod)) {
    return {
      grade: "announced",
      clause: "B3",
      source: "registry_seed",
      reason: `the interval opens at contract creation, established by '${row.creationMethod}', which names two agreeing voices`,
    };
  }
  return {
    grade: "inferred",
    clause: "B4",
    source: "registry_seed",
    reason: `era_evidence '${row.eraEvidence}' with creation_method '${row.creationMethod}' rests on a single unchallenged source`,
  };
}

/**
 * The grade for one registry row, preferring promoted boundary evidence when it exists.
 *
 * The evidence map is keyed `chainId|proxyAddress|eraIndex`.
 */
export function gradeForEra(row: RegistryRow, evidence: ReadonlyMap<string, EraBoundaryEvidence>): GradeVerdict {
  const e = evidence.get(eraEvidenceKey(row.chainId, row.proxyAddress, row.eraIndex));
  return e ? gradeFromBoundaryEvidence(e) : gradeFromRegistryRow(row);
}

export function eraEvidenceKey(chainId: number, proxyAddress: string, eraIndex: number): string {
  return `${chainId}|${proxyAddress.toLowerCase()}|${eraIndex}`;
}

export const ERA_BOUNDARY_EVIDENCE_PATH = join(SEEDS_DIR, "era_boundary_evidence.csv");

export const ERA_BOUNDARY_EVIDENCE_HEADER = [
  "chain", "chain_id", "proxy_address", "era_index", "implementation_address",
  "valid_from_block", "valid_to_block", "open_ended",
  "opening_transition_kind", "opening_event_implementation",
  "opening_both_measured", "opening_address_agrees", "opening_order_agrees",
  "slot_outcome", "slot_address", "slot_agreeing", "slot_error_count",
  "cross_check_blocked", "check_points_total", "check_points_measured", "check_points_disagreeing",
  "claimed_events", "independently_confirmed_events", "baseline_skipped_chunks",
  "tail_complete", "tail_skipped_chunks", "tail_error_chunks",
  "obligatorily_emits", "frozen_safe_head", "boundary_checked_through_block",
  "source_manifest", "manifest_sha256",
] as const;

/** `"true"` / `"false"` / `""`, where the empty string means the question was never answered. */
function triBool(raw: string): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function num(raw: string): number {
  return raw === "" ? 0 : Number(raw);
}

/**
 * Read the promoted boundary-evidence seed.
 *
 * This is the artifact an outside reader opens to re-derive any manifest-backed grade, which is
 * the whole reason the Phase 2B manifests were promoted out of a gitignored scratch directory: a
 * receipt nobody else can open is not a receipt.
 */
export function parseEraBoundaryEvidence(path = ERA_BOUNDARY_EVIDENCE_PATH): Map<string, EraBoundaryEvidence> {
  const csv = readStrictCsv(path, [ERA_BOUNDARY_EVIDENCE_HEADER]);
  const out = new Map<string, EraBoundaryEvidence>();
  for (const r of csv.records) {
    const [
      chain, chainId, proxyAddress, eraIndex, implementationAddress,
      validFromBlock, , openEnded,
      openingTransitionKind, openingEventImplementation,
      openingBothMeasured, openingAddressAgrees, openingOrderAgrees,
      slotOutcome, slotAddress, slotAgreeing, slotErrorCount,
      crossCheckBlocked, , checkPointsMeasured, checkPointsDisagreeing,
      claimedEvents, independentlyConfirmedEvents, baselineSkippedChunks,
      tailComplete, tailSkippedChunks, tailErrorChunks,
      obligatorilyEmits, frozenSafeHead, boundaryCheckedThroughBlock,
      sourceManifest, manifestSha256,
    ] = r;

    const row: EraBoundaryEvidence = {
      chain,
      chainId: Number(chainId),
      proxyAddress,
      eraIndex: Number(eraIndex),
      implementationAddress: implementationAddress === "" ? null : implementationAddress,
      validFromBlock: Number(validFromBlock),
      openEnded: openEnded === "true",
      openingTransitionKind: openingTransitionKind === "" ? null : openingTransitionKind,
      openingEventImplementation: openingEventImplementation === "" ? null : openingEventImplementation,
      openingBothMeasured: triBool(openingBothMeasured),
      openingAddressAgrees: triBool(openingAddressAgrees),
      openingOrderAgrees: triBool(openingOrderAgrees),
      slotOutcome: slotOutcome === "" ? null : slotOutcome,
      slotAddress: slotAddress === "" ? null : slotAddress,
      slotAgreeing: slotAgreeing === "" ? null : Number(slotAgreeing),
      slotErrorCount: slotErrorCount === "" ? null : Number(slotErrorCount),
      crossCheckBlocked: crossCheckBlocked === "true",
      checkPointsMeasured: num(checkPointsMeasured),
      checkPointsDisagreeing: num(checkPointsDisagreeing),
      claimedEvents: num(claimedEvents),
      independentlyConfirmedEvents: num(independentlyConfirmedEvents),
      baselineSkippedChunks: num(baselineSkippedChunks),
      tailComplete: tailComplete === "true",
      tailSkippedChunks: num(tailSkippedChunks),
      tailErrorChunks: num(tailErrorChunks),
      obligatorilyEmits: obligatorilyEmits === "true",
      frozenSafeHead: num(frozenSafeHead),
      boundaryCheckedThroughBlock: num(boundaryCheckedThroughBlock),
      sourceManifest,
      manifestSha256,
    };
    out.set(eraEvidenceKey(row.chainId, row.proxyAddress, row.eraIndex), row);
  }
  return out;
}
