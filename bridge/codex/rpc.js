'use strict';

// JSON-RPC 2.0 over a pair of byte streams, for `codex app-server`.
//
// Hand-written because the alternatives all fail the no-dependencies rule (see
// docs/plans/23-codex.md §Risks): `@openai/codex-sdk` wraps `codex exec`, which
// has no approval channel, and t3code's generated client depends on Effect. What
// the app-server needs is small: newline-delimited JSON, an id → promise map for
// what we ask, a handler table for what it asks us, and a policy for what we do
// not recognise.
//
// It is deliberately ignorant of processes: it takes a readable and a writable
// and nothing else.
//
// **The conversation's own process does not go through this.** Since Phase 1
// (bridge/runtimes/claude/process.js, whose header is the contract) the runner
// owns line framing and mints the ids of its correlated `rpc`, and an adapter
// only turns parsed objects into events and back. So a Codex adapter uses
// protocol.js and the message rules written down here, not a Connection. What
// a Connection is for is everything outside a conversation: the recorder and the
// replay test, and the short-lived app-server that model/list, account/read,
// account/rateLimits/read and config/read need for Settings and the quota meter.
// bridge/codex/README §Fit lists where the contract and Codex disagree.
//
// Decisions worth knowing before changing it:
//
//   - **Unknown notifications are logged once and dropped.** "Unknown" means not
//     in the `known` set the caller hands in (bridge/codex/protocol.js has the
//     list for the pinned version). The app-server adds notifications most
//     minors; a new one must not throw, must not reach the adapter as if it were
//     understood, and must not fill the log at one line per delta. One line per
//     method name, per connection, is the whole of its cost.
//   - **A server request with no handler is answered, not ignored.** Codex blocks
//     the turn on a request until it is answered, so silence is a hang. It gets
//     -32601, the same as JSON-RPC says a server should send us.
//   - **A handler may answer later.** Approval cards are answered by a person,
//     possibly after a bridge restart, by a bridge that never saw the request
//     arrive. So pending server requests are a public table (`pendingRequests`),
//     and `respond(id, …)` answers any of them, whether a handler is still
//     awaiting it or not. A handler that returns `DEFER` leaves the request in
//     that table for someone else to answer.
//   - **`serverRequest/resolved` removes a pending request.** Codex sends it when
//     a request it asked is no longer wanted (the turn was interrupted, a
//     reviewer answered it); it is the `control_cancel_request` of this protocol.
//     It is emitted as `resolved` after the entry is gone, so a card can be
//     withdrawn.
//   - **Ids we mint are integers from 1.** Ids the server mints are kept exactly
//     as they arrive, number or string, because they go back verbatim.
//   - **Closing rejects everything outstanding** with an `RpcClosedError`, so no
//     caller waits on a process that is gone.
//   - **Notifications are dispatched by onNotification(), never as events named
//     after their method.** One of them is called `error`.
//   - **`jsonrpc: "2.0"` is sent and not required.** Measured on 0.172.0: the
//     app-server omits it on everything it writes and accepts it on what we send.

const { EventEmitter } = require('events');

/** Returned by a server-request handler that will answer through respond() later. */
const DEFER = Symbol('codex-rpc-defer');

class RpcError extends Error {
    constructor(code, message, data) {
        super(message);
        this.name = 'RpcError';
        this.code = code;
        if (data !== undefined) this.data = data;
    }
}

class RpcClosedError extends Error {
    constructor(reason) {
        super(reason || 'connection closed');
        this.name = 'RpcClosedError';
    }
}

// The JSON-RPC 2.0 codes we send ourselves.
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

class Connection extends EventEmitter {
    /**
     * @param {object} o
     * @param {import('stream').Readable} o.input   what the server writes (its stdout)
     * @param {import('stream').Writable} o.output  what the server reads (its stdin)
     * @param {Iterable<string>} [o.known]  notification methods we understand; omit to accept all
     * @param {(line: string) => void} [o.log]  one line per oddity; defaults to console.warn
     * @param {number} [o.timeoutMs]  default per-request timeout, 0 for none
     */
    constructor({ input, output, known, log, timeoutMs = 0 } = {}) {
        super();
        this.input = input;
        this.output = output;
        this.known = known ? new Set(known) : null;
        this.log = log || ((line) => console.warn(line));
        this.timeoutMs = timeoutMs;
        this.nextId = 1;
        this.pending = new Map();          // our id → { resolve, reject, method, timer }
        this.pendingRequests = new Map();  // their id → { id, method, params, at }
        this.handlers = new Map();         // method → (params, req) => result | Promise | DEFER
        this.byMethod = new Map();         // notification method → Set of listeners
        this.warned = new Set();
        this.closed = false;
        this._buf = '';

        this._onData = (chunk) => this._feed(chunk);
        this._onEnd = () => this.close('input ended');
        input.on('data', this._onData);
        input.on('end', this._onEnd);
        input.on('close', this._onEnd);
        input.on('error', (e) => this.close('input error: ' + e.message));
        output.on('error', (e) => this.close('output error: ' + e.message));
    }

    /** Ask the server something. Resolves with `result`, rejects with an RpcError. */
    request(method, params, { timeoutMs = this.timeoutMs } = {}) {
        if (this.closed) return Promise.reject(new RpcClosedError(this.closeReason));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, method, timer: null };
            if (timeoutMs > 0) {
                entry.timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new RpcError(INTERNAL_ERROR, `${method} timed out after ${timeoutMs} ms`));
                }, timeoutMs);
                entry.timer.unref?.();
            }
            this.pending.set(id, entry);
            this._write(params === undefined ? { jsonrpc: '2.0', id, method }
                : { jsonrpc: '2.0', id, method, params });
        });
    }

    /** Tell the server something; no answer comes back. */
    notify(method, params) {
        if (this.closed) return false;
        return this._write(params === undefined ? { jsonrpc: '2.0', method }
            : { jsonrpc: '2.0', method, params });
    }

    /**
     * Register the answer to a server request. The handler gets (params, req) and
     * returns the result, a promise of it, or DEFER. Throwing an RpcError sends
     * that error; throwing anything else sends -32603.
     */
    handle(method, fn) {
        this.handlers.set(method, fn);
        return this;
    }

    /**
     * Listen for one notification method. Returns the function that stops it.
     *
     * Not EventEmitter's `on(method)`: Codex has a notification called `error`, and
     * emitting that on an EventEmitter with no `error` listener throws — measured,
     * on the first signed-out turn, which is how this method came to exist.
     */
    onNotification(method, fn) {
        if (!this.byMethod.has(method)) this.byMethod.set(method, new Set());
        this.byMethod.get(method).add(fn);
        return () => this.byMethod.get(method)?.delete(fn);
    }

    /** Answer a pending server request by id. False if it is not pending. */
    respond(id, result) {
        if (!this.pendingRequests.delete(id)) return false;
        return this._write({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
    }

    /** Refuse a pending server request by id. */
    respondError(id, code, message, data) {
        if (!this.pendingRequests.delete(id)) return false;
        const error = { code, message };
        if (data !== undefined) error.data = data;
        return this._write({ jsonrpc: '2.0', id, error });
    }

    /** Stop reading, reject what is outstanding, emit `close` once. */
    close(reason) {
        if (this.closed) return;
        this.closed = true;
        this.closeReason = reason || 'closed';
        this.input.off('data', this._onData);
        this.input.off('end', this._onEnd);
        this.input.off('close', this._onEnd);
        for (const [, p] of this.pending) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(new RpcClosedError(`${p.method}: ${this.closeReason}`));
        }
        this.pending.clear();
        this.emit('close', this.closeReason);
    }

    _write(msg) {
        if (this.closed) return false;
        let line;
        try { line = JSON.stringify(msg); } catch (e) {
            this.log(`codex rpc: cannot encode ${msg.method || msg.id}: ${e.message}`);
            return false;
        }
        this.emit('send', msg);
        this.output.write(line + '\n');
        return true;
    }

    _feed(chunk) {
        this._buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let nl;
        while ((nl = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, nl).replace(/\r$/, '');
            this._buf = this._buf.slice(nl + 1);
            if (line.trim()) this._line(line);
            if (this.closed) return;
        }
    }

    _warnOnce(key, line) {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        this.log(line);
    }

    _line(line) {
        let msg;
        try { msg = JSON.parse(line); } catch {
            this._warnOnce('parse', `codex rpc: dropped a line that is not JSON: ${line.slice(0, 120)}`);
            return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            // Batches are JSON-RPC 2.0, but the app-server never sends one.
            this._warnOnce('shape', `codex rpc: dropped a message that is not an object`);
            return;
        }
        this.emit('message', msg);
        const hasId = msg.id !== undefined && msg.id !== null;
        if (typeof msg.method === 'string') {
            if (hasId) this._serverRequest(msg);
            else this._notification(msg);
        } else if (hasId) {
            this._response(msg);
        } else {
            this._warnOnce('shape', `codex rpc: dropped a message with neither method nor id`);
        }
    }

    _response(msg) {
        const p = this.pending.get(msg.id);
        if (!p) {
            this._warnOnce('orphan', `codex rpc: response to an id we are not waiting on (${msg.id})`);
            return;
        }
        this.pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) {
            const e = msg.error;
            p.reject(new RpcError(e.code, `${p.method}: ${e.message}`, e.data));
        } else {
            p.resolve(msg.result);
        }
    }

    _notification(msg) {
        const { method, params } = msg;
        if (method === 'serverRequest/resolved') {
            const id = params && params.requestId;
            const req = this.pendingRequests.get(id);
            this.pendingRequests.delete(id);
            this.emit('resolved', id, req || null, params);
        }
        if (this.known && !this.known.has(method)) {
            this._warnOnce('n:' + method, `codex rpc: ignoring notification ${method}, unknown to this build`);
            return;
        }
        this.emit('notification', method, params);
        const fns = this.byMethod.get(method);
        if (fns) for (const fn of [...fns]) fn(params);
    }

    _serverRequest(msg) {
        const { id, method, params } = msg;
        const req = { id, method, params, at: Date.now() };
        this.pendingRequests.set(id, req);
        const fn = this.handlers.get(method);
        if (!fn) {
            this._warnOnce('r:' + method, `codex rpc: no handler for server request ${method}; refusing it`);
            this.respondError(id, METHOD_NOT_FOUND, `client does not handle ${method}`);
            return;
        }
        this.emit('request', req);
        let out;
        try { out = fn(params, req); } catch (e) { return this._fail(id, e); }
        if (out === DEFER) return;
        Promise.resolve(out).then(
            (result) => { if (result !== DEFER) this.respond(id, result); },
            (e) => this._fail(id, e));
    }

    _fail(id, e) {
        if (e instanceof RpcError) this.respondError(id, e.code, e.message, e.data);
        else this.respondError(id, INTERNAL_ERROR, (e && e.message) || String(e));
    }
}

module.exports = {
    Connection, RpcError, RpcClosedError, DEFER,
    PARSE_ERROR, METHOD_NOT_FOUND, INTERNAL_ERROR,
};
