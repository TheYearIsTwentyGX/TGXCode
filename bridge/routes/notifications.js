'use strict';

// The notification history: `GET /api/notifications`, marking it read, and
// clearing it. The log and the read watermarks are bridge/notifications.js;
// what is filed, and when, is decided by the wiring in server.js.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const cfg = require('../config');
const { broadcast } = require('../events');
const { NEXT, readJson, send } = require('../http');

// Handed over by server.js — see the note above ROUTES there.
let notifications = null;
let reads = null;

function init(deps) {
    ({ notifications, reads } = deps);
}

async function handle(req, res, url, pathname, seg, who) {
    // --- notification history ---------------------------------------------
    if (pathname === '/api/notifications' && req.method === 'GET') {
        return send(res, 200, {
            // Counted over the whole log rather than over the page below it.
            // The badge used to be worked out client-side from whatever had been
            // fetched, so it quietly saturated at the fetch limit — a number
            // that stops being true when it gets large is worse than no number.
            unread: notifications.countUnread(r => reads.isRead(r), { includeTest: cfg.IS_DEV }),
            read: reads.get(),
            notifications: notifications.list({
                limit: Math.min(Number(url.searchParams.get('limit')) || 200, 1000),
                // 'notable' is the default view: the entries that cleared the bar
                // for interrupting somebody. 'all' also has the quiet ones — a
                // six-second turn, a subagent finishing — which nothing ever
                // notified about but which answer "what has been going on".
                scope: url.searchParams.get('scope') === 'all' ? 'all' : 'notable',
                type: url.searchParams.get('type') || null,
                sessionId: url.searchParams.get('sessionId') || null,
                // Same rule as /api/sessions: a scratch session belongs to the
                // instance that started it.
                includeTest: cfg.IS_DEV,
            // `read` is derived per caller rather than stored on the row: the
            // row is one thing that happened, and whether it is news is a
            // question about the reader. Stamped here so a client need not
            // reimplement the watermark comparison to render a list.
            }).map(row => ({ ...row, read: reads.isRead(row) })),
        });
    }

    if (pathname === '/api/notifications/read' && req.method === 'POST') {
        const body = await readJson(req);
        // `all` and a session id are two different gestures, not one with a flag:
        // opening History says "I have seen everything", opening a chat says "I
        // have seen this conversation". Neither is not a third gesture, so it is
        // refused rather than treated as a no-op — a client that meant to send
        // one and sent nothing should hear about it.
        const wantsAll = body.all === true || Number.isFinite(body.all);
        const sessionId = wantsAll ? null : String(body.sessionId || '');
        if (sessionId === '') {
            return send(res, 400, { error: 'send either {all:true} or {sessionId}' });
        }
        // `all` may name the instant instead of meaning "now", which is what a
        // client migrating an older watermark of its own needs — it knows when it
        // last looked and that is not now. Clamped, because a mark in the future
        // would silence everything filed between here and then, and no honest
        // caller wants that.
        const now = Date.now();
        const at = Number.isFinite(body.all) ? Math.min(Number(body.all), now) : now;
        // `moved` is whether the badge changed, not whether a timestamp did.
        // Every repeat of this call advances the watermark by however long it has
        // been, so a timestamp almost always moves and says nothing; a loud row
        // going from unread to read is the only thing another window would have
        // to repaint for. Every navigation in the UI comes through here, so the
        // difference is a broadcast per rail click against a broadcast per thing
        // actually dealt with.
        const count = () =>
            notifications.countUnread(r => reads.isRead(r), { includeTest: cfg.IS_DEV });
        const before = count();
        if (sessionId === null) reads.markAll(at);
        else reads.markSession(sessionId, at);
        const unread = count();
        const moved = unread !== before;
        if (moved) broadcast('notification-read', { sessionId, at, unread });
        return send(res, 200, { ok: true, moved, unread, read: reads.get() });
    }

    if (pathname === '/api/notifications' && req.method === 'DELETE') {
        notifications.clear();
        broadcast('notifications-cleared', { at: Date.now() });
        return send(res, 200, { ok: true });
    }

    return NEXT;
}

module.exports = { init, handle };
