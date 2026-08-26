'use strict';

// A remote device loads the page with no cookie. It must load (it is static), the
// token must NOT be handed over, and the probe the page makes on boot must 401 —
// that combination is what produces a "not paired" screen instead of an empty app.
//
// Written when the remote device was a phone browser on /m. The phone is the native
// Android app now, which never loads a page of ours, but the three-way combination
// this pins is a property of the *bridge* rather than of that page: any off-machine
// caller sees it, including a desktop browser opened over the tunnel. So it is
// aimed at / and it still earns its place.

const http = require('http');

const PORT = Number(process.argv[2] || 45901);

// No Authorization header: an unpaired device has only the URL.
const PHONE = {
    'x-forwarded-for': '100.75.106.58',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'tg-dylanh.taild5c420.ts.net',
};

/**
 * `stream: true` resolves on the response head and hangs up, rather than waiting
 * for a body that never ends — /api/events is an open SSE stream when it succeeds.
 */
function call(p, headers, { stream = false } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: p, headers },
            (res) => {
                if (stream && res.statusCode === 200) {
                    req.destroy();
                    return resolve({ status: 200, headers: res.headers, body: '' });
                }
                const c = [];
                res.on('data', (x) => c.push(x));
                res.on('end', () => resolve({
                    status: res.statusCode, headers: res.headers,
                    body: Buffer.concat(c).toString('utf8'),
                }));
            });
        req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
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
    console.log('\n--- an unpaired remote device loading / ---');
    const page = await call('/', PHONE);
    check('the page loads', page.status, 200);
    check('but is NOT handed the token', /cs-token/.test(page.body), false);
    check('and gets no cookie', page.headers['set-cookie'], undefined);

    console.log('\n--- what boot() then sees ---');
    const health = await call('/api/health', PHONE);
    check('health answers 200 (it is open)', health.status, 200);
    check('and says remote', JSON.parse(health.body).remote, true);
    const probe = await call('/api/sessions?limit=1', PHONE);
    check('the probe 401s — this is what triggers the screen', probe.status, 401);
    const events = await call('/api/events', PHONE, { stream: true });
    check('and so does the stream', events.status, 401);

    console.log('\n--- after pairing ---');
    const paired = await call(`/pair?token=${require('fs').readFileSync(
        require('path').join(require('os').homedir(),
            '.local/share/claude-sessions/token'), 'utf8').trim()}`, PHONE);
    check('pair redirects', paired.status, 303);
    const cookie = String(paired.headers['set-cookie']).split(';')[0];
    check('and the cookie then works',
        (await call('/api/sessions?limit=1', { ...PHONE, cookie })).status, 200);
    check('as does the stream',
        (await call('/api/events', { ...PHONE, cookie }, { stream: true })).status, 200);

    console.log(fails ? `\n${fails} FAILED` : '\nall passed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
