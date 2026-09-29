/**
 * decodeSurface.ts -- the decode layer: union ABIs, the computed ambiguous set, and the
 * undecodable-log counter.
 *
 * WHY THE UNION IS THE FLOOR. Distinct parameter types produce distinct event hashes, so for all
 * but a measured handful of keys a union of every implementation's ABI cannot collide. That makes
 * the union provably correct rather than a compromise, and it is what every production indexer
 * does -- Ponder merges ABIs by address with no block dimension, Dune resubmits under one contract
 * name, Envio imports the current ABI. None of them models when each ABI was valid.
 *
 * WHY THE ORDER IS A CORRECTNESS DECISION AND NOT A STYLE CHOICE. `topic0` is keccak over the
 * canonical signature, which EXCLUDES `indexed` modifiers. Two implementations declaring the same
 * event with different indexed flags therefore produce the SAME topic0 and DIFFERENT physical
 * layouts, and a topic0-keyed decoder picks the first match in array order. Measured 2026-09-28
 * against viem on the real GReputation case:
 *
 *   era-1 log decoded against an era-2-first union  -> THROWS
 *   era-2 log decoded against an era-1-first union  -> DECODES SILENTLY WRONG, balance = 4,
 *                                                      which is the byte length of the string
 *                                                      "celo" read as a uint256
 *
 * A throw is recoverable. A plausible-looking wrong number is not. So every union here is built
 * NEWEST-IMPLEMENTATION-FIRST, which is correct for recent data -- where about 95 percent of the
 * questions live -- and raises loudly on old ambiguous data instead of lying about it.
 *
 * WHAT THIS MODULE DOES NOT BUILD. No era-scoped binding subsystem, no per-era ABI selection at
 * query time, no bisection tooling. The ambiguous set inside the ingestion scope is empty, and
 * building a resolution subsystem for an empty set is work with no member to serve. The assertion
 * below is what keeps that true: a third ambiguity fails the build rather than decoding silently.
 */

import type { EventSurfaceRow, ParsedEventSurface } from "./eventSurface.js";
import { contractKey } from "./contractRegistry.js";

/**
 * Ordinal, not locale-aware.
 *
 * `localeCompare` resolves through ICU collation, which orders punctuation against digits
 * differently depending on the locale data the runtime happens to carry -- so it would make the
 * ORDER of a shipped artifact an environment fact. Found by a test that expected one order and
 * got the other. Every ordering in this module is a property of the data, so it compares bytes.
 */
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One input of a union ABI event, in the shape viem and every ABI consumer expects. */
export interface UnionAbiInput {
  readonly name: string;
  readonly type: string;
  readonly indexed: boolean;
}

export interface UnionAbiEvent {
  readonly type: "event";
  readonly name: string;
  readonly inputs: readonly UnionAbiInput[];
  readonly anonymous: boolean;
}

/** A union entry with the provenance that put it there, so any ordering claim is checkable. */
export interface UnionAbiEntry {
  readonly event: UnionAbiEvent;
  readonly eraIndex: number;
  readonly line: number;
  readonly signature: string;
  readonly topic0: string | null;
  /** `formatAbiItem`-equivalent identity: name, parameter types AND indexed flags. */
  readonly identity: string;
}

export interface UnionAbi {
  readonly chain: string;
  readonly chainId: number;
  readonly address: string;
  readonly entries: readonly UnionAbiEntry[];
  /** The array a topic0-keyed decoder consumes, in the order it will try them. */
  readonly abi: readonly UnionAbiEvent[];
  /** Era indices contributing to this union, in the order they were merged. */
  readonly eraOrder: readonly number[];
}

/**
 * The identity two ABI entries must share to be the same entry.
 *
 * Ponder dedupes on `formatAbiItem`, which INCLUDES `indexed`, so two entries differing only in an
 * indexed flag both survive the merge. That is the right rule and it is deliberately reproduced:
 * collapsing them would silently discard one of the two real layouts and make the ambiguous set
 * unmeasurable.
 */
export function abiItemIdentity(row: EventSurfaceRow): string {
  const flags = row.paramTypes.map((t, i) => `${t}${row.indexedPositions.includes(i) ? " indexed" : ""}`);
  return `${row.anonymous ? "anonymous " : ""}event ${row.eventName}(${flags.join(",")})`;
}

function toEvent(row: EventSurfaceRow): UnionAbiEvent {
  return {
    type: "event",
    name: row.eventName,
    inputs: row.paramTypes.map((t, i) => ({
      name: row.paramNames[i] ?? "",
      type: t,
      indexed: row.indexedPositions.includes(i),
    })),
    anonymous: row.anonymous,
  };
}

/**
 * Build one contract's union ABI, newest implementation first.
 *
 * Ordering is by DESCENDING era index, then by ascending seed line inside an era so the result is
 * a pure function of the seed. Duplicate identities collapse to the newest occurrence, which is
 * what keeps the newest-first guarantee true after deduplication rather than merely before it.
 */
export function buildUnionAbi(rows: readonly EventSurfaceRow[]): UnionAbi {
  if (rows.length === 0) throw new Error("buildUnionAbi: no surface rows given");
  const first = rows[0];
  for (const r of rows) {
    if (r.chainId !== first.chainId || r.proxyAddress !== first.proxyAddress) {
      throw new Error(
        `buildUnionAbi: rows span more than one contract -- ${first.chainId}|${first.proxyAddress} and ${r.chainId}|${r.proxyAddress}`,
      );
    }
  }

  const ordered = [...rows].sort((a, b) => b.eraIndex - a.eraIndex || a.line - b.line);

  const seen = new Set<string>();
  const entries: UnionAbiEntry[] = [];
  for (const r of ordered) {
    const identity = abiItemIdentity(r);
    if (seen.has(identity)) continue;
    seen.add(identity);
    entries.push({ event: toEvent(r), eraIndex: r.eraIndex, line: r.line, signature: r.eventSignature, topic0: r.topic0, identity });
  }

  return {
    chain: first.chain,
    chainId: first.chainId,
    address: first.proxyAddress,
    entries,
    abi: entries.map((e) => e.event),
    eraOrder: entries.map((e) => e.eraIndex),
  };
}

/** Every contract's union, keyed by `contractKey(chainId, proxyAddress)`. */
export function buildAllUnionAbis(surface: ParsedEventSurface): Map<string, UnionAbi> {
  const byContract = new Map<string, EventSurfaceRow[]>();
  for (const r of surface.rows) {
    const k = contractKey(r.chainId, r.proxyAddress);
    const list = byContract.get(k);
    if (list) list.push(r);
    else byContract.set(k, [r]);
  }
  const out = new Map<string, UnionAbi>();
  for (const [k, rows] of byContract) out.set(k, buildUnionAbi(rows));
  return out;
}

/**
 * Is this union ordered newest-implementation-first?
 *
 * Returned rather than asserted so a caller can report every offender in one pass. A union with
 * one entry is trivially ordered; the property that matters is that no entry is preceded by an
 * entry from an OLDER era.
 */
export function isNewestFirst(union: UnionAbi): boolean {
  for (let i = 1; i < union.eraOrder.length; i++) {
    if (union.eraOrder[i] > union.eraOrder[i - 1]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The computed ambiguous set
// ---------------------------------------------------------------------------------------------

export interface AmbiguousLayout {
  /** The indexed positions, joined, or the empty-set marker. This IS the physical layout. */
  readonly indexedPositions: string;
  readonly eras: readonly number[];
  readonly lines: readonly number[];
}

export interface AmbiguousKey {
  readonly chain: string;
  readonly chainId: number;
  readonly address: string;
  readonly topic0: string;
  readonly signature: string;
  readonly layouts: readonly AmbiguousLayout[];
}

/**
 * The ambiguous set, computed offline from the seed with zero chain calls.
 *
 * Group each `(chain_id, proxy_address)` union by `topic0`; a group carrying more than one
 * distinct indexed-position layout is ambiguous. That is the complete test: topic0 fixes the event
 * name and the parameter TYPES, so two entries sharing a topic0 can differ only in which
 * parameters are indexed.
 *
 * Anonymous rows carry no topic0 and are excluded -- they are selected by position rather than by
 * selector, so they are not subject to this failure mode.
 */
export function computeAmbiguousKeys(surface: ParsedEventSurface): AmbiguousKey[] {
  const groups = new Map<string, { row: EventSurfaceRow; layouts: Map<string, { eras: number[]; lines: number[] }> }>();

  for (const r of surface.rows) {
    if (r.anonymous || r.topic0 === null) continue;
    const k = `${r.chainId}|${r.proxyAddress}|${r.topic0}`;
    let g = groups.get(k);
    if (!g) {
      g = { row: r, layouts: new Map() };
      groups.set(k, g);
    }
    const layout = r.indexedPositions.length === 0 ? "<none>" : r.indexedPositions.join(" ");
    const l = g.layouts.get(layout);
    if (l) {
      l.eras.push(r.eraIndex);
      l.lines.push(r.line);
    } else {
      g.layouts.set(layout, { eras: [r.eraIndex], lines: [r.line] });
    }
  }

  const out: AmbiguousKey[] = [];
  for (const g of groups.values()) {
    if (g.layouts.size < 2) continue;
    out.push({
      chain: g.row.chain,
      chainId: g.row.chainId,
      address: g.row.proxyAddress,
      topic0: g.row.topic0!,
      signature: g.row.eventSignature,
      layouts: [...g.layouts]
        .map(([indexedPositions, v]) => ({
          indexedPositions,
          eras: [...v.eras].sort((a, b) => a - b),
          lines: [...v.lines].sort((a, b) => a - b),
        }))
        .sort((a, b) => ordinal(a.indexedPositions, b.indexedPositions)),
    });
  }
  return out.sort((a, b) => a.chainId - b.chainId || ordinal(a.address, b.address) || ordinal(a.topic0, b.topic0));
}

export interface KnownAmbiguity {
  readonly chainId: number;
  readonly chain: string;
  readonly address: string;
  readonly signature: string;
  readonly disposition: string;
}

/**
 * The ambiguous keys this system has already looked at and decided about.
 *
 * MEASURED 2026-09-28 over the shipped `event_surface.csv`: exactly two, both the same contract on
 * two chains. Neither is inside the ingestion scope of this slice, which is why no era-scoped
 * binding subsystem is built -- it would have no member to serve.
 *
 * A key that is NOT in this list fails the build. That is the whole point: this declaration is
 * what makes a third ambiguity a loud event rather than a silent wrong decode.
 */
export const KNOWN_DECODE_AMBIGUITIES: readonly KnownAmbiguity[] = [
  {
    chainId: 1,
    chain: "ETHEREUM",
    address: "0x603b8c0f110e037b51a381cbcacabb8d6c6e4543",
    signature: "StateHashProof(string,address,uint256)",
    disposition:
      "GReputation. Era 1 declares no indexed parameter; eras 2 and 3 index the address. Ethereum " +
      "is in the declared release scope but is NOT ingested by this slice and no shipped model " +
      "reads this contract, so the union's newest-first order is the whole mitigation: an era-1 " +
      "log throws rather than decoding wrong. Revisit before Ethereum is ingested.",
  },
  {
    chainId: 122,
    chain: "FUSE",
    address: "0x603b8c0f110e037b51a381cbcacabb8d6c6e4543",
    signature: "StateHashProof(string,address,uint256)",
    disposition:
      "The same contract and the same layout change on Fuse. Fuse was dropped from the release on " +
      "2026-09-28; its rows are retained as a record. No capture path reaches it.",
  },
] as const;

export class UnhandledDecodeAmbiguityError extends Error {
  constructor(readonly keys: readonly AmbiguousKey[]) {
    const shown = keys
      .map((k) => {
        const layouts = k.layouts.map((l) => `indexed[${l.indexedPositions}] in era(s) ${l.eras.join(",")}`).join(" vs ");
        return `  ${k.chain} ${k.address} ${k.signature}\n    topic0 ${k.topic0}\n    ${layouts}`;
      })
      .join("\n");
    super(
      `DECODE_AMBIGUITY_UNHANDLED: ${keys.length} (chain, address, topic0) key(s) carry more than one ` +
        `physical layout and are not declared in KNOWN_DECODE_AMBIGUITIES.\n${shown}\n` +
        `A topic0-keyed decoder picks the first match in array order, so one of these layouts would be ` +
        `decoded into the wrong columns without raising. Declare each key with its disposition in ` +
        `src/control-plane/decodeSurface.ts, or bind the contract's eras to their own ABIs.`,
    );
    this.name = "UnhandledDecodeAmbiguityError";
  }
}

/**
 * The build-time assertion. Throws on any ambiguous key that has not been declared.
 *
 * Deliberately NOT scoped to the ingestion chains. Restricting it to what this slice captures
 * would let a new ambiguity on a declared-but-not-yet-ingested chain through in silence, and the
 * assertion exists precisely to catch the one nobody is looking for.
 */
export function assertNoUnhandledDecodeAmbiguity(surface: ParsedEventSurface): AmbiguousKey[] {
  const found = computeAmbiguousKeys(surface);
  const declared = new Set(KNOWN_DECODE_AMBIGUITIES.map((k) => `${k.chainId}|${k.address.toLowerCase()}|${k.signature}`));
  const undeclared = found.filter((k) => !declared.has(`${k.chainId}|${k.address.toLowerCase()}|${k.signature}`));
  if (undeclared.length > 0) throw new UnhandledDecodeAmbiguityError(undeclared);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Decode coverage: the undecodable-log counter
// ---------------------------------------------------------------------------------------------

/**
 * The minimum a captured log must carry for this counter to classify it. Deliberately structural
 * rather than the full row type, so the counter can run against a BigQuery result, a fixture or a
 * HyperSync response without any of them depending on the others.
 */
export interface DecodeCandidateLog {
  readonly chainId: number;
  readonly address: string;
  readonly topic0: string | null;
}

export interface UndecodableCount {
  readonly chainId: number;
  readonly address: string;
  readonly rowsConsidered: number;
  readonly rowsDecodable: number;
  /** Rows whose topic0 matched no entry in this address's surface. */
  readonly rowsUndecodable: number;
  /** Distinct unmatched topic0 values, so the answer names what to go and find an ABI for. */
  readonly unmatchedTopic0s: readonly string[];
  /** True when this address has no surface row at all, so nothing it emits can be decoded. */
  readonly addressHasNoSurface: boolean;
}

export interface UndecodableReport {
  readonly byContract: readonly UndecodableCount[];
  readonly rowsConsidered: number;
  readonly rowsUndecodable: number;
  /**
   * Rows this counter could NOT classify, counted separately from the result and never folded
   * into `rowsUndecodable`. An absence is a measurement only when its error count is zero, and a
   * null topic0 on a non-anonymous log means the ROW is unreadable, not that the event is unknown.
   */
  readonly errors: number;
  readonly errorDetail: readonly string[];
}

/**
 * Count, per `(chain, address)`, the rows whose `topic0` matched no entry in that address's
 * surface.
 *
 * WHY THIS EXISTS. Block coverage answers "what did we read". It does not answer "what could we
 * read". An undecodable log is indistinguishable from an absent one in every downstream model,
 * and the magnitude tripwire catches a wrong value, not a missing row. So the count is reported
 * beside block coverage rather than inferred from it.
 *
 * Owner: Unit 2 builds and proves the counter. Unit 3 reports it alongside block coverage, which
 * is where the captured rows are available to feed it.
 */
export function countUndecodableLogs(
  logs: readonly DecodeCandidateLog[],
  surface: ParsedEventSurface,
): UndecodableReport {
  const topicsByContract = new Map<string, Set<string>>();
  for (const r of surface.rows) {
    const k = contractKey(r.chainId, r.proxyAddress);
    let s = topicsByContract.get(k);
    if (!s) {
      s = new Set();
      topicsByContract.set(k, s);
    }
    if (r.topic0 !== null) s.add(r.topic0.toLowerCase());
  }

  const acc = new Map<string, { chainId: number; address: string; considered: number; decodable: number; undecodable: number; unmatched: Set<string> }>();
  let errors = 0;
  const errorDetail: string[] = [];

  for (const log of logs) {
    const addr = log.address.toLowerCase();
    const k = contractKey(log.chainId, addr);
    let a = acc.get(k);
    if (!a) {
      a = { chainId: log.chainId, address: addr, considered: 0, decodable: 0, undecodable: 0, unmatched: new Set() };
      acc.set(k, a);
    }

    if (log.topic0 === null) {
      errors++;
      if (errorDetail.length < 25) errorDetail.push(`${k}: a log carried no topic0, so it can be neither matched nor ruled out`);
      continue;
    }

    a.considered++;
    const known = topicsByContract.get(k);
    if (known && known.has(log.topic0.toLowerCase())) a.decodable++;
    else {
      a.undecodable++;
      a.unmatched.add(log.topic0.toLowerCase());
    }
  }

  const byContract = [...acc.values()]
    .map((a) => ({
      chainId: a.chainId,
      address: a.address,
      rowsConsidered: a.considered,
      rowsDecodable: a.decodable,
      rowsUndecodable: a.undecodable,
      unmatchedTopic0s: [...a.unmatched].sort(ordinal),
      addressHasNoSurface: !topicsByContract.has(contractKey(a.chainId, a.address)),
    }))
    .sort((x, y) => x.chainId - y.chainId || ordinal(x.address, y.address));

  return {
    byContract,
    rowsConsidered: byContract.reduce((n, c) => n + c.rowsConsidered, 0),
    rowsUndecodable: byContract.reduce((n, c) => n + c.rowsUndecodable, 0),
    errors,
    errorDetail,
  };
}

/**
 * The structural half of the same question, answerable with no captured rows at all: which
 * deployment intervals have no surface entry, so ANY log they emit is undecodable.
 *
 * This is what can be measured before ingestion has run. It is NOT a substitute for the row count
 * above and the unit report keeps the two apart.
 */
export interface UndecodableInterval {
  readonly chain: string;
  readonly chainId: number;
  readonly address: string;
  readonly contractName: string;
  readonly eraIndex: number;
  readonly reason: "no_abi_held" | "no_surface_row";
}

export function intervalsWithNoDecodableSurface(
  registryRows: readonly { chain: string; chainId: number; proxyAddress: string; contractName: string; eraIndex: number; abiSource: string; noCodeDeployed: boolean }[],
  surface: ParsedEventSurface,
): UndecodableInterval[] {
  const surfaceKeys = new Set(surface.rows.map((r) => `${r.chainId}|${r.proxyAddress}|${r.eraIndex}`));
  const out: UndecodableInterval[] = [];
  for (const r of registryRows) {
    if (r.noCodeDeployed) continue;
    if (surfaceKeys.has(`${r.chainId}|${r.proxyAddress}|${r.eraIndex}`)) continue;
    out.push({
      chain: r.chain,
      chainId: r.chainId,
      address: r.proxyAddress,
      contractName: r.contractName,
      eraIndex: r.eraIndex,
      reason: r.abiSource === "none" || r.abiSource === "" ? "no_abi_held" : "no_surface_row",
    });
  }
  return out;
}
