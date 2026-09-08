// Live re-check of every wallet currently on the Celo+XDC burn/refund list
// (from _internal/burn-refund-update-2026-09-08.md), plain balanceOf only
// (fast, no history scan). Confirms which figures are stale (e.g. the
// already-known-accelerating 0x22fa3239) as of the moment this report is
// finalized, and timestamps the whole list with a real block number so it is
// independently reproducible.

const CELO_RPC_ENDPOINTS = ["https://forno.celo.org", "https://celo.drpc.org", "https://rpc.ankr.com/celo", "https://1rpc.io/celo"];
const XDC_RPC_ENDPOINTS = ["https://rpc.xinfin.network", "https://erpc.xinfin.network", "https://rpc.ankr.com/xdc", "https://xdc.public-rpc.com"];
const GD_CELO = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";
const GD_XDC = "0xec2136843a983885aebf2feb3931f73a8ebee50c";

const CELO_WALLETS = [
  ["0x22fa3239c4bf43d05cc587ff40ea3ba5841c6709", 33000000, "listed 2026-09-08 update"],
  ["0xa779ce177555284baf953de8a3246ba2444a2d34", 26000000, "listed 2026-09-08 update"],
  ["0x4f649e50680c16c9b73e646e4b396647fd153091", 15000000, ""],
  ["0x62b7fd18f9bc72c8543801b31ce88289264f9869", 12400000, ""],
  ["0xce029f6ee3c8d7e6c9338c04171b895a22428de3", 12200000, ""],
  ["0x288dc841a52fca2707c6947b3a777c5e56cd87bc", 9200000, ""],
  ["0xd7f3596fcf17e68bd7db2537c87cf8a969235c12", 8100000, ""],
  ["0x2973a379b3fb2d869712b9296a7ea2c054426d47", 6700000, ""],
  ["0x93f1f1e11b995a8bd3fe87afc404634ddbcf8624", 6000000, ""],
  ["0x1df536323b382def549cb386fc128efe93e6f24f", 6000000, "LP-position holder in 0x9491d57c per Lewis"],
  ["0xf2fb24a6cedca39b9c514833371aca29512d8a3f", 5500000, ""],
  ["0x7f553faa8f4bbbbd16fe419bf9b5255d3ea01652", 4900000, ""],
  ["0x61dd2ec85e168b4a06ae39b35eebfee8eaebea37", 4600000, ""],
  ["0x9b27ac014671d006000b4546a3fb4796e2073241", 2100000, ""],
  ["0x980abeb0f35db41c6ee67068f981d46de04823c7", 2000000, ""],
  ["0xdedff708684052be37ec7cbe1de2e6e608e9447e", 1500000, ""],
  ["0x8e089f5d70c5d5d1378f656ae74752bf65e00c8e", 1400000, ""],
  ["0xce06ac2d581e80cc6ea4bc28f8bdb91ce887ff25", 1300000, ""],
  ["0x0e9b063789909565ceda1fba162474405a151e66", 963200, ""],
  ["0x0e401c81611424eccd0428f309bcd41ba3057112", 927900, "LP-position holder in 0x9491d57c per Lewis (out of range)"],
  ["0xc96e2cc0de82bbafebbd70c2a30db34e4c419fce", 755000, ""],
  ["0xd824212300be0555df8bb14278c1f25c975d1106", 754500, ""],
  ["0xc151fe0d8dd6b852d75e29e18f4791b2f806f2a6", 561900, ""],
  ["0x83525b2783fb2dccaf7ae5b2551fbd995dd27309", 541700, ""],
  ["0x58d6eb8cd983449dc4fb0d6b173be140dfdb63d0", 332500, ""],
  ["0x7f8946b257ad9a8fa55704120957901741a3346c", 135500, ""],
  ["0x744942ec88d88c4dcc3da48f18e824d765e9a245", 94800, ""],
  ["0x20a15f256f7537da4f707a196f6ddc3e2e8be9da", 19400, ""],
  ["0x55fbeae109d55b911d165a624e99d3e5abdddb54", 16800, ""],
  ["0x2c2b0310adcba409deb2739106a08a05cc4c0a79", 411.8, ""]
];

const XDC_WALLETS = [
  ["0xfa7d15c941da051bc4276ab341d3cb37cc09b73f", 23033.9],
  ["0x61b7b0009fced05695ee811b7f8f78ba37c38344", 18587.1],
  ["0xff3c46ee68f90da6a33303897dbcbd62661c73f1", 7678.6],
  ["0x8675d6b6fcde8db7af5a0ab86de7db0dceba4407", 0]
];

// Additional wallets surfaced during the LP/staking undercounting check,
// checked here for the same live-snapshot consistency even though they are
// not (yet) on the list.
const WATCH_WALLETS = [
  ["0x463dFcbF3b88F3330646648e185475F98235c74F", "LP-position holder in 0x9491d57c per Lewis, NOT currently on the list"],
  ["0x66582d24fead72555adac681cc621cacbb208324", "Hadar/treasury wallet, excluded by policy"]
];

let rpcId = 1;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function rpc(endpoints, method, params, epIndex = 0, attempt = 1) {
  const url = endpoints[epIndex % endpoints.length];
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ }) });
  if (!res.ok) { if (attempt >= endpoints.length * 4) throw new Error(`HTTP ${res.status}`); await sleep(300); return rpc(endpoints, method, params, epIndex + 1, attempt + 1); }
  const json = await res.json();
  if (json.error) { if (attempt >= endpoints.length * 4) throw new Error(json.error.message); await sleep(300); return rpc(endpoints, method, params, epIndex + 1, attempt + 1); }
  await sleep(100);
  return json.result;
}
async function balanceOf(endpoints, token, holder) {
  const padded = holder.replace("0x", "").padStart(64, "0");
  const res = await rpc(endpoints, "eth_call", [{ to: token, data: "0x70a08231" + padded }, "latest"]);
  return Number(BigInt(res)) / 1e18;
}

async function main() {
  const celoBlock = Number(BigInt(await rpc(CELO_RPC_ENDPOINTS, "eth_blockNumber", [])));
  const xdcBlock = Number(BigInt(await rpc(XDC_RPC_ENDPOINTS, "eth_blockNumber", [])));
  console.error(`Celo block: ${celoBlock}, XDC block: ${xdcBlock}`);

  const celoResults = [];
  for (const [addr, listedHeld, note] of CELO_WALLETS) {
    const current = await balanceOf(CELO_RPC_ENDPOINTS, GD_CELO, addr);
    const delta = current - listedHeld;
    const pctChange = listedHeld > 0 ? (delta / listedHeld * 100) : null;
    celoResults.push({ address: addr, listedHeld, currentHeld: current, delta, pctChange, note });
    console.error(`  Celo ${addr}: listed=${listedHeld} current=${current.toFixed(2)} delta=${delta.toFixed(2)} (${pctChange !== null ? pctChange.toFixed(1) + "%" : "n/a"})`);
  }

  const xdcResults = [];
  for (const [addr, listedHeld] of XDC_WALLETS) {
    const current = await balanceOf(XDC_RPC_ENDPOINTS, GD_XDC, addr);
    const delta = current - listedHeld;
    xdcResults.push({ address: addr, listedHeld, currentHeld: current, delta });
    console.error(`  XDC ${addr}: listed=${listedHeld} current=${current.toFixed(2)} delta=${delta.toFixed(2)}`);
  }

  const watchResults = [];
  for (const [addr, note] of WATCH_WALLETS) {
    const current = await balanceOf(CELO_RPC_ENDPOINTS, GD_CELO, addr);
    watchResults.push({ address: addr, currentHeldCelo: current, note });
    console.error(`  WATCH ${addr}: current Celo GD=${current.toFixed(2)} (${note})`);
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), celoBlock, xdcBlock, celoResults, xdcResults, watchResults }, null, 2));
}

main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
