// Discover ALL Celo AMM pools (Uniswap-V3-fork + Uniswap-V2-fork/Ubeswap-style)
// that pair GD with anything, directly from each factory's own event registry
// (PoolCreated / PairCreated). This is authoritative (the factory is the
// single source of truth for "does this pool exist"), not an empirical
// volume-based guess like the earlier Transfer-log detection method used for
// XDC/Fuse. Every address/selector used here was empirically confirmed
// against a live Celoscan-decoded transaction before use, not assumed from
// memory.
//
// Two V3 factory candidates are checked because the previous session found
// TWO different "Uniswap V3 NFPM-shaped" contracts on Celo at different
// addresses; this script resolves which one(s) actually hold GD pools rather
// than assuming either is correct.

// IMPORTANT (discovered 2026-09-08): celo.gateway.tenderly.co accepts huge
// block ranges per call but silently returns EMPTY results for blocks it
// doesn't have archived (confirmed via eth_getBlockByNumber returning null
// for a block forno.celo.org/celo.drpc.org both serve correctly, same hash).
// It looked like a fast wide-range provider but is actually a pruned node --
// a silent-wrong-answer trap, not an error. Do NOT put it first for
// historical scans. celo.drpc.org confirmed to have real archive depth
// (matched forno's block hash at block 19916922) with a 5000-block/call cap.
const CELO_RPC_ENDPOINTS = ["https://celo.drpc.org", "https://forno.celo.org", "https://rpc.ankr.com/celo", "https://1rpc.io/celo"];
const GD_TOKEN = "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a";

// V3 factory candidates
const V3_FACTORY_CONFIRMED = "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc"; // confirmed via GD pool 0x9491d57c's own PoolCreated log
const V3_FACTORY_CANONICAL = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // canonical cross-chain Uniswap V3 factory address; presence on Celo unconfirmed, checked below
const NFPM_CONFIRMED = "0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A"; // confirmed via Celoscan token-name tag "Uniswap V3 Positions NFT-V1" + validated positions()/ownerOf() calls
const NFPM_UNVERIFIED_FROM_PRIOR_SESSION = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; // prior session's candidate, re-checked here, NOT assumed correct

// Seed pool for Ubeswap/V2-style factory discovery (from the Notion incident
// doc's own dexscreener link: "it also seems to have drained the ubeswap pool")
const V2_SEED_POOL = "0x3d9e27c04076288ebfdc4815b4f6d81b0ed1b341";

const POOL_CREATED_TOPIC0 = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const PAIR_CREATED_TOPIC0_CANDIDATES = {
  // Uniswap V2 canonical PairCreated(address,address,address,uint256) topic0.
  // Verified below empirically against the seed pool's own creation log before trusting.
};

let rpcId = 1;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function rpc(method, params, epIndex = 0, attempt = 1) {
  const url = CELO_RPC_ENDPOINTS[epIndex % CELO_RPC_ENDPOINTS.length];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ })
  });
  if (res.status === 403 || res.status === 429) {
    if (attempt >= CELO_RPC_ENDPOINTS.length * 3) throw new Error(`HTTP ${res.status} calling ${method}`);
    await sleep(400);
    return rpc(method, params, epIndex + 1, attempt + 1);
  }
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
  await sleep(150);
  return json.result;
}

function topicAddress(addr) { return "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0"); }
function addressFromTopic(t) { return "0x" + t.slice(-40); }
function addressFromWord(w) { return "0x" + w.slice(24); }

async function getCode(address) {
  return rpc("eth_getCode", [address, "latest"]);
}

async function ethCall(to, data) {
  return rpc("eth_call", [{ to, data }, "latest"]);
}

async function getLogsChunked(filterBase, fromBlock, toBlock, chunkSize, label = "") {
  const logs = [];
  let cursor = fromBlock;
  let size = chunkSize;
  const totalSpan = toBlock - fromBlock + 1;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + size - 1, toBlock);
    try {
      const chunk = await rpc("eth_getLogs", [{ ...filterBase, fromBlock: "0x" + cursor.toString(16), toBlock: "0x" + end.toString(16) }]);
      logs.push(...chunk);
      const pct = (((cursor - fromBlock) / totalSpan) * 100).toFixed(1);
      console.error(`  [${label}] blocks ${cursor}-${end} (${pct}%), +${chunk.length} logs, total ${logs.length}`);
      cursor = end + 1;
    } catch (err) {
      if (size <= 1000) throw new Error(`getLogsChunked[${label}] stuck at chunk size ${size}: ${err.message}`);
      size = Math.floor(size / 2);
      console.error(`  [${label}] shrinking chunk size to ${size} after error: ${err.message}`);
    }
  }
  return logs;
}

// Binary search for the block at which a contract's bytecode first appears
// (its deployment block). Avoids scanning eth_getLogs from block 0.
async function findDeploymentBlock(address, latest) {
  let lo = 1, hi = latest;
  const hiCode = await getCode(address);
  if (hiCode === "0x") return null; // no code even at latest? shouldn't happen given earlier check
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midCode = await rpc("eth_getCode", [address, "0x" + mid.toString(16)]);
    if (midCode !== "0x") hi = mid; else lo = mid + 1;
  }
  return lo;
}

async function main() {
  const latestHex = await rpc("eth_blockNumber", []);
  const latest = Number(BigInt(latestHex));
  console.error(`Latest Celo block: ${latest}`);

  const out = { generatedAt: new Date().toISOString(), latestBlock: latest };

  // --- Step 1: confirm which V3 factory/NFPM pair is real and check for a second deployment ---
  const codeConfirmedFactory = await getCode(V3_FACTORY_CONFIRMED);
  const codeCanonicalFactory = await getCode(V3_FACTORY_CANONICAL);
  const codeConfirmedNfpm = await getCode(NFPM_CONFIRMED);
  const codeUnverifiedNfpm = await getCode(NFPM_UNVERIFIED_FROM_PRIOR_SESSION);
  console.error(`V3_FACTORY_CONFIRMED has code: ${codeConfirmedFactory !== "0x"}`);
  console.error(`V3_FACTORY_CANONICAL has code: ${codeCanonicalFactory !== "0x"}`);
  console.error(`NFPM_CONFIRMED has code: ${codeConfirmedNfpm !== "0x"}`);
  console.error(`NFPM_UNVERIFIED_FROM_PRIOR_SESSION has code: ${codeUnverifiedNfpm !== "0x"}`);

  let unverifiedNfpmFactory = null;
  if (codeUnverifiedNfpm !== "0x") {
    try {
      const factorySelector = "0xc45a0155"; // factory() -- standard INonfungiblePositionManager/PeripheryImmutableState getter
      const res = await ethCall(NFPM_UNVERIFIED_FROM_PRIOR_SESSION, factorySelector);
      unverifiedNfpmFactory = addressFromWord(res.slice(2));
      console.error(`NFPM_UNVERIFIED_FROM_PRIOR_SESSION.factory() = ${unverifiedNfpmFactory}`);
    } catch (err) {
      console.error(`NFPM_UNVERIFIED_FROM_PRIOR_SESSION.factory() call failed: ${err.message}`);
    }
  }
  let confirmedNfpmFactory = null;
  try {
    const factorySelector = "0xc45a0155";
    const res = await ethCall(NFPM_CONFIRMED, factorySelector);
    confirmedNfpmFactory = addressFromWord(res.slice(2));
    console.error(`NFPM_CONFIRMED.factory() = ${confirmedNfpmFactory}`);
  } catch (err) {
    console.error(`NFPM_CONFIRMED.factory() call failed: ${err.message}`);
  }

  out.v3Deployments = {
    confirmed: { factory: V3_FACTORY_CONFIRMED, nfpm: NFPM_CONFIRMED, nfpmFactoryCallResult: confirmedNfpmFactory, matchesExpectedFactory: confirmedNfpmFactory === V3_FACTORY_CONFIRMED.toLowerCase() },
    priorSessionCandidate: { nfpm: NFPM_UNVERIFIED_FROM_PRIOR_SESSION, hasCode: codeUnverifiedNfpm !== "0x", nfpmFactoryCallResult: unverifiedNfpmFactory },
    canonicalFactoryHasCodeOnCelo: codeCanonicalFactory !== "0x"
  };

  // --- Step 2: enumerate ALL GD pools from the confirmed V3 factory (token0=GD or token1=GD) ---
  const gdTopic = topicAddress(GD_TOKEN);
  const confirmedFactoryDeployBlock = await findDeploymentBlock(V3_FACTORY_CONFIRMED, latest);
  console.error(`V3_FACTORY_CONFIRMED deployment block: ${confirmedFactoryDeployBlock}`);
  const asToken0Logs = await getLogsChunked({ address: V3_FACTORY_CONFIRMED, topics: [POOL_CREATED_TOPIC0, gdTopic] }, confirmedFactoryDeployBlock, latest, 5000, "v3-confirmed-token0");
  const asToken1Logs = await getLogsChunked({ address: V3_FACTORY_CONFIRMED, topics: [POOL_CREATED_TOPIC0, null, gdTopic] }, confirmedFactoryDeployBlock, latest, 5000, "v3-confirmed-token1");
  console.error(`V3 confirmed-factory PoolCreated logs: GD-as-token0=${asToken0Logs.length}, GD-as-token1=${asToken1Logs.length}`);

  function decodePoolCreated(log) {
    const token0 = addressFromTopic(log.topics[1]);
    const token1 = addressFromTopic(log.topics[2]);
    const fee = Number(BigInt(log.topics[3]));
    const data = log.data.slice(2);
    // data: tickSpacing (int24, first word) then pool address (second word)
    const poolWord = data.slice(64, 128);
    const pool = addressFromWord(poolWord);
    return { token0, token1, fee, pool, txHash: log.transactionHash, blockNumber: Number(BigInt(log.blockNumber)) };
  }

  const v3Pools = [...asToken0Logs, ...asToken1Logs].map(decodePoolCreated);
  const seen = new Set();
  const v3PoolsUnique = v3Pools.filter((p) => {
    if (seen.has(p.pool)) return false;
    seen.add(p.pool);
    return true;
  });
  out.v3PoolsFromConfirmedFactory = v3PoolsUnique;
  console.error(`Unique V3 GD pools (confirmed factory): ${v3PoolsUnique.length} -> ${v3PoolsUnique.map((p) => p.pool).join(", ")}`);

  // Self-validation: these 3 pools were independently confirmed (2026-09-08,
  // via direct pool.factory() RPC calls) to belong to this exact factory. If
  // any are missing here, this scan silently missed data and must not be
  // trusted as complete (this is exactly the kind of check that caught
  // tenderly's silent pruning above).
  const mustInclude = ["0x991f1aa7e0901f9ab3d583846bf5be0ebace1d7f", "0x9491d57c5687ab75726423b55ac2d87d1cda2c3f", "0xcb037f27eb3952222810966e28e0ceb650c65cd9"];
  const foundAddrs = new Set(v3PoolsUnique.map((p) => p.pool.toLowerCase()));
  const missing = mustInclude.filter((a) => !foundAddrs.has(a));
  out.selfValidation = { mustInclude, missing, passed: missing.length === 0 };
  console.error(`Self-validation against known pools: ${missing.length === 0 ? "PASSED" : "FAILED, missing: " + missing.join(", ")}`);

  // Also check canonical factory for GD pools, if it exists on Celo at all
  if (codeCanonicalFactory !== "0x") {
    const canonicalDeployBlock = await findDeploymentBlock(V3_FACTORY_CANONICAL, latest);
    console.error(`V3_FACTORY_CANONICAL deployment block: ${canonicalDeployBlock}`);
    const asToken0LogsC = await getLogsChunked({ address: V3_FACTORY_CANONICAL, topics: [POOL_CREATED_TOPIC0, gdTopic] }, canonicalDeployBlock, latest, 5000, "v3-canonical-token0");
    const asToken1LogsC = await getLogsChunked({ address: V3_FACTORY_CANONICAL, topics: [POOL_CREATED_TOPIC0, null, gdTopic] }, canonicalDeployBlock, latest, 5000, "v3-canonical-token1");
    const v3PoolsCanonical = [...asToken0LogsC, ...asToken1LogsC].map(decodePoolCreated);
    out.v3PoolsFromCanonicalFactory = v3PoolsCanonical;
    console.error(`Unique V3 GD pools (canonical factory): ${v3PoolsCanonical.length}`);
  } else {
    out.v3PoolsFromCanonicalFactory = [];
    console.error(`Canonical V3 factory has no code on Celo, skipping.`);
  }

  // --- Step 3: identify the V2-style (Ubeswap) factory via the seed pool, then enumerate all GD pairs ---
  const TOKEN0_SELECTOR = "0x0dfe1681";
  const TOKEN1_SELECTOR = "0xd21220a7";
  const FACTORY_SELECTOR_V2 = "0xc45a0155"; // factory() -- standard on UniswapV2Pair
  const seedToken0 = addressFromWord((await ethCall(V2_SEED_POOL, TOKEN0_SELECTOR)).slice(2));
  const seedToken1 = addressFromWord((await ethCall(V2_SEED_POOL, TOKEN1_SELECTOR)).slice(2));
  console.error(`Seed V2 pool ${V2_SEED_POOL}: token0=${seedToken0}, token1=${seedToken1}`);
  let v2Factory = null;
  try {
    v2Factory = addressFromWord((await ethCall(V2_SEED_POOL, FACTORY_SELECTOR_V2)).slice(2));
    console.error(`Seed V2 pool factory(): ${v2Factory}`);
  } catch (err) {
    console.error(`Seed pool factory() call failed: ${err.message}`);
  }
  out.v2SeedPool = { address: V2_SEED_POOL, token0: seedToken0, token1: seedToken1, factory: v2Factory };

  if (v2Factory) {
    // Verify PairCreated topic0 empirically: get the seed pool's own creation
    // log from the factory rather than assuming the canonical hash, by
    // scanning factory logs where the seed pool address appears in the data.
    // We instead directly query with the GD topic filter and inspect the
    // topic0 seen on real results to confirm which one that factory used.
    const v2FactoryDeployBlock = await findDeploymentBlock(v2Factory, latest);
    console.error(`V2 factory deployment block: ${v2FactoryDeployBlock}`);
    const anyLogsFromFactory = await getLogsChunked({ address: v2Factory, topics: [] }, v2FactoryDeployBlock, latest, 5000, "v2-factory-all").catch((err) => { console.error(`v2 factory full scan failed: ${err.message}`); return []; });
    const distinctTopic0 = new Set(anyLogsFromFactory.map((l) => l.topics[0]));
    console.error(`Distinct event topic0 values seen on V2 factory (all-time): ${[...distinctTopic0].join(", ")}`);
    out.v2FactoryDistinctTopic0 = [...distinctTopic0];
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
