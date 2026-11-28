'use strict';

// Codex's own reviewer, as the pull-request gate's review path for a schedule
// that runs on Codex (docs/plans/23-codex.md, Phase 4, *As built — the PR gate on
// Codex*).
//
// The gate needs three things from a review: that it is of exactly the pull
// request's range, a verdict it can label the PR with, and text it can post. A
// Claude gate gets the verdict by asking its reviewer to end on a `VERDICT:` line
// (bridge/schedule.js `verdictOf`). Codex has a review mode instead —
// `review/start` — whose findings come tagged by priority, `[P0]` to `[P3]`, and
// which writes no verdict of its own. So:
//
//   - **The range is ours, given as `custom` instructions.** `baseBranch` reviews
//     the checkout's HEAD against a merge base, so every open PR would have to be
//     checked out first. bridge/pr-gate.js `prRange` has already resolved
//     `mergeBase..head` and fetched a fork's head, so the instructions name those
//     two commits and how to read a file at the head without a checkout — what a
//     Claude gate's prompt does too. Measured on 0.172.0: a `custom` target
//     entered review mode (`enteredReviewMode`, `exitedReviewMode {review}`) and
//     came back with `[P1]` findings, exactly as `baseBranch` had.
//   - **The verdict is read off the priorities.** Any P0 or P1 blocks; any P2 is a
//     concern; P3 alone, or nothing, is clean. Codex calls P3 a nit.
//   - **The text is the review plus a `VERDICT:` line**, appended by the adapter
//     at the end of the turn (`withVerdict`). So `verdictOf`, the schedule card,
//     the posted comment and the label all read it unchanged, and the line says
//     what it was read from, since Codex did not write it.
//
// The wire carries the review as text only (`exitedReviewMode {review}`), so the
// live verdict is read off the tags in it. The rollout keeps more: its
// `ExitedReviewMode` item has `review_output {findings[{title, body, priority,
// confidence_score, code_location}], overall_correctness, …}` (measured on
// 0.172.0), so a review read back from disk after its process is gone takes its
// verdict from the integers (`verdictOfOutput`, bridge/pr-reviews.js).

// `- [P1] Restore addition in `add` — path:2-2`, the shape Codex renders a
// finding in. The bullet is optional; the tag at the start of the line is not.
const FINDING_RE = /^[ \t]*(?:[-*][ \t]+)?\[P([0-3])\][ \t]*(.+)$/gm;

/** `[{priority, title}]`, every finding in a review's text, in order. */
function findingsOf(text) {
    const out = [];
    for (const m of String(text || '').matchAll(FINDING_RE)) {
        out.push({ priority: Number(m[1]), title: m[2].trim() });
    }
    return out;
}

/** `{0: n, 1: n, 2: n, 3: n}` for a review's findings. */
function countsOf(findings) {
    const c = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const f of findings) c[f.priority]++;
    return c;
}

/**
 * The gate's verdict for a Codex review: `BLOCK` for any P0 or P1, `CONCERNS`
 * for any P2, `CLEAN` otherwise — nits alone, or nothing found. Null for text
 * that is not a review (empty), so a failed turn is not called clean.
 */
function reviewVerdict(text) {
    if (!String(text || '').trim()) return null;
    const c = countsOf(findingsOf(text));
    if (c[0] || c[1]) return 'BLOCK';
    if (c[2]) return 'CONCERNS';
    return 'CLEAN';
}

/** The same rule over the rollout's structured `review_output`, or null without one. */
function verdictOfOutput(out) {
    if (!out || !Array.isArray(out.findings)) return null;
    const ps = out.findings.map(f => Number(f && f.priority)).filter(Number.isFinite);
    if (ps.some(p => p <= 1)) return 'BLOCK';
    if (ps.some(p => p === 2)) return 'CONCERNS';
    return 'CLEAN';
}

const VERDICT_LINE_RE = /^[ \t]*(?:[#>*-]+[ \t]*)?(?:\*\*)?VERDICT(?:\*\*)?[ \t]*:?[ \t]*(?:\*\*)?[ \t]*(BLOCK|CONCERNS|CLEAN)\b/im;

/**
 * The review as the gate posts it: Codex's text, then the verdict line the gate
 * reads, saying it was mapped from the priorities. A review that already ends on
 * a verdict (the schedule's own prompt asked for one) is left as it is.
 * `output` is the rollout's `review_output` when there is one; its integers win
 * over the tags in the text.
 */
function withVerdict(text, output = null) {
    const body = String(text || '').trimEnd();
    if (!body) return body;
    if (VERDICT_LINE_RE.test(body)) return body;
    const c = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const structured = output && Array.isArray(output.findings) ? output.findings : null;
    if (structured) for (const f of structured) { if (Number(f && f.priority) in c) c[Number(f.priority)]++; }
    else Object.assign(c, countsOf(findingsOf(body)));
    const verdict = structured ? verdictOfOutput(output) : reviewVerdict(body);
    const said = [0, 1, 2, 3].filter(p => c[p]).map(p => `${c[p]} × P${p}`);
    return `${body}\n\nVERDICT: ${verdict} — mapped by TGXCode from Codex's priorities `
        + `(${said.length ? said.join(', ') : 'no findings'}; P0/P1 block, P2 is a concern).`;
}

/**
 * The `custom` target's instructions for one pull request: the range the gate
 * resolved, how to see it without a checkout, and the schedule's own prompt as
 * further guidance. `facts` is what bridge/scheduler.js fills a prompt from:
 * `{head, since, count, pr: {number, title, branch, base, url, repo}}`.
 */
function reviewInstructions(facts, prompt = '') {
    const pr = (facts && facts.pr) || {};
    const head = String((facts && facts.head) || '');
    const since = String((facts && facts.since) || '');
    const range = since ? `${since}..${head}` : `${head}~1..${head}`;
    const title = pr.title ? ` ("${String(pr.title).replace(/"/g, "'")}")` : '';
    const branches = pr.branch && pr.base ? `, branch ${pr.branch} into ${pr.base}` : '';
    const lines = [
        `Review pull request #${pr.number}${title}${branches}: the commits ${range}`
            + `${facts && Number.isFinite(facts.count) ? ` (${facts.count} commit${facts.count === 1 ? '' : 's'})` : ''}.`,
        `Run \`git diff ${since || `${head}~1`} ${head}\` to see the change. The working tree is not the pull`
            + ` request's head, so read a file as the pull request has it with \`git show ${head}:<path>\`.`,
        'Review only this change. Do not edit files, commit, push or post anything.',
    ];
    const extra = String(prompt || '').trim();
    if (extra) lines.push('', 'The schedule that asked for this review also says:', '', extra);
    return lines.join('\n');
}

module.exports = { findingsOf, reviewVerdict, verdictOfOutput, withVerdict, reviewInstructions, FINDING_RE };
