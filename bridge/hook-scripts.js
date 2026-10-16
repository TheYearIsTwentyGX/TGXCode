'use strict';

// The scripts hooks run — read and written whole, from the Hooks page.
//
// The shape is bridge/claude-docs.js's: a file is the unit, every write carries
// the stamp it was read with, the read and the write share one size cap, a NUL
// byte is refused, and a symlink is refused rather than followed. Two things
// differ, and they are the reason this is a module rather than a third scope of
// that one.
//
//   1. **The client names the path, so the bridge decides whether it may.**
//      claude-docs builds its path from a scope and never takes one. That cannot
//      work here — a hook's script is wherever its command says — so the rule is
//      a whitelist instead of a constructor. A path is allowed when either:
//
//        - it is the script of a hook in a settings file in the chain for this
//          directory (scriptPath() in bridge/claude-config.js picks it out of
//          the command, the same way the "script missing" tag does), or
//        - it sits under a `.claude/hooks/` directory this page owns — the
//          user's, or the workspace's — which is where a new one is created.
//
//      So the page can open what a hook already points at and create what a
//      recipe needs, and nothing else. Naming `/etc/passwd` gets `path`, and so
//      does naming a file a hook *used* to point at before somebody edited it.
//
//   2. **The mode survives the save.** A hook script is executed, and the
//      atomic write replaces the inode — so a save through bare writeAtomic
//      would hand back a script without its executable bit, and the hook would
//      fail as quietly as one whose script had been deleted. The old mode is
//      read and put back; `executable: true` adds the bits for a new file or a
//      file somebody forgot to chmod.
//
// What is deliberately not here: running the script. The page edits and
// creates; whether the hook works is answered by the next session that fires it.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { chainFor, scriptPath } = require('./claude-config');
const { readJson, writeAtomic, writable, escapes, refuse, stampOf, stampNow } = require('./jsonfile');
const { isPlainObject } = require('./claude-schema');

/** A hook script is a page of shell; 256KB is the same generous cap as CLAUDE.md. */
const MAX_SCRIPT_BYTES = 256 * 1024;

/** What `executable: true` sets on a file that has no mode of its own yet. */
const NEW_EXEC_MODE = 0o755;

/** Where a page may create a script it has never seen a hook name. */
const HOOKS_DIR = 'hooks';

const NUL = String.fromCharCode(0);

/** Every command a settings file in the chain for `dir` hands to a hook. */
function commandsInChain(dir) {
    const out = [];
    for (const spec of chainFor(dir)) {
        const { data } = readJson(spec.file);
        const hooks = data && data.hooks;
        if (!isPlainObject(hooks)) continue;
        for (const groups of Object.values(hooks)) {
            if (!Array.isArray(groups)) continue;
            for (const g of groups) {
                for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
                    if (h && typeof h.command === 'string') out.push(h.command);
                }
            }
        }
    }
    return out;
}

/** The `.claude/hooks/` directories a script may be created in, for `dir`. */
function hookDirs(dir) {
    const out = [path.join(cfg.USER_CLAUDE_DIR, HOOKS_DIR)];
    if (dir && cfg.withinRoots(dir)) {
        out.push(path.join(path.resolve(cfg.expandHome(dir)), cfg.CLAUDE_DIR, HOOKS_DIR));
    }
    return out;
}

const inside = (file, root) => file.startsWith(root + path.sep);

/**
 * May the page touch this file, and what must it stay inside?
 *
 * @returns {{file: string, within: string, referenced: boolean}}
 * @throws a `path` refusal when it may not
 */
function allow(given, dir) {
    if (typeof given !== 'string' || !given.trim()) throw refuse('path', 'no path given');
    if (given.includes(NUL)) throw refuse('path', 'that path contains a NUL byte');
    const file = path.resolve(cfg.expandHome(given.trim()));
    if (dir && !cfg.withinRoots(dir)) {
        throw refuse('dir', `${dir} is not a directory this bridge will read`);
    }

    // A hook's own script: the strongest claim, and checked first so a script
    // that happens to live in `.claude/hooks/` is still reported as one a hook
    // points at.
    //
    // Still only inside the allowed roots or `~/.claude`: scriptPath() takes
    // the first token with a slash in it, which for `/usr/bin/env bash x.sh`
    // is the interpreter — and "a hook mentions it" must not make a binary on
    // the system path something a text box can overwrite.
    const referenced = commandsInChain(dir).some(c => scriptPath(c, dir) === file)
        && (cfg.withinRoots(file) || inside(file, cfg.USER_CLAUDE_DIR));
    if (referenced) return { file, within: path.dirname(file), referenced: true };

    // Somewhere new, inside a directory that exists for exactly this. Depth is
    // allowed — `hooks/lib/common.sh` is ordinary — but `..` is not, and
    // path.resolve has already folded any of it away, so the prefix test is the
    // whole check.
    const root = hookDirs(dir).find(r => inside(file, r));
    if (root) return { file, within: root, referenced: false };

    throw refuse('path',
        `${file} is not a script any hook here runs, nor inside a .claude/hooks directory`);
}

/** Read one script, or say why there is nothing to show. See claude-docs readText(). */
function readScript(file) {
    const none = {
        text: null, stamp: null, size: 0, exists: false, truncated: false, binary: false,
        executable: false, mode: null,
    };
    let st;
    try { st = fs.statSync(file); } catch { return none; }
    if (!st.isFile()) return none;
    const base = {
        stamp: stampOf(st), size: st.size, exists: true,
        mode: st.mode & 0o777,
        executable: (st.mode & 0o111) !== 0,
    };
    if (st.size > MAX_SCRIPT_BYTES) return { ...base, text: null, truncated: true, binary: false };
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { return { ...base, text: null, truncated: true, binary: false }; }
    // A compiled program is not something a text box can round-trip: shown, it
    // is mojibake, and saved, it is a broken binary. No text, and save refuses.
    if (text.includes(NUL)) return { ...base, text: null, truncated: false, binary: true };
    return { ...base, text, truncated: false, binary: false };
}

class HookScripts {
    /**
     * One script, with everything the editor needs to draw it.
     *
     * Refused rather than answered empty when the path is not allowed: unlike a
     * memory file, there is no "the row is simply absent" here — the client
     * asked about one path by name.
     */
    read({ dir, path: given }) {
        const spec = allow(given, dir);
        const got = readScript(spec.file);
        const symlink = escapes(spec.file, spec.within);
        return {
            file: spec.file,
            referenced: spec.referenced,
            writable: !symlink && writable(spec.file),
            symlink,
            maxBytes: MAX_SCRIPT_BYTES,
            ...got,
        };
    }

    /**
     * Replace a script's contents, or create one.
     *
     * Byte for byte, like claude-docs: a script's whitespace is the author's.
     * `executable: true` adds the execute bits; absent or false keeps the mode
     * the file had, and a new file without it gets the umask's answer — which
     * is a script a hook cannot run, so the page sends `true` for a new one.
     */
    save({ dir, path: given, stamp, text, executable }) {
        const spec = allow(given, dir);
        if (typeof text !== 'string') throw refuse('body', 'text is not a string');
        if (text.includes(NUL)) {
            throw refuse('body', 'that contains a NUL byte, so it is not text this can save');
        }
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > MAX_SCRIPT_BYTES) {
            throw refuse('size',
                `that is ${bytes} bytes, and ${MAX_SCRIPT_BYTES} is as large as a hook script gets here`);
        }
        if (escapes(spec.file, spec.within)) {
            throw refuse('readonly', `${spec.file} is a symlink — refusing to write through it`);
        }
        if (!writable(spec.file)) throw refuse('write', `${spec.file} cannot be written`);

        this._checkStamp(spec.file, stamp, stampNow(spec.file));

        const before = readScript(spec.file);
        if (before.binary || before.truncated) {
            throw refuse('readonly', `${spec.file} is not a text file this page can save over`);
        }
        let mode = before.exists ? before.mode : undefined;
        if (executable === true) mode = (mode === undefined ? NEW_EXEC_MODE : mode | 0o111);
        try {
            writeAtomic(spec.file, text, { mode });
        } catch (err) {
            throw refuse('write', `${spec.file}: ${err.message}`);
        }
        return this.read({ dir, path: spec.file });
    }

    /** The claude-docs precondition, unchanged: absent is refused, null means "create". */
    _checkStamp(file, sent, current) {
        if (sent === undefined) {
            throw refuse('stamp', 'this replaces the whole file, so it needs the stamp it was read with');
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
            err.detail = { stamp: current, text: readScript(file).text };
            throw err;
        }
    }
}

module.exports = { HookScripts, MAX_SCRIPT_BYTES, allow, hookDirs, readScript };
