'use strict';

// The nightly review's findings, and starting a session to fix them.
//
//   GET  /api/pr-review?repo=owner/name&number=N   — the latest review, parsed
//   POST /api/pr-review/fix                        — "Fix this" / "Fix all"
//
// The reading half is bridge/pr-reviews.js, which answers from memory and never
// waits on GitHub. The writing half starts an ordinary session, so it keeps every
// rule `POST /api/sessions` keeps, in the same order: the mode, then the remote
// worktree rule, then the create limit, then git.
//
// **Where the fix runs.** On the pull request's own branch, because the session is
// told to push to it. A worktree already holding that branch is reused — most PRs
// here come from one — and otherwise one is checked out under `.claude/worktrees/`
// by bridge/worktree.js `checkoutWorktree`. A remote caller may reuse one but not
// make one, which is `POST /api/sessions`' `worktree` rule.
//
// **It will not pile into somebody's work.** A worktree with a live session in it,
// or with uncommitted changes, is a 409 that names what is there rather than a
// second session editing the same files. The main checkout is never used, even
// when it happens to have the branch out: it is the one the user runs the app from.
//
// **The prompt is built here, from the bridge's own copy of the review.** The
// client names a finding by index and nothing it sends ends up in the prompt but
// that choice, so a page cannot dress arbitrary text up as a review finding.

const fs = require('fs');
const cfg = require('../config');
const git = require('../git');
const pulls = require('../pulls');
const prStore = require('../pr-store');
const prReviews = require('../pr-reviews');
const { NEXT, readJson, send } = require('../http');
const { worktreeForBranch, checkoutWorktree } = require('../worktree');
const { broadcast } = require('../events');

// Handed over by server.js — see the note above ROUTES there.
let CREATE_LIMIT = null;
let flags = null;
let index = null;
let modeRefusal = null;
let normalizeMode = null;
let pool = null;
let registry = null;
let tooManyCreates = null;

function init(deps) {
    ({ CREATE_LIMIT, flags, index, modeRefusal, normalizeMode, pool, registry, tooManyCreates } = deps);
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LIVE_STATES = new Set(['starting', 'idle', 'busy']);

/** `{repo, number}` off a query or a body, or null when either is malformed. */
function prOf(repo, number) {
    const n = Number(number);
    if (typeof repo !== 'string' || !REPO_RE.test(repo) || !Number.isInteger(n) || n <= 0) return null;
    return { repo, number: n };
}

/**
 * A live session whose directory is `dir` or inside it, or null.
 *
 * This bridge's own processes first, then Claude Code's registry of every one
 * running on the machine — which is what sees a session the everyday bridge, a
 * dev bridge or a terminal started, none of which are in this pool.
 */
function liveSessionIn(dir) {
    const inside = (cwd) => !!cwd && (git.samePath(cwd, dir) || cwd.startsWith(dir.replace(/\/$/, '') + '/'));
    const named = (sessionId) => {
        const summary = index.summary(sessionId);
        return { sessionId, title: (summary && summary.title) || null };
    };
    for (const [sessionId, st] of Object.entries(pool.statuses())) {
        if (st && LIVE_STATES.has(st.state) && inside(st.cwd)) return named(sessionId);
    }
    for (const e of (registry && registry.running()) || []) {
        if (e.sessionId && inside(e.cwd)) return named(e.sessionId);
    }
    return null;
}

/**
 * A directory that is a checkout of `repo`: the caller's hint when it is one,
 * else the directory the review's schedule runs in, else any project the index
 * knows with that remote. The hint is only a hint because a surface does not
 * always know — the board can list a PR under a project that merely mentioned it.
 */
async function checkoutOf(repo, number, hint) {
    const rec = prReviews.localRecord(repo, number);
    const seen = new Set();
    const candidates = [hint, rec && rec.cwd, ...index.projects().map(p => p.cwd)];
    for (const dir of candidates) {
        if (!dir || seen.has(dir) || !cfg.withinRoots(dir) || !fs.existsSync(dir)) continue;
        seen.add(dir);
        if (await pulls.repoOf(dir) === repo) return dir;
    }
    return null;
}

/** A short session name: "Fix #12: the finding's title". */
function sessionTitle(number, findings) {
    const what = findings.length === 1 ? findings[0].title
        : findings.length ? `${findings.length} review findings` : 'review findings';
    const t = `Fix #${number}: ${what}`;
    return t.length > 90 ? t.slice(0, 89) + '…' : t;
}

async function handle(req, res, url, pathname, seg, who) {
    if (pathname === '/api/pr-review' && req.method === 'GET') {
        const pr = prOf(url.searchParams.get('repo'), url.searchParams.get('number'));
        if (!pr) return send(res, 400, { error: 'repo (owner/name) and number are required' });
        const { review, pending } = prReviews.reviewFor(pr.repo, pr.number);
        const open = prStore.lookup(pr.repo, pr.number, null);
        const summary = prReviews.summaryFor(pr.repo, pr.number, open && open.headSha);
        return send(res, 200, {
            repo: pr.repo,
            number: pr.number,
            review: review ? { ...review, counts: summary.counts, stale: summary.stale } : null,
            pending: !!pending,
        });
    }

    if (pathname === '/api/pr-review/fix' && req.method === 'POST') {
        const body = await readJson(req);
        const pr = prOf(body.repo, body.number);
        if (!pr) return send(res, 400, { error: 'repo (owner/name) and number are required' });
        const hint = typeof body.cwd === 'string' && body.cwd ? cfg.expandHome(body.cwd) : null;
        if (hint && !cfg.withinRoots(hint)) {
            return send(res, 403, { error: 'that directory is outside the allowed roots' });
        }

        const { review } = prReviews.reviewFor(pr.repo, pr.number);
        if (!review) return send(res, 404, { error: 'no review of that pull request is known yet' });

        let findings;
        if (body.finding == null) {
            findings = prReviews.fixAllFindings(review.findings);
        } else {
            const i = Number(body.finding);
            if (!Number.isInteger(i) || i < 0 || i >= review.findings.length) {
                return send(res, 400, { error: 'finding must be the index of one of the review\'s findings' });
            }
            findings = [review.findings[i]];
        }

        const open = prStore.lookup(pr.repo, pr.number, null);
        if (!open || !open.branch) {
            return send(res, 409, {
                error: 'pr-unknown',
                message: `#${pr.number} is not in the pull request list yet — try again in a minute`,
            });
        }
        if (open.state && open.state !== 'OPEN') {
            return send(res, 409, { error: 'pr-closed', message: `#${pr.number} is no longer open` });
        }
        const cwd = await checkoutOf(pr.repo, pr.number, hint);
        if (!cwd) {
            return send(res, 409, {
                error: 'no-checkout',
                message: `no checkout of ${pr.repo} is known on this machine`,
            });
        }

        // The app's default mode, as a session started with none named gets.
        const mode = normalizeMode(body.permissionMode);
        const refusal = modeRefusal(mode, who);
        if (refusal) return send(res, 403, { error: refusal, remote: true });

        let found;
        try {
            found = await worktreeForBranch(cwd, open.branch);
        } catch (err) {
            return send(res, 400, { error: err.message, code: err.code || 'git-failed' });
        }
        if (found && found.main) {
            return send(res, 409, {
                error: 'branch-in-main-checkout',
                message: `${open.branch} is checked out in the main checkout — switch it away, or fix it there yourself`,
                path: found.path, branch: open.branch,
            });
        }
        if (found) {
            const busy = liveSessionIn(found.path);
            if (busy) {
                return send(res, 409, {
                    error: 'worktree-in-use',
                    message: `${busy.title ? `"${busy.title}"` : 'Another session'} is working in ${found.path}`,
                    path: found.path, branch: open.branch, sessionId: busy.sessionId,
                });
            }
            const st = await git.workingState(found.path);
            if (st && st.dirty) {
                return send(res, 409, {
                    error: 'worktree-dirty',
                    message: `${found.path} has uncommitted changes — commit or discard them first`,
                    path: found.path, branch: open.branch,
                });
            }
        } else if (who.remote) {
            return send(res, 403, {
                error: 'a worktree cannot be created remotely — start it at the machine itself',
                remote: true,
            });
        }

        if (tooManyCreates()) {
            return send(res, 429, {
                error: `more than ${CREATE_LIMIT.max} sessions started in a minute — `
                    + 'slow down, or start the rest from the machine itself',
            });
        }

        let worktree;
        if (found) {
            worktree = { path: found.path, branch: open.branch, created: false };
        } else {
            try {
                const made = await checkoutWorktree(cwd, `pr-${pr.number}`, open.branch,
                    { allow: (p) => cfg.withinRoots(p) });
                worktree = { ...made, created: true };
            } catch (err) {
                const status = err.code === 'fetch-failed' ? 409 : 400;
                return send(res, status, { error: err.code || 'git-failed', message: err.message });
            }
        }

        const prompt = prReviews.fixPrompt({
            pr: { url: open.url, title: open.title, number: pr.number },
            review, findings, branch: open.branch,
        });
        try {
            const out = pool.create({ cwd: worktree.path, prompt, permissionMode: mode });
            flags.set(out.sessionId, {
                title: sessionTitle(pr.number, findings),
                ...(body.test ? { test: true } : {}),
            });
            index.note(out.sessionId);
            broadcast('sessions-changed', { at: Date.now() });
            return send(res, 200, { ...out, test: !!body.test, worktree, findings: findings.length });
        } catch (err) {
            return send(res, 400, { error: err.message, worktree });
        }
    }

    return NEXT;
}

module.exports = { init, handle, sessionTitle };
