# 04 — Liveness from the session registry, and the live-elsewhere lock

**Effort:** S–M · **Depends on:** none · **Touches:** new
`bridge/registry.js`, `bridge/sessions.js`, `bridge/server.js`, `web/app.js`

The cheapest high-value plan here. It is pure reading, it deletes a heuristic,
and it closes the one correctness hole the README admits to.

## Why

Two problems, one cause: the app guesses at liveness.

**Guessing.** `sessions.js:220` decides a session is live by file mtime:

```js
active: (now - rec.mtimeMs) < ACTIVE_WINDOW_MS,   // 90s
```

That is wrong in both directions. A session thinking hard for two minutes
without writing looks dead. A session that finished 80 seconds ago looks alive.

**The hole.** From the README:

> **One writer at a time.** Sending from here while the same session is mid-turn
> in a terminal would have two processes appending to one transcript. The rail
> flags active sessions; it does not stop you.

Today the failure is caught *after* the fact: `claude` refuses to resume,
`classifyError` (`runner.js:303`) recognises the message, and
`handleSendFailure` (`web/app.js:1082`) offers to branch. That recovery is good
work — but it fires after the user has already sent, and it depends on matching
an error string that could change.

## The finding

Claude Code maintains a registry we are not reading:

```
~/.claude/sessions/<pid>.json
```

One file per running session. Observed contents:

```json
{
  "pid": 524875,
  "sessionId": "8df08a77-dbf8-4baa-afd1-601bfef4004d",
  "cwd": "/home/dylan_hays/TableGX",
  "startedAt": 1784218349406,
  "procStart": "26187268",
  "version": "2.1.211",
  "peerProtocol": 1,
  "kind": "bg",
  "entrypoint": "cli",
  "name": "playground dev server",
  "agent": "claude",
  "jobId": "8df08a77",
  "status": "idle",
  "updatedAt": 1784218350156,
  "statusUpdatedAt": 1784218349842,
  "bridgeSessionId": "session_01UYo..."
}
```

That is: **which sessions are running, under which pid, in what state, started
how.** Exactly the question the mtime window was approximating.

Note `procStart` — a process start-time token. It exists so a recycled pid can
be told from the original. Use it; do not trust pid alone.

## Design

### `bridge/registry.js`

```js
class SessionRegistry extends EventEmitter {
    // sessionId -> {pid, status, kind, entrypoint, name, cwd, startedAt, updatedAt, alive}
}
```

- Read the directory on start; `fs.watch` it, same pattern as
  `SessionIndex._watch` (`sessions.js:111`), plus a slow poll as the safety net.
- **Verify liveness independently.** A crashed session leaves its file behind.
  Confirm with `process.kill(pid, 0)` and, where available, cross-check
  `/proc/<pid>` start time against `procStart`. A file whose process is gone is
  stale — report it as such, never delete it (constraint 2: not our file).
- Treat every field as optional. This is an internal format that can change
  between Claude Code versions; a missing or renamed field must degrade to
  "unknown", never throw.

### Wiring

- `SessionIndex._summary` gains `live: {running, pid, status, kind, entrypoint,
  isOurs}`, where `isOurs` is `pool.get(sessionId) !== null`.
- Keep `active` (the mtime bit) as a **separate** field. It still answers a
  different question — "did the file change recently" — which is what you want
  for a session running under a Claude Code version that doesn't write a
  registry entry. Registry when present, mtime when absent.
- Broadcast `sessions-changed` on registry changes so the rail updates without
  a poll.

### UI

**Rail.** Three states, not two: `running-here` (our runner), `running-elsewhere`
(registry says yes, not ours), `idle`. Give `running-elsewhere` a visibly
different marker — a hollow dot to the filled one — with a tooltip naming the
entrypoint (`cli`, `bg`, `vscode`) and pid.

**Composer lock.** When the open session is `running-elsewhere`, replace the
send button with the branch path *before* anything is sent:

```
This session is running in a terminal (pid 524875).
[ Branch off a copy ]      [ Send anyway ]
```

- "Branch off a copy" calls the existing `sendMessage({fork: true})` — already
  implemented and tested by the error path.
- "Send anyway" is kept because the registry can be wrong (stale file, exotic
  setup) and being locked out by a bad guess is worse than the risk. It warns
  once, then behaves exactly as today, error recovery included.

**Keep the existing recovery path.** This plan reduces how often
`busy-elsewhere` fires; it does not replace it. The error handling in
`runner.js:303` and `app.js:1082` stays as the backstop.

### Bonus, nearly free

- `name` in the registry is a human label Claude Code already knows — use it as
  a title source when the transcript has none.
- `kind: "bg"` identifies background agents, worth a badge in the rail.
- The dashboard (plan 06) and the tray menu (plan 02) both want exactly this
  data. Build it once here.

## Risks

- **Format drift.** Mitigated by treating all fields as optional and by keeping
  the mtime fallback. Add a startup log line when the registry directory exists
  but nothing parses, so the failure is visible rather than silent.
- **Pid reuse.** Handled by `procStart`; without it, fall back to mtime.
- **WSL vs Windows pids.** The registry is written inside WSL and the bridge runs
  inside WSL, so `process.kill` is checking the right namespace. Do not move this
  check to the Electron side.

## Acceptance

- A session running in a terminal shows as running-elsewhere within ~1s of
  starting, without any transcript write.
- A session thinking silently for 3 minutes stays marked running.
- Killing a terminal session with `kill -9` leaves a stale registry file, and
  the rail still shows the session as not running.
- Opening a session that is live elsewhere shows the branch affordance before
  the user can send into it.
