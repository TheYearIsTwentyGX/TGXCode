'use strict';

// Which sessions are actually running, read rather than guessed.
//
// Claude Code writes one file per running session to ~/.claude/sessions/<pid>.json:
//
//   {"pid":311333,"sessionId":"abe2de97-…","cwd":"/home/dylan_hays/Other/claude-sessions",
//    "startedAt":1786481652527,"procStart":"17877786","version":"2.1.227",
//    "kind":"interactive","entrypoint":"claude-sessions","name":"claude-sessions-76"}
//
// That answers the question the index was approximating with file mtime — a
// session thinking for two minutes without writing looked dead, and one that
// finished eighty seconds ago looked alive. Neither is a guess any more.
//
// Two things this is careful about:
//
//   * **The file is a claim, not an answer.** A session killed outright leaves
//     its file behind, and there were 38 of them on this machine with most of
//     the processes long gone. Every entry is checked against the process table
//     before it counts as running, and `procStart` is what tells a recycled pid
//     from the original.
//   * **It is not our file.** Nothing here writes or unlinks anything under
//     ~/.claude. A stale entry is reported as stale and left exactly where it is.
//
// The format is internal to Claude Code and can change between versions, so
// every field is optional and a missing one degrades to "unknown" rather than
// throwing. `active` — the mtime window in sessions.js — stays as the fallback
// for a version that writes no registry at all.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { REGISTRY_DIR } = require('./config');

// Watches miss events under some filesystems, and a directory that does not
// exist yet has to be picked up eventually.
const POLL_MS = 30_000;
// A process dying writes no file event, so nothing but a re-check notices it.
// This is what makes `kill -9` on a session show up in the UI.
const VERIFY_MS = 5_000;
// Coalesce the burst of events a single write produces.
const SETTLE_MS = 500;

class SessionRegistry extends EventEmitter {
    constructor(dir = REGISTRY_DIR) {
        super();
        this.dir = dir;
        /** @type {Map<string, object>} sessionId -> entry */
        this.entries = new Map();
        this.ready = false;
        this.watcher = null;
        this._scanTimer = null;
        this._poll = null;
        this._verify = null;
        // Said once, not every scan: a directory full of files none of which
        // parse is the shape format drift takes, and it should be visible.
        this._warned = false;
    }

    // -- lifecycle ---------------------------------------------------------

    start() {
        this.scan();
        this.ready = true;

        try {
            this.watcher = fs.watch(this.dir, { persistent: false },
                () => this._scheduleScan());
            this.watcher.on('error', () => { /* directory removed; the poll notices */ });
        } catch { /* no directory yet, or unwatchable: the poll covers it */ }

        this._poll = setInterval(() => this.scan(), POLL_MS);
        this._poll.unref();
        this._verify = setInterval(() => this.verify(), VERIFY_MS);
        this._verify.unref();
    }

    stop() {
        if (this.watcher) { try { this.watcher.close(); } catch { /* gone */ } }
        this.watcher = null;
        if (this._scanTimer) clearTimeout(this._scanTimer);
        if (this._poll) clearInterval(this._poll);
        if (this._verify) clearInterval(this._verify);
    }

    _scheduleScan() {
        if (this._scanTimer) return;
        this._scanTimer = setTimeout(() => {
            this._scanTimer = null;
            this.scan();
        }, SETTLE_MS);
    }

    // -- reading -----------------------------------------------------------

    /** Re-read the directory. */
    scan() {
        let names;
        try {
            names = fs.readdirSync(this.dir);
        } catch (err) {
            // No registry directory at all — an older Claude Code, or a machine
            // that has never run one. Not an error; the mtime fallback stands,
            // and saying "nothing is running" is the honest answer.
            if (err.code === 'ENOENT') return this._commit(new Map());
            // Anything else — a permissions blip, too many open files — is this
            // read failing, not every session stopping. Treating it as the
            // latter would drop the composer lock and clear the board for as
            // long as it lasted. Keep what we know and try again next pass.
            return;
        }

        const next = new Map();
        let files = 0;
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            files++;
            const entry = readEntry(path.join(this.dir, name));
            if (!entry) continue;

            // A stale file and a live one can name the same session. The running
            // one is the answer; failing that, the one that started last.
            const held = next.get(entry.sessionId);
            if (held && !preferable(entry, held)) continue;
            next.set(entry.sessionId, entry);
        }

        if (files && !next.size && !this._warned) {
            this._warned = true;
            console.warn(`[registry] ${files} file(s) in ${this.dir} and none of them `
                + 'parsed as a session — the format may have changed. Falling back to '
                + 'file mtime for liveness.');
        }
        this._commit(next);
    }

    /**
     * Re-check the processes we believe are running.
     *
     * Only those: a stale entry cannot become live again without its file being
     * rewritten, and that is what the watch is for. So this is a handful of
     * /proc reads however many dead sessions have piled up in the directory.
     */
    verify() {
        let moved = false;
        for (const e of this.entries.values()) {
            if (!e.running) continue;
            if (alive(e.pid, e.procStart)) continue;
            e.running = false;
            moved = true;
        }
        if (moved) this.emit('changed');
    }

    _commit(next) {
        if (sameShape(this.entries, next)) { this.entries = next; return; }
        this.entries = next;
        this.emit('changed');
    }

    // -- queries -----------------------------------------------------------

    /**
     * What the registry knows about one session, or null.
     *
     * A stale entry is still returned, with `running: false` — it carries the
     * name and the entrypoint, which stay true of the session after its process
     * has gone.
     */
    for(sessionId) {
        return this.entries.get(sessionId) || null;
    }

    /** Every session whose process is still there. */
    running() {
        return [...this.entries.values()].filter(e => e.running);
    }

    get size() { return this.entries.size; }
    get liveCount() { return this.running().length; }
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

/**
 * Read one registry file into the shape the rest of the app uses, or null if it
 * is not a session entry we can make sense of.
 *
 * Only `sessionId` and `pid` are required — without those there is nothing to
 * attach to a transcript or to check against the process table. Everything else
 * is whatever this version of Claude Code happened to write.
 */
function readEntry(file) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    if (!raw || typeof raw !== 'object') return null;

    const sessionId = str(raw.sessionId);
    const pid = Number(raw.pid);
    if (!sessionId || !Number.isInteger(pid) || pid <= 0) return null;

    const procStart = raw.procStart == null ? null : String(raw.procStart);
    return {
        sessionId,
        pid,
        procStart,
        cwd: str(raw.cwd),
        // 'interactive' | 'bg' | whatever comes next. Worth a badge when it is
        // a background agent, and worth saying in a tooltip either way.
        kind: str(raw.kind),
        // How it was started: 'cli', 'vscode', 'claude-sessions' (us), …
        entrypoint: str(raw.entrypoint),
        // A human label Claude Code already derived. Used as a title source for
        // a session whose transcript has not produced one.
        name: str(raw.name),
        status: str(raw.status),
        version: str(raw.version),
        startedAt: num(raw.startedAt),
        updatedAt: num(raw.updatedAt),
        running: alive(pid, procStart),
    };
}

const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (Number.isFinite(v) ? v : null);

/** Of two files naming one session, which one to believe. */
function preferable(a, b) {
    if (a.running !== b.running) return a.running;
    return (a.startedAt || 0) > (b.startedAt || 0);
}

// ---------------------------------------------------------------------------
// Is that process still there?
// ---------------------------------------------------------------------------

/**
 * The process start time from /proc/<pid>/stat — field 22, a monotonic token
 * that differs between a process and whatever later reuses its pid.
 *
 * Parsed from the *last* `)` rather than by splitting the line: field 2 is the
 * executable name in parentheses and may itself contain spaces and brackets, so
 * counting from the left goes wrong on exactly the processes worth naming.
 */
function procStartOf(pid) {
    let text;
    try { text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
    const close = text.lastIndexOf(')');
    if (close === -1) return null;
    // The first token after the name is field 3, so field 22 is 19 further on.
    const fields = text.slice(close + 1).trim().split(/\s+/);
    return fields[19] || null;
}

/**
 * Whether the process behind a registry entry is still running.
 *
 * The bridge runs inside WSL and the registry is written inside WSL, so this is
 * looking at the right process table. It must not be moved to the Electron side.
 */
function alive(pid, procStart) {
    if (!Number.isInteger(pid) || pid <= 0) return false;

    const seen = procStartOf(pid);
    if (seen !== null) {
        // No procStart in the file — an older Claude Code — leaves the pid
        // existing as the whole answer available. Weaker, and still better than
        // an mtime window.
        return procStart == null || procStart === seen;
    }

    // No /proc: not Linux, or a hardened mount. Ask the kernel directly.
    try { process.kill(pid, 0); return true; }
    catch (err) { return err.code === 'EPERM'; }   // there, just not ours to signal
}

// ---------------------------------------------------------------------------

/** Whether two scans say the same thing, for the fields anything downstream reads. */
function sameShape(a, b) {
    if (a.size !== b.size) return false;
    for (const [id, x] of a) {
        const y = b.get(id);
        if (!y) return false;
        if (x.pid !== y.pid || x.running !== y.running || x.status !== y.status
            || x.name !== y.name || x.kind !== y.kind || x.entrypoint !== y.entrypoint
            || x.cwd !== y.cwd) return false;
    }
    return true;
}

module.exports = { SessionRegistry, alive, procStartOf, readEntry };
