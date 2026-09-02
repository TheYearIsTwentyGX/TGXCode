#!/usr/bin/env bash
#
# Start the bridge with a usable node — and a usable PATH — whatever started us.
#
# The Windows shell starts us through `wsl.exe bash -lc`. A login shell reads
# ~/.profile but not ~/.bashrc, and nvm installs its PATH shim in ~/.bashrc — so
# in that context `node` is simply missing even though it works fine in a normal
# terminal. Every caller goes through this script so the fix lives in one place.
#
# **Cron is worse than a login shell, and that cost a restart every morning.**
# The nightly entry runs this non-login *and* non-interactive, so it reads neither
# ~/.profile nor ~/.bashrc and starts from `PATH=/usr/bin:/bin`. node was rescued
# below and `claude` was not — it lives in ~/.local/bin, which only those two
# files put on PATH — so the midnight bridge came up looking perfect and could not
# start a single turn: every message died with ENOENT, reported as a `close` code
# of -2, and the 2 AM scheduled review and the quota beacon failed the same way
# without saying so. bridge/config.js now resolves the binary itself, which is
# the actual fix; the PATH work here is for the *sessions* this bridge starts,
# which inherit its environment wholesale (see sessionEnv in bridge/runner.js)
# and need more than node on PATH to be any use.
#
#   bridge/launch.sh            start the bridge
#   bridge/launch.sh --check    print the node and claude paths and exit
#                               (used by install.ps1)

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

find_node() {
    command -v node >/dev/null 2>&1 && return 0

    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    fi
    command -v node >/dev/null 2>&1 && return 0

    # nvm.sh missing or non-functional: fall back to the newest installed version.
    local newest
    newest=$(find "$NVM_DIR/versions/node" -maxdepth 2 -type d -name bin 2>/dev/null \
        | sort -V | tail -1)
    if [ -n "$newest" ]; then
        PATH="$newest:$PATH"
        export PATH
    fi
    command -v node >/dev/null 2>&1
}

if ! find_node; then
    echo "claude-sessions: no node found in WSL." >&2
    echo "  Looked on PATH, in \$NVM_DIR/nvm.sh, and under \$NVM_DIR/versions/node." >&2
    echo "  Install node, or add it to PATH from ~/.profile so login shells see it." >&2
    exit 127
fi

# The directories a person's own shell has and a cron job does not. Prepended for
# the sessions' sake as much as ours: an agent that cannot find npm, pnpm or
# claude is not much of an agent, and `sessionEnv()` hands each one whatever PATH
# this process ends up with.
#
# Idempotent, so the bridge that bridge/restart.js relaunches as its own child
# does not accumulate a copy of these per restart.
add_bin() {
    [ -n "${1:-}" ] || return 0
    [ -d "$1" ] || return 0
    case ":$PATH:" in
        *":$1:"*) return 0 ;;
    esac
    PATH="$1:$PATH"
    export PATH
}

add_bin "$HOME/.local/bin"
add_bin "${PNPM_HOME:-}"

# Where `claude` ended up, for --check and for the warning below. Only reports;
# the PATH work is done above and bridge/config.js resolves the binary properly.
find_claude() {
    command -v claude 2>/dev/null && return 0
    for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" \
             /usr/local/bin/claude /usr/bin/claude; do
        if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
    done
    return 1
}

if [ "${1:-}" = "--check" ]; then
    printf '%s %s\n' "$(command -v node)" "$(node --version)"
    printf 'claude %s\n' "$(find_claude || echo 'NOT FOUND')"
    exit 0
fi

# Say so, and start anyway.
#
# Exiting here would be worse than the problem: scripts/restart-bridge.sh has
# already killed the running bridge by the time it calls us, so a non-zero exit
# turns "a bridge that cannot start turns" into "no bridge at all" — discovered
# at 9am, with the journal reading `failed-start`. A bridge that cannot find
# `claude` still serves every transcript, board and terminal it ever did. So this
# is a report, not a refusal: /api/health carries `claudeBin` for the window and
# for restart-bridge.sh, which journals `restarted-no-claude` rather than
# claiming a success.
if ! find_claude >/dev/null; then
    echo "claude-sessions: no 'claude' found in WSL — sessions will not start." >&2
    echo "  Looked on PATH, in ~/.local/bin, ~/.claude/local, /usr/local/bin and /usr/bin." >&2
    echo "  PATH=$PATH" >&2
    echo "  Starting anyway: reading transcripts still works. See /api/health claudeBin." >&2
fi

exec node bridge/server.js "$@"
