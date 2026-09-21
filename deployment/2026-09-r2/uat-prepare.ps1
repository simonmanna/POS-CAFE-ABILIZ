<#
.SYNOPSIS
  Make a MIGRATED REHEARSAL COPY usable for UAT: every user gets a known test
  password and PIN, lockouts and MFA are cleared.

.DESCRIPTION
  UAT needs to log in as every role, and the cafe's real passwords are not known
  to the rehearsal team. This rewrites credentials on a DISPOSABLE copy only:

    * _safety.ps1 refuses anything that is not an approved rehearsal database
      and rejects the live cafe database and the golden reference by name
    * the production credential table is never read for this, never written

  Run it AFTER upgrade.ps1 has finished and its fingerprint has been captured:
  the User table is outside the financial fingerprint, but running it earlier
  would still put a non-migration write into the evidence window.

  The live cafe keeps its real credentials. The only production credential
  action in the plan is decision D12 (change admin@demo.test before go-live),
  done by the owner in the application, never by script.

.EXAMPLE
  $env:PGPASSWORD = '...'
  .\uat-prepare.ps1 -TargetDb cafe_migration_r1 -RunId rehearsal-2026-09-18-r3
#>
param(
    [string]$TargetDb     = 'cafe_migration_r1',
    [Parameter(Mandatory = $true)][string]$RunId,
    [string]$Password     = '1234',
    [string]$Pin          = '1234',
    [string]$DbHost       = 'localhost',
    [int]   $Port         = 5432,
    [string]$User         = 'postgres',
    [string]$PgBin        = 'C:\Program Files\PostgreSQL\18\bin',
    [string]$EvidenceRoot = 'C:\POS-BACKUPS\work'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_safety.ps1"
if (-not $env:PGPASSWORD) { throw 'PGPASSWORD is not set.' }

Assert-SafeTarget -Database $TargetDb -DbHost $DbHost -Port $Port -User $User `
                  -Purpose 'UAT credential reset on a DISPOSABLE migrated copy' -ForbidReference

$dir = Join-Path $EvidenceRoot $RunId
if (-not (Test-Path (Join-Path $dir 'state.json'))) { throw "no rehearsal evidence at $dir - run new-rehearsal.ps1 first" }

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$psql = Join-Path $PgBin 'psql.exe'

Push-Location (Join-Path $repoRoot 'apps\api')
try {
    $pwHash  = & node -e "process.stdout.write(require('bcryptjs').hashSync(process.argv[1], 10))" $Password
    $pinHash = & node -e "process.stdout.write(require('bcryptjs').hashSync(process.argv[1], 10))" $Pin
} finally { Pop-Location }
if ($pwHash -notmatch '^\$2[aby]\$10\$' -or $pinHash -notmatch '^\$2[aby]\$10\$') { throw 'bcrypt hashing failed' }

$sql = @"
\set ON_ERROR_STOP on
begin;
update "User" set "passwordHash" = '$pwHash', "pinHash" = '$pinHash', "pinHashRounds" = 10,
       "failedLoginCount" = 0, "lockedUntil" = null,
       "mfaSecret" = null, "mfaSecretIv" = null, "mfaSecretTag" = null, "mfaEnrolledAt" = null
 where "deletedAt" is null;
commit;
select o.code || '|' || u.email || '|' || case when u."isActive" then 'active' else 'inactive' end || '|' ||
       coalesce(string_agg(r.name, ',' order by r.name), '-')
  from "User" u join "Organization" o on o.id = u."organizationId"
  left join "_UserRoles" ur on ur."B" = u.id left join "Role" r on r.id = ur."A"
 where u."deletedAt" is null
 group by o.code, u.email, u."isActive" order by 1;
"@
$tmp = [IO.Path]::GetTempFileName()
try {
    Set-Content -Path $tmp -Value $sql -Encoding utf8
    $rows = & $psql -h $DbHost -p $Port -U $User -w -X -A -t -q -d $TargetDb -f $tmp
    if ($LASTEXITCODE -ne 0) { throw 'credential reset failed' }
} finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }

$out = @("UAT credentials for $TargetDb (run $RunId), set $(Get-Date -Format o)",
         "password = '$Password'   PIN = '$Pin'   (DISPOSABLE COPY ONLY)", '',
         'organization | email | status | roles') + $rows
$out | Out-File (Join-Path $dir 'uat-credentials.txt') -Encoding utf8
$out | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host "UAT logins ready on $TargetDb. Inactive users stay inactive (log in as an active user per role)." -ForegroundColor Green
