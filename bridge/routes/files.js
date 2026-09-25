'use strict';

// The filesystem, outside any session: `/api/fs` (the directory picker),
// `/api/fs/mkdir`, `/api/fs/open`, and `/api/attachments` for a file staged
// before its session exists.
//
// The attachment helpers came with it, and are lent out: `attachmentRefused`,
// `receiveAttachment` and `attachmentPath` to session.js for the per-session
// upload, and `resolveAttachments` to session.js, sessions.js and server.js
// (later-delivery sends with it). One copy, because two would be two places for
// the roots check to be got right.
//
// **Refused remotely** by remoteRefusal() before `api()`: mkdir, open, and the
// attachment upload. Listing a directory stays open — a phone may start a
// session, so it may ask where one could start.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const fs = require('fs');
const path = require('path');
const attachments = require('../attachments');
const cfg = require('../config');
const { isLaunchable, openFile, openInExplorer, toLinuxPath } = require('../explorer');
const { isWsl } = require('../platform');
const {
    NEXT, declaredOverMax, overMax, readBinary, readJson, refuseUpload, send,
} = require('../http');
const { resolveWorkdir } = require('../runner');

/**
 * Refuse an upload for a reason that has nothing to do with where it was going.
 *
 * Both checks run before the caller has even worked out a working directory, and
 * that ordering is the point: answering "session not found" to a request that
 * also carried `../evil.png` hides the refusal that actually mattered behind an
 * unrelated one. The size is answered from Content-Length, so an oversized upload
 * is refused before its bytes travel rather than after.
 *
 * Returns true when it has already answered.
 */
function attachmentRefused(req, res, name) {
    const bad = attachments.attachmentNameProblem(name);
    if (bad) {
        send(res, 400, { error: bad });
        return true;
    }
    if (declaredOverMax(req, attachments.MAX_ATTACHMENT_BYTES)) {
        refuseUpload(req, res, 413, overMax(attachments.MAX_ATTACHMENT_BYTES));
        return true;
    }
    return false;
}

/**
 * Read an upload's bytes and write them into a working directory's attachments.
 *
 * Everything the two upload routes do once they agree on a directory, which is
 * everything that matters: the roots check before the write and the realpath
 * check after it, the empty-file refusal, the rename-on-collision, the
 * gitignore entry, and sniffing the media type from the bytes. One copy, because
 * two would be two places for the roots check to be got right and one of them to
 * be forgotten later.
 *
 * `cwd` is already resolved by the caller — from a session for one of them, from
 * a validated `?cwd=` for the other.
 */
async function receiveAttachment(req, res, cwd, name) {
    const { dir, root } = attachments.attachmentsDirFor(cwd);
    if (!cfg.withinRoots(dir)) {
        return send(res, 403, {
            error: 'that directory is outside the allowed roots',
            path: dir, roots: cfg.ALLOWED_ROOTS,
        });
    }

    let buffer;
    try {
        buffer = await readBinary(req, attachments.MAX_ATTACHMENT_BYTES);
    } catch (err) {
        if (err.oversized) return refuseUpload(req, res, err.status, err.message);
        return send(res, err.status || 400, { error: err.message });
    }
    if (!buffer.length) return send(res, 400, { error: 'that file is empty' });

    let written;
    try {
        written = attachments.writeAttachment({ dir, name, buffer });
    } catch (err) {
        if (err.code === 'ENOTDIR') {
            return send(res, 400, {
                error: `${dir} exists but is not a directory`,
            });
        }
        return send(res, 500, { error: `could not save the file: ${err.message}` });
    }

    // After the mkdir, not before: this is the check that catches an
    // attached_assets symlinked out of the roots, which cannot be seen until
    // the directory exists.
    let real = dir;
    try { real = fs.realpathSync(dir); } catch { /* just written; treat as itself */ }
    if (!cfg.withinRoots(real)) {
        try { fs.unlinkSync(written.path); } catch { /* nothing better to do */ }
        return send(res, 403, {
            error: 'that directory resolves outside the allowed roots',
            path: real, roots: cfg.ALLOWED_ROOTS,
        });
    }

    attachments.ensureExcluded(root);

    return send(res, 200, {
        ok: true,
        name: written.name,
        renamed: written.renamed,
        path: written.path,
        relPath: attachments.relativeTo(cwd, written.path),
        dir,
        bytes: buffer.length,
        // Sniffed from the bytes, not taken from Content-Type — this is what
        // decides whether the turn carries an inline image block.
        mediaType: attachments.sniffType(buffer, req.headers['content-type']),
    });
}

/**
 * One client-supplied attachment path, re-derived against this session's own
 * attachments directory — or null.
 *
 * The client is handing back a path the bridge gave it a moment ago, which is not the
 * same thing as a path the bridge is willing to act on: a different session's id with
 * this session's file, or a path edited in flight, both arrive looking identical. So
 * only the *basename* is taken from the caller and the directory is recomputed here.
 * That leaves nothing for a `..` to traverse out of.
 */
function attachmentPath(cwd, given) {
    const raw = String(given == null ? '' : given);
    if (!raw) return null;
    const name = path.basename(raw);
    if (attachments.attachmentNameProblem(name)) return null;

    const { dir } = attachments.attachmentsDirFor(cwd);
    if (!cfg.withinRoots(dir)) return null;

    const file = path.join(dir, name);
    if (path.dirname(file) !== dir) return null;      // belt and braces
    try {
        if (!fs.statSync(file).isFile()) return null;
    } catch {
        return null;
    }
    return file;
}

/**
 * The attachments a send may carry, in the order the client staged them.
 *
 * A path that no longer resolves is dropped rather than refused. The alternative is
 * losing a message somebody typed because a file they staged was tidied away in the
 * meantime, and the message is worth more than the completeness of its file list.
 */
function resolveAttachments(cwd, given) {
    if (given == null) return [];
    if (!Array.isArray(given)) throw new Error('attachments must be an array');
    if (given.length > attachments.MAX_PER_MESSAGE) {
        throw new Error(`at most ${attachments.MAX_PER_MESSAGE} files per message`);
    }

    const out = [];
    for (const a of given) {
        const file = attachmentPath(cwd, a && (a.path || a.relPath || a));
        if (!file) continue;
        let bytes = 0;
        try { bytes = fs.statSync(file).size; } catch { /* raced; reported as 0 */ }
        out.push({
            path: file,
            name: path.basename(file),
            relPath: attachments.relativeTo(cwd, file),
            // Sniffed from the file on disk rather than believed from the client, for
            // the same reason the upload route sniffs it: this decides whether the turn
            // carries an inline image block, and a wrong answer is a failed turn.
            mediaType: attachments.sniffType(readHead(file), a && a.mediaType),
            bytes,
        });
    }
    return out;
}

/** The first few bytes of a file, for sniffing. Enough for every magic number. */
function readHead(file, n = 16) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(n);
        const read = fs.readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, read);
    } catch {
        return Buffer.alloc(0);
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
}

/**
 * Why this is not a usable folder name, or null if it is one.
 *
 * The leading-dot refusal is not prudishness: listDir() hides dotfiles, so a
 * `.foo` created here would be invisible in the very picker that made it. A name
 * the app will not show is worse than a name it will not accept.
 */
function folderNameProblem(name) {
    if (!name) return 'a name is required';
    if (name === '.' || name === '..') return `"${name}" is not a name`;
    if (name.includes('/')) return 'a folder name cannot contain "/" — make one level at a time';
    if (name.includes('\0')) return 'that name contains a null byte';
    if (name.startsWith('.')) return 'names starting with "." are hidden, and the picker would not show it';
    if (Buffer.byteLength(name) > 255) return 'that name is too long';
    return null;
}

/** Does this path exist and is it a directory? Follows symlinks, unlike a Dirent. */
function isDirectory(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const LIST_CAP = 500;

function listDir(dir) {
    const resolved = path.resolve(cfg.expandHome(dir));
    let entries = [];
    let truncated = false;
    try {
        const all = fs.readdirSync(resolved, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.'))
            // A symlink pointing at a directory reports isDirectory() false, so
            // without the second arm browsing cannot see a project tree that was
            // linked into place — and people do link them in. Only links pay for
            // the stat, and a dangling one drops out of the list by failing it.
            .filter(e => e.isDirectory()
                || (e.isSymbolicLink() && isDirectory(path.join(resolved, e.name))))
            .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        // The cap used to be silent, which reads as "this is all of it". Saying so
        // costs a boolean and stops the picker implying something false.
        truncated = all.length > LIST_CAP;
        entries = all.slice(0, LIST_CAP)
            // Which of these is a project, without having to click in. One stat
            // per row, capped, and all of it local.
            .map(e => ({ ...e, git: fs.existsSync(path.join(e.path, '.git')) }));
    } catch (err) {
        return {
            path: resolved, error: err.message, entries: [],
            parent: path.dirname(resolved), roots: cfg.ALLOWED_ROOTS,
        };
    }
    const isGit = fs.existsSync(path.join(resolved, '.git'));
    // Stop "up" at the edge of the allowed roots rather than offering a step the
    // route above will refuse. A dead end you can see is better than a button that
    // returns 403.
    const up = resolved === '/' ? null : path.dirname(resolved);
    return {
        path: resolved,
        parent: up && cfg.withinRoots(up) ? up : null,
        // The breadcrumb needs to know where the trail stops and what to call the
        // top of it, and when more than one root is configured this is the only
        // way a client can offer the second one at all. Learning the roots by
        // making a request that fails is backwards.
        roots: cfg.ALLOWED_ROOTS,
        isGit,
        truncated,
        entries,
    };
}

async function handle(req, res, url, pathname, seg, who) {
    // --- filesystem (new-session directory picker) -------------------------
    if (pathname === '/api/fs' && req.method === 'GET') {
        const dir = url.searchParams.get('path') || cfg.HOME;
        // This exists for the new-session directory picker, and a session can only
        // start inside the allowed roots — so listing outside them offers a choice
        // that cannot be taken, on top of enumerating the machine to a caller who
        // has no business doing so.
        if (!cfg.withinRoots(dir)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: path.resolve(dir),
                roots: cfg.ALLOWED_ROOTS,
            });
        }
        return send(res, 200, listDir(dir));
    }

    // --- attachments, before there is a session -----------------------------
    //
    // The same upload as POST /api/sessions/:id/attachments, for the composer in
    // the Start-a-session dialog. That one names a working directory by naming a
    // session; this one names it directly, because the session does not exist yet
    // and cannot until its first message — which is the message the file is going
    // on — has been composed.
    //
    // Beside /api/fs/mkdir rather than beside its own sibling, because these two
    // are the pair that matters: both take a client-supplied path and write into
    // the checkout it names, and remoteRefusal treats them the same way for the
    // same reason.
    if (pathname === '/api/attachments' && req.method === 'POST') {
        const name = url.searchParams.get('name');
        if (attachmentRefused(req, res, name)) return;

        const given = cfg.expandHome(url.searchParams.get('cwd') || '');
        if (!given) return send(res, 400, { error: 'cwd is required' });

        // The roots check by hand and first, so the refusal is the same shape every
        // other cwd-addressed route answers with. resolveWorkdir would refuse it
        // too, but only as a sentence — and a sentence is not something a client
        // can show a breadcrumb from.
        if (!cfg.withinRoots(given)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: path.resolve(given), roots: cfg.ALLOWED_ROOTS,
            });
        }

        // Unlike a session id, a client-supplied path is arbitrary: it may not
        // exist, and it may be a file. attachmentsDirFor would compute a plausible
        // directory beside either of those without complaint, so the question has
        // to be asked here — by the same function that asks it when a session is
        // about to be started in a directory.
        let cwd;
        try {
            cwd = resolveWorkdir(given);
        } catch (err) {
            return send(res, 400, { error: err.message });
        }

        return receiveAttachment(req, res, cwd, name);
    }

    // Somewhere to put a project that does not exist yet. The picker can navigate,
    // so this only ever has to make one directory in a place you are already
    // standing — which is why the body is {parent, name} rather than one joined
    // path. A separate `name` can be refused outright for containing a separator,
    // instead of being sanitised after the fact and hoping nothing was missed.
    if (pathname === '/api/fs/mkdir' && req.method === 'POST') {
        const body = await readJson(req);
        const parent = cfg.expandHome(body.parent || '');
        const name = String(body.name == null ? '' : body.name).trim();

        if (!parent) return send(res, 400, { error: 'parent is required' });
        if (!cfg.withinRoots(parent)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: path.resolve(parent),
                roots: cfg.ALLOWED_ROOTS,
            });
        }

        // Asked before mkdir so a missing or file-shaped parent is a sentence
        // rather than a bare ENOENT/ENOTDIR arriving from two layers down.
        if (!isDirectory(parent)) {
            return send(res, 400, { error: `No such directory: ${parent}` });
        }

        const bad = folderNameProblem(name);
        if (bad) return send(res, 400, { error: bad });

        const target = path.join(path.resolve(parent), name);
        // Belt and braces. The separator refusal above already makes this
        // unreachable, and it is still the check that must not be the one that
        // was left out.
        if (!cfg.withinRoots(target)) {
            return send(res, 403, {
                error: 'that directory is outside the allowed roots',
                path: target, roots: cfg.ALLOWED_ROOTS,
            });
        }

        try {
            // Deliberately not recursive: one segment is all the button offers, and
            // a non-recursive mkdir is what makes EEXIST below mean something.
            fs.mkdirSync(target);
            return send(res, 200, { ok: true, path: target, created: true });
        } catch (err) {
            if (err.code === 'EEXIST') {
                // The caller wanted a directory here by this name, and there is
                // one. Saying "already exists" would be technically true and
                // practically unhelpful — so this is idempotent, and the client
                // navigates into it either way.
                let st = null;
                try { st = fs.statSync(target); } catch { /* raced away */ }
                if (st && st.isDirectory()) {
                    return send(res, 200, { ok: true, path: target, created: false });
                }
                return send(res, 409, {
                    error: `${target} already exists and is not a directory`,
                });
            }
            if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
                return send(res, 404, { error: `${parent} is no longer a directory` });
            }
            if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
                return send(res, 403, { error: `Not allowed to create a folder in ${parent}` });
            }
            return send(res, 500, { error: err.message });
        }
    }

    // Open a path on the Windows host: the file itself, or the folder holding it.
    //
    // The one route here whose argument comes out of a transcript rather than out
    // of the app. Everywhere else that reaches explorer.js names a path this
    // bridge computed — a session's working directory, or a file re-derived
    // against that session's own attachments directory. Here the client is
    // repeating text a model wrote, and `explorer.exe` handed a file does not show
    // it, it launches it. So what Windows would do with the path is asked before
    // the path is handed over.
    //
    // No roots check, deliberately, and that is the refusal on this route that was
    // considered and dropped rather than the one that was forgotten.
    // cfg.ALLOWED_ROOTS defaults to $HOME, which would 403 every /tmp/claude-… and
    // /mnt/c/… link a transcript contains while buying nothing: an agent that
    // wanted a click on something malicious could write the file inside $HOME and
    // be inside the fence. What does the work instead is that this is local-only,
    // that the link text is the path itself so you see what you are opening, and
    // that isLaunchable is not negotiable.
    //
    // Session-free on purpose: this is about the machine, not about a
    // conversation, which is also what lets a path work on the second-monitor
    // board with nothing in focus.
    if (pathname === '/api/fs/open' && req.method === 'POST') {
        const body = await readJson(req);
        let given = cfg.expandHome(String(body.path == null ? '' : body.path).trim());
        if (!given) return send(res, 400, { error: 'path is required' });
        // The Windows form - `\\wsl.localhost\Ubuntu\…` or `C:\…` - is how an
        // agent writes a path it means you to find from the Windows side. wslpath
        // turns it back; nothing on this side guesses what the share is called.
        if (/^(?:\\\\|[A-Za-z]:\\)/.test(given)) {
            const linux = await toLinuxPath(given);
            if (!linux) {
                return send(res, 400, {
                    error: isWsl() ? `${given} is not a path this machine can reach`
                        : 'Windows paths can only be opened under WSL',
                });
            }
            given = linux;
        }
        const target = path.resolve(given);

        // Asked here rather than left to explorer.js so a path that is simply gone
        // — a plan file from a worktree that has since been landed — is a 404 and
        // not a 502 about a program that could not be run.
        let st;
        try { st = fs.statSync(target); } catch {
            return send(res, 404, { error: `${target} does not exist` });
        }

        // What a click needs before it can decide anything: a folder opens, a
        // file asks whether you want it or the folder it is in. Nothing is opened.
        if (body.probe) {
            return send(res, 200, {
                ok: true,
                how: 'probe',
                path: target,
                kind: st.isDirectory() ? 'directory' : 'file',
                launchable: !st.isDirectory() && isLaunchable(target),
            });
        }

        const answer = (out, how, why) => send(res, out.ok ? 200 : 502, {
            ok: out.ok,
            how,
            path: target,
            winPath: out.path || null,
            ...(why ? { why } : {}),
            ...(out.error ? { error: out.error } : {}),
        });

        // A directory belongs to Explorer, and a file Windows would execute is not
        // something a click on a sentence should do. Both degrade to the reveal
        // instead of refusing: the folder is the same information with none of the
        // execution. `how` is what happened rather than what was asked for, so a
        // client can say why the file it clicked did not open.
        const why = st.isDirectory() ? 'directory'
            : isLaunchable(target) ? 'executable'
                : null;
        if (why || body.reveal) {
            return answer(await openInExplorer(target), 'reveal', why);
        }
        return answer(await openFile(target), 'open');
    }

    return NEXT;
}

module.exports = { handle, attachmentPath, attachmentRefused, receiveAttachment, resolveAttachments };
