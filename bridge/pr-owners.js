'use strict';

// Which conversation raised a pull request — `GET /api/pr-owners`.
//
// A transcript records the PRs its session opened (`pr-link` lines, read into
// `summary.prs` by transcript.js), so the bridge has always known session → PR.
// What nothing knew was the way back: an agent writes "#151 isn't approved yet",
// #151 was opened by some other chat, and the only way to find which was to go
// looking. This is the reverse map, so a `#N` mention in the transcript can say
// whose it is and take you there (web/pr-refs.js).
//
// Keyed `owner/name#N` rather than by number, because a number means nothing
// without its repository — two projects both have a #12. A `pr-link` that named
// no repository gets the one its checkout's `origin` points at, the same guess
// `pr-store.reposFor` makes; one that still cannot be placed is left out rather
// than filed under null, where it would match every repository's #N.
//
// It walks the whole index, not the 500 the rail lists, because the session that
// raised a PR is very often an old one. That walk is a loop over summaries the
// index already holds plus a memoised `git remote` per directory, so it is cheap,
// but it is still kept for OWNERS_TTL_MS and dropped early when the index moves.
//
// PR status rides along from pr-store when it already has it. This route never
// asks GitHub — the refresher does that on its own clock.

const cfg = require('./config');
const pulls = require('./pulls');
const prStore = require('./pr-store');
const { mapLimit } = require('./memo');

const OWNERS_TTL_MS = 30_000;
const GIT_CONCURRENCY = 8;

let index = null;
/** @type {{at: number, value: Promise<object>}|null} */
let memo = null;

function init(deps) {
    ({ index } = deps);
    if (index && typeof index.on === 'function') index.on('changed', invalidate);
}

function invalidate() { memo = null; }

const keyOf = (repo, number) => `${repo}#${number}`;

/**
 * The reverse map, from summaries alone.
 *
 * `repoOf(dir)` answers for a `pr-link` that named no repository. Each list is
 * most recently active first and holds a session once, however many times its
 * transcript linked the PR.
 *
 * @param {object[]} summaries index summaries
 * @param {(dir: string) => Promise<string|null>} repoOf
 * @returns {Promise<Record<string, object[]>>}
 */
async function buildOwners(summaries, repoOf) {
    const rows = (summaries || []).filter(s => s && (s.prs || []).length);
    const needDir = [...new Set(rows
        .filter(s => s.prs.some(p => p && !p.repo))
        .map(s => s.cwd || s.projectCwd)
        .filter(Boolean))];
    const dirRepo = new Map();
    await mapLimit(needDir, GIT_CONCURRENCY, async (dir) => {
        dirRepo.set(dir, await repoOf(dir).catch(() => null));
    });

    const owners = {};
    for (const s of rows) {
        for (const p of s.prs) {
            if (!p || p.number == null) continue;
            const repo = p.repo || dirRepo.get(s.cwd || s.projectCwd) || null;
            if (!repo) continue;
            const list = owners[keyOf(repo, p.number)] ||= [];
            if (list.some(o => o.sessionId === s.sessionId)) continue;
            list.push({
                sessionId: s.sessionId,
                title: s.title || null,
                projectName: s.projectName || null,
                projectCwd: s.projectCwd || s.cwd || null,
                archived: !!s.archived,
                mtimeMs: s.mtimeMs || 0,
            });
        }
    }
    for (const list of Object.values(owners)) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return owners;
}

/** What each owned PR currently looks like, where the store already knows. */
function statusesFor(keys) {
    const prs = {};
    for (const k of keys) {
        const at = k.lastIndexOf('#');
        const repo = k.slice(0, at);
        const number = Number(k.slice(at + 1));
        const [r] = pulls.resolveBatch([{ number, url: null, repo }], prStore.lookup);
        if (r && r.status !== 'unknown') {
            prs[k] = { title: r.title || null, status: r.status, label: r.label || null };
        }
    }
    return prs;
}

/** The body of `GET /api/pr-owners`. */
function ownersPayload() {
    if (memo && Date.now() - memo.at < OWNERS_TTL_MS) return memo.value;
    const value = (async () => {
        const sessions = index.list({ limit: 100_000, includeTest: cfg.IS_DEV });
        const owners = await buildOwners(sessions, pulls.repoOf);
        return { owners, prs: statusesFor(Object.keys(owners)), checkedAt: new Date().toISOString() };
    })();
    memo = { at: Date.now(), value };
    value.catch(() => { if (memo && memo.value === value) memo = null; });
    return value;
}

module.exports = { init, invalidate, buildOwners, ownersPayload, keyOf };
