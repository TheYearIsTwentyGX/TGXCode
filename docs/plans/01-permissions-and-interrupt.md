# 01 — Permission prompts and real interrupt

**Effort:** L · **Depends on:** none (pairs well with 04) · **Touches:**
`bridge/runner.js`, `bridge/server.js`, `web/app.js`, `web/index.html`

Both features are one piece of work because both need the same thing: the
stream-json channel used **bidirectionally**, with correlated request/response
messages rather than one-way parsing.

## Why

From the README:

> Headless Claude never blocks on a permission prompt — it denies the tool call
> and carries on.

So the mode picker under the composer is really a choice between *file edits
only* and *no guardrails at all*. `acceptEdits` silently loses Bash calls;
`bypassPermissions` runs everything. Neither is what you'd pick interactively,
which is why the README has to explain the trap instead of the feature.

Interrupt has the same shape of problem. `Runner.stop()` (`bridge/runner.js:168`)
SIGTERMs the process, waits 1500ms, then SIGKILLs. The transcript survives, but
the turn dies mid-tool-call, and there is no way to say "finish this call, then
stop."

## What exists today

- `runner.js:69-80` builds args including `--permission-mode`.
- `runner.js:202-271` `_onMessage` handles `system`, `assistant`, `user`,
  `result`, `rate_limit_event`. It only ever *reads*.
- `runner.js:147-161` `_flushQueue` is the only writer to stdin, and it writes
  exactly one message shape: a user turn.
- `runner.js:215-220` already surfaces `system/permission_denied` as a notice,
  and `transcript.js:449` renders it in the log. That is the "you were denied"
  path we want to replace with an "approve or deny" path.

## Design

### 1. A control channel in the runner

Add request/response plumbing alongside the existing user-turn writer.

```js
// runner.js
_control(subtype, payload) {          // outbound request, resolves on response
    const id = `req_${++this._ctlSeq}`;
    const p = new Promise((res, rej) => this._pending.set(id, { res, rej }));
    this._write({ type: 'control_request', request_id: id,
                  request: { subtype, ...payload } });
    return p;
}
```

and in `_onMessage`, two new cases:

- `control_response` — resolve the promise in `this._pending` keyed by
  `request_id`.
- `control_request` — an *inbound* request from the CLI. This is the permission
  ask. Do not answer it in the runner; emit it and let the UI decide.

**Verify the exact subtype names against the installed CLI before building.**
`claude --help` does not document them and they are version-coupled. Probe with
a throwaway session and log every non-content line; the app already has the
right tool for this (`bridge/launch.sh` + a `--verbose` stream). Design the code
so an unrecognised subtype is logged and ignored rather than fatal.

Two possible mechanisms for the ask, in preference order:

1. **`can_use_tool` control request.** If the CLI emits one, answer it with a
   `control_response` carrying allow/deny and optionally updated input.
2. **`--permission-prompt-tool`.** Point it at an MCP tool the bridge serves;
   the CLI calls that tool to ask. More moving parts (the bridge becomes an MCP
   server) but it is the documented seam.

Pick whichever the installed version actually supports. The UI contract below is
identical either way, which is the point of putting the decision behind an
event.

### 2. Pending-approval state

A permission ask is a *blocking* piece of session state, so it belongs next to
the runner's other liveness state, not in the transcript.

```js
// Runner
this.pendingPermission = null;  // {id, tool, input, suggestions, askedAt}
```

- Set it, `_setState('busy', `Waiting for you: ${tool}`)`, and
  `emit('permission-request', {...})`.
- `pool` re-emits; `server.js` broadcasts a new SSE event `permission-request`.
- New endpoint `POST /api/sessions/:id/permission` with
  `{requestId, decision: 'allow'|'allow-always'|'deny', updatedInput?}`.
- Resolve, clear, return to `busy`.

**Timeout.** A pending ask with no UI attached hangs the turn forever. If no
client is subscribed to that session, or nothing answers within N seconds
(default 120, configurable), auto-deny with a reason and record it. Surface the
countdown in the UI so the auto-deny is never a surprise.

### 3. UI

Render the ask **inline in the transcript, at the bottom**, not as a toast — it
is a blocking decision and toasts are dismissible. A card styled like a tool
block, using the existing `renderTool` vocabulary so the tool name and input
render exactly as they will once approved:

```
┌ Bash — permission needed ───────────────── 1:42 left ┐
│  rm -rf dist                                          │
│  [ Allow ]  [ Allow Bash all session ]  [ Deny ]      │
└───────────────────────────────────────────────────────┘
```

- `Allow always` scope is **this session, this tool name** — not global. A
  global allowlist belongs in Claude Code's own settings, not here.
- Keyboard: `Y` / `A` / `N` when the card is focused, and it takes focus on
  arrival if the window is focused.
- If the window is *not* focused, this is the single best notification trigger
  in the app — see plan 02.
- The card is replaced by the ordinary tool block once the transcript catches
  up, since the real record comes from the file.

### 4. Interrupt

With the control channel in place, `stop()` gains a soft path:

```js
async stop({ hard = false } = {}) {
    if (!hard && this._supportsInterrupt) {
        try { await this._control('interrupt', {}); return true; } catch { /* fall through */ }
    }
    ...existing SIGTERM/SIGKILL...
}
```

UI: the Stop button becomes "Stop" (soft) with a hold-to-force or a second
click within ~3s escalating to "Force stop". Show which happened, because the
consequences differ — a soft stop leaves a resumable session, a kill may leave a
half-written tool result.

## Risks

- **Version coupling.** The control protocol is not a documented stable surface.
  Mitigate: feature-detect at startup by probing once and caching the result in
  `pool`; fall back to today's behaviour with a one-time notice
  ("This Claude Code version does not support approval prompts here — using
  permission mode only"). Never let a protocol mismatch break sending.
- **Two clients, one ask.** If two browsers are open, both see the card. First
  answer wins; broadcast a `permission-resolved` event so the other card
  collapses with "answered elsewhere".
- **Auto-deny loops.** A session that gets auto-denied repeatedly will spin.
  After two consecutive auto-denies, stop the turn and say so.

## Acceptance

- With mode `auto` and no UI attached, behaviour is unchanged from today.
- With the app open, a Bash call in `auto` mode produces a card; approving runs
  the command and the transcript shows the result.
- Denying produces the same `permission_denied` system entry a denial produces
  today.
- Stop mid-`Bash` with the soft path leaves the session resumable and the
  transcript coherent.
- Killing the bridge with an ask pending does not corrupt anything; the session
  resumes cleanly.
