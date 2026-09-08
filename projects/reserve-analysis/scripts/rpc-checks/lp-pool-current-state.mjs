// Current-state check for the 9 known Celo GD pools (from
// queries/dune/reserve-analysis/wallet-cost-list.sql, cross-validated against
// an independent "9 active GD pools" finding from an earlier RPC pass). For
// each pool: confirm token0/token1 live via RPC (never trust the SQL
// comment's labels alone), classify V2-style (Ubeswap, ERC20 LP token) vs
// V3-style (Uniswap fork, NFT positions) via which selectors respond, and
// report current GD balance held by the pool contract itself (the amount
// that is NOT visible to a simple per-wallet balanceOf scan).

const CELO_RPC_ENDPOINTS = ["https://celo.drpc.org", "https://rpc.ankr.com/celo", "https://forno.celo.org", "https://1rpc.io/celo"];
const GD_TOKEN = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";

const KNOWN_POOLS = [
  { address: "0x991f1aa7e0901f9ab3d583846bf5be0ebace1d7f", labelFromSql: "Uniswap V3 GD/USDGLO" },
  { address: "0x3d9e27c04076288ebfdc4815b4f6d81b0ed1b341", labelFromSql: "Ubeswap GD/USDGLO" },
  { address: "0x9491d57c5687ab75726423b55ac2d87d1cda2c3f", labelFromSql: "Uniswap V3 GD/cUSD" },
  { address: "0x31f9dee850b4284b81b52b25a3194f2fc8ff18cf", labelFromSql: "Ubeswap GD/cUSD" },
  { address: "0x07f86b39728be613062bc7413fc2ca7293eef022", labelFromSql: "Ubeswap GD/mcUSD" },
  { address: "0x25878951ae130014e827e6f54fd3b4cca057a7e8", labelFromSql: "Ubeswap GD/CELO" },
  { address: "0xcb037f27eb3952222810966e28e0ceb650c65cd9", labelFromSql: "Uniswap V3 GD/CELO" },
  { address: "0x8b393470bef8bb27a9a5169531b4eba5209b0b26", labelFromSql: "Ubeswap GD/CELO 0.3%" },
  { address: "0xa0bef7ff637c10b9ec67a00687b4d4364a7f1c55", labelFromSql: "GD/PACT" },
  // Additional candidates mentioned live in the crisis-management Slack
  // thread (2026-09-08) not present in the SQL file, checked for existence:
  { address: "0x784d8d96d0e0859ec534ef5d70522c890d5da23b", labelFromSql: "Lewis-mentioned G$/USDM position (unverified, checked here)" }
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
    if (attempt >= CELO_RPC_ENDPOINTS.length * 3) throw new Error(`HTTP ${res.status} calling ${method}`);
    await sleep(300);
    return rpc(method, params, epIndex + 1, attempt + 1);
  }
  const json = await res.json();
  if (json.error) {
    if (attempt >= CELO_RPC_ENDPOINTS.length * 3) throw new Error(`RPC error calling ${method}: ${json.error.message}`);
    await sleep(300);
    return rpc(method, params, epIndex + 1, attempt + 1);
  }
  await sleep(120);
  return json.result;
}

function addressFromWord(w) { return "0x" + w.slice(24); }
async function ethCall(to, data) {
  try {
    const res = await rpc("eth_call", [{ to, data }, "latest"]);
    return res;
  } catch (err) {
    return null;
  }
}

const SELECTORS = {
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  fee: "0xddca3f43",
  factory: "0xc45a0155",
  totalSupply: "0x18160ddd",
  symbol: "0x95d89b41",
  balanceOf: "0x70a08231"
};

async function symbolOf(token) {
  const res = await ethCall(token, SELECTORS.symbol);
  if (!res || res === "0x") return "UNKNOWN";
  try {
    const bytes = Buffer.from(res.slice(2), "hex");
    if (bytes.length === 32) {
      // bytes32-style symbol (not dynamic string)
      return bytes.toString("utf8").replace(/\0/g, "").trim() || "UNKNOWN";
    }
    return bytes.slice(64).toString("utf8").replace(/\0/g, "").trim() || "UNKNOWN";
  } catch { return "UNKNOWN"; }
}

async function balanceOf(token, holder) {
  const padded = holder.replace("0x", "").padStart(64, "0");
  const res = await ethCall(token, SELECTORS.balanceOf + padded);
  if (!res || res === "0x") return null;
  return Number(BigInt(res)) / 1e18;
}

async function main() {
  const latestHex = await rpc("eth_blockNumber", []);
  const latest = Number(BigInt(latestHex));
  console.error(`Latest Celo block: ${latest}`);

  const results = [];
  for (const pool of KNOWN_POOLS) {
    console.error(`Checking ${pool.address} (${pool.labelFromSql})...`);
    const codeRes = await rpc("eth_getCode", [pool.address, "latest"]);
    if (codeRes === "0x") {
      results.push({ ...pool, exists: false });
      console.error(`  no code at this address, skipping`);
      continue;
    }
    const token0Raw = await ethCall(pool.address, SELECTORS.token0);
    const token1Raw = await ethCall(pool.address, SELECTORS.token1);
    const token0 = token0Raw && token0Raw !== "0x" ? addressFromWord(token0Raw.slice(2)) : null;
    const token1 = token1Raw && token1Raw !== "0x" ? addressFromWord(token1Raw.slice(2)) : null;
    const feeRaw = await ethCall(pool.address, SELECTORS.fee);
    const isV3Shaped = feeRaw && feeRaw !== "0x" && feeRaw.length === 66;
    const factoryRaw = await ethCall(pool.address, SELECTORS.factory);
    const factory = factoryRaw && factoryRaw !== "0x" ? addressFromWord(factoryRaw.slice(2)) : null;
    const totalSupplyRaw = await ethCall(pool.address, SELECTORS.totalSupply);
    const hasTotalSupply = totalSupplyRaw && totalSupplyRaw !== "0x";

    const involvesGd = [token0, token1].filter(Boolean).some((t) => t.toLowerCase() === GD_TOKEN);
    const pairedToken = involvesGd ? [token0, token1].find((t) => t && t.toLowerCase() !== GD_TOKEN) : null;
    const pairedSymbol = pairedToken ? await symbolOf(pairedToken) : null;

    const gdBalance = await balanceOf(GD_TOKEN, pool.address);

    // Classification: V3 pools expose fee() as a uint24 AND do not behave as
    // a standard ERC20 (no meaningful totalSupply representing LP shares in
    // the way V2 pairs do -- V3 pools have no LP token at all, ownership is
    // externalized to NFT positions in the NFPM). V2-style pairs expose
    // totalSupply() (the LP token supply) and typically no fee() getter.
    const kind = isV3Shaped ? "v3-style (NFT positions via NFPM)" : (hasTotalSupply ? "v2-style (ERC20 LP token)" : "unknown");

    results.push({
      ...pool,
      exists: true,
      token0, token1, involvesGd, pairedToken, pairedSymbol,
      feeRaw, isV3Shaped, factory, hasTotalSupply, kind,
      gdBalance
    });
    console.error(`  token0=${token0} token1=${token1} involvesGd=${involvesGd} paired=${pairedSymbol} kind=${kind} gdBalance=${gdBalance}`);
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), latestBlock: latest, pools: results }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
