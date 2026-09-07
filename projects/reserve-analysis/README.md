# Reserve Analysis Toolkit

Purpose: Provide auditable, reproducible analysis checks for Celo, XDC, and Fuse.

## Scope

This folder contains:

- Canonical Dune query links for Celo-side checks.
- Public endpoint scripts for XDC and Fuse checks.
- Minimal run instructions for team use.

## Celo Checks (Dune)

- Q8, Cheap buyers and current holdings:
  - https://dune.com/queries/8611078?sidebar=none
- Q10, Ethereum bridge check and balances:
  - https://dune.com/queries/8611080?sidebar=none
- Q12, Route trail from 0x5ec2:
  - https://dune.com/queries/8611082?sidebar=none

Interpretation guard:

- Q10 zero output excludes the tested Ethereum bridge path from this analsysis.
- It does not prove every possible Ethereum path is impossible.

## XDC and Fuse Checks (Public Endpoints)

Scripts are in scripts/rpc-checks:

- analysis-rpc-checks.ps1 (recommended on Windows)
- analysis-rpc-checks.mjs (Node)

Current logic:

1. XDC:

- Pull reserve swap events from reserve_xdc for fixed analysis window.
- Parse tx hashes from event IDs.
- Resolve tx senders via XDC RPC and aggregate outflow by seller.

2. Fuse:

- Pull paginated ERC-20 token transfers for route contracts.
- Keep only transfers where router is sender.
- Exclude GD token transfers.
- Rank recipients by non-GD outflow and return top 2.

## XSwap Checks (XDC, Public RPC)

Script: scripts/rpc-checks/xswap-check.mjs

GD has pools on XSwap (a separate AMM on XDC, independent of the GoodDollar Reserve). This script checks that venue directly:

- Pull GD token Transfer logs from XDC RPC for a fixed window, no pool address assumed in advance.
- Detect pool-like addresses empirically (bidirectional flow, multiple counterparties, varying amounts).
- Confirm each candidate on-chain via the standard token0()/token1() selectors before trusting it as an AMM pair.
- Rank buyers by GD received directly from a confirmed pool, with a live current-balance check per buyer.
- RPC calls rotate across multiple public XDC endpoints with backoff, since single-endpoint rate limits are common.

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
node xswap-check.mjs
```

## Output

Both scripts print JSON with:

- xdc.windowStart, xdc.windowEnd
- xdc.reserveSwapEvents
- xdc.totalReserveOutflow
- xdc.sellers[] with txHashes
- fuse.routeOutflowRows
- fuse.top2[] with txHashes and token breakdown

xswap-check.mjs prints JSON with:

- window, blockRange
- confirmedPools[] with paired token and volume
- buyers[] ranked by GD received, each with txHashes and currentGdBalance

## Auditability

- Every value can be traced to an API response and transaction hash.
- Endpoint URLs are embedded in output.sources.
- Team members can rerun scripts directly from this folder.
