<#
.SYNOPSIS
  Prove the bridged database is structurally identical to the squashed baseline.

.DESCRIPTION
  Two independent comparisons, because neither alone is sufficient:

    1. `prisma migrate diff --exit-code` - what Prisma's own engine believes.
       This is the check that decides whether `migrate resolve --applied` is
       honest, but it only understands what Prisma models: tables, columns,
       indexes, foreign keys, enums.

    2. A catalog diff over pg_catalog / information_schema - everything Prisma
       cannot see: CHECK constraints, functions, triggers, RLS policies, FORCE
       flags and sequence inventory. The baseline migration creates 35 policies
       and 2 triggers that `migrate diff` would happily call "no difference".

  Expected, allowlisted differences between a bridged cafe database and a freshly
  built baseline:
    * `_prisma_migrations`          - migration history, absent from the baseline
    * `seq_<org8hex>_*`             - per-tenant document sequences
    * schema `legacy_archive`       - never compared (public schema only)

  Exit code 0 = equivalent. Non-zero = STOP; the bridge is not finished.

.EXAMPLE
  $env:PGPASSWORD = '...'
  .\equivalence-check.ps1 -SourceDb cafe_migration_r1 -TargetDb ref_baseline_20260727
#>
param(
    [string]$SourceDb = 'cafe_migration_r1',
    [string]$TargetDb = 'ref_baseline_20260727',
    [string]$DbHost   = 'localhost',
    [int]   $Port     = 5432,
    [string]$User     = 'postgres',
    [string]$PgBin    = 'C:\Program Files\PostgreSQL\18\bin',
    [switch]$SkipPrisma
)

$ErrorActionPreference = 'Stop'

$psql     = Join-Path $PgBin 'psql.exe'
$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$failures = @()

# Per-tenant sequences and the migration-history table are data, not schema.
$allowPattern = '^(_prisma_migrations|seq_[0-9a-f]{8}_)'

$queries = [ordered]@{
    'columns' = @"
select table_name || '.' || column_name || ' :: ' || data_type || ' / ' || udt_name ||
       ' null=' || is_nullable || ' default=' || coalesce(column_default, '-')
  from information_schema.columns
 where table_schema = 'public'
 order by 1
"@
    'indexes' = @"
select indexname || ' :: ' || indexdef
  from pg_indexes where schemaname = 'public'
 order by 1
"@
    'constraints' = @"
select c.conrelid::regclass::text || '.' || c.conname || ' :: ' || c.contype::text || ' :: ' ||
       pg_get_constraintdef(c.oid)
  from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
 where n.nspname = 'public'
 order by 1
"@
    'enums' = @"
select t.typname || ' :: ' || string_agg(e.enumlabel, ',' order by e.enumsortorder)
  from pg_type t
  join pg_enum e on e.enumtypid = t.oid
  join pg_namespace n on n.oid = t.typnamespace
 where n.nspname = 'public'
 group by t.typname
 order by 1
"@
    'functions' = @"
select p.proname || ' :: ' || md5(pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
 order by 1
"@
    'triggers' = @"
select c.relname || '.' || t.tgname || ' :: ' || md5(pg_get_triggerdef(t.oid))
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
 order by 1
"@
    'policies' = @"
select tablename || '.' || policyname || ' :: ' || cmd || ' :: ' ||
       coalesce(qual, '-') || ' :: ' || coalesce(with_check, '-') || ' :: ' ||
       coalesce(array_to_string(roles, ','), '-')
  from pg_policies where schemaname = 'public'
 order by 1
"@
    'rls_flags' = @"
select c.relname || ' :: rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by 1
"@
    'sequences' = @"
select c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'S'
 order by 1
"@
}

function Get-Catalog {
    param([string]$Database, [string]$Sql)
    $rows = & $psql -h $DbHost -p $Port -U $User -w -X -A -t -d $Database -c $Sql
    if ($LASTEXITCODE -ne 0) { throw "catalog query failed on $Database" }
    if ($null -eq $rows) { return @() }
    return @($rows | Where-Object { $_ -ne '' -and $_ -notmatch $allowPattern })
}

Write-Host "=== equivalence check ===" -ForegroundColor Cyan
Write-Host "  source (bridged) : $SourceDb"
Write-Host "  target (baseline): $TargetDb"
Write-Host ""

# --- 1. Prisma's own view -------------------------------------------------
if (-not $SkipPrisma) {
    $pw   = [uri]::EscapeDataString($env:PGPASSWORD)
    $from = "postgresql://$User`:$pw@${DbHost}:$Port/$SourceDb`?schema=public"
    $to   = "postgresql://$User`:$pw@${DbHost}:$Port/$TargetDb`?schema=public"
    Push-Location (Join-Path $repoRoot 'apps\api')
    try {
        & pnpm exec prisma migrate diff --from-url $from --to-url $to --exit-code | Out-Null
        $code = $LASTEXITCODE
    } finally { Pop-Location }
    if ($code -eq 0) {
        Write-Host "  [pass] prisma migrate diff: no difference" -ForegroundColor Green
    } elseif ($code -eq 2) {
        $failures += 'prisma migrate diff reports schema differences (run it without --exit-code to see them)'
        Write-Host "  [FAIL] prisma migrate diff: differences found" -ForegroundColor Red
    } else {
        throw "prisma migrate diff failed with exit code $code"
    }
}

# --- 2. Everything Prisma cannot see --------------------------------------
foreach ($name in $queries.Keys) {
    $a = Get-Catalog -Database $SourceDb -Sql $queries[$name]
    $b = Get-Catalog -Database $TargetDb -Sql $queries[$name]
    $diff = Compare-Object -ReferenceObject $b -DifferenceObject $a
    if ($null -eq $diff) {
        Write-Host ("  [pass] {0,-12} {1} objects match" -f $name, $a.Count) -ForegroundColor Green
    } else {
        $failures += "$name differs"
        Write-Host ("  [FAIL] {0,-12} {1} difference(s)" -f $name, @($diff).Count) -ForegroundColor Red
        foreach ($d in @($diff) | Select-Object -First 25) {
            $side = if ($d.SideIndicator -eq '=>') { "only in $SourceDb" } else { "only in $TargetDb" }
            Write-Host "           $side : $($d.InputObject)"
        }
        if (@($diff).Count -gt 25) { Write-Host "           ... $((@($diff).Count) - 25) more" }
    }
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "EQUIVALENCE GATE FAILED: $($failures -join '; ')" -ForegroundColor Red
    exit 2
}
Write-Host "EQUIVALENCE GATE PASSED - the bridged database matches the baseline." -ForegroundColor Green
exit 0
