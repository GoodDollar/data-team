/**
 * adapters.ts -- the replaceable edges of this program.
 *
 * WHY THIS FILE EXISTS. Every defect the readiness audit reproduced sits behind something this
 * process cannot do in a test: a BigQuery job, a socket, a wall clock, a second process. Until
 * those edges are replaceable, the only way to exercise a defect is to run the real thing against
 * real infrastructure, which is how a warehouse gets a production incident during an audit.
 *
 * WHAT THIS FILE IS NOT. It is not a fix for anything. Every default below is the behaviour the
 * program has today, written down rather than changed -- with one exception, now that the write
 * lock behind `C1` has been built. `NO_LOCK` is still here and still means "no exclusion at
 * all", but it is no longer what production gets: `bq.ts` registers the real lease as a factory
 * on import. Keeping `NO_LOCK` exported is what lets a test install the absence deliberately and
 * show the difference, which is how the control is proven rather than asserted.
 *
 * Each adapter is a module-level holder with a setter and a reset, rather than a parameter
 * threaded through every call site. That is a deliberate trade: threading would have touched
 * every function in the pipeline. A holder changes construction only.
 */

import type { MergeWindow } from "./types.js";

// --------------------------------------------------------------------------- BigQuery

/**
 * The narrow slice of `@google-cloud/bigquery` this pipeline actually uses. Narrow on purpose:
 * a test double implements six members instead of the whole client surface, and anything the
 * pipeline starts using has to be added here first, where it is visible.
 */
export interface BigQueryTableLike {
  load(source: string, metadata: unknown): Promise<unknown>;
  getMetadata(): Promise<[{ schema?: { fields?: { name: string }[] } }, ...unknown[]]>;
}

export interface BigQueryDatasetLike {
  table(tableId: string): BigQueryTableLike;
}

export interface BigQueryClientLike {
  query(request: {
    query: string;
    params?: Record<string, unknown>;
    types?: Record<string, string>;
    projectId?: string;
    /** The per-job cost ceiling. A string because the REST field is an int64. */
    maximumBytesBilled?: string;
  }): Promise<[any[], ...unknown[]]>;
  dataset(datasetId: string, options?: { projectId?: string }): BigQueryDatasetLike;
}

let bigQueryClient: BigQueryClientLike | null = null;
let bigQueryFactory: (() => BigQueryClientLike) | null = null;

/**
 * Register how a real client is built, without building one.
 *
 * `bq.ts` constructed its client at import time, which means importing any module that
 * transitively reaches it resolved credentials as a side effect of an import. A test that only
 * wanted to read a pure function paid for a credential lookup, and a machine with no credentials
 * could not import the module at all.
 */
export function setBigQueryFactory(factory: () => BigQueryClientLike): void {
  bigQueryFactory = factory;
}

/** Replace the client. Tests use this; nothing in `src/` does. */
export function setBigQueryClient(client: BigQueryClientLike | null): void {
  bigQueryClient = client;
}

export function getBigQueryClient(): BigQueryClientLike {
  if (bigQueryClient) return bigQueryClient;
  if (!bigQueryFactory) {
    throw new Error(
      "BQ_CLIENT_UNSET: no BigQuery client and no factory registered. `bq.ts` registers the real " +
      "factory on import; a test must call setBigQueryClient() before any query."
    );
  }
  bigQueryClient = bigQueryFactory();
  return bigQueryClient;
}

// --------------------------------------------------------------------------- RPC transport

/** What `rpc.ts` needs from `fetch`. Kept to exactly this so a recorder is a few lines. */
export interface RpcTransportResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type RpcTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<RpcTransportResponse>;

const REAL_TRANSPORT: RpcTransport = (url, init) =>
  fetch(url, init) as unknown as Promise<RpcTransportResponse>;

let rpcTransport: RpcTransport = REAL_TRANSPORT;

export function setRpcTransport(transport: RpcTransport | null): void {
  rpcTransport = transport ?? REAL_TRANSPORT;
}

export function getRpcTransport(): RpcTransport {
  return rpcTransport;
}

// --------------------------------------------------------------------------- Clock

export interface Clock {
  now(): Date;
}

const REAL_CLOCK: Clock = { now: () => new Date() };

let clock: Clock = REAL_CLOCK;

export function setClock(replacement: Clock | null): void {
  clock = replacement ?? REAL_CLOCK;
}

export function now(): Date {
  return clock.now();
}

/** The form every timestamp column in this warehouse is written in. */
export function nowIso(): string {
  return clock.now().toISOString();
}

// --------------------------------------------------------------------------- Write lock

/**
 * The cross-process write lease.
 *
 * C1: two concurrent captures of the same range each staged their own batch, each measured the
 * target before and after their own MERGE, and both exited zero while the table held two rows
 * per merge key. The control is now real and lives in `writelock.ts`; `bq.ts` registers it as a
 * FACTORY on import, for the same reason the BigQuery client is a factory -- building one at
 * import time would make every test that transitively reaches this module touch the filesystem.
 *
 * `NO_LOCK` remains exported, and it is no longer the production default. It is the absence of
 * the control written down, so a test can install it deliberately and show what the write path
 * does without exclusion. `acquire` may return null to mean refused, which is what turns a
 * losing writer into a nonzero exit rather than a duplicate row.
 */
export interface WriteLockHandle {
  release(): Promise<void>;
}

export interface WriteLock {
  /** Null means refused. A handle means the caller may mutate `tableId` over `window`. */
  acquire(tableId: string, window: MergeWindow | null): Promise<WriteLockHandle | null>;
}

const GRANTED: WriteLockHandle = { release: async () => { /* nothing is held */ } };

/** Grants every request instantly and excludes nothing. The absence of a lock, written down. */
export const NO_LOCK: WriteLock = { acquire: async () => GRANTED };

let writeLock: WriteLock | null = null;
let writeLockFactory: (() => WriteLock) | null = null;

/** Register how the real lock is built, without building one. `bq.ts` calls this on import. */
export function setWriteLockFactory(factory: () => WriteLock): void {
  writeLockFactory = factory;
}

/** Replace the lock. Tests use this; nothing in `src/` does. */
export function setWriteLock(replacement: WriteLock | null): void {
  writeLock = replacement;
}

/**
 * The lock in force.
 *
 * Falls back to `NO_LOCK` only when no factory has been registered at all, which means nothing
 * has imported `bq.ts` and therefore nothing is about to write.
 */
export function getWriteLock(): WriteLock {
  if (writeLock) return writeLock;
  if (!writeLockFactory) return NO_LOCK;
  writeLock = writeLockFactory();
  return writeLock;
}

// --------------------------------------------------------------------------- Reader

/**
 * The whole reader, replaceable as one unit.
 *
 * A chain's reader is either a HyperSync index in a child process or a rotation of JSON-RPC
 * endpoints. Neither can run in a test, and neither can be made to return a chosen shape by
 * stubbing `fetch` alone: the index path never touches `fetch` at all. So the dispatch point in
 * `reader.ts` consults this first.
 *
 * `null` means "use the real reader", which is what every production path gets.
 */
export type FetchRangeFn = (
  network: unknown,
  addresses: string[],
  fromBlock: number,
  toBlock: number,
  onChunk: (chunk: any) => Promise<void>
) => Promise<any>;

let readerOverride: FetchRangeFn | null = null;

export function setReaderOverride(replacement: FetchRangeFn | null): void {
  readerOverride = replacement;
}

export function getReaderOverride(): FetchRangeFn | null {
  return readerOverride;
}

// --------------------------------------------------------------------------- HyperSync worker

/**
 * The HyperSync worker call, replaceable.
 *
 * `setReaderOverride` replaces the WHOLE reader, which is the right seam for a test about the
 * pipeline and the wrong one for a test about the index reader itself: everything in
 * `hypersync.ts` -- chunk planning, bounded retries, the short-collection refusal, empty-chunk
 * tracking and rollback-guard forwarding -- sits BELOW that override and is unreachable through
 * it. The only thing underneath is `spawn`, so this is the seam.
 *
 * It replaces one request/response, not the logic around it, so a test exercises the real
 * chunking and the real retry policy against a scripted worker.
 */
export type WorkerRunner = (
  request: Record<string, unknown>,
  timeoutMs: number
) => Promise<Record<string, any>>;

let workerRunner: WorkerRunner | null = null;

export function setWorkerRunner(replacement: WorkerRunner | null): void {
  workerRunner = replacement;
}

export function getWorkerRunner(): WorkerRunner | null {
  return workerRunner;
}

// --------------------------------------------------------------------------- Notifier

export interface Notifier {
  post(payload: Record<string, unknown>): Promise<void>;
}

let notifier: Notifier | null = null;

export function setNotifier(replacement: Notifier | null): void {
  notifier = replacement;
}

export function getNotifier(): Notifier | null {
  return notifier;
}

// --------------------------------------------------------------------------- Reset

/**
 * Put every edge back to its real default.
 *
 * Adapters are module-level, so one test leaking a double into the next would make a suite whose
 * result depends on file order. Every test file calls this in `afterEach`.
 */
export function resetAdapters(): void {
  bigQueryClient = null;
  setRpcTransport(null);
  setClock(null);
  setWriteLock(null);
  setNotifier(null);
  setReaderOverride(null);
  setWorkerRunner(null);
}
