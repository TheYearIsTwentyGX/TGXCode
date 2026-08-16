'use strict';

// What slash commands a directory can run, so the composer can offer them.
//
// The list comes from the CLI itself. Every `claude` process opens its stream
// with a system/init message carrying `slash_commands` — built-ins, the user's
// ~/.claude/commands, the project's .claude/commands, plugins and skills, all
// already resolved and already filtered to the ones a user may invoke. It also
// carries `terminal_slash_commands`, whose own schema says: "Phone/remote UIs
// should hide these from command menus." That field is absent when empty, so a
// missing one means none, never unknown.
//
// **We do not scan the filesystem for the list.** That was the obvious design
// and it is worse on every axis: it cannot see built-ins at all (most of the
// menu), it cannot apply `userInvocable` or `terminalOriented` — those are
// properties of a loaded command, not of a file — and on this machine
// ~/.claude/commands does not exist while only three of seven installed plugins
// ship a commands/ directory. It would work hard for a fraction of the answer.
//
// Disk is still read, but only for *descriptions*: `init` gives names, and a
// name on its own is a poor menu row. See `docsFor` below, which is best-effort
// and never gates a command from being offered.
//
// **Keyed by cwd, not by session id.** Commands resolve from the working
// directory, so every session in a checkout has the same list and one session's
// init warms the menu for all of them — including sessions that have never run.
// init reports its own `cwd`, so nothing has to be inferred.
//
// **Rejected: probing on demand.** `claude --init-only` would fetch a list for a
// cold directory, but it runs the user's SessionStart hooks — this repo has them
// — and a keystroke in a text box must not fire a Setup hook. The cold case is
// handled by falling back to another directory's list instead, flagged inexact.
//
// This is a cache, not state: the next process start rebuilds it. So it lives
// under CACHE_DIR, on the line bridge/config.js draws — losing it costs a
// rescan, and loses no decision anyone made.

const fs = require('fs');
const path = require('path');

const { CACHE_DIR, HOME } = require('./config');

const CACHE_FILE = path.join(CACHE_DIR, 'commands.json');
const VERSION = 1;

// Enough for every directory anyone is realistically moving between, and small
// enough that the file stays a cache rather than a log of everywhere you have
// ever worked.
const MAX_ENTRIES = 50;

// A description scan is a handful of small directory reads, but it sits behind a
// keystroke, so it is memoised. Short enough that installing a plugin shows up
// without a restart; long enough that holding a key down does not walk the disk.
const DOC_TTL_MS = 30_000;

class CommandCache {
    constructor() {
        /** cwd -> { cwd, commands: string[], at: number, source: 'runner'|'cache' } */
        this.entries = new Map();
        this._docs = new Map();     // cwd -> { at, map: Map<name, {description, argumentHint}> }
        this._saveTimer = null;
        this.load();
    }

    /**
     * Record what an init message said about a directory.
     *
     * Returns the entry when the list actually moved, and null when it did not —
     * the caller broadcasts on the former only. Without that, every process
     * start would push an identical list to every open window for nothing.
     */
    note(cwd, init) {
        if (!cwd || !init) return null;
        const all = Array.isArray(init.slash_commands) ? init.slash_commands : null;
        if (!all) return null;

        // Absent means none. The field is omitted when empty and on CLIs that
        // predate it, so treating a missing one as "unknown" would either hide
        // everything or hide nothing, and both are wrong.
        const terminal = new Set(
            Array.isArray(init.terminal_slash_commands) ? init.terminal_slash_commands : []);

        const commands = all.filter(n => typeof n === 'string' && !terminal.has(n));

        const prev = this.entries.get(cwd);
        if (prev && sameList(prev.commands, commands)) {
            prev.source = 'runner';
            return null;
        }

        const entry = { cwd, commands, at: Date.now(), source: 'runner' };
        this.entries.set(cwd, entry);
        this._evict();
        this.save();
        return entry;
    }

    /**
     * The list for a directory, with descriptions attached.
     *
     * A directory nobody has run in yet borrows the most recent list from
     * anywhere, flagged `exact: false`. Built-ins and user-level commands are the
     * same everywhere; only project commands and project-scoped plugins differ.
     * So a new project gets a mostly-right menu on the first keystroke instead of
     * an empty box, and the response says plainly that it is approximate.
     */
    for(cwd) {
        const exact = cwd ? this.entries.get(cwd) : null;
        const entry = exact || this._mostRecent();
        if (!entry) return { cwd, commands: [], at: 0, exact: false, source: 'none' };

        const docs = cwd ? this.docsFor(cwd) : new Map();
        return {
            cwd: entry.cwd,
            at: entry.at,
            exact: Boolean(exact),
            source: exact ? entry.source : 'fallback',
            commands: entry.commands.map((name) => {
                const d = docs.get(name);
                // Built-ins have no file and so no description. A row with just a
                // name is honest; an invented one is not.
                if (!d) return { name };
                const out = { name };
                if (d.description) out.description = d.description;
                if (d.argumentHint) out.argumentHint = d.argumentHint;
                return out;
            }),
        };
    }

    _mostRecent() {
        let best = null;
        for (const e of this.entries.values()) if (!best || e.at > best.at) best = e;
        return best;
    }

    _evict() {
        if (this.entries.size <= MAX_ENTRIES) return;
        const byAge = [...this.entries.values()].sort((a, b) => a.at - b.at);
        for (const e of byAge.slice(0, this.entries.size - MAX_ENTRIES)) {
            this.entries.delete(e.cwd);
        }
    }

    // ── descriptions ─────────────────────────────────────────────────────

    /**
     * name -> {description, argumentHint} for every command backed by a file.
     *
     * Best-effort by design: a name with no file, an unreadable directory and a
     * malformed frontmatter block all produce the same thing, which is nothing,
     * and a command with nothing still appears in the menu under its own name.
     * Nothing here may throw — this sits behind a keystroke.
     */
    docsFor(cwd) {
        const hit = this._docs.get(cwd);
        if (hit && (Date.now() - hit.at) < DOC_TTL_MS) return hit.map;

        const map = new Map();
        // Lowest precedence first: a later write wins, so a project command
        // shadowing a plugin's shows the project's description, which is the one
        // the CLI will actually run.
        for (const [dir, prefix] of pluginRoots()) collectDir(map, dir, prefix);
        collectHome(map);
        collectProject(map, cwd);

        this._docs.set(cwd, { at: Date.now(), map });
        return map;
    }

    // ── persistence ──────────────────────────────────────────────────────

    load() {
        let raw;
        try { raw = fs.readFileSync(CACHE_FILE, 'utf8'); } catch { return; }
        try {
            const data = JSON.parse(raw.replace(/^﻿/, ''));
            if (data.version !== VERSION || !Array.isArray(data.entries)) return;
            for (const e of data.entries) {
                if (!e || typeof e.cwd !== 'string' || !Array.isArray(e.commands)) continue;
                this.entries.set(e.cwd, {
                    cwd: e.cwd,
                    commands: e.commands.filter(n => typeof n === 'string'),
                    at: Number(e.at) || 0,
                    // Not 'runner': no process has confirmed this list since the
                    // bridge started, and /api/commands says so.
                    source: 'cache',
                });
            }
            this._evict();
        } catch (err) {
            console.error(`[claude-sessions] ignoring unreadable ${CACHE_FILE}: ${err.message}`);
        }
    }

    /** Debounced atomic write, as bridge/flags.js does. */
    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            try {
                fs.mkdirSync(CACHE_DIR, { recursive: true });
                const tmp = CACHE_FILE + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify({
                    version: VERSION,
                    entries: [...this.entries.values()].map(e => ({
                        cwd: e.cwd, commands: e.commands, at: e.at,
                    })),
                }, null, 2));
                fs.renameSync(tmp, CACHE_FILE);
            } catch (err) {
                console.error(`[claude-sessions] could not save commands: ${err.message}`);
            }
        }, 400);
        this._saveTimer.unref();
    }
}

function sameList(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ── where descriptions come from ─────────────────────────────────────────

/**
 * Every installed plugin's directory, once each, with the namespace its commands
 * carry.
 *
 * The manifest lists an install record per scope, so the same `installPath`
 * appears many times over — eight or more for a plugin enabled in several
 * projects. The cache directory alongside it is worse: it holds a directory per
 * version (`unknown`, a sha, a semver) for the same plugin, so globbing it shows
 * every command two and three times. Reading installPath and de-duplicating is
 * what makes the list come out right.
 */
function pluginRoots() {
    const manifest = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');
    let data;
    try { data = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { return []; }
    const plugins = data && data.plugins;
    if (!plugins || typeof plugins !== 'object') return [];

    const seen = new Set();
    const out = [];
    for (const [key, records] of Object.entries(plugins)) {
        if (!Array.isArray(records)) continue;
        const name = key.split('@')[0];
        for (const rec of records) {
            const dir = rec && rec.installPath;
            if (!dir || seen.has(dir)) continue;
            seen.add(dir);
            out.push([dir, name]);
        }
    }
    return out;
}

function collectHome(map) {
    collectDir(map, path.join(HOME, '.claude'), '');
}

function collectProject(map, cwd) {
    if (!cwd) return;
    collectDir(map, path.join(cwd, '.claude'), '');
}

/**
 * Read `<root>/commands/**\/*.md` and `<root>/skills/*\/SKILL.md` into `map`.
 *
 * A nested command file is namespaced by its directories — `commands/a/b.md` is
 * `/a:b` — which is the same colon the plugin prefix uses, so both fall out of
 * one join.
 */
function collectDir(map, root, prefix) {
    const ns = prefix ? `${prefix}:` : '';

    walk(path.join(root, 'commands'), 4, (file, rel) => {
        if (!file.endsWith('.md')) return;
        const name = ns + rel.slice(0, -3).split(path.sep).join(':');
        const doc = readDoc(file);
        if (doc) map.set(name, doc);
    });

    // A skill is invocable as /<name> too, and carries the same two keys.
    walk(path.join(root, 'skills'), 2, (file, rel) => {
        if (path.basename(file) !== 'SKILL.md') return;
        const dir = path.dirname(rel);
        if (dir === '.') return;
        const name = ns + dir.split(path.sep).join(':');
        const doc = readDoc(file);
        if (doc) map.set(name, doc);
    });
}

/** Depth-limited directory walk that never throws. */
function walk(dir, depth, onFile, base = dir) {
    if (depth < 0) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full, depth - 1, onFile, base);
        else if (item.isFile()) onFile(full, path.relative(base, full));
    }
}

// Frontmatter is two string fields here, so it gets two lines of parser rather
// than a YAML dependency. Anything it cannot read is simply a command without a
// description, which the menu already handles.
const FM_KEYS = { description: 'description', 'argument-hint': 'argumentHint' };

function readDoc(file) {
    let head;
    try {
        // Frontmatter is at the top; a command body can be long and none of it
        // is wanted.
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        head = buf.slice(0, n).toString('utf8');
    } catch { return null; }

    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (!m) return null;

    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = FM_KEYS[kv[1]];
        if (!key) continue;
        out[key] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
    }
    return (out.description || out.argumentHint) ? out : null;
}

module.exports = { CommandCache, CACHE_FILE };
