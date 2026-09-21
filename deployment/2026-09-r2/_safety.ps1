<#
  Shared JOB 1 write-target guard (see README S0 EXECUTION SAFETY RULE).

  Every script in this kit that writes to PostgreSQL calls Assert-SafeTarget
  first. It prints the target, then refuses anything that is not an approved
  disposable rehearsal database. The live cafe database is rejected by name
  before the approved-list check, so no configuration mistake can reach it.

  Dot-source it:  . "$PSScriptRoot\_safety.ps1"
#>

# The live cafe database. Never a legal target in Job 1.
$script:ForbiddenDatabases = @('POS-CAFE')

# The only databases Job 1 may write to.
$script:ApprovedDatabases = @(
    'cafe_reference_20260917',   # golden copy - read-only, never migrated
    'cafe_migration_r1',         # disposable migration workspace
    'ref_baseline_20260727',     # disposable schema-equivalence target
    'cafe_v2_restore_test',      # disposable restore test
    'cafe_rollback_test_r1'      # disposable writable legacy copy (rollback drill)
)

function Get-ApprovedDatabases {
    $extra = $env:POSCAFE_EXTRA_APPROVED_DB
    if ([string]::IsNullOrWhiteSpace($extra)) { return $script:ApprovedDatabases }
    # Escape hatch for a named rehearsal round (e.g. cafe_migration_r2). It can
    # never widen the list to a forbidden database.
    $added = $extra.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    return @($script:ApprovedDatabases + $added)
}

function Assert-SafeTarget {
    param(
        [Parameter(Mandatory = $true)][string]$Database,
        [string]$DbHost  = 'localhost',
        [int]   $Port    = 5432,
        [string]$User    = 'postgres',
        [string]$Purpose = 'write',
        # Set for steps that must never run against the golden reference copy.
        [switch]$ForbidReference
    )

    Write-Host "=== WRITE TARGET SAFETY CHECK ===" -ForegroundColor Cyan
    Write-Host "  purpose   : $Purpose"
    Write-Host "  target db : $Database"
    Write-Host "  host/port : ${DbHost}:${Port}"
    Write-Host "  user      : $User"
    Write-Host "  env       : JOB 1 LOCAL REHEARSAL"

    foreach ($forbidden in $script:ForbiddenDatabases) {
        if ($Database -eq $forbidden) {
            throw "STOP: '$Database' is the live cafe production database. Job 1 must never write to it."
        }
    }

    $approved = Get-ApprovedDatabases
    if ($approved -notcontains $Database) {
        throw ("STOP: '$Database' is not an approved Job 1 database. Approved: " + ($approved -join ', '))
    }

    if ($ForbidReference -and $Database -eq 'cafe_reference_20260917') {
        throw "STOP: '$Database' is the untouched golden reference. It is never migrated or written to."
    }

    Write-Host "  disposable: YES (approved Job 1 target)" -ForegroundColor Green
    Write-Host ""
}

function Assert-NoActiveConnections {
    param(
        [Parameter(Mandatory = $true)][string]$Database,
        [Parameter(Mandatory = $true)][string]$Psql,
        [string]$DbHost = 'localhost',
        [int]   $Port   = 5432,
        [string]$User   = 'postgres'
    )
    $n = & $Psql -h $DbHost -p $Port -U $User -w -X -A -t -d postgres `
        -c "select count(*) from pg_stat_activity where datname = '$Database' and pid <> pg_backend_pid()"
    if ($LASTEXITCODE -ne 0) { throw "connection check failed for $Database" }
    if ([int]$n -ne 0) {
        throw "STOP: $Database has $n active connection(s). Close them before cloning or dropping."
    }
}
