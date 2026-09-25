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
// Here rather than against a live bridge, and by importing web/format.js
// directly — the way paths.test.js imports web/markdown.js. It used to be cut
// out of web/app.js as text, because that module has a `dom` and a `state`
// behind it; format.js has neither at top level, which is what lets Node load
// it. It is worth testing because the thing it decides is invisible when wrong
// in the direction that matters — a date that fails to appear looks exactly
// like a session you were in more recently than you were.
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

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// The module warns about being loaded from a package.json with no "type", which
// is noise in a test run and says nothing about the code.
process.removeAllListeners('warning');

(async () => {
    const { dateOf, clockOf, hhmm, hourOpts, setClock } = await import('../web/format.js');

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

    // ── the 12- or 24-hour clock ────────────────────────────────────────────────

    // `transcript.clock`. Built from local-time parts, as the functions read them,
    // so the file passes in any time zone.
    const local = (h, m, s) => new Date(2026, 8, 21, h, m, s).toISOString();
    assert.strictEqual(clockOf(local(15, 4, 5)), '15:04:05', '24h is the default');
    assert.strictEqual(hhmm(local(9, 7, 0)), '09:07');
    assert.strictEqual(hourOpts().hour12, false);
    setClock('12h');
    try {
        assert.strictEqual(clockOf(local(15, 4, 5)), '3:04:05 PM');
        assert.strictEqual(clockOf(local(0, 0, 0)), '12:00:00 AM', 'midnight is 12 AM, not 0');
        assert.strictEqual(clockOf(local(12, 30, 9)), '12:30:09 PM', 'noon is 12 PM');
        assert.strictEqual(hhmm(local(9, 7, 0)), '9:07 AM');
        assert.strictEqual(hhmm(local(23, 59, 0)), '11:59 PM');
        assert.strictEqual(clockOf(''), '', 'no ts is still an empty gutter');
        assert.strictEqual(hhmm(null), '');
        assert.strictEqual(hourOpts().hour12, true);
    } finally {
        setClock('24h');
    }
    assert.strictEqual(clockOf(local(15, 4, 5)), '15:04:05', 'and back');
    ok('the clock reads 12- or 24-hour as transcript.clock says');

    console.log(`\nmessage-date: ${pass} passed`);
})();
