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

    // Everything web/app.js does, now that the jar is warm. No header anywhere.
    console.log('\n--- and now every call web/ makes, unchanged ---');
    check('GET /api/sessions', (await call('/api/sessions')).status, 200);
    check('GET /api/projects', (await call('/api/projects')).status, 200);
    check('GET /api/overview', (await call('/api/overview')).status, 200);
    check('GET /api/dashboard', (await call('/api/dashboard')).status, 200);
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

    console.log('\n--- the phone surface and its assets ---');
    const manifest = await call('/manifest.webmanifest');
    check('manifest is served', manifest.status, 200);
    check('with the right content type',
        manifest.headers['content-type'], 'application/manifest+json');
    const icon = await call('/icon-192.png');
    check('icon is served', icon.status, 200);
    check('as a PNG', icon.headers['content-type'], 'image/png');
    for (const p of ['/m', '/m/', '/mobile.js', '/mobile.css']) {
        check(`GET ${p}`, (await call(p)).status, 200);
    }
    const m = await call('/m');
    check('/m is the mobile page', /mobile\.js/.test(m.body), true);
    check('and it too is handed the token', /name="cs-token"/.test(m.body), true);

    console.log(fails ? `\n${fails} FAILED` : '\nall passed');
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
