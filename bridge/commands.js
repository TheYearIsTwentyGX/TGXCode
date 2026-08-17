'use strict';

// What a project says its commands are.
//
// Every project has two or three things you run constantly — `npm run dev`
// above all — and until now the only way to run one from this app was to open
// the terminal pane and type it. A project declares them in `.tgxcode/` instead
// and the app draws a button per command. bridge/runs.js runs them.
//
// This is the first time the bridge reads a file out of a project directory. It
// is also the first time it runs a command string that somebody other than the
// person clicking may have written — a `git pull` can change what a familiar
// button does. The decision is to trust the file the way `package.json` scripts
// and a Makefile are already trusted on this machine, and to make it visible
// instead: the resolved command travels with every command in the payload so
// the UI can put it on the button, and nothing here ever starts anything on its
// own. What is *not* negotiable is cfg.withinRoots — without it a `cwd=` query
// parameter is a file-read primitive.
//
// Where the files are read from is asymmetric, and that is the interesting part.
// A worktree is a checkout of the same repo, so it has its own commands.json —
// possibly a branch's newer version, which should work. It never has the
// gitignored local file, because that file was never committed. So the shared
// file comes from the directory you are running in and the personal one comes
// from the main checkout, and your overrides follow you into every worktree.

const fs = require('fs');
const path = require('path');
// Synchronous on purpose: both calls are `git` answering about a directory it
// has already indexed, they are cached for ten seconds, and load() is on the
// path of a route that has to return a whole answer anyway.
const { execFileSync } = require('child_process');

const cfg = require('./config');
const { projectRootOf, worktreeNameOf } = require('./transcript');

// A config file is a handful of commands. Anything approaching this is either a
// mistake or an attempt to make the bridge do unbounded work parsing it.
const MAX_FILE_BYTES = 64 * 1024;
const MAX_COMMANDS = 24;
const MAX_RUN_CHARS = 2000;
const MAX_ENV_KEYS = 32;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const PLACEHOLDER_RE = /\$\{([a-z]+)\}/g;
const KNOWN = new Set(['port', 'cwd', 'project', 'worktree', 'branch']);

// Re-stat rather than watch: one inotify watcher per project for a file that
// changes monthly is a poor trade, and 2s is short enough that editing the file
// and clicking feels immediate.
const CACHE_MS = 2000;
const BRANCH_CACHE_MS = 10_000;

const cache = new Map();          // workspace -> {at, value}
const branchCache = new Map();    // dir -> {at, value}
const ignoreCache = new Map();    // file -> {at, value}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read one config file.
 *
 * Stat before read, in the shape of persistedOutput() in sessions.js: a file of
 * unknown size never goes into memory whole.
 *
 * @returns {{data: object|null, stamp: string|null, problem: object|null}}
 */
function readConfig(file) {
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
    // Tolerate a BOM the same way flags.js does: this is a file people edit.
    try { data = JSON.parse(raw.replace(/^﻿/, '')); }
    catch (err) { return { data: null, stamp, problem: { file, message: err.message } }; }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { data: null, stamp, problem: { file, message: 'not a JSON object' } };
    }
    if (data.version !== 1) {
        return { data: null, stamp,
            problem: { file, message: `unknown version ${JSON.stringify(data.version)} — expected 1` } };
    }
    if (!Array.isArray(data.commands)) {
        return { data: null, stamp, problem: { file, message: '"commands" is not an array' } };
    }
    return { data, stamp, problem: null };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check one declared entry.
 *
 * A bad entry is dropped and reported; its siblings survive. One malformed
 * command hiding every working button would be the wrong trade — you would
 * lose the buttons and not know why.
 *
 * `override` is for an id that an earlier file already defined. The point of the
 * local file is to change one thing about a command without restating it, so an
 * override supplies only what it changes; a first definition has to be whole.
 *
 * Placeholders are deliberately *not* checked here. Whether `${port}` is legal
 * depends on the port block, and a local file may add one to a command declared
 * without it — so that check runs once over the merged result instead.
 *
 * @returns {{command: object|null, problem: object|null}}
 */
function validate(raw, file, override = false) {
    const bad = (message) => ({ command: null,
        problem: { file, id: raw && raw.id, message } });

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('not an object');
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
        return bad('id must be lower-case letters, digits, dot, dash or underscore');
    }

    const out = { id: raw.id };

    if (raw.label !== undefined || !override) {
        if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 40) {
            return bad('label must be 1-40 characters');
        }
        // A label goes on a button; an escape sequence in one is either a
        // mistake or an attempt to make the button lie about what it is.
        if (/[\u0000-\u001f\u007f]/.test(raw.label)) return bad('label contains a control character');
        out.label = raw.label.trim();
    }

    if (raw.run !== undefined || !override) {
        if (typeof raw.run !== 'string' || !raw.run.trim()) return bad('run must be a non-empty string');
        if (raw.run.length > MAX_RUN_CHARS) return bad(`run is longer than ${MAX_RUN_CHARS} characters`);
        // A NUL truncates the line at the exec, so it cannot be quoted safely
        // — see shq() in terminal.js.
        if (raw.run.includes('\0')) return bad('run contains a NUL byte');
        out.run = raw.run;
    }

    if (raw.cwd !== undefined) {
        if (typeof raw.cwd !== 'string' || path.isAbsolute(raw.cwd)) {
            return bad('cwd must be a relative path');
        }
        out.cwd = raw.cwd;
    }

    if (raw.env !== undefined) {
        if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) {
            return bad('env must be an object');
        }
        const keys = Object.keys(raw.env);
        if (keys.length > MAX_ENV_KEYS) return bad(`env has more than ${MAX_ENV_KEYS} keys`);
        for (const k of keys) {
            if (!ENV_KEY_RE.test(k)) return bad(`env name ${JSON.stringify(k)} is not a shell variable name`);
            if (typeof raw.env[k] !== 'string') return bad(`env.${k} must be a string`);
        }
        out.env = { ...raw.env };
    }

    if (raw.port !== undefined) {
        const p = raw.port;
        if (!p || typeof p !== 'object' || !Array.isArray(p.range) || p.range.length !== 2) {
            return bad('port.range must be [low, high]');
        }
        const [lo, hi] = p.range.map(Number);
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1024 || hi > 65535 || lo > hi) {
            return bad('port.range must be two integers between 1024 and 65535, low first');
        }
        if (hi - lo > 1000) return bad('port.range spans more than 1000 ports');
        if (p.env !== undefined && (typeof p.env !== 'string' || !ENV_KEY_RE.test(p.env))) {
            return bad('port.env is not a shell variable name');
        }
        out.port = { range: [lo, hi] };
        if (p.env) out.port.env = p.env;
    }

    if (raw.devbrowser !== undefined) {
        if (typeof raw.devbrowser !== 'string') return bad('devbrowser must be a string');
        out.devbrowser = raw.devbrowser;
    }

    if (raw.disabled !== undefined) {
        if (typeof raw.disabled !== 'boolean') return bad('disabled must be true or false');
        out.disabled = raw.disabled;
    }

    return { command: out, problem: null };
}

/**
 * Every placeholder in a merged command, checked against what it can mean.
 *
 * A typo shown next to the command beats an empty string in a command line
 * nobody reads before clicking.
 */
function checkPlaceholders(command) {
    const fields = [['run', command.run], ['cwd', command.cwd], ['devbrowser', command.devbrowser]];
    for (const [k, v] of Object.entries(command.env || {})) fields.push([`env.${k}`, v]);
    for (const [field, text] of fields) {
        if (typeof text !== 'string') continue;
        for (const m of text.matchAll(PLACEHOLDER_RE)) {
            if (!KNOWN.has(m[1])) {
                return `${field} uses unknown placeholder \${${m[1]}} — known: ${[...KNOWN].join(', ')}`;
            }
            if (m[1] === 'port' && !command.port) {
                return `${field} uses \${port} but the command declares no port range`;
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Fold one file's commands into the accumulator.
 *
 * By id, shallow per key, except `env` which merges key by key — so a local file
 * can add DEBUG=1 without restating everything — and `port`, which replaces
 * wholesale, because half a port block is not a thing.
 */
function merge(into, commands, file, problems) {
    const seenHere = new Set();
    for (const raw of commands) {
        const id = raw && raw.id;
        const { command, problem } = validate(raw, file, into.has(id));
        if (problem) { problems.push(problem); continue; }
        if (seenHere.has(command.id)) {
            problems.push({ file, id: command.id, message: 'declared twice in this file' });
            continue;
        }
        seenHere.add(command.id);

        const prev = into.get(command.id);
        if (!prev) { into.set(command.id, { ...command, from: file }); continue; }
        const env = (prev.env || command.env) ? { ...prev.env, ...command.env } : undefined;
        const next = { ...prev, ...command, from: file };
        if (env) next.env = env; else delete next.env;
        into.set(command.id, next);
    }
}

/** Drop merged commands whose placeholders do not add up, and say why. */
function checkMerged(merged, problems) {
    for (const [id, command] of [...merged]) {
        const err = checkPlaceholders(command);
        if (err) { merged.delete(id); problems.push({ file: command.from, id, message: err }); }
    }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

function cached(map, key, ttl, compute) {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = compute();
    map.set(key, { at: Date.now(), value });
    return value;
}

/** Current branch, or null. Cheap enough to shell out for, cached anyway. */
function branchOf(dir) {
    return cached(branchCache, dir, BRANCH_CACHE_MS, () => {
        try {
            const out = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'],
                { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
            const name = String(out).trim();
            return name && name !== 'HEAD' ? name : null;
        } catch { return null; }
    });
}

/**
 * Is the local file actually gitignored?
 *
 * The only thing making commands.local.json personal is a line in .gitignore. If
 * a project forgets it, a private override becomes a committed one and nobody
 * finds out until it is in someone else's checkout. The app is in a position to
 * notice, so it does.
 */
function ignored(dir, relative) {
    const key = path.join(dir, relative);
    return cached(ignoreCache, key, BRANCH_CACHE_MS, () => {
        try {
            execFileSync('git', ['-C', dir, 'check-ignore', '-q', '--', relative],
                { timeout: 3000, stdio: 'ignore' });
            return true;
        } catch { return false; }
    });
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Fill in the placeholders.
 *
 * `port` is left alone when it is not known yet — the UI wants to show the
 * command before there is one, and showing `${port}` there is more honest than
 * showing a port that will not be the one used.
 */
function expand(text, context) {
    if (typeof text !== 'string') return text;
    return text.replace(PLACEHOLDER_RE, (whole, name) => {
        if (name === 'port') return context.port == null ? whole : String(context.port);
        const v = context[name];
        return v == null ? '' : String(v);
    });
}

/** Everything a command needs resolved, ready to hand to runs.js. */
function resolve(command, context) {
    const env = {};
    for (const [k, v] of Object.entries(command.env || {})) env[k] = expand(v, context);
    if (command.port && command.port.env && context.port != null) {
        env[command.port.env] = String(context.port);
    }
    const rel = expand(command.cwd || '.', context);
    const cwd = path.resolve(context.cwd, rel);
    return { run: expand(command.run, context), cwd, env };
}

/** The DevBrowser name for a run, or null if the command did not ask for one. */
function devbrowserTitle(command, context) {
    if (command.devbrowser === undefined) return null;
    const asked = expand(command.devbrowser, context).trim();
    // 13-C: worktree, then branch, then project. A name that leads with the
    // project repeats on every tab and pushes what identifies the server out of
    // a narrow rail.
    return asked || context.worktree || context.branch || context.project || null;
}

// ---------------------------------------------------------------------------
// The public read
// ---------------------------------------------------------------------------

/**
 * Read and merge every file that applies to a workspace.
 *
 * Kept separate from load() so that starting a command and listing them use the
 * same precedence — an earlier draft of this file listed the files twice, in two
 * different orders, and the local overrides silently lost.
 *
 * @returns {object|null} null if the directory is outside the allowed roots
 */
function readMerged(dir) {
    if (!dir || !cfg.withinRoots(dir)) return null;
    const workspace = path.resolve(cfg.expandHome(dir));
    const project = projectRootOf(workspace);

    const files = [
        // The workspace's own checked-in file, falling back to the project's
        // only if it has none — a worktree branched before the file existed
        // should not lose its buttons.
        { file: path.join(workspace, cfg.TGX_DIR, cfg.COMMANDS_FILE), fallback:
            path.join(project, cfg.TGX_DIR, cfg.COMMANDS_FILE) },
        // Your overrides live in the main checkout and follow you into every
        // worktree of it, which is the whole point of them.
        { file: path.join(project, cfg.TGX_DIR, cfg.COMMANDS_LOCAL_FILE), local: true },
        // …unless somebody deliberately put one in the worktree.
        { file: path.join(workspace, cfg.TGX_DIR, cfg.COMMANDS_LOCAL_FILE), local: true },
    ];

    const reads = [];
    for (const spec of files) {
        let read = readConfig(spec.file);
        let file = spec.file;
        if (!read.data && !read.problem && spec.fallback && spec.fallback !== spec.file) {
            file = spec.fallback;
            read = readConfig(file);
        }
        reads.push({ ...spec, file, read });
    }

    const stamp = reads.map(r => `${r.file}@${r.read.stamp || '-'}`).join('|');
    const problems = [];
    const merged = new Map();
    // Deduplicate: in the main checkout the project and workspace local files
    // are the same path, and reading it twice would double every problem.
    const seenFiles = new Set();
    for (const { file, read, local } of reads) {
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);
        if (read.problem) { problems.push(read.problem); continue; }
        if (!read.data) continue;
        if (local && !ignored(path.dirname(path.dirname(file)), path.join(cfg.TGX_DIR, cfg.COMMANDS_LOCAL_FILE))) {
            problems.push({ file, message:
                'not gitignored — your local overrides would be committed. Add '
                + `${cfg.TGX_DIR}/${cfg.COMMANDS_LOCAL_FILE} to .gitignore.` });
        }
        merge(merged, read.data.commands, file, problems);
    }

    checkMerged(merged, problems);

    const worktree = worktreeNameOf(workspace);
    const context = {
        cwd: workspace,
        project: path.basename(project),
        worktree: worktree || '',
        branch: branchOf(workspace) || '',
        port: null,
    };

    const hidden = [...merged.values()].filter(c => c.disabled).length;
    if (hidden) {
        problems.push({ informational: true,
            message: `${hidden} command${hidden > 1 ? 's' : ''} hidden by a local file` });
    }
    if (merged.size > MAX_COMMANDS) {
        problems.push({ message: `more than ${MAX_COMMANDS} commands declared — the rest are ignored` });
    }

    return { workspace, project, context, merged, problems, stamp, worktree };
}

/**
 * What `dir` declares, as the API serves it.
 *
 * @param {string} dir a workspace: a checkout, or a worktree of one
 * @returns {object|null} null if the directory is outside the allowed roots
 */
function load(dir) {
    const read = readMerged(dir);
    if (!read) return null;
    const { workspace, project, context, merged, problems, stamp, worktree } = read;

    const hit = cache.get(workspace);
    if (hit && hit.stamp === stamp && Date.now() - hit.at < CACHE_MS) return hit.value;

    const commands = [...merged.values()]
        .filter(c => !c.disabled)
        .slice(0, MAX_COMMANDS)
        .map((c) => {
            const r = resolve(c, context);
            return {
                id: c.id,
                label: c.label,
                // What the button's tooltip shows. `${port}` is still in it when
                // the command declares a range, because that is the truth until
                // one has been allocated — a number here would be a number
                // that turns out not to be the one used.
                command: r.run,
                cwd: r.cwd,
                port: c.port || null,
                devbrowser: devbrowserTitle(c, context),
                from: c.from,
            };
        });

    const value = {
        workspace,
        project,
        projectName: context.project,
        worktree: worktree || null,
        branch: context.branch || null,
        commands,
        problems,
    };
    cache.set(workspace, { at: Date.now(), stamp, value });
    return value;
}

/**
 * One command, resolved against a port and ready for runs.js.
 *
 * Re-read rather than taken from load()'s payload, because that payload
 * deliberately still has `${port}` in it.
 *
 * @returns {object|null} null if the directory or the id is unknown; an object
 *   carrying `error` if the command resolves somewhere it may not run
 */
function prepare(dir, id, port) {
    const read = readMerged(dir);
    if (!read) return null;
    const raw = read.merged.get(id);
    if (!raw || raw.disabled) return null;

    const context = { ...read.context, port: port == null ? null : port };
    const r = resolve(raw, context);

    // A relative cwd that climbs out of the workspace is a typo with
    // consequences — a build run in somebody else's tree.
    if (r.cwd !== read.workspace && !r.cwd.startsWith(read.workspace + path.sep)) {
        return { error: `cwd ${JSON.stringify(raw.cwd)} resolves outside the workspace` };
    }
    if (!cfg.withinRoots(r.cwd)) return { error: 'cwd is outside the allowed roots' };

    return {
        id: raw.id,
        label: raw.label,
        run: r.run,
        cwd: r.cwd,
        env: r.env,
        port: raw.port || null,
        devbrowser: devbrowserTitle(raw, context),
        workspace: read.workspace,
    };
}

module.exports = { load, prepare, expand, resolve, devbrowserTitle, MAX_COMMANDS };
