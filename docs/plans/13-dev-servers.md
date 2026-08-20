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

> **Superseded by 17, except for stop.** A project declaring its commands in
> `.tgxcode/` is strictly better than re-running a string scraped out of Bash
> traffic — see the Risks below, which say as much. Do not build the start half.
> Stop already shipped and stays: it works from the socket rather than the
> transcript, so it is the right tool for a server this app did not start.

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
- **Stop** — *done.* `devservers.stop()` resolves the owner via `ss -ltnp`,
  SIGTERMs those pids and escalates to SIGKILL only if the port still answers;
  the chip arms on the first click and shows the pid and command line in its
  tooltip (`/api/devservers/owner`) before the second one signals. `PORT_DENYLIST`
  gates the endpoint, and a process whose command line is a bridge or a `claude`
  is named and refused — killing either takes a turn down with it.
- Never auto-start anything. The agent starts servers; the app offers to
  restart one you can see.

### B. Log tail

> **Superseded by 17.** A run's log keys on the run, not on the port: ports get
> reused across worktrees, so `<port>.log` would interleave two projects. It is
> `~/.cache/claude-sessions/runs/<runId>.log`, and the pane that reads it is the
> terminal pane with a tab strip rather than a panel of its own.

A server started by the app writes to
`~/.cache/claude-sessions/devservers/<port>.log`. The chip menu opens a tail
panel — the same event-stream plumbing as the transcript tail, pointed at a log
file.

For servers the app did *not* start there is no log to read. Say so plainly
rather than showing an empty panel.

### B2. Whose port is it — settled

> **Built.** Not in the original plan, because the original plan did not realise
> attribution was the problem.

Everything above assumes the chips on a session are that session's ports. They
were not. `enrich` ended in `ranked.filter(p => p.listening)`, so *any* port a
transcript mentioned became a live chip the moment anything on the machine
answered on it — and the ranking above it never gated the list at all. A
`curl localhost:5001` in one worktree lit up green because another worktree's
vite was on 5001. No amount of scoring fixes that, because "is it listening" is a
fact about the machine and the score is a fact about a conversation.

The kernel knows the answer: `ss` gives the pid holding a port, `/proc/<pid>/cwd`
gives its directory, and `workspaceOf()` turns that into a worktree or checkout.
A port belongs to the workspace its process is in. Sessions elsewhere do not see
it, whatever their transcript says.

Ancestry — walk the holder's parents until you reach the session's `claude` —
looks like the better answer and is not: a backgrounded dev server is reparented
to init the moment its launching shell exits. Measured on this machine, every
agent-started server had systemd as its ancestor and not one was traceable.

Two things the kernel cannot settle, and what they fall back to:

- **No Linux pid** — a Windows-side server on the mirror. Falls back to this
  session's own transcript, and only its strong end, marked `unverified`.
- **A dead port** — nothing holds it. Kept only on strong own-transcript
  evidence *and* only if DevBrowser's name for it is not another worktree's.
  That last rule exists because `pgrep -f "vite dev --port 5002"` reads as a
  start command to any regex looking for one.

Ports held by a bridge or a `claude` are dropped outright. The everyday instance
runs in the main checkout, so a session there was being offered a green chip —
and a stop button — for the app it was being displayed in.

### B3. Which port does it get — settled

> **Built.** Also not in the original plan, and for the same reason: allocation
> looked like a solved problem because `isFree()` was never wrong about a socket.

A dev server for one worktree came up on the port another worktree's had, and
took its DevBrowser tab with it. The reconstruction, from the run records and
both transcripts:

| | |
|---|---|
| 09:58 | the app starts `Dev server (PROD DB)` for `training-video-scripts` on **5001** |
| 10:21 | that worktree's agent kills the run and restarts vite itself in the background, then titles the tab `training-videos (PROD DB)` |
| ~10:30 | the agent's background server dies with its session |
| 10:35 | the app starts the same command for `bank-accounts`, is handed **5001**, and re-titles the tab |

At 10:35 the port was genuinely free — no `EADDRINUSE`, and vite's `--strictPort`
never fired. The socket test was right. What was wrong was everything around it:

- **First-fit from the bottom of the range, with no memory.** Every worktree of a
  project scans from the same low port, so whichever server restarts next takes
  it. `titles.json` had the other half of the fingerprint: 5001 *and* 5002 both
  named `PROD bank-accounts`, because that run had been on 5002, restarted, hopped
  down, and orphaned its own tab on the way.
- **Free is not the same as unclaimed.** A tab named for another worktree, a run
  record from one, and the port memory of the other bridge are all evidence that
  a free port is somebody's. None of it was consulted.

So `allocate()` now takes `prefer` (tried first, in order) and `avoid` (used only
when the alternative is refusing to start), and remembers key → port in
`STATE_DIR/ports.json` — one file shared with the other bridge on purpose, since
that is the only thing that stops two instances homing onto the same port.
`runs.js` supplies the policy, because the claims are about workspaces and tabs:
its own remembered port first, then a tab already carrying this command's name
(which is what survives losing the memory file); against it, other keys'
remembered ports, other workspaces' run records, and tabs named for anything
else. A tab name is deliberately the softer evidence of the two — anyone can set
one from a shell — so it makes a port a last resort but cannot hand over one a
record of allocation already claims. When a command does move ports, the title it
left behind is cleared, provided it is still its own name and nothing is
listening there.

One real hole turned up underneath all this, measured rather than reasoned: a
listener bound to `::1` alone passed both tests. `bindable()` on the wildcard
succeeds next to it and 127.0.0.1 answers nothing, so the port read as free and
would have been handed out from under a running server. `isFree()` now also
consults the kernel's listen table — one `ss` sweep per `allocate()`, which sees
every local socket whatever it is bound to — and probes `::1` as well as
127.0.0.1. `test/ports.test.js` holds a `::1` port and demands it be skipped.

What is still not closed: two bridges can pick the same port in the same moment.
The shared memory file narrows it; only a lock would close it, and the failure is
already loud — the log says the address is in use, the button goes red, and
clicking again gets a different port.

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
- ✅ Stopping a server shows which pid and command will be killed before doing it.
- A server started by a worktree session gets a DevBrowser tab named for the
  worktree.
