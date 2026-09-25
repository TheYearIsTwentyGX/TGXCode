'use strict';

// A session's scratchpad: the directory Claude Code gives each session for the
// probe scripts, SQL, PR bodies and message drafts that do not belong in the
// repository — and so the one place the changes panel could not see.
//
// Where it lives is `<tmp>/claude-<uid>/<project-slug>/<sessionId>/scratchpad`,
// and the thing that makes this a module rather than one `path.join` is that a
// session can have **several**. The slug is the project directory the session is
// running in, and a session that crosses into a worktree is running in a new one,
// so the same session id turns up under the main checkout's slug and under each
// worktree's. The transcript records only the one it started with
// (`environment.snapshot.scratchpadDirectory`), so it is not read here: looking
// for the id under every slug finds that one and the others with it.
//
// The sibling `tasks/` is not ours to show. It holds background agents' output,
// which is whole JSONL transcripts, and the conversation already renders those.
//
// `/tmp` does not survive a restart, so "there is no scratchpad" is the ordinary
// answer for any session older than the last boot, and is reported as an empty
// list rather than as an error.
//
// Every path a client sends back is a slug `key` and a path *relative* to that
// directory, and both are re-derived here: the key must name a directory this
// session actually has, and the file must resolve inside it both on paper and
// through `realpath`, so a symlink an agent left behind cannot make this a
// reader for the rest of the disk.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE_CAP = 400;      // across every directory; nobody scrolls further
const DEPTH_CAP = 4;
const READ_CAP = 1024 * 1024;
const SNIFF = 8192;
const SESSION_ID = /^[0-9a-f-]{36}$/i;
const WORKTREE_MARK = '--claude-worktrees-';

function base() {
    const tmp = process.env.CLAUDE_CODE_TMPDIR || os.tmpdir();
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    return path.join(tmp, `claude-${uid}`);
}

/** Every scratchpad directory this session has, main checkout first. */
function dirsFor(sessionId, root = base()) {
    if (!SESSION_ID.test(String(sessionId || ''))) return [];
    let slugs;
    try { slugs = fs.readdirSync(root); } catch { return []; }
    const out = [];
    for (const slug of slugs) {
        const dir = path.join(root, slug, sessionId, 'scratchpad');
        let st;
        try { st = fs.lstatSync(dir); } catch { continue; }
        if (!st.isDirectory()) continue;
        const at = slug.indexOf(WORKTREE_MARK);
        out.push({ key: slug, path: dir, where: at >= 0 ? slug.slice(at + WORKTREE_MARK.length) : null });
    }
    return out.sort((a, b) => (a.where || '').localeCompare(b.where || ''));
}

function list(sessionId, root = base()) {
    const dirs = dirsFor(sessionId, root);
    const files = [];
    let truncated = false;

    const walk = (key, top, rel, depth) => {
        let names;
        try { names = fs.readdirSync(path.join(top, rel)); } catch { return; }
        for (const name of names) {
            if (files.length >= FILE_CAP) { truncated = true; return; }
            const r = rel ? path.join(rel, name) : name;
            let st;
            try { st = fs.lstatSync(path.join(top, r)); } catch { continue; }
            // Symlinks are skipped rather than followed, for the reason in the header.
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) {
                if (depth < DEPTH_CAP) walk(key, top, r, depth + 1);
                continue;
            }
            if (!st.isFile()) continue;
            files.push({ dir: key, path: r.split(path.sep).join('/'), size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        }
    };
    for (const d of dirs) walk(d.key, d.path, '', 1);

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { dirs, files, truncated };
}

function inside(top, file) {
    const rel = path.relative(top, file);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function read(sessionId, key, given, root = base()) {
    const d = dirsFor(sessionId, root).find(x => x.key === key);
    if (!d) return { ok: false, reason: 'no-such-file' };

    const file = path.resolve(d.path, String(given || ''));
    if (!inside(d.path, file)) return { ok: false, reason: 'outside' };

    let real, realTop;
    try { real = fs.realpathSync(file); realTop = fs.realpathSync(d.path); } catch {
        return { ok: false, reason: 'no-such-file' };
    }
    if (!inside(realTop, real)) return { ok: false, reason: 'outside' };

    let st;
    try { st = fs.statSync(real); } catch { return { ok: false, reason: 'no-such-file' }; }
    if (!st.isFile()) return { ok: false, reason: 'no-such-file' };

    const meta = { absPath: file, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    const want = Math.min(st.size, READ_CAP);
    const buf = Buffer.alloc(want);
    let got = 0;
    let fd;
    try {
        fd = fs.openSync(real, 'r');
        while (got < want) {
            const n = fs.readSync(fd, buf, got, want - got, got);
            if (!n) break;
            got += n;
        }
    } catch (err) {
        return { ok: false, reason: 'read-failed', error: err.message, ...meta };
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }

    const bytes = buf.subarray(0, got);
    if (bytes.subarray(0, SNIFF).includes(0)) {
        return { ok: true, ...meta, binary: true, truncated: false, text: '' };
    }
    return { ok: true, ...meta, binary: false, truncated: st.size > got, text: bytes.toString('utf8') };
}

module.exports = { base, dirsFor, list, read, FILE_CAP, READ_CAP };
