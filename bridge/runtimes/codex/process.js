'use strict';

// The Codex process adapter: `codex app-server` behind the runner's process
// contract (the header of bridge/runtimes/claude/process.js), so a Codex session
// gets the queue, the cards, the stall clock and host adoption that a Claude one
// has, and the runner never learns it is talking JSON-RPC. Phase 3 of
// docs/plans/23-codex.md; bridge/codex/README §Fit says where the contract was
// widened to make room for it.
//
// What it decided, in the order a conversation meets it:
//
//   - **One app-server per conversation** (D3), spawned by the runner from `bin`
//     and `argv` through the session host like `claude` is. The runner frames
//     lines; this file gets parsed objects. bridge/codex/rpc.js is not used here —
//     it owns a stream, and the runner already does.
//   - **The handshake gates the queue.** `initialize`, the `initialized`
//     notification, `account/read`, then `thread/start` (a new session) or
//     `thread/resume` (any other). Nothing is written before it settles, and a
//     failure is the session's error: signed out (`account: null`) is
//     `codex-signed-out` before a turn spends thirteen seconds learning the same.
//     The order is the fixtures' order, which is what lets the replay stub drive
//     this file end to end.
//   - **Codex mints the id.** The `thread/start` reply becomes `init` with
//     `minted: true`, built in `read` from the reply's own line, so the adoption
//     replay rebuilds it. A reply is recognised by the verb we sent when we sent
//     it, and by its shape when there is no "when" (a replay).
//   - **A turn is a request.** `turn/start` from an idle runner, `turn/steer`
//     when the runner hands a message to the running turn, with ids of our own
//     (`cx_<n>`, never the runner's `req_…`). A started turn's reply names the
//     turn; a refused `turn/start` is a failed turn-end (nothing else would ever
//     end it), and a refused steer is `returned`, which the runner sends again
//     as a turn of its own.
//   - **Permission modes are ours** (D5): all three of Codex's settings go on
//     every `turn/start`, because leaving one out leaves the last turn's in
//     force. So setPermissionMode is free and needs no request.
//   - **Approvals carry Codex's own decisions.** A command request's
//     `availableDecisions` become the ask's `decisions`; a file-change request,
//     which carries none, gets the four its schema allows. The execpolicy
//     amendment is persistent — Codex keeps it in its rules — so its label says
//     so. A permissions request is a third card, granted for the turn or the
//     session. Server-request ids are integers; the ask keeps the integer
//     (`rpcId`) and is answered with it.
//   - **`serverRequest/resolved` follows every request**, answered or not, so it
//     withdraws a card only when we never answered it.
//   - **Two question mechanisms.** The blocking `item/tool/requestUserInput` is a
//     question ask answered by id. The async one is an `agentMessage` carrying
//     `questions`, with no request behind it: it becomes a question ask with
//     `followUp: true`, and its answer is sent as the next turn.
//   - **Plan mode ends in a `plan` item**, not a request. A turn that produced
//     one ends, and then a plan ask with `followUp: true` goes up; Approve sends
//     "Implement the plan." in the mode the card chose, Revise sends the
//     feedback as another plan turn. The runner's followUp handling is the
//     mechanism; nothing goes on the wire for the ask itself.
//   - **Images go as `localImage`**, by the path attachments.js staged. No base64.
//
// Phase 4's conversation features (docs/plans/23-codex.md):
//
//   - **Fork and branch are `thread/fork`**, made in the handshake in place of
//     `thread/resume`, with `excludeTurns: true`. The reply names the new thread
//     and is an `init` that is not `minted`, so the runner announces it as a fork
//     exactly as it does Claude's `--fork-session`. A branch from a turn adds
//     `beforeTurnId`: the send route's `branch.parent` is the turn the edited
//     message was in (bridge/runtimes/codex/transcript.js, `branchPoint`).
//   - **The checklist is `update_plan`**, opt-in, so every thread this adapter
//     opens says `tools.update_plan.enabled` in its config. The list itself is read
//     from the rollout (bridge/codex/plan.js); `turn/plan/updated` is the live
//     copy, and becomes the activity line — the step in progress.
//   - **Spawned agents share this connection.** A subagent's thread runs in this
//     app-server, so its `turn/started`, items and `turn/completed` arrive here
//     under *its* `threadId`. They are never this thread's turn — a child's
//     `turn/completed` used to end the parent's — and are read only as the
//     subagent's progress; the parent's own `subAgentActivity` items are what
//     start and finish it as background work (`task`, `agent-done`).
//   - **A slash command is a skill.** `/name args` for a skill the palette listed
//     (bridge/codex/skills.js) goes as `{type:"skill", name, path}` beside the
//     text `$name args`, as Codex's own clients send one.
//
// Kept out of here, for the rest of Phase 4: the tgxcode MCP server in the thread
// `config`.

const path = require('path');

const cfg = require('../../config');
const { deleteBoth } = require('../../legacy-env');
const sudo = require('../../sudo');
const { CODEX_BIN } = require('../../codex/client');
const { KNOWN_NOTIFICATIONS, OPT_OUT } = require('../../codex/protocol');
// The one table of item kinds, shared with the rollout reader (D2): the same item
// is a `tool` event in a transcript and a `tool-start` label here, under the
// same name, so a card, a row and the activity line agree on what a call is.
const { TOOL, KINDS, toolEvent, scriptOf, contextOf, taskNameOf } = require('../../codex/items');
const codexSkills = require('../../codex/skills');
const { describeTool } = require('./tools');

let bridgeVersion = '0.0.0';
try { bridgeVersion = require(path.join(__dirname, '..', '..', '..', 'package.json')).version; } catch { /* packaged */ }

const KNOWN = new Set(KNOWN_NOTIFICATIONS);
const unknownLogged = new Set();

// Ours → Codex's three settings (docs/plans/23-codex.md, D5). `plan` adds a
// collaborationMode on the turn; Codex forces read-only in it whatever is sent.
const MODES = {
    manual: { approvalPolicy: 'untrusted', sandbox: 'read-only', reviewer: 'user' },
    acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write', reviewer: 'user' },
    auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write', reviewer: 'auto_review' },
    plan: { approvalPolicy: 'on-request', sandbox: 'read-only', reviewer: 'user' },
    dontAsk: { approvalPolicy: 'never', sandbox: 'workspace-write', reviewer: 'user' },
    bypassPermissions: { approvalPolicy: 'never', sandbox: 'danger-full-access', reviewer: 'user' },
};

/** `thread/start` takes a SandboxMode; `turn/start` takes a SandboxPolicy. */
const POLICY = {
    'read-only': { type: 'readOnly' },
    'workspace-write': { type: 'workspaceWrite' },
    'danger-full-access': { type: 'dangerFullAccess' },
};

function settingsFor(mode) {
    return MODES[mode] || MODES.auto;
}

/**
 * The entry a decision word becomes. `id` is the variant's name, which is what a
 * client answers with; `raw` is the value Codex is answered with, kept as sent.
 */
function decisionOf(d, { command = true } = {}) {
    const key = typeof d === 'string' ? d : (d && typeof d === 'object' && Object.keys(d)[0]) || String(d);
    const raw = d;
    switch (key) {
        case 'accept':
            return { id: key, label: 'Allow', behavior: 'allow', scope: 'once', endsTurn: false, raw };
        case 'acceptForSession':
            return { id: key, label: command ? 'Allow for this session' : 'Allow these files for this session',
                behavior: 'allow', scope: 'session', endsTurn: false, raw };
        case 'acceptWithExecpolicyAmendment': {
            const prefix = (d[key] && Array.isArray(d[key].execpolicy_amendment) ? d[key].execpolicy_amendment : [])
                .join(' ');
            return { id: key,
                label: prefix ? `Always allow \`${prefix}\` — saved to Codex's rules, in every session`
                    : "Always allow this command — saved to Codex's rules, in every session",
                behavior: 'allow', scope: 'always', endsTurn: false, raw };
        }
        case 'applyNetworkPolicyAmendment': {
            const a = (d[key] && d[key].network_policy_amendment) || {};
            const deny = /deny/i.test(String(a.action || ''));
            const host = a.host || 'this host';
            return { id: key,
                label: `${deny ? 'Always block' : 'Always allow'} network access to ${host} — saved to Codex's rules`,
                behavior: deny ? 'deny' : 'allow', scope: 'always', endsTurn: false, raw };
        }
        case 'decline':
            return { id: key, label: 'Deny', behavior: 'deny', scope: 'once', endsTurn: false, raw };
        case 'cancel':
            return { id: key, label: 'Deny and stop the turn', behavior: 'deny', scope: 'once', endsTurn: true, raw };
        default:
            // A decision this build has not met. Offered under its own name, as a
            // refusal: a button that might allow something we cannot describe is
            // the wrong default.
            return { id: key, label: key, behavior: 'deny', scope: 'once', endsTurn: false, raw };
    }
}

// What a file-change request may be answered with (FileChangeApprovalDecision).
// It carries no list of its own, so the schema's is the list.
const FILE_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'];

// A permissions request is granted for the turn or for the session, or not.
const PERMISSION_DECISIONS = [
    { id: 'turn', label: 'Allow for this turn', behavior: 'allow', scope: 'once', endsTurn: false, raw: 'turn' },
    { id: 'session', label: 'Allow for this session', behavior: 'allow', scope: 'session', endsTurn: false, raw: 'session' },
    { id: 'decline', label: 'Deny', behavior: 'deny', scope: 'once', endsTurn: false, raw: null },
];

/**
 * `/bin/bash -lc 'touch x'` → `touch x`. Codex runs every command through a
 * login shell and reports it wrapped; the card shows what runs. items.js's
 * reading of it, so the card and the transcript row say the same thing.
 */
const unwrapCommand = (cmd) => scriptOf(cmd);

/**
 * What a tool-like item is called while it runs — `{name, label}` — or null for
 * one that is not a tool (a message, reasoning, and a plan, which is the model
 * writing).
 */
function describeItem(item) {
    if (!item || item.type === 'plan') return null;
    const ev = toolEvent(item);
    return ev ? { name: ev.name, label: describeTool(ev) } : null;
}

/** "Reconnecting... 2/5" → {attempt: 2, max: 5}, or null. */
function retryOf(message) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(String(message || ''));
    return m ? { attempt: Number(m[1]), max: Number(m[2]) } : null;
}

/** `tgxcode/0.172.0 (Ubuntu …)` → `0.172.0`: the server names itself after our client. */
function versionOf(userAgent) {
    const m = /\/(\d+\.\d+\.\d+[^\s(]*)/.exec(String(userAgent || ''));
    return m ? m[1] : null;
}

function startError(kind, message) {
    return Object.assign(new Error(message), { kind });
}

/**
 * The environment a Codex process runs in: the bridge's, less the variables that
 * are about *this* bridge (the port, a terminal pane's session id — see
 * sessionEnv in bridge/runtimes/claude/process.js, which says why), with sudo's
 * askpass when Settings › Sudo is on and the secrets port beside it.
 */
// The thread config every conversation is opened with. `update_plan` is opt-in on
// 0.172.0, and it is what the checklist and the boards are built from.
const THREAD_CONFIG = Object.freeze({ 'tools.update_plan.enabled': true });

function codexEnv({ sudo: sudoAccess = null } = {}) {
    const env = { ...process.env };
    deleteBoth(env, 'PORT');
    delete env.TGXCODE_SESSION_ID;
    sudo.applyEnv(env, sudoAccess);
    env.TGXCODE_SECRETS_PORT = String(cfg.PORT);
    return env;
}

/**
 * The input list for one user turn: the typed text with the attachment note on
 * it, and each image beside it as a `localImage` by path. The note is written by
 * the same two helpers the Claude adapter uses, so the transcript reader sees the
 * same text whichever runtime wrote it.
 */
function inputFor(entry, skillOf = null) {
    const files = entry.attachments || [];
    // `/name args` for a skill Codex listed: the skill as an input, and the text
    // as Codex's own clients write a mention of it.
    let text = entry.text || '';
    const skills = [];
    const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const skill = m && typeof skillOf === 'function' ? skillOf(m[1]) : null;
    if (skill) {
        skills.push({ type: 'skill', name: skill.name, path: skill.path });
        text = m[2] ? `$${skill.name} ${m[2].trim()}` : `$${skill.name}`;
    }
    if (!files.length) return [...skills, { type: 'text', text }];
    const { ATTACHMENT_NOTE_HEAD, attachmentNoteLine, isImageType } = require('../../attachments');
    const lines = [text ? `${text}\n\n${ATTACHMENT_NOTE_HEAD}` : ATTACHMENT_NOTE_HEAD];
    for (const a of files) lines.push(attachmentNoteLine(a));
    const input = [...skills, { type: 'text', text: lines.join('\n') }];
    for (const a of files) {
        if (a && a.path && isImageType(a.mediaType)) input.push({ type: 'localImage', path: a.path });
    }
    return input;
}

/** Claude's question shape, from requestUserInput's. `id` is what Codex answers by. */
function questionsFrom(qs) {
    return (qs || []).map(q => ({
        id: q.id,
        header: q.header || '',
        question: q.question || q.header || '',
        options: (q.options || []).map(o => ({ label: String(o.label || ''), description: o.description || '' })),
        multiSelect: false,
        ...(q.isOther && { isOther: true }),
        ...(q.isSecret && { isSecret: true }),
    }));
}

/** The async tool's `questions[{title, options[string]}]`, in the same shape. */
function asyncQuestionsFrom(qs) {
    return (qs || []).map((q, i) => ({
        id: `q${i}`,
        header: '',
        question: String(q.title || q.question || `Question ${i + 1}`),
        options: (q.options || []).map(o => (typeof o === 'string'
            ? { label: o, description: '' } : { label: String(o.label || ''), description: o.description || '' })),
        multiSelect: false,
        isOther: true,
    }));
}

class CodexAdapter {
    /**
     * @param {{rpc: Function, notify?: Function}} host  `notify(obj)` writes a line
     *   the runner does not wait on — the `initialized` notification
     */
    constructor({ rpc, notify }) {
        this.rpc = rpc;
        this.notify = notify || (() => false);
        this.seq = 0;
        this.own = new Map();        // our turn ids -> {kind:'start'|'steer', uuid}
        this.verbs = new Map();      // the runner's ids -> verb, for reading replies
        this.answered = new Set();   // ask ids we answered, for serverRequest/resolved
        this.items = new Map();      // item id -> the item as it started, for a file-change card
        this.threadId = null;
        this.turnId = null;
        this.version = null;
        this.cwd = null;
        this.model = null;           // what the thread runs; plan mode has to name it
        this.effort = null;
        this.mode = 'auto';
        this.systemPrompt = null;
        this.wasPlan = false;        // the last turn/start was in plan mode
        this.current = null;            // {plan, text, error} for the turn running
        this.agents = new Map();        // spawned agents' thread ids -> their task name
        this.finished = new Set();      // the ones whose end has been reported
    }

    get name() { return 'codex'; }
    get label() { return 'Codex'; }
    get product() { return 'Codex'; }
    get bin() { return CODEX_BIN; }
    get handshakeGates() { return true; }

    argv() { return ['app-server', '--listen', 'stdio://']; }
    env(o) { return codexEnv(o); }
    initialCaps() { return { permissionPrompt: true, interrupt: true }; }

    /** What an adopted process's adapter would have learned at its start. */
    adopting(o) {
        this.threadId = o.sessionId || null;
        this.cwd = o.cwd || null;
        if (o.model) this.model = o.model;
        this.effort = o.effort || null;
        if (o.permissionMode) this.mode = o.permissionMode;
    }

    async handshake(o) {
        this.cwd = o.cwd;
        this.mode = o.permissionMode || 'auto';
        this.effort = o.effort || null;
        if (o.model) this.model = o.model;
        this.systemPrompt = o.systemPrompt || null;

        try {
            await this.rpc('initialize', {
                clientInfo: { name: 'tgxcode', title: 'TGXCode', version: bridgeVersion },
                capabilities: { experimentalApi: true, optOutNotificationMethods: [...OPT_OUT] },
            });
        } catch (err) {
            throw startError('unknown', `Codex would not start a conversation: ${err.message}`);
        }
        this.notify({ method: 'initialized' });

        // Before anything that costs a turn: a signed-out Codex spends about
        // thirteen seconds retrying before it says so. `account: null` is the
        // signal; `requiresOpenaiAuth` is true signed in as well.
        let account;
        try { account = await this.rpc('account/read', { refreshToken: false }); } catch { account = undefined; }
        if (account && account.account === null) {
            throw startError('codex-signed-out',
                'Codex is not signed in. Run `codex login` in a terminal (or `codex login --device-auth` '
                + 'where no browser opens), then send again.');
        }

        const s = settingsFor(this.mode);
        const common = {
            cwd: o.cwd,
            ...(o.model && { model: o.model }),
            approvalPolicy: s.approvalPolicy,
            sandbox: s.sandbox,
            approvalsReviewer: s.reviewer,
            ...(this.systemPrompt && { developerInstructions: this.systemPrompt }),
            config: { ...THREAD_CONFIG },
        };
        if (o.fork) {
            // A copy, or a copy cut before a turn. The new thread's id comes back
            // in the reply, which `read` makes the fork's `init`.
            const cut = o.branch && o.branch.parent ? { beforeTurnId: o.branch.parent } : {};
            try {
                await this.rpc('thread/fork', { threadId: o.sessionId, ...common, excludeTurns: true, ...cut });
            } catch (err) {
                if (o.branch) {
                    throw startError('branch-refused', `Codex would not branch from that turn: ${err.message}`);
                }
                if (/not found|no (?:such )?thread|no rollout/i.test(err.message)) {
                    throw startError('missing', 'Codex could not find this conversation to copy.');
                }
                throw startError('unknown', `Codex would not copy this conversation: ${err.message}`);
            }
            return;
        }
        if (o.isNew) {
            try {
                await this.rpc('thread/start', { ...common, historyMode: 'paginated' });
            } catch (err) {
                throw startError('unknown', `Codex would not start the conversation: ${err.message}`);
            }
            return;
        }
        const resume = () => this.rpc('thread/resume', { threadId: o.sessionId, ...common, excludeTurns: true });
        try {
            await resume();
        } catch (err) {
            // An archived thread is brought back once, as t3code does.
            if (/archiv/i.test(err.message)) {
                try {
                    await this.rpc('thread/unarchive', { threadId: o.sessionId });
                    await resume();
                    return;
                } catch (again) {
                    throw startError('missing', `Codex could not reopen this conversation: ${again.message}`);
                }
            }
            if (/not found|no (?:such )?thread|no rollout/i.test(err.message)) {
                throw startError('missing', 'Codex could not find this conversation to resume.');
            }
            throw startError('unknown', `Codex could not reopen this conversation: ${err.message}`);
        }
    }

    read(msg) {
        if (!msg || typeof msg !== 'object') return [];
        if (msg.method === undefined && msg.id !== undefined) return this._reply(msg);
        if (typeof msg.method === 'string' && msg.id !== undefined) return this._serverRequest(msg);
        if (typeof msg.method === 'string') return this._notification(msg.method, msg.params || {});
        return [];
    }

    /** A reply to one of ours: a turn, a handshake step, or a runner request. */
    _reply(msg) {
        const ok = !msg.error;
        const result = msg.result || {};
        const errorText = msg.error ? String(msg.error.message || 'refused') : null;
        const response = { type: 'response', id: msg.id, ok, result, error: errorText };

        const mine = this.own.get(msg.id);
        if (mine) {
            this.own.delete(msg.id);
            if (mine.kind === 'start') {
                if (ok) {
                    if (result.turn && result.turn.id) this.turnId = result.turn.id;
                    return [{ type: 'lifecycle', uuid: mine.uuid, state: 'started' }];
                }
                // A turn Codex never started: nothing else will end it, and the
                // runner is holding it in flight until something does.
                return [{ type: 'turn-end', result: { isError: true,
                    text: `Codex refused the message: ${errorText}`, costUsd: 0, durationMs: 0,
                    numTurns: 0, stopReason: 'refused' } }];
            }
            // A steer. Refused is "the turn ended first" (-32600 "no active turn to
            // steer") or the turn moved on; either way the message is still wanted.
            return [{ type: 'lifecycle', uuid: mine.uuid, state: ok ? 'started' : 'returned' }];
        }
        // Our own ids are `cx_<n>`. One we no longer have a record of is a turn
        // from before an adoption; its reply says nothing the notifications do not.
        if (typeof msg.id === 'string' && msg.id.startsWith('cx_')) return [];

        const verb = this.verbs.get(msg.id);
        this.verbs.delete(msg.id);
        const out = [response];
        if (ok && (verb === 'initialize' || (!verb && typeof result.userAgent === 'string'))) {
            this.version = versionOf(result.userAgent);
        }
        if (ok && result.thread && result.thread.id
            && (verb === 'thread/start' || verb === 'thread/resume' || verb === 'thread/unarchive'
                || verb === 'thread/fork' || !verb)) {
            this.threadId = result.thread.id;
            if (result.model) this.model = result.model;
            if (result.cwd) this.cwd = result.cwd;
            // On a replay there is no verb; a thread reply that is the one this
            // process started under says so by being new (no turns, no preview,
            // not a fork). A fork's reply is a new id that is not minted: the
            // runner announces it as `forked`.
            const minted = verb ? verb === 'thread/start'
                : !result.thread.forkedFromId
                    && !(result.thread.turns && result.thread.turns.length) && !result.thread.preview;
            out.push({ type: 'init', version: this.version, sessionId: this.threadId, minted,
                cwd: this.cwd, raw: null });
        }
        return out;
    }

    /** Codex asking us something. Ask ids are the integer as a string; `rpcId` keeps it. */
    _serverRequest(msg) {
        const p = msg.params || {};
        const base = {
            id: String(msg.id), rpcId: msg.id, secrets: null,
            toolUseId: p.itemId || null, description: null, reason: p.reason || null,
            blockedPath: null, agentId: null, askedAt: Date.now(),
        };
        switch (msg.method) {
            case 'item/commandExecution/requestApproval': {
                const list = Array.isArray(p.availableDecisions) && p.availableDecisions.length
                    ? p.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel'];
                return [{ type: 'ask', uninteractive: false, ask: { ...base,
                    kind: 'tool', tool: TOOL.command, displayName: 'Run a command',
                    input: { command: unwrapCommand(p.command), cwd: p.cwd || null,
                        ...(p.networkApprovalContext && { network: p.networkApprovalContext }) },
                    decisions: list.map(d => decisionOf(d)) } }];
            }
            case 'item/fileChange/requestApproval': {
                const item = this.items.get(p.itemId) || { type: 'fileChange', changes: [] };
                return [{ type: 'ask', uninteractive: false, ask: { ...base,
                    kind: 'tool', tool: TOOL.patch, displayName: 'Edit files',
                    input: { ...KINDS.fileChange.input(item), ...(p.grantRoot && { grantRoot: p.grantRoot }) },
                    blockedPath: p.grantRoot || null,
                    decisions: FILE_DECISIONS.map(d => decisionOf(d, { command: false })) } }];
            }
            case 'item/permissions/requestApproval':
                return [{ type: 'ask', uninteractive: false, ask: { ...base,
                    kind: 'tool', tool: 'permissions', displayName: 'More permissions',
                    input: { permissions: p.permissions || {}, cwd: p.cwd || null },
                    decisions: PERMISSION_DECISIONS.map(d => ({ ...d })) } }];
            case 'item/tool/requestUserInput':
                return [{ type: 'ask', uninteractive: false, ask: { ...base,
                    kind: 'question', tool: 'request_user_input', displayName: 'Question',
                    input: { questions: questionsFrom(p.questions), ...(p.isBlocking === false && { blocking: false }) } } }];
            default:
                // Elicitations, dynamic tool calls, token refreshes: a client we are
                // not. Turned away with -32601 so Codex stops waiting.
                return [{ type: 'request', id: msg.id, method: msg.method }];
        }
    }

    _notification(method, p) {
        if (!KNOWN.has(method) && !unknownLogged.has(method)) {
            unknownLogged.add(method);
            console.warn(`[codex] ignoring unknown notification ${method}`);
        }
        if (p.threadId && !this.threadId) this.threadId = p.threadId;
        // A spawned agent's thread runs on this connection too. Nothing it says is
        // this thread's turn; see the header. Only a thread a `subAgentActivity`
        // named is a child: anything else is taken as this thread, as it was
        // before agents were known, rather than dropped.
        if (p.threadId && p.threadId !== this.threadId && this.agents.has(String(p.threadId).toLowerCase())) {
            return this._child(method, p);
        }
        switch (method) {
            case 'thread/started':
                if (p.thread && p.thread.id && !this.threadId) this.threadId = p.thread.id;
                return [];

            case 'turn/started':
                if (p.turn && p.turn.id) this.turnId = p.turn.id;
                this.current = { plan: null, text: '', error: null };
                return [{ type: 'thinking' }];

            case 'item/started': {
                const item = p.item || {};
                if (item.id) this.items.set(item.id, item);
                if (this.items.size > 200) this.items.delete(this.items.keys().next().value);
                if (item.type === 'subAgentActivity') return this._agentActivity(item);
                if (item.type === 'reasoning') return [{ type: 'thinking' }];
                if (item.type === 'agentMessage' || item.type === 'plan') return [{ type: 'writing' }];
                const d = describeItem(item);
                return d ? [{ type: 'tool-start', id: item.id, name: d.name, label: d.label }] : [];
            }

            case 'item/completed': {
                const item = p.item || {};
                const out = [{ type: 'tools-done', ids: item.id ? [item.id] : [] }];
                if (item.id) this.items.delete(item.id);
                // A spawn's `started` item says it twice, started and completed;
                // the second is not news.
                if (item.type === 'subAgentActivity' && item.kind === 'started') return out;
                if (item.type === 'subAgentActivity') return [...out, ...this._agentActivity(item)];
                const t = this.current || (this.current = { plan: null, text: '', error: null });
                if (item.type === 'plan' && item.text) t.plan = item.text;
                if (item.type === 'agentMessage' && typeof item.text === 'string') {
                    t.text = item.text;
                    // The async question tool: no request behind it, and the turn
                    // goes on. Its answer is the next turn.
                    if (item.delivery === 'async' && Array.isArray(item.questions) && item.questions.length) {
                        out.push({ type: 'ask', uninteractive: false, ask: {
                            id: `ask-${item.id}`, kind: 'question', tool: 'request_user_input_async',
                            displayName: 'Question', input: { questions: asyncQuestionsFrom(item.questions) },
                            followUp: true, secrets: null, toolUseId: item.id, description: null, reason: null,
                            blockedPath: null, agentId: null, askedAt: Date.now() } });
                    }
                }
                return out;
            }

            case 'turn/completed': {
                const turn = p.turn || {};
                const t = this.current || { plan: null, text: '', error: null };
                this.current = null;
                this.turnId = null;
                const status = turn.status || 'completed';
                const failed = status === 'failed';
                const errText = (turn.error && turn.error.message) || t.error || '';
                const last = (turn.items || []).filter(i => i && i.type === 'agentMessage').pop();
                const out = [{ type: 'turn-end', result: {
                    isError: failed,
                    text: failed ? errText || 'The turn failed.' : (last && last.text) || t.text || '',
                    costUsd: 0,
                    durationMs: turn.durationMs || 0,
                    numTurns: 1,
                    stopReason: status,
                } }];
                // A plan turn ends in a plan and nothing to approve. The card is
                // ours, and so is what it does: see Runner#_answerFollowUp.
                if (t.plan && status === 'completed') {
                    out.push({ type: 'ask', uninteractive: false, ask: {
                        id: `plan-${turn.id || Date.now()}`, kind: 'plan', tool: 'plan', displayName: 'Plan',
                        input: { plan: t.plan }, followUp: true, secrets: null, toolUseId: null,
                        description: null, reason: null, blockedPath: null, agentId: null, askedAt: Date.now() } });
                }
                return out;
            }

            // Two readings the bridge shows and does not act on: how full this
            // thread's context window is (a subagent's thread has its own, so
            // only ours counts), and the account's usage windows.
            case 'thread/tokenUsage/updated': {
                if (p.threadId && p.threadId !== this.threadId) return [];
                const u = p.tokenUsage || {};
                const context = contextOf(u.last && u.last.totalTokens, u.modelContextWindow);
                return context ? [{ type: 'context', context }] : [];
            }

            case 'account/rateLimits/updated':
                return p.rateLimits ? [{ type: 'limits', limits: p.rateLimits }] : [];

            case 'turn/plan/updated': {
                // The checklist, live. The list is read from the rollout (the
                // checklist panel, the boards); this is what the turn is on now.
                const plan = Array.isArray(p.plan) ? p.plan : [];
                const at = plan.findIndex(s => s && (s.status === 'inProgress' || s.status === 'in_progress'));
                if (at < 0) return [];
                const step = String(plan[at].step || '').trim();
                return [{ type: 'tool-start', id: `plan:${p.turnId || this.turnId || ''}`, name: 'update_plan',
                    label: `${step || 'Working'} (${at + 1} of ${plan.length})` }];
            }

            case 'serverRequest/resolved': {
                // Sent after every request, answered or not. Only one we did not
                // answer has been withdrawn.
                const id = String(p.requestId);
                if (this.answered.has(id)) { this.answered.delete(id); return []; }
                return [{ type: 'ask-withdrawn', id }];
            }

            case 'error': {
                const e = p.error || {};
                if (p.willRetry) {
                    const r = retryOf(e.message) || { attempt: 1, max: null };
                    return [{ type: 'retry', attempt: r.attempt, max: r.max,
                        status: e.codexErrorInfo ? Object.keys(e.codexErrorInfo)[0] || null : null,
                        notice: r.attempt === 1 ? { level: 'warn', kind: 'api_retry',
                            text: 'Trouble reaching OpenAI. Codex is retrying; this can take a while before it gives up.' }
                            : null }];
                }
                if (this.current) this.current.error = e.message || null;
                return [];
            }

            case 'configWarning':
            case 'deprecationNotice':
                return [{ type: 'notice', notice: { level: 'warn', kind: 'codex_warning',
                    text: String(p.summary || p.message || p.details || method) } }];

            case 'model/rerouted':
                return [{ type: 'notice', notice: { level: 'info', kind: 'codex_rerouted',
                    text: `Codex moved this turn from ${p.fromModel || 'the chosen model'} to ${p.toModel || 'another model'}`
                        + (p.reason ? ` (${p.reason})` : '') + '.' } }];

            default:
                return [];
        }
    }

    /**
     * A spawned agent's `subAgentActivity`, as background work: `started` is a
     * task the process runs on its own, and `completed` or `interrupted` ends it
     * and says so (`agent-done`). Keyed by the agent's thread id, which is also
     * the id of its row in the transcript and how `GET …/subagent` finds it.
     */
    _agentActivity(item) {
        const id = item.agentThreadId ? String(item.agentThreadId).toLowerCase() : null;
        if (!id) return [];
        if (item.kind === 'started') {
            if (this.agents.has(id)) return [];
            this.agents.set(id, taskNameOf(item.agentPath) || 'subagent');
            return [{ type: 'task', id, state: 'started', taskType: 'agent' },
                { type: 'tool-start', id: item.id || id, name: TOOL.subagent,
                    label: `Started a subagent: ${this.agents.get(id)}` }];
        }
        if (item.kind !== 'completed' && item.kind !== 'interrupted') return [];
        if (!this.agents.has(id)) return [];
        // Kept as a known child, so its last notifications are still not ours;
        // `finished` is what says it has been reported.
        if (this.finished.has(id)) return [];
        this.finished.add(id);
        return [{ type: 'task', id, state: 'done', taskType: 'agent' },
            { type: 'agent-done', taskId: id, toolUseId: id,
                status: item.kind === 'completed' ? 'completed' : 'interrupted', summary: null, durationMs: null }];
    }

    /**
     * What a spawned agent's own thread said. Its turn is not ours to start or
     * end; its items are only what it is doing, which the activity line shows
     * while the parent waits on it.
     */
    _child(method, p) {
        // An agent spawned by an agent: a child of this connection too.
        const item = p.item || {};
        if (item.type === 'subAgentActivity' && item.agentThreadId) {
            const id = String(item.agentThreadId).toLowerCase();
            if (item.kind === 'started' && method === 'item/started') this.agents.set(id, taskNameOf(item.agentPath) || 'subagent');
            return [];
        }
        if (method === 'item/completed' && p.item && p.item.id) {
            return [{ type: 'tools-done', ids: [`${p.threadId}:${p.item.id}`] }];
        }
        if (method !== 'item/started') return [];
        const d = describeItem(p.item);
        const who = this.agents.get(String(p.threadId).toLowerCase());
        return d && who ? [{ type: 'tool-start', id: `${p.threadId}:${p.item.id}`, name: d.name,
            label: `${who}: ${d.label}` }] : [];
    }

    turn(entry, { handOver }) {
        const id = `cx_${++this.seq}`;
        this.own.set(id, { kind: handOver ? 'steer' : 'start', uuid: entry.uuid });
        const input = inputFor(entry, (name) => codexSkills.lookup(this.cwd, name));
        if (handOver) {
            return { id, method: 'turn/steer', params: {
                threadId: this.threadId, expectedTurnId: this.turnId || '', input,
                clientUserMessageId: entry.uuid } };
        }
        const s = settingsFor(this.mode);
        const params = {
            threadId: this.threadId, input, clientUserMessageId: entry.uuid,
            approvalPolicy: s.approvalPolicy,
            sandboxPolicy: POLICY[s.sandbox],
            approvalsReviewer: s.reviewer,
            ...(this.effort && { effort: this.effort }),
        };
        // Plan mode is a collaboration mode, and `settings.model` is required in
        // it. Leaving plan mode says so once; otherwise none is sent, which keeps
        // whatever developer instructions the thread was started with.
        const plan = this.mode === 'plan';
        if ((plan || this.wasPlan) && this.model) {
            params.collaborationMode = { mode: plan ? 'plan' : 'default',
                settings: { model: this.model, ...(this.effort && { reasoning_effort: this.effort }) } };
        }
        this.wasPlan = plan;
        return { id, method: 'turn/start', params };
    }

    request(id, verb, payload = {}) {
        this.verbs.set(id, verb);
        return { id, method: verb, params: payload };
    }

    /**
     * The answer on the wire. Null for a followUp ask, which is answered by the
     * next turn instead, and writes nothing.
     */
    answer(ask, { behavior, choice, answers }) {
        if (ask.followUp) return null;
        this.answered.add(ask.id);
        const id = ask.rpcId !== undefined ? ask.rpcId
            : /^\d+$/.test(ask.id) ? Number(ask.id) : ask.id;
        if (ask.kind === 'question') {
            return { id, result: { answers: Object.fromEntries((behavior === 'allow' && answers || [])
                .filter(a => a.id != null).map(a => [a.id, { answers: a.answers }])) } };
        }
        if (ask.tool === 'permissions') {
            const grant = behavior === 'allow' && choice && choice.raw;
            return { id, result: grant
                ? { permissions: ask.input.permissions || {}, scope: grant }
                : { permissions: {}, scope: 'turn' } };
        }
        const decision = choice ? choice.raw : behavior === 'allow' ? 'accept' : 'decline';
        return { id, result: { decision } };
    }

    refuse(ev) {
        return { id: ev.id, error: { code: -32601, message: `tgxcode does not handle ${ev.method}` } };
    }

    async interrupt() {
        // Without a turn id there is nothing to name. Not a refusal — that would
        // turn interrupts off for every session in the pool — so the runner falls
        // back to ending the process, which a resume recovers from.
        if (!this.turnId) throw Object.assign(new Error('no Codex turn to interrupt yet'), { reason: 'timeout' });
        try {
            return await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
        } catch (err) {
            // The turn ended first (a `cancel` answer ends it too): that is stopped.
            if (err && err.reason === 'refused' && /no active turn|not found|not running|already/i.test(err.message)) {
                return {};
            }
            throw err;
        }
    }

    // Codex cannot take back a steered message.
    async withdraw() { return false; }

    // Sent on the next turn/start, as every turn's are (D5). Nothing to ask.
    setPermissionMode(mode) {
        this.mode = mode;
        return Promise.resolve({});
    }

    classifyExit(stderr, code) {
        const text = String(stderr || '').trim();
        if (/ENOENT|command not found|not found/i.test(text) && /codex/i.test(text)) {
            return { kind: 'no-codex', message: 'Could not find the `codex` command. Check that Codex is installed and on PATH.' };
        }
        if (/not logged in|login required|401 Unauthorized/i.test(text)) {
            return { kind: 'codex-signed-out', message: 'Codex is not signed in. Run `codex login` in a terminal.' };
        }
        const tail = text.split('\n').filter(Boolean).slice(-4).join('\n');
        return { kind: 'unknown', message: tail || `codex exited with code ${code}` };
    }

    argvRefusal() { return null; }

    usageLimit(info, failed, detail) {
        if (!failed || !/usage limit|usageLimitExceeded|hit your .*limit/i.test(String(detail || ''))) return null;
        return { resetsAt: null, window: null };
    }
}

module.exports = {
    Adapter: CodexAdapter, CodexAdapter,
    MODES, POLICY, THREAD_CONFIG,
    decisionOf, unwrapCommand, describeItem, inputFor, questionsFrom, asyncQuestionsFrom, codexEnv, versionOf,
};
