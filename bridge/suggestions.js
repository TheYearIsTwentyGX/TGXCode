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

/**
 * What can have happened to a suggestion. Anything else is ignored on load.
 *
 * `completed` is said, not detected. Nothing here can tell that a started
 * session's work is finished — a turn ending is not the task ending, and a merged
 * pull request is one repository's idea of done — so it is recorded when the
 * agent that did the work (or you) says so, through `set_task_status`.
 */
const STATUSES = new Set(['started', 'dismissed', 'completed']);

/** How a task was taken up: a session of its own, or inside the caller's. */
const VIAS = new Set(['session', 'subagent']);

// A note is a pointer — the pull request, one line on what was left — not a
// report. Capped so this file stays something you can open and read.
const MAX_NOTE = 500;

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
                        via: VIAS.has(entry.via) ? entry.via : null,
                        note: cleanNote(entry.note),
                        at: Number.isFinite(entry.at) ? entry.at : 0,
                    };
                }
                if (Object.keys(clean).length) this.bySession.set(sessionId, clean);
            }
        } catch (err) {
            console.error(`[tgxcode] ignoring unreadable ${STATE_FILE}: ${err.message}`);
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
                console.error(`[tgxcode] could not save suggestions: ${err.message}`);
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
     * is dropped there rather than stored as a lie. On a completion it is kept
     * from the start that preceded it when none is given: finishing a task does
     * not change who did it, and the link is still the useful part of the card.
     * `via` carries over the same way.
     */
    set(sessionId, toolUseId, { status, startedId = null, via = null, note = null } = {}) {
        if (!sessionId || !toolUseId || !STATUSES.has(status)) return null;
        const acted = this.bySession.get(sessionId) || {};
        const prior = acted[toolUseId] || null;
        const keeps = status === 'started' || status === 'completed';
        const given = typeof startedId === 'string' && startedId ? startedId : null;
        acted[toolUseId] = {
            status,
            startedId: keeps
                ? (given || (status === 'completed' && prior ? prior.startedId : null))
                : null,
            via: keeps
                ? (VIAS.has(via) ? via
                    : (status === 'completed' && prior ? prior.via : null))
                : null,
            note: cleanNote(note),
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

/** A short string or null. Trimmed and capped rather than refused. */
function cleanNote(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, MAX_NOTE) : null;
}

module.exports = { Suggestions, STATE_FILE, STATUSES, VIAS, MAX_NOTE };
