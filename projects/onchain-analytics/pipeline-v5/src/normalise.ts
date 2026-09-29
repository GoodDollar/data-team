/**
 * normalise.ts -- every hex identifier is lowercased at the point a reader's output enters the
 * pipeline, and nowhere else.
 *
 * WHY THIS IS A CORRECTNESS RULE AND NOT A STYLE ONE. L0-9 part 5. `tx_hash` is part of the merge
 * key of both RawLogs and Transactions. Two spellings of one hash are two different keys, so the
 * same log lands twice, and a uniqueness test on the key CANNOT flag it because the two rows
 * genuinely have different keys. Nothing downstream can detect it either: the next correctly
 * scoped MERGE updates both copies to identical content, so the duplicate is invisible to every
 * comparison of values.
 *
 * WHY THE HAZARD IS REAL RATHER THAN THEORETICAL. An RPC node and an index return lowercase. An
 * explorer API returns EIP-55 checksummed mixed case. This warehouse plans to read from all three,
 * and the chains without a HyperSync index are precisely the ones that will be read by explorer.
 * Measured against the live tables: every one of 2,649,450 claim rows and 7,093 invite rows
 * already holds lowercase, so today the hazard is LATENT. It is guaranteed by nothing except the
 * habits of the one reader that has ever written them.
 *
 * WHY IT LIVES HERE, AT THE BOUNDARY, RATHER THAN IN EACH STATEMENT. A reader is the only place
 * mixed case can enter. Normalising inside each statement makes every future statement a fresh
 * chance to forget one column, and the failure is silent. One function applied to a whole chunk
 * cannot forget a column, because it does not know the column names: it walks the values.
 *
 * WHAT IS NOT NORMALISED, DELIBERATELY. `log_data` and transaction `input` are payloads, not
 * identifiers. Lowercasing a payload is harmless for hex digits but it is not this function's
 * job to decide that, and a payload never enters a key. They are passed through untouched, which
 * is also what L0-1 requires: the data section is stored VERBATIM.
 */

/** A 0x-prefixed hex string, of any length. */
const HEX = /^0x[0-9a-fA-F]*$/;

/** Lowercase a hex identifier. Anything that is not 0x-prefixed hex is returned unchanged. */
export function hex(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!HEX.test(s)) return s;
  return s.toLowerCase();
}

/** Lowercase a hex identifier, and refuse an absent one. For fields that are NOT NULL at L0. */
export function requireHex(v: unknown, field: string): string {
  const h = hex(v);
  if (h === null || h === "") {
    throw new Error(`NORMALISE: ${field} is required and the reader supplied ${JSON.stringify(v)}`);
  }
  return h;
}

/**
 * The identifier fields a reader can return, across every reader this pipeline uses.
 *
 * Named explicitly rather than "every string that looks like hex", because a heuristic over
 * values would also rewrite a payload, and a payload must be stored verbatim. Unknown keys are
 * left alone, so a reader that starts returning a new field does not have its value silently
 * rewritten by a rule nobody wrote for it.
 */
const IDENTIFIER_KEYS = new Set([
  // log
  "address", "blockHash", "transactionHash", "topic0", "topic1", "topic2", "topic3",
  // transaction
  "hash", "from", "to", "contractAddress",
  // block
  "parentHash", "miner",
]);

/**
 * Normalise one object returned by a reader, in place on a copy.
 *
 * `topics` is handled as an array because HyperSync returns it as a filtered array with nulls
 * removed, while the JSON-RPC shape returns a dense array, and both are positional.
 */
export function normaliseEntity<T extends Record<string, any>>(e: T): T {
  const o: Record<string, any> = { ...e };
  for (const k of Object.keys(o)) {
    if (IDENTIFIER_KEYS.has(k)) o[k] = hex(o[k]);
  }
  if (Array.isArray(o.topics)) o.topics = o.topics.map((t: unknown) => hex(t));
  return o as T;
}

/**
 * Normalise a whole chunk the moment it leaves a reader.
 *
 * This is the ONLY place in the pipeline that lowercases an identifier. Everything downstream may
 * assume lowercase, and that assumption is what makes the merge key sound.
 */
export function normaliseChunk(chunk: { logs?: any[]; transactions?: any[]; blocks?: any[] }): void {
  if (Array.isArray(chunk.logs)) chunk.logs = chunk.logs.map(normaliseEntity);
  if (Array.isArray(chunk.transactions)) chunk.transactions = chunk.transactions.map(normaliseEntity);
  if (Array.isArray(chunk.blocks)) chunk.blocks = chunk.blocks.map(normaliseEntity);
}

/**
 * The merge key of one log row, rendered as a string. Used for in-process de-duplication before
 * a MERGE, because two source rows with one key make BigQuery reject the whole statement.
 *
 * It refuses a mixed case input rather than normalising one, on purpose. By the time a key is
 * being built, normalisation has either happened at the boundary or been skipped, and silently
 * repairing it here would hide the skip. A loud failure in a staging step is cheap; a duplicate
 * under two spellings of one hash is undetectable.
 */
export function logKey(r: { chain_id: number; tx_hash: string; log_index: number }): string {
  if (r.tx_hash !== r.tx_hash.toLowerCase()) {
    throw new Error(`NORMALISE: tx_hash ${r.tx_hash} reached the merge key un-normalised`);
  }
  return `${r.chain_id}|${r.tx_hash}|${r.log_index}`;
}

/** The merge key of one transaction row. Transactions are keyed on (chain_id, tx_hash) only. */
export function txKey(r: { chain_id: number; tx_hash: string }): string {
  if (r.tx_hash !== r.tx_hash.toLowerCase()) {
    throw new Error(`NORMALISE: tx_hash ${r.tx_hash} reached the merge key un-normalised`);
  }
  return `${r.chain_id}|${r.tx_hash}`;
}
