'use strict';

// `GET /api/digest?since=<ms>`: what happened while you were away. The assembly
// is bridge/digest.js and is pure; this gathers its inputs from the stores the
// bridge already keeps, and decides nothing.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own.

const cfg = require('../config');
const { NEXT, send } = require('../http');
const { buildDigest } = require('../digest');
const { MAX_AGE_MS } = require('../notifications');
const { scheduleTitle } = require('../schedule');
const prStore = require('../pr-store');

// Handed over by server.js — see the note above ROUTES there.
let index = null;
let pool = null;
let flags = null;
let standing = null;
let schedules = null;
let notifications = null;
let orchestrators = null;

function init(deps) {
    ({ index, pool, flags, standing, schedules, notifications, orchestrators } = deps);
}

async function handle(req, res, url, pathname, seg, who) {
    // Open to a remote caller, like /api/notifications: it is the same rows,
    // regrouped, and a phone coming back to the app is the other client this was
    // designed for.
    if (pathname === '/api/digest' && req.method === 'GET') {
        const now = Date.now();
        const raw = url.searchParams.get('since');
        const since = Number(raw);
        // Refused rather than clamped. A missing or garbled `since` is a client
        // bug, and quietly answering "the last fortnight" would hide it behind a
        // card that looks plausible. Older than the log keeps is refused for the
        // same reason: the answer would be silently incomplete.
        if (raw === null || raw === '' || !Number.isInteger(since)) {
            return send(res, 400, { error: 'since must be an epoch-millisecond integer' });
        }
        if (since > now) return send(res, 400, { error: 'since is in the future' });
        if (since < now - MAX_AGE_MS) {
            return send(res, 400, {
                error: 'since is older than the notification log keeps',
                oldest: now - MAX_AGE_MS,
            });
        }

        // Same rule as /api/notifications: a scratch session belongs to the
        // instance that started it.
        const includeTest = cfg.IS_DEV;
        const isTest = includeTest ? () => false : (id) => Boolean(id && flags.get(id).test);
        const orchs = orchestrators && orchestrators.byId
            ? [...orchestrators.byId.values()] : [];
        return send(res, 200, buildDigest({
            since,
            now,
            rows: notifications.since(since, { includeTest }),
            statuses: pool.statuses(),
            schedules: schedules.list().filter(s => includeTest || !s.test),
            suggestions: index.listSuggestions({ includeTest, limit: 500 }),
            orchestrators: orchs,
            prs: prStore.snapshot(),
            describe: (id) => index.summary(id),
            standingFor: (id) => standing.forSession(id),
            isTest,
            scheduleTitle,
        }));
    }
    return NEXT;
}

module.exports = { init, handle };
