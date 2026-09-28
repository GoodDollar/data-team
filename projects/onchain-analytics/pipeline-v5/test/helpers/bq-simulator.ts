/**
 * bq-simulator.ts -- an in-process stand-in for BigQuery that models the ONE thing the write-path
 * defects actually depend on.
 *
 * WHY A SIMULATOR AND NOT THE REAL THING. Two of the defects this phase must keep red were
 * originally reproduced against live BigQuery: the concurrent-duplicate MERGE (`C1`) and the
 * guarded MERGE that misses a key in a non-incoming month (`R-XPART`). Phase 1 may not touch a
 * cloud resource, so the choice is a simulator or no executable test at all. Coordination decided
 * the simulator, on the condition that it models the SEMANTICS the defect depends on rather than
 * returning a canned failure, and that each test proves it discriminates. That condition is what
 * the rest of this comment is about.
 *
 * THE SEMANTICS BEING MODELLED, AND WHY EACH ONE IS THE DEFECT.
 *
 *   1. A MERGE's ON clause decides which TARGET rows are match candidates. `stageAndMerge` puts
 *      a literal partition window on the target, because BigQuery refuses a correlated predicate
 *      and `require_partition_filter` refuses none at all. A target row OUTSIDE that window is
 *      therefore not a candidate, so a source row whose key already exists out there is NOT
 *      MATCHED, and WHEN NOT MATCHED INSERTs it. Two rows, one merge key. That is R-XPART, and it
 *      is ordinary MERGE semantics in any dialect, not a BigQuery quirk and not the guard's fault.
 *
 *   2. A MERGE computes its matches against a SNAPSHOT of the target taken when the statement
 *      starts. Two statements that start before either finishes both see a target with no
 *      matching key, so both insert. That is C1. The audit's runtime receipt is the shape being
 *      modelled: two processes captured XDC 105201000..105201500 at the same time, both exited 0,
 *      and RawLogs ended with 149 stored rows over 102 distinct keys, 47 of them phantoms.
 *
 * WHAT IT REFUSES TO DO. Any statement whose shape it does not recognise throws, naming the
 * statement. A simulator that silently answers an unrecognised query with a plausible-looking
 * empty result is a machine for manufacturing false greens, which is the exact failure class this
 * project keeps finding.
 *
 * WHAT IT IS NOT. It is not a BigQuery. It has no partition pruning, no cost, no types, no
 * `require_partition_filter` enforcement and no transaction semantics beyond the snapshot above.
 * Phase 5's RED check is the real two-process sandbox reproduction. This is the executable
 * placeholder that keeps the suite honest until then.
 */

import { readFileSync } from "fs";
import type {
  BigQueryClientLike, BigQueryDatasetLike, BigQueryTableLike,
} from "../../src/adapters.js";

export interface SimulatedTable {
  /** Column names the table declares. `liveColumns` reads exactly this. */
  columns: string[];
  rows: Record<string, any>[];
}

export interface SimulatedStatement {
  kind:
    | "count_matched" | "count_reorg" | "merge" | "drop" | "select_max_ts"
    | "create_table" | "insert" | "select_coverage" | "other";
  sql: string;
  params?: Record<string, unknown>;
}

/**
 * A rendezvous for N callers. Every caller waits until all N have arrived, then all proceed.
 *
 * This is how two "concurrent" MERGEs are made deterministic. Without it the interleaving would
 * depend on microtask scheduling, and a concurrency test whose outcome depends on scheduling is
 * a coin flip wearing a test's name.
 *
 * `fallbackMs` is load-bearing, not a safety net. Install a real serialising lock and the second
 * statement cannot reach the rendezvous until the first has finished, so a strict barrier would
 * deadlock the very control it exists to demonstrate. The fallback lets a caller that waited and
 * found nobody proceed alone, which is what genuinely serialised statements do.
 */
export function rendezvous(participants: number, fallbackMs = 50): () => Promise<void> {
  let arrived = 0;
  let release: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return async () => {
    arrived += 1;
    if (arrived >= participants) {
      release!();
      await gate;
      return;
    }
    const timer = setTimeout(() => release!(), fallbackMs);
    await gate;
    clearTimeout(timer);
  };
}

export class BigQuerySimulator implements BigQueryClientLike {
  readonly tables = new Map<string, SimulatedTable>();
  readonly statements: SimulatedStatement[] = [];

  /**
   * Called inside a MERGE, after the target snapshot is taken and before the result is applied.
   * A test installs a rendezvous here to hold two statements open at once, which is what the two
   * concurrent processes in the C1 receipt did to each other.
   */
  onMergeSnapshotTaken: (() => Promise<void>) | null = null;

  constructor(readonly projectId = "gooddollar", readonly datasetId = "BlockchainEvents") {}

  // ----------------------------------------------------------------- table management

  /** `project.dataset.Table` as `stageAndMerge` renders it, reduced to the bare table id. */
  private static shortName(ref: string): string {
    return ref.replace(/`/g, "").split(".").pop() ?? ref;
  }

  defineTable(tableId: string, columns: string[], rows: Record<string, any>[] = []): void {
    this.tables.set(tableId, { columns: [...columns], rows: rows.map((r) => ({ ...r })) });
  }

  table(tableId: string): SimulatedTable {
    const t = this.tables.get(tableId);
    if (!t) throw new Error(`SIM_NO_TABLE: ${tableId} was never defined on the simulator`);
    return t;
  }

  rowsOf(tableId: string): Record<string, any>[] {
    return this.table(tableId).rows;
  }

  /** Distinct values of the merge key, which is the only question C1 and R-XPART actually ask. */
  distinctKeys(tableId: string, keyCols: readonly string[]): Set<string> {
    return new Set(this.rowsOf(tableId).map((r) => keyCols.map((k) => String(r[k])).join("|")));
  }

  // ----------------------------------------------------------------- client surface

  dataset(_datasetId: string, _options?: { projectId?: string }): BigQueryDatasetLike {
    const load = async (tableId: string, source: string, metadata: any): Promise<unknown> => {
      const text = readFileSync(source, "utf8");
      const rows = text.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
      const declared: string[] = (metadata?.schema?.fields ?? []).map((f: any) => f.name);
      const columns = declared.length > 0
        ? declared
        : [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const existing = this.tables.get(tableId);
      if (metadata?.writeDisposition === "WRITE_APPEND" && existing) {
        existing.rows.push(...rows);
      } else {
        this.defineTable(tableId, columns, rows);
      }
      return [{}];
    };

    const metadataOf = async (tableId: string) => {
      const t = this.table(tableId);
      return [{ schema: { fields: t.columns.map((name) => ({ name })) } }] as [
        { schema?: { fields?: { name: string }[] } }, ...unknown[]
      ];
    };

    return {
      table: (tableId: string): BigQueryTableLike => ({
        load: (source: string, metadata: unknown) => load(tableId, source, metadata),
        getMetadata: () => metadataOf(tableId),
      }),
    };
  }

  async query(request: { query: string; params?: Record<string, unknown> }): Promise<[any[], ...unknown[]]> {
    const sql = request.query;

    const create = /CREATE TABLE IF NOT EXISTS\s+(\S+)\s*\(([\s\S]*?)\n\s*\)/i.exec(sql);
    if (create) {
      this.statements.push({ kind: "create_table", sql });
      const tableId = BigQuerySimulator.shortName(create[1]);
      if (!this.tables.has(tableId)) {
        // Column names are the first token of each line inside the parentheses. Enough for
        // `assertColumns`, which is the only thing that reads an infra table's schema.
        const columns = create[2]
          .split("\n")
          .map((line) => /^\s*(\w+)\s+\w+/.exec(line)?.[1])
          .filter((c): c is string => !!c);
        this.defineTable(tableId, columns, []);
      }
      return [[]];
    }

    const insert = /INSERT INTO\s+(\S+)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*)\)/i.exec(sql);
    if (insert) {
      this.statements.push({ kind: "insert", sql, params: request.params });
      const tableId = BigQuerySimulator.shortName(insert[1]);
      const columns = insert[2].split(",").map((c) => c.trim()).filter(Boolean);
      // Bind by reading the @names out of the VALUES clause in order, rather than by trusting the
      // key order of the params object. `recordCoverage` passes a whole record through, and its
      // field order is not the statement's column order.
      const names = [...insert[3].matchAll(/@(\w+)/g)].map((m) => m[1]);
      const table = this.tables.get(tableId) ?? (this.defineTable(tableId, columns, []), this.table(tableId));
      const row: Record<string, any> = {};
      columns.forEach((c, i) => { row[c] = (request.params ?? {})[names[i]]; });
      table.rows.push(row);
      return [[]];
    }

    const drop = /DROP TABLE IF EXISTS\s+(\S+)/i.exec(sql);
    if (drop) {
      this.statements.push({ kind: "drop", sql });
      this.tables.delete(BigQuerySimulator.shortName(drop[1]));
      return [[]];
    }

    if (/^\s*MERGE\s/i.test(sql)) {
      this.statements.push({ kind: "merge", sql });
      return [await this.runMerge(sql)];
    }

    if (/COUNT\(\*\) AS n/i.test(sql) && /EXISTS\s*\(/i.test(sql)) {
      this.statements.push({ kind: "count_matched", sql });
      return [[{ n: this.countMatched(sql) }]];
    }

    if (/COUNT\(\*\) AS n/i.test(sql) && /block_hash\s*!=/i.test(sql)) {
      this.statements.push({ kind: "count_reorg", sql });
      return [[{ n: this.countReorg(sql) }]];
    }

    if (/MAX\(block_timestamp\)\s+AS\s+max_ts/i.test(sql)) {
      this.statements.push({ kind: "select_max_ts", sql });
      return [[{ max_ts: null }]];
    }

    if (/FROM\s+\S*IngestionCoverage\S*\s*\n/i.test(sql) && /capture_id/i.test(sql)) {
      this.statements.push({ kind: "select_coverage", sql, params: request.params });
      const p = (request.params ?? {}) as Record<string, any>;
      const rows = (this.tables.get("IngestionCoverage")?.rows ?? [])
        .filter((r) =>
          (p.chainId === undefined || Number(r.chain_id) === Number(p.chainId)) &&
          (p.targetTable === undefined || r.target_table === p.targetTable) &&
          (p.address === undefined || String(r.contract_address).toLowerCase() === String(p.address).toLowerCase()) &&
          r.from_block !== null && r.from_block !== undefined &&
          r.to_block !== null && r.to_block !== undefined)
        .sort((a, b) => Number(a.from_block) - Number(b.from_block))
        .map((r) => ({
          capture_id: r.capture_id, run_id: r.run_id,
          from_block: r.from_block, to_block: r.to_block,
          status: r.status, skipped_ranges: r.skipped_ranges,
          started: r.started_at,
        }));
      return [rows];
    }

    this.statements.push({ kind: "other", sql });
    throw new Error(
      `SIM_UNRECOGNISED_STATEMENT: the simulator does not model this SQL, and answering it with a ` +
      `plausible empty result would manufacture a false green. Statement:\n${sql}`
    );
  }

  // ----------------------------------------------------------------- statement models

  /** `T.a = S.a AND T.b = S.b` from the ON clause only, never from the UPDATE SET clause. */
  private static keyColumns(sql: string): string[] {
    const onClause = /\bON\b([\s\S]*?)\bWHEN\s+MATCHED\b/i.exec(sql)?.[1]
      ?? /\bON\b([\s\S]*?)\bWHERE\b/i.exec(sql)?.[1]
      ?? sql;
    return [...onClause.matchAll(/T\.(\w+)\s*=\s*S\.\1\b/g)].map((m) => m[1]);
  }

  private static window(sql: string): { from: number; to: number } | null {
    const m = /(\w+)\.block_timestamp >= TIMESTAMP\('([^']+)'\)\s+AND\s+\1\.block_timestamp < TIMESTAMP\('([^']+)'\)/
      .exec(sql);
    if (!m) return null;
    return { from: Date.parse(m[2] + "Z"), to: Date.parse(m[3] + "Z") };
  }

  private static tableRefs(sql: string): { target: string; staging: string } {
    const merge = /MERGE\s+(\S+)\s+AS T\s+USING\s+(\S+)\s+AS S/i.exec(sql);
    if (merge) {
      return {
        target: BigQuerySimulator.shortName(merge[1]),
        staging: BigQuerySimulator.shortName(merge[2]),
      };
    }
    const count = /FROM\s+(\S+)\s+T/i.exec(sql);
    const staging = /FROM\s+(\S+)\s+S\b/i.exec(sql) ?? /JOIN\s+(\S+)\s+S\b/i.exec(sql);
    if (!count || !staging) throw new Error(`SIM_NO_TABLE_REFS in:\n${sql}`);
    return {
      target: BigQuerySimulator.shortName(count[1]),
      staging: BigQuerySimulator.shortName(staging[1]),
    };
  }

  private inWindow(row: Record<string, any>, w: { from: number; to: number } | null): boolean {
    if (!w) return true;
    const t = Date.parse(String(row.block_timestamp).replace(" ", "T").replace(/Z?$/, "Z"));
    return t >= w.from && t < w.to;
  }

  private countMatched(sql: string): number {
    const { target, staging } = BigQuerySimulator.tableRefs(sql);
    const keyCols = BigQuerySimulator.keyColumns(sql);
    const w = BigQuerySimulator.window(sql);
    const key = (r: Record<string, any>) => keyCols.map((k) => String(r[k])).join("|");
    const stagingKeys = new Set(this.rowsOf(staging).map(key));
    return this.rowsOf(target).filter((r) => this.inWindow(r, w) && stagingKeys.has(key(r))).length;
  }

  private countReorg(sql: string): number {
    const { target, staging } = BigQuerySimulator.tableRefs(sql);
    const keyCols = BigQuerySimulator.keyColumns(sql);
    const w = BigQuerySimulator.window(sql);
    const key = (r: Record<string, any>) => keyCols.map((k) => String(r[k])).join("|");
    const byKey = new Map(this.rowsOf(staging).map((r) => [key(r), r]));
    return this.rowsOf(target).filter((t) => {
      if (!this.inWindow(t, w)) return false;
      const s = byKey.get(key(t));
      return !!s && t.block_hash != null && s.block_hash != null && t.block_hash !== s.block_hash;
    }).length;
  }

  /**
   * MERGE, modelled in three phases so the concurrency defect is reproducible rather than racy.
   *
   *   SNAPSHOT  the target's rows as they stand when the statement starts
   *   PAUSE     at the rendezvous, if a test installed one
   *   APPLY     update the matched rows in place, append the unmatched
   *
   * A row is a match candidate only when it is in the window AND its key is in staging, which is
   * the R-XPART half. Both statements matching against a pre-insert snapshot is the C1 half.
   */
  private async runMerge(sql: string): Promise<any[]> {
    const { target, staging } = BigQuerySimulator.tableRefs(sql);
    const keyCols = BigQuerySimulator.keyColumns(sql);
    if (keyCols.length === 0) throw new Error(`SIM_NO_MERGE_KEY parsed from:\n${sql}`);
    const w = BigQuerySimulator.window(sql);
    const key = (r: Record<string, any>) => keyCols.map((k) => String(r[k])).join("|");

    const targetTable = this.table(target);
    const snapshot = [...targetTable.rows];

    if (this.onMergeSnapshotTaken) await this.onMergeSnapshotTaken();

    const candidates = new Map<string, Record<string, any>>();
    for (const r of snapshot) {
      if (this.inWindow(r, w)) candidates.set(key(r), r);
    }

    for (const s of this.rowsOf(staging)) {
      const hit = candidates.get(key(s));
      if (hit) {
        for (const [k, v] of Object.entries(s)) {
          if (!keyCols.includes(k)) hit[k] = v;
        }
      } else {
        targetTable.rows.push({ ...s });
      }
    }
    return [];
  }
}
