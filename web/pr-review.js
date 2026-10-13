// The nightly review of a pull request, inside the app.
//
// A chip beside a PR — verdict and how many findings — and, when it is opened,
// the findings themselves, each with a **Fix this** button and the review with a
// **Fix all**. Drawn on two surfaces: under a row of the dashboard
// (web/boards/dashboard.js) and in a panel under the conversation header
// (web/transcript/conversation.js). The data is GET /api/pr-review and the
// buttons POST /api/pr-review/fix; bridge/pr-reviews.js and
// bridge/routes/pr-reviews.js are the other half.
//
// State stays in `state`, as web/rail.js settled: `state.prReviews` holds what
// each review fetch answered, keyed `owner/name#N`, and a surface re-renders
// itself after a fetch lands by passing its own render function in. Nothing here
// touches DOM that Preact drew.
//
// This imports conversation.js, which imports this — safe for the reason
// dashboard.js gives: nothing reads an imported binding at module top level.

import { html, render } from './vendor/preact.js';
import { get, post } from './api.js';
import { state } from './state.js';
import { toast } from './dom.js';
import { ago } from './format.js';
import { renderMarkdown } from './markdown.js';
import { openSession, openSessionSoon } from './transcript/conversation.js';

const VERDICT_WORD = { BLOCK: 'Blocked', CONCERNS: 'Concerns', CLEAN: 'Clean' };
const SEVERITY_WORD = { critical: 'Critical', warning: 'Warning', note: 'Note' };

export const reviewKey = (repo, number) => `${repo}#${number}`;

/** "3h ago", "now", or "on Sep 29" — `ago()` turns into a date after a week. */
function when(ts) {
    const a = ago(ts);
    if (!a) return '';
    if (a === 'now') return 'just now';
    return /\d[mhd]$/.test(a) ? `${a} ago` : `on ${a}`;
}

/** Forget every fetched review, so the next draw asks again. */
export function forgetReviews() {
    state.prReviews.clear();
}

/** Fetch a review unless it is fetched or on its way; `rerender` when it lands. */
export function ensureReview(repo, number, rerender) {
    const key = reviewKey(repo, number);
    const have = state.prReviews.get(key);
    // Once per key until forgotten: `pending` and an error are both answered by
    // `pr-reviews-changed`, which forgets them — asking again on every draw
    // would be a fetch per render while a transcript is read.
    if (have) return;
    state.prReviews.set(key, { ...(have || {}), loading: true });
    get(`/api/pr-review?repo=${encodeURIComponent(repo)}&number=${number}`)
        .then((r) => {
            state.prReviews.set(key, { review: r.review, pending: r.pending, loading: false, error: null });
            // A transcript still being read answers `pending`; the bridge says
            // `pr-reviews-changed` when it lands, which clears this and asks again.
        })
        .catch((err) => state.prReviews.set(key, { review: null, loading: false, error: err.message }))
        .finally(() => rerender());
}

/** The words a chip's tooltip says about a summary. */
function chipTip(s) {
    return [
        `Nightly review: ${VERDICT_WORD[s.verdict] || 'no verdict'}`,
        s.count ? [
            s.counts.critical && `${s.counts.critical} critical`,
            s.counts.warning && `${s.counts.warning} ${s.counts.warning === 1 ? 'warning' : 'warnings'}`,
            s.counts.note && `${s.counts.note} ${s.counts.note === 1 ? 'note' : 'notes'}`,
        ].filter(Boolean).join(', ') : 'no findings listed',
        s.stale ? 'Reviewed an earlier commit — the branch has moved since.' : null,
        s.at ? `Reviewed ${when(s.at)}${s.source === 'github' ? ', read from the PR comment' : ''}` : null,
        'Click to see the findings.',
    ].filter(Boolean).join('\n');
}

/**
 * The chip: verdict and finding count. `summary` is the `review` field a PR row
 * carries (null draws nothing).
 */
export function reviewChip(summary, { key, open, onToggle, cls = '' }) {
    if (!summary) return null;
    const verdict = summary.verdict || 'NONE';
    const n = summary.counts.critical + summary.counts.warning;
    const label = summary.verdict === 'CLEAN' || !n
        ? (VERDICT_WORD[summary.verdict] || 'Reviewed')
        : `${n} ${n === 1 ? 'finding' : 'findings'}`;
    return html`<button key=${key} type="button" class=${`prr-chip ${cls}${open ? ' on' : ''}`}
        data-verdict=${verdict} data-stale=${summary.stale ? '1' : null}
        aria-expanded=${String(!!open)} title=${chipTip(summary)}
        onClick=${(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
        ><span class="prr-dot" aria-hidden="true"></span>${label}</button>`;
}

async function startFix(pr, cwd, finding, rerender) {
    const key = reviewKey(pr.repo, pr.number);
    const busyKey = `${key}:${finding == null ? 'all' : finding}`;
    if (state.prReviewFixing.has(busyKey)) return;
    state.prReviewFixing.add(busyKey);
    rerender();
    try {
        const r = await post('/api/pr-review/fix', {
            repo: pr.repo, number: pr.number, cwd,
            ...(finding == null ? {} : { finding }),
        });
        toast(r.worktree.created
            ? `Fixing #${pr.number} in a new worktree on ${r.worktree.branch}.`
            : `Fixing #${pr.number} in the worktree on ${r.worktree.branch}.`, 'ok');
        openSessionSoon(r.sessionId);
    } catch (err) {
        const d = err.data || {};
        // A worktree somebody is in: offer to go there instead of piling in.
        if (d.error === 'worktree-in-use' && d.sessionId) {
            toast(d.message, 'warn', { action: { label: 'Open it', onClick: () => openSession(d.sessionId) } });
        } else {
            toast(`Could not start the fix: ${d.message || err.message}`, 'error');
        }
    } finally {
        state.prReviewFixing.delete(busyKey);
        rerender();
    }
}

function findingRow(pr, cwd, f, i, rerender) {
    const busy = state.prReviewFixing.has(`${reviewKey(pr.repo, pr.number)}:${i}`);
    const where = f.file
        ? `${f.file}${f.line ? `:${f.line}${f.endLine ? `–${f.endLine}` : ''}` : ''}`
        : null;
    return html`<li key=${`f${i}`} class="prr-finding" data-severity=${f.severity}>
        <details>
            <summary>
                <span class="prr-sev">${SEVERITY_WORD[f.severity] || f.severity}</span>
                <span class="prr-ftitle">${f.title}</span>
                ${where ? html`<code class="prr-where" title=${where}>${where}</code>` : null}
            </summary>
            <div class="prr-body md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(f.body) }}></div>
        </details>
        <button type="button" class="prr-fix" disabled=${busy}
            title="Start a session on this pull request's branch to fix this finding, then commit and push"
            onClick=${() => startFix(pr, cwd, i, rerender)}>${busy ? 'Starting…' : 'Fix this'}</button>
    </li>`;
}

/**
 * The findings of one PR's review. `pr` is `{repo, number, url}`; `cwd` is a
 * checkout of the repository, which the bridge resolves the PR's worktree from.
 */
export function reviewPanel(pr, cwd, { rerender, onClose = null }) {
    const key = reviewKey(pr.repo, pr.number);
    ensureReview(pr.repo, pr.number, rerender);
    const got = state.prReviews.get(key) || { loading: true };
    const close = onClose
        ? html`<button type="button" class="prr-close" aria-label="Close" onClick=${onClose}>✕</button>`
        : null;

    if (got.error) {
        return html`<div key=${`prr:${key}`} class="prr-panel"><p class="prr-note">${
            `Could not read the review: ${got.error}`}</p>${close}</div>`;
    }
    const r = got.review;
    if (!r) {
        return html`<div key=${`prr:${key}`} class="prr-panel"><p class="prr-note">${
            got.loading || got.pending ? 'Reading the review…' : 'No review of this pull request is known.'
        }</p>${close}</div>`;
    }

    const allBusy = state.prReviewFixing.has(`${key}:all`);
    const serious = r.findings.filter(f => f.severity !== 'note').length;
    const allWhat = !r.findings.length ? 'the whole review'
        : serious ? `the ${serious} critical and warning ${serious === 1 ? 'finding' : 'findings'}`
        : `all ${r.findings.length} notes`;
    return html`<div key=${`prr:${key}`} class="prr-panel" data-verdict=${r.verdict || 'NONE'}>
        <header class="prr-head">
            <span class="prr-verdict">${VERDICT_WORD[r.verdict] || 'Reviewed'}</span>
            <span class="prr-meta">${[
                `#${pr.number}`,
                r.sha ? `at ${r.sha.slice(0, 8)}` : null,
                r.at ? `reviewed ${when(r.at)}` : null,
                r.stale ? 'branch has moved since' : null,
                r.running ? 'a new review is running' : null,
            ].filter(Boolean).join(' · ')}</span>
            <span class="prr-actions">
                ${r.sessionId ? html`<button type="button" class="prr-link"
                    title="Open the session that wrote this review"
                    onClick=${() => openSession(r.sessionId)}>Review session</button>` : null}
                ${pr.url ? html`<a class="prr-link" href=${pr.url} target="_blank" rel="noreferrer">On GitHub</a>` : null}
                <button type="button" class="prr-fix all" disabled=${allBusy}
                    title=${`Start one session on this pull request's branch to fix ${allWhat}, then commit and push`}
                    onClick=${() => startFix(pr, cwd, null, rerender)}>${allBusy ? 'Starting…' : 'Fix all'}</button>
                ${close}
            </span>
        </header>
        ${r.title ? html`<p class="prr-title">${r.title.replace(/`/g, '')}</p>` : null}
        ${r.findings.length
            ? html`<ol class="prr-list">${r.findings.map((f, i) => findingRow(pr, cwd, f, i, rerender))}</ol>`
            : html`<div class="prr-raw md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(r.raw || '') }}></div>`}
    </div>`;
}

// ── the conversation header's panel ─────────────────────────────────────────

let popEl = null;
let popWired = false;
// The header's render function, from the last draw — what Escape (in app.js's
// keydown ladder) calls through closeHeaderReview.
let popRerender = null;

function pop() {
    if (!popEl) popEl = document.getElementById('pr-review-pop');
    return popEl;
}

/** Open or close the header panel for one of the current session's PRs. */
export function toggleHeaderReview(key, rerender) {
    state.prReviewOpen = state.prReviewOpen === key ? null : key;
    rerender();
}

/**
 * Draw the header panel: the review of `state.prReviewOpen`, if it is one of
 * `prs` (the header's own list), else nothing.
 */
export function renderHeaderReview(prs, cwd, rerender) {
    const host = pop();
    if (!host) return;
    const pr = state.prReviewOpen
        ? prs.find(p => p.repo && reviewKey(p.repo, p.number) === state.prReviewOpen)
        : null;
    if (!pr) state.prReviewOpen = null;
    host.hidden = !pr;
    const close = () => { state.prReviewOpen = null; rerender(); };
    render(pr ? reviewPanel(pr, cwd, { rerender, onClose: close }) : null, host);

    popRerender = rerender;
    if (!popWired) {
        popWired = true;
        // Escape is a rung in app.js's keydown ladder rather than a listener here,
        // so that one press closes this and nothing behind it.
        document.addEventListener('mousedown', (e) => {
            if (!state.prReviewOpen) return;
            if (host.contains(e.target) || e.target.closest('.prr-chip')) return;
            closeHeaderReview();
        });
    }
}

/** Close the header panel, if it is open. True when there was one to close. */
export function closeHeaderReview() {
    if (!state.prReviewOpen) return false;
    state.prReviewOpen = null;
    if (popRerender) popRerender();
    return true;
}
