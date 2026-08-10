'use strict';

// Drives `claude` processes on behalf of the UI.
//
// Each conversation the user is chatting with gets one long-lived process
// started with `--input-format stream-json --output-format stream-json`. That
// keeps the session warm across turns: send a JSON line on stdin, read events
// off stdout. Resuming reuses the original session id and appends to the same
// transcript, so a session driven from here is indistinguishable on disk from
// one driven from a terminal.
//
// Note on content: the UI does *not* render from this stream. It renders from
// the transcript file, which the index tails — that way a session running in
// somebody's terminal looks exactly like one this app started. What the runner
// contributes is liveness: is a turn in flight, which tool is executing, did the
// process die. Keeping the two concerns apart avoids de-duplicating the same
// message from two sources.
//
// The same stream is also used *backwards*, as a control channel. Alongside the
// user turns we write, `claude` and the bridge exchange correlated
// control_request/control_response pairs. Two of them matter here:
//
//   can_use_tool  — inbound. The CLI is asking whether a tool call may run.
//                   Without an answer it blocks, which is what makes a real
//                   approval prompt possible instead of the silent denial
//                   headless mode does by default. Enabled by
//                   `--permission-prompt-tool stdio`.
//   interrupt     — outbound. Ends the turn where it stands without killing the
//                   process, so the session stays resumable and no tool result
//                   is left half-written.
//
// A permission ask is state about a turn, not content of it, so it lives here
// next to the other liveness state and never goes near the transcript. The real
// record of what was allowed or denied still arrives from the file.
//
// None of this is a documented, stable surface, so every part of it is written
// to degrade rather than break: an unrecognised subtype is answered and ignored,
// a CLI that rejects the flag falls back to permission modes alone, and an
// interrupt that does not land falls through to the signal path.

const fs = require('fs');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');

const { CLAUDE_BIN } = require('./config');
const { describeTool } = require('./transcript');

// Processes are cheap to restart (resume is a warm cache hit), so don't hoard them.
const MAX_LIVE = 4;
const IDLE_EVICT_MS = 15 * 60 * 1000;

const PERMISSION_MODES = ['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'bypassPermissions'];

// How long an approval card may sit unanswered before the ask is denied for you.
// A blocked turn holds a process open indefinitely otherwise, and the person who
// would have answered may have closed the window hours ago.
const PERMISSION_TIMEOUT_MS =
    Number(process.env.CLAUDE_SESSIONS_PERMISSION_TIMEOUT_MS) || 120_000;

// Requests we make of the CLI, where no answer means the version in front of us
// does not speak this part of the protocol. Short, because every one of them has
// a working fallback.
const CONTROL_TIMEOUT_MS = 8_000;

// Denying forever is a spin: the model retries, gets denied, retries. Stop the
// turn instead and say why.
const MAX_AUTO_DENIES = 2;

class Runner extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.sessionId
     * @param {string} opts.cwd
     * @param {boolean} opts.isNew   start a fresh session rather than resuming
     * @param {{permissionPrompt:boolean, interrupt:boolean}} [opts.caps]
     *   What this `claude` build has been observed to support. Shared across the
     *   pool, so one runner discovering a gap spares the rest from rediscovering
     *   it.
     */
    constructor(opts) {
        super();
        this.sessionId = opts.sessionId;
        this.cwd = opts.cwd;
        this.isNew = !!opts.isNew;
        this.model = opts.model || null;
        this.permissionMode = opts.permissionMode || 'acceptEdits';
        // Branch off a copy instead of continuing in place. Needed when the
        // original is already live somewhere else.
        this.fork = !!opts.fork;
        this.errorKind = null;
        this.retry = null;             // set while the CLI is retrying the API

        this.proc = null;
        this.state = 'stopped';        // stopped | starting | idle | busy | error
        this.activity = null;          // human-readable "what is it doing right now"
        this.lastError = null;
        this.lastResult = null;        // {costUsd, durationMs, numTurns, isError}
        this.lastUsedAt = Date.now();
        this.queue = [];               // prompts sent before the process was ready
        this.inFlight = [];            // written to the process, not yet answered
        this._buf = '';
        this._stderr = '';
        this._pendingTools = new Map();

        // -- control channel ------------------------------------------------
        this.caps = opts.caps || { permissionPrompt: true, interrupt: true };
        /** Is anyone actually in a position to answer an approval card? */
        this.hasViewer = opts.hasViewer || (() => false);
        /** @type {null | {id:string, tool:string, input:object, askedAt:number, expiresAt:number}} */
        this.pendingPermission = null;
        this._ctlSeq = 0;
        this._pending = new Map();     // request_id -> {resolve, reject, timer}
        // Tools the user said yes to for the rest of this session. The CLI is
        // told too (destination "session"), so this only does work after a
        // process restart, when the CLI's own copy is gone and ours is not.
        this._sessionAllow = new Set();
        this._autoDenies = 0;
    }

    // -- lifecycle ---------------------------------------------------------

    start() {
        if (this.proc) return;

        const args = [
            '-p',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', this.permissionMode,
        ];
        // The whole point of the control channel: route "may I?" back to us
        // instead of letting headless mode answer "no" on the user's behalf.
        // `stdio` is the CLI's sentinel for "ask over this stream" rather than
        // the name of an MCP tool.
        if (this.caps.permissionPrompt) args.push('--permission-prompt-tool', 'stdio');
        if (this.isNew) args.push('--session-id', this.sessionId);
        else args.push('--resume', this.sessionId);
        if (this.fork) args.push('--fork-session');
        if (this.model) args.push('--model', this.model);

        this._setState('starting', 'Starting Claude…');

        try {
            this.proc = spawn(CLAUDE_BIN, args, {
                cwd: this.cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-sessions' },
                // Its own process group, so a Ctrl-C aimed at the bridge is not
                // also delivered to a turn in flight; it gets to shut down on
                // stdin EOF instead of being interrupted mid-write.
                //
                // This does not make a turn outlive the bridge, and nothing can:
                // `claude` reads stdin for input, so when the bridge exits and
                // the pipe closes it treats that as end-of-input and stops. That
                // is exactly why the everyday instance runs on its own port —
                // see CLAUDE.md.
                detached: true,
            });
        } catch (err) {
            this.lastError = `Could not start ${CLAUDE_BIN}: ${err.message}`;
            this._setState('error', null);
            return;
        }

        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
        this.proc.stderr.setEncoding('utf8');
        this.proc.stderr.on('data', (chunk) => {
            this._stderr = (this._stderr + chunk).slice(-4000);
        });

        this.proc.on('error', (err) => {
            this.lastError = err.message;
            this._setState('error', null);
        });

        this.proc.on('close', (code) => {
            this.proc = null;
            this._pendingTools.clear();
            this._abandonControl('the Claude process exited');
            if (this._stopping) {
                this._stopping = false;
                this._setState('stopped', null);
            } else if (code === 0) {
                this._setState('stopped', null);
            } else {
                const raw = this._stderr.trim();

                // A build that does not know the flag rejects it before doing
                // any work. Drop approval prompts for the rest of the bridge's
                // life rather than letting a protocol difference break sending,
                // and put the turn back on the queue so nothing is lost.
                if (this.caps.permissionPrompt && /permission-prompt-tool/i.test(raw)) {
                    this.caps.permissionPrompt = false;
                    this.queue = this.inFlight.concat(this.queue);
                    this.inFlight.length = 0;
                    this._stderr = '';
                    this.emit('notice', {
                        level: 'warn', kind: 'no_permission_prompt',
                        text: 'This Claude Code version does not support approval prompts here — '
                            + 'using permission mode only.',
                    });
                    this.emit('exit', code);
                    this.start();
                    return;
                }

                const classified = classifyError(raw, code);
                this.errorKind = classified.kind;
                this.lastError = classified.message;
                // The turn never started, so whatever the user typed was never
                // recorded anywhere. Hand it back so the UI can restore it.
                this.emit('failed', {
                    kind: classified.kind,
                    message: classified.message,
                    unsent: this.inFlight.concat(this.queue),
                });
                this.inFlight.length = 0;
                this.queue.length = 0;
                this._setState('error', null);
            }
            this.emit('exit', code);
        });

        // The handshake the Agent SDK opens with. We need nothing from the
        // reply, but a CLI that expects a client to announce itself gets what it
        // is waiting for, and a round trip completing tells us the channel works
        // in both directions before anything depends on it.
        this._control('initialize', {}).catch(() => { /* older build; the fallbacks cover it */ });

        // The process is ready for input immediately; `system/init` confirms it.
        this._setState('idle', null);
        this._flushQueue();
    }

    /** Queue or deliver a user turn. Starts the process if it isn't running. */
    send(text) {
        this.lastUsedAt = Date.now();
        this.queue.push(text);
        if (!this.proc) this.start();
        else this._flushQueue();
    }

    _flushQueue() {
        if (!this.proc || !this.proc.stdin.writable) return;
        while (this.queue.length) {
            const text = this.queue.shift();
            const line = JSON.stringify({
                type: 'user',
                message: { role: 'user', content: [{ type: 'text', text }] },
            }) + '\n';
            this.proc.stdin.write(line);
            // Held until a result arrives: if the process dies first, this text
            // was never written to the transcript and would otherwise be lost.
            this.inFlight.push(text);
            this._setState('busy', 'Thinking…');
        }
    }

    /**
     * End the current turn.
     *
     * The soft path asks the CLI to interrupt itself: the turn stops where it
     * is, the process stays alive, and the session is resumable with nothing
     * half-written. The hard path is the old behaviour — SIGTERM, then SIGKILL —
     * which ends the turn wherever it happens to be, possibly mid-tool-call.
     *
     * Soft is tried first and falls through to hard if the CLI does not answer,
     * so this never becomes a way to fail to stop something.
     *
     * @returns {Promise<{ok:boolean, how:'soft'|'hard'|null}>}
     */
    async stop({ hard = false } = {}) {
        if (!this.proc) return { ok: false, how: null };

        // An unanswered ask is holding the turn open. Whichever path we take, it
        // has to be answered first — the CLI is blocked waiting on us and will
        // not process an interrupt until it is unblocked.
        if (this.pendingPermission) {
            const ask = this.pendingPermission;
            this._respondPermission(ask, {
                behavior: 'deny',
                message: 'Stopped from Claude Sessions before this was approved.',
            });
            this._clearPermission('stopped');
        }

        if (!hard && this.caps.interrupt) {
            this.queue.length = 0;
            try {
                await this._control('interrupt', { cancel_queued: true });
                // Leave the state alone: the CLI answers an interrupt with a
                // `result` like any other turn ending, and that is what should
                // move us back to idle.
                return { ok: true, how: 'soft' };
            } catch {
                // Either this build has no interrupt or it did not answer in
                // time. Stop asking, and stop it the way that always works.
                this.caps.interrupt = false;
            }
        }

        // Awaiting the interrupt gave the process time to exit on its own — a
        // failed interrupt and a dead process look the same from here. There is
        // nothing left to signal.
        if (!this.proc) return { ok: true, how: 'soft' };

        this._stopping = true;
        this.queue.length = 0;
        try { this.proc.stdin.end(); } catch { /* already closed */ }
        const proc = this.proc;
        // Give it a moment to exit gracefully, then insist.
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 1500).unref();
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        return { ok: true, how: 'hard' };
    }

    // -- control channel ---------------------------------------------------

    _write(obj) {
        if (!this.proc || !this.proc.stdin.writable) return false;
        try {
            this.proc.stdin.write(JSON.stringify(obj) + '\n');
            return true;
        } catch {
            return false;
        }
    }

    /** Outbound request; resolves with the CLI's response payload. */
    _control(subtype, payload = {}, { timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
        return new Promise((resolve, reject) => {
            const id = `req_${++this._ctlSeq}`;
            if (!this._write({
                type: 'control_request', request_id: id, request: { subtype, ...payload },
            })) {
                reject(new Error('the Claude process is not accepting input'));
                return;
            }
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`no answer to control request "${subtype}"`));
            }, timeoutMs);
            timer.unref();
            this._pending.set(id, { resolve, reject, timer });
        });
    }

    /** Fail every outstanding request; the channel they were riding on is gone. */
    _abandonControl(why) {
        for (const [, p] of this._pending) {
            clearTimeout(p.timer);
            p.reject(new Error(why));
        }
        this._pending.clear();
        // Nothing can answer it now, and nothing is waiting for the answer.
        if (this.pendingPermission) {
            clearTimeout(this.pendingPermission.timer);
            const { id } = this.pendingPermission;
            this.pendingPermission = null;
            this.emit('permission-resolved', {
                sessionId: this.sessionId, requestId: id, outcome: 'abandoned',
            });
        }
    }

    /**
     * An inbound request from the CLI.
     *
     * Only `can_use_tool` is ours to act on. Anything else is a newer CLI
     * expecting a client we are not — answer it with an error so it stops
     * waiting on us, and carry on.
     */
    _onControlRequest(msg) {
        const req = msg.request || {};
        if (req.subtype !== 'can_use_tool') {
            this._write({
                type: 'control_response',
                response: {
                    subtype: 'error', request_id: msg.request_id,
                    error: `claude-sessions does not handle the "${req.subtype}" control request`,
                },
            });
            return;
        }

        // Some MCP asks need a dialog of the server's own, which this channel
        // cannot carry. Offering Allow would be a lie — the call fails anyway —
        // so say what happened instead of pretending it was a choice.
        if (req.requires_user_interaction) {
            this._write({
                type: 'control_response',
                response: {
                    subtype: 'success', request_id: msg.request_id,
                    response: {
                        behavior: 'deny', toolName: req.tool_name,
                        message: 'This tool needs its own interactive prompt, which Claude '
                            + 'Sessions cannot show. Run it from a terminal.',
                    },
                },
            });
            this.emit('notice', {
                level: 'warn', kind: 'permission_uninteractive',
                text: `${req.tool_name} asked for an interactive prompt this app cannot show, `
                    + 'so it was denied. That tool needs a terminal.',
            });
            return;
        }

        const ask = {
            id: msg.request_id,
            tool: req.tool_name,
            displayName: req.display_name || req.tool_name,
            input: req.input || {},
            toolUseId: req.tool_use_id || null,
            description: req.description || null,
            reason: req.decision_reason || null,
            blockedPath: req.blocked_path || null,
            // A call made by a subagent, not by the session itself.
            agentId: req.agent_id || null,
            askedAt: Date.now(),
            expiresAt: Date.now() + PERMISSION_TIMEOUT_MS,
            timer: null,
        };

        // Said yes to this tool earlier in the session, before the process was
        // last restarted. The CLI has forgotten; we have not.
        if (this._sessionAllow.has(ask.tool)) {
            this._respondPermission(ask, {
                behavior: 'allow',
                updatedPermissions: sessionAllowRule(ask.tool),
            });
            return;
        }

        // Nothing is attached to answer, so the honest outcome is the one the
        // app produced before any of this existed: denied.
        if (!this.hasViewer()) {
            this._autoDeny(ask, 'No Claude Sessions window was open to approve this, so it was denied.');
            return;
        }

        // Only one ask can be outstanding per process, but be defensive: a
        // second would otherwise silently orphan the first.
        if (this.pendingPermission) {
            this._respondPermission(this.pendingPermission, {
                behavior: 'deny',
                message: 'Superseded by a later permission request.',
            });
            this._clearPermission('superseded');
        }

        ask.timer = setTimeout(
            () => this._autoDeny(ask, `Nobody answered within ${Math.round(PERMISSION_TIMEOUT_MS / 1000)}s, `
                + 'so it was denied.'),
            PERMISSION_TIMEOUT_MS);
        ask.timer.unref();

        this.pendingPermission = ask;
        this._setState('busy', `Waiting for you: ${ask.displayName}`);
        this.emit('permission-request', { sessionId: this.sessionId, ...publicAsk(ask) });
    }

    /**
     * Answer an outstanding ask. Called from the UI.
     *
     * @param {string} requestId
     * @param {'allow'|'allow-always'|'deny'} decision
     * @param {object} [updatedInput] edited tool input to run instead
     */
    answerPermission(requestId, decision, updatedInput) {
        const ask = this.pendingPermission;
        if (!ask) return { ok: false, error: 'nothing is waiting for approval' };
        // Two windows, one ask: the first answer wins and the second is told so
        // rather than silently doing nothing.
        if (ask.id !== requestId) return { ok: false, error: 'that request was already answered' };

        this.lastUsedAt = Date.now();
        this._autoDenies = 0;   // somebody is here; the spin guard can reset

        if (decision === 'deny') {
            this._respondPermission(ask, {
                behavior: 'deny', message: 'Denied from Claude Sessions.',
            });
        } else {
            const always = decision === 'allow-always';
            if (always) this._sessionAllow.add(ask.tool);
            this._respondPermission(ask, {
                behavior: 'allow',
                updatedInput: updatedInput && Object.keys(updatedInput).length ? updatedInput : null,
                updatedPermissions: always ? sessionAllowRule(ask.tool) : null,
            });
        }
        this._clearPermission(decision);
        return { ok: true };
    }

    _respondPermission(ask, { behavior, message, updatedInput, updatedPermissions }) {
        const response = { behavior, toolName: ask.tool };
        if (behavior === 'allow' && updatedInput) response.updatedInput = updatedInput;
        if (behavior === 'deny') response.message = message || 'Denied from Claude Sessions.';
        if (updatedPermissions) response.updatedPermissions = updatedPermissions;
        this._write({
            type: 'control_response',
            response: { subtype: 'success', request_id: ask.id, response },
        });
    }

    _clearPermission(outcome) {
        const ask = this.pendingPermission;
        if (!ask) return;
        clearTimeout(ask.timer);
        this.pendingPermission = null;
        this.emit('permission-resolved', {
            sessionId: this.sessionId, requestId: ask.id, outcome,
        });
        // The tool is about to run (or not); either way we are back to working.
        if (this.state === 'busy') this._setState('busy', 'Thinking…');
    }

    _autoDeny(ask, reason) {
        this._autoDenies++;
        this._respondPermission(ask, { behavior: 'deny', message: reason });
        if (this.pendingPermission && this.pendingPermission.id === ask.id) {
            this._clearPermission('auto-denied');
        }
        this.emit('notice', { level: 'warn', kind: 'permission_auto_denied', text: reason });

        if (this._autoDenies >= MAX_AUTO_DENIES) {
            this._autoDenies = 0;
            this.emit('notice', {
                level: 'warn', kind: 'permission_auto_denied',
                text: `${MAX_AUTO_DENIES} tool calls in a row were denied with nobody to approve `
                    + 'them, so the turn was stopped rather than left to spin.',
            });
            this.stop().catch(() => { /* the hard path already ran */ });
        }
    }

    /**
     * Stop managing the process without signalling it.
     *
     * Used when the bridge is going away mid-turn. It buys the process a chance
     * to wind down on its own as our stdin pipe closes, rather than being killed
     * outright — but it does not save the turn. Nothing can: `claude` reads
     * stdin for input, so the pipe closing when we exit is end-of-input and it
     * stops there. Protecting work means not killing the bridge in the first
     * place, which is what the separate development port is for.
     */
    detach() {
        if (!this.proc) return;
        const proc = this.proc;
        this.proc = null;
        this._abandonControl('the bridge stopped managing this process');
        try { proc.unref(); } catch { /* already gone */ }
        this._setState('stopped', null);
    }

    /** Close stdin so the process exits once the current turn finishes. */
    retire() {
        if (!this.proc) return;
        this._stopping = true;
        try { this.proc.stdin.end(); } catch { /* already closed */ }
    }

    // -- stream ------------------------------------------------------------

    _onStdout(chunk) {
        this._buf += chunk;
        let i;
        while ((i = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, i);
            this._buf = this._buf.slice(i + 1);
            if (!line.trim()) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                // stderr shares this stream now, so anything that is not an
                // event is diagnostic text — and it is what classifyError reads
                // to tell "already running elsewhere" from a generic failure.
                this._stderr = (this._stderr + line + '\n').slice(-4000);
                continue;
            }
            this._onMessage(msg);
        }
    }

    _onMessage(msg) {
        switch (msg.type) {
            case 'control_request':
                this._onControlRequest(msg);
                break;

            case 'control_response': {
                const r = msg.response || {};
                const p = this._pending.get(r.request_id);
                if (!p) break;
                this._pending.delete(r.request_id);
                clearTimeout(p.timer);
                if (r.subtype === 'error') p.reject(new Error(r.error || 'the request was refused'));
                else p.resolve(r.response || {});
                break;
            }

            case 'control_cancel_request': {
                // The CLI withdrew an ask — usually because the turn it belonged
                // to ended. Take the card down rather than leaving a dead one on
                // screen with a countdown running.
                const id = msg.request_id || (msg.request && msg.request.request_id);
                if (this.pendingPermission && this.pendingPermission.id === id) {
                    this._clearPermission('cancelled');
                }
                break;
            }

            case 'system':
                if (msg.subtype === 'init') {
                    // A resumed session keeps its id; a fork gets a new one, and
                    // the UI has to follow it or the user is left watching a
                    // transcript that will never move again.
                    if (msg.session_id && msg.session_id !== this.sessionId) {
                        const from = this.sessionId;
                        this.sessionId = msg.session_id;
                        this.emit('forked', { from, to: msg.session_id });
                    }
                    this.emit('init', msg);
                } else if (msg.subtype === 'permission_denied') {
                    this.emit('notice', {
                        level: 'warn', kind: 'permission_denied',
                        text: msg.content || 'A tool call was denied by the permission mode.',
                    });
                } else if (msg.subtype === 'api_retry') {
                    // The CLI retries a failing API call up to ten times with
                    // exponential backoff, which can run for several minutes.
                    // Without this the UI just says "Thinking" the whole time and
                    // the user has no idea anything is wrong, or that stopping is
                    // an option.
                    this.retry = {
                        attempt: msg.attempt,
                        max: msg.max_retries,
                        status: msg.error_status || null,
                        at: Date.now(),
                    };
                    this._setState('busy',
                        `Can't reach the API — retry ${msg.attempt} of ${msg.max_retries}`);
                    // One notice, not ten.
                    if (msg.attempt === 1) {
                        this.emit('notice', {
                            level: 'warn', kind: 'api_retry',
                            text: 'Trouble reaching the Anthropic API. Claude is retrying; '
                                + 'this can take several minutes before it gives up.',
                        });
                    }
                }
                break;

            case 'assistant': {
                const content = (msg.message && msg.message.content) || [];
                for (const b of content) {
                    if (b.type === 'tool_use') {
                        this._pendingTools.set(b.id, b.name);
                        this._setState('busy', describeTool(b));
                    } else if (b.type === 'text' && b.text.trim()) {
                        this._setState('busy', 'Writing…');
                    } else if (b.type === 'thinking') {
                        this._setState('busy', 'Thinking…');
                    }
                }
                break;
            }

            case 'user': {
                const content = (msg.message && msg.message.content) || [];
                for (const b of content) {
                    if (b.type !== 'tool_result') continue;
                    this._pendingTools.delete(b.tool_use_id);
                }
                if (this.state === 'busy') this._setState('busy', 'Thinking…');
                break;
            }

            case 'result': {
                // A turn that ends in an API error still counts as "finished" to
                // the CLI, so say what went wrong rather than quietly going idle.
                const failed = !!msg.is_error;
                const detail = typeof msg.result === 'string' ? msg.result : '';
                this.lastResult = {
                    isError: failed,
                    detail: failed ? detail.slice(0, 300) : null,
                    retries: this.retry ? this.retry.attempt : 0,
                    costUsd: msg.total_cost_usd || 0,
                    durationMs: msg.duration_ms || msg.duration_api_ms || 0,
                    numTurns: msg.num_turns || 0,
                    stopReason: msg.stop_reason || null,
                };
                this._pendingTools.clear();
                this.inFlight.length = 0;   // safely in the transcript now
                this.retry = null;
                this._autoDenies = 0;       // a finished turn is not a spin
                this._setState('idle', null);
                if (failed) {
                    this.emit('notice', {
                        level: 'warn', kind: 'turn_failed',
                        text: detail || 'The turn ended with an error.',
                    });
                }
                this.emit('turn-complete', this.lastResult);
                break;
            }

            case 'rate_limit_event':
                if (msg.rate_limit_info && msg.rate_limit_info.status !== 'allowed') {
                    this.emit('notice', {
                        level: 'warn', kind: 'rate_limit',
                        text: `Rate limit: ${msg.rate_limit_info.status}`,
                    });
                }
                break;
        }
    }

    _setState(state, activity) {
        const changed = this.state !== state || this.activity !== activity;
        // Stamped once per turn, not on every activity change, so the elapsed
        // time the UI shows covers the whole turn.
        if (state === 'busy' && this.state !== 'busy') this.busySince = Date.now();
        if (state !== 'busy') this.busySince = null;
        this.state = state;
        this.activity = activity;
        if (changed) this.emit('status', this.status());
    }

    status() {
        return {
            sessionId: this.sessionId,
            state: this.state,
            activity: this.activity,
            model: this.model,
            permissionMode: this.permissionMode,
            cwd: this.cwd,
            error: this.lastError,
            errorKind: this.errorKind,
            retry: this.retry,
            lastResult: this.lastResult,
            queued: this.queue.length,
            // A window opening onto a session that is already blocked on an ask
            // has to be able to draw the card without having seen the event.
            pendingPermission: this.pendingPermission ? publicAsk(this.pendingPermission) : null,
            canPrompt: this.caps.permissionPrompt,
            // Lets the UI show how long a turn has been going, which matters
            // when the API is being retried for minutes at a time.
            busySince: this.state === 'busy' ? this.busySince : null,
        };
    }
}

/** The ask as the UI sees it — no timer handle, nothing it cannot serialise. */
function publicAsk(ask) {
    return {
        requestId: ask.id,
        tool: ask.tool,
        displayName: ask.displayName,
        input: ask.input,
        toolUseId: ask.toolUseId,
        description: ask.description,
        reason: ask.reason,
        blockedPath: ask.blockedPath,
        agentId: ask.agentId,
        askedAt: ask.askedAt,
        expiresAt: ask.expiresAt,
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

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

class RunnerPool extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, Runner>} */
        this.runners = new Map();
        this._sweep = setInterval(() => this._evictIdle(), 60_000);
        this._sweep.unref();

        // What this `claude` build turned out to support, learned once and
        // shared: a runner that discovers a gap saves every later one from
        // rediscovering it the same expensive way.
        this.caps = { permissionPrompt: true, interrupt: true };

        // Replaced by the server with the real answer. Whether anything is
        // listening decides between blocking on a person and denying, so
        // guessing "yes" here would hang turns nobody is watching.
        this.hasViewer = () => false;
    }

    get(sessionId) {
        return this.runners.get(sessionId) || null;
    }

    /** Existing runner for a session, or a new one bound to `cwd`. */
    ensure(sessionId, { cwd, model, permissionMode, isNew = false, fork = false } = {}) {
        let r = this.runners.get(sessionId);
        if (r) {
            // A mode, model or fork change only takes effect on a fresh process.
            const wants = { model: model ?? r.model, permissionMode: permissionMode ?? r.permissionMode };
            if (r.state !== 'busy'
                && (wants.model !== r.model || wants.permissionMode !== r.permissionMode
                    || fork !== r.fork || r.state === 'error')) {
                r.retire();
                this.runners.delete(sessionId);
                r = null;
            } else {
                return r;
            }
        }

        this._evictTo(MAX_LIVE - 1);

        r = new Runner({ sessionId, cwd, model, permissionMode, isNew, fork, caps: this.caps });
        // Read through `r.sessionId` rather than closing over the id it was
        // created with: a fork changes it, and the viewer check has to follow.
        r.hasViewer = () => this.hasViewer(r.sessionId);
        r.on('status', (s) => this.emit('status', s));
        r.on('notice', (n) => this.emit('notice', { sessionId: r.sessionId, ...n }));
        r.on('permission-request', (p) => this.emit('permission-request', p));
        r.on('permission-resolved', (p) => this.emit('permission-resolved', p));
        r.on('turn-complete', (res) => this.emit('turn-complete', { sessionId: r.sessionId, ...res }));
        r.on('failed', (f) => this.emit('failed', { sessionId: r.sessionId, ...f }));
        r.on('exit', () => this.emit('status', r.status()));
        r.on('forked', ({ from, to }) => {
            // Re-key so a later send reaches the copy, not the original.
            if (this.runners.get(from) === r) this.runners.delete(from);
            this.runners.set(to, r);
            this.emit('forked', { from, to });
        });
        this.runners.set(sessionId, r);
        return r;
    }

    /** Create a brand-new session and deliver its first prompt. */
    create({ cwd, model, permissionMode, prompt }) {
        if (!cwd || !fs.existsSync(cwd)) {
            throw new Error(`Working directory does not exist: ${cwd}`);
        }
        const sessionId = randomUUID();
        const r = this.ensure(sessionId, { cwd, model, permissionMode, isNew: true });
        r.send(prompt);
        return { sessionId, status: r.status() };
    }

    statuses() {
        const out = {};
        for (const [id, r] of this.runners) out[id] = r.status();
        return out;
    }

    _evictIdle() {
        const now = Date.now();
        for (const [id, r] of this.runners) {
            if (r.state === 'busy') continue;
            if (now - r.lastUsedAt < IDLE_EVICT_MS) continue;
            r.retire();
            this.runners.delete(id);
        }
    }

    _evictTo(limit) {
        const idle = [...this.runners.entries()]
            .filter(([, r]) => r.state !== 'busy')
            .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
        while (this.runners.size > limit && idle.length) {
            const [id, r] = idle.shift();
            r.retire();
            this.runners.delete(id);
        }
    }

    /**
     * Stand down.
     *
     * A turn in flight is left unsignalled rather than killed, so it can wind
     * down cleanly as our pipes close and whatever it already wrote stays in the
     * transcript. It will still stop — see Runner#detach — which is why killing
     * the bridge someone is using costs them work, and why development runs on
     * its own port.
     */
    shutdown({ force = false } = {}) {
        clearInterval(this._sweep);
        let left = 0;
        for (const r of this.runners.values()) {
            if (r.state === 'busy' && !force) { left++; r.detach(); continue; }
            // Hard, deliberately: the bridge is going away, so there is nobody
            // left to wait for a polite interrupt to be answered.
            r.stop({ hard: true });
        }
        this.runners.clear();
        return { stillRunning: left };
    }

    get busyCount() {
        let n = 0;
        for (const r of this.runners.values()) if (r.state === 'busy') n++;
        return n;
    }
}

module.exports = { RunnerPool, Runner, PERMISSION_MODES };
