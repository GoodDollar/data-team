/**
 * build-check.ts -- the decode layer's build-time gate.
 *
 * WHY A SEPARATE ENTRY POINT. A control that only exists inside a function nothing calls enforces
 * nothing. This file is what makes the decode assertions a BUILD failure rather than a fact
 * somebody could look up: it runs on `npm run verify:local`, it exits non-zero, and it can be
 * pointed at a fixture so the failure itself is demonstrable rather than merely asserted.
 *
 *   npx tsx src/control-plane/build-check.ts [--chains p] [--registry p] [--event-surface p]
 *
 * Exit 0 clean, exit 1 on a blocking finding, exit 2 on a usage error.
 */

import { parseEventSurface } from "./eventSurface.js";
import { parseRegistry } from "./contractRegistry.js";
import { SeedParseError } from "./csv.js";
import { pathToFileURL } from "url";
import { assertSemanticErasConsumable, RELEASE_SCOPE_FREEZE } from "./releaseScope.js";
import { parseEraBoundaryEvidence, eraEvidenceKey } from "./eraConfidence.js";
import {
  assertNoUnhandledDecodeAmbiguity,
  buildAllUnionAbis,
  isNewestFirst,
  intervalsWithNoDecodableSurface,
  UnhandledDecodeAmbiguityError,
  KNOWN_DECODE_AMBIGUITIES,
} from "./decodeSurface.js";

interface Options {
  registry?: string;
  eventSurface?: string;
  boundaryEvidence?: string;
}

export function parseArgs(argv: readonly string[]): Options {
  const o: Options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`build-check: '${flag}' needs a value`);
    if (flag === "--registry") o.registry = value;
    else if (flag === "--event-surface") o.eventSurface = value;
    else if (flag === "--boundary-evidence") o.boundaryEvidence = value;
    else throw new Error(`build-check: unknown argument '${flag}'`);
  }
  return o;
}

export interface BuildCheckResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly ambiguousKeyCount: number;
  readonly unionsChecked: number;
  readonly unionsOutOfOrder: number;
  readonly undecodableIntervals: number;
  /** Eras carrying promoted boundary evidence on a release chain -- the measured consumed set. */
  readonly evidencedErasChecked: number;
  readonly evidencedErasRefused: number;
}

/** Runs every decode build check. Returns rather than exits, so a test can drive it. */
export function runBuildCheck(options: Options = {}): BuildCheckResult {
  const lines: string[] = [];
  const surface = parseEventSurface(options.eventSurface);
  const registry = parseRegistry(options.registry);

  // 1. The ambiguous set. Throws on any key nobody has declared.
  const ambiguous = assertNoUnhandledDecodeAmbiguity(surface);
  lines.push(`decode ambiguity: ${ambiguous.length} key(s) found, all declared in KNOWN_DECODE_AMBIGUITIES (${KNOWN_DECODE_AMBIGUITIES.length} declared)`);
  for (const k of ambiguous) lines.push(`  declared: ${k.chain} ${k.address} ${k.signature}`);

  // 2. Union order. A union built oldest-first decodes a later-era log into the wrong columns
  //    without raising, so the order is checked rather than trusted.
  const unions = buildAllUnionAbis(surface);
  const outOfOrder = [...unions.values()].filter((u) => !isNewestFirst(u));
  lines.push(`union order: ${unions.size} union(s) built, ${outOfOrder.length} not newest-implementation-first`);
  for (const u of outOfOrder) lines.push(`  OUT OF ORDER: ${u.chain} ${u.address} eras ${u.eraOrder.join(",")}`);

  // 3. Intervals nothing can decode. Reported, never blocking: raw capture is lossless and an
  //    interval with no ABI is a known state, not a defect in this seed.
  const undecodable = intervalsWithNoDecodableSurface(registry.rows, surface);
  const noAbi = undecodable.filter((i) => i.reason === "no_abi_held").length;
  lines.push(`decode coverage: ${undecodable.length} interval(s) have no surface entry (${noAbi} hold no ABI at all, ${undecodable.length - noAbi} hold an ABI but catalogue no event)`);

  // 4. The semantic-era policy, on the eras that are actually consumed.
  //
  //    WHY THIS SET AND NOT EVERY ERA. Phase 2B derived the consumed set by walking every semantic
  //    and mart model down to the raw tables it reads: 41 eras over 6 contracts. Those are exactly
  //    the eras a boundary manifest was produced for, and they are what the promoted evidence seed
  //    carries. Running the policy over every era in the registry instead would refuse 247 eras
  //    nobody consumes and block the build for a reason no reader could act on -- which is
  //    over-refusal, and over-refusal is its own defect.
  const evidence = parseEraBoundaryEvidence(options.boundaryEvidence);
  const releaseChains = new Set(RELEASE_SCOPE_FREEZE.releaseChains);
  const consumed = registry.rows.filter(
    (r) => releaseChains.has(r.chain) && !r.noCodeDeployed && evidence.has(eraEvidenceKey(r.chainId, r.proxyAddress, r.eraIndex)),
  );
  const refusals = assertSemanticErasConsumable(consumed, "consumed semantic eras", RELEASE_SCOPE_FREEZE, { boundaryEvidence: evidence });
  lines.push(`semantic era policy: ${consumed.length} consumed era(s) checked, ${refusals.length} refused`);
  for (const v of refusals) lines.push(`  REFUSED: ${v.subject}: ${v.detail}`);

  return {
    ok: outOfOrder.length === 0 && refusals.length === 0,
    lines,
    ambiguousKeyCount: ambiguous.length,
    unionsChecked: unions.size,
    unionsOutOfOrder: outOfOrder.length,
    undecodableIntervals: undecodable.length,
    evidencedErasChecked: consumed.length,
    evidencedErasRefused: refusals.length,
  };
}

function main(argv: readonly string[]): number {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  try {
    const result = runBuildCheck(options);
    for (const l of result.lines) console.log(l);
    if (!result.ok) {
      console.error("BUILD CHECK FAILED: a union ABI is not newest-implementation-first, or a consumed era is refused");
      return 1;
    }
    console.log("BUILD CHECK CLEAN");
    return 0;
  } catch (e) {
    if (e instanceof UnhandledDecodeAmbiguityError || e instanceof SeedParseError) {
      console.error(`BUILD CHECK FAILED: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

// Only run when invoked directly, so importing this file in a test does not exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
