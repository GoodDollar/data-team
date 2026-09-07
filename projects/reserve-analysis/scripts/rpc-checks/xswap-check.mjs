// Reproducible XSwap (XDC) cheap-buyer check for the incident window.
// Method: scan GD token Transfer logs directly via RPC, no dependency on any
// explorer API or manually-supplied pool address. Pool-like addresses are
// identified empirically (bidirectional flow, many counterparties, varying
// amounts) then confirmed on-chain via the standard Uniswap V2 token0/token1
// selectors before being trusted as swap venues.

const XDC_RPC_ENDPOINTS = [
  "https://rpc.xinfin.network",
  "https://erpc.xinfin.network",
  "https://rpc.ankr.com/xdc",
  "https://xdc.public-rpc.com"
];
const GD_TOKEN = "0xec2136843a983885aebf2feb3931f73a8ebee50c";
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";

const WINDOW = {
  startIso: "2026-09-03T00:00:00Z",
  endIso: "2026-09-05T00:00:00Z"
};

let rpcId = 1;
let endpointIndex = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(method, params, attempt = 1) {
  const url = XDC_RPC_ENDPOINTS[endpointIndex];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ })
  });

  if (res.status === 403 || res.status === 429) {
    if (attempt >= XDC_RPC_ENDPOINTS.length * 2) {
      throw new Error(`HTTP ${res.status} from RPC calling ${method} after exhausting endpoint rotation`);
    }
    endpointIndex = (endpointIndex + 1) % XDC_RPC_ENDPOINTS.length;
    await sleep(400);
    return rpc(method, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from RPC calling ${method}`);

  const json = await res.json();
  if (json.error) throw new Error(`RPC error calling ${method}: ${json.error.message}`);
  await sleep(300);
  return json.result;
}

function toHexBlock(n) {
  return "0x" + n.toString(16);
}

async function blockTimestamp(blockNum) {
  const blk = await rpc("eth_getBlockByNumber", [toHexBlock(blockNum), false]);
  return Number(BigInt(blk.timestamp));
}

// Empirically measured against this RPC: block 106962597 @ 1788815940 (2026-09-07T21:19:00Z),
// block 106957597 @ 1788805170 (2026-09-07T18:19:30Z) => 2.154 sec/block.
const REFERENCE_BLOCK = 106962597;
const REFERENCE_TS = 1788815940;
const SEC_PER_BLOCK = 2.154;
const SAFETY_PADDING_BLOCKS = 900; // ~30 min, absorbs any drift in the rate estimate

async function resolveWindowBlocks() {
  const latestHex = await rpc("eth_blockNumber", []);
  const latest = Number(BigInt(latestHex));

  const startTs = Math.floor(new Date(WINDOW.startIso).getTime() / 1000);
  const endTs = Math.floor(new Date(WINDOW.endIso).getTime() / 1000);

  const rawFromBlock = REFERENCE_BLOCK - Math.round((REFERENCE_TS - startTs) / SEC_PER_BLOCK);
  const rawToBlock = REFERENCE_BLOCK - Math.round((REFERENCE_TS - endTs) / SEC_PER_BLOCK);

  const fromBlock = Math.max(1, rawFromBlock - SAFETY_PADDING_BLOCKS);
  const toBlock = Math.min(latest, rawToBlock + SAFETY_PADDING_BLOCKS);

  // Verify the estimate landed close to the intended timestamps (sanity check, not a hard requirement).
  const fromTs = await blockTimestamp(fromBlock);
  const toTs = await blockTimestamp(toBlock);

  return {
    fromBlock,
    toBlock,
    latest,
    sanityCheck: {
      fromBlockActualUtc: new Date(fromTs * 1000).toISOString(),
      toBlockActualUtc: new Date(toTs * 1000).toISOString()
    }
  };
}

async function getLogsChunked(fromBlock, toBlock, chunkSize) {
  const logs = [];
  let cursor = fromBlock;
  let size = chunkSize;

  while (cursor <= toBlock) {
    const end = Math.min(cursor + size - 1, toBlock);
    try {
      const chunk = await rpc("eth_getLogs", [{
        address: GD_TOKEN,
        topics: [TRANSFER_TOPIC0],
        fromBlock: toHexBlock(cursor),
        toBlock: toHexBlock(end)
      }]);
      logs.push(...chunk);
      cursor = end + 1;
    } catch (err) {
      if (size <= 200) throw err;
      size = Math.floor(size / 2);
    }
  }

  return logs;
}

function topicToAddress(topic) {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function decodeTransfer(log) {
  return {
    from: topicToAddress(log.topics[1]),
    to: topicToAddress(log.topics[2]),
    value: BigInt(log.data),
    txHash: log.transactionHash,
    blockNumber: Number(BigInt(log.blockNumber))
  };
}

function toGd(value) {
  return Number(value) / 1e18;
}

async function classifyPools(transfers) {
  const stats = new Map();

  for (const t of transfers) {
    for (const [addr, direction] of [[t.from, "out"], [t.to, "in"]]) {
      if (!stats.has(addr)) {
        stats.set(addr, { address: addr, outTotal: 0n, inTotal: 0n, outCount: 0, inCount: 0, counterparties: new Set(), amounts: new Set() });
      }
      const s = stats.get(addr);
      s.counterparties.add(direction === "out" ? t.to : t.from);
      s.amounts.add(t.value.toString());
      if (direction === "out") {
        s.outTotal += t.value;
        s.outCount += 1;
      } else {
        s.inTotal += t.value;
        s.inCount += 1;
      }
    }
  }

  // Empirical pool signature: meaningful volume in both directions, more than
  // one distinct counterparty on each side, and non-uniform transfer amounts
  // (rules out one-way faucets like UBI claims, which pay a fixed amount).
  const candidates = [...stats.values()].filter((s) =>
    s.outCount >= 2 &&
    s.inCount >= 2 &&
    s.amounts.size >= 3 &&
    s.outTotal > 0n &&
    s.inTotal > 0n
  );

  const confirmed = [];
  for (const c of candidates) {
    try {
      const token0 = await rpc("eth_call", [{ to: c.address, data: TOKEN0_SELECTOR }, "latest"]);
      const token1 = await rpc("eth_call", [{ to: c.address, data: TOKEN1_SELECTOR }, "latest"]);
      const t0 = topicToAddress(token0);
      const t1 = topicToAddress(token1);
      if (t0 === GD_TOKEN || t1 === GD_TOKEN) {
        confirmed.push({
          pool: c.address,
          pairedToken: t0 === GD_TOKEN ? t1 : t0,
          outTotalGd: toGd(c.outTotal),
          inTotalGd: toGd(c.inTotal),
          outCount: c.outCount,
          inCount: c.inCount
        });
      }
    } catch {
      // not a token0/token1-shaped contract, so not an AMM pair, skip it
    }
  }

  return confirmed;
}

async function currentGdBalance(address) {
  const selector = "0x70a08231"; // balanceOf(address)
  const padded = address.replace("0x", "").padStart(64, "0");
  const result = await rpc("eth_call", [{ to: GD_TOKEN, data: selector + padded }, "latest"]);
  return toGd(BigInt(result));
}

async function buildBuyerRanking(transfers, pools) {
  const poolAddrs = new Set(pools.map((p) => p.pool));
  const byBuyer = new Map();

  for (const t of transfers) {
    if (!poolAddrs.has(t.from)) continue; // only GD leaving a confirmed pool = a buy
    if (!byBuyer.has(t.to)) {
      byBuyer.set(t.to, { buyer: t.to, gdBought: 0, txHashes: [] });
    }
    const row = byBuyer.get(t.to);
    row.gdBought += toGd(t.value);
    row.txHashes.push(t.txHash);
  }

  const ranked = [...byBuyer.values()].sort((a, b) => b.gdBought - a.gdBought);

  for (const row of ranked) {
    row.currentGdBalance = await currentGdBalance(row.buyer);
  }

  return ranked;
}

async function main() {
  const { fromBlock, toBlock, latest } = await resolveWindowBlocks();

  const rawLogs = await getLogsChunked(fromBlock, toBlock, 5000);
  const transfers = rawLogs.map(decodeTransfer);

  const pools = await classifyPools(transfers);
  const buyers = await buildBuyerRanking(transfers, pools);

  const output = {
    generatedAt: new Date().toISOString(),
    method: "Empirical pool detection via GD Transfer logs (bidirectional flow, varying amounts), confirmed via token0()/token1() against the GD contract. No pool address assumed in advance.",
    window: WINDOW,
    blockRange: { fromBlock, toBlock, latestBlockAtRunTime: latest },
    gdTokenContract: GD_TOKEN,
    transferLogCount: transfers.length,
    confirmedPools: pools,
    buyers: buyers.slice(0, 50)
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
