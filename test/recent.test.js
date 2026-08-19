'use strict';

// Exercises the one rule in bridge/overview.js that a clock could get wrong:
// how far back the board's "recent activity" group reaches.
//
// A pure function taking its own `at`, so every case here is exact rather than
// "whatever today happens to be". Local time throughout — the rule is about the
// user's morning, and so is the test.

const assert = require('assert');
const { recentSince } = require('../bridge/overview.js');

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

console.log(`\n  ${pass} checks passed`);
