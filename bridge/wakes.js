'use strict';

// Wake-ups: a session coming back by itself at a time, to the same conversation.
//
// Two ways one is set, and one way it is delivered:
//
//   **`wake_me_up`** (bridge/mcp.js). A session asks to be resumed at a time with
//   a prompt of its own — "check the CI run in 45 minutes", "carry on after the
//   nightly build". `schedule_session` starts a *new* session, which has none of
//   this one's context; until this, nothing could bring the same one back.
//
//   **After the usage limit.** A turn that ends because the account hit its limit
//   (`lastResult.usageLimit`, bridge/runner.js) gets a wake for a minute after the
//   window resets, saying so. Orchestrators already did this for themselves
//   (`paused.resumeAt` in bridge/orchestration.js); an ordinary session just
//   stopped, and stayed stopped until somebody noticed. Gated by
//   `quota.resumeAfterLimit` (default on).
//
// **Each is a row in the scheduled-message store** (bridge/later.js), with
// `kind: 'wake'` or `'limit'`, not a store of its own. A wake-up *is* a message
// delivered to an existing session at a time, which is that store's whole job,
// and everything it already gets right is what this needed: persisted and merged
// across bridges, claimed on disk before the send so it is never delivered twice,
// delivered by the bridge that owns the session (`test`), queued behind a turn
// that is running, shown as a chip with a cancel. bridge/later-delivery.js is
// where the kinds differ, and only in four places:
//
//   * **Never "missed".** A message has LATE_MS because an instruction can stop
//     being true; "carry on" does not, and a limit wake that came late because the
//     bridge was down is exactly the one that must still go.
//   * **The session's own settings, not the row's.** With a process up the wake
//     goes to it as it is ("as you were"), so it is queued behind a running turn
//     instead of waiting for a mode to match, and never retires a process. Closed,
//     it resumes in what the session was running when the wake was set.
//   * **The text says what it is.** A self wake arrives as "TGXCode wake-up you
//     set …" above the prompt, so the model knows why it is talking.
//   * **Dropped rather than kept once sent** — the transcript is the record.
//
// **One self wake per session at a time is too few and twenty is a loop.**
// MAX_SELF_WAKES is three, separate from the store's twenty: enough for "check at
// 3, again at 5", and small enough that a session waking itself to set another
// wake cannot fill the file.
//
// **An orchestrator's own resume wins.** A limit wake is not set — and one already
// set is dropped at fire time — for an orchestrator, or a worker of one, whose
// orchestrator is paused or has its usage cutoff on with auto-resume: that flow
// wakes the orchestrator and tells it which workers were cut off, and a second
// "carry on" from here would be the double wake it exists to avoid.

const { MAX_AHEAD_MS } = require('./later');

const MAX_SELF_WAKES = 3;

/** How long after the window resets a limit wake fires; the orchestrators' grace. */
let limitGraceMs = 60_000;

/** Shortest wait `wake_me_up` takes. Anything sooner is a sleep, not a wake-up. */
const MIN_WAIT_MS = 60_000;

const LIMIT_TEXT = 'The usage limit reset; carry on where you left off.';

// Handed over by server.js.
let later = null;
let pool = null;
let index = null;
let orchestrators = null;
let prefs = null;
let usage = null;
let sessionCwd = null;
let changed = () => {};

function init(deps) {
    ({ later, pool, index, orchestrators, prefs, usage, sessionCwd } = deps);
    changed = deps.changed || (() => {});
    if (Number.isFinite(deps.limitGraceMs)) limitGraceMs = deps.limitGraceMs;
}

const isWake = (row) => !!row && (row.kind === 'wake' || row.kind === 'limit');

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * "45m", "2h", "1h30m", "90s", "1.5h", "2 days" — epoch ms from `now`, or null.
 * A bare number is minutes, which is what anybody means by "in 30".
 */
function parseIn(text, now = Date.now()) {
    const s = String(text || '').trim().toLowerCase();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return now + Number(s) * UNIT_MS.m;
    const re = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])/g;
    let total = 0;
    let used = '';
    let m;
    while ((m = re.exec(s))) {
        total += Number(m[1]) * UNIT_MS[m[2][0]];
        used += m[0];
    }
    // Every character accounted for (bar spaces and "and"), so "in 3 fortnights"
    // is refused instead of read as whatever part of it parsed.
    if (!total || s.replace(/\band\b|[\s,]/g, '') !== used.replace(/\s/g, '')) return null;
    return now + total;
}

/**
 * A local date and time as epoch ms. A full date-time is `Date`'s local form;
 * "17:30" or "5:30pm" alone is the next time the clock reads that — today, or
 * tomorrow if it has passed. A date with no time is refused, for cronForDate's
 * reason: `Date` reads it as midnight UTC, which is nobody's intent.
 */
function parseAt(text, now = Date.now()) {
    const s = String(text || '').trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
    if (clock && (clock[2] || clock[3])) {
        let h = Number(clock[1]);
        const min = Number(clock[2] || 0);
        const ap = clock[3] && clock[3].toLowerCase();
        if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'pm' ? 12 : 0); }
        if (h > 23 || min > 59) return null;
        const d = new Date(now);
        d.setHours(h, min, 0, 0);
        if (d.getTime() <= now) d.setDate(d.getDate() + 1);
        return d.getTime();
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * `{at}` or `{error}` from what a caller gave: `at` or `in`, exactly one.
 */
function resolveWhen({ at, in: inText } = {}, now = Date.now()) {
    const hasAt = at !== undefined && at !== null && String(at).trim() !== '';
    const hasIn = inText !== undefined && inText !== null && String(inText).trim() !== '';
    if (hasAt === hasIn) return { error: 'give at (a local date and time) or in (a duration like "45m"), not both' };
    const when = hasAt
        ? (typeof at === 'number' ? at : parseAt(at, now))
        : parseIn(inText, now);
    if (when === null || !Number.isFinite(when)) {
        return {
            error: hasAt
                ? `cannot read "${at}" as a time; use e.g. 2026-09-25T09:00 or 17:30`
                : `cannot read "${inText}" as a duration; use e.g. 45m, 2h or 1h30m`,
        };
    }
    if (when - now < MIN_WAIT_MS - 1000) return { error: 'that is less than a minute away — pick a later time' };
    if (when - now > MAX_AHEAD_MS) return { error: 'that is more than 30 days away' };
    return { at: when };
}

// ---------------------------------------------------------------------------
// Setting one
// ---------------------------------------------------------------------------

/**
 * What the session runs in now, for a wake that has to resume it closed: the
 * live process's settings, or the mode the session was last seen in.
 */
function settingsOf(sessionId, summary) {
    const st = pool.statuses()[sessionId] || null;
    return {
        permissionMode: (st && st.permissionMode) || (summary && summary.permissionMode) || 'auto',
        model: (st && st.model) || null,
        effort: (st && st.effort) || null,
    };
}

/**
 * A session's own wake-up. `{wake}` or `{error, status}`.
 */
function setWake(sessionId, { at, in: inText, prompt, reason } = {}) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (!text) return { error: 'prompt is required — the message the session is woken with', status: 400 };
    if (text.length > 20_000) return { error: 'prompt is longer than 20000 characters', status: 400 };
    const when = resolveWhen({ at, in: inText });
    if (when.error) return { error: when.error, status: 400 };
    const summary = index.summary(sessionId);
    if (!summary) return { error: 'session not found', status: 404 };
    if (later.pendingWakes(sessionId, ['wake']).length >= MAX_SELF_WAKES) {
        return {
            error: `this session already has ${MAX_SELF_WAKES} wake-ups waiting — cancel one first`,
            status: 409,
        };
    }
    const row = later.create({
        ...settingsOf(sessionId, summary),
        sessionId,
        cwd: sessionCwd(summary),
        text,
        at: when.at,
        test: !!summary.test,
        kind: 'wake',
        reason: typeof reason === 'string' ? reason.trim().slice(0, 300) : null,
    });
    if (!row) return { error: 'that session has too many scheduled messages waiting', status: 409 };
    changed();
    return { wake: row };
}

/** A session's pending wake-ups, both kinds, soonest first. */
function listWakes(sessionId) {
    return later.pendingWakes(sessionId);
}

/**
 * Cancel one of this session's wake-ups by id, or all of them. Only its own:
 * the id is checked against the session, so one session cannot cancel
 * another's. Returns how many went.
 */
function cancelWakes(sessionId, id = null) {
    let n = 0;
    for (const w of later.pendingWakes(sessionId)) {
        if (id && w.id !== id) continue;
        if (later.remove(w.id)) n++;
    }
    if (n) changed();
    return n;
}

// ---------------------------------------------------------------------------
// After the usage limit
// ---------------------------------------------------------------------------

function limitPrefOn() {
    try {
        const q = prefs.forCwd().quota || {};
        return q.resumeAfterLimit !== false;
    } catch { return true; }
}

/**
 * Is resuming this session after a limit an orchestrator's job? The orchestrator
 * itself or a worker of one, when that orchestrator is paused or will resume
 * itself after the window resets. See the header.
 */
function handledByOrchestrator(sessionId) {
    if (!orchestrators) return false;
    const o = orchestrators.get(sessionId) || orchestrators.orchestratorOf(sessionId);
    if (!o) return false;
    const u = o.settings && o.settings.usageStop;
    return !!o.paused || !!(u && u.enabled && u.autoResume);
}

/**
 * When the window that stopped it resets, in epoch ms: the turn's own
 * `rate_limit_event`, else the latest reset among the windows bridge/usage.js
 * has seen refused. Null when nobody knows.
 */
function limitResetsAt(usageLimit, now = Date.now()) {
    if (usageLimit && Number.isFinite(usageLimit.resetsAt) && usageLimit.resetsAt > now) {
        return usageLimit.resetsAt;
    }
    let ws = [];
    try { ws = (usage && usage.snapshot().windows) || []; } catch { /* none */ }
    const ms = (w) => (Number.isFinite(w.resetsAt) ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : null);
    const refused = ws.filter(w => w.status === 'rejected' && ms(w) && ms(w) > now);
    return refused.length ? Math.max(...refused.map(ms)) : null;
}

/**
 * A turn ended. On the limit, set (or move) the session's one limit wake; on
 * anything that got through, the limit is no longer what stopped it, so any limit
 * wake still waiting is stale and goes.
 *
 * @returns {object|null} the wake set, for the tests.
 */
function onTurnComplete(r) {
    if (!r || !r.sessionId) return null;
    if (!r.usageLimit) {
        if (!r.isError) {
            let n = 0;
            for (const w of later.pendingWakes(r.sessionId, ['limit'])) if (later.remove(w.id)) n++;
            if (n) changed();
        }
        return null;
    }
    if (!limitPrefOn() || handledByOrchestrator(r.sessionId)) return null;
    const resetsAt = limitResetsAt(r.usageLimit);
    if (resetsAt === null) return null;
    const summary = index.summary(r.sessionId);
    if (!summary) return null;
    // One per session: a second limit hit before the first wake moves it.
    for (const w of later.pendingWakes(r.sessionId, ['limit'])) later.remove(w.id);
    const row = later.create({
        ...settingsOf(r.sessionId, summary),
        sessionId: r.sessionId,
        cwd: sessionCwd(summary),
        text: LIMIT_TEXT,
        at: resetsAt + limitGraceMs,
        test: !!summary.test,
        kind: 'limit',
        reason: r.usageLimit.window ? `${r.usageLimit.window.replace(/_/g, '-')} usage limit` : 'usage limit',
    });
    changed();
    return row;
}

// ---------------------------------------------------------------------------
// Delivering one — called from bridge/later-delivery.js
// ---------------------------------------------------------------------------

/**
 * Why this wake should not go after all, or null. Read at fire time, so a pref
 * turned off or an orchestrator paused since it was set is honoured.
 */
function dropReason(row) {
    if (!row || row.kind !== 'limit') return null;
    if (!limitPrefOn()) return 'resuming after the usage limit is turned off in Settings';
    if (handledByOrchestrator(row.sessionId)) return 'its orchestrator resumes it';
    return null;
}

/** "3:05 PM" */
function clock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** What the session reads when the wake arrives. */
function deliveredText(row) {
    if (!row || row.kind !== 'wake') return String((row && row.text) || '');
    const head = `(TGXCode wake-up you set at ${clock(row.createdAt)}, for ${clock(row.at)}`
        + `${row.reason ? ` — ${row.reason}` : ''})`;
    return `${head}\n\n${row.text}`;
}

module.exports = {
    init, isWake, setWake, listWakes, cancelWakes, onTurnComplete, dropReason, deliveredText,
    handledByOrchestrator, limitResetsAt, resolveWhen, parseIn, parseAt,
    MAX_SELF_WAKES, LIMIT_TEXT,
};
