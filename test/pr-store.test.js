'use strict';

// Exercises bridge/pr-store.js: when it decides a repository is worth a `gh` call,
// and what it keeps between one bridge and the next.
//
// Both halves are the kind that fail quietly. A freshness rule that is wrong does
// not throw — it just asks GitHub sixty times an hour, or once a day, and either
// way the app carries on looking correct. And the persistence exists to make a
// restart cheap, which is a property nobody notices working and nobody notices
// stopping.
//
// Three of these pin things that were bugs in the shape this replaced. A failed
// `gh pr list` used to be cached as an empty list, so an outage was
// indistinguishable from "nothing is open" — and the scheduled-review gate prunes
// against that list, so it would have emptied a reviewed map and re-reviewed a
// whole repository. Settled PRs were kept forever but only in memory, so every
// restart paid a `gh pr view` for each one. And nothing bounded the maps at all.
//
// No bridge and no network: `pulls.openPulls` and `pulls.pullState` are stubbed on
// the module object, which is the seam that exists precisely because the store
// asks gh through them rather than shelling out itself.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Its own cache directory, before anything reads config: the real one is shared
// with the everyday bridge, and this test writes a prs.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pr-store-'));
process.env.XDG_CACHE_HOME = TMP;

const pulls = require('../bridge/pulls.js');
const store = require('../bridge/pr-store.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// -- stubs -------------------------------------------------------------------

/** An open, unremarkable PR, for tests to spoil one field at a time. */
const pull = (over = {}) => ({
    number: 1,
    title: 'A change',
    url: 'https://github.com/o/r/pull/1',
    branch: 'feature',
    headSha: 'abc123',
    base: 'main',
    labels: [],
    draft: false,
    reviewDecision: null,
    author: 'someone',
    createdAt: null,
    updatedAt: '2026-08-27T10:00:00Z',
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    checks: null,
    repo: 'o/r',
    ...over,
});

let listCalls = [];
let viewCalls = [];
let listAnswer = () => ({ ok: true, error: null, pulls: [] });
let viewAnswer = () => ({ ok: false, error: 'not stubbed', terminal: false, pull: null });

pulls.openPulls = async (repo) => { listCalls.push(repo); return listAnswer(repo); };
pulls.pullState = async (repo, number) => { viewCalls.push(`${repo}#${number}`); return viewAnswer(repo, number); };
// Every session in these tests names its own repository, so this must never run.
pulls.repoOf = async () => { throw new Error('repoOf should not be needed'); };

const reset = () => {
    store.reset();
    listCalls = [];
    viewCalls = [];
    try { fs.unlinkSync(store.STORE_FILE); } catch { /* not there yet */ }
};

/** One session with one PR, in the shape index.list() hands out. */
const session = (over = {}) => ({
    sessionId: 's1',
    cwd: '/work',
    mtimeMs: 1000,
    prs: [{ number: 1, url: 'https://github.com/o/r/pull/1', repo: 'o/r' }],
    ...over,
});

// -- a failed list is not an empty one ---------------------------------------

(async () => {
    reset();
    listAnswer = () => ({ ok: true, error: null, pulls: [pull()] });
    await store.tick({ sessions: [session()] });
    assert.strictEqual(store.openPulls('o/r').pulls.length, 1, 'the good list should be held');

    listAnswer = () => ({ ok: false, error: 'gh: not logged in', pulls: [] });
    store.invalidate('o/r');
    await store.tick({ sessions: [session({ mtimeMs: 2000 })] });

    const after = store.openPulls('o/r');
    assert.strictEqual(after.ok, false, 'a failed list must report itself failed');
    assert.strictEqual(after.error, 'gh: not logged in', 'and say why, in gh\'s words');
    assert.strictEqual(after.pulls.length, 1,
        'a failed list must keep the last good one — an empty array reads as '
        + '"nothing is open", which is what the review gate prunes against');
    ok('a failed list keeps the pulls it last read, and says it failed');

    // -- backoff -------------------------------------------------------------

    reset();
    listAnswer = () => ({ ok: false, error: 'network down', pulls: [] });
    await store.tick({ sessions: [session()] });
    let entry = store.snapshot().repos['o/r'];
    assert.strictEqual(entry.attempts, 1, 'the first failure counts as one attempt');
    assert.strictEqual(store.interval(entry, false), store.BACKOFF_MS[0],
        'the first retry comes quickly — gh failing is usually a token or a blip');

    entry.attempts = 3;
    assert.strictEqual(store.interval(entry, false), store.BACKOFF_MS[2],
        'a third failure waits longer');
    entry.attempts = 99;
    assert.strictEqual(store.interval(entry, false), store.IDLE_MS,
        'and it never backs off past the idle floor');

    // Activity does not shorten a backoff: gh being down is not something typing
    // fixes, and asking harder is how a rate limit becomes a ban.
    entry.attempts = 3;
    assert.strictEqual(store.interval(entry, true), store.BACKOFF_MS[2],
        'a busy conversation does not shorten a backoff');
    ok('a failing repository backs off, and activity does not override it');

    reset();
    listAnswer = () => ({ ok: false, error: 'network down', pulls: [] });
    await store.tick({ sessions: [session()] });
    listAnswer = () => ({ ok: true, error: null, pulls: [pull()] });
    store.invalidate('o/r');
    await store.tick({ sessions: [session({ mtimeMs: 2000 })] });
    assert.strictEqual(store.snapshot().repos['o/r'].attempts, 0,
        'one good answer clears the backoff');
    ok('a successful list resets the backoff');

    // -- the freshness rules -------------------------------------------------

    reset();
    const quiet = { ok: true, error: null, attempts: 0, pulls: [pull()], checkedAt: Date.now() };
    assert.strictEqual(store.interval(quiet, false), store.IDLE_MS,
        'a quiet repository is asked about on the idle floor');
    assert.strictEqual(store.interval(quiet, true), store.ACTIVE_MS,
        'one whose conversation just moved is asked about sooner');

    const building = { ...quiet, pulls: [pull({ checks: { total: 2, failed: 0, pending: 1, passed: 1 } })] };
    assert.strictEqual(store.interval(building, false), store.CHECKS_MS,
        'a check in flight is the one thing that changes on its own within minutes');
    assert.ok(store.CHECKS_MS < store.IDLE_MS, 'and it must be the shorter of the two');

    // Deliberately the raw pending count and not resolveStatus: a draft with a
    // build running reports `draft`, and it is still a build about to finish.
    const draftBuilding = { ...quiet, pulls: [pull({ draft: true, checks: { total: 1, failed: 0, pending: 1, passed: 0 } })] };
    assert.strictEqual(store.checksRunning(draftBuilding), true,
        'a draft with a build running still counts as building');
    assert.strictEqual(store.interval(draftBuilding, false), store.CHECKS_MS,
        'and gets the short interval, because resolveStatus would have hidden it');

    const done = { ...quiet, pulls: [pull({ checks: { total: 2, failed: 0, pending: 0, passed: 2 } })] };
    assert.strictEqual(store.interval(done, false), store.IDLE_MS,
        'and it stops the moment the check does');
    ok('the four intervals, including the one resolveStatus would have hidden');

    // -- activity is what the conversation moving means ----------------------
    //
    // The transcript mtime is compared against the repository's own `checkedAt`,
    // and both are wall-clock ms — so these seed a `checkedAt` and set an mtime on
    // either side of it rather than counting passes.

    reset();
    listAnswer = () => ({ ok: true, error: null, pulls: [pull()] });
    await store.tick({ sessions: [session()] });
    assert.strictEqual(listCalls.length, 1, 'a repository never asked about is asked about');

    // Listed a moment ago, and the conversation has said nothing since. Neither
    // trigger fires, so nothing is asked.
    const justNow = Date.now();
    store.seed('o/r', { checkedAt: justNow, pulls: [pull()] });
    await store.tick({ sessions: [session({ mtimeMs: justNow - 1000 })] });
    assert.strictEqual(listCalls.length, 1, 'a quiet conversation asks nothing');

    // The conversation has moved since that list — but the list is seconds old,
    // and the floor is a minute.
    await store.tick({ sessions: [session({ mtimeMs: justNow + 1 })] });
    assert.strictEqual(listCalls.length, 1,
        'activity does not beat the one-minute floor — a session writing its '
        + 'transcript every few seconds must not become a gh per tick');

    // Same activity, a list that is now older than the floor.
    const old = Date.now() - store.ACTIVE_MS - 1;
    store.seed('o/r', { checkedAt: old, pulls: [pull()] });
    await store.tick({ sessions: [session({ mtimeMs: old + 1 })] });
    assert.strictEqual(listCalls.length, 2, 'past the floor, the moved conversation is asked about');

    // And a conversation quiet since before that list is still left alone, even
    // though the same list is past the active floor: it is on the idle one.
    store.seed('o/r', { checkedAt: old, pulls: [pull()] });
    await store.tick({ sessions: [session({ mtimeMs: old - 1 })] });
    assert.strictEqual(listCalls.length, 2,
        'a conversation that has not moved since the list stays on the idle floor');
    ok('a moved conversation triggers a list, floored at a minute');

    // A running turn counts even with an mtime behind the list: `claude` has not
    // flushed the transcript yet, and that is exactly the moment a PR gets raised.
    store.seed('o/r', { checkedAt: old, pulls: [pull()] });
    await store.tick({ sessions: [session({ mtimeMs: old - 1 })], running: new Set(['s1']) });
    assert.strictEqual(listCalls.length, 3, 'a turn in flight counts as activity');
    ok('a running turn counts as activity even with an unflushed transcript');

    // -- a failed list does not swallow the activity that prompted it --------
    //
    // The failure moves `checkedAt` past the mtime, so the activity trigger stops
    // firing — the backoff is what has to bring it back, rather than the idle floor.

    reset();
    listAnswer = () => ({ ok: false, error: 'gh down', pulls: [] });
    store.seed('o/r', { checkedAt: old, pulls: [] });
    await store.tick({ sessions: [session({ mtimeMs: old + 1 })] });
    assert.strictEqual(listCalls.length, 1, 'the moved conversation was asked about');
    const failed = store.snapshot().repos['o/r'];
    assert.strictEqual(failed.ok, false, 'and gh could not answer');
    assert.strictEqual(store.interval(failed, false), store.BACKOFF_MS[0],
        'so the retry is a minute away on the backoff, not twenty on the idle floor');
    ok('a failed list is retried on its backoff rather than forgotten');

    // -- settled pull requests survive a restart -----------------------------

    reset();
    const merged = pull({ state: 'MERGED', number: 7, url: 'https://github.com/o/r/pull/7' });
    listAnswer = () => ({ ok: true, error: null, pulls: [] });
    viewAnswer = () => ({ ok: true, error: null, terminal: true, pull: merged });

    const s = session({ prs: [{ number: 7, url: merged.url, repo: 'o/r' }] });
    await store.tick({ sessions: [s] });
    assert.strictEqual(viewCalls.length, 1, 'a PR the open list does not mention costs one view');
    assert.strictEqual(store.terminalPull('o/r', 7).state, 'MERGED', 'and is remembered');

    await store.tick({ sessions: [s], force: true });
    assert.strictEqual(viewCalls.length, 1, 'and never asked about again in this process');

    // The whole point of the file: a restart must not pay for it again.
    store.flush();
    store.reset();
    assert.strictEqual(store.terminalPull('o/r', 7).state, 'MERGED',
        'a settled PR must survive a restart — this is the seconds-long cold '
        + 'start the store exists to end');
    await store.tick({ sessions: [s], force: true });
    assert.strictEqual(viewCalls.length, 1, 'and still cost nothing after it');
    ok('a settled PR is resolved once, ever, across restarts');

    // An open PR that raced the list is not written down as settled: it is not.
    reset();
    listAnswer = () => ({ ok: true, error: null, pulls: [] });
    viewAnswer = () => ({ ok: true, error: null, terminal: false, pull: pull({ number: 9 }) });
    await store.tick({ sessions: [session({ prs: [{ number: 9, url: 'u9', repo: 'o/r' }] })] });
    assert.strictEqual(store.terminalPull('o/r', 9), null,
        'only a settled answer is worth keeping forever');
    ok('an open PR that raced the list is not recorded as settled');

    // Absence proves nothing when the list itself failed.
    reset();
    listAnswer = () => ({ ok: false, error: 'gh down', pulls: [] });
    viewAnswer = () => ({ ok: true, error: null, terminal: true, pull: merged });
    await store.tick({ sessions: [session({ prs: [{ number: 7, url: merged.url, repo: 'o/r' }] })] });
    assert.strictEqual(viewCalls.length, 0,
        'a PR missing from a list that failed is not missing — it is unknown');
    ok('a failed list does not make its PRs look merged');

    // -- reading never asks ---------------------------------------------------

    reset();
    listAnswer = () => ({ ok: true, error: null, pulls: [pull()] });
    await store.tick({ sessions: [session()] });
    const before = listCalls.length + viewCalls.length;
    store.forSession([{ number: 1, url: 'https://github.com/o/r/pull/1', repo: 'o/r' }]);
    store.forSessions([{ sessionId: 's1', prs: [{ number: 1, url: 'https://github.com/o/r/pull/1', repo: 'o/r' }] }]);
    store.openPulls('o/r');
    assert.strictEqual(listCalls.length + viewCalls.length, before,
        'nothing a route calls may shell out — that is the whole refactor');
    ok('reading the store never asks GitHub');

    // A PR in a repository nobody has listed is `unknown`, not missing and not
    // open. The header keeps drawing it from the summary, uncoloured.
    const cold = store.forSession([{ number: 3, url: 'u3', repo: 'other/repo' }]);
    assert.strictEqual(cold.prs.length, 1, 'an unlisted PR still gets an entry');
    assert.strictEqual(cold.prs[0].status, 'unknown', 'with no claim about it');
    assert.strictEqual(cold.gh.ok, false, 'and the envelope says GitHub could not answer');
    ok('a PR in an unlisted repository reports unknown rather than vanishing');

    // -- the file stays a cache ----------------------------------------------

    reset();
    listAnswer = () => ({ ok: true, error: null, pulls: [pull()] });
    await store.tick({ sessions: [session()] });
    assert.ok(store.snapshot().repos['o/r'], 'the repository is held while a session names it');

    // The session is gone; so is everything that was kept for it.
    await store.tick({ sessions: [] });
    const empty = store.snapshot();
    assert.deepStrictEqual(empty.repos, {}, 'a repository nothing asks about is dropped');
    assert.deepStrictEqual(empty.terminal, {}, 'and so are its settled PRs');
    ok('the store prunes what nothing is asking about any more');

    // -- a version it does not know is dropped whole -------------------------

    reset();
    await store.tick({ sessions: [session()] });
    store.flush();
    const raw = JSON.parse(fs.readFileSync(store.STORE_FILE, 'utf8'));
    assert.strictEqual(raw.version, 1, 'the file is versioned');
    fs.writeFileSync(store.STORE_FILE, JSON.stringify({ ...raw, version: 999 }));
    store.reset();
    assert.deepStrictEqual(store.snapshot().repos, {},
        'a version this release does not know is dropped rather than half-read: '
        + 'the cost is one round of gh calls, and the alternative is another '
        + 'release\'s shape quietly answering questions about today\'s');
    ok('an unknown file version is dropped rather than half-read');

    // Corrupt is the same answer, and must not throw on the way to it.
    reset();
    fs.writeFileSync(store.STORE_FILE, '{not json');
    store.reset();
    assert.deepStrictEqual(store.snapshot().repos, {}, 'an unreadable file starts empty');
    ok('an unreadable file starts empty rather than throwing');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\n  ${pass} checks passed`);
})().catch((err) => {
    console.error(`\n  FAILED: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
