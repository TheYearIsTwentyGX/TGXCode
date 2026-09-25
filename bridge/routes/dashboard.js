'use strict';

// Work in flight across every project: `/api/dashboard` (uncommitted changes and
// unmerged pull requests) and `/api/prs`. The board is built by
// bridge/dashboard.js, and pull requests come from the store bridge/pr-refresh.js
// keeps filled — so neither asks GitHub, except the board's `?refresh=1`, which
// forces a pass of the refresher out of turn.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const cfg = require('../config');
const dashboard = require('../dashboard');
const { NEXT, send } = require('../http');
const pulls = require('../pulls');
const { prsPayload, tickPrs } = require('../pr-refresh');

// Handed over by server.js — see the note above ROUTES there.
let index = null;
let pool = null;

function init(deps) {
    ({ index, pool } = deps);
}

async function handle(req, res, url, pathname, seg, who) {
    // Work in flight: uncommitted changes and unmerged pull requests, by project.
    // Still shells out to git — a working tree can only be read by looking at it —
    // but no longer to gh: pull requests come from the store the refresher fills.
    //
    // `?refresh=1` is the board's Refresh button. It drops the working-tree cache
    // *and* forces a pass of the refresher, which is the only way to ask GitHub
    // out of turn. Awaited, because the whole point of the press is to see the
    // answer it produces.
    if (pathname === '/api/dashboard' && req.method === 'GET') {
        const refresh = url.searchParams.get('refresh') === '1';
        if (refresh) {
            await tickPrs({ force: true }).catch(err => console.error(
                `[tgxcode] forced PR refresh failed: ${err.message}`));
        }
        const data = await dashboard.build(index, {
            includeTest: cfg.IS_DEV,
            refresh,
        });
        // The same live status the rail carries, so a row can say that one of
        // its sessions is working right now rather than looking abandoned.
        const statuses = pool.statuses();
        for (const p of data.projects) {
            for (const w of p.workspaces) {
                for (const s of w.sessions) {
                    const st = statuses[s.sessionId];
                    if (st) {
                        s.runner = { state: st.state, activity: st.activity,
                            detail: st.detail, queued: st.queued, claudeVersion: st.claudeVersion };
                    }
                }
            }
        }
        return send(res, 200, data);
    }

    // One PR status per session, for the rail. The same question the conversation
    // header asks about one session, asked about all of them at once — and reduced
    // to a single word each, because a rail row has space for one glyph.
    //
    // It reads the store and answers immediately; the only thing that asks GitHub
    // is `tickPrs`. It stays its own route rather than becoming a field on
    // `/api/sessions` because it is also the payload of `prs-changed`, and because
    // a client that has not received an event yet needs somewhere to start.
    if (pathname === '/api/prs' && req.method === 'GET') {
        return send(res, 200, await prsPayload());
    }

    // Where a project's `origin` lives, as a page to open — the rail's ⋮ menu.
    // Asked on demand rather than carried on every session: it is one menu's
    // question, and `git remote` is memoised for ten minutes in pulls.js, so a
    // remote you just changed can take that long to show.
    if (pathname === '/api/origin' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd') || '';
        if (!cfg.withinRoots(cwd)) {
            return send(res, 403, { error: 'that directory is outside the allowed roots' });
        }
        return send(res, 200, { url: await pulls.originUrlOf(cwd) });
    }

    return NEXT;
}

module.exports = { init, handle };
