#!/usr/bin/env bash
#
# Restart the everyday bridge so it picks up whatever is on main now.
#
#   restart-bridge              restart from the local checkout
#   restart-bridge --pull       fast-forward from origin first, then restart
#   restart-bridge --force      restart even with a turn in flight
#   restart-bridge --status     say what is running and exit
#
# Deliberately narrow: it only ever touches the instance on the everyday port.
# `pkill -f bridge/server.js` would match development bridges too, and killing
# one of those out from under an agent is the thing this whole setup avoids.

set -uo pipefail

PORT="${CLAUDE_SESSIONS_PORT:-45888}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/claude-sessions"
LOG="$LOG_DIR/bridge-$PORT.log"

PULL=0; FORCE=0; STATUS_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --pull) PULL=1 ;;
        --force) FORCE=1 ;;
        --status) STATUS_ONLY=1 ;;
        -h|--help) sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "restart-bridge: unknown option '$arg'" >&2; exit 1 ;;
    esac
done

health() { curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; }

# Read one field out of the health JSON without needing jq.
field() {
    python3 -c "import json,sys
try: print(json.load(sys.stdin).get('$1',''))
except Exception: print('')" 2>/dev/null
}

CURRENT="$(health)"

if [ "$STATUS_ONLY" = 1 ]; then
    if [ -z "$CURRENT" ]; then
        echo "bridge :$PORT  not running"
    else
        # A bridge older than the `busy` field reports nothing for it; say so
        # rather than printing a hole.
        BUSY="$(printf '%s' "$CURRENT" | field busy)"
        printf 'bridge :%s  pid %s  %s sessions  %s client(s)  %s turn(s) in flight\n' \
            "$PORT" "$(printf '%s' "$CURRENT" | field pid)" \
            "$(printf '%s' "$CURRENT" | field sessions)" \
            "$(printf '%s' "$CURRENT" | field clients)" \
            "${BUSY:-an unknown number of}"
    fi
    exit 0
fi

# --- don't throw away work -------------------------------------------------

if [ -n "$CURRENT" ]; then
    BUSY="$(printf '%s' "$CURRENT" | field busy)"
    if [ -n "$BUSY" ] && [ "$BUSY" != "0" ] && [ "$FORCE" != 1 ]; then
        echo "restart-bridge: $BUSY turn(s) still running." >&2
        echo "  A restart ends them — Claude stops when its input pipe closes." >&2
        echo "  Wait for them, or re-run with --force if you don't mind." >&2
        exit 1
    fi
fi

# --- optionally catch up with the remote -----------------------------------

if [ "$PULL" = 1 ]; then
    echo "Updating $REPO…"
    # --ff-only so this can never leave a merge or a conflict behind; if the
    # branch has diverged, that is a decision for a human.
    if ! git -C "$REPO" pull --ff-only; then
        echo "restart-bridge: pull failed, leaving the bridge alone." >&2
        exit 1
    fi
fi

# --- say what is about to be loaded ----------------------------------------

# The bridge runs what is on disk, not what is committed. On a repo where
# several agents work at once that regularly means somebody's half-finished
# edits, so name them rather than loading them silently.
DIRTY="$(git -C "$REPO" status --porcelain 2>/dev/null | grep -v '^??' | wc -l)"
if [ "${DIRTY:-0}" -gt 0 ]; then
    echo "Heads up: $DIRTY tracked file(s) in $REPO have uncommitted changes."
    git -C "$REPO" status --porcelain 2>/dev/null | grep -v '^??' | sed 's/^/    /'
    echo "  The bridge loads what is on disk, so it will run these too."
    if [ "$FORCE" != 1 ]; then
        printf '  Continue? [y/N] '
        read -r reply </dev/tty 2>/dev/null || reply=n
        case "$reply" in
            [yY]*) ;;
            *) echo "Left the bridge alone."; exit 1 ;;
        esac
    fi
fi

# --- swap it out -----------------------------------------------------------

if [ -n "$CURRENT" ]; then
    PID="$(printf '%s' "$CURRENT" | field pid)"
    OLD_REV="$(printf '%s' "$CURRENT" | field version)"
    if [ -n "$PID" ]; then
        kill "$PID" 2>/dev/null
        for _ in $(seq 1 25); do
            health >/dev/null 2>&1 || break
            sleep 0.2
        done
    fi
    echo "Stopped pid $PID."
else
    echo "Nothing was listening on $PORT."
fi

mkdir -p "$LOG_DIR"
cd "$REPO" || exit 1
# setsid so it is its own session: it outlives this shell, and a stray signal
# aimed at the terminal cannot reach it.
setsid nohup bash bridge/launch.sh >"$LOG" 2>&1 </dev/null &
disown 2>/dev/null || true

for _ in $(seq 1 60); do
    sleep 0.5
    NEW="$(health)"
    [ -n "$NEW" ] && break
done

if [ -z "${NEW:-}" ]; then
    echo "restart-bridge: it did not come back. Last output:" >&2
    tail -n 20 "$LOG" >&2
    exit 1
fi

printf 'Bridge :%s up — pid %s, %s sessions, running %s\n' \
    "$PORT" "$(printf '%s' "$NEW" | field pid)" \
    "$(printf '%s' "$NEW" | field sessions)" \
    "$(git -C "$REPO" log --oneline -1 2>/dev/null | cut -c1-60)"

# The window reconnects on its own; say so, because a blank moment looks broken.
echo 'Any open window reconnects by itself.'
