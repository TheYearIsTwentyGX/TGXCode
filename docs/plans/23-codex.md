# 23 — Running Codex sessions beside Claude ones

**Effort:** XL, in six phases · **Depends on:** 01, 05, 08, 20 ·
**Touches:** `bridge/runner.js`, `bridge/transcript.js`, `bridge/sessions.js`,
`bridge/turn-index.js`, `bridge/changes.js`, `bridge/usage.js`, `bridge/mcp.js`,
`bridge/routes/session.js`, `web/transcript/*`, `web/composer/*`,
`web/new-session/dialog.js`, `web/index.html`, `docs/api.md`, new
`bridge/codex/*`, new `test/codex-*.test.js`

> Roadmap. Phases 0–3 are done: the JSON-RPC client is in `bridge/codex/`, the
> schema in `docs/codex-schema/0.172.0/`, the recordings in
> `test/fixtures/codex/`, the runtime seam in `bridge/runtimes/`, Codex sessions
> are listed and read through `bridge/runtimes/codex/transcript.js`, and they are
> started and driven through `bridge/runtimes/codex/process.js`. Phase 4's
> conversation features (fork, branch, checklist, subagents, the skill palette) and
> its quota and version are built, as are the MCP server, dev-server attribution,
> drafts, schedules and workers. Search, spend, images and archived threads read Codex
> too; see *Reading beside the transcript* under Phase 4, and the rest of Phase 4 for
> what is left of it. Phase 5's config surfaces are built; see under Phase 5.

## Why

Everything TGXCode does is built around one agent CLI, Claude Code. The rail, the
approval cards, the boards, scheduling, the PR gate and the handoff tools are
not really about Claude, though: they are about *a coding agent that runs in a
directory and needs a human now and then*. OpenAI's Codex CLI is that too. The
goal is to start a Codex session from the same dialog, watch it in the same
transcript view, answer its approvals from the same cards, and schedule it
from the same schedule rows. Where Codex cannot do something, the UI should not
pretend it can.

The roadmap is based on `openai/codex` at `rust-v0.160.1` (2026-10-05) and on
how `pingdotgg/t3code` drives Codex today. Most of the claims it builds on were
then checked against a live 0.160.1 on a ChatGPT Free account, by driving
`codex app-server` directly; *Measured on 0.160.1* near the end records what
that showed. Phase 0 installed 0.172.0 (2026-11-26, twelve minors on) and
measured again, recording each scenario as a replay fixture; *Measured on
0.172.0* records what changed. Where a measurement contradicted the research,
the measurement wins and the section has been changed to match.

## What Codex offers a client like this one

Codex has three ways in, and only one is the right one:

- **`codex exec --json`** prints JSONL events for one headless run
  (`thread.started`, `item.*`, `turn.completed`). It has **no approval channel
  and no interrupt** — it is what `@openai/codex-sdk` wraps for CI. It is
  useful for one-shot text jobs, nothing interactive.
- **`codex mcp-server`** was deleted on 2026-09-05 (#42993). Do not build on it.
- **`codex app-server`** is JSON-RPC 2.0 over stdio (`--listen stdio://`, the
  default). It is what the VS Code extension and Codex Desktop use, and what
  t3code uses. It is the one we want, and it maps onto what `runner.js` does
  with stream-json nearly one to one.

The handshake is `initialize {clientInfo, capabilities:{experimentalApi:true}}`
followed by an `initialized` notification. A request sent before that is
refused with "Not initialized", and a second `initialize` is refused with
-32600 "Already initialized". Leave out `experimentalApi` and every method or
field marked experimental is rejected — which includes `requestUserInput`,
`collaborationMode/list` and `thread/fork.beforeTurnId`.

**The stability problem is real and has to shape the design.** The CLI labels
`app-server` *[experimental]*, and the docs say it is "not supported for
production workloads". In the last two months alone:

- `thread/rollback` was replaced by `thread/revert {beforeTurnId}`, which only
  works on threads with `historyMode: "paginated"`.
- `update_plan` became opt-in (`tools.update_plan.enabled`).
- `mcp-server` was removed.
- t3code had to loosen `PlanType` to a plain string because 0.159 added a plan
  slug (`promax`) and broke decoding of `account/read`.

So the policy is:

- **Pin a tested Codex version** and say which one in `bridge/codex/README`.
  Show a banner when the installed one is outside the range.
- **Vendor the generated schema as a reference.** Commit the output of
  `codex app-server generate-json-schema` under `docs/codex-schema/<version>/`
  so the next upgrade is a diff. It is documentation, not a dependency — see the
  last section of `CLAUDE.md`.
- **Tolerate what we do not know.** An unknown item type renders as a generic
  tool row, and an unknown notification is logged once and dropped. Neither
  should throw.

## Decisions

### D1 — A `runtime` on every session, and two seams

Every session gets `runtime: "claude" | "codex"`. Claude Code behaviour moves
behind two adapters rather than being branched on throughout:

- **The process adapter.** `runner.js` keeps everything that is ours: the queue,
  `inFlight`, the stall timer, `MAX_LIVE` eviction, notes and adoption. It
  delegates to an adapter for the parts that are Claude's: argv, how a user turn
  is written, how stdout is parsed into busy/idle/tool/permission, and the
  control verbs (`interrupt`, `set_permission_mode`, `cancel_async_message`).
  The Codex adapter, under `bridge/codex/`, speaks JSON-RPC in the same places.
- **The transcript adapter.** Today `transcript.js` (`scanMeta`, `buildEvents`)
  reads Claude's `.jsonl`. A Codex reader turns rollout files into the **same
  event kinds** — `user`, `assistant`, `thinking`, `tool`, `tool-result`,
  `system`, `compact`, `agent-done` — so `web/` renders them unchanged where the
  meaning matches.

`bridge/host.js` needs no change. It relays bytes, so it carries a `codex
app-server` exactly as it carries `claude`. That is the payoff of keeping it
boring.

### D2 — Content still comes from the transcript

The invariant in `docs/api.md` holds for Codex: **content comes from the
rollout file, and liveness comes from the process.** Codex writes
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`. Each
line is `{timestamp, type, payload}`, and `type` is one of `session_meta`,
`response_item`, `event_msg`, `turn_context`, `compacted` and a few newer ones.

The alternative was to ask the app-server for history (`thread/read`,
`thread/turns/list`), as t3code does — though t3code goes further and keeps its
own event store. That was rejected for three reasons:

- A file can be read with no Codex process running, which is how the sidebar
  lists 300 sessions without starting 300 processes.
- The index in `sessions.js` is already built on watching files, and it stays
  that way.
- The rollout format has churned more slowly than the RPC surface.

Measured, this holds up better than expected:

- **The file is live.** Each line lands within about 50 ms of the matching
  notification, and a tool call is on disk *before* `item/started` reaches the
  client. A content-from-file view lags the stream by less than a frame.
- **One mapper serves both sources.** Next to the raw Responses API lines
  (`response_item`), the rollout records `event_msg` `item_completed` with the
  same v2 `ThreadItem` the app-server streams. The type names are PascalCase
  there (`CommandExecution`) and camelCase on the wire (`commandExecution`), and
  on 0.172.0 the *fields* differ the same way: `aggregated_output`, `exit_code`,
  `parsed_cmd` and a `cwd` written as a `file://` URL on disk, against
  `aggregatedOutput`, `exitCode`, `commandActions` and a plain path on the wire.
  So the transcript reader and the runner's liveness parser can share one table
  of item kinds, with a key translation in front of it.
- **`item_completed` is the only usable record of a tool on 0.172.0.** Codex
  now runs the model in *code mode*: it has one `exec` tool taking JavaScript
  (`await tools.exec_command({cmd, workdir})`), so the `response_item` lines are
  `custom_tool_call` carrying a script and `custom_tool_call_output` carrying
  its printout. The `exec_command_end` and `patch_apply_end` events that 0.160.1
  wrote are gone. A command, a patch and its unified diff are on disk only as
  `item_completed` `CommandExecution` / `FileChange`.
- **A fork does not copy its parent.** The child rollout opens with a
  `session_meta` carrying `forked_from_id` and `history_base {thread_id,
  end_ordinal_exclusive, end_byte_offset}`, and then holds only the child's own
  lines. The reader has to read the parent's rollout up to `end_byte_offset`
  first, and a parent that is deleted or compressed breaks the child's history.
- **The noise needs filtering.** Each turn opens with `developer` messages
  (skills, multi-agent role) and a user-role `<environment_context>` message.
  These are the Codex equivalents of `<system-reminder>`, and the reader must
  strip them the same way.
- **`thread/start` returns the file's path** as `thread.path`, but the file
  does not exist until the first turn (or a `thread/name/set`, which creates it
  too). `index.note(id)` already handles a session that has an id and no file
  yet.

Two details:

- **Cold rollouts may be compressed** to `.jsonl.zst`. Node has
  `zlib.zstdDecompressSync` from v22.15 (this machine now has v24.21), so this
  needs a version check and no dependency. On 0.172.0 compression is the
  `local_thread_store_compression` feature, *under development* and off by
  default, or an explicit `rollout/compress` (experimental). No probe produced
  one.
- **Titles live elsewhere**, in `session_index.jsonl` (append-only, last entry
  wins, lines `{id, thread_name, updated_at}`; measured on 0.172.0 through
  `thread/name/set`). Archived threads live in `archived_sessions/`. The
  sqlite files beside them are projections of the rollouts, not records (see
  *Still open* 3).

### D3 — One app-server per conversation

t3code runs one app-server and puts many threads on it. We run one per
conversation, the same as one `claude` per conversation today. That way:

- `MAX_LIVE` eviction keeps its meaning.
- Host release and adoption work per session.
- A crash takes down one conversation rather than all of them.

The cost is a few more processes. If that cost turns out to matter, a shared
server is a contained change inside `bridge/codex/`, and the rest of the bridge
never sees it.

### D4 — Capabilities, not runtime checks, in `web/`

`/api/sessions/:id` (and the six-field `runner` summary on `/api/sessions`)
gains `runtime` and `capabilities {fork, branchFromTurn, planMode, askUser,
peers, tasks, scratchpad, slashCommands, …}`. `web/` hides a control when its
capability is false and never asks which runtime it is looking at. The phone
client gets the same object through `docs/api.md`, which must say so in the
same commit that adds it.

### D5 — Permission modes stay ours

The mode chip keeps our six names. The Codex adapter maps each one onto Codex's
three settings, `approvalPolicy`, `sandbox` and `approvalsReviewer`:

| Ours | approvalPolicy | sandbox | reviewer | Notes |
|---|---|---|---|---|
| `manual` | `untrusted` | `read-only` | `user` | Asks before anything but known-safe reads |
| `acceptEdits` | `on-request` | `workspace-write` | `user` | Edits in the workspace run; escalations ask |
| `auto` | `on-request` | `workspace-write` | `auto_review` | A reviewer subagent answers approvals instead of us |
| `plan` | `on-request` | `read-only` | `user` | Plus `collaborationMode: {mode:"plan", settings:{model}}`. `settings.model` is required; take it from the `thread/start` response, which has `model` beside `thread`. Plan mode forces the read-only profile whatever is sent. |
| `dontAsk` | `never` | `workspace-write` | `user` | Never asks; anything outside the sandbox fails back to the model. Measured: a write outside the workspace got "Read-only file system" and no prompt. `/tmp` stays writable unless `excludeSlashTmp`. |
| `bypassPermissions` | `never` | `danger-full-access` | `user` | |

All three settings are sent on **every `turn/start`**, not only at thread start.
t3code found that leaving them out on a later turn left the previous turn's
reviewer in force. That also makes mode switching *easier* than it is for
Claude: there is no `set_permission_mode` control request and no restart, just
different values on the next turn. While a turn is running, a mode change only
takes effect on the next one, so the UI should say so.

## Phases

### Phase 0 — Spike, pin, fixtures

- Install Codex, pin it, and log in with a ChatGPT account.
- Generate the schema with `codex app-server generate-json-schema --out` and
  commit it under `docs/codex-schema/`.
- Record real app-server sessions as replay fixtures under
  `test/fixtures/codex/`, covering a plain turn, a command approval, a
  file-change approval, an interrupt, a fork, a `requestUserInput` and a plan
  turn. Keep the rollout files they produce beside them.
- Add a `TGXCODE_CODEX_BIN` stub that replays fixtures, the way the `runner`
  test drives a stub `claude` through `TGXCODE_CLAUDE_BIN`.
- Settle what *Still open* lists at the end of this document; *Measured on 0.160.1* records what has already been answered.

**Exit check:** fixtures exist for each event kind Phase 2 maps, and each still-open
question has an answer written down here.

### Phase 1 — The seam, with no Codex in it

- Extract the Claude process adapter out of `runner.js` and the Claude
  transcript reader out of `transcript.js`.
- Add `runtime` and `capabilities` to the session payloads, with Claude
  reporting everything true.
- Document both fields in `docs/api.md`.
- Convert the hard-coded tool-name tables (`changes.js` `EDIT_TOOLS`,
  `turn-index.js` `REVIEWABLE`, `describeTool`) into adapter-supplied tables.

**Exit check:** `npm test` passes **unchanged**, especially `runner` and
`host`. This phase is a refactor, and a test that had to be edited is a
behaviour change in disguise.

### Phase 2 — Read-only Codex

- `sessions.js` indexes `$CODEX_HOME/sessions` beside `~/.claude/projects`. It
  also reads `session_meta.cwd` to place a session in its project group, and
  `session_index.jsonl` for its title.
- The Codex reader maps rollout lines to events:

  | Rollout | Event |
  |---|---|
  | `response_item` message, role user / assistant | `user` / `assistant` |
  | `response_item` reasoning (summary text) | `thinking` |
  | `event_msg` `item_completed` `CommandExecution` | `tool` (Bash-like) + `tool-result` with `aggregated_output` and `exit_code` (0.160.1 also wrote `exec_command_end`; 0.172.0 does not) |
  | `event_msg` `item_completed` `FileChange` | an edit `tool` carrying each change's unified `diff` (0.160.1's `patch_apply_end` is gone) |
  | `response_item` `custom_tool_call` `exec` | nothing: it is the code-mode script the two rows above came out of |
  | MCP tool call, web search | `tool` |
  | `compacted` | `compact` |
  | `turn_aborted` | interrupted marker |
  | `event_msg` `plan_update` | checklist (see Phase 4: 0.172.0 no longer writes it) |

- `web/transcript/tools.js` learns to render a command row and a patch row.
- `changes.js` takes line counts from patch diffs instead of `structuredPatch`.
- `turn-index.js` takes turn boundaries from `turn_context` lines.

**Exit check:** a Codex session started in a terminal shows up in the rail and
reads correctly, with no Codex process started by the bridge.

**As built.** What the build settled that the list above did not:

- **Codex is a read-only runtime, not a second entry in `RUNTIMES`.** The
  registry has two tables: what a session can be run on, and what can only be
  read. `get('codex')` throws, so nothing that starts a process can be handed
  one, and `capabilitiesOf`, `toolsOf` and `readerFor` answer for both. Phase 3
  moves Codex across.
- **Two new flags, `send` and `delete`, false for Codex.** No existing flag
  covered "can take a message at all", and a rollout is Codex's store to delete,
  not ours. Claude's object does not carry them yet (`test/runtimes.test.js`
  pins its eleven), which the contract already reads as true. Every summary now
  carries `runtime` and `capabilities`, because a Codex session never has a
  runner to carry them. The write routes refuse `409 {capability}`, and
  `pool.ensure` refuses too, as a backstop.
- **Messages from `response_item`, tools from `item_completed`.** As the table
  says, with two exceptions found in the fixtures: the blocking question is a
  `function_call` (`request_user_input`) whose answer is its
  `function_call_output`, and an async question exists only as an
  `agentMessage` item. A plan turn's last message repeats the plan in
  `<proposed_plan>`, which is stripped, since the `plan` item is drawn.
- **A fork's history is cut by ordinal, not by byte offset.** The offset is only
  true of the file Codex wrote; the scrubbed fixtures moved their bytes and kept
  their ordinals. `end_byte_offset` is used only when lines carry no ordinal.
- **A steered message is a turn mark** at the offset of the turn it joined, as a
  folded message is for Claude.
- Not done here, and harmless: search, spend, images and skill runs read a Codex
  rollout with Claude's parsers and find nothing in it. `archived_sessions/` is
  not indexed. (All but skill runs have since been done; see *Reading beside the
  transcript* under Phase 4.)

### Phase 3 — Driving Codex

These are the `runner.js` behaviours, one by one, mapped onto the app-server.
Phase 1's process contract (the header of `bridge/runtimes/claude/process.js`)
held for most of them. `bridge/codex/README` §Fit lists the seven places it did
not: the handshake has to gate the queue, Codex mints the new session's id,
there is no unsolicited `init`, turns are requests, a refused steer has to be
queued again, and approvals and questions have answers richer than allow/deny.
**The contract has since been widened for all seven** (`handshakeGates` and
`handshake(o)`, `init.minted`, `init` built in `read`, adapter-owned request
ids, the `returned` lifecycle state, `decisions` with `choice`, and question
answers as a list), with `test/runtime-contract.test.js` driving a fake runtime
through each. What is left of them is in the README: the create route still
answers with the placeholder id, and the cards still draw allow and deny.

| Ours | Codex |
|---|---|
| New session (`--session-id`) | `thread/start {cwd, model, config, historyMode:"paginated"}`. **The thread id comes back in the response**, so `index.note(id)` moves to after the reply. Today we mint the id ourselves, so this changes the order. |
| Resume (`--resume`) | `thread/resume {threadId}`, with the same `config` overrides |
| Send a turn | `turn/start {threadId, input[], approvalPolicy, sandboxPolicy, model, effort, collaborationMode}` |
| Hand a message to the running turn (`_handOver`) | `turn/steer {threadId, expectedTurnId, input}`, answered `{turnId}`. Measured: steering during a running command folded the message into the **same** turn at the next tool boundary, which is Claude's semantics exactly. The steered message is only written to the rollout when it is folded in, so the existing "queued" chip covers the gap between the steer and its line on disk. On 0.172.0 that gap is milliseconds: code mode's `exec` yields while the command runs on, so a boundary comes almost at once. **A steer that loses the race with the end of the turn is refused** -32600 "no active turn to steer", and the runner must then send it as a `turn/start`, not drop it. |
| Drop a queued message | Our own queue holds it until `turn/completed`. There is no `cancel_async_message` to send. |
| Stop | `turn/interrupt {threadId, turnId}`, then SIGTERM/SIGKILL after `CONTROL_TIMEOUT_MS`, as now. Measured: the running command was killed at once, and the turn ended `interrupted`, recorded as `turn_aborted {reason:"interrupted"}`. |
| Busy / idle and the activity label | `turn/started`, `turn/completed`, `item/started`, `item/completed`, `thread/status/changed` (`active{waitingOnApproval}`) |
| `can_use_tool` approval card | `item/commandExecution/requestApproval` (shows the command and cwd) and `item/fileChange/requestApproval` (the diff comes from the `fileChange` item). Each answer is a `{decision}`. **A command request carries `availableDecisions`, and the card draws its buttons from that list rather than from a fixed set.** Measured under `untrusted`, the list was `accept`, `{acceptWithExecpolicyAmendment: [prefix]}`, `cancel`: no `decline` and no `acceptForSession`. The amendment is a *persistent* "always allow this command prefix" rule, which is stronger than Claude's session-scoped "allow always", so its button must say so. `cancel` also interrupts the turn. A file-change request carries no list. It was declined with `decline`, which became `status: "declined"` on the item. |
| A card withdrawn (`control_cancel_request`) | `serverRequest/resolved {threadId, requestId}`. Measured on 0.172.0, it is also sent after a request *we* answered, so it means "no longer pending", not "withdrawn": withdraw a card only if it was still unanswered. Server-request ids are integers from 0 per connection. |
| AskUserQuestion card | **Two mechanisms, and the model picks which one.** The *blocking* tool, `request_user_input`, sends `item/tool/requestUserInput {questions[{id, header, question, options, isOther, isSecret}]}`, which is answered with `{answers:{<id>:{answers:[…]}}}`. It is on by default but offered only in plan mode, unless the `default_mode_request_user_input` feature also enables it in default mode. Measured on 0.172.0: asked for by name in plan mode, it arrived with `isBlocking: true`; asked for by name in default mode, the model used the async tool instead; with `config: {"features.default_mode_request_user_input": true}` on `thread/start` it arrived in default mode, with `isBlocking: false` (`autoResolutionMs` is deprecated in its favour). The *async* tool, `request_user_input_async`, is offered when the model's metadata lists it, and on 0.160.1 it was the one used in both probes, in default and in plan mode. It produces no server request at all: an `agentMessage` arrives with `delivery: "async"` and `questions[{title, options[]}]`, and the turn carries on and ends. The card is drawn from that item, and choosing an option sends it as the next turn. So the card must handle both, and only the blocking one maps onto today's AskUserQuestion flow. And a third case needs no card at all but does need the composer: asked to "ask me and wait" with no tool named, 0.172.0 once asked in plain text and ended the turn, and once asked in plain text and then called its `sleep` tool for 43,200,000 ms. The second leaves a turn busy for twelve hours waiting on a reply, which only arrives if the composer sends it as a `turn/steer`, which the hand-over path above already does. |
| Extra permissions | `item/permissions/requestApproval` gets a third card type, with a turn or session scope |
| Model and effort pickers | `model/list`, which returns per model `supportedReasoningEfforts` and `defaultReasoningEffort`. `web/index.html` stops hard-coding the list for Codex sessions. **Never hard-code a Codex model.** The default depends on the account and moves between versions: signed out it was `gpt-6.1-sol` on 0.160.1 and `gpt-6.2-sol` on 0.172.0, and on a ChatGPT Free account it was `gpt-6-luna` on both. A turn naming a model the account cannot use fails late, with an `error` notification and `turn/completed {status:"failed"}` ("model is not supported when using Codex with a ChatGPT account"), not at `turn/start`. |
| Images | `{type:"localImage", path}`, using the files `attachments.js` already stages. No base64 inlining. |
| `classifyError` | JSON-RPC error codes and `error` notifications instead of matching stderr text. An archived thread on resume gets `thread/unarchive` and one retry, as t3code does. |

**Pending approvals across a bridge restart.** t3code loses pending approvals
when its process restarts. We should not, because the host keeps the Codex
process alive. A pending server request is a JSON-RPC id that Codex is still
waiting on, so the note a releasing bridge writes (`_saveNote`) records the id
and the request. The adopting bridge redraws the card and answers that id.
This is the same pattern `pendingPermission` uses today, and the `host` test
gets a Codex case.

**Plan mode is shaped differently.** In Codex, a plan turn ends with a `plan`
item and nothing to approve: there is no `ExitPlanMode` request to allow or
deny. So the plan card's buttons become actions:

- **Approve** sends the next turn with `collaborationMode: default` and
  "Implement the plan".
- **Revise** sends the feedback as another plan turn.

The card looks the same and the mechanism is ours.

**Exit check:** the `runner` test's three assertions — nothing left in flight,
the next message delivered, the stopped turn not delivered again — pass against
the Codex stub, and an approval survives `npm run dev` being restarted.

**Done.** What was built, and where it went its own way:

- `test/codex-runner.test.js` drives a real Runner against every recording through
  `test/fixtures/codex/walker.js` (stub.js's walk, plus plain.ndjson's turn for any
  `turn/start` past the end, so the three assertions can follow every scenario), and
  `test/codex-host.test.js` restarts a pool with an approval pending.
- **The note carries the pending ask whole** (`pending` in `_saveNote`), with Codex's
  integer id as `rpcId`. The replay still finds it when the host's log has it; the
  note is for when the log's 8 MiB cap dropped the request, which a chatty Codex turn
  makes likelier than a Claude one.
- **The plan card and the async question card are `followUp` asks**: the runner holds
  them without blocking, never auto-denies them, takes them down when you type past
  them, and answers them by sending the next turn (`Runner#_answerFollowUp`). That is
  the "mechanism is ours" above, kept in the runner rather than `web/`, so the phone
  gets it through the same `POST …/permission`.
- **The handshake reads `account/read` before opening the thread**, so signed out is
  a `codex-signed-out` failure that hands the message back, not thirteen seconds of
  retries ending in a failed turn.
- `collaborationMode` is sent only in plan mode and on the first turn after it
  (`mode: "default"`). Sending it every turn would replace the thread's developer
  instructions — our agent brief — with the mode's built-in ones.
- Two runner hooks beyond #261's widening, both optional: `notify` in the adapter's
  constructor (a line nobody waits on — `initialized`), and `adopting(o)` (what an
  adopted process's adapter would have learned at its start: thread id, mode, model).
- Not done here, and Phase 4's: drafts and schedules carry no `runtime`, so the
  Start dialog offers the runtime picker to Start alone; an orchestrator cannot run
  on Codex (its role is keyed by an id the create route mints before Codex does).
  Phase 4 has since given drafts and schedules a `runtime`, let workers run on
  Codex, and let orchestrators run on it too; see its *Done in part* and *As built —
  orchestrators on Codex*.

### Phase 4 — The features around the conversation

- **Fork.** `thread/fork {threadId}`. The new id is in the response, alongside
  `forkedFromId`, and it drives the existing `session-forked` broadcast. Pass
  `excludeTurns: true`: without it, 0.160.1 sends a `deprecationNotice` saying
  full-history hydration is deprecated for paginated threads. (With it, 0.172.0
  sent none.) The child's rollout points into the parent's rather than copying
  it; see D2.
- **Branch from a turn.**
  - Fork with `lastTurnId`, which is inclusive, to keep everything up to that
    turn.
  - Use `beforeTurnId` (experimental) to drop that turn.
  - Both need paginated history. Measured on 0.160.1, every new thread is
    paginated, both from `app-server` and from a terminal `codex exec`. Only
    threads left by older Codex versions report `branchFromTurn: false`.
  - Neither undoes file changes, which matches what branch does today.
- **The tgxcode MCP server.**
  - Inject it through the `config` map on `thread/start` and `thread/resume`:
    `{"mcp_servers.tgxcode": {"command": node, "args": [mcp.js, "--port", P, "--session", id]}}`.
    `mcp.js` itself does not change.
  - Replace `--allowedTools mcp__tgxcode__*` with
    `default_tools_approval_mode = "approve"` on that server. The type is
    `AppToolApproval` (`auto | prompt | writes | approve`) in
    `codex-rs/config/src/mcp_types.rs`, and `approve` is the identity in its
    `restrict_to`, so it is the least restrictive of the four. Measured: both the
    dotted key and the nested form are accepted in `config`. A bad value is
    refused at `thread/start` with -32600 naming the key, and the server's
    startup is reported per thread through `mcpServer/startupStatus/updated`.
  - `parseSuggestion` matches an MCP tool-call item with `{server: "tgxcode",
    tool: "suggest_session"}` instead of the `mcp__…__suggest_session` name.
- **Checklist and boards.**
  - Turn on `tools.update_plan.enabled` in the thread `config`.
  - Read `turn/plan/updated {plan[{step, status}]}` live and `plan_update` from
    the rollout.
  - `pending | inProgress | completed` maps onto `TodoWrite`'s three statuses,
    so `checklist.js` and the taskboard need only an adapter.
- **Subagents.** `collabAgentToolCall` and `subAgentActivity` items, and child
  threads carrying `parentThreadId`, map to the existing subagent rows.
- **Usage and quota.**
  - `account/rateLimits/read` on start, then `account/rateLimits/updated` pushed
    after that. A snapshot has `primary` and `secondary` windows of
    `{usedPercent, windowDurationMins, resetsAt}`, plus `planType` and
    `credits`.
  - This is far simpler than Claude's beacon and status line: no `script(1)`,
    and no writing to anyone's settings.
  - `thread/tokenUsage/updated` gives context-window use, which Claude sessions
    do not show today.
  - `web/quota.js` gets a second meter keyed by runtime. **Draw it from
    `windowDurationMins`; do not assume Claude's five-hour and weekly shape.**
    Measured on a Free plan, there was a single `primary` window of 43200
    minutes (30 days) and `secondary: null`. Other plans have other windows.
- **Version.** `codex --version`, compared against npm `@openai/codex`
  dist-tags. This is the same shape as `claude-version.js`, minus `claude
  update`: Codex installs vary (npm, brew, a release tarball), so tell the user
  how to update rather than doing it.

  *Built* (quota, context use, version, and Phase 5's sign-in notice): see
  `bridge/codex/quota.js` and `version.js`. The meter is `runtimes.codex` on
  `GET /api/quota`. Its reads come from a short-lived app-server and a live
  conversation only adds its pushes, so the adapter's handshake did not change.
- **Slash palette.** There is no `init.slash_commands` equivalent. Build the
  palette from `skills/list {cwds}`, whose entries have name, description and
  scope. A chosen skill is sent as a `{type:"skill"}` input rather than as a
  `/name` text marker, so the transcript reader recognises skill inputs where
  it now recognises `<command-name>`.
- **Scheduling and the PR gate.**
  - Schedule rows gain `runtime`.
  - A scheduled Codex run reads its `VERDICT:` from the last `agentMessage`.
  - The gate's prompts are Claude skills (`/adversarial-reviewer`), so a Codex
    gate needs the same skill under `~/.codex/skills`, or it uses Codex's
    native `review/start {target: {type: "baseBranch", branch}}`. The native
    path is worth trying first.
- **Dev-server attribution.** `devservers.js` finds a server's session through
  `CLAUDE_CODE_SESSION_ID` in the process environment. For Codex, set our own
  `TGXCODE_SESSION_ID` through `shell_environment_policy.set` in the thread
  `config`. Today we *strip* that variable for Claude, so the reader has to
  accept it only for Codex sessions.

**As built — fork, branch, checklist, subagents, skills.** Measured on 0.172.0
and recorded as `branch`, `plan-update`, `skill` and `subagent` in
`test/fixtures/codex/`; `test/codex-features.test.js` pins each. Where the list
above was wrong:

- **There is no `plan_update` line any more.** Code mode puts `update_plan` inside
  an `exec` script, so the rollout's only record of the checklist is JavaScript
  (`await tools.update_plan({plan:[…]})`), and `turn/plan/updated` exists only on
  the wire. `bridge/codex/plan.js` reads literals, and names bound to literals
  earlier in the script — a live turn bound six lists to `const`s and passed each by
  name. Anything else is skipped. The wire's copy drives the activity line ("Think of
  an animal (2 of 3)").
- **A spawned agent shares its parent's app-server.** Its `turn/started` and
  `turn/completed` arrive on the parent's connection under the child's `threadId`,
  and before this an agent's `turn/completed` ended the parent's turn. The adapter
  now reads a thread named by a `subAgentActivity` as a child: background work
  (`task`, `agent-done`), never a turn. On 0.172.0 a spawn writes a
  `SubAgentActivity` item, not a `collabAgentToolCall` `spawnAgent`; its prompt is
  encrypted, so the row is named for its task.
- **A child's rollout copies its parent's history inline**, unlike a fork's
  (`subagent_history_start_ordinal` says where its own lines start), and carries
  `parent_thread_id`. The index files it under the parent as a subagent and never
  lists it.
- **Branching needs no context to key.** A person's message is keyed by its own
  `msg_<uuid>` (prefix dropped) and carries its turn id as `parent`;
  `user_input_order` 0 marks the conversation's first input, counted across a fork's
  inherited history. The branch is `thread/fork {beforeTurnId: parent}`.
- **`$name` at the start of a message runs a skill even without a skill input**, and
  Codex injects a `<skill>` harness message after it. A palette sends both the input
  and the `$name args` text; the reader reads either as `command {name, args}`.

**Done in part** (the MCP server, dev-server attribution, drafts and schedules,
workers, the PR gate measured) — what was built and what it found:

- **The MCP server is in the thread `config`** (`threadConfig` in
  `bridge/runtimes/codex/process.js`): `mcp_servers.tgxcode` and, with
  `preview.agentControl`, `mcp_servers.preview`, both `approve`, as dotted keys so the
  user's own servers stay. **One thing the plan assumed did not hold: there is no id to
  give a new thread's server.** Codex mints the thread id in the same `thread/start`
  that starts the server, and a thread with no rollout cannot be `thread/resume`d to
  pass it again ("no rollout found", measured). What Codex does send is the thread id on
  every tool call, as `_meta.threadId` (with `x-codex-turn-metadata.thread_id` beside
  it). So `bridge/mcp.js` *did* change, by one opt-in flag: `--session-from-call` takes
  the id from there. Without the flag a Claude session behaves as before. The
  alternative, an alias table in the bridge from placeholder to minted id, would have
  had to survive host adoption and cover every route mcp.js reaches.
- **Codex gives an MCP server a bare environment** — nothing of the bridge's arrived
  in a probe server — so `XDG_DATA_HOME` and `XDG_CACHE_HOME` go in the server's `env`,
  or a test bridge's mcp.js reads the everyday token and is refused.
- **Dev-server attribution needed less than planned.** Codex sets `CODEX_THREAD_ID` on
  every command itself (measured), which is the only id a brand-new thread's commands
  can carry; `devservers.js` reads it below `TGXCODE_SESSION_ID` and above
  `CLAUDE_CODE_SESSION_ID`. `TGXCODE_SESSION_ID` goes through
  `shell_environment_policy.set` on a resume, where the id is ours to give, and
  `codexEnv` now strips an inherited `CLAUDE_CODE_SESSION_ID`.
- **Suggestion cards and handoff.** `bridge/mcp-calls.js` reads a Claude
  `mcp__…__suggest_session` block and a Codex `{server: "tgxcode", tool}` item alike;
  the rollout reader makes the card in the view and the task in the index from it. The
  desktop draws an `mcp_tool_call` row under its `mcp__<server>__<tool>` name, so
  `message_session` and the orchestrator tools read as they do for Claude.
- **Drafts and schedules carry `runtime`**, and the dialog offers the Agent picker for
  both (not for a template, which still has no such field). A draft's Start, a
  schedule's run and a worker's spawn wait for the minted id (`bridge/minted.js`, the
  create route's wait moved out of it). A scheduled Codex run's `VERDICT:` comes from
  the turn's last `agentMessage`, which is what the adapter already made the turn's
  result text.
- **Workers can run on Codex.** A task from a Codex draft
  spawns a Codex worker, re-keyed to the minted id on the pool's `minted` (in the same
  tick, so the status and the turn that follow find it); its model is the task's or
  Codex's default, never a Claude one. (Orchestrators on Codex, and `spawn_worker`'s
  `runtime`, came after; see *As built — orchestrators on Codex*.)

**As built — orchestrators on Codex.** Marking an *existing* Codex session an
orchestrator already nearly worked: `PUT …/orchestrator` had no runtime check, the
recycle resumed the thread with `--role orchestrator` and its real id, and `ensure` took
the runtime from the index, so nudges reached it. What did not work was narrower than
"orchestrators are Claude-only", and each part was fixed where it was:

- **A new one is re-keyed like a worker.** The create route marks it under the
  placeholder, as its role decides its first start, and `Orchestrators#rekeyOrchestrator`
  moves the record on `minted`. The placeholder goes in `_removed`, so another bridge's
  merge cannot write it back. The route already waited on the mint, so it answers with
  the real id. The brief names the session id only once it is real; nothing needed it
  said, since mcp.js learns it per call.
- **Its own model is the composer's.** `orchestratorModel` and `orchestratorEffort` are
  Claude aliases, and `ownModel` forced them onto the Codex process. A Codex turn on a
  model the account cannot use fails at its *end*. They now apply to a Claude
  orchestrator only, and the page says so instead of drawing the Claude picker.
- **`spawn_worker` takes `runtime`**, defaulting to the orchestrator's own; a task's is
  the user's and wins. A Codex worker's model is checked against `model/list` (cached),
  and Settings' worker-model policy, which names Claude's models, does not apply to it.
  For a Codex orchestrator the tool's `model` has no Claude enum, or every Codex id would
  be refused before the bridge could check it.
- **The cutoff watches the account being spent.** `windowsFor(o)` gives Claude's windows
  while the orchestrator or an open worker runs on Claude, and Codex's (`codex:primary`,
  `codex:secondary`) while any runs on Codex. Neither account can pause what does not
  spend it: a Free account at 95% of its 30-day window used to be able to pause nothing,
  and must not start pausing all-Claude orchestrations. Codex's windows are the plan's
  lengths, so they share one threshold, `usageStop.codexPercent` (default 90). The quota's
  `changed` event checks the cutoff, and auto-resume waits for the Codex window's
  `resetsAt` like a Claude one.
- **`move_session` works** (measured; see the table below). `resumeFinds` asks for the
  thread's rollout instead of a transcript under `~/.claude/projects`. The brief's line
  about being stranded by a `cd` is Claude's alone: a Codex thread's cwd does not follow
  a command's `workdir`.
- **`tools/list` has no thread id**, so the spawn_worker description's policy line could
  not be read by id on a brand-new thread. A new orchestrator's server gets
  `--provisional <placeholder>`, and `GET …/orchestrator` answers for that placeholder for
  ten minutes after the re-key. It is memory only, and for that one read: every call still
  waits for its own `_meta.threadId`.
- **The envelopes.** The Codex reader now reads a nudge, an orchestrator's message and a
  handoff as their own events, not as the person's words. That was also wrong for every
  Codex worker since #266.

`test/codex-orchestrator.test.js` pins each part, including the cutoff in both directions.

**The PR gate's `review/start` was tried, and it is not wired in.** Measured on
0.172.0 against a scratch repo: `review/start {threadId, target: {type: "baseBranch",
branch: "main"}}` answers at once with a turn, then `enteredReviewMode`, a userMessage
Codex writes itself ("Review the code changes against the base branch 'main'. The merge
base commit … Run `git diff <merge-base>`…"), the commands it ran, `exitedReviewMode
{review}` and an `agentMessage` with the same text, ending `completed` in about 12 s.
The review is prose with findings tagged by priority (`- [P1] Restore addition in
`add` — <path>:2-2`) and **no verdict line**. Three things stand between that and the
gate, none of them large but all of them the gate's design rather than this slice's:

1. `baseBranch` reviews the *checkout's* HEAD against the merge base. The gate runs a
   PR's review in the schedule's `cwd` and lets the prompt fetch the PR; the native
   review would need the PR head checked out first, in a worktree as
   `bridge/pr-reviews.js` already makes for its own button.
2. It is a different request from `turn/start`, so the process contract would need a
   queue entry that is a review rather than a message.
3. Its verdict would have to be read from the priorities (`P0`/`P1` → BLOCK, `P2` →
   CONCERNS, none → CLEAN) instead of `verdictOf`.

Until then a Codex gate is a `runtime: "codex"` schedule whose prompt is written out
rather than a Claude skill's name, and it ends on a `VERDICT:` line like any other.

**Reading beside the transcript.** What Phase 2 left reading a rollout with
Claude's parsers, closed later; `test/codex-gaps.test.js` pins it, with `images`
recorded for it. Measured on 0.172.0:

- **Search** reads a rollout one line at a time through the Codex reader, so a hit's
  turn is the rail's turn. Results carry `agent`, which labels the reply.
- **Spend is tokens only.** `token_usage_record` has one `usage` per response and
  names its thread, which is what makes it countable: `token_count`'s running total is
  inherited by a fork, and a spawned agent's rollout copies its parent's lines. There
  are no Codex prices and a ChatGPT plan is not billed per token, so the board has a
  Codex card beside Claude's figures rather than tokens added into them.
- **Images** are `input_image` blocks. A tool's picture is on the code-mode script's
  `custom_tool_call_output`, and the call that made it is the `item_completed` written
  between the two. An attached file is wrapped in `<image name=… path=…>` text blocks,
  which the transcript had been showing as the person's words.
- **Archived threads** move, flat, to `$CODEX_HOME/archived_sessions/`. They are listed
  as `archived`; restoring one here is remembered in `flags.json` and writes nothing to
  Codex's store.
- Still not done: skill runs (`bridge/skill-runs.js`) find nothing in a rollout, and a
  fork's search and image indexes hold its own lines, not the inherited ones. A
  `.jsonl.zst` is read by all four, whole.

### Phase 5 — Config surfaces

- **A Codex tab in Settings.** Read it through `config/read` and write it
  through `config/value/write`. Going through the app-server means we never
  parse or write TOML ourselves, which keeps `bridge/` dependency-free.
  `claude-schema.js`'s hand-written catalogue gets a smaller Codex sibling for
  the keys worth a control: `model`, `model_reasoning_effort`, `approval_policy`,
  `sandbox_mode`, `web_search` and `[features]`.
- **Memory editor.** Show `AGENTS.md` (global `~/.codex/AGENTS.md` and per
  project) beside `CLAUDE.md` in `web/settings/memory.js`, through
  `claude-docs.js` generalised to a list of files.
- **Hooks.** `hooks/list` replaces reading `hooks` blocks out of
  `settings.json`, and `hook/completed` failures replace `stop_hook_summary`.
- **Auth.** `account/read` shows whether Codex is signed in, and which plan.
  Key the banner on `account === null`: `requiresOpenaiAuth` is `true` signed in
  too (measured on 0.172.0), because it says what the provider needs, not what
  is missing. Check before starting a turn, since a signed-out turn spends about
  13 seconds in ten retries before it fails. If it is not, show what to run in
  the terminal pane, `codex login` (`codex login --device-auth` where no browser
  opens). Driving
  `account/login/start` from the UI is possible but is not parity work.

**As built** (Phase 5's settings, memory and hooks; sign-in shipped with Phase 4's
quota). Measured on 0.172.0 with a scratch `CODEX_HOME`:

- **Only the user's `config.toml` can be written.** `config/value/write` refuses any
  other file ("Only writes to the user config are allowed"), so a project's
  `.codex/config.toml` is read and reported, never edited. A write keeps comments and
  layout, and `value: null` removes the key. A bad value is refused with
  `config_write_error_code: configValidationError`, **but any name under `[features]`
  is accepted**, which is why `bridge/codex-schema.js` is a closed set, unlike
  `claude-schema.js`.
- **`approval_policy` and `sandbox_mode` do not govern TGXCode's sessions**, which send
  their own on every turn (D5). The tab says so rather than leaving them out: they are
  what a terminal `codex` gets.
- **`hooks/list` is rich enough for a page**: command, matcher, source, file, and
  `trustStatus`. A new or changed hook is `untrusted` and does not run. The page is
  read-only and offers no trusting: that is `/hooks` in Codex.
- **A hook run is not in the rollout.** Only the context a hook added is. So
  "`hook/completed` failures replace `stop_hook_summary`" could not be done from the
  file as D2 wants: the failures heard live are kept by the bridge
  (`bridge/codex/hook-log.js`, `STATE_DIR/codex-hooks/<threadId>.jsonl`), placed by
  rollout byte offset, and merged into reads. A thread nothing was listening to has
  none. This is the one place a Codex transcript row does not come from Codex's file.
- **`AGENTS.override.md`** beside an `AGENTS.md` is read instead of it; the editor says
  so and does not edit the override.
- Not done: editing hooks, per-profile config, and project `config.toml` editing.

## Parity at a glance

✅ direct · 🟡 works, differently · ❌ not possible with Codex today

| Feature | | How, or why not |
|---|---|---|
| Warm process per conversation, queue, host adoption | ✅ | D3 |
| Transcript view | ✅ | Rollout reader, D2 |
| Tool approvals, allow for session | ✅ | `requestApproval` + `acceptForSession` |
| Approvals surviving a bridge restart | ✅ | Note records the JSON-RPC id (Phase 3) |
| AskUserQuestion | 🟡 | The blocking `requestUserInput` and the async `agentMessage.questions` both have to be handled. A client can get the blocking one in plan mode, or in default mode through an under-development feature flag; otherwise the model picks |
| Stop / interrupt | ✅ | `turn/interrupt` |
| Mid-turn message | ✅ | `turn/steer` |
| Model and effort | ✅ | `model/list`, which is better than our hard-coded list |
| Images | ✅ | `localImage` |
| Fork | ✅ | `thread/fork` |
| tgxcode MCP tools, suggestion cards, handoff | ✅ | `config.mcp_servers` |
| Quota | ✅ | `account/rateLimits/*`, which is simpler than Claude's |
| Scheduling, PR gate | ✅ | `runtime` on rows; `review/start` as an option |
| Orchestrators | ✅ | Re-keyed on mint like a worker; workers default to Codex; the cutoff watches Codex's windows; moved by `thread/resume {cwd}` |
| Worktrees | ✅ | Ours are plain git. A Codex session started in one just has that `cwd`. |
| Global search | ✅ | The rollout through the Codex reader. A fork is searched for its own lines |
| Images pane | ✅ | `input_image` in messages and tool outputs. A fork lists its own |
| Archived sessions | ✅ | `archived_sessions/`, shown as archived. Restoring here does not run `codex unarchive`; sending to it does |
| Spend and analytics | 🟡 | Tokens only, in a card of their own: no price table, and a ChatGPT plan is not billed per token |
| Skill-run history | ❌ | Not built: `skill-runs.js` reads Claude transcripts only |
| Plan mode | 🟡 | A `plan` item, not an approval. The buttons send the next turn. |
| Permission modes | 🟡 | Mapped per turn (D5), and measured |
| Branch from a turn | 🟡 | Paginated-history threads only, which is every thread from 0.160.1 |
| Checklist / boards | 🟡 | `update_plan`, opt-in. It has no `blocks` and no task ids, so the taskboard shows a flat list. |
| Slash commands | 🟡 | Skills only. Custom prompts were removed from Codex in March 2026. |
| Settings, memory, hooks, version | 🟡 | Through app-server RPCs, with no install-and-update button |
| Dev-server attribution | 🟡 | Our env var via `shell_environment_policy` |
| Rail status line (`standing.js`) | 🟡 | Keep calling Claude Haiku when `claude` is installed; otherwise fall back to the existing last-reply extraction. Spending a Codex turn on a summary is not worth it. |
| Peers, `SendMessage`, `@` mentions | ❌ | Codex has no `~/.claude/sessions` registry and no cross-session socket. Our own `message_session` handoff still works, which covers the common case. |
| `worktree-state`, `pr-link` transcript entries | ❌ | No equivalent. We infer them from `cwd` and `gh` instead. |
| Scratchpad | ❌ | Codex has no per-session temp directory convention |
| `ai-title` | 🟡 | `thread.name` when set; otherwise the first prompt (`preview`) |

## Risks

- **API churn.** This is the big one. Pinning, vendored schemas, fixture tests
  and tolerance of unknown shapes are the mitigation. Budget an upgrade pass for
  every Codex minor version.
- **The no-dependencies rule.** `@openai/codex-sdk` wraps `exec`, so it lacks
  approvals anyway, and t3code's generated client depends on Effect. Neither is
  usable here. The answer is a hand-written JSON-RPC client in `bridge/codex/`.
  It is a few hundred lines: newline-delimited JSON, an id → promise map, and a
  handler table for server requests.
- **Phone client.** `runtime`, `capabilities`, the new card types and the second
  quota meter are all wire surface. Each lands in `docs/api.md` with the phase
  that adds it, or `tgxcode-mobile` silently renders the wrong thing.
- **Experimental-only features.** `requestUserInput`, `beforeTurnId` and
  `collaborationMode/list` sit behind `experimentalApi`. If Codex stops
  accepting them, the capability flags must be able to turn off at runtime
  rather than at build time.
- **Two sources of truth for model names.** Claude's list stays hard-coded and
  Codex's comes from `model/list`. Do not try to unify them.
- **Auth and CSRF are unaffected.** Codex holds its own credentials in
  `$CODEX_HOME`, and nothing about the bridge token changes.

## Measured on 0.160.1

These were measured on 2026-10-06, by driving `codex app-server` over stdio
with a throwaway client, on a ChatGPT Free account and in scratch directories.
Each answer has already been folded into the section it affects. This is the
index.

| Question | Answer |
|---|---|
| Does `never` + `workspace-write` behave like `dontAsk`? | Yes. A write outside the workspace failed with "Read-only file system", with no prompt and no file. |
| Is `default_tools_approval_mode = "approve"` "never prompt"? Is the dotted key accepted? | Yes, and yes. The nested form is accepted too. A bad value is a -32600 at `thread/start`. |
| How promptly does the rollout flush? | Live, within about 50 ms of the stream. D2 holds without a stream fallback. |
| Legacy or paginated history from a terminal `codex`? | Paginated (`codex exec`, `history_mode: "paginated"`). |
| Does `turn/steer` fold at a tool boundary? | Yes, into the same turn. It is written to the rollout when folded, not when sent. |
| Do approvals look like the docs say? | Yes, plus `availableDecisions` per command request. See Phase 3. |
| Does plan mode end in something to approve? | No. It ends in a `plan` item carrying markdown, as Phase 3 assumes. |
| Does `requestUserInput` arrive? | Not in either probe. The model chose `request_user_input_async`, which arrives as an `agentMessage` carrying `questions`. See Phase 3. |
| Does the bridge's `originator` mark sessions it started? | Yes. `clientInfo.name` is stored as `originator` in `session_meta`. Terminal runs say `codex_exec`. |
| Does a signed-out Codex work at all? | `thread/start` works signed out. `account/read` returns `{account: null, requiresOpenaiAuth: true}`, and the banner keys on `account: null` — not on `requiresOpenaiAuth`, which 0.172.0 showed is `true` signed in as well. Turns fail with 401. |

## Measured on 0.172.0

Measured on 2026-11-26 in Phase 0, with `bridge/codex/client.js` itself rather
than a throwaway client, on the same ChatGPT Free account (signed out first,
against a scratch `CODEX_HOME`), in scratch directories under `/tmp`. Every
scenario is a fixture in `test/fixtures/codex/`, and `test/codex-rpc.test.js`
replays each one and asserts what it was recorded to show. The probe threads
were deleted from `~/.codex` afterwards. Answers are folded into the sections
they affect; this is the index.

| Question | Answer |
|---|---|
| What changed in the surface? | 189 client methods (110 without `experimentalApi`), 87 notifications, 10 server requests. New since 0.160.1 and worth knowing: `thread/queue/*`, `turn/settings/update`, `thread/settings/updated` (sent on every turn whose settings changed), `rollout/compress`, and `capabilities.optOutNotificationMethods` on `initialize`, which `client.js` uses to turn off voice, fuzzy-search and remote-control traffic. `codex app-server daemon` and `proxy` now exist, which is the shared-server option D3 left open. |
| Does the handshake still behave? | Yes. "Not initialized" and "Already initialized" are both -32600. The server omits `"jsonrpc"` on everything it writes, and puts `emittedAtMs` beside `params` on notifications. |
| Anything that breaks a naive client? | A notification is called `error`. Emitted as an EventEmitter event with no listener, that throws and takes the process down; it did, on the first signed-out recording. `rpc.js` dispatches notifications through its own table for that reason. |
| Is `requiresOpenaiAuth` the sign-in signal? | No. It is `true` signed in too. `account: null` is the signal. A signed-out turn makes five WebSocket and five HTTPS attempts, sends an `error` with `willRetry: true` for each, and ends `failed` with `codexErrorInfo.httpConnectionFailed.httpStatusCode: 401` after about 13.5 s. |
| Quota shape on Free? | Unchanged: one `primary` window of 43200 minutes, `secondary: null`. The snapshot gained `limitId: "codex"`, `ordinaryUsageAllowed`, `spendControlReached` and `individualLimit`. |
| Do approvals still look the same? | Command requests, yes: `availableDecisions` was `accept`, `{acceptWithExecpolicyAmendment}`, `cancel`, and `cancel` ended the turn `interrupted`. `item/started` for the command arrives just before the request, with `thread/status/changed` `waitingOnApproval`. Under `untrusted` even `cat -n notes.txt` asked. A file-change request still carries no list, and its item carries each change's unified `diff`, with a git-style `turn/diff/updated` beside it. `serverRequest/resolved` follows every request, answered or not. |
| Interrupt? | As on 0.160.1. `turn/completed {status:"interrupted"}` arrived 9 ms after `turn/interrupt`, the `sleep 60` was gone, and the rollout has `turn_aborted {reason:"interrupted"}`. |
| Steer? | Folds into the same turn, with the steered `userMessage` on disk within milliseconds, because code mode's `exec` yields while the command runs. A steer after the turn ended is -32600 "no active turn to steer". |
| What does a rollout hold now? | No `exec_command_end` or `patch_apply_end`; tools are `custom_tool_call` scripts plus `item_completed` items. New line types `world_state` and `token_usage_record`, and `response_item` kinds `additional_tools` and `configuration_update`. `session_meta.source` is `"vscode"` for app-server threads; `originator` is still `clientInfo.name`. Thread ids are UUIDv7. |
| Fork? | `thread/fork {excludeTurns: true}` returns the child with `forkedFromId` and the parent's `preview`, and sends no `deprecationNotice`. The child's rollout references the parent's by byte offset instead of copying it. |
| Plan turn? | Unchanged: a `plan` item carrying markdown, and nothing to approve. `collaborationMode.settings.model` is required. |
| Which question tool? | Both are in the tool list in both modes. Plan mode plus a request by name gave the blocking one (`isBlocking: true`). Default mode never did, even by name, until `features.default_mode_request_user_input` was set in the thread `config`, and then it came with `isBlocking: false`. Unprompted, the model asked in plain text. |
| Titles? | `thread/name/set` appends `{id, thread_name, updated_at}` to `session_index.jsonl`, and creates the rollout if no turn has yet. |
| Does `thread/resume {threadId, cwd}` move a thread? (2026-11-28) | Yes. A fresh app-server resumed a thread started in `D` with `cwd: D/moved`: the reply's `cwd` and `thread.cwd` were the new directory, `pwd` printed it, a file the turn wrote landed there and not in `D`, and the rollout's next `turn_context` named it. So a Codex orchestrator can be moved. |
| Does Codex send the thread id on MCP `tools/list`? (2026-11-28) | No. A probe server got `tools/list` with `_meta: {progressToken: 0}` and nothing else, once per process start; `tools/call` carries `threadId` and `x-codex-turn-metadata.thread_id`. So anything read at listing time has to be keyed by what the bridge knew at spawn. |

## Still open

1. **Do approvals survive host adoption?** **Yes, measured** on 2026-11-26 with
   0.172.0. A dev bridge was killed with a `touch two.txt` command approval
   pending (server-request id 1); the app-server stayed in the session host, the
   next bridge adopted it, redrew the card with the same id and decisions, and the
   `accept` answered after adoption ran the command in the same process, which
   finished the turn. `test/codex-host.test.js` pins the same, including the case
   where only the note still has the request.
2. **Can a still-loaded thread be compressed to `.jsonl.zst`?** Partly
   answered: on 0.172.0 compression is either the `local_thread_store_compression`
   feature (*under development*, off by default) or an explicit
   `rollout/compress`, so nothing compresses a rollout unless asked to. Whether a
   loaded one can be is still unmeasured, and it now matters more, because a
   fork's history lives in its parent's file at a byte offset.
3. **Is the rollout still the history of record?** Yes on 0.172.0.
   `thread_history_1.sqlite` has `thread_items` and `thread_turns`, but each row
   carries a `rollout_ordinal`, and `thread_history_projection_state` records a
   `next_rollout_byte_offset` per thread: the database is built from the rollout,
   not the other way round. Keep checking on every upgrade; if that table goes
   away, D2 moves to `thread/turns/list` and `thread/items/list`.
4. **What decides between the two question tools?** Answered (see *Measured on
   0.172.0*): plan mode gives the model the blocking one, and default mode gets
   it only through `features.default_mode_request_user_input`, which is *under
   development*. That leaves a smaller question: **what does `isBlocking: false`
   mean for a card?** It arrived as a normal server request and our immediate
   answer was used, so the turn did wait for it. Whether Codex gives up on an
   unanswered non-blocking request, and when, was not measured.
5. **Should Phase 1's adapter turn code mode off?** Code mode puts every
   command behind a JavaScript `exec` tool, which is why the rollout's
   `response_item` lines no longer say what ran. The `item_completed` lines do,
   so nothing needs it off, but if a future version stops writing them, the
   reader is left parsing JavaScript. `codex features list` shows `code_mode`
   *under development* and off, and `code_mode_host` *stable* and on, so it is
   probably the second, or the model's metadata; which one, and whether a
   thread `config` can turn it off, was not tried.
6. **Is `clientUserMessageId` echoed?** The adapter sends the runner's uuid on
   every `turn/start` and `turn/steer`, and the schema has `clientId` on the
   `userMessage` item. Whether Codex fills it in was not checked; nothing depends
   on it yet, and the transcript reader could use it to match a queued chip to its
   line.
7. **Does a `collaborationMode` replace the thread's `developerInstructions`?**
   The schema says it "takes precedence over model, reasoning_effort, and
   developer instructions if set", which is why the adapter sends one only around
   plan mode. Whether a plan turn loses our agent brief, and whether the default
   turn after it gets it back, was not measured.
