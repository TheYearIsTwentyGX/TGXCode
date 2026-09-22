'use strict';

// When a transcript row says what day it is.
//
// The gutter used to hold a wall clock and nothing else, so a session reopened
// after a few days gave you `14:32:07` and no way to tell this afternoon from
// last Tuesday. `dateOf` is the rule that fixed it: a date is drawn when the
// message is **not from the current calendar day** *and* is **more than twelve
// hours old**. Both halves are load-bearing and each is wrong on its own — the
// day test alone dates this morning's messages, and the twelve-hour test alone
// dates a message from four hours ago that happens to sit the other side of
// midnight.
//
// Here rather than against a live bridge, and by extraction rather than by
// require, for the reason ask-result.test.js gives about `readAnswer`: this is
// a pure function inside a browser module that has a `dom` and a `state` behind
// it, and the alternative on offer was not testing it. It is worth the liberty
// because the thing it decides is invisible when wrong in the direction that
// matters — a date that fails to appear looks exactly like a session you were
// in more recently than you were.
//
// **What is asserted, and what deliberately is not.** The rule is asserted
// exactly: dated or bare, at the minute either side of every boundary. The
// *format* is asserted structurally — against `toLocaleDateString` called with
// the same options — rather than against the string `'Sep 21'`. That is not
// laziness. `dateOf` formats through the host's locale on purpose, so pinning
// the English output would make this file fail on a machine whose ICU disagrees
// while the function was behaving perfectly. What is worth pinning is the part
// this project chose: that a year appears only when it is not the current one,
// and appears as two digits.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// ── lifting dateOf out of web/app.js ────────────────────────────────────────

// Same brace-counting cut as ask-result.test.js, with one addition: `dateOf`
// calls `pad`, which is a top-level `const` arrow rather than a `function`, so
// the extracted body would close over nothing. The const is carried in with it.
// Both halves fail loudly if renamed rather than quietly matching nothing.
function liftDateOf() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

    const padAt = src.match(/^const pad = .*;$/m);
    assert.ok(padAt, 'the `pad` const is gone from web/app.js — this test is stale');

    const at = src.indexOf('function dateOf(');
    assert.notStrictEqual(at, -1, 'dateOf is gone from web/app.js — this test is stale');
    let depth = 0;
    let i = src.indexOf('{', at);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    assert.ok(i < src.length, 'dateOf has unbalanced braces');

    return new Function(`${padAt[0]}\n${src.slice(at, i + 1)}; return dateOf;`)();
}

const dateOf = liftDateOf();

// A fixed "now" so nothing here depends on when the suite runs: Tue 22 Sep
// 2026, 08:00, local. Local rather than UTC because the rule is about the
// reader's calendar day, which is the one `getDate()` answers for.
const NOW = new Date(2026, 8, 22, 8, 0, 0).getTime();
const at = (...a) => new Date(...a).toISOString();
const shortDate = (d) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const bare = (ts, why) => assert.strictEqual(dateOf(ts, NOW), '', why);
const dated = (ts, why) => assert.notStrictEqual(dateOf(ts, NOW), '', why);

// A second fixed now, late the same evening, which is the only vantage point
// from which the same-day half of the rule does any work — see below.
const TONIGHT = new Date(2026, 8, 22, 23, 0, 0).getTime();

// ── the same-day half ───────────────────────────────────────────────────────

// Any hour of today, however far back. Midnight is 8h before NOW and the top of
// the hour is 0h, and neither gets a date: you have been here all day.
bare(at(2026, 8, 22, 0, 0), 'midnight today');
bare(at(2026, 8, 22, 0, 30), 'half past midnight today');
bare(at(2026, 8, 22, 7, 59), 'a minute ago');
bare(at(2026, 8, 22, 8, 0), 'this instant');
ok('a message from earlier today is never dated, whatever the hour');

// **The case that pins the same-day test, and the only kind there is.** Read
// from 08:00, every hour of today is also inside twelve hours, so the age test
// alone would hold all of it bare and this half of the rule would be dead code
// the suite could not see. It takes a vantage point late in the evening for a
// message to be both from today and more than twelve hours old — and a mutation
// that deletes `sameDay` passes every assertion above while failing these.
assert.strictEqual(dateOf(at(2026, 8, 22, 9, 0), TONIGHT), '',
    'this morning, read at 23:00 — 14h old and still today');
assert.strictEqual(dateOf(at(2026, 8, 22, 0, 1), TONIGHT), '',
    'just after midnight, read at 23:00 — 23h old and still today');
// The same instants a day earlier are dated, so what holds them bare above is
// the calendar day and not something about the hour.
assert.notStrictEqual(dateOf(at(2026, 8, 21, 9, 0), TONIGHT), '',
    'yesterday morning, read at 23:00 — dated');
ok('a message from today is bare even when it is more than twelve hours old');

// ── the twelve-hour half ────────────────────────────────────────────────────

// Yesterday, which passes the day test, held bare by the age test alone. This
// is the case the calendar-only rule got wrong: at breakfast, 11pm last night
// is still "last night".
bare(at(2026, 8, 21, 23, 0), 'yesterday 23:00 — 9h ago');
bare(at(2026, 8, 21, 20, 1), 'yesterday 20:01 — 11h59m ago');
ok('a message from late last night is not dated at breakfast');

// The boundary itself, to the minute. `<=` on twelve hours, so the instant
// itself is bare and the minute before it is dated.
bare(at(2026, 8, 21, 20, 0), 'exactly 12h ago is bare');
dated(at(2026, 8, 21, 19, 59), '12h01m ago is dated');
assert.strictEqual(dateOf(at(2026, 8, 21, 19, 59), NOW),
    shortDate(new Date(2026, 8, 21)));
ok('the twelve-hour boundary falls where it says it does');

// ── both halves together ────────────────────────────────────────────────────

dated(at(2026, 8, 21, 12, 0), 'yesterday noon — 20h ago');
dated(at(2026, 8, 15, 9, 0), 'a week ago');
dated(at(2026, 0, 1, 9, 0), 'January of this year');
ok('a message old enough on both counts is dated');

// ── the year ────────────────────────────────────────────────────────────────

// Within this year the date carries no year at all: it is noise on every row of
// every session anybody is actually reading.
assert.strictEqual(dateOf(at(2026, 8, 15, 9, 0), NOW),
    shortDate(new Date(2026, 8, 15)));
ok('a date in the current year carries no year');

// Outside it, two digits, because `Dec 3` on a session from last December reads
// as three weeks ago rather than a year — a date a reader would act on. The
// separator is a right single quote, not an ASCII apostrophe.
assert.strictEqual(dateOf(at(2025, 11, 3, 23, 57), NOW),
    `${shortDate(new Date(2025, 11, 3))} ’25`);
assert.strictEqual(dateOf(at(2009, 0, 5, 10, 0), NOW),
    `${shortDate(new Date(2009, 0, 5))} ’09`);
ok('a date in another year carries a two-digit year, zero-padded');

// ── things that are not a date to assert ────────────────────────────────────

// A clock-skewed `ts` fails the age test and stays bare. This is the right way
// round rather than an accident of the comparison: the alternative is printing
// tomorrow against a message, which is worse than printing nothing.
bare(at(2026, 8, 22, 8, 5), '5 minutes into the future');
bare(at(2026, 8, 23, 8, 5), 'tomorrow');
bare(at(2027, 8, 22, 8, 5), 'next year');
ok('a timestamp in the future is never dated');

// The pending row drawn at Send passes `ts: null` on purpose — the gutter is
// empty and a marker says why — so a null has to come back empty rather than
// throw or render the epoch.
for (const [name, v] of [['null', null], ["''", ''], ['undefined', undefined],
    ['0', 0], ['NaN', NaN], ['a non-date string', 'not a date'],
    ['an object', {}], ['an array', []]]) {
    assert.strictEqual(dateOf(v, NOW), '', `${name} must come back empty`);
}
ok('a missing or unparseable ts comes back empty rather than throwing');

// ── the default argument ────────────────────────────────────────────────────

// Every caller in app.js relies on `now` defaulting to the wall clock. Asserted
// against the real clock rather than a fixture, since that is the thing being
// checked: a message a fortnight old is dated whenever the suite runs, and one
// a minute old is not.
assert.notStrictEqual(dateOf(new Date(Date.now() - 14 * 86400e3).toISOString()), '',
    'a fortnight old, against the real clock');
assert.strictEqual(dateOf(new Date().toISOString()), '',
    'a message sent this instant');
ok('now defaults to the wall clock');

console.log(`\nmessage-date: ${pass} passed`);
