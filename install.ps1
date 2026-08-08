<#
.SYNOPSIS
    Build and install the Claude Sessions Windows app.

.DESCRIPTION
    Only the Electron shell is packaged -- the bridge and the UI stay in WSL and
    are loaded at runtime, so this installer is small and you rarely need to
    rerun it. Editing anything under bridge/ or web/ takes effect on the next
    app restart (or Ctrl+R for UI-only changes); rerun this script only when
    app/main.js or package.json changes.

    Packaging happens in a Windows-local staging directory rather than over the
    \\wsl.localhost share, because electron-builder is slow and unreliable on a
    UNC path.

.PARAMETER BridgeDir
    Where this repository lives *inside WSL*. Detected from the script's own
    location when it is run from the WSL share.

.PARAMETER Distro
    WSL distribution to run the bridge in. Defaults to your default distro.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -BridgeDir '~/Other/claude-sessions' -Distro Ubuntu
#>

[CmdletBinding()]
param(
    [string]$BridgeDir,
    [string]$Distro = '',
    [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

function Say($msg, $color = 'Cyan') { Write-Host $msg -ForegroundColor $color }

Say ''
Say '  Claude Sessions -- build and install'
Say '  -----------------------------------'
Say ''

# -- work out where the bridge lives inside WSL -------------------------------

$here = $PSScriptRoot
if (-not $BridgeDir) {
    if ($here -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$') {
        if (-not $Distro) { $Distro = $Matches[1] }
        $BridgeDir = '/' + ($Matches[2] -replace '\\', '/')
    } else {
        throw ("Could not tell where this repo lives inside WSL (running from '$here'). " +
               "Pass it explicitly, e.g. -BridgeDir '~/Other/claude-sessions'.")
    }
}

Say "  Bridge directory : $BridgeDir"
Say "  WSL distro       : $(if ($Distro) { $Distro } else { '(default)' })"
Say ''

# -- sanity: can WSL see the bridge, and does it have node? -------------------

Say '[1/5] Checking WSL...' Yellow
$wslArgs = @()
if ($Distro) { $wslArgs += @('-d', $Distro) }

# Keep a leading ~ expandable; single quotes would stop bash resolving it.
$bashDir = if ($BridgeDir.StartsWith('~/')) {
    '"$HOME"/' + "'" + $BridgeDir.Substring(2) + "'"
} else {
    "'" + $BridgeDir + "'"
}

$check = & wsl.exe @wslArgs bash -lc "cd $bashDir 2>/dev/null && bash bridge/launch.sh --check"
if ($LASTEXITCODE -ne 0 -or -not $check) {
    throw ("WSL could not start the bridge at '$BridgeDir'. " +
           "Check the path exists there and that node is installed. " +
           "Run this to see the error: wsl.exe bash -lc ""cd $BridgeDir && bash bridge/launch.sh --check""")
}
Say "      node found in WSL: $check" Green

# -- stage the shell somewhere Windows-local ----------------------------------

# A running copy holds a lock on ClaudeSessions.exe and packaging fails with a
# bare "Access is denied", so close it first.
$running = Get-Process ClaudeSessions -ErrorAction SilentlyContinue
if ($running) {
    Say '      ClaudeSessions is running; closing it so the build can replace it.' Yellow
    $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    Start-Sleep -Seconds 2
    Get-Process ClaudeSessions -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
}

$stage = Join-Path $env:LOCALAPPDATA 'ClaudeSessions-build'
Say "[2/5] Staging the shell in $stage..." Yellow

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item (Join-Path $here 'package.json') $stage
Copy-Item (Join-Path $here 'app') $stage -Recurse

# Bake in where to find the bridge so the app needs no setup on first run.
# Write UTF-8 *without* a BOM: Set-Content -Encoding UTF8 adds one on Windows
# PowerShell 5.1, and JSON.parse refuses to read it.
$config = [ordered]@{ bridgeDir = $BridgeDir; distro = $Distro }
$json = $config | ConvertTo-Json
[System.IO.File]::WriteAllText(
    (Join-Path $stage 'app\config.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Say '      config.json written.' Green

# -- build --------------------------------------------------------------------

Push-Location $stage
try {
    Say '[3/5] Installing build dependencies (first run downloads Electron, ~100MB)...' Yellow
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }

    Say '[4/5] Packaging...' Yellow
    & npm run dist
    if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed.' }
} finally {
    Pop-Location
}

$installer = Get-ChildItem (Join-Path $stage 'dist') -Filter '*.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*Setup*' } | Select-Object -First 1

if (-not $installer) { throw "Build finished but no installer turned up in $stage\dist." }

Say "[5/5] Installer ready: $($installer.FullName)" Green

if ($NoInstall) {
    Say ''
    Say 'Skipping install (-NoInstall). Run the installer yourself when ready.' Yellow
} else {
    Say ''
    Say 'Launching the installer -- complete the wizard to finish.' Green
    Start-Process $installer.FullName
}

Say ''
Say 'Done. After installing, launch "ClaudeSessions" from the Start menu.' Cyan
Say 'Changes to bridge/ or web/ do not need a rebuild -- just restart the app.' Cyan
Say ''
