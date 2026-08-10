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

const fs = require('fs');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');

const { CLAUDE_BIN } = require('./config');
const { describeTool } = require('./transcript');

// Queue entry ids only have to be unique per process; the UI never persists one.
let queueSeq = 0;

// Processes are cheap to restart (resume is a warm cache hit), so don't hoard them.
const MAX_LIVE = 4;
const IDLE_EVICT_MS = 15 * 60 * 1000;

const PERMISSION_MODES = ['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'bypassPermissions'];

class Runner extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.sessionId
     * @param {string} opts.cwd
     * @param {boolean} opts.isNew   start a fresh session rather than resuming
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
        // Messages waiting their turn: {id, text, at}. Held here rather than
        // written straight through, so they stay visible and cancellable — see
        // _flushQueue.
        this.queue = [];
        this.inFlight = [];            // written to the process, not yet answered
        this._buf = '';
        this._stderr = '';
        this._pendingTools = new Map();
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
            if (this._stopping) {
                this._stopping = false;
                this._setState('stopped', null);
            } else if (code === 0) {
                this._setState('stopped', null);
            } else {
                const raw = this._stderr.trim();
                const classified = classifyError(raw, code);
                this.errorKind = classified.kind;
                this.lastError = classified.message;
                // The turn never started, so whatever the user typed was never
                // recorded anywhere. Hand it back so the UI can restore it.
                this.emit('failed', {
                    kind: classified.kind,
                    message: classified.message,
                    unsent: this.inFlight.concat(this.queue.map(q => q.text)),
                });
                this.inFlight.length = 0;
                this.queue.length = 0;
                this._setState('error', null);
            }
            this.emit('exit', code);
        });

        // The process is ready for input immediately; `system/init` confirms it.
        this._setState('idle', null);
        this._flushQueue();
    }

    /**
     * Queue or deliver a user turn. Starts the process if it isn't running.
     * Returns the queue entry, so a caller can tell whether its message went
     * out immediately or is still waiting.
     */
    send(text) {
        this.lastUsedAt = Date.now();
        const entry = { id: `q${++queueSeq}`, text, at: Date.now() };
        this.queue.push(entry);
        if (!this.proc) this.start();
        else this._flushQueue();
        if (this.queue.includes(entry)) this._queueChanged();
        return entry;
    }

    /**
     * Hand the next message to the process, one turn at a time.
     *
     * The CLI would happily take several lines at once, but then they are gone:
     * nothing can be reordered or taken back, and there is no queue left for the
     * UI to show. So only one message is in flight at a time and the rest wait
     * here, where they can still be edited, reordered or dropped.
     */
    _flushQueue() {
        if (!this.proc || !this.proc.stdin.writable) return;
        if (this.state === 'busy' || this.inFlight.length) return;
        const entry = this.queue.shift();
        if (!entry) return;
        const line = JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: entry.text }] },
        }) + '\n';
        this.proc.stdin.write(line);
        // Held until a result arrives: if the process dies first, this text
        // was never written to the transcript and would otherwise be lost.
        this.inFlight.push(entry.text);
        this._setState('busy', 'Thinking…');
        // _setState only reports when the state or activity moved; a shorter
        // queue is news on its own.
        this._queueChanged();
    }

    /** Drop one waiting message. Returns it, or null if it already went out. */
    dequeue(id) {
        const i = this.queue.findIndex(q => q.id === id);
        if (i < 0) return null;
        const [entry] = this.queue.splice(i, 1);
        this._queueChanged();
        return entry;
    }

    /** Drop everything still waiting. Returns what was dropped. */
    clearQueue() {
        if (!this.queue.length) return [];
        const dropped = this.queue.slice();
        this.queue.length = 0;
        this._queueChanged();
        return dropped;
    }

    /**
     * Put the queue in the order given. Ids that are no longer waiting are
     * ignored, and anything the caller did not mention keeps its place at the
     * back — a message that flushed while the drag was in progress must not
     * take the rest of the queue with it.
     */
    reorder(ids) {
        const byId = new Map(this.queue.map(q => [q.id, q]));
        const next = [];
        for (const id of ids) {
            const entry = byId.get(id);
            if (entry && !next.includes(entry)) next.push(entry);
        }
        for (const entry of this.queue) if (!next.includes(entry)) next.push(entry);
        this.queue = next;
        this._queueChanged();
        return this.queue;
    }

    _queueChanged() {
        this.emit('status', this.status());
    }

    /**
     * End the current turn. The CLI has no mid-turn interrupt on this channel, so
     * this terminates the process; the transcript keeps everything written so far
     * and the session resumes cleanly on the next send.
     *
     * Anything still queued is dropped — stopping means stopping — but it is
     * handed back rather than binned, so the UI can return it to the composer.
     */
    stop() {
        if (!this.proc) return { ok: false, dropped: [] };
        this._stopping = true;
        const dropped = this.queue.slice();
        this.queue.length = 0;
        try { this.proc.stdin.end(); } catch { /* already closed */ }
        const proc = this.proc;
        // Give it a moment to exit gracefully, then insist.
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 1500).unref();
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        return { ok: true, dropped };
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
                this._setState('idle', null);
                // The turn that was holding the queue back has landed.
                this._flushQueue();
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
            // The messages themselves, not just a count: the composer renders one
            // chip per entry and needs the id to cancel or reorder it.
            // Every status event carries this, so it stays a list of what is
            // still waiting — the message being answered is on its way to the
            // transcript and is read from there like any other.
            queue: this.queue.map(q => ({ id: q.id, text: q.text, at: q.at })),
            // Lets the UI show how long a turn has been going, which matters
            // when the API is being retried for minutes at a time.
            busySince: this.state === 'busy' ? this.busySince : null,
        };
    }
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
    }

    get(sessionId) {
        return this.runners.get(sessionId) || null;
    }

    /** Existing runner for a session, or a new one bound to `cwd`. */
    ensure(sessionId, { cwd, model, permissionMode, isNew = false, fork = false } = {}) {
        let r = this.runners.get(sessionId);
        let carried = [];
        if (r) {
            // A mode, model or fork change only takes effect on a fresh process.
            const wants = { model: model ?? r.model, permissionMode: permissionMode ?? r.permissionMode };
            if (r.state !== 'busy'
                && (wants.model !== r.model || wants.permissionMode !== r.permissionMode
                    || fork !== r.fork || r.state === 'error')) {
                // A model or mode change replaces the process. Messages still
                // waiting belong to the user, not to the process, so they move
                // across rather than disappearing.
                carried = r.clearQueue();
                r.retire();
                this.runners.delete(sessionId);
                r = null;
            } else {
                return r;
            }
        }

        this._evictTo(MAX_LIVE - 1);

        r = new Runner({ sessionId, cwd, model, permissionMode, isNew, fork });
        r.on('status', (s) => this.emit('status', s));
        r.on('notice', (n) => this.emit('notice', { sessionId: r.sessionId, ...n }));
        r.on('turn-complete', (res) => this.emit('turn-complete', { sessionId: r.sessionId, ...res }));
        r.on('failed', (f) => this.emit('failed', { sessionId: r.sessionId, ...f }));
        r.on('exit', () => this.emit('status', r.status()));
        r.on('forked', ({ from, to }) => {
            // Re-key so a later send reaches the copy, not the original.
            if (this.runners.get(from) === r) this.runners.delete(from);
            this.runners.set(to, r);
            this.emit('forked', { from, to });
        });
        if (carried.length) {
            r.queue.push(...carried);
            r._queueChanged();
        }
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
            r.stop();
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
