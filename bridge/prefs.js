'use strict';

// Settings the person using the app chose, as opposed to flags they set on one
// conversation.
//
// The first of these is how the transcript folds a finished run of tool calls
// into one row — whether to do it at all, how long a run has to be, and whether
// a thinking block counts as part of the run or ends it. They are preferences
// about reading rather than about any one session, so they do not belong in
// bridge/flags.js, and they are not per-browser either: the same answer should
// come back in the Electron window, in a tab, and on a phone.
//
// **Where the file lives is the deliberate part.** `~/.tgxcode/settings.json`,
// not STATE_DIR. Everything under STATE_DIR is state the app owns and nobody is
// expected to open — a token, a set of archived ids. This is a file a person
// edits by hand today and a settings page will write tomorrow, and it is the
// start of a directory meant to hold more than this app's share of it. A
// project may override any key from `<workspace>/.tgxcode/settings.json`, which
// is the same directory a project already declares its commands in — see
// bridge/commands.js, whose precedence this mirrors so the two cannot disagree
// about what "the local file" means.
//
// Unlike Flags, the defaults are written out on first read. A settings file
// with no UI in front of it has to be discoverable to be editable at all, and
// an empty `~/.tgxcode/` teaches nobody what may go in it.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { projectRootOf } = require('./transcript');

const VERSION = 1;

// A settings file is a handful of keys. Anything approaching this is either a
// mistake or an attempt to make the bridge do unbounded work parsing it — the
// same reasoning, and the same number, as commands.js.
const MAX_FILE_BYTES = 64 * 1024;

// Re-stat rather than watch, as commands.js does: one inotify watcher for a
// file that changes monthly is a poor trade, and this is read once per session
// open.
const CACHE_MS = 2000;

const DEFAULTS = {
    version: VERSION,
    transcript: {
        // Fold a run of tool calls into one row once a message closes it.
        groupToolCalls: true,
        // ...but only when the run is at least this long. One or two rows
        // collapsed into a summary row loses more than it saves.
        groupMinCalls: 3,
        // Whether a thinking block is part of the work stretch or the end of
        // it. Folding it in keeps runs long; breaking on it fragments a turn
        // that thinks between every call into groups of two.
        groupIncludesThinking: true,
    },
};

// What each key is allowed to be. A file is a thing people edit, so a bad value
// is dropped and the default kept rather than taken at face value — a
// `groupMinCalls` of `"3"` or of `-1` would otherwise turn grouping off with no
// account of itself.
const SHAPE = {
    transcript: {
        groupToolCalls: (v) => typeof v === 'boolean',
        groupMinCalls: (v) => Number.isInteger(v) && v >= 2 && v <= 1000,
        groupIncludesThinking: (v) => typeof v === 'boolean',
    },
};

/**
 * Read one settings file.
 *
 * Stat before read, in the shape of readConfig() in commands.js: a file of
 * unknown size never goes into memory whole.
 *
 * @returns {{data: object|null, stamp: string|null, problem: object|null}}
 */
function readFile(file) {
    let st;
    try { st = fs.statSync(file); } catch { return { data: null, stamp: null, problem: null }; }
    if (!st.isFile()) return { data: null, stamp: null, problem: null };
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (st.size > MAX_FILE_BYTES) {
        return { data: null, stamp,
            problem: { file, message: `larger than ${MAX_FILE_BYTES / 1024}KB — ignored` } };
    }

    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (err) { return { data: null, stamp, problem: { file, message: err.message } }; }

    let data;
    // Tolerate a BOM the same way flags.js and commands.js do.
    try { data = JSON.parse(raw.replace(/^﻿/, '')); }
    catch (err) { return { data: null, stamp, problem: { file, message: err.message } }; }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { data: null, stamp, problem: { file, message: 'not a JSON object' } };
    }
    // Absent is fine: a project file that only sets one key has no reason to
    // restate the version. A *wrong* version is not.
    if (data.version !== undefined && data.version !== VERSION) {
        return { data: null, stamp,
            problem: { file, message: `unknown version ${JSON.stringify(data.version)} — expected ${VERSION}` } };
    }
    return { data, stamp, problem: null };
}

/** Fold one file's keys over an accumulating result, dropping what fails SHAPE. */
function merge(into, data, file, problems) {
    for (const [section, checks] of Object.entries(SHAPE)) {
        const block = data[section];
        if (block === undefined) continue;
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
            problems.push({ file, message: `"${section}" is not an object — ignored` });
            continue;
        }
        for (const [key, ok] of Object.entries(checks)) {
            if (block[key] === undefined) continue;
            if (!ok(block[key])) {
                problems.push({ file,
                    message: `${section}.${key}: ${JSON.stringify(block[key])} is not a valid value — ignored` });
                continue;
            }
            into[section][key] = block[key];
        }
    }
}

class Prefs {
    constructor() {
        this.cache = new Map();   // workspace ('' for user-level only) -> {at, stamp, value}
        this.ensureUserFile();
    }

    /**
     * Write the defaults out if there is no user file yet.
     *
     * Failure is not fatal and not worth a throw: a read-only home directory
     * costs the user a place to edit, not the app a preference — everything
     * still falls back to DEFAULTS.
     */
    ensureUserFile() {
        try {
            if (fs.existsSync(cfg.USER_PREFS_FILE)) return;
            fs.mkdirSync(path.dirname(cfg.USER_PREFS_FILE), { recursive: true });
            const tmp = cfg.USER_PREFS_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(DEFAULTS, null, 2) + '\n');
            fs.renameSync(tmp, cfg.USER_PREFS_FILE);
        } catch (err) {
            console.error(`[claude-sessions] could not create ${cfg.USER_PREFS_FILE}: ${err.message}`);
        }
    }

    /**
     * Which files apply, weakest first.
     *
     * The project half mirrors readMerged() in commands.js exactly, because the
     * two read the same directory and a reader should not have to hold two
     * different precedence rules in mind:
     *
     *  - the workspace's own checked-in file, falling back to the project's
     *    only if it has none, so a worktree branched before the file existed
     *    does not lose the setting;
     *  - the gitignored local file from the main checkout, so your own
     *    overrides follow you into every worktree of it;
     *  - ...unless somebody deliberately put one in the worktree.
     */
    files(dir) {
        const out = [{ file: cfg.USER_PREFS_FILE }];
        if (!dir || !cfg.withinRoots(dir)) return out;

        const workspace = path.resolve(cfg.expandHome(dir));
        const project = projectRootOf(workspace);
        out.push(
            { file: path.join(workspace, cfg.TGX_DIR, cfg.SETTINGS_FILE),
                fallback: path.join(project, cfg.TGX_DIR, cfg.SETTINGS_FILE) },
            { file: path.join(project, cfg.TGX_DIR, cfg.SETTINGS_LOCAL_FILE) },
            { file: path.join(workspace, cfg.TGX_DIR, cfg.SETTINGS_LOCAL_FILE) },
        );
        return out;
    }

    /**
     * The settings in force for a directory.
     *
     * @param {string} [dir] a workspace — a session's cwd. Omitted gives the
     *   user-level answer, which is what the page is served before it knows
     *   which conversation it is about to show.
     * @returns {{version, transcript, sources: string[], problems: object[]}}
     */
    forCwd(dir) {
        const key = dir || '';
        const specs = this.files(dir);

        const reads = [];
        for (const spec of specs) {
            let read = readFile(spec.file);
            let file = spec.file;
            if (!read.data && !read.problem && spec.fallback && spec.fallback !== spec.file) {
                file = spec.fallback;
                read = readFile(file);
            }
            reads.push({ file, read });
        }

        const stamp = reads.map(r => `${r.file}@${r.read.stamp || '-'}`).join('|');
        const hit = this.cache.get(key);
        if (hit && hit.stamp === stamp && Date.now() - hit.at < CACHE_MS) return hit.value;

        const value = {
            version: VERSION,
            transcript: { ...DEFAULTS.transcript },
            sources: [],
            problems: [],
        };
        // In the main checkout the project and workspace local files are the
        // same path; reading it twice would double every problem it reports.
        const seen = new Set();
        for (const { file, read } of reads) {
            if (seen.has(file)) continue;
            seen.add(file);
            if (read.problem) value.problems.push(read.problem);
            if (!read.data) continue;
            merge(value, read.data, file, value.problems);
            value.sources.push(file);
        }

        this.cache.set(key, { at: Date.now(), stamp, value });
        return value;
    }

    /**
     * The same answer without the diagnostics, for the copy that goes into
     * every page as a <meta> tag. `sources` names files in the user's home
     * directory and nothing in the page reads it; a route can say more than a
     * document that gets served to a phone.
     */
    page(dir) {
        const { sources, problems, ...settings } = this.forCwd(dir);
        return settings;
    }
}

module.exports = { Prefs, DEFAULTS, VERSION };
