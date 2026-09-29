/**
 * The strict registry parser and schema.
 *
 * WHAT THESE REPLACE. The previous loader ended its parse with
 * `.filter(r => r.length === header.length)` and read control fields through `Number()`. So a row
 * with one stray comma VANISHED from the contract universe with no error, and a blank `era_index`
 * became era 0. Both were silent, and silence is what makes them expensive: nothing downstream can
 * tell "this contract produced no logs" from "this contract was never asked about", and
 * `lookupEra` cannot fail, so era 0 is a confident wrong decode rather than an error.
 *
 * Each case mutates exactly ONE field of an otherwise valid 23-column row, so a pass proves the
 * named rule rather than proving that something somewhere was wrong.
 */

import { describe, it, expect } from "vitest";
import { rmSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { parseRegistry, validateRegistry, assertScopeFrozen, NO_CODE_ERA_METHOD } from "../../src/control-plane/contractRegistry.js";
import { loadChains } from "../../src/control-plane/chains.js";
import { SeedParseError } from "../../src/control-plane/csv.js";
import {
  registryRow, registryEra2Row, validRegistryBody, writeRegistry, writeSeed,
  registryRowWithBoundary, writeRegistryWithBoundary,
  REGISTRY_COLUMNS, UBI, INT64_MAX,
} from "../helpers/seed-fixtures.js";

const chains = loadChains();

function parse(body: readonly string[], opts?: Parameters<typeof writeRegistry>[1]) {
  const path = writeRegistry(body, opts);
  try {
    return parseRegistry(path);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
}

function violations(body: readonly string[]): string[] {
  return validateRegistry(parse(body), chains).map((v) => v.check);
}

describe("the fixture itself is valid", () => {
  it("parses two eras with zero violations", () => {
    const parsed = parse(validRegistryBody());
    expect(parsed.rows).toHaveLength(2);
    expect(validateRegistry(parsed, chains)).toEqual([]);
  });
});

describe("a malformed physical row rejects the WHOLE registry", () => {
  it("refuses a row with a missing field instead of dropping it", () => {
    const short = registryRow().split(",").slice(0, 21).join(",");
    expect(() => parse([registryRow(), short])).toThrow(SeedParseError);
  });

  it("refuses a row with an extra field instead of dropping it", () => {
    expect(() => parse([registryRow(), registryRow() + ",surplus"])).toThrow(SeedParseError);
  });

  it("names the physical line of the offending row", () => {
    // Line 3 = header + one good row + the bad one. Without this a maintainer is told the file is
    // bad and left to find the byte.
    expect(() => parse([registryRow(), registryRow() + ",surplus"])).toThrow(/line 3/);
  });

  it("keeps every good row rather than returning a smaller universe", () => {
    // The defect being guarded: 2 physical rows in, 1 contract out, no error.
    let rows = -1;
    try {
      rows = parse([registryRow(), registryRow().split(",").slice(0, 21).join(",")]).rows.length;
    } catch {
      rows = -1;
    }
    expect(rows).toBe(-1);
  });

  it("refuses an unterminated quote", () => {
    // Written raw: the fixture builder escapes quotes correctly, which is the opposite of what
    // this case needs.
    const bad = registryRow().replace(/,fixture,$/, ',"fixture,');
    expect(() => parse([bad])).toThrow(SeedParseError);
  });

  it("refuses a header with the right width but a wrong column name", () => {
    const wrong: string[] = [...REGISTRY_COLUMNS];
    wrong[13] = "created_block";
    const path = writeSeed("contract_deployments.csv", REGISTRY_COLUMNS, [registryRow()], {
      header: wrong.join(","),
    }).path;
    try {
      expect(() => parseRegistry(path)).toThrow(/header mismatch/);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("refuses a header that is narrower than the schema", () => {
    const path = writeSeed("contract_deployments.csv", REGISTRY_COLUMNS, [registryRow()], {
      header: REGISTRY_COLUMNS.slice(0, 22).join(","),
    }).path;
    try {
      expect(() => parseRegistry(path)).toThrow(SeedParseError);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("refuses a reordered header even though every column is present", () => {
    const reordered = [REGISTRY_COLUMNS[1], REGISTRY_COLUMNS[0], ...REGISTRY_COLUMNS.slice(2)];
    const path = writeSeed("contract_deployments.csv", REGISTRY_COLUMNS, [registryRow()], {
      header: reordered.join(","),
    }).path;
    try {
      expect(() => parseRegistry(path)).toThrow(/header mismatch/);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});

describe("physical row count is reconciled against parsed record count", () => {
  it("refuses a field containing an embedded line terminator", () => {
    // Legal RFC 4180, illegal in a control seed: it would make one record span two physical lines,
    // and the row-count reconciliation is what proves nothing was dropped.
    expect(() => parse([registryRow({ notes: "line one\r\nline two" })]))
      .toThrow(/physical\/parsed row count disagreement|embedded line terminator/);
  });

  it("refuses mixed line terminators", () => {
    const path = writeRegistry(validRegistryBody(), { terminator: "\n" });
    // Rewrite one terminator as CRLF to produce a genuinely mixed file.
    writeFileSync(path, readFileSync(path, "utf8").replace("\n", "\r\n"), "ascii");
    try {
      expect(() => parseRegistry(path)).toThrow(/mixed line terminators/);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("refuses a missing final terminator", () => {
    expect(() => parse([registryRow()], { trailingTerminator: false })).toThrow(/does not end with a line terminator/);
  });

  it("refuses a byte-order mark", () => {
    const path = writeRegistry([registryRow()]);
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(path)]));
    try {
      expect(() => parseRegistry(path)).toThrow(/byte-order mark/);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("refuses a non-ASCII byte, which is how an editor corrupts a seed", () => {
    expect(() => parse([registryRow({ notes: "re\u2011enabled" })])).toThrow(/non-printable or non-ASCII/);
  });
});

describe("field-level schema", () => {
  it("refuses a blank era_index rather than reading it as era 0", () => {
    expect(() => parse([registryRow({ era_index: "" })])).toThrow(/era_index/);
  });

  it("refuses era_index zero", () => {
    expect(() => parse([registryRow({ era_index: "0" })])).toThrow(/below the minimum permitted value 1/);
  });

  it("refuses a mixed-case address", () => {
    const checksummed = "0x22867567E2D80F2049200E25C6F31CB6EC2F0FAF";
    expect(() => parse([registryRow({ proxy_address: checksummed })])).toThrow(/uppercase hex/);
  });

  it("refuses an address of the wrong length", () => {
    expect(() => parse([registryRow({ proxy_address: "0x2286" })])).toThrow(/lowercase 20-byte/);
  });

  it("refuses is_live spelled any way but exactly true or false", () => {
    for (const bad of ["TRUE", "True", "1", "yes", ""]) {
      expect(() => parse([registryRow({ is_live: bad })]), bad).toThrow(/is not exactly 'true' or 'false'/);
    }
  });

  it("refuses a runtime_code_hash that is not 32 lowercase hex bytes", () => {
    expect(() => parse([registryRow({ runtime_code_hash: "0xabc" })])).toThrow(/lowercase 32-byte/);
  });

  it("refuses the open-ended sentinel in valid_from_block", () => {
    expect(() => parse([registryRow({ valid_from_block: INT64_MAX })])).toThrow(/open-ended upper bound/);
  });

  it("refuses the sentinel on a row that is not is_live", () => {
    expect(() => parse([registryRow({ valid_to_block: INT64_MAX, is_live: "false" })]))
      .toThrow(/not declared current\/open-ended/);
  });

  it("refuses a finite upper bound on an is_live row", () => {
    expect(() => parse([registryRow({ is_live: "true", valid_to_block: "106000000" })]))
      .toThrow(/declared current\/open-ended but carries a finite upper bound/);
  });

  it("keeps the sentinel as a lexeme and never as a number", () => {
    const parsed = parse(validRegistryBody());
    const live = parsed.rows.find((r) => r.isLive)!;
    expect(live.validTo!.kind).toBe("open_ended");
    expect(live.validTo!.lexeme).toBe(INT64_MAX);
    expect(live.raw[11]).toBe(INT64_MAX);
  });
});

describe("the no_code_deployed exception shape is enforced, not just tolerated", () => {
  const noCode = {
    implementation_address: "", implementation_name: "unknown", era_index: "1", era_count: "0",
    valid_from_block: "", valid_to_block: "", is_live: "false", creation_block: "",
    creation_method: "not applicable, no code is deployed at this address",
    era_method: NO_CODE_ERA_METHOD, era_evidence: "none", era_announcement_event: "none",
    abi_source: "none", runtime_code_hash: "",
  };

  it("accepts the exact declared shape", () => {
    const parsed = parse([registryRow(noCode)]);
    expect(parsed.rows[0].noCodeDeployed).toBe(true);
    expect(parsed.rows[0].creationBlock).toBeNull();
    expect(validateRegistry(parsed, chains)).toEqual([]);
  });

  it("refuses a no_code row that also carries blocks", () => {
    expect(() => parse([registryRow({ ...noCode, creation_block: "105000000" })]))
      .toThrow(/must leave valid_from_block, valid_to_block and creation_block empty/);
  });

  it("refuses a no_code row claiming to be live", () => {
    expect(() => parse([registryRow({ ...noCode, is_live: "true" })])).toThrow(/cannot be is_live=true/);
  });

  it("refuses a deployed row that leaves its blocks empty", () => {
    // Without this, "no blocks" becomes a hiding place for a row that simply failed to resolve.
    expect(() => parse([registryRow({ valid_from_block: "" })])).toThrow(/valid_from_block/);
  });
});

describe("cross-row interval rules", () => {
  it("accepts eras that touch exactly", () => {
    expect(violations(validRegistryBody())).toEqual([]);
  });

  it("flags overlapping eras", () => {
    expect(violations([registryRow({ valid_to_block: "106000001" }), registryEra2Row()]))
      .toContain("era_overlap");
  });

  it("flags an undeclared gap between eras", () => {
    expect(violations([registryRow({ valid_to_block: "105999999" }), registryEra2Row()]))
      .toContain("era_gap");
  });

  it("flags non-contiguous era indexes", () => {
    expect(violations([registryRow(), registryEra2Row({ era_index: "3" })]))
      .toContain("era_index_contiguous");
  });

  it("flags era_count that disagrees with the number of rows", () => {
    expect(violations([registryRow({ era_count: "3" }), registryEra2Row({ era_count: "3" })]))
      .toContain("era_count_matches_rows");
  });

  it("flags creation_block after the first era", () => {
    expect(violations([registryRow({ creation_block: "105000001" }), registryEra2Row()]))
      .toContain("creation_before_first_era");
  });

  it("flags more than one live era on one contract", () => {
    expect(violations([
      registryRow({ is_live: "true", valid_to_block: INT64_MAX }),
      registryEra2Row(),
    ])).toContain("single_live_era");
  });

  it("flags a chain_id that disagrees with its chain name", () => {
    expect(violations([registryRow({ chain_id: "42220" }), registryEra2Row({ chain_id: "42220" })]))
      .toContain("chain_id_consistency");
  });

  it("flags a chain that is not in the chains seed at all", () => {
    expect(violations([registryRow({ chain: "BASE", chain_id: "8453" }), registryEra2Row({ chain: "BASE", chain_id: "8453" })]))
      .toContain("chain_known");
  });

  it("flags an era whose block order disagrees with its index", () => {
    expect(violations([
      registryRow({ era_index: "2" }),
      registryEra2Row({ era_index: "1" }),
    ])).toContain("era_order_matches_blocks");
  });
});

describe("what the loader exposes downstream", () => {
  it("defaults every era to raw_only_unproven while the boundary columns are absent", () => {
    const parsed = parse(validRegistryBody());
    expect(parsed.hasBoundaryColumns).toBe(false);
    expect(parsed.rows.every((r) => r.boundaryCompleteness === "raw_only_unproven")).toBe(true);
    expect(parsed.rows.every((r) => r.boundaryEvidenceManifestHash === null)).toBe(true);
  });

  it("preserves every original lexeme for byte-exact regeneration", () => {
    const body = validRegistryBody();
    const parsed = parse(body);
    expect(parsed.rows.map((r) => r.raw.join(","))).toEqual(body.map((b) => b.replace(/"/g, "")));
  });

  it("uses the contract key, so the same address on two chains is two contracts", () => {
    const parsed = parse([
      registryRow({ era_count: "1", valid_to_block: INT64_MAX, is_live: "true" }),
      registryRow({ chain: "CELO", chain_id: "42220", era_count: "1", valid_to_block: INT64_MAX, is_live: "true" }),
    ]);
    expect(validateRegistry(parsed, chains)).toEqual([]);
    expect(new Set(parsed.rows.map((r) => `${r.chainId}|${r.proxyAddress}`)).size).toBe(2);
    expect(parsed.rows[0].proxyAddress).toBe(UBI);
  });
});

/**
 * The declared trailing block Phase 2 task 16 appends. It does not exist in the shipped seed, so
 * these tests are what proves the contract is enforced the moment it does.
 */
describe("the boundary-evidence and release-scope block", () => {
  function parseWithBoundary(body: readonly string[]) {
    const path = writeRegistryWithBoundary(body);
    try {
      return parseRegistry(path);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  }

  it("accepts the wider header and reads the declared values", () => {
    const parsed = parseWithBoundary([
      registryRowWithBoundary(),
      registryRowWithBoundary({ era_index: "2", valid_from_block: "106000000", valid_to_block: INT64_MAX, is_live: "true" }),
    ]);
    expect(parsed.hasBoundaryColumns).toBe(true);
    expect(parsed.rows[0].releaseScope).toBe("in_release");
    expect(parsed.rows[0].boundaryCompleteness).toBe("raw_only_unproven");
  });

  it("reports release scope as undeclared when the column is absent, never as included", () => {
    const parsed = parse(validRegistryBody());
    expect(parsed.hasBoundaryColumns).toBe(false);
    expect(parsed.rows.every((r) => r.releaseScope === "undeclared")).toBe(true);
  });

  it("refuses a release_scope value outside the declared set", () => {
    expect(() => parseWithBoundary([registryRowWithBoundary({ release_scope: "maybe" })]))
      .toThrow(/is not one of: in_release, out_of_release, scope_pending/);
  });

  it("refuses 'undeclared' written into the column, which is a loader state and not a value", () => {
    expect(() => parseWithBoundary([registryRowWithBoundary({ release_scope: "undeclared" })]))
      .toThrow(/is not one of/);
  });

  it("refuses a completeness verdict with no reproducible evidence behind it", () => {
    expect(() => parseWithBoundary([registryRowWithBoundary({ boundary_completeness: "complete" })]))
      .toThrow(/requires boundary_evidence_manifest_hash, boundary_checked_through_block and frozen_safe_head/);
  });

  it("refuses evidence checked past the frozen safe head it cites", () => {
    expect(() => parseWithBoundary([registryRowWithBoundary({
      boundary_completeness: "plain_contract",
      boundary_evidence_manifest_hash: "0x" + "cd".repeat(32),
      boundary_checked_through_block: "106000001",
      frozen_safe_head: "106000000",
    })])).toThrow(/is above frozen_safe_head/);
  });

  it("accepts a complete verdict that carries all three pieces of evidence", () => {
    const parsed = parseWithBoundary([registryRowWithBoundary({
      boundary_completeness: "complete",
      boundary_evidence_manifest_hash: "0x" + "cd".repeat(32),
      boundary_checked_through_block: "106000000",
      frozen_safe_head: "106000000",
    })]);
    expect(parsed.rows[0].boundaryCompleteness).toBe("complete");
  });
});

describe("scope_pending blocks the freeze, and only the freeze", () => {
  function parseWithBoundary(body: readonly string[]) {
    const path = writeRegistryWithBoundary(body);
    try {
      return parseRegistry(path);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  }

  it("is a legal state before the freeze, so an undecided row is recorded rather than resolved", () => {
    const parsed = parseWithBoundary([registryRowWithBoundary({
      era_count: "1", valid_to_block: INT64_MAX, is_live: "true", release_scope: "scope_pending",
    })]);
    expect(validateRegistry(parsed, chains)).toEqual([]);
    expect(parsed.rows[0].releaseScope).toBe("scope_pending");
  });

  it("fails the freeze check, so A5 cannot include or silently exclude it", () => {
    const parsed = parseWithBoundary([registryRowWithBoundary({ release_scope: "scope_pending" })]);
    expect(assertScopeFrozen(parsed).map((x) => x.check)).toEqual(["no_scope_pending_when_frozen"]);
  });

  it("fails the freeze check when the column is absent entirely", () => {
    // The dangerous default: no column at all must not read as "everything is in".
    const parsed = parse(validRegistryBody());
    expect(assertScopeFrozen(parsed)).toHaveLength(2);
  });

  it("passes the freeze check once every row is decided either way", () => {
    const parsed = parseWithBoundary([
      registryRowWithBoundary({ release_scope: "in_release" }),
      registryRowWithBoundary({ era_index: "2", valid_from_block: "106000000", valid_to_block: INT64_MAX, is_live: "true", release_scope: "out_of_release" }),
    ]);
    expect(assertScopeFrozen(parsed)).toEqual([]);
  });
});
