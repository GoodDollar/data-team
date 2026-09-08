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

## LP Position and Staking Contract Checks (Celo)

A plain `balanceOf` check on a wallet misses GD held inside a liquidity-pool position (Uniswap-V3-style NFT position, or a Ubeswap-V2-style ERC20 LP token) or staked in a separate voting-power contract. These scripts and queries close that gap.

Fast, targeted RPC scripts (no historical scanning, safe to re-run any time):

- `lp-pool-current-state.mjs`, live GD balance for every known Celo GD pool, classified by kind (V3-style NFT positions vs. V2-style ERC20 LP token).
- `lp-pool-discovery.mjs`, discovers GD pools from a factory registry rather than a hardcoded list.
- `lp-known-positions-check.mjs`, resolves specific known Uniswap-V3 NFT position token IDs (owner, tick range, GD amount) directly via `positions()` / `ownerOf()`.
- `final-fresh-snapshot.mjs`, a quick live-balance snapshot for a fixed watchlist of addresses/contracts, meant to be re-run immediately before publishing any figure that depends on current balances.
- `refresh-burn-list-balances.mjs`, live re-check of every wallet on a given list against its previously-recorded balance.
- `staking-contract-check.mjs`, identifies a staking/voting-power contract's aggregate state and known interactions.

General-purpose finders (self-discover positions/holders via on-chain event history rather than a hardcoded list; correct but rate-limited by public RPC `eth_getLogs` block-range caps on a full historical scan):

- `lp-v3-positions.mjs <poolAddress>`, per-pool Uniswap-V3-style NFT position finder.
- `lp-v2-holders.mjs <poolAddress>`, per-pool Ubeswap-V2-style LP-token holder finder.

Dune SQL (no per-call block-range limit, the practical way to run the same discovery over full history):

- `queries/dune/reserve-analysis/lp-v3-positions.sql`, discovers every V3 LP position across all Uniswap-V3-style GD pools via Mint/IncreaseLiquidity/Transfer event correlation, no hardcoded token-ID list.
- `queries/dune/reserve-analysis/lp-v2-holders.sql`, LP-token holder enumeration for the Ubeswap-V2-style GD pools.
- `queries/dune/reserve-analysis/staking-contract-per-member-v2.sql`, per-member net staked GD for the staking contract, using last-event-wins state-machine logic (an amount-increase event on this contract restates an absolute total, not a delta, so a naive SUM overcounts members who topped up more than once).
- `queries/dune/reserve-analysis/v3-direct-liquidity-diagnostic.sql`, checks whether any GD liquidity was added directly to a pool bypassing the NFT position-manager wrapper.
- `queries/dune/reserve-analysis/v3-pairing-completeness-check.sql`, checks whether every position-manager-owned Mint event has a matching IncreaseLiquidity event in the same transaction.

Supporting parsers, clean up a raw Dune CSV/UI export (which can include repeated pagination headers) into structured rows for the scripts above:

- `parse-dune-export.mjs`, `parse-staking-export.mjs`, `parse-v3-direct-export.mjs`.

Converts parsed V3 position rows into GD amounts using the pool's current tick/price:

- `lp-bulk-gd-amounts.mjs <parsedPositionsJson>`.

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
