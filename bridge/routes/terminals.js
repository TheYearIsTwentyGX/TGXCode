'use strict';

// `/api/terminals/:id`: a terminal pane's byte stream, its input, its size, and
// closing it. Opening one is `POST /api/sessions/:id/terminal`, in
// session-workspace.js. The ptys are bridge/terminal.js.
//
// **Every route here is refused to a remote caller** — remoteRefusal() in
// server.js refuses the whole prefix before `api()`. A raw pty is the machine.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract: `handle` returns `NEXT` for a request that is
// not one of its own, and the branches below were moved out of `api()` verbatim,
// so their order, their fall-through and their status codes are what they were.

const { streamBytes } = require('../events');
const { NEXT, readJson, send } = require('../http');

// Handed over by server.js — see the note above ROUTES there.
let terminals = null;

function init(deps) {
    ({ terminals } = deps);
}

async function handle(req, res, url, pathname, seg, who) {
    // --- terminals ---------------------------------------------------------
    // Keyed by terminal rather than by session so a pane keeps talking to the
    // shell it opened even if the session list moves underneath it.
    if (seg[1] === 'terminals' && seg[2]) {
        const term = terminals.get(seg[2]);
        if (!term) return send(res, 404, { error: 'no such terminal' });
        const tail = seg[3];

        // Its own stream, not the app's SSE channel: this is a byte pipe that
        // can move megabytes when a build is noisy, and it has no business
        // sharing a connection with transcript tailing.
        if (tail === 'stream' && req.method === 'GET') return streamBytes(req, res, term, term.info());

        if (tail === 'input' && req.method === 'POST') {
            const body = await readJson(req);
            // Base64 both ways: a keystroke is bytes, and half a multi-byte
            // character is a legitimate thing to send on its own.
            if (typeof body.b64 !== 'string') return send(res, 400, { error: 'b64 is required' });
            const ok = term.write(Buffer.from(body.b64, 'base64'));
            // The shell exiting while you were mid-keystroke is ordinary, and
            // the pane already knows from the exit event — say so, don't fail.
            return send(res, 200, { ok, exited: term.exited });
        }

        if (tail === 'resize' && req.method === 'POST') {
            const body = await readJson(req);
            term.resize(body.rows, body.cols);
            return send(res, 200, { ok: true, rows: term.rows, cols: term.cols });
        }

        if (!tail && req.method === 'DELETE') {
            terminals.close(term.id);
            return send(res, 200, { ok: true });
        }
    }

    return NEXT;
}

module.exports = { init, handle };
