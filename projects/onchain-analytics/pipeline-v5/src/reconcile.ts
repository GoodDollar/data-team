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

  const span = await warehouseDaySpan(oracle.network.chainId, oracle.address, topic0, periodStart);
  if (!span) {
    log.warn(`${RAW_LOGS_TABLE} holds no ${oracle.eventSignature} rows for ${oracle.address}; nothing to reconcile`);
    return null;
  }

  // Interior days only, unless the caller named days explicitly. The first and last day the
  // warehouse covers are partial by construction and would show a false gap.
  let wantedDays: number[];
  if (days && days.length > 0) {
    wantedDays = [...new Set(days)].sort((a, b) => a - b);
  } else {
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
    days: verdicts, edgeDays: [span.first, span.last],
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
 * The verify mode. Returns true when everything reconciles.
 *
 * TWO CONTRACTS OUT OF 146 PUBLISH A USABLE LEDGER, and that is stated here rather than implied
 * by silence. This is the only EXTERNAL evidence this warehouse has, and it covers about 1.4
 * percent of its surface. Coverage, which covers all of it, is a different question and is
 * answered by the coverage mode.
 */
export async function runVerify(opts: PipelineOpts): Promise<boolean> {
  let clean = true;
  const oracles = oraclesFor(selectedNetworks(opts.chains));

  if (oracles.length === 0) {
    log.warn(`No contract oracle exists on the selected chain(s), so nothing can be checked against the chain here`);
    return true;
  }

  for (const oracle of oracles) {
    const label = `${oracle.address} on ${oracle.network.name}`;

    if (oracle.kind === "ubi_daily") {
      const r = await reconcileDaily(oracle, opts.days);
      if (!r) continue;
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
      log.info(`  edge days ${r.edgeDays.join(" and ")} are partial by construction and excluded`);
      if (!r.clean) clean = false;
    }

    if (oracle.kind === "invites_stats") {
      const r = await reconcileInviteStats(oracle);
      if (!r) continue;
      log.info(
        `${label}: contract counted ${r.bountyDelta} bounties over blocks ` +
        `${r.windowStartBlock}..${r.windowEndBlock}, warehouse holds ${r.warehouseDistinctBounties} distinct ` +
        `(${r.warehouseBountyRows} stored)`
      );
      if (!r.clean) {
        log.error(`  gap ${r.gap}, phantom rows ${r.warehouseBountyRows - r.warehouseDistinctBounties}`);
        for (const e of r.errors) log.error(`  ${e}`);
        clean = false;
      }
    }

    const maxTs = await getMaxBlockTimestamp(RAW_LOGS_TABLE, oracle.network.chainId);
    if (maxTs) log.info(`  newest block_timestamp on chain ${oracle.network.chainId}: ${maxTs.toISOString()}`);
  }

  return clean;
}
