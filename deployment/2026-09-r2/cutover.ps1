<#
.SYNOPSIS
  JOB 2 - production cutover wrapper (gates G10 -> G13). Human-controlled,
  phase by phase, fail-closed. There is NO -Force.

.DESCRIPTION
  The migration itself is the unchanged, rehearsed chain (upgrade.ps1 under the
  unchanged _safety.ps1 guard). It runs in the approved disposable workspace
  `cafe_migration_r1` on the cafe server, restored from the FINAL backup, and is
  PROMOTED to the production name (ALTER DATABASE ... RENAME) only after every
  gate passed. This wrapper adds what production needs around it:

    preflight  G10  authorization file, two signatures, kit/commit/build hashes
                    equal the M0 manifest, databases absent, disk space, tools
    freeze     G11  two-person confirmation, terminal sheets, open state = 0,
                    stop old services, 0 connections, legacy DB read-only
    backup     G11  final dump + globals + uploads + config + service settings,
                    SHA-256 manifest, offsite copy verified, dump restores into
                    cafe_final_ref_<date>, counts equal, next numbers, pre-migration
                    fingerprint
    migrate    G12  fresh workspace from the final dump, the chain with the
                    APPROVED mapping (never prompts), numbering equal, promote,
                    timezone, app-role access
    switch     G13  uploads restored into the new install's STORAGE_LOCAL_DIR
                    (verified against the File table), services -> new install,
                    env checks, health/ready/startup, post-boot fingerprint
                    0 unexpected; records the rollback boundary
    accept     G13  terminals signed, controlled first transaction proves the
                    numbering and the posting chain, Day 0 reconciliation, GO
    abort           pre-write switch-back only (old services, legacy writable)

  Each phase needs the previous one PASSED in cutover-state.json and is run
  once. A failed phase is not retried in place: `abort`, investigate, and start
  a new run ID.

  -Rehearse runs every phase against disposable databases on a test machine:
  the "legacy" database must be an approved Job 1 database, services and nginx
  are only printed, and the new API is started locally for the health checks.

.EXAMPLE
  $env:PGPASSWORD = '...'
  .\cutover.ps1 -RunId cutover-2026-09-27-r1 -Config C:\POS-BACKUPS\cafe-config.json -Authorization C:\POS-BACKUPS\authorization.json -Phase preflight
  ... -Phase freeze / backup / migrate / switch / accept
  ... -Phase abort
#>
param(
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$Config,
    [Parameter(Mandatory = $true)][string]$Authorization,
    [Parameter(Mandatory = $true)][ValidateSet('preflight', 'freeze', 'backup', 'migrate', 'switch', 'accept', 'abort')][string]$Phase,
    [switch]$Rehearse
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_safety.ps1"
. "$PSScriptRoot\_kit.ps1"

if (-not $env:PGPASSWORD) { throw 'PGPASSWORD is not set.' }
if ($RunId -notmatch '^cutover-\d{4}-\d{2}-\d{2}-r\d+$') { throw 'RunId must look like cutover-2026-09-27-r1' }

$cfg  = Get-Content $Config -Raw | ConvertFrom-Json
$auth = Get-Content $Authorization -Raw | ConvertFrom-Json
$pg   = $cfg.pg
$psql = Join-Path $pg.bin 'psql.exe'; $pgDump = Join-Path $pg.bin 'pg_dump.exe'
$pgDumpAll = Join-Path $pg.bin 'pg_dumpall.exe'; $pgRestore = Join-Path $pg.bin 'pg_restore.exe'
$createdb = Join-Path $pg.bin 'createdb.exe'
$runDate    = ($RunId -replace '^cutover-(\d{4})-(\d{2})-(\d{2})-r\d+$', '$1$2$3')
$legacyDb   = $cfg.legacyDb
$workspace  = 'cafe_migration_r1'          # the approved Job 1 workspace name, unchanged guard
$finalRefDb = "cafe_final_ref_$runDate"
$targetDb   = $cfg.targetDb
$evRoot     = Join-Path $cfg.backupRoot 'cutover'
$dir        = Join-Path $evRoot $RunId
$finalDir   = Join-Path $dir 'final-backup'
$stateFile  = Join-Path $dir 'cutover-state.json'
$pw = [uri]::EscapeDataString($env:PGPASSWORD)
function Url([string]$db) { "postgresql://$($pg.superuser):$pw@$($pg.host):$($pg.port)/$db" }

# ------------------------------------------------------------------ helpers
function Q([string]$db, [string]$sql) {
    $tmp = [IO.Path]::GetTempFileName()
    try {
        Set-Content -Path $tmp -Value $sql -Encoding utf8
        $r = & $psql -h $pg.host -p $pg.port -U $pg.superuser -w -X -A -t -q -F '|' -v ON_ERROR_STOP=1 -d $db -f $tmp
        if ($LASTEXITCODE -ne 0) { throw "query failed on $db" }
        return $r
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}
function DbExists([string]$db) { [int](Q 'postgres' "select count(*) from pg_database where datname = '$db'") -gt 0 }
function Connections([string]$db) { [int](Q 'postgres' "select count(*) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()") }
function Svc([string]$verb, [string]$name, [string[]]$more = @()) {
    if ($Rehearse) { Write-Host "  [rehearse] nssm $verb $name $($more -join ' ')" -ForegroundColor DarkYellow; return '' }
    $out = ((& nssm $verb $name @more) -join '') -replace "`0", ''
    if ($LASTEXITCODE -ne 0) { throw "nssm $verb $name failed" }
    return $out
}
# Rehearsal only: answers come from config.rehearseAnswers.<phase> so the whole
# wrapper can be exercised unattended against disposable clones. In production
# every answer is typed by a person.
$script:answerQueue = New-Object System.Collections.Queue
if ($Rehearse -and $cfg.rehearseAnswers -and $cfg.rehearseAnswers.$Phase) { @($cfg.rehearseAnswers.$Phase) | ForEach-Object { $script:answerQueue.Enqueue("$_") } }
function Ask([string]$prompt) {
    if ($Rehearse -and $script:answerQueue.Count) { $a = $script:answerQueue.Dequeue(); Write-Host "$prompt : $a  [rehearse answer]"; return $a }
    return (Read-Host $prompt)
}
function Confirm-Human([string]$what) {
    Write-Host ''
    Write-Host "HUMAN CONFIRMATION - $what" -ForegroundColor Yellow
    $approvers = @($auth.authorizedApprovers)
    $op = Ask '  Operator full name'
    $ap = Ask '  Approver full name (a second person)'
    if (-not $op -or -not $ap -or $op -eq $ap) { throw 'Two different named people must confirm.' }
    if ($approvers -notcontains $ap) { throw "Approver '$ap' is not in authorization.authorizedApprovers." }
    $phrase = "$Phase $($auth.kitHash.Substring(0, 8))"
    $typed = Ask "  Approver: type exactly '$phrase'"
    if ($typed -ne $phrase) { throw 'Confirmation phrase mismatch - nothing was done.' }
    return [ordered]@{ operator = $op; approver = $ap; at = (Get-Date -Format o) }
}
function Health([string]$base) {
    $h = [ordered]@{}; $deadline = (Get-Date).AddSeconds(150)
    foreach ($p in '/health', '/health/ready', '/health/startup') {
        $h[$p] = 0
        while ((Get-Date) -lt $deadline -and $h[$p] -ne 200) {
            try { $h[$p] = (Invoke-WebRequest -UseBasicParsing -Uri "$base$p" -TimeoutSec 4).StatusCode } catch { Start-Sleep 1 }
        }
    }
    return $h
}
function Invoke-Tsx([string]$script, [string[]]$tsxArgs, [hashtable]$envVars = @{}) {
    Push-Location (Resolve-Path "$PSScriptRoot\..\..").Path
    $saved = @{}
    foreach ($k in $envVars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envVars[$k]) }
    try { & pnpm tsx "deployment/2026-09-r2/$script" @tsxArgs | Out-Host; return $LASTEXITCODE }
    finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }; Pop-Location }
}
function Get-NextNumbers([string]$db) {
    $rows = Q $db (Get-Content "$PSScriptRoot\next-numbers.sql" -Raw) | Where-Object { $_ -and $_ -ne 'SET' }
    $o = [ordered]@{}
    foreach ($l in $rows) { $c = $l -split '\|'; $o["$($c[0])/$($c[1])"] = [ordered]@{ maxUsed = $c[2]; expectedNext = $c[5]; sequenceNext = $c[7]; status = $c[8] } }
    return $o
}
$countsSql = @'
select 'Invoice', count(*) from "Invoice" union all select 'Payment', count(*) from "Payment"
union all select 'Receipt', count(*) from "Receipt" union all select 'JournalEntry', count(*) from "JournalEntry"
union all select 'JournalLine', count(*) from "JournalLine" union all select 'InventoryLedger', count(*) from "InventoryLedger"
union all select 'CashMovement', count(*) from "CashMovement" union all select 'CashSession', count(*) from "CashSession"
union all select 'Order', count(*) from "Order" union all select '_prisma_migrations', count(*) from "_prisma_migrations"
union all select 'posted_debit', coalesce(sum(l."baseDebit"),0) from "JournalLine" l join "JournalEntry" e on e.id = l."journalEntryId" where e.status::text = 'posted'
union all select 'posted_credit', coalesce(sum(l."baseCredit"),0) from "JournalLine" l join "JournalEntry" e on e.id = l."journalEntryId" where e.status::text = 'posted'
order by 1
'@
$openStateSql = @'
select 'open_shifts', count(*) from "CashSession" where status::text = 'open'
union all select 'orders_not_invoiced', count(*) from "Order" where "invoiceId" is null and status::text not in ('closed','cancelled')
union all select 'parked_carts', count(*) from "PosHold"
union all select 'kds_tickets_new', count(*) from "KitchenTicket" where status::text = 'new'
'@

# ------------------------------------------------------------------ state
$order = 'preflight', 'freeze', 'backup', 'migrate', 'switch', 'accept'
if (-not (Test-Path $dir)) {
    if ($Phase -ne 'preflight') { throw "no run $RunId yet - start with -Phase preflight" }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
$state = if (Test-Path $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json } else {
    [pscustomobject]@{ runId = $RunId; rehearse = [bool]$Rehearse; phases = [pscustomobject]@{} } }
if ([bool]$state.rehearse -ne [bool]$Rehearse) { throw 'This run was started with a different -Rehearse setting.' }
function Save { $state | ConvertTo-Json -Depth 10 | Out-File $stateFile -Encoding utf8 }
function Passed([string]$p) { $x = $state.phases.$p; return ($x -and $x.status -eq 'PASSED') }
function Record([string]$p, [string]$status, $data) {
    $state.phases | Add-Member -NotePropertyName $p -NotePropertyValue ([ordered]@{ status = $status; at = (Get-Date -Format o); data = $data }) -Force
    Save
}

if ($Phase -ne 'abort') {
    if ($state.phases.$Phase -and -not ($Phase -eq 'preflight' -and $state.phases.preflight.status -eq 'FAILED')) { throw "phase '$Phase' already ran ($($state.phases.$Phase.status)). A phase runs once per run ID." }
    $i = [array]::IndexOf($order, $Phase)
    if ($i -gt 0 -and -not (Passed $order[$i - 1])) { throw "phase '$($order[$i - 1])' has not PASSED." }
    if ($state.phases.abort) { throw 'this run was aborted. Start a new run ID.' }
}

# Transcript per phase (see new-rehearsal.ps1: never redirect this script's streams).
Start-Transcript -Path (Join-Path $dir "console-$Phase-$(Get-Date -Format 'yyyyMMdd-HHmmss').log") | Out-Null
Write-Host "=== JOB 2 CUTOVER  run $RunId  phase $Phase $(if ($Rehearse) { '(REHEARSAL)' } else { '(PRODUCTION)' }) ===" -ForegroundColor Cyan
Write-Host "  legacy : $legacyDb   final ref: $finalRefDb   workspace: $workspace   target: $targetDb"
Write-Host "  evidence: $dir"

# The only live database this wrapper ever touches is the legacy one, and only
# to read it, to stop its connections and to set/reset read-only. In rehearsal
# even that must be a disposable copy.
if ($Rehearse) {
    Assert-SafeTarget -Database $legacyDb -DbHost $pg.host -Port $pg.port -User $pg.superuser -Purpose 'cutover REHEARSAL legacy stand-in' -ForbidReference
} elseif ($legacyDb -ne 'POS-CAFE') { throw "production legacyDb must be 'POS-CAFE' (config says '$legacyDb')" }
if ($targetDb -in @('POS-CAFE', $legacyDb, $workspace, $finalRefDb)) { throw "targetDb '$targetDb' collides with another database role in this run" }

try {
switch ($Phase) {

# ================================================================== PREFLIGHT (G10)
'preflight' {
    $f = New-Object System.Collections.Generic.List[string]
    # Governance findings (M0 state, signatures, decisions). They block in
    # production; in -Rehearse they are listed, so a dress rehearsal can run
    # before the sheet is signed and still prove the check works.
    $gov = New-Object System.Collections.Generic.List[string]
    $man = Get-Content $cfg.releaseManifest -Raw | ConvertFrom-Json
    $kit = Get-KitManifest
    if (-not $man.passed) { $gov.Add('release manifest did not pass M0') }
    if (-not $man.newTag) { $gov.Add('release manifest has no release tag') }
    if ($kit.kitHash -ne $man.kitHash) { $f.Add("kit hash $($kit.kitHash) != M0 manifest $($man.kitHash)") }
    if ($auth.kitHash -ne $man.kitHash) { $gov.Add('authorization was signed for a different kit') }
    if ($auth.newCommit -ne $man.newCommit) { $gov.Add('authorization was signed for a different commit') }
    foreach ($g in 'M0', 'G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10') {
        $s = $auth.gates.$g
        if (-not $s -or $s.status -ne 'PASS' -or -not $s.signedBy -or -not $s.date -or -not $s.evidence) { $gov.Add("gate $g is not signed PASS with evidence") }
    }
    foreach ($r in 'owner', 'engineer', 'rollbackAuthority') { if (-not $auth.signatures.$r.name) { $gov.Add("signature missing: $r") } }
    if (@($auth.authorizedApprovers).Count -lt 1) { $gov.Add('no authorizedApprovers') }
    if (-not $auth.maintenanceWindow.start) { $gov.Add('maintenance window not recorded') }
    if (-not $auth.approvedMapping) { $gov.Add('approved G3 mapping missing') }
    $decisionsOpen = @($auth.decisions.PSObject.Properties | Where-Object { -not $_.Value.decidedBy })
    if ($decisionsOpen.Count) { $gov.Add("owner decisions not signed: $(($decisionsOpen | ForEach-Object Name) -join ', ')") }

    # New install must be the frozen build.
    foreach ($b in $man.builds.PSObject.Properties) {
        $t = Get-TreeHash (Join-Path $cfg.newInstall $b.Name.Replace('/', '\'))
        if (-not $t -or $t.hash -ne $b.Value.hash) { $f.Add("new install $($b.Name) does not match the M0 build") }
    }
    if (-not $Rehearse -and -not (Test-Path $cfg.oldInstall)) { $f.Add("old install missing: $($cfg.oldInstall) - it is the rollback") }

    if (-not (DbExists $legacyDb)) { $f.Add("legacy database $legacyDb not found") }
    foreach ($db in $finalRefDb, $targetDb) { if (DbExists $db) { $f.Add("$db already exists - the target must be NEW") } }
    if (-not (DbExists $cfg.baselineDb)) { $f.Add("equivalence baseline $($cfg.baselineDb) missing (build-ref-baseline.ps1)") }
    if ((Connections $workspace) -gt 0) { $f.Add("$workspace has connections") }

    $size = [int64](Q 'postgres' "select pg_database_size('$legacyDb')")
    foreach ($p in $cfg.backupRoot, $cfg.offsiteDir) {
        if (-not (Test-Path $p)) { $f.Add("backup destination unavailable: $p"); continue }
        $free = (Get-PSDrive -Name ((Resolve-Path $p).Drive.Name)).Free
        if ($free -lt 5 * $size + 512MB) { $f.Add("not enough free space on $p") }
    }
    $pgv = & $pgDump --version
    $role = Q $legacyDb "select current_user || '|' || rolsuper || '|' || rolbypassrls from pg_roles where rolname = current_user"
    $data = [ordered]@{ failures = @($f); kitHash = $kit.kitHash; manifestCommit = $man.newCommit; pgDump = "$pgv"; legacySizeBytes = $size; migrationRole = "$role"
                        appDbRole = $cfg.appDbRole; rlsDecision = $auth.decisions.rlsPosture.value }
    Write-Evidence $dir 'preflight.json' $data | Out-Null
    $data.governance = @($gov)
    $gov | ForEach-Object { Write-Host "  $(if ($Rehearse) { 'WOULD BLOCK IN PRODUCTION' } else { 'FAIL' }) $_" -ForegroundColor $(if ($Rehearse) { 'Yellow' } else { 'Red' }) }
    if (-not $Rehearse) { foreach ($x in $gov) { $f.Add($x) } }
    if ($f.Count) { $f | ForEach-Object { Write-Host "  FAIL $_" -ForegroundColor Red }; Record 'preflight' 'FAILED' $data; throw 'PREFLIGHT FAILED - nothing was changed.' }
    Record 'preflight' 'PASSED' $data
}

# ================================================================== FREEZE (G11 a)
'freeze' {
    $who = Confirm-Human 'stop trading and freeze the legacy database'
    foreach ($t in @($cfg.terminals)) {
        $a = Ask "  Terminal '$t': BEFORE-backup sheet signed, offline queue 0, cart empty, logged out? (yes/no)"
        if ($a -ne 'yes') { throw "terminal $t is not ready - trading is NOT stopped yet, nothing changed." }
    }
    $pre = Q $legacyDb $openStateSql
    $bad = @($pre | Where-Object { [int](($_ -split '\|')[1]) -ne 0 })
    if ($bad.Count) { throw "open operational state in the legacy database: $($bad -join '; '). Close it in the OLD system first." }

    $stoppedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
    Svc 'stop' $cfg.services.web | Out-Null
    Svc 'stop' $cfg.services.api | Out-Null
    if (-not $Rehearse) {
        foreach ($sv in $cfg.services.api, $cfg.services.web) {
            $st = ((& nssm status $sv) -join '') -replace "`0", ''
            if ($st -notmatch 'SERVICE_STOPPED') { throw "service $sv is not stopped ($st)" }
        }
    }
    $deadline = (Get-Date).AddSeconds(60)
    while ((Connections $legacyDb) -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep 2 }
    $conns = Connections $legacyDb
    if ($conns -gt 0) {
        $who2 = Q 'postgres' "select coalesce(application_name,'') || '@' || coalesce(client_addr::text,'local') from pg_stat_activity where datname = '$legacyDb' and pid <> pg_backend_pid()"
        throw "legacy database still has $conns connection(s): $($who2 -join ', '). Find and stop them (nothing is terminated automatically), then abort and restart with a new run ID."
    }
    Q 'postgres' "alter database `"$legacyDb`" set default_transaction_read_only = on" | Out-Null
    $post = Q $legacyDb $openStateSql
    $data = [ordered]@{ confirmedBy = $who; tradingStoppedAtUtc = $stoppedAt; openStateBefore = @($pre); openStateAfter = @($post); legacyReadOnly = $true }
    Write-Evidence $dir 'freeze.json' $data | Out-Null
    Record 'freeze' 'PASSED' $data
}

# ================================================================== BACKUP (G11 b)
'backup' {
    New-Item -ItemType Directory -Path $finalDir, "$finalDir\uploads", "$finalDir\config" -Force | Out-Null
    $stoppedAt = [datetime]::ParseExact($state.phases.freeze.data.tradingStoppedAtUtc, 'yyyy-MM-dd HH:mm:ss', $null)
    if ((Connections $legacyDb) -gt 0) { throw 'legacy database has connections again - stop' }

    $dump = Join-Path $finalDir 'final.dump'
    $t0 = (Get-Date).ToUniversalTime()
    & $pgDump -h $pg.host -p $pg.port -U $pg.superuser -w -Fc -f $dump $legacyDb
    if ($LASTEXITCODE -ne 0) { throw 'final pg_dump failed' }
    & $pgDumpAll -h $pg.host -p $pg.port -U $pg.superuser -w --globals-only -f (Join-Path $finalDir 'globals.sql')
    if ($LASTEXITCODE -ne 0) { throw 'pg_dumpall --globals-only failed' }
    if ($t0 -lt $stoppedAt) { throw 'dump started before the trading-stop timestamp' }

    if ($cfg.uploadsDir -and (Test-Path $cfg.uploadsDir)) {
        & robocopy $cfg.uploadsDir "$finalDir\uploads" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw 'uploads copy failed' }
    } elseif (-not $Rehearse) { throw "uploads directory not found: $($cfg.uploadsDir)" }
    foreach ($c in @($cfg.configFiles)) {
        if (Test-Path $c) { Copy-Item $c (Join-Path "$finalDir\config" (($c -replace '[:\\/]', '_').TrimStart('_'))) }
        elseif (-not $Rehearse) { throw "config file missing: $c" }
    }
    $svcDump = foreach ($s in $cfg.services.api, $cfg.services.web) {
        foreach ($k in 'Application', 'AppDirectory', 'AppParameters', 'ObjectName', 'AppEnvironmentExtra') { "$s|$k|$(Svc 'get' $s @($k))" }
    }
    $svcDump | Out-File (Join-Path $finalDir 'services.txt') -Encoding utf8

    $files = Get-ChildItem $finalDir -Recurse -File | Sort-Object FullName
    $hashes = [ordered]@{}; foreach ($x in $files) { $hashes[$x.FullName.Substring($finalDir.Length + 1)] = Get-FileSha256 $x.FullName }
    $bm = [ordered]@{ runId = $RunId; tradingStoppedAtUtc = $state.phases.freeze.data.tradingStoppedAtUtc; dumpStartedUtc = $t0.ToString('o'); legacyDb = $legacyDb; files = $hashes }
    $bmPath = Write-Evidence $dir 'backup-manifest.json' $bm

    # Offsite copy, verified by hash.
    $off = Join-Path $cfg.offsiteDir $RunId
    & robocopy $finalDir $off /E /R:1 /W:1 /NFL /NDL /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'offsite copy failed' }
    Copy-Item $bmPath $off
    foreach ($k in $hashes.Keys) { if ((Get-FileSha256 (Join-Path $off $k)) -ne $hashes[$k]) { throw "offsite copy hash mismatch: $k" } }

    # The final dump must restore. The restored copy becomes the read-only reference.
    & $createdb -h $pg.host -p $pg.port -U $pg.superuser -w -T template0 -E UTF8 $finalRefDb
    if ($LASTEXITCODE -ne 0) { throw "createdb $finalRefDb failed" }
    & $pgRestore -h $pg.host -p $pg.port -U $pg.superuser -w -d $finalRefDb --single-transaction --exit-on-error $dump
    if ($LASTEXITCODE -ne 0) { throw 'the FINAL dump does not restore - STOP, abort, the cafe reopens on the old system' }
    Q 'postgres' "alter database `"$finalRefDb`" set default_transaction_read_only = on" | Out-Null
    $a = Q $legacyDb $countsSql; $b = Q $finalRefDb $countsSql
    if (($a -join ';') -ne ($b -join ';')) { throw "restored counts differ from the legacy database: $($a -join ';') vs $($b -join ';')" }

    $nn = Get-NextNumbers $finalRefDb
    $blk = @($nn.GetEnumerator() | Where-Object { $_.Value.status -in 'BLOCKER', 'MISSING' })
    if ($blk.Count) { throw "numbering blocker in the final backup: $(($blk | ForEach-Object Key) -join ', ')" }
    Write-Evidence $dir 'expected-next-numbers.json' $nn | Out-Null
    $rc = Invoke-Tsx 'fingerprint.ts' @('--capture', (Join-Path $dir 'fingerprint-pre.json')) @{ DATABASE_URL = (Url $finalRefDb) }
    if ($rc -ne 0) { throw 'pre-migration fingerprint capture failed' }

    $data = [ordered]@{ backupManifestSha256 = Get-FileSha256 $bmPath; finalDumpSha256 = $hashes['final.dump']; offsite = $off; finalRefDb = $finalRefDb; counts = @($b); expectedNext = $nn }
    Record 'backup' 'PASSED' $data
}

# ================================================================== MIGRATE (G12)
'migrate' {
    $bm = Get-Content (Join-Path $dir 'backup-manifest.json') -Raw | ConvertFrom-Json
    foreach ($p in $bm.files.PSObject.Properties) {
        if ((Get-FileSha256 (Join-Path $finalDir $p.Name)) -ne $p.Value) { throw "final backup file changed since the manifest: $($p.Name)" }
    }
    if ((Get-Item (Join-Path $finalDir 'final.dump')).LastWriteTimeUtc -lt [datetime]::ParseExact($bm.tradingStoppedAtUtc, 'yyyy-MM-dd HH:mm:ss', $null)) {
        throw 'final.dump is older than the trading stop'
    }
    $who = Confirm-Human 'migrate the final backup into a new database'

    # Fresh workspace (approved Job 1 name, unchanged guard), empty before restore.
    Assert-SafeTarget -Database $workspace -DbHost $pg.host -Port $pg.port -User $pg.superuser -Purpose "Job 2 workspace for $RunId (fresh from the final backup)" -ForbidReference
    Assert-NoActiveConnections -Database $workspace -Psql $psql -DbHost $pg.host -Port $pg.port -User $pg.superuser
    Q 'postgres' "drop database if exists `"$workspace`"" | Out-Null
    $owner = Q 'postgres' "select pg_get_userbyid(datdba) from pg_database where datname = '$legacyDb'"
    & $createdb -h $pg.host -p $pg.port -U $pg.superuser -w -T template0 -E UTF8 -O "$owner" $workspace
    if ($LASTEXITCODE -ne 0) { throw "createdb $workspace failed" }
    if ([int](Q $workspace "select count(*) from pg_tables where schemaname = 'public'") -ne 0) { throw 'workspace is not empty before restore' }
    & $pgRestore -h $pg.host -p $pg.port -U $pg.superuser -w -d $workspace --single-transaction --exit-on-error (Join-Path $finalDir 'final.dump')
    if ($LASTEXITCODE -ne 0) { throw 'restore into the workspace failed' }

    # The rehearsed chain, unchanged. Approved mapping: never prompts.
    $mapFile = Join-Path $dir 'approved-mapping.json'
    $auth.approvedMapping | ConvertTo-Json | Out-File $mapFile -Encoding utf8
    $a = @{ RunId = $RunId; TargetDb = $workspace; SourceDb = $finalRefDb; BaselineDb = $cfg.baselineDb; DbHost = $pg.host; Port = $pg.port
            User = $pg.superuser; PgBin = $pg.bin; EvidenceRoot = $evRoot; ExpectMapping = $mapFile }
    if ($auth.decisions.wireParents.value -eq $true) { $a.WireParents = $true }
    & "$PSScriptRoot\upgrade.ps1" @a | Out-Host
    $st = Get-Content (Join-Path $dir 'state.json') -Raw | ConvertFrom-Json
    if (@($st.completed).Count -lt 17) { throw 'migration chain incomplete' }
    $fp = Get-Content (Join-Path $dir 'fingerprint.json') -Raw | ConvertFrom-Json
    if ($fp.counts.unexpected -ne 0) { throw 'fingerprint reports unexpected differences' }

    $n1 = Get-NextNumbers $finalRefDb; $n2 = Get-NextNumbers $workspace
    if (($n1 | ConvertTo-Json -Depth 4) -ne ($n2 | ConvertTo-Json -Depth 4)) { throw 'next numbers differ after migration' }

    # D21: explicit POS payment methods + mobile_money / card_clearing mappings.
    # Configuration only (additive), applied to the workspace before promotion so
    # the unchanged guard covers it. History was fingerprinted above.
    $d21 = $auth.decisions.D21_paymentMethods
    if ($d21 -and $d21.value -eq 'configure') {
        $prov = if ($d21.providers) { "$($d21.providers)" } else { 'MTN,Airtel' }
        & "$PSScriptRoot\configure-payment-methods.ps1" -TargetDb $workspace -EvidenceDir $dir -Providers $prov -Apply `
            -DbHost $pg.host -Port $pg.port -User $pg.superuser -PgBin $pg.bin | Out-Host
    }

    # Promote: the proven workspace becomes the production database.
    Assert-NoActiveConnections -Database $workspace -Psql $psql -DbHost $pg.host -Port $pg.port -User $pg.superuser
    Q 'postgres' "alter database `"$workspace`" rename to `"$targetDb`"" | Out-Null
    if ($auth.decisions.databaseTimezone.value) { Q 'postgres' "alter database `"$targetDb`" set timezone = '$($auth.decisions.databaseTimezone.value)'" | Out-Null }

    # The application role must reach every table, including the new ones.
    $appRole = $cfg.appDbRole
    $noAccess = Q $targetDb "select count(*) from pg_tables where schemaname = 'public' and not has_table_privilege('$appRole', format('%I.%I', schemaname, tablename), 'SELECT,INSERT,UPDATE')"
    if ([int]$noAccess -ne 0) { throw "application role '$appRole' lacks privileges on $noAccess table(s) in $targetDb. Do not start the API; abort (G0/G9 role finding)." }
    $drift = Q $targetDb "select count(*) from pg_namespace where nspname = 'legacy_archive'"
    $data = [ordered]@{ confirmedBy = $who; workspaceOwner = "$owner"; promotedTo = $targetDb; chainSteps = @($st.completed).Count; fingerprintUnexpected = 0
                        legacyArchivePresent = ([int]$drift -eq 1); nextNumbers = $n2 }
    Record 'migrate' 'PASSED' $data
}

# ================================================================== SWITCH (G13 a)
'switch' {
    $envFile = Join-Path $cfg.newInstall 'apps\api\.env'
    $envText = if (Test-Path $envFile) { Get-Content $envFile -Raw } else { '' }
    $f = New-Object System.Collections.Generic.List[string]
    if ($envText -notmatch "DATABASE_URL\s*=\s*`"?postgres(ql)?://[^`"\r\n]*/$([regex]::Escape($targetDb))(\?|`"|\s|$)") { $f.Add("new .env DATABASE_URL does not point at $targetDb") }
    if ($envText -notmatch 'NODE_ENV\s*=\s*"?production') { $f.Add('new .env NODE_ENV is not production') }
    if ($envText -notmatch 'BACKUP_DIR\s*=\s*"?[A-Za-z]:') { $f.Add('new .env BACKUP_DIR is not set (decision D13)') }
    if ($envText -match 'ENABLE_[A-Z_]+\s*=\s*"?true') { $f.Add('a feature flag ENABLE_* is true (decision D14: all false at cutover)') }
    # Images: the new install needs its OWN storage dir (never inside the old
    # install, never the live backup dir). Parsed here, used by the restore
    # step below. Relative values resolve against apps\api, like the old .env.
    $storageDir = $null
    if ($envText -match '(?m)^\s*STORAGE_LOCAL_DIR\s*=\s*"?([^"\r\n]+?)"?\s*$') {
        $storageDir = [Environment]::ExpandEnvironmentVariables($Matches[1].Trim())
        if (-not [IO.Path]::IsPathRooted($storageDir)) { $storageDir = Join-Path (Join-Path $cfg.newInstall 'apps\api') $storageDir }
        if ($cfg.oldInstall) {
            $oldFull = [IO.Path]::GetFullPath($cfg.oldInstall).TrimEnd('\')
            $storFull = [IO.Path]::GetFullPath($storageDir).TrimEnd('\')
            if ($storFull.Equals($oldFull, [StringComparison]::OrdinalIgnoreCase) -or $storFull.StartsWith("$oldFull\", [StringComparison]::OrdinalIgnoreCase)) {
                $f.Add("new .env STORAGE_LOCAL_DIR must not live inside the old install ($($cfg.oldInstall))")
            }
        }
    } else { $f.Add('new .env STORAGE_LOCAL_DIR is not set - uploaded images cannot be served') }
    if ($f.Count -and -not $Rehearse) { $f | ForEach-Object { Write-Host "  FAIL $_" -ForegroundColor Red }; throw 'new install configuration is not ready' }
    $f | ForEach-Object { Write-Host "  [rehearse] would fail: $_" -ForegroundColor DarkYellow }
    $who = Confirm-Human 'start the NEW system on the migrated database'

    # --- images: restore the final backup's uploads into the NEW storage dir ---
    # Files are addressed by a relative storageKey under STORAGE_LOCAL_DIR, so
    # a tree copy keeps every image valid. The File table has no hash column,
    # so the copy is verified by: robocopy exit code, file count vs File rows,
    # byte totals (copy integrity) and storageKey spot-checks (resolution).
    # This gate must pass BEFORE the API starts; failure = do not start, abort,
    # investigate, new run ID.
    $storageDest = if ($Rehearse) { Join-Path $dir 'api-uploads' } else { $storageDir }
    if (-not $storageDest) { throw 'no STORAGE_LOCAL_DIR for the new install - images cannot be restored. Fix the new .env, then start a NEW run ID.' }
    $uploadsSrc = Join-Path $finalDir 'uploads'
    if (-not (Test-Path $uploadsSrc)) { throw "final backup has no uploads folder: $uploadsSrc (the rehearsal config must set uploadsDir). Nothing was started." }
    Write-Host '  Restoring uploaded images into the new storage dir...' -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $storageDest -Force | Out-Null
    & robocopy $uploadsSrc $storageDest /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "uploads restore failed (robocopy exit $LASTEXITCODE) - the API must NOT start; investigate, then abort and use a new run ID" }
    $srcFiles = @(Get-ChildItem $uploadsSrc -Recurse -File)
    $dstFiles = @(Get-ChildItem $storageDest -Recurse -File)
    $fileRows = [int](Q $targetDb 'select count(*) from "File"')
    $srcBytes = [int64]($srcFiles | Measure-Object Length -Sum).Sum
    $dstBytes = [int64]($dstFiles | Measure-Object Length -Sum).Sum
    $samples = @(Q $targetDb 'select "storageKey" from "File" order by random() limit 5')
    $missing = @($samples | Where-Object { -not (Test-Path (Join-Path $storageDest $_)) })
    $up = [ordered]@{ source = $uploadsSrc; destination = $storageDest; sourceFiles = $srcFiles.Count; restoredFiles = $dstFiles.Count
                      sourceBytes = $srcBytes; restoredBytes = $dstBytes; fileRows = $fileRows
                      storageKeysChecked = $samples.Count; storageKeysMissing = @($missing) }
    Write-Evidence $dir 'uploads-restore.json' $up | Out-Null
    if ($dstFiles.Count -ne $fileRows) { throw "uploads restore: $($dstFiles.Count) file(s) on disk but the File table has $fileRows row(s) - reconcile BEFORE the API starts (never delete rows to make this pass; see uploads-restore.json)" }
    if ($srcBytes -ne $dstBytes) { throw "uploads restore byte totals differ (source $srcBytes vs restored $dstBytes) - the copy is incomplete; the API must NOT start" }
    if ($missing.Count) { throw "sampled storageKey(s) missing on disk: $($missing -join ', ') - the API must NOT start" }
    Write-Host "  uploads restored: $($dstFiles.Count) file(s), $dstBytes byte(s); File rows: $fileRows - OK (uploads-restore.json)" -ForegroundColor Green

    $switchedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
    if ($Rehearse) {
        $apiDir = Join-Path $cfg.newInstall 'apps\api'
        $vars = @{ DATABASE_URL = "$(Url $targetDb)?schema=public"; PORT = "$($cfg.rehearseApiPort)"; NODE_ENV = 'production'; RLS_ALLOW_SUPERUSER = 'true'; BACKUP_DIR = (Join-Path $dir 'api-backups'); STORAGE_LOCAL_DIR = $storageDest }
        $saved = @{}; foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
        try { $proc = Start-Process node -ArgumentList '--max-http-header-size=65536', 'dist/main.js' -WorkingDirectory $apiDir -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'new-api.log') -RedirectStandardError (Join-Path $dir 'new-api.err.log') }
        finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
        $base = "http://localhost:$($cfg.rehearseApiPort)/api/v1"
    } else {
        foreach ($s in $cfg.newServices.PSObject.Properties) {
            foreach ($k in $s.Value.PSObject.Properties) { Svc 'set' $s.Name @($k.Name, $k.Value) | Out-Null }
        }
        if ($cfg.nginxReload) { & $cfg.nginxExe -s reload; if ($LASTEXITCODE) { throw 'nginx reload failed' } }
        Svc 'start' $cfg.services.api | Out-Null
        Svc 'start' $cfg.services.web | Out-Null
        $base = $cfg.apiBase
    }
    $h = Health $base
    try {
        if (@($h.Values | Where-Object { $_ -ne 200 }).Count) { throw "new API not healthy: $(($h.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ') - run -Phase abort" }
        $rc = Invoke-Tsx 'fingerprint.ts' @('--ab', '--source', (Url $finalRefDb), '--target', (Url $targetDb), '--out', (Join-Path $dir 'fingerprint-after-boot.json'))
        if ($rc -ne 0) { throw 'post-boot fingerprint has unexpected differences - run -Phase abort' }
    } finally { if ($Rehearse -and $proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } }
    $data = [ordered]@{ confirmedBy = $who; switchedAtUtc = $switchedAt; health = $h; envFindings = @($f)
                        note = 'switchedAtUtc is the rollback boundary for rollback.ps1 -ReportV2Writes' }
    Record 'switch' 'PASSED' $data
    Write-Host "`nNow: terminal-checklist.md AFTER section on every terminal, then -Phase accept." -ForegroundColor Yellow
}

# ================================================================== ACCEPT (G13 b)
'accept' {
    foreach ($t in @($cfg.terminals)) {
        $a = Ask "  Terminal '$t': AFTER sheet signed (site data cleared, new build, login, register bound, receipt+KOT printed, drawer)? (yes/no)"
        if ($a -ne 'yes') { throw "terminal $t not accepted" }
    }
    $boundary = $state.phases.switch.data.switchedAtUtc
    $exp = Get-Content (Join-Path $dir 'expected-next-numbers.json') -Raw | ConvertFrom-Json
    $inv = Ask '  Controlled first sale: invoice number printed'
    $rct = Ask '  Controlled first sale: receipt number printed'
    $org = ($exp.PSObject.Properties | Where-Object { $_.Name -like '*/invoice' } | Select-Object -First 1)
    $okInv = $inv -in @($org.Value.expectedNext, $org.Value.sequenceNext)
    $rOrg = ($exp.PSObject.Properties | Where-Object { $_.Name -like '*/receipt' } | Select-Object -First 1)
    $okRct = $rct -in @($rOrg.Value.expectedNext, $rOrg.Value.sequenceNext)
    if (-not $okInv) { throw "invoice $inv is not the expected next number ($($org.Value.expectedNext))" }
    if (-not $okRct) { throw "receipt $rct is not the expected next number ($($rOrg.Value.expectedNext))" }
    $chain = Q $targetDb @"
select i."invoiceNumber", i.status::text, i."paymentStatus"::text, (i."journalEntryId" is not null),
       (select count(*) from "Receipt" r where r."invoiceId" = i.id and r."receiptNumber" = '$rct'),
       (select count(*) from "PaymentAllocation" pa where pa."invoiceId" = i.id)
  from "Invoice" i where i."invoiceNumber" = '$inv' and i."createdAt" >= '$boundary'
"@
    $c = "$chain" -split '\|'
    if ($c.Count -lt 6 -or $c[3] -ne 't' -or [int]$c[4] -ne 1 -or [int]$c[5] -lt 1) { throw "controlled sale $inv does not show invoice+journal+receipt+payment: '$chain'" }
    Write-Host '  The controlled sale stays in the books: keep it as a real sale, or refund/void it in the application with a reason. Never delete it.'
    & "$PSScriptRoot\reconcile.ps1" -Database $targetDb -Boundary $boundary -Label day0 -EvidenceDir $dir -DbHost $pg.host -Port $pg.port -User $pg.superuser -PgBin $pg.bin
    $recon = $LASTEXITCODE
    if ($recon -eq 1) { throw 'Day 0 reconciliation has findings - read reconcile-day0.json before GO' }
    $who = Confirm-Human 'GO-LIVE: the cafe trades on the new system'
    $data = [ordered]@{ confirmedBy = $who; controlledSale = [ordered]@{ invoice = $inv; receipt = $rct; chain = "$chain" }; reconcileDay0 = $recon; boundaryUtc = $boundary }
    Record 'accept' 'PASSED' $data
    Write-Host "`nGO-LIVE recorded. Reconcile at end of Day 1, Day 3, Day 7, Day 30 (reconcile.ps1 -Boundary '$boundary')." -ForegroundColor Green
}

# ================================================================== ABORT (pre-write)
'abort' {
    if (Passed 'accept') { throw 'GO-LIVE was accepted. Use rollback.ps1 -Production (post-write procedure), not abort.' }
    if ($state.phases.switch -and (DbExists $targetDb)) {
        $since = if ($state.phases.switch.data.switchedAtUtc) { $state.phases.switch.data.switchedAtUtc } else { $state.phases.freeze.data.tradingStoppedAtUtc }
        $n = [int](Q $targetDb "select (select count(*) from `"Invoice`" where `"createdAt`" >= '$since') + (select count(*) from `"Payment`" where `"createdAt`" >= '$since') + (select count(*) from `"CashMovement`" where `"createdAt`" >= '$since')")
        if ($n -gt 0) { throw "the new system has written $n business row(s) since $since. This is a POST-WRITE rollback: rollback.ps1 -Production -PostWrite." }
    }
    $who = Confirm-Human 'ABORT: return the cafe to the old system (pre-write)'
    if ($state.phases.switch) {
        Svc 'stop' $cfg.services.web | Out-Null; Svc 'stop' $cfg.services.api | Out-Null
        $snap = Get-Content (Join-Path $finalDir 'services.txt')
        foreach ($l in $snap) { $p = $l -split '\|', 3; if ($p[1] -in 'Application', 'AppDirectory', 'AppParameters' -and $p[2]) { Svc 'set' $p[0] @($p[1], $p[2]) | Out-Null } }
        if ($cfg.nginxReload -and -not $Rehearse) { & $cfg.nginxExe -s reload }
    }
    if ($state.phases.freeze) {
        Q 'postgres' "alter database `"$legacyDb`" reset default_transaction_read_only" | Out-Null
    }
    Svc 'start' $cfg.services.api | Out-Null; Svc 'start' $cfg.services.web | Out-Null
    $h = if ($Rehearse) { 'rehearse: old services not started' } else { Health $cfg.apiBase }
    $data = [ordered]@{ confirmedBy = $who; legacyWritable = $true; oldHealth = $h
                        kept = "$targetDb / $finalRefDb / final backup are KEPT for forensics - never dropped"
                        next = 'clear site data on every terminal (terminal-checklist.md, rollback section)' }
    Record 'abort' 'DONE' $data
    Write-Host 'ABORTED: the old system is back. Clear site data on every terminal.' -ForegroundColor Yellow
}
}
} catch {
    if ($Phase -ne 'abort' -and -not $state.phases.$Phase) { Record $Phase 'FAILED' ([ordered]@{ error = "$_" }) }
    Write-Host "`n$Phase FAILED: $_" -ForegroundColor Red
    Write-Host 'Nothing is retried in place. Decide with the rollback authority: -Phase abort, investigate, new run ID.' -ForegroundColor Red
    Stop-Transcript | Out-Null
    exit 1
}
Write-Host "`n$Phase PASSED  (state: $stateFile)" -ForegroundColor Green
Stop-Transcript | Out-Null
exit 0
