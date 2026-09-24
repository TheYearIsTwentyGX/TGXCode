'use strict';

// Which session a listening port belongs to.
//
// No bridge needed, but real processes: each case starts a `node` listener with
// a chosen environment and working directory, because /proc/<pid>/environ and
// /proc/<pid>/cwd are the whole of the mechanism and a stub would test nothing.
//
// The failure this guards against is a chip in the wrong session. It never
// throws and it looks plausible, so nobody reports it as a bug until it has
// happened a dozen times. So the cases are the ways it used to go wrong. Two
// sessions sharing one checkout. A DevBrowser title left over from someone
// else's server. A dead port that the session only ever grepped for.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { enrich, sessionOf } = require('../bridge/devservers.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgxcode-devservers-'));
const workspace = (name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
};

// This file is usually run by an agent, so its own environment carries a
// session id. Every child starts from a copy with both names removed.
const cleanEnv = () => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.TGXCODE_SESSION_ID;
    return env;
};

const bindable = (port) => new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

/** A free port below the kernel's ephemeral range, which is what a person picks. */
async function chosenPort() {
    for (let i = 0; i < 200; i++) {
        const port = 20000 + Math.floor(Math.random() * 10000);
        if (await bindable(port)) return port;
    }
    throw new Error('no free port in 20000-29999');
}

/** A listener in `cwd` with `env`, resolved once it is accepting. */
function serve(port, cwd, env) {
    const child = spawn(process.execPath, ['-e', `
        require('http').createServer((q, r) => r.end('ok'))
            .listen(${port}, '127.0.0.1', () => console.log('ready'));
        setInterval(() => {}, 1e6);
    `], { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.stdout.once('data', () => resolve(child));
    });
}

const kill = (child) => new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
});

const shown = (out, port) => out.ports.find(p => p.port === port) || null;

// What detect() would have produced for a session that typed `--port N`.
const typed = (port) => ({ port, score: 70, title: null, source: 'port-flag', ts: null,
    evidence: null, background: true, startedTs: null, killedTs: null });

(async () => {
    const shared = workspace('main');
    const other = workspace('other');

    assert.strictEqual(sessionOf(2 ** 22 + 12345), null);
    ok('sessionOf of a pid that does not exist is null');

    // -- two sessions, one checkout ------------------------------------------
    const port = await chosenPort();
    const a = await serve(port, shared, { ...cleanEnv(), CLAUDE_CODE_SESSION_ID: 'session-a' });
    assert.strictEqual(sessionOf(a.pid), 'session-a');
    ok('sessionOf reads the session a process was started by');

    const forA = await enrich([], {}, { id: 'session-a', workspace: shared });
    const chip = shown(forA, port);
    assert.ok(chip, 'the session that started it was not shown its own server');
    assert.strictEqual(chip.ours, true);
    assert.strictEqual(chip.session, 'session-a');
    assert.strictEqual(chip.source, 'process');
    assert.strictEqual(chip.listening, true);
    ok('a server is found from the socket table, with no transcript evidence at all');

    const forB = await enrich([typed(port)], {}, { id: 'session-b', workspace: shared });
    assert.strictEqual(shown(forB, port), null,
        'a second session in the same checkout was shown the first one\'s server');
    assert.strictEqual(forB.elsewhere, 1);
    ok('another session in the same checkout does not get it, even having typed its port');

    // -- DevBrowser titles do not vote ---------------------------------------
    const titled = await enrich([], { [port]: 'someone-elses-worktree' },
        { id: 'session-a', workspace: shared, worktreeName: 'main' });
    assert.ok(shown(titled, port), 'a stale DevBrowser title hid a server from its own session');
    assert.strictEqual(shown(titled, port).title, 'someone-elses-worktree');
    assert.strictEqual(shown(titled, port).titledElsewhere, false);
    ok('a DevBrowser title names the chip and decides nothing');

    // -- a dead port remembers who held it -----------------------------------
    await kill(a);
    const deadForB = await enrich([typed(port)], {}, { id: 'session-b', workspace: shared });
    assert.strictEqual(shown(deadForB, port), null,
        'a session that only named the port was offered "the server you started is gone"');
    const deadForA = await enrich([typed(port)], {}, { id: 'session-a', workspace: shared });
    assert.ok(shown(deadForA, port), 'the session that did start it lost its stopped chip');
    assert.strictEqual(shown(deadForA, port).listening, false);
    ok('once it stops, it is history for the session that ran it and nobody else');

    // -- no session in the environment: the directory decides ----------------
    const port2 = await chosenPort();
    const byHand = await serve(port2, shared, cleanEnv());
    assert.strictEqual(sessionOf(byHand.pid), null);
    const here = await enrich([typed(port2)], {}, { id: 'session-c', workspace: shared });
    assert.ok(shown(here, port2) && shown(here, port2).ours, 'cwd fallback did not claim it');
    const there = await enrich([typed(port2)], {}, { id: 'session-c', workspace: other });
    assert.strictEqual(shown(there, port2), null);
    assert.strictEqual(there.elsewhere, 1);
    const unclaimed = await enrich([], {}, { id: 'session-c', workspace: shared });
    assert.strictEqual(shown(unclaimed, port2), null,
        'a server nobody\'s session started was claimed without the transcript naming it');
    ok('a server started by hand belongs to the workspace it runs in, on the transcript\'s word');
    await kill(byHand);

    // -- a session's own terminal pane outranks what the bridge inherited ----
    const port3 = await chosenPort();
    const pane = await serve(port3, shared, {
        ...cleanEnv(), CLAUDE_CODE_SESSION_ID: 'the-bridges-parent', TGXCODE_SESSION_ID: 'session-d',
    });
    assert.strictEqual(sessionOf(pane.pid), 'session-d');
    assert.ok(shown(await enrich([], {}, { id: 'session-d', workspace: shared }), port3));
    assert.strictEqual(
        shown(await enrich([], {}, { id: 'the-bridges-parent', workspace: shared }), port3), null);
    ok('TGXCODE_SESSION_ID wins over an inherited CLAUDE_CODE_SESSION_ID');
    await kill(pane);

    // -- a port nobody chose is not a dev server -----------------------------
    const random = await serve(0, shared, { ...cleanEnv(), CLAUDE_CODE_SESSION_ID: 'session-e' });
    const found = await enrich([], {}, { id: 'session-e', workspace: shared });
    assert.strictEqual(found.ports.filter(p => p.source === 'process').length, 0,
        'a listen(0) port was offered as a dev server');
    ok('a kernel-assigned port is not picked up from the socket table alone');
    await kill(random);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`devservers: ${pass} passed`);
})().catch((err) => {
    console.error(err);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
});
