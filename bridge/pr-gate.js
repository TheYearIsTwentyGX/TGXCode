'use strict';

// The pull-request gate's side of a schedule: which open pull requests a
// schedule still owes a review, what range each one is, how much of a sweep may
// start at once, and putting the finished review back on the pull request.
//
// Split from bridge/scheduler.js because this is the file that writes to
// GitHub, and it carries the one rule in the feature that must never be relaxed:
//
//   **A schedule marked `test` never posts.** `gh` is authenticated as the
//   user on every bridge, dev ones included, and TGXCODE_SCHEDULE_ON_DEV exists
//   so a development bridge can fire test schedules — so the `if (row.test ||
//   … row.gate.post === false)` in `postReviewToPr` is the only thing between
//   testing this feature and commenting on, and relabelling, the user's real
//   pull requests. `gate.post: false` is the same switch for an ordinary
//   schedule that wants the reviews without the noise. Keep them in that one
//   `if`, and keep it ahead of every `pulls.*` call in the function.
//
// Everything else that touches GitHub for a schedule is a *read* (`pulls.repoOf`,
// the pr-store's lists, `git fetch`), and a read changes nothing there.
//
// **Why `init`.** The store and the runner pool are server.js's instances, and
// the two functions this files and broadcasts through — `fileScheduleNote`,
// `schedulesPayload` — are scheduler.js's. scheduler.js requires this file, so
// requiring it back would be a cycle; `scheduler.init` hands them over instead.

const git = require('./git');
const pulls = require('./pulls');
const prStore = require('./pr-store');
const { reviewKey, unreviewedPulls, scheduleTitle } = require('./schedule');
const { broadcast } = require('./events');

// Handed over by scheduler.js; see the header.
let schedules = null;
let pool = null;
let fileScheduleNote = null;
let schedulesPayload = null;

function init(deps) {
    ({ schedules, pool, fileScheduleNote, schedulesPayload } = deps);
}

// ── the pull-request gate ────────────────────────────────────────────────

// How long a slot's review window stays open. A slot does not do all the work
// for a PR gate — twenty concurrent `claude` processes is not a thing to do to a
// laptop at 2 AM, and the create limit would refuse most of them — so it opens a
// window and the batch drains across the ticks that follow. Thirty minutes drains
// far more than any real repository has open, and closes long before the next
// night's slot could collide with it.
const SWEEP_MS = 30 * 60_000;

// Starts per tick, per schedule. The tick is 30s, so two is four a minute —
// comfortably under the create limit even before the reserve below.
const REVIEWS_PER_TICK = 2;

// Concurrent review sessions. Chosen against `MAX_LIVE = 4` in the runner pool
// and the fact that `_evictTo` refuses to evict a *busy* runner: without this cap
// the pool does not bound the fan-out at all, it just quietly grows to one
// `claude` per open pull request. Three leaves the fourth slot for the person
// using the app.
const REVIEWS_IN_FLIGHT = 3;

// Creates a minute kept back for the user. `CREATE_LIMIT` is global, so a sweep
// that spent the whole budget would 429 somebody's own next Start button from a
// limit they never touched.
const CREATE_RESERVE = 2;

/**
 * Pull requests whose range would not resolve, for the sweep they failed in.
 *
 * These are deliberately left *unmarked* in `reviewed` so that the next slot tries
 * them again — a review of the wrong range is worse than a missing one, so a base
 * branch that has been deleted must not be papered over. But "still due" means the
 * drain pass finds it again thirty seconds later, and the first version filed a
 * loud notification each time: about sixty per sweep, per broken pull request,
 * followed by a `sweep-expired` because it never got anywhere.
 *
 * So the failure is remembered for the life of the sweep. Keyed by head SHA as
 * well, so a push that might have fixed it is tried immediately rather than
 * waiting. Cleared when the window closes.
 * @type {Map<string, Set<string>>} scheduleId -> `${key}@${headSha}`
 */
const rangeFailures = new Map();

function noteRangeFailure(scheduleId, key, headSha) {
    if (!rangeFailures.has(scheduleId)) rangeFailures.set(scheduleId, new Set());
    rangeFailures.get(scheduleId).add(`${key}@${headSha}`);
}

const sawRangeFailure = (scheduleId, key, headSha) => Boolean(
    rangeFailures.get(scheduleId)?.has(`${key}@${headSha}`));

// An in-flight review with no outcome that is older than this is not in flight
// any more — its process died with a bridge, or its turn was lost. Without a
// backstop one lost turn would hold a slot in REVIEWS_IN_FLIGHT forever and wedge
// the batch.
const REVIEW_STALE_MS = 2 * 60 * 60_000;

/**
 * The open pull requests a schedule still owes a review, and the repo they are in.
 *
 * @returns {Promise<{ok: boolean, repo: string|null, error: string|null,
 *   pulls: object[], due: object[], openNumbers: number[]}>}
 */
async function pullsForSchedule(row) {
    const repo = await pulls.repoOf(row.cwd);
    if (!repo) {
        return { ok: false, repo: null, pulls: [], due: [], openNumbers: [],
            error: `${row.cwd} has no GitHub origin` };
    }
    // From the store, which may never have been asked about this repository —
    // a schedule can name a checkout no session has a PR in. Ask now if so; a
    // schedule tick is a background pass itself and can afford to wait.
    let list = prStore.openPulls(repo);
    if (!list.checkedAt) {
        await prStore.refreshRepo(repo);
        list = prStore.openPulls(repo);
    }
    if (!list.ok) {
        // **Not a prune, and not an empty batch.** Treating this as "no PRs are
        // open" would look exactly like "everything is reviewed" — and pruning
        // against it would empty the reviewed map and buy a fresh review of the
        // whole repository. The store keeps the last good list beside the error
        // for exactly this reason, but the answer is still "do not act on it".
        return { ok: false, repo, pulls: [], due: [], openNumbers: [],
            error: list.error || `cannot list pull requests for ${repo}` };
    }
    const due = unreviewedPulls(list.pulls, row.reviewed, {
        includeDrafts: row.gate.includeDrafts,
    });
    return {
        ok: true, repo, error: null,
        pulls: list.pulls,
        due,
        openNumbers: list.pulls.map(p => p.number),
    };
}

/** How many of this schedule's reviews are still running. */
function reviewsInFlight(row) {
    const now = Date.now();
    let n = 0;
    for (const entry of Object.values(row.reviewed || {})) {
        if (!entry.sessionId || entry.outcome) continue;
        // A lost turn stops counting, or it would hold a slot forever.
        if (now - (entry.at || 0) > REVIEW_STALE_MS) continue;
        const runner = pool.get(entry.sessionId);
        if (runner && runner.state === 'busy') n++;
    }
    return n;
}

/**
 * Work out the diff range for one pull request.
 *
 * **A merge base, and two dots.** Not `origin/<base>..<head>`, which against the
 * *tip* of base includes whatever other people landed on base since this branch
 * diverged — so the review would contain changes the PR did not make. And not
 * three dots either: `A...B` is the right thing for `git diff` and is what
 * GitHub's Files-changed tab shows, but for `git log` the same spelling means the
 * symmetric difference, which is wrong and wrong silently. The prompt is prose and
 * the session may reach for either command, so the range has to mean one thing to
 * both. `mergeBase..head` does.
 *
 * @returns {Promise<{ok: true, range: string, since: string, count: number|null}
 *   | {ok: false, error: string}>}
 */
async function prRange(cwd, pr) {
    // The head has to be reachable locally. `git fetch origin` at the top of the
    // sweep brings down every branch on the remote, which covers every same-repo
    // PR; a fork's head is not there and needs its own ref.
    let have = await git.run('git', ['-C', cwd, 'cat-file', '-e', `${pr.headSha}^{commit}`]);
    if (!have.ok) {
        // Named rather than left in FETCH_HEAD, so the SHA keeps a name that
        // survives the next fetch.
        await git.run('git', ['-C', cwd, 'fetch', '--quiet', '--no-tags', 'origin',
            `pull/${pr.number}/head:refs/tgxcode/pr/${pr.number}`],
            { timeout: 60_000 });
        have = await git.run('git', ['-C', cwd, 'cat-file', '-e', `${pr.headSha}^{commit}`]);
        if (!have.ok) {
            return { ok: false, error: `cannot reach ${pr.headSha.slice(0, 12)} in ${cwd}` };
        }
    }

    const mb = await git.run('git', ['-C', cwd, 'merge-base',
        `origin/${pr.base}`, pr.headSha]);
    if (!mb.ok) {
        // A base branch that merged and was deleted while the PR stayed open.
        // Deliberately **no fallback to `head~1..head`**: a review of the wrong
        // range is worse than a missing one, and the PR is left unreviewed so it
        // comes back rather than being marked done against a guess.
        return { ok: false, error: `cannot resolve origin/${pr.base} in ${cwd}` };
    }
    const since = mb.stdout.trim();
    const range = `${since.slice(0, 12)}..${pr.headSha.slice(0, 12)}`;

    const counted = await git.run('git', ['-C', cwd, 'rev-list', '--count',
        `${since}..${pr.headSha}`]);
    const count = counted.ok ? Number(counted.stdout.trim()) : null;
    return { ok: true, range, since, count: Number.isFinite(count) ? count : null };
}

/**
 * Put the finished review on the pull request.
 *
 * The governing rule: **the review is the artefact and this is delivery.** It has
 * already been written to a transcript that is not going anywhere, so nothing here
 * ever unwinds the reviewed entry — re-running a whole review session to retry a
 * *post* would spend minutes of somebody's quota re-deriving text that already
 * exists. A failed post is recorded and said out loud instead.
 *
 * A comment is posted whatever the verdict, including CLEAN: on a pull request,
 * "somebody looked at this and found nothing" is information, unlike in a
 * notification where it is noise.
 */
async function postReviewToPr(row, target, { sessionId, verdict, outcome, body }) {
    const key = reviewKey(target.repo, target.number);
    const bad = outcome === 'error' || verdict === 'BLOCK' || verdict === 'CONCERNS';

    // **A test schedule does not touch GitHub.** `SCHEDULE_ON_DEV` exists so a
    // development bridge fires test schedules, and `gh` is authenticated as the
    // same person either way — so without this line, testing this feature comments
    // on the user's real pull requests. `gate.post` is the same switch for an
    // ordinary schedule that wants the reviews without the noise.
    // Null-safe: the gate can be cleared while a review is in flight, and this
    // path runs minutes after it started. Treating an absent gate as "do not post"
    // is the safe reading — a schedule that is no longer a PR schedule has not
    // asked for a comment.
    if (row.test || !row.gate || row.gate.kind !== 'open-prs' || row.gate.post === false) {
        schedules.noteReview(row.id, key, { posted: 'skipped-test' });
        console.log(`[tgxcode] not posting #${target.number} (`
            + `${row.test ? 'test schedule' : 'posting is off'}); `
            + `verdict ${verdict || outcome}`);
        broadcast('schedules-changed', schedulesPayload());
        // **Still notify.** Not posting is about not writing to somebody else's
        // repository; it is not about keeping the finding from *you*. Returning
        // early here meant a BLOCK on a schedule with posting switched off told
        // nobody anything — the one configuration where the notification is the
        // only way you would ever hear about it.
        if (bad) {
            fileScheduleNote(row, {
                sessionId,
                type: 'schedule-findings',
                summary: `#${target.number} came back ${verdict || outcome}`,
                detail: `"${scheduleTitle(row)}" reviewed #${target.number} and did not `
                    + 'post, because posting is switched off for this schedule.',
                loud: true,
            });
        }
        return;
    }

    let postError = null;
    let commentOk = false;
    if (body) {
        const wrapped = wrapReviewBody(target, body);
        const posted = await pulls.comment(target.repo, target.number, wrapped);
        commentOk = posted.ok;
        if (!posted.ok) postError = posted.error;
    } else {
        postError = 'the review produced no text to post';
    }

    // The label is decoration, so its failure rides along in `postError` for the
    // log and never raises anything of its own — a toast about a label is exactly
    // the kind that teaches you to ignore the ones that matter.
    if (verdict) {
        // The current labels have to be *known*, not assumed. Passing an empty
        // list when the re-list failed would make `setVerdictLabel`'s remove set
        // empty, so a pull request that was BLOCK last week and is CLEAN today
        // would end up wearing both — a contradiction is worse than a missing
        // label, so a list we could not read means the label is left alone.
        // One repository, not every repository. This used to be
        // `pulls.clearCache()`, which emptied every open list the process held to
        // get one of them re-read — the whole board paid for a label on one PR.
        await prStore.refreshRepo(target.repo);
        const fresh = prStore.openPulls(target.repo);
        const pr = fresh.ok
            ? fresh.pulls.find(x => x.number === target.number) : null;
        if (!pr) {
            const why = fresh.ok
                ? `#${target.number} is no longer open`
                : (fresh.error || 'could not list pull requests');
            console.error(`[tgxcode] not labelling #${target.number}: ${why}`);
            if (!postError) postError = `label: ${why}`;
        } else {
            const labelled = await pulls.setVerdictLabel(
                target.repo, target.number, verdict, pr.labels);
            if (!labelled.ok) {
                console.error(`[tgxcode] could not label #${target.number}: `
                    + labelled.error);
                if (!postError) postError = `label: ${labelled.error}`;
            }
        }
    }

    // `posted` tracks the *comment* only. A label that would not go on is noted in
    // `postError` but does not make the delivery a failure — the findings landed,
    // which is the part anybody needs.
    schedules.noteReview(row.id, key, {
        posted: commentOk ? 'ok' : 'failed',
        postError,
    });
    broadcast('schedules-changed', schedulesPayload());

    // Loud when there is something to act on. A comment that would not post is one
    // of those: the review exists and nobody would otherwise know where.
    if (!bad && commentOk) return;
    fileScheduleNote(row, {
        sessionId,
        type: postError ? 'schedule-failed' : 'schedule-findings',
        summary: postError
            ? `#${target.number} was reviewed but the comment did not post`
            : `#${target.number} came back ${verdict || outcome}`,
        detail: postError
            ? `"${scheduleTitle(row)}" reviewed #${target.number} and could not post it: `
                + `${postError}. The review is in the session transcript.`
            : null,
        loud: true,
    });
}

/**
 * The comment as it appears on the pull request.
 *
 * Wrapped rather than posted raw so that a re-review at a new head SHA is legible
 * in the timeline: three bare reports in a row say nothing about which commit each
 * was looking at.
 */
function wrapReviewBody(target, body) {
    const head = String(target.headSha || '').slice(0, 12);
    // 60_000 is `lastResultBody`'s cap, so a body at exactly that length is one
    // the runner cut rather than one that happened to end there.
    const clipped = body.length >= 60_000;
    // Built by concatenation rather than `[...].filter(Boolean).join()`, which is
    // how the blank line after the header got eaten: an empty string is falsy, so
    // the separator was filtered out along with the optional footer — and without
    // it GitHub renders the review's first paragraph *inside* the blockquote, so
    // the opening sentence reads as part of the machine header.
    let out = `> Automated review of \`${head}\`.\n\n${body}`;
    if (clipped) out += '\n\n_Truncated — the full review is in the session transcript._';
    return out;
}

module.exports = {
    init,
    SWEEP_MS, REVIEWS_PER_TICK, REVIEWS_IN_FLIGHT, CREATE_RESERVE, REVIEW_STALE_MS,
    rangeFailures, noteRangeFailure, sawRangeFailure,
    pullsForSchedule, reviewsInFlight, prRange,
    postReviewToPr, wrapReviewBody,
};
