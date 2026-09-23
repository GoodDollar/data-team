// Live re-check of every wallet on the reviewed Celo+XDC list, plain
// balanceOf only (fast, no history scan). Confirms which recorded figures
// have drifted as of the moment a report is finalized, and timestamps the
// whole list with a real block number so it is independently reproducible.
//
// The wallet list is loaded from the local-only _wallet-list.json -- see
// wallet-list.example.json for the shape.

import { loadWalletList } from "./wallet-list.mjs";

const CELO_RPC_ENDPOINTS = ["https://forno.celo.org", "https://celo.drpc.org", "https://rpc.ankr.com/celo", "https://1rpc.io/celo"];
const XDC_RPC_ENDPOINTS = ["https://rpc.xinfin.network", "https://erpc.xinfin.network", "https://rpc.ankr.com/xdc", "https://xdc.public-rpc.com"];
const GD_CELO = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";
const GD_XDC = "0xec2136843a983885aebf2feb3931f73a8ebee50c";

const { celo: CELO_WALLETS, xdc: XDC_WALLETS, watch: WATCH_WALLETS } = loadWalletList();

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
  for (const { address: addr, listedHeld, note } of CELO_WALLETS) {
    const current = await balanceOf(CELO_RPC_ENDPOINTS, GD_CELO, addr);
    const delta = current - listedHeld;
    const pctChange = listedHeld > 0 ? (delta / listedHeld * 100) : null;
    celoResults.push({ address: addr, listedHeld, currentHeld: current, delta, pctChange, note });
    console.error(`  Celo ${addr}: listed=${listedHeld} current=${current.toFixed(2)} delta=${delta.toFixed(2)} (${pctChange !== null ? pctChange.toFixed(1) + "%" : "n/a"})`);
  }

  const xdcResults = [];
  for (const { address: addr, listedHeld } of XDC_WALLETS) {
    const current = await balanceOf(XDC_RPC_ENDPOINTS, GD_XDC, addr);
    const delta = current - listedHeld;
    xdcResults.push({ address: addr, listedHeld, currentHeld: current, delta });
    console.error(`  XDC ${addr}: listed=${listedHeld} current=${current.toFixed(2)} delta=${delta.toFixed(2)}`);
  }

  const watchResults = [];
  for (const { address: addr, note } of WATCH_WALLETS) {
    const current = await balanceOf(CELO_RPC_ENDPOINTS, GD_CELO, addr);
    watchResults.push({ address: addr, currentHeldCelo: current, note });
    console.error(`  WATCH ${addr}: current Celo GD=${current.toFixed(2)} (${note})`);
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), celoBlock, xdcBlock, celoResults, xdcResults, watchResults }, null, 2));
}

main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
