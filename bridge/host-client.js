'use strict';

// The bridge's side of bridge/host.js: a `claude` that lives in the host, dressed
// as a ChildProcess.
//
// bridge/runner.js was written against `child_process.spawn` and uses a small,
// definite part of what it returns — `stdin.write/end/writable`, `stdout` and
// `stderr` as utf8 streams, `kill(sig)`, `unref()`, and the `error` and `close`
// events. A HostChild is that surface and nothing more, so the runner's lifecycle
// code did not have to learn a second kind of process. What is different is where
// the pipes are: every write is a message to the host, every line of output one
// from it, and when this bridge exits the process on the far end keeps going.
//
// Using the host is never required. `ensureHost()` connects, starting a host if
// none answers; if that fails for any reason — the socket path is too long, the
// host speaks another protocol, it will not start — `spawnClaude()` hands back a
// plain child process and the bridge behaves exactly as it did before the host
// existed. Losing the host later is the same: the processes it held are gone (it
// owned their pipes), their runners see them exit, and the next spawn goes direct
// while a new host is started behind it.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { Writable, PassThrough } = require('stream');

const PROTOCOL = 1;
const HOST_SCRIPT = path.join(__dirname, 'host.js');

// sun_path is 108 bytes on Linux; past that, listen() fails with a message that
// names nothing useful. Measured against the path rather than left to fail.
const MAX_SOCKET_PATH = 100;

class HostConnection extends EventEmitter {
    constructor(socketPath) {
        super();
        this.socketPath = socketPath;
        this.sock = null;
        this.up = false;
        this.info = null;        // the host's hello: {protocol, pid, startedAt}
        this._seq = 0;
        this._waiting = new Map();
        /** @type {Map<string, HostChild>} */
        this.children = new Map();
        this._buf = '';
    }

    /** Resolves true once connected and greeted, false on any failure. */
    connect(timeoutMs = 1500) {
        return new Promise((resolve) => {
            const sock = net.connect(this.socketPath);
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
            const t = setTimeout(() => { sock.destroy(); done(false); }, timeoutMs);
            sock.on('error', () => done(false));
            sock.on('connect', async () => {
                this.sock = sock;
                sock.setEncoding('utf8');
                sock.on('data', (d) => this._onData(d));
                sock.on('close', () => this._onClose());
                this.up = true;
                try {
                    this.info = await this.request('hello');
                } catch {
                    sock.destroy();
                    return done(false);
                }
                if (this.info.protocol !== PROTOCOL) {
                    this.up = false;
                    sock.destroy();
                    return done(false);
                }
                this._ref();
                done(true);
            });
        });
    }

    request(op, payload = {}, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            if (!this.up) return reject(new Error('the session host is not connected'));
            const id = ++this._seq;
            const timer = setTimeout(() => {
                this._settle(id);
                reject(new Error(`the session host did not answer "${op}"`));
            }, timeoutMs);
            timer.unref();
            this._waiting.set(id, { resolve, reject, timer });
            this._ref();
            this.post({ id, op, ...payload });
        });
    }

    _settle(id) {
        const w = this._waiting.get(id);
        if (!w) return null;
        this._waiting.delete(id);
        clearTimeout(w.timer);
        this._ref();
        return w;
    }

    /**
     * Hold the event loop open exactly when a ChildProcess would: while an answer
     * is awaited, or while a process we are relaying has not been unref()'d. An
     * idle connection must not keep anything alive, and a busy one must — or a
     * caller awaiting a `close` exits with the promise unsettled.
     */
    _ref() {
        if (!this.sock) return;
        let held = this._waiting.size > 0;
        if (!held) for (const c of this.children.values()) if (!c._unrefd) { held = true; break; }
        if (held) this.sock.ref(); else this.sock.unref();
    }

    /** Fire and forget; ordered with everything else on this connection. */
    post(obj) {
        if (!this.up || !this.sock) return false;
        try { this.sock.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
    }

    _onData(chunk) {
        this._buf += chunk;
        let i;
        while ((i = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, i);
            this._buf = this._buf.slice(i + 1);
            let m;
            try { m = JSON.parse(line); } catch { continue; }
            if (m.re != null) {
                const w = this._settle(m.re);
                if (!w) continue;
                if (m.ok) w.resolve(m); else w.reject(new Error(m.error || 'refused'));
            } else if (m.ev) {
                const child = this.children.get(m.key);
                if (!child) continue;
                if (m.ev === 'data') child._data(m);
                else if (m.ev === 'exit') child._exit(m);
            }
        }
    }

    _onClose() {
        const wasUp = this.up;
        this.up = false;
        this.sock = null;
        for (const [, w] of this._waiting) { clearTimeout(w.timer); w.reject(new Error('the session host went away')); }
        this._waiting.clear();
        // The host owned their pipes, so they went with it.
        for (const child of this.children.values()) {
            child._exit({ code: null, signal: 'SIGHUP', error: null,
                note: 'The session host exited, and the Claude process it was holding went with it.' });
        }
        this.children.clear();
        if (wasUp) this.emit('lost');
    }
}

class HostChild extends EventEmitter {
    constructor(conn, key) {
        super();
        this.conn = conn;
        this.key = key;
        this.pid = undefined;
        this.hosted = true;
        this.lastSeq = 0;
        this._exited = false;
        this._released = false;
        this._unrefd = false;
        this.stdin = new Writable({
            decodeStrings: false,
            write: (chunk, _enc, cb) => {
                this.conn.post({ op: 'write', key: this.key, data: String(chunk) });
                cb();
            },
            final: (cb) => { this.conn.post({ op: 'end', key: this.key }); cb(); },
        });
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        conn.children.set(key, this);
        conn._ref();
    }

    kill(sig = 'SIGTERM') {
        if (this._exited) return false;
        return this.conn.post({ op: 'signal', key: this.key, sig });
    }

    unref() { this._unrefd = true; this.conn._ref(); }

    /** Leave an opaque record with the host, for whichever bridge adopts this next. */
    note(data) {
        if (this._exited || this._released) return;
        this.conn.post({ op: 'note', key: this.key, data });
    }

    /**
     * Stop listening, and leave the process running. What a bridge that is going
     * away does with a turn it would otherwise end.
     */
    release() {
        if (this._released) return;
        this._released = true;
        this.conn.post({ op: 'detach', key: this.key });
        this.conn.children.delete(this.key);
        this.conn._ref();
    }

    _data(m) {
        this.lastSeq = m.seq;
        (m.dir === 'err' ? this.stderr : this.stdout).write(m.data);
    }

    /**
     * Ends the streams and only then emits `close`, the order a real child keeps:
     * the runner's close handler reads what the process last said, and a `result`
     * line still sitting in the PassThrough would otherwise arrive after it.
     */
    _exit({ code, signal, error, note }) {
        if (this._exited) return;
        this._exited = true;
        this.conn.children.delete(this.key);
        this.conn._ref();
        if (note) this.stderr.write(note + '\n');
        if (error) this.emit('error', new Error(error));
        this.stdin.destroy();
        let open = 2;
        let fired = false;
        const fire = () => {
            if (fired) return;
            fired = true;
            this.emit('exit', code, signal);
            this.emit('close', code, signal);
        };
        const ended = () => { if (--open === 0) fire(); };
        this.stdout.once('end', ended);
        this.stderr.once('end', ended);
        this.stdout.end();
        this.stderr.end();
        // A stream nobody reads never ends. Nothing here should be unread, but a
        // close that never fires is a runner stuck forever, so do not rely on it.
        setTimeout(fire, 1000).unref();
    }
}

// --- module state -----------------------------------------------------------

let conn = null;
let options = null;      // what ensureHost was last asked for; null = never wanted
let starting = null;

function socketPathOk(p) {
    return typeof p === 'string' && Buffer.byteLength(p) <= MAX_SOCKET_PATH;
}

function launch({ socketPath, logFile }) {
    let out = 'ignore';
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        out = fs.openSync(logFile, 'a');
    } catch { /* unlogged is fine */ }
    // `detached` is setsid(2): its own session and process group, so neither a
    // Ctrl-C at the bridge's terminal nor the restart script's kill reaches it.
    const p = spawn(process.execPath, [HOST_SCRIPT, '--socket', socketPath], {
        detached: true, stdio: ['ignore', out, out], env: process.env,
    });
    p.unref();
    if (typeof out === 'number') { try { fs.closeSync(out); } catch { /* ignore */ } }
}

/**
 * Connect to the host for this bridge, starting one if nothing answers.
 *
 * Resolves true when sessions will run in the host from here on, false when they
 * will be spawned directly. Never rejects: not having a host is a supported way
 * to run, not an error.
 */
async function ensureHost({ socketPath, logFile, launchTimeoutMs = 4000 } = {}) {
    if (conn && conn.up) return true;
    if (starting) return starting;
    options = { socketPath, logFile, launchTimeoutMs };
    if (!socketPathOk(socketPath)) return false;
    starting = (async () => {
        try {
            fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
        } catch { /* connect will say */ }
        let c = new HostConnection(socketPath);
        if (!(await c.connect())) {
            launch({ socketPath, logFile });
            const deadline = Date.now() + launchTimeoutMs;
            let ok = false;
            while (!ok && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 100));
                c = new HostConnection(socketPath);
                ok = await c.connect(800);
            }
            if (!ok) return false;
        }
        c.on('lost', () => {
            if (conn === c) conn = null;
            // A new one behind it, for the next spawn after this one.
            setTimeout(() => { if (options) ensureHost(options).catch(() => {}); }, 500).unref();
        });
        conn = c;
        return true;
    })();
    try { return await starting; } finally { starting = null; }
}

/**
 * Start `claude` in the host if there is one, or as our own child if not.
 * Synchronous either way, like spawn(): the spawn request and any writes that
 * follow it travel on one ordered connection, so there is nothing to wait for.
 *
 * @returns {import('child_process').ChildProcess | HostChild}
 */
function spawnClaude(cmd, args, opts, sessionId) {
    if (!conn || !conn.up) {
        // Kick a reconnect, but do not wait on it: this spawn goes direct.
        if (options && !starting) ensureHost(options).catch(() => {});
        return spawn(cmd, args, opts);
    }
    // Unique per process, not per session: a runner replacing its process after a
    // mode change starts the new one before the old has finished exiting.
    const key = `${sessionId}.${randomUUID().slice(0, 8)}`;
    const child = new HostChild(conn, key);
    conn.request('spawn', {
        key, cmd, args, cwd: opts.cwd, env: opts.env || process.env,
    }, 10_000).then((r) => {
        child.pid = r.pid;
    }, (err) => {
        child._exit({ code: 1, signal: null, error: null, note: err.message });
    });
    return child;
}

/** Processes the host is still holding for us: what a starting bridge adopts. */
async function held() {
    if (!conn || !conn.up) return [];
    try {
        const { children } = await conn.request('list');
        return children;
    } catch {
        return [];
    }
}

/**
 * Take over a process a previous bridge left in the host.
 *
 * @returns {Promise<{child: HostChild, records: Array, note: *, noteSeq: number,
 *   lastSeq: number, exited: object|null}>}
 */
async function adopt(key) {
    if (!conn || !conn.up) throw new Error('the session host is not connected');
    const child = new HostChild(conn, key);
    let r;
    try {
        r = await conn.request('attach', { key, from: 0 }, 10_000);
    } catch (err) {
        conn.children.delete(key);
        throw err;
    }
    child.lastSeq = r.lastSeq;
    return { child, records: r.records, note: r.note, noteSeq: r.noteSeq,
        lastSeq: r.lastSeq, exited: r.exited };
}

/** Drop the host's record of a process that has already exited. */
function forget(key) {
    if (!conn || !conn.up) return Promise.resolve();
    return conn.request('forget', { key }).catch(() => {});
}

/** For /api/health: which host, if any, and how many processes it holds for us. */
function status() {
    if (!conn || !conn.up || !conn.info) return null;
    return { pid: conn.info.pid, protocol: conn.info.protocol, startedAt: conn.info.startedAt,
        attached: conn.children.size };
}

function connected() {
    return !!(conn && conn.up);
}

module.exports = {
    ensureHost, spawnClaude, held, adopt, forget, status, connected,
    HostConnection, HostChild, PROTOCOL,
};
