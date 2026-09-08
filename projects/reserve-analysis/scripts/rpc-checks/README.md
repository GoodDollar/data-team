# RPC Checks

This folder contains reproducible reserve analysis checks for XDC and Fuse.

## Files

- analysis-rpc-checks.ps1: Recommended runner for Windows.
- analysis-rpc-checks.mjs: Node runner.
- xswap-check.mjs: Node runner for the XSwap (XDC) pool and cheap-buyer check.
- fuse-cheap-buyer-check.mjs: Node runner for the Fuse pool and cheap-buyer check.
- wallet-balance-check.mjs: Node runner for a live balance snapshot across Celo, XDC, Fuse, and Ethereum for a configured wallet list.
- wallet-cost-basis-xdc.mjs: Node runner that ranks XDC cheap-buyers still holding GD and reports what they paid (raw asset amount, USD where the paired asset is a stablecoin).
- wallet-cost-basis-fuse.mjs: Node runner that ranks Fuse cheap-buyers still holding GD and reports what they paid (raw asset amount, USD where the paired asset is a stablecoin). Mirrors wallet-cost-basis-xdc.mjs.
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

XDC wallet cost-basis (Node):

```bash
cd projects/reserve-analysis/scripts/rpc-checks
node wallet-cost-basis-xdc.mjs
```

Fuse wallet cost-basis (Node):

```bash
cd projects/reserve-analysis/scripts/rpc-checks
node wallet-cost-basis-fuse.mjs
```

## Notes

- If Node execution hits XDC RPC network filtering from your environment, use the PowerShell runner.
- JSON output includes source endpoints and tx hashes for audit.
- xswap-check.mjs and fuse-cheap-buyer-check.mjs do not take a pool address as input. They detect pools empirically from GD transfer activity in the configured window, then confirm each candidate on-chain via token0()/token1() before trusting it.
- wallet-cost-basis-xdc.mjs excludes known operator/treasury wallets from its results (see KNOWN_EXCLUSIONS in the script) and excludes other confirmed pools from being counted as buyers (inter-pool routing is not an external buyer). Non-stablecoin payment legs are reported as raw token + amount, not converted to USD.
- xswap-check.mjs rotates across several public XDC RPC endpoints with backoff. Public RPC nodes can rate-limit bursts of requests; rotation and throttling keep the script resilient to that.
- GD uses 2 decimals on Fuse, unlike Celo, XDC, and Ethereum (18). fuse-cheap-buyer-check.mjs and wallet-balance-check.mjs both account for this per chain. Always verify decimals() directly on a new chain rather than assuming.
- wallet-balance-check.mjs is a live snapshot only (current balanceOf plus native balance per chain, with block number for reproducibility), not a historical scan.
- wallet-cost-basis-fuse.mjs excludes known operator/treasury wallets and other confirmed pools from being counted as buyers, same as the XDC version. "Still holding" results should be checked against a block explorer before treating them as real wallets: high-traffic infrastructure (fee vaults, routers, batch-distribution contracts) can pass the pool-exclusion heuristic and still surface as a false "buyer". A quick eth_getCode plus an explorer look is a cheap way to confirm a result is an actual externally-owned wallet, not a contract.
