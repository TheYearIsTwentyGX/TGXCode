'use strict';

// Sessions that start on a clock.
//
// Work that should happen on a schedule had nowhere to live here. "Review
// whatever landed overnight" either did not happen, or it happened outside the
// app as a cron entry running headless `claude -p` into a report file — which
// works, and is invisible: no session row, no transcript, no history of what it
// found. This app is where the results get read, so this is where the schedule
// belongs.
//
// **A schedule is a draft that is never consumed, plus a cron expression, plus a
// gate.** That is not a metaphor, it is the implementation: the fields below are
// the ones `POST /api/sessions` takes, validated by the same `scheduleFields` →
// `resolveWorkdir` → `normalizeMode` path drafts.js's go through, and fired by
// the same sequence `POST /api/drafts/:id/start` runs. Everything about how this
// file stores rows is drafts.js, for the reasons drafts.js gives.
//
// **`docs/plans/15-scheduling.md` argued against building this**, on the grounds
// that Claude Code already schedules agents and that a duplicated scheduler is
// how a job comes to run twice. That premise did not survive contact: the CLI's
// own cron is session-scoped and in-memory — gone when the session exits, and
// expiring after a week — so it cannot hold a nightly schedule at all. Cloud
// routines can, but they run against a clone, so they cannot use a skill that
// only exists in a local checkout. And "since the prior run" is state nothing
// outside this app keeps. What survives from that note is its warning, and it is
// the reason for four of the rules below: *do not write a `setInterval`
// scheduler and call it done.*
//
// The four:
//
//   * **`lastSlotAt`, not `lastFiredAt`, decides whether to fire.** The slot is
//     the wall-clock minute the cron expression matched; recording the slot we
//     satisfied rather than the moment we acted is what makes firing idempotent
//     across a restart, a second bridge, and a tick that lands twice in the same
//     minute. `lastFiredAt` is for the card to draw and nothing else.
//   * **A slot older than `CATCHUP_MS` is skipped, not run.** The bridge is not
//     up continuously, so catching up is the point — but a machine that was off
//     for a week must not produce five reviews at breakfast. Missing is recorded
//     and notified, because a schedule that quietly stops firing is the failure
//     worth hearing about.
//   * **Only one instance fires.** Several bridges share this file by design;
//     the caller gates the tick on being the everyday one. Nothing here enforces
//     that — a store cannot know which bridge it is in — but `claim()` exists so
//     that two of them racing still cannot double-fire.
//   * **The marker advances only after a session actually starts.** A failed
//     spawn that consumed the commit range would lose a night's review silently.
//
// **Merge-on-write, not last-writer-wins**, the same as drafts.js and for a
// sharper version of the same reason. Two bridges share `schedules.json`; a
// whole-file rewrite from a startup snapshot would mean the first write by any
// bridge erases every schedule made in another since it booted. A schedule is
// more expensive than a draft to lose, not less: it is a decision plus the
// history of every run it has done.
//
// The `_removed` tombstone set, the strictly-increasing `_stamp()`, the BOM
// tolerance and the version check are all drafts.js's, unchanged, and the
// comments there explain each one.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { STATE_DIR } = require('./config');

const STATE_FILE = path.join(STATE_DIR, 'schedules.json');
const VERSION = 1;

// Lower than drafts' 200 on purpose. A draft is a message you might send; a
// schedule is a thing that starts processes on its own, and fifty of those is
// already a machine nobody is supervising. The cap is a brake on a client in a
// loop, not a judgement about how many anybody needs.
const MAX_SCHEDULES = 50;

// How late a missed slot may be and still run. Twelve hours means an overnight
// slot survives a machine that was asleep until morning — which is the case this
// exists for — while a slot from the day before yesterday is reported as missed
// rather than run at a time nobody chose it for.
const CATCHUP_MS = 12 * 60 * 60 * 1000;

// The furthest ahead `nextSlot` will look before giving up. Five years covers
// every real expression including `0 3 29 2 *` (Feb 29, so up to four years
// away); the point of the bound is that a satisfiable-looking expression which
// never matches — `0 0 30 2 *`, Feb 30 — must return null rather than spin.
//
// Counted in *days* because that is how the search moves: see nextSlot.
const HORIZON_DAYS = 5 * 366;

const MINUTE_MS = 60_000;

/** Why a slot passed without starting a session. */
const SKIP_REASONS = ['nothing-new', 'missed', 'disabled', 'error', 'rate-limited'];

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------
//
// Hand-rolled, and that is a deliberate choice rather than an oversight: this
// package has no dependencies and no build step, and the subset of cron a
// schedule needs is a hundred lines. What is *not* supported is named months and
// weekdays (`MON`, `JAN`), `@daily`, `L`, `#` and `?` — none of which the UI can
// produce, and all of which are better refused loudly than half-implemented.
//
// Everything here is a pure function of its arguments and the local timezone.
// They are exported for the tests, which is where the edge cases live: a slot
// across a DST boundary, the end of a month, and a day-of-month/day-of-week pair
// that cron's own rules say is an OR rather than an AND.

const FIELDS = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'dom', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12 },
    { name: 'dow', min: 0, max: 7 },
];

/**
 * One field of an expression as the set of values it matches.
 *
 * @returns {{values: Set<number>, star: boolean} | {error: string}}
 */
function parseField(text, { name, min, max }) {
    const raw = String(text || '').trim();
    if (!raw) return { error: `${name} is empty` };

    const values = new Set();
    for (const part of raw.split(',')) {
        const piece = part.trim();
        if (!piece) return { error: `${name} has an empty entry` };

        // `*/n` and `a-b/n` both step; a bare `n` after the slash without a
        // range in front means "every n from the bottom of the field".
        const [spec, stepText] = piece.split('/');
        let step = 1;
        if (stepText !== undefined) {
            step = Number(stepText);
            if (!Number.isInteger(step) || step < 1) {
                return { error: `${name} has a bad step "${stepText}"` };
            }
        }

        let lo;
        let hi;
        if (spec === '*') {
            lo = min;
            hi = max;
        } else if (spec.includes('-')) {
            const [a, b] = spec.split('-');
            lo = Number(a);
            hi = Number(b);
        } else {
            lo = Number(spec);
            hi = stepText === undefined ? lo : max;
        }

        if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
            return { error: `${name} has a bad value "${piece}"` };
        }
        if (lo < min || hi > max || lo > hi) {
            return { error: `${name} must be ${min}-${max}, got "${piece}"` };
        }
        for (let v = lo; v <= hi; v += step) values.add(v);
    }

    // Cron's one irregular field: Sunday is both 0 and 7, and an expression may
    // use either. Normalising to 0 here means `matches` never has to know.
    if (name === 'dow' && values.has(7)) {
        values.delete(7);
        values.add(0);
    }

    return { values, star: raw === '*' };
}

/**
 * A 5-field expression, in local time.
 *
 * @returns {{minute, hour, dom, month, dow, text} | {error: string}}
 */
function parseCron(text) {
    const parts = String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 5) {
        return {
            error: 'a schedule needs five space-separated fields '
                + `(minute hour day-of-month month day-of-week), got ${parts.length}`,
        };
    }
    const spec = { text: parts.join(' ') };
    for (let i = 0; i < FIELDS.length; i++) {
        const field = parseField(parts[i], FIELDS[i]);
        if (field.error) return { error: field.error };
        spec[FIELDS[i].name] = field;
    }
    return spec;
}

/**
 * Does this *day* match — month, day-of-month, day-of-week?
 *
 * Split from the time half because it is what lets the search skip a whole day
 * at a time. The day pair is cron's documented oddity: when day-of-month and
 * day-of-week are *both* restricted, a day matching **either** counts. Getting
 * this wrong is invisible in the common cases — one of the two is almost always
 * `*` — and then silently wrong for `0 2 1 * 1`, which crontab(5) says means the
 * 1st of the month *and* every Monday.
 */
function dayMatches(spec, date) {
    if (!spec.month.values.has(date.getMonth() + 1)) return false;

    const domOk = spec.dom.values.has(date.getDate());
    const dowOk = spec.dow.values.has(date.getDay());
    if (spec.dom.star && spec.dow.star) return true;
    if (spec.dom.star) return dowOk;
    if (spec.dow.star) return domOk;
    return domOk || dowOk;
}

/** Does the clock half match — hour and minute? */
function timeMatches(spec, date) {
    return spec.hour.values.has(date.getHours())
        && spec.minute.values.has(date.getMinutes());
}

/** Does this minute match? */
function matches(spec, date) {
    return dayMatches(spec, date) && timeMatches(spec, date);
}

/** Local midnight at the start of the day after `date`. */
function nextMidnight(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

/** A Date at the top of the minute containing `ms`. */
function floorMinute(ms) {
    const d = new Date(ms);
    d.setSeconds(0, 0);
    return d;
}

/**
 * A local wall-clock minute, as a value that can be compared.
 *
 * Not the same thing as an instant, and the difference is the autumn clock
 * change: when the clocks go back, local 01:30 happens at two epoch times an
 * hour apart. A walk that steps epoch minutes and asks "does this match" says
 * yes to both, so a daily `30 1 * * *` fires twice that night — which is exactly
 * the duplicated unattended run this whole file is arranged to prevent.
 *
 * Keying on the wall-clock minute makes "02:00 on the 25th" one slot however
 * many instants wear that label, which is what a person means by a schedule and
 * what every cron implementation does. The spring-forward case needs nothing
 * extra: the local minute simply does not occur, no candidate matches, and that
 * day has no run — also the standard behaviour.
 */
function localKey(date) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
        + `T${date.getHours()}:${date.getMinutes()}`;
}

/**
 * The first matching minute strictly after `after`, or null within the horizon.
 *
 * Minute-by-minute rather than arithmetic on the fields. It is a few thousand
 * cheap comparisons for a daily schedule and it is *correct across DST without
 * knowing anything about DST*, because it asks a local `Date` what its own
 * hour is at every step. Field arithmetic here is where duplicate and missing
 * runs on the two switch days come from.
 */
function nextSlot(spec, after = Date.now()) {
    if (!spec || spec.error) return null;
    const start = floorMinute(after);
    // The wall-clock minute we are starting from. A candidate wearing the same
    // label is the *same slot* seen a second time — see localKey — so it is
    // stepped over rather than returned. Without this, walking forward from a
    // slot we just fired finds it again an hour later on the night the clocks
    // go back.
    const from = localKey(start);

    // **Skip by day first, then by minute inside a matching day.** The obvious
    // version steps one minute at a time from here to a match, which is correct
    // and unusably slow at the edges: five years is 2.6 million `new Date()`
    // calls, so an expression that never matches — `0 0 31 4 *`, April 31st —
    // took about a quarter of a second to say so. That is per keystroke in the
    // dialog, which asks for this on every input event, and it blocks the event
    // loop for a bridge that is also serving a live board.
    //
    // Asking "does this day match" first collapses that: a non-matching day
    // costs one comparison and a jump to midnight, so the worst case is ~1800
    // steps rather than millions, and the minute walk only ever runs on a day
    // that can actually contain a slot.
    let cur = new Date(start.getTime() + MINUTE_MS);
    for (let day = 0; day < HORIZON_DAYS; day++) {
        if (!dayMatches(spec, cur)) {
            cur = nextMidnight(cur);
            continue;
        }
        const end = nextMidnight(cur).getTime();
        // Epoch ms with local fields read back, rather than incrementing local
        // fields: a spring-forward jump lands the wall clock an hour on while
        // the epoch advanced a minute, and this simply steps through whatever
        // local minutes exist without having to know that happened.
        for (let ms = cur.getTime(); ms < end; ms += MINUTE_MS) {
            const at = new Date(ms);
            if (timeMatches(spec, at) && localKey(at) !== from) return ms;
        }
        cur = new Date(end);
    }
    return null;
}

// How many slots one `dueSlot` walk will step through. A schedule that has been
// unable to run for a long time — the bridge down, the machine off — must still
// converge rather than walk a year of `*/5` minutes in one tick. Hitting the
// limit is not a failure: the walk returns the furthest slot it reached, the
// caller records the cursor there, and the next tick continues from it.
const WALK_LIMIT = 4096;

/**
 * The slot this schedule owes, walking forward from the one it last satisfied.
 *
 * The firing question, and it is asked *forward from the cursor* rather than
 * backward from now. Both directions were tried. Backward means picking a
 * lookback window, and any window is wrong: 36 hours cannot see across the
 * Sunday-and-Monday gap in `0 2 * * 2-6`, so on a Monday the previous Saturday
 * simply vanished — a missed run that could never be reported because nothing
 * could find it. Widening the window to cover a monthly schedule means scanning
 * 44,000 minutes per schedule per tick for an answer that is almost always one
 * step away.
 *
 * Forward from the cursor has neither problem. It is one `nextSlot` call in the
 * ordinary case, it is exact however sparse the expression, and "what have I not
 * done yet" is the question the tick actually has.
 *
 * A tick every thirty seconds cannot instead ask "is now a match" — it would
 * miss any slot falling between two ticks and double-fire any it saw twice.
 * Comparing the owed slot against the one already claimed makes both impossible,
 * and makes catching up after a restart the same code path as firing on time.
 *
 * @param {object} spec
 * @param {{cursor: number, now?: number, limit?: number}} opts `cursor` is
 *   `lastSlotAt`, or `createdAt` for a schedule that has never run.
 * @returns {{slot: number|null, skipped: number}} the latest slot at or before
 *   `now` that the cursor has not passed, and how many earlier ones it stepped
 *   over — so a week of downtime is one report rather than five.
 */
function dueSlot(spec, { cursor, now = Date.now(), limit = WALK_LIMIT } = {}) {
    if (!spec || spec.error) return { slot: null, skipped: 0 };
    let slot = null;
    let skipped = 0;
    let from = Number.isFinite(cursor) ? cursor : now;
    for (let i = 0; i < limit; i++) {
        const next = nextSlot(spec, from);
        if (next === null || next > now) break;
        if (slot !== null) skipped++;
        slot = next;
        from = next;
    }
    return { slot, skipped };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `[0,1,2]` → `"Sun–Tue"`, `[1,3]` → `"Mon, Wed"`. */
function daysText(values) {
    const days = [...values].sort((a, b) => a - b);
    if (days.length === 7) return 'every day';
    if (days.length === 5 && days.join() === '1,2,3,4,5') return 'weekdays';
    if (days.length === 2 && days.join() === '0,6') return 'weekends';

    // Contiguous runs read far better than a list once there are more than two:
    // "Tue–Sat" rather than "Tue, Wed, Thu, Fri, Sat".
    const runs = [];
    for (const d of days) {
        const last = runs[runs.length - 1];
        if (last && d === last[1] + 1) last[1] = d;
        else runs.push([d, d]);
    }
    return runs
        .map(([a, b]) => {
            if (a === b) return days.length === 1 ? DAY_NAMES[a] : DAY_SHORT[a];
            if (b === a + 1) return `${DAY_SHORT[a]}, ${DAY_SHORT[b]}`;
            return `${DAY_SHORT[a]}–${DAY_SHORT[b]}`;
        })
        .join(', ');
}

/** `h:mm am/pm`, matching how the rest of the UI writes a time. */
function clockText(hour, minute) {
    const suffix = hour < 12 ? 'AM' : 'PM';
    const h = hour % 12 === 0 ? 12 : hour % 12;
    return `${h}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/**
 * The expression in English, for the card.
 *
 * The card shows this instead of the raw expression because `0 2 * * 2-6` is not
 * something anybody should have to decode to check they typed what they meant.
 * It covers the shapes the dialog can produce and falls back to the expression
 * itself for anything hand-written and odd — a wrong-looking sentence would be
 * worse than the honest raw text.
 */
function describeCron(spec) {
    if (!spec || spec.error) return null;
    const { minute, hour, dom, month, dow } = spec;

    const everyMonth = month.values.size === 12;
    const oneTime = minute.values.size === 1 && hour.values.size === 1;

    if (oneTime && everyMonth && dom.star) {
        const time = clockText([...hour.values][0], [...minute.values][0]);
        if (dow.star) return `every day at ${time}`;
        return `${daysText(dow.values)} at ${time}`;
    }

    if (oneTime && everyMonth && dow.star && dom.values.size === 1) {
        const time = clockText([...hour.values][0], [...minute.values][0]);
        return `the ${ordinal([...dom.values][0])} of each month at ${time}`;
    }

    // `*/n * * * *` and friends — the shape a test schedule uses.
    if (dom.star && dow.star && everyMonth && hour.star && minute.values.size > 1) {
        const sorted = [...minute.values].sort((a, b) => a - b);
        const step = sorted.length > 1 ? sorted[1] - sorted[0] : 0;
        const even = step > 0 && sorted.every((v, i) => v === sorted[0] + i * step);
        if (even && sorted[0] === 0) return `every ${step} minutes`;
    }

    return spec.text;
}

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * Fill the placeholders a schedule's prompt may carry.
 *
 * Substituted at fire time rather than stored expanded, which is the whole point:
 * the prompt is written once and says something true on every run. `{{range}}` is
 * the one that matters — it is how "since the prior run" reaches the session at
 * all.
 *
 * **An unknown placeholder is left alone**, on purpose. A prompt is prose, and
 * `{{` is not reserved punctuation in it; blanking something this function does
 * not recognise would quietly delete part of a message somebody wrote. A typo'd
 * `{{rang}}` arriving in the session verbatim is a bug you can see.
 *
 * @param {string} prompt
 * @param {{head?: string|null, since?: string|null, count?: number|null,
 *   ref?: string|null, at?: number}} facts
 */
function fillPrompt(prompt, facts = {}) {
    const short = (sha) => (sha ? String(sha).slice(0, 12) : '');
    const head = short(facts.head);
    const since = short(facts.since);

    // No marker — a first run, or one whose marker git no longer has. Reviewing
    // the whole history is never what was meant, so the range narrows to the tip
    // commit. Deliberately not empty: a prompt whose range vanished reads as an
    // instruction to review nothing.
    const range = head && since ? `${since}..${head}` : (head ? `${head}~1..${head}` : '');

    const values = {
        range,
        head,
        since,
        ref: facts.ref || '',
        count: facts.count == null ? 'the new' : String(facts.count),
        date: new Date(facts.at || Date.now()).toISOString().slice(0, 10),
    };

    return String(prompt).replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole
    ));
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Read a verdict out of what a run said, or null.
 *
 * This is what decides whether a finished overnight run wakes anybody. The
 * review skill this was built for ends on a `VERDICT: BLOCK` line, and lifting
 * that one word is what lets a clean review stay silent while a blocking one
 * raises a notification — which is the difference between a morning where the
 * absence of a toast means something and one where you have learned to ignore
 * them.
 *
 * **No match is not a failure.** A schedule can run any prompt, and most will
 * have no verdict at all; that case is "finished, nothing to say". Treating an
 * absent verdict as a problem would make the loud path the default and undo the
 * point of reading it.
 *
 * Tolerant about the decoration around the word because the text is prose from a
 * language model, not a machine format: bold markers, a heading hash, a leading
 * bullet, and a missing colon all appear in practice. Anchored per line and
 * requiring the literal word `VERDICT`, so it cannot be tripped by a review that
 * merely *discusses* blocking something.
 */
function verdictOf(text) {
    const m = /^[ \t]*(?:[#>*-]+[ \t]*)?(?:\*\*)?VERDICT(?:\*\*)?[ \t]*:?[ \t]*(?:\*\*)?[ \t]*(BLOCK|CONCERNS|CLEAN)\b/im
        .exec(String(text || ''));
    return m ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** `null` unless it is a non-empty string. */
function orNull(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s || null;
}

function numOrNull(v) {
    return Number.isFinite(v) ? v : null;
}

/**
 * A gate, or null for "fire every time the clock says so".
 *
 * One kind so far. Spelled as a tagged object rather than a pair of loose fields
 * because the second kind is easy to imagine — a gate on a PR being open, on a
 * file changing — and a `gateRef`/`gateFetch` pair on the row would have to be
 * renamed the moment one arrives.
 */
function cleanGate(gate) {
    if (!gate || typeof gate !== 'object') return null;
    if (gate.kind !== 'git-commits') return null;
    const ref = orNull(gate.ref);
    if (!ref) return null;
    return { kind: 'git-commits', ref, fetch: gate.fetch !== false };
}

/**
 * The fields a schedule carries.
 *
 * Spelled out rather than spread, so a caller cannot smuggle a key into the
 * store by putting it in a request body — `update` takes a patch straight off
 * the wire. drafts.js's rule, and the reason is the same.
 */
function clean(row) {
    return {
        id: row.id,
        enabled: row.enabled,
        // Null means "derive it from the first line of the prompt". A title you
        // typed is a decision; the first line of a prompt is a guess.
        title: row.title,
        cwd: row.cwd,
        prompt: row.prompt,
        model: row.model,
        permissionMode: row.permissionMode,
        test: row.test,
        cron: row.cron,
        gate: row.gate,
        // What has happened. Kept on the row rather than derived from the
        // notification log because the card must be able to say "last run 3 days
        // ago, nothing new" after a log rotation.
        lastSlotAt: row.lastSlotAt,
        lastFiredAt: row.lastFiredAt,
        lastSessionId: row.lastSessionId,
        lastOutcome: row.lastOutcome,
        lastSkipReason: row.lastSkipReason,
        lastError: row.lastError,
        lastMarker: row.lastMarker,
        runs: row.runs,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/** Newest-updated first, the order a client draws them in. */
const byUpdated = (a, b) => b.updatedAt - a.updatedAt;

/**
 * The file as rows, or an empty list.
 *
 * Module-level rather than a method because `flush()` needs it too, to merge
 * over whatever another bridge has written since this one loaded.
 */
function read() {
    let raw;
    try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return []; }
    try {
        const data = JSON.parse(raw.replace(/^﻿/, ''));
        if (data.version !== VERSION) return [];
        const rows = Array.isArray(data.schedules) ? data.schedules : [];
        const out = [];
        for (const row of rows) {
            // The four fields without which a schedule cannot do anything.
            // Dropped rather than repaired: there is no cwd to invent, no
            // message to invent, and an unparseable expression would otherwise
            // be a row that sits there looking armed and never fires.
            if (!row || typeof row.id !== 'string') continue;
            if (typeof row.cwd !== 'string' || !row.cwd) continue;
            if (typeof row.prompt !== 'string' || !row.prompt) continue;
            if (typeof row.cron !== 'string' || parseCron(row.cron).error) continue;
            out.push(clean({
                id: row.id,
                // Absent reads as on. A row written by an older version, or by
                // hand, is a schedule somebody wanted.
                enabled: row.enabled !== false,
                title: orNull(row.title),
                cwd: row.cwd,
                prompt: row.prompt,
                model: orNull(row.model),
                // Not checked against PERMISSION_MODES here, and it does not
                // need to be: `scheduleFields` normalizes on the way in and the
                // fire path normalizes again on the way out, so a mode this file
                // cannot vouch for still cannot reach `claude`. Rejecting it
                // here would only mean silently dropping a schedule if the list
                // of modes were ever renamed upstream.
                permissionMode: typeof row.permissionMode === 'string'
                    ? row.permissionMode : 'auto',
                test: !!row.test,
                cron: row.cron,
                gate: cleanGate(row.gate),
                lastSlotAt: numOrNull(row.lastSlotAt),
                lastFiredAt: numOrNull(row.lastFiredAt),
                lastSessionId: orNull(row.lastSessionId),
                lastOutcome: orNull(row.lastOutcome),
                lastSkipReason: orNull(row.lastSkipReason),
                lastError: orNull(row.lastError),
                lastMarker: orNull(row.lastMarker),
                runs: Number.isFinite(row.runs) ? row.runs : 0,
                createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
                updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
            }));
        }
        return out.sort(byUpdated);
    } catch (err) {
        console.error(`[claude-sessions] ignoring unreadable ${STATE_FILE}: ${err.message}`);
        return [];
    }
}

class Schedules {
    constructor() {
        /** @type {Array<object>} newest-updated first; see list(). */
        this.rows = [];
        /**
         * Ids this bridge has deleted, held until the write that carries the
         * deletion out. Without it a merge could not tell a row we removed from
         * one another bridge has just added.
         * @type {Set<string>}
         */
        this._removed = new Set();
        this._saveTimer = null;
        this.load();
    }

    load() {
        this.rows = read();
    }

    /**
     * Take up whatever another bridge has written, without losing our own.
     *
     * drafts.js does not have this, and can live without it: a draft another
     * window created is one you will see on the next reload, and the comment
     * there says so. A schedule cannot live without it, because it is not only
     * *displayed* from these rows — it is **fired** from them. The everyday
     * instance is the only process that fires, so a schedule created anywhere
     * else would sit on disk doing nothing until that bridge happened to
     * restart, which on this machine can be days.
     *
     * `flush()` first, and that order is the whole of it. Writes here are on a
     * 400ms debounce, so re-reading without flushing would throw away a `note()`
     * from a moment ago — and since `flush()` merges rather than overwrites,
     * doing it first means our pending changes reach the file and come back in
     * the read as the newest version of themselves.
     */
    reload() {
        this.flush();
        this.rows = read();
    }

    /** Debounced atomic write — the shape flags.js uses, for the same reason. */
    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => this.flush(), 400);
        this._saveTimer.unref();
    }

    /**
     * Write now, merging over the file.
     *
     * Split out of `save()` so a caller that cannot wait 400ms can force the
     * write. Two of them must: the bridge's shutdown, and `claim()` — where it
     * is the entire mechanism. An unflushed claim is not a claim.
     */
    flush() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        try {
            // Start from disk so another bridge's rows survive, then let ours
            // win per id — but only where ours is not older, so a snapshot
            // taken before somebody else's edit cannot undo it.
            const merged = new Map(read().map(r => [r.id, r]));
            for (const row of this.rows) {
                const theirs = merged.get(row.id);
                if (!theirs || row.updatedAt >= theirs.updatedAt) merged.set(row.id, row);
            }
            for (const id of this._removed) merged.delete(id);
            this._removed.clear();

            const rows = [...merged.values()].sort(byUpdated);
            fs.mkdirSync(STATE_DIR, { recursive: true });
            const tmp = STATE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, schedules: rows }, null, 2));
            fs.renameSync(tmp, STATE_FILE);
        } catch (err) {
            console.error(`[claude-sessions] could not save schedules: ${err.message}`);
        }
    }

    _sort() {
        this.rows.sort(byUpdated);
    }

    /**
     * A timestamp strictly greater than every row this store holds.
     *
     * drafts.js's `_stamp`, and load-bearing for the same two reasons: two writes
     * in the same millisecond would compare equal, which breaks both the list
     * order and the merge rule in `flush()` that decides whose row wins.
     */
    _stamp() {
        const now = Date.now();
        let newest = 0;
        for (const r of this.rows) if (r.updatedAt > newest) newest = r.updatedAt;
        return now > newest ? now : newest + 1;
    }

    list() {
        return this.rows.map(clean);
    }

    /** Just the ones a tick should consider. */
    enabled() {
        return this.rows.filter(r => r.enabled).map(clean);
    }

    get(id) {
        const row = this.rows.find(r => r.id === id);
        return row ? clean(row) : null;
    }

    /**
     * @returns {object|null} the schedule, or null at the cap — which the route
     *   turns into a 409. Null rather than a throw so the caller does not have
     *   to read a message to tell the two apart.
     */
    create(fields = {}) {
        if (this.rows.length >= MAX_SCHEDULES) return null;
        const now = this._stamp();
        const row = clean({
            id: randomUUID(),
            enabled: fields.enabled !== false,
            title: orNull(fields.title),
            cwd: String(fields.cwd),
            prompt: String(fields.prompt),
            model: orNull(fields.model),
            permissionMode: String(fields.permissionMode || 'auto'),
            test: !!fields.test,
            cron: String(fields.cron),
            gate: cleanGate(fields.gate),
            // **Seeded, not zero.** The caller resolves the gate's ref before
            // creating and passes the SHA, so the first run reviews what arrives
            // *after* you set the schedule up. Without this the first run's range
            // is the entire history of the repository.
            lastSlotAt: null,
            lastFiredAt: null,
            lastSessionId: null,
            lastOutcome: null,
            lastSkipReason: null,
            lastError: null,
            lastMarker: orNull(fields.lastMarker),
            runs: 0,
            createdAt: now,
            updatedAt: now,
        });
        this.rows.push(row);
        this._sort();
        this.save();
        return clean(row);
    }

    /**
     * Apply a partial change.
     *
     * A genuine patch: a key absent from `fields` is left alone. `undefined` is
     * the absence and `null` is a value.
     *
     * The run history is deliberately not writable here — `note()` owns it. An
     * edit is about what the schedule *will* do, and letting a PATCH rewrite
     * `lastMarker` would make "which commits have been reviewed" something a
     * client could get wrong.
     */
    update(id, fields = {}) {
        const row = this.rows.find(r => r.id === id);
        if (!row) return null;

        const wasEnabled = row.enabled;
        if (fields.enabled !== undefined) row.enabled = !!fields.enabled;
        if (fields.title !== undefined) row.title = orNull(fields.title);
        if (fields.cwd !== undefined) row.cwd = String(fields.cwd);
        if (fields.prompt !== undefined) row.prompt = String(fields.prompt);
        if (fields.model !== undefined) row.model = orNull(fields.model);
        if (fields.permissionMode !== undefined) {
            row.permissionMode = String(fields.permissionMode);
        }
        if (fields.test !== undefined) row.test = !!fields.test;
        if (fields.cron !== undefined) row.cron = String(fields.cron);
        if (fields.gate !== undefined) row.gate = cleanGate(fields.gate);

        // A schedule re-enabled after a long pause must not fire for every slot
        // it slept through. Moving the slot cursor to the moment of the edit
        // means the next run is the next *scheduled* one — which is what turning
        // something back on means. Only on the off→on transition: doing it on
        // every PATCH would let an unrelated edit at 1:59 AM skip the 2 AM run.
        if (!wasEnabled && row.enabled) row.lastSlotAt = Date.now();

        row.updatedAt = this._stamp();
        this._sort();
        this.save();
        return clean(row);
    }

    /**
     * Take a slot, or find that somebody else already has.
     *
     * The last guard against two bridges firing the same schedule. The caller
     * gates its tick on being the everyday instance, which is what actually
     * prevents this — but that is one `if`, and the cost of it being wrong is a
     * duplicated unattended agent run. So: re-read the file, check the slot is
     * still unclaimed, write it back, and flush *synchronously* before returning
     * true. Whichever process completes the rename first wins, and the loser
     * sees the winner's slot on its own re-read.
     *
     * Not airtight — two processes can interleave between the read and the
     * rename — but the window is sub-millisecond against a tick that fires twice
     * a minute, and the alternative is a lock file with a stale-lock problem of
     * its own. The everyday-instance gate is the real answer; this is the net.
     *
     * @returns {boolean} true if this process may now fire that slot.
     */
    claim(id, slotAt) {
        const fresh = read().find(r => r.id === id);
        if (fresh && fresh.lastSlotAt != null && fresh.lastSlotAt >= slotAt) return false;

        const row = this.rows.find(r => r.id === id);
        if (!row) return false;
        row.lastSlotAt = slotAt;
        row.updatedAt = this._stamp();
        this._sort();
        this.flush();
        return true;
    }

    /**
     * Record what a slot did.
     *
     * One method for every outcome rather than `fired()`/`skipped()`/`failed()`,
     * because they write the same four fields and the interesting part is which
     * ones are left alone. In particular: **`marker` is only stored when it is
     * passed**, so a failed spawn or a refused gate cannot advance the commit
     * range. That is the rule that keeps a bad night from eating a review.
     */
    note(id, { sessionId, marker, outcome, skipReason, error, slotAt } = {}) {
        const row = this.rows.find(r => r.id === id);
        if (!row) return null;

        if (slotAt != null) row.lastSlotAt = slotAt;
        if (sessionId) {
            row.lastSessionId = sessionId;
            row.lastFiredAt = Date.now();
            row.runs += 1;
            // A run supersedes whatever the previous slot decided not to do.
            row.lastSkipReason = null;
            row.lastOutcome = null;
        }
        if (marker) row.lastMarker = marker;
        if (outcome !== undefined) row.lastOutcome = orNull(outcome);
        if (skipReason !== undefined) row.lastSkipReason = orNull(skipReason);
        if (error !== undefined) row.lastError = orNull(error);

        row.updatedAt = this._stamp();
        this._sort();
        this.save();
        return clean(row);
    }

    remove(id) {
        const at = this.rows.findIndex(r => r.id === id);
        if (at < 0) return false;
        this.rows.splice(at, 1);
        // Remembered until the write goes out. `flush()` starts from the file,
        // so without this the row we just dropped would be read straight back in.
        this._removed.add(id);
        this.save();
        return true;
    }
}

module.exports = {
    Schedules,
    STATE_FILE,
    MAX_SCHEDULES,
    CATCHUP_MS,
    SKIP_REASONS,
    parseCron,
    matches,
    nextSlot,
    dueSlot,
    describeCron,
    fillPrompt,
    verdictOf,
};
