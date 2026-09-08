// Parses the noisy paginated Dune UI export for staking-contract-per-member.sql
// / staking-contract-per-member-v2.sql (v2 has an extra last_event_kind
// column between net_staked_gd and already_on_burn_refund_list; detected
// automatically, no need to pick a version).
import fs from "node:fs";

const raw = fs.readFileSync(process.argv[2], "utf8");
const lines = raw.split(/\r?\n/).map((l) => l.trim());

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const FLOAT_RE = /^-?\d+(\.\d+)?$/;
const BOOL_RE = /^(true|false)$/;
const KIND_RE = /^(register_or_increase|unregister)$/;

const rows = [];
for (let i = 0; i < lines.length - 2; i++) {
  // v1 shape: member, net_staked_gd, already_on_burn_refund_list (3 lines)
  const [member, netStaked, onList] = lines.slice(i, i + 3);
  if (member && ADDR_RE.test(member) && netStaked && FLOAT_RE.test(netStaked) && onList && BOOL_RE.test(onList)) {
    rows.push({ member: member.toLowerCase(), netStakedGd: Number(netStaked), onList: onList === "true" });
    continue;
  }
  // v2 shape: member, net_staked_gd, last_event_kind, already_on_burn_refund_list (4 lines)
  if (i < lines.length - 3) {
    const [member2, netStaked2, kind2, onList2] = lines.slice(i, i + 4);
    if (member2 && ADDR_RE.test(member2) && netStaked2 && FLOAT_RE.test(netStaked2) && kind2 && KIND_RE.test(kind2) && onList2 && BOOL_RE.test(onList2)) {
      rows.push({ member: member2.toLowerCase(), netStakedGd: Number(netStaked2), lastEventKind: kind2, onList: onList2 === "true" });
    }
  }
}
const seen = new Set();
const uniqueRows = rows.filter((r) => { if (seen.has(r.member)) return false; seen.add(r.member); return true; });

console.error(`Parsed ${rows.length} raw matches, ${uniqueRows.length} unique members.`);
uniqueRows.sort((a, b) => b.netStakedGd - a.netStakedGd);

const totalStaked = uniqueRows.reduce((s, r) => s + r.netStakedGd, 0);
const totalOnList = uniqueRows.filter((r) => r.onList).reduce((s, r) => s + r.netStakedGd, 0);
const totalNotOnList = uniqueRows.filter((r) => !r.onList).reduce((s, r) => s + r.netStakedGd, 0);

console.error(`\nTotal net staked across ${uniqueRows.length} members: ${totalStaked.toFixed(2)}`);
console.error(`  Already on burn/refund list: ${totalOnList.toFixed(2)} (${uniqueRows.filter((r) => r.onList).length} members)`);
console.error(`  NOT on the list: ${totalNotOnList.toFixed(2)} (${uniqueRows.filter((r) => !r.onList).length} members)`);

console.error(`\nTop 30 by net staked GD:`);
for (const r of uniqueRows.slice(0, 30)) {
  console.error(`  ${r.member}: ${r.netStakedGd.toFixed(2)} GD, onList=${r.onList}`);
}

fs.writeFileSync(process.argv[2] + ".parsed.json", JSON.stringify({ uniqueRows, totalStaked, totalOnList, totalNotOnList }, null, 2));
console.error(`\nWritten to ${process.argv[2]}.parsed.json`);
