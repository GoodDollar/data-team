/**
 * releaseScope.ts -- the frozen release scope, and the checks that keep it frozen.
 *
 * WHY THIS IS CODE AND NOT A NOTE. The plan forbids A5 from either including or silently
 * excluding an undecided contract. A decision recorded only in prose cannot enforce that: the
 * next seed regeneration can reintroduce an excluded address and nothing would object. So the
 * decision is declared here, next to the loader that reads the seed, and the loader refuses to
 * start the pipeline if the seed and the decision disagree.
 *
 * THE DECISION. Recorded 2026-09-28 by whoever owns release scope, on the evidence summarised in
 * `docs/release-scope.md`: all nineteen ambiguous candidates are excluded, and Base and Gnosis
 * stay out as a DECISION NOT TO ASSESS rather than as an assessment. Nobody queried either chain.
 * That distinction is preserved below because a silence later reads as if somebody had checked.
 *
 * THE AMENDMENT, the same day. Fuse was DROPPED from the release: its data is disproportionately
 * expensive to obtain and it was holding up everything else. The recorded Fuse inventory is
 * RETAINED in the seeds rather than deleted -- 1 chain row, 96 deployment rows and 616 event
 * surface rows bound to them by a composite foreign key -- because deleting the deployment rows
 * orphans the surface rows, and because a deleted row says nothing while a retained row declared
 * out of the release says exactly what happened. `chainsDropped` is what keeps retention from
 * becoming re-admission.
 *
 * WHAT EACH STATE MEANS, and why only one of them fails the build.
 *
 *   `scope_pending`  A row the seed declares undecided. Correct before the freeze, illegal after
 *                    it. This is the state the plan names, and it fails the build.
 *   `undeclared`     Not a value a seed may carry. It is what the loader reports when the whole
 *                    optional boundary/scope column block is absent, which is the shipped seed
 *                    today. It does not fail the build, because the same absence already forces
 *                    every era to `raw_only_unproven`, which forbids every decoder and every
 *                    user-facing model over every era. That is a STRICTLY STRONGER prohibition
 *                    than `out_of_release`, so nothing can be silently included while it holds.
 *                    `releaseScopeState()` names that condition and a test pins the coupling, so
 *                    the two columns can never be decoupled without the test failing.
 *
 * WHAT A CHAIN'S STANDING MEANS, which is a different axis from a row's `release_scope`.
 *
 *   `in_release`     Named in `releaseChains`. Capture, planning and semantic consumption are
 *                    all permitted, subject to every other rule.
 *   `dropped`        Named in `chainsDropped`. Its recorded rows are legal and stay; every path
 *                    that would act on the chain refuses. See `chainStanding`.
 *   `undeclared`     In neither list. Nobody decided, so it FAILS THE BUILD. This is the case the
 *                    discriminator exists to preserve: without `chainsDropped`, dropping a chain
 *                    would have meant making the check stop firing, which also stops it catching
 *                    a chain that arrived in a seed by accident.
 */

import type { ChainAuthority } from "./chains.js";
import {
  assertScopeFrozen,
  type ParsedRegistry,
  type RegistryRow,
} from "./contractRegistry.js";
import { gradeForEra, type ConfidenceGrade, type EraBoundaryEvidence } from "./eraConfidence.js";
import { violation, type Violation } from "./fields.js";

export interface ExcludedContract {
  readonly chainId: number;
  readonly chain: string;
  readonly contractName: string;
  /** Lowercase 20-byte address, as the registry stores it. */
  readonly address: string;
}

/** A chain deliberately removed from the release, with the day it left and why. */
export interface DroppedChain {
  readonly chain: string;
  readonly droppedOn: string;
  readonly reason: string;
}

export interface ReleaseScopeFreeze {
  readonly frozen: boolean;
  readonly decidedOn: string;
  readonly decisionRecord: string;
  readonly planSha256: string;
  /**
   * Plans this decision was made under before the current one, newest first. Carried rather than
   * overwritten: an artifact that cites only its latest governing document loses the ability to
   * answer "what was this decided under at the time".
   */
  readonly supersededPlanSha256: readonly string[];
  readonly releaseChains: readonly string[];
  /**
   * Chains removed from the release ON PURPOSE. This is NOT the same as a chain nobody decided
   * about, and keeping them apart is the whole reason the field exists: a chain in neither list
   * still fails the build.
   */
  readonly chainsDropped: readonly DroppedChain[];
  readonly chainsNotAssessed: readonly { readonly chain: string; readonly note: string }[];
  readonly excludedContracts: readonly ExcludedContract[];
  readonly evidence: readonly string[];
}

export const RELEASE_SCOPE_FREEZE: ReleaseScopeFreeze = {
  frozen: true,
  decidedOn: "2026-09-28",
  decisionRecord: "docs/release-scope.md",
  planSha256: "BAA0005DEE707BA6BF26DCC100194087AC84299084C372AE5DED6569325ECA02",
  supersededPlanSha256: ["9DCDE225459127C4DA2BEADF9094FD894FE193010F39CB70C0753DD874853E26"],
  releaseChains: ["CELO", "XDC", "ETHEREUM"],
  chainsDropped: [
    {
      chain: "FUSE",
      droppedOn: "2026-09-28",
      reason:
        "no HyperSync index exists, the only archive-capable endpoint is rate limited to roughly " +
        "54 reads per hour, the transaction index is pruned so creation blocks cannot be " +
        "established by receipt lookup, and no endpoint serves a finality tag. Serving Fuse to the " +
        "same standard as the other chains was holding up the release. Recorded rows are retained; " +
        "see docs/release-scope.md",
    },
  ],
  chainsNotAssessed: [
    { chain: "BASE", note: "decision not to assess; zero queries were made against this chain" },
    { chain: "GNOSIS", note: "decision not to assess; zero queries were made against this chain" },
  ],
  // The nineteen A1-R candidates. 140 privilege checks against the production Controller, GD
  // token and Identity returned zero grants with two or more endpoints agreeing on every check,
  // and eighteen of nineteen hold zero production GD. Addresses are copied from the receipts
  // named in `evidence`, never retyped from a document. The six on Fuse are kept after the chain
  // was dropped: an exclusion is a finding about an address, and it does not expire because the
  // chain left the release.
  excludedContracts: [
    { chainId: 122, chain: "FUSE", contractName: "ProxyFactory", address: "0x4659176e962763e7c8a4ef965ecfd0fdf9f52057" },
    { chainId: 122, chain: "FUSE", contractName: "NameService", address: "0xe26867ddd22f9342d9f0d566d182f2c960683971" },
    { chainId: 122, chain: "FUSE", contractName: "GReputation", address: "0x3a9299be789ac3730e4e4c49d6d2ad1b8bc34dff" },
    { chainId: 122, chain: "FUSE", contractName: "CompoundVotingMachine", address: "0xc2ff55b896e3c42f9e1c2f7467c51b93f1c23dfd" },
    { chainId: 122, chain: "FUSE", contractName: "ClaimersDistribution", address: "0xf34552f1583c0b981dbb09611128c3375b47182e" },
    { chainId: 122, chain: "FUSE", contractName: "UBIScheme", address: "0x87d77a30a6819860eb8332d293810ed7b510035a" },
    { chainId: 1, chain: "ETHEREUM", contractName: "ProxyFactory", address: "0x4659176e962763e7c8a4ef965ecfd0fdf9f52057" },
    { chainId: 1, chain: "ETHEREUM", contractName: "NameService", address: "0xe26867ddd22f9342d9f0d566d182f2c960683971" },
    { chainId: 1, chain: "ETHEREUM", contractName: "GReputation", address: "0x3a9299be789ac3730e4e4c49d6d2ad1b8bc34dff" },
    { chainId: 1, chain: "ETHEREUM", contractName: "CompoundVotingMachine", address: "0xc2ff55b896e3c42f9e1c2f7467c51b93f1c23dfd" },
    { chainId: 1, chain: "ETHEREUM", contractName: "GoodMarketMaker", address: "0x30d37b05cf73edd8c59ce8450f093f6c06da9272" },
    { chainId: 1, chain: "ETHEREUM", contractName: "GoodReserveCDai", address: "0x6c35677206ae7ff1bf753877649cf57cc30d1c42" },
    { chainId: 1, chain: "ETHEREUM", contractName: "ExchangeHelper", address: "0x0a8c6bb832801454f6cc21761d0a293caa003296" },
    { chainId: 1, chain: "ETHEREUM", contractName: "GoodFundManager", address: "0x3f55bd3b432edc73bbb704fa5a29cc08dc1adbeb" },
    { chainId: 1, chain: "ETHEREUM", contractName: "StakersDistribution", address: "0x12d15efc3c9661ad68209cd197d416bfd9b145f5" },
    { chainId: 1, chain: "ETHEREUM", contractName: "UniswapV2SwapHelper", address: "0x62305662fa7c4bc442803b940d9192dbdc92d710" },
    { chainId: 1, chain: "ETHEREUM", contractName: "CompoundStakingFactory", address: "0x5f6f25143cd580e2e285210d7cfcb26e59cf9566" },
    { chainId: 1, chain: "ETHEREUM", contractName: "AaveStakingFactory", address: "0xa99ba154223052b8c5fd92b3f5df9eb08b72d5fc" },
    { chainId: 1, chain: "ETHEREUM", contractName: "DonationsStaking", address: "0x06eafc6749723583672fc8f4451c8ec0e59f5798" },
  ],
  // PROMOTED 2026-09-28. These three entries used to name files under `specs/_scratch/`, which is
  // gitignored and local to one machine -- so a receipt pointing there could not be opened by
  // anyone holding only this repository, which makes it an assertion rather than a receipt. The
  // decision-relevant substance now ships in the repository at the paths below. The raw probe
  // output that produced it stays local by design; it is working material, not a reader-facing
  // artifact, and the claim it supports is reproducible from what ships.
  evidence: [
    "docs/release-scope.md",
    "gd_dbt/seeds/contract_deployments.csv",
  ],
} as const;

/**
 * Which of the two legitimate conditions the registry is in.
 *
 * `pre_freeze_seed` is not a pass. It means the seed predates the freeze and therefore carries no
 * boundary or scope columns at all, which forces `raw_only_unproven` everywhere.
 */
export type ReleaseScopeState = "pre_freeze_seed" | "frozen_and_declared";

export function releaseScopeState(parsed: ParsedRegistry): ReleaseScopeState {
  return parsed.hasBoundaryColumns ? "frozen_and_declared" : "pre_freeze_seed";
}

function excludedKey(chainId: number, address: string): string {
  return `${chainId}|${address.toLowerCase()}`;
}

/** Where a chain stands against the frozen release. The three cases are deliberately distinct. */
export type ChainReleaseStanding = "in_release" | "dropped" | "undeclared";

/**
 * The single answer to "may this system act on this chain".
 *
 * Every path that could act on a chain asks this rather than keeping its own list. `dropped` and
 * `undeclared` both forbid action; they differ only in whether the absence was a decision, and
 * that difference is what the seed checks below report.
 */
export function chainStanding(
  chain: string,
  freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE,
): ChainReleaseStanding {
  if (freeze.releaseChains.includes(chain)) return "in_release";
  if (freeze.chainsDropped.some((c) => c.chain === chain)) return "dropped";
  return "undeclared";
}

/**
 * The checks that run because scope is frozen. Returned rather than thrown so one run names every
 * violation; `loadControlPlane` rejects the whole control plane if the list is non-empty.
 */
export function assertReleaseScopeFrozen(
  parsed: ParsedRegistry,
  chains: ChainAuthority,
  freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE,
): Violation[] {
  if (!freeze.frozen) return [];

  const v: Violation[] = [];
  const release = new Set(freeze.releaseChains);
  const dropped = new Map(freeze.chainsDropped.map((c) => [c.chain, c]));
  const excluded = new Map(freeze.excludedContracts.map((c) => [excludedKey(c.chainId, c.address), c]));

  // A freeze naming a chain in both lists decides nothing. Caught here rather than letting
  // whichever list happens to be read first win the answer.
  for (const [chain] of dropped) {
    if (release.has(chain)) {
      v.push(violation(
        "release_scope_declaration_coherent",
        null,
        chain,
        `the freeze names '${chain}' in releaseChains AND in chainsDropped; a chain is in the release or it is dropped, never both`,
      ));
    }
  }

  // A chain the authority declares but the freeze does not is a scope change wearing a seed edit.
  // A DROPPED chain is not that: it was decided about, its rows are retained on purpose, and the
  // refusals live on the paths that would act on it rather than on the row that records it.
  for (const row of chains.rows) {
    if (chainStanding(row.chain, freeze) === "undeclared") {
      v.push(violation(
        "release_chain_frozen",
        row.line,
        `${row.chain} (chain_id ${row.chainId})`,
        `the chains seed declares '${row.chain}' but the frozen release scope is ${[...release].join(", ")} and '${row.chain}' is not recorded as dropped either; a scope change invalidates the frozen seeds and returns the work to Phase 2`,
      ));
    }
  }

  for (const row of parsed.rows) {
    const subject = `${row.chain} ${row.proxyAddress} (${row.contractName})`;
    const standing = chainStanding(row.chain, freeze);

    if (standing === "undeclared") {
      v.push(violation("release_chain_frozen", row.line, subject, `row names chain '${row.chain}', which is neither in the frozen release scope nor recorded as dropped from it`));
    }

    // Retention is a record, not a re-admission. A row on a dropped chain may say anything about
    // itself except that it is in the release, because that is the one claim the drop denies.
    const drop = dropped.get(row.chain);
    if (drop && row.releaseScope === "in_release") {
      v.push(violation(
        "dropped_chain_not_in_release",
        row.line,
        subject,
        `chain '${row.chain}' was dropped from the release on ${drop.droppedOn} but this row declares release_scope 'in_release'; a retained row is a record of what was measured, not a way back into the release`,
      ));
    }

    // Exclusion has to be enforced on BOTH address columns and matched on (chain_id, column). A
    // substring match over the whole file manufactured a false membership during A1-R by
    // colliding with a different chain's implementation_address.
    const asProxy = excluded.get(excludedKey(row.chainId, row.proxyAddress));
    if (asProxy) {
      v.push(violation(
        "excluded_contract_absent",
        row.line,
        subject,
        `proxy_address is ${asProxy.chain} ${asProxy.contractName}, excluded from the release on ${freeze.decidedOn}; see ${freeze.decisionRecord}`,
      ));
    }
    if (row.implementationAddress !== null) {
      const asImpl = excluded.get(excludedKey(row.chainId, row.implementationAddress));
      if (asImpl) {
        v.push(violation(
          "excluded_contract_absent",
          row.line,
          subject,
          `implementation_address is ${asImpl.chain} ${asImpl.contractName}, excluded from the release on ${freeze.decidedOn}; see ${freeze.decisionRecord}`,
        ));
      }
    }
  }

  // `scope_pending` is only reachable when the seed carries the column. When it does not, every
  // era is already `raw_only_unproven`, so nothing is consumable and nothing can be silently
  // included. See the header.
  if (releaseScopeState(parsed) === "frozen_and_declared") {
    v.push(...assertScopeFrozen(parsed));
  }

  return v;
}

/**
 * Which branch decided. Named so the branch table can be asserted by name rather than by counting
 * refusals, and so a future edit that deletes a branch fails a test instead of going quiet.
 *
 * `boundary_completeness_raw_only_unproven` is ABSENT ON PURPOSE. It was a shipped branch and it
 * was removed; leaving the name behind would let a reader believe the rule still exists somewhere.
 */
export const ERA_CONSUMABILITY_BRANCHES = [
  "no_code_deployed",
  "release_scope_not_in_release",
  "boundary_evidence_incomplete",
  "abi_unknown",
  "decode_ambiguity_unbound",
  "magnitude_tripwire_failed",
  "consumable",
] as const;
export type EraConsumabilityBranch = (typeof ERA_CONSUMABILITY_BRANCHES)[number];

export interface EraConsumability {
  readonly consumable: boolean;
  readonly reason: string;
  /** The branch that decided, always set, including on the pass. */
  readonly branch: EraConsumabilityBranch;
  /**
   * The confidence grade, which PROPAGATES rather than gates. Present on a refusal too: "how
   * wrong could this be" and "may I proceed" are different questions and this answers the first
   * one either way.
   */
  readonly confidenceGrade: ConfidenceGrade;
  readonly gradeClause: string;
}

/**
 * The facts a decode refusal needs that a registry row does not carry.
 *
 * All three are optional and an absent one refuses nothing. That is deliberate: a control that
 * fires when its input is missing is indistinguishable from a control that fires when its input
 * says so, and the second one is the only useful kind.
 */
export interface EraDecodeContext {
  /**
   * `chainId|address` for contracts carrying a decode ambiguity with no era-scoped binding.
   * Computed offline from the event surface; see `decodeSurface.computeAmbiguousKeys`.
   */
  readonly unboundAmbiguousContracts?: ReadonlySet<string>;
  /** `chainId|address|eraIndex` for rows whose decoded values failed a magnitude tripwire. */
  readonly magnitudeFailures?: ReadonlySet<string>;
  /** Promoted boundary evidence, keyed by `eraEvidenceKey`, for the propagating grade. */
  readonly boundaryEvidence?: ReadonlyMap<string, EraBoundaryEvidence>;
}

/**
 * May a semantic model decode this era?
 *
 * THE REVERSAL, 2026-09-28, and what it is not. This function used to refuse every
 * `raw_only_unproven` interval, which is every interval in the release. That rule was written when
 * `complete` was believed reachable. It is not: reaching it required every slot-writing path to
 * obligatorily emit an upgrade event, and EIP-1967 says SHOULD, not MUST -- OpenZeppelin's own
 * reference implementation writes the slot before emitting on the rollback branch. Applying the
 * bar honestly produced 0 provable eras out of 41, and a bar that cannot tell a well-understood
 * contract from an unknown one is uninformative rather than conservative.
 *
 * So `raw_only_unproven` stops being a refusal and becomes a propagating grade. The control is
 * narrowed in exactly one place and widened in three, each of the three on a condition that is
 * actually actionable:
 *
 *   RETAINED  no code deployed
 *   RETAINED  the row is not in the release        <- this is what keeps dropped chains out
 *   REMOVED   boundary_completeness is raw_only_unproven
 *   RETAINED  boundary evidence incomplete          <- stated as its refusal condition
 *   ADDED     the interval's ABI is unknown         <- no ABI, no decode
 *   ADDED     an unbound decode ambiguity           <- two layouts, one topic0, no binding
 *   ADDED     a failed magnitude tripwire           <- the value is not a possible quantity
 *
 * The two retained refusals are the reason removing the third is safe: an out-of-release row and
 * an unevidenced row are both still refused, so nothing is admitted that nobody decided about.
 */
export function eraConsumableBySemanticModel(
  row: RegistryRow,
  freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE,
  context: EraDecodeContext = {},
): EraConsumability {
  const evidence = context.boundaryEvidence ?? new Map<string, EraBoundaryEvidence>();
  const g = gradeForEra(row, evidence);
  const grade = { confidenceGrade: g.grade, gradeClause: g.clause };

  if (row.noCodeDeployed) {
    return { consumable: false, branch: "no_code_deployed", ...grade, reason: "no_code_deployed: the contract has no code and declares no era interval" };
  }
  if (freeze.frozen && row.releaseScope !== "in_release") {
    return { consumable: false, branch: "release_scope_not_in_release", ...grade, reason: `release_scope is '${row.releaseScope}', not 'in_release'` };
  }
  if (row.boundaryEvidenceManifestHash === null || row.boundaryCheckedThroughBlock === null || row.frozenSafeHead === null) {
    return { consumable: false, branch: "boundary_evidence_incomplete", ...grade, reason: "boundary evidence is incomplete: manifest hash, checked-through block and frozen safe head must all be present" };
  }
  if (row.abiSource === "none" || row.abiSource === "") {
    return {
      consumable: false,
      branch: "abi_unknown",
      ...grade,
      reason: "abi_source is 'none': no ABI is held for this implementation, so its logs are captured raw and decode is refused for the interval",
    };
  }
  const contract = `${row.chainId}|${row.proxyAddress}`;
  if (context.unboundAmbiguousContracts?.has(contract)) {
    return {
      consumable: false,
      branch: "decode_ambiguity_unbound",
      ...grade,
      reason: `${contract} carries a topic0 with more than one physical layout and no era-scoped binding, so a decoder would pick one of them without raising`,
    };
  }
  if (context.magnitudeFailures?.has(`${contract}|${row.eraIndex}`)) {
    return {
      consumable: false,
      branch: "magnitude_tripwire_failed",
      ...grade,
      reason: "a consumed numeric field on this interval failed its magnitude tripwire, which is what a wrong-layout or wrong-scale decode looks like",
    };
  }
  return {
    consumable: true,
    branch: "consumable",
    ...grade,
    reason: `boundary_completeness='${row.boundaryCompleteness}' through frozen safe head ${row.frozenSafeHead}, confidence '${g.grade}' by rule ${g.clause}`,
  };
}

/** The policy check a semantic model's era selection must pass. One violation per refused era. */
export function assertSemanticErasConsumable(
  rows: readonly RegistryRow[],
  modelName: string,
  freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE,
  context: EraDecodeContext = {},
): Violation[] {
  const v: Violation[] = [];
  for (const row of rows) {
    const verdict = eraConsumableBySemanticModel(row, freeze, context);
    if (!verdict.consumable) {
      v.push(violation(
        "semantic_era_reviewed",
        row.line,
        `${modelName} -> ${row.chain} ${row.proxyAddress} era ${row.eraIndex}`,
        verdict.reason,
      ));
    }
  }
  return v;
}
