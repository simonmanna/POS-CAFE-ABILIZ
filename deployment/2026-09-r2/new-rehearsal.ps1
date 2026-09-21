<#
.SYNOPSIS
  One FRESH, fully evidenced rehearsal (gates G2, G4, G6, G7, G8 automated part).

.DESCRIPTION
  Every rehearsal is a new run ID, a new evidence directory, a freshly recreated
  workspace and a fresh state.json. Nothing from an earlier run is reused.

    1. evidence dir     <EvidenceRoot>\<RunId>\   (refused if it exists)
    2. reference check  read-only flag on, optional backup hash vs .sha256 sidecar
    3. baseline         ref_baseline_20260727 built if missing
    4. fresh clone      reference -> dump -> DROP + CREATE workspace -> restore
    5. chain            upgrade.ps1 -RunId <RunId>
    6. numbering        next-numbers.sql on reference and workspace; must agree
    7. restore test     migrated -> dump -> DROP + CREATE restore db -> restore
                        -> counts agree -> API boots against it (/health/startup)
    7b. D21            (-ConfigurePaymentMethods) POS payment methods, as Job 2
    8. rollback drill   (-RollbackDrill) reference -> writable legacy copy ->
                        rollback.ps1 -Drill (old install, timed)
    9. summary          run-summary.json with every hash and verdict

  Only the approved disposable databases are ever dropped or written
  (_safety.ps1). The golden reference is only read.

.EXAMPLE
  $env:PGPASSWORD = '...'
  .\new-rehearsal.ps1 -RunId rehearsal-2026-09-18-r3 -Yes -RollbackDrill
  .\new-rehearsal.ps1 -RunId rehearsal-2026-09-20-r4 -ExpectMapping .\approved-mapping.json -WireParents
#>
param(
    [Parameter(Mandatory = $true)][string]$RunId,
    [string]$ReferenceDb  = 'cafe_reference_20260917',
    [string]$WorkspaceDb  = 'cafe_migration_r1',
    [string]$RestoreDb    = 'cafe_v2_restore_test',
    [string]$RollbackDb   = 'cafe_rollback_test_r1',
    [string]$BaselineDb   = 'ref_baseline_20260727',
    [string]$BackupFile   = 'C:\POS-BACKUPS\2026-09-17\backup-Sep-17.dump',
    [string]$DbHost       = 'localhost',
    [int]   $Port         = 5432,
    [string]$User         = 'postgres',
    [string]$PgBin        = 'C:\Program Files\PostgreSQL\18\bin',
    [string]$EvidenceRoot = 'C:\POS-BACKUPS\work',
    [switch]$Yes,
    [string]$ExpectMapping = '',
    [switch]$WireParents,
    [switch]$RollbackDrill,
    # D21: apply the POS payment-method configuration after the chain (as Job 2 does).
    [switch]$ConfigurePaymentMethods,
    [string]$Providers    = 'MTN,Airtel',
    [string]$OldInstall   = 'C:\projects\POS-CAFE-ABILIZ',
    [int]   $OldPort      = 3004,
    [int]   $BootPort     = 3097
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_safety.ps1"
. "$PSScriptRoot\_kit.ps1"

if (-not $env:PGPASSWORD) { throw 'PGPASSWORD is not set.' }
$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$psql = Join-Path $PgBin 'psql.exe'; $pgDump = Join-Path $PgBin 'pg_dump.exe'
$pgRestore = Join-Path $PgBin 'pg_restore.exe'
$pw = [uri]::EscapeDataString($env:PGPASSWORD)
function Url([string]$db) { "postgresql://$User`:$pw@${DbHost}:$Port/$db" }

foreach ($db in $WorkspaceDb, $RestoreDb) {
    Assert-SafeTarget -Database $db -DbHost $DbHost -Port $Port -User $User -Purpose "fresh rehearsal $RunId (drop + recreate)" -ForbidReference
}
if ($RollbackDrill) {
    Assert-SafeTarget -Database $RollbackDb -DbHost $DbHost -Port $Port -User $User -Purpose "rollback drill $RunId (drop + recreate)" -ForbidReference
}

$dir = New-EvidenceDir $EvidenceRoot $RunId
# Log with a transcript, never by redirecting the script's streams: Windows
# PowerShell 5.1 turns a redirected native stderr line (a Prisma warning) into a
# terminating error under 'Stop'.
Start-Transcript -Path (Join-Path $dir 'console.log') | Out-Null
$summary = [ordered]@{ runId = $RunId; started = (Get-Date -Format o); reference = $ReferenceDb; workspace = $WorkspaceDb; steps = [ordered]@{} }
function Save-Summary { Write-Evidence $dir 'run-summary.json' $summary | Out-Null }
function Step([string]$name, [scriptblock]$body) {
    Write-Host "`n--- $name ---" -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = & $body
        $summary.steps[$name] = [ordered]@{ ok = $true; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); result = $r }
        Save-Summary
    } catch {
        $summary.steps[$name] = [ordered]@{ ok = $false; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); error = "$_" }
        $summary.verdict = 'FAILED'
        Save-Summary
        Stop-Transcript | Out-Null
        throw
    }
}
function Q([string]$db, [string]$sql) {
    $tmp = [IO.Path]::GetTempFileName()
    try {
        Set-Content -Path $tmp -Value $sql -Encoding utf8
        $r = & $psql -h $DbHost -p $Port -U $User -w -X -A -t -F '|' -v ON_ERROR_STOP=1 -d $db -f $tmp
        if ($LASTEXITCODE -ne 0) { throw "query failed on $db" }
        return $r
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}
function Recreate([string]$db) {
    Assert-NoActiveConnections -Database $db -Psql $psql -DbHost $DbHost -Port $Port -User $User
    & $psql -h $DbHost -p $Port -U $User -w -X -q -d postgres -c "drop database if exists `"$db`"" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "drop $db failed" }
    & (Join-Path $PgBin 'createdb.exe') -h $DbHost -p $Port -U $User -w -T template0 -E UTF8 $db
    if ($LASTEXITCODE -ne 0) { throw "createdb $db failed" }
}
function Restore([string]$db, [string]$dump) {
    & $pgRestore -h $DbHost -p $Port -U $User -w -d $db --single-transaction --exit-on-error $dump
    if ($LASTEXITCODE -ne 0) { throw "pg_restore into $db failed" }
}
$countsSql = @'
select 'Invoice', count(*) from "Invoice" union all select 'Payment', count(*) from "Payment"
union all select 'Receipt', count(*) from "Receipt" union all select 'JournalLine', count(*) from "JournalLine"
union all select 'InventoryLedger', count(*) from "InventoryLedger" union all select 'CashMovement', count(*) from "CashMovement"
union all select 'posted_debit', coalesce(sum(l."baseDebit"),0) from "JournalLine" l join "JournalEntry" e on e.id = l."journalEntryId" where e.status = 'posted'
order by 1
'@

Write-Host "=== fresh rehearsal $RunId ===" -ForegroundColor Cyan
Write-Host "  evidence : $dir"

Step 'reference' {
    $ro = Q 'postgres' "select setconfig::text from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase where d.datname = '$ReferenceDb'"
    if ("$ro" -notmatch 'default_transaction_read_only=on') { throw "$ReferenceDb is not read-only - it may have been written. Rebuild it from the backup." }
    $r = [ordered]@{ readOnly = $true }
    if ($BackupFile -and (Test-Path $BackupFile)) {
        $r.backupSha256 = Get-FileSha256 $BackupFile
        $side = "$BackupFile.sha256"
        if (Test-Path $side) {
            $expected = ((Get-Content $side -Raw).Trim() -split '\s+')[0].ToLower()
            if ($expected -ne $r.backupSha256) { throw "backup hash mismatch: $BackupFile" }
            $r.backupHashVerified = $true
        }
    }
    $r
}

Step 'baseline' {
    $exists = Q 'postgres' "select count(*) from pg_database where datname = '$BaselineDb'"
    if ([int]$exists -eq 0) { & "$PSScriptRoot\build-ref-baseline.ps1" -DbName $BaselineDb | Out-Host; if ($LASTEXITCODE) { throw 'baseline build failed' } }
    'present'
}

Step 'freshClone' {
    $dump = Join-Path $dir 'reference.dump'
    & $pgDump -h $DbHost -p $Port -U $User -w -Fc -f $dump $ReferenceDb
    if ($LASTEXITCODE -ne 0) { throw 'pg_dump of the reference failed' }
    Recreate $WorkspaceDb
    Restore $WorkspaceDb $dump
    [ordered]@{ dumpSha256 = Get-FileSha256 $dump; workspace = $WorkspaceDb; createdFresh = (Get-Date -Format o) }
}

Step 'chain' {
    $a = @{ RunId = $RunId; TargetDb = $WorkspaceDb; SourceDb = $ReferenceDb; BaselineDb = $BaselineDb
            DbHost = $DbHost; Port = $Port; User = $User; PgBin = $PgBin; EvidenceRoot = $EvidenceRoot }
    if ($Yes) { $a.Yes = $true }
    if ($ExpectMapping) { $a.ExpectMapping = $ExpectMapping }
    if ($WireParents) { $a.WireParents = $true }
    & "$PSScriptRoot\upgrade.ps1" @a | Out-Host
    $st = Get-Content (Join-Path $dir 'state.json') -Raw | ConvertFrom-Json
    if (@($st.completed).Count -lt 17) { throw 'chain did not complete' }
    [ordered]@{ steps = @($st.completed).Count; kitHash = $st.kitHash; gitCommit = $st.gitCommit }
}

Step 'numbering' {
    $sql = Get-Content "$PSScriptRoot\next-numbers.sql" -Raw
    $ref = Q $ReferenceDb $sql | Where-Object { $_ -and $_ -ne 'SET' }
    $mig = Q $WorkspaceDb $sql | Where-Object { $_ -and $_ -ne 'SET' }
    $ref | Out-File (Join-Path $dir 'next-numbers-reference.txt') -Encoding utf8
    $mig | Out-File (Join-Path $dir 'next-numbers-migrated.txt') -Encoding utf8
    if (($ref -join "`n") -ne ($mig -join "`n")) { throw 'next numbers differ between reference and migrated copy' }
    $bad = @($mig | Where-Object { ($_ -split '\|')[8] -in 'BLOCKER', 'MISSING' })
    if ($bad.Count) { throw "numbering blocker: $($bad -join '; ')" }
    $out = [ordered]@{}
    foreach ($l in $mig) { $c = $l -split '\|'; $out[$c[1]] = [ordered]@{ expectedNext = $c[5]; sequenceNext = $c[7]; status = $c[8] } }
    $out
}

if ($ConfigurePaymentMethods) {
    Step 'paymentMethods' {
        & "$PSScriptRoot\configure-payment-methods.ps1" -TargetDb $WorkspaceDb -EvidenceDir $dir -Providers $Providers -Apply `
            -DbHost $DbHost -Port $Port -User $User -PgBin $PgBin | Out-Host
        @(Get-Content (Join-Path $dir 'payment-methods-state.txt'))
    }
}

Step 'restoreTest' {
    $dump = Join-Path $dir 'migrated-v2.dump'
    & $pgDump -h $DbHost -p $Port -U $User -w -Fc -f $dump $WorkspaceDb
    if ($LASTEXITCODE -ne 0) { throw 'pg_dump of the migrated copy failed' }
    Recreate $RestoreDb
    $sw = [Diagnostics.Stopwatch]::StartNew(); Restore $RestoreDb $dump; $sw.Stop()
    $a = Q $WorkspaceDb $countsSql; $b = Q $RestoreDb $countsSql
    if (($a -join ';') -ne ($b -join ';')) { throw "restored counts differ: $($a -join ';') vs $($b -join ';')" }

    # Boot the NEW API against the restored copy and wait for /health/startup.
    $apiDir = Join-Path $repoRoot 'apps\api'
    if (-not (Test-Path (Join-Path $apiDir 'dist\main.js'))) { throw 'apps/api/dist missing - pnpm build first' }
    $log = Join-Path $dir 'restore-api-boot.log'
    $saved = @{}; $vars = @{ DATABASE_URL = "$(Url $RestoreDb)?schema=public"; PORT = "$BootPort"; NODE_ENV = 'production'; RLS_ALLOW_SUPERUSER = 'true'; BACKUP_DIR = (Join-Path $dir 'api-backups') }
    foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
    try {
        $proc = Start-Process -FilePath 'node' -ArgumentList '--max-http-header-size=65536', 'dist/main.js' -WorkingDirectory $apiDir `
                              -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    } finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
    $health = [ordered]@{}
    try {
        $deadline = (Get-Date).AddSeconds(120)
        foreach ($p in '/health', '/health/ready', '/health/startup') {
            $health[$p] = 0
            while ((Get-Date) -lt $deadline -and $health[$p] -ne 200) {
                try { $health[$p] = (Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$BootPort/api/v1$p" -TimeoutSec 3).StatusCode }
                catch { Start-Sleep -Milliseconds 500 }
            }
        }
    } finally { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    $txt = @("run $RunId", "dump $dump sha256 $(Get-FileSha256 $dump)", "restore seconds $([math]::Round($sw.Elapsed.TotalSeconds,1))",
             'counts (migrated == restored):') + $a + ('api boot: ' + (($health.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '))
    $txt | Out-File (Join-Path $dir 'restore-test.txt') -Encoding utf8
    if (@($health.Values | Where-Object { $_ -ne 200 }).Count) { throw "API did not become healthy against the restored copy (see $log)" }
    [ordered]@{ restoreSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); health = $health }
}

if ($RollbackDrill) {
    Step 'rollbackDrill' {
        $dump = Join-Path $dir 'reference.dump'
        Recreate $RollbackDb
        Restore $RollbackDb $dump
        # A frozen legacy database, exactly as it will be at cutover.
        Q 'postgres' "alter database `"$RollbackDb`" set default_transaction_read_only = on" | Out-Null
        & "$PSScriptRoot\rollback.ps1" -Drill -LegacyDb $RollbackDb -OldInstall $OldInstall -OldPort $OldPort 6>&1 |
            Tee-Object -FilePath (Join-Path $dir 'rollback-test.txt') | Out-Host
        Get-NetTCPConnection -LocalPort $OldPort -State Listen -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
        $t = Get-Content (Join-Path $dir 'rollback-test.txt') -Raw
        if ($t -notmatch 'TESTED RAPID ROLLBACK: ([\d\.]+)s') { throw 'rollback drill did not report a healthy old POS' }
        [ordered]@{ seconds = [double]$Matches[1] }
    }
}

$summary.finished = (Get-Date -Format o)
$summary.verdict = 'PASS'
Save-Summary
Write-Host "`n=== rehearsal $RunId PASSED (automated part) ===" -ForegroundColor Green
Write-Host "  evidence: $dir"
Write-Host '  next    : uat-prepare.ps1 on the workspace, then UAT-CHECKLIST.md (G5).'
Stop-Transcript | Out-Null
