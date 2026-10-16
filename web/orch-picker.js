// Send to an orchestrator: the picker, and the one call behind it.
//
// Three places offer it — a card on the Drafts board, the draft editor and the
// Start-a-session dialog — and all three end in the same place: a `task` item in
// the chosen orchestrator's inbox, filed by
// `POST /api/sessions/:id/orchestrator/tasks`. The orchestrator is woken the way
// any inbox item wakes it, and decides how the work fits its plan; nothing is
// started from here. So this module is a list to choose from and a toast, and
// nothing that has to agree with the bridge about what a task is.
//
// **The list is the bridge's, in the bridge's order** (`GET /api/orchestrators`):
// live ones first, then by newest activity, with archived, test and /tmp ones
// already left out. Asked afresh on every open, because what makes a row worth
// choosing — running, queued, paused — is exactly what moves while the dialog
// is shut.
//
// **It is also the only answer to "is there an orchestrator to send to".** The
// Ctrl+K row asks `knownOrchestrators()`, the last answer from that same route,
// rather than looking for one in the session list: the two lists filter
// differently, and a row that offered a picker which then said "No
// orchestrators yet" was what that disagreement looked like.
//
// **It does not answer Escape**, like every dialog here but the diff viewer (see
// `modalUp` in web/dom.js): Cancel, the ✕ and a click outside close it. It can be up over the
// Start dialog, which is why its scrim comes later in index.html.

import { html, render } from './vendor/preact.js';
import { get, post } from './api.js';
import { dom, closeModal, closeOnClickOutside, openModal, toast } from './dom.js';

let cur = null;         // {subject, rows, error, resolve}
let wired = false;
let known = null;       // the last GET /api/orchestrators answer, or null before the first

/** The orchestrators as last fetched — synchronous, for the palette. */
export function knownOrchestrators() {
    return known || [];
}

/** Fetch the list again. Resolves with it; a failure keeps the last answer. */
export async function refreshOrchestrators() {
    const data = await get('/api/orchestrators');
    known = data.orchestrators || [];
    return known;
}

function wire() {
    if (wired) return;
    wired = true;
    for (const n of dom.orchPickScrim.querySelectorAll('[data-close-orch-pick]')) {
        n.addEventListener('click', () => finish(null));
    }
    closeOnClickOutside(dom.orchPickScrim, () => finish(null));
}

/**
 * Ask which orchestrator. Resolves with the chosen row, or null when the
 * picker was closed without one.
 *
 * @param {{subject?: string}} [opts] what is being sent, for the line at the top.
 */
export function pickOrchestrator({ subject = '' } = {}) {
    wire();
    // A second open while one is up answers the first with nothing, so no
    // caller is left waiting on a promise nobody will settle.
    if (cur) cur.resolve(null);
    return new Promise((resolve) => {
        cur = { subject, rows: null, error: null, resolve };
        openModal(dom.orchPickScrim);
        draw();
        load(cur);
    });
}

async function load(mine) {
    try {
        const rows = await refreshOrchestrators();
        if (cur !== mine) return;
        mine.rows = rows;
    } catch (err) {
        if (cur !== mine) return;
        mine.error = err.message;
    }
    draw();
    const first = dom.orchPickBody.querySelector('.op-pick-row');
    if (first) first.focus({ preventScroll: true });
}

function finish(row) {
    const was = cur;
    cur = null;
    closeModal(dom.orchPickScrim, () => render(null, dom.orchPickBody));
    if (was) was.resolve(row);
}

/** "2 of 3 running · 1 queued · 2 tasks waiting" — what makes a row worth choosing. */
function meta(r) {
    return [
        r.projectName,
        `${r.running} of ${r.maxRunning} running`,
        r.queued ? `${r.queued} queued` : null,
        r.openTasks ? `${r.openTasks} task${r.openTasks === 1 ? '' : 's'} waiting` : null,
    ].filter(Boolean).join(' · ');
}

/** Up and down between the rows; Enter is the button's own. */
function onKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...dom.orchPickBody.querySelectorAll('.op-pick-row')];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
    rows[next].focus();
}

function draw() {
    if (!cur) return;
    const { subject, rows, error } = cur;
    const lede = html`<p class="op-pick-lede">${subject ? html`<b>${`\u201c${subject}\u201d`}</b> becomes ` : 'This becomes '}
        a task in its inbox. The orchestrator is woken, and decides how to start it.</p>`;
    let list;
    if (error) {
        list = html`<p class="op-pick-note">${`Could not list the orchestrators. ${error}`}</p>`;
    } else if (!rows) {
        list = html`<div class="op-pick-list" aria-busy="true">
            ${[0, 1, 2].map(i => html`<div key=${i} class="skel op-pick-skel"></div>`)}</div>`;
    } else if (!rows.length) {
        list = html`<p class="op-pick-note">${'No orchestrators yet. Tick "Start as an orchestrator" '
            + 'when you start a session, or turn one on from a session’s header.'}</p>`;
    } else {
        list = html`<div class="op-pick-list" role="listbox" aria-label="Orchestrators" onKeyDown=${onKey}>
            ${rows.map(r => html`<button key=${r.orchestratorId} type="button" role="option" class="op-pick-row"
                aria-selected="false" data-live=${String(r.live)} onClick=${() => finish(r)}
                title=${r.cwd || ''}>
                <span class="op-dot" data-s=${r.paused ? 'wait' : r.live ? 'run' : 'idle'}
                    aria-label=${r.paused ? 'paused' : r.live ? 'live' : 'not running'}></span>
                <span class="op-pick-text">
                    <span class="op-pick-name">${r.title || 'Untitled orchestrator'}${r.test
                        ? html` <span class="tag-test">test</span>` : null}</span>
                    <span class="op-pick-meta">${meta(r)}</span>
                </span>
                ${r.paused ? html`<span class="op-pick-paused" title=${r.paused.reason}>paused</span>` : null}
            </button>`)}
        </div>`;
    }
    render(html`${lede}${list}`, dom.orchPickBody);
}

/**
 * Pick, then hand it over. `draftId`, `fields` or both — see the route in
 * bridge/routes/orchestrators.js. Resolves with the bridge's answer, or null
 * when nothing was sent (closed, or refused — the toast has said why).
 *
 * @param {{draftId?: string, fields?: object, subject?: string}} what
 */
export async function sendToOrchestrator({ draftId = null, fields = null, subject = '' }) {
    const row = await pickOrchestrator({ subject });
    if (!row) return null;
    const body = {};
    if (draftId) body.draftId = draftId;
    if (fields) body.fields = fields;
    try {
        const r = await post(`/api/sessions/${encodeURIComponent(row.orchestratorId)}/orchestrator/tasks`, body);
        const name = row.title ? `“${row.title}”` : 'the orchestrator';
        toast(r.paused
            ? `Handed to ${name}. It is paused, and will pick this up when it is resumed.`
            : `Handed to ${name} as a task.`, r.paused ? 'warn' : 'ok');
        return { ...r, orchestrator: row };
    } catch (err) {
        toast(`Could not hand it over: ${err.message}`, 'error');
        return null;
    }
}
