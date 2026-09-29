/**
 * coverage.ts, as a green suite.
 *
 * The H3 and H5 red tests prove the defects are closed. These prove the rules around them behave,
 * including the cases that decide whether the H3 fix is a real rule or a special case that happens
 * to satisfy one fixture: a gap ABOVE the newest recorded block is not a gap, a row that describes
 * no range must not widen the envelope, and a repaired hole must stop being reported.
 */

import { describe, it, expect } from "vitest";
import {
  isClean, openGaps, computeResumePoint, weightDecodeCoverage,
  type DecodeLogGroup,
} from "../../src/coverage.js";
import { parseEventSurface } from "../../src/control-plane/eventSurface.js";
import { interval } from "../helpers/fixtures.js";
import { EVENT_SURFACE_PATH } from "../../src/control-plane/eventSurface.js";

describe("isClean: a capture vouches for its range only when it finished and skipped nothing", () => {
  it("accepts a complete capture with no skips", () => {
    expect(isClean(interval(100, 199))).toBe(true);
  });

  it("rejects a complete capture that recorded a skip", () => {
    expect(isClean(interval(100, 199, { skipped: [[150, 160]] }))).toBe(false);
  });

  it("rejects every non-complete status", () => {
    for (const status of ["incomplete", "unconfirmed_empty", "refused_budget", "capability_gap", "nothing_to_fetch"]) {
      expect(isClean(interval(100, 199, { status }))).toBe(false);
    }
  });
});

describe("openGaps names three kinds of hole and nothing else", () => {
  it("names a hole no capture ever recorded, between two clean captures", () => {
    // H3, stated as a rule rather than as one fixture.
    expect(openGaps([interval(100, 199), interval(300, 399)])).toEqual([[200, 299]]);
  });

  it("names a recorded skip", () => {
    expect(openGaps([interval(100, 199, { skipped: [[150, 160]] })])).toEqual([[150, 160]]);
  });

  it("names the whole range of a capture that did not complete", () => {
    expect(openGaps([interval(100, 199, { status: "incomplete" })])).toEqual([[100, 199]]);
  });

  it("does NOT name anything above the newest recorded block", () => {
    // The bound that keeps this from reporting the rest of the chain. Blocks nobody has claimed
    // to read are the resume point's subject, not a gap in what was read.
    expect(openGaps([interval(100, 199)])).toEqual([]);
  });

  it("does not let a row that describes no range widen the envelope", () => {
    // A `nothing_to_fetch` row records toBlock BELOW fromBlock. Counting it would invent a
    // gigantic gap out of a read that found nothing to do.
    const captures = [interval(100, 199), interval(5_000, 4_999, { status: "nothing_to_fetch" })];
    expect(openGaps(captures)).toEqual([]);
  });

  it("stops naming a hole once a later clean capture covers it", () => {
    const captures = [interval(100, 199), interval(300, 399), interval(200, 299)];
    expect(openGaps(captures)).toEqual([]);
  });

  it("returns nothing for an empty ledger, because absence of rows is not a hole in a range", () => {
    expect(openGaps([])).toEqual([]);
  });

  it("merges adjacent holes into one range", () => {
    const captures = [interval(100, 199), interval(400, 499), interval(200, 299, { status: "incomplete" })];
    expect(openGaps(captures)).toEqual([[200, 399]]);
  });

  it("clamps an unreadable skip to the capture's own range rather than dropping it", () => {
    const captures = [interval(100, 199, { status: "incomplete", skipped: [[-Infinity, Infinity]] })];
    expect(openGaps(captures)).toEqual([[100, 199]]);
  });
});

describe("computeResumePoint stays below a hole and now names it", () => {
  it("resumes at the edge of the contiguous clean run, not at the highest block held", () => {
    const resume = computeResumePoint([interval(100, 199), interval(300, 399)], 100);
    expect(resume.resumeAt).toBe(199);
    expect(resume.coveredUpTo).toBe(199);
  });

  it("names the hole in its own output, so no mode of this module is silent about it", () => {
    const resume = computeResumePoint([interval(100, 199), interval(300, 399)], 100);
    expect(resume.openGaps).toEqual([[200, 299]]);
    expect(resume.reason).toContain("200..299");
  });

  it("falls back to the creation block when no coverage row exists", () => {
    const resume = computeResumePoint([], 12_345);
    expect(resume.resumeAt).toBe(12_345);
    expect(resume.coveredUpTo).toBeNull();
    expect(resume.reason).toContain("no coverage row exists");
  });

  it("falls back to the creation block when every row is unclean, and says how many", () => {
    const resume = computeResumePoint([interval(100, 199, { status: "incomplete" })], 100);
    expect(resume.resumeAt).toBe(100);
    expect(resume.coveredUpTo).toBeNull();
    expect(resume.reason).toContain("all 1 coverage row(s) are incomplete");
  });

  it("falls back to the creation block when clean coverage starts above it", () => {
    const resume = computeResumePoint([interval(500, 599)], 100);
    expect(resume.resumeAt).toBe(100);
    expect(resume.coveredUpTo).toBeNull();
    expect(resume.reason).toContain("no clean capture covers the contract's creation block 100");
  });
});

describe("decode coverage counts rows, and counts what it could not classify separately", () => {
  const surface = parseEventSurface(EVENT_SURFACE_PATH);
  // A real (chain, address, topic0) from the shipped surface, so the fixture matches the shape of
  // the artifact it stands in for rather than an invented one.
  const known = surface.rows.find((r) => r.topic0 !== null)!;
  const UNKNOWN_TOPIC = "0x" + "ab".repeat(32);

  it("reports zero undecodable when every topic0 is on the surface", () => {
    const groups: DecodeLogGroup[] = [
      { chainId: known.chainId, address: known.proxyAddress, topic0: known.topic0!, rows: 2_649_450 },
    ];
    const report = weightDecodeCoverage(groups, surface);

    expect(report.rowsConsidered).toBe(2_649_450);
    expect(report.rowsUndecodable).toBe(0);
    expect(report.errors).toBe(0);
  });

  it("counts ROWS, not distinct topic0 values", () => {
    const groups: DecodeLogGroup[] = [
      { chainId: known.chainId, address: known.proxyAddress, topic0: known.topic0!, rows: 100 },
      { chainId: known.chainId, address: known.proxyAddress, topic0: UNKNOWN_TOPIC, rows: 35_862 },
    ];
    const report = weightDecodeCoverage(groups, surface);

    expect(report.rowsConsidered).toBe(35_962);
    expect(report.rowsUndecodable).toBe(35_862);
    expect(report.byContract[0].unmatchedTopic0s).toEqual([UNKNOWN_TOPIC]);
  });

  it("never folds an unclassifiable row into the undecodable count", () => {
    // A null topic0 means the ROW is unreadable, not that the event is unknown. Merging the two
    // would let "we could not look" be reported as "we looked and it was fine".
    const groups: DecodeLogGroup[] = [
      { chainId: known.chainId, address: known.proxyAddress, topic0: known.topic0!, rows: 10 },
      { chainId: known.chainId, address: known.proxyAddress, topic0: null, rows: 7 },
    ];
    const report = weightDecodeCoverage(groups, surface);

    expect(report.rowsUndecodable).toBe(0);
    expect(report.errors).toBe(7);
    expect(report.rowsConsidered).toBe(10);
    expect(report.errorDetail.join(" ")).toContain("7 row(s) carry no topic0");
  });

  it("flags an address the surface does not describe at all", () => {
    const groups: DecodeLogGroup[] = [
      { chainId: 50, address: "0x" + "99".repeat(20), topic0: UNKNOWN_TOPIC, rows: 4 },
    ];
    const report = weightDecodeCoverage(groups, surface);

    expect(report.byContract[0].addressHasNoSurface).toBe(true);
    expect(report.rowsUndecodable).toBe(4);
  });

  it("reports nothing rather than zero when there are no rows to classify", () => {
    const report = weightDecodeCoverage([], surface);
    expect(report.byContract).toEqual([]);
    expect(report.rowsConsidered).toBe(0);
    expect(report.errors).toBe(0);
  });
});
