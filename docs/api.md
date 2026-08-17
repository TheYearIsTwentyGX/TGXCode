# The bridge API

What a client needs to know to talk to the bridge. `web/app.js` (desktop) and
`web/mobile.js` (phone) are both clients of this; a native Android app will be a
third, and this document exists so that it is a *client* rather than a rewrite.

Anything a client needs and cannot get from here is a gap in the API, and belongs
fixed here rather than worked around in the client.

## The invariant that shapes everything

**Content comes from the transcript, never from the process.**

The bridge drives `claude` over stdio, but it never renders what comes back. Every
message, tool call and result a client displays is re-read from Claude Code's own
`.jsonl` transcript on disk. That is what makes a session started in a terminal
look identical to one started here, and it is why there is no de-duplication
problem to solve.

The one sanctioned exception is **liveness** — `runner-status`, `permission-request`
and friends are state *about* a turn, not content *of* it.

A client that renders from a token stream reintroduces exactly the problem this
design avoids. Do not.

## Authentication

A token is created on first run at `~/.local/share/claude-sessions/token`
(mode `0600`), 32 random bytes as base64url. Every `/api/` route requires it except
`GET /api/health`.

Three accepted forms, and **any one of them being valid is enough** — a stale
credential in one slot does not shadow a good one in another:

| Form | Use |
|---|---|
| `Authorization: Bearer <token>` | The normal one. What an Android client should send. |
| `?token=<token>` | For `EventSource`, which cannot set headers. In practice only used by the pairing handshake. |
| `Cookie: cs_token=<token>` | What browsers use after pairing. |

Failure is `401` with `{"error": "unauthorized", "hint": …}`.

### Pairing a device

```
GET /pair?token=<token>   →  303 to /m, Set-Cookie: cs_token=…; HttpOnly; SameSite=Lax; Max-Age=31536000
POST /pair/forget         →  303, cookie expired
```

`Secure` is added when the request arrived over HTTPS (or the host is a `.ts.net`
name). This is what keeps the token out of URLs and history after the first open.

A native client does not need this — it should store the token and send the header.

### Local browsers

A page fetched over loopback with no `Origin` is served with the cookie set and the
token injected as `<meta name="cs-token" content="…">`. That is why nothing in
`web/` sends an explicit credential.

## Local vs remote

Every request is classified. `remote` is true if **any** of: the socket is not
loopback; `x-forwarded-*` headers are present on a loopback connection; or the
request was addressed to a host that is not loopback. Three signals OR'd, so a
proxy that changes its behaviour degrades into withholding powers rather than
granting them.

`GET /api/health` reports `remote` so a client can say so in its UI. Plan 14-C asks
for this by name, and a client should honour it: you should never be unsure whether
the thing you are about to approve is running on a machine you are sitting at.

**Refused for remote callers** (403, with `{"error": …, "remote": true}`):
`permissionMode` of `bypassPermissions` or `dontAsk` on both create and send; all
of `/api/terminals/*`; `/api/shutdown`; `/api/devservers/stop`;
`/api/devbrowser/*`; `POST /api/sessions/:id/reveal`; `POST /api/fs/mkdir`.

Note the asymmetry in that last one: `GET /api/fs` stays readable remotely, so the
refusal is on the exact path rather than the `/api/fs` prefix. Reading the tree
answers "where could a session start", and a phone may already start one. Creating
a directory is reaching past the app into the machine.

**For every caller:** a session may only start inside `CLAUDE_SESSIONS_ROOTS`
(default `$HOME`); `/api/fs` lists and `/api/fs/mkdir` writes only inside the same
roots; session creation is capped at 8 per minute (`429`). A leading `~` in any
path — a session's `cwd`, `/api/fs?path=`, a mkdir `parent` — means `$HOME`, as it
would in a shell.

## Reading

### `GET /api/health`

The only unauthenticated route. Counts, a pid, and:

```json
{ "ok": true, "version": "1.0.0", "port": 45888, "dev": false,
  "remote": false, "authRequired": true,
  "permissionModes": ["auto","acceptEdits","plan","manual","dontAsk","bypassPermissions"],
  "sessions": 120, "clients": 1, "live": 4, "busy": 3 }
```

`root` and `home` are included only for local callers. Read `permissionModes` rather
than hardcoding the list; a remote client should drop `bypassPermissions` and
`dontAsk` from what it offers, because the bridge will refuse them.

### `GET /api/sessions?q=&project=&limit=`

`{ sessions: [summary], ready: bool }`. A summary carries `sessionId`, `title`,
`projectName`, `cwd`, `worktree`, `model`, `permissionMode`, `userMessages`,
`toolCalls`, `firstTs`/`lastTs`/`lastUserTs`, `lastPrompt`, the `pinned`/`archived`/
`test` flags, `live` (from Claude Code's own process registry, or null), and
`runner` (this bridge's process for it, or null).

### `GET /api/sessions/:id[?tail=N]`

`{ summary, events: [...], offset, runner }`.

`offset` is a **byte position in the transcript file**, not an event count. Hold it;
it is what resumes the live tail.

`?tail=N` returns only the last N events and adds
`truncated: { dropped, total }`. Mobile clients should use it — a 60-turn session is
~1,800 events and half a megabyte of JSON, and none of the first 1,500 is why
someone opened their phone.

Event kinds, all with `id`, `kind`, `ts`:

| kind | Carries |
|---|---|
| `user` | `text`, `images[]`, `command`, `origin` (`human` or an agent) |
| `assistant` | `text` (markdown), `model` |
| `thinking` | `text` |
| `tool` | `name`, `input{}`, `status` (`ok`/`error`/absent while running), `result{text,stdout,stderr,patch,filePath,interrupted}`, `agent`, `persistedPath`, `durationMs` |
| `system` | `subtype`, `isError`, `text` |
| `agent-done` | `taskId`, `toolUseId`, `status`, `summary` |
| `compact` | `text` |

A `tool` event arrives once as a call and again with its result. Render idempotently
by `id` and patch in place.

### `GET /api/sessions/:id/since?offset=N`

`{ events, offset, reset }`. The catch-up call. `reset: true` means the transcript
shrank — it was compacted or forked — and the client should reload from scratch.

This is how a mobile client resumes after a network change, and it is much cheaper
than refetching.

### `GET /api/overview`

The live board: `{ at, ready, sessions: [card], hidden, waiting, running }`, already
ordered needs-you-first. A card carries `reason`
(`ask`/`error`/`here`/`elsewhere`/`pinned`), `title`, `projectName`, `worktree`,
`runner`, `live`, `ask`, `headlines[]`, `tasks{done,total,current}`, `devservers`.

`waiting` is the count worth putting on a badge.

Also pushed as the `overview` SSE event, so most clients never call this — but it is
the right answer to "what is happening right now", and anything that wants that
should read it rather than growing a second answer.

### `GET /api/slash-commands?session=<id>` · `GET /api/slash-commands?cwd=<path>`

What slash commands a working directory can run, for a composer that completes
them: `{ cwd, at, exact, source, commands: [{ name, description?, argumentHint? }] }`.

Addressed either way because both callers exist — a composer knows a session id
and a dialog that has not started one knows only a path. The session form
resolves the cwd exactly as `POST /api/sessions/:id/send` does, which a client
cannot do for itself, having no way to ask whether a path still exists. The
`cwd` form is roots-scoped like `GET /api/fs`.

The list is whatever the CLI reported in its `system`/`init` message, **minus
`terminal_slash_commands`** — commands whose UX is bound to a terminal, which
that field exists to let remote UIs hide. Filtered here rather than by the
client, so every surface gets it. `description` and `argumentHint` are read from
the command's own frontmatter and are simply absent for the built-ins, which
have no file.

`source` is `runner` (a process reported it this bridge lifetime), `cache`
(read back from disk at startup), `fallback` (another directory's list, with
`exact: false`) or `none`. An unknown directory is `commands: []` and 200, never
a 404: the caller pressed a key, and an empty list is a real answer.

## The live channel

`GET /api/events` — SSE, `text/event-stream`. Then tell it what to follow:

```
POST /api/subscribe  { clientId, sessionId, offset, agent, overview }
```

`clientId` comes from the `hello` event. One session followed at a time; `overview`
is a separate, orthogonal follow that stays on while a session is open.

**There is no `Last-Event-ID` replay, and no `id:` field.** Nothing is buffered for
a disconnected client. Recovery is: reconnect, re-subscribe from the offset you
hold, and call `/since`. Design for this rather than around it — on a phone it
happens constantly.

A `: ping` comment arrives every 25s. `X-Accel-Buffering: no` is set.

| Event | Payload |
|---|---|
| `hello` | `{clientId, version}` |
| `tail` | `{sessionId, events, offset}` |
| `reset` | `{sessionId}` — reload from scratch |
| `agent-tail` / `agent-reset` | as above, for a subagent |
| `overview` | the board; sent only when it has actually changed |
| `sessions-changed` | `{at}` — a nudge to refetch the list |
| `session-deleted` | `{sessionId, title}` |
| `runner-status` | see below |
| `permission-request` | `{sessionId, ...ask}` |
| `permission-resolved` | `{sessionId, requestId, outcome}` |
| `notice` | `{sessionId, level, kind, text}` |
| `turn-complete` | `{sessionId, isError, detail, costUsd, durationMs, …}` |
| `send-failed` | `{sessionId, kind, message, unsent: [text]}` — hand the text back to the user |
| `session-forked` | `{from, to}` — follow the new id |
| `slash-commands` | `{cwd, at}` — that directory's slash commands changed; drop what you cached |

`runner-status`: `{sessionId, state, activity, model, permissionMode, cwd, error,
errorKind, queued, queue[], pendingPermission, canPrompt, busySince}` where `state`
is `stopped`/`starting`/`idle`/`busy`/`error`.

**`pendingPermission` matters on open**: an ask may already be outstanding when a
client attaches, and this is what remembers it. A client that only listens for the
`permission-request` event will miss every ask that predates it.

### Being connected is load-bearing

`pool.hasViewer = () => clients.size > 0`. With no SSE client attached, an ask is
**denied immediately** — there is nobody to ask. A connected phone is what makes a
session answerable when nobody is at the desk; a phone that drops its connection
causes auto-denials.

## Writing

### `POST /api/sessions`

`{cwd, prompt, model?, permissionMode?, test?}` → `{sessionId, status, test}`.

`cwd` must be inside the allowed roots. `test: true` keeps it out of the everyday
window — use it for anything exploratory. `plan` is the sensible default mode for a
first message.

### `POST /api/sessions/:id/send`

`{text, model?, permissionMode?, fork?}` → `{ok, id, cwd, fork, status, queued}`.

**Always send `permissionMode`.** An absent one normalises to `auto`, which means
omitting it does not mean "leave it alone" — it means "set it to auto", and would
quietly drop a session out of `acceptEdits` on every message.

A model or mode change replaces the process; queued messages carry across. `queued`
tells you whether the text is still recoverable on this side.

### `POST /api/sessions/:id/permission`

The one route that answers all three kinds of ask.

```
{ requestId, decision: "allow" | "allow-always" | "deny",
  updatedInput?, answers?, feedback?, mode? }
```

- **Tool** — `allow`, `deny`, or `allow-always` (this tool, this session only).
- **Plan** — `allow` **plus `mode`**. This is load-bearing: the session is *in* plan
  mode while the card is up, so approving without changing mode agrees to the work
  and then blocks every edit in it. `auto` is the normal choice, `acceptEdits` the
  deliberate second one. `feedback` on an allow is appended to the plan and echoed
  to the model as *Approved Plan (edited by user)*; on a `deny` it goes back as the
  tool's error, which is where the model reads a refusal — so "too broad, do the
  parser first" produces a different plan rather than the same one again.
- **Question** — `allow` with `answers`, an object keyed by the **exact question
  text** from `ask.input.questions[].question`.

`404` means no live process. **`409` means it was already answered** — by another
window, or the desktop's notification buttons. That is an ordinary outcome, not an
error to shout about.

The ask shape (`permission-request`, and `runner.pendingPermission`):

```json
{ "requestId": "…", "kind": "tool" | "plan" | "question",
  "tool": "Bash", "displayName": "Bash", "input": {…},
  "toolUseId": "…", "description": null, "reason": null,
  "blockedPath": null, "agentId": null,
  "askedAt": 1786722343125 }
```

**An ask does not expire.** There is no deadline to count down and no
`expiresAt` — a card waits as long as you do, and a client that attaches later
finds it on `runner.pendingPermission`. `askedAt` is there so a client can say how
long something has been blocked, which is the number that matters when the person
who should answer is not at the desk.

The case that made expiry seem necessary is handled earlier and more bluntly: an
ask arriving with no client connected is denied immediately, because there is
nobody to ask.

`outcome` values on `permission-resolved`: `allow`, `allow-always`, `deny`,
`answered`, `dismissed`, `plan-approved`, `plan-approved-note`, `plan-rejected`,
`auto-denied`, `superseded`, `stopped`, `cancelled`, `abandoned`.

### Other writes

| Route | Body | Notes |
|---|---|---|
| `POST /api/sessions/:id/stop` | `{hard?}` | `{ok, how, dropped[]}` |
| `GET/DELETE /api/sessions/:id/queue[/:qid]` | | inspect, drop one, clear |
| `POST /api/sessions/:id/queue/reorder` | `{ids}` | |
| `POST /api/sessions/:id/flags` | `{pinned?, archived?, test?}` | |
| `DELETE /api/sessions/:id` | | hard delete; `409` if a turn is running |
| `GET /api/fs?path=` | | directory picker; roots-scoped |
| `POST /api/fs/mkdir` | `{parent, name}` | one new folder; roots-scoped, local callers only |
| `GET /api/pairing` | | local callers only — what this machine is reachable as |

`/api/fs` returns `{path, parent, roots, isGit, truncated, entries[]}`, where each
entry is `{name, path, git}`. Directories only, dotfiles omitted, symlinks to
directories included, sorted, and capped at 500 with `truncated` saying when the
cap bit. `parent` is null at the edge of the roots rather than offering a step the
route would refuse, and `roots` is there so a breadcrumb knows where the trail
stops. A directory that cannot be read comes back **200** with an `error` field
and no entries — the path and the way back up are still good, so a client should
check `error` on success.

`/api/fs/mkdir` makes exactly one directory: `name` is a single segment, and a
slash in it is a `400` rather than an implied `mkdir -p`. Also `400`: an empty
name, `.` or `..`, a leading `.` (the listing hides those, so it would vanish the
moment it was made), a name over 255 bytes, and a `parent` that is not a
directory. `403` for a `parent` outside the roots or an unwritable one, `409` when
a *file* of that name is in the way. Creating one that is already a directory is
**200** with `created: false` — the caller wanted a folder there and there is one.

`/api/pairing` returns `{hosts: [{url, kind}], tailscale: {name, https, running},
served, port}`, by shelling out to `tailscale.exe` on the Windows host. `served` is
the origin `tailscale serve` is already proxying to this port, or null. Every `url`
is a real value a client can use directly — never a placeholder to be edited. When
nothing can be determined, `hosts` is empty and the caller should ask.

## Decisions locked in for a native client

These are cheap now and expensive later, so they are settled:

- **Bearer token**, which OkHttp sets trivially. The cookie exists for browsers.
- **SSE over HTTP/1.1, not WebSockets.** It is what the bridge speaks, and it is
  what survives an HTTP proxy. (One caveat: see the `cloudflared` buffering bug in
  `docs/remote.md` — it is a reason to pick a transport, not to change protocol.)
- **`?tail=N` on open, `/since?offset=` to resume.** Never refetch a whole
  transcript on reconnect.
- **No dependency on the Electron shell.** There is exactly one native method
  (`app/preload.js` → `revealWindow`) and both of its call sites are already
  feature-guarded. Everything else comes over HTTP.
- **Push is not built.** When it is, it is FCM from the Android app or Web Push from
  the PWA; both need the HTTPS origin that `docs/remote.md` sets up. Until then, a
  client only learns about an ask while it is connected — and see *Being connected
  is load-bearing* above for why that matters more than it sounds.

## Two things that will bite

**Deleting a session whose process is still shutting down.** `DELETE` unlinks the
transcript, but an exiting `claude` may then write its bookkeeping (`last-prompt`,
`ai-title`) back to the same path — and the session reappears as an empty row with
0 turns. Stop it, wait, then delete; or delete twice.

**A tool call is not final when you first see it.** It arrives with no `status` and
no `result`, and again later with both. Anything keyed on first sight will show a
permanently spinning tool.
