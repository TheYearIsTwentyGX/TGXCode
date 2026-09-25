// Subagents: the list of them beside the transcript, and the pane that opens
// one's own transcript through AGENT_VIEW.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { get } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { ago, clip, dur, shortModel } from '../format.js';
import { state } from '../state.js';
import { applyRunner, rememberView, subscribe } from '../app.js';
import { renderLater } from '../composer/later.js';
import { renderQueue } from '../composer/queue.js';
import { enableSend } from '../composer/send.js';
import { renderAsk } from './approvals.js';
import { AGENT_VIEW, appendEvents, renderHeader } from './conversation.js';
import { markFindDirty, syncFindSubs } from './find.js';
import { toolSummary } from './tools.js';
import { hideTurnPop } from './turn-rail.js';

// ── subagents ────────────────────────────────────────────────────────────
// A subagent is a conversation the session had on its own. Two things about it
// are worth seeing without opening it — whether it is still going, and what it
// is doing — and those come from two different places. Whether the call
// finished is in *this* transcript, as the result of the tool that spawned it,
// which the client already has and which updates live. What the agent is doing
// is in the agent's own file, which only the bridge can see.

export const STATUS_WORD = { running: 'running', done: 'finished', failed: 'failed' };

/** How the tool call that spawned an agent ended. */
export function statusOfCall(ev) {
    if (!ev || ev.status === 'pending') return 'running';
    return ev.status === 'error' ? 'failed' : 'done';
}

export async function loadAgents() {
    if (!state.current) return;
    const id = state.current.sessionId;
    try {
        const { agents } = await get(`/api/sessions/${id}/subagents`);
        if (!state.current || state.current.sessionId !== id) return;
        state.agents = agents;
        renderAgents();
        if (state.agent) renderAgentHeader();
    } catch {
        // The strip is derived from the transcript anyway; a failed refresh just
        // means the activity lines are a poll behind.
    }
}

/**
 * Every subagent this session spawned, in the order it spawned them.
 *
 * Driven by the Task calls in the transcript rather than by the bridge's file
 * listing, for two reasons: spawn order is the order worth reading them in, and
 * the transcript is what knows how each call ended. The bridge's records only
 * fill in what a file can tell you. Agents spawned *by* a subagent are left out
 * — their call lives in that subagent's transcript, and that is where they read
 * as belonging.
 */
export function agentRows() {
    const byId = new Map(state.agents.map(a => [a.toolUseId, a]));
    const rows = [];
    for (const { ev } of state.tools.values()) {
        if (ev.name !== 'Task' && ev.name !== 'Agent') continue;
        const info = byId.get(ev.id);
        const a = ev.agent || {};
        // No transcript on disk and nothing from the bridge: a call that was
        // denied or never got off the ground. Nothing to switch to.
        if (!info && !a.hasTranscript) continue;
        rows.push({
            toolUseId: ev.id,
            status: statusOfCall(ev),
            label: a.description || (info && info.description)
                || toolSummary(ev) || a.agentType || 'Subagent',
            agentType: a.agentType || (info && info.agentType) || null,
            model: a.model || null,
            depth: a.spawnDepth || (info && info.spawnDepth) || 1,
            durationMs: ev.durationMs || a.durationMs || null,
            toolUses: a.toolUses || null,
            tokens: a.tokens || null,
            startedAt: ev.ts,
            activity: (info && info.activity) || null,
            activityTs: (info && info.activityTs) || null,
            warm: Boolean(info && info.warm),
            bytes: (info && info.bytes) || 0,
        });
    }
    return rows;
}

export function renderAgents() {
    const rows = agentRows();
    syncFindSubs(rows);
    dom.agents.replaceChildren();
    if (!rows.length) return;

    for (const a of rows) {
        // A running agent that nothing has written to in a minute and a half is
        // not working — it is a session that went away mid-call. Say so rather
        // than showing a green light for something that has stopped.
        const stalled = a.status === 'running' && !a.warm && a.bytes > 0;
        const trailing = a.status === 'running'
            ? (stalled ? `idle ${ago(a.activityTs || a.startedAt)}` : clip(a.activity || 'working', 34))
            : [dur(a.durationMs), a.toolUses && `${a.toolUses} tools`].filter(Boolean).join(' · ');

        dom.agents.append(el('button', {
            class: 'agent-chip',
            type: 'button',
            'data-status': a.status,
            'data-stalled': String(stalled),
            'aria-current': state.agent === a.toolUseId ? 'true' : null,
            title: [a.label, a.agentType && `type: ${a.agentType}`,
                a.activity && `last: ${a.activity}`].filter(Boolean).join('\n'),
            onclick: () => openAgent(a.toolUseId),
        },
            el('span', { class: 'led' }),
            a.depth > 1 ? el('span', { class: 'depth' }, '↳') : null,
            el('span', { class: 'name' }, clip(a.label, 34)),
            trailing ? el('span', { class: 'trail' }, trailing) : null,
            el('span', { class: 'go' }, 'View'),
        ));
    }
}

/**
 * Switch the conversation pane over to one subagent's transcript.
 *
 * `quiet` is for a restore. A subagent is a detail of a session rather than a
 * place of its own, so an id that has gone should drop you back into the parent
 * transcript without saying anything — the session itself is fine, and the
 * address stops naming the subagent a moment later.
 */
export async function openAgent(toolUseId, { quiet = false } = {}) {
    if (!state.current) return;
    if (state.agent === toolUseId) return;
    const sessionId = state.current.sessionId;

    try {
        const d = await get(`/api/sessions/${sessionId}/subagent`
            + `?toolUseId=${encodeURIComponent(toolUseId)}`);
        if (!state.current || state.current.sessionId !== sessionId) return;

        state.agent = toolUseId;
        state.agentOffset = d.offset || 0;
        state.agentNodes.clear();
        state.agentTools.clear();
        state.agentRun.length = 0;
        dom.agentLog.replaceChildren();

        // Both panes stay mounted, so each keeps its own scroll position and the
        // session keeps streaming into its own while you read the subagent.
        dom.scroll.hidden = true;
        dom.agentScroll.hidden = false;
        dom.turns.hidden = true;
        hideTurnPop();

        appendEvents(d.events, AGENT_VIEW);
        renderAgentHeader();
        renderAgents();
        applyComposerScope();
        dom.agentScroll.scrollTop = dom.agentScroll.scrollHeight;

        subscribe();    // start following the agent's file as well
        loadAgents();
        rememberView();
        markFindDirty();
        syncFindSubs();
    } catch (err) {
        if (!quiet) toast(`Could not open the subagent: ${err.message}`, 'error');
        // state.agent is still null, so this drops the id that did not work
        // rather than leaving the next refresh to try it again.
        else rememberView();
    }
}

/** Reset subagent state without touching the DOM — for switching sessions. */
export function leaveAgent() {
    state.agent = null;
    state.agentOffset = 0;
    state.agentNodes.clear();
    state.agentTools.clear();
    state.agentRun.length = 0;
    dom.agentLog.replaceChildren();
    dom.scroll.hidden = false;
    dom.agentScroll.hidden = true;
    dom.turns.hidden = false;
    dom.btnBack.hidden = true;
    applyComposerScope();
    // The pane this emptied is one find may have been painting into, and with the
    // Subagents toggle off the index is the visible pane's alone.
    markFindDirty();
    syncFindSubs();
}

/** Back to the session that spawned it. */
export function closeAgent() {
    if (!state.agent) return;
    leaveAgent();
    renderHeader();
    renderAgents();
    subscribe();        // stop the bridge following a file nobody is reading
    rememberView();
}

// Writes the same `.conv-sub` as renderHeader, and deliberately without the
// session's pull requests: a subagent did not raise them, and the line is about
// the agent you are looking at. They come back when you leave it.
function renderAgentHeader() {
    const a = agentRows().find(r => r.toolUseId === state.agent);
    if (!a) return;

    dom.convTitle.textContent = a.label;
    dom.btnBack.hidden = false;
    dom.btnBackLabel.textContent = clip(state.current.title, 46);

    const stalled = a.status === 'running' && !a.warm && a.bytes > 0;
    const bits = [
        el('span', { class: `agent-state ${a.status}` },
            stalled ? 'stopped' : STATUS_WORD[a.status]),
    ];
    const push = (node) => { bits.push(el('span', { class: 'sep' }, '·'), node); };
    if (a.agentType) push(el('span', { class: 'branch' }, a.agentType));
    if (a.model) push(el('span', {}, shortModel(a.model)));
    if (a.durationMs) push(el('span', {}, dur(a.durationMs)));
    if (a.toolUses) push(el('span', {}, `${a.toolUses} tools`));
    if (a.tokens) push(el('span', {}, `${a.tokens.toLocaleString()} tokens`));
    if (a.status === 'running' && a.activity) {
        push(el('span', { class: 'pulse' }, clip(a.activity, 40)));
    }
    dom.convSub.replaceChildren(...bits);
}

/**
 * A subagent has no composer of its own — it is a conversation that already
 * happened, driven by the session. Say that rather than leaving a dead box.
 */
function applyComposerScope() {
    const onAgent = Boolean(state.agent);
    dom.input.disabled = onAgent;
    dom.input.placeholder = onAgent
        ? 'Subagents do not take messages — go back to the session to reply.'
        : 'Send a message to this session…';
    dom.conv.dataset.scope = onAgent ? 'agent' : 'session';
    // The dock and the plan view sit outside the scroller that swaps for a
    // subagent, so unlike the transcript they do not go away on their own.
    renderAsk();
    if (onAgent) {
        enableSend(false);
        dom.btnStop.hidden = true;
        renderQueue(state.runner);   // the session's queue is not the agent's business
        renderLater();               // nor are its scheduled messages
    } else {
        renderLater();
        enableSend(Boolean(state.current));
        applyRunner(state.runner);   // paints the lock, which owns the send buttons after this
    }
}
