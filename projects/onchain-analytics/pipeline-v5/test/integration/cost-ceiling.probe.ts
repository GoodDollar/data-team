/**
 * cost-ceiling.probe.ts -- proves against live BigQuery that an over-ceiling job is REFUSED
 * rather than billed.
 *
 * Run as a separate process by `two-process-merge.gate.ts` with `MAX_BYTES_BILLED_PER_JOB` set
 * to one byte, because the ceiling is read at module load and the point is to exercise the real
 * path rather than to stub it.
 *
 * WHY ONE BYTE AND NOT A GENUINELY HUGE QUERY. The claim is that the ceiling is attached to
 * every statement and that BigQuery enforces it before running the job. Lowering the ceiling
 * tests exactly that, against a real table, and costs nothing -- a refused job bills zero. Aiming
 * a real 10 GiB query at production to watch it be refused would test the same property and put
 * a runaway scan one configuration mistake away from running.
 *
 * Exit 0 means REFUSED, which is the passing outcome.
 */

import { bqQuery } from "../../src/bq.js";
import { CONFIG, RAW_LOGS_TABLE } from "../../src/config.js";

const datasetId = CONFIG.DATASET_ID;
const table = `\`${CONFIG.GCP_PROJECT_ID}.${datasetId}.${RAW_LOGS_TABLE}\``;

try {
  const rows = await bqQuery(
    `SELECT COUNT(*) AS n FROM ${table}
      WHERE block_timestamp >= TIMESTAMP('2000-01-01 00:00:00')
        AND block_timestamp <  TIMESTAMP('2100-01-01 00:00:00')`
  );
  process.stdout.write(JSON.stringify({
    outcome: "BILLED",
    ceiling: CONFIG.MAX_BYTES_BILLED_PER_JOB,
    rows: rows.length,
    note: "The job RAN. Either the ceiling was not attached to the request, or it was not enforced.",
  }) + "\n");
  process.exit(1);
} catch (e: any) {
  const message = String(e?.message ?? e);
  const refused = /bytes billed/i.test(message);
  process.stdout.write(JSON.stringify({
    outcome: refused ? "REFUSED" : "OTHER_ERROR",
    ceiling: CONFIG.MAX_BYTES_BILLED_PER_JOB,
    message: message.slice(0, 500),
  }) + "\n");
  process.exit(refused ? 0 : 1);
}
