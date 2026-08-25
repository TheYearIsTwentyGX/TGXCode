'use strict';

// The schedule store and its cron, on their own — no bridge.
//
// A unit test for the reason test/drafts.test.js gives, and with a stronger case
// than drafts had: the cron half of bridge/schedule.js is where the real edge
// cases in this feature live. A schedule that fires twice, or that skips the
// night of a clock change, or that spins forever on `0 0 30 2 *`, is a bug
// nobody would notice from the UI until it had already gone wrong at 2 AM. Those
// are pure functions of a timestamp, so they are cheap to pin down here and
// nearly impossible to pin down anywhere else.
//
// **XDG_DATA_HOME is set before the require, and that order is load-bearing.**
// bridge/config.js reads the variable once, at require time, to build STATE_DIR —
// so setting it afterwards would point the module at the real
// ~/.local/share/claude-sessions and this test would eat the user's schedules.
// test/drafts.test.js and test/ports.test.js do the same thing for the same
// reason.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-schedule-'));
process.env.XDG_DATA_HOME = home;

const {
    Schedules, STATE_FILE, MAX_SCHEDULES, CATCHUP_MS,
    parseCron, matches, nextSlot, dueSlot, describeCron, cronForm, fillPrompt,
    verdictOf,
} = require('../bridge/schedule');

// Where the module will actually write, now that the env var is in place.
// Asserted rather than assumed: if this ever pointed at the real directory the
// rest of the file would be destructive.
assert.ok(STATE_FILE.startsWith(home),
    `refusing to run: STATE_FILE is ${STATE_FILE}, outside the throwaway ${home}`);

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

/** A fresh store over a wiped file, so groups cannot leak into each other. */
function fresh() {
    try { fs.unlinkSync(STATE_FILE); } catch { /* first run */ }
    return new Schedules();
}

/** A local wall-clock time as epoch ms. Months are 1-based here, unlike Date. */
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const show = (ms) => (ms == null ? 'null' : new Date(ms).toString().slice(0, 21));

// --- parsing -------------------------------------------------------------

{
    const spec = parseCron('0 2 * * 2-6');
    assert.ok(!spec.error, spec.error);
    assert.deepStrictEqual([...spec.minute.values], [0]);
    assert.deepStrictEqual([...spec.hour.values], [2]);
    assert.deepStrictEqual([...spec.dow.values].sort((a, b) => a - b), [2, 3, 4, 5, 6]);
    assert.strictEqual(spec.dom.star, true);
    assert.strictEqual(spec.dow.star, false);

    // Every shape the dialog can produce, plus the ones a person writes by hand.
    for (const text of ['*/5 * * * *', '0 9 * * 1-5', '30 14 1 * *', '0 0 * * 0,6',
        '0 2 1 * 1', '0 3 29 2 *', '7,37 * * * *', '0 0-6/2 * * *', '0 2 * * 7']) {
        assert.ok(!parseCron(text).error, `${text} should parse: ${parseCron(text).error}`);
    }

    // Sunday is both 0 and 7 in cron, and an expression may use either.
    assert.deepStrictEqual([...parseCron('0 2 * * 7').dow.values], [0],
        'day-of-week 7 normalises to 0, so matches() never has to know');
    assert.deepStrictEqual([...parseCron('0 2 * * 0,7').dow.values], [0],
        'and 0,7 is not two Sundays');

    ok('the expressions the UI produces parse, and dow 7 folds into 0');
}

{
    // Every one of these must be a refusal with a message, not a silently
    // accepted expression that then never fires.
    const bad = {
        '': 'empty',
        '0 2 * *': 'four fields',
        '0 2 * * * *': 'six fields',
        '60 2 * * *': 'minute out of range',
        '0 24 * * *': 'hour out of range',
        '0 2 0 * *': 'day-of-month below 1',
        '0 2 32 * *': 'day-of-month above 31',
        '0 2 * 13 *': 'month out of range',
        '0 2 * * 8': 'day-of-week above 7',
        'a b c d e': 'not numbers',
        '0 2 * * */0': 'a zero step',
        '0 2 * * 5-1': 'a backwards range',
        '0 2 * * 1,,2': 'an empty entry',
    };
    for (const [text, why] of Object.entries(bad)) {
        const spec = parseCron(text);
        assert.ok(spec.error, `${JSON.stringify(text)} (${why}) should be refused`);
        assert.strictEqual(typeof spec.error, 'string');
    }
    assert.strictEqual(parseCron(null).error !== undefined, true, 'null is refused, not thrown on');
    assert.strictEqual(parseCron(undefined).error !== undefined, true);
    ok(`${Object.keys(bad).length} malformed expressions are refused with a message`);
}

// --- the ask: Tuesday to Saturday at 2 AM --------------------------------

{
    const spec = parseCron('0 2 * * 2-6');

    // Tuesday 25 August 2026, noon. The next five slots must be Wed–Sat then
    // Tuesday: Sunday and Monday are skipped, and the week wraps.
    let t = at(2026, 8, 25, 12);
    const got = [];
    for (let i = 0; i < 5; i++) {
        t = nextSlot(spec, t);
        got.push(new Date(t).toDateString() + ' ' + new Date(t).getHours() + 'h');
    }
    assert.deepStrictEqual(got, [
        'Wed Aug 26 2026 2h',
        'Thu Aug 27 2026 2h',
        'Fri Aug 28 2026 2h',
        'Sat Aug 29 2026 2h',
        'Tue Sep 01 2026 2h',
    ], 'Sunday and Monday are skipped and the month rolls over');

    ok('Tue–Sat at 2 AM steps forward correctly, including across the weekend');
}

{
    const spec = parseCron('0 2 * * 2-6');

    // Cursor on Monday's noon, asked at Tuesday noon: Tuesday 2 AM is owed.
    let due = dueSlot(spec, { cursor: at(2026, 8, 24, 12), now: at(2026, 8, 25, 12) });
    assert.strictEqual(due.slot, at(2026, 8, 25, 2));
    assert.strictEqual(due.skipped, 0);

    // Nothing owed once the cursor has passed it.
    due = dueSlot(spec, { cursor: at(2026, 8, 25, 2), now: at(2026, 8, 25, 12) });
    assert.strictEqual(due.slot, null, 'a claimed slot is not owed again');

    // On the minute itself the slot counts as owed. Off by one here would mean
    // every run happening a full period late.
    due = dueSlot(spec, { cursor: at(2026, 8, 25, 1), now: at(2026, 8, 25, 2) });
    assert.strictEqual(due.slot, at(2026, 8, 25, 2));

    // The case a backwards lookback could not see: a cursor on Saturday, asked
    // on Monday. Sunday and Monday have no slot, so the answer is Saturday's own
    // — and with the cursor already there, nothing is owed.
    due = dueSlot(spec, { cursor: at(2026, 8, 22, 2), now: at(2026, 8, 31, 12) });
    assert.strictEqual(due.slot, at(2026, 8, 29, 2), 'the previous Saturday is reachable');
    assert.strictEqual(due.skipped, 4, 'Tue, Wed, Thu, Fri were stepped over');

    // A tick that fires repeatedly must report the same owed slot every time,
    // which is what lets claim() dedupe them.
    const slot = at(2026, 8, 25, 2);
    const seen = new Set();
    for (const now of [slot, slot + 15_000, slot + 45_000, slot + 90_000, slot + 30 * 60_000]) {
        seen.add(dueSlot(spec, { cursor: at(2026, 8, 25, 1), now }).slot);
    }
    assert.deepStrictEqual([...seen], [slot],
        'every tick after 02:00 reports the same slot, so a claim can dedupe them');

    // The walk is bounded: a `*/5` schedule with a year-old cursor returns
    // something in the past rather than running to the end of time.
    const dense = dueSlot(parseCron('*/5 * * * *'),
        { cursor: at(2025, 8, 25), now: at(2026, 8, 25) });
    assert.ok(dense.slot !== null && dense.slot < at(2026, 8, 25),
        'the walk limit yields a slot to advance the cursor to, and converges');
    ok('dueSlot owes each slot exactly once and reaches back across a sparse week');
}

// --- clocks that misbehave ----------------------------------------------

{
    // A daily 2:30 AM schedule across the US spring-forward, when 2:30 AM does
    // not exist. The rule being checked is weaker than "it fires at 2:30": it is
    // that nextSlot always makes progress and never returns a slot in the past,
    // which is what stops a missing local hour from becoming an infinite loop or
    // a repeated run. In a zone without DST every step is simply the next day.
    const spec = parseCron('30 2 * * *');
    let t = at(2026, 3, 6, 12);
    let steps = 0;
    let last = t;
    for (let i = 0; i < 10; i++) {
        const next = nextSlot(spec, t);
        assert.ok(next !== null, 'a daily schedule always has a next slot');
        assert.ok(next > last, `slot ${show(next)} must be after ${show(last)}`);
        // Never more than two days apart: one day normally, and at most a day
        // extra if a local 2:30 genuinely does not occur.
        assert.ok(next - last < 49 * 60 * 60 * 1000,
            `slot ${show(next)} is implausibly far from ${show(last)}`);
        last = next;
        t = next;
        steps++;
    }
    assert.strictEqual(steps, 10);

    // And across the autumn fall-back, when 1:30 AM happens twice: the slot owed
    // must be one instant, and asking twice must give the same answer rather
    // than firing once per repeated local minute.
    const back = parseCron('30 1 * * *');
    const opts = { cursor: at(2026, 10, 31, 12), now: at(2026, 11, 1, 12) };
    const a = dueSlot(back, opts);
    const b = dueSlot(back, opts);
    assert.deepStrictEqual(a, b, 'the walk is a function, not a coin toss');
    assert.ok(a.slot !== null);
    // Having claimed it, nothing more is owed for that day — the second 1:30 AM
    // must not produce a second run.
    assert.strictEqual(dueSlot(back, { cursor: a.slot, now: opts.now }).slot, null);
    ok('daily slots always advance and never repeat across a clock change');
}

{
    // Month ends and leap years, where field arithmetic usually breaks.
    const eom = parseCron('0 0 31 * *');
    let t = at(2026, 1, 15);
    const months = [];
    for (let i = 0; i < 4; i++) { t = nextSlot(eom, t); months.push(new Date(t).toDateString()); }
    assert.deepStrictEqual(months, [
        'Sat Jan 31 2026', 'Tue Mar 31 2026', 'Sun May 31 2026', 'Fri Jul 31 2026',
    ], 'the 31st skips the months that have no 31st rather than sliding to the 1st');

    // 29 February exists in 2028, not 2026 or 2027, so this is the horizon
    // doing real work rather than a formality.
    const leap = nextSlot(parseCron('0 3 29 2 *'), at(2026, 3, 1));
    assert.strictEqual(new Date(leap).toDateString(), 'Tue Feb 29 2028');

    // And an expression that can never match must give up rather than spin.
    assert.strictEqual(nextSlot(parseCron('0 0 30 2 *'), at(2026, 1, 1)), null,
        'February 30th returns null inside the horizon instead of looping forever');
    assert.strictEqual(nextSlot(parseCron('0 0 31 4 *'), at(2026, 1, 1)), null,
        'nor does April 31st');
    ok('month ends, leap days, and February 30th');
}

{
    // **Giving up has to be cheap.** `GET /api/schedules/describe` runs this on
    // unvalidated input, once per keystroke in the dialog, on the same event loop
    // that serves the live board. The first version stepped one minute at a time
    // over the five-year horizon, so an expression that never matches took about
    // a quarter of a second to say so — 2.6 million Date constructions per
    // keypress. Skipping by day first is what fixes it, and this is the assertion
    // that stops it regressing.
    //
    // The bound is deliberately loose: it is here to catch a return to
    // minute-stepping, which is two orders of magnitude out, not to police
    // milliseconds on a busy machine.
    const worst = parseCron('0 0 31 4 *');
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) assert.strictEqual(nextSlot(worst, at(2026, 1, 1)), null);
    const perCall = Number(process.hrtime.bigint() - started) / 20 / 1e6;
    assert.ok(perCall < 25,
        `an unsatisfiable expression took ${perCall.toFixed(1)}ms per call — the day-skip `
        + 'in nextSlot has probably been lost');
    ok(`an expression that never matches gives up in ${perCall.toFixed(2)}ms`);
}

{
    // crontab(5)'s documented oddity: when day-of-month and day-of-week are both
    // restricted, a day matching *either* counts. Invisible in the common cases
    // because one of the two is almost always `*`.
    const both = parseCron('0 2 1 * 1');
    let t = at(2026, 8, 25);
    const days = [];
    for (let i = 0; i < 6; i++) { t = nextSlot(both, t); days.push(new Date(t).toDateString()); }
    assert.deepStrictEqual(days, [
        'Mon Aug 31 2026',  // a Monday
        'Tue Sep 01 2026',  // the 1st, and not a Monday
        'Mon Sep 07 2026',
        'Mon Sep 14 2026',
        'Mon Sep 21 2026',
        'Mon Sep 28 2026',
    ], 'the 1st OR a Monday, not the 1st AND a Monday');

    // With one of them a star it is a plain AND-with-everything again.
    assert.ok(matches(parseCron('0 2 * * 1'), new Date(at(2026, 8, 31, 2))));
    assert.ok(!matches(parseCron('0 2 * * 1'), new Date(at(2026, 9, 1, 2))));
    ok('the day-of-month / day-of-week OR rule');
}

// --- the shape a picker draws -------------------------------------------

{
    const form = (text) => cronForm(parseCron(text));

    // Every kind the dialog can select, and the expression it selects it from.
    assert.deepStrictEqual(form('*/15 * * * *'), { kind: 'minutes', every: 15 });
    assert.deepStrictEqual(form('* * * * *'), { kind: 'minutes', every: 1 },
        '`*` and `*/1` are the same schedule and read the same way');
    assert.deepStrictEqual(form('*/1 * * * *'), { kind: 'minutes', every: 1 });
    assert.deepStrictEqual(form('0 */3 * * *'), { kind: 'hours', every: 3, minute: 0 });
    assert.deepStrictEqual(form('30 * * * *'), { kind: 'hours', every: 1, minute: 30 });
    assert.deepStrictEqual(form('0 2 * * *'), { kind: 'daily', hour: 2, minute: 0 });
    assert.deepStrictEqual(form('0 2 * * 2-6'),
        { kind: 'weekly', days: [2, 3, 4, 5, 6], hour: 2, minute: 0 });
    assert.deepStrictEqual(form('30 14 1 * *'),
        { kind: 'monthly', day: 1, hour: 14, minute: 30 });
    assert.deepStrictEqual(form('0 17 29 8 *'),
        { kind: 'date', month: 8, day: 29, hour: 17, minute: 0 });

    // **The shapes it must not claim it can draw.** A picker that reported
    // `0 9,17 * * 1-5` as "weekdays at 9" would silently drop the 5 PM run the
    // moment somebody opened it for an unrelated edit and pressed save.
    for (const text of ['0 9,17 * * 1-5', '0 2 1 * 1', '0 0-6/2 * * *',
        '15,45 * * * *', '0 2 1,15 * *', '0 2 * 3 *']) {
        assert.deepStrictEqual(form(text), { kind: 'custom' }, `${text} is not drawable`);
    }

    // `{0,2,4,6}` out of 24 hours is a list that stops, not a repetition — the
    // distinction the `custom` case above turns on.
    assert.deepStrictEqual(form('0 */2 * * *'), { kind: 'hours', every: 2, minute: 0 },
        'but a step that does reach the end of the range is one');

    // A day list written the long way round is still a week. Worth pinning: the
    // days come back sorted, so the checkboxes tick in calendar order however
    // the expression happened to spell them.
    assert.deepStrictEqual(form('0 2 * * 1-5,0'),
        { kind: 'weekly', days: [0, 1, 2, 3, 4, 5], hour: 2, minute: 0 });

    assert.strictEqual(cronForm(parseCron('nonsense')), null);
    assert.strictEqual(cronForm(null), null);
    ok('cronForm names the shapes a picker can draw and refuses the rest');
}

{
    // The round trip the dialog depends on: a form drawn from an expression has
    // to compose back to that same expression, or opening a schedule and saving
    // it without touching anything would quietly reschedule it.
    const back = (f) => {
        const hhmm = (o) => `${o.minute} ${o.hour}`;
        switch (f.kind) {
            case 'minutes': return `*/${f.every} * * * *`;
            case 'hours': return `${f.minute} */${f.every} * * *`;
            case 'daily': return `${hhmm(f)} * * *`;
            case 'weekly': return `${hhmm(f)} * * ${f.days.join(',')}`;
            case 'monthly': return `${hhmm(f)} ${f.day} * *`;
            case 'date': return `${hhmm(f)} ${f.day} ${f.month} *`;
            default: return null;
        }
    };
    for (const text of ['*/15 * * * *', '0 */3 * * *', '0 2 * * *', '0 2 * * 3',
        '30 14 1 * *', '0 17 29 8 *', '0 9 * * 1,4']) {
        const spec = parseCron(text);
        const composed = back(cronForm(spec));
        assert.strictEqual(parseCron(composed).text, spec.text,
            `${text} composed back as ${composed}`);
    }
    ok('a form composes back to the expression it was drawn from');
}

// --- English ------------------------------------------------------------

{
    const say = (text) => describeCron(parseCron(text));
    assert.strictEqual(say('0 2 * * 2-6'), 'Tue–Sat at 2:00 AM');
    assert.strictEqual(say('0 2 * * *'), 'every day at 2:00 AM');
    assert.strictEqual(say('30 14 * * *'), 'every day at 2:30 PM');
    assert.strictEqual(say('0 9 * * 1-5'), 'weekdays at 9:00 AM');
    assert.strictEqual(say('0 0 * * 0,6'), 'weekends at 12:00 AM');
    assert.strictEqual(say('0 2 * * 3'), 'Wednesday at 2:00 AM');
    assert.strictEqual(say('0 2 * * 1,4'), 'Mon, Thu at 2:00 AM');
    assert.strictEqual(say('30 14 1 * *'), 'the 1st of each month at 2:30 PM');
    assert.strictEqual(say('*/5 * * * *'), 'every 5 minutes');

    // Anything it cannot phrase well comes back as the expression itself. A
    // wrong-looking sentence would be worse than the honest raw text.
    assert.strictEqual(say('0 0-6/2 * * *'), '0 0-6/2 * * *');
    assert.strictEqual(describeCron(parseCron('nonsense')), null);
    ok('describeCron says the common shapes in English and falls back to the expression');
}

{
    const say = (text) => describeCron(parseCron(text));

    // The shapes the picker added. `* * * * *` is the one *existing* output this
    // changed: it used to read "every 1 minutes", which nothing pinned and
    // nobody would have written on purpose.
    assert.strictEqual(say('* * * * *'), 'every minute');
    assert.strictEqual(say('*/1 * * * *'), 'every minute');
    assert.strictEqual(say('*/15 * * * *'), 'every 15 minutes');
    assert.strictEqual(say('0 * * * *'), 'every hour');
    assert.strictEqual(say('30 * * * *'), 'every hour at :30');
    assert.strictEqual(say('0 */3 * * *'), 'every 3 hours');
    assert.strictEqual(say('5 */6 * * *'), 'every 6 hours at :05');

    // A dated expression says something different depending on the flag, because
    // it *is* something different: without `once` it comes round again in a year.
    assert.strictEqual(say('0 17 29 8 *'), '29 August every year at 5:00 PM');
    assert.strictEqual(describeCron(parseCron('0 17 29 8 *'), { once: true }),
        'once, on 29 August at 5:00 PM');

    // The flag is about the row, not the expression, so it cannot invent a date
    // out of a repeating one — a `once` daily still reads as daily.
    assert.strictEqual(describeCron(parseCron('0 2 * * *'), { once: true }),
        'every day at 2:00 AM');
    ok('describeCron says the picker\'s new shapes, and `once` changes only the dated one');
}

// --- the prompt ---------------------------------------------------------

{
    const head = 'a'.repeat(40);
    const since = 'b'.repeat(40);

    const full = fillPrompt('review {{range}} on {{ref}} — {{count}} commits, {{date}}',
        { head, since, ref: 'origin/main', count: 3, at: Date.parse('2026-08-25T00:00:00Z') });
    assert.strictEqual(full,
        `review ${'b'.repeat(12)}..${'a'.repeat(12)} on origin/main — 3 commits, 2026-08-25`);

    // No marker: a first run, or one whose marker git no longer has. Reviewing
    // the whole history is never what was meant.
    assert.strictEqual(fillPrompt('range={{range}}', { head }),
        `range=${'a'.repeat(12)}~1..${'a'.repeat(12)}`);
    // And with nothing at all the range is empty rather than the string
    // "undefined..undefined" reaching a session.
    assert.strictEqual(fillPrompt('range={{range}}', {}), 'range=');

    // An unknown placeholder is left alone: a prompt is prose, and blanking
    // something unrecognised would quietly delete part of a message.
    assert.strictEqual(fillPrompt('keep {{rang}}, fill {{head}}', { head }),
        `keep {{rang}}, fill ${'a'.repeat(12)}`);
    // Whitespace inside the braces is tolerated, since a person types these.
    assert.strictEqual(fillPrompt('{{ head }}', { head }), 'a'.repeat(12));
    // A null count reads as prose rather than as "null commits".
    assert.strictEqual(fillPrompt('{{count}} commits', { count: null }), 'the new commits');
    assert.strictEqual(fillPrompt('{{count}} commits', { count: 0 }), '0 commits');

    // The real thing, end to end.
    assert.strictEqual(
        fillPrompt('/adversarial-reviewer --diff {{range}}', { head, since }),
        `/adversarial-reviewer --diff ${'b'.repeat(12)}..${'a'.repeat(12)}`);
    ok('prompt placeholders, the no-marker fallback, and unknown ones left intact');
}

// --- the verdict --------------------------------------------------------

{
    // This is what decides whether a finished overnight run wakes anybody, so
    // both directions are worth pinning: a verdict that is missed stays silent
    // when it should not, and a false positive trains you to ignore the toast.
    const found = {
        'VERDICT: BLOCK': 'BLOCK',
        'verdict: block': 'BLOCK',
        '**VERDICT**: CONCERNS': 'CONCERNS',
        '**VERDICT: CLEAN**': 'CLEAN',
        'VERDICT BLOCK': 'BLOCK',
        '## VERDICT: CLEAN': 'CLEAN',
        '- VERDICT: CONCERNS': 'CONCERNS',
        '  VERDICT:   BLOCK  ': 'BLOCK',
        'Reviewed 3 commits.\n\nVERDICT: CLEAN\n\nNothing further.': 'CLEAN',
        // The real shape: a long report ending on the line that matters.
        ['# Review\n\n## Critical Findings\n\nNone.\n\n## Summary\n\nVERDICT: CLEAN'
            + '\n']: 'CLEAN',
    };
    for (const [text, want] of Object.entries(found)) {
        assert.strictEqual(verdictOf(text), want, JSON.stringify(text));
    }

    // No verdict is the ordinary case, not a defect: most schedules run prompts
    // that have nothing of the sort. It must not be mistaken for a bad outcome.
    for (const text of ['', null, undefined, 'All done.', 'Nothing to review.',
        // The trap: a review that *discusses* blocking rather than declaring it.
        'I would block this if it were not behind a flag.',
        'The verdict is still out on whether to BLOCK.',
        'VERDICT: MAYBE',
        'a VERDICT: BLOCK mid-sentence does not count']) {
        assert.strictEqual(verdictOf(text), null, JSON.stringify(text));
    }
    ok('verdictOf reads the decorated shapes and is not fooled by prose about them');
}

// --- the store ----------------------------------------------------------

const FIELDS = ['id', 'enabled', 'title', 'cwd', 'prompt', 'model', 'permissionMode',
    'test', 'cron', 'once', 'gate', 'lastSlotAt', 'lastFiredAt', 'lastSessionId',
    'lastOutcome', 'lastSkipReason', 'lastError', 'lastMarker', 'runs', 'createdAt',
    'updatedAt'];

{
    const s = fresh();
    assert.deepStrictEqual(s.list(), []);
    assert.strictEqual(s.get('nope'), null);

    const made = s.create({
        cwd: '/home/someone/proj', prompt: 'review {{range}}', cron: '0 2 * * 2-6',
        model: 'opus', permissionMode: 'dontAsk', test: true,
        gate: { kind: 'git-commits', ref: 'origin/main' },
        lastMarker: 'c'.repeat(40),
    });
    assert.ok(made.id);
    assert.deepStrictEqual(Object.keys(made).sort(), [...FIELDS].sort(),
        'the wire shape is the whitelist, so a body cannot smuggle a key in');
    assert.strictEqual(made.enabled, true, 'a new schedule is on');
    assert.strictEqual(made.once, false, 'and repeats unless it was asked not to');
    assert.strictEqual(made.runs, 0);
    assert.strictEqual(made.lastSlotAt, null);
    assert.strictEqual(made.lastMarker, 'c'.repeat(40), 'the seed marker is kept');
    assert.deepStrictEqual(made.gate, { kind: 'git-commits', ref: 'origin/main', fetch: true },
        'fetch defaults on');

    // A key not on the whitelist is dropped rather than stored.
    const sneaky = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *', evil: 'yes' });
    assert.strictEqual(sneaky.evil, undefined);

    s.flush();
    assert.deepStrictEqual(new Schedules().list().map(r => r.id).sort(),
        [made.id, sneaky.id].sort(), 'and it survives a reload');
    ok('create stores exactly the whitelisted fields and they survive a reload');
}

{
    const s = fresh();
    const row = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *', title: 'nightly' });

    // A patch is partial: an absent key is left alone, null is a value.
    const edited = s.update(row.id, { cron: '0 3 * * *' });
    assert.strictEqual(edited.cron, '0 3 * * *');
    assert.strictEqual(edited.title, 'nightly', 'an absent key is untouched');
    assert.strictEqual(s.update(row.id, { title: null }).title, null, 'null clears');
    assert.strictEqual(s.update(row.id, { enabled: false }).enabled, false);
    assert.strictEqual(s.update('nope', { title: 'x' }), null, 'an unknown id is null');

    // createdAt is when you wrote it down; the card says how long it has been
    // running. Only updatedAt moves.
    assert.strictEqual(s.get(row.id).createdAt, row.createdAt);
    assert.ok(s.get(row.id).updatedAt > row.updatedAt);

    // A PATCH must not be able to rewrite the run history — "which commits have
    // been reviewed" is not something a client gets to decide.
    s.note(row.id, { sessionId: 'sess-1', marker: 'd'.repeat(40) });
    s.update(row.id, { lastMarker: 'e'.repeat(40), runs: 99, lastSessionId: 'forged' });
    assert.strictEqual(s.get(row.id).lastMarker, 'd'.repeat(40));
    assert.strictEqual(s.get(row.id).runs, 1);
    assert.strictEqual(s.get(row.id).lastSessionId, 'sess-1');
    ok('update is a genuine patch and cannot touch the run history');
}

{
    // Re-enabling after a pause must not fire for every slot it slept through.
    const s = fresh();
    const row = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *' });
    s.update(row.id, { enabled: false });
    const before = Date.now();
    const on = s.update(row.id, { enabled: true });
    assert.ok(on.lastSlotAt >= before, 'turning it back on moves the cursor to now');

    // But an unrelated edit must not, or an edit at 1:59 AM would skip 2 AM.
    const marked = s.update(row.id, { lastSlotAt: undefined, title: 'renamed' });
    assert.strictEqual(marked.lastSlotAt, on.lastSlotAt, 'a plain edit leaves the cursor alone');
    ok('the off→on transition resets the slot cursor, and nothing else does');
}

{
    // A one-time schedule is spent by its slot, not by its run — so the two ways
    // a slot cursor advances both switch it off, and neither of the ways it does
    // not touches it.
    const spent = () => {
        const s = fresh();
        const row = s.create({
            cwd: '/a', prompt: 'p', cron: '0 17 29 8 *', once: true,
        });
        assert.strictEqual(row.once, true);
        assert.strictEqual(row.enabled, true, 'armed until its slot comes round');
        return { s, row };
    };

    // The tick taking the slot.
    {
        const { s, row } = spent();
        assert.strictEqual(s.claim(row.id, at(2026, 8, 29, 17, 0)), true);
        assert.strictEqual(s.get(row.id).enabled, false, 'claiming its slot spends it');
        assert.strictEqual(s.enabled().length, 0, 'so the tick stops walking it');
    }

    // The slot found too old to run. It did not fire and it is still spent: a
    // one-time trigger the machine slept through does not run late.
    {
        const { s, row } = spent();
        s.note(row.id, { slotAt: at(2026, 8, 29, 17, 0), skipReason: 'missed' });
        assert.strictEqual(s.get(row.id).enabled, false, 'a missed slot spends it too');
        assert.strictEqual(s.get(row.id).runs, 0, 'without ever having run');
    }

    // Run now, which does not touch `lastSlotAt` — pressing the button to try a
    // one-time schedule out must leave it armed for the slot it was made for.
    {
        const { s, row } = spent();
        s.note(row.id, { sessionId: 'sess-1', marker: 'aa' });
        assert.strictEqual(s.get(row.id).enabled, true, 'Run now does not spend it');
        assert.strictEqual(s.get(row.id).runs, 1, 'though it really did run');

        // Nor does the verdict arriving afterwards.
        s.note(row.id, { outcome: 'CLEAN' });
        assert.strictEqual(s.get(row.id).enabled, true);
    }

    // A repeating schedule is untouched by any of it.
    {
        const s = fresh();
        const row = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *' });
        s.claim(row.id, at(2026, 8, 29, 2, 0));
        s.note(row.id, { slotAt: at(2026, 8, 30, 2, 0), skipReason: 'missed' });
        assert.strictEqual(s.get(row.id).enabled, true, 'and repeats regardless');
    }

    // Spent, then turned back on by hand: the off→on cursor reset still applies,
    // so it does not immediately owe the slot it was spent for.
    {
        const { s, row } = spent();
        s.claim(row.id, at(2026, 8, 29, 17, 0));
        const before = Date.now();
        const on = s.update(row.id, { enabled: true });
        assert.strictEqual(on.enabled, true);
        assert.ok(on.lastSlotAt >= before, 'and starts from now, not from its old slot');
    }
    ok('a one-time schedule is spent by its slot, and Run now does not spend it');
}

{
    // note() is the only writer of history, and what it *leaves alone* is the
    // point: a skip or a failure must never advance the marker.
    const s = fresh();
    const row = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *', lastMarker: 'aa' });

    s.note(row.id, { skipReason: 'nothing-new', slotAt: 1000 });
    let now = s.get(row.id);
    assert.strictEqual(now.lastMarker, 'aa', 'a skip does not consume commits');
    assert.strictEqual(now.runs, 0, 'and is not a run');
    assert.strictEqual(now.lastSkipReason, 'nothing-new');
    assert.strictEqual(now.lastSlotAt, 1000);

    s.note(row.id, { skipReason: 'error', error: 'cannot resolve origin/main', slotAt: 2000 });
    assert.strictEqual(s.get(row.id).lastMarker, 'aa', 'nor does a failure');
    assert.strictEqual(s.get(row.id).lastError, 'cannot resolve origin/main');

    // A real run advances everything and clears the last skip, because a run
    // supersedes whatever the previous slot decided not to do.
    s.note(row.id, { sessionId: 'sess-2', marker: 'bb', slotAt: 3000 });
    now = s.get(row.id);
    assert.strictEqual(now.lastMarker, 'bb');
    assert.strictEqual(now.runs, 1);
    assert.strictEqual(now.lastSessionId, 'sess-2');
    assert.strictEqual(now.lastSkipReason, null);
    assert.ok(now.lastFiredAt > 0);

    // And the outcome lands on the row afterwards, when the turn finishes.
    s.note(row.id, { outcome: 'BLOCK' });
    assert.strictEqual(s.get(row.id).outcome, undefined);
    assert.strictEqual(s.get(row.id).lastOutcome, 'BLOCK');
    assert.strictEqual(s.get(row.id).runs, 1, 'recording an outcome is not a second run');
    ok('note() advances the marker only on a real run, and a skip keeps it');
}

{
    // claim() is the net under the everyday-instance gate: two stores over one
    // file, both trying to fire the same slot.
    const s = fresh();
    const row = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *' });
    s.flush();

    const other = new Schedules();
    assert.strictEqual(s.claim(row.id, 5000), true, 'the first claim wins');
    assert.strictEqual(other.claim(row.id, 5000), false,
        'and the second sees it on disk, because claim flushes synchronously');

    // A later slot is a different claim, not the same one again.
    assert.strictEqual(other.claim(row.id, 6000), true);
    assert.strictEqual(s.claim(row.id, 6000), false);
    // An earlier slot never wins — that is a stale tick, not a missed run.
    assert.strictEqual(s.claim(row.id, 4000), false);
    assert.strictEqual(s.claim('nope', 9000), false, 'an unknown id cannot be claimed');
    ok('claim() lets exactly one store take a slot, and only ever moves forward');
}

{
    // The catch-up cap, as the tick will apply it. Kept here rather than in the
    // server because the arithmetic is the part worth pinning down: an overnight
    // slot must survive a machine asleep until morning, and a slot from two days
    // ago must not run at a time nobody chose.
    const spec = parseCron('0 2 * * 2-6');

    // A machine asleep until 9 AM: the 2 AM slot is seven hours late and runs.
    const morning = at(2026, 8, 25, 9);
    const late = dueSlot(spec, { cursor: at(2026, 8, 24, 12), now: morning });
    assert.strictEqual(late.slot, at(2026, 8, 25, 2));
    assert.ok(morning - late.slot < CATCHUP_MS, 'seven hours late still runs');

    // Eighteen hours late is past the cap and is reported as missed instead.
    const evening = at(2026, 8, 26, 20);
    const stale = dueSlot(spec, { cursor: at(2026, 8, 25, 12), now: evening });
    assert.strictEqual(stale.slot, at(2026, 8, 26, 2));
    assert.ok(evening - stale.slot > CATCHUP_MS, 'eighteen hours late is reported as missed');

    // A week of downtime is one report, not five: the walk collapses the slots
    // it stepped over into a count, and the caller advances the cursor once.
    const week = dueSlot(spec, { cursor: at(2026, 8, 18, 2), now: at(2026, 8, 25, 12) });
    assert.strictEqual(week.slot, at(2026, 8, 25, 2), 'the latest owed slot is the one to act on');
    assert.strictEqual(week.skipped, 4, 'and the four before it are counted, not run');
    ok('the catch-up cap separates a late run from a missed one, and collapses a backlog');
}

{
    // Merge-on-write, drafts.js's bargain: two bridges share this file, and a
    // whole-file rewrite from a startup snapshot would erase the other's rows.
    const a = fresh();
    const mine = a.create({ cwd: '/a', prompt: 'mine', cron: '0 2 * * *' });
    a.flush();

    const b = new Schedules();
    const theirs = b.create({ cwd: '/b', prompt: 'theirs', cron: '0 3 * * *' });
    b.flush();

    // `a` has never seen `theirs`, and writing must not lose it.
    a.update(mine.id, { title: 'renamed' });
    a.flush();
    const onDisk = new Schedules().list();
    assert.strictEqual(onDisk.length, 2, 'both bridges\' schedules survive');
    assert.strictEqual(onDisk.find(r => r.id === mine.id).title, 'renamed');
    assert.strictEqual(onDisk.find(r => r.id === theirs.id).prompt, 'theirs');

    // Per id the newer updatedAt wins, so a stale copy cannot roll back an edit
    // it never saw.
    const stale = new Schedules();
    const staleRow = stale.rows.find(r => r.id === mine.id);
    a.update(mine.id, { title: 'newest' });
    a.flush();
    staleRow.title = 'rollback';
    stale.flush();
    assert.strictEqual(new Schedules().get(mine.id).title, 'newest',
        'an older row does not overwrite a newer one');

    // A deletion is tracked rather than inferred from absence, so the row does
    // not get read straight back in and re-saved.
    a.remove(mine.id);
    a.flush();
    assert.strictEqual(new Schedules().get(mine.id), null, 'and a delete sticks');
    assert.ok(new Schedules().get(theirs.id), 'without taking the other bridge\'s row');
    ok('merge-on-write keeps two bridges\' schedules, newest wins, deletes stick');
}

{
    // reload() is what lets the everyday bridge — the only one that fires — pick
    // up a schedule made anywhere else. Without it a schedule created from a dev
    // bridge or a phone sits in the file doing nothing until the firing process
    // happens to restart, which on this machine can be days.
    const a = fresh();
    const mine = a.create({ cwd: '/a', prompt: 'mine', cron: '0 2 * * *' });
    a.flush();

    const b = new Schedules();
    const theirs = b.create({ cwd: '/b', prompt: 'theirs', cron: '0 3 * * *' });
    b.flush();

    assert.strictEqual(a.get(theirs.id), null, 'not seen before a reload');
    a.reload();
    assert.ok(a.get(theirs.id), 'and seen after one');
    assert.ok(a.enabled().some(r => r.id === theirs.id), 'so the tick will consider it');

    // The flush-before-read is the load-bearing half: a write still inside the
    // 400ms debounce must survive the reload rather than being read over.
    a.note(mine.id, { skipReason: 'nothing-new', slotAt: 4242 });
    a.reload();
    assert.strictEqual(a.get(mine.id).lastSkipReason, 'nothing-new',
        'a pending write is flushed out before the file is read back');
    assert.strictEqual(a.get(mine.id).lastSlotAt, 4242);
    assert.ok(a.get(theirs.id), 'and the other bridge\'s row is still there');
    ok('reload() takes up another bridge\'s rows without dropping our own pending writes');
}

{
    // The three branches of read() that only run on a bad day.
    fs.writeFileSync(STATE_FILE, 'not json at all');
    assert.deepStrictEqual(new Schedules().list(), [], 'unreadable is empty, not a throw');

    fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 99, schedules: [{ id: 'x' }] }));
    assert.deepStrictEqual(new Schedules().list(), [], 'a future version is discarded');

    // A BOM, because this file is plain enough that somebody may open it.
    const s = fresh();
    const row = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *' });
    s.flush();
    fs.writeFileSync(STATE_FILE, '﻿' + fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(new Schedules().list().length, 1, 'a BOM is tolerated');
    assert.strictEqual(new Schedules().get(row.id).cron, '0 2 * * *');

    // Rows missing something load-bearing are dropped rather than repaired —
    // there is no cwd to invent, and an unparseable expression would otherwise
    // sit there looking armed and never fire.
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        version: 1,
        schedules: [
            { id: 'ok', cwd: '/a', prompt: 'p', cron: '0 2 * * *' },
            { id: 'no-cwd', prompt: 'p', cron: '0 2 * * *' },
            { id: 'no-prompt', cwd: '/a', cron: '0 2 * * *' },
            { id: 'no-cron', cwd: '/a', prompt: 'p' },
            { id: 'bad-cron', cwd: '/a', prompt: 'p', cron: 'every tuesday please' },
            { cwd: '/a', prompt: 'p', cron: '0 2 * * *' },
        ],
    }));
    assert.deepStrictEqual(new Schedules().list().map(r => r.id), ['ok'],
        'a row that cannot fire is dropped, and an unparseable expression is one of those');

    // An older row without `enabled` reads as on: it is a schedule somebody wanted.
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        version: 1, schedules: [{ id: 'old', cwd: '/a', prompt: 'p', cron: '0 2 * * *' }],
    }));
    assert.strictEqual(new Schedules().get('old').enabled, true);
    ok('a bad file, a future version, a BOM, and rows that cannot fire');
}

{
    const s = fresh();
    const on = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *' });
    const off = s.create({ cwd: '/a', prompt: 'p', cron: '0 3 * * *', enabled: false });
    assert.deepStrictEqual(s.enabled().map(r => r.id), [on.id],
        'the tick only considers what is switched on');
    assert.strictEqual(s.list().length, 2, 'but a paused schedule is still listed');
    assert.strictEqual(s.get(off.id).enabled, false);
    ok('enabled() is what the tick walks; a paused schedule is kept, not deleted');
}

{
    // A gate is either whole or absent — a half-specified one that silently
    // never matches would be worse than no gate at all.
    const s = fresh();
    const noRef = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *',
        gate: { kind: 'git-commits' } });
    assert.strictEqual(noRef.gate, null, 'a gate with no ref is no gate');

    const unknown = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *',
        gate: { kind: 'phase-of-moon', ref: 'x' } });
    assert.strictEqual(unknown.gate, null, 'and an unknown kind is refused, not stored');

    const off = s.create({ cwd: '/a', prompt: 'p', cron: '0 2 * * *',
        gate: { kind: 'git-commits', ref: 'main', fetch: false } });
    assert.deepStrictEqual(off.gate, { kind: 'git-commits', ref: 'main', fetch: false },
        'fetch:false is honoured, unlike a missing fetch which defaults on');

    // And it can be cleared by patching it away.
    assert.strictEqual(s.update(off.id, { gate: null }).gate, null);
    ok('a gate is stored whole or not at all');
}

{
    const s = fresh();
    for (let i = 0; i < MAX_SCHEDULES; i++) {
        assert.ok(s.create({ cwd: '/a', prompt: `n${i}`, cron: '0 2 * * *' }),
            `schedule ${i} was made`);
    }
    assert.strictEqual(s.list().length, MAX_SCHEDULES);
    assert.strictEqual(s.create({ cwd: '/a', prompt: 'one too many', cron: '0 2 * * *' }), null,
        'the cap returns null, which the route turns into a 409');
    assert.strictEqual(s.list().length, MAX_SCHEDULES, 'and nothing was stored');

    s.remove(s.list()[0].id);
    assert.ok(s.create({ cwd: '/a', prompt: 'room again', cron: '0 2 * * *' }));
    ok(`the ${MAX_SCHEDULES}-schedule cap refuses the next one, and lifts when one is deleted`);
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} groups passed`);
