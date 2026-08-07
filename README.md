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

## Install

From PowerShell, in this directory:

```powershell
.\install.ps1
```

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
| **Pin / archive** | Hover a row for its two buttons, or use the ones beside the session title. Pinned sessions sit in their own group at the top, across projects. Archived ones collapse into a group at the bottom. |
| **Conversation** | Your turns, Claude's replies with syntax-highlighted code, and one collapsible block per tool call. Edits render as diffs, subagents expand inline, and output too large to inline loads on demand. |
| **Dev servers** | The chips under the title. Green means the port is answering right now; click to switch DevBrowser to that tab, starting DevBrowser if it isn't running. |
| **Open folder** | The folder button by the title shows the session's working directory in Windows File Explorer, through the `\\wsl.localhost` share. |
| **Composer** | Sends to the session, resuming it in place — the same transcript a terminal would append to. |

Shortcuts: `Ctrl+Enter` send, `Ctrl+K` filter, `Ctrl+N` new session, `Ctrl+R`
reload, `Ctrl+±` zoom, `F12` devtools.

### Archiving never deletes

Archiving moves a session out of the way and nothing else. The transcript is
untouched, the session still opens and still answers, and a filter that matches
an archived session expands the group so the result is not silently hidden.
Pinning and archiving are mutually exclusive — asking for a session to sit at the
top *and* be tucked away is a contradiction, so each clears the other.

These two flags are the only state this app owns; everything else it shows is
derived from Claude Code's own files, which it never writes to. They live in
`~/.local/share/claude-sessions/flags.json`, and flags for transcripts that no
longer exist are pruned automatically.

### The icon

`app/icon.ico` is generated by `npm run icon` — signed distance fields for the
shapes, a hand-rolled PNG encoder, and a PNG-in-ICO container, so the project
keeps its zero dependencies. Below 32px the caret inside the bubble is dropped;
at that size it is mud, and the silhouette is what identifies the app anyway. The
`.ico` is committed, so a normal build never regenerates it.

### Permissions

Headless Claude never blocks on a permission prompt — it denies the tool call and
carries on. So the mode you pick under the composer decides what a session can
actually do:

- **acceptEdits** (default) — file edits go through, most other tools prompt, and
  prompting means denied.
- **auto** — Claude judges each call, which is the mode these sessions normally
  run in interactively.
- **bypassPermissions** — everything runs. Convenient and unguarded; pick it
  deliberately.

When a call is denied the transcript shows a "Permission needed" notice saying
so, rather than leaving you to wonder why Claude stopped short. Changing the mode
takes effect on the next message.

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

## Layout

| Path | |
|---|---|
| `bridge/server.js` | HTTP + SSE, routing, static files |
| `bridge/sessions.js` | The session index — incremental, cached, watched |
| `bridge/transcript.js` | JSONL → render events; pairs tool calls with results |
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

## Notes and limits

- **Reasoning is usually blank.** Claude Code writes the signature of a thinking
  block but strips its text — across the 6,898 blocks on this machine only 29
  kept any. Newer sessions do keep it, and those render; older ones show nothing
  because there is nothing there.
- **Content comes from the transcript file, never from the process.** That is
  what makes a session running in your terminal look identical to one started
  here. The trade-off is that updates arrive per message rather than per token.
- **Stop ends the process.** There is no mid-turn interrupt on the headless
  channel. Whatever was written stays in the transcript and the session resumes
  cleanly on the next message.
- **The bridge outlives the window.** It is started detached so a long turn
  survives closing the app, and shuts down on exit only when nothing is running.
  A second launch reuses whatever is already listening on 45888.
- **One writer at a time.** Sending from here while the same session is mid-turn
  in a terminal would have two processes appending to one transcript. The rail
  flags active sessions; it does not stop you.
