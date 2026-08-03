/**
 * types.ts -- Shared interfaces for the v5 pipeline.
 */

export interface NetworkConfig {
  url: string;
  name: string;
  chainId: number;
  finalityBlocks: number;
  blocksPerDay: number;
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
    networkName: string
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
}

export interface DecodedRow {
  [key: string]: any;
}

export interface PipelineOpts {
  mode: "daily" | "backfill";
  contracts?: string[];
  fromBlock?: number;
  toBlock?: number;
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
