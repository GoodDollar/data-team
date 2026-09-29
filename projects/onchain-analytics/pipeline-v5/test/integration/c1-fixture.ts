/**
 * c1-fixture.ts -- the rows both halves of the `C1` reproduction write.
 *
 * The block range is the incident's own: two processes captured XDC 105,201,000..105,201,500 at
 * the same time, both exited 0, and `RawLogs` ended with 149 stored rows over 102 distinct keys.
 * Both workers build this identically, so every merge key collides by construction -- which is
 * what makes "one row per key afterwards" a real assertion rather than a coincidence of
 * non-overlapping data.
 */

import { rawLogRow, C1_RANGE, XDC_CHAIN_ID, hash32 } from "../helpers/fixtures.js";

export const C1_KEY_COUNT = 47;

export function C1_ROWS(): Record<string, any>[] {
  return Array.from({ length: C1_KEY_COUNT }, (_, i) =>
    rawLogRow({
      blockNumber: C1_RANGE.from + i,
      txHash: hash32(`c1-${i}`),
      logIndex: 0,
      chainId: XDC_CHAIN_ID,
    })
  );
}
