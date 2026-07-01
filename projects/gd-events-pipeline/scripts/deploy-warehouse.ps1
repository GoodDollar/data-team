# deploy-warehouse.ps1
# Creates the L1 raw event tables (BlockchainEvents.*) from the DDL in warehouse/L1/.
# These are the tables the TypeScript pipeline streams into and dbt reads as sources —
# they are NOT managed by dbt, so this bootstrap DDL still lives here.
#
# The Semantic (L2) and Marts (L3) layers are managed by dbt now — use `dbt run`, not this
# script. See gd_dbt/ and docs/03_OPERATIONS.md.
#
# Usage:
#   .\scripts\deploy-warehouse.ps1        # creates/refreshes the L1 raw tables
#
# Requires:
#   - Google Cloud SDK installed (provides the `bq` CLI)
#   - `gcloud auth application-default login` already run

param(
    [Parameter(Position = 0)]
    [ValidateSet("L1")]
    [string]$Layer = "L1"
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
    Write-Host "Deploying $($files.Count) file(s) in $LayerName..." -ForegroundColor Green
    foreach ($f in $files) {
        Invoke-SqlFile -Path $f.FullName
    }
    Write-Host "$LayerName complete." -ForegroundColor Green
}

Deploy-Layer $Layer

Write-Host ""
Write-Host "Done." -ForegroundColor Green
