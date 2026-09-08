// Parses the noisy, paginated Dune UI text export (copy-pasted across 14
// pages, headers/pagination controls interleaved between data blocks) into
// clean rows, then aggregates by current_owner and cross-references against
// the existing burn/refund list wallets.
import fs from "node:fs";

const raw = fs.readFileSync(process.argv[2], "utf16le").length > 0
  ? fs.readFileSync(process.argv[2], "utf8")
  : fs.readFileSync(process.argv[2], "utf8");
const lines = raw.split(/\r?\n/).map((l) => l.trim());

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const INT_RE = /^\d+$/;

const rows = [];
for (let i = 0; i < lines.length - 4; i++) {
  const [poolName, poolAddr, nfpm, tokenId, owner] = lines.slice(i, i + 5);
  if (
    poolAddr && ADDR_RE.test(poolAddr) &&
    nfpm && ADDR_RE.test(nfpm) &&
    tokenId && INT_RE.test(tokenId) &&
    owner && ADDR_RE.test(owner) &&
    poolName && !ADDR_RE.test(poolName) && !INT_RE.test(poolName)
  ) {
    rows.push({ poolName, poolAddr: poolAddr.toLowerCase(), nfpm: nfpm.toLowerCase(), tokenId, owner: owner.toLowerCase() });
  }
}

// Dedupe (the paginated export can repeat a boundary row across two page
// screenshots/copies)
const seen = new Set();
const uniqueRows = rows.filter((r) => {
  const key = `${r.poolAddr}|${r.tokenId}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.error(`Parsed ${rows.length} raw row-matches, ${uniqueRows.length} unique (pool, tokenId) positions.`);

const byPool = new Map();
for (const r of uniqueRows) {
  if (!byPool.has(r.poolAddr)) byPool.set(r.poolAddr, { poolName: r.poolName, count: 0 });
  byPool.get(r.poolAddr).count++;
}
console.error("Positions found per pool:");
for (const [addr, info] of byPool.entries()) console.error(`  ${info.poolName} (${addr}): ${info.count} positions`);

const byOwner = new Map();
for (const r of uniqueRows) {
  if (!byOwner.has(r.owner)) byOwner.set(r.owner, []);
  byOwner.get(r.owner).push(r);
}

const KNOWN_LIST = new Set([
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
  "0x55fbeae109d55b911d165a624e99d3e5abdddb54", "0x2c2b0310adcba409deb2739106a08a05cc4c0a79"
]);
const KNOWN_TREASURY = new Set(["0x66582d24fead72555adac681cc621cacbb208324"]);

console.error(`\nUnique owners across all V3 positions: ${byOwner.size}`);
const ownerRows = [...byOwner.entries()].map(([owner, positions]) => ({
  owner,
  positionCount: positions.length,
  pools: [...new Set(positions.map((p) => p.poolName))],
  onList: KNOWN_LIST.has(owner),
  isTreasury: KNOWN_TREASURY.has(owner)
})).sort((a, b) => b.positionCount - a.positionCount);

console.error("\nTop owners by position count:");
for (const o of ownerRows.slice(0, 40)) {
  console.error(`  ${o.owner} : ${o.positionCount} position(s) in [${o.pools.join(", ")}] -- onList=${o.onList} isTreasury=${o.isTreasury}`);
}

const notOnListCount = ownerRows.filter((o) => !o.onList && !o.isTreasury).length;
const onListCount = ownerRows.filter((o) => o.onList).length;
console.error(`\nSummary: ${onListCount} distinct owners already on the burn/refund list, ${notOnListCount} distinct owners NOT on the list (excluding the known treasury wallet), out of ${ownerRows.length} total distinct owners.`);

fs.writeFileSync(process.argv[2] + ".parsed.json", JSON.stringify({ uniqueRows, ownerRows }, null, 2));
