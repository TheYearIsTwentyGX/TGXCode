'use strict';

// What is still in flight: work written to disk but not committed, and pull
// requests that are open but not merged.
//
// The session list answers "what have I been talking to", which is not the same
// question. A worktree with eleven modified files and no commit, or a PR that has
// sat open for a week, are both things that need doing something about, and
// neither shows up as activity — the session that did the work has been quiet
// for days, which is exactly why it is easy to lose.
//
// Two sources, neither of them the transcript:
//
//   * `git status` in the directory a session was working in. A worktree is the
//     unit that holds uncommitted work, not a session — several sessions share
//     one, and one session can leave work in a worktree it has since left — so
//     rows are keyed by directory and sessions hang off them.
//   * `gh pr list` per repository. Listing the open ones and matching against
//     them answers "not merged yet" in a single call per repo; asking after each
//     PR the transcripts mention would be a call each and would still have to
//     read the same field.
//
// Everything here shells out, so all of it is cached: a dashboard left on screen
// re-reads working trees every fifteen seconds and GitHub every minute.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { cached, mapLimit } = require('./memo');

// Working trees are local and cheap; GitHub is neither.
const STATUS_TTL_MS = 15_000;
const PR_TTL_MS = 60_000;
const REPO_TTL_MS = 10 * 60_000;

// Enough to see who has been in here without the row becoming a list.
const SESSIONS_PER_WORKSPACE = 6;
// Enough to recognise the change without pasting a `git status` into the UI.
const FILE_SAMPLE = 10;

const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 20_000;
const GIT_CONCURRENCY = 8;
const GH_CONCURRENCY = 4;

const PR_FIELDS = 'number,title,url,headRefName,isDraft,updatedAt,createdAt,reviewDecision,author';

const cache = {
    /** @type {Map<string, {value?: any, pending?: Promise<any>, at: number}>} dir -> working state */
    status: new Map(),
    /** @type {Map<string, {value?: any, pending?: Promise<any>, at: number}>} repo -> open PRs */
    prs: new Map(),
    /** @type {Map<string, {value?: any, pending?: Promise<any>, at: number}>} checkout -> owner/name */
    repo: new Map(),
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
    return parseStatus(st.stdout);
}

function parseStatus(text) {
    const out = {
        ok: true, branch: null, upstream: null, ahead: 0, behind: 0,
        staged: 0, unstaged: 0, untracked: 0, conflicts: 0, files: 0,
        sample: [], detached: false,
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
        if (out.sample.length < FILE_SAMPLE) out.sample.push(entry);
    }

    out.dirty = out.files > 0;
    return out;
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

const statusOf = (dir) => cached(cache.status, dir, STATUS_TTL_MS, () => workingState(dir));

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/** `owner/name` for a GitHub remote, or null for anything else. */
function githubRepo(url) {
    const m = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
    return m ? `${m[1]}/${m[2]}` : null;
}

const repoOf = (dir) => cached(cache.repo, dir, REPO_TTL_MS, async () => {
    const r = await run('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    return r.ok ? githubRepo(r.stdout) : null;
});

/**
 * The open pull requests on one repository.
 *
 * "Open" is the whole answer to "not merged yet": a PR the transcripts know
 * about that is absent from this list has been merged or closed, and is not this
 * dashboard's business either way.
 */
const openPulls = (repo) => cached(cache.prs, repo, PR_TTL_MS, async () => {
    const r = await run('gh', [
        'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_FIELDS,
    ], { timeout: GH_TIMEOUT_MS });

    if (!r.ok) {
        const why = r.code === 'ENOENT'
            ? 'the gh CLI is not installed'
            : firstLine(r.stderr) || 'gh failed';
        return { ok: false, error: why, pulls: [] };
    }
    try {
        const pulls = JSON.parse(r.stdout).map(p => ({
            number: p.number,
            title: p.title,
            url: p.url,
            branch: p.headRefName,
            draft: !!p.isDraft,
            reviewDecision: p.reviewDecision || null,
            author: (p.author && (p.author.login || p.author.name)) || null,
            createdAt: p.createdAt || null,
            updatedAt: p.updatedAt || null,
            repo,
        }));
        return { ok: true, error: null, pulls };
    } catch (err) {
        return { ok: false, error: `could not read gh output: ${err.message}`, pulls: [] };
    }
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The directories a session actually worked in, newest role first. */
function sessionDirs(s) {
    const dirs = [];
    if (s.cwd) dirs.push(s.cwd);
    // A session that has left its worktree reports the project as its directory,
    // but whatever it did is still sitting in the worktree.
    if (s.worktree && s.worktree.path && !dirs.includes(s.worktree.path)) {
        dirs.push(s.worktree.path);
    }
    return dirs;
}

/**
 * What the UI needs to draw a session chip and open the conversation — and no
 * more. Every project's every worktree carries a few of these, so the summary
 * the rail uses would be sending a lot of nothing.
 */
function sessionChip(s) {
    return {
        sessionId: s.sessionId,
        title: s.title,
        // When you last spoke, which is what the rail sorts on and what "how
        // long has this been sitting here" means.
        lastTs: s.lastUserTs || s.lastTs,
        userMessages: s.userMessages,
        active: !!s.active,
    };
}

const chipTime = (c) => (c.lastTs ? Date.parse(c.lastTs) : 0);

/**
 * Everything the dashboard shows, grouped by project.
 *
 * @param {import('./sessions').SessionIndex} index
 * @param {{includeTest?: boolean, refresh?: boolean}} opts
 */
async function build(index, { includeTest = false, refresh = false } = {}) {
    if (refresh) { cache.status.clear(); cache.prs.clear(); }

    const sessions = index.list({ limit: 100_000, includeTest });

    // -- group sessions by project, then by the directory they worked in ------
    const exists = new Map();
    const here = (dir) => {
        if (!exists.has(dir)) {
            try { exists.set(dir, fs.statSync(dir).isDirectory()); } catch { exists.set(dir, false); }
        }
        return exists.get(dir);
    };

    /** @type {Map<string, {cwd, name, repo, workspaces: Map<string, any>}>} */
    const projects = new Map();
    const project = (cwd, name) => {
        let p = projects.get(cwd);
        if (!p) {
            p = { cwd, name, repo: null, workspaces: new Map() };
            projects.set(cwd, p);
        }
        return p;
    };

    for (const s of sessions) {
        const root = s.projectCwd || s.cwd;
        if (!root) continue;
        const p = project(root, s.projectName || path.basename(root));
        // A directory that is not there any more contributes no row of its own.
        // If it left a pull request behind, the PR pass below picks that up.
        for (const dir of sessionDirs(s).filter(here)) {
            let ws = p.workspaces.get(dir);
            if (!ws) {
                ws = {
                    dir,
                    kind: dir === root ? 'checkout' : 'worktree',
                    name: dir === root ? 'main checkout' : path.basename(dir),
                    sessions: [],
                };
                p.workspaces.set(dir, ws);
            }
            ws.sessions.push(sessionChip(s));
        }
    }

    // -- ask git and GitHub --------------------------------------------------
    const allWorkspaces = [...projects.values()].flatMap(p => [...p.workspaces.values()]);
    const gitDone = mapLimit(allWorkspaces, GIT_CONCURRENCY, async (ws) => {
        ws.git = await statusOf(ws.dir);
    });

    // A repository per project from its remote, plus any a transcript named
    // outright — a session run from a home directory has no checkout of its own
    // to read a remote from, but its PR link still says which repo it is.
    const roots = [...projects.values()];
    await mapLimit(roots, GIT_CONCURRENCY, async (p) => {
        p.repo = here(p.cwd) ? await repoOf(p.cwd) : null;
    });

    const repos = new Set();
    for (const p of roots) if (p.repo) repos.add(p.repo);
    for (const s of sessions) if (s.pr && s.pr.repo) repos.add(s.pr.repo);

    const pullsByRepo = new Map();
    const ghErrors = new Set();
    await mapLimit([...repos], GH_CONCURRENCY, async (repo) => {
        const r = await openPulls(repo);
        pullsByRepo.set(repo, r);
        if (!r.ok) ghErrors.add(r.error);
    });
    await gitDone;

    const openPr = (repo, number) => (pullsByRepo.get(repo)?.pulls || [])
        .find(p => p.number === number) || null;

    // -- match pull requests to what is on disk ------------------------------
    //
    // A workspace shows the PRs raised from the branch it has checked out, and
    // only those. Attaching a PR to a workspace because a session that worked
    // there recorded it reads plausibly and is wrong often: a session that
    // raises a PR from a worktree and then leaves reports the *project* as its
    // directory, which hung the worktree's PR on the main checkout — under a
    // branch the PR has nothing to do with, and a second time over next to the
    // worktree that really holds it.
    const out = [];
    for (const p of roots) {
        const rows = [];
        const claimed = new Set();      // PR urls a live branch accounts for

        for (const ws of p.workspaces.values()) {
            ws.sessions.sort((a, b) => chipTime(b) - chipTime(a));
            const pulls = (p.repo && pullsByRepo.get(p.repo)?.pulls) || [];
            const branch = ws.git && ws.git.branch;
            const mine = branch ? pulls.filter(pr => pr.branch === branch) : [];
            for (const pr of mine) claimed.add(pr.url);

            rows.push({
                ...ws,
                prs: mine.map(pr => ({ ...pr, matched: 'branch' })),
                sessions: ws.sessions.slice(0, SESSIONS_PER_WORKSPACE),
                moreSessions: Math.max(0, ws.sessions.length - SESSIONS_PER_WORKSPACE),
                lastTs: ws.sessions.length ? ws.sessions[0].lastTs : null,
            });
        }

        // Then the PRs the transcripts named that nothing on disk answers for —
        // a worktree that has been removed, or a branch that has moved on. One
        // row per PR rather than per session, so two sessions that worked the
        // same PR share it, and it is the sessions that link back to the chat.
        const byPr = new Map();
        for (const s of sessions) {
            if ((s.projectCwd || s.cwd) !== p.cwd) continue;
            if (!s.pr || !s.pr.number) continue;
            const pr = openPr(s.pr.repo || p.repo, s.pr.number);
            if (!pr || claimed.has(pr.url)) continue;

            let row = byPr.get(pr.url);
            if (!row) {
                row = {
                    dir: null,
                    kind: 'gone',
                    name: pr.branch || `PR #${pr.number}`,
                    git: { ok: false, reason: 'gone' },
                    prs: [{ ...pr, matched: 'session' }],
                    sessions: [],
                    moreSessions: 0,
                    lastTs: null,
                };
                byPr.set(pr.url, row);
            }
            row.sessions.push(sessionChip(s));
        }
        for (const row of byPr.values()) {
            row.sessions.sort((a, b) => chipTime(b) - chipTime(a));
            row.lastTs = row.sessions.length ? row.sessions[0].lastTs : null;
            row.moreSessions = Math.max(0, row.sessions.length - SESSIONS_PER_WORKSPACE);
            row.sessions = row.sessions.slice(0, SESSIONS_PER_WORKSPACE);
            rows.push(row);
        }

        // The whole point of the screen: only what is unfinished.
        const kept = rows.filter(r => (r.git && r.git.dirty) || r.prs.length);
        if (!kept.length) continue;

        kept.sort((a, b) => (Date.parse(b.lastTs || 0) || 0) - (Date.parse(a.lastTs || 0) || 0));
        out.push({
            cwd: p.cwd,
            name: p.name,
            repo: p.repo,
            dirty: kept.filter(r => r.git && r.git.dirty).length,
            open: kept.reduce((n, r) => n + r.prs.length, 0),
            workspaces: kept,
        });
    }

    out.sort((a, b) => {
        const at = Date.parse(a.workspaces[0].lastTs || 0) || 0;
        const bt = Date.parse(b.workspaces[0].lastTs || 0) || 0;
        return bt - at;
    });

    return {
        ready: index.ready,
        checkedAt: new Date().toISOString(),
        projects: out,
        dirty: out.reduce((n, p) => n + p.dirty, 0),
        open: out.reduce((n, p) => n + p.open, 0),
        // One line, not one per repository: they all fail the same way — gh
        // missing, or a login that has expired.
        gh: { ok: !ghErrors.size, repos: repos.size, error: [...ghErrors][0] || null },
    };
}

module.exports = { build, parseStatus, githubRepo };
