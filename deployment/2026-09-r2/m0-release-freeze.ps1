<#
.SYNOPSIS
  GATE M0 - release freeze. Read-only against PostgreSQL.

.DESCRIPTION
  Produces release-manifest.json, the identity every later gate is signed
  against. It fails (exit 1) unless:

    * the working tree is clean (the migration kit is committed)
    * HEAD carries a release tag            (-RequireTag, mandatory for Job 2)
    * the API and web builds exist and are hashed
    * no loose evidence sits in the evidence root (earlier runs are archived)

  The manifest records the old (legacy) commit, the new commit and tag, the kit
  hash, and one hash per build tree. cutover.ps1 refuses to run unless the kit,
  the commit and the new install on the cafe machine match this manifest.

.EXAMPLE
  .\m0-release-freeze.ps1                       # check only, rehearsal
  .\m0-release-freeze.ps1 -RequireTag -OutDir C:\POS-BACKUPS\releases
  .\m0-release-freeze.ps1 -ArchiveLooseEvidence  # move old root-level evidence away
#>
param(
    [string]$LegacyCommit = 'e91fb5b',
    [string]$EvidenceRoot = 'C:\POS-BACKUPS\work',
    [string]$OutDir       = 'C:\POS-BACKUPS\releases',
    [switch]$RequireTag,
    [switch]$ArchiveLooseEvidence,
    # Hash the build trees of this install instead of the repository (run on the
    # cafe machine against the NEW install to prove it is the frozen build).
    [string]$InstallRoot = ''
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_kit.ps1"

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$fail = New-Object System.Collections.Generic.List[string]

Write-Host '=== M0 release freeze ===' -ForegroundColor Cyan

# 1. Source identity
$git = Get-GitInfo $repoRoot
if (-not $git.clean) { $fail.Add("working tree is not clean ($($git.dirty.Count) change(s)): commit the migration kit first") }
if ($RequireTag -and -not $git.tag) { $fail.Add('HEAD has no release tag (git tag -a release-2026-09-r2 -m ...)') }
Write-Host "  commit : $($git.commit)  tag: $(if ($git.tag) { $git.tag } else { '<none>' })  clean: $($git.clean)"

# 2. Kit identity
$kit = Get-KitManifest
Write-Host "  kit    : $($kit.kitHash)  ($($kit.files.Count) files)"

# 3. Build artifacts
$root = if ($InstallRoot) { $InstallRoot } else { $repoRoot }
$builds = [ordered]@{}
foreach ($rel in 'apps\api\dist', 'apps\web\dist', 'apps\api\prisma\migrations') {
    $t = Get-TreeHash (Join-Path $root $rel)
    if (-not $t) { $fail.Add("build tree missing: $rel (run pnpm build)"); continue }
    $builds[$rel.Replace('\', '/')] = $t
    Write-Host ("  build  : {0,-28} {1}  ({2} files)" -f $rel, $t.hash.Substring(0, 16), $t.files)
}

# 4. Evidence hygiene: every earlier run lives in its own directory.
if (Test-Path $EvidenceRoot) {
    $loose = @(Get-ChildItem -Path $EvidenceRoot -File)
    if ($loose.Count -gt 0) {
        if ($ArchiveLooseEvidence) {
            $arc = Join-Path $EvidenceRoot ("archive-pre-m0-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
            New-Item -ItemType Directory -Path $arc | Out-Null
            $loose | Move-Item -Destination $arc
            Write-Host "  evidence: archived $($loose.Count) loose file(s) into $arc"
        } else {
            $fail.Add("$($loose.Count) loose evidence file(s) in $EvidenceRoot - rerun with -ArchiveLooseEvidence")
        }
    }
}

$manifest = [ordered]@{
    release       = '2026-09-r2'
    frozenAt      = (Get-Date -Format o)
    legacyCommit  = $LegacyCommit
    newCommit     = $git.commit
    newTag        = $git.tag
    treeClean     = $git.clean
    kitHash       = $kit.kitHash
    kitFiles      = $kit.files
    builds        = $builds
    installRoot   = $root
    passed        = ($fail.Count -eq 0)
    failures      = @($fail)
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$name = if ($git.tag) { $git.tag } else { $git.commit.Substring(0, 12) }
$path = Join-Path $OutDir "release-manifest-$name.json"
$manifest | ConvertTo-Json -Depth 6 | Out-File $path -Encoding utf8
Write-Host "  manifest: $path  sha256 $(Get-FileSha256 $path)"

Write-Host ''
if ($fail.Count -gt 0) {
    Write-Host 'M0 FAILED:' -ForegroundColor Red
    $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host 'M0 PASSED - release frozen. Record the manifest hash in SIGNOFF.md.' -ForegroundColor Green
exit 0
