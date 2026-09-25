'use strict';

// Things on this machine that are not the app: dev servers (who owns a port, and
// stopping one), DevBrowser's tabs, and Wispr Flow's shortcuts.
//
// **Mostly refused remotely**, by remoteRefusal() before `api()`: stopping a dev
// server, every `/api/devbrowser` route, and pressing a Wispr chord. What stays
// open is reading who owns a port and whether Wispr is there — and the latter
// says `available: false` to a remote caller, beside the route.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const cfg = require('../config');
const devbrowser = require('../devbrowser');
const devservers = require('../devservers');
const { NEXT, readJson, send } = require('../http');
const wispr = require('../wispr');

// Handed over by server.js — see the note above ROUTES there.
let prefs = null;

function init(deps) {
    ({ prefs } = deps);
}

const STOP_STATUS = { protected: 403, 'no-owner': 409, 'not-permitted': 403 };

/** Why a stop did not happen, in words the chip can put in a toast. */
function stopMessage(out, port) {
    if (out.reason === 'protected') return `:${port} is ${out.what} — left alone`;
    if (out.reason === 'no-owner') {
        return out.listening
            ? `Something answers on :${port} but no Linux process owns it — it may be running on Windows`
            : `Nothing is listening on :${port}`;
    }
    if (out.reason === 'not-permitted') return `Not allowed to signal the process on :${port}`;
    return `:${port} is still listening after SIGKILL`;
}

async function handle(req, res, url, pathname, seg, who) {
    // --- dev servers -------------------------------------------------------
    // Both of these are keyed by port, not by session: the chip is offered
    // because this session started the server, but what answers on the port —
    // and what ends up killed — is whoever holds the socket now, which is the
    // only thing that can be checked for real.

    // Who holds a port, so a chip about to stop one can say whose process it is.
    // Ports get reused across worktrees; the pid and command line are the only
    // things that tell you the server is still the one you meant.
    if (pathname === '/api/devservers/owner' && req.method === 'GET') {
        const port = Number(url.searchParams.get('port'));
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            return send(res, 400, { error: 'invalid port' });
        }
        const [owners, listening] = await Promise.all([
            devservers.owners(port), devservers.isListening(port),
        ]);
        return send(res, 200, { port, listening, owners });
    }

    if (pathname === '/api/devservers/stop' && req.method === 'POST') {
        const body = await readJson(req);
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            return send(res, 400, { error: 'invalid port' });
        }
        // The same list that keeps a port out of the chip row keeps it from being
        // killed through one — this bridge's own port included.
        if (cfg.PORT_DENYLIST.has(port)) {
            return send(res, 403, { error: `:${port} is not a dev server this app will stop` });
        }
        const out = await devservers.stop(port);
        if (out.ok) return send(res, 200, out);
        return send(res, STOP_STATUS[out.reason] || 502, { ...out, error: stopMessage(out, port) });
    }

    // --- devbrowser --------------------------------------------------------
    if (pathname === '/api/devbrowser/status' && req.method === 'GET') {
        const [health, tls] = await Promise.all([devbrowser.health(), devbrowser.titles()]);
        return send(res, 200, { ...health, titles: tls });
    }

    if (pathname === '/api/devbrowser/open' && req.method === 'POST') {
        const body = await readJson(req);
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return send(res, 400, { error: 'invalid port' });
        }
        // Name the tab on the way in when the transcript told us what it is —
        // DevBrowser identifies tabs by port alone, so an unnamed one is just a
        // number in a wall of numbers.
        if (body.title) {
            try { await devbrowser.setTitle(port, String(body.title).slice(0, 64)); } catch { /* best effort */ }
        }
        // `ifClosed: 'none'` asks for no launch. Not running is then an answer,
        // not an error — 200 with `running: false` — so the client can fall
        // back to its own preview without parsing a 502.
        const launch = body.ifClosed !== 'none';
        const out = await devbrowser.openTab(port, body.path || null, { launch });
        if (out.running === false) return send(res, 200, out);
        return send(res, out.ok ? 200 : 502, out);
    }

    if (pathname === '/api/devbrowser/title' && req.method === 'POST') {
        const body = await readJson(req);
        const port = Number(body.port);
        if (!Number.isInteger(port)) return send(res, 400, { error: 'invalid port' });
        const r = await devbrowser.setTitle(port, body.title == null ? null : String(body.title));
        return send(res, r.ok ? 200 : 502, { ok: r.ok });
    }

    // --- wispr flow --------------------------------------------------------
    // Whether the composer's Wispr button should be drawn at all. The answer is
    // about *this caller*: a remote one is refused the press below, so for it
    // there is nothing to draw, even on a host where the press would work.
    if (pathname === '/api/wispr' && req.method === 'GET') {
        return send(res, 200, { available: wispr.available() && !who.remote });
    }

    // By id and never by chord: the chord comes out of the user's own settings,
    // so a caller can press what the user set up and nothing else. See
    // bridge/wispr.js.
    if (pathname === '/api/wispr/press' && req.method === 'POST') {
        const body = await readJson(req);
        if (!wispr.available()) {
            return send(res, 409, { error: 'Wispr Flow shortcuts need the Windows host', available: false });
        }
        const found = prefs.forCwd('').wispr.transforms.find(t => t.id === body.id);
        if (!found) return send(res, 404, { error: 'no such transform' });
        const out = await wispr.press(found.combo);
        if (!out.ok) return send(res, 502, { error: out.error });
        return send(res, 200, { ok: true, combo: found.combo });
    }

    return NEXT;
}

module.exports = { init, handle };
