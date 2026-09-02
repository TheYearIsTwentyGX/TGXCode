'use strict';

// When to ask GitHub about a pull request, and what the answer was last time.
//
// `pulls.js` knows *how* to ask and what an answer means. This file owns the
// other half: which repositories are worth asking about right now, and a copy of
// the last answer that survives a restart. Nothing here shells out on the path of
// a request — a route reads the snapshot and answers immediately, and a timer in
// `server.js` is the only thing that ever calls gh.
//
// That inversion is the whole change. Before it, three routes each asked
// `pulls.js`, which memoised one `gh pr list` per repository for a minute — so
// every repository in play was re-listed every sixty seconds forever, awake or
// idle, whether or not anything had happened. The 60s was never a judgement about
// pull requests; it was the shortest interval that kept three independent client
// polls from tripling the cost.
//
// **The unit of work is a repository, not a pull request.** One
// `gh pr list --state open` answers every open PR on a repo at once, so "refresh
// the PRs that changed" is not a question that can be asked — the question is
// which *repositories* are worth a call. Everything below decides that.
//
// Four triggers, in the order they matter:
//
//   * **Never asked.** A repository the store has not seen, which is boot and any
//     newly-linked PR.
//   * **The conversation moved.** A session's transcript mtime is past the moment
//     its repository was last listed. Someone is working here, so a PR may have
//     just been raised, pushed to, or merged. Floored at a minute so a busy
//     session cannot spawn a gh per tick. Both halves of that comparison are
//     wall-clock on this machine, which is what lets it be a comparison rather
//     than a bookkeeping map — see `tick`.
//   * **Checks are running.** The one state that changes on its own within
//     minutes and that somebody is actually waiting on. Two minutes, and only
//     while a check is genuinely in flight.
//   * **Staleness.** Twenty minutes, which is the floor that catches a review
//     landing on a repository nobody is talking about. This is the number the old
//     60s really becomes, and it is the honest trade: a PR can be twenty minutes
//     stale on a repository you are not working in.
//
// A failed call backs off — 1, 2, 5 minutes, then the idle floor — and, crucially,
// **keeps the pulls it last read successfully**. gh failing has to be
// distinguishable from a repository with nothing open; `pullsForSchedule` in
// server.js refuses to prune a schedule's reviewed set on a failed list precisely
// because those two used to look identical for a whole minute.
//
// The file is a cache and lives in CACHE_DIR, on the line bridge/config.js draws:
// losing it costs a rescan and loses no decision anybody made. Two bridges may
// both write it and the loser's copy is simply rebuilt, which is why this does
// none of bridge/schedule.js's merge-on-flush work — that file holds the user's
// decisions and this one holds GitHub's.
//
// What it persists that memory could not: **settled pull requests**. A merged or
// closed PR is final, so `pulls.js` already kept one forever — but only until the
// bridge exited, after which the first rail paint cost one `gh pr view` per
// settled PR across every session on the machine. That is the seconds-long cold
// start docs/api.md used to warn about, and writing them down is the end of it.

const fs = require('fs');
const path = require('path');

const { CACHE_DIR } = require('./config');
const { mapLimit, keepOnly } = require('./memo');
const pulls = require('./pulls');

const STORE_FILE = path.join(CACHE_DIR, 'prs.json');
const VERSION = 1;

// How often the refresher looks. Not how often it asks: a pass over a store where
// nothing is due makes no calls at all, which is the steady state.
const TICK_MS = 30_000;

// The floor under an activity-driven refresh. A session writing its transcript
// every few seconds must not become a gh per tick.
const ACTIVE_MS = 60_000;

// While a check is actually in flight. Short because somebody is watching it, and
// bounded because it stops the moment the check does.
const CHECKS_MS = 2 * 60_000;

// The staleness floor, and the cap on every backoff. Everything a conversation
// cannot see — a review landing, somebody else merging — is found within this.
const IDLE_MS = 20 * 60_000;

// After a failed list. Short at first because gh failing is usually a token or a
// network blip, then giving up on being clever.
const BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, IDLE_MS];

// Separate processes, not requests on one connection. The same figure pulls.js and
// dashboard.js use, for the same reason.
const GH_CONCURRENCY = 4;

// Resolving a repository from a checkout shells out to git. Cheap, but not free,
// and a machine with fifty sessions has a handful of directories.
const GIT_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

const state = {
    /** @type {Map<string, {checkedAt: number, ok: boolean, error: string|null, attempts: number, pulls: Array}>} */
    repos: new Map(),
    /** @type {Map<string, {at: number, pull: object}>} `owner/name#12` -> a settled PR */
    terminal: new Map(),
    loaded: false,
    saveTimer: null,
};

const key = (repo, number) => `${repo}#${number}`;

/**
 * Read the file, or start empty.
 *
 * A version this does not recognise is dropped whole rather than half-read: the
 * cost is one round of gh calls, and the alternative is a shape from another
 * release quietly answering questions about today's.
 */
function load() {
    if (state.loaded) return;
    state.loaded = true;
    try {
        const raw = fs.readFileSync(STORE_FILE, 'utf8').replace(/^﻿/, '');
        const data = JSON.parse(raw);
        if (!data || data.version !== VERSION) return;

        for (const [repo, e] of Object.entries(data.repos || {})) {
            if (!repo || !e || !Array.isArray(e.pulls)) continue;
            state.repos.set(repo, {
                checkedAt: Number(e.checkedAt) || 0,
                ok: !!e.ok,
                error: e.error ? String(e.error) : null,
                attempts: Number(e.attempts) || 0,
                pulls: e.pulls,
            });
        }
        for (const [k, e] of Object.entries(data.terminal || {})) {
            if (!k || !e || !e.pull) continue;
            state.terminal.set(k, { at: Number(e.at) || 0, pull: e.pull });
        }
    } catch (err) {
        // No file yet is the ordinary case and says nothing. Anything else is
        // worth one line, because a cache that cannot be read is a cache that is
        // being rebuilt on every boot.
        if (err.code !== 'ENOENT') {
            console.error(`[claude-sessions] ignoring unreadable ${STORE_FILE}: ${err.message}`);
        }
    }
}

const serialise = () => JSON.stringify({
    version: VERSION,
    repos: Object.fromEntries(state.repos),
    terminal: Object.fromEntries(state.terminal),
});

/** Write now rather than in 400ms. Also what the debounce eventually calls. */
function flush() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = STORE_FILE + '.tmp';
        fs.writeFileSync(tmp, serialise());
        fs.renameSync(tmp, STORE_FILE);
    } catch (err) {
        console.error(`[claude-sessions] could not save PR cache: ${err.message}`);
    }
}

/** Debounced atomic write, as bridge/slash-commands.js does. */
function save() {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(flush, 400);
    state.saveTimer.unref();
}

// ---------------------------------------------------------------------------
// When a repository is worth asking about
// ---------------------------------------------------------------------------

/**
 * Is a check actually in flight on this repository?
 *
 * Deliberately the raw count rather than `resolveStatus(pr) === 'checks-pending'`.
 * That status is what a PR shows *after* everything more urgent has had its turn,
 * so a draft with a build running reports `draft` — and it is still a build that
 * will finish in two minutes and change what this repository looks like.
 */
const checksRunning = (entry) => (entry.pulls || [])
    .some(p => p && p.checks && p.checks.pending > 0);

/**
 * How long to leave a repository alone, given its last answer.
 *
 * A failed call backs off regardless of activity: gh being down is not something
 * that typing fixes, and asking harder is how a rate limit becomes a ban.
 */
function interval(entry, active) {
    if (!entry.ok) {
        const n = Math.min(Math.max(entry.attempts, 1), BACKOFF_MS.length) - 1;
        return BACKOFF_MS[n];
    }
    if (active) return ACTIVE_MS;
    if (checksRunning(entry)) return CHECKS_MS;
    return IDLE_MS;
}

/**
 * When this repository next wants asking about, in epoch ms.
 *
 * 0 for one never asked about, which sorts it ahead of everything.
 */
function dueAt(repo, active = false) {
    const entry = state.repos.get(repo);
    if (!entry || !entry.checkedAt) return 0;
    return entry.checkedAt + interval(entry, active);
}

const isDue = (repo, active = false, now = Date.now()) => dueAt(repo, active) <= now;

/**
 * Mark a repository due immediately.
 *
 * Replaces the old `pulls.clearCache()`, which emptied every repository's list to
 * refresh one — the board's Refresh button, and the moment after a scheduled
 * review posts, which wants back the labels it has just set.
 */
function invalidate(repo = null) {
    load();
    if (repo === null) {
        for (const e of state.repos.values()) e.checkedAt = 0;
        return;
    }
    const entry = state.repos.get(repo);
    if (entry) entry.checkedAt = 0;
}

// ---------------------------------------------------------------------------
// Reading, which never asks GitHub
// ---------------------------------------------------------------------------

/**
 * The last known open list for a repository, in `pulls.openPulls`' shape.
 *
 * A repository nobody has asked about yet reports `ok: false` with no pulls and
 * says so, which is the truth: this is not "nothing is open", it is "not known".
 * Every caller already had to handle that case for a gh that would not run.
 */
function openPulls(repo) {
    load();
    const entry = state.repos.get(repo);
    if (!entry) {
        return {
            ok: false,
            error: 'pull requests have not been listed yet',
            pulls: [],
            checkedAt: null,
        };
    }
    return {
        ok: entry.ok,
        error: entry.error,
        pulls: entry.pulls,
        checkedAt: entry.checkedAt ? new Date(entry.checkedAt).toISOString() : null,
    };
}

/** A settled pull request, if one has ever been resolved. */
function terminalPull(repo, number) {
    load();
    const hit = state.terminal.get(key(repo, number));
    return hit ? hit.pull : null;
}

/**
 * Find one pull request without asking anybody.
 *
 * The open list first, then the settled ones. `pulls.resolveBatch` takes this so
 * that resolving a batch is a lookup rather than a fan-out of subprocesses.
 */
function lookup(repo, number, url) {
    if (!repo) return null;
    const listed = state.repos.get(repo);
    if (listed) {
        const found = listed.pulls.find(p => p.url === url || p.number === number);
        if (found) return found;
    }
    return terminalPull(repo, number);
}

/** The most recent moment any repository was successfully listed. */
function checkedAt() {
    load();
    let best = 0;
    for (const e of state.repos.values()) if (e.ok && e.checkedAt > best) best = e.checkedAt;
    return best ? new Date(best).toISOString() : null;
}

/** The first thing gh could not do, across the repositories a caller cares about. */
function ghError(repos) {
    load();
    for (const repo of repos) {
        const e = state.repos.get(repo);
        if (!e) return 'pull requests have not been listed yet';
        if (!e.ok) return e.error || 'gh failed';
    }
    return null;
}

/**
 * Status for the PRs one session raised, in the order it raised them.
 *
 * Was `pulls.forSession`. The shape it answers with is unchanged but for the
 * added `checkedAt`; what moved is where the pull requests come from.
 */
function forSession(prs, fallbackRepo = null) {
    load();
    const list = (prs || []).filter(p => p && p.url)
        .map(p => ({ number: p.number, url: p.url, repo: p.repo || fallbackRepo || null }));
    if (!list.length) return { prs: [], gh: { ok: true, error: null }, checkedAt: checkedAt() };

    const out = pulls.resolveBatch(list, lookup);
    const error = ghError(new Set(list.map(p => p.repo).filter(Boolean)));
    return { prs: out, gh: { ok: !error, error }, checkedAt: checkedAt() };
}

/**
 * One aggregate per session, for the rail. Was `pulls.forSessions`.
 *
 * Sessions with no PRs stay absent from the answer rather than null — the client
 * already knows which those are from `prs` on the summary.
 */
function forSessions(rows) {
    load();
    const flat = [];
    const spans = [];
    const repos = new Set();

    for (const row of rows || []) {
        const list = (row.prs || []).filter(p => p && p.url);
        if (!list.length) continue;
        const from = flat.length;
        for (const p of list) {
            const repo = p.repo || row.repo || null;
            if (repo) repos.add(repo);
            flat.push({ number: p.number, url: p.url, repo });
        }
        spans.push({ sessionId: row.sessionId, from, to: flat.length });
    }

    if (!flat.length) return { sessions: {}, gh: { ok: true, error: null }, checkedAt: checkedAt() };

    const resolved = pulls.resolveBatch(flat, lookup);
    const sessions = {};
    for (const { sessionId, from, to } of spans) {
        const agg = pulls.aggregate(resolved.slice(from, to));
        if (agg) sessions[sessionId] = agg;
    }

    const error = ghError(repos);
    return { sessions, gh: { ok: !error, error }, checkedAt: checkedAt() };
}

// ---------------------------------------------------------------------------
// Refreshing, which is the only thing that asks GitHub
// ---------------------------------------------------------------------------

/**
 * What a repository's answer amounts to, for deciding whether to tell anybody.
 *
 * Deliberately not the whole record: `updatedAt` moving because somebody
 * commented is a real change worth pushing, but `checkedAt` moves on every
 * successful call, and pushing on that would make the SSE event a heartbeat.
 */
const signature = (entry) => JSON.stringify([
    entry.ok, entry.error,
    (entry.pulls || []).map(p => [
        p.number, p.state, p.draft, p.reviewDecision, p.mergeable, p.updatedAt,
        p.headSha, p.labels, p.checks,
    ]),
]);

/**
 * List one repository and fold the answer in.
 *
 * The failure case is the interesting one: the previous pulls are kept beside the
 * error rather than replaced with an empty array. A caller that treats a failed
 * list as "nothing is open" will prune something it should not have, and an empty
 * array is exactly the shape that invites it.
 */
async function refreshRepo(repo) {
    const prev = state.repos.get(repo) || null;
    const before = prev ? signature(prev) : null;

    const r = await pulls.openPulls(repo);
    const entry = {
        checkedAt: Date.now(),
        ok: r.ok,
        error: r.error,
        attempts: r.ok ? 0 : (prev ? prev.attempts : 0) + 1,
        pulls: r.ok ? r.pulls : (prev ? prev.pulls : []),
    };
    state.repos.set(repo, entry);
    return before !== signature(entry);
}

/**
 * Resolve the pull requests a session named that its repository's open list does
 * not mention: merged or closed, and never going to be anything else.
 *
 * One `gh pr view` each, once ever — the answer is written to `terminal` and this
 * never asks again. It runs here, on the timer, rather than inside `resolveBatch`,
 * and that is what takes gh off the path of a request entirely.
 */
async function resolveTerminal(wanted) {
    const missing = new Map();
    for (const { repo, number, url } of wanted) {
        if (!repo || !number) continue;
        if (state.terminal.has(key(repo, number))) continue;
        const listed = state.repos.get(repo);
        // Not listed at all, or listed and failed: absence proves nothing.
        if (!listed || !listed.ok) continue;
        if (listed.pulls.some(p => p.url === url || p.number === number)) continue;
        missing.set(key(repo, number), { repo, number });
    }
    if (!missing.size) return false;

    let changed = false;
    await mapLimit([...missing.values()], GH_CONCURRENCY, async ({ repo, number }) => {
        const r = await pulls.pullState(repo, number);
        // Only a settled answer is worth keeping forever. An open PR that raced
        // the list is left alone; the next pass picks it up from the list itself.
        if (r.ok && r.terminal && r.pull) {
            state.terminal.set(key(repo, number), { at: Date.now(), pull: r.pull });
            changed = true;
        }
    });
    return changed;
}

/**
 * Which repository each session's pull requests live in.
 *
 * A `pr-link` line usually names its own repository. Where one did not, the
 * session's checkout is the best guess available, and `pulls.repoOf` shells out to
 * git — so it is asked once per directory rather than once per session, and its
 * own ten-minute memo covers the rest.
 */
async function reposFor(sessions) {
    const needRepo = [...new Set((sessions || [])
        .filter(s => s.cwd && (s.prs || []).some(p => p && !p.repo))
        .map(s => s.cwd))];

    const repoOfDir = new Map();
    await mapLimit(needRepo, GIT_CONCURRENCY, async (dir) => {
        repoOfDir.set(dir, await pulls.repoOf(dir));
    });

    /** @type {Map<string, Set<string>>} sessionId -> the repositories its PRs live in */
    const bySession = new Map();
    const all = new Set();
    for (const s of sessions || []) {
        const mine = new Set();
        for (const pr of s.prs || []) {
            const repo = (pr && pr.repo) || repoOfDir.get(s.cwd) || null;
            if (repo) { mine.add(repo); all.add(repo); }
        }
        if (mine.size) bySession.set(s.sessionId, mine);
    }
    return { repoOfDir, bySession, repos: all };
}

/**
 * One pass of the refresher.
 *
 * @param {object} opts
 * @param {Array} opts.sessions index summaries — `{sessionId, cwd, prs, mtimeMs}`.
 * @param {Set<string>} [opts.running] sessions with a turn in flight, which count
 *   as active whether or not their transcript has been flushed yet.
 * @param {Iterable<string>} [opts.extraRepos] repositories in play for a reason no
 *   session's PR list names — the dashboard reads a remote per project, and a
 *   project with no PR linked anywhere still wants listing.
 * @param {boolean} [opts.force] list everything regardless of when it was last
 *   asked. The board's explicit Refresh, and nothing else.
 * @returns {Promise<{changed: boolean, refreshed: string[], repos: Set<string>}>}
 */
async function tick({ sessions = [], running = new Set(), extraRepos = [], force = false } = {}) {
    load();
    const now = Date.now();
    const { bySession, repos } = await reposFor(sessions);
    for (const repo of extraRepos) if (repo) repos.add(repo);

    // A repository is active if a conversation about it has moved since it was
    // last listed, or has a turn running right now.
    //
    // **The comparison is the session's transcript mtime against the repository's
    // own `checkedAt`, and both are wall-clock on this machine, so it is exact.**
    // The obvious alternative — remember, per session, the mtime it was last
    // listed for — is what this started as, and it starves. Give a session two
    // repositories whose minute floors happen to be thirty seconds out of phase
    // and no single pass ever lists both, so the session is never marked answered
    // and both repositories poll at the floor forever. Comparing against
    // `checkedAt` has each repository answer for itself and needs no second map to
    // keep in step.
    //
    // A running turn is a separate signal because `claude` has not necessarily
    // flushed the transcript yet, so mtime can be behind the conversation — and
    // that is exactly the moment a PR gets raised.
    const active = new Set();
    for (const s of sessions) {
        const mine = bySession.get(s.sessionId);
        if (!mine) continue;
        const live = running.has(s.sessionId);
        for (const repo of mine) {
            const e = state.repos.get(repo);
            if (live || (s.mtimeMs || 0) > (e ? e.checkedAt : 0)) active.add(repo);
        }
    }

    const due = [...repos].filter(repo => force || isDue(repo, active.has(repo), now));

    let changed = false;
    if (due.length) {
        const results = await mapLimit(due, GH_CONCURRENCY, refreshRepo);
        changed = results.some(Boolean);
    }

    // Settle whatever the lists did not mention. After the lists, because a PR
    // that merged since the last pass leaves the open list and becomes terminal in
    // the same tick — so it is resolved before anybody is told anything.
    const wanted = [];
    for (const s of sessions) {
        const mine = bySession.get(s.sessionId);
        for (const pr of s.prs || []) {
            if (!pr || !pr.number) continue;
            const repo = pr.repo || (mine && mine.size ? [...mine][0] : null);
            wanted.push({ repo, number: pr.number, url: pr.url });
        }
    }
    if (await resolveTerminal(wanted)) changed = true;

    // Nothing to write down about the conversations: a failed list leaves
    // `checkedAt` moved but `ok` false, and `interval` puts a failing repository on
    // its backoff rather than on the idle floor — so the activity that prompted the
    // pass is still there to be found next time, without a marker recording it.

    prune(sessions, repos);
    if (changed || due.length) save();
    return { changed, refreshed: due, repos };
}

/**
 * Drop what nothing is asking about any more, so the file stays a cache and not a
 * log of every repository this machine has ever seen.
 */
function prune(sessions, repos) {
    const live = repos instanceof Set ? repos : new Set(repos);
    keepOnly(state.repos, live);

    const wanted = new Set();
    for (const s of sessions || []) {
        for (const pr of s.prs || []) {
            if (!pr || !pr.number) continue;
            // Deliberately loose: a settled PR is kept if any session still names
            // its number and its repository is still in play. Keying it exactly
            // would mean re-resolving the repository of every PR on every tick to
            // save a few hundred bytes.
            for (const repo of live) wanted.add(key(repo, pr.number));
        }
    }
    keepOnly(state.terminal, wanted);
}

/** Everything the store holds, for tests and for a health route. */
const snapshot = () => {
    load();
    return {
        repos: Object.fromEntries([...state.repos].map(([k, e]) => [k, { ...e }])),
        terminal: Object.fromEntries(state.terminal),
    };
};

/** Put a repository's answer in by hand, without asking gh. Tests only. */
function seed(repo, entry) {
    load();
    state.repos.set(repo, {
        checkedAt: Date.now(),
        ok: true,
        error: null,
        attempts: 0,
        pulls: [],
        ...entry,
    });
}

/** Forget everything held in memory. Tests only; leaves the file alone. */
function reset() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    state.repos.clear();
    state.terminal.clear();
    state.loaded = false;
}

module.exports = {
    openPulls, terminalPull, lookup, checkedAt, ghError,
    forSession, forSessions,
    tick, invalidate, refreshRepo, resolveTerminal, reposFor,
    dueAt, isDue, interval, checksRunning,
    load, save, flush, snapshot, seed, reset,
    STORE_FILE, TICK_MS, ACTIVE_MS, CHECKS_MS, IDLE_MS, BACKOFF_MS,
};
