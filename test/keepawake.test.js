'use strict';

// Holding off sleep while an agent works — bridge/keepawake.js.
//
// No bridge needed, and no real process: a stub spawn records what it was asked
// to run and hands back a fake child, and a fake clock drives the linger. Two
// things are worth guarding and neither shows up in a window you are looking at:
//
//   - **What gets spawned on which host.** The host is forced with
//     TGXCODE_HOST_KIND, as test/platform.test.js does, so the Windows branch is
//     checked from a Linux box and the other way round. The command has to keep
//     its stdin watchdog: a plain sleep looks the same until the bridge is
//     SIGKILLed and the lock outlives it.
//   - **When it lets go.** A lock that never releases keeps a laptop awake in a
//     bag, and nobody would connect that to a checkbox in Settings.

const assert = require('assert');
const { EventEmitter } = require('events');
const { KeepAwake, command, LINGER_MS, RETRY_MS } = require('../bridge/keepawake.js');
const platform = require('../bridge/platform.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

function fake({ kind = 'wsl', inhibit = true } = {}) {
    let now = 1_000_000;
    const timers = [];
    const spawned = [];
    const ka = new KeepAwake({
        now: () => now,
        setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
        clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
        hostKind: platform.hostKind,
        hasInhibit: () => inhibit,
        spawn: (bin, args, opts) => {
            const child = new EventEmitter();
            child.stdin = new EventEmitter();
            child.killed = false;
            child.kill = () => { child.killed = true; };
            spawned.push({ bin, args, opts, child });
            return child;
        },
    });
    process.env.TGXCODE_HOST_KIND = kind;
    const advance = (ms) => {
        now += ms;
        for (const t of timers.filter(x => x.at <= now)) {
            timers.splice(timers.indexOf(t), 1);
            t.fn();
        }
    };
    return { ka, spawned, advance };
}

const saved = process.env.TGXCODE_HOST_KIND;
try {
    // --- what gets spawned ----------------------------------------------------
    {
        const { ka, spawned } = fake({ kind: 'wsl' });
        ka.update({ enabled: true, working: true, reason: '1 agent working' });
        assert.strictEqual(spawned.length, 1);
        const { bin, args, opts } = spawned[0];
        assert.strictEqual(bin, 'powershell.exe');
        assert.deepStrictEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
        assert.match(args[3], /SetThreadExecutionState\(\[uint32\]2147483649\)/,
            'ES_CONTINUOUS | ES_SYSTEM_REQUIRED, and not the display');
        assert.match(args[3], /\[Console\]::In\.ReadLine\(\)/, 'the stdin watchdog');
        assert.strictEqual(opts.stdio[0], 'pipe', 'stdin must be a pipe for the watchdog to see EOF');
        assert.ok(!opts.detached, 'a detached lock would outlive its bridge');
        assert.deepStrictEqual(ka.status(), {
            enabled: true, holding: true, since: 1_000_000,
            reason: '1 agent working', lingerUntil: null,
        });
        ok('under WSL it spawns powershell.exe holding ES_SYSTEM_REQUIRED, with the stdin watchdog');
    }
    {
        const { ka, spawned } = fake({ kind: 'linux', inhibit: true });
        ka.update({ enabled: true, working: true });
        assert.strictEqual(spawned.length, 1);
        assert.strictEqual(spawned[0].bin, 'systemd-inhibit');
        assert.ok(spawned[0].args.includes('--what=sleep:idle'));
        assert.ok(spawned[0].args.includes('--mode=block'));
        assert.strictEqual(spawned[0].args[spawned[0].args.length - 1], 'cat',
            '`cat` exits on EOF; `sleep infinity` would not');
        ok('on a Linux host it spawns systemd-inhibit around cat');
    }
    {
        const { ka, spawned } = fake({ kind: 'linux', inhibit: false });
        ka.update({ enabled: true, working: true });
        assert.strictEqual(spawned.length, 0);
        assert.strictEqual(ka.status().holding, false);
        assert.strictEqual(ka.status().unsupported, 'systemd-inhibit not found');
        assert.deepStrictEqual(command('linux', false), { unsupported: 'systemd-inhibit not found' });
        ok('on a Linux host without systemd-inhibit nothing spawns, and status says why');
    }
    {
        const { ka, spawned } = fake();
        ka.update({ enabled: false, working: true });
        assert.strictEqual(spawned.length, 0);
        assert.strictEqual(ka.status().holding, false);
        ok('off, nothing spawns however busy it is');
    }

    // --- acquire, linger, release ----------------------------------------------
    {
        const { ka, spawned, advance } = fake();
        ka.update({ enabled: true, working: true, reason: '1 agent working' });
        ka.update({ enabled: true, working: true, reason: '2 agents working' });
        ka.update({ enabled: true, working: true, reason: '2 agents working' });
        assert.strictEqual(spawned.length, 1, 'one lock however often it is asked');
        assert.strictEqual(ka.status().reason, '2 agents working',
            'the count updates without a respawn');

        ka.update({ enabled: true, working: false });
        assert.strictEqual(ka.status().holding, true, 'held through the linger');
        assert.strictEqual(ka.status().lingerUntil, 1_000_000 + LINGER_MS);
        advance(LINGER_MS - 1);
        assert.strictEqual(spawned[0].child.killed, false);

        // A turn inside the linger keeps the same child.
        ka.update({ enabled: true, working: true, reason: '1 agent working' });
        assert.strictEqual(ka.status().lingerUntil, null);
        advance(LINGER_MS * 2);
        assert.strictEqual(spawned[0].child.killed, false, 'the linger was cancelled');
        assert.strictEqual(spawned.length, 1);

        ka.update({ enabled: true, working: false });
        ka.update({ enabled: true, working: false });
        advance(LINGER_MS);
        assert.strictEqual(spawned[0].child.killed, true);
        assert.strictEqual(ka.status().holding, false);
        // The kill's own exit event must not be read as a crash.
        spawned[0].child.emit('exit', null, 'SIGTERM');
        assert.strictEqual(ka.status().error, undefined);
        ok('acquires once, lingers after the last turn, a new turn cancels the linger, then releases');
    }
    {
        const { ka, spawned } = fake();
        ka.update({ enabled: true, working: true });
        ka.update({ enabled: false, working: true });
        assert.strictEqual(spawned[0].child.killed, true);
        assert.strictEqual(ka.status().holding, false);
        ok('turning it off releases at once, mid-turn');
    }
    {
        const { ka, spawned, advance } = fake();
        ka.update({ enabled: true, working: true });
        spawned[0].child.emit('exit', 1, null);
        assert.strictEqual(ka.status().holding, false);
        assert.match(ka.status().error, /powershell\.exe exited \(1\)/);
        ka.update({ enabled: true, working: true });
        advance(RETRY_MS - 1);
        ka.update({ enabled: true, working: true });
        assert.strictEqual(spawned.length, 1, 'no respawn inside the retry window');
        advance(1);
        ka.update({ enabled: true, working: true });
        assert.strictEqual(spawned.length, 2);
        assert.strictEqual(ka.status().error, undefined);
        ok('a child that dies by itself is reported, and retried no sooner than a minute later');
    }
    {
        const { ka, spawned } = fake();
        ka.update({ enabled: true, working: true });
        spawned[0].child.emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' }));
        assert.strictEqual(ka.status().error, 'powershell.exe not found on PATH');
        ok('a missing binary says so');
    }
    {
        const { ka, spawned } = fake();
        ka.update({ enabled: true, working: true });
        ka.shutdown();
        assert.strictEqual(spawned[0].child.killed, true);
        assert.strictEqual(ka.status().holding, false);
        ok('shutdown kills the child');
    }
} finally {
    if (saved === undefined) delete process.env.TGXCODE_HOST_KIND;
    else process.env.TGXCODE_HOST_KIND = saved;
}

console.log(`\n${pass} keepawake checks passed`);
