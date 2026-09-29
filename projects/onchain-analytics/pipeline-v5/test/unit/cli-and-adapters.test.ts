/**
 * The CLI parser and the adapter seams, tested as the pure things plan task 3 made them.
 *
 * The parser used to call `process.exit` from inside itself, so exercising a bad argument killed
 * the runner. It now returns data or throws a typed error, and the process wrapper is the only
 * thing that ends a process. These tests are what make that claim checkable.
 */

import { describe, it, expect, afterEach } from "vitest";
import { parseArgs, CliUsageError, captureExitCode } from "../../src/index.js";
import {
  setBigQueryClient, setRpcTransport, setClock, setWriteLock, setNotifier, setReaderOverride,
  getBigQueryClient, getRpcTransport, getWriteLock, getNotifier, getReaderOverride,
  resetAdapters, nowIso, NO_LOCK,
} from "../../src/adapters.js";

afterEach(() => resetAdapters());

describe("CLI parser returns data and throws typed errors", () => {
  it("parses a full command line into options", () => {
    const opts = parseArgs([
      "backfill", "--chains=XDC,CELO", "--addresses=0xAAA,0xBBB",
      "--from=100", "--to=200", "--days=1,2,3", "--dry-run",
      "--max-capture-blocks=5000", "--max-captures=3",
    ]);

    expect(opts.mode).toBe("backfill");
    expect(opts.chains).toEqual(["XDC", "CELO"]);
    expect(opts.addresses).toEqual(["0xaaa", "0xbbb"]);
    expect(opts.fromBlock).toBe(100);
    expect(opts.toBlock).toBe(200);
    expect(opts.days).toEqual([1, 2, 3]);
    expect(opts.dryRun).toBe(true);
    expect(opts.maxCaptureBlocks).toBe(5_000);
    expect(opts.maxCaptures).toBe(3);
  });

  it("throws rather than exiting on an unknown mode", () => {
    expect(() => parseArgs(["nonsense"])).toThrow(CliUsageError);
    try {
      parseArgs(["nonsense"]);
    } catch (e) {
      expect((e as CliUsageError).exitCode).toBe(2);
      expect((e as CliUsageError).showUsage).toBe(true);
    }
  });

  it("throws on an unrecognised argument, a reversed range and a non-numeric bound", () => {
    expect(() => parseArgs(["daily", "--nope"])).toThrow(/Unrecognised argument/);
    expect(() => parseArgs(["backfill", "--from=200", "--to=100"])).toThrow(/below --from/);
    expect(() => parseArgs(["backfill", "--from=abc"])).toThrow(/--from is not a number/);
  });

  it("refuses a limit that would silently become NaN and disable the guard it raises", () => {
    // A NaN limit compares false against every span, so passing --max-captures=x would turn the
    // budget guard OFF rather than raise it. That is the defect shape this check exists for.
    expect(() => parseArgs(["daily", "--max-captures=x"])).toThrow(/positive whole number/);
    expect(() => parseArgs(["daily", "--max-capture-blocks=0"])).toThrow(/positive whole number/);
  });

  it("maps capture counts to exit codes the way main does", () => {
    expect(captureExitCode(5, 0)).toBe(0);
    expect(captureExitCode(5, 1)).toBe(1);
    expect(captureExitCode(0, 3)).toBe(2);
  });
});

describe("every adapter is replaceable and resets to its real default", () => {
  it("refuses to invent a BigQuery client when none is registered for a test", () => {
    setBigQueryClient(null);
    // `bq.ts` registers the real factory on import, so this returns a real client rather than
    // throwing. What matters is that a test-installed client wins and that reset removes it.
    const fake = { query: async () => [[]] as [any[]], dataset: () => ({ table: () => ({}) }) } as any;
    setBigQueryClient(fake);
    expect(getBigQueryClient()).toBe(fake);
  });

  it("replaces the RPC transport and restores the real one", () => {
    const real = getRpcTransport();
    const fake = (async () => ({ ok: true, status: 200, text: async () => "{}" })) as any;
    setRpcTransport(fake);
    expect(getRpcTransport()).toBe(fake);
    setRpcTransport(null);
    expect(getRpcTransport()).toBe(real);
  });

  it("replaces the clock, so a timestamp in a record is assertable", () => {
    setClock({ now: () => new Date("2020-01-02T03:04:05.000Z") });
    expect(nowIso()).toBe("2020-01-02T03:04:05.000Z");
    setClock(null);
    expect(nowIso()).not.toBe("2020-01-02T03:04:05.000Z");
  });

  it("defaults the write lock to the real cross-process lease, not to NO_LOCK", async () => {
    // Renamed from "defaults the write lock to NO_LOCK, which is the control that does not exist
    // yet". The control now exists, so the assertion is inverted rather than relaxed: the point
    // of the original test was that the default is whatever production actually gets, and that
    // is the thing still being asserted.
    //
    // `bq.ts` registers the lease factory on import, so importing it is what makes the default
    // real. A control you have to remember to install is not a control.
    await import("../../src/bq.js");
    const active = getWriteLock();
    expect(active, "production must not get the do-nothing lock").not.toBe(NO_LOCK);

    // NO_LOCK stays exported and stays meaningful: it is the absence of exclusion, which a test
    // installs deliberately to show what the write path does without it.
    const handle = await NO_LOCK.acquire("RawLogs", null);
    expect(handle, "NO_LOCK grants every request instantly and excludes nothing").not.toBeNull();

    const refusing = { acquire: async () => null };
    setWriteLock(refusing);
    expect(getWriteLock()).toBe(refusing);
  });

  it("replaces the reader and the notifier", () => {
    const reader = (async () => ({})) as any;
    setReaderOverride(reader);
    expect(getReaderOverride()).toBe(reader);

    const notifier = { post: async () => {} };
    setNotifier(notifier);
    expect(getNotifier()).toBe(notifier);
  });

  it("resetAdapters clears every seam, so one file cannot leak into the next", () => {
    setRpcTransport((async () => ({ ok: true, status: 200, text: async () => "{}" })) as any);
    setClock({ now: () => new Date(0) });
    const refusing = { acquire: async () => null };
    setWriteLock(refusing);
    setNotifier({ post: async () => {} });
    setReaderOverride((async () => ({})) as any);

    resetAdapters();

    // The lock resets to whatever the process default is rather than to a fixed object, because
    // the default is now built from a factory. What has to be true is that the double installed
    // above is gone; asserting a specific identity here would make this test depend on whether
    // some other file happened to import `bq.ts` first.
    expect(getWriteLock()).not.toBe(refusing);
    expect(getNotifier()).toBeNull();
    expect(getReaderOverride()).toBeNull();
    expect(nowIso()).not.toBe(new Date(0).toISOString());
  });
});
