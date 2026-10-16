'use strict';

// Session templates: a create call you start from more than once.
//
// The three neighbours each hold a create call and none of them is this. A draft
// is one session not started yet, and starting it uses it up. A schedule fires on
// a clock. A snippet fills a compose box. What was missing is the setup you
// repeat: the same directory, model, mode, worktree and orchestrator box, and a
// first message that differs only in the part you would have typed anyway.
//
// So a template is the dialog's fields, held, with two differences from a draft.
// Both `cwd` and `prompt` may be blank, because a template for every project has
// no directory and one that only sets a model and a mode has no message. It also
// carries the two fields only Start has, `worktree` and `orchestrator`, which the
// drafts store has never had.
//
// **Where it lives.** It is in STATE_DIR beside drafts.json, not in a project's
// `.tgxcode/`. That directory is checked in (`commands.json` is committed) and
// every worktree has its own copy of it. A template written there would dirty
// the checkout and vanish with the worktree it was saved from, and it would be
// shared with everybody who clones the repository. Templates are personal, so
// "for this project" is a `project` field holding a directory, matched the way
// snippets match theirs.
//
// **Merge-on-write**, which is drafts.js's bargain and for drafts.js's reason.
// The everyday bridge and every dev bridge share this file, and a whole-file
// rewrite from a snapshot would let one agent's test template erase the user's
// real ones. Read the header there for the details. The rules are the same here:
// newer `updatedAt` wins per id, and deletions are carried in `_removed`.
//
// **Placeholders** are `{{name}}`, the syntax snippets and schedules use, and
// PLACEHOLDER is imported from snippets.js rather than respelled. Three names
// are filled by the bridge: `branch`, `date` and `project`. Any other name is a
// question for whoever uses the template. An unanswered name is left in the
// text as written, never blanked, which is the rule `fillBody` gives.

const path = require('path');
const { randomUUID } = require('crypto');

const { STATE_DIR, expandHome } = require('./config');
const { readJson, serialize, writeAtomic } = require('./jsonfile');
const { PLACEHOLDER } = require('./snippets');

const STATE_FILE = path.join(STATE_DIR, 'templates.json');
const VERSION = 1;

// Two hundred is drafts.js's cap, and its reasoning applies here.
const MAX_TEMPLATES = 200;
const MAX_NAME = 100;
// Far past anything a person keeps, but a cap so the read in jsonfile.js stays
// bounded. Its 64KB default is meant for a settings file, and two hundred
// prompts would pass it.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** The names the bridge fills in itself, in the order a client lists them. */
const BUILTINS = ['branch', 'date', 'project'];

function orNull(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s || null;
}

/** A directory as a project scope: expanded and absolute, with no trailing separator. */
function cleanDir(v) {
    const given = orNull(v);
    if (!given) return null;
    return path.resolve(expandHome(given)).replace(/[/\\]+$/, '') || path.sep;
}

/**
 * `{name, base}` or null. The name is a *pattern* and is not checked against
 * bridge/worktree.js's rule here, because `{{task}}` is not a valid name until it
 * has been filled. resolve() slugs it, and `POST /api/sessions` checks the result.
 */
function cleanWorktree(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const name = orNull(v.name);
    if (!name) return null;
    return { name, base: orNull(v.base) };
}

/** Spelled out rather than spread, so a request body cannot add keys to a row. */
function clean(row) {
    return {
        id: row.id,
        name: row.name,
        project: row.project,
        cwd: row.cwd,
        prompt: row.prompt,
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
        worktree: row.worktree ? { name: row.worktree.name, base: row.worktree.base } : null,
        orchestrator: row.orchestrator,
        test: row.test,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/**
 * Most recently updated first, then by name. A template you just saved or edited
 * is the one you are most likely to reach for next.
 */
const byUpdated = (a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name);

/** The file as rows, or an empty list. See drafts.js for why this is module-level. */
function read() {
    const { data, problem } = readJson(STATE_FILE, { maxBytes: MAX_FILE_BYTES });
    if (problem) {
        console.error(`[tgxcode] ignoring unreadable ${STATE_FILE}: ${problem.message}`);
        return [];
    }
    if (!data || data.version !== VERSION) return [];
    const out = [];
    for (const row of Array.isArray(data.templates) ? data.templates : []) {
        // A template's identity is its id and the only thing it must have is a
        // name. Everything else has a sensible empty value.
        if (!row || typeof row.id !== 'string') continue;
        const name = orNull(row.name);
        if (!name) continue;
        out.push(clean({
            id: row.id,
            name: name.slice(0, MAX_NAME),
            project: cleanDir(row.project),
            cwd: orNull(row.cwd),
            prompt: typeof row.prompt === 'string' ? row.prompt : '',
            model: orNull(row.model),
            effort: orNull(row.effort),
            // Not checked against the list of modes here. Every route runs it
            // through normalizeMode, which is drafts.js's argument.
            permissionMode: typeof row.permissionMode === 'string' ? row.permissionMode : 'auto',
            worktree: cleanWorktree(row.worktree),
            orchestrator: !!row.orchestrator,
            test: !!row.test,
            createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
            updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
        }));
    }
    return out.sort(byUpdated);
}

/**
 * The project a directory belongs to for scoping. A directory under
 * `<repo>/.claude/worktrees/<name>` belongs to `<repo>`, because a worktree is a
 * sibling of the checkout rather than a child of it. Without this, a template
 * scoped to the project would vanish in every worktree you start from it.
 */
function projectOf(cwd) {
    const dir = cleanDir(cwd);
    if (!dir) return null;
    const m = /^(.*)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/.exec(dir);
    return m ? m[1] : dir;
}

/**
 * Does this template apply in `cwd`? A global template applies everywhere. A
 * project template applies in its directory, anywhere under it, and in that
 * project's worktrees. The match is a prefix, the rule snippets' `matchesCwd`
 * uses and for its reason: you can predict it from the path you typed.
 */
function matchesProject(row, cwd) {
    if (!row || !row.project) return true;
    const here = projectOf(cwd);
    if (!here) return false;
    const full = cleanDir(cwd);
    return [here, full].some(d => d === row.project || d.startsWith(row.project + path.sep));
}

/** Every placeholder name in a string, once each, in order of appearance. */
function namesIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(PLACEHOLDER)) {
        if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
}

/**
 * Which placeholders a template uses, split into the ones the bridge fills
 * (`builtins`) and the ones somebody has to answer (`asks`). Both the prompt and
 * the worktree name pattern are scanned, so `{{task}}` used only in the name
 * still gets a box.
 */
function scanTemplate(row) {
    const names = namesIn(`${(row && row.prompt) || ''}\n${(row && row.worktree && row.worktree.name) || ''}`);
    return {
        builtins: names.filter(n => BUILTINS.includes(n)),
        asks: names.filter(n => !BUILTINS.includes(n)),
    };
}

/**
 * Fill `{{name}}` from `values`. A name with no value, or an empty one, is left as
 * written. Blanking it would quietly delete part of a message somebody wrote, and
 * `{{` is ordinary punctuation in prose.
 */
function fillTemplate(text, values = {}) {
    return String(text || '').replace(PLACEHOLDER, (whole, key) => {
        if (!Object.prototype.hasOwnProperty.call(values, key)) return whole;
        const v = values[key];
        return v === undefined || v === null || v === '' ? whole : String(v);
    });
}

/**
 * A filled worktree pattern turned into a name bridge/worktree.js will accept,
 * or null if nothing usable is left. Lowercased and hyphenated the way the
 * dialog's own `worktreeSlug` makes a name from the prompt, so a template-made
 * name looks like one the dialog would have suggested. A placeholder still left
 * in it makes it null rather than a name built from its braces.
 */
function worktreeSlug(text) {
    const s = String(text || '');
    if (/\{\{\s*\w+\s*\}\}/.test(s)) return null;
    const out = s.toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/-{2,}/g, '-')
        .replace(/^[.-]+/, '')
        .slice(0, 60)
        .replace(/[.-]+$/, '')
        .replace(/\.lock$/, '');
    return out || null;
}

/** Local date as YYYY-MM-DD. The `{{date}}` schedules fill is in the same form. */
function localDate(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class Templates {
    constructor() {
        this.rows = [];
        this._removed = new Set();
        this._saveTimer = null;
        // Whether anything has changed since the last write. The bridge flushes
        // on every shutdown, and without this a bridge that never touched a
        // template would create the file, empty, on its way out.
        this._dirty = false;
        this.load();
    }

    load() {
        this.rows = read();
    }

    save() {
        this._dirty = true;
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => this.flush(), 400);
        this._saveTimer.unref();
    }

    /** Write now, merged over the file. drafts.js's flush(), line for line in intent. */
    flush() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        if (!this._dirty) return;
        this._dirty = false;
        try {
            const merged = new Map(read().map(r => [r.id, r]));
            for (const row of this.rows) {
                const theirs = merged.get(row.id);
                if (!theirs || row.updatedAt >= theirs.updatedAt) merged.set(row.id, row);
            }
            for (const id of this._removed) merged.delete(id);
            this._removed.clear();
            const rows = [...merged.values()].sort(byUpdated).map(clean);
            writeAtomic(STATE_FILE, serialize({ version: VERSION, templates: rows }));
        } catch (err) {
            console.error(`[tgxcode] could not save templates: ${err.message}`);
        }
    }

    /** Strictly increasing. drafts.js's `_stamp` says why `Date.now()` is not enough. */
    _stamp() {
        const now = Date.now();
        let newest = 0;
        for (const r of this.rows) if (r.updatedAt > newest) newest = r.updatedAt;
        return now > newest ? now : newest + 1;
    }

    list({ cwd = null } = {}) {
        const rows = cwd ? this.rows.filter(r => matchesProject(r, cwd)) : this.rows;
        return rows.map(clean);
    }

    get(id) {
        const row = this.rows.find(r => r.id === id);
        return row ? clean(row) : null;
    }

    /** @returns {object|null} the template, or null at the cap (a 409). */
    create(fields = {}) {
        if (this.rows.length >= MAX_TEMPLATES) return null;
        const now = this._stamp();
        const row = clean({
            id: randomUUID(),
            name: String(fields.name).trim().slice(0, MAX_NAME),
            project: cleanDir(fields.project),
            cwd: orNull(fields.cwd),
            prompt: typeof fields.prompt === 'string' ? fields.prompt : '',
            model: orNull(fields.model),
            effort: orNull(fields.effort),
            permissionMode: String(fields.permissionMode || 'auto'),
            worktree: cleanWorktree(fields.worktree),
            orchestrator: !!fields.orchestrator,
            test: !!fields.test,
            createdAt: now,
            updatedAt: now,
        });
        this.rows.push(row);
        this.rows.sort(byUpdated);
        this.save();
        return clean(row);
    }

    /** A real patch: a key left out is left alone, and `null` is a value. */
    update(id, fields = {}) {
        const row = this.rows.find(r => r.id === id);
        if (!row) return null;
        if (fields.name !== undefined) row.name = String(fields.name).trim().slice(0, MAX_NAME);
        if (fields.project !== undefined) row.project = cleanDir(fields.project);
        if (fields.cwd !== undefined) row.cwd = orNull(fields.cwd);
        if (fields.prompt !== undefined) row.prompt = typeof fields.prompt === 'string' ? fields.prompt : '';
        if (fields.model !== undefined) row.model = orNull(fields.model);
        if (fields.effort !== undefined) row.effort = orNull(fields.effort);
        if (fields.permissionMode !== undefined) row.permissionMode = String(fields.permissionMode);
        if (fields.worktree !== undefined) row.worktree = cleanWorktree(fields.worktree);
        if (fields.orchestrator !== undefined) row.orchestrator = !!fields.orchestrator;
        if (fields.test !== undefined) row.test = !!fields.test;
        row.updatedAt = this._stamp();
        this.rows.sort(byUpdated);
        this.save();
        return clean(row);
    }

    remove(id) {
        const at = this.rows.findIndex(r => r.id === id);
        if (at < 0) return false;
        this.rows.splice(at, 1);
        this._removed.add(id);
        this.save();
        return true;
    }
}

module.exports = {
    Templates, STATE_FILE, VERSION, MAX_TEMPLATES, MAX_NAME, BUILTINS,
    matchesProject, projectOf, scanTemplate, fillTemplate, worktreeSlug, localDate,
};
