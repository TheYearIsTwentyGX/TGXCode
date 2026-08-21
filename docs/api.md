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
`POST /api/sessions/:id/reveal`; `POST /api/sessions/:id/handoff`; `POST /api/fs/mkdir`.

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

The suggestions themselves arrive as `suggestion` events in `events`, but a client
drawing them as a list should read `GET /api/suggestions?session=<id>` instead —
same fields, and it does not depend on how much of the transcript was asked for.

`offset` is a **byte position in the transcript file**, not an event count. Hold it;
it is what resumes the live tail.

`?tail=N` returns only the last N events and adds
`truncated: { dropped, total }`. Mobile clients should use it — a 60-turn session is
~1,800 events and half a megabyte of JSON, and none of the first 1,500 is why
someone opened their phone.

Event kinds, all with `id`, `kind`, `ts`:

| kind | Carries |
|---|---|
| `user` | `text`, `images[]`, `files[]`, `command`, `origin` (`human` or an agent) |
| `assistant` | `text` (markdown), `model` |
| `thinking` | `text` |
| `tool` | `name`, `input{}`, `status` (`ok`/`error`/absent while running), `result{text,stdout,stderr,patch,filePath,interrupted}`, `agent`, `persistedPath`, `durationMs` |
| `system` | `subtype`, `isError`, `text` |
| `agent-done` | `taskId`, `toolUseId`, `status`, `summary` |
| `suggestion` | `prompt`, `why`, `title`, `cwd` — follow-up work an agent offered rather than did |
| `peer-message` | `from` (socket address), `fromName` (the peer's name, which is its address), `text` |
| `handoff` | `from` (the sending session's id), `fromTitle`, `fromProject`, `title`, `text` — work another session handed this one, which is what woke it |
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

`spinner`: `randomize` (whether a turn in progress wears a themed verb in front
of what it is doing, or says only what it is doing as before), `groups` (which
groups from `~/.tgxcode/verbs/` are in play, named by their `Category` — at most
200), `rerollMs` (how long a verb stands before the next is drawn; `0` pins one
for the whole turn, else 1000–600000). The verbs themselves are not here — they
are a directory, and `GET /api/spinner/groups` lists it.

### `GET /api/spinner/groups?cwd=<path>`

`{ randomize, rerollMs, enabled: [...], pool, groups: [...], problems: [...] }` —
which spinner verb groups exist and which are in force.

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
waiting, running }`, already ordered needs-you-first. A card carries `reason`
(`ask`/`error`/`here`/`elsewhere`/`pinned`/`recent`), `title`, `projectName`, `worktree`,
`runner`, `live`, `ask`, `headlines[]`, `tasks{done,total,current}`, `devservers`.

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

## The live channel

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
| `sessions-changed` | `{at}` — a nudge to refetch the list |
| `peer-message` | `{at, sessionId, from, count}` — another session messaged this one. The message itself is in the transcript, so a client tailing it has already drawn it; this is for everything that is not the open pane |
| `handoff` | `{at, sessionId, from, count}` — another session handed this one work, and it was resumed to deal with it. Same shape and same reasoning as above; watched in the transcript rather than reported by the route, so it fires when the message *arrived* rather than when it was queued |
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

`runner-status`: `{sessionId, state, activity, verb, detail, model, permissionMode,
cwd, error, errorKind, queued, queue[], pendingPermission, canPrompt, busySince}`
where `state` is `stopped`/`starting`/`idle`/`busy`/`error`.

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

`{cwd, prompt, model?, permissionMode?, test?}` → `{sessionId, status, test}`.

`cwd` must be inside the allowed roots. `test: true` keeps it out of the everyday
window — use it for anything exploratory. `plan` is the sensible default mode for a
first message.

### `POST /api/sessions/:id/send`

`{text, attachments?, model?, permissionMode?, fork?}` →
`{ok, id, cwd, fork, status, queued}`.

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
| `POST /api/sessions/:id/stop` | `{hard?}` | `{ok, how, dropped[]}` |
| `GET/DELETE /api/sessions/:id/queue[/:qid]` | | inspect, drop one, clear |
| `POST /api/sessions/:id/queue/reorder` | `{ids}` | |
| `POST /api/sessions/:id/flags` | `{pinned?, archived?, test?}` | |
| `GET /api/sessions/:id/suggestions` | | `{sessionId, suggestions}` — the decisions alone. `GET /api/suggestions?session=` is the offers *and* the decisions |
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
