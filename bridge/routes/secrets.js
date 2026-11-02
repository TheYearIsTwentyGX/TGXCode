'use strict';

// Secrets: what a project has, the agent's ask for one, your answer, and the
// wrapper's fetch. The design and its limits are in bridge/secrets.js.
//
//   GET    /api/secrets?cwd=               names and dates, never values; and the open asks
//   POST   /api/secrets/ask                the request_secret tool. Held open until answered
//   POST   /api/secrets/asks/:id/answer    {value} — this machine, or a phone once
//                                          `secrets.allowRemote` is on
//   POST   /api/secrets/asks/:id/deny      from anywhere: refusing grants nothing
//   PUT    /api/secrets/:NAME              {cwd, value} — this machine only
//   DELETE /api/secrets/:NAME?cwd=         this machine only
//   POST   /api/secrets/:NAME/reveal       {cwd} — this machine only; the Settings page's eye
//   POST   /api/secrets/resolve            {cwd, names, sessionId} — bridge/secret-exec.js
//
// Every route is behind the token like any other. Those that carry a value are
// refused to a remote caller here *and* in server.js's remoteRefusal, and none
// of them logs a body or echoes a value in an error. A value travels in exactly
// three directions: from your answer into the store, from the store to the
// wrapper, and from the store to the Settings page when you press Reveal.
//
// **The answer is the one exception, and it is narrow.** It writes one value, to
// the name and project a pending ask already named, and returns nothing a caller
// did not have. A phone's answer has to clear three things before its body is even
// read: `secrets.allowRemote`, off until you switch it on at the desk because a
// tunnel's operator can read what crosses it (docs/remote.md); a connection that
// arrived encrypted; and an ask still pending. And it never replaces a value: a
// name set since the ask was raised stays as it is, or an open ask would be a way
// to overwrite what `PUT` refuses to.

const path = require('path');

const { NEXT, readJson, send } = require('../http');
const secrets = require('../secrets');

let pool = null;
let secretAsks = null;
let prefs = null;

function init(deps) {
    ({ pool, secretAsks, prefs } = deps);
}

/** Whether a remote caller may answer an ask. Off if it cannot be read: this fails towards the desk. */
function allowRemote() {
    try { return (prefs.forCwd().secrets || {}).allowRemote === true; } catch { return false; }
}

/**
 * Why this remote caller may not send a value, or null. An accident guard rather
 * than authentication: `secure` trusts a forwarded header, and by the time a client
 * that ignored the card gets here its value has already crossed. It still means a
 * plain-HTTP origin is told so, and nothing it sent is kept.
 */
function remoteAnswerProblem(who) {
    if (!allowRemote()) {
        return 'answering a secret ask from a phone is off — turn it on in Settings › Secrets at your desk';
    }
    if (!who.secure) return 'this connection is not encrypted, so a secret cannot be sent over it';
    return null;
}

function cwdOf(v) {
    return typeof v === 'string' && path.isAbsolute(v) ? v : null;
}

const local = (res, who) => {
    if (!who.remote) return false;
    send(res, 403, { error: 'secrets can only be set or read at the machine they live on', remote: true });
    return true;
};

async function body(req, res) {
    try { return (await readJson(req)) || {}; } catch (err) { send(res, 400, { error: err.message }); return null; }
}

/** The tool asking. Held until you answer, deny, or the tool hangs up. */
async function ask(req, res, who) {
    if (local(res, who)) return;
    const b = await body(req, res);
    if (!b) return;
    const problem = secrets.nameProblem(b.name);
    if (problem) return send(res, 400, { error: problem });
    const cwd = cwdOf(b.cwd);
    if (!cwd) return send(res, 400, { error: 'cwd must be an absolute path' });
    const sessionId = typeof b.sessionId === 'string' && b.sessionId ? b.sessionId : null;
    if (!sessionId) return send(res, 400, { error: 'sessionId is required' });
    const root = secrets.projectRoot(cwd);
    if (secrets.has(root, b.name)) return send(res, 200, { saved: true, existed: true, name: b.name });
    // Nobody to ask: the rule a permission prompt and a sudo ask follow, so an
    // unattended run is told now rather than waiting forever.
    if (pool && pool.hasViewer && !pool.hasViewer(sessionId)) {
        return send(res, 200, { denied: true, reason: 'nobody is watching TGXCode to provide it' });
    }
    let settled = false;
    const a = secretAsks.open({ sessionId, name: b.name, why: typeof b.why === 'string' ? b.why : '', cwd, root },
        (result) => {
            settled = true;
            if (!res.writableEnded && !res.destroyed) send(res, 200, result);
        });
    res.on('close', () => { if (!settled) secretAsks.cancel(a.id, 'the agent stopped waiting'); });
}

async function handle(req, res, url, pathname, seg, who) {
    if (seg[1] !== 'secrets') return NEXT;

    if (seg.length === 2 && req.method === 'GET') {
        const cwd = cwdOf(url.searchParams.get('cwd'));
        if (!cwd) return send(res, 400, { error: 'cwd must be an absolute path' });
        const root = secrets.projectRoot(cwd);
        return send(res, 200, {
            project: root,
            allowRemote: allowRemote(),
            secrets: secrets.list(root),
            asks: secretAsks.list().filter(a => a.project === root),
        });
    }

    if (seg.length === 3 && seg[2] === 'ask' && req.method === 'POST') return ask(req, res, who);

    if (seg.length === 3 && seg[2] === 'resolve' && req.method === 'POST') {
        if (local(res, who)) return;
        const b = await body(req, res);
        if (!b) return;
        const cwd = cwdOf(b.cwd);
        const names = Array.isArray(b.names) ? b.names : null;
        if (!cwd || !names || !names.length || names.length > 64) {
            return send(res, 400, { error: 'cwd (absolute) and names (1–64) are required' });
        }
        const bad = names.find(n => secrets.nameProblem(n));
        if (bad !== undefined) return send(res, 400, { error: secrets.nameProblem(bad) });
        const root = secrets.projectRoot(cwd);
        const out = secrets.resolve(root, names);
        if (out.missing) return send(res, 404, { error: 'not set', missing: out.missing });
        const by = typeof b.sessionId === 'string' ? b.sessionId.slice(0, 8) : 'unknown';
        console.log(`[tgxcode] secrets ${names.join(', ')} used by session ${by} in ${root}`);
        return send(res, 200, { values: out.values });
    }

    if (seg.length === 5 && seg[2] === 'asks' && req.method === 'POST') {
        const id = seg[3];
        const verb = seg[4];
        if (verb === 'deny') {
            if (!secretAsks.get(id)) return send(res, 409, { error: 'that secret ask was already answered or has gone' });
            secretAsks.deny(id, 'denied');
            return send(res, 200, { ok: true });
        }
        if (verb === 'answer') {
            // Before the body is read: a refused value is not one to hold on to.
            const refused = who.remote ? remoteAnswerProblem(who) : null;
            if (refused) return send(res, 403, { error: refused, remote: true });
            const gone = 'that secret ask was already answered or has gone';
            if (who.remote && !secretAsks.get(id)) return send(res, 409, { error: gone });
            const b = await body(req, res);
            if (!b) return;
            const problem = secrets.valueProblem(b.value);
            if (problem) return send(res, 400, { error: problem });
            // Asked again after the read, which is where another answer could have landed.
            const pending = secretAsks.get(id);
            if (!pending) return send(res, 409, { error: gone });
            if (who.remote && secrets.has(pending.root, pending.name)) {
                return send(res, 409, { error: `${pending.name} is already set; change it at your desk`, exists: true });
            }
            try { secretAsks.save(id, b.value); } catch (err) {
                return send(res, err.status || 500, { error: err.status ? err.message : 'could not save the secret' });
            }
            return send(res, 200, { ok: true });
        }
        return NEXT;
    }

    const name = seg[2];
    if (!name || secrets.nameProblem(name)) {
        return seg.length >= 3 ? send(res, 400, { error: secrets.nameProblem(name) || 'no such route' }) : NEXT;
    }

    if (seg.length === 3 && req.method === 'PUT') {
        if (local(res, who)) return;
        const b = await body(req, res);
        if (!b) return;
        const cwd = cwdOf(b.cwd);
        if (!cwd) return send(res, 400, { error: 'cwd must be an absolute path' });
        const problem = secrets.valueProblem(b.value);
        if (problem) return send(res, 400, { error: problem });
        const row = secrets.set(secrets.projectRoot(cwd), name, b.value);
        return send(res, 200, { ok: true, secret: row });
    }

    if (seg.length === 3 && req.method === 'DELETE') {
        if (local(res, who)) return;
        const cwd = cwdOf(url.searchParams.get('cwd'));
        if (!cwd) return send(res, 400, { error: 'cwd must be an absolute path' });
        const gone = secrets.remove(secrets.projectRoot(cwd), name);
        return gone ? send(res, 200, { ok: true }) : send(res, 404, { error: `${name} is not set` });
    }

    if (seg.length === 4 && seg[3] === 'reveal' && req.method === 'POST') {
        if (local(res, who)) return;
        const b = await body(req, res);
        if (!b) return;
        const cwd = cwdOf(b.cwd);
        if (!cwd) return send(res, 400, { error: 'cwd must be an absolute path' });
        const value = secrets.get(secrets.projectRoot(cwd), name);
        if (value === null) return send(res, 404, { error: `${name} is not set` });
        return send(res, 200, { name, value });
    }

    return NEXT;
}

module.exports = { init, handle, allowRemote };
