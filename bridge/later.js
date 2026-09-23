'use strict';

// Messages written now and delivered to an existing session later.
//
// The gap this fills sits between the two things that already existed. A
// *schedule* (bridge/schedule.js) starts a new session on a cron expression; a
// *send* (POST /api/sessions/:id/send) speaks to a session that is already
// there, immediately. Neither says "tell that session this at 02:00" — and that
// is a real thing to want, because some instructions are only true at an hour
// nobody is awake for. The case this was built for: an agent taking screenshots
// has to modify app data to do it, and the go-ahead should arrive in the middle
// of the night, when disturbing that data costs nothing.
//
// **A scheduled message is the body `/send` takes, held back until a timestamp.**
// That is the whole design, and it is drafts.js's relationship to
// `POST /api/sessions` one route over. It matters because it makes delivery the
// *send path* rather than a second one: the tick calls what the route calls, so
// "the clock delivers what the button delivers" is true by construction rather
// than by being careful. docs/plans/15-scheduling.md learned that for "Run now"
// and it is the same lesson.
//
// **Its own file rather than a field on a schedule row**, and that is not
// tidiness. `clean()` in schedule.js is a whitelist, and every bridge on this
// machine reads schedules.json on its 30s tick and writes it back through that
// whitelist — so a field a *running* older bridge has not heard of is stripped
// within half a minute of being written. schedule-runs.json exists for exactly
// this reason and this is the same move. Nothing else was shared anyway: no
// cron, no gate, no marker, no unattended() suffix.
//
// **Merge-on-write, not last-writer-wins** — drafts.js's bargain, copied whole,
// because the reason is identical and slightly sharper. Several bridges share
// STATE_DIR by design, a whole-file rewrite from a snapshot taken at startup
// erases every row another bridge has added since, and what would be lost is a
// message somebody wrote — work, not a cache. Deletions are tracked in
// `_removed` rather than inferred from absence, because "I do not have it" and
// "it was deleted" are the same shape and only one of them should remove a row.
//
// Three decisions in here that are easy to get backwards:
//
//   * **`delivering` is a claim on disk, and a row found in it at boot is
//     `failed`, never retried.** The bridge stopped between writing the claim and
//     hearing back, so the message may well have reached the process — `claude`
//     writes its user entry at submission. Re-delivering would re-run work the
//     transcript already shows, which is the mistake test/runner.test.js exists
//     to prevent one layer down. Failing loudly is the safe direction.
//   * **A terminal row is kept for a week, but a cancel is a delete.** "Sent at
//     02:00" and "missed" are things you come back in the morning to read; a
//     message you thought better of is not.
//   * **`test` is copied off the session, not chosen.** It decides which bridge
//     delivers the row — the everyday one, or a dev one — and the answer is
//     already written down as a property of the session it is aimed at.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { STATE_DIR } = require('./config');

const STATE_FILE = path.join(STATE_DIR, 'later.json');
const VERSION = 1;

/**
 * How late a message may be and still be worth delivering.
 *
 * Deliberately far tighter than the schedule tick's 12-hour CATCHUP_MS, and the
 * difference is not a matter of taste. A *session* started seven hours late is
 * merely late — it does the same work, later. An *instruction* seven hours late
 * is the wrong instruction: "you may now modify app data" is true at 02:00 and
 * false at 09:00, and it arrives carrying the permission to act on itself. So a
 * message past this window is reported rather than sent.
 */
const LATE_MS = 60 * 60 * 1000;

/** How long a delivered, missed or failed row stays around to be read. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Per session, so one runaway client cannot fill the file. Not a lifetime budget. */
const MAX_PER_SESSION = 20;

/** Far enough out that no real use meets it; near enough that a typo'd year is a 400. */
const MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/** At most five, matching what the send route accepts. */
const MAX_ATTACHMENTS = 5;

/**
 * pending    — waiting for its time
 * delivering — claimed by a tick, not yet answered
 * sent       — handed to the runner
 * missed     — its window closed before it could be delivered
 * failed     — the delivery was attempted and did not work
 */
const STATES = new Set(['pending', 'delivering', 'sent', 'missed', 'failed']);

/** The states nothing will happen to again. */
const TERMINAL = new Set(['sent', 'missed', 'failed']);

/** `null` unless it is a non-empty string. */
function orNull(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s || null;
}

/**
 * The attachment list, in the send route's shape.
 *
 * Paths only — every one of these is already on disk, written by the attachments
 * route before its chip appeared, so there is nothing to hold in memory
 * overnight. They are re-derived against the session's own directory at delivery
 * exactly as `/send` re-derives them, so a path stored here is a hint and not an
 * authority.
 */
function cleanAttachments(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const a of v) {
        if (!a || typeof a.path !== 'string' || !a.path) continue;
        out.push({
            path: a.path,
            relPath: orNull(a.relPath),
            mediaType: orNull(a.mediaType),
        });
        if (out.length >= MAX_ATTACHMENTS) break;
    }
    return out;
}

/**
 * The fields a scheduled message carries.
 *
 * Spelled out rather than spread, so a caller cannot smuggle a key into the store
 * by putting it in a request body — `update` takes a patch straight off the wire.
 * drafts.js's rule, and schedule.js's, for the same reason.
 */
function clean(row) {
    return {
        id: row.id,
        sessionId: row.sessionId,
        // Where the session was working when this was written. Re-resolved at
        // delivery from the session itself, so this is for display and for saying
        // something useful when a checkout has moved.
        cwd: row.cwd,
        text: row.text,
        attachments: row.attachments,
        // Null is `inherit`, the composer's own default.
        model: row.model,
        // Never defaulted at delivery. /send's documented trap is that an absent
        // mode normalises to `auto`; doing that silently, six hours after the
        // message was written, would pick the one mode that cannot work when
        // nobody is watching — see the delivery notes in server.js.
        permissionMode: row.permissionMode,
        at: row.at,
        state: row.state,
        test: row.test,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        sentAt: row.sentAt,
        error: row.error,
    };
}

/** Soonest first: the order they will happen in, which is the order to read them in. */
const byDue = (a, b) => a.at - b.at || a.createdAt - b.createdAt;

/**
 * The file as rows, or an empty list.
 *
 * Module-level rather than a method because `flush()` needs it too, to merge over
 * whatever another bridge has written since this one loaded — drafts.js's header
 * explains why at length.
 */
function read() {
    let raw;
    try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return []; }
    try {
        // Tolerate a BOM, as flags.js and drafts.js do: this file holds messages
        // somebody wrote, which makes it one of the few here worth opening.
        const data = JSON.parse(raw.replace(/^﻿/, ''));
        if (data.version !== VERSION) return [];
        const rows = Array.isArray(data.messages) ? data.messages : [];
        const out = [];
        for (const row of rows) {
            // The fields without which the row cannot do anything. Dropped rather
            // than repaired: there is no session to invent and no time to invent.
            if (!row || typeof row.id !== 'string') continue;
            if (typeof row.sessionId !== 'string' || !row.sessionId) continue;
            if (!Number.isFinite(row.at)) continue;
            const text = typeof row.text === 'string' ? row.text : '';
            const attachments = cleanAttachments(row.attachments);
            // A message with neither is one that cannot be sent — the send route
            // refuses exactly this pair.
            if (!text.trim() && !attachments.length) continue;
            out.push(clean({
                id: row.id,
                sessionId: row.sessionId,
                cwd: typeof row.cwd === 'string' ? row.cwd : '',
                text,
                attachments,
                model: orNull(row.model),
                // Not checked against PERMISSION_MODES here, for the reason
                // drafts.js gives: every route runs it through normalizeMode on
                // the way in and the delivery runs it again on the way out, so a
                // mode this file cannot vouch for still cannot reach `claude`.
                permissionMode: typeof row.permissionMode === 'string'
                    ? row.permissionMode : 'auto',
                at: row.at,
                state: STATES.has(row.state) ? row.state : 'pending',
                test: !!row.test,
                createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
                updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
                sentAt: Number.isFinite(row.sentAt) ? row.sentAt : null,
                error: orNull(row.error),
            }));
        }
        return out.sort(byDue);
    } catch (err) {
        console.error(`[tgxcode] ignoring unreadable ${STATE_FILE}: ${err.message}`);
        return [];
    }
}

class Later {
    constructor() {
        /** @type {Array<object>} soonest-due first; see list(). */
        this.rows = [];
        /**
         * Ids this bridge has deleted, held until the write that carries the
         * deletion out. Without it a merge could not tell a row we removed from
         * one another bridge has just added.
         * @type {Set<string>}
         */
        this._removed = new Set();
        this._saveTimer = null;
        this.load();
    }

    load() {
        this.rows = read();
    }

    /**
     * Re-read the file, keeping nothing.
     *
     * The tick calls this first, for the reason schedule.js's tick does: a message
     * written on a dev bridge or from a phone has to be *seen* by the bridge that
     * will deliver it, and the two processes only meet through this file.
     */
    reload() {
        this.flush();
        this.load();
    }

    /** Debounced atomic write — flags.js's shape, for its reason. */
    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => this.flush(), 400);
        this._saveTimer.unref();
    }

    /**
     * Write now, whatever the debounce was waiting for, merging over the file.
     *
     * Load-bearing at shutdown, and more so here than for a draft: the process can
     * exit well inside the debounce window, and an unflushed `delivering` claim
     * would come back up looking like `pending` — which is the one transition this
     * store must never make, because the message may already be in the transcript.
     */
    flush() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        try {
            // Start from disk so another bridge's rows survive, then let ours win
            // per id — but only where ours is not older, so a snapshot taken before
            // somebody else's edit cannot undo it.
            const merged = new Map(read().map(r => [r.id, r]));
            for (const row of this.rows) {
                const theirs = merged.get(row.id);
                if (!theirs || row.updatedAt >= theirs.updatedAt) merged.set(row.id, row);
            }
            for (const id of this._removed) merged.delete(id);
            this._removed.clear();

            const rows = [...merged.values()].sort(byDue);
            fs.mkdirSync(STATE_DIR, { recursive: true });
            const tmp = STATE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, messages: rows }, null, 2));
            fs.renameSync(tmp, STATE_FILE);
        } catch (err) {
            console.error(`[tgxcode] could not save scheduled messages: ${err.message}`);
        }
    }

    _sort() {
        this.rows.sort(byDue);
    }

    /**
     * A timestamp strictly greater than every row this store holds.
     *
     * drafts.js's `_stamp`, and its reasoning applies unchanged: two writes in the
     * same millisecond are ordinary, they would compare equal, and "newest
     * updatedAt wins" would then stop being a rule that always decides — which is
     * what the merge in flush() is built on.
     */
    _stamp() {
        const now = Date.now();
        let newest = 0;
        for (const r of this.rows) if (r.updatedAt > newest) newest = r.updatedAt;
        return now > newest ? now : newest + 1;
    }

    list() {
        return this.rows.map(clean);
    }

    /** One session's messages, soonest first. */
    forSession(sessionId) {
        return this.rows.filter(r => r.sessionId === sessionId).map(clean);
    }

    /**
     * What a rail row needs: how many are waiting, and when the first one lands.
     *
     * Null rather than a zero row, so a client tests one field instead of two, and
     * so the summary of a session with nothing pending — which is nearly every
     * session — carries nothing.
     *
     * A scan per session rather than a Map built once, although sessions.js calls
     * this while building every summary. The list is bounded at 20 per session and
     * pruned of everything terminal after a week, so in practice it holds a handful
     * of rows; an index would be machinery guarding an array walk.
     *
     * @returns {{pending: number, nextAt: number}|null}
     */
    pendingFor(sessionId) {
        let pending = 0;
        let nextAt = 0;
        for (const r of this.rows) {
            if (r.state !== 'pending' || r.sessionId !== sessionId) continue;
            pending++;
            if (!nextAt || r.at < nextAt) nextAt = r.at;
        }
        return pending ? { pending, nextAt } : null;
    }

    get(id) {
        const row = this.rows.find(r => r.id === id);
        return row ? clean(row) : null;
    }

    /** How many are still waiting for one session, for the route's ceiling. */
    pendingCount(sessionId) {
        return this.rows.filter(r => r.sessionId === sessionId && r.state === 'pending').length;
    }

    /**
     * @returns {object|null} the message, or null when this session is at its
     *   ceiling — which the route turns into a 409. Null rather than a throw so
     *   the caller does not have to read a message to tell the two apart.
     */
    create({ sessionId, cwd, text, attachments, model, permissionMode, at, test } = {}) {
        if (this.pendingCount(sessionId) >= MAX_PER_SESSION) return null;
        const now = this._stamp();
        const row = clean({
            id: randomUUID(),
            sessionId: String(sessionId),
            cwd: String(cwd || ''),
            text: String(text || ''),
            attachments: cleanAttachments(attachments),
            model: orNull(model),
            permissionMode: String(permissionMode || 'auto'),
            at: Number(at),
            state: 'pending',
            test: !!test,
            createdAt: now,
            updatedAt: now,
            sentAt: null,
            error: null,
        });
        this.rows.push(row);
        this._sort();
        this.save();
        return clean(row);
    }

    /**
     * Apply a partial change to a message that has not gone yet.
     *
     * A genuine patch, drafts.js's rule: a key absent from `fields` is left alone,
     * `undefined` is absence and `null` is a value. Rescheduling therefore does not
     * have to restate the mode, which is the trap `/send` has and the reason that
     * route is a POST and this one is a PATCH.
     *
     * Refuses a row that is no longer `pending`: editing the text of a message
     * already handed to a process would be editing the past.
     *
     * @returns {object|null|{conflict: string}} the row, null for an unknown id, or
     *   the state that refused it.
     */
    update(id, fields = {}) {
        const row = this.rows.find(r => r.id === id);
        if (!row) return null;
        if (row.state !== 'pending') return { conflict: row.state };

        if (fields.text !== undefined) row.text = String(fields.text);
        if (fields.attachments !== undefined) {
            row.attachments = cleanAttachments(fields.attachments);
        }
        if (fields.model !== undefined) row.model = orNull(fields.model);
        if (fields.permissionMode !== undefined) {
            row.permissionMode = String(fields.permissionMode);
        }
        if (fields.at !== undefined) row.at = Number(fields.at);

        // `createdAt` is deliberately untouched: it is when you wrote this.
        row.updatedAt = this._stamp();
        this._sort();
        this.save();
        return clean(row);
    }

    /**
     * Everything due now, soonest first.
     *
     * Only `pending` rows, and only ones whose time has come — being *late* is not
     * this function's business, because the caller has to tell "deliver it" from
     * "report it missed" and both of those start here.
     */
    due(now = Date.now()) {
        return this.rows.filter(r => r.state === 'pending' && r.at <= now).map(clean);
    }

    /**
     * Take a message, on disk, before anything that can throw or block.
     *
     * The order is the bug docs/plans/15-scheduling.md records under section C: an
     * exception *after* the claim loses the run silently, because the claim says it
     * happened and nothing says it did not. So the claim goes down first and the
     * caller's catch is what turns a throw into a recorded failure — and two ticks
     * overlapping on one row cannot both reach the send.
     *
     * @returns {boolean} false if somebody got there first.
     */
    claim(id) {
        const row = this.rows.find(r => r.id === id);
        if (!row || row.state !== 'pending') return false;
        row.state = 'delivering';
        row.updatedAt = this._stamp();
        this.flush();          // on disk now, not in 400ms
        return true;
    }

    /** Record how it went. `state` is normally one of the terminal three. */
    note(id, { state, error = null, sentAt = null } = {}) {
        const row = this.rows.find(r => r.id === id);
        if (!row) return null;
        if (STATES.has(state)) row.state = state;
        if (error !== null) row.error = orNull(error);
        if (sentAt !== null) row.sentAt = sentAt;
        row.updatedAt = this._stamp();
        this.save();
        return clean(row);
    }

    /**
     * Put a claimed row back, for the one case where nothing was attempted.
     *
     * Only safe because the caller has not written to the process yet — the tick
     * claims before it looks at whether the session is reachable, and "held in a
     * terminal" is an answer that says to try again rather than to give up. Any
     * release *after* a send would be the double-delivery this store is built to
     * make impossible, which is why recover() exists and does the opposite.
     */
    release(id) {
        const row = this.rows.find(r => r.id === id);
        if (!row || row.state !== 'delivering') return false;
        row.state = 'pending';
        row.updatedAt = this._stamp();
        this.flush();
        return true;
    }

    /**
     * Rows this bridge left mid-delivery when it stopped.
     *
     * Called once at boot, *before* the first tick, the way
     * `recoverInterruptedReviews()` runs before the schedule tick and for the same
     * reason. They are marked failed and **never retried**: the bridge died
     * somewhere between writing the claim and hearing back, so the message may
     * already be in the transcript — `claude` writes its user entry at submission.
     * Re-sending would re-run work that has already happened, which is the more
     * expensive of the two mistakes.
     *
     * **`owns` is not optional in practice, and leaving it out is a bug with a
     * cross-bridge blast radius.** Every bridge on this machine shares STATE_DIR,
     * so an ungated pass here would let a dev bridge booting at 02:00:05 mark the
     * *everyday* bridge's in-flight message as failed — a message that is being
     * delivered perfectly well, one process over. The caller passes the same
     * dev/test rule the tick applies, so a bridge only ever recovers claims it
     * could have written.
     *
     * @param {(row: object) => boolean} [owns] which rows are this bridge's
     * @returns {Array<object>} what was recovered, so the caller can notify.
     */
    recover(owns = () => true) {
        const stuck = this.rows.filter(r => r.state === 'delivering' && owns(r));
        for (const row of stuck) {
            row.state = 'failed';
            row.error = 'the bridge stopped while this was being delivered; it was '
                + 'not sent again, because it may already have arrived';
            row.updatedAt = this._stamp();
        }
        if (stuck.length) this.flush();
        return stuck.map(clean);
    }

    /**
     * Drop what nothing will read again.
     *
     * Two arms, and neither is "is it old". A row whose session is gone has nothing
     * to be delivered to — suggestions.js prunes against the same set for the same
     * reason. A terminal row is kept a week because "sent at 02:00" and "missed"
     * are things you come back in the morning to read, and after that they are
     * noise.
     *
     * @param {Set<string>|null} knownIds every session this bridge can see, or null
     *   to skip that arm — the index is not always ready, and pruning against an
     *   empty set would delete everything.
     */
    prune(knownIds = null, now = Date.now()) {
        const before = this.rows.length;
        this.rows = this.rows.filter(r => {
            if (knownIds && !knownIds.has(r.sessionId)) { this._removed.add(r.id); return false; }
            if (TERMINAL.has(r.state) && now - r.updatedAt > KEEP_MS) {
                this._removed.add(r.id); return false;
            }
            return true;
        });
        const gone = before - this.rows.length;
        if (gone) this.save();
        return gone;
    }

    /**
     * Cancel one.
     *
     * A hard delete rather than a `cancelled` state, which is the one place this
     * differs from how a delivery is recorded: a message you thought better of is
     * not something you come back to read, where "it was sent" and "it was missed"
     * both are.
     */
    remove(id) {
        const at = this.rows.findIndex(r => r.id === id);
        if (at < 0) return false;
        this.rows.splice(at, 1);
        // Remembered until the write goes out: the merge in flush() starts from the
        // file, so without this the row would be read straight back in and re-saved.
        this._removed.add(id);
        this.save();
        return true;
    }

    /** Every row for one session, gone. Called when the session itself is deleted. */
    forget(sessionId) {
        const keep = [];
        let gone = 0;
        for (const row of this.rows) {
            if (row.sessionId === sessionId) { this._removed.add(row.id); gone++; }
            else keep.push(row);
        }
        this.rows = keep;
        if (gone) this.save();
        return gone;
    }
}

module.exports = {
    Later, STATE_FILE, LATE_MS, KEEP_MS,
    MAX_PER_SESSION, MAX_AHEAD_MS, MAX_ATTACHMENTS, STATES, TERMINAL,
};
