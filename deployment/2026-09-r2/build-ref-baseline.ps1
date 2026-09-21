<#
.SYNOPSIS
  Build the schema-equivalence target: an empty database carrying ONLY the two
  baseline migrations.

.DESCRIPTION
  The bridge (bridge-00/10/30) has to land the legacy cafe database exactly on
  the state Prisma calls `20260727120000_squashed_baseline` +
  `20260727120001_rls_and_triggers`. That state cannot be asserted against
  `schema.prisma`, because schema.prisma is 80 migrations further along, so this
  script materialises it as a real database to diff against.

  No data is ever written here. The database is disposable and is rebuilt from
  the migration SQL whenever it is needed.

  JOB 1 SAFETY: the target must be on the approved disposable list. The live
  cafe database `POS-CAFE` is rejected outright.

.EXAMPLE
  $env:PGPASSWORD = '...'
  .\build-ref-baseline.ps1
  .\build-ref-baseline.ps1 -Recreate
#>
param(
    [string]$DbName   = 'ref_baseline_20260727',
    [string]$DbHost   = 'localhost',
    [int]   $Port     = 5432,
    [string]$User     = 'postgres',
    [string]$PgBin    = 'C:\Program Files\PostgreSQL\18\bin',
    # Drop and rebuild when the database already exists.
    [switch]$Recreate
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\_safety.ps1"

$repoRoot      = (Resolve-Path "$PSScriptRoot\..\..").Path
$migrationsDir = Join-Path $repoRoot 'apps\api\prisma\migrations'
$baseline      = @(
    '20260727120000_squashed_baseline',
    '20260727120001_rls_and_triggers'
)

$psql     = Join-Path $PgBin 'psql.exe'
$createdb = Join-Path $PgBin 'createdb.exe'
$dropdb   = Join-Path $PgBin 'dropdb.exe'

Assert-SafeTarget -Database $DbName -DbHost $DbHost -Port $Port -User $User -Purpose 'build schema-equivalence baseline'

function Invoke-Psql {
    param([string]$Database, [string]$Sql)
    $out = & $psql -h $DbHost -p $Port -U $User -w -X -A -t -d $Database -c $Sql
    if ($LASTEXITCODE -ne 0) { throw "psql failed: $Sql" }
    return $out
}

$exists = Invoke-Psql -Database 'postgres' -Sql "select 1 from pg_database where datname = '$DbName'"
if ($exists) {
    if (-not $Recreate) { throw "$DbName already exists. Pass -Recreate to rebuild it." }
    Write-Host "  dropping existing $DbName (disposable)"
    & $dropdb -h $DbHost -p $Port -U $User -w $DbName
    if ($LASTEXITCODE -ne 0) { throw "dropdb failed" }
}

Write-Host "  creating $DbName"
& $createdb -h $DbHost -p $Port -U $User -w -T template0 -E UTF8 -O $User $DbName
if ($LASTEXITCODE -ne 0) { throw "createdb failed" }

foreach ($name in $baseline) {
    $file = Join-Path $migrationsDir "$name\migration.sql"
    if (-not (Test-Path $file)) { throw "missing baseline migration: $file" }
    Write-Host "  applying $name"
    & $psql -h $DbHost -p $Port -U $User -w -X -q -d $DbName --set ON_ERROR_STOP=on --single-transaction -f $file
    if ($LASTEXITCODE -ne 0) { throw "failed applying $name" }
}

# The baseline database is a DIFF TARGET only: it deliberately carries no
# _prisma_migrations rows, no seed data and no tenant rows.
$summary = Invoke-Psql -Database $DbName -Sql @"
select (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')
    || ' tables, ' ||
       (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e')
    || ' enums, ' ||
       (select count(*) from pg_policies where schemaname='public')
    || ' policies, ' ||
       (select count(*) from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and not tg.tgisinternal)
    || ' triggers, ' ||
       (select count(*) from pg_constraint where connamespace='public'::regnamespace and contype='f')
    || ' fks'
"@

Write-Host ""
Write-Host "ref baseline ready: $DbName" -ForegroundColor Green
Write-Host "  $summary"
Write-Host "  (no _prisma_migrations rows by design - this database is a diff target)"
