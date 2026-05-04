/**
 * GoodDollar — Event Pipeline Cost Estimator
 *
 * Scans every deployed GoodDollar contract (Celo, XDC, Ethereum — Fuse excluded)
 * via Envio HyperSync to count historical log volumes and estimate BigQuery costs.
 *
 * Two run modes (see README.md for full details):
 *
 *   QUICK  (default) — counts only the last 7 days per contract to establish a
 *                      daily rate, then ESTIMATES the historical total from
 *                      (dailyRate × daysSinceFirstBlock). Fast: ~3–8 min total.
 *
 *   FULL   (--full)  — streams ALL logs from firstBlock to tip for each contract.
 *                      Accurate for backfill sizing. Slow: 30–90+ min depending
 *                      on G$ token transfer volume on Celo / Ethereum.
 *
 * Optional flags:
 *   --full               Enable full historical scan
 *   --group <name>       Only scan contracts in this group (e.g. "UBIScheme")
 *   --timeout <seconds>  Per-contract timeout in full mode (default: 300s)
 *
 * Output: cost-estimate-YYYY-MM-DD.csv  — import directly into Google Sheets.
 */

// @ts-ignore — NAPI-RS generated package has a known TypeScript export quirk
import { HypersyncClient } from "@envio-dev/hypersync-client";
import { writeFileSync }    from "fs";
import { config }           from "dotenv";

config(); // load .env from current directory

// ─────────────────────────────────────────────────────────────────────────────
// CLI FLAG PARSING
// ─────────────────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const FULL_MODE   = args.includes("--full");
const GROUP_FILTER: string | undefined = (() => {
  const idx = args.indexOf("--group");
  return idx !== -1 ? args[idx + 1] : undefined;
})();
const PER_CONTRACT_TIMEOUT_MS: number = (() => {
  const idx = args.indexOf("--timeout");
  return idx !== -1 ? parseInt(args[idx + 1], 10) * 1000 : 300_000; // default 5 min
})();

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING — structured, timestamped, consistent across the whole run
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "SKIP";

function log(level: LogLevel, msg: string): void {
  const ts    = new Date().toISOString().replace("T", " ").slice(0, 19);
  const label = level.padEnd(5);
  console.log(`[${ts}] [${label}] ${msg}`);
}

function logSeparator(title?: string): void {
  const line = "─".repeat(60);
  if (title) {
    console.log(`\n${line}`);
    console.log(`  ${title}`);
    console.log(`${line}`);
  } else {
    console.log(line);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAIN CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

type Chain = "ETHEREUM" | "CELO" | "XDC";

/** Average blocks mined per day on each chain. */
const BLOCKS_PER_DAY: Record<Chain, number> = {
  ETHEREUM: 7_200,   // ~12 s block time
  CELO:     17_280,  // ~5 s block time
  XDC:      43_200,  // ~2 s block time
};

/** Envio HyperSync endpoint for each chain. */
const HYPERSYNC_URL: Record<Chain, string> = {
  ETHEREUM: "https://eth.hypersync.xyz",
  CELO:     "https://celo.hypersync.xyz",
  XDC:      "https://xdc.hypersync.xyz",
};

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT DEFINITIONS
// Source: https://docs.gooddollar.org/for-developers/core-contracts
// Fuse is explicitly excluded (out of scope per team decision).
//
// firstBlock values marked [~] are APPROXIMATE deployment block estimates.
// They are used to bound the historical scan range. If the estimate is too
// early (before the real deployment), the scan returns 0 events for that
// range — it does NOT affect count accuracy, only scan duration.
// Refine these values for faster future re-runs.
// ─────────────────────────────────────────────────────────────────────────────

interface ContractSpec {
  group:        string;    // logical grouping — controls CSV sections and --group filter
  label:        string;    // human-readable name shown in logs and CSV
  chain:        Chain;
  address:      string;    // checksummed or lowercase — HyperSync accepts both
  firstBlock:   number;    // [~] = approximate; exact values commented where known
  note?:        string;    // surfaces in CSV — flag any known data-quality concerns
}

const CONTRACTS: ContractSpec[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // G$ TOKEN
  // Expected volume: HIGH — every wallet Transfer, DEX swap, and Superfluid
  // stream operation emits events. Likely the largest single source of logs.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    group:      "G$ Token",
    label:      "GoodDollar ERC20 / Ethereum",
    chain:      "ETHEREUM",
    address:    "0x67C5870b4A41D4Ebef24d2456547A03F1f3e094B",
    firstBlock: 10_700_000, // [~] GoodDollar Ethereum mainnet launch ~Aug 2020
  },
  {
    group:      "G$ Token",
    label:      "GoodDollar SuperGoodDollar / Celo",
    chain:      "CELO",
    address:    "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
    firstBlock: 13_000_000, // [~] GoodDollar Celo launch ~2022
  },
  {
    group:      "G$ Token",
    label:      "GoodDollar SuperGoodDollar / XDC",
    chain:      "XDC",
    address:    "0xEC2136843a983885AebF2feB3931F73A8eBEe50c",
    firstBlock: 90_000_000, // [~] GoodDollar XDC launch ~2024
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // UBISCHEME
  // Expected volume: HIGH — UBIClaimed fires once per active user per day.
  // Celo has ~4 years of history; this will dominate backfill row count.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    group:      "UBIScheme",
    label:      "UBIScheme / Celo",
    chain:      "CELO",
    address:    "0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1",
    firstBlock: 18_006_679, // exact — from pipeline CONTRACT_CONFIGS
  },
  {
    group:      "UBIScheme",
    label:      "UBIScheme / XDC",
    chain:      "XDC",
    address:    "0x22867567E2D80f2049200E25C6F31CB6Ec2F0faf",
    firstBlock: 95_249_624, // exact — from pipeline CONTRACT_CONFIGS
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // INVITE
  // Expected volume: MEDIUM — one-time per user (join + optional payout).
  // ═══════════════════════════════════════════════════════════════════════════
  {
    group:      "Invite",
    label:      "InviteContract / Celo",
    chain:      "CELO",
    address:    "0x36829D1Cda92FFF5782d5d48991620664FC857d3",
    firstBlock: 18_483_200, // exact — from pipeline CONTRACT_CONFIGS
  },
  {
    group:      "Invite",
    label:      "InviteContract / XDC",
    chain:      "XDC",
    address:    "0x6bd698566632bf2e81e2278f1656CB24aAF06D2e",
    firstBlock: 95_144_756, // exact — from pipeline CONTRACT_CONFIGS
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // IDENTITY
  // Expected volume: MEDIUM — every new user whitelisting emits an event.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    group:      "Identity",
    label:      "Identity / Ethereum",
    chain:      "ETHEREUM",
    address:    "0x76e76e10Ac308A1D54a00f9df27EdCE4801F288b",
    firstBlock: 10_700_000, // [~]
  },
  {
    group:      "Identity",
    label:      "Identity / Celo",
    chain:      "CELO",
    address:    "0xC361A6E67822a0EDc17D899227dd9FC50BD62F42",
    firstBlock: 13_000_000, // [~]
  },
  {
    group:      "Identity",
    label:      "Identity / XDC",
    chain:      "XDC",
    address:    "0x27a4a02C9ed591E1a86e2e5D05870292c34622C9",
    firstBlock: 90_000_000, // [~]
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MENTO RESERVE & DEFI
  // Expected volume: MEDIUM — swap and liquidity operations.
  //
  // ⚠️  WARNING: The GoodDollar core contracts docs list the same address
  //     (0x94A3240...) for MentoReserve, MentoExpansionController,
  //     MentoExchangeProvider, AND MentoBroker on both Celo and XDC.
  //     This is almost certainly a documentation error (copy-paste of the
  //     proxy/router address). The log count here will reflect ALL events
  //     from that address — which may combine multiple contracts.
  //     Verify individual contract addresses before building production
  //     pipeline ingestion for this group.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    group:   "Mento / Reserve & DeFi",
    label:   "Mento contracts (shared address) / Celo",
    chain:   "CELO",
    address: "0x94A3240f484A04F5e3d524f528d02694c109463b",
    firstBlock: 20_000_000, // [~]
    note:    "⚠️ Docs show same address for Reserve + ExpansionController + ExchangeProvider + Broker — verify individual addresses before prod ingestion",
  },
  {
    group:   "Mento / Reserve & DeFi",
    label:   "Mento contracts (shared address) / XDC",
    chain:   "XDC",
    address: "0x94A3240f484A04F5e3d524f528d02694c109463b",
    firstBlock: 90_000_000, // [~]
    note:    "⚠️ Docs show same address for Reserve + ExpansionController + ExchangeProvider + Broker — verify individual addresses before prod ingestion",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BRIDGE
  // Expected volume: MEDIUM — cross-chain transfers; proportional to bridge usage.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    group:      "Bridge",
    label:      "MessagePassingBridge / Ethereum",
    chain:      "ETHEREUM",
    address:    "0xa3247276DbCC76Dd7705273f766eB3E8a5ecF4a5",
    firstBlock: 14_000_000, // [~]
  },
  {
    group:      "Bridge",
    label:      "MessagePassingBridge / Celo",
    chain:      "CELO",
    address:    "0xa3247276DbCC76Dd7705273f766eB3E8a5ecF4a5",
    firstBlock: 16_000_000, // [~]
  },
  {
    group:      "Bridge",
    label:      "MessagePassingBridge / XDC",
    chain:      "XDC",
    address:    "0xa3247276DbCC76Dd7705273f766eB3E8a5ecF4a5",
    firstBlock: 90_000_000, // [~]
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DAO
  // Expected volume: LOW — governance proposals and votes are infrequent.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    group:      "DAO",
    label:      "DAO Controller / Ethereum",
    chain:      "ETHEREUM",
    address:    "0x95C0d9dCEA1E243ED696F34CAc5e6559C3c128a3",
    firstBlock: 10_700_000, // [~]
  },
  {
    group:      "DAO",
    label:      "DAO Controller / Celo",
    chain:      "CELO",
    address:    "0x0be7C592374EE0bD0CcBFC76Be758a138BcaEc6E",
    firstBlock: 13_000_000, // [~]
  },
  {
    group:      "DAO",
    label:      "DAO Controller / XDC",
    chain:      "XDC",
    address:    "0x75a8bE0C2dEaDEd8Fc9ECEB5F01ad0B979b7AD03",
    firstBlock: 90_000_000, // [~]
  },
  {
    group:      "DAO",
    label:      "DAO Avatar / Ethereum",
    chain:      "ETHEREUM",
    address:    "0x1ecFD1afb601C406fF0e13c3485f2d75699b6817",
    firstBlock: 10_700_000, // [~]
  },
  {
    group:      "DAO",
    label:      "DAO Avatar / Celo",
    chain:      "CELO",
    address:    "0x495d133B938596C9984d462F007B676bDc57eCEC",
    firstBlock: 13_000_000, // [~]
  },
  {
    group:      "DAO",
    label:      "DAO Avatar / XDC",
    chain:      "XDC",
    address:    "0x21eaC3fE218307BeE0463F77EBcA3b50F452C0Ce",
    firstBlock: 90_000_000, // [~]
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITY — Faucet, NameService, OneTimePayments, ContributionCalculation
  // Expected volume: LOW to MEDIUM.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    group:      "Utility",
    label:      "Faucet / Celo",
    chain:      "CELO",
    address:    "0x4F93Fa058b03953C851eFaA2e4FC5C34afDFAb84",
    firstBlock: 13_000_000, // [~]
  },
  {
    group:      "Utility",
    label:      "Faucet / XDC",
    chain:      "XDC",
    address:    "0x7344Da1Be296f03fbb8082aDaC5696058B5a9bd9",
    firstBlock: 90_000_000, // [~]
  },
  {
    group:      "Utility",
    label:      "NameService / Ethereum",
    chain:      "ETHEREUM",
    address:    "0xec6dcE387B1616a0c44fF2E4fA9E90E53Cf14eb0",
    firstBlock: 13_000_000, // [~]
  },
  {
    group:      "Utility",
    label:      "NameService / Celo",
    chain:      "CELO",
    address:    "0x0F5dB7a64A6a64052693676CA898EC7F7A94FF4e",
    firstBlock: 13_000_000, // [~]
  },
  {
    group:      "Utility",
    label:      "NameService / XDC",
    chain:      "XDC",
    address:    "0x1e5154Bf5e31FF56051bbd45958b879Fb7a290FE",
    firstBlock: 90_000_000, // [~]
  },
  {
    group:      "Utility",
    label:      "OneTimePayments / Celo",
    chain:      "CELO",
    address:    "0xB27D247f5C2a61D2Cb6b6E67FEE51d839447e97d",
    firstBlock: 13_000_000, // [~]
  },
  {
    group:      "Utility",
    label:      "ContributionCalculation / Ethereum",
    chain:      "ETHEREUM",
    address:    "0x8eEC64bb6807c0178f96277cCE6a334B4e565E5C",
    firstBlock: 10_700_000, // [~]
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// BIGQUERY PRICING CONSTANTS  (on-demand tier, as of mid-2025)
// Update these if GCP changes its pricing.
// ─────────────────────────────────────────────────────────────────────────────

const AVG_ROW_BYTES              = 700;   // avg bytes per L1 row (20 common cols + event cols)
const DAYS_SAMPLE                = 7;     // window used to compute the daily rate

const BQ_ACTIVE_STORAGE_PER_GB  = 0.02;  // $/GB/month — first 90 days after write
const BQ_LONGTERM_STORAGE_PER_GB = 0.01; // $/GB/month — after 90 days
const BQ_QUERY_COST_PER_TB      = 6.25;  // $/TB scanned — on-demand
const BQ_FREE_QUERY_TB_PER_MONTH = 1.0;  // first 1 TB/month is free
const BQ_STREAMING_INSERT_PER_GB = 5.00; // $/GB — streaming inserts; AVOID for backfill
// BQ Load Jobs (batch) are FREE — use them for any historical backfill.

const L3_MART_COUNT = 4;   // current number of daily-rebuild L3 marts (warehouse/L3/)

// ─────────────────────────────────────────────────────────────────────────────
// HYPERSYNC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function makeClient(url: string): any {
  return (HypersyncClient as any).new({
    url,
    bearerToken: process.env.ENVIO_API_TOKEN ?? "",
  });
}

/** Returns the current chain tip block number (latest confirmed block). */
async function getChainTip(url: string): Promise<number> {
  const client = makeClient(url);
  const status = await client.getStatus();
  return status.headBlock as number;
}

/**
 * Counts all logs emitted by `address` in [fromBlock, toBlock).
 * Uses minimal field selection (only block number + log index) for maximum speed.
 * Returns { count, timedOut } — timedOut=true means the scan was cut off.
 */
async function countLogs(
  url:       string,
  address:   string,
  fromBlock: number,
  toBlock?:  number,
  timeoutMs: number = Infinity
): Promise<{ count: number; timedOut: boolean }> {
  const client    = makeClient(url);
  const startedAt = Date.now();
  let count       = 0;
  let timedOut    = false;

  const stream = await client.stream(
    {
      fromBlock,
      ...(toBlock != null ? { toBlock } : {}),
      logs: [{ address: [address] }],
      fieldSelection: {
        // Request the absolute minimum — we only need to count, not decode.
        log: ["BlockNumber", "LogIndex"],
      },
    },
    {}
  );

  while (true) {
    // Check timeout between batches (cannot interrupt mid-batch).
    if (Date.now() - startedAt > timeoutMs) {
      timedOut = true;
      break;
    }

    const res = await stream.recv();
    if (res === null) break; // stream exhausted

    const batch = (res.data?.logs ?? []).length;
    count += batch;

    // Progress heartbeat every 500k events so long-running scans don't look frozen.
    if (count > 0 && count % 500_000 === 0) {
      log("INFO", `  ... ${count.toLocaleString()} events counted so far (${address.slice(0, 10)}...)`);
    }
  }

  return { count, timedOut };
}

/** Retry wrapper with linear back-off. Isolates transient network failures. */
async function withRetry<T>(
  fn:      () => Promise<T>,
  retries: number = 3,
  label:   string = ""
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt < retries) {
        const delayMs = attempt * 2_000; // 2s → 4s → give up
        log("WARN", `${label} attempt ${attempt}/${retries} failed: ${err.message ?? err}. Retrying in ${delayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// COST MODEL
// ─────────────────────────────────────────────────────────────────────────────

interface ContractResult {
  // identity
  group:           string;
  label:           string;
  chain:           Chain;
  address:         string;
  firstBlock:      number;
  note:            string;
  status:          "OK" | "FAILED" | "TIMED_OUT";
  errorMsg:        string;

  // measured
  currentTip:      number;
  daysSinceFirst:  number;
  historicalEvents: number;  // actual (full mode) or estimated (quick mode)
  historicalIsEstimated: boolean;
  dailyAvgEvents:  number;   // from DAYS_SAMPLE window

  // sizing
  historicalSizeGB: number;
  dailyGrowthMB:    number;
  monthlyGrowthGB:  number;

  // costs
  backfillStreamingCostUSD:  number;  // ⚠️ avoid — use Load Jobs
  monthlyStorageNowUSD:      number;
  yearStorageCumulativeUSD:  number;
  dailyMartScanGB:           number;
  monthlyQueryCostRawUSD:    number;  // before free tier deduction
}

function buildResult(
  spec:             ContractSpec,
  currentTip:       number,
  historicalEvents: number,
  dailyAvgEvents:   number,
  historicalIsEstimated: boolean,
  status:           ContractResult["status"],
  errorMsg:         string = ""
): ContractResult {
  const daysSinceFirst   = Math.max(1, (currentTip - spec.firstBlock) / BLOCKS_PER_DAY[spec.chain]);
  const historicalSizeGB = (historicalEvents * AVG_ROW_BYTES) / 1e9;
  const dailyGrowthMB    = (dailyAvgEvents  * AVG_ROW_BYTES) / 1e6;
  const monthlyGrowthGB  = (dailyGrowthMB * 30) / 1_000;

  const backfillStreamingCostUSD = historicalSizeGB * BQ_STREAMING_INSERT_PER_GB;
  const monthlyStorageNowUSD     = historicalSizeGB * BQ_ACTIVE_STORAGE_PER_GB;

  // Cumulative storage cost across 12 months:
  // months 1-3 billed at active rate; months 4-12 at long-term rate.
  let runningStorageGB      = historicalSizeGB;
  let yearStorageCumulativeUSD = 0;
  for (let m = 1; m <= 12; m++) {
    runningStorageGB += monthlyGrowthGB;
    const rate = m <= 3 ? BQ_ACTIVE_STORAGE_PER_GB : BQ_LONGTERM_STORAGE_PER_GB;
    yearStorageCumulativeUSD += runningStorageGB * rate;
  }

  // Query cost: each L3 mart does a full L1 table scan once per day.
  // L2 views pass through to L1 — no independent storage or query cost.
  // Use mid-year projected L1 size (6 months of growth on top of today).
  const projectedL1GB    = historicalSizeGB + monthlyGrowthGB * 6;
  const dailyMartScanGB  = projectedL1GB * L3_MART_COUNT;
  const monthlyRawScanTB = (dailyMartScanGB * 30) / 1_000;
  const monthlyQueryCostRawUSD = monthlyRawScanTB * BQ_QUERY_COST_PER_TB;

  return {
    group:                    spec.group,
    label:                    spec.label,
    chain:                    spec.chain,
    address:                  spec.address,
    firstBlock:               spec.firstBlock,
    note:                     spec.note ?? "",
    status,
    errorMsg,
    currentTip,
    daysSinceFirst,
    historicalEvents,
    historicalIsEstimated,
    dailyAvgEvents,
    historicalSizeGB,
    dailyGrowthMB,
    monthlyGrowthGB,
    backfillStreamingCostUSD,
    monthlyStorageNowUSD,
    yearStorageCumulativeUSD,
    dailyMartScanGB,
    monthlyQueryCostRawUSD,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCAN ONE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

async function scanContract(spec: ContractSpec): Promise<ContractResult> {
  const url = HYPERSYNC_URL[spec.chain];

  let currentTip: number;
  try {
    currentTip = await withRetry(() => getChainTip(url), 3, `[${spec.chain}] getChainTip`);
  } catch (err: any) {
    log("ERROR", `[${spec.chain}] Could not get chain tip: ${err.message}`);
    return buildResult(spec, 0, 0, 0, false, "FAILED", `getChainTip failed: ${err.message}`);
  }

  const sevenDaysAgoBlock = Math.max(
    spec.firstBlock,
    currentTip - BLOCKS_PER_DAY[spec.chain] * DAYS_SAMPLE
  );

  // Always count the 7-day recent window (fast — typically thousands of events).
  let recentCount = 0;
  try {
    const result = await withRetry(
      () => countLogs(url, spec.address, sevenDaysAgoBlock, currentTip),
      3,
      `[${spec.chain}] ${spec.label} 7-day`
    );
    recentCount = result.count;
  } catch (err: any) {
    log("ERROR", `[${spec.chain}] ${spec.label} — 7-day scan failed: ${err.message}`);
    return buildResult(spec, currentTip, 0, 0, false, "FAILED", `7-day scan failed: ${err.message}`);
  }

  const dailyAvgEvents = recentCount / DAYS_SAMPLE;

  if (!FULL_MODE) {
    // QUICK MODE: estimate historical total from daily rate × days elapsed.
    const daysSinceFirst  = Math.max(1, (currentTip - spec.firstBlock) / BLOCKS_PER_DAY[spec.chain]);
    const estimatedHistorical = Math.round(dailyAvgEvents * daysSinceFirst);
    return buildResult(spec, currentTip, estimatedHistorical, dailyAvgEvents, true, "OK");
  }

  // FULL MODE: stream ALL logs from firstBlock to tip.
  log("INFO", `[${spec.chain}] ${spec.label} — starting full historical scan (timeout: ${PER_CONTRACT_TIMEOUT_MS / 1000}s)...`);
  let historicalCount = 0;
  let timedOut        = false;
  try {
    const result = await withRetry(
      () => countLogs(url, spec.address, spec.firstBlock, currentTip, PER_CONTRACT_TIMEOUT_MS),
      2, // fewer retries for long-running scans
      `[${spec.chain}] ${spec.label} full-history`
    );
    historicalCount = result.count;
    timedOut        = result.timedOut;
  } catch (err: any) {
    log("ERROR", `[${spec.chain}] ${spec.label} — full scan failed: ${err.message}`);
    return buildResult(spec, currentTip, 0, dailyAvgEvents, false, "FAILED", `full scan failed: ${err.message}`);
  }

  if (timedOut) {
    log("WARN", `[${spec.chain}] ${spec.label} — scan timed out after ${PER_CONTRACT_TIMEOUT_MS / 1000}s. Count (${historicalCount.toLocaleString()}) is a LOWER BOUND.`);
    return buildResult(
      spec, currentTip, historicalCount, dailyAvgEvents, false,
      "TIMED_OUT", `timed out after ${PER_CONTRACT_TIMEOUT_MS / 1000}s — count is lower bound`
    );
  }

  return buildResult(spec, currentTip, historicalCount, dailyAvgEvents, false, "OK");
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildCsv(results: ContractResult[]): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  const columns = [
    "Group",
    "Contract Label",
    "Chain",
    "Address",
    "Status",
    "Scan Mode",
    "Current Chain Tip",
    "Days Since First Block",
    "Historical Event Count (actual or estimated)",
    "Historical Count Is Estimated?",
    "Daily Avg Events (last 7d)",
    "Historical L1 Size (GB)",
    "Daily Growth (MB/day)",
    "Monthly Growth (GB/month)",
    "Backfill via Streaming Insert USD ⚠️ AVOID",
    "Backfill via Load Job USD ✅ USE THIS",
    "Monthly Storage USD (now)",
    "1-Year Cumulative Storage USD",
    "Daily L3 Mart Scan GB",
    "Monthly Query Cost USD (before free tier)",
    "Notes / Warnings",
    "Error",
  ];
  lines.push(columns.join(","));

  // ── Per-contract rows, grouped ──────────────────────────────────────────────
  const groups = [...new Set(results.map(r => r.group))];

  for (const group of groups) {
    const groupResults = results.filter(r => r.group === group);

    for (const r of groupResults) {
      const mode = FULL_MODE
        ? (r.status === "TIMED_OUT" ? "full (timed out)" : "full")
        : (r.historicalIsEstimated ? "quick (estimated)" : "quick");

      lines.push([
        q(r.group),
        q(r.label),
        r.chain,
        r.address,
        r.status,
        mode,
        r.currentTip,
        r.daysSinceFirst.toFixed(0),
        r.historicalEvents,
        r.historicalIsEstimated ? "YES" : "NO",
        r.dailyAvgEvents.toFixed(0),
        r.historicalSizeGB.toFixed(5),
        r.dailyGrowthMB.toFixed(3),
        r.monthlyGrowthGB.toFixed(5),
        r.backfillStreamingCostUSD.toFixed(4),
        "0.0000",
        r.monthlyStorageNowUSD.toFixed(4),
        r.yearStorageCumulativeUSD.toFixed(4),
        r.dailyMartScanGB.toFixed(3),
        r.monthlyQueryCostRawUSD.toFixed(4),
        q(r.note),
        q(r.errorMsg),
      ].join(","));
    }

    // Group subtotal row
    const ok = groupResults.filter(r => r.status !== "FAILED");
    lines.push([
      q(`SUBTOTAL — ${group}`), "", "", "", "", "",  "", "",
      sum(ok, "historicalEvents"),
      "",
      sum(ok, "dailyAvgEvents").toFixed(0),
      sum(ok, "historicalSizeGB").toFixed(5),
      sum(ok, "dailyGrowthMB").toFixed(3),
      sum(ok, "monthlyGrowthGB").toFixed(5),
      sum(ok, "backfillStreamingCostUSD").toFixed(4),
      "0.0000",
      sum(ok, "monthlyStorageNowUSD").toFixed(4),
      sum(ok, "yearStorageCumulativeUSD").toFixed(4),
      sum(ok, "dailyMartScanGB").toFixed(3),
      sum(ok, "monthlyQueryCostRawUSD").toFixed(4),
      "", "",
    ].join(","));

    lines.push(""); // blank row between groups
  }

  // ── Grand total ─────────────────────────────────────────────────────────────
  const ok = results.filter(r => r.status !== "FAILED");
  const totalMonthlyScanTB = sum(ok, "dailyMartScanGB") * 30 / 1_000;
  const billableScanTB     = Math.max(0, totalMonthlyScanTB - BQ_FREE_QUERY_TB_PER_MONTH);
  const totalQueryCostUSD  = billableScanTB * BQ_QUERY_COST_PER_TB;

  lines.push([
    q("GRAND TOTAL"), "", "", "", "", "", "", "",
    sum(ok, "historicalEvents"),
    "",
    sum(ok, "dailyAvgEvents").toFixed(0),
    sum(ok, "historicalSizeGB").toFixed(5),
    sum(ok, "dailyGrowthMB").toFixed(3),
    sum(ok, "monthlyGrowthGB").toFixed(5),
    sum(ok, "backfillStreamingCostUSD").toFixed(4),
    "0.0000",
    sum(ok, "monthlyStorageNowUSD").toFixed(4),
    sum(ok, "yearStorageCumulativeUSD").toFixed(4),
    sum(ok, "dailyMartScanGB").toFixed(3),
    totalQueryCostUSD.toFixed(4) + ` (after ${BQ_FREE_QUERY_TB_PER_MONTH}TB free tier applied)`,
    "", "",
  ].join(","));

  // ── Metadata / assumptions block ────────────────────────────────────────────
  lines.push("");
  lines.push("ASSUMPTIONS & METHODOLOGY");
  lines.push(`Run date,${new Date().toISOString()}`);
  lines.push(`Run mode,${FULL_MODE ? "full historical scan" : "quick (7-day rate + estimated historical)"}`);
  lines.push(`AVG_ROW_BYTES,${AVG_ROW_BYTES} — adjust if your rows are significantly wider or narrower`);
  lines.push(`Daily rate window,last ${DAYS_SAMPLE} days`);
  lines.push(`BQ active storage rate,$${BQ_ACTIVE_STORAGE_PER_GB}/GB/month (first 90 days)`);
  lines.push(`BQ long-term storage rate,$${BQ_LONGTERM_STORAGE_PER_GB}/GB/month (after 90 days)`);
  lines.push(`BQ on-demand query rate,$${BQ_QUERY_COST_PER_TB}/TB`);
  lines.push(`BQ free query tier,${BQ_FREE_QUERY_TB_PER_MONTH} TB/month`);
  lines.push(`BQ streaming insert rate,$${BQ_STREAMING_INSERT_PER_GB}/GB — AVOID for backfill`);
  lines.push(`BQ Load Job rate,$0 — USE FOR ALL BACKFILL`);
  lines.push(`L3 mart count,${L3_MART_COUNT} — each mart does one full L1 scan per daily rebuild`);
  lines.push(`L2 views cost,L2 is all VIEWs — query cost flows through to L1 scans above`);
  lines.push(`Envio HyperSync cost,NOT INCLUDED — check your plan at envio.dev`);
  lines.push(`firstBlock estimates,Rows marked [~] in code use approximate deployment block — scan may start earlier than actual deployment`);

  return lines.join("\n");
}

/** Quote a CSV cell value (handles commas and quotes in content). */
function q(value: string | undefined): string {
  if (!value) return "";
  return `"${value.replace(/"/g, '""')}"`;
}

function sum(results: ContractResult[], key: keyof ContractResult): number {
  return results.reduce((acc, r) => acc + (r[key] as number), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Pre-flight checks ───────────────────────────────────────────────────────

  if (!process.env.ENVIO_API_TOKEN) {
    log("ERROR", "ENVIO_API_TOKEN is not set. Copy .env.example to .env and add your token.");
    process.exit(1);
  }

  const contractsToScan = GROUP_FILTER
    ? CONTRACTS.filter(c => c.group.toLowerCase() === GROUP_FILTER.toLowerCase())
    : CONTRACTS;

  if (contractsToScan.length === 0) {
    log("ERROR", `No contracts matched group filter "${GROUP_FILTER}". Available groups: ${[...new Set(CONTRACTS.map(c => c.group))].join(", ")}`);
    process.exit(1);
  }

  // ── Banner ──────────────────────────────────────────────────────────────────

  logSeparator("GoodDollar Event Pipeline — Cost Estimator");
  log("INFO", `Mode           : ${FULL_MODE ? "FULL (accurate historical scan)" : "QUICK (7-day rate + estimated historical)"}`);
  log("INFO", `Contracts      : ${contractsToScan.length}${GROUP_FILTER ? ` (group: ${GROUP_FILTER})` : " (all groups)"}`);
  if (FULL_MODE) {
    log("INFO", `Per-contract timeout: ${PER_CONTRACT_TIMEOUT_MS / 1000}s (override: --timeout <seconds>)`);
  }
  log("INFO", `Output         : cost-estimate-${new Date().toISOString().slice(0, 10)}.csv`);
  logSeparator();

  if (!FULL_MODE) {
    log("WARN", "Running in QUICK mode — historical totals are ESTIMATES (dailyRate × daysSinceDeployment).");
    log("WARN", "Run with --full for accurate backfill sizing (significantly slower).");
    console.log("");
  }

  // ── Scan each contract ──────────────────────────────────────────────────────

  const results: ContractResult[] = [];
  let   contractIdx = 0;

  for (const spec of contractsToScan) {
    contractIdx++;
    const progress = `[${contractIdx}/${contractsToScan.length}]`;

    logSeparator(`${progress} ${spec.label}`);
    log("INFO", `Group    : ${spec.group}`);
    log("INFO", `Chain    : ${spec.chain}  |  Address: ${spec.address}`);
    log("INFO", `From block: ${spec.firstBlock.toLocaleString()}${spec.firstBlock.toString().includes("0") ? " [~approx]" : " [exact]"}`);

    const result = await scanContract(spec);
    results.push(result);

    // Per-contract summary log
    if (result.status === "FAILED") {
      log("ERROR", `FAILED — ${result.errorMsg}`);
    } else {
      const histLabel = result.historicalIsEstimated ? "(estimated)" : "(actual)";
      log(result.status === "TIMED_OUT" ? "WARN" : "OK",
        `Historical: ${result.historicalEvents.toLocaleString()} events ${histLabel}` +
        ` | ${result.historicalSizeGB.toFixed(3)} GB` +
        ` | Daily avg: ${result.dailyAvgEvents.toFixed(0)} events/day` +
        ` | ${result.dailyGrowthMB.toFixed(1)} MB/day`
      );
      if (result.note) {
        log("WARN", `NOTE: ${result.note}`);
      }
    }
  }

  // ── Console summary ─────────────────────────────────────────────────────────

  const ok           = results.filter(r => r.status !== "FAILED");
  const failed       = results.filter(r => r.status === "FAILED");
  const timedOut     = results.filter(r => r.status === "TIMED_OUT");

  const totalHistorical    = sum(ok, "historicalEvents");
  const totalDaily         = sum(ok, "dailyAvgEvents");
  const totalHistGB        = sum(ok, "historicalSizeGB");
  const totalDailyMB       = sum(ok, "dailyGrowthMB");
  const totalBackfillUSD   = sum(ok, "backfillStreamingCostUSD");
  const totalMonthlyStore  = sum(ok, "monthlyStorageNowUSD");
  const totalYearStore     = sum(ok, "yearStorageCumulativeUSD");
  const totalDailyScanGB   = sum(ok, "dailyMartScanGB");
  const totalMonthlyScanTB = totalDailyScanGB * 30 / 1_000;
  const billableScanTB     = Math.max(0, totalMonthlyScanTB - BQ_FREE_QUERY_TB_PER_MONTH);
  const totalQueryCostUSD  = billableScanTB * BQ_QUERY_COST_PER_TB;

  logSeparator("SUMMARY");
  console.log("");
  console.log("  DATA VOLUME");
  console.log(`    Historical events (${FULL_MODE ? "actual" : "estimated"}) :  ${totalHistorical.toLocaleString()}`);
  console.log(`    Historical L1 size                  :  ${totalHistGB.toFixed(3)} GB`);
  console.log(`    Daily event rate (live)             :  ${totalDaily.toFixed(0)} events/day`);
  console.log(`    Daily data growth                   :  ${totalDailyMB.toFixed(1)} MB/day`);
  console.log("");
  console.log("  BACKFILL WRITE COST (one-time)");
  console.log(`    ⚠️  Streaming inserts               :  $${totalBackfillUSD.toFixed(2)}  ← DO NOT USE for backfill`);
  console.log(`    ✅  BQ Load Jobs (batch)             :  $0.00              ← USE THIS`);
  console.log("");
  console.log("  ONGOING STORAGE COST (BQ)");
  console.log(`    Monthly (current data size)         :  $${totalMonthlyStore.toFixed(4)}/month`);
  console.log(`    1-year cumulative (with growth)     :  $${totalYearStore.toFixed(2)}`);
  console.log("");
  console.log("  ONGOING QUERY COST (BQ — L3 daily mart rebuilds)");
  console.log(`    Daily scan total                    :  ${totalDailyScanGB.toFixed(1)} GB`);
  console.log(`    Monthly scan total                  :  ${totalMonthlyScanTB.toFixed(3)} TB`);
  console.log(`    After ${BQ_FREE_QUERY_TB_PER_MONTH}TB free tier               :  ${billableScanTB.toFixed(3)} TB billable`);
  console.log(`    Monthly query cost                  :  $${totalQueryCostUSD.toFixed(2)}`);
  console.log("");
  if (failed.length > 0) {
    console.log(`  ⚠️  FAILED CONTRACTS (${failed.length}) — excluded from totals above:`);
    failed.forEach(r => console.log(`    - ${r.label}: ${r.errorMsg}`));
    console.log("");
  }
  if (timedOut.length > 0) {
    console.log(`  ⚠️  TIMED OUT CONTRACTS (${timedOut.length}) — counts are lower bounds:`);
    timedOut.forEach(r => console.log(`    - ${r.label}`));
    console.log("");
  }

  logSeparator();

  // ── Write CSV ───────────────────────────────────────────────────────────────

  const filename = `cost-estimate-${new Date().toISOString().slice(0, 10)}.csv`;
  writeFileSync(filename, buildCsv(results));

  log("OK", `CSV written to: ${filename}`);
  log("INFO", "Import into Google Sheets: File → Import → Upload → Replace current sheet.");
  console.log("");
}

main().catch(err => {
  log("ERROR", `Unhandled error: ${err.message ?? err}`);
  console.error(err);
  process.exit(1);
});
