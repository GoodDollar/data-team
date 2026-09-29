/**
 * The event surface: topic0 proof, era binding, topic-slot arithmetic and hash-only parameters.
 *
 * WHY topic0 IS RECOMPUTED RATHER THAN TRUSTED. An indexed flag is NOT part of an event selector.
 * A wrong-indexed ABI returns the right row count, throws nothing, and writes values into the
 * wrong columns. So a stored topic0 that agrees with a stored signature proves nothing on its own;
 * what proves something is recomputing keccak256 over a signature REBUILT from the stored
 * parameter types, which binds the selector to the layout rather than to itself.
 *
 * WHY THE BINDING MATTERS. Two (chain, address, topic0) keys in the shipped seed change their
 * indexed layout across their own eras. A surface row that binds to the wrong era therefore
 * decodes real logs into the wrong fields, silently and forever.
 */

import { describe, it, expect } from "vitest";
import { rmSync } from "fs";
import { dirname } from "path";
import {
  parseEventSurface, validateEventSurface, topic0For, canonicalSignature, isHashOnlyWhenIndexed,
} from "../../src/control-plane/eventSurface.js";
import { parseRegistry } from "../../src/control-plane/contractRegistry.js";
import { loadChains } from "../../src/control-plane/chains.js";
import { SeedParseError } from "../../src/control-plane/csv.js";
import {
  surfaceRow, registryRow, registryEra2Row, validRegistryBody, writeRegistry, writeSurface,
  INT64_MAX,
} from "../helpers/seed-fixtures.js";

const chains = loadChains();

function withSeeds(surfaceBody: readonly string[], registryBody: readonly string[] = validRegistryBody()) {
  const rPath = writeRegistry(registryBody);
  const sPath = writeSurface(surfaceBody);
  try {
    const registry = parseRegistry(rPath);
    const surface = parseEventSurface(sPath);
    return { registry, surface, ...validateEventSurface(surface, registry, chains) };
  } finally {
    rmSync(dirname(rPath), { recursive: true, force: true });
    rmSync(dirname(sPath), { recursive: true, force: true });
  }
}

function parseSurfaceOnly(body: readonly string[]) {
  const path = writeSurface(body);
  try {
    return parseEventSurface(path);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
}

function checks(surfaceBody: readonly string[], registryBody?: readonly string[]): string[] {
  return withSeeds(surfaceBody, registryBody).violations.map((v) => v.check);
}

/** An event present in both eras of the fixture contract, so era_bound=false is truthful. */
function bothEras(over: Parameters<typeof surfaceRow>[0] = {}): string[] {
  return [surfaceRow({ era_index: "1", ...over }), surfaceRow({ era_index: "2", implementation_address: "0x2222222222222222222222222222222222222222", ...over })];
}

describe("the fixture itself is valid", () => {
  it("passes every surface rule with zero violations", () => {
    const r = withSeeds(bothEras());
    expect(r.violations).toEqual([]);
    expect(r.advisories).toEqual([]);
    expect(r.counts.topic0Checked).toBe(2);
    expect(r.counts.topic0Matched).toBe(2);
  });
});

describe("topic0 is proven, not trusted", () => {
  it("flags a stored topic0 that is not keccak256 of its signature", () => {
    const wrong = "0x" + "de".repeat(32);
    expect(checks(bothEras({ topic0: wrong }))).toContain("topic0_recompute");
  });

  it("flags a signature that does not rebuild from event_name and param_types", () => {
    // The dangerous shape: topic0 agrees with the stored signature, but the stored signature does
    // not describe the stored parameter list, so the decoder and the selector disagree.
    const sig = "UBIClaimed(address,uint128)";
    expect(checks(bothEras({ event_signature: sig, topic0: topic0For(sig) })))
      .toContain("signature_canonical");
  });

  it("counts rows checked separately from rows matched", () => {
    const r = withSeeds(bothEras());
    expect(r.counts.signatureChecked).toBe(2);
    expect(r.counts.signatureMatched).toBe(2);
  });

  it("recomputes a selector that is independently known", () => {
    // ERC20 Transfer. A fixed, externally checkable constant, so a broken keccak wiring in this
    // module cannot agree with itself and look correct.
    expect(topic0For("Transfer(address,address,uint256)"))
      .toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(canonicalSignature("Transfer", ["address", "address", "uint256"]))
      .toBe("Transfer(address,address,uint256)");
  });
});

describe("every row binds to exactly one deployment era", () => {
  it("flags a row whose era does not exist", () => {
    expect(checks([surfaceRow({ era_index: "9" })])).toContain("surface_binds_to_one_era");
  });

  it("flags a row whose contract is not in the registry", () => {
    expect(checks([surfaceRow({ proxy_address: "0x9999999999999999999999999999999999999999" })]))
      .toContain("surface_binds_to_one_era");
  });

  it("flags a row that binds to a no_code_deployed registry row", () => {
    const noCode = registryRow({
      implementation_address: "", implementation_name: "unknown", era_count: "0",
      valid_from_block: "", valid_to_block: "", is_live: "false", creation_block: "",
      creation_method: "not applicable, no code is deployed at this address",
      era_method: "no_code_deployed", era_evidence: "none", era_announcement_event: "none",
      abi_source: "none", runtime_code_hash: "",
    });
    expect(checks([surfaceRow({ era_index: "1" })], [noCode]))
      .toContain("surface_binds_to_deployed_era");
  });

  it("flags a chain_id that disagrees with its chain name", () => {
    expect(checks(bothEras({ chain_id: "42220" }))).toContain("chain_id_consistency");
  });

  it("flags an implementation_address that disagrees with the bound era", () => {
    expect(checks([surfaceRow({ implementation_address: "0x3333333333333333333333333333333333333333" })]))
      .toContain("implementation_agreement");
  });
});

describe("topic slots are physical, so the arithmetic is enforced", () => {
  it("flags a non-anonymous event with four indexed parameters", () => {
    const sig = "Wide(address,address,address,address)";
    expect(checks(bothEras({
      event_name: "Wide", event_signature: sig, topic0: topic0For(sig),
      indexed_positions: "0 1 2 3", param_types: "address address address address",
      param_names: "a b c d",
    }))).toContain("indexed_slot_limit");
  });

  it("reports an anonymous four-slot event as an advisory, not a blocking violation", () => {
    // The seed is right and the RawLogs grain is narrower than the chain. Refusing to start the
    // pipeline over a correct row would be the wrong failure.
    const r = withSeeds(bothEras({
      event_name: "LogNote", event_signature: "LogNote(bytes4,address,bytes32,bytes32,bytes)",
      topic0: "", anonymous: "true", indexed_positions: "0 1 2 3",
      param_types: "bytes4 address bytes32 bytes32 bytes", param_names: "sig usr arg1 arg2 data",
    }));
    expect(r.violations).toEqual([]);
    expect(r.advisories.map((a) => a.check)).toContain("anonymous_not_capturable_in_rawlogs");
    expect(r.counts.anonymousRows).toBe(2);
  });

  it("refuses an anonymous event that still carries a topic0", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ anonymous: "true" })]))
      .toThrow(/anonymous event .* must leave topic0 empty/);
  });

  it("refuses an indexed position outside the declared parameters", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ indexed_positions: "5" })]))
      .toThrow(/outside the 2 declared parameter/);
  });

  it("refuses duplicate or unordered indexed positions", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ indexed_positions: "0 0" })])).toThrow(/duplicate/);
    expect(() => parseSurfaceOnly([surfaceRow({ indexed_positions: "1 0" })])).toThrow(/ascending/);
  });

  it("refuses a param_names list that does not match the parameter count", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ param_names: "claimer" })]))
      .toThrow(/2 param_types but 1 param_names/);
  });
});

describe("an unnamed ABI parameter is representable and unambiguous", () => {
  it("accepts a trailing empty name and identifies which parameter is unnamed", () => {
    // Uniswap V2: PairCreated(address indexed token0, address indexed token1, address pair, uint).
    // The fourth parameter genuinely has no name in the verified source, so the seed is faithful
    // and the parser must not trim the field into a shorter list.
    const sig = "PairCreated(address,address,address,uint256)";
    const parsed = parseSurfaceOnly([surfaceRow({
      event_name: "PairCreated", event_signature: sig, topic0: topic0For(sig),
      indexed_positions: "0 1", param_types: "address address address uint256",
      param_names: "token0 token1 pair ",
    })]);
    expect(parsed.rows[0].paramNames).toEqual(["token0", "token1", "pair", ""]);
    expect(parsed.rows[0].paramTypes).toHaveLength(4);
  });

  it("still refuses a blank element in param_types or indexed_positions", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ param_types: "address " })])).toThrow(/blank/);
    expect(() => parseSurfaceOnly([surfaceRow({ indexed_positions: "0 " })])).toThrow(/blank/);
  });

  it("refuses a parameter name that is not a Solidity identifier", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ param_names: "claimer 1amount" })]))
      .toThrow(/not a Solidity identifier/);
  });
});

describe("indexed dynamic parameters are labelled hash-only", () => {
  it("classifies every non-value type as hash-only when indexed", () => {
    for (const t of ["string", "bytes", "address[]", "uint256[3]", "(address,uint256)", "tuple"]) {
      expect(isHashOnlyWhenIndexed(t), t).toBe(true);
    }
    for (const t of ["address", "uint256", "bytes32", "bool", "int8", "bytes4"]) {
      expect(isHashOnlyWhenIndexed(t), t).toBe(false);
    }
  });

  it("records the exact positions whose value can never be recovered from a log", () => {
    const sig = "AdminsAdded(address[])";
    const parsed = parseSurfaceOnly([surfaceRow({
      event_name: "AdminsAdded", event_signature: sig, topic0: topic0For(sig),
      indexed_positions: "0", param_types: "address[]", param_names: "admins",
    })]);
    expect(parsed.rows[0].hashOnlyIndexedPositions).toEqual([0]);
  });

  it("does not label a dynamic parameter that is NOT indexed", () => {
    // Only an indexed dynamic parameter is replaced by its hash. A non-indexed one is in the data
    // payload and is fully recoverable.
    const sig = "TransferComment(string)";
    const parsed = parseSurfaceOnly([surfaceRow({
      event_name: "TransferComment", event_signature: sig, topic0: topic0For(sig),
      indexed_positions: "", param_types: "string", param_names: "comment",
    })]);
    expect(parsed.rows[0].hashOnlyIndexedPositions).toEqual([]);
  });
});

describe("the era-bound window uses the identical sentinel contract", () => {
  const boundOver = {
    era_bound: "true", era_bound_from_block: "105000000", era_bound_to_block: INT64_MAX,
  };

  it("accepts a window that is the exact envelope of the eras carrying the event", () => {
    const r = withSeeds(bothEras(boundOver));
    expect(r.violations).toEqual([]);
    expect(r.counts.boundGroupsChecked).toBe(1);
    expect(r.counts.boundGroupsMatchingEnvelope).toBe(1);
  });

  it("keeps the sentinel as a lexeme, never a number", () => {
    const parsed = parseSurfaceOnly([surfaceRow(boundOver)]);
    expect(parsed.rows[0].eraBoundTo!.kind).toBe("open_ended");
    expect(parsed.rows[0].eraBoundTo!.lexeme).toBe(INT64_MAX);
  });

  it("flags a window narrower than the eras it is declared on", () => {
    expect(checks(bothEras({ ...boundOver, era_bound_from_block: "105500000" })))
      .toContain("surface_era_within_window");
  });

  it("flags a window that is not the exact envelope", () => {
    expect(checks(bothEras({ ...boundOver, era_bound_from_block: "104000000" })))
      .toContain("era_bound_window_is_exact_envelope");
  });

  it("flags a finite window closing before a still-live era", () => {
    expect(checks(bothEras({ ...boundOver, era_bound_to_block: "106000000" })))
      .toContain("surface_live_era_needs_open_window");
  });

  it("flags rows of one event disagreeing about its window", () => {
    expect(checks([
      surfaceRow({ era_index: "1", ...boundOver }),
      surfaceRow({ era_index: "2", implementation_address: "0x2222222222222222222222222222222222222222", ...boundOver, era_bound_from_block: "105000001" }),
    ])).toContain("era_bound_window_agreement");
  });

  it("flags rows of one event disagreeing about whether it is era bound at all", () => {
    expect(checks([
      surfaceRow({ era_index: "1", ...boundOver }),
      surfaceRow({ era_index: "2", implementation_address: "0x2222222222222222222222222222222222222222" }),
    ])).toContain("era_bound_flag_agreement");
  });

  it("refuses bound blocks on a row that declares era_bound=false", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ era_bound_from_block: "105000000" })]))
      .toThrow(/era_bound=false but/);
  });

  it("refuses the sentinel with no era_bound declaration", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ era_bound: "true", era_bound_from_block: INT64_MAX, era_bound_to_block: INT64_MAX })]))
      .toThrow(SeedParseError);
  });
});

describe("era_bound=false is a claim about every era, and is checked", () => {
  it("flags an unbound event that is absent from one of its contract's eras", () => {
    expect(checks([surfaceRow({ era_index: "1" })]))
      .toContain("unbound_event_covers_all_eras");
  });

  it("accepts an unbound event present in every era", () => {
    expect(checks(bothEras())).toEqual([]);
  });

  it("accepts a single-era contract with a single unbound row", () => {
    const single = [registryRow({ era_count: "1", valid_to_block: INT64_MAX, is_live: "true" })];
    expect(checks([surfaceRow({ era_index: "1" })], single)).toEqual([]);
  });
});

describe("the whole surface is rejected on the first malformed physical row", () => {
  it("refuses an extra field rather than dropping the row", () => {
    expect(() => parseSurfaceOnly([surfaceRow(), surfaceRow() + ",surplus"])).toThrow(SeedParseError);
  });

  it("refuses a mixed-case proxy address", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ proxy_address: "0x22867567E2D80F2049200E25C6F31CB6EC2F0FAF" })]))
      .toThrow(/uppercase hex/);
  });

  it("refuses a topic0 that is not 32 lowercase hex bytes", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ topic0: "0xABC" })])).toThrow(/lowercase 32-byte/);
  });

  it("refuses an event_name that is not a Solidity identifier", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ event_name: "UBI Claimed" })]))
      .toThrow(/not a Solidity identifier/);
  });

  it("refuses era_index zero", () => {
    expect(() => parseSurfaceOnly([surfaceRow({ era_index: "0" })])).toThrow(/below the minimum permitted value 1/);
  });
});

describe("registry era 2 fixture stays consistent", () => {
  it("binds a row to era 2 when the implementation matches", () => {
    const r = withSeeds(bothEras());
    expect(r.counts.bindingChecked).toBe(2);
    expect(r.counts.bindingMatched).toBe(2);
    expect(registryEra2Row()).toContain(INT64_MAX);
  });
});
