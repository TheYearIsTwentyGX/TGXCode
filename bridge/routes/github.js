'use strict';

// Publishing a directory to GitHub, and cloning a repository from it:
// `/api/github/*`. The work is in bridge/github.js and bridge/github-clone.js. This file does the checks every directory-taking route does
// (allowed roots) and turns a `Refusal` into its status code.
//
// Only the two POSTs write anything, and both are refused to remote callers in
// server.js's `remoteRefusal`: publish creates a repository under your account
// and pushes from this machine, clone writes a repository onto its disk. The
// GETs stay open because they only read — the repository list included, which
// is what `gh` already shows to anyone holding the token.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract.

const path = require('path');

const cfg = require('../config');
const github = require('../github');
const clone = require('../github-clone');
const { NEXT, send, readJson } = require('../http');

function dirParam(raw) {
    const dir = raw ? path.resolve(cfg.expandHome(raw)) : '';
    return dir && cfg.withinRoots(dir) ? dir : null;
}

const OUTSIDE = { error: 'that directory is outside the allowed roots' };

async function handle(req, res, url, pathname) {
    if (!pathname.startsWith('/api/github/')) return NEXT;
    const q = url.searchParams;

    if (pathname === '/api/github/account' && req.method === 'GET') {
        return send(res, 200, await github.account({ refresh: q.get('refresh') === '1' }));
    }

    if (pathname === '/api/github/templates' && req.method === 'GET') {
        return send(res, 200, await github.templates());
    }

    if (pathname === '/api/github/teams' && req.method === 'GET') {
        const org = q.get('org') || '';
        if (!/^[A-Za-z0-9-]+$/.test(org)) return send(res, 400, { error: 'org is required' });
        return send(res, 200, { teams: await github.teams(org) });
    }

    if (pathname === '/api/github/repo-state' && req.method === 'GET') {
        const cwd = dirParam(q.get('cwd'));
        if (!cwd) return send(res, 403, OUTSIDE);
        return send(res, 200, await github.repoState(cwd));
    }

    if (pathname === '/api/github/name' && req.method === 'GET') {
        const owner = q.get('owner') || '';
        const name = q.get('name') || '';
        const problem = github.repoNameProblem(name)
            || (/^[A-Za-z0-9-]+$/.test(owner) ? null : 'an owner is required');
        return send(res, 200, {
            problem,
            taken: problem ? null : await github.nameTaken(owner, name),
        });
    }

    if (pathname === '/api/github/publish' && req.method === 'POST') {
        const body = await readJson(req);
        const cwd = dirParam(body.cwd);
        if (!cwd) return send(res, 403, OUTSIDE);
        try {
            return send(res, 200, await github.publish(cwd, body));
        } catch (err) {
            if (err instanceof github.Refusal) return send(res, err.status, { error: err.message });
            throw err;
        }
    }

    // --- cloning -----------------------------------------------------------

    if (pathname === '/api/github/repos' && req.method === 'GET') {
        return send(res, 200, await clone.repos({
            q: q.get('q') || '',
            offset: q.get('offset'),
            limit: q.get('limit'),
            refresh: q.get('refresh') === '1',
        }));
    }

    if (pathname === '/api/github/resolve' && req.method === 'GET') {
        return send(res, 200, await clone.resolve(q.get('input') || '', { branch: q.get('branch') }));
    }

    if (pathname === '/api/github/clone-target' && req.method === 'GET') {
        const parent = q.get('parent');
        const base = clone.defaultParent();
        if (!parent) return send(res, 200, { defaultParent: base });
        const t = await clone.checkDestination({
            parent, name: q.get('name') || '', allowNested: q.get('allowNested') === '1',
        });
        return send(res, 200, {
            defaultParent: base, parent: t.parent, name: t.name, path: t.path,
            problem: t.problem, nested: t.nested, exists: t.exists,
        });
    }

    if (pathname === '/api/github/clone' && req.method === 'POST') {
        const body = await readJson(req);
        try {
            return send(res, 200, await clone.clone(body));
        } catch (err) {
            if (err instanceof github.Refusal) return send(res, err.status, { error: err.message });
            throw err;
        }
    }

    return NEXT;
}

module.exports = { handle };
