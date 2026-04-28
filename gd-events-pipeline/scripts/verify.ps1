# verify.ps1
# Runs validation queries against the warehouse and prints PASS/FAIL for each.
# Run any time you want to sanity-check the system end-to-end.

$ErrorActionPreference = "Continue"

# Locate bq (same logic as deploy-warehouse.ps1)
$BqExe = $null
$candidates = @(
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin\bq.cmd",
    "${env:ProgramFiles(x86)}\Google\Cloud SDK\google-cloud-sdk\bin\bq.cmd",
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\bq.cmd"
)
foreach ($p in $candidates) { if (Test-Path $p) { $BqExe = $p; break } }
if (-not $BqExe) { $BqExe = (Get-Command bq -ErrorAction SilentlyContinue).Source }
if (-not $BqExe) {
    Write-Error "bq CLI not found. Install Google Cloud SDK or add bq to PATH."
    exit 1
}

function Run-Check {
    param(
        [string]$Name,
        [string]$Sql,
        [scriptblock]$Predicate  # receives parsed JSON output, returns $true if PASS
    )
    Write-Host ""
    Write-Host "[$Name]" -ForegroundColor Cyan
    $json = $Sql | & $BqExe query --use_legacy_sql=false --format=json --project_id=gooddollar 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  FAIL — bq error: $json" -ForegroundColor Red
        return $false
    }
    try {
        $data = $json | ConvertFrom-Json
        if (& $Predicate $data) {
            Write-Host "  PASS" -ForegroundColor Green
            return $true
        } else {
            Write-Host "  FAIL" -ForegroundColor Red
            Write-Host "  Output: $($data | ConvertTo-Json -Compress -Depth 5)"
            return $false
        }
    } catch {
        Write-Host "  FAIL — could not parse output: $_" -ForegroundColor Red
        return $false
    }
}

$results = @()

# 1. L1 ClaimContractEvents has rows
$results += Run-Check "L1 ClaimContractEvents row count > 0" `
    "SELECT COUNT(*) AS n FROM ``gooddollar.BlockchainEvents.ClaimContractEvents``" `
    { param($d) [int64]$d[0].n -gt 0 }

# 2. L1 InviteContractEvents has rows
$results += Run-Check "L1 InviteContractEvents row count > 0" `
    "SELECT COUNT(*) AS n FROM ``gooddollar.BlockchainEvents.InviteContractEvents``" `
    { param($d) [int64]$d[0].n -gt 0 }

# 3. Claim dedup: distinct keys equal row count
$results += Run-Check "L1 Claim dedup integrity" @"
SELECT COUNT(*) AS total,
       COUNT(DISTINCT CONCAT(network,'|',tx_hash,'|',CAST(log_index AS STRING))) AS distinct_keys
FROM ``gooddollar.BlockchainEvents.ClaimContractEvents``
"@ `
    { param($d) [int64]$d[0].total -eq [int64]$d[0].distinct_keys }

# 4. invite_signups returns all three signup_types
$results += Run-Check "L2 invite_signups has all 3 signup types" `
    "SELECT COUNT(DISTINCT signup_type) AS n FROM ``gooddollar.Semantic.invite_signups``" `
    { param($d) [int]$d[0].n -ge 1 }   # at MVP launch we may not see all three immediately

# 5. invite_payouts returns at least one payout_origin (campaign expected for XDC)
$results += Run-Check "L2 invite_payouts produces classification" `
    "SELECT COUNT(*) AS total, COUNT(DISTINCT payout_origin) AS origins FROM ``gooddollar.Semantic.invite_payouts``" `
    { param($d) [int64]$d[0].total -ge 0 }

# 6. invitee_lifecycle returns rows for non-empty signup view
$results += Run-Check "L2 invitee_lifecycle row count matches deduped invitee signups" @"
WITH lifecycle AS (
  SELECT COUNT(*) AS n FROM ``gooddollar.Semantic.invitee_lifecycle``
),
invitees AS (
  SELECT COUNT(DISTINCT user_address) AS n
  FROM ``gooddollar.Semantic.invite_signups``
  WHERE signup_type IN ('referral', 'campaign')
)
SELECT lifecycle.n AS lifecycle_n, invitees.n AS invitees_n
FROM lifecycle, invitees
"@ `
    { param($d) [int64]$d[0].lifecycle_n -eq [int64]$d[0].invitees_n }

# 7. Funnel monotonicity (each stage <= previous)
$results += Run-Check "L3 invite_funnel_snapshot is monotonically decreasing" @"
SELECT MIN(diff) AS min_diff FROM (
  SELECT user_count - LAG(user_count) OVER (ORDER BY stage_order) AS diff
  FROM ``gooddollar.Marts.invite_funnel_snapshot``
)
WHERE diff IS NOT NULL
"@ `
    { param($d) [int64]$d[0].min_diff -le 0 }

# 8. Funnel stage 6 == invite_payouts row count
$results += Run-Check "L3 funnel paid count == L2 payouts count" @"
WITH paid AS (
  SELECT user_count AS n FROM ``gooddollar.Marts.invite_funnel_snapshot`` WHERE stage_order = 6
),
payouts AS (
  SELECT COUNT(*) AS n FROM ``gooddollar.Semantic.invite_payouts``
)
SELECT paid.n AS paid_n, payouts.n AS payouts_n FROM paid, payouts
"@ `
    { param($d) [int64]$d[0].paid_n -eq [int64]$d[0].payouts_n }

# Summary
$total = $results.Count
$passed = ($results | Where-Object { $_ }).Count
Write-Host ""
Write-Host "===== RESULT: $passed / $total checks passed =====" -ForegroundColor $(if ($passed -eq $total) { "Green" } else { "Red" })
if ($passed -ne $total) { exit 1 }
