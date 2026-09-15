'use strict';

// Claude Code's memory files — `CLAUDE.md` at the user level and at the root of
// a workspace, read and written whole.
//
// A module of its own rather than a mode of bridge/claude-config.js, and the
// three differences are the whole reason:
//
//   1. **The unit is a file, not a key.** claude-config.js addresses a dotted
//      path inside a document it parses, validates against a catalogue and
//      re-serialises. There is nothing here to parse and nothing to validate:
//      the bytes somebody typed are the value, and the only honest thing to do
//      with them is write them back unchanged. Half of that module — `leaves`,
//      `setPath`, the schema, the union rule for permission lists — has no
//      meaning against prose.
//
//   2. **The addressing is different.** A settings file lives at
//      `<workspace>/.claude/settings.json`; the project memory file lives at
//      `<workspace>/CLAUDE.md`, one level up and outside `.claude` entirely. So
//      the directory the symlink check contains the file *within* differs per
//      scope, where claude-config.js could take `path.dirname(file)` for all of
//      them. Getting that wrong would check containment against the wrong root.
//
//   3. **Every write carries the precondition.** claude-config.js deliberately
//      lets a single scalar patch omit the `stamp`, because a read immediately
//      before the write cannot revert a sibling key. There is no such thing
//      here — every write replaces the whole document, which is exactly the
//      case that module *requires* the stamp for. So `stamp` is mandatory, and
//      an absent one is a refusal rather than a permitted shortcut.
//
// What is shared is bridge/jsonfile.js: the atomic write, the writability walk,
// the symlink check and the refusal helper. Those are file mechanics rather
// than JSON mechanics, which is why they were worth extracting in the first
// place. `readJson` is not shared — it parses, and rejects anything that is not
// a JSON object.
//
// These files are also additive rather than a precedence chain, which is the
// one thing a client must not borrow from the settings page: Claude Code reads
// the user file *and* the project file, and both are in force. There is no
// `effective` here, and nothing overrides anything.

const path = require('path');
const fs = require('fs');

const cfg = require('./config');
const { writeAtomic, writable, escapes, refuse, stampOf, stampNow } = require('./jsonfile');

/** The two scopes, in the order Claude Code reads them. */
const SCOPES = ['user', 'project'];

// One cap, used by both the read and the write.
//
// Phase 1 arrived at two independently-computed numbers that happen to be
// equal — `schema.MAX_STRING * 16` on the way in and `jsonfile.MAX_FILE_BYTES`
// on the way out — and that is worth not repeating here, because two caps that
// disagree are an editor that can open a file and then not save it. This repo's
// own CLAUDE.md is 23KB, so 256KB is generous rather than a limit anybody meets
// by writing.
const MAX_DOC_BYTES = 256 * 1024;

// Built from its code point rather than written as an escape in a literal, so
// that the byte this check is about cannot end up inside this file.
const NUL = String.fromCharCode(0);

/**
 * The one file a scope means, and the directory it has to stay inside.
 *
 * `within` is not `path.dirname(file)`: for the project scope the file sits at
 * the root of the workspace, so the workspace is what containment is checked
 * against. Writing `path.dirname` for both would be right by accident at the
 * user level and wrong at the project one.
 *
 * @returns {{file: string, within: string}|null} null when the scope needs a
 *   directory and has none, when the directory is not one this bridge will
 *   read, or when the scope is not one of ours.
 */
function specFor(scope, dir) {
    if (scope === 'user') {
        return { file: cfg.USER_CLAUDE_MEMORY, within: cfg.USER_CLAUDE_DIR };
    }
    if (scope !== 'project') return null;
    if (!dir || !cfg.withinRoots(dir)) return null;
    // The workspace itself, never its main checkout. Claude Code reads the
    // CLAUDE.md of the directory it runs in, so a worktree's own file is the
    // one in force — the same rule /api/claude-config states for `.claude`.
    const workspace = path.resolve(cfg.expandHome(dir));
    return { file: path.join(workspace, cfg.CLAUDE_MEMORY_FILE), within: workspace };
}

/**
 * Read one text file, or say why there is nothing to show.
 *
 * Stat before read, so a file of unknown size never goes into memory whole.
 * Over the cap the answer is `truncated` with **no text at all**, which is a
 * deliberate difference from Index#persistedOutput in bridge/sessions.js: that
 * one clips and returns what it got, because it feeds a viewer. This feeds an
 * editor with a Save button, and handing it the first 256KB of a larger file
 * would let one save silently delete the rest.
 *
 * @returns {{text: string|null, stamp: string|null, size: number,
 *   exists: boolean, truncated: boolean}}
 */
function readText(file) {
    const none = { text: null, stamp: null, size: 0, exists: false, truncated: false };
    let st;
    try { st = fs.statSync(file); } catch { return none; }
    // A directory or a socket where a file should be is not a file we have.
    if (!st.isFile()) return none;

    const base = { stamp: stampOf(st), size: st.size, exists: true };
    if (st.size > MAX_DOC_BYTES) return { ...base, text: null, truncated: true };
    try { return { ...base, text: fs.readFileSync(file, 'utf8'), truncated: false }; }
    catch { return { ...base, text: null, truncated: true }; }
}

/** Claude Code's memory files, for one workspace. */
class ClaudeDocs {
    /**
     * Both scopes, user first.
     *
     * The project row is **absent** rather than present-and-empty when there is
     * no workspace to resolve it against, or when the one given is outside the
     * allowed roots. A row naming `undefined/CLAUDE.md`, or one naming a real
     * path outside the roots that every write would then refuse, are both worse
     * answers than no row: the first is a lie, and the second is a control that
     * cannot work.
     */
    read(dir) {
        const docs = [];
        for (const scope of SCOPES) {
            const spec = specFor(scope, dir);
            if (!spec) continue;
            const got = readText(spec.file);
            const symlink = escapes(spec.file, spec.within);
            docs.push({
                id: `claude-md:${scope}`,
                kind: 'claude-md',
                scope,
                file: spec.file,
                exists: got.exists,
                // A symlink is refused rather than followed, so a page that drew
                // a writable box over one would be promising something the route
                // will decline.
                writable: !symlink && writable(spec.file),
                symlink,
                size: got.size,
                stamp: got.stamp,
                text: got.text,
                truncated: got.truncated,
            });
        }
        return { docs };
    }

    /**
     * Replace one file's contents.
     *
     * Written through byte for byte — no re-indenting, no trailing-newline
     * fixing, no BOM stripping. The JSON tab next door re-serialises because it
     * owns a format with a house style; this is somebody's prose, and an editor
     * that quietly changed the whitespace of a file it was asked to save would
     * be corrupting a diff nobody asked for.
     */
    save({ scope, dir, stamp, text }) {
        const spec = this._writeTarget(scope, dir);
        if (typeof text !== 'string') throw refuse('body', 'text is not a string');
        // A NUL byte means somebody sent something that is not text — most
        // likely a file picked by mistake. Refused rather than written, because
        // `claude` reads these as UTF-8 and what it would make of one is
        // undefined, and because a caller that sent one did not mean to.
        if (text.includes(NUL)) {
            throw refuse('body', 'that contains a NUL byte, so it is not text this can save');
        }
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > MAX_DOC_BYTES) {
            throw refuse('size',
                `that is ${bytes} bytes, and ${MAX_DOC_BYTES} is as large as one of these gets here`);
        }

        this._checkStamp(spec.file, stamp, stampNow(spec.file));
        this._write(spec.file, text);
        // The fresh stamp is what the caller's *next* write has to send, and the
        // rows come back with it so a client can take the answer wholesale
        // rather than patching its own copy.
        return { file: spec.file, stamp: stampNow(spec.file), ...this.read(dir) };
    }

    /** The scope checks a write shares, and the file it settles on. */
    _writeTarget(scope, dir) {
        if (!SCOPES.includes(scope)) {
            throw refuse('scope', `${JSON.stringify(scope)} is not a memory scope`);
        }
        if (scope !== 'user' && !dir) throw refuse('dir', `scope ${scope} needs a directory`);
        if (scope !== 'user' && !cfg.withinRoots(dir)) {
            throw refuse('dir', `${dir} is not a directory this bridge will read`);
        }
        const spec = specFor(scope, dir);
        if (!spec) throw refuse('scope', `no memory file for scope ${JSON.stringify(scope)}`);
        if (escapes(spec.file, spec.within)) {
            throw refuse('readonly', `${spec.file} is a symlink — refusing to write through it`);
        }
        if (!writable(spec.file)) throw refuse('write', `${spec.file} cannot be written`);
        return spec;
    }

    /**
     * Is the file still the one the caller read?
     *
     * Unlike claude-config.js, `undefined` is a refusal. There is no write here
     * that touches part of a document, so there is no write that can do without
     * the precondition — and a prose file is a draft by nature, so the gap
     * between the read that filled the box and the save is minutes rather than
     * milliseconds. `null` is the caller saying "this file should not exist
     * yet", which is how a page that has never seen one asks to create it.
     */
    _checkStamp(file, sent, current) {
        if (sent === undefined) {
            throw refuse('stamp',
                'this replaces the whole file, so it needs the stamp it was read with');
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
            // The file as it is now, so the page can show what it would have
            // overwritten rather than only reporting that it declined to.
            err.detail = { stamp: current, text: readText(file).text };
            throw err;
        }
    }

    _write(file, text) {
        try {
            writeAtomic(file, text);
        } catch (err) {
            throw refuse('write', `${file}: ${err.message}`);
        }
    }
}

module.exports = { ClaudeDocs, SCOPES, MAX_DOC_BYTES, specFor, readText };
