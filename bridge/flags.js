'use strict';

// Per-session flags the user sets: pinned, archived, test, and a title.
//
// This is the only state the app owns. Everything else it shows is derived from
// Claude Code's own transcripts, which we never write to — so these live in
// their own file under XDG_DATA_HOME rather than the cache, because losing them
// would lose a real decision the user made.
//
// Archiving never deletes anything. An archived session keeps its transcript and
// stays reachable; it just moves out of the way.
//
// `test` is the odd one out: not a decision about a conversation so much as a
// label saying it was never meant to be read. An agent working on this codebase
// starts sessions to see whether the UI does what it claims, and those used to
// pile up in the everyday window alongside real work. A test session is listed
// by the development bridge only, so the everyday instance never shows it — see
// SessionIndex#list.
//
// `title` is a name given from the rail. It is kept here rather than appended to
// the transcript as a `custom-title` entry, and not only because of the rule
// above: a running `claude` holds its own title in memory and writes it back, so
// a line appended under it can be silently outvoted. Clearing it hands the
// session back to whatever the transcript calls it.
//
// **Every bridge on this machine shares this file**, the everyday one and each
// development one alike, and each holds it in memory. It used to be read once at
// startup and written back whole, so the last bridge to save won: a dev bridge
// labelled a session `test`, the everyday bridge then pinned something or spawned
// a worker and wrote its own copy — which had never heard of that session — over
// it, and the label was gone. The everyday bridge, never re-reading, showed every
// test session made since it started; and a dev bridge's stale copy reverted pins,
// archives and names the user had set in the everyday window. So now:
//
//   * **A write is a list of changes, not a snapshot.** `set` and `prune` record
//     what they changed; `save` re-reads the file, replays those changes onto it
//     and writes the result. Two bridges' writes both survive, unless they land
//     in the same few milliseconds — there is no lock, and that window is not
//     worth one.
//   * **A read sees the other bridges' writes.** `refresh` stats the file at most
//     once a second and reloads it when it changed, so a list of hundreds of rows
//     costs one `stat`, not one per row.
//   * **A prune spares what is new.** Another bridge's session can carry a flag
//     before its transcript exists, and this bridge's `pending` reprieve
//     (SessionIndex#note) does not know about it. `added` stamps when an id last
//     gained a flag, and an id stamped in the last few minutes is not pruned.

const fs = require('fs');
const path = require('path');

const { STATE_DIR } = require('./config');

const STATE_FILE = path.join(STATE_DIR, 'flags.json');
const VERSION = 1;

/** How often a read may stat the file for another bridge's write. */
const REFRESH_MS = 1000;
/** How long a newly flagged id is spared by prune — SessionIndex's PENDING_TTL_MS. */
const FRESH_MS = 5 * 60_000;

/** An empty state: the four kinds of flag and when each id last gained one. */
function emptyState() {
    return { pinned: new Set(), archived: new Set(), test: new Set(), titles: new Map(), added: new Map() };
}

/** Parse the file's text into a state. Throws on bad JSON; null for a foreign version. */
function parseState(raw) {
    // Tolerate a BOM: this file is plain enough that somebody may edit it.
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (data.version !== VERSION) return null;
    const st = emptyState();
    st.pinned = new Set(Array.isArray(data.pinned) ? data.pinned : []);
    st.archived = new Set(Array.isArray(data.archived) ? data.archived : []);
    // Added after the first version of this file shipped. Absent is
    // empty, which is why it did not need a version bump — bumping
    // would have thrown away everybody's pins to gain nothing.
    st.test = new Set(Array.isArray(data.test) ? data.test : []);
    // The same again for `titles`: an object of id → name.
    if (data.titles && typeof data.titles === 'object') {
        for (const [id, t] of Object.entries(data.titles)) {
            const clean = cleanTitle(t);
            if (clean) st.titles.set(id, clean);
        }
    }
    // And for `added`: id → epoch ms. An id without one is old, and prunable.
    if (data.added && typeof data.added === 'object') {
        for (const [id, at] of Object.entries(data.added)) {
            if (Number.isFinite(at)) st.added.set(id, at);
        }
    }
    return st;
}

/**
 * Apply one recorded change to a state. The same function runs when the change
 * is made and again when it is replayed onto a fresh read of the file, so the
 * rules — pinning un-archives, and the reverse — hold in both.
 */
function applyOp(st, op) {
    const { id } = op;
    switch (op.kind) {
        case 'pinned':
            if (op.on) { st.pinned.add(id); st.archived.delete(id); } else st.pinned.delete(id);
            break;
        case 'archived':
            if (op.on) { st.archived.add(id); st.pinned.delete(id); } else st.archived.delete(id);
            break;
        case 'test':
            if (op.on) st.test.add(id); else st.test.delete(id);
            break;
        case 'title':
            if (op.title) st.titles.set(id, op.title); else st.titles.delete(id);
            break;
        case 'added':
            st.added.set(id, op.at);
            break;
        case 'forget':
            for (const set of [st.pinned, st.archived, st.test, st.titles, st.added]) set.delete(id);
            break;
    }
}

class Flags {
    constructor() {
        Object.assign(this, emptyState());
        this._saveTimer = null;
        /** Changes made here and not yet written. Replayed over any reload. */
        this._ops = [];
        /** The file as last read or written: `mtimeMs:size`, or null if absent. */
        this._seen = null;
        this._checkedAt = 0;
        this.load();
    }

    load() {
        let raw, stat;
        try {
            stat = fs.statSync(STATE_FILE);
            raw = fs.readFileSync(STATE_FILE, 'utf8');
        } catch { return; }
        this._seen = `${stat.mtimeMs}:${stat.size}`;
        try {
            const st = parseState(raw);
            if (!st) return;
            for (const op of this._ops) applyOp(st, op);
            Object.assign(this, st);
        } catch (err) {
            console.error(`[tgxcode] ignoring unreadable ${STATE_FILE}: ${err.message}`);
        }
    }

    /**
     * Pick up another bridge's write. Throttled by time rather than by caller, so
     * the per-row `get` in a session list costs one `stat` per second at most.
     */
    refresh() {
        const now = Date.now();
        if (now - this._checkedAt < REFRESH_MS) return;
        this._checkedAt = now;
        let seen = null;
        try {
            const s = fs.statSync(STATE_FILE);
            seen = `${s.mtimeMs}:${s.size}`;
        } catch { /* absent: nothing to pick up */ }
        if (seen && seen !== this._seen) this.load();
    }

    _record(op) {
        applyOp(this, op);
        this._ops.push(op);
    }

    /** Debounced atomic write — flag toggles arrive in bursts when tidying up. */
    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._write();
        }, 400);
        this._saveTimer.unref();
    }

    /** Re-read, replay this bridge's changes on top, write. See the header. */
    _write() {
        try {
            this._checkedAt = 0;
            this._seen = null;
            this.load();
            fs.mkdirSync(STATE_DIR, { recursive: true });
            // Per process: two bridges saving at once must not share a temp file.
            const tmp = `${STATE_FILE}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({
                version: VERSION,
                pinned: [...this.pinned],
                archived: [...this.archived],
                test: [...this.test],
                titles: Object.fromEntries(this.titles),
                added: Object.fromEntries(this.added),
            }, null, 2));
            fs.renameSync(tmp, STATE_FILE);
            this._ops = [];
            const s = fs.statSync(STATE_FILE);
            this._seen = `${s.mtimeMs}:${s.size}`;
        } catch (err) {
            console.error(`[tgxcode] could not save flags: ${err.message}`);
        }
    }

    get(sessionId) {
        this.refresh();
        return {
            pinned: this.pinned.has(sessionId),
            archived: this.archived.has(sessionId),
            test: this.test.has(sessionId),
            title: this.titles.get(sessionId) || null,
        };
    }

    /** The one flag a list filters on; cheaper than get() for every row. */
    isTest(sessionId) {
        this.refresh();
        return this.test.has(sessionId);
    }

    /**
     * Apply a partial change. Pinning something archived un-archives it: asking
     * for a session to sit at the top and be tucked away at once is a
     * contradiction, and pinning is the more deliberate of the two.
     */
    set(sessionId, { pinned, archived, test, title } = {}) {
        this.refresh();
        const id = sessionId;
        let gained = false;
        if (typeof pinned === 'boolean') { this._record({ kind: 'pinned', id, on: pinned }); gained ||= pinned; }
        if (typeof archived === 'boolean') { this._record({ kind: 'archived', id, on: archived }); gained ||= archived; }
        // Not in tension with the other two: a test session can still be pinned
        // while it is being worked on. It just is not the everyday window's
        // business either way.
        if (typeof test === 'boolean') { this._record({ kind: 'test', id, on: test }); gained ||= test; }
        // A string names it; `null` or a blank string clears the name, and
        // absence leaves it alone.
        if (title !== undefined) {
            const clean = cleanTitle(title);
            this._record({ kind: 'title', id, title: clean });
            gained ||= !!clean;
        }
        if (gained) this._record({ kind: 'added', id, at: Date.now() });
        this.save();
        return this.get(sessionId);
    }

    /** Drop every flag on one id now, stamp or not: its transcript was deleted on purpose. */
    forget(sessionId) {
        this.refresh();
        this._record({ kind: 'forget', id: sessionId });
        this.save();
    }

    /**
     * Forget flags for transcripts that no longer exist — except ids flagged in
     * the last `freshMs`, which may be another bridge's session that has not
     * written its first line yet.
     */
    prune(liveIds, freshMs = FRESH_MS) {
        this.refresh();
        const cutoff = Date.now() - freshMs;
        const ids = new Set();
        for (const set of [this.pinned, this.archived, this.test, this.titles, this.added]) {
            for (const id of set.keys()) if (!liveIds.has(id)) ids.add(id);
        }
        let changed = false;
        for (const id of ids) {
            if ((this.added.get(id) || 0) > cutoff) continue;
            this._record({ kind: 'forget', id });
            changed = true;
        }
        if (changed) this.save();
        return changed;
    }
}

/** Longest name kept. Long enough for a sentence; short enough for a row. */
const TITLE_MAX = 200;

/** A usable name, or null. Collapses whitespace so a pasted newline is not a row break. */
function cleanTitle(t) {
    if (typeof t !== 'string') return null;
    const clean = t.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim();
    return clean || null;
}

module.exports = { Flags, STATE_FILE, cleanTitle, TITLE_MAX, REFRESH_MS, FRESH_MS };
