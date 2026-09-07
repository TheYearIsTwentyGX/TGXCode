'use strict';

// Canned messages you send more than once.
//
// The composer had one button that was not Send, and it sent a specific paragraph
// about opening a pull request and merging it. It was a good paragraph. It was
// also a hard-coded string in web/app.js, which meant the second canned message
// anybody wanted cost a code change, and the third one cost an argument about
// which two deserved buttons.
//
// So a snippet is that paragraph with the specialness taken out: a title, a body,
// and the three decisions the LGTM button had already made silently — that it
// replaces whatever is in the box rather than adding to it, that it sends itself
// rather than waiting, and that it is worth a button of its own rather than a
// place in a list. Those are now `insert`, `autoSubmit` and `pinned`, and LGTM
// ships as a row in this file with all three set the way the button had them.
//
// **Placeholders are declared, not discovered.** `{{branch}}` in a body means
// nothing on its own; a `params` entry named `branch` is what makes it a question
// the composer asks. The two are deliberately allowed to disagree in both
// directions — a declared param nothing references is a field you have not wired
// up yet, and an undeclared `{{x}}` is left in the message verbatim. That second
// rule is `fillPrompt`'s in schedule.js, down to the regular expression, and it is
// there for the reason that function gives: `{{` is not reserved punctuation in
// prose, and blanking what this file does not recognise would quietly delete part
// of a message somebody wrote. A typo'd `{{brnach}}` arriving in the session as
// itself is a bug you can see.
//
// **Global, not per-scope.** A snippet is a thing you type, and you type the same
// things in every project. The one concession is `projects`: directories a snippet
// is *for*, prefix-matched, empty meaning everywhere — because "deploy to staging"
// is a real snippet and it is a mistake in the wrong repository.
//
// **Two arrays in one file, not two files.** A group is nothing on its own — it is
// an accent colour and a heading for the snippets in it — and both are read
// together on every draw. Splitting them would buy nothing and cost a second file
// to keep in step.
//
// **This is state the app owns**, so it lives beside drafts.json for drafts.js's
// reason: losing it would lose real work rather than a cache, and a snippet is a
// paragraph somebody wrote and rewrote.
//
// **Merge-on-write, not last-writer-wins** — drafts.js's bargain, copied from it
// wholesale along with the `_removed` tombstone sets, the strictly-increasing
// `_stamp()`, the BOM tolerance, the version check and the atomic rename. Its
// header argues them at length; the short version is that several bridges run here
// at once by design and share this directory, so a whole-file rewrite from a
// startup snapshot would let an agent's dev bridge take the afternoon's real edits
// with it.
//
// **Order is a stored decision, not a derived one**, which is the one real
// departure from drafts.js. Every other store here sorts newest-first, because
// every other store holds things that happen. These are things you arrange: the
// popover draws them in the order you put them in, and `order: null` means "you
// have not said", which sorts alphabetically after everything that was placed by
// hand. Nulls are never interleaved with numbers — an explicit order is a decision
// and null is the absence of one, and a rule that guessed where the absence goes
// would move rows around when an unrelated snippet was numbered.
//
// **Seeding is recorded, not inferred.** `seeded` is the list of shipped ids this
// file has already been offered, and an id in it is never offered again whatever
// the arrays currently hold. That buys three things that the obvious rule — seed
// when the file is missing — does not. A store you emptied stays empty, and stays
// empty because a fact was written down rather than because a file happened to
// survive. A second shipped snippet can arrive in a later build and reach
// everybody without bringing back the one they threw away. And `rm snippets.json`
// is an honest escape hatch that gives you the shipped rows again, which is the
// same deal spinner.js offers for ~/.tgxcode/verbs/.
//
// **What this deliberately does not fix:** drafts.js's tombstone gap, unchanged —
// a row another bridge deleted, that this one still holds in memory, comes back on
// the next write here, and costs you deleting a card a second time. And two
// bridges booting into an absent file in the same instant both seed; the ids are
// stable rather than UUIDs, so the merge dedupes and you get one LGTM rather than
// two.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { STATE_DIR, expandHome } = require('./config');

const STATE_FILE = path.join(STATE_DIR, 'snippets.json');
const VERSION = 1;

// Caps, and the arithmetic behind them. The whole list is the SSE payload —
// `snippets-changed` carries it the way `drafts-changed` does — so the ceiling is
// not "how much fits in a file", it is "how much is pushed to every open window on
// every save". 200 x 20000 is the worst case and nobody is anywhere near it; the
// real list is a dozen.
const MAX_SNIPPETS = 200;
const MAX_GROUPS = 40;
const MAX_PARAMS = 20;
const MAX_PROJECTS = 20;
const MAX_TITLE = 200;

// A snippet is a message, and the composer will take a long one. LGTM is about
// 1100 characters. This is a guard against a client pasting a transcript into the
// store, not a style rule.
const MAX_BODY = 20000;

/**
 * How a snippet lands in the compose box.
 *
 * Three values, and `overwrite` is the one that can destroy something — which is
 * why an unrecognised value is a refusal at the route rather than a normalisation,
 * unlike a param's `type`. There is no fallback here that is both the natural
 * default and harmless. On the way in from disk it still normalises, because a
 * hand-edited file has to load and every field has to have a value.
 */
const INSERT_STYLES = ['overwrite', 'append', 'cursor'];

/**
 * What a parameter asks for.
 *
 * Each one is a real `<input type>` in the client, which is the point: asking for
 * a date should get a date picker rather than a box somebody types 3/4/26 into.
 * `integer` and `decimal` differ only in the `step` the client sets, but they are
 * two names because "how many" and "how much" are two questions.
 *
 * **Extensible by design**, which is why an unknown type reads as `text` rather
 * than dropping the param: a snippet written on a build that knows one more type
 * should still load and stay editable on a build that does not. `text` is the safe
 * widening — every value is a string by the time it reaches the body anyway.
 */
const PARAM_TYPES = ['text', 'integer', 'decimal', 'date', 'time', 'datetime'];

/**
 * The placeholder syntax, which is `fillPrompt`'s in bridge/schedule.js.
 *
 * Deliberately the same expression rather than one that merely looks like it: two
 * placeholder syntaxes in one app is one too many, and a param name this cannot
 * capture is a name you could never reference from a body.
 */
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * A parameter name, which is also what `{{name}}` has to match.
 *
 * `\w+` is what PLACEHOLDER captures, so a name outside it could never be
 * referenced. Leading digits are excluded on top of that: `{{2}}` reads as a
 * position rather than a name, and this is not a positional syntax.
 */
const PARAM_NAME_RE = /^[A-Za-z_]\w*$/;

/**
 * A group's accent, as `#abc` or `#aabbcc` and nothing else.
 *
 * Strict because of where it ends up: the client sets it as a CSS custom property
 * on the group's card, so anything this accepts becomes a declaration in the
 * page's stylesheet. `red`, `var(--x)` and `#fff;}` are all refused for that one
 * reason, not for tidiness.
 *
 * A literal colour rather than a name from the palette in styles.css, which is the
 * other way this could have gone and is worth saying out loud: a name would
 * survive a restyle, and would keep every group inside a set of six that already
 * work against these surfaces. It is a colour because a group's accent is the one
 * thing about a group somebody picks for pleasure, and six is not a choice. The
 * client mixes it against its own surface rather than painting it raw, so a badly
 * chosen one is muted rather than loud.
 */
const ACCENT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const isParamName = (v) => typeof v === 'string' && PARAM_NAME_RE.test(v);
const isAccent = (v) => typeof v === 'string' && ACCENT_RE.test(v);

/** `null` unless it is a non-empty string, trimmed. Names, labels, titles. */
function orNull(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s || null;
}

/**
 * `null` unless it is a non-empty string, **untrimmed**. Bodies and defaults.
 *
 * Two helpers rather than a flag, because the distinction is not stylistic: a
 * label with a trailing space is a typo, and a default value with one may be the
 * point — a default is inserted into a message verbatim, and so is a body, whose
 * leading and trailing whitespace is part of what `append` and `cursor` mean.
 */
function textOrNull(v) {
    return typeof v === 'string' && v !== '' ? v : null;
}

/** An integer, or null for "no opinion" — which is what `order` mostly is. */
function intOrNull(v) {
    return Number.isInteger(v) ? v : null;
}

/**
 * One declared parameter, or null if it is not usable.
 *
 * A param's identity *is* its name — that is what `{{name}}` looks up — so a name
 * this cannot capture means a param that can never be referenced, and there is
 * nothing to keep. Dropped rather than repaired, which is `cleanReviewed`'s call
 * in schedule.js and made for the same reason: a malformed entry does not fail
 * loudly, it silently produces a field nothing fills, and dropping it puts the raw
 * `{{name}}` back in the message where somebody can see it.
 */
function cleanParam(p) {
    if (!p || typeof p !== 'object') return null;
    const name = orNull(p.name);
    if (!name || !isParamName(name)) return null;
    return {
        name,
        // Null means "use the name". A label you typed is a decision and a name is
        // an identifier; showing one where the other belongs is the argument
        // drafts.js makes about a draft's title.
        label: orNull(p.label),
        type: PARAM_TYPES.includes(p.type) ? p.type : 'text',
        // Means "may not be left empty when the dialog is confirmed". A `default`
        // pre-fills the box and nothing more, so the two are not in conflict: a
        // required param with a default is one you can clear and must then refill.
        required: !!p.required,
        default: textOrNull(p.default),
    };
}

/** The declared parameters, dropping what cannot be used, capped. */
function cleanParams(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const p of list) {
        if (out.length >= MAX_PARAMS) break;
        const param = cleanParam(p);
        // A duplicate name is not worth refusing a whole snippet over, but only
        // the first can win: two boxes writing one placeholder is a question with
        // no answer.
        if (!param || seen.has(param.name)) continue;
        seen.add(param.name);
        out.push(param);
    }
    return out;
}

/**
 * The directories a snippet is for, expanded and resolved — and **not checked**.
 *
 * Deliberately not `resolveWorkdir`, which is what every other path in this app
 * goes through. That one throws for a directory which does not exist or lies
 * outside the allowed roots, and both refusals are wrong here: this is a filter,
 * not somewhere a process is about to be started. A checkout you have not cloned
 * on this machine yet is exactly a directory you want a snippet scoped to, and
 * drafts.js already makes the neighbouring argument about a `cwd` it will not
 * sweep — "a checkout you moved is a draft you still want".
 *
 * Trailing separators are stripped, because `matchesCwd` compares strings and
 * `~/proj/` and `~/proj` are one entry.
 */
function cleanProjects(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const v of list) {
        if (out.length >= MAX_PROJECTS) break;
        const given = orNull(v);
        if (!given) continue;
        const dir = path.resolve(expandHome(given)).replace(/[/\\]+$/, '') || path.sep;
        if (!out.includes(dir)) out.push(dir);
    }
    return out;
}

/**
 * The fields a snippet carries, which are exactly the fields a create call takes.
 *
 * Spelled out rather than spread, so a caller cannot smuggle a key into the store
 * by putting it in a request body — `update` takes a patch straight off the wire.
 * The arrays are rebuilt rather than referenced, which is what makes `list()` hand
 * out copies somebody can safely mutate; the drafts version of this had only flat
 * fields, and a shared array reference is the version of that bug which survives
 * copying the pattern across.
 */
function clean(row) {
    return {
        id: row.id,
        title: row.title,
        // The message itself, and **not trimmed** unlike a draft's prompt: an
        // `insert` of `append` or `cursor` makes leading and trailing whitespace
        // part of what the snippet means, and one that begins "\n\nP.S. " is one
        // somebody wrote on purpose.
        body: row.body,
        // The sentence a pinned button shows on hover. Null falls back to the
        // first line of the body, which is a guess; this is where LGTM's carefully
        // worded tooltip lives now that the button is not written out in the page.
        hint: row.hint,
        // Null is ungrouped, which is a place in the popover rather than a group
        // with no name. A groupId naming a group that is not here is **kept**, not
        // nulled — another bridge may hold that group and be about to write it,
        // and rewriting a row on the strength of what this process happens to know
        // is exactly what merge-on-write exists to avoid. It draws ungrouped in
        // the meantime and heals itself.
        groupId: row.groupId,
        params: row.params.map(p => ({ ...p })),
        insert: row.insert,
        autoSubmit: row.autoSubmit,
        // Null is **inherit** — send under whatever mode the selector is already
        // on. Not `auto`, which is a choice to *move* the selector. Not checked
        // against PERMISSION_MODES here, for the reason drafts.js gives about the
        // same field: every route normalises it on the way in and the send route
        // refuses it again on the way out, so a mode this file cannot vouch for
        // still cannot reach `claude`, and rejecting it here would silently drop a
        // snippet the day that list is renamed upstream.
        permissionMode: row.permissionMode,
        pinned: row.pinned,
        order: row.order,
        projects: [...row.projects],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/** The fields a group carries. A name and a colour; the snippets are elsewhere. */
function cleanGroup(row) {
    return {
        id: row.id,
        name: row.name,
        accent: row.accent,
        order: row.order,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/**
 * Ordered by what somebody arranged, then by what they typed, then by id.
 *
 * A factory because groups sort on `name` and snippets on `title`, and the rule is
 * otherwise identical. `Infinity` is what puts an unordered row after every
 * ordered one — see the header on why null is not simply zero.
 *
 * The tiebreak runs all the way down to `id` so the order never depends on where a
 * row happened to sit in the array. Two rows genuinely can share an `order`: the
 * file is hand-editable, and two bridges number independently.
 */
function byOrder(key) {
    return (a, b) => {
        const ao = a.order === null ? Infinity : a.order;
        const bo = b.order === null ? Infinity : b.order;
        if (ao !== bo) return ao - bo;
        const named = String(a[key]).localeCompare(String(b[key]));
        return named || String(a.id).localeCompare(String(b.id));
    };
}

const bySnippetOrder = byOrder('title');
const byGroupOrder = byOrder('name');

/**
 * Does this snippet apply in this directory?
 *
 * **A prefix match at a path boundary**, and the boundary is not optional: a bare
 * `startsWith` makes a snippet scoped to `/home/me/proj` show up in
 * `/home/me/proj-old`, which is a different repository that happens to share
 * fourteen characters. It is the rule `withinRoots` uses in config.js.
 *
 * Prefix rather than exact, because a session's working directory is routinely a
 * subdirectory of the project and a rule that only fired at the top would look
 * broken. Prefix rather than "the same project", because a project's root is
 * derived from git — a filter built on that would change what the popover contains
 * when a directory stops being a repository, which is not something the user did
 * to the snippet. A prefix is a rule you can predict from the path you typed, and
 * it composes: scope one to `~/work` and everything under it inherits it. The cost
 * is worktrees, which are siblings rather than descendants and need their own
 * entry — one line in a list, against a rule nobody could guess.
 *
 * An empty list is everywhere. Case-sensitive, because the filesystem is.
 */
function matchesCwd(row, cwd) {
    const list = row && row.projects;
    if (!Array.isArray(list) || !list.length) return true;
    if (typeof cwd !== 'string' || !cwd) return false;
    const here = path.resolve(expandHome(cwd)).replace(/[/\\]+$/, '') || path.sep;
    return list.some(p => here === p || here.startsWith(p + path.sep));
}

/**
 * Which placeholders a body uses, and how that squares with what it declares.
 *
 * Pure, and derived on the bridge rather than in each client for the reason
 * `draftOut` derives `projectName`: the desktop, the phone and the Android app
 * should not each get to decide what counts as an undeclared placeholder.
 *
 * **Neither list is an error and no route refuses on them.** An undeclared name is
 * left verbatim when the snippet is used, and an unused param is a field you have
 * declared and not wired up yet — a normal state to save a half-finished snippet
 * in. They are here so an editor can say so quietly under the body, which is the
 * difference between a bug you can see and one you meet three sessions later.
 */
function scanPlaceholders(body, params = []) {
    const declared = new Set((params || []).map(p => p.name));
    const used = new Set();
    for (const m of String(body || '').matchAll(PLACEHOLDER)) used.add(m[1]);
    return {
        used: [...used],
        undeclared: [...used].filter(n => !declared.has(n)),
        unused: [...declared].filter(n => !used.has(n)),
    };
}

/**
 * Fill a body from a map of answers.
 *
 * The one place that decides what a `{{name}}` becomes, so that three clients
 * agreeing is a fact rather than a coincidence. A name with no answer falls back
 * to its param's `default`, and then to leaving the placeholder alone — **never to
 * the empty string**, because that is "quietly delete part of a message somebody
 * wrote", which is the failure this whole rule exists to avoid.
 *
 * The client is what actually calls this shape of thing on the way to the compose
 * box — there is no route that fills a snippet, because the point of `cursor` and
 * `append` is that the result lands in a box you then edit, and `autoSubmit` goes
 * through the ordinary send route rather than a second thinner one. This is here
 * so the rule is written down once and tested.
 */
function fillBody(body, params = [], answers = {}) {
    const defaults = new Map((params || []).map(p => [p.name, p.default]));
    return String(body).replace(PLACEHOLDER, (whole, key) => {
        if (!defaults.has(key)) return whole;
        const given = answers[key];
        if (given !== undefined && given !== null && given !== '') return String(given);
        const fallback = defaults.get(key);
        return fallback === null ? whole : fallback;
    });
}

/**
 * The file as `{groups, snippets, seeded, unreadable}`, or an empty store.
 *
 * Module-level rather than a method because `flush()` needs it too, to merge over
 * whatever another bridge has written since this one loaded — see the header. It
 * returns rather than assigns for the same reason.
 *
 * `unreadable` is the difference between "there is nothing here" and "there is
 * something here this build cannot parse", and it exists for exactly one caller:
 * `_seed()`, which writes without anybody having asked. Seeding a file written by
 * a newer version would put LGTM into it and then flush a `version: 1` document
 * over the top, destroying a file the next build owns. Nothing else needs to tell
 * the two apart, because nothing else writes unprompted.
 */
function read() {
    const empty = { groups: [], snippets: [], seeded: [], unreadable: false };
    let raw;
    try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return empty; }
    try {
        // Tolerate a BOM, as drafts.js and flags.js do. This is a file somebody
        // may well open — a snippet body is prose they wrote — and an editor that
        // adds one should not cost them the lot.
        const data = JSON.parse(raw.replace(/^﻿/, ''));
        if (data.version !== VERSION) return { ...empty, unreadable: true };

        const groups = [];
        for (const row of Array.isArray(data.groups) ? data.groups : []) {
            if (!row || typeof row.id !== 'string' || !row.id) continue;
            if (typeof row.name !== 'string' || !row.name.trim()) continue;
            groups.push(cleanGroup({
                id: row.id,
                name: row.name.trim().slice(0, MAX_TITLE),
                accent: isAccent(row.accent) ? row.accent : null,
                order: intOrNull(row.order),
                createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
                updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
            }));
        }

        const snippets = [];
        for (const row of Array.isArray(data.snippets) ? data.snippets : []) {
            // The three fields without which a snippet cannot do anything. A row
            // missing one is dropped rather than repaired: there is no title to
            // invent and no message to invent either.
            if (!row || typeof row.id !== 'string' || !row.id) continue;
            if (typeof row.title !== 'string' || !row.title.trim()) continue;
            if (typeof row.body !== 'string' || !row.body) continue;
            snippets.push(clean({
                id: row.id,
                title: row.title.trim().slice(0, MAX_TITLE),
                body: row.body.slice(0, MAX_BODY),
                hint: orNull(row.hint),
                groupId: orNull(row.groupId),
                params: cleanParams(row.params),
                insert: INSERT_STYLES.includes(row.insert) ? row.insert : 'overwrite',
                autoSubmit: !!row.autoSubmit,
                permissionMode: orNull(row.permissionMode),
                pinned: !!row.pinned,
                order: intOrNull(row.order),
                projects: cleanProjects(row.projects),
                createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
                updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
            }));
        }

        return {
            groups: groups.sort(byGroupOrder),
            snippets: snippets.sort(bySnippetOrder),
            // Which shipped rows this file has already been offered. A file written
            // before seeding existed has no list, which reads as "none yet" — and
            // that is right: it predates the seed, so it is owed it.
            seeded: Array.isArray(data.seeded)
                ? data.seeded.filter(id => typeof id === 'string' && id) : [],
            unreadable: false,
        };
    } catch (err) {
        console.error(`[claude-sessions] ignoring unreadable ${STATE_FILE}: ${err.message}`);
        return { ...empty, unreadable: true };
    }
}

class Snippets {
    /**
     * @param {object} [opts]
     * @param {boolean} [opts.seed] — spinner.js's flag, same name and same reason:
     *   the test exercises seeding for real in its own group, and every other
     *   group would otherwise start one row down and count wrong.
     */
    constructor({ seed = true } = {}) {
        /** @type {Array<object>} display order; see `_sort()`. */
        this.groups = [];
        /** @type {Array<object>} display order; see `_sort()`. */
        this.rows = [];
        /** @type {Set<string>} shipped ids this file has been offered. */
        this.seeded = new Set();
        /** Whether the file on disk is one this build cannot parse. See `read()`. */
        this.unreadable = false;
        /**
         * Ids this bridge has deleted, held until the write that carries the
         * deletion out. Without them a merge could not tell a row we removed from
         * one another bridge has just added — see the header. Two sets, because
         * the two collections merge separately and must not share an id space.
         * @type {Set<string>}
         */
        this._removed = new Set();
        /** @type {Set<string>} */
        this._removedGroups = new Set();
        this._saveTimer = null;
        this.load();
        if (seed) this._seed();
    }

    load() {
        const data = read();
        this.groups = data.groups;
        this.rows = data.snippets;
        this.seeded = new Set(data.seeded);
        this.unreadable = data.unreadable;
    }

    /**
     * Put the shipped snippets in, exactly once each, ever.
     *
     * The rule is per-seed and it is recorded rather than inferred: an id in
     * `seeded` has been offered and is never offered again, whatever the arrays
     * currently hold. So a store you emptied stays empty — deleting every snippet
     * is a thing a person does, and putting LGTM back on the next boot would not
     * read as a policy, it would read as the delete having failed.
     *
     * The `have` check is belt and braces for two bridges starting together: they
     * write the same stable id and the merge settles it either way, but not adding
     * a row we can already see is cheaper.
     *
     * It flushes rather than debouncing, because the record of having offered a
     * seed is the only thing standing between a deleted one and its return: a
     * bridge that seeded and then exited inside the 400ms window would come back
     * and seed again.
     *
     * The cap is respected silently. It cannot bite on a first run, and a store
     * already at MAX_SNIPPETS belongs to somebody with an opinion.
     */
    _seed() {
        // A file this build cannot parse is not a file to write into. Seeding is
        // the only write nobody asked for, so it is the only one that has to check
        // — see `read()`.
        if (this.unreadable) return;
        const missing = SEEDS.filter(s => !this.seeded.has(s.id));
        if (!missing.length) return;
        const have = new Set(this.rows.map(r => r.id));
        for (const seed of missing) {
            this.seeded.add(seed.id);
            if (have.has(seed.id) || this.rows.length >= MAX_SNIPPETS) continue;
            const now = this._stamp();
            this.rows.push(clean({ ...seed, createdAt: now, updatedAt: now }));
        }
        this._sort();
        this.flush();
    }

    /** Debounced atomic write — the shape drafts.js uses, for the same reason. */
    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => this.flush(), 400);
        this._saveTimer.unref();
    }

    /**
     * Write now, whatever the debounce was waiting for, merging over the file.
     *
     * Split out of `save()` rather than left inside its callback so that a caller
     * which cannot wait 400ms can make the write happen: the test, the seed above,
     * and the bridge's own shutdown — where it is load-bearing, because the
     * process exits well inside the debounce window and an unflushed deletion
     * would put a snippet you removed back in the popover.
     */
    flush() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        try {
            // Start from disk so another bridge's rows survive, then let ours win
            // per id — but only where ours is not older, so a snapshot taken
            // before somebody else's edit cannot undo it.
            const disk = read();

            const groups = new Map(disk.groups.map(g => [g.id, g]));
            for (const row of this.groups) {
                const theirs = groups.get(row.id);
                if (!theirs || row.updatedAt >= theirs.updatedAt) groups.set(row.id, row);
            }
            for (const id of this._removedGroups) groups.delete(id);
            this._removedGroups.clear();

            const snippets = new Map(disk.snippets.map(s => [s.id, s]));
            for (const row of this.rows) {
                const theirs = snippets.get(row.id);
                if (!theirs || row.updatedAt >= theirs.updatedAt) snippets.set(row.id, row);
            }
            for (const id of this._removed) snippets.delete(id);
            this._removed.clear();

            // Union, never replace. A bridge that booted before a seed existed
            // must not erase another bridge's record of having offered it, and a
            // union is the only merge of two sets whose answer does not depend on
            // who wrote last.
            const seeded = [...new Set([...disk.seeded, ...this.seeded])];

            fs.mkdirSync(STATE_DIR, { recursive: true });
            const tmp = STATE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({
                version: VERSION,
                seeded,
                groups: [...groups.values()].sort(byGroupOrder),
                snippets: [...snippets.values()].sort(bySnippetOrder),
            }, null, 2));
            fs.renameSync(tmp, STATE_FILE);
        } catch (err) {
            console.error(`[claude-sessions] could not save snippets: ${err.message}`);
        }
    }

    /** Both collections into the order the popover draws them in. */
    _sort() {
        this.groups.sort(byGroupOrder);
        this.rows.sort(bySnippetOrder);
    }

    /**
     * A timestamp strictly greater than every row this store holds.
     *
     * `Date.now()` alone is not enough, and the reason is not theoretical: two
     * writes in the same millisecond are ordinary — a create followed by an edit,
     * or a burst from the editor — and they would compare *equal*, so the merge in
     * `flush()` could not tell a newer edit from an older one and a stale row from
     * another bridge could roll back an edit it never saw. Making the stamp
     * strictly increasing means "newest updatedAt wins" is a rule that always
     * decides.
     *
     * Across **both** collections, because they are merged against one file and a
     * group and a snippet written together must not tie.
     */
    _stamp() {
        const now = Date.now();
        let newest = 0;
        for (const r of this.rows) if (r.updatedAt > newest) newest = r.updatedAt;
        for (const g of this.groups) if (g.updatedAt > newest) newest = g.updatedAt;
        return now > newest ? now : newest + 1;
    }

    /**
     * Every snippet, in display order; `cwd` narrows it to the ones that apply.
     *
     * The filter is offered here so a client that would rather not implement the
     * prefix rule need not — but the SSE payload is deliberately never filtered,
     * since one payload goes to every window and each window's composer is
     * somewhere different.
     */
    list({ cwd = null } = {}) {
        const rows = cwd ? this.rows.filter(r => matchesCwd(r, cwd)) : this.rows;
        return rows.map(clean);
    }

    listGroups() {
        return this.groups.map(cleanGroup);
    }

    get(id) {
        const row = this.rows.find(r => r.id === id);
        return row ? clean(row) : null;
    }

    getGroup(id) {
        const row = this.groups.find(g => g.id === id);
        return row ? cleanGroup(row) : null;
    }

    /**
     * @returns {object|null} the snippet, or null when the cap is reached — which
     *   the route turns into a 409. Null rather than a throw so the one caller
     *   that has to tell the two apart does not have to read a message.
     */
    create(fields = {}) {
        if (this.rows.length >= MAX_SNIPPETS) return null;
        const now = this._stamp();
        const row = clean({
            id: randomUUID(),
            title: String(fields.title).trim().slice(0, MAX_TITLE),
            body: String(fields.body).slice(0, MAX_BODY),
            hint: orNull(fields.hint),
            groupId: orNull(fields.groupId),
            params: cleanParams(fields.params),
            insert: INSERT_STYLES.includes(fields.insert) ? fields.insert : 'overwrite',
            autoSubmit: !!fields.autoSubmit,
            permissionMode: orNull(fields.permissionMode),
            pinned: !!fields.pinned,
            order: intOrNull(fields.order),
            projects: cleanProjects(fields.projects),
            // The same stamp for both, so a snippet nobody has edited reads as
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
     * A genuine patch: a key absent from `fields` is left alone, which is what lets
     * the editor send only what somebody edited. `undefined` is the absence and
     * `null` is a value — ungrouping a snippet means sending `groupId: null`, and
     * so does going back to inheriting the permission mode.
     *
     * `params` is the exception and **replaces rather than merges**. A param has no
     * id — its name is its identity, and that name is also what the body
     * references — so there is nothing to address a partial update to, and renaming
     * a param while fixing the `{{…}}` that refers to it has to be one save or it
     * can half-fail.
     */
    update(id, fields = {}) {
        const row = this.rows.find(r => r.id === id);
        if (!row) return null;

        if (fields.title !== undefined) {
            row.title = String(fields.title).trim().slice(0, MAX_TITLE);
        }
        if (fields.body !== undefined) row.body = String(fields.body).slice(0, MAX_BODY);
        if (fields.hint !== undefined) row.hint = orNull(fields.hint);
        if (fields.groupId !== undefined) row.groupId = orNull(fields.groupId);
        if (fields.params !== undefined) row.params = cleanParams(fields.params);
        if (fields.insert !== undefined) {
            row.insert = INSERT_STYLES.includes(fields.insert) ? fields.insert : row.insert;
        }
        if (fields.autoSubmit !== undefined) row.autoSubmit = !!fields.autoSubmit;
        if (fields.permissionMode !== undefined) {
            row.permissionMode = orNull(fields.permissionMode);
        }
        if (fields.pinned !== undefined) row.pinned = !!fields.pinned;
        if (fields.order !== undefined) row.order = intOrNull(fields.order);
        if (fields.projects !== undefined) row.projects = cleanProjects(fields.projects);

        // `createdAt` is deliberately untouched: it is when you first wrote this
        // down, and nothing about editing the wording changes that.
        row.updatedAt = this._stamp();
        this._sort();
        this.save();
        return clean(row);
    }

    remove(id) {
        const at = this.rows.findIndex(r => r.id === id);
        if (at < 0) return false;
        this.rows.splice(at, 1);
        // Remembered until the write goes out. The merge in `flush()` starts from
        // the file, so without this the row we just dropped would be read straight
        // back in and re-saved.
        this._removed.add(id);
        this.save();
        return true;
    }

    createGroup(fields = {}) {
        if (this.groups.length >= MAX_GROUPS) return null;
        const now = this._stamp();
        const row = cleanGroup({
            id: randomUUID(),
            name: String(fields.name).trim().slice(0, MAX_TITLE),
            accent: isAccent(fields.accent) ? fields.accent : null,
            order: intOrNull(fields.order),
            createdAt: now,
            updatedAt: now,
        });
        this.groups.push(row);
        this._sort();
        this.save();
        return cleanGroup(row);
    }

    updateGroup(id, fields = {}) {
        const row = this.groups.find(g => g.id === id);
        if (!row) return null;

        if (fields.name !== undefined) {
            row.name = String(fields.name).trim().slice(0, MAX_TITLE);
        }
        if (fields.accent !== undefined) {
            row.accent = isAccent(fields.accent) ? fields.accent : null;
        }
        if (fields.order !== undefined) row.order = intOrNull(fields.order);

        row.updatedAt = this._stamp();
        this._sort();
        this.save();
        return cleanGroup(row);
    }

    /**
     * Delete a group. Its snippets are **not** deleted, and keep their `groupId`.
     *
     * Deleting a container must not delete its contents: a group is a name and a
     * colour, and the snippets under it are paragraphs somebody wrote — the
     * expensive half of this file. They draw ungrouped, which is a real place in
     * the popover rather than a limbo, and recreating a group with the same id puts
     * them straight back.
     *
     * Keeping the `groupId` rather than nulling it is the same rule `read()`
     * follows for a group it cannot see, and it is not laziness: rewriting rows on
     * the strength of a deletion another bridge has not seen yet is what
     * merge-on-write exists to avoid, and it would make the deletion impossible to
     * undo by hand.
     *
     * @returns {{orphaned: number}|null} how many snippets came loose, so the UI
     *   can say so rather than leaving somebody to notice.
     */
    removeGroup(id) {
        const at = this.groups.findIndex(g => g.id === id);
        if (at < 0) return null;
        this.groups.splice(at, 1);
        this._removedGroups.add(id);
        const orphaned = this.rows.filter(r => r.groupId === id).length;
        this._sort();
        this.save();
        return { orphaned };
    }

    /**
     * Write a whole arrangement at once.
     *
     * Whole lists rather than one row at a time because that is what both gestures
     * in the editor produce — a drag knows the final order, and so does an up
     * arrow — and because a swap done as two writes has an instant in the middle
     * where both rows hold the same number and two events go out.
     *
     * Two of `runner.reorder`'s rules carry over verbatim: **ids that are not here
     * are ignored**, because a row somebody deleted in another window mid-drag must
     * not fail the save, and the call is idempotent. Ignored means ignored all the
     * way down: a stranger does not consume an index either, so the numbering stays
     * dense and a list that names one row this store has never heard of produces
     * exactly the arrangement the same list without it would. Letting it take a
     * slot would leave a gap, which is harmless, and would make the call stop being
     * idempotent, which is not. The third rule changes. That
     * one puts anything the caller did not mention at the back, which it can
     * because a queue is one list with one owner. Here **a row the body does not
     * mention keeps the order it had, `null` included** — so reordering one group
     * is that group's ids and touches nothing else, and a client holding a stale
     * list cannot renumber snippets it has never seen.
     *
     * A snippet's `order` is a global index rather than one within its group, and
     * that is not a compromise: the client buckets by group and sorts inside each,
     * so any sequence putting a group's snippets in the right relative order is a
     * right answer.
     *
     * **`updatedAt` moves only on rows whose `order` actually changed**, which is
     * not cosmetic. Bumping the stamp on rows that did not move would let a client
     * re-sending its current order — which is what a drag landing where it started
     * does — win the merge against another bridge's later edit to those same rows.
     * The counts come back so the route can skip the broadcast entirely.
     *
     * @returns {{snippets: number, groups: number}} rows that actually moved.
     */
    reorder({ snippets, groups } = {}) {
        const now = this._stamp();
        const moved = { snippets: 0, groups: 0 };

        // A counter rather than the array index, so an id this store does not hold
        // is skipped without leaving a hole where it would have been.
        if (Array.isArray(groups)) {
            let at = 0;
            for (const id of groups) {
                const row = this.groups.find(g => g.id === id);
                if (!row) continue;
                const i = at++;
                if (row.order === i) continue;
                row.order = i;
                row.updatedAt = now;
                moved.groups++;
            }
        }
        if (Array.isArray(snippets)) {
            let at = 0;
            for (const id of snippets) {
                const row = this.rows.find(r => r.id === id);
                if (!row) continue;
                const i = at++;
                if (row.order === i) continue;
                row.order = i;
                row.updatedAt = now;
                moved.snippets++;
            }
        }

        if (moved.snippets || moved.groups) {
            this._sort();
            this.save();
        }
        return moved;
    }
}

/**
 * What LGTM says, and why it is here rather than in the client.
 *
 * The button sends this as an ordinary message, which is the point: approving work
 * is a thing worth having in the transcript in words, and "LGTM" on its own is not
 * an instruction — it does not say whether the branch is already on a PR, or what
 * counts as done.
 *
 * It ends by naming what should stop the merge, because the failure it replaces is
 * not a bad merge, it is a green one reported over the top of a red check.
 * Repositories with no remote are the normal case on this machine, so the PR is
 * described by what it is for rather than assumed to exist.
 */
const LGTM_BODY = `LGTM — take it from here and land it.

- If this work is not on a pull request yet, commit whatever is outstanding on a
  branch of its own and open one. If the repository has no remote, merging that
  branch into the main branch is the equivalent — do that instead.
- Run the checks this project expects of a change: its tests, lint, typecheck,
  build, whatever it has. Fix what they turn up.
- Once they pass, merge it.

If something genuinely blocks the merge — checks you cannot fix, conflicts, a
review asking for changes — stop and tell me instead of working around it.

If you noticed work along the way that this change is not the place for, file it
with your suggest_session tool before you finish, one call each — the refactor
you left alone, the test that should exist, the thing you had to work around. If
you noticed nothing, say nothing; this is not a box to fill.`;

/**
 * What ships in the box.
 *
 * Ids are **stable strings, not UUIDs**, and that is load-bearing twice over. A
 * UUID minted at seed time could not be written into `seeded`, so the store could
 * not remember having offered it; and two bridges seeding an absent file at the
 * same instant would mint two ids and the merge would keep both, so somebody's
 * first sight of this feature would be two identical LGTM buttons.
 *
 * `insert: 'overwrite'` with `autoSubmit` is the shape the button had, and the
 * client turns that pair into a send that never touches the compose box — so a
 * half-typed message survives pressing it, exactly as it used to. `permissionMode`
 * is null because the button never changed one: the session still asks for
 * whatever its mode makes it ask for before anything is pushed or merged. The
 * `hint` is the button's old `title`, which is why that field exists at all.
 */
const SEEDS = [
    {
        id: 'seed-lgtm',
        title: 'LGTM',
        body: LGTM_BODY,
        hint: 'open a PR for this work if there is not one, run the checks, and '
            + 'merge it once they pass',
        groupId: null,
        params: [],
        insert: 'overwrite',
        autoSubmit: true,
        permissionMode: null,
        // Pinned, so it keeps the button it has always had rather than moving
        // behind a popover on the day this shipped.
        pinned: true,
        order: 0,
        projects: [],
    },
];

module.exports = {
    Snippets, STATE_FILE, VERSION, SEEDS,
    MAX_SNIPPETS, MAX_GROUPS, MAX_PARAMS, MAX_BODY, MAX_PROJECTS, MAX_TITLE,
    INSERT_STYLES, PARAM_TYPES, PLACEHOLDER,
    isParamName, isAccent, matchesCwd, scanPlaceholders, fillBody,
};
