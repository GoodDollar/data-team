const GD = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";
const STAKING = "0xF42C9Ca2b10010142e2bAc34eBdDDB0b82177684";
const ENDPOINTS = ["https://forno.celo.org", "https://celo.drpc.org", "https://rpc.ankr.com/celo", "https://1rpc.io/celo"];

let rpcId = 1;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function rpc(method, params, epIndex = 0, attempt = 1) {
  const url = ENDPOINTS[epIndex % ENDPOINTS.length];
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ }) });
  if (!res.ok) { if (attempt >= ENDPOINTS.length * 4) throw new Error(`HTTP ${res.status}`); await sleep(300); return rpc(method, params, epIndex + 1, attempt + 1); }
  const json = await res.json();
  if (json.error) { if (attempt >= ENDPOINTS.length * 4) throw new Error(json.error.message); await sleep(300); return rpc(method, params, epIndex + 1, attempt + 1); }
  await sleep(120);
  return json.result;
}
async function balanceOf(holder) {
  const padded = holder.replace("0x", "").padStart(64, "0");
  const res = await rpc("eth_call", [{ to: GD, data: "0x70a08231" + padded }, "latest"]);
  return Number(BigInt(res)) / 1e18;
}

const WATCH = [
  ["0x0e401c81611424eccd0428f309bcd41ba3057112", "headline correction #1 (LP)"],
  ["0x83525b2783fb2dccaf7ae5b2551fbd995dd27309", "headline correction #2 (staking)"],
  ["0x1df536323b382def549cb386fc128efe93e6f24f", "headline correction #3 (LP+staking)"],
  ["0x0e9b063789909565ceda1fba162474405a151e66", "headline correction #4 (staking, but net down)"],
  ["0x463dfcbf3b88f3330646648e185475f98235c74f", "largest entirely-missing wallet (0xmoti.eth)"],
  ["0x22fa3239c4bf43d05cc587ff40ea3ba5841c6709", "largest listed wallet, sanity check"],
  ["0xF42C9Ca2b10010142e2bAc34eBdDDB0b82177684", "staking contract itself"],
  ["0x9491d57c5687ab75726423b55ac2d87d1cda2c3f", "pool GD/cUSD (largest)"],
  ["0x3d9e27c04076288ebfdc4815b4f6d81b0ed1b341", "pool GD/USDGLO (2nd)"],
  ["0xcb037f27eb3952222810966e28e0ceb650c65cd9", "pool GD/CELO (V3)"],
  ["0x991f1aa7e0901f9ab3d583846bf5be0ebace1d7f", "pool GD/USDGLO (V3)"],
  ["0x8b393470bef8bb27a9a5169531b4eba5209b0b26", "pool GD/CELO 0.3%"],
];

async function main() {
  const block = Number(BigInt(await rpc("eth_blockNumber", [])));
  const nowIso = new Date().toISOString();
  console.log(`FRESH SNAPSHOT at block ${block}, ${nowIso}`);
  for (const [addr, label] of WATCH) {
    const bal = await balanceOf(addr);
    console.log(`${addr}  ${bal.toFixed(2).padStart(18)}  ${label}`);
  }
}
main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
