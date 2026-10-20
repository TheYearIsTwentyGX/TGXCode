'use strict';

// `/api/phone-installs`: APKs an agent filed for the phone, the APK itself, and
// what the phone says about installing it. The store and its rules are
// bridge/phone-installs.js; the broadcast is its `onChange`, wired in server.js.
//
// Filing one and cancelling one are local-only, and that is remoteRefusal() in
// server.js rather than a check here: filing names a path on this machine and
// makes its bytes downloadable from anywhere the token reaches, which is a
// decision for something running on this machine. Everything a phone needs —
// the list, the APK, the status report — stays open, since the phone is the
// client this exists for.
//
// One of the route modules server.js's `api()` asks in turn — see the note above
// ROUTES there for the contract.

const fs = require('fs');

const { NEXT, readJson, send } = require('../http');
const viewers = require('../viewers');

// Handed over by server.js — see the note above ROUTES there.
let phoneInstalls = null;

function init(deps) {
    ({ phoneInstalls } = deps);
}

/**
 * One `bytes=a-b` range, or null for the whole file — and `false` for a range
 * that cannot be satisfied. A multi-range request is answered whole, which the
 * spec allows and no download manager minds.
 */
function parseRange(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!m || (!m[1] && !m[2])) return null;
    let start;
    let end;
    if (!m[1]) {
        // `bytes=-N`: the last N bytes.
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
    } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    if (start >= size || start > end) return false;
    return { start, end };
}

function serveApk(req, res, rec, file) {
    let size;
    try { size = fs.statSync(file).size; } catch {
        return send(res, 410, { error: 'the APK is no longer stored here', state: rec.state });
    }
    const etag = `"${rec.sha256}"`;
    const head = {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="${rec.fileName.replace(/["\\\r\n]/g, '_')}"`,
        ETag: etag,
        'X-SHA256': rec.sha256,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
    };
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, head);
        return res.end();
    }
    // A stale If-Range means the client's partial file is of something else;
    // then it gets the whole thing, as the spec says.
    const ifRange = req.headers['if-range'];
    const range = !ifRange || ifRange === etag ? parseRange(req.headers.range, size) : null;
    if (range === false) {
        res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` });
        return res.end();
    }
    const { start, end } = range || { start: 0, end: size - 1 };
    res.writeHead(range ? 206 : 200, {
        ...head,
        'Content-Length': size ? end - start + 1 : 0,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (!size) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
    stream.pipe(res);
}

async function handle(req, res, url, pathname, seg) {
    if (seg[1] !== 'phone-installs') return NEXT;

    if (!seg[2]) {
        if (req.method === 'GET') return send(res, 200, { installs: phoneInstalls.list() });
        if (req.method === 'POST') {
            const body = await readJson(req);
            try {
                return send(res, 201, await phoneInstalls.create(body));
            } catch (err) {
                if (err.status) return send(res, err.status, { error: err.message });
                throw err;
            }
        }
        return NEXT;
    }

    const id = seg[2];
    if (seg[3] === 'apk' && !seg[4] && req.method === 'GET') {
        const rec = phoneInstalls.get(id);
        if (!rec) return send(res, 404, { error: 'no such install' });
        return serveApk(req, res, rec, phoneInstalls.apkPath(id));
    }

    if (seg[3] === 'status' && !seg[4] && req.method === 'POST') {
        const body = await readJson(req);
        const viewer = req.headers[viewers.HEADER] ? String(req.headers[viewers.HEADER]) : null;
        const out = phoneInstalls.setStatus(id, body, viewer);
        return out.error ? send(res, out.status, { error: out.error }) : send(res, 200, out.record);
    }

    if (seg[3] === 'cancel' && !seg[4] && req.method === 'POST') {
        const out = phoneInstalls.cancel(id);
        return out.error ? send(res, out.status, { error: out.error }) : send(res, 200, out.record);
    }

    if (!seg[3] && req.method === 'GET') {
        const rec = phoneInstalls.get(id);
        return rec ? send(res, 200, rec) : send(res, 404, { error: 'no such install' });
    }

    return NEXT;
}

module.exports = { init, handle, parseRange };
