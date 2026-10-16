#!/usr/bin/env bash
#
# Start the bridge with a usable node on PATH.
#
# The Windows shell starts us through `wsl.exe bash -lc`. A login shell reads
# ~/.profile but not ~/.bashrc, and nvm installs its PATH shim in ~/.bashrc — so
# in that context `node` is simply missing even though it works fine in a normal
# terminal. Every caller goes through this script so the fix lives in one place.
#
#   bridge/launch.sh            start the bridge
#   bridge/launch.sh --check    print the node version and exit (used by install.ps1)

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
    echo "tgxcode: no node found in WSL." >&2
    echo "  Looked on PATH, in \$NVM_DIR/nvm.sh, and under \$NVM_DIR/versions/node." >&2
    echo "  Install node, or add it to PATH from ~/.profile so login shells see it." >&2
    exit 127
fi

# TGXCODE_ORIGINS is the hostname a tunnel reaches us by, and it lives in
# ~/.profile because the Windows shell's `bash -lc` reads that file. Everything
# else that starts a bridge does not: scripts/restart-bridge.sh hands us the
# environment of whoever called it — a cron entry, `npm run land` from an agent's
# session, a shell that never read ~/.profile — and a bridge started without the
# variable answers every tunnel request `403 unexpected host`, which is the phone
# going dark until somebody restarts from a login shell. So when neither name is
# set, ask ~/.profile for it. In a subshell, and only that one value comes back:
# nothing else the profile does reaches the bridge's environment. Set to empty
# on purpose still wins, because only an unset variable is filled in.
if [ -z "${TGXCODE_ORIGINS+x}" ] && [ -z "${CLAUDE_SESSIONS_ORIGINS+x}" ] \
    && [ -r "$HOME/.profile" ]; then
    origins=$(timeout 10 bash -c \
        '. "$HOME/.profile" >/dev/null 2>&1 </dev/null; printf %s "${TGXCODE_ORIGINS:-${CLAUDE_SESSIONS_ORIGINS:-}}"' \
        2>/dev/null </dev/null)
    if [ -n "$origins" ]; then
        export TGXCODE_ORIGINS="$origins"
    fi
fi

if [ "${1:-}" = "--check" ]; then
    printf '%s %s\n' "$(command -v node)" "$(node --version)"
    exit 0
fi

exec node bridge/server.js "$@"
