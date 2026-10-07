// An orchestrator's dock: what sits above the composer in a session marked as
// one — bridge/orchestrators.js has what that means.
//
// Five things, top to bottom, with the one read most sitting nearest the
// composer:
//
//   - a **paused** line with Resume, when the usage cutoff has stopped it.
//   - the **inbox**, shut by default: what workers have filed and whether the
//     orchestrator has read it. A plan or a permission prompt is answered on the
//     worker's own page — its title is a link there, where the usual card is
//     already drawn — so this list never grows a second copy of that card.
//   - **workers** and **settings**, shut by default.
//   - the **summary**, pinned to the bottom of the conversation: a paragraph or
//     two the orchestrator rewrites with `set_summary` as it goes. It is the
//     thing to glance at on the way past, so it is open by default.
//
// A worker gets one line instead, naming its orchestrator, so the way back up is
// never more than a click.
//
// Preact, rendered from `state.orch`, which is the bridge's `orchestrator`
// payload for the session on screen: fetched when a session opens and replaced
// whole by the `orchestrator` event. Nothing here touches its own DOM.

import { html, render } from './vendor/preact.js';
import { state } from './state.js';
import { dom, toast } from './dom.js';
import { get, post, put } from './api.js';
import { ago, clip } from './format.js';
import { renderMarkdown } from './markdown.js';

const KIND_LABEL = {
    plan: 'Plan', permission: 'Permission', ask: 'Question for it', question: 'Question',
    update: 'Update', done: 'Done', turn: 'Turn report', note: 'Note',
};

// What is open, per window. Shut by default except the summary.
const open = { summary: true, inbox: false, workers: false, settings: false };

function goTo(id) {
    // Imported at call time: conversation.js imports this module, and a static
    // import back would make the two wait on each other at load.
    import('./transcript/conversation.js').then(m => m.openSession(id));
}

/** Fetch the payload for the session on screen, if it has a part in one. */
export async function loadOrchestrator() {
    const s = state.current;
    state.orch = null;
    if (!s || (!s.orchestrator && !s.worker)) { paintOrchestrator(); return; }
    const id = s.orchestrator ? s.sessionId : s.worker.orchestratorId;
    try {
        const p = await get(`/api/sessions/${id}/orchestrator`);
        if (!state.current || state.current.sessionId !== s.sessionId) return;
        state.orch = p.enabled ? p : null;
    } catch {
        state.orch = null;
    }
    paintOrchestrator();
}

/** The `orchestrator` event: replace the payload if it is about what is on screen. */
export function onOrchestratorEvent(p) {
    const s = state.current;
    if (!s) return;
    const mine = s.sessionId === p.orchestratorId
        || (s.worker && s.worker.orchestratorId === p.orchestratorId);
    if (!mine) return;
    state.orch = p.enabled ? p : null;
    paintOrchestrator();
}

/** Turn the role on or off for the session on screen. */
export async function toggleOrchestrator() {
    const s = state.current;
    if (!s) return;
    if (s.worker) {
        toast('A worker cannot be an orchestrator — orchestrators only go one level deep.', 'error');
        return;
    }
    const on = !s.orchestrator;
    if (!on && !window.confirm('Stop this session being an orchestrator? Its workers carry on as '
        + 'ordinary sessions, and its inbox is discarded.')) return;
    try {
        const p = await put(`/api/sessions/${s.sessionId}/orchestrator`, { enabled: on });
        s.orchestrator = on ? { inbox: 0, workers: 0, paused: false } : null;
        state.orch = p.enabled ? p : null;
        toast(on
            ? (p.restarted === 'after-turn'
                ? 'Marked as an orchestrator. It gets its tools when this turn ends.'
                : 'Marked as an orchestrator. It gets its tools on the next message.')
            : 'No longer an orchestrator.', 'ok');
    } catch (err) {
        toast(`Could not change that: ${err.message}`, 'error');
    }
    paintOrchestratorButton();
    paintOrchestrator();
}

export function paintOrchestratorButton() {
    const s = state.current;
    if (!dom.btnOrch || !s) return;
    const on = !!s.orchestrator;
    dom.btnOrch.hidden = !!s.worker;
    dom.btnOrch.classList.toggle('on', on);
    dom.btnOrch.setAttribute('aria-pressed', String(on));
    dom.btnOrch.title = on ? 'This session is an orchestrator — click to turn that off'
        : 'Make this session an orchestrator of worker sessions';
}

export function paintOrchestrator() {
    if (!dom.orchDock) return;
    const s = state.current;
    const p = state.orch;
    const show = !!s && !!p && (s.sessionId === p.orchestratorId || !!s.worker);
    dom.orchDock.hidden = !show;
    render(show ? (s.worker ? workerLine(s, p) : dock(p)) : null, dom.orchDock);
}

function toggle(key) {
    open[key] = !open[key];
    paintOrchestrator();
}

function workerLine(s, p) {
    const self = p.workers.find(w => w.id === s.sessionId);
    return html`<div class="orch-worker-line">
        <span class="tag-orch">worker</span>
        <span>${'Started by an orchestrator'}${self && self.closedAt ? ' · closed' : ''}</span>
        <button class="orch-link" type="button" onClick=${() => goTo(p.orchestratorId)}>
            Open the orchestrator</button>
    </div>`;
}

function section(key, title, extra, body) {
    return html`<section class=${`orch-sec orch-${key}`} data-open=${String(open[key])}>
        <button class="orch-sec-head" type="button" aria-expanded=${String(open[key])}
            onClick=${() => toggle(key)}>
            <span class="twist">▸</span><span class="orch-sec-title">${title}</span>${extra}
        </button>
        ${open[key] ? html`<div class="orch-sec-body">${body()}</div>` : null}
    </section>`;
}

function dock(p) {
    const running = p.workers.filter(w => !w.closedAt && (w.state === 'busy' || w.state === 'starting')).length;
    const openWorkers = p.workers.filter(w => !w.closedAt);
    return html`<div class="orch">
        ${p.paused ? html`<div class="orch-paused">
            <span>${`Paused — ${p.paused.reason}.`}</span>
            <button class="btn-small" type="button" onClick=${resume}>Resume</button>
        </div>` : null}
        ${section('inbox', 'Inbox',
            html`<span class="orch-count" data-hot=${String(p.unread > 0)}>${
                p.unread ? `${p.unread} unread` : 'nothing unread'}</span>`,
            () => inbox(p))}
        ${section('workers', 'Workers',
            html`<span class="orch-count">${`${openWorkers.length} open · ${running}/${p.settings.maxRunning} running`
                + `${p.pendingSpawns.length ? ` · ${p.pendingSpawns.length} queued` : ''}`}</span>`,
            () => workers(p))}
        ${section('settings', 'Settings', null, () => settings(p))}
        ${section('summary', 'Summary',
            html`<span class="orch-count">${p.summary ? updatedWhen(p.summary.at) : 'none yet'}</span>`,
            () => (p.summary
                ? html`<div class="orch-summary md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(p.summary.text) }}></div>`
                : html`<div class="orch-empty">The orchestrator has not written one yet. It is asked to keep
                    one or two paragraphs here on what is done and what is in flight.</div>`))}
    </div>`;
}

function updatedWhen(at) {
    const a = ago(at);
    return a === 'now' ? 'updated just now' : `updated ${a} ago`;
}

function workerTitle(p, id) {
    const w = id && p.workers.find(x => x.id === id);
    return w ? (w.title || 'untitled worker') : null;
}

function inbox(p) {
    const items = p.inbox.slice(0, 40);
    if (!items.length) return html`<div class="orch-empty">Nothing has arrived yet.</div>`;
    return html`<ul class="orch-items">${items.map(i => html`
        <li key=${i.id} class="orch-item" data-status=${i.status} data-kind=${i.kind}>
            <div class="orch-item-head">
                <span class="orch-kind">${KIND_LABEL[i.kind] || i.kind}</span>
                ${i.workerId ? html`<button class="orch-link" type="button" onClick=${() => goTo(i.workerId)}>
                    ${clip(workerTitle(p, i.workerId) || 'worker', 40)}</button>` : null}
                <span class="orch-when">${ago(i.at)}</span>
                <span class="orch-status">${statusWord(i)}</span>
                ${(i.status === 'new' || i.status === 'read') ? html`
                    <button class="orch-x" type="button" title="Dismiss" onClick=${() => dismiss(p, i)}>×</button>`
                    : null}
            </div>
            <details class="orch-text">
                <summary>${clip(i.text, 160) || '(empty)'}</summary>
                <pre>${i.text}</pre>
            </details>
        </li>`)}</ul>`;
}

function statusWord(i) {
    if (i.status === 'new') return 'unread';
    if (i.status === 'read') return i.requestId ? 'read · waiting' : 'read';
    if (i.status === 'stale') return 'gone';
    return `${i.outcome || 'done'}${i.by ? ` · by ${i.by}` : ''}`;
}

function workers(p) {
    if (!p.workers.length && !p.pendingSpawns.length) {
        return html`<div class="orch-empty">None yet. The orchestrator starts them with spawn_worker.</div>`;
    }
    return html`<ul class="orch-workers">
        ${p.workers.map(w => html`<li key=${w.id} data-closed=${String(!!w.closedAt)}>
            <button class="orch-link" type="button" onClick=${() => goTo(w.id)}>${w.title || 'untitled'}</button>
            <span class="orch-state" data-state=${w.state}>${w.closedAt ? 'closed'
                : w.pending ? `waiting on a ${w.pending}` : w.state}</span>
            ${w.worktree && w.worktree.branch ? html`<span class="orch-branch">${w.worktree.branch}</span>` : null}
        </li>`)}
        ${p.pendingSpawns.map(q => html`<li key=${q.id} data-queued="true">
            <span>${q.title || 'untitled'}</span><span class="orch-state">queued</span></li>`)}
    </ul>`;
}

function settings(p) {
    const s = p.settings;
    const save = (patch) => saveSettings(p, patch);
    return html`<div class="orch-settings">
        <label>At most
            <input type="number" min="1" max="10" defaultValue=${s.maxRunning}
                key=${`max:${s.maxRunning}`}
                onChange=${(e) => save({ maxRunning: Number(e.target.value) })} />
            workers running at once</label>
        <label><input type="checkbox" checked=${s.worktree}
            onChange=${(e) => save({ worktree: e.target.checked })} />
            Start each worker in its own worktree</label>
        <label><input type="checkbox" checked=${s.usageStop.enabled}
            onChange=${(e) => save({ usageStop: { enabled: e.target.checked } })} />
            Stop everything at
            <input type="number" min="1" max="100" defaultValue=${s.usageStop.percent}
                key=${`pct:${s.usageStop.percent}`} disabled=${!s.usageStop.enabled}
                onChange=${(e) => save({ usageStop: { percent: Number(e.target.value) } })} />
            % of
            <select value=${s.usageStop.window} disabled=${!s.usageStop.enabled}
                onChange=${(e) => save({ usageStop: { window: e.target.value } })}>
                <option value="five_hour">the five-hour window</option>
                <option value="seven_day">the weekly window</option>
                <option value="seven_day_opus">the weekly Opus window</option>
                <option value="seven_day_sonnet">the weekly Sonnet window</option>
            </select></label>
        <div class="orch-note">The defaults for new orchestrators, and text added to every
            orchestrator's instructions, are in Settings › Orchestrators.</div>
    </div>`;
}

async function saveSettings(p, patch) {
    try {
        state.orch = await put(`/api/sessions/${p.orchestratorId}/orchestrator`, { settings: patch });
    } catch (err) {
        toast(`Could not save that: ${err.message}`, 'error');
    }
    paintOrchestrator();
}

async function dismiss(p, i) {
    try {
        await post(`/api/sessions/${p.orchestratorId}/orchestrator/inbox/${i.id}/dismiss`, {});
    } catch (err) {
        toast(`Could not dismiss that: ${err.message}`, 'error');
    }
}

async function resume() {
    const p = state.orch;
    if (!p) return;
    try {
        state.orch = await post(`/api/sessions/${p.orchestratorId}/orchestrator/resume`, {});
        toast('Resumed. Queued workers start, and the orchestrator is told what is waiting.', 'ok');
    } catch (err) {
        toast(`Could not resume: ${err.message}`, 'error');
    }
    paintOrchestrator();
}
