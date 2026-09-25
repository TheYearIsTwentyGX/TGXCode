'use strict';

// Delivering a scheduled message: the tick, the one delivery path the tick and
// `POST /api/later/:id/send` share, and the boot pass that owns up to a
// delivery the last bridge left half done.
//
// bridge/later.js is the store and is deliberately inert; this is the half that
// sends. It was the "Messages on a clock" section of server.js, and its own
// header comment — below, unchanged — is the reasoning worth keeping with it:
// delivery is the send route's sequence rather than a second one, and nobody is
// watching when it runs.
//
// **Why `init`.** Delivery needs the runner pool, the index and the
// notification log, which server.js builds, and three helpers the send route
// uses — `normalizeMode`, `sessionCwd`, `resolveAttachments` — which are the
// router's. Passing them is what keeps "the clock delivers what the button
// delivers" true by construction: it is literally the same functions. Requiring
// server.js back for them would be a cycle.
//
// **No timers here.** The catch-up pass and the interval are started from
// server.js's listen callback, on the schedule tick's clock, as before.

const cfg = require('./config');
const { LATE_MS } = require('./later');
const { stateOf: handoffState, wakes, wakeFailure } = require('./handoff');
const { broadcast } = require('./events');

// Handed over by server.js; see the header.
let later = null;
let index = null;
let pool = null;
let notifications = null;
let filed = null;
let laterPayload = null;
let normalizeMode = null;
let sessionCwd = null;
let resolveAttachments = null;

function init(deps) {
    ({
        later, index, pool, notifications, filed, laterPayload,
        normalizeMode, sessionCwd, resolveAttachments,
    } = deps);
}

// ---------------------------------------------------------------------------
// Messages on a clock
// ---------------------------------------------------------------------------
//
// A scheduled message is the body `POST /api/sessions/:id/send` takes, held back
// until a timestamp — see bridge/later.js for the store and why it is its own
// file. This is the half that delivers one.
//
// **The delivery is the send route's own sequence, not a second one.** That is
// the rule `POST /api/schedules/:id/run` established for "Run now" and the reason
// is the same: "the clock delivers what the button delivers" should be true
// because there is one path, not because two were kept in step. `deliverLater` is
// what both the tick and `POST /api/later/:id/send` call.
//
// The thing this has to get right that `/send` does not is that **nobody is
// watching**. Three consequences, all of them load-bearing:
//
//   * A permission ask raised with no SSE client attached is auto-denied on the
//     spot, and two of those stop the turn (see `hasViewer` in bridge/runner.js).
//     So the mode a message is delivered in is the difference between it working
//     and it quietly giving up at 02:00. It is stored per message and never
//     defaulted here; the composer offers `bypassPermissions` because that is the
//     only mode that reliably runs unattended, and web/app.js makes the same
//     argument for a scheduled *session* one dialog over.
//   * A message that cannot be delivered has nobody to be handed back to, which
//     is the problem `wakeFailure` was written for in bridge/handoff.js. It is
//     reused here rather than reimplemented.
//   * Being late is a reason not to deliver at all. LATE_MS, not CATCHUP_MS —
//     bridge/later.js says why.

/** At most this many go out per tick, so a backlog drains rather than bursts. */
const LATER_PER_TICK = 4;

/**
 * File a notification about a scheduled message, unless it is a test one.
 *
 * `fileScheduleNote`'s guard, for a narrower version of its reason. There the log's
 * own `flags`-based filter could not help because a failing schedule often has no
 * session at all; here there is always a session, and it is the *right* session —
 * so the filter would work. The guard is kept anyway because it is the same fact
 * stated once instead of twice, and because a dev bridge's throwaway probe failing
 * every two minutes has no business in the user's notification list.
 *
 * No `title`: `notifications.record` derives it from `sessionId` along with the
 * project and the directory, so passing our own would be one field out of three
 * coming from somewhere else.
 */
function fileLaterNote(row, entry) {
    if (row.test) return;
    filed(notifications.record({ ...entry, sessionId: row.sessionId }));
}

/**
 * Deliver one scheduled message, or say why not.
 *
 * The caller has already claimed the row, so every exit here has to be one the
 * caller can record — there is no path that leaves the message in limbo.
 *
 * `retry: true` is the one non-fatal refusal: it means nothing was attempted and
 * the row should go back to `pending` for a later tick. It is deliberately narrow.
 * Anything after `r.send` has reached the process and can never be retried,
 * because `claude` writes its user entry at submission — re-sending would re-run
 * work the transcript already shows.
 *
 * @returns {Promise<{ok: boolean, retry?: boolean, error?: string, status?: object,
 *   queued?: boolean, cwd?: string, woke?: boolean}>}
 */
async function deliverLater(row) {
    const summary = index.summary(row.sessionId);
    if (!summary) {
        return { ok: false, error: 'that session no longer exists' };
    }

    // Normalised on the way out as well as on the way in, for the reason
    // `POST /api/drafts/:id/start` gives: the row was written through a route that
    // checked it, but this file is hand-editable and outlives the process that
    // wrote it, so the value reaching `--permission-mode` is not taken on trust
    // from JSON on disk. The *remote* refusal is not repeated — it was applied
    // when the message was written, and a tick has no caller to refuse.
    const mode = normalizeMode(row.permissionMode);
    const model = row.model || null;

    const st = pool.statuses()[row.sessionId] || null;

    // Held by a terminal, VS Code or a background agent: two writers cannot append
    // to one transcript. Worth retrying rather than failing, which is the one place
    // this differs from the handoff route's 409 — that route has a caller waiting
    // for an answer, and this one has until the window closes. A terminal closed a
    // minute from now should not cost the message.
    if (handoffState(summary, st) === 'elsewhere') {
        return {
            ok: false, retry: true,
            error: 'that session is running somewhere else',
        };
    }

    // The self-inflicted failure this exists to prevent. `pool.ensure` with a
    // changed model or mode *retires the process and respawns it* — the queue
    // carries across but the turn in flight does not. Killing a 2am turn to deliver
    // a message meant to help it is the worst thing this feature could do, so a
    // message that would change the mode waits for the session to be idle. One that
    // would not is simply queued behind the turn, which is correct and needs no
    // special case.
    const busy = st && (st.state === 'busy' || st.state === 'starting');
    if (busy && (st.permissionMode !== mode || (st.model || null) !== model)) {
        return {
            ok: false, retry: true,
            error: `that session is mid-turn and this message would change its mode to `
                + `${mode}, which would end the turn — waiting for it to finish`,
        };
    }

    const cwd = sessionCwd(summary);
    let files;
    try {
        // Re-derived against this session's own attachments directory, exactly as
        // `/send` re-derives them. A file tidied away since the message was written
        // is dropped rather than failing the whole delivery.
        files = resolveAttachments(cwd, row.attachments);
    } catch (err) {
        return { ok: false, error: err.message };
    }

    // Read before ensure(), which is about to change the answer.
    const woke = wakes(st);

    let r;
    let entry;
    try {
        r = pool.ensure(row.sessionId, { cwd, model, permissionMode: mode });
        entry = r.send(String(row.text || ''), files);
    } catch (err) {
        return { ok: false, error: err.message };
    }

    // The send is what started the process, so wait briefly to see whether it
    // actually started — a session id still locked by a killed process refuses
    // one or two seconds in, and without this that is recorded as delivered.
    if (woke) {
        const failure = await wakeFailure(r);
        if (failure) {
            return {
                ok: false,
                error: `that session could not be resumed: ${failure.message}`,
            };
        }
    }

    const status = r.status();
    return {
        ok: true, status, cwd, woke,
        queued: status.queue.some(q => q.id === entry.id),
    };
}

// The same re-entrancy guard the schedule tick keeps, and for its reason: a
// delivery can wait five seconds on a wake, and two passes overlapping on one row
// would otherwise both get as far as the send.
let laterTicking = false;

function tickLater() {
    if (laterTicking) return Promise.resolve();
    laterTicking = true;
    return runLaterTick().finally(() => { laterTicking = false; });
}

/**
 * One pass over everything due.
 *
 * The order inside the loop is the bug docs/plans/15-scheduling.md records under
 * section C — an exception after the claim loses the run silently — so the claim
 * goes down before anything that can throw, and the catch turns a throw into a
 * recorded failure rather than a row nobody will ever look at again.
 */
async function runLaterTick() {
    // A message written on a dev bridge, or from a phone, reaches the bridge that
    // will deliver it only through the file. schedule.js's tick reloads first for
    // the same reason.
    later.reload();
    const now = Date.now();
    let changed = false;
    let budget = LATER_PER_TICK;

    for (const row of later.due(now)) {
        // The symmetric rule the schedule tick applies: a dev bridge takes only
        // test rows and the everyday one only the rest. Here the flag was copied
        // off the target session rather than chosen, so this says no more than
        // "the bridge that owns this session is the one that delivers to it".
        if (cfg.IS_DEV !== !!row.test) continue;

        // Past its window. Reported rather than sent — an instruction seven hours
        // late is the wrong instruction, and this one arrives carrying the
        // permission to act on itself.
        if (now - row.at > LATE_MS) {
            later.note(row.id, {
                state: 'missed',
                error: 'the bridge was not running when this was due, and it was too '
                    + 'late to deliver by the time it came back',
            });
            fileLaterNote(row, {
                type: 'later-missed',
                summary: 'a scheduled message was not delivered',
                detail: `The message due at ${new Date(row.at).toLocaleString()} was not `
                    + 'sent, because by the time the bridge could send it more than an '
                    + 'hour had passed. It is still on the session, marked missed, so '
                    + 'you can send it yourself.',
                loud: true,
            });
            changed = true;
            continue;
        }

        if (budget <= 0) break;
        if (!later.claim(row.id)) continue;
        budget--;
        changed = true;

        let out;
        try {
            out = await deliverLater(row);
        } catch (err) {
            out = { ok: false, error: err.message };
        }

        if (out.ok) {
            later.note(row.id, { state: 'sent', sentAt: Date.now() });
        } else if (out.retry) {
            // Nothing was attempted, so the claim can be given back. Only ever
            // reached before the send — see deliverLater.
            later.release(row.id);
        } else {
            later.note(row.id, { state: 'failed', error: out.error });
            fileLaterNote(row, {
                type: 'later-failed',
                summary: 'a scheduled message could not be delivered',
                detail: `${out.error}. The message is still on the session, marked `
                    + 'failed, so nothing you wrote has been lost.',
                loud: true,
            });
        }
    }

    if (changed) broadcast('later-changed', laterPayload());
}

/**
 * Messages this bridge left mid-delivery when it stopped.
 *
 * Runs once at boot, before the first tick, exactly as `recoverInterruptedReviews`
 * does. The store marks them failed and never retries them; this is the half that
 * says so out loud.
 */
function recoverInterruptedLater() {
    // Gated by the same symmetry the tick applies, and it has to be: every bridge
    // shares STATE_DIR, so an ungated pass would let a dev bridge coming up mark
    // the everyday bridge's in-flight message as failed while it is being
    // delivered perfectly well one process over.
    const stuck = later.recover(row => cfg.IS_DEV === !!row.test);
    if (!stuck.length) return;
    for (const row of stuck) {
        fileLaterNote(row, {
            type: 'later-failed',
            summary: 'a scheduled message was interrupted',
            detail: 'The bridge stopped while this message was being delivered. It was '
                + 'not sent again, because it may already have arrived — check the '
                + 'transcript, and send it yourself if it did not.',
            loud: true,
        });
    }
    console.log(`[tgxcode] ${stuck.length} interrupted scheduled message(s) marked`);
    broadcast('later-changed', laterPayload());
}

module.exports = { init, deliverLater, tickLater, recoverInterruptedLater };
