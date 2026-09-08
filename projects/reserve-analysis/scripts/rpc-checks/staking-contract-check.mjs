// Identify what 0xF42C9Ca2b10010142e2bAc34eBdDDB0b82177684 actually is (Lewis
// asked directly, unresolved: "we dont have governance on celo?"), and cross-
// reference every address that has ever interacted with it against the
// current burn/refund list. Method names visible on Celoscan ("Stake And
// Register", "Increase Power", "Unregister Member") suggest a delegate/
// voting-power staking registry, not a GD-locking vault in the LP sense --
// checked here rather than assumed.

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

// Known burn/refund-list wallets (Celo side), for cross-reference.
const KNOWN_LIST_WALLETS = new Set([
  "0x22fa3239c4bf43d05cc587ff40ea3ba5841c6709", "0xa779ce177555284baf953de8a3246ba2444a2d34",
  "0x4f649e50680c16c9b73e646e4b396647fd153091", "0x62b7fd18f9bc72c8543801b31ce88289264f9869",
  "0xce029f6ee3c8d7e6c9338c04171b895a22428de3", "0x288dc841a52fca2707c6947b3a777c5e56cd87bc",
  "0xd7f3596fcf17e68bd7db2537c87cf8a969235c12", "0x2973a379b3fb2d869712b9296a7ea2c054426d47",
  "0x93f1f1e11b995a8bd3fe87afc404634ddbcf8624", "0x1df536323b382def549cb386fc128efe93e6f24f",
  "0xf2fb24a6cedca39b9c514833371aca29512d8a3f", "0x7f553faa8f4bbbbd16fe419bf9b5255d3ea01652",
  "0x61dd2ec85e168b4a06ae39b35eebfee8eaebea37", "0x9b27ac014671d006000b4546a3fb4796e2073241",
  "0x980abeb0f35db41c6ee67068f981d46de04823c7", "0xdedff708684052be37ec7cbe1de2e6e608e9447e",
  "0x8e089f5d70c5d5d1378f656ae74752bf65e00c8e", "0xce06ac2d581e80cc6ea4bc28f8bdb91ce887ff25",
  "0x0e9b063789909565ceda1fba162474405a151e66", "0x0e401c81611424eccd0428f309bcd41ba3057112",
  "0xc96e2cc0de82bbafebbd70c2a30db34e4c419fce", "0xd824212300be0555df8bb14278c1f25c975d1106",
  "0xc151fe0d8dd6b852d75e29e18f4791b2f806f2a6", "0x83525b2783fb2dccaf7ae5b2551fbd995dd27309",
  "0x58d6eb8cd983449dc4fb0d6b173be140dfdb63d0", "0x7f8946b257ad9a8fa55704120957901741a3346c",
  "0x744942ec88d88c4dcc3da48f18e824d765e9a245", "0x20a15f256f7537da4f707a196f6ddc3e2e8be9da",
  "0x55fbeae109d55b911d165a624e99d3e5abdddb54", "0x2c2b0310adcba409deb2739106a08a05cc4c0a79",
  "0x463dfcbf3b88f3330646648e185475f98235c74f" // watch wallet, not on the list yet
]);

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
  console.error(`Overlap with current burn/refund list / watch wallets: ${overlap.length} -> ${overlap.join(", ")}`);

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
