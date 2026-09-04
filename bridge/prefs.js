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
// `spinner` is the second, and the same argument puts it here: what a turn in
// progress calls itself should read the same on every surface, and it does,
// because the bridge decides it rather than each client. The verbs themselves
// are too many for this file and live one group per file in `~/.tgxcode/verbs/`
// — see bridge/spinner.js. What lands here is only which groups are in play.
//
// `live` is the third, and it is about a view rather than about reading or
// about wording: how much of a card the live board draws, and whether it draws
// sessions this window has no process for. Per-browser was the obvious home for
// it — the board's other layout choice, side or bottom, is localStorage — but it
// is the same argument as above that puts it here instead. How much of a card
// you want to see is a preference about the app, not about the machine you
// happened to open it on.
//
// `keyboard` is the fourth, and it is the one section that is not about a view
// at all: which chord reaches which command, what Enter does in the composer,
// and whether Ctrl+C in the terminal copies a selection or interrupts. The
// bindings themselves are validated against bridge/keymap.js, which owns the
// catalogue of what may be bound — see the header there for why the list is not
// in `web/`.
//
// **Where the file lives is the deliberate part.** `~/.tgxcode/settings.json`,
// not STATE_DIR. Everything under STATE_DIR is state the app owns and nobody is
// expected to open — a token, a set of archived ids. This is a file a person
// edits by hand and the settings page writes, and it is the start of a
// directory meant to hold more than this app's share of it. A
// project may override any key from `<workspace>/.tgxcode/settings.json`, which
// is the same directory a project already declares its commands in — see
// bridge/commands.js, whose precedence this mirrors so the two cannot disagree
// about what "the local file" means.
//
// Unlike Flags, the defaults are written out on first read. A settings file
// with no UI in front of it has to be discoverable to be editable at all, and
// an empty `~/.tgxcode/` teaches nobody what may go in it. There is a settings
// page now — see `save()` at the foot of this file — and the defaults still get
// written, because the file being readable by hand is the thing that made the
// page possible to build rather than a step on the way to it.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const keymap = require('./keymap');
const { readJson, serialize, writeAtomic, writable, refuse } = require('./jsonfile');
const { projectRootOf } = require('./transcript');

const VERSION = 1;

// The size cap, the stat-before-read, the BOM and the atomic write all live in
// bridge/jsonfile.js now — three callers needed them and two of them had
// already drifted. What stays here is the one rule that is this file's own: a
// `version` that is not ours drops the file whole.

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
    live: {
        // Stop a card at the tool-count line: no history preview, no message
        // box, no Open/Stop, and no approval row either. Everything below that
        // line goes, which is more than "a bit tighter" — a compact card is a
        // status light, and answering anything on it means opening the session.
        // That is the trade being asked for: many sessions readable at a glance
        // beats any one of them being actionable in place.
        compact: false,
        // Leave out sessions running under something that is not this bridge —
        // a terminal, VS Code, another Claude Sessions window. They are the
        // cards the board cannot do anything with: no send, no stop, no answer,
        // because a second process on one transcript is two writers on one file.
        // Off by default, because a session you cannot drive from here is still
        // a session you may want to know is running.
        hideElsewhere: false,
    },
    quota: {
        // Refresh the quota percentages by starting a short-lived `claude`,
        // letting its startup probe run, harvesting the status line and killing
        // it — so the pill stays current with no terminal open. It leaves
        // nothing behind: a session that is never sent a message writes no
        // transcript, so there is no row in the rail and nothing to clean up.
        //
        // Off until `beaconDir` names somewhere, and deliberately **read from
        // the user file only** — a project's `.tgxcode/settings.json` is
        // checked into a repository, and what directory this app starts Claude
        // in is not a repository's business.
        beacon: false,
        // Where it runs. **Open Claude Code there yourself at least once
        // first.** The beacon never answers the trust prompt — that dialog
        // grants read, edit and execute on the directory, and a background
        // process confirming it on your behalf is not a thing this app will do.
        // Naming a directory you have not trusted just makes every run time
        // out, which the quota panel will tell you about.
        beaconDir: null,
        // How often, in minutes. Each run costs a CLI start and one
        // `max_tokens: 1` API call — a rounding error against a window, but not
        // nothing, so this is a floor of five rather than a free knob.
        beaconEveryMinutes: 20,
    },
    spinner: {
        // What a turn in progress calls itself. Off gives back the literal
        // "Thinking…" this app said for its whole life before now.
        randomize: true,
        // Which groups from `~/.tgxcode/verbs/` are in play. Named, not
        // globbed: enabling all 114 at once is a soup, and the point of the
        // groups is to choose a voice.
        groups: ['Claude Code Defaults', 'Monty Python', 'Absurd / Nonsense', 'Tech / Programming'],
        // How long a verb stands before another is drawn. This is the only
        // thing that moves it: the verb is a prefix, and what follows it — a
        // tool's name, `Writing…` — changes on its own as reality does. So the
        // verb drifts straight through a call of any length without displacing
        // what that call is. 0 pins it for the whole turn.
        rerollMs: 8000,
    },
    keyboard: {
        // Ctrl+C in the terminal copies when there is a selection and
        // interrupts when there is not, and Ctrl+V then pastes without the
        // Shift a terminal usually asks for. Off, because the alternative is
        // changing what Ctrl+C does to somebody who did not ask: a selection
        // left in the scrollback would turn an interrupt into a copy, and the
        // process you were trying to stop keeps running.
        //
        // **User file only.** Which keys your hands use is not a repository's
        // business — the same argument as `quota` below it, and see USER_ONLY.
        contextualTerminalCopy: false,
        // What Enter does in a composer. 'enter' is what this app has always
        // done — Enter sends, Shift+Enter is a newline. 'ctrl-enter' swaps
        // them, for anyone who writes several paragraphs before sending one.
        // Ctrl+Enter sends either way, which it already did.
        composerSend: 'enter',
        // Command id -> combo, or null to leave a command unbound. Absent means
        // the default in bridge/keymap.js, so this holds only what you changed
        // and a command added later arrives already bound.
        bindings: {},
    },
};

// Sections a project may not set, however the precedence would otherwise fall.
//
// `quota` because the beacon starts a `claude` in a directory of its own
// choosing, and a checked-in file deciding that for everyone who clones the
// repository is not a preference — it is a repository reaching outside itself.
// `keyboard` for the same reason one step further in: a repository that can
// rebind your keys can make the window unusable, and the way back would be
// hand-editing the file the page exists to save you from.
//
// Both were already meant to work this way. `quota` said so in prose and was
// enforced only by its call sites passing no `cwd` (see bridge/server.js,
// quotaPrefs) — which held, but left `GET /api/prefs?cwd=…` echoing a project's
// value back as though it counted. That was harmless while nothing read the
// answer and is not once a settings page prints which file wins for each key.
const USER_ONLY = new Set(['quota', 'keyboard']);

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
    live: {
        compact: (v) => typeof v === 'boolean',
        hideElsewhere: (v) => typeof v === 'boolean',
    },
    quota: {
        beacon: (v) => typeof v === 'boolean',
        beaconDir: (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 4096),
        // A floor of five minutes. Each run is a process and an API call, and a
        // settings file asking for one every ten seconds is a mistake rather
        // than a preference.
        beaconEveryMinutes: (v) => Number.isInteger(v) && v >= 5 && v <= 1440,
    },
    spinner: {
        randomize: (v) => typeof v === 'boolean',
        // A bound on the list rather than on the catalogue: the files are the
        // user's to add to, but a settings file naming ten thousand groups is
        // either a mistake or an attempt to make the bridge do unbounded work.
        groups: (v) => Array.isArray(v) && v.length <= 200
            && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 80),
        // A floor of a second, because a label changing faster than you can
        // read it is worse than one that never changes. 0 is off.
        rerollMs: (v) => v === 0 || (Number.isInteger(v) && v >= 1000 && v <= 600_000),
    },
    keyboard: {
        contextualTerminalCopy: (v) => typeof v === 'boolean',
        composerSend: (v) => v === 'enter' || v === 'ctrl-enter',
        // The last gate rather than the only one: cleanBindings() below has
        // already thrown out the entries that fail, one problem each, so
        // anything reaching here is a map of known command ids to `null` or a
        // canonical combo.
        bindings: (v) => {
            if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
            const ids = Object.keys(v);
            if (ids.length > keymap.MAX_BINDINGS) return false;
            return ids.every(id => keymap.COMMAND_IDS.has(id)
                && (v[id] === null || keymap.normalize(v[id]) === v[id]));
        },
    },
};

/**
 * `keyboard.bindings`, entry by entry.
 *
 * Every other setting is one value, so SHAPE's all-or-nothing rule reads as
 * "that number was wrong, the default stands". A map is different: one typo'd
 * command id would throw away every binding beside it, which is a lot of
 * silence for one mistake in a file people edit by hand. So each entry stands
 * or falls on its own and says which it was, and what survives is spelled the
 * way bridge/keymap.js spells it — `cmd+k` in the file becomes `Ctrl+K`, so
 * nothing downstream has to know the aliases.
 *
 * @param {*} value whatever the file had
 * @param {(msg: string) => void} note where a rejected entry gets reported
 * @returns {object|undefined} the cleaned map, or undefined to leave the
 *   default alone — which is what a value that is not a map at all gets.
 */
function cleanBindings(value, note) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const [id, raw] of Object.entries(value)) {
        if (!keymap.COMMAND_IDS.has(id)) {
            note(`${JSON.stringify(id)} is not a command`);
            continue;
        }
        if (raw === null) { out[id] = null; continue; }
        const combo = keymap.normalize(raw);
        if (!combo) {
            note(`${JSON.stringify(raw)} is not a usable combo for ${id}`);
            continue;
        }
        out[id] = combo;
    }
    return out;
}

// Section keys whose value is a map and so gets the treatment above, before
// SHAPE sees it. One entry today; the table exists so the next one does not
// have to special-case merge().
const SANITIZE = {
    keyboard: { bindings: cleanBindings },
};

/**
 * Read one settings file.
 *
 * bridge/jsonfile.js does the stat-before-read, the size cap, the BOM and the
 * parse. What is left here is the version rule, which is ours alone: a file
 * stamped with a version this bridge does not know is dropped whole rather than
 * half-read, because an old key that has changed meaning is worse than a
 * missing one.
 *
 * @returns {{data: object|null, stamp: string|null, problem: object|null}}
 */
function readFile(file) {
    const read = readJson(file);
    if (read.problem || !read.data) {
        return { data: read.data, stamp: read.stamp, problem: read.problem };
    }
    // Absent is fine: a project file that only sets one key has no reason to
    // restate the version. A *wrong* version is not.
    if (read.data.version !== undefined && read.data.version !== VERSION) {
        return { data: null, stamp: read.stamp,
            problem: { file, message: `unknown version ${JSON.stringify(read.data.version)} — expected ${VERSION}` } };
    }
    return { data: read.data, stamp: read.stamp, problem: null };
}

/**
 * Fold one file's keys over an accumulating result, dropping what fails SHAPE.
 *
 * @param {boolean} isUser whether `file` is the user's own settings, which is
 *   what decides whether a USER_ONLY section counts or is reported and skipped.
 */
function merge(into, data, file, problems, isUser) {
    for (const [section, checks] of Object.entries(SHAPE)) {
        const block = data[section];
        if (block === undefined) continue;
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
            problems.push({ file, message: `"${section}" is not an object — ignored` });
            continue;
        }
        if (USER_ONLY.has(section) && !isUser) {
            problems.push({ file,
                message: `"${section}" may only be set in ${cfg.USER_PREFS_FILE} — ignored` });
            continue;
        }
        for (const [key, ok] of Object.entries(checks)) {
            if (block[key] === undefined) continue;
            const sanitize = SANITIZE[section] && SANITIZE[section][key];
            const value = sanitize
                ? sanitize(block[key], (message) => problems.push({ file, message: `${section}.${key}: ${message} — ignored` }))
                : block[key];
            if (value === undefined) {
                problems.push({ file,
                    message: `${section}.${key}: ${JSON.stringify(block[key])} is not a valid value — ignored` });
                continue;
            }
            if (!ok(value)) {
                problems.push({ file,
                    message: `${section}.${key}: ${JSON.stringify(block[key])} is not a valid value — ignored` });
                continue;
            }
            into[section][key] = value;
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
            writeAtomic(cfg.USER_PREFS_FILE, serialize(DEFAULTS));
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
     *
     * `scope` is the settings page's name for a file — `user`, `project` or
     * `project-local`. Two of the four are `project-local`, because the main
     * checkout's local file and a worktree's own are both that: which is why
     * the page's save target comes from targetFile() and never from a row here.
     */
    files(dir) {
        const out = [{ file: cfg.USER_PREFS_FILE, scope: 'user' }];
        if (!dir || !cfg.withinRoots(dir)) return out;

        const workspace = path.resolve(cfg.expandHome(dir));
        const project = projectRootOf(workspace);
        out.push(
            { file: path.join(workspace, cfg.TGX_DIR, cfg.SETTINGS_FILE), scope: 'project',
                fallback: path.join(project, cfg.TGX_DIR, cfg.SETTINGS_FILE) },
            { file: path.join(project, cfg.TGX_DIR, cfg.SETTINGS_LOCAL_FILE), scope: 'project-local' },
            { file: path.join(workspace, cfg.TGX_DIR, cfg.SETTINGS_LOCAL_FILE), scope: 'project-local' },
        );
        return out;
    }

    /**
     * The one file a given scope writes, for a given directory.
     *
     * Derived rather than picked out of files(): the page offers three scopes
     * and the chain has four entries, and the entry that is not offered — the
     * main checkout's local file seen from a worktree — is exactly the one a
     * caller would pick by accident.
     *
     * @returns {string|null} null if the scope needs a directory and has none,
     *   or the directory is not one this bridge will read.
     */
    targetFile(scope, dir) {
        if (scope === 'user') return cfg.USER_PREFS_FILE;
        if (scope !== 'project' && scope !== 'project-local') return null;
        if (!dir || !cfg.withinRoots(dir)) return null;
        const workspace = path.resolve(cfg.expandHome(dir));
        return path.join(workspace, cfg.TGX_DIR,
            scope === 'project' ? cfg.SETTINGS_FILE : cfg.SETTINGS_LOCAL_FILE);
    }

    /**
     * The settings in force for a directory.
     *
     * @param {string} [dir] a workspace — a session's cwd. Omitted gives the
     *   user-level answer, which is what the page is served before it knows
     *   which conversation it is about to show.
     * @returns {{version, transcript, live, quota, spinner, keyboard,
     *   sources: string[], problems: object[]}}
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
            reads.push({ file, read, scope: spec.scope });
        }

        const stamp = reads.map(r => `${r.file}@${r.read.stamp || '-'}`).join('|');
        const hit = this.cache.get(key);
        if (hit && hit.stamp === stamp && Date.now() - hit.at < CACHE_MS) return hit.value;

        const value = {
            version: VERSION,
            transcript: { ...DEFAULTS.transcript },
            live: { ...DEFAULTS.live },
            quota: { ...DEFAULTS.quota },
            spinner: { ...DEFAULTS.spinner },
            keyboard: { ...DEFAULTS.keyboard, bindings: { ...DEFAULTS.keyboard.bindings } },
            sources: [],
            problems: [],
        };
        // In the main checkout the project and workspace local files are the
        // same path; reading it twice would double every problem it reports.
        const seen = new Set();
        for (const { file, read, scope } of reads) {
            if (seen.has(file)) continue;
            seen.add(file);
            if (read.problem) value.problems.push(read.problem);
            if (!read.data) continue;
            merge(value, read.data, file, value.problems, scope === 'user');
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

    /**
     * What each file in the chain *says*, as opposed to what the chain adds up
     * to.
     *
     * forCwd() answers "what is in force", which is the only thing the app
     * itself needs. A settings page needs the other question as well: a
     * checkbox has to know whether this scope set the value or inherited it,
     * because clearing an inherited one is meaningless and clearing a set one
     * is the whole point — and when a stronger file has taken over, the page
     * has to be able to name it rather than show a control that appears not to
     * work.
     *
     * Weakest first, the same order as sources. Rows are informational: what a
     * save would write comes from targetFile().
     *
     * @returns {Array<{file, scope, target, exists, parsed, writable, values,
     *   problems: string[]}>} — `parsed` false means the file was dropped
     *   whole, so what it says is unknown and a save to it will be refused.
     */
    raw(dir) {
        const seen = new Set();
        const out = [];
        for (const spec of this.files(dir)) {
            let read = readFile(spec.file);
            let file = spec.file;
            if (!read.data && !read.problem && spec.fallback && spec.fallback !== spec.file) {
                file = spec.fallback;
                read = readFile(file);
            }
            if (seen.has(file)) continue;
            seen.add(file);

            // Only the keys this bridge knows, and only the ones that pass —
            // the page draws controls from this, and a key it has no control
            // for would be invisible while still counting.
            const values = {};
            const problems = [];
            if (read.data) {
                const holder = {};
                for (const section of Object.keys(SHAPE)) holder[section] = {};
                merge(holder, read.data, file, problems, spec.scope === 'user');
                for (const [section, block] of Object.entries(holder)) {
                    if (Object.keys(block).length) values[section] = block;
                }
            }
            out.push({
                file,
                scope: spec.scope,
                target: file === this.targetFile(spec.scope, dir),
                exists: read.stamp !== null,
                parsed: !read.problem,
                writable: writable(file),
                values,
                problems: (read.problem ? [read.problem.message] : []).concat(problems.map(p => p.message)),
            });
        }
        return out;
    }

    /**
     * Write settings to one file in the chain.
     *
     * A patch of sections rather than a whole document, because the page edits
     * one control at a time and a whole-document write would have two windows
     * clobbering each other's unrelated keys. A `null` leaf **removes** the key
     * so the value falls back down the chain — which is not the same as writing
     * the default, and is the only way to say "I do not care about this one"
     * once you have said otherwise.
     *
     * A patch is per *key*, not deeper: `keyboard.bindings` is one key whose
     * value happens to be a map, so sending it replaces the whole map. That is
     * on purpose — inside the map `null` already means "unbound on purpose",
     * so there is no spare way to spell "drop this one entry back to its
     * default", and a caller that holds the resolved map (which the page does)
     * can say exactly what it wants by sending all of it.
     *
     * Everything is validated before anything is written, and the first failure
     * refuses the whole call. That is the opposite of what a *file* gets, where
     * a bad value is dropped and the default stands — deliberately: the file is
     * hand-edited and half of it working beats none of it, whereas a page
     * sending a value the bridge will not keep is a bug in the page, and
     * silently dropping it would leave a control showing something that is not
     * true.
     *
     * @param {{scope: string, dir?: string, patch: object}} req
     * @returns {{file, prefs, files}} the target and the answer that now holds
     * @throws {Error} with `.code` — `scope`, `section`, `value`, `dir`,
     *   `readonly`, `unparseable` or `write` — so a route can turn it into the
     *   right status without matching on prose.
     */
    save({ scope, dir, patch }) {
        if (scope !== 'user' && scope !== 'project' && scope !== 'project-local') {
            throw refuse('scope', `${JSON.stringify(scope)} is not a settings scope`);
        }
        if (scope !== 'user' && !dir) throw refuse('dir', `scope ${scope} needs a directory`);
        if (scope !== 'user' && !cfg.withinRoots(dir)) {
            throw refuse('dir', `${dir} is not a directory this bridge will read`);
        }
        const file = this.targetFile(scope, dir);
        if (!file) throw refuse('scope', `no settings file for scope ${JSON.stringify(scope)}`);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw refuse('section', 'patch is not an object');
        }

        // Validate the whole patch first. `null` skips SHAPE because it is a
        // removal rather than a value, and the sanitizers run here too so what
        // lands on disk is spelled canonically.
        const clean = {};
        for (const [section, block] of Object.entries(patch)) {
            if (!SHAPE[section]) throw refuse('section', `"${section}" is not a settings section`);
            if (!block || typeof block !== 'object' || Array.isArray(block)) {
                throw refuse('section', `"${section}" is not an object`);
            }
            if (USER_ONLY.has(section) && scope !== 'user') {
                throw refuse('readonly', `"${section}" may only be set in ${cfg.USER_PREFS_FILE}`);
            }
            clean[section] = {};
            for (const [key, value] of Object.entries(block)) {
                if (!SHAPE[section][key]) throw refuse('section', `${section}.${key} is not a setting`);
                if (value === null) { clean[section][key] = null; continue; }
                const sanitize = SANITIZE[section] && SANITIZE[section][key];
                const rejected = [];
                const next = sanitize ? sanitize(value, (m) => rejected.push(m)) : value;
                if (rejected.length) throw refuse('value', `${section}.${key}: ${rejected[0]}`);
                if (next === undefined || !SHAPE[section][key](next)) {
                    throw refuse('value', `${section}.${key}: ${JSON.stringify(value)} is not a valid value`);
                }
                clean[section][key] = next;
            }
        }

        // Read what is there before touching it. A file that does not parse is
        // refused rather than replaced: whatever is in it is somebody's work,
        // and a settings page is not a good enough reason to throw it away.
        const before = readFile(file);
        if (before.problem) throw refuse('unparseable', `${file}: ${before.problem.message}`);
        const doc = before.data ? { ...before.data } : {};
        doc.version = VERSION;
        for (const [section, block] of Object.entries(clean)) {
            const existing = (doc[section] && typeof doc[section] === 'object' && !Array.isArray(doc[section]))
                ? { ...doc[section] } : {};
            for (const [key, value] of Object.entries(block)) {
                if (value === null) delete existing[key];
                else existing[key] = value;
            }
            // An empty section is noise in a file people read, so it goes
            // rather than sitting there as `{}`.
            if (Object.keys(existing).length) doc[section] = existing;
            else delete doc[section];
        }

        try {
            writeAtomic(file, serialize(doc));
        } catch (err) {
            throw refuse('write', `${file}: ${err.message}`);
        }

        // The cache is keyed by workspace and stamped on mtime, but CACHE_MS is
        // two seconds of clock as well — long enough that a save followed
        // straight away by a read could answer with the old value.
        this.cache.clear();
        return { file, prefs: this.forCwd(dir), files: this.raw(dir) };
    }
}

module.exports = { Prefs, DEFAULTS, SHAPE, SANITIZE, USER_ONLY, VERSION };
