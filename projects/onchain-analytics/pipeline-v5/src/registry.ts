/**
 * registry.ts -- the contract universe, read from the reference seed rather than hard coded.
 *
 * WHY A SEED AND NOT A LIST IN THIS FILE. The L0 v4 contract states the property this buys, in as
 * many words: adding the 147th contract requires no schema change, it requires a row in the
 * contract_deployments seed. A list of addresses in the pipeline would make that false, because
 * ingestion would then need a code change per contract, and the one thing this warehouse cannot
 * afford is a log going uncaptured because nobody had added a line for it yet. The previous
 * configuration hard coded two addresses and, as a direct consequence, had Celo commented out for
 * months without anything noticing.
 *
 * WHAT THE SEED SUPPLIES THAT NOTHING ELSE CAN. Two things, and the second is the one that is
 * easy to miss:
 *
 *   1. WHICH CONTRACTS EXIST, per chain, with each one's own creation block. R8: an absence claim
 *      states the range it covers and its lower bound is contract creation unless there is a
 *      stated reason otherwise. Taking a start block from anywhere else has already cost this
 *      project real data: a scan from a subgraph's declared start rather than the contract's
 *      creation missed 570 swaps.
 *
 *   2. THE ERA MAP. L0-4 requires every row to self-identify its era, because an identical getter
 *      or an identical event signature can mean different things across an upgrade. 179 eras
 *      announce with Upgraded(address), 66 with CodeUpdated(bytes32,address), and 115 announce
 *      NOTHING AT ALL, so a resolver that follows announcements cannot reach a third of them. The
 *      seed carries valid_from_block and valid_to_block per era, which is a block-range lookup and
 *      needs no chain read.
 *
 * THE FAILURE MODE OF AN ERA MAP, WRITTEN DOWN HERE BECAUSE IT IS THE DANGEROUS ONE. A lookup
 * that always returns something cannot fail, so a wrong or missing era yields a CONFIDENT WRONG
 * ANSWER rather than an error. `lookupEra` therefore returns null where no era covers the block,
 * and the caller writes era_resolution 'unresolved' with a NULL era_index, which is what the L0
 * contract asks for: a row that does not know its era says so, and 'unresolved' is not era 1.
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { log } from "./log.js";
import type { CaptureTarget, EraMapEntry, NetworkConfig } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The seed lives in the dbt project, which is the versioned home of every reference table in this
 * warehouse. Resolved relative to this file so it works from source and from a build, and checked
 * for existence so a moved seed fails loudly at startup rather than as an empty contract list.
 */
export const REGISTRY_PATH = resolve(join(HERE, "..", "..", "gd_dbt", "seeds", "contract_deployments.csv"));

/** Minimal RFC 4180 reader. Handles quoted fields and embedded commas, which the seed contains. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export interface Registry {
  /** One entry per contract era, in block order per contract. */
  eras: EraMapEntry[];
  /** One entry per distinct (chain_id, proxy_address). */
  contracts: { chainId: number; address: string; contractName: string; firstBlock: number; isLive: boolean }[];
  path: string;
  rowsRead: number;
}

let cached: Registry | null = null;

export function loadRegistry(path = REGISTRY_PATH): Registry {
  if (cached && cached.path === path) return cached;

  if (!existsSync(path)) {
    throw new Error(
      `REGISTRY_MISSING: ${path} does not exist. The contract universe is defined by that seed, ` +
      `so an ingestion run with no registry would silently cover nothing.`
    );
  }

  const rows = parseCsv(readFileSync(path, "utf8"));
  const eras: EraMapEntry[] = [];
  const byContract = new Map<string, { chainId: number; address: string; contractName: string; firstBlock: number; isLive: boolean }>();

  for (const r of rows) {
    const chainId = Number(r.chain_id);
    const address = String(r.proxy_address ?? "").toLowerCase();
    if (!Number.isFinite(chainId) || !address.startsWith("0x")) continue;

    const validFrom = Number(r.valid_from_block);
    const validTo = r.valid_to_block === "" || r.valid_to_block === undefined ? null : Number(r.valid_to_block);
    eras.push({
      chainId,
      proxyAddress: address,
      eraIndex: Number(r.era_index),
      implementationAddress: r.implementation_address ? String(r.implementation_address).toLowerCase() : null,
      validFromBlock: Number.isFinite(validFrom) ? validFrom : 0,
      validToBlock: validTo !== null && Number.isFinite(validTo) ? validTo : null,
    });

    const key = `${chainId}|${address}`;
    const creation = Number(r.creation_block);
    const existing = byContract.get(key);
    // The contract's own creation block, taken as the minimum across its eras so that a seed row
    // with a missing creation_block cannot raise the floor above a real one.
    const first = Number.isFinite(creation) ? creation : (Number.isFinite(validFrom) ? validFrom : 0);
    if (!existing) {
      byContract.set(key, {
        chainId, address, contractName: String(r.contract_name ?? "unknown"),
        firstBlock: first, isLive: String(r.is_live).toLowerCase() === "true",
      });
    } else {
      if (first > 0 && (existing.firstBlock === 0 || first < existing.firstBlock)) existing.firstBlock = first;
      if (String(r.is_live).toLowerCase() === "true") existing.isLive = true;
    }
  }

  eras.sort((a, b) =>
    a.chainId - b.chainId || a.proxyAddress.localeCompare(b.proxyAddress) || a.validFromBlock - b.validFromBlock);

  cached = { eras, contracts: [...byContract.values()], path, rowsRead: rows.length };
  log.info(
    `Registry loaded: ${cached.contracts.length} contracts, ${cached.eras.length} eras, from ${rows.length} seed rows`,
    { path }
  );
  return cached;
}

/**
 * Capture targets for one chain, in address order.
 *
 * EXCLUDES a contract whose creation block could not be resolved from the seed, which this
 * registry represents as firstBlock 0. Six seed rows carry an empty `creation_block`, all of them
 * addresses A1 established have no code on that chain, and `Number("")` is 0 rather than NaN, so
 * the fallback to `valid_from_block` never fires for them and 0 survives. Handing those to the
 * pipeline asks it to scan from genesis to head for an address that has never held code, on four
 * chains. Resuming from block 0 is not a conservative default here, it is a guess wearing one.
 *
 * Note the sentinel is only safe because no contract in this registry is genesis allocated. If one
 * ever is, firstBlock has to become nullable rather than overloading 0, and this comment is the
 * warning that the change is not local.
 *
 * It does NOT filter on isLive. A contract that was live and has since been retired still has
 * history worth ingesting, and dropping it would lose exactly the data L0 exists to hold.
 */
export function targetsFor(network: NetworkConfig, opts: { addresses?: string[] } = {}): CaptureTarget[] {
  const reg = loadRegistry();
  const wanted = opts.addresses ? new Set(opts.addresses.map((a) => a.toLowerCase())) : null;
  const onChain = reg.contracts.filter((c) => c.chainId === network.chainId);
  const unresolved = onChain.filter((c) => c.firstBlock === 0);
  if (unresolved.length > 0) {
    log.warn(
      `${network.name}: ${unresolved.length} contract(s) excluded, no creation block in the seed`,
      { contracts: unresolved.map((c) => `${c.contractName} ${c.address}`).join(", ") }
    );
  }
  return onChain
    .filter((c) => c.firstBlock > 0)
    .filter((c) => (wanted ? wanted.has(c.address) : true))
    .sort((a, b) => a.address.localeCompare(b.address))
    .map((c) => ({
      chainId: c.chainId,
      network,
      address: c.address,
      contractName: c.contractName,
      firstBlock: c.firstBlock,
    }));
}

/**
 * The era covering a block on a contract, or null.
 *
 * Null is a real answer and must stay reachable. An era map lookup that always succeeds turns a
 * missing era into a confident wrong answer, which is worse than an unresolved one because
 * nothing downstream can tell it apart from a correct one.
 */
export function lookupEra(chainId: number, address: string, blockNumber: number): EraMapEntry | null {
  const reg = loadRegistry();
  const a = address.toLowerCase();
  for (const e of reg.eras) {
    if (e.chainId !== chainId || e.proxyAddress !== a) continue;
    if (blockNumber < e.validFromBlock) continue;
    if (e.validToBlock !== null && blockNumber >= e.validToBlock) continue;
    return e;
  }
  return null;
}

/** An index keyed by contract, so a chunk of logs resolves without rescanning the whole seed. */
export function eraIndexFor(chainId: number, address: string): EraMapEntry[] {
  const reg = loadRegistry();
  const a = address.toLowerCase();
  return reg.eras.filter((e) => e.chainId === chainId && e.proxyAddress === a);
}

/** Resolve against a pre-filtered era list. Same null-is-an-answer rule as lookupEra. */
export function eraAt(eras: EraMapEntry[], blockNumber: number): EraMapEntry | null {
  for (const e of eras) {
    if (blockNumber < e.validFromBlock) continue;
    if (e.validToBlock !== null && blockNumber >= e.validToBlock) continue;
    return e;
  }
  return null;
}
