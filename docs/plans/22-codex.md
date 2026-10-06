# 22 — Running Codex sessions beside Claude ones

**Effort:** XL, in six phases · **Depends on:** 01, 05, 08, 20 ·
**Touches:** `bridge/runner.js`, `bridge/transcript.js`, `bridge/sessions.js`,
`bridge/turn-index.js`, `bridge/changes.js`, `bridge/usage.js`, `bridge/mcp.js`,
`bridge/routes/session.js`, `web/transcript/*`, `web/composer/*`,
`web/new-session/dialog.js`, `web/index.html`, `docs/api.md`, new
`bridge/codex/*`, new `test/codex-*.test.js`

> Roadmap. Nothing here is built.

## Why

Everything TGXCode does is built around one agent CLI, Claude Code. The rail, the
approval cards, the boards, scheduling, the PR gate and the handoff tools are
not really about Claude, though: they are about *a coding agent that runs in a
directory and needs a human now and then*. OpenAI's Codex CLI is that too. The
goal is to start a Codex session from the same dialog, watch it in the same
transcript view, answer its approvals from the same cards, and schedule it
from the same schedule rows. Where Codex cannot do something, the UI should not
pretend it can.

This document is what research turned up, not what was measured. It is based on
`openai/codex` at `rust-v0.160.1` (2026-10-05) and on how
`pingdotgg/t3code` drives Codex today. Phase 0 exists to turn the claims below
into fixtures before any of them is built on.

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

Two details:

- **Cold rollouts may be compressed** to `.jsonl.zst`. Node has
  `zlib.zstdDecompressSync` from v22.15 (this machine has v22.23), so this needs
  a version check and no dependency.
- **Titles live elsewhere**, in `session_index.jsonl` (append-only, last entry
  wins). Archived threads live in `archived_sessions/`.

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
| `plan` | `on-request` | `read-only` | `user` | Plus `collaborationMode: {mode:"plan"}` |
| `dontAsk` | `never` | `workspace-write` | `user` | Never asks; anything outside the sandbox fails back to the model. Closest to Claude's meaning — verify in Phase 0 |
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
- Answer the open questions at the end of this document.

**Exit check:** fixtures exist for each event kind Phase 2 maps, and each open
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
  | `event_msg` `exec_command_end` | `tool` (Bash-like) + `tool-result` with stdout, stderr and exit code |
  | `event_msg` `patch_apply_end` / file changes | an edit `tool` carrying a unified diff |
  | MCP tool call, web search | `tool` |
  | `compacted` | `compact` |
  | `turn_aborted` | interrupted marker |
  | `event_msg` `plan_update` | checklist (see Phase 4) |

- `web/transcript/tools.js` learns to render a command row and a patch row.
- `changes.js` takes line counts from patch diffs instead of `structuredPatch`.
- `turn-index.js` takes turn boundaries from `turn_context` lines.

**Exit check:** a Codex session started in a terminal shows up in the rail and
reads correctly, with no Codex process started by the bridge.

### Phase 3 — Driving Codex

These are the `runner.js` behaviours, one by one, mapped onto the app-server:

| Ours | Codex |
|---|---|
| New session (`--session-id`) | `thread/start {cwd, model, config, historyMode:"paginated"}`. **The thread id comes back in the response**, so `index.note(id)` moves to after the reply. Today we mint the id ourselves, so this changes the order. |
| Resume (`--resume`) | `thread/resume {threadId}`, with the same `config` overrides |
| Send a turn | `turn/start {threadId, input[], approvalPolicy, sandboxPolicy, model, effort, collaborationMode}` |
| Hand a message to the running turn (`_handOver`) | `turn/steer {threadId, expectedTurnId, input}` |
| Drop a queued message | Our own queue holds it until `turn/completed`. There is no `cancel_async_message` to send. |
| Stop | `turn/interrupt {threadId, turnId}`, then SIGTERM/SIGKILL after `CONTROL_TIMEOUT_MS`, as now |
| Busy / idle and the activity label | `turn/started`, `turn/completed`, `item/started`, `item/completed`, `thread/status/changed` (`active{waitingOnApproval}`) |
| `can_use_tool` approval card | `item/commandExecution/requestApproval` (shows the command and cwd) and `item/fileChange/requestApproval` (the diff comes from the `fileChange` item). Reply with `{decision: accept \| acceptForSession \| decline \| cancel}`. **"Allow always" becomes `acceptForSession`**, and `cancel` also interrupts the turn. |
| A card withdrawn (`control_cancel_request`) | `serverRequest/resolved {threadId, requestId}` |
| AskUserQuestion card | `item/tool/requestUserInput {questions[{id, header, question, options, isOther, isSecret}]}`, answered with `{answers:{<id>:{answers:[…]}}}`. Needs `tools.experimental_request_user_input.enabled` in the thread `config`. |
| Extra permissions | `item/permissions/requestApproval` gets a third card type, with a turn or session scope |
| Model and effort pickers | `model/list`, which returns per model `supportedReasoningEfforts` and `defaultReasoningEffort`. `web/index.html` stops hard-coding the list for Codex sessions. |
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

### Phase 4 — The features around the conversation

- **Fork.** `thread/fork {threadId}`. The new id is in the response, and it
  drives the existing `session-forked` broadcast.
- **Branch from a turn.**
  - Fork with `lastTurnId`, which is inclusive, to keep everything up to that
    turn.
  - Use `beforeTurnId` (experimental) to drop that turn.
  - Both need paginated history. A thread started in legacy mode by a terminal
    `codex` reports `branchFromTurn: false`.
  - Neither undoes file changes, which matches what branch does today.
- **The tgxcode MCP server.**
  - Inject it through the `config` map on `thread/start` and `thread/resume`:
    `{"mcp_servers.tgxcode": {"command": node, "args": [mcp.js, "--port", P, "--session", id]}}`.
    `mcp.js` itself does not change.
  - Replace `--allowedTools mcp__tgxcode__*` with
    `default_tools_approval_mode = "approve"` on that server (an `AppToolApproval`
    in `codex-rs/config/src/types.rs`). Phase 0 confirms that value means
    "never ask".
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
  - `web/quota.js` gets a second meter keyed by runtime.
- **Version.** `codex --version`, compared against npm `@openai/codex`
  dist-tags. This is the same shape as `claude-version.js`, minus `claude
  update`: Codex installs vary (npm, brew, a release tarball), so tell the user
  how to update rather than doing it.
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
- **Auth.** `account/read` shows whether Codex is signed in, and which plan. If
  it is not, show what to run in the terminal pane, `codex login`. Driving
  `account/login/start` from the UI is possible but is not parity work.

## Parity at a glance

✅ direct · 🟡 works, differently · ❌ not possible with Codex today

| Feature | | How, or why not |
|---|---|---|
| Warm process per conversation, queue, host adoption | ✅ | D3 |
| Transcript view | ✅ | Rollout reader, D2 |
| Tool approvals, allow for session | ✅ | `requestApproval` + `acceptForSession` |
| Approvals surviving a bridge restart | ✅ | Note records the JSON-RPC id (Phase 3) |
| AskUserQuestion | ✅ | `item/tool/requestUserInput` (experimental) |
| Stop / interrupt | ✅ | `turn/interrupt` |
| Mid-turn message | ✅ | `turn/steer` |
| Model and effort | ✅ | `model/list`, which is better than our hard-coded list |
| Images | ✅ | `localImage` |
| Fork | ✅ | `thread/fork` |
| tgxcode MCP tools, suggestion cards, handoff | ✅ | `config.mcp_servers` |
| Quota | ✅ | `account/rateLimits/*`, which is simpler than Claude's |
| Scheduling, PR gate | ✅ | `runtime` on rows; `review/start` as an option |
| Worktrees | ✅ | Ours are plain git. A Codex session started in one just has that `cwd`. |
| Plan mode | 🟡 | A `plan` item, not an approval. The buttons send the next turn. |
| Permission modes | 🟡 | Mapped per turn (D5). `dontAsk` needs verifying. |
| Branch from a turn | 🟡 | Paginated-history threads only |
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

## Open questions for Phase 0

1. Does `approvalPolicy: never` with `workspace-write` behave like `dontAsk` —
   fail quietly — or does it widen anything?
2. Does `default_tools_approval_mode = "approve"` mean "never prompt"? And is
   the dotted `config` key `mcp_servers.tgxcode` accepted, or does the map need
   nesting?
3. How promptly does Codex flush rollout lines? If it buffers until the end of
   a turn, the live transcript has to come from `item/*` notifications after
   all, and D2 becomes "file for history, stream for the turn in progress".
4. Does a thread started by a terminal `codex` default to `legacy` or
   `paginated` history in 0.160? That decides how often branch-from-turn is
   unavailable.
5. Does `turn/steer` fold a message in at the next tool boundary, as Claude
   does, or does it restart the model call?
