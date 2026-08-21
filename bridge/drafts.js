'use strict';

// Sessions you have set up but not started.
//
// The Start-a-session dialog was all-or-nothing: a working directory, a first
// message, a model and a permission mode, and the only button that kept any of it
// was Start. But work gets set up while it is still blocked — waiting on a merge,
// waiting on quota, waiting on a decision somewhere else — and the only options
// were to start it anyway or to keep it in your head.
//
// So a draft is a *whole* create call held back: exactly the fields
// `POST /api/sessions` takes, validated the same way, waiting for you to press
// Start. Not a note about a session — the session itself, minus the process.
//
// **This is state the app owns**, so it lives beside flags.json for the reason
// flags.js gives: losing it would lose real work rather than a cache. A draft is
// several minutes of setting-up, which makes it the most expensive thing in this
// directory to lose.
//
// **Nothing here is derived and nothing here is pruned.** The two neighbours both
// key on a session id and so both need a prune() — suggestions.js against tool
// ids, flags.js against transcripts. A draft is not about a session; it is one
// that does not exist yet, so there is nothing for it to go stale against. What
// *can* go stale is its `cwd`, and that is deliberately not swept: a checkout you
// moved is a draft you still want, and the start refuses with the real reason.
//
// **Merge-on-write, not last-writer-wins** — ports.js's bargain rather than
// flags.js's, and the choice matters more here than in either.
//
// Several bridges run at once on this machine by design: the everyday one on
// 45888 with the user's real drafts in it, and a development bridge per agent.
// They share this file. A straight whole-file rewrite from a snapshot taken at
// startup would mean the *first write by any bridge erases every draft made in
// another since that bridge booted* — so an agent's dev bridge saving one test
// draft could take the afternoon's real ones with it. That is not a collision
// costing one edit to undo, which is the bargain flags.js and suggestions.js
// strike; it is losing work, and a draft is the most expensive thing in this
// directory precisely because it is work rather than a decision.
//
// So `flush()` reads the file back, merges by id, and writes the union. Per id
// the newer `updatedAt` wins, so a stale copy cannot overwrite somebody's later
// edit either. Deletions are tracked in `_removed` rather than inferred from
// absence, because "I do not have it" and "it was deleted" are the same shape and
// only one of them should remove a row.
//
// **What this deliberately does not fix:** a draft another bridge deleted, that
// this one still holds in memory, comes back on the next write here. Telling that
// apart needs tombstones on disk, and the failure it would prevent is a stale card
// you delete a second time — much cheaper than the machinery, and far cheaper than
// the loss above. A bridge also does not *see* another's drafts until it reloads;
// each window is consistent with itself, which is the same deal the rest of the
// state directory offers.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { STATE_DIR } = require('./config');

const STATE_FILE = path.join(STATE_DIR, 'drafts.json');
const VERSION = 1;

// High enough that nobody meets it by working, low enough that a client in a
// loop cannot grow the file without bound. A person with two hundred drafts has
// a different problem than this feature solves.
const MAX_DRAFTS = 200;

/**
 * The fields a draft carries, which are exactly the fields a create call takes.
 *
 * Spelled out rather than spread, so a caller cannot smuggle a key into the store
 * by putting it in a request body — `update` takes a patch straight off the wire.
 */
function clean(row) {
    return {
        id: row.id,
        cwd: row.cwd,
        prompt: row.prompt,
        // Null means "derive it from the first line of the prompt", which is what
        // every client does. Stored rather than derived here because a title you
        // typed is a decision and the first line of a prompt is a guess.
        title: row.title,
        // Null is `inherit`, the dialog's own default — the absence of a choice
        // rather than a choice of nothing.
        model: row.model,
        permissionMode: row.permissionMode,
        test: row.test,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/** `null` unless it is a non-empty string. Used for the two optional strings. */
function orNull(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s || null;
}

/** Newest-updated first, which is the order a client draws them in. */
const byUpdated = (a, b) => b.updatedAt - a.updatedAt;

/**
 * The file as rows, or an empty list.
 *
 * Module-level rather than a method because `flush()` needs it too, to merge over
 * whatever another bridge has written since this one loaded — see the header. It
 * returns rather than assigns for the same reason.
 */
function read() {
    let raw;
    try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return []; }
    try {
        // Tolerate a BOM, as flags.js does: this file is plain enough that
        // somebody may open it to see what is in there — and a draft is the one
        // thing here worth reading, being a message you wrote.
        const data = JSON.parse(raw.replace(/^﻿/, ''));
        if (data.version !== VERSION) return [];
        const rows = Array.isArray(data.drafts) ? data.drafts : [];
        const out = [];
        for (const row of rows) {
            // The two fields without which a draft cannot do anything. A row
            // missing either is dropped rather than repaired: there is no
            // sensible cwd to invent and no message to invent either.
            if (!row || typeof row.id !== 'string') continue;
            if (typeof row.cwd !== 'string' || !row.cwd) continue;
            if (typeof row.prompt !== 'string' || !row.prompt) continue;
            out.push(clean({
                id: row.id,
                cwd: row.cwd,
                prompt: row.prompt,
                title: orNull(row.title),
                model: orNull(row.model),
                // Not checked against PERMISSION_MODES here, and it does not need
                // to be: every route runs it through normalizeMode both when a
                // draft is written and again when it is started, so a mode this
                // file cannot vouch for still cannot reach `claude`. Rejecting it
                // here as well would only mean silently dropping a draft if the
                // list of modes is ever renamed upstream.
                permissionMode: typeof row.permissionMode === 'string'
                    ? row.permissionMode : 'auto',
                test: !!row.test,
                createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
                updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
            }));
        }
        return out.sort(byUpdated);
    } catch (err) {
        console.error(`[claude-sessions] ignoring unreadable ${STATE_FILE}: ${err.message}`);
        return [];
    }
}

class Drafts {
    constructor() {
        /** @type {Array<object>} newest-updated first; see list(). */
        this.rows = [];
        /**
         * Ids this bridge has deleted, held until the write that carries the
         * deletion out. Without it a merge could not tell a row we removed from
         * one another bridge has just added — see the header.
         * @type {Set<string>}
         */
        this._removed = new Set();
        this._saveTimer = null;
        this.load();
    }

    load() {
        this.rows = read();
    }

    /** Debounced atomic write — the shape flags.js uses, for the same reason. */
    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => this.flush(), 400);
        this._saveTimer.unref();
    }

    /**
     * Write now, whatever the debounce was waiting for, merging over the file.
     *
     * Split out of save() rather than left inside its callback so that a caller
     * which cannot wait 400ms can make the write happen: the test, and the
     * bridge's own shutdown — where it is load-bearing, because the process exits
     * well inside the debounce window, and an unflushed deletion would bring a
     * draft that has already been started back to be started a second time.
     */
    flush() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        try {
            // Start from disk so another bridge's rows survive, then let ours win
            // per id — but only where ours is not older, so a snapshot taken
            // before somebody else's edit cannot undo it.
            const merged = new Map(read().map(r => [r.id, r]));
            for (const row of this.rows) {
                const theirs = merged.get(row.id);
                if (!theirs || row.updatedAt >= theirs.updatedAt) merged.set(row.id, row);
            }
            for (const id of this._removed) merged.delete(id);
            this._removed.clear();

            const rows = [...merged.values()].sort(byUpdated);
            fs.mkdirSync(STATE_DIR, { recursive: true });
            const tmp = STATE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, drafts: rows }, null, 2));
            fs.renameSync(tmp, STATE_FILE);
        } catch (err) {
            console.error(`[claude-sessions] could not save drafts: ${err.message}`);
        }
    }

    /**
     * Newest-updated first.
     *
     * The order a card is *placed* in, and the client takes it once — the rail's
     * rule for the rail's reason. Editing a draft is what moves it, which is news
     * rather than noise: you have just been working on it.
     */
    _sort() {
        this.rows.sort(byUpdated);
    }

    /**
     * A timestamp strictly greater than every row this store holds.
     *
     * `Date.now()` alone is not enough, and the reason is not theoretical: two
     * writes in the same millisecond are ordinary — a create followed by an edit,
     * or a burst from a script — and they would compare *equal*. Two things then
     * break at once. The list order becomes whatever the sort happened to do with
     * a tie, and worse, the merge in flush() cannot tell a newer edit from an
     * older one, so a stale row from another bridge could roll back an edit it
     * never saw. Making the stamp strictly increasing removes both, and means
     * "newest updatedAt wins" is a rule that always decides.
     *
     * Still a wall-clock time, and still what the card shows: it only ever runs
     * ahead when the clock has not moved, and then by a millisecond at a time.
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

    get(id) {
        const row = this.rows.find(r => r.id === id);
        return row ? clean(row) : null;
    }

    /**
     * @returns {object|null} the draft, or null when the cap is reached — which
     *   the route turns into a 409. Null rather than a throw so the one caller
     *   that has to tell the two apart does not have to read a message.
     */
    create({ cwd, prompt, title, model, permissionMode, test } = {}) {
        if (this.rows.length >= MAX_DRAFTS) return null;
        const now = this._stamp();
        const row = clean({
            id: randomUUID(),
            cwd: String(cwd),
            prompt: String(prompt),
            title: orNull(title),
            model: orNull(model),
            permissionMode: String(permissionMode || 'auto'),
            test: !!test,
            // The same stamp for both, so a draft nobody has edited reads as
            // untouched rather than as edited the instant it was made.
            createdAt: now,
            updatedAt: now,
        });
        this.rows.push(row);
        this._sort();
        this.save();
        return clean(row);
    }

    /**
     * Apply a partial change.
     *
     * A genuine patch: a key absent from `fields` is left alone, which is what
     * lets a client send only what the person edited. `undefined` is the absence
     * and `null` is a value — clearing a title means sending `null`.
     */
    update(id, fields = {}) {
        const row = this.rows.find(r => r.id === id);
        if (!row) return null;

        if (fields.cwd !== undefined) row.cwd = String(fields.cwd);
        if (fields.prompt !== undefined) row.prompt = String(fields.prompt);
        if (fields.title !== undefined) row.title = orNull(fields.title);
        if (fields.model !== undefined) row.model = orNull(fields.model);
        if (fields.permissionMode !== undefined) {
            row.permissionMode = String(fields.permissionMode);
        }
        if (fields.test !== undefined) row.test = !!fields.test;

        // `createdAt` is deliberately untouched: it is when you first wrote this
        // down, and the card says how long it has been waiting.
        row.updatedAt = this._stamp();
        this._sort();
        this.save();
        return clean(row);
    }

    remove(id) {
        const at = this.rows.findIndex(r => r.id === id);
        if (at < 0) return false;
        this.rows.splice(at, 1);
        // Remembered until the write goes out. The merge in flush() starts from
        // the file, so without this the row we just dropped would be read straight
        // back in and re-saved.
        this._removed.add(id);
        this.save();
        return true;
    }
}

module.exports = { Drafts, STATE_FILE, MAX_DRAFTS };
