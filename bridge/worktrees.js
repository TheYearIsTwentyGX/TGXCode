'use strict';

// The worktree janitor: every git worktree of a project, what is in each, and the
// one-click removal of the ones nothing would be lost from.
//
// bridge/worktree.js makes worktrees and still never removes one as a side effect
// of anything. This is the exception, and it is narrow on purpose. A person asks
// for removal by name, from the panel, and the bridge **decides again at the
// moment of removal** whether it is safe. The answer the panel drew from may be a
// minute old, and in that minute a session can start in the directory or somebody
// can edit a file there. A worktree is safe when every one of these holds:
//
//   * **It is not the main checkout**, nor the checkout this bridge serves.
//   * **It is not locked.** `git worktree lock` is somebody saying "leave this".
//   * **It is clean.** Uncommitted changes, untracked files included, are the one
//     thing `git worktree remove` really destroys.
//   * **Its tip is on a remote.** The test is `for-each-ref --contains` against
//     `refs/remotes`, or the PR's own head being this commit. An upstream with
//     `ahead: 0` is not used: once the remote branch is deleted after a merge,
//     status reports the upstream as gone and the ahead count as 0, which would
//     pass a branch that has commits nowhere else.
//   * **Its pull request is merged or closed.** No PR, an open one, or a gh that
//     could not answer (`unknown`) all refuse. "Never opened a PR" is a branch
//     somebody may still mean to.
//   * **No session is in it.** That covers a registry entry still running, a
//     runner in the pool that has not stopped, and a transcript written within
//     the last couple of minutes. This list is the "decides again" part, because
//     it changes fastest.
//
// Removal is `git worktree remove` **without `--force`**, so git's own dirty check
// is a second guard behind the first. A missing directory, which git calls
// prunable, is removed with `git worktree prune`; it only ever forgets
// administrative files for directories that are already gone. The branch is
// deleted only when its PR is MERGED **and** that PR's head is the branch's tip.
// `git branch -d` would refuse a squash-merged branch, and `-D` without that test
// would delete commits added after the merge. A closed-unmerged PR keeps its
// branch: the worktree had nothing uncommitted, but the branch may be the only
// local name for an idea somebody dropped on purpose.
//
// Everything that reads the outside world is passed in as `ctx`: the session list,
// the pool's statuses, and a function returning a repo's PRs. That keeps
// `classify` pure and lets test/worktrees.test.js drive the whole module against
// a throwaway repository with no bridge and no gh.

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const git = require('./git');
const pulls = require('./pulls');
const { cached, mapLimit } = require('./memo');
const { mainTop } = require('./worktree');

// One `gh pr list --state all` per repository per minute. The panel asks on open
// and again after every removal, and a bulk removal re-asks per path.
const PULLS_TTL_MS = 60_000;
// How recently a transcript must have been written to count as somebody being
// in the directory, when no registry entry or runner says so.
const ACTIVE_MS = 2 * 60_000;
// How many sessions a row lists by name. The count is always given in full.
const RECENT_SHOWN = 5;

const pullsCache = new Map();

/** Every PR of `repo` in any state, newest first, as `{ok, pulls, error}`. Memoised. */
function branchPulls(repo) {
    return cached(pullsCache, repo, PULLS_TTL_MS, async () => {
        const r = await pulls.run('gh', ['pr', 'list', '--repo', repo, '--state', 'all',
            '--limit', '200', '--json', 'number,state,headRefName,headRefOid,url,title']);
        if (!r.ok) return { ok: false, pulls: [], error: pulls.ghError(r) };
        try {
            const list = JSON.parse(r.stdout);
            return { ok: true, pulls: list.sort((a, b) => b.number - a.number) };
        } catch {
            return { ok: false, pulls: [], error: 'gh returned something that is not JSON' };
        }
    });
}

/** Forget the PR list for `repo`, so the next panel load sees a merge that just happened. */
function forgetPulls(repo) { pullsCache.delete(repo); }

/** `git worktree list --porcelain`, as `[{path, head, branch, main, locked, missing}]`. */
function parsePorcelain(text) {
    const out = [];
    for (const block of String(text).split(/\n\s*\n/)) {
        const wt = { path: null, head: null, branch: null, main: false, locked: false, missing: false, bare: false };
        for (const line of block.split('\n')) {
            const sp = line.indexOf(' ');
            const key = sp === -1 ? line : line.slice(0, sp);
            const val = sp === -1 ? '' : line.slice(sp + 1);
            if (key === 'worktree') wt.path = val;
            else if (key === 'HEAD') wt.head = val;
            else if (key === 'branch') wt.branch = val.replace(/^refs\/heads\//, '');
            else if (key === 'locked') wt.locked = true;
            else if (key === 'prunable') wt.missing = true;
            else if (key === 'bare') wt.bare = true;
        }
        if (wt.path && !wt.bare) out.push(wt);
    }
    // git always lists the main worktree first.
    if (out.length) out[0].main = true;
    return out;
}

async function listWorktrees(top) {
    const r = await git.run('git', ['-C', top, 'worktree', 'list', '--porcelain']);
    if (!r.ok) throw Object.assign(new Error(git.firstLine(r.stderr) || 'git worktree list failed'), { code: 'git-failed' });
    return parsePorcelain(r.stdout);
}

const inside = (p, dir) => !!p && (p === dir || p.startsWith(dir + path.sep));

/**
 * Who has been in `dir`: `{live, count, recent: [{id, title, lastTs, live}]}`.
 * `sessions` are index summaries; `runners` is `pool.statuses()`. `nested` are
 * other worktrees under `dir` — the main checkout contains every
 * `.claude/worktrees/*`, and a session in one of those is not in the main one.
 */
function sessionUse(dir, sessions = [], runners = {}, now = Date.now(), nested = []) {
    const own = (p) => inside(p, dir) && !nested.some(n => inside(p, n));
    const here = sessions.filter(s => own(s.cwd) || own(s.worktree && s.worktree.path));
    const liveIds = new Set();
    for (const s of here) {
        if ((s.live && s.live.running) || (s.mtimeMs && now - s.mtimeMs < ACTIVE_MS)) liveIds.add(s.sessionId);
    }
    for (const [id, st] of Object.entries(runners || {})) {
        if (st && st.state !== 'stopped' && own(st.cwd)) liveIds.add(id);
    }
    const recent = here
        .slice()
        .sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')))
        .slice(0, RECENT_SHOWN)
        .map(s => ({ id: s.sessionId, title: s.title || s.lastPrompt || null, lastTs: s.lastTs || null, live: liveIds.has(s.sessionId) }));
    return { live: liveIds.size > 0, count: here.length, recent };
}

/** The newest PR whose head is `branch`, as a row's `pr`, or null. */
function prFor(branch, list) {
    if (!branch) return null;
    const p = list.find(x => x.headRefName === branch);
    if (!p) return null;
    return { number: p.number, state: String(p.state || '').toLowerCase(), url: p.url, title: p.title, head: p.headRefOid };
}

/**
 * Why a row cannot be removed, as reason codes. Empty means safe. Pure: every
 * fact it needs is already on the row.
 */
function classify(row) {
    const reasons = [];
    if (row.main) reasons.push('main');
    if (row.self) reasons.push('self');
    if (row.locked) reasons.push('locked');
    if (row.dirty) reasons.push('dirty');
    if (row.unreadable) reasons.push('unreadable');
    if (!row.pushed) reasons.push('unpushed');
    if (row.prState === 'open') reasons.push('pr-open');
    else if (row.prState === 'none') reasons.push('pr-none');
    else if (row.prState !== 'merged' && row.prState !== 'closed') reasons.push('pr-unknown');
    if (row.sessions && row.sessions.live) reasons.push('live-session');
    return { safe: reasons.length === 0, reasons };
}

/** Is commit `sha` on any remote-tracking ref? */
async function onRemote(top, sha) {
    if (!sha) return false;
    const r = await git.run('git', ['-C', top, 'for-each-ref', '--count=1', '--contains', sha,
        '--format=%(refname)', 'refs/remotes']);
    return r.ok && r.stdout.trim() !== '';
}

/** Everything the panel shows about one worktree, with its verdict. */
async function inspect(wt, { top, prList, prOk, sessions, runners, selfRoot = cfg.ROOT, all = [] }) {
    const row = {
        path: wt.path,
        name: path.basename(wt.path),
        branch: wt.branch,
        head: wt.head,
        main: wt.main,
        locked: wt.locked,
        missing: wt.missing || !fs.existsSync(wt.path),
        self: git.samePath(wt.path, selfRoot),
        lastCommit: null,
        dirty: false,
        files: 0,
        unreadable: false,
        pushed: false,
        pr: null,
        prState: 'unknown',
        sessions: sessionUse(wt.path, sessions, runners, Date.now(),
            all.filter(p => p !== wt.path && inside(p, wt.path))),
    };

    if (!row.missing) {
        const st = await git.workingState(wt.path);
        if (st.ok) {
            row.dirty = !!st.dirty;
            row.files = st.files || 0;
        } else {
            // A status that could not be read is not a clean one.
            row.unreadable = true;
        }
    }
    const log = await git.run('git', ['-C', top, 'log', '-1', '--format=%cI', wt.head || 'HEAD']);
    if (log.ok) row.lastCommit = log.stdout.trim() || null;

    row.pr = prOk ? prFor(wt.branch, prList) : null;
    row.prState = !prOk ? 'unknown' : (row.pr ? row.pr.state : 'none');
    row.pushed = (row.pr && row.pr.head && row.pr.head === wt.head) || await onRemote(top, wt.head);

    Object.assign(row, classify(row));
    return row;
}

/** The shared facts every row is inspected against. */
async function context(top, ctx) {
    const repo = ctx.repo !== undefined ? ctx.repo : await pulls.repoOf(top);
    const got = repo ? await (ctx.pullsFor || branchPulls)(repo) : { ok: false, pulls: [], error: 'no GitHub remote' };
    return {
        top, repo,
        prList: got.pulls || [],
        prOk: !!got.ok,
        prError: got.ok ? null : got.error,
        sessions: ctx.sessions || [],
        runners: ctx.runners || {},
        selfRoot: ctx.selfRoot || cfg.ROOT,
    };
}

/**
 * Every worktree of the repository `cwd` belongs to, inspected.
 * Resolves `{top, repo, prError, worktrees: [row]}`.
 */
async function survey(cwd, ctx = {}) {
    const top = await mainTop(cwd);
    const c = await context(top, ctx);
    const list = await listWorktrees(top);
    c.all = list.map(w => w.path);
    const worktrees = await mapLimit(list, 6, wt => inspect(wt, c));
    return { top, repo: c.repo, prError: c.prError, worktrees };
}

const refusal = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

/**
 * Remove the worktree at `target`, a worktree of the repository `cwd` belongs to,
 * if and only if it is safe right now. Resolves
 * `{path, removed, branchDeleted, branchKept, branch}`; throws a refusal with a
 * `code` (`not-a-worktree`, `not-safe` with `reasons`, `git-failed`) otherwise.
 */
async function removeWorktree(cwd, target, ctx = {}) {
    const top = await mainTop(cwd);
    const want = path.resolve(String(target || ''));
    const list = await listWorktrees(top);
    const wt = list.find(w => w.path === want || git.samePath(w.path, want));
    if (!wt) throw refusal('not-a-worktree', `${want} is not a worktree of ${top}`);
    if (ctx.allow && !ctx.allow(wt.path)) throw refusal('outside-roots', `${wt.path} is outside the allowed roots`);

    const c = await context(top, ctx);
    c.all = list.map(w => w.path);
    const row = await inspect(wt, c);
    if (!row.safe) {
        throw refusal('not-safe', `${row.name} is not safe to remove: ${row.reasons.join(', ')}`, { reasons: row.reasons });
    }

    const gone = row.missing
        ? await git.run('git', ['-C', top, 'worktree', 'prune'])
        : await git.run('git', ['-C', top, 'worktree', 'remove', wt.path], { timeout: 60_000 });
    if (!gone.ok) {
        const lines = gone.stderr.split('\n').map(s => s.trim()).filter(Boolean);
        throw refusal('git-failed', lines.find(l => /^(fatal|error):/.test(l)) || git.firstLine(gone.stderr) || 'git worktree remove failed');
    }

    let branchDeleted = false;
    if (wt.branch && row.pr && row.pr.state === 'merged' && row.pr.head && row.pr.head === wt.head) {
        // Re-read the tip: a commit made between inspect and now would move it,
        // and -D must only ever delete the exact commit the PR merged.
        const tip = await git.run('git', ['-C', top, 'rev-parse', '--verify', '-q', `refs/heads/${wt.branch}`]);
        if (tip.ok && tip.stdout.trim() === row.pr.head) {
            const del = await git.run('git', ['-C', top, 'branch', '-D', wt.branch]);
            branchDeleted = del.ok;
        }
    }
    git.clearCache(top);
    return { path: wt.path, branch: wt.branch, removed: true, branchDeleted, branchKept: !!wt.branch && !branchDeleted };
}

module.exports = {
    survey, removeWorktree, classify, sessionUse, parsePorcelain, branchPulls, forgetPulls, prFor,
};
