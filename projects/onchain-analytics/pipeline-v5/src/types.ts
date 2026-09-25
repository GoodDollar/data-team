/**
 * types.ts -- Shared interfaces for the v5 pipeline.
 *
 * The v4 L0 contract changed what a row IS. v3 had one table per domain, each naming the fields
 * of the events it expected, so a type here described a decoded event. v4 has one universal raw
 * log table plus a transaction table, so a type here describes a CAPTURE: which reader read which
 * range of which contract, how far the result can be trusted, and what it failed on.
 */

// ---------------------------------------------------------------------------------------------
// Chains and readers
// ---------------------------------------------------------------------------------------------

/**
 * How settled a block has to be before this pipeline treats it as final.
 *
 * Carried as a structure rather than a bare number because the number alone has already been
 * wrong by a factor of thirty and nobody could tell, since a constant records no evidence.
 * `source` is not decoration: it is what lets the next agent check the figure instead of
 * inheriting it.
 */
export interface FinalityConfig {
  /** Blocks behind head that this pipeline stays. */
  blocks: number;
  /** Whether the chain publishes a `finalized` block tag at all. One in this set does not. */
  publishesFinalizedTag: boolean;
  /** Where `blocks` came from, specifically enough to re-measure. */
  source: string;
}

/**
 * What can read this chain, and how well. Reader behaviour is a MOVING property, which is why
 * every row carries the reader that answered it, and why this structure records what is known
 * about each reader rather than one quality score.
 */
export interface ReaderCapability {
  /** HyperSync endpoint, or null where no HyperSync index exists for this chain. */
  hypersyncUrl: string | null;
  /** JSON-RPC endpoints, for confirming negatives, reading state, and enumerating logs where HyperSync cannot. */
  rpcUrls: string[];
  /** Endpoints able to serve historical state. Empty means historical state is unreadable here. */
  archiveRpcUrls: string[];
  /** Largest block span this chain's RPC endpoints accept for eth_getLogs. */
  rpcLogRange: number;
  /**
   * Largest number of log entries an endpoint returns in one response, where the chain caps by
   * RESULT SIZE rather than by block span. null where no such cap has been measured.
   */
  rpcLogResultCap: number | null;
  /**
   * Whether a second INDEPENDENT enumerating reader exists. This decides the best assurance grade
   * obtainable on the chain: without one, every capture is grade C by construction, permanently.
   */
  hasIndependentConfirmingReader: boolean;
  /** What is known about the readers, with the measurement behind it. */
  notes: string;
}

export interface NetworkConfig {
  name: string;
  chainId: number;
  finality: FinalityConfig;
  /** Used for range sizing only. The authoritative end of any range is the chain tip. */
  blocksPerDay: number;
  /** Blocks per fetch chunk. */
  chunkBlocks: number;
  readers: ReaderCapability;
  /** false where this pipeline cannot yet read the chain adequately. A gap, recorded, not hidden. */
  ingestEnabled: boolean;
  /** Why, when ingestEnabled is false. Written into the coverage row so the gap is queryable. */
  disabledReason?: string;
}

// ---------------------------------------------------------------------------------------------
// The contract registry, loaded from the seed rather than hard coded
// ---------------------------------------------------------------------------------------------

/**
 * One implementation era of one contract, from the contract_deployments seed.
 *
 * L0-4. A row must self-identify its era, because the era decides how its topics decode. The era
 * map is the only route to that which does not need a state read per log: 115 of the eras in this
 * system announce nothing at all, so a resolver following announcements alone would leave them
 * unresolved, and `era_map_lookup` cannot fail, so a missing era yields a confident wrong answer.
 */
export interface EraMapEntry {
  chainId: number;
  /** Lowercase. */
  proxyAddress: string;
  eraIndex: number;
  /** Lowercase, or null where the seed records no implementation. */
  implementationAddress: string | null;
  validFromBlock: number;
  /** Exclusive upper bound. null means "still in force". */
  validToBlock: number | null;
}

/** One contract this pipeline reads, on one chain. Derived from the registry, never hand listed. */
export interface CaptureTarget {
  chainId: number;
  network: NetworkConfig;
  /** Lowercase. */
  address: string;
  /** Logical name, for reading. A label, never a key. */
  contractName: string;
  /** The contract's own creation block. R8: an absence claim's lower bound is contract creation. */
  firstBlock: number;
}

export interface SchemaField {
  name: string;
  type: string;
  mode?: string;
}

export type SourceKind = "index" | "rpc" | "explorer" | "unknown";

/** L0-7. How far a captured range can be trusted. */
export type Assurance = "A" | "B" | "C";

/**
 * What HyperSync's own rollback guard reported for a chunk. The previous worker dropped it
 * entirely, which is why the disappearing-log shape was undetectable: the client offers the
 * detector and nothing read it.
 */
export interface RollbackGuard {
  blockNumber: number;
  timestamp: number;
  hash: string;
  firstBlockNumber: number;
  firstParentHash: string;
}

/** One block chunk from one reader. `ok` is false when the range was not covered to its end. */
export interface ChunkResult {
  fromBlock: number;
  toBlock: number;
  ok: boolean;
  logs: any[];
  transactions: any[];
  blocks: any[];
  nextBlock: number | null;
  archiveHeight: number | null;
  rollbackGuard: RollbackGuard | null;
  /** Which reader produced this chunk. Travels onto every row it becomes, per L0-7. */
  sourceKind: SourceKind;
  sourceId: string;
  attempts: string[];
  ms: number;
}

/** The outcome of fetching a whole block range. Reports its own completeness. */
export interface FetchResult {
  fromBlock: number;
  toBlock: number;
  chunksPlanned: number;
  chunksOk: number;
  skipped: [number, number][];
  errors: string[];
  /** Chunks that returned no logs at all. Each is a NEGATIVE requiring confirmation. */
  emptyChunks: [number, number][];
  logsSeen: number;
  complete: boolean;
  sourceKind: SourceKind;
  sourceId: string;
  /**
   * How many INDEPENDENT sources enumerated every chunk of this range and returned the identical
   * set. The minimum across chunks, never the maximum: a capture is only as confirmed as its
   * worst covered chunk, and taking the best would let one well-covered chunk grade a whole range.
   */
  enumeratingSources: number;
  /** Head as the reader saw it, so confirmations_at_capture on each row is reproducible. */
  headAtCapture: number | null;
  /** Every rollback guard the reader returned, in chunk order. */
  rollbackGuards: RollbackGuard[];
}

/**
 * The literal window a MERGE puts on its target's partitioning column. L0-9.
 *
 * MEASURED, and every part is load bearing. A MERGE with no predicate on the target scans the
 * whole target. A window derived INSIDE the statement does not work: a subquery in the ON clause
 * is refused by BigQuery outright, and a predicate correlated to the source row is refused by the
 * partition guard because it eliminates no partitions. So the writing program computes the window
 * and writes it in as a constant, and this pipeline is that program. A window that does not cover
 * an already present row INSERTS A DUPLICATE under the same merge key, on an unguarded table too,
 * which is why the padding exists and why its measured bound is carried with it.
 */
export interface MergeWindow {
  /** Inclusive lower bound, as a SQL TIMESTAMP literal body. */
  fromTs: string;
  /** Exclusive upper bound. */
  toTs: string;
  /** The source rows' own span, before truncation and padding. Recorded on the coverage row. */
  sourceMinTs: string;
  sourceMaxTs: string;
  /** Months of padding applied each side. */
  paddingMonths: number;
}

export interface PipelineOpts {
  mode: "daily" | "backfill" | "verify" | "dedup" | "repair" | "calibrate" | "coverage";
  /** Limit to these chain names, for example CELO,XDC. */
  chains?: string[];
  /** Limit to these contract addresses. */
  addresses?: string[];
  fromBlock?: number;
  toBlock?: number;
  /** verify and repair: limit to these protocol days. */
  days?: number[];
  /** repair and dedup: report what would change without changing it. */
  dryRun?: boolean;
  /** Guard. Largest span one capture may attempt. Default is 30 days of blocks for that chain. */
  maxCaptureBlocks?: number;
  /** Guard. Largest number of contracts one run may attempt. */
  maxCaptures?: number;
}

export interface PipelineResult {
  succeeded: number;
  failed: number;
  totalRows: number;
}

/**
 * L0-8. One row per range that was READ: by whom, over what, and what it failed on.
 *
 * A capture is one source reading one contract over one block range. A run contains many. This
 * is what makes an empty result interpretable at all: a block range with no coverage row was
 * never scanned, and a model that reads its emptiness as a measurement is wrong.
 *
 * It is also the resume record. A watermark that means "the furthest row I happen to hold"
 * cannot represent a hole, and this pipeline has already created one.
 */
export interface CoverageRecord {
  captureId: string;
  runId: string;
  chainId: number;
  /** Kept alongside chainId so the ledger stays readable next to the rows already in the table. */
  network: string;
  /** Lowercase, or null where one capture batched several addresses into a single query. */
  contractAddress: string | null;
  /** RawLogs, Transactions, or ContractStateSnapshots. */
  targetTable: string;
  /** Retained for continuity with the rows already in this table. */
  tableId: string;
  fromBlock: number;
  toBlock: number;
  /** complete, incomplete, unconfirmed_empty, nothing_to_fetch, or capability_gap. Never "success". */
  status: string;
  chunksPlanned: number;
  chunksOk: number;
  skippedRanges: string;
  rowsMerged: number;
  rowsInserted: number;
  rowsUpdated: number;
  logsSeen: number;
  sourceKind: SourceKind;
  sourceId: string;
  confirmingSourceKind: string | null;
  confirmingSourceId: string | null;
  /** identical, refuted_emptiness, disagreed, or unavailable. A disagreement is a RESULT. */
  confirmationResult: string;
  assurance: Assurance;
  headAtCapture: number | null;
  missRateCalibrated: number | null;
  passesRun: number | null;
  gainSeries: string | null;
  startedAt: string;
  completedAt: string;
  errorMessage: string;
}

export interface PipelineRunRecord {
  runId: string;
  mode: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  totalRowsMerged: number;
  contractsProcessed: number;
  contractsFailed: number;
  host: string;
  errorMessage?: string;
  chainsProcessed: string;
  capturesPlanned: number;
  capturesOk: number;
  capturesFailed: number;
  pipelineVersion: string;
}
