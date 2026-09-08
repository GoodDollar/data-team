// Parses the noisy paginated Dune UI export for
// v3-direct-liquidity-diagnostic.sql (pool_name, pool_address, mint_owner,
// tick_lower, tick_upper, mint_count, gd_added_gross_total,
// example_tx_hash) into clean rows.
import fs from "node:fs";

const raw = fs.readFileSync(process.argv[2], "utf8");
const lines = raw.split(/\r?\n/).map((l) => l.trim());

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;
const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

const rows = [];
for (let i = 0; i < lines.length - 7; i++) {
  const chunk = lines.slice(i, i + 8);
  const [poolName, poolAddr, owner, tickLower, tickUpper, mintCount, gdGross, txHash] = chunk;
  if (
    poolAddr && ADDR_RE.test(poolAddr) &&
    owner && ADDR_RE.test(owner) &&
    tickLower && INT_RE.test(tickLower) &&
    tickUpper && INT_RE.test(tickUpper) &&
    mintCount && INT_RE.test(mintCount) &&
    gdGross && FLOAT_RE.test(gdGross) &&
    txHash && TXHASH_RE.test(txHash) &&
    poolName && !ADDR_RE.test(poolName)
  ) {
    rows.push({
      poolName, poolAddr: poolAddr.toLowerCase(), owner: owner.toLowerCase(),
      tickLower: Number(tickLower), tickUpper: Number(tickUpper),
      mintCount: Number(mintCount), gdAddedGross: Number(gdGross), exampleTxHash: txHash
    });
  }
}

// Dedupe on the full grouping key (pool+owner+tickLower+tickUpper), since
// pagination can repeat a boundary row.
const seen = new Set();
const uniqueRows = rows.filter((r) => {
  const key = `${r.poolAddr}|${r.owner}|${r.tickLower}|${r.tickUpper}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
console.error(`Parsed ${rows.length} raw matches, ${uniqueRows.length} unique (pool, owner, tick range) rows.`);

const byOwner = new Map();
for (const r of uniqueRows) {
  if (!byOwner.has(r.owner)) byOwner.set(r.owner, { owner: r.owner, totalGd: 0, rows: 0, pools: new Set() });
  const o = byOwner.get(r.owner);
  o.totalGd += r.gdAddedGross;
  o.rows += 1;
  o.pools.add(r.poolName);
}
const ownerSummary = [...byOwner.values()].map((o) => ({ owner: o.owner, totalGd: o.totalGd, rows: o.rows, pools: [...o.pools] })).sort((a, b) => b.totalGd - a.totalGd);

console.error(`\nUnique direct-mint owners: ${ownerSummary.length}`);
console.error(`\nTop 30 owners by gross GD added via direct mints:`);
for (const o of ownerSummary.slice(0, 30)) {
  console.error(`  ${o.owner}: ${o.totalGd.toFixed(2)} GD across ${o.rows} tick-range row(s) in [${o.pools.join(", ")}]`);
}

const byPool = new Map();
for (const r of uniqueRows) {
  byPool.set(r.poolName, (byPool.get(r.poolName) || 0) + r.gdAddedGross);
}
console.error(`\nTotal gross GD added via direct mints, by pool:`);
for (const [name, total] of byPool.entries()) console.error(`  ${name}: ${total.toFixed(2)}`);

const grandTotal = uniqueRows.reduce((s, r) => s + r.gdAddedGross, 0);
console.error(`\nGRAND TOTAL gross GD added via direct (non-NFT) mints across all 5 pools: ${grandTotal.toFixed(2)}`);

fs.writeFileSync(process.argv[2] + ".parsed.json", JSON.stringify({ uniqueRows, ownerSummary, grandTotal }, null, 2));
console.error(`\nWritten to ${process.argv[2]}.parsed.json`);
