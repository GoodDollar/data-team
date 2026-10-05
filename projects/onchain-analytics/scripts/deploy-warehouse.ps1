# deploy-warehouse.ps1
# Applies one explicitly allowlisted L1 migration to gooddollar.BlockchainEvents.
# It never scans the SQL directory. Unknown and historical files are refused by filename.
# Default execution is plan-only. Production execution requires both switches and a typed prompt.
# See docs/03_OPERATIONS.md for the migration and approval requirements.
#
# Usage:
#   .\scripts\deploy-warehouse.ps1 -Migration 09_CreateRawLogs_v1.sql
#   .\scripts\deploy-warehouse.ps1 -Migration 09_CreateRawLogs_v1.sql -Execute -AllowProduction
#
# Requires:
#   - Google Cloud SDK installed (provides the `bq` CLI)
#   - `gcloud auth application-default login` already run
#   - Production execution is only for an administrator after separate approval

param(
    [Parameter(Mandatory = $true)]
    [string]$Migration,

    [switch]$Execute,

    [switch]$AllowProduction,

    [string]$ImpersonateServiceAccount
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$WarehouseDir = Join-Path $RepoRoot "warehouse"
$MigrationDir = Join-Path $WarehouseDir "L1"
$AllowedMigrations = @(
    "08_PipelineRunsOutcome_v1.sql",
    "09_CreateRawLogs_v1.sql",
    "10_AddOracleReconciliationCompatibility_v1.sql",
    "11_CreateRawLogsAllHistory_v1.sql",
    "12_CreateTransactionsAllHistory_v1.sql"
)

if ($Migration -notin $AllowedMigrations) {
    throw "REFUSED_UNLISTED_MIGRATION: '$Migration' is not in the deployment allowlist. Historical and unknown SQL is never executed by this helper."
}

$MigrationPath = Join-Path $MigrationDir $Migration
if (-not (Test-Path -LiteralPath $MigrationPath -PathType Leaf)) {
    throw "Allowlisted migration is missing: $MigrationPath"
}

$Sql = Get-Content -LiteralPath $MigrationPath -Raw
if (-not $Sql.Contains('${PROJECT}') -or -not $Sql.Contains('${DATASET}')) {
    throw "Migration must use the literal project and dataset placeholders: $Migration"
}
$Sql = $Sql.Replace('${PROJECT}', 'gooddollar').Replace('${DATASET}', 'BlockchainEvents')
if ($Sql -match '\$\{(PROJECT|DATASET)\}') {
    throw "Unresolved identifier placeholder in $Migration"
}

Write-Host "Migration: $Migration"
Write-Host "Target: gooddollar.BlockchainEvents"

if (-not $Execute) {
    Write-Host "PLAN ONLY. No BigQuery client was resolved and no query was submitted."
    return
}

if (-not $AllowProduction) {
    throw "REFUSED_PRODUCTION_EXECUTION: production execution requires -AllowProduction after separate production authorization."
}

if ($ImpersonateServiceAccount -notmatch '^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$') {
    throw "REFUSED_IMPERSONATION_REQUIRED: provide the separately approved commissioner service account with -ImpersonateServiceAccount."
}

$ExpectedConfirmation = "APPLY APPROVED DDL TO gooddollar.BlockchainEvents"
$Confirmation = Read-Host "Type '$ExpectedConfirmation' to continue"
if ($Confirmation -cne $ExpectedConfirmation) {
    throw "Production confirmation did not match. Nothing was submitted."
}

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
$GcloudExe = (Get-Command gcloud -ErrorAction SilentlyContinue).Source
if (-not $GcloudExe) {
    throw "gcloud CLI not found; cannot establish the approved impersonated identity."
}

$PreviousImpersonation = (& $GcloudExe config get-value auth/impersonate_service_account 2>$null | Select-Object -First 1)
$HadPreviousImpersonation = $PreviousImpersonation -and $PreviousImpersonation -notmatch '^\(unset\)$'
try {
    & $GcloudExe config set auth/impersonate_service_account $ImpersonateServiceAccount --quiet | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not set the approved temporary service-account impersonation."
    }

    Write-Host "Executing $Migration as $ImpersonateServiceAccount" -ForegroundColor Cyan
    $Sql | & $BqExe query --use_legacy_sql=false --format=none --project_id=gooddollar --maximum_bytes_billed=10737418240
    if ($LASTEXITCODE -ne 0) {
        throw "bq query failed for $Migration with exit code $LASTEXITCODE"
    }
} finally {
    if ($HadPreviousImpersonation) {
        & $GcloudExe config set auth/impersonate_service_account $PreviousImpersonation --quiet | Out-Null
    } else {
        & $GcloudExe config unset auth/impersonate_service_account --quiet | Out-Null
    }
}

Write-Host "Migration completed." -ForegroundColor Green
