<#
.SYNOPSIS
    Install CapsWriter client on a Windows host.

.DESCRIPTION
    - Copies the offline Windows client to a chosen install directory
    - Creates a Python 3.11 virtual environment
    - Installs required Python packages
    - Creates a launcher script and an optional desktop shortcut

.PARAMETER InstallDir
    Target install directory. Default: $env:LOCALAPPDATA\CapsWriter

.PARAMETER AddToStartup
    Also create a shortcut in the current user's Startup folder.

.PARAMETER CreateDesktopShortcut
    Create a desktop shortcut for quick launch. Default: $true

.PARAMETER PythonExe
    Path to a Python 3.11+ interpreter. If omitted, the script tries `py -3.11` then `python`.

.EXAMPLE
    # From repo root
    pwsh -ExecutionPolicy Bypass -File scripts/install-client.ps1 -AddToStartup

.NOTES
    To capture global hotkeys, running the client with Administrator privileges may be required by the `keyboard` package.
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CapsWriter'),
    [switch]$AddToStartup,
    [switch]$CreateDesktopShortcut = $true,
    [string]$PythonExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step($msg){ Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg){ Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg){ Write-Warning $msg }

function Resolve-Python311 {
    param([string]$Preferred)
    if ($Preferred) {
        return $Preferred
    }
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
    return $null
}

function Ensure-Python311 {
    $py = Resolve-Python311 -Preferred $PythonExe
    if ($py) { return $py }
    Write-Warn 'Python 3.11+ not found. Attempting to install via winget...'
    try { $wg = Get-Command winget -ErrorAction Stop } catch { $wg = $null }
    if (-not $wg) {
        throw 'winget not found. Please install Python 3.11+ manually, then re-run this script.'
    }
    Write-Step 'Installing Python 3.11 via winget (requires network)...'
    & winget install -e --id Python.Python.3.11 --source winget --accept-source-agreements --accept-package-agreements
    $py = Resolve-Python311
    if (-not $py) { throw 'Python 3.11 installation did not succeed or not on PATH.' }
    return $py
}

function Ensure-Dir($path){ if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path | Out-Null } }

function Copy-ClientPayload {
    param(
        [string]$RepoRoot,
        [string]$Destination
    )
    Write-Step "Copying CLI payload to '$Destination'"
    Ensure-Dir $Destination

    foreach ($file in @('core_client.py', 'config.py', 'hot-en.txt', 'hot-zh.txt', 'hot-rule.txt', 'keywords.txt')) {
        Copy-Item -Path (Join-Path $RepoRoot $file) -Destination (Join-Path $Destination $file) -Force
    }

    foreach ($dir in @('util', 'assets')) {
        $sourceDir = Join-Path $RepoRoot $dir
        $targetDir = Join-Path $Destination $dir
        Ensure-Dir $targetDir
        $rc = Start-Process -FilePath robocopy -ArgumentList @(
            $sourceDir, $targetDir,
            '/E',
            '/NFL','/NDL','/NJH','/NJS',
            '/XF','*.pyc','*.pyo',
            '/XD','__pycache__','2025'
        ) -PassThru -Wait
        if ($rc.ExitCode -ge 8) { throw "Robocopy failed with code $($rc.ExitCode) for $dir" }
    }

    Write-Ok 'CLI payload copied.'
}

function Create-Venv {
    param([string]$Python, [string]$Path)
    Write-Step 'Creating virtual environment (.venv)'
    & $Python -m venv $Path
    $venvPython = Join-Path $Path 'Scripts/python.exe'
    if (-not (Test-Path $venvPython)) { throw 'Failed to create virtual environment.' }
    Write-Ok 'Virtual environment ready.'
    return $venvPython
}

function Install-Requirements {
    param([string]$Python)
    Write-Step 'Installing Python dependencies'
    & $Python -m pip install --upgrade pip wheel setuptools
    & $Python -m pip install `
        "numpy<2" `
        sounddevice `
        keyboard `
        typer `
        colorama `
        rich `
        watchdog `
        pynput `
        pypinyin `
        ffmpeg-python `
        srt `
        markdown-it-py `
        pyclip
    Write-Ok 'Dependencies installed.'
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

# --------------------------- Main
Write-Step "Install dir: $InstallDir"
Ensure-Dir $InstallDir

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not (Test-Path (Join-Path $repoRoot 'core_client.py'))) {
    throw "CLI source not found in repo root: $repoRoot"
}

$python = Ensure-Python311
Copy-ClientPayload -RepoRoot $repoRoot -Destination $InstallDir
$venvPython = Create-Venv -Python $python -Path (Join-Path $InstallDir '.venv')
Install-Requirements -Python $venvPython
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

Write-Host "`nInstallation complete." -ForegroundColor Green
Write-Host "Install path: $InstallDir"
Write-Host "Launch: $InstallDir\Start-CapsWriter.bat (Run as Administrator for global hotkey)"
Write-Host "Config:  $InstallDir\config.py  (backend_url, hotkeys, etc.)"
