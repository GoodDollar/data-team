/**
 * The harness proving itself.
 *
 * Coordination's rule for a simulator-backed test: "A simulator-backed test that would pass
 * against a correctly fixed implementation AND against the current broken one is worthless. Prove
 * each one discriminates." That obligation lands on the simulator, so this file is where it is
 * discharged.
 *
 * Three properties, and the third is the one that matters most:
 *
 *   1. It reproduces the defect under the current implementation.
 *   2. It reports a correct implementation as correct.
 *   3. It REFUSES any SQL it does not model, rather than answering with a plausible empty result.
 *
 * Without the third, every future statement this pipeline learns to emit would silently return
 * nothing and every assertion built on it would pass for no reason.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BigQuerySimulator, rendezvous } from "../helpers/bq-simulator.js";
import { makeWireRecorder } from "../helpers/wire-recorder.js";
import { setRpcTransport, resetAdapters } from "../../src/adapters.js";
import { rpcCall } from "../../src/rpc.js";

const COLUMNS = ["chain_id", "tx_hash", "log_index", "block_timestamp", "block_hash", "payload"];

function row(txHash: string, ts: string, extra: Record<string, any> = {}) {
  return {
    chain_id: 50, tx_hash: txHash, log_index: 0,
    block_timestamp: ts, block_hash: "0xaa", payload: "v1", ...extra,
  };
}

const MERGE_SQL = (windowFrom: string, windowTo: string) => `
      MERGE \`p.d.Target\` AS T
      USING \`p.d.Staging\` AS S
        ON T.chain_id = S.chain_id AND T.tx_hash = S.tx_hash AND T.log_index = S.log_index
        AND T.block_timestamp >= TIMESTAMP('${windowFrom}') AND T.block_timestamp < TIMESTAMP('${windowTo}')
      WHEN MATCHED THEN UPDATE SET T.block_timestamp = S.block_timestamp, T.payload = S.payload
      WHEN NOT MATCHED THEN INSERT (chain_id, tx_hash, log_index, block_timestamp, block_hash, payload) VALUES (S.chain_id, S.tx_hash, S.log_index, S.block_timestamp, S.block_hash, S.payload)
    `;

let sim: BigQuerySimulator;

beforeEach(() => { sim = new BigQuerySimulator(); });
afterEach(() => resetAdapters());

describe("the BigQuery simulator models window-scoped MERGE matching", () => {
  it("UPDATES a row inside the window", async () => {
    sim.defineTable("Target", COLUMNS, [row("0x01", "2026-08-10T00:00:00.000Z")]);
    sim.defineTable("Staging", COLUMNS, [row("0x01", "2026-08-11T00:00:00.000Z", { payload: "v2" })]);

    await sim.query({ query: MERGE_SQL("2026-07-01 00:00:00", "2026-10-01 00:00:00") });

    expect(sim.rowsOf("Target")).toHaveLength(1);
    expect(sim.rowsOf("Target")[0].payload).toBe("v2");
  });

  it("INSERTS a duplicate when the same key sits outside the window", async () => {
    sim.defineTable("Target", COLUMNS, [row("0x01", "2026-05-02T00:00:00.000Z")]);
    sim.defineTable("Staging", COLUMNS, [row("0x01", "2026-08-11T00:00:00.000Z", { payload: "v2" })]);

    await sim.query({ query: MERGE_SQL("2026-07-01 00:00:00", "2026-10-01 00:00:00") });

    expect(sim.rowsOf("Target")).toHaveLength(2);
    expect(sim.distinctKeys("Target", ["chain_id", "tx_hash", "log_index"]).size).toBe(1);
  });

  it("does not read the UPDATE SET clause as part of the merge key", async () => {
    // `T.payload = S.payload` appears in the UPDATE clause. A naive regex over the whole
    // statement would treat payload as a key column, which would make the R-XPART test pass for
    // the wrong reason.
    sim.defineTable("Target", COLUMNS, [row("0x01", "2026-08-10T00:00:00.000Z", { payload: "old" })]);
    sim.defineTable("Staging", COLUMNS, [row("0x01", "2026-08-11T00:00:00.000Z", { payload: "new" })]);

    await sim.query({ query: MERGE_SQL("2026-07-01 00:00:00", "2026-10-01 00:00:00") });

    expect(sim.rowsOf("Target")).toHaveLength(1);
  });

  it("models snapshot isolation, so two overlapping MERGEs both insert", async () => {
    sim.defineTable("Target", COLUMNS, []);
    sim.defineTable("Staging", COLUMNS, [row("0x01", "2026-08-11T00:00:00.000Z")]);
    sim.onMergeSnapshotTaken = rendezvous(2);

    const sql = MERGE_SQL("2026-07-01 00:00:00", "2026-10-01 00:00:00");
    await Promise.all([sim.query({ query: sql }), sim.query({ query: sql })]);

    expect(sim.rowsOf("Target")).toHaveLength(2);
  });

  it("models serialisation, so two sequential MERGEs leave one row", async () => {
    sim.defineTable("Target", COLUMNS, []);
    sim.defineTable("Staging", COLUMNS, [row("0x01", "2026-08-11T00:00:00.000Z")]);

    const sql = MERGE_SQL("2026-07-01 00:00:00", "2026-10-01 00:00:00");
    await sim.query({ query: sql });
    await sim.query({ query: sql });

    expect(sim.rowsOf("Target")).toHaveLength(1);
  });

  it("REFUSES a statement it does not model rather than answering it", async () => {
    await expect(
      sim.query({ query: "SELECT something_novel FROM `p.d.Target` WHERE 1 = 1" })
    ).rejects.toThrow(/SIM_UNRECOGNISED_STATEMENT/);
  });

  it("binds an INSERT by the @names in its VALUES clause, not by parameter order", async () => {
    sim.defineTable("Cover", ["a", "b"], []);
    await sim.query({
      query: "INSERT INTO `p.d.Cover` (a, b) VALUES (@second, @first)",
      params: { first: "F", second: "S" },
    });
    expect(sim.rowsOf("Cover")[0]).toEqual({ a: "S", b: "F" });
  });

  it("loads NDJSON through the table handle the way a staging load does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-load-"));
    const file = join(dir, "rows.ndjson");
    writeFileSync(file, [JSON.stringify(row("0x01", "2026-08-11T00:00:00.000Z"))].join("\n"));

    await sim.dataset("d").table("Staging").load(file, {
      sourceFormat: "NEWLINE_DELIMITED_JSON",
      writeDisposition: "WRITE_TRUNCATE",
      schema: { fields: COLUMNS.map((name) => ({ name })) },
    });

    expect(sim.rowsOf("Staging")).toHaveLength(1);
    const [meta] = await sim.dataset("d").table("Staging").getMetadata();
    expect(meta.schema?.fields?.map((f) => f.name)).toEqual(COLUMNS);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the wire recorder captures the request envelope", () => {
  it("records the method, params and verbatim body of every call", async () => {
    const recorder = makeWireRecorder({ answers: { eth_blockNumber: "0x10" } });
    setRpcTransport(recorder.transport);

    const r = await rpcCall("https://example.invalid/rpc", "eth_blockNumber", []);

    expect(r.ok).toBe(true);
    expect(r.result).toBe("0x10");
    expect(recorder.of("eth_blockNumber")).toHaveLength(1);
    expect(recorder.calls[0].url).toBe("https://example.invalid/rpc");
    expect(recorder.calls[0].body).toContain('"method":"eth_blockNumber"');
  });

  it("surfaces an unanswered method as an error rather than letting the call look successful", async () => {
    const recorder = makeWireRecorder({ answers: {} });
    setRpcTransport(recorder.transport);
    // `rpcCall` converts a thrown transport error into { ok: false }, which is its contract, so
    // the recorder's refusal arrives as a counted error and never as an empty result.
    const r = await rpcCall("https://example.invalid/rpc", "eth_chainId", []);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/WIRE_NO_ANSWER/);
  });

  it("turns a configured failure into a non-ok HTTP response, which rpcCall counts as an error", async () => {
    const recorder = makeWireRecorder({
      answers: { eth_blockNumber: "0x10" },
      failWith: { "https://down.invalid/rpc": 500 },
    });
    setRpcTransport(recorder.transport);

    const r = await rpcCall("https://down.invalid/rpc", "eth_blockNumber", []);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP_500/);
  });
});
