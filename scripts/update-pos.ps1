param(
    [ValidateSet("full","web-only")]
    [string]$Mode = "full"
)

$owner  = "simonmanna"
$repo   = "POS-CAFE-ABILIZ"
$posDir = "C:\microsoft\POS-CAFE"
$nginx  = "C:\Program Files\nginx\nginx.exe"
$versionFile = "$posDir\.version"

# --- helpers ---
function Restart-Services {
    Write-Host "Restarting services..."
    nssm restart pos-cafe-api
    if ($?) { Start-Sleep 3 }
    nssm restart pos-cafe-web
    if ($LASTEXITCODE -ne 0) { throw "Failed to restart services" }
}

function Save-Version {
    $tag = git describe --tags --abbrev=0 2>$null
    if ($tag) { $tag | Out-File $versionFile -Encoding UTF8 }
}

# --- web-only: download pre-built artifact ---
if ($Mode -eq "web-only") {
    Write-Host "Fetching latest release..."
    $release = $null
    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/$owner/$repo/releases/latest"
    } catch { throw "Cannot fetch latest release: $_" }

    $tag = $release.tag_name
    if ((Test-Path $versionFile) -and ((Get-Content $versionFile) -eq $tag)) {
        Write-Host "Already on $tag — nothing to do"; exit 0
    }

    $zipUrl = ($release.assets | Where-Object { $_.name -eq "pos-web.zip" }).browser_download_url
    if (-not $zipUrl) { throw "pos-web.zip not found in release $tag" }

    Write-Host "Downloading $tag ..."
    Invoke-WebRequest $zipUrl -OutFile "$env:TEMP\pos-web.zip"

    Remove-Item "$posDir\apps\web\dist" -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path "$posDir\apps\web\dist" -Force | Out-Null
    Expand-Archive "$env:TEMP\pos-web.zip" -DestinationPath "$posDir\apps\web\dist" -Force

    nssm restart pos-cafe-web
    $tag | Out-File $versionFile -Encoding UTF8
    Write-Host "Web updated to $tag"
    exit 0
}

# --- full update ---
Write-Host "=== POS-CAFE-ABILIZ Full Update ==="

# 1. Pull latest
Set-Location $posDir
Write-Host "1/8  git pull origin main..."
git pull origin main
if ($LASTEXITCODE -ne 0) { throw "git pull failed" }

# 2. Install dependencies
Write-Host "2/8  pnpm install..."
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

# 3. Build shared lib
Write-Host "3/8  pnpm shared:build..."
pnpm --filter @erp/shared build
if ($LASTEXITCODE -ne 0) { throw "shared build failed" }

# 4. Generate Prisma client
Write-Host "4/8  prisma generate..."
pnpm --filter @erp/api db:generate
if ($LASTEXITCODE -ne 0) { throw "prisma generate failed" }

# 5. Deploy DB migrations (safe — only unapplied)
Write-Host "5/8  prisma migrate deploy..."
pnpm --filter @erp/api db:deploy
if ($LASTEXITCODE -ne 0) { Write-Host "WARN: db:deploy failed (may be no new migrations)" }

# 6. Build API
Write-Host "6/8  pnpm --filter api build..."
pnpm --filter @erp/api build
if ($LASTEXITCODE -ne 0) { throw "api build failed" }

# 7. Build web
Write-Host "7/8  pnpm --filter web build..."
pnpm --filter @erp/web build
if ($LASTEXITCODE -ne 0) { throw "web build failed" }

# 8. Restart services
Write-Host "8/8  Restarting services..."
Restart-Services
Save-Version

Write-Host "=== Update complete ==="
