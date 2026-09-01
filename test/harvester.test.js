'use strict';

// scripts/quota-statusline.py, on its own.
//
// This suite exists because of where the logic lives and how it fails. The
// freshness arbitration — which of several disagreeing writers gets to set the
// shared quota file — is in the Python, so test/usage.test.js cannot reach it.
// And the harvester swallows every exception by design, because it runs on
// somebody's shell prompt and a traceback where the status line should be is
// worse than no quota pill. A bug in it is therefore silent by construction:
// nothing throws, nothing logs, the pill just quietly shows the wrong number.
// The only way to find one is here.
//
// Each case runs the real script with XDG_DATA_HOME pointed at a throwaway
// directory and a crafted status-line payload on stdin, then reads back what it
// wrote. No bridge, no CLI.
//
// **Not covered here:** actually spawning a beacon. That needs a directory the
// user has trusted and costs a real API call, so it stays a manual check — see
// docs/plans/05-usage-and-quota.md and the note in test/usage.test.js.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'quota-statusline.py');

// A run on Windows is a real scenario (scripts/win.js exists), and a suite that
// cannot run is not a suite that failed.
const probe = spawnSync('python3', ['-c', 'pass'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
    console.log('SKIPPED: no python3 on PATH — the harvester could not be exercised.');
    process.exit(0);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-harvester-'));
const STATE = path.join(home, 'claude-sessions');
const FILE = path.join(STATE, 'quota-statusline.json');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** One render. Returns {stdout, file} where file is the parsed harvest file. */
function render(payload, args = []) {
    const r = spawnSync('python3', [SCRIPT, ...args], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, XDG_DATA_HOME: home },
    });
    assert.strictEqual(r.status, 0, `the harvester must always exit 0: ${r.stderr}`);
    return { stdout: r.stdout, file: read() };
}

function read() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

function write(body) {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(body));
}

function reset() {
    fs.rmSync(STATE, { recursive: true, force: true });
    fs.mkdirSync(STATE, { recursive: true });
}

const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;

/** A live, working terminal: it has made API calls, so its numbers are current. */
function live(windows, extra = {}) {
    return {
        session_id: 'live-session',
        cost: { total_duration_ms: 60_000, total_api_duration_ms: 12_000 },
        model: { display_name: 'Opus 5' },
        rate_limits: windows,
        ...extra,
    };
}

/**
 * An orphaned beacon: 28 hours old, never sent a message, so `api` is 0 and its
 * rate_limits are the ones its startup prefetch fetched 28 hours ago. This is
 * the exact shape of pids 155420, 159395, 160286 and 162199.
 */
function zombie(windows) {
    return {
        session_id: 'zombie-session',
        cost: { total_duration_ms: 100_000_000, total_api_duration_ms: 0 },
        model: { display_name: 'Opus 5' },
        rate_limits: windows,
    };
}

// --- writing a first reading --------------------------------------------

{
    reset();
    const t = now();
    const { file } = render(live({
        five_hour: { used_percentage: 25, resets_at: t + 2 * HOUR },
        seven_day: { used_percentage: 3, resets_at: t + 5 * 86400 },
    }));

    assert.strictEqual(file.version, 1, 'still version 1 — see the note in save()');
    assert.strictEqual(file.windows.five_hour.used_percentage, 25);
    assert.strictEqual(file.windows.seven_day.used_percentage, 3);
    assert.ok(Math.abs(file.observedAt.five_hour - t) <= 5, 'stamped now');
    assert.strictEqual(file.capturedAt, Math.max(...Object.values(file.observedAt)));

    ok('a first reading is written with a per-window timestamp');
}

// --- the bug, replayed ---------------------------------------------------

{
    // The whole reason this file exists. A fresh reading is on disk; an
    // orphaned beacon then renders with a 28-hour-old snapshot that has lost
    // its five-hour window (that window's reset passed long ago, so the CLI
    // dropped it). Before this change the zombie won both ways: it overwrote
    // seven_day with a stale number, and because save() replaced the whole
    // windows object it *deleted* five_hour outright — which is exactly why the
    // pill read "5h —" with no percentage.
    reset();
    const t = now();
    render(live({
        five_hour: { used_percentage: 25, resets_at: t + 2 * HOUR },
        seven_day: { used_percentage: 3, resets_at: t + 5 * 86400 },
    }));

    const { file } = render(zombie({
        seven_day: { used_percentage: 9, resets_at: t + 5 * 86400 },
    }));

    assert.strictEqual(file.windows.seven_day.used_percentage, 3,
        'the stale reading must not overwrite the fresh one');
    assert.ok(file.windows.five_hour, 'and must not delete a window it cannot see');
    assert.strictEqual(file.windows.five_hour.used_percentage, 25);

    ok('a 28-hour-old orphan cannot overwrite or erase a live reading');
}

{
    // The other order. The zombie writes first into an empty file — which it is
    // entitled to do, something is better than nothing — and the live terminal
    // must then win, because a stale reading is only preferable to no reading.
    reset();
    const t = now();
    render(zombie({ seven_day: { used_percentage: 9, resets_at: t + 5 * 86400 } }));
    assert.strictEqual(read().windows.seven_day.used_percentage, 9, 'better than nothing');

    const { file } = render(live({
        seven_day: { used_percentage: 3, resets_at: t + 5 * 86400 },
    }));
    assert.strictEqual(file.windows.seven_day.used_percentage, 3, 'the fresher wins');

    ok('a live reading displaces an orphan that got there first');
}

// --- the ordinary-terminal case the age bound alone does not cover -------

{
    // Two live terminals, both with API calls behind them, holding readings of
    // different ages. `total_api_duration_ms == 0` says nothing here — both are
    // non-zero — so the age of the *counter* is what decides: rate limits are
    // refreshed by an API response, and every API response moves that counter,
    // so a counter that has not moved means numbers that have not been
    // refreshed since it last did.
    //
    // This is the live disagreement that was still visible after the five
    // orphans were killed: the file flipping between 10% and 32% for the
    // five-hour window while both terminals were perfectly healthy.
    reset();
    const t = now();

    // Terminal A last talked to the API four hours ago. That is recorded in its
    // session note, which is what the harvester wrote the first time it saw
    // this counter value — seeded here rather than waited for.
    fs.writeFileSync(path.join(STATE, 'quota-session.terminal-a.json'),
        JSON.stringify({ api: 500, at: t - 4 * HOUR }));

    const idle = {
        session_id: 'terminal-a',
        cost: { total_duration_ms: 5 * HOUR * 1000, total_api_duration_ms: 500 },
        rate_limits: { five_hour: { used_percentage: 10, resets_at: t + HOUR } },
    };

    render(idle);
    assert.ok(Math.abs(read().observedAt.five_hour - (t - 4 * HOUR)) <= 5,
        'its reading is stamped when it was learned, not when it was read');

    // Terminal B, actively working, reports the real number.
    render({
        session_id: 'terminal-b',
        cost: { total_duration_ms: 60_000, total_api_duration_ms: 30_000 },
        rate_limits: { five_hour: { used_percentage: 32, resets_at: t + HOUR } },
    });
    assert.strictEqual(read().windows.five_hour.used_percentage, 32,
        'the terminal that has actually spoken to the API wins');

    // A renders again — and again, and again, which is what it does every 30
    // seconds for as long as it stays open. Its counter has not moved, so it
    // has learned nothing and must not win any of them.
    render(idle);
    render(idle);
    assert.strictEqual(read().windows.five_hour.used_percentage, 32,
        'an idle terminal cannot re-assert an old number, however often it renders');

    ok('an idle terminal that has learned nothing cannot outbid a working one');
}

{
    // And the converse, so the rule above cannot be satisfied by simply never
    // letting anyone update anything: when the idle terminal *does* talk to the
    // API again, its counter moves, and its new number is taken at once.
    reset();
    const t = now();
    fs.writeFileSync(path.join(STATE, 'quota-session.terminal-a.json'),
        JSON.stringify({ api: 500, at: t - 4 * HOUR }));

    render({
        session_id: 'terminal-b',
        cost: { total_duration_ms: 60_000, total_api_duration_ms: 30_000 },
        rate_limits: { five_hour: { used_percentage: 32, resets_at: t + HOUR } },
    });

    render({
        session_id: 'terminal-a',
        cost: { total_duration_ms: 5 * HOUR * 1000, total_api_duration_ms: 900 },
        rate_limits: { five_hour: { used_percentage: 47, resets_at: t + HOUR } },
    });
    assert.strictEqual(read().windows.five_hour.used_percentage, 47,
        'a counter that moved means a number that is new');

    ok('a terminal that has just spoken to the API is believed immediately');
}

// --- not churning the file ------------------------------------------------

{
    reset();
    const t = now();
    const payload = live({ five_hour: { used_percentage: 25, resets_at: t + HOUR } });
    render(payload);
    const first = read();
    const mtime = fs.statSync(FILE).mtimeMs;

    render(payload);
    const second = read();

    assert.deepStrictEqual(second, first, 'byte-identical');
    assert.strictEqual(fs.statSync(FILE).mtimeMs, mtime, 'and not rewritten at all');
    assert.strictEqual(second.capturedAt, first.capturedAt,
        're-confirming a number is not learning one — the age must go on advancing');

    ok('an unchanged reading does not rewrite the file or refresh its age');
}

// --- windows that have expired -------------------------------------------

{
    reset();
    const t = now();
    const { file } = render(live({
        five_hour: { used_percentage: 25, resets_at: t - 60 },
        seven_day: { used_percentage: 3, resets_at: t + 5 * 86400 },
    }));

    assert.ok(!file.windows.five_hour,
        'a window whose reset has passed describes a period that no longer exists');
    assert.ok(!file.observedAt.five_hour, 'and its stamp goes with it');
    assert.ok(file.windows.seven_day, 'the live one is untouched');

    ok('a window whose reset has passed is dropped rather than shown');
}

// --- nothing to say --------------------------------------------------------

{
    reset();
    const t = now();
    render(live({ five_hour: { used_percentage: 25, resets_at: t + HOUR } }));
    const before = read();

    // The first renders of any session arrive before the quota probe answers —
    // there is no `rate_limits` key at all. That must not be read as "every
    // window is gone".
    render({ session_id: 'x', cost: { total_duration_ms: 500, total_api_duration_ms: 0 } });
    assert.deepStrictEqual(read(), before, 'a payload with no rate_limits changes nothing');

    ok('a render before the quota probe answers leaves the file alone');
}

// --- an older harvester's file --------------------------------------------

{
    // ~60 worktree copies of this script are on this machine and will go on
    // writing the old shape: windows and capturedAt, no stamp map. Reading one
    // must not mean discarding it.
    reset();
    const t = now();
    write({
        version: 1,
        capturedAt: t - 30,
        windows: { five_hour: { used_percentage: 40, resets_at: t + HOUR } },
    });

    // A zombie is older than that file's capturedAt and must still lose.
    render(zombie({ five_hour: { used_percentage: 5, resets_at: t + HOUR } }));
    assert.strictEqual(read().windows.five_hour.used_percentage, 40,
        "an old-shape file's capturedAt is taken as its observation time");

    // And a live terminal must still win.
    render(live({ five_hour: { used_percentage: 41, resets_at: t + HOUR } }));
    assert.strictEqual(read().windows.five_hour.used_percentage, 41);

    ok('a file written by an older copy of this script is merged, not rejected');
}

{
    // The compatibility lock, in the other direction. An old copy detects
    // change with `prev['windows'] == found`, so a third key inside a window
    // entry would make that comparison never match and have every one of those
    // sixty copies rewrite the file on every render, at the 300ms debounce.
    // The stamps live in a sibling map for exactly this reason.
    reset();
    const t = now();
    const { file } = render(live({
        five_hour: { used_percentage: 25, resets_at: t + HOUR },
    }));
    assert.deepStrictEqual(Object.keys(file.windows.five_hour).sort(),
        ['resets_at', 'used_percentage'],
        'a window entry carries these two keys and nothing else');

    ok('a window entry keeps the exact shape older copies compare against');
}

// --- the receipt -----------------------------------------------------------

{
    reset();
    const t = now();
    const rp = path.join(home, 'r.json');

    render(live({ five_hour: { used_percentage: 25, resets_at: t + HOUR } }),
        ['--receipt', rp]);
    let r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    assert.strictEqual(r.windows.five_hour.used_percentage, 25);
    assert.strictEqual(r.sessionId, 'live-session');

    // The half that makes the beacon's diagnosis work: a render that saw no
    // rate_limits still leaves a receipt. It is the only thing separating "the
    // CLI never got up" from "it got up and the probe never answered".
    fs.rmSync(rp);
    render({ session_id: 'x', cost: { total_duration_ms: 500, total_api_duration_ms: 0 } },
        ['--receipt', rp]);
    r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    assert.deepStrictEqual(r.windows, {}, 'an empty reading is still a receipt');

    // `--receipt=<path>` too, since it is hand-parsed.
    fs.rmSync(rp);
    render(live({ five_hour: { used_percentage: 7, resets_at: t + HOUR } }),
        [`--receipt=${rp}`]);
    assert.ok(fs.existsSync(rp));

    // And an ordinary terminal, which passes no receipt, writes none anywhere.
    const before = fs.readdirSync(STATE);
    render(live({ five_hour: { used_percentage: 8, resets_at: t + HOUR } }));
    assert.deepStrictEqual(
        fs.readdirSync(STATE).filter(n => n.includes('receipt')), [],
        'a terminal without --receipt leaves nothing behind');
    assert.ok(before.length >= 0);

    ok('a receipt records what the run saw, including nothing');
}

// --- never failing loudly --------------------------------------------------

{
    reset();
    for (const input of ['', 'not json', '[]', 'null', '{"rate_limits":"nope"}',
        '{"rate_limits":{"five_hour":{"used_percentage":"high"}}}']) {
        const r = spawnSync('python3', [SCRIPT], {
            input, encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: home },
        });
        assert.strictEqual(r.status, 0, `exit 0 for ${JSON.stringify(input)}`);
        assert.ok(!/Traceback/.test(r.stdout + r.stderr),
            `a traceback where the status line should be, for ${JSON.stringify(input)}`);
    }

    ok('malformed input costs a status line, never a traceback');
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} groups passed`);
