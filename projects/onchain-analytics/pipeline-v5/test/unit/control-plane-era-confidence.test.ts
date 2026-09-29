/**
 * The era confidence-grade rule.
 *
 * The rule was published and hashed BEFORE any grade was assigned, so these tests pin a mapping
 * that already existed rather than describing whatever the data turned out to look like. Each
 * clause gets a case, in both directions where the clause has two.
 */

import { describe, it, expect } from "vitest";
import {
  gradeFromBoundaryEvidence,
  gradeFromRegistryRow,
  gradeForEra,
  parseEraBoundaryEvidence,
  slotReadingAdmissible,
  eraEvidenceKey,
  CONFIDENCE_GRADES,
  GRADE_STRENGTH,
  type EraBoundaryEvidence,
} from "../../src/control-plane/eraConfidence.js";
import { parseRegistry } from "../../src/control-plane/contractRegistry.js";
import { registryRowWithBoundary, writeRegistryWithBoundary, INT64_MAX } from "../helpers/seed-fixtures.js";

/** A fully corroborated era: bisected boundary, agreeing order, every event re-read. */
const BASE: EraBoundaryEvidence = {
  chain: "XDC", chainId: 50, proxyAddress: "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf",
  eraIndex: 1, implementationAddress: "0x1111111111111111111111111111111111111111",
  validFromBlock: 95144756, openEnded: false,
  openingTransitionKind: "interior_boundary",
  openingEventImplementation: "0x1111111111111111111111111111111111111111",
  openingBothMeasured: true, openingAddressAgrees: true, openingOrderAgrees: true,
  slotOutcome: "answer", slotAddress: "0x1111111111111111111111111111111111111111",
  slotAgreeing: 2, slotErrorCount: 0,
  crossCheckBlocked: false, checkPointsMeasured: 5, checkPointsDisagreeing: 0,
  claimedEvents: 2, independentlyConfirmedEvents: 2, baselineSkippedChunks: 0,
  tailComplete: true, tailSkippedChunks: 0, tailErrorChunks: 0,
  obligatorilyEmits: false, frozenSafeHead: 107765548, boundaryCheckedThroughBlock: 107576852,
  sourceManifest: "fixture.json", manifestSha256: "ab".repeat(32),
};

const ev = (o: Partial<EraBoundaryEvidence>): EraBoundaryEvidence => ({ ...BASE, ...o });

describe("rule A: the grade of an era a boundary manifest covers", () => {
  it("A1 corroborated -- the slot agrees at the boundary AND every event was independently re-read", () => {
    const v = gradeFromBoundaryEvidence(BASE);
    expect(v.grade).toBe("corroborated");
    expect(v.clause).toBe("A1");
    expect(v.source).toBe("boundary_evidence");
  });

  it("A1 needs BOTH voices: a bisected boundary alone drops to A2", () => {
    // 1 of 2 confirmed. A contract-level count cannot be attributed to one era, so a partial
    // count buys nothing rather than being rounded up -- which is the whole reason this is A2.
    const v = gradeFromBoundaryEvidence(ev({ independentlyConfirmedEvents: 1 }));
    expect(v.grade).toBe("slot_bisected");
    expect(v.clause).toBe("A2");
    expect(v.reason).toContain("1 of 2");
  });

  it("A1 needs BOTH voices: full event confirmation alone does not reach it", () => {
    const v = gradeFromBoundaryEvidence(ev({ openingBothMeasured: false, openingAddressAgrees: null, openingOrderAgrees: null }));
    expect(v.grade).not.toBe("corroborated");
  });

  it("A1 is refused when any checkpoint on the contract disagreed", () => {
    expect(gradeFromBoundaryEvidence(ev({ checkPointsDisagreeing: 1 })).clause).toBe("A2");
  });

  it("A3 slot_bisected -- the live era's implementation matches an admissible head slot read", () => {
    const v = gradeFromBoundaryEvidence(ev({
      openEnded: true, openingBothMeasured: false, openingAddressAgrees: null, openingOrderAgrees: null,
      checkPointsMeasured: 0, independentlyConfirmedEvents: 1,
    }));
    expect(v.grade).toBe("slot_bisected");
    expect(v.clause).toBe("A3");
  });

  it("A3 is unavailable to a CLOSED era, because a head read says nothing about one", () => {
    const closed = ev({
      openEnded: false, openingBothMeasured: false, openingAddressAgrees: null, openingOrderAgrees: null,
      checkPointsMeasured: 0, independentlyConfirmedEvents: 1,
    });
    expect(gradeFromBoundaryEvidence(closed).clause).toBe("A4");
  });

  it("A3 is unavailable when the head slot names a DIFFERENT implementation", () => {
    const v = gradeFromBoundaryEvidence(ev({
      openEnded: true, openingBothMeasured: false, openingAddressAgrees: null, openingOrderAgrees: null,
      slotAddress: "0x9999999999999999999999999999999999999999", independentlyConfirmedEvents: 1,
    }));
    expect(v.clause).toBe("A4");
  });

  it("A4 announced -- an on-chain record bounds it, whole, with an independent check available", () => {
    const v = gradeFromBoundaryEvidence(ev({
      openingBothMeasured: false, openingAddressAgrees: null, openingOrderAgrees: null,
      checkPointsMeasured: 0, independentlyConfirmedEvents: 1,
    }));
    expect(v.grade).toBe("announced");
    expect(v.clause).toBe("A4");
  });

  it("A4 drops to A5 when the announcement record has a hole", () => {
    const holed = ev({
      openingBothMeasured: false, openingAddressAgrees: null, openingOrderAgrees: null,
      independentlyConfirmedEvents: 1, tailErrorChunks: 1,
    });
    expect(gradeFromBoundaryEvidence(holed).clause).toBe("A5");
  });

  it("A5 inferred -- no independent check is available AT ALL, which is Fuse's case exactly", () => {
    const v = gradeFromBoundaryEvidence(ev({
      openingBothMeasured: false, openingAddressAgrees: null, openingOrderAgrees: null,
      crossCheckBlocked: true, checkPointsMeasured: 0, independentlyConfirmedEvents: 0,
    }));
    expect(v.grade).toBe("inferred");
    expect(v.clause).toBe("A5");
    expect(v.reason).toContain("BLOCKED");
  });

  it("A5 when no transition opens the era at all", () => {
    expect(gradeFromBoundaryEvidence(ev({
      openingEventImplementation: null, openingBothMeasured: false,
      openingAddressAgrees: null, openingOrderAgrees: null, independentlyConfirmedEvents: 1,
    })).clause).toBe("A5");
  });

  it("obligatorilyEmits is carried but never decides, because it has one value everywhere", () => {
    // It reads false on all six shipped manifests, so it cannot separate one era from another.
    // It is the reason no era reaches `complete`, which is a statement about the REMOVED gate.
    expect(gradeFromBoundaryEvidence(ev({ obligatorilyEmits: true })).grade)
      .toBe(gradeFromBoundaryEvidence(ev({ obligatorilyEmits: false })).grade);
  });
});

describe("a slot reading is admissible only when two or more readers agree", () => {
  it("accepts a positive answer agreed by two", () => {
    expect(slotReadingAdmissible({ slotOutcome: "answer", slotAgreeing: 2, slotErrorCount: 0 })).toBe(true);
  });

  it("accepts a positive answer even with a non-zero error count, and says so in the rule", () => {
    // A non-zero error alongside a POSITIVE answer two readers agree on does not void the answer.
    // The error count is carried into the receipt so a reader can weigh it.
    expect(slotReadingAdmissible({ slotOutcome: "answer", slotAgreeing: 2, slotErrorCount: 1 })).toBe(true);
  });

  it("refuses a single reader", () => {
    expect(slotReadingAdmissible({ slotOutcome: "answer", slotAgreeing: 1, slotErrorCount: 0 })).toBe(false);
  });

  it("refuses a ZERO reading whose error count is non-zero", () => {
    // An absence is a measurement only when its error count is zero.
    expect(slotReadingAdmissible({ slotOutcome: "zero", slotAgreeing: 2, slotErrorCount: 1 })).toBe(false);
    expect(slotReadingAdmissible({ slotOutcome: "zero", slotAgreeing: 2, slotErrorCount: 0 })).toBe(true);
  });
});

describe("rule B: the grade of an era with no promoted boundary evidence", () => {
  const rowWith = (o: Parameters<typeof registryRowWithBoundary>[0]) =>
    parseRegistry(writeRegistryWithBoundary([
      registryRowWithBoundary({ era_count: "1", valid_to_block: INT64_MAX, is_live: "true", ...o }),
    ])).rows[0];

  it("B1 slot_bisected, from a bisected era_evidence", () => {
    expect(gradeFromRegistryRow(rowWith({ era_evidence: "slot_bisection_and_announcement_log" })))
      .toMatchObject({ grade: "slot_bisected", clause: "B1", source: "registry_seed" });
    expect(gradeFromRegistryRow(rowWith({ era_evidence: "slot_bisection_only" })).clause).toBe("B1");
  });

  it("B2 announced, from an announcement with no state read", () => {
    expect(gradeFromRegistryRow(rowWith({ era_evidence: "announcement_log_only" })))
      .toMatchObject({ grade: "announced", clause: "B2" });
  });

  it("B3 announced, when the creation that opens the era was established by two agreeing voices", () => {
    expect(gradeFromRegistryRow(rowWith({
      era_evidence: "contract_creation", creation_method: "explorer_index_and_state_read_agree",
    }))).toMatchObject({ grade: "announced", clause: "B3" });
  });

  it("B4 inferred, when that same creation rests on ONE voice", () => {
    expect(gradeFromRegistryRow(rowWith({
      era_evidence: "contract_creation", creation_method: "etherscan_v2_getcontractcreation",
    }))).toMatchObject({ grade: "inferred", clause: "B4" });
  });

  it("is CAPPED at slot_bisected: no registry row can reach corroborated", () => {
    // The registry records how an era was found; it carries no second reader's verdict. A grade
    // claiming two agreeing voices has to be able to name both, and this one cannot.
    for (const evidence of ["slot_bisection_and_announcement_log", "slot_bisection_only", "announcement_log_only", "contract_creation"]) {
      const g = gradeFromRegistryRow(rowWith({ era_evidence: evidence }));
      expect(GRADE_STRENGTH[g.grade]).toBeLessThan(GRADE_STRENGTH.corroborated);
    }
  });
});

describe("the promoted evidence seed is what ships, and it re-derives the grades", () => {
  const evidence = parseEraBoundaryEvidence();
  const registry = parseRegistry();
  const IN_SCOPE = new Set(["CELO", "XDC", "ETHEREUM"]);

  it("carries every era the six manifests covered", () => {
    // MEASURED 2026-09-28: 41 eras across 6 manifests, 15 of them on a release chain.
    expect(evidence.size).toBe(41);
    expect([...evidence.values()].filter((e) => IN_SCOPE.has(e.chain))).toHaveLength(15);
    expect([...evidence.values()].filter((e) => e.chain === "FUSE")).toHaveLength(26);
  });

  it("names its own source manifest and that manifest's hash on every row", () => {
    for (const e of evidence.values()) {
      expect(e.sourceManifest).toMatch(/\.json$/);
      expect(e.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("grades all 15 in-scope eras from the manifest, with the measured distribution", () => {
    const inScope = registry.rows.filter((r) => IN_SCOPE.has(r.chain) && !r.noCodeDeployed);
    const graded = inScope
      .map((r) => ({ row: r, verdict: gradeForEra(r, evidence) }))
      .filter((g) => g.verdict.source === "boundary_evidence");

    expect(graded).toHaveLength(15);
    const byGrade = graded.reduce<Record<string, number>>((a, g) => ((a[g.verdict.grade] = (a[g.verdict.grade] ?? 0) + 1), a), {});
    // MEASURED, and it is the distribution the published rule produces: XDC's three eras are the
    // only ones with both a bisected boundary and full event confirmation.
    expect(byGrade).toEqual({ corroborated: 3, slot_bisected: 2, announced: 10 });
  });

  it("every in-scope era carries a grade, not only the manifest-backed ones", () => {
    const inScope = registry.rows.filter((r) => IN_SCOPE.has(r.chain) && !r.noCodeDeployed);
    expect(inScope).toHaveLength(262);
    for (const r of inScope) {
      const v = gradeForEra(r, evidence);
      expect(CONFIDENCE_GRADES).toContain(v.grade);
      expect(v.clause).toMatch(/^[AB][1-5]$/);
    }
  });

  /*
   * THE NON-DEGENERACY CHECK. A rule that gives every era the same answer is not a rule, and a
   * suspiciously uniform result is a bug report about the instrument before it is a finding.
   * Run over the whole population, the rule must separate the chain where an independent check
   * could run from the one where it provably could not.
   */
  it("discriminates: Fuse, where no historical state read is obtainable, grades lower", () => {
    const fuse = [...evidence.values()].filter((e) => e.chain === "FUSE").map(gradeFromBoundaryEvidence);
    const xdc = [...evidence.values()].filter((e) => e.chain === "XDC").map(gradeFromBoundaryEvidence);

    expect(fuse.filter((g) => g.grade === "inferred").length).toBeGreaterThan(0);
    expect(fuse.filter((g) => g.grade === "corroborated")).toHaveLength(0);
    expect(xdc.every((g) => g.grade === "corroborated")).toBe(true);
  });

  it("uses more than one grade across the whole population", () => {
    const all = [...evidence.values()].map((e) => gradeFromBoundaryEvidence(e).grade);
    expect(new Set(all).size).toBeGreaterThan(1);
  });

  it("keys evidence case-insensitively on the address", () => {
    const one = [...evidence.values()][0];
    expect(evidence.get(eraEvidenceKey(one.chainId, one.proxyAddress.toUpperCase(), one.eraIndex))).toBeDefined();
  });
});
