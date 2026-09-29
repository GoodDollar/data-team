/**
 * The decode layer: union ABIs, the computed ambiguous set, and the undecodable-log counter.
 *
 * The centrepiece is the union-order test. It does not merely assert that a list is sorted -- it
 * decodes a real log both ways with the same decoder the system would use, and pins the exact
 * wrong value the wrong order produces. An ordering assertion that only checks the array would
 * still pass if the ordering stopped mattering, and the whole point is that it matters.
 */

import { describe, it, expect } from "vitest";
import { decodeEventLog, encodeAbiParameters, keccak256, pad, toHex } from "viem";
import { parseEventSurface } from "../../src/control-plane/eventSurface.js";
import { parseRegistry } from "../../src/control-plane/contractRegistry.js";
import { inspectControlPlane } from "../../src/control-plane/index.js";
import {
  buildUnionAbi,
  buildAllUnionAbis,
  isNewestFirst,
  computeAmbiguousKeys,
  assertNoUnhandledDecodeAmbiguity,
  countUndecodableLogs,
  intervalsWithNoDecodableSurface,
  abiItemIdentity,
  UnhandledDecodeAmbiguityError,
  KNOWN_DECODE_AMBIGUITIES,
} from "../../src/control-plane/decodeSurface.js";
import { runBuildCheck, parseArgs } from "../../src/control-plane/build-check.js";
import { surfaceRow, writeSurface, UBI } from "../helpers/seed-fixtures.js";

/*
 * The real ambiguity, reproduced at fixture scale.
 *
 * `GReputation.StateHashProof(string,address,uint256)` declares no indexed parameter in era 1 and
 * indexes the address in eras 2 and 3. Indexed modifiers are excluded from the signature hash, so
 * both layouts share one topic0 and a topic0-keyed decoder has two candidates.
 */
const SIG = "StateHashProof(string,address,uint256)";
const TOPIC0 = keccak256(toHex(SIG));
const USER = "0x603b8c0f110e037b51a381cbcacabb8d6c6e4543";
const BALANCE = 1234567890123456789n;

const stateHashProofRow = (era: string, indexed: string) =>
  surfaceRow({
    contract_name: "GReputation", proxy_address: UBI, era_index: era,
    event_name: "StateHashProof", event_signature: SIG, topic0: TOPIC0,
    indexed_positions: indexed, param_types: "string address uint256",
    param_names: "blockchain user balance",
  });

const twoLayoutSurface = () =>
  parseEventSurface(writeSurface([stateHashProofRow("1", ""), stateHashProofRow("2", "1")]));

/** A real era-2 log: the address is lifted into topic1 and is absent from the data. */
const ERA_2_LOG = {
  topics: [TOPIC0, pad(USER as `0x${string}`, { size: 32 })] as [`0x${string}`, `0x${string}`],
  data: encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["celo", BALANCE]),
};

/** A real era-1 log: everything sits in the data and there is one topic. */
const ERA_1_LOG = {
  topics: [TOPIC0] as [`0x${string}`],
  data: encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "uint256" }],
    ["celo", USER as `0x${string}`, BALANCE],
  ),
};

describe("a union ABI is built newest-implementation-first", () => {
  it("orders by descending era, and the order survives deduplication", () => {
    const union = buildUnionAbi(twoLayoutSurface().rows);
    expect(union.eraOrder).toEqual([2, 1]);
    expect(isNewestFirst(union)).toBe(true);
  });

  /*
   * THE DISCRIMINATOR, and it is the reason the ordering rule exists.
   *
   * Every value below was MEASURED against viem, not predicted. Reverse the order in
   * `buildUnionAbi` and the first assertion fails; the rest of this test is what that failure
   * would have cost, spelled out, so nobody reads the ordering rule as a tidiness preference.
   */
  it("decodes an era-2 log correctly, where the reversed order decodes it SILENTLY WRONG", () => {
    const union = buildUnionAbi(twoLayoutSurface().rows);

    const right = decodeEventLog({ abi: union.abi, data: ERA_2_LOG.data, topics: ERA_2_LOG.topics });
    const rightArgs = right.args as unknown as { user: string; balance: bigint };
    expect(rightArgs.balance).toBe(BALANCE);
    expect(rightArgs.user.toLowerCase()).toBe(USER);

    // The SAME log, the SAME decoder, the ONLY difference being the array order.
    const reversed = [...union.abi].reverse();
    const wrong = decodeEventLog({ abi: reversed, data: ERA_2_LOG.data, topics: ERA_2_LOG.topics });
    const wrongArgs = wrong.args as unknown as { user: string; balance: bigint };

    // It does not throw. It returns 4 -- the BYTE LENGTH of the string "celo", read as a uint256
    // because the reader is one word out of step with the writer. Nothing downstream can tell
    // this apart from a real balance of 4.
    expect(wrongArgs.balance).toBe(4n);
    expect(wrongArgs.user.toLowerCase()).toBe("0x000000000000000000000000112210f47de98115");
    expect(wrongArgs.balance).not.toBe(BALANCE);
  });

  it("throws on an old ambiguous log rather than guessing, which is the trade being made", () => {
    const union = buildUnionAbi(twoLayoutSurface().rows);
    // Newest-first is correct for recent data and LOUD on old ambiguous data. A throw is
    // recoverable; a plausible wrong number is not. That asymmetry is the whole argument.
    expect(() => decodeEventLog({ abi: union.abi, data: ERA_1_LOG.data, topics: ERA_1_LOG.topics }))
      .toThrow(/indexed event parameter/);
  });

  it("keeps both layouts through the merge, because indexed flags are part of an entry's identity", () => {
    const rows = twoLayoutSurface().rows;
    expect(abiItemIdentity(rows[0])).not.toBe(abiItemIdentity(rows[1]));
    expect(buildUnionAbi(rows).entries).toHaveLength(2);
  });

  it("collapses a genuinely identical entry to its newest occurrence", () => {
    const surface = parseEventSurface(writeSurface([stateHashProofRow("1", "1"), stateHashProofRow("2", "1")]));
    const union = buildUnionAbi(surface.rows);
    expect(union.entries).toHaveLength(1);
    expect(union.eraOrder).toEqual([2]);
  });

  it("refuses to build a union spanning two contracts", () => {
    const surface = parseEventSurface(writeSurface([
      stateHashProofRow("1", ""),
      surfaceRow({ proxy_address: "0x3333333333333333333333333333333333333333", era_index: "1" }),
    ]));
    expect(() => buildUnionAbi(surface.rows)).toThrow(/more than one contract/);
  });

  it("every union built from the shipped seed is newest-first", () => {
    const surface = inspectControlPlane().plane!.eventSurface;
    const unions = [...buildAllUnionAbis(surface).values()];
    expect(unions.length).toBeGreaterThan(0);
    expect(unions.filter((u) => !isNewestFirst(u))).toEqual([]);
  });
});

describe("the ambiguous set is computed from the seed, with no chain call", () => {
  it("finds a key carrying two physical layouts", () => {
    const keys = computeAmbiguousKeys(twoLayoutSurface());
    expect(keys).toHaveLength(1);
    expect(keys[0].signature).toBe(SIG);
    expect(keys[0].layouts.map((l) => l.indexedPositions)).toEqual(["1", "<none>"]);
    expect(keys[0].layouts.find((l) => l.indexedPositions === "1")!.eras).toEqual([2]);
  });

  it("does not flag a key whose layout is stable across its eras", () => {
    const stable = parseEventSurface(writeSurface([stateHashProofRow("1", "1"), stateHashProofRow("2", "1")]));
    expect(computeAmbiguousKeys(stable)).toEqual([]);
  });

  it("does not flag two DIFFERENT addresses sharing one topic0", () => {
    // A global topic0 collision across addresses is not the ambiguous set: each address gets its
    // own union, so neither decoder ever sees the other's entry. Conflating the two would report
    // five keys where the real number is two.
    const shared = parseEventSurface(writeSurface([
      stateHashProofRow("1", ""),
      surfaceRow({
        contract_name: "GReputation", proxy_address: "0x3333333333333333333333333333333333333333",
        era_index: "1", event_name: "StateHashProof", event_signature: SIG, topic0: TOPIC0,
        indexed_positions: "1", param_types: "string address uint256", param_names: "blockchain user balance",
      }),
    ]));
    expect(computeAmbiguousKeys(shared)).toEqual([]);
  });

  it("ignores anonymous rows, which carry no selector to be ambiguous about", () => {
    const anon = parseEventSurface(writeSurface([
      surfaceRow({ event_name: "LogNote", event_signature: "LogNote(uint256)", topic0: "", anonymous: "true", indexed_positions: "", param_types: "uint256", param_names: "x", era_index: "1" }),
      surfaceRow({ event_name: "LogNote", event_signature: "LogNote(uint256)", topic0: "", anonymous: "true", indexed_positions: "0", param_types: "uint256", param_names: "x", era_index: "2" }),
    ]));
    expect(computeAmbiguousKeys(anon)).toEqual([]);
  });
});

describe("an undeclared ambiguity fails the build", () => {
  it("throws, naming the key and both layouts", () => {
    let thrown: unknown;
    try {
      assertNoUnhandledDecodeAmbiguity(twoLayoutSurface());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnhandledDecodeAmbiguityError);
    const message = (thrown as Error).message;
    expect(message).toContain("DECODE_AMBIGUITY_UNHANDLED");
    expect(message).toContain(SIG);
    expect(message).toContain("indexed[1]");
    expect(message).toContain("indexed[<none>]");
  });

  it("does not throw on a key that has been declared with its disposition", () => {
    // The shipped seed carries exactly the two declared keys, so the assertion passes on it and
    // would stop passing the moment a third appeared.
    const surface = inspectControlPlane().plane!.eventSurface;
    const found = assertNoUnhandledDecodeAmbiguity(surface);
    expect(found).toHaveLength(2);
    expect(found.every((k) => k.signature === SIG)).toBe(true);
    expect(found.map((k) => k.chain).sort()).toEqual(["ETHEREUM", "FUSE"]);
  });

  it("declares a disposition for every known ambiguity rather than only listing it", () => {
    expect(KNOWN_DECODE_AMBIGUITIES.length).toBeGreaterThan(0);
    for (const k of KNOWN_DECODE_AMBIGUITIES) {
      expect(k.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(k.disposition.length).toBeGreaterThan(40);
    }
  });

  it("makes the control plane invalid, so the running system refuses too", () => {
    // Not only the build: a seed carrying an undeclared ambiguity fails inspection, which is what
    // stops the assertion being a thing that is true only when somebody runs a script.
    const inspection = inspectControlPlane({ eventSurface: writeSurface([stateHashProofRow("1", ""), stateHashProofRow("2", "1")]) });
    expect(inspection.decodeViolations.map((v) => v.check)).toEqual(["decode_ambiguity_declared"]);
    expect(inspection.ok).toBe(false);
  });

  it("the shipped seed produces no decode violation", () => {
    expect(inspectControlPlane().decodeViolations).toEqual([]);
  });
});

describe("the build check is a command that exits non-zero", () => {
  it("is clean on the shipped seeds", () => {
    const result = runBuildCheck();
    expect(result.ok).toBe(true);
    expect(result.ambiguousKeyCount).toBe(2);
    expect(result.unionsOutOfOrder).toBe(0);
  });

  it("fails on a fixture that introduces a third ambiguity", () => {
    expect(() => runBuildCheck({ eventSurface: writeSurface([stateHashProofRow("1", ""), stateHashProofRow("2", "1")]) }))
      .toThrow(UnhandledDecodeAmbiguityError);
  });

  it("refuses an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--not-a-flag", "x"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--registry"])).toThrow(/needs a value/);
  });
});

describe("decode coverage is counted, not assumed", () => {
  const surface = () => parseEventSurface(writeSurface([surfaceRow({ era_index: "1" })]));

  it("counts a log whose topic0 matches no surface entry, per contract", () => {
    const s = surface();
    const known = s.rows[0].topic0!;
    const report = countUndecodableLogs([
      { chainId: 50, address: UBI, topic0: known },
      { chainId: 50, address: UBI, topic0: "0x" + "ff".repeat(32) },
      { chainId: 50, address: UBI, topic0: "0x" + "ff".repeat(32) },
    ], s);

    expect(report.byContract).toHaveLength(1);
    expect(report.byContract[0].rowsConsidered).toBe(3);
    expect(report.byContract[0].rowsDecodable).toBe(1);
    expect(report.byContract[0].rowsUndecodable).toBe(2);
    // The distinct unmatched selector, so the answer names what to go and find an ABI for rather
    // than only how many rows were lost.
    expect(report.byContract[0].unmatchedTopic0s).toEqual(["0x" + "ff".repeat(32)]);
  });

  it("reports an address with no surface at all as its own state", () => {
    const report = countUndecodableLogs([{ chainId: 50, address: "0x9999999999999999999999999999999999999999", topic0: "0x" + "aa".repeat(32) }], surface());
    expect(report.byContract[0].addressHasNoSurface).toBe(true);
    expect(report.byContract[0].rowsUndecodable).toBe(1);
  });

  it("counts an unreadable row as an ERROR, never as an undecodable one", () => {
    // An absence is a measurement only when its error count is zero. A row with no topic0 is
    // unreadable, which is a different fact from "this event is unknown", and folding the two
    // together would make a broken reader look like a missing ABI.
    const report = countUndecodableLogs([
      { chainId: 50, address: UBI, topic0: null },
      { chainId: 50, address: UBI, topic0: "0x" + "ff".repeat(32) },
    ], surface());
    expect(report.errors).toBe(1);
    expect(report.rowsUndecodable).toBe(1);
    expect(report.rowsConsidered).toBe(1);
    expect(report.errorDetail[0]).toMatch(/no topic0/);
  });

  it("is case-insensitive on the selector, so a checksum difference is not a missing ABI", () => {
    const s = surface();
    const report = countUndecodableLogs([{ chainId: 50, address: UBI.toUpperCase(), topic0: s.rows[0].topic0!.toUpperCase() }], s);
    expect(report.rowsUndecodable).toBe(0);
  });

  it("names the intervals nothing can decode, split by whether an ABI is held at all", () => {
    const plane = inspectControlPlane().plane!;
    const intervals = intervalsWithNoDecodableSurface(plane.registry.rows, plane.eventSurface);
    const inScope = intervals.filter((i) => ["CELO", "XDC", "ETHEREUM"].includes(i.chain));
    // MEASURED 2026-09-28 against the shipped seeds.
    expect(inScope).toHaveLength(24);
    expect(inScope.filter((i) => i.reason === "no_abi_held")).toHaveLength(7);
    expect(inScope.filter((i) => i.reason === "no_surface_row")).toHaveLength(17);
  });

  it("returns nothing for a registry whose every interval has a surface row", () => {
    const s = surface();
    const registry = parseRegistry();
    const covered = registry.rows.filter((r) => r.chainId === 50 && r.proxyAddress === UBI && r.eraIndex === 1);
    expect(intervalsWithNoDecodableSurface(covered, s)).toEqual([]);
  });
});
