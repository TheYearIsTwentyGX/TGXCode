'use strict';

// Everything the live board draws, for every session at once.
//
// The app is built around one open conversation — /api/subscribe deliberately
// drops every follow but the current one, so that nobody is polling transcripts
// nobody is looking at. That is the right default and this does not change it.
// What the board needs is not the content of N transcripts, it is *state* about
// them, and state is much smaller: a line of activity, a task count, the last
// few headlines. One payload, one timer, no watcher per session.
//
// Where each piece comes from, and what it costs:
//
//   * the runner pool         — free, already in memory, for sessions we started
//   * the registry            — free, already in memory, for everything else
//   * the index summary       — free, already parsed
//   * headlines               — one bounded tail read per session (~0.5ms even
//                               on a 40MB transcript); see recentActivity
//   * task progress           — a handful of small files, cached ~3s
//   * dev servers             — port probes and a DevBrowser round trip, so
//                               strictly on its own slow cycle behind a cache
//
// The expensive one is last for a reason: at one build a second, folding dev
// servers into the same pass would mean probing ports sixty times a minute per
// session. It refreshes on its own ~15s cycle and every build in between reads
// whatever that last left behind.

const { recentActivity } = require('./transcript');
const { cached, keepOnly } = require('./memo');
const tasks = require('./tasks');
const devservers = require('./devservers');
const devbrowser = require('./devbrowser');

// How many headlines a card shows. Three is enough to see the shape of what an
// agent is doing without the card becoming a transcript.
const HEADLINES = 3;

// Dev servers cost real IO, and a port that came up ten seconds ago is not news.
const DEVSERVER_TTL_MS = 15_000;

// A ceiling on the board, so that a machine with fifty live sessions draws a
// screen rather than hanging. What falls off is reported rather than dropped
// quietly — a board that silently truncates reads as "this is everything".
const MAX_CARDS = 24;

/** @type {Map<string, {value?: any, pending?: Promise<any>, at: number}>} */
const devCache = new Map();
/**
 * The last good answer per session, held separately from the cache.
 *
 * `cached` replaces an entry's value with a pending promise while it refreshes,
 * so reading the cache directly made every chip disappear for the duration of
 * each pass and come back — a card that blinks its dev servers off every few
 * seconds looks like a server going up and down.
 * @type {Map<string, any>}
 */
const devLast = new Map();

/**
 * The board.
 *
 * @param {import('./sessions').SessionIndex} index
 * @param {import('./runner').RunnerPool} pool
 * @param {import('./registry').SessionRegistry} registry
 * @param {{includeTest?: boolean}} opts
 */
function build(index, pool, registry, { includeTest = false } = {}) {
    const statuses = pool.statuses();
    const summaries = index.list({ limit: 100_000, includeTest });

    const cards = [];
    for (const s of summaries) {
        const runner = statuses[s.sessionId] || null;
        const reason = why(s, runner);
        if (!reason) continue;
        cards.push(card(index, s, runner, reason));
    }

    cards.sort(order);
    const shown = cards.slice(0, MAX_CARDS);

    // Only the sessions actually on screen keep their caches alive.
    const ids = new Set(shown.map(c => c.sessionId));
    tasks.keepOnly(ids);
    keepOnly(devCache, ids);
    keepOnly(devLast, ids);

    return {
        at: Date.now(),
        ready: index.ready,
        sessions: shown,
        hidden: cards.length - shown.length,
        // What the button in the header counts.
        waiting: shown.filter(c => c.ask).length,
        running: shown.filter(c => c.reason === 'here' || c.reason === 'elsewhere').length,
    };
}

/**
 * Whether a session belongs on the board, and why it is there.
 *
 * "Running now, plus pinned" — with anything blocked on an answer and anything
 * that just failed kept as well, because those are the two states where the
 * session has stopped and is waiting for a person.
 */
function why(s, runner) {
    if (runner && runner.pendingPermission) return 'ask';
    if (runner && (runner.state === 'busy' || runner.state === 'starting')) return 'here';
    if (runner && runner.state === 'error') return 'error';
    // Messages waiting behind a turn that is no longer running are work that
    // will never go out on its own; worth a card rather than being hidden until
    // somebody opens the session.
    if (runner && runner.queued) return 'here';
    // "Elsewhere" is specifically *not us* — a terminal, VS Code, a background
    // agent. A process this bridge started is never that, however idle it is,
    // and calling it that told the user their own session was running in
    // another window.
    if (!runner && s.live && s.live.running) return 'elsewhere';
    if (s.pinned) return 'pinned';
    return null;
}

const RANK = { ask: 0, error: 1, here: 2, elsewhere: 3, pinned: 4 };

/**
 * Needs-you first. That ordering is the whole point of the view: the question it
 * answers is "who is blocked on me", and the answer has to be at the top rather
 * than somewhere in a grid.
 */
function order(a, b) {
    const r = RANK[a.reason] - RANK[b.reason];
    if (r) return r;
    // Within a band, whatever moved most recently.
    return (b.lastTs ? Date.parse(b.lastTs) : 0) - (a.lastTs ? Date.parse(a.lastTs) : 0);
}

function card(index, s, runner, reason) {
    const rec = index.get(s.sessionId);
    const file = rec ? rec.file : null;

    return {
        sessionId: s.sessionId,
        reason,
        title: s.title,
        projectName: s.projectName,
        cwd: s.cwd,
        worktree: s.worktree,
        pinned: s.pinned,
        test: s.test,
        model: s.model,
        lastTs: s.lastTs,
        lastUserTs: s.lastUserTs,
        toolCalls: s.toolCalls,
        userMessages: s.userMessages,

        // State about the turn, which is the one thing the runner is allowed to
        // be the source of. Trimmed to what a card draws: the queue's contents
        // and the last result's cost belong to the conversation view.
        runner: runner ? {
            state: runner.state,
            activity: runner.activity,
            queued: runner.queued,
            busySince: runner.busySince,
            retry: runner.retry,
            error: runner.error,
            errorKind: runner.errorKind,
        } : null,

        // Whether there is a process, and whose. `live` covers the sessions the
        // pool knows nothing about — anything running in a terminal.
        live: s.live,

        // What it is blocked on, if anything. The whole ask, because a tool ask
        // is answered from the card and needs its request id and its input.
        ask: (runner && runner.pendingPermission) || null,

        // Content, and therefore from the transcript — never from the runner's
        // stream. See the constraint in ROADMAP.md.
        headlines: file ? recentActivity(file, HEADLINES) : [],
        tasks: tasks.progress(s.sessionId, file),

        // Whatever the last dev-server pass left; null until the first one runs.
        devservers: devLast.get(s.sessionId) || null,
    };
}

/**
 * Refresh the dev-server chips, on its own slow cycle.
 *
 * Separate from `build` and deliberately not awaited by it: this probes ports
 * and asks DevBrowser for its tab names, which is far too much to do at the rate
 * the board redraws. Call it on a timer; `build` picks up whatever it last left.
 *
 * One session at a time, with the loop given a chance to breathe between them.
 * `index.read` is a synchronous read-and-parse of the whole transcript — tens of
 * megabytes for a long session — so firing all of them off together stalls
 * everything else the bridge is doing, including the turns it is running, for as
 * long as the slowest of them takes. Spread out, the same work is invisible.
 */
async function refreshDevServers(index, ids) {
    if (!ids.length) return false;

    let titles = {};
    try { titles = await devbrowser.titles(); } catch { /* not running; ports still probe */ }

    let moved = false;
    for (const sessionId of ids) {
        await breathe();
        const before = JSON.stringify(devLast.get(sessionId) || null);
        try {
            const next = await cached(devCache, sessionId, DEVSERVER_TTL_MS, async () => {
                const data = index.read(sessionId);
                if (!data) return null;
                const found = await devservers.enrich(
                    devservers.detect(data.events), titles, {
                        worktreeName: data.summary.worktree && data.summary.worktree.name,
                        projectName: data.summary.projectName,
                        lastTs: data.summary.lastTs,
                    });
                // Only the ports something is actually answering on. `enrich`
                // also returns a few recently-dead ones, which are useful
                // context in the conversation view and noise on a card.
                return found.ports.filter(d => d.listening)
                    .map(d => ({ port: d.port, title: d.title, owned: d.owned }));
            });
            devLast.set(sessionId, next || null);
            if (JSON.stringify(next || null) !== before) moved = true;
        } catch { /* a transcript that vanished mid-read; the next pass retries */ }
    }
    return moved;
}

/** Yield to the event loop, so a long pass is not one long block. */
const breathe = () => new Promise(resolve => setImmediate(resolve));

module.exports = { build, refreshDevServers, DEVSERVER_TTL_MS };
