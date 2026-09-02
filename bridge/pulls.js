'use strict';

// Everything this app knows about a pull request comes through here.
//
// Three callers with different questions. The work-in-flight board asks "what is
// open on this repository" once per repo and matches the answers against what is
// on disk. A conversation header asks the narrower question "what happened to the
// PRs *this session* raised", and that one has to be answerable for a PR that has
// already merged — which the open list, by design, does not mention. The session
// rail asks the header's question about every session at once and then throws all
// but one word of the answer away, because a row has space for one glyph.
//
// So the open list stays the primary source and the per-PR lookup is the
// exception. A PR absent from `gh pr list --state open` is terminal: merged or
// closed, and never going to be anything else. That is worth one `gh pr view` and
// then worth remembering forever.
//
// **Where an answer is kept, and for how long, is no longer this file's
// business.** `bridge/pr-store.js` owns that now — a snapshot on disk, and a
// timer deciding which repositories are worth asking about. What is left here is
// the two gh verbs, the shape an answer takes, and the two orderings that turn a
// pull request into one word. `openPulls` and `pullState` ask, every time, and it
// is the store that decides whether to call them; `resolveBatch` no longer asks
// at all and takes a lookup instead, which is what got gh off the path of a
// request. The one memo that stayed is `repoOf`: a checkout's remote is a fact
// about the disk rather than about GitHub, and nothing gains by writing it down.
//
// A resolved status is one word, because an icon and a colour can only carry one.
// A PR is regularly several things at once (open, approved, and conflicting), so
// `resolveStatus` ranks them by what most needs doing about it and hands the rest
// back as detail lines for the tooltip.
//
// **This module also writes now, which it did not used to.** A scheduled review
// leaves a comment and a verdict label on the PR it reviewed — see *Telling
// GitHub* at the foot of the file. The header said "everything this app knows
// about a pull request comes through here" and that is still true; what changed is
// that the arrow points both ways.
//
// It lives here rather than in a module of its own because the rule worth keeping
// is *one module per external tool*, not *one direction per module*. A second file
// shelling out to `gh` would have to copy `run()`, `ghError()` and the ENOENT
// special case, and `bridge/git.js` exists in the shape it does precisely because
// two modules once asked git the same question independently. What deliberately
// stayed out of here is policy: which label a verdict earns, whether a schedule
// may post at all, and when to give up are decisions about a schedule. A *session* is regularly several PRs at
// once for the same reason, and `aggregate` ranks those — by a different order,
// which is worth reading the comment above `ATTENTION_ORDER` for.

const { execFile } = require('child_process');

const { cached } = require('./memo');

const GH_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 10_000;

// A checkout's origin does not change, so this is long. It is also the only TTL
// left in this file — see the header for where the others went.
const REPO_TTL_MS = 10 * 60_000;

// `state`, `mergeable` and `statusCheckRollup` are here for the header's sake;
// the board only ever used the first six. They cost nothing extra — the same one
// call per repository answers both callers.
//
// `headRefOid`, `baseRefName` and `labels` are the scheduled-review gate's, and
// each is load-bearing rather than convenient. The head SHA is what "have I
// reviewed this PR *as it stands*" is keyed on — `updatedAt` moves when somebody
// comments, so it cannot be the marker. The base is per-PR because these repos
// stack: one open PR targets `replit-dev` and another targets a worktree branch,
// so a review diffed against a fixed ref would attribute somebody else's commits
// to the PR. And the labels are needed to *remove* the two verdict labels a PR is
// not wearing any more — `--remove-label` errors on a label that is not there, so
// the only safe way to set one of three is to know which are on.
const PR_FIELDS = 'number,title,url,headRefName,headRefOid,baseRefName,labels,'
    + 'isDraft,updatedAt,createdAt,'
    + 'reviewDecision,author,state,mergeable,statusCheckRollup';

const cache = {
    /** @type {Map<string, {value?: any, pending?: Promise<any>, at: number}>} checkout -> owner/name */
    repo: new Map(),
};

/**
 * Run a command and always resolve. Every question here is about somebody else's
 * repository, so failure is an answer rather than an error: gh may not be
 * installed, the repo may not be readable, the network may be down, and the
 * caller's job in all three cases is to say so and carry on.
 */
function run(cmd, args, { timeout = GH_TIMEOUT_MS, input = null } = {}) {
    return new Promise((resolve) => {
        const child = execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({
                ok: !err,
                stdout: String(stdout || ''),
                stderr: String(stderr || (err && err.message) || ''),
                code: err ? (err.code ?? 1) : 0,
            }));
        // `input` exists for one caller and one reason: a review body is
        // multi-KB prose, and argv has a hard length limit — about 128KB on
        // Linux but roughly 32KB through CreateProcess, and this app ships to
        // Windows. `execFile` avoids a shell so quoting was never the problem;
        // length is. Writing the body to stdin has no such limit.
        //
        // Guarded because a child that has already failed to spawn has no
        // stdin, and an EPIPE on a process that exited is not news.
        if (input != null && child.stdin) {
            child.stdin.on('error', () => {});
            child.stdin.end(input);
        }
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
    // Named for the existing `branch ← headRefName` convention rather than
    // gh's own spelling.
    headSha: p.headRefOid || null,
    base: p.baseRefName || null,
    // Names only. gh returns {id, name, color, description} per label; `id` is a
    // node id nothing here can use, and the whole array would be several hundred
    // bytes per PR on a payload that already carries a hundred of them.
    labels: Array.isArray(p.labels)
        ? p.labels.map(l => l && l.name).filter(Boolean) : [],
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
 * transcripts mention would be a call each and would read the same fields. This
 * asks every time it is called — `pr-store.js` is what decides how often that is.
 */
async function openPulls(repo) {
    const r = await run('gh', [
        'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_FIELDS,
    ]);
    if (!r.ok) return { ok: false, error: ghError(r), pulls: [] };
    try {
        return { ok: true, error: null, pulls: JSON.parse(r.stdout).map(p => normalise(p, repo)) };
    } catch (err) {
        return { ok: false, error: `could not read gh output: ${err.message}`, pulls: [] };
    }
}

/**
 * One pull request by number, for the PRs the open list does not mention.
 *
 * `terminal` is the answer the caller is really after: `MERGED` and `CLOSED` are
 * final, so an answer carrying it is the last one ever needed for that PR. The
 * store writes those down and never asks again, which is the whole economy of
 * this pair — and, since it writes them to disk, the economy now survives a
 * restart rather than dying with the process.
 */
async function pullState(repo, number) {
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
 * Resolve a batch of `{number, url, repo}` triples to statuses.
 *
 * **Synchronous, and it asks nobody anything.** `lookup(repo, number, url)`
 * hands back a pull request or null, and `pr-store.js` supplies one that reads
 * its snapshot; whatever the lookup cannot answer for reports `unknown`, which is
 * the same thing this used to report when gh would not run. That is what took
 * GitHub off the path of a request: the three routes that call this used to fan
 * out one `gh pr list` per repository and one `gh pr view` per settled PR while a
 * browser waited, and now they read memory.
 *
 * A PR the lookup misses is not an error and is not empty — it is a PR whose
 * state is not known yet, and a header that has lost its colour is no worse than
 * one that never had it. The store's own `ghError` says why, separately, so that
 * "gh is broken" and "nothing is open" stay distinguishable.
 *
 * Returns a resolved entry per input in input order, so a caller can slice its
 * own sessions back out.
 */
function resolveBatch(list, lookup) {
    return list.map((p) => {
        const repo = p.repo || null;
        const base = { number: p.number, url: p.url, repo };

        const pull = repo ? lookup(repo, p.number, p.url) : null;
        if (!pull) return unknown(base);

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
    });
}

// ---------------------------------------------------------------------------
// One status for a whole session
// ---------------------------------------------------------------------------

// Which of a session's PRs the rail should colour itself after — least settled
// first, so the first match wins.
//
// Deliberately *not* `resolveStatus`'s order, and the difference is the point of
// having two. That one ranks the states of a single PR and puts the terminal ones
// first, because for one merged PR nothing else is worth saying. Across several,
// the terminal states are the ones that no longer need saying: a session with two
// merged PRs and a draft has a draft to finish, and that is the whole question a
// row is answering.
//
// It also disagrees about draft. `resolveStatus` puts draft above anything wrong
// with the code, because nobody is being asked to act on a draft yet. That
// reasoning is about *one* PR — here a conflict on a second PR is waiting on you
// now while the draft is not, so the broken one wins.
//
// `unknown` is gh being unreachable rather than a state a PR can be in, and it
// sits above the two settled states on purpose: with one PR unreachable and one
// merged, "all merged" is a claim this cannot make. Below every live state,
// because a real answer beats no answer.
const ATTENTION_ORDER = [
    'conflicting', 'checks-failed', 'changes', 'draft', 'checks-pending',
    'open', 'approved', 'unknown', 'closed', 'merged',
];

const attentionRank = (status) => {
    const at = ATTENTION_ORDER.indexOf(status);
    // A status this does not know is more interesting than one it does, not less:
    // a new one added to `resolveStatus` and forgotten here should show up rather
    // than sort quietly to the bottom.
    return at === -1 ? -1 : at;
};

/**
 * The one status a session's whole set of pull requests reduces to.
 *
 * `counts` carries what the single word left out, so a tooltip can say "1 draft ·
 * 2 merged" without the caller holding the list. Null for a session with no PRs —
 * which is not the same as a session whose PRs could not be reached, and a row
 * draws nothing at all for the first and a grey glyph for the second.
 *
 * @param {Array<{status: string, label: string|null}>} resolved
 */
function aggregate(resolved) {
    const list = (resolved || []).filter(p => p && p.status);
    if (!list.length) return null;

    const counts = {};
    for (const p of list) counts[p.status] = (counts[p.status] || 0) + 1;

    let worst = list[0];
    for (const p of list) {
        if (attentionRank(p.status) < attentionRank(worst.status)) worst = p;
    }

    return { status: worst.status, label: worst.label || null, total: list.length, counts };
}

// The two callers that slice a batch back into sessions — one session's PRs for
// the conversation header, one word per session for the rail — live in
// `pr-store.js` now, because both of them are questions about the snapshot rather
// than about GitHub.

// ---------------------------------------------------------------------------
// Telling GitHub
// ---------------------------------------------------------------------------
//
// Everything above this line asks; everything below it tells. That is a real
// change to what this module is, and the header says so — but the alternative was
// a second module shelling out to `gh`, which would have to duplicate `run()`,
// `ghError()` and the ENOENT special case to preserve a purity that only ever
// existed in a comment. `bridge/git.js` was assembled out of exactly that
// mistake: two callers asking git the same question a second apart.
//
// So the rule is *one module per external tool*, and the line these functions do
// not cross is policy. They are three dumb verbs. Which label a verdict deserves,
// whether a test schedule may post at all, when to notify and whether to retry
// all live in the caller, because every one of those is a decision about a
// schedule rather than a fact about GitHub.
//
// They keep the file's convention that a failure is an answer: `{ok, error}`,
// never a throw.

/** The three labels a scheduled review can leave behind. */
const VERDICT_LABELS = {
    CLEAN: {
        name: 'review-clean', color: '0e8a16',
        description: 'Automated review found nothing',
    },
    CONCERNS: {
        name: 'review-concerns', color: 'fbca04',
        description: 'Automated review raised warnings',
    },
    BLOCK: {
        name: 'review-blocked', color: 'd93f0b',
        description: 'Automated review found something critical',
    },
};

/** Every verdict label, for working out which ones to take off. */
const ALL_VERDICT_LABELS = Object.values(VERDICT_LABELS).map(l => l.name);

// stderr worth one more go. Deliberately short: a retry is only correct where the
// *request* failed rather than the operation, because posting a review is not
// idempotent — a second attempt after a lost response comments twice.
const TRANSIENT = /timed out|timeout|502|503|504|bad gateway|rate limit|connection reset|EAI_AGAIN/i;

/**
 * Post a review comment on a pull request.
 *
 * `--comment` rather than `--approve`, and that is a constraint rather than a
 * preference: GitHub refuses to let an account approve its own pull request, and
 * on this machine every open PR is authored by the account `gh` is authenticated
 * as. A commenting review is the only kind that lands.
 *
 * The body goes over stdin — see `run`'s `input` for why argv cannot carry it.
 *
 * @returns {Promise<{ok: boolean, error: string|null, retried: boolean}>}
 */
async function comment(repo, number, body) {
    const args = ['pr', 'review', String(number), '--repo', repo,
        '--comment', '--body-file', '-'];
    let r = await run('gh', args, { input: body });
    let retried = false;
    // One retry, and only for something that looks like the network rather than
    // the request. See TRANSIENT.
    if (!r.ok && TRANSIENT.test(r.stderr)) {
        retried = true;
        r = await run('gh', args, { input: body });
    }
    return { ok: r.ok, error: r.ok ? null : ghError(r), retried };
}

/**
 * Create a label, if it is not already there.
 *
 * Deliberately **not** `gh label create --force`. Force rewrites the colour and
 * description of a label that already exists, which for a name we chose is
 * harmless and for one the user happens to have chosen is quietly destructive.
 * An "already exists" failure is the success case here.
 *
 * @returns {Promise<{ok: boolean, error: string|null, created: boolean}>}
 */
async function ensureLabel(repo, { name, color, description }) {
    const r = await run('gh', ['label', 'create', name, '--repo', repo,
        '--color', color, '--description', description]);
    if (r.ok) return { ok: true, error: null, created: true };
    if (/already exists/i.test(r.stderr)) return { ok: true, error: null, created: false };
    return { ok: false, error: ghError(r), created: false };
}

/**
 * Put exactly one verdict label on a PR, and take the other two off.
 *
 * The removal is the part that is easy to leave out and wrong to leave out: a PR
 * that was BLOCK last week and is CLEAN today would otherwise wear both, and a
 * label that contradicts itself is worse than no label at all.
 *
 * `--remove-label` errors on a label that is not present, which is why `present`
 * is a parameter and why `labels` had to join PR_FIELDS — guessing would turn a
 * tidy-up into a failure.
 *
 * Optimistic: it tries the edit first and only creates a label when that fails
 * for the one reason a missing label fails, so the steady state is one call.
 *
 * @param {string[]} present the PR's current label names, from `normalise`
 * @param {string|null} want a verdict — BLOCK, CONCERNS, CLEAN — or null to only
 *   remove whatever is there.
 * @returns {Promise<{ok, error, added: string|null, removed: string[]}>}
 */
async function setVerdictLabel(repo, number, want, present = []) {
    const spec = want ? VERDICT_LABELS[want] : null;
    const add = spec ? spec.name : null;
    const remove = ALL_VERDICT_LABELS.filter(n => n !== add && present.includes(n));

    if (!add && !remove.length) return { ok: true, error: null, added: null, removed: [] };

    const args = ['pr', 'edit', String(number), '--repo', repo];
    if (add) args.push('--add-label', add);
    for (const n of remove) args.push('--remove-label', n);

    let r = await run('gh', args);
    // The one failure worth handling rather than reporting: the label we want
    // does not exist in this repository yet. Create it and try once more.
    if (!r.ok && add && /not found|could not add label|no such label/i.test(r.stderr)) {
        const made = await ensureLabel(repo, spec);
        if (!made.ok) return { ok: false, error: made.error, added: null, removed: [] };
        r = await run('gh', args);
    }
    return {
        ok: r.ok,
        error: r.ok ? null : ghError(r),
        added: r.ok ? add : null,
        removed: r.ok ? remove : [],
    };
}

module.exports = {
    githubRepo, repoOf, openPulls, pullState, resolveStatus, checkSummary,
    resolveBatch, aggregate, ATTENTION_ORDER,
    comment, ensureLabel, setVerdictLabel, VERDICT_LABELS,
};
