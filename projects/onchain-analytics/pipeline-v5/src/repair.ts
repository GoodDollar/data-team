/**
 * repair.ts
 *
 * Two operations on history. MERGE prevents new damage; it does nothing about damage already
 * written, and both kinds exist in this warehouse.
 *
 *   dedup   Collapses repeated natural keys. 43,000 phantom claim rows and 2,167 phantom invite
 *           rows were written by the predecessor's append path re-running a block range four
 *           months apart.
 *
 *   repair  Re-reads the ranges the coverage ledger says were not covered. The four missing
 *           claims are not recoverable by de-duplicating anything: they were never written.
 *
 * WHAT CHANGED, AND IT IS THE POINT OF THE PACKAGE. Repair used to be driven by a contract
 * ORACLE: `runRepair` skipped any binding whose oracle was not of kind ubi_daily, and ORACLES has
 * two entries. So the only route to re-reading a range covered one table on one network, against
 * a surface of 146 contracts on four chains, and the other 144 contracts had no route at all
 * because they publish no comparable ledger.
 *
 * Meanwhile the pipeline was already recording exactly what needed re-reading, and throwing it
 * away. `skipped_ranges` is written in three places and, by an exhaustive search of all fourteen
 * source files, read in none. A field written and never read is not a record, it is a comment in
 * a table. Repair is now driven by it.
 *
 * THE ORACLE ROUTE STAYS, because it is the only EXTERNAL check this warehouse has. Every
 * correctness argument before it compared the warehouse against itself, including the one that
 * drove a shipped production fix, and a uniqueness assertion cannot prove a table holds what the
 * chain produced. It is a second route, not the only one.
 *
 * ONE CODE PATH. Both routes call the pipeline's own `processTarget` over a named range. The
 * previous version carried its own copy of the fetch, build and write loop, about sixty-five
 * lines duplicated almost verbatim, so a fix to one path silently left the other behind.
 */

import { selectedNetworks, RAW_LOGS_TABLE, TRANSACTIONS_TABLE, oraclesFor, networkByChainId } from "./config.js";
import { log } from "./log.js";
import { dedupTable } from "./bq.js";
import { targetsFor } from "./registry.js";
import { loadCoverage, openGaps } from "./coverage.js";
import { processTarget } from "./pipeline.js";
import { reconcileDaily } from "./reconcile.js";
import type { PipelineOpts } from "./types.js";

/** Collapse repeated keys on both L0 tables, for every selected chain. */
export async function runDedup(opts: PipelineOpts): Promise<boolean> {
  let clean = true;

  for (const network of selectedNetworks(opts.chains)) {
    for (const tableId of [RAW_LOGS_TABLE, TRANSACTIONS_TABLE]) {
      const r = await dedupTable(tableId, network.chainId, !!opts.dryRun);
      if (opts.dryRun) {
        log.info(
          `[dry run] ${tableId}/${network.name}: ${r.before.storedRows} stored, ` +
          `${r.before.distinctKeys} distinct, ${r.before.phantomRows} phantom` +
          (r.before.phantomRows > 0 ? `, blocks ${r.before.minBlock}..${r.before.maxBlock}` : "")
        );
        if (r.before.phantomRows > 0) clean = false;
        continue;
      }
      if (r.after && r.after.phantomRows > 0) {
        log.error(`${tableId}/${network.name}: ${r.after.phantomRows} phantom row(s) survived de-duplication`);
        clean = false;
      }
    }
  }

  return clean;
}

/**
 * Report every open gap without changing anything. This is what `coverage` mode runs.
 *
 * Worth having as its own mode because the question "what does this warehouse not cover" was
 * previously unanswerable: the data could not be asked, since an empty result has two causes, and
 * the ledger was write only.
 */
export async function reportCoverage(opts: PipelineOpts): Promise<boolean> {
  let clean = true;

  for (const network of selectedNetworks(opts.chains)) {
    for (const target of targetsFor(network, { addresses: opts.addresses })) {
      const captures = await loadCoverage(target.chainId, RAW_LOGS_TABLE, target.address);
      const gaps = openGaps(captures);
      if (captures.length === 0) {
        log.warn(
          `${network.name} ${target.contractName} ${target.address}: NO COVERAGE ROW. No range has ` +
          `been read into ${RAW_LOGS_TABLE} for this contract, so an empty result over it means ` +
          `"nobody looked" and not "nothing happened".`
        );
        clean = false;
        continue;
      }
      if (gaps.length === 0) {
        log.info(`${network.name} ${target.contractName}: ${captures.length} capture(s), no open gap`);
        continue;
      }
      clean = false;
      log.error(
        `${network.name} ${target.contractName} ${target.address}: ${gaps.length} open gap(s): ` +
        gaps.map(([a, b]) => `${a}..${b}`).join(", ")
      );
    }
  }

  return clean;
}

/**
 * Re-read every range the coverage ledger records as not covered, then re-check.
 *
 * The re-check is the point. A repair that reports what it did is a claim; a repair that reads
 * the ledger again afterwards, and reconciles against the contract where one exists, is a result.
 */
export async function runRepair(opts: PipelineOpts): Promise<boolean> {
  let allClean = true;

  for (const network of selectedNetworks(opts.chains)) {
    for (const target of targetsFor(network, { addresses: opts.addresses })) {
      const captures = await loadCoverage(target.chainId, RAW_LOGS_TABLE, target.address);
      const gaps = openGaps(captures);
      if (gaps.length === 0) continue;

      const label = `${target.contractName} ${target.address} on ${network.name}`;
      log.warn(`${label}: ${gaps.length} open gap(s) to re-read: ` + gaps.map(([a, b]) => `${a}..${b}`).join(", "));

      if (opts.dryRun) {
        allClean = false;
        continue;
      }

      for (const [from, to] of gaps) {
        log.info(`Repairing ${label} over blocks ${from}..${to}`);
        try {
          // The same code path an ordinary ingestion uses, over a named range. Re-reading is free
          // of duplicates under MERGE, so over-covering a gap costs time and nothing else.
          await processTarget(target, { mode: "backfill", fromBlock: from, toBlock: to });
        } catch (e: any) {
          log.error(`  repair of ${from}..${to} did not complete: ${e.message}`);
          allClean = false;
        }
      }

      const after = openGaps(await loadCoverage(target.chainId, RAW_LOGS_TABLE, target.address));
      if (after.length > 0) {
        log.error(`${label}: ${after.length} gap(s) remain after repair: ` + after.map(([a, b]) => `${a}..${b}`).join(", "));
        allClean = false;
      } else {
        log.info(`${label}: every open gap is now covered by a clean capture`);
      }
    }
  }

  // The external check, where one exists. Two contracts out of 146 publish a usable ledger, so
  // this cannot be the only route to a re-read, but it is the only evidence in this system that
  // does not come from the system itself.
  for (const oracle of oraclesFor(selectedNetworks(opts.chains))) {
    if (oracle.kind !== "ubi_daily") continue;
    const network = networkByChainId(oracle.network.chainId);
    if (!network) continue;
    const result = await reconcileDaily(oracle, opts.days);
    if (!result) continue;
    if (!result.clean) {
      log.error(
        `Oracle reconciliation on ${oracle.address} is NOT clean after repair: ` +
        `${result.days.filter((d) => d.verdict !== "exact").length} day(s) disagree with the contract`
      );
      allClean = false;
    } else {
      log.info(`Oracle reconciliation on ${oracle.address} is exact across ${result.interiorDays} interior day(s)`);
    }
  }

  return allClean;
}
