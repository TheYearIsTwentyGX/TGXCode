#!/usr/bin/env bash
#
# Restart the everyday bridge so it picks up whatever is on main now.
#
#   restart-bridge              restart from the local checkout
#   restart-bridge --pull       fast-forward from origin first, then restart
#   restart-bridge --yes        load uncommitted bridge/ changes without asking
#   restart-bridge --force      restart even with a turn in flight (implies --yes)
#   restart-bridge --status     say what is running and exit
#
#   exit 0   restarted — also --status and --help
#   exit 3   deliberately did not restart: a turn was in flight, or bridge/ had
#            uncommitted changes and there was no terminal to confirm on
#   exit 1   tried and could not: bad option, a worktree, a failed pull, or a
#            bridge that never came back
#
# Every run that could change something appends a line to
# ~/.cache/claude-sessions/restart-<port>.log, one word for the outcome, so
# `grep skipped-dirty` is a real question to ask of it. A night with no `start`
# line at all means cron never fired — usually WSL was not running at midnight,
# which is a different problem and used to look identical to every other one.
#
# Deliberately narrow: it only ever touches the instance on the everyday port.
# `pkill -f bridge/server.js` would match development bridges too, and killing
# one of those out from under an agent is the thing this whole setup avoids.
#
# It already runs under cron unchanged — there is a midnight entry for it — so
# resist "fixing" the environment at the top. Every command it needs (git, curl,
# python3, setsid, ss) is in /usr/bin, which cron's default PATH has, and $REPO
# comes from BASH_SOURCE rather than the working directory, so no cd is wanted.
# Setting PATH by hand is worse than useless: it drops nvm, and hardcoding
# /usr/local/bin does nothing for a node that lives under ~/.nvm.
#
# `set -e` is the one that actually breaks it. `CURRENT="$(health)"` below exits
# non-zero whenever nothing is listening, so the script would die right there —
# taking out --status and, worse, the bring-it-back-up path the nightly restart
# exists for. The explicit checks against an empty $CURRENT are the handling.
# `grep -c` returning 1 on zero matches, below, is a second one it would break.
#
# What was actually wrong under cron was none of that. The dirty-checkout prompt
# read /dev/tty; cron has no controlling terminal; the read failed; and the
# failure was taken for a "no". So it exited 1 with "Left the bridge alone." on a
# checkout that is dirty most nights — a deliberate skip wearing the same words
# and the same status as every genuine failure, into a log in /tmp that WSL wipes
# on shutdown and that cron, with MAILTO="" set, never mailed anywhere either.
# can_ask and the journal are the fix. The environment was fine.

set -uo pipefail

PORT="${CLAUDE_SESSIONS_PORT:-45888}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/claude-sessions"
LOG="$LOG_DIR/bridge-$PORT.log"

# The run journal. Deliberately not $LOG: that one is the bridge's own stdout and
# every restart truncates it, so it can only say what the instance running right
# now has done. This one is appended to, and answers the question the other
# cannot — did the midnight run happen, and what did it decide.
JOURNAL="$LOG_DIR/restart-$PORT.log"

PULL=0; FORCE=0; STATUS_ONLY=0; YES=0
for arg in "$@"; do
    case "$arg" in
        --pull) PULL=1 ;;
        --yes) YES=1 ;;
        --force) FORCE=1 ;;
        --status) STATUS_ONLY=1 ;;
        -h|--help) sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

say() { printf '%s\n' "$*"; }

# One line per event, appended. Timestamp first so tail, sort and grep all do the
# obvious thing; then one word for the outcome, so the vocabulary is greppable.
# Never fatal: a journal that cannot be written must not be the reason the bridge
# stays down. The pid tells a manual run apart from the nightly one it raced.
journal() {
    [ -d "$LOG_DIR" ] || mkdir -p "$LOG_DIR" 2>/dev/null || return 0
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$*" \
        >>"$JOURNAL" 2>/dev/null || true
}

# Every unhappy ending goes through here: the same words to stderr and to the
# journal, so the two cannot drift, and one place that knows the exit codes.
#   die <code> <outcome> <headline> [indented guidance…]
die() {
    local code="$1" outcome="$2" head="$3" line
    shift 3
    printf 'restart-bridge: %s\n' "$head" >&2
    for line in "$@"; do printf '  %s\n' "$line" >&2; done
    journal "$outcome $head"
    exit "$code"
}

# Two lines a run, so 4000 is years of nightly restarts. Trimming here rather
# than on every append keeps it to one `wc` per run; a run interleaving with the
# rename could lose a line, which is the right price for a file in a cache dir.
trim_journal() {
    local lines
    [ -f "$JOURNAL" ] || return 0
    lines="$(wc -l <"$JOURNAL" 2>/dev/null)" || return 0
    [ "${lines:-0}" -gt 4000 ] || return 0
    tail -n 2000 "$JOURNAL" >"$JOURNAL.tmp" 2>/dev/null && mv "$JOURNAL.tmp" "$JOURNAL"
}

# Can we actually ask? The prompt further down reads /dev/tty, not stdin, so
# /dev/tty is what has to be tested. `[ -t 0 ]` gets it wrong in both directions:
# `restart-bridge </dev/null` from a terminal has no tty on stdin but can be
# asked perfectly well, and a process setsid'd away from its terminal can still
# have one on stdin that it is no longer allowed to open. The subshell opens the
# thing and throws it away; a failed redirection is the answer.
can_ask() { (exec </dev/tty) 2>/dev/null; }

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

# From here on the run can change something, so it goes in the journal. --status
# above does not: it changes nothing, and a journal full of status checks is one
# nobody scans for the line that matters.
trim_journal
journal "start port=$PORT repo=$REPO args=${*:-none}"

# --- never the everyday instance, from a worktree ---------------------------

# This script kills whatever is on $PORT and starts a bridge from $REPO — the
# checkout it lives in. Run from a worktree against the everyday port, that
# replaces the user's bridge with a branch's, which is the failure the port guard
# in bridge/server.js exists to stop. And because that guard now refuses the
# bind, the replacement would never come up: the everyday instance would be dead
# rather than merely wrong. So refuse here, before anything is killed.
#
# --status is read-only and stays allowed above.
case "$REPO/" in
    */.claude/worktrees/*)
        if [ "$PORT" = 45888 ]; then
            die 1 refused-worktree "$REPO is a worktree." \
                "Refusing to restart the everyday bridge on $PORT — it would come" \
                "back serving this worktree, and bridge/server.js will not allow that." \
                "Your own: CLAUDE_SESSIONS_PORT=45899 scripts/restart-bridge.sh" \
                "The everyday one: run this from the main checkout."
        fi
        ;;
esac

# --- don't throw away work -------------------------------------------------

if [ -n "$CURRENT" ]; then
    BUSY="$(printf '%s' "$CURRENT" | field busy)"
    if [ -n "$BUSY" ] && [ "$BUSY" != "0" ] && [ "$FORCE" != 1 ]; then
        die 3 skipped-busy "$BUSY turn(s) still running." \
            "A restart ends them — Claude stops when its input pipe closes." \
            "Wait for them, or re-run with --force if you don't mind." \
            "Nothing was restarted; the bridge on $PORT is still up."
    fi
fi

# --- optionally catch up with the remote -----------------------------------

if [ "$PULL" = 1 ]; then
    say "Updating $REPO…"
    # --ff-only so this can never leave a merge or a conflict behind; if the
    # branch has diverged, that is a decision for a human.
    if ! git -C "$REPO" pull --ff-only; then
        die 1 failed-pull "pull failed, leaving the bridge alone."
    fi
fi

# --- say what is about to be loaded ----------------------------------------

# The bridge runs what is on disk, not what is committed. On a repo where
# several agents work at once that regularly means somebody's half-finished
# edits, so name them rather than loading them silently.
#
# Only bridge/ decides whether that matters enough to stop. The bridge require()s
# bridge/ once at startup, so a restart is the only thing that ever loads it;
# web/ is read from disk per request, so it is already live whether anything
# restarts or not; and docs, tests, scripts and app/ are not read by the bridge
# process at all. Blocking the nightly restart on a dirty README was blocking it
# on nothing, which is how it came to block on most nights.
#
# `cut -c4-` is the documented porcelain layout — two status characters and a
# space — and unlike `awk '{print $2}'` it survives a path with a space in it.
DIRTY_LIST="$(git -C "$REPO" status --porcelain 2>/dev/null | grep -v '^??')"
DIRTY="$(printf '%s' "$DIRTY_LIST" | grep -c .)"
LOADED="$(printf '%s' "$DIRTY_LIST" | cut -c4- | grep -c '^bridge/')"
DIRTY_NOTE=""

if [ "${DIRTY:-0}" -gt 0 ]; then
    say "Heads up: $DIRTY tracked file(s) in $REPO have uncommitted changes."
    printf '%s\n' "$DIRTY_LIST" | sed 's/^/    /'
    if [ "${LOADED:-0}" = 0 ]; then
        say "  None of them under bridge/, so this restart loads no uncommitted code."
    elif [ "$FORCE" = 1 ] || [ "$YES" = 1 ]; then
        say "  $LOADED of them under bridge/ — loading those, as asked."
        DIRTY_NOTE=" dirty-bridge=$LOADED"
    elif can_ask; then
        printf '  %s of them under bridge/, which this will load. Continue? [y/N] ' "$LOADED"
        read -r reply </dev/tty 2>/dev/null || reply=n
        case "$reply" in
            [yY]*) DIRTY_NOTE=" dirty-bridge=$LOADED" ;;
            *) say "Left the bridge alone."
               journal "skipped-declined $LOADED uncommitted file(s) under bridge/, answered no"
               exit 3 ;;
        esac
    else
        die 3 skipped-dirty \
            "$LOADED uncommitted file(s) under bridge/ and no terminal to ask at." \
            "Nothing was restarted. The bridge on $PORT is still up, running the" \
            "code it started with — the safe half of this, but not a success." \
            "Commit or stash them, or pass --yes to load them anyway."
    fi
fi

# --- swap it out -----------------------------------------------------------

if [ -n "$CURRENT" ]; then
    PID="$(printf '%s' "$CURRENT" | field pid)"
    if [ -n "$PID" ]; then
        kill "$PID" 2>/dev/null
        for _ in $(seq 1 25); do
            health >/dev/null 2>&1 || break
            sleep 0.2
        done
    fi
    say "Stopped pid $PID."
else
    say "Nothing was listening on $PORT."
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
    TAIL="$(tail -n 20 "$LOG" 2>/dev/null)"
    echo "restart-bridge: it did not come back. Last output:" >&2
    printf '%s\n' "$TAIL" >&2
    # Into the journal too: by morning $LOG has been truncated by whatever
    # restarted next, and these twenty lines are the only part worth keeping.
    journal "failed-start it did not come back — last output follows"
    printf '%s\n' "$TAIL" | sed 's/^/        /' >>"$JOURNAL" 2>/dev/null
    exit 1
fi

REV="$(git -C "$REPO" log --oneline -1 2>/dev/null | cut -c1-60)"
NEWPID="$(printf '%s' "$NEW" | field pid)"
printf 'Bridge :%s up — pid %s, %s sessions, running %s\n' \
    "$PORT" "$NEWPID" "$(printf '%s' "$NEW" | field sessions)" "$REV"
# rev last: it is a commit subject, so it has spaces in it, and anything after it
# on the line would be unparseable. The key=value fields go in front of it.
journal "restarted pid=$NEWPID$DIRTY_NOTE rev=$REV"

# The window reconnects on its own; say so, because a blank moment looks broken.
say 'Any open window reconnects by itself.'
