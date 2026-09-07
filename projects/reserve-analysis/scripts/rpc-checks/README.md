# RPC Checks

This folder contains reproducible reserve analysis checks for XDC and Fuse.

## Files

- analysis-rpc-checks.ps1: Recommended runner for Windows.
- analysis-rpc-checks.mjs: Node runner.
- xswap-check.mjs: Node runner for the XSwap (XDC) pool and cheap-buyer check.
- fuse-cheap-buyer-check.mjs: Node runner for the Fuse pool and cheap-buyer check.
- wallet-balance-check.mjs: Node runner for a live balance snapshot across Celo, XDC, Fuse, and Ethereum for a configured wallet list.
- package.json: Script aliases.

## Run

PowerShell:

```powershell
Set-Location projects/reserve-analysis/scripts/rpc-checks
powershell -ExecutionPolicy Bypass -File .\analysis-rpc-checks.ps1
```

Node:

```bash
cd projects/reserve-analysis/scripts/rpc-checks
npm run analysis
```

XSwap check (Node):

```bash
cd projects/reserve-analysis/scripts/rpc-checks
npm run xswap
```

Fuse cheap-buyer check (Node):

```bash
cd projects/reserve-analysis/scripts/rpc-checks
node fuse-cheap-buyer-check.mjs
```

Wallet balance snapshot (Node):

```bash
cd projects/reserve-analysis/scripts/rpc-checks
node wallet-balance-check.mjs
```

## Notes

- If Node execution hits XDC RPC network filtering from your environment, use the PowerShell runner.
- JSON output includes source endpoints and tx hashes for audit.
- xswap-check.mjs and fuse-cheap-buyer-check.mjs do not take a pool address as input. They detect pools empirically from GD transfer activity in the configured window, then confirm each candidate on-chain via token0()/token1() before trusting it.
- xswap-check.mjs rotates across several public XDC RPC endpoints with backoff. Public RPC nodes can rate-limit bursts of requests; rotation and throttling keep the script resilient to that.
- GD uses 2 decimals on Fuse, unlike Celo, XDC, and Ethereum (18). fuse-cheap-buyer-check.mjs and wallet-balance-check.mjs both account for this per chain. Always verify decimals() directly on a new chain rather than assuming.
- wallet-balance-check.mjs is a live snapshot only (current balanceOf plus native balance per chain, with block number for reproducibility), not a historical scan.
