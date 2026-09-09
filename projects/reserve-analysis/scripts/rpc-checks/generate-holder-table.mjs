// Regenerates the burn/refund candidate table shared in Slack (address, current G$ held, G$
// acquired during the incident window, USD paid, remark) so anyone (not just whoever has this
// worktree's scratch state) can reproduce it on demand.
//
// "Current held" is a live balanceOf, deterministic, needs nothing but Node and a public RPC
// endpoint (no Dune, no API key). "Acquired" and "USD paid" are a historical event scan (who
// bought how much, when, for how much), which is only reliably answered by Dune (query 8656320,
// wallet-cost-list.sql), not a one-off RPC log scan -- public RPC log queries proved
// non-deterministic in testing, simple state reads did not.
//
// Fetches that Dune data directly via Dune's REST API (same pattern already proven in
// projects/dashboard-scripts/v6-daily.gs's duneFetchTable/duneExecuteQuery, which runs on a free
// Dune plan every day) -- a manual CSV export is NOT required. Get a free API key at
// https://dune.com/settings/api (Dune's free tier includes API access), then either set it as
// the DUNE_API_KEY environment variable or pass --dune-api-key=<key>.
//
// Usage:
//   node generate-holder-table.mjs                              # uses DUNE_API_KEY env var, latest cached Dune result
//   node generate-holder-table.mjs --fresh                       # same, but triggers a fresh Dune execution first and waits for it
//   node generate-holder-table.mjs --dune-api-key=<key>          # override the env var
//   node generate-holder-table.mjs --dune-csv=path/to/export.csv # fallback: a manual CSV export, if you don't have API access
//   [--xdc-json=path/to/xdc-cost-basis.json]                     # optional, re-run wallet-cost-basis-xdc.mjs for fresh XDC numbers
//
// If none of DUNE_API_KEY / --dune-api-key / --dune-csv is available, falls back to a small
// hardcoded snapshot (2026-09-09) with a loud staleness warning, never silently. Also reads
// wallet-outflow-trace-out.json (this investigation's outbound-transfer trace, item 5) from the
// same folder, if present, to auto-tag mechanical remarks (burns to the null address, transfers
// to the known staking contract) -- anything not mechanically derivable (LP positions, identity,
// behavior notes) is left blank for a human to fill in, not guessed.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const GD_CELO = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";
const GD_XDC = "0xec2136843a983885aebf2feb3931f73a8ebee50c";
const CELO_ENDPOINTS = ["https://forno.celo.org", "https://celo.drpc.org", "https://rpc.ankr.com/celo", "https://1rpc.io/celo"];
const XDC_ENDPOINTS = ["https://rpc.xinfin.network", "https://erpc.xinfin.network", "https://rpc.ankr.com/xdc", "https://xdc.public-rpc.com"];
const DUNE_QUERY_ID = 8656320; // wallet-cost-list.sql, Celo cheap-buyer ranking

// 2026-09-09 snapshot, only used if no --dune-csv is passed. Re-run Dune query 8656320 and pass
// a fresh export instead of trusting this for anything but a quick local smoke-test.
const FALLBACK_CELO_BOUGHT_PAID = {
  "0x22fa3239c4bf43d05cc587ff40ea3ba5841c6709": [156500000, 465.61],
  "0xa779ce177555284baf953de8a3246ba2444a2d34": [101500000, 66.61],
  "0x4f649e50680c16c9b73e646e4b396647fd153091": [16100000, 30.04],
  "0x62b7fd18f9bc72c8543801b31ce88289264f9869": [11100000, 31.03],
  "0xce029f6ee3c8d7e6c9338c04171b895a22428de3": [21800000, 56.43],
  "0x288dc841a52fca2707c6947b3a777c5e56cd87bc": [5800000, 0.03],
  "0xd7f3596fcf17e68bd7db2537c87cf8a969235c12": [8100000, 149.49],
  "0x2973a379b3fb2d869712b9296a7ea2c054426d47": [13600000, 71.01],
  "0x93f1f1e11b995a8bd3fe87afc404634ddbcf8624": [8700000, 124.07],
  "0x1df536323b382def549cb386fc128efe93e6f24f": [2300000, 2.00],
  "0xf2fb24a6cedca39b9c514833371aca29512d8a3f": [5500000, 49.99],
  "0x7f553faa8f4bbbbd16fe419bf9b5255d3ea01652": [9500000, 71.70],
  "0x61dd2ec85e168b4a06ae39b35eebfee8eaebea37": [8300000, 46.39],
  "0x9b27ac014671d006000b4546a3fb4796e2073241": [2100000, 2.04],
  "0x980abeb0f35db41c6ee67068f981d46de04823c7": [2700000, 30.31],
  "0xdedff708684052be37ec7cbe1de2e6e608e9447e": [1500000, 14.76],
  "0x8e089f5d70c5d5d1378f656ae74752bf65e00c8e": [1400000, 18.45],
  "0xce06ac2d581e80cc6ea4bc28f8bdb91ce887ff25": [3400000, 4.19],
  "0x0e9b063789909565ceda1fba162474405a151e66": [681800, 6.89],
  "0x0e401c81611424eccd0428f309bcd41ba3057112": [6100000, 23.53],
  "0xc96e2cc0de82bbafebbd70c2a30db34e4c419fce": [2100, 0.03],
  "0xd824212300be0555df8bb14278c1f25c975d1106": [753000, 1.09],
  "0xc151fe0d8dd6b852d75e29e18f4791b2f806f2a6": [10100000, 54.82],
  "0x83525b2783fb2dccaf7ae5b2551fbd995dd27309": [13600000, 1.31],
  "0x58d6eb8cd983449dc4fb0d6b173be140dfdb63d0": [416600, 0.10],
  "0x7f8946b257ad9a8fa55704120957901741a3346c": [8900000, 18.79],
  "0x744942ec88d88c4dcc3da48f18e824d765e9a245": [94800, 0.07],
  "0x20a15f256f7537da4f707a196f6ddc3e2e8be9da": [4400000, 3.69],
  "0x55fbeae109d55b911d165a624e99d3e5abdddb54": [3100, 0.05],
  "0x2c2b0310adcba409deb2739106a08a05cc4c0a79": [67000000, 116.85]
};
const FALLBACK_XDC = [
  { wallet: "0xfa7d15c941da051bc4276ab341d3cb37cc09b73f", bought: 12779.94, usd: null, remark: "paid 58.11 native XDC" },
  { wallet: "0x61b7b0009fced05695ee811b7f8f78ba37c38344", bought: 11122.13, usd: 0, remark: "no payment leg found" },
  { wallet: "0xff3c46ee68f90da6a33303897dbcbd62661c73f1", bought: 7678.59, usd: null, remark: "paid 16.81 native XDC" },
  { wallet: "0x8675d6b6fcde8db7af5a0ab86de7db0dceba4407", bought: 240.56, usd: null, remark: "paid via a mix of 10 small tokens" }
];

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const kv = a.match(/^--([a-z-]+)=(.*)$/);
    if (kv) { args[kv[1]] = kv[2]; continue; }
    const flag = a.match(/^--([a-z-]+)$/);
    if (flag) args[flag[1]] = true;
  }
  return args;
}

// Minimal CSV parser: fine for Dune's export of this specific query (addresses/numbers/short
// enum strings only, no embedded commas or quoted fields expected in any column). Fallback path
// only, for anyone without a Dune API key.
function parseDuneCsv(path) {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const walletIdx = idx("wallet");
  const boughtIdx = idx("total_gd_bought");
  const paidIdx = idx("total_quote_paid_usd");
  if (walletIdx === -1 || boughtIdx === -1 || paidIdx === -1) {
    throw new Error(`Dune CSV missing expected columns (wallet, total_gd_bought, total_quote_paid_usd). Found: ${header.join(", ")}`);
  }
  const out = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const wallet = cols[walletIdx]?.trim().toLowerCase();
    if (!wallet || !wallet.startsWith("0x")) continue;
    out[wallet] = [Number(cols[boughtIdx]), Number(cols[paidIdx])];
  }
  return out;
}

// Dune REST API client, same endpoints/headers as projects/dashboard-scripts/v6-daily.gs's
// duneFetchTable/duneExecuteQuery (that script runs on a free Dune plan daily, so this does too).
async function duneRequest(method, url, apiKey, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method,
      headers: { "X-DUNE-API-KEY": apiKey, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Dune HTTP ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function rowsToBoughtPaid(rows) {
  const out = {};
  for (const row of rows) {
    const wallet = String(row.wallet || "").toLowerCase();
    if (!wallet.startsWith("0x")) continue;
    out[wallet] = [Number(row.total_gd_bought), Number(row.total_quote_paid_usd)];
  }
  return out;
}

// Quick path: whatever Dune already has cached from the last execution (matches duneFetchTable).
async function duneFetchLatestResults(queryId, apiKey) {
  const json = await duneRequest("GET", `https://api.dune.com/api/v1/query/${queryId}/results?limit=1000`, apiKey);
  return json.result?.rows || [];
}

// --fresh path: trigger a new execution and poll until it completes (matches duneExecuteQuery,
// plus the polling the daily dashboard doesn't need since it prewarms well ahead of the fetch).
async function duneExecuteAndWait(queryId, apiKey, maxWaitMs = 120000) {
  const exec = await duneRequest("POST", `https://api.dune.com/api/v1/query/${queryId}/execute`, apiKey, {});
  const executionId = exec.execution_id;
  if (!executionId) throw new Error(`Dune execute did not return an execution_id: ${JSON.stringify(exec)}`);
  console.error(`  Dune execution ${executionId} started, polling for completion...`);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await duneRequest("GET", `https://api.dune.com/api/v1/execution/${executionId}/status`, apiKey);
    if (status.state === "QUERY_STATE_COMPLETED") break;
    if (status.state === "QUERY_STATE_FAILED" || status.state === "QUERY_STATE_CANCELLED") {
      throw new Error(`Dune execution ${executionId} ended in state ${status.state}`);
    }
    console.error(`  ...still ${status.state}, waiting`);
    await sleep(3000);
  }
  const json = await duneRequest("GET", `https://api.dune.com/api/v1/execution/${executionId}/results`, apiKey);
  return json.result?.rows || [];
}

let rpcId = 1;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function rpc(endpoints, method, params, epIndex = 0, attempt = 1) {
  const url = endpoints[epIndex % endpoints.length];
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ }) });
  if (!res.ok) { if (attempt >= endpoints.length * 4) throw new Error(`HTTP ${res.status}`); await sleep(300); return rpc(endpoints, method, params, epIndex + 1, attempt + 1); }
  const json = await res.json();
  if (json.error) { if (attempt >= endpoints.length * 4) throw new Error(json.error.message); await sleep(300); return rpc(endpoints, method, params, epIndex + 1, attempt + 1); }
  await sleep(150);
  return json.result;
}
async function balanceOf(endpoints, token, holder) {
  const padded = holder.replace("0x", "").padStart(64, "0");
  const res = await rpc(endpoints, "eth_call", [{ to: token, data: "0x70a08231" + padded }, "latest"]);
  return Number(BigInt(res)) / 1e18;
}

function loadOutflowAutoTags() {
  const path = join(HERE, "wallet-outflow-trace-out.json");
  const tags = new Map();
  if (!existsSync(path)) return tags;
  try {
    let raw = readFileSync(path, "utf8");
    // tolerate a UTF-16LE file (PowerShell-redirected) as well as plain UTF-8 (writeFileSync)
    if (raw.charCodeAt(0) === 0xfffd || /\u0000/.test(raw.slice(0, 50))) raw = readFileSync(path, "utf16le");
    raw = raw.replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    for (const chainResult of data.results) {
      for (const w of chainResult.walletsWithOutflowDetail) {
        const notes = [];
        for (const t of w.outboundTransfers) {
          if (t.to === "0x0000000000000000000000000000000000000000") notes.push(`sent ${t.amount.toLocaleString()} G$ to the null address (burn)`);
          if (t.category === "known staking contract") notes.push(`sent ${t.amount.toLocaleString()} G$ to the known staking contract`);
        }
        if (notes.length) tags.set(w.wallet.toLowerCase(), [...new Set(notes)].join("; "));
      }
    }
  } catch (err) {
    console.error(`(auto-tag skip: could not parse wallet-outflow-trace-out.json: ${err.message})`);
  }
  return tags;
}

function fmt(n) {
  if (n == null) return "n/a";
  if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(1);
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function main() {
  const args = parseArgs();
  const duneApiKey = args["dune-api-key"] || process.env.DUNE_API_KEY;

  let celoBoughtPaid;
  if (duneApiKey) {
    console.error(`Fetching Celo bought/paid from Dune query ${DUNE_QUERY_ID} via API${args.fresh ? " (--fresh: triggering a new execution)" : " (latest cached execution)"}...`);
    const rows = args.fresh
      ? await duneExecuteAndWait(DUNE_QUERY_ID, duneApiKey)
      : await duneFetchLatestResults(DUNE_QUERY_ID, duneApiKey);
    celoBoughtPaid = rowsToBoughtPaid(rows);
    console.error(`Loaded ${Object.keys(celoBoughtPaid).length} Celo wallets from Dune.`);
  } else if (args["dune-csv"]) {
    celoBoughtPaid = parseDuneCsv(args["dune-csv"]);
    console.error(`Loaded ${Object.keys(celoBoughtPaid).length} Celo wallets from ${args["dune-csv"]}.`);
  } else {
    celoBoughtPaid = FALLBACK_CELO_BOUGHT_PAID;
    console.error("WARNING: no DUNE_API_KEY / --dune-api-key / --dune-csv available, using a hardcoded 2026-09-09 snapshot for G$ acquired/USD paid. Get a free key at https://dune.com/settings/api for live numbers.");
  }

  let xdcRows = FALLBACK_XDC;
  if (args["xdc-json"]) {
    let raw = readFileSync(args["xdc-json"], "utf8");
    if (/\u0000/.test(raw.slice(0, 50))) raw = readFileSync(args["xdc-json"], "utf16le");
    raw = raw.replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    xdcRows = data.stillHolding.map((r) => ({ wallet: r.wallet, bought: r.gdBought, usd: r.usdPaidTotal, remark: r.usdPaidNote || "" }));
    console.error(`Loaded ${xdcRows.length} XDC wallets from ${args["xdc-json"]}.`);
  } else {
    console.error("WARNING: no --xdc-json passed, using a hardcoded 2026-09-09 snapshot for XDC. Re-run wallet-cost-basis-xdc.mjs and pass --xdc-json=<path> for current numbers.");
  }

  const autoTags = loadOutflowAutoTags();

  const rows = [];
  for (const [wallet, [bought, usd]] of Object.entries(celoBoughtPaid)) {
    const held = await balanceOf(CELO_ENDPOINTS, GD_CELO, wallet);
    rows.push({ wallet, chain: "Celo", held, bought, usd, remark: autoTags.get(wallet) || "" });
  }
  for (const r of xdcRows) {
    const held = await balanceOf(XDC_ENDPOINTS, GD_XDC, r.wallet);
    rows.push({ wallet: r.wallet, chain: "XDC", held, bought: r.bought, usd: r.usd, remark: r.remark || "" });
  }

  rows.sort((a, b) => b.held - a.held);

  console.log("WALLET\tCHAIN\tG$ HELD (LIVE)\tG$ ACQUIRED\tUSD PAID\tREMARK");
  for (const r of rows) {
    console.log(`${r.wallet}\t${r.chain}\t${fmt(r.held)}\t${fmt(r.bought)}\t${r.usd == null ? "n/a" : "$" + fmt(r.usd)}\t${r.remark}`);
  }
  console.error(`\nDone. Live balances as of ${new Date().toISOString()}.`);
}

main().catch((err) => { console.error(err.message || err); process.exitCode = 1; });
