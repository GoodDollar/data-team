# RPC Checks

This folder contains reproducible reserve analysis checks for XDC and Fuse.

## Files

- analysis-rpc-checks.ps1: Recommended runner for Windows.
- analysis-rpc-checks.mjs: Node runner.
- xswap-check.mjs: Node runner for the XSwap (XDC) pool and cheap-buyer check.
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

## Notes

- If Node execution hits XDC RPC network filtering from your environment, use the PowerShell runner.
- JSON output includes source endpoints and tx hashes for audit.
- xswap-check.mjs does not take a pool address as input. It detects pools empirically from GD transfer activity in the configured window, then confirms each candidate on-chain via token0()/token1() before trusting it.
- xswap-check.mjs rotates across several public XDC RPC endpoints with backoff. Public RPC nodes can rate-limit bursts of requests; rotation and throttling keep the script resilient to that.
