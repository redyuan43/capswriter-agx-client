<#
.SYNOPSIS
    Uninstall CapsWriter client from a Windows host.

.DESCRIPTION
    Removes the install directory and user shortcuts created by the installer.

.PARAMETER InstallDir
    Target install directory. Default: $env:LOCALAPPDATA\CapsWriter

.PARAMETER RemoveShortcuts
    Remove Desktop and Startup shortcuts (default: $true)

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File scripts/uninstall-client.ps1
#>
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Medium')]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CapsWriter'),
    [switch]$RemoveShortcuts = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step($msg){ Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg){ Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg){ Write-Warning $msg }

Write-Step "Uninstalling from: $InstallDir"

if (Test-Path $InstallDir) {
    # Try to stop running client processes that started from this folder
    try {
        Get-CimInstance Win32_Process |
            Where-Object { $_.ExecutablePath -and $_.CommandLine -and $_.CommandLine -match [Regex]::Escape($InstallDir) } |
            ForEach-Object { Write-Step "Stopping PID $($_.ProcessId): $($_.Name)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}

    Remove-Item -Recurse -Force -Path $InstallDir
    Write-Ok 'Install directory removed.'
} else {
    Write-Warn "Install directory not found: $InstallDir"
}

if ($RemoveShortcuts) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $startup = [Environment]::GetFolderPath('Startup')
    foreach($path in @(
        (Join-Path $desktop 'CapsWriter.lnk'),
        (Join-Path $startup 'CapsWriter.lnk')
    )){
        if (Test-Path $path) { Remove-Item -Force $path; Write-Ok "Removed shortcut: $path" }
    }
}

Write-Host "Done." -ForegroundColor Green

