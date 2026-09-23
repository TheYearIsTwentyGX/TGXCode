#!/usr/bin/env bash
#
# Land the branch you have been working on: merge its pull request, then bring
# the main checkout up to date with what you just merged.
#
#   land                   merge the PR for this branch, then pull the main checkout
#   land --branch NAME     land a branch other than the one you are standing on
#   land --squash          squash instead of a merge commit (--rebase also works)
#   land --delete-branch   delete the remote branch afterwards
#   land --no-pull         merge only, leave the main checkout alone
#   land --no-restart      leave the everyday bridge alone, even if bridge/ changed
#   land --restart         restart the everyday bridge even if bridge/ did not change
#   land --dry-run         say what would happen and change nothing
#   land --status          report what is landable here and exit
#
# Why this exists. An agent finishes in a worktree, pushes, and opens a PR — and
# then the work sits on origin while the checkout the user actually runs the app
# from knows nothing about it. Closing that gap by hand is three commands, one of
# which an agent is not allowed to run: a worktree-isolated session is refused
# `git -C <the main checkout>` by its own harness, because pointing git at a
# directory computed at runtime is how agents commit to the wrong tree. This
# script is the sanctioned way through. It is deliberately narrow so that being
# sanctioned is safe: it fast-forwards and nothing else, it will not touch a main
# checkout that is dirty or on another branch, and it never commits there.
#
# When the merge changed bridge/, it restarts the everyday bridge so that the
# code just landed is the code running. That used to be opt-in, because a
# restart ended every live turn — `claude` stops when its input pipe closes. It
# no longer does: turns run in the session host (bridge/host.js), which outlives
# the bridge and hands them to the next one. The restart is delegated to
# scripts/restart-bridge.sh, which refuses while any turn is `atRisk` — started
# while no host was reachable, so a restart really would end it — and that
# refusal is reported, never overridden. It does not start a bridge that was not
# already running. --no-restart keeps the old behaviour: say, do not act.

set -uo pipefail

# Where the user actually runs the app from. Overridable, but this is the
# answer on this machine and the default is what makes the script callable
# from a worktree that cannot know it.
MAIN="${CLAUDE_SESSIONS_MAIN:-$HOME/Other/claude-sessions}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

METHOD=--merge
BRANCH=""; PULL=1; RESTART=auto; DRY=0; STATUS_ONLY=0; DELETE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --branch) shift; BRANCH="${1:-}" ;;
        --branch=*) BRANCH="${1#*=}" ;;
        --squash) METHOD=--squash ;;
        --rebase) METHOD=--rebase ;;
        --merge) METHOD=--merge ;;
        --delete-branch) DELETE=1 ;;
        --no-pull) PULL=0 ;;
        --restart) RESTART=1 ;;
        --no-restart) RESTART=0 ;;
        --dry-run) DRY=1 ;;
        --status) STATUS_ONLY=1 ;;
        -h|--help) sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "land: unknown option '$1'" >&2; exit 1 ;;
    esac
    shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'land: %s\n' "$1" >&2; shift; for l in "$@"; do printf '  %s\n' "$l" >&2; done; exit 1; }

# --- what are we landing ----------------------------------------------------

[ -n "$BRANCH" ] || BRANCH="$(git -C "$HERE" rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -n "$BRANCH" ] && [ "$BRANCH" != HEAD ] || die "could not work out which branch to land." \
    "Pass one: land --branch <name>"

DEFAULT_BRANCH="$(git -C "$HERE" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH=main

if [ "$BRANCH" = "$DEFAULT_BRANCH" ]; then
    die "you are on $DEFAULT_BRANCH." \
        "There is nothing to land: this is the branch things land onto." \
        "Run this from the worktree whose work you want merged."
fi

# --- is the branch actually finished ---------------------------------------

# Merging a PR that does not include the edits still sitting in the working tree
# is the quiet way to lose them: the branch merges, the agent moves on, and the
# uncommitted half is only noticed later. Refuse rather than warn.
DIRTY="$(git -C "$HERE" status --porcelain 2>/dev/null | grep -cv '^??')"
if [ "${DIRTY:-0}" -gt 0 ] && [ "$STATUS_ONLY" != 1 ]; then
    git -C "$HERE" status --porcelain 2>/dev/null | grep -v '^??' | sed 's/^/    /' >&2
    die "$DIRTY tracked file(s) here are not committed." \
        "They are not in the PR, so landing it now would leave them behind." \
        "Commit them and push, or stash them deliberately, then run this again."
fi

UNPUSHED="$(git -C "$HERE" rev-list --count "origin/$BRANCH..$BRANCH" 2>/dev/null || echo unknown)"
if [ "$UNPUSHED" = unknown ]; then
    [ "$STATUS_ONLY" = 1 ] || die "$BRANCH has never been pushed." \
        "Push it first: git push -u origin $BRANCH"
elif [ "${UNPUSHED:-0}" -gt 0 ] && [ "$STATUS_ONLY" != 1 ]; then
    die "$BRANCH is $UNPUSHED commit(s) ahead of origin/$BRANCH." \
        "The PR would merge without them. Push first: git push"
fi

# --- find the pull request --------------------------------------------------

PR_JSON="$(gh pr view "$BRANCH" --json number,state,mergeable,mergeStateStatus,title,url 2>/dev/null)"
if [ -z "$PR_JSON" ]; then
    die "no pull request found for $BRANCH." \
        "Open one first — the title and body are yours to write:" \
        "  gh pr create --head $BRANCH --fill"
fi

field() {
    printf '%s' "$PR_JSON" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('$1',''))
except Exception: print('')" 2>/dev/null
}

PR_NUM="$(field number)"; PR_STATE="$(field state)"; PR_TITLE="$(field title)"
PR_URL="$(field url)"; MERGEABLE="$(field mergeable)"; MERGE_STATE="$(field mergeStateStatus)"

if [ "$STATUS_ONLY" = 1 ]; then
    say "branch      $BRANCH"
    say "pull request #$PR_NUM  $PR_STATE  $PR_TITLE"
    say "            $PR_URL"
    say "mergeable   $MERGEABLE ($MERGE_STATE)"
    say "unpushed    ${UNPUSHED:-0} commit(s)"
    say "uncommitted ${DIRTY:-0} tracked file(s)"
    say "main        $MAIN"
    exit 0
fi

[ "$PR_STATE" = OPEN ] || die "PR #$PR_NUM is $PR_STATE, not OPEN." "$PR_URL"

if [ "$MERGEABLE" = CONFLICTING ]; then
    die "PR #$PR_NUM conflicts with $DEFAULT_BRANCH." \
        "Merge $DEFAULT_BRANCH into $BRANCH and resolve it, then run this again." \
        "$PR_URL"
fi

case "$MERGE_STATE" in
    BLOCKED|DIRTY)
        die "PR #$PR_NUM is not mergeable yet — $MERGE_STATE." \
            "Failing checks or an unmet review rule. Look before forcing it:" \
            "$PR_URL" ;;
esac

# --- merge ------------------------------------------------------------------

say "Landing #$PR_NUM — $PR_TITLE"
MERGE_ARGS=("$PR_NUM" "$METHOD")
[ "$DELETE" = 1 ] && MERGE_ARGS+=(--delete-branch)

if [ "$DRY" = 1 ]; then
    say "  would run: gh pr merge ${MERGE_ARGS[*]}"
else
    if ! gh pr merge "${MERGE_ARGS[@]}"; then
        die "gh pr merge failed. Nothing was pulled." "$PR_URL"
    fi
    say "Merged."
fi

# --- bring the main checkout up to date ------------------------------------

if [ "$PULL" != 1 ]; then
    say "Left $MAIN alone (--no-pull)."
    exit 0
fi

[ -d "$MAIN/.git" ] || die "no main checkout at $MAIN." \
    "Set CLAUDE_SESSIONS_MAIN if it lives somewhere else." \
    "The merge is done; only the pull was skipped."

MAIN_BRANCH="$(git -C "$MAIN" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$MAIN_BRANCH" != "$DEFAULT_BRANCH" ]; then
    say "Heads up: $MAIN is on '$MAIN_BRANCH', not $DEFAULT_BRANCH — not pulling."
    say "  The merge is done. Pull it yourself once that checkout is back on $DEFAULT_BRANCH."
    exit 0
fi

MAIN_DIRTY="$(git -C "$MAIN" status --porcelain 2>/dev/null | grep -cv '^??')"
if [ "${MAIN_DIRTY:-0}" -gt 0 ]; then
    git -C "$MAIN" status --porcelain 2>/dev/null | grep -v '^??' | sed 's/^/    /'
    say "Heads up: $MAIN has ${MAIN_DIRTY} uncommitted tracked file(s) — not pulling."
    say "  The merge is done. Deal with those, then: git -C $MAIN pull --ff-only"
    exit 0
fi

BEFORE="$(git -C "$MAIN" rev-parse HEAD 2>/dev/null)"

if [ "$DRY" = 1 ]; then
    say "  would run: git -C $MAIN pull --ff-only"
    case "$RESTART" in
        1) say "  would restart the everyday bridge (--restart)" ;;
        auto) say "  would restart the everyday bridge if the pull changes bridge/" ;;
    esac
    exit 0
fi

say "Updating $MAIN…"
# --ff-only so this can never leave a merge or a conflict in the checkout the
# user is working out of. A diverged main is a decision for a human.
if ! git -C "$MAIN" pull --ff-only; then
    die "pull failed in $MAIN — it has probably diverged from origin." \
        "The merge is done; sort the checkout out by hand."
fi

AFTER="$(git -C "$MAIN" rev-parse HEAD 2>/dev/null)"

# --- say what that means ----------------------------------------------------

CHANGED=""
if [ "$BEFORE" = "$AFTER" ]; then
    say "$MAIN was already up to date."
    # Nothing new on disk, so nothing for a restart to pick up — unless one was
    # asked for by name.
    [ "$RESTART" = 1 ] || exit 0
else
    CHANGED="$(git -C "$MAIN" diff --name-only "$BEFORE" "$AFTER" 2>/dev/null)"
    say "$MAIN is now at $(git -C "$MAIN" log --oneline -1 | cut -c1-60)"
fi

# The bridge runs what was on disk when it started, so a merge that touched
# bridge/ is on disk but not in the running process until it restarts.
BRIDGE_CHANGED=0
printf '%s\n' "$CHANGED" | grep -q '^bridge/' && BRIDGE_CHANGED=1
if [ "$BRIDGE_CHANGED" = 1 ]; then
    say ""
    say "This merge changed bridge/ — the running bridge is still on the old code."
    if [ "$RESTART" = 0 ]; then
        say "  When it suits you, from $MAIN:  npm run restart"
        say "  (it refuses while a turn would be lost, which is the point)"
    fi
fi
if printf '%s\n' "$CHANGED" | grep -qE '^(app/|package\.json)'; then
    say ""
    say "This merge changed app/ or package.json — the packaged shell is stale."
    say "  That needs a rebuild, which closes the user's window: npm run build"
    say "  Ask before running it."
fi
if printf '%s\n' "$CHANGED" | grep -q '^web/' \
   && [ "$BRIDGE_CHANGED" = 0 ]; then
    say ""
    say "This merge was UI only — a refresh in the open window picks it up."
fi

# --- restart, when there is new bridge code to run --------------------------

DO_RESTART=0
[ "$RESTART" = 1 ] && DO_RESTART=1
[ "$RESTART" = auto ] && [ "$BRIDGE_CHANGED" = 1 ] && DO_RESTART=1
[ "$DO_RESTART" = 1 ] || exit 0

say ""
# Landing is no reason to bring up a bridge the user had not got running, and
# restart-bridge.sh would start one on an empty port — so look first.
if ! curl -fsS -m 3 http://127.0.0.1:45888/api/health >/dev/null 2>&1; then
    say "No everyday bridge is running on 45888 — nothing to restart."
    say "  It will run the new code whenever it is next started."
    exit 0
fi

say "Restarting the everyday bridge…"
# Delegated rather than reimplemented: that script has the turn-at-risk guard,
# and running it from $MAIN is the one place it is allowed to replace the
# everyday instance. No --force and no --yes: the guard is the point, and its
# dirty-checkout prompt cannot fire, because a dirty main was refused above.
#
# env -u because landing always means the everyday instance. A session can
# still carry a CLAUDE_SESSIONS_PORT it never chose, and letting that aim the
# restart somewhere else is the trap CLAUDE.md spends a section on.
#
# Its status is worth reading. It exits 3 when it deliberately did not restart,
# and swallowing that would leave you thinking the merge you just landed is
# running when it is not.
( cd "$MAIN" && env -u CLAUDE_SESSIONS_PORT bash scripts/restart-bridge.sh )
RC=$?
if [ "$RC" != 0 ]; then
    say ""
    say "  The restart did not happen — see above. $MAIN is merged either way;"
    say "  the running bridge is still on the code it started with."
    [ "$RC" = 3 ] && say "  Once those turns finish, from $MAIN:  npm run restart"
fi
exit 0
