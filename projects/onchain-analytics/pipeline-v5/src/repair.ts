/**
 * repair.ts
 *
 * Two operations on history. MERGE prevents new damage; it does nothing about damage already
 * written, and both kinds exist in this warehouse.
 *
 *   dedup   Collapses repeated natural keys. 43,000 phantom claim rows and 2,167 phantom invite
 *           rows were written by the predecessor's append path re-running a block range four
 *           months apart. Once this has run and the pipeline holds, the dbt staging QUALIFY
 *           de-duplication is a bandage on a healed wound.
 *
 *   repair  Re-ingests the block ranges the contract oracle says are short. The four missing
 *           claims are not recoverable by de-duplicating anything: they were never written.
 *           The days are identified by reconciliation rather than by guesswork, the block range
 *           for each day is derived from the day's UTC window, and the re-ingest goes through
 *           the same MERGE as any other write, so running it twice changes nothing the second
 *           time.
 */

import { CONTRACTS, oracleFor } from "./config.js";
import { log, RUN_ID } from "./log.js";
import { dedupTable, duplicateReport, stageAndMerge, recordCoverage, bqQuery } from "./bq.js";
import { fullTableName } from "./config.js";
import { fetchRange } from "./hypersync.js";
import { confirmEmptyRange } from "./rpc.js";
import { reconcileDaily } from "./reconcile.js";
import { readPeriodStart, pinBlock, dayWindow } from "./oracle.js";
import { decodeEventLog } from "viem";
import type { PipelineOpts, ContractConfig, LogContext, NetworkConfig } from "./types.js";

/** Collapse repeated keys on every table this pipeline owns. */
export async function runDedup(opts: PipelineOpts): Promise<boolean> {
  let clean = true;

  for (const cfg of CONTRACTS) {
    if (opts.contracts && !opts.contracts.includes(cfg.tableId)) continue;
    for (const binding of cfg.networkBindings) {
      const r = await dedupTable(cfg.tableId, binding.network.name, !!opts.dryRun);
      if (opts.dryRun) {
        log.info(
          `[dry run] ${cfg.tableId}/${binding.network.name}: ${r.before.storedRows} stored, ` +
          `${r.before.distinctKeys} distinct, ${r.before.phantomRows} phantom` +
          (r.before.phantomRows > 0 ? `, blocks ${r.before.minBlock}..${r.before.maxBlock}` : "")
        );
        if (r.before.phantomRows > 0) clean = false;
        continue;
      }
      if (r.after && r.after.phantomRows > 0) {
        log.error(`${cfg.tableId}/${binding.network.name}: ${r.after.phantomRows} phantom row(s) survived de-duplication`);
        clean = false;
      }
    }
  }

  return clean;
}

/**
 * Find the block range a protocol day occupies, by asking the chain rather than the warehouse.
 *
 * Deriving the range from the stored rows is what hid the omission in the first place: a row
 * missing at a day edge sits outside a window computed from the rows that are present. The
 * range here is anchored on the stored rows and then widened by a margin on both sides, and
 * the widening is deliberate over-coverage, which MERGE makes free.
 */
async function dayBlockRange(
  tableId: string,
  networkName: string,
  day: number,
  periodStart: number,
  marginBlocks: number
): Promise<{ from: number; to: number } | null> {
  const [start, end] = dayWindow(day, periodStart);
  const rows = await bqQuery(
    `SELECT MIN(block_number) AS lo, MAX(block_number) AS hi
     FROM ${fullTableName(tableId)}
     WHERE network = @network
       AND block_timestamp >= TIMESTAMP_SECONDS(@start)
       AND block_timestamp <  TIMESTAMP_SECONDS(@end)`,
    { network: networkName, start, end }
  );
  if (!rows[0]?.lo) return null;
  return {
    from: Math.max(0, Number(rows[0].lo) - marginBlocks),
    to: Number(rows[0].hi) + marginBlocks,
  };
}

/** Decode and MERGE one block range for one binding. Shared by repair and by targeted backfill. */
async function reingestRange(
  cfg: ContractConfig,
  network: NetworkConfig,
  contracts: string[],
  fromBlock: number,
  toBlock: number
): Promise<{ inserted: number; updated: number; complete: boolean; detail: string }> {
  const startedAt = new Date().toISOString();
  let buffer: Record<string, any>[] = [];
  let lastBlockInBuffer = -1;
  let inserted = 0;
  let updated = 0;
  let distinct = 0;
  let reorgSuspects = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    const r = await stageAndMerge(cfg.tableId, buffer, cfg.schema, RUN_ID);
    inserted += r.inserted;
    updated += r.updated;
    distinct += r.distinct;
    reorgSuspects += r.reorgSuspects;
    buffer = [];
  };

  const fetch = await fetchRange(network, contracts, fromBlock, toBlock, async (chunk) => {
    const txByHash = new Map<string, any>();
    for (const tx of chunk.transactions ?? []) {
      const h = String(tx.hash ?? "").toLowerCase();
      if (h) txByHash.set(h, tx);
    }
    const blockByNumber = new Map<number, any>();
    for (const b of chunk.blocks ?? []) {
      const n = b.number === null || b.number === undefined ? -1 : Number(b.number);
      if (n >= 0) blockByNumber.set(n, b);
    }

    for (const entry of chunk.logs ?? []) {
      const rawTopics: (string | null)[] = [0, 1, 2, 3].map((i) => {
        const t = (entry.topics ?? [])[i];
        return typeof t === "string" ? t : null;
      });
      const decodeTopics = rawTopics.filter((t): t is string => typeof t === "string");
      if (decodeTopics.length === 0) continue;

      let decoded: { eventName: string; args: any };
      try {
        decoded = decodeEventLog({
          abi: cfg.abi,
          data: String(entry.data ?? "0x") as `0x${string}`,
          topics: decodeTopics as [`0x${string}`, ...`0x${string}`[]],
        }) as any;
      } catch {
        continue;
      }

      const txHash = String(entry.transactionHash ?? "");
      const tx = txByHash.get(txHash.toLowerCase());
      const block = blockByNumber.get(Number(entry.blockNumber));

      const ctx: LogContext = {
        blockNumber: Number(entry.blockNumber),
        blockHash: String(entry.blockHash ?? block?.hash ?? ""),
        blockTimestamp: block?.timestamp ? Number(block.timestamp) : 0,
        txHash,
        txIndex: entry.transactionIndex === undefined ? 0 : Number(entry.transactionIndex),
        logIndex: Number(entry.logIndex),
        contractAddress: String(entry.address ?? ""),
        topics: rawTopics,
        logData: String(entry.data ?? "0x"),
        txFrom: tx?.from ? String(tx.from) : null,
        txTo: tx?.to ? String(tx.to) : null,
        txValue: tx?.value === undefined || tx?.value === null ? null : String(tx.value),
        txStatus: tx?.status === undefined || tx?.status === null ? null : Number(tx.status),
        txNonce: tx?.nonce === undefined || tx?.nonce === null ? null : Number(tx.nonce),
        gasUsed: tx?.gasUsed === undefined || tx?.gasUsed === null ? null : Number(tx.gasUsed),
        effectiveGasPrice:
          tx?.effectiveGasPrice === undefined || tx?.effectiveGasPrice === null
            ? null
            : String(tx.effectiveGasPrice),
      };

      const row = cfg.decodeToRow(decoded.eventName, decoded.args, ctx, network, RUN_ID);
      if (row === null) continue;

      if (buffer.length >= 50_000 && row.block_number > lastBlockInBuffer) await flush();
      buffer.push(row);
      if (row.block_number > lastBlockInBuffer) lastBlockInBuffer = row.block_number;
    }
  });

  await flush();

  const unconfirmed: string[] = [];
  for (const [lo, hi] of fetch.emptyChunks) {
    const c = await confirmEmptyRange(network, contracts, lo, hi);
    if (!c.confirmed) unconfirmed.push(`${lo}..${hi}: ${c.reason}`);
  }

  const complete = fetch.complete && unconfirmed.length === 0;
  const detail = [
    ...fetch.errors,
    ...unconfirmed,
    ...(reorgSuspects > 0 ? [`REORG_SUSPECTED: ${reorgSuspects} row(s)`] : []),
  ].join(" | ");

  await recordCoverage({
    runId: RUN_ID, network: network.name, tableId: cfg.tableId,
    fromBlock, toBlock,
    status: complete ? "complete" : fetch.complete ? "unconfirmed_empty" : "incomplete",
    chunksPlanned: fetch.chunksPlanned, chunksOk: fetch.chunksOk,
    skippedRanges: JSON.stringify(fetch.skipped),
    rowsMerged: distinct, rowsInserted: inserted, rowsUpdated: updated,
    logsSeen: fetch.logsSeen,
    startedAt, completedAt: new Date().toISOString(),
    errorMessage: detail.slice(0, 4000),
  });

  return { inserted, updated, complete, detail };
}

export { reingestRange };

/**
 * Re-ingest every protocol day the oracle says is short, then re-check those days.
 *
 * The re-check is the point. A repair that reports what it did is a claim; a repair that
 * reconciles the repaired days against the contract afterwards is a result.
 */
export async function runRepair(opts: PipelineOpts): Promise<boolean> {
  let allClean = true;

  for (const cfg of CONTRACTS) {
    if (opts.contracts && !opts.contracts.includes(cfg.tableId)) continue;

    for (const binding of cfg.networkBindings) {
      const oracle = oracleFor(cfg.tableId, binding.network.name);
      if (!oracle || oracle.kind !== "ubi_daily") continue;
      const network = binding.network;

      const dup = await duplicateReport(cfg.tableId, network.name);
      if (dup.phantomRows > 0) {
        log.warn(
          `${cfg.tableId}/${network.name} still holds ${dup.phantomRows} phantom row(s). ` +
          `Run dedup first: a duplicated day cannot be told apart from a repaired one by count alone.`
        );
      }

      log.info(`Finding short days on ${cfg.tableId}/${network.name}`);
      const before = await reconcileDaily(cfg.tableId, network.name, "amount", opts.days);
      if (!before) continue;

      const short = before.days.filter((d) => d.verdict === "missing").map((d) => d.day);
      if (short.length === 0) {
        log.info(`${cfg.tableId}/${network.name}: no short days, nothing to repair`);
        continue;
      }
      log.warn(`${cfg.tableId}/${network.name}: ${short.length} short day(s): ${short.join(", ")}`);

      if (opts.dryRun) {
        for (const d of before.days.filter((x) => x.verdict === "missing")) {
          log.info(
            `[dry run] day ${d.day}: contract ${d.oracleCount}, warehouse ${d.distinctRows}, ` +
            `missing ${d.countGap} claim(s) worth ${d.amountGapRaw} raw units`
          );
        }
        allClean = false;
        continue;
      }

      const pin = await pinBlock(network);
      if (!pin.ok || pin.value === null) throw new Error(`Cannot pin a block: ${pin.errors.join("; ")}`);
      const ps = await readPeriodStart(network, oracle.address, pin.value);
      if (!ps.ok || ps.value === null) throw new Error(`Cannot read periodStart(): ${ps.errors.join("; ")}`);

      // One block per side is enough for the mechanism found here, since the loss is always
      // the tail of a boundary block. The margin is far wider so a day-edge loss is covered
      // too, and over-coverage is free under MERGE.
      const margin = Math.ceil(network.blocksPerDay / 24);

      for (const day of short) {
        const range = await dayBlockRange(cfg.tableId, network.name, day, ps.value, margin);
        if (!range) {
          log.error(`Day ${day}: no stored rows, cannot anchor a block range. Use backfill --from/--to.`);
          allClean = false;
          continue;
        }
        log.info(`Repairing day ${day} over blocks ${range.from}..${range.to}`);
        const r = await reingestRange(cfg, network, binding.contracts, range.from, range.to);
        log.info(
          `  day ${day}: ${r.inserted} row(s) inserted, ${r.updated} updated, ` +
          `${r.complete ? "range complete" : "RANGE INCOMPLETE"}`
        );
        if (!r.complete) {
          log.error(`  day ${day} repair is not trustworthy: ${r.detail}`);
          allClean = false;
        }
      }

      log.info(`Re-checking repaired day(s) against the contract`);
      const after = await reconcileDaily(cfg.tableId, network.name, "amount", short);
      if (!after) { allClean = false; continue; }
      for (const d of after.days) {
        log.info(
          `  day ${d.day}: ${d.verdict}, contract ${d.oracleCount}, warehouse ${d.distinctRows} distinct, ` +
          `count gap ${d.countGap}, amount gap ${d.amountGapRaw}`
        );
      }
      if (!after.clean) allClean = false;
    }
  }

  return allClean;
}
