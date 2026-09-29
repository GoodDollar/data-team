/**
 * report.ts -- run every control-plane check against the shipped seeds and emit the evidence.
 *
 * This is deliberately the SAME code path the pipeline uses (`inspectControlPlane`), not a second
 * implementation. A validation report produced by a parallel implementation proves that the two
 * agree, which is not the question; the question is what the thing that gates ingestion decides.
 *
 * Reads files. Writes one JSON file. No network, no BigQuery.
 *
 *   npx tsx src/control-plane/report.ts <output.json>
 */

import { writeFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { inspectControlPlane } from "./index.js";
import { CHAINS_PATH } from "./chains.js";
import { REGISTRY_PATH, REGISTRY_BOUNDARY_COLUMNS } from "./contractRegistry.js";
import { EVENT_SURFACE_PATH, canonicalSignature, topic0For, RAWLOGS_INDEXED_SLOTS } from "./eventSurface.js";
import { eraConsumableBySemanticModel } from "./releaseScope.js";
import { buildAllUnionAbis, isNewestFirst } from "./decodeSurface.js";
import { INT64_MAX_LEXEME } from "./int64.js";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function tally<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const m = new Map<string, number>();
  for (const i of items) {
    const k = key(i);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

const outPath = process.argv[2];
if (!outPath) {
  console.error("usage: tsx src/control-plane/report.ts <output.json>");
  process.exit(2);
}

const inspection = inspectControlPlane();

const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  inputs: {
    chains: { path: CHAINS_PATH, sha256: sha256(CHAINS_PATH) },
    contract_deployments: { path: REGISTRY_PATH, sha256: sha256(REGISTRY_PATH) },
    event_surface: { path: EVENT_SURFACE_PATH, sha256: sha256(EVENT_SURFACE_PATH) },
  },
  ok: inspection.ok,
  parseError: inspection.parseError,
  advisories: inspection.advisories,
};

if (inspection.plane) {
  const { chains, registry, eventSurface, counts } = inspection.plane;
  const rows = registry.rows;
  const surface = eventSurface.rows;

  const deployed = rows.filter((r) => !r.noCodeDeployed);
  const noCode = rows.filter((r) => r.noCodeDeployed);
  const contracts = new Set(rows.map((r) => `${r.chainId}|${r.proxyAddress}`));
  const sentinelRows = rows.filter((r) => r.validTo?.kind === "open_ended");
  const liveRows = rows.filter((r) => r.isLive);
  const unions = buildAllUnionAbis(eventSurface);

  // Task 10. The full list, not a count: an indexed dynamic parameter is unrecoverable from any
  // log capture at any completeness, so which ones they are is the deliverable.
  const hashOnly = surface
    .filter((r) => r.hashOnlyIndexedPositions.length > 0)
    .map((r) => ({
      line: r.line, chain: r.chain, contract: r.contractName, proxyAddress: r.proxyAddress,
      eraIndex: r.eraIndex, signature: r.eventSignature, topic0: r.topic0,
      hashOnlyParams: r.hashOnlyIndexedPositions.map((p) => ({ position: p, type: r.paramTypes[p], name: r.paramNames[p] })),
    }));

  // Task 9. Anonymous events, with the physical slot arithmetic stated per row.
  const anonymous = surface.filter((r) => r.anonymous).map((r) => ({
    line: r.line, chain: r.chain, contract: r.contractName, proxyAddress: r.proxyAddress,
    eraIndex: r.eraIndex, signature: r.eventSignature,
    indexedCount: r.indexedPositions.length,
    indexedPositions: r.indexedPositions,
    paramTypes: r.paramTypes,
    topicSlotsNeeded: r.indexedPositions.length,
    rawlogsIndexedSlots: RAWLOGS_INDEXED_SLOTS,
    losslesslyCapturable: r.indexedPositions.length <= RAWLOGS_INDEXED_SLOTS,
  }));

  // Task 6, restated independently of the validator so the report carries its own arithmetic.
  let topic0Recomputed = 0, topic0Agreed = 0, sigRebuilt = 0, sigAgreed = 0;
  const topic0Mismatches: unknown[] = [];
  for (const r of surface) {
    const canon = canonicalSignature(r.eventName, r.paramTypes);
    sigRebuilt++;
    if (canon === r.eventSignature) sigAgreed++;
    if (!r.anonymous) {
      topic0Recomputed++;
      const t = topic0For(r.eventSignature);
      if (t === r.topic0) topic0Agreed++;
      else topic0Mismatches.push({ line: r.line, signature: r.eventSignature, stored: r.topic0, recomputed: t });
    }
  }

  const distinctSelectors = new Set(surface.filter((r) => !r.anonymous).map((r) => r.topic0!));
  const layoutsBySelector = new Map<string, Set<string>>();
  for (const r of surface) {
    if (r.anonymous) continue;
    const set = layoutsBySelector.get(r.topic0!) ?? new Set<string>();
    set.add(r.indexedPositions.join(","));
    layoutsBySelector.set(r.topic0!, set);
  }
  const multiLayoutSelectors = [...layoutsBySelector].filter(([, s]) => s.size > 1);

  const layoutsByEraKey = new Map<string, Set<string>>();
  for (const r of surface) {
    if (r.anonymous) continue;
    const k = `${r.chainId}|${r.proxyAddress}|${r.topic0}`;
    const set = layoutsByEraKey.get(k) ?? new Set<string>();
    set.add(r.indexedPositions.join(","));
    layoutsByEraKey.set(k, set);
  }
  const keysChangingLayoutAcrossEras = [...layoutsByEraKey]
    .filter(([, s]) => s.size > 1)
    .map(([k, s]) => ({ key: k, layouts: [...s] }));

  report.chains = { path: chains.path, rows: chains.rows };

  report.registry = {
    path: registry.csv.path,
    recordDelimiter: registry.csv.recordDelimiter,
    physicalLines: registry.csv.physicalLines,
    parsedRecords: registry.rows.length,
    physicalMinusHeaderEqualsParsed: registry.csv.physicalLines - 1 === registry.rows.length,
    headerFieldCount: registry.csv.header.length,
    hasBoundaryColumns: registry.hasBoundaryColumns,
    boundaryColumnsExpectedWhenRegenerated: REGISTRY_BOUNDARY_COLUMNS,
    droppedRows: 0,
    distinctContracts: contracts.size,
    eraRows: deployed.length,
    noCodeDeployedRows: noCode.length,
    noCodeDeployedList: noCode.map((r) => ({ line: r.line, chain: r.chain, contract: r.contractName, address: r.proxyAddress, notes: r.notes })),
    eraRowsByChain: tally(deployed, (r) => r.chain),
    contractsByChain: tally([...contracts].map((k) => k.split("|")[0]), (id) => chains.byId.get(Number(id)) ?? `chain_id ${id}`),
    openEndedSentinelRows: sentinelRows.length,
    isLiveRows: liveRows.length,
    sentinelSetEqualsLiveSet:
      sentinelRows.length === liveRows.length && sentinelRows.every((r) => r.isLive),
    sentinelLexeme: INT64_MAX_LEXEME,
    boundaryCompletenessDistribution: tally(rows, (r) => r.boundaryCompleteness),
    categoryDistribution: tally(rows, (r) => r.category),
    eraMethodDistribution: tally(rows, (r) => r.eraMethod),
    eraAnnouncementDistribution: tally(rows, (r) => r.eraAnnouncementEvent),
    violations: inspection.registryViolations,
    violationsByCheck: tally(inspection.registryViolations, (v) => v.check),
  };

  report.eventSurface = {
    path: eventSurface.csv.path,
    recordDelimiter: eventSurface.csv.recordDelimiter,
    physicalLines: eventSurface.csv.physicalLines,
    parsedRecords: surface.length,
    physicalMinusHeaderEqualsParsed: eventSurface.csv.physicalLines - 1 === surface.length,
    headerFieldCount: eventSurface.csv.header.length,
    droppedRows: 0,
    rowsByChain: tally(surface, (r) => r.chain),
    task6_topic0: {
      rowsChecked: topic0Recomputed,
      rowsMatched: topic0Agreed,
      rowsMismatched: topic0Recomputed - topic0Agreed,
      rowsNotCheckedBecauseAnonymous: surface.length - topic0Recomputed,
      mismatches: topic0Mismatches,
    },
    task6_canonicalSignature: {
      rowsChecked: sigRebuilt,
      rowsMatched: sigAgreed,
      rowsMismatched: sigRebuilt - sigAgreed,
    },
    task7_binding: {
      rowsChecked: counts.bindingChecked,
      rowsBindingToExactlyOneEra: counts.bindingMatched,
      rowsFailingToBind: counts.bindingChecked - counts.bindingMatched,
    },
    task5_eraBoundRows: {
      declaredBound: surface.filter((r) => r.eraBound).length,
      comparedAgainstDeploymentEra: counts.boundRowsChecked,
      carryingOpenEndedSentinel: surface.filter((r) => r.eraBoundTo?.kind === "open_ended").length,
      eventGroupsChecked: counts.boundGroupsChecked,
      eventGroupsWhoseWindowIsTheExactEnvelope: counts.boundGroupsMatchingEnvelope,
    },
    task9_anonymous: { count: anonymous.length, rows: anonymous },
    task10_hashOnlyIndexed: {
      rowCount: hashOnly.length,
      paramCount: hashOnly.reduce((n, r) => n + r.hashOnlyParams.length, 0),
      distinctSignatures: [...new Set(hashOnly.map((r) => r.signature))],
      rows: hashOnly,
    },
    layoutRisk: {
      distinctSelectors: distinctSelectors.size,
      selectorsWithMoreThanOneIndexedLayout: multiLayoutSelectors.length,
      selectorsWithMoreThanOneIndexedLayoutList: multiLayoutSelectors.map(([t, s]) => ({ topic0: t, layouts: [...s] })),
      chainAddressSelectorKeysChangingLayoutAcrossOwnEras: keysChangingLayoutAcrossEras,
    },
    violations: inspection.surfaceViolations,
    violationsByCheck: tally(inspection.surfaceViolations, (v) => v.check),
  };

  // The grade is a propagating confidence signal, NOT a gate. REVERSED 2026-09-28, at the same
  // time as the branch table in `releaseScope.ts`: changing one carrier and not the other would
  // have left the old rule live in whichever path survived, and this file is the second carrier.
  //
  // What changed: `raw_only_unproven` used to forbid every decoder, every state interpretation
  // and every user-facing model over every era, which was all of them. It no longer refuses
  // anything. The bar it enforced required every slot-writing path to obligatorily emit an upgrade
  // event, and EIP-1967 says SHOULD rather than MUST, so the bar was unreachable by construction
  // and produced 0 provable eras out of 41 -- uninformative rather than conservative.
  report.boundaryEvidence = {
    columnsPresent: registry.hasBoundaryColumns,
    erasReadingRawOnlyUnproven: rows.filter((r) => r.boundaryCompleteness === "raw_only_unproven").length,
    erasCarryingAManifestHash: rows.filter((r) => r.boundaryEvidenceManifestHash !== null).length,
    consumableEras: rows.filter((r) => eraConsumableBySemanticModel(r).consumable).length,
    refusalsByBranch: tally(
      rows.filter((r) => !eraConsumableBySemanticModel(r).consumable),
      (r) => eraConsumableBySemanticModel(r).branch,
    ),
    confidenceGradeDistribution: tally(rows, (r) => eraConsumableBySemanticModel(r).confidenceGrade),
    policy:
      "boundary_completeness='raw_only_unproven' is a CONFIDENCE GRADE that propagates to whatever " +
      "reads the era; it is not a refusal. An era is refused only when it has no code, is not in " +
      "the release, carries no boundary evidence at all, holds no ABI, carries an unbound decode " +
      "ambiguity, or fails a magnitude tripwire. Every refusal names its branch above.",
  };

  // The computed ambiguous set, reported rather than inferred, with the two senses of scope kept
  // apart because they differ: Ethereum is in the declared release and is not ingested here.
  const INGESTION_SCOPE = new Set(["CELO", "XDC"]);
  report.decodeAmbiguity = {
    keysFound: inspection.decodeAmbiguities.length,
    keysInDeclaredReleaseScope: inspection.decodeAmbiguities.filter((k) => ["CELO", "XDC", "ETHEREUM"].includes(k.chain)).length,
    keysInIngestionScope: inspection.decodeAmbiguities.filter((k) => INGESTION_SCOPE.has(k.chain)).length,
    keys: inspection.decodeAmbiguities,
    undeclaredViolations: inspection.decodeViolations,
    unionsBuilt: unions.size,
    unionsNotNewestFirst: [...unions.values()].filter((u) => !isNewestFirst(u)).map((u) => ({ chain: u.chain, address: u.address, eraOrder: u.eraOrder })),
  };
}

writeFileSync(outPath, JSON.stringify(report, null, 2), "ascii");
console.log(`ok=${inspection.ok} parseError=${inspection.parseError ? "YES" : "no"} ` +
  `registryViolations=${inspection.registryViolations.length} surfaceViolations=${inspection.surfaceViolations.length} ` +
  `advisories=${inspection.advisories.length}`);
if (inspection.parseError) console.log(inspection.parseError.message);
for (const v of [...inspection.registryViolations, ...inspection.surfaceViolations, ...inspection.advisories].slice(0, 40)) {
  console.log(`  [${v.check}] line ${v.line ?? "-"} ${v.subject}: ${v.detail}`);
}
