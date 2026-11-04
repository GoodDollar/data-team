/**
 * range-duplicate-check.worker.ts -- the live half of `range-duplicate-check.gate.ts`.
 *
 * Runs in its own process because CONFIG reads DATASET_ID when the module loads, and the gate only
 * knows the sandbox dataset's name after it has created it. Never run this directly: without the
 * gate's environment DATASET_ID defaults to the production dataset. `sandbox.ts` would refuse to
 * drop it, but nothing here should ever reach it, so the first thing this does is refuse too.
 *
 * Per table, the same story the unit tests tell through the simulator, told to real BigQuery:
 *   1. a row already sits in April under a key;
 *   2. a run writes that key again in June, with the real MERGE and its real window, which inserts
 *      a second row because April is outside that window;
 *   3. the run's duplicate check, through the real statements, has to report exactly that;
 *   4. a second run writing a key with no twin has to come back clean.
 * Every statement goes to a table built with require_partition_filter, so a statement the guard
 * would refuse fails here instead of in production.
 *
 * Prints one JSON line and exits 0 only if every expectation held.
 */

import { stageAndMerge, verifyWrittenRangeUniqueness } from "../../src/bq.js";
import {
  CONFIG, RAW_LOGS_TABLE, TRANSACTIONS_TABLE, RAW_LOGS_SCHEMA, TRANSACTIONS_SCHEMA,
} from "../../src/config.js";
import { windowForRows, monthsWritten } from "../../src/window.js";
import { rawLogRow, transactionRow, hash32, XDC_CHAIN_ID } from "../helpers/fixtures.js";

if (!CONFIG.DATASET_ID.startsWith("sbx_")) {
  console.log(JSON.stringify({ outcome: "refused", reason: `DATASET_ID ${CONFIG.DATASET_ID} is not a sandbox` }));
  process.exit(1);
}

const TABLES = [
  { tableId: RAW_LOGS_TABLE, schema: RAW_LOGS_SCHEMA, row: rawLogRow },
  { tableId: TRANSACTIONS_TABLE, schema: TRANSACTIONS_SCHEMA, row: transactionRow },
];

async function merge(tableId: string, schema: any, rows: Record<string, any>[], runId: string) {
  return stageAndMerge(tableId, rows, schema, runId, windowForRows(rows, CONFIG.MERGE_PADDING_MONTHS)!);
}

async function main(): Promise<void> {
  const results: Record<string, any>[] = [];

  for (const { tableId, schema, row } of TABLES) {
    const dupKey = hash32(`gate-dup-${tableId}`);
    const seed = [row({ txHash: dupKey, blockNumber: 900, blockTimestamp: "2026-04-15T00:00:00.000Z", runId: "gateseed" })];
    const written = [
      row({ txHash: dupKey, blockNumber: 1_000, blockTimestamp: "2026-06-09T10:13:20.000Z", runId: "gaterun" }),
      row({ txHash: hash32(`gate-one-${tableId}`), blockNumber: 1_001, blockTimestamp: "2026-06-09T10:13:25.000Z", runId: "gaterun" }),
    ];
    const clean = [
      row({ txHash: hash32(`gate-clean-${tableId}`), blockNumber: 1_002, blockTimestamp: "2026-06-09T10:13:30.000Z", runId: "gateclean" }),
    ];

    await merge(tableId, schema, seed, "gateseed");
    const runMerge = await merge(tableId, schema, written, "gaterun");
    const dup = await verifyWrittenRangeUniqueness(tableId, XDC_CHAIN_ID, {
      runId: "gaterun", months: monthsWritten(written, CONFIG.MERGE_PADDING_MONTHS),
    });

    await merge(tableId, schema, clean, "gateclean");
    const ok = await verifyWrittenRangeUniqueness(tableId, XDC_CHAIN_ID, {
      runId: "gateclean", months: monthsWritten(clean, CONFIG.MERGE_PADDING_MONTHS),
    });

    const expectations: Record<string, boolean> = {
      "the June MERGE inserted both rows, so a real duplicate exists": runMerge.inserted === 2,
      "the check reports the duplicate": dup.ok === false,
      "exactly one phantom row": dup.report.phantomRows === 1,
      "over the run's two keys, held by three rows": dup.report.distinctKeys === 2 && dup.report.storedRows === 3,
      "the clean run passes": ok.ok === true && ok.report.storedRows === 1 && ok.report.distinctKeys === 1,
    };
    results.push({
      tableId, inserted_by_run: runMerge.inserted, duplicate_report: dup.report, clean_report: ok.report,
      expectations, passed: Object.values(expectations).every(Boolean),
    });
  }

  const passed = results.every((r) => r.passed);
  console.log(JSON.stringify({ outcome: passed ? "passed" : "failed", dataset: CONFIG.DATASET_ID, results }));
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ outcome: "error", message: String(e?.message ?? e) }));
  process.exit(1);
});
