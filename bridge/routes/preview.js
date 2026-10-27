'use strict';

// `/api/preview/*`: an agent driving the browser preview. The store and the open
// handshake are bridge/preview-agent.js; the endpoint itself is the shell's,
// app/preview-cdp.js.
//
//   GET    /api/preview/agent        whether it is on, and whether a window registered
//   POST   /api/preview/agent        a window registers its endpoint {endpoint}
//   DELETE /api/preview/agent        a window withdraws it
//   POST   /api/preview/open         open_in_preview: {url, sessionId} -> {ok, outcome, url, error?}
//   POST   /api/preview/open/:id     a window's answer to `preview-open`: {pending} or {ok, outcome, error?}
//
// All local-only, and that is remoteRefusal() in server.js: the endpoint is a way
// to drive a page on this desktop, and the page is somebody's dev server.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract.

const { NEXT, readJson, send } = require('../http');
const previewAgent = require('../preview-agent');
const events = require('../events');

// Handed over by server.js — see the note above ROUTES there.
let prefs = null;

function init(deps) {
    ({ prefs } = deps);
}

// What open_in_preview's answer is, as a status. `waiting` is a 202 because the
// request stands: the page opens when the user allows it.
const OPEN_STATUS = { opened: 200, waiting: 202, denied: 403, 'no-window': 503 };

function enabled() {
    try { return prefs.forCwd().preview.agentControl === true; } catch { return false; }
}

async function handle(req, res, url, pathname, seg) {
    if (seg[1] !== 'preview') return NEXT;

    if (seg[2] === 'agent' && !seg[3]) {
        if (req.method === 'GET') {
            const r = previewAgent.read();
            return send(res, 200, { enabled: enabled(), registered: Boolean(r), at: r ? r.at : null });
        }
        if (req.method === 'POST') {
            const body = await readJson(req);
            // Registered whatever the setting says: the window reads the same
            // setting, and a race between a save and this post should not lose
            // the endpoint. What gates use is the session's spawn, which reads
            // the setting itself.
            const r = previewAgent.register(body && body.endpoint);
            return send(res, r.ok ? 200 : 400, r);
        }
        if (req.method === 'DELETE') {
            previewAgent.clear();
            return send(res, 200, { ok: true });
        }
        return NEXT;
    }

    if (seg[2] === 'open' && !seg[3] && req.method === 'POST') {
        if (!enabled()) {
            return send(res, 409, {
                error: 'agent control of the preview is off. The user can turn it on in '
                    + 'Settings → Browser preview → Let agents drive the preview.',
            });
        }
        const body = await readJson(req);
        const u = previewAgent.checkOpenUrl(body && body.url);
        if (!u.ok) return send(res, 400, { error: u.error });
        const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.slice(0, 80) : null;
        const result = await previewAgent.requestOpen({ url: u.url, sessionId }, events.broadcast, events.clients.size);
        if (!result.url) result.url = u.url;
        return send(res, OPEN_STATUS[result.outcome] || (result.ok ? 200 : 409), result);
    }

    if (seg[2] === 'open' && seg[3] && !seg[4] && req.method === 'POST') {
        const body = await readJson(req);
        const taken = previewAgent.answerOpen(seg[3], body || {});
        return send(res, taken ? 200 : 404, taken ? { ok: true } : { error: 'nobody is waiting for that' });
    }

    return NEXT;
}

module.exports = { init, handle };
