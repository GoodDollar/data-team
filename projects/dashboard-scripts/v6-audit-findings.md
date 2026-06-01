# v6 Audit Findings
**Audited files:** `v6-main-p12.gs` (4517 lines), `v6-dev.gs` (611 lines)
**Reference docs read:** `v6-master-reference.md`, `v6-implementation-plan.md`, `v6-build-log.md`
**Audit scope:** Correctness, safety, performance, design per `v6-audit-agent-prompt.md`

---

## Summary

| Severity | Count | Findings |
|----------|-------|----------|
| CRITICAL | 1 | FINDING-001 |
| HIGH | 3 | FINDING-002, FINDING-003, FINDING-004 |
| MEDIUM | 4 | FINDING-005, FINDING-006, FINDING-007, FINDING-008 |
| LOW | 2 | FINDING-009, FINDING-010 |
| INFO | 2 | FINDING-011, FINDING-012 |

**Overall assessment: PASS WITH CONDITIONS.**
The script is production-ready for normal daily runs. One CRITICAL defect exists in the AGG repair path and must be fixed before any partial-chain repair run. Three HIGH findings (Partners sheet bug, silent SupplyComputed gaps, exposed Slack webhook) should be resolved before the next deploy.

---

## Phase Regression Checklist

| Phase | Description | Status | Notes |
|-------|-------------|--------|-------|
| Ph-1 | Foundation: DEADLINES, UTC, notifySlack | **PASS** | `DEADLINES` correct; `formatYMD` uses `'UTC'`; `notifySlack` reads webhook from Script Properties |
| Ph-2 | ctx / factsValueIndex architecture | **PASS** | `getExistingFactsIndex` returns `{index, maxDates, factsValueIndex}`; `lookupValue` checks batchByKey first; `pushRow` updates both `rows[]` and `batchByKey` |
| Ph-3 | Remove adapter sheet reads | **PASS** | No sheet reads inside adapters; all dependency lookups go through `lookupValue(ctx, …)` |
| Ph-4 | Etherscan validation + fallback | **PASS** | `parseInt`/`isFinite`/positive guard present; `ETH_GD_TOTAL_SUPPLY_CONST` and `ETH_GD_FROZEN_SUPPLY_CONST` used on failure |
| Ph-5 | Deadlines + Dune null fix | **PARTIAL** | Query-level null (`duneDataCache[id] = null`) correctly handled. Cell-level null coercion not fixed — see FINDING-005 |
| Ph-6 | Append-at-bottom + batched formats | **PASS** | `getLastRow()+1` used for all appends; number formats batched by decimal group via `getRangeList` |
| Ph-7 | XdcReserveComputed date loop | **PASS** | While loop `d <= untilYMD` present for all 4 XDC reserve metric types; `daily_minted` uses `lookupValue` |
| Ph-8 | AGG correction on partial-chain repair | **PARTIAL** | AGG sum logic correct (reads both batchByKey and factsValueIndex, `chainsAdded` dedup). Update-in-place path broken — see FINDING-001 (CRITICAL) |
| Ph-9 | Silent gap visibility | **PARTIAL** | `xdcFetchDailyField` ✓; `xdcFetchGlobalTotal` ✓; Computed warn sentinel ✓; XdcReserveComputed warn ✓. SupplyComputed still silent (FINDING-003). `xdcFetchTransactionDaily/Lifetime` still use `\|\| 0` (FINDING-006) |
| Ph-10 | Registry + budget guards | **PASS** | All 28 XdcInvites metric keys registered; `checkBudget()` called before all 9 adapter groups |
| Ph-11 | Health sheet redesign | **PASS** | 11-column health schema; ok/0 suppression; SUMMARY row; Slack critical alert on exception; `ensureSheets` auto-migrates |
| Ph-12 | XDC Invites standalone pipeline | **PASS** | `updateXdcInvitesPipeline()` not called from `smartBackfill()`; `xdcInvitesAggregateRaw` emits exactly 28 metrics (14 daily + 14 `_at`); cumulative sweep starts from `firstDay` to preserve state |

---

## Findings

---

### FINDING-001 [CRITICAL] — AGG Update Path Uses `row = true` Instead of Row Number (Header Corruption Risk)

**File:** `v6-main-p12.gs`  
**Location:** `writeFactsAndHealth()`, ~lines 3120–3165 (partition + update loop)

**Description:**  
`getExistingFactsIndex()` stores the existence index as `{ "date|chain|metric_key": true }` — a boolean sentinel, not a row number. `writeFactsAndHealth()` uses this as its `existingIndex`. In the partition loop:

```js
const rowNum = existingIndex[key];   // → true (not a row number)
if (rowNum) {
  updates.push({ row: rowNum, … }); // → { row: true, … }
}
```

Then the update loop runs:
```js
facts.getRange(u.row, 1, 1, u.values.length).setValues([u.values]);
// equivalent to: facts.getRange(true, 1, 1, 6) → getRange(1, 1, 1, 6)
```

In GAS, `true` coerces to `1` in numeric contexts, so this writes to row 1 — the header row.

**When is this triggered?**  
Only in repair scenarios, which is precisely the scenario Phase 8 was designed to fix. Specifically: if a prior run wrote AGG rows for a date (e.g., CELO-only AGG), and a repair run now fetches the missing chain (XDC) for that same date, `batchDates` includes the date, a new corrected AGG row is generated inside `writeFactsAndHealth()`, the key is in `existingIndex` with value `true`, and the update path fires with `row = true`.

Normal daily runs are **safe**: they generate AGG rows for new dates that don't yet have AGG entries in `existingIndex` → those go to appends, not updates.

**Impact:** Header row `date|chain|metric_key|value|source|updated_at` is silently overwritten with AGG data, corrupting the facts sheet irreversibly. Or GAS throws if it validates the row argument, causing a Slack CRITICAL alert and pipeline failure.

**Root cause:** `indexResult.index` was designed as an existence check (`true`/`false`) for `buildRows()` deduplication. The update path in `writeFactsAndHealth()` incorrectly reuses this structure as if it contained row numbers. The fallback path (when `indexResult` is `null`, used only by `backfillGdUsdPrice()`) correctly builds a row-number index from a fresh sheet read.

**Fix (two options):**  
A. In `writeFactsAndHealth()`, add a guard:
```js
if (rowNum === true) {
  // existingIndex has no row number — force append (will create a duplicate
  // that must be deduped by the operator, but is safe). Or: skip the AGG row
  // if we accept stale AGG until the next full daily run.
  appends.push({ values: toRow(r), dp: r.decimals });
  continue;
}
```
B. (Preferred, longer) Change `getExistingFactsIndex()` to also store row numbers as `2 + i`, mirroring what the fallback code already does.

---

### FINDING-002 [HIGH] — `updatePartnersSheet()` Silently Writes All-Empty Rows

**File:** `v6-main-p12.gs`  
**Location:** `updatePartnersSheet()`, ~lines 3365–3400

**Description:**  
`duneFetchTable()` returns `rows` as an array of numeric-indexed arrays (v6 refactor). `updatePartnersSheet()` was not updated and still accesses data by column name:

```js
for (var j = 0; j < cols.length; j++) {
  row.push(rows[i][cols[j]] || '');  // cols[j] is a string; rows[i][string] = undefined
}
```

Every cell evaluates to `undefined || ''` = `''`. The Partners sheet is overwritten with empty rows on every call, while the header row (correctly written from `cols`) looks valid.

**Impact:** The Partners sheet loses all Dune data silently after the first v6 run. No error is logged because `rows.length > 0` passes the guard.

**Fix:**
```js
row.push(rows[i][j] !== undefined ? rows[i][j] : '');
```

---

### FINDING-003 [HIGH] — SupplyComputed Missing Dependencies Emit No Health Warning (S4 Incomplete)

**File:** `v6-main-p12.gs`  
**Location:** `Adapters.SupplyComputed.fetch()` (missing-component branches); `buildRows()` SupplyComputed consumer, ~line 2873

**Description:**  
When `eth_gd_in_circulation` or `agg_gd_in_circulation` cannot be computed (null inputs), `SupplyComputed.fetch()` logs a message and returns `[]`. The consumer:

```js
var results = Adapters.SupplyComputed.fetch(…);
var count = 0;
for (var j = 0; j < results.length; j++) { … count++; }
addHealth('SUPPLY_COMPUTED', chain, metricKey, 'ok', count, 0, '', …);
```

When `results = []`, `count = 0`, and the `ok/0` suppression rule hides this health row entirely. The health sheet shows nothing — identical to "already up to date." Master reference bug **S4 is not fixed.**

Compare with `Adapters.Computed.fetch()` and `Adapters.XdcReserveComputed.fetch()`, which both use a warn-sentinel pattern (`r.warn === true`) to emit explicit `'warn'` health rows when upstream values are unavailable.

**Impact:** If Etherscan fails AND no prior value exists in `factsValueIndex`, both `eth_gd_in_circulation` and `agg_gd_in_circulation` silently gap. The only way to detect this is via `runGapReport()` — there is no proactive alert.

**Fix:**  
Either (a) have `SupplyComputed.fetch()` return `{ rows, warnMessage }` like the Computed adapter and update the consumer to emit `addHealth(…, 'warn', …)`, or (b) in the consumer, detect `count === 0` after the loop and emit a warn row when the metric was expected for the current date range.

---

### FINDING-004 [HIGH] — Live Slack Webhook URL Hardcoded in Planning Document

**File:** `v6-implementation-plan.md`  
**Location:** Phase 14a, Script Properties table, ~line 942

**Description:**  
```
| SLACK_WEBHOOK_URL | [REDACTED — stored in Script Properties] |
```

This is a live, operational Slack webhook URL committed in plaintext in a workspace file. Anyone with read access to this repository can post arbitrary messages to the target Slack channel. The code itself is correct (the URL is loaded from `PropertiesService` at runtime). The exposure is confined to this planning document.

**Impact:** Unauthorized Slack messages; potential for spam or social-engineering content in the GoodDollar Slack workspace. The webhook remains exploitable until revoked.

**Fix:**  
1. **Revoke the webhook immediately** via the Slack app management console.
2. Generate a new webhook and set it only in Script Properties.
3. Replace the URL in this file with a placeholder: `https://hooks.slack.com/services/T.../.../<redacted>`.

---

### FINDING-005 [MEDIUM] — Dune Adapter Coerces Null Cell Values to 0

**File:** `v6-main-p12.gs`  
**Location:** `buildRows()`, Dune processing loop, ~line 2656

**Description:**  
```js
const raw = row[valueIdx];
const val = Number(String(raw).replace(/,/g, '')) || 0;
```

When `raw` is `null` (Dune returns null for fields with no value): `String(null)` = `"null"`, `Number("null")` = `NaN`, `NaN || 0` = `0`. Null cells are written as 0 instead of being skipped.

Phase 5 checklist item: *"Dune adapter: null/undefined column values treated as missing data (skipped), NOT coerced to 0."* Not implemented.

**Impact:** If Dune returns a row for a date with a null metric value (e.g., a metric not yet computed by Dune for that date), 0 is written as real data. This is a different defect from the query-level null fix (which was implemented correctly).

**Fix:**
```js
const raw = row[valueIdx];
if (raw == null) continue;  // skip null/undefined cells
const val = Number(String(raw).replace(/,/g, '')) || 0;
```

---

### FINDING-006 [MEDIUM] — `xdcFetchTransactionDaily` and `xdcFetchTransactionLifetime` Skip Phase 9 Null Guard

**File:** `v6-main-p12.gs`  
**Location:** `xdcFetchTransactionDaily()`, ~line 1382; `xdcFetchTransactionLifetime()`, ~line 1406

**Description:**  
Phase 9 applied `if (n[fieldName] == null) continue;` to `xdcFetchDailyField()` and `if (g[fieldName] == null) return [];` to `xdcFetchGlobalTotal()`. However, `xdcFetchTransactionDaily` and `xdcFetchTransactionLifetime` were not updated:

```js
// xdcFetchTransactionDaily (line ~1382) — still coerces:
var val = Number(String(n[fieldName] || 0).replace(/,/g, ''));

// xdcFetchTransactionLifetime (line ~1406) — still coerces:
var val = Number(String(g[fieldName] || 0).replace(/,/g, ''));
```

**Affected metrics:** `xdc_p2p_tx_count`, `xdc_p2p_gd_amount`, `xdc_p2p_lifetime_tx_count`, `xdc_p2p_lifetime_gd_amount`, `xdc_gd_in_circulation` (via `xdcFetchTransactionLifetime`).

**Fix:** Apply the same null guard:
```js
// In xdcFetchTransactionDaily:
if (n[fieldName] == null) { Logger.log('…'); continue; }

// In xdcFetchTransactionLifetime:
if (g[fieldName] == null) { Logger.log('…'); return []; }
```

---

### FINDING-007 [MEDIUM] — `Adapters.Computed.fetch()` Silently Skips Zero-Value Source Days

**File:** `v6-main-p12.gs`  
**Location:** `Adapters.Computed.fetch()`, ~lines 2240–2280

**Description:**  
```js
var sourceValue = lookupValue(ctx, d, chain, sourceMetric);
if (sourceValue !== null && sourceValue !== 0) {
  …
}
```

When `sourceValue === 0` (a legitimate zero, e.g., zero P2P volume on a given day), the entire date is silently skipped — no row is written and no warn is emitted. This creates a gap in the computed USD metric for every zero-activity day.

**Impact:** `runGapReport()` would flag every zero-volume day as a gap for USD-computed metrics (e.g., `xdc_p2p_usd_amount`). Dashboard queries that calculate totals or moving averages over these metrics will produce incorrect results due to missing rows.

**Fix:** Remove `&& sourceValue !== 0` from the condition. A zero source value should produce a 0 USD row (`0 * price = 0`), not a gap.

---

### FINDING-008 [MEDIUM] — `testEtherscanFallback()` Always Reports False Negative

**File:** `v6-dev.gs`  
**Location:** `testEtherscanFallback()`, ~lines 210–240

**Description:**  
`fetchEthereumSupply()` and `fetchEthereumFrozenSupply()` return an array `[{date, value, source}]`, not a bare number. The test function checks:

```js
var liveTotal = fetchEthereumSupply();        // returns [{…}]
if (typeof liveTotal === 'number' && liveTotal > 0) { … }  // always false
else { Logger.log('…unexpected value…  [warn]'); }
```

The check `typeof [{…}] === 'number'` is always `false`, so the test always logs `[warn]` even when Etherscan is fully functional. Additionally, `fetchEthereumSupply()` is called without the required `untilYMD` argument, meaning the returned row has `date: undefined`.

**Impact:** Dev-only function. No production impact, but it makes Etherscan connectivity testing unreliable — every manual health check looks like a failure.

**Fix:**
```js
var liveTotal = fetchEthereumSupply(getYesterdayYMD());
if (Array.isArray(liveTotal) && liveTotal.length > 0 && liveTotal[0].value > 0) {
  Logger.log('  live supply: ' + liveTotal[0].value + ' G$  [ok]');
}
```

---

### FINDING-009 [LOW] — Number Formats for Updated Rows Applied Per-Row (T4 Partial Fix)

**File:** `v6-main-p12.gs`  
**Location:** `writeFactsAndHealth()`, update loop, line 3163

**Description:**  
For new append rows, number formats are correctly batched via `getRangeList` (1 API call per decimal-precision group). For updated rows (in-place overwrites), formats are still applied one at a time:

```js
facts.getRange(u.row, 4).setNumberFormat(numberFormatFor(u.dp));  // per row
```

**Impact:** In normal daily runs the update path is only triggered for AGG rows on repair runs — a small number of calls. For large backfill repairs of pre-existing data, this could accumulate many per-row format calls. Severity is low in practice given the small update set in typical scenarios.

---

### FINDING-010 [LOW] — `Adapters.Reserve._bundle` Stored as Static Object Property, Not in `ctx`

**File:** `v6-main-p12.gs`  
**Location:** `Adapters.Reserve`, ~lines 2200–2230

**Description:**  
The reserve volume bundle is cached as `Adapters.Reserve._bundle = null` (static property on the adapter object), not in `ctx.reserveVolumeBundle` as specified in the build log. The three reserve volume metrics that share this bundle all call `Adapters.Reserve.fetch()`, which initialises `_bundle` on the first call and reuses it for subsequent calls.

**Impact:** Negligible in production. Each GAS invocation starts a fresh V8 context, so `_bundle` resets to `null` on each execution. The risk of stale data only exists if `buildRows()` were called twice in a single execution (not the current code path).

---

### FINDING-011 [INFO] — `getYesterdayYMD()` Uses `setDate(-1)` Instead of `Date.now() - 86400000`

**File:** `v6-main-p12.gs`  
**Location:** `getYesterdayYMD()`, ~lines 1000–1005

**Description:**  
```js
function getYesterdayYMD() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatYMD(d);
}
```

The Phase 1 spec says "subtracts exactly 86,400,000ms from `Date.now()`." `setDate(getDate()-1)` performs local-calendar arithmetic, which differs from subtracting exactly 86,400s during DST transitions.

In practice this is a non-issue: `formatYMD()` formats the result in UTC explicitly (`Utilities.formatDate(d, 'UTC', …)`), which compensates for any local-timezone offset applied by `setDate`. Manual verification with UTC offsets of −3, 0, and +5:30 all produce the correct yesterday date.

The `testTimezone()` function in `v6-dev.gs` verifies this against `Utilities.formatDate(new Date(Date.now() - 86400000), 'UTC', 'yyyy-MM-dd')`, so any divergence would be caught at runtime.

---

### FINDING-012 [INFO] — `Adapters.Dune.buildDateMap()` Is Dead Code

**File:** `v6-main-p12.gs`  
**Location:** `Adapters.Dune.buildDateMap()`, ~lines 2180–2195

**Description:**  
This method calls `duneFetchTable()` directly (bypassing the batch cache), constructing a `{ymd: value}` map. It is not called anywhere in the production pipeline. `buildRows()` uses the `duneDataCache` pattern instead. The function appears to be a holdover from a pre-batch-cache design.

**Impact:** None. Dead code only.

---

## Open Questions

1. **FINDING-001 GAS coercion confirmation:** Does GAS's `Sheet.getRange(true, 1, …)` coerce `true` to `1` and write to row 1, or does it throw `Invalid argument`? Runtime testing needed to confirm whether the failure mode is silent corruption or a noisy exception.

2. **FINDING-005 null cell frequency:** Does the current set of Dune queries (`ACTIVE_CLAIMERS`, `UBI_SUMMARIES`, `P2P_TRANSFERS`, `LIFETIMES`, `NEW_VS_RETURN`) ever return null for individual cell values in practice? If Dune queries always return complete rows for dates present in the result set, FINDING-005 is low-probability but still worth guarding.

3. **FINDING-006 XDC transaction schema:** Can `transactionsCountClean` or `transactionsValueClean` be null in the XDC Goldsky subgraph? If the subgraph guarantees non-null for these fields when the entity exists, the risk is low — but the guard is cheap to add.

4. **Phase 8 repair cadence:** Is there an existing runbook or operational procedure for partial-chain repair runs? If repairs are never run manually (only the daily cron fires), FINDING-001 has lower urgency. If operators occasionally re-run for missed dates, it must be fixed before the next such occasion.

---

## Positive Observations

These are specific design decisions and implementation details that are done correctly and deserve recognition.

- **AGG sum logic is architecturally sound.** The `chainsAdded[chain]` deduplication guard in the AGG loop correctly prevents double-counting when iterating over multiple aggregate-flagged metrics that share the same `baseMetric`. Reading from both `batchByKey` (current run's new data) and `factsValueIndex` (prior history) to compute cross-chain sums is the right design for repair scenarios. The bug is confined to the write path, not the computation.

- **Etherscan fallback is robust.** `fetchEthereumSupply()` and `fetchEthereumFrozenSupply()` use `parseInt` + `isFinite` + positive-number validation and fall back to hardcoded constants. The constants are checked for sanity (`frozen < total`) in `testEtherscanFallback()`. Bug A1/A2 are fully fixed.

- **No credentials hardcoded in the main script.** All secrets (`SLACK_WEBHOOK_URL`, `DUNE_API_KEY`, `ETHERSCAN_API_KEY`, `HYPERSYNC_TOKEN`) are read from `PropertiesService` at runtime. The security finding (FINDING-004) is isolated to the planning document, not to the production code.

- **XdcInvites cumulative sweep is correct.** `xdcInvitesAggregateRaw()` starts the replay from `firstDay` (the earliest day in the raw data) even when `sinceYMD` is later. This correctly preserves all cumulative `_at` state and avoids the "stale cumulative on resume" bug pattern.

- **Budget guards cover all 9 adapter groups.** `checkBudget()` is called before every adapter group in `buildRows()` — Dune, Subgraph, Reserve, Computed, Supply, SupplyComputed, XdcReserve, XdcReserveComputed, XdcInvites. Under the 6-minute GAS execution cap, this ensures the pipeline always emits a partial result plus a health record, never silently truncates.

- **11-column health schema + ok/0 suppression** cleanly separates genuine failures (warn/error rows) from noise. The `ok/0` rule (suppress health rows for adapters that wrote zero new rows without error) correctly handles the common case of "data already up to date" without polluting the health sheet.

- **`xdcInvitesAggregateRaw()` emits exactly 28 metrics** (14 daily + 14 cumulative `_at`), matching the METRICS registry exactly. The per-day and per-set deduplication sets (`seenInvitees`, `seenInviters`) are correctly scoped outside the day loop, enabling accurate cumulative unique-user counts across the full sweep.

- **`deleteOldInviteRows()` uses correct reverse-iteration.** The loop iterates `data.length - 1` down to `1`, avoiding row-shift bugs when deleting multiple rows from a spreadsheet.

- **`testCtxLookup()` is pure.** The test constructs an in-memory `ctx` object and validates `lookupValue()` semantics (batchByKey priority over factsValueIndex, null on miss) without touching any spreadsheet. Safe to run at any time.

- **`Adapters.XdcReserveComputed.fetch()` date loop covers the full range.** All four metric types (`daily_price`, `daily_reserve_ratio`, `daily_minted`, `daily_volume_usd`) use `d = sinceYMD; while (d <= untilYMD) { … d = addDays(d, 1); }`. Bug R2 (single-date only) is fully fixed.

---

---

# Re-evaluation: v6-daily.gs
**File:** `v6-daily.gs` (4 430+ lines)
**Date:** 2026-05-26
**Context:** User applied fixes from the prior audit (documented in a separate fix plan) and delivered `v6-daily.gs` as the updated production file. This section records the outcome of the re-evaluation against the original 12 findings and identifies any new issues introduced alongside the fix work (new 7d/30d rolling P2P metrics and one-shot backfill utilities).

---

## Status of Prior Findings

| Finding | Severity | Status | Notes |
|---------|----------|--------|-------|
| FINDING-001 | CRITICAL | **FIXED** | `getExistingFactsIndex()` now stores `index[key] = 2 + i` (actual 1-based row numbers). Update path calls `getRange(rowNum, …)` with valid integers. AGG repair path is now safe. |
| FINDING-002 | HIGH | **FIXED** | `updatePartnersSheet()` now uses `rows[i][j]` (numeric index). |
| FINDING-003 | HIGH | **FIXED** | `Adapters.SupplyComputed.fetch()` now returns `{ warn: true, date, message }` sentinels when components are null. Consumer calls `addHealth('SUPPLY_COMPUTED', …, 'warn', …)`. |
| FINDING-004 | HIGH | **External** | Slack webhook URL in `v6-implementation-plan.md` — user to handle separately via Slack app console. Not present in `v6-daily.gs`. |
| FINDING-005 | MEDIUM | **FIXED** | `if (raw == null) continue;` added before the `Number(…) \|\| 0` conversion in the Dune cell-processing loop. |
| FINDING-006 | MEDIUM | **FIXED** | Both `xdcFetchTransactionDaily()` and `xdcFetchTransactionLifetime()` now have `if (n[fieldName] == null)` / `if (g[fieldName] == null)` guards. |
| FINDING-007 | MEDIUM | **FIXED** | Condition changed from `if (sourceValue !== null && sourceValue !== 0)` to `if (sourceValue !== null)`. Zero-volume days now emit a `0 * price` row. |
| FINDING-008 | MEDIUM | **N/A** | `testEtherscanFallback()` was in `v6-dev.gs`, which is not part of `v6-daily.gs`. Not applicable to this file. |
| FINDING-009 | LOW | **Open** | Update-row number formats still applied per-row (`setNumberFormat` in a loop). Unchanged. |
| FINDING-010 | LOW | **Open** | `Adapters.Reserve._bundle` still a static object property, not in `ctx`. No production risk. Unchanged. |
| FINDING-011 | INFO | **Open** | `getYesterdayYMD()` still uses `setDate(getDate()-1)`; `formatYMD`'s UTC path compensates. Unchanged. |
| FINDING-012 | INFO | **Open** | `Adapters.Dune.buildDateMap()` still dead code. Unchanged. |

**Overall: all CRITICAL and HIGH/MEDIUM code findings are resolved. The script is significantly improved.**

---

## New Findings

---

### NEW-001 [MEDIUM] — `backfillNewP2PMetrics()` Produces No AGG Rows for Historical Dates

**Location:** `backfillNewP2PMetrics()`, line 3656

**Description:**
```js
writeFactsAndHealth({ rows: rows, health: [], runId: runIdStr });
//                    ^^^ no batchByKey, no indexResult argument
```

`writeFactsAndHealth()` reads `batchByKey = buildResult.batchByKey || {}`. With no `batchByKey` property on the object, this is `{}`. `batchDates` (keyed by date from `batchByKey`) is therefore empty, and the AGG loop iterates zero times.

The function writes all XDC P2P data rows correctly (the fallback sheet-read `existingIndex` handles appends/updates), but **generates no AGG rows** for any of the new rolling metrics (`agg_p2p_tx_count_7d`, `agg_p2p_gd_amount_7d`, `agg_p2p_tx_count_30d`, `agg_p2p_gd_amount_30d`) for the entire historical date range from GENESIS to yesterday.

Because those XDC rows are then present in `existingIndex` on all future daily runs, those historical dates will never appear in `batchDates` again — the AGG rows will not auto-populate on subsequent cron runs.

**Fix:**
```js
var batchByKey = {};
for (var i = 0; i < rows.length; i++) {
  batchByKey[rows[i].date + '|' + rows[i].chain + '|' + rows[i].metric_key] = rows[i].value;
}
var indexResult = getExistingFactsIndex();
writeFactsAndHealth({ rows: rows, health: [], runId: runIdStr, batchByKey: batchByKey }, indexResult);
```

---

### NEW-002 [MEDIUM] — `fixRollingSumMetrics()` Has the Same Missing-`batchByKey` Problem

**Location:** `fixRollingSumMetrics()`, line 3707

**Description:**
Identical to NEW-001. The call is:
```js
writeFactsAndHealth({ rows: rows, health: [], runId: runIdStr });
```

After this utility re-fetches XDC rolling UBI metrics (`xdc_gd_claimed_30d`, `xdc_gd_claimed_7d`, `xdc_gd_per_user_30d`, `xdc_gd_per_user_7d`), the corresponding AGG rows (`agg_gd_claimed_30d`, `agg_gd_claimed_7d`, etc.) are not recomputed for historical dates. The data rows themselves are written correctly.

**Fix:** Same as NEW-001 — build `batchByKey` from `rows[]` and call `getExistingFactsIndex()` before the `writeFactsAndHealth` call.

---

### NEW-003 [LOW] — AGG Number Format in Append Path Ignores Stored `dp`, Falls Back to 2

**Location:** `writeFactsAndHealth()`, append-path format loop, line ~3190

**Description:**
```js
var mKey = appends[i].values[2];   // e.g. 'agg_p2p_tx_count_7d'
var dp = (METRICS[mKey] && METRICS[mKey].decimals !== undefined) ? METRICS[mKey].decimals : 2;
// METRICS['agg_p2p_tx_count_7d'] is undefined → dp = 2 (wrong; should be 0)
```

AGG rows are created with the correct `decimals: agg.dp` (e.g. `0` for count metrics), and `appends.push({ values: toRow(r), dp: r.decimals })` stores that value as `appends[i].dp`. However, the format loop ignores `appends[i].dp` and instead re-resolves dp via `METRICS`, which does not contain AGG keys. The fallback is always `2`.

This was a pre-existing defect. It now affects more keys because of the new rolling metrics (`agg_p2p_tx_count_7d`, `agg_p2p_tx_count_30d`), which are integer-count metrics formatted as `#,##0.00` instead of `#,##0` on initial write. The update path (triggered on repair runs) correctly uses `u.dp`, so the format is repaired if the row is ever overwritten. Correctness of the stored value is unaffected.

**Fix:**
```js
var dp = appends[i].dp !== undefined
  ? appends[i].dp
  : (METRICS[mKey] && METRICS[mKey].decimals !== undefined ? METRICS[mKey].decimals : 2);
```

---

### NEW-004 [INFO] — `XdcInvites` Adapter Reads the Raw Sheet 28× Per `buildRows()` Call

**Location:** `Adapters.XdcInvites.fetch()` → `xdcInvitesAggregateRaw()` → `xdcInvitesReadRaw()`

**Description:**
The XdcInvites adapter is called once per registry metric (28 entries). Each invocation calls `xdcInvitesAggregateRaw()`, which performs a full `xdcInvitesReadRaw()` (entire sheet read), a full `.sort()`, and a full aggregate sweep. At current scale this is acceptable. As the raw sheet grows to tens of thousands of rows, 28 sequential full reads and sorts will become the dominant cost in `buildRows()` and could exhaust the 6-minute GAS budget.

**Fix (not urgent):** Call `xdcInvitesAggregateRaw()` once before the adapter loop in `buildRows()` and pass the cached result through, rather than re-computing it on every metric call.

---

## Re-evaluation Summary

| Category | Count |
|----------|-------|
| Prior findings confirmed fixed (code) | 6 (FINDING-001 to -007, excluding -004 and -008) |
| Prior findings still open (low/info, unchanged) | 4 (FINDING-009, -010, -011, -012) |
| New findings (MEDIUM) | 2 (NEW-001, NEW-002) |
| New findings (LOW) | 1 (NEW-003) |
| New findings (INFO) | 1 (NEW-004) |

**Verdict: PASS for production cron use.** The two MEDIUM utility-function findings (NEW-001, NEW-002) must be fixed before running `backfillNewP2PMetrics()` or `fixRollingSumMetrics()`, otherwise historical AGG rows for the new rolling metrics will be permanently absent from the facts sheet and will not self-heal on subsequent daily runs.
