'use strict';

// The Claude process adapter: everything bridge/runner.js used to know about
// *Claude Code's* side of a conversation, and nothing about ours.
//
// A runner drives one agent process per conversation. Most of what it does is
// ours and the same whichever CLI is on the other end — the send queue and
// `inFlight`, the stall clock, the activity label, MAX_LIVE eviction, the note
// left in the session host and adopting from it, the approval cards and who may
// answer them. What is the CLI's is how to start it, what to write to it, and
// what its output means. That is this file, and a runtime that wants to be
// driven by the runner implements the same contract (docs/plans/23-codex.md,
// D1). The Codex one will speak JSON-RPC to `codex app-server` in each place
// where this one speaks stream-json to `claude -p`.
//
// ## The contract
//
// **Framing.** One JSON value per line, both ways. The runner splits stdout on
// newlines, parses each line, and hands the object to `read`; a line that is not
// JSON is diagnostic text and joins the stderr it classifies exits with. It
// serialises whatever the adapter returns to write, plus a newline. JSON-RPC
// over stdio is framed exactly this way, which is why the runner owns framing
// rather than the adapter.
//
// **One adapter per runner**, made with `new Adapter({ rpc })`. `rpc(verb,
// payload)` is the runner's correlated request: it mints the id, writes
// `request(id, verb, payload)`, and settles when `read` yields the matching
// `response` — or rejects with `err.reason` `refused` | `timeout` | `closed` |
// `gone`, which the runner's callers branch on. An adapter may keep state across
// lines (a Codex one has to remember turn and item ids); this one does not.
//
// **Starting a process** — the runner asks, in this order:
//
//   bin                         what to spawn
//   argv(o)                     its arguments. `o` is `{sessionId, cwd,
//                               permissionMode, model, effort, isNew, fork,
//                               branch, role, preview, systemPrompt, caps}`;
//                               `systemPrompt` is ours (the agent brief and a
//                               role's), to be appended to the CLI's own
//   env({browser, sudo})        its environment
//   label                       "Starting <label>…", and the process's name in
//                               the messages the runner writes about it
//   product                     the CLI's name, for "this <product> version…"
//   handshake()                 a promise, sent once the process is up; a
//                               rejection is ignored (an old build)
//
// **Reading.** `read(msg)` turns one output object into a list of events, in the
// order they happened. The runner acts on them in that order, and also replays
// them — without the side effects — from the output the session host kept when
// it adopts a process a previous bridge left there. So an event says what
// happened, never what to do about it:
//
//   {type:'init', version, sessionId, cwd, raw}
//                     the process is up. `sessionId` differing from the
//                     runner's is a fork; `raw` reaches the pool's `init`
//                     listeners (the slash palette reads Claude's)
//   {type:'response', id, ok, result, error}
//                     the answer to an `rpc`
//   {type:'ask', ask, uninteractive}
//                     the process is blocked on a person. `ask` is in the
//                     runner's held shape — {id, kind:'tool'|'plan'|'question',
//                     tool, displayName, input, secrets, toolUseId, description,
//                     reason, blockedPath, agentId, askedAt} — and
//                     `uninteractive` means it wants a dialog of its own that no
//                     card can draw
//   {type:'ask-withdrawn', id}      the process stopped waiting for an answer
//   {type:'request', id, method}    an inbound request the adapter does not
//                                   handle; the runner writes `refuse(event)`
//   {type:'lifecycle', uuid, state} what became of a turn written mid-turn:
//                                   queued | started | completed | cancelled |
//                                   discarded (see Runner#_onLifecycle)
//   {type:'tool-start', id, name, label}
//                     a tool call began; `label` is what to call it meanwhile
//   {type:'tools-done', ids}
//                     these calls finished. Emitted for every message that could
//                     carry one, with `ids` possibly empty, because whatever ends
//                     a call is also what puts the label back to the verb alone
//   {type:'writing'} | {type:'thinking'}
//   {type:'turn-end', result:{isError, text, costUsd, durationMs, numTurns, stopReason}}
//                     the turn the process was answering is over
//   {type:'task', id, state:'started'|'done', taskType}
//                     background work the process runs on its own
//   {type:'agent-done', taskId, toolUseId, status, summary, durationMs}
//   {type:'retry', attempt, max, status, notice}
//                     the CLI is retrying the API; `notice` is said once
//   {type:'quota', info, rejected, notice}
//                     rate-limit state, account-wide. `rejected` is the one
//                     that can end a turn; `info` is kept for `usageLimit`
//   {type:'notice', notice:{level, kind, text}}
//
// An unrecognised message is an empty list. Nothing here throws on a shape it
// does not know: that is the CLI being newer than us, not broken.
//
// **Writing.**
//
//   turn(entry)          the line for one user turn: `{uuid, text, attachments}`.
//                        `uuid` is ours, and `lifecycle` events name it
//   request(id, verb, payload)                   an outbound request's line
//   answer(ask, {behavior:'allow'|'deny', message, updatedInput, allowSession})
//                        the line answering an ask
//   refuse(requestEvent)                         the line turning one away
//
// **Control verbs** — each a promise, made with `rpc`:
//
//   interrupt()                end the running turn, keep the process
//   withdraw(uuid)             take back a turn written mid-turn; true only when
//                              the process says it had not started it
//   setPermissionMode(mode)    change the running process's mode
//
// **Exits and the rest.**
//
//   classifyExit(stderr, code)   {kind, message} for the `failed` event and
//                                `errorKind`. Kinds are docs/api.md's
//   argvRefusal(stderr, caps)    a process that died refusing one of its own
//                                flags: `{cap, notice}`, and the runner turns
//                                that cap off pool-wide and starts again
//   initialCaps()                what a build is assumed to support until it
//                                shows otherwise: {permissionPrompt, interrupt}
//   usageLimit(info, failed, detail)
//                                `{resetsAt, window}` when this turn ended on the
//                                account's usage limit, else null
//
// Everything below was lifted out of bridge/runner.js unchanged in what it
// does; the comments that explained it came along.

const fs = require('fs');
const path = require('path');

const cfg = require('../../config');
const { deleteBoth } = require('../../legacy-env');
const { toolDisplayName } = require('../../tool-name');
const { ATTACHMENT_NOTE_HEAD, attachmentNoteLine } = require('../../attachments');
const sudo = require('../../sudo');
const secrets = require('../../secrets');
const { ASKS, describeTool } = require('./tools');

const { CLAUDE_BIN } = cfg;

/**
 * The environment a session runs in.
 *
 * A session inherits the bridge's environment, and `TGXCODE_PORT` has no
 * business travelling down it. The bridge sets that variable for itself; an agent
 * that inherits it is holding the port of *this* instance, so a bridge it starts
 * while working on this codebase silently binds the everyday one — which is
 * exactly how a worktree came to be serving the user's window. An agent that
 * genuinely wants a port picks one, and `npm run dev` picks a free one for it.
 *
 * CLAUDE_CODE_ENTRYPOINT goes the other way: it is set here so the CLI knows what
 * started it.
 *
 * `browser` is the `agentBrowser.mode` setting. `headless` sets the variable the
 * Playwright MCP server reads in place of its `--headless` flag, so the browser an
 * agent tests with draws no window and cannot take focus from the person typing
 * elsewhere. `visible` adds nothing, which leaves the bridge's own environment in
 * charge — set the variable there and it still holds. The MCP server is started
 * once per `claude`, so a change reaches the next session spawned, not one running.
 *
 * `sudo` is `{key, port}` when Settings › Sudo is on, and then the session gets
 * SUDO_ASKPASS and what the helper needs to reach this bridge; null strips them.
 * Read at spawn like the browser — see bridge/sudo.js.
 *
 * `TGXCODE_SECRETS_PORT` is where bridge/secret-exec.js fetches a command's
 * secrets from. Always set, because the hook that wraps a command is always
 * there (bridge/secrets.js), and deliberately not `TGXCODE_PORT`: nothing reads
 * this one as the port to bind.
 */
function sessionEnv({ browser = 'visible', sudo: sudoAccess = null } = {}) {
    const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'tgxcode' };
    deleteBoth(env, 'PORT');
    // terminal.js sets this on a session's own terminal pane, and devservers.js
    // reads it ahead of CLAUDE_CODE_SESSION_ID. A bridge started from that pane
    // would pass it to every agent it runs, and each server those agents started
    // would be attributed to the pane's session. `claude` sets
    // CLAUDE_CODE_SESSION_ID itself.
    delete env.TGXCODE_SESSION_ID;
    // And this one goes the same way as the entrypoint: the app shows a
    // session's own task list, and current models are not offered the tools that
    // keep one unless this is set. See cfg.TODO_TOOLS for the opt-out.
    if (cfg.TODO_TOOLS) env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';
    if (browser === 'headless') env.PLAYWRIGHT_MCP_HEADLESS = 'true';
    sudo.applyEnv(env, sudoAccess);
    env.TGXCODE_SECRETS_PORT = String(cfg.PORT);
    return env;
}

// The tools this app gives a session that it would not otherwise have: offer the
// next piece of work as a suggestion, find the other sessions, and hand one of
// them a fact — waking it if it is idle. See bridge/mcp.js for what each does.
//
// Passed as a JSON *string* rather than a file — `--mcp-config` takes either, and
// a string means there is no temp file to write, collide on between two bridges,
// or leave behind. `process.execPath` rather than `node`, because the node that
// is already running us is the only one we know exists: a login shell has none
// on PATH, which is the whole reason bridge/launch.sh exists.
//
// Deliberately *not* `--strict-mcp-config`, which would switch off every MCP
// server the user configured for themselves. We are adding one, not taking over.
//
// **The port and the session id are arguments, and the token is not.** Two of
// these tools call back into this bridge, so the server has to know where it is
// — and `sessionEnv()` strips TGXCODE_PORT on purpose, so the
// environment is not the channel. This string lands on the `claude` command
// line, where `ps` can read it, which is why the port travels here and the token
// is read off disk at the other end instead.
const AGENT_TOOLS = [
    // A read of the agent brief's sections; see bridge/brief.js.
    'mcp__tgxcode__tgxcode_guide',
    'mcp__tgxcode__suggest_session',
    'mcp__tgxcode__list_sessions',
    'mcp__tgxcode__message_session',
    'mcp__tgxcode__find_tasks',
    'mcp__tgxcode__start_task',
    'mcp__tgxcode__set_task_status',
    'mcp__tgxcode__schedule_session',
    // Speaks only to this session, later; see bridge/wakes.js. A card for it would
    // be asked exactly when a session is about to stop for the night.
    'mcp__tgxcode__wake_me_up',
    // A read. install_on_phone is not here: it makes bytes downloadable off this
    // machine, which is a call worth a card.
    'mcp__tgxcode__phone_install_status',
    // Asking changes nothing until you answer the card it raises, and the answer
    // is only ever "it is set" — see bridge/secrets.js. Listing is names only.
    'mcp__tgxcode__request_secret',
    'mcp__tgxcode__list_secrets',
];

// The extra tools a session gets for its part in an orchestration — see
// bridge/orchestrators.js. Auto-approved for the reason the list above is: an
// orchestrator's whole job is calling them, mostly while nobody is watching, and
// a card for each one would be auto-denied at exactly that moment. What they can
// *do* is bounded where it survives that: the workers they start stop at the
// orchestrator's own permission prompts, the cap on running workers, and the
// usage cutoff.
const ROLE_TOOLS = {
    orchestrator: [
        'spawn_worker', 'list_workers', 'next_message', 'send_to_worker', 'answer_worker',
        'read_worker', 'stop_worker', 'close_worker', 'get_usage', 'set_summary',
    ].map(t => `mcp__tgxcode__${t}`),
    worker: ['mcp__tgxcode__report_to_orchestrator'],
};

// The `--mcp-config` string itself; see the note above AGENT_TOOLS for its shape.
//
// **`preview` is the second server, and only when `preview.agentControl` is on.**
// It is Playwright MCP pointed at the browser preview in the user's window rather
// than at a browser of its own; bridge/preview-mcp.js says how. Named `preview`
// so its tools (`mcp__preview__browser_click`, …) cannot be mistaken for the
// user's own Playwright server's, which stays exactly as it was. With it,
// tgxcode lists open_in_preview, which is how an agent gets a page there to drive.
function mcpConfig(sessionId, role = null, { preview = false } = {}) {
    const servers = {
        tgxcode: {
            command: process.execPath,
            args: [
                path.join(__dirname, '..', '..', 'mcp.js'),
                '--port', String(cfg.PORT),
                '--session', sessionId,
                // Which tools to list. Fixed at spawn, like everything on this
                // line: the CLI reads the tool list once, so a session whose
                // role changes has to be restarted to see it — see
                // RunnerPool#recycle.
                ...(role ? ['--role', role] : []),
                ...(preview ? ['--preview'] : []),
            ],
        },
    };
    if (preview) {
        servers.preview = {
            command: process.execPath,
            args: [path.join(__dirname, '..', '..', 'preview-mcp.js'), '--port', String(cfg.PORT)],
        };
    }
    return JSON.stringify({ mcpServers: servers });
}

// Answered without a card when the preview server is there. Turning the setting
// on is the consent: what these reach is the page in the preview pane and
// nothing else (app/preview-cdp.js), the user is watching it happen, and a card
// per click would make watching an agent use the page impossible. `mcp__preview`
// with no tool name is every tool that server lists.
const PREVIEW_TOOLS = ['mcp__preview', 'mcp__tgxcode__open_in_preview'];

// The task statuses that mean it is over, as `task_updated` spells them.
const TASK_DONE = ['completed', 'failed', 'killed', 'stopped'];

// What the CLI says when a turn is refused for the usage limit: the synthetic
// "You've hit your session limit · resets 3:20pm" (and the 5-hour and weekly
// spellings), or the older "Claude AI usage limit reached". A fallback for the
// `rate_limit_event` with status `rejected`, which is the reliable signal but is
// not there for a turn read back from an adopted process.
const LIMIT_TEXT = /\b(hit your (?:[\w-]+ )*limit|usage limit reached)\b/i;

// Types the API accepts as an image source. Kept here rather than imported from
// bridge/attachments.js so the adapter has no opinion about where files come
// from — it is handed a list and asked to send it.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// A cap on what one turn will inline, independent of the per-file upload cap. Five
// 25MB screenshots base64'd is a 160MB line on a pipe, and the paths are in the text
// either way — so past this the model reads the file instead of being handed it.
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

/**
 * The content blocks for one user turn.
 *
 * With nothing attached this is what it always was: one text block. With files on it,
 * three things are going on, and they are worth separating.
 *
 * **The note is split across blocks, one line each, with an image block sitting
 * straight after the line that names it.** `userText` in the Claude transcript reader
 * joins a turn's text blocks with a newline, so this reassembles into exactly the
 * message a single block would have carried — the parser on the way back does not
 * know or care that it arrived in pieces. What it buys is that each screenshot is
 * labelled with the file it came from. Two anonymous images on one turn are genuinely
 * ambiguous, and asked which was which the model said so; "the second screenshot" is
 * a thing people say, and this is what makes it answerable.
 *
 * **The base64 is read here**, at flush time, rather than carried on the queue entry.
 * A queued message is broadcast to every viewer inside `status()` on every change, and
 * a screenshot on that path would put megabytes through an SSE stream for reasons
 * unrelated to it.
 *
 * **A file that has gone missing since it was staged is skipped**, not fatal. Its path
 * is still in the note, so the message stays true either way: it says a file was
 * attached, and the model finds out it cannot read it in the ordinary way.
 */
function userContent(entry) {
    const files = entry.attachments || [];
    if (!files.length) return [{ type: 'text', text: entry.text }];

    // The note's heading rides on the end of the typed message rather than in a block
    // of its own, so the blank line between the two survives the rejoin.
    const content = [{
        type: 'text',
        text: entry.text ? `${entry.text}\n\n${ATTACHMENT_NOTE_HEAD}` : ATTACHMENT_NOTE_HEAD,
    }];

    let budget = MAX_INLINE_BYTES;
    for (const a of files) {
        content.push({ type: 'text', text: attachmentNoteLine(a) });
        if (!INLINE_IMAGE_TYPES.has(a.mediaType) || a.bytes > budget) continue;
        let data;
        try { data = fs.readFileSync(a.path); } catch { continue; }
        budget -= data.length;
        content.push({
            type: 'image',
            source: { type: 'base64', media_type: a.mediaType, data: data.toString('base64') },
        });
    }

    return content;
}

/**
 * The stdin line for one user turn. The uuid is ours, and the CLI reports what
 * became of the message under it — `command_lifecycle` frames, see
 * Runner#_onLifecycle — which is the only way to tell a message folded into a
 * running turn from one still waiting in the CLI's queue.
 */
function userLine(entry) {
    return {
        type: 'user',
        uuid: entry.uuid,
        message: { role: 'user', content: userContent(entry) },
    };
}

/**
 * The argv for one start. See the contract for `o`.
 */
function argv(o) {
    const args = [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', o.permissionMode,
    ];
    // The whole point of the control channel: route "may I?" back to us
    // instead of letting headless mode answer "no" on the user's behalf.
    // `stdio` is the CLI's sentinel for "ask over this stream" rather than
    // the name of an MCP tool.
    if (o.caps.permissionPrompt) args.push('--permission-prompt-tool', 'stdio');
    // Filing a suggestion is the agent offering the user something, not the
    // agent doing anything, so it must never raise an approval card — a
    // permission prompt for "may I suggest this?" is noise nobody wants.
    // `--allowedTools` is an auto-approve list, not a restriction on which
    // tools exist; `--tools` is the one that would narrow the set.
    //
    // `message_session` is on that list too, and that one is a real choice:
    // it wakes another session, which is an effect outside this
    // conversation, and auto-approving it means a session in *plan* mode can
    // still cause one. The alternative was worse. A handoff exists precisely
    // because the sender is finishing and the recipient is not around, so
    // gating it on an approval card means it is auto-denied exactly when it
    // was needed (see Runner#_onAsk, which denies with no window open)
    // and stalls until somebody looks the rest of the time. The containment
    // is put where it survives that: the woken session resumes in plan mode
    // and stops at a plan, and the bridge rate-limits the pair.
    //
    // One flag per tool. Repeating it is the form that has been checked
    // against a real session; whether a comma-separated list is also accepted
    // has not, and there is nothing to gain by finding out.
    //
    // **Plan mode ignores this list, and that is worth knowing before you go
    // looking for a bug in it.** A session in `plan` routes every tool that
    // is not plainly read-only through `can_use_tool` whatever is on
    // `--allowedTools`, so `message_session` from a planning session raises a
    // card — and is auto-denied when no window is open. Measured, not assumed:
    // the same `list_sessions` call is denied in `plan` and runs unasked in
    // `auto`.
    //
    // It matters in two directions and is wanted in both. A session that has
    // just *changed* something is not in plan mode, so the handoff that
    // motivates this feature goes out. And a session woken *by* a handoff is
    // resumed in plan mode, so it cannot pass the work on to a third session
    // even though the tool is nominally allowed — which is exactly the
    // containment the wrapper asks for in prose, enforced.
    //
    // The task and schedule tools are on it for the handoff's reason. Their
    // main caller is a *scheduled* run, which is unattended by definition, so
    // an approval card would be auto-denied at the one moment it matters —
    // and the same plan-mode rule means a session that is only planning still
    // has to ask before it schedules or starts anything.
    args.push('--mcp-config', mcpConfig(o.sessionId, o.role, { preview: o.preview }));
    for (const tool of AGENT_TOOLS) args.push('--allowedTools', tool);
    // The secrets hook, and the rules keeping Read and Edit out of the store —
    // bridge/secrets.js. Additive, like --mcp-config: the user's own settings
    // and hooks still apply.
    args.push('--settings', JSON.stringify(secrets.sessionSettings()));
    if (o.preview) for (const tool of PREVIEW_TOOLS) args.push('--allowedTools', tool);
    for (const tool of (o.role && ROLE_TOOLS[o.role]) || []) args.push('--allowedTools', tool);
    // Appended rather than replacing anything, so CLAUDE.md and the rest of the
    // default prompt still apply. One flag carrying everything the runner put
    // together: whether the CLI concatenates a repeated --append-system-prompt
    // or keeps the last one is not something to find out from a worker that
    // lost its brief.
    if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
    // `--session-id` mints the id; `--resume` continues it. Which one is right
    // is a fact about *this start*, not about the runner — see the reset below
    // the spawn in Runner#start, and the bug that reset fixes.
    if (o.isNew) args.push('--session-id', o.sessionId);
    else args.push('--resume', o.sessionId);
    if (o.fork) args.push('--fork-session');
    // Keep history up to and including `parent` — the entry the edited turn
    // follows — and drop the rest from the copy. The original is not touched:
    // the cut only applies to what this process loads, and `--fork-session`
    // writes it under a new id. Both flags are print-mode only, which the
    // `-p` above is, and both need `--resume`, which a fork always has.
    //
    // `--resume-drops-turn` is the CLI's own check that the cut discards the
    // turn you meant and nothing else — a queued message it absorbed, a task
    // notification. It refuses any cut that drops *another turn of yours*,
    // though, so it can only be asked for when the edited turn is the last
    // one (`guard`). Branching from turn 4 of 12 drops turns 5–12 on purpose,
    // and the banner that offered it said so.
    if (o.branch) {
        args.push(`--resume-session-at=${o.branch.parent}`);
        if (o.branch.guard) args.push(`--resume-drops-turn=${o.branch.fromUuid}`);
    }
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    return args;
}

/** A `can_use_tool` request as the runner holds it. */
function askFrom(msg) {
    const req = msg.request || {};
    return {
        id: msg.request_id,
        kind: ASKS[req.tool_name] || 'tool',
        tool: req.tool_name,
        // Ours for an MCP tool, whatever the CLI sent: its own label for one is
        // the server and tool spelled raw, and this string is drawn as-is by every
        // card, notification and the phone.
        displayName: toolDisplayName(req.tool_name) !== req.tool_name
            ? toolDisplayName(req.tool_name) : req.display_name || req.tool_name,
        input: req.input || {},
        // A Bash command the secrets hook wrapped: what it runs and with which
        // names. The card shows that, not the wrapper — see publicAsk in
        // bridge/runner.js.
        secrets: req.tool_name === 'Bash' && req.input ? secrets.unwrapCommand(req.input.command) : null,
        toolUseId: req.tool_use_id || null,
        description: req.description || null,
        reason: req.decision_reason || null,
        blockedPath: req.blocked_path || null,
        // A call made by a subagent, not by the session itself.
        agentId: req.agent_id || null,
        askedAt: Date.now(),
    };
}

/**
 * "Allow this tool for the rest of the session."
 *
 * `destination: 'session'` keeps it in the CLI's memory for this process only.
 * A wider scope would mean writing to Claude Code's own settings files, which is
 * not ours to do — a permanent allowlist belongs in Claude Code, not here.
 */
function sessionAllowRule(toolName) {
    return [{
        type: 'addRules',
        rules: [{ toolName }],
        behavior: 'allow',
        destination: 'session',
    }];
}

/**
 * Turn `claude`'s stderr into something the UI can act on.
 *
 * The case that matters: a session already running elsewhere — a background
 * agent, or a terminal — cannot be resumed, because two writers would be
 * appending to one transcript. Claude Code refuses and suggests branching off a
 * copy, which is exactly the recovery the UI should offer.
 */
function classifyError(stderr, code) {
    const text = String(stderr || '').trim();

    if (/currently running as a background agent|add --fork-session to branch/i.test(text)) {
        return {
            kind: 'busy-elsewhere',
            message: 'This session is already running somewhere else, so it cannot be '
                + 'continued here. Branch off a copy to keep going.',
        };
    }
    // A branch from an earlier turn that the CLI would not cut: the entry it was
    // told to keep is not in the transcript, or the drop guard found something
    // other than the edited turn in the part that would be discarded. Before the
    // `missing` test below, which "No message found" would otherwise not reach but
    // a later rewording easily could.
    if (/Resume rejected by --resume-drops-turn|No message found with message\.uuid/i.test(text)) {
        return {
            kind: 'branch-refused',
            message: 'Claude Code would not branch from that turn: '
                + text.split('\n').filter(Boolean)[0],
        };
    }
    if (/ENOENT|command not found|not found/i.test(text) && /claude/i.test(text)) {
        return {
            kind: 'no-claude',
            message: 'Could not find the `claude` command in WSL. Check that it is on PATH.',
        };
    }
    if (/No conversation found|session .* not found/i.test(text)) {
        return { kind: 'missing', message: 'Claude Code could not find this session to resume.' };
    }

    const tail = text.split('\n').filter(Boolean).slice(-4).join('\n');
    return { kind: 'unknown', message: tail || `claude exited with code ${code}` };
}

/**
 * `{resetsAt, window}` when a turn ended because the account hit its usage
 * limit, else null. `info` is the turn's `rejected` rate_limit_info, if one came;
 * `resetsAt` is epoch ms, or null when only the text said so — bridge/wakes.js
 * then asks bridge/usage.js.
 */
function usageLimit(info, failed, detail) {
    if (!failed) return null;
    if (!info && !LIMIT_TEXT.test(detail)) return null;
    const secs = info && Number.isFinite(info.resetsAt) ? info.resetsAt : null;
    return {
        resetsAt: secs === null ? null : Math.round(secs * 1000),
        window: (info && typeof info.rateLimitType === 'string' && info.rateLimitType) || null,
    };
}

/** stream-json, one output object at a time. See the contract above. */
function read(msg) {
    switch (msg.type) {
        case 'control_request': {
            // Only `can_use_tool` is ours to act on. Anything else is a newer
            // CLI expecting a client we are not, and is answered with an error
            // so it stops waiting on us.
            const req = msg.request || {};
            if (req.subtype !== 'can_use_tool') {
                return [{ type: 'request', id: msg.request_id, method: req.subtype }];
            }
            return [{ type: 'ask', ask: askFrom(msg), uninteractive: !!req.requires_user_interaction }];
        }

        case 'control_response': {
            const r = msg.response || {};
            return [{ type: 'response', id: r.request_id, ok: r.subtype !== 'error',
                result: r.response || {}, error: r.error || null }];
        }

        case 'command_lifecycle':
            return [{ type: 'lifecycle', uuid: msg.command_uuid, state: msg.state }];

        case 'control_cancel_request':
            // The CLI withdrew an ask — usually because the turn it belonged to
            // ended.
            return [{ type: 'ask-withdrawn',
                id: msg.request_id || (msg.request && msg.request.request_id) }];

        case 'system':
            if (msg.subtype === 'init') {
                return [{ type: 'init', version: msg.claude_code_version || null,
                    sessionId: msg.session_id || null, cwd: msg.cwd || null, raw: msg }];
            }
            if (msg.subtype === 'permission_denied') {
                return [{ type: 'notice', notice: {
                    level: 'warn', kind: 'permission_denied',
                    text: msg.content || 'A tool call was denied by the permission mode.',
                } }];
            }
            // `task_started` is sent for foreground subagents too; they finish with
            // a `task_notification` like any other, before their turn does.
            // `task_updated` is read for a terminal status in case a build sends
            // that without the notification.
            if (msg.subtype === 'task_started') {
                return [{ type: 'task', id: msg.task_id, state: 'started', taskType: msg.task_type || null }];
            }
            if (msg.subtype === 'task_updated') {
                return msg.patch && TASK_DONE.includes(msg.patch.status)
                    ? [{ type: 'task', id: msg.task_id, state: 'done' }] : [];
            }
            if (msg.subtype === 'task_notification') {
                // A background task finished — a subagent, or a command. The
                // conversation gets this as an injected *user* message too, which
                // is what the transcript reader draws; this is the structured copy.
                const u = msg.usage || {};
                return [
                    { type: 'task', id: msg.task_id, state: 'done' },
                    { type: 'agent-done', taskId: msg.task_id, toolUseId: msg.tool_use_id || null,
                        status: msg.status || 'completed', summary: msg.summary || null,
                        durationMs: u.duration_ms || null },
                ];
            }
            if (msg.subtype === 'api_retry') {
                // The CLI retries a failing API call up to ten times with
                // exponential backoff, which can run for several minutes.
                return [{ type: 'retry', attempt: msg.attempt, max: msg.max_retries,
                    status: msg.error_status || null,
                    // One notice, not ten.
                    notice: msg.attempt === 1 ? {
                        level: 'warn', kind: 'api_retry',
                        text: 'Trouble reaching the Anthropic API. Claude is retrying; '
                            + 'this can take several minutes before it gives up.',
                    } : null }];
            }
            return [];

        case 'assistant': {
            const out = [];
            for (const b of (msg.message && msg.message.content) || []) {
                if (b.type === 'tool_use') out.push({ type: 'tool-start', id: b.id, name: b.name, label: describeTool(b) });
                else if (b.type === 'text' && b.text.trim()) out.push({ type: 'writing' });
                else if (b.type === 'thinking') out.push({ type: 'thinking' });
            }
            return out;
        }

        case 'user': {
            const ids = [];
            for (const b of (msg.message && msg.message.content) || []) {
                if (b.type === 'tool_result') ids.push(b.tool_use_id);
            }
            return [{ type: 'tools-done', ids }];
        }

        case 'result':
            // A turn that ends in an API error still counts as "finished" to the
            // CLI, which is why `isError` travels with it.
            return [{ type: 'turn-end', result: {
                isError: !!msg.is_error,
                text: typeof msg.result === 'string' ? msg.result : '',
                costUsd: msg.total_cost_usd || 0,
                durationMs: msg.duration_ms || msg.duration_api_ms || 0,
                numTurns: msg.num_turns || 0,
                stopReason: msg.stop_reason || null,
            } }];

        case 'rate_limit_event': {
            const info = msg.rate_limit_info;
            if (!info) return [];
            // The whole payload, every time — not just the ones that are going
            // wrong. An `allowed` event is where `resetsAt` for a window lives, so
            // dropping it threw away the only free source of "when does the quota
            // come back". bridge/usage.js decides what is worth showing; see the
            // note there on why `utilization` is usually absent.
            return [{ type: 'quota', info, rejected: info.status === 'rejected',
                notice: info.status !== 'allowed'
                    ? { level: 'warn', kind: 'rate_limit', text: `Rate limit: ${info.status}` } : null }];
        }

        default:
            return [];
    }
}

class ClaudeAdapter {
    /** @param {{rpc: (verb:string, payload?:object) => Promise<object>}} host */
    constructor({ rpc }) {
        this.rpc = rpc;
    }

    get name() { return 'claude'; }
    get label() { return 'Claude'; }
    get product() { return 'Claude Code'; }
    get bin() { return CLAUDE_BIN; }

    argv(o) { return argv(o); }
    env(o) { return sessionEnv(o); }

    initialCaps() { return { permissionPrompt: true, interrupt: true }; }

    /**
     * The handshake the Agent SDK opens with. We need nothing from the reply, but
     * a CLI that expects a client to announce itself gets what it is waiting for,
     * and a round trip completing tells us the channel works in both directions
     * before anything depends on it.
     */
    handshake() { return this.rpc('initialize', {}); }

    read(msg) { return read(msg); }

    turn(entry) { return userLine(entry); }

    request(id, verb, payload = {}) {
        return { type: 'control_request', request_id: id, request: { subtype: verb, ...payload } };
    }

    answer(ask, { behavior, message, updatedInput, allowSession }) {
        const response = { behavior, toolName: ask.tool };
        if (behavior === 'allow' && updatedInput) response.updatedInput = updatedInput;
        if (behavior === 'deny') response.message = message || 'Denied from TGXCode.';
        if (allowSession) response.updatedPermissions = sessionAllowRule(ask.tool);
        return { type: 'control_response', response: { subtype: 'success', request_id: ask.id, response } };
    }

    refuse(ev) {
        return {
            type: 'control_response',
            response: {
                subtype: 'error', request_id: ev.id,
                error: `tgxcode does not handle the "${ev.method}" control request`,
            },
        };
    }

    // `cancel_queued` takes anything the CLI was holding for the next turn with
    // it: stopping means stopping, and the runner hands that text back.
    interrupt() { return this.rpc('interrupt', { cancel_queued: true }); }

    async withdraw(uuid) {
        const r = await this.rpc('cancel_async_message', { message_uuid: uuid });
        return !!(r && r.cancelled);
    }

    setPermissionMode(mode) { return this.rpc('set_permission_mode', { mode }); }

    classifyExit(stderr, code) { return classifyError(stderr, code); }

    // A build that does not know the flag rejects it before doing any work.
    argvRefusal(stderr, caps) {
        if (!caps.permissionPrompt || !/permission-prompt-tool/i.test(stderr)) return null;
        return {
            cap: 'permissionPrompt',
            notice: {
                level: 'warn', kind: 'no_permission_prompt',
                text: 'This Claude Code version does not support approval prompts here — '
                    + 'using permission mode only.',
            },
        };
    }

    usageLimit(info, failed, detail) { return usageLimit(info, failed, detail); }
}

module.exports = {
    Adapter: ClaudeAdapter, ClaudeAdapter,
    sessionEnv, mcpConfig, argv, read, askFrom, userContent, userLine, classifyError, usageLimit,
    AGENT_TOOLS, ROLE_TOOLS, PREVIEW_TOOLS, LIMIT_TEXT,
};
