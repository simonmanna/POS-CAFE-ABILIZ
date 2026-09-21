<#
.SYNOPSIS
  Return to the old POS, and answer "what did the new system write since we
  switched?".

.DESCRIPTION
  The migration never touches the legacy database: it is frozen read-only, dumped
  and restored into a NEW database which the new application uses. Rollback is
  therefore a switch-back, not a restore:

      stop new app -> point services at the old install -> unfreeze the legacy
      database -> start old app -> health -> test read

  That is why this script NEVER runs `pg_restore` over a live database. The
  2026-08-r1 predecessor did (`pg_restore --clean` over the upgraded database),
  which cannot work once the new schema has added tables and foreign keys that
  the dump knows nothing about - it fails half way and leaves an unknown state.

  ROLLBACK BOUNDARY
  A switch-back is only lossless while the new system has written no
  authoritative business transaction. `-ReportV2Writes` lists exactly what the
  new system recorded after a boundary timestamp, so the decision is made on
  evidence rather than on hope. Anything it lists must be re-entered by hand in
  the old system before trading resumes.

.PARAMETER Drill
  Local rehearsal: no NSSM, no nginx. Starts the old API against a disposable
  copy and times the switch.

.PARAMETER Production
  JOB 2. With -ReportV2Writes: read the PRODUCTION database (read-only) and
  export every V2 business row to CSV. Alone: the POST-WRITE switch-back, driven
  by the cutover run's evidence (services.txt, cutover-state.json). The
  PRE-WRITE switch-back is `cutover.ps1 -Phase abort`.

.EXAMPLE
  # Job 1 drill (local, disposable databases only)
  .\rollback.ps1 -Drill -LegacyDb cafe_rollback_test_r1 -OldInstall C:\projects\POS-CAFE-ABILIZ -OldPort 3004

  # What has the new system written since the cutover?
  .\rollback.ps1 -ReportV2Writes -TargetDb cafe_migration_r1 -Since '2026-09-17T19:00:00Z'

  # Job 2: what exactly did the new system write? (read-only, one CSV per table)
  .\rollback.ps1 -Production -ReportV2Writes -TargetDb cafe_pos_v2 -Since '2026-09-27 17:30:00' -ExportDir C:\POS-BACKUPS\cutover\cutover-2026-09-27-r1\v2-writes

  # Job 2: post-write switch-back (named rollback authority + witness)
  .\rollback.ps1 -Production -RunId cutover-2026-09-27-r1 -Config C:\POS-BACKUPS\cafe-config.json -Authorization C:\POS-BACKUPS\authorization.json
#>
param(
    [switch]$Drill,
    [switch]$ReportV2Writes,

    # --- databases ---
    [string]$LegacyDb   = 'cafe_rollback_test_r1',
    [string]$TargetDb   = 'cafe_migration_r1',
    [string]$DbHost     = 'localhost',
    [int]   $Port       = 5432,
    [string]$User       = 'postgres',
    [string]$PgBin      = 'C:\Program Files\PostgreSQL\18\bin',

    # --- applications ---
    [string]$OldInstall = 'C:\projects\POS-CAFE-ABILIZ',
    [int]   $OldPort    = 3004,
    [string]$Since      = '',

    # --- production switch-back (Job 2; unused in a Job 1 drill) ---
    [string]$ApiService = 'pos-cafe-api',
    [string]$WebService = 'pos-cafe-web',

    # --- Job 2 ---
    [switch]$Production,
    [string]$ExportDir     = '',
    [string]$RunId         = '',
    [string]$Config        = '',
    [string]$Authorization = ''
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_safety.ps1"

$psql = Join-Path $PgBin 'psql.exe'
if (-not $env:PGPASSWORD) { throw 'PGPASSWORD is not set.' }

function Invoke-Query([string]$Database, [string]$Sql) {
    # Via a file, not -c: PowerShell strips the double quotes around mixed-case
    # identifiers on the way to a native executable, which turns `"Order"` into
    # the reserved word `Order` and the query into a syntax error.
    $tmp = [IO.Path]::GetTempFileName()
    try {
        Set-Content -Path $tmp -Value $Sql -Encoding utf8
        $r = & $psql -h $DbHost -p $Port -U $User -w -X -A -F ' | ' -t -v ON_ERROR_STOP=1 -d $Database -f $tmp
        if ($LASTEXITCODE -ne 0) { throw "query failed on $Database" }
        return $r
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
# What has the new system written since the boundary?
# ---------------------------------------------------------------------------
if ($ReportV2Writes) {
    if (-not $Since) { throw 'Pass -Since <ISO timestamp> (the cutover boundary).' }
    if ($Production) {
        # Read-only on the production database: nothing in this branch writes.
        if ($TargetDb -eq 'POS-CAFE') { throw 'V2 writes live in the NEW database, not POS-CAFE.' }
        Write-Host "  production read-only report on $TargetDb" -ForegroundColor Cyan
    } else {
        Assert-SafeTarget -Database $TargetDb -DbHost $DbHost -Port $Port -User $User -Purpose 'read post-cutover writes (read-only)'
    }

    Write-Host "=== business transactions written by the NEW system since $Since ===" -ForegroundColor Cyan
    $sql = @"
select 'Invoice'         as entity, count(*)::text as rows from "Invoice"         where "createdAt" > '$Since'
 union all select 'Payment',        count(*)::text from "Payment"                 where "createdAt" > '$Since'
 union all select 'Order',          count(*)::text from "Order"                   where "createdAt" > '$Since'
 union all select 'Receipt',        count(*)::text from "Receipt"                 where "createdAt" > '$Since'
 union all select 'CashMovement',   count(*)::text from "CashMovement"            where "createdAt" > '$Since'
 union all select 'CashSession',    count(*)::text from "CashSession"             where "createdAt" > '$Since'
 union all select 'JournalEntry',   count(*)::text from "JournalEntry"            where "createdAt" > '$Since'
 union all select 'InventoryLedger',count(*)::text from "InventoryLedger"         where "createdAt" > '$Since'
 union all select 'PosRefund',      count(*)::text from "PosRefund"               where "createdAt" > '$Since'
 union all select 'TenderSettlement',count(*)::text from "TenderSettlement"       where "createdAt" > '$Since'
 order by 1
"@
    $rows = Invoke-Query $TargetDb $sql
    $rows | ForEach-Object { Write-Host "  $_" }

    $total = Invoke-Query $TargetDb @"
select coalesce(sum(n),0)::text from (
  select count(*) n from "Invoice" where "createdAt" > '$Since'
  union all select count(*) from "Payment" where "createdAt" > '$Since'
  union all select count(*) from "Order" where "createdAt" > '$Since'
  union all select count(*) from "CashMovement" where "createdAt" > '$Since'
  union all select count(*) from "JournalEntry" where "createdAt" > '$Since'
) s
"@
    $n = [int]($total | Select-Object -First 1)

    if ($ExportDir) {
        # One CSV per table, full rows, so every V2 transaction can be re-entered
        # in the old system and ticked off one by one.
        New-Item -ItemType Directory -Path $ExportDir -Force | Out-Null
        foreach ($t in 'Order', 'OrderItem', 'Invoice', 'InvoiceItem', 'Payment', 'PaymentAllocation', 'Receipt',
                       'CashSession', 'CashMovement', 'PosRefund', 'JournalEntry', 'InventoryLedger') {
            $exists = Invoke-Query $TargetDb "select count(*) from information_schema.columns where table_schema = 'public' and table_name = '$t' and column_name = 'createdAt'"
            if ([int]($exists | Select-Object -First 1) -eq 0) { continue }
            $csv = (Join-Path $ExportDir "$t.csv").Replace('\', '/')
            Invoke-Query $TargetDb "\copy (select * from ""$t"" where ""createdAt"" > '$Since' order by ""createdAt"") to '$csv' with csv header" | Out-Null
        }
        Write-Host "  exported to $ExportDir"
    }
    Write-Host ''
    if ($n -eq 0) {
        Write-Host 'ROLLBACK IS LOSSLESS: the new system has recorded no business transaction since the boundary.' -ForegroundColor Green
    } else {
        Write-Host "ROLLBACK IS NOT LOSSLESS: $n business row(s) exist only in the new system." -ForegroundColor Yellow
        Write-Host 'Export them, re-enter them in the old system with owner verification, and only then switch back.'
    }
    exit 0
}

# ---------------------------------------------------------------------------
# Switch back
# ---------------------------------------------------------------------------
$sw = [Diagnostics.Stopwatch]::StartNew()
Write-Host '=== rollback: switch back to the old POS ===' -ForegroundColor Cyan

if ($Drill) {
    Assert-SafeTarget -Database $LegacyDb -DbHost $DbHost -Port $Port -User $User -Purpose 'rollback drill (writable legacy copy)' -ForbidReference

    Write-Host '  [1] stopping anything on the old port'
    Get-NetTCPConnection -LocalPort $OldPort -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

    Write-Host '  [2] unfreezing the legacy database'
    Invoke-Query 'postgres' "alter database ""$LegacyDb"" reset default_transaction_read_only" | Out-Null

    Write-Host '  [3] starting the old application'
    $pw  = [uri]::EscapeDataString($env:PGPASSWORD)
    $env:DATABASE_URL = "postgresql://$User`:$pw@${DbHost}:$Port/$LegacyDb`?schema=public"
    $env:PORT = "$OldPort"
    $apiDir = Join-Path $OldInstall 'apps\api'
    if (-not (Test-Path (Join-Path $apiDir 'dist\main.js'))) { throw "old build missing: $apiDir\dist\main.js" }
    $proc = Start-Process -FilePath 'node' -ArgumentList '--max-http-header-size=65536', 'dist/main.js' `
                          -WorkingDirectory $apiDir -PassThru -WindowStyle Hidden

    Write-Host '  [4] waiting for health'
    $healthy = $false
    for ($i = 0; $i -lt 120; $i++) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$OldPort/api/v1/health" -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    $sw.Stop()
    if (-not $healthy) { throw "the old application did not become healthy (pid $($proc.Id))" }

    Write-Host '  [5] proving the legacy data is intact'
    $check = Invoke-Query $LegacyDb @"
select 'invoices=' || (select count(*) from "Invoice") ||
       ' migrations=' || (select count(*) from "_prisma_migrations") ||
       ' accountType_column=' || (select count(*) from information_schema.columns
                                   where table_name = 'Account' and column_name = 'accountType')
"@
    Write-Host "         $($check | Select-Object -First 1)"

    Write-Host ''
    Write-Host ("TESTED RAPID ROLLBACK: {0:n1}s from switch to a healthy old POS (pid {1})." -f $sw.Elapsed.TotalSeconds, $proc.Id) -ForegroundColor Green
    Write-Host 'Terminals still need their site data cleared so the new service worker and'
    Write-Host 'the shared pos-offline-queue do not linger. See terminal-checklist.md.'
    exit 0
}

# ---------------------------------------------------------------------------
# JOB 2: POST-WRITE switch-back (the new system HAS written business rows).
# The PRE-WRITE switch-back is `cutover.ps1 -Phase abort`.
# ---------------------------------------------------------------------------
if (-not $Production) { throw 'Choose -Drill (Job 1), -ReportV2Writes, or -Production (Job 2 post-write switch-back).' }
if (-not ($RunId -and $Config -and $Authorization)) { throw '-Production needs -RunId, -Config and -Authorization.' }
$cfg  = Get-Content $Config -Raw | ConvertFrom-Json
$auth = Get-Content $Authorization -Raw | ConvertFrom-Json
$dir  = Join-Path (Join-Path $cfg.backupRoot 'cutover') $RunId
$cst  = Get-Content (Join-Path $dir 'cutover-state.json') -Raw | ConvertFrom-Json
$since = $cst.phases.switch.data.switchedAtUtc
if (-not $since) { throw 'this run never switched to the new system: use cutover.ps1 -Phase abort (pre-write).' }
$legacy = $cfg.legacyDb; $target = $cfg.targetDb
$DbHost = $cfg.pg.host; $Port = $cfg.pg.port; $User = $cfg.pg.superuser
$psql = Join-Path $cfg.pg.bin 'psql.exe'

Write-Host "POST-WRITE ROLLBACK for $RunId (new system live since $since UTC)" -ForegroundColor Yellow
Write-Host 'Old and new must never trade at the same time. Step 1 stops BOTH.'
$ra = Read-Host '  Rollback authority full name'
if ($ra -ne $auth.signatures.rollbackAuthority.name) { throw "only the named rollback authority ($($auth.signatures.rollbackAuthority.name)) can start this." }
$witness = Read-Host '  Witness full name'
if (-not $witness -or $witness -eq $ra) { throw 'a second, different person must witness.' }

# 1. stop everything
foreach ($s in $cfg.services.web, $cfg.services.api) { & nssm stop $s | Out-Null }
Start-Sleep 3
$live = Invoke-Query 'postgres' "select count(*) from pg_stat_activity where datname in ('$legacy', '$target') and pid <> pg_backend_pid()"
if ([int]($live | Select-Object -First 1) -ne 0) { throw 'connections still open to the legacy or the new database - find them first.' }

# 2. enumerate and export every V2 write (read-only)
$export = Join-Path $dir ('v2-writes-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
& $PSCommandPath -Production -ReportV2Writes -TargetDb $target -Since $since -ExportDir $export -DbHost $DbHost -Port $Port -User $User -PgBin $cfg.pg.bin
Write-Host ''
Write-Host "Every row in $export must be re-entered in the OLD system once it reopens," -ForegroundColor Yellow
Write-Host 'quoting the V2 number, and ticked off by the owner. Afterwards compare cash'
Write-Host 'counted with the V2 cash movements and sales by payment method.'
$ok = Read-Host "  Rollback authority: type 'RE-ENTRY PLAN APPROVED' to reopen the OLD system"
if ($ok -ne 'RE-ENTRY PLAN APPROVED') { throw 'not approved - both systems stay stopped.' }

# 3. old service settings back, legacy writable, old system started
foreach ($l in Get-Content (Join-Path $dir 'final-backup\services.txt')) {
    $p = $l -split '\|', 3
    if ($p[1] -in 'Application', 'AppDirectory', 'AppParameters' -and $p[2]) { & nssm set $p[0] $p[1] $p[2] | Out-Null }
}
if ($cfg.nginxReload) { & $cfg.nginxExe -s reload }
Invoke-Query 'postgres' "alter database ""$legacy"" reset default_transaction_read_only" | Out-Null
foreach ($s in $cfg.services.api, $cfg.services.web) { & nssm start $s | Out-Null }

# 4. health; the new database is kept, frozen, for forensics
$healthy = $false
for ($i = 0; $i -lt 90; $i++) {
    try { if ((Invoke-WebRequest -UseBasicParsing -Uri "$($cfg.apiBase)/health" -TimeoutSec 3).StatusCode -eq 200) { $healthy = $true; break } } catch { Start-Sleep 1 }
}
Invoke-Query 'postgres' "alter database ""$target"" set default_transaction_read_only = on" | Out-Null
[ordered]@{ runId = $RunId; at = (Get-Date -Format o); authority = $ra; witness = $witness; since = $since; export = $export
            oldHealthy = $healthy; kept = "$target kept read-only for forensics, never dropped" } |
    ConvertTo-Json | Out-File (Join-Path $dir 'rollback-post-write.json') -Encoding utf8
if (-not $healthy) { throw 'the old system did not become healthy - escalate' }
Write-Host 'OLD SYSTEM IS BACK. Clear site data on every terminal, re-enter the exported V2 rows, reconcile.' -ForegroundColor Green
