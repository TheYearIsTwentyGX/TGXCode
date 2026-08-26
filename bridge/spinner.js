'use strict';

// The words a turn in progress calls itself.
//
// For its whole life before this, the app said `Thinking…` — one string, set in
// four places in bridge/runner.js and fanned out over SSE to every surface that
// shows a session working. This supplies a themed word instead, and the runner
// puts it in front of whatever is specifically happening:
//
//     Percolating…
//     Percolating… Reading runner.js
//
// The collection comes from github.com/wynandw87/claude-code-spinner-verbs;
// scripts/import-spinner-verbs.js turns its README into bridge/spinner-verbs.json.
//
// This module's job stops at the word. Composing the label, and deciding when a
// state deserves a verb at all, is Runner#_work / Runner#_say — which is why
// `pick` answers null rather than a fallback string.
//
// **It is decided here rather than in the browser**, which is the one design
// choice worth defending. Eight surfaces show this label — the composer status
// line, rail rows, the subagent header, the live board, the task board, the
// dashboard chips, and the Android app — and they all read `runner.activity` off
// one SSE message, so picking the verb in the bridge means every one of them
// agrees about what a session is doing, the phone included. Picking it per-client
// would have meant teaching all eight, twice, and two windows would still have
// disagreed. Only the session rail needed anything: it has room for about
// twenty characters, not both halves of the label, so it reads the `detail`
// field instead — see Runner#status and activityBits in web/app.js.
//
// **A directory, not a settings key.** There are 3,639 verbs across 114 groups.
// They will not fit in `~/.tgxcode/settings.json` — prefs.js caps that file at
// 64KB, rightly — and more to the point, "delete the ones I don't like" has to
// be a thing you can actually do. So each group is its own file under
// `~/.tgxcode/verbs/`, named after itself:
//
//     ~/.tgxcode/verbs/Monty_Python.json
//     { "Category": "Monty Python", "Verbs": ["Ni-ing", "Holy-grailing", …] }
//
// `Category` is inside the file as well as in its name because a category may
// contain characters a filename may not — `Tech / Programming` is the reason
// `Tech_Programming.json` exists — and because a group that says what it is
// survives being renamed, moved, or handed to somebody else. Settings refer to
// the `Category`; the filename is an index into it, and a fast one (see
// `resolve`). Adding a group is dropping a file in. Removing a verb is deleting
// a line.
//
// Which groups are *in play* is a setting, and lives with the other settings —
// `spinner.groups` in prefs.js. Only the groups named there are ever opened, so
// the size of the directory costs nothing.
//
// The file-reading conventions here — stat before read, a size cap, BOM
// tolerance, an `mtimeMs:size` stamp as the cache key, a 2s TTL, and no
// `fs.watch` — are lifted from bridge/prefs.js and bridge/commands.js on
// purpose. This reads the same directory they do, and a reader should not have
// to hold three sets of rules in mind.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { projectRootOf } = require('./transcript');

// One group of verbs. Generous next to the largest real group (Kaomoji, 185
// multi-byte faces, about 6KB) because this is a file people paste into, and
// mean enough that a stray log file named `.json` does not get read into
// memory whole.
const MAX_FILE_BYTES = 256 * 1024;

// A directory of groups. The bundled catalogue has 114; the rest of the room is
// for the user's own. Past this we stop listing rather than walk something that
// is not a verb directory at all.
const MAX_FILES = 2000;

// Verbs in one pool. Enabling every group at once gives about 3,600, so this is
// several times any real answer — it exists so a generated directory cannot
// make the bridge hold an unbounded list.
const MAX_POOL = 50_000;

const CACHE_MS = 2000;

/**
 * A category as a filename stem.
 *
 * ` / ` becomes `_` so `Tech / Programming` can be a file at all; everything
 * outside `[A-Za-z0-9_-]` is dropped. That last rule is also what makes this
 * safe to join onto a path: a name out of a settings file cannot come through
 * here carrying a `/` or a `..`. A name with nothing left is refused by the
 * caller rather than turned into a mystery file.
 */
function slugFor(name) {
    return String(name)
        .replace(/\s*\/\s*/g, '_')
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9_-]/g, '')
        .replace(/_{2,}/g, '_')
        .replace(/^[_-]+|[_-]+$/g, '');
}

/**
 * A category flattened for comparison.
 *
 * These are names people type into a settings file, so `"Tech / Programming"`,
 * `"Tech_Programming"` and `"tech-programming"` all have to find the same
 * group. Punctuation and case carry no meaning in a category name, so neither
 * decides a match.
 */
function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Read one group file.
 *
 * The canonical shape is `{Category, Verbs}`, but the tolerated ones matter: a
 * file somebody wrote by hand is as likely to say `verbs`, and a bare array is
 * the obvious thing to reach for when the filename already says which group it
 * is. All three parse. What does *not* pass is taken out and reported, because
 * a silently half-loaded group is worse than a named problem.
 *
 * @returns {{category: string|null, verbs: string[], stamp: string|null, problems: object[]}}
 */
function readGroup(file) {
    const miss = { category: null, verbs: [], stamp: null, problems: [] };

    let st;
    try { st = fs.statSync(file); } catch { return miss; }
    if (!st.isFile()) return miss;
    const stamp = `${st.mtimeMs}:${st.size}`;
    const bad = (message) => ({ category: null, verbs: [], stamp, problems: [{ file, message }] });

    if (st.size > MAX_FILE_BYTES) return bad(`larger than ${MAX_FILE_BYTES / 1024}KB — ignored`);

    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (err) { return bad(err.message); }

    let data;
    // Tolerate a BOM the same way prefs.js and commands.js do.
    try { data = JSON.parse(raw.replace(/^﻿/, '')); }
    catch (err) { return bad(err.message); }

    const problems = [];
    let list = null;
    let category = null;
    if (Array.isArray(data)) {
        list = data;
    } else if (data && typeof data === 'object') {
        list = Array.isArray(data.Verbs) ? data.Verbs
            : Array.isArray(data.verbs) ? data.verbs : null;
        const c = data.Category !== undefined ? data.Category : data.category;
        if (typeof c === 'string' && c.trim()) category = c.trim();
        // A category that is not a name loses the file its preferred title, not
        // its verbs: the filename still says which group this is.
        else if (c !== undefined) problems.push({ file, message: '"Category" is not a name — using the filename' });
    }
    if (!list) return bad('no "Verbs" array — expected {"Category": "…", "Verbs": ["…"]}');

    const verbs = [];
    const seen = new Set();
    let dropped = 0;
    for (const v of list) {
        if (typeof v !== 'string' || !v.trim()) { dropped++; continue; }
        const verb = v.trim();
        if (seen.has(verb)) continue;
        seen.add(verb);
        verbs.push(verb);
    }

    // A count, not a list: a file of five hundred blanks should say so in one
    // line rather than five hundred.
    if (dropped) {
        problems.push({ file,
            message: `${dropped} entr${dropped === 1 ? 'y is' : 'ies are'} not a verb — ignored` });
    }

    return { category, verbs, stamp, problems };
}

class Spinner {
    /**
     * @param {import('./prefs').Prefs} prefs the same instance the rest of the
     *   bridge reads settings from — `spinner.groups` decides what this opens,
     *   and sharing the instance shares its cache rather than doubling the
     *   file reads.
     * @param {object} [opts]
     * @param {string} [opts.userDir] where the user's groups live. Overridable
     *   so the tests can exercise seeding and reading for real without writing
     *   into somebody's home directory.
     * @param {boolean} [opts.seed] whether to write the catalogue out when that
     *   directory is missing.
     */
    constructor(prefs, { userDir = cfg.USER_VERBS_DIR, seed = true } = {}) {
        this.prefs = prefs;
        this.userDir = userDir;
        this.bundled = null;              // the checked-in catalogue, read once, lazily
        this.files = new Map();           // file -> {stamp, category, verbs, problem}
        this.listings = new Map();        // dir -> {at, stamp, groups, problems}
        this.pools = new Map();           // cwd -> {at, stamp, verbs, problems}
        if (seed) this.ensureUserDir();
    }

    /** The catalogue that ships with the app, as `{name: [verb, ...]}`. */
    catalogue() {
        if (this.bundled) return this.bundled;
        this.bundled = {};
        try {
            const raw = fs.readFileSync(path.join(__dirname, 'spinner-verbs.json'), 'utf8');
            const data = JSON.parse(raw);
            if (data && data.groups && typeof data.groups === 'object') this.bundled = data.groups;
        } catch (err) {
            // Not fatal, and not worth a throw: without a catalogue every pick
            // falls back to `Thinking…`, which is what the app said before.
            console.error(`[claude-sessions] could not read the bundled spinner verbs: ${err.message}`);
        }
        return this.bundled;
    }

    /**
     * Write the catalogue out as one file per group, if the directory is not
     * there yet. Mirrors Prefs#ensureUserFile(): a collection with no UI in
     * front of it has to be on disk to be editable at all, and an empty
     * `~/.tgxcode/verbs/` teaches nobody what may go in it.
     *
     * **Only when the directory is absent entirely** — never file by file. If
     * a missing `Gen-Z.json` were treated as one to restore, deleting a group
     * you dislike would undo itself on the next turn, and deleting a group you
     * dislike is the whole point of the directory.
     *
     * Failure logs and does not throw. A read-only home costs the user a place
     * to edit, not the app a spinner: `catalogue()` still answers.
     */
    ensureUserDir() {
        const dir = this.userDir;
        try {
            if (fs.existsSync(dir)) return;
            const groups = this.catalogue();
            const names = Object.keys(groups);
            if (!names.length) return;
            fs.mkdirSync(dir, { recursive: true });
            for (const name of names) {
                const slug = slugFor(name);
                if (!slug) continue;
                const file = path.join(dir, `${slug}.json`);
                const tmp = `${file}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify({ Category: name, Verbs: groups[name] }, null, 2) + '\n');
                fs.renameSync(tmp, file);
            }
            console.log(`[claude-sessions] wrote ${names.length} spinner verb groups to ${dir}`);
        } catch (err) {
            console.error(`[claude-sessions] could not create ${dir}: ${err.message}`);
        }
    }

    /**
     * The verb directories that apply to a workspace, **strongest first** —
     * the opposite order to Prefs#files(), because a group is answered by the
     * first directory that has it rather than folded together key by key.
     *
     * A project shipping its own group is the case this exists for: a repo can
     * put `Deploy_Chants.json` in its `.tgxcode/verbs/` and every session in it
     * can name that group, without anybody editing their home directory.
     */
    dirs(cwd) {
        const out = [];
        if (cwd && cfg.withinRoots(cwd)) {
            const workspace = path.resolve(cfg.expandHome(cwd));
            const project = projectRootOf(workspace);
            out.push(path.join(workspace, cfg.TGX_DIR, cfg.VERBS_DIR));
            if (project !== workspace) out.push(path.join(project, cfg.TGX_DIR, cfg.VERBS_DIR));
        }
        out.push(this.userDir);
        return out;
    }

    /** One group file, parsed, with the result kept while its stamp holds. */
    _read(file) {
        const hit = this.files.get(file);
        const got = readGroup(file);
        if (hit && got.stamp && hit.stamp === got.stamp) return hit;
        if (got.stamp) this.files.set(file, got);
        return got;
    }

    /**
     * Every group one directory offers.
     *
     * This is the call that opens every file — it needs each `Category` and
     * each count — so it is what the listing route uses and what `resolve()`
     * falls back to, never what `pick()` does.
     *
     * **The TTL is checked before the work, not after**, which is where this
     * departs from prefs.js. That file re-stats on every call so an edit is
     * picked up the instant it lands, and it can afford to: it stats four
     * files. This stats every group in the directory, so 2s of staleness is
     * the better trade — and `pick()` reaches the groups it actually uses
     * through `resolve()`'s fast path, which does re-stat every time.
     */
    _listing(dir) {
        const fresh = this.listings.get(dir);
        if (fresh && Date.now() - fresh.at < CACHE_MS) return fresh;

        let names;
        try { names = fs.readdirSync(dir); }
        catch { return { groups: [], problems: [] }; }

        names = names.filter(n => n.endsWith('.json') && !n.endsWith('.tmp')).sort();
        const problems = [];
        if (names.length > MAX_FILES) {
            problems.push({ file: dir, message: `more than ${MAX_FILES} groups — listing the first ${MAX_FILES}` });
            names = names.slice(0, MAX_FILES);
        }

        const parts = [];
        const reads = [];
        for (const n of names) {
            const file = path.join(dir, n);
            const got = this._read(file);
            parts.push(`${n}@${got.stamp || '-'}`);
            reads.push({ n, file, got });
        }
        const stamp = parts.join('|');

        // Nothing has moved since the last listing — keep the answer and only
        // freshen its age, so a directory nobody is editing settles into one
        // readdir per TTL.
        const hit = this.listings.get(dir);
        if (hit && hit.stamp === stamp) { hit.at = Date.now(); return hit; }

        const groups = [];
        for (const { n, file, got } of reads) {
            problems.push(...got.problems);
            if (!got.verbs.length) continue;
            const stem = n.replace(/\.json$/, '');
            const name = got.category || stem;
            // Honoured, not corrected. A file whose category disagrees with its
            // name still works — `resolve()` finds it either way — but the
            // mismatch is said out loud, because the alternative is a group
            // that answers to a name nothing in the directory appears to have.
            if (got.category && slugFor(got.category) !== stem) {
                problems.push({ file, message: `Category "${got.category}" does not match the filename — both work` });
            }
            groups.push({ name, file, count: got.verbs.length });
        }

        const value = { groups, problems, stamp, at: Date.now() };
        this.listings.set(dir, value);
        return value;
    }

    /**
     * Every group available to a workspace, nearest directory winning.
     *
     * @returns {{groups: Array<{name, file, count, source}>, problems: object[]}}
     */
    groups(cwd) {
        const byName = new Map();
        const problems = [];
        for (const dir of this.dirs(cwd)) {
            const listing = this._listing(dir);
            problems.push(...listing.problems);
            for (const g of listing.groups) {
                const key = norm(g.name);
                if (!key || byName.has(key)) continue;   // nearer directory already answered
                byName.set(key, { ...g, source: dir });
            }
        }
        const groups = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
        return { groups, problems };
    }

    /**
     * The file holding one named group, or null.
     *
     * Two tiers, because `Category` lives *inside* a file and opening all 114
     * to find one would undo the point of only touching what is enabled:
     *
     *  - the **fast path** slugs the name and stats that file directly, which
     *    is every normal case, since that is exactly how the seed names them;
     *  - the **slow path** runs only on a miss — a renamed file, or one whose
     *    category and filename differ — and searches the full listing, which
     *    is cached, so a miss costs one scan of the directory and not one per
     *    pick.
     */
    resolve(cwd, name) {
        const slug = slugFor(name);
        const wanted = norm(name);
        if (!wanted) return null;

        const dirs = this.dirs(cwd);
        if (slug) {
            for (const dir of dirs) {
                const file = path.join(dir, `${slug}.json`);
                const got = this._read(file);
                if (got.verbs.length) return file;
            }
        }
        for (const dir of dirs) {
            for (const g of this._listing(dir).groups) {
                if (norm(g.name) === wanted) return g.file;
            }
        }
        return null;
    }

    /**
     * The verbs in play for a workspace, from the groups its settings name.
     *
     * @returns {{verbs: string[], problems: object[]}}
     */
    pool(cwd) {
        const wanted = this.prefs.forCwd(cwd).spinner.groups;

        // The stamp is the resolved files and their own stamps, so editing a
        // group, deleting one, or changing which groups are enabled all
        // invalidate — and an untouched setup costs a stat per enabled group.
        const resolved = wanted.map(name => ({ name, file: this.resolve(cwd, name) }));
        const stamp = resolved
            .map(r => `${r.name}=${r.file || '-'}@${r.file ? (this.files.get(r.file) || {}).stamp || '-' : '-'}`)
            .join('|');

        const key = cwd || '';
        const hit = this.pools.get(key);
        if (hit && hit.stamp === stamp && Date.now() - hit.at < CACHE_MS) return hit;

        const verbs = [];
        const seen = new Set();
        const problems = [];
        let capped = false;
        for (const { name, file } of resolved) {
            if (!file) {
                problems.push({ file: this.userDir, message: `no group named "${name}" — ignored` });
                continue;
            }
            const got = this._read(file);
            problems.push(...got.problems);
            for (const v of got.verbs) {
                if (seen.has(v)) continue;              // the same verb in two groups is one verb
                if (verbs.length >= MAX_POOL) { capped = true; break; }
                seen.add(v);
                verbs.push(v);
            }
            if (capped) break;
        }
        if (capped) problems.push({ file: this.userDir, message: `more than ${MAX_POOL} verbs — the rest ignored` });

        const value = { verbs, problems, stamp, at: Date.now() };
        this.pools.set(key, value);
        return value;
    }

    /**
     * One verb for a session in `cwd`, or **null** when there is not one to
     * give — randomizing is off, or no enabled group resolved to anything.
     *
     * Null rather than `Thinking…` because the verb is a prefix now, not the
     * whole label: what the caller needs to know is whether there is a verb at
     * all, so that `randomize: false` composes to exactly the string this app
     * showed before any of this existed. Runner#_say is where that happens.
     *
     * `last` is the verb already on screen, and is avoided when there is
     * anything else to say: a re-roll that lands on the same word looks like a
     * stuck label rather than a coincidence.
     */
    pick(cwd, last) {
        const settings = this.prefs.forCwd(cwd).spinner;
        if (!settings.randomize) return null;

        const { verbs } = this.pool(cwd);
        if (!verbs.length) return null;
        if (verbs.length === 1) return verbs[0];

        let i = Math.floor(Math.random() * verbs.length);
        if (verbs[i] === last) i = (i + 1) % verbs.length;
        return verbs[i];
    }

    /** How long a verb stands before another is drawn; 0 for not on its own. */
    rerollMs(cwd) {
        const settings = this.prefs.forCwd(cwd).spinner;
        if (!settings.randomize) return 0;
        return settings.rerollMs;
    }
}

module.exports = { Spinner, slugFor, norm, readGroup, MAX_FILE_BYTES };
