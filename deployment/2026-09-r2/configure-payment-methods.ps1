<#
.SYNOPSIS
  Decision D21: give the migrated database explicit POS payment methods and the
  `mobile_money` / `card_clearing` fallback mappings. Configuration only, never
  history.

.DESCRIPTION
  After the migration the till still shows Cash / MTN / Airtel, because the API
  synthesizes tiles from the legacy wallet accounts (MOMO-MTN, MOMO-AIRTEL). But
  the `mobile_money` account mapping is unset, and a tender that arrives WITHOUT
  an account (an offline-queued sale replayed later, an API client) falls back
  to that mapping and is rejected. This step closes that gap by running the
  reviewed repository script apps/api/scripts/seed-pos-payment-methods.ts:

    * additive only: existing accounts, mappings and methods are never changed
    * one transaction per organization
    * reuses an existing wallet account whose name contains the provider

  Guards added here, because the script itself has none:
    * the target must be an approved database (_safety.ps1); in Job 2 this runs
      on the workspace BEFORE it is promoted
    * DATABASE_URL is always set explicitly, so the script can never fall back
      to apps/api/.env
    * refuses when a code the script may create (1121, 1122, ..., 1131) already
      belongs to an account of another category (it would be silently reused)
    * dry run first, both outputs kept as evidence

  The card tile it adds can be deactivated in the app if the café has no card
  terminal (record that in D21).

.EXAMPLE
  .\configure-payment-methods.ps1 -TargetDb cafe_migration_r1 -EvidenceDir C:\POS-BACKUPS\work\<run> -Providers MTN,Airtel -Apply
#>
param(
    [string]$TargetDb = 'cafe_migration_r1',
    [Parameter(Mandatory = $true)][string]$EvidenceDir,
    [string]$Providers = 'MTN,Airtel',
    [switch]$Apply,
    [string]$DbHost = 'localhost',
    [int]   $Port   = 5432,
    [string]$User   = 'postgres',
    [string]$PgBin  = 'C:\Program Files\PostgreSQL\18\bin'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_safety.ps1"
if (-not $env:PGPASSWORD) { throw 'PGPASSWORD is not set.' }
if (-not (Test-Path $EvidenceDir)) { throw "evidence directory missing: $EvidenceDir" }

Assert-SafeTarget -Database $TargetDb -DbHost $DbHost -Port $Port -User $User `
                  -Purpose 'D21 POS payment methods (additive configuration)' -ForbidReference

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$psql = Join-Path $PgBin 'psql.exe'
function Invoke-Query([string]$Sql) {
    # Via a file: Windows PowerShell strips the double quotes of mixed-case
    # identifiers when passing -c to a native executable.
    $tmp = [IO.Path]::GetTempFileName()
    try {
        Set-Content -Path $tmp -Value $Sql -Encoding utf8
        $r = & $psql -h $DbHost -p $Port -U $User -w -X -A -t -F '|' -v ON_ERROR_STOP=1 -d $TargetDb -f $tmp
        if ($LASTEXITCODE -ne 0) { throw "query failed on $TargetDb" }
        return $r
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}
$providerList = @($Providers.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$codes = @(for ($i = 0; $i -lt $providerList.Count; $i++) { "'$(1121 + $i)'" }) + "'1131'"

# Code-collision guard: a code the script would create must be free, or already
# be the right kind of account.
$clash = Invoke-Query @"
select a.code || ' ' || a.name || ' (' || coalesce(c.key, 'no category') || ')'
  from "Account" a left join "AccountCategory" c on c.id = a."categoryId"
 where a.code in ($($codes -join ',')) and coalesce(c.key, '') not in ('mobile_money', 'current_asset')
"@
if ($clash) { throw "STOP: account code(s) the script would use already belong to other accounts: $($clash -join '; ')" }

$pw = [uri]::EscapeDataString($env:PGPASSWORD)
$saved = $env:DATABASE_URL
$env:DATABASE_URL = "postgresql://$User`:$pw@${DbHost}:$Port/$TargetDb`?schema=public"
Push-Location $repoRoot
try {
    $dry = Join-Path $EvidenceDir 'payment-methods-dry-run.txt'
    & pnpm tsx apps/api/scripts/seed-pos-payment-methods.ts --providers ($providerList -join ',') | Out-File $dry -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'payment-method dry run failed' }
    Get-Content $dry | ForEach-Object { Write-Host "  $_" }
    if ($Apply) {
        $out = Join-Path $EvidenceDir 'payment-methods-apply.txt'
        & pnpm tsx apps/api/scripts/seed-pos-payment-methods.ts --providers ($providerList -join ',') --apply | Out-File $out -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw 'payment-method apply failed' }
        Get-Content $out | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
    }
} finally {
    Pop-Location
    $env:DATABASE_URL = $saved
}

$state = Invoke-Query @"
select 'method|' || m.code || '|' || m.kind || '|' || coalesce(a.code, '-') from "PosPaymentMethod" m left join "Account" a on a.id = m."accountId" where m."deletedAt" is null
union all select 'mapping|' || m.key || '|' || a.code || '|' || a.name from "AccountMapping" m join "Account" a on a.id = m."accountId" where m.key in ('mobile_money', 'card_clearing')
order by 1
"@
$state | Out-File (Join-Path $EvidenceDir 'payment-methods-state.txt') -Encoding utf8
$state | ForEach-Object { Write-Host "  $_" }
if ($Apply -and -not ($state -match '^mapping\|mobile_money\|')) { throw 'mobile_money mapping still missing after apply' }
Write-Host "D21 payment methods $(if ($Apply) { 'APPLIED' } else { 'dry run only' }) on $TargetDb" -ForegroundColor Green
