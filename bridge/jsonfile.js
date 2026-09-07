'use strict';

// Reading and writing one small JSON file on disk, carefully.
//
// This is the third place in the repository that needed the same few things —
// bridge/prefs.js, scripts/install-quota-statusline.js, and now
// bridge/claude-config.js — and the two that existed had already drifted apart
// in a way that mattered:
//
//   - prefs.js wrote `<file>.tmp`, so the everyday bridge and a dev bridge
//     saving at the same moment raced on one path. The statusline script had
//     already worked that out and used the pid. This module uses the pid.
//   - Neither returned the file's text, only its parsed form. A raw editor
//     needs the bytes, and re-reading the file to get them is a second chance
//     to read a different file than the one you parsed.
//
// What is deliberately *not* here: any opinion about what the JSON means. No
// schema, no version check, no defaults. `readJson` hands back a plain object
// or a problem, and callers own the rest — prefs.js keeps its own `version`
// rule and claude-config.js keeps its catalogue, because those are the parts
// that are not shared.
//
// `stamp` is the one concept worth explaining. It is `mtimeMs:size`, opaque to
// everyone but this module, and it exists so a caller can say "write this only
// if the file is still the one I read". That is not paranoia here: the files
// bridge/claude-config.js writes are also written by `claude` itself, so
// "nothing else touches this" — which is true of `~/.tgxcode/settings.json` —
// is false one directory over.

const fs = require('fs');
const path = require('path');

/** A file of settings is a handful of keys; 64KB is already an accident. */
const MAX_FILE_BYTES = 64 * 1024;

/** Two spaces and a trailing newline: what Claude Code itself writes. */
const serialize = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

/** The opaque token that says "still the file I read". */
const stampOf = (st) => `${st.mtimeMs}:${st.size}`;

/**
 * The stamp of a file right now, without reading it.
 *
 * `null` means the file is not there — which is a legitimate answer to compare
 * against rather than an error: "create this, and refuse if somebody beat me
 * to it" is a precondition worth being able to state.
 */
function stampNow(file) {
    try {
        const st = fs.statSync(file);
        return st.isFile() ? stampOf(st) : null;
    } catch { return null; }
}

/**
 * Read one JSON file.
 *
 * Stat before read, in the shape of readConfig() in commands.js: a file of
 * unknown size never goes into memory whole.
 *
 * A missing file is not a problem — it is the common case for every file in a
 * precedence chain but one — so it comes back as all-nulls with no `problem`.
 * A file that exists and cannot be used comes back with `problem` set, and the
 * caller decides whether that is fatal.
 *
 * @param {string} file
 * @param {{maxBytes?: number}} [opts]
 * @returns {{data: object|null, text: string|null, stamp: string|null,
 *   size: number, problem: {file: string, message: string}|null}}
 */
function readJson(file, { maxBytes = MAX_FILE_BYTES } = {}) {
    const none = { data: null, text: null, stamp: null, size: 0, problem: null };

    let st;
    try { st = fs.statSync(file); } catch { return none; }
    if (!st.isFile()) return none;

    const stamp = stampOf(st);
    const base = { data: null, text: null, stamp, size: st.size };
    if (st.size > maxBytes) {
        return { ...base,
            problem: { file, message: `larger than ${Math.round(maxBytes / 1024)}KB — ignored` } };
    }

    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (err) { return { ...base, problem: { file, message: err.message } }; }

    // The text is handed back even when the parse fails, because that is
    // exactly when an editor needs it: a file that does not parse is a file
    // somebody has to look at, and it cannot be shown without its bytes.
    let data;
    // Tolerate a BOM the same way flags.js and commands.js do.
    try { data = JSON.parse(text.replace(/^﻿/, '')); }
    catch (err) { return { ...base, text, problem: { file, message: err.message } }; }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ...base, text, problem: { file, message: 'not a JSON object' } };
    }
    return { data, text, stamp, size: st.size, problem: null };
}

/**
 * Replace a file's contents, or fail having changed nothing.
 *
 * Write beside it and rename over it: a reader either sees the old file whole
 * or the new one whole, never a half-written one. The pid in the temporary name
 * is what keeps two bridges from racing on the same path — the everyday
 * instance and a dev instance both run out of this code.
 *
 * @param {string} file
 * @param {string} text already serialised; this module has no opinion about it
 */
function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
    } catch (err) {
        // A failed rename leaves the temporary file behind, and the next run
        // would write over it anyway — but a directory quietly filling with
        // `settings.json.12345.tmp` is the kind of thing nobody notices until
        // they go looking for something else.
        try { fs.unlinkSync(tmp); } catch { /* it may never have been created */ }
        throw err;
    }
}

/** Can this path be written, creating it and its directory if need be? */
function writable(file) {
    try {
        fs.accessSync(file, fs.constants.W_OK);
        return true;
    } catch { /* missing, or not writable — the directory decides */ }
    // Walk up to the nearest directory that exists: the containing directory is
    // created on demand, so its absence is not an answer.
    let dir = path.dirname(file);
    for (;;) {
        try {
            fs.accessSync(dir, fs.constants.W_OK);
            return true;
        } catch {
            if (!fs.existsSync(dir)) {
                const up = path.dirname(dir);
                if (up !== dir) { dir = up; continue; }
            }
            return false;
        }
    }
}

/**
 * Is this path a symlink, or does it resolve outside where it should be?
 *
 * Both `~/.claude/` and `<project>/.claude/` are directories somebody else's
 * tooling creates, and a symlink in one of them is a way to make a write land
 * somewhere this app would never have agreed to write. Checked rather than
 * followed, and checked on the *link* — `statSync` follows, `lstatSync` does
 * not, and following is the bug.
 *
 * @param {string} file
 * @param {string} within the directory the file must resolve inside
 * @returns {boolean} true when the file should not be written
 */
function escapes(file, within) {
    try {
        if (fs.lstatSync(file).isSymbolicLink()) return true;
    } catch { return false; }   // absent: nothing to escape with yet
    try {
        const real = fs.realpathSync(file);
        const root = fs.realpathSync(within);
        return real !== root && !real.startsWith(root + path.sep);
    } catch { return false; }
}

/** An Error a route can classify without reading the sentence. */
function refuse(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

module.exports = {
    MAX_FILE_BYTES, serialize, stampOf, stampNow,
    readJson, writeAtomic, writable, escapes, refuse,
};
