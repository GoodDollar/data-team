/**
 * registry.ts -- the pipeline's view of the contract universe and the era map.
 *
 * WHAT CHANGED AND WHY. This module used to own a hand-rolled CSV scanner. That scanner ended
 * with `.filter(r => r.length === header.length)`, so a row with one stray comma VANISHED: no
 * error, a smaller contract universe, and an ingestion run that silently covered less than it
 * claimed. It also read every numeric field through `Number()`, where `Number("")` is 0 rather
 * than NaN, so a blank `era_index` became era 0 -- and `era_index` is what decides which ABI
 * decodes a log. Both failures were silent, and silence is the expensive part: `lookupEra` cannot
 * fail, so a missing era yields a confident wrong decode rather than an error.
 *
 * Parsing, schema and cross-row validation now live in `./control-plane/`, which rejects the whole
 * seed on the first malformed physical row. This file keeps only what the PIPELINE needs from a
 * registry it has already been told is sound: capture targets and era lookup.
 *
 * WHY A SEED AND NOT A LIST IN THIS FILE. Adding the 147th contract must require a row in
 * `contract_deployments`, not a code change, because the one thing this warehouse cannot afford is
 * a log going uncaptured because nobody had added a line for it yet. The previous configuration
 * hard coded two addresses and, as a direct consequence, had Celo commented out for months.
 *
 * THE FAILURE MODE OF AN ERA MAP, WRITTEN DOWN HERE BECAUSE IT IS THE DANGEROUS ONE. A lookup
 * that always returns something cannot fail. `lookupEra` therefore returns null where no era
 * covers the block, and the caller writes era_resolution 'unresolved' with a NULL era_index, which
 * is what the L0 contract asks for: a row that does not know its era says so, and 'unresolved' is
 * not era 1.
 */

import { log } from "./log.js";
import type { CaptureTarget, EraMapEntry, NetworkConfig } from "./types.js";
import { loadChains } from "./control-plane/chains.js";
import { parseRegistry, validateRegistry, REGISTRY_PATH } from "./control-plane/contractRegistry.js";
import { ControlPlaneInvalidError } from "./control-plane/index.js";
import { boundToNullableNumber } from "./control-plane/int64.js";
import { chainStanding, RELEASE_SCOPE_FREEZE, type ReleaseScopeFreeze } from "./control-plane/releaseScope.js";

export { REGISTRY_PATH };

export interface Registry {
  /** One entry per contract era, in block order per contract. */
  eras: EraMapEntry[];
  /**
   * One entry per distinct (chain_id, proxy_address). `firstBlock` is null where the seed declares
   * no deployed code at that address, which is a real answer and not a block number.
   */
  contracts: { chainId: number; address: string; contractName: string; firstBlock: number | null; isLive: boolean }[];
  path: string;
  rowsRead: number;
}

let cached: Registry | null = null;

/**
 * Load and validate the registry, or throw.
 *
 * There is no partial result and no warning path. The condition this serves is that one malformed
 * byte in a control seed prevents the pipeline from starting, so every failure mode -- a missing
 * file, a malformed row, a bad integer lexeme, an overlapping era, a chain id that disagrees with
 * its chain name -- raises here rather than quietly producing a smaller universe.
 */
export function loadRegistry(path = REGISTRY_PATH): Registry {
  if (cached && cached.path === path) return cached;

  const chains = loadChains();
  const parsed = parseRegistry(path);
  const violations = validateRegistry(parsed, chains);
  if (violations.length > 0) throw new ControlPlaneInvalidError(violations);

  const eras: EraMapEntry[] = [];
  const byContract = new Map<string, Registry["contracts"][number]>();

  for (const r of parsed.rows) {
    if (!r.noCodeDeployed) {
      eras.push({
        chainId: r.chainId,
        proxyAddress: r.proxyAddress,
        eraIndex: r.eraIndex,
        implementationAddress: r.implementationAddress,
        validFromBlock: boundToNullableNumber(r.validFrom!)!,
        // Open ended becomes null, never a large number: null propagates as "still in force",
        // while a number propagates as a block that exists and can be compared against.
        validToBlock: boundToNullableNumber(r.validTo!),
      });
    }

    const key = `${r.chainId}|${r.proxyAddress}`;
    const existing = byContract.get(key);
    if (!existing) {
      byContract.set(key, {
        chainId: r.chainId, address: r.proxyAddress, contractName: r.contractName,
        firstBlock: r.creationBlock, isLive: r.isLive,
      });
    } else {
      if (r.creationBlock !== null && (existing.firstBlock === null || r.creationBlock < existing.firstBlock)) {
        existing.firstBlock = r.creationBlock;
      }
      if (r.isLive) existing.isLive = true;
    }
  }

  eras.sort((a, b) =>
    a.chainId - b.chainId || a.proxyAddress.localeCompare(b.proxyAddress) || a.validFromBlock - b.validFromBlock);

  cached = { eras, contracts: [...byContract.values()], path, rowsRead: parsed.rows.length };
  log.info(
    `Registry loaded: ${cached.contracts.length} contracts, ${cached.eras.length} eras, from ${parsed.rows.length} seed rows`,
    { path, recordDelimiter: parsed.csv.recordDelimiter, boundaryColumns: parsed.hasBoundaryColumns }
  );
  return cached;
}

/** Test seam. The cache is keyed on path, so a fixture cannot silently reuse a real load. */
export function clearRegistryCache(): void {
  cached = null;
}

export class ChainOutOfReleaseScopeError extends Error {
  constructor(readonly chain: string, message: string) {
    super(message);
    this.name = "ChainOutOfReleaseScopeError";
  }
}

/** Why one chain may not be acted on, in the words a command can print or persist. */
export interface RefusedChain {
  readonly network: NetworkConfig;
  readonly detail: string;
}

function outOfScopeDetail(network: NetworkConfig, freeze: ReleaseScopeFreeze): string {
  const drop = freeze.chainsDropped.find((c) => c.chain === network.name);
  const why = drop
    ? `was dropped from the release on ${drop.droppedOn}`
    : `is NOT in the release scope frozen on ${freeze.decidedOn} and is not recorded as dropped either, so nobody has decided about it`;
  return (
    `${network.name} is configured but ${why}; release scope is ` +
    `${freeze.releaseChains.join(", ")}; see ${freeze.decisionRecord}`
  );
}

/**
 * Split selected networks into the ones the release covers and the ones it refuses.
 *
 * Every command that acts per chain runs its network list through here first, so a dropped chain
 * is skipped with a stated reason instead of either being captured or aborting the whole run.
 * `targetsFor` refuses the same chain unconditionally, which is the backstop: this function makes
 * the refusal reportable, it does not make it optional.
 */
export function partitionByReleaseScope(
  networks: readonly NetworkConfig[],
  freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE,
): { usable: NetworkConfig[]; refused: RefusedChain[] } {
  if (!freeze.frozen) return { usable: [...networks], refused: [] };
  const usable: NetworkConfig[] = [];
  const refused: RefusedChain[] = [];
  for (const network of networks) {
    if (chainStanding(network.name, freeze) === "in_release") usable.push(network);
    else refused.push({ network, detail: outOfScopeDetail(network, freeze) });
  }
  return { usable, refused };
}

/**
 * The networks a per-chain command may act on, with each refusal logged exactly once.
 *
 * For commands that report through the log rather than through a run summary. `runPipeline` uses
 * `partitionByReleaseScope` directly because its refusals have to become typed outcomes.
 */
export function releaseScopedNetworks(
  networks: readonly NetworkConfig[],
  freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE,
): NetworkConfig[] {
  const { usable, refused } = partitionByReleaseScope(networks, freeze);
  for (const r of refused) log.warn(`Skipping ${r.network.name}: ${r.detail}`, { chainId: r.network.chainId });
  return usable;
}

/**
 * Capture targets for one chain, in address order.
 *
 * REFUSES a chain outside the frozen release scope, and this is the enforcement point for it on
 * the path that writes. Before this check the scope decision bound `plan` mode and the tests and
 * bound nothing on capture: `loadControlPlane`, which is what calls `assertReleaseScopeFrozen`,
 * has no caller in this package, and `loadRegistry` deliberately does not perform the
 * frozen-scope checks. Every command that captures, repairs or calibrates reaches a chain's
 * contracts through here, so one refusal covers all of them.
 *
 * Thrown rather than returned empty. An empty target list is indistinguishable from "this chain
 * has no contracts yet", and a run that silently covers nothing while exiting 0 is the exact
 * failure this pipeline has already paid for once. Callers that need to carry on with the chains
 * they CAN do filter first, through `partitionByReleaseScope`.
 *
 * `freeze` is a parameter with the frozen module as its default, matching `buildPlan` and
 * `assertReleaseScopeFrozen`, so a test can narrow the scope and watch the refusal instead of
 * asserting against whatever the scope happens to say today.
 *
 * EXCLUDES a contract the seed declares has no deployed code. Those rows carry an empty
 * `creation_block`, which this module now represents as null rather than 0. The distinction is the
 * whole point: handing a 0 to the pipeline asks it to scan genesis to head for an address that has
 * never held code, and "resume from block 0" is a guess wearing the costume of a conservative
 * default.
 *
 * It does NOT filter on isLive. A contract that was live and has since been retired still has
 * history worth ingesting, and dropping it would lose exactly the data L0 exists to hold.
 */
export function targetsFor(
  network: NetworkConfig,
  opts: { addresses?: string[] } = {},
  freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE,
): CaptureTarget[] {
  if (freeze.frozen && chainStanding(network.name, freeze) !== "in_release") {
    throw new ChainOutOfReleaseScopeError(
      network.name,
      `${network.name} cannot be captured: ${outOfScopeDetail(network, freeze)}`,
    );
  }

  const reg = loadRegistry();
  const wanted = opts.addresses ? new Set(opts.addresses.map((a) => a.toLowerCase())) : null;
  const onChain = reg.contracts.filter((c) => c.chainId === network.chainId);
  const unresolved = onChain.filter((c) => c.firstBlock === null);
  if (unresolved.length > 0) {
    log.warn(
      `${network.name}: ${unresolved.length} contract(s) excluded, the seed declares no deployed code there`,
      { contracts: unresolved.map((c) => `${c.contractName} ${c.address}`).join(", ") }
    );
  }
  return onChain
    .filter((c): c is typeof c & { firstBlock: number } => c.firstBlock !== null)
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
