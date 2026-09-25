'use strict';

// The plumbing every route shares: a JSON reply, a JSON body, a binary body, and
// the `NEXT` a route module returns to say "not mine".
//
// Out of server.js because the routes moved out of it, and a route module that
// required server.js back for `send` would get a half-filled exports object in
// the middle of server.js's own load. Nothing here knows about a route, a session
// or a token; the request handler in server.js still does the gating before any
// of this is reached.

function send(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error('invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

/**
 * The whole body as bytes, for the one route that takes a file rather than JSON.
 *
 * A sibling of readJson rather than a generalisation of it, for two reasons. It
 * needs a *caller-supplied* cap — 25MB for an attachment against readJson's 4MB —
 * and it needs to fail honestly: readJson's rejection reaches the catch-all in
 * `route`, which turns "body too large" into a 500, and that has been the answer
 * for long enough that other routes may be relying on the shape. So the new reader
 * throws a `status` and this route reads it, and readJson is left alone.
 *
 * Content-Length is checked first where the client sent one, so an oversized upload
 * is refused before the bytes travel rather than after.
 */
const overMax = (max) => `that file is larger than the `
    + `${Math.round(max / (1024 * 1024))}MB limit`;

/**
 * Refuse an upload, and hang up on the rest of it.
 *
 * Both halves matter and the order between them is the whole reason this is a function
 * rather than two lines at each caller. Destroying the socket is what stops a client
 * from spending thirty seconds sending a file that has already been refused; doing it
 * before the response has flushed truncates the sentence that says why, which is how
 * an oversized upload came to report a bare `100 Continue` and nothing else. `finish`
 * is the event that says the answer is out.
 */
function refuseUpload(req, res, status, error) {
    res.on('finish', () => req.destroy());
    return send(res, status || 413, { error });
}

/**
 * A Content-Length the caller already told us is too big.
 *
 * Split out so the route can ask *before* it looks a session up. Both refusals can be
 * true of one request, and the size is the more useful of the two to hear: "session not
 * found" in answer to a 40MB upload hides the thing that would still be wrong after
 * the id was fixed.
 */
function declaredOverMax(req, max) {
    const n = Number(req.headers['content-length']);
    return Number.isFinite(n) && n > max;
}

function readBinary(req, max) {
    return new Promise((resolve, reject) => {
        // Paused, not destroyed. Destroying the socket here was the first version and
        // it is wrong in a way worth remembering: the caller still has to write the
        // 413 onto that socket, and a client that sent `Expect: 100-continue` — curl
        // does, for a body this size — then sees the interim 100 and nothing else. It
        // reports "100" as the status and never learns what the limit was. So the
        // stream stops and the route answers; `oversized` tells it to hang up
        // afterwards, since nothing is going to read the rest of the upload.
        const tooBig = () => {
            req.pause();
            reject(Object.assign(new Error(overMax(max)), { status: 413, oversized: true }));
        };

        // Normally already handled by the caller; kept because this function's contract
        // is the cap, not the caller's diligence.
        if (declaredOverMax(req, max)) return tooBig();

        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            // A Content-Length that lied, or a chunked body. Same answer.
            if (size > max) return tooBig();
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// What a route module's handler returns when the request was not one of its own,
// so the dispatcher in server.js goes on to the next. Anything else — including
// the `undefined` a bare `return send(…)` produces — means it answered.
const NEXT = Symbol('next route');

module.exports = { send, readJson, readBinary, refuseUpload, declaredOverMax, overMax, NEXT };
