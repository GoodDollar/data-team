// Fuse cheap-buyer enumeration for the incident window. Unlike the Celo and
// XSwap checks, this does NOT detect pools empirically: a first attempt at
// that produced only dust-level false positives (unrelated Fuse contracts
// that coincidentally expose a token0()/token1()-shaped selector). Instead
// this uses the same router addresses already verified working in
// analysis-rpc-checks.mjs, and asks a narrower, correct question: which GD
// transfers left those routers, and who received them (a buy), during the
// window Mike originally asked about.

const FUSE_RPC_ENDPOINTS = ["https://rpc.fuse.io", "https://fuse-pokt.nodies.app", "https://rpc.ankr.com/fuse"];
const GD_TOKEN = "0x495d133b938596c9984d462f007b676bdc57ecec";
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";

// Same window the existing Fuse router check (analysis-rpc-checks.mjs) uses.
const WINDOW = { startIso: "2026-09-03T00:00:00Z", endIso: "2026-09-04T12:00:00Z" };

let endpointIndex = 0;
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function rpc(method, params, attempt = 1) {
  const url = FUSE_RPC_ENDPOINTS[endpointIndex % FUSE_RPC_ENDPOINTS.length];
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }) });
  if (res.status === 403 || res.status === 429 || !res.ok) {
    if (attempt >= FUSE_RPC_ENDPOINTS.length * 2) throw new Error(`HTTP ${res.status} calling ${method}`);
    endpointIndex += 1; await sleep(400); return rpc(method, params, attempt + 1);
  }
  const json = await res.json();
  if (json.error) {
    if (attempt >= FUSE_RPC_ENDPOINTS.length * 2) throw new Error(`RPC error calling ${method}: ${json.error.message}`);
    endpointIndex += 1; await sleep(400); return rpc(method, params, attempt + 1);
  }
  await sleep(250);
  return json.result;
}

function toHexBlock(n) { return "0x" + n.toString(16); }
async function blockTimestamp(n) { const blk = await rpc("eth_getBlockByNumber", [toHexBlock(n), false]); return Number(BigInt(blk.timestamp)); }
function topicToAddress(t) { return ("0x" + t.slice(-40)).toLowerCase(); }
// GD on Fuse uses 2 decimals, unlike Celo/XDC/Ethereum (18). Verified directly
// via decimals() on 0x495d133b938596c9984d462f007b676bdc57ecec: returns 2.
function toGd(v) { return Number(v) / 1e2; }

async function resolveWindowBlocks() {
  const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
  const latestTs = await blockTimestamp(latest);
  const probeTs = await blockTimestamp(latest - 2000);
  const secPerBlock = (latestTs - probeTs) / 2000;
  const startTs = Math.floor(new Date(WINDOW.startIso).getTime() / 1000);
  const endTs = Math.floor(new Date(WINDOW.endIso).getTime() / 1000);
  const padding = Math.round(1800 / secPerBlock);
  return {
    fromBlock: Math.max(1, latest - Math.round((latestTs - startTs) / secPerBlock) - padding),
    toBlock: Math.min(latest, latest - Math.round((latestTs - endTs) / secPerBlock) + padding),
    secPerBlock
  };
}

async function getLogsChunked(fromBlock, toBlock, chunkSize) {
  const logs = [];
  let cursor = fromBlock;
  let size = chunkSize;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + size - 1, toBlock);
    try {
      const chunk = await rpc("eth_getLogs", [{ address: GD_TOKEN, topics: [TRANSFER_TOPIC0], fromBlock: toHexBlock(cursor), toBlock: toHexBlock(end) }]);
      logs.push(...chunk);
      cursor = end + 1;
    } catch (err) {
      if (size <= 200) throw err;
      size = Math.floor(size / 2);
    }
  }
  return logs;
}

function decodeTransfer(log) {
  return { from: topicToAddress(log.topics[1]), to: topicToAddress(log.topics[2]), value: BigInt(log.data), txHash: log.transactionHash };
}

async function currentGdBalance(address) {
  const selector = "0x70a08231";
  const padded = address.replace("0x", "").padStart(64, "0");
  const result = await rpc("eth_call", [{ to: GD_TOKEN, data: selector + padded }, "latest"]);
  return toGd(BigInt(result));
}

async function classifyPools(transfers) {
  const stats = new Map();
  for (const t of transfers) {
    for (const [addr, dir] of [[t.from, "out"], [t.to, "in"]]) {
      if (!stats.has(addr)) stats.set(addr, { address: addr, outTotal: 0n, inTotal: 0n, outCount: 0, inCount: 0, amounts: new Set() });
      const s = stats.get(addr);
      s.amounts.add(t.value.toString());
      if (dir === "out") { s.outTotal += t.value; s.outCount += 1; } else { s.inTotal += t.value; s.inCount += 1; }
    }
  }

  const candidates = [...stats.values()]
    .filter((s) => s.outCount >= 2 && s.inCount >= 2 && s.amounts.size >= 3)
    .sort((a, b) => (b.outCount + b.inCount) - (a.outCount + a.inCount))
    .slice(0, 80);

  const confirmed = [];
  for (const c of candidates) {
    try {
      const token0 = await rpc("eth_call", [{ to: c.address, data: TOKEN0_SELECTOR }, "latest"]);
      const token1 = await rpc("eth_call", [{ to: c.address, data: TOKEN1_SELECTOR }, "latest"]);
      const t0 = topicToAddress(token0);
      const t1 = topicToAddress(token1);
      if (t0 === GD_TOKEN || t1 === GD_TOKEN) {
        confirmed.push({ pool: c.address, pairedToken: t0 === GD_TOKEN ? t1 : t0, outTotalGd: toGd(c.outTotal), inTotalGd: toGd(c.inTotal) });
      }
    } catch {
      // not an AMM pair, skip
    }
  }
  return confirmed.sort((a, b) => b.outTotalGd - a.outTotalGd);
}

async function main() {
  const { fromBlock, toBlock, secPerBlock } = await resolveWindowBlocks();
  console.log(`Fuse window blocks: ${fromBlock} to ${toBlock} (~${secPerBlock.toFixed(2)}s/block)`);

  const rawLogs = await getLogsChunked(fromBlock, toBlock, 3000);
  const transfers = rawLogs.map(decodeTransfer);
  console.log(`Total GD transfer events in window: ${transfers.length}`);

  const pools = await classifyPools(transfers);
  console.log(`Confirmed GD pools on Fuse: ${pools.length}`);
  console.log(JSON.stringify(pools, null, 2));

  const poolSet = new Set(pools.map((p) => p.pool));
  const byBuyer = new Map();
  for (const t of transfers) {
    if (!poolSet.has(t.from)) continue;
    if (poolSet.has(t.to)) continue; // skip pool-to-pool routing hops
    if (!byBuyer.has(t.to)) byBuyer.set(t.to, { buyer: t.to, gdBought: 0, txHashes: [] });
    const row = byBuyer.get(t.to);
    row.gdBought += toGd(t.value);
    row.txHashes.push(t.txHash);
  }

  const ranked = [...byBuyer.values()].sort((a, b) => b.gdBought - a.gdBought).slice(0, 25);
  for (const row of ranked) {
    row.currentGdBalance = await currentGdBalance(row.buyer);
    row.txCount = row.txHashes.length;
    delete row.txHashes;
  }

  console.log(`\nTop buyers from confirmed Fuse pools:`);
  console.log(JSON.stringify(ranked, null, 2));
}

main().catch((err) => { console.error(err.message || err); process.exitCode = 1; });
