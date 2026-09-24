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
const jsonfile = require('./jsonfile');
const { projectRootOf, worktreeNameOf } = require('./transcript');

// A config file is a handful of commands. Anything approaching this is either a
// mistake or an attempt to make the bridge do unbounded work parsing it.
const MAX_FILE_BYTES = 64 * 1024;
const MAX_COMMANDS = 24;
const MAX_RUN_CHARS = 2000;
const MAX_ENV_KEYS = 32;
const MAX_LABEL_CHARS = 40;

// The two files an editor may write, named the way the rest of the app names
// this distinction. `bridge/prefs.js` and `bridge/claude-config.js` both say
// project / project-local for exactly this shared-versus-private-local pair,
// and docs/api.md documents it that way twice — a third word for one idea is
// how a client ends up guessing. The tabs say "Shared" and "Local" on screen,
// where the file names are what the reader has in mind.
const SCOPES = ['project', 'project-local'];

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
 * The stat-before-read, the size cap, the BOM and the parse all come from
 * bridge/jsonfile.js — this function predated that module and was the third
 * copy of them. What stays here is the part that is not shared: the `version`
 * and `commands` rules, which belong to this format and to nothing else.
 *
 * `text` rides along because a file that will not parse is exactly the file
 * somebody has to look at, and an editor cannot show it without the bytes. The
 * old version read them and threw them away, so repairing a broken file meant
 * leaving the app for a text editor.
 *
 * @returns {{data: object|null, text: string|null, stamp: string|null,
 *   size: number, problem: {file: string, message: string}|null}}
 */
function readConfig(file) {
    const got = jsonfile.readJson(file, { maxBytes: MAX_FILE_BYTES });
    const base = { data: null, text: got.text, stamp: got.stamp, size: got.size };
    if (got.problem) return { ...base, problem: got.problem };
    if (!got.data) return { ...base, problem: null };

    if (got.data.version !== 1) {
        return { ...base,
            problem: { file, message: `unknown version ${JSON.stringify(got.data.version)} — expected 1` } };
    }
    if (!Array.isArray(got.data.commands)) {
        return { ...base, problem: { file, message: '"commands" is not an array' } };
    }
    return { ...base, data: got.data, problem: null };
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
    // `field` is what lets a form put the message on the input that is wrong
    // rather than at the top of the card. Omitted where the complaint is about
    // the entry as a whole; the read path ignores the key either way.
    const bad = (message, field) => ({ command: null,
        problem: { file, id: raw && raw.id, message, ...(field ? { field } : {}) } });

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('not an object');
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
        return bad('id must be lower-case letters, digits, dot, dash or underscore', 'id');
    }

    const out = { id: raw.id };

    if (raw.label !== undefined || !override) {
        if (typeof raw.label !== 'string' || !raw.label.trim()
            || raw.label.length > MAX_LABEL_CHARS) {
            return bad(`label must be 1-${MAX_LABEL_CHARS} characters`, 'label');
        }
        // A label goes on a button; an escape sequence in one is either a
        // mistake or an attempt to make the button lie about what it is.
        if (/[\u0000-\u001f\u007f]/.test(raw.label)) return bad('label contains a control character', 'label');
        out.label = raw.label.trim();
    }

    if (raw.run !== undefined || !override) {
        if (typeof raw.run !== 'string' || !raw.run.trim()) return bad('run must be a non-empty string', 'run');
        if (raw.run.length > MAX_RUN_CHARS) return bad(`run is longer than ${MAX_RUN_CHARS} characters`, 'run');
        // A NUL truncates the line at the exec, so it cannot be quoted safely
        // — see shq() in terminal.js.
        if (raw.run.includes('\0')) return bad('run contains a NUL byte', 'run');
        out.run = raw.run;
    }

    if (raw.cwd !== undefined) {
        if (typeof raw.cwd !== 'string' || path.isAbsolute(raw.cwd)) {
            return bad('cwd must be a relative path', 'cwd');
        }
        out.cwd = raw.cwd;
    }

    if (raw.env !== undefined) {
        if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) {
            return bad('env must be an object', 'env');
        }
        const keys = Object.keys(raw.env);
        if (keys.length > MAX_ENV_KEYS) return bad(`env has more than ${MAX_ENV_KEYS} keys`, 'env');
        for (const k of keys) {
            if (!ENV_KEY_RE.test(k)) return bad(`env name ${JSON.stringify(k)} is not a shell variable name`, 'env');
            if (typeof raw.env[k] !== 'string') return bad(`env.${k} must be a string`, 'env');
        }
        out.env = { ...raw.env };
    }

    if (raw.port !== undefined) {
        const p = raw.port;
        if (!p || typeof p !== 'object' || !Array.isArray(p.range) || p.range.length !== 2) {
            return bad('port.range must be [low, high]', 'port');
        }
        const [lo, hi] = p.range.map(Number);
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1024 || hi > 65535 || lo > hi) {
            return bad('port.range must be two integers between 1024 and 65535, low first', 'port');
        }
        if (hi - lo > 1000) return bad('port.range spans more than 1000 ports', 'port');
        if (p.env !== undefined && (typeof p.env !== 'string' || !ENV_KEY_RE.test(p.env))) {
            return bad('port.env is not a shell variable name', 'port');
        }
        out.port = { range: [lo, hi] };
        if (p.env) out.port.env = p.env;
    }

    if (raw.devbrowser !== undefined) {
        if (typeof raw.devbrowser !== 'string') return bad('devbrowser must be a string', 'devbrowser');
        out.devbrowser = raw.devbrowser;
    }

    // Only means something beside a port, but a local file may add the port to
    // a command the shared file declares without one, so that is not checked here.
    if (raw.web !== undefined) {
        if (typeof raw.web !== 'boolean') return bad('web must be true or false', 'web');
        out.web = raw.web;
    }

    if (raw.disabled !== undefined) {
        if (typeof raw.disabled !== 'boolean') return bad('disabled must be true or false', 'disabled');
        out.disabled = raw.disabled;
    }

    return { command: out, problem: null };
}

/**
 * Every placeholder in a merged command, checked against what it can mean.
 *
 * A typo shown next to the command beats an empty string in a command line
 * nobody reads before clicking.
 *
 * Returns `{field, message}` rather than a bare string so the editor can put
 * the complaint on the input that carries the placeholder. `field` is the key
 * as a form knows it — `env.FOO` collapses to the env block, which is the only
 * control there is for it.
 *
 * @returns {{field: string, message: string}|null}
 */
function checkPlaceholders(command) {
    const fields = [['run', command.run], ['cwd', command.cwd], ['devbrowser', command.devbrowser]];
    for (const [k, v] of Object.entries(command.env || {})) fields.push([`env.${k}`, v]);
    for (const [field, text] of fields) {
        if (typeof text !== 'string') continue;
        for (const m of text.matchAll(PLACEHOLDER_RE)) {
            if (!KNOWN.has(m[1])) {
                return { field,
                    message: `${field} uses unknown placeholder \${${m[1]}} — known: ${[...KNOWN].join(', ')}` };
            }
            if (m[1] === 'port' && !command.port) {
                return { field,
                    message: `${field} uses \${port} but the command declares no port range` };
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
        if (err) {
            merged.delete(id);
            problems.push({ file: command.from, id, field: err.field, message: err.message });
        }
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
                web: c.web === true && !!c.port,
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

// ---------------------------------------------------------------------------
// The editor's read
// ---------------------------------------------------------------------------

/**
 * The one place a scope becomes a path.
 *
 * Both files sit at the *project* root, never a worktree's. A worktree has its
 * own checked-in copy — 66 of them do in this repository — and editing one from
 * a settings page would write into a directory a branch merge is about to
 * overwrite. The local file has never lived anywhere but the main checkout, by
 * design: that is what makes an override follow you into every worktree.
 *
 * @returns {string|null} null for a scope that is not one of ours
 */
function fileFor(scope, project) {
    if (scope === 'project') return path.join(project, cfg.TGX_DIR, cfg.COMMANDS_FILE);
    if (scope === 'project-local') return path.join(project, cfg.TGX_DIR, cfg.COMMANDS_LOCAL_FILE);
    return null;
}

/**
 * What each file *says*, as against what the chain adds up to.
 *
 * This is the seed for an editor, and it is deliberately not load(): that
 * answers "what is in force", with every placeholder expanded and both files
 * folded into one list. A control seeded from it would write the merged value
 * back into whichever file you happened to be editing — which is how a page
 * meaning to add one local override writes a copy of every shared command into
 * a personal file. bridge/claude-config.js hit that exact bug twice and
 * docs/plans/20-claude-config.md records both.
 *
 * `commands` is therefore raw: the entries as written, unvalidated, in file
 * order. A file being edited is a file that may not currently be valid, and the
 * editor is the thing that fixes it — validating on the way out would hide the
 * entry somebody is trying to repair.
 *
 * `merged` comes from readMerged() rather than being computed here, so the
 * precedence an editor shows is the precedence a click obeys. With `dir` at the
 * project root the two file lists are the same two paths; the worktree fallback
 * in readMerged() simply has nothing to fall back to.
 *
 * @param {string} dir any directory in the project; the project root is used
 * @returns {object|null} null if the directory is outside the allowed roots
 */
function raw(dir) {
    if (!dir || !cfg.withinRoots(dir)) return null;
    const workspace = path.resolve(cfg.expandHome(dir));
    const project = projectRootOf(workspace);
    const read = readMerged(project);
    if (!read) return null;

    const files = SCOPES.map((scope) => {
        const file = fileFor(scope, project);
        const got = readConfig(file);
        // Checked on the link rather than followed — statSync follows, and
        // following is the bug. A page that drew a writable box over a symlink
        // would be promising something the write refuses.
        const symlink = escapesProject(file, project);
        return {
            scope,
            file,
            exists: got.stamp !== null,
            // Exists and could not be understood. The JSON tab is the only
            // thing in the app that can repair one, so this is the flag that
            // sends a reader there rather than an error that stops them.
            parsed: got.data !== null,
            stamp: got.stamp,
            size: got.size,
            writable: !symlink && jsonfile.writable(file),
            symlink,
            // Only the local row: the shared file is meant to be committed, so
            // "not excluded" is not a finding about it. The route enriches this
            // with the rule that matched; here it is the cheap synchronous copy
            // load() already relies on.
            ignored: scope === 'project-local'
                ? ignored(project, path.join(cfg.TGX_DIR, cfg.COMMANDS_LOCAL_FILE))
                : null,
            commands: got.data ? got.data.commands : [],
            text: got.text,
            problem: got.problem,
        };
    });

    return {
        project,
        projectName: path.basename(project),
        // What ${…} expands to at the project root, so an editor can show a
        // resolved preview beside the template. A worktree session's own values
        // differ, which is the whole of the note the page carries.
        context: read.context,
        // Merged and validated, for the local tab's inherited placeholders.
        merged: [...read.merged.values()],
        problems: read.problems,
        files,
        // The caps and the patterns ride along so a form can label its own
        // counters and refuse a bad id before the round trip, without a second
        // copy of this module's constants going stale in web/app.js. It is the
        // argument GET /api/claude-docs already makes for shipping `maxBytes`:
        // a hardcoded number goes on being displayed long after the real one
        // moved, and that drift is only ever found by somebody hitting it.
        limits: {
            maxCommands: MAX_COMMANDS,
            maxFileBytes: MAX_FILE_BYTES,
            maxRunChars: MAX_RUN_CHARS,
            maxEnvKeys: MAX_ENV_KEYS,
            maxLabelChars: MAX_LABEL_CHARS,
        },
        placeholders: [...KNOWN],
        patterns: { id: ID_RE.source, envKey: ENV_KEY_RE.source },
    };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
//
// The read above has been here since plan 17; this half arrived with the
// settings panel that edits these files. It lives in the same module rather
// than a new one because what would have to be duplicated is the format: the
// id pattern, every field rule, the caps, the two filenames and the precedence
// between them. bridge/claude-config.js was split out of bridge/prefs.js for
// three reasons and none of them holds here — that format belonged to somebody
// else, and this one is ours.
//
// Two rules, and they are opposites on purpose. A file is hand-edited, so the
// reader drops one bad command and keeps its siblings. A page is a client, so
// the writer validates the whole document and refuses all of it — a control
// left showing a value that was silently discarded is worse than a refusal.
// The same reasoning is written out in docs/plans/19-settings.md.

/**
 * Is this a way out of the project — the file, or the directory holding it?
 *
 * Two corrections to the obvious call, and both were found by trying it.
 *
 * **Contained against the project root, not `<project>/.tgxcode`.** If that
 * directory is itself a symlink then `commands.json` inside it is a perfectly
 * ordinary file — `lstat` on it says so — and its realpath sits happily inside
 * the realpath of `<project>/.tgxcode`, because that *is* the link's target.
 * Rooted one level up, the same write is refused.
 *
 * **And the directory is checked as well as the file**, because
 * `jsonfile.escapes` answers about a path that exists: `lstat` throws for a
 * missing one and "absent" is correctly not an escape. But missing is the
 * normal case here — the first save to a project creates both the file and
 * `.tgxcode` — so the file-only check is blind in exactly the situation the
 * guard is for.
 */
function escapesProject(file, project) {
    return jsonfile.escapes(file, project) || jsonfile.escapes(path.dirname(file), project);
}

/**
 * Write, or refuse with a sentence somebody can act on.
 *
 * The case worth catching is a `.tgxcode` that is a regular file, which
 * `mkdirSync(..., {recursive: true})` reports as `EEXIST: file already exists,
 * mkdir '<path>'` — a message naming neither what is wrong nor what to do. The
 * condition is tested rather than the error code matched, because the code for
 * it is EEXIST here and ENOTDIR elsewhere and neither is worth relying on.
 */
function writeThrough(file, text) {
    try {
        jsonfile.writeAtomic(file, text);
    } catch (err) {
        const dir = path.dirname(file);
        let blocked = false;
        try { blocked = !fs.lstatSync(dir).isDirectory(); } catch { /* absent, so not this */ }
        throw jsonfile.refuse('write', blocked
            ? `${dir} is a file, not a directory — ${path.basename(file)} cannot be written into it`
            : `${file}: ${err.message}`);
    }
}

/**
 * The scope checks a write shares, and the file it settles on.
 *
 * @returns {{scope: string, project: string, file: string}}
 */
function writeTarget(scope, dir) {
    if (!SCOPES.includes(scope)) {
        throw jsonfile.refuse('scope', `${JSON.stringify(scope)} is not a command scope`);
    }
    if (!dir) throw jsonfile.refuse('dir', `scope ${scope} needs a directory`);
    if (!cfg.withinRoots(dir)) {
        throw jsonfile.refuse('dir', `${dir} is not a directory this bridge will write`);
    }
    const project = projectRootOf(path.resolve(cfg.expandHome(dir)));
    const file = fileFor(scope, project);
    if (escapesProject(file, project)) {
        throw jsonfile.refuse('readonly', `${file} is a symlink — refusing to write through it`);
    }
    if (!jsonfile.writable(file)) throw jsonfile.refuse('write', `${file} cannot be written`);
    return { scope, project, file };
}

/**
 * Is the file still the one the caller read?
 *
 * Every write here replaces the whole `commands` array, so — unlike
 * bridge/claude-config.js, where a single scalar patch can re-read immediately
 * before writing — there is no write that can do without the precondition.
 * `undefined` is therefore a refusal rather than a permission. `null` is the
 * caller saying "this file should not exist yet", which is how a page that has
 * never seen one asks to create it.
 */
function checkStamp(file, sent, current) {
    if (sent === undefined) {
        throw jsonfile.refuse('stamp',
            'this replaces the whole file, so it needs the stamp it was read with');
    }
    if (sent === null && current !== null) {
        const err = jsonfile.refuse('exists', `${file} exists now — it did not when this page loaded`);
        err.detail = { stamp: current };
        throw err;
    }
    if (sent !== null && sent !== current) {
        const err = jsonfile.refuse('stale', current === null
            ? `${file} has been deleted since this page loaded`
            : `${file} has changed since this page loaded`);
        // What is on disk now, so the page can show what it declined to
        // overwrite rather than only reporting that it declined.
        const got = readConfig(file);
        err.detail = { stamp: current, text: got.text, commands: got.data ? got.data.commands : null };
        throw err;
    }
}

/**
 * Forget what the read path remembers about a project.
 *
 * `load()` recomputes its composite stamp on every call, so it would notice on
 * its own. The other two would not: `ignoreCache` holds "is the local file
 * excluded?" for ten seconds, and a page that has just been told to add the
 * line and has done so should not go on being told for another ten.
 */
function clearCaches(project) {
    cache.delete(project);
    for (const key of [...ignoreCache.keys()]) {
        if (key.startsWith(project)) ignoreCache.delete(key);
    }
    branchCache.delete(project);
}

/**
 * Check a whole document, and say everything that is wrong with it.
 *
 * Every problem rather than the first: a form that surfaces one error per round
 * trip makes six saves out of one paste. `index` is what pins a message to a
 * row — an entry with a malformed id has no usable id, and a duplicate id names
 * two rows, so neither can be the key.
 *
 * Placeholders are checked against the **merged** command, not this file's
 * half, because that is the rule the reader applies: a shared `${port}` whose
 * range the local file supplies is legal, and refusing it here would refuse
 * something a click would honour.
 *
 * @returns {Array<{index: number, id: string|undefined, field?: string, message: string}>}
 */
function checkDocument(entries, { scope, project, file }) {
    const problems = [];
    if (!Array.isArray(entries)) {
        return [{ index: -1, message: 'commands must be an array' }];
    }
    if (entries.length > MAX_COMMANDS) {
        problems.push({ index: -1,
            message: `${entries.length} commands — ${MAX_COMMANDS} is as many as one file may declare` });
    }

    // What the *other* file says, so an entry that only overrides is judged the
    // way the reader will judge it. Read rather than passed in: a save happens
    // long after the page loaded, and the sibling may have moved.
    const otherScope = scope === 'project' ? 'project-local' : 'project';
    const other = readConfig(fileFor(otherScope, project));
    const otherById = new Map();
    for (const raw of (other.data ? other.data.commands : [])) {
        if (raw && typeof raw.id === 'string') otherById.set(raw.id, raw);
    }

    const seen = new Set();
    entries.forEach((raw, index) => {
        // Only the *local* file may leave out label and run, and only for an id
        // the shared file already declares. Everything else is a first
        // definition and has to be whole.
        const isOverride = scope === 'project-local' && otherById.has(raw && raw.id);
        const { command, problem } = validate(raw, file, isOverride);
        if (problem) {
            problems.push({ index, id: problem.id, field: problem.field, message: problem.message });
            return;
        }
        if (seen.has(command.id)) {
            problems.push({ index, id: command.id, field: 'id', message: 'declared twice in this file' });
            return;
        }
        seen.add(command.id);

        // The merged reading, in the same shape merge() builds it.
        const prev = isOverride ? validate(otherById.get(command.id), file).command : null;
        let merged = command;
        if (prev) {
            const env = (prev.env || command.env) ? { ...prev.env, ...command.env } : undefined;
            merged = { ...prev, ...command };
            if (env) merged.env = env; else delete merged.env;
        }
        const err = checkPlaceholders(merged);
        if (err) problems.push({ index, id: command.id, field: err.field, message: err.message });
    });
    return problems;
}

/**
 * Replace one file's `commands` array.
 *
 * The entries are written **as given**, not as `validate()` cleans them.
 * `validate()` builds a fresh object and drops every key it does not know, so
 * saving its output would silently delete a field somebody added by hand — the
 * editor would quietly narrow the file every time it round-tripped. Validation
 * is a gate here, not a transform.
 */
function saveDoc({ scope, dir, stamp, commands }) {
    const target = writeTarget(scope, dir);
    if (!Array.isArray(commands)) throw jsonfile.refuse('body', 'commands must be an array');

    const problems = checkDocument(commands, target);
    if (problems.length) {
        const err = jsonfile.refuse('invalid', problems.length === 1
            ? problems[0].message
            : `${problems.length} problems with those commands`);
        err.detail = { problems };
        throw err;
    }

    const text = jsonfile.serialize({ version: 1, commands });
    // Every field is capped, but `validate()` ignores keys it does not know —
    // so a megabyte parked under one of them would pass the schema and make a
    // file the reader then refuses to open.
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
        throw jsonfile.refuse('size',
            `that is ${bytes} bytes, and ${MAX_FILE_BYTES} is as large as one of these gets`);
    }

    checkStamp(target.file, stamp, jsonfile.stampNow(target.file));
    writeThrough(target.file, text);
    clearCaches(target.project);
    return { file: target.file, stamp: jsonfile.stampNow(target.file), project: target.project };
}

/**
 * Replace one file's whole text.
 *
 * The only thing in the app that can repair a file which no longer parses, and
 * therefore the thing that makes the form honest: nothing in these files is
 * beyond reach, so a control the form has not learned to draw is an
 * inconvenience rather than a wall. docs/plans/20-claude-config.md argues this
 * at length for the same reason.
 *
 * It is still checked — this is our format, and writing a document the reader
 * would refuse wholesale is not a service to anybody. What it does *not* do is
 * re-serialise: the bytes are written through, so whatever somebody typed is
 * what the diff shows.
 */
function saveText({ scope, dir, stamp, text }) {
    const target = writeTarget(scope, dir);
    if (typeof text !== 'string') throw jsonfile.refuse('body', 'text is not a string');

    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
        throw jsonfile.refuse('size',
            `that is ${bytes} bytes, and ${MAX_FILE_BYTES} is as large as one of these gets`);
    }

    let data;
    try { data = JSON.parse(text.replace(/^\ufeff/, '')); }
    catch (err) { throw jsonfile.refuse('json', err.message); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw jsonfile.refuse('json', 'that is not a JSON object');
    }
    if (data.version !== 1) {
        throw jsonfile.refuse('version',
            `version ${JSON.stringify(data.version)} — this reader understands 1`);
    }
    if (!Array.isArray(data.commands)) {
        throw jsonfile.refuse('json', '"commands" is not an array');
    }
    const problems = checkDocument(data.commands, target);
    if (problems.length) {
        const err = jsonfile.refuse('invalid', problems.length === 1
            ? problems[0].message
            : `${problems.length} problems with those commands`);
        err.detail = { problems };
        throw err;
    }

    checkStamp(target.file, stamp, jsonfile.stampNow(target.file));
    writeThrough(target.file, text);
    clearCaches(target.project);
    return { file: target.file, stamp: jsonfile.stampNow(target.file), project: target.project };
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
        web: raw.web === true && !!raw.port,
        workspace: read.workspace,
    };
}

module.exports = {
    load, prepare, expand, resolve, devbrowserTitle,
    raw, fileFor, saveDoc, saveText, clearCaches,
    validate, checkPlaceholders,
    SCOPES, MAX_COMMANDS, MAX_FILE_BYTES, MAX_RUN_CHARS, MAX_ENV_KEYS, MAX_LABEL_CHARS,
};
