/**
 * KNOWN FAILURE: the registry loses and invents control data without saying so.
 *
 *   H4  Registry loading silently drops or invents control data.
 *       Owner: Phase 2 (registry and inventory agent). Matrix: "Strict parser RED/GREEN suite".
 *
 * RECEIPTS THESE ENCODE, from `specs/system/readiness-audit-2026-09-25.md` section H4.
 *
 *   "A CSV with two physical data rows, one malformed, loaded one row and did not throw."
 *   "An empty `era_index` loaded as era 0 and did not throw."
 *
 * The source lines the audit names are still there: `pipeline-v5/src/registry.ts` discards any
 * row whose field count differs from the header, and uses JavaScript `Number` on control fields,
 * where `Number("")` is 0 rather than NaN.
 *
 * WHY THIS MATTERS MORE THAN A PARSE ERROR. A dropped contract row is a contract that is never
 * ingested, and nothing downstream can tell "this contract has no logs" from "this contract was
 * never asked about". A blank era becoming era 0 is worse: `era_index` decides which ABI decodes
 * a log, two addresses in this registry genuinely change their indexed layout across their own
 * eras, and an era map lookup that always succeeds turns a missing era into a confident wrong
 * answer. Both are silent.
 *
 * No adapter is replaced here. `loadRegistry` reads a CSV from disk, so the fixture IS a CSV
 * written to a temporary directory, parsed by the real parser.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadRegistry } from "../../src/registry.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "registry-red-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const HEADER =
  "chain_id,proxy_address,contract_name,era_index,implementation_address," +
  "creation_block,valid_from_block,valid_to_block,is_live";

function seed(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `${HEADER}\n${body}\n`, "utf8");
  return path;
}

describe("H4: a malformed registry row disappears", () => {
  it("refuses a CSV whose physical row count does not match what it loaded", () => {
    // Two physical data rows. The second is missing its last two fields, which is what a
    // hand-edited seed or a truncated export looks like.
    const path = seed(
      "dropped-row.csv",
      [
        "50,0x22867567e2d80f2049200e25c6f31cb6ec2f0faf,UBIScheme,1,,105000000,105000000,,true",
        "50,0x6bd698566632bf2e81e2278f1656cb24aaf06d2e,Invites,1,,105000001",
      ].join("\n")
    );

    let threw: Error | null = null;
    let contracts = -1;
    try {
      const reg = loadRegistry(path);
      contracts = reg.contracts.length;
    } catch (e: any) {
      threw = e;
    }

    expect(
      threw,
      `H4 reproduced (dropped row): the CSV holds 2 physical data rows and loadRegistry() ` +
      `returned ${contracts} contract(s) without throwing. pipeline-v5/src/registry.ts parseCsv() ` +
      `filters out every row whose field count differs from the header, so a malformed row is ` +
      `removed from the contract universe and nothing records that it existed. A contract that ` +
      `is never asked about produces no logs and no error. Owner: Phase 2.`
    ).not.toBeNull();
  });
});

describe("H4: a blank era index becomes era zero", () => {
  it("refuses a row whose era_index is blank rather than reading it as 0", () => {
    const path = seed(
      "blank-era.csv",
      "50,0x22867567e2d80f2049200e25c6f31cb6ec2f0faf,UBIScheme,,,105000000,105000000,,true"
    );

    let threw: Error | null = null;
    let eraIndex: unknown = "not loaded";
    try {
      const reg = loadRegistry(path);
      eraIndex = reg.eras[0]?.eraIndex;
    } catch (e: any) {
      threw = e;
    }

    expect(
      threw,
      `H4 reproduced (blank era): era_index was empty and loaded as ${JSON.stringify(eraIndex)} ` +
      `without throwing. pipeline-v5/src/registry.ts uses Number(r.era_index), and Number("") is ` +
      `0, not NaN. Era 0 is not a real era in this registry: eras are 1-based, and era_index is ` +
      `what decides which ABI decodes a log. Two (chain, address) keys in the shipped seed change ` +
      `their indexed layout across their own eras, so a wrong era is a confident wrong decode ` +
      `rather than a missing one. Owner: Phase 2.`
    ).not.toBeNull();
  });

  it("refuses a row whose chain_id is not one of the four in release scope", () => {
    const path = seed(
      "bad-chain.csv",
      "999999,0x22867567e2d80f2049200e25c6f31cb6ec2f0faf,UBIScheme,1,,105000000,105000000,,true"
    );

    let threw: Error | null = null;
    let chains: number[] = [];
    try {
      const reg = loadRegistry(path);
      chains = reg.contracts.map((c) => c.chainId);
    } catch (e: any) {
      threw = e;
    }

    expect(
      threw,
      `H4 reproduced (unsupported chain): chain_id 999999 loaded as ${JSON.stringify(chains)} ` +
      `without throwing. The release scope is Celo, XDC, Fuse and Ethereum, decided in plan ` +
      `Section 2 item 3, and nothing in the loader checks a chain id against it. A row for a ` +
      `chain with no reader is a contract that silently never ingests. Owner: Phase 2.`
    ).not.toBeNull();
  });
});
