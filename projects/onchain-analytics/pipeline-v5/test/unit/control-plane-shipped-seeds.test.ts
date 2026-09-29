/**
 * The SHIPPED seeds, through the same code path the pipeline uses.
 *
 * This is the GREEN half of the strict-parser suite: the real control plane must survive every
 * rule with zero dropped rows. A parser that rejects a defect but also rejects the live seed has
 * not helped anyone.
 *
 * It reads three CSV files and touches no network and no warehouse.
 */

import { describe, it, expect } from "vitest";
import { inspectControlPlane } from "../../src/control-plane/index.js";
import { topic0For, RAWLOGS_INDEXED_SLOTS } from "../../src/control-plane/eventSurface.js";

const inspection = inspectControlPlane();

describe("the shipped control plane parses and validates", () => {
  it("has no malformed physical row in any seed", () => {
    expect(inspection.parseError, inspection.parseError?.message).toBeNull();
  });

  it("passes every registry rule", () => {
    expect(inspection.registryViolations).toEqual([]);
  });

  it("passes every event-surface rule", () => {
    expect(inspection.surfaceViolations).toEqual([]);
  });

  it("drops zero rows: physical line count reconciles with parsed record count", () => {
    const { registry, eventSurface } = inspection.plane!;
    expect(registry.rows.length).toBe(registry.csv.physicalLines - 1);
    expect(eventSurface.rows.length).toBe(eventSurface.csv.physicalLines - 1);
  });
});

/**
 * Measured on 2026-09-28 against the held-local seeds. These are deliberately exact: a control
 * seed changing size is a decision, not a detail, and this test is where that decision has to be
 * acknowledged. Plan task 16 regenerates both seeds, and updating these numbers is part of it.
 */
describe("measured shape of the shipped seeds", () => {
  const plane = inspection.plane!;

  it("contract_deployments holds 362 rows over 148 contracts", () => {
    expect(plane.registry.rows).toHaveLength(362);
    expect(new Set(plane.registry.rows.map((r) => `${r.chainId}|${r.proxyAddress}`)).size).toBe(148);
  });

  it("356 of those are deployment eras and 6 declare no deployed code", () => {
    expect(plane.registry.rows.filter((r) => !r.noCodeDeployed)).toHaveLength(356);
    expect(plane.registry.rows.filter((r) => r.noCodeDeployed)).toHaveLength(6);
  });

  it("every open-ended sentinel row is exactly a live row, and there are 142", () => {
    const sentinel = plane.registry.rows.filter((r) => r.validTo?.kind === "open_ended");
    const live = plane.registry.rows.filter((r) => r.isLive);
    expect(sentinel).toHaveLength(142);
    expect(live).toHaveLength(142);
    expect(sentinel.map((r) => r.line)).toEqual(live.map((r) => r.line));
  });

  it("event_surface holds 2824 rows", () => {
    expect(plane.eventSurface.rows).toHaveLength(2824);
  });

  it("recomputes every non-anonymous topic0 and matches all of them", () => {
    const nonAnon = plane.eventSurface.rows.filter((r) => !r.anonymous);
    expect(nonAnon).toHaveLength(2823);
    const mismatched = nonAnon.filter((r) => topic0For(r.eventSignature) !== r.topic0);
    expect(mismatched.map((r) => `${r.line} ${r.eventSignature}`)).toEqual([]);
  });

  it("binds all 2824 surface rows to exactly one deployment era", () => {
    expect(plane.counts.bindingChecked).toBe(2824);
    expect(plane.counts.bindingMatched).toBe(2824);
  });

  it("carries exactly one anonymous event, and it does not fit the RawLogs grain", () => {
    const anon = plane.eventSurface.rows.filter((r) => r.anonymous);
    expect(anon).toHaveLength(1);
    expect(anon[0].eventSignature).toBe("LogNote(bytes4,address,bytes32,bytes32,bytes)");
    expect(anon[0].indexedPositions.length).toBeGreaterThan(RAWLOGS_INDEXED_SLOTS);
    expect(inspection.advisories.map((a) => a.check)).toEqual(["anonymous_not_capturable_in_rawlogs"]);
  });

  it("labels 24 indexed dynamic parameters as permanently unrecoverable from a log", () => {
    const hashOnly = plane.eventSurface.rows.filter((r) => r.hashOnlyIndexedPositions.length > 0);
    expect(hashOnly).toHaveLength(24);
    expect([...new Set(hashOnly.map((r) => r.eventSignature))].sort())
      .toEqual(["AdminsAdded(address[])", "AdminsRemoved(address[])"]);
  });

  // RENAMED 2026-09-28 by the decode unit, together with the seed it describes.
  //   was: "carries no boundary-evidence column, so every era is raw_only_unproven"
  // The registry seed now carries the declared five-column boundary block, so the old name states
  // the opposite of the artifact. What did NOT change is the verdict every era carries: Phase 2B
  // reached `complete` on 0 of 41 assessed eras and the rest were never assessed, so nothing may
  // claim anything stronger than raw_only_unproven.
  it("carries the boundary-evidence block, and every era still reads raw_only_unproven", () => {
    expect(plane.registry.hasBoundaryColumns).toBe(true);
    expect(plane.registry.rows.every((r) => r.boundaryCompleteness === "raw_only_unproven")).toBe(true);
    // Only the eras an evidence manifest covers carry a hash; the rest declare nothing rather
    // than declaring an absence as if it were a measurement.
    expect(plane.registry.rows.filter((r) => r.boundaryEvidenceManifestHash !== null)).toHaveLength(41);
    // Every row now makes a scope statement, which is what `scope_pending` exists to prevent
    // being skipped.
    expect(plane.registry.rows.every((r) => r.releaseScope === "in_release" || r.releaseScope === "out_of_release")).toBe(true);
    expect(plane.registry.rows.filter((r) => r.releaseScope === "out_of_release")).toHaveLength(96);
  });
});
