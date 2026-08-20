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
#   land --restart         also restart the everyday bridge (opt-in; see below)
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
# It does not restart the bridge unless asked. The everyday instance usually has
# live turns in it and a restart ends them — `claude` stops when its input pipe
# closes — so picking up merged code is the user's call, not a side effect of
# landing a branch. What the merge implies is printed instead.

set -uo pipefail

# Where the user actually runs the app from. Overridable, but this is the
# answer on this machine and the default is what makes the script callable
# from a worktree that cannot know it.
MAIN="${CLAUDE_SESSIONS_MAIN:-$HOME/Other/claude-sessions}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

METHOD=--merge
BRANCH=""; PULL=1; RESTART=0; DRY=0; STATUS_ONLY=0; DELETE=0
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
        --dry-run) DRY=1 ;;
        --status) STATUS_ONLY=1 ;;
        -h|--help) sed -n '3,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

if [ "$BEFORE" = "$AFTER" ]; then
    say "$MAIN was already up to date."
    exit 0
fi

CHANGED="$(git -C "$MAIN" diff --name-only "$BEFORE" "$AFTER" 2>/dev/null)"
say "$MAIN is now at $(git -C "$MAIN" log --oneline -1 | cut -c1-60)"

# The bridge runs what was on disk when it started, so a merge that touched
# bridge/ is on disk but not in the running process. Say so; do not act on it.
if printf '%s\n' "$CHANGED" | grep -q '^bridge/'; then
    say ""
    say "This merge changed bridge/ — the running bridge is still on the old code."
    if [ "$RESTART" != 1 ]; then
        say "  When it suits you, from $MAIN:  npm run restart"
        say "  (it refuses while a turn is in flight, which is the point)"
    fi
fi
if printf '%s\n' "$CHANGED" | grep -qE '^(app/|package\.json)'; then
    say ""
    say "This merge changed app/ or package.json — the packaged shell is stale."
    say "  That needs a rebuild, which closes the user's window: npm run build"
    say "  Ask before running it."
fi
if printf '%s\n' "$CHANGED" | grep -q '^web/' \
   && ! printf '%s\n' "$CHANGED" | grep -q '^bridge/'; then
    say ""
    say "This merge was UI only — a refresh in the open window picks it up."
fi

# --- optionally restart, having been asked explicitly -----------------------

if [ "$RESTART" = 1 ]; then
    say ""
    say "Restarting the everyday bridge, as asked…"
    # Delegated rather than reimplemented: that script has the turn-in-flight
    # guard, and running it from $MAIN is the one place it is allowed to
    # replace the everyday instance.
    #
    # Its status is worth reading. It exits 3 when it deliberately did not
    # restart — a turn in flight, or uncommitted bridge/ changes — and swallowing
    # that would leave you thinking the merge you just landed is running when it
    # is not, which is the same silent skip the nightly cron run used to have.
    if ! ( cd "$MAIN" && bash scripts/restart-bridge.sh ); then
        say ""
        say "  The restart did not happen — see above. $MAIN is merged either way;"
        say "  the running bridge is still on the code it started with."
    fi
fi
