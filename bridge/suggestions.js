'use strict';

// Which suggested follow-ups you have already dealt with.
//
// A suggestion itself is not stored here and must not be: the agent's call to
// `suggest_session` is in the transcript, so the prompt, the reason and where in
// the conversation it was raised all come from the same place everything else in
// this app comes from. Re-recording it would be a second copy to drift.
//
// What is *not* in the transcript is what you did about it. Starting a
// suggestion or waving it away is a decision you made, and it has to outlive a
// reload — so it goes here, beside flags.json, for the reason flags.js gives:
// losing it would lose a real decision rather than a cache.
//
// **Keyed by session, then by the tool call's id.** Keying by tool id alone
// would be enough to look one up, but then nothing could be pruned — there is no
// cheap way to ask whether a tool id still exists. Nesting under the session
// makes prune() the same one-line job it is in flags.js, and makes "the
// suggestions in this conversation" a single lookup rather than a scan.
//
// Whole-file rewrite, like flags.js and unlike notifications.js. Two bridges do
// run at once and the last writer wins, which is a real if rare loss — but these
// are single clicks made in the window you are looking at, not a stream of
// events arriving while you are away, so a JSONL log would be machinery for a
// collision that costs one click to undo.

const fs = require('fs');
const path = require('path');

const { STATE_DIR } = require('./config');

const STATE_FILE = path.join(STATE_DIR, 'suggestions.json');
const VERSION = 1;

/** What can have happened to a suggestion. Anything else is ignored on load. */
const STATUSES = new Set(['started', 'dismissed']);

class Suggestions {
    constructor() {
        /** @type {Map<string, Record<string, {status: string, startedId: string|null, at: number}>>} */
        this.bySession = new Map();
        this._saveTimer = null;
        this.load();
    }

    load() {
        let raw;
        try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return; }
        try {
            // Tolerate a BOM, as flags.js does: this file is plain enough that
            // somebody may open it to see what is in there.
            const data = JSON.parse(raw.replace(/^﻿/, ''));
            if (data.version !== VERSION) return;
            const sessions = data.sessions && typeof data.sessions === 'object' ? data.sessions : {};
            for (const [sessionId, acted] of Object.entries(sessions)) {
                if (!acted || typeof acted !== 'object') continue;
                const clean = {};
                for (const [toolUseId, entry] of Object.entries(acted)) {
                    if (!entry || !STATUSES.has(entry.status)) continue;
                    clean[toolUseId] = {
                        status: entry.status,
                        startedId: typeof entry.startedId === 'string' ? entry.startedId : null,
                        at: Number.isFinite(entry.at) ? entry.at : 0,
                    };
                }
                if (Object.keys(clean).length) this.bySession.set(sessionId, clean);
            }
        } catch (err) {
            console.error(`[claude-sessions] ignoring unreadable ${STATE_FILE}: ${err.message}`);
        }
    }

    /** Debounced atomic write — the same shape flags.js uses, for the same reason. */
    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            try {
                fs.mkdirSync(STATE_DIR, { recursive: true });
                const tmp = STATE_FILE + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify({
                    version: VERSION,
                    sessions: Object.fromEntries(this.bySession),
                }, null, 2));
                fs.renameSync(tmp, STATE_FILE);
            } catch (err) {
                console.error(`[claude-sessions] could not save suggestions: ${err.message}`);
            }
        }, 400);
        this._saveTimer.unref();
    }

    /**
     * Everything acted on in one conversation, as `{[toolUseId]: entry}`.
     *
     * Always an object, never null — it rides along on the session payload and a
     * client should not have to test for it before looking something up.
     */
    forSession(sessionId) {
        return this.bySession.get(sessionId) || {};
    }

    /**
     * Record what happened to one suggestion.
     *
     * `startedId` is the session that got started, so the card can become a link
     * into it rather than just going quiet. It is meaningless on a dismissal and
     * is dropped there rather than stored as a lie.
     */
    set(sessionId, toolUseId, { status, startedId = null } = {}) {
        if (!sessionId || !toolUseId || !STATUSES.has(status)) return null;
        const acted = this.bySession.get(sessionId) || {};
        acted[toolUseId] = {
            status,
            startedId: status === 'started' && typeof startedId === 'string' ? startedId : null,
            at: Date.now(),
        };
        this.bySession.set(sessionId, acted);
        this.save();
        return acted[toolUseId];
    }

    /**
     * Undo one — the card goes back to offering itself.
     *
     * Worth having because *dismissed* is the one of the two that is easy to hit
     * by accident, and the transcript still holds the suggestion, so there is
     * nothing stopping it being offered again.
     */
    clear(sessionId, toolUseId) {
        const acted = this.bySession.get(sessionId);
        if (!acted || !(toolUseId in acted)) return false;
        delete acted[toolUseId];
        if (!Object.keys(acted).length) this.bySession.delete(sessionId);
        this.save();
        return true;
    }

    /** Forget decisions about transcripts that no longer exist. */
    prune(liveIds) {
        let changed = false;
        for (const sessionId of [...this.bySession.keys()]) {
            if (!liveIds.has(sessionId)) { this.bySession.delete(sessionId); changed = true; }
        }
        if (changed) this.save();
        return changed;
    }
}

module.exports = { Suggestions, STATE_FILE, STATUSES };
