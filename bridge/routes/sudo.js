'use strict';

// Sudo approval: the askpass helper's ask, and the user's answer to it. The
// design, what was measured and the threat model are in bridge/sudo.js.
//
//   POST /api/sudo/ask         the helper, authenticated by its session key —
//                              *not* by the bridge token, which the helper never
//                              has. Answered only once the user has. Reached from
//                              server.js's request handler ahead of the token
//                              check, which is why it is `helperAsk` and not in
//                              `handle`.
//   GET  /api/sudo             what is waiting, and the two settings.
//   POST /api/sudo/:id/answer  {password} — this machine only, unless
//                              `sudo.allowRemote` is on.
//   POST /api/sudo/:id/deny    from anywhere: refusing grants nothing.
//
// The password is read from the answer's body and handed to the waiting helper's
// response, and that is all that is done with it: it is not logged, broadcast,
// stored, or echoed in an error.

const { NEXT, readJson, send } = require('../http');
const auth = require('../auth');
const { KEY_HEADER, keySession, readAsk } = require('../sudo');

let prefs = null;
let pool = null;
let sudoAsks = null;
let procRoot = '/proc';

function init(deps) {
    ({ prefs, pool, sudoAsks } = deps);
    if (deps.sudoProcRoot) procRoot = deps.sudoProcRoot;
}

function settings() {
    try {
        const s = prefs.forCwd().sudo || {};
        return { enabled: s.enabled === true, allowRemote: s.allowRemote === true };
    } catch { return { enabled: false, allowRemote: false }; }
}

const MAX_PASSWORD = 4096;

/**
 * The helper asking. Holds the response open until the ask is settled, and
 * cancels the ask if the helper hangs up first — which is what a stopped Bash
 * call looks like from here.
 */
async function helperAsk(req, res, who) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (who.remote) return send(res, 403, { error: 'local callers only', remote: true });
    if (!settings().enabled) {
        return send(res, 403, { error: 'sudo approval is switched off in TGXCode Settings › Sudo' });
    }
    const key = String(req.headers[KEY_HEADER] || '');
    const sessionId = keySession(auth.current(), key);
    if (!sessionId) return send(res, 401, { error: 'not a TGXCode session key' });

    let body;
    try { body = await readJson(req); } catch (err) { return send(res, 400, { error: err.message }); }
    let info;
    try { info = readAsk(Number(body && body.pid), key, { procRoot }); } catch (err) {
        return send(res, err.status || 403, { error: err.message });
    }
    // Nobody to ask: the same rule a permission prompt follows, and the same
    // reason — an unattended run would otherwise sit until its Bash call timed out.
    if (pool && pool.hasViewer && !pool.hasViewer(sessionId)) {
        return send(res, 200, { denied: true, reason: 'nobody is watching TGXCode to approve it' });
    }

    let settled = false;
    const ask = sudoAsks.open(sessionId, info, (result) => {
        settled = true;
        if (!res.writableEnded && !res.destroyed) send(res, 200, result);
    });
    res.on('close', () => { if (!settled) sudoAsks.cancel(ask.id, 'sudo exited'); });
}

async function handle(req, res, url, pathname, seg, who) {
    if (seg[1] !== 'sudo') return NEXT;

    if (pathname === '/api/sudo' && req.method === 'GET') {
        return send(res, 200, { ...settings(), asks: sudoAsks.list() });
    }

    const id = seg[2];
    const verb = seg[3];
    if (!id || seg.length !== 4 || req.method !== 'POST') return NEXT;

    if (verb === 'deny') {
        if (!sudoAsks.get(id)) return send(res, 409, { error: 'that sudo ask was already answered or has gone' });
        sudoAsks.deny(id, 'denied');
        return send(res, 200, { ok: true });
    }

    if (verb === 'answer') {
        if (who.remote && !settings().allowRemote) {
            return send(res, 403, { error: 'sudo can only be approved at the desktop — '
                + 'Settings › Sudo › allow the phone to answer', remote: true });
        }
        let body;
        try { body = await readJson(req); } catch (err) { return send(res, 400, { error: err.message }); }
        const password = body && body.password;
        // A newline would end the line sudo reads early; anything past it would
        // be thrown away and the password it did read would be wrong.
        if (typeof password !== 'string' || password.length > MAX_PASSWORD || /[\r\n\0]/.test(password)) {
            return send(res, 400, { error: 'password must be one line of text' });
        }
        if (!sudoAsks.get(id)) return send(res, 409, { error: 'that sudo ask was already answered or has gone' });
        sudoAsks.approve(id, password);
        return send(res, 200, { ok: true });
    }

    return NEXT;
}

module.exports = { init, handle, helperAsk, settings };
