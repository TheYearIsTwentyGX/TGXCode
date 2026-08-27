'use strict';

// The quota store, on its own — no bridge.
//
// What is worth pinning down here is almost entirely about *units and
// precedence*, which is where this feature can go wrong quietly. The two
// sources report the same quantity on two different scales — the stream sends
// the raw `anthropic-ratelimit-unified-*` fraction (0–1), the status line has
// already multiplied by 100 — so an off-by-100 is one character away at all
// times and would show a 5% window as fully spent, or a spent one as 0.05%.
// Neither would throw.
//
// The rest is the merge: which source wins for a field both carry, what happens
// to a window only one of them has seen, and that a `rateLimitType` nobody has
// heard of survives to the UI instead of being dropped or bent into `five_hour`.
//
// **XDG_DATA_HOME is set before the require, and that order is load-bearing.**
// bridge/config.js reads the variable once, at require time, to build STATE_DIR
// — so setting it afterwards would point the module at the real
// ~/.local/share/claude-sessions and this test would fight the user's own
// bridges over their quota file. test/drafts.test.js does the same thing for
// the same reason.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-'));
process.env.XDG_DATA_HOME = home;

const {
    Usage, fractionToPercent, clampPercent, labelFor, shortLabelFor,
    STATUSLINE_FILE, STATE_FILE, VERSION,
} = require('../bridge/usage');

// Asserted rather than assumed: if either path ever pointed at the real
// directory this file would be destructive, so it is worth failing loudly on.
assert.ok(STATE_FILE.startsWith(home),
    `refusing to run: STATE_FILE is ${STATE_FILE}, outside the throwaway ${home}`);
assert.ok(STATUSLINE_FILE.startsWith(home),
    `refusing to run: STATUSLINE_FILE is ${STATUSLINE_FILE}, outside the throwaway ${home}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** A store over a wiped state file, so groups cannot leak into each other. */
function fresh() {
    try { fs.unlinkSync(STATE_FILE); } catch { /* first run */ }
    return new Usage();
}

/** Stand in for scripts/quota-statusline.py having run. */
function writeStatusLine(windows, capturedAt) {
    fs.mkdirSync(path.dirname(STATUSLINE_FILE), { recursive: true });
    fs.writeFileSync(STATUSLINE_FILE, JSON.stringify({
        version: VERSION, windows, capturedAt: capturedAt || Math.floor(Date.now() / 1000),
    }));
}

function clearStatusLine() {
    try { fs.unlinkSync(STATUSLINE_FILE); } catch { /* already gone */ }
}

const win = (snap, type) => snap.windows.find(w => w.type === type);
const now = () => Math.floor(Date.now() / 1000);

// --- units --------------------------------------------------------------

{
    // The stream's scale. 0.82 is 82%, and the day this returns 0.82 the pill
    // reads "1%" on a window that is nearly spent.
    assert.strictEqual(fractionToPercent(0.82), 82);
    assert.strictEqual(fractionToPercent(0), 0);
    assert.strictEqual(fractionToPercent(1), 100);

    // Out of range in either direction is clamped rather than shown. A bar
    // 140% wide is a rendering bug on top of whatever sent it.
    assert.strictEqual(fractionToPercent(1.4), 100);
    assert.strictEqual(fractionToPercent(-0.2), 0);

    // Absent is null, not zero — "nobody told us" and "none used" are opposite
    // claims and the UI draws them differently.
    assert.strictEqual(fractionToPercent(undefined), null);
    assert.strictEqual(fractionToPercent(null), null);
    assert.strictEqual(fractionToPercent(NaN), null);
    assert.strictEqual(fractionToPercent('0.5'), null);

    // The status line's scale is already percent, so it goes through the clamp
    // and not the multiply.
    assert.strictEqual(clampPercent(82), 82);
    assert.strictEqual(clampPercent(101), 100);
    assert.strictEqual(clampPercent(undefined), null);

    ok('a 0–1 fraction becomes 0–100, out-of-range clamps, and absent stays null');
}

// --- the stream alone ---------------------------------------------------

{
    const u = fresh();
    clearStatusLine();

    // The ordinary case, and the reason this feature needed a second source at
    // all: `allowed` carries no utilization, so there is a reset time and no
    // percentage.
    assert.strictEqual(
        u.noteRateLimitEvent({ status: 'allowed', resetsAt: 1786134000, rateLimitType: 'five_hour' }),
        true, 'the first sighting of a window is a change');

    const w = win(u.snapshot(), 'five_hour');
    assert.strictEqual(w.usedPercent, null, 'an allowed event has no percentage to give');
    assert.strictEqual(w.usedPercentSource, null);
    assert.strictEqual(w.resetsAt, 1786134000);
    assert.strictEqual(w.status, 'allowed');

    // The identical event on the next turn must not be broadcast — it arrives
    // every turn, and the pill would repaint for nothing.
    assert.strictEqual(
        u.noteRateLimitEvent({ status: 'allowed', resetsAt: 1786134000, rateLimitType: 'five_hour' }),
        false, 'an unchanged repeat is not a change');

    ok('an allowed event gives a reset and no percentage, and repeats do not re-broadcast');
}

{
    const u = fresh();
    clearStatusLine();

    // Near a limit the stream does send utilization, which is the one case the
    // percentage works with no status line installed at all.
    u.noteRateLimitEvent({
        status: 'allowed_warning', resetsAt: 1786500000, rateLimitType: 'seven_day',
        utilization: 0.82, surpassedThreshold: 0.8,
    });
    const w = win(u.snapshot(), 'seven_day');
    assert.strictEqual(w.usedPercent, 82);
    assert.strictEqual(w.usedPercentSource, 'stream');
    assert.strictEqual(w.surpassedThreshold, 0.8);

    ok('a warning event carries a percentage, scaled from the wire fraction');
}

// --- window ids ---------------------------------------------------------

{
    const u = fresh();
    clearStatusLine();

    // The enum today has six members and will grow. A window we have never
    // heard of has to reach the UI intact — dropped, it is invisible; renamed
    // to something known, it is a lie about a different window.
    u.noteRateLimitEvent({ status: 'allowed_warning', rateLimitType: 'thirty_day_quantum', utilization: 0.4 });
    const w = win(u.snapshot(), 'thirty_day_quantum');
    assert.ok(w, 'an unknown window id survives');
    assert.strictEqual(w.label, 'thirty_day_quantum', 'and labels itself with its raw id');
    assert.strictEqual(w.shortLabel, 'thirty_day_quantum');
    assert.strictEqual(w.usedPercent, 40);

    // Known ones are humanised, and sort ahead of it.
    assert.strictEqual(labelFor('five_hour'), '5-hour');
    assert.strictEqual(shortLabelFor('seven_day'), '7d');
    u.noteRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour' });
    assert.strictEqual(u.snapshot().windows[0].type, 'five_hour',
        'known windows come first, so a new one cannot displace the 5-hour one');

    ok('an unknown rateLimitType reaches the UI as itself, behind the known ones');
}

{
    const u = fresh();
    clearStatusLine();

    // `rateLimitType` is optional on the wire. Filing such an event under
    // `five_hour` would be a guess presented as a fact.
    u.noteRateLimitEvent({ status: 'rejected', resetsAt: 1786134000 });
    const snap = u.snapshot();
    assert.strictEqual(win(snap, 'five_hour'), undefined, 'nothing is invented');
    assert.ok(win(snap, 'unspecified'), 'and the event is not lost either');

    ok('an event with no window id is kept apart rather than guessed at');
}

// --- the merge ----------------------------------------------------------

{
    const u = fresh();
    // The everyday shape: the status line has both windows, the stream has
    // status and resets for one of them and no percentage for either.
    writeStatusLine({
        five_hour: { used_percentage: 12.5, resets_at: 1786134000 },
        seven_day: { used_percentage: 34.2, resets_at: 1786500000 },
    });
    u.noteRateLimitEvent({ status: 'allowed', resetsAt: 1786134000, rateLimitType: 'five_hour' });

    const snap = u.snapshot();
    const five = win(snap, 'five_hour');
    const seven = win(snap, 'seven_day');

    assert.strictEqual(five.usedPercent, 12.5, 'the percentage comes from the status line');
    assert.strictEqual(five.usedPercentSource, 'statusline');
    assert.strictEqual(five.status, 'allowed', 'and the status from the stream');

    // The weekly window the stream never mentioned. `status` must stay null:
    // rendering it as `allowed` would be claiming something nobody said.
    assert.strictEqual(seven.usedPercent, 34.2);
    assert.strictEqual(seven.status, null, 'a window only the status line saw has no status');

    assert.strictEqual(snap.statusLine.present, true);

    ok('the status line supplies percentages and the stream supplies status');
}

{
    const u = fresh();
    // Both have a percentage. Near a limit the stream is the fresher of the
    // two, because it arrives on the turn while the status line waits for a
    // terminal to render.
    writeStatusLine({ seven_day: { used_percentage: 34.2, resets_at: 1786500000 } }, now() - 3600);
    u.noteRateLimitEvent({
        status: 'allowed_warning', resetsAt: 1786500000, rateLimitType: 'seven_day', utilization: 0.9,
    });
    const w = win(u.snapshot(), 'seven_day');
    assert.strictEqual(w.usedPercent, 90, 'the newer reading wins');
    assert.strictEqual(w.usedPercentSource, 'stream');

    ok('where both sources have a percentage, the newer observation wins');
}

{
    const u = fresh();
    // And the other way round: a status line harvested a moment ago beats a
    // warning the stream reported an hour back.
    writeStatusLine({ seven_day: { used_percentage: 34.2, resets_at: 1786500000 } }, now() + 600);
    u.noteRateLimitEvent({
        status: 'allowed_warning', resetsAt: 1786500000, rateLimitType: 'seven_day', utilization: 0.9,
    });
    const w = win(u.snapshot(), 'seven_day');
    assert.strictEqual(w.usedPercent, 34.2);
    assert.strictEqual(w.usedPercentSource, 'statusline');

    ok('and the status line wins when it is the newer of the two');
}

// --- staleness ----------------------------------------------------------

{
    const u = fresh();
    // Every reading is stamped, because the UI's whole obligation here is to
    // show the age rather than pass an old number off as current. A snapshot
    // that lost the stamp would take that ability away silently.
    const captured = now() - 7200;
    writeStatusLine({ five_hour: { used_percentage: 12.5, resets_at: 1786134000 } }, captured);

    const snap = u.snapshot();
    const w = win(snap, 'five_hour');
    assert.strictEqual(w.usedPercentAt, captured, 'the reading carries when it was taken');
    assert.ok(typeof snap.now === 'number', 'and the snapshot carries server time to measure it against');
    assert.ok(snap.now - w.usedPercentAt > 3600, 'so a two-hour-old reading is visibly two hours old');

    ok('a reading carries its own timestamp, and the snapshot the clock to read it by');
}

{
    const u = fresh();
    clearStatusLine();
    const snap = u.snapshot();
    assert.strictEqual(snap.statusLine.present, false,
        'a missing harvester is reported, so the panel can offer the setup step');
    assert.deepStrictEqual(snap.windows, [], 'and nothing is invented to fill the gap');

    ok('with no harvester and no events, the snapshot is empty rather than fabricated');
}

{
    const u = fresh();
    // A torn or hand-mangled file must cost the percentage and nothing else.
    fs.writeFileSync(STATUSLINE_FILE, '{"version":1,"windows":{"five_hour":');
    u.noteRateLimitEvent({ status: 'allowed', resetsAt: 1786134000, rateLimitType: 'five_hour' });
    const snap = u.snapshot();
    assert.strictEqual(snap.statusLine.present, false);
    assert.strictEqual(win(snap, 'five_hour').resetsAt, 1786134000,
        'the stream half still works');

    ok('an unreadable harvest file costs the percentage, not the pill');
}

// --- events -------------------------------------------------------------

{
    const u = fresh();
    clearStatusLine();

    // A change is worth recording; the same status arriving every turn is not.
    u.noteRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour' });
    assert.strictEqual(u.snapshot().events.length, 0, 'a healthy first sighting is not an event');

    u.noteRateLimitEvent({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.85 });
    u.noteRateLimitEvent({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.85 });
    const evs = u.snapshot().events;
    assert.strictEqual(evs.length, 1, 'the repeat did not file a second one');
    assert.strictEqual(evs[0].from, 'allowed');
    assert.strictEqual(evs[0].to, 'allowed_warning');
    assert.strictEqual(evs[0].usedPercent, 85);

    ok('a status change is recorded once, with the percentage at the time');
}

{
    const u = fresh();
    clearStatusLine();

    // A bridge that starts up already in warning has no previous status to
    // differ from. Without the first-sighting rule it records nothing, and the
    // panel shows a clean history for a window that is nearly spent.
    u.noteRateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour' });
    const evs = u.snapshot().events;
    assert.strictEqual(evs.length, 1, 'a first sighting that is already bad is an event');
    assert.strictEqual(evs[0].from, null, 'with nothing claimed about what came before');
    assert.strictEqual(evs[0].to, 'rejected');

    ok('a window first seen in trouble is recorded, with no invented history');
}

// --- persistence --------------------------------------------------------

{
    const u = fresh();
    clearStatusLine();
    u.noteRateLimitEvent({ status: 'allowed', resetsAt: 1786134000, rateLimitType: 'five_hour' });
    u._writeNow();

    // The point of persisting: a restart has a pill before the first turn
    // rather than an empty header for however long the next turn takes.
    const reloaded = new Usage();
    assert.strictEqual(win(reloaded.snapshot(), 'five_hour').resetsAt, 1786134000);

    ok('a reset time survives a restart');
}

{
    const a = fresh();
    a.noteRateLimitEvent({ status: 'allowed', resetsAt: 1000, rateLimitType: 'five_hour' });
    a._writeNow();

    // Two bridges share STATE_DIR and both watch the same account. Merging on
    // write rather than overwriting is what stops them flapping the pill
    // between each other's observations — b must not lose a's weekly window
    // just because it never saw one.
    const b = new Usage();
    b.stream = Object.create(null);
    b.noteRateLimitEvent({ status: 'allowed', resetsAt: 2000, rateLimitType: 'seven_day' });
    b._writeNow();

    const merged = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.ok(merged.stream.five_hour, "the other bridge's window survived");
    assert.ok(merged.stream.seven_day, 'alongside this one');

    ok('two bridges sharing the state file merge rather than overwrite');
}

// --- the beacon ---------------------------------------------------------
//
// Only the parts that do not spawn anything. Actually running a beacon needs a
// directory the user has trusted and costs a real API call, so it is a manual
// check rather than a test — see docs/plans/05-usage-and-quota.md.
//
// DEFAULTS and SHAPE are read without constructing Prefs on purpose: the
// constructor writes ~/.tgxcode/settings.json, which is keyed off HOME rather
// than XDG_DATA_HOME and would therefore reach outside this test's sandbox.

const { DEFAULTS: PREF_DEFAULTS, SHAPE: PREF_SHAPE } = require('../bridge/prefs');
const { plain } = require('../bridge/beacon');

{
    // Off, and pointed nowhere. A feature that starts Claude in a directory
    // must not have a directory until somebody names one.
    assert.strictEqual(PREF_DEFAULTS.quota.beacon, false);
    assert.strictEqual(PREF_DEFAULTS.quota.beaconDir, null);

    const shape = PREF_SHAPE.quota;
    assert.strictEqual(shape.beacon(true), true);
    assert.strictEqual(shape.beacon('yes'), false);

    assert.strictEqual(shape.beaconDir(null), true, 'unset is how it ships');
    assert.strictEqual(shape.beaconDir('/home/x/proj'), true);
    assert.strictEqual(shape.beaconDir(''), false, 'empty is not a directory');
    assert.strictEqual(shape.beaconDir(42), false);

    // The floor matters: each run is a process and an API call, so a file
    // asking for one a minute is a mistake to reject rather than obey.
    assert.strictEqual(shape.beaconEveryMinutes(20), true);
    assert.strictEqual(shape.beaconEveryMinutes(5), true);
    assert.strictEqual(shape.beaconEveryMinutes(4), false);
    assert.strictEqual(shape.beaconEveryMinutes(0), false);
    assert.strictEqual(shape.beaconEveryMinutes(2000), false);
    assert.strictEqual(shape.beaconEveryMinutes(20.5), false);

    ok('the beacon ships off, with no directory, and refuses a silly interval');
}

{
    // When a run fails it is almost always a dialog waiting in a TUI nobody can
    // see, and the panel has to name it. This is that text arriving as the CLI
    // actually emits it — the real settings-warning modal, ANSI and all, whose
    // cursor moves split "Enter to confirm" into three pieces.
    const soup = '\x1b[93m\x1b[1mSettings Warning\x1b[22m\x1b[39m\n'
        + '\x1b[2Gpermissions.allow: invalid rule was skipped\n'
        + '\x1b[37mEnter \x1b[8Gto \x1b[11Gconfirm\x1b[39m\n';
    const out = plain(soup);
    assert.ok(out.includes('Settings Warning'), out);
    assert.ok(out.includes('Enter to confirm'), 'the cursor moves must not shred the words');
    assert.ok(!out.includes('\x1b'), 'no escapes survive into the panel');

    // And it must never be the thing that throws while reporting a failure.
    assert.strictEqual(plain(''), '');
    assert.strictEqual(plain(null), '');
    assert.strictEqual(plain(undefined), '');
    assert.ok(plain('x'.repeat(50_000)).length <= 400, 'the panel gets a line, not a screen dump');

    ok('a blocking dialog is rendered as readable text for the panel to show');
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} groups passed`);
