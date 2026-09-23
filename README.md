# TGXCode

**A desktop console for the Claude Code sessions running on your machine.**

Claude Code is a terminal tool, and a terminal holds one session at a time. Once
you are running several — a refactor here, a review there, a nightly job you
started and forgot — the question stops being *what is this agent doing* and
becomes *which of these needs me*. TGXCode answers that one.

It lists every session on disk, renders each as a proper conversation with
syntax-highlighted code and collapsible tool calls, and lets you send messages
or start new work. Sessions you started in a terminal appear here too and stream
as they go — TGXCode reads the same transcripts Claude Code writes, so there is
no separate world and nothing to opt into.

```
┌─ Needs you ──────┬─ Working ────────┬─ Suggested ──────┬─ Idle ───────────┐
│ auth-refactor    │ payments-api     │ add retry test   │ docs-pass        │
│   ↳ permission   │   ↳ 4m, editing  │   ↳ from ci-fix  │   ↳ 2h ago       │
│ ci-fix           │ schema-migrate   │ drop dead flag   │ spike-worker     │
│   ↳ plan waiting │   ↳ 11m, testing │   ↳ from auth-…  │   ↳ yesterday    │
└──────────────────┴──────────────────┴──────────────────┴──────────────────┘
```

> **Status.** Built for one person's daily use and run that way every day. It is
> opinionated about workflow, and it assumes Linux (or WSL2). Issues and patches
> welcome; treat the version number as decoration.

---

## What it gives you

**A board instead of a pile.** Four columns over every session: what is blocked
on you, what is working, what has been suggested, and what has gone quiet. The
count in the title bar is how many things are waiting on a human.

**Answers without a terminal.** Permission prompts, plans and multiple-choice
questions surface as cards. Approve a plan, approve it with a note, or send it
back with what to change — and pick the permission mode the work continues in.

**Work that hands itself on.** Sessions can see each other, message each other,
and pass work along with enough context to resume it. An agent that notices
something outside its brief files it as a suggested task with the prompt already
written, and you start it with one click.

**A queue that waits its turn.** Write while an agent is busy and the message
holds until the turn ends. Reorder, edit or drop anything still pending.

**What actually changed.** Per project: every directory with uncommitted work and
every open pull request, linked back to the session that did it. PR status —
draft, approved, checks failing, conflicting, merged — sits on the session title.

**Dev servers, found not configured.** When a session brings a port up it appears
as a chip; one click switches [DevBrowser](https://github.com/TheYearIsTwentyGX/dev-browser)
to that tab, and one more shuts the server down.

**Sessions on a clock.** Nightly review of open pull requests, a catch-up on a
branch's new commits — scheduled work that starts itself and lands in its own
fold of the rail rather than burying the conversation you wanted.

**A phone, when you are not at the desk.** A native Android client speaks the
same API. It can watch, send, and answer permissions and plans; it deliberately
cannot open a terminal, stop the bridge, or run anything unsandboxed.

The full tour — every pane, every setting, and the reasoning behind the ones that
are not obvious — is in **[`docs/manual.md`](docs/manual.md)**.

## How it fits together

```
   the shell                                Linux
   ┌───────────────────┐                    ┌──────────────────────────────┐
   │ TGXCode           │  HTTP + SSE        │ bridge  (node, no deps)      │
   │ (Electron)        │ ─────────────────► │   • indexes ~/.claude        │
   │                   │  127.0.0.1:45888   │   • tails transcripts        │
   │ a window, and     │                    │   • runs `claude`            │
   │ nothing else      │                    │   • serves web/              │
   └───────────────────┘                    └──────────┬───────────────────┘
            │                                          │
            │ starts on launch (bash, or wsl.exe)      │ spawns
            └──────────────────────────────────────────┤
                                                       ▼
   ┌───────────────────┐                    ┌──────────────────────────────┐
   │ DevBrowser        │ ◄───────────────── │ claude -p --input-format     │
   │ 127.0.0.1:45777   │  open tab :5006    │        stream-json …         │
   └───────────────────┘                    └──────────────────────────────┘
```

It runs two ways: **on Linux**, where the app and the sessions share a machine,
and **on Windows**, where the window is a Windows executable and the sessions
live in WSL2. That works because WSL can run with `networkingMode=mirrored`, so
`127.0.0.1` is the same loopback on both sides — no port proxy, no firewall rule.
The arrow is the same HTTP either way, which is why there is one app and not two.

**The split matters more than the platform.** All the real work happens in the
**bridge**, a dependency-free Node process: it reads `~/.claude/projects` at
native speed, spawns `claude` with the right environment, and serves the UI. The
**Electron shell** is about 200 lines that start the bridge and point a window at
it, and there is exactly one thing it does that the page cannot do for itself —
raise the window when you click a notification.

Three things follow:

- **Editing `bridge/` or `web/` needs no rebuild.** Restart the app, or press
  Ctrl+R for UI-only changes. You rebuild only when `app/main.js` or
  `package.json` changes.
- **The UI works in any browser.** Run `npm run bridge` and open
  <http://127.0.0.1:45888>. A perfectly reasonable way to use TGXCode if you would
  rather not install a desktop shell at all.
- **The bridge barely knows which host it is on.** One module,
  `bridge/platform.js`, and two callers: what opens a file (`explorer.exe` or
  `xdg-open`), and where DevBrowser keeps its control-server file. Everything
  else — the pty, port ownership, process liveness — is plain Linux on both.

## Requirements

The bridge is dependency-free Node against a fairly plain Linux userland, and it
is specific about which parts it uses:

| | For |
|---|---|
| node | The bridge. `bridge/launch.sh` finds an nvm-managed one if it is not on `PATH`. |
| `claude` | The whole point. On `PATH`, or named by `CLAUDE_SESSIONS_CLAUDE_BIN`. |
| `bash` | `launch.sh`, the terminal pane, `restart-bridge.sh`. |
| `util-linux` — `script`, `stty` | The pty. There is no node-pty here and no native modules; `script(1)` *is* the terminal. |
| `iproute2` — `ss` | Which process holds a dev server's port. |
| `procps` — `ps` | The quota beacon. |
| `git`, `curl`, `python3` | Changes and diffs; the health check and restart script. |
| `xdg-utils` — `xdg-open` | Opening a file or folder, on a Linux host. |
| `gh` *(optional)* | Pull requests. |
| `tailscale` *(optional)* | Reaching the bridge from a phone — see [`docs/remote.md`](docs/remote.md). |

`/proc` is read directly for process liveness and a dev server's working
directory, so this wants **Linux specifically** rather than any Unix. On Windows,
add WSL2 with `networkingMode=mirrored`, and PowerShell for the build.

## Install

### Linux

```bash
git clone https://github.com/TheYearIsTwentyGX/TGXCode.git
cd TGXCode
npm run build       # installs devDependencies, then packages an AppImage into dist/
npm start           # run it
```

Or skip the shell entirely — `npm run bridge`, then open
<http://127.0.0.1:45888>. The UI is identical; what you give up is the window
raising itself when you click a notification.

### Windows

From PowerShell, in the checkout:

```powershell
.\install.ps1
```

or from WSL, `npm run build`.

It checks that WSL can find the bridge, stages the Electron shell into
`%LOCALAPPDATA%`, packages it, and runs the installer. Packaging happens
Windows-side on purpose: electron-builder is slow and flaky over the
`\\wsl.localhost` share.

```powershell
.\install.ps1 -NoInstall                    # build the installer, don't run it
.\install.ps1 -BridgeDir '~/src/tgxcode' -Distro Ubuntu
```

The script bakes the bridge location into `app/config.json`. To change it later
without rebuilding, edit that file next to the installed executable, or create
one in `%APPDATA%\claude-sessions\` (on Linux, `~/.config/claude-sessions/`):

```json
{ "bridgeDir": "~/src/tgxcode", "distro": "Ubuntu" }
```

`distro` is read only on Windows; on Linux there is no relay for it to name.

## Getting around

| | |
|---|---|
| **Left rail** | Every session on disk, grouped by project, sorted by when *you* last wrote. A green dot means the transcript moved in the last 90 seconds. |
| **Conversation** | Your turns and Claude's, with a collapsible block per tool call; edits render as diffs. |
| **Task board** | `Ctrl+2` — four columns over everything outstanding. |
| **Dashboard** | Uncommitted work and open pull requests, per project. |
| **Composer** | Sends to the session, resuming it in place. `@` mentions another running session. |
| **Snippets** | Canned messages with `{{placeholders}}`, pinnable to buttons of their own. |

Shortcuts: `Enter` send, `Ctrl+1`–`Ctrl+8` switch panes, `Ctrl+F` find, `Ctrl+K`
filter, `Ctrl+N` new session, `Esc` back out. Nearly all are rebindable.

**[`docs/manual.md`](docs/manual.md) is the real documentation** — the panes in
full, the settings, permissions, notifications, scheduling, and the rules that
are easier to read than to infer.

## Documentation

| | |
|---|---|
| [`docs/manual.md`](docs/manual.md) | Everything the app does, at length |
| [`docs/api.md`](docs/api.md) | The bridge API, written as a contract for other clients |
| [`docs/remote.md`](docs/remote.md) | Reaching the bridge from a phone, and the local/remote split |
| [`docs/plans/`](docs/plans) | The design notes features were built from |
| [`CLAUDE.md`](CLAUDE.md) | Working on this codebase, with or without an agent |

## Development

| | |
|---|---|
| `npm start` | Launch the app. It starts its own bridge on 45888. |
| `npm run dev` | A **separate** instance on 45899 plus its own window — for working on TGXCode without disturbing the one you use. |
| `npm run dev:headless` | The same, bridge only. The fastest loop for UI work: edit `web/`, hit refresh. |
| `npm run bridge` | The bridge in the foreground on 45888. |
| `npm test` | Starts a bridge on a free port, runs everything, stops it. `npm test -- 45901` uses one you already have. |
| `npm run restart` | Restart the everyday bridge to pick up new code. Refuses while a turn is in flight. |
| `npm run build` | Package the app — electron-builder on Linux, `install.ps1` from WSL. |

Two rules worth knowing before you send a patch:

- **`dependencies` is empty and stays empty.** The bridge uses Node built-ins
  only. `web/vendor/` holds prebuilt, committed bundles (xterm, diff2html)
  fetched with `npm pack` — never an `npm install`. A bundler would turn
  `web/app.js` into a build artifact and put a build step between every UI edit
  and a refresh, which is the loop worth protecting.
- **`docs/api.md` is a contract.** A second client — the Android app — reads it
  and cannot read the code. If a change moves the wire surface, that document
  changes in the same commit.

[`CLAUDE.md`](CLAUDE.md) has the rest, including why there are two ports.

### Layout

| Path | |
|---|---|
| `bridge/server.js` | HTTP + SSE, routing, static files |
| `bridge/config.js` | Paths, ports, allowed roots — every constant with a reason attached, and the two containment checks that decide whether a path is one a caller may name |
| `bridge/dashboard.js` | Uncommitted changes and open PRs, per project |
| `bridge/git.js` | Every question the bridge asks git about a directory, cached once for all of them |
| `bridge/restart.js` | Pulling this checkout and handing over to `scripts/restart-bridge.sh` — the one mutating git call |
| `bridge/changes.js` | What a session changed, out of its transcript and its subagents' |
| `bridge/pulls.js` | Everything this app asks GitHub about a pull request, what its status *is*, and the review it leaves behind |
| `bridge/pr-store.js` | When to ask, and last time's answer kept on disk — so no route ever waits on GitHub |
| `bridge/overview.js` | The live board: what every session is doing right now |
| `bridge/taskboard.js` | The task board: everything outstanding, in a column per state |
| `bridge/sessions.js` | The session index — incremental, cached, watched |
| `bridge/registry.js` | Which sessions have a process, from Claude Code's own registry |
| `bridge/transcript.js` | JSONL → render events; pairs tool calls with results; reads subagent transcripts |
| `bridge/tasks.js` | A session's own task list — the items, and how far through them it is |
| `bridge/attachments.js` | Files pasted into the composer — where they land, and out of git |
| `bridge/memo.js` | Small notes the UI keeps against a session |
| `bridge/runner.js` | `claude` processes, one per active conversation |
| `bridge/host.js` | The session host: owns `claude`'s pipes so a turn outlives a bridge restart. A dumb relay, on purpose |
| `bridge/host-client.js` | The bridge's side of it — a hosted `claude` dressed as a ChildProcess, or a plain spawn when there is no host |
| `bridge/terminal.js` | The pty, out of `script(1)` — a shell to type into, or a declared command |
| `bridge/commands.js` | What a project declares in `.tgxcode/` — the two files, the merge between them, and the editor that writes them back |
| `bridge/runs.js` | Running those commands, and keeping the record |
| `bridge/ports.js` | Finding a port that is free *and* unclaimed, holding it, and remembering it |
| `bridge/devservers.js` | Port detection, ranking, and stopping a server |
| `bridge/devbrowser.js` | DevBrowser control client |
| `bridge/explorer.js` | Opens a directory in the host's file manager, a file in whatever the host opens it with, and knows what it will not launch |
| `bridge/wispr.js` | Presses a Wispr Flow transform's chord on the Windows desktop through PowerShell's SendInput, and the chord grammar `wispr.transforms` is written in |
| `bridge/platform.js` | Whether there is a Windows on the other side of this bridge, and the env var that lets a test pretend otherwise |
| `bridge/notifications.js` | The notification log, what is worth raising, and what you have already read |
| `bridge/flags.js` | Pinned, archived and test state |
| `bridge/prefs.js` | Settings from `~/.tgxcode/` and from the project — which file each one came from, and which one a save goes to |
| `bridge/claude-config.js` | Claude Code's *own* settings files — the chain, what each one says, and the preconditions on writing somebody else's format |
| `bridge/claude-version.js` | Installed Claude Code against the registry, and which live sessions are on an older binary |
| `bridge/claude-schema.js` | Which of Claude Code's keys this app has a control for, and what happens to the ones it does not |
| `bridge/claude-docs.js` | Claude Code's memory files — which `CLAUDE.md` a scope means, and reading and writing one whole |
| `bridge/jsonfile.js` | Reading and writing one small JSON file: the size cap, the BOM, the atomic write, the stamp |
| `bridge/keymap.js` | The shortcuts that may be rebound, and the grammar for writing one down |
| `bridge/spinner.js` | What a turn in progress calls itself, out of `~/.tgxcode/verbs/` |
| `bridge/spinner-verbs.json` | The verb catalogue, and the seed for that directory |
| `bridge/suggestions.js` | What you did about a suggested follow-up |
| `bridge/drafts.js` | Sessions set up but not started — a create call, held back |
| `bridge/later.js` | Messages delivered to a session at a time you picked — a send, held back |
| `bridge/snippets.js` | Canned messages and the groups they sit in |
| `bridge/usage.js` | How much of the 5-hour window and the week are gone, merged from turn events and the status line |
| `bridge/beacon.js` | A `claude` started for four seconds and killed, so the quota percentages refresh with no terminal open |
| `bridge/schedule.js` | Sessions that start on a clock — the store, the cron, and what counts as new since last time |
| `bridge/mcp.js` | The tools this app gives a session: offer the next piece of work, find the other sessions, hand one of them a fact |
| `bridge/handoff.js` | The rules a handoff has to pass: the loop guard, and what waking a session would run into |
| `bridge/slash-commands.js` | What slash commands a directory has, for composer completion |
| `bridge/auth.js` | The access token, and telling local from remote apart |
| `bridge/tailscale.js` | What this machine is reachable as, for pairing |
| `bridge/launch.sh` | Finds a node, then starts the bridge |
| `scripts/import-spinner-verbs.js` | Rebuilds the verb catalogue from upstream |
| `scripts/quota-statusline.py` | Claude Code's status line, harvesting the quota percentages on the way past |
| `scripts/install-quota-statusline.js` | Points `~/.claude/settings.json` at that script, and refuses to clobber one you already have |
| `web/` | The UI. No build step: edit a file and refresh |
| `web/terminal.js` | The terminal pane — a shell, or a run's output |
| `web/keys.js` | Which chord means which command, and the one function that decides it |
| `web/vendor/` | The two libraries worth not writing — xterm, and diff2html for the diff viewer. Checked-in prebuilt bundles, not a `node_modules` |
| `app/main.js` | The Electron shell |
| `app/make-icon.js` | Generates the packaged shell's icon |

`launch.sh` exists because the shell starts the bridge with `bash -lc` — a
*login* shell, which reads `~/.profile` but not `~/.bashrc`, and nvm installs
itself in `~/.bashrc`. Node is simply absent in that context, so every caller
goes through the script that knows where to look. Cron and systemd hand you the
same empty `PATH` on any machine, which is why the script stayed when the WSL
relay became optional.

## Notes and limits

- **Content comes from the transcript file, never from the process.** That is
  what makes a session running in your terminal look identical to one started
  here. The trade-off is that updates arrive per message rather than per token.
- **Reasoning is usually blank.** Claude Code writes the signature of a thinking
  block but strips its text. Newer sessions keep it and those render; older ones
  show nothing because there is nothing there.
- **A bridge restart no longer ends a turn — as long as the session host is up.**
  `claude` reads stdin for input, so whoever holds that pipe decides how long it
  lives. `bridge/host.js` holds it now, and the next bridge on the same port picks
  the session back up, approval cards and all. A turn started while no host could
  be reached (`sessionHost: null` in `/api/health`) still stops with its bridge,
  and killing the host itself ends everything it holds. That is why development
  still runs on a second port.
- **One writer at a time.** Sending from here while the same session is mid-turn
  in a terminal would have two processes appending to one transcript. The rail
  flags active sessions; it does not stop you.

The rest — what **Stop** does on the first click versus the second, and why the
bridge outlives the window — is in [`docs/manual.md`](docs/manual.md).

## Licence

None yet — all rights reserved. Ask if you want to do something with it.
