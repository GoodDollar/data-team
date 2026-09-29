/**
 * fixtures.ts -- synthetic rows and intervals, built from the shapes the live tables actually use.
 *
 * Every default here is taken from a measured fact rather than invented: chain 50 is XDC, the
 * block range 105,201,000..105,201,500 is the exact range the audit's two concurrent processes
 * captured for `C1`, and the merge keys are the ones `config.ts` declares. A fixture built from
 * imagination tests imagination.
 */

import { RAW_LOGS_SCHEMA, TRANSACTIONS_SCHEMA } from "../../src/config.js";
import type { CaptureInterval } from "../../src/coverage.js";

export const XDC_CHAIN_ID = 50;

/** The exact range from the C1 runtime receipt in the readiness audit. */
export const C1_RANGE = { from: 105_201_000, to: 105_201_500 };

export const RAW_LOGS_COLUMNS = RAW_LOGS_SCHEMA.map((f) => f.name);
export const TRANSACTIONS_COLUMNS = TRANSACTIONS_SCHEMA.map((f) => f.name);

let txCounter = 0;

/**
 * A 32-byte lowercase hex identifier derived from a seed.
 *
 * Hex, not the seed padded with zeros. Lowercase matters because the merge key refuses mixed
 * case, and being genuinely hex matters because assertions on the wire check the shape of what
 * goes out, and a fixture that is not a valid hash would fail them for the fixture's reason.
 */
export function hash32(seed: number | string): string {
  return "0x" + Buffer.from(String(seed), "utf8").toString("hex").padStart(64, "0").slice(-64);
}

export interface RawLogOverrides {
  chainId?: number;
  blockNumber?: number;
  blockTimestamp?: string;
  blockHash?: string;
  txHash?: string;
  logIndex?: number;
  contractAddress?: string;
  captureId?: string;
  runId?: string;
}

/** One RawLogs row, complete against the shipping schema so nothing fails on a missing column. */
export function rawLogRow(o: RawLogOverrides = {}): Record<string, any> {
  const n = ++txCounter;
  const blockNumber = o.blockNumber ?? C1_RANGE.from + n;
  return {
    chain_id: o.chainId ?? XDC_CHAIN_ID,
    block_number: blockNumber,
    block_timestamp: o.blockTimestamp ?? "2026-06-15T12:00:00.000Z",
    block_hash: o.blockHash ?? hash32(`b${blockNumber}`),
    tx_hash: o.txHash ?? hash32(`t${n}`),
    tx_index: 0,
    log_index: o.logIndex ?? 0,
    contract_address: o.contractAddress ?? "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf",
    implementation_address: null,
    era_index: null,
    era_resolution: "unresolved",
    topic0: hash32("topic0"),
    topic1: null,
    topic2: null,
    topic3: null,
    topic_count: 1,
    log_data: "0x",
    removed: false,
    source_kind: "index",
    source_id: "hypersync:xdc",
    assurance: "C",
    confirmations_at_capture: 64,
    capture_id: o.captureId ?? "capture-test",
    ingestion_run_id: o.runId ?? "run-test",
    ingested_at: "2026-09-28T00:00:00.000Z",
  };
}

export function transactionRow(o: RawLogOverrides = {}): Record<string, any> {
  const base = rawLogRow(o);
  return {
    chain_id: base.chain_id,
    block_number: base.block_number,
    block_timestamp: base.block_timestamp,
    block_hash: base.block_hash,
    tx_hash: base.tx_hash,
    tx_index: base.tx_index,
    from_address: "0x0000000000000000000000000000000000000001",
    to_address: base.contract_address,
    contract_created: null,
    value_raw: "0",
    input_selector: "0x00000000",
    nonce: 1,
    status: 1,
    gas_used: 21_000,
    gas_limit: 21_000,
    effective_gas_price: "1",
    tx_type: 2,
    source_kind: base.source_kind,
    source_id: base.source_id,
    assurance: base.assurance,
    capture_id: base.capture_id,
    ingestion_run_id: base.ingestion_run_id,
    ingested_at: base.ingested_at,
  };
}

/** A coverage interval as `coverage.ts` consumes it. Clean unless told otherwise. */
export function interval(
  fromBlock: number,
  toBlock: number,
  o: Partial<CaptureInterval> = {}
): CaptureInterval {
  return {
    fromBlock,
    toBlock,
    status: "complete",
    skipped: [],
    captureId: `capture-${fromBlock}-${toBlock}`,
    runId: "run-test",
    startedAt: "2026-09-28T00:00:00Z",
    ...o,
  };
}
