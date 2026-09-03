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

## There is no mobile web UI

**A UI change lands in `web/app.js` and `web/index.html`. Desktop only.** Do not ask
whether a feature should also go to mobile, do not build a narrow-screen variant of
it, and do not add a `/m` back.

The phone client is the native Android app in `~/Other/tgxcode-mobile`. It reads
`docs/api.md` and nothing else of ours, so if the phone needs what you are building,
the deliverable here is a field in that document — see the next section. Filing it
there is the whole of your obligation to the phone; the app is a separate repository
with its own sessions.

There *was* a phone-shaped web page at `/m` — `web/mobile.js` and friends — and it
was deleted rather than fixed. It had drifted a long way behind the API (it dropped
the `tool-result` event, misread `runner`, rendered a slash command as
`/[object Object]`), and every UI feature was arriving at the question "desktop, or
desktop and mobile?" — a question with a real cost and no good answer once a native
client existed. `test/browser.test.js` asserts `/m` and its old assets still 404, so
the page cannot creep back by accident.

What did *not* go with it, because none of it was mobile-web machinery:
`web/sw.js` (the desktop registers it for notification action buttons), the
`/pair` handshake and the **Connect a phone** group in Settings (the Android app is
pointed at a bridge by pasting the link they produce), and every `@media` block in
`web/styles.css` — those are narrow-*desktop*-window and `prefers-reduced-motion`,
so do not mistake them for phone CSS and delete them.

## Leave `docs/api.md` true before you land

**If your change touched the bridge's wire surface, updating `docs/api.md` is part
of the change, not a follow-up.** Wire surface means: a route added, removed or
renamed; a request or response field added, removed, retyped or given a new
meaning; a new `/api/events` event or a new payload field on an existing one; a
status code, a refusal rule, a local/remote classification, a required header, a
cap or a rate limit. If a client would behave differently after your commit, the
document has to say so before you land it.

This is heavier than the usual "keep the docs current" because there is now a
client that cannot read the code. `~/Other/tgxcode-mobile` is a native Android
app — the second client of this bridge, alongside `web/app.js` — and its whole
design premise is that `docs/api.md` *is* the contract: it adds
no code to this repo, and anything it needs and cannot get from that file is
recorded as a gap to be fixed here. An agent working in that project reads
`docs/api.md` and nothing else of ours. So a field that changed shape and was
never written down does not produce a merge conflict or a failing test; it
produces a phone that silently renders the wrong thing, and a session that spends
an afternoon finding out why.

That has already happened, more than once, which is what this section is made of.
Four fields were documented by name alone and turned out to be
objects — `user.command`, `tool.result.patch` and `tool.agent` in the event table,
and the `status` a send returns. A whole event kind, `tool-result`, was never listed, so a phone client
left every tool spinning while you watched a live turn. And
`X-Claude-Sessions-Client: 1` has been mandatory on every non-GET `/api/` route
since the CSRF guard landed, without appearing in the document at all — so the
first thing a new client does is 403 on its entire write surface.

Three habits follow from that:

- **Write the type, not the field name.** `command` in a table cell is a lie a
  reader can act on; `command {name, args}` is not. An object, an array of
  objects, "a string or null" — say which.
- **Say when a route is narrower than it looks.** `/api/sessions` and
  `/api/dashboard` carry a *four-field* `runner`, not the full `runner-status`
  payload; a client that reads `runner.pendingPermission` there gets `undefined`
  forever and no error. The same goes for a response that is eventually consistent:
  `POST /api/sessions` returns an id that `GET /api/sessions/:id` 404s on for a
  few seconds, and the obvious client — navigate straight to the new id — reports
  "session not found" about a session that is being created perfectly well.
- **Fix the document rather than the reader.** If a client had to discover
  something by experiment, that discovery belongs in `docs/api.md` in the same
  commit. Both directions: gaps that `~/Other/tgxcode-mobile/README.md` reports
  under *Things found while building this* are ours to close, and closing one
  means editing `docs/api.md`, not replying in a transcript.

`docs/remote.md` is the same deal for anything you change about the local/remote
split, and `README.md` §Layout for a new module. `docs/api.md` is the one with a
client depending on it.

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

The suite is `auth`, `temp`, `recent`, `pulls`, `taskboard`, `ports`, `spinner`,
`changes`, `restart`, `handoff`, `drafts`, `notifications`, `schedule`, `usage`,
`titles`, `tasks` and `runner` on their own — no bridge needed — plus four that want a live one: `gate`,
`browser`, `refusals`, `unpaired`. Between them they cover the token, what a remote
caller is refused, what an unpaired remote device sees before and after pairing, and
what the nightly restart does when there is nobody to ask. If you touch
`bridge/auth.js` or any route's local/remote rule, run it: that is the part of this
codebase with tests around it.

**`runner` is the one to run when you touch `bridge/runner.js`**, and for the same
reason `schedule` exists: its bugs do not announce themselves. `inFlight` is both the
record of the turn being answered and the gate in `_flushQueue`, so an exit path that
forgets to empty it does not throw or log — it leaves a session that accepts a
message, draws a chip for it, reports `idle`, and never sends it. That is
indistinguishable from a slow turn from every surface the app has, and it is what a
hard stop did for months. The test drives a real `Runner` against a stub `claude`
(`CLAUDE_SESSIONS_CLAUDE_BIN`, set before the require — the constant is destructured
at load), and asserts three things per case rather than one: that nothing is left in
flight, that the next message is actually delivered, and that the *stopped* turn is
not delivered again. The third is not padding. The obvious fix for this bug is to
re-queue what was in flight, and that is wrong: `claude` writes its user entry at
submission, so a stopped turn is already in the transcript and re-sending it re-runs
work the user cancelled.

**Testing a schedule needs its own store, not the shared one.** Two things bite
otherwise, and both were measured rather than guessed. `schedules.json` lives in
`STATE_DIR`, which every bridge shares — so the everyday instance reads it every
thirty seconds and writes the rows back through a whitelist `clean()` that has
never heard of whatever field you just added, stripping it within half a minute
and resurrecting rows you deleted. And a schedule marked `test` is only skipped by
the *everyday* bridge as of the pull-request work; before that the guard narrowed a
dev bridge alone, and a probe schedule created while 45888 was up got run by 45888,
in the user's own checkout. So:

```bash
XDG_DATA_HOME=$(mktemp -d) CLAUDE_SESSIONS_SCHEDULE_ON_DEV=1 \
  CLAUDE_SESSIONS_PORT=45921 node bridge/server.js
```

That gets its own store *and* its own token, which is the point: nothing you do
there can reach the user's schedules. `CLAUDE_SESSIONS_SCHEDULE_ON_DEV=1` is what
lets a dev bridge fire at all, and it fires only `test` rows.

**A `test` schedule never writes to GitHub.** The pull-request gate comments on
pull requests and labels them, and `gh` is authenticated as the user on every
bridge — so that one line in `postReviewToPr` is the only thing between testing
this feature and commenting on real PRs. `gate.post: false` is the same switch for
a schedule you want quiet.

`schedule` is the other part worth that treatment, and for a different reason:
its bugs are ones nobody sees until 2 AM. A slot that fires twice on the night the
clocks go back, a missed run that is invisible because the lookback could not see
across a weekend, a marker that advances on a run that never happened — all three
were real, all three were caught by that file, and none of them would have shown
up in a window you were looking at. If you touch `bridge/schedule.js`, run it.

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
