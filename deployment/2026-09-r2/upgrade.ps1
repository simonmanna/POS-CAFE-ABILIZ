<#
.SYNOPSIS
  2026-09-r2 migration driver. Idempotent, resumable, fail-closed.

.DESCRIPTION
  Runs the whole chain against ONE disposable database and stops at the first
  gate that does not pass:

    preflightPre -> archive -> bridge00 -> bridge10 -> backfillDry -> GATE
      -> backfillApply -> preflightPostB -> bridge30 -> equivalence
      -> history -> deploy -> drift -> ledgerConstraints -> releasePreflight
      -> fingerprint -> transformations

  RUN IDENTITY
  Every run has a run ID and its OWN evidence directory
  (<EvidenceRoot>\<RunId>\), which holds state.json, MigrationReport.* and every
  report. A new run refuses an existing directory, so a completed state.json from
  an earlier run can never cause steps to be skipped. `-Resume` continues an
  interrupted run only when the target and the kit hash are unchanged.

  FRESH TARGET
  Before the first step the target must still be a pristine legacy copy: no
  `legacy_archive` schema and no baseline migration row. A half-migrated or
  re-used workspace is refused.

  JOB 1 SAFETY
    * the target must be an approved disposable database (_safety.ps1)
    * the live cafe database is rejected by name
    * `-SourceDb` (the untouched reference) is only ever READ
    * on failure the driver stops; it never "repairs" a half-migrated database.
      Drop the workspace, recreate it from the reference, fix the kit, rerun
      with a NEW run ID.

.PARAMETER RunId
  rehearsal-YYYY-MM-DD-rN (or cutover-/drill-). Mandatory.

.PARAMETER ExpectMapping
  JSON file with the approved mapping counts (G3). When given, the mapping gate
  never prompts: any difference from the approved counts stops the run.

.EXAMPLE
  $env:PGPASSWORD = '...'
  .\upgrade.ps1 -RunId rehearsal-2026-09-18-r3 -TargetDb cafe_migration_r1
  .\upgrade.ps1 -RunId rehearsal-2026-09-18-r3 -TargetDb cafe_migration_r1 -Resume
#>
param(
    [Parameter(Mandatory = $true)][string]$RunId,
    [string]$TargetDb   = 'cafe_migration_r1',
    [string]$SourceDb   = 'cafe_reference_20260917',
    [string]$BaselineDb = 'ref_baseline_20260727',
    [string]$DbHost     = 'localhost',
    [int]   $Port       = 5432,
    [string]$User       = 'postgres',
    [string]$PgBin      = 'C:\Program Files\PostgreSQL\18\bin',
    [string]$EvidenceRoot = 'C:\POS-BACKUPS\work',
    # Continue an interrupted run (same run ID, same target, same kit).
    [switch]$Resume,
    # Re-run a step that is already marked complete (rehearsal diagnosis only).
    [switch]$Force,
    [string]$Step = '',
    # Answer the mapping-review gate without a prompt (unattended rehearsal).
    [switch]$Yes,
    [string]$ExpectMapping = '',
    # Fill Account.parentAccountId from the template where it is NULL.
    [switch]$WireParents
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_safety.ps1"
. "$PSScriptRoot\_kit.ps1"

$releaseDir = $PSScriptRoot
$repoRoot   = (Resolve-Path "$releaseDir\..\..").Path
$psql       = Join-Path $PgBin 'psql.exe'

if (-not $env:PGPASSWORD) { throw 'PGPASSWORD is not set.' }
if ($ExpectMapping -and $Yes) { throw '-Yes and -ExpectMapping are exclusive: an approved mapping is checked, never waved through.' }

Assert-SafeTarget -Database $TargetDb -DbHost $DbHost -Port $Port -User $User `
                  -Purpose 'run the 2026-09-r2 migration chain' -ForbidReference

$kit = Get-KitManifest
if ($Resume) {
    $WorkDir = Join-Path $EvidenceRoot $RunId
    if (-not (Test-Path (Join-Path $WorkDir 'state.json'))) { throw "-Resume: no state.json in $WorkDir" }
} else {
    if (-not (Test-Path $EvidenceRoot)) { New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null }
    $WorkDir = Join-Path $EvidenceRoot $RunId
    if (Test-Path (Join-Path $WorkDir 'state.json')) {
        throw "STOP: $WorkDir already holds a state.json. A new run needs a NEW run ID (or -Resume for this one)."
    }
    # new-rehearsal.ps1 / cutover.ps1 create the directory first; standalone runs create it here.
    if (-not (Test-Path $WorkDir)) { $WorkDir = New-EvidenceDir $EvidenceRoot $RunId }
}
$stateFile = Join-Path $WorkDir 'state.json'

$pw        = [uri]::EscapeDataString($env:PGPASSWORD)
$targetUrl = "postgresql://$User`:$pw@${DbHost}:$Port/$TargetDb"
$sourceUrl = "postgresql://$User`:$pw@${DbHost}:$Port/$SourceDb"

# --- state ------------------------------------------------------------------
function Get-State {
    if (Test-Path $stateFile) { return (Get-Content $stateFile -Raw | ConvertFrom-Json) }
    $git = Get-GitInfo $repoRoot
    return [pscustomobject]@{
        release = '2026-09-r2'; runId = $RunId; target = $TargetDb; source = $SourceDb
        kitHash = $kit.kitHash; gitCommit = $git.commit; gitClean = $git.clean
        started = (Get-Date -Format o); completed = @()
    }
}
function Save-State($s) { $s | ConvertTo-Json -Depth 6 | Out-File $stateFile -Encoding utf8 }
function Test-Done($s, [string]$name) {
    if ($Force -and ($Step -eq '' -or $Step -eq $name)) { return $false }
    return ($s.completed -contains $name)
}
function Complete-Step($s, [string]$name) {
    if ($s.completed -notcontains $name) { $s.completed = @($s.completed) + $name }
    $s | Add-Member -NotePropertyName 'last'   -NotePropertyValue $name -Force
    $s | Add-Member -NotePropertyName 'lastAt' -NotePropertyValue (Get-Date -Format o) -Force
    Save-State $s
}
function Invoke-Step($s, [string]$name, [scriptblock]$body) {
    if (Test-Done $s $name) { Write-Host "  [skip] $name" -ForegroundColor DarkGray; return }
    Write-Host "  [run ] $name" -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $body
    $sw.Stop()
    Write-Host ("         done in {0:n1}s" -f $sw.Elapsed.TotalSeconds)
    Complete-Step $s $name
}

function Invoke-Sql([string]$file) {
    & $psql -h $DbHost -p $Port -U $User -w -X -q -d $TargetDb --set ON_ERROR_STOP=on --single-transaction -f (Join-Path $releaseDir $file)
    if ($LASTEXITCODE -ne 0) { throw "psql failed applying $file" }
}
function Invoke-Tsx([string]$script, [string[]]$tsxArgs, [hashtable]$envVars) {
    Push-Location $repoRoot
    try {
        $saved = @{}
        foreach ($k in $envVars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envVars[$k]) }
        try {
            # Out-Host, not the pipeline: anything a function writes to the
            # pipeline becomes part of its return value, which would hide the
            # exit code behind the script's own output.
            & pnpm tsx "deployment/2026-09-r2/$script" @tsxArgs | Out-Host
            return $LASTEXITCODE
        } finally {
            foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
        }
    } finally { Pop-Location }
}

# --- run --------------------------------------------------------------------
$state = Get-State
if ($Resume) {
    if ($state.target -ne $TargetDb) { throw "-Resume: state.json belongs to target '$($state.target)', not '$TargetDb'." }
    if ($state.kitHash -ne $kit.kitHash) { throw '-Resume: the kit changed since this run started. Start a NEW run ID from a fresh clone.' }
} else {
    # A new run must start from a pristine legacy copy, never a re-used workspace.
    $fresh = & $psql -h $DbHost -p $Port -U $User -w -X -A -t -d $TargetDb -c @"
select (select count(*) from pg_namespace where nspname = 'legacy_archive')
     + (select count(*) from _prisma_migrations where migration_name like '20260727%')
"@
    if ($LASTEXITCODE -ne 0) { throw "cannot inspect $TargetDb" }
    if ([int]$fresh -ne 0) {
        throw "STOP: $TargetDb is not a fresh legacy copy (legacy_archive or baseline rows present). Drop it and clone again from the reference."
    }
    Save-State $state
}

Write-Host "=== 2026-09-r2 migration chain ===" -ForegroundColor Cyan
Write-Host "  target    : $TargetDb"
Write-Host "  reference : $SourceDb (read-only)"
Write-Host "  baseline  : $BaselineDb"
Write-Host "  run       : $RunId  (kit $($kit.kitHash.Substring(0,12)))"
Write-Host "  evidence  : $WorkDir"
Write-Host ""

# 1. Data conditions that would make a migration abort.
Invoke-Step $state 'preflightPre' {
    $rc = Invoke-Tsx '01-legacy-preflight.ts' @('--stage','pre','--json',(Join-Path $WorkDir "preflight-pre.json")) @{ DATABASE_URL = $targetUrl }
    if ($rc -eq 2) { throw 'PREFLIGHT BLOCKED: fix the legacy data before migrating (see the JSON report).' }
    if ($rc -ne 0) { throw "preflight failed with exit code $rc" }
}

# 2. Pre-migration values, kept forever. Must precede every bridge step.
Invoke-Step $state 'archive' { Invoke-Sql 'archive.sql' }

# 3. Enum values first: PostgreSQL refuses to use one in the transaction that
#    added it, so bridge-10 must see them already committed.
Invoke-Step $state 'bridge00' { Invoke-Sql 'bridge-00-enums.sql' }

# 4. Additive DDL. The legacy application still runs against this state.
Invoke-Step $state 'bridge10' { Invoke-Sql 'bridge-10-additive.sql' }

# 5. Mapping report first, so the gate has something to read.
Invoke-Step $state 'backfillDry' {
    $rc = Invoke-Tsx 'bridge-20-backfill.ts' @('--out-dir', $WorkDir) @{ DATABASE_URL = $targetUrl }
    if ($rc -ne 0) { throw 'backfill dry run reported unmapped postable accounts - see MigrationReport.md' }
}

# 6. GATE. bridge-30 is irreversible without a restore.
Invoke-Step $state 'gate' {
    $reportFile = Join-Path $WorkDir 'MigrationReport.json'
    if (-not (Test-Path $reportFile)) { throw 'MigrationReport.json missing - the backfill dry run did not produce one.' }
    $r = Get-Content $reportFile -Raw | ConvertFrom-Json
    if ($r.unmapped -ne 0) { throw "GATE FAILED: $($r.unmapped) unmapped postable account(s)." }
    Write-Host "         accounts=$($r.accounts) template=$($r.fromTemplate) groups=$($r.groups) typeMap=$($r.fromTypeMap) unmapped=0"
    if ($ExpectMapping) {
        # Approved mapping (G3): every count must match exactly; nothing is waved through.
        $e = Get-Content $ExpectMapping -Raw | ConvertFrom-Json
        foreach ($k in 'accounts','fromTemplate','groups','fromTypeMap','unmapped','needsReview') {
            if ("$($r.$k)" -ne "$($e.$k)") { throw "GATE FAILED: mapping '$k' is $($r.$k), approved value is $($e.$k). Re-rehearse and re-approve G3." }
        }
        if (@($r.renamedByTemplate).Count -ne 0) { throw 'GATE FAILED: template renames present; the approved mapping has none.' }
        Write-Host '         mapping equals the approved G3 mapping' -ForegroundColor Green
        return
    }
    if ($r.needsReview -gt 0 -or $r.renamedByTemplate.Count -gt 0) {
        Write-Host "         $($r.needsReview) account(s) need review, $($r.renamedByTemplate.Count) name difference(s)." -ForegroundColor Yellow
        Write-Host '         Read MigrationReport.md now - bridge-30 makes the old value unrecoverable.'
        if (-not $Yes) {
            $answer = Read-Host "         Type 'reviewed' to proceed"
            if ($answer -ne 'reviewed') { throw 'Aborted at the mapping gate.' }
        } else {
            Write-Host '         -Yes supplied: review acknowledged for an unattended rehearsal.' -ForegroundColor Yellow
        }
    }
}

# 7. Write the mapping.
Invoke-Step $state 'backfillApply' {
    $tsxArgs = @('--apply', '--out-dir', $WorkDir)
    if ($WireParents) { $tsxArgs += '--wire-parents' }
    $rc = Invoke-Tsx 'bridge-20-backfill.ts' $tsxArgs @{ DATABASE_URL = $targetUrl }
    if ($rc -ne 0) { throw 'backfill apply failed' }
}

# 8. Conditions that only exist once the mapping is in place.
Invoke-Step $state 'preflightPostB' {
    $rc = Invoke-Tsx '01-legacy-preflight.ts' @('--stage','post-b','--json',(Join-Path $WorkDir "preflight-postb.json")) @{ DATABASE_URL = $targetUrl }
    if ($rc -eq 2) { throw 'POST-BACKFILL PREFLIGHT BLOCKED - do not apply bridge-30.' }
    if ($rc -ne 0) { throw "preflight failed with exit code $rc" }
}

# 9. Contract: drop the legacy classification columns.
Invoke-Step $state 'bridge30' { Invoke-Sql 'bridge-30-contract.sql' }

# 10. Prove the bridge landed exactly on the squashed baseline.
Invoke-Step $state 'equivalence' {
    & "$releaseDir\equivalence-check.ps1" -SourceDb $TargetDb -TargetDb $BaselineDb -DbHost $DbHost -Port $Port -User $User -PgBin $PgBin
    if ($LASTEXITCODE -ne 0) { throw 'EQUIVALENCE GATE FAILED - the bridge is not finished.' }
}

# 11. Migration history. The legacy rows are the cafe's deployment audit trail
#     and are PRESERVED; only the two baseline names are registered, which is
#     enough for `migrate deploy` (proven in rehearsal, see README).
Invoke-Step $state 'history' {
    $before = & $psql -h $DbHost -p $Port -U $User -w -X -A -t -d $TargetDb -c 'select count(*) from "_prisma_migrations"'
    Push-Location (Join-Path $repoRoot 'apps\api')
    try {
        $env:DATABASE_URL = "$targetUrl`?schema=public"
        foreach ($m in @('20260727120000_squashed_baseline', '20260727120001_rls_and_triggers')) {
            & pnpm exec prisma migrate resolve --applied $m
            if ($LASTEXITCODE -ne 0) { throw "migrate resolve --applied $m failed" }
        }
        & pnpm exec prisma migrate status | Out-File (Join-Path $WorkDir "migrate-status.txt") -Encoding utf8
    } finally { Pop-Location }
    $after = & $psql -h $DbHost -p $Port -U $User -w -X -A -t -d $TargetDb -c 'select count(*) from "_prisma_migrations"'
    Write-Host "         _prisma_migrations rows: $before -> $after (legacy rows preserved)"
}

# 12. The real migrations, with their own backfills, gates and triggers.
Invoke-Step $state 'deploy' {
    Push-Location (Join-Path $repoRoot 'apps\api')
    try {
        $env:DATABASE_URL = "$targetUrl`?schema=public"
        & pnpm exec prisma migrate deploy | Out-File (Join-Path $WorkDir "migrate-deploy.log") -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw 'prisma migrate deploy FAILED - stop and read the log.' }
    } finally { Pop-Location }
}

# 13. The database must now equal schema.prisma exactly.
Invoke-Step $state 'drift' {
    Push-Location (Join-Path $repoRoot 'apps\api')
    try {
        & pnpm exec prisma migrate diff --from-url "$targetUrl`?schema=public" --to-schema-datamodel ./prisma/schema.prisma --exit-code | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'SCHEMA DRIFT: the database does not match schema.prisma.' }
    } finally { Pop-Location }
    Write-Host '         no drift'
}

# 14. Prove the historical rows satisfy the NOT VALID inventory checks.
Invoke-Step $state 'ledgerConstraints' {
    Push-Location $repoRoot
    try {
        $env:DATABASE_URL = "$targetUrl`?schema=public"
        & node apps/api/scripts/validate-ledger-constraints.cjs --apply | Out-File (Join-Path $WorkDir "ledger-constraints.json") -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw 'ledger constraint validation failed - historical rows violate a CHECK.' }
    } finally { Pop-Location }
}

# 15. Business readiness. Schema-level blockers fail the run; tenant-level ones
#     are pre-existing cafe data conditions, recorded for the owner.
Invoke-Step $state 'releasePreflight' {
    $out = Join-Path $WorkDir "release-preflight.json"
    Push-Location $repoRoot
    try {
        $env:DATABASE_URL = "$targetUrl`?schema=public"
        & node scripts/pos-release-preflight.cjs --all | Out-File $out -Encoding utf8
    } finally { Pop-Location }
    $raw = Get-Content $out -Raw
    $j = $raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json
    $dbBlockers = @($j.database.blockers).Count
    if ($dbBlockers -gt 0) { throw "release preflight: $dbBlockers DATABASE-level blocker(s) - the migration is incomplete." }
    foreach ($o in $j.organizations) {
        $n = @($o.blockers).Count
        if ($n -gt 0) {
            Write-Host "         tenant readiness: $n blocker(s) for $($o.organizationCode) - pre-existing data conditions, owner decision" -ForegroundColor Yellow
            foreach ($b in $o.blockers) { Write-Host "           - $($b.check)" }
        }
    }
}

# 16. Nothing moved that should not have.
Invoke-Step $state 'fingerprint' {
    $rc = Invoke-Tsx 'fingerprint.ts' @('--ab','--source',$sourceUrl,'--target',$targetUrl,'--out',(Join-Path $WorkDir "fingerprint.json")) @{}
    if ($rc -ne 0) { throw 'FINGERPRINT FAILED - unexplained differences. Do not proceed.' }
}

# 17. Every allowlisted rewrite, proved against legacy_archive.
Invoke-Step $state 'transformations' {
    $rc = Invoke-Tsx 'fingerprint.ts' @('--transformations','--out',(Join-Path $WorkDir "transformations.json")) @{ DATABASE_URL = $targetUrl }
    if ($rc -ne 0) { throw 'TRANSFORMATION PROOF FAILED - a documented rewrite did not happen as specified.' }
}

Write-Host ''
Write-Host '=== migration chain complete ===' -ForegroundColor Green
Write-Host "  target : $TargetDb"
Write-Host "  state  : $stateFile"
Write-Host "  evidence in $WorkDir"
Write-Host ''
Write-Host 'Still to do by hand (Job 1): UAT against the migrated database, the restore test,'
Write-Host 'and both rollback drills. A clean chain is not a GO for production.'
