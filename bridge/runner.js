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
                    unsent: this.inFlight.concat(this.queue),
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
     * End the current turn. The CLI has no mid-turn interrupt on this channel, so
     * this terminates the process; the transcript keeps everything written so far
     * and the session resumes cleanly on the next send.
     */
    stop() {
        if (!this.proc) return false;
        this._stopping = true;
        this.queue.length = 0;
        try { this.proc.stdin.end(); } catch { /* already closed */ }
        const proc = this.proc;
        // Give it a moment to exit gracefully, then insist.
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 1500).unref();
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        return true;
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
            try { msg = JSON.parse(line); } catch { continue; }
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

            case 'result':
                this.lastResult = {
                    isError: !!msg.is_error,
                    costUsd: msg.total_cost_usd || 0,
                    durationMs: msg.duration_ms || msg.duration_api_ms || 0,
                    numTurns: msg.num_turns || 0,
                    stopReason: msg.stop_reason || null,
                };
                this._pendingTools.clear();
                this.inFlight.length = 0;   // safely in the transcript now
                this._setState('idle', null);
                this.emit('turn-complete', this.lastResult);
                break;

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
            lastResult: this.lastResult,
            queued: this.queue.length,
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

    shutdown() {
        clearInterval(this._sweep);
        for (const r of this.runners.values()) r.stop();
        this.runners.clear();
    }

    get busyCount() {
        let n = 0;
        for (const r of this.runners.values()) if (r.state === 'busy') n++;
        return n;
    }
}

module.exports = { RunnerPool, Runner, PERMISSION_MODES };
