'use strict';

// Everything in the bridge that asks git a question about a directory.
//
// It started life inside `bridge/dashboard.js`, which needed "is there
// uncommitted work in this worktree" for a board of every project at once. The
// session changes panel needs the same answer about one directory, plus the
// per-file line counts, and two modules shelling out to git independently would
// mean two `git status` runs over the same worktree a second apart — so the
// primitives moved here and the cache moved with them. A panel and the board
// asking about the same directory now share one answer.
//
// Three rules, all inherited from the dashboard and all still load-bearing:
//
//   * `execFile`, never a shell, always with `cwd` and a timeout. These
//     directories are named by transcripts and may hold anything.
//   * Every failure is an answer, not an error. Half of what this is asked
//     about is somebody else's repository, and "that is not a checkout any
//     more" is a fact the UI wants to draw rather than an exception.
//   * The full file list is what gets cached, and callers cap it on the way
//     out. The board wants ten files per workspace across every project; the
//     panel wants all of one directory's. Capping before the cache would have
//     made those two different queries.

const fs = require('fs');
const { execFile } = require('child_process');

const { cached } = require('./memo');

// Working trees are local and cheap; a board left on screen re-reads them every
// fifteen seconds.
const STATUS_TTL_MS = 15_000;
const GIT_TIMEOUT_MS = 10_000;

const cache = {
    /** @type {Map<string, {value?: any, pending?: Promise<any>, at: number}>} dir -> working state */
    status: new Map(),
};

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * Run a command and always resolve. A dashboard is a report on other people's
 * repositories: half of what it asks for is allowed to fail, and a directory
 * that has stopped being a checkout is an answer rather than an error.
 */
function run(cmd, args, { cwd, timeout = GIT_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({
                ok: !err,
                stdout: String(stdout || ''),
                stderr: String(stderr || (err && err.message) || ''),
                code: err ? (err.code ?? 1) : 0,
            }));
    });
}

const firstLine = (s) => String(s || '').trim().split('\n')[0] || '';

/** Two paths naming the same directory, through symlinks. */
function samePath(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

/** Everything past the first `n` space-separated fields, spaces in it intact. */
function afterFields(line, n) {
    let at = 0;
    for (let i = 0; i < n; i++) {
        at = line.indexOf(' ', at);
        if (at === -1) return '';
        at++;
    }
    return line.slice(at);
}

// ---------------------------------------------------------------------------
// Working trees
// ---------------------------------------------------------------------------

/**
 * What `git status` says about one directory.
 *
 * The directory has to be a checkout root of its own, and that test is the whole
 * reason this asks git twice. A worktree that was removed leaves its directory
 * behind whenever anything untracked was in it — `node_modules`, a build cache —
 * and because those directories sit *inside* the project (`.claude/worktrees/…`)
 * git happily answers about the parent repository instead. Taking that answer
 * would report the main checkout's modified files against every dead worktree
 * on disk.
 */
async function workingState(dir) {
    const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    if (!top.ok) return { ok: false, reason: 'not-a-repo', error: firstLine(top.stderr) };

    const root = top.stdout.trim();
    if (!samePath(root, dir)) return { ok: false, reason: 'left-behind', root };

    const st = await run('git', [
        // Paths relative to the repository root rather than to the cwd, so a
        // sample line reads the same wherever the directory happens to be.
        '-c', 'status.relativePaths=false',
        '-C', dir, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal',
    ]);
    if (!st.ok) return { ok: false, reason: 'status-failed', error: firstLine(st.stderr) };
    return { ...parseStatus(st.stdout), root };
}

/**
 * `git status --porcelain=v2` as counts and a file list.
 *
 * `entries` is every file, uncapped — `statusOf` is what decides how many of
 * them a caller sees. `files` stays a count, because that is what it has always
 * been in this payload and the dashboard's UI reads it as one.
 */
function parseStatus(text) {
    const out = {
        ok: true, branch: null, upstream: null, ahead: 0, behind: 0,
        staged: 0, unstaged: 0, untracked: 0, conflicts: 0, files: 0,
        entries: [], detached: false,
    };

    for (const line of text.split('\n')) {
        if (!line) continue;

        if (line.startsWith('# ')) {
            const sp = line.indexOf(' ', 2);
            const key = sp === -1 ? line.slice(2) : line.slice(2, sp);
            const value = sp === -1 ? '' : line.slice(sp + 1);
            if (key === 'branch.head') {
                if (value === '(detached)') out.detached = true;
                else out.branch = value;
            } else if (key === 'branch.upstream') {
                out.upstream = value;
            } else if (key === 'branch.ab') {
                const m = /^\+(\d+) -(\d+)$/.exec(value);
                if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
            }
            continue;
        }

        const kind = line[0];
        let entry = null;

        if (kind === '1' || kind === '2') {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<orig>
            const skip = kind === '1' ? 8 : 9;
            const xy = line.split(' ', 2)[1] || '..';
            const rest = afterFields(line, skip);
            if (xy[0] !== '.') out.staged++;
            if (xy[1] !== '.') out.unstaged++;
            entry = { path: rest.split('\t')[0], status: xy };
        } else if (kind === 'u') {
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            out.conflicts++;
            entry = { path: afterFields(line, 10), status: 'UU' };
        } else if (kind === '?') {
            out.untracked++;
            entry = { path: line.slice(2), status: '??' };
        }

        if (!entry) continue;
        out.files++;
        out.entries.push(entry);
    }

    out.dirty = out.files > 0;
    return out;
}

/**
 * How many lines each changed file gained and lost, against HEAD.
 *
 * Renames are deliberately switched off. `--numstat` would otherwise print
 * `a/{b => c}/d` for one, and this map exists to be looked up by the paths
 * `git status` reports — a form neither side would agree on is worse than a
 * rename showing up as an add and a delete.
 *
 * Untracked files are not in `git diff` at all and so get no counts. That is an
 * answer rather than a gap: the UI already calls them new.
 *
 * @returns {Promise<Map<string, {added:number, deleted:number, binary:boolean}>>}
 */
async function numstat(dir) {
    const out = new Map();
    // A repository with no commit yet has no HEAD to diff against; everything in
    // it is staged or nothing, so ask about the index instead of failing.
    const hasHead = (await run('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'])).ok;
    const r = await run('git', [
        '-C', dir, 'diff', '--numstat', '--no-renames',
        ...(hasHead ? ['HEAD'] : ['--cached']),
    ]);
    if (!r.ok) return out;

    for (const line of r.stdout.split('\n')) {
        if (!line) continue;
        const [added, deleted, ...rest] = line.split('\t');
        const file = rest.join('\t');
        if (!file) continue;
        // `-` in both columns is git's way of saying binary.
        const binary = added === '-' || deleted === '-';
        out.set(file, {
            added: binary ? 0 : Number(added) || 0,
            deleted: binary ? 0 : Number(deleted) || 0,
            binary,
        });
    }
    return out;
}

/**
 * The cached working state of a directory, with its file list capped.
 *
 * The cap is per call rather than per cache entry, so that the board's ten files
 * and the panel's several hundred come out of one `git status`.
 *
 * @param {string} dir
 * @param {{limit?: number}} opts `limit` omitted means every file.
 */
async function statusOf(dir, { limit } = {}) {
    const state = await cached(cache.status, dir, STATUS_TTL_MS, () => workingState(dir));
    if (!state || !state.ok) return state;

    const { entries, ...rest } = state;
    const shown = limit == null ? entries : entries.slice(0, limit);
    return { ...rest, sample: shown, truncated: Math.max(0, entries.length - shown.length) };
}

/**
 * Forget cached working trees — what a Refresh button means.
 *
 * With a directory, only that one. The panel's Refresh is about the checkout in
 * front of you and has no business emptying the board's answers for forty other
 * worktrees; the board's Refresh is about all of them and passes nothing.
 */
function clearCache(dir) {
    if (dir) cache.status.delete(dir);
    else cache.status.clear();
}

module.exports = {
    run, firstLine, samePath, afterFields,
    parseStatus, workingState, numstat, statusOf, clearCache,
};
