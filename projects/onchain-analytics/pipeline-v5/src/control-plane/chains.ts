/**
 * chains.ts -- the chain-name/chain-id authority, read from the `chains` seed.
 *
 * Task 8 exists because a composite foreign key cannot catch this class of error. `event_surface`
 * points at `contract_deployments` by (chain, proxy_address, era_index); if a row carries
 * chain='FUSE' with chain_id=42220, both seeds agree with each other and every referential test
 * passes while the row describes a contract that does not exist. It was measured that 14 addresses
 * are deployed at the same address with the same era index on two chains, so a wrong chain is
 * exactly the error that survives a composite key. This map is the independent third opinion.
 */

import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { readStrictCsv, SeedParseError } from "./csv.js";
import { parseFiniteInt } from "./int64.js";
import { bool, nonEmpty } from "./fields.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEEDS_DIR = resolve(join(HERE, "..", "..", "..", "gd_dbt", "seeds"));
export const CHAINS_PATH = join(SEEDS_DIR, "chains.csv");

export const CHAINS_HEADER = [
  "chain", "chain_id", "chain_name", "native_token_symbol", "explorer_url_template", "is_active", "notes",
] as const;

export interface ChainRow {
  readonly line: number;
  readonly chain: string;
  readonly chainId: number;
  readonly isActive: boolean;
}

export interface ChainAuthority {
  readonly byName: ReadonlyMap<string, number>;
  readonly byId: ReadonlyMap<number, string>;
  readonly rows: readonly ChainRow[];
  readonly path: string;
}

export function loadChains(path = CHAINS_PATH): ChainAuthority {
  const csv = readStrictCsv(path, [CHAINS_HEADER]);
  const byName = new Map<string, number>();
  const byId = new Map<number, string>();
  const rows: ChainRow[] = [];

  for (let i = 0; i < csv.records.length; i++) {
    const r = csv.records[i];
    const line = csv.recordLines[i];
    const ctx = (column: string) => ({ path, line, column });
    const chain = nonEmpty(ctx("chain"), r[0]);
    const chainId = parseFiniteInt("chain_id", r[1], { min: 1 });
    const isActive = bool(ctx("is_active"), r[5]);

    if (byName.has(chain)) throw new SeedParseError(path, `duplicate chain '${chain}'`, line);
    if (byId.has(chainId)) throw new SeedParseError(path, `duplicate chain_id ${chainId} (already '${byId.get(chainId)}')`, line);
    byName.set(chain, chainId);
    byId.set(chainId, chain);
    rows.push({ line, chain, chainId, isActive });
  }

  if (rows.length === 0) throw new SeedParseError(path, "declares no chains");
  return { byName, byId, rows, path };
}
