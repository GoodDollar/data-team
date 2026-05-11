# refresh-marts.ps1
# Re-runs only the L3 mart .sql files. Use after each new pipeline ingest.
# (L1 grows continuously via the pipeline; L2 are views and always live.)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $ScriptDir "deploy-warehouse.ps1") L3
