'use strict';

// The regression that matters: a browser (or the Electron shell) loading the page
// over loopback must end up able to call the API and open the SSE stream with no
// change to anything in web/. That works only if the page response sets the cookie
// and the subsequent calls send it back, which is what this imitates.
//
//   node browser-test.js [port]

const http = require('http');

const PORT = Number(process.argv[2] || 45901);

let jar = '';

function call(pathname, { headers = {}, method = 'GET', useJar = true } = {}) {
    return new Promise((resolve, reject) => {
        const h = { ...headers };
        if (useJar && jar) h.cookie = jar;
        const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: h },
            (res) => {
                // Behave like a cookie jar: remember what we are told to.
                const sc = res.headers['set-cookie'];
                if (sc) {
                    for (const line of sc) {
                        const pair = line.split(';')[0];
                        if (/Max-Age=0/.test(line)) jar = '';
                        else jar = pair;
                    }
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({
                    status: res.statusCode, headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            });
        req.on('error', reject);
        req.end();
    });
}

/** Open the SSE stream and resolve on the first event, or reject on a non-200. */
function stream(pathname) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: PORT, path: pathname, headers: jar ? { cookie: jar } : {} },
            (res) => {
                if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode }); }
                res.setEncoding('utf8');
                let buf = '';
                res.on('data', (c) => {
                    buf += c;
                    if (buf.includes('\n\n')) { req.destroy(); resolve({ status: 200, first: buf }); }
                });
                res.on('error', () => { /* destroyed by us */ });
            });
        req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
        req.setTimeout(4000, () => { req.destroy(); reject(new Error('SSE timed out')); });
        req.end();
    });
}

let fails = 0;
function check(name, got, want) {
    const okay = got === want;
    if (!okay) fails++;
    console.log(`  ${okay ? 'ok  ' : 'FAIL'} ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

(async () => {
    console.log(`\n--- a browser on loopback, no token of its own (bridge on ${PORT}) ---`);

    // Cold: no cookie yet. This is what the old UI would have hit.
    check('API refuses us before we load the page', (await call('/api/sessions')).status, 401);

    // Load the page, exactly as navigating to http://127.0.0.1:PORT/ does.
    const page = await call('/');
    check('the page loads', page.status, 200);
    check('it sets a cookie', Boolean(page.headers['set-cookie']), true);
    check('the cookie is HttpOnly', /HttpOnly/.test(String(page.headers['set-cookie'])), true);
    check('it is NOT Secure over plain loopback http',
        /Secure/.test(String(page.headers['set-cookie'])), false);
    check('and the page can read the token for the pairing link',
        /name="cs-token" content="[\w-]{43}"/.test(page.body), true);
    // The transcript decides how to draw itself from this before its first
    // fetch, so a page served without it is a page that renders the wrong way
    // with nothing to say so. Percent-encoded, because it is JSON in an
    // attribute — see auth.injectMeta.
    check('and the settings are in the page, not behind a fetch',
        /name="cs-prefs" content="%7B%22version%22/.test(page.body), true);
    // Same argument, one step further: the first key somebody presses can land
    // before a fetch could answer, and a Ctrl+3 that does nothing because the
    // keymap has not arrived is indistinguishable from a broken binding.
    check('and so is the shortcut catalogue',
        /name="cs-keymap" content="%7B%22commands%22/.test(page.body), true);

    // Everything web/app.js does, now that the jar is warm. No header anywhere.
    console.log('\n--- and now every call web/ makes, unchanged ---');
    check('GET /api/sessions', (await call('/api/sessions')).status, 200);
    check('GET /api/projects', (await call('/api/projects')).status, 200);
    check('GET /api/keymap', (await call('/api/keymap')).status, 200);
    // What the settings panel reads: the merged answer plus what each file in
    // the chain says on its own.
    check('GET /api/prefs?files=1', (await call('/api/prefs?files=1')).status, 200);
    // And what the Claude Code group reads: somebody else's four files, the
    // merged reading of them, and everything in them this app has no control
    // for. Only the read is exercised — every write on that route replaces or
    // removes a key in the user's live `~/.claude/settings.json`, which decides
    // what every session on this machine may do, and `npm test` has no business
    // touching it. The refusals suite next door sends bodies the bridge throws
    // out before it opens a file; the write path itself is covered against a
    // temporary HOME in test/claude-config.test.js.
    {
        const r = await call('/api/claude-config');
        check('GET /api/claude-config', r.status, 200);
        const body = JSON.parse(r.body || '{}');
        check('  …carries the chain', Array.isArray(body.files), true);
        check('  …carries the catalogue', Array.isArray(body.catalogue), true);
        // The field that makes the group honest about drift. An empty array is
        // a legitimate answer; a missing one means the page draws nothing where
        // the uncatalogued keys should be.
        check('  …and the keys it has no control for', Array.isArray(body.unknown), true);
    }
    // And what the Memory group reads: one row per CLAUDE.md. The read alone,
    // for the same reason as the block above and rather more so — a write on
    // that route replaces the whole of the user's own instructions to Claude,
    // and `npm test` has no business touching those. The refusals suite next
    // door covers what a remote caller is told; the write path is covered
    // against a temporary HOME in test/claude-docs.test.js.
    {
        const r = await call('/api/claude-docs');
        check('GET /api/claude-docs', r.status, 200);
        const body = JSON.parse(r.body || '{}');
        check('  …carries a row per file', Array.isArray(body.docs), true);
        // With no `cwd` there is exactly one row, the user's, and a client that
        // drew two would be drawing a file for a project nobody named.
        check('  …just the user one with no cwd',
            (body.docs || []).map(d => d.scope).join(','), 'user');
        // The cap, so a page can label its byte counter with the real number
        // instead of hardcoding one that later drifts.
        check('  …and the size cap', typeof body.maxBytes, 'number');
    }
    check('GET /api/overview', (await call('/api/overview')).status, 200);
    check('GET /api/dashboard', (await call('/api/dashboard')).status, 200);
    check('GET /api/quota', (await call('/api/quota')).status, 200);
    // A refresh starts a `claude` and spends an API call, so it must be POST
    // and nothing else. Browsers prefetch, service workers replay, and a link
    // somebody pastes is a GET — any of which starting a CLI would be a real
    // bug. 404 is the route table falling through, which is the point: there is
    // no GET here to reach.
    //
    // The POST itself is deliberately *not* exercised here. It would spawn a
    // real CLI against the user's own trusted directory and write their live
    // quota file, which is not a thing `npm test` should do; it is a manual
    // check, like the beacon run it performs.
    check('GET /api/quota/refresh does not exist — a refresh is never a GET',
        (await call('/api/quota/refresh')).status, 404);
    check('POST /api/subscribe reaches its own 404, not the gate',
        (await call('/api/subscribe', {
            method: 'POST', headers: { 'x-claude-sessions-client': '1' },
        })).status, 404);

    const es = await stream('/api/events');
    check('EventSource /api/events opens', es.status, 200);
    check('and says hello', /event: hello/.test(es.first || ''), true);

    // The static assets the page pulls in.
    for (const asset of ['/app.js', '/styles.css', '/markdown.js', '/highlight.js', '/sw.js']) {
        check(`GET ${asset}`, (await call(asset)).status, 200);
    }

    // The phone web view is gone — the phone is the native Android app now, and it
    // is a client of /api/ only. Pinned because a stale PAGES entry or a manifest
    // left in web/ would otherwise resurrect a page nothing maintains.
    console.log('\n--- the removed phone surface stays removed ---');
    for (const p of ['/m', '/m/', '/mobile.js', '/mobile.css', '/manifest.webmanifest',
        '/icon-192.png']) {
        check(`GET ${p} is gone`, (await call(p)).status, 404);
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed');
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
