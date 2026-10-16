// The code reviews this session ran: a side pane listing them, and a dialog with
// one review's findings.
//
// A review is a run of a skill you named in Settings → Code reviews — the
// bridge finds them in the transcript and parses their findings (see
// bridge/code-reviews.js and GET /api/sessions/:id/reviews in docs/api.md). This
// file only draws what it is told.
//
// The pane is the Changed drawer's twin: the same `.tasks` box, strip and
// header, put in and taken out by slidePane, its open/shut remembered per window.
// The dialog is the plan/question review's shell — same scrim, same motion, same
// close rules (✕, Close or a whole click outside, never Escape; see modalUp) —
// with a Preact body, because its rows carry buttons that must survive a refresh
// landing while you read.
//
// What a finding offers is deliberately small: open its file (the bridge opens
// the file; there is no line-aware open yet), copy `path:line`, and ask *this*
// chat to fix it. #199's Fix this starts a new session on a PR's branch, which
// fits a nightly review nobody is in; these reviews belong to the conversation
// you are looking at, and that conversation is where the fix belongs.
//
// This imports conversation.js and app.js-adjacent modules that import it back.
// Safe for the reason changes.js gives: nothing here reads an imported binding
// at module top level.

import { get, post } from '../api.js';
import { closeModal, dom, openModal, toast } from '../dom.js';
import { isUp } from '../motion.js';
import { html, render } from '../vendor/preact.js';
import { ago, dur } from '../format.js';
import { inline, renderMarkdown } from '../markdown.js';
import { state } from '../state.js';
import { sendMessage, autoGrow } from '../composer/send.js';
import { openSettingsAt } from '../settings/index.js';
import { openContextMenu } from './context-menu.js';
import { renderHeaderActions } from './conversation.js';
import { loadEarlier } from './earlier.js';
import { slidePane, syncPaneInsets } from './layout.js';
import { revealNode } from './turn-rail.js';

// A list fetched this recently is not fetched again just because the pane was
// opened twice. A turn ending, or the transcript growing while the pane is up,
// refetches regardless — see refreshReviews.
const REVIEWS_STALE_MS = 15_000;
// How long a burst of transcript appends is gathered before the pane asks again.
// The bridge answers an unchanged transcript with one stat, but a streaming turn
// appends several times a second and none of that is a review finishing.
const TAIL_DEBOUNCE_MS = 1500;

const VERDICT_WORD = { BLOCK: 'Blocked', CONCERNS: 'Concerns', CLEAN: 'Clean' };
const SEVERITY_WORD = { critical: 'Critical', warning: 'Warning', note: 'Note' };
const GROUP_WORD = { critical: 'Critical', warning: 'Warnings', note: 'Notes' };
const STATUS_WORD = { running: 'Running', rejected: 'Declined', error: 'Failed', incomplete: 'Did not finish' };

// ── the pane ─────────────────────────────────────────────────────────────

/** Put the pane in the layout, or take it out. Remembered across sessions. */
export function showReviews(on) {
    state.reviews.on = on;
    localStorage.setItem('reviewsOn', on ? '1' : '0');
    if (on) collapseReviews(false, { render: false });
    renderReviews();
    renderHeaderActions();
    if (on) loadReviewsIfStale();
}

/** Collapse it to its strip, or bring it back. */
export function collapseReviews(shut, { render: draw = true } = {}) {
    state.reviews.shut = shut;
    localStorage.setItem('reviewsShut', shut ? '1' : '0');
    if (!draw) return;
    renderReviews();
    syncPaneInsets();
    (shut ? dom.reviewsStrip : dom.reviewsCollapse).focus();
    if (!shut) loadReviewsIfStale();
}

const paneUp = () => !!state.current && state.reviews.on && !state.reviews.shut;

export function loadReviewsIfStale() {
    const s = state.current;
    if (!s || !paneUp()) return;
    const fresh = state.reviews.sessionId === s.sessionId
        && Date.now() - state.reviews.at < REVIEWS_STALE_MS;
    if (!fresh) loadReviews();
}

let tailTimer = null;

/**
 * Something happened that may have started or finished a review: a turn ended,
 * or (`{tail: true}`) the transcript grew. Only while the pane or the dialog is
 * up — nothing else draws this.
 */
export function refreshReviews({ tail = false } = {}) {
    if (!state.current) return;
    const dialog = isUp(dom.creviewScrim);
    if (!paneUp() && !dialog) return;
    if (!tail) { loadReviews(); return; }
    clearTimeout(tailTimer);
    tailTimer = setTimeout(() => { tailTimer = null; loadReviews(); }, TAIL_DEBOUNCE_MS);
}

/** Forget what is on screen — the conversation it was about has changed. */
export function resetReviews() {
    clearTimeout(tailTimer);
    tailTimer = null;
    closeCodeReview();
    state.reviews.data = null;
    state.reviews.sessionId = null;
    state.reviews.at = 0;
    state.reviews.error = null;
}

export async function loadReviews() {
    const s = state.current;
    if (!s || state.reviews.loading) return;
    const id = s.sessionId;
    state.reviews.loading = true;
    state.reviews.error = null;
    renderReviews();
    try {
        const d = await get(`/api/sessions/${id}/reviews`);
        if (!state.current || state.current.sessionId !== id) return;
        state.reviews.data = d;
        state.reviews.sessionId = id;
        state.reviews.at = Date.now();
        // The open dialog's review may have finished, or gained findings.
        const open = state.reviews.openId;
        if (open && isUp(dom.creviewScrim)) {
            const now = (d.reviews || []).find(r => r.id === open);
            const was = state.reviews.detail;
            if (now && was && (now.status !== was.status || now.endedAt !== was.endedAt)) loadDetail(open);
        }
    } catch (err) {
        state.reviews.error = err.message;
    } finally {
        state.reviews.loading = false;
        renderReviews();
    }
}

export function renderReviews() {
    const present = !!state.reviews.on && !!state.current;
    slidePane(dom.reviews, present);
    if (!present) return;

    const d = state.reviews.data;
    const list = (d && d.reviews) || [];
    const label = d ? String(list.length) : (state.reviews.error ? '!' : '…');
    dom.reviewsCount.textContent = label;
    dom.reviewsStripCount.textContent = label;
    dom.reviewsStrip.hidden = !state.reviews.shut;
    dom.reviewsOpen.hidden = state.reviews.shut;
    dom.reviews.classList.toggle('shut', state.reviews.shut);
    dom.reviewsRun.disabled = !d || !(d.types || []).length;
    if (state.reviews.shut) return;
    render(reviewsList(d, list), dom.reviewsBody);
}

function reviewsList(d, list) {
    if (state.reviews.error && !d) {
        return html`<p class="crv-empty">Could not read the reviews: ${state.reviews.error}</p>`;
    }
    if (!d) return html`<p class="crv-empty">Reading the transcript…</p>`;
    if (!list.length) {
        const names = (d.types || []).map(t => t.label).join(', ');
        return html`<div class="crv-empty">
            <p>No code reviews in this chat yet.</p>
            <p class="crv-empty-sub">${names ? `Counting runs of ${names}.` : 'No skills are set up as reviews.'}${' '}
                <button type="button" class="crv-link" onClick=${() => openSettingsAt('reviews')}>Choose which</button></p>
        </div>`;
    }
    // Newest first: the one you just ran is the one you came for.
    return html`<ol class="crv-list">${[...list].reverse().map(reviewRow)}</ol>`;
}

/** "3h ago", "just now", or "on Sep 29". */
function when(ts) {
    const a = ago(ts);
    if (!a) return '';
    if (a === 'now') return 'just now';
    return /\d[mhd]$/.test(a) ? `${a} ago` : `on ${a}`;
}

/** What a review was of, in a few words. */
export function targetLabel(t) {
    if (!t) return 'the current diff';
    if (t.pr) return `PR #${t.pr}`;
    if (t.range) return t.range;
    if (t.files && t.files.length) return t.files.length === 1 ? t.files[0] : `${t.files.length} files`;
    // `low`, `high --comment`: an effort and flags are how, not what.
    const what = t.text ? t.text.replace(/(?:^|\s)(?:low|medium|high|xhigh|max|--?[\w-]+)(?=\s|$)/gi, ' ').trim() : '';
    if (what) return what.length > 48 ? `${what.slice(0, 47)}…` : what;
    return 'the current diff';
}

function counts(c) {
    return ['critical', 'warning', 'note'].filter(k => c && c[k])
        .map(k => html`<span key=${k} class="crv-count" data-severity=${k}
            title=${`${c[k]} ${c[k] === 1 ? SEVERITY_WORD[k].toLowerCase() : GROUP_WORD[k].toLowerCase()}`}>${c[k]}</span>`);
}

function reviewRow(r) {
    const length = r.startedAt && r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : null;
    const status = STATUS_WORD[r.status];
    const total = r.counts ? r.counts.critical + r.counts.warning + r.counts.note : 0;
    return html`<li key=${r.id} class="crv-row" data-status=${r.status}>
        <button type="button" class="crv-open" onClick=${() => openCodeReview(r.id)}
            title="Read this review's findings">
            <span class="crv-line">
                <span class="crv-type" data-colour=${r.type.colour}>${r.type.label}</span>
                <span class="crv-target">${targetLabel(r.target)}</span>
            </span>
            <span class="crv-line crv-meta">
                ${status ? html`<span class="crv-status">${status}</span>`
                    : r.verdict ? html`<span class="crv-verdict" data-verdict=${r.verdict}>${VERDICT_WORD[r.verdict]}</span>`
                    : null}
                ${counts(r.counts)}
                ${r.status === 'done' && !total && !r.verdict && r.findingSource === 'none'
                    ? html`<span class="crv-plain">Not itemised</span>` : null}
                <span class="crv-when" title=${r.startedAt ? new Date(r.startedAt).toLocaleString() : ''}>${
                    [when(r.startedAt), length && length > 0 ? dur(length) : null].filter(Boolean).join(' · ')}</span>
            </span>
        </button>
        <button type="button" class="crv-jump" aria-label="Show it in the transcript"
            title="Show it in the transcript" onClick=${() => jumpToReview(r.anchor)}>↗</button>
    </li>`;
}

// Claude Code's own reviewers, which a session's command list does not always name.
const BUILT_IN = new Set(['code-review', 'security-review', 'review']);

/**
 * The menu under Run: one entry per review type, each putting `/skill ` in the
 * box. A type can name a subagent (`feature-dev:code-reviewer`) rather than a
 * command, and typing that as `/…` would do nothing — so the session's command
 * list is asked, and a type it does not have is offered greyed with the reason.
 */
export async function openRunMenu(ev) {
    const types = (state.reviews.data && state.reviews.data.types) || [];
    if (!types.length || !state.current) return;
    const at = { clientX: ev.clientX, clientY: ev.clientY, currentTarget: ev.currentTarget };
    let known = null;
    try {
        const r = await get(`/api/slash-commands?session=${encodeURIComponent(state.current.sessionId)}`);
        if (r.commands && r.commands.length) known = new Set(r.commands.map(c => c.name.toLowerCase()));
    } catch { /* offer them all */ }
    openContextMenu(at, types.map((t) => {
        const name = t.skill.toLowerCase();
        const has = !known || known.has(name) || BUILT_IN.has(name);
        return {
            label: `${t.label} — /${t.skill}`,
            disabled: has ? false : `This session has no /${t.skill} command — it may be a subagent type, which runs only when Claude starts it.`,
            // Into the box rather than sent: most reviews take an argument — a PR
            // number, an effort — and this is where you add it.
            onClick: () => prefill(`/${t.skill} `),
        };
    }));
}

function prefill(text) {
    dom.input.value = text;
    dom.input.focus();
    dom.input.setSelectionRange(text.length, text.length);
    dom.input.dispatchEvent(new Event('input', { bubbles: true }));
    autoGrow();
}

/**
 * Put a review's start on screen. The row may be above the loaded part of the
 * log: then the stretch from the turn it sits in is loaded first, which is the
 * only kind of offset the range route accepts.
 */
export async function jumpToReview(anchor) {
    if (!anchor) return;
    const find = () => (anchor.kind === 'tool' ? state.tools.get(anchor.id) : state.nodes.get(anchor.id)) || null;
    let hit = find();
    if (!hit && state.windowStart && anchor.offset < state.windowStart) {
        const turn = (state.turnIndex || []).filter(m => m.kind === 'turn' && m.offset <= anchor.offset).pop();
        await loadEarlier({ through: { offset: turn ? turn.offset : 0 } });
        hit = find();
    }
    if (hit && hit.node) revealNode(hit.node);
    else toast('That review is not in the loaded transcript.', 'warn');
}

// ── the dialog ───────────────────────────────────────────────────────────

export function openCodeReview(id) {
    state.reviews.openId = id;
    state.reviews.detail = null;
    state.reviews.detailError = null;
    paintCodeReview();
    if (!isUp(dom.creviewScrim)) {
        openModal(dom.creviewScrim);
        dom.creviewModal.focus();
    }
    loadDetail(id);
}

export function closeCodeReview() {
    if (!isUp(dom.creviewScrim)) { state.reviews.openId = null; return; }
    closeModal(dom.creviewScrim);
    state.reviews.openId = null;
    state.reviews.detail = null;
}

async function loadDetail(id) {
    const s = state.current;
    if (!s) return;
    try {
        const d = await get(`/api/sessions/${s.sessionId}/reviews/${encodeURIComponent(id)}`);
        if (state.reviews.openId !== id || !state.current || state.current.sessionId !== s.sessionId) return;
        state.reviews.detail = d.review;
    } catch (err) {
        if (state.reviews.openId !== id) return;
        state.reviews.detailError = err.message;
    }
    paintCodeReview();
}

function summaryOf(id) {
    return state.reviews.detail
        || ((state.reviews.data && state.reviews.data.reviews) || []).find(r => r.id === id) || null;
}

function paintCodeReview() {
    const id = state.reviews.openId;
    const r = summaryOf(id);
    dom.creviewKind.textContent = r ? r.type.label : 'Review';
    dom.creviewKind.dataset.colour = r ? r.type.colour : '';
    dom.creviewTitle.textContent = r ? (r.title || targetLabel(r.target)) : '';
    dom.creviewWhen.textContent = r && r.startedAt ? when(r.startedAt) : '';
    dom.creviewWhen.title = r && r.startedAt ? new Date(r.startedAt).toLocaleString() : '';
    const full = state.reviews.detail;
    dom.creviewFixall.hidden = !(full && full.findings.length);
    render(dialogBody(r, full), dom.creviewBody);
}

function dialogBody(r, full) {
    if (state.reviews.detailError) {
        return html`<p class="crv-empty">Could not read this review: ${state.reviews.detailError}</p>`;
    }
    if (!full) return html`<p class="crv-empty">Reading the review…</p>`;
    const groups = ['critical', 'warning', 'note']
        .map(sev => ({ sev, items: full.findings.map((f, i) => ({ f, i })).filter(x => x.f.severity === sev) }))
        .filter(g => g.items.length);
    const status = STATUS_WORD[full.status];
    return html`<div class="crv-detail">
        <div class="crv-summary">
            ${full.verdict ? html`<span class="crv-verdict" data-verdict=${full.verdict}>${VERDICT_WORD[full.verdict]}</span>` : null}
            ${status ? html`<span class="crv-status">${status}</span>` : null}
            <span class="crv-of">${[
                // The head shows the target when the review has no title of its own.
                full.title ? `Of ${targetLabel(full.target)}` : null,
                full.target && full.target.effort ? `${full.target.effort} effort` : null,
                full.findings.length ? `${full.findings.length} ${full.findings.length === 1 ? 'finding' : 'findings'}` : null,
                full.endedAt && full.startedAt ? `took ${dur(Date.parse(full.endedAt) - Date.parse(full.startedAt))}` : null,
            ].filter(Boolean).join(' · ')}</span>
        </div>
        ${full.findingSource === 'none' && full.status !== 'rejected'
            ? html`<p class="crv-note">${full.raw ? 'Couldn’t pick findings out of this review — here it is as written.'
                : full.status === 'running' ? 'Still running.' : 'This review left no text.'}</p>` : null}
        ${groups.map(g => html`<section key=${g.sev} class="crv-group" data-severity=${g.sev}>
            <h3 class="crv-group-head">${GROUP_WORD[g.sev]} <span class="crv-group-count">${g.items.length}</span></h3>
            <ol class="prr-list crv-findings">${g.items.map(({ f, i }) => findingRow(full, f, i))}</ol>
        </section>`)}
        ${full.raw ? html`<details class="crv-raw" open=${full.findingSource === 'none'}>
            <summary>Raw review</summary>
            <div class="prr-raw md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(full.raw) }}></div>
        </details>` : null}
    </div>`;
}

function where(f) {
    if (!f.file) return null;
    return `${f.file}${f.line ? `:${f.line}${f.endLine ? `–${f.endLine}` : ''}` : ''}`;
}

function findingRow(review, f, i) {
    const loc = where(f);
    const tags = [f.category, f.confidence && f.confidence.toLowerCase()].filter(Boolean);
    return html`<li key=${`f${i}`} class="prr-finding crv-finding" data-severity=${f.severity}>
        <details>
            <summary>
                <span class="prr-sev">${SEVERITY_WORD[f.severity] || f.severity}</span>
                <span class="prr-ftitle" dangerouslySetInnerHTML=${{ __html: inline(f.title) }}></span>
                ${tags.length ? html`<span class="crv-tags">${tags.join(' · ')}</span>` : null}
            </summary>
            ${loc ? html`<div class="crv-where">
                <button type="button" class="crv-file" title="Open this file (at its top — the line is not passed on)"
                    onClick=${() => openFile(f.file)}>${loc}</button>
                <button type="button" class="crv-copy" title="Copy path:line" aria-label="Copy path:line"
                    onClick=${() => copy(loc)}>Copy</button>
            </div>` : null}
            <div class="prr-body crv-body md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(f.body || '') }}></div>
        </details>
        <button type="button" class="prr-fix" title="Ask this chat to fix this finding"
            onClick=${() => fixInChat(review, [f])}>Fix in chat</button>
    </li>`;
}

async function openFile(file) {
    if (!state.current) return;
    try {
        const out = await post(`/api/sessions/${state.current.sessionId}/open-file`, { path: file });
        if (out.how === 'reveal') toast('Windows would run that file, so its folder opened instead.', 'warn');
    } catch (err) {
        toast(`Could not open that file: ${err.message}`, 'error');
    }
}

async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast(`Copied ${text}`, 'ok');
    } catch {
        toast('Could not copy that.', 'error');
    }
}

/** The message that asks for findings to be fixed. Exported for the Fix-all button. */
export function fixText(review, findings) {
    const label = review.type ? review.type.label : '';
    const of = !label ? 'the review' : /review$/i.test(label) ? `the ${label}` : `the ${label} review`;
    const item = (f) => {
        const loc = where(f);
        return `**${f.title}**${loc ? ` — \`${loc}\`` : ''}\n\n${(f.body || '').trim()}`;
    };
    if (findings.length === 1) return `Fix this finding from ${of}:\n\n${item(findings[0])}`;
    return `Fix these ${findings.length} findings from ${of}:\n\n`
        + findings.map((f, i) => `${i + 1}. ${item(f).replace(/\n/g, '\n   ')}`).join('\n\n');
}

function fixInChat(review, findings) {
    if (!findings.length) return;
    sendMessage({ text: fixText(review, findings), canned: true });
    closeCodeReview();
}

/** Fix all: every finding in the open review, in one message. */
export function fixAllInChat() {
    const full = state.reviews.detail;
    if (full) fixInChat(full, full.findings);
}

/** Show it in the transcript, from the dialog's foot. */
export function jumpFromCodeReview() {
    const r = summaryOf(state.reviews.openId);
    closeCodeReview();
    if (r) jumpToReview(r.anchor);
}
