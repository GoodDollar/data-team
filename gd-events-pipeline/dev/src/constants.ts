/**
 * ============================================================================
 * constants.ts — Shared magic values
 * ============================================================================
 *
 * Centralizes constants used across multiple modules so they stay in sync.
 * Later phases will add more entries here.
 * ============================================================================
 */

/** Composite unique key columns for every contract event table. */
export const EVENT_KEY_COLUMNS = ["network", "block_number", "log_index", "tx_hash"] as const;

/** Maximum rows per staging load chunk in the loader before a forced emit. */
export const MAX_CHUNK_ROWS_HARD_CAP = 500_000;

/**
 * Maximum consecutive null timestamp probes during binary search before
 * aborting. Prevents infinite/skewed results when HyperSync index lags.
 */
export const MAX_NULL_PROBES = 5;
