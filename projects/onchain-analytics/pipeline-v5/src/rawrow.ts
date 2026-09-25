/**
 * rawrow.ts -- one log becomes one RawLogs row, one transaction becomes one Transactions row.
 *
 * THIS FILE REPLACES THE DECODERS, IT DOES NOT PORT THEM. Under v3 each contract carried its own
 * ABI, its own column set and its own decodeToRow closure, so a log that matched no expected
 * event was discarded and a new event needed a schema change. Under v4 nothing is matched at
 * ingestion time at all: the selector is stored, the data blob is stored verbatim, and decoding
 * becomes a view over the event_surface seed. That is the strongest available form of L0-3, and
 * it is why there is no ABI anywhere in this module.
 *
 * WHAT THAT BUYS, CONCRETELY. The v3 path counted 'undecodable' logs and dropped them. Every one
 * of those was a real chain event that this warehouse then did not hold, and whether it was kept
 * depended on whether someone had written its ABI down. A wrong ABI has forced a full re-ingest
 * twice here, and a hand-written one with a single wrong parameter type returns a confident zero
 * because the selector changes completely.
 *
 * WHAT IT COSTS, STATED. A row here carries no meaning until something joins it to the event
 * surface. That is the intended trade: a decoding error becomes a view change instead of a
 * re-read from the chain, and on one chain in this set a re-read costs about 55 days at the free
 * quota.
 */

import { eraAt } from "./registry.js";
import { hex, requireHex } from "./normalise.js";
import type { Assurance, ChunkResult, EraMapEntry, SourceKind } from "./types.js";

/** What every row produced from one capture carries in common. L0-6 and L0-7. */
export interface CaptureContext {
  chainId: number;
  captureId: string;
  runId: string;
  sourceKind: SourceKind;
  sourceId: string;
  assurance: Assurance;
  /** Chain head when the capture ran. null where the reader could not report one. */
  headAtCapture: number | null;
  ingestedAt: string;
}

/**
 * Topics as a dense positional array of exactly four slots.
 *
 * Topics are dense on chain: a filled slot above an empty one cannot occur, because the EVM
 * appends them. The readers disagree on rendering though. HyperSync returns a filtered array with
 * nulls removed, and JSON-RPC returns a dense array, so the count has to come from what is
 * actually present rather than from the array's length. The assertion below is not decoration: if
 * a reader ever returns an interior null, silently compacting it would move every topic one slot
 * left and write values into the wrong columns, which no test in this project could see.
 */
function topicSlots(raw: unknown): { slots: (string | null)[]; count: number } {
  const arr = Array.isArray(raw) ? raw : [];
  const present: string[] = [];
  let sawGap = false;
  for (let i = 0; i < 4; i++) {
    const t = arr[i];
    if (typeof t === "string" && t.length > 0) {
      if (sawGap) {
        throw new Error(
          `TOPIC_GAP: the reader returned a topic at slot ${i} above an empty slot. Topics are ` +
          `dense on chain, so compacting this would write values into the wrong columns.`
        );
      }
      present.push(t);
    } else {
      sawGap = true;
    }
  }
  return {
    slots: [0, 1, 2, 3].map((i) => present[i] ?? null),
    count: present.length,
  };
}

/** A uint as a decimal STRING. L0-2: every uint256 is STRING, including values that fit today. */
function uintString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  const s = String(v);
  if (s === "") return null;
  if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s).toString();
  return s;
}

/** An INT64 field. Returns null rather than NaN, because NaN loads as null with no complaint. */
function int(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The first four bytes of calldata, which names the function called.
 *
 * The full calldata is deliberately not stored: it is unbounded in size and re-fetchable per
 * transaction from any archive node. A transaction with no calldata, which is a plain value
 * transfer, has no selector, and null is the honest answer rather than '0x'.
 */
function inputSelector(input: unknown): string | null {
  const s = hex(input);
  if (!s || s.length < 10) return null;
  return s.slice(0, 10);
}

/**
 * Build the RawLogs rows for one chunk.
 *
 * `eras` is the pre-filtered era list for the contract being read, so era resolution is a range
 * comparison per log rather than a scan of the whole seed.
 */
export function rawLogRows(
  chunk: ChunkResult,
  ctx: CaptureContext,
  eras: EraMapEntry[]
): Record<string, any>[] {
  const blockByNumber = new Map<number, any>();
  for (const b of chunk.blocks ?? []) {
    const n = int(b.number);
    if (n !== null) blockByNumber.set(n, b);
  }

  const rows: Record<string, any>[] = [];
  for (const entry of chunk.logs ?? []) {
    const blockNumber = int(entry.blockNumber);
    if (blockNumber === null) {
      throw new Error("RAWROW: a log arrived with no block number, so it cannot be keyed or partitioned");
    }
    const block = blockByNumber.get(blockNumber);
    const tsSeconds = int(block?.timestamp);
    if (tsSeconds === null) {
      // block_timestamp is NOT NULL at L0 and is the partitioning column, so a log whose block
      // timestamp was not returned cannot be written at all. Failing here names the cause. It is
      // never derived from a block rate: one chain in this set changed cadence mid-life.
      throw new Error(
        `RAWROW: block ${blockNumber} returned no timestamp. block_timestamp is the partitioning ` +
        `column and is NOT NULL, and deriving it from a block rate is wrong across a cadence change.`
      );
    }

    const { slots, count } = topicSlots(entry.topics);
    const era = eraAt(eras, blockNumber);

    rows.push({
      chain_id: ctx.chainId,
      block_number: blockNumber,
      block_timestamp: new Date(tsSeconds * 1000).toISOString(),
      block_hash: requireHex(entry.blockHash ?? block?.hash, "block_hash"),
      tx_hash: requireHex(entry.transactionHash, "tx_hash"),
      tx_index: int(entry.transactionIndex) ?? 0,
      log_index: int(entry.logIndex),
      contract_address: requireHex(entry.address, "contract_address"),

      // L0-4. era_map_lookup where the seed covers the block, 'unresolved' where it does not.
      // 'unresolved' is NOT era 1, and the era_index stays NULL alongside it, because a lookup
      // that always returns something turns a missing era into a confident wrong answer.
      implementation_address: era?.implementationAddress ?? null,
      era_index: era?.eraIndex ?? null,
      era_resolution: era ? "era_map_lookup" : "unresolved",

      topic0: slots[0],
      topic1: slots[1],
      topic2: slots[2],
      topic3: slots[3],
      // A capture fact, not a decode. Positional storage alone cannot say whether topic0 holds a
      // selector or an anonymous event's first indexed value, and a NULL topic1 cannot be told
      // from a topic1 that was never emitted.
      topic_count: count,

      // L0-1. Verbatim, including the prefix. An event with no data carries the two characters
      // 0x, so "nothing was captured" can never be confused with "the data section was empty".
      log_data: hex(entry.data) ?? "0x",

      // TRUE or FALSE where the reader reports the field, NULL where it does not report it at
      // all. NOT NULL here would force an unknown to be written as FALSE, which asserts "not
      // removed" while meaning "nobody said".
      removed: typeof entry.removed === "boolean" ? entry.removed : null,

      source_kind: ctx.sourceKind,
      source_id: ctx.sourceId,
      assurance: ctx.assurance,
      confirmations_at_capture: ctx.headAtCapture === null ? null : ctx.headAtCapture - blockNumber,

      capture_id: ctx.captureId,
      ingestion_run_id: ctx.runId,
      ingested_at: ctx.ingestedAt,
    });
  }
  return rows;
}

/**
 * Build the Transactions rows for one chunk.
 *
 * ONE ROW PER TRANSACTION THAT PRODUCED AT LEAST ONE CAPTURED LOG, which is L0-5. The v3 tables
 * carried the sender, value, nonce, status, gas and gas price on every LOG row, so a transaction
 * emitting three captured logs stored its sender three times, and the domain shape hid how often
 * by splitting one transaction's logs across three tables.
 *
 * WHAT IS ABSENT BY CONSTRUCTION, STATED RATHER THAN DISCOVERED LATER. A reverted transaction
 * emits no logs, so it can never be reached by a log filter and can never appear here. Absence
 * from this table means "produced no captured log", never "did not happen". Closing that needs a
 * reader that walks blocks, which is a reader problem and not a schema one.
 */
export function transactionRows(chunk: ChunkResult, ctx: CaptureContext): Record<string, any>[] {
  const blockByNumber = new Map<number, any>();
  for (const b of chunk.blocks ?? []) {
    const n = int(b.number);
    if (n !== null) blockByNumber.set(n, b);
  }

  // Only transactions that actually produced a captured log in this chunk. A reader may return
  // more than that, and writing those would make the table's own definition false.
  const wanted = new Set<string>();
  const blockOfTx = new Map<string, number>();
  for (const entry of chunk.logs ?? []) {
    const h = hex(entry.transactionHash);
    const bn = int(entry.blockNumber);
    if (h && bn !== null) { wanted.add(h); blockOfTx.set(h, bn); }
  }

  const rows: Record<string, any>[] = [];
  const seen = new Set<string>();
  for (const tx of chunk.transactions ?? []) {
    const h = hex(tx.hash);
    if (!h || !wanted.has(h) || seen.has(h)) continue;

    // A transaction's own block number is preferred, because it is what the reader asserts about
    // the transaction. The log's block is the fallback for a reader that omits the field.
    const blockNumber = int(tx.blockNumber) ?? blockOfTx.get(h) ?? null;
    if (blockNumber === null) continue;
    const block = blockByNumber.get(blockNumber);
    const tsSeconds = int(block?.timestamp);
    const blockHash = hex(tx.blockHash ?? block?.hash);
    if (tsSeconds === null || !blockHash) {
      // Same rule as a log: the partitioning column is NOT NULL, so a transaction whose block
      // facts were not returned is skipped and the skip is visible in the count, rather than
      // being written with an invented timestamp.
      continue;
    }

    seen.add(h);
    rows.push({
      chain_id: ctx.chainId,
      block_number: blockNumber,
      block_timestamp: new Date(tsSeconds * 1000).toISOString(),
      block_hash: blockHash,
      tx_hash: h,
      tx_index: int(tx.transactionIndex) ?? 0,

      from_address: requireHex(tx.from, "from_address"),
      to_address: hex(tx.to),
      contract_created: hex(tx.contractAddress),
      value_raw: uintString(tx.value) ?? "0",
      input_selector: inputSelector(tx.input),
      nonce: int(uintString(tx.nonce)),
      // 1 succeeded, 0 reverted. A row here always has at least one log, so 0 would mean the
      // receipt and the logs disagree, which is a finding rather than a value.
      status: int(tx.status),
      gas_used: int(uintString(tx.gasUsed)),
      // The client calls the gas LIMIT `gas`; `gasUsed` is the receipt figure. Taking the wrong
      // one of a similarly named pair is a defect this project has already shipped once.
      gas_limit: int(uintString(tx.gas)),
      effective_gas_price: uintString(tx.effectiveGasPrice),
      // EIP-2718 transaction type. The client calls it `kind`. Batched claims arrive as account
      // abstraction bundles, so the type is how a bundle is told from a direct call.
      tx_type: int(tx.kind),

      source_kind: ctx.sourceKind,
      source_id: ctx.sourceId,
      // Independent of the log's grade on purpose: several endpoints on one chain in this set
      // prune the transaction index, so a transaction can be less assured than the log that
      // pointed at it.
      assurance: ctx.assurance,
      capture_id: ctx.captureId,
      ingestion_run_id: ctx.runId,
      ingested_at: ctx.ingestedAt,
    });
  }

  return rows;
}

/** How many transactions the chunk's logs point at but the reader did not return. */
export function missingTransactionCount(chunk: ChunkResult, produced: number): number {
  const wanted = new Set<string>();
  for (const entry of chunk.logs ?? []) {
    const h = hex(entry.transactionHash);
    if (h) wanted.add(h);
  }
  return Math.max(0, wanted.size - produced);
}
