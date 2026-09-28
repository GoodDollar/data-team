/**
 * contractRegistry.ts -- schema, parse and cross-row validation for `contract_deployments.csv`.
 *
 * This seed is the contract universe and the era map. Two properties make it unusually
 * unforgiving:
 *
 *   1. A dropped row silently shrinks what the pipeline covers. Nothing downstream can tell a
 *      contract that was never ingested apart from a contract that produced no logs.
 *   2. `lookupEra` cannot fail by construction, so a wrong or missing era yields a CONFIDENT WRONG
 *      decode rather than an error. 115 eras announce nothing at all on chain, so there is no
 *      independent signal to catch it afterwards.
 *
 * Every check below therefore rejects the whole file rather than the offending row.
 *
 * ON THE BOUNDARY-EVIDENCE COLUMNS. The plan requires the schema to carry
 * `boundary_completeness`, `boundary_evidence_manifest_hash`, `boundary_checked_through_block` and
 * the frozen safe head that registry and event surface share. They are declared here as an
 * optional trailing block: present, they are validated as a unit; absent, every era is
 * `raw_only_unproven`, which is precisely the state the plan assigns to an era with no boundary
 * evidence. What is NOT done here is infer `plain_contract` from `era_method`. That verdict rests
 * on creation-bytecode identity and a proven absence of any proxy mutation surface; deriving it
 * from a field that only records how the era was found would manufacture the evidence.
 */

import { join } from "path";
import { readStrictCsv, SeedParseError, type StrictCsv } from "./csv.js";
import { SEEDS_DIR, type ChainAuthority } from "./chains.js";
import { parseFiniteInt, parseLowerBound, parseUpperBound, compareBounds, type BlockBound } from "./int64.js";
import { address, optionalAddress, optionalHex32, bool, nonEmpty, oneOf, violation, type Violation, type FieldContext } from "./fields.js";

export const REGISTRY_PATH = join(SEEDS_DIR, "contract_deployments.csv");

export const REGISTRY_HEADER_BASE = [
  "chain", "chain_id", "contract_name", "category", "provenance", "proxy_address",
  "implementation_address", "implementation_name", "era_index", "era_count", "valid_from_block",
  "valid_to_block", "is_live", "creation_block", "creation_method", "era_method", "era_evidence",
  "era_announcement_event", "abi_source", "runtime_code_hash", "semantics_note", "source", "notes",
] as const;

/** The declared boundary-evidence block, appended as a unit when Phase 2 task 16 regenerates. */
export const REGISTRY_BOUNDARY_COLUMNS = [
  "boundary_completeness", "boundary_evidence_manifest_hash", "boundary_checked_through_block",
  "frozen_safe_head", "release_scope",
] as const;

export const REGISTRY_HEADER_WITH_BOUNDARY = [...REGISTRY_HEADER_BASE, ...REGISTRY_BOUNDARY_COLUMNS] as const;

export const BOUNDARY_COMPLETENESS = ["complete", "plain_contract", "raw_only_unproven"] as const;
export type BoundaryCompleteness = (typeof BOUNDARY_COMPLETENESS)[number];

/**
 * Release scope, per row.
 *
 * `scope_pending` exists so an undecided contract is RECORDED as undecided rather than resolved by
 * whichever way the seed happens to fall. The plan is explicit that A5 may neither include nor
 * silently exclude such a row, which is only enforceable if the state has a name.
 *
 * `undeclared` is not a value a seed may carry. It is what this loader reports when the column is
 * absent altogether, so "nobody has decided yet" never reads as "everything is in".
 */
export const RELEASE_SCOPE = ["in_release", "out_of_release", "scope_pending"] as const;
export type ReleaseScope = (typeof RELEASE_SCOPE)[number] | "undeclared";

/** The exact marker that declares the no-code exception shape. */
export const NO_CODE_ERA_METHOD = "no_code_deployed";

export interface RegistryRow {
  readonly line: number;
  readonly chain: string;
  readonly chainId: number;
  readonly contractName: string;
  readonly category: string;
  readonly provenance: string;
  readonly proxyAddress: string;
  readonly implementationAddress: string | null;
  readonly implementationName: string;
  readonly eraIndex: number;
  readonly eraCount: number;
  /** Null only on a `no_code_deployed` row, which declares no era interval at all. */
  readonly validFrom: BlockBound | null;
  readonly validTo: BlockBound | null;
  readonly isLive: boolean;
  readonly creationBlock: number | null;
  readonly creationMethod: string;
  readonly eraMethod: string;
  readonly eraEvidence: string;
  readonly eraAnnouncementEvent: string;
  readonly abiSource: string;
  readonly runtimeCodeHash: string | null;
  readonly semanticsNote: string;
  readonly source: string;
  readonly notes: string;
  readonly noCodeDeployed: boolean;
  readonly boundaryCompleteness: BoundaryCompleteness;
  readonly boundaryEvidenceManifestHash: string | null;
  readonly boundaryCheckedThroughBlock: number | null;
  readonly frozenSafeHead: number | null;
  readonly releaseScope: ReleaseScope;
  /** Original field lexemes, so a regenerated seed reproduces the source byte for byte. */
  readonly raw: readonly string[];
}

export interface ParsedRegistry {
  readonly rows: readonly RegistryRow[];
  readonly csv: StrictCsv;
  readonly hasBoundaryColumns: boolean;
}

/** Adds file/line/column context to the lexeme-level errors thrown by int64.ts. */
function at<T>(path: string, line: number, column: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SeedParseError) throw e;
    throw new SeedParseError(path, `column '${column}': ${(e as Error).message}`, line);
  }
}

export function contractKey(chainId: number, proxyAddress: string): string {
  return `${chainId}|${proxyAddress}`;
}

/**
 * Parse every physical row. Throws on the FIRST malformed one; never filters, never skips.
 */
export function parseRegistry(path = REGISTRY_PATH): ParsedRegistry {
  const csv = readStrictCsv(path, [REGISTRY_HEADER_BASE, REGISTRY_HEADER_WITH_BOUNDARY]);
  const hasBoundaryColumns = csv.header.length === REGISTRY_HEADER_WITH_BOUNDARY.length;
  const rows: RegistryRow[] = [];

  for (let i = 0; i < csv.records.length; i++) {
    const r = csv.records[i];
    const line = csv.recordLines[i];
    const ctx = (column: string): FieldContext => ({ path, line, column });

    const chain = nonEmpty(ctx("chain"), r[0]);
    const chainId = at(path, line, "chain_id", () => parseFiniteInt("chain_id", r[1], { min: 1 }));
    const contractName = nonEmpty(ctx("contract_name"), r[2]);
    const category = nonEmpty(ctx("category"), r[3]);
    const provenance = nonEmpty(ctx("provenance"), r[4]);
    const proxyAddress = address(ctx("proxy_address"), r[5]);
    const implementationAddress = optionalAddress(ctx("implementation_address"), r[6]);
    const implementationName = nonEmpty(ctx("implementation_name"), r[7]);
    const eraIndex = at(path, line, "era_index", () => parseFiniteInt("era_index", r[8], { min: 1 }));
    const eraCount = at(path, line, "era_count", () => parseFiniteInt("era_count", r[9], { min: 0 }));
    const isLive = bool(ctx("is_live"), r[12]);
    const eraMethod = nonEmpty(ctx("era_method"), r[15]);
    const noCodeDeployed = eraMethod === NO_CODE_ERA_METHOD;

    let validFrom: BlockBound | null = null;
    let validTo: BlockBound | null = null;
    let creationBlock: number | null = null;

    if (noCodeDeployed) {
      // The declared exception shape, enforced in full so it cannot be used as a hiding place for
      // a row that simply failed to resolve its blocks.
      if (r[10] !== "" || r[11] !== "" || r[13] !== "") {
        throw new SeedParseError(path, `${NO_CODE_ERA_METHOD} row must leave valid_from_block, valid_to_block and creation_block empty, found '${r[10]}' / '${r[11]}' / '${r[13]}'`, line);
      }
      if (eraIndex !== 1 || eraCount !== 0) {
        throw new SeedParseError(path, `${NO_CODE_ERA_METHOD} row must declare era_index=1 and era_count=0, found ${eraIndex} / ${eraCount}`, line);
      }
      if (isLive) throw new SeedParseError(path, `${NO_CODE_ERA_METHOD} row cannot be is_live=true`, line);
      if (implementationAddress !== null) {
        throw new SeedParseError(path, `${NO_CODE_ERA_METHOD} row must leave implementation_address empty`, line);
      }
    } else {
      validFrom = at(path, line, "valid_from_block", () => parseLowerBound("valid_from_block", r[10], { min: 0 }));
      // The row's own `is_live` flag is the explicit open-ended declaration. The sentinel is
      // admissible here and nowhere else, and it never becomes a JavaScript number.
      validTo = at(path, line, "valid_to_block", () => parseUpperBound("valid_to_block", r[11], { declaredOpenEnded: isLive, min: 0 }));
      creationBlock = at(path, line, "creation_block", () => parseFiniteInt("creation_block", r[13], { min: 0 }));
      if (eraCount < 1) {
        throw new SeedParseError(path, `era_count must be at least 1 on a deployed contract, found ${eraCount}`, line);
      }
    }

    let boundaryCompleteness: BoundaryCompleteness = "raw_only_unproven";
    let boundaryEvidenceManifestHash: string | null = null;
    let boundaryCheckedThroughBlock: number | null = null;
    let frozenSafeHead: number | null = null;
    let releaseScope: ReleaseScope = "undeclared";

    if (hasBoundaryColumns) {
      boundaryCompleteness = oneOf(ctx("boundary_completeness"), r[23], BOUNDARY_COMPLETENESS);
      boundaryEvidenceManifestHash = optionalHex32(ctx("boundary_evidence_manifest_hash"), r[24]);
      boundaryCheckedThroughBlock = r[25] === "" ? null : at(path, line, "boundary_checked_through_block", () => parseFiniteInt("boundary_checked_through_block", r[25], { min: 0 }));
      frozenSafeHead = r[26] === "" ? null : at(path, line, "frozen_safe_head", () => parseFiniteInt("frozen_safe_head", r[26], { min: 0 }));
      releaseScope = oneOf(ctx("release_scope"), r[27], RELEASE_SCOPE);

      // The block is validated as a unit: a completeness verdict with no reproducible manifest,
      // no checked-through block or no frozen head is an assertion, not evidence.
      if (boundaryCompleteness !== "raw_only_unproven") {
        if (boundaryEvidenceManifestHash === null || boundaryCheckedThroughBlock === null || frozenSafeHead === null) {
          throw new SeedParseError(path, `boundary_completeness='${boundaryCompleteness}' requires boundary_evidence_manifest_hash, boundary_checked_through_block and frozen_safe_head to all be present`, line);
        }
        if (boundaryCheckedThroughBlock > frozenSafeHead) {
          throw new SeedParseError(path, `boundary_checked_through_block ${boundaryCheckedThroughBlock} is above frozen_safe_head ${frozenSafeHead}`, line);
        }
      }
    }

    rows.push({
      line, chain, chainId, contractName, category, provenance, proxyAddress,
      implementationAddress, implementationName, eraIndex, eraCount, validFrom, validTo, isLive,
      creationBlock, creationMethod: nonEmpty(ctx("creation_method"), r[14]), eraMethod,
      eraEvidence: nonEmpty(ctx("era_evidence"), r[16]),
      eraAnnouncementEvent: nonEmpty(ctx("era_announcement_event"), r[17]),
      abiSource: nonEmpty(ctx("abi_source"), r[18]),
      runtimeCodeHash: optionalHex32(ctx("runtime_code_hash"), r[19]),
      semanticsNote: r[20], source: nonEmpty(ctx("source"), r[21]), notes: r[22],
      noCodeDeployed, boundaryCompleteness, boundaryEvidenceManifestHash,
      boundaryCheckedThroughBlock, frozenSafeHead, releaseScope, raw: r,
    });
  }

  return { rows, csv, hasBoundaryColumns };
}

/**
 * Cross-row rules. Returned rather than thrown so one run names every violation; the loader
 * rejects the registry if the list is non-empty.
 *
 * Era intervals are half-open, [valid_from_block, valid_to_block), which is the convention the era
 * lookup already implements. "No gap" is therefore an exact equality between one era's upper bound
 * and the next one's lower bound, not an inequality.
 */
export function validateRegistry(parsed: ParsedRegistry, chains: ChainAuthority): Violation[] {
  const v: Violation[] = [];
  const byContract = new Map<string, RegistryRow[]>();

  for (const row of parsed.rows) {
    const subject = `${row.chain} ${row.proxyAddress} era ${row.eraIndex}`;

    const expectedId = chains.byName.get(row.chain);
    if (expectedId === undefined) {
      v.push(violation("chain_known", row.line, subject, `chain '${row.chain}' is not declared in ${chains.path}`));
    } else if (expectedId !== row.chainId) {
      v.push(violation("chain_id_consistency", row.line, subject, `chain '${row.chain}' is chain_id ${expectedId} in the chains seed but this row says ${row.chainId}`));
    }

    if (row.isLive && row.validTo !== null && row.validTo.kind !== "open_ended") {
      v.push(violation("live_era_not_expired", row.line, subject, `is_live=true but valid_to_block is the finite value ${row.validTo.lexeme}`));
    }
    if (!row.isLive && row.validTo !== null && row.validTo.kind === "open_ended") {
      v.push(violation("open_ended_requires_live", row.line, subject, "valid_to_block is the open-ended sentinel but is_live=false"));
    }
    if (row.validFrom !== null && row.validTo !== null && compareBounds(row.validFrom, row.validTo) >= 0) {
      v.push(violation("interval_ordering", row.line, subject, `valid_from_block ${row.validFrom.lexeme} is not below valid_to_block ${row.validTo.lexeme}`));
    }
    if (row.creationBlock !== null && row.validFrom !== null && row.validFrom.kind === "finite" && row.creationBlock > row.validFrom.value) {
      v.push(violation("creation_before_first_era", row.line, subject, `creation_block ${row.creationBlock} is after valid_from_block ${row.validFrom.lexeme}`));
    }

    const key = contractKey(row.chainId, row.proxyAddress);
    const list = byContract.get(key);
    if (list) list.push(row);
    else byContract.set(key, [row]);
  }

  for (const [key, rows] of byContract) {
    const head = rows[0];
    const subject = `${head.chain} ${head.proxyAddress} (${head.contractName})`;

    if (head.noCodeDeployed) {
      if (rows.length !== 1) {
        v.push(violation("no_code_single_row", head.line, subject, `${NO_CODE_ERA_METHOD} contract carries ${rows.length} rows; it must carry exactly one`));
      }
      continue;
    }

    const declaredCounts = new Set(rows.map((r) => r.eraCount));
    if (declaredCounts.size > 1) {
      v.push(violation("era_count_agreement", head.line, subject, `rows disagree on era_count: ${[...declaredCounts].join(", ")}`));
    }
    if (head.eraCount !== rows.length) {
      v.push(violation("era_count_matches_rows", head.line, subject, `era_count=${head.eraCount} but ${rows.length} era row(s) are present`));
    }

    const names = new Set(rows.map((r) => r.contractName));
    if (names.size > 1) {
      v.push(violation("contract_name_agreement", head.line, subject, `rows disagree on contract_name: ${[...names].join(", ")}`));
    }

    const indexes = rows.map((r) => r.eraIndex).sort((a, b) => a - b);
    for (let i = 0; i < indexes.length; i++) {
      if (indexes[i] !== i + 1) {
        v.push(violation("era_index_contiguous", head.line, subject, `era indexes are not contiguous from 1: ${indexes.join(", ")}`));
        break;
      }
    }

    const live = rows.filter((r) => r.isLive);
    if (live.length > 1) {
      v.push(violation("single_live_era", head.line, subject, `${live.length} eras are marked is_live=true (${live.map((r) => r.eraIndex).join(", ")})`));
    }

    const ordered = [...rows].sort((a, b) => compareBounds(a.validFrom!, b.validFrom!) || a.eraIndex - b.eraIndex);
    for (let i = 0; i < ordered.length; i++) {
      // The era carrying the highest index must be the one carrying the highest interval, or the
      // era map and the declared order describe two different histories.
      if (ordered[i].eraIndex !== i + 1) {
        v.push(violation("era_order_matches_blocks", ordered[i].line, subject, `era ${ordered[i].eraIndex} sits at block-order position ${i + 1}`));
      }
    }
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const next = ordered[i];
      const cmp = compareBounds(prev.validTo!, next.validFrom!);
      if (cmp > 0) {
        v.push(violation("era_overlap", next.line, subject, `era ${prev.eraIndex} ends at ${prev.validTo!.lexeme} which is after era ${next.eraIndex} starts at ${next.validFrom!.lexeme}`));
      } else if (cmp < 0) {
        v.push(violation("era_gap", next.line, subject, `undeclared gap: era ${prev.eraIndex} ends at ${prev.validTo!.lexeme} and era ${next.eraIndex} starts at ${next.validFrom!.lexeme}`));
      }
    }

    const last = ordered[ordered.length - 1];
    if (last.validTo!.kind === "open_ended" && !last.isLive) {
      v.push(violation("open_ended_requires_live", last.line, subject, "the final era is open ended but not marked is_live"));
    }

    const duplicateIndex = rows.length !== new Set(rows.map((r) => r.eraIndex)).size;
    if (duplicateIndex) {
      v.push(violation("era_index_unique", head.line, subject, `duplicate era_index within ${key}`));
    }
  }

  return v;
}

/**
 * The check that runs when the release scope is frozen, and only then.
 *
 * It is separate from `validateRegistry` on purpose. Before scope is frozen, `scope_pending` is
 * the CORRECT state for an undecided row and must not fail the build. After the freeze, a
 * `scope_pending` or `undeclared` row is exactly the silent inclusion or exclusion the plan
 * forbids, so it must fail.
 */
export function assertScopeFrozen(parsed: ParsedRegistry): Violation[] {
  const v: Violation[] = [];
  for (const row of parsed.rows) {
    if (row.releaseScope === "scope_pending" || row.releaseScope === "undeclared") {
      v.push(violation(
        "no_scope_pending_when_frozen",
        row.line,
        `${row.chain} ${row.proxyAddress} (${row.contractName})`,
        `release_scope is '${row.releaseScope}' but the release scope has been frozen; every row must read in_release or out_of_release`,
      ));
    }
  }
  return v;
}
