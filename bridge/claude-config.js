'use strict';

// Claude Code's own settings files — read as a precedence chain, written one
// key at a time or one document at a time.
//
// This is bridge/prefs.js's shape applied to somebody else's file, and the
// three ways it has to differ are the whole design:
//
//   1. **The file is the truth; our catalogue is a rendering hint.** prefs.js
//      merges by iterating SHAPE, so a key it does not know is invisible. That
//      is right for a closed world we own and catastrophic here — the app would
//      hide a permission rule it had never heard of. This module walks the
//      *file* and reports everything in it, catalogued or not. See
//      bridge/claude-schema.js.
//
//   2. **A write has a precondition, because we are not the only writer.**
//      `claude` writes these files itself: `theme` and `editorMode` change from
//      `/config`, `enabledPlugins` from a plugin toggle, and
//      `.claude/settings.local.json` gains a rule every time somebody approves
//      a permission mid-turn. So a whole-document write carries the `stamp` of
//      the document it was derived from and is refused if the file has moved
//      on. Nothing in `~/.tgxcode/` needs that, which is why prefs.js has no
//      such concept and why grafting one on would have changed its contract.
//
//      A single scalar key does *not* need the stamp: the read happens
//      immediately before the write, so setting one key cannot revert another.
//      A whole collection does — `permissions.allow` is one key holding
//      twenty-eight rules, and writing the array a page loaded ten minutes ago
//      would silently drop the rule that was approved since.
//
//   3. **`version` is never written.** prefs.js stamps its own document, which
//      is correct for a format it defines. Doing it here would inject a key
//      Claude Code does not define into the user's own file. This is the reason
//      the two cannot share `save()`, more than any of the above.
//
// What this module will not do: merge on conflict. We do not own the schema, so
// we cannot merge safely — `hooks` is an array where order matters and a naive
// union produces a hook that fires twice per tool call. A conflict is refused
// and a person looks at it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('./config');
const schema = require('./claude-schema');
const {
    readJson, serialize, writeAtomic, writable, escapes, stampNow, refuse,
} = require('./jsonfile');

const { CATALOG, isPlainObject } = schema;

// The three scopes a save may target, weakest first. `managed` is a fourth
// row in the chain and deliberately not in this list.
const SCOPES = ['user', 'project', 'project-local'];

// A dotted path deeper than this is either a mistake or an attempt to walk
// somewhere. Four segments reaches `a.b.c.d`, which is deeper than anything in
// the real schema that is not a free-form map.
const MAX_DEPTH = 4;

// Assigning into an object from a client-supplied path. These are refused by
// name rather than filtered out, because a filter that silently drops a segment
// changes which key gets written.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

// How deep the reader walks looking for leaves. Past this a value is reported
// whole rather than descended into.
const WALK_DEPTH = 3;

// A settings file people also hand-edit; the cache is short because the whole
// point of the page is that it never shows a stale value.
const CACHE_MS = 1000;

/**
 * Every file that decides what `claude` does in a directory, weakest first.
 *
 * Four rows for three scopes, and unlike Prefs.files() the extra one is not a
 * duplicate scope but a stronger file nobody can write: an administrator's
 * `managed-settings.json` overrides all three. It is reported precisely because
 * it is absent almost everywhere — a page that showed three rows when there are
 * four would be lying in the one case where the answer matters.
 *
 * @param {string} [dir] a workspace. Omitted gives the user row alone.
 */
function chainFor(dir) {
    const out = [{ file: cfg.USER_CLAUDE_SETTINGS, scope: 'user', within: cfg.USER_CLAUDE_DIR }];
    if (dir && cfg.withinRoots(dir)) {
        // The workspace itself, not its main checkout. Claude Code reads the
        // `.claude` of the directory it is running in, so a worktree's own file
        // is the one in force — none of Prefs.files()'s fallback applies.
        const workspace = path.resolve(cfg.expandHome(dir));
        const within = path.join(workspace, cfg.CLAUDE_DIR);
        out.push(
            { file: path.join(within, cfg.CLAUDE_SETTINGS_FILE), scope: 'project', within },
            { file: path.join(within, cfg.CLAUDE_SETTINGS_LOCAL_FILE), scope: 'project-local', within },
        );
    }
    out.push({
        file: cfg.MANAGED_CLAUDE_SETTINGS, scope: 'managed',
        within: path.dirname(cfg.MANAGED_CLAUDE_SETTINGS), readonly: true,
    });
    return out;
}

/**
 * Walk one settings document into `{dottedPath: value}` leaves.
 *
 * A catalogued path is a leaf whatever it holds — `env`, `enabledPlugins` and
 * `hooks` are objects the page has one control for, and descending into them
 * would turn one control into forty. Everything else is a leaf if it is a
 * scalar or an array, and recursed into if it is an object.
 */
function leaves(data, prefix = '', depth = 0, out = new Map()) {
    for (const [key, value] of Object.entries(data)) {
        const dotted = prefix ? `${prefix}.${key}` : key;
        if (!CATALOG.has(dotted) && isPlainObject(value) && depth < WALK_DEPTH) {
            leaves(value, dotted, depth + 1, out);
            continue;
        }
        out.set(dotted, value);
    }
    return out;
}

const typeOf = (v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
};
const isScalar = (v) => v === null || ['boolean', 'number', 'string'].includes(typeof v);

/** Read a dotted path out of a document, or undefined. */
function getPath(doc, dotted) {
    let at = doc;
    for (const seg of dotted.split('.')) {
        if (!isPlainObject(at)) return undefined;
        at = at[seg];
    }
    return at;
}

/**
 * Set or remove a dotted path in a document, in place.
 *
 * Objects along the way are copied rather than mutated so a caller holding the
 * document it read is not changed under it, and an object left with no keys is
 * removed rather than written out as `{}` — a file people read should not
 * accumulate empty braces for keys they cleared.
 */
function setPath(doc, dotted, value) {
    const segs = dotted.split('.');
    const last = segs.pop();
    let at = doc;
    const trail = [];
    for (const seg of segs) {
        if (!isPlainObject(at[seg])) {
            if (value === null) return;   // nothing to remove
            at[seg] = {};
        } else {
            at[seg] = { ...at[seg] };
        }
        trail.push([at, seg]);
        at = at[seg];
    }
    if (value === null) delete at[last];
    else at[last] = value;

    // Prune upward: a section emptied by a removal goes with it.
    for (let i = trail.length - 1; i >= 0; i -= 1) {
        const [parent, seg] = trail[i];
        if (isPlainObject(parent[seg]) && Object.keys(parent[seg]).length === 0) delete parent[seg];
        else break;
    }
}

/** `$HOME/x` rather than `/home/someone/x`, for a summary line. */
function shortHome(text) {
    const home = os.homedir();
    return typeof text === 'string' ? text.split(home).join('$HOME') : text;
}

/**
 * What a `hooks` block actually points at, and whether it is still there.
 *
 * The check that earns this its place: a hook whose script has been deleted
 * fails quietly, and nothing in Claude Code says so. Pulling the first path-like
 * token out of the command and stat-ing it is approximate — a command may be a
 * pipeline, and `$HOME` has to be expanded by hand — but approximate and
 * usually right beats a text editor, which cannot answer at all.
 */
function hookSummary(hooks) {
    if (!isPlainObject(hooks)) return [];
    const out = [];
    for (const [event, matchers] of Object.entries(hooks)) {
        if (!Array.isArray(matchers)) continue;
        for (const m of matchers) {
            const entries = m && Array.isArray(m.hooks) ? m.hooks : [];
            for (const h of entries) {
                const command = h && typeof h.command === 'string' ? h.command : null;
                out.push({
                    event,
                    matcher: m && typeof m.matcher === 'string' ? m.matcher : null,
                    type: h && typeof h.type === 'string' ? h.type : null,
                    command: shortHome(command),
                    script: scriptState(command || (h && h.file) || null),
                });
            }
        }
    }
    return out;
}

/**
 * Does the file a hook command names exist?
 *
 * `null` when no path could be picked out — which is the honest answer for
 * `type: "prompt"` and for a one-liner that runs no script. Only a token that
 * looks like a path is considered, so `python3` alone is not reported missing.
 */
function scriptState(command) {
    if (typeof command !== 'string' || !command) return null;
    const home = os.homedir();
    // Quoted or bare, and only tokens with a separator in them: a bare word is
    // a program on PATH and not this function's business.
    const tokens = command.match(/"[^"]+"|'[^']+'|\S+/g) || [];
    for (const raw of tokens) {
        const token = raw.replace(/^["']|["']$/g, '');
        if (!token.includes('/')) continue;
        const file = token
            .replace(/^\$HOME\b/, home)
            .replace(/^~(?=\/)/, home)
            .replace(/^\$\{?CLAUDE_PROJECT_DIR\}?\b.*/, '');   // not ours to resolve
        if (!file || !path.isAbsolute(file)) continue;
        return { file: shortHome(file), exists: fs.existsSync(file) };
    }
    return null;
}

/**
 * Every plugin this machine has installed, by the id `enabledPlugins` uses.
 *
 * The point is the *union* with what the file says: a plugin that is installed
 * and that the settings file has never mentioned becomes a checkbox you can
 * tick, rather than a name you have to know how to spell. That is the one thing
 * this control does that a text editor cannot.
 *
 * The manifest's keys already carry the `name@marketplace` form, which is what
 * `enabledPlugins` is keyed by, so no assembly is needed — unlike
 * pluginRoots() in bridge/slash-commands.js, which wants the install paths and
 * has to de-duplicate them.
 */
function installedPlugins() {
    const manifest = path.join(cfg.USER_CLAUDE_DIR, 'plugins', 'installed_plugins.json');
    const read = readJson(manifest, { maxBytes: 1024 * 1024 });
    const plugins = read.data && read.data.plugins;
    if (!isPlainObject(plugins)) return [];
    return Object.keys(plugins);
}

/** Is this `statusLine` the one scripts/install-quota-statusline.js wrote? */
const ourStatusLine = (line) => !!line && typeof line === 'object'
    && typeof line.command === 'string' && line.command.includes('quota-statusline.py');

class ClaudeConfig {
    constructor() {
        /** @type {Map<string, {at: number, value: any}>} workspace ('' for user only) -> payload */
        this.cache = new Map();
    }

    /**
     * The one file a scope writes for a directory.
     *
     * @returns {string|null} null when the scope needs a directory and has
     *   none, when the directory is not one this bridge will read, or when the
     *   scope is not one that may be written at all.
     */
    targetFile(scope, dir) {
        if (scope === 'user') return cfg.USER_CLAUDE_SETTINGS;
        if (scope !== 'project' && scope !== 'project-local') return null;
        if (!dir || !cfg.withinRoots(dir)) return null;
        const workspace = path.resolve(cfg.expandHome(dir));
        return path.join(workspace, cfg.CLAUDE_DIR,
            scope === 'project' ? cfg.CLAUDE_SETTINGS_FILE : cfg.CLAUDE_SETTINGS_LOCAL_FILE);
    }

    /**
     * Everything the Settings page needs about a directory, in one answer.
     *
     * Deliberately one call rather than "in force" and "per file" as two, the
     * way GET /api/prefs splits them: there is no client here that wants only
     * the merged answer. Nothing in this app behaves differently because of
     * these files, so the merged view exists to be *displayed* beside the files
     * it came from, and splitting it would only mean two reads of four files.
     */
    read(dir) {
        const key = dir || '';
        const hit = this.cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

        const specs = chainFor(dir);
        const files = specs.map((spec) => {
            const read = readJson(spec.file);
            const symlink = escapes(spec.file, spec.within);
            const exists = read.stamp !== null;
            return {
                file: spec.file,
                scope: spec.scope,
                readonly: !!spec.readonly,
                target: !spec.readonly,
                exists,
                parsed: exists ? read.problem === null : false,
                writable: spec.readonly ? false : (!symlink && writable(spec.file)),
                symlink,
                size: read.size,
                stamp: read.stamp,
                text: read.text,
                values: read.data ? Object.fromEntries(leaves(read.data)) : {},
                problems: [
                    ...(read.problem ? [read.problem.message] : []),
                    ...(symlink ? ['a symlink — every save here is refused'] : []),
                ],
            };
        });

        const value = {
            files,
            effective: effectiveOf(files),
            unknown: unknownOf(files),
            hooks: hookSummary(mergedHooks(files)),
            statusLine: statusLineOf(files),
            installedPlugins: installedPlugins(),
            catalogue: schema.GROUPS,
            catalogueAgainst: schema.AGAINST_VERSION,
            scopes: SCOPES,
            problems: files.flatMap(f => f.problems.map(message => ({ file: f.file, message }))),
        };
        this.cache.set(key, { at: Date.now(), value });
        return value;
    }

    /**
     * Save one or more dotted paths into one file.
     *
     * @param {{scope: string, dir?: string, stamp?: string|null,
     *   patch: Record<string, any>}} req `null` as a value removes the key.
     *   `stamp` is required whenever a value is an array or an object, and
     *   whenever a key holding one is being removed.
     */
    save({ scope, dir, stamp, patch }) {
        const file = this._writeTarget(scope, dir);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw refuse('body', 'patch is not an object');
        }
        const entries = Object.entries(patch);
        if (!entries.length) throw refuse('body', 'patch is empty');

        const before = readJson(file);
        if (before.problem) {
            // Narrower than PUT /api/prefs, which refuses outright. A patch
            // cannot be applied to a document that did not parse — there is
            // nothing to merge into — but `text` can replace it, and that is
            // the only repair the app can offer. See saveText().
            throw refuse('unparseable',
                `${file}: ${before.problem.message}. The raw JSON tab can replace it.`);
        }

        // Validate the whole patch before touching anything, so a refusal
        // leaves the file as it was — including the keys beside the bad one.
        const clean = [];
        let needsStamp = false;
        for (const [dotted, value] of entries) {
            const segs = String(dotted).split('.');
            if (segs.length > MAX_DEPTH || segs.some(s => !s)) {
                throw refuse('path', `${JSON.stringify(dotted)} is not a settings path`);
            }
            if (segs.some(s => RESERVED.has(s))) {
                throw refuse('path', `${JSON.stringify(dotted)} names a reserved property`);
            }
            if (!isScalar(value)) needsStamp = true;

            if (value === null) {
                // A removal needs no type agreement. It does need the stamp
                // when what is being removed is a collection.
                const current = getPath(before.data || {}, dotted);
                if (current !== undefined && !isScalar(current)) needsStamp = true;
                clean.push([dotted, null]);
                continue;
            }

            if (CATALOG.has(dotted)) {
                if (!schema.check(dotted, value)) {
                    throw refuse('value',
                        `${dotted}: expected ${schema.describe(dotted)}`);
                }
                clean.push([dotted, value]);
                continue;
            }

            // Not catalogued. Editable anyway when it already holds a scalar
            // somewhere in the chain, and only as the same JSON type — which is
            // what stops a text box turning `switchModelsOnFlag: false` into
            // the string `"false"`. A key nothing in the chain has is refused:
            // the app will keep a key it does not understand, but it will not
            // invent one.
            const known = this._chainValue(dotted, dir);
            if (known === undefined) {
                throw refuse('path',
                    `${dotted} is not a key this page knows, and no settings file has it. `
                    + 'Use the raw JSON tab to add it.');
            }
            if (!isScalar(known)) {
                throw refuse('path',
                    `${dotted} holds ${typeOf(known)} — use Edit as JSON rather than a control`);
            }
            if (typeOf(value) !== typeOf(known)) {
                throw refuse('value',
                    `${dotted} holds ${typeOf(known)}; refusing to write ${typeOf(value)}`);
            }
            clean.push([dotted, value]);
        }

        if (needsStamp) this._checkStamp(file, stamp, before.stamp);

        const doc = before.data ? { ...before.data } : {};
        for (const [dotted, value] of clean) setPath(doc, dotted, value);

        this._write(file, serialize(doc));
        return { file, ...this._after(dir, file) };
    }

    /**
     * Replace one file's whole contents.
     *
     * The raw tab's path, and the only one that can repair a file that does not
     * parse. `stamp` is mandatory here — the caller is replacing keys it may
     * never have looked at.
     */
    saveText({ scope, dir, stamp, text }) {
        const file = this._writeTarget(scope, dir);
        if (typeof text !== 'string') throw refuse('body', 'text is not a string');
        if (Buffer.byteLength(text) > schema.MAX_STRING * 16) {
            throw refuse('size', 'that is larger than a settings file should be');
        }

        let doc;
        try { doc = JSON.parse(text.replace(/^﻿/, '')); }
        catch (err) { throw refuse('json', err.message); }
        if (!isPlainObject(doc)) throw refuse('json', 'the document is not a JSON object');

        this._checkStamp(file, stamp, stampNow(file));

        // Re-serialised rather than written through, so the file keeps the two
        // spaces and the trailing newline Claude Code writes and the diff of a
        // one-key change stays one line. The cost is that a hand-formatted file
        // is reformatted by a save, which is worth saying in the UI.
        this._write(file, serialize(doc));
        return { file, ...this._after(dir, file) };
    }

    /** The scope checks every write shares. */
    _writeTarget(scope, dir) {
        if (scope === 'managed') {
            throw refuse('readonly', 'managed settings are an administrator’s, not yours to write');
        }
        if (!SCOPES.includes(scope)) {
            throw refuse('scope', `${JSON.stringify(scope)} is not a settings scope`);
        }
        if (scope !== 'user' && !dir) throw refuse('dir', `scope ${scope} needs a directory`);
        if (scope !== 'user' && !cfg.withinRoots(dir)) {
            throw refuse('dir', `${dir} is not a directory this bridge will read`);
        }
        const file = this.targetFile(scope, dir);
        if (!file) throw refuse('scope', `no settings file for scope ${JSON.stringify(scope)}`);
        const within = path.dirname(file);
        if (escapes(file, within)) {
            throw refuse('readonly', `${file} is a symlink — refusing to write through it`);
        }
        if (!writable(file)) throw refuse('write', `${file} cannot be written`);
        return file;
    }

    /**
     * Is the file still the one the caller read?
     *
     * `undefined` is the caller not having sent one, which is only reached for
     * a scalar patch; `null` means "this file should not exist yet", which is
     * how a page that has never seen the file says so.
     */
    _checkStamp(file, sent, current) {
        if (sent === undefined) {
            throw refuse('stamp', 'this change replaces a whole key, so it needs the stamp it was read with');
        }
        if (sent === null && current !== null) {
            const err = refuse('exists', `${file} exists now — it did not when this page loaded`);
            err.detail = { stamp: current };
            throw err;
        }
        if (sent !== null && sent !== current) {
            const err = refuse('stale',
                current === null
                    ? `${file} has been deleted since this page loaded`
                    : `${file} has changed since this page loaded`);
            const read = readJson(file);
            err.detail = { stamp: current, text: read.text };
            throw err;
        }
    }

    _write(file, text) {
        try {
            writeAtomic(file, text);
        } catch (err) {
            throw refuse('write', `${file}: ${err.message}`);
        }
        this.cache.clear();
    }

    /**
     * What now holds, for the response body.
     *
     * The caller takes this rather than assuming its own value is the answer,
     * for the reason PUT /api/prefs already documents: a save into a file that
     * something stronger overrides changes nothing about what is in force, and
     * a client that assumed success draws that case wrongly. The fresh `stamp`
     * matters more here — it is what the caller's *next* write has to send.
     */
    _after(dir, file) {
        this.cache.clear();
        return { stamp: stampNow(file), config: this.read(dir) };
    }

    /** The strongest value any file in the chain has for a path. */
    _chainValue(dotted, dir) {
        const { files } = this.read(dir);
        let found;
        for (const f of files) {
            if (Object.prototype.hasOwnProperty.call(f.values, dotted)) found = f.values[dotted];
        }
        return found;
    }
}

/**
 * The merged view, and where each value came from.
 *
 * **This is our reading of Claude Code's precedence, not something Claude Code
 * told us.** Said out loud here and in docs/api.md, because the app cannot ask
 * the CLI what it concluded and a client that treated this as authoritative
 * would be trusting a guess.
 *
 * A permission list is the one place where "strongest wins" is simply wrong:
 * `allow`, `deny` and `ask` add up across scopes, so the twenty-eight rules in
 * the user file and the twenty-five in the local one are all in force. Those
 * come back with `merged: true` and a per-file breakdown, and the page must not
 * draw its "overridden, so this has no effect" sentence over them.
 */
function effectiveOf(files) {
    const out = {};
    for (const f of files) {
        if (!f.parsed) continue;
        for (const [dotted, value] of Object.entries(f.values)) {
            const row = CATALOG.get(dotted);
            if (row && row.kind === 'rules') {
                const at = out[dotted] || (out[dotted] = { value: [], merged: true, from: [] });
                const list = Array.isArray(value) ? value : [];
                // The entries, not just how many. Seeing the user file's rules
                // and the project's together is the thing that took opening two
                // files before, and it is most of why this control is worth
                // more than a text editor.
                at.from.push({ scope: f.scope, file: f.file, count: list.length, values: list });
                for (const rule of list) if (!at.value.includes(rule)) at.value.push(rule);
                continue;
            }
            out[dotted] = { value, scope: f.scope, file: f.file };
        }
    }
    return out;
}

/**
 * Keys in the files that the catalogue does not model.
 *
 * `kind` is what the page needs to decide whether it can offer a control:
 * `scalar` gets a generic one by JSON type, anything else gets a read-only row
 * and an Edit as JSON button. Nothing is left out of this list — a key the app
 * has never heard of is exactly the key somebody needs to find.
 */
function unknownOf(files) {
    const seen = new Map();
    for (const f of files) {
        if (!f.parsed) continue;
        for (const [dotted, value] of Object.entries(f.values)) {
            if (CATALOG.has(dotted)) continue;
            seen.set(dotted, {
                path: dotted,
                kind: isScalar(value) ? 'scalar' : typeOf(value),
                type: typeOf(value),
                preview: preview(value),
                scope: f.scope,
                file: f.file,
            });
        }
    }
    return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** One line of JSON, clipped — enough to recognise a value by. */
function preview(value) {
    let text;
    try { text = JSON.stringify(value); } catch { return '…'; }
    if (text === undefined) return 'undefined';
    text = text.replace(/\s+/g, ' ');
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** The strongest `hooks` block, for the summary. */
function mergedHooks(files) {
    let found = null;
    for (const f of files) {
        if (f.parsed && isPlainObject(f.values.hooks)) found = f.values.hooks;
    }
    return found;
}

/** The strongest `statusLine`, and whether this app is the one that set it. */
function statusLineOf(files) {
    let found = null;
    let from = null;
    for (const f of files) {
        if (f.parsed && f.values.statusLine !== undefined) {
            found = f.values.statusLine;
            from = f;
        }
    }
    if (found === null) return null;
    return {
        value: found,
        scope: from.scope,
        file: from.file,
        ours: ourStatusLine(found),
        command: shortHome(found && found.command),
    };
}

module.exports = {
    ClaudeConfig, SCOPES, chainFor, leaves, setPath, getPath,
    hookSummary, ourStatusLine, effectiveOf, unknownOf, installedPlugins,
};
