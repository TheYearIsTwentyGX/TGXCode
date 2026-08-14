'use strict';

// Per-session flags the user sets: pinned, archived, and test.
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
        } catch (err) {
            console.error(`[claude-sessions] ignoring unreadable ${STATE_FILE}: ${err.message}`);
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
                }, null, 2));
                fs.renameSync(tmp, STATE_FILE);
            } catch (err) {
                console.error(`[claude-sessions] could not save flags: ${err.message}`);
            }
        }, 400);
        this._saveTimer.unref();
    }

    get(sessionId) {
        return {
            pinned: this.pinned.has(sessionId),
            archived: this.archived.has(sessionId),
            test: this.test.has(sessionId),
        };
    }

    /**
     * Apply a partial change. Pinning something archived un-archives it: asking
     * for a session to sit at the top and be tucked away at once is a
     * contradiction, and pinning is the more deliberate of the two.
     */
    set(sessionId, { pinned, archived, test } = {}) {
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
        this.save();
        return this.get(sessionId);
    }

    /** Forget flags for transcripts that no longer exist. */
    prune(liveIds) {
        let changed = false;
        for (const set of [this.pinned, this.archived, this.test]) {
            for (const id of [...set]) {
                if (!liveIds.has(id)) { set.delete(id); changed = true; }
            }
        }
        if (changed) this.save();
        return changed;
    }
}

module.exports = { Flags, STATE_FILE };
