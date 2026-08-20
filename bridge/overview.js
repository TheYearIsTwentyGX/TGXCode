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

// A second, smaller ceiling, for the recent-activity group alone. Separate from
// MAX_CARDS on purpose: a day with thirty sessions behind it must not be able to
// push the ones that are actually running off the strip. It is a cost ceiling as
// well — every card is a tail read, and this is built once a second whether or
// not the window looking at it draws the group.
const MAX_RECENT = 12;

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
    // Everything the board has no reason for — the pool the recent group is
    // drawn from. Collected here rather than filtered again afterwards, which
    // also makes the two groups disjoint by construction: a session with a
    // reason never reaches this list, so nothing can appear twice.
    const idle = [];
    for (const s of summaries) {
        const runner = statuses[s.sessionId] || null;
        const reason = why(s, runner);
        if (!reason) { idle.push(s); continue; }
        cards.push(card(index, s, runner, reason));
    }

    cards.sort(order);
    const shown = cards.slice(0, MAX_CARDS);

    const since = recentSince();
    const warm = idle.filter(s => !s.archived && activityAt(s) >= since)
        .sort((a, b) => activityAt(b) - activityAt(a));
    const recent = warm.slice(0, MAX_RECENT).map(s => card(index, s, null, 'recent'));

    // Only the sessions actually on screen keep their caches alive — both
    // groups of them. Left at `shown` alone, every recent card's task progress
    // was thrown away and re-read on every pass.
    const ids = new Set([...shown, ...recent].map(c => c.sessionId));
    tasks.keepOnly(ids);
    keepOnly(devCache, ids);
    keepOnly(devLast, ids);
    keepOnly(devFold, ids);

    return {
        at: Date.now(),
        ready: index.ready,
        sessions: shown,
        // Beside `sessions` rather than mixed into it, so that every client which
        // already reads this payload keeps meaning what it meant: the phone's
        // "needs you" list is `sessions`, and it must not fill up with sessions
        // that are merely warm.
        recent,
        hidden: cards.length - shown.length,
        recentHidden: warm.length - recent.length,
        // What the button in the header counts.
        waiting: shown.filter(c => c.ask).length,
        running: shown.filter(c => c.reason === 'here' || c.reason === 'elsewhere').length,
    };
}

/**
 * How far back "recent activity" reaches, as ms since the epoch.
 *
 * A fixed rolling window is wrong at both ends of a day: eight hours back at 9am
 * is the middle of the night, and the sessions wanted then are yesterday
 * afternoon's. So the morning reaches back into the previous afternoon and the
 * afternoon does not — by lunchtime today is its own context. Monday reaches
 * across the weekend to Friday lunchtime, which is the same rule counted in
 * working days rather than calendar ones.
 *
 * Local time, deliberately: this is a question about the user's morning, not
 * about UTC. Going through setHours/setDate rather than arithmetic on the
 * timestamp is what carries it over a DST boundary — one of these "days" is 23
 * hours long twice a year.
 */
function recentSince(at = new Date()) {
    const noon = new Date(at);
    noon.setHours(12, 0, 0, 0);

    if (at.getTime() >= noon.getTime()) {
        const midnight = new Date(at);
        midnight.setHours(0, 0, 0, 0);
        return midnight.getTime();
    }

    const back = new Date(noon);
    back.setDate(back.getDate() - (at.getDay() === 1 ? 3 : 1));
    return back.getTime();
}

/**
 * When a session was last touched by anyone.
 *
 * `lastTs` rather than `lastUserTs`, which is what the rail sorts on: an agent
 * that worked until 2am on something asked for at 4pm is work from last night,
 * and the point of the group is to find it again. `mtimeMs` covers a transcript
 * too old to carry timestamps.
 */
function activityAt(s) {
    const ts = s.lastTs ? Date.parse(s.lastTs) : NaN;
    return Number.isNaN(ts) ? s.mtimeMs : ts;
}

/**
 * Whether a session belongs on the board, and why it is there.
 *
 * "Running now, plus pinned" — with anything blocked on an answer and anything
 * that just failed kept as well, because those are the two states where the
 * session has stopped and is waiting for a person.
 *
 * A session this says nothing about may still be recent; that is a separate
 * question, asked by `recentSince` over what is left, and answered in its own
 * array. Keeping it out of here is what stops an idle session from ever counting
 * as running.
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

    const c = {
        sessionId: s.sessionId,
        reason,
        title: s.title,
        projectName: s.projectName,
        cwd: s.cwd,
        worktree: s.worktree,
        pinned: s.pinned,
        test: s.test,
        model: s.model,
        // The mode a message sent from this card has to carry.
        //
        // `pool.ensure` compares the mode it is given against the mode the live
        // process is in, and replaces the process when they differ. The send
        // route defaults a missing one to `auto`, so a card that said nothing
        // would quietly restart every session running in acceptEdits or plan.
        // Same precedence the composer's own selector uses: the live process
        // first, then the mode the transcript was last seen in.
        permissionMode: (runner && runner.permissionMode) || s.permissionMode || null,
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

    c.sig = fingerprint(c);
    return c;
}

/**
 * A card's contents, as one short string.
 *
 * The board is pushed once a second and almost every card in it is identical to
 * the one before — an agent working moves one card's activity line and leaves
 * the other thirty-five alone. Without this the client has no way to know that,
 * so it tears down and rebuilds every card on every push. This is what lets it
 * keep the nodes it already has; see `renderLive` in web/app.js.
 *
 * Nothing here needs the exclusion `signature` makes for `at`. Every field on a
 * card is a fact that stays put until something happens — timestamps out of the
 * transcript, a fixed `busySince` the UI counts up from itself — so a card only
 * differs when the session did something. `busySince` in particular has to stay
 * in: a queued message starting a second turn moves it without the runner state
 * ever leaving `busy`, and a card that ignored that would count the new turn
 * from the old turn's start.
 *
 * FNV-1a rather than a crypto hash: this runs 36 times a second forever, the
 * strings are a kilobyte or two, and nothing here is adversarial — a collision
 * costs one stale card until the next thing that session does.
 */
function fingerprint(card) {
    const json = JSON.stringify(card);
    let h = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) {
        h ^= json.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

/**
 * The port fold per session: where in its transcript we have read to, and what
 * had been found by then. See `foldPorts`.
 * @type {Map<string, {offset: number, found: Map<number, object>}>}
 */
const devFold = new Map();

/**
 * How far back before the last offset each pass re-reads.
 *
 * A tool call and its result are consecutive lines, but an append can land
 * between them — `buildEvents` says so itself, "this happens on every live
 * tail" — and a result read on its own is a patch with no command attached, so
 * a server banner in it would be attributed to nothing. Overlapping the window
 * puts the pair back together. `detect` folds monotonically, so re-reading the
 * same lines cannot change the answer; the only cost is the bytes.
 */
const FOLD_LOOKBACK = 64 * 1024;

/**
 * Every port this session has mentioned, folded from wherever we left off.
 *
 * The first pass reads the transcript whole, because a server started an hour
 * ago and still listening is only visible in the part that has already been
 * written. Every pass after that reads the bytes appended since — which while
 * an agent works is a few kilobytes, against tens of megabytes for the file.
 *
 * That difference is the whole point. This used to call `index.read` on every
 * session on the board every fifteen seconds, and `index.read` is a synchronous
 * read-and-parse of the entire transcript: measured at ~200ms and ~150MB of
 * garbage for one 48MB session on this machine, with the board's own pinned
 * card guaranteeing that session was in the list whether or not it was running.
 * Each of those was one uninterruptible block on the bridge's only thread, so
 * every turn, every tail and every request waited behind it.
 *
 * A transcript that shrank has been replaced; `readSince` reports that, and the
 * fold starts again rather than carrying ports from a file that no longer says
 * so.
 */
function foldPorts(index, sessionId) {
    const prev = devFold.get(sessionId);
    if (prev) {
        const from = Math.max(0, prev.offset - FOLD_LOOKBACK);
        const delta = index.readSince(sessionId, from);
        if (delta && !delta.reset) {
            const found = devservers.detect(delta.events, prev.found);
            devFold.set(sessionId, { offset: delta.offset, found });
            return found;
        }
        if (!delta) return null;
    }

    const data = index.read(sessionId);
    if (!data) return null;
    const found = devservers.detect(data.events);
    devFold.set(sessionId, { offset: data.offset, found });
    return found;
}

/**
 * Refresh the dev-server chips, on its own slow cycle.
 *
 * Separate from `build` and deliberately not awaited by it: this probes ports
 * and asks DevBrowser for its tab names, which is far too much to do at the rate
 * the board redraws. Call it on a timer; `build` picks up whatever it last left.
 *
 * One session at a time, with the loop given a chance to breathe between them —
 * still worth doing now that `foldPorts` reads only the appended bytes, because
 * the first pass over a session is a whole transcript and the port probes and
 * DevBrowser round trip are still real IO.
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
                const ports = foldPorts(index, sessionId);
                const summary = ports && index.summary(sessionId);
                if (!summary) return null;
                const found = await devservers.enrich(
                    [...ports.values()], titles, {
                        worktreeName: summary.worktree && summary.worktree.name,
                        projectName: summary.projectName,
                        lastTs: summary.lastTs,
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

module.exports = { build, refreshDevServers, recentSince, activityAt, DEVSERVER_TTL_MS };
