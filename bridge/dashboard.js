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
//   * the open pull requests per repository, via `pulls.js`. Listing them and
//     matching against them answers "not merged yet" in a single call per repo;
//     asking after each PR the transcripts mention would be a call each and
//     would still have to read the same field. The conversation header does ask
//     per PR, because it wants merged ones too — which is why that code lives in
//     `pulls.js` and not here, and why the cache it uses is shared.
//
// Everything here shells out, so all of it is cached — and neither cache is this
// module's any more. Working trees live in `git.js`, which the session changes
// panel asks the same question of and which therefore shares the answer; GitHub
// lives in `pulls.js` along with everything else that asks it questions.

const fs = require('fs');
const path = require('path');

const { mapLimit } = require('./memo');
const git = require('./git');
const pulls = require('./pulls');

// Enough to see who has been in here without the row becoming a list.
const SESSIONS_PER_WORKSPACE = 6;
// Enough to recognise the change without pasting a `git status` into the UI.
const FILE_SAMPLE = 10;

const GIT_CONCURRENCY = 8;
const GH_CONCURRENCY = 4;

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
    if (refresh) { git.clearCache(); pulls.clearCache(); }

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
        ws.git = await git.statusOf(ws.dir, { limit: FILE_SAMPLE });
    });

    // A repository per project from its remote, plus any a transcript named
    // outright — a session run from a home directory has no checkout of its own
    // to read a remote from, but its PR link still says which repo it is.
    const roots = [...projects.values()];
    await mapLimit(roots, GIT_CONCURRENCY, async (p) => {
        p.repo = here(p.cwd) ? await pulls.repoOf(p.cwd) : null;
    });

    const repos = new Set();
    for (const p of roots) if (p.repo) repos.add(p.repo);
    for (const s of sessions) for (const pr of s.prs || []) if (pr.repo) repos.add(pr.repo);

    const pullsByRepo = new Map();
    const ghErrors = new Set();
    await mapLimit([...repos], GH_CONCURRENCY, async (repo) => {
        const r = await pulls.openPulls(repo);
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
            // Every PR the session raised, not just its newest: a session that
            // lands one and opens another has left two things behind, and only
            // one of them used to reach this board.
            for (const own of s.prs || []) {
                if (!own.number) continue;
                const pr = openPr(own.repo || p.repo, own.number);
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

module.exports = { build };
