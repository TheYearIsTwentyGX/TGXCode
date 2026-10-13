// The orchestrator's workers view: a board of its workers laid over the
// transcript, opened from the dock (web/orchestrator.js). What the dock lists
// as a line per worker, this draws as a card — what it is doing, what it is
// stopped on, its branch and PR, the last thing it said, and how far along the
// road from spawned to PR it has got — beside the inbox and the usage cutoff.
//
// It covers `#conv-body` and nothing else, so the dock and the composer stay
// under it: the point of looking at the workers is usually to tell the
// orchestrator something about them.
//
// Everything is drawn from `state.orch`, the same payload the dock reads, and
// repainted whenever the dock is; the `orchestrator` event carries a worker's
// state changing as well as its filings, so nothing here polls for that. The
// usage reading is the exception — it is not in the payload, so it is fetched
// from `…/orchestrator/usage` while the view is up, at most every half minute.
// What a card says is worked out in web/orchestrator-model.js, which is pure
// and tested.
//
// An ask is answered from the card through answerAskFor, the live board's way
// of answering for a session that is not on screen: as the user, so the
// orchestrator is told the user got there first, exactly as if the worker's own
// page had been used. A tool prompt gets its three buttons. A plan gets its
// text, folded, and Approve beside it — approving one unread is the thing the
// plan pane exists to prevent, so the button sits under the text, not over it.
// A question opens the worker, where the dock that answers it already is.

import { html, render } from './vendor/preact.js';
import { state } from './state.js';
import { toast } from './dom.js';
import { get } from './api.js';
import { ago, clip } from './format.js';
import { renderMarkdown } from './markdown.js';
import { isUp, present } from './motion.js';
import { answerAskFor } from './transcript/approvals.js';
import { toolSummary } from './transcript/tools.js';
import { clockAt, goTo, inboxList, paintOrchestrator, resume } from './orchestrator.js';
import {
    blockedOn, cutoffLine, inboxCounts, lastReport, workerOrder, workerStateWord, workerTimeline,
} from './orchestrator-model.js';

// Which orchestrators have the view up, per window. Keyed by id so moving to a
// worker and back finds it as it was left.
const openFor = new Set();
// Asks being answered from here: requestId → true, so a card's buttons go quiet
// between the click and the `orchestrator` event that takes the ask away.
const answering = new Set();
// The last usage reading, per orchestrator: {at, windows}.
const usageFor = new Map();
const USAGE_TTL_MS = 30_000;

const STEP_WORD = { spawned: 'Spawned', plan: 'Plan', approved: 'Approved', done: 'Done', pr: 'PR' };
const STEP_STATE = {
    done: '', now: 'in progress', todo: 'not yet', skipped: 'skipped',
    unknown: 'no longer in the inbox',
};
const REPORT_WORD = { update: 'Update', done: 'Done', turn: 'Turn', question: 'Question' };
const ASK_WORD = { tool: 'Permission', plan: 'Plan', question: 'Question' };

let wired = false;
/**
 * The mount point, with Esc wired to it once. On the node itself rather than in
 * the tree: opening the view focuses the node, and a key pressed there never
 * reaches a handler on one of its children.
 */
function node() {
    const n = document.getElementById('orch-view');
    if (n && !wired) {
        wired = true;
        n.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            const p = state.orch;
            if (!p || !openFor.has(p.orchestratorId)) return;
            e.preventDefault();
            e.stopPropagation();
            toggleOrchView(p.orchestratorId, false);
        });
    }
    return n;
}

/** Is the view up for this orchestrator? */
export function orchViewOpen(orchId) {
    return !!orchId && openFor.has(orchId);
}

/**
 * Open or close the view for the orchestrator on screen. Through the dock's
 * paint, which paints this too, so the dock's toggle never disagrees with
 * whether the view is up — closing with Esc or Close included.
 */
export function toggleOrchView(orchId, on = !openFor.has(orchId)) {
    if (on) openFor.add(orchId); else openFor.delete(orchId);
    paintOrchestrator();
    const n = node();
    if (on && n && document.hasFocus()) n.focus({ preventScroll: true });
}

/**
 * Draw the view, or take it down — called from paintOrchestrator, so it moves
 * with the dock: a session change, a payload, the role turned off.
 */
export function paintOrchView() {
    const n = node();
    if (!n) return;
    const s = state.current;
    const p = state.orch;
    const show = !!s && !!p && s.sessionId === p.orchestratorId && openFor.has(p.orchestratorId);
    if (!show) {
        // Emptied once it has gone, unless it was opened again on the way out.
        if (isUp(n)) present(n, false, { as: 'arrive', onGone: () => { if (n.hidden) render(null, n); } });
        return;
    }
    refreshUsage(p.orchestratorId);
    render(view(p), n);
    if (!isUp(n)) present(n, true, { as: 'arrive' });
}

function refreshUsage(id) {
    const had = usageFor.get(id);
    if (had && Date.now() - had.at < USAGE_TTL_MS) return;
    usageFor.set(id, { at: Date.now(), windows: had ? had.windows : null });
    get(`/api/sessions/${id}/orchestrator/usage`)
        .then((u) => {
            usageFor.set(id, { at: Date.now(), windows: u.windows || [] });
            if (state.orch && state.orch.orchestratorId === id) paintOrchView();
        })
        .catch(() => {});
}

function view(p) {
    const workers = workerOrder(p.workers);
    const open = p.workers.filter(w => !w.closedAt);
    const running = open.filter(w => workerStateWord(w) === 'running').length;
    const counts = inboxCounts(p);
    const close = () => toggleOrchView(p.orchestratorId, false);
    return html`<div class="ow">
        <header class="ow-top">
            <h2 class="ow-title">Workers</h2>
            <span class="ow-counts">${`${open.length} open · ${running}/${p.settings.maxRunning} running`
                + `${p.pendingSpawns.length ? ` · ${p.pendingSpawns.length} queued` : ''}`}</span>
            ${cutoff(p)}
            <button class="lbtn" type="button" title="Back to the conversation — Esc" onClick=${close}>
                Close</button>
        </header>
        ${p.paused ? html`<div class="orch-paused ow-paused">
            <span>${`Paused — ${p.paused.reason}.`}${p.paused.resumeAt
                ? html` <span class="orch-wake">${`Carries on by itself at ${clockAt(p.paused.resumeAt)}.`}</span>`
                : null}</span>
            <button type="button" onClick=${resume}>Resume</button>
        </div>` : null}
        <div class="ow-body">
            <section class="ow-grid" aria-label="Workers">
                ${!workers.length && !p.pendingSpawns.length ? html`<div class="orch-empty ow-none">
                    No workers yet. The orchestrator starts them with spawn_worker.</div>` : null}
                ${workers.map(w => card(p, w))}
                ${p.pendingSpawns.map(q => html`<article key=${q.id} class="ow-card ow-queued">
                    <div class="ow-head">
                        <span class="ow-name">${q.title || 'untitled'}</span>
                        <span class="ow-state" data-state="queued">queued</span>
                    </div>
                    <div class="ow-facts">${`Starts when a slot frees · asked ${since(q.at)}`}</div>
                </article>`)}
            </section>
            <aside class="ow-inbox" aria-label="Inbox">
                <div class="ow-inbox-head">
                    <span class="ow-sub">Inbox</span>
                    <span class="orch-count" data-hot=${String(counts.unread > 0)}>${
                        `${counts.unread} unread${counts.waiting ? ` · ${counts.waiting} waiting` : ''}`}</span>
                </div>
                ${inboxList(p)}
            </aside>
        </div>
    </div>`;
}

function cutoff(p) {
    if (p.paused) return null;
    const u = usageFor.get(p.orchestratorId);
    const line = cutoffLine(p.settings.usageStop, u && u.windows);
    return html`<span class="ow-cutoff" data-tone=${line.tone}>${line.text}</span>`;
}

/** A click anywhere on a card that is not one of its controls opens the worker. */
function cardOpens(e, id) {
    if (e.target.closest('button, a, details, summary, input, textarea')) return;
    if (String(window.getSelection() || '')) return;
    goTo(id);
}

function card(p, w) {
    const word = workerStateWord(w);
    const blocked = blockedOn(w, p.inbox);
    const report = lastReport(w, p.inbox);
    return html`<article key=${w.id} class="ow-card" data-state=${word}
        data-blocked=${String(!!blocked)} onClick=${(e) => cardOpens(e, w.id)}>
        <div class="ow-head">
            <button class="ow-name orch-link" type="button" title="Open this worker"
                onClick=${() => goTo(w.id)}>${w.title || 'untitled worker'}</button>
            <span class="ow-state" data-state=${word}>${word}</span>
        </div>
        <div class="ow-facts">
            ${w.worktree && w.worktree.branch
                ? html`<span class="ow-branch" title=${w.worktree.path || ''}>${w.worktree.branch}</span>` : null}
            ${w.pr ? prChip(w.pr) : null}
            <span class="ow-age">${`spawned ${since(w.spawnedAt)}`}</span>
        </div>
        ${blocked ? ask(w, blocked) : null}
        ${report ? html`<div class="ow-report">
            <span class="ow-report-kind">${REPORT_WORD[report.kind] || report.kind}</span>
            <span class="ow-report-text" title=${clip(report.text, 600)}>${clip(firstLine(report.text), 160)}</span>
            <span class="ow-age">${ago(report.at)}</span>
        </div>` : null}
        ${timeline(workerTimeline(w, p.inbox))}
    </article>`;
}

/** "3m ago", or "just now" — `ago` says `now` for the first minute. */
const since = (at) => { const a = ago(at); return a === 'now' ? 'just now' : `${a} ago`; };

const firstLine = (t) => String(t || '').split('\n').find(l => l.trim()) || '';

function prChip(pr) {
    const tip = [`#${pr.number}${pr.title ? ` — ${pr.title}` : ''}`, pr.label || null].filter(Boolean).join('\n');
    return pr.url
        ? html`<a class="ow-pr" data-status=${pr.status || 'unknown'} href=${pr.url} target="_blank"
            rel="noreferrer" title=${tip}>${`#${pr.number}`}${pr.label ? html`<i>${pr.label}</i>` : null}</a>`
        : html`<span class="ow-pr" data-status=${pr.status || 'unknown'} title=${tip}>${`#${pr.number}`}</span>`;
}

function timeline(steps) {
    return html`<ol class="ow-line" aria-label="Progress">
        ${steps.map(st => html`<li key=${st.key} data-state=${st.state}
            title=${[STEP_WORD[st.key], st.at ? since(st.at) : STEP_STATE[st.state]].filter(Boolean).join(' · ')}>
            <span class="ow-dot"></span><span class="ow-step">${STEP_WORD[st.key]}</span>
        </li>`)}
    </ol>`;
}

function ask(w, b) {
    const item = b.item;
    const busy = !!(item && answering.has(item.requestId));
    const send = (payload) => answerFrom(w, item, payload);
    const what = !item ? 'Waiting on you.'
        : b.kind === 'tool' && item.ask
            ? toolSummary({ name: item.ask.tool, input: item.ask.input }) || item.text
            : firstLine(item.text);
    const head = b.kind === 'tool' && item && item.ask ? item.ask.displayName || ASK_WORD.tool : ASK_WORD[b.kind];
    return html`<div class="ow-ask" data-kind=${b.kind} data-pending=${String(busy)}>
        <div class="ow-ask-what"><b>${head}</b><span>${clip(what, 140)}</span></div>
        ${b.kind === 'plan' && item ? html`<details class="ow-plan">
            <summary>Read the plan</summary>
            <div class="ow-plan-doc md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(item.text) }}></div>
            <div class="ow-acts">
                <button class="lbtn ok" type="button" disabled=${busy}
                    title="Approve, and let it work in auto mode — as the orchestrator would"
                    onClick=${() => send({ decision: 'allow', mode: 'auto' })}>Approve</button>
                <button class="lbtn" type="button" onClick=${() => goTo(w.id)}>Reply on its page</button>
            </div>
        </details>` : null}
        ${b.kind === 'tool' && item ? html`<div class="ow-acts">
            <button class="lbtn ok" type="button" disabled=${busy}
                onClick=${() => send({ decision: 'allow' })}>Allow</button>
            <button class="lbtn" type="button" disabled=${busy} title="Allow it for the rest of this session"
                onClick=${() => send({ decision: 'allow-always' })}>Always</button>
            <button class="lbtn no" type="button" disabled=${busy}
                onClick=${() => send({ decision: 'deny' })}>Deny</button>
        </div>` : null}
        ${b.kind === 'question' || !item ? html`<div class="ow-acts">
            <button class="lbtn ok" type="button" onClick=${() => goTo(w.id)}>Answer →</button>
        </div>` : null}
    </div>`;
}

async function answerFrom(w, item, payload) {
    if (!item || answering.has(item.requestId)) return;
    answering.add(item.requestId);
    paintOrchView();
    try {
        await answerAskFor(w.id, item.requestId, payload);
    } catch (err) {
        // 409: answered somewhere else first. The event that follows redraws
        // the card without the ask, so the message is all that is needed.
        toast(`Could not answer: ${err.message}`, 'error');
    } finally {
        answering.delete(item.requestId);
        paintOrchView();
    }
}
