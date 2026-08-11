# 13 — Dev servers: act on them, don't just find them

**Effort:** M · **Depends on:** none · **Touches:** `bridge/devservers.js`,
`bridge/devbrowser.js`, `bridge/server.js`, `web/app.js`

## Why

`devservers.js` does real work: it scans Bash traffic for ports, ranks
candidates by whether the port answers now, whether the agent's last action was
to start or kill it, and whether DevBrowser's name for the port matches the
session's worktree. The result is a row of chips that can do exactly one thing —
switch DevBrowser to that tab (`openInDevBrowser`, `app.js:793`).

Everything else about a dev server still happens in a terminal, including the
most common thing: it died and needs restarting.

## Design

### A. Restart, stop, start

The chip gains a menu. The command is not guessed — `devservers.js` already
captures the evidence that identified the port, and the chip already shows it in
a tooltip (`app.js:781`):

```js
title: p.evidence ? `${p.evidence.from}: ${p.evidence.command}` : ''
```

So "restart" means: re-run *that command*, in the session's cwd.

- **Start / restart** — `POST /api/sessions/:id/devservers/:port/start`, running
  the recorded command detached with output to a log file, the same
  `setsid nohup … &` pattern `app/main.js` uses to launch the bridge without a
  console.
- **Stop** — find the listener and terminate it. Resolve owner via
  `ss -ltnp` / `/proc/net/tcp` rather than a blind `fuser -k`, and **confirm
  before killing**, showing the pid and command line. Killing the wrong process
  because a port was reused is exactly the failure the config's `PORT_DENYLIST`
  exists to avoid elsewhere.
- Never auto-start anything. The agent starts servers; the app offers to
  restart one you can see.

### B. Log tail

A server started by the app writes to
`~/.cache/claude-sessions/devservers/<port>.log`. The chip menu opens a tail
panel — the same event-stream plumbing as the transcript tail, pointed at a log
file.

For servers the app did *not* start there is no log to read. Say so plainly
rather than showing an empty panel.

### C. Naming, taken seriously

The machine notes for this box are emphatic that DevBrowser tabs are identified
by port alone, so unnamed servers are a wall of numbers, and that names should
lead with what distinguishes the server — worktree, branch, purpose — not the
project.

The app already half-does this: `/api/devbrowser/open` sets a title on the way
in when the transcript knew one (`server.js:346-348`). Finish it:

- When a session starts a server and the app notices a new live port, set the
  DevBrowser title from the **worktree name**, falling back to branch, then
  project. That is exactly the ordering those notes ask for.
- Re-title on every open, since ports get reused across worktrees and a stale
  name is worse than none — `devbrowser title` overwrites, so there is no need
  to check first.
- Clear the title when a port has been dead for a while
  (`devbrowser title <port> --clear`).
- Show the current title on the chip, editable inline.

### D. Health beyond "is it listening"

`listening` is a TCP connect. A server that is up but returning 500 looks
healthy. Optionally fetch `/` and show the status code — behind a setting, since
hitting an app's root on a timer is not always harmless.

## Risks

- **Re-running a captured command.** The recorded command is whatever appeared
  in a Bash call, which could be long, chained, or environment-dependent. Show
  it in the confirmation and let it be edited before it runs. Never run it
  through a shell without showing the user the exact string first.
- **Zombie servers.** A restarted server the app owns should be killed when? Not
  on window close — the bridge deliberately outlives the window. Leave it
  running and list owned servers in the info panel.

## Acceptance

- A dev server killed by the agent can be restarted from its chip with the same
  command, and the chip goes green.
- Stopping a server shows which pid and command will be killed before doing it.
- A server started by a worktree session gets a DevBrowser tab named for the
  worktree.
