'use strict';

// One view over everything outstanding: suggested tasks beside every
// un-archived session, grouped by what state it is in.
//
// The live board next door answers "what is running right now" and deliberately
// says nothing about anything else — `why()` in overview.js returns null for an
// idle session and it never gets a card. The rail answers "which conversation",
// one at a time. Neither answers "what is left", which is the question this one
// is for, and it is the question with three different half-homes today: the
// rail, the live board, and a tasks panel that could only see the conversation
// you happened to have open.
//
// **Everything here is derived.** Index summaries, the runner pool, the registry
// via `s.live`, and `index.listSuggestions()` — all of it already in memory, and
// none of it a new store of session state. The one thing this app owns about a
// task is whether you started it or waved it away, and that is suggestions.js's,
// not ours.
//
// **It reads no transcripts.** That is the difference from overview.build, and
// it is why this can carry a hundred cards where the live board caps at
// twenty-four: a headline costs a tail read per session, and a board this wide
// cannot afford one each. What is left is state, which is small. `tasks.progress`
// is the one exception and it is asked only about the sessions actually working
// — a handful of small files, cached ~3s in tasks.js — because "3 of 7" is worth
// a card saying and nothing else here costs IO at all.
//
// **The idle column is windowed, not capped.** There are several hundred
// un-archived sessions on a machine that has been used for a while, and a column
// of all of them is a scroll bar rather than an answer. So it leads with the
// same working-hours window the live board's recent group uses — `recentSince`,
// imported rather than reimplemented, so the two views cannot disagree about
// what "recent" means — and `?idle=all` pages the rest in behind a button. The
// count in the header is the total either way; a count describing only the
// visible slice would read as "this is everything".

const overview = require('./overview');
const tasks = require('./tasks');

/**
 * Which column a session belongs in, or null when it is off the board.
 *
 * The same predicates in the same order as `why()` in overview.js, so the two
 * boards cannot come to different conclusions about what "blocked" means. Two
 * deliberate differences:
 *
 *   * **archived is off the board entirely** — that is what archiving is for,
 *     and it is the only filter this view applies to a session at all;
 *   * **`pinned` is not a state.** On the live board a pin is a reason to draw a
 *     card for a session that has none of its own. Here every session gets a
 *     card, so a pinned idle session is simply idle — giving the flag a second
 *     meaning would only make it mean less.
 *
 * `error` joins `ask` under *needs you* rather than taking a column of its own:
 * both are a session that has stopped and is waiting for a person, which is
 * exactly what the column asks.
 */
function column(s, runner) {
    if (s.archived) return null;
    if (runner && runner.pendingPermission) return 'needs';
    if (runner && runner.state === 'error') return 'needs';
    if (runner && (runner.state === 'busy' || runner.state === 'starting')) return 'working';
    // Messages waiting behind a turn that is no longer running are work that
    // will never go out on its own — still working, from where you sit.
    if (runner && runner.queued) return 'working';
    // "Elsewhere" is specifically *not us* — a terminal, VS Code, a background
    // agent. A process this bridge started is never that, however idle it is.
    if (!runner && s.live && s.live.running) return 'working';
    return 'idle';
}

/**
 * The board.
 *
 * @param {import('./sessions').SessionIndex} index
 * @param {import('./runner').RunnerPool} pool
 * @param {{includeTest?: boolean, idle?: 'recent'|'all'}} opts
 */
function build(index, pool, { includeTest = false, idle = 'recent' } = {}) {
    const statuses = pool.statuses();
    const summaries = index.list({ limit: 100_000, includeTest });

    const needs = [];
    const working = [];
    const allIdle = [];
    for (const s of summaries) {
        const runner = statuses[s.sessionId] || null;
        const col = column(s, runner);
        if (col === 'needs') needs.push(card(s, runner, col));
        else if (col === 'working') working.push(card(s, runner, col));
        else if (col === 'idle') allIdle.push(s);
    }

    // Newest first within every column. The client takes this order once and
    // then holds it — the rail's rule, for the rail's reason — so this is the
    // order a card is *placed* in, not one it is re-sorted into every few
    // seconds under somebody's cursor.
    needs.sort(byActivity);
    working.sort(byActivity);
    allIdle.sort(byActivity);

    const since = overview.recentSince();
    const shownIdle = idle === 'all'
        ? allIdle
        : allIdle.filter(s => overview.activityAt(s) >= since);

    // No `tasks.keepOnly` here, deliberately. That cache has one owner —
    // overview.js, which trims it to the sessions on the live board every
    // second — and a second caller with a different idea of what to keep does
    // not share it, it fights over it: each pass would throw away the entries
    // the other just made, and both boards would re-read the task directories
    // far more often than the 3s TTL is asking for. This only ever asks about
    // sessions that are working, which is a handful, so what it leaves behind
    // is a few small objects that the live board sweeps up whenever it is on.

    // Open ones only. A task that was *started* became a session and is already
    // on the board as one; a *dismissed* one is the gesture for "not this".
    const suggested = index.listSuggestions({ status: 'open', includeTest });

    return {
        at: Date.now(),
        ready: index.ready,
        needs,
        working,
        suggested,
        idle: shownIdle.map(s => card(s, null, 'idle')),
        counts: {
            needs: needs.length,
            working: working.length,
            suggested: suggested.length,
            // The total, not what is shown. See the header comment.
            idle: allIdle.length,
        },
        idleHidden: allIdle.length - shownIdle.length,
    };
}

/** Newest first, on the same clock the live board's recent group uses. */
const byActivity = (a, b) => overview.activityAt(b) - overview.activityAt(a);

/**
 * A session as a card.
 *
 * A trimmed `overview.card`: no headlines and no dev-server chips, both of which
 * cost more than this view can spend. `ask` is kept whole even though the board
 * does not answer it — the card has to *say* what it is waiting on, and
 * `publicAsk` is where the kind and the tool's display name live.
 */
function card(s, runner, col) {
    return {
        sessionId: s.sessionId,
        column: col,
        title: s.title,
        projectName: s.projectName,
        projectCwd: s.projectCwd,
        cwd: s.cwd,
        worktree: s.worktree,
        pinned: s.pinned,
        test: s.test,
        model: s.model,
        lastTs: s.lastTs,
        lastUserTs: s.lastUserTs,
        userMessages: s.userMessages,

        // Whether there is a process, and whose. `live` covers the sessions the
        // pool knows nothing about — anything running in a terminal.
        live: s.live,
        runner: runner ? {
            state: runner.state,
            activity: runner.activity,
            queued: runner.queued,
            busySince: runner.busySince,
            error: runner.error,
            errorKind: runner.errorKind,
        } : null,
        ask: (runner && runner.pendingPermission) || null,

        // Only where it means something. An idle session's list is whatever it
        // was left at, which is not news, and asking would be a directory read
        // per card down a column that can be hundreds long.
        tasks: col === 'working' ? tasks.progress(s.sessionId) : null,
    };
}

module.exports = { build, column };
