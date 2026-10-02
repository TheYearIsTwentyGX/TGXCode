'use strict';

// Exercises the one rule in bridge/overview.js that a clock could get wrong:
// how far back the board's "recent activity" group reaches — and, at the end,
// whose a recent card's process is.
//
// A pure function taking its own `at`, so every case here is exact rather than
// "whatever today happens to be". Local time throughout — the rule is about the
// user's morning, and so is the test.

const assert = require('assert');
const { build, recentSince } = require('../bridge/overview.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** A local-time instant, written the way a person reads a calendar. */
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

/** What `recentSince` returned, as a local-time string, for a readable failure. */
const since = (when) => new Date(recentSince(when)).toString();
const same = (when, expected, name) => {
    assert.strictEqual(recentSince(when), expected.getTime(),
        `${name}: got ${since(when)}, wanted ${expected.toString()}`);
    ok(name);
};

// August 2026: the 14th is a Friday, the 17th a Monday, the 18th a Tuesday.
assert.strictEqual(at(2026, 8, 14, 9).getDay(), 5, 'the 14th should be a Friday');
assert.strictEqual(at(2026, 8, 17, 9).getDay(), 1, 'the 17th should be a Monday');

// --- after noon: today only -----------------------------------------------
same(at(2026, 8, 18, 13), at(2026, 8, 18, 0), 'an afternoon reaches back to midnight');
same(at(2026, 8, 18, 23, 59), at(2026, 8, 18, 0), 'late evening is still today');
// Noon itself is the afternoon. It has to fall one way and this is the way that
// keeps the morning rule strictly a morning rule.
same(at(2026, 8, 18, 12), at(2026, 8, 18, 0), 'noon exactly counts as afternoon');

// --- before noon: yesterday afternoon -------------------------------------
same(at(2026, 8, 18, 9), at(2026, 8, 17, 12), 'a morning reaches back to noon yesterday');
same(at(2026, 8, 18, 11, 59), at(2026, 8, 17, 12), 'right up to the last minute before noon');
same(at(2026, 8, 18, 0, 1), at(2026, 8, 17, 12), 'just after midnight, too');

// --- Monday: back past the weekend ----------------------------------------
same(at(2026, 8, 17, 9), at(2026, 8, 14, 12), 'Monday morning reaches back to noon Friday');
same(at(2026, 8, 17, 13), at(2026, 8, 17, 0), 'Monday afternoon is an afternoon like any other');

// --- the weekend falls out of the general rule ----------------------------
same(at(2026, 8, 16, 9), at(2026, 8, 15, 12), 'Sunday morning reaches back to noon Saturday');
same(at(2026, 8, 15, 9), at(2026, 8, 14, 12), 'Saturday morning reaches back to noon Friday');

// --- across a DST boundary -------------------------------------------------
// The reason this goes through setHours/setDate rather than subtracting hours:
// the US clocks go back on Sunday 1 November 2026, so both of these spans are an
// hour longer than they look — 25 hours, and 73. Written as wall-clock times,
// which is what the rule is actually about, so the assertion holds in a zone
// with no DST at all as well.
assert.strictEqual(at(2026, 11, 2, 9).getDay(), 1, 'the 2nd of November should be a Monday');
same(at(2026, 11, 2, 9), at(2026, 10, 30, 12), 'Monday after the clocks change: noon Friday');
same(at(2026, 11, 1, 9), at(2026, 10, 31, 12), 'the morning the clocks changed: noon Saturday');

// --- a recent card keeps the runner this bridge holds ----------------------
// A session whose turn just ended is idle but still has its `claude`, so the
// registry says running. Sent with `runner: null`, that is "running somewhere
// that is not us" to every client, and the board called the bridge's own
// session another TGXCode window. Made-up ids, so the tasks cache and
// ~/.claude/tasks have nothing for them.
{
    const ours = `test-ours-${process.pid}`;
    const theirs = `test-theirs-${process.pid}`;
    const now = new Date().toISOString();
    const summary = (sessionId, pid) => ({
        sessionId, title: sessionId, lastTs: now, mtimeMs: Date.now(),
        live: { running: true, pid, entrypoint: 'tgxcode', kind: 'interactive' },
    });
    const index = {
        ready: true,
        list: () => [summary(ours, 1001), summary(theirs, 1002)],
        get: () => null,
    };
    const pool = {
        statuses: () => ({
            [ours]: { state: 'idle', activity: null, queued: 0, busySince: null, retry: null,
                error: null, errorKind: null, stalled: false, pendingPermission: null },
        }),
    };
    const d = build(index, pool, null);

    const mine = d.recent.find(c => c.sessionId === ours);
    assert.ok(mine, 'an idle session of ours is in the recent group');
    assert.ok(!d.sessions.some(c => c.sessionId === ours), 'and not on the board as running');
    assert.strictEqual(mine.runner && mine.runner.state, 'idle',
        'a recent card carries the idle runner this bridge holds');
    ok('a recent session with our idle process keeps its runner');

    const away = d.sessions.find(c => c.sessionId === theirs);
    assert.ok(away, 'a live session with no runner of ours is on the board');
    assert.strictEqual(away.reason, 'elsewhere');
    assert.strictEqual(away.runner, null);
    assert.ok(!d.recent.some(c => c.sessionId === theirs), 'and not in recent');
    ok('a live session with no runner of ours is still elsewhere');
}

console.log(`\n  ${pass} checks passed`);
