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
    check('mkdir', (await call('POST', '/api/fs/mkdir', {
        headers: PHONE, body: { parent: HOME, name: 'x' },
    })).status, 403);
    check('runs list', (await call('GET', '/api/runs', { headers: PHONE })).status, 403);
    check('runs stream', (await call('GET', '/api/runs/x/stream', { headers: PHONE })).status, 403);
    check('runs input', (await call('POST', '/api/runs/x/input', { headers: PHONE, body: {} })).status, 403);
    check('starting a project command', (await call('POST', '/api/commands/run', {
        headers: PHONE, body: { cwd: HOME, id: 'dev' },
    })).status, 403);
    // The same asymmetry as /api/fs below: what a project *declares* is in its
    // repository already, so reading it from a phone gives away nothing. Running
    // it is reaching past the app into the machine.
    check('reading what a project declares', (await call('GET',
        `/api/commands?cwd=${encodeURIComponent(HOME)}`, { headers: PHONE })).status, 200);
    // The asymmetry that decision rests on: reading the tree stays allowed, and
    // this is the line that pins it. A phone may already start a session, so it
    // may see where one could start; writing to the filesystem is the other side.
    check('listing home from a phone', (await call('GET',
        `/api/fs?path=${encodeURIComponent(HOME)}`, { headers: PHONE })).status, 200);

    console.log('\n--- and the same routes from the desk ---');
    // Not 403: they may fail for their own reasons (404, 409), but the gate must
    // not be what stops them.
    const localTerm = await call('GET', '/api/terminals/nope/stream', { headers: LOCAL });
    check('terminals locally is not a refusal', localTerm.status === 403, false);
    const localDb = await call('GET', '/api/devbrowser/status', { headers: LOCAL });
    check('devbrowser locally is not a refusal', localDb.status === 403, false);
    // 404 rather than 403: the gate lets it through and it fails on its own
    // terms, which is the distinction being tested.
    check('a run locally reaches its own not-found',
        (await call('GET', '/api/runs/nope', { headers: LOCAL })).status, 404);

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
    // Same rule, same reason: a directory no session may start in is one whose
    // slash commands are nobody's business either, and the route takes a path.
    check('slash commands for /etc', (await call('GET', '/api/slash-commands?cwd=/etc',
        { headers: LOCAL })).status, 403);
    check('slash commands for home', (await call('GET',
        `/api/slash-commands?cwd=${encodeURIComponent(HOME)}`, { headers: LOCAL })).status, 200);
    // Naming neither is a bad request, not an empty answer — the two parameters
    // are the whole interface.
    check('slash commands with no target', (await call('GET', '/api/slash-commands',
        { headers: LOCAL })).status, 400);
    check('listing home', (await call('GET', `/api/fs?path=${encodeURIComponent(HOME)}`, { headers: LOCAL })).status, 200);
    const home = await call('GET', `/api/fs?path=${encodeURIComponent(HOME)}`, { headers: LOCAL });
    check('and home reports no parent to climb to', home.body.parent, null);
    // The breadcrumb needs these to know where the trail stops.
    check('and reports the roots it is bounded by', Array.isArray(home.body.roots), true);
    check('a tilde is expanded rather than resolved against cwd',
        (await call('GET', '/api/fs?path=~', { headers: LOCAL })).body.path, HOME);

    console.log('\n--- making a folder ---');
    // The only test in this suite that writes to disk. It creates one directory
    // under $HOME — it has to be inside a root, so os.tmpdir() is not an option —
    // and removes it again in the finally below.
    const made = `${HOME}/cs-mkdir-test-${process.pid}`;
    try {
        const first = await call('POST', '/api/fs/mkdir', {
            headers: LOCAL, body: { parent: HOME, name: `cs-mkdir-test-${process.pid}` },
        });
        check('creating one', first.status, 200);
        check('says it created it', first.body && first.body.created, true);
        check('and hands back the path', first.body && first.body.path, made);

        const again = await call('POST', '/api/fs/mkdir', {
            headers: LOCAL, body: { parent: HOME, name: `cs-mkdir-test-${process.pid}` },
        });
        check('creating it twice is not an error', again.status, 200);
        check('but it says it made nothing', again.body && again.body.created, false);
    } finally {
        try { fs.rmdirSync(made); } catch { /* never created */ }
    }

    check('a slash in the name', (await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: HOME, name: '../evil' },
    })).status, 400);
    check('a dotted name the picker could not show', (await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: HOME, name: '.hidden' },
    })).status, 400);
    check('no name at all', (await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: HOME, name: '  ' },
    })).status, 400);
    const outside = await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: '/etc', name: 'x' },
    });
    check('a parent outside the roots', outside.status, 403);
    console.log(`       said: ${outside.body && outside.body.error}`);
    check('a parent that is a file', (await call('POST', '/api/fs/mkdir', {
        headers: LOCAL, body: { parent: `${HOME}/.bashrc`, name: 'x' },
    })).status, 400);

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
