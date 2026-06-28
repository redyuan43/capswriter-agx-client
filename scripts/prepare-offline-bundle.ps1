<#
.SYNOPSIS
    Prepare an offline installation bundle for CapsWriter client (Windows).

.DESCRIPTION
    Downloads Python wheels for required packages and copies client files
    into a self-contained folder that can be moved to an offline machine.

.PARAMETER OutputDir
    Output bundle directory. Default: ./offline-bundle

.PARAMETER PythonExe
    Path to a Python 3.11+ interpreter used to download wheels.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File scripts/prepare-offline-bundle.ps1 -OutputDir D:\bundle

.NOTES
    The offline target still needs Python 3.11+ installed. Use the official
    Python installer (can be placed alongside the bundle) on the target host.
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$OutputDir = (Join-Path (Get-Location) 'offline-bundle'),
    [string]$PythonExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step($msg){ Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg){ Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg){ Write-Warning $msg }

function Resolve-Python311 {
    param([string]$Preferred)
    if ($Preferred) { return $Preferred }
    try {
        $py = Get-Command py -ErrorAction Stop
        $exe = (& $py -3.11 -c "import sys;print(sys.executable)" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe)) { return $exe.Trim() }
    } catch {}
    try {
        $python = Get-Command python -ErrorAction Stop
        $ver = & $python - <<#PS#> "import sys;print('.'.join(map(str, sys.version_info[:2])))" 2>$null
        if ($ver -match '^3\.(1[1-9]|[2-9]\d)$') { return $python.Path }
    } catch {}
    throw 'Python 3.11+ not found. Please install it before preparing the bundle.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot 'core_client.py'))) { throw "CLI source not found in repo root: $repoRoot" }

# Layout
$bundle = $OutputDir
$wheelhouse = Join-Path $bundle 'wheelhouse'
$clientDir = Join-Path $bundle 'client'
$reqFile = Join-Path $bundle 'requirements-offline.txt'

Write-Step "Creating bundle at: $bundle"
New-Item -ItemType Directory -Force -Path $bundle,$wheelhouse,$clientDir | Out-Null

# Write requirement list (aligned with installer)
@(
    'numpy<2'
    'sounddevice'
    'keyboard'
    'typer'
    'colorama'
    'rich'
    'watchdog'
    'pynput'
    'pypinyin'
    'ffmpeg-python'
    'srt'
    'markdown-it-py'
    'pyclip'
) | Set-Content -Path $reqFile -Encoding ASCII

$python = Resolve-Python311 -Preferred $PythonExe
Write-Step "Using Python: $python"

# Download wheels to wheelhouse for current platform & py version
Write-Step 'Downloading wheels to wheelhouse (this may take a while)'
& $python -m pip download --only-binary=:all: -d $wheelhouse -r $reqFile
Write-Ok 'Wheels downloaded.'

# Copy client files
Write-Step 'Copying CLI payload into bundle'
foreach ($file in @('core_client.py', 'config.py', 'hot-en.txt', 'hot-zh.txt', 'hot-rule.txt', 'keywords.txt')) {
    Copy-Item -Path (Join-Path $repoRoot $file) -Destination (Join-Path $clientDir $file) -Force
}
foreach ($dir in @('util', 'assets')) {
    $sourceDir = Join-Path $repoRoot $dir
    $targetDir = Join-Path $clientDir $dir
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    robocopy $sourceDir $targetDir /E /NFL /NDL /NJH /NJS /XF *.pyc *.pyo /XD __pycache__ 2025 | Out-Null
}
Write-Ok 'CLI payload copied.'

Write-Host "`nBundle ready: $bundle" -ForegroundColor Green
Write-Host "Transfer this folder to the offline machine, then run:"
Write-Host "  pwsh -ExecutionPolicy Bypass -File install-client-offline.ps1 -BundleDir <path> [-InstallDir <dir>]" -ForegroundColor Yellow
