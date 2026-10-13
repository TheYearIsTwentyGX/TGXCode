'use strict';

// The worktree janitor: `/api/worktrees*`. The work is in bridge/worktrees.js.
// This file validates the directory the way every directory-taking route does
// (allowed roots, exists), gathers the sessions and runners the safety test
// needs, and turns a refusal into a per-path result.
//
// The GET only reads and stays open to remote callers. The removal is refused to
// them twice. server.js's `remoteRefusal` refuses the exact path, and so does the
// `who.remote` test below. A removal deletes a directory on this machine, and
// nobody off it is looking at that directory.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract.

const cfg = require('../config');
const pulls = require('../pulls');
const worktrees = require('../worktrees');
const { NEXT, send, readJson } = require('../http');
const { resolveWorkdir } = require('../runner');

let index = null;
let pool = null;

function init(deps) { ({ index, pool } = deps); }

// A cap on one bulk removal, so a malformed body cannot keep git busy for an hour.
const MAX_PATHS = 100;

function ctx() {
    return {
        sessions: index.list({ includeTest: true, limit: 100_000 }),
        runners: pool.statuses(),
        allow: (p) => cfg.withinRoots(p),
    };
}

async function handle(req, res, url, pathname, seg, who) {
    if (pathname !== '/api/worktrees' && !pathname.startsWith('/api/worktrees/')) return NEXT;

    if (pathname === '/api/worktrees' && req.method === 'GET') {
        let dir;
        try { dir = resolveWorkdir(url.searchParams.get('cwd')); } catch (err) {
            return send(res, 400, { error: err.message });
        }
        if (url.searchParams.get('refresh') === '1') {
            const repo = await pulls.repoOf(dir);
            if (repo) worktrees.forgetPulls(repo);
        }
        try {
            return send(res, 200, await worktrees.survey(dir, ctx()));
        } catch (err) {
            return send(res, 400, { error: err.message, code: err.code || null });
        }
    }

    if (pathname === '/api/worktrees/remove' && req.method === 'POST') {
        if (who.remote) {
            return send(res, 403, { error: 'worktrees can only be removed at the machine they live on', remote: true });
        }
        const body = await readJson(req);
        let dir;
        try { dir = resolveWorkdir(body.cwd); } catch (err) {
            return send(res, 400, { error: err.message });
        }
        const paths = Array.isArray(body.paths) ? body.paths : [];
        if (!paths.length || paths.length > MAX_PATHS || !paths.every(p => typeof p === 'string' && p)) {
            return send(res, 400, { error: `paths must be 1–${MAX_PATHS} worktree paths` });
        }
        const c = ctx();
        const results = [];
        // One at a time: each removal changes `git worktree list`, and the next
        // check should see the repository as it now is.
        for (const p of paths) {
            try {
                results.push(await worktrees.removeWorktree(dir, p, c));
            } catch (err) {
                results.push({
                    path: p, removed: false, branchDeleted: false, branchKept: false,
                    error: err.message, code: err.code || 'failed', reasons: err.reasons || [],
                });
            }
        }
        return send(res, 200, { results });
    }

    return NEXT;
}

module.exports = { init, handle };
