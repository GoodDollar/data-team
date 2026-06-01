# GoodDollar Dashboard v6 — Master Reference

> **Audit date:** May 25–26, 2026
> **Status:** Planning complete. All design decisions locked. Ready for implementation.
> **Purpose:** Single authoritative source of truth for the v6 build. Coding agents read this; they do not design.

---

## 1. Context and Naming

| Version | GAS Project | Spreadsheet | Status |
|---|---|---|---|
| v4 | "Dashboard Scripts" | `1vZoUwOi9EKAABqy6TIeW1XWdChwvDPL71YJWlwy5AXo` | ✅ Current production |
| v5 | "DEV Dashboard Scripts" | `1oFhPG8rWsG04kgrgtJy3By-_cDtrhSveL5HzuAATKxs` | ❌ Never shipped — too complex |
| **v6** | "Dashboard Scripts v6" (script ID: `10MyBmSXovm5AytJrBLuhjIz5DqujJS1cLA5uxMVnDQ17C1K9Kqy7Z8Ck`) | `1QkXSU39x8UJeIP49mFUsFczxmiuSVB1La0lhE5ke3bw` (copy of v4 sheet — full v4 history already present) | 🔨 Infrastructure ready; implementation pending |

**What v6 is:** v4 + targeted bug fixes. Not a rewrite. No new features. ~6-month sunset timeline.

**Why v6 and not v5:** v5 exists as a live, named GAS project ("DEV Dashboard Scripts") with a different architecture that was abandoned. Reusing the v5 name creates ambiguity. v6 is unambiguous.

**The v6 baseline is `Main Dashboard - Daily v4.gs`.** The v5 dev code (`DEV Dashboard v5.gs`) is a reference only for specific well-implemented helper functions — listed in Section 6.

**⚠️ Critical: The v6 spreadsheet IS the facts sheet that powers the public GoodDollar dashboard, seen by thousands of users daily.** It already contains ~8,500+ rows of production history copied from v4. The v6 script must write to it seamlessly — no resets, no schema changes, no overwriting. The existing data is the baseline; v6 just continues appending. The `CONFIG.DEST_SPREADSHEET_ID` in the v6 script must be set to `1QkXSU39x8UJeIP49mFUsFczxmiuSVB1La0lhE5ke3bw`.

**Evidence the v4 cron almost timed out on May 26, 2026:** See `Logs/v4 26-May cron success.txt`. The run succeeded but came very close to the 6-minute GAS execution cap. This confirms urgency of the timeout/performance fixes.

---

## 2. Technical Foundation

**Platform:** Google Apps Script (GAS)
- Hard **6-minute (360-second) execution cap** — process killed with no cleanup if exceeded
- `UrlFetchApp.fetch()` default timeout: **60s per call** unless `deadline` is specified
- PropertiesService: stores API keys. No state caching in v6 (adds complexity, not worth it for 6-month sunset)
- No server-side filtering on Google Sheets API; all filtering is client-side in GAS

**v4 Daily Trigger Schedule:**
- `prewarmFromRegistry` → 12:45 AM UTC (fires Dune query executions 36 min early)
- `smartBackfill` → 1:21 AM UTC (main daily run)

**v6 will replicate these triggers** and add a third:
- `updateXdcInvitesPipeline` → dedicated trigger (every 6h or 2:00 AM UTC daily)

**Sheet schema (do not change):** `date | chain | metric_key | value | source | updated_at`
- Append-only immutable model — once `(date, chain, metric_key)` written, never overwritten
- ~94 rows per successful daily run; ~8,500+ total rows as of May 26, 2026
- User frequently reorders/sorts/filters the sheet (this rules out tail-read optimizations)

**v4 Adapter execution order in `buildRows()`:**
1. Dune (batched by queryId → all CELO metrics)
2. Subgraph (XDC Goldsky) + `xdc_returning_claimers` (computed inline)
3. Reserve (CELO reserve subgraph → priceMap)
4. Computed (price × quantity, with fallback reads)
5. Supply (Etherscan, Fuse, Celo explorers)
6. SupplyComputed (`eth_circulating`, `total_circulating`)
7. XdcReserve (XDC price subgraph + RPC liquidity)
8. XdcReserveComputed (`price_spread`, `backing_ratio`, `daily_minted`, `reserve_growth_abs`)
9. XdcInvites (reads "XDC Invites Raw" sheet)

---

## 3. Data Sources and Deadlines

| Source | Metrics | v6 Deadline |
|---|---|---|
| Dune Analytics REST | All CELO activity metrics (5 query IDs) | 45s |
| XDC Goldsky Subgraph (`gd_xdc/1.2/gn`) | All XDC activity | 30s |
| CELO Reserve Subgraph (`reserve_celo/1.0/gn`) | `celo_gd_price`, reserve in/out/volume | 30s |
| XDC Reserve Subgraph (`reserve_xdc/v1.0.0/gn`) | `xdc_gd_price` | 30s |
| XDC RPC (`erpc.xinfin.network`) | `xdc_reserve_liquidity_usd` | 15s |
| Etherscan v2 API | `eth_gd_total_supply`, `eth_gd_frozen_supply` | 30s |
| Fuse Explorer API | `fuse_gd_in_circulation` | 30s |
| Celo Explorer API | `celo_gd_in_circulation` | 30s |
| Envio Hypersync | XDC invite events (11 metrics) | 25s |

**Key constants — do not change under any circumstances:**
```js
ETH_GD_TOTAL_SUPPLY_CONST  = 11125628315   // G$ units (post /100 conversion). Fixed post-hack.
ETH_GD_FROZEN_SUPPLY_CONST = 9208232844    // G$ units
CONFIG.XDC_GENESIS          = '2025-11-12'
ETH_GD_CONTRACT             = '0x67C5870b4A41D4Ebef24d2456547A03F1f3e094B'
FROZEN_WALLET_1             = '0xec577447d314cf1e443e9f4488216651450dbe7c'
FROZEN_WALLET_2             = '0x6738fa889ff31f82d9fe8862ec025dbe318f3fde'
```

---

## 4. Complete Bug Catalog

Every bug was found by reading all ~3,700 lines of `Main Dashboard - Daily v4.gs` in full.

### 4A — Data Corruption (values written permanently wrong)

#### A1 — Etherscan `!json.result` guard passes error strings → NaN → 0 written (CRITICAL)
- **Location:** `fetchEthereumSupply()`
- **Root cause:** Etherscan error responses return non-empty strings like `"Max rate limit reached"`. `!json.result` is `false` for any non-empty string, so the guard does nothing. `Number("Max rate limit...")` → NaN. `roundDp(NaN, 2)` → 0. Written permanently.
- **Fix:** Replace `if (!json.result) throw` with:
  ```js
  const raw = Number(json.result);
  if (!isFinite(raw) || raw <= 0) throw new Error('Invalid Etherscan result: ' + json.result);
  ```
- **Fallback:** On throw, use `ETH_GD_TOTAL_SUPPLY_CONST` with `source = 'ETH_SUPPLY_FALLBACK'`. ETH supply is fixed post-hack so the constant is permanently accurate.

#### A2 — `fetchEthereumFrozenSupply` silently accumulates NaN (CRITICAL)
- **Location:** `fetchEthereumFrozenSupply()`
- **Root cause:** `if (json.result) total += Number(json.result) / 100` — error strings are truthy. `Number("error string")` = NaN. NaN arithmetic produces NaN. Written as 0.
- **Fix:** Same strict `isFinite` + `> 0` guard per wallet. If any wallet fails, throw immediately (no partial accumulation). Add final check: `if (!isFinite(total) || total <= 0) throw`.
- **Fallback:** Use `ETH_GD_FROZEN_SUPPLY_CONST`.

#### A3 — `SupplyComputed` NaN cascade: `NaN != null` is `true` (CRITICAL)
- **Location:** `SupplyComputed.fetch()`, `eth_circulating` and `total_circulating` branches
- **Root cause:** `lookupValue()` can return NaN from batchByKey. `NaN != null` → true, so null guards pass silently. `NaN - NaN = NaN`. `roundDp(NaN)` → 0 written.
- **Fix:** Add `isFinite(total) && total > 0` before computing `eth_gd_in_circulation`. Add `isFinite(ethC) && ethC > 0` before computing `agg_gd_in_circulation`.

#### A4 — `Session.getScriptTimeZone()` returns São Paulo → off-by-one date on ALL rows (HIGH)
- **Location:** `CONFIG.TIMEZONE = Session.getScriptTimeZone() || 'America/Sao_Paulo'`; used in `formatYMD()` and all `Utilities.formatDate()` calls
- **Root cause:** Script runs at 1:21 AM UTC. São Paulo is UTC-3, so the script thinks "today" is still the previous calendar day. `getYesterdayYMD()` returns D-2 instead of D-1. All row dates are wrong.
- **Fix:** Hardcode `'UTC'` everywhere `Utilities.formatDate()` is called. Remove `CONFIG.TIMEZONE`. Same fix applies to `getExistingFactsIndex()` where Date objects from the sheet are formatted in São Paulo timezone, producing wrong index keys.

#### N1 — AGG row corruption on partial-chain repair runs (CRITICAL — newly discovered)
- **Location:** `writeFactsAndHealth()` — AGG computation block
- **Root cause:** AGG rows are computed by summing ONLY the rows in the current run's `buildResult.rows`. If chain A was written in a prior run and chain B is new this run, the AGG sum only contains chain B. `writeFactsAndHealth()` finds the existing AGG row and OVERWRITES it with the partial sum.
  - **Example:** Run 1: XDC succeeds (xdc_p2p_tx_count=200), CELO fails (0 written). Run 2 repair: CELO=1000, XDC skipped (already in existingIndex). AGG computed as 1000. Overwrites 200. Sheet now has 1000 — correct answer is 1200.
- **Affected:** ALL `agg_*` metrics from the AGG computation block.
- **Fix:** Before writing an AGG row that already exists, look up the component values for ALL chains using `lookupValue(ctx, date, chain, baseMetric)` — checking both `ctx.batchByKey` (this run) and `ctx.factsValueIndex` (pre-existing). Sum all non-null values. This produces the correct total whether the run is fresh or a repair. Requires the ctx pattern (Phase 2 in implementation plan).

#### N_xrc1 — `xdc_returning_claimers` writes 0 when xdc_dau already exists (HIGH)
- **Location:** `buildRows()` — returning claimers computation block
- **Root cause:** `xdcDauData` is only populated for dates that pass the `existingIndex` check (i.e., NEW rows). If `xdc_dau` was already written in a prior run, it's in `existingIndex` → skipped → NOT added to `xdcDauData` → `dau = xdcDauData[date] || 0 = 0` → `returning_claimers = 0` written permanently.
- **Fix:** Use `lookupValue(ctx, date, 'XDC', 'xdc_dau')` instead of `xdcDauData[date]`. Guard: if null, skip.

#### N_xrc2 — `xdc_returning_claimers` writes full DAU when xdc_new_claimers fetch fails (HIGH)
- **Same location.** `xdcNewData[date] || 0 = 0` when `xdc_new_claimers` fetch failed → `returning = dau - 0 = dau`. All claimers appear "returning."
- **Fix:** Use `lookupValue(ctx, date, 'XDC', 'xdc_new_claimers')`. Guard: if null, skip.

### 4B — Silent Gaps (rows not written; health shows ok/0 — invisible failure)

#### S1 — Dune query fetch failure silently zeros 20+ CELO metrics (CRITICAL)
- **Location:** `buildRows()` outer Dune catch block
- **Root cause:** `duneDataCache[queryId] = []` on fetch error. Each dependent metric processes `rawRows = []`, writes 0 rows, reports `health.status = 'ok', records = 0`. Indistinguishable from a day with no data.
- **Fix:** Change to `duneDataCache[queryId] = null`. In the per-metric loop: if `rawRows === null`, call `addHealth('DUNE', metricKey, chain, 'error', 0, ..., 'query fetch failed')` and skip.

#### S2 — `XdcReserveComputed` missing dependency → Logger.log only (HIGH)
- **Location:** `XdcReserveComputed.fetch()`, all 4 computed metric branches
- **Root cause:** When dependency values are null, the else branch only calls `Logger.log`. No health entry. Dashboard shows `ok, 0` for 4 metrics.
- **Fix:** Add `addHealth('XDC_RESERVE_COMPUTED', metricKey, 'XDC', 'warn', 0, ..., 'missing dependency: <name>')` in each else branch.

#### S3 — Computed USD metrics silently skip dates (HIGH)
- **Location:** `Adapters.Computed.fetchWithFactsLookup()`, per-date loop
- **Root cause:** `if (sourceValue == null || sourceValue === 0) continue` and `if (price == null || price === 0) continue` exit silently with no health entry.
- **Fix:** Track skipped date count. After the loop, if any dates were skipped, call `addHealth(..., 'warn', 0, ..., 'skipped N dates: missing price or source metric')`.

#### S4 — `agg_gd_in_circulation` missing → Logger.log only (HIGH)
- **Location:** `SupplyComputed.total_circulating` else branch
- **Fix:** Same as S2 — add `addHealth('SUPPLY_COMPUTED', 'agg_gd_in_circulation', 'AGG', 'warn', 0, ..., 'missing components: <list>')`.

#### S5 — XDC invites never populated by cron trigger (CRITICAL)
- **Location:** `smartBackfill()` — does not call `updateXdcInvitesPipeline()`. Only `runOneDaySinglePass()` calls it, which is not the cron trigger.
- **Impact:** All 11 XDC invite metrics are always 0 in production cron runs. Health shows `ok, 0` every day — looks normal.
- **Fix:** Set up a **dedicated time trigger** for `updateXdcInvitesPipeline()` (recommended: 2:00 AM UTC daily or every 6h). Do NOT add it to `smartBackfill()` — the Hypersync sweep can take several minutes and would threaten the 6-minute budget.

### 4C — Timeout / Performance

#### T1 — `insertRowsAfter(1, N)` row-shift approach: O(sheet size) time (CRITICAL)
- **Location:** `writeFactsAndHealth()` main appends block
- **Root cause:** `facts.insertRowsAfter(1, appends.length)` shifts all ~8,500 existing rows down before writing at row 2. Measured at 60–120s and growing. This is likely the primary contributor to the near-timeout on May 26.
- **Fix:** `facts.getRange(facts.getLastRow() + 1, 1, appends.length, 6).setValues(values)` — true append at last row. No row-shifting. Works correctly even when user has reordered the sheet (always appends to the actual physical last row).

#### T1b — Health sheet uses the same `insertRowsAfter` pattern (MEDIUM)
- **Same fix:** append at bottom.

#### T3 — `SupplyComputed.total_circulating` unconditionally reads full sheet (HIGH)
- **Location:** `SupplyComputed.fetch()`, `total_circulating` branch
- **Root cause:** A `SpreadsheetApp.openById()` call is missing its conditional guard (copy-paste error vs. the correct `eth_circulating` branch). Reads full sheet (~8,500 rows) every run, whether or not `total_circulating` is needed.
- **Fix:** Eliminated entirely by the ctx/factsValueIndex pattern.

#### T3b — `XdcReserveComputed.findInFacts()` reads full sheet per computed metric (HIGH)
- **Location:** `findInFacts()` inside `XdcReserveComputed.fetch()`
- **Fix:** Eliminated by ctx pattern.

#### T3c — `Adapters.Computed.fetchWithFactsLookup()` up to 10 full sheet reads per run (HIGH)
- **Location:** 5 XDC Computed USD metrics × 2 sheet reads each = up to 10 reads
- **Fix:** Eliminated by ctx pattern.

#### T4 — `writeFactsAndHealth()` applies number format one cell at a time (MEDIUM)
- **Location:** `for (i...) { facts.getRange(2+i, 4).setNumberFormat(...) }` — ~94 separate API calls
- **Measured cost:** ~18s per run
- **Fix:** Group rows by decimal precision (typically 2–3 groups). Call `setNumberFormats([[fmt], [fmt], ...])` on each range in a single call.

#### T5 — CELO reserve makes 3 identical HTTP requests per run (MEDIUM)
- **Location:** `buildRows()` Reserve section calls `reserveFetchDailyVolume()` 3× for `celo_reserve_in`, `celo_reserve_out`, `celo_reserve_volume`
- **Fix:** Port `reserveFetchDailyVolumeBundle()` from `DEV Dashboard v5.gs`. Single GQL call returns `amountIn`, `amountOut`, `volume` together.

#### N4_perf — `xdc_daily_gd_minted` makes 2 live subgraph calls with no deadline (HIGH)
- **Location:** `XdcReserveComputed.fetch()`, `daily_minted` branch — two direct `xdcFetchDailyField()` calls (for `untilYMD` and `untilYMD-1`) outside any batch, no `deadline` parameter
- **Risk:** Up to 120s if subgraph is slow
- **Fix:** The `totalUBIDistributed` field is already fetched in the main Subgraph adapter pass for `xdc_gd_claimed_1d` and related metrics. Move `daily_minted` to use `lookupValue(ctx, d, 'XDC', 'xdc_gd_claimed_1d')` for today and `lookupValue(ctx, prevDay, 'XDC', 'xdc_gd_claimed_1d')` for yesterday. No live calls needed.

#### B1 — No `deadline` on any `UrlFetchApp.fetch()` call (CRITICAL)
- **Location:** Every single `UrlFetchApp.fetch()` call throughout the script
- **Risk:** A hung HTTP connection blocks the entire GAS execution thread. With no deadline, one slow API call can silently eat 60s of the 360s budget.
- **Fix:** Add `deadline` to every call. Recommended constants:
  ```js
  const DEADLINES = {
    DUNE:       45,
    ETHERSCAN:  30,
    SUBGRAPH:   30,
    XDC_RPC:    15,
    HYPERSYNC:  25,
    SLACK:      10
  };
  ```

#### A10 — No elapsed-time budget guard in `buildRows()` (MEDIUM)
- **Location:** `buildRows()` — no elapsed-time check between adapter groups
- **Risk:** Slow adapters push execution past the 6-minute cap. Script is killed mid-write, corrupting health sheet.
- **Fix:** Record `const runStart = Date.now()` at the start of `buildRows()`. At the start of each adapter group, check `if (Date.now() - runStart > 320_000)` — if exceeded, skip remaining adapters and log a warning health row. 320s leaves 40s for `writeFactsAndHealth()`.

### 4D — Design / Architecture Gaps

#### N5 — 5 CELO USD metrics have `aggregate: false` → misleading single-chain `agg_*` rows (MEDIUM)
- **Location:** METRICS registry
- **Root cause:** XDC Computed USD metrics have `aggregate: true` but their CELO counterparts have `aggregate: false`. The AGG block produces `agg_*` rows containing only XDC data, labeled as if they represent cross-chain totals.
- **Affected pairs:** `xdc_p2p_usd_amount` / `celo_p2p_usd_amount`, `xdc_lifetime_claimed_usd_amount` / `celo_lifetime_claimed_usd_amount`, `xdc_usd_claimed_30d` / `celo_usd_claimed_30d`, `xdc_usd_claimed_7d` / `celo_usd_claimed_7d`, `xdc_usd_claimed_1d` / `celo_usd_claimed_1d`
- **Fix:** Set `aggregate: true` on all 5 CELO metrics in the registry. Requires N1 to be fixed first (so the newly-enabled AGG computation is correct).

#### N6 — `|| 0` in XDC subgraph helpers writes 0 for null fields (MEDIUM)
- **Location:** `xdcFetchDailyField()`: `var val = Number(String(n[fieldName] || 0)...)`, `xdcFetchGlobalTotal()`: same
- **Root cause:** If a subgraph entity exists but a specific field is null (partial indexing), the `|| 0` coercion writes 0 instead of skipping.
- **Fix:** Replace `|| 0` with an explicit check: `if (n[fieldName] == null) continue;` before the value assignment.

#### A6 — `XdcReserveComputed` has no date loop (MEDIUM)
- **Location:** `XdcReserveComputed.fetch()` — all 4 computed metrics only process `untilYMD` (the single latest date)
- **Impact:** Multi-day gaps in computed XDC reserve metrics fill at 1 day per run, even if all dependency prices exist in `factsValueIndex` for the missing dates.
- **Fix:** Add a `while (d <= untilYMD) { ... d = addDays(d, 1); }` loop. Use `lookupValue(ctx, d, ...)` for per-day dependency lookups. Requires ctx pattern.

#### N_priceMap — `priceMap` only covers THIS run's new prices (MEDIUM)
- **Location:** `buildRows()` Reserve section — `priceMap[date] = value` only added for NEW price rows
- **Root cause:** If `celo_gd_price` for a date was written in a prior run, it's in `existingIndex` → skipped → NOT added to `priceMap`. The Computed adapter then falls back to the expensive `fetchWithFactsLookup()` sheet read to get a price that's already in memory.
- **Fix:** Eliminated by ctx pattern — `lookupValue(ctx, ...)` checks `factsValueIndex` which covers all historical prices.

#### A5 / A5b — Price metrics fill only 1 day per run (LOW — accepted)
- `reserveFetchDailyAvgPrice()` ignores `sinceDayISO`, only returns data for `untilDayISO`.
- Same for `xdcReserveFetchGdPrice()`.
- **Decision: ACCEPTED for v6.** `backfillGdUsdPrice()` exists as manual repair for CELO. XDC price gaps are rare. Carry-forward covers most cases.

#### CF1/CF2 — Price carry-forward has no TTL (LOW — deferred)
- **Decision: DEFERRED.** Source column clearly shows fallback source name. Low operational risk.

#### A7 — `reserveFetchDailyVolume` 60-day hardcoded cap (LOW — accepted)
- **Decision: ACCEPTED for v6.**

---

## 5. The ctx / factsValueIndex Architecture Pattern

This is the single most impactful architectural change. It eliminates ALL adapter-level sheet reads and enables correct dependency lookups for all computed metrics.

**Implementation:**

```js
// ── Step 1: Extend getExistingFactsIndex() to also read column 4 (value) ──
// v4 currently reads 4 columns but discards column 4. v6 stores it.
const factsValueIndex = {};  // "YYYY-MM-DD|CHAIN|metric_key" → numeric value
// In the row-processing loop, after building index and maxDates:
const numVal = Number(row[3]);
if (isFinite(numVal)) factsValueIndex[key] = numVal;
// Return { index, maxDates, factsValueIndex }

// ── Step 2: Add batchByKey in buildRows() ──
// Updated in real-time as each row is pushed to the rows array.
const batchByKey = {};  // "YYYY-MM-DD|CHAIN|metric_key" → numeric value
// After every rows.push(...):
batchByKey[date + '|' + chain + '|' + metricKey] = value;

// ── Step 3: Build ctx and pass to all adapters ──
const ctx = { batchByKey, factsValueIndex };

// ── Step 4: lookupValue() — checks batch first, then historical ──
function lookupValue(ctx, date, chain, metric) {
  const key = date + '|' + chain + '|' + metric;
  if (key in ctx.batchByKey) return ctx.batchByKey[key];
  if (key in ctx.factsValueIndex) return ctx.factsValueIndex[key];
  return null;
}
```

**What this replaces in v4:**
| v4 code | v6 replacement |
|---|---|
| `findInFacts()` in XdcReserveComputed | `lookupValue(ctx, ...)` |
| `SpreadsheetApp.openById()` in SupplyComputed | `lookupValue(ctx, ...)` |
| `sourceFromFacts` sheet read in `fetchWithFactsLookup` | `lookupValue(ctx, ...)` |
| `effectivePriceMap` sheet read in `fetchWithFactsLookup` | `lookupValue(ctx, 'CELO', 'celo_gd_price', date)` with carry-forward |
| `priceMap` (only covers new rows) | `lookupValue(ctx, 'CELO', 'celo_gd_price', date)` |
| `xdcDauData`/`xdcNewData` maps | `lookupValue(ctx, ...)` with null guard |

**xdc_returning_claimers with ctx (correct implementation):**
```js
var d = effectiveSince;
while (d <= untilYMD) {
  const factKey = d + '|XDC|xdc_returning_claimers';
  if (!existingIndex[factKey]) {
    const dau  = lookupValue(ctx, d, 'XDC', 'xdc_dau');
    const newC = lookupValue(ctx, d, 'XDC', 'xdc_new_claimers');
    if (dau !== null && newC !== null) {
      const returning = Math.max(0, dau - newC);
      rows.push({ date: d, chain: 'XDC', metric_key: 'xdc_returning_claimers',
                  value: returning, source: 'XDC_SUBGRAPH' });
      batchByKey[d + '|XDC|xdc_returning_claimers'] = returning;
    }
  }
  d = addDays(d, 1);
}
```

---

## 6. What to Port from v5 Dev (`DEV Dashboard v5.gs`)

Read `DEV Dashboard v5.gs` for the implementations of these. Do not modify that file.

| Pattern | Port to v6? | Notes |
|---|---|---|
| `ctx` object + `lookupValue()` | ✅ YES | Core dependency-lookup fix |
| `batchByKey` real-time map | ✅ YES | Part of ctx |
| `factsValueIndex` in `getExistingFactsIndex()` | ✅ YES | Extend v4's function |
| `notifySlack(message)` | ✅ YES | Operational alerting |
| `DEADLINES` constants object | ✅ YES | All timeout values in one place |
| Append-at-bottom in `writeFactsAndHealth()` | ✅ YES | T1 fix |
| `reserveFetchDailyVolumeBundle()` | ✅ YES | T5 fix |
| `setNumberFormats()` batch | ✅ YES | T4 fix |
| Tail-read optimization in `getExistingFactsIndex()` | ❌ NO | User reorders sheet; last N rows ≠ most recent dates |
| PropertiesService `MAX_DATES_V5` cache | ❌ NO | Complexity not worth it for 6-month sunset |
| `CARRY_FORWARD_MAX_DAYS` enforcement | ❌ NO | Deferred |
| Gap detection/audit system | ❌ NO | Caused v5 architectural drift |
| `supplySelfHeal()` auto-repair trigger | ❌ NO | Etherscan fallback constants eliminate supply gaps |

---

## 7. Etherscan Fallback Strategy (Important Design Decision)

When Etherscan calls fail (rate limit, invalid key, network error), use hardcoded constants as the fallback value rather than leaving a gap.

**Rationale:** ETH GD supply is frozen post-hack. The constants `ETH_GD_TOTAL_SUPPLY_CONST` and `ETH_GD_FROZEN_SUPPLY_CONST` are permanently accurate. A supply gap cascades through: `eth_gd_total_supply` → `eth_gd_in_circulation` → `agg_gd_in_circulation`. Using a fallback is strictly correct and prevents cascade failures.

```js
// In the Supply adapter, on Etherscan failure:
} catch (e) {
  Logger.log('WARN [eth_gd_total_supply]: Etherscan failed (' + e.message + '), using fallback constant');
  // Use fallback constant — ETH supply is fixed post-hack
  rows.push({ date: untilYMD, chain: 'ETH', metric_key: 'eth_gd_total_supply',
              value: ETH_GD_TOTAL_SUPPLY_CONST, source: 'ETH_SUPPLY_FALLBACK', ... });
}
```

Source column will show `ETH_SUPPLY_FALLBACK` — fully auditable.

**This differs from the older `gooddollar_supply_bug_rca_and_fix_plan.md`** which described a "throw + leave gap" approach. That document is superseded. The fallback-constant approach is correct for v6.

---

## 8. What Is Not Changing in v6

These aspects of v4 are correct and must not be touched:

- Sheet schema (date, chain, metric_key, value, source, updated_at)
- The append-only immutable model (AGG fix is the one explicit exception, see N1)
- `getExistingFactsIndex()` immutability/dedup logic (only extend it, don't change existing behavior)
- `smartBackfill()` `earliestNeeded` calculation logic
- `roundDp()` behavior — NaN→0 is acceptable for non-supply metrics; supply correctness is enforced upstream
- METRICS registry entries — all correct except the 5 `aggregate` flag fixes (N5)
- `CONFIG.XDC_GENESIS = '2025-11-12'`
- All contract and wallet addresses (see Section 3)
- The `smartBackfill()` / `backfillRange()` / `runOneDaySinglePass()` orchestrator structure
- FUSE/CELO historical backfill via Hypersync/Dune

---

## 9. Deployment Plan (Human Operator Steps)

**Already done (as of May 26, 2026):**
- ✅ v6 spreadsheet created (duplicate of v4): `1QkXSU39x8UJeIP49mFUsFczxmiuSVB1La0lhE5ke3bw`
- ✅ v6 GAS project created: script ID `10MyBmSXovm5AytJrBLuhjIz5DqujJS1cLA5uxMVnDQ17C1K9Kqy7Z8Ck`

**Step 1 — Pre-flight: Import XDC invite historical data (before first v6 run)**
1. Open the v5 facts sheet (`1oFhPG8rWsG04kgrgtJy3By-_cDtrhSveL5HzuAATKxs`)
2. Filter rows where `metric_key` starts with `xdc_invite_` (all 11 invite metrics)
3. Copy those rows into the v6 spreadsheet's "Daily Facts" tab
4. This ensures historical invite data is not lost when v4 is sunset
5. (v6 script will see these rows in `getExistingFactsIndex()` and skip them correctly — no duplicates)

**Step 2 — Install v6 code**
1. Open the v6 GAS project in the editor
2. Replace ALL code with the coding agent's output (two files: the main pipeline and the dev/diagnostics file)
3. Verify `CONFIG.DEST_SPREADSHEET_ID` is set to `1QkXSU39x8UJeIP49mFUsFczxmiuSVB1La0lhE5ke3bw`
4. Set Script Properties (**not copied during GAS project duplication — must set manually**):
   - `DUNE_API_KEY` — same value as v4
   - `ETHERSCAN_API_KEY` — same value as v4 (the repaired key, valid as of May 25, 2026)
   - `HYPERSYNC_TOKEN` — same value as v4
   - `SLACK_WEBHOOK_URL` — new value, see Section 15 for setup instructions

**Step 3 — Set v6 triggers**
1. `prewarmFromRegistry` → time-driven, 12:45 AM UTC daily
2. `smartBackfill` → time-driven, 1:21 AM UTC daily
3. `updateXdcInvitesPipeline` → time-driven, 2:00 AM UTC daily

**Step 4 — Validation run**
1. Run `smartBackfill()` manually once in the v6 editor
2. Inspect the health sheet — look for any `error` or `warn` entries; there should be none on a clean first run
3. Verify new rows appear at the BOTTOM of the Daily Facts sheet (T1 fix)
4. Verify supply values are > 0 and match v4's values for the same date
5. Verify AGG rows include both chains

**Step 5 — Parallel run (2–3 days)**
1. Keep v4 triggers running; keep v6 triggers running simultaneously
2. Each morning, compare v4 vs v6 health sheets and fact row counts
3. Slack DM notifications from v6 will signal any issues immediately

**Step 6 — Cutover**
1. Switch the main GoodDollar public dashboard data source to the v6 spreadsheet
2. Delete v4 triggers (`prewarmFromRegistry`, `smartBackfill`)
3. Keep v4 spreadsheet and "Dashboard Scripts" project as read-only archive — do not delete

---

## 10. Summary: Change Impact by Phase

| Phase | Bugs Fixed | Risk | Time Saved (est.) |
|---|---|---|---|
| 1 — Foundation (DEADLINES, UTC, Slack) | A4, A4b, B1 | Low | Prevents hung fetches |
| 2 — ctx/factsValueIndex | T3, T3b, T3c, N2, N3, N_priceMap | Low | ~30–40s |
| 3 — Remove adapter sheet reads | N_xrc1, N_xrc2, A3, A3b | Low | Included in Phase 2 |
| 4 — Etherscan validation + fallback | A1, A2 | Low | Prevents supply corruption |
| 5 — Dune error visibility + deadlines | S1, B1 | Low | Prevents silent CELO gaps |
| 6 — Append at bottom + reserve bundle | T1, T1b, T5, T4 | **Medium** (critical path) | ~90–120s ← biggest win |
| 7 — XdcReserveComputed date loop | A6, N4_perf, S2 | Low | ~30s |
| 8 — AGG corruption fix | N1 | Medium | Correctness fix |
| 9 — Silent gap visibility | S3, S4, N6 | Low | Observability fix |
| 10 — Registry fixes + budget guard | N5, A10 | Low | Safety net |
| 11 — Health sheet redesign | All silent fails | Low | Operational clarity |
| 12 — Gap diagnostics + test suite | — | Low | Debugging capability |

---

## 11. Two-File Architecture

v6 will be delivered as **two `.gs` files**, matching the v4 project's existing convention:

| File | Purpose | Contains |
|---|---|---|
| `v6-main.gs` | Daily production pipeline | All code that runs on cron: `smartBackfill`, `buildRows`, `writeFactsAndHealth`, all adapters, `prewarmFromRegistry`, `backfillRange`, `runOneDaySinglePass`, constants, METRICS registry, all fetch helpers |
| `v6-dev.gs` | Diagnostics and utilities | Functions that are never called by cron but are essential for debugging, repair, and monitoring: gap detection, test suite, manual repair utilities, backfill helpers, `runGapReport()` |

**Why this matters:** The production file stays lean and readable. The dev file can grow without risk to the daily pipeline. Functions in `v6-dev.gs` can call functions defined in `v6-main.gs` (GAS shares scope across files in the same project). The reverse must NOT happen — `v6-main.gs` must not call anything defined only in `v6-dev.gs`.

**Logging requirement:** Verbose `Logger.log()` calls must be preserved throughout `v6-main.gs`, as they have been in v4 and v5. Without them, debugging adapter-level failures requires re-running the entire pipeline. Each major step should log: what it's doing, the date range, any counts, and any errors with full details. This is the primary debugging tool.

---

## 12. Health Sheet Redesign

### Problem statement

The current v4 health sheet is ineffective for operational monitoring:
- Writes `ok, 0` rows for skipped metrics — indistinguishable from success
- Error details are vague or absent
- No run-level summary — you can't tell at a glance if a run was clean
- Does not show expected vs. actual record counts
- A reviewer cannot look at it and immediately know what went wrong, when, and why

### Design principles

1. **The health sheet is for humans first.** When something goes wrong at 1:30 AM, the founder needs to open it and understand the problem in 10 seconds.
2. **No silent ok/0 rows.** If a metric is up-to-date (already in the sheet), write nothing about it. Noise is the enemy of signal.
3. **Every failure has a human-readable explanation.** `details` must never be empty for `warn` or `error` rows.
4. **A run summary row closes every run.** It captures the top-level outcome.
5. **Slack delivers the summary immediately.** The founder does not need to open the spreadsheet to know if something went wrong.

### New health sheet schema

**Sheet name:** `Health Runs` (preserve existing name)

**Columns (replace all existing columns):**
```
run_id | run_date | started_at | adapter | chain | metric_key | status | records_written | records_expected | details | elapsed_ms
```

| Column | Type | Description |
|---|---|---|
| `run_id` | string | Unique ID per `smartBackfill()` invocation (e.g., `20260526-012134`) |
| `run_date` | string | The date being processed (`YYYY-MM-DD`), or `ALL` for summary row |
| `started_at` | ISO timestamp | When this row was recorded |
| `adapter` | string | Which adapter produced this row (`DUNE`, `SUBGRAPH`, `SUPPLY`, `SUMMARY`, etc.) |
| `chain` | string | `CELO`, `XDC`, `ETH`, `FUSE`, `AGG`, or `ALL` for summary |
| `metric_key` | string | The specific metric, or `all` for summary rows |
| `status` | string | `ok` / `warn` / `error` / `skip` |
| `records_written` | number | Rows actually written to facts sheet for this metric/run |
| `records_expected` | number | Rows that SHOULD have been written (0 if metric is up-to-date) |
| `details` | string | Human-readable explanation. Required for warn/error. Empty for ok. |
| `elapsed_ms` | number | Time taken for this adapter/step |

### What gets written

**Write a row when:**
- Any metric writes at least one record → `ok` row with count
- Any metric is skipped due to missing dependency → `warn` row with details
- Any adapter fails (API error, timeout, invalid data) → `error` row with error message
- A Dune query fails → one `error` row covering all metrics from that query
- Supply fallback constants are used → `warn` row (metric written, but from fallback)

**Do NOT write a row when:**
- A metric is already up-to-date in the sheet (records_expected = 0, no new dates needed) — this is the common case and is noise

**Write a summary row at the END of every run:**
```
SUMMARY | run_id | run_date=ALL | adapter=SUMMARY | status=[ok/warn/error] | 
records_written=[total] | records_expected=[total] | 
details="Run complete in Xs. N metrics ok, N warn, N error. [errors list if any]"
```

### Slack notification behavior

- At the **end of every run**, send a Slack DM to the founder with the run summary
- **Immediate alert** (don't wait for end of run) if `status = 'error'` and the adapter is critical (Dune, Supply, or any that produces > 5 metrics)
- Message format for summary:
  ```
  ✅ v6 run complete — May 26, 2026
  94 rows written | 0 warnings | 0 errors | 47s
  ```
  Or on failure:
  ```
  ❌ v6 run — May 26, 2026
  52 rows written | 2 warnings | 1 error | 49s
  ERROR: Dune query 3237345 failed — CELO activity metrics missing for 2026-05-26
  WARN: eth_gd_total_supply used fallback constant (Etherscan rate limit)
  ```

---

## 13. Gap Diagnostics Tool

A utility function `runGapReport()` in `v6-dev.gs` that scans the facts sheet and reports exactly which metric+chain combos have missing dates.

**Specification:**

```js
/**
 * Scans the Daily Facts sheet and returns all gaps (missing dates) for every
 * metric+chain combination. Logs a human-readable summary and optionally
 * returns the structured result.
 *
 * Run this manually from the GAS editor after a migration, after a repair run,
 * or whenever the data looks suspicious.
 *
 * Output format (logged and returned):
 *   { "XDC|xdc_dau": { expectedCount: 195, actualCount: 193, missing: ["2026-03-14", "2026-04-02"] },
 *     "CELO|celo_active_claimers": { ... }, ... }
 */
function runGapReport() {
  // 1. Read all rows from Daily Facts (date, chain, metric_key)
  // 2. For each (chain, metric_key) combo, find min and max date
  // 3. Generate the full expected date list from min to max
  // 4. Diff against actual dates present
  // 5. Log: "chain|metric_key: N gaps — [date1, date2, ...]" for each combo with gaps
  // 6. Log summary: "Total: X metric+chain combos have gaps, Y total missing dates"
  // Return the structured result for programmatic use if needed
}
```

**The function should also cross-reference against XDC_GENESIS** — XDC metrics should not be expected before `2025-11-12`.

**Separate function `runExpectedMetricsReport()`:** Lists all expected metric+chain combos from the METRICS registry, compares against what is actually in the sheet, and logs any that are 100% absent. This catches metrics that have never been written at all (like XDC invites before the pipeline was wired).

---

## 14. XDC Invites Historical Data Import (Decision: YES)

### Background
- v5 dev code (`DEV Dashboard v5.gs`) implemented `updateXdcInvitesPipeline()` and ran it successfully
- v5's facts sheet contains historical XDC invite metric data from `CONFIG.XDC_GENESIS` onward
- v4's facts sheet (and therefore v6's facts sheet) has ZERO `xdc_invite_*` rows — the pipeline was never wired to v4's cron
- v6 will wire the invite pipeline properly (dedicated trigger, see Section 2)

### Decision
**Import v5's historical XDC invite rows into the v6 spreadsheet BEFORE the first v6 run.**

**Rationale:**
- The data exists and is correct in v5's sheet
- Without the import, the v6 sheet would have a gap from `XDC_GENESIS` to today's date on all 11 invite metrics
- The v6 script will correctly skip already-imported dates (they'll be in `getExistingFactsIndex()`)
- The Hypersync pipeline uses a cursor in ScriptProperties — after import, set the cursor to yesterday's date so the pipeline only fetches new events going forward

### Steps (human operator, before first v6 run)
1. Open v5 facts sheet: `1oFhPG8rWsG04kgrgtJy3By-_cDtrhSveL5HzuAATKxs`
2. Filter rows where `metric_key` contains `xdc_invite` (all 11 invite metrics)
3. Copy those rows to the v6 spreadsheet (`1QkXSU39x8UJeIP49mFUsFczxmiuSVB1La0lhE5ke3bw`) Daily Facts tab — append at the bottom
4. After the first v6 run, run `runGapReport()` to confirm no invite gaps remain
5. Set the Hypersync invite cursor in v6 Script Properties to the most recent date in the imported data (so the next pipeline run fetches only new events)

### What the v6 code must handle
The v6 `getExistingFactsIndex()` will see the imported invite rows normally. The `updateXdcInvitesPipeline()` will skip already-written dates. No special handling needed in the code — this is a data migration step, not a code change.

---

## 15. Slack DM Webhook Setup Instructions

The `SLACK_WEBHOOK_URL` Script Property must be set to an incoming webhook that sends messages **directly as a DM to the founder**.

**Setup steps (founder does this):**
1. Go to https://api.slack.com/apps and click **Create New App → From scratch**
2. Name it "GoodDollar Dashboard Alerts", select your workspace
3. In the left menu, click **Incoming Webhooks** → toggle **Activate Incoming Webhooks** ON
4. Click **Add New Webhook to Workspace**
5. When asked "Where should this app post?", search for your own name (i.e., select yourself as the target — this sends to your personal DM)
6. Copy the Webhook URL (looks like `https://hooks.slack.com/services/T.../B.../...`)
7. In the v6 GAS project, go to **Project Settings → Script Properties** → add property `SLACK_WEBHOOK_URL` with that URL
8. Test by running `testSlackNotification()` from `v6-dev.gs` — you should receive a DM from the app

**The `notifySlack(message)` function in `v6-main.gs` sends plain text.** The message format is defined in Section 12 above.
