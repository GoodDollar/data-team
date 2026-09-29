/**
 * The sandbox guard, tested as a control rather than as a helper.
 *
 * The question each test answers is "what does this refuse", not "does the happy path work". A
 * convenience wrapper and a control are indistinguishable while nothing goes wrong; they differ
 * only at the moment something does.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PROTECTED_DATASETS, SANDBOX_PURPOSE_LABEL, SandboxRefusal,
  isProtectedDataset, assertNotProtectedDataset, sandboxDatasetId, purposeLabelValue,
  createSandbox, dropSandbox, withSandbox, setDatasetAdmin,
  type DatasetAdmin, type CreateDatasetOptions,
} from "../../src/sandbox.js";

/** An in-memory project. Records every call so a test can assert what did NOT happen. */
class FakeAdmin implements DatasetAdmin {
  datasets = new Map<string, Record<string, string>>();
  readonly deletes: string[] = [];
  readonly creates: string[] = [];
  listThrows: Error | null = null;

  constructor(seed: string[] = []) {
    for (const id of seed) this.datasets.set(id, {});
  }

  async listDatasets(): Promise<string[]> {
    if (this.listThrows) throw this.listThrows;
    return [...this.datasets.keys()].sort();
  }

  async createDataset(datasetId: string, options: CreateDatasetOptions): Promise<void> {
    this.creates.push(datasetId);
    this.datasets.set(datasetId, options.labels);
  }

  async labelsOf(datasetId: string): Promise<Record<string, string> | null> {
    return this.datasets.get(datasetId) ?? null;
  }

  async deleteDataset(datasetId: string): Promise<void> {
    this.deletes.push(datasetId);
    this.datasets.delete(datasetId);
  }
}

let admin: FakeAdmin;

beforeEach(() => {
  admin = new FakeAdmin(["BlockchainEvents", "Staging", "Semantic", "Marts", "dev_sandbox"]);
  setDatasetAdmin(admin);
});

afterEach(() => setDatasetAdmin(null));

describe("the refusal is by hard-coded name, not by configuration", () => {
  it("names BlockchainEvents in the source and refuses it", () => {
    expect(PROTECTED_DATASETS).toContain("BlockchainEvents");
    expect(isProtectedDataset("BlockchainEvents")).toBe(true);
    expect(() => assertNotProtectedDataset("BlockchainEvents", "test")).toThrow(SandboxRefusal);
  });

  it("refuses every dbt layer built on production too", () => {
    for (const name of ["Staging", "Semantic", "Marts"]) {
      expect(() => assertNotProtectedDataset(name, "test")).toThrow(SandboxRefusal);
    }
  });

  it("refuses regardless of casing, because a dataset id comparison is not case sensitive here", () => {
    expect(() => assertNotProtectedDataset("blockchainevents", "test")).toThrow(SandboxRefusal);
    expect(() => assertNotProtectedDataset("  BLOCKCHAINEVENTS  ", "test")).toThrow(SandboxRefusal);
  });

  it("refuses to CREATE a sandbox named BlockchainEvents, and writes nothing while refusing", async () => {
    // config.ts defaults DATASET_ID to BlockchainEvents, so this is the exact shape of the
    // accident: a caller that forgets one environment variable asks for production by name.
    await expect(createSandbox({ purpose: "unit-03-test", datasetId: "BlockchainEvents" }))
      .rejects.toThrow(/protected dataset/);
    expect(admin.creates).toEqual([]);
  });

  it("refuses to DELETE BlockchainEvents even when handed a handle that claims it is a sandbox", async () => {
    await expect(dropSandbox({
      datasetId: "BlockchainEvents",
      purposeLabel: "unit-03-test",
      location: "US",
      createdAt: new Date().toISOString(),
    })).rejects.toThrow(/protected dataset/);
    expect(admin.deletes).toEqual([]);
  });

  it("lets an ordinary sandbox name through, so the refusal discriminates", () => {
    expect(isProtectedDataset("sbx_unit03_coverage_20260929T014230Z_q3bywk")).toBe(false);
    expect(() => assertNotProtectedDataset("sbx_unit03_coverage", "test")).not.toThrow();
  });
});

describe("a sandbox must be uniquely named and purpose-labelled", () => {
  it("refuses a name that already exists rather than reusing it", async () => {
    await expect(createSandbox({ purpose: "unit-03-test", datasetId: "dev_sandbox" }))
      .rejects.toThrow(/already exists/);
    expect(admin.creates).toEqual([]);
  });

  it("refuses when the listing that would prove uniqueness fails", async () => {
    admin.listThrows = new Error("listing unavailable");
    await expect(createSandbox({ purpose: "unit-03-test" })).rejects.toThrow("listing unavailable");
    expect(admin.creates).toEqual([]);
  });

  it("generates a legal, unique, self-describing dataset id", () => {
    const id = sandboxDatasetId("unit-03 coverage", new Date("2026-09-29T01:42:30.123Z"), "q3bywk");
    expect(id).toBe("sbx_unit_03_coverage_20260929T014230Z_q3bywk");
    expect(id).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it("carries the purpose label at creation", async () => {
    const handle = await createSandbox({ purpose: "unit-03-coverage" });
    expect(admin.datasets.get(handle.datasetId)).toEqual({ [SANDBOX_PURPOSE_LABEL]: "unit-03-coverage" });
  });

  it("refuses a purpose that cannot become a legal label", () => {
    expect(() => purposeLabelValue("!!")).toThrow(SandboxRefusal);
    expect(purposeLabelValue("Unit 03 Coverage")).toBe("unit-03-coverage");
  });
});

describe("cleanup checks the label first and proves absence by listing", () => {
  it("deletes only after reading the label back off the live dataset", async () => {
    const handle = await createSandbox({ purpose: "unit-03-coverage" });
    const result = await dropSandbox(handle);

    expect(result.labelChecked).toBe("unit-03-coverage");
    expect(admin.deletes).toEqual([handle.datasetId]);
    expect(result.provenAbsent).toBe(true);
    expect(result.datasetsAfter).not.toContain(handle.datasetId);
  });

  it("refuses to delete when the live label disagrees with the handle", async () => {
    const handle = await createSandbox({ purpose: "unit-03-coverage" });
    // Something else now occupies the name. The handle is a claim; the label is the evidence.
    admin.datasets.set(handle.datasetId, { [SANDBOX_PURPOSE_LABEL]: "someone-elses-work" });

    await expect(dropSandbox(handle)).rejects.toThrow(/not provably the one this run created/);
    expect(admin.deletes).toEqual([]);
  });

  it("refuses to delete a dataset carrying no purpose label at all", async () => {
    // The two leftover datasets in this project carry no labels, which is why neither could be
    // judged disposable. An unlabelled dataset is never this run's to remove.
    const handle = await createSandbox({ purpose: "unit-03-coverage" });
    admin.datasets.set(handle.datasetId, {});

    await expect(dropSandbox(handle)).rejects.toThrow(/purpose=\(none\)/);
    expect(admin.deletes).toEqual([]);
  });

  it("reports NOT proven absent when the delete succeeds and the listing still shows it", async () => {
    // A cleanup receipt in this corpus is known wrong at least once. The listing decides, not
    // the delete call's return value.
    const handle = await createSandbox({ purpose: "unit-03-coverage" });
    admin.deleteDataset = async (id: string) => { admin.deletes.push(id); };

    const result = await dropSandbox(handle);
    expect(admin.deletes).toEqual([handle.datasetId]);
    expect(result.provenAbsent).toBe(false);
    expect(result.detail).toMatch(/still present/);
  });

  it("treats an already-absent dataset as nothing to do, not as a failure", async () => {
    const handle = await createSandbox({ purpose: "unit-03-coverage" });
    admin.datasets.delete(handle.datasetId);

    const result = await dropSandbox(handle);
    expect(result.provenAbsent).toBe(true);
    expect(result.labelChecked).toBeNull();
    expect(admin.deletes).toEqual([]);
  });
});

describe("withSandbox cleans up on both paths", () => {
  it("drops the sandbox after the work succeeds", async () => {
    const { result, cleanup } = await withSandbox({ purpose: "unit-03-coverage" }, async (h) => h.datasetId);
    expect(admin.datasets.has(result)).toBe(false);
    expect(cleanup.provenAbsent).toBe(true);
  });

  it("drops the sandbox when the work throws, and still raises the original error", async () => {
    await expect(
      withSandbox({ purpose: "unit-03-coverage" }, async () => { throw new Error("the work failed"); })
    ).rejects.toThrow("the work failed");

    expect(admin.creates).toHaveLength(1);
    expect(admin.deletes).toEqual(admin.creates);
    expect([...admin.datasets.keys()]).not.toContain(admin.creates[0]);
  });
});
