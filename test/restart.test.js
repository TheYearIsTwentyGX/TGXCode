'use strict';

// What scripts/restart-bridge.sh does when there is nobody to ask.
//
// It runs from cron at midnight, and cron has no controlling terminal. The
// dirty-checkout prompt reads /dev/tty, could not open it, took the failure for
// a "no", and exited 1 saying "Left the bridge alone." — the same words and the
// same status as a person declining, on a checkout that is dirty most nights.
// So the nightly restart silently did nothing, and nothing said so.
//
// Everything here runs a *copy* of the script in a throwaway git repo — $REPO
// comes from BASH_SOURCE, so the copy has to live in one — against a port with
// nothing on it, with XDG_CACHE_HOME pointed somewhere disposable and a stub
// bridge/launch.sh in place of the real one. Nothing here can reach the everyday
// port, the real launcher, or the user's cache.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-restart-'));
const REPO = path.join(TMP, 'repo');
const CACHE = path.join(TMP, 'cache');
const SCRIPT = path.join(REPO, 'scripts', 'restart-bridge.sh');
const journalFile = (port) => path.join(CACHE, 'claude-sessions', `restart-${port}.log`);

/** git with none of this machine's config, signing, hooks or identity. */
function git(...args) {
    const out = spawnSync('git', ['-C', REPO, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
            GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
        },
    });
    assert.strictEqual(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout;
}

/** A port with nothing on it: the kernel picks one, we hand it straight back. */
const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
    });
});

/** The health JSON of whatever is on `port`, or null if nothing is. */
const health = (port) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 900 },
        (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
});

/** Stop the stub bridge a restart case left running, so the next case starts clean. */
async function stopStub(port) {
    const h = await health(port);
    if (!h || !h.pid) return;
    try { process.kill(h.pid, 'SIGKILL'); } catch { /* already gone */ }
    for (let i = 0; i < 20 && await health(port); i++) {
        await new Promise((r) => setTimeout(r, 50));
    }
}

/**
 * Run the script with no controlling terminal, the way cron does.
 *
 * `detached: true` is the whole reason this file can exist: Node calls setsid(2)
 * in the child, and a process in a fresh session has no controlling terminal, so
 * `(exec </dev/tty)` fails there. Redirecting stdin would not do it — /dev/tty is
 * not stdin, it is whatever terminal the process belongs to, and `npm test` run
 * from a real terminal hands that straight down to the child. Without this the
 * script would reach a live `Continue? [y/N]` with nobody to answer it and hang
 * the whole suite; the assertion below is there to catch it if that ever breaks.
 *
 * The timer is the belt to that brace. The kill is aimed at -pid because a
 * detached child is the leader of its own process group.
 */
function run(argv, port) {
    return new Promise((resolve) => {
        const child = spawn('bash', argv, {
            cwd: os.tmpdir(),          // irrelevant on purpose: $REPO comes from BASH_SOURCE
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CLAUDE_SESSIONS_PORT: String(port), XDG_CACHE_HOME: CACHE },
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const timer = setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }, 20000);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, out, err });
        });
    });
}
const script = (args, port) => run([SCRIPT, ...args], port);

const journal = (port) => {
    try { return fs.readFileSync(journalFile(port), 'utf8'); } catch { return ''; }
};
const countLines = (text, re) => text.split('\n').filter((l) => re.test(l)).length;

// A bridge that only answers /api/health, so the cases that do restart finish in
// about a second instead of running out the script's thirty-second poll.
const STUB_LAUNCH = `#!/usr/bin/env bash
exec node -e '
const http = require("http");
http.createServer((q, s) => {
  s.writeHead(200, { "content-type": "application/json" });
  s.end(JSON.stringify({ ok: true, pid: process.pid, sessions: 7, clients: 0, busy: 0 }));
}).listen(Number(process.env.CLAUDE_SESSIONS_PORT), "127.0.0.1");
'
`;

// Set as soon as there is a port, so the cleanup at the foot can always reach a
// stub a failed assertion left running. A detached node server outliving the
// suite is exactly the kind of litter this repo's CLAUDE.md is about.
let PORT = 0;

(async () => {
    PORT = await freePort();
    assert.notStrictEqual(PORT, 45888, 'never the everyday bridge');

    fs.mkdirSync(path.join(REPO, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(REPO, 'bridge'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'restart-bridge.sh'), SCRIPT);
    fs.writeFileSync(path.join(REPO, 'bridge', 'launch.sh'), STUB_LAUNCH, { mode: 0o755 });
    fs.writeFileSync(path.join(REPO, 'bridge', 'server.js'), '// committed\n');
    fs.writeFileSync(path.join(REPO, 'README.md'), 'committed\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'first');

    // --- the harness has to be as blind as cron is --------------------------
    // If this fails, every dirty case below would sit on a real prompt forever.
    const probe = await run(['-c',
        'if (exec </dev/tty) 2>/dev/null; then echo tty; else echo notty; fi'], PORT);
    assert.strictEqual(probe.out.trim(), 'notty',
        'this child can open a terminal, so the dirty cases would block on a real prompt');
    ok('the child runs with no controlling terminal, as cron does');

    // --- --status still works with nothing listening ------------------------
    // The path `set -e` would kill: `CURRENT="$(health)"` exits non-zero here.
    const st = await script(['--status'], PORT);
    assert.strictEqual(st.code, 0, st.err);
    assert.match(st.out, /not running/);
    assert.strictEqual(fs.existsSync(journalFile(PORT)), false,
        '--status changes nothing, so it should leave no journal line');
    ok('--status reports a dead port, exits 0, and journals nothing');

    // --- a typo is still refused, and still before anything is journalled ---
    const bad = await script(['--yolo'], PORT);
    assert.strictEqual(bad.code, 1);
    assert.match(bad.err, /unknown option/);
    assert.strictEqual(fs.existsSync(journalFile(PORT)), false);
    ok('an unknown option exits 1 and journals nothing');

    // --- the nightly case: uncommitted code, nobody to ask ------------------
    fs.appendFileSync(path.join(REPO, 'bridge', 'server.js'), 'half-finished edit\n');
    const skip = await script([], PORT);
    assert.strictEqual(skip.code, 3,
        `wanted the skip status, got ${skip.code}/${skip.signal}: ${skip.err}`);
    assert.match(skip.err, /no terminal to ask at/);
    assert.doesNotMatch(skip.out, /Continue\?/,
        'it must not print a prompt it cannot read the answer to');
    assert.doesNotMatch(skip.out, /Nothing was listening|Stopped pid/,
        'it must stop at the dirty check, well short of starting anything');
    assert.strictEqual(await health(PORT), null, 'nothing should have been started');
    ok('uncommitted bridge/ with nobody to ask is exit 3, not a silent exit 1');

    let j = journal(PORT);
    assert.match(j, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[\d+\] start /m);
    assert.match(j, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[\d+\] skipped-dirty 1 uncommitted/m);
    ok('and the journal says so, timestamped, one word for the outcome');

    // --- the journal is a record, not a snapshot ----------------------------
    await script([], PORT);
    j = journal(PORT);
    assert.strictEqual(countLines(j, /\] start /), 2, 'the second run must append, not replace');
    assert.strictEqual(countLines(j, /\] skipped-dirty /), 2);
    ok('a second run appends rather than truncating — several nights are recoverable');

    // --- --yes is the way past it -------------------------------------------
    const yes = await script(['--yes'], PORT);
    assert.strictEqual(yes.code, 0, `--yes should restart: ${yes.err}`);
    assert.match(yes.out, /1 of them under bridge\/ — loading those, as asked/);
    assert.match(yes.out, new RegExp(`Bridge :${PORT} up`));
    assert.match(journal(PORT), /\] restarted pid=\d+ dirty-bridge=1 rev=\S+/,
        'the journal should record that it loaded uncommitted code');
    await stopStub(PORT);
    ok('--yes loads the uncommitted bridge/ changes and says so in the journal');

    // --- the branch the whole change turns on -------------------------------
    // Dirty, but nothing the bridge loads: web/ is read per request and docs are
    // read by nobody, so there is nothing here for a restart to get wrong. This
    // used to be a skip, which is how the nightly run came to be a no-op.
    git('checkout', '-q', '--', 'bridge/server.js');
    fs.appendFileSync(path.join(REPO, 'README.md'), 'a docs edit\n');
    const docs = await script([], PORT);
    assert.strictEqual(docs.code, 0,
        `a dirty README must not stop the restart: ${docs.err}`);
    assert.match(docs.out, /None of them under bridge\//);
    assert.match(docs.out, new RegExp(`Bridge :${PORT} up`));
    const lastRestart = journal(PORT).split('\n').filter((l) => / restarted /.test(l)).pop();
    assert.match(lastRestart, /\] restarted pid=\d+ rev=\S+/);
    assert.doesNotMatch(lastRestart, /dirty-bridge/,
        'this restart loaded no uncommitted code, so it should not claim to have');
    await stopStub(PORT);
    ok('a dirty README no longer blocks the nightly restart');

    // --- the help range is a line number, and drifts silently ---------------
    const h = await script(['-h'], PORT);
    assert.strictEqual(h.code, 0);
    assert.match(h.out, /^Restart the everyday bridge/);
    assert.match(h.out, /--yes/);
    assert.match(h.out, /exit 3/);
    assert.match(h.out, /Deliberately narrow/);
    assert.doesNotMatch(h.out, /#!|BASH_SOURCE|set -uo/,
        'the sed range has drifted past the end of the header');
    ok('--help prints the whole header and stops where the header does');

    console.log(`\n${pass} groups passed`);
})().then(
    async () => { await cleanup(); },
    async (e) => { console.error(e); await cleanup(); process.exit(1); },
);

async function cleanup() {
    if (PORT) await stopStub(PORT);
    fs.rmSync(TMP, { recursive: true, force: true });
}
