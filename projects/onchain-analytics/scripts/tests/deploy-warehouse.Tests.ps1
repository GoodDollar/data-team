$ErrorActionPreference = "Continue"
$testDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $testDir)
$deployScript = Join-Path $repoRoot "scripts\deploy-warehouse.ps1"
$refused = @(
    "99_UnlistedUnbannered.sql",
    "04_L0Contract_v3.sql",
    "06_L0Contract_v4.sql",
    "07_RetireV3EventTables.sql"
)

foreach ($migration in $refused) {
    $output = & powershell.exe -NoProfile -NonInteractive -File $deployScript -Migration $migration 2>&1
    $exitCode = $LASTEXITCODE
    $text = $output -join "`n"
    if ($exitCode -eq 0 -or $text -notmatch "REFUSED_UNLISTED_MIGRATION") {
        throw "Expected refusal for $migration; exit=$exitCode output=$text"
    }
    Write-Host "PASS refused $migration before query submission"
}

foreach ($migration in @(
    "08_PipelineRunsOutcome_v1.sql",
    "09_CreateRawLogs_v1.sql",
    "10_AddOracleReconciliationCompatibility_v1.sql",
    "11_CreateRawLogsAllHistory_v1.sql",
    "12_CreateTransactionsAllHistory_v1.sql"
)) {
    $plan = & powershell.exe -NoProfile -NonInteractive -File $deployScript -Migration $migration 2>&1
    if ($LASTEXITCODE -ne 0 -or ($plan -join "`n") -notmatch "PLAN ONLY") {
        throw "An allowlisted migration must default to plan-only: $migration. output=$($plan -join "`n")"
    }
}
Write-Host "PASS all allowlisted migrations default to plan-only"

$impersonation = & powershell.exe -NoProfile -NonInteractive -File $deployScript -Migration "09_CreateRawLogs_v1.sql" -Execute -AllowProduction 2>&1
$impersonationExit = $LASTEXITCODE
if ($impersonationExit -eq 0 -or ($impersonation -join "`n") -notmatch "REFUSED_IMPERSONATION_REQUIRED") {
    throw "Production execution without an approved service account must refuse. output=$($impersonation -join "`n")"
}
Write-Host "PASS production execution requires an explicit service account"