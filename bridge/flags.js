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

const fs = require('fs');
const path = require('path');

const { STATE_DIR } = require('./config');

const STATE_FILE = path.join(STATE_DIR, 'flags.json');
const VERSION = 1;

class Flags {
    constructor() {
        this.pinned = new Set();
        this.archived = new Set();
        this.test = new Set();
        this.titles = new Map();
        this._saveTimer = null;
        this.load();
    }

    load() {
        let raw;
        try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return; }
        try {
            // Tolerate a BOM: this file is plain enough that somebody may edit it.
            const data = JSON.parse(raw.replace(/^﻿/, ''));
            if (data.version !== VERSION) return;
            this.pinned = new Set(Array.isArray(data.pinned) ? data.pinned : []);
            this.archived = new Set(Array.isArray(data.archived) ? data.archived : []);
            // Added after the first version of this file shipped. Absent is
            // empty, which is why it did not need a version bump — bumping
            // would have thrown away everybody's pins to gain nothing.
            this.test = new Set(Array.isArray(data.test) ? data.test : []);
            // The same again for `titles`: an object of id → name.
            this.titles = new Map();
            if (data.titles && typeof data.titles === 'object') {
                for (const [id, t] of Object.entries(data.titles)) {
                    const clean = cleanTitle(t);
                    if (clean) this.titles.set(id, clean);
                }
            }
        } catch (err) {
            console.error(`[tgxcode] ignoring unreadable ${STATE_FILE}: ${err.message}`);
        }
    }

    /** Debounced atomic write — flag toggles arrive in bursts when tidying up. */
    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            try {
                fs.mkdirSync(STATE_DIR, { recursive: true });
                const tmp = STATE_FILE + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify({
                    version: VERSION,
                    pinned: [...this.pinned],
                    archived: [...this.archived],
                    test: [...this.test],
                    titles: Object.fromEntries(this.titles),
                }, null, 2));
                fs.renameSync(tmp, STATE_FILE);
            } catch (err) {
                console.error(`[tgxcode] could not save flags: ${err.message}`);
            }
        }, 400);
        this._saveTimer.unref();
    }

    get(sessionId) {
        return {
            pinned: this.pinned.has(sessionId),
            archived: this.archived.has(sessionId),
            test: this.test.has(sessionId),
            title: this.titles.get(sessionId) || null,
        };
    }

    /**
     * Apply a partial change. Pinning something archived un-archives it: asking
     * for a session to sit at the top and be tucked away at once is a
     * contradiction, and pinning is the more deliberate of the two.
     */
    set(sessionId, { pinned, archived, test, title } = {}) {
        if (typeof pinned === 'boolean') {
            if (pinned) { this.pinned.add(sessionId); this.archived.delete(sessionId); }
            else this.pinned.delete(sessionId);
        }
        if (typeof archived === 'boolean') {
            if (archived) { this.archived.add(sessionId); this.pinned.delete(sessionId); }
            else this.archived.delete(sessionId);
        }
        // Not in tension with the other two: a test session can still be pinned
        // while it is being worked on. It just is not the everyday window's
        // business either way.
        if (typeof test === 'boolean') {
            if (test) this.test.add(sessionId);
            else this.test.delete(sessionId);
        }
        // A string names it; `null` or a blank string clears the name, and
        // absence leaves it alone.
        if (title !== undefined) {
            const clean = cleanTitle(title);
            if (clean) this.titles.set(sessionId, clean);
            else this.titles.delete(sessionId);
        }
        this.save();
        return this.get(sessionId);
    }

    /** Forget flags for transcripts that no longer exist. */
    prune(liveIds) {
        let changed = false;
        for (const set of [this.pinned, this.archived, this.test, this.titles]) {
            for (const id of [...set.keys()]) {
                if (!liveIds.has(id)) { set.delete(id); changed = true; }
            }
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

module.exports = { Flags, STATE_FILE, cleanTitle, TITLE_MAX };
