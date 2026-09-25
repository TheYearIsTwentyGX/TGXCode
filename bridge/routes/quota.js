'use strict';

// `/api/quota` and `/api/quota/refresh`: how much of the usage windows is gone,
// and running the beacon now to find out. The payload and the beacon's
// bookkeeping stay in server.js beside the timer that also runs it, and are
// handed over through `init`, so the button and the clock cannot drift apart.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const { NEXT, send } = require('../http');

// Handed over by server.js — see the note above ROUTES there.
let beacon = null;
let quotaPayload = null;
let quotaPrefs = null;
let runBeaconNow = null;

function init(deps) {
    ({ beacon, quotaPayload, quotaPrefs, runBeaconNow } = deps);
}

async function handle(req, res, url, pathname, seg, who) {
    // How much of the quota is gone. Deliberately open to a remote caller: it
    // carries no filesystem detail and names no session, and "release the work
    // from a phone when quota frees up" is a case the drafts routes are already
    // open for. The snapshot is cheap — one stat of a small file, and everything
    // else is in memory — so it needs no caching beyond the one in usage.js.
    if (pathname === '/api/quota' && req.method === 'GET') {
        return send(res, 200, quotaPayload());
    }

    // Refresh the percentage now, because the automatic clock is twenty minutes
    // and "how much is left" is a question people ask at the moment they need
    // the answer.
    //
    // It runs the beacon rather than doing anything new: the percentage lives in
    // the status line, and being a TUI for a few seconds remains the only way to
    // make one render. So this is the same operation the timer performs, on
    // demand — which is why it shares runBeaconNow() and pushes the interval out
    // just the same. Clicking Refresh should not be followed by an automatic run
    // a minute later.
    //
    // Deliberately allowed on a dev bridge, unlike the timer. The dev gate is
    // about a worktree bridge quietly spending quota to measure quota on a clock
    // nobody asked about; a person pressing a button has asked.
    //
    // The response is the whole quota payload rather than an acknowledgement, so
    // one round trip both runs the refresh and returns what it produced —
    // including `beacon.ok` and `beacon.reason`, which is what a client draws
    // when a run was blocked by a dialog.
    if (pathname === '/api/quota/refresh' && req.method === 'POST') {
        const q = quotaPrefs();
        if (!q.beaconDir) {
            // Not an error the user can retry past, so it says what to do. 409
            // rather than 400: the request is fine, the machine is not set up.
            return send(res, 409, {
                error: 'no quota beacon directory is configured',
                needsSetup: true,
                quota: quotaPayload(),
            });
        }
        if (beacon.busy) {
            // Not a failure. Somebody double-clicked, or the timer is mid-run,
            // and either way a reading is already on its way.
            return send(res, 409, {
                error: 'a refresh is already running',
                running: true,
                quota: quotaPayload(),
            });
        }

        // `quota.beacon` being false is not checked. That preference governs the
        // automatic clock — "do this every twenty minutes without me" — and a
        // machine that has named a trusted directory but left the timer off is
        // exactly the one where a manual refresh is the point.
        const out = await runBeaconNow(q.beaconDir);
        return send(res, 200, { ok: out.ok === true, quota: quotaPayload() });
    }

    return NEXT;
}

module.exports = { init, handle };
