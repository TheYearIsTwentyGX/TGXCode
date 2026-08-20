'use strict';

// Runs the auth and remote-access tests.
//
//   npm test              — starts a bridge on a free port, runs everything, stops it
//   npm test -- 45901     — runs against a bridge you already have on that port
//
// It will not use 45888. That is the everyday instance, and these tests start and
// delete sessions.

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const UNIT = ['auth.test.js', 'temp.test.js', 'recent.test.js', 'pulls.test.js',
    'taskboard.test.js', 'ports.test.js', 'spinner.test.js'];
const LIVE = ['gate.test.js', 'browser.test.js', 'refusals.test.js', 'unpaired.test.js'];

const given = Number(process.argv[2]);
if (given === 45888) {
    console.error('45888 is the everyday bridge. Pick another port.');
    process.exit(2);
}

/**
 * Deliberately not bridge/ports.js, though it looks like the same helper.
 *
 * `listen(0)` asks the kernel, which needs no range, no denylist and no
 * reservation — it is simply better for what this does. And the harness should
 * not depend on the module the suite exercises: a bug in ports.js that stopped
 * the tests from starting would look like a passing run.
 */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

function health(port) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 900 },
            (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function waitFor(port, tries = 40) {
    for (let i = 0; i < tries; i++) {
        if (await health(port)) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

function run(file, port) {
    const out = spawnSync(process.execPath, [path.join(__dirname, file), String(port)],
        { stdio: 'inherit' });
    return out.status === 0;
}

(async () => {
    let failed = [];

    for (const file of UNIT) {
        if (!run(file, 0)) failed.push(file);
    }

    const port = given || await freePort();
    let bridge = null;

    if (!given) {
        bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
            cwd: ROOT,
            env: { ...process.env, CLAUDE_SESSIONS_PORT: String(port) },
            stdio: 'ignore',
        });
        if (!await waitFor(port)) {
            console.error(`bridge never came up on ${port}`);
            bridge.kill();
            process.exit(1);
        }
        console.log(`\n(started a bridge on ${port})`);
    } else if (!await health(port, 4)) {
        console.error(`nothing answering on ${port}`);
        process.exit(1);
    }

    try {
        for (const file of LIVE) {
            if (!run(file, port)) failed.push(file);
        }
    } finally {
        if (bridge) bridge.kill();
    }

    console.log(failed.length
        ? `\nFAILED: ${failed.join(', ')}`
        : '\nEverything passed.');
    process.exit(failed.length ? 1 : 0);
})();
