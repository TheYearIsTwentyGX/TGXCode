'use strict';

// Everything this app knows about a pull request comes through here.
//
// Two callers with different questions. The work-in-flight board asks "what is
// open on this repository" once per repo and matches the answers against what is
// on disk. A conversation header asks the narrower question "what happened to the
// PRs *this session* raised", and that one has to be answerable for a PR that has
// already merged — which the open list, by design, does not mention.
//
// So the open list stays the primary source and the per-PR lookup is the
// exception. A PR absent from `gh pr list --state open` is terminal: merged or
// closed, and never going to be anything else. That is worth one `gh pr view` and
// then worth remembering forever, which is why the TTL below is chosen per call
// rather than fixed — see `pullState`.
//
// A resolved status is one word, because an icon and a colour can only carry one.
// A PR is regularly several things at once (open, approved, and conflicting), so
// `resolveStatus` ranks them by what most needs doing about it and hands the rest
// back as detail lines for the tooltip.

const { execFile } = require('child_process');

const { cached } = require('./memo');

const GH_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 10_000;

// GitHub is not cheap and a PR does not change much in a minute.
const PR_TTL_MS = 60_000;
const REPO_TTL_MS = 10 * 60_000;

// `state`, `mergeable` and `statusCheckRollup` are here for the header's sake;
// the board only ever used the first six. They cost nothing extra — the same one
// call per repository answers both callers.
const PR_FIELDS = 'number,title,url,headRefName,isDraft,updatedAt,createdAt,'
    + 'reviewDecision,author,state,mergeable,statusCheckRollup';

const cache = {
    /** @type {Map<string, {value?: any, pending?: Promise<any>, at: number}>} repo -> open PRs */
    prs: new Map(),
    /** @type {Map<string, {value?: any, pending?: Promise<any>, at: number}>} checkout -> owner/name */
    repo: new Map(),
    /** @type {Map<string, {value?: any, pending?: Promise<any>, at: number}>} repo#n -> one PR */
    state: new Map(),
};

/**
 * Run a command and always resolve. Every question here is about somebody else's
 * repository, so failure is an answer rather than an error: gh may not be
 * installed, the repo may not be readable, the network may be down, and the
 * caller's job in all three cases is to say so and carry on.
 */
function run(cmd, args, { timeout = GH_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({
                ok: !err,
                stdout: String(stdout || ''),
                stderr: String(stderr || (err && err.message) || ''),
                code: err ? (err.code ?? 1) : 0,
            }));
    });
}

const firstLine = (s) => String(s || '').trim().split('\n')[0] || '';

/** Why gh could not answer, in one line a person can act on. */
const ghError = (r) => (r.code === 'ENOENT'
    ? 'the gh CLI is not installed'
    : firstLine(r.stderr) || 'gh failed');

// ---------------------------------------------------------------------------
// Asking GitHub
// ---------------------------------------------------------------------------

/** `owner/name` for a GitHub remote, or null for anything else. */
function githubRepo(url) {
    const m = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
    return m ? `${m[1]}/${m[2]}` : null;
}

const repoOf = (dir) => cached(cache.repo, dir, REPO_TTL_MS, async () => {
    const r = await run('git', ['-C', dir, 'remote', 'get-url', 'origin'],
        { timeout: GIT_TIMEOUT_MS });
    return r.ok ? githubRepo(r.stdout) : null;
});

/** One gh PR object, in this app's shape. */
const normalise = (p, repo) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    branch: p.headRefName,
    draft: !!p.isDraft,
    reviewDecision: p.reviewDecision || null,
    author: (p.author && (p.author.login || p.author.name)) || null,
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
    // `gh pr list --state open` does report `state`, but default it anyway: this
    // shape is also built from callers that filtered for open and dropped it.
    state: p.state || 'OPEN',
    mergeable: p.mergeable || 'UNKNOWN',
    checks: checkSummary(p.statusCheckRollup),
    repo,
});

/**
 * The open pull requests on one repository.
 *
 * Still one call per repo rather than one per PR: asking after each PR the
 * transcripts mention would be a call each and would read the same fields.
 */
const openPulls = (repo) => cached(cache.prs, repo, PR_TTL_MS, async () => {
    const r = await run('gh', [
        'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_FIELDS,
    ]);
    if (!r.ok) return { ok: false, error: ghError(r), pulls: [] };
    try {
        return { ok: true, error: null, pulls: JSON.parse(r.stdout).map(p => normalise(p, repo)) };
    } catch (err) {
        return { ok: false, error: `could not read gh output: ${err.message}`, pulls: [] };
    }
});

/**
 * One pull request by number, for the PRs the open list does not mention.
 *
 * The TTL is decided from what is already cached rather than fixed, which is the
 * whole economy of this module: `MERGED` and `CLOSED` are final, so the first
 * answer is the last one needed and it is kept for the life of the bridge. Only
 * an open PR — a race against the open list's own minute of cache — is asked
 * about again.
 */
function pullState(repo, number) {
    const key = `${repo}#${number}`;
    const hit = cache.state.get(key);
    const ttl = hit && hit.value && hit.value.terminal ? Infinity : PR_TTL_MS;

    return cached(cache.state, key, ttl, async () => {
        const r = await run('gh', [
            'pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS,
        ]);
        if (!r.ok) return { ok: false, error: ghError(r), terminal: false, pull: null };
        try {
            const pull = normalise(JSON.parse(r.stdout), repo);
            return {
                ok: true,
                error: null,
                terminal: pull.state === 'MERGED' || pull.state === 'CLOSED',
                pull,
            };
        } catch (err) {
            return {
                ok: false,
                error: `could not read gh output: ${err.message}`,
                terminal: false,
                pull: null,
            };
        }
    });
}

// ---------------------------------------------------------------------------
// What a pull request's status is
// ---------------------------------------------------------------------------

// A check that has finished badly. `CANCELLED`, `NEUTRAL` and `SKIPPED` are
// deliberately absent: GitHub counts none of them against a PR, and reporting a
// skipped job as a failure would make the indicator cry wolf.
const CHECK_FAILED = new Set([
    'FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE',
]);
const CHECK_PENDING = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']);

/**
 * Count a `statusCheckRollup` into passed/failed/pending, or null for "nothing to
 * say".
 *
 * Null is the important case and it is not the same as zero. An empty rollup
 * means the repository has no CI at all, which must read as silence — neither of
 * this app's own repositories has a workflow, so treating empty as "pending"
 * would put a spinning badge on every PR forever.
 *
 * Two entry shapes exist and both turn up in the same array: a `CheckRun` states
 * `status` and, once complete, `conclusion`; a `StatusContext` states `state`.
 * Anything matching neither is skipped rather than guessed at.
 */
function checkSummary(rollup) {
    if (!Array.isArray(rollup) || !rollup.length) return null;

    let total = 0; let failed = 0; let pending = 0; let passed = 0;
    for (const c of rollup) {
        if (!c || typeof c !== 'object') continue;
        let v = null;
        if (typeof c.status === 'string' && c.status) {
            v = c.status === 'COMPLETED' ? String(c.conclusion || '') : c.status;
        } else if (typeof c.state === 'string' && c.state) {
            v = c.state;
        }
        if (!v) continue;

        total++;
        if (CHECK_FAILED.has(v)) failed++;
        else if (CHECK_PENDING.has(v)) pending++;
        else if (v === 'SUCCESS') passed++;
    }
    return total ? { total, failed, pending, passed } : null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The one status to show for a pull request, plus the rest as detail.
 *
 * Ordered by what most needs doing about it, so a PR that is open *and* approved
 * *and* conflicting reads as conflicting. `detail` carries everything the one
 * word had to leave out, for the tooltip.
 */
function resolveStatus(pr) {
    const detail = [];
    const checks = pr.checks;

    if (checks) {
        if (checks.failed) {
            detail.push(`${checks.failed} of ${plural(checks.total, 'check')} failed`);
        } else if (checks.pending) {
            detail.push(`${plural(checks.pending, 'check')} still running`);
        } else if (checks.passed === checks.total) {
            detail.push(`${plural(checks.total, 'check')} passed`);
        }
    }
    if (pr.reviewDecision === 'REVIEW_REQUIRED') detail.push('review required');

    const of = (status, label) => ({ status, label, detail });

    // Terminal first: nothing else about a merged PR is worth saying.
    if (pr.state === 'MERGED') return of('merged', 'merged');
    if (pr.state === 'CLOSED') return of('closed', 'closed without merging');

    if (pr.draft) return of('draft', 'draft');

    if (pr.reviewDecision === 'CHANGES_REQUESTED') return of('changes', 'changes requested');
    if (checks && checks.failed) return of('checks-failed', 'checks failing');

    // `UNKNOWN` means GitHub has not worked it out yet, which is not the same as
    // mergeable — it turns up on freshly-pushed branches. Say nothing.
    if (pr.mergeable === 'CONFLICTING') return of('conflicting', 'conflicts with the base branch');

    if (checks && checks.pending) return of('checks-pending', 'checks running');
    if (pr.reviewDecision === 'APPROVED') return of('approved', 'approved');
    return of('open', 'open');
}

// ---------------------------------------------------------------------------
// A session's pull requests
// ---------------------------------------------------------------------------

/** A PR gh could not be asked about: still a number, still a link, no claim. */
const unknown = (base) => ({ ...base, status: 'unknown', label: null, detail: [] });

/**
 * Status for the PRs one session raised, in the order it raised them.
 *
 * Takes the `{number, url, repo}` triples the transcript recorded and answers
 * with a status for each. A PR gh could not be asked about reports `unknown`,
 * because a header that has lost its GitHub connection should be no worse than
 * one that never had it.
 */
async function forSession(prs, fallbackRepo = null) {
    const list = (prs || []).filter(p => p && p.url);
    if (!list.length) return { prs: [], gh: { ok: true, error: null } };

    const repos = [...new Set(list.map(p => p.repo || fallbackRepo).filter(Boolean))];
    const open = new Map();
    let error = null;

    await Promise.all(repos.map(async (repo) => {
        const r = await openPulls(repo);
        if (r.ok) open.set(repo, r);
        else error = error || r.error;
    }));

    const out = await Promise.all(list.map(async (p) => {
        const repo = p.repo || fallbackRepo;
        const base = { number: p.number, url: p.url, repo: repo || null };

        const listed = repo ? open.get(repo) : null;
        if (!listed) return unknown(base);

        let pull = listed.pulls.find(q => q.url === p.url || q.number === p.number) || null;
        if (!pull) {
            // Not open, so it has been merged or closed. One call, then never again.
            const r = await pullState(repo, p.number);
            if (!r.ok) { error = error || r.error; return unknown(base); }
            pull = r.pull;
        }

        const { status, label, detail } = resolveStatus(pull);
        return {
            ...base,
            title: pull.title || null,
            branch: pull.branch || null,
            updatedAt: pull.updatedAt || null,
            status,
            label,
            detail,
        };
    }));

    return { prs: out, gh: { ok: !error, error } };
}

/** Forget the cached open lists, for the board's explicit refresh. */
function clearCache() {
    cache.prs.clear();
    // Remotes and settled PRs are not what a refresh is ever about: a repository
    // does not change its origin, and a merged PR does not come back.
}

module.exports = {
    githubRepo, repoOf, openPulls, pullState, resolveStatus, checkSummary,
    forSession, clearCache, PR_TTL_MS,
};
