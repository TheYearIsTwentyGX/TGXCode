# Working on Claude Sessions

This app is used while it is being worked on. Dylan keeps a window open with
live sessions in it, and those sessions are real work in progress. The rules
below exist because breaking them destroys that work.

## Never touch the everyday instance

**Port 45888 belongs to the user.** Do not start a bridge on it, do not
`pkill -f bridge/server.js`, and do not `Stop-Process` ClaudeSessions.

Use your own instance instead:

```bash
npm run dev                  # bridge on 45899 (or the next free port) + a window
npm run dev:headless         # bridge only; open the printed URL in a browser
npm run dev -- --port=45905  # ask for a particular one
```

`npm run dev` refuses to bind 45888 and picks a free port near 45899, so two
agents can each have one. The window it opens is titled `dev :45899` and carries
an amber badge, so it is never confused with the everyday one.

`--port` is refused for 45888 exactly like the environment variable is, and it
wins over it. Prefer it when you want a specific port: `CLAUDE_SESSIONS_PORT=…`
in front of a command reads like the thing the section below is about, and it is
also the variable a run started from the app never receives.

The **Dev instance** button in the conversation header does all of this for you —
it is `.tgxcode/commands.json` in this repo, and it picks a free port in
45899–45918, names the DevBrowser tab for your worktree, and gives the name back
when you stop it.

`pkill -f bridge/server.js` matches *every* bridge including the user's. If you
must stop your own, Ctrl-C the `npm run dev` you started, or kill it by port:

```bash
kill "$(ss -ltnp 2>/dev/null | grep :45899 | grep -oP 'pid=\K\d+' | head -1)"
```

**`CLAUDE_SESSIONS_PORT` in your environment is not a port you chose.** A session
started from the app inherits the bridge's environment, so for a long time that
variable arrived pre-set to `45888` — and `bash bridge/launch.sh` or
`node bridge/server.js` from a worktree then bound the user's port without a port
ever being mentioned. That bridge reported `dev: false`, the Windows shell adopted
it in place of its own, and the everyday window quietly served a branch's UI out
of a stale worktree. It is the most expensive way this rule has been broken.

Three things stop it now, and none of them is you remembering:

- `bridge/server.js` refuses to bind 45888 when it is running out of
  `.claude/worktrees/` — exit 4, before the socket. `npm run dev` still refuses
  the port outright.
- The bridge no longer passes `CLAUDE_SESSIONS_PORT` to the sessions or terminals
  it starts, so a fresh session inherits nothing to trip over.
- `scripts/restart-bridge.sh` refuses the everyday port from a worktree. Without
  that it would kill the user's bridge and then fail to replace it, which is worse
  than the bug. `--status` still works from anywhere.

`/api/health` reports `root` — which checkout a bridge is serving. When a window
shows something you cannot explain, check that first:

```bash
curl -s http://127.0.0.1:45888/api/health | python3 -m json.tool | grep root
```

## Work in a worktree, never the main checkout

Several agents work on this repo at once — there are usually a handful of live
worktrees under `.claude/worktrees/` — and they all reach for the same few files
in `bridge/` and `web/`. Editing `/home/dylan_hays/Other/claude-sessions`
directly means two agents silently overwriting each other, and it leaves the
user's own checkout dirty while they are running the app out of it.

**Make the worktree your first action, before the first edit.** Use
`EnterWorktree` with a short name for the work; it branches `worktree-<name>` off
HEAD and moves you there.

- **`cd` into the repo first.** `EnterWorktree` needs a git repository at the
  working directory; an agent launched in `~` reports "not in a git repository
  and no WorktreeCreate hooks are configured", which looks like a missing hook
  but is just the wrong directory.
- `baseRef` is pinned to `head` in `.claude/settings.json`, so a worktree branches
  from local HEAD rather than `origin/<default-branch>`. The pin dates from when
  this repo had no remote. It has one now — `origin` is
  `github.com/TheYearIsTwentyGX/TGXCode` and `main` tracks `origin/main` — so the
  `fresh` default would resolve too. Leaving it at `head` keeps a worktree based on
  the checkout in front of you, which is the predictable thing while several agents
  are committing to main; the choice is now a real one rather than forced.
- **Enter it before you start editing, not after.** Moving mid-session works, but
  every edit you have already made stays behind in the main checkout and has to
  be carried across by hand — which is a merge you did not need to do.
- Either way, a session that enters a worktree ends up with two transcript files.
  That is expected and handled; see *Notes that save time* for what it means.
- A dev bridge run from inside the worktree serves that worktree's `bridge/` and
  `web/`, which is what you want when verifying your own change.

Not everything is an edit. Reading transcripts, diagnosing, querying a bridge and
running `npm run dev` are fine from wherever you are. The rule is about writing
to tracked files: if you are about to change one, be in a worktree. When in
doubt, make one — it costs a second and nothing is lost by it.

## Landing what you finished

`npm run land`, from the worktree you worked in, merges the pull request for the
branch you are on and then fast-forwards the main checkout at
`~/Other/claude-sessions` — so the checkout the user actually runs the app from
has your work in it, rather than the work sitting on origin where nobody sees it.

```bash
npm run land -- --status    # what would land, and whether it can
npm run land -- --dry-run   # say what would happen, change nothing
npm run land                # merge the PR, then pull the main checkout
```

It refuses rather than guesses, and every refusal says what to do next:
uncommitted files in your worktree (they are not in the PR, so landing would
leave them behind), commits you have not pushed, a PR that conflicts or is
blocked, a main checkout that is dirty or on some other branch. A refusal that
comes *after* the merge says so, so you always know which half happened.

**It does not restart the bridge.** The everyday instance usually has live turns
in it and a restart ends them, so picking up merged code stays the user's call.
When the merge touched `bridge/` the script says the running bridge is now on old
code and leaves `npm run restart` to them; `--restart` opts in, and delegates to
the script that has the turn-in-flight guard rather than reimplementing it.

It is also the sanctioned way to reach the main checkout at all: a worktree-isolated
session is refused `git -C ~/Other/claude-sessions` by its own harness, which is
why the gap existed. The script is narrow so that being sanctioned is safe — it
fast-forwards and nothing else, and never commits there.

## Clean up the sessions you start

Every session you start to try something out lands in the user's sidebar, because
both instances read the same `~/.claude/projects`. Groups full of `probe`,
`sandbox` and the like are what that looks like after a few agents have been
through. **Do not leave them there.** Either:

- **Mark it a test session**, which keeps it out of the everyday window entirely.
  Tick *Test session — dev only* in the Start a session dialog, or pass the field:

  ```bash
  curl -sX POST http://127.0.0.1:45899/api/sessions \
    -H "Authorization: Bearer $(cat ~/.local/share/claude-sessions/token)" \
    -H 'X-Claude-Sessions-Client: 1' -H 'Content-Type: application/json' \
    -d '{"cwd":"'"$PWD"'","prompt":"…","test":true}'
  ```

  Labelled sessions collect in a **Test sessions** card at the foot of the rail on
  dev only. Prefer this: a session you forget to delete is then still invisible to
  the user.

- **Or delete it when you are done**, with the trash icon on the row, or:

  ```bash
  curl -sX DELETE http://127.0.0.1:45899/api/sessions/$ID \
    -H "Authorization: Bearer $(cat ~/.local/share/claude-sessions/token)" \
    -H 'X-Claude-Sessions-Client: 1'
  ```

  This is a hard delete — the transcript and its sidecar directory. Do it to
  sessions *you* created, never to one you found.

  If the session's process is still shutting down, the exiting `claude` can write
  its bookkeeping back to the path you just unlinked, and the session reappears as
  an empty row with 0 turns. Stop it, wait a moment, then delete — or delete twice.

Best is both: label it on the way in, delete it on the way out.

## The API needs a token now

Every `/api/` route but `/api/health` requires the token at
`~/.local/share/claude-sessions/token`, created on first run with mode `0600`. So
any `curl` against the bridge needs:

```bash
-H "Authorization: Bearer $(cat ~/.local/share/claude-sessions/token)"
```

Without it you get `401 {"error":"unauthorized"}`, which is easy to misread as a
broken bridge.

**Nothing in `web/` had to change for this, and nor should yours.** A page fetched
over loopback is served with the token in a `<meta name="cs-token">` tag *and* with
an `HttpOnly` cookie set; `fetch` and `EventSource` both send same-origin cookies
on their own. So the browser and the Electron shell need no login step, and the
service worker keeps working. Loopback is not otherwise trusted — "any process on
this machine" is the hole the token closes.

`/api/health` stays open because `app/main.js` pings it before it could know a
token. It reports `remote`, which is what raises the banner in the UI.

The bridge also refuses to bind a non-loopback interface without
`CLAUDE_SESSIONS_ALLOW_REMOTE_BIND=1`, and refuses several routes outright to
remote callers. See `docs/remote.md` for the reasoning and `docs/api.md` for the
contract.

## There are tests, and they are quick

```bash
npm test               # starts a bridge on a free port, runs everything, stops it
npm test -- 45901      # run against a bridge you already have on that port
```

`test/run.js` refuses 45888 the same way everything else here does — these tests
start and delete sessions, so pointing them at the everyday instance is exactly
the accident the rest of this file is about.

The suite is `auth`, `temp`, `recent`, `pulls`, `taskboard` and `restart` on
their own — no bridge needed — plus four that want a live one: `gate`, `browser`,
`refusals`, `unpaired`. Between them they cover the token, what a remote caller
is refused, what an unpaired phone sees before and after pairing, and what the
nightly restart does when there is nobody to ask. If you touch `bridge/auth.js`
or any route's local/remote rule, run it: that is the part of this codebase with
tests around it.

Most of the first group are pure functions, but `restart` is not — it runs a
copy of `scripts/restart-bridge.sh` in a throwaway git repo, with a stub
`bridge/launch.sh` and a port the kernel just handed back. It spawns the script
`detached`, which is load-bearing rather than tidiness: `/dev/tty` is the
*controlling* terminal and is inherited, so without the detach a run from a real
terminal would reach a live `Continue? [y/N]` and hang the suite. Its first
assertion checks the detach worked, so that failure is a failure and not a hang.

## Never rebuild without asking

`install.ps1` force-closes any running ClaudeSessions and replaces the
executable, which shuts the user's window. You almost never need it: **changes
to `bridge/` and `web/` need no rebuild at all** — restart your dev bridge, or
just refresh for UI-only edits. Only `app/main.js` and `package.json` are
packaged, and if one of those has to ship, say so and let the user run it.

Two agents packaging at once will also pull the executable out from under each
other, since the staging directory is wiped and rebuilt.

## What is safe

- Editing anything under `bridge/`, `web/`, `scripts/`.
- Running `npm run dev` and restarting it as often as you like.
- Reading transcripts: both instances read the same `~/.claude/projects`, so a
  session you start in dev is visible in the everyday window and vice versa.

## Finding your way around

`README.md` **§Layout** is the file map — one line per module, and it is kept
current. `docs/api.md` is the bridge API as a contract, and `docs/remote.md` the
reasoning behind the local/remote split; `docs/plans/` holds the design notes the
features were built from.

Every module under `bridge/` opens with a header comment saying why it exists and
what it decided — read that before grepping the body. `server.js` is 71KB and
sectioned by comment headers, so search for the section name rather than scrolling.

## Notes that save time

- **Entering a worktree splits the session's transcript in two.** Claude Code
  files a transcript under the project directory for the cwd it is running in,
  and a worktree is a project directory of its own, so a session that crosses
  into one leaves a second `<id>.jsonl` under
  `~/.claude/projects/…--claude-worktrees-<name>/`. One copy holds the
  conversation and the other only bookkeeping — a title, a mode, the worktree
  state — and which gets which goes either way: both orders exist on this
  machine. `conversationRecord` in `bridge/sessions.js` is what picks the copy
  with the conversation in it. Before that the index took whichever copy was
  scanned last, so directory order decided whether a session showed its history
  or showed 0 turns and nothing at all.
- **No `node_modules`, on purpose.** `electron .` will not work here; the shell
  is packaged from a Windows-side staging directory. `npm start` finds the built
  executable instead.
- **A login shell has neither node nor `claude` on PATH** — nvm and `~/.local/bin`
  both come from `~/.bashrc`, which `bash -lc` never reads. `bridge/launch.sh`
  resolves node itself; that is why it exists.
- **Commit messages are prose, not prefixes.** The log is uniform: an imperative
  sentence-case subject describing the change as the user meets it — "Give each
  session its own terminal pane", "Let an approval card wait as long as you do" —
  and a body explaining why, including what was rejected and what still holds. No
  `feat:` or `fix:` prefixes appear anywhere in this repo.
- **Killing a bridge kills its turns.** This is measured, not assumed: `claude`
  reads stdin for input, so when the bridge exits and that pipe closes it treats
  it as end-of-input and stops, mid-turn. Running it detached with its output on
  a file descriptor does not change this. There is no way to make a turn outlive
  its bridge, which is the whole reason for the separate development port.
- **"Why is the bridge still on old code?" has a log.** A midnight cron entry
  restarts the everyday bridge, and every run that could change something appends
  a line to `~/.cache/claude-sessions/restart-45888.log` — a `start` line and then
  one word for the outcome. `grep skipped-dirty` is the usual answer: uncommitted
  changes **under `bridge/`** stop the nightly run, because there is no terminal
  to confirm them at. So a worktree is not the only reason to keep the main
  checkout clean — leaving half-finished `bridge/` edits in it is what silently
  pins the everyday instance to yesterday's code. Nothing else in that directory
  blocks it: `web/` is read per request and is already live, and docs, tests and
  scripts the bridge never reads. See README §Picking up new code.
