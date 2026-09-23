// Identify what 0xF42C9Ca2b10010142e2bAc34eBdDDB0b82177684 actually is, and
// cross-reference every address that has ever interacted with it against the
// current reviewed list. Method names visible on Celoscan ("Stake And
// Register", "Increase Power", "Unregister Member") suggest a delegate/
// voting-power staking registry, not a GD-locking vault in the LP sense --
// checked here rather than assumed.

import { loadWalletList } from "./wallet-list.mjs";

const CELO_RPC_ENDPOINTS = ["https://celo.drpc.org", "https://forno.celo.org", "https://rpc.ankr.com/celo"];
const GD_TOKEN = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";
const CONTRACT = "0xF42C9Ca2b10010142e2bAc34eBdDDB0b82177684";

let rpcId = 1;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function rpc(method, params, epIndex = 0, attempt = 1) {
  const url = CELO_RPC_ENDPOINTS[epIndex % CELO_RPC_ENDPOINTS.length];
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ }) });
  if (!res.ok) { if (attempt >= CELO_RPC_ENDPOINTS.length * 4) throw new Error(`HTTP ${res.status}`); await sleep(300); return rpc(method, params, epIndex + 1, attempt + 1); }
  const json = await res.json();
  if (json.error) { if (attempt >= CELO_RPC_ENDPOINTS.length * 4) throw new Error(json.error.message); await sleep(300); return rpc(method, params, epIndex + 1, attempt + 1); }
  await sleep(100);
  return json.result;
}
function toHexBlock(n) { return "0x" + n.toString(16); }

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
      if (size <= 500) throw new Error(`stuck at chunk size ${size}: ${err.message}`);
      size = Math.floor(size / 2);
      console.error(`  [${label}] shrinking chunk size to ${size} after error: ${err.message}`);
    }
  }
  return logs;
}

async function ethCall(to, data) {
  try { const r = await rpc("eth_call", [{ to, data }, "latest"]); return (!r || r === "0x") ? null : r; } catch { return null; }
}
function addressFromWord(w) { return "0x" + w.slice(24); }

// Reviewed-list wallets (Celo side) plus watch wallets, for cross-reference.
// Loaded from the local-only _wallet-list.json -- see wallet-list.example.json.
const KNOWN_LIST_WALLETS = new Set(
  [...loadWalletList().celo, ...loadWalletList().watch].map((w) => w.address.toLowerCase())
);

async function main() {
  const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
  console.error(`Latest block: ${latest}`);
  const deployBlock = await findDeploymentBlock(CONTRACT, latest);
  console.error(`Contract deployment block: ${deployBlock}`);

  const gdBalanceRaw = BigInt(await ethCall(GD_TOKEN, "0x70a08231" + CONTRACT.replace("0x", "").padStart(64, "0")));
  console.error(`Contract's current GD balance: ${Number(gdBalanceRaw) / 1e18}`);

  const allLogs = await getLogsChunked({ address: CONTRACT, topics: [] }, deployBlock, latest, 5000, "staking-contract-all");
  console.error(`Total events: ${allLogs.length}`);

  const distinctTopic0 = new Map();
  for (const log of allLogs) {
    distinctTopic0.set(log.topics[0], (distinctTopic0.get(log.topics[0]) || 0) + 1);
  }
  console.error(`Distinct event signatures (topic0 -> count):`);
  for (const [t0, count] of distinctTopic0.entries()) console.error(`  ${t0}: ${count}`);

  // Collect every unique address appearing in any indexed topic (heuristic:
  // any 32-byte topic whose top 12 bytes are zero looks like an address).
  const candidateAddresses = new Set();
  for (const log of allLogs) {
    for (const topic of log.topics.slice(1)) {
      if (topic.slice(2, 26) === "000000000000000000000000") {
        candidateAddresses.add("0x" + topic.slice(-40));
      }
    }
  }
  console.error(`Unique candidate addresses referenced in events: ${candidateAddresses.size}`);

  const overlap = [...candidateAddresses].filter((a) => KNOWN_LIST_WALLETS.has(a.toLowerCase()));
  console.error(`Overlap with current reviewed list / watch wallets: ${overlap.length} -> ${overlap.join(", ")}`);

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    contract: CONTRACT,
    deployBlock,
    contractGdBalance: Number(gdBalanceRaw) / 1e18,
    totalEvents: allLogs.length,
    distinctTopic0: Object.fromEntries(distinctTopic0),
    uniqueCandidateAddresses: candidateAddresses.size,
    allCandidateAddresses: [...candidateAddresses],
    overlapWithKnownList: overlap
  }, null, 2));
}

main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
