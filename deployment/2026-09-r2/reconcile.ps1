<#
.SYNOPSIS
  Post-cutover reconciliation: Day 0 capture, then Day 1 / 3 / 7 / 30 checks.
  Read-only.

.DESCRIPTION
  Day 0 (immediately after go-live acceptance) captures the frozen history
  (`hist.*` in reconcile.sql). Every later day re-measures it and FAILS if one
  historical number moved, because history written before the cutover must
  never change again. It also reports new activity and health invariants.

  Exit code: 0 = PASS, 1 = FINDING (history moved or an invariant is non-zero),
  2 = WATCH (a pre-existing legacy condition grew).

.EXAMPLE
  $env:PGPASSWORD = '...'
  .\reconcile.ps1 -Database cafe_pos_v2 -Boundary '2026-09-27 17:30:00' -Label day0 -EvidenceDir C:\POS-BACKUPS\cutover\cutover-2026-09-27-r1
  .\reconcile.ps1 -Database cafe_pos_v2 -Boundary '2026-09-27 17:30:00' -Label day1 -EvidenceDir C:\POS-BACKUPS\cutover\cutover-2026-09-27-r1
#>
param(
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Boundary,
    [Parameter(Mandatory = $true)][ValidateSet('day0', 'day1', 'day3', 'day7', 'day30', 'adhoc')][string]$Label,
    [Parameter(Mandatory = $true)][string]$EvidenceDir,
    [string]$DbHost = 'localhost',
    [int]   $Port   = 5432,
    [string]$User   = 'postgres',
    [string]$PgBin  = 'C:\Program Files\PostgreSQL\18\bin'
)

$ErrorActionPreference = 'Stop'
if (-not $env:PGPASSWORD) { throw 'PGPASSWORD is not set.' }
if ($Database -eq 'POS-CAFE') { throw 'reconcile runs on the NEW database, not the legacy one.' }
if ($Boundary -notmatch '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$') { throw "Boundary must be 'YYYY-MM-DD HH:MM:SS' in UTC." }

$psql = Join-Path $PgBin 'psql.exe'
$rows = & $psql -h $DbHost -p $Port -U $User -w -X -A -t -F '|' -v ON_ERROR_STOP=1 -v "boundary=$Boundary" -d $Database -f "$PSScriptRoot\reconcile.sql"
if ($LASTEXITCODE -ne 0) { throw 'reconcile.sql failed' }

$m = [ordered]@{}
foreach ($r in $rows) { $c = $r -split '\|'; if ($c.Count -eq 3) { $m["$($c[0]).$($c[1])"] = $c[2] } }
$sorted = [ordered]@{}
foreach ($k in @($m.Keys) | Sort-Object) { $sorted[$k] = $m[$k] }
$m = $sorted

$findings = New-Object System.Collections.Generic.List[string]
$watch    = New-Object System.Collections.Generic.List[string]

foreach ($k in $m.Keys | Where-Object { $_ -like 'check.*' }) {
    if ([decimal]$m[$k] -ne 0) { $findings.Add("$k = $($m[$k])") }
}

$baselinePath = Join-Path $EvidenceDir 'reconcile-day0.json'
if ($Label -ne 'day0') {
    if (-not (Test-Path $baselinePath)) { throw "no Day 0 capture at $baselinePath" }
    $base = (Get-Content $baselinePath -Raw | ConvertFrom-Json).metrics
    foreach ($p in $base.PSObject.Properties | Where-Object { $_.Name -like 'hist.*' }) {
        if ("$($m[$p.Name])" -ne "$($p.Value)") { $findings.Add("HISTORY MOVED: $($p.Name) day0=$($p.Value) now=$($m[$p.Name])") }
    }
    foreach ($p in $base.PSObject.Properties | Where-Object { $_.Name -like 'watch.*' }) {
        if ([decimal]$m[$p.Name] -gt [decimal]$p.Value) { $watch.Add("$($p.Name) grew: day0=$($p.Value) now=$($m[$p.Name])") }
    }
} elseif (Test-Path $baselinePath) {
    throw "Day 0 was already captured ($baselinePath). It is never overwritten."
}

$verdict = if ($findings.Count) { 'FINDING' } elseif ($watch.Count) { 'WATCH' } else { 'PASS' }
$report = [ordered]@{
    label = $Label; database = $Database; boundaryUtc = $Boundary; measuredAt = (Get-Date -Format o)
    verdict = $verdict; findings = @($findings); watch = @($watch); metrics = $m
}
$out = Join-Path $EvidenceDir "reconcile-$Label.json"
if ($Label -eq 'adhoc') { $out = Join-Path $EvidenceDir ("reconcile-adhoc-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json') }
$report | ConvertTo-Json -Depth 5 | Out-File $out -Encoding utf8

Write-Host "=== reconciliation $Label on $Database (boundary $Boundary UTC) ===" -ForegroundColor Cyan
foreach ($k in $m.Keys | Where-Object { $_ -like 'new.*' }) { Write-Host ("  {0,-40} {1}" -f $k, $m[$k]) }
$findings | ForEach-Object { Write-Host "  FINDING  $_" -ForegroundColor Red }
$watch    | ForEach-Object { Write-Host "  WATCH    $_" -ForegroundColor Yellow }
Write-Host "  verdict: $verdict   ($out)" -ForegroundColor $(if ($verdict -eq 'PASS') { 'Green' } else { 'Yellow' })
exit $(switch ($verdict) { 'PASS' { 0 } 'FINDING' { 1 } default { 2 } })
