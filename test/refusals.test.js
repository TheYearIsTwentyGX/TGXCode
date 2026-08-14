'use strict';

// What a remote caller holding a valid token may and may not do.
//
//   node refusal-test.js [port]

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.argv[2] || 45901);
const TOKEN = fs.readFileSync(
    path.join(os.homedir(), '.local/share/claude-sessions/token'), 'utf8').trim();

const LOCAL = { authorization: `Bearer ${TOKEN}`, 'X-Claude-Sessions-Client': '1' };
// A phone behind `tailscale serve`.
const PHONE = {
    ...LOCAL,
    'x-forwarded-for': '100.88.1.2',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'tgdylanh.tail1234.ts.net',
};

function call(method, p, { headers, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                ...headers,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            },
        }, (res) => {
            const c = [];
            res.on('data', (x) => c.push(x));
            res.on('end', () => {
                const text = Buffer.concat(c).toString('utf8');
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { /* html or empty */ }
                resolve({ status: res.statusCode, body: parsed, text });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

let fails = 0;
function check(name, got, want) {
    const okay = got === want;
    if (!okay) fails++;
    console.log(`  ${okay ? 'ok  ' : 'FAIL'} ${name} — got ${got}, want ${want}`);
}

const HOME = os.homedir();

(async () => {
    console.log('\n--- routes a phone may not reach ---');
    check('terminals stream', (await call('GET', '/api/terminals/x/stream', { headers: PHONE })).status, 403);
    check('terminals input', (await call('POST', '/api/terminals/x/input', { headers: PHONE, body: {} })).status, 403);
    check('shutdown', (await call('POST', '/api/shutdown', { headers: PHONE })).status, 403);
    check('devservers stop', (await call('POST', '/api/devservers/stop', { headers: PHONE, body: { port: 1 } })).status, 403);
    check('devbrowser status', (await call('GET', '/api/devbrowser/status', { headers: PHONE })).status, 403);
    check('reveal', (await call('POST', '/api/sessions/abc/reveal', { headers: PHONE, body: {} })).status, 403);

    console.log('\n--- and the same routes from the desk ---');
    // Not 403: they may fail for their own reasons (404, 409), but the gate must
    // not be what stops them.
    const localTerm = await call('GET', '/api/terminals/nope/stream', { headers: LOCAL });
    check('terminals locally is not a refusal', localTerm.status === 403, false);
    const localDb = await call('GET', '/api/devbrowser/status', { headers: LOCAL });
    check('devbrowser locally is not a refusal', localDb.status === 403, false);

    console.log('\n--- permission modes ---');
    const bypass = await call('POST', '/api/sessions', {
        headers: PHONE, body: { cwd: HOME, prompt: 'x', permissionMode: 'bypassPermissions' },
    });
    check('bypassPermissions remotely', bypass.status, 403);
    console.log(`       said: ${bypass.body && bypass.body.error}`);
    check('dontAsk remotely', (await call('POST', '/api/sessions', {
        headers: PHONE, body: { cwd: HOME, prompt: 'x', permissionMode: 'dontAsk' },
    })).status, 403);
    check('escalating an existing session by sending', (await call('POST', '/api/sessions/abc/send', {
        headers: PHONE, body: { text: 'x', permissionMode: 'bypassPermissions' },
    })).status, 403);
    // The same request from the desk must get past the mode check — it then fails
    // at "session not found", which is the point: a different error.
    const localSend = await call('POST', '/api/sessions/abc/send', {
        headers: LOCAL, body: { text: 'x', permissionMode: 'bypassPermissions' },
    });
    check('bypassPermissions locally is allowed through the gate', localSend.status, 404);

    console.log('\n--- cwd roots ---');
    const etc = await call('POST', '/api/sessions', {
        headers: LOCAL, body: { cwd: '/etc', prompt: 'x' },
    });
    check('starting a session in /etc', etc.status, 400);
    console.log(`       said: ${etc.body && etc.body.error}`);
    check('a near-miss prefix is not inside the root', (await call('POST', '/api/sessions', {
        headers: LOCAL, body: { cwd: `${HOME}-evil`, prompt: 'x' },
    })).status, 400);
    check('listing /etc', (await call('GET', '/api/fs?path=/etc', { headers: LOCAL })).status, 403);
    check('listing home', (await call('GET', `/api/fs?path=${encodeURIComponent(HOME)}`, { headers: LOCAL })).status, 200);
    const home = await call('GET', `/api/fs?path=${encodeURIComponent(HOME)}`, { headers: LOCAL });
    check('and home reports no parent to climb to', home.body.parent, null);

    console.log('\n--- what a phone may still do ---');
    check('read sessions', (await call('GET', '/api/sessions?limit=1', { headers: PHONE })).status, 200);
    check('read the board', (await call('GET', '/api/overview', { headers: PHONE })).status, 200);
    check('answer an ask (404 = no such session, not refused)',
        (await call('POST', '/api/sessions/abc/permission', {
            headers: PHONE, body: { requestId: 'x', decision: 'allow' },
        })).status, 404);
    check('start an ordinary session (reaches its own validation)',
        (await call('POST', '/api/sessions', { headers: PHONE, body: { cwd: HOME } })).status, 400);

    console.log(fails ? `\n${fails} FAILED` : '\nall passed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
