<#
.SYNOPSIS
    Offline install of CapsWriter client using a prepared bundle.

.DESCRIPTION
    Uses the bundle produced by scripts/prepare-offline-bundle.ps1 to install
    the client on a Windows host with no network.

.PARAMETER BundleDir
    Path to the offline bundle folder (must contain 'client', 'wheelhouse', 'requirements-offline.txt').

.PARAMETER InstallDir
    Target install directory. Default: $env:LOCALAPPDATA\CapsWriter

.PARAMETER PythonExe
    Path to an existing Python 3.11+ interpreter on the target host.

.PARAMETER AddToStartup
    Create Startup shortcut.

.PARAMETER CreateDesktopShortcut
    Create Desktop shortcut (default: $true)

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File scripts/install-client-offline.ps1 -BundleDir D:\bundle
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [Parameter(Mandatory=$true)][string]$BundleDir,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CapsWriter'),
    [string]$PythonExe,
    [switch]$AddToStartup,
    [switch]$CreateDesktopShortcut = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step($msg){ Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg){ Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg){ Write-Warning $msg }

function Ensure-Dir($path){ if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path | Out-Null } }

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
    throw 'Python 3.11+ not found. Please install it on the target host before running this script.'
}

function New-LauncherFiles {
    param([string]$Dir)
    $bat = @"
@echo off
setlocal
pushd "%~dp0"
"%~dp0\.venv\Scripts\python.exe" core_client.py %*
popd
endlocal
"@
    Set-Content -Path (Join-Path $Dir 'Start-CapsWriter.bat') -Value $bat -Encoding ASCII

    $ps1 = @"
param(
  [string[]]
  `$Args
)
`$here = Split-Path -Parent `$MyInvocation.MyCommand.Path
& "$Dir\.venv\Scripts\python.exe" "$Dir\core_client.py" @Args
"@
    Set-Content -Path (Join-Path $Dir 'Start-CapsWriter.ps1') -Value $ps1 -Encoding UTF8
}

function New-Shortcut {
    param([string]$TargetPath, [string]$ShortcutPath, [string]$IconPath)
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($ShortcutPath)
    $sc.TargetPath = $TargetPath
    $sc.WorkingDirectory = Split-Path -Parent $TargetPath
    if (Test-Path $IconPath) { $sc.IconLocation = "$IconPath,0" }
    $sc.Save()
}

# Validate bundle layout
$wheelhouse = Join-Path $BundleDir 'wheelhouse'
$clientSrc = Join-Path $BundleDir 'client'
$reqFile = Join-Path $BundleDir 'requirements-offline.txt'
foreach($p in @($wheelhouse,$clientSrc,$reqFile)){
    if (-not (Test-Path $p)) { throw "Bundle is incomplete. Missing: $p" }
}

Write-Step "Installing from bundle: $BundleDir"
Ensure-Dir $InstallDir

# Copy client
Write-Step 'Copying client files'
robocopy $clientSrc $InstallDir /E /NFL /NDL /NJH /NJS /XF *.pyc *.pyo /XD __pycache__ 2025 | Out-Null
Write-Ok 'Client files copied.'

$python = Resolve-Python311 -Preferred $PythonExe

# venv
Write-Step 'Creating virtual environment (.venv)'
& $python -m venv (Join-Path $InstallDir '.venv')
$venvPython = Join-Path $InstallDir '.venv/Links/python.exe'
if (-not (Test-Path $venvPython)) { $venvPython = Join-Path $InstallDir '.venv/Scripts/python.exe' }
if (-not (Test-Path $venvPython)) { throw 'Failed to create virtual environment.' }
Write-Ok 'Virtual environment ready.'

# Offline pip install
Write-Step 'Installing dependencies (offline)'
& $venvPython -m pip install --no-index --find-links $wheelhouse -r $reqFile
Write-Ok 'Dependencies installed.'

New-LauncherFiles -Dir $InstallDir

# Shortcuts
$icon = Join-Path $InstallDir 'assets/icon.ico'
if ($CreateDesktopShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $scPath = Join-Path $desktop 'CapsWriter.lnk'
    Write-Step 'Creating desktop shortcut'
    New-Shortcut -TargetPath (Join-Path $InstallDir 'Start-CapsWriter.bat') -ShortcutPath $scPath -IconPath $icon
    Write-Ok 'Desktop shortcut created.'
}
if ($AddToStartup) {
    $startup = [Environment]::GetFolderPath('Startup')
    $scPath2 = Join-Path $startup 'CapsWriter.lnk'
    Write-Step 'Adding startup shortcut (current user)'
    New-Shortcut -TargetPath (Join-Path $InstallDir 'Start-CapsWriter.bat') -ShortcutPath $scPath2 -IconPath $icon
    Write-Ok 'Startup entry created.'
}

Write-Host "`nOffline installation complete." -ForegroundColor Green
Write-Host "Install path: $InstallDir"
Write-Host "Launch: $InstallDir\Start-CapsWriter.bat (Run as Administrator for global hotkey)"
Write-Host "Config:  $InstallDir\config.py"

