'use strict';

// Finding a port nothing else wants, and holding it until the thing we started
// has actually taken it.
//
// Three tests, because on this machine one is not enough. Binding the port is
// the question actually being asked — can a child we are about to spawn bind
// this. But WSL runs with networkingMode=mirrored, so a server on the *Windows*
// side answers on 127.0.0.1 while holding no Linux socket at all; devservers.js
// already documents that asymmetry from the other direction. A bind test on its
// own would hand out a port that is visibly occupied from the browser, which is
// the most confusing possible failure. And a bind test plus a loopback probe
// still misses a listener bound to `::1` alone: measured here, bindable() on
// 0.0.0.0 succeeds and connecting to 127.0.0.1 fails, so the port reads as free
// while it is answering. The kernel's own listen table is what closes that, and
// it costs one `ss` sweep for a whole allocate() rather than one per port.
//
// The reservation is the second thing. Seconds pass between the bind test closing
// its socket and the child calling bind() — bash reads ~/.bashrc, nvm resolves,
// npm starts — and two commands launched back to back would otherwise be handed
// the same port. A reservation covers that gap; observe() turns it into a hold
// with no expiry once the child is really listening, and release() frees it when
// the run ends.
//
// And the third — the reason this file grew — is that **free is not the same
// as unclaimed**. Ports were handed out first-fit from the bottom of the
// range, so every worktree of a project scanned from the same low port and
// whichever dev server restarted next took it. DevBrowser keys its tabs by port
// alone, so the name on the tab moved to a different worktree, and the run that
// moved orphaned the tab it used to own. Both halves of that were visible in
// titles.json: two ports carrying the same worktree's name, one of them dead.
// So allocate() takes `prefer` — ports this caller has a claim on, tried first,
// in order — and `avoid`, ports somebody else has a claim on, which are used
// only when the alternative is refusing to start. The claims themselves are not
// this file's business: runs.js knows about workspaces and tab titles, and
// passes down the conclusion.
//
// What *is* this file's business is remembering, because a claim has to survive
// the bridge that made it. remember()/rememberedPort() keep a key -> port map in
// STATE_DIR, deliberately in one file shared by the everyday instance and any
// development one: it is the only thing that stops two bridges homing onto the
// same port. It narrows that race rather than closing it — this only *binds*
// this process, and two bridges can still pick the same port in the same moment.
// The caller is expected to handle a fast non-zero exit by asking for another
// one; a lock file between processes is more machinery than a one-user machine
// earns.

const fs = require('fs');
const net = require('net');
const path = require('path');

const { PORT_DENYLIST, STATE_DIR } = require('./config');
const { isListening, heldPorts } = require('./devservers');

// Long enough for `bash -i` to read a slow .bashrc and for npm to get as far as
// binding, short enough that a run which died on the way up does not sit on a
// port for the rest of the day.
const RESERVE_MS = 90_000;

/** @type {Map<number, {owner: string, until: number}>} port -> who is holding it */
const reservations = new Map();

// ---------------------------------------------------------------------------
// Is it free?
// ---------------------------------------------------------------------------

/** Can a process bind this port right now? */
function bindable(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => s.close(() => resolve(true)));
        s.listen(port, host);
    });
}

/**
 * Is this port free for something we are about to start?
 *
 * Bind first and short-circuit on failure: a port already held by a Linux
 * process on the wildcard address is the common case and answers instantly,
 * where the connect probes would spend their whole timeout confirming it.
 *
 * `held` is one sweep of the kernel's listen table, from devservers.heldPorts().
 * allocate() takes it once and passes it to every check; a caller with no table
 * gets one of its own, which is correct but costs an `ss` per call.
 */
async function isFree(port, held = null) {
    if (!(await bindable(port))) return false;
    const table = held || await heldPorts();
    if (table.has(port)) return false;
    // Both families, because neither implies the other: mirrored networking
    // means a Windows-side server has no Linux socket to be in the table, and a
    // `::1` listener answers nothing on 127.0.0.1.
    const answering = await Promise.all([
        isListening(port, 200, '127.0.0.1'),
        isListening(port, 200, '::1'),
    ]);
    return !answering.some(Boolean);
}

function reservedNow(port, now) {
    const r = reservations.get(port);
    if (!r) return false;
    if (r.until && r.until <= now) { reservations.delete(port); return false; }
    return true;
}

// ---------------------------------------------------------------------------
// Allocating
// ---------------------------------------------------------------------------

/**
 * The first port in `[lo, hi]` this caller can have, reserved for `owner`.
 *
 * `prefer` comes first, in the order given: a port this caller had last time is
 * worth more than the lowest free one, because a dev server that keeps its port
 * keeps its DevBrowser tab. Ports in `avoid` are somebody else's and are left
 * alone on the first pass through the range; the second pass takes one anyway,
 * because a claim on a port nothing is listening on should not stop a server
 * from starting. Neither list can override `skip` or the denylist.
 *
 * `skip` is for callers with a port they must never return whatever the socket
 * says — scripts/dev.js and the everyday instance's 45888.
 *
 * `denylist` defaults to the config one, which is the right answer for a dev
 * server: nothing declared in a project should come up on 3306 or on the port
 * this bridge is serving. A caller picking a port for something that is *not* a
 * project's dev server passes null — scripts/dev.js does, because the denylist
 * contains the bridge's own port and asking for that port explicitly is exactly
 * what `CLAUDE_SESSIONS_PORT=45899 npm run dev` means.
 *
 * @returns {Promise<number|null>} null if the whole range is taken
 */
async function allocate(
    { lo, hi, skip = [], denylist = PORT_DENYLIST, prefer = [], avoid = null }, owner) {
    const forbidden = new Set(skip);
    const claimed = avoid instanceof Set ? avoid : new Set(avoid || []);
    // One sweep for the whole call. A port that comes up while we are scanning
    // is the reservation gap all over again, and nothing here can win that race
    // — the bind test is what catches it, and that is per-port.
    const held = await heldPorts();

    const allowed = (port) => Number.isInteger(port) && port >= lo && port <= hi
        && !forbidden.has(port) && !(denylist && denylist.has(port));

    const take = async (port) => {
        if (reservedNow(port, Date.now())) return false;
        if (!(await isFree(port, held))) return false;
        reservations.set(port, { owner, until: Date.now() + RESERVE_MS });
        return true;
    };

    for (const port of prefer) {
        if (allowed(port) && await take(port)) return port;
    }
    // Leaving anybody else's alone on the first pass, then — having found
    // nothing — the whole range including theirs.
    for (const theirs of [false, true]) {
        for (let port = lo; port <= hi; port++) {
            if (!allowed(port)) continue;
            if (!theirs && claimed.has(port)) continue;
            if (await take(port)) return port;
        }
    }
    return null;
}

/**
 * The child is really listening now, so the reservation stops being a guess.
 *
 * Without this a long-lived dev server would come out of reservation after 90
 * seconds and the next allocate() would have to rediscover it by probing. It
 * would, but it would also race with a restart that has not rebound yet.
 */
function observe(port, owner) {
    const r = reservations.get(port);
    if (r && r.owner === owner) r.until = 0;
}

/** Give the port back. A reservation belonging to somebody else is left alone. */
function release(port, owner) {
    const r = reservations.get(port);
    if (r && r.owner === owner) reservations.delete(port);
}

/** What this bridge is currently holding — for /api/health and for debugging. */
function reserved() {
    const now = Date.now();
    return [...reservations.entries()]
        .filter(([port]) => reservedNow(port, now))
        .map(([port, r]) => ({ port, owner: r.owner, permanent: !r.until }));
}

// ---------------------------------------------------------------------------
// Remembering
// ---------------------------------------------------------------------------
// Which port a thing had last time, so it can have the same one again. Keys are
// the caller's to invent, with one convention: name the directory it is about —
// `dev:<path>`, `run:<path>:<command id>` — so a key belonging to a worktree
// that has since been deleted can be dropped rather than claiming a port for
// ever. Worktrees come and go here often enough that without that, a range of
// nineteen ports would be entirely claimed after nineteen of them.

const MEMORY_FILE = path.join(STATE_DIR, 'ports.json');
const MEMORY_VERSION = 1;

/** @type {Map<string, number>|null} loaded lazily — requiring this file must not touch state */
let memory = null;
/** Keys deleted here, so the merge below removes them rather than reading them back. */
const forgotten = new Set();
let saveTimer = null;

function readMemoryFile() {
    const out = new Map();
    let raw;
    try { raw = fs.readFileSync(MEMORY_FILE, 'utf8'); } catch { return out; }
    try {
        // Tolerate a BOM: this file is plain enough that somebody may edit it.
        const data = JSON.parse(raw.replace(/^﻿/, ''));
        if (data.version !== MEMORY_VERSION) return out;
        for (const [key, port] of Object.entries(data.ports || {})) {
            if (Number.isInteger(port) && port > 0 && port < 65536) out.set(key, port);
        }
    } catch (err) {
        console.error(`[claude-sessions] ignoring unreadable ${MEMORY_FILE}: ${err.message}`);
    }
    return out;
}

/**
 * The directory a key is about, or null if it does not name one.
 *
 * Both callers put one in: `dev:<path>` for a bridge, `run:<path>:<command id>`
 * for a declared command. A path with a colon in it reads wrong here and its key
 * is dropped as stale, which costs one port hop and no correctness.
 */
function directoryOf(key) {
    const kind = key.indexOf(':');
    if (kind < 0) return null;
    const rest = key.slice(kind + 1);
    if (!rest.startsWith('/')) return null;
    const id = rest.lastIndexOf(':');
    return id < 0 ? rest : rest.slice(0, id);
}

/**
 * Forget keys naming a directory that is gone.
 *
 * Worktrees are made and deleted here constantly, and without this each dead one
 * goes on claiming its port for ever: a range of nineteen would be entirely
 * claimed after nineteen worktrees, at which point allocate() falls back to
 * handing out whatever is free and the stickiness has bought nothing.
 */
function prune(mem) {
    for (const key of [...mem.keys()]) {
        const dir = directoryOf(key);
        if (!dir || fs.existsSync(dir)) continue;
        mem.delete(key);
        forgotten.add(key);
    }
    if (forgotten.size) saveMemory();
}

function loadMemory() {
    if (!memory) {
        memory = readMemoryFile();
        prune(memory);
    }
    return memory;
}

/**
 * Debounced atomic write, merging over whatever is on disk.
 *
 * The merge is the point: this file is shared with the other bridge deliberately,
 * and a straight overwrite would drop its keys — leaving both instances free to
 * pick the same port again, which is the thing the memory exists to stop.
 */
function saveMemory() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            const merged = readMemoryFile();
            for (const [key, port] of loadMemory()) merged.set(key, port);
            for (const key of forgotten) merged.delete(key);
            forgotten.clear();
            fs.mkdirSync(STATE_DIR, { recursive: true });
            const tmp = MEMORY_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({
                version: MEMORY_VERSION,
                ports: Object.fromEntries(merged),
            }, null, 2));
            fs.renameSync(tmp, MEMORY_FILE);
        } catch (err) {
            console.error(`[claude-sessions] could not save ports: ${err.message}`);
        }
    }, 400);
    saveTimer.unref();
}

/** The port this key had last time, or null. */
function rememberedPort(key) {
    const port = key ? loadMemory().get(key) : undefined;
    return port === undefined ? null : port;
}

/** This key has this port now. */
function remember(key, port) {
    if (!key || !Number.isInteger(port)) return;
    const mem = loadMemory();
    forgotten.delete(key);
    if (mem.get(key) === port) return;
    mem.set(key, port);
    saveMemory();
}

/** Forget a key — its command is gone, or its workspace is. */
function forgetKey(key) {
    if (!key || !loadMemory().delete(key)) return;
    forgotten.add(key);
    saveMemory();
}

/**
 * Every remembered key and its port, for a caller building an avoid set.
 *
 * Re-read from disk rather than served from memory alone: the other bridge
 * writes here too, and a claim it made a minute ago is exactly the one worth
 * respecting.
 */
function claims() {
    const disk = readMemoryFile();
    for (const [key, port] of loadMemory()) disk.set(key, port);
    for (const key of forgotten) disk.delete(key);
    return disk;
}

module.exports = {
    isFree, bindable, allocate, observe, release, reserved, RESERVE_MS,
    rememberedPort, remember, forgetKey, claims, MEMORY_FILE,
};
