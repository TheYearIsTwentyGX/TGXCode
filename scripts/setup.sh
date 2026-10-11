#!/usr/bin/env bash
#
# Set up TGXCode on a new machine, from a bare Ubuntu (WSL or not) to a built app.
#
#   bash scripts/setup.sh                 everything below, asking before anything slow
#   bash scripts/setup.sh --dry-run       print what would run, change nothing
#   bash scripts/setup.sh --cron          also add the nightly restart to crontab
#   bash scripts/setup.sh --statusline    also install the quota status line
#   bash scripts/setup.sh --no-build      stop before packaging the app
#   bash scripts/setup.sh --dir PATH      where to clone, when not run from a checkout
#
# Or, before there is a checkout at all:
#
#   curl -fsSL https://raw.githubusercontent.com/TheYearIsTwentyGX/TGXCode/main/scripts/setup.sh | bash
#
# What it does, each step skipped when it is already done, so a rerun is cheap:
#
#   1. apt: git, curl, python3, util-linux, iproute2, procps, xdg-utils, and gh
#      from GitHub's own apt repo (Ubuntu's lags by years)
#   2. gh auth login, if not logged in and there is a terminal to do it at
#   3. clone the repo, unless this script is already running out of one
#   4. nvm and a Node LTS in Linux
#   5. Claude Code, from its native installer
#   6. WSL only: Node LTS on Windows, through winget
#   7. WSL only: networkingMode=mirrored in %USERPROFILE%\.wslconfig
#   8. the build — install.ps1 on WSL, electron-builder on Linux
#   9. --cron / --statusline, if asked for
#
# and ends with a list of what is left for you, which is at least logging in to
# Claude Code (an interactive TUI this script should not drive) and, if step 7
# changed anything, `wsl --shutdown`.
#
# Decisions worth knowing before changing this:
#
# - **Windows gets Node from winget, not nvm-windows.** The Windows Node exists
#   for one job — install.ps1's npm install and electron-builder — and nobody
#   switches versions there. nvm-windows makes `nvm use` a symlink under Program
#   Files that needs an elevated shell every time, which is a worse thing to
#   drive from WSL than one UAC prompt for an MSI.
# - **The build is run with a refreshed Windows PATH.** WSL captures the Windows
#   environment when the distro starts, so a Node winget installed a minute ago
#   is invisible to `npm run build`'s powershell.exe. The build below reloads
#   PATH from the registry before calling install.ps1 for exactly that reason.
# - **install.ps1 force-closes a running TGXCode.** Harmless on a new machine,
#   and the opposite on a machine already using it, so the build asks first when
#   it finds one running and skips it when there is no terminal to ask at.
# - **.wslconfig is merged, never replaced.** Other sections and keys survive;
#   the original is kept as .wslconfig.bak, and CRLF line endings stay CRLF.
#   `--merge-wslconfig FILE` runs just that step against any file, which is
#   what test/setup.test.js drives.
# - **`wsl --shutdown` is left to you.** It ends this shell along with every
#   other WSL process, including any Claude sessions you have running.
#
# The host check is bridge/platform.js's — WSL_DISTRO_NAME or WSLInterop —
# with the same TGXCODE_HOST_KIND override (`wsl` or `linux`).

set -uo pipefail

REPO_URL="https://github.com/TheYearIsTwentyGX/TGXCode.git"
NVM_VERSION="v0.40.1"

DRY=0
CRON=0
STATUSLINE=0
BUILD=1
DIR=""
TODO=()

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mtgxcode setup: %s\033[0m\n' "$*" >&2; exit 1; }
todo() { TODO+=("$*"); }

# Run a command, or under --dry-run print it.
run() {
    if [ "$DRY" = 1 ]; then printf '    + %s\n' "$*"; return 0; fi
    "$@"
}
# The same, for a pipeline that has to go through a shell.
run_sh() {
    if [ "$DRY" = 1 ]; then printf '    + %s\n' "$1"; return 0; fi
    bash -c "$1"
}

# A terminal to ask at. Under `curl | bash` stdin is the script, so read the tty.
have_tty() { [ -r /dev/tty ] && [ -w /dev/tty ] && { : </dev/tty; } 2>/dev/null; }
confirm() {
    have_tty || return 1
    local reply
    printf '    %s [y/N] ' "$1" >/dev/tty
    read -r reply </dev/tty || return 1
    [[ "$reply" =~ ^[Yy] ]]
}

is_wsl() {
    case "${TGXCODE_HOST_KIND:-}" in
        wsl) return 0 ;;
        linux) return 1 ;;
    esac
    [ -n "${WSL_DISTRO_NAME:-}" ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop ]
}

# ── .wslconfig ──────────────────────────────────────────────────────────────

# Ensure [wsl2] networkingMode=mirrored in FILE. Prints `created`, `changed` or
# `unchanged`. Keys are matched case-insensitively, the way WSL reads them.
merge_wslconfig() {
    local file="$1" tmp crlf=0
    if [ ! -e "$file" ]; then
        printf '[wsl2]\r\nnetworkingMode=mirrored\r\ndnsTunneling=true\r\nautoProxy=true\r\nfirewall=true\r\n' >"$file"
        echo created
        return 0
    fi
    grep -q $'\r$' "$file" && crlf=1
    tmp="$(mktemp)"
    tr -d '\r' <"$file" | awk '
        function flush_missing() {
            if (in_wsl2 && !seen) { print "networkingMode=mirrored"; seen = 1 }
        }
        /^[[:space:]]*\[/ {
            flush_missing()
            hdr = tolower($0); gsub(/[[:space:]]/, "", hdr)
            in_wsl2 = (hdr == "[wsl2]")
            if (in_wsl2) had_wsl2 = 1
            print; next
        }
        in_wsl2 && tolower($0) ~ /^[[:space:]]*networkingmode[[:space:]]*=/ {
            seen = 1
            v = tolower($0); sub(/^[^=]*=[[:space:]]*/, "", v); sub(/[[:space:]]*(#.*)?$/, "", v)
            print (v == "mirrored" ? $0 : "networkingMode=mirrored"); next
        }
        { print }
        END {
            flush_missing()
            if (!had_wsl2) { print ""; print "[wsl2]"; print "networkingMode=mirrored" }
        }' >"$tmp"
    if [ "$crlf" = 1 ]; then sed -i 's/$/\r/' "$tmp"; fi
    if cmp -s "$tmp" "$file"; then
        rm -f "$tmp"
        echo unchanged
    else
        cp "$file" "$file.bak"
        cat "$tmp" >"$file"
        rm -f "$tmp"
        echo changed
    fi
}

# ── arguments ───────────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1 ;;
        --cron) CRON=1 ;;
        --statusline) STATUSLINE=1 ;;
        --no-build) BUILD=0 ;;
        --dir) shift; DIR="${1:-}"; [ -n "$DIR" ] || die "--dir needs a path" ;;
        --dir=*) DIR="${1#--dir=}" ;;
        --merge-wslconfig) shift; [ -n "${1:-}" ] || die "--merge-wslconfig needs a file"
                           merge_wslconfig "$1"; exit $? ;;
        -h|--help) sed -n '3,/^# What it does/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $1 (try --help)" ;;
    esac
    shift
done

[ "$(id -u)" = 0 ] && die "run this as your own user, not root — it uses sudo where it has to"
command -v apt-get >/dev/null 2>&1 || die "this script knows apt, and there is no apt-get here"

WSL=0; is_wsl && WSL=1
[ "$DRY" = 1 ] && say "Dry run: nothing below is executed"

# ── 1. system packages ──────────────────────────────────────────────────────

say "System packages"
PKGS=(git curl ca-certificates python3 util-linux iproute2 procps xdg-utils)
MISSING=()
for p in "${PKGS[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done
if [ ${#MISSING[@]} -gt 0 ]; then
    run sudo apt-get update
    run sudo apt-get install -y "${MISSING[@]}" || die "apt-get install failed"
else
    ok "all present"
fi

if command -v gh >/dev/null 2>&1; then
    ok "gh $(gh --version | head -1 | awk '{print $3}')"
else
    run sudo mkdir -p -m 755 /etc/apt/keyrings
    run_sh "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null"
    run sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    run_sh "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null"
    run sudo apt-get update
    run sudo apt-get install -y gh || die "could not install gh"
fi

# ── 2. GitHub login ─────────────────────────────────────────────────────────

say "GitHub"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    ok "logged in"
elif [ "$DRY" = 1 ]; then
    run gh auth login
elif have_tty; then
    gh auth login </dev/tty >/dev/tty 2>&1 || todo "Log in to GitHub: gh auth login"
else
    todo "Log in to GitHub: gh auth login"
fi

# ── 3. the checkout ─────────────────────────────────────────────────────────

say "Checkout"
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ] && [ -f "$(dirname "$SELF")/../bridge/server.js" ]; then
    REPO="$(cd "$(dirname "$SELF")/.." && pwd)"
    ok "running from $REPO"
else
    REPO="${DIR:-$HOME/TGXCode}"
    REPO="${REPO/#\~/$HOME}"
    if [ -f "$REPO/bridge/server.js" ]; then
        ok "already cloned at $REPO"
    else
        [ -e "$REPO" ] && [ -n "$(ls -A "$REPO" 2>/dev/null)" ] \
            && die "$REPO exists and is not a TGXCode checkout; pass --dir somewhere else"
        run git clone "$REPO_URL" "$REPO" || die "git clone failed"
    fi
fi

# ── 4. Node in Linux ────────────────────────────────────────────────────────

say "Node (Linux)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
if command -v node >/dev/null 2>&1; then
    ok "node $(node --version) at $(command -v node)"
else
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        run_sh "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash" \
            || die "nvm install failed"
    fi
    if [ "$DRY" = 1 ]; then
        run nvm install --lts
    else
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh" || die "nvm installed but will not load from $NVM_DIR"
        nvm install --lts || die "nvm install --lts failed"
        nvm alias default 'lts/*' >/dev/null
    fi
fi

# ── 5. Claude Code ──────────────────────────────────────────────────────────

say "Claude Code"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
if command -v claude >/dev/null 2>&1; then
    ok "claude at $(command -v claude)"
else
    run_sh "curl -fsSL https://claude.ai/install.sh | bash" || die "Claude Code install failed"
fi
if [ ! -s "$HOME/.claude/.credentials.json" ]; then
    todo "Log in to Claude Code: run \`claude\` once, follow the login, then /exit"
fi

# ── 6–7. the Windows side ───────────────────────────────────────────────────

# Run PowerShell with PATH reloaded from the registry, from /mnt/c because
# Windows tools refuse a \\wsl.localhost working directory.
winps() {
    (cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
        "\$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); $1") \
        | tr -d '\r'
}

RESTART_WSL=0
if [ "$WSL" = 1 ]; then
    command -v powershell.exe >/dev/null 2>&1 \
        || die "powershell.exe is not reachable from WSL; is Windows interop turned off in /etc/wsl.conf?"

    say "Node (Windows)"
    WIN_NODE="$(winps "(Get-Command node -ErrorAction SilentlyContinue).Source")"
    if [ -n "$WIN_NODE" ]; then
        ok "node at $WIN_NODE"
    else
        echo "    winget will ask Windows for permission (a UAC prompt) to install the MSI."
        run_sh "cd /mnt/c && winget.exe install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements" \
            || die "winget could not install Node; install the Windows LTS from nodejs.org and rerun"
    fi

    say "WSL networking"
    BUILD_NO="$(winps "[Environment]::OSVersion.Version.Build")"
    if [ -n "$BUILD_NO" ] && [ "$BUILD_NO" -lt 22621 ] 2>/dev/null; then
        warn "Windows build $BUILD_NO is older than 22621 (11 22H2), which mirrored networking needs."
        warn "The window will not reach the bridge until Windows is updated."
    fi
    WIN_PROFILE="$(winps 'Write-Output $env:USERPROFILE')"
    [ -n "$WIN_PROFILE" ] || die "could not find %USERPROFILE%"
    WSLCONFIG="$(wslpath -u "$WIN_PROFILE")/.wslconfig"
    if [ "$DRY" = 1 ]; then
        # Merge a copy, so the dry run can say whether a real one would change it.
        DRYCOPY="$(mktemp -d)/.wslconfig"
        [ -e "$WSLCONFIG" ] && cp "$WSLCONFIG" "$DRYCOPY"
        ok "$WSLCONFIG would be: $(merge_wslconfig "$DRYCOPY")"
        rm -rf "$(dirname "$DRYCOPY")"
    else
        case "$(merge_wslconfig "$WSLCONFIG")" in
            unchanged) ok "networkingMode=mirrored already set" ;;
            created) ok "wrote $WSLCONFIG"; RESTART_WSL=1 ;;
            changed) ok "set networkingMode=mirrored (old file at .wslconfig.bak)"; RESTART_WSL=1 ;;
        esac
    fi
    [ "$RESTART_WSL" = 1 ] && todo "Restart WSL so mirrored networking takes effect: \`wsl --shutdown\` in PowerShell (this ends every WSL process), then reopen Ubuntu"
fi

# ── 8. build ────────────────────────────────────────────────────────────────

say "Build"
if [ "$BUILD" = 0 ]; then
    ok "skipped (--no-build)"
    todo "Build the app: cd $REPO && npm run build"
elif [ "$WSL" = 1 ]; then
    RUNNING="$(winps "Get-Process TGXCode,ClaudeSessions -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty ProcessName")"
    GO=1
    if [ -n "$RUNNING" ] && [ "$DRY" = 1 ]; then
        warn "TGXCode is running; a real run would ask before the installer closes it"
    elif [ -n "$RUNNING" ] && ! confirm "TGXCode is running, and the installer closes it. Build anyway?"; then
        GO=0
        warn "skipped: TGXCode is running"
        todo "Build the app once TGXCode is closed: cd $REPO && npm run build"
    fi
    if [ "$GO" = 1 ]; then
        WIN_SCRIPT="$(wslpath -w "$REPO/install.ps1")"
        if [ "$DRY" = 1 ]; then
            run powershell.exe -File "$WIN_SCRIPT"
        else
            # Not through winps: its tr would buffer install.ps1's progress.
            (cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
                "\$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); & '$WIN_SCRIPT'; exit \$LASTEXITCODE") || die "install.ps1 failed — the output above says where"
        fi
    fi
else
    run_sh "cd '$REPO' && npm run build" || die "npm run build failed"
    todo "Start it: cd $REPO && npm start"
fi

# ── 9. extras ───────────────────────────────────────────────────────────────

if [ "$CRON" = 1 ]; then
    say "Nightly restart"
    LINE="0 0 * * * $REPO/scripts/restart-bridge.sh >/tmp/bridge.log 2>&1"
    CURRENT="$(crontab -l 2>/dev/null || true)"
    if printf '%s\n' "$CURRENT" | grep -v '^[[:space:]]*#' | grep -q 'restart-bridge\.sh'; then
        ok "already in crontab"
    else
        NEW="$CURRENT"
        printf '%s\n' "$CURRENT" | grep -q '^SHELL=' || NEW="SHELL=/bin/bash"$'\n'"$NEW"
        printf '%s\n' "$CURRENT" | grep -q '^MAILTO=' || NEW="MAILTO=\"\""$'\n'"$NEW"
        NEW="$NEW"$'\n'"# Daily: restarts the bridge for TGXCode"$'\n'"$LINE"
        if [ "$DRY" = 1 ]; then run crontab -; else printf '%s\n' "$NEW" | crontab - && ok "added"; fi
    fi
fi

if [ "$STATUSLINE" = 1 ]; then
    say "Quota status line"
    run node "$REPO/scripts/install-quota-statusline.js" \
        || warn "not installed — the message above says why"
fi

# ── what is left ────────────────────────────────────────────────────────────

say "Done"
if [ ${#TODO[@]} -eq 0 ]; then
    ok "Nothing left to do. Launch TGXCode."
else
    echo "    Still yours to do:"
    for t in "${TODO[@]}"; do printf '      - %s\n' "$t"; done
fi
