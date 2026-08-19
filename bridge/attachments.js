'use strict';

// Files pasted or dropped into the composer.
//
// The composer used to be text only, and the transcript could *show* an image it
// could never send. This is the other half: a file arrives over
// POST /api/sessions/:id/attachments, lands on disk, and the turn names its path.
//
// On disk rather than inlined as base64 — which is what docs/plans/09-composer.md §B
// proposed — for three reasons that only became clear once "images" grew into "any
// file". A path is referenceable in a later turn, where a base64 block is gone the
// moment the message scrolls past. A path survives as something the person can open
// themselves. And a CSV or a PDF has no inline block to be sent as at all, so the
// path is the only mechanism that covers every attachment rather than one kind.
//
// Images get *both*: the file on disk and an inline block, so the model sees a
// screenshot without spending a Read on it and the transcript draws the thumbnail
// with the code that was already there.
//
// Where they land is `attached_assets/` at the root of the checkout the session is
// working in — the *worktree* root for a worktree session, not the checkout that owns
// it. Writing to the owner would make an untracked directory appear in the checkout
// the user runs the everyday instance out of, which is the cost CLAUDE.md §"Work in a
// worktree" exists to prevent, and it would be the bridge itself causing it. A
// worktree's attached_assets dies with the worktree, which is the right lifetime for
// a screenshot pasted at a branch.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { isCheckout, projectRootOf, ATTACHMENT_NOTE_HEAD } = require('./transcript');

// Fixed, and deliberately not configurable. It is a convention the person typing has
// to be able to predict — they go looking for the screenshot they pasted — and a
// setting would make it something they have to remember per project.
const DIR_NAME = 'attached_assets';

// 25 MiB. Large enough for a screenshot off a 4K display and a PDF of any sensible
// length; small enough that a mis-dropped video is refused rather than copied into a
// git checkout. The body is read raw rather than base64-in-JSON precisely so this
// number can be about the file instead of about a third more than the file.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Per message, not per session. Five chips is already a wide strip, and a message
// carrying more than that is a directory — which is a path the model can be given.
const MAX_PER_MESSAGE = 5;

// What gets an inline image block. Deliberately narrower than "everything the model
// can read": these are the four the API takes as an image source, and a fifth entry
// here would be a block the CLI rejects and a turn that fails.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The media type, from the bytes rather than from the caller.
 *
 * The client's Content-Type decides whether we hand a file to the model *as an
 * image*, and a wrong one there is a failed turn rather than a bad thumbnail — so it
 * is sniffed. Anything unrecognised keeps whatever the caller said, because for a CSV
 * or a PDF the header is only ever a label on a card.
 */
function sniffType(buf, declared) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.alloc(0);
    if (b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF'
        && b.subarray(8, 12).toString('latin1') === 'WEBP') {
        return 'image/webp';
    }
    // Not an image we can inline. A declared type that *claims* to be one would send
    // a block the CLI cannot decode, so those drop back to a generic label and the
    // file travels as a path like any other.
    const said = String(declared || '').split(';')[0].trim().toLowerCase();
    if (!said || IMAGE_TYPES.has(said)) return 'application/octet-stream';
    return said;
}

function isImageType(mediaType) {
    return IMAGE_TYPES.has(String(mediaType || '').toLowerCase());
}

/**
 * The nearest checkout at or above a directory.
 *
 * `isCheckout` is an existence test on `.git`, which is a *file* in a worktree and a
 * directory in a clone — so this finds a worktree root without needing to know what a
 * worktree is, and `.claude/worktrees/foo` stops the walk exactly where we want it
 * stopped. Bounded rather than `while`: this walks a path that came off a transcript.
 */
function nearestCheckout(dir) {
    let at = path.resolve(dir || '');
    for (let i = 0; i < 40 && at; i++) {
        if (isCheckout(at)) return at;
        const up = path.dirname(at);
        if (up === at) return null;
        at = up;
    }
    return null;
}

/**
 * Where a session's attachments go, and the root that decided it.
 *
 * No checkout anywhere above the working directory means the working directory *is*
 * the root: `~/attached_assets` for a session started in the home directory is the
 * plain reading of "the project root" for somewhere that is not a project, and it
 * beats walking up to a checkout the session has nothing to do with.
 */
function attachmentsDirFor(cwd) {
    const at = path.resolve(cfg.expandHome(cwd || ''));
    const root = nearestCheckout(at) || at;
    return { root, dir: path.join(root, DIR_NAME) };
}

/**
 * Why this name cannot be used, or null.
 *
 * Refused rather than sanitised — the same choice `folderNameProblem` makes in
 * server.js: a name repaired after the fact is a name nobody checked, and the repair
 * is where the separator you missed gets through.
 *
 * One deliberate difference from that function: a leading dot is fine here. It
 * refuses one because the directory picker would not show the result; nothing browses
 * this directory, and `.env` or `.babelrc` is a plausible thing to drag onto a
 * composer.
 */
function attachmentNameProblem(name) {
    const n = String(name == null ? '' : name);
    if (!n) return 'a file name is required';
    if (n === '.' || n === '..') return `"${n}" is not a name`;
    if (n.includes('/') || n.includes('\\')) return 'a file name cannot contain a path separator';
    // Covers the null byte, which is the one that matters, along with every other
    // byte a name has no business carrying.
    if (/[\u0000-\u001f\u007f]/.test(n)) return 'that name contains a control character';
    if (Buffer.byteLength(n) > 200) return 'that name is too long';
    return null;
}

/** `shot.png` → `shot-2.png`; `LICENSE` → `LICENSE-2`. */
function numbered(name, n) {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    return `${stem}-${n}${ext}`;
}

/**
 * Write the file, without ever overwriting one that is already there.
 *
 * Two screenshots both called `image.png` in the same afternoon is the common case,
 * not an edge one, and the second is never a correction of the first — so a collision
 * becomes `image-2.png` and the earlier file is left exactly as it was.
 *
 * `flag: 'wx'` rather than an existsSync check, so the test and the write are one
 * operation. An existsSync loop has a window between the two, and two windows pasting
 * at once is a thing this app is specifically built to make possible.
 */
function writeAttachment({ dir, name, buffer }) {
    fs.mkdirSync(dir, { recursive: true });

    for (let n = 1; n <= 200; n++) {
        const candidate = n === 1 ? name : numbered(name, n);
        const target = path.join(dir, candidate);
        // Belt and braces. attachmentNameProblem has already refused every separator,
        // and this is still the check that must not be the one that was left out.
        if (path.dirname(target) !== dir) {
            throw Object.assign(
                new Error('that name does not stay inside the attachments directory'),
                { code: 'ENAME' });
        }
        try {
            fs.writeFileSync(target, buffer, { flag: 'wx', mode: 0o644 });
            return { path: target, name: candidate, renamed: candidate !== name };
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }
    }

    // Two hundred files of one name is not a case worth a nicer answer than a name
    // nothing can collide with.
    const candidate = numbered(name, Date.now());
    const target = path.join(dir, candidate);
    fs.writeFileSync(target, buffer, { mode: 0o644 });
    return { path: target, name: candidate, renamed: true };
}

/**
 * The path as the message should name it: relative to the working directory when the
 * file is inside it, absolute when it is not.
 *
 * Relative is what the model is going to type into a Read, and it is what a person
 * reading the transcript recognises. Absolute is the honest answer when a fallback
 * has put the file somewhere other than under the session's cwd.
 */
function relativeTo(cwd, file) {
    const base = path.resolve(cfg.expandHome(cwd || ''));
    const abs = path.resolve(file);
    if (abs === base || abs.startsWith(base + path.sep)) return path.relative(base, abs);
    return abs;
}

// `attached_assets`, with or without a leading or trailing slash, on its own line.
const EXCLUDE_RE = new RegExp(`^\\s*/?${DIR_NAME}/?\\s*$`, 'm');

/**
 * Keep `attached_assets/` out of git, without editing a file that is in git.
 *
 * `.git/info/exclude` and not `.gitignore`: the second is a tracked file in somebody
 * else's project, and a POST handler quietly adding a line to it is the same "leaves
 * the checkout dirty" problem wearing a different hat. info/exclude is local,
 * untracked, and exactly what it is for.
 *
 * The line goes in the *owning* checkout's exclude file. `projectRootOf` unwinds any
 * nesting of worktrees to get there, and it has to: git reads info/exclude from the
 * common git directory, so a worktree's own `.git/worktrees/<name>/info/exclude`
 * would be written and then never consulted.
 *
 * Best effort throughout. A repository we cannot write to is not a reason to fail an
 * upload the user is watching.
 */
function ensureExcluded(root) {
    try {
        const owner = projectRootOf(path.resolve(root));
        if (!owner || !isCheckout(owner)) return false;

        // The project may already say so, in which case adding a second rule saying
        // the same thing is noise in a file somebody reads.
        const gitignore = path.join(owner, '.gitignore');
        if (fs.existsSync(gitignore)
            && EXCLUDE_RE.test(fs.readFileSync(gitignore, 'utf8'))) {
            return false;
        }

        // A clone has .git as a directory and a worktree has it as a file, but
        // projectRootOf has already walked out to the clone — so this is a directory,
        // and anything else means the assumption broke rather than that we should
        // guess.
        const gitDir = path.join(owner, '.git');
        if (!fs.statSync(gitDir).isDirectory()) return false;

        const exclude = path.join(gitDir, 'info', 'exclude');
        let current = '';
        try { current = fs.readFileSync(exclude, 'utf8'); } catch { /* not created yet */ }
        if (EXCLUDE_RE.test(current)) return false;

        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        const gap = current && !current.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(exclude,
            `${gap}\n# Files pasted into a Claude Sessions composer.\n${DIR_NAME}/\n`);
        return true;
    } catch {
        return false;
    }
}

/**
 * One line of the block that names a turn's attached files.
 *
 * The paths have to be in the text, because text is the only channel a turn has: an
 * inline image block is the file, not a reference to it, and a CSV has no block at all.
 * So the message ends with a list, and bridge/transcript.js parses it straight back off
 * before anything is rendered.
 *
 * Assembled by `userContent` in bridge/runner.js — a line at a time, for a reason
 * explained there — and never by a client, so that a phone, a curl and the desktop
 * cannot each produce a slightly different list that only one parser knows.
 *
 * The size is in it because the card in the transcript wants it and the text is the
 * only thing a reread transcript still has. The model seeing it too costs a few tokens
 * and occasionally saves it opening a file to find out it is empty.
 */
function attachmentNoteLine(f) {
    return `- ${f.relPath} (${formatBytes(f.bytes)})`;
}

/** For the card in the transcript and the chip on the composer. */
function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
    DIR_NAME, MAX_ATTACHMENT_BYTES, MAX_PER_MESSAGE, IMAGE_TYPES,
    attachmentsDirFor, nearestCheckout, attachmentNameProblem, writeAttachment,
    relativeTo, ensureExcluded, sniffType, isImageType, formatBytes,
    // Re-exported so the runner, which writes the note, takes the heading and the
    // line shape from one import rather than reaching into transcript.js for half of
    // a format it is not otherwise involved with.
    ATTACHMENT_NOTE_HEAD, attachmentNoteLine,
};
