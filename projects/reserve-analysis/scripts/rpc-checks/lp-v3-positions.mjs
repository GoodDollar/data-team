// Uniswap-V3-fork LP position reconstruction, self-discovering the NFPM per
// pool (no hardcoded NFPM address -- different Celo V3 forks use different
// NFPM contracts, confirmed 2026-09-08 when the "known" NFPM address from a
// prior session turned out to be wrong for 3 of our 5 V3-style GD pools).
//
// Method per pool:
//  1. Binary-search the pool's own deployment block (avoids scanning from 0).
//  2. Scan the POOL's own Mint event history (much smaller than a whole
//     factory's) for the full range, chunked to stay under the RPC's
//     archive-range limit.
//  3. For each Mint tx, pull the full receipt and find whichever contract in
//     the SAME transaction emitted an IncreaseLiquidity(tokenId,...) event --
//     that contract IS the NFPM for this position (self-discovered, not
//     assumed), and its log gives the tokenId.
//  4. For each unique tokenId: call positions(tokenId) (current liquidity +
//     tick range) and ownerOf(tokenId) (current holder, or "burned" if it
//     reverts) on ITS OWN NFPM.
//  5. Pull the pool's live slot0() (current sqrtPriceX96/tick) and compute
//     each open position's current token0/token1 amounts with standard
//     Uniswap V3 range-math (double-precision float; adequate for a
//     magnitude assessment, NOT wei-exact -- see cross-check against the
//     pool's own balanceOf below).
//
// All selectors/topics used here were empirically confirmed against a live
// Celoscan-decoded transaction or a live eth_call before use.

const CELO_RPC_ENDPOINTS = ["https://celo.drpc.org", "https://forno.celo.org", "https://rpc.ankr.com/celo"];
const GD_TOKEN = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";

const MINT_TOPIC0 = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
const INCREASE_LIQUIDITY_TOPIC0 = "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const SELECTORS = {
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  slot0: "0x3850c7bd",
  positions: "0x99fbab88",
  ownerOf: "0x6352211e",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  balanceOf: "0x70a08231"
};

const POOLS_TO_CHECK = process.argv[2] ? [process.argv[2]] : [
  "0x9491d57c5687ab75726423b55ac2d87d1cda2c3f", // Uniswap V3 GD/cUSD -- calibration case (Lewis already posted 3 positions for this one)
  "0x991f1aa7e0901f9ab3d583846bf5be0ebace1d7f", // Uniswap V3 GD/USDGLO
  "0xcb037f27eb3952222810966e28e0ceb650c65cd9", // Uniswap V3 GD/CELO
  "0x3d9e27c04076288ebfdc4815b4f6d81b0ed1b341", // Ubeswap V3-style GD/USDGLO (different factory/NFPM)
  "0x8b393470bef8bb27a9a5169531b4eba5209b0b26"  // Ubeswap V3-style GD/CELO 0.3% (same factory/NFPM as above)
];

let rpcId = 1;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function rpc(method, params, epIndex = 0, attempt = 1) {
  const url = CELO_RPC_ENDPOINTS[epIndex % CELO_RPC_ENDPOINTS.length];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ })
  });
  if (!res.ok) {
    if (attempt >= CELO_RPC_ENDPOINTS.length * 4) throw new Error(`HTTP ${res.status} calling ${method}`);
    await sleep(300);
    return rpc(method, params, epIndex + 1, attempt + 1);
  }
  const json = await res.json();
  if (json.error) {
    if (attempt >= CELO_RPC_ENDPOINTS.length * 4) throw new Error(`RPC error calling ${method}: ${json.error.message}`);
    await sleep(300);
    return rpc(method, params, epIndex + 1, attempt + 1);
  }
  await sleep(120);
  return json.result;
}

function addressFromTopic(t) { return "0x" + t.slice(-40); }
function addressFromWord(w) { return "0x" + w.slice(24); }
function toHexBlock(n) { return "0x" + n.toString(16); }

async function ethCall(to, data) {
  try {
    const res = await rpc("eth_call", [{ to, data }, "latest"]);
    if (!res || res === "0x") return null;
    return res;
  } catch { return null; }
}

async function getCode(address) { return rpc("eth_getCode", [address, "latest"]); }

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

async function symbolOf(token) {
  const res = await ethCall(token, SELECTORS.symbol);
  if (!res) return "UNKNOWN";
  try {
    const bytes = Buffer.from(res.slice(2), "hex");
    if (bytes.length === 32) return bytes.toString("utf8").replace(/\0/g, "").trim() || "UNKNOWN";
    return bytes.slice(64).toString("utf8").replace(/\0/g, "").trim() || "UNKNOWN";
  } catch { return "UNKNOWN"; }
}
async function decimalsOf(token) {
  const res = await ethCall(token, SELECTORS.decimals);
  return res ? Number(BigInt(res)) : 18;
}
async function balanceOf(token, holder) {
  const padded = holder.replace("0x", "").padStart(64, "0");
  const res = await ethCall(token, SELECTORS.balanceOf + padded);
  return res ? Number(BigInt(res)) : 0;
}

function wordsOf(hexNo0x) {
  const words = [];
  for (let k = 0; k < hexNo0x.length; k += 64) words.push(hexNo0x.slice(k, k + 64));
  return words;
}
function asSigned(wordHex, bits) {
  let v = BigInt("0x" + wordHex);
  const max = 2n ** BigInt(bits - 1);
  const mod = 2n ** BigInt(bits);
  if (v >= max) v -= mod;
  return v;
}

async function slot0(pool) {
  const res = await ethCall(pool, SELECTORS.slot0);
  const w = wordsOf(res.slice(2));
  return {
    sqrtPriceX96: BigInt("0x" + w[0]),
    tick: Number(asSigned(w[1].slice(-6), 24))
  };
}

async function positions(nfpm, tokenId) {
  const idHex = tokenId.toString(16).padStart(64, "0");
  const res = await ethCall(nfpm, SELECTORS.positions + idHex);
  if (!res) return null;
  const w = wordsOf(res.slice(2));
  return {
    token0: addressFromWord(w[2]),
    token1: addressFromWord(w[3]),
    fee: Number(BigInt("0x" + w[4])),
    tickLower: Number(asSigned(w[5].slice(-6), 24)),
    tickUpper: Number(asSigned(w[6].slice(-6), 24)),
    liquidity: BigInt("0x" + w[7])
  };
}

async function ownerOf(nfpm, tokenId) {
  const idHex = tokenId.toString(16).padStart(64, "0");
  const res = await ethCall(nfpm, SELECTORS.ownerOf + idHex);
  if (!res) return null; // reverted -- burned or never existed
  const addr = addressFromWord(res.slice(2));
  if (addr === "0x0000000000000000000000000000000000000000") return null;
  return addr;
}

// Standard Uniswap V3 range math, float precision (adequate for magnitude
// assessment; cross-checked in aggregate against the pool's own balanceOf
// below rather than trusted to the wei).
function sqrtPriceAtTick(tick) { return Math.pow(1.0001, tick / 2); }
function amountsForPosition(liquidity, tickLower, tickUpper, currentTick, sqrtPriceX96Current) {
  const L = Number(liquidity);
  const sqrtLower = sqrtPriceAtTick(tickLower);
  const sqrtUpper = sqrtPriceAtTick(tickUpper);
  const Q96 = Math.pow(2, 96);
  const sqrtCurrent = Number(sqrtPriceX96Current) / Q96;
  let amount0 = 0, amount1 = 0;
  if (currentTick < tickLower) {
    amount0 = L * (sqrtUpper - sqrtLower) / (sqrtUpper * sqrtLower);
  } else if (currentTick >= tickUpper) {
    amount1 = L * (sqrtUpper - sqrtLower);
  } else {
    amount0 = L * (sqrtUpper - sqrtCurrent) / (sqrtUpper * sqrtCurrent);
    amount1 = L * (sqrtCurrent - sqrtLower);
  }
  return { amount0, amount1 };
}

async function processPool(poolAddress, latest) {
  console.error(`\n=== Pool ${poolAddress} ===`);
  const token0 = addressFromWord((await ethCall(poolAddress, SELECTORS.token0)).slice(2));
  const token1 = addressFromWord((await ethCall(poolAddress, SELECTORS.token1)).slice(2));
  const gdIsToken0 = token0.toLowerCase() === GD_TOKEN;
  console.error(`token0=${token0} token1=${token1} gdIsToken0=${gdIsToken0}`);

  const deployBlock = await findDeploymentBlock(poolAddress, latest);
  console.error(`deployment block: ${deployBlock}`);

  const mintLogs = await getLogsChunked({ address: poolAddress, topics: [MINT_TOPIC0] }, deployBlock, latest, 5000, poolAddress.slice(0, 10));
  console.error(`Mint events found: ${mintLogs.length}`);

  const txHashes = [...new Set(mintLogs.map((l) => l.transactionHash))];
  const tokenIdToNfpm = new Map();
  for (const txHash of txHashes) {
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    for (const log of receipt.logs) {
      if (log.topics[0] === INCREASE_LIQUIDITY_TOPIC0) {
        const tokenId = Number(BigInt(log.topics[1]));
        tokenIdToNfpm.set(tokenId, log.address);
      }
    }
  }
  console.error(`Unique position token IDs found via same-tx correlation: ${tokenIdToNfpm.size}`);

  const { sqrtPriceX96, tick: currentTick } = await slot0(poolAddress);
  console.error(`current tick: ${currentTick}, sqrtPriceX96: ${sqrtPriceX96}`);

  const positionsOut = [];
  for (const [tokenId, nfpm] of tokenIdToNfpm.entries()) {
    const pos = await positions(nfpm, tokenId);
    if (!pos) { console.error(`  tokenId ${tokenId}: positions() call failed`); continue; }
    // Confirm this position actually belongs to THIS pool (defends against a
    // tokenId collision across different pools using the same NFPM).
    const belongsToThisPool = [pos.token0.toLowerCase(), pos.token1.toLowerCase()].includes(token0.toLowerCase())
      && [pos.token0.toLowerCase(), pos.token1.toLowerCase()].includes(token1.toLowerCase());
    if (!belongsToThisPool) { console.error(`  tokenId ${tokenId}: belongs to a different pool (token0=${pos.token0}, token1=${pos.token1}), skipping`); continue; }
    const owner = await ownerOf(nfpm, tokenId);
    const inRange = currentTick >= pos.tickLower && currentTick < pos.tickUpper;
    let gdAmount = 0;
    if (pos.liquidity > 0n) {
      const { amount0, amount1 } = amountsForPosition(pos.liquidity, pos.tickLower, pos.tickUpper, currentTick, sqrtPriceX96);
      // Raw integer units -- GD is 18 decimals on Celo, scale down.
      gdAmount = (gdIsToken0 ? amount0 : amount1) / 1e18;
    }
    positionsOut.push({
      tokenId, nfpm, owner: owner || "BURNED_OR_NONEXISTENT",
      tickLower: pos.tickLower, tickUpper: pos.tickUpper,
      liquidity: pos.liquidity.toString(),
      liquidityIsZero: pos.liquidity === 0n,
      inRange, gdAmountEstimate: gdAmount
    });
    console.error(`  tokenId ${tokenId}: owner=${owner || "BURNED/NONE"} liquidity=${pos.liquidity} inRange=${inRange} gdEstimate=${gdAmount.toFixed(2)}`);
  }

  const gdBalanceRaw = await balanceOf(GD_TOKEN, poolAddress);
  const gdBalance = gdBalanceRaw / 1e18;
  const sumEstimated = positionsOut.reduce((s, p) => s + p.gdAmountEstimate, 0);

  return {
    pool: poolAddress, token0, token1, gdIsToken0,
    deployBlock, mintEventCount: mintLogs.length,
    currentTick, sqrtPriceX96: sqrtPriceX96.toString(),
    positions: positionsOut,
    crossCheck: { poolGdBalanceActual: gdBalance, sumOfEstimatedPositionGd: sumEstimated, ratio: gdBalance > 0 ? sumEstimated / gdBalance : null }
  };
}

async function main() {
  const latestHex = await rpc("eth_blockNumber", []);
  const latest = Number(BigInt(latestHex));
  console.error(`Latest Celo block: ${latest}`);

  const results = [];
  for (const pool of POOLS_TO_CHECK) {
    try {
      results.push(await processPool(pool, latest));
    } catch (err) {
      console.error(`Pool ${pool} FAILED: ${err.message}`);
      results.push({ pool, error: err.message });
    }
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), latestBlock: latest, results }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
