'use strict';

// Finding a port nothing else wants, and holding it until the thing we started
// has actually taken it.
//
// Two tests, because on this machine one is not enough. Binding the port is the
// question actually being asked — can a child we are about to spawn bind this —
// and it is the only test that sees a socket held on an interface loopback
// cannot reach. But WSL runs with networkingMode=mirrored, so a server on the
// *Windows* side answers on 127.0.0.1 while holding no Linux socket at all;
// devservers.js already documents that asymmetry from the other direction. A
// bind test on its own would hand out a port that is visibly occupied from the
// browser, which is the most confusing possible failure. So: bind first, and if
// that succeeds, check nothing answers either.
//
// The reservation is the other half. Seconds pass between the bind test closing
// its socket and the child calling bind() — bash reads ~/.bashrc, nvm resolves,
// npm starts — and two commands launched back to back would otherwise be handed
// the same port. A reservation covers that gap; observe() turns it into a hold
// with no expiry once the child is really listening, and release() frees it when
// the run ends.
//
// This only binds *this* bridge. The everyday instance and a development one can
// still pick the same port at the same moment, and the caller is expected to
// handle a fast non-zero exit by asking for another one — a lock file shared
// between two processes is more machinery than a one-user machine earns.

const net = require('net');

const { PORT_DENYLIST } = require('./config');
const { isListening } = require('./devservers');

// Long enough for `bash -i` to read a slow .bashrc and for npm to get as far as
// binding, short enough that a run which died on the way up does not sit on a
// port for the rest of the day.
const RESERVE_MS = 90_000;

/** @type {Map<number, {owner: string, until: number}>} port -> who is holding it */
const reservations = new Map();

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
 * process is the common case and answers instantly, where the connect probe
 * would spend its whole timeout confirming it.
 */
async function isFree(port) {
    if (!(await bindable(port))) return false;
    return !(await isListening(port, 200));
}

function held(port, now) {
    const r = reservations.get(port);
    if (!r) return false;
    if (r.until && r.until <= now) { reservations.delete(port); return false; }
    return true;
}

/**
 * The first free port in `[lo, hi]`, reserved for `owner`.
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
async function allocate({ lo, hi, skip = [], denylist = PORT_DENYLIST }, owner) {
    const now = Date.now();
    const forbidden = new Set(skip);
    for (let port = lo; port <= hi; port++) {
        if (forbidden.has(port) || (denylist && denylist.has(port))) continue;
        if (held(port, now)) continue;
        if (!(await isFree(port))) continue;
        reservations.set(port, { owner, until: Date.now() + RESERVE_MS });
        return port;
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
        .filter(([port]) => held(port, now))
        .map(([port, r]) => ({ port, owner: r.owner, permanent: !r.until }));
}

module.exports = { isFree, bindable, allocate, observe, release, reserved, RESERVE_MS };
