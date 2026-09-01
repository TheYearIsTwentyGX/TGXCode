# The bridge API

What a client needs to know to talk to the bridge. `web/app.js` (desktop) is one
client; the native Android app in `~/Other/tgxcode-mobile` is the other, and this
document exists so that it is a *client* rather than a rewrite.

There used to be a third — a phone-shaped web page at `/m` — and it is gone. The
phone surface is the Android app now, so a feature the phone needs is a field in
here, not a page in `web/`.

Anything a client needs and cannot get from here is a gap in the API, and belongs
fixed here rather than worked around in the client.

**This file is the contract, not a summary of one.** The Android client adds no
code to this repository and cannot read `bridge/`; it is written against this
document alone. So a change to the wire surface that is not written down here does
not fail a test — it produces a client that renders the wrong thing and a session
spent finding out why. Field *types* are given wherever a name alone would mislead,
because that is the mistake this file has actually made: four fields were listed by
name and turned out to be objects. See CLAUDE.md §*Leave `docs/api.md` true before
you land*.

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

### `X-Claude-Sessions-Client: 1` on every write

**Every non-GET `/api/` route except `/api/health` also requires the header
`X-Claude-Sessions-Client: 1`**, and refuses without it with
`403 {"error": "missing client header"}`. It is checked before the token, so a
request that is missing it fails the same way whether or not the token was good.

It is a CSRF guard, not a secret: the value is a constant published in this
repository, and the point is only that a form post or an image tag from another
origin cannot set a custom header without a preflight. Nothing in `web/` mentions
it in prose because `web/app.js`, `web/terminal.js` and `web/sw.js` each carry it
in their own `HEADERS` constant.

It is the first thing a new client trips over, because the read surface works
perfectly without it and then the *entire* write surface 403s at once —
`/api/subscribe` included, which makes it look like the live channel is broken
rather than the header missing. Send it on every request and the distinction never
comes up.

Sending it on a GET is harmless and simplest.

### One more refusal that is not about the token

A **remote** request addressed to a host the bridge does not recognise is
`403 {"error": "unexpected host", "host": …}`, before auth. Loopback names, any
`.ts.net` name, a bare IP address, and anything in `CLAUDE_SESSIONS_ORIGINS`
are recognised; a name that resolves to `127.0.0.1` from somewhere else is the
DNS-rebinding case this closes. A client reaching the bridge through a proxy on a
new hostname needs that hostname in `CLAUDE_SESSIONS_ORIGINS` — the symptom is a 403 that no
amount of correct token fixes.

### Pairing a device

```
GET /pair?token=<token>   →  303 to /, Set-Cookie: cs_token=…; HttpOnly; SameSite=Lax; Max-Age=31536000
POST /pair/forget         →  303, cookie expired
```

`Secure` is added when the request arrived over HTTPS (or the host is a `.ts.net`
name). This is what keeps the token out of URLs and history after the first open.

A native client does not need the handshake — it should store the token and send the
header. **It does still depend on this URL's shape**, because pasting the link the
desktop's *Connect a phone* dialog builds (`<origin>/pair?token=<token>`) is how the
token gets onto a device at all. Parse the token out of the query and never fetch the
route. The `303` target is the desktop page and means nothing to a native client; it
was `/m` until the phone web view was removed, so do not key on it.

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
`permissionMode` of `bypassPermissions` or `dontAsk` on create, on send, and on
**saving or starting a draft**; all
of `/api/terminals/*`; all of `/api/runs/*`; `POST /api/commands/run`;
`/api/shutdown`; `/api/restart` (both methods); `/api/devservers/stop`; `/api/devbrowser/*`;
`POST /api/sessions/:id/reveal`; `POST /api/sessions/:id/handoff`; `POST /api/fs/mkdir`;
both attachment uploads — `POST /api/sessions/:id/attachments` and
`POST /api/attachments`.

The draft routes are otherwise fully open to a remote caller, deliberately: setting
work up at the desk and releasing it from a phone when quota frees up is the case the
feature exists for. What a phone cannot do is *widen* a mode — the check runs when the
draft is written and again when it is started, so a `bypassPermissions` draft saved
locally still refuses to start remotely.

Note the asymmetry around `/api/fs` and `/api/commands`: `GET /api/fs` and
`GET /api/commands` stay readable remotely, so those refusals are on the exact path
rather than the prefix. Reading the tree answers "where could a session start", and a phone may
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

### `GET /api/projects`

`{projects: [{cwd, name, sessions, mtimeMs, active}]}` — one entry per directory
sessions have run in, newest first. `sessions` is how many there are, `active` how
many were written to in the last 90 seconds, `mtimeMs` the newest of them. Sessions
whose directory is under a temp path contribute nothing. This is what fills the
project filter on `GET /api/sessions?project=`.

### `GET /api/sessions?q=&project=&limit=`

`{ sessions: [summary], ready: bool }`. A summary is:

| Field | Type |
|---|---|
| `sessionId`, `title`, `titleSource`, `cwd`, `projectCwd`, `projectName`, `gitBranch`, `model`, `permissionMode`, `version`, `sessionKind`, `lastPrompt` | strings, any of them null |
| `firstTs`, `lastTs`, `lastUserTs` | ISO 8601 strings or null |
| `userMessages`, `assistantMessages`, `toolCalls`, `bytes`, `mtimeMs` | numbers |
| `pinned`, `archived`, `test`, `active` | bools |
| **`worktree`** | **object or null** — `{name, branch, path, originalCwd}` |
| **`schedule`** | **object or null** — `{id, title}`, both strings; see below |
| `prs` | array of `{number, url, repo}`, empty if none |
| **`live`** | **object or null** — see below |
| **`runner`** | **object or absent** — four fields only, see below |

**`schedule` is an object, not an id**, and its presence changes `title`. It is
`{id, title}` when a schedule started this session and `null` for everything else,
which is nearly everything. `id` is the row in `GET /api/schedules`; `title` is that
schedule's *resolved* name — a schedule's own `title` is nullable and falls back to the
first line of its prompt, and this field has already done that, so it is never empty.

When it is present, **`title` is composed** rather than read from the transcript:
`"<schedule title> - <M/D/YY>"`, dated from `firstTs`, with `titleSource: "schedule"`.
A headless scheduled run gets none of Claude Code's own title entries, so without this
every run of a schedule is titled with the same slash command and a fortnight of them
is indistinguishable. **A title the user set by hand wins** — `custom-title` and
`agent-name` are left alone, and the field is then absent from `titleSource` while
`schedule` is still there. A client that wants the schedule's name without the date
reads `schedule.title`; one that wants to group scheduled runs tests `schedule` for
null and needs nothing else.

`titleSource` says where `title` came from: `custom-title`, `agent-name`, `ai-title`
(Claude Code's own entries), `schedule` (composed as above), `prompt` (the first line
of the first user message, with a slash-command invocation unwrapped to
`/name args` rather than left as its `<command-message>` tags), `registry` (the live
process's label), or `none`.

**`worktree` is an object, not a name.** `{name, branch, path, originalCwd}`, where
`originalCwd` is the checkout the worktree was branched from — which is what makes a
worktree session belong to its owning project in a rail rather than becoming a project
of its own. Null for a session that is not in one.

**`live` is Claude Code's own process-registry entry, not a flag.** Present as an
object when there is a process — including one running in a terminal or VS Code, which
this bridge knows nothing else about — and `null` otherwise:
`{sessionId, pid, procStart, cwd, kind, entrypoint, name, nameSource, addressable,
peerProtocol, status, version, startedAt, updatedAt, running}`. `kind` is
`"interactive"`, `"bg"`, or whatever Claude Code adds next; `entrypoint` is `"cli"`,
`"vscode"`, `"claude-sessions"` (us), …; `name` is the session's *address* for
cross-session messaging and `addressable` says whether it is listening. Treat truthiness
of `live` as "there is a process" and `live.running` as "and it is still alive" — the
registry file outlives the process that wrote it.

### There are three different `runner` shapes

The same field name carries **three different shapes** depending on which payload you
read it off. Nothing errors when you read a field that is not there; you get
`undefined` forever. So check which one you are holding:

| Where | `runner` is |
|---|---|
| `GET /api/sessions/:id` · `runner-status` event · the `status` a write returns | **the whole thing** — every field in §*`runner-status`* below |
| `GET /api/sessions` · `GET /api/dashboard` | **four fields**: `{state, activity, detail, queued}` |
| a `GET /api/overview` / `taskboard` card | **seven fields**: `{state, activity, queued, busySince, retry, error, errorKind}` |
| absent entirely | there is no process of ours for that session |

The narrowing is deliberate — the rail draws several hundred rows and wants a label and
a badge, not a queue and an ask for each — but it is invisible at the call site, which
is what makes it worth a table.

**The practical consequence: `runner.pendingPermission` is `undefined` on every payload
except the three in the first row.** A client that reads it off a session summary to
decide whether to draw an ask dot draws it never and reports no error — this was a real
bug in a real client, not a hypothetical. **To find out which sessions are blocked, read
`GET /api/overview` and use the card's `ask` field** — not `card.runner`, which does not
carry it either. `ask` is the whole ask object, so a tool ask can be answered straight
from the card.

`prs` is every pull request the session raised, in the order it raised them:
`[{number, url, repo}]`, empty for a session that raised none. Read from the
transcript, so it is free and it is history — what has *become* of those PRs is a
separate request: `GET /api/sessions/:id/prs` for one session, or `GET /api/prs`
for a status per session across the whole list, both below. It is an array because
a session that lands one PR and opens another is ordinary; it was a single `pr`
object until August 2026, which silently kept only the newest.

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

The suggestions themselves arrive as `suggestion` events in `events`, but a client
drawing them as a list should read `GET /api/suggestions?session=<id>` instead —
same fields, and it does not depend on how much of the transcript was asked for.

`offset` is a **byte position in the transcript file**, not an event count. Hold it;
it is what resumes the live tail.

`?tail=N` returns only the last N events and adds
`truncated: { dropped, total }`. Mobile clients should use it — a 60-turn session is
~1,800 events and half a megabyte of JSON, and none of the first 1,500 is why
someone opened their phone.

Event kinds, all with `id` (string), `kind` (string) and `ts` (ISO 8601 string).
Types are given because several of these were once listed by name alone and read as
strings by a client that then rendered `[object Object]`:

| kind | Carries |
|---|---|
| `user` | `text` string · `images[]` `{mediaType, dataUri}` · `files[]` `{relPath, name, size}` · **`command` object or null** — `{name, args}` · `origin` string or absent — Claude Code's own `origin.kind`, passed through: `"human"`, `"peer"`, or an agent type. Not a closed set the bridge controls, so treat anything other than `"human"` as "not the person" rather than switching on it |
| `assistant` | `text` string (markdown) · `model` string or null |
| `thinking` | `text` string |
| `tool` | `name` string · `input` object · `status` — see below · `result` object or null · **`agent` object or null** · `persistedPath` string or null · `durationMs` number or null · `resultTs` ISO string once resolved |
| `tool-result` | `toolId` string, plus every field of a resolved `tool` — a **patch**, see below |
| `system` | `subtype` string · `isError` bool · `text` string |
| `agent-done` | `taskId`, `toolUseId`, `status` (`"completed"` unless the notification said otherwise), `summary`, `result` — all strings or null — plus `tokens`, `toolUses`, `durationMs`, numbers or null, and `hasTranscript`, a boolean. **`toolUseId` is not on its own a subagent you can open.** A background shell reports itself through the same notification and its `toolUseId` names a `Bash` call, which has nothing filed under `subagents/`; `GET /api/sessions/:id/subagent` then answers `404`. Offer a way in only when `hasTranscript` is true |
| `suggestion` | `prompt` string · `why`, `title` strings or null · `cwd` string — follow-up work an agent offered rather than did |
| `peer-message` | `from` (socket address), `fromName` (the peer's name, which is its address), `text` |
| `handoff` | `text` string — work another session handed this one, which is what woke it · `from` (the sending session's id), `fromTitle`, `fromProject`, `title`, all strings or null |
| `compact` | `text` string |

**`tool.status` is `"pending"`, not absent, while a call is running**, and `"ok"` or
`"error"` once it resolves. A client switching on it needs three cases, and the third
is not a missing key.

**`tool.result`** is `{text, stdout, stderr, patch, filePath, interrupted,
backgroundTaskId}`. `text` is the tool output flattened to a string and is the one to
show; `stdout`/`stderr`/`filePath` are strings or null; `interrupted` is a bool.

**`tool.result.patch` is a structured diff, not a string** — the `structuredPatch`
Claude Code records for an edit, an array of hunks:

```json
[{ "oldStart": 12, "oldLines": 3, "newStart": 12, "newLines": 4,
   "lines": ["     const x = 1;", "-    return x;", "+    return x + 1;"] }]
```

Each entry in `lines` already carries its own leading `+`, `-` or space; do not add
one. Null for a tool that produced no diff.

**`tool.agent` is a subagent descriptor, not a name** — `{agentId, agentType,
description, model, isAsync, durationMs, tokens, toolUses}` from the result, plus
`spawnDepth` and `hasTranscript: true` when a transcript for it exists on disk. Null
for an ordinary tool call. `hasTranscript` is what says the subagent can be opened as
its own view; see `agent` on `POST /api/subscribe`.

**A `user` event for a slash command has bookkeeping XML in `text`.** The bridge
strips `<system-reminder>` and `<local-command-stdout>` and nothing else, so a
`/foo bar` turn arrives with `text` of
`"<command-message>…</command-message><command-name>/foo</command-name><command-args>bar</command-args>"`
and the parsed `command` beside it. Render from `command` when it is present —
`{name: "foo", args: "bar"}`, the name with its leading slash **already removed**, so
put one back; `args` is `""` for a command that takes none — and strip the
`<command-…>` tags out of `text` yourself if you show it at all. A client that does
neither renders a slash command as `/[object Object]`, which is how this got noticed.

### A tool call resolves in one of two ways

A `tool` event arrives once as a call and again with its result. Render idempotently
by `id` and patch in place.

**Which of the two you get depends on whether the call and its result landed in the
same read**, and on a live tail they usually do not:

- **A full read** (`GET /api/sessions/:id`) stitches the result into the `tool` event
  itself, so the second copy carries `status`, `result` and `durationMs`.
- **A tail** whose chunk holds the result but not the call cannot stitch, and emits a
  separate **`tool-result`** event instead: `id` of `<toolUseId>:result`, `kind` of
  `tool-result`, `toolId` pointing at the `tool` event already on screen, and the
  resolved fields alongside. Apply it to that block.

**A client with no `tool-result` case leaves every tool spinning for the whole of a
live turn** and looks perfectly fine on a finished session, because a full read never
produces one — which is why it is easy to ship without noticing. `web/app.js` handles
it.

### `GET /api/sessions/:id/since?offset=N`

`{ events, offset, reset }`. The catch-up call. `reset: true` means the transcript
shrank — it was compacted or forked — and the client should reload from scratch.

This is how a phone client resumes after a network change, and it is much cheaper
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

### `GET /api/prs`

`{ sessions: {...}, gh: {ok, error} }` — one *aggregate* status per session, for a
list that wants a glyph per row and cannot afford a request per row.

`sessions` is **an object keyed by session id, not an array**, and a session with
no pull requests is **absent from it rather than null** — the client already knows
which those are from `prs` on the summary. Each value is an object:

| Field | Type |
|---|---|
| `status` | string — one of the same ten values `GET /api/sessions/:id/prs` uses |
| `label` | string or null — the winning PR's own label, in words |
| `total` | number — how many pull requests the session raised |
| **`counts`** | **object** — `{[status]: number}` over all of them, e.g. `{"merged": 2, "draft": 1}`. Only the statuses actually present appear as keys |

**The ranking here is not the one `resolveStatus` uses, and that is deliberate.**
A client that assumes one precedence and is served the other draws the wrong glyph
and reports no error, so both are written out:

- **One PR** (`/api/sessions/:id/prs`): settled states *first*, because for a merged
  PR nothing else is worth saying, and draft above anything wrong with the code,
  because nobody is being asked to act on a draft yet.
- **A session's whole set** (`/api/prs`): settled states *last*, because they are
  the ones that no longer need saying, and a broken PR above a draft, because it is
  the one waiting on you now. In full, least settled first:
  `conflicting`, `checks-failed`, `changes`, `draft`, `checks-pending`, `open`,
  `approved`, `unknown`, `closed`, `merged`.

`unknown` sits above the two settled states on purpose: with one PR unreachable and
one merged, "all merged" is a claim that cannot be made. `ATTENTION_ORDER` and
`aggregate` in `bridge/pulls.js` are the whole rule and `test/pulls.test.js` pins
both orderings.

Cost: every call is one cached `gh pr list` per repository, *plus*, the first time a
given already-settled PR is asked about, one `gh pr view` for it — merged and closed
cannot change back, so that answer is kept for the life of the process. So the first
call after a bridge restart can take seconds on a machine with a long history, and
every later one is fast. Fetch it **after** the session list has painted, never
before: this is the request `/api/sessions` deliberately does not make.

Nothing pushes PR changes — there is no `/api/events` event for them. Poll this at
about the bridge's own minute of cache; `web/app.js` uses 60s.

### `GET /api/sessions/:id/changes[?refresh=1]`

`{ dir, checkedAt, git: {...}, edits: [...], agents: {total, edited}, added, deleted }`
— what this session changed, in the two ways that question has an answer. Both are
sent because **neither is a better version of the other**, and the client is
expected to draw them as two lists rather than reconcile them.

`edits` is the transcript's answer, and so is about the *conversation*: it holds
files the session edited and has since committed, files it edited in a directory
that no longer exists, and files a subagent edited on its behalf. Each entry
carries `path` (absolute, its identity), `relPath` (relative to the repository
root where it is inside one, absolute where it is not), `added`, `deleted`, an
`edits` count, `firstTs`/`lastTs`, and one of two ways back to it:

- `toolId` — the `tool_use` id of the **first** edit in this transcript, so a
  client can jump to where the file started changing rather than where it stopped.
- `agent` — `{toolUseId, agentType, description}`, set only when *every* edit came
  from a subagent, so there is no call in this transcript to jump to. Where both
  touched a file, `toolId` wins and `agent` is null.

Counted from the structured patch Claude Code recorded with the call, not by
re-diffing a file that has moved on since. Only `Edit`, `Write`, `MultiEdit` and
`NotebookEdit` count, and they are recognised **by tool name**: `ExitPlanMode`
results carry a `filePath` too — the plan file — and keying on that field instead
lists approved plans as edited code. A `Bash` running `sed -i` is invisible here
by necessity, which is one of the reasons the tree is shown beside this.

`git` is the working tree as it stands, and so is about the *directory*: it holds
whatever anybody else changed and drops what this session changed and put back.
`{ok: true}` carries `branch`, `upstream`, `ahead`, `behind`, `root`, the counts
`staged`/`unstaged`/`untracked`/`conflicts`/`files`, `dirty`, and `sample` — up to
400 files, with `truncated` saying how many were left out. Each sample entry has
`path` (relative to the repository root), `status` (the porcelain-v2 XY code), and
`added`/`deleted`/`binary` from `git diff --numstat`. Untracked files have no
counts at all: they are not in `git diff`, and the status code already says they
are new.

`{ok: false}` is an answer rather than an error, and `reason` is one of
`no-directory`, `not-a-repo`, `left-behind` (the directory is inside a repository
but is not a checkout of its own — a removed worktree whose untracked files kept
it on disk) or `status-failed`. Sessions run outside a repository are ordinary.

`agents` says how many subagents the session spawned and how many of them changed
a file, so a client can explain a count that looks too small.

`refresh=1` drops the cached `git status` **for this directory only** — a 15s TTL
otherwise, shared with `/api/dashboard`, which asks the same question of the same
directories. Its own route rather than a field on the summary for the reason
`/prs` gives: it shells out, and the session list must never wait on that.

### `GET /api/prefs?cwd=<path>`

`{ version, transcript: {…}, live: {…}, spinner: {…}, sources: [string], problems: [{file, message}] }`
— how the person using the app wants it to behave. `sources` is file paths, weakest
first; each `problems` entry is an **object**, `{file, message}`, naming the file that
carried a value the key does not allow and what was wrong with it.

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

`live` is about the desktop live board: `compact` (bool — a card stops at the
tool-count line, with no history preview, no message box, no Open/Stop and no
approval row), `hideElsewhere` (bool — leave out cards whose session is running
under something that is not this bridge, i.e. `reason: "elsewhere"`; the board
says how many it left out rather than dropping them silently). Both default
`false`.

Note that the page reads these from its `<meta>` copy, which is the **user-level**
answer — the board draws sessions from every project at once, so a project's
`<workspace>/.tgxcode/settings.json` can set `live` and will see it echoed back
on `?cwd=`, but it does not change what the board draws. A client that builds its
own cards has no reason to read `live` at all — the Android app does not.

`spinner`: `randomize` (whether a turn in progress wears a themed verb in front
of what it is doing, or says only what it is doing as before), `groups` (which
groups from `~/.tgxcode/verbs/` are in play, named by their `Category` — at most
200), `rerollMs` (how long a verb stands before the next is drawn; `0` pins one
for the whole turn, else 1000–600000). The verbs themselves are not here — they
are a directory, and `GET /api/spinner/groups` lists it.

### `GET /api/spinner/groups?cwd=<path>`

`{ randomize (bool), rerollMs (number), enabled: [string], pool (number),
groups: [{name, file, count, source}], problems: [{file, message}] }` — which spinner
verb groups exist and which are in force. `enabled` is group names; `problems` entries
are **objects**, as on `/api/prefs`.

`groups` is one entry per group available to `cwd` — `{name, file, count,
source}`, where `name` is the `Category` inside the file and `source` is the
directory it came from. A project's `<workspace>/.tgxcode/verbs/` wins over the
user's `~/.tgxcode/verbs/`, so a repo can ship its own group without anybody
editing their home directory.

`enabled` is what settings ask for and `pool` is how many distinct verbs that
actually amounts to — the two disagree when a name matches no file, which is
what `problems` then says. A group whose filename and `Category` differ still
works, and is reported here rather than left a mystery.

This is the discoverable half of `spinner.groups`: there is no settings page, so
without it the only answer to "what may I put in that list?" is to go and read a
directory. Read-only, like `/api/prefs` — the files are the interface. Not
local-only either: the names and sizes of verb groups are not a capability worth
refusing a phone.

### `GET /api/sessions/:id/devservers`

`{ports: [...], total, elsewhere}` — the localhost ports this session's agent
brought up, for the chip strip above the conversation.

A port is shown when it belongs to **this session's workspace**, and that is
decided by the kernel rather than by the transcript: `ss` says which pid holds
the port, `/proc/<pid>/cwd` says where that process is running, and the worktree
or checkout above it is the workspace. `ours: true` means that matched.

This matters because the obvious alternative does not work. Evidence scraped
from a transcript can only say a session *mentioned* a port, and "is it
listening" is a fact about the machine — so a `curl localhost:5001` in one
session used to light up green the moment another worktree's server took 5001.
Ports bled across sessions constantly. Walking the holder's parents to find the
owning `claude` does not work either: a backgrounded dev server is reparented to
init as soon as its launching shell exits.

Each port carries `port`, `title`, `listening`, `stopped`, `evidence`, plus the
attribution: `workspace` (where its process runs, or null), `ours`, `foreign`
(held by another workspace), `unverified`, `protectedBy` and `titledElsewhere`.

Two cases the kernel cannot settle:

- **No Linux process holds it.** WSL mirrored networking means a Windows-side
  server answers on 127.0.0.1 with no pid this side. Those fall back to the
  session's own transcript and only to its strong end — a startup banner or a
  devbrowser call, never a bare mention — and come back `unverified: true`.
- **The port is dead.** Nothing holds it, so nothing can speak for it. A dead
  port is kept only if this session has strong evidence *and* DevBrowser's name
  for it does not belong to another worktree (`titledElsewhere`).

`protectedBy` marks a port held by a bridge or a `claude` process. Those are
never offered at all: the everyday instance runs in the main checkout, so a
session there would otherwise be shown a green chip — and a stop button — for
the app it is being displayed in.

`elsewhere` counts the live ports this session mentioned that another workspace
is holding. The UI says so rather than leaving the strip looking empty.


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

For the sessions that are *not* running — which is most of them — see
`GET /api/sessions/addressable` below. The two routes look similar and answer
different questions, and the difference is the whole reason both exist.

### `GET /api/sessions/addressable?q=&project=&from=&limit=`

`{ sessions: [{sessionId, title, cwd, projectName, branch, lastActive, state, self}],
ready }` — who an agent could **hand work to**, most recently active first.

The counterpart to `GET /api/peers`, and worth reading beside it. That route answers
"who can receive a message right now", so it lists live processes with an inbox:
Claude Code's peer transport needs one, and a name only exists while a process does.
This answers "who could be *given* work", which is nearly everybody — a handoff goes
through `pool.ensure`, so a session with no process is resumed rather than
unreachable. Since a runner is evicted after fifteen idle minutes and only four stay
live, having no process is the ordinary state of a session, and most of this list is
sessions `/api/peers` cannot see at all.

`state` is what a handoff would run into, and it is three answers where the taskboard
gives two:

| | |
|---|---|
| `idle` | no turn in flight. A handoff resumes it. The usual case. |
| `working` | a turn is running, or messages are queued. A handoff is queued behind it. |
| `elsewhere` | a process, but not one of ours — a terminal, VS Code, a background agent. `claude --resume` refuses it, so a handoff is refused too. |

`?from=` marks the caller's own row `self`, so the tool offering this list can rule
out the one session it must not pick. Archived sessions are left out: filing one away
says it is finished, and an agent looking for somewhere to send work should not
reopen it.

### `GET /api/overview`

The live board: `{ at, ready, sessions: [card], recent: [card], hidden, recentHidden,
waiting, running }`, already ordered needs-you-first. A card is:

| Field | Type |
|---|---|
| `sessionId`, `title`, `projectName`, `cwd`, `model`, `permissionMode` | strings, any of them null |
| `reason` | `"ask"`, `"error"`, `"here"`, `"elsewhere"`, `"pinned"` or `"recent"` |
| `pinned`, `test` | bools |
| `lastTs`, `lastUserTs` | ISO 8601 strings or null |
| `toolCalls`, `userMessages` | numbers |
| **`worktree`** | **object or null** — as on a session summary |
| **`live`** | **object or null** — the registry entry, as on a session summary |
| **`runner`** | **object or null — seven fields**, not the `runner-status` payload: `{state, activity, queued, busySince, retry, error, errorKind}` |
| **`ask`** | **object or null** — the *whole* ask (`runner.pendingPermission`), so a tool ask is answerable from the card. Same shape as `permission-request` |
| **`headlines[]`** | **array of objects**, not strings — `{text, ts}`, oldest first, up to three |
| `tasks` | object or null — `{done, total, current, ts}` |
| **`devservers`** | **array of objects or null** — `{port, title, owned}`, listening ports only; `null` until the first probe has run |
| `sig` | string — see below |

Every card also carries `sig`, a short hash of the rest of the card. The board is pushed
once a second and almost all of it is identical to the push before, so a client that keeps
its nodes can compare `sig` and rebuild only the cards that moved — which is what the web
UI does. Treat it as opaque: it is a fingerprint, not an identifier, and its only promise
is that it changes when something else on the card does.

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

`devservers` is not refreshed for a recent card, and that budget goes to what is running.
A session that has just gone quiet keeps the chips its last pass found — a dev server
usually outlives the turn that started it — and one that was never on the board has none.
The probe costs a whole transcript read the first time it sees a session and only the
bytes appended since on every pass after; port detection folds forward, so there is
nothing to recompute from the beginning.

Also pushed as the `overview` SSE event, so most clients never call this — but it is
the right answer to "what is happening right now", and anything that wants that
should read it rather than growing a second answer.

### `GET /api/taskboard?idle=`

Everything outstanding, in one payload: open suggested tasks beside every un-archived
session, grouped by what state it is in.

```json
{
  "at": 1787161000629, "ready": true,
  "needs":   [sessionCard],
  "working": [sessionCard],
  "suggested": [task],
  "idle":    [sessionCard],
  "counts": { "needs": 1, "working": 3, "suggested": 3, "idle": 57 },
  "idleHidden": 46
}
```

`suggested` is `GET /api/suggestions?status=open` verbatim — the same rows, the same
fields — so a client draws a task the same way wherever it meets one. A `sessionCard` is
a trimmed `/api/overview` card: no `headlines` and no `devservers`, because both cost a
transcript read or a port probe per session and this board is several times wider than
that one. What is left is state, which is free.

Which column a session is in is `column(s, runner)` in `bridge/taskboard.js`, and it is
deliberately the same predicates in the same order as `why()` in `overview.js`:

| | |
|---|---|
| off the board | `archived` — that is what archiving is for, and it is the only filter applied to a session here |
| `needs` | a pending permission (tool, plan or question), or a runner in `error` |
| `working` | runner `busy` or `starting`, or a queue behind a stopped turn, or a live registry entry with no runner of ours — a terminal, VS Code, a background agent |
| `idle` | everything else |

Two differences from the live board, both because every session gets a card here.
`pinned` is not a state: on the live board a pin is a *reason to draw a card at all*, and
here a pinned idle session is simply idle. And nothing falls through to nothing.

**`counts.idle` is the total, not what was returned.** The idle column leads with the same
working-hours window the live board's recent group uses (`recentSince`, shared rather than
reimplemented), and `idleHidden` says how many that left out. A count describing only the
visible slice would read as "this is everything" on a machine with several hundred
un-archived sessions.

`?idle=all` drops the window and returns all of them, newest first, with `idleHidden: 0`.
It is answered here and **never pushed**: it is what one button asks for once, the rows it
brings back are idle by definition, and pushing several hundred of them every few seconds
to every window is the cost the window exists to avoid. Any other value of `?idle=` means
`recent`; there is nothing to get wrong, so there is no 400.

Test sessions appear only on the development bridge, exactly as in the session list.
**A task from an archived session is still returned**, carrying `archived: true` — the
reasoning is under `/api/suggestions` and it is about tasks, not sessions.

Also pushed as the `taskboard` SSE event, which is how the UI reads it; the route is for
the first load, for the Show-all button, and for anything that would rather poll.

### `GET /api/drafts`

Sessions set up but not started — a working directory, a first message, a model and a
permission mode, held until somebody presses Start.

```json
{
  "at": 1787328400656,
  "drafts": [
    { "id": "9640eae3-2c96-4a21-aa94-b7d262950ec0",
      "cwd": "/home/dylan_hays/Other/claude-sessions",
      "projectName": "claude-sessions",
      "prompt": "Add a CSV export to the reports page",
      "title": null, "model": "opus", "permissionMode": "plan", "test": true,
      "createdAt": 1787328400891, "updatedAt": 1787328401276 }
  ],
  "counts": { "total": 1 }
}
```

**A draft is the body of `POST /api/sessions`**, plus an id, two timestamps and a
`title`. That is the whole idea: pressing Start runs the create call that was written
down, so a client that can build one form can do both, and nothing about the session is
decided at start time that was not decided when it was saved.

One exception, and it is one-way: **`attachments` is not stored.** The create call
takes it and a draft does not, so a file cannot be set up now and sent later. It is
left out rather than forgotten — the bytes live in a checkout, and a draft that
referred to them would be a promise about a directory nobody is watching.

`title` is the one field that is **not** part of the create call, and it does not survive
the start — there is nothing to hand it to, because a session names itself from its first
message like every other session. It names the *draft*, on a board that may hold a
dozen, and it is dropped when the draft is. Leave it `null` and clients show the first
line of `prompt`, which is what `web/app.js` does; set it when the first line makes a bad
label.

| Field | Type |
|---|---|
| `id` | string, a UUID |
| `cwd` | string — **expanded and checked when it was saved**, so never a `~`, always inside the allowed roots at the time of writing |
| **`projectName`** | string — derived, not stored. The same label the rail and the session list use (`projectName` in `bridge/sessions.js`), computed on the bridge so three clients cannot disagree about which project a directory belongs to |
| `prompt` | string, non-empty, already trimmed |
| **`title`** | **string or null.** `null` means *derive it* — take the first line of `prompt`. It is not an empty heading and it is not the string `"null"`; a client that renders it raw shows nothing where the name should be |
| **`model`** | **string or null.** `null` is `inherit` — the session picks for itself. Not `""` |
| `permissionMode` | string, one of the six in `POST /api/sessions/:id/send` |
| `test` | boolean — the flag the started session will get, not a property of the draft |
| `createdAt`, `updatedAt` | numbers, epoch ms. `createdAt` never moves; every write bumps `updatedAt` |

Ordered **newest `updatedAt` first**, which is the order to draw them in — editing a
draft moves it to the front. Ties break newest-first too, so a burst saved in the same
millisecond does not come back reversed.

`counts.total` is the length of `drafts`, always: unlike `/api/taskboard`'s idle column
there is no window and nothing is held back, so the two cannot disagree.

Test-flagged drafts are **not** filtered on the everyday bridge, unlike test *sessions*.
A draft is not visible work — it has no transcript and no process — and hiding one you
had ticked would mean losing it. The flag only decides what the session becomes.

Also pushed as the `drafts-changed` SSE event, which is how the UI reads it. That event
carries this same payload, so a client never has to come back here after the first load.

### `GET /api/schedules`

Sessions that start on a clock — everything `POST /api/sessions` takes, plus a cron
expression and an optional gate, held and fired by the bridge itself.

```json
{
  "at": 1787669481083,
  "schedules": [
    { "id": "1e18868c-2a44-4e4b-9be7-f049c34e2072",
      "enabled": true,
      "title": "adversarial review",
      "cwd": "/home/dylan_hays/LTCDataPlus",
      "projectName": "LTCDataPlus",
      "prompt": "/adversarial-reviewer --diff {{range}}",
      "model": null, "permissionMode": "dontAsk", "test": false,
      "cron": "0 2 * * 2-6",
      "once": false,
      "cronText": "Tue–Sat at 2:00 AM",
      "cronForm": { "kind": "weekly", "days": [2, 3, 4, 5, 6], "hour": 2, "minute": 0 },
      "nextRunAt": 1787727600000,
      "gate": { "kind": "git-commits", "ref": "origin/main", "fetch": true },
      "reviewed": {}, "reviewedCount": 0, "reviewsInFlight": 0,
      "sweepSlotAt": null, "sweepUntil": null,
      "lastSlotAt": 1787641200000,
      "lastFiredAt": 1787641203115,
      "lastSessionId": "c7e384e8-1a5c-495f-b02c-7d48a7d63095",
      "lastOutcome": "CLEAN",
      "lastSkipReason": null,
      "lastError": null,
      "lastMarker": "c9e5dcd56a7031f2b0f8e4a1d9c7b6e5f4a3b2c1",
      "runs": 14,
      "createdAt": 1787328400891, "updatedAt": 1787641203118 }
  ],
  "counts": { "total": 1, "enabled": 1 }
}
```

**A schedule is a draft that is never consumed, plus a cron expression and a gate.**
The same create-call fields, validated the same way — so a client that can build the
drafts form can build this one with two fields added.

**`prompt` may contain placeholders, and they are filled at fire time, not stored
expanded.** `{{range}}` is the one that matters: it becomes `abc123def456..789abc012def`,
the commits that have landed since the previous run. Also `{{head}}`, `{{since}}`,
`{{count}}`, `{{ref}}` and `{{date}}` (ISO `YYYY-MM-DD`). A placeholder this list does not
name is **left in the text verbatim** rather than blanked — a prompt is prose, and `{{`
is not reserved punctuation in it. With no usable marker `{{range}}` narrows to
`<head>~1..<head>`, never to the whole history and never to an empty string.

| Field | Type |
|---|---|
| `id` | string, a UUID |
| `enabled` | boolean. `false` is paused, not deleted — it keeps its history and its marker, and is skipped by the tick. **The bridge itself clears this** on a `once` schedule whose slot has passed, so a client must treat it as something that changes underneath it rather than only in response to a `PATCH` |
| **`title`** | **string or null.** `null` means *derive it* — take the first line of `prompt`. Not an empty heading, not the string `"null"` |
| `cwd` | string — expanded and checked when it was saved, and **checked again at fire time**, so a directory that has since moved costs one run rather than being trusted from disk |
| **`projectName`** | string — derived, not stored. The same label the rail uses |
| `prompt` | string, non-empty, already trimmed. See placeholders above |
| **`model`** | **string or null.** `null` is `inherit`. Not `""` |
| `permissionMode` | string, one of the six in `POST /api/sessions/:id/send` |
| `test` | boolean — the flag the started session will get |
| `cron` | string, **five space-separated fields in the bridge's local timezone**: minute hour day-of-month month day-of-week. `*`, `N`, `a-b`, `*/n` and comma lists. Day-of-week 0 and 7 are both Sunday. **No** names (`MON`), `@daily`, `L`, `#` or `?` — those are refused, not ignored. When day-of-month and day-of-week are both restricted, a day matching **either** fires, which is crontab(5)'s rule |
| **`once`** | **boolean.** `true` is a one-time schedule: cron has no year field, so the expression names a date (`0 17 29 8 *`) and this is what stops it coming round again next August. **It switches itself off the moment its slot passes** — `enabled` goes `false` whether the run happened or was missed. Pressing `POST /:id/run` does *not* spend it, because Run now does not touch `lastSlotAt`. A `once` on a repeating expression is accepted and coherent: it runs at the next slot and then stops. With an `open-prs` gate a spent one-time keeps a `sweepUntil` in the future for as long as its batch is still draining, so **`enabled: false` and an open window is a real, transient state** and not a contradiction — the row is finishing the slot that disabled it |
| **`cronText`** | **string or null** — derived. `cron` in English, e.g. `"Tue–Sat at 2:00 AM"`. Falls back to the raw expression for shapes it cannot phrase, so it is safe to render directly. `null` only if `cron` is unparseable, which a stored row cannot be. Reads the `once` flag: the same dated expression is `"once, on 29 August at 5:00 PM"` with it and `"29 August every year at 5:00 PM"` without |
| **`cronForm`** | **object** — derived, and the *same expression as controls* so a client can draw a schedule picker without parsing cron. A tagged union on `kind`, one of: `{kind: "minutes", every}` · `{kind: "hours", every, minute}` · `{kind: "daily", hour, minute}` · `{kind: "weekly", days, hour, minute}` (`days` is an **array of numbers**, 0=Sunday, ascending) · `{kind: "monthly", day, hour, minute}` · `{kind: "date", month, day, hour, minute}` (1-based `month`) · `{kind: "custom"}`. All values are numbers. **`custom` is a real answer, not an error** — it means no picker row represents this expression (`0 9,17 * * 1-5`, or the day-of-month/day-of-week OR) and a client should offer the raw text instead of approximating. `kind` is `"date"` whether or not `once` is set; the flag is what says which of the two it means. Never null for a stored row |
| **`nextRunAt`** | **number or null**, epoch ms — derived, computed per request. `null` when the schedule is paused **or** when the expression matches no future date (`0 0 30 2 *` parses and never fires). Those two are different states; `enabled` tells them apart |
| **`gate`** | **object or null**, and one of **two shapes** — `null` means fire every time the clock says so. `{kind: "git-commits", ref: string, fetch: boolean}` fires one session when `ref` has moved; `ref` is anything `git rev-parse` accepts and `fetch` defaults to `true`, fetching only that ref's remote, never `--all`, never tags. `{kind: "open-prs", includeDrafts: boolean, post: boolean}` fires **one session per open pull request** — see *The pull-request gate* below. Both booleans default to `true` |
| **`reviewed`** | **object** — the pull-request gate's marker, `{"<owner>/<name>#<number>": {sha, at, sessionId, outcome, posted, postError}}`. Empty `{}` for every other kind of schedule. **On the wire this is a TAIL, not the store**: the twenty most recent by `at`, with `reviewedCount` giving the real size. A client that treated it as complete would decide a pull request was unreviewed because it fell off the end |
| `reviewedCount` | number — how many entries the store actually holds |
| `reviewsInFlight` | number — reviews started and not yet finished. What a card says during a sweep |
| **`sweepSlotAt`, `sweepUntil`** | **number or null**, epoch ms. A pull-request slot does not do all its work at once: it opens a *window*, and the batch drains over the ticks that follow. These are that window. `null` on every other kind of schedule, and on a PR schedule that is not mid-sweep |
| **`lastSlotAt`** | **number or null**, epoch ms — the cron slot already satisfied. This, not `lastFiredAt`, is what makes firing idempotent; a client should treat it as bookkeeping rather than as "when it last ran" |
| **`lastFiredAt`** | **number or null**, epoch ms — when a session was actually started. `null` if it has never run. A slot that skipped does **not** move this |
| **`lastSessionId`** | **string or null** — the session the last run produced. Safe to link to; it may 404 briefly right after a run, for the reason `POST /api/sessions` gives |
| **`lastOutcome`** | **string or null** — how the last *run* ended: `"BLOCK"`, `"CONCERNS"`, `"CLEAN"`, `"error"`, or `"done"`. The first three are lifted from a `VERDICT:` line in the session's final message; `"done"` means it finished and said nothing of the sort, which is the ordinary case for most prompts and **not** a failure. `null` before the first run finishes |
| **`lastSkipReason`** | **string or null** — why the last slot passed *without* starting a session: `"nothing-new"` (the gate found no commits), `"missed"` (the slot was older than the 12-hour catch-up cap), `"error"`, `"rate-limited"`. `null` when the last slot did run. **A card that treats `null` here as "fine" and ignores the rest will show a broken schedule as healthy** |
| **`lastError`** | **string or null** — the message behind an `error` or `missed` skip |
| **`lastMarker`** | **string or null** — the full SHA reviewed up to, and the `since` half of `{{range}}`. **Seeded when the schedule is created**, so the first run covers what arrives afterwards rather than the repository's whole history. Advanced **only** when a session actually starts: a skip, a refusal or a failed spawn leaves it exactly where it was |
| `runs` | number — sessions actually started, ever. Skips do not count |
| `createdAt`, `updatedAt` | numbers, epoch ms. `createdAt` never moves |

Ordered **newest `updatedAt` first**. Note that a *run* bumps `updatedAt`, so the order
moves on its own here in a way the drafts list's does not.

Test-flagged schedules are not filtered on the everyday bridge, for the reason drafts are
not. The flag decides what the session becomes, and — see below — which bridge may fire it.

**Only the everyday instance fires schedules.** Several bridges share `schedules.json` by
design, so a development bridge lists, edits and runs-on-demand but its tick does nothing.
With `CLAUDE_SESSIONS_SCHEDULE_ON_DEV=1` a dev bridge fires schedules with `test: true`
and only those. A client cannot see which bridge it is talking to beyond `dev` in
`/api/health`, and should not need to.

Also pushed as the `schedules-changed` SSE event, carrying this same payload.

#### The pull-request gate

`{kind: "open-prs"}` is a different shape of schedule and the difference is worth
stating plainly: **a branch gate fires one session and a pull-request gate fires
one per pull request.**

A PR is due when its current head SHA is not the SHA in `reviewed`. Keyed on the
SHA and not on `updatedAt`, because `updatedAt` moves when somebody leaves a
comment — which would buy a full review session for a pull request whose code has
not changed.

**A slot opens a window rather than doing the work.** Twenty concurrent `claude`
processes is not a thing to do to a laptop at 2 AM, and the create limit would
refuse most of them, so the slot sets `sweepUntil` and the batch drains across the
ticks that follow — at most two starts per tick, at most three reviews in flight,
and never spending the last of the shared create budget (a sweep that did would
`429` the next Start *you* pressed). Anything still unreviewed when the window
closes is reported as `lastSkipReason: "sweep-expired"` with a count, never
dropped silently.

`{{range}}` for a PR run is `<mergeBase>..<head>`, computed per pull request.
Two dots and a merge base, both deliberate: two dots against the *tip* of the base
branch would include whatever other people landed on it since the branch diverged,
and three dots — right for `git diff`, and what GitHub's Files-changed tab shows —
means the *symmetric difference* to `git log`. The prompt is prose and the session
may reach for either command, so the range has to mean one thing to both. The base
comes from each PR's own `baseRefName`, which on these repositories is regularly
not `main`.

**What the bridge writes to GitHub when a review finishes**, if `gate.post` is
true and the schedule is not a `test` one:

- a review **comment** carrying the report, prefixed with the head SHA it was
  looking at so a re-review is legible in the timeline;
- one of `review-clean` / `review-concerns` / `review-blocked`, **and the other two
  removed** — a pull request wearing both `review-blocked` and `review-clean` is
  worse than one wearing neither. The labels are created on first use.

It is a *comment*, never an approval, and that is a constraint rather than a
choice: GitHub refuses to let an account approve its own pull request, and on this
machine every open PR is authored by the account `gh` is authenticated as.
`review-clean` is the "ready to merge" signal instead.

**A `test: true` schedule never posts.** A development bridge fires test schedules
on purpose and `gh` is the same credentials either way, so without that rule
testing this feature would comment on real pull requests. `posted` reads
`skipped-test` in that case. `gate.post: false` is the same switch for an ordinary
schedule that wants the reviews without writing anything.

`posted` on a reviewed entry is `null` before the turn ends, then one of `ok`,
`failed`, `skipped-test`, `seeded` (never reviewed — recorded at create time so
the first run does not review the whole backlog), or `interrupted` (the bridge
stopped mid-review; the findings are in the transcript and were never posted).
**A failed post never unwinds the entry** — the review is the artefact and posting
is delivery, so re-running a whole session to retry a comment would spend minutes
of quota re-deriving text that already exists. It raises a loud notification
instead.

### `GET /api/schedules/describe?cron=<expr>&once=1`

What an expression means, without saving anything. This is where a "runs Tue–Sat at
2:00 AM" line under an input box comes from — **do not ship a second cron parser in a
client**, or it will eventually disagree with the one that actually fires.

```json
{ "cron": "0 2 * * 2-6",
  "text": "Tue–Sat at 2:00 AM",
  "form": { "kind": "weekly", "days": [2, 3, 4, 5, 6], "hour": 2, "minute": 0 },
  "next": 1787727600000 }
```

`once=1` is optional and says the caller is asking about a *one-time* schedule, which
changes `text` and nothing else — a dated expression means two different things with
the flag and without it, and this route has no row to read it off. Any other value,
including its absence, is `false`.

`form` is the same tagged union as `cronForm` on a schedule, documented under
`GET /api/schedules` — the expression as controls. **Composing cron in a client is
fine; parsing it is what this route is for.** A picker builds five fields out of
numbers it already has, which cannot misread anything; going the other way — deciding
that `0 0-6/2 * * *` is or is not "every 2 hours" — is the judgement that has to match
the process that fires. So: compose on the way out, and read `form` on the way back in.

`text` is never null here. `next` is a number or `null`, and `null` is a real answer:
the expression parses and matches no future date. `400` with `{error}` for anything
`cron` cannot parse, and that message is written to be shown to a person.

### `GET /api/dashboard?refresh=1`

What is still in flight: work written to disk but not committed, and pull requests
that are open but not merged. A different question from the session list — a worktree
with eleven modified files and no commit does not show up as activity, which is
exactly why it gets lost.

```json
{ "ready": true, "checkedAt": "2026-08-21T…Z", "dirty": 3, "open": 2,
  "gh": { "ok": true, "repos": 4, "error": null },
  "projects": [ { "cwd": "…", "name": "claude-sessions", "repo": "owner/repo",
                  "dirty": 2, "open": 1, "workspaces": [ … ] } ] }
```

A workspace is `{dir, kind, name, git, prs[], sessions[], moreSessions, lastTs}`.
`kind` is `checkout`, `worktree`, or `gone` — a row that exists only because a
transcript named a still-open PR whose directory has since been removed, in which case
`dir` is null. `git` is either `{ok: false, reason}` (`not-a-repo`, `left-behind`,
`status-failed`, `gone`) or a parsed `git status`: `{ok: true, branch, upstream, ahead,
behind, staged, unstaged, untracked, conflicts, files, dirty, detached, sample[]}`,
where `sample` is up to ten `{path, status}` entries — enough to recognise the change,
not a whole `git status`.

`prs[]` are the whole `pulls.js` record plus `matched`, which is `"branch"` (the
workspace has that branch checked out) or `"session"` (only a transcript connects
them). The record, field by field — it was documented by reference before, which is
the "write the type, not the field name" mistake this document is supposed to avoid:

| Field | Type |
|---|---|
| `number` | number |
| `title`, `url` | strings |
| `branch` | string — the **head** ref name |
| **`headSha`** | **string or null** — the head commit. What a scheduled review keys "have I seen this pull request as it stands" on; `updatedAt` cannot serve, because a comment moves it |
| **`base`** | **string or null** — the base ref name, and on these repositories regularly **not** `main`: pull requests here stack, so one may target another branch's worktree. A diff computed against a fixed ref would attribute somebody else's commits to the PR |
| **`labels`** | **array of strings** — names only. gh returns objects; the id is a node id nothing here can use, and the full array would be hundreds of bytes per PR on a payload carrying a hundred of them |
| `draft` | boolean |
| **`reviewDecision`** | **string or null** — `"APPROVED"`, `"CHANGES_REQUESTED"`, `"REVIEW_REQUIRED"`, or null for none |
| `author` | string or null — a login, falling back to a display name |
| `createdAt`, `updatedAt` | ISO strings or null |
| `state` | string — `"OPEN"`, `"MERGED"`, `"CLOSED"` |
| `mergeable` | string — `"MERGEABLE"`, `"CONFLICTING"`, `"UNKNOWN"`. `UNKNOWN` says nothing, deliberately |
| **`checks`** | **object or null** — `{total, failed, pending, passed}`. **`null` means the repository has no CI**, which is not the same as zero of everything, and a client that renders it as "0 checks passed" is saying something untrue |
| `repo` | string — `owner/name` |

**A failed `gh` is cached for its full 60s TTL**, empty list and all. So one hiccup
looks exactly like "nothing is open" for a minute — which for a reader is a blank
panel, and for anything deciding what to act on is a trap worth knowing about. `sessions[]` are chips — `{sessionId, title, lastTs, userMessages,
active}` — capped at six per workspace with `moreSessions` counting the rest, and
carrying the same narrow four-field `runner` as `GET /api/sessions` where one is live.
A chip carries **no `schedule`**, so a client cannot tell a scheduled run from any
other here; its `title` is still the composed one, so the schedule's name and the date
it ran are in the text even though the field is not there to group on.

Only unfinished rows survive: a workspace with a clean tree and no open PR is dropped,
and so is a project left with no workspaces. `gh` fails once for everything rather than
per repository, because they all fail the same way — `gh` missing, or a login that
expired.

**This route shells out to `git` and `gh`, so it is slow and it is cached** — working
trees for 15s, GitHub for a minute. `?refresh=1` clears both caches first; do not send
it on a poll.

### `GET /api/notifications?scope=&type=&sessionId=&limit=`

Everything that reached out to you, after the fact. It exists because `broadcast()`
has no replay buffer and Windows' own notification centre swallows toasts, so
"something pinged me and I have no idea what" had no answer.

The envelope is
`{ notifications: [row], unread: number, read: {all, sessions} }`, newest row first.

A row is:

```json
{ "id": "1786722343125-a1b2c3d4", "at": 1786722343125, "type": "permission",
  "sessionId": "…", "title": "Rename the runner", "project": "claude-sessions",
  "cwd": "…", "summary": "Bash: npm test", "detail": "…", "loud": true,
  "requestId": "…", "outcome": null, "outcomeAt": null, "anchorId": "…",
  "read": false }
```

`type` is one of `permission`, `plan`, `question`, `finished`, `failed`, `agent-done`,
`peer-message`, `handoff`, `schedule-findings`, `schedule-failed`, `schedule-missed`.
`summary` is clipped to 200 characters and `detail` to 400.

**`sessionId` may be `null`, and it is on two of the three schedule types.** Every row
used to be about a session, so a client could treat `sessionId` as always present and
`title` as always the session's. A schedule can fail *without* producing a session — a
missed slot, a ref it could not resolve, a working directory that has moved — and those
are exactly the rows worth raising. On such a row `title` is the schedule's name and
there is nothing to navigate to, so **a client that links the whole row to
`/api/sessions/<sessionId>` must check for `null` first**. `schedule-findings` does
carry one; the other two do not.
`outcome` and `outcomeAt` are filled in later, on the row that already exists, when an
ask is answered — so a row is mutable and a client holding one should patch it rather
than assume it is final. `anchorId` is a `toolUseId` where there is one, so a client
can scroll the transcript to what the notification was about. `requestId` is set for
the three ask types only.

**`read` is not stored on the row — it is computed for you.** A row records one thing
that happened; whether it is still news is a question about the reader, and the answer
is kept as a watermark per conversation. It is stamped on the response so that a
client rendering a list does not have to reimplement the comparison. `read` on the
envelope is that state itself — `{all: number, sessions: {sessionId: number}}`, all of
them epoch milliseconds — and the rule is
`read = row.at <= max(all, sessions[row.sessionId] ?? 0)`.

**`loud` means "this cleared the bar for interrupting somebody", not "a toast appeared
on your screen"** — the bridge cannot know whether you were looking straight at that
session, which is the one thing the page knows and it does not. `?scope=notable` (the
default) returns only the loud rows; `?scope=all` also returns the quiet ones — a
six-second turn, a subagent finishing — which nothing ever notified about but which
answer "what has been going on". `limit` defaults to 200 and is capped at 1000. Test
sessions are included on a dev bridge only, same rule as `GET /api/sessions`.

**`unread` counts the whole log, not the page.** It is the number of `loud` rows that
are not `read`, across every row the bridge holds — so a client can render the badge
from it directly rather than counting the rows it happened to fetch, which is what the
desktop UI used to do and why the badge quietly stopped being true past 300 rows.

`DELETE /api/notifications` empties the log and broadcasts `notifications-cleared`.
There is no per-row delete. It does not touch the read watermarks, and does not need
to: with no rows left there is nothing for them to apply to.

### `POST /api/notifications/read`

Mark rows read. Two gestures, and the body says which:

```json
{ "all": true }              // I have seen everything up to now
{ "sessionId": "…" }         // I have seen this conversation up to now
```

Returns `{ok: true, moved: bool, unread: number, read: {all, sessions}}`. **`moved`
is whether `unread` changed, not whether a watermark did** — repeating the call
advances the timestamp every time and that means nothing, whereas a loud row going
from unread to read is the only thing another client would have to repaint for. Every
navigation in the desktop UI posts a `sessionId` and most of them have nothing to
clear. Sending neither key is a `400`; it is not a third gesture.

**Watermarks are monotonic and never move backwards.** Re-opening a chat you were in
an hour ago cannot un-read the rows filed since, and two clients racing cannot undo
each other. A `sessionId` watermark covers that conversation only; `all` is a floor
under every conversation, including ones with no watermark of their own.

Allowed from a phone, unlike most write routes — see `docs/remote.md`. Marking
something read is the whole point of having History on a second device, and the worst
a hostile caller could do with it is clear a badge.

A move broadcasts `notification-read`. Nothing is broadcast when `moved` is false.

History is kept in `~/.local/share/claude-sessions/notifications.jsonl`, appended a
line at a time so that two bridges writing at once interleave instead of clobbering,
and pruned to 1000 rows or 14 days, whichever bites first. The watermarks live beside
it in `notification-reads.json`, which is rewritten whole — safe there, where it would
not be for the log, because the file is merged in before it is replaced and the later
of two timestamps always wins. Watermarks older than the log's own 14 days are dropped
on load; every surviving row is newer than one of those, so it could not have applied.

### `GET /api/suggestions?session=&project=&status=&limit=`

`{ suggestions: [task], ready: bool }`, newest first. A task is

```json
{
  "id": "toolu_…", "kind": "suggestion", "sessionId": "…",
  "ts": "2026-08-19T15:53:51.009Z",
  "title": "Task persistence", "why": "…", "prompt": "…", "cwd": "/home/…",
  "status": "open", "startedId": null, "at": 0,
  "archived": false,
  "session": { "title": "…", "projectName": "claude-sessions",
               "projectCwd": "/home/…", "worktree": null, "test": false }
}
```

Everything down to `cwd` is the offer, and is exactly what the `suggestion` event
carries — same fields, same parse, so a client can draw a row and an event with
one code path. Everything below it is the join: `status` is `open`, `started` or
`dismissed`, with `startedId` and `at` present only for a decision that was
actually taken. `?status=` filters on it and takes a comma-separated list
(`?status=open,started`); an unknown value is a 400 naming the three.

`?session=<id>` narrows to one conversation, which is what the aside beside a
transcript asks for — it reads these rows rather than lifting them out of the
event stream, so the panel and a cross-session view agree by construction.
`?project=` matches `projectCwd`, as on `GET /api/sessions`. Temp sessions are
left out and test sessions only appear on the development bridge, both exactly as
in the session list.

**A task from an archived session is still returned**, carrying `archived: true`
so a caller can group or dim it. *Dismissed* is already the gesture for "not
this"; if archiving hid tasks there would be two ways to dismiss, one of them
invisible, and an outstanding task is the loose end you most want to still find
after filing a conversation away.

**A task lives and dies with its transcript.** The offers are collected by the
index rescan — `scanMeta` puts them on `meta.suggestions`, and they are cached
under `CACHE_VERSION` with the rest of it — so this route reads no transcripts of
its own and holds no copy of one. Deleting a session therefore deletes its tasks,
and `prune()` drops their decisions with them. Keeping a task alive past its
session would mean writing `title`/`why`/`prompt` into state this app owns, and
content coming from anywhere but Claude Code's transcripts is the line the app
holds everywhere else (ROADMAP.md, *The three constraints*). What the index buys
is that a task is findable without its conversation being **open** — which was the
actual complaint — not that it outlives the conversation existing.

There is no push for a task being *filed*. A client watching one conversation
sees the `suggestion` event on its tail; anything watching all of them refetches,
and `sessions-changed` is the signal that the index moved.

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

### `GET /api/quota`

How much of the subscription quota is gone, and when it comes back. On a quota
plan `costUsd` in the transcripts is `0`, so this is the only answer to "can I
start another one of these".

```
{ version: 1,
  now: number,                     // unix seconds, the bridge's clock
  windows: [ { type, label, shortLabel, usedPercent, usedPercentAt,
               usedPercentSource, resetsAt, status, statusAt,
               isUsingOverage, overageStatus, overageResetsAt,
               overageDisabledReason, surpassedThreshold } ],
  events:  [ { type, label, from, to, usedPercent, at } ],
  statusLine: { present: boolean, capturedAt: number|null, path: string },
  beacon:  { enabled, suppressed, dir, everyMinutes, running,
             at, ok, reaped, reason, screen, ms } }
```

An **array**, not an object keyed by window — the order is meaningful (5-hour
first, then the weekly ones, then anything unrecognised) and a client should
render it as given.

| Field | Type |
| --- | --- |
| `type` | string — `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`, or `unspecified` for an event the CLI sent with no window named. **Not a closed set** — render an unknown one from `label` rather than dropping it |
| `label` / `shortLabel` | string — humanised (`5-hour` / `5h`). For an unknown `type` both are the raw id |
| `usedPercent` | **number 0–100, or null.** Null means nobody has said, which is *not* zero. Note the scale: the CLI's own `rate_limit_event` carries `utilization` as a 0–1 fraction and the bridge multiplies it here |
| `usedPercentAt` | number, unix seconds, or null — **when that percentage was true.** See below; it can be hours old |
| `usedPercentSource` | `"statusline"`, `"stream"`, or null |
| `resetsAt` | number, unix seconds, or null |
| `status` | `"allowed"`, `"allowed_warning"`, `"rejected"`, or **null when never observed.** Null is not "allowed" — a window the status line reported and no turn ever did has a percentage and no status |
| `isUsingOverage` | boolean |
| `overageStatus` | same three strings, or null |
| `surpassedThreshold` | number 0–1, or null — the threshold the account crossed |
| `events[].from` | string, or **null** for a window first observed already in trouble |

**`usedPercent` can be stale, and a client must show its age.** The percentage
has two possible sources and neither is continuous. The stream's
`rate_limit_event` only carries `utilization` once you are near a limit — on the
ordinary `allowed` path it sends a reset time and no percentage at all. The rest
of the time the number comes from `scripts/quota-statusline.py`, which harvests
`rate_limits.{five_hour,seven_day}.used_percentage` out of the Claude Code
status line — and the status line is rendered only by the interactive TUI, so
nothing this bridge spawns produces one. A day spent entirely inside the app
leaves the percentage frozen at whatever a terminal last saw, while `status` and
`resetsAt` stay current from the stream.

So: compare `usedPercentAt` against `now` and say how old the reading is.
`web/app.js` greys it past 30 minutes. Presenting an old percentage as current
is the one failure this shape exists to prevent — do not render a bare number.

`statusLine.present` is false when the harvester has never run, which is what
lets a client offer the setup step (`node scripts/install-quota-statusline.js`)
rather than showing an empty gauge.

**`beacon` says why the number is or is not moving**, and a client should show
it rather than leaving a stale reading unexplained. The beacon starts a
short-lived `claude` in a directory the user has named, purely so its startup
quota probe runs and the status line can be harvested — see `bridge/beacon.js`.

| Field | Type |
| --- | --- |
| `enabled` | boolean — on *and* pointed at a directory. Off is the default and means the percentage only refreshes while a terminal is open |
| `suppressed` | `"dev-bridge"` or null. A development bridge does not run the beacon even when `enabled` is true: the reading is account-wide, so the everyday instance owns the probe, and a worktree bridge doing it too spends quota to measure quota. `CLAUDE_SESSIONS_BEACON_ON_DEV=1` overrides it. When this is set, `at`/`ok` describe some older run and will not advance |
| `dir` | string or null — where it runs. The user names it in `~/.tgxcode/settings.json`, **user file only**: a project's `.tgxcode/settings.json` is checked into a repository and cannot set this |
| `everyMinutes` | number or null — floor of 5 |
| `running` | boolean — a run is in flight right now |
| `at` | number, unix seconds, or absent — when the last run finished |
| `ok` | boolean or absent. **Absent means it has never run**, which is not the same as failing |
| `reaped` | number or absent — beacons left behind by bridges that are no longer running, killed before this run started. Normally 0. A number that stays non-zero means something is still leaking them and is worth reporting; it is not a status to draw for its own sake |
| `reason` | string, present when `ok` is false — usually a timeout, meaning a dialog is waiting in a TUI nobody can see |
| `screen` | string or absent — a one-line readable tail of that TUI, so the dialog can be named. Escape sequences are stripped and it is capped at 400 chars |
| `ms` | number or absent — how long the run took. A healthy one is a few seconds |

A failing beacon is **not** an error condition for a client: the previous
reading stands and ages visibly. Draw the reason, do not raise anything.

**Readable by a remote caller**, deliberately: it names no session, no path and
no machine, and deciding from a phone whether there is room to release a draft is
the same case the draft routes are open for.

## The live channel

**SSE is best-effort. Polling is the guaranteed path.** Some transports buffer
server-sent events instead of passing them through, and they fail silently: the
request succeeds, the content type is right, and nothing arrives until the
connection closes.

Measured, so a client knows what it is defending against. A Cloudflare **named**
tunnel streams fine — 36 chunks over 75 seconds, `hello` at 0.29s. A Cloudflare
**quick** tunnel (`*.trycloudflare.com`) delivers **zero bytes in 75 seconds** on
the same bridge, holding the immediate `hello` and three pings, while ordinary
requests through it return in 60ms. Both strip the `X-Accel-Buffering: no` header
the bridge sets, so that header is not the lever and the origin cannot fix it.

A client that must work everywhere should detect this and fall back:

- **Detect** on `hello`. The bridge writes it the instant the stream opens, so on
  any working transport it lands in well under a second (0.04s on loopback). If it
  has not arrived in ~6s, the stream will not work at all. Do not try to detect
  this by watching for silence later: a comment line (`: ping`) is invisible to
  `EventSource`, so an idle-but-healthy stream is indistinguishable from a dead one.
- **Fall back** to polling `GET /api/overview`, `GET /api/sessions/:id?tail=0` for
  liveness, and `GET /api/sessions/:id/since?offset=` for new events. Measured
  through the same tunnel: ~60ms per call, 7KB for the board, **42 bytes** for an
  empty delta. 2.5s for the transcript and half that rate for the board is a
  measured-comfortable cadence.

Liveness becomes a couple of seconds granular rather than instant, which for "has
it finished, does it need me" is a distinction without a difference.

`GET /api/events` — SSE, `text/event-stream`. Then tell it what to follow:

```
POST /api/subscribe  { clientId, sessionId, offset, agent, overview, taskboard }
```

`clientId` comes from the `hello` event. One session followed at a time; `overview` and
`taskboard` are separate, orthogonal follows that stay on while a session is open, and
independent of each other — the two boards answer different questions and a window is
rarely reading both. Each has its own timer on the bridge, started only while somebody is
watching, and its own per-client change mark.

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
| `taskboard` | the task board; every ~3s while watched, and only when it has actually changed. Never carries `?idle=all` |
| `drafts-changed` | `{at, drafts[], counts}` — the whole `GET /api/drafts` payload, so there is nothing to refetch. **Not gated by a `POST /api/subscribe` flag**, unlike `overview` and `taskboard`: a draft only changes because somebody changed it, so there is no tick to switch on and every window gets every change. Fires on create, edit, delete, and on a start (which deletes one) |
| `schedules-changed` | `{at, schedules[], counts}` — the whole `GET /api/schedules` payload. Ungated, exactly as `drafts-changed` is. Unlike that one it fires **without anybody having done anything**: a schedule firing, skipping a slot, or having its outcome recorded when the turn ends all push it. So a client that assumed the payload only moves in response to a user action will be wrong here, and pleasantly so — this is how a card starts saying "ran 2h ago — BLOCK" while nobody is looking at it |
| `sessions-changed` | `{at}` — a nudge to refetch the list |
| `peer-message` | `{at, sessionId, from, count}` — another session messaged this one. The message itself is in the transcript, so a client tailing it has already drawn it; this is for everything that is not the open pane |
| `handoff` | `{at, sessionId, from, count}` — another session handed this one work, and it was resumed to deal with it. Same shape and same reasoning as above; watched in the transcript rather than reported by the route, so it fires when the message *arrived* rather than when it was queued |
| `suggestion-changed` | `{at, sessionId, toolUseId}` — a suggested follow-up was started, dismissed, or undone, possibly in another window |
| `session-deleted` | `{sessionId, title}` |
| `notification` | a whole notification row, just filed — the same shape `GET /api/notifications` returns, `read` included — plus `unread`, the badge count after this row. So an open history view need not refetch, and need not guess whether the new row counts |
| `notification-resolved` | `{id, outcome, outcomeAt}` — patch the row with that `id`; fired alongside `permission-resolved` |
| `notification-read` | `{sessionId: string\|null, at: number, unread: number}` — a watermark moved, here or in another window. `sessionId` is `null` when the whole log was marked. Fold `at` into your copy of `read` and repaint |
| `notifications-cleared` | `{at}` — the log was emptied, by this window or another |
| `runner-status` | see below |
| `permission-request` | `{sessionId, ...ask}` |
| `permission-resolved` | `{sessionId, requestId, outcome}` |
| `notice` | `{sessionId, level, kind, text}` |
| `quota` | **the whole `GET /api/quota` payload**, so there is nothing to refetch. Ungated, like `drafts-changed`. Fires only when a reading actually moved — the CLI sends an identical `rate_limit_event` on every turn and those are dropped rather than pushed. Note it carries **no `sessionId`**: quota is account-wide, and which session happened to observe it says nothing. A window that has been near a limit for an hour will therefore push nothing at all, which is why `usedPercentAt` matters more than the arrival time of this event |
| `turn-complete` | `{sessionId, isError, detail, retries, costUsd, durationMs, numTurns, stopReason}` — the runner's `lastResult` with the session id on it. `detail` is null unless `isError` |
| `send-failed` | `{sessionId, kind, message, unsent: [text]}` — a send that never became a turn; hand the text back to the user. `unsent` is an array of **strings**, in send order, and may be empty — the event still means the send failed, and `message` is then the whole of it. `kind` is one of `busy-elsewhere` (the session is running somewhere else; offer to branch), `no-claude`, `missing`, `unknown`, `exited` (the process ended without answering) or `retired` (the bridge shut the process down with messages still queued). Treat an unrecognised kind as `unknown`. Attachments are **not** carried: a message that had files comes back as its text alone |
| `session-forked` | `{from, to}` — follow the new id |
| `slash-commands` | `{cwd, at}` — that directory's slash commands changed; drop what you cached |
| `run-changed` | `{runId, workspace, commandId, label, state, port, exit, stopped, at}` — a project command moved; state only, never output |

`runner-status` is the full shape — the one the two narrower `runner` objects are cut
down from:

| Field | Type |
|---|---|
| `sessionId`, `model`, `permissionMode`, `cwd` | strings or null |
| `state` | `"stopped"`, `"starting"`, `"idle"`, `"busy"` or `"error"` |
| `activity`, `verb`, `detail` | strings or null — see below |
| `error`, `errorKind` | strings or null |
| `queued` | number — how many messages are waiting |
| **`queue[]`** | **array of objects** — `{id, text, at, attachments[]}`, the messages themselves, because the composer draws a chip per entry and needs the `id` to cancel or reorder it. `attachments` is metadata only; the base64 is read at flush time and never travels here |
| **`pendingPermission`** | **object or null** — the whole ask, same shape as `permission-request` |
| `canPrompt` | bool — whether this process supports permission prompts at all |
| `busySince` | number or null — epoch ms, and null unless `state` is `busy` |
| **`retry`** | **object or null** — `{attempt, max, status, at}` while the CLI is retrying a failing API call, which can run for minutes. Cleared when the turn lands |
| **`lastResult`** | **object or null** — `{isError, detail, retries, costUsd, durationMs, numTurns, stopReason}` for the turn that most recently finished |

**`activity` is the label to draw.** While a turn works it is composed of two
halves — `verb`, the themed spinner word, and `detail`, whatever is specifically
happening (`Reading runner.js`, `Writing…`) — giving `Percolating… Reading
runner.js`. Both are null outside a working state, and `verb` is null whenever
`spinner.randomize` is off, in which case `activity` is exactly what it was
before spinner verbs existed.

The halves are on the wire for one reason: a surface too narrow for the whole
label has to choose which half to keep, and it should keep the informative one.
The session rail is the only place in this app that does, at about twenty
characters; everything wider draws `activity` and can ignore both.

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

`{cwd, prompt, model?, permissionMode?, test?, attachments?}` →
`{sessionId, status, test}`.

`cwd` must be inside the allowed roots. `test: true` keeps it out of the everyday
window — use it for anything exploratory. `plan` is the sensible default mode for a
first message.

**`attachments` is an array of objects, not of strings**: `[{path}]`, where `path`
is the `path` a `POST /api/attachments` returned. `relPath` is accepted in its
place, and so is a bare string, but only the basename of whatever you send is
used — the directory is recomputed from `cwd`, so there is nothing for a `..` to
traverse out of. At most **five**; more is a `400`. Each one is re-checked against
that directory's `attached_assets/`, and **a file that no longer resolves is
dropped rather than refused** — losing a session because a staged file was tidied
away would be the worse outcome. The same rule and the same code as
`POST /api/sessions/:id/send`.

Because of that, `prompt` may be **empty** when `attachments` is non-empty: a
screenshot with nothing typed is a message. The check reads the request's array
rather than the resolved list, so a stale path does not turn into
`prompt is required`, which would be advice about the wrong field.

The first turn then carries the note naming each file *and* an inline image block
for each real PNG, JPEG, GIF or WebP within the inline budget — the same content
any later message gets. Before this field existed a session could not be started
with the screenshot that was the reason for starting it.

**`status` is a whole runner status object** — the `runner-status` payload, for the
process that was just started — not a word describing the outcome. Same on
`POST /api/sessions/:id/send` and on every queue write.

**The new id is not readable for a few seconds.** This returns as soon as the process
spawns, but `GET /api/sessions/:id` reads the transcript, and `claude` has not written
its first line yet — so the obvious client, navigate straight to the id you were just
given, gets `404 {"error": "session not found"}` about a session that is being created
perfectly well. Measured at roughly three and a half seconds on this machine, and it
is a race rather than a fixed delay. Either subscribe and wait for the first `tail`,
or retry the read on 404 for ~15s before believing it. The bridge already holds the id
against pruning for five minutes for the same reason (`note()` in
`bridge/sessions.js`), so a 404 in that window is "not yet", never "never".

`400` for a missing `cwd` or `prompt`, a directory that does not exist, or one outside
the roots; `403` for a refused `permissionMode` from a remote caller; `429` past 8
creates a minute.

### `POST /api/sessions/:id/send`

`{text, attachments?, model?, permissionMode?, fork?}` →
`{ok, id, cwd, fork, status, queued}`, where `id` is the id of the message and
`status` is a whole runner status object, not a word.

**Always send `permissionMode`.** An absent one normalises to `auto`, which means
omitting it does not mean "leave it alone" — it means "set it to auto", and would
quietly drop a session out of `acceptEdits` on every message.

A model or mode change replaces the process; queued messages carry across. `queued`
tells you whether the text is still recoverable on this side.

`attachments` is a list of files already uploaded through the route below —
`[{path, relPath?, mediaType?}]`, at most five. Each is re-derived against *this*
session's own attachments directory and dropped if it no longer resolves, so a client
cannot name a path by sending one. `text` may be empty when there is at least one
attachment: a screenshot with nothing typed under it is a message.

What the process receives is the text plus a trailing list of the paths, and an inline
image block for each attachment that really is a PNG, JPEG, GIF or WebP. The list is
parsed back off the message before the transcript renders it (`files[]` on the `user`
event above), so the paths are not shown twice.

### `POST /api/drafts`

`{cwd, prompt, model?, permissionMode?, test?, title?}` → `{draft}`, the row as
`GET /api/drafts` describes it.

**Validated exactly as `POST /api/sessions` is, at save time.** This is the part worth
knowing: the directory must exist, be a directory, and be inside the allowed roots
*now*, and a remote caller is refused `bypassPermissions` and `dontAsk` here and not
only when the draft is started. The reasoning is that a draft you cannot start is worse
than a refused save — it sits on the board looking ready and fails every time you press
the button, with nothing to say why it was ever accepted. `resolveWorkdir` in
`bridge/runner.js` is the same function the create route calls, so the two cannot come
to different verdicts.

`cwd` is stored **expanded**: send `~/thing` and the draft comes back with the real
path, because that is what will be handed to `spawn()`.

`400` for a missing `cwd` or empty `prompt`, a directory that does not exist, is a file,
or is outside the roots; `403` for a refused `permissionMode` from a remote caller;
`409` past **200 drafts**, which is a ceiling and not a lifetime budget — deleting one
makes room again.

An unknown `permissionMode` normalises to `auto` rather than being refused, as
everywhere else. An absent one does too, so **send it explicitly**: omitting it does not
mean "decide later", it means the draft is saved as `auto`.

### `PATCH /api/drafts/:id`

Any subset of `{cwd, prompt, model, permissionMode, test, title}` → `{draft}`.

**A genuine partial.** A field left out of the body is left alone; only what you send is
written. So saving an edited message does not restate the model and the mode, and cannot
silently reset them — which is the trap `POST /api/sessions/:id/send` has with
`permissionMode`, and the reason this is a PATCH rather than a second POST.

`null` is a value and absence is not: `{"title": null}` clears a title, `{}` changes
nothing but the timestamp. For `title` and `model` a whitespace-only string is stored as
`null`, since neither has a meaningful empty value.

Every field is validated as it is on create, so the refusals are the same — `400`, and
`403` on a remote caller's `permissionMode` — plus `404` for an unknown id. `createdAt`
is never touched; `updatedAt` always is, which is what moves the row to the front of the
list.

**The body is checked before the id is looked up**, so a refused mode is a `403` whether
or not the draft exists — the same order `POST /api/sessions/:id/send` uses, and for the
same reason: the refusal is about what this caller may ask for, not about what it aimed
at. A client that treats `404` as "wrong id" and `403` as "not allowed" therefore reads
both correctly.

### `DELETE /api/drafts/:id`

→ `{ok: true, id}`; `404` if there is no such draft.

A hard delete of a small file, and deliberately not offered a confirmation by the UI —
unlike a session, whose transcript cannot be reconstructed. Deleting twice is a `404`,
not an error worth handling.

### `POST /api/drafts/:id/start`

No body → `{sessionId, status, test}`, and **the draft is deleted**.

The same response as `POST /api/sessions`, because it *is* that call with its arguments
read off a file — and therefore everything documented there applies:

- **`status` is a whole runner status object**, the `runner-status` payload for the
  process just started, not a word describing the outcome.
- **The new id is not readable for a few seconds.** `GET /api/sessions/:id` will `404`
  while `claude` writes its first line. Subscribe and wait for the first `tail`, or
  retry the read for ~15s before believing it.

**The draft is deleted only after the process starts.** A failure leaves it exactly
where it was, which is the whole reason this is one route and not the client doing
create-then-delete: a directory moved since you saved it should cost you the press, not
the message you wrote. So a `400` here means *nothing happened* and the draft is still
listed.

Re-checked at start time rather than trusted from save time: the allowed roots are
configuration and a draft can outlive the setting that let it be saved, and a draft
saved at the machine must not become a way for a phone to start `bypassPermissions`.

`404` for an unknown id; `403` for a `permissionMode` this caller may not start; `400`
if the directory no longer resolves; `429` past 8 sessions started in a minute — the
same bucket `POST /api/sessions` draws on, because both spawn a process.

### `POST /api/schedules`

`{cwd, prompt, cron, once?, gate?, title?, model?, permissionMode?, test?, enabled?,
seed?}` → `{schedule}`, the row as `GET /api/schedules` returns it.

Validated exactly as `POST /api/drafts` is — `cwd` resolved and checked against the
allowed roots, `permissionMode` normalised — plus the two of its own:

- **`cron` must parse *and* match some future date.** `0 0 30 2 *` is syntactically
  fine and fires on February 30th, so it is refused with `400` rather than saved as a
  card that reads "next run: never" for a month.
- **`gate`, when given, must be whole.** `{kind: "git-commits", ref}` with `ref`
  non-empty; `fetch` defaults `true`. `{kind: "open-prs"}` needs nothing beyond the
  kind — `includeDrafts` and `post` both default `true`. An unknown `kind` is `400`,
  not silently dropped: a gate that quietly became "no gate" would turn a schedule
  that reviews new commits into one that starts a session every night regardless.

**A gated schedule resolves its ref before it is stored**, and a ref that cannot be
resolved is a `400`. That is what seeds `lastMarker`, so the first run reviews what
arrives *after* you set the schedule up. It also means a typo'd `orgin/main` costs you
the save rather than a month of silent "nothing new".

`permissionMode` defaults to `auto` as everywhere else. The refusal a remote caller
gets on `bypassPermissions` and `dontAsk` applies here too and matters more: a schedule
in one of those modes is an unattended agent with no permission gate, starting itself
every night. `403` with `{error, remote: true}`.

`once` defaults `false` and is **not** checked against the expression. `once` on a
repeating cron is coherent — it runs at the next slot and stops — and a dated
expression without it is an annual schedule, which is a real thing to want. Nor can a
date in the past be refused here: `0 17 29 8 *` saved on the 30th of August matches
next August, so the bridge sees a perfectly good expression that fires in eleven
months. **A client offering a one-time schedule should refuse a past date itself**,
while it still has the date somebody picked rather than a cron expression that has
forgotten the year.

**An `open-prs` schedule is seeded the same way, and for a sharper reason.** The
create call lists the repository's open pull requests and records each one at its
current head, so the first run reviews what arrives *afterwards*. Without it,
pressing Save would start a review session for every pull request already open —
five, on a machine where that is a normal number. `seed: "all"` asks for exactly
that instead, which is how you say "review everything I have open right now". A
`cwd` with no GitHub origin, or a repository `gh` cannot list, is a `400` rather
than an empty seed: a schedule that cannot see the repository is one that reports
"nothing new" every night and never says why.

`409` at 50 schedules. `400` if the directory does not resolve.

### `PATCH /api/schedules/:id`

The same fields, all optional; anything absent is left alone. `→ {schedule}`.

**The run history is not writable here.** `lastMarker`, `runs`, `lastSessionId` and the
rest are ignored if sent — "which commits have already been reviewed" is not something
a client gets to decide, and a PATCH that could rewind the marker would silently make
the next run re-review a month of work.

`enabled: false` pauses without deleting. `enabled: true` **moves the slot cursor to
now**, so a schedule arming after a fortnight off does not immediately fire for every
slot it slept through. No other field does that: an unrelated edit at 01:59 must not
cancel the 02:00 run. That cursor reset is also what makes a spent `once` schedule
re-armable: turning one back on starts it from now, not from the slot it was spent
for — though it will then next match a year later, which is why re-arming one is
usually a matter of editing its date.

Validation runs *before* the id is looked up, so a refused mode is `403` whether or not
the schedule exists — the order `PATCH /api/drafts/:id` uses, and for the same reason.
`404` for an unknown id.

### `DELETE /api/schedules/:id`

`→ {ok: true, id}`, or `404`. Takes the run history and the marker with it, so
recreating the same schedule afterwards starts its range from scratch. `web/app.js`
confirms first for that reason, where it does not for a draft.

### `POST /api/schedules/:id/run`

`→ {sessionId, sessionIds[], deferred, test, schedule}`. Start a run now, whatever
the clock says.

**`sessionIds` is the real answer and `sessionId` is kept for compatibility.** A
pull-request gate starts one session per PR, so a single id cannot describe what
happened; `sessionId` is `sessionIds[0]` so a client written against the older shape
gets a session it can open rather than `undefined`. `deferred` counts pull requests
that were due but did not fit this run's budget — they drain on the ticks that
follow, so a non-zero `deferred` is progress rather than a failure.

**The same function the tick calls**, which is the point: what this produces is what
tonight would have produced, so it is a trustworthy way to check a schedule before
leaving it alone. Two differences, both deliberate:

- **The gate is skipped**, and when there is nothing new `{{range}}` falls back to
  `<head>~1..<head>` rather than coming out as the empty `<head>..<head>`. You pressed
  a button, so something should happen — and a session told to review an empty range
  correctly reports that there is nothing there, which makes the button useless in the
  two cases anybody presses it. `{{count}}` reads as `the new` in that case rather than
  claiming a number.
- **`lastSlotAt` is not touched**, so tonight's scheduled run still happens.

It does **not** skip the permission-mode refusal or the rate limit. `lastMarker`
advances exactly as a scheduled run's does — otherwise pressing this would make the
next scheduled run re-review the same commits.

`403` `{error, remote: true}` for a mode a remote caller may not start, `429` past the
create limit, `400` for a directory or ref that no longer resolves, `404` for an
unknown id. Every failure is also recorded on the schedule as `lastSkipReason`, so the
card says what happened even if the response was lost.

### `POST /api/restart`

`{force?, pull?}` → `200 {ok, restarting, pid, port, force, pulled, reach, warnings,
detached, log, journal}`. **Local callers only.** Fast-forwards the checkout this
bridge is serving and hands over to `scripts/restart-bridge.sh`.

**A `200` does not mean it restarted.** It means the script was launched and this
process is about to be killed by it. Nothing can report the outcome, because the
process that would report it is the one being replaced — see §*Things that will bite*
for what to poll instead.

`pulled` is `{ok, skipped, out, error, before, after, changed}` — `before`/`after` are
SHAs or `null`, `changed` is an array of repo-relative paths, `error` is a string or
`null`. `reach` is `{bridge, web, shell}`: three booleans saying whether what arrived
needs a restart at all (`bridge/`), was already live (`web/`, read per request), or
needs a rebuild nobody should run unasked (`app/`, `package.json`). `warnings` is
`{terminals, runs}` — counts of things that die with the bridge. `detached: true` says
the replacement comes back in its own session, so a bridge that `npm run dev` was
watching can no longer be stopped with Ctrl-C in that terminal. `log` and `journal`
are paths on the machine.

`409 {blocked: true, pulled, problems}` when something is in the way. `problems` is an
array of `{kind, text, files?}`, `kind` one of:

| `kind` | what it is | `files` |
|---|---|---|
| `busy` | turns in flight; a restart ends them | — |
| `dirty-bridge` | uncommitted tracked files under `bridge/`, which a restart would load | repo-relative paths |
| `pull` | `git pull --ff-only` failed; `text` is git's own stderr | — |
| `not-a-repo` | the checkout cannot be read as one | — |

**On a `409` nothing was restarted — but the pull may have succeeded.** `pulled` is
`null` when it was never attempted (something was already in the way) and an object
when it ran, so a client must read it rather than assuming a refusal means nothing
happened. Only `bridge/` counts for `dirty-bridge`: the bridge `require()`s it once at
startup, while `web/` is read per request.

`force: true` means one thing — **go ahead with turns in flight**. It is not a general
override: uncommitted `bridge/` changes are always loaded, because a script started
from a route has no terminal to answer the confirmation at. With `force` there is no
`409`; a failed pull is reported in `pulled` and the restart happens anyway.

`pull: false` skips the fast-forward and restarts on what is already on disk. Sensible
after watching a pull fail, and for a worktree bridge on a branch with no upstream.

`409 {error: 'not the bridge you started', pid}` for a `?pid=` that is not this
process, and `409 {error: 'a restart is already running'}` for a second call — two
would be two kills racing for one port. `500` if the pull removed the script.

### `GET /api/restart`

`→ {pid, port, root, worktree, busy, journal}`. **Local callers only.** `journal` is
up to the last 20 lines of `~/.cache/claude-sessions/restart-<port>.log` as strings.

This exists for the case a `POST` cannot report: a restart that refused. The script's
own turn-in-flight guard is still armed on every invocation, so a turn starting between
the route's check and the script's own means it exits without restarting — this process
lives, no `pid` changes, nothing drops, and the only record is that file. Whichever
bridge is up serves it.

### `POST /api/sessions/:id/handoff`

`{from, text, title?}` → `{ok, id, sessionId, cwd, woke, status, queued}`. **Local
callers only.**

One session telling another something it needs to know, and waking it to deal with
it. Reached by the `message_session` tool in `bridge/mcp.js`; `:id` comes from
`GET /api/sessions/addressable`.

The wake itself needed nothing new — `pool.ensure` has always spawned
`claude --resume` when there is no process, so `/send` could do this already. What
was missing was an address an agent could use, since a peer name only exists while a
process does. So this is `/send` with four differences, and they are the reason it is
not a flag on `/send`:

- **The mode is not the caller's to choose.** Forced to `plan`, so a woken session
  comes back with a plan for you rather than editing a checkout nobody is watching.
  There is no `permissionMode` field to send.
- **Refusals a person would never hit.** `400` for handing work to yourself (checked
  before the lookup, so the answer cannot be used to ask which ids are real), `409`
  for a target whose `state` is `elsewhere` — which `/send` only discovers by failing
  a spawn a few seconds later.
- **A rate limit**, `429`: one handoff per sender-recipient pair per minute, twenty
  an hour across the bridge. The sender is a model and the recipient can send back,
  so a ping-pong is a real failure mode rather than a theoretical one. See
  `bridge/handoff.js`.
- **The message is wrapped**, in `<session-handoff>`, so it renders as work arriving
  rather than as something you typed. See `handoffEnvelope` in `bridge/transcript.js`.

`woke` says whether this resumed a stopped session or joined one already up — the one
thing the sender cannot work out for itself.

**A handoff that did not land is not reported as delivered.** `502` when the wake
failed — a session id still locked by a process that was killed, a transcript another
writer holds. This is the one place the route waits: when the send is what started
the process it watches the runner for about five seconds and answers with what
happened. `/send` needs none of that because a person gets their text back in the
composer and can try again; the session that sent a handoff is finishing its turn and
is about to tell the user it passed the work on, so a silent drop is the worst
outcome available.

`from` is **provenance, not authority**. It is whatever the sending session was
started as, so a session that has forked since reports the id it began with. Nothing
downstream uses it to find a session; an unknown one is carried through rather than
refused, and the card simply shows no sender.

Every refusal here is phrased for the model that will read it, because that is who
reads it — a body that only says `429` leaves an agent with nothing to do but try
again.

### `POST /api/sessions/:id/attachments?name=…`

Raw file bytes, one file per request, `Content-Type` as a hint —
→ `{ok, name, path, relPath, dir, bytes, mediaType, renamed}`.

Not JSON: `readJson` caps a body at 4MB and base64 is a third larger than what it
encodes, which would put the real limit under 3MB. The cap here is **25MB**, answered
from `Content-Length` before the bytes travel where the client sent one.

The file is written to `attached_assets/` at the root of the checkout the session is
working in — the *worktree* root for a worktree session, not the checkout that owns it.
`attached_assets/` is added to the owning checkout's `.git/info/exclude` on first write,
which is local and untracked; no `.gitignore` is ever edited. Nothing prunes the
directory.

`name` is refused rather than sanitised — no separator, no `..`, no control character,
200 bytes — but a leading dot is allowed, unlike `/api/fs/mkdir`, because nothing
browses this directory. An existing name is never overwritten: `shot.png` becomes
`shot-2.png` and `renamed` says so, so a client can relabel its chip.

`mediaType` is sniffed from the bytes, not taken from `Content-Type`, because it is what
decides whether the turn carries an inline image block.

`413` is the cap. `403` is a directory outside the allowed roots, or a remote caller.

### `POST /api/attachments?cwd=…&name=…`

The same upload, for a composer whose session does not exist yet — the
Start-a-session dialog. Raw bytes, and the identical response.

Addressed by path because there is nothing else to address it by. The session form
above uses the id only to *find a working directory*; that is the whole of what
decides where the file goes, so this form supplies it directly. Everything from the
directory onward — the roots check, the rename-on-collision, the `.git/info/exclude`
entry, the sniffed `mediaType` — is the same code, not a second copy of it.

`cwd` is expanded (`~` works) and must be inside the allowed roots (`403`), must
exist, and must be a directory (`400` for either). That last pair matters here and
not on the session form: a session id names a directory the bridge chose, and a
`?cwd=` names one the caller typed.

`name` is checked **before** `cwd` is looked at, so a request carrying both a bad
name and a bad directory is refused for the name. `400` for a missing `cwd`, `413`
for the cap, `403` for a remote caller.

**The order a client wants is upload, then create.** Stage each file here, then pass
the returned `path` in `POST /api/sessions`'s `attachments`. There is no way to add
a file to a session's first message after the session exists, because that message
has already been sent.

Drafts and schedules do **not** carry attachments: neither `POST /api/drafts` nor
`POST /api/schedules` accepts the field, and neither record stores it. So the claim
that a draft is exactly the body of `POST /api/sessions` is now one field short, and
this is the field. A client that wants a file on a session it is setting up for later
has to attach it at the moment it starts it.

### `POST /api/sessions/:id/attachments/open`

`{path}` → `{ok, path, file}`. Opens the file in whatever the Windows host opens that
kind of file with. Only the basename is taken from the caller; the directory is
recomputed, so `404` means "not one of this session's attachments" rather than
"missing". Local callers only.

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
| `POST /api/sessions/:id/stop` | `{hard?}` | `{ok, how, dropped[]}` — see below |
| `GET/DELETE /api/sessions/:id/queue[/:qid]` | | inspect, drop one, clear |
| `POST /api/sessions/:id/queue/reorder` | `{ids}` | |
| `POST /api/sessions/:id/flags` | `{pinned?, archived?, test?}` | |
| `GET /api/sessions/:id/suggestions` | | `{sessionId, suggestions}` — the decisions alone. `GET /api/suggestions?session=` is the offers *and* the decisions |
| `POST /api/sessions/:id/suggestions/:toolUseId` | `{status, startedId?}` | `status` of `started`, `dismissed`, or absent to undo |
| `DELETE /api/sessions/:id` | | hard delete; `409` if a turn is running |
| `GET /api/fs?path=` | | directory picker; roots-scoped |
| `POST /api/fs/mkdir` | `{parent, name}` | one new folder; roots-scoped, local callers only |
| `GET /api/pairing` | | local callers only — what this machine is reachable as |

`POST /api/sessions/:id/stop` answers `{ok, how, dropped}`. `404` when the session
has no runner at all. Otherwise `how` says what actually happened, and the three
values are not interchangeable:

- `soft` — the CLI was asked to interrupt itself. The turn stops, the process stays
  alive, and the session is resumable. Escalate by posting again with `hard: true`.
- `hard` — SIGTERM then SIGKILL, possibly mid-tool-call.
- `null` with `ok: false` — **there was no process to stop.** Not an error: the
  session's process had already gone, and a client should say so rather than
  claiming a kill. It still matters, because `dropped` can be non-empty here.

`dropped` is an array of **strings** — the text of the messages that were still
waiting, in send order. Never the turn that was in flight, which is already in the
transcript. Attachments do not come back with them even though the files are still
on disk. They have been taken off the queue, so a client that does not put them
somewhere (the composer, a draft) loses them; that includes the `how: null` case,
which is the one where a session looked stuck and Stop was the obvious thing to
press.

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

**A command tends to get the same port back.** Where a port is allocated it is
not simply the lowest free one in the range: the port that command last had wins
if it is still free, and a port another worktree has a claim on — its own
remembered port, a live or recent run record, or a DevBrowser tab carrying its
name — is passed over while anything else is available. A claimed port that
nothing is listening on is still used rather than refused, since a stale claim
should not stop a server starting. So `port` in the record is stable across a
stop and start, and a client should not assume the bottom of the declared range.
See `bridge/ports.js`.

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
- **SSE over HTTP/1.1, not WebSockets** — with a polling fallback, not a protocol
  change, when a transport buffers it. It is what the bridge speaks, and it is
  what survives an HTTP proxy. (One caveat: see the `cloudflared` buffering bug in
  `docs/remote.md` — it is a reason to pick a transport, not to change protocol.)
- **`?tail=N` on open, `/since?offset=` to resume.** Never refetch a whole
  transcript on reconnect.
- **No dependency on the Electron shell.** There is exactly one native method
  (`app/preload.js` → `revealWindow`) and both of its call sites are already
  feature-guarded. Everything else comes over HTTP.
- **Push is not built.** When it is, it is FCM from the Android app, which needs the
  HTTPS origin that `docs/remote.md` sets up. Until then, a
  client only learns about an ask while it is connected — and see *Being connected
  is load-bearing* above for why that matters more than it sounds.

## Things that will bite

**The write surface 403s without `X-Claude-Sessions-Client: 1`.** Reads work, writes
do not, and the message says `missing client header` rather than anything about auth.
See §*Authentication*.

**A newly created session 404s for a few seconds.** `POST /api/sessions` hands back an
id before `claude` has written a transcript to read. See §`POST /api/sessions`.

**Deleting a session whose process is still shutting down.** `DELETE` unlinks the
transcript, but an exiting `claude` may then write its bookkeeping (`last-prompt`,
`ai-title`) back to the same path — and the session reappears as an empty row with
0 turns. Stop it, wait, then delete; or delete twice.

**A tool call is not final when you first see it.** It arrives with `status:
"pending"` and no `result`, and resolves later — either as a second copy of the same
`tool` event, or as a separate `tool-result` event when the call was in an earlier
chunk. Anything keyed on first sight, or handling only the first of those two shapes,
will show a permanently spinning tool. See §*A tool call resolves in one of two ways*.

**`runner` on a session summary is not the `runner-status` payload.** Four fields, and
`pendingPermission` is not among them. See §`GET /api/sessions`.

**A restart has no completion event.** The process that would send one is the process
being replaced. After a `200` from `POST /api/restart`, poll `GET /api/health` until
`pid` differs from the one the `200` returned — allow 45s, since the script waits 30s
for the replacement to answer. A `pid` that never changes does not mean it is still
working: it means the script decided not to restart, and `GET /api/restart` carries the
journal line saying why. See §`POST /api/restart`.
