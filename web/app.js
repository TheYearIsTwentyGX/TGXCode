// Claude Sessions — renderer.
//
// All state lives in the bridge; this file is a view over it. Transcript content
// arrives from one place only (the file tail, pushed over SSE), so a session
// running in somebody's terminal renders identically to one started here.

import { renderMarkdown, inline } from './markdown.js';
import { highlight, escapeHtml } from './highlight.js';
import { TerminalPane } from './terminal.js';

// ── api ──────────────────────────────────────────────────────────────────

const HEADERS = { 'X-Claude-Sessions-Client': '1', 'Content-Type': 'application/json' };

async function get(path) {
    const r = await fetch(path, { headers: { 'X-Claude-Sessions-Client': '1' } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
}

async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}

async function del(path) {
    const r = await fetch(path, { method: 'DELETE', headers: HEADERS });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}

// ── state ────────────────────────────────────────────────────────────────

const state = {
    clientId: null,
    dev: false,             // talking to a development bridge
    sessions: [],
    query: '',
    current: null,          // session summary
    offset: 0,
    openSeq: 0,             // bumped per open; a slow fetch checks it before drawing
    nodes: new Map(),       // event id -> {ev, node}
    tools: new Map(),       // tool_use id -> {ev, node}
    turns: [],              // the user messages, in order, for the turn rail
    activeTurn: -1,
    agents: [],             // subagent records for this session, from the bridge
    agent: null,            // the subagent being viewed, if any
    agentOffset: 0,
    agentNodes: new Map(),  // the viewed subagent's own event id -> {ev, node}
    agentTools: new Map(),
    runner: null,
    channels: [],
    pinned: true,           // stick to the bottom as new events arrive
    // Which rail groups are shut. Storing the collapsed ones rather than the
    // open ones means a project seen for the first time defaults to open.
    collapsed: (() => {
        try {
            const raw = localStorage.getItem('railCollapsed');
            if (raw) return new Set(JSON.parse(raw));
            // Migrate the old single-group flag; archived stays shut by default.
            return new Set(localStorage.getItem('archiveOpen') === '1' ? [] : ['archived']);
        } catch { return new Set(['archived']); }
    })(),
    // Where each row and each group card sits, decided once — see rememberOrder.
    order: new Map(),       // sessionId -> rank
    groupOrder: new Map(),  // group key -> rank
    freshRank: 0,           // ranks for what turns up after the first load
    unsent: new Map(),      // sessionId -> text written to a process but not yet in a transcript
    pendingDelete: null,    // the session the confirm dialog is asking about
    busyTimer: null,        // ticks the elapsed-time readout while a turn runs
    queue: [],              // the current session's waiting messages, from the bridge
    queueDrag: null,        // id of the chip being dragged
    queueOpen: new Set(),   // ids of chips expanded to their full text
    queueSig: '',           // what the chips were last built from, to avoid churn
    queueFocus: null,       // the chip holding the queue's single tab stop
    ask: null,              // the approval this session is blocked on, if any
    askTimer: null,         // ticks the countdown on the approval card
    runnerMode: null,       // the permission mode the bridge last reported
    stopArmed: 0,           // when a soft Stop happened, for the force escalation
};

const $ = (id) => document.getElementById(id);
const dom = {};
for (const id of ['search', 'rail', 'conv', 'placeholder', 'conv-title', 'conv-sub',
    'channels', 'scroll', 'log', 'status-line', 'status-text', 'btn-stop', 'input',
    'btn-send', 'queue', 'queue-list', 'queue-count', 'queue-clear',
    'model', 'perm', 'btn-new', 'db-status', 'db-label', 'toasts',
    'btn-pin', 'btn-folder', 'btn-term', 'btn-archive', 'btn-delete', 'turns', 'turn-pop',
    'term-pane', 'term-grip', 'term-dir', 'term-moved', 'term-body', 'term-restart', 'term-close',
    'agents', 'agent-scroll', 'agent-log', 'btn-back', 'btn-back-label',
    'new-scrim', 'new-cwd', 'new-picker', 'new-prompt', 'new-model', 'new-perm',
    'new-test', 'new-test-row', 'new-go',
    'del-scrim', 'del-what', 'del-meta', 'del-go']) {
    dom[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id);
}

// ── helpers ──────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs, ...kids) {
    // createElement('svg') yields an unknown HTML element that never renders.
    const n = tag === 'svg' ? document.createElementNS(SVG_NS, 'svg')
        : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
        if (kid === null || kid === undefined || kid === false) continue;
        n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
}

const pad = (n) => String(n).padStart(2, '0');

function clockOf(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    const d = Math.floor(s / 86400);
    if (d < 7) return `${d}d`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dur(ms) {
    if (!ms || ms < 0) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${pad(Math.floor((ms % 60000) / 1000))}s`;
}

const fileName = (p) => (p ? String(p).split('/').pop() : '');
const shortModel = (m) => (m ? String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '') : '');

function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * @param {object} [opts] {ms, action:{label, onClick}} — an action keeps the
 * toast up until it is used or dismissed, since it is the recovery path.
 */
function toast(text, kind = 'info', opts = {}) {
    const { ms = 4200, action = null } = typeof opts === 'number' ? { ms: opts } : opts;
    const t = el('div', { class: 'toast', 'data-kind': kind },
        el('span', { class: 'toast-text' }, text));

    if (action) {
        t.append(el('button', {
            class: 'toast-action', type: 'button',
            onclick: () => { t.remove(); action.onClick(); },
        }, action.label));
    }
    t.append(el('button', {
        class: 'toast-close', type: 'button', 'aria-label': 'Dismiss',
        onclick: () => t.remove(),
    }, '✕'));

    dom.toasts.append(t);
    if (!action) setTimeout(() => t.remove(), ms);
    return t;
}

// ── drafts ───────────────────────────────────────────────────────────────
// What is typed but not yet sent, and what was sent but never made it into a
// transcript. Neither should be lost to a reload or a failed turn.

const draftKey = (id) => `draft:${id}`;

function loadDraft(id) {
    try { return localStorage.getItem(draftKey(id)) || ''; } catch { return ''; }
}

function saveDraft(id, text) {
    try {
        if (text) localStorage.setItem(draftKey(id), text);
        else localStorage.removeItem(draftKey(id));
    } catch { /* storage unavailable; drafts are best effort */ }
}

/** Put text back in the composer without clobbering anything typed since. */
function restoreToComposer(text) {
    if (!text) return;
    const current = dom.input.value.trim();
    dom.input.value = current ? `${text}\n\n${current}` : text;
    autoGrow();
    dom.input.focus();
    dom.input.setSelectionRange(dom.input.value.length, dom.input.value.length);
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
}

// ── rail ─────────────────────────────────────────────────────────────────

async function loadSessions() {
    try {
        const q = state.query ? `?q=${encodeURIComponent(state.query)}` : '';
        const { sessions } = await get('/api/sessions' + q);
        state.sessions = sessions;
        rememberOrder(sessions);
        renderRail();
    } catch (err) {
        toast(`Could not load sessions: ${err.message}`, 'error');
    }
}

const groupKeyOf = (s) => `project:${s.projectName || 'unknown'}`;

/**
 * Decide where each row and each group card sits, once.
 *
 * The bridge returns sessions newest-first and recomputes that on every change,
 * so the rail used to re-sort itself whenever anything happened anywhere: a
 * session taking a message climbed past its neighbours and dragged its whole
 * project card up with it, moving rows out from under the cursor of somebody
 * reading them. So the order the rail was opened with is the order it keeps —
 * a reload is what re-sorts it.
 *
 * Ranks from the first load count up from zero, in the order the bridge sent
 * them. Anything first seen after that is genuinely new rather than merely
 * busy, so it takes a negative rank: it lands at the top of its group, and a
 * project nobody had a session in yet lands at the top of the rail, without
 * disturbing the position of anything already placed.
 */
function rememberOrder(sessions) {
    const firstLoad = state.order.size === 0;
    for (const s of sessions) {
        if (!state.order.has(s.sessionId)) {
            state.order.set(s.sessionId, firstLoad ? state.order.size : --state.freshRank);
        }
        // Recorded for every session, pinned or not: unpinning one later has to
        // drop it back into a project card that already knows where it goes.
        const key = groupKeyOf(s);
        if (!state.groupOrder.has(key)) {
            state.groupOrder.set(key, firstLoad ? state.groupOrder.size : --state.freshRank);
        }
    }
}

const rankOf = (s) => state.order.get(s.sessionId) ?? 0;

const ICON = {
    pin: '<path d="M9 3h6l-.7 5.2 3 2.6V13H6.7v-2.2l3-2.6L9 3Z" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linejoin="round"/><path d="M12 13v8" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round"/>',
    archive: '<path d="M3.5 6.2h17V9h-17V6.2Z" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linejoin="round"/><path d="M5 9v9.3h14V9" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linejoin="round"/><path d="M10 12.5h4" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round"/>',
    unarchive: '<path d="M12 19V9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
        + '<path d="m8.5 12.5 3.5-3.5 3.5 3.5" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 5.5h15" '
        + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    caret: '<path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round"/>',
    trash: '<path d="M4.5 6.8h15" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round"/><path d="M6.6 6.8 7.7 19a1.5 1.5 0 0 0 1.5 1.4h5.6A1.5 1.5 0 0 0 '
        + '16.3 19l1.1-12.2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
        + '<path d="M9.6 6.8V4.6a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v2.2" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linejoin="round"/>',
};

function icon(name, size = 15) {
    return el('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': 'true', html: ICON[name],
    });
}

function renderRail() {
    dom.rail.replaceChildren();

    if (!state.sessions.length) {
        dom.rail.append(el('div', { class: 'rail-empty' },
            state.query ? 'Nothing matches that filter.' : 'No sessions on disk yet.'));
        return;
    }

    // Held order, not the order the bridge sent. See rememberOrder.
    const ordered = [...state.sessions].sort((a, b) => rankOf(a) - rankOf(b));

    const pinned = ordered.filter(s => s.pinned);
    const archived = ordered.filter(s => s.archived && !s.pinned);
    // Scratch sessions gathered in one place, because the point of labelling one
    // is to be able to find it again and delete it. Only a development bridge
    // sends any, so the everyday window never grows this card.
    const test = ordered.filter(s => s.test && !s.pinned && !s.archived);
    const rest = ordered.filter(s => !s.pinned && !s.archived && !s.test);

    // Pinned first, across every project — that is the point of pinning.
    if (pinned.length) dom.rail.append(groupCard('pinned', 'Pinned', pinned));

    const groups = new Map();
    for (const s of rest) {
        const key = groupKeyOf(s);
        if (!groups.has(key)) groups.set(key, { label: s.projectName || 'unknown', list: [] });
        groups.get(key).list.push(s);
    }
    const byGroupRank = [...groups].sort(
        (a, b) => (state.groupOrder.get(a[0]) ?? 0) - (state.groupOrder.get(b[0]) ?? 0));
    for (const [key, { label, list }] of byGroupRank) {
        dom.rail.append(groupCard(key, label, list));
    }

    if (test.length) dom.rail.append(groupCard('test', 'Test sessions', test));
    if (archived.length) dom.rail.append(groupCard('archived', 'Archived', archived));
}

/** A rail group: a card whose heading shuts it. `key` is what the open/shut
 *  state is remembered under, so it has to outlive a re-render. */
function groupCard(key, label, list) {
    // A filter that matches inside a shut group must not hide its own results.
    // The heading still toggles while filtering; it takes effect once the
    // filter clears.
    const open = !state.collapsed.has(key) || Boolean(state.query);
    const live = list.filter(s => s.active || (s.runner && s.runner.state === 'busy')).length;
    const bodyId = `group-${key.replace(/[^\w-]/g, '_')}`;

    return el('section', { class: 'rail-group', 'data-key': key },
        el('button', {
            class: 'group-head',
            type: 'button',
            'aria-expanded': String(open),
            'aria-controls': bodyId,
            onclick: () => {
                state.collapsed[open ? 'add' : 'delete'](key);
                saveCollapsed();
                renderRail();
            },
        },
            el('span', { class: 'twist' }, icon('caret', 13)),
            el('span', { class: 'group-label' }, label),
            live ? el('span', { class: 'live' }, `${live} live`) : null,
            el('span', { class: 'count' }, String(list.length)),
        ),
        open ? el('div', { class: 'group-body', id: bodyId }, list.map(strip)) : null,
    );
}

function strip(s) {
    const running = s.runner && (s.runner.state === 'busy' || s.runner.state === 'starting');
    const current = state.current && state.current.sessionId === s.sessionId;
    const queued = (s.runner && s.runner.queued) || 0;

    // A row, not a button: it holds its own pin and archive controls, and
    // nesting buttons is not allowed.
    return el('div', {
        class: 'strip',
        'data-id': s.sessionId,
        'data-state': running ? 'running' : (s.active ? 'active' : 'idle'),
        'data-pinned': String(!!s.pinned),
        'data-archived': String(!!s.archived),
        'aria-current': current ? 'true' : null,
    },
        el('button', {
            class: 'strip-main', type: 'button',
            onclick: () => openSession(s.sessionId),
        },
            el('span', { class: 'strip-title' }, s.title),
            el('span', { class: 'strip-meta' },
                // Pinning is a state worth seeing without hovering, and this is
                // where it goes now that the buttons are hover-only.
                s.pinned ? el('span', { class: 'tag-pin', title: 'Pinned' },
                    icon('pin', 11)) : null,
                // Only ever set on a development bridge, and worth saying on the
                // row: a labelled session is one somebody meant to throw away.
                s.test ? el('span', { class: 'tag-test' }, 'test') : null,
                s.worktree ? el('span', { class: 'wt' }, s.worktree.name) : null,
                s.worktree ? el('span', { class: 'dot' }, '·') : null,
                // The time the list is ordered by, so the order reads as sorted.
                el('span', { title: `You last wrote here ${ago(s.lastUserTs || s.lastTs)} ago` },
                    ago(s.lastUserTs || s.lastTs)),
                el('span', { class: 'dot' }, '·'),
                el('span', {}, `${s.userMessages} ${s.userMessages === 1 ? 'turn' : 'turns'}`),
                // Something you queued here and then walked away from. Ahead of
                // the activity because the activity is the one part of the row
                // that may be cut short — it is the least specific thing on it.
                queued ? queuedBadge(queued) : null,
                activityBits(running ? s.runner : null),
            ),
        ),
        el('div', { class: 'strip-actions' },
            el('button', {
                class: 'mini' + (s.pinned ? ' on' : ''), type: 'button',
                title: s.pinned ? 'Unpin' : 'Pin to the top',
                'aria-pressed': String(!!s.pinned),
                onclick: (e) => { e.stopPropagation(); setFlags(s, { pinned: !s.pinned }); },
            }, icon('pin')),
            el('button', {
                class: 'mini', type: 'button',
                title: s.archived ? 'Restore from archive' : 'Archive',
                onclick: (e) => { e.stopPropagation(); setFlags(s, { archived: !s.archived }); },
            }, icon(s.archived ? 'unarchive' : 'archive')),
            el('button', {
                class: 'mini danger', type: 'button',
                title: 'Delete permanently',
                onclick: (e) => { e.stopPropagation(); askDelete(s); },
            }, icon('trash')),
        ),
    );
}

/**
 * What a row says about the turn it is running: its separator and the activity
 * line, as a pair, so a status update can swap them as one.
 *
 * Only the words. That a session is working at all is said by the dot at the head
 * of the meta line, which is the part that has to survive a narrow rail — this
 * text is last in a row that does not wrap, so it is the first thing to go.
 */
function activityBits(runner) {
    if (!runner) return [];
    return [
        el('span', { class: 'dot dot-act' }, '·'),
        el('span', { class: 'pulse' },
            el('span', { class: 'pulse-t' }, clip(runner.activity || 'Working', 22))),
    ];
}

function queuedBadge(queued) {
    return el('span', {
        class: 'wait',
        title: `${queued} message${queued === 1 ? '' : 's'} waiting to be sent`,
    }, `+${queued} queued`);
}

/** Update one row's queue count in place, rather than rebuilding the rail. */
function patchQueuedBadge(stripEl, queued) {
    const meta = stripEl.querySelector('.strip-meta');
    if (!meta) return;
    const existing = meta.querySelector('.wait');
    if (!queued) { if (existing) existing.remove(); return; }
    const fresh = queuedBadge(queued);
    if (existing) existing.replaceWith(fresh);
    // Ahead of the activity, in the place strip() would have built it.
    else meta.insertBefore(fresh, meta.querySelector('.pulse')?.previousSibling || null);
}

/**
 * Bring one row's state, queue count and activity line up to date in place.
 *
 * The rail is rebuilt only when the session list changes, and none of the things
 * that move while a turn runs change it: not the tool being called, not the queue
 * behind it, not the turn ending. So a row kept whatever the last list happened to
 * say — an activity line minutes stale, and a finished turn still breathing.
 */
function patchStripStatus(stripEl, s) {
    const meta = stripEl.querySelector('.strip-meta');
    if (!meta) return;
    const runner = s.runner;
    const running = runner && (runner.state === 'busy' || runner.state === 'starting');
    stripEl.dataset.state = running ? 'running' : (s.active ? 'active' : 'idle');
    // Cleared before the queue badge is placed, so it lands where strip() puts it.
    for (const node of meta.querySelectorAll('.dot-act, .pulse')) node.remove();
    patchQueuedBadge(stripEl, (runner && runner.queued) || 0);
    for (const node of activityBits(running ? runner : null)) meta.append(node);
}

/** Toggle pin/archive, updating in place so the rail doesn't jump under the cursor. */
async function setFlags(summary, change) {
    try {
        const r = await post(`/api/sessions/${summary.sessionId}/flags`, change);
        Object.assign(summary, { pinned: r.pinned, archived: r.archived, test: r.test });
        if (state.current && state.current.sessionId === summary.sessionId) {
            Object.assign(state.current, { pinned: r.pinned, archived: r.archived, test: r.test });
            renderHeaderActions();
        }
        renderRail();
    } catch (err) {
        toast(`Could not update the session: ${err.message}`, 'error');
    }
}

function saveCollapsed() {
    try {
        localStorage.setItem('railCollapsed', JSON.stringify([...state.collapsed]));
    } catch { /* private mode */ }
}

// ── delete ───────────────────────────────────────────────────────────────
// Archiving is the reversible one and is a click. This is not reversible, so it
// is a click plus an answer to a question that names what is about to go.

function askDelete(summary) {
    state.pendingDelete = summary;
    dom.delWhat.textContent = summary.title;
    // replaceChildren has no opinion about nulls the way el() does — it would
    // render them as the word "null".
    dom.delMeta.replaceChildren(...[
        el('span', {}, summary.projectName),
        el('span', { class: 'sep' }, '·'),
        el('span', {}, `${summary.userMessages} ${summary.userMessages === 1 ? 'turn' : 'turns'}`),
        el('span', { class: 'sep' }, '·'),
        el('span', {}, `last written ${ago(summary.lastTs)} ago`),
        summary.test ? el('span', { class: 'sep' }, '·') : null,
        summary.test ? el('span', { class: 'tag-test' }, 'test') : null,
    ].filter(Boolean));
    dom.delScrim.hidden = false;
    dom.delGo.focus();
}

function closeDelete() {
    dom.delScrim.hidden = true;
    state.pendingDelete = null;
    dom.delGo.disabled = false;
    dom.delGo.textContent = 'Delete permanently';
}

async function confirmDelete() {
    const s = state.pendingDelete;
    if (!s) return;
    dom.delGo.disabled = true;
    dom.delGo.textContent = 'Deleting…';
    try {
        await del(`/api/sessions/${s.sessionId}`);
        closeDelete();
        toast(`Deleted “${clip(s.title, 40)}”.`, 'ok');
        // The bridge broadcasts as well, so this is only about not waiting for a
        // round trip to stop showing a conversation that no longer exists.
        forgetSession(s.sessionId);
    } catch (err) {
        dom.delGo.disabled = false;
        dom.delGo.textContent = 'Delete permanently';
        toast(`Could not delete: ${err.message}`, 'error');
    }
}

/** Drop every trace of a session that has gone, whoever deleted it. */
function forgetSession(sessionId) {
    state.sessions = state.sessions.filter(s => s.sessionId !== sessionId);
    state.order.delete(sessionId);
    state.unsent.delete(sessionId);
    saveDraft(sessionId, '');
    if (state.pendingDelete && state.pendingDelete.sessionId === sessionId) closeDelete();
    if (state.current && state.current.sessionId === sessionId) clearCurrent();
    renderRail();
}

/** Back to the empty state — the conversation on screen is not there any more. */
function clearCurrent() {
    state.current = null;
    state.openSeq++;        // a transcript fetch still in flight must not draw
    state.offset = 0;
    state.runner = null;
    state.nodes.clear();
    state.tools.clear();
    state.turns = [];
    state.activeTurn = -1;
    state.agents = [];
    state.ask = null;
    leaveAgent();
    clearInterval(state.busyTimer);
    state.busyTimer = null;
    dom.log.replaceChildren();
    dom.turns.replaceChildren();
    dom.agents.replaceChildren();
    dom.channels.replaceChildren();
    hideTurnPop();
    dom.conv.hidden = true;
    dom.placeholder.hidden = false;
    dom.btnSend.disabled = true;
    // The pane lives inside .conv, so it goes with it; the shell keeps running
    // and is there again the moment the session is.
    termPane.detach();
    subscribe();            // stop the bridge tailing a file that is gone
}

// ── conversation ─────────────────────────────────────────────────────────

async function openSession(id, { quiet = false } = {}) {
    if (state.current && state.current.sessionId === id) return true;
    // Keep whatever is half-typed for the session being left behind.
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);

    // Switching should feel like switching, not like waiting: a long transcript
    // is megabytes and the fetch is most of the delay. The rail summary is the
    // same object the transcript endpoint returns, so the header is drawn for
    // real straight away and only the body stands in until the events land.
    // A session we hold no summary for — a fork still being written, which
    // openSessionSoon() retries against — has nothing to draw from, so it keeps
    // the old behaviour of arriving all at once.
    const known = state.sessions.find(s => s.sessionId === id) || null;
    const seq = ++state.openSeq;
    if (known) beginOpen(known);

    try {
        const data = await get(`/api/sessions/${id}`);
        // Another session was opened while this was in flight; that one owns the
        // pane now and must not be overwritten by this late arrival.
        if (seq !== state.openSeq) return true;

        if (known) state.current = data.summary;   // the index may have moved on
        else beginOpen(data.summary);              // nothing was drawn yet
        state.offset = data.offset;

        renderHeader();
        dom.log.replaceChildren();      // drops the skeleton
        appendEvents(data.events);
        renderTurns();      // a session with no turns of your own still clears the rail
        renderRail();
        applyRunner(data.runner);
        scrollToEnd(true);

        subscribe();
        loadChannels();
        loadAgents();
        return true;
    } catch (err) {
        if (seq !== state.openSeq) return true;
        // The pane is already showing this session, so the failure has to be
        // said there — a toast alone would leave a skeleton pulsing forever.
        if (known) showOpenFailed(id, err);
        if (!quiet) toast(`Could not open session: ${err.message}`, 'error');
        return false;
    }
}

/**
 * Move the conversation pane onto a session before its transcript exists.
 *
 * Everything here is derivable from the summary alone. What needs the fetch —
 * the events, the byte offset, the runner state — is deliberately left cleared
 * so nothing downstream reads the session it just left.
 */
function beginOpen(summary) {
    state.current = summary;
    state.offset = 0;
    state.runner = null;
    state.nodes.clear();
    state.tools.clear();
    state.turns = [];
    state.activeTurn = -1;
    state.pinned = true;
    state.agents = [];  // the previous session's agents are not this one's
    state.ask = null;   // approvals belong to the session that is blocked on them
    state.runnerMode = null;
    state.stopArmed = 0;
    leaveAgent();       // a subagent belongs to the session it was spawned by

    dom.placeholder.hidden = true;
    dom.conv.hidden = false;

    renderHeader();
    hideTurnPop();
    dom.turns.replaceChildren();
    dom.log.replaceChildren(skeleton());
    dom.scroll.scrollTop = 0;
    renderRail();       // the clicked row takes the current-session mark now
    applyRunner(null);
    syncTerm();         // an open pane follows the session onto its directory

    // Anything typed here before, or handed back by a failed turn — but only what
    // is genuinely still owed to the composer. state.unsent is insurance against a
    // process dying mid-turn, not a draft: reading it here put the message you had
    // just sent back in the box every time you looked away and back, and leaving
    // again then saved that copy as a real draft, which outlived the turn.
    // handleSendFailure and editQueued are the two things that hand text back.
    dom.input.value = loadDraft(summary.sessionId);
    autoGrow();
    dom.input.focus();
}

function showOpenFailed(id, err) {
    dom.log.replaceChildren(el('div', { class: 'load-failed' },
        el('p', {}, `This conversation could not be loaded: ${err.message}`),
        el('button', { class: 'more-btn', type: 'button',
            onclick: () => { state.current = null; openSession(id); } }, 'Try again'),
    ));
}

/**
 * A stand-in for a transcript that is still loading.
 *
 * Shaped like the real thing — the same time gutter, prose blocks and collapsed
 * tool rows — so the pane keeps its rhythm and does not visibly re-flow when the
 * events replace it.
 */
function skeleton() {
    const row = (...body) => el('div', { class: 'ev' },
        el('div', { class: 'ev-time' }, el('div', { class: 'skel skel-time' })),
        el('div', { class: 'ev-body' }, ...body));
    const said = (...widths) => row(
        el('div', { class: 'skel skel-name' }),
        ...widths.map(w => el('div', { class: 'skel skel-line', style: `width:${w}` })));
    const called = () => row(el('div', { class: 'skel skel-tool' }));

    const box = el('div', { class: 'skeleton', role: 'status',
        'aria-label': 'Loading this conversation' });

    // A transcript opens scrolled to its end, so a stand-in that stops a third
    // of the way down the pane reads as an empty conversation rather than a
    // loading one. Fill the height there actually is, alternating the shapes so
    // it does not look like a repeating pattern.
    const SAID = [['54%'], ['97%', '88%', '61%'], ['93%', '46%'], ['89%', '96%', '72%', '38%']];
    const target = Math.max(320, dom.scroll.clientHeight);
    for (let i = 0, used = 0; used < target; i++) {
        const widths = SAID[i % SAID.length];
        box.append(said(...widths));
        used += 32 + widths.length * 24;            // label, then prose on a 24px pitch
        for (let c = 0, calls = 1 + (i % 3); c < calls; c++) { box.append(called()); used += 42; }
    }
    return box;
}

/**
 * Open a session that may not exist on disk yet.
 *
 * A brand-new or freshly forked session has no transcript until `claude` writes
 * its first line, so opening it immediately 404s. Wait for it to show up rather
 * than guessing a delay.
 */
async function openSessionSoon(id, { timeoutMs = 25000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let delay = 350;
    while (Date.now() < deadline) {
        if (await openSession(id, { quiet: true })) {
            loadSessions();
            return true;
        }
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(1500, Math.round(delay * 1.4));
    }
    await loadSessions();
    toast('The new session has not shown up yet — it will appear in the list shortly.', 'warn');
    return false;
}

function renderHeader() {
    const s = state.current;
    dom.convTitle.textContent = s.title;

    const bits = [];
    bits.push(el('span', {}, s.projectName));
    if (s.worktree) {
        bits.push(el('span', { class: 'sep' }, '/'));
        bits.push(el('span', { class: 'branch' }, s.worktree.name));
    } else if (s.gitBranch && s.gitBranch !== 'HEAD') {
        bits.push(el('span', { class: 'sep' }, '/'));
        bits.push(el('span', { class: 'branch' }, s.gitBranch));
    }
    if (s.model) {
        bits.push(el('span', { class: 'sep' }, '·'));
        bits.push(el('span', {}, shortModel(s.model)));
    }
    bits.push(el('span', { class: 'sep' }, '·'));
    bits.push(el('span', {}, `${s.userMessages} turns`));
    if (s.pr) {
        bits.push(el('span', { class: 'sep' }, '·'));
        bits.push(el('a', { class: 'pr', href: s.pr.url, target: '_blank', rel: 'noreferrer' },
            `PR #${s.pr.number}`));
    }
    bits.push(el('span', { class: 'sep' }, '·'));
    bits.push(el('span', { class: 'cwd', title: s.cwd }, clip(s.cwd, 42)));

    dom.convSub.replaceChildren(...bits);
    renderHeaderActions();
}

function renderHeaderActions() {
    const s = state.current;
    if (!s) return;
    dom.btnPin.classList.toggle('on', !!s.pinned);
    dom.btnPin.setAttribute('aria-pressed', String(!!s.pinned));
    dom.btnPin.title = s.pinned ? 'Unpin this session' : 'Pin this session to the top';
    dom.btnArchive.classList.toggle('on', !!s.archived);
    dom.btnArchive.title = s.archived ? 'Restore from archive' : 'Archive this session';
    dom.btnDelete.title = `Delete “${clip(s.title, 40)}” permanently`;
    dom.btnFolder.title = `Show ${s.cwd} in File Explorer`;
    dom.btnTerm.title = dom.termPane.hidden
        ? `Open a terminal in ${s.cwd}` : 'Hide the terminal';
}

// A session transcript and a subagent transcript render identically — they
// differ only in which nodes they own and which pane they live in. A view is
// that difference, so everything below can be written once.

const SESSION_VIEW = {
    isAgent: false,
    nodes: state.nodes, tools: state.tools,
    get log() { return dom.log; },
    get scroll() { return dom.scroll; },
};

const AGENT_VIEW = {
    isAgent: true,
    nodes: state.agentNodes, tools: state.agentTools,
    get log() { return dom.agentLog; },
    get scroll() { return dom.agentScroll; },
};

function appendEvents(events, view = SESSION_VIEW) {
    const frag = document.createDocumentFragment();
    let newTurn = false;
    let sawAgent = false;
    for (const ev of events) {
        if (ev.kind === 'tool-result') { patchTool(ev, view); continue; }
        if (view.nodes.has(ev.id)) continue;
        const node = renderEvent(ev);
        if (!node) continue;
        view.nodes.set(ev.id, { ev, node });
        if (ev.kind === 'tool') {
            view.tools.set(ev.id, { ev, node });
            if (ev.name === 'Task' || ev.name === 'Agent') sawAgent = true;
        }
        if (ev.kind === 'user') newTurn = true;
        frag.append(node);
    }
    if (frag.childNodes.length) view.log.append(frag);
    if (!view.isAgent) {
        if (newTurn) renderTurns();
        // A Task call that has only just appeared belongs on the strip now, not
        // after the next poll.
        if (sawAgent) { renderAgents(); loadAgents(); }
    }
}

/** A tool call whose result arrived in a later chunk than the call itself. */
function patchTool(patch, view = SESSION_VIEW) {
    const entry = view.tools.get(patch.toolId);
    if (!entry) return;
    // Only the result fields. The patch is a well-formed event in its own right,
    // so it carries `id` (`toolu_x:result`), `kind` ('tool-result') and the
    // result's own `ts` — and merging those into the call is silently fatal:
    // the new kind makes renderEvent fall through to null so the block is never
    // redrawn, the new id unkeys it from `nodes`, and the new ts is the same
    // instant as resultTs so every duration collapses to 0ms.
    const { id, kind, toolId, ts, ...fields } = patch;
    Object.assign(entry.ev, fields);
    if (entry.ev.ts && patch.resultTs) {
        entry.ev.durationMs = Date.parse(patch.resultTs) - Date.parse(entry.ev.ts);
    }
    const wasOpen = entry.node.querySelector('details') ?
        entry.node.querySelector('details').open : false;
    const fresh = renderEvent(entry.ev);
    if (!fresh) return;
    const det = fresh.querySelector('details');
    // Rebuild the body up front rather than waiting for the toggle event the
    // assignment queues, so a block that was open does not blink shut.
    if (det && wasOpen) { fillTool(det, entry.ev); det.open = true; }
    entry.node.replaceWith(fresh);
    entry.node = fresh;
    view.nodes.set(entry.ev.id, entry);
    // A result landing on a Task call is a subagent finishing: the strip says so.
    if (!view.isAgent && entry.ev.agent) renderAgents();
}

function row(ev, kind, ...body) {
    return el('div', { class: `ev ev-${kind}`, 'data-error': ev.isError ? 'true' : null },
        el('div', { class: 'ev-time' }, clockOf(ev.ts)),
        el('div', { class: 'ev-body' }, ...body),
    );
}

function renderEvent(ev) {
    switch (ev.kind) {
        case 'user': return renderUser(ev);
        case 'assistant': return renderAssistant(ev);
        case 'thinking': return renderThinking(ev);
        case 'tool': return renderTool(ev);
        case 'agent-done': return renderAgentDone(ev);
        case 'system': return renderSystem(ev);
        case 'compact': return row(ev, 'compact', 'context compacted');
        default: return null;
    }
}

function renderUser(ev) {
    const body = [];
    body.push(el('div', { class: 'ev-label' }, 'You'));
    if (ev.command) {
        body.push(el('div', { class: 'prose', html:
            `<p><code>/${escapeHtml(ev.command.name)}</code>`
            + (ev.command.args ? ' ' + inline(ev.command.args) : '') + '</p>' }));
    } else {
        body.push(el('div', { class: 'prose', html: renderMarkdown(ev.text) }));
    }
    for (const img of ev.images || []) {
        if (img.dataUri) body.push(el('img', { src: img.dataUri, alt: 'attached image',
            style: 'max-width:100%; margin-top:8px; border:1px solid var(--outline-soft)' }));
    }
    return row(ev, 'user', ...body);
}

function renderAssistant(ev) {
    return row(ev, 'assistant',
        el('div', { class: 'ev-label' }, 'Claude'),
        el('div', { class: 'prose', html: renderMarkdown(ev.text) }),
    );
}

function renderThinking(ev) {
    const words = ev.text.trim().split(/\s+/).length;
    const det = el('details', { class: 'tool thinking' },
        el('summary', {},
            el('span', { class: 'caret' }, '▶'),
            el('span', { class: 'tname' }, 'Thought'),
            el('span', { class: 'targ' }, clip(ev.text, 90)),
            el('span', { class: 'tmeta' }, `${words} words`),
        ),
        el('div', { class: 'tool-body' },
            el('div', { class: 'prose', html: renderMarkdown(ev.text) })),
    );
    return row(ev, 'thinking', det);
}

/**
 * A background task reporting back. It arrives as a user message — that is the
 * only way into a conversation — but you did not write it, so it does not get
 * rendered as though you had.
 */
function renderAgentDone(ev) {
    const failed = ev.status && ev.status !== 'completed';
    const meta = [ev.toolUses && `${ev.toolUses} tools`, dur(ev.durationMs),
        ev.tokens && `${ev.tokens.toLocaleString()} tokens`].filter(Boolean).join(' · ');

    const body = [el('div', { class: 'ev-label' },
        failed ? `Subagent ${ev.status}` : 'Subagent finished')];
    if (ev.summary) body.push(el('div', { class: 'agent-done-sum' }, ev.summary));
    if (meta) body.push(el('div', { class: 'agent-done-meta' }, meta));

    // The notification carries the id of the call that spawned it, which is the
    // same key the transcripts are filed under — so this can be a way in.
    if (ev.toolUseId && state.tools.has(ev.toolUseId)) {
        body.push(el('div', { class: 'subagent-btns' },
            el('button', {
                class: 'more-btn primary', type: 'button',
                onclick: () => openAgent(ev.toolUseId),
            }, 'Open this subagent')));
    }

    if (ev.result) {
        body.push(el('details', { class: 'tool' },
            el('summary', {},
                el('span', { class: 'caret' }, '▶'),
                el('span', { class: 'tname' }, 'Result'),
                el('span', { class: 'targ' }, clip(ev.result, 90)),
            ),
            el('div', { class: 'tool-body' },
                el('div', { class: 'prose', html: renderMarkdown(ev.result) })),
        ));
    }

    return row(ev, 'agent-done', ...body);
}

function renderSystem(ev) {
    const label = ev.subtype === 'permission_denied' ? 'Denied'
        : ev.subtype === 'away_summary' ? 'Summary'
        : ev.subtype.replace(/_/g, ' ');
    const body = [
        el('div', { class: 'ev-label' }, label),
        el('div', { class: 'prose', html: renderMarkdown(ev.text) }),
    ];
    if (ev.subtype === 'permission_denied') {
        // Now that asks are answerable, most denials on this line are somebody's
        // answer rather than a mode quietly refusing. Point at the mode only as
        // the thing to change if you are being asked more than you want to be.
        body.push(el('div', { class: 'note', style: 'margin-top:6px; font-size:11.5px; color:var(--text-4)' },
            'The permission mode below the composer decides how often you are asked.'));
    }
    return row(ev, 'system', ...body);
}

// ── approvals, plans and questions ───────────────────────────────────────
// A blocked turn, drawn at the foot of the transcript rather than as a toast:
// toasts are dismissible and this is not — the turn is waiting on the answer.
// The card is deliberately built from the same vocabulary as a tool block, so
// what you approve looks like what you will see once it has run.
//
// Three things arrive down this channel and only one of them is a permission:
//
//   tool      may I run this? — yes, yes-always, or no.
//   plan      here is the plan. Approving it starts the work and decides the
//             mode it runs under; turning it down is feedback, not a refusal,
//             so the card offers somewhere to say what was wrong with it.
//   question  a multiple-choice question, answered by picking.
//
// They share the card chrome because they share the thing that matters about
// it: the turn does not move until you answer.

const DECISION_WORD = {
    allow: 'Allowed.', 'allow-always': 'Allowed for the rest of this session.',
    deny: 'Denied.', stopped: 'Stopped before it was approved.',
    cancelled: 'Withdrawn — the turn ended.',
    superseded: 'Replaced by a later request.',
    'auto-denied': 'Denied automatically — nobody answered.',
    abandoned: 'The Claude process exited before this was answered.',
    'plan-approved': 'Approved.',
    'plan-approved-note': 'Approved, with a note to bear in mind.',
    'plan-rejected': 'Sent back for more planning.',
    answered: 'Answered.',
    dismissed: 'Dismissed — Claude carries on unaided.',
};

/** Head words per kind: what the card calls itself. */
const ASK_HEAD = {
    plan: { name: 'Plan', title: 'ready to start' },
    question: { name: 'Question', title: 'waiting on you' },
};

const ASK_LABEL = {
    plan: 'A plan waiting for your approval',
    question: 'A question waiting for your answer',
};

/** Don't fire single-key shortcuts at somebody who is writing a sentence. */
const isTyping = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

/** Show, replace or clear the card for whatever the session is blocked on. */
function renderAsk() {
    clearInterval(state.askTimer);
    state.askTimer = null;
    const old = dom.log.querySelector('.perm');
    if (old) old.remove();
    if (!state.ask || state.agent) return;

    const ask = state.ask;
    const kind = ask.kind || 'tool';
    const head = ASK_HEAD[kind] || { name: ask.displayName, title: 'permission needed' };
    const card = el('div', { class: `perm perm-${kind}`, tabindex: '0',
        role: 'group', 'aria-label': ASK_LABEL[kind] || `Permission needed for ${ask.displayName}` });

    const clock = el('span', { class: 'perm-left' });
    card.append(
        el('div', { class: 'perm-head' },
            el('span', { class: 'perm-tool' }, head.name),
            el('span', { class: 'perm-title' }, head.title),
            clock),
    );

    if (ask.agentId) {
        card.append(el('div', { class: 'perm-why' }, 'Asked by a subagent.'));
    }

    if (kind === 'plan') fillPlanAsk(card, ask);
    else if (kind === 'question') fillQuestionAsk(card, ask);
    else fillToolAsk(card, ask);

    dom.log.append(card);

    // The countdown is not decoration: the ask is denied for you when it runs
    // out, and that should never arrive as a surprise.
    const tick = () => {
        const remaining = ask.expiresAt - Date.now();
        if (remaining <= 0) { clock.textContent = 'expired'; return; }
        const s = Math.ceil(remaining / 1000);
        clock.textContent = `${Math.floor(s / 60)}:${pad(s % 60)} left`;
    };
    tick();
    state.askTimer = setInterval(tick, 1000);

    // Taking focus makes the single-key answers work without a click, but only
    // when the user is actually here — stealing focus from another window, or
    // from something being typed, would be worse than a click.
    if (document.hasFocus() && !dom.input.matches(':focus')) card.focus({ preventScroll: true });
    if (state.pinned) scrollToEnd(false);
}

/** "May I run this?" — the original card, unchanged. */
function fillToolAsk(card, ask) {
    // toolSummary is the collapsed-row text of an ordinary tool block. Shape
    // the ask like the event it reads and the two render identically.
    card.append(el('div', { class: 'perm-arg' },
        toolSummary({ name: ask.tool, input: ask.input }) || ask.description || ''));

    if (ask.reason) card.append(el('div', { class: 'perm-why' }, clip(ask.reason, 220)));

    card.append(el('div', { class: 'perm-btns' },
        el('button', { class: 'perm-btn allow', type: 'button',
            onclick: () => answerAsk({ decision: 'allow' }) },
            'Allow ', el('kbd', {}, 'Y')),
        el('button', { class: 'perm-btn', type: 'button',
            onclick: () => answerAsk({ decision: 'allow-always' }) },
            `Allow ${ask.displayName} all session `, el('kbd', {}, 'A')),
        el('button', { class: 'perm-btn deny', type: 'button',
            onclick: () => answerAsk({ decision: 'deny' }) },
            'Deny ', el('kbd', {}, 'N')),
    ));

    card.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        const k = e.key.toLowerCase();
        const decision = k === 'y' ? 'allow' : k === 'a' ? 'allow-always' : k === 'n' ? 'deny' : null;
        if (!decision) return;
        e.preventDefault();
        answerAsk({ decision });
    });
}

/**
 * A plan, and the two things approving one actually decides: that the work
 * starts, and what it is allowed to do once it has.
 *
 * The session is in plan mode while this card is up, so approving without
 * changing the mode would agree to the plan and then refuse every edit in it.
 * That is why these are one button and not two steps.
 */
function fillPlanAsk(card, ask) {
    const plan = (ask.input && ask.input.plan) || ask.description || '';
    card.append(el('div', { class: 'perm-plan prose', html: renderMarkdown(plan) }));

    // `auto` is the default because it is how these sessions run when you are
    // sitting in front of one: Claude judges each call and asks when a call
    // warrants it. Blanket-accepting edits is the deliberate second choice.
    const approve = (mode) => answerAsk({ decision: 'allow', mode });
    const btns = el('div', { class: 'perm-btns' },
        el('button', { class: 'perm-btn allow', type: 'button',
            title: 'Start work, asking about calls that warrant it',
            onclick: () => approve('auto') },
            'Approve ', el('kbd', {}, 'Y')),
        el('button', { class: 'perm-btn', type: 'button',
            title: 'Start work, and let file edits through without asking',
            onclick: () => approve('acceptEdits') },
            'Approve — auto-accept edits ', el('kbd', {}, 'A')),
        el('button', { class: 'perm-btn', type: 'button',
            title: 'Approve the plan, with something to bear in mind while doing it',
            onclick: () => openFeedback(card, 'approve') },
            'Approve with feedback ', el('kbd', {}, 'F')),
        el('button', { class: 'perm-btn deny', type: 'button',
            onclick: () => openFeedback(card, 'reject') },
            'Keep planning ', el('kbd', {}, 'N')),
    );
    card.append(btns,
        el('div', { class: 'perm-why' },
            'Approving leaves plan mode and sets the permission mode under the composer.'));

    card.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        const k = e.key.toLowerCase();
        if (k === 'y') { e.preventDefault(); approve('auto'); }
        else if (k === 'a') { e.preventDefault(); approve('acceptEdits'); }
        else if (k === 'f') { e.preventDefault(); openFeedback(card, 'approve'); }
        else if (k === 'n') { e.preventDefault(); openFeedback(card, 'reject'); }
    });
}

/**
 * Say something about the plan — whether or not you are approving it.
 *
 * Both answers are a sentence rather than a verdict, and they reach the model
 * by different routes because the protocol gives them different routes. Turned
 * down, the note is the tool's error, which is where the model reads a refusal
 * — so "too broad, do the parser first" is planned against, while a silent no
 * is usually just re-sent shorter. Approved, it is appended to the plan itself,
 * because a condition you attach to a yes is part of what was agreed to.
 *
 * @param {'approve'|'reject'} how
 */
function openFeedback(card, how) {
    const btns = card.querySelector('.perm-btns');
    if (!btns || card.querySelector('.perm-feedback')) return;
    const approving = how === 'approve';

    const ta = el('textarea', { class: 'perm-fb', rows: '3',
        'aria-label': approving ? 'What should Claude bear in mind?'
            : 'What should change about this plan?',
        placeholder: approving
            ? 'Anything to bear in mind? Enter to approve, Esc to go back.'
            : 'What should change? Enter to send, Esc to go back.' });
    const send = () => answerAsk(approving
        ? { decision: 'allow', mode: 'auto', feedback: ta.value }
        : { decision: 'deny', feedback: ta.value });
    const cancel = () => { box.remove(); btns.hidden = false; card.focus({ preventScroll: true }); };

    const box = el('div', { class: 'perm-feedback' }, ta,
        el('div', { class: 'perm-btns' },
            el('button', { class: `perm-btn ${approving ? 'allow' : 'deny'}`, type: 'button',
                onclick: send },
                approving ? 'Approve with this note ' : 'Send it back ', el('kbd', {}, '⏎')),
            el('button', { class: 'perm-btn', type: 'button', onclick: cancel }, 'Cancel')));

    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });

    btns.hidden = true;
    btns.after(box);
    ta.focus();
}

/**
 * A multiple-choice question, or several.
 *
 * Native radios and checkboxes rather than clickable divs: arrow keys, space,
 * groups and labels all work without being reimplemented, and a question is
 * exactly the moment not to have reinvented a form control. Every question has
 * an "Other" row, because the honest answer is often none of the above.
 */
function fillQuestionAsk(card, ask) {
    const questions = (ask.input && ask.input.questions) || [];
    const readers = [];
    const wrap = el('div', { class: 'perm-qs' });

    questions.forEach((q, qi) => {
        const group = el('div', { class: 'perm-q', role: 'group',
            'aria-label': q.question || q.header || `Question ${qi + 1}` });
        group.append(el('div', { class: 'perm-q-head' },
            q.header ? el('span', { class: 'perm-q-chip' }, q.header) : null,
            el('span', { class: 'perm-q-text' }, q.question || '')));

        const name = `perm-q${qi}`;
        const type = q.multiSelect ? 'checkbox' : 'radio';
        const picks = [];

        for (const [oi, opt] of (q.options || []).entries()) {
            const box = el('input', { type, name, id: `${name}-o${oi}`, value: opt.label || '' });
            box.addEventListener('change', update);
            picks.push({ box, label: opt.label || '' });
            group.append(el('label', { class: 'perm-opt', for: `${name}-o${oi}` }, box,
                el('span', { class: 'perm-opt-body' },
                    el('span', { class: 'perm-opt-label' }, opt.label || ''),
                    opt.description ? el('span', { class: 'perm-opt-desc' }, opt.description) : null,
                    // Previews are for comparing, so they are readable on hover
                    // and focus too — not only once you have already chosen.
                    opt.preview ? el('pre', { class: 'perm-opt-preview' }, opt.preview) : null)));
        }

        const otherBox = el('input', { type, name, id: `${name}-other` });
        const otherText = el('input', { type: 'text', class: 'perm-other', autocomplete: 'off',
            'aria-label': `A different answer to "${q.question || ''}"`, placeholder: 'Something else…' });
        otherBox.addEventListener('change', update);
        // Typing is choosing; making people also click the radio is a trap.
        otherText.addEventListener('input', () => {
            if (otherText.value.trim()) otherBox.checked = true;
            update();
        });
        group.append(el('label', { class: 'perm-opt perm-opt-other', for: `${name}-other` }, otherBox,
            el('span', { class: 'perm-opt-body' },
                el('span', { class: 'perm-opt-label' }, 'Other'), otherText)));

        // One question's answer, as the string the model will be handed. Several
        // selections read back as a list, which is how they were asked.
        readers.push(() => {
            const chosen = picks.filter(p => p.box.checked).map(p => p.label);
            const other = otherBox.checked ? otherText.value.trim() : '';
            if (other) chosen.push(other);
            return { question: q.question, answer: chosen.join(', ') };
        });

        wrap.append(group);
    });

    const submit = el('button', { class: 'perm-btn allow', type: 'button',
        onclick: () => answerAsk({ decision: 'allow', answers: collect() }) },
        questions.length > 1 ? 'Send answers ' : 'Send answer ', el('kbd', {}, '⏎'));

    function collect() {
        const out = {};
        for (const read of readers) {
            const { question, answer } = read();
            if (answer) out[question] = answer;
        }
        return out;
    }

    // Claude asked all of them; answering some and leaving the rest to guesswork
    // is the outcome this card exists to avoid.
    function update() {
        const done = Object.keys(collect()).length;
        submit.disabled = done !== readers.length;
        submit.title = submit.disabled
            ? `${readers.length - done} still to answer`
            : '';
    }

    card.append(wrap, el('div', { class: 'perm-btns' }, submit,
        el('button', { class: 'perm-btn deny', type: 'button',
            title: 'Answer nothing and let Claude decide for itself',
            onclick: () => answerAsk({ decision: 'deny' }) },
            'Skip'),
    ));

    card.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
        if (submit.disabled) return;
        e.preventDefault();
        submit.click();
    });

    update();
}

/**
 * Send an answer.
 *
 * @param {{decision:'allow'|'allow-always'|'deny', mode?:string,
 *          answers?:object, feedback?:string}} payload
 */
async function answerAsk(payload) {
    const ask = state.ask;
    if (!ask || !state.current) return;
    const card = dom.log.querySelector('.perm');
    if (card) {
        for (const b of card.querySelectorAll('button')) b.disabled = true;
        card.dataset.pending = '1';
    }
    try {
        await post(`/api/sessions/${state.current.sessionId}/permission`,
            { requestId: ask.requestId, ...payload });
    } catch (err) {
        // 409 means another window got there first; the resolved event that
        // follows takes the card down with the right reason on it.
        toast(`Could not answer: ${err.message}`, 'error');
        if (card) {
            delete card.dataset.pending;
            for (const b of card.querySelectorAll('button')) b.disabled = false;
        }
    }
}

/** Take the card down and leave a line saying how it ended. */
function resolveAsk(outcome) {
    if (!state.ask) return;
    const head = ASK_HEAD[state.ask.kind];
    const tool = head ? head.name : state.ask.displayName;
    state.ask = null;
    renderAsk();
    const word = DECISION_WORD[outcome] || 'Answered.';
    // The transcript will carry the real record; this is only the acknowledgement
    // that the card is gone and why.
    dom.log.append(el('div', { class: 'perm-done' }, `${tool} — ${word}`));
    if (state.pinned) scrollToEnd(false);
}

// ── tools ────────────────────────────────────────────────────────────────

/** One-line summary of what a tool call is doing, shown on the collapsed row. */
function toolSummary(ev) {
    const i = ev.input || {};
    switch (ev.name) {
        case 'Bash': return i.command || i.description || '';
        case 'Read': return i.file_path + (i.offset ? `  :${i.offset}` : '');
        case 'Edit': return i.file_path;
        case 'Write': return i.file_path;
        case 'Glob': return i.pattern + (i.path ? `  in ${i.path}` : '');
        case 'Grep': return i.pattern + (i.path ? `  in ${i.path}` : '');
        case 'Task':
        case 'Agent': return i.description || clip(i.prompt, 80);
        case 'WebFetch': return i.url;
        case 'WebSearch': return i.query;
        case 'TodoWrite': return `${(i.tasks || i.todos || []).length} items`;
        case 'Skill': return '/' + (i.skill || '');
        // The first heading of a plan is what it is a plan for.
        case 'ExitPlanMode': return clip((i.plan || '').replace(/^#+\s*/, ''), 80);
        case 'AskUserQuestion':
            return (i.questions || []).map(q => q.header || q.question).join(' · ');
        case 'SendMessage': return `to ${i.to || i.recipient || '?'}`;
        default: {
            const first = Object.values(i)[0];
            return typeof first === 'string' ? clip(first, 80) : '';
        }
    }
}

function renderTool(ev) {
    const status = ev.status || 'pending';
    const summary = toolSummary(ev);

    const det = el('details', { class: 'tool', 'data-status': status },
        el('summary', {},
            el('span', { class: 'caret' }, '▶'),
            el('span', { class: 'tname' }, ev.name),
            el('span', { class: 'targ' }, summary),
            el('span', { class: 'tmeta' },
                [status === 'pending' ? 'running' : '', dur(ev.durationMs)]
                    .filter(Boolean).join('  ')),
        ),
    );

    // The body is the expensive half of a transcript — highlighted code, diffs,
    // rendered markdown — and it sits behind a summary that is closed by
    // default. Most tool calls are never opened, so build it on first expand.
    det.append(el('div', { class: 'tool-body' }));
    // `click` lands before the open state is applied, so the body is there in
    // the same frame the block expands. `toggle` is the backstop for opens that
    // do not come from a click — find-in-page, or `open` set in code.
    det.addEventListener('click', () => fillTool(det, ev));
    det.addEventListener('toggle', () => fillTool(det, ev));
    return row(ev, 'tool', det);
}

/** Build a tool's body the first time it is actually shown. */
function fillTool(det, ev) {
    const body = det.querySelector('.tool-body');
    if (!body || body.dataset.filled) return;
    body.dataset.filled = '1';
    body.append(...toolBody(ev));
}

function toolBody(ev) {
    const out = [];
    const i = ev.input || {};
    const r = ev.result || {};

    // --- input ------------------------------------------------------------
    if (ev.name === 'Bash') {
        out.push(section('Command', codePre(i.command || '', 'bash')));
        if (i.run_in_background) out.push(note('Runs in the background.'));
    } else if (ev.name === 'Write') {
        out.push(section('Contents', codePre(i.content || '', langOf(i.file_path))));
    } else if (ev.name === 'Edit') {
        // The summary row already names the file; don't say it twice.
        if (r.patch) out.push(section('Changes', diffView(r.patch)));
        else {
            out.push(section('Replace', codePre(i.old_string || '', langOf(i.file_path))));
            out.push(section('With', codePre(i.new_string || '', langOf(i.file_path))));
        }
    } else if (ev.name === 'TodoWrite') {
        out.push(section('Tasks', todoView(i.tasks || i.todos || [])));
    } else if (ev.name === 'Task' || ev.name === 'Agent') {
        out.push(section('Prompt', el('div', { class: 'prose', html: renderMarkdown(i.prompt || '') })));
    } else if (ev.name === 'ExitPlanMode') {
        // The card is long gone by the time anyone reads this back; the plan
        // that was approved is the whole content of the call.
        out.push(section('Plan', el('div', { class: 'prose', html: renderMarkdown(i.plan || '') })));
    } else if (ev.name === 'AskUserQuestion') {
        out.push(section('Questions', questionsView(i.questions || [])));
    } else if (Object.keys(i).length) {
        out.push(section('Input', kvView(i)));
    }

    // --- output -----------------------------------------------------------
    if (ev.name === 'Write' || (ev.name === 'Edit' && r.patch)) {
        // The diff above already is the outcome; don't repeat the file body.
        if (ev.status === 'error') out.push(section('Error', codePre(r.text || '', null, true)));
    } else if (r.patch && ev.name !== 'Edit') {
        out.push(section('Changes', diffView(r.patch)));
    } else if (r.stdout || r.stderr) {
        if (r.stdout) out.push(section('stdout', codePre(r.stdout, null)));
        if (r.stderr) out.push(section('stderr', codePre(r.stderr, null, true)));
    } else if (r.text) {
        out.push(section(ev.status === 'error' ? 'Error' : 'Result',
            codePre(r.text, null, ev.status === 'error')));
    } else if (ev.status === 'pending') {
        out.push(note('Still running.'));
    }

    if (r.interrupted) out.push(note('Interrupted before it finished.'));
    if (r.backgroundTaskId) out.push(note(`Background task ${r.backgroundTaskId}.`));

    // --- spilled output ------------------------------------------------------
    if (ev.persistedPath) {
        const btn = el('button', { class: 'more-btn', type: 'button' }, 'Load full output');
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Loading…';
            try {
                const d = await get(`/api/sessions/${state.current.sessionId}/output`
                    + `?path=${encodeURIComponent(ev.persistedPath)}`);
                btn.replaceWith(codePre(d.text + (d.truncated ? '\n\n… truncated' : ''), null));
            } catch (err) {
                btn.disabled = false;
                btn.textContent = 'Load full output';
                toast(`Could not read the saved output: ${err.message}`, 'error');
            }
        });
        out.push(el('div', { class: 'tool-section' }, btn));
    }

    // --- subagent -------------------------------------------------------------
    if (ev.agent) {
        const a = ev.agent;
        const st = statusOfCall(ev);
        const meta = [STATUS_WORD[st], a.agentType, a.model && shortModel(a.model),
            a.toolUses && `${a.toolUses} tools`, dur(a.durationMs)].filter(Boolean).join(' · ');
        const wrap = el('div', { class: 'tool-section subagent', 'data-status': st },
            el('h4', {}, 'Subagent'),
            el('div', { class: 'subagent-meta' }, meta));

        if (a.hasTranscript) {
            const btns = el('div', { class: 'subagent-btns' });
            // Two ways in on purpose: a peek that keeps your place in this
            // conversation, and a switch for when the subagent is the thing you
            // actually came to read.
            btns.append(el('button', {
                class: 'more-btn primary', type: 'button',
                onclick: () => openAgent(ev.id),
            }, 'Open this subagent'));

            const btn = el('button', { class: 'more-btn', type: 'button' }, 'Peek inline');
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Loading…';
                try {
                    const d = await get(`/api/sessions/${state.current.sessionId}/subagent`
                        + `?toolUseId=${encodeURIComponent(ev.id)}`);
                    const log = el('div', { class: 'subagent-log' });
                    for (const sub of d.events) {
                        const n = renderEvent(sub);
                        if (n) log.append(n);
                    }
                    btn.replaceWith(log);
                } catch (err) {
                    btn.disabled = false;
                    btn.textContent = 'Peek inline';
                    toast(`Could not load the subagent transcript: ${err.message}`, 'error');
                }
            });
            btns.append(btn);
            wrap.append(btns);
        }
        out.push(wrap);
    }

    return out;
}

function section(title, node) {
    return el('div', { class: 'tool-section' }, el('h4', {}, title), node);
}

function note(text) {
    return el('div', { class: 'tool-section',
        style: 'font:400 11.5px/1.5 var(--mono); color:var(--text-4)' }, text);
}

function codePre(text, lang, isError) {
    const s = String(text == null ? '' : text);
    const MAX = 40000;
    const shown = s.length > MAX ? s.slice(0, MAX) : s;
    const pre = el('pre', { class: 'io' + (isError ? ' err' : ''),
        html: lang ? highlight(shown, lang) : escapeHtml(shown) });
    if (s.length > MAX) {
        const wrap = el('div', {}, pre);
        const btn = el('button', { class: 'more-btn', type: 'button' },
            `Show the remaining ${(s.length - MAX).toLocaleString()} characters`);
        btn.addEventListener('click', () => {
            pre.innerHTML = lang ? highlight(s, lang) : escapeHtml(s);
            btn.remove();
        });
        wrap.append(btn);
        return wrap;
    }
    return pre;
}

function langOf(path) {
    const ext = String(path || '').split('.').pop().toLowerCase();
    return ({ ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
        json: 'json', css: 'css', scss: 'scss', html: 'html', svelte: 'html',
        vue: 'html', py: 'py', sh: 'sh', bash: 'sh', sql: 'sql', yml: 'yaml',
        yaml: 'yaml', go: 'go', rs: 'rust', cs: 'cs', md: null })[ext] || null;
}

function diffView(patch) {
    const box = el('div', { class: 'diff' });
    for (const hunk of patch) {
        box.append(el('div', { class: 'hunk' },
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`));
        for (const line of hunk.lines || []) {
            const c = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
            box.append(el('div', { class: `dl ${c}` }, line || ' '));
        }
    }
    return box;
}

function todoView(items) {
    const list = el('div', { style: 'font:400 12px/1.7 var(--mono)' });
    for (const t of items) {
        const st = t.status || t.state || 'pending';
        const mark = st === 'completed' ? '✓' : st === 'in_progress' ? '▸' : '○';
        const color = st === 'completed' ? 'var(--green)'
            : st === 'in_progress' ? 'var(--yellow)' : 'var(--text-4)';
        list.append(el('div', { style: `color:${st === 'completed' ? 'var(--text-4)' : 'var(--text)'}` },
            el('span', { style: `color:${color}; margin-right:8px` }, mark),
            t.subject || t.content || t.description || t.activeForm || ''));
    }
    return list;
}

/**
 * What was asked, read back later.
 *
 * The answer is not here — it is in the tool result, which says what was picked
 * — so this stays a record of the question and the choices it offered.
 */
function questionsView(questions) {
    const list = el('div', { class: 'qview' });
    for (const q of questions) {
        list.append(el('div', { class: 'qview-q' },
            q.header ? el('span', { class: 'perm-q-chip' }, q.header) : null,
            el('span', {}, q.question || '')));
        for (const opt of q.options || []) {
            list.append(el('div', { class: 'qview-o' },
                el('span', { class: 'qview-mark' }, '○'),
                el('span', {}, opt.label || '')));
        }
    }
    return list;
}

function kvView(obj) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of Object.entries(obj)) {
        const text = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
        dl.append(el('dt', {}, k), el('dd', {}, clip(text, 600)));
    }
    return dl;
}

// ── subagents ────────────────────────────────────────────────────────────
// A subagent is a conversation the session had on its own. Two things about it
// are worth seeing without opening it — whether it is still going, and what it
// is doing — and those come from two different places. Whether the call
// finished is in *this* transcript, as the result of the tool that spawned it,
// which the client already has and which updates live. What the agent is doing
// is in the agent's own file, which only the bridge can see.

const STATUS_WORD = { running: 'running', done: 'finished', failed: 'failed' };

/** How the tool call that spawned an agent ended. */
function statusOfCall(ev) {
    if (!ev || ev.status === 'pending') return 'running';
    return ev.status === 'error' ? 'failed' : 'done';
}

async function loadAgents() {
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
function agentRows() {
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

function renderAgents() {
    const rows = agentRows();
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

/** Switch the conversation pane over to one subagent's transcript. */
async function openAgent(toolUseId) {
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
    } catch (err) {
        toast(`Could not open the subagent: ${err.message}`, 'error');
    }
}

/** Reset subagent state without touching the DOM — for switching sessions. */
function leaveAgent() {
    state.agent = null;
    state.agentOffset = 0;
    state.agentNodes.clear();
    state.agentTools.clear();
    dom.agentLog.replaceChildren();
    dom.scroll.hidden = false;
    dom.agentScroll.hidden = true;
    dom.turns.hidden = false;
    dom.btnBack.hidden = true;
    applyComposerScope();
}

/** Back to the session that spawned it. */
function closeAgent() {
    if (!state.agent) return;
    leaveAgent();
    renderHeader();
    renderAgents();
    subscribe();        // stop the bridge following a file nobody is reading
}

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
    if (onAgent) {
        dom.btnSend.disabled = true;
        dom.btnStop.hidden = true;
        renderQueue(state.runner);   // the session's queue is not the agent's business
    } else {
        dom.btnSend.disabled = !state.current;
        applyRunner(state.runner);
    }
}

// ── dev-server channel strip ─────────────────────────────────────────────

async function loadChannels() {
    if (!state.current) return;
    const id = state.current.sessionId;
    try {
        const { ports } = await get(`/api/sessions/${id}/devservers`);
        if (!state.current || state.current.sessionId !== id) return;
        state.channels = ports;
        renderChannels();
    } catch {
        // A missing channel strip is not worth interrupting the user over.
    }
}

function renderChannels() {
    dom.channels.replaceChildren();
    for (const p of state.channels) {
        const btn = el('button', {
            class: 'channel',
            type: 'button',
            'data-live': String(p.listening),
            title: p.evidence ? `${p.evidence.from}: ${p.evidence.command}` : '',
            onclick: () => openInDevBrowser(p, btn),
        },
            el('span', { class: 'led' }),
            el('span', { class: 'port' }, ':' + p.port),
            p.title ? el('span', { class: 'name' }, p.title) : null,
            el('span', { class: 'go' }, p.listening ? 'Open' : 'Gone'),
        );
        dom.channels.append(btn);
    }
}

async function openInDevBrowser(p, btn) {
    btn.classList.add('busy');
    const go = btn.querySelector('.go');
    const was = go.textContent;
    go.textContent = 'Opening';
    try {
        const r = await post('/api/devbrowser/open', {
            port: p.port,
            // Give the tab a name if the transcript knew one and DevBrowser did not.
            title: !p.titled && p.title ? p.title : undefined,
        });
        go.textContent = 'Open';
        if (r.launched) toast(`Started DevBrowser and switched to :${p.port}.`, 'ok');
    } catch (err) {
        go.textContent = was;
        toast(`Could not switch to :${p.port}. ${err.message}`, 'error');
    } finally {
        btn.classList.remove('busy');
    }
}

async function refreshDevBrowser() {
    try {
        const s = await get('/api/devbrowser/status');
        dom.dbStatus.dataset.up = String(!!s.running);
        dom.dbLabel.textContent = s.running ? `DevBrowser :${s.port}` : 'DevBrowser off';
    } catch {
        dom.dbStatus.dataset.up = 'false';
        dom.dbLabel.textContent = 'DevBrowser off';
    }
}

/**
 * Mark the window when it is talking to a development bridge. Two identical
 * windows side by side, one with real sessions in it, is asking for trouble.
 */
async function markInstance() {
    try {
        const h = await get('/api/health');
        state.dev = !!h.dev;
        // Starting a session that only this instance will list is a development
        // affordance; offering it in the everyday window would be offering to
        // hide a real conversation from the window you are standing in.
        dom.newTestRow.hidden = !state.dev;
        if (!h.dev) return;
        document.title = `Claude Sessions — dev :${h.port}`;
        document.querySelector('.wordmark').append(
            el('span', { class: 'dev-badge', title: `Development bridge on port ${h.port}` },
                `dev :${h.port}`));
    } catch { /* the status line already reports an unreachable bridge */ }
}

// ── streaming ────────────────────────────────────────────────────────────

function connect() {
    const es = new EventSource('/api/events');

    es.addEventListener('hello', (e) => {
        state.clientId = JSON.parse(e.data).clientId;
        if (state.current) subscribe();
    });

    es.addEventListener('tail', (e) => {
        const d = JSON.parse(e.data);
        if (!state.current || d.sessionId !== state.current.sessionId) return;
        state.offset = d.offset;
        const stick = state.pinned;
        appendEvents(d.events, SESSION_VIEW);
        // The session pane keeps growing behind a subagent; don't yank the
        // subagent's scroll position around for it.
        if (stick && !state.agent) scrollToEnd(false);
    });

    es.addEventListener('agent-tail', (e) => {
        const d = JSON.parse(e.data);
        if (!state.agent || d.toolUseId !== state.agent) return;
        if (!state.current || d.sessionId !== state.current.sessionId) return;
        state.agentOffset = d.offset;
        const sc = dom.agentScroll;
        const stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90;
        appendEvents(d.events, AGENT_VIEW);
        if (stick) sc.scrollTop = sc.scrollHeight;
    });

    es.addEventListener('agent-reset', (e) => {
        const d = JSON.parse(e.data);
        if (!state.agent || d.toolUseId !== state.agent) return;
        const id = state.agent;
        state.agent = null;         // force openAgent to rebuild from the top
        openAgent(id);
    });

    es.addEventListener('reset', () => {
        if (state.current) {
            const id = state.current.sessionId;
            state.current = null;
            openSession(id);
        }
    });

    es.addEventListener('sessions-changed', () => loadSessions());

    // Someone deleted a session — possibly in another window, possibly this one.
    es.addEventListener('session-deleted', (e) => {
        const d = JSON.parse(e.data);
        const wasOpen = state.current && state.current.sessionId === d.sessionId;
        // Read before forgetSession, which takes the dialog down: this event can
        // beat the answer to our own DELETE back.
        const mine = state.pendingDelete && state.pendingDelete.sessionId === d.sessionId;
        forgetSession(d.sessionId);
        // Only worth saying when the conversation vanished from under someone;
        // the window that did the deleting has already had its own toast.
        if (wasOpen && !mine) {
            toast(`“${clip(d.title || 'That session', 40)}” was deleted.`, 'warn');
        }
    });

    es.addEventListener('runner-status', (e) => {
        const s = JSON.parse(e.data);
        if (state.current && s.sessionId === state.current.sessionId) applyRunner(s);
        // The rail's own copy, so a rebuild from the held order draws what the
        // patch below already put on screen rather than reverting it.
        const row = state.sessions.find(x => x.sessionId === s.sessionId);
        if (row) row.runner = { state: s.state, activity: s.activity, queued: s.queued };
        const strip = dom.rail.querySelector(`[data-id="${CSS.escape(s.sessionId)}"]`);
        if (strip && row) patchStripStatus(strip, row);
    });

    es.addEventListener('permission-request', (e) => {
        const p = JSON.parse(e.data);
        if (!state.current || p.sessionId !== state.current.sessionId) return;
        state.ask = p;
        renderAsk();
    });

    es.addEventListener('permission-resolved', (e) => {
        const p = JSON.parse(e.data);
        if (!state.ask || state.ask.requestId !== p.requestId) return;
        resolveAsk(p.outcome);
    });

    es.addEventListener('notice', (e) => {
        const n = JSON.parse(e.data);
        toast(n.text, n.level === 'warn' ? 'warn' : 'info', 7000);
    });

    es.addEventListener('turn-complete', (e) => {
        const r = JSON.parse(e.data);
        state.unsent.delete(r.sessionId);   // it is in the transcript now
        if (!state.current || r.sessionId !== state.current.sessionId) return;
        // The dev servers a turn started only become visible once it finishes.
        loadChannels();
        loadAgents();
    });

    es.addEventListener('send-failed', (e) => handleSendFailure(JSON.parse(e.data)));

    es.addEventListener('session-forked', (e) => {
        const { from, to } = JSON.parse(e.data);
        state.unsent.delete(from);
        if (!state.current || state.current.sessionId !== from) return;
        toast('Branched off a copy — following the new session.', 'ok');
        // The original keeps running elsewhere; the copy is where this turn goes.
        openSessionSoon(to);
    });

    es.onerror = () => {
        dom.statusText.textContent = 'Reconnecting to the bridge…';
        dom.statusLine.dataset.state = 'error';
    };
}

async function subscribe() {
    if (!state.clientId) return;
    try {
        // A null session is a real answer, not a no-op: it is how the bridge is
        // told to stop tailing a transcript nobody is looking at any more.
        await post('/api/subscribe', {
            clientId: state.clientId,
            sessionId: state.current ? state.current.sessionId : null,
            offset: state.offset,
            agent: state.agent
                ? { toolUseId: state.agent, offset: state.agentOffset }
                : null,
        });
    } catch { /* the SSE reconnect will re-subscribe */ }
}

function applyRunner(s) {
    state.runner = s;
    const busy = s && (s.state === 'busy' || s.state === 'starting');
    const retrying = Boolean(s && s.retry);

    // The status carries the pending ask too, so a window opening onto a session
    // that is already blocked draws the card without having seen the event.
    const ask = (s && s.pendingPermission) || null;
    const same = ask && state.ask && ask.requestId === state.ask.requestId;
    // Redraw on any change, and also when the card should be up but is not —
    // coming back from a subagent leaves the log without one.
    if (!same || (ask && !dom.log.querySelector('.perm'))) {
        state.ask = ask;
        renderAsk();
    }

    // Approving a plan changes the mode out from under the selector, so the
    // selector follows the bridge. Only on a change the bridge reports, though:
    // a mode picked here and not yet sent is a choice, not a stale value, and
    // reasserting the running process's mode over it would undo it as it is typed.
    if (s && s.permissionMode && s.permissionMode !== state.runnerMode) {
        state.runnerMode = s.permissionMode;
        if (dom.perm.value !== s.permissionMode) dom.perm.value = s.permissionMode;
    }

    dom.statusLine.dataset.state = s
        ? (s.state === 'error' ? 'error' : ask ? 'ask' : retrying ? 'stalled' : busy ? 'busy' : 'idle')
        : 'idle';
    // While a subagent is on screen the composer belongs to nothing you can
    // send to, so its controls stay out of the way.
    dom.btnStop.hidden = !busy || Boolean(state.agent);
    dom.btnSend.disabled = !state.current || Boolean(state.agent);
    // Say what the button will actually do. While a turn is running the message
    // joins the queue rather than going anywhere, and that is worth admitting
    // before the click, not after.
    dom.btnSend.textContent = busy && !state.agent ? 'Queue' : 'Send';
    applyQueue(s);

    // The escalation is armed against one turn. Once that turn is over the
    // button must not still be offering to kill the next one.
    if (!busy && state.stopArmed) {
        state.stopArmed = 0;
        dom.btnStop.textContent = 'Stop';
        dom.btnStop.classList.remove('force');
    }

    // A turn can run for minutes; without a clock it is impossible to tell a
    // long tool call from a stuck one.
    clearInterval(state.busyTimer);
    state.busyTimer = null;
    if (busy && s.busySince) {
        state.busyTimer = setInterval(() => paintStatus(state.runner), 1000);
    }
    paintStatus(s);
}

function paintStatus(s) {
    const busy = s && (s.state === 'busy' || s.state === 'starting');

    if (s && s.state === 'error' && s.error) {
        dom.statusText.replaceChildren(el('span', { class: 'err' }, clip(s.error, 140)));
        return;
    }
    if (busy) {
        const elapsed = s.busySince ? ` · ${dur(Date.now() - s.busySince)}` : '';
        const label = s.activity || 'Working…';
        if (s.retry) {
            dom.statusText.replaceChildren(
                el('span', { class: 'warn' }, label),
                el('span', {}, elapsed),
                el('span', { class: 'muted' }, ' · Stop to give up early'));
        } else {
            dom.statusText.textContent = label + elapsed;
        }
        return;
    }
    const r = s && s.lastResult;
    if (r && r.isError) {
        dom.statusText.replaceChildren(
            el('span', { class: 'err' }, clip(r.detail || 'The turn ended with an error.', 140)));
    } else if (r && r.costUsd) {
        dom.statusText.textContent =
            `Ready · last turn ${dur(r.durationMs)} · $${r.costUsd.toFixed(3)}`;
    } else {
        dom.statusText.textContent = 'Ready';
    }
}

function scrollToEnd(instant) {
    const sc = dom.scroll;
    if (instant) {
        const prev = sc.style.scrollBehavior;
        sc.style.scrollBehavior = 'auto';
        sc.scrollTop = sc.scrollHeight;
        sc.style.scrollBehavior = prev;
    } else {
        sc.scrollTop = sc.scrollHeight;
    }
}

// ── turn rail ────────────────────────────────────────────────────────────
// A tick per thing you said, down the right edge of the transcript. Hovering
// reads the message back; clicking jumps to it. Built from the rendered log,
// so a session streaming in a terminal grows its rail as it goes.

function turnText(ev) {
    if (ev.command) return `/${ev.command.name}${ev.command.args ? ' ' + ev.command.args : ''}`;
    return (ev.text || '').trim() || '(image only)';
}

/** Like clip(), but keeps line breaks — the popover renders them. */
function clipLines(s, n) {
    const t = String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function renderTurns() {
    state.turns = [];
    for (const entry of state.nodes.values()) {
        if (entry.ev.kind === 'user') state.turns.push(entry);
    }
    state.activeTurn = -1;

    const total = state.turns.length;
    dom.turns.replaceChildren(...state.turns.map((t, i) => el('button', {
        class: 'turn-tick',
        type: 'button',
        'aria-label': `Turn ${i + 1} of ${total}: ${clip(turnText(t.ev), 60)}`,
        onclick: () => jumpToTurn(t),
        onmouseenter: (e) => showTurnPop(e.currentTarget, i),
        onmouseleave: hideTurnPop,
        onfocus: (e) => showTurnPop(e.currentTarget, i),
        onblur: hideTurnPop,
    })));
    markActiveTurn();
}

function showTurnPop(tick, i) {
    const t = state.turns[i];
    if (!t) return;
    const pop = dom.turnPop;
    const isCmd = Boolean(t.ev.command);

    pop.replaceChildren(
        el('div', { class: 'pop-head' },
            el('span', {}, `Turn ${i + 1} of ${state.turns.length}`),
            el('span', { class: 'when' }, clockOf(t.ev.ts)),
        ),
        el('div', { class: 'pop-text' + (isCmd ? ' cmd' : '') },
            clipLines(turnText(t.ev), 460)),
    );
    pop.hidden = false;

    // Sits to the left of the rail, centred on its tick, kept on screen.
    const r = tick.getBoundingClientRect();
    const h = pop.offsetHeight;
    pop.style.top = `${Math.min(Math.max(8, r.top + r.height / 2 - h / 2),
        Math.max(8, window.innerHeight - h - 8))}px`;
    pop.style.left = `${Math.max(8, r.left - pop.offsetWidth - 10)}px`;
}

function hideTurnPop() {
    dom.turnPop.hidden = true;
}

function jumpToTurn(t) {
    hideTurnPop();
    const sc = dom.scroll;
    const top = t.node.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = Math.max(0, top - 14);
    state.pinned = false;

    t.node.classList.remove('flash');
    void t.node.offsetWidth;    // restart the animation when the same tick is clicked twice
    t.node.classList.add('flash');
    setTimeout(() => t.node.classList.remove('flash'), 1400);
}

/** Whichever turn the transcript is currently sitting in. */
function markActiveTurn() {
    if (!state.turns.length) return;
    const edge = dom.scroll.getBoundingClientRect().top + 60;
    let active = 0;
    for (let i = 0; i < state.turns.length; i++) {
        if (state.turns[i].node.getBoundingClientRect().top > edge) break;
        active = i;
    }
    if (active === state.activeTurn) return;
    state.activeTurn = active;

    const ticks = dom.turns.children;
    for (let i = 0; i < ticks.length; i++) {
        if (i === active) ticks[i].setAttribute('aria-current', 'true');
        else ticks[i].removeAttribute('aria-current');
    }

    // Keep the marked tick visible when there are more turns than rail.
    const tick = ticks[active];
    if (!tick) return;
    const railH = dom.turns.clientHeight;
    if (tick.offsetTop < dom.turns.scrollTop
        || tick.offsetTop + tick.offsetHeight > dom.turns.scrollTop + railH) {
        dom.turns.scrollTop = tick.offsetTop - railH / 2;
    }
}

// ── send queue ───────────────────────────────────────────────────────────
// One turn runs at a time, so anything you write while an agent is working
// waits. The bridge holds those messages instead of pushing them straight down
// stdin, which is what makes them showable here: still yours, still editable,
// still droppable. Once a message has gone to the process it is on its way to
// the transcript and it leaves this list — nothing here pretends to cancel
// something that has already been sent.

/** Take the bridge's view of the queue and repaint. */
function applyQueue(s) {
    state.queue = (s && s.queue) || [];
    for (const id of state.queueOpen) {
        if (!state.queue.some(q => q.id === id)) state.queueOpen.delete(id);
    }
    renderQueue(s);
}

function renderQueue(s) {
    const q = state.queue;
    // While a subagent is on screen the composer belongs to nothing you can send
    // to, so its queue is out of scope too.
    const show = q.length > 0 && !state.agent;
    dom.queue.hidden = !show;
    if (!show) {
        dom.queueList.replaceChildren();
        state.queueSig = '';
        return;
    }

    const busy = s && (s.state === 'busy' || s.state === 'starting');
    dom.queueCount.textContent = q.length === 1
        ? (busy ? '1 message waiting for this turn to finish' : '1 message waiting')
        : `${q.length} messages waiting${busy ? ', in this order' : ''}`;
    dom.queueClear.textContent = q.length === 1 ? 'Drop it' : 'Drop all';

    // Runner status arrives every time the activity line moves, several times a
    // turn. Rebuilding the chips on each one would throw away focus, an expanded
    // message and any drag in progress, so only rebuild when the queue itself
    // actually changed.
    if (state.queueDrag) return;   // the drag owns the DOM until it ends
    const sig = q.map(x => x.id).join(',') + '|' + [...state.queueOpen].sort().join(',');
    if (sig === state.queueSig && dom.queueList.children.length === q.length) return;
    state.queueSig = sig;

    // Keep the keyboard where it was: reordering with Alt+arrows repaints the
    // list under the very control being used.
    const active = document.activeElement;
    const held = active && active.closest && active.closest('.queue-item');
    const holdId = held ? held.dataset.id : null;
    const holdPart = held ? active.dataset.part : null;

    dom.queueList.replaceChildren(...q.map((entry, i) => queueItem(entry, i, rovingId())));

    if (holdId) {
        const back = dom.queueList.querySelector(`[data-id="${CSS.escape(holdId)}"]`);
        const target = back && (holdPart ? back.querySelector(`[data-part="${holdPart}"]`) : back);
        if (target) target.focus();
    }
}

/**
 * Which chip Shift+Tab out of the composer lands on.
 *
 * The last one, because that is the message you just wrote and the one the
 * composer sits directly beneath — and because it is what the browser would pick
 * anyway, the queue being above the input in the document. After that it follows
 * you: arrow to a chip and it stays the way back in.
 */
function rovingId() {
    const q = state.queue;
    if (!q.length) return null;
    const remembered = q.some(x => x.id === state.queueFocus) ? state.queueFocus : null;
    return remembered || q[q.length - 1].id;
}

/** Move the single tab stop without rebuilding the chips. */
function setRovingTab() {
    const id = rovingId();
    for (const li of dom.queueList.children) {
        li.tabIndex = li.dataset.id === id ? 0 : -1;
    }
}

function focusChipAt(i) {
    const li = dom.queueList.children[i];
    if (!li) return false;
    state.queueFocus = li.dataset.id;
    setRovingTab();
    li.focus();
    return true;
}

/**
 * One chip is one tab stop, and the chip itself takes the keys.
 *
 * The obvious markup — three buttons per row — puts Shift+Tab out of the composer
 * on the *drop* button of the last message, which is both surprising and the one
 * control there you would least like to hit by accident. So the row is the
 * focusable thing, its buttons are taken out of the tab order, and everything
 * they do has a key on the row instead.
 */
function queueItem(entry, i, roving) {
    const open = state.queueOpen.has(entry.id);
    const toggleOpen = () => {
        if (open) state.queueOpen.delete(entry.id);
        else state.queueOpen.add(entry.id);
        renderQueue(state.runner);
    };

    const li = el('li', {
        class: 'queue-item' + (open ? ' open' : ''),
        'data-id': entry.id,
        draggable: 'true',
        tabindex: entry.id === roving ? '0' : '-1',
        'aria-label': `Waiting message ${i + 1} of ${state.queue.length}: ${clip(entry.text, 80)}`,
        onfocus: () => { state.queueFocus = entry.id; setRovingTab(); },
        onkeydown: (e) => onChipKey(e, entry, i, toggleOpen),
    },
        el('span', { class: 'queue-grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⠿'),
        el('span', { class: 'queue-n' }, String(i + 1)),
        el('button', {
            class: 'queue-text', type: 'button', 'data-part': 'text', tabindex: '-1',
            title: open ? 'Show less' : 'Show the whole message',
            onclick: toggleOpen,
        }, open ? entry.text : clip(entry.text, 110)),
        el('div', { class: 'queue-acts' },
            el('button', {
                class: 'queue-act', type: 'button', 'data-part': 'edit', tabindex: '-1',
                title: 'Take it out of the queue and back into the box',
                onclick: () => editQueued(entry),
            }, 'Edit'),
            el('button', {
                class: 'queue-act danger', type: 'button', 'data-part': 'drop', tabindex: '-1',
                title: 'Drop this message', 'aria-label': `Drop waiting message ${i + 1}`,
                onclick: () => dropQueued(entry),
            }, '×'),
        ),
    );

    li.addEventListener('dragstart', (e) => {
        state.queueDrag = entry.id;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox ignores a drag with nothing on the transfer.
        e.dataTransfer.setData('text/plain', entry.id);
    });
    li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        state.queueDrag = null;
        commitQueueOrder();
    });
    return li;
}

/**
 * The keys on a focused chip.
 *
 * | ↑ ↓ | move between waiting messages |
 * | Alt+↑ Alt+↓ | move the message itself |
 * | Enter | take it back to the composer to reword |
 * | Esc | drop it |
 * | Space | show the whole message |
 *
 * Enter and Esc are the two things you actually want mid-turn — "I said that
 * wrong" and "never mind" — so they are the unmodified keys.
 */
function onChipKey(e, entry, i, toggleOpen) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        // Alt moves the message; on its own the key moves you.
        if (e.altKey) moveQueued(entry.id, dir);
        else focusChipAt(i + dir);
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        editQueued(entry);
        return;
    }
    if (e.key === 'Escape') {
        // Escape closes the new-session dialog and leaves a subagent; while a
        // chip has the focus it belongs to the chip.
        e.preventDefault();
        e.stopPropagation();
        dropQueued(entry, { fromKeyboard: true, index: i });
        return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();   // otherwise the transcript scrolls behind it
        toggleOpen();
    }
}

/**
 * Reordering moves the row under the cursor as you go, so the list you drop on
 * is the list you get. The bridge is told once, on drop.
 */
function onQueueDragOver(e) {
    if (!state.queueDrag) return;
    e.preventDefault();
    const dragged = dom.queueList.querySelector('.dragging');
    const over = e.target.closest && e.target.closest('.queue-item');
    if (!dragged || !over || over === dragged) return;
    const box = over.getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    dom.queueList.insertBefore(dragged, after ? over.nextSibling : over);
    renumberQueue();
}

function renumberQueue() {
    [...dom.queueList.children].forEach((li, i) => {
        const n = li.querySelector('.queue-n');
        if (n) n.textContent = String(i + 1);
    });
}

/** Nudge one message up or down the queue, keeping the keyboard focus on it. */
async function moveQueued(id, delta) {
    if (!state.current) return;
    const ids = state.queue.map(q => q.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    try {
        const r = await post(`/api/sessions/${state.current.sessionId}/queue/reorder`, { ids });
        applyRunner(r.status);
        // Follow the message, not the position: holding Alt+↑ should keep walking
        // the same message up the queue.
        const moved = dom.queueList.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (moved) { state.queueFocus = id; setRovingTab(); moved.focus(); }
    } catch (err) {
        toast(`Could not reorder the queue: ${err.message}`, 'error');
    }
}

async function commitQueueOrder() {
    if (!state.current) return;
    const ids = [...dom.queueList.children].map(li => li.dataset.id);
    if (ids.join() === state.queue.map(q => q.id).join()) return;
    try {
        const r = await post(`/api/sessions/${state.current.sessionId}/queue/reorder`, { ids });
        applyRunner(r.status);
    } catch (err) {
        toast(`Could not reorder the queue: ${err.message}`, 'error');
        renderQueue(state.runner);   // back to what the bridge actually has
    }
}

async function dropQueued(entry, { fromKeyboard = false, index = 0 } = {}) {
    if (!state.current) return;
    try {
        const r = await del(`/api/sessions/${state.current.sessionId}/queue/${entry.id}`);
        applyRunner(r.status);
        // No toast: the chip disappearing where you clicked is the feedback, and
        // *Edit* next to it is the non-destructive way out.
        //
        // Dropping from the keyboard has to say where the focus went, or it lands
        // on the body and the next Escape closes something else entirely. Stay on
        // the row that took this one's place; if that was the last message, the
        // panel is gone and the composer is where you were headed anyway.
        if (fromKeyboard && !focusChipAt(Math.min(index, state.queue.length - 1))) {
            dom.input.focus();
        }
    } catch (err) {
        toast(err.message, 'warn');
        refreshQueue();
    }
}

/** Pull a waiting message back into the composer, where it can be rewritten. */
async function editQueued(entry) {
    if (!state.current) return;
    try {
        const r = await del(`/api/sessions/${state.current.sessionId}/queue/${entry.id}`);
        applyRunner(r.status);
        restoreToComposer(entry.text);
    } catch (err) {
        toast(err.message, 'warn');
        refreshQueue();
    }
}

async function clearQueue() {
    if (!state.current || !state.queue.length) return;
    const dropped = state.queue.map(q => q.text);
    try {
        const r = await del(`/api/sessions/${state.current.sessionId}/queue`);
        if (r.status) applyRunner(r.status); else applyQueue(null);
        toast(dropped.length === 1 ? 'Message dropped.' : `${dropped.length} messages dropped.`,
            'info', {
                action: {
                    label: 'Undo',
                    onClick: async () => { for (const t of dropped) await sendMessage({ text: t }); },
                },
            });
    } catch (err) {
        toast(`Could not clear the queue: ${err.message}`, 'error');
        refreshQueue();
    }
}

/** Re-read the queue after a failed edit, so the view is never ahead of the bridge. */
async function refreshQueue() {
    if (!state.current) return;
    try {
        const r = await get(`/api/sessions/${state.current.sessionId}/queue`);
        applyQueue(r.status || { queue: r.queue });
    } catch { /* the next runner-status will fix it */ }
}

// ── composer ─────────────────────────────────────────────────────────────

/**
 * Size a textarea to its contents.
 *
 * `height: auto` first so the box can shrink again — scrollHeight never reports
 * less than the height already set, so measuring without clearing it makes a
 * textarea that only ever grows.
 */
function grow(ta, min, max) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(min, Math.min(max, ta.scrollHeight)) + 'px';
}

// Never below the button height, so an empty composer stays centred.
const autoGrow = () => grow(dom.input, 38, 220);

// The dialog's own limits: two lines to start, and a ceiling low enough that a
// pasted-in briefing cannot push the Start button off the bottom of the modal.
const growPrompt = () => grow(dom.newPrompt, 62, 300);

async function sendMessage({ fork = false, text: override = null } = {}) {
    const text = override != null ? override : dom.input.value.trim();
    if (!text || !state.current) return;
    const sessionId = state.current.sessionId;

    if (override == null) { dom.input.value = ''; autoGrow(); }
    saveDraft(sessionId, '');
    dom.btnSend.disabled = true;

    try {
        const r = await post(`/api/sessions/${sessionId}/send`, {
            text,
            fork,
            model: dom.model.value || null,
            permissionMode: dom.perm.value,
        });
        // Only a message that actually went to the process needs holding here:
        // if it died before answering, this is the only surviving copy of what
        // was typed. A queued one is still on the bridge, which hands the whole
        // queue back on failure.
        if (!r.queued) state.unsent.set(sessionId, text);
        applyRunner(r.status);
        if (!r.queued) {
            state.pinned = true;
            scrollToEnd(false);
        }
    } catch (err) {
        restoreToComposer(text);
        toast(`Could not send: ${err.message}`, 'error');
    } finally {
        dom.btnSend.disabled = !state.current;
    }
}

/** A turn that never started: give the text back, and offer the way forward. */
function handleSendFailure(f) {
    // Everything the process was holding, in send order — the turn it died on
    // plus whatever was still queued behind it.
    const text = (f.unsent && f.unsent.length)
        ? f.unsent.join('\n\n')
        : (state.unsent.get(f.sessionId) || '');
    state.unsent.delete(f.sessionId);

    const onCurrent = state.current && state.current.sessionId === f.sessionId;
    if (text) {
        if (onCurrent) restoreToComposer(text);
        else saveDraft(f.sessionId, text);   // waiting when they come back
    }

    if (f.kind === 'busy-elsewhere' && onCurrent && text) {
        toast(`${f.message} Your message is back in the box.`, 'warn', {
            action: { label: 'Branch off a copy', onClick: () => sendMessage({ fork: true }) },
        });
    } else {
        toast(text ? `${f.message} Your message was put back.` : f.message, 'error',
            { ms: 9000 });
    }
}

// ── terminal ─────────────────────────────────────────────────────────────

// The pane is a property of the window, not of a session: leave it open and
// every session you move to shows its own shell in its own directory, which is
// what you want when the pane is open because you are comparing two of them.
// Its height is remembered for the same reason.
const TERM_MIN = 120;

const termPane = new TerminalPane({
    mount: dom.termBody,
    onOpen: (info) => paintTermHead(info),
    onError: (msg) => toast(`Terminal: ${msg}`, 'error'),
});

function termHeight() {
    const saved = Number(localStorage.getItem('termHeight'));
    return Number.isFinite(saved) && saved >= TERM_MIN ? saved : 300;
}

function setTermHeight(px) {
    const max = Math.max(TERM_MIN, Math.round(window.innerHeight * 0.78));
    const h = Math.min(max, Math.max(TERM_MIN, Math.round(px)));
    dom.termPane.style.setProperty('--term-h', `${h}px`);
    localStorage.setItem('termHeight', String(h));
}

function termOpen() { return localStorage.getItem('termOpen') === '1'; }

/** A path the way a shell prompt writes it: ~ for home, and only the tail. */
function homely(cwd) {
    const short = String(cwd || '').replace(/^\/home\/[^/]+/, '~');
    if (short.length <= 52) return short;
    const parts = short.split('/');
    const out = [];
    // Whole segments only — half a directory name is worse than fewer of them.
    for (let i = parts.length - 1; i >= 0; i--) {
        if (out.join('/').length + parts[i].length + 1 > 50) break;
        out.unshift(parts[i]);
    }
    return `…/${out.join('/')}`;
}

/**
 * Label the pane with the directory the shell is actually in.
 *
 * Not with the session's, because the two drift: a session that enters a
 * worktree after the pane was opened leaves its shell behind in the old
 * directory. Saying so is the honest thing — the alternative is a heading that
 * quietly contradicts the prompt two lines below it.
 */
function paintTermHead(info) {
    const shellCwd = (info && info.cwd) || '';
    dom.termDir.textContent = homely(shellCwd);
    dom.termDir.title = shellCwd;

    const now = state.current && state.current.cwd;
    const moved = !!(info && now && now !== shellCwd);
    dom.termMoved.hidden = !moved;
    if (moved) {
        dom.termMoved.textContent = `· session moved to ${homely(now)}`;
        dom.termMoved.title = now;
    }
    dom.termRestart.title = moved
        ? `Restart the shell in ${now}` : 'End this shell and start a new one';
}

/** Show or hide the pane. The shell itself is unaffected either way. */
function showTerm(on, { focus = false } = {}) {
    localStorage.setItem('termOpen', on ? '1' : '0');
    dom.termPane.hidden = !on;
    dom.btnTerm.classList.toggle('on', on);
    dom.btnTerm.setAttribute('aria-pressed', String(on));
    renderHeaderActions();
    if (!on) { termPane.detach(); return; }

    setTermHeight(termHeight());
    syncTerm();
    if (focus) termPane.focus();
}

/** Point the pane at whatever session is on screen. */
function syncTerm() {
    if (dom.termPane.hidden) return;
    if (!state.current) { termPane.detach(); paintTermHead(null); return; }
    // Already attached: the shell is known, so the head can be right now rather
    // than after a round trip. Otherwise stand in with where it is about to open.
    if (termPane.info && termPane.sessionId === state.current.sessionId) {
        paintTermHead(termPane.info);
    } else {
        dom.termDir.textContent = homely(state.current.cwd);
        dom.termDir.title = state.current.cwd || '';
        dom.termMoved.hidden = true;
    }
    termPane.attach(state.current.sessionId);
}

/**
 * Drag the grip to resize. Measured from the pane's bottom edge rather than
 * from where the drag started, so the pointer stays on the grip however far
 * the clamp has moved it.
 */
function startTermDrag(e) {
    e.preventDefault();
    const bottom = dom.termPane.getBoundingClientRect().bottom;
    dom.termGrip.classList.add('dragging');
    document.body.classList.add('term-resizing');

    const move = (ev) => setTermHeight(bottom - ev.clientY);
    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        dom.termGrip.classList.remove('dragging');
        document.body.classList.remove('term-resizing');
        termPane.refit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

// ── new session ──────────────────────────────────────────────────────────

async function openNew() {
    dom.newScrim.hidden = false;
    dom.newPrompt.value = '';
    growPrompt();
    dom.newTest.checked = false;
    dom.newCwd.value = state.current
        ? (state.current.worktree ? state.current.worktree.originalCwd : state.current.cwd)
        : '';
    try {
        const { projects } = await get('/api/projects');
        dom.newPicker.replaceChildren(...projects.slice(0, 40).map(p =>
            el('button', {
                class: 'picker-row', type: 'button',
                onclick: () => { dom.newCwd.value = p.cwd; dom.newPrompt.focus(); },
            },
                el('span', {}, p.name),
                el('span', { class: 'path' }, clip(p.cwd, 44)),
                p.active ? el('span', { class: 'tag' }, `${p.active} live`) : null,
            )));
        if (!dom.newCwd.value && projects[0]) dom.newCwd.value = projects[0].cwd;
    } catch (err) {
        toast(`Could not list projects: ${err.message}`, 'error');
    }
    dom.newPrompt.focus();
}

function closeNew() { dom.newScrim.hidden = true; }

async function startNew() {
    const cwd = dom.newCwd.value.trim();
    const prompt = dom.newPrompt.value.trim();
    if (!cwd) { toast('Pick a working directory first.', 'warn'); return; }
    if (!prompt) { toast('Write a first message so the session has something to do.', 'warn'); return; }

    dom.newGo.disabled = true;
    dom.newGo.textContent = 'Starting';
    try {
        const r = await post('/api/sessions', {
            cwd, prompt,
            model: dom.newModel.value || null,
            permissionMode: dom.newPerm.value,
            test: state.dev && dom.newTest.checked,
        });
        closeNew();
        toast('Session started.', 'ok');
        // The transcript only exists once `claude` writes its first line.
        openSessionSoon(r.sessionId);
    } catch (err) {
        toast(`Could not start the session: ${err.message}`, 'error');
    } finally {
        dom.newGo.disabled = false;
        dom.newGo.textContent = 'Start';
    }
}

// ── wiring ───────────────────────────────────────────────────────────────

dom.search.addEventListener('input', debounce(() => {
    state.query = dom.search.value;
    loadSessions();
}, 180));

dom.btnSend.addEventListener('click', () => sendMessage());
dom.btnNew.addEventListener('click', openNew);

dom.btnPin.addEventListener('click', () => {
    if (state.current) setFlags(state.current, { pinned: !state.current.pinned });
});

dom.btnArchive.addEventListener('click', () => {
    if (state.current) setFlags(state.current, { archived: !state.current.archived });
});

dom.btnDelete.addEventListener('click', () => {
    if (state.current) askDelete(state.current);
});
dom.delGo.addEventListener('click', confirmDelete);

dom.btnFolder.addEventListener('click', async () => {
    if (!state.current) return;
    dom.btnFolder.disabled = true;
    try {
        await post(`/api/sessions/${state.current.sessionId}/reveal`, {});
    } catch (err) {
        toast(`Could not open the folder: ${err.message}`, 'error');
    } finally {
        dom.btnFolder.disabled = false;
    }
});
dom.btnTerm.addEventListener('click', () => {
    if (!state.current) return;
    showTerm(dom.termPane.hidden, { focus: true });
});
dom.termClose.addEventListener('click', () => showTerm(false));
dom.termRestart.addEventListener('click', async () => {
    await termPane.kill();
    syncTerm();
    termPane.focus();
});
dom.termGrip.addEventListener('pointerdown', startTermDrag);
// Keyboard equivalent of the drag, so the pane is not mouse-only.
dom.termGrip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 60 : 20;
    if (e.key === 'ArrowUp') { e.preventDefault(); setTermHeight(dom.termPane.offsetHeight + step); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setTermHeight(dom.termPane.offsetHeight - step); }
});

dom.newGo.addEventListener('click', startNew);
dom.dbStatus.addEventListener('click', refreshDevBrowser);
dom.btnBack.addEventListener('click', closeAgent);

dom.input.addEventListener('input', autoGrow);
dom.input.addEventListener('input', debounce(() => {
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
}, 400));
// A reload or a crash should not eat a half-written message either.
window.addEventListener('beforeunload', () => {
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
});
// Enter sends, Shift+Enter breaks the line — chat convention, and what the hand
// reaches for. Ctrl/Cmd+Enter stays wired up because it used to be the only way
// and fingers remember. `isComposing` keeps an IME's Enter for the IME: it is
// picking a candidate, not finishing a message.
dom.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (e.altKey) return;
    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    sendMessage();
});

// Two stops, because the consequences differ. The first asks the turn to end
// where it is, which leaves the session resumable and the transcript coherent.
// A second click within a few seconds kills the process instead, which is what
// you want when the polite one did not take — and which can leave a tool call
// half-finished, so it is never what happens on the first click.
const FORCE_WINDOW_MS = 4000;

function armForce() {
    state.stopArmed = Date.now();
    dom.btnStop.textContent = 'Force stop';
    dom.btnStop.classList.add('force');
    setTimeout(() => {
        if (Date.now() - state.stopArmed < FORCE_WINDOW_MS) return;
        state.stopArmed = 0;
        dom.btnStop.textContent = 'Stop';
        dom.btnStop.classList.remove('force');
    }, FORCE_WINDOW_MS + 50);
}

dom.btnStop.addEventListener('click', async () => {
    if (!state.current) return;
    const hard = state.stopArmed > 0 && Date.now() - state.stopArmed < FORCE_WINDOW_MS;
    dom.btnStop.disabled = true;
    try {
        const out = await post(`/api/sessions/${state.current.sessionId}/stop`, { hard });
        // Either way the send queue went with the turn — but those messages never
        // reached the process, so they come back to the box rather than being
        // binned. Said as part of the stop toast, not a second one.
        let back = '';
        if (out.dropped && out.dropped.length) {
            restoreToComposer(out.dropped.join('\n\n'));
            back = out.dropped.length === 1
                ? ' The message that was waiting is back in the box.'
                : ` The ${out.dropped.length} waiting messages are back in the box.`;
        }
        if (out.how === 'soft') {
            toast('Asked the turn to stop — the session stays resumable.' + back, 'ok');
            armForce();
        } else {
            state.stopArmed = 0;
            dom.btnStop.textContent = 'Stop';
            dom.btnStop.classList.remove('force');
            toast('Killed the process. Whatever was written is in the transcript.' + back, 'warn');
        }
    } catch (err) {
        toast(`Could not stop: ${err.message}`, 'error');
    } finally {
        dom.btnStop.disabled = false;
    }
});

dom.queueClear.addEventListener('click', clearQueue);
dom.queueList.addEventListener('dragover', onQueueDragOver);
// Without this the browser treats the list as a non-target and the drag snaps
// back instead of dropping.
dom.queueList.addEventListener('drop', (e) => e.preventDefault());

// Stop auto-scrolling the moment the user scrolls away from the bottom.
dom.scroll.addEventListener('scroll', () => {
    const sc = dom.scroll;
    state.pinned = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90;
    markActiveTurn();
});

// The tooltip is positioned against a tick, so it cannot follow one that moves.
dom.turns.addEventListener('scroll', hideTurnPop);

dom.newPrompt.addEventListener('input', growPrompt);

for (const n of dom.newScrim.querySelectorAll('[data-close]')) {
    n.addEventListener('click', closeNew);
}
dom.newScrim.addEventListener('click', (e) => { if (e.target === dom.newScrim) closeNew(); });

for (const n of dom.delScrim.querySelectorAll('[data-close-del]')) {
    n.addEventListener('click', closeDelete);
}
dom.delScrim.addEventListener('click', (e) => { if (e.target === dom.delScrim) closeDelete(); });

document.addEventListener('keydown', (e) => {
    // The confirm sits over the new-session dialog, so it answers Escape first.
    if (e.key === 'Escape' && !dom.delScrim.hidden) { closeDelete(); return; }
    if (e.key === 'Escape' && !dom.newScrim.hidden) { closeNew(); return; }
    if (e.key === 'Escape' && state.agent) { closeAgent(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); dom.search.focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); openNew(); }
});

// Copy buttons inside rendered markdown are delegated: the blocks are innerHTML.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const block = btn.closest('.code-block');
    const code = decodeURIComponent(block.dataset.code || '');
    navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1400);
    }).catch(() => toast('Could not copy to the clipboard.', 'error'));
});

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── go ───────────────────────────────────────────────────────────────────

connect();
loadSessions();
markInstance();
refreshDevBrowser();
// Restore the pane before the first session lands, so it opens with the window
// already the right shape rather than growing one out from under the transcript.
showTerm(termOpen());
setInterval(refreshDevBrowser, 20_000);
setInterval(() => { if (state.current) loadChannels(); }, 25_000);

// A running subagent writes to its own file, which the parent transcript says
// nothing about — so the only way its activity line moves is to go and look.
// Only while something is actually running, and only for what is on screen.
setInterval(() => {
    if (!state.current) return;
    const busy = state.runner && (state.runner.state === 'busy' || state.runner.state === 'starting');
    // A busy session counts even with no agents listed yet: the first poll after
    // a Task call starts is how the agent gets on the strip at all.
    if (state.agent || busy || agentRows().some(a => a.status === 'running')) loadAgents();
}, 4000);
