# The bridge API

What a client needs to know to talk to the bridge. `web/app.js` (desktop) is one
client; the native Android app in `~/Other/tgxcode-mobile` is the other, and this
document exists so that it is a *client* rather than a rewrite.

There used to be a third — a phone-shaped web page at `/m` — and it is gone. The
phone surface is the Android app now, so a feature the phone needs is a field in
here, not a page in `web/`.

Anything a client needs and cannot get from here is a gap in the API, and belongs
fixed here rather than worked around in the client.

**The app was called Claude Sessions until the rename to TGXCode.** Every name a
client can see changed with it, and every old one is still accepted, so a client
built against the old names keeps working:

| Was | Is | Old name still… |
|---|---|---|
| `X-Claude-Sessions-Client: 1` | `X-TGXCode-Client: 1` | accepted by the CSRF guard |
| cookie `cs_token` | cookie `tgx_token` | read; never set; expired by `/pair/forget` |
| `~/.local/share/claude-sessions/` | `~/.local/share/tgxcode/` | a symlink to the new directory |
| `CLAUDE_SESSIONS_<X>` variables | `TGXCODE_<X>` | read when the new one is unset |
| `/api/health` `app: "claude-sessions"` | `app: "tgxcode"` | reported by an older bridge |
| `<meta name="cs-token">`, `cs-prefs`, `cs-keymap`, `cs-host` | `tgx-token`, `tgx-prefs`, `tgx-keymap`, `tgx-host` | read by `web/` beside the new |
| MCP tools `mcp__claude-sessions__*` | `mcp__tgxcode__*` | in transcripts written before it |
| `live.entrypoint` `"claude-sessions"` | `"tgxcode"` | on sessions started before it |

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

A token is created on first run at `~/.local/share/tgxcode/token`
(mode `0600`), 32 random bytes as base64url. Every `/api/` route requires it except
`GET /api/health`.

Three accepted forms, and **any one of them being valid is enough** — a stale
credential in one slot does not shadow a good one in another:

| Form | Use |
|---|---|
| `Authorization: Bearer <token>` | The normal one. What an Android client should send. |
| `?token=<token>` | For `EventSource`, which cannot set headers. In practice only used by the pairing handshake. |
| `Cookie: tgx_token=<token>` | What browsers use after pairing. `cs_token`, the name from before the rename, is still read but never set. |

Failure is `401` with `{"error": "unauthorized", "hint": …}`.

### `X-TGXCode-Client: 1` on every write

**Every non-GET `/api/` route except `/api/health` also requires the header
`X-TGXCode-Client: 1`**, and refuses without it with
`403 {"error": "missing client header"}`. It is checked before the token, so a
request that is missing it fails the same way whether or not the token was good.

**`X-Claude-Sessions-Client: 1`, the name from before the rename, is accepted in its
place** — either one satisfies the guard. A client should send the new one. The
desktop's own clients send both for now, because a bridge started before the rename
only knows the old name and `web/` goes live before that bridge restarts; a client
that must talk to such a bridge can do the same.

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
`.ts.net` name, a bare IP address, and anything in `TGXCODE_ORIGINS`
are recognised; a name that resolves to `127.0.0.1` from somewhere else is the
DNS-rebinding case this closes. A client reaching the bridge through a proxy on a
new hostname needs that hostname in `TGXCODE_ORIGINS` — the symptom is a 403 that no
amount of correct token fixes.

### Pairing a device

```
GET /pair?token=<token>   →  303 to /, Set-Cookie: tgx_token=…; HttpOnly; SameSite=Lax; Max-Age=31536000
POST /pair/forget         →  303, both tgx_token and the old cs_token expired
```

`Secure` is added when the request arrived over HTTPS (or the host is a `.ts.net`
name). This is what keeps the token out of URLs and history after the first open.

A native client does not need the handshake — it should store the token and send the
header. **It does still depend on this URL's shape**, because pasting the link the
desktop's *Settings → Connect a phone* builds (`<origin>/pair?token=<token>`) is how the
token gets onto a device at all. Parse the token out of the query and never fetch the
route. The `303` target is the desktop page and means nothing to a native client; it
was `/m` until the phone web view was removed, so do not key on it.

### Local browsers

A page fetched over loopback with no `Origin` is served with the cookie set and the
token injected as `<meta name="cs-token" content="…">`. That is why nothing in
`web/` sends an explicit credential.

A local page is also served `<meta name="cs-host" content="…">`: URI-encoded JSON
`{distro: string, home: string}` — the name of the WSL distribution the bridge runs
in, and its home directory. It is there so a client can build the
`\\wsl.localhost\<distro>\home\…` form of a Linux path for a link's `href` and hover
text, and it is for **display only**.

The tag is **omitted entirely for a remote caller**, and omitted when the bridge is
not running under WSL. The reasoning is `/api/health`'s for `root` and `home`: a path
on this machine is not something an off-machine client can act on, and
`POST /api/fs/open` refuses it anyway. A client that does not find the tag should
render paths as plain text rather than guess a distribution name.

The translation that is *acted* on is never this one — see `POST /api/fs/open`.

### The host the bridge opens files on

The bridge runs on Linux either way — it is a Linux process under WSL too, so
`process.platform` is `linux` on both — but what it can hand a path to is not the
same, and four routes differ because of it:
`POST /api/fs/open`, `POST /api/sessions/:id/open-file`,
`POST /api/sessions/:id/reveal` and `POST /api/sessions/:id/attachments/open`.

| | WSL | Linux |
|---|---|---|
| Opens a file with | `explorer.exe` | `xdg-open` |
| Reveals a folder with | `explorer.exe` | `xdg-open`, or `org.freedesktop.FileManager1` to select a file |
| Path handed over | `wslpath -w` output | the Linux path unchanged |
| `cs-host` meta tag | served | not served |
| Unregistered file type | `200`, Windows shows its own dialog | `502`, nothing opened |

**There is no route that reports which host this is**, and adding one has been
deliberately avoided: `cs-host` already distinguishes them for the only purpose a
client has — whether to draw a Windows path — and a second signal would be one more
thing to keep true. A client should branch on the presence of `cs-host`, or better,
on nothing at all: every field above is well-defined on both hosts, and a client that
renders `path`/`winPath` as opaque text is correct on either.

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
`permissionMode` of `bypassPermissions` or `dontAsk` on create, on send, on
**saving or starting a draft**, and on **saving a snippet**; all
of `/api/terminals/*`; all of `/api/runs/*`; `POST /api/commands/run`; all of
`/api/commands-config*`;
`/api/shutdown`; `/api/restart` (both methods); `POST /api/claude-version/update`; `/api/devservers/stop`; `/api/devbrowser/*`;
`POST /api/sessions/:id/reveal`; `POST /api/sessions/:id/open-file`;
`POST /api/sessions/:id/handoff`; `POST /api/fs/mkdir`;
`POST /api/fs/open`;
`POST /api/wispr/press`;
`PUT /api/prefs`;
**every method of `/api/claude-config` and anything under it, the GET included**;
**every method of `/api/claude-docs` likewise**;
both attachment uploads — `POST /api/sessions/:id/attachments` and
`POST /api/attachments`.

The draft routes are otherwise fully open to a remote caller, deliberately: setting
work up at the desk and releasing it from a phone when quota frees up is the case the
feature exists for. What a phone cannot do is *widen* a mode — the check runs when the
draft is written and again when it is started, so a `bypassPermissions` draft saved
locally still refuses to start remotely.

The snippet routes are open on the same reasoning and with the same one exception,
and the exception matters more here. A snippet may carry `autoSubmit: true` together
with a `permissionMode`, and those two together are a single pinned toolbar button
that sets the mode and sends — which is exactly the "one tap away on a phone that
might be in someone else's hand" the refusal exists for. So a phone may write, edit,
reorder and delete snippets freely, and may not save one naming either of the two
modes. It is refused twice over: here, so the snippet cannot be stashed, and again by
`POST /api/sessions/:id/send` when it is used.

Note that `PUT /api/prefs` above is local-only and the snippet routes are not, which
looks inconsistent and is not. That route is refused because it writes a file in the
user's home directory or inside a checkout, and one of its keys names a directory the
app then starts `claude` in. Snippets are written to the state directory, execute
nothing, and their `projects` list is a display filter.

`/api/prefs` has the same shape of asymmetry, and it is on the method rather
than the path: reading how somebody wants a transcript folded is not a
capability, and a phone has a use for the answer. *Saving* is the `mkdir` clause
with a longer reach — it writes a file in the user's home directory, and one of
the keys in it names a directory this app then starts `claude` in.

**`/api/claude-config` is the one route family where the read is refused too**,
and the contrast with `/api/prefs` is deliberate rather than an oversight. Those
files are Claude Code's own: they name hook commands, permission rules and the
*values* of environment variables, and no client that is not on this machine
configures the CLI — so there is nothing to weigh against caution, and a leaked
token should not be able to read them. The refusal is on the **prefix with no
method test**, so anything added under it later is refused by default rather
than by somebody remembering to. If a phone ever needs one of these reads, the
answer is a narrower route, not a deleted refusal.

`/api/claude-docs` is refused on the same terms, and the argument only gets
stronger: a project's `CLAUDE.md` is repository source, and a user's describes
the machine — what is installed, which ports are in use, which instance not to
touch. Being able to *write* one is the ability to change what every session on
this machine is told before its first message, which is a larger capability
than any single setting on the route above.

`/api/commands-config` — the editor for those same files — is refused on the
prefix instead, **both methods**. The merged read stays open because what a
project declares is in its repository already and that payload has never carried
`env`; the raw read serves `commands.local.json`, which is the private file where
an environment variable with a token in it actually lives.

Note the asymmetry around `/api/fs` and `/api/commands`: `GET /api/fs` and
`GET /api/commands` stay readable remotely, so those refusals are on the exact path
rather than the prefix. Reading the tree answers "where could a session start", and a phone may
already start one; reading what a project declares gives away nothing that is not
in its repository. Creating a directory, or running one of those commands, is
reaching past the app into the machine.

`GET /api/sessions/:id/diff` is the same shape of asymmetry one route further
down: `POST /api/sessions/:id/open-file` beside it is refused and the diff is not,
because launching a Windows program is reaching past the app into the machine and
reading a diff is not. It is repository-scoped rather than only roots-scoped, which
is what makes that safe to say.

`GET /api/slash-commands` is readable remotely for the same reason, and is a
different route from `GET /api/commands` despite the name — one is what the CLI
will accept in the composer, the other is what the repository declares in
`.tgxcode/`. It is still roots-scoped, so a `?cwd=` outside them is refused for
every caller.

**For every caller:** a session may only start inside `TGXCODE_ROOTS`
(default `$HOME`); `/api/fs` lists and `/api/fs/mkdir` writes only inside the same
roots; `GET /api/sessions/:id/diff` and `POST /api/sessions/:id/open-file` reach
only inside those roots **and** only inside the session's own repository root;
session creation is capped at 8 per minute (`429`). A leading `~` in any
path — a session's `cwd`, `/api/fs?path=`, a mkdir `parent` — means `$HOME`, as it
would in a shell.

## Reading

### `GET /api/health`

The only unauthenticated route. Counts, a pid, and:

```json
{ "ok": true, "app": "tgxcode", "version": "1.0.0", "port": 45888, "dev": false,
  "remote": false, "authRequired": true,
  "permissionModes": ["auto","acceptEdits","plan","manual","dontAsk","bypassPermissions"],
  "sessions": 120, "clients": 1, "live": 4, "busy": 3, "atRisk": 0,
  "sessionHost": { "pid": 5031, "protocol": 1, "startedAt": 1790098455020, "attached": 3 } }
```

`app` is the string `"tgxcode"` — `"claude-sessions"` from a bridge that predates the
rename. `busy` is a number: turns in flight. `atRisk` is a number, never more than `busy`:
the turns a restart of this bridge would **end**. A turn running in the session host
(`bridge/host.js`) survives a restart and is picked up by the next bridge on the same
port, so it counts in `busy` and not in `atRisk`. Anything deciding whether a restart
is safe should read `atRisk`, and fall back to `busy` when the field is absent, since
that is an older bridge with no host.

`sessionHost` is **an object or null**: `{pid, protocol, startedAt, attached}`, where
`pid` and `startedAt` (epoch ms) belong to the host process, `protocol` is a number and
`attached` is how many processes this bridge is relaying through it. `null` means this
bridge starts `claude` directly, the way every bridge did before the host existed, so
every busy turn is at risk. See §*A bridge restart does not end a turn* under *Things
that will bite*.

`root` and `home` are included only for local callers. Read `permissionModes` rather
than hardcoding the list; a remote client should drop `bypassPermissions` and
`dontAsk` from what it offers, because the bridge will refuse them.

`todoTools` is a boolean: whether this bridge sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
on the sessions it starts (`TGXCODE_TODO_TOOLS=0` in front of the bridge turns
that off). It is worth reading before drawing an empty task list as "no tasks": Claude
Code stopped offering the task tools to current models by default, so `false` means a
session's list will usually be empty for that reason rather than because the agent chose
not to keep one. It says nothing about sessions this bridge did not start — one run from
somebody's own terminal keeps no list unless they set the variable themselves.

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
| **`later`** | **object or null** — `{pending, nextAt}`, both numbers; see below |
| `prs` | array of `{number, url, repo}`, empty if none |
| **`live`** | **object or null** — see below |
| **`runner`** | **object or absent** — five fields only, see below |

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

**`later` is the count and the clock, not the messages.** `{pending, nextAt}` when this
session has messages waiting to be delivered to it — the number still `pending`, and the
epoch ms of the soonest — and **`null`** when it has none, which is nearly every session.
It is here so a rail can say "something arrives here at 02:00" without a second fetch,
since opening the session is the one thing nobody is going to do at 02:00. The messages
themselves are `GET /api/sessions/:id/later`.

Note the shape of the staleness: this is computed per request, but the session list is
not pushed when a message is delivered — `later-changed` is. So a client that draws a
badge from this field and never refetches will show a message that has already gone.
`web/app.js` draws its badge from the `later-changed` payload instead and leaves this
field for clients that fetch sessions and nothing else.

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
`"vscode"`, `"tgxcode"` (us — `"claude-sessions"` on a session started before the rename), …; `name` is the session's *address* for
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
| `GET /api/sessions` · `GET /api/dashboard` | **five fields**: `{state, activity, detail, queued, claudeVersion}` |
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
| `user` | `text` string · `images[]` `{mediaType, dataUri}` · `files[]` `{relPath, name, size}` · **`command` object or null** — `{name, args}` · `origin` string or absent — Claude Code's own `origin.kind`, passed through: `"human"`, `"peer"`, or an agent type. Not a closed set the bridge controls, so treat anything other than `"human"` as "not the person" rather than switching on it. A message **folded into a running turn** is a `user` event too, even though on disk it is a `queued_command` attachment with no `user` entry. It sits between the tool calls where the turn read it, its `ts` is when it was *sent* (so it can be earlier than the tool block before it), and its `origin` is `"human"` or absent |
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
backgroundTaskId, answers, plan, planWasEdited}`. `text` is the tool output flattened
to a string and is the one to show; `stdout`/`stderr`/`filePath` are strings or null;
`interrupted` is a bool.

**`tool.result.patch` is a structured diff, not a string** — the `structuredPatch`
Claude Code records for an edit, an array of hunks:

```json
[{ "oldStart": 12, "oldLines": 3, "newStart": 12, "newLines": 4,
   "lines": ["     const x = 1;", "-    return x;", "+    return x + 1;"] }]
```

Each entry in `lines` already carries its own leading `+`, `-` or space; do not add
one. Null for a tool that produced no diff.

**`tool.result.answers` is what was picked, not what was offered** — an object, or
null for every tool but `AskUserQuestion`. Keys are the **exact** `question` strings
from `input.questions[]`; values are strings. **There is no index anywhere**, and a
question with no key here was not answered — the object carries only the questions
that were. So match on the text and show nothing for a question that is absent;
do not fall back to position, because "this key was rewritten" and "this question
went unanswered" look identical from here, and guessing by position attributes one
question's answer to another.

**Parsing a value is not a split.** One string carries all three cases with nothing
to tell them apart: a single choice is the option's `label` verbatim; a multi-select
is the chosen labels joined `", "`; and an answer typed into the tool's "Other" box
is a sentence that matches no label at all. Measured over 414 real answers on one
machine: 83% one label, 4% several joined, 13% free text, and 1% a label followed by
typed words. **Do not split on `", "`** — 187 of those 414 questions had an option
label containing a comma of its own (`"Bar, count, cycling (Recommended)"`), so
splitting shreds them. Consume whole labels off the
**front** of the string, longest-first, for as long as the front keeps being a label
followed by end-of-string or `,\s*`; whatever remains is what the person typed.
Both halves of that matter. Front-anchored, because the picks are joined first and
the typed answer pushed on the end — searching the whole string instead marks a
label somebody quoted mid-sentence to argue against it. Longest-first, because one
label is often a prefix of another (`"Approve"` / `"Approve with feedback"`).

**One case is not recoverable, and no client should pretend otherwise.** Ticking an
option and adding a condition in the "Other" box produces the same bytes as typing
that whole sentence into "Other" alone. `"Hard delete, but make them confirm"` is
therefore read as the option plus a note, which is what the real answers support —
but it is a reading, not a fact, so show the typed words either way rather than
letting the mark stand on its own.

**`tool.result.plan` is the approved plan, not the proposed one** — a string, or null
for every tool but `ExitPlanMode`. `input.plan` is what was put forward; this is what
was agreed to. They differ when the plan was edited before approval, or approved with
a note, which appends a `## Note from the user` section. `planWasEdited` is a bool
saying which happened, and is only ever true — its absence is the ordinary case, not
a recorded `false`.

On `status: "error"` both are null and `result.text` is the reason. That is usually
the person's own words and can be shown as such, but three canned strings are not and
should not be presented as feedback: `"Not yet — keep planning."`, `"The question was
dismissed unanswered. Use your own judgement and carry on."` and `"Stopped from
TGXCode before this was approved."` — the last meaning the turn was stopped
while the ask was still open, so nobody answered it at all.

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

`{ prs: [...], gh: {ok, error}, checkedAt }` — what has become of the pull requests
this session raised, one entry per PR in `summary.prs`, same order.

`checkedAt` is an ISO string or null: the most recent moment any repository was
successfully listed. Null means nothing has been listed yet — a bridge that has
only just started, on a machine with no cache file.

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

`unknown` means the bridge has no answer for that PR *yet*, and it covers three
cases, only one of which is a problem: gh could not be reached, the PR's repository
has not been listed yet, or the PR is settled and the one `gh pr view` that
resolves it has not run. The client is expected to keep showing the PR, since it
has the number and the link from the summary already, and simply not colour it.

**`gh.ok` is what says whether GitHub is reachable — `unknown` does not.** The last
two cases report `unknown` with `gh.ok: true`, and on a first run with no cache
file that is every merged PR on the machine for one pass. A client that renders
`unknown` as "GitHub could not be reached" will say so, wrongly, every time a
bridge starts cold. Use `gh.error` for the wording and fall back to something that
does not blame the network.

**This route does not shell out.** It reads a snapshot that a background refresher
in the bridge keeps current, so it answers in memory and never waits on GitHub. It
stays a separate route from the summary because the two go stale on different
clocks, not because it is slow. See *How the bridge keeps PR status fresh* under
`GET /api/prs`.

### `GET /api/prs`

`{ sessions: {...}, gh: {ok, error}, checkedAt }` — one *aggregate* status per
session, for a list that wants a glyph per row and cannot afford a request per row.

This is also the payload of the `prs-changed` event, byte for byte. Fetch it once
when a client starts, to have something to draw; after that the event carries the
same shape and the fetch is not needed again.

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

Cost: none worth planning around. It reads a snapshot in memory. It used to fan out
one `gh pr list` per repository and one `gh pr view` per already-settled PR while
the caller waited — which is why older versions of this document told you to fetch
it after the session list had painted, and warned that the first call after a
restart could take seconds. Neither is true any more.

#### How the bridge keeps PR status fresh

A background refresher in the bridge is the only thing that calls `gh` about a pull
request. It runs every 30s and, on each pass, decides per *repository* whether to
list it — the repository is the unit, because one `gh pr list --state open` answers
every open PR on it at once, so "refresh the PRs that changed" is not a question
that can be asked.

A repository is listed when any of these holds:

| Trigger | Interval |
|---|---|
| Never listed | immediately — bridge start, or a newly-linked PR |
| A session whose PRs live in it has a transcript newer than the last listing, or a turn running | 60s floor |
| Any of its open PRs has a check in flight | 2 min |
| Otherwise | 20 min |
| The last listing failed | 1 min, then 2, then 5, then 20 |

**So a PR can be up to twenty minutes stale on a repository nobody is working in.**
That is the deliberate trade for not calling `gh` sixty times an hour per repository
forever. Anything a conversation *can* see — a PR raised, pushed to or merged from a
session on this machine — is picked up within a minute of it happening, and a build
finishing within two.

A failed listing **keeps the pull requests it last read successfully** and reports
`ok: false` alongside them. This matters to any client that acts on absence: an
empty list from a failed call is indistinguishable from a repository with nothing
open, and treating the two alike is how a review sweep concludes it has reviewed
everything. Check `gh.ok` before drawing a conclusion from an empty `prs`.

Settled pull requests — merged or closed — are resolved once and written to disk, so
a restart does not pay for them again. The store lives at
`$XDG_CACHE_HOME/tgxcode/prs.json` and is a cache: deleting it costs one
round of `gh` calls and loses nothing.

`?refresh=1` on `GET /api/dashboard` is the only way to make the refresher run out
of turn. There is no per-route refresh here.

### `GET /api/sessions/:id/tasks`

The session's own task list — the checklist the agent keeps for itself, with
per-item status.

```
{ sessionId, source, items: [...], done, total, current, idle, ts, truncated }
```

| field | type |
|---|---|
| `source` | **`"directory"`, `"todo"`, or `null`** — which of two places answered; `null` when neither did |
| `items[]` | **array of objects** — see the item table below |
| `done` | number — items with `status: "completed"` |
| `total` | number — `items.length` |
| `current` | string or null — the in-progress item's `activeForm`, falling back to its `subject` |
| `idle` | boolean — work is left and *nothing* is in progress: a list that has stopped, not one between steps |
| `ts` | **ISO 8601 string or null** — see the note below; null for `source: "directory"` |
| `truncated` | number — items dropped past the 200-item cap, `0` normally |

One item:

| field | type |
|---|---|
| `id` | **string or null** — see below; always null for `source: "todo"` |
| `subject` | string — what the task is |
| `description` | string or null — a sentence or two of detail; always null for `source: "todo"` |
| `activeForm` | string or null — the present-tense phrasing, written for a status line |
| `status` | **`"pending"`, `"in_progress"` or `"completed"`** — a closed set |
| `blocks` | array of strings — ids of tasks this one blocks; always `[]` for `source: "todo"` |
| `blockedBy` | array of strings — ids blocking this one; always `[]` for `source: "todo"` |

**The two sources are not equally rich, which is what `source` is for.** A
`directory` list (from `~/.claude/tasks/<session-id>/`, written by the
`TaskCreate`/`TaskUpdate` tools) has ids, descriptions and dependencies. A `todo`
list (reconstructed from the newest `TodoWrite` call in the transcript) has none
of those three. A client that draws a description affordance on a `todo` list is
drawing something that can never be filled.

**`id` is null for `source: "todo"`, and that is not an omission.** TodoWrite is
called with the whole list every time and carries no ids, so anything this API
invented would be positional and unstable across pushes — a client keying its
DOM or its storage on one would silently mis-associate items the moment the agent
inserted a step. Do not synthesise one from the index.

**TodoWrite's `content` arrives as `subject`.** One name field, not two, so there
is nothing to guess. (Two malformed shapes are also repaired rather than passed
on: the key is accepted as `tasks` as well as `todos`, and a `todos` that arrived
as a JSON *string* holding the array is parsed. Both occur in real transcripts.)

**`status` is a closed set.** Anything outside those three values is normalised
to `"pending"` rather than passed through, so a client's switch never falls
through to nothing.

**`ts` is only ever non-null for `source: "todo"`** — it is the timestamp of the
TodoWrite entry. The directory format records no times at all, so `ts` must not
be used to judge how fresh a `directory` list is.

**An empty list is a 200, not a 404.** A session that kept no task list answers
`{source: null, items: [], total: 0, …}`. Only an unknown session id is a 404
(`{"error": "session not found"}`) — an empty answer and a missing session are
different things.

Items are in the order the agent keeps them: numerically by `id` for
`directory`, call order for `todo`. Answered from a ~1s cache. **There is no
write side** — this app reads `~/.claude/tasks/` and never writes it.

**This route is wider than the `tasks` field on a board card.** `/api/overview`
and `/api/taskboard` carry only the five-field aggregate (`{done, total, current,
idle, ts}`) and **no items**; a client that wants the list has to ask here.

**The list moves mid-turn**, which is the whole reason to show it — so the
`task-list` event under *The live channel* is the live path, and polling this at
the end of a turn is not the same thing.

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

A client that wants the content behind one of those rows asks
`GET /api/sessions/:id/diff`, below.

### `GET /api/sessions/:id/diff?path=<p>[&mode=<m>][&context=<n>]`

`{ ok, path, absPath, root, mode, status, added, deleted, binary, diff, bytes, truncated, checkedAt }`
— the unified diff of one file, as text. This is the **tree's** answer, the same side
of `/changes` that `git` is; the transcript's answer is the `patch` already on every
edit tool's result over `/api/events`, which a client holding the conversation can
assemble itself and which is the only answer left once a file has been committed.

`path` is what `/changes` gave you — `git.sample[].path`, relative to the repository
root, or an `edits[].relPath`, which is absolute for a session that ran outside a
repository. Either form works; an absolute one must still resolve inside the
session's own repository root. **It is re-derived rather than trusted:** joined to a
root the bridge worked out for itself, resolved, checked against that root and
against the allowed roots, and then resolved with **every symlink on it followed**
and checked again against the real root. That last step is not the same as asking
whether the file is a link: a leaf inside a symlinked *directory* is not itself a
link, and checking only the leaf leaves `escape/etc/passwd` lexically inside a
repository that contains `escape -> /`. Every git argument is then recomputed from the resolved path,
never the string you sent.

`mode` is one of:

| `mode` | what it diffs |
| --- | --- |
| `worktree` (default) | everything uncommitted, staged and unstaged together, against `HEAD` — what the row's `+N −M` is counting |
| `staged` | the index against `HEAD` |
| `unstaged` | the working tree against the index |

Anything else is a `400`, rather than a silent fall back to the default. An
untracked file is in none of the three, so it is diffed against `/dev/null` and comes
back as one whole-file addition whatever `mode` says. A repository with no commit yet
falls back to the index, as `/changes`' line counts do.

`context` is lines of surrounding code, `0`–`25`, default 3 — the one thing a
per-file view offers that the drawer cannot. Out-of-range values are clamped.

**Failures are answers, not errors.** `{ok: false}` arrives with `200` and a `reason`
of `no-directory`, `not-a-repo`, `left-behind`, `no-such-file`, `outside-repo` or
`diff-failed`, plus `error` where git said something. `outside-repo` in particular is
an ordinary result a client draws, not a refusal: a `403` is reserved for a path
outside `TGXCODE_ROOTS`, and it carries `{error, path, roots}`. A missing
`path` or an unrecognised `mode` is a `400`, **checked before the session is looked
up**, so the difference between `400` and `404` cannot be used to enumerate session
ids. `404` is only "session not found".

`binary: true` arrives with `ok: true` and an empty `diff` — it is a fact about the
file rather than a failure, and it is known from `git diff --numstat` before a diff is
asked for at all.

`diff` is capped at **2 MB**, cut on a line boundary so a half-line never reaches a
parser; `truncated` is **how many bytes were left out**, not a boolean, matching
`git.truncated` on `/changes`. `bytes` is the length of what was sent. A diff too
large for the bridge to read at all is `{ok: false, reason: 'diff-failed'}` saying so,
rather than a truncated diff claiming to be whole.

**Not cached, deliberately.** `/changes` shares a 15s `git status` with
`/api/dashboard` because a board asks about forty directories on a timer; a diff is
asked for once, by a person who wants it as it is now. There is no `refresh=1` — ask
again.

**Readable remotely**, unlike its neighbours, and the omission from the refusal list
is deliberate: it is a read, its bytes already reach a phone inside the tool results
it renders, and it is scoped to the session's own repository so a leaked token cannot
walk it to `~/.ssh`.

### `POST /api/sessions/:id/open-file`

`{path}` → `{ok, how, file, path}` — opens one of the session's files in whatever
program the **host desktop** opens that kind of file with. `POST /api/sessions/:id/reveal`
for the folder, this for the file.

There are two hosts and the difference is visible in the answer; see
*The host the bridge opens files on* below. Under WSL this hands the file to
`explorer.exe`, and on a Linux host to `xdg-open`.

`how` is `"open"` or `"reveal"`, and it says what *happened* rather than what was
asked for. A file the host would **run** rather than open — the `isLaunchable` list
`POST /api/fs/open` uses, `.ps1`, `.exe`, `.lnk`, `.desktop` and the rest — is
revealed in its folder instead, with `why: "executable"`. That is not a refusal and
not an error: it
is `200`, and the folder is the same information with none of the execution. A
checkout is exactly where a `.ps1` an agent wrote ten minutes ago would be, which is
why this route defers to that list even though its path is one the bridge computed.

`path` takes the same forms as the diff route's and is re-derived exactly the same
way. A path that leaves the tree is `403 {"error": "that file is outside this
session's working directory"}` — and it is the **same 403 whether the file is absent
or out of bounds**, because the difference between those two answers is an existence
oracle for everything on the machine. An empty `path` is `400`, again before the
session lookup.

`file` in the answer is always the Linux path. **`path` is the path as it was handed
to the host's file manager**, which is host-dependent and is the one field on this
route a client must not assume the shape of:

| Host | `path` |
|---|---|
| WSL | the Windows form, `\\wsl.localhost\…`, from `wslpath -w` |
| Linux | the same Linux path as `file` |

`502` with `ok: false` means the launch itself failed, and what counts as a failure
differs because the two openers differ in how much they will tell you:

- **Under WSL**, only a missing `explorer.exe` or a `wslpath` that could not
  translate. A file type with **no** registered handler still reports `ok: true`:
  Windows shows its own "how do you want to open this" dialog, and that is a success.
- **On Linux**, `xdg-open`'s exit codes are specified and are believed, so a file
  type nothing is registered for *is* a `502`. Nothing appeared on screen, and saying
  otherwise would be a lie a client cannot check.

One limitation worth knowing rather than working around, and it is WSL-only: Windows
joins an argument vector into a single command line and Explorer parses its own,
comma-separated. A filename containing a comma therefore opens the wrong thing or
nothing. It cannot escape the tree — the path is validated before `wslpath` sees it,
and `execFile` uses no shell — so this is a visible failure on an unusual filename,
not a hole. `xdg-open` takes an argument vector and does not have this problem.

**Local only.** A remote caller gets
`403 {"error": "opening a file only makes sense on the machine itself"}`. The window
it opens is on this machine's desktop, which a phone cannot look at.

### `GET /api/prefs?cwd=<path>&files=1`

`{ version, transcript: {…}, live: {…}, projects: {…}, quota: {…}, spinner: {…},
keyboard: {…}, toolbar: {…}, wispr: {…}, sources: [string], problems: [{file, message}] }` — how the person using the app
wants it to behave. `sources` is file paths, weakest first; each `problems` entry
is an **object**, `{file, message}`, naming the file that carried a value the key
does not allow and what was wrong with it.

`?files=1` adds `files`, which is the *other* question — not "what is in force"
but "what does each file in the chain say on its own". One entry per file, weakest
first:

| Field | Type | |
|---|---|---|
| `file` | string | absolute path |
| `scope` | string | `"user"`, `"project"` or `"project-local"` |
| `target` | bool | whether `PUT` with that `scope` and this `cwd` writes *this* file |
| `exists` | bool | |
| `parsed` | bool | false means the file was dropped whole, so what it says is unknown and a `PUT` to it is refused |
| `writable` | bool | the file, or the nearest directory that would have to be created |
| `values` | object | only the keys this bridge knows and that passed validation, nested `{section: {key: value}}` |
| `problems` | [string] | messages for this file alone, without the `{file, message}` wrapper |

Two of the four chain entries have `scope: "project-local"` — the main
checkout's local file and the workspace's own — which is why `target` exists and
why a client must never derive the save target from a row. Only the settings
page asks for this; a client that just wants the settings in force does not need
it, and "in force" cannot distinguish a value you set from one you inherited.

`~/.tgxcode/settings.json` is the user's own, written out with the defaults on
first run so it can be found and edited. A project overrides any key from
`<workspace>/.tgxcode/settings.json`, with the same precedence as project
commands: the workspace's checked-in file (falling back to the main checkout's),
then `settings.local.json` from the main checkout, then one in the workspace.
`sources` lists the files that were actually read, weakest first.

A bridge started with `TGXCODE_PREFS_DIR` set uses that directory in place
of `~/.tgxcode`, for reads and saves alike, so the user file's path in `sources`
and `target` is under it. This exists so a development bridge can test a save
without touching the real file; no field changes because of it.

A value that is not what the key allows is dropped and reported in `problems`
rather than taken at face value; the default stands. Without `?cwd=` you get the
user-level answer, which is also what every page is served in a `cs-prefs`
`<meta>` tag (minus `sources` and `problems`).

**Seven sections may only be set in the user's own file**: `quota`, `keyboard`,
`projects`, `toolbar`, `wispr`, `preview` and `devbrowser`. A project file that carries one is ignored and says so in
`problems`. What directory this app starts `claude` in, and which keys your
hands use, are not a repository's business — and a repository that could rebind
your keys could make the window unusable with hand-editing the file as the only
way back. `projects` is there for a third reason: the map is keyed by absolute
path and so names *other* projects, and a repository setting one would be a
repository colouring its neighbours. `toolbar` is the `keyboard` argument
applied to the top bar: a checked-in file should not be able to rearrange your
window. `quota` was documented this way before it
was enforced this way; it is enforced now, so `?cwd=` no longer echoes a
project's value back as though it counted. `wispr` is there because the bridge
presses its chords on the desktop, and a repository choosing which keys get
pressed on your machine is not a preference. `preview` and `devbrowser` decide
which browser on this machine you look at pages in and whether a click launches
one, which is the same class of thing.

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

Six more `live` keys say whether the board stays on screen while a whole-screen
panel is open, one per panel: `overTasks`, `overDashboard`, `overHistory`,
`overDrafts`, `overSchedules`, `overSettings`. Each is a string, one of
`"hidden" | "always" | "side" | "stacked"`, default `"hidden"`:

| Value | Over that panel, the board is… |
|---|---|
| `hidden` | covered (the behaviour before these keys existed) |
| `always` | docked beside or under the panel, whichever way the board's dock toggle is set |
| `side` | docked beside the panel while the dock toggle is *side by side*, covered while it is *stacked* |
| `stacked` | docked under the panel while the dock toggle is *stacked*, covered while it is *side by side* |

The dock toggle itself is per-browser (`localStorage`), not a pref. Any other
string, including `"bottom"`, is refused with `400` (`code: "value"`). The
Settings page's "All views" buttons are not a key — they send all six in one
`PUT /api/prefs` patch.

Note that the page reads these from its `<meta>` copy, which is the **user-level**
answer — the board draws sessions from every project at once, so a project's
`<workspace>/.tgxcode/settings.json` can set `live` and will see it echoed back
on `?cwd=`, but it does not change what the board draws. A client that builds its
own cards has no reason to read `live` at all — the Android app does not.

`projects` is eleven keys: `colors`, a map described below; seven about the
order of the rail's project cards, described after it; and two plain ones
about how the desktop wears a colour — `backdropTint {boolean}`, default `true`,
and `backdropStrength {integer 0–40}`, default `13`, a percentage of the
project's colour mixed into the dim behind the Start-a-session dialog. `false`
gives that dialog the plain dim every other dialog has. Both are presentation in
the desktop window alone, so a client with no such backdrop has no reason to
read them; a value out of range, a string, or a fraction is dropped with one
`problems` line and the default holds. They are user-only like the rest of the
section.

`colors` is an **object**:
`{"<absolute project directory>": "<#rgb or #rrggbb>"}`. It is a colour a person
gave a project so that a session scoped to the wrong checkout is visible rather
than only readable — the desktop wears it on the rail's project cards, the
drafts and task boards' project columns, the dashboard's project cards, and the
dialog that scopes a new session or a schedule. A project with no entry has no
colour, which is most of them, and `{}` is how it ships.

**A directory is matched as a prefix at a path boundary, longest first.** The map
is keyed by *project root*, so `/home/you/proj` also answers for
`/home/you/proj/.claude/worktrees/spike` and for any other subdirectory of it —
which is what lets a worktree wear its checkout's colour without being listed
separately. The boundary is part of the rule: `/home/you/proj` does **not**
answer for `/home/you/project`. Longest wins, so a worktree given a colour of its
own keeps it. This resolution is the client's to do; the bridge stores the map
and validates it, and takes no view on which directory you are asking about.

**The value is a literal colour, and the validation is strict for a reason.** A
client sets it as a CSS custom property, so `red`, `var(--x)` and `#fff;}` are
all refused — the same rule and the same argument as a snippet group's `accent`
(see `POST /api/snippet-groups`). Keys must be absolute and are stored resolved,
so `/home/you/proj/` and `/home/you/proj/sub/..` cannot become two entries for
one project. At most 200 entries are kept. A bad key or a bad value is dropped
with one `problems` line rather than costing the map, exactly as
`keyboard.bindings` and `spinner.weights` are.

**The rail's project order** is seven keys. They are how the desktop orders its
project cards; the bridge orders nothing by them, and `GET /api/sessions` is
still newest-first whatever they say. A client with a project list of its own
may honour them or not.

| key | type | default | meaning |
|---|---|---|---|
| `sort` | `"recent"` \| `"dynamic"` \| `"alpha"` \| `"custom"` | `"recent"` | `recent`: newest first as of when the window opened, then held still. `dynamic`: the same start, and a card moves to the top when one of the `bumpOn*` events happens in it. `alpha`: by project name. `custom`: by `order` |
| `bumpOnCreate` | boolean | `true` | `dynamic`: a session starts in the project |
| `bumpOnUser` | boolean | `true` | `dynamic`: a user message in any of its sessions (`lastUserTs` advancing) |
| `bumpOnAny` | boolean | `false` | `dynamic`: any line written in any of its sessions (`lastTs` advancing) — moves cards constantly while agents run |
| `bumpOnTurn` | boolean | `false` | `dynamic`: a `turn-complete` in any of its sessions |
| `bumpOnPr` | boolean | `false` | `dynamic`: a session's entry in `prs-changed` differs from the last one |
| `order` | array of strings — absolute project directories, top first | `[]` | `custom`: the hand-arranged order. Keyed by path like `colors`, and by the *project root* (`projectCwd`), not a worktree. Stored resolved; a relative path or a duplicate is dropped with one `problems` line and the rest kept (a `PUT` carrying one is refused with `400 value`). At most 500 |
| `newAt` | `"top"` \| `"bottom"` | `"top"` | `custom`: where a project `order` does not name yet is drawn. The desktop writes it into `order` the next time anything is dragged |

`order` is one key like the maps are, so a `PUT` naming it replaces the whole
list. The desktop sends the whole list after every drag, including projects
that were not on screen at the time, which keep their places.

Like those two, `colors` is a **map**, so a `PUT` naming it replaces the whole
thing rather than merging into it: there is no spelling for "clear this one
entry", because leaving the key out *is* that. Send all of it. Clearing the last
colour is `{"projects": {"colors": null}}`, which removes the key from the file —
and the section with it, when neither backdrop key is set there either.

User file only — see the three-section paragraph below.

`spinner`: `randomize` (whether a turn in progress wears a themed verb in front
of what it is doing, or says only what it is doing as before), `groups` (which
groups from `~/.tgxcode/verbs/` are in play, named by their `Category` — at most
200), `weights` (**object**, `{[group]: number}` — how often each group gets to
speak), `rerollMs` (how long a verb stands before the next is drawn; `0` pins one
for the whole turn, else 1000–600000). The verbs themselves are not here — they
are a directory, and `GET /api/spinner/groups` lists it.

**`weights` is a share of the draws, not a multiplier on a group's size.** A
verb is picked in two steps — a group by its weight, then a verb uniformly
inside that group — so weight `4` against weight `1` is drawn four times as
often whatever the two groups' counts are. A group the map does not name weighs
`1`, making `{}` an even split; `0` means never drawn, and its verbs leave the
pool. A number must be finite and 0–1000, keys are group names of 1–80
characters matched the same forgiving way `groups` entries are
(`"Tech / Programming"` = `"Tech_Programming"` = `"tech-programming"`), and at
most 200 entries are kept — a bad entry is dropped with one `problems` line
rather than costing the map. Weights naming a group that is not enabled are kept
and ignored, so unchecking a group does not forget its number; a weight naming a
group in no directory at all is one `problems` line from
`GET /api/spinner/groups`.

Like `keyboard.bindings`, `weights` is a **map**, so a `PUT` naming it replaces
the whole thing rather than merging into it — there is no spelling for "drop
this one entry back to its default", since removing the key *is* that. Send all
of it.

`quota` is about the background refresh that keeps the percentages current with
no terminal open: `beacon` (bool), `beaconDir` (**string or null** — where the
short-lived `claude` runs; nothing happens until it names somewhere you have
already trusted), `beaconEveryMinutes` (int, 5–1440). See `GET /api/quota` for
what the refresh itself reports. User file only.

`keyboard` is about keys, and is four keys of its own:

| Key | Type | |
|---|---|---|
| `contextualTerminalCopy` | bool, default `false` | in the integrated terminal, `Ctrl+C` copies the selection and clears it when there is one and interrupts when there is not, and plain `Ctrl+V` pastes instead of `Ctrl+Shift+V`. Only while the terminal has the focus. |
| `composerSend` | `"enter"` (default) or `"ctrl-enter"` | what Enter does in a composer. `"enter"`: Enter sends, Shift+Enter is a newline. `"ctrl-enter"`: the reverse. `Ctrl+Enter` sends under both. |
| `cycleOrder` | `"default"` (default) or `"alphabetical"` | the order `composer.permissionMode` / `composer.model` (and their `…Prev` twins) step the composer's pickers in. `"default"`: the order the dropdown lists them. `"alphabetical"`: sorted by the option's label, case-insensitive, with an empty value (the model's "inherit") kept first. The dropdowns themselves are not reordered. |
| `bindings` | **object**, `{[commandId]: string \| null}` | which chord reaches which command. A missing id means the default; `null` means deliberately unbound. Keys must be ids `GET /api/keymap` lists, and values must be canonical combos it would accept — anything else is one entry dropped with one `problems` line, not the whole map. At most 100 entries. |

User file only, and `bindings` is a **map**, so a `PUT` naming it replaces the
whole thing rather than merging into it — inside the map `null` already means
"unbound on purpose", so there is no spare spelling for "drop this one entry
back to its default". Send all of it.

`toolbar` is how the desktop page lays out its top bar. It has one key, `items`,
an **array of objects** `[{id, place, label}]` in the order the bar draws them:

| Field | Type | |
|---|---|---|
| `id` | string | one of `tasks`, `live`, `dashboard`, `history`, `drafts`, `schedules`, `settings`, `quota`, `devbrowser` |
| `place` | `"bar"`, `"more"` or `"hidden"` | on the bar, in its More menu, or not drawn. Missing means `"bar"` |
| `label` | bool | whether the name shows beside the icon. Missing means `true`. Only the seven views have an icon, so it means nothing on `quota` or `devbrowser` |

The default is `[]`, which means the built-in layout. An id the list leaves out
is drawn in its default place, so a button added later shows up without anyone
having to list it. Entries are cleaned one at a time, as `keyboard.bindings`
is: an unknown or repeated id, a `place` outside the three, or a `label` that is
not a bool costs that entry and adds one `problems` line. Two buttons are
**pinned**. `settings` may be `"bar"` or `"more"` but never `"hidden"`, because
it is where hidden buttons are brought back from. `quota` is always `"bar"`,
because its popover holds Restart bridge. A file that asks otherwise is
**moved** back to `"bar"` with a `problems` line. A `PUT` that asks otherwise is
refused with `400`, the way any value the file would have had to correct is.

Hiding a view removes its button and nothing else: its shortcut in
`keyboard.bindings` still opens it. User file only, and `items` is one key, so
a `PUT` sends the whole list. The Android app draws no such bar and can ignore
this section.

`wispr` is the Wispr Flow transforms the composers' Wispr button lists, and is one
key:

| Key | Type | |
|---|---|---|
| `transforms` | **array of objects**, `[{id: string, title: string, combo: string}]`, default `[]` | in the order the popover lists them. `id` is 1–40 of `a-z`, `0-9` and `-`, unique in the list, and is what `POST /api/wispr/press` names; a client makes it up when a transform is added and keeps it. `title` is 1–60 characters, trimmed. `combo` is the chord the transform has in Wispr Flow: modifiers `Win`, `Ctrl`, `Alt`, `Shift` (read case-insensitively, with `Super`/`Meta`/`Cmd` as aliases for `Win`) and one key name from `GET /api/keymap`'s `keys`, stored canonically in that modifier order — `win+alt+2` comes back `Win+Alt+2`. It needs a modifier unless the key is `F1`–`F12`. **`Win` is its own modifier here**, unlike in `keyboard.bindings`, where Ctrl and Cmd are one. At most 20 entries. |

User file only. In a file a bad entry is dropped alone with one `problems` line; in a
`PUT` it refuses the whole call, as every value does. The array is one key, so a
`PUT` naming it replaces the list whole — send all of it, and `null` to empty it.

`preview` is the desktop page's in-window browser preview, and is two keys:

| Key | Type | |
|---|---|---|
| `keepAliveMinutes` | **integer 0–240**, default `10` | how long a preview page stays loaded after you leave it. Coming back inside that finds it as you left it; after it the page is discarded and the next open loads it fresh. `0` discards it as soon as you leave. |
| `overLive` | **bool**, default `true` | a port clicked on a Live card opens its preview over the Live board. `false` opens that card's session and previews over it, leaving a docked board beside it. |

`devbrowser` is whether DevBrowser is part of the app, and where a "show me this
port" click goes. Three keys:

| Key | Type | |
|---|---|---|
| `show` | **bool**, default `true` | `false` removes every mention of DevBrowser from the desktop page — the status pill, the preview's "Open in DevBrowser", the DevBrowser tab field in the command editor — and every port opens in the in-window preview. It does **not** stop the bridge naming a task's port in DevBrowser when it comes up (`devbrowser` on a project command); that is a no-op with DevBrowser closed. |
| `openIn` | **`"devbrowser"` or `"inline"`**, default `"devbrowser"` | where a click on a port or a running task shows its page. Only consulted when `show` is `true`. |
| `whenClosed` | **`"launch"`, `"inline"` or `"nothing"`**, default `"launch"` | with `openIn: "devbrowser"`, what happens when DevBrowser is not running: start it (what a click always did), preview in the window instead, or nothing but a note that it is closed. The client passes `ifClosed: "none"` to `POST /api/devbrowser/open` for the last two. |

Both sections are **user file only**, and both are read only by the desktop page —
a client with no browser of its own has nothing to consult them for. The defaults
are the behaviour from before either existed: a click goes to DevBrowser, and
launches it if need be.

### `GET /api/wispr`

`{available: boolean}` — whether a Wispr Flow chord pressed through this bridge can
reach anything, which is what decides whether a client draws the Wispr button and
the settings for it at all. `false` on a Linux host (Wispr Flow has no Linux build)
and `false` for a **remote** caller, whatever the host: the answer is about the
caller, and a remote one is refused the press. A client that gets `false` should
draw nothing rather than a disabled button.

### `GET /api/keymap`

`{ commands: [{id, group, label, default}], keys: [string] }` — the shortcuts the
web UI answers to and may be rebound, and the closed set of key names a combo
may end in.

`default` is a canonical combo, `group` is a heading the settings page groups by,
and `label` is what to call the command to a person. `keys` is every name the
last segment of a combo may be: `A`–`Z`, `0`–`9`, `F1`–`F12`, `Up`, `Down`,
`Left`, `Right`, `Enter`, `Escape`, `Tab`, `Space`, `Backspace`, `Delete`,
`Insert`, `Home`, `End`, `PageUp`, `PageDown`, and the punctuation keys under
their `KeyboardEvent.code` names (`Minus`, `Equal`, `Slash`, `Comma`, …).

**A combo names physical keys, not characters.** `Ctrl+Shift+3` means
`code === "Digit3"` with Ctrl and Shift, because `Shift+3` arrives as `#` on a US
layout and `£` on a UK one and a binding written against the character works on
one keyboard and silently fails on the next. **Ctrl and Cmd are one modifier**,
spelled `Ctrl`; `Cmd+`, `Meta+`, `Command+` and `Super+` are accepted when
reading a file and never written back. Modifiers are written in the order
`Ctrl+Alt+Shift+`.

**A binding has to carry Ctrl or Alt, or be a function key.** These fire while
the composer — a `<textarea>` — has the focus, so binding a bare letter would
make that letter untypeable with hand-editing the settings file as the only way
back. `Shift+F3` is legal; `Shift+K` is not.

The same catalogue is in a `cs-keymap` `<meta>` tag on every page, percent-encoded
like `cs-prefs`, because the first key somebody presses can land before a fetch
could answer.

### `GET /api/spinner/groups?cwd=<path>&verbs=1`

`{ randomize (bool), rerollMs (number), enabled: [string],
weights: {[group]: number}, pool (number),
groups: [{name, file, count, source, weight, share}], problems: [{file, message}] }`
— which spinner verb groups exist and which are in force. `enabled` is group
names, `weights` is the map in force from `spinner.weights`, and `problems`
entries are **objects**, as on `/api/prefs`.

`?verbs=1` adds `verbs: [string]` to every group entry, sorted. Off by default
because it is 3,639 strings across the bundled catalogue and a caller that
wanted counts should not pay for them; the settings page asks for it to put a
group's contents in its tooltip, which is the difference between choosing a
voice and guessing from a name.

`groups` is one entry per group available to `cwd` — `{name, file, count,
source, weight, share}`, where `name` is the `Category` inside the file and
`source` is the directory it came from. A project's `<workspace>/.tgxcode/verbs/`
wins over the user's `~/.tgxcode/verbs/`, so a repo can ship its own group
without anybody editing their home directory.

`weight` and `share` are **`null` for a group that is not enabled** — it has no
share of anything, which is a different statement from a share of zero. For an
enabled group, `weight` is what `spinner.weights` says (`1` when it says
nothing, `0` for a muted one) and `share` is that weight over the total, `0` to
`1`. Both come from the bridge rather than being left to the caller because the
bridge is where the draw happens: a client recomputing a share would be a second
implementation of the algorithm, and the two would disagree the first time this
one changed.

`enabled` is what settings ask for and `pool` is how many distinct verbs that
actually amounts to — the two disagree when a name matches no file, which is
what `problems` then says, and when a group is enabled but weighed `0`, which is
deliberate and says nothing. A group whose filename and `Category` differ still
works, and is reported here rather than left a mystery.

This is the discoverable half of `spinner.groups`, and it was built when there
was no settings page and the only answer to "what may I put in that list?" was
to go and read a directory. There is one now, and this is what its checkboxes
are drawn from — which is why the panel needed no route of its own. Read-only.
Not local-only either: the names and contents of verb groups are not a
capability worth refusing a phone.

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

`http` (**bool**) says whether the port answers HTTP — a `GET /` on 127.0.0.1 that
got any status line back, `404` and `500` included, within about 600 ms. It is what
decides whether a browser preview can show the port: `listening` is only a TCP
connect, and a database or a language server accepts connections too. Always
`false` for a port that is not listening. Answers are cached per port for about
ten seconds, so a server that has just started can read `false` briefly.

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

### `POST /api/devbrowser/open`

`{port, title?, path?, ifClosed?}` → switches DevBrowser to a tab for `port`,
creating it if need be, and raises its window. `title` names the tab on the way in
(capped at 64 characters); `path` is the page within the port. Local callers only,
like every `/api/devbrowser/*` route.

`ifClosed` is `"launch"` (the default) or `"none"`. With `"launch"`, a DevBrowser
that is not running is started first, and the answer carries `launched: true`.
With `"none"`, nothing is started: the answer is **`200 {ok: false, running: false,
launched: false}`** — not an error, but the signal to fall back (the desktop page
previews in its own window, or does nothing, by `devbrowser.whenClosed`). Any other
value is read as `"launch"`.

Otherwise `200 {ok: true, launched, status}` on success and `502 {ok: false,
launched, status, error}` when DevBrowser refused or could not be reached. An
invalid `port` is `400`.


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
| `tasks` | object or null — **five fields, and no items**: `{done: number, total: number, current: string\|null, idle: boolean, ts: string\|null}`. `current` is the in-progress task's `activeForm`. `idle` is true when work is left and *nothing* is in progress — a list that has stopped, not one between steps. `ts` is ISO 8601 and non-null only when the answer came from a `TodoWrite` in the transcript rather than from `~/.claude/tasks`. **The items are not here** — `GET /api/sessions/:id/tasks` has them. (Previously documented as `{done, total, current, ts}`, which was true of only one of the two sources: the directory returned `idle` and no `ts`, the transcript the reverse.) |
| **`devservers`** | **array of objects or null** — `{port, title, owned, http}`, listening ports only (`http` as on `/api/sessions/:id/devservers`); `null` until the first probe has run |
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

Its `tasks` is the same five-field aggregate an overview card carries, documented above,
and carries no items — and it is only ever non-null in the `working` column, because that
is the only one it is asked for. `GET /api/sessions/:id/tasks` is where the items are.

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

### `GET /api/later`

Messages written now and delivered to a session that **already exists**, at a time you
picked. Where a draft is a `POST /api/sessions` held back, one of these is a
`POST /api/sessions/:id/send` held back.

```json
{
  "at": 1790086932143,
  "messages": [
    { "id": "fcaf1abd-2c91-4648-ae9a-895916fd4de6",
      "sessionId": "8ee90bfa-bfab-47d6-aba0-ba2482a2cc47",
      "cwd": "/home/dylan_hays/Other/claude-sessions",
      "projectName": "claude-sessions",
      "text": "You may now modify app data to get the screenshots.",
      "attachments": [],
      "model": null, "permissionMode": "bypassPermissions",
      "at": 1790112000000, "state": "pending", "late": false, "test": false,
      "createdAt": 1790086931954, "updatedAt": 1790086931954,
      "sentAt": null, "error": null }
  ],
  "counts": { "total": 1, "pending": 1 }
}
```

**Read the section on `permissionMode` below before building a client for this.** It is
the field that decides whether the feature works at all, and the obvious default is the
one value that cannot.

| Field | Type |
|---|---|
| `id` | string, a UUID |
| `sessionId` | string — the session this will be delivered to. Always a session that existed when the message was written; a message whose session is later deleted is deleted with it |
| `cwd` | string — where that session was working when this was written. **Display only**: the delivery re-resolves the directory from the session itself, so a checkout that moved is a recorded failure rather than a message sent somewhere else |
| **`projectName`** | string — derived, not stored, exactly as on a draft |
| `text` | string. May be `""` when `attachments` is non-empty — a screenshot with nothing typed under it is a message |
| **`attachments`** | **array of objects**, `[{path, relPath, mediaType}]`, each of the last two a string or null; `[]` for most messages, at most 5. Files already written by the attachments route. Re-derived against the session's own directory at delivery, so one tidied away in the meantime is dropped rather than failing the message |
| **`model`** | **string or null.** `null` is `inherit`. Not `""` |
| **`permissionMode`** | string, one of the six in `POST /api/sessions/:id/send`, and **never absent** — see below |
| `at` | number, epoch ms — when it is due |
| **`state`** | string, one of `pending` · `delivering` · `sent` · `missed` · `failed`. `delivering` is a claim a tick holds and is normally seen only for a moment; a client should draw it as in-progress rather than as a state of its own |
| **`late`** | **boolean** — derived per request, and `true` only on a `pending` row that is now past its window. The window lives on the bridge, so a client cannot compute this; without it a chip would say "in −20 minutes" about a message that is never going to be delivered |
| `test` | boolean — **copied off the target session's own `test` flag** when the message was written, not chosen by the caller. It decides which bridge delivers the row; see below |
| `createdAt`, `updatedAt` | numbers, epoch ms. `createdAt` never moves |
| `sentAt` | **number or null**, epoch ms — when it was handed to the process. `null` until then |
| `error` | **string or null** — why it is `missed` or `failed`, in a sentence fit to show |

Ordered **soonest `at` first** — the order they will happen in, which is the order to
read them in. Delivered and missed rows keep their place in that order rather than
moving to an end.

`counts.pending` counts only `state: "pending"`, so it is what a badge should draw;
`counts.total` includes the week of history described under retention.

#### `permissionMode` is the feature, not a detail of it

A permission ask raised while **no client is attached to `/api/events`** is denied
immediately, and two denials stop the turn — see *Being connected is load-bearing*. A
message delivered at 02:00 therefore does not run unattended in `auto`; it stalls on the
first tool call and gives up, and the only sign is a session that did nothing in the
night.

So: **the mode is stored per message, is required on create, and is never defaulted at
delivery.** `web/app.js` offers `bypassPermissions` first and remembers the last choice.
A client that omits the field gets a `400` rather than a silent `auto`, which is the one
place this deliberately departs from `POST /api/sessions/:id/send`.

The mode is also applied on the way in: delivering with a model or mode that differs
from the session's current one replaces the process, exactly as a `/send` with a changed
mode does. That is why the tick **waits for the session to be idle** in that case rather
than delivering behind the turn — replacing the process ends the turn in flight, and
killing a 2am turn to deliver a message meant to help it would be the worst thing this
could do. A message whose mode already matches is simply queued behind the turn.

#### Which bridge delivers, and when it gives up

**One hour of grace.** A message more than an hour past its time is marked `missed` and
**not delivered**, with a loud notification. That is far tighter than the schedule tick's
12-hour catch-up on purpose: a *session* started seven hours late is merely late, but an
*instruction* seven hours late is the wrong instruction, and this one arrives carrying
the permission to act on itself.

**The everyday bridge delivers real messages and a dev bridge delivers `test` ones**, the
same symmetric rule the schedule tick applies — but here the flag is not something a
caller sets. It is copied off the target session, so it says no more than "the bridge
that owns this session is the one that delivers to it". Unlike schedules this needs no
`TGXCODE_SCHEDULE_ON_DEV`: a scheduled message can only speak to a session that
already exists, so there is no unattended-agent-in-the-user's-checkout hazard for that
variable to guard.

**A message interrupted mid-delivery is marked `failed` and never retried.** If the
bridge stops between claiming a message and hearing back, the message may already be in
the transcript — `claude` writes its user entry at submission — so re-sending it would
re-run work that has already happened. The `error` says so.

**Retention.** `sent`, `missed` and `failed` rows are kept for **seven days** and then
dropped, and every row for a session goes when the session is deleted. So a client must
treat this list as something that shrinks underneath it.

Also pushed as the `later-changed` SSE event, carrying this same payload.

### `GET /api/sessions/:id/later`

→ `{messages: [...]}`, the same rows as above filtered to one session. Nothing else
differs; it exists so a conversation view does not have to hold the whole list.

`404` for an unknown session. An empty `messages` is the normal answer.

### `GET /api/snippets?cwd=<path>`

Canned messages, and the groups they are drawn in. What replaced the one hard-coded
LGTM button on the composer.

```json
{
  "at": 1787328400656,
  "snippets": [
    { "id": "seed-lgtm",
      "title": "LGTM",
      "body": "LGTM — take it from here and land it.\n\n- If this work is not on a pull request yet…",
      "hint": "open a PR for this work if there is not one, run the checks, and merge it once they pass",
      "groupId": null,
      "params": [],
      "insert": "overwrite", "autoSubmit": true, "permissionMode": null,
      "pinned": true, "order": 0, "projects": [],
      "undeclared": [], "unused": [],
      "createdAt": 1787328400891, "updatedAt": 1787328400891 },
    { "id": "6b1f0e2c-6b8a-4f0e-9a1d-2c4b7e5a0f31",
      "title": "Review a branch",
      "body": "Review {{branch}} against main, and cap it at {{count}} findings.",
      "hint": null,
      "groupId": "d4c0a1b2-77e3-4a55-8c19-0f2b6d3e91aa",
      "params": [
        { "name": "branch", "label": "Branch", "type": "text",
          "required": true, "default": null },
        { "name": "count", "label": "How many at most", "type": "integer",
          "required": false, "default": "5" }
      ],
      "insert": "cursor", "autoSubmit": false, "permissionMode": "plan",
      "pinned": false, "order": null,
      "projects": ["/home/dylan_hays/Other"],
      "undeclared": [], "unused": [],
      "createdAt": 1787328401276, "updatedAt": 1787328401276 }
  ],
  "groups": [
    { "id": "d4c0a1b2-77e3-4a55-8c19-0f2b6d3e91aa", "name": "Review",
      "accent": "#d0bcff", "order": 0,
      "createdAt": 1787328400891, "updatedAt": 1787328400891 }
  ],
  "counts": { "snippets": 2, "groups": 1, "pinned": 1 }
}
```

| Field | Type |
|---|---|
| `id` | string, a UUID — except for the shipped ones, whose ids are stable strings like `seed-lgtm` |
| `title` | string, non-empty, trimmed. What the row and the pinned button say |
| `body` | string, non-empty — **and not trimmed**, unlike a draft's `prompt`. An `insert` of `append` or `cursor` makes leading and trailing whitespace part of what the snippet means |
| `hint` | string or null — the sentence a pinned button shows on hover. Null means *use the first line of the body*, which is a guess; a hint is a decision |
| `groupId` | string or null. Null is ungrouped, which is a place in the popover rather than a group with no name. **May name a group that is not in `groups`** — draw it ungrouped and leave the field alone; another bridge may be about to write that group, and it heals itself |
| `params` | array of `{name, label, type, required, default}`, possibly empty — see below |
| `insert` | `overwrite`, `append` or `cursor` — where the body lands in the compose box |
| `autoSubmit` | boolean. True sends it; false leaves it in the box |
| **`permissionMode`** | **string or null.** One of the six in `POST /api/sessions/:id/send`, or `null` for **inherit** — leave the mode selector exactly where the user left it. `null` is not `auto`: `auto` is a choice to *move* the selector. Only meaningful when `autoSubmit` is true, and kept regardless, so turning `autoSubmit` off and on again does not lose the mode |
| `pinned` | boolean — gets a button of its own in the composer toolbar, beside the snippets icon |
| **`order`** | **integer or null.** Null means *sort me alphabetically*, and sorts **after** everything carrying a number. Nulls are never interleaved with numbers: an explicit order is a decision and null is the absence of one |
| `projects` | array of absolute paths, already expanded, possibly empty. Empty is everywhere — see the matching rule below |
| **`undeclared`, `unused`** | **arrays of strings, derived rather than stored.** `undeclared` names the `{{placeholders}}` in `body` that no param declares; `unused` names the params nothing references. **Neither is an error** and no route refuses on either — they are here so an editor can say so quietly, computed on the bridge so three clients cannot disagree about what counts |
| `createdAt`, `updatedAt` | numbers, epoch ms. `createdAt` never moves |

A **param** is `{name, label, type, required, default}`.

| Field | Type |
|---|---|
| `name` | string matching `[A-Za-z_]\w*`, unique within the snippet. This is its identity: `{{name}}` in the body is what refers to it |
| `label` | string or null. Null means *use the name*, so a parameter is never an unlabelled box |
| `type` | `text`, `integer`, `decimal`, `date`, `time` or `datetime`. **The list is meant to grow**, so treat an unrecognised type as `text` rather than failing — that is what this bridge does with one, so a snippet written on a newer build stays editable on an older one |
| `required` | boolean — may not be left empty when the dialog is confirmed. A `default` only pre-fills, so the two do not cancel out: a required param with a default is one you can clear and must then refill |
| `default` | string or null, **untrimmed**. Always a string whatever the `type`, because the substitution is textual — an `integer` default is `"5"` |

A **group** is `{id, name, accent, order, createdAt, updatedAt}`. `accent` is a
`#rgb` or `#rrggbb` colour, or null. Strict, because of where it ends up: the client
sets it as a CSS custom property on the group's card, so anything looser would be a
declaration in the page's stylesheet rather than a colour.

**Placeholders are declared, not discovered.** `{{x}}` becomes a question only because
a param is named `x`; anything else is **left in the message verbatim**. That is
`fillPrompt`'s rule for schedules, down to the expression — `\{\{\s*(\w+)\s*\}\}` — and
it is there for the same reason: `{{` is not reserved punctuation in prose, and blanking
what nothing declares would quietly delete part of a message somebody wrote. A typo'd
`{{brnach}}` arriving in the session as itself is a bug you can see. An unanswered param
falls back to its `default` and then to the placeholder — **never to the empty string**.

**`projects` is a prefix match at a path boundary.** A snippet applies when the
composer's working directory *is* one of the listed paths or lies *underneath* one:
`/home/me/proj` matches `/home/me/proj/web` and does **not** match `/home/me/proj-old`,
which is a different repository sharing fourteen characters. Empty means everywhere.
Case-sensitive. Prefix rather than "the same project" deliberately: a project's root is
derived from git, and a filter built on that would change what the popover contains when
a directory stops being a repository. The cost is worktrees, which are siblings rather
than descendants and need their own entry.

`?cwd=` applies that filter here, for a client that would rather not implement it — but
`counts` is deliberately left whole, so a popover can say how many are hidden rather
than shortening its list in silence. **The `snippets-changed` event is never filtered**,
so a client that narrows its first load must narrow the event too, or its list widens
the moment anybody edits anything.

Ordered the way it should be drawn, and the bridge decides that so the popover, the
pinned strip and the editor cannot come to three answers: explicit `order` ascending,
then everything unnumbered alphabetically by title, then by id so a tie never depends on
where a row sat in the array. Two rows genuinely can share an `order` — the file is
hand-editable, and two bridges number independently.

**On first run the store seeds itself with `LGTM`**, the button this feature replaced,
pinned and set to send itself. Seeded **once ever**: the file records which shipped
snippets it has been offered, so deleting it is permanent and a later release adding a
second shipped snippet will not bring it back. Deleting
`~/.local/share/tgxcode/snippets.json` outright is how to get the shipped ones
again.

Global — not per-session and not per-project. `projects` is the only scoping and it
hides rather than partitions.

Also pushed as the `snippets-changed` SSE event, which is how the UI reads it. That
event carries this same payload, so a client never has to come back here after the
first load.

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
      "spent": false,
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

**The prompt a scheduled session receives is not the stored `prompt`.** On top of the
placeholder substitution above, the bridge **appends a note telling the agent it is
running unattended** — that a schedule started the session rather than a person, that
no question it asks will be answered before it finishes, and that its findings belong
in the transcript. It is appended and never prepended, so the head of the stored
prompt is still the head of what was sent.

This applies to every scheduled run: the tick, the pull-request drain, and
`POST /api/schedules/:id/run`. "Run now" is included on purpose — that button exists
to produce a session identical to the one the clock produces.

A client showing "what will run" is therefore showing the stored text, which is the
right thing to show and edit; it is just not byte-for-byte what the session is sent.

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
| **`nextRunAt`** | **number or null**, epoch ms — derived, computed per request. `null` when the schedule is paused **or** when the expression matches no future date (`0 0 30 2 *` parses and never fires). Those two are different states, and **`enabled` does not tell them apart on its own** — see `spent` below |
| **`spent`** | **boolean** — derived, computed per request. `true` when this schedule will not fire again. **This is the field that separates *paused* from *finished*,** and nothing else on the row does: the bridge clears `enabled` on a one-time schedule the moment its slot passes, so a spent row and one you paused by hand carry the same `enabled: false` and the same `nextRunAt: null`. Two ways to be `true`: an expression with no future date at all, which is `true` even while `enabled` is; and a `once` row the bridge switched off, which is `once && !enabled && lastSlotAt != null` — all three, because cron has no year field (so a `once` can sit on a repeating expression and have a real next slot until it has taken one) and because arming a spent one again resets its slot cursor rather than clearing it. `POST /:id/run` does not set it, since Run now leaves `lastSlotAt` alone. **A spent `once` with an `open-prs` gate can still be working** — see `sweepUntil` — so a client filing rows by lifecycle should check `reviewsInFlight` and the sweep window before it calls one finished |
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
With `TGXCODE_SCHEDULE_ON_DEV=1` a dev bridge fires schedules with `test: true`
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

`prs[]` are the whole `pulls.js` record, plus `matched` — `"branch"` (the workspace
has that branch checked out) or `"session"` (only a transcript connects them) — plus
the resolved `status` and `label` that `GET /api/sessions/:id/prs` documents, from
the same `resolveStatus`. Those two are the ones to draw from: this route used to
carry the raw record alone, so a client had to invent its own reading of `draft` and
`reviewDecision`, and `web/app.js` did — with the result that a merged PR, one
conflicting with its base and one with a failing build all rendered identically
while the other two surfaces showed three different glyphs. `detail` is **not**
here; ask `GET /api/sessions/:id/prs` if you want the tooltip lines.

The record, field by field — it was documented by reference before, which is the
"write the type, not the field name" mistake this document is supposed to avoid:

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
| **`status`**, **`label`** | **strings** — the resolved one-word status and its wording, exactly as `GET /api/sessions/:id/prs` defines them |

**A failed `gh` no longer empties the list.** The store keeps the pull requests it
last read successfully and reports the error beside them, so a hiccup no longer
looks like "nothing is open" — which used to last a full minute, and was a blank
panel for a reader and a trap for anything deciding what to act on. `gh.ok` is still
the field to check before concluding anything from an empty `prs`.

`sessions[]` are chips — `{sessionId, title, lastTs, userMessages,
active}` — capped at six per workspace with `moreSessions` counting the rest, and
carrying the same narrow five-field `runner` as `GET /api/sessions` where one is live.
A chip carries **no `schedule`**, so a client cannot tell a scheduled run from any
other here; its `title` is still the composed one, so the schedule's name and the date
it ran are in the text even though the field is not there to group on.

Only unfinished rows survive: a workspace with a clean tree and no open PR is dropped,
and so is a project left with no workspaces. `gh` fails once for everything rather than
per repository, because they all fail the same way — `gh` missing, or a login that
expired.

**This route shells out to `git`, so it is slow and it is cached** — working trees
for 15s. It no longer shells out to `gh` at all: pull requests come from the store
described under `GET /api/prs`.

`?refresh=1` drops the working-tree cache *and* forces a pass of the PR refresher,
awaiting it — so it is the slowest thing here and the only way to make the bridge
ask GitHub out of turn. It is a button, not a poll. A client that wants to know when
PRs move should listen for `prs-changed` instead.

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
`peer-message`, `handoff`, `schedule-findings`, `schedule-failed`, `schedule-missed`,
`later-failed`, `later-missed`.
`summary` is clipped to 200 characters and `detail` to 400.

**`sessionId` may be `null`, and it is on two of the three schedule types.** Every row
used to be about a session, so a client could treat `sessionId` as always present and
`title` as always the session's. A schedule can fail *without* producing a session — a
missed slot, a ref it could not resolve, a working directory that has moved — and those
are exactly the rows worth raising. On such a row `title` is the schedule's name and
there is nothing to navigate to, so **a client that links the whole row to
`/api/sessions/<sessionId>` must check for `null` first**. `schedule-findings` does
carry one; the other two do not.

**The two `later-` types always carry one**, and that is not an accident of this
implementation: a scheduled message is written against a session that exists, so there
is always somewhere for the row to open. `title` on those is the *session's* title, not
a schedule's. `later-missed` means the bridge was not running when the message was due
and more than an hour had passed by the time it could be; `later-failed` means a
delivery was attempted and did not land, or was interrupted mid-flight. In every case
the message survives in `GET /api/later` with its `error` set, so nothing anybody wrote
is lost.
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

History is kept in `~/.local/share/tgxcode/notifications.jsonl`, appended a
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
             at, ok, probed, reaped, reason, screen, ms } }
```

An **array**, not an object keyed by window — the order is meaningful (5-hour
first, then the weekly ones, then anything unrecognised) and a client should
render it as given.

| Field | Type |
| --- | --- |
| `type` | string — `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`, or `unspecified` for an event the CLI sent with no window named. **Not a closed set** — render an unknown one from `label` rather than dropping it |
| `label` / `shortLabel` | string — humanised (`5-hour` / `5h`). For an unknown `type` both are the raw id |
| `usedPercent` | **number 0–100, or null.** Null means nobody has said, which is *not* zero. Note the scale: the CLI's own `rate_limit_event` carries `utilization` as a 0–1 fraction and the bridge multiplies it here |
| `usedPercentAt` | number, unix seconds, or null — **when that percentage was learned**, per window. Not one timestamp shared by the response: two windows here can be stamped hours apart, because they are written by whichever terminals happen to be open and each holds a reading of its own age. It also advances only when the percentage itself *changes* — a terminal re-reporting the same 3% has learned nothing, so a steady number ages and eventually greys by design |
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

**A window can disappear, and a client must let it.** One whose `resetsAt` has
passed is dropped rather than shown: its percentage describes a period that has
ended, and 25% of a window that is over says nothing about the window you are in
now. So treat `windows` as the whole truth on every snapshot — do not keep the
last-seen entry for a type that stopped appearing, and do not carry a value
across a reset. Absent means *unknown*, which is the same claim `usedPercent:
null` makes and needs the same rendering. A window comes back with a real
percentage the first time a terminal reports the new period.

`statusLine.present` is false when the harvester has never run, which is what
lets a client offer the setup step (`node scripts/install-quota-statusline.js`)
rather than showing an empty gauge. `statusLine.capturedAt` is the freshest
per-window stamp in that file, so it does **not** advance merely because some
terminal re-rendered and re-confirmed a number nobody has changed. Do not read
it as "the harvester is alive": on a quiet account it legitimately stops moving
while everything is working. `beacon.at` is the liveness signal.

**`beacon` says why the number is or is not moving**, and a client should show
it rather than leaving a stale reading unexplained. The beacon starts a
short-lived `claude` in a directory the user has named, purely so its startup
quota probe runs and the status line can be harvested — see `bridge/beacon.js`.

| Field | Type |
| --- | --- |
| `enabled` | boolean — on *and* pointed at a directory. Off is the default and means the percentage only refreshes while a terminal is open |
| `suppressed` | `"dev-bridge"` or null. A development bridge does not run the beacon even when `enabled` is true: the reading is account-wide, so the everyday instance owns the probe, and a worktree bridge doing it too spends quota to measure quota. `TGXCODE_BEACON_ON_DEV=1` overrides it. When this is set, `at`/`ok` describe some older run and will not advance |
| `dir` | string or null — where it runs. The user names it in `~/.tgxcode/settings.json`, **user file only**: a project's `.tgxcode/settings.json` is checked into a repository and cannot set this |
| `everyMinutes` | number or null — floor of 5 |
| `running` | boolean — a run is in flight right now |
| `at` | number, unix seconds, or absent — when the last run finished |
| `ok` | boolean or absent. **Absent means it has never run**, which is not the same as failing. True means **this run's own reading landed**, proved by a receipt file that only this run could write. It previously meant only that the shared harvest file changed while the run was up — which any other open terminal causes — so a run blocked behind a folder-trust dialog, having rendered nothing at all, reported success |
| `probed` | boolean — the status line rendered at least once. This splits the two failures that used to be indistinguishable, and the client's advice should differ: `ok:false, probed:false` means it never got that far and `screen` names the dialog somebody has to go and answer; `ok:false, probed:true` means the CLI came up fine and its quota probe never answered, which is nothing the user can act on |
| `reaped` | number or absent — **process groups** killed before this run, belonging to beacons left behind by bridges that are no longer running. One leaked beacon counts as two, so do not read it as a count of beacons. Normally 0; a number that stays non-zero means something is still leaking them and is worth reporting, not a status to draw for its own sake |
| `reason` | string, present when `ok` is false. Read it with `probed`: a timeout with `probed:false` is a dialog waiting in a TUI nobody can see, and with `probed:true` it is the probe itself never answering |
| `screen` | string or absent — a one-line readable tail of that TUI, so the dialog can be named. Escape sequences are stripped and it is capped at 400 chars |
| `ms` | number or absent — how long the run took. A healthy one is a few seconds |

A failing beacon is **not** an error condition for a client: the previous
reading stands and ages visibly. Draw the reason, do not raise anything.

**Readable by a remote caller**, deliberately: it names no session, no path and
no machine, and deciding from a phone whether there is room to release a draft is
the same case the draft routes are open for.

### `POST /api/quota/refresh`

Harvest a percentage **now**, rather than waiting out `beacon.everyMinutes`.
Body is ignored. Like every non-GET under `/api/`, it needs
`X-TGXCode-Client: 1`.

```
200 { ok: boolean, quota: <the GET /api/quota payload> }
409 { error: string, needsSetup?: true, running?: true, quota: <same> }
```

The response carries the **whole quota payload**, so one round trip both runs
the refresh and returns what it produced — do not follow it with a `GET
/api/quota`. `ok` is the run's own outcome, and it being false is not an error:
read `quota.beacon.reason`, `quota.beacon.probed` and `quota.beacon.screen`
exactly as you would after an automatic run. **A 200 with `ok: false` is the
normal way a blocked run reports itself.**

Two refusals, and neither is a failure worth an alarm:

| Status | Body | Means |
| --- | --- | --- |
| `409` | `needsSetup: true` | No `quota.beaconDir` is configured, so there is nowhere to run. Offer the setup step; retrying will not help |
| `409` | `running: true` | A run is already in flight — a double press, or the timer got there first. A reading is already on its way |

It runs the same beacon the timer runs — being an interactive TUI for a few
seconds is still the only way to make a status line render — so it costs one CLI
start and one `max_tokens: 1` request, takes a few seconds, and **pushes the
automatic interval out by a full period.** Pressing this is not followed by a
scheduled run a minute later.

Two deliberate differences from the timer. It ignores `quota.beacon`, which
governs the *automatic* clock only: a machine that has named a trusted directory
and left the timer off is exactly the one where a manual refresh is the point,
so only `beaconDir` is required. And it is **not** suppressed on a development
bridge, where `beacon.suppressed` is `"dev-bridge"` and the timer never fires —
that gate exists to stop a worktree bridge spending quota on a clock nobody
asked about, and a caller pressing a button has asked.

**Allowed to a remote caller**, which is a decision rather than an omission. The
GET beside it is open for deciding from a phone whether there is room to start
something, and a stale number is the whole problem with doing that — so a phone
that can read the percentage can ask for a current one. It is not the class of
thing `/api/commands/run` and `/api/runs` are refused for: those run whatever a
repository declares, and this runs one fixed operation, in a directory the user
named and trusted, that the bridge already performs unattended on a timer. Only
one can be in flight at a time, so it cannot be turned into a fan of processes.

### `GET /api/claude-version[?refresh=1]`

Whether Claude Code is current, in both senses that matter: is the installed binary
behind the registry, and are any live sessions still running a binary older than the
installed one. Claude Code updates itself, and a process keeps the binary it started
on — so after an auto-update the second is common and the first is not.

```
200 {
  installed: string | null,     // `claude --version`, e.g. "2.1.280"; null if it could not be run
  latest: string | null,        // the newest on `channel`, from the npm registry; null if never reached
  channel: 'stable' | 'latest' | 'rc',   // autoUpdatesChannel in force; unset reads as 'latest'
  tag: 'stable' | 'latest' | 'next',     // the npm dist-tag `channel` was compared against
  behind: boolean,              // installed < latest. False when either is unknown
  staleSessions: [{ id: string, version: string }],  // live processes older than `installed`
  checkedAt: number | null,     // epoch ms of the last registry attempt
  error: string | null,         // why the last registry attempt failed; `latest` is then the last good answer
  updating: boolean,            // a POST .../update is running
  lastUpdate: { ok: boolean, at: number, output: string } | null
}
```

**`behind: false` does not mean current** when `latest` is null or `error` is set: it
means the bridge could not tell. Draw "cannot check" rather than "up to date" then.

The registry is asked at most hourly (at startup, then on a timer) and
`installed` is cached for five minutes; `?refresh=1` asks both again now. The
`rc` → `next` mapping is our reading of the registry, not something the CLI
reports; a channel whose tag the registry lacks falls back to `latest`.

`staleSessions` is derived from `runner.claudeVersion`, so it only ever names sessions
with a live process. **Open to remote callers** — which version is installed is not
sensitive, and a phone is a reasonable place to notice that sessions are on an old
binary.

### `POST /api/claude-version/update`

Runs `claude update` on the machine. Body is ignored; needs `X-TGXCode-Client: 1`.

```
200 { ok: boolean, output: string, summary: <the GET /api/claude-version payload, freshly checked> }
409 { error: 'an update is already running', running: true, summary: <same> }
403 { error, remote: true }    // remote caller
```

`ok: false` is the update's own failure (its output is in `output` and in
`summary.lastUpdate`), not an HTTP error. It can take up to three minutes; a
`claude-version` event carries the result to every other window.

**It changes the binary new processes start from and nothing else.** Running sessions
keep theirs — they appear in `summary.staleSessions` afterwards, and move over when
their process next starts. The bridge restarts nothing. **Refused to remote callers**:
it replaces an executable on this machine.

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
  measured-comfortable cadence. `GET /api/sessions/:id/tasks` is the poll that
  replaces `task-list`, and only while a conversation is open — it is a small
  answer off a 1s cache, so the transcript's cadence suits it.

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
| `task-list` | `{sessionId, source, items[], done, total, current, idle, ts, truncated}` — the **whole** `GET /api/sessions/:id/tasks` payload, so there is nothing to refetch. **Not a `POST /api/subscribe` flag of its own**: it rides the transcript follow, because a task list only moves while a turn is running and that is exactly when a client is following one. Sent **once as soon as a session is followed** — an open panel does not wait for the first change — and after that only when the list has actually moved, so a session with a static list is silent. Carries `sessionId`, so a payload for a conversation the client has left is safe to drop |
| `overview` | the board; sent only when it has actually changed |
| `taskboard` | the task board; every ~3s while watched, and only when it has actually changed. Never carries `?idle=all` |
| `drafts-changed` | `{at, drafts[], counts}` — the whole `GET /api/drafts` payload, so there is nothing to refetch. **Not gated by a `POST /api/subscribe` flag**, unlike `overview` and `taskboard`: a draft only changes because somebody changed it, so there is no tick to switch on and every window gets every change. Fires on create, edit, delete, and on anything that consumes one — `POST /api/drafts/:id/start`, and a `fromDraft` on `POST /api/sessions` or `POST /api/schedules` |
| `later-changed` | `{at, messages[], counts}` — the whole `GET /api/later` payload, so there is nothing to refetch. Ungated, exactly as `drafts-changed` is. Like `schedules-changed` and unlike `drafts-changed` it also fires **without anybody having done anything**: a delivery, a message going past its window, and a failed wake all move it. That is how a chip starts saying "sent 02:00" while nobody is looking at it, and it is the only signal a client gets that a scheduled message has left — the session list is not pushed for it |
| `snippets-changed` | `{at, snippets[], groups[], counts}` — the whole `GET /api/snippets` payload, so there is nothing to refetch. Ungated, exactly as `drafts-changed` is, and like it, it never fires without somebody having done something: a snippet or group created, edited or deleted, and a reorder **that actually moved a row** — a drag that lands where it started pushes nothing. Both arrays every time, because deleting a group re-homes its snippets and sending half the answer would leave a client drawing a card that no longer exists. **Always unfiltered by `cwd`**, so a client that fetched with `?cwd=` must apply the filter itself here or watch its list silently widen |
| `schedules-changed` | `{at, schedules[], counts}` — the whole `GET /api/schedules` payload. Ungated, exactly as `drafts-changed` is. Unlike that one it fires **without anybody having done anything**: a schedule firing, skipping a slot, or having its outcome recorded when the turn ends all push it. So a client that assumed the payload only moves in response to a user action will be wrong here, and pleasantly so — this is how a card starts saying "ran 2h ago — BLOCK" while nobody is looking at it |
| `sessions-changed` | `{at}` — a nudge to refetch the list |
| `prs-changed` | **the whole `GET /api/prs` payload** — `{sessions, gh, checkedAt}` — so a rail has nothing to refetch. Ungated, exactly as `drafts-changed` is, and like `schedules-changed` it fires **without anybody having done anything**: it is a background refresher noticing that a review landed, a build finished, or somebody merged. Fires only when the answer actually moved, so a pass that re-lists a quiet repository and finds it unchanged pushes nothing — this is not a heartbeat and must not be treated as one. It is the *only* signal that PR status changed; there was none before, and clients polled. A client wanting per-PR detail for one session should refetch `GET /api/sessions/:id/prs` on this event, which is cheap and does not shell out |
| `peer-message` | `{at, sessionId, from, count}` — another session messaged this one. The message itself is in the transcript, so a client tailing it has already drawn it; this is for everything that is not the open pane |
| `handoff` | `{at, sessionId, from, count}` — another session handed this one work, and it was resumed to deal with it. Same shape and same reasoning as above; watched in the transcript rather than reported by the route, so it fires when the message *arrived* rather than when it was queued |
| `suggestion-changed` | `{at, sessionId, toolUseId}` — a suggested follow-up was started, dismissed, or undone, possibly in another window |
| `session-deleted` | `{sessionId, title}` |
| `prefs` | the **user-level** settings, in the same shape as the `cs-prefs` `<meta>` tag: `{version, transcript, live, projects, quota, spinner, keyboard, toolbar, wispr}`, with no `sources` or `problems`. Fired on every `PUT /api/prefs` including your own, so a second window does not sit on a stale copy — two are routinely open here. A project's answer is deliberately not sent: it is the open session's business and arrives with `GET /api/sessions/:id` |
| `claude-config` | `{at: number, scope: 'user'\|'project'\|'project-local'\|'managed', file: string}` — the *fact* that one of Claude Code's settings files changed, and deliberately **not** its content. Unlike `prefs` there is no `<meta>` copy for a page to keep in sync and nothing in this app behaves differently because of those files, so the event is a nudge to re-read; pushing the contents of a file whose route is local-only down every open channel would be a poor trade for saving a fetch. Fired on every successful `PUT /api/claude-config`, including your own — **and on a change this bridge did not make**: `claude` writes these files itself, so `theme` or `editorMode` from `/config`, `enabledPlugins` from a plugin toggle, and a rule appended to `settings.local.json` when somebody approves a permission mid-turn all arrive here too. `scope` may then be `managed`, which no `PUT` can produce. **Two caveats a client has to hold.** It is best-effort: the bridge watches directories with `fs.watch`, which throws on some filesystems and silently does nothing on others, so a change can go unannounced — keep treating `409 {code:'stale'}` from `PUT /api/claude-config` as the guarantee, and this only as the convenience that usually saves you from meeting it. And a project's two files are watched only once `GET /api/claude-config?cwd=<dir>` has been called for that directory, only for a small number of directories at a time (least-recently-read dropped first), and not after ten minutes without another read of it; the user file and the managed file are watched throughout. So poll or re-`GET` if you need certainty about a directory you have not asked about |
| `claude-docs` | `{at, scope, file}` — the same trade for a `CLAUDE.md`: the fact one was written, never its contents. `scope` is `"user"` or `"project"`. Fired on every successful `PUT /api/claude-docs`, including your own. **A client holding an unsaved draft must not reload on this** — show a conflict and keep what the person typed; the whole draft here is somebody's prose rather than one key |
| `notification` | a whole notification row, just filed — the same shape `GET /api/notifications` returns, `read` included — plus `unread`, the badge count after this row. So an open history view need not refetch, and need not guess whether the new row counts |
| `notification-resolved` | `{id, outcome, outcomeAt}` — patch the row with that `id`; fired alongside `permission-resolved` |
| `notification-read` | `{sessionId: string\|null, at: number, unread: number}` — a watermark moved, here or in another window. `sessionId` is `null` when the whole log was marked. Fold `at` into your copy of `read` and repaint |
| `notifications-cleared` | `{at}` — the log was emptied, by this window or another |
| `runner-status` | see below |
| `permission-request` | `{sessionId, ...ask}` |
| `permission-resolved` | `{sessionId, requestId, outcome}` |
| `notice` | `{sessionId: string, level: 'warn', kind: string, text: string}` — something worth telling the user that is not a permission ask. Every notice the bridge sends today is `level: 'warn'`; treat any other level as informational. `kind` is one of `no_permission_prompt`, `permission_uninteractive`, `mode_change_failed`, `permission_auto_denied`, `permission_denied`, `api_retry`, `turn_failed`, `rate_limit` — and an unrecognised kind is a plain warning, not an error. **`rate_limit` is not one per limit: it repeats on every turn for as long as the limit holds**, because the CLI sends an identical `rate_limit_event` each time and this one is not deduplicated the way the `quota` event below is. A client that toasts it unconditionally therefore stacks the same warning over and over for an afternoon. `web/app.js` drops this kind entirely and flashes the header quota pill off the `quota` event instead; a client with nowhere to put a persistent indicator should throttle the toast itself. Everything the notice says is also in `GET /api/quota` — `windows[].status` for the current state and `events` for the history |
| `claude-version` | **the whole `GET /api/claude-version` payload**, so there is nothing to refetch. Ungated, no `sessionId`. Sent when the summary moved: the hourly registry check found a newer version, an update finished, or a process started or ended on a version that changes `staleSessions`. Debounced by about a second |
| `quota` | **the whole `GET /api/quota` payload**, so there is nothing to refetch. Ungated, like `drafts-changed`. Fires only when a reading actually moved — the CLI sends an identical `rate_limit_event` on every turn and those are dropped rather than pushed. Note it carries **no `sessionId`**: quota is account-wide, and which session happened to observe it says nothing. A window that has been near a limit for an hour will therefore push nothing at all, which is why `usedPercentAt` matters more than the arrival time of this event |
| `turn-complete` | `{sessionId, isError, detail, retries, costUsd, durationMs, numTurns, stopReason}` — the runner's `lastResult` with the session id on it. `detail` is null unless `isError` |
| `send-failed` | `{sessionId, kind, message, unsent: [text]}` — a send that never became a turn; hand the text back to the user. `unsent` is an array of **strings**, in send order, and may be empty — the event still means the send failed, and `message` is then the whole of it. `kind` is one of `busy-elsewhere` (the session is running somewhere else; offer to branch), `no-claude`, `missing`, `unknown`, `exited` (the process ended without answering) or `retired` (the bridge shut the process down with messages still queued). Treat an unrecognised kind as `unknown`. Attachments are **not** carried: a message that had files comes back as its text alone |
| `session-forked` | `{from, to}` — follow the new id |
| `slash-commands` | `{cwd, at}` — that directory's slash commands changed; drop what you cached |
| `run-changed` | `{runId, workspace, commandId, label, state, port, http, exit, stopped, at}` — a project command moved; state only, never output. `http` (bool) as in the run record; it can turn `true` in an event of its own, a second or so after the one that said `listening` |
| `commands-config` | `{at, scope, project, file}` — a project's `.tgxcode/` command file was written through `PUT /api/commands-config`. The fact of a change, never its content: these files carry `env` values the route classifies as local-only, and this channel reaches a paired phone. Re-read the file, and re-read `GET /api/commands` for any directory inside `project` — a renamed command's button does not change on its own. It does **not** fire for a hand edit; nothing watches these files, and the `409` on save is what catches that |

`runner-status` is the full shape — the one the two narrower `runner` objects are cut
down from:

| Field | Type |
|---|---|
| `sessionId`, `model`, `permissionMode`, `cwd` | strings or null |
| `state` | `"stopped"`, `"starting"`, `"idle"`, `"busy"` or `"error"` |
| `activity`, `verb`, `detail` | strings or null — see below |
| `error`, `errorKind` | strings or null |
| `queued` | number — how many messages are waiting, handed-over ones included |
| **`queue[]`** | **array of objects** — `{id, text, at, attachments[], handed}`, the messages themselves, because the composer draws a chip per entry and needs the `id` to cancel or reorder it. `attachments` is metadata only; the base64 is read at flush time and never travels here. **`handed`** bool — see below |

**A queued message can land inside the running turn.** While a tool call is running,
the bridge hands everything waiting to the CLI (`handed: true`), and the CLI folds it
into that turn once the tool round ends. The model reads it next to the tool result,
the way a message typed in a terminal mid-turn is read. A message sent while the turn
is only writing text, or while nothing runs, waits for the turn to end as before. Three
things follow for a client:

- **One `turn-complete` can answer several messages.** Do not pair them one to one.
- **A handed message sits at the front of `queue[]` and keeps its place there.**
  `reorder` ignores its id. It can still be dropped (`DELETE …/queue/:qid`), because
  the bridge asks the CLI for it back, but that can lose the race and return `409`.
- **It leaves `queue[]` when the turn reads it**, and turns up in the transcript as an
  ordinary `user` event (see below). There is no separate event for the fold.

Handing over happens only when the process has shown it supports it. Builds without the
CLI's command queue keep the old one-turn-at-a-time behaviour, and `handed` is then
always false.
| **`pendingPermission`** | **object or null** — the whole ask, same shape as `permission-request` |
| `canPrompt` | bool — whether this process supports permission prompts at all |
| `busySince` | number or null — epoch ms, and null unless `state` is `busy` |
| `claudeVersion` | string or null — the Claude Code version **of the running process**, from its `system/init` line (e.g. `"2.1.280"`). Null until the process has started and whenever there is none, so an idle session with no process is never "on an old binary": its next message starts whatever is installed then. This is not the summary's `version`, which is the first binary that ever wrote the transcript. Carried over when a bridge adopts a process from the session host. See `GET /api/claude-version` |
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

`{cwd, prompt, model?, permissionMode?, test?, attachments?, fromDraft?}` →
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

**`fromDraft` is a draft id to consume** — the id of a `GET /api/drafts` row this call
was built from, for a client that loaded a draft into its own form and then started the
result instead of saving it. The draft is deleted **after** the session spawns and only
if it did, so a `400` here leaves it exactly where it was; a `drafts-changed` push
follows the deletion, before the response. Same field, same rule and the same reasoning
as `POST /api/schedules`, and an id naming no draft is **not** an error — the session
started, which is what was asked for.

The fields sent here are what start, and they are **not** written back to the draft
first. Editing the prompt and passing `fromDraft` runs the edited prompt and drops the
draft unedited: sending it is a decision not to keep the draft. A client that wants the
edit kept should `PATCH /api/drafts/:id` and then `POST /api/drafts/:id/start`.

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

**This is not the only way a draft is consumed.** `POST /api/sessions` and
`POST /api/schedules` each take a `fromDraft` id and delete it on success, for a client
that loaded a draft into its own form and then started or scheduled the edited version
rather than saving it. Use this route when nothing was edited: it needs no body, and the
arguments it spawns with are the ones on the file rather than ones the caller has to
send back.

### `POST /api/sessions/:id/later`

`{text, attachments?, model?, permissionMode, at}` → `{message}`, the row as
`GET /api/later` returns it.

The create lives on the session because a scheduled message is written *against* one.
Everything after this is about one message and takes no session in the path.

**`permissionMode` is required**, and that is the one rule worth reading twice. `/send`
normalises an absent one to `auto`; here an absent one is a `400`, because `auto` is the
single mode that cannot work when nobody is watching and making it the silent default
would mean a feature that fails only at night. See *`permissionMode` is the feature*
under `GET /api/later`.

`at` is epoch ms, must be **in the future** and **within 30 days** — the upper bound is
what makes a typo'd year a refusal rather than a row that sits in the file forever.

`text` may be empty when `attachments` is non-empty, the send route's rule. `attachments`
is `[{path, relPath?, mediaType?}]`, at most five, naming files already uploaded through
`POST /api/sessions/:id/attachments`.

`test` is **not** a field here: it is copied off the session.

`400` for a missing or past `at`, an `at` too far out, an empty message with no
attachment, or a missing `permissionMode`; `403` for a `permissionMode` a remote caller
may not ask for — `bypassPermissions` and `dontAsk`, the same pair refused everywhere
else, and **checked before the session is looked up**, so a refusal is a `403` whether or
not the id is real; `404` for an unknown session; `409` past **20 pending messages for
one session**, which is a ceiling and not a lifetime budget — cancelling one makes room.

### `PATCH /api/later/:id`

Any subset of `{text, attachments, model, permissionMode, at}` → `{message}`.

**A genuine partial**, `PATCH /api/drafts/:id`'s rule: a field left out is left alone, so
rescheduling does not restate the mode and cannot silently reset it. Every field is
validated as it is on create, and the body is checked before the id is looked up, so the
refusals are the same plus `404`.

`409` when the message is no longer `pending` — `{"error": "that message is sent — it
cannot be changed now"}`. Editing a message already handed to a process would be editing
the past.

`createdAt` is never touched; `updatedAt` always is.

### `DELETE /api/later/:id`

→ `{ok: true, id}`; `404` if there is no such message.

A hard delete, and it is how a message is **cancelled** — there is no `cancelled` state.
That asymmetry is deliberate: "it was sent" and "it was missed" are things you come back
in the morning to read, and a message you thought better of is not. Deleting a message
that has already been delivered clears the record of it and nothing more; the turn it
produced is in the transcript either way.

### `POST /api/later/:id/send`

No body → `{ok: true, message, status, queued, woke}` — deliver it now, whatever its
clock says.

**The same function the tick calls**, which is `POST /api/schedules/:id/run`'s rule and
matters for the same reason: "the button delivers what the clock delivers" is only true
if there is one path. That includes the wait-for-idle rule, so pressing this cannot end a
turn either.

- **`status` is a whole runner status object**, the `runner-status` payload for the
  process the message went to — not a word describing the outcome.
- `queued` says whether the message is still waiting behind a turn on this side, exactly
  as `POST /api/sessions/:id/send` uses it.
- `woke` is true when the delivery is what started the process. A woken session is
  watched briefly before this answers, so a `claude --resume` that refuses is a `502`
  here rather than a delivery falsely reported as made.

`404` unknown id. `403` for a `permissionMode` this caller may not send — re-checked
here and not only at write time, because the store is hand-editable and outlives the
process that wrote it. `409` twice over, and both mean *nothing happened, try again*: the
message is not `pending`, or the session is held in a terminal or mid-turn with a mode
this message would change. `502` for a delivery that was attempted and did not land; the
message is marked `failed` and its text is still in the row.

### `POST /api/snippets`

`{title, body, hint?, groupId?, params?, insert?, autoSubmit?, permissionMode?, pinned?,
order?, projects?}` → `{snippet}`, the row as `GET /api/snippets` describes it,
`undeclared` and `unused` included.

`400` for a missing `title` or `body`; a `title` over **200** characters or a `body` over
**20000**; an `insert` that is not one of the three; an `order` that is not an integer or
null; a `groupId` naming a group that does not exist; more than **20** params or **20**
`projects`; and a param whose `name` is not `[A-Za-z_]\w*` or repeats an earlier one — a
param's name is its identity, so a duplicate is not a thing that can be stored.

`403` for a `permissionMode` of `bypassPermissions` or `dontAsk` from a remote caller.

`409` past **200 snippets** — a ceiling and not a lifetime budget, so deleting one makes
room.

**Two fields normalise rather than refuse, and two do not, and the split is deliberate.**
An unrecognised param `type` reads as `text` and an unrecognised group `accent` reads as
no accent, because both are open sets whose worst case is a field that still holds the
right value. An unrecognised `insert` is a `400`, because its three values decide what
happens to text the user has *already typed* and one of them replaces it — there is no
fallback that is both the natural default and harmless. An unrecognised `permissionMode`
becomes `null` (inherit) rather than `auto`, because `auto` would be a silent decision to
move the user's mode selector and `null` is the only value that does nothing.

`body` is stored **exactly as sent**, not trimmed. It must be non-empty *once* trimmed,
which is a different test.

### `PATCH /api/snippets/:id`

Any subset of `{title, body, hint, groupId, params, insert, autoSubmit, permissionMode,
pinned, order, projects}` → `{snippet}`.

**A genuine partial**, drafts' rule: a field left out is left alone. `null` is a value and
absence is not — `{"groupId": null}` ungroups a snippet, `{}` changes nothing but the
timestamp.

**`params` is the exception, and it replaces rather than merges.** Send the whole array
or do not send the key. A param has no id — its name is its identity, and that name is
also what the body references — so there is nothing to address a partial update to, and
renaming a param while fixing the `{{…}}` that refers to it has to be one save or it can
half-fail.

Every field is validated as it is on create, so the refusals are the same, plus `404` for
an unknown id. **The body is checked before the id is looked up**, so a refused mode is a
`403` whether or not the snippet exists — the same order `PATCH /api/drafts/:id` uses and
for the same reason.

### `DELETE /api/snippets/:id`

→ `{ok: true, id}`; `404` if there is no such snippet.

A hard delete. **Deleting a shipped snippet is permanent** — the store records that it has
offered `seed-lgtm` once and never offers it again, so emptying the list and restarting
does not bring the button back. That is the point: a default that reappears does not read
as a policy, it reads as the delete having failed.

### `POST /api/snippets/reorder`

`{snippets?: [id, …], groups?: [id, …]}` → the whole `GET /api/snippets` payload.

Each array is the new order of the rows it names: they get `order` 0, 1, 2 … in the order
given. **Ids that are not there are ignored**, because a row somebody deleted in another
window mid-drag must not fail the save — and ignored all the way down, so a stranger does
not consume an index either and the numbering stays dense. **A row the body does not
mention keeps the `order` it had**, `null` included, so reordering one group is that
group's ids and touches nothing else and a client holding a stale list cannot renumber
snippets it has never seen.

A snippet's `order` is a global index rather than one within its group, which is not a
compromise: a client buckets by group and sorts inside each, so any sequence putting a
group's snippets in the right relative order is a right answer.

Idempotent. `updatedAt` moves only on rows whose `order` actually changed, and **nothing
is broadcast when nothing moved**. That is not cosmetic: bumping stamps on rows that did
not move would let a client re-sending its current order win the merge against another
bridge's later edit to those same rows.

This is also the right call for an up/down button rather than two `PATCH`es — a swap is
two rows, and doing it as two writes has an instant in the middle where both hold the same
number and two events go out.

`400` if a key that is present is not an array of strings.

### `POST /api/snippet-groups`

`{name, accent?, order?}` → `{group}`.

A sibling path rather than `/api/snippets/groups`, so that `reorder` is the only reserved
word under that prefix and `groups` can never be mistaken for a snippet id.

`accent` is `#rgb` or `#rrggbb`, and **normalises to null** if it is anything else —
strictly, because the client sets it as a CSS custom property, so `red`, `var(--x)` and
`#fff;}` would each be a declaration in the page's stylesheet rather than a colour.

`400` for a missing `name`, a `name` over **200** characters, or an `order` that is not an
integer or null; `409` past **40 groups**.

There is no `GET`: a group is only ever read as part of `GET /api/snippets`, and a route
returning half the popover's data would be one more thing for a client to keep in step.

### `PATCH /api/snippet-groups/:id`

Any subset of `{name, accent, order}` → `{group}`. A genuine partial; `404` for an unknown
id.

### `DELETE /api/snippet-groups/:id`

→ `{ok: true, id, orphaned: 3}`; `404` if there is no such group.

**Its snippets are not deleted, and they keep their `groupId`.** Deleting a container must
not delete its contents: the group is a name and a colour, and the snippets under it are
paragraphs somebody wrote. They draw ungrouped, and recreating a group with the same id
puts them straight back — which is also why the field is left alone rather than nulled, so
one bridge is not rewriting rows on the strength of a deletion another has not seen.
`orphaned` is how many came loose, so a client can say so rather than leaving somebody to
notice.

### `POST /api/schedules`

`{cwd, prompt, cron, once?, gate?, title?, model?, permissionMode?, test?, enabled?,
seed?, fromDraft?}` → `{schedule}`, the row as `GET /api/schedules` returns it.

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

**`fromDraft` is a draft id to consume** — the id of a `GET /api/drafts` row, for a
client turning a draft into a schedule. The draft is deleted **after** the schedule
row is written and only if it was: the draft is the copy of that work which still
exists if the save fails, so a refused create leaves it exactly where it was. A
`drafts-changed` push follows the deletion, before the response.

An id naming no draft is **not** an error. The schedule saved, which is what was
asked for, and the two reasons an id goes missing — it was already deleted, or it
belongs to a bridge with a different state directory — are both cases where the
right outcome is the schedule you asked for and no complaint.

It is not stored on the schedule and does not appear on the row; nothing after the
create has a use for it. `PATCH` does not accept it, because converting a draft
happens once.

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

### `PUT /api/prefs`

`{scope, cwd?, patch}` → `200 {file, prefs, files}`. **Local callers only**, and
the client header like every other write. Saves some of the settings
`GET /api/prefs` reports.

```json
{
  "scope": "user",
  "cwd": "/home/you/proj",
  "patch": { "transcript": { "groupMinCalls": 5 } }
}
```

`scope` is `"user"`, `"project"` or `"project-local"`, and with `cwd` it picks
exactly one file:

| `scope` | file |
|---|---|
| `user` | `~/.tgxcode/settings.json` — `cwd` ignored (under `TGXCODE_PREFS_DIR` instead when the bridge was started with it) |
| `project` | `<cwd>/.tgxcode/settings.json`, which git tracks |
| `project-local` | `<cwd>/.tgxcode/settings.local.json`, which is meant to be ignored — **check the repository actually ignores it**; this one does, since the Settings panel landed, but that is a line in a `.gitignore` and not something the bridge can promise |

`patch` is `{section: {key: value}}` and only the keys it names are touched, so
two clients editing different settings do not clobber each other. **A `null`
value removes the key** so the value falls back down the chain, which is not the
same as writing the default — it is the only way to say "I do not care about this
one" once you have said otherwise. A section left with no keys is removed too,
rather than left as `{}` in a file people read. Unknown keys already in the file
are preserved, and `version` is stamped.

**A key whose value is a map is still one key**, so naming it replaces the whole
map. That is true of all three — `keyboard.bindings`, `spinner.weights` and
`projects.colors` — and of the two lists, `toolbar.items` and
`projects.order`, and it is deliberate: a client that holds the resolved map
can say exactly what it wants by sending all of it, and there is no second
spelling that would have to mean "drop one entry". See each one under
`GET /api/prefs`.

The response is the answer that now holds: `file` is what was written, `prefs` is
`GET /api/prefs?cwd=` for the same directory, and `files` is its `files=1` half.
Take those rather than assuming the write landed where it matters — a save into a
file a stronger one already overrides changes nothing about what is in force, and
that is the case a client which assumed success draws wrongly.

**Everything is validated before anything is written, and the first failure
refuses the whole call** — including the valid keys beside it. That is the
opposite of what a *file* gets, where a bad value is dropped and the default
stands, and the difference is deliberate: a file is hand-edited and half of it
working beats none of it, whereas a client sending a value the bridge will not
keep is a bug in the client, and dropping it silently would leave a control
showing something untrue.

Refusals carry a `code` beside the message, so they can be told apart without
matching on prose:

| Status | `code` | |
|---|---|---|
| 400 | `scope` | not one of the three |
| 400 | `dir` | a project scope with no `cwd`, or one outside the allowed roots |
| 400 | `section` | no `patch`, or a section or key this bridge does not have |
| 400 | `value` | a value the key does not allow, or a binding that is not a usable combo |
| 403 | `readonly` | `quota`, `keyboard` or `projects` at a project scope |
| 403 | `unparseable` | the target file does not currently parse. Refused rather than replaced: whatever is in it is somebody's work |
| 403 | `write` | the file or its directory could not be written |

### `GET /api/claude-config?cwd=<path>`

**Local callers only — the read as well as the write.** See §*Refused for remote
callers*.

Claude Code's own settings, as opposed to this app's. `/api/prefs` is
`~/.tgxcode/settings.json`, a format this app defines; this is
`~/.claude/settings.json` and its project siblings, a format it does not.

```
{
  files: [{
    file,       string   absolute
    scope,      string   "user" | "project" | "project-local" | "managed"
    target,     bool     whether a PUT with that scope and this cwd writes this file
    readonly,   bool     true only for "managed"
    exists,     bool
    parsed,     bool     false → `values` is {} and a `patch` write is refused
    writable,   bool     the file, or the nearest directory that would be created
    symlink,    bool     true → every write here is refused
    size,       int      bytes
    stamp,      string or null   opaque; echo it on a write, never parse it
    text,       string or null   the file verbatim, or null when absent or over the cap
    values,     object   {dottedPath: value} — this file alone, unfiltered
    problems,   [string]
    ignored,    bool     project-local only, from `check-ignore`; absent on other rows
    ignoredBy   string or null   "<file>:<line>" of the rule that matched
  }],
  effective:   {dottedPath: {value, scope, file} | {value, merged: true, from: […]}},
  unknown:     [{path, kind, type, preview, scope, file}],
  hooks:       [{scope, file, event, matcher, index, type, command, target, timeout, script}],
  statusLine:  {value, scope, file, ours, command} or null,
  installedPlugins: [string],
  catalogue:   [{title, key, note, rows: […]}],
  hookEvents:  [{name, matcher, values?, blurb}],
  hookTypes:   [{type, required, label}],
  toolNames:   [string],
  catalogueAgainst: string,
  scopes:      [string],
  running:     int,
  problems:    [{file, message}]
}
```

The chain is **four rows for three writable scopes**, weakest first: `user`,
`project`, `project-local`, then `managed` —
`/etc/claude-code/managed-settings.json`, which overrides all three and which no
caller may write. It is reported even when it does not exist, which is almost
everywhere: a client that drew three rows would be wrong in exactly the case
where the answer matters.

`values` is keyed by **dotted path** and holds what that one file says, with
nothing filtered out. A path is a leaf when the catalogue models it — so `env`,
`enabledPlugins` and `hooks` arrive whole rather than exploded — and otherwise
when it is a scalar or an array; plain objects are walked to three levels.

**`effective` is this bridge's reading of Claude Code's precedence, not
something Claude Code told us.** The CLI cannot be asked what it concluded, so a
client that treats this as authoritative is trusting a guess. It is meant to be
*displayed* beside the files it came from.

**`permissions.allow`, `deny` and `ask` add up across files rather than
overriding.** Those three come back as `{value, merged: true, from}`, where
`value` is the union weakest-first with duplicates collapsed and `from` is
`[{scope, file, count, values}]` — one entry per file that contributes, carrying
that file's own entries. Every other path comes back as `{value, scope, file}`,
last-file-wins. A client that draws an "overridden, so this has no effect"
sentence over a `merged` path is telling the user a rule does nothing when it is
one of the rules actually in force.

`unknown` is every key in the files that the catalogue does not model, and it is
the field that keeps this route honest — Claude Code ships no schema anyone can
read, so the catalogue is hand-written and always behind. `kind` is `"scalar"`
when the value is a bool, number, string or null, and otherwise the JSON type
(`"array"`, `"object"`). A `scalar` may be written through `patch`; anything
else has to go through `text`. `preview` is one clipped line of JSON.
`catalogueAgainst` is the Claude Code version the catalogue was read against, so
"there is no control for that" and "this app is out of date" can be told apart.

`hooks` is a flattened summary of **every file's** `hooks` block, weakest file
first, one entry per hook. Claude Code runs the hooks of every scope — a project
hook does not replace a user one, both fire — so this is every hook in force,
not the strongest file's. (Until the hooks editor landed it *was* the strongest
file's alone, which under-reported exactly the case that matters.) Each entry:

| field | type | |
|---|---|---|
| `scope`, `file` | string | the file the hook is in |
| `event` | string | the key under `hooks`, e.g. `PreToolUse` |
| `matcher` | string or null | `null` means no matcher — every tool, or an event that takes none |
| `index` | `{group: int, hook: int}` | the hook's position in that file's `hooks[event]` — group, then hook within it |
| `type` | string or null | `command`, `http`, `prompt`, `agent`, `mcp_tool`, or whatever the file says |
| `command` | string or null | a `command` hook's command, `$HOME` folded back; `null` for every other type |
| `target` | string or null | what the hook does, whatever its type — the command, the URL, the prompt, or `server / tool` — whitespace collapsed, clipped to 200 characters |
| `timeout` | int or null | seconds, when the hook sets one |
| `script` | `{file, exists}` or null | when a path could be picked out of the command |

`script.exists: false` is the useful part: a hook whose script has been deleted
fails silently and nothing in Claude Code says so.

`hookEvents`, `hookTypes` and `toolNames` are the catalogue for the hooks
editor, and like the rest of the catalogue they are hints with no authority.
`hookEvents[].matcher` is what the event's matcher is matched against — `"tool"`
(a tool name or regex), `"values"` (one of `values`), `"free"` (a name nobody
can list), or `null` for an event that reads no matcher. `hookTypes[].required`
is the fields a hook of that type is refused without. An event or type not in
these lists is still accepted on a write.

`statusLine.ours` is true when the command names `quota-statusline.py`, i.e.
when `scripts/install-quota-statusline.js` is what put it there.

`installedPlugins` is every plugin id this machine has installed, from
`~/.claude/plugins/installed_plugins.json`, so a client can offer a checkbox for
a plugin the settings file has never mentioned.

`running` is how many sessions have a live process — scoped to `cwd` when one is
given, otherwise every session. It is there for one sentence: a change to these
files reaches the *next* session and not the ones already going.

**This call has a side effect: it starts watching the directory you named.**
From then on a change to that project's two files raises the `claude-config`
event on `/api/events`, so a client showing these settings need not poll. The
user and managed files are watched from startup regardless. It is dropped again
after ten minutes without another read of that directory, or sooner if reads of
other directories push it past the small cap the bridge keeps — so a long-lived
view should re-`GET` rather than assume the watch outlives it. See the
`claude-config` row in §*Server-sent events* for the caveats, of which the
important one is that the watch is best-effort and `409 {code: "stale"}` below
remains the actual guarantee.

### `PUT /api/claude-config`

`{scope, cwd?, stamp?, patch}` **or** `{scope, cwd?, stamp, text}` →
`200 {file, stamp, config}`. Exactly one of `patch` and `text`; sending both, or
neither, is `400 {code: "body"}`. **Local callers only**, and the client header
like every other write. `config` is the whole `GET` payload as it now stands, and
`stamp` is the written file's new stamp — which the *next* write has to send.

`scope` is `"user"`, `"project"` or `"project-local"`, and with `cwd` picks one
file:

| `scope` | file |
|---|---|
| `user` | `~/.claude/settings.json` — `cwd` ignored |
| `project` | `<cwd>/.claude/settings.json`, which git tracks |
| `project-local` | `<cwd>/.claude/settings.local.json` — check `ignored` on that row rather than assuming; on the machine this was written it is ignored by a **global** excludes file, which a clone elsewhere does not inherit |

`"managed"` is `403 {code: "readonly"}`.

Unlike `PUT /api/prefs`, `cwd` is the **workspace itself** and never falls back
to its main checkout: Claude Code reads the `.claude` of the directory it runs
in, so a worktree's own file is the one in force.

#### `patch` — one or more dotted paths

`{"permissions.defaultMode": "plan", "theme": null}`. Only the paths named are
touched, `null` removes a key so it falls back down the chain, and a section
left with no keys is removed rather than written out as `{}`. Existing key order
is preserved and a new key is appended, so a one-key change is one line of diff.

**`hooks` is written whole.** `patch: {hooks: {…}}` replaces the file's entire
`hooks` block and `patch: {hooks: null}` removes it; there is no dotted path into
it (`hooks.Stop` is refused as uncatalogued). Being an object, it always needs
the `stamp`. The block is checked for shape, not wisdom — a hook command is an
arbitrary shell string by design — and refused with `400 {code: "value"}` when:

- it is not an object, has more than 64 events, or an event name is not
  `^[A-Z][A-Za-z]{1,63}$`;
- an event's value is not a non-empty array of at most 64 groups;
- a group is not an object, has a `matcher` that is not a string (≤1024
  characters), or has no non-empty `hooks` array (≤64);
- a hook has no string `type`, or lacks the field its type requires as a
  non-empty string (≤16384 characters): `command` for `command`, `url` for
  `http`, `prompt` for `prompt` and `agent`, `server` and `tool` for `mcp_tool`;
- an optional field is present with the wrong type: `timeout` an integer 1–86400;
  `async`, `asyncRewake`, `once` booleans; `statusMessage`, `if`, `shell`,
  `model` non-empty strings; `args`, `allowedEnvVars` string arrays; `headers` an
  object of strings; `input` an object.

Any other field, any unrecognised `type` and any unrecognised event are kept
exactly as sent. The whole block is refused on the first problem, and the
message does not say which hook — a client that wants to point at the row
should check the same rules itself before sending.

A path is accepted when the catalogue models it, **or** when it already holds a
scalar somewhere in the chain and the new value is the same JSON type — which is
what lets a client edit a key this bridge has never heard of without being able
to turn `switchModelsOnFlag: false` into the string `"false"`. A path nothing in
the chain has is refused: the bridge will keep a key it does not understand, but
it will not invent one.

At most four segments. A segment of `__proto__`, `constructor` or `prototype` is
refused by name — this is a client-supplied path being assigned into an object,
so the refusal is explicit rather than a filter that would silently change which
key got written.

**`version` is never written.** `PUT /api/prefs` stamps its own document, which
is right for a format this app defines; doing it here would put a key Claude
Code does not define into the user's file.

#### `text` — the whole document

Replaces the file. Must parse and must be a JSON **object** — not an array, not
a scalar. Re-serialised to two spaces and a trailing newline, so a
hand-formatted file comes back formatted the way Claude Code writes one; keys
keep their order.

This is the only way to reach a key `patch` refuses, and **the only thing that
can repair a file that no longer parses** — which is why an unparseable target
refuses a `patch` and accepts a `text`. That is narrower than `PUT /api/prefs`,
which refuses both outright, and the difference is deliberate rather than a
typo: refusing here would leave the app declining to fix the one problem only it
can see.

#### `stamp` — the precondition, and when it is required

`stamp` is the opaque token from the `GET`. It exists because **this app is not
the only writer**: `claude` changes `theme`, `editorMode`, `effortLevel` and
`enabledPlugins` from inside a session, and appends to
`.claude/settings.local.json` every time somebody approves a permission
mid-turn.

| the write | `stamp` |
|---|---|
| one scalar path | not needed — the file is read immediately before it is written, so setting one key cannot revert another |
| a whole array or object, or removing a key that holds one | **required** — `permissions.allow` is one key holding twenty-eight rules, and writing the array a page loaded ten minutes ago would silently drop the rule approved since |
| `text` | **required** — it replaces keys the caller may never have looked at |
| a file that should not exist yet | send `stamp: null` |

Omitting it where it is required is `400 {code: "stamp"}`, which is a distinct
answer from sending a wrong one.

**Nothing is merged on conflict.** This bridge does not own the schema, so it
cannot merge safely — `hooks` is an array where order matters, and a naive union
produces a hook that fires twice per tool call. A conflict is refused and a
person looks at it.

#### Refusals

| Status | `code` | |
|---|---|---|
| 400 | `scope` | not one of the three writable scopes |
| 400 | `dir` | a project scope with no `cwd`, or one outside the allowed roots |
| 400 | `body` | both `patch` and `text`, or neither, or an empty patch |
| 400 | `path` | not catalogued and not an existing scalar; more than four segments; an empty or reserved segment; an uncatalogued path holding a collection |
| 400 | `value` | a value the catalogue refuses, or a type change on a generic scalar |
| 400 | `json` | `text` does not parse, or is not a JSON object. The message is the parser's |
| 400 | `stamp` | a whole-collection or whole-document write with no `stamp` |
| 403 | `readonly` | the `managed` scope, or a symlinked target |
| 403 | `unparseable` | the file does not parse **and** the write is a `patch` |
| 403 | `write` | the file or its directory could not be written |
| 409 | `stale` | `stamp` no longer matches. The body carries `stamp` and `text` — the file as it is now |
| 409 | `exists` | `stamp: null` but the file is there. The body carries `stamp` |
| 413 | `size` | larger than a settings file should be |

`409` is neither the caller's mistake nor a file it may not write, which is why
it is not folded into `400` or `403`: the request was well formed and would have
been accepted a moment earlier.

### `GET /api/claude-docs?cwd=<path>`

**Local callers only — the read as well as the write.** See §*Refused for remote
callers*.

Claude Code's `CLAUDE.md` files: the instructions a session is given before your
first message, as opposed to the settings that decide what it may do. This is
the only route in the bridge that reads or writes a whole file's *contents* —
`/api/fs` lists directories and `/api/fs/mkdir` creates one, and that is the
rest of the filesystem surface.

```
{
  docs: [{
    id,         string   "claude-md:<scope>" — stable, for a client's own keys
    kind,       string   "claude-md" — the only kind so far
    scope,      string   "user" | "project"
    file,       string   absolute
    exists,     bool
    writable,   bool     the file, or the nearest directory that would be created
    symlink,    bool     true → every write here is refused
    size,       int      bytes, not characters
    stamp,      string or null   opaque; echo it on a write, never parse it
    text,       string or null   the file verbatim, or null when absent or over the cap
    truncated   bool     true → the file is past the cap and `text` is null
  }],
  maxBytes:     int      the cap, in bytes, on both the read and the write
}
```

**Two scopes, and they are not a chain.** `user` is `~/.claude/CLAUDE.md` and
`project` is `<cwd>/CLAUDE.md`. Claude Code reads **both** and concatenates
them: neither overrides the other, there is no `effective` reading to compute,
and a client that draws an "overridden by … — this has no effect here" label
over either one — the shape `/api/prefs` and `/api/claude-config` really do
have — is telling the user a file does nothing when it is in force. Say that
both apply.

Note where the project file *is*: at the root of the workspace, **not** inside
`.claude/`. That is the one place this family does not mirror the settings files
on the route above, and it is also why the symlink check is against a different
containing directory per scope.

`cwd` is the **workspace itself** and never falls back to its main checkout:
Claude Code reads the `CLAUDE.md` of the directory it runs in, so a worktree's
own file is the one in force.

**A row is absent rather than empty when there is nothing to name.** With no
`cwd`, or a `cwd` outside `TGXCODE_ROOTS`, the answer is the `user` row
alone — not a `project` row pointing at a path no write would accept. So the
array is one or two entries and a client should find its scope in it rather than
index into it. This is deliberately *not* a `403`: a directory the bridge will
not read is no reason to refuse a perfectly good user file.

`truncated` is how a file too large to open is reported, and `text` is `null`
rather than clipped. A client must not offer an editor over a truncated row: it
would be seeded with nothing and a save would replace the whole file with it.
`size` and `stamp` are still filled in, so the row can say how big the file is
and why it is not open.

`maxBytes` is the same cap in both directions — a file that can be read here can
be written here. Label a byte counter with this rather than hardcoding a number
that later drifts.

### `PUT /api/claude-docs`

`{scope, cwd?, stamp, text}` → `200 {file, stamp, docs, maxBytes}`. **Local
callers only**, and the client header like every other write. `docs` and
`maxBytes` are the `GET` payload as it now stands, so a client can take the
answer wholesale rather than patching its own copy, and `stamp` is the written
file's new one — which the *next* write has to send.

| `scope` | file |
|---|---|
| `user` | `~/.claude/CLAUDE.md` — `cwd` ignored |
| `project` | `<cwd>/CLAUDE.md`, which git tracks |

`"project-local"` and `"managed"` are `400 {code: "scope"}`: those are scopes of
`/api/claude-config`, and there is no `CLAUDE.local.md` or administrator's
memory file here.

**`text` is written byte for byte.** No re-indenting, no trailing newline added,
no BOM stripped, no CRLF normalised. `PUT /api/claude-config` re-serialises its
document because it owns a format with a house style; this is somebody's prose,
and reformatting a file it was asked to save would corrupt a diff nobody asked
for. An empty string is a legitimate document — a file that says nothing is not
the same as no file — and there is no way to *delete* one through this route.

#### `stamp` — the precondition, and it is never optional

`stamp` is the opaque token from the `GET`. Sending none at all is
`400 {code: "stamp"}`.

That is stricter than `PUT /api/claude-config`, which lets a single scalar patch
do without one, and the difference is not an oversight. There is no partial
write here: every request replaces the whole document, which is exactly the case
that route *requires* a stamp for. And the window is much wider — a scalar patch
is a control being clicked, where a prose file is a draft by nature and the read
that filled the box was minutes ago.

Send `stamp: null` for a file that should not exist yet; absent and `null` mean
different things and both are meaningful.

| the write | `stamp` |
|---|---|
| any write to a file that exists | **required** — the one from the `GET` that filled the editor |
| creating a file | `null` |
| absent | refused |

**Nothing is merged on conflict**, and there is nothing sensible to merge:
`CLAUDE.md` is prose, so a union of two versions is not a document. A conflict
is refused and a person looks at it.

#### Refusals

| Status | `code` | |
|---|---|---|
| 400 | `scope` | not `"user"` or `"project"` |
| 400 | `dir` | a project scope with no `cwd`, or one outside the allowed roots |
| 400 | `body` | `text` is absent, not a string, or contains a **NUL byte** |
| 400 | `stamp` | no `stamp` was sent |
| 403 | `readonly` | the target is a symlink. Checked with `lstat` on the link, so it is never followed |
| 403 | `write` | the file or its directory could not be written |
| 409 | `stale` | `stamp` no longer matches. The body carries `stamp` and `text` — the file as it is now |
| 409 | `exists` | `stamp: null` but the file is there. The body carries `stamp` |
| 413 | `size` | over `maxBytes`. The boundary is inclusive: exactly the cap is accepted |

A NUL byte is `body` rather than a code of its own — it means something that is
not text arrived, most likely a file picked by mistake, and it groups with "that
is not a string". `claude` reads these files as UTF-8 and what it would make of
a NUL is undefined, so it is refused rather than written.

`409` is neither the caller's mistake nor a file it may not write, which is why
it is not folded into `400` or `403`: the request was well formed and would have
been accepted a moment earlier.

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
| `busy` | turns a restart would end: busy, and not in the session host. Turns in the host are not counted; they survive. | — |
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

`→ {pid, port, root, worktree, busy, atRisk, journal}`. **Local callers only.** `busy` and
`atRisk` are numbers with their `/api/health` meanings. `journal` is
up to the last 20 lines of `~/.cache/tgxcode/restart-<port>.log` as strings.

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

`{path}` → `{ok, path, file}`. Opens the file in whatever the host desktop opens that
kind of file with. Only the basename is taken from the caller; the directory is
recomputed, so `404` means "not one of this session's attachments" rather than
"missing". Local callers only.

`file` is the Linux path; `path` is the path as handed to the host's file manager,
with the same host-dependent shape as `POST /api/sessions/:id/open-file`.

### `POST /api/wispr/press`

`{id: string}` → `{ok: true, combo: string}`.

Presses a Wispr Flow transform's chord on the Windows desktop, into whichever window
has the focus. `id` names an entry in the user's `wispr.transforms` (see
§`GET /api/prefs`), and the chord is looked up there. **The route never takes a chord
from the request**, so a caller can press what the user set up and nothing else.

The press goes to the focused window, so a client does its own half first: focus the
message box, select the text Wispr should transform (all of it, if nothing is
selected), then call this. Wispr rewrites the selection itself. Nothing in the
response says it did — `ok` means the keystrokes were injected, not that Wispr
answered them. It takes about 0.6 s, most of it PowerShell starting.

| Status | When |
|---|---|
| `200` | pressed |
| `404` | no transform with that `id` in the user's settings |
| `409` | `{error, available: false}` — the bridge is not on the Windows host |
| `502` | PowerShell could not be run, timed out, or Windows injected fewer events than it was given. The last usually means the focused window is running as administrator and the bridge is not. |

**Local only.** A remote caller gets
`403 {"error": "keys can only be pressed on the machine they reach"}`.

### `POST /api/fs/open`

`{path: string, reveal?: boolean}` →
`{ok: true, how: "open" | "reveal", path: string, winPath: string | null, why?: "directory" | "executable"}`.

Opens a path on the host desktop: the file, in whatever the host opens that kind of
file with, or — with `reveal: true` — the folder holding it, in the file manager.
`path` is a Linux path on the machine the bridge runs on and a leading `~` means
`$HOME`, as everywhere else. `path` in the answer is the resolved Linux path, not the
one you sent. Local callers only.

Under WSL the opener is `explorer.exe`; on a Linux host it is `xdg-open`, and a
`reveal` of a *file* is handed to the `org.freedesktop.FileManager1` D-Bus interface
so the file is **selected** in its folder rather than the folder merely opened. If no
file manager implements that interface the folder is opened instead, which is what
WSL does in every case. Nothing in the response distinguishes those two outcomes.

Session-free on purpose: this is about the machine rather than a conversation, so a
client with nothing in focus can still open a path a transcript mentioned. Unlike
`POST /api/sessions/:id/attachments/open`, which recomputes the directory and can
therefore only reach files it put there, this route takes the path as given — which
is why the next two paragraphs exist.

**`how` is what happened, not what was asked for, and a client should read it.** Two
kinds of path are revealed even when you asked to open them, and come back
`how: "reveal"` with `why` naming which:

- `why: "directory"` — the path is a folder.
- `why: "executable"` — the extension is one a host would *run* rather than open:
  `.exe .com .bat .cmd .ps1 .psm1 .msi .msp .lnk .url .scr .pif .vbs .vbe .wsf .wsh
  .hta .reg .jar .cpl .msc .scf .appref-ms` (Windows) and `.desktop .appimage .run
  .bin` (a Linux desktop). That is a degrade rather than a refusal: the folder is the
  same information with none of the execution. Note what is deliberately **not** on
  that list — `.js`, `.ts`, `.py`, `.sh`, `.md` all open normally.

  **The list is one set, not a pair chosen by host.** Both halves apply on both
  hosts, so this field does not change meaning when the bridge moves — an entry that
  is inert on the running host costs one extra click, and a client can cache the list
  without asking what it is running on.

There is **no roots check**: unlike `GET /api/fs` and `POST /api/fs/mkdir`, this route
is not bounded by `TGXCODE_ROOTS`. Opening `/tmp/…` and `/mnt/c/…` is the
common case, and a fence at `$HOME` would refuse those while buying little — anything
a caller could be induced to open, it could have written inside `$HOME` first. The
route being local-only, and the launchable list above, are what carry the weight.

**`winPath` is host-dependent, and its name is older than the second host.** It is
the path as handed to the file manager:

| Host | `winPath` |
|---|---|
| WSL | the `\\wsl.localhost\…` or `C:\…` form `wslpath -w` produced |
| Linux | the resolved Linux path — the same string as `path` |

Under WSL it is the authoritative translation, and the `cs-host` meta tag exists only
so a client can *display* an approximation of it before asking. On a Linux host there
is no translation to be authoritative about, `cs-host` is not served at all, and a
client should render the path as it stands. It is `null` only when the opener was
never reached.

`400` for a missing `path`. `404` when nothing is at that path. `502` when the opener
could not be run — under WSL `wslpath` or `explorer.exe`, and on Linux `xdg-open`,
which unlike Explorer also reports a file type nothing is registered for.

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
| `GET/DELETE /api/sessions/:id/queue[/:qid]` | | inspect, drop one, clear. Dropping one answers `{ok, removed, status}`, or `409` if the message has already been sent — including a `handed` one the running turn read first. Clearing answers `{ok, dropped[]}` with only what was actually dropped, so a handed message that lost that race stays out of the list |
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
served, port}`, by shelling out to `tailscale`. It looks on `PATH` first and falls
back to `tailscale.exe` on the Windows host, so a real Linux Tailscale wins wherever
one exists and no client sees the difference. `served` is
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

A run record is `{id, workspace, commandId, label, command, cwd, port, http,
devbrowser, state, pid, startedAt, listeningAt, exitedAt, exit, stopped,
terminalId}` with `state ∈ starting | listening | running | stopping | exited`.
`http` (**bool**) is whether the port answers HTTP, so whether a browser preview
can show it. It is probed after the run reaches `listening`, a few times over about
six seconds because plenty of dev servers bind before their first compile answers,
so a run can be `listening` with `http: false` for a moment and then flip — watch
`run-changed` for it. Always `false` once the run has exited.
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

## Editing what a project declares

The files behind the section above, as an editor sees them. A different question
from `GET /api/commands` and a different audience, which is why it is a
different route rather than a mode of that one: this answers "what does each
file *say*", where that answers "what buttons does this directory have".

| Route | Body / query | Notes |
|---|---|---|
| `GET /api/commands-config?cwd=` | | the two files, unmerged; **local callers only** |
| `PUT /api/commands-config` | `{cwd, scope, stamp, commands[]}` | replace the array |
| `PUT /api/commands-config` | `{cwd, scope, stamp, text}` | replace the document |

**Both methods are refused to a remote caller, including the read** — which is
the opposite of `GET /api/commands` one section up, and the asymmetry is
deliberate. What a project *declares* is in its repository already and the
merged payload has never carried `env`; these files are where somebody keeps
`{"STRIPE_KEY": "sk_live_…"}`, in a file whose whole premise is that it is
private. The refusal is on the prefix with no method test, so anything added
under it later is refused by default rather than by being remembered.

`cwd` may be any directory in the project. **The project root is what gets
edited** — `projectRootOf()` is applied, and the answer's `project` is the path
actually written, which may not be the one you asked about. A worktree has its
own checked-in `commands.json` that takes precedence for a session running
there, so an edit here does not reach it until the branch picks the change up.
The local file is read from the project root for every worktree, and does.

### The file format

Not written down anywhere before this section, which is why it is here rather
than behind a pointer at `bridge/commands.js`.

```json
{ "version": 1, "commands": [{
    "id": "dev", "label": "Dev server", "run": "npm run dev -- --port=${port}",
    "cwd": "web", "env": {"DEBUG": "1"},
    "port": { "range": [5000, 5099], "env": "PORT" },
    "devbrowser": "${worktree}", "disabled": false
}]}
```

`version` must be exactly `1`; anything else and the file contributes nothing.

| Field | Type | | |
|---|---|---|---|
| `id` | string | **required, always** | `^[a-z0-9][a-z0-9._-]{0,31}$` |
| `label` | string | required on a first definition | 1–40 chars, no control characters |
| `run` | string | required on a first definition | ≤ 2000 chars, no NUL |
| `cwd` | string | optional | **relative**, and may not resolve outside the workspace |
| `env` | `{NAME: string}` | optional | ≤ 32 keys, each `^[A-Z_][A-Z0-9_]*$`, values strings |
| `port` | `{range: [lo, hi], env?: string}` | optional | integers 1024–65535, `lo ≤ hi`, span ≤ 1000 |
| `devbrowser` | string | optional | empty falls back to worktree, then branch, then project |
| `disabled` | boolean | optional | declared, but no button |

Keys not in that table are **kept as written**, by both the reader and the
editor. The reader ignores them; the editor round-trips them rather than
dropping a field somebody added by hand.

**Five placeholders, and a sixth is an error rather than an empty string:**
`${port}`, `${cwd}`, `${project}`, `${worktree}`, `${branch}`. They are expanded
in `run`, `cwd`, `devbrowser` and every `env` value. `${port}` additionally
requires the command to declare a range — **checked against the *merged*
command**, so a `run` in the shared file may use it while the local file
supplies the range.

At most 24 commands per file, and 64KB per file.

**Two files, merged by `id`.** `commands.json` is checked in;
`commands.local.json` is yours and should be excluded from the repository — the
bridge checks and reports when it is not. A local entry whose id the shared file
already declares is an **override** and supplies only what it changes; anything
else is a first definition and needs `label` and `run`. Merging is shallow per
key, except `env`, which merges key by key — so there is no way to *remove* an
inherited variable, only to give it a different value — and `port`, which
replaces wholesale.

### What the read answers

```
{ project, projectName, context, merged[], problems[], files[], limits, placeholders[], patterns }
```

- `context` is `{cwd, project, worktree, branch, port}` — what `${…}` expands to
  at the project root. `port` is always `null` here.
- `files[]` is one row per scope, weakest first, each
  `{scope, file, exists, parsed, stamp, size, writable, symlink, ignored,
  ignoredBy, commands[], text, problem}`. `scope` is `project` or
  `project-local`, the same two words `/api/prefs` uses.
  **`commands[]` is verbatim** — the entries exactly as the file has them,
  unvalidated and including keys this app does not model. That is the point: a
  client that seeded an editor from `merged` instead would write the merged
  answer back, and adding one local override would copy every shared command
  into a private file.
  `exists && !parsed` means the file is there and unreadable; `text` still
  carries the bytes so an editor can repair it, and `problem` is
  `{file, message}` with the parser's own sentence.
  `ignored` is `true`/`false` on the local row and `null` on the shared one, and
  `ignoredBy` names the matching rule as `<file>:<line>`.
- `merged[]` is the two files folded together and validated, each carrying
  `from` — the file that last set it. For showing inherited values, not for
  seeding an editor.
- `problems[]` is `{file?, id?, field?, message, informational?}`.
- `limits` is `{maxCommands, maxFileBytes, maxRunChars, maxEnvKeys,
  maxLabelChars}` and `patterns` is `{id, envKey}` as regular-expression source
  strings. They ride along so a form can label its counters and refuse a bad id
  without a second copy of the bridge's constants going stale.

### What a write has to send

Exactly one of `commands` (an array, replacing that file's own entries) or
`text` (the whole document, and the only thing that can repair one which no
longer parses). `version` is **not** in the body: the writer stamps it, because
a client that could send `version: 7` is a client that can write a file this
bridge then refuses to read. A structured write is serialised with two-space
indent and a trailing newline; a `text` write is stored byte for byte.

**`stamp` is required and `undefined` is a refusal**, unlike
`PUT /api/claude-config` where a single scalar patch may omit it. Every write
here replaces the whole array, so there is no write a read immediately
beforehand could make safe. `null` means "this file should not exist yet", which
is how a page that has never seen one asks to create it — so absent and null
must stay distinguishable in the JSON.

**The write is refused whole.** One bad entry and nothing is written, including
the good entries and including the file itself when it was being created. The
refusal reports *every* problem rather than the first.

| `code` | Status | |
|---|---|---|
| `scope` | 400 | not `project` or `project-local` |
| `dir` | 400 | missing, or outside the allowed roots |
| `body` | 400 | not exactly one of `commands`/`text`; wrong type |
| `stamp` | 400 | the precondition was left out |
| `invalid` | 400 | the document would not load; `problems[]` |
| `json` | 400 | `text` that does not parse, or is not an object |
| `version` | 400 | `text` whose `version` is not 1 |
| `stale` | 409 | changed since it was read; `stamp`, `text`, `commands` |
| `exists` | 409 | `stamp: null` against a file that now exists; `stamp` |
| `size` | 413 | over 64KB serialised |
| `readonly` | 403 | a symlink, or a `.tgxcode` that is one |
| `write` | 403 | not writable, or `.tgxcode` is a regular file |

An `invalid` refusal carries `problems: [{index, id?, field?, message}]`.
`index` is the position in the array you sent, and it is the row key rather than
`id`: an entry with a malformed id has no usable one, and a duplicate id names
two rows.

A success answers `{file, stamp, config}`, where `config` is the same shape the
GET returns — so a client can take the answer wholesale instead of patching its
own copy.

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

**The write surface 403s without `X-TGXCode-Client: 1`.** Reads work, writes
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

**A bridge restart does not end a turn.** When `/api/health` reports a `sessionHost`,
every `claude` this bridge started runs in that host, and a restart hands it on rather
than killing it. A client reconnecting after the bridge went away will find:

- **The same session still `busy`, or `idle` with its turn finished.** A turn that
  ended while no bridge was up is reported with a `turn-complete` event as the new
  bridge starts, before any client can be connected to hear it. So a client that
  wants to know about it reads `lastResult` from the runner status rather than
  waiting for the event.
- **An approval card on a session nobody has looked at yet.** An ask raised while the
  bridge was down comes back as `pendingPermission` on the runner status and is
  answered on the usual route. It is not auto-denied for want of a window, because
  none has had time to reconnect; it waits, like any card left open.
- **Messages queued before the restart are still queued**, with new ids. Queue ids
  (`q…`) are not stable across a restart, so never keep one from before it.
- **Idle sessions keep their process.** An idle session can still be running a
  background command or subagent, so the bridge does not stop it on the way down.

A turn is still lost when there is no host (`sessionHost: null`), or when the host
itself is killed. The runner then reports `error`, and the next send starts a fresh
process with `--resume` as it always did. `atRisk` in `/api/health` counts exactly the
turns a restart would end.

**A `200` from `/api/fs/open` means Windows was handed the path, not that a window
appeared.** `explorer.exe` reports exit code 1 even when it works perfectly, so its
status says nothing and only a spawn failure is treated as an error. A file type with
no registered handler comes back `ok` and Windows shows its own *how do you want to
open this* dialog — which is the right outcome to report as success. Read `how`
rather than `ok` to find out what the user will actually see.

**`keyboard.bindings` is one key, and `PUT` replaces it whole.** A patch is per
key, and this key's value happens to be a map — so sending
`{"keyboard": {"bindings": {"view.live": "Alt+L"}}}` leaves that as the *only*
binding, not as one added to the rest. Send the whole map. Inside it, `null`
already means "unbound on purpose", which is why there is no per-entry spelling
for "back to the default": leave the id out instead. See §`PUT /api/prefs`.

**`files=1` has two `project-local` rows, and neither is necessarily the one you
would write.** The precedence chain is four files and the settings scopes are
three, because the main checkout's local file and the workspace's own are both
"project-local". Read `target` to find the file a `PUT` with a given `scope` and
`cwd` lands in; deriving it from the scope alone picks the wrong one from a
worktree. See §`GET /api/prefs`.

**A save into a file something stronger overrides changes nothing in force.**
`PUT /api/prefs` answers `200` with the settings that now hold, and they can be
identical to the ones before it — the write happened, and a project-local file
is still winning. Take `prefs` and `files` from the response rather than
assuming your value is now the answer.

**A saved Claude Code setting reaches the next session, not the ones running.**
Claude Code reads those files when a session starts. `PUT /api/claude-config`
returning `200` means the file was written, and a turn already in flight goes on
using what it read at startup — so a client that says "saved" and nothing else
has told the user something they will read as "in effect". `running` on
`GET /api/claude-config` is there to be said out loud. See §`GET /api/claude-config`.

**A `409` from `/api/claude-config` is not an error to retry.** It means the file
changed since the `stamp` you were given — most often because `claude` itself
appended a permission somebody approved mid-turn. The body carries the current
`stamp` and `text`; the fix is to show what is there now and let a person decide,
never to re-send with the fresh stamp, which would do the clobber the
precondition just prevented. There is no merge, deliberately: this bridge does
not own the schema, and `hooks` is an array where order matters. See
§`PUT /api/claude-config`.

**The `claude-config` event is a convenience; the `409` is the contract.** The
bridge watches these files and broadcasts when one moves underneath it, so a
view left open can repaint instead of finding out on its next save. But
`fs.watch` throws on some filesystems and silently does nothing on others, and a
project is only watched after it has been read — so a client that treats a
missing event as proof nothing changed will eventually clobber a permission rule.
Send the `stamp` and handle the `409`; the event only makes meeting it rare. See
the `claude-config` row in §*Server-sent events*.

**`permissions.allow` is a union, not an override.** Three paths — `allow`, `deny`
and `ask` — add up across every file in the chain, so the reflex borrowed from
`/api/prefs` ("the strongest file that mentions a key wins") produces two wrong
behaviours at once: an "overridden, so this has no effect" label over a rule that
is in force, and — worse — a client that seeds an editor from `effective.value`
and writes it back, which copies every inherited rule into whichever file it is
writing. That is not hypothetical; it is what the first version of this app's own
page did. Edit `files[].values` for the scope you are writing, not `effective`.
Look for `merged: true`. See §`GET /api/claude-config`.

**The two `CLAUDE.md` files both apply, and neither wins.** `/api/claude-docs`
returns two rows and they look exactly like the scope rows on the routes above,
which are a precedence chain. These are not. Claude Code reads the user file and
the project file and concatenates them, so the reflex — draw the tabs, label the
weaker one "overridden" — reports that a file has no effect when every line in
it is in force. There is no `effective` field on that route for the same reason:
there is nothing to compute. See §`GET /api/claude-docs`.

**A `CLAUDE.md` edit does not reach a session that is already running — ever.**
This is worse than the settings case above, not merely the same. Claude Code
reads these files at startup and puts them *in the context*, so a running
session is not waiting to notice the change; it is holding the old text and will
hold it until it ends. "Saved" therefore means "the next session you start", and
a client that says only "saved" has told the user something they will read as
"in effect". See §`GET /api/claude-docs`.

**A truncated row has no text, and must not get an editor.** A `CLAUDE.md` past
`maxBytes` comes back with `truncated: true` and `text: null` rather than the
first 256KB — unlike `GET /api/sessions/:id/output`, which does clip, because
that feeds a viewer. Seed a text box from a truncated row and the box is empty;
save it and the file is empty. `size` and `stamp` are still there so the row can
explain itself. See §`GET /api/claude-docs`.

**A restart has no completion event.** The process that would send one is the process
being replaced. After a `200` from `POST /api/restart`, poll `GET /api/health` until
`pid` differs from the one the `200` returned — allow 45s, since the script waits 30s
for the replacement to answer. A `pid` that never changes does not mean it is still
working: it means the script decided not to restart, and `GET /api/restart` carries the
journal line saying why. See §`POST /api/restart`.
