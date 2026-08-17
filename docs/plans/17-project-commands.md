# 17 — Commands a project declares

**Effort:** M · **Depends on:** none · **Supersedes:** 13-A, 13-B ·
**Touches:** new `bridge/commands.js`, new `bridge/runs.js`, new `bridge/ports.js`,
`bridge/terminal.js`, `bridge/config.js`, `bridge/server.js`, `web/terminal.js`,
`web/app.js`, `web/index.html`, `web/styles.css`, `scripts/dev.js`,
`test/refusals.test.js`

> Built.

## Why

Every project has two or three commands you run constantly — `npm run dev` above
all — and the only way to run one from this app was to open the terminal pane and
type it. That is fine once. It is not fine when LTCDataPlus has four worktrees
live, each wanting its own dev server on its own free port, each wanting a
DevBrowser tab named for the branch rather than a bare number.

`devservers.js` already does the *archaeology* — it scans a transcript's Bash
traffic for ports (`detect`, devservers.js:43) and can stop what holds one
(`stop`, devservers.js:306). What it cannot do is start anything, because it has
never known what command to run.

Plan 13-A's answer was to re-run the string scraped out of the transcript, and
13's own Risks section admits what that string is: "long, chained, or
environment-dependent". A project saying what its commands are is strictly
better, so 13-A should be dropped rather than built and 13-B's log tail is
superseded — a log keys on a run, not on a port, because ports get reused across
worktrees. 13's stop half already shipped and stays: it is the right tool for a
server this app did not start. 13-C's naming chain is reused verbatim.

## Design

### A. The declaration

`.tgxcode/commands.json`, checked in, plus `.tgxcode/commands.local.json`,
gitignored. Merged by `id`.

```json
{ "version": 1, "commands": [{
    "id": "dev", "label": "Dev server", "run": "npm run dev",
    "port": { "range": [5000, 5099], "env": "PORT" },
    "devbrowser": "${worktree}"
}]}
```

Five placeholders, no more: `${port}`, `${cwd}`, `${project}`, `${worktree}`,
`${branch}`. An unknown one is a validation error against that command rather
than a silent empty string — a typo should be findable, not invisible.

**Where the two files are read from is asymmetric, and that is the whole trick.**
A worktree is a checkout of the same repo, so it has its own `commands.json` —
possibly a branch's newer one, which should work. It never has the gitignored
local file, because that file was never committed. So the shared file comes from
the directory you are running in, and the personal one from the main checkout,
and your overrides follow you into every worktree of it.

Failure has two levels on purpose. A file that will not parse contributes nothing
and reports once; it does **not** quietly fall back to the other file, because a
typo in your local overrides must not silently restore everyone's defaults. A
single bad *command* is dropped and its siblings survive.

### B. A run is a terminal with a different first command

`bridge/runs.js` composes `Terminal` from `terminal.js` rather than reimplementing
it. Not thrift — it is the only way the output reads correctly. Vite, Next,
webpack and dotnet-watch all repaint a status line with `\r` and cursor moves,
which in a `<pre>` is an unreadable smear, and most of them fall back to a duller
mode the moment they find stdout is a pipe. Under a pty and xterm it renders as
the tool intended, and the process-group teardown, the scrollback replay and the
SSE byte pipe all come free.

`terminal.js` gained four options, each defaulting to today's behaviour: an
injectable command (`exec /bin/bash -i -c '<cmd>'` in place of `exec $SHELL -i`),
extra `env`, a `logFile` to tee to, and an `onExit` callback. `-i` is load-bearing
in both forms: nvm and `~/.local/bin` come from `~/.bashrc`, so `npm run dev`
without it fails with `node: not found`.

`TerminalPool` is **not** reused. It keys on `sessionId`, its `MAX_TERMINALS`
budget would let four dev servers starve the shells, and its `open()` quietly
returns the existing terminal where a start button must refuse. `RunPool` keys on
`(workspace, commandId)`, caps separately at `MAX_RUNS`, and has no idle rule at
all — a dev server nobody is watching is the feature working. It reaps only
records of runs that ended half a day ago.

### C. Ports

`bridge/ports.js`. `isFree` is a bind test **and** a connect probe: the bind
answers the question actually being asked, but WSL's mirrored networking means a
Windows-side server answers on 127.0.0.1 while holding no Linux socket, and
devservers.js:257 already documents that asymmetry from the other side. Bind
first and short-circuit, since a port held by a Linux process is the common case
and answers instantly.

The reservation covers the seconds between the bind test closing its socket and
the child calling `bind()` — bash reading `.bashrc`, nvm resolving, npm starting.
`observe()` turns it into a permanent hold once the child is really listening.

It only binds *this* bridge, so the everyday and development instances can still
collide. Nothing retries: the failure is already legible — the log says the
address is in use, the button goes red, and clicking again gets a different port
because the failed one was released on exit. Machinery to paper over that would
be harder to trust than the message.

`scripts/dev.js` now picks its port through this. `test/run.js` deliberately does
not: `listen(0)` is different and better for what it does, and a test harness
should not depend on the module the suite exercises.

### D. Naming, and when

The DevBrowser title is set the moment the port is first observed listening —
never at start, because a name on a port nothing answers on is exactly the stale
title 13-C is about. Cleared on exit, and only if the port has actually gone, so
a quick restart does not wipe its own new name. Never `openTab`: that launches
DevBrowser, and starting a dev server must not open a window.

With DevBrowser closed there is simply nothing to name, and that is the right
outcome rather than a gap: `/api/devbrowser/open` already sets a title on the way
in when the chip is eventually clicked.

### E. Where the buttons are

The conversation header, acting on `state.current.cwd` — the workspace the
session is actually in, so a worktree session gets that worktree's dev server.
The output goes in the existing terminal pane, which gained a tab strip: the
shell, then one tab per run. One xterm, re-attached on switch; the bridge replays
scrollback on attach, so switching back redraws correctly and there is no second
pane, second height to remember, or second emulator in memory.

The pane stays **writable** for a run. Read-only would cost work and buy no
boundary — the route is refused remotely either way — and it would throw away
vite's `r`, jest's watch keys, and Ctrl-C as a gentler stop than SIGHUP.

### F. Runs die with their bridge

Not a limitation to route around. The child's stdout is a pipe whose only reader
is the bridge; when it exits the child fills the buffer and blocks on `write()`
forever, still holding the port. A run that survived would be a run that hung,
and re-adoption by pid cannot help — the new bridge can acquire neither the pipe
nor the pty. So they are killed on the way out, `state: 'stopping'` is broadcast
before the kill so an open window shows a reason, and the pane says so out loud.

Which is also why nothing is persisted: no `runs.json`, no adoption. Only the
logs outlive the process, so a run that ended two minutes ago is still readable.

### G. Archiving stops them

Archiving is how you say you are done with a piece of work, and a dev server for
a branch nobody is looking at any more is exactly the thing that holds a port for
a week. But runs are keyed by directory and several sessions share a worktree
routinely, so archiving one of three would pull the server out from under the
other two. The last one out turns the lights off — `archiveStoppedRuns` in
server.js checks for another unarchived session in the same directory first.

## Risks

- **A file in a repository now has a path to execution.** The capability is not
  new: an API caller can already start a session in `bypassPermissions`, or open
  a terminal. What is new is that whoever wrote the commit decides what a
  familiar button does. This is the same trust model as `package.json` scripts, a
  Makefile or `.vscode/tasks.json`, all of which get run by hand here daily, and
  the decision is to trust the file and make it visible: the resolved command is
  on the button's tooltip and at the head of the pane, and nothing ever
  auto-runs. No approval flow, no remembered hashes.
- **What does earn a guard**: `cfg.withinRoots` before any read or run, without
  which `?cwd=` is a file-read primitive; containment of a command's relative
  `cwd` inside its workspace; caps of 64KB, 24 commands and 2000 characters; the
  same env hygiene terminals have; `0600` on log files, because a dev server
  prints tokens. And one accident-catcher: the only thing making the local file
  personal is a line in `.gitignore`, so when it is not ignored the UI says so.
- **What would be theatre**: allowlisting binaries (any list permitting `npm`
  permits arbitrary code, and implies what passed was vetted); arg-array-only
  execution (breaks `a && b`, breaks mid-argument `${port}`, and loses the
  `bash -i` that puts node on PATH); sandboxing or a timeout on something that is
  supposed to run indefinitely; requiring the file to be committed, which fails
  exactly while you are setting it up.
- **Log growth.** 8MB a run, one rotation, swept at seven days.

## Acceptance

- ✅ A project declaring `npm run dev` with a port range gets a button; clicking
  it finds a free port, runs the command in the session's directory, and turns
  green with the port when the server answers.
- ✅ Two commands in the same range get different ports, and both really listen.
- ✅ The DevBrowser tab is named from the command's `devbrowser` field, on
  listening rather than on start, and the name is given back on exit.
- ✅ A local file overrides one field of a shared command without restating it,
  and `disabled` hides one.
- ✅ A malformed file shows the parser's message and leaves the other file's
  commands working.
- ✅ Stopping says "stopped"; falling over says how.
- ✅ Killing the bridge takes every run with it and orphans no ports.
- ✅ Archiving the last session in a directory stops its runs; archiving one of
  several does not.
- ✅ A remote caller may read what a project declares and may not run it.
