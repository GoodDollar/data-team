/**
 * eventSurface.ts -- schema, parse, topic0 proof and era binding for `event_surface.csv`.
 *
 * WHAT THIS SEED DECIDES. Which log is which event, per era. Getting it wrong does not produce an
 * error: it produces decoded rows whose columns hold the wrong values. Two measured facts make
 * that concrete. Five selectors carry two different indexed layouts, and two (chain, address,
 * topic0) keys change their indexed layout ACROSS THEIR OWN ERAS -- GReputation's
 * `StateHashProof(string,address,uint256)` has no indexed parameter in era 1 and an indexed
 * `address` in eras 2 and 3. So era resolution is mandatory, and a surface row that binds to the
 * wrong era decodes real logs into the wrong fields silently.
 *
 * WHY topic0 IS RECOMPUTED RATHER THAN TRUSTED. An indexed flag is not part of the selector.
 * A wrong-indexed ABI returns the right row count, throws nothing, and writes fields into the
 * wrong columns. Recomputing keccak256 over the canonical signature is the only check that binds
 * the stored topic0 to the stored parameter types rather than to itself.
 */

import { join } from "path";
import { keccak256, toBytes } from "viem";
import { readStrictCsv, SeedParseError, type StrictCsv } from "./csv.js";
import { SEEDS_DIR, type ChainAuthority } from "./chains.js";
import { parseFiniteInt, parseLowerBound, parseUpperBound, compareBounds, type BlockBound } from "./int64.js";
import { address, optionalAddress, bool, nonEmpty, hex32, violation, type Violation, type FieldContext } from "./fields.js";
import { contractKey, type ParsedRegistry, type RegistryRow } from "./contractRegistry.js";

export const EVENT_SURFACE_PATH = join(SEEDS_DIR, "event_surface.csv");

export const EVENT_SURFACE_HEADER = [
  "chain", "chain_id", "contract_name", "proxy_address", "era_index", "implementation_address",
  "event_name", "event_signature", "topic0", "anonymous", "indexed_positions", "param_types",
  "param_names", "era_bound", "era_bound_from_block", "era_bound_to_block", "abi_source",
  "source", "notes",
] as const;

/**
 * A non-anonymous event spends topic0 on its selector, leaving three indexed slots. An anonymous
 * event has no selector and may use all four. Exceeding either is physically impossible on chain,
 * so it is a defect in the seed, not a capture limitation.
 */
export const MAX_INDEXED_NON_ANONYMOUS = 3;
export const MAX_INDEXED_ANONYMOUS = 4;

/** Topic slots the universal RawLogs grain physically carries besides topic0. */
export const RAWLOGS_INDEXED_SLOTS = 3;

const SOLIDITY_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * An indexed parameter of a non-value type is stored as keccak256 of its encoding, so the value
 * itself never reaches the chain and is unrecoverable from any log capture, at any completeness.
 * Solidity's rule is "arrays and structs", plus the two dynamic byte types.
 */
export function isHashOnlyWhenIndexed(abiType: string): boolean {
  return abiType === "string" || abiType === "bytes" || abiType.includes("[") || abiType.includes("(") || abiType.startsWith("tuple");
}

export interface EventSurfaceRow {
  readonly line: number;
  readonly chain: string;
  readonly chainId: number;
  readonly contractName: string;
  readonly proxyAddress: string;
  readonly eraIndex: number;
  readonly implementationAddress: string | null;
  readonly eventName: string;
  readonly eventSignature: string;
  readonly topic0: string | null;
  readonly anonymous: boolean;
  readonly indexedPositions: readonly number[];
  readonly paramTypes: readonly string[];
  readonly paramNames: readonly string[];
  readonly eraBound: boolean;
  readonly eraBoundFrom: BlockBound | null;
  readonly eraBoundTo: BlockBound | null;
  readonly abiSource: string;
  readonly source: string;
  readonly notes: string;
  /** Indexed positions whose declared type reaches the topic as a hash only. */
  readonly hashOnlyIndexedPositions: readonly number[];
  readonly raw: readonly string[];
}

export interface ParsedEventSurface {
  readonly rows: readonly EventSurfaceRow[];
  readonly csv: StrictCsv;
}

function at<T>(path: string, line: number, column: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SeedParseError) throw e;
    throw new SeedParseError(path, `column '${column}': ${(e as Error).message}`, line);
  }
}

/**
 * A space-separated list where every element must carry a value.
 *
 * Split is exact: no trimming and no collapsing, so the element count is a faithful function of
 * the field. An empty element here is a defect, because a type and an indexed position are both
 * things that cannot be blank.
 */
function requiredList(path: string, line: number, column: string, raw: string): string[] {
  if (raw === "") return [];
  const parts = raw.split(" ");
  if (parts.some((p) => p === "")) {
    throw new SeedParseError(path, `column '${column}': '${raw}' has a leading, trailing or repeated space, which would make an element blank`, line);
  }
  return parts;
}

/**
 * The parameter-name list, where an EMPTY element is legitimate.
 *
 * Solidity permits an unnamed event parameter and this seed contains one: Uniswap V2's
 * `PairCreated(address indexed token0, address indexed token1, address pair, uint)` leaves its
 * fourth parameter unnamed, so the field reads `token0 token1 pair ` with a trailing space. An
 * exact split is a bijection with the element list -- names are Solidity identifiers and cannot
 * contain a space -- so `token0 token1 pair ` is unambiguously three named parameters and one
 * unnamed one. Trimming it, or collapsing the space, would silently lose which parameter is the
 * unnamed one.
 */
function nameList(path: string, line: number, column: string, raw: string, expectedCount: number): string[] {
  if (expectedCount === 0) {
    if (raw !== "") throw new SeedParseError(path, `column '${column}': '${raw}' is set but the event declares no parameters`, line);
    return [];
  }
  const parts = raw.split(" ");
  for (const p of parts) {
    if (p !== "" && !SOLIDITY_IDENTIFIER.test(p)) {
      throw new SeedParseError(path, `column '${column}': '${p}' is not a Solidity identifier`, line);
    }
  }
  return parts;
}

/** keccak256 over the UTF-8 bytes of the canonical signature, lowercase 0x-prefixed. */
export function topic0For(signature: string): string {
  return keccak256(toBytes(signature));
}

/** `Name(type1,type2)` built from the stored name and stored parameter types. */
export function canonicalSignature(eventName: string, paramTypes: readonly string[]): string {
  return `${eventName}(${paramTypes.join(",")})`;
}

export function parseEventSurface(path = EVENT_SURFACE_PATH): ParsedEventSurface {
  const csv = readStrictCsv(path, [EVENT_SURFACE_HEADER]);
  const rows: EventSurfaceRow[] = [];

  for (let i = 0; i < csv.records.length; i++) {
    const r = csv.records[i];
    const line = csv.recordLines[i];
    const ctx = (column: string): FieldContext => ({ path, line, column });

    const chain = nonEmpty(ctx("chain"), r[0]);
    const chainId = at(path, line, "chain_id", () => parseFiniteInt("chain_id", r[1], { min: 1 }));
    const contractName = nonEmpty(ctx("contract_name"), r[2]);
    const proxyAddress = address(ctx("proxy_address"), r[3]);
    const eraIndex = at(path, line, "era_index", () => parseFiniteInt("era_index", r[4], { min: 1 }));
    const implementationAddress = optionalAddress(ctx("implementation_address"), r[5]);
    const eventName = nonEmpty(ctx("event_name"), r[6]);
    if (!SOLIDITY_IDENTIFIER.test(eventName)) {
      throw new SeedParseError(path, `column 'event_name': '${eventName}' is not a Solidity identifier`, line);
    }
    const eventSignature = nonEmpty(ctx("event_signature"), r[7]);
    const anonymous = bool(ctx("anonymous"), r[9]);
    const topic0 = anonymous ? null : hex32(ctx("topic0"), r[8]);
    if (anonymous && r[8] !== "") {
      // An anonymous event has no selector. A value in topic0 would be a real indexed parameter
      // and treating it as a selector is exactly how an anonymous event gets mis-bound.
      throw new SeedParseError(path, `column 'topic0': anonymous event '${eventSignature}' must leave topic0 empty, found '${r[8]}'`, line);
    }

    const paramTypes = requiredList(path, line, "param_types", r[11]);
    const paramNames = nameList(path, line, "param_names", r[12], paramTypes.length);
    const indexedPositions = requiredList(path, line, "indexed_positions", r[10])
      .map((p) => at(path, line, "indexed_positions", () => parseFiniteInt("indexed_positions", p, { min: 0 })));

    if (paramNames.length !== paramTypes.length) {
      throw new SeedParseError(path, `${paramTypes.length} param_types but ${paramNames.length} param_names`, line);
    }
    for (const p of indexedPositions) {
      if (p >= paramTypes.length) {
        throw new SeedParseError(path, `indexed position ${p} is outside the ${paramTypes.length} declared parameter(s)`, line);
      }
    }
    if (new Set(indexedPositions).size !== indexedPositions.length) {
      throw new SeedParseError(path, `duplicate value in indexed_positions '${r[10]}'`, line);
    }
    for (let k = 1; k < indexedPositions.length; k++) {
      if (indexedPositions[k] <= indexedPositions[k - 1]) {
        throw new SeedParseError(path, `indexed_positions '${r[10]}' is not strictly ascending`, line);
      }
    }

    const eraBound = bool(ctx("era_bound"), r[13]);
    let eraBoundFrom: BlockBound | null = null;
    let eraBoundTo: BlockBound | null = null;
    if (eraBound) {
      eraBoundFrom = at(path, line, "era_bound_from_block", () => parseLowerBound("era_bound_from_block", r[14], { min: 0 }));
      // `era_bound=true` is this seed's explicit open-ended declaration. Whether the sentinel is
      // ACTUALLY admissible is settled against the deployment era in validateEventSurface; it can
      // only be admissible at all on a bounded row.
      eraBoundTo = at(path, line, "era_bound_to_block", () => parseUpperBound("era_bound_to_block", r[15], { declaredOpenEnded: r[15] === "9223372036854775807", min: 0 }));
    } else if (r[14] !== "" || r[15] !== "") {
      throw new SeedParseError(path, `era_bound=false but era_bound_from_block='${r[14]}' / era_bound_to_block='${r[15]}' are not both empty`, line);
    }

    rows.push({
      line, chain, chainId, contractName, proxyAddress, eraIndex, implementationAddress,
      eventName, eventSignature, topic0, anonymous, indexedPositions, paramTypes, paramNames,
      eraBound, eraBoundFrom, eraBoundTo,
      abiSource: nonEmpty(ctx("abi_source"), r[16]),
      source: nonEmpty(ctx("source"), r[17]),
      notes: r[18],
      hashOnlyIndexedPositions: indexedPositions.filter((p) => isHashOnlyWhenIndexed(paramTypes[p])),
      raw: r,
    });
  }

  return { rows, csv };
}

export interface SurfaceCheckCounts {
  /** Rows whose topic0 was recomputed (non-anonymous only). */
  readonly topic0Checked: number;
  readonly topic0Matched: number;
  /** Rows whose stored signature was rebuilt from stored name + param types. */
  readonly signatureChecked: number;
  readonly signatureMatched: number;
  readonly anonymousRows: number;
  readonly boundRowsChecked: number;
  readonly boundGroupsChecked: number;
  readonly boundGroupsMatchingEnvelope: number;
  readonly bindingChecked: number;
  readonly bindingMatched: number;
  readonly hashOnlyIndexedRows: number;
}

/**
 * Cross-row and cross-seed rules. Counts are returned alongside violations because "every topic0
 * matched" is only meaningful next to how many were actually recomputed.
 */
export function validateEventSurface(
  parsed: ParsedEventSurface,
  registry: ParsedRegistry,
  chains: ChainAuthority,
): { violations: Violation[]; advisories: Violation[]; counts: SurfaceCheckCounts } {
  const v: Violation[] = [];
  // Reported, never blocking. An advisory is a true statement about the CAPTURE GRAIN rather than
  // a defect in the seed. Blocking on one would refuse to start the pipeline over a row that is
  // correctly describing the chain.
  const advisories: Violation[] = [];
  const counts = {
    topic0Checked: 0, topic0Matched: 0, signatureChecked: 0, signatureMatched: 0,
    anonymousRows: 0, boundRowsChecked: 0, boundGroupsChecked: 0, boundGroupsMatchingEnvelope: 0,
    bindingChecked: 0, bindingMatched: 0, hashOnlyIndexedRows: 0,
  };

  // Exactly one era row per (chain, proxy_address, era_index). Built from the registry so a
  // duplicate there surfaces here as an ambiguous bind rather than an arbitrary first match.
  const eraByKey = new Map<string, RegistryRow[]>();
  for (const row of registry.rows) {
    const k = `${row.chainId}|${row.proxyAddress}|${row.eraIndex}`;
    const list = eraByKey.get(k);
    if (list) list.push(row);
    else eraByKey.set(k, [row]);
  }
  const contractExists = new Set(registry.rows.map((r) => contractKey(r.chainId, r.proxyAddress)));

  for (const row of parsed.rows) {
    const subject = `${row.chain} ${row.proxyAddress} era ${row.eraIndex} ${row.eventSignature}`;

    const expectedId = chains.byName.get(row.chain);
    if (expectedId === undefined) {
      v.push(violation("chain_known", row.line, subject, `chain '${row.chain}' is not declared in ${chains.path}`));
    } else if (expectedId !== row.chainId) {
      v.push(violation("chain_id_consistency", row.line, subject, `chain '${row.chain}' is chain_id ${expectedId} in the chains seed but this row says ${row.chainId}`));
    }

    counts.signatureChecked++;
    const canonical = canonicalSignature(row.eventName, row.paramTypes);
    if (canonical === row.eventSignature) counts.signatureMatched++;
    else v.push(violation("signature_canonical", row.line, subject, `stored event_signature '${row.eventSignature}' does not equal '${canonical}' rebuilt from event_name and param_types`));

    if (row.anonymous) {
      counts.anonymousRows++;
      if (row.indexedPositions.length > MAX_INDEXED_ANONYMOUS) {
        v.push(violation("anonymous_topic_slots", row.line, subject, `${row.indexedPositions.length} indexed parameters exceed the ${MAX_INDEXED_ANONYMOUS} physical topic slots available to an anonymous event`));
      }
      if (row.indexedPositions.length > RAWLOGS_INDEXED_SLOTS) {
        // Not a seed defect: the seed is right and the grain is narrower than the chain. Recorded
        // so it cannot be discovered later as missing data with no explanation.
        advisories.push(violation("anonymous_not_capturable_in_rawlogs", row.line, subject, `anonymous event uses ${row.indexedPositions.length} topic slots but RawLogs reserves topic0 for NULL and carries ${RAWLOGS_INDEXED_SLOTS} indexed slots, so this event is not losslessly capturable in the current grain`));
      }
    } else {
      counts.topic0Checked++;
      const recomputed = topic0For(row.eventSignature);
      if (recomputed === row.topic0) counts.topic0Matched++;
      else v.push(violation("topic0_recompute", row.line, subject, `stored topic0 ${row.topic0} but keccak256('${row.eventSignature}') = ${recomputed}`));

      if (row.indexedPositions.length > MAX_INDEXED_NON_ANONYMOUS) {
        v.push(violation("indexed_slot_limit", row.line, subject, `${row.indexedPositions.length} indexed parameters, but a non-anonymous event has only ${MAX_INDEXED_NON_ANONYMOUS} topic slots after the selector`));
      }
    }

    if (row.hashOnlyIndexedPositions.length > 0) counts.hashOnlyIndexedRows++;

    // Task 7: exactly one binding, and it must be the exact era, not merely the same contract.
    counts.bindingChecked++;
    const matches = eraByKey.get(`${row.chainId}|${row.proxyAddress}|${row.eraIndex}`) ?? [];
    if (matches.length === 1) {
      counts.bindingMatched++;
      const era = matches[0];
      if (era.noCodeDeployed) {
        v.push(violation("surface_binds_to_deployed_era", row.line, subject, `binds to a ${era.eraMethod} registry row, which declares no deployed code`));
      }
      if (era.contractName !== row.contractName) {
        v.push(violation("contract_name_agreement", row.line, subject, `contract_name '${row.contractName}' but the registry era says '${era.contractName}'`));
      }
      if (row.implementationAddress !== null && era.implementationAddress !== null && row.implementationAddress !== era.implementationAddress) {
        v.push(violation("implementation_agreement", row.line, subject, `implementation_address ${row.implementationAddress} but the registry era says ${era.implementationAddress}`));
      }

      if (row.eraBound && era.validFrom && era.validTo) {
        counts.boundRowsChecked++;
        // WHAT era_bound_from/to ACTUALLY MEAN, from the seed's own schema: "First block this
        // event can be emitted at" and "Exclusive upper bound", for an event that is NOT present
        // in every era of its contract. So the window is the event's PRESENCE ENVELOPE across the
        // contract's history, not a sub-range of one era. The era this row is declared on must
        // therefore sit INSIDE the window; a row claiming an event is decodable in an era its own
        // window excludes is a contradiction. Every comparison is on the discriminated bound, so
        // the open-ended sentinel is never coerced to a number.
        if (compareBounds(era.validFrom, row.eraBoundFrom!) < 0) {
          v.push(violation("surface_era_within_window", row.line, subject, `era ${era.eraIndex} starts at ${era.validFrom.lexeme}, before the event's declared first block ${row.eraBoundFrom!.lexeme}`));
        }
        if (compareBounds(era.validTo, row.eraBoundTo!) > 0) {
          v.push(violation("surface_era_within_window", row.line, subject, `era ${era.eraIndex} ends at ${era.validTo.lexeme}, after the event's declared exclusive upper bound ${row.eraBoundTo!.lexeme}`));
        }
        if (era.validTo.kind === "open_ended" && row.eraBoundTo!.kind !== "open_ended") {
          v.push(violation("surface_live_era_needs_open_window", row.line, subject, `registry era ${era.eraIndex} is open ended but the event's window closes at the finite block ${row.eraBoundTo!.lexeme}`));
        }
        if (compareBounds(row.eraBoundFrom!, row.eraBoundTo!) >= 0) {
          v.push(violation("surface_interval_ordering", row.line, subject, `era_bound_from_block ${row.eraBoundFrom!.lexeme} is not below era_bound_to_block ${row.eraBoundTo!.lexeme}`));
        }
      }
    } else if (matches.length === 0) {
      const detail = contractExists.has(contractKey(row.chainId, row.proxyAddress))
        ? `no era ${row.eraIndex} exists for that contract in the registry`
        : `contract ${row.proxyAddress} is not in the registry on chain_id ${row.chainId}`;
      v.push(violation("surface_binds_to_one_era", row.line, subject, detail));
    } else {
      v.push(violation("surface_binds_to_one_era", row.line, subject, `binds to ${matches.length} registry rows (lines ${matches.map((m) => m.line).join(", ")})`));
    }
  }

  // Group-level rules. An event is one (chain, contract, selector) across however many eras carry
  // it, and the declared window has to describe exactly those eras -- otherwise a decoder that
  // trusts the window covers blocks where the event does not exist, or refuses blocks where it
  // does. The seed's own schema warns that 59 combinations are removed in one era and restored in
  // a later one, so a first-and-last envelope is the only thing the window can honestly be, and
  // the per-era rows remain the precise statement of presence.
  const groups = new Map<string, EventSurfaceRow[]>();
  for (const row of parsed.rows) {
    const k = `${row.chainId}|${row.proxyAddress}|${row.anonymous ? row.eventSignature : row.topic0}`;
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }

  const erasByContract = new Map<string, RegistryRow[]>();
  for (const r of registry.rows) {
    if (r.noCodeDeployed) continue;
    const k = contractKey(r.chainId, r.proxyAddress);
    const list = erasByContract.get(k);
    if (list) list.push(r);
    else erasByContract.set(k, [r]);
  }

  for (const [, rows] of groups) {
    const head = rows[0];
    const subject = `${head.chain} ${head.proxyAddress} ${head.eventSignature}`;
    const contractEras = erasByContract.get(contractKey(head.chainId, head.proxyAddress)) ?? [];
    if (contractEras.length === 0) continue;

    const bound = rows.filter((r) => r.eraBound);
    if (bound.length > 0 && bound.length !== rows.length) {
      v.push(violation("era_bound_flag_agreement", head.line, subject, `${bound.length} of ${rows.length} rows for this event declare era_bound=true; the flag describes the event, not one era`));
      continue;
    }

    if (bound.length === 0) {
      // era_bound=false asserts the event is present in EVERY era of its contract.
      const covered = new Set(rows.map((r) => r.eraIndex));
      const missing = contractEras.filter((e) => !covered.has(e.eraIndex)).map((e) => e.eraIndex);
      if (missing.length > 0) {
        v.push(violation("unbound_event_covers_all_eras", head.line, subject, `era_bound=false asserts presence in every era, but era(s) ${missing.join(", ")} of ${contractEras.length} carry no row for it`));
      }
      continue;
    }

    counts.boundGroupsChecked++;
    const froms = new Set(rows.map((r) => r.eraBoundFrom!.lexeme));
    const tos = new Set(rows.map((r) => r.eraBoundTo!.lexeme));
    if (froms.size > 1 || tos.size > 1) {
      v.push(violation("era_bound_window_agreement", head.line, subject, `rows for this event disagree on its window: from {${[...froms].join(", ")}} to {${[...tos].join(", ")}}`));
      continue;
    }

    const present = new Set(rows.map((r) => r.eraIndex));
    const presentEras = contractEras.filter((e) => present.has(e.eraIndex));
    if (presentEras.length === 0) continue;
    const envelopeFrom = presentEras.reduce((a, b) => (compareBounds(a.validFrom!, b.validFrom!) <= 0 ? a : b)).validFrom!;
    const envelopeTo = presentEras.reduce((a, b) => (compareBounds(a.validTo!, b.validTo!) >= 0 ? a : b)).validTo!;

    const fromExact = head.eraBoundFrom!.lexeme === envelopeFrom.lexeme;
    const toExact = head.eraBoundTo!.lexeme === envelopeTo.lexeme;
    if (!fromExact) {
      v.push(violation("era_bound_window_is_exact_envelope", head.line, subject, `era_bound_from_block is ${head.eraBoundFrom!.lexeme} but the earliest era carrying this event starts at ${envelopeFrom.lexeme}`));
    }
    if (!toExact) {
      v.push(violation("era_bound_window_is_exact_envelope", head.line, subject, `era_bound_to_block is ${head.eraBoundTo!.lexeme} but the latest era carrying this event ends at ${envelopeTo.lexeme}`));
    }
    if (fromExact && toExact) counts.boundGroupsMatchingEnvelope++;
  }

  return { violations: v, advisories, counts };
}
