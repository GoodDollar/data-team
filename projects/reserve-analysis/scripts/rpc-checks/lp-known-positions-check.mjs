// Direct, fast check of the 3 specific LP positions Lewis already posted in
// Slack for pool 0x9491d57c (GD/cUSD), by token ID -- no historical scan
// needed since the IDs are already known. Computes current GD amount per
// position via validated tick-math and cross-checks the sum against the
// pool's own live GD balanceOf.

const CELO_RPC_ENDPOINTS = ["https://forno.celo.org", "https://celo.drpc.org", "https://rpc.ankr.com/celo"];
const GD_TOKEN = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";
const POOL = "0x9491d57c5687ab75726423b55ac2d87d1cda2c3f";
const NFPM = "0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A";
const KNOWN_TOKEN_IDS = [201874, 201875, 201876];

let rpcId = 1;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function rpc(method, params, epIndex = 0, attempt = 1) {
  const url = CELO_RPC_ENDPOINTS[epIndex % CELO_RPC_ENDPOINTS.length];
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ }) });
  const json = await res.json();
  if (json.error) { if (attempt >= CELO_RPC_ENDPOINTS.length * 3) throw new Error(json.error.message); await sleep(300); return rpc(method, params, epIndex + 1, attempt + 1); }
  return json.result;
}
async function ethCall(to, data) {
  const r = await rpc("eth_call", [{ to, data }, "latest"]);
  return (!r || r === "0x") ? null : r;
}
function addressFromWord(w) { return "0x" + w.slice(24); }
function wordsOf(hexNo0x) { const words = []; for (let k = 0; k < hexNo0x.length; k += 64) words.push(hexNo0x.slice(k, k + 64)); return words; }
function asSigned(wordHex, bits) {
  let v = BigInt("0x" + wordHex);
  const max = 2n ** BigInt(bits - 1);
  const mod = 2n ** BigInt(bits);
  if (v >= max) v -= mod;
  return v;
}
function sqrtPriceAtTick(tick) { return Math.pow(1.0001, tick / 2); }
function amountsForPosition(liquidity, tickLower, tickUpper, currentTick, sqrtPriceX96Current) {
  const L = Number(liquidity);
  const sqrtLower = sqrtPriceAtTick(tickLower);
  const sqrtUpper = sqrtPriceAtTick(tickUpper);
  const Q96 = Math.pow(2, 96);
  const sqrtCurrent = Number(sqrtPriceX96Current) / Q96;
  let amount0 = 0, amount1 = 0;
  if (currentTick < tickLower) { amount0 = L * (sqrtUpper - sqrtLower) / (sqrtUpper * sqrtLower); }
  else if (currentTick >= tickUpper) { amount1 = L * (sqrtUpper - sqrtLower); }
  else { amount0 = L * (sqrtUpper - sqrtCurrent) / (sqrtUpper * sqrtCurrent); amount1 = L * (sqrtCurrent - sqrtLower); }
  return { amount0, amount1 };
}

async function main() {
  const token0 = addressFromWord((await ethCall(POOL, "0x0dfe1681")).slice(2));
  const gdIsToken0 = token0.toLowerCase() === GD_TOKEN;

  const slot0Raw = await ethCall(POOL, "0x3850c7bd");
  const slot0Words = wordsOf(slot0Raw.slice(2));
  const sqrtPriceX96 = BigInt("0x" + slot0Words[0]);
  const currentTick = Number(asSigned(slot0Words[1].slice(-6), 24));
  console.error(`Pool current tick: ${currentTick}, sqrtPriceX96: ${sqrtPriceX96}`);

  const results = [];
  for (const tokenId of KNOWN_TOKEN_IDS) {
    const idHex = tokenId.toString(16).padStart(64, "0");
    const posRaw = await ethCall(NFPM, "0x99fbab88" + idHex);
    const w = wordsOf(posRaw.slice(2));
    const tickLower = Number(asSigned(w[5].slice(-6), 24));
    const tickUpper = Number(asSigned(w[6].slice(-6), 24));
    const liquidity = BigInt("0x" + w[7]);
    const ownerRaw = await ethCall(NFPM, "0x6352211e" + idHex);
    const owner = ownerRaw ? addressFromWord(ownerRaw.slice(2)) : "BURNED_OR_NONE";
    const inRange = currentTick >= tickLower && currentTick < tickUpper;
    const { amount0, amount1 } = amountsForPosition(liquidity, tickLower, tickUpper, currentTick, sqrtPriceX96);
    // Uniswap V3 liquidity math returns amounts in the token's raw integer
    // units (e.g. wei for an 18-decimal token) -- GD is 18 decimals on Celo
    // (established convention throughout this repo's other scripts).
    const gdAmount = (gdIsToken0 ? amount0 : amount1) / 1e18;
    const otherAmount = (gdIsToken0 ? amount1 : amount0) / 1e18;
    results.push({ tokenId, owner, tickLower, tickUpper, liquidity: liquidity.toString(), inRange, gdAmountEstimate: gdAmount, otherTokenAmountEstimate: otherAmount });
    console.error(`tokenId ${tokenId}: owner=${owner} tickLower=${tickLower} tickUpper=${tickUpper} inRange=${inRange} liquidity=${liquidity} gdEstimate=${gdAmount.toFixed(2)}`);
  }

  const gdBalanceRaw = BigInt(await ethCall(GD_TOKEN, "0x70a08231" + POOL.replace("0x", "").padStart(64, "0")));
  const gdBalance = Number(gdBalanceRaw) / 1e18;
  const sumEstimated = results.reduce((s, r) => s + r.gdAmountEstimate, 0);
  console.error(`Pool total GD balance (actual, live): ${gdBalance}`);
  console.error(`Sum of these 3 known positions' estimated GD: ${sumEstimated}`);
  console.error(`Ratio (3 known positions / pool total): ${(sumEstimated / gdBalance * 100).toFixed(2)}%`);

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), pool: POOL, currentTick, sqrtPriceX96: sqrtPriceX96.toString(), positions: results, poolGdBalanceActual: gdBalance, sumOfKnownPositionsGd: sumEstimated, pctOfPoolAccountedForByKnownPositions: sumEstimated / gdBalance * 100 }, null, 2));
}
main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
