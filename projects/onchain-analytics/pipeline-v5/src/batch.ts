/**
 * batch.ts -- project one batched capture down to per-target results.
 *
 * FINDING H2. The readers have always accepted a LIST of addresses; the pipeline only ever handed
 * them one. `fetchRange(network, [target.address], ...)` sat inside a loop over targets, so a
 * chain with 52 contracts issued 52 separate chunk streams over overlapping block ranges, and the
 * cost plan the project is budgeted against assumes one batched address query per chain range.
 * The measured multiplier is in this unit's report, re-derived from the shipped seed.
 *
 * THE PART THAT IS EASY TO GET WRONG, and the reason this is a module with its own tests rather
 * than a few lines inside the capture loop: batching changes how a result is ATTRIBUTED. One
 * query answering for 52 addresses still has to produce 52 coverage rows, each describing that
 * contract's own declared range, and a chunk that failed has to be recorded against exactly the
 * contracts whose range it overlaps -- not against all of them, and not against none. Closing H2
 * by simply widening the address list would trade a cost defect for a coverage defect, which is
 * the worse of the two: cost is visible on a bill and a wrong coverage row is not visible at all.
 *
 * So the batched range is the UNION of the group's ranges, and every per-target figure is derived
 * by projecting that union back onto the target's own interval. A target is never told about a
 * block it did not ask for, and never told a range is clean when the chunk covering it failed.
 */

import type { ChunkResult, FetchResult } from "./types.js";

/** One contract's own declared capture interval inside a batched read. */
export interface BatchMember {
  /** Lowercase contract address. Matching is on the normalised form, never the raw spelling. */
  address: string;
  fromBlock: number;
  toBlock: number;
}

/** Inclusive interval overlap. */
export function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

/** The union interval a group of members must be read over, or null for an empty group. */
export function unionRange(members: BatchMember[]): { fromBlock: number; toBlock: number } | null {
  if (members.length === 0) return null;
  return {
    fromBlock: Math.min(...members.map((m) => m.fromBlock)),
    toBlock: Math.max(...members.map((m) => m.toBlock)),
  };
}

/**
 * Narrow one batched chunk to what a single member actually asked for.
 *
 * TWO filters, and both are load bearing:
 *   ADDRESS, because the chunk holds every member's logs and a row must be attributed to the
 *   contract that emitted it.
 *   BLOCK RANGE, because the batched read spans the union of the group and a member whose
 *   interval starts later did not ask for the blocks below it. Attributing an early log to a
 *   member that declares no coverage there would put a row in the table under a capture whose
 *   coverage row says that range was never read.
 *
 * Transactions and blocks are narrowed to those the surviving logs actually point at. A batched
 * chunk carries the transactions of every member, and copying all of them onto each member would
 * make the Transactions table's own definition -- one row per transaction that produced at least
 * one CAPTURED log -- false for every member but the one that emitted it.
 */
export function projectChunk(chunk: ChunkResult, member: BatchMember): ChunkResult {
  const address = member.address.toLowerCase();
  const logs = (chunk.logs ?? []).filter((l) => {
    const bn = Number(l.blockNumber);
    return String(l.address).toLowerCase() === address &&
      Number.isFinite(bn) && bn >= member.fromBlock && bn <= member.toBlock;
  });

  const wantedTx = new Set(logs.map((l) => String(l.transactionHash).toLowerCase()));
  const wantedBlocks = new Set(logs.map((l) => Number(l.blockNumber)));

  return {
    ...chunk,
    // The chunk's own bounds are narrowed to the member's interval so that anything reading the
    // projected chunk's range sees what this member was actually read over.
    fromBlock: Math.max(chunk.fromBlock, member.fromBlock),
    toBlock: Math.min(chunk.toBlock, member.toBlock),
    logs,
    transactions: (chunk.transactions ?? []).filter((t) => wantedTx.has(String(t.hash).toLowerCase())),
    blocks: (chunk.blocks ?? []).filter((b) => wantedBlocks.has(Number(b.number))),
  };
}

/**
 * Project the batched FetchResult onto one member's interval.
 *
 * WHAT EACH FIELD MEANS AFTER PROJECTION, stated because a plausible-looking wrong answer here is
 * invisible downstream:
 *
 *   `chunksPlanned` / `chunksOk` count only the chunks that OVERLAP this member. A member whose
 *   contract was created late did not have 145,000 chunks planned for it.
 *   `skipped` keeps only the overlapping failures, CLIPPED to the member's interval, because the
 *   member's coverage row describes the member's range and a skip recorded outside it would be
 *   read as a hole in ground the member never claimed.
 *   `complete` is false when any chunk overlapping this member failed. A failure elsewhere in the
 *   union does not make this member incomplete, and a failure inside it is not excused by the
 *   other members' success.
 *   `emptyChunks` is recomputed by the caller from the projected chunks, never inherited: a
 *   batched chunk holding another contract's logs is NOT empty for the batch but IS empty for
 *   this member, and that is a negative this member has to confirm.
 *   `logsSeen` likewise counts this member's logs, not the batch's.
 *   `rollbackGuards` are carried whole. A guard is a statement by the reader about the blocks it
 *   is holding, which is a property of the chain and the moment, not of one address.
 */
export function projectFetchResult(
  fetch: FetchResult,
  member: BatchMember,
  chunkRanges: [number, number][],
  perMember: { logsSeen: number; emptyChunks: [number, number][] }
): FetchResult {
  const mine = chunkRanges.filter(([a, b]) => overlaps(a, b, member.fromBlock, member.toBlock));
  const skipped = fetch.skipped
    .filter(([a, b]) => overlaps(a, b, member.fromBlock, member.toBlock))
    .map(([a, b]) => [Math.max(a, member.fromBlock), Math.min(b, member.toBlock)] as [number, number]);

  // A chunk that failed is reported by range, so an error line is attributed by asking whether
  // the range it names overlaps this member. An error carrying no range is kept for everyone,
  // because dropping an unattributable error silently is how an error count reaches zero while
  // something is still wrong.
  const errors = fetch.errors.filter((e) => {
    const m = /(\d+)\.\.(\d+)/.exec(e);
    return m === null || overlaps(Number(m[1]), Number(m[2]), member.fromBlock, member.toBlock);
  });

  return {
    ...fetch,
    fromBlock: member.fromBlock,
    toBlock: member.toBlock,
    chunksPlanned: mine.length,
    chunksOk: mine.length - skipped.length,
    skipped,
    errors,
    emptyChunks: perMember.emptyChunks,
    logsSeen: perMember.logsSeen,
    complete: skipped.length === 0,
  };
}
