<#
  Shared helpers for run identity and evidence (M0 release freeze, rehearsal
  runs, Job 2 cutover). Read-only: nothing here writes to PostgreSQL.

  Dot-source it:  . "$PSScriptRoot\_kit.ps1"
#>

# The files that ARE the migration kit. Documents, reports and evidence are not
# part of the hash, so signing a sheet does not change the kit identity.
$script:KitPatterns = @('*.ps1', '*.sql', '*.ts')

function Get-KitFiles {
    $dir = $PSScriptRoot
    $files = foreach ($p in $script:KitPatterns) { Get-ChildItem -Path $dir -Filter $p -File }
    return @($files | Sort-Object Name -Unique)
}

# One line per file "<sha256>  <name>", then the SHA-256 of those lines. Stable
# across machines because it hashes content, not timestamps.
function Get-KitManifest {
    $lines = foreach ($f in Get-KitFiles) {
        '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -Path $f.FullName).Hash.ToLower(), $f.Name
    }
    $joined = ($lines -join "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    $kitHash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($joined)) | ForEach-Object { $_.ToString('x2') })
    return [pscustomobject]@{ kitHash = $kitHash; files = @($lines) }
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}

function Get-GitInfo([string]$RepoRoot) {
    Push-Location $RepoRoot
    # git writes warnings to stderr; under 'Stop' Windows PowerShell 5.1 turns
    # any stderr line of a native command into a terminating error.
    $ErrorActionPreference = 'Continue'
    try {
        $commit = (& git rev-parse HEAD 2>$null)
        $dirty  = @(& git status --porcelain 2>$null | Where-Object { $_ })
        $tag    = (& git describe --tags --exact-match HEAD 2>$null)
        return [pscustomobject]@{ commit = "$commit"; tag = "$tag"; clean = ($dirty.Count -eq 0); dirty = $dirty }
    } finally { Pop-Location }
}

# A run ID names ONE rehearsal or ONE cutover. Its evidence directory must not
# exist yet: reusing a directory would let an old state.json skip steps.
function New-EvidenceDir([string]$Root, [string]$RunId) {
    if ($RunId -notmatch '^(rehearsal|cutover|drill)-\d{4}-\d{2}-\d{2}-r\d+$') {
        throw "Run ID '$RunId' must look like rehearsal-2026-09-18-r3 / cutover-2026-09-27-r1 / drill-2026-09-20-r1."
    }
    $dir = Join-Path $Root $RunId
    if (Test-Path $dir) { throw "Evidence directory already exists: $dir. Every run gets a NEW run ID." }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

function Write-Evidence([string]$Dir, [string]$Name, $Object) {
    $path = Join-Path $Dir $Name
    $Object | ConvertTo-Json -Depth 8 | Out-File $path -Encoding utf8
    return $path
}

# Content hash of a build tree (relative paths + file hashes).
function Get-TreeHash([string]$Dir) {
    if (-not (Test-Path $Dir)) { return $null }
    $lines = Get-ChildItem -Path $Dir -Recurse -File | Sort-Object FullName | ForEach-Object {
        '{0}  {1}' -f (Get-FileSha256 $_.FullName), $_.FullName.Substring($Dir.Length).TrimStart('\').Replace('\', '/')
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    $h = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))) | ForEach-Object { $_.ToString('x2') })
    return [pscustomobject]@{ hash = $h; files = @($lines).Count }
}
