'use strict';

// Sudo approval — bridge/sudo.js, bridge/routes/sudo.js and the askpass helper.
//
// The parts worth pinning are the ones whose failure does not announce itself:
// a command read from the wrong process (the card shows something other than
// what runs), an ask route that a process without the session's key can reach,
// a password that leaks into an event, the log or a file, a phone that can send
// one when the setting says it cannot, and an ask that outlives the sudo it was
// for. No real sudo here: /proc is a fake tree the test owns, and the helper is
// the real bridge/sudo-askpass, talking to a real HTTP server running the real
// route. The end-to-end run against sudo itself is described in docs/manual.md.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Every file this could touch goes somewhere of the test's own, so the last
// check can search all of it for the password.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-sudo-'));
process.env.XDG_DATA_HOME = path.join(TMP, 'data');
process.env.TGXCODE_PREFS_DIR = path.join(TMP, 'prefs');

const auth = require('../bridge/auth');
const sudo = require('../bridge/sudo');
const routes = require('../bridge/routes/sudo');
const { Prefs } = require('../bridge/prefs');
const { NotificationLog } = require('../bridge/notifications');
const { sessionEnv } = require('../bridge/runner');

let pass = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok  ${name}\n`); };

const PASSWORD = 'correct horse battery staple';
const UID = process.getuid();

// Everything the bridge says, so the password can be looked for in it.
const said = [];
for (const k of ['log', 'warn', 'error', 'info']) {
    const orig = console[k];
    console[k] = (...a) => { said.push(a.map(String).join(' ')); if (k !== 'log') orig(...a); };
}

// ── argv ───────────────────────────────────────────────────────────────────

{
    const p = (s) => sudo.parseSudoArgv(s);
    let r = p(['sudo', '-A', 'apt', 'install', '-y', 'jq']);
    assert.deepStrictEqual([r.user, r.mode, r.command, r.runsShell], ['root', 'run', ['apt', 'install', '-y', 'jq'], false]);
    r = p(['sudo', '-Au', 'postgres', 'psql']);
    assert.deepStrictEqual([r.user, r.command], ['postgres', ['psql']]);
    r = p(['sudo', '-Aupostgres', 'psql']);
    assert.strictEqual(r.user, 'postgres', 'a value glued to its flag');
    r = p(['sudo', '-A', '-u', 'root', '-D', '/tmp', 'ls', 'a b']);
    assert.deepStrictEqual([r.chdir, r.command], ['/tmp', ['ls', 'a b']]);
    r = p(['sudo', '--user=bob', '--group', 'wheel', '--', '-weird']);
    assert.deepStrictEqual([r.user, r.group, r.command], ['bob', 'wheel', ['-weird']]);
    r = p(['sudo', '-A', '-s']);
    assert.deepStrictEqual([r.mode, r.runsShell], ['shell', true]);
    r = p(['sudo', '-iA']);
    assert.deepStrictEqual([r.mode, r.runsShell], ['login', true]);
    for (const cmd of [['bash', '-c', 'rm -rf /x'], ['/bin/sh'], ['env', 'FOO=1', 'zsh'], ['X=1', 'dash'], ['su', '-']]) {
        assert.strictEqual(p(['sudo', '-A', ...cmd]).runsShell, true, cmd.join(' '));
    }
    assert.strictEqual(p(['sudo', '-A', 'bashful']).runsShell, false);
    assert.strictEqual(sudo.shellQuote(['ls', 'a b', "it's"]), `ls 'a b' 'it'\\''s'`);
    ok('sudo argv: user, group, chdir, modes, and what counts as running a shell');
}

{
    // What Claude Code actually spawns for a Bash call, as seen in /proc.
    const wrapper = ['/bin/bash', '-c',
        "source /home/u/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && "
        + "shopt -u extglob 2>/dev/null || true && eval 'sudo -A true && echo '\\''hi'\\''' "
        + '< /dev/null && pwd -P >| /tmp/claude-1-cwd'];
    assert.strictEqual(sudo.bashContext(wrapper), "sudo -A true && echo 'hi'");
    assert.strictEqual(sudo.bashContext(['bash', '-c', 'make install']), 'make install');
    assert.strictEqual(sudo.bashContext(['node', 'x.js']), null);
    assert.strictEqual(sudo.bashContext(['bash']), null);
    ok('the Bash command a sudo is part of is unwrapped from Claude Code\'s shell');
}

// ── the key ────────────────────────────────────────────────────────────────

{
    const key = sudo.sessionKey('secret', 'abc-123');
    assert.strictEqual(sudo.keySession('secret', key), 'abc-123');
    assert.strictEqual(sudo.keySession('other', key), null, 'another bridge token');
    assert.strictEqual(sudo.keySession('secret', key.replace('abc-123', 'abc-124')), null, 'another session');
    assert.strictEqual(sudo.keySession('secret', key.slice(0, -1) + 'x'), null, 'a tampered mac');
    for (const bad of ['', 'nodot', '.', null, undefined, 42, 'x'.repeat(400)]) {
        assert.strictEqual(sudo.keySession('secret', bad), null, String(bad));
    }
    assert.ok(!key.includes('secret'));
    ok('a session key is bound to its session and the bridge token, and gives neither away');
}

// ── the environment ────────────────────────────────────────────────────────

{
    const on = sessionEnv({ sudo: { key: 'k.m', port: 45999 } });
    assert.strictEqual(on.SUDO_ASKPASS, sudo.HELPER);
    assert.strictEqual(on.TGXCODE_SUDO_KEY, 'k.m');
    assert.strictEqual(on.TGXCODE_SUDO_PORT, '45999');
    assert.strictEqual(on.TGXCODE_SUDO_NODE, process.execPath);
    assert.ok(fs.statSync(sudo.HELPER).mode & 0o111, 'the helper is executable');

    const saved = { ...process.env };
    Object.assign(process.env, { SUDO_ASKPASS: sudo.HELPER, TGXCODE_SUDO_KEY: 'inherited', TGXCODE_SUDO_PORT: '1' });
    const off = sessionEnv({});
    for (const k of ['SUDO_ASKPASS', 'TGXCODE_SUDO_KEY', 'TGXCODE_SUDO_PORT', 'TGXCODE_SUDO_NODE']) {
        assert.ok(!(k in off), `${k} is not set when off, even inherited`);
    }
    process.env.SUDO_ASKPASS = '/usr/bin/ssh-askpass';
    assert.strictEqual(sessionEnv({}).SUDO_ASKPASS, '/usr/bin/ssh-askpass', 'the user\'s own helper is left alone');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    ok('SUDO_ASKPASS and the key are set only when on, and stripped when inherited');
}

// ── a fake /proc ───────────────────────────────────────────────────────────

const PROC = path.join(TMP, 'proc');
fs.mkdirSync(PROC);

function fakeProc(pid, { name, ppid, uid = UID, euid = uid, argv = [], env = {}, cwd = null, start = '123' }) {
    const d = path.join(PROC, String(pid));
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'status'),
        `Name:\t${name}\nPPid:\t${ppid}\nUid:\t${uid}\t${euid}\t${euid}\t${euid}\n`);
    fs.writeFileSync(path.join(d, 'cmdline'), argv.map(a => a + '\0').join(''));
    fs.writeFileSync(path.join(d, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(''));
    fs.writeFileSync(path.join(d, 'stat'), `${pid} (${name}) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0`);
    if (cwd) fs.symlinkSync(cwd, path.join(d, 'cwd'));
}

// A Bash call (3000) running `sudo -A …` (3001), which ran the helper (3002).
function sudoTree(helperPid, sudoPid, key, { argv = ['sudo', '-A', 'apt', 'update'], sudoName = 'sudo', euid = 0 } = {}) {
    fakeProc(sudoPid - 1, { name: 'bash', ppid: 1, argv: ['/bin/bash', '-c', "x && eval 'sudo -A apt update && ls' < /dev/null"] });
    fakeProc(sudoPid, { name: sudoName, ppid: sudoPid - 1, euid, argv });
    fakeProc(helperPid, { name: 'node', ppid: sudoPid, env: { TGXCODE_SUDO_KEY: key }, cwd: '/srv/app' });
}

{
    const key = sudo.sessionKey('s', 'sess');
    sudoTree(3002, 3001, key);
    const info = sudo.readAsk(3002, key, { procRoot: PROC });
    assert.deepStrictEqual(info.argv, ['sudo', '-A', 'apt', 'update']);
    assert.strictEqual(info.command, 'apt update');
    assert.strictEqual(info.cwd, '/srv/app');
    assert.strictEqual(info.user, 'root');
    assert.strictEqual(info.context, 'sudo -A apt update && ls');
    assert.strictEqual(info.sudoPid, 3001);

    const refused = (fn, re) => assert.throws(fn, (e) => e.status >= 400 && re.test(e.message));
    refused(() => sudo.readAsk(3002, sudo.sessionKey('s', 'other'), { procRoot: PROC }), /not this session/);
    refused(() => sudo.readAsk(9999, key, { procRoot: PROC }), /not there/);
    refused(() => sudo.readAsk(3002, key, { procRoot: PROC, uid: UID + 1 }), /not yours/);
    // The agent calling the route itself: its parent is its shell, not sudo.
    fakeProc(3102, { name: 'node', ppid: 3000, env: { TGXCODE_SUDO_KEY: key } });
    refused(() => sudo.readAsk(3102, key, { procRoot: PROC }), /not started by sudo/);
    // A sudo-named process that is not running as root is not sudo.
    sudoTree(3202, 3201, key, { euid: UID });
    refused(() => sudo.readAsk(3202, key, { procRoot: PROC }), /not started by sudo/);
    // Nor is a setuid program that is not sudo, whatever its argv says.
    sudoTree(3302, 3301, key, { sudoName: 'passwd', argv: ['sudo', '-A', 'true'] });
    refused(() => sudo.readAsk(3302, key, { procRoot: PROC }), /not started by sudo/);
    ok('the command is read from the sudo process itself, and only a sudo child of the session is believed');
}

// ── the asks ───────────────────────────────────────────────────────────────

{
    const asks = new sudo.SudoAsks({ procRoot: PROC, sweepMs: 0 });
    const events = [];
    asks.on('ask', (p) => events.push(p));
    asks.on('resolved', (p) => events.push(p));
    const key = sudo.sessionKey('s', 'sess');
    sudoTree(4002, 4001, key);
    const info = sudo.readAsk(4002, key, { procRoot: PROC });

    let got = null;
    const a = asks.open('sess', info, (r) => { got = r; });
    assert.strictEqual(asks.forSession('sess').id, a.id);
    assert.strictEqual(events[0].kind, 'sudo');
    assert.strictEqual(events[0].attempt, 1);
    asks.approve(a.id, PASSWORD);
    assert.deepStrictEqual(got, { password: PASSWORD });
    assert.strictEqual(asks.forSession('sess'), null);
    assert.strictEqual(asks.approve(a.id, PASSWORD), false, 'only once');

    // sudo asking again is a wrong password.
    const b = asks.open('sess', info, (r) => { got = r; });
    assert.strictEqual(asks.publicAsk(b).attempt, 2);
    asks.deny(b.id);
    assert.deepStrictEqual(got, { denied: true, reason: 'denied' });

    const c = asks.open('sess', info, (r) => { got = r; });
    fs.rmSync(path.join(PROC, '4001'), { recursive: true });
    asks.sweep();
    assert.strictEqual(asks.get(c.id), null, 'gone with its sudo');
    assert.strictEqual(got.denied, true);
    assert.strictEqual(asks.tries.size, 0, 'and so is its retry count');

    const outcomes = events.filter(e => e.outcome).map(e => e.outcome);
    assert.deepStrictEqual(outcomes, ['approved', 'denied', 'cancelled']);
    assert.ok(!JSON.stringify(events).includes(PASSWORD), 'no event carries the password');
    ok('an ask is answered once, counts wrong passwords, and goes when its sudo does');
}

// ── the routes, with the real helper ───────────────────────────────────────

(async () => {
    auth.ensureToken();
    const prefs = new Prefs();
    prefs.save({ scope: 'user', patch: { sudo: { enabled: true } } });
    let viewers = 1;
    const asks = new sudo.SudoAsks({ procRoot: PROC, sweepMs: 0,
        allowRemote: () => routes.settings().allowRemote });
    const broadcasts = [];
    const notes = new NotificationLog();
    asks.on('ask', (p) => { broadcasts.push(['sudo-ask', p]); notes.ask(p); });
    asks.on('resolved', (p) => { broadcasts.push(['sudo-resolved', p]); notes.resolve(p.requestId, p.outcome); });
    routes.init({ prefs, pool: { hasViewer: () => viewers > 0 }, sudoAsks: asks, sudoProcRoot: PROC });

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const who = { remote: req.headers['x-test-remote'] === '1', ok: true };
        if (url.pathname === '/api/sudo/ask') return routes.helperAsk(req, res, who);
        const seg = url.pathname.split('/').filter(Boolean);
        const out = await routes.handle(req, res, url, url.pathname, seg, who);
        if (out !== undefined) { res.writeHead(404); res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
        const data = body === undefined ? '' : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, method, path: p,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
        (res) => {
            const c = []; res.on('data', d => c.push(d));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString() || '{}') }));
        });
        req.on('error', reject);
        req.end(data);
    });

    const sessionKey = sudo.sessionKey(auth.current(), 'sess-live');
    let nextSudo = 5001;

    // The real helper, as sudo would run it, with a fake sudo parent in /proc.
    // Its own pid is only known once it is spawned; node takes far longer to
    // start than the fake entries take to write.
    function helper({ key = sessionKey, argv } = {}) {
        const child = spawn(sudo.HELPER, ['[sudo] password for you: '], {
            env: { PATH: process.env.PATH, TGXCODE_SUDO_KEY: key, TGXCODE_SUDO_PORT: String(port),
                TGXCODE_SUDO_NODE: process.execPath },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const sudoPid = nextSudo; nextSudo += 10;
        sudoTree(child.pid, sudoPid, key, argv ? { argv } : {});
        const out = { stdout: '', stderr: '' };
        child.stdout.on('data', d => { out.stdout += d; });
        child.stderr.on('data', d => { out.stderr += d; });
        out.done = new Promise(r => child.on('exit', (code) => r(code)));
        out.child = child;
        return out;
    }
    const nextAsk = () => new Promise(r => asks.once('ask', r));
    const nextResolved = () => new Promise(r => asks.once('resolved', r));

    // Refusals before anything is shown.
    const k = { 'X-TGXCode-Sudo-Key': sessionKey };
    assert.strictEqual((await call('POST', '/api/sudo/ask', { pid: 1 })).status, 401, 'no key');
    assert.strictEqual((await call('POST', '/api/sudo/ask', { pid: 1 },
        { 'X-TGXCode-Sudo-Key': sudo.sessionKey('not-the-token', 'sess-live') })).status, 401, 'a forged key');
    assert.strictEqual((await call('POST', '/api/sudo/ask', { pid: 1 }, { ...k, 'X-Test-Remote': '1' })).status, 403, 'remote');
    assert.strictEqual((await call('POST', '/api/sudo/ask', { pid: process.pid }, k)).status, 403,
        'a pid that is not a sudo helper of this session');
    prefs.save({ scope: 'user', patch: { sudo: { enabled: false } } });
    assert.match((await call('POST', '/api/sudo/ask', { pid: 1 }, k)).body.error, /switched off/);
    prefs.save({ scope: 'user', patch: { sudo: { enabled: true } } });
    assert.strictEqual(asks.list().length, 0);
    ok('the ask route refuses no key, a forged key, a remote caller, a stray pid, and being off');

    // Approve: from the phone refused while allowRemote is off, then at the desk.
    {
        const shown = nextAsk();
        const h = helper({ argv: ['sudo', '-A', '-u', 'www-data', 'systemctl', 'restart', 'nginx'] });
        const ask = await shown;
        assert.strictEqual(ask.command, 'systemctl restart nginx');
        assert.strictEqual(ask.user, 'www-data');
        assert.strictEqual(ask.cwd, '/srv/app');
        assert.strictEqual(ask.remoteAnswer, false);
        const listed = (await call('GET', '/api/sudo')).body;
        assert.deepStrictEqual(listed.asks.map(a => a.id), [ask.id]);

        const phone = await call('POST', `/api/sudo/${ask.id}/answer`, { password: PASSWORD }, { 'X-Test-Remote': '1' });
        assert.strictEqual(phone.status, 403);
        assert.strictEqual(phone.body.remote, true);
        assert.strictEqual((await call('POST', `/api/sudo/${ask.id}/answer`, { password: 'two\nlines' })).status, 400);
        assert.ok(asks.get(ask.id), 'still waiting after both refusals');

        const ans = await call('POST', `/api/sudo/${ask.id}/answer`, { password: PASSWORD });
        assert.strictEqual(ans.status, 200);
        assert.strictEqual(await h.done, 0);
        assert.strictEqual(h.stdout, `${PASSWORD}\n`, 'the helper prints the password once, for sudo');
        assert.strictEqual((await call('POST', `/api/sudo/${ask.id}/answer`, { password: PASSWORD })).status, 409);
        ok('a phone cannot send the password while allowRemote is off; the desk can, once');
    }

    // With allowRemote on, the phone can.
    {
        prefs.save({ scope: 'user', patch: { sudo: { allowRemote: true } } });
        const shown = nextAsk();
        const h = helper();
        const ask = await shown;
        assert.strictEqual(ask.remoteAnswer, true);
        const phone = await call('POST', `/api/sudo/${ask.id}/answer`, { password: PASSWORD }, { 'X-Test-Remote': '1' });
        assert.strictEqual(phone.status, 200);
        assert.strictEqual(await h.done, 0);
        prefs.save({ scope: 'user', patch: { sudo: { allowRemote: null } } });
        ok('with allowRemote on, the phone may answer');
    }

    // Deny, from the phone — refusing grants nothing, so it is allowed.
    {
        const shown = nextAsk();
        const h = helper();
        const ask = await shown;
        const ended = nextResolved();
        assert.strictEqual((await call('POST', `/api/sudo/${ask.id}/deny`, {}, { 'X-Test-Remote': '1' })).status, 200);
        assert.strictEqual((await ended).outcome, 'denied');
        assert.strictEqual(await h.done, 1);
        assert.strictEqual(h.stdout, '', 'nothing on stdout for sudo to read');
        assert.match(h.stderr, /not approved \(denied\)\. Do not run it again/);
        ok('a deny exits the helper non-zero and tells the agent not to retry');
    }

    // Cancel: the Bash call is stopped, so the helper dies, and the card goes.
    {
        const shown = nextAsk();
        const h = helper();
        const ask = await shown;
        const ended = nextResolved();
        h.child.kill('SIGTERM');
        const r = await ended;
        assert.deepStrictEqual([r.id, r.outcome], [ask.id, 'cancelled']);
        assert.strictEqual(asks.list().length, 0);
        ok('killing the helper withdraws the ask');
    }

    // Nobody watching: refused at once rather than left to the Bash timeout.
    {
        viewers = 0;
        const h = helper();
        assert.strictEqual(await h.done, 1);
        assert.match(h.stderr, /nobody is watching/);
        viewers = 1;
        ok('with no window or phone watching, the ask is denied at once');
    }

    // The password went nowhere but the helper.
    {
        const everything = JSON.stringify(broadcasts) + JSON.stringify(notes.rows) + said.join('\n');
        assert.ok(!everything.includes(PASSWORD), 'not in an event, a notification row or a log line');
        assert.ok(broadcasts.some(([e]) => e === 'sudo-ask') && notes.rows.length > 0, 'and there were some');
        const files = [];
        const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, f.name);
            if (f.isDirectory()) walk(p); else if (f.isFile()) files.push(p);
        } };
        walk(TMP);
        for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(PASSWORD), `not in ${f}`);
        assert.ok(files.some(f => f.endsWith('settings.json')), 'the prefs file was among them');
        ok('the password is in no broadcast, notification, log line, prefs or other file');
    }

    server.close();
    asks.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    process.stdout.write(`sudo: ${pass} passed\n`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
