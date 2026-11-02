<#
.SYNOPSIS
    Build and install the TGXCode Windows app.

.DESCRIPTION
    Only the Electron shell is packaged -- the bridge and the UI stay in WSL and
    are loaded at runtime, so this installer is small and you rarely need to
    rerun it. Editing anything under bridge/ or web/ takes effect on the next
    app restart (or Ctrl+R for UI-only changes); rerun this script only when
    app/main.js or package.json changes.

    Packaging happens in a Windows-local staging directory rather than over the
    \\wsl.localhost share, because electron-builder is slow and unreliable on a
    UNC path.

    Once an app built by this script is installed, it can update itself: build
    with `npm run release:local` (which calls this with -Release) and the app
    offers the update in Settings > Updates. A plain run still closes the app and
    runs the installer wizard, which is how you get onto the updatable build the
    first time.

    Every build carries a version worked out from git (scripts/release.js --info),
    so the updater can tell builds apart, and app/build-info.json with the hash of
    the shell it was built from, which is how the UI knows when app/ has moved on.

.PARAMETER Release
    Build for the updates feed: stage in TGXCode-release, leave the running app
    alone, and do not run the installer. scripts/release.js passes this, then
    copies the result into the feed folder.

.PARAMETER Version
    The version to build. Asked of scripts/release.js when not given.

.PARAMETER ShellHash
    Hash of the app/ being packaged (bridge/shell-build.js). Asked of
    scripts/release.js along with the version when not given.

.PARAMETER BridgeDir
    Where this repository lives *inside WSL*. Detected from the script's own
    location when it is run from the WSL share.

.PARAMETER Distro
    WSL distribution to run the bridge in. Defaults to your default distro.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -BridgeDir '~/Other/claude-sessions' -Distro Ubuntu
    npm run release:local     # from WSL: build an update without closing the app
#>

[CmdletBinding()]
param(
    [string]$BridgeDir,
    [string]$Distro = '',
    [switch]$NoInstall,
    [switch]$Release,
    [string]$Version = '',
    [string]$ShellHash = '',
    [string]$Commit = ''
)

$ErrorActionPreference = 'Stop'

function Say($msg, $color = 'Cyan') { Write-Host $msg -ForegroundColor $color }

Say ''
Say '  TGXCode -- build and install'
Say '  ---------------------------'
Say ''

# -- work out where the bridge lives inside WSL -------------------------------

$here = $PSScriptRoot
# The distro is read off the share even when the directory is given: a release
# build passes -BridgeDir (the main checkout, not the worktree it ran from), and
# the distro baked in has to be the one it came from.
if ($here -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$') {
    if (-not $Distro) { $Distro = $Matches[1] }
    if (-not $BridgeDir) { $BridgeDir = '/' + ($Matches[2] -replace '\\', '/') }
} elseif (-not $BridgeDir) {
    throw ("Could not tell where this repo lives inside WSL (running from '$here'). " +
           "Pass it explicitly, e.g. -BridgeDir '~/Other/claude-sessions'.")
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

# The version and shell hash this build will carry. scripts/release.js passes
# them; a plain run asks it, so an install by hand never goes back to 1.0.0 and
# looks older than the updates already published.
if (-not $Version) {
    $infoJson = & wsl.exe @wslArgs bash -lc "cd $bashDir && bash bridge/launch.sh --node scripts/release.js --info"
    try {
        # The last line: a login shell's profile may have printed something first.
        $info = ($infoJson | Select-Object -Last 1) | ConvertFrom-Json
        $Version = $info.version
        if (-not $ShellHash) { $ShellHash = $info.shellHash }
        if (-not $Commit -and $info.commit) { $Commit = $info.commit }
    } catch {
        Say "      Could not work out a version ($_); building package.json's." Yellow
    }
}
if ($Version) { Say "      version $Version" Green }

# -- stage the shell somewhere Windows-local ----------------------------------

# A running copy holds a lock on TGXCode.exe and packaging fails with a bare
# "Access is denied", so close it first. ClaudeSessions is the same app from
# before the rename: it holds the everyday port, and the new build cannot adopt
# a window that is still open.
#
# Not for -Release: that build stages somewhere nothing runs from and installs
# nothing, and leaving the open window alone is the whole point of it.
$names = 'TGXCode', 'ClaudeSessions'
$running = if ($Release) { $null } else { Get-Process $names -ErrorAction SilentlyContinue }
if ($running) {
    Say "      $(($running | Select-Object -ExpandProperty ProcessName -Unique) -join ', ') is running; closing it so the build can replace it." Yellow
    $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    Start-Sleep -Seconds 2
    Get-Process $names -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
}

# The staging directory from before the rename is dead weight now.
$oldStage = Join-Path $env:LOCALAPPDATA 'ClaudeSessions-build'
if (Test-Path $oldStage) { Remove-Item $oldStage -Recurse -Force -ErrorAction SilentlyContinue }

# A release stages on its own: `npm start` may be running a copy out of
# TGXCode-build\dist\win-unpacked, and a file in use there fails the wipe.
$stage = Join-Path $env:LOCALAPPDATA $(if ($Release) { 'TGXCode-release' } else { 'TGXCode-build' })
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

# What this build is, for the updater and the UI's "shell out of date" check.
$buildInfo = [ordered]@{
    version = $Version; shellHash = $ShellHash; commit = $Commit
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
[System.IO.File]::WriteAllText(
    (Join-Path $stage 'app\build-info.json'), ($buildInfo | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding($false)))

# An explicit -BridgeDir/-Distro is also written to the profile's config.json,
# which wins over the baked one -- the shell copies the baked one there on first
# launch, so that an update built elsewhere cannot move the bridge. Without this,
# the parameter would stop meaning anything after the first install.
if (-not $Release -and ($PSBoundParameters.ContainsKey('BridgeDir') -or $PSBoundParameters.ContainsKey('Distro'))) {
    $profileDir = Join-Path $env:APPDATA 'tgxcode'
    $profileCfg = Join-Path $profileDir 'config.json'
    $current = [ordered]@{}
    if (Test-Path $profileCfg) {
        try {
            $parsed = (Get-Content $profileCfg -Raw) -replace '^\uFEFF', '' | ConvertFrom-Json
            foreach ($p in $parsed.PSObject.Properties) { $current[$p.Name] = $p.Value }
        } catch { }
    }
    $current['bridgeDir'] = $BridgeDir
    $current['distro'] = $Distro
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    [System.IO.File]::WriteAllText($profileCfg, ($current | ConvertTo-Json),
        (New-Object System.Text.UTF8Encoding($false)))
    Say "      $profileCfg updated." Green
}

# -- build --------------------------------------------------------------------

Push-Location $stage
try {
    Say '[3/5] Installing build dependencies (first run downloads Electron, ~100MB)...' Yellow
    if ($Version) {
        # Only edits the staged package.json; there is no git here to tag.
        & npm version $Version --no-git-tag-version --allow-same-version | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "npm version $Version failed." }
    }
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

if ($Release) {
    Say ''
    Say 'Release build: the installer was not run and nothing was closed.' Green
    Say ''
    exit 0
}

if ($NoInstall) {
    Say ''
    Say 'Skipping install (-NoInstall). Run the installer yourself when ready.' Yellow
} else {
    Say ''
    Say 'Launching the installer -- complete the wizard to finish.' Green
    Start-Process $installer.FullName
}

Say ''
Say 'Done. After installing, launch "TGXCode" from the Start menu.' Cyan
if (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\ClaudeSessions')) {
    # A new appId is a new application to Windows, so the old one is not
    # replaced. Its settings were copied across on first launch; the app itself
    # is safe to remove.
    Say 'The old "ClaudeSessions" app is still installed alongside it. Once TGXCode' Yellow
    Say 'has opened once, uninstall ClaudeSessions from Settings > Apps.' Yellow
}
Say 'Changes to bridge/ or web/ do not need a rebuild -- just restart the app.' Cyan
Say 'For app/ changes from now on: npm run release:local in WSL, then' Cyan
Say 'Settings > Updates in the app. No reinstall, nothing closed until you restart.' Cyan
Say ''
