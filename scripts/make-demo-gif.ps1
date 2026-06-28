<#
.SYNOPSIS
    Convert a screen recording (MP4/MOV) into an optimized GIF for README.

.DESCRIPTION
    Uses ffmpeg palette generation for a compact, decent-looking GIF.
    If gifski is available, it will be used for higher quality.

.PARAMETER Input
    Path to an input video (mp4/mov/webm). Required.

.PARAMETER Output
    Output GIF path. Default: assets/demo.gif

.PARAMETER Fps
    Frame rate for the GIF (default 18)

.PARAMETER Width
    Target width in pixels (default 720)

.PARAMETER UseGifski
    Force using gifski if found; otherwise palette-based ffmpeg is used.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File scripts/make-demo-gif.ps1 -Input demo.mp4 -Output assets/demo.gif -Fps 18 -Width 720

.NOTES
    If ffmpeg is missing, the script will try to install it via winget (requires network).
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [Parameter(Mandatory=$true)][string]$Input,
    [string]$Output = (Join-Path (Split-Path $PSScriptRoot -Parent) 'assets/demo.gif'),
    [int]$Fps = 18,
    [int]$Width = 720,
    [switch]$UseGifski
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step($m){ Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok($m){ Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Warn($m){ Write-Warning $m }

if (-not (Test-Path $Input)) { throw "Input not found: $Input" }
if (-not (Test-Path (Split-Path $Output -Parent))) { New-Item -ItemType Directory -Path (Split-Path $Output -Parent) | Out-Null }

function Ensure-Tool($name,$wingetId){
    try { return (Get-Command $name -ErrorAction Stop).Path } catch {}
    Write-Warn "$name not found. Attempting to install via winget..."
    try { Get-Command winget -ErrorAction Stop | Out-Null } catch { throw "winget not found; please install $name manually." }
    & winget install -e --id $wingetId --accept-package-agreements --accept-source-agreements
    try { return (Get-Command $name -ErrorAction Stop).Path } catch { throw "Failed to install $name. Please install manually." }
}

$ffmpeg = Ensure-Tool 'ffmpeg' 'Gyan.FFmpeg'
Write-Step "Using ffmpeg: $ffmpeg"

$gifskiPath = $null
if ($UseGifski) {
    try { $gifskiPath = (Get-Command gifski -ErrorAction Stop).Path } catch {
        Write-Warn 'gifski not found; continuing with ffmpeg palette method.'
    }
}

if ($gifskiPath) {
    Write-Step "Converting via gifski (quality path)"
    $tmp = New-Item -ItemType Directory -Force -Path (Join-Path ([IO.Path]::GetTempPath()) ("gifframes_" + [Guid]::NewGuid()))
    try {
        & $ffmpeg -y -i $Input -vf "fps=$Fps,scale=$Width:-1:flags=lanczos" (Join-Path $tmp.FullName 'f%04d.png')
        & $gifskiPath -o $Output --fps $Fps --quality 80 (Join-Path $tmp.FullName 'f*.png')
    } finally {
        Remove-Item -Recurse -Force $tmp.FullName -ErrorAction SilentlyContinue
    }
} else {
    Write-Step "Converting via ffmpeg palette (compact path)"
    & $ffmpeg -y -i $Input -vf "fps=$Fps,scale=$Width:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64:stats_mode=diff[p];[s1][p]paletteuse=dither=floyd_steinberg" -loop 0 $Output
}

Write-Ok "GIF saved: $Output"

