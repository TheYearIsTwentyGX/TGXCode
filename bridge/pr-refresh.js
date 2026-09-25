'use strict';

// The clock that keeps pull request status fresh — the only thing in the bridge
// that asks gh about a pull request on a timer, and the reason no route has to.
//
// The store is bridge/pr-store.js, which decides *when* a repository is worth
// asking about and keeps the last answer; this is the half that walks the index
// to find which repositories are in play, runs a pass, and tells every window
// when the answer moved. It was a section of server.js; the interval that drives
// it is still started there, in the listen callback, where it always was.
//
// `init` takes the index and the runner pool because server.js builds them and
// requiring server.js back would be a cycle.

const cfg = require('./config');
const pulls = require('./pulls');
const prStore = require('./pr-store');
const { mapLimit } = require('./memo');
const { broadcast } = require('./events');

// Handed over by server.js; see the header.
let index = null;
let pool = null;

function init(deps) {
    ({ index, pool } = deps);
}

// ---------------------------------------------------------------------------
// Keeping pull request status fresh
// ---------------------------------------------------------------------------
//
// The only thing in this process that calls gh about a pull request on a clock.
// Every route that shows PR status reads `pr-store.js`, which reads memory; this
// is what puts anything in it.
//
// It replaced three client polls at sixty seconds each — the conversation header,
// the rail and the board, none of them aware of the others — and the minute of
// server-side cache that existed to stop them tripling the cost. What the store
// decides, and why twenty minutes is the idle floor, is in that file's header.
//
// One pass at a time, for `tickSchedules`' reason rather than its own: the pass is
// `await`-heavy and the interval is short enough that two overlapping is ordinary.
// Nothing here is unsafe to run twice — the worst case is two identical `gh pr
// list` calls — but the second pass would see the first's half-written `seen`
// marks and conclude the conversations had not moved.
//
// The promise is kept rather than a boolean, because unlike the schedule tick this
// one has a caller who is *waiting*: pressing Refresh on the board while the timer
// happens to be mid-pass would otherwise return before anything was asked, and the
// press would look like it did nothing.
/** @type {Promise<{changed: boolean}>|null} */
let prPass = null;

/**
 * One pass of the PR refresher.
 *
 * @param {{force?: boolean}} opts `force` lists every repository in play
 *   regardless of when it was last asked — the board's Refresh button, and the
 *   moment after a scheduled review posts a label it wants to read back.
 */
function tickPrs({ force = false } = {}) {
    // A forced press waits for the pass in front of it and then runs its own:
    // the running one may have started before whatever the user is trying to see.
    if (prPass) return force ? prPass.then(() => tickPrs({ force })) : prPass;
    prPass = runPrPass(force).finally(() => { prPass = null; });
    return prPass;
}

async function runPrPass(force) {
    // The whole index, as the board uses: a repository is in play because a
    // project on this machine has that remote, not only because a recent session
    // linked a PR in it. Test sessions on a dev bridge for the same reason the
    // rail shows them — a probe session's PR is still a PR somebody wants coloured.
    const sessions = index.list({ limit: 100_000, includeTest: cfg.IS_DEV });
    const running = new Set(Object.entries(pool.statuses())
        .filter(([, st]) => st && st.state === 'busy')
        .map(([id]) => id));

    // The remote of every project root, which is what the board matches branches
    // against. Without these, a project whose PRs no transcript happens to name
    // would have its repository pruned out of the store and its rows would lose
    // every pull request they had. `repoOf` is memoised for ten minutes, so this
    // is one `git remote` per project on the first pass and free after that.
    const roots = [...new Set(sessions.map(s => s.projectCwd || s.cwd).filter(Boolean))];
    const extraRepos = (await mapLimit(roots, 8, (dir) => pulls.repoOf(dir)))
        .filter(Boolean);

    const result = await prStore.tick({ sessions, running, extraRepos, force });

    // Only when something actually moved. The store compares the answer it got
    // against the one it had, so a pass that re-lists a quiet repository and finds
    // it unchanged tells nobody — otherwise this would be a heartbeat with a
    // payload, waking every open window every thirty seconds.
    if (result.changed) broadcast('prs-changed', await prsPayload(sessions));
    return result;
}

/**
 * What the rail should look like: one aggregate status per session.
 *
 * The body of `GET /api/prs`, and the payload of the `prs-changed` event, because
 * they are the same answer to the same question — small enough to push whole
 * rather than making every window come back and ask.
 *
 * The conversation header is deliberately *not* in here. It wants per-PR detail
 * for one session, which would mean either sending every session's detail to every
 * window or knowing which session each window has open; the client refetches the
 * one session it is showing instead, off the same event.
 *
 * `reposFor` is what fills in a `pr-link` line that never named its repository —
 * one `git remote` per directory, memoised for ten minutes in `pulls.repoOf`, so
 * this is free after the first pass.
 */
async function prsPayload(sessions = null) {
    const list = (sessions || index.list({ limit: 500, includeTest: cfg.IS_DEV }))
        .filter(s => s.prs && s.prs.length);
    const { repoOfDir } = await prStore.reposFor(list);
    return prStore.forSessions(list.map(s => ({
        sessionId: s.sessionId,
        prs: s.prs,
        repo: repoOfDir.get(s.cwd) || null,
    })));
}

module.exports = { init, tickPrs, prsPayload };
