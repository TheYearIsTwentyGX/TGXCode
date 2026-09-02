'use strict';

// What bridge/launch.sh puts on PATH — and what it says when it cannot.
//
// This file exists because of the most expensive quiet failure this repo has
// had. The nightly cron entry restarts the bridge, and cron runs a job non-login
// *and* non-interactive: it reads neither ~/.profile nor ~/.bashrc, so it hands
// the script `PATH=/usr/bin:/bin`. `claude` lives in ~/.local/bin, which only
// those two files put on PATH. launch.sh had always rescued node — the reason
// the file exists at all — and nothing rescued `claude`, so every midnight the
// bridge came back looking perfect and could not start a single turn.
//
// Hermetic on purpose: a fake HOME with a fake `claude` in it, rather than
// asserting anything about the machine the suite happens to run on. The bug was
// never about which paths exist here; it was about which of them the script
// bothers to look in. node is the one thing borrowed from the real environment,
// prepended to the stripped PATH so find_node has something to find — otherwise
// every case below would fail at exit 127 for the wrong reason.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const LAUNCH = path.resolve(__dirname, '../bridge/launch.sh');
// Where the node running this test lives. `env -i` throws PATH away, and
// find_node's nvm fallback looks under $NVM_DIR — which points into the fake
// HOME below and is deliberately empty.
const NODE_DIR = path.dirname(process.execPath);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const roots = [];
function fakeHome({ withClaude }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-test-'));
    roots.push(home);
    if (withClaude) {
        const bin = path.join(home, '.local', 'bin');
        fs.mkdirSync(bin, { recursive: true });
        // Contents are never run — --check only reports where it landed.
        fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    return home;
}

/** `launch.sh --check` as cron would run it: a thin PATH and no profile read. */
function check(home) {
    return execFileSync('bash', [LAUNCH, '--check'], {
        encoding: 'utf8',
        // The whole environment, replaced. Anything inherited from the shell
        // running this suite would be the thing the test is trying not to have.
        env: { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin`, SHELL: '/bin/bash' },
    });
}

try {
    // --- the cron case ----------------------------------------------------
    {
        const home = fakeHome({ withClaude: true });
        const out = check(home);

        assert.match(out, /\/node v\d+/, 'it still has to find node — that half always worked');
        ok('--check finds node under a stripped PATH');

        assert.match(out, new RegExp(`^claude ${path.join(home, '.local', 'bin', 'claude')}$`, 'm'),
            'a bridge started by cron has to find ~/.local/bin/claude, or it can serve '
            + 'transcripts and nothing else');
        ok('--check finds ~/.local/bin/claude with only /usr/bin:/bin on PATH');
    }

    // --- and the PATH the bridge actually starts with ---------------------
    // The case above is about the *report*, and passes even with the PATH work
    // deleted — `find_claude` looks in ~/.local/bin directly, whatever PATH says.
    // This one is about the thing sessions depend on: `sessionEnv()` hands each
    // one the bridge's own environment, so an agent that cannot find npm, gh or
    // claude is an agent that cannot do its job. A stub node prints the PATH it
    // was handed, which is precisely what the bridge process would have had.
    {
        const home = fakeHome({ withClaude: true });
        const fakeBin = path.join(home, 'fakebin');
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.writeFileSync(path.join(fakeBin, 'node'),
            '#!/bin/sh\nprintf %s "$PATH"\nexit 0\n', { mode: 0o755 });

        const r = spawnSync('bash', [LAUNCH], {
            encoding: 'utf8',
            env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/bash' },
            timeout: 20000,
        });

        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(r.stdout.split(':').includes(path.join(home, '.local', 'bin')),
            'the bridge — and so every session it starts — has to have ~/.local/bin on '
            + `PATH. Got: ${r.stdout}`);
        ok('the bridge starts with ~/.local/bin on PATH, for the sessions that inherit it');

        // Once, not once per restart: bridge/restart.js relaunches the bridge as
        // its own child, so a PATH that grew a copy each time would grow without
        // bound across a month of nightly restarts.
        const again = spawnSync('bash', [LAUNCH], {
            encoding: 'utf8',
            env: { HOME: home, PATH: r.stdout, SHELL: '/bin/bash' },
            timeout: 20000,
        });
        assert.strictEqual(again.stdout, r.stdout,
            'a relaunch inheriting the fixed PATH must not prepend it again');
        ok('and does not prepend it twice when a restart inherits it');
    }

    // --- and says so when it is really not there --------------------------
    // Without this the case above proves nothing: a script that printed a path
    // unconditionally would pass it.
    {
        const out = check(fakeHome({ withClaude: false }));
        assert.match(out, /^claude NOT FOUND$/m,
            'the report has to be a report, not a guess');
        ok('--check says NOT FOUND when there is no claude to find');
    }

    // --- a missing claude is not a refusal to start -----------------------
    // Deliberate, and the opposite of what it looks like. restart-bridge.sh has
    // already killed the running bridge by the time it calls launch.sh, so
    // exiting here would turn "a bridge that cannot start turns" into no bridge
    // at all — discovered the next morning, with the journal reading
    // `failed-start`. It warns on stderr instead, and /api/health carries
    // `claudeBin` so the window and the journal can both tell.
    {
        const home = fakeHome({ withClaude: false });

        // --check returns before the warning, so this has to drive the real path,
        // which ends in `exec node bridge/server.js`. A stub node that exits
        // immediately stands in for the bridge: no port is named, nothing binds,
        // and there is no way for this case to reach the everyday instance. That
        // matters more than the brevity of the alternative — a test that starts a
        // real server is one bad default away from being the accident the rest of
        // this repo is arranged to prevent.
        const fakeBin = path.join(home, 'fakebin');
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.writeFileSync(path.join(fakeBin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const r = spawnSync('bash', [LAUNCH], {
            encoding: 'utf8',
            env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/bash' },
            timeout: 20000,
        });

        assert.notStrictEqual(r.status, 127,
            'exit 127 is the no-node refusal; a missing claude must not borrow it');
        assert.strictEqual(r.status, 0, 'it went on to start the bridge');
        assert.match(r.stderr, /no 'claude' found/,
            'it has to say so out loud — this failing silently is the whole bug');
        assert.match(r.stderr, /Starting anyway/,
            'and say that it is starting regardless, so the warning is not read as a refusal');
        ok('a missing claude warns loudly and does not stop the bridge starting');
    }

    console.log(`\n${pass} launch checks passed`);
} finally {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
}
