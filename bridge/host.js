'use strict';

// The session host: the process that owns `claude`'s pipes, so the bridge does not
// have to.
//
// A turn ends when its bridge does. `claude` reads stdin for input, so the pipe
// closing when the bridge exits is end-of-input and it stops, mid-turn, however
// the process was spawned. That is measured, not assumed, and for a long time the
// only defence was not restarting: a separate development port, a restart script
// that refuses while anything is busy, a nightly restart that skips itself.
//
// This process is the other defence. It spawns `claude` on the bridge's behalf,
// holds both ends of its pipes, and relays them over a Unix socket. When the
// bridge goes away the socket closes, the pipes do not, and the turn carries on.
// A bridge that comes back lists what is still running, attaches, and is handed
// everything that was said while nobody was listening.
//
// **It knows nothing about what it relays, and that is the design.** No
// stream-json, no control requests, no idea what a turn or a permission is. Lines
// out, bytes in, an exit status, and one opaque note per child that the bridge
// writes and reads back. Everything that has to understand `claude` stays in
// bridge/runner.js, so a change in the CLI's protocol is a change there and never
// a change here. The point of that is the thing this file cannot escape:
// replacing it ends every turn it holds, exactly like restarting the bridge used
// to. So it has to be the part that almost never changes. Which is also why it
// requires nothing from the rest of bridge/ — an edit to config.js must never be
// a reason to restart the one process whose restart costs work.
//
// A new version still gets picked up, just never forcibly: the host exits on its
// own once it has held nothing for IDLE_EXIT_MS, and the next bridge to want one
// starts whatever is on disk. `hello` carries PROTOCOL, and a bridge that does not
// speak it spawns directly instead, exactly as it did before this existed.
//
// One host per bridge port — the socket is named for it — so a development bridge
// can never adopt, signal or even list the everyday instance's sessions. The
// socket is created 0600 in the bridge's state directory, and being able to
// connect to it is the whole of the authentication: anyone who can open that
// file can already read the token beside it.
//
// Protocol: newline-delimited JSON both ways.
//
//   → {id, op:'hello'}                          ← {re:id, ok, protocol, pid, startedAt}
//   → {id, op:'spawn', key, cmd, args, cwd, env} ← {re:id, ok, pid}   (and watches `key`)
//   → {op:'write', key, data}                   raw text for stdin; no reply
//   → {op:'end', key}                           close stdin; no reply
//   → {op:'signal', key, sig}                   no reply
//   → {op:'note', key, data}                    opaque, latest wins, stamped with the
//                                               child's current seq; no reply
//   → {id, op:'attach', key, from}              ← {re:id, ok, records, lastSeq, exited,
//                                                  note, noteSeq}, then live events
//   → {op:'detach', key}
//   → {id, op:'list'}                           ← {re:id, ok, children:[…]}
//   → {id, op:'forget', key}                    drop an exited child's record
//
//   ← {ev:'data', key, seq, dir:'out'|'err', data}
//   ← {ev:'exit', key, code, signal, error}
//
// Messages on one connection are handled in the order they arrive, which the
// bridge relies on: a note sent before a write is on record before the write
// reaches the child.

require('./legacy-env');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const PROTOCOL = 1;

// What is kept of each child's output for a bridge that was not there to hear it.
// A restart is seconds, so this only has to cover one turn's worth; a turn that
// out-talks it loses the front of the replay, and the runner reads the transcript
// for content in any case.
const LOG_BYTES = 8 * 1024 * 1024;

// An exited child is remembered this long, so a bridge that was down when it died
// still learns how it ended rather than finding nothing.
const EXITED_KEEP_MS = 10 * 60_000;

// A child nobody has attached to for this long is told its input is over, which
// is how `claude` is asked to exit. Only reachable when no bridge ever came back
// for it — a development bridge shut down for good, say — and without it that
// child would sit in the host indefinitely, holding a few hundred megabytes and
// keeping the host from ever idling out. Hours, not minutes: a bridge that is
// down is usually coming back, and a turn it left running should get to finish.
const ORPHAN_MS = Number(process.env.TGXCODE_HOST_ORPHAN_MS) || 6 * 60 * 60_000;

// Held nothing for this long: exit, and let the next bridge start a fresh copy.
// Both overridable so a test can watch it happen in a second rather than ten minutes.
const IDLE_EXIT_MS = Number(process.env.TGXCODE_HOST_IDLE_MS) || 10 * 60_000;
const IDLE_CHECK_MS = Math.min(30_000, IDLE_EXIT_MS, ORPHAN_MS);

function arg(name) {
    const i = process.argv.indexOf(name);
    return i < 0 ? null : process.argv[i + 1];
}

function log(...parts) {
    console.log(new Date().toISOString(), ...parts);
}

const SOCKET = arg('--socket');
if (!SOCKET) {
    console.error('usage: node bridge/host.js --socket <path>');
    process.exit(2);
}

const startedAt = Date.now();
let lastActivity = Date.now();

/**
 * @typedef {object} Child
 * @property {string} key
 * @property {import('child_process').ChildProcess} proc
 * @property {number|undefined} pid
 * @property {number} startedAt
 * @property {Array<{seq:number, dir:string, data:string}>} log
 * @property {number} logBytes
 * @property {number} seq
 * @property {string} outBuf
 * @property {null|{code:number|null, signal:string|null, error:string|null}} exited
 * @property {*} note
 * @property {number} noteSeq
 * @property {Set<net.Socket>} watchers
 * @property {number|null} unwatchedSince
 */

/** @type {Map<string, Child>} */
const children = new Map();

function send(conn, obj) {
    if (conn.destroyed) return;
    try { conn.write(JSON.stringify(obj) + '\n'); } catch { /* the close handler tidies up */ }
}

function record(child, dir, data) {
    const r = { seq: ++child.seq, dir, data };
    child.log.push(r);
    child.logBytes += data.length;
    while (child.logBytes > LOG_BYTES && child.log.length > 1) {
        child.logBytes -= child.log.shift().data.length;
    }
    for (const w of child.watchers) send(w, { ev: 'data', key: child.key, ...r });
}

/**
 * stdout is split at newlines so that every record is a whole line. A replay that
 * starts after the log was trimmed then starts on a line boundary, rather than
 * half-way through a JSON object the reader would take for diagnostic text.
 * stderr is diagnostics already and is passed through as it comes.
 */
function onOut(child, chunk) {
    child.outBuf += chunk;
    let i;
    while ((i = child.outBuf.indexOf('\n')) >= 0) {
        record(child, 'out', child.outBuf.slice(0, i + 1));
        child.outBuf = child.outBuf.slice(i + 1);
    }
}

function doSpawn(conn, { key, cmd, args, cwd, env }) {
    const prior = children.get(key);
    if (prior && !prior.exited) throw new Error(`a process for ${key} is already running`);
    if (prior) children.delete(key);

    /** @type {Child} */
    const child = {
        key, proc: null, pid: undefined, startedAt: Date.now(),
        log: [], logBytes: 0, seq: 0, outBuf: '', exited: null,
        note: null, noteSeq: 0, watchers: new Set([conn]), unwatchedSince: null,
    };
    let spawnError = null;
    // Its own process group, the same as the bridge used to give it: a signal
    // meant for this host is not a signal meant for a turn.
    child.proc = spawn(cmd, args || [], {
        cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    child.pid = child.proc.pid;
    children.set(key, child);
    lastActivity = Date.now();

    child.proc.stdout.setEncoding('utf8');
    child.proc.stdout.on('data', (d) => onOut(child, d));
    child.proc.stderr.setEncoding('utf8');
    child.proc.stderr.on('data', (d) => record(child, 'err', d));
    // A child dying under a write reports it here, asynchronously. Unhandled, it
    // would throw — and this is the one process that must not.
    for (const s of [child.proc.stdin, child.proc.stdout, child.proc.stderr]) {
        s.on('error', () => { /* 'close' accounts for it */ });
    }
    child.proc.on('error', (err) => { spawnError = err.message; });
    child.proc.on('close', (code, signal) => {
        if (child.outBuf) { record(child, 'out', child.outBuf); child.outBuf = ''; }
        child.exited = { code, signal: signal || null, error: spawnError };
        lastActivity = Date.now();
        log(`exit ${key} pid=${child.pid} code=${code} signal=${signal || '-'}`);
        for (const w of child.watchers) send(w, { ev: 'exit', key, ...child.exited });
        setTimeout(() => {
            if (children.get(key) === child) children.delete(key);
        }, EXITED_KEEP_MS).unref();
    });

    log(`spawn ${key} pid=${child.pid} ${cmd}`);
    return { pid: child.pid };
}

function unwatch(child, conn) {
    if (!child.watchers.delete(conn)) return;
    if (!child.watchers.size) child.unwatchedSince = Date.now();
}

function need(key) {
    const child = children.get(key);
    if (!child) throw new Error(`no process for ${key}`);
    return child;
}

function describe(child) {
    return {
        key: child.key, pid: child.pid, startedAt: child.startedAt,
        exited: child.exited, lastSeq: child.seq, note: child.note, noteSeq: child.noteSeq,
    };
}

function handle(conn, m) {
    switch (m.op) {
        case 'hello':
            return { protocol: PROTOCOL, pid: process.pid, startedAt };
        case 'spawn':
            return doSpawn(conn, m);
        case 'write': {
            const c = children.get(m.key);
            if (c && !c.exited && c.proc.stdin.writable) c.proc.stdin.write(String(m.data));
            return null;
        }
        case 'end': {
            const c = children.get(m.key);
            if (c && !c.exited) { try { c.proc.stdin.end(); } catch { /* gone */ } }
            return null;
        }
        case 'signal': {
            const c = children.get(m.key);
            if (c && !c.exited) { try { c.proc.kill(m.sig || 'SIGTERM'); } catch { /* gone */ } }
            return null;
        }
        case 'note': {
            const c = children.get(m.key);
            if (c) { c.note = m.data; c.noteSeq = c.seq; }
            return null;
        }
        case 'attach': {
            const c = need(m.key);
            const from = Number(m.from) || 0;
            c.watchers.add(conn);
            c.unwatchedSince = null;
            return {
                records: c.log.filter(r => r.seq > from), lastSeq: c.seq,
                exited: c.exited, note: c.note, noteSeq: c.noteSeq,
            };
        }
        case 'detach': {
            const c = children.get(m.key);
            if (c) unwatch(c, conn);
            return null;
        }
        case 'list':
            return { children: [...children.values()].map(describe) };
        case 'forget': {
            const c = children.get(m.key);
            if (c && !c.exited) throw new Error(`${m.key} is still running`);
            children.delete(m.key);
            return {};
        }
        default:
            throw new Error(`unknown op "${m.op}"`);
    }
}

function onConnection(conn) {
    lastActivity = Date.now();
    conn.setEncoding('utf8');
    let buf = '';
    conn.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let m;
            try { m = JSON.parse(line); } catch { continue; }
            let out;
            try {
                out = handle(conn, m);
            } catch (err) {
                if (m.id != null) send(conn, { re: m.id, ok: false, error: err.message });
                continue;
            }
            if (m.id != null) send(conn, { re: m.id, ok: true, ...(out || {}) });
        }
    });
    conn.on('error', () => { /* close follows */ });
    // The bridge going away is the whole case this file exists for, so nothing
    // happens to the children here. They just stop having anyone to tell.
    conn.on('close', () => {
        for (const c of children.values()) unwatch(c, conn);
    });
}

// --- start --------------------------------------------------------------

// A crash here ends every turn it holds, which is the one thing this process is
// for not doing. Say what happened and keep relaying.
process.on('uncaughtException', (err) => log('uncaught:', err && err.stack || err));
// setsid leaves no terminal to hang up, but be sure.
process.on('SIGHUP', () => {});

process.umask(0o077);

let socketIno = null;
const server = net.createServer(onConnection);
server.on('error', (err) => {
    log(`listen failed: ${err.message}`);
    process.exit(1);
});

function listen() {
    try { fs.unlinkSync(SOCKET); } catch { /* not there */ }
    server.listen(SOCKET, () => {
        // The umask already made it 0700; nothing executes a socket, so say what is meant.
        try { fs.chmodSync(SOCKET, 0o600); } catch { /* still owner-only */ }
        try { socketIno = fs.statSync(SOCKET).ino; } catch { /* checked again at exit */ }
        log(`host pid=${process.pid} protocol=${PROTOCOL} listening on ${SOCKET}`);
    });
}

// Another host already answering on this socket is the one to keep: it may be
// holding turns. Unlinking its socket would strand them unreachable.
const probe = net.connect(SOCKET);
probe.on('connect', () => {
    log(`another host is already listening on ${SOCKET}; leaving it be`);
    probe.destroy();
    process.exit(0);
});
probe.on('error', listen);

setInterval(() => {
    for (const c of children.values()) {
        if (c.exited || c.watchers.size || !c.unwatchedSince) continue;
        if (Date.now() - c.unwatchedSince < ORPHAN_MS) continue;
        log(`orphaned ${c.key}: nobody attached for ${Math.round(ORPHAN_MS / 60_000)} min; ending its input`);
        c.unwatchedSince = null;
        try { c.proc.stdin.end(); } catch { /* gone */ }
    }
    if (children.size) { lastActivity = Date.now(); return; }
    if (Date.now() - lastActivity < IDLE_EXIT_MS) return;
    log('idle; exiting');
    // Only our own socket file: a newer host may have taken the path since.
    try { if (fs.statSync(SOCKET).ino === socketIno) fs.unlinkSync(SOCKET); } catch { /* gone */ }
    process.exit(0);
}, IDLE_CHECK_MS).unref();
