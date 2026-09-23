// Parses the noisy, paginated Dune UI text export (copy-pasted across 14
// pages, headers/pagination controls interleaved between data blocks) into
// clean rows, then aggregates by current_owner and cross-references against
// the reviewed list wallets.
import fs from "node:fs";
import { addressSet } from "./wallet-list.mjs";

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

// Loaded from the local-only _wallet-list.json -- see wallet-list.example.json.
const KNOWN_LIST = addressSet("celo");
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
console.error(`\nSummary: ${onListCount} distinct owners already on the reviewed list, ${notOnListCount} distinct owners NOT on the list (excluding the known treasury wallet), out of ${ownerRows.length} total distinct owners.`);

fs.writeFileSync(process.argv[2] + ".parsed.json", JSON.stringify({ uniqueRows, ownerRows }, null, 2));
