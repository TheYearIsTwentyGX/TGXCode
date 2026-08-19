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
of `/api/terminals/*`; all of `/api/runs/*`; `POST /api/commands/run`;
`/api/shutdown`; `/api/devservers/stop`; `/api/devbrowser/*`;
`POST /api/sessions/:id/reveal`; `POST /api/fs/mkdir`.

Note the asymmetry in the last two: `GET /api/fs` and `GET /api/commands` stay
readable remotely, so those refusals are on the exact path rather than the
prefix. Reading the tree answers "where could a session start", and a phone may
already start one; reading what a project declares gives away nothing that is not
in its repository. Creating a directory, or running one of those commands, is
reaching past the app into the machine.

`GET /api/slash-commands` is readable remotely for the same reason, and is a
different route from `GET /api/commands` despite the name — one is what the CLI
will accept in the composer, the other is what the repository declares in
`.tgxcode/`. It is still roots-scoped, so a `?cwd=` outside them is refused for
every caller.

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

`prs` is every pull request the session raised, in the order it raised them:
`[{number, url, repo}]`, empty for a session that raised none. Read from the
transcript, so it is free and it is history — what has *become* of those PRs is a
separate request, below. It is an array because a session that lands one PR and
opens another is ordinary; it was a single `pr` object until August 2026, which
silently kept only the newest.

### `GET /api/sessions/:id[?tail=N]`

`{ summary, events: [...], offset, runner, suggestions, prefs }`.

`prefs` is the settings in force **for this conversation's directory** — see
`GET /api/prefs`. It travels with the transcript rather than being fetched
separately because a client that draws the transcript before the settings arrive
has drawn it the wrong way, and nothing re-renders history.

`suggestions` maps the id of a `suggestion` event to what was already done about
it — `{status: "started"|"dismissed", startedId, at}`. The suggestion itself is in
the transcript; only the decision is the app's, so only the decision is sent
separately. See `POST /api/sessions/:id/suggestions/:toolUseId`.

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
| `suggestion` | `prompt`, `why`, `title`, `cwd` — follow-up work an agent offered rather than did |
| `peer-message` | `from` (socket address), `fromName` (the peer's name, which is its address), `text` |
| `compact` | `text` |

A `tool` event arrives once as a call and again with its result. Render idempotently
by `id` and patch in place.

### `GET /api/sessions/:id/since?offset=N`

`{ events, offset, reset }`. The catch-up call. `reset: true` means the transcript
shrank — it was compacted or forked — and the client should reload from scratch.

This is how a mobile client resumes after a network change, and it is much cheaper
than refetching.

### `GET /api/sessions/:id/prs`

`{ prs: [...], gh: {ok, error} }` — what has become of the pull requests this
session raised, one entry per PR in `summary.prs`, same order.

Each carries `number`, `url`, `repo`, `title`, `branch`, `updatedAt`, a resolved
`status`, a `label` naming that status in words, and `detail`: extra lines the one
status had to leave out, for a tooltip.

`status` is one of `open`, `draft`, `approved`, `changes`, `checks-failed`,
`checks-pending`, `conflicting`, `merged`, `closed`, or `unknown`. A PR is
regularly several of those at once — open *and* approved *and* conflicting — so
one is chosen by what most needs doing about it: settled states first, then draft,
then a review asking for changes, a failing check, a conflict, a check still
running, an approval, and plain open last. `resolveStatus` in `bridge/pulls.js` is
the whole rule and `test/pulls.test.js` pins the ordering.

Two answers are deliberately withheld rather than guessed. A repository with no CI
reports no check state at all — an empty rollup is not a pending one. And GitHub
reports mergeability as `UNKNOWN` until it has computed it, which is common on a
freshly-pushed branch, so nothing is said about conflicts until it does.

`unknown` means gh could not be reached, and `gh.error` says why in one line. The
client is expected to keep showing the PR — it has the number and the link from the
summary already — and simply not colour it. **This is its own route rather than a
field on the summary on purpose**: it asks GitHub, and the session list must never
wait on GitHub. The bridge caches one `gh pr list` per repository for a minute, and
a merged or closed PR for the life of the process, since neither can change back.

### `GET /api/prefs?cwd=<path>`

`{ version, transcript: {...}, sources: [...], problems: [...] }` — how the person
using the app wants it to behave.

`~/.tgxcode/settings.json` is the user's own, written out with the defaults on
first run so it can be found and edited. A project overrides any key from
`<workspace>/.tgxcode/settings.json`, with the same precedence as project
commands: the workspace's checked-in file (falling back to the main checkout's),
then `settings.local.json` from the main checkout, then one in the workspace.
`sources` lists the files that were actually read, weakest first.

A value that is not what the key allows is dropped and reported in `problems`
rather than taken at face value; the default stands. Without `?cwd=` you get the
user-level answer, which is also what every page is served in a `cs-prefs`
`<meta>` tag (minus `sources` and `problems`).

`transcript` today: `groupToolCalls` (fold a run of tool calls into one row once
a message closes it), `groupMinCalls` (how long a run has to be — at least 2),
`groupIncludesThinking` (whether a thinking block is part of the run or the end
of it).

### `GET /api/peers`

`{ peers: [{name, nameSource, sessionId, cwd, kind, entrypoint, status, startedAt,
title, project}], at }` — the live sessions an agent could send a message to,
newest first.

Read from Claude Code's own process registry rather than from the session index,
because they answer different questions: the index is about transcripts and hides
some of them (test sessions on the everyday bridge, anything under `/tmp`), while a
background agent with no indexed transcript is still perfectly able to receive a
message. `title` and `project` are joined on where there is an indexed transcript
and are null where there is not.

**`name` is the address.** `SendMessage({to: "<name>"})` is how one session reaches
another and there is no other form of address, which is what this route is for:
getting the exact name in front of somebody. Only sessions that are running *and*
have an inbox are listed.

### `GET /api/overview`

The live board: `{ at, ready, sessions: [card], recent: [card], hidden, recentHidden,
waiting, running }`, already ordered needs-you-first. A card carries `reason`
(`ask`/`error`/`here`/`elsewhere`/`pinned`/`recent`), `title`, `projectName`, `worktree`,
`runner`, `live`, `ask`, `headlines[]`, `tasks{done,total,current}`, `devservers`.

`waiting` is the count worth putting on a badge.

`sessions` is "running now, plus pinned" and is the answer to *who is blocked on me*.
`recent` is a second list, of sessions with no process at all but touched recently, for a
surface that also has to answer *what was I doing yesterday* — a board of nothing but
pinned cards is what the mornings looked like without it. It is a separate array rather
than more reasons in `sessions` so that a client reading only `sessions` keeps getting
exactly what it got before.

"Recently" is not a rolling window, which is wrong at both ends of a day. Before noon it
reaches back to noon yesterday — or to noon Friday on a Monday; after noon, only to
midnight. Measured on `lastTs`, so an agent that worked until 2am counts as last night's
work. Archived sessions are left out, and anything already in `sessions` cannot appear
here. Capped at 12 with the remainder in `recentHidden`, as `sessions` is capped at 24 with
`hidden`.

`devservers` is not refreshed for a recent card: the probe behind it costs a full
transcript read per session every 15s, and that budget goes to what is running. A session
that has just gone quiet keeps the chips its last pass found — a dev server usually
outlives the turn that started it — and one that was never on the board has none.

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
| `peer-message` | `{at, sessionId, from, count}` — another session messaged this one. The message itself is in the transcript, so a client tailing it has already drawn it; this is for everything that is not the open pane |
| `suggestion-changed` | `{at, sessionId, toolUseId}` — a suggested follow-up was started, dismissed, or undone, possibly in another window |
| `session-deleted` | `{sessionId, title}` |
| `runner-status` | see below |
| `permission-request` | `{sessionId, ...ask}` |
| `permission-resolved` | `{sessionId, requestId, outcome}` |
| `notice` | `{sessionId, level, kind, text}` |
| `turn-complete` | `{sessionId, isError, detail, costUsd, durationMs, …}` |
| `send-failed` | `{sessionId, kind, message, unsent: [text]}` — hand the text back to the user |
| `session-forked` | `{from, to}` — follow the new id |
| `slash-commands` | `{cwd, at}` — that directory's slash commands changed; drop what you cached |
| `run-changed` | `{runId, workspace, commandId, label, state, port, exit, stopped, at}` — a project command moved; state only, never output |

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
| `GET /api/sessions/:id/suggestions` | | `{sessionId, suggestions}` — the decisions alone |
| `POST /api/sessions/:id/suggestions/:toolUseId` | `{status, startedId?}` | `status` of `started`, `dismissed`, or absent to undo |
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

## Project commands

What a directory declares in `.tgxcode/commands.json`, and the processes started
from it. See `bridge/commands.js` for the file format and where it is read from,
and `docs/plans/17-project-commands.md` for why.

| Route | Body / query | Notes |
|---|---|---|
| `GET /api/commands?cwd=` | | what this directory declares; readable remotely |
| `POST /api/commands/run` | `{cwd, id}` | start one; local callers only |
| `GET /api/runs` | | every run this bridge knows of |
| `GET /api/runs/:id` | | one of them |
| `GET /api/runs/:id/stream` | | SSE byte pipe — see below |
| `POST /api/runs/:id/input` | `{b64}` | bytes to the pty |
| `POST /api/runs/:id/resize` | `{rows, cols}` | |
| `POST /api/runs/:id/stop` | | SIGHUP to the job, SIGKILL after 2s |
| `DELETE /api/runs/:id` | | forget an exited record; `409` if still running |

`GET /api/commands` answers `{workspace, project, projectName, worktree, branch,
commands[], problems[]}`. Each command is `{id, label, command, cwd, port,
devbrowser, from, run}` — `command` is the string that will run, with everything
expanded *except* `${port}`, which is not known until one is allocated. `run` is
the live or last record for that command in that directory, or null.

`problems[]` is `{file?, id?, message, informational?}`. A file that will not
parse contributes nothing and reports once; a single bad command is dropped and
its siblings survive. Both are worth showing: silently offering fewer buttons
than the file asks for is how a typo goes unnoticed for a week.

A run record is `{id, workspace, commandId, label, command, cwd, port,
devbrowser, state, pid, startedAt, listeningAt, exitedAt, exit, stopped,
terminalId}` with `state ∈ starting | listening | running | stopping | exited`.
`stopped` says somebody pressed Stop, as against the process ending on its own —
worth distinguishing, because SIGHUP escalates to SIGKILL for anything that
shrugs it off, so the signal a run died of says nothing about whether it was
asked to.

**Starting is not idempotent and does not reattach.** One run per
`(cwd, commandId)`; asking for a second is `409` with the live one in the body,
so a client can open its output rather than quietly start nothing. `409` also
covers no free port in the range and too many runs at once. Restart is stop, wait
for `exited`, start.

**Runs die with their bridge**, like terminals and unlike nothing else here. The
child's stdout is a pipe whose only reader is the bridge, so one that outlived it
would fill the buffer, block on `write()` and go on holding its port while hung.
A client should say so rather than imply otherwise.

`/api/runs/:id/stream` is byte-for-byte the terminal stream — `opened` (once,
carrying the run record), `data` (`{b64}`), `exit` (`{code, signal}`), base64 in
both directions, `: ping` every 25s. It is a connection of its own for the reason
the terminal one is: a noisy build moves megabytes and has no business sharing
with transcript tailing. **Nothing about a run's output ever appears on
`/api/events`** — that channel carries `run-changed` and `run-changed` only.

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
