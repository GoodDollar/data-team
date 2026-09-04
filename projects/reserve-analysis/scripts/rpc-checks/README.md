# RPC Checks

This folder contains reproducible reserve analysis checks for XDC and Fuse.

## Files

- analysis-rpc-checks.ps1: Recommended runner for Windows.
- analysis-rpc-checks.mjs: Node runner.
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

## Notes

- If Node execution hits XDC RPC network filtering from your environment, use the PowerShell runner.
- JSON output includes source endpoints and tx hashes for audit.
