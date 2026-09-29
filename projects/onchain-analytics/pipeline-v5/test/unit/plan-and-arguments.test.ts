/**
 * Plan mode and argument validation. Plan tasks 7, 8 and 9.
 *
 * TWO THINGS THIS FILE HAS TO PROVE, and they are different in kind.
 *
 *   1. That `plan` is genuinely PURE. Not "does not appear to touch the network" but "cannot":
 *      the BigQuery client and the RPC transport are both replaced with doubles that THROW on
 *      any use, and the plan is built anyway. A purity claim that rests on reading the code is
 *      the same class of evidence as a completeness claim that rests on a scan's own report.
 *
 *   2. That every argument shape plan task 7 names is REFUSED, each with its own assertion, and
 *      that each refusal carries exit code 2. A parser that rejects the wrong thing for the
 *      right reason still lets the defect through.
 */

import { describe, it, expect, afterEach } from "vitest";
import { parseArgs, CliUsageError } from "../../src/index.js";
import { buildPlan, renderPlan, releaseScopeChains } from "../../src/plan.js";
import { RELEASE_SCOPE_FREEZE } from "../../src/control-plane/releaseScope.js";
import { RAW_LOGS_TABLE, TRANSACTIONS_TABLE, NETWORKS } from "../../src/config.js";
import { MAX_CAPTURES_CEILING, MAX_CAPTURE_BLOCKS_CEILING } from "../../src/budget.js";
import { setBigQueryClient, setRpcTransport, setReaderOverride, resetAdapters } from "../../src/adapters.js";

afterEach(() => resetAdapters());

/** Any use at all is a failure, so the double throws instead of answering. */
const EXPLODING_BQ = {
  query: () => { throw new Error("PLAN_MODE_TOUCHED_BIGQUERY"); },
  dataset: () => { throw new Error("PLAN_MODE_TOUCHED_BIGQUERY"); },
} as any;

const EXPLODING_RPC = (() => { throw new Error("PLAN_MODE_TOUCHED_THE_NETWORK"); }) as any;

const EXPLODING_READER = (() => { throw new Error("PLAN_MODE_TOUCHED_A_CHAIN"); }) as any;

function armTheTripwires(): void {
  setBigQueryClient(EXPLODING_BQ);
  setRpcTransport(EXPLODING_RPC);
  setReaderOverride(EXPLODING_READER);
}

describe("plan mode reads no chain and writes no BigQuery", () => {
  it("builds a complete plan for an explicit range with every edge armed to throw", () => {
    armTheTripwires();

    const plan = buildPlan({
      mode: "backfill",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
      fromBlock: 105_201_000,
      toBlock: 105_201_500,
    });

    expect(plan.outcome).toBe("complete");
    expect(plan.exitCode).toBe(0);
    expect(plan.contractsPlanned).toBe(1);
    // One unit per grain. A refusal has to speak about both, so a plan does too.
    expect(plan.units.map((u) => u.grain).sort()).toEqual([RAW_LOGS_TABLE, TRANSACTIONS_TABLE]);
    for (const u of plan.units) {
      expect(u.rangeResolved).toBe(true);
      expect(u.fromBlock).toBe(105_201_000);
      expect(u.toBlock).toBe(105_201_500);
      expect(u.spanVerdict?.allowed).toBe(true);
    }
    expect(renderPlan(plan)).toMatch(/PLAN \(backfill\): COMPLETE, exit 0/);
  });

  it("plans a backfill with no --from from the contract's own creation block", () => {
    armTheTripwires();

    // R8: an absence claim's lower bound is contract creation, and that is knowable from the
    // seed without reading anything. The END is not, so the plan is still incomplete and still
    // exits nonzero. Half a resolvable range does not make a resolvable plan.
    const plan = buildPlan({
      mode: "backfill",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
    });

    expect(plan.outcome).toBe("incomplete");
    expect(plan.units[0].fromBlock).toBeGreaterThan(0);
    expect(plan.units[0].toBlock).toBeNull();
    expect(plan.units[0].rangeSource).toMatch(/start from the contract's creation block \d+/);
    expect(plan.units[0].rangeSource).toMatch(/end at the chain tip minus \d+ finality block/);
  });

  it("calls an unresolvable range INCOMPLETE rather than guessing it", () => {
    armTheTripwires();

    // A daily run's start comes from the coverage ledger and its end from the chain tip. Plan
    // mode reads neither, so the only honest answer is that it cannot say.
    const plan = buildPlan({
      mode: "daily",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
    });

    expect(plan.outcome).toBe("incomplete");
    expect(plan.exitCode).toBe(1);
    expect(plan.units.every((u) => !u.rangeResolved)).toBe(true);
    expect(plan.units[0].fromBlock).toBeNull();
    expect(plan.units[0].rangeSource).toMatch(/coverage frontier, which plan mode does not read/);
    expect(plan.refusals.join(" ")).toMatch(/cannot be resolved without reading/);
  });

  it("reports the budget verdict rather than the refusal's consequences", () => {
    armTheTripwires();

    // Every contract on every chain, against the default limit of 12.
    const plan = buildPlan({ mode: "daily" });

    expect(plan.outcome).toBe("refused");
    expect(plan.exitCode).toBe(2);
    expect(plan.runSize?.allowed).toBe(false);
    expect(plan.runSize?.requested).toBeGreaterThan(plan.runSize!.limit);
    expect(plan.summary.totals.refused).toBe(plan.summary.totals.planned);
    expect(plan.summary.totals.completed).toBe(0);
  });

  it("refuses an explicitly named span above the absolute ceiling", () => {
    armTheTripwires();

    // Naming a range raises the ordinary 30-day limit deliberately. It does not raise the
    // absolute ceiling: a span this size is a genesis-to-head read of the deepest chain in the
    // release, which is A5. Phase 3 made bare backfill illegal, so without this ceiling every
    // backfill would be explicit and therefore unbounded.
    const plan = buildPlan({
      mode: "backfill",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
      fromBlock: 1,
      toBlock: MAX_CAPTURE_BLOCKS_CEILING + 1,
    });

    expect(plan.outcome).toBe("refused");
    expect(plan.exitCode).toBe(2);
    expect(plan.summary.totals.refused).toBe(2);
    expect(plan.refusals.join(" ")).toMatch(/absolute ceiling/);
  });

  it("allows an explicitly named span below the ceiling even above the ordinary limit", () => {
    armTheTripwires();

    const xdc = NETWORKS.XDC;
    const plan = buildPlan({
      mode: "backfill",
      chains: ["XDC"],
      addresses: ["0x22867567e2d80f2049200e25c6f31cb6ec2f0faf"],
      fromBlock: 1,
      // Comfortably above 30 days of XDC blocks, comfortably below the ceiling.
      toBlock: 30 * xdc.blocksPerDay * 3,
    });

    expect(plan.outcome).toBe("complete");
    expect(plan.exitCode).toBe(0);
  });
});

describe("plan mode takes its chain list from the frozen release scope", () => {
  it("reads the scope from the freeze module rather than a list of its own", () => {
    expect(releaseScopeChains()).toEqual([...RELEASE_SCOPE_FREEZE.releaseChains]);
  });

  it("never treats a chain outside the frozen scope as usable", () => {
    armTheTripwires();
    // A property, not a literal list: whatever the freeze says today, nothing outside it may be
    // planned. Fuse was dropped from the release after the scope was first frozen, so a test
    // asserting a fixed set of chains here would have to be edited when the seed catches up.
    const plan = buildPlan({ mode: "daily", maxCaptures: MAX_CAPTURES_CEILING });
    const planned = new Set(plan.units.map((u) => u.network));
    for (const chain of planned) expect(releaseScopeChains()).toContain(chain);
  });

  it("refuses a configured chain the freeze excludes, with the decision record named", () => {
    armTheTripwires();

    // Narrow the scope to XDC alone and watch every other configured chain become unsupported.
    // This is the path a scope change takes through this command, exercised rather than assumed.
    const narrowed = { ...RELEASE_SCOPE_FREEZE, releaseChains: ["XDC"] as const };
    const plan = buildPlan({ mode: "daily", chains: ["CELO"] }, narrowed);

    expect(plan.outcome).toBe("unsupported");
    expect(plan.exitCode).toBe(2);
    expect(plan.refusals.join(" ")).toMatch(/CELO is configured but is NOT in the release scope/);
    expect(plan.refusals.join(" ")).toContain(RELEASE_SCOPE_FREEZE.decisionRecord);
  });

  it("treats every configured chain as usable when the scope is not frozen", () => {
    armTheTripwires();

    // The pre-freeze state, which is legal before a scope decision exists. It must not silently
    // become "everything is out of scope", which is what an unguarded `includes` would do.
    const unfrozen = { ...RELEASE_SCOPE_FREEZE, frozen: false };
    const plan = buildPlan({ mode: "daily", chains: ["CELO"], maxCaptures: 500 }, unfrozen);

    expect(plan.outcome).not.toBe("unsupported");
    expect(plan.contractsPlanned).toBeGreaterThan(0);
  });

  it("renders a refused and an unsupported plan without inventing numbers it does not have", () => {
    armTheTripwires();

    const unsupported = buildPlan({ mode: "daily", chains: ["SOLANA"] });
    const rendered = renderPlan(unsupported);
    expect(rendered).toMatch(/UNSUPPORTED, exit 2/);
    // No chains selected and no budget verdict exists, so neither is printed as a zero.
    expect(rendered).toMatch(/chains selected: \(none\)/);
    expect(rendered).not.toMatch(/run-size budget/);

    // And a plan long enough to be truncated says how many it left out rather than trailing off.
    const big = buildPlan({ mode: "daily", maxCaptures: MAX_CAPTURES_CEILING });
    expect(big.units.length).toBeGreaterThan(40);
    expect(renderPlan(big)).toMatch(/\.\.\. \d+ more unit\(s\)/);
  });
});

describe("arguments plan task 7 says must be refused", () => {
  function usageError(argv: string[]): CliUsageError {
    try {
      parseArgs(argv);
    } catch (e) {
      return e as CliUsageError;
    }
    throw new Error(`parseArgs(${JSON.stringify(argv)}) did not throw`);
  }

  it("refuses an unknown chain instead of selecting nothing", () => {
    const e = usageError(["daily", "--chains=SOLANA"]);
    expect(e.exitCode).toBe(2);
    expect(e.message).toMatch(/Unknown chain\(s\): SOLANA/);
    // The message names what IS configured, from the configuration, not from a list in the error.
    for (const n of Object.values(NETWORKS)) expect(e.message).toContain(n.name);
  });

  it("refuses a one-sided block range on either side", () => {
    expect(usageError(["daily", "--to=100"]).message).toMatch(/--to was given without --from/);
    expect(usageError(["daily", "--from=100"]).message).toMatch(/--from was given without --to/);
    expect(usageError(["daily", "--to=100"]).exitCode).toBe(2);
  });

  it("refuses a bare backfill, which is a full history wearing the name of a range read", () => {
    const e = usageError(["backfill"]);
    expect(e.exitCode).toBe(2);
    expect(e.message).toMatch(/requires an explicit --from and --to/);
  });

  it("accepts a two-sided range and a known chain", () => {
    const opts = parseArgs(["backfill", "--chains=XDC", "--from=1", "--to=2"]);
    expect(opts.fromBlock).toBe(1);
    expect(opts.toBlock).toBe(2);
  });

  it("keeps the existing rejections, which fire before the new ones", () => {
    // Ordering matters: a reversed range and a non-numeric bound must still report themselves
    // rather than being swallowed by the one-sided check that now sits below them.
    expect(() => parseArgs(["backfill", "--from=200", "--to=100"])).toThrow(/below --from/);
    expect(() => parseArgs(["backfill", "--from=abc"])).toThrow(/--from is not a number/);
    expect(() => parseArgs(["nonsense"])).toThrow(CliUsageError);
    expect(() => parseArgs(["daily", "--nope"])).toThrow(/Unrecognised argument/);
  });
});

describe("limits are positive safe integers with an explicit ceiling", () => {
  function usageError(argv: string[]): CliUsageError {
    try {
      parseArgs(argv);
    } catch (e) {
      return e as CliUsageError;
    }
    throw new Error(`parseArgs(${JSON.stringify(argv)}) did not throw`);
  }

  it("refuses a limit that would silently become NaN and disable the guard it raises", () => {
    expect(usageError(["daily", "--max-captures=x"]).message).toMatch(/positive whole number/);
    expect(usageError(["daily", "--max-capture-blocks=0"]).message).toMatch(/positive whole number/);
    expect(usageError(["daily", "--max-captures=-1"]).message).toMatch(/positive whole number/);
  });

  it("refuses a limit above its stated ceiling", () => {
    const e = usageError(["daily", `--max-captures=${MAX_CAPTURES_CEILING + 1}`]);
    expect(e.exitCode).toBe(2);
    expect(e.message).toMatch(/is above the maximum of/);
    expect(usageError(["daily", `--max-capture-blocks=${MAX_CAPTURE_BLOCKS_CEILING + 1}`]).message)
      .toMatch(/is above the maximum of/);
  });

  it("refuses a limit that is not a SAFE integer, which is not the same as not finite", () => {
    // `Number.isFinite(9223372036854775807)` is true and the value is a DIFFERENT integer from
    // the one typed. This project measured exactly that on 134 registry rows, so the check is
    // safe-integer, not finite.
    expect(usageError(["daily", "--max-captures=9223372036854775807"]).message)
      .toMatch(/positive whole number|above the maximum/);
  });

  it("accepts a limit at the ceiling, so the bound is inclusive and stated", () => {
    expect(parseArgs(["daily", `--max-captures=${MAX_CAPTURES_CEILING}`]).maxCaptures)
      .toBe(MAX_CAPTURES_CEILING);
    expect(parseArgs(["daily", `--max-capture-blocks=${MAX_CAPTURE_BLOCKS_CEILING}`]).maxCaptureBlocks)
      .toBe(MAX_CAPTURE_BLOCKS_CEILING);
  });
});
