// V2-style (Ubeswap classic) LP-token holder reconstruction. These pools ARE
// the LP token (plain ERC20), so "who holds LP shares" is just an ERC20
// Transfer-event scan on the pool's own address -- no NFT/tick-math needed.
// Each holder's current GD entitlement = (holderLpBalance / totalSupply) *
// pool's current GD reserve.

const CELO_RPC_ENDPOINTS = ["https://celo.drpc.org", "https://forno.celo.org", "https://rpc.ankr.com/celo"];
const GD_TOKEN = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const SELECTORS = { totalSupply: "0x18160ddd", balanceOf: "0x70a08231", token0: "0x0dfe1681", token1: "0xd21220a7" };

const POOLS = process.argv[2] ? [process.argv[2]] : [
  "0x31f9dee850b4284b81b52b25a3194f2fc8ff18cf", // Ubeswap GD/cUSD-or-USDm
  "0x07f86b39728be613062bc7413fc2ca7293eef022", // Ubeswap GD/mcUSD
  "0x25878951ae130014e827e6f54fd3b4cca057a7e8", // Ubeswap GD/CELO
  "0xa0bef7ff637c10b9ec67a00687b4d4364a7f1c55"  // Ubeswap GD/PACT
];

let rpcId = 1;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function rpc(method, params, epIndex = 0, attempt = 1) {
  const url = CELO_RPC_ENDPOINTS[epIndex % CELO_RPC_ENDPOINTS.length];
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ }) });
  if (!res.ok) { if (attempt >= CELO_RPC_ENDPOINTS.length * 4) throw new Error(`HTTP ${res.status}`); await sleep(300); return rpc(method, params, epIndex + 1, attempt + 1); }
  const json = await res.json();
  if (json.error) { if (attempt >= CELO_RPC_ENDPOINTS.length * 4) throw new Error(json.error.message); await sleep(300); return rpc(method, params, epIndex + 1, attempt + 1); }
  await sleep(100);
  return json.result;
}
function toHexBlock(n) { return "0x" + n.toString(16); }
function addressFromTopic(t) { return "0x" + t.slice(-40); }
function addressFromWord(w) { return "0x" + w.slice(24); }
async function ethCall(to, data) {
  try { const r = await rpc("eth_call", [{ to, data }, "latest"]); return (!r || r === "0x") ? null : r; } catch { return null; }
}
async function findDeploymentBlock(address, latest) {
  let lo = 1, hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midCode = await rpc("eth_getCode", [address, toHexBlock(mid)]);
    if (midCode !== "0x") hi = mid; else lo = mid + 1;
  }
  return lo;
}
async function getLogsChunked(filterBase, fromBlock, toBlock, chunkSize, label) {
  const logs = [];
  let cursor = fromBlock;
  let size = chunkSize;
  const totalSpan = Math.max(1, toBlock - fromBlock + 1);
  while (cursor <= toBlock) {
    const end = Math.min(cursor + size - 1, toBlock);
    try {
      const chunk = await rpc("eth_getLogs", [{ ...filterBase, fromBlock: toHexBlock(cursor), toBlock: toHexBlock(end) }]);
      logs.push(...chunk);
      const pct = (((cursor - fromBlock) / totalSpan) * 100).toFixed(1);
      console.error(`  [${label}] blocks ${cursor}-${end} (${pct}%), +${chunk.length} logs, total ${logs.length}`);
      cursor = end + 1;
    } catch (err) {
      if (size <= 500) throw new Error(`getLogsChunked[${label}] stuck at chunk size ${size}: ${err.message}`);
      size = Math.floor(size / 2);
      console.error(`  [${label}] shrinking chunk size to ${size} after error: ${err.message}`);
    }
  }
  return logs;
}

async function processPool(pool, latest) {
  console.error(`\n=== V2 pool ${pool} ===`);
  const token0 = addressFromWord((await ethCall(pool, SELECTORS.token0)).slice(2));
  const token1 = addressFromWord((await ethCall(pool, SELECTORS.token1)).slice(2));
  const gdIsToken0 = token0.toLowerCase() === GD_TOKEN;

  const deployBlock = await findDeploymentBlock(pool, latest);
  console.error(`deployment block: ${deployBlock}`);

  const transferLogs = await getLogsChunked({ address: pool, topics: [TRANSFER_TOPIC0] }, deployBlock, latest, 5000, pool.slice(0, 10));
  console.error(`LP Transfer events: ${transferLogs.length}`);

  const balances = new Map();
  for (const log of transferLogs) {
    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    const value = BigInt(log.data);
    if (from !== "0x0000000000000000000000000000000000000000") {
      balances.set(from, (balances.get(from) || 0n) - value);
    }
    if (to !== "0x0000000000000000000000000000000000000000") {
      balances.set(to, (balances.get(to) || 0n) + value);
    }
  }
  const holders = [...balances.entries()].filter(([, bal]) => bal > 0n);
  console.error(`Non-zero holders derived from transfer deltas: ${holders.length}`);

  const totalSupply = BigInt(await ethCall(pool, SELECTORS.totalSupply));
  const gdBalanceRaw = BigInt((await ethCall(GD_TOKEN, SELECTORS.balanceOf + pool.replace("0x", "").padStart(64, "0"))) || "0x0");
  const gdBalance = Number(gdBalanceRaw) / 1e18;

  const holderRows = holders.map(([addr, bal]) => {
    const share = Number(bal) / Number(totalSupply);
    return { holder: addr, lpBalanceRaw: bal.toString(), sharePct: share * 100, gdEntitlement: share * gdBalance };
  }).sort((a, b) => b.gdEntitlement - a.gdEntitlement);

  // Cross-check: derived balances from Transfer deltas should each match a
  // live balanceOf call (defends against a missed/duplicated log in the scan).
  const spotCheck = [];
  for (const row of holderRows.slice(0, 5)) {
    const live = BigInt((await ethCall(pool, SELECTORS.balanceOf + row.holder.replace("0x", "").padStart(64, "0"))) || "0x0");
    spotCheck.push({ holder: row.holder, derivedFromTransfers: row.lpBalanceRaw, liveBalanceOf: live.toString(), match: live.toString() === row.lpBalanceRaw });
  }

  console.error(`Top holders:`, holderRows.slice(0, 8).map((h) => `${h.holder}=${h.gdEntitlement.toFixed(2)} GD (${h.sharePct.toFixed(3)}%)`).join(", "));

  return { pool, token0, token1, gdIsToken0, deployBlock, transferEventCount: transferLogs.length, totalSupply: totalSupply.toString(), poolGdBalance: gdBalance, holders: holderRows, spotCheck };
}

async function main() {
  const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
  console.error(`Latest Celo block: ${latest}`);
  const results = [];
  for (const pool of POOLS) {
    try { results.push(await processPool(pool, latest)); }
    catch (err) { console.error(`Pool ${pool} FAILED: ${err.message}`); results.push({ pool, error: err.message }); }
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), latestBlock: latest, results }, null, 2));
}
main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
