'use strict';

// `GET /api/search` — full text across every session's transcript. The index
// and the matching are bridge/search-index.js; this is the request and the
// filters around it.
//
// Test sessions are left out on the everyday bridge and kept on a development
// one, exactly as `/api/dashboard` decides it, and temporary sessions are left
// out everywhere: both come from SessionIndex.searchCandidates, which is list()
// without a query, so a search can never show a session the rail would not.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract.

const cfg = require('../config');
const { NEXT, send } = require('../http');
const { search } = require('../search-index');

// Handed over by server.js — see the note above ROUTES there.
let index = null;
let warmer = null;

function init(deps) {
    ({ index, searchWarmer: warmer } = deps);
}

const KINDS = new Set(['user', 'assistant', 'tool']);
const Q_MAX = 200;

async function handle(req, res, url, pathname) {
    if (pathname !== '/api/search' || req.method !== 'GET') return NEXT;
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return send(res, 400, { error: 'q is required' });
    if (q.length > Q_MAX) return send(res, 400, { error: `q is longer than ${Q_MAX} characters` });
    const kinds = String(url.searchParams.get('kinds') || 'user,assistant')
        .split(',').map(k => k.trim()).filter(k => KINDS.has(k));
    const candidates = index.searchCandidates({
        project: url.searchParams.get('project') || null,
        includeTest: cfg.IS_DEV,
    });
    const out = search(index.searchIndex, candidates, {
        q, kinds,
        limit: url.searchParams.get('limit'),
        perSession: url.searchParams.get('perSession'),
    });
    // Whatever the budget left behind, the warmer picks up now rather than
    // after its idle sleep, so asking again shortly finds more.
    if (out.pending && warmer) warmer.poke();
    return send(res, 200, out);
}

module.exports = { init, handle };
