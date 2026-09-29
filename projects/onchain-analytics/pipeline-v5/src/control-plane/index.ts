/**
 * registry/index.ts -- the public entry point for the control plane.
 *
 * `loadControlPlane` is fail-closed: it returns a validated control plane or it throws. There is
 * no partial result and no warning path, because the exit condition this module exists to satisfy
 * is that one malformed byte in either control seed prevents the pipeline from starting.
 *
 * `inspectControlPlane` is the same work without the throw, for the validation report. It exists
 * so evidence can be generated from the identical code the pipeline runs, rather than from a
 * second implementation that could disagree with it.
 */

import { SeedParseError } from "./csv.js";
import { loadChains, CHAINS_PATH, type ChainAuthority } from "./chains.js";
import { parseRegistry, validateRegistry, REGISTRY_PATH, type ParsedRegistry } from "./contractRegistry.js";
import { assertReleaseScopeFrozen, releaseScopeState, RELEASE_SCOPE_FREEZE, type ReleaseScopeFreeze, type ReleaseScopeState } from "./releaseScope.js";
import { parseEventSurface, validateEventSurface, EVENT_SURFACE_PATH, type ParsedEventSurface, type SurfaceCheckCounts } from "./eventSurface.js";
import { computeAmbiguousKeys, KNOWN_DECODE_AMBIGUITIES, type AmbiguousKey } from "./decodeSurface.js";
import { violation, type Violation } from "./fields.js";

export * from "./int64.js";
export * from "./csv.js";
export * from "./fields.js";
export * from "./chains.js";
export * from "./contractRegistry.js";
export * from "./releaseScope.js";
export * from "./eventSurface.js";
export * from "./decodeSurface.js";
export * from "./eraConfidence.js";
export * from "./eraIntervals.js";
export * from "./magnitude.js";

export interface ControlPlanePaths {
  readonly chains?: string;
  readonly registry?: string;
  readonly eventSurface?: string;
  /** Overridable so a test can exercise an unfrozen scope without editing the shipped decision. */
  readonly freeze?: ReleaseScopeFreeze;
}

export interface ControlPlane {
  readonly chains: ChainAuthority;
  readonly registry: ParsedRegistry;
  readonly eventSurface: ParsedEventSurface;
  readonly counts: SurfaceCheckCounts;
  readonly releaseScopeState: ReleaseScopeState;
}

export interface ControlPlaneInspection {
  readonly ok: boolean;
  /** Set when a physical row was malformed. Parsing stops at the first one, by design. */
  readonly parseError: { readonly path: string; readonly line: number | null; readonly message: string } | null;
  readonly registryViolations: readonly Violation[];
  readonly surfaceViolations: readonly Violation[];
  /** Violations of the frozen release scope: a pending row, an excluded contract, a new chain. */
  readonly releaseScopeViolations: readonly Violation[];
  /**
   * An undeclared decode ambiguity: one `topic0` carrying two physical layouts on one address,
   * with nothing recording that anybody has looked at it. Blocking, because the alternative is a
   * decoder silently picking one of the two layouts.
   */
  readonly decodeViolations: readonly Violation[];
  /** Every ambiguous key found, declared or not. Reported so the count is never inferred. */
  readonly decodeAmbiguities: readonly AmbiguousKey[];
  readonly releaseScopeState: ReleaseScopeState | null;
  /** True statements about the capture grain. Reported, never blocking. */
  readonly advisories: readonly Violation[];
  readonly plane: ControlPlane | null;
}

export class ControlPlaneInvalidError extends Error {
  constructor(readonly violations: readonly Violation[]) {
    const shown = violations.slice(0, 25)
      .map((x) => `  [${x.check}] line ${x.line ?? "-"} ${x.subject}: ${x.detail}`)
      .join("\n");
    const more = violations.length > 25 ? `\n  ... and ${violations.length - 25} more` : "";
    super(`CONTROL_PLANE_REJECTED: ${violations.length} rule violation(s)\n${shown}${more}`);
    this.name = "ControlPlaneInvalidError";
  }
}

export function inspectControlPlane(paths: ControlPlanePaths = {}): ControlPlaneInspection {
  const chainsPath = paths.chains ?? CHAINS_PATH;
  const registryPath = paths.registry ?? REGISTRY_PATH;
  const surfacePath = paths.eventSurface ?? EVENT_SURFACE_PATH;

  let chains: ChainAuthority;
  let registry: ParsedRegistry;
  let eventSurface: ParsedEventSurface;
  try {
    chains = loadChains(chainsPath);
    registry = parseRegistry(registryPath);
    eventSurface = parseEventSurface(surfacePath);
  } catch (e) {
    if (e instanceof SeedParseError) {
      return {
        ok: false,
        parseError: { path: e.path, line: e.line, message: e.message },
        registryViolations: [], surfaceViolations: [], releaseScopeViolations: [],
        decodeViolations: [], decodeAmbiguities: [],
        releaseScopeState: null, advisories: [], plane: null,
      };
    }
    throw e;
  }

  const freeze = paths.freeze ?? RELEASE_SCOPE_FREEZE;
  const registryViolations = validateRegistry(registry, chains);
  const releaseScopeViolations = assertReleaseScopeFrozen(registry, chains, freeze);
  const { violations: surfaceViolations, advisories, counts } = validateEventSurface(eventSurface, registry, chains);
  const decodeAmbiguities = computeAmbiguousKeys(eventSurface);
  const decodeViolations = undeclaredAmbiguityViolations(decodeAmbiguities);
  const state = releaseScopeState(registry);

  return {
    ok: registryViolations.length === 0 && surfaceViolations.length === 0
      && releaseScopeViolations.length === 0 && decodeViolations.length === 0,
    parseError: null,
    registryViolations,
    surfaceViolations,
    releaseScopeViolations,
    decodeViolations,
    decodeAmbiguities,
    releaseScopeState: state,
    advisories,
    plane: { chains, registry, eventSurface, counts, releaseScopeState: state },
  };
}

/**
 * An ambiguous key nobody has declared is a blocking violation; a declared one is not.
 *
 * The distinction is the whole control. Two implementations of one event that differ only in an
 * `indexed` flag share a `topic0`, so a topic0-keyed decoder has two candidates and picks the
 * first. Declaring the key records that somebody looked and said what happens; leaving it
 * undeclared means nobody has, and that is the case worth failing on.
 */
function undeclaredAmbiguityViolations(found: readonly AmbiguousKey[]): Violation[] {
  const declared = new Set(KNOWN_DECODE_AMBIGUITIES.map((k) => `${k.chainId}|${k.address.toLowerCase()}|${k.signature}`));
  return found
    .filter((k) => !declared.has(`${k.chainId}|${k.address.toLowerCase()}|${k.signature}`))
    .map((k) => violation(
      "decode_ambiguity_declared",
      k.layouts[0]?.lines[0] ?? null,
      `${k.chain} ${k.address} ${k.signature}`,
      `topic0 ${k.topic0} carries ${k.layouts.length} physical layouts (${k.layouts.map((l) => `indexed[${l.indexedPositions}] in era(s) ${l.eras.join(",")}`).join(" vs ")}) and is not declared in KNOWN_DECODE_AMBIGUITIES; a topic0-keyed decoder would pick one of them without raising`,
    ));
}

export function loadControlPlane(paths: ControlPlanePaths = {}): ControlPlane {
  const chains = loadChains(paths.chains ?? CHAINS_PATH);
  const registry = parseRegistry(paths.registry ?? REGISTRY_PATH);
  const eventSurface = parseEventSurface(paths.eventSurface ?? EVENT_SURFACE_PATH);
  const freeze = paths.freeze ?? RELEASE_SCOPE_FREEZE;

  const registryViolations = validateRegistry(registry, chains);
  const releaseScopeViolations = assertReleaseScopeFrozen(registry, chains, freeze);
  const { violations: surfaceViolations, counts } = validateEventSurface(eventSurface, registry, chains);
  const decodeViolations = undeclaredAmbiguityViolations(computeAmbiguousKeys(eventSurface));
  const all = [...registryViolations, ...surfaceViolations, ...releaseScopeViolations, ...decodeViolations];
  if (all.length > 0) throw new ControlPlaneInvalidError(all);

  return { chains, registry, eventSurface, counts, releaseScopeState: releaseScopeState(registry) };
}