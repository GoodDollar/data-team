// Bulk GD-amount computation for every V3 position discovered by the Dune
// query (queries/dune/reserve-analysis/lp-v3-positions.sql), parsed into
// <file>.parsed.json by parse-dune-export.mjs. No historical scanning
// needed -- every token ID is already known, so this is just a fast,
// targeted positions()+slot0() pass (same validated method as
// lp-known-positions-check.mjs, generalized to an arbitrary position list
// instead of 3 hardcoded IDs).

import fs from "node:fs";
import { addressSet } from "./wallet-list.mjs";

const CELO_RPC_ENDPOINTS = ["https://forno.celo.org", "https://celo.drpc.org", "https://rpc.ankr.com/celo"];
const GD_TOKEN = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";
const BURN_ADDRESSES = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
const KNOWN_TREASURY = new Set(["0x66582d24fead72555adac681cc621cacbb208324"]);
// Loaded from the local-only _wallet-list.json -- see wallet-list.example.json.
const KNOWN_LIST = addressSet("celo");

let rpcId = 1;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function rpc(method, params, epIndex = 0, attempt = 1) {
  const url = CELO_RPC_ENDPOINTS[epIndex % CELO_RPC_ENDPOINTS.length];
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ }) });
  const json = await res.json();
  if (json.error) { if (attempt >= CELO_RPC_ENDPOINTS.length * 4) throw new Error(json.error.message); await sleep(250); return rpc(method, params, epIndex + 1, attempt + 1); }
  await sleep(60);
  return json.result;
}
async function ethCall(to, data) {
  try { const r = await rpc("eth_call", [{ to, data }, "latest"]); return (!r || r === "0x") ? null : r; } catch { return null; }
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
  const sqrtCurrent = Number(sqrtPriceX96Current) / Math.pow(2, 96);
  let amount0 = 0, amount1 = 0;
  if (currentTick < tickLower) { amount0 = L * (sqrtUpper - sqrtLower) / (sqrtUpper * sqrtLower); }
  else if (currentTick >= tickUpper) { amount1 = L * (sqrtUpper - sqrtLower); }
  else { amount0 = L * (sqrtUpper - sqrtCurrent) / (sqrtUpper * sqrtCurrent); amount1 = L * (sqrtCurrent - sqrtLower); }
  return { amount0, amount1 };
}

async function main() {
  const jsonPath = process.argv[2];
  const { uniqueRows } = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  console.error(`Loaded ${uniqueRows.length} positions from ${jsonPath}`);

  const realRows = uniqueRows.filter((r) => !BURN_ADDRESSES.has(r.owner));
  console.error(`${uniqueRows.length - realRows.length} positions excluded as burned/closed (owner is 0x0 or 0xdead).`);

  // Per-pool: get token0/token1/slot0 once.
  const poolAddrs = [...new Set(realRows.map((r) => r.poolAddr))];
  const poolInfo = new Map();
  for (const pool of poolAddrs) {
    const token0 = addressFromWord((await ethCall(pool, "0x0dfe1681")).slice(2));
    const slot0Raw = await ethCall(pool, "0x3850c7bd");
    const w = wordsOf(slot0Raw.slice(2));
    const sqrtPriceX96 = BigInt("0x" + w[0]);
    const currentTick = Number(asSigned(w[1].slice(-6), 24));
    const gdIsToken0 = token0 === GD_TOKEN;
    poolInfo.set(pool, { gdIsToken0, sqrtPriceX96, currentTick });
    console.error(`Pool ${pool}: gdIsToken0=${gdIsToken0} currentTick=${currentTick}`);
  }

  const results = [];
  let processed = 0;
  for (const row of realRows) {
    const idHex = BigInt(row.tokenId).toString(16).padStart(64, "0");
    const posRaw = await ethCall(row.nfpm, "0x99fbab88" + idHex);
    if (!posRaw) { console.error(`  tokenId ${row.tokenId} on ${row.nfpm}: positions() call failed, skipping`); continue; }
    const w = wordsOf(posRaw.slice(2));
    const tickLower = Number(asSigned(w[5].slice(-6), 24));
    const tickUpper = Number(asSigned(w[6].slice(-6), 24));
    const liquidity = BigInt("0x" + w[7]);
    const tokensOwed0 = BigInt("0x" + w[10]);
    const tokensOwed1 = BigInt("0x" + w[11]);
    const pi = poolInfo.get(row.poolAddr);
    let gdAmount = 0;
    if (liquidity > 0n) {
      const { amount0, amount1 } = amountsForPosition(liquidity, tickLower, tickUpper, pi.currentTick, pi.sqrtPriceX96);
      gdAmount = (pi.gdIsToken0 ? amount0 : amount1) / 1e18;
    }
    // Uncollected trading fees owed to this position (separate from the
    // liquidity itself) -- checking whether this explains the gap between
    // the pool's total balanceOf and the sum of all positions' liquidity.
    const gdFeesOwed = Number(pi.gdIsToken0 ? tokensOwed0 : tokensOwed1) / 1e18;
    results.push({ ...row, tickLower, tickUpper, liquidity: liquidity.toString(), gdAmount, gdFeesOwed });
    processed++;
    if (processed % 25 === 0) console.error(`  processed ${processed}/${realRows.length}`);
  }

  // Aggregate by owner
  const byOwner = new Map();
  for (const r of results) {
    if (!byOwner.has(r.owner)) byOwner.set(r.owner, { owner: r.owner, totalGd: 0, positions: 0, pools: new Set() });
    const o = byOwner.get(r.owner);
    o.totalGd += r.gdAmount;
    o.positions += 1;
    o.pools.add(r.poolName);
  }
  const ownerSummary = [...byOwner.values()]
    .map((o) => ({ owner: o.owner, totalGd: o.totalGd, positions: o.positions, pools: [...o.pools], onList: KNOWN_LIST.has(o.owner), isTreasury: KNOWN_TREASURY.has(o.owner) }))
    .sort((a, b) => b.totalGd - a.totalGd);

  console.error("\n=== TOP 30 OWNERS BY TOTAL V3-POSITION GD ===");
  for (const o of ownerSummary.slice(0, 30)) {
    console.error(`  ${o.owner}: ${o.totalGd.toFixed(2)} GD across ${o.positions} position(s) in [${o.pools.join(", ")}] -- onList=${o.onList} isTreasury=${o.isTreasury}`);
  }

  const totalGdAllPositions = results.reduce((s, r) => s + r.gdAmount, 0);
  const totalGdFeesOwed = results.reduce((s, r) => s + r.gdFeesOwed, 0);
  const totalGdNotOnList = ownerSummary.filter((o) => !o.onList && !o.isTreasury).reduce((s, o) => s + o.totalGd, 0);
  const totalGdOnList = ownerSummary.filter((o) => o.onList).reduce((s, o) => s + o.totalGd, 0);
  const totalGdTreasury = ownerSummary.filter((o) => o.isTreasury).reduce((s, o) => s + o.totalGd, 0);

  console.error(`\n=== SUMMARY ===`);
  console.error(`Total GD across all ${results.length} live V3 positions: ${totalGdAllPositions.toFixed(2)}`);
  console.error(`Total uncollected GD trading fees owed across all positions: ${totalGdFeesOwed.toFixed(2)}`);
  console.error(`  Held by wallets ALREADY on the reviewed list: ${totalGdOnList.toFixed(2)} GD`);
  console.error(`  Held by the known treasury wallet (0x66582d24): ${totalGdTreasury.toFixed(2)} GD`);
  console.error(`  Held by wallets NOT on the list at all: ${totalGdNotOnList.toFixed(2)} GD  <-- new, previously invisible`);

  fs.writeFileSync(jsonPath + ".gd-amounts.json", JSON.stringify({ generatedAt: new Date().toISOString(), results, ownerSummary, totalGdAllPositions, totalGdOnList, totalGdTreasury, totalGdNotOnList }, null, 2));
  console.error(`\nFull detail written to ${jsonPath}.gd-amounts.json`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
