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

**A queue that reaches the turn at its next step.** Write while an agent is busy
and the message waits above the composer; the next time the agent runs a tool, the
running turn reads it after that step, the way a terminal does. Reorder, edit or
drop anything still waiting — and drop or reword a handed message right up until
the turn reads it.

**What actually changed.** Per project: every directory with uncommitted work and
every open pull request, linked back to the session that did it. PR status —
draft, approved, checks failing, conflicting, merged — sits on the session title.

**Dev servers, found not configured.** When a session brings a port up it appears
as a chip; one click shows its page — in the window's own browser preview, or in
[DevBrowser](https://github.com/TheYearIsTwentyGX/dev-browser), as Settings says —
and one more shuts the server down.

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
| `claude` | The whole point. On `PATH`, or named by `TGXCODE_CLAUDE_BIN`. |
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
one in `%APPDATA%\tgxcode\` (on Linux, `~/.config/tgxcode/`):

```json
{ "bridgeDir": "~/src/tgxcode", "distro": "Ubuntu" }
```

`distro` is read only on Windows; on Linux there is no relay for it to name.

## Getting around

| | |
|---|---|
| **Left rail** | Every session on disk, grouped by project, sorted by when *you* last wrote; the project cards can be ordered four ways, and *Hide finished* drops sessions whose PRs have all landed. A green dot means the transcript moved in the last 90 seconds. |
| **Conversation** | Your turns and Claude's, with a collapsible block per tool call; edits render as diffs. |
| **Task board** | `Ctrl+2` — four columns over everything outstanding. |
| **Dashboard** | Uncommitted work and open pull requests, per project. |
| **Composer** | Sends to the session, resuming it in place. `@` mentions another running session. |
| **Snippets** | Canned messages with `{{placeholders}}`, pinnable to buttons of their own. |

Shortcuts: `Enter` send, `Ctrl+1`–`Ctrl+8` switch panes, `Ctrl+F` find, `Ctrl+K`
filter, `Ctrl+N` new session, ``Ctrl+` `` terminal, `Ctrl+P` / `Ctrl+M` cycle
permission mode and model, `Esc` back out. Nearly all are rebindable.

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
| `npm run restart` | Restart the everyday bridge to pick up new code. Turns in the session host survive it; refuses only while a turn is running outside the host. |
| `npm run land` | From a worktree: merge its pull request, fast-forward the main checkout, and restart the everyday bridge if the merge touched `bridge/`. `-- --status` / `-- --dry-run` to look first. |
| `npm run build` | Package the app — electron-builder on Linux, `install.ps1` from WSL. |

Two rules worth knowing before you send a patch:

- **`dependencies` is empty and stays empty.** The bridge uses Node built-ins
  only. `web/vendor/` holds prebuilt, committed bundles (xterm, diff2html,
  Preact) fetched with `npm pack` — never an `npm install`. A bundler would turn
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
| `bridge/mcp.js` | The tools this app gives a session: offer the next piece of work, find the other sessions, hand one of them a fact, search and take up suggested tasks, schedule a session |
| `bridge/handoff.js` | The rules a handoff has to pass: the loop guard, and what waking a session would run into |
| `bridge/slash-commands.js` | What slash commands a directory has, for composer completion |
| `bridge/auth.js` | The access token, and telling local from remote apart |
| `bridge/tailscale.js` | What this machine is reachable as, for pairing |
| `bridge/launch.sh` | Finds a node, then starts the bridge |
| `bridge/legacy-env.js` | Reads the pre-rename `CLAUDE_SESSIONS_<X>` variables as fallbacks for `TGXCODE_<X>` |
| `bridge/legacy-dirs.js` | Moves `…/claude-sessions` state and cache directories to `…/tgxcode`, leaving a symlink behind |
| `scripts/dev.js` | `npm run dev` — a development bridge and window that refuse the everyday port |
| `scripts/start.js` | `npm start` — finds the built app and launches it, on WSL or Linux |
| `scripts/build.js` | `npm run build` — `install.ps1` from WSL, electron-builder on Linux |
| `scripts/win.js` | Helpers for reaching the Windows side from WSL |
| `scripts/restart-bridge.sh` | `npm run restart` — restart the everyday bridge onto new code, and the nightly cron's entry point |
| `scripts/land.sh` | `npm run land` — merge a worktree's PR, fast-forward the main checkout, restart the bridge if `bridge/` changed |
| `scripts/import-spinner-verbs.js` | Rebuilds the verb catalogue from upstream |
| `scripts/quota-statusline.py` | Claude Code's status line, harvesting the quota percentages on the way past |
| `scripts/install-quota-statusline.js` | Points `~/.claude/settings.json` at that script, and refuses to clobber one you already have |
| `web/` | The UI. No build step: edit a file and refresh |
| `web/app.js` | Everything not yet moved out of it: the event stream, the composer and every surface but Settings and the transcript. Imports the modules below |
| `web/api.js` | `get`, `post`, `patch`, `put`, `del`, `postFile` — the fetch wrappers every call to the bridge goes through, and the CSRF header they send |
| `web/boot.js` | What the page was handed in `<meta>` tags — `BOOT_PREFS` and its fallback, the host paths, the pairing token — read synchronously at load |
| `web/state.js` | `state`, the page's one mutable store, and `DEFAULT_PERM`. What a surface remembers goes on here, not in a module-level `let` |
| `web/dom.js` | `dom` (every id in index.html, looked up once), `el`, `toast`, and the rules modal dialogs share |
| `web/format.js` | Timestamps, durations, paths and model ids as short text. Pure, so the Node tests import it directly |
| `web/icons.js` | `ICON`, the SVG glyphs every surface draws, `PR_ICON`, and `icon()` to make one |
| `web/notifications.js` | Desktop notifications and the chime for a turn that finished or is waiting on you, and the page side of `sw.js` — registering it, and opening the session a notification's button was about |
| `web/quota.js` | The quota pill and the Claude Code version pill, and their popovers. `loadQuota`/`loadCv` are what a reconnect calls |
| `web/restart.js` | Pull and restart — the quota popover's button that fast-forwards the checkout and hands over to `scripts/restart-bridge.sh`, and the dialog for a refusal |
| `web/channels.js` | The dev-server channel strip: a chip per port the open session started, to open in DevBrowser or stop |
| `web/settings/` | The Settings panel, one module per group. Every module here evaluates before app.js's body, so none may read an app.js `const` at top level |
| `web/settings/index.js` | Opening and closing the panel, loading and saving `~/.tgxcode/settings.json` a key at a time, the head and the table of contents |
| `web/settings/general.js` | `SETTINGS`, one row per key, and the builders that turn a row into a control |
| `web/settings/claude-config.js` | The Claude Code group — `~/.claude/settings.json` and a project's own, as controls and as JSON |
| `web/settings/hooks.js` | The hooks editor inside the Claude Code group |
| `web/settings/memory.js` | The Memory group — the CLAUDE.md files — and the full-height dialog on the same file |
| `web/settings/project-commands.js` | The Commands group — a project's `.tgxcode/commands.json`, as a form and as JSON |
| `web/settings/toolbar.js` | The top bar's layout and More menu, and the Toolbar group that edits them |
| `web/settings/shortcuts.js` | The Shortcuts group, and the key hints in every title that names a binding |
| `web/settings/notifications.js` | The Notifications group — this browser's switches for `web/notifications.js` |
| `web/transcript/` | The open conversation, kept imperative on purpose: rows are append-only, streamed from SSE, with scroll, width and find marks managed by hand. Like `settings/`, every module here evaluates before app.js's body, so none may read an imported binding at top level |
| `web/transcript/conversation.js` | Opening a session, its header, and appending events to the log through a view — `SESSION_VIEW` or `AGENT_VIEW` — so the main log and the subagent pane share one renderer; folding runs of tool calls |
| `web/transcript/rows.js` | One row per event — the row shell and its copy button, user, assistant and thinking rows, peer messages, handoffs and system lines |
| `web/transcript/tools.js` | Tool calls: the one-line summary, the block, and the body built on first expand (`fillTool`) |
| `web/transcript/approvals.js` | A blocked turn — the permission card, the plan pane and the question dock — and answering it |
| `web/transcript/review.js` | Reviewing a plan or a question after the fact |
| `web/transcript/subagents.js` | The subagent list and the pane that opens one's transcript |
| `web/transcript/suggestions.js` | Suggested follow-ups — the panel, the dialog that shows one at a readable width, and starting or dismissing one |
| `web/transcript/changes.js` | What this session changed, and the diff viewer (diff2html, read as `window.Diff2Html`, never imported) |
| `web/transcript/checklist.js` | The session's own task list, the column left of the transcript |
| `web/transcript/layout.js` | The width the log lays itself out at, the composer's insets, and sliding a side column in and out |
| `web/transcript/context-menu.js` | The right-click menu, and the file menu on a changed file |
| `web/transcript/turn-rail.js` | The turn rail, and revealing and flashing a row in the log |
| `web/transcript/find.js` | Ctrl+F over the transcript and its subagents |
| `web/terminal.js` | The terminal pane — a shell, or a run's output |
| `web/markdown.js` | The transcript's markdown renderer |
| `web/highlight.js` | The syntax highlighter behind it |
| `web/sw.js` | A service worker for one thing only: buttons on a notification. No `fetch` handler |
| `web/preview.js` | The browser preview — a dev server's page in the window, with DevBrowser's toolbar |
| `web/preview-picker.js` | The preview's element picker, copied from DevBrowser; runs inside the previewed page |
| `web/keys.js` | Which chord means which command, and the one function that decides it |
| `web/rail.js` | The sessions rail, drawn with Preact — keyed by session and by group, so an update keeps the rows it did not change. The first surface moved off `app.js`'s rebuild-everything rendering, and the pattern for the next |
| `web/vendor/` | The libraries worth not writing — xterm; diff2html for the diff viewer; and `preact.js`, htm's standalone build (Preact 10 + hooks + htm in one ESM file) for components written without JSX. Checked-in prebuilt bundles, not a `node_modules` |
| `app/main.js` | The Electron shell, and the rules for what a preview `<webview>` may load |
| `app/preload.js` | The page's only doors into the shell: raise the window, and the preview's two clipboard writes |
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
