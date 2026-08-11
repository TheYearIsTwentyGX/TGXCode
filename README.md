# Claude Sessions

A Windows desktop app for the Claude Code sessions running in WSL2 on this
machine. It lists every session on disk, renders each one as a conversation with
formatted code, and lets you send new messages or start new sessions — and when
a session has a dev server up, one click switches
[DevBrowser](../dev-browser) to that port's tab.

Sessions running in a terminal show up here too and stream as they go: the app
reads the same transcripts Claude Code writes, so there is no separate world.

---

## How it fits together

```
   Windows                                  WSL2 (Ubuntu)
   ┌───────────────────┐                    ┌──────────────────────────────┐
   │ ClaudeSessions    │  HTTP + SSE        │ bridge  (node, no deps)      │
   │ .exe (Electron)   │ ─────────────────► │   • indexes ~/.claude        │
   │                   │  127.0.0.1:45888   │   • tails transcripts        │
   │ a window, and     │                    │   • runs `claude`            │
   │ nothing else      │                    │   • serves web/              │
   └───────────────────┘                    └──────────┬───────────────────┘
            │                                          │
            │ starts on launch (wsl.exe)               │ spawns
            └──────────────────────────────────────────┤
                                                       ▼
   ┌───────────────────┐                    ┌──────────────────────────────┐
   │ DevBrowser        │ ◄───────────────── │ claude -p --input-format     │
   │ 127.0.0.1:45777   │  open tab :5006    │        stream-json …         │
   └───────────────────┘                    └──────────────────────────────┘
```

The split matters. All the real work happens in the **bridge**, a dependency-free
Node process inside WSL: it reads `~/.claude/projects` at native speed, spawns
`claude` with the right environment, and serves the UI. The **Electron shell** is
about 200 lines that start the bridge and point a window at it.

Two things follow from that:

- **Editing `bridge/` or `web/` needs no rebuild.** Restart the app (or press
  Ctrl+R for UI-only changes). You only rerun `install.ps1` when `app/main.js`
  or `package.json` changes.
- **The UI works in any browser.** Run `npm run bridge` in WSL and open
  <http://127.0.0.1:45888>. Handy for iterating on the frontend.

This works because WSL runs with `networkingMode=mirrored` here, so `127.0.0.1`
is the same loopback on both sides — no port proxy, no firewall rule. It is the
same trick DevBrowser's control channel uses.

## Scripts

All of these run from WSL, in this directory.

| | |
|---|---|
| `npm start` | Launch the Windows app. It starts its own bridge on 45888. |
| `npm run restart` | Restart the everyday bridge so it picks up whatever is on main. Refuses while a turn is in flight; `-- --pull` fast-forwards from origin first, `-- --status` just reports. |
| `npm run dev` | A **separate** instance on 45899 plus its own window, for working on this app without disturbing the one you actually use. |
| `npm run dev:headless` | The same, bridge only — open the printed URL in a browser. The fastest loop for UI work: edit `web/`, hit refresh. |
| `npm run bridge` | The bridge in the foreground on 45888. This is the everyday instance; use `dev` instead unless you mean it. |
| `npm run build` | Build and install the app (calls `install.ps1` through PowerShell). Pass options after `--`, e.g. `npm run build -- -NoInstall`. |
| `npm run icon` | Regenerate `app/icon.ico`. |

There is deliberately no `node_modules` in this repo and `electron .` will not
work here: the shell is packaged from a staging directory on the Windows side,
and a Linux Electron is not the app you want anyway. `npm start` finds the built
executable instead, and tells you what to run if it is missing. (`npm run dist`
exists only for `install.ps1` to call inside that staging directory.)

## Install

From PowerShell, in this directory:

```powershell
.\install.ps1
```

or from WSL, `npm run build`.

It checks that WSL can find the bridge, stages the Electron shell into
`%LOCALAPPDATA%\ClaudeSessions-build`, packages it, and runs the installer.
Packaging happens Windows-side on purpose: electron-builder is slow and flaky
over the `\\wsl.localhost` share.

```powershell
.\install.ps1 -NoInstall     # build the installer but don't run it
.\install.ps1 -BridgeDir '~/Other/claude-sessions' -Distro Ubuntu
```

The script bakes the bridge location into `app/config.json`. To change it later
without rebuilding, edit `config.json` next to the installed executable, or
create one in `%APPDATA%\claude-sessions\`:

```json
{ "bridgeDir": "~/Other/claude-sessions", "distro": "Ubuntu" }
```

## Using it

| | |
|---|---|
| **Left rail** | Every session on disk, grouped by project. Worktrees fold under the checkout that owns them. A green dot means the transcript changed in the last 90 seconds — something is working. |
| **Ordering** | By when *you* last wrote, not by last activity. Sorting on activity meant a busy agent kept bumping its session to the top and shuffling the rest out from under the cursor. The timestamp on each row is the one it sorts by. |
| **Pin / archive** | Hover a row for its two buttons, or use the ones beside the session title. Pinned sessions sit in their own group at the top, across projects. Archived ones collapse into a group at the bottom. |
| **Conversation** | Your turns, Claude's replies with syntax-highlighted code, and one collapsible block per tool call. Edits render as diffs, and output too large to inline loads on demand. |
| **Subagents** | The first chip row under the title, one per subagent, with a light for how it is going and a line of what it is doing. Click to switch the pane over to it; `Esc` or the breadcrumb comes back. |
| **Dev servers** | The second chip row. Green means the port is answering right now; click to switch DevBrowser to that tab, starting DevBrowser if it isn't running. The button on the end shuts the server down — one click arms it, the next signals. |
| **Open folder** | The folder button by the title shows the session's working directory in Windows File Explorer, through the `\\wsl.localhost` share. |
| **Composer** | Sends to the session, resuming it in place — the same transcript a terminal would append to. |
| **Send queue** | Write while an agent is working and the message waits, listed above the composer in send order. Each one can be expanded, reordered, pulled back for editing, or dropped, right up until its turn starts. `Shift+Tab` out of the composer to work through them without the mouse. |

Shortcuts: `Ctrl+Enter` send, `Ctrl+K` filter, `Ctrl+N` new session, `Esc` leave
a subagent, `Ctrl+R` reload, `Ctrl+±` zoom, `F12` devtools.

In the send queue, `Shift+Tab` from the composer reaches the message you wrote
last, and from there: `↑`/`↓` pick, `Alt+↑`/`Alt+↓` move it, `Space` show it in
full, `Enter` take it back to the composer to reword, `Esc` drop it.

### Subagents are sessions too

Claude Code writes a subagent's conversation to its own file, next to the
transcript that spawned it:

```
<session-id>/subagents/agent-<id>.jsonl        the subagent's conversation
<session-id>/subagents/agent-<id>.meta.json    {agentType, description, toolUseId}
```

So a subagent gets the same treatment a session does — it is rendered by the
same code, and it streams while it runs. The chip row lists them in the order
they were spawned; clicking one switches the pane over to it and starts tailing
its file. Both panes stay mounted, so the session keeps streaming behind you and
neither loses its scroll position.

**Status comes from two places, because it has to.** Whether an agent is still
going is in the *parent* transcript — a `Task` call with no result yet is an
agent still running — and the app already has those events, so the light changes
the moment the call returns without asking the bridge anything. What the agent is
*doing* is only in the agent's own file, so the bridge tails the last 64KB of it
and reports the last thing that happened. That is the line on the chip.

The two together also catch the case neither can catch alone: a call with no
result whose file has not been touched in 90 seconds is not working, it is a
session that went away mid-call. The light stops pulsing and the chip says how
long it has been idle, rather than showing green for something that has stopped.

**A subagent finishing is not a turn you took.** Claude Code delivers that news
as a *user* message, because a conversation has no other channel — so left alone
it renders as though you had personally pasted a block of XML at yourself. It gets
its own event instead, showing the summary, what the run cost, and a way into the
transcript. The same entry is skipped when counting turns and when working out
when you last spoke, which matters more than it sounds: the rail sorts on that,
so an agent finishing would otherwise reorder your session list on its own.

These are recognised by the message *starting* with `<task-notification>` — or
with the `[SYSTEM NOTIFICATION - NOT USER INPUT]` preamble, which is addressed to
the agent when its prompt is assembled and does not reliably reach disk. Anchored
at the start rather than matched anywhere, because quoting one of these back into
a conversation is a thing people do, and a quote really is a turn you took.

Subagents don't take messages — the composer greys out while you are reading one.
A subagent that spawned its own subagents shows them inside its transcript, at
the `Task` call that spawned them, rather than flattening them into the session's
chip row where they did not happen.

### The send queue holds messages back on purpose

A turn takes minutes, and the next thing you want to say arrives long before it
ends. The CLI would accept several messages down its stdin at once — but the
moment one is written it is gone: it cannot be reordered, taken back, or even
looked at. That is why nothing was ever shown for it.

So the bridge keeps them instead. One message is in flight at a time; the rest sit
in `Runner.queue` until the turn that was holding them up lands, and only then is
the next one handed over. What you get for that is a queue you can actually work
with — expand a message, drag it earlier, pull it back into the box to reword, or
drop it — because until it is written, it is still yours.

The line the app will not cross is pretending. Once a message has gone to the
process it leaves the list, because it is on its way to the transcript and no
button here can recall it. Everything that stays visible is genuinely still
cancellable:

- **Reordering** is committed to the bridge on drop, and a message that flushed
  mid-drag keeps its place rather than dragging the rest of the queue with it.
- **Stop** drops the queue whichever way it ends the turn, soft interrupt or hard
  kill, since stopping means stopping — but the messages were never sent anywhere,
  so they come back to the composer instead of vanishing.
- **A process that dies** hands back everything it was holding, the turn it died
  on and the queue behind it, in the order you wrote them.
- **A model or permission change** replaces the process; the queue moves across,
  because those messages belong to you, not to the process.

Rows in the rail carry a `+N queued` badge, so a session you queued work for and
walked away from says so from the outside.

**One chip is one tab stop.** The obvious markup — a text button plus *Edit* plus
*×* on every row — puts `Shift+Tab` out of the composer on the drop button of the
last message, which is both surprising and the one control there you would least
like to hit blind. So the row itself is the focusable thing, its buttons are out
of the tab order, and everything they do has a key on the row: `Enter` to reword,
`Esc` to drop, `Space` to read it in full. The two you want mid-turn — *I said
that wrong* and *never mind* — are the unmodified keys. Dropping from the keyboard
moves the focus to the row that took the dropped one's place, or to the composer
if that was the last one, because focus falling to the body would leave the next
`Esc` closing something else entirely.

### The rail is sorted on load, and then left alone

The bridge returns sessions ordered by when *you* last wrote in them, and it
recomputes that whenever anything changes. The rail takes that order once, at
load, and then holds it: a session taking a message does not climb past its
neighbours, and it does not drag its project card to the top of the rail either.
Rows staying where you last saw them matters more than the list being perfectly
ordered at every instant — the alternative moves things out from under the
cursor while you are reading them. Reload to re-sort.

A session that appears *after* that first load is genuinely new rather than
merely busy, so it goes to the top of its group, and a project with no sessions
in it yet gets a new card at the top of the rail. Neither disturbs the position
of anything already placed.

### Archiving never deletes — deleting does

Archiving moves a session out of the way and nothing else. The transcript is
untouched, the session still opens and still answers, and a filter that matches
an archived session expands the group so the result is not silently hidden.
Pinning and archiving are mutually exclusive — asking for a session to sit at the
top *and* be tucked away is a contradiction, so each clears the other.

The trash icon, on a row or in the conversation header, is the one control that
does destroy something. It asks first, in a dialog that names the session and its
turn count, because the thing worth checking is *which* conversation. Confirming
removes the transcript and the sidecar directory beside it — the session's
subagent transcripts and any spilled tool output — and nothing else. A session
with a turn in flight is refused rather than deleted out from under the turn;
stop it first.

These flags are the only state this app owns; everything else it shows is derived
from Claude Code's own files, which it never writes to. They live in
`~/.local/share/claude-sessions/flags.json`, and flags for transcripts that no
longer exist are pruned automatically.

### Test sessions

A session can be marked **test**, which means only a development bridge lists it;
the everyday window on 45888 never shows it. Both instances read the same
transcripts, so this label is the only thing keeping an agent's scratch work out
of a list of real conversations.

The **Test session — dev only** checkbox in the Start a session dialog appears
only on a dev bridge. Over the API it is a field on create, or a flag afterwards:

```bash
curl -sX POST http://127.0.0.1:45899/api/sessions \
  -H 'X-Claude-Sessions-Client: 1' -H 'Content-Type: application/json' \
  -d '{"cwd":"/home/you/project","prompt":"…","test":true}'

curl -sX POST http://127.0.0.1:45899/api/sessions/$ID/flags \
  -H 'X-Claude-Sessions-Client: 1' -H 'Content-Type: application/json' \
  -d '{"test":true}'
```

Labelled sessions gather in a **Test sessions** card at the foot of the rail, so
the ones left behind are easy to find and delete. Delete them; the label is a way
to keep them out of sight until you do, not a substitute for cleaning up.

### The icon

`app/icon.ico` is generated by `npm run icon` — signed distance fields for the
shapes, a hand-rolled PNG encoder, and a PNG-in-ICO container, so the project
keeps its zero dependencies. Below 32px the caret inside the bubble is dropped;
at that size it is mud, and the silhouette is what identifies the app anyway. The
`.ico` is committed, so a normal build never regenerates it.

### Permissions

When Claude wants to run something the mode does not already cover, the turn
stops and a card appears at the foot of the transcript with the tool name and its
input rendered the way the tool block will render once it has run:

```
┌ Bash — permission needed ───────────────── 1:42 left ┐
│  rm -rf dist                                          │
│  [ Allow ]  [ Allow Bash all session ]  [ Deny ]      │
└───────────────────────────────────────────────────────┘
```

`Y`, `A` and `N` answer it from the keyboard; the card takes focus on arrival if
the window is focused. **Allow … all session** means this tool for this session
only — a permanent allowlist belongs in Claude Code's own settings, not here.

So the mode under the composer now decides how *often* you are asked, not what is
possible:

- **acceptEdits** (default) — file edits go through, most other tools ask.
- **auto** — Claude judges each call, which is the mode these sessions normally
  run in interactively.
- **manual** — asks about everything.
- **bypassPermissions** — everything runs, unasked. Convenient and unguarded;
  pick it deliberately.

Changing the mode takes effect on the next message.

Two things to know about the edges. A card nobody answers is **denied for you**
after two minutes — the countdown says when — because a blocked turn otherwise
holds a process open forever; and if no window is open at all, the ask is denied
immediately, which is what the app did before any of this existed. Two auto-denials
in a row stop the turn rather than let it spin.

Approvals ride a control channel on the same stream that carries the session, and
that channel is not a documented, stable surface. If the installed `claude` turns
out not to support it, the app says so once and falls back to permission modes
alone; sending never breaks over a protocol difference.

### How dev servers are found

A long session mentions dozens of ports, most of them history. The bridge scans
Bash traffic and ranks candidates by whether the port is **answering right now**,
whether the agent's last action was to start or kill it, and whether the name
DevBrowser has for it matches the session's worktree. That last signal is the
strongest — it is why naming ports pays off:

```bash
devbrowser title 5006 "add-company-flow"
```

Live ports are always offered; a couple of recently-dead ones are shown greyed
out so a server that has gone away is visible rather than silently missing.

### Stopping one

The chip's end button ends the server. Two clicks, because the chips are
identical in size and sit shoulder to shoulder — the first arms it and the chip
says `Stop?` where it said `Open`, the second signals. Moving off the chip, or
waiting four seconds, calls it off.

What gets signalled comes from the socket, not the transcript: `ss` says which
pids hold the port, they get a `SIGTERM`, and only if the port is still answering
2.5s later a `SIGKILL`. Signals go to those pids alone and never to their process
group, because a server started in the foreground of a Bash call shares a group
with the shell `claude` is waiting on.

Two things are never stopped this way, however they got hold of a port: another
**Claude Sessions bridge** — killing one takes its turns with it, since `claude`
reads the closed stdin as end-of-input — and a **`claude`** process, which *is* a
turn. Both are named and left alone. A port with no Linux process behind it says
so too: with WSL mirrored networking a Windows-side server answers on 127.0.0.1
but has no pid on this side, and the chip reports that rather than guessing.

## Layout

| Path | |
|---|---|
| `bridge/server.js` | HTTP + SSE, routing, static files |
| `bridge/sessions.js` | The session index — incremental, cached, watched |
| `bridge/transcript.js` | JSONL → render events; pairs tool calls with results; reads subagent transcripts |
| `bridge/runner.js` | `claude` processes, one per active conversation |
| `bridge/devservers.js` | Port detection and ranking |
| `bridge/devbrowser.js` | DevBrowser control client |
| `bridge/explorer.js` | Opens a WSL directory in File Explorer |
| `bridge/flags.js` | Pinned and archived state |
| `bridge/launch.sh` | Finds a node, then starts the bridge |
| `web/` | The UI. No build step, no dependencies |
| `app/main.js` | The Electron shell |
| `app/make-icon.js` | Generates `app/icon.ico` |

`launch.sh` exists because `wsl.exe bash -lc` runs a *login* shell, which reads
`~/.profile` but not `~/.bashrc` — and nvm installs itself in `~/.bashrc`. Node
is simply absent in that context, so every caller goes through the script that
knows where to look.

## Two instances

Port **45888** is the everyday app — the window you leave open with real
sessions in it. Port **45899** is for working on this codebase: `npm run dev`
starts a bridge there (or the next free port, so two agents can each have one)
and opens a window titled `dev :45899` with an amber badge, so the two are never
mistaken for each other. It refuses to bind 45888 at all.

Both read the same `~/.claude/projects`, so a session started in one appears in
the other — they are two views of the same transcripts. What is separate is the
*process*, and that is the point:

**Killing a bridge kills the turns running under it.** `claude` reads stdin for
its input, so when the bridge exits and that pipe closes, it treats it as
end-of-input and stops mid-turn. Running it detached with its output on a file
descriptor does not change that — both were tried and measured. There is no way
to make a turn outlive its bridge, so the only real protection is not killing
the bridge somebody is using. Hence two ports.

`pkill -f bridge/server.js` matches every bridge, including the everyday one.
To stop your own, Ctrl-C the `npm run dev` that started it, or kill it by port:

```bash
kill "$(ss -ltnp 2>/dev/null | grep :45899 | grep -oP 'pid=\K\d+' | head -1)"
```

### Picking up new code

The bridge runs whatever was on disk when it started, so it keeps running old
code until you restart it. Add this to `~/.bashrc`:

```bash
alias restart-bridge='bash ~/Other/claude-sessions/scripts/restart-bridge.sh'
```

Then `restart-bridge` from anywhere. It touches only the everyday port, refuses
while a turn is in flight (`--force` overrides), takes `--pull` to fast-forward
from origin first, and `--status` to just report what is running. Any open
window reconnects on its own.

## Working on this with agents

`.claude/settings.json` pins `worktree.baseRef` to `head`. The global default is
`fresh`, which branches a new worktree from `origin/<default-branch>` — and this
repo has no remote, so there is no `origin/master` to branch from. Pinning it to
the local HEAD avoids that whole question. Add a remote later and either setting
works.

Two other things that trip agents up here:

- **Start them in this directory.** `EnterWorktree` needs a git repository at the
  working directory. An agent launched in `~` reports "not in a git repository
  and no WorktreeCreate hooks are configured", which reads like a missing hook
  but is really just the wrong cwd. Nothing needs configuring — `cd` here first.
- **One build at a time.** `install.ps1` wipes and rebuilds its staging
  directory, so two agents packaging at once will pull the executable out from
  under each other.

## Notes and limits

- **Reasoning is usually blank.** Claude Code writes the signature of a thinking
  block but strips its text — across the 6,898 blocks on this machine only 29
  kept any. Newer sessions do keep it, and those render; older ones show nothing
  because there is nothing there.
- **Content comes from the transcript file, never from the process.** That is
  what makes a session running in your terminal look identical to one started
  here. The trade-off is that updates arrive per message rather than per token.
- **Stop asks first, then insists.** The first click interrupts the turn over the
  control channel: the process stays alive, nothing is left half-written, and the
  session is resumable. For a few seconds afterwards the button reads **Force
  stop**, which kills the process — the old behaviour, and still the thing to
  reach for when the polite path does not take. The status line says which one
  happened, because the outcomes differ.
- **The bridge outlives the window.** It is started detached so a long turn
  survives closing the app, and shuts down on exit only when nothing is running.
  A second launch reuses whatever is already listening on 45888.
- **One writer at a time.** Sending from here while the same session is mid-turn
  in a terminal would have two processes appending to one transcript. The rail
  flags active sessions; it does not stop you.
