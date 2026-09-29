/**
 * The era validity-interval table and its three properties.
 *
 * Every check here is run in BOTH directions: green on the shipped seed, and red on a seed mutated
 * to carry exactly the defect it claims to catch. A structural test that has never been seen to
 * fail is an assumption with a test's name on it.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import {
  parseEraIntervals,
  assertNoOverlappingIntervals,
  assertNoIntervalGaps,
  assertExactlyOneIntervalCovers,
  boundaryProbes,
  ERA_INTERVAL_REQUIRED_COLUMNS,
  ERA_INTERVALS_HEADER,
  OPEN_ENDED,
  type EraInterval,
} from "../../src/control-plane/eraIntervals.js";
import { parseRegistry } from "../../src/control-plane/contractRegistry.js";
import { SEEDS_DIR } from "../../src/control-plane/chains.js";
import { CONFIDENCE_GRADES, parseEraBoundaryEvidence, eraEvidenceKey } from "../../src/control-plane/eraConfidence.js";

const intervals = parseEraIntervals();
const registry = parseRegistry();

const creationBlockFor = (chainId: number, proxyAddress: string): bigint | null => {
  const era1 = registry.rows.find(
    (r) => r.chainId === chainId && r.proxyAddress === proxyAddress && r.eraIndex === 1 && !r.noCodeDeployed,
  );
  return era1?.creationBlock === undefined || era1.creationBlock === null ? null : BigInt(era1.creationBlock);
};

/** Mutate one interval, leaving every other row exactly as shipped. */
const mutate = (predicate: (i: EraInterval) => boolean, patch: Partial<EraInterval>): EraInterval[] =>
  intervals.map((i) => (predicate(i) ? { ...i, ...patch } : i));

describe("the era interval table carries what plan 5.4 requires", () => {
  it("has all eight required columns", () => {
    for (const c of ERA_INTERVAL_REQUIRED_COLUMNS) expect(ERA_INTERVALS_HEADER).toContain(c);
  });

  it("covers every in-release deployed era, and the ingestion slice is 206 of them", () => {
    // MEASURED 2026-09-28. Plan 5.2 says "208 in-scope rows", which reconciles exactly to the
    // CELO + XDC rows of the registry seed -- 168 + 40. Two of those 208 are `no_code_deployed`
    // rows that declare NO interval at all, so the interval table carries 206 of them, plus
    // Ethereum's 56, which is declared in the release and simply not ingested by this slice.
    expect(intervals).toHaveLength(262);
    expect(intervals.filter((i) => i.chain === "CELO" || i.chain === "XDC")).toHaveLength(206);
    expect(intervals.filter((i) => i.chain === "ETHEREUM")).toHaveLength(56);
  });

  it("carries a grade and a receipt on EVERY row, so neither column is nulls with a name", () => {
    for (const i of intervals) {
      expect(CONFIDENCE_GRADES).toContain(i.confidenceGrade);
      expect(i.evidenceReceiptUri.length).toBeGreaterThan(0);
      expect(i.abiId.length).toBeGreaterThan(0);
    }
  });

  it("every receipt resolves to a tracked path inside the repository", () => {
    // A receipt nobody outside this machine can open is not a receipt, it is an assertion. The
    // property asserted here is the positive one -- the path is a real, tracked location in this
    // repository -- rather than a copy of any particular tool's list of paths to avoid.
    for (const i of intervals) {
      const path = i.evidenceReceiptUri.split("#")[0];
      expect(path.startsWith("gd_dbt/seeds/")).toBe(true);
      expect(path.endsWith(".csv")).toBe(true);
      expect(existsSync(join(SEEDS_DIR, path.replace("gd_dbt/seeds/", "")))).toBe(true);
    }
  });

  it("the row key in a receipt resolves to exactly one row of the seed it names", () => {
    // `#CHAIN/0xaddress/era=N` has to be resolvable, not decorative.
    const evidence = parseEraBoundaryEvidence();
    for (const i of intervals.filter((x) => x.evidenceReceiptUri.includes("era_boundary_evidence"))) {
      const key = i.evidenceReceiptUri.split("#")[1];
      expect(key).toBe(`${i.chain}/${i.proxyAddress}/era=${i.eraIndex}`);
      expect(evidence.get(eraEvidenceKey(i.chainId, i.proxyAddress, i.eraIndex))).toBeDefined();
    }
  });

  it("points the manifest-backed eras at the PROMOTED evidence seed, not at the registry", () => {
    const promoted = intervals.filter((i) => i.evidenceReceiptUri.startsWith("gd_dbt/seeds/era_boundary_evidence.csv"));
    expect(promoted).toHaveLength(15);
    // And those are exactly the eras that reach a grade the registry alone cannot produce.
    expect(promoted.filter((i) => i.confidenceGrade === "corroborated")).toHaveLength(3);
  });
});

describe("no overlapping intervals per (chain, address)", () => {
  it("GREEN on the shipped seed", () => {
    expect(assertNoOverlappingIntervals(intervals)).toEqual([]);
  });

  it("RED when one era is stretched over the next", () => {
    const broken = mutate(
      (i) => i.chain === "XDC" && i.contractName === "Invites" && i.eraIndex === 1,
      { validToBlock: OPEN_ENDED },
    );
    const v = assertNoOverlappingIntervals(broken);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].check).toBe("era_intervals_do_not_overlap");
    expect(v[0].detail).toMatch(/overlaps era 2/);
  });

  it("does NOT flag intervals that merely touch, which is the correct shape", () => {
    // Half-open [from, to): era 1 ending at block X and era 2 starting at block X share no block.
    // A closed-interval reading would call every contiguous pair an overlap.
    const touching = intervals.filter((i) => i.chain === "XDC" && i.contractName === "Invites");
    expect(touching.length).toBe(2);
    expect(touching[0].validToBlock).toBe(touching[1].validFromBlock);
    expect(assertNoOverlappingIntervals(touching)).toEqual([]);
  });
});

describe("no gaps from deployment to head", () => {
  it("GREEN on the shipped seed", () => {
    expect(assertNoIntervalGaps(intervals, creationBlockFor)).toEqual([]);
  });

  it("RED on a hole between two eras", () => {
    const broken = mutate(
      (i) => i.chain === "XDC" && i.contractName === "Invites" && i.eraIndex === 1,
      { validToBlock: 100000000n },
    );
    const v = assertNoIntervalGaps(broken, creationBlockFor);
    expect(v.map((x) => x.check)).toContain("era_intervals_have_no_gaps");
    expect(v.some((x) => x.detail.includes("not contiguous"))).toBe(true);
  });

  it("RED when the first era starts after the contract was created", () => {
    // The failure that looks healthiest from the inside: an internally perfect chain that simply
    // begins late, losing every log before it while every other assertion still passes.
    const broken = mutate(
      (i) => i.chain === "XDC" && i.contractName === "UBIScheme" && i.eraIndex === 1,
      { validFromBlock: 99999999n },
    );
    const v = assertNoIntervalGaps(broken, creationBlockFor);
    expect(v.some((x) => x.detail.includes("belong to no era"))).toBe(true);
  });

  it("RED when a live contract's last era is closed", () => {
    const broken = mutate((i) => i.chain === "XDC" && i.contractName === "UBIScheme" && i.isLive, { validToBlock: 107000000n });
    const v = assertNoIntervalGaps(broken, creationBlockFor);
    expect(v.some((x) => x.detail.includes("open-ended sentinel"))).toBe(true);
  });

  it("RED when an era index is missing from the table entirely", () => {
    const broken = intervals.filter((i) => !(i.chain === "CELO" && i.contractName === "Invites" && i.eraIndex === 4));
    const v = assertNoIntervalGaps(broken, creationBlockFor);
    expect(v.some((x) => x.detail.includes("an era is missing"))).toBe(true);
  });
});

describe("exactly one row covers any queried block", () => {
  const probes = boundaryProbes(intervals);

  it("probes every real boundary rather than an invented block", () => {
    // Every era's first block, and every closed era's last block. A boundary off by one is the
    // defect this shape exists to find, so the probes sit exactly on the boundaries.
    expect(probes.length).toBeGreaterThan(intervals.length);
    expect(new Set(probes.map((p) => p.kind))).toEqual(new Set(["era_first_block", "era_last_block"]));
  });

  it("GREEN on the shipped seed", () => {
    expect(assertExactlyOneIntervalCovers(intervals, probes)).toEqual([]);
  });

  it("RED with TWO covering rows when an interval is written closed instead of half-open", () => {
    const broken = mutate(
      (i) => i.chain === "CELO" && i.contractName === "UBIScheme" && i.eraIndex === 1,
      { validToBlock: 19276073n },
    );
    const v = assertExactlyOneIntervalCovers(broken, boundaryProbes(broken));
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].detail).toMatch(/^2 interval\(s\) cover this block/);
  });

  it("RED with ZERO covering rows on a block inside a hole", () => {
    const broken = mutate(
      (i) => i.chain === "CELO" && i.contractName === "UBIScheme" && i.eraIndex === 1,
      { validToBlock: 19000000n },
    );
    const inTheHole = [{ chainId: 42220, proxyAddress: "0x43d72ff17701b2da814620735c39c620ce0ea4a1", block: 19100000n, kind: "inside_the_hole" }];
    const v = assertExactlyOneIntervalCovers(broken, inTheHole);
    expect(v).toHaveLength(1);
    expect(v[0].detail).toBe("0 interval(s) cover this block");
  });

  /*
   * WHY THE GAP TEST IS A SEPARATE TEST, found by this one failing when it should not have.
   *
   * The probe set is derived from the intervals themselves, so after a mutation that SHRINKS an
   * era, the probes shrink with it: era 1's last block moves down into era 1, era 2's first block
   * stays inside era 2, and nothing probes the hole between them. The coverage property is real
   * but it is blind to a gap by construction -- it can only speak about blocks somebody asks
   * about. That is precisely the work `assertNoIntervalGaps` does, and it is why three tests are
   * three tests rather than one with a longer name.
   */
  it("cannot see a gap on its own, which is why the gap test exists", () => {
    const broken = mutate(
      (i) => i.chain === "CELO" && i.contractName === "UBIScheme" && i.eraIndex === 1,
      { validToBlock: 19000000n },
    );
    expect(assertExactlyOneIntervalCovers(broken, boundaryProbes(broken))).toEqual([]);
    expect(assertNoIntervalGaps(broken, creationBlockFor).length).toBeGreaterThan(0);
  });
});

describe("what these three tests deliberately do NOT detect", () => {
  it("a perfectly shaped chain can still rest on weak evidence, and the grade is what says so", () => {
    // The interval algebra is silent about how well evidenced an interval is. Saying so is the
    // difference between a test suite and a reassurance.
    expect(assertNoOverlappingIntervals(intervals)).toEqual([]);
    expect(assertNoIntervalGaps(intervals, creationBlockFor)).toEqual([]);
    const weak = intervals.filter((i) => i.confidenceGrade === "inferred");
    expect(weak.length).toBeGreaterThan(0);
  });
});
