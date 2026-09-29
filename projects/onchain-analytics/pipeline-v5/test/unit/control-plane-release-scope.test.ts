/**
 * The frozen release scope.
 *
 * Every case mutates exactly ONE thing about an otherwise valid seed, and each file starts from a
 * control that passes. A test that builds three defects proves only that something was wrong.
 *
 * The fixtures use the SAME 23-column base header as the shipped seed, plus the declared 5-column
 * boundary block. A fixture whose header does not match the artifact it stands in for is rejected
 * at the header and passes for a weaker reason than it was written for; that happened once in this
 * repository already.
 */

import { describe, it, expect } from "vitest";
import { parseRegistry } from "../../src/control-plane/contractRegistry.js";
import { loadChains, type ChainAuthority } from "../../src/control-plane/chains.js";
import { loadControlPlane, inspectControlPlane } from "../../src/control-plane/index.js";
import {
  RELEASE_SCOPE_FREEZE,
  assertReleaseScopeFrozen,
  chainStanding,
  releaseScopeState,
  eraConsumableBySemanticModel,
  assertSemanticErasConsumable,
  ERA_CONSUMABILITY_BRANCHES,
  type ReleaseScopeFreeze,
} from "../../src/control-plane/releaseScope.js";
import { parseEraBoundaryEvidence, eraEvidenceKey } from "../../src/control-plane/eraConfidence.js";
import { runBuildCheck } from "../../src/control-plane/build-check.js";
import { NETWORKS } from "../../src/config.js";
import { buildPlan } from "../../src/plan.js";
import { targetsFor, partitionByReleaseScope, ChainOutOfReleaseScopeError } from "../../src/registry.js";
import {
  registryRow,
  registryEra2Row,
  registryRowWithBoundary,
  surfaceRow,
  writeRegistry,
  writeRegistryWithBoundary,
  writeSeed,
  writeSurface,
  INT64_MAX,
  IMPL_A,
} from "../helpers/seed-fixtures.js";

const chains = loadChains();

const CHAINS_COLUMNS = [
  "chain", "chain_id", "chain_name", "native_token_symbol", "explorer_url_template", "is_active", "notes",
] as const;

function chainsWith(rows: readonly string[]): ChainAuthority {
  const path = writeSeed("chains.csv", CHAINS_COLUMNS, rows).path;
  return loadChains(path);
}

/** One of the nineteen, copied from the freeze declaration rather than retyped. */
const EXCLUDED_ETH = RELEASE_SCOPE_FREEZE.excludedContracts.find((c) => c.chain === "ETHEREUM")!;

const boundaryBody = (overrides: Parameters<typeof registryRowWithBoundary>[0] = {}) => [
  registryRowWithBoundary({ era_index: "1", valid_to_block: "106000000", is_live: "false", ...overrides }),
  registryRowWithBoundary({
    era_index: "2", implementation_address: "0x2222222222222222222222222222222222222222",
    implementation_name: "UBISchemeV2", valid_from_block: "106000000",
    valid_to_block: "9223372036854775807", is_live: "true",
    era_evidence: "slot_bisection_and_announcement_log", ...overrides,
  }),
];

function checks(path: string, freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE, authority = chains): string[] {
  return assertReleaseScopeFrozen(parseRegistry(path), authority, freeze).map((v) => v.check);
}

describe("the release scope is frozen", () => {
  // RENAMED 2026-09-28, along with the record it asserts. The previous name used a word that
  // means nothing to a reader outside this project, and the decision record it pointed at was not
  // part of the repository, so neither could be resolved by anyone holding only this code.
  it("declares the scope decision, its record and its evidence", () => {
    expect(RELEASE_SCOPE_FREEZE.frozen).toBe(true);
    expect(RELEASE_SCOPE_FREEZE.decidedOn).toBe("2026-09-28");
    expect(RELEASE_SCOPE_FREEZE.decisionRecord).toBe("docs/release-scope.md");
    expect(RELEASE_SCOPE_FREEZE.evidence.length).toBeGreaterThan(0);
  });

  it("covers Celo, XDC and Ethereum, and records Fuse as dropped rather than forgotten", () => {
    expect(RELEASE_SCOPE_FREEZE.releaseChains).toEqual(["CELO", "XDC", "ETHEREUM"]);
    expect(RELEASE_SCOPE_FREEZE.chainsDropped.map((c) => c.chain)).toEqual(["FUSE"]);
    for (const c of RELEASE_SCOPE_FREEZE.chainsDropped) {
      expect(c.droppedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.reason.length).toBeGreaterThan(0);
      // Disjoint by construction, so no chain can be read as both in and out.
      expect(RELEASE_SCOPE_FREEZE.releaseChains).not.toContain(c.chain);
    }
  });

  it("names the plan governing the amended decision and carries the superseded one", () => {
    expect(RELEASE_SCOPE_FREEZE.planSha256)
      .toBe("BAA0005DEE707BA6BF26DCC100194087AC84299084C372AE5DED6569325ECA02");
    expect(RELEASE_SCOPE_FREEZE.supersededPlanSha256)
      .toEqual(["9DCDE225459127C4DA2BEADF9094FD894FE193010F39CB70C0753DD874853E26"]);
    expect(RELEASE_SCOPE_FREEZE.supersededPlanSha256).not.toContain(RELEASE_SCOPE_FREEZE.planSha256);
  });

  it("excludes exactly the nineteen A1-R candidates, 6 on Fuse and 13 on Ethereum", () => {
    const e = RELEASE_SCOPE_FREEZE.excludedContracts;
    expect(e).toHaveLength(19);
    expect(e.filter((c) => c.chain === "FUSE")).toHaveLength(6);
    expect(e.filter((c) => c.chain === "ETHEREUM")).toHaveLength(13);
    expect(new Set(e.map((c) => `${c.chainId}|${c.address}`)).size).toBe(19);
    for (const c of e) expect(c.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("records Base and Gnosis as a decision not to assess, not as an assessment", () => {
    expect(RELEASE_SCOPE_FREEZE.chainsNotAssessed.map((c) => c.chain)).toEqual(["BASE", "GNOSIS"]);
    for (const c of RELEASE_SCOPE_FREEZE.chainsNotAssessed) {
      expect(c.note).toMatch(/zero queries were made/);
    }
    expect(RELEASE_SCOPE_FREEZE.releaseChains).not.toContain("BASE");
    expect(RELEASE_SCOPE_FREEZE.releaseChains).not.toContain("GNOSIS");
  });
});

describe("scope_pending is an illegal state once scope is frozen", () => {
  it("accepts a declared seed where every row reads in_release", () => {
    expect(checks(writeRegistryWithBoundary(boundaryBody()))).toEqual([]);
  });

  it("fails the build on a single surviving scope_pending row", () => {
    const body = boundaryBody();
    body[1] = registryRowWithBoundary({
      era_index: "2", implementation_address: "0x2222222222222222222222222222222222222222",
      implementation_name: "UBISchemeV2", valid_from_block: "106000000",
      valid_to_block: "9223372036854775807", is_live: "true",
      era_evidence: "slot_bisection_and_announcement_log", release_scope: "scope_pending",
    });
    expect(checks(writeRegistryWithBoundary(body))).toEqual(["no_scope_pending_when_frozen"]);
  });

  it("names every pending row rather than stopping at the first", () => {
    const body = boundaryBody({ release_scope: "scope_pending" });
    expect(checks(writeRegistryWithBoundary(body))).toHaveLength(2);
  });

  it("permits scope_pending while the freeze has not been declared", () => {
    const body = boundaryBody({ release_scope: "scope_pending" });
    const unfrozen = { ...RELEASE_SCOPE_FREEZE, frozen: false };
    expect(checks(writeRegistryWithBoundary(body), unfrozen)).toEqual([]);
  });

  it("accepts out_of_release, which is a decision, unlike scope_pending", () => {
    expect(checks(writeRegistryWithBoundary(boundaryBody({ release_scope: "out_of_release" })))).toEqual([]);
  });
});

describe("the pre-freeze seed is a named state, not a silent pass", () => {
  it("reports pre_freeze_seed when the boundary and scope columns are absent", () => {
    const parsed = parseRegistry(writeRegistry([registryRow(), registryEra2Row()]));
    expect(releaseScopeState(parsed)).toBe("pre_freeze_seed");
  });

  it("reports frozen_and_declared once the columns are present", () => {
    expect(releaseScopeState(parseRegistry(writeRegistryWithBoundary(boundaryBody())))).toBe("frozen_and_declared");
  });

  /*
   * The coupling that makes `undeclared` safe to allow through the loader. Absent the column
   * block, release_scope reads `undeclared` AND boundary_completeness is forced to
   * `raw_only_unproven`, which forbids every decoder over every era. If a future change ever
   * decouples the two, this test fails and the allowance has to be revisited.
   */
  it("forbids semantic consumption of every era while the seed is pre-freeze", () => {
    const parsed = parseRegistry(writeRegistry([registryRow(), registryEra2Row()]));
    for (const row of parsed.rows) {
      expect(row.releaseScope).toBe("undeclared");
      expect(row.boundaryCompleteness).toBe("raw_only_unproven");
      expect(eraConsumableBySemanticModel(row).consumable).toBe(false);
    }
  });
});

describe("an excluded contract may not reappear in the registry", () => {
  it("rejects an excluded address used as a proxy_address on its own chain", () => {
    const body = [registryRowWithBoundary({
      chain: "ETHEREUM", chain_id: "1", proxy_address: EXCLUDED_ETH.address,
      valid_to_block: "9223372036854775807", is_live: "true", era_count: "1",
    })];
    expect(checks(writeRegistryWithBoundary(body))).toEqual(["excluded_contract_absent"]);
  });

  it("rejects an excluded address used as an implementation_address on its own chain", () => {
    const body = [registryRowWithBoundary({
      chain: "ETHEREUM", chain_id: "1", implementation_address: EXCLUDED_ETH.address,
      valid_to_block: "9223372036854775807", is_live: "true", era_count: "1",
    })];
    expect(checks(writeRegistryWithBoundary(body))).toEqual(["excluded_contract_absent"]);
  });

  /*
   * A1-R's first membership answer was a false positive from a substring match over the whole
   * file: the address was real but sat in a different chain's implementation_address column.
   * Matching on (chain_id, column) is what removed it, and this pins that.
   */
  it("does not flag the same address on a different chain", () => {
    const body = [registryRowWithBoundary({
      chain: "XDC", chain_id: "50", implementation_address: EXCLUDED_ETH.address,
      valid_to_block: "9223372036854775807", is_live: "true", era_count: "1",
    })];
    expect(checks(writeRegistryWithBoundary(body))).toEqual([]);
  });

  it("leaves an ordinary implementation address alone", () => {
    const body = [registryRowWithBoundary({
      implementation_address: IMPL_A, valid_to_block: "9223372036854775807",
      is_live: "true", era_count: "1",
    })];
    expect(checks(writeRegistryWithBoundary(body))).toEqual([]);
  });
});

describe("a scope change cannot arrive as a seed edit", () => {
  it("rejects a chain the frozen release does not name", () => {
    const authority = chainsWith([
      "CELO,42220,Celo,CELO,https://celoscan.io/tx/{tx_hash},true,",
      "BASE,8453,Base,ETH,https://basescan.org/tx/{tx_hash},true,",
    ]);
    const body = [registryRowWithBoundary({
      chain: "CELO", chain_id: "42220", valid_to_block: "9223372036854775807",
      is_live: "true", era_count: "1",
    })];
    expect(checks(writeRegistryWithBoundary(body), RELEASE_SCOPE_FREEZE, authority)).toEqual(["release_chain_frozen"]);
  });

  // RENAMED 2026-09-28. Was "accepts the four chains the release actually contains", which became
  // false when Fuse left: the seed still declares four chains and the release now names three.
  // The property that survives the change is the one worth asserting -- every chain in the seed
  // has been DECIDED about, whether that decision was in or out.
  it("accepts a chains seed where every chain is declared, in release or dropped", () => {
    const declared = new Set([
      ...RELEASE_SCOPE_FREEZE.releaseChains,
      ...RELEASE_SCOPE_FREEZE.chainsDropped.map((c) => c.chain),
    ]);
    expect(chains.rows.map((r) => r.chain).sort()).toEqual([...declared].sort());
    expect(assertReleaseScopeFrozen(parseRegistry(writeRegistryWithBoundary(boundaryBody())), chains)).toEqual([]);
  });

  /*
   * The discriminator, both directions, on ONE fixture. This is what makes dropping a chain
   * different from making the check stop firing: a chain recorded as dropped is silent, and a
   * chain nobody decided about still raises. Delete `chainsDropped` and the first assertion
   * fails; widen the rule to "anything outside the release is fine" and the rest fail.
   */
  it("is silent on a dropped chain and still raises on a chain nobody decided about", () => {
    const authority = chainsWith([
      "FUSE,122,Fuse,FUSE,https://explorer.fuse.io/tx/{tx_hash},true,",
      "BASE,8453,Base,ETH,https://basescan.org/tx/{tx_hash},true,",
    ]);
    const registry = writeRegistryWithBoundary([
      registryRowWithBoundary({
        chain: "FUSE", chain_id: "122", release_scope: "out_of_release",
        era_count: "1", valid_to_block: INT64_MAX, is_live: "true",
      }),
      registryRowWithBoundary({
        chain: "BASE", chain_id: "8453", proxy_address: "0x3333333333333333333333333333333333333333",
        release_scope: "out_of_release", era_count: "1", valid_to_block: INT64_MAX, is_live: "true",
      }),
    ]);

    const v = assertReleaseScopeFrozen(parseRegistry(registry), authority);

    expect(v.filter((x) => x.subject.startsWith("FUSE"))).toEqual([]);
    expect(v.map((x) => x.check)).toEqual(["release_chain_frozen", "release_chain_frozen"]);
    for (const x of v) expect(x.subject).toMatch(/^BASE/);
  });

  it("answers where a chain stands in three cases, not two", () => {
    expect(chainStanding("CELO")).toBe("in_release");
    expect(chainStanding("FUSE")).toBe("dropped");
    expect(chainStanding("BASE")).toBe("undeclared");
  });

  /*
   * Retention is a record, not a re-admission. The Fuse rows stay in the seeds because deleting
   * the 96 deployment rows would orphan the 616 event-surface rows bound to them, so the one
   * claim a retained row must never be allowed to make is that it is back in the release.
   */
  it("refuses a retained row on a dropped chain that declares itself in release", () => {
    const authority = chainsWith(["FUSE,122,Fuse,FUSE,https://explorer.fuse.io/tx/{tx_hash},true,"]);
    const registry = writeRegistryWithBoundary([
      registryRowWithBoundary({
        chain: "FUSE", chain_id: "122", release_scope: "in_release",
        era_count: "1", valid_to_block: INT64_MAX, is_live: "true",
      }),
    ]);

    const v = assertReleaseScopeFrozen(parseRegistry(registry), authority);

    expect(v.map((x) => x.check)).toEqual(["dropped_chain_not_in_release"]);
    expect(v[0].detail).toMatch(/dropped from the release on 2026-09-28/);
  });

  it("accepts the same retained row once it declares itself out of the release", () => {
    const authority = chainsWith(["FUSE,122,Fuse,FUSE,https://explorer.fuse.io/tx/{tx_hash},true,"]);
    const registry = writeRegistryWithBoundary([
      registryRowWithBoundary({
        chain: "FUSE", chain_id: "122", release_scope: "out_of_release",
        era_count: "1", valid_to_block: INT64_MAX, is_live: "true",
      }),
    ]);
    expect(assertReleaseScopeFrozen(parseRegistry(registry), authority)).toEqual([]);
  });

  it("refuses a freeze that names one chain as both in release and dropped", () => {
    const incoherent: ReleaseScopeFreeze = {
      ...RELEASE_SCOPE_FREEZE,
      releaseChains: ["CELO", "XDC", "ETHEREUM", "FUSE"],
    };
    const v = assertReleaseScopeFrozen(
      parseRegistry(writeRegistryWithBoundary(boundaryBody())), chains, incoherent,
    );
    expect(v.map((x) => x.check)).toEqual(["release_scope_declaration_coherent"]);
    expect(v[0].subject).toBe("FUSE");
    expect(v[0].line).toBeNull();
  });
});

describe("a semantic model may not consume an unreviewed era", () => {
  const parseOne = (overrides: Parameters<typeof registryRowWithBoundary>[0]) =>
    parseRegistry(writeRegistryWithBoundary([
      registryRowWithBoundary({ era_count: "1", valid_to_block: "9223372036854775807", is_live: "true", ...overrides }),
    ])).rows[0];

  const proven = {
    boundary_completeness: "complete",
    boundary_evidence_manifest_hash: "0x" + "cd".repeat(32),
    boundary_checked_through_block: "107000000",
    frozen_safe_head: "107000100",
  };

  it("allows a complete era that is in release", () => {
    expect(eraConsumableBySemanticModel(parseOne(proven)).consumable).toBe(true);
  });

  it("allows a plain_contract era on the same evidence", () => {
    expect(eraConsumableBySemanticModel(parseOne({ ...proven, boundary_completeness: "plain_contract" })).consumable).toBe(true);
  });

  // RENAMED 2026-09-28 by the decode unit.
  //   was: "refuses a raw_only_unproven era and says why"
  // This is the test plan 5.5 obligation 4 names. It asserted the one branch the reversal
  // REMOVES, so leaving it would have pinned the rule the change exists to retire. Rewritten to
  // assert the reversal itself, in both directions on one fixture.
  it("no longer refuses on raw_only_unproven alone, and still refuses with no evidence", () => {
    // Same completeness verdict, full boundary evidence: consumable, and it carries a grade.
    // The fixture's era_evidence is `contract_creation` on a two-voice creation method, so the
    // published rule puts it at `announced` by clause B3.
    const withEvidence = eraConsumableBySemanticModel(parseOne({ ...proven, boundary_completeness: "raw_only_unproven" }));
    expect(withEvidence.consumable).toBe(true);
    expect(withEvidence.branch).toBe("consumable");
    expect(withEvidence.confidenceGrade).toBe("announced");

    // The grade VARIES with the evidence rather than being a constant dressed as one: the same
    // row with a bisected era reads a tier higher, and it is still consumable either way. That
    // is the whole reversal -- the grade describes, it does not decide.
    const bisected = eraConsumableBySemanticModel(parseOne({ ...proven, era_evidence: "slot_bisection_and_announcement_log" }));
    expect(bisected.consumable).toBe(true);
    expect(bisected.confidenceGrade).toBe("slot_bisected");

    // Same completeness verdict, no evidence: still refused, by the RETAINED branch, and the
    // reason no longer mentions raw_only_unproven because that is no longer why.
    const without = eraConsumableBySemanticModel(parseOne({ boundary_completeness: "raw_only_unproven" }));
    expect(without.consumable).toBe(false);
    expect(without.branch).toBe("boundary_evidence_incomplete");
    expect(without.reason).not.toMatch(/raw_only_unproven/);
  });

  it("refuses a complete era that is still scope_pending", () => {
    const verdict = eraConsumableBySemanticModel(parseOne({ ...proven, release_scope: "scope_pending" }));
    expect(verdict.consumable).toBe(false);
    expect(verdict.reason).toMatch(/scope_pending/);
  });

  it("refuses an out_of_release era even when its boundary evidence is complete", () => {
    expect(eraConsumableBySemanticModel(parseOne({ ...proven, release_scope: "out_of_release" })).consumable).toBe(false);
  });

  it("reports one policy violation per refused era, naming the model", () => {
    const parsed = parseRegistry(writeRegistryWithBoundary(boundaryBody()));
    const v = assertSemanticErasConsumable(parsed.rows, "Semantic.claim_events");
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.check)).toEqual(["semantic_era_reviewed", "semantic_era_reviewed"]);
    expect(v[0].subject).toMatch(/^Semantic\.claim_events -> /);
  });
});

/*
 * THE BRANCH TABLE, asserted branch by branch.
 *
 * The reversal narrows this control in one place and widens it in three. A test that only asserted
 * "consumable" would pass equally well on an implementation that deleted the release-scope refusal
 * and made every dropped-chain row consumable -- which is the exact hazard the plan names. So each
 * branch gets its own case, and the removed one gets a case proving it is GONE.
 */
describe("the 5.5 branch table, branch by branch", () => {
  const row = (o: Parameters<typeof registryRowWithBoundary>[0]) =>
    parseRegistry(writeRegistryWithBoundary([
      registryRowWithBoundary({ era_count: "1", valid_to_block: INT64_MAX, is_live: "true", ...o }),
    ])).rows[0];

  const evidenced = {
    boundary_completeness: "raw_only_unproven",
    boundary_evidence_manifest_hash: "0x" + "cd".repeat(32),
    boundary_checked_through_block: "107000000",
    frozen_safe_head: "107000100",
  };

  it("RETAINED 1 of 5: no code deployed", () => {
    const v = eraConsumableBySemanticModel(row({
      era_method: "no_code_deployed", era_index: "1", era_count: "0", valid_from_block: "",
      valid_to_block: "", creation_block: "", is_live: "false", implementation_address: "",
    }));
    expect(v.consumable).toBe(false);
    expect(v.branch).toBe("no_code_deployed");
  });

  it("RETAINED 2 of 5: the row is not in the release -- the branch that keeps dropped chains out", () => {
    const v = eraConsumableBySemanticModel(row({ ...evidenced, release_scope: "out_of_release" }));
    expect(v.consumable).toBe(false);
    expect(v.branch).toBe("release_scope_not_in_release");
  });

  it("REMOVED 3 of 5: raw_only_unproven no longer refuses, and its name is gone from the branch list", () => {
    const v = eraConsumableBySemanticModel(row(evidenced));
    expect(v.consumable).toBe(true);
    expect(v.branch).toBe("consumable");
    // The removed branch cannot be named, which is what stops it being reintroduced quietly.
    expect(ERA_CONSUMABILITY_BRANCHES).not.toContain("boundary_completeness_raw_only_unproven");
    expect([...ERA_CONSUMABILITY_BRANCHES].filter((b) => b.includes("raw_only_unproven"))).toEqual([]);
  });

  it("RETAINED 4 of 5: boundary evidence incomplete, stated as its refusal condition", () => {
    for (const missing of ["boundary_evidence_manifest_hash", "boundary_checked_through_block", "frozen_safe_head"]) {
      const v = eraConsumableBySemanticModel(row({ ...evidenced, [missing]: "" }));
      expect(v.consumable).toBe(false);
      expect(v.branch).toBe("boundary_evidence_incomplete");
    }
  });

  it("RETAINED 5 of 5: otherwise consumable, and it carries its grade", () => {
    const v = eraConsumableBySemanticModel(row(evidenced));
    expect(v.consumable).toBe(true);
    expect(v.confidenceGrade).toBe("announced");
    expect(v.reason).toContain("confidence 'announced'");
  });

  it("ADDED 1 of 3: an interval whose ABI is unknown", () => {
    const v = eraConsumableBySemanticModel(row({ ...evidenced, abi_source: "none" }));
    expect(v.consumable).toBe(false);
    expect(v.branch).toBe("abi_unknown");
    expect(v.reason).toMatch(/captured raw and decode is refused/);
  });

  it("ADDED 2 of 3: an unbound decode ambiguity", () => {
    const r = row(evidenced);
    const v = eraConsumableBySemanticModel(r, RELEASE_SCOPE_FREEZE, {
      unboundAmbiguousContracts: new Set([`${r.chainId}|${r.proxyAddress}`]),
    });
    expect(v.consumable).toBe(false);
    expect(v.branch).toBe("decode_ambiguity_unbound");
  });

  it("ADDED 3 of 3: a row failing its magnitude tripwire", () => {
    const r = row(evidenced);
    const v = eraConsumableBySemanticModel(r, RELEASE_SCOPE_FREEZE, {
      magnitudeFailures: new Set([`${r.chainId}|${r.proxyAddress}|${r.eraIndex}`]),
    });
    expect(v.consumable).toBe(false);
    expect(v.branch).toBe("magnitude_tripwire_failed");
  });

  it("an ABSENT decode context refuses nothing, so a missing input never reads as a finding", () => {
    // A control that fires when its input is missing cannot be told apart from one that fires
    // because its input said so, and only the second kind is worth having.
    expect(eraConsumableBySemanticModel(row(evidenced), RELEASE_SCOPE_FREEZE, {}).consumable).toBe(true);
  });

  it("the grade propagates on a REFUSAL too, because those are different questions", () => {
    const v = eraConsumableBySemanticModel(row({ ...evidenced, release_scope: "out_of_release" }));
    expect(v.consumable).toBe(false);
    expect(v.confidenceGrade).toBe("announced");
    expect(v.gradeClause).toBe("B3");
  });
});

/*
 * The enforcement point. Unit 1's precedent: a policy living in a function nothing calls enforces
 * nothing, and this policy had exactly that shape -- its only callers were inside its own module.
 */
describe("the semantic-era policy is reached from the build path", () => {
  it("runs over the consumed eras and passes on the shipped seeds", () => {
    const result = runBuildCheck();
    expect(result.evidencedErasChecked).toBe(15);
    expect(result.evidencedErasRefused).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.startsWith("semantic era policy:"))).toBe(true);
  });

  it("the 15 consumed eras are exactly the in-release eras carrying promoted evidence", () => {
    const evidence = parseEraBoundaryEvidence();
    const rows = inspectControlPlane().plane!.registry.rows.filter(
      (r) => RELEASE_SCOPE_FREEZE.releaseChains.includes(r.chain) && !r.noCodeDeployed
        && evidence.has(eraEvidenceKey(r.chainId, r.proxyAddress, r.eraIndex)),
    );
    expect(rows).toHaveLength(15);
    for (const r of rows) expect(eraConsumableBySemanticModel(r, RELEASE_SCOPE_FREEZE, { boundaryEvidence: evidence }).consumable).toBe(true);
  });

  it("goes RED when a consumed era loses its ABI, so the refusal is load-bearing", () => {
    const evidence = parseEraBoundaryEvidence();
    const rows = inspectControlPlane().plane!.registry.rows.filter(
      (r) => evidence.has(eraEvidenceKey(r.chainId, r.proxyAddress, r.eraIndex)) && r.chain === "XDC",
    );
    expect(rows.length).toBeGreaterThan(0);
    const stripped = rows.map((r) => ({ ...r, abiSource: "none" }));
    const refusals = assertSemanticErasConsumable(stripped, "consumed semantic eras", RELEASE_SCOPE_FREEZE, { boundaryEvidence: evidence });
    expect(refusals).toHaveLength(rows.length);
    expect(refusals[0].detail).toMatch(/^abi_source is 'none'/);
  });
});

/*
 * The checks above run on the rule functions. These run on the fail-closed loader the pipeline
 * actually calls at startup, because "the validator fails the build" is the requirement, not
 * "a function returns a violation object".
 */
describe("the loader refuses to start the pipeline on a frozen-scope violation", () => {
  // `era_bound=false` asserts the event is present in EVERY era, so a two-era fixture needs a
  // surface row per era or the control fails on the surface rule instead of the scope rule.
  const surface = writeSurface([
    surfaceRow({ era_index: "1", implementation_address: IMPL_A }),
    surfaceRow({ era_index: "2", implementation_address: "0x2222222222222222222222222222222222222222" }),
  ]);

  it("starts on a declared seed where every row reads in_release", () => {
    const registry = writeRegistryWithBoundary(boundaryBody());
    const plane = loadControlPlane({ registry, eventSurface: surface });
    expect(plane.releaseScopeState).toBe("frozen_and_declared");
  });

  it("throws, naming the check, when one row still reads scope_pending", () => {
    const registry = writeRegistryWithBoundary(boundaryBody({ release_scope: "scope_pending" }));
    expect(() => loadControlPlane({ registry, eventSurface: surface }))
      .toThrow(/CONTROL_PLANE_REJECTED[\s\S]*no_scope_pending_when_frozen/);
  });

  it("reports the same violation through the inspection path, without throwing", () => {
    const registry = writeRegistryWithBoundary(boundaryBody({ release_scope: "scope_pending" }));
    const inspection = inspectControlPlane({ registry, eventSurface: surface });
    expect(inspection.ok).toBe(false);
    expect(inspection.releaseScopeViolations.map((v) => v.check)).toEqual([
      "no_scope_pending_when_frozen", "no_scope_pending_when_frozen",
    ]);
  });

  // RENAMED 2026-09-28 by the decode unit, together with the seed it describes.
  //   was: "still starts on the shipped pre-freeze seed, which carries no scope column at all"
  // The shipped seed now carries the declared boundary and scope block, so `pre_freeze_seed` is
  // no longer the state it is in. The property worth keeping is the same one: the shipped seed
  // starts the pipeline cleanly, and it now does so having STATED every row's scope rather than
  // by being silent about it -- which is the stronger of the two, since `scope_pending` exists
  // precisely to stop an undecided row passing as decided.
  it("starts on the shipped seed, which now declares every row's scope explicitly", () => {
    const inspection = inspectControlPlane();
    expect(inspection.releaseScopeState).toBe("frozen_and_declared");
    expect(inspection.releaseScopeViolations).toEqual([]);
    expect(inspection.decodeViolations).toEqual([]);
    expect(inspection.ok).toBe(true);
  });
});

/*
 * A dropped chain is refused everywhere it can be asked for.
 *
 * This block exists because the scope decision used to bind NOTHING on the path that writes:
 * `loadControlPlane`, the only caller of `assertReleaseScopeFrozen`, has no caller of its own in
 * this package, and `loadRegistry` deliberately does not run the frozen-scope checks. A decision
 * that is true in a document and false in the running system is the failure this whole change
 * exists to prevent, so each refusal below is asserted by running the thing, not by reading it.
 */
describe("a dropped chain is refused on every path that could act on it", () => {
  it("reports it as unsupported in plan mode, with a nonzero exit and the record named", () => {
    const plan = buildPlan({ mode: "daily", chains: ["fuse"] });

    expect(plan.outcome).toBe("unsupported");
    expect(plan.exitCode).not.toBe(0);
    expect(plan.refusals.join(" ")).toMatch(/FUSE is configured but is NOT in the release scope/);
    expect(plan.refusals.join(" ")).toContain(RELEASE_SCOPE_FREEZE.decisionRecord);
  });

  it("refuses to build capture targets for it, rather than returning none", () => {
    // Returning an empty list would be indistinguishable from "this chain has no contracts",
    // which is how a run covers nothing and still exits 0.
    expect(() => targetsFor(NETWORKS.FUSE)).toThrow(ChainOutOfReleaseScopeError);
    expect(() => targetsFor(NETWORKS.FUSE)).toThrow(/dropped from the release on 2026-09-28/);
    expect(() => targetsFor(NETWORKS.FUSE)).toThrow(/docs\/release-scope\.md/);
  });

  it("refuses a chain nobody decided about with a different reason than a dropped one", () => {
    const narrowed = { ...RELEASE_SCOPE_FREEZE, releaseChains: ["XDC"] as const };
    expect(() => targetsFor(NETWORKS.CELO, {}, narrowed)).toThrow(/nobody has decided about it/);
  });

  it("still builds capture targets for a chain that is in the release", () => {
    expect(targetsFor(NETWORKS.XDC).length).toBeGreaterThan(0);
  });

  it("partitions a run's chain list rather than aborting the whole run", () => {
    // What keeps a bare `daily` usable: Fuse is reported and skipped, Celo and XDC still run.
    const { usable, refused } = partitionByReleaseScope(Object.values(NETWORKS));
    expect(refused.map((r) => r.network.name)).toEqual(["FUSE"]);
    expect(usable.map((n) => n.name).sort()).toEqual([...RELEASE_SCOPE_FREEZE.releaseChains].sort());
    expect(refused[0].detail).toContain(RELEASE_SCOPE_FREEZE.decisionRecord);
  });

  it("refuses every Fuse era in the shipped seed, and names which branch refused each", () => {
    const fuseRows = inspectControlPlane().plane!.registry.rows.filter((r) => r.chain === "FUSE");
    expect(fuseRows).toHaveLength(96);

    let byNoCode = 0;
    let byReleaseScope = 0;
    for (const row of fuseRows) {
      const verdict = eraConsumableBySemanticModel(row);
      expect(verdict.consumable).toBe(false);
      if (row.noCodeDeployed) {
        // An earlier branch, and it fires first. Counted separately rather than folded in, so a
        // claim about the release-scope branch is a claim about the rows it actually decides.
        expect(verdict.reason).toMatch(/^no_code_deployed:/);
        expect(verdict.branch).toBe("no_code_deployed");
        byNoCode++;
      } else {
        // CHANGED 2026-09-28 by the decode unit, with the seed. The literal was
        // "release_scope is 'undeclared', not 'in_release'" while the seed carried no scope
        // column at all. It now carries one, and every Fuse row states its own exclusion rather
        // than being excluded by an absence. Same branch, stronger artifact.
        expect(verdict.reason).toBe("release_scope is 'out_of_release', not 'in_release'");
        expect(verdict.branch).toBe("release_scope_not_in_release");
        byReleaseScope++;
      }
    }
    // MEASURED 2026-09-28 against the shipped seed.
    expect([byNoCode, byReleaseScope]).toEqual([2, 94]);
  });

  /*
   * The closing argument, and it names a real seam rather than papering over it.
   *
   * `eraConsumableBySemanticModel` reads the ROW's `release_scope` column; it never consults the
   * freeze's chain list. On its own it would therefore let a Fuse era through if a seed ever
   * declared one `in_release` with complete boundary evidence. It cannot happen, because
   * `assertReleaseScopeFrozen` refuses exactly that combination and the loader refuses the whole
   * control plane on any violation -- so no loadable seed can produce a consumable Fuse era.
   *
   * Both halves are asserted here so that if either is ever weakened, this fails rather than
   * going quiet. The branch table itself is out of scope for this change by design.
   */
  it("closes the only route by which a Fuse era could become consumable", () => {
    const authority = chainsWith(["FUSE,122,Fuse,FUSE,https://explorer.fuse.io/tx/{tx_hash},true,"]);
    const readmitted = {
      chain: "FUSE", chain_id: "122", era_count: "1", valid_to_block: INT64_MAX, is_live: "true",
      release_scope: "in_release", boundary_completeness: "complete",
      boundary_evidence_manifest_hash: "0x" + "cd".repeat(32),
      boundary_checked_through_block: "107000000", frozen_safe_head: "107000100",
    };
    const parsed = parseRegistry(writeRegistryWithBoundary([registryRowWithBoundary(readmitted)]));

    // Half one: the era predicate alone WOULD admit it. Stated, not hidden.
    expect(eraConsumableBySemanticModel(parsed.rows[0]).consumable).toBe(true);

    // Half two: the seed carrying it is refused, so the predicate is never asked.
    expect(assertReleaseScopeFrozen(parsed, authority).map((v) => v.check))
      .toEqual(["dropped_chain_not_in_release"]);
  });
});
