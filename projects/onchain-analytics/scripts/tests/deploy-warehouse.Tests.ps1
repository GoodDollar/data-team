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

$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$deployAst = [System.Management.Automation.Language.Parser]::ParseFile($deployScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    throw "Deployment script must parse before identity checks"
}
$scopedBuilders = $deployAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'New-BqProcessStartInfo'
}, $true)
if ($scopedBuilders.Count -ne 1) {
    throw "Deployment must build a child process with its own approved identity"
}
if ($deployAst.Extent.Text -match 'config\s+(set|unset)\s+auth/impersonate_service_account') {
    throw "Deployment must not mutate shared gcloud impersonation settings"
}
Invoke-Expression $scopedBuilders[0].Extent.Text
$parentIdentity = $env:CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
$first = New-Object System.Diagnostics.Process
$second = New-Object System.Diagnostics.Process
try {
    $first.StartInfo = New-BqProcessStartInfo -BqExe $env:ComSpec -Arguments @('/d', '/c', 'echo', '%CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT%') -ImpersonateServiceAccount 'review-a@example.iam.gserviceaccount.com'
    $second.StartInfo = New-BqProcessStartInfo -BqExe $env:ComSpec -Arguments @('/d', '/c', 'echo', '%CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT%') -ImpersonateServiceAccount 'review-b@example.iam.gserviceaccount.com'
    [void]$first.Start()
    [void]$second.Start()
    $first.StandardInput.Close()
    $second.StandardInput.Close()
    $firstOutput = $first.StandardOutput.ReadToEnd()
    $secondOutput = $second.StandardOutput.ReadToEnd()
    $first.WaitForExit()
    $second.WaitForExit()
    if ($first.ExitCode -ne 0 -or $firstOutput.Trim() -cne 'review-a@example.iam.gserviceaccount.com') {
        throw "The first deployment child lost its approved identity: $firstOutput"
    }
    if ($second.ExitCode -ne 0 -or $secondOutput.Trim() -cne 'review-b@example.iam.gserviceaccount.com') {
        throw "The second deployment child lost its approved identity: $secondOutput"
    }
    if ($env:CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT -cne $parentIdentity) {
        throw "Deployment changed the caller's impersonation environment"
    }
} finally {
    $first.Dispose()
    $second.Dispose()
}
Write-Host "PASS overlapping children keep separate identities without modifying the caller"

$gcloudCommand = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
if ($gcloudCommand) {
    $sdkProbe = New-Object System.Diagnostics.Process
    try {
        $sdkProbe.StartInfo = New-BqProcessStartInfo -BqExe $gcloudCommand.Source -Arguments @('config', 'get-value', 'auth/impersonate_service_account') -ImpersonateServiceAccount 'review-a@example.iam.gserviceaccount.com'
        [void]$sdkProbe.Start()
        $sdkProbe.StandardInput.Close()
        $sdkOutputTask = $sdkProbe.StandardOutput.ReadToEndAsync()
        $sdkErrorTask = $sdkProbe.StandardError.ReadToEndAsync()
        $sdkProbe.WaitForExit()
        if ($sdkProbe.ExitCode -ne 0 -or $sdkOutputTask.Result.Trim() -cne 'review-a@example.iam.gserviceaccount.com') {
            throw "The installed SDK did not recognize the child-only identity: $($sdkErrorTask.Result)"
        }
    } finally {
        $sdkProbe.Dispose()
    }
    Write-Host "PASS installed SDK recognizes child-only impersonation without token acquisition"
}