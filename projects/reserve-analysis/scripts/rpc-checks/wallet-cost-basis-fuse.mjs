// Burn/refund candidate list for Fuse: for each wallet that bought GD cheaply
// in the window and still holds GD, report GD bought, GD still held, and
// what they paid (raw asset, USD only where the paired asset is a
// stablecoin). Same shape as wallet-cost-basis-xdc.mjs.
// Pool detection and pool-to-pool routing exclusion reused from
// fuse-cheap-buyer-check.mjs (already correct there, decimals fix included).

const FUSE_RPC_ENDPOINTS = ["https://rpc.fuse.io", "https://fuse-pokt.nodies.app", "https://rpc.ankr.com/fuse"];
const GD_TOKEN = "0x495d133b938596c9984d462f007b676bdc57ecec";
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";
const SYMBOL_SELECTOR = "0x95d89b41";
const DECIMALS_SELECTOR = "0x313ce567";
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "USDM", "USDGLO"]);

// Confirmed 2026-09-08 (operator-attributed): operator/treasury wallet, not
// an external buyer. Found on XDC, excluded here defensively too.
const KNOWN_EXCLUSIONS = new Set(["0x66582d24fead72555adac681cc621cacbb208324"]);

// Same window agreed for Celo/XDC: 1 hour before the malicious contract's
// verified deployment (2026-09-02T15:35:12Z), through now.
const WINDOW = { startIso: "2026-09-02T14:35:12Z", endIso: new Date().toISOString() };

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
function topicAddress(addr) { return "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0"); }
function addressFromTopic(t) { return "0x" + t.slice(-40); }
// GD on Fuse uses 2 decimals, unlike Celo/XDC/Ethereum (18). Verified via
// decimals() on this contract during Phase 4, do not assume 18 here.
function toGd(v) { return Number(v) / 1e2; }

async function blockTimestamp(n) { const blk = await rpc("eth_getBlockByNumber", [toHexBlock(n), false]); return Number(BigInt(blk.timestamp)); }

// Self-calibrating: no hardcoded reference block, derives sec/block fresh
// every run.
async function resolveBlockForTimestamp(targetTs, latest) {
  const latestTs = await blockTimestamp(latest);
  const farBack = Math.max(1, latest - 300000);
  const farBackTs = await blockTimestamp(farBack);
  const secPerBlock = (latestTs - farBackTs) / (latest - farBack);
  const raw = latest - Math.round((latestTs - targetTs) / secPerBlock);
  return Math.max(1, Math.min(latest, raw));
}

async function getLogsChunked(filterBase, fromBlock, toBlock, chunkSize) {
  const logs = [];
  let cursor = fromBlock;
  let size = chunkSize;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + size - 1, toBlock);
    try {
      const chunk = await rpc("eth_getLogs", [{ ...filterBase, fromBlock: toHexBlock(cursor), toBlock: toHexBlock(end) }]);
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
  return { from: addressFromTopic(log.topics[1]), to: addressFromTopic(log.topics[2]), value: BigInt(log.data), txHash: log.transactionHash };
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
      const t0 = addressFromTopic(token0);
      const t1 = addressFromTopic(token1);
      if (t0 === GD_TOKEN || t1 === GD_TOKEN) confirmed.push({ pool: c.address, pairedToken: t0 === GD_TOKEN ? t1 : t0 });
    } catch { /* not an AMM pair, skip */ }
  }
  return confirmed;
}

const tokenMetaCache = new Map();
async function tokenMeta(address) {
  if (tokenMetaCache.has(address)) return tokenMetaCache.get(address);
  let symbol = "UNKNOWN";
  let decimals = 18;
  try {
    const symHex = await rpc("eth_call", [{ to: address, data: SYMBOL_SELECTOR }, "latest"]);
    const bytes = Buffer.from(symHex.slice(2), "hex");
    symbol = bytes.slice(64, bytes.length).toString("utf8").replace(/\0/g, "").trim() || "UNKNOWN";
  } catch { /* leave as UNKNOWN */ }
  try {
    const decHex = await rpc("eth_call", [{ to: address, data: DECIMALS_SELECTOR }, "latest"]);
    decimals = Number(BigInt(decHex));
  } catch { /* leave as 18 */ }
  const meta = { symbol, decimals };
  tokenMetaCache.set(address, meta);
  return meta;
}

async function currentGdBalance(address) {
  const selector = "0x70a08231";
  const padded = address.replace("0x", "").padStart(64, "0");
  const result = await rpc("eth_call", [{ to: GD_TOKEN, data: selector + padded }, "latest"]);
  return toGd(BigInt(result));
}

async function main() {
  const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
  const startTs = Math.floor(new Date(WINDOW.startIso).getTime() / 1000);
  const endTs = Math.floor(new Date(WINDOW.endIso).getTime() / 1000);
  const fromBlock = await resolveBlockForTimestamp(startTs, latest);
  const toBlock = Math.min(latest, await resolveBlockForTimestamp(endTs, latest) + 900);
  console.error(`Window blocks: ${fromBlock} to ${toBlock} (latest ${latest})`);

  const rawLogs = await getLogsChunked({ address: GD_TOKEN, topics: [TRANSFER_TOPIC0] }, fromBlock, toBlock, 100000);
  console.error(`GD transfer events in window: ${rawLogs.length}`);
  const transfers = rawLogs.map(decodeTransfer);

  const pools = await classifyPools(transfers);
  console.error(`Confirmed GD pools: ${pools.length} -> ${pools.map((p) => p.pool).join(", ")}`);
  const poolAddrs = new Set(pools.map((p) => p.pool));

  const byBuyer = new Map();
  for (const t of transfers) {
    if (!poolAddrs.has(t.from)) continue;
    if (poolAddrs.has(t.to)) continue; // pool-to-pool routing, not an external buyer
    if (!byBuyer.has(t.to)) byBuyer.set(t.to, { buyer: t.to, gdBought: 0, buyTxHashes: new Set() });
    const row = byBuyer.get(t.to);
    row.gdBought += toGd(t.value);
    row.buyTxHashes.add(t.txHash);
  }
  console.error(`Buyers found: ${byBuyer.size}`);

  const receiptCache = new Map();
  async function getReceipt(txHash) {
    if (!receiptCache.has(txHash)) receiptCache.set(txHash, await rpc("eth_getTransactionReceipt", [txHash]));
    return receiptCache.get(txHash);
  }
  const txCache = new Map();
  async function getTx(txHash) {
    if (!txCache.has(txHash)) txCache.set(txHash, await rpc("eth_getTransactionByHash", [txHash]));
    return txCache.get(txHash);
  }

  const results = [];
  let processed = 0;
  for (const row of byBuyer.values()) {
    if (KNOWN_EXCLUSIONS.has(row.buyer)) {
      console.error(`  skipping known-excluded wallet ${row.buyer}`);
      continue;
    }
    const paidByToken = new Map();
    let nativeFusePaid = 0;
    for (const txHash of row.buyTxHashes) {
      const receipt = await getReceipt(txHash);
      const tx = await getTx(txHash);
      if (BigInt(tx.value || "0x0") > 0n && tx.from.toLowerCase() === row.buyer) {
        nativeFusePaid += Number(BigInt(tx.value)) / 1e18;
      }
      for (const log of receipt.logs) {
        if (log.topics[0] !== TRANSFER_TOPIC0) continue;
        if (addressFromTopic(log.topics[1]) !== row.buyer) continue;
        const token = log.address.toLowerCase();
        const amount = BigInt(log.data);
        paidByToken.set(token, (paidByToken.get(token) || 0n) + amount);
      }
    }

    const paid = [];
    let usdPaidTotal = 0;
    let usdIncomplete = false;
    if (nativeFusePaid > 0) {
      paid.push({ token: "native", symbol: "FUSE", amount: nativeFusePaid, usd: null });
      usdIncomplete = true;
    }
    for (const [token, amountRaw] of paidByToken.entries()) {
      const meta = await tokenMeta(token);
      const amount = Number(amountRaw) / Math.pow(10, meta.decimals);
      const isStable = STABLE_SYMBOLS.has(meta.symbol.toUpperCase());
      paid.push({ token, symbol: meta.symbol, amount, usd: isStable ? amount : null });
      if (isStable) usdPaidTotal += amount;
      else usdIncomplete = true;
    }

    const currentBalance = await currentGdBalance(row.buyer);

    results.push({
      wallet: row.buyer,
      gdBought: row.gdBought,
      gdCurrentlyHeld: currentBalance,
      paidRaw: paid,
      usdPaidTotal: usdIncomplete ? null : usdPaidTotal,
      usdPaidNote: usdIncomplete ? "one or more payment legs were in a non-stablecoin asset, USD figure incomplete, see paidRaw" : null
    });

    processed += 1;
    console.error(`  processed buyer ${processed}/${byBuyer.size}: ${row.buyer}`);
  }

  const stillHolding = results.filter((r) => r.gdCurrentlyHeld > 0).sort((a, b) => b.gdCurrentlyHeld - a.gdCurrentlyHeld);

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    window: WINDOW,
    blockRange: { fromBlock, toBlock, latestAtRunTime: latest },
    confirmedPools: pools,
    totalBuyersFound: results.length,
    stillHoldingCount: stillHolding.length,
    stillHolding
  }, null, 2));
}

main().catch((err) => { console.error(err.message || err); process.exitCode = 1; });
