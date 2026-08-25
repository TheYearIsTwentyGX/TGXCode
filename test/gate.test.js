'use strict';

// Drives a live dev bridge over HTTP and checks the auth gate, the origin check,
// the Host check, /pair, and the <meta> injection.
//
//   node gate-test.js [port]

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.argv[2] || 45901);
const TOKEN = fs.readFileSync(
    path.join(os.homedir(), '.local/share/claude-sessions/token'), 'utf8').trim();

function call(pathname, { headers = {}, method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: PORT, path: pathname, method, headers },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            });
        req.on('error', reject);
        req.end();
    });
}

let fails = 0;
function check(name, got, want) {
    const okay = got === want;
    if (!okay) fails++;
    console.log(`  ${okay ? 'ok  ' : 'FAIL'} ${name} — got ${got}, want ${want}`);
}

const BEARER = { authorization: `Bearer ${TOKEN}` };
// A phone behind `tailscale serve` looks like this from in here.
const PHONE = {
    ...BEARER,
    'x-forwarded-for': '100.88.1.2',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'tgdylanh.tail1234.ts.net',
};

(async () => {
    console.log(`\n--- the gate (bridge on ${PORT}) ---`);
    check('health, no token', (await call('/api/health')).status, 200);
    check('sessions, no token', (await call('/api/sessions')).status, 401);
    check('sessions, bearer', (await call('/api/sessions', { headers: BEARER })).status, 200);
    check('sessions, ?token=', (await call(`/api/sessions?token=${TOKEN}`)).status, 200);
    check('sessions, cookie',
        (await call('/api/sessions', { headers: { cookie: `cs_token=${TOKEN}` } })).status, 200);
    check('sessions, wrong token',
        (await call('/api/sessions', { headers: { authorization: 'Bearer nope' } })).status, 401);
    check('overview needs a token', (await call('/api/overview')).status, 401);
    check('overview with a token',
        (await call('/api/overview', { headers: BEARER })).status, 200);
    check('taskboard needs a token', (await call('/api/taskboard')).status, 401);
    check('taskboard with a token',
        (await call('/api/taskboard', { headers: BEARER })).status, 200);
    check('a bogus route still 404s past the gate',
        (await call('/api/nope', { headers: BEARER })).status, 404);

    console.log('\n--- what /api/health says ---');
    const local = JSON.parse((await call('/api/health')).body);
    check('local health: remote', local.remote, false);
    check('local health: authRequired', local.authRequired, true);
    check('local health: root present', typeof local.root, 'string');
    const far = JSON.parse((await call('/api/health', { headers: PHONE })).body);
    check('remote health: remote', far.remote, true);
    check('remote health: root withheld', far.root, undefined);
    check('remote health: home withheld', far.home, undefined);

    console.log('\n--- origin check ---');
    check('our own loopback origin',
        (await call('/api/sessions', { headers: { ...BEARER, origin: 'http://127.0.0.1:45888' } })).status, 200);
    check('a hostile origin',
        (await call('/api/sessions', { headers: { ...BEARER, origin: 'http://evil.example' } })).status, 403);
    check('the ts.net origin a phone sends',
        (await call('/api/sessions', {
            headers: { ...PHONE, origin: 'https://tgdylanh.tail1234.ts.net' },
        })).status, 200);
    check('an origin matching a forged Host is still refused if the Host is unknown',
        (await call('/api/sessions', {
            headers: { ...BEARER, host: 'attacker.example', origin: 'http://attacker.example' },
        })).status, 403);

    console.log('\n--- Host check (DNS rebinding) ---');
    check('a public name pointed at this port',
        (await call('/api/sessions', { headers: { ...BEARER, host: 'rebind.example' } })).status, 403);
    check('a ts.net name is fine',
        (await call('/api/sessions', { headers: { ...BEARER, host: 'tgdylanh.tail1234.ts.net' } })).status, 200);
    check('a LAN IP is fine',
        (await call('/api/sessions', { headers: { ...BEARER, host: '10.11.64.43:45901' } })).status, 200);

    console.log('\n--- tail=0: metadata without the transcript ---');
    // The polling fallback in web/mobile.js leans on this: liveness for the open
    // session at a few hundred bytes rather than a whole conversation. `slice(-0)`
    // returns everything, so getting this wrong makes the cheapest call the most
    // expensive one — hence a test rather than trust.
    const list = JSON.parse((await call('/api/sessions?limit=1', { headers: BEARER })).body);
    const id = list.sessions[0] && list.sessions[0].sessionId;
    if (id) {
        const full = JSON.parse((await call(`/api/sessions/${id}`, { headers: BEARER })).body);
        const none = JSON.parse((await call(`/api/sessions/${id}?tail=0`, { headers: BEARER })).body);
        const one = JSON.parse((await call(`/api/sessions/${id}?tail=1`, { headers: BEARER })).body);
        check('tail=0 returns no events', none.events.length, 0);
        check('tail=1 returns exactly one', one.events.length, Math.min(1, full.events.length));
        check('tail=0 still reports the offset', typeof none.offset, 'number');
        check('and the same offset as a full read', none.offset, full.offset);
        check('tail=0 still carries the runner slot', 'runner' in none, true);
        check('and says what it withheld', none.truncated && none.truncated.total,
            full.events.length);
        check('tail=0 is smaller than the whole transcript',
            JSON.stringify(none).length < JSON.stringify(full).length, true);
    } else {
        console.log('  --   no sessions indexed; skipped');
    }

    console.log('\n--- token injection into the page ---');
    const page = await call('/');
    check('/ serves HTML', page.status, 200);
    check('the local page carries the token', page.body.includes(`content="${TOKEN}"`), true);
    check('and a same-origin referrer policy', page.headers['referrer-policy'], 'same-origin');
    const remotePage = await call('/', { headers: PHONE });
    check('a proxied page is NOT handed the token', remotePage.body.includes(TOKEN), false);
    const originPage = await call('/', { headers: { origin: 'http://evil.example' } });
    check('a cross-origin fetch of the page is refused', originPage.status, 403);

    console.log('\n--- /pair ---');
    const paired = await call(`/pair?token=${TOKEN}`, { headers: PHONE });
    check('pair redirects', paired.status, 303);
    check('pair lands on /m', paired.headers.location, '/m');
    const cookie = String(paired.headers['set-cookie']);
    check('pair sets the cookie', cookie.includes(`cs_token=${TOKEN}`), true);
    check('cookie is HttpOnly', cookie.includes('HttpOnly'), true);
    check('cookie is Secure over https', cookie.includes('Secure'), true);
    check('cookie is Lax', cookie.includes('SameSite=Lax'), true);
    // No Authorization header here: a phone opening a stale link has only the URL.
    const { authorization, ...PROXY_ONLY } = PHONE;
    const badPair = await call('/pair?token=nope', { headers: PROXY_ONLY });
    check('a bad token gets a readable page', badPair.status, 401);
    check('and it is HTML, not JSON',
        String(badPair.headers['content-type']).startsWith('text/html'), true);
    check('a bad token sets no cookie', badPair.headers['set-cookie'], undefined);
    // But a device that is already paired can re-pair through a stale link, because
    // its cookie is a perfectly good credential.
    const rePair = await call('/pair?token=nope',
        { headers: { ...PROXY_ONLY, cookie: `cs_token=${TOKEN}` } });
    check('an already-paired device re-pairs anyway', rePair.status, 303);
    const forget = await call('/pair/forget', { headers: PHONE });
    check('forget expires the cookie',
        String(forget.headers['set-cookie']).includes('Max-Age=0'), true);

    console.log(fails ? `\n${fails} FAILED` : '\nall passed');
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
