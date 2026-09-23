/**
 * oracle.ts
 *
 * The contract's own ledger, read as state.
 *
 * Where a quantity is readable as state, read state. The XDC UBIScheme stores per-day claimer
 * counts and per-day distributed amounts in public mappings, and the Invites contract stores
 * lifetime totals. Reading them is deterministic, reproducible at a pinned block forever, and
 * independent of every log index and every endpoint's willingness to answer a log query.
 *
 * This is the whole reason a reconciliation is now possible. Every previous correctness
 * argument in this warehouse compared the warehouse against itself.
 *
 * R1: a state read at head is not a receipt, because head names a different block every time it
 * is used. Every function here takes a numeric block and refuses anything else.
 */

import { consensusRead } from "./rpc.js";
import { log } from "./log.js";
import type { NetworkConfig } from "./types.js";
import { keccak256, toHex } from "viem";

/** Computed at runtime. A recalled selector is a guess with four bytes of confidence. */
const selector = (sig: string): string => keccak256(toHex(sig)).slice(0, 10);

const SEL = {
  getClaimerCount: selector("getClaimerCount(uint256)"),
  getClaimAmount: selector("getClaimAmount(uint256)"),
  periodStart: selector("periodStart()"),
  currentDay: selector("currentDay()"),
  stats: selector("stats()"),
};

const padUint = (n: number | bigint): string => BigInt(n).toString(16).padStart(64, "0");

function requireBlock(block: number): string {
  if (!Number.isInteger(block) || block <= 0) {
    throw new Error(`R1_VIOLATION: a state read must name a numeric block, got ${String(block)}`);
  }
  return "0x" + block.toString(16);
}

export interface Reading<T> {
  ok: boolean;
  value: T | null;
  block: number;
  agreeing: string[];
  errors: string[];
}

async function callAt<T>(
  network: NetworkConfig,
  to: string,
  data: string,
  block: number,
  decode: (hex: string) => T
): Promise<Reading<T>> {
  const tag = requireBlock(block);
  const r = await consensusRead(network, "eth_call", [{ to, data }, tag]);
  if (!r.ok) return { ok: false, value: null, block, agreeing: r.agreeing, errors: r.errors };
  try {
    return { ok: true, value: decode(r.value as string), block, agreeing: r.agreeing, errors: r.errors };
  } catch (e: any) {
    return { ok: false, value: null, block, agreeing: r.agreeing, errors: [...r.errors, `DECODE ${e.message}`] };
  }
}

const decUint = (hex: string): bigint => (!hex || hex === "0x" ? 0n : BigInt(hex));

function decWords(hex: string): bigint[] {
  const body = hex.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(BigInt("0x" + body.slice(i, i + 64)));
  return out;
}

/** The chain head every listed endpoint can already serve, minus a margin. */
export async function pinBlock(network: NetworkConfig, behind = 5): Promise<Reading<number>> {
  const r = await consensusRead(network, "eth_blockNumber", [], 1);
  const heads: number[] = [];
  const errors = [...r.errors];
  for (const a of r.answers) {
    try { heads.push(Number(BigInt(JSON.parse(a.raw)))); } catch { errors.push(`${a.url}: unparsable head`); }
  }
  if (heads.length < 2) {
    return { ok: false, value: null, block: 0, agreeing: [], errors: [...errors, `only ${heads.length} endpoint(s) returned a head, need 2`] };
  }
  const pin = Math.min(...heads) - behind;
  log.info(`Pinned ${network.name} block ${pin}`, { heads, endpoints: r.answers.map((a) => a.url) });
  return { ok: true, value: pin, block: pin, agreeing: r.answers.map((a) => a.url), errors };
}

export const readPeriodStart = (network: NetworkConfig, address: string, block: number) =>
  callAt(network, address, SEL.periodStart, block, (h) => Number(decUint(h)));

export const readCurrentDay = (network: NetworkConfig, address: string, block: number) =>
  callAt(network, address, SEL.currentDay, block, (h) => Number(decUint(h)));

export const readClaimerCount = (network: NetworkConfig, address: string, day: number, block: number) =>
  callAt(network, address, SEL.getClaimerCount + padUint(day), block, (h) => decUint(h));

export const readClaimAmount = (network: NetworkConfig, address: string, day: number, block: number) =>
  callAt(network, address, SEL.getClaimAmount + padUint(day), block, (h) => decUint(h));

export interface InviteStats {
  bountiesPaid: bigint;
  bountyTotalRaw: bigint;
  referralSignups: bigint;
}

export const readInviteStats = (network: NetworkConfig, address: string, block: number) =>
  callAt(network, address, SEL.stats, block, (h): InviteStats => {
    const w = decWords(h);
    if (w.length < 3) throw new Error(`stats() returned ${w.length} words, expected 3`);
    return { bountiesPaid: w[0], bountyTotalRaw: w[1], referralSignups: w[2] };
  });

export interface DayReading {
  day: number;
  ok: boolean;
  claimers: bigint | null;
  amountRaw: bigint | null;
  errors: string[];
}

/**
 * Read the contract's own record for a set of protocol days, at ONE pinned block.
 *
 * Past days are FROZEN, verified on this contract at blocks 1.5 million apart, which is what
 * makes these readings reproducible. The current day is excluded by the caller, never averaged
 * in: a lifetime total read at head could not be reproduced hours later and differed by 2,431
 * claims, and both readings were correct.
 */
export async function readDays(
  network: NetworkConfig,
  address: string,
  days: number[],
  block: number,
  onProgress?: (done: number, total: number) => void
): Promise<DayReading[]> {
  const out: DayReading[] = [];

  for (const day of days) {
    // The two getters are independent reads of the same pinned block, so they go together.
    const [c, a] = await Promise.all([
      readClaimerCount(network, address, day, block),
      readClaimAmount(network, address, day, block),
    ]);
    out.push({
      day,
      ok: c.ok && a.ok,
      claimers: c.value,
      amountRaw: a.value,
      errors: [...c.errors, ...a.errors],
    });
    if (onProgress && (out.length % 25 === 0 || out.length === days.length)) {
      onProgress(out.length, days.length);
    }
  }

  return out;
}

/** Convenience wrapper over an inclusive day span. */
export function readDayRange(
  network: NetworkConfig,
  address: string,
  firstDay: number,
  lastDay: number,
  block: number,
  onProgress?: (done: number, total: number) => void
): Promise<DayReading[]> {
  const days: number[] = [];
  for (let d = firstDay; d <= lastDay; d++) days.push(d);
  return readDays(network, address, days, block, onProgress);
}

/** Protocol day containing a Unix timestamp, on a contract with the given periodStart. */
export const dayOf = (unixSeconds: number, periodStart: number): number =>
  Math.floor((unixSeconds - periodStart) / 86_400);

/** UTC window [start, end) of a protocol day, in Unix seconds. */
export const dayWindow = (day: number, periodStart: number): [number, number] =>
  [periodStart + day * 86_400, periodStart + (day + 1) * 86_400];
