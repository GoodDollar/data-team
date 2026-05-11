# Contract Deployment Blocks

`firstBlock` values used by the pipeline for backfill. Set conservatively — too low is safe (just slower), too high silently loses history.

To verify any of these: open the block explorer for the chain, search the contract address, click **Contract** → look for the contract creation transaction. Use that block number (or one block earlier to be safe).

---

## In MVP scope

| Contract | Network | Address | First block | Verified via |
|---|---|---|---|---|
| UBIScheme | XDC | `0x22867567e2d80f2049200e25c6f31cb6ec2f0faf` | 95,249,624 | xdcscan.io |
| Invite | XDC | `0x6bd698566632bf2e81e2278f1656cb24aaf06d2e` | 95,144,756 | xdcscan.io |

---

## Post-MVP

| Contract | Network | Address | First block | Verified via |
|---|---|---|---|---|
| UBIScheme | Celo | `0x43d72ff17701b2da814620735c39c620ce0ea4a1` | 18,006,679 | celoscan.io |
| UBIScheme | Fuse | `0xd253a5203817225e9768c05e5996d642fb96ba86` | 15,747,401 | explorer.fuse.io |
| Invite | Celo | `0x36829d1cda92fff5782d5d48991620664fc857d3` | 18,483,200 | celoscan.io |

---

## How to find a deployment block (block-explorer walkthrough)

For example, the XDC UBIScheme contract:

1. Open <https://xdcscan.io/address/0x22867567e2d80f2049200e25c6f31cb6ec2f0faf>
2. Click the **Contract** tab → **Contract Creation** subsection
3. Note the block number from the creation tx
4. Use that number (or `block - 1` to be safe) as `firstBlock`

Same pattern works on celoscan.io, etherscan.io, etc.
