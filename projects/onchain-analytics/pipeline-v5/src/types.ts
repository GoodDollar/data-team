/**
 * types.ts -- Shared interfaces for the v5 pipeline.
 */

export interface NetworkConfig {
  url: string;
  name: string;
  chainId: number;
  finalityBlocks: number;
  /** MEASURED, not assumed. See config.ts for how each figure was established. */
  blocksPerDay: number;
  /** Blocks per HyperSync request. Sized so one chunk stays well inside the per-request limit. */
  chunkBlocks: number;
  /** JSON-RPC endpoints used to confirm negatives and to read contract state. */
  rpcUrls: string[];
  /** Largest block span this chain's public RPC endpoints accept for eth_getLogs. */
  rpcLogRange: number;
}

export interface SchemaField {
  name: string;
  type: string;
}

export interface NetworkBinding {
  network: NetworkConfig;
  firstBlock: number;
  contracts: string[];
}

export interface ContractConfig {
  tableId: string;
  schema: SchemaField[];
  abi: readonly any[];
  networkBindings: NetworkBinding[];
  decodeToRow: (
    eventName: string,
    args: any,
    logCtx: LogContext,
    network: NetworkConfig,
    runId: string
  ) => Record<string, any> | null;
}

export interface LogContext {
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number; // Unix seconds
  txHash: string;
  txIndex: number;
  logIndex: number;
  contractAddress: string;
  /** L0-1. All four topic slots and the data blob, retained verbatim. */
  topics: (string | null)[];
  logData: string;
  txFrom: string | null;
  txTo: string | null;
  txValue: string | null;
  txStatus: number | null;
  txNonce: number | null;
  gasUsed: number | null;
  effectiveGasPrice: string | null;
}

/** One HyperSync block chunk. `ok` is false when the range was not covered to its end. */
export interface ChunkResult {
  fromBlock: number;
  toBlock: number;
  ok: boolean;
  logs: any[];
  transactions: any[];
  blocks: any[];
  nextBlock: number | null;
  archiveHeight: number | null;
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
}

export interface DecodedRow {
  [key: string]: any;
}

export interface PipelineOpts {
  mode: "daily" | "backfill" | "verify" | "dedup" | "repair" | "calibrate";
  contracts?: string[];
  fromBlock?: number;
  toBlock?: number;
  /** verify and repair: limit to these protocol days. */
  days?: number[];
  /** repair and dedup: report what would change without changing it. */
  dryRun?: boolean;
}

export interface PipelineResult {
  succeeded: number;
  failed: number;
  totalRows: number;
}

export interface IngestionRecord {
  network: string;
  tableId: string;
  ingestionDate: string;
  status: "success" | "failed" | "partial";
  lastBlock: number;
  rowCount: number;
  startedAt: string;
  completedAt: string;
  errorMessage?: string;
  runId: string;
}

/**
 * One row of the coverage ledger. "Did we cover blocks X to Y, and how many times" becomes a
 * query rather than a belief. Written for EVERY attempted range, including failed ones, because
 * a range that was attempted and failed is the single most important thing to be able to find.
 */
export interface CoverageRecord {
  runId: string;
  network: string;
  tableId: string;
  fromBlock: number;
  toBlock: number;
  /** complete, incomplete, or unconfirmed_empty. Never "success". */
  status: string;
  chunksPlanned: number;
  chunksOk: number;
  skippedRanges: string;
  rowsMerged: number;
  rowsInserted: number;
  rowsUpdated: number;
  logsSeen: number;
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
}
