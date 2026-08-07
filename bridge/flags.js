'use strict';

// Per-session flags the user sets: pinned and archived.
//
// This is the only state the app owns. Everything else it shows is derived from
// Claude Code's own transcripts, which we never write to — so these live in
// their own file under XDG_DATA_HOME rather than the cache, because losing them
// would lose a real decision the user made.
//
// Archiving never deletes anything. An archived session keeps its transcript and
// stays reachable; it just moves out of the way.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'claude-sessions');
const STATE_FILE = path.join(STATE_DIR, 'flags.json');
const VERSION = 1;

class Flags {
    constructor() {
        this.pinned = new Set();
        this.archived = new Set();
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
        };
    }

    /**
     * Apply a partial change. Pinning something archived un-archives it: asking
     * for a session to sit at the top and be tucked away at once is a
     * contradiction, and pinning is the more deliberate of the two.
     */
    set(sessionId, { pinned, archived } = {}) {
        if (typeof pinned === 'boolean') {
            if (pinned) { this.pinned.add(sessionId); this.archived.delete(sessionId); }
            else this.pinned.delete(sessionId);
        }
        if (typeof archived === 'boolean') {
            if (archived) { this.archived.add(sessionId); this.pinned.delete(sessionId); }
            else this.archived.delete(sessionId);
        }
        this.save();
        return this.get(sessionId);
    }

    /** Forget flags for transcripts that no longer exist. */
    prune(liveIds) {
        let changed = false;
        for (const set of [this.pinned, this.archived]) {
            for (const id of [...set]) {
                if (!liveIds.has(id)) { set.delete(id); changed = true; }
            }
        }
        if (changed) this.save();
        return changed;
    }
}

module.exports = { Flags, STATE_FILE };
