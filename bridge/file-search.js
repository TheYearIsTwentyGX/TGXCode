'use strict';

// File search for the composer's `@` menu: which files and directories under a
// working directory match what has been typed after the `@`.
//
// Two halves, kept apart so the ranking can be tested without a filesystem:
//
//   - `listEntries(cwd)` — every path worth offering under a directory, cached.
//   - `rank(entries, query, limit)` — pure: the best `limit` of them for a query.
//
// **Listing.** Inside a git work tree the answer is `git ls-files --cached
// --others --exclude-standard`, because that is the one source of truth for "what
// would a person call part of this project": it honours every .gitignore, the
// repo's exclude file and the user's global one, which a hand-written walk never
// quite does. Tracked files deleted from disk are subtracted (`--deleted`), or the
// menu would offer a path the CLI then cannot read. Directories are not in that
// output, so they are derived from the file paths — an empty directory is not
// offered, which is no loss for a menu whose job is to point at something.
//
// Outside git (a scratch folder, `$HOME`) there is no ignore file to lean on, so a
// bounded walk skips the directories that are never what somebody means by "the
// project" and are routinely enormous: node_modules, .git, Library, caches. It is
// breadth-first, so when the budget runs out it is the deep files that are missing
// rather than the top of the tree, and it reports `truncated` so a client can say
// so. Symlinked directories are not followed: that is how a walk finds a loop, or
// leaves the roots the route checked.
//
// **Bounded, because the bridge is one process.** A Unity project is hundreds of
// thousands of files; listing it must not stall every other request. Both paths are
// async (a child process, `fs.promises`), capped by count, and the walk by time as
// well. Past the cap the list is cut and `truncated` says so — a menu that is
// sometimes missing a file it should have is better than a bridge that stops
// answering.
//
// **Cached per directory with a short TTL**, and concurrent callers share one
// in-flight listing. No watcher: a listing that is five seconds stale is a menu
// that has not yet heard about a file made in that time, and the next keystroke
// after the TTL hears of it. Invalidation is therefore just the clock, plus
// `forget()` for a caller that knows better.
//
// Ranking is in `rank()`'s own comment.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TTL_MS = 5_000;
const MAX_ENTRIES = 200_000;       // files + derived directories kept per listing
const MAX_WALK = 20_000;           // directory entries a non-git walk will look at
const WALK_BUDGET_MS = 1_500;      // wall-clock cap on a non-git walk
const GIT_TIMEOUT_MS = 8_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const STAT_CANDIDATES = 120;       // how many top results get an mtime for tie-breaks
const CACHE_MAX = 16;              // listings kept; oldest forgotten beyond this

// Never worth walking when there is no .gitignore to say so. Matched on the
// directory's own name. The Unity entries are the ones that actually hurt: Library
// alone is a hundred thousand files in a project of any size.
const WALK_SKIP = new Set([
    'node_modules', '.git', '.hg', '.svn', 'Library', 'Temp', 'Logs', 'obj',
    '.cache', '.npm', '.yarn', '.pnpm-store', '.gradle', '.cargo', '.rustup', '.nvm',
    '.Trash', '__pycache__', '.venv', 'venv', '.tox', '.next', '.nuxt', 'target',
    'DerivedData', 'Pods', '.idea', '.vs',
]);

/** @type {Map<string, {at:number, value?:object, pending?:Promise<object>}>} */
const cache = new Map();

/** One entry per file, plus one per directory that holds one. Sorted by the caller's need. */
function withDirectories(files) {
    const dirs = new Set();
    for (const f of files) {
        let d = path.posix.dirname(f);
        while (d !== '.' && !dirs.has(d)) {
            dirs.add(d);
            d = path.posix.dirname(d);
        }
    }
    const out = [];
    for (const d of dirs) out.push({ path: d, isDirectory: true });
    for (const f of files) out.push({ path: f, isDirectory: false });
    return out;
}

function git(cwd, args) {
    return new Promise((resolve, reject) => {
        execFile('git', ['-C', cwd, ...args], {
            encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        }, (err, stdout) => {
            // A buffer overflow still delivers what fit, which is the capped list
            // we want; only a failure with nothing to show is a failure.
            if (err && !(err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && stdout)) return reject(err);
            resolve({ out: stdout, overflow: Boolean(err) });
        });
    });
}

async function listWithGit(cwd) {
    const [all, gone] = await Promise.all([
        git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
        git(cwd, ['ls-files', '--deleted', '-z']).catch(() => ({ out: '', overflow: false })),
    ]);
    const deleted = new Set(gone.out.split('\0').filter(Boolean));
    let truncated = all.overflow;
    const seen = new Set();
    const files = [];
    for (const f of all.out.split('\0')) {
        // A cut-off buffer ends mid-name: the last piece has no terminator after it.
        if (!f || deleted.has(f) || seen.has(f)) continue;
        // Paths are relative to `cwd` already (`-C`), but a path that climbs out of
        // it — which ls-files does not produce — is dropped rather than trusted.
        if (f.startsWith('../') || path.isAbsolute(f)) continue;
        seen.add(f);
        files.push(f);
        if (files.length >= MAX_ENTRIES) { truncated = true; break; }
    }
    if (all.overflow) files.pop();   // the name the buffer cut in half
    return { entries: withDirectories(files), truncated, git: true };
}

async function listWithWalk(cwd) {
    const entries = [];
    const deadline = Date.now() + WALK_BUDGET_MS;
    let looked = 0;
    let truncated = false;
    let queue = [''];
    while (queue.length && !truncated) {
        const next = [];
        for (const rel of queue) {
            let items;
            try {
                items = await fs.promises.readdir(path.join(cwd, rel), { withFileTypes: true });
            } catch {
                continue;   // unreadable, or gone since the parent listed it
            }
            for (const d of items) {
                if (++looked > MAX_WALK || Date.now() > deadline || entries.length >= MAX_ENTRIES) {
                    truncated = true;
                    break;
                }
                const p = rel ? `${rel}/${d.name}` : d.name;
                if (d.isDirectory()) {
                    if (WALK_SKIP.has(d.name)) continue;
                    entries.push({ path: p, isDirectory: true });
                    next.push(p);
                } else {
                    entries.push({ path: p, isDirectory: false });
                }
            }
            if (truncated) break;
        }
        queue = next;
    }
    return { entries, truncated, git: false };
}

async function build(cwd) {
    try {
        return await listWithGit(cwd);
    } catch {
        // Not a work tree, or no git on PATH. Either way the walk is the answer.
        return listWithWalk(cwd);
    }
}

/**
 * Everything worth offering under `cwd`, from the cache while it is fresh.
 *
 * The caller has already checked `cwd` is inside the allowed roots; this module
 * reads wherever it is pointed. Throws if `cwd` is not a directory.
 *
 * @returns {Promise<{entries: {path:string,isDirectory:boolean}[], truncated:boolean, git:boolean}>}
 */
async function listEntries(cwd, now = Date.now()) {
    const hit = cache.get(cwd);
    if (hit && hit.pending) return hit.pending;
    if (hit && hit.value && now - hit.at < TTL_MS) return hit.value;

    const st = await fs.promises.stat(cwd);
    if (!st.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });

    const pending = build(cwd).then((value) => {
        cache.set(cwd, { at: Date.now(), value });
        // Oldest out first. A Map iterates in insertion order and `set` on an
        // existing key keeps its place, so delete-then-set to refresh.
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return value;
    }, (err) => { cache.delete(cwd); throw err; });
    cache.set(cwd, { at: now, pending });
    return pending;
}

/** Drop what is cached for one directory, or for all of them. */
function forget(cwd) {
    if (cwd) cache.delete(cwd); else cache.clear();
}

const lower = (s) => s.toLowerCase();

/** Is every character of `q` in `s`, in order? Returns the span it covered, or -1. */
function subsequenceSpan(s, q) {
    let at = 0;
    let first = -1;
    for (const ch of q) {
        const i = s.indexOf(ch, at);
        if (i < 0) return -1;
        if (first < 0) first = i;
        at = i + 1;
    }
    return at - first;
}

/**
 * How well one entry matches, or 0 for no match. Higher is better.
 *
 * Tiers, which are the ranking — the number inside a tier only breaks ties:
 *
 *   1000  the basename is the query
 *    900  the basename starts with it            (`mention` → mentions.js)
 *    800  the basename contains it
 *    700  a path segment starts with it          (`composer` → composer/slash.js)
 *    600  a path segment contains it
 *    300  the query is a subsequence of the basename   (`mnts` → mentions.js)
 *    200  the query is a subsequence of the whole path
 *
 * A query with a `/` in it is a path being typed, so it is matched against the
 * whole path instead: a prefix of it is 950, each `/`-separated piece matching the
 * start of successive segments (`w/c/sl` → web/composer/slash.js) 850, plain
 * containment 650.
 *
 * Inside a tier, shallower beats deeper and shorter beats longer: of two
 * `index.js`, the one at the top of the tree is nearly always the one meant.
 */
function score(entry, q) {
    const p = lower(entry.path);
    const slash = p.lastIndexOf('/');
    const base = p.slice(slash + 1);
    const depth = (p.match(/\//g) || []).length;
    const tiebreak = -depth * 4 - p.length * 0.05;
    let tier = 0;

    if (q.includes('/')) {
        const want = q.replace(/\/+$/, '');
        if (p.startsWith(want)) tier = 950;
        else {
            const pieces = want.split('/').filter(Boolean);
            const segs = p.split('/');
            let si = 0;
            let ok = pieces.length > 0;
            for (const piece of pieces) {
                while (si < segs.length && !segs[si].startsWith(piece)) si++;
                if (si >= segs.length) { ok = false; break; }
                si++;
            }
            if (ok) tier = 850;
            else if (p.includes(want)) tier = 650;
        }
    } else if (base === q) tier = 1000;
    else if (base.startsWith(q)) tier = 900;
    else if (base.includes(q)) tier = 800 - Math.min(base.indexOf(q), 50) * 0.5;
    else {
        const segs = p.split('/').slice(0, -1);
        if (segs.some(s => s.startsWith(q))) tier = 700;
        else if (segs.some(s => s.includes(q))) tier = 600;
        else {
            const sb = subsequenceSpan(base, q);
            if (sb >= 0) tier = 300 - Math.min(sb - q.length, 100) * 0.5;
            else {
                const sp = subsequenceSpan(p, q);
                if (sp >= 0) tier = 200 - Math.min(sp - q.length, 100) * 0.5;
            }
        }
    }
    return tier ? tier + tiebreak : 0;
}

/**
 * The best `limit` entries for a query, best first.
 *
 * An empty query is "show me the top of the tree": the entries directly under
 * `cwd`, directories first. A query ending in `/` that names a directory is "show
 * me inside it" — its direct children, same order — which is what lets the menu
 * drill in one level at a time after a directory is chosen.
 *
 * `mtimes` is an optional `path → ms` lookup for the tie-break the caller could
 * afford; see `rankWithRecency`. Without it ties fall to the alphabet.
 */
function rank(entries, query, limit = 50, mtimes = null) {
    const q = lower(String(query || '').trim().replace(/^\.\//, '')).replace(/\\/g, '/');
    const byName = (a, b) => a.path.localeCompare(b.path);

    const children = (dir) => entries
        .filter(e => path.posix.dirname(e.path) === dir)
        .sort((a, b) => (Number(b.isDirectory) - Number(a.isDirectory)) || byName(a, b));

    if (!q) return children('.').slice(0, limit);
    if (q.endsWith('/')) {
        const dir = q.replace(/\/+$/, '');
        if (entries.some(e => e.isDirectory && lower(e.path) === dir)) {
            const actual = entries.find(e => e.isDirectory && lower(e.path) === dir).path;
            return children(actual).slice(0, limit);
        }
    }

    const scored = [];
    for (const e of entries) {
        const s = score(e, q);
        if (s) scored.push({ e, s });
    }
    // A directory that matches the same as a file in it is the better answer: it
    // is the shorter path, and drilling in is one keystroke.
    scored.sort((a, b) => {
        if (Math.abs(b.s - a.s) > 1e-9) return b.s - a.s;
        if (mtimes) {
            const d = (mtimes.get(b.e.path) || 0) - (mtimes.get(a.e.path) || 0);
            if (d) return d;
        }
        return byName(a.e, b.e);
    });
    return scored.slice(0, limit).map(x => x.e);
}

/**
 * `rank`, with recency as the tie-breaker among the closest candidates.
 *
 * Cheap by construction: only the top few score-equal-ish candidates are statted,
 * not the listing. Two files that match a query equally well are the ones recency
 * is for, and those are always near the top.
 */
async function rankWithRecency(cwd, entries, query, limit = 50) {
    const first = rank(entries, query, Math.max(limit, STAT_CANDIDATES));
    const mtimes = new Map();
    await Promise.all(first.slice(0, STAT_CANDIDATES).map(async (e) => {
        try {
            mtimes.set(e.path, (await fs.promises.stat(path.join(cwd, e.path))).mtimeMs);
        } catch { /* gone since it was listed; sorts as oldest */ }
    }));
    return rank(entries, query, limit, mtimes);
}

/** The shape the route returns for one entry. */
function present(e) {
    const slash = e.path.lastIndexOf('/');
    return {
        path: e.path,
        name: e.path.slice(slash + 1),
        parent: slash < 0 ? '' : e.path.slice(0, slash),
        isDirectory: e.isDirectory,
    };
}

/**
 * The whole job for the route: list (cached), rank, present.
 *
 * @returns {Promise<{results: object[], truncated: boolean, git: boolean}>}
 */
async function search(cwd, query, limit = 50) {
    const { entries, truncated, git: isGit } = await listEntries(cwd);
    const top = await rankWithRecency(cwd, entries, query, limit);
    return { results: top.map(present), truncated, git: isGit };
}

module.exports = {
    search, listEntries, rank, rankWithRecency, score, forget, present,
    MAX_ENTRIES, MAX_WALK, TTL_MS, WALK_SKIP,
};
