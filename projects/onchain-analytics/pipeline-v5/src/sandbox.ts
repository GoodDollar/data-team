/**
 * sandbox.ts -- the control that stands between a disposable experiment and the production dataset.
 *
 * WHY THIS IS A CONTROL AND NOT A CONVENIENCE WRAPPER. The reason is on the record twice. One
 * maintenance script extracted a single CREATE statement from a DDL file by string substitution,
 * the substitution rewrote only the first table reference, and BigQuery ran the remainder as a
 * multi-statement script against `gooddollar.BlockchainEvents`: it dropped and recreated a
 * production table. And two undocumented sandbox datasets sit in this project today, one of them
 * recorded as deleted in a maintenance note and still present. So a cleanup receipt here is known
 * wrong at least once, and a script that merely intends to hit a sandbox is not evidence of
 * anything.
 *
 * THE FOUR RULES, each of which exists because its absence has already cost something:
 *
 *   1. PROTECTED DATASETS ARE REFUSED BY HARD-CODED NAME. Not by a configuration default. The
 *      default value of `DATASET_ID` in `config.ts` IS `BlockchainEvents`, so an agent that
 *      forgets one environment variable points the whole pipeline at production and nothing in
 *      the configuration layer objects. A refusal that a different config can flip is not a
 *      control; this one cannot be reached by any configuration at all.
 *   2. THE TARGET MUST BE UNIQUELY NAMED, and its absence is checked against a live listing
 *      before creation. Reusing a name is how a long-lived scratch space appears.
 *   3. A PURPOSE LABEL IS MANDATORY. The two leftover datasets in this project carry no labels,
 *      which is precisely why nobody could say whether either was disposable.
 *   4. THE LABEL IS READ BACK AND CHECKED BEFORE ANYTHING IS DELETED, and absence afterwards is
 *      proven by a LISTING, never by the delete call's return value.
 *
 * MEASURED, 2026-09-29, before anything was built on it: project-scope `bigquery.datasets.delete`
 * is DENIED for the ordinary analytics identity, and the delete of a dataset that identity created
 * still returns HTTP 204, after which the dataset is absent from a listing with an error count of
 * zero. A project-scope denial is a floor, not a ceiling, because the creator of a dataset becomes
 * its owner.
 */

import { log } from "./log.js";

/** Refusal by this control. Distinct from an API error so a caller cannot conflate the two. */
export class SandboxRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRefusal";
  }
}

/**
 * Datasets no sandbox operation may ever touch, by name.
 *
 * `BlockchainEvents` is the production raw layer. The other three are the dbt layers built on it.
 * This list is a literal in the source: it is not read from configuration, not overridable by an
 * environment variable, and not a default parameter.
 */
export const PROTECTED_DATASETS: readonly string[] = [
  "BlockchainEvents",
  "Staging",
  "Semantic",
  "Marts",
];

/** The label key every sandbox must carry. Checked before any delete. */
export const SANDBOX_PURPOSE_LABEL = "purpose";

/** BigQuery dataset ids accept letters, digits and underscores only. */
const DATASET_ID_PATTERN = /^[A-Za-z0-9_]{1,1024}$/;

/** BigQuery label values accept lowercase letters, digits, dashes and underscores, max 63. */
const LABEL_VALUE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,62}$/;

export function isProtectedDataset(datasetId: string): boolean {
  const target = datasetId.trim().toLowerCase();
  return PROTECTED_DATASETS.some((p) => p.toLowerCase() === target);
}

/**
 * The refusal itself. Every path in this module goes through it, and so must every caller that
 * is about to write anywhere on this identity's behalf.
 */
export function assertNotProtectedDataset(datasetId: string, operation: string): void {
  if (isProtectedDataset(datasetId)) {
    throw new SandboxRefusal(
      `REFUSED: ${operation} targets ${datasetId}, which is a protected dataset. This refusal is ` +
      `hard-coded in sandbox.ts and cannot be turned off by configuration. If a sandbox is ` +
      `wanted, name one; if production is wanted, this is not the route to it.`
    );
  }
}

/** What this module needs from a BigQuery administrative client, and nothing more. */
export interface DatasetAdmin {
  /** Every dataset id in the project. Throws on failure; an errored listing proves nothing. */
  listDatasets(): Promise<string[]>;
  createDataset(datasetId: string, options: CreateDatasetOptions): Promise<void>;
  /** The dataset's labels, or null when it does not exist. */
  labelsOf(datasetId: string): Promise<Record<string, string> | null>;
  deleteDataset(datasetId: string, options: { deleteContents: boolean }): Promise<void>;
}

export interface CreateDatasetOptions {
  location: string;
  labels: Record<string, string>;
  description: string;
  defaultTableExpirationMs: number;
}

let admin: DatasetAdmin | null = null;
let adminFactory: (() => DatasetAdmin) | null = null;

/** Register how a real admin client is built, without building one. Same reason as `bq.ts`. */
export function setDatasetAdminFactory(factory: () => DatasetAdmin): void {
  adminFactory = factory;
}

/** Replace the admin. Tests use this; nothing in `src/` does. */
export function setDatasetAdmin(replacement: DatasetAdmin | null): void {
  admin = replacement;
}

export function getDatasetAdmin(): DatasetAdmin {
  if (admin) return admin;
  if (!adminFactory) {
    throw new SandboxRefusal(
      "SANDBOX_ADMIN_UNSET: no dataset admin and no factory registered. Call " +
      "setDatasetAdminFactory() with a real client, or setDatasetAdmin() with a double."
    );
  }
  admin = adminFactory();
  return admin;
}

export interface SandboxOptions {
  /** What this sandbox is FOR. Becomes the `purpose` label and part of the dataset name. */
  purpose: string;
  /** Defaults to `US`, which every dataset in this project uses. */
  location?: string;
  /**
   * Belt and braces. Every table created in the sandbox expires on its own, so a failed cleanup
   * leaves nothing durable behind rather than a permanent scratch space.
   */
  tableExpirationHours?: number;
  /** Supply a name instead of generating one. Still checked for uniqueness and protection. */
  datasetId?: string;
}

export interface SandboxHandle {
  readonly datasetId: string;
  readonly purposeLabel: string;
  readonly location: string;
  readonly createdAt: string;
}

/**
 * A unique, self-describing dataset name.
 *
 * Reads as what it is at a glance in the console, which the two leftovers do not:
 * `sbx_unit03_coverage_20260929T014230Z_q3bywk`.
 */
export function sandboxDatasetId(purpose: string, now: Date, nonce: string): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "").replace(/\d{3}Z$/, "Z");
  const slug = purpose.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const id = `sbx_${slug}_${stamp}_${nonce}`;
  if (!DATASET_ID_PATTERN.test(id)) {
    throw new SandboxRefusal(`Generated dataset id ${id} is not a legal BigQuery dataset id.`);
  }
  return id;
}

/** The purpose, in the form a BigQuery label value accepts. */
export function purposeLabelValue(purpose: string): string {
  const value = purpose.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (!LABEL_VALUE_PATTERN.test(value)) {
    throw new SandboxRefusal(
      `Purpose "${purpose}" does not reduce to a legal BigQuery label value. Use at least three ` +
      `characters of letters, digits, dashes or underscores.`
    );
  }
  return value;
}

/**
 * Create a disposable, labelled sandbox dataset.
 *
 * Refuses a protected name, refuses a name that already exists, and refuses to create anything
 * without a purpose.
 */
export async function createSandbox(options: SandboxOptions): Promise<SandboxHandle> {
  const purposeLabel = purposeLabelValue(options.purpose);
  const location = options.location ?? "US";
  const expirationHours = options.tableExpirationHours ?? 6;
  const client = getDatasetAdmin();

  const datasetId = options.datasetId
    ?? sandboxDatasetId(options.purpose, new Date(), Math.random().toString(36).slice(2, 8));

  assertNotProtectedDataset(datasetId, "sandbox creation");
  if (!DATASET_ID_PATTERN.test(datasetId)) {
    throw new SandboxRefusal(`${datasetId} is not a legal BigQuery dataset id.`);
  }

  // Uniqueness is checked against a live listing, not against a naming convention. If the listing
  // fails, this throws rather than proceeding: an unverified name is not a unique one.
  const existing = await client.listDatasets();
  if (existing.includes(datasetId)) {
    throw new SandboxRefusal(
      `REFUSED: dataset ${datasetId} already exists. A sandbox is created for one piece of work ` +
      `and dropped after it, so reusing a name would make its contents ambiguous.`
    );
  }

  await client.createDataset(datasetId, {
    location,
    labels: { [SANDBOX_PURPOSE_LABEL]: purposeLabel },
    description:
      `Disposable sandbox for ${options.purpose}. Created by pipeline-v5 sandbox.ts. ` +
      `Every table expires after ${expirationHours}h. Safe to delete.`,
    defaultTableExpirationMs: expirationHours * 60 * 60 * 1000,
  });

  log.info(`Sandbox ${datasetId} created in ${location} for ${purposeLabel}`);
  return { datasetId, purposeLabel, location, createdAt: new Date().toISOString() };
}

export interface CleanupResult {
  readonly datasetId: string;
  /** True only when a LISTING taken after the delete does not contain the dataset. */
  readonly provenAbsent: boolean;
  readonly datasetsAfter: readonly string[];
  readonly labelChecked: string | null;
  readonly detail: string;
}

/**
 * Drop a sandbox, having first checked it is one, and prove it is gone.
 *
 * THE LABEL CHECK COMES BEFORE THE DELETE, not after and not instead of it. A handle is a claim
 * about what a dataset is; the label read back off the live dataset is evidence. They disagree
 * exactly when something has gone wrong, which is the moment a delete must not proceed.
 *
 * ABSENCE IS PROVEN BY A LISTING. The delete call's own success is not admissible: this project
 * holds a cleanup receipt that says a dataset was dropped, and that dataset is still there.
 */
export async function dropSandbox(handle: SandboxHandle): Promise<CleanupResult> {
  const client = getDatasetAdmin();
  assertNotProtectedDataset(handle.datasetId, "sandbox cleanup");

  const labels = await client.labelsOf(handle.datasetId);
  if (labels === null) {
    const after = await client.listDatasets();
    return {
      datasetId: handle.datasetId,
      provenAbsent: !after.includes(handle.datasetId),
      datasetsAfter: after,
      labelChecked: null,
      detail: `${handle.datasetId} does not exist, so there was nothing to delete.`,
    };
  }

  const found = labels[SANDBOX_PURPOSE_LABEL] ?? null;
  if (found !== handle.purposeLabel) {
    throw new SandboxRefusal(
      `REFUSED: ${handle.datasetId} carries ${SANDBOX_PURPOSE_LABEL}=${found ?? "(none)"} and this ` +
      `handle claims ${handle.purposeLabel}. Nothing is deleted when the dataset is not provably ` +
      `the one this run created.`
    );
  }

  await client.deleteDataset(handle.datasetId, { deleteContents: true });

  const after = await client.listDatasets();
  const provenAbsent = !after.includes(handle.datasetId);
  if (!provenAbsent) {
    log.error(
      `Sandbox ${handle.datasetId} is STILL PRESENT after a delete that reported success. ` +
      `The listing is the measurement and it says the dataset is there.`
    );
  }

  return {
    datasetId: handle.datasetId,
    provenAbsent,
    datasetsAfter: after,
    labelChecked: found,
    detail: provenAbsent
      ? `${handle.datasetId} is absent from a listing of ${after.length} dataset(s) taken after the delete.`
      : `${handle.datasetId} is still present in a listing of ${after.length} dataset(s) taken after the delete.`,
  };
}

/**
 * Run work against a fresh sandbox and drop it afterwards, whatever the work did.
 *
 * The cleanup runs on the failure path too, because the run that leaves a dataset behind is
 * always the one that went wrong.
 */
export async function withSandbox<T>(
  options: SandboxOptions,
  work: (handle: SandboxHandle) => Promise<T>,
): Promise<{ result: T; cleanup: CleanupResult }> {
  const handle = await createSandbox(options);
  try {
    const result = await work(handle);
    return { result, cleanup: await dropSandbox(handle) };
  } catch (e) {
    const cleanup = await dropSandbox(handle).catch((ce: Error) => {
      log.error(`Sandbox cleanup failed after the work threw: ${ce.message}`);
      return null;
    });
    if (cleanup && !cleanup.provenAbsent) {
      log.error(`Sandbox ${handle.datasetId} was NOT proven absent after a failed run.`);
    }
    throw e;
  }
}
