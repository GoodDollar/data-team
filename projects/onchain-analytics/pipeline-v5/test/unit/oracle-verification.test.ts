/**
 * oracle-verification.test.ts -- the Celo oracle, and what a verification result has to be able
 * to say.
 *
 * THE DEFECT THESE GUARD, IN ONE SENTENCE. `runVerify` returned a boolean, so a run that compared
 * 254 protocol days and matched every one, and a run that compared nothing at all, arrived at the
 * CLI as the same value, and the CLI exited 0 for both. That is C4. It is the same shape as C2 one
 * layer up: the type could not hold the distinction, so no amount of checking inside the function
 * could produce it.
 *
 * THE OTHER HALF IS THE DAY KEY. Both UBIScheme contracts start their protocol day at NOON UTC --
 * measured, `periodStart()` modulo 86,400 is exactly 43,200 on Celo and on XDC. A comparison keyed
 * on `DATE(block_timestamp)` therefore puts every claim made before noon on the wrong side of the
 * boundary, and MEASURED on the real warehouse that is 764,706 of 2,649,450 XDC rows, 28.9 percent.
 * It would not fail loudly. It would produce a plausible near-miss on every single day.
 *
 * WHY THERE IS A PURPOSE-BUILT WAREHOUSE STAND-IN HERE. The shared `BigQuerySimulator` models the
 * MERGE semantics two write-path defects depend on and refuses any statement it does not model,
 * which is the right behaviour and is why it is not extended here. What these tests depend on is a
 * different single semantic: which protocol day a stored row is counted under. So the stand-in
 * below computes the two reconciliation aggregates from rows, with the DAY KEY AS A PARAMETER,
 * which is what makes the calendar key falsifiable rather than merely described. It answers only
 * the statements it recognises and throws on anything else, for the same reason the shared
 * simulator does: a plausible empty answer is a machine for manufacturing false greens.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { keccak256, toHex } from "viem";
import { NETWORKS, ORACLES, oracleFor, oraclesFor } from "../../src/config.js";
import { dayOf, dayWindow } from "../../src/oracle.js";
import { runVerify, topic0Of } from "../../src/reconcile.js";
import { readOnlyExitCode } from "../../src/outcome.js";
import { setBigQueryClient, setRpcTransport, resetAdapters } from "../../src/adapters.js";
import type { BigQueryClientLike } from "../../src/adapters.js";
import { makeWireRecorder } from "../helpers/wire-recorder.js";

const CELO_UBISCHEME = "0x43d72ff17701b2da814620735c39c620ce0ea4a1";
const CELO_PERIOD_START = 1_677_672_000; // MEASURED on chain: 2023-03-01T12:00:00Z
const XDC_PERIOD_START = 1_761_393_600; // MEASURED on chain: 2025-10-25T12:00:00Z
const UBICLAIMED = "UBIClaimed(address,uint256)";

/** Computed, never recalled. A recalled selector is a guess with four bytes of confidence. */
const sel = (sig: string) => keccak256(toHex(sig)).slice(0, 10);
const SEL = {
  periodStart: sel("periodStart()"),
  currentDay: sel("currentDay()"),
  getClaimerCount: sel("getClaimerCount(uint256)"),
  getClaimAmount: sel("getClaimAmount(uint256)"),
};
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const hexWord = (n: bigint | number) => "0x" + word(n);

// --------------------------------------------------------------------------- the day keys

/** What the shipped SQL computes: DIV(UNIX_SECONDS(ts) - periodStart, 86400). */
const protocolDayKey = (unixSeconds: number, periodStart: number) => dayOf(unixSeconds, periodStart);

/**
 * What a calendar key computes: whole UTC days since the calendar date periodStart falls on.
 * This is the `DATE(block_timestamp)` shape, expressed so a test can run the comparison under it.
 */
const calendarDayKey = (unixSeconds: number, periodStart: number) => {
  const midnightOfPeriodStart = Math.floor(periodStart / 86_400) * 86_400;
  return Math.floor((unixSeconds - midnightOfPeriodStart) / 86_400);
};

// --------------------------------------------------------------------------- the stand-in

interface StoredLog { tsSeconds: number; amountRaw: bigint; txHash: string; logIndex: number }

interface WarehouseOptions {
  rows: StoredLog[];
  periodStart: number;
  /** Swap this for `calendarDayKey` to watch the comparison break. */
  dayKey: (unixSeconds: number, periodStart: number) => number;
}

/** Rows loaded into OracleReconciliation, so the stored comparison is inspectable. */
const recorded: Record<string, any>[] = [];
/** Every statement the SHIPPED code emitted, so a test can assert on the real SQL. */
const emittedSql: string[] = [];

function warehouse(options: WarehouseOptions): BigQueryClientLike {
  const key = (r: StoredLog) => options.dayKey(r.tsSeconds, options.periodStart);
  return {
    async query(request) {
      const sql = request.query;
      emittedSql.push(sql);

      if (/MIN\(block_timestamp\) AS lo/i.test(sql)) {
        if (options.rows.length === 0) return [[{ lo: null, hi: null }]];
        const ts = options.rows.map((r) => r.tsSeconds);
        return [[{
          lo: new Date(Math.min(...ts) * 1000).toISOString(),
          hi: new Date(Math.max(...ts) * 1000).toISOString(),
        }]];
      }

      if (/protocol_day/i.test(sql)) {
        const p = (request.params ?? {}) as Record<string, any>;
        const byDay = new Map<number, { n: number; amount: bigint }>();
        for (const r of options.rows) {
          const d = key(r);
          if (d < Number(p.firstDay) || d > Number(p.lastDay)) continue;
          const cur = byDay.get(d) ?? { n: 0, amount: 0n };
          byDay.set(d, { n: cur.n + 1, amount: cur.amount + r.amountRaw });
        }
        return [[...byDay.entries()].map(([d, v]) => ({
          protocol_day: d, stored_rows: v.n, distinct_rows: v.n,
          unreadable_rows: 0, amount_raw: v.amount.toString(),
        }))];
      }

      if (/MAX\(block_timestamp\)\s+AS\s+max_ts/i.test(sql)) return [[{ max_ts: null }]];

      throw new Error(
        `STANDIN_UNRECOGNISED_STATEMENT: answering this with an empty result would manufacture a ` +
        `false green. Statement:\n${sql}`
      );
    },
    dataset() {
      return {
        table() {
          return {
            async load(source: string) {
              // `recordReconciliation` writes newline-delimited JSON to a temp file and loads it.
              const { readFileSync } = await import("node:fs");
              for (const line of readFileSync(source, "utf8").split("\n")) {
                if (line.trim()) recorded.push(JSON.parse(line));
              }
              return [];
            },
            async getMetadata() { return [{}] as any; },
          };
        },
      };
    },
  };
}

/**
 * A chain that answers exactly the four getters this unit reads, from a ledger the test states.
 * Every Celo archive endpoint gets the same answer, which is what `consensusRead` requires.
 */
function chain(options: { periodStart: number; currentDay: number; ledger: Map<number, { claimers: number; amountRaw: bigint }> }) {
  return makeWireRecorder({
    answers: {
      eth_blockNumber: () => "0x" + (30_000_000).toString(16),
      eth_call: (params: unknown[]) => {
        const data = String((params[0] as { data: string }).data);
        if (data.startsWith(SEL.periodStart)) return hexWord(options.periodStart);
        if (data.startsWith(SEL.currentDay)) return hexWord(options.currentDay);
        const day = Number(BigInt("0x" + data.slice(10)));
        const entry = options.ledger.get(day) ?? { claimers: 0, amountRaw: 0n };
        if (data.startsWith(SEL.getClaimerCount)) return hexWord(entry.claimers);
        if (data.startsWith(SEL.getClaimAmount)) return hexWord(entry.amountRaw);
        throw new Error(`unexpected eth_call data ${data}`);
      },
    },
  });
}

/** Noon UTC on protocol day `d`, i.e. the exact instant the day opens. */
const dayStart = (d: number, periodStart: number) => dayWindow(d, periodStart)[0];

beforeEach(() => { recorded.length = 0; emittedSql.length = 0; });
afterEach(() => { resetAdapters(); setBigQueryClient(null); });

// =========================================================================================
describe("the Celo oracle exists and is bound to what the contract actually says", () => {
  it("resolves an oracle for Celo, which ORACLES could not do before", () => {
    const celo = oracleFor(NETWORKS.CELO.chainId, CELO_UBISCHEME);
    expect(
      celo,
      `Celo is half the ingestion scope and ORACLES held two entries, BOTH XDC. Without a Celo ` +
      `entry no Celo figure can ever be reconciled against the chain, and a chain with no oracle ` +
      `cannot return clean, so Celo verify would be permanently nonzero for a reason nobody could fix.`
    ).toBeDefined();
    expect(celo!.kind).toBe("ubi_daily");
    expect(oraclesFor([NETWORKS.CELO]).length).toBeGreaterThan(0);
  });

  it("carries the periodStart the contract returns, to the second", () => {
    const celo = oracleFor(NETWORKS.CELO.chainId, CELO_UBISCHEME)!;
    expect(celo.periodStart).toBe(CELO_PERIOD_START);
    expect(new Date(celo.periodStart * 1000).toISOString()).toBe("2023-03-01T12:00:00.000Z");
  });

  it("puts every UBI oracle's day boundary at noon UTC, which is the whole reason the key matters", () => {
    for (const o of ORACLES.filter((x) => x.kind === "ubi_daily")) {
      expect(
        o.periodStart % 86_400,
        `${o.network.name} ${o.address} starts its protocol day ${o.periodStart % 86_400}s after ` +
        `midnight UTC. Every UBIScheme in scope was MEASURED at exactly 43200, and a day boundary ` +
        `taken from a config file rather than the contract is a claim about a config file.`
      ).toBe(43_200);
    }
  });

  it("binds on a topic0 computed from the signature, matching the shipped event surface", () => {
    // The seed is an INDEPENDENT source for this value: it was recomputed from the verified ABI
    // on 2,823 of 2,823 rows. Agreement between the computed selector and the seed is the check.
    expect(topic0Of(UBICLAIMED)).toBe("0x89ed24731df6b066e4c5186901fffdba18cd9a10f07494aff900bdee260d1304");
    for (const o of ORACLES.filter((x) => x.kind === "ubi_daily")) {
      expect(o.eventSignature).toBe(UBICLAIMED);
      // claimer is the only indexed parameter, so amount is word 0 of log_data.
      expect(o.amountWordIndex).toBe(0);
    }
  });
});

// =========================================================================================
describe("C4: a verification result says what was compared, not just whether it went well", () => {
  it("returns clean ONLY after actually comparing something", async () => {
    const day = 900;
    const ledger = new Map([[day, { claimers: 2, amountRaw: 300n }]]);
    setRpcTransport(chain({ periodStart: CELO_PERIOD_START, currentDay: 1000, ledger }).transport);
    setBigQueryClient(warehouse({
      periodStart: CELO_PERIOD_START,
      dayKey: protocolDayKey,
      rows: [
        { tsSeconds: dayStart(day, CELO_PERIOD_START) + 60, amountRaw: 100n, txHash: "0xa", logIndex: 0 },
        { tsSeconds: dayStart(day, CELO_PERIOD_START) + 120, amountRaw: 200n, txHash: "0xb", logIndex: 0 },
      ],
    }));

    const report = await runVerify({ mode: "verify", chains: ["CELO"], days: [day] });

    expect(report.outcome).toBe("clean");
    expect(report.comparedUnits).toBe(1);
    expect(report.matchedUnits).toBe(1);
    expect(report.discrepantUnits).toBe(0);
    expect(readOnlyExitCode(report.outcome)).toBe(0);
  });

  it("does not return clean when the contract holds a ledger and the warehouse holds nothing", async () => {
    // This is the LIVE state of Celo in this warehouse: the oracle resolves, the contract answers,
    // and not one claim row has been ingested. Before the fix, `reconcileDaily` refused to run at
    // all without a warehouse day span, returned null, and the run still ended clean.
    const day = 900;
    const ledger = new Map([[day, { claimers: 11_743, amountRaw: 1_356_243_042_837_526_291_314_194n }]]);
    setRpcTransport(chain({ periodStart: CELO_PERIOD_START, currentDay: 1000, ledger }).transport);
    setBigQueryClient(warehouse({ periodStart: CELO_PERIOD_START, dayKey: protocolDayKey, rows: [] }));

    const report = await runVerify({ mode: "verify", chains: ["CELO"], days: [day] });

    expect(
      report.outcome,
      `The contract says 11,743 people claimed on protocol day ${day} and the warehouse holds zero ` +
      `rows. That is a finding, and an empty warehouse is a legitimate side of a comparison.`
    ).toBe("finding");
    expect(report.comparedUnits).toBe(1);
    expect(report.matchedUnits).toBe(0);
    expect(report.discrepantUnits).toBe(1);
    expect(report.checks[0].detail).toContain("0/1");
    expect(readOnlyExitCode(report.outcome)).toBe(1);
  });

  it("separates a day that disagrees from a day nobody could look at", async () => {
    const day = 900;
    const ledger = new Map([[day, { claimers: 3, amountRaw: 300n }]]);
    setRpcTransport(chain({ periodStart: CELO_PERIOD_START, currentDay: 1000, ledger }).transport);
    setBigQueryClient(warehouse({
      periodStart: CELO_PERIOD_START,
      dayKey: protocolDayKey,
      rows: [{ tsSeconds: dayStart(day, CELO_PERIOD_START) + 60, amountRaw: 100n, txHash: "0xa", logIndex: 0 }],
    }));

    const report = await runVerify({ mode: "verify", chains: ["CELO"], days: [day] });

    expect(report.outcome).toBe("finding");
    expect(report.discrepantUnits).toBe(1);
    expect(report.unreadableUnits).toBe(0);
    expect(report.checks[0].outcome).toBe("discrepant");
  });

  it("counts a day the oracle could not be read as unreadable, which is not a pass and not a gap", async () => {
    const day = 900;
    // One endpoint answers and two fail, so `consensusRead` cannot reach two agreeing answers.
    const recorder = makeWireRecorder({
      answers: {
        eth_blockNumber: () => "0x" + (30_000_000).toString(16),
        eth_call: (params: unknown[]) => {
          const data = String((params[0] as { data: string }).data);
          if (data.startsWith(SEL.periodStart)) return hexWord(CELO_PERIOD_START);
          if (data.startsWith(SEL.currentDay)) return hexWord(1000);
          return undefined; // no answer for the day getters
        },
      },
    });
    setRpcTransport(recorder.transport);
    setBigQueryClient(warehouse({
      periodStart: CELO_PERIOD_START,
      dayKey: protocolDayKey,
      rows: [{ tsSeconds: dayStart(day, CELO_PERIOD_START) + 60, amountRaw: 100n, txHash: "0xa", logIndex: 0 }],
    }));

    const report = await runVerify({ mode: "verify", chains: ["CELO"], days: [day] });

    expect(
      report.outcome,
      `A day the contract could not be read for is an unanswered question. Reporting it as clean ` +
      `would be the same class of error as C4 itself: an absence presented as a result.`
    ).not.toBe("clean");
    expect(report.unreadableUnits).toBe(1);
    expect(report.matchedUnits).toBe(0);
    expect(report.checks[0].outcome).toBe("unreadable");
  });

  it("stores the per-day comparison so it can be queried afterwards", async () => {
    const days = [900, 901];
    const ledger = new Map([
      [900, { claimers: 1, amountRaw: 100n }],
      [901, { claimers: 5, amountRaw: 999n }],
    ]);
    setRpcTransport(chain({ periodStart: CELO_PERIOD_START, currentDay: 1000, ledger }).transport);
    setBigQueryClient(warehouse({
      periodStart: CELO_PERIOD_START,
      dayKey: protocolDayKey,
      rows: [{ tsSeconds: dayStart(900, CELO_PERIOD_START) + 60, amountRaw: 100n, txHash: "0xa", logIndex: 0 }],
    }));

    await runVerify({ mode: "verify", chains: ["CELO"], days });

    expect(recorded.map((r) => r.protocol_day)).toEqual([900, 901]);
    expect(recorded[0].verdict).toBe("exact");
    expect(recorded[1].verdict).toBe("missing");
    expect(recorded[1].count_gap).toBe(5);
    // The amounts are carried as STRINGS, because a 24-digit raw value is past the point where a
    // JavaScript number is exact and a reconciliation that is not exact is not a reconciliation.
    expect(recorded[1].oracle_amount_raw).toBe("999");
    expect(recorded.every((r) => r.chain_id === NETWORKS.CELO.chainId)).toBe(true);
  });

  it("records an unreadable chain instead of letting it erase the whole run", async () => {
    // A quorum failure on one chain used to throw out of `runVerify` and abort the command, so a
    // completed comparison on another chain would be destroyed on the way out. MEASURED on Celo
    // this session: two of three archive endpoints were unavailable at once and `pinBlock`
    // refused, which is correct and must not also be fatal.
    setRpcTransport(makeWireRecorder({ answers: { eth_blockNumber: () => undefined } }).transport);
    setBigQueryClient(warehouse({ periodStart: CELO_PERIOD_START, dayKey: protocolDayKey, rows: [] }));

    const report = await runVerify({ mode: "verify", chains: ["CELO"], days: [900] });

    expect(report.outcome).toBe("nothing_to_check");
    expect(report.unreadableUnits).toBe(1);
    expect(report.checks[0].outcome).toBe("unreadable");
    expect(report.checks[0].detail).toContain("could not be read");
    expect(readOnlyExitCode(report.outcome)).toBe(2);
  });
});

// =========================================================================================
describe("the protocol day is the contract's, not the calendar's", () => {
  it("assigns a claim made before noon to a different day under each key", () => {
    // 09:00 UTC on the calendar date that protocol day 900 opens. The protocol day that contains
    // this instant opened at noon the PREVIOUS calendar date.
    const beforeNoon = dayStart(900, CELO_PERIOD_START) - 3 * 3_600;
    expect(protocolDayKey(beforeNoon, CELO_PERIOD_START)).toBe(899);
    expect(calendarDayKey(beforeNoon, CELO_PERIOD_START)).toBe(900);

    const afterNoon = dayStart(900, CELO_PERIOD_START) + 3 * 3_600;
    expect(protocolDayKey(afterNoon, CELO_PERIOD_START)).toBe(900);
    expect(calendarDayKey(afterNoon, CELO_PERIOD_START)).toBe(900);
  });

  it("splits one protocol day across two calendar days on both chains in scope", () => {
    for (const periodStart of [CELO_PERIOD_START, XDC_PERIOD_START]) {
      const [open] = dayWindow(500, periodStart);
      const beforeMidnight = open + 6 * 3_600; // 18:00 UTC, same calendar date
      const afterMidnight = open + 18 * 3_600; // 06:00 UTC, the NEXT calendar date
      expect(protocolDayKey(beforeMidnight, periodStart)).toBe(500);
      expect(protocolDayKey(afterMidnight, periodStart)).toBe(500);
      expect(new Date(beforeMidnight * 1000).toISOString().slice(0, 10))
        .not.toBe(new Date(afterMidnight * 1000).toISOString().slice(0, 10));
    }
  });

  it("RECONCILES EXACTLY on the protocol day key and FAILS on the calendar key, same rows", async () => {
    // The discriminator. Two claims on protocol day 900, one either side of midnight UTC, which
    // is the ordinary case rather than an edge: a protocol day always spans two calendar dates.
    // The contract's own ledger says day 900 had two claimers and 300 raw units.
    const open = dayStart(900, CELO_PERIOD_START);
    const rows: StoredLog[] = [
      { tsSeconds: open + 6 * 3_600, amountRaw: 100n, txHash: "0xa", logIndex: 0 },
      { tsSeconds: open + 18 * 3_600, amountRaw: 200n, txHash: "0xb", logIndex: 0 },
    ];
    const ledger = new Map([[900, { claimers: 2, amountRaw: 300n }]]);

    setRpcTransport(chain({ periodStart: CELO_PERIOD_START, currentDay: 1000, ledger }).transport);
    setBigQueryClient(warehouse({ periodStart: CELO_PERIOD_START, dayKey: protocolDayKey, rows }));
    const onProtocolDay = await runVerify({ mode: "verify", chains: ["CELO"], days: [900] });

    resetAdapters();
    setRpcTransport(chain({ periodStart: CELO_PERIOD_START, currentDay: 1000, ledger }).transport);
    setBigQueryClient(warehouse({ periodStart: CELO_PERIOD_START, dayKey: calendarDayKey, rows }));
    const onCalendarDay = await runVerify({ mode: "verify", chains: ["CELO"], days: [900] });

    expect(onProtocolDay.outcome).toBe("clean");
    expect(onProtocolDay.matchedUnits).toBe(1);

    expect(
      onCalendarDay.outcome,
      `Keyed on the calendar date, the same two rows and the same contract ledger do NOT ` +
      `reconcile: the claim made before midnight lands on one key and the claim made after it on ` +
      `another, so day 900 reports a shortfall it does not have. If this assertion cannot be made ` +
      `to fail on the calendar key, the keying under test is not the contract's.`
    ).toBe("finding");
    expect(onCalendarDay.matchedUnits).toBe(0);
    expect(onCalendarDay.discrepantUnits).toBe(1);
  });

  it("emits SQL that derives the day from periodStart, and never from the row's calendar date", async () => {
    // The two tests above prove the SEMANTICS discriminate. This one binds that to the statement
    // the SHIPPED code actually sends, so a future rewrite to `DATE(block_timestamp)` -- which
    // would look tidier and read more naturally -- fails here instead of quietly producing a
    // near-miss on every day.
    const ledger = new Map([[900, { claimers: 1, amountRaw: 100n }]]);
    setRpcTransport(chain({ periodStart: CELO_PERIOD_START, currentDay: 1000, ledger }).transport);
    setBigQueryClient(warehouse({
      periodStart: CELO_PERIOD_START,
      dayKey: protocolDayKey,
      rows: [{ tsSeconds: dayStart(900, CELO_PERIOD_START) + 60, amountRaw: 100n, txHash: "0xa", logIndex: 0 }],
    }));

    await runVerify({ mode: "verify", chains: ["CELO"], days: [900] });

    const dayQuery = emittedSql.find((s) => /protocol_day/i.test(s));
    expect(dayQuery, "the reconciliation never issued its per-day aggregate").toBeDefined();
    expect(
      dayQuery,
      `The per-day aggregate must subtract periodStart before dividing into days. Without that ` +
      `subtraction the key is a calendar day, and both contracts open their day at noon UTC.`
    ).toMatch(/DIV\(UNIX_SECONDS\(\w*\.?block_timestamp\) - @periodStart, 86400\)/);
    expect(
      dayQuery,
      `A DATE(block_timestamp) key silently reassigns every claim made before noon. MEASURED on ` +
      `the real warehouse: 764,706 of 2,649,450 XDC rows, 28.9 percent.`
    ).not.toMatch(/DATE\(\w*\.?block_timestamp\)/);
  });
});
