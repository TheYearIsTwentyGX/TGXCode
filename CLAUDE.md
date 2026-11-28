# Working on TGXCode

This app is used while it is being worked on. The user keeps a window open with
live sessions in it, and those sessions are real work in progress. Breaking the
rules below destroys that work.

## Never touch the everyday instance

**Port 45888 belongs to the user.** Do not start a bridge on it, do not
`pkill -f bridge/server.js` (it matches every bridge, the user's included), and do
not `Stop-Process` TGXCode or ClaudeSessions, its name before the rename.

Use your own instance:

```bash
npm run dev                  # bridge on 45899 (or the next free port) + a window
npm run dev:headless         # bridge only; open the printed URL in a browser
npm run dev -- --port=45905  # ask for a particular one
```

`npm run dev` refuses 45888, `--port` included, and its window is titled
`dev :<port>` with an amber badge. The **Dev instance** button in the conversation
header does the same from `.tgxcode/commands.json`, picking a free port in
45899–45918. Stop your own bridge with Ctrl-C, or by port:

```bash
kill "$(ss -ltnp 2>/dev/null | grep :45899 | grep -oP 'pid=\K\d+' | head -1)"
```

**A `TGXCODE_PORT` already in your environment is not a port you chose.** It used to
arrive pre-set to 45888 in every session the app started, so `bash bridge/launch.sh`
from a worktree bound the user's port without anyone naming it, and the everyday
window quietly served a stale branch. Prefer `--port`. Three guards now stop it:
`bridge/server.js` exits 4 rather than bind 45888 from under `.claude/worktrees/`;
the bridge no longer passes `TGXCODE_PORT` to the sessions and terminals it starts;
and `scripts/restart-bridge.sh` refuses the everyday port from a worktree
(`--status` still works anywhere). When a window shows something you cannot
explain, check which checkout it serves:

```bash
curl -s http://127.0.0.1:45888/api/health | python3 -m json.tool | grep root
```

**Do not kill the session host either.** `claude` stops when the process holding its
stdin exits, so live turns are held by `bridge/host.js`, one per port, at
`~/.local/share/tgxcode/host-<port>.sock`. A bridge that exits hands its sessions to
the host, and the next bridge on that port adopts them, so restarting a bridge is
safe. Killing the host ends every turn it holds. Its pid is `sessionHost.pid` in
`/api/health`; it runs under `setsid` and exits on its own after ten idle minutes,
which is how a new `host.js` gets picked up. `atRisk` in `/api/health` counts turns
started with no host to hold them, which a restart would end. Keep `host.js`
boring: it relays bytes and knows nothing of stream-json, because replacing it
costs every turn it holds. Protocol changes go in `bridge/runner.js`. Run
`node test/host.test.js` if you touch it.

A midnight cron restarts the everyday bridge and logs each run to
`~/.cache/tgxcode/restart-45888.log`. Uncommitted changes under `bridge/` in the
main checkout make it skip (`grep skipped-dirty`), so half-finished `bridge/` edits
there silently pin the everyday instance to yesterday's code. See docs/manual.md
§Picking up new code.

## Work in a worktree, never the main checkout

Several agents work on this repo at once and reach for the same files in `bridge/`
and `web/`. Editing the main checkout means agents overwriting each other, and it
leaves the checkout the user runs the app from dirty.

**Make the worktree your first action, before the first edit.** `cd` into the repo,
then call `EnterWorktree` with a short name; it branches `worktree-<name>` off local
HEAD (`baseRef` is pinned to `head` in `.claude/settings.json`). Launched in `~`,
it fails with "not in a git repository and no WorktreeCreate hooks are configured",
which is the wrong directory, not a missing hook. Edits made before you move stay
behind in the main checkout and have to be carried across by hand.

Reading, diagnosing, querying a bridge and `npm run dev` are fine from anywhere;
the rule is about writing tracked files. A dev bridge run from the worktree serves
that worktree's `bridge/` and `web/`.

Entering a worktree leaves the session with two `<id>.jsonl` files, one under the
worktree's project directory. That is expected: `conversationRecord` in
`bridge/sessions.js` picks the copy holding the conversation.

## There is no mobile web UI

**A UI change lands in `web/` (`app.js`, `index.html` and their modules), desktop
only.** Do not ask whether it should also go to mobile, do not build a
narrow-screen variant, and do not add a `/m` back; `test/browser.test.js` asserts
`/m` and its old assets 404.

The phone client is the native Android app in the `tgxcode-mobile` repository, a
sibling of the main checkout. It reads `docs/api.md` and nothing else of ours, so if
the phone needs what you are building, your deliverable here is that document (next
section).

Not phone machinery, so do not delete them: `web/sw.js` (the desktop registers it
for notification actions), the `/pair` handshake and the **Connect a phone** group
in Settings, and the `@media` blocks in `web/css/*.css` (narrow desktop windows and
`prefers-reduced-motion`).

## Leave `docs/api.md` true before you land

**If your change touched the bridge's wire surface, updating `docs/api.md` is part
of the change.** Wire surface means: a route added, removed or renamed; a request
or response field added, removed, retyped or given a new meaning; a new
`/api/events` event or payload field; a status code, refusal rule, local/remote
classification, required header, cap or rate limit. If a client would behave
differently after your commit, the document says so before you land.

The Android app cannot read the code. A field that changes shape without being
written down produces no conflict and no failing test, only a phone that silently
renders the wrong thing. Three habits:

- **Write the type, not the field name.** `command` in a table cell is a lie a
  reader can act on; `command {name, args}` is not.
- **Say when a route is narrower than it looks, or eventually consistent.**
  `/api/sessions` carries a six-field `runner`, not the full `runner-status`
  payload. `POST /api/sessions` returns an id that `GET /api/sessions/:id` 404s on
  for a few seconds.
- **Fix the document, not the reader.** Anything a client had to discover by
  experiment goes into `docs/api.md` in the same commit. The gaps listed under
  *Things found while building this* in the `tgxcode-mobile` README are ours to
  close, and closing one means editing `docs/api.md`.

`docs/remote.md` is the same for the local/remote split, and README §Layout for a
new module.

## Landing what you finished

`npm run land`, from your worktree, merges the pull request for your branch and
fast-forwards the main checkout (`$TGXCODE_MAIN`, default `~/Other/claude-sessions`;
set it where the checkout lives elsewhere). It is the sanctioned way to reach the
main checkout: your harness refuses `git -C` there, and the script only
fast-forwards and never commits. The **Land** button in the header runs it.

```bash
npm run land -- --status      # what would land, and whether it can
npm run land -- --dry-run     # say what would happen, change nothing
npm run land                  # merge, pull the main checkout, restart if bridge/ changed
npm run land -- --no-restart  # the same, but leave the running bridge alone
```

It refuses rather than guesses, and each refusal says what to do next: uncommitted
files or unpushed commits in your worktree, a PR that conflicts or is blocked, a
main checkout on another branch. A refusal after the merge says so.

**If the main checkout has uncommitted tracked files, land merges and then does not
pull.** Those are usually the user's own edits. Report that to the user, with the
files land listed. Do not stash, check out, reset or otherwise discard them, and do
not try to pull around them.

When the merge touched `bridge/`, land restarts the everyday bridge through
`scripts/restart-bridge.sh`; live turns survive because the host holds them. The
script refuses while any turn is `atRisk`. Land reports that, tells you to run
`npm run restart` later, and never forces it. It never starts a bridge that was not
already running. `--restart` restarts even when `bridge/` did not change. The
restart runs under `setsid`, because the bridge kills its runs as it exits, the Land
button's included. From the button the pane therefore ends on the old bridge, and
whether the new one came up is the last line of `~/.cache/tgxcode/restart-45888.log`.

Before landing:

- **Check whether `README.md` needs changing.** This is a check, not a requirement
  to edit it, and keep the README brief.
- **If you changed the UI, check whether README's text or pictures should show
  it.** Regenerate pictures with `npm run screenshots`, which uses invented demo
  data on an isolated bridge (docs/manual.md §Screenshots). A screenshot taken from
  a real window may show data only from these projects: TGXCode, TGXCode-Combined,
  TableGX, MobiliTGX and TGXReact.
- **Write the commit message as prose.** The subject is an imperative,
  sentence-case description of the change as the user meets it ("Give each session
  its own terminal pane"). The body says why, including what was rejected. No
  `feat:` or `fix:` prefixes.

## Clean up the sessions you start

Both instances read the same `~/.claude/projects`, so every session you start shows
up in the user's sidebar. Do not leave `probe` and `sandbox` sessions there. Label
them on the way in, and delete them on the way out.

- **Mark it a test session**, which keeps it out of the everyday window (it shows in
  a **Test sessions** card on dev only). Tick *Test session — dev only* in the Start
  a session dialog, or:

  ```bash
  curl -sX POST http://127.0.0.1:45899/api/sessions \
    -H "Authorization: Bearer $(cat ~/.local/share/tgxcode/token)" \
    -H 'X-TGXCode-Client: 1' -H 'Content-Type: application/json' \
    -d '{"cwd":"'"$PWD"'","prompt":"…","test":true}'
  ```

- **Delete it when you are done**, with the trash icon on its row, or:

  ```bash
  curl -sX DELETE http://127.0.0.1:45899/api/sessions/$ID \
    -H "Authorization: Bearer $(cat ~/.local/share/tgxcode/token)" \
    -H 'X-TGXCode-Client: 1'
  ```

  This hard-deletes the transcript and its sidecar directory, so only use it on
  sessions you created. Stop the session first: a `claude` still exiting can write
  back to the path, and the session reappears as an empty row.

## The API needs a token

Every `/api/` route except `/api/health` needs the token at
`~/.local/share/tgxcode/token`, and every non-GET route also needs
`X-TGXCode-Client: 1` (the CSRF guard):

```bash
-H "Authorization: Bearer $(cat ~/.local/share/tgxcode/token)"
```

A `401 {"error":"unauthorized"}` means the token is missing, not that the bridge is
broken. `web/` needs no login code, and yours should not add any: a page fetched
over loopback gets the token in a `<meta name="tgx-token">` tag and an `HttpOnly`
cookie, and `fetch` and `EventSource` send the cookie on their own. `/api/health`
stays open because `app/main.js` pings it before it has a token. The bridge refuses
to bind a non-loopback interface without `TGXCODE_ALLOW_REMOTE_BIND=1`.
`docs/remote.md` has the reasoning and `docs/api.md` the contract.

## There are tests, and they are quick

```bash
npm test               # starts a bridge on a free port, runs everything, stops it
npm test -- 45901      # run against a bridge you already have on that port
```

`test/run.js` is the list: `UNIT` runs without a bridge, and `LIVE` needs one. Add a
new test file to the right array there. It refuses 45888, because the tests start
and delete sessions. Which tests to run when:

- **`bridge/auth.js` or any route's local/remote rule:** the whole suite. The live
  tests `gate`, `browser`, `refusals` and `unpaired` cover the token, what a remote
  caller is refused, and pairing.
- **`bridge/runner.js`: `node test/runner.test.js`.** `inFlight` is both the record
  of the current turn and the gate in `_flushQueue`. An exit path that forgets to
  empty it leaves a session that accepts messages and never sends them, with no
  error anywhere. The test drives a real `Runner` against a stub `claude`
  (`TGXCODE_CLAUDE_BIN`) and checks three things: nothing is left in flight, the
  next message is delivered, and the stopped turn is *not* sent again. Do not "fix"
  a stuck queue by re-queueing what was in flight. `claude` writes the user entry at
  submission, so re-sending re-runs work the user cancelled.
- **Snippet seeding: `snippets`.** A deleted snippet coming back after a restart
  looks like data loss. The guard is a record of which shipped ids were offered,
  never "is the list empty".
- **`bridge/schedule.js`: `schedule`.** Its bugs (a slot firing twice when the clocks
  go back, a missed run hidden across a weekend) only show at 2 AM.
- **`bridge/host.js`: `host`.** **`bridge/platform.js`: `platform`**, which asserts
  on what got spawned. **`scripts/restart-bridge.sh`: `restart`**, which spawns
  the script `detached` so that it never reaches a real terminal's prompt.

### Isolate shared state when you test

Every bridge shares `STATE_DIR`, `~/.tgxcode` and the user's Codex home. A test that
writes to them writes to the user's real data.

- **Schedules.** `schedules.json` is shared, and the everyday bridge rewrites it
  every thirty seconds, which strips fields it does not know and brings back deleted
  rows. Give the bridge its own store and token:

  ```bash
  XDG_DATA_HOME=$(mktemp -d) TGXCODE_SCHEDULE_ON_DEV=1 \
    TGXCODE_PORT=45921 node bridge/server.js
  ```

  `TGXCODE_SCHEDULE_ON_DEV=1` lets a dev bridge fire, and it fires only `test` rows.
  A `test` schedule never comments on or labels a pull request (`postReviewToPr`
  in `bridge/pr-gate.js`), and `gate.post: false` does the same for a schedule you
  want quiet. `gh` is authenticated as the user on every bridge, so that check is
  all that keeps a probe off real PRs.
- **Settings.** Saving Settings on a dev bridge rewrites the user's
  `~/.tgxcode/settings.json`. Overriding `HOME` is refused by the worktree guard, so
  use `TGXCODE_PREFS_DIR=$(mktemp -d) npm run dev:headless`.
- **Codex.** Never run against the real `~/.codex`. `bridge/config.js` resolves
  `HOME` and `CODEX_HOME` at load, so a unit test sets both to a temp directory
  *before* its first `require` and asserts the resolved paths are inside it before
  writing; copy the header of `test/skills.test.js` or `test/codex-config.test.js`.
  A dev bridge that will write Codex config, hooks or skills gets
  `CODEX_HOME=$(mktemp -d)`.

## No dependencies, no build step

**`"dependencies": {}` in `package.json` is load-bearing, and `web/` has no build
step on purpose.** A single `npm install` breaks both, and neither breaks loudly.

- `web/` is served live off disk per request, so a UI edit shows on refresh.
  A bundler would turn `web/app.js` into a build artifact and end that.
- `install.ps1` copies `package.json` into a Windows staging directory and runs
  `npm install` there before electron-builder. Anything in `dependencies` gets
  packaged into the shell. That is why `electron` and `electron-builder` are
  devDependencies.
- `bridge/` requires only Node built-ins. If you want a package there, the answer is
  almost always less code.

The one exception is `web/vendor/`: **prebuilt browser bundles, committed**, fetched
with `npm pack` (never `npm install`), renamed to `.js`/`.css`, with their licence
and version recorded, and never from a CDN, because the CSP refuses it. **Check the
bundle's footer before you load it**. An ESM bundle (ends in `export{…}`) is
imported. A UMD one (`}(this, …)`, like `diff2html.js`) needs a classic `<script>`,
because importing it throws before `app.js` runs. docs/vendoring.md has the
procedure.

UI that updates under the cursor uses Preact (`web/vendor/preact.js`, with htm, no
JSX); `web/rail.js` is the pattern. Keep state in `app.js`'s `state`, key every list
child by something stable, and never edit DOM that Preact rendered: put the fact in
`state` and re-render. docs/vendoring.md §Preact has the details.

## Never rebuild without asking

`install.ps1` force-closes the running TGXCode and replaces the executable, which
shuts the user's window, and two agents packaging at once wipe each other's staging
directory. Changes to `bridge/` and `web/` never need a rebuild: restart your dev
bridge, or refresh for UI-only edits. Only `app/main.js` and `package.json` are
packaged. If one of those has to ship, say so and let the user run it.

`npm run release:local` closes nothing, but it publishes to the folder the everyday
app auto-updates from. It refuses a branch or uncommitted `app/` build unless you
name a folder (`--feed <dir>`). Do not pass `--allow-dev` unasked, and leave
**Restart to update** to the user (docs/manual.md §Updating the desktop app).

On a Linux host, `npm run build` still replaces the app the user is looking at, so
ask first. `npm install` there only fetches devDependencies into `node_modules/`,
and `electron .` is the normal way to try an `app/main.js` change. On WSL there is
no `node_modules` on purpose: the shell has to be a Windows build, packaged from the
Windows-side staging directory, and `npm start` finds the built executable.

## The old name is still wired in, on purpose

The app was **Claude Sessions** before it was TGXCode. Every old spelling is still
accepted, so builds and paired devices from before the rename keep working. None of
it is a leftover to tidy:

- `CLAUDE_SESSIONS_<X>` fills in for an unset `TGXCODE_<X>` (`bridge/legacy-env.js`,
  and the loop at the top of `app/main.js`). Stripping the port strips both.
- `X-Claude-Sessions-Client` passes the CSRF guard; `web/`, `bridge/mcp.js` and
  `app/main.js` send both headers.
- `cs_token` is read beside `tgx_token`, and the `cs-*` `<meta>` names beside `tgx-*`.
- `~/.local/share/claude-sessions` and `~/.cache/claude-sessions` are moved to
  `…/tgxcode` and left as symlinks (`bridge/legacy-dirs.js`).

The checkout directory `~/Other/claude-sessions`, and the `.claude/projects`
directories derived from it, kept the old name too.

## Finding your way around

README §Layout is the file map, one line per module. `docs/api.md` is the API
contract, `docs/remote.md` the local/remote reasoning, and `docs/plans/` the design
notes. Every module under `bridge/` opens with a header comment saying why it exists;
read that before grepping the body. Each `/api/` route family is a module under
`bridge/routes/`, tried in the order of `ROUTES` in `server.js`, which is a
first-match chain, so order matters.

## Gotchas

- **A login shell has neither node nor `claude` on PATH.** nvm and `~/.local/bin`
  come from `~/.bashrc`, which `bash -lc`, cron and systemd never read.
  `bridge/launch.sh` resolves node itself for that reason.
- **Host detection lives in `bridge/platform.js`** (`isWsl()`, overridable with
  `TGXCODE_HOST_KIND`). Use it rather than adding a `process.platform` check, and
  add a case to `test/platform.test.js`.
