/**
 * write-safety.test.ts -- the controls that stand between this pipeline and a duplicated or
 * runaway write.
 *
 * FOUR SUBJECTS, each of which exists because its absence was measured on this system.
 *
 *   THE CROSS-PROCESS LEASE. `C1`: two captures of one range ran at once, both exited 0, and
 *   RawLogs held 149 rows over 102 keys. The lease excludes the second writer.
 *
 *   THE COVERAGE CONSEQUENCE OF A REFUSAL, which is the half a row count cannot show. The
 *   original incident was invisible because BOTH processes wrote a coverage row saying
 *   `complete`. A correct row count with two `complete` rows is not a fix. So the refusal has to
 *   travel: refused write, thrown capture, `incomplete` coverage, nonzero exit.
 *
 *   THE COST CEILING. `maximumBytesBilled` on every statement, attached at the one chokepoint
 *   every statement passes through, because a ceiling that jobs can be written without is a
 *   convention rather than a control.
 *
 *   THE STAGING SPLIT. Staging tables are created and dropped, so they must not live in the
 *   dataset holding production rows -- otherwise the writer identity needs `tables.delete` on
 *   the production raw layer, which is one of the permissions this system is built to keep
 *   revoked.
 *
 * The two-OS-process reproduction is NOT here, deliberately: everything below runs in one
 * process, and within-process repetition has already produced a wrong conclusion on this
 * project. It lives in `test/integration/two-process-merge.gate.ts`, which needs a credential.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { tmpdir, hostname } from "os";
import { join } from "path";
import { stageAndMerge, bqQuery } from "../../src/bq.js";
import { runPipeline } from "../../src/pipeline.js";
import {
  CONFIG, RAW_LOGS_TABLE, RAW_LOGS_SCHEMA, MERGE_KEYS,
  stagingTableName, assertStagingIsSeparate,
} from "../../src/config.js";
import { windowForRows } from "../../src/window.js";
import { fileWriteLock, leaseFileName } from "../../src/writelock.js";
import { setBigQueryClient, setWriteLock, setReaderOverride, resetAdapters } from "../../src/adapters.js";
import { BigQuerySimulator } from "../helpers/bq-simulator.js";
import { rawLogRow, RAW_LOGS_COLUMNS, C1_RANGE, XDC_CHAIN_ID, hash32 } from "../helpers/fixtures.js";

const KEY = MERGE_KEYS[RAW_LOGS_TABLE];
const tempDirs: string[] = [];

function lockDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gd-writelock-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetAdapters();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function simulator(): BigQuerySimulator {
  const sim = new BigQuerySimulator();
  sim.defineTable(RAW_LOGS_TABLE, RAW_LOGS_COLUMNS, []);
  setBigQueryClient(sim);
  return sim;
}

describe("the cross-process write lease", () => {
  it("admits one holder at a time and refuses the second when it will not wait", async () => {
    const lock = fileWriteLock({ dir: lockDir(), waitMs: 0, pollMs: 1 });

    const first = await lock.acquire(RAW_LOGS_TABLE, null);
    expect(first, "the first caller must be admitted").not.toBeNull();

    // waitMs 0 means the second caller does not queue; it is told no. That is what turns a
    // losing writer into a nonzero exit instead of a duplicate row.
    const second = await lock.acquire(RAW_LOGS_TABLE, null);
    expect(second, "a held lease must refuse rather than admit a second writer").toBeNull();

    await first!.release();

    const third = await lock.acquire(RAW_LOGS_TABLE, null);
    expect(third, "a released lease must be acquirable again").not.toBeNull();
    await third!.release();
  });

  it("waits for a held lease rather than refusing, when it is given time", async () => {
    const lock = fileWriteLock({ dir: lockDir(), waitMs: 5_000, pollMs: 5 });

    const first = await lock.acquire(RAW_LOGS_TABLE, null);
    let secondAdmittedAt = 0;
    const waiter = lock.acquire(RAW_LOGS_TABLE, null).then((h) => {
      secondAdmittedAt = Date.now();
      return h;
    });

    await new Promise((r) => setTimeout(r, 60));
    const releasedAt = Date.now();
    await first!.release();

    const second = await waiter;
    expect(second, "a waiter given time must be admitted, not refused").not.toBeNull();
    expect(
      secondAdmittedAt,
      "the waiter must not have been admitted before the holder let go"
    ).toBeGreaterThanOrEqual(releasedAt);
    await second!.release();
  });

  it("holds the lease per table, so an unrelated table is not blocked", async () => {
    const lock = fileWriteLock({ dir: lockDir(), waitMs: 0, pollMs: 1 });
    const logs = await lock.acquire(RAW_LOGS_TABLE, null);
    const txs = await lock.acquire("Transactions", null);

    expect(logs).not.toBeNull();
    expect(txs, "a different table is a different lease").not.toBeNull();
    await logs!.release();
    await txs!.release();
  });

  it("reclaims a lease whose holder is no longer running, without waiting out the expiry", async () => {
    const dir = lockDir();
    // A pid that cannot be running: the killed-mid-MERGE case. Without liveness detection this
    // lease would block every later run for a full expiry period, which is how a crash turns
    // into an unwritable table -- and the expiry cannot simply be shortened, because reclaiming
    // a lease that is merely slow reintroduces the concurrent write.
    const dead = {
      token: "stale-token", pid: 0x7fffffff, host: hostname(),
      tableId: RAW_LOGS_TABLE, acquiredAt: new Date().toISOString(), window: null,
    };
    writeFileSync(
      join(dir, leaseFileName(CONFIG.GCP_PROJECT_ID, CONFIG.DATASET_ID, RAW_LOGS_TABLE)),
      JSON.stringify(dead)
    );

    const lock = fileWriteLock({ dir, waitMs: 0, pollMs: 1, staleMs: 60 * 60_000 });
    const handle = await lock.acquire(RAW_LOGS_TABLE, null);

    expect(
      handle,
      "a lease held by a dead process must be reclaimed at once, not held until it expires"
    ).not.toBeNull();
    await handle!.release();
  });

  it("reclaims a lease that has passed its expiry even when the holder cannot be asked about", async () => {
    const dir = lockDir();
    const foreign = {
      token: "old-token", pid: 1, host: "some-other-machine",
      tableId: RAW_LOGS_TABLE, acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      window: null,
    };
    writeFileSync(
      join(dir, leaseFileName(CONFIG.GCP_PROJECT_ID, CONFIG.DATASET_ID, RAW_LOGS_TABLE)),
      JSON.stringify(foreign)
    );

    const handle = await fileWriteLock({ dir, waitMs: 0, pollMs: 1, staleMs: 60_000 })
      .acquire(RAW_LOGS_TABLE, null);
    expect(handle, "a lease older than its expiry is abandoned").not.toBeNull();
    await handle!.release();
  });

  it("will not delete a lease that was reclaimed from it, which would admit a third writer", async () => {
    const dir = lockDir();
    const path = join(dir, leaseFileName(CONFIG.GCP_PROJECT_ID, CONFIG.DATASET_ID, RAW_LOGS_TABLE));
    const lock = fileWriteLock({ dir, waitMs: 0, pollMs: 1 });

    const mine = await lock.acquire(RAW_LOGS_TABLE, null);
    // Somebody else reclaimed it as stale while this holder was still running. Releasing by
    // unlinking the path would delete THEIR lease.
    const theirs = { ...JSON.parse(readFileSync(path, "utf8")), token: "someone-elses-token" };
    writeFileSync(path, JSON.stringify(theirs));

    await mine!.release();

    expect(existsSync(path), "the other holder's lease must survive our release").toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("someone-elses-token");
  });

  it("names the lease by dataset, so a sandbox write does not contend with production", () => {
    const production = leaseFileName("gooddollar", "BlockchainEvents", RAW_LOGS_TABLE);
    const sandbox = leaseFileName("gooddollar", "sbx_unit06_20260929Z_ab12cd", RAW_LOGS_TABLE);
    expect(production).not.toBe(sandbox);
  });
});

describe("a refused write does not leave a capture looking complete", () => {
  const ADDRESS = "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf";

  /**
   * A reader that returns one log and reports the range fully read.
   *
   * `complete: true` and an empty `rollbackGuards` are load-bearing rather than boilerplate:
   * `pipeline.ts` derives status from them first, so a fixture that omitted either would record
   * `incomplete` for a reason that has nothing to do with the write lock, and the refusal test
   * above it would pass while proving nothing. The discrimination case below is what catches
   * that, and it caught exactly this.
   */
  function readerReturningOneLog(): void {
    setReaderOverride(async (_n, _addresses, from, to, onChunk) => {
      await onChunk({
        fromBlock: from, toBlock: to,
        logs: [{
          address: ADDRESS, blockNumber: from, blockHash: hash32(`b${from}`),
          transactionHash: hash32(`t${from}`), transactionIndex: 0, logIndex: 0,
          topics: [hash32("topic0")], data: "0x", removed: false,
        }],
        transactions: [], blocks: [{ number: from, hash: hash32(`b${from}`), timestamp: 1_781_000_000 }],
        sourceKind: "index", sourceId: "hypersync:xdc.hypersync.xyz", archiveHeight: to + 100,
      } as any);
      return {
        fromBlock: from, toBlock: to, chunksPlanned: 1, chunksOk: 1, logsSeen: 1,
        skipped: [], errors: [], emptyChunks: [], complete: true,
        sourceKind: "index", sourceId: "hypersync:xdc.hypersync.xyz",
        enumeratingSources: 1, headAtCapture: to + 100, rollbackGuards: [],
      } as any;
    });
  }

  const runOneCapture = () => runPipeline({
    mode: "backfill", chains: ["XDC"], addresses: [ADDRESS],
    fromBlock: 100_000_000, toBlock: 100_000_010,
  });

  /**
   * `C1`'s third clause, which is the one that made the original incident invisible.
   *
   * Both processes exited 0 and both wrote `complete`. A correct row count with two `complete`
   * coverage rows is a failed fix, so the refusal has to be visible in the ledger and not only
   * in the table. This drives the real capture path with a lock that refuses.
   */
  it("records incomplete, never complete, when the write lock refuses", async () => {
    const sim = simulator();
    setWriteLock({ acquire: async () => null });
    readerReturningOneLog();

    await runOneCapture();

    const coverage = sim.tables.get("IngestionCoverage")?.rows ?? [];
    expect(coverage.length, "a refused write must still leave a coverage row").toBeGreaterThan(0);

    const complete = coverage.filter((r) => r.status === "complete");
    expect(
      complete.length,
      `A refused writer recorded ${complete.length} coverage row(s) as complete. That is the ` +
      `exact shape of the original incident: the rows were wrong and the ledger said they were ` +
      `fine. A refusal must never read as a clean capture.`
    ).toBe(0);

    // Asserted on the RawLogs grain by name. The transaction grain returns its own `incomplete`
    // whenever a captured log points at a transaction the reader did not return, which it does
    // here -- so `some row says incomplete` would have passed with the lock removed entirely.
    const logsRow = coverage.find((r) => r.target_table === RAW_LOGS_TABLE);
    expect(logsRow, "the RawLogs grain must have a coverage row").toBeDefined();
    expect(logsRow!.status).toBe("incomplete");
    expect(
      String(logsRow!.error_message ?? ""),
      "the coverage row must name the refusal, so the cause is queryable rather than inferred"
    ).toContain("WRITE_LOCK_REFUSED");
  });

  it("DISCRIMINATION: the same capture with a granting lock records complete", async () => {
    const sim = simulator();
    setWriteLock({ acquire: async () => ({ release: async () => {} }) });
    readerReturningOneLog();

    await runOneCapture();

    // If this ever fails, the test above proves nothing: it would be reporting "not complete"
    // for a reason that has nothing to do with the lock.
    const coverage = sim.tables.get("IngestionCoverage")?.rows ?? [];
    const logsRow = coverage.find((r) => r.target_table === RAW_LOGS_TABLE);
    expect(
      logsRow?.status,
      `The identical capture with a GRANTING lock did not record the RawLogs grain complete, so ` +
      `the refusal test above is not measuring the lock. Statuses seen: ` +
      `${coverage.map((r) => `${r.target_table}=${r.status}`).join(", ") || "(none)"}.`
    ).toBe("complete");
    expect(
      String(logsRow?.error_message ?? ""),
      "a granted lock must leave no refusal note behind"
    ).not.toContain("WRITE_LOCK_REFUSED");
  });
});

describe("the per-job cost ceiling", () => {
  it("puts maximumBytesBilled on every statement, because they all pass one chokepoint", async () => {
    const seen: (string | undefined)[] = [];
    setBigQueryClient({
      query: async (req: any) => { seen.push(req.maximumBytesBilled); return [[]]; },
      dataset: () => ({ table: () => ({ load: async () => [{}], getMetadata: async () => [{}] }) }),
    } as any);

    await bqQuery("SELECT 1");
    await bqQuery("DELETE FROM x WHERE y = @z", { z: 1 }, { z: "INT64" });

    expect(seen).toHaveLength(2);
    for (const v of seen) {
      expect(v, "a statement with no ceiling is an unbounded bill").toBe(
        String(CONFIG.MAX_BYTES_BILLED_PER_JOB)
      );
    }
  });

  it("sends the ceiling as a string, because the REST field is an int64", async () => {
    let captured: any;
    setBigQueryClient({
      query: async (req: any) => { captured = req.maximumBytesBilled; return [[]]; },
      dataset: () => ({ table: () => ({ load: async () => [{}], getMetadata: async () => [{}] }) }),
    } as any);

    await bqQuery("SELECT 1");
    expect(typeof captured).toBe("string");
    expect(Number(captured)).toBe(10 * 1024 * 1024 * 1024);
  });

  it("does not retry a refusal, because the same statement is refused identically every time", async () => {
    let attempts = 0;
    setBigQueryClient({
      query: async () => {
        attempts += 1;
        throw new Error(
          "Query exceeded limit for bytes billed: 10737418240. 21474836480 or higher required."
        );
      },
      dataset: () => ({ table: () => ({ load: async () => [{}], getMetadata: async () => [{}] }) }),
    } as any);

    await expect(bqQuery("SELECT * FROM enormous")).rejects.toThrow(/exceeded limit for bytes billed/);
    expect(
      attempts,
      `A refusal was attempted ${attempts} times. Retrying a cost refusal cannot succeed and only ` +
      `delays the error behind ${CONFIG.BQ_RETRIES} backoffs.`
    ).toBe(1);
  });
});

describe("the staging split", () => {
  it("composes a staging name from the staging dataset, not the production one", () => {
    const name = stagingTableName("_staging_RawLogs_abc123");
    expect(name).toContain(CONFIG.STAGING_DATASET_ID);
    expect(
      name.includes(`.${CONFIG.DATASET_ID}.`),
      "a staging table inside the production dataset is the defect this split removes"
    ).toBe(false);
  });

  it("refuses to compose a staging name at all if the two datasets are configured the same", () => {
    const original = CONFIG.STAGING_DATASET_ID;
    try {
      (CONFIG as any).STAGING_DATASET_ID = CONFIG.DATASET_ID;
      expect(() => assertStagingIsSeparate()).toThrow(/STAGING_NOT_SEPARATE/);
      expect(() => stagingTableName("_staging_RawLogs_abc123")).toThrow(/STAGING_NOT_SEPARATE/);
    } finally {
      (CONFIG as any).STAGING_DATASET_ID = original;
    }
  });

  it("creates, reads and drops the staging table in the staging dataset during a real merge", async () => {
    const sim = simulator();
    const rows = Array.from({ length: 3 }, (_, i) =>
      rawLogRow({ blockNumber: C1_RANGE.from + i, txHash: hash32(`split-${i}`), logIndex: 0, chainId: XDC_CHAIN_ID })
    );
    // The simulator records the dataset each handle was opened against, so "which dataset did
    // the load go to" is answerable rather than inferred from the SQL text alone.
    await stageAndMerge(RAW_LOGS_TABLE, rows, RAW_LOGS_SCHEMA, "run-split", windowForRows(rows, 1)!);

    const stagingRefs = sim.statements
      .filter((s) => /_staging_/.test(s.sql))
      .map((s) => s.sql);
    expect(stagingRefs.length, "the merge must reference a staging table").toBeGreaterThan(0);

    for (const sql of stagingRefs) {
      for (const ref of sql.match(/`[^`]*_staging_[^`]*`/g) ?? []) {
        expect(
          ref,
          `Staging reference ${ref} resolves into the production dataset. Every staging create, ` +
          `read and drop must route to ${CONFIG.STAGING_DATASET_ID}.`
        ).toContain(`.${CONFIG.STAGING_DATASET_ID}.`);
      }
    }

    const dropped = sim.statements.filter((s) => s.kind === "drop");
    expect(dropped.length, "the staging table must be dropped").toBeGreaterThan(0);
    expect(dropped[0].sql).toContain(`.${CONFIG.STAGING_DATASET_ID}.`);
    expect(sim.rowsOf(RAW_LOGS_TABLE)).toHaveLength(3);
  });

  it("leaves no lease files behind after a merge", async () => {
    const dir = lockDir();
    setWriteLock(fileWriteLock({ dir, waitMs: 1_000, pollMs: 5 }));
    const sim = simulator();
    const rows = [rawLogRow({ blockNumber: C1_RANGE.from, txHash: hash32("lease"), logIndex: 0, chainId: XDC_CHAIN_ID })];

    await stageAndMerge(RAW_LOGS_TABLE, rows, RAW_LOGS_SCHEMA, "run-lease", windowForRows(rows, 1)!);

    expect(sim.rowsOf(RAW_LOGS_TABLE)).toHaveLength(1);
    expect(
      readdirSync(dir),
      "a lease that outlives its merge blocks the next run"
    ).toHaveLength(0);
  });

  it("releases the lease even when the merge throws", async () => {
    const dir = lockDir();
    setWriteLock(fileWriteLock({ dir, waitMs: 1_000, pollMs: 5 }));
    const sim = new BigQuerySimulator();
    // No RawLogs defined, so `liveColumns` throws part way through the write path.
    setBigQueryClient(sim);
    const rows = [rawLogRow({ blockNumber: C1_RANGE.from, txHash: hash32("throw"), logIndex: 0, chainId: XDC_CHAIN_ID })];

    await expect(
      stageAndMerge(RAW_LOGS_TABLE, rows, RAW_LOGS_SCHEMA, "run-throw", windowForRows(rows, 1)!)
    ).rejects.toThrow();

    expect(
      readdirSync(dir),
      "a lease held by a failed merge would block every later run"
    ).toHaveLength(0);
  });
});

describe("the merge key is checked, not assumed", () => {
  it("reports a phantom row rather than leaving a duplicate silent", async () => {
    const sim = simulator();
    const key = { txHash: hash32("dup"), logIndex: 0, chainId: XDC_CHAIN_ID };
    sim.defineTable(RAW_LOGS_TABLE, RAW_LOGS_COLUMNS, [
      rawLogRow({ ...key, blockNumber: 105_100_000, blockTimestamp: "2026-05-02T00:00:00.000Z" }),
      rawLogRow({ ...key, blockNumber: 105_100_000, blockTimestamp: "2026-08-05T00:00:00.000Z" }),
    ]);

    const { verifyMergeKeyUniqueness } = await import("../../src/bq.js");
    const result = await verifyMergeKeyUniqueness(RAW_LOGS_TABLE, XDC_CHAIN_ID);

    expect(result.ok).toBe(false);
    expect(result.report.storedRows).toBe(2);
    expect(result.report.distinctKeys).toBe(1);
    expect(result.report.phantomRows).toBe(1);
    expect(sim.distinctKeys(RAW_LOGS_TABLE, KEY).size).toBe(1);
  });
});
