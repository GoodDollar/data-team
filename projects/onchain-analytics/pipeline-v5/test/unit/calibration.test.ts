/**
 * calibration.test.ts -- the module that measures a source's false-zero rate.
 *
 * WHY THIS MODULE MATTERS ENOUGH TO TEST. It is the only thing in this pipeline that measures
 * whether a reader can be believed. The stop rule it replaced was "stop when two consecutive
 * passes add nothing", which fired falsely twice on one range: the identical query on the
 * identical endpoint measured a 0.30 miss rate one day and 0.70 the next, so no fixed pass count
 * bounds anything. Everything here exists to turn that into a number measured in session.
 *
 * Until now only its pure summariser was exercised, and the three functions that actually drive a
 * reader and an endpoint were not covered at all -- in the module whose subject is whether a
 * reader is lying. These tests install a scripted reader and a scripted endpoint, so the
 * repetition, the per-endpoint isolation and the error accounting are all exercised without
 * reaching a network.
 */

import { describe, it, expect, afterEach } from "vitest";
import { runCalibrate, __testing } from "../../src/calibrate.js";
import { setReaderOverride, setRpcTransport, resetAdapters } from "../../src/adapters.js";
import { makeWireRecorder } from "../helpers/wire-recorder.js";
import { hash32 } from "../helpers/fixtures.js";

const XDC_CONTRACT = "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf";

afterEach(() => resetAdapters());

/** A reader that returns a scripted log count per pass, and reports incompleteness on demand. */
function scriptedReader(perPass: (number | "incomplete")[]): () => number {
  let pass = 0;
  setReaderOverride(async (_n, _addresses, from, to) => {
    const scripted = perPass[Math.min(pass, perPass.length - 1)];
    pass += 1;
    const incomplete = scripted === "incomplete";
    return {
      fromBlock: from, toBlock: to,
      chunksPlanned: 1, chunksOk: incomplete ? 0 : 1,
      skipped: incomplete ? [[from, to]] : [],
      errors: incomplete ? ["scripted failure"] : [],
      emptyChunks: [], logsSeen: incomplete ? 0 : (scripted as number),
      complete: !incomplete,
      sourceKind: "index", sourceId: "hypersync:xdc.hypersync.xyz",
      enumeratingSources: 1, headAtCapture: to + 100, rollbackGuards: [],
    } as any;
  });
  return () => pass;
}

/** An endpoint whose `eth_getLogs` answer is scripted per URL, so one endpoint can drop answers. */
function scriptedEndpoints(logsByUrl: (url: string, call: number) => number): void {
  const callsByUrl = new Map<string, number>();
  setRpcTransport(makeWireRecorder({
    answers: {
      eth_getLogs: (_params: unknown[], url: string) => {
        const n = (callsByUrl.get(url) ?? 0) + 1;
        callsByUrl.set(url, n);
        return logsOf(logsByUrl(url, n));
      },
    },
  }).transport);
}

function logsOf(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    address: XDC_CONTRACT, blockNumber: "0x1", blockHash: hash32(`b${i}`),
    transactionHash: hash32(`t${i}`), transactionIndex: "0x0",
    logIndex: `0x${i.toString(16)}`, topics: [hash32("topic0")], data: "0x", removed: false,
  }));
}

describe("the miss rate is measured, never assumed", () => {
  it("reports a consistent source as consistent WITH its repeat count, not as proven", async () => {
    // The distinction is the whole point. "No short answer in 4 repeats" is a fact about this
    // session; "this source is reliable" is a claim about the source, and this module is
    // deliberately not allowed to make it.
    const clean = __testing.summarise("src", "CELO", 1, 100, [10, 10, 10, 10], 0);

    expect(clean.p).toBe(0);
    expect(clean.kForOnePercent).toBe(1);
    expect(clean.verdict).toContain("4 repeats");
    expect(
      clean.verdict,
      "a clean calibration must say what it is a fact ABOUT, or it reads as a guarantee"
    ).toContain("fact about this session");
  });

  it("derives the pass count a repetition rule would need from the measured rate", async () => {
    // At p = 0.5 a stop rule needs ceil(log 0.01 / log 0.5) = 7 consecutive zero-gain passes to
    // stop falsely less than one time in a hundred. The five-pass rule this replaced would stop
    // falsely about three times in a hundred at that rate.
    const half = __testing.summarise("src", "CELO", 1, 100, [10, 10, 0, 0], 0);
    expect(half.p).toBe(0.5);
    expect(half.kForOnePercent).toBe(7);

    // A quarter short needs four.
    const quarter = __testing.summarise("src", "CELO", 1, 100, [10, 10, 10, 0], 0);
    expect(quarter.p).toBe(0.25);
    expect(quarter.kForOnePercent).toBe(4);
  });

  it("MEASURES SHORTNESS AGAINST THE MODE, so a source that is usually zero reads as consistent", () => {
    // Pinned because it is surprising and it is load-bearing, not because it is wrong.
    //
    // `p` is the share of passes that returned FEWER than the modal answer. When most passes
    // return zero, zero IS the mode, nothing is below it, and p comes out 0 -- the same value a
    // perfectly consistent source produces. The two are told apart by `zeroAnswers`, which is
    // why that field is counted separately rather than folded into the rate.
    //
    // This is safe HERE because the module is advisory: the pipeline never decides anything from
    // repetition, it refuses short collections outright and confirms every empty range against an
    // independent source. It would not be safe in anything that read `p` alone as a verdict, so
    // the behaviour is asserted where a future reader will find it.
    const mostlyZero = __testing.summarise("src", "CELO", 1, 100, [10, 0, 0, 0], 0);

    expect(mostlyZero.modeAnswer, "zero is the most frequent answer, so zero is the mode").toBe(0);
    expect(mostlyZero.shortAnswers, "nothing is below zero").toBe(0);
    expect(mostlyZero.p).toBe(0);
    expect(
      mostlyZero.zeroAnswers,
      "the zero count is what distinguishes this from a genuinely consistent source"
    ).toBe(3);
  });

  it("calls a source that answered nothing UNUSABLE, and does not divide by its zero answers", async () => {
    const dead = __testing.summarise("src", "CELO", 1, 100, [], 5);
    expect(dead.modeAnswer).toBeNull();
    expect(dead.p, "no answer at all is a miss rate of one, not a division by zero").toBe(1);
    expect(dead.kForOnePercent).toBeNull();
    expect(dead.verdict).toContain("UNUSABLE");
    expect(dead.repeats, "the repeats count must include the passes that errored").toBe(5);
  });

  it("counts a ZERO answer separately from an error, because only one of them is visible", async () => {
    // A 14-day scan once reported zero skipped chunks while holding 12 of 26 real logs. An error
    // announces itself; a confident zero does not, and conflating them is what hid that.
    const mixed = __testing.summarise("src", "CELO", 1, 100, [26, 26, 0], 2);
    expect(mixed.zeroAnswers).toBe(1);
    expect(mixed.errors).toBe(2);
    expect(mixed.shortAnswers, "a zero is short, and so is any answer below the mode").toBe(1);
    expect(mixed.repeats).toBe(5);
  });
});

describe("calibration drives every source and keeps their results apart", () => {
  it("repeats the query against the primary reader and reports what each pass returned", async () => {
    const passes = scriptedReader([12, 12, 12]);
    scriptedEndpoints(() => 12);

    const allConsistent = await runCalibrate({
      mode: "calibrate", chains: ["XDC"], addresses: [XDC_CONTRACT],
      fromBlock: 100_000_000, toBlock: 100_000_100,
    } as any);

    expect(passes(), "the primary reader must be asked more than once").toBeGreaterThan(1);
    expect(allConsistent, "every source answered on every pass").toBe(true);
  });

  it("reports NOT every source answering when the primary reader returns incomplete every pass", async () => {
    scriptedReader(["incomplete"]);
    scriptedEndpoints(() => 12);

    const allConsistent = await runCalibrate({
      mode: "calibrate", chains: ["XDC"], addresses: [XDC_CONTRACT],
      fromBlock: 100_000_000, toBlock: 100_000_100,
    } as any);

    expect(
      allConsistent,
      "a reader that never completed a pass is not a source that answered"
    ).toBe(false);
  });

  it("probes each endpoint SEPARATELY, so one endpoint dropping answers cannot hide in a union", async () => {
    // This is the property the whole module turns on. Probing several endpoints together
    // measures their union, and the union hides exactly the endpoint the rule exists to find.
    const seen = new Set<string>();
    scriptedReader([12, 12, 12]);
    setRpcTransport(makeWireRecorder({
      answers: {
        eth_getLogs: (_params: unknown[], url: string) => {
          seen.add(url);
          // One endpoint returns nothing while the others return the real answer.
          return logsOf(url.includes("public-rpc") ? 0 : 12);
        },
      },
    }).transport);

    await runCalibrate({
      mode: "calibrate", chains: ["XDC"], addresses: [XDC_CONTRACT],
      fromBlock: 100_000_000, toBlock: 100_000_100,
    } as any);

    expect(
      seen.size,
      `Only ${seen.size} endpoint(s) were probed. Calibration must ask each one on its own, or ` +
      `the endpoint returning zero is averaged away by the ones that answered.`
    ).toBeGreaterThan(1);
  });

  it("returns without reaching a reader when the chain selection matches no contract", async () => {
    let touched = false;
    setReaderOverride(async () => { touched = true; return {} as any; });

    const result = await runCalibrate({
      mode: "calibrate", chains: ["XDC"], addresses: ["0x0000000000000000000000000000000000000000"],
    } as any);

    expect(touched, "no target means nothing to calibrate, not a read of the whole chain").toBe(false);
    expect(result, "vacuously true: every one of no sources answered").toBe(true);
  });
});
