/**
 * reconcile.ts
 *
 * The external check. Every correctness argument this warehouse had before 2026-09-23 compared
 * the warehouse against itself, including the one that drove a shipped production fix. A
 * uniqueness assertion proves a table does not repeat a key. It cannot prove the table holds
 * what the chain produced, and the difference between those two statements is four claims that
 * nothing detected for four months.
 *
 * What this does: reads the contract's own per-day ledger at ONE pinned block, reads the
 * warehouse for the same days, and reports every day where they disagree, in counts and in raw
 * units. A day that reconciles to the wei is evidence. A day that does not names its gap.
 *
 * Two properties make it reproducible rather than a moving target:
 *   Past protocol days are FROZEN on this contract, verified at blocks 1.5 million apart.
 *   The current protocol day is excluded, always. A lifetime total read at head could not be
 *   reproduced hours later and differed by 2,431 claims, and both readings were correct.
 *
 * The first and last day the warehouse covers are partial by construction, because the window
 * is open at both ends. They are reported separately rather than averaged in.
 */

import { oraclesFor, selectedNetworks, RAW_LOGS_TABLE } from "./config.js";
import type { OracleConfig } from "./config.js";
import { releaseScopedNetworks } from "./registry.js";
import type { ReadOnlyOutcome } from "./outcome.js";
import { log, RUN_ID } from "./log.js";
import {
  pinBlock, readDays, readPeriodStart, readCurrentDay, readInviteStats, dayOf,
} from "./oracle.js";
import { warehouseDailyTotals, recordReconciliation, getMaxBlockTimestamp, bqQuery, allHistory } from "./bq.js";
import { keccak256, toHex } from "viem";
import type { PipelineOpts } from "./types.js";

/**
 * The event selector, COMPUTED from a signature, never recalled.
 *
 * L0-3 binds on topic0 and never on an event name, and that is not a style rule. The GD token
 * declares two different events both named Transfer, a three argument and a four argument form,
 * with different selectors. A hand-written ABI with one wrong parameter type changes the selector
 * completely, so a topic-filtered query on it finds precisely zero matches forever with no error,
 * which is indistinguishable from a genuinely inactive contract. That has already produced a
 * false "confirmed zero activity" finding in this project.
 */
export const topic0Of = (signature: string): string => keccak256(toHex(signature));

export interface DayVerdict {
  day: number;
  oracleCount: number;
  oracleAmountRaw: bigint;
  storedRows: number;
  distinctRows: number;
  warehouseAmountRaw: bigint;
  unreadableRows: number;
  countGap: number;
  amountGapRaw: bigint;
  verdict: "exact" | "missing" | "duplicated" | "surplus" | "oracle_unreadable" | "amount_unreadable";
}

export interface ReconcileResult {
  chainId: number;
  network: string;
  contractAddress: string;
  pinnedBlock: number;
  firstDay: number;
  lastDay: number;
  interiorDays: number;
  exactDays: number;
  days: DayVerdict[];
  /** The warehouse's own first and last covered day, or empty when the caller named the days. */
  edgeDays: number[];
  oracleErrors: string[];
  clean: boolean;
}

/**
 * The protocol days the warehouse actually covers, from the stored block timestamps.
 *
 * Reads through the all-history view: a MIN and MAX over a contract's whole history has no
 * natural window, which is exactly the shape require_partition_filter refuses.
 */
async function warehouseDaySpan(
  chainId: number,
  contractAddress: string,
  topic0: string,
  periodStart: number
): Promise<{ first: number; last: number } | null> {
  const rows = await bqQuery(
    `SELECT MIN(block_timestamp) AS lo, MAX(block_timestamp) AS hi
     FROM ${allHistory(RAW_LOGS_TABLE)}
     WHERE chain_id = @chainId AND contract_address = @address AND topic0 = @topic0`,
    { chainId, address: contractAddress.toLowerCase(), topic0: topic0.toLowerCase() }
  );
  const lo = rows[0]?.lo, hi = rows[0]?.hi;
  if (!lo || !hi) return null;
  const loSec = Math.floor(new Date(lo.value ?? lo).getTime() / 1000);
  const hiSec = Math.floor(new Date(hi.value ?? hi).getTime() / 1000);
  return { first: dayOf(loSec, periodStart), last: dayOf(hiSec, periodStart) };
}

/**
 * Reconcile one daily-ledger contract against its own onchain record.
 *
 * `days` limits the check to named protocol days, which is what makes a targeted re-check after
 * a repair cheap. Omit it to check the whole warehouse window.
 */
export async function reconcileDaily(
  oracle: OracleConfig,
  days?: number[]
): Promise<ReconcileResult | null> {
  if (oracle.kind !== "ubi_daily") return null;
  const network = oracle.network;
  const topic0 = topic0Of(oracle.eventSignature);

  const pin = await pinBlock(network);
  if (!pin.ok || pin.value === null) {
    throw new Error(`Cannot pin a block on ${network.name}: ${pin.errors.join("; ")}`);
  }
  const block = pin.value;

  // The contract's own periodStart, read rather than assumed. A day boundary taken from a
  // config file is a claim about a config file.
  const ps = await readPeriodStart(network, oracle.address, block);
  if (!ps.ok || ps.value === null) {
    throw new Error(`Cannot read periodStart() on ${oracle.address}: ${ps.errors.join("; ")}`);
  }
  if (ps.value !== oracle.periodStart) {
    log.warn(`periodStart() is ${ps.value}, config says ${oracle.periodStart}. Using the contract.`);
  }
  const periodStart = ps.value;

  const cd = await readCurrentDay(network, oracle.address, block);
  const currentDay = cd.ok && cd.value !== null ? cd.value : null;

  // Interior days only, unless the caller named days explicitly. The first and last day the
  // warehouse covers are partial by construction and would show a false gap.
  //
  // A NAMED DAY RANGE DOES NOT NEED A WAREHOUSE SPAN, and requiring one was C4's shape at this
  // level. The span exists to derive a window from stored rows; when the caller supplies the
  // window, asking the warehouse to justify it means a contract the warehouse holds nothing for
  // can never be checked -- which is precisely the case where the answer matters most, and is
  // the live state of Celo in this warehouse today. An empty warehouse is a legitimate side of a
  // comparison: the contract says N, we hold 0, and that is a result.
  let wantedDays: number[];
  let span: { first: number; last: number } | null = null;

  if (days && days.length > 0) {
    wantedDays = [...new Set(days)].sort((a, b) => a - b);
  } else {
    span = await warehouseDaySpan(oracle.network.chainId, oracle.address, topic0, periodStart);
    if (!span) {
      log.warn(`${RAW_LOGS_TABLE} holds no ${oracle.eventSignature} rows for ${oracle.address} and no days were named, so there is no window to reconcile over`);
      return null;
    }
    wantedDays = [];
    for (let d = span.first + 1; d <= span.last - 1; d++) wantedDays.push(d);
  }
  if (currentDay !== null) {
    const before = wantedDays.length;
    wantedDays = wantedDays.filter((d) => d < currentDay);
    if (wantedDays.length !== before) {
      log.warn(`Excluding protocol day ${currentDay} and later: still accumulating`);
    }
  }
  if (wantedDays.length === 0) {
    log.warn(`No frozen days to reconcile for ${oracle.address} on ${network.name}`);
    return null;
  }
  const firstDay = wantedDays[0];
  const lastDay = wantedDays[wantedDays.length - 1];

  log.info(
    `Reconciling ${oracle.address} on ${network.name}, ${wantedDays.length} protocol day(s) in ` +
    `${firstDay}..${lastDay} at block ${block}`,
    { pinnedBlock: block, periodStart, currentDay, topic0 }
  );

  const oracleDays = await readDays(
    network, oracle.address, wantedDays, block,
    (done, total) => log.info(`  oracle ${done}/${total} days`)
  );
  const warehouse = await warehouseDailyTotals(
    network.chainId, oracle.address, topic0, periodStart, oracle.amountWordIndex, firstDay, lastDay
  );

  const verdicts: DayVerdict[] = [];
  const oracleErrors: string[] = [];

  for (const od of oracleDays) {
    const w = warehouse.get(od.day) ?? { stored: 0, distinct: 0, amountRaw: 0n, unreadable: 0 };

    if (!od.ok || od.claimers === null || od.amountRaw === null) {
      oracleErrors.push(`day ${od.day}: ${od.errors.join("; ")}`);
      verdicts.push({
        day: od.day, oracleCount: -1, oracleAmountRaw: 0n,
        storedRows: w.stored, distinctRows: w.distinct, warehouseAmountRaw: w.amountRaw,
        unreadableRows: w.unreadable,
        countGap: 0, amountGapRaw: 0n, verdict: "oracle_unreadable",
      });
      continue;
    }

    const oracleCount = Number(od.claimers);
    const countGap = oracleCount - w.distinct;
    const amountGap = od.amountRaw - w.amountRaw;

    let verdict: DayVerdict["verdict"];
    // A value that could not be decoded out of log_data is NOT a zero. Summing it as one would
    // report a false amount gap, or worse, hide a real one.
    if (w.unreadable > 0) verdict = "amount_unreadable";
    else if (countGap === 0 && amountGap === 0n && w.stored === w.distinct) verdict = "exact";
    else if (countGap > 0) verdict = "missing";
    else if (countGap < 0) verdict = "surplus";
    else verdict = "duplicated";

    verdicts.push({
      day: od.day, oracleCount, oracleAmountRaw: od.amountRaw,
      storedRows: w.stored, distinctRows: w.distinct, warehouseAmountRaw: w.amountRaw,
      unreadableRows: w.unreadable,
      countGap, amountGapRaw: amountGap, verdict,
    });
  }

  const exact = verdicts.filter((v) => v.verdict === "exact").length;
  const result: ReconcileResult = {
    chainId: network.chainId, network: network.name, contractAddress: oracle.address,
    pinnedBlock: block,
    firstDay, lastDay, interiorDays: verdicts.length, exactDays: exact,
    days: verdicts, edgeDays: span ? [span.first, span.last] : [],
    oracleErrors,
    clean: verdicts.length > 0 && exact === verdicts.length && oracleErrors.length === 0,
  };

  await recordReconciliation(verdicts.map((v) => ({
    run_id: RUN_ID,
    chain_id: network.chainId,
    network: network.name,
    contract_address: oracle.address,
    protocol_day: v.day,
    oracle_block: block,
    oracle_count: v.oracleCount,
    oracle_amount_raw: v.oracleAmountRaw.toString(),
    warehouse_stored: v.storedRows,
    warehouse_distinct: v.distinctRows,
    warehouse_amount_raw: v.warehouseAmountRaw.toString(),
    count_gap: v.countGap,
    amount_gap_raw: v.amountGapRaw.toString(),
    verdict: v.verdict,
    checked_at: new Date().toISOString(),
  })));

  return result;
}

export interface StatsVerdict {
  chainId: number;
  network: string;
  contractAddress: string;
  pinnedBlock: number;
  windowStartBlock: number;
  windowEndBlock: number;
  bountiesAtStart: bigint;
  bountiesAtEnd: bigint;
  bountyDelta: bigint;
  warehouseBountyRows: number;
  warehouseDistinctBounties: number;
  gap: number;
  clean: boolean;
  errors: string[];
}

/**
 * Reconcile the invite bounty logs against the contract's lifetime counters.
 *
 * stats() is cumulative, so the warehouse's own block window is isolated by subtraction: read
 * the counter at the block before the first stored event and at the last stored event. No log
 * query appears anywhere in this chain of evidence.
 *
 * The rows are selected by computed topic0 rather than by an event_name column, because there is
 * no event_name column any more and because binding on a name is what L0-3 forbids.
 */
export async function reconcileInviteStats(oracle: OracleConfig): Promise<StatsVerdict | null> {
  if (oracle.kind !== "invites_stats") return null;
  const network = oracle.network;
  const topic0 = topic0Of(oracle.eventSignature);

  const rows = await bqQuery(
    `SELECT MIN(block_number) AS lo, MAX(block_number) AS hi,
            COUNT(*) AS bounty_rows,
            COUNT(DISTINCT FORMAT('%s|%d', tx_hash, log_index)) AS bounty_keys
     FROM ${allHistory(RAW_LOGS_TABLE)}
     WHERE chain_id = @chainId AND contract_address = @address AND topic0 = @topic0`,
    { chainId: network.chainId, address: oracle.address, topic0 }
  );
  if (!rows[0]?.lo) {
    log.warn(`${RAW_LOGS_TABLE} holds no ${oracle.eventSignature} rows for ${oracle.address}; nothing to reconcile`);
    return null;
  }

  const windowStartBlock = Number(rows[0].lo) - 1;
  const windowEndBlock = Number(rows[0].hi);

  const pin = await pinBlock(network);
  const errors: string[] = [];

  const start = await readInviteStats(network, oracle.address, windowStartBlock);
  const end = await readInviteStats(network, oracle.address, windowEndBlock);
  if (!start.ok) errors.push(`stats() at ${windowStartBlock}: ${start.errors.join("; ")}`);
  if (!end.ok) errors.push(`stats() at ${windowEndBlock}: ${end.errors.join("; ")}`);
  if (!start.ok || !end.ok || !start.value || !end.value) {
    return {
      chainId: network.chainId, network: network.name, contractAddress: oracle.address,
      pinnedBlock: pin.value ?? 0,
      windowStartBlock, windowEndBlock,
      bountiesAtStart: 0n, bountiesAtEnd: 0n, bountyDelta: 0n,
      warehouseBountyRows: Number(rows[0].bounty_rows ?? 0),
      warehouseDistinctBounties: Number(rows[0].bounty_keys ?? 0),
      gap: 0, clean: false, errors,
    };
  }

  const delta = end.value.bountiesPaid - start.value.bountiesPaid;
  const distinct = Number(rows[0].bounty_keys ?? 0);
  const gap = Number(delta) - distinct;

  return {
    chainId: network.chainId, network: network.name, contractAddress: oracle.address,
    pinnedBlock: pin.value ?? 0,
    windowStartBlock, windowEndBlock,
    bountiesAtStart: start.value.bountiesPaid,
    bountiesAtEnd: end.value.bountiesPaid,
    bountyDelta: delta,
    warehouseBountyRows: Number(rows[0].bounty_rows ?? 0),
    warehouseDistinctBounties: distinct,
    gap,
    clean: gap === 0 && Number(rows[0].bounty_rows ?? 0) === distinct,
    errors,
  };
}

/**
 * What one oracle contributed to a verification.
 *
 * `comparedUnits` is the load-bearing field: it is the count of things that were actually put
 * side by side with the chain. A protocol day for a daily ledger, a block window for a lifetime
 * counter. Zero means no evidence was produced, whatever else the row says.
 */
export interface OracleCheck {
  chainId: number;
  network: string;
  contractAddress: string;
  kind: OracleConfig["kind"];
  comparedUnits: number;
  matchedUnits: number;
  discrepantUnits: number;
  /** Units the oracle itself could not be read for. Not a pass and not a discrepancy. */
  unreadableUnits: number;
  outcome: "exact" | "discrepant" | "nothing_to_compare" | "unreadable";
  detail: string;
}

/**
 * The result of a verification run, which is a measurement and not a verdict.
 *
 * A boolean could not distinguish "compared 254 protocol days, all matched" from "compared
 * nothing", and those need opposite responses. So the report carries the counts, and `outcome`
 * is DERIVED from them by one rule stated in `finish()` rather than accumulated by a flag that
 * any branch can forget to clear.
 */
export interface VerificationReport {
  outcome: ReadOnlyOutcome;
  chainsSelected: string[];
  chainsWithNoOracle: string[];
  oraclesSelected: number;
  checks: OracleCheck[];
  comparedUnits: number;
  matchedUnits: number;
  discrepantUnits: number;
  unreadableUnits: number;
  /** Oracles that produced no comparison at all. */
  oraclesWithNothingToCompare: number;
  summary: string;
}

const emptyReport = (): VerificationReport => ({
  outcome: "nothing_to_check",
  chainsSelected: [],
  chainsWithNoOracle: [],
  oraclesSelected: 0,
  checks: [],
  comparedUnits: 0,
  matchedUnits: 0,
  discrepantUnits: 0,
  unreadableUnits: 0,
  oraclesWithNothingToCompare: 0,
  summary: "",
});

const nothingCompared = (oracle: OracleConfig, detail: string): OracleCheck => ({
  chainId: oracle.network.chainId,
  network: oracle.network.name,
  contractAddress: oracle.address,
  kind: oracle.kind,
  comparedUnits: 0,
  matchedUnits: 0,
  discrepantUnits: 0,
  unreadableUnits: 0,
  outcome: "nothing_to_compare",
  detail,
});

function dailyCheck(oracle: OracleConfig, r: ReconcileResult): OracleCheck {
  const unreadable = r.days.filter((d) => d.verdict === "oracle_unreadable").length;
  const discrepant = r.days.filter((d) => d.verdict !== "exact" && d.verdict !== "oracle_unreadable").length;
  return {
    chainId: r.chainId,
    network: r.network,
    contractAddress: r.contractAddress,
    kind: oracle.kind,
    comparedUnits: r.interiorDays,
    matchedUnits: r.exactDays,
    discrepantUnits: discrepant,
    unreadableUnits: unreadable,
    outcome: r.interiorDays === 0 ? "nothing_to_compare"
      : unreadable > 0 ? "unreadable"
      : discrepant > 0 ? "discrepant"
      : "exact",
    detail:
      `${r.exactDays}/${r.interiorDays} protocol days exact in ${r.firstDay}..${r.lastDay} ` +
      `at block ${r.pinnedBlock}` +
      (discrepant > 0 ? `, ${discrepant} discrepant` : "") +
      (unreadable > 0 ? `, ${unreadable} the oracle could not be read for` : ""),
  };
}

function statsCheck(oracle: OracleConfig, r: StatsVerdict): OracleCheck {
  // A lifetime counter compared over one block window is ONE comparison, not one per bounty.
  // Counting it as `gap` units would let a large gap look like a large amount of evidence.
  const unreadable = r.errors.length > 0 ? 1 : 0;
  return {
    chainId: r.chainId,
    network: r.network,
    contractAddress: r.contractAddress,
    kind: oracle.kind,
    comparedUnits: unreadable ? 0 : 1,
    matchedUnits: !unreadable && r.clean ? 1 : 0,
    discrepantUnits: !unreadable && !r.clean ? 1 : 0,
    unreadableUnits: unreadable,
    outcome: unreadable ? "unreadable" : r.clean ? "exact" : "discrepant",
    detail:
      `contract counted ${r.bountyDelta} bounties over blocks ${r.windowStartBlock}..${r.windowEndBlock}, ` +
      `warehouse holds ${r.warehouseDistinctBounties} distinct (${r.warehouseBountyRows} stored), gap ${r.gap}`,
  };
}

/**
 * The one place the outcome is decided, from the counts rather than from a flag.
 *
 * `clean` REQUIRES `comparedUnits > 0`. That single conjunct is finding C4: without it, every
 * path that compares nothing falls through to success, and there are three such paths.
 */
function finish(report: VerificationReport): VerificationReport {
  for (const c of report.checks) {
    report.comparedUnits += c.comparedUnits;
    report.matchedUnits += c.matchedUnits;
    report.discrepantUnits += c.discrepantUnits;
    report.unreadableUnits += c.unreadableUnits;
    if (c.outcome === "nothing_to_compare") report.oraclesWithNothingToCompare++;
  }

  if (report.comparedUnits === 0) {
    report.outcome = "nothing_to_check";
    report.summary =
      report.oraclesSelected === 0
        ? `no oracle exists on [${report.chainsSelected.join(", ") || "no chain"}], so nothing was compared`
        : `${report.oraclesSelected} oracle(s) selected but nothing was compared`;
  } else if (report.unreadableUnits > 0 || report.oraclesWithNothingToCompare > 0) {
    // Partial evidence is a finding, never a pass. A day the contract could not be read for is
    // an unanswered question, and an oracle that compared nothing is a silent half of the scope.
    report.outcome = "finding";
    report.summary =
      `${report.matchedUnits}/${report.comparedUnits} compared units matched, ` +
      `${report.discrepantUnits} disagreed, ${report.unreadableUnits} could not be read, ` +
      `${report.oraclesWithNothingToCompare} oracle(s) compared nothing`;
  } else if (report.discrepantUnits > 0) {
    report.outcome = "finding";
    report.summary = `${report.matchedUnits}/${report.comparedUnits} compared units matched, ${report.discrepantUnits} disagreed`;
  } else {
    report.outcome = "clean";
    report.summary = `${report.matchedUnits}/${report.comparedUnits} compared units matched against the contract`;
  }

  log.info(`verify: ${report.outcome} -- ${report.summary}`);
  return report;
}

/**
 * The verify mode. Returns WHAT WAS COMPARED, not whether it went well.
 *
 * TWO CONTRACTS OUT OF 146 PUBLISH A USABLE LEDGER, and that is stated here rather than implied
 * by silence. This is the only EXTERNAL evidence this warehouse has, and it covers about 1.4
 * percent of its surface. Coverage, which covers all of it, is a different question and is
 * answered by the coverage mode.
 *
 * C4 WAS THE RETURN TYPE, not a missing check. This function used to return `boolean`, so
 * "compared 254 protocol days and every one matched" and "compared nothing at all" arrived at
 * the caller as the same value `true`, and the CLI mapped both to exit 0. Three paths reached
 * that `true` without comparing anything: a chain with no oracle, a contract the warehouse holds
 * no rows for, and a window with no frozen day in it. An `if` on any one of them leaves the other
 * two, which is why the fix is the type. Same shape as C2 one layer up.
 *
 * The rule the type enforces, in one sentence: **a run is clean only when it compared something.**
 */
export async function runVerify(opts: PipelineOpts): Promise<VerificationReport> {
  const report = emptyReport();
  const selected = releaseScopedNetworks(selectedNetworks(opts.chains));
  report.chainsSelected = selected.map((n) => n.name);

  // DECIDED-4, the scope leak Unit 1 named: this used to read `oraclesFor(selectedNetworks(...))`
  // with no release-scope filter. It was inert only while ORACLES held XDC entries alone, and
  // this unit adds Celo, which is exactly the change that would have made it bite.
  const oracles = oraclesFor(selected);
  report.oraclesSelected = oracles.length;
  report.chainsWithNoOracle = selected
    .filter((n) => !oracles.some((o) => o.network.chainId === n.chainId))
    .map((n) => n.name);

  if (oracles.length === 0) {
    const named = report.chainsSelected.join(", ") || "none";
    log.warn(
      `No contract oracle exists on the selected chain(s) [${named}], so NOTHING was compared ` +
      `against the chain. That is not a clean result; it is the absence of a result.`
    );
    return finish(report);
  }

  for (const oracle of oracles) {
    const label = `${oracle.address} on ${oracle.network.name}`;

    // One chain's endpoints having a bad minute must not erase another chain's result. A throw
    // here used to abort the whole command, so a Celo quorum failure would have destroyed a
    // completed XDC comparison on the way out. An oracle that could not be read is recorded as
    // unreadable, which is a finding rather than a pass, and the loop continues.
    try {
      await checkOracle(oracle, opts, report);
    } catch (e: any) {
      log.error(`${label}: could not be read: ${e.message}`);
      report.checks.push({
        ...nothingCompared(oracle, `could not be read: ${e.message}`),
        unreadableUnits: 1,
        outcome: "unreadable",
      });
    }
  }

  return finish(report);
}

/** One oracle's contribution, appended to the report. Throws only on an unreadable chain. */
async function checkOracle(oracle: OracleConfig, opts: PipelineOpts, report: VerificationReport): Promise<void> {
  const label = `${oracle.address} on ${oracle.network.name}`;

  if (oracle.kind === "ubi_daily") {
    const r = await reconcileDaily(oracle, opts.days);
    if (!r) {
      // The warehouse holds no rows for this contract, or the window contains no frozen day.
      // Before the type existed this was a `continue` and the run still ended clean, which is
      // C4 one layer down and is the live state of Celo in this warehouse today.
      report.checks.push(nothingCompared(oracle, "the warehouse holds no rows for this contract, or the window contains no frozen protocol day"));
      log.warn(`${label}: nothing could be compared, so this chain contributes no evidence either way`);
      return;
    }
    const bad = r.days.filter((d) => d.verdict !== "exact");
    log.info(
      `${label}: ${r.exactDays}/${r.interiorDays} protocol days reconcile exactly at block ${r.pinnedBlock}`
    );
    for (const d of bad.slice(0, 50)) {
      log.error(
        `  day ${d.day} ${d.verdict}: contract ${d.oracleCount}, warehouse ${d.distinctRows} distinct ` +
        `(${d.storedRows} stored), count gap ${d.countGap}, amount gap ${d.amountGapRaw} raw units` +
        (d.unreadableRows > 0 ? `, ${d.unreadableRows} row(s) whose amount could not be decoded` : "")
      );
    }
    if (r.oracleErrors.length > 0) {
      log.error(`  ${r.oracleErrors.length} day(s) the oracle could not be read, which is not a pass`);
    }
    if (r.edgeDays.length === 2) {
      log.info(`  edge days ${r.edgeDays.join(" and ")} are partial by construction and excluded`);
    }
    report.checks.push(dailyCheck(oracle, r));
  }

  if (oracle.kind === "invites_stats") {
    const r = await reconcileInviteStats(oracle);
    if (!r) {
      report.checks.push(nothingCompared(oracle, "the warehouse holds no bounty rows for this contract"));
      log.warn(`${label}: nothing could be compared, so this chain contributes no evidence either way`);
      return;
    }
    log.info(
      `${label}: contract counted ${r.bountyDelta} bounties over blocks ` +
      `${r.windowStartBlock}..${r.windowEndBlock}, warehouse holds ${r.warehouseDistinctBounties} distinct ` +
      `(${r.warehouseBountyRows} stored)`
    );
    if (!r.clean) {
      log.error(`  gap ${r.gap}, phantom rows ${r.warehouseBountyRows - r.warehouseDistinctBounties}`);
      for (const e of r.errors) log.error(`  ${e}`);
    }
    report.checks.push(statsCheck(oracle, r));
  }

  const maxTs = await getMaxBlockTimestamp(RAW_LOGS_TABLE, oracle.network.chainId);
  if (maxTs) log.info(`  newest block_timestamp on chain ${oracle.network.chainId}: ${maxTs.toISOString()}`);
}
