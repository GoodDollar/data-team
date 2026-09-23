# deploy-warehouse.ps1
# Creates the L1 raw event tables (BlockchainEvents.*) from the DDL in warehouse/L1/.
# These are the tables pipeline-v5 writes into and dbt reads as sources; they are NOT managed
# by dbt, so this bootstrap DDL still lives here.
#
# The Semantic (L2) and Marts (L3) layers are managed by dbt. Use `dbt run`, not this script.
# See gd_dbt/ and docs/03_OPERATIONS.md.
#
# SAFETY: files whose header carries a DO NOT RUN or NOT THE LIVE SHAPE banner are skipped, and
# -Force deliberately does not override that. Two files in warehouse/L1 are CREATE OR REPLACE
# against tables holding 2.6 million rows of production data.
#
# Usage:
#   .\scripts\deploy-warehouse.ps1        # applies the L1 DDL that is safe to re-apply
#
# Requires:
#   - Google Cloud SDK installed (provides the `bq` CLI)
#   - `gcloud auth application-default login` already run

param(
    [Parameter(Position = 0)]
    [ValidateSet("L1")]
    [string]$Layer = "L1",

    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$WarehouseDir = Join-Path $RepoRoot "warehouse"

# Resolve the bq.cmd location (gcloud SDK ships it as bq.cmd on Windows).
# Try common paths; fall back to PATH lookup.
$BqExe = $null
$candidates = @(
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin\bq.cmd",
    "${env:ProgramFiles(x86)}\Google\Cloud SDK\google-cloud-sdk\bin\bq.cmd",
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\bq.cmd"
)
foreach ($p in $candidates) {
    if (Test-Path $p) { $BqExe = $p; break }
}
if (-not $BqExe) {
    $BqExe = (Get-Command bq -ErrorAction SilentlyContinue).Source
}
if (-not $BqExe) {
    Write-Error "bq CLI not found. Install Google Cloud SDK from https://cloud.google.com/sdk/docs/install or add bq.cmd to PATH."
    exit 1
}
Write-Host "Using bq: $BqExe"

function Invoke-SqlFile {
    param([string]$Path)
    Write-Host ""
    Write-Host "==== $Path ====" -ForegroundColor Cyan
    $sql = Get-Content -Raw -Path $Path
    # bq query reads SQL from stdin
    $sql | & $BqExe query --use_legacy_sql=false --format=none --project_id=gooddollar
    if ($LASTEXITCODE -ne 0) {
        Write-Error "bq query failed for $Path"
        exit $LASTEXITCODE
    }
}

function Deploy-Layer {
    param([string]$LayerName)
    $layerDir = Join-Path $WarehouseDir $LayerName
    if (-not (Test-Path $layerDir)) {
        Write-Error "Layer folder not found: $layerDir"
        exit 1
    }
    $files = Get-ChildItem -Path $layerDir -Filter "*.sql" | Sort-Object Name
    if ($files.Count -eq 0) {
        Write-Warning "No .sql files in $layerDir"
        return
    }

    # Refuse anything that would drop a table holding production data. warehouse/L1 now contains
    # historical DDL that is NOT the live shape: 01 and 02 are CREATE OR REPLACE against the two
    # tables holding 2.6 million rows, and 03 was superseded. Running this folder end to end used
    # to be safe and no longer is. Each such file carries a banner and is skipped by name.
    $skipped = @()
    $toRun = @()
    foreach ($f in $files) {
        $head = Get-Content -Path $f.FullName -TotalCount 20 -Raw
        if ($head -match 'DO NOT RUN|NOT THE LIVE SHAPE') {
            $skipped += $f.Name
        } else {
            $toRun += $f
        }
    }

    if ($skipped.Count -gt 0) {
        Write-Host ""
        Write-Host "SKIPPED (superseded or destructive, banner in file header):" -ForegroundColor Yellow
        foreach ($s in $skipped) { Write-Host "  $s" -ForegroundColor Yellow }
        if ($Force) {
            Write-Error "-Force does not override this. These files would drop tables holding production data. Run the individual statements you actually want, by hand."
            exit 1
        }
    }

    if ($toRun.Count -eq 0) {
        Write-Warning "Nothing to run in $LayerName after skips."
        return
    }

    Write-Host "Deploying $($toRun.Count) file(s) in $LayerName..." -ForegroundColor Green
    foreach ($f in $toRun) {
        Invoke-SqlFile -Path $f.FullName
    }
    Write-Host "$LayerName complete." -ForegroundColor Green
}

Deploy-Layer $Layer

Write-Host ""
Write-Host "Done." -ForegroundColor Green
