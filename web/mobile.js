'use strict';

// Claude Sessions on a phone.
//
// A second client of the same bridge, not a second version of the app. Everything
// here talks the API documented in docs/api.md, which is also what an Android
// client will talk — so anything this file needs and cannot get is a gap in the
// API, and belongs fixed there rather than worked around here.
//
// Three deliberate departures from web/app.js:
//
// **One screen at a time.** The desktop is a rail plus a conversation plus a board.
// This is a tab bar over four screens, and it opens on *Needs you* rather than on a
// list — the reason to pick up a phone is that something is blocked, and making
// that the landing screen is the whole design.
//
// **Tool calls stay collapsed.** The desktop renders every tool body inline, which
// is right at a desk and wrong on a 390px screen where it buries the prose. Here a
// tool is a one-line fact you can tap. That is also why this file does not import
// the desktop's renderers: it is not a subset of them, it is a different summary.
// If that stops being true, web/app.js's renderers lift out cleanly — the notes in
// the plan say how.
//
// **Reconnection is assumed, not exceptional.** A phone backgrounds the tab, loses
// the network, changes cell. There is no Last-Event-ID replay on the bridge's SSE,
// so recovery is: re-subscribe from the byte offset we hold, and catch up over
// `GET /api/sessions/:id/since?offset=`. visibilitychange tears the stream down and
// puts it back rather than trusting a backgrounded EventSource to still be alive.
//
// Authentication is a cookie, set either by /pair (a phone) or by the page response
// itself (loopback). Nothing here sends a token: `fetch` and `EventSource` both send
// same-origin cookies on their own, which is exactly why the cookie was chosen over
// a bearer header — the service worker's fetch gets it too, for free.

import { renderMarkdown, inline } from './markdown.js';

const HEADERS = { 'X-Claude-Sessions-Client': '1' };

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function get(path) {
    const r = await fetch(path, { headers: HEADERS });
    if (!r.ok) throw await httpError(r);
    return r.json();
}

async function post(path, body) {
    const r = await fetch(path, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw await httpError(r);
    return r.json();
}

/**
 * An Error carrying the status, so callers can tell apart the outcomes that are
 * ordinary from the ones that are not — 409 on an ask someone else already
 * answered being the one that matters.
 */
async function httpError(r) {
    let detail = '';
    try { detail = (await r.json()).error || ''; } catch { /* not JSON */ }
    const err = new Error(detail || `${r.status} ${r.statusText}`);
    err.status = r.status;
    return err;
}

const $ = (id) => document.getElementById(id);

/** Build an element. Mirrors web/app.js's `el` so the two read alike. */
function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
        if (kid === null || kid === undefined || kid === false) continue;
        node.append(kid);
    }
    return node;
}

const dom = {};
for (const id of ['remote-banner', 'remote-banner-text', 'back', 'bar-title', 'conn',
    'main', 'screen-needs', 'needs-list', 'needs-empty', 'needs-empty-detail',
    'screen-sessions', 'filter', 'session-list', 'screen-session', 'log', 'ask-slot',
    'composer', 'mode', 'queue-note', 'stop', 'prompt', 'send',
    'screen-new', 'new-form', 'new-cwd', 'new-mode', 'new-prompt', 'new-test',
    'new-go', 'new-error', 'needs-badge', 'toast']) {
    dom[id] = $(id);
}

const state = {
    screen: 'needs',
    clientId: null,
    /** Sessions from GET /api/sessions, newest activity first. */
    sessions: [],
    /** The live board, from the `overview` SSE event. */
    board: null,
    /** The open conversation, or null. */
    current: null,
    /** Permission modes the bridge will accept, minus the ones it refuses remotely. */
    modes: [],
    remote: false,
    /** Per-session mode the user picked but has not sent yet. */
    pendingMode: new Map(),
};

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(message) {
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 3200);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** "4m", "3h", "2d" — the rail's vocabulary, because it is the compact one. */
function ago(ts) {
    if (!ts) return '';
    const ms = Date.now() - new Date(ts).getTime();
    if (!Number.isFinite(ms)) return '';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
}

/** How long an ask has been waiting, in words. */
function waitingFor(askedAt) {
    if (!askedAt) return '';
    const s = Math.max(0, Math.round((Date.now() - askedAt) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `waiting ${m} min`;
    const h = Math.round(m / 60);
    return `waiting ${h}h`;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
//
// The hash is the address, so the back button works and a notification can deep
// link into a session — which web/sw.js already does, with `/#/session/<id>`. That
// spelling is honoured here as well as `#/s/<id>`, because the service worker is
// shared with the desktop and must not need to know which surface opened it.

function parseHash() {
    const h = location.hash.replace(/^#/, '');
    let m = /^\/(?:s|session)\/(.+)$/.exec(h);
    if (m) return { screen: 'session', sessionId: decodeURIComponent(m[1]) };
    m = /^\/(needs|sessions|new)$/.exec(h);
    if (m) return { screen: m[1] };
    return { screen: 'needs' };
}

function go(screen, sessionId) {
    const next = screen === 'session' ? `#/s/${encodeURIComponent(sessionId)}` : `#/${screen}`;
    if (location.hash === next) applyRoute();
    else location.hash = next;
}

const TITLES = { needs: 'Needs you', sessions: 'Sessions', new: 'Start a session' };

async function applyRoute() {
    const route = parseHash();
    state.screen = route.screen;
    document.body.dataset.screen = route.screen;

    for (const name of ['needs', 'sessions', 'session', 'new']) {
        dom[`screen-${name}`].hidden = name !== route.screen;
    }
    for (const tab of document.querySelectorAll('.tab')) {
        const on = tab.dataset.go === route.screen;
        if (on) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    }
    dom.back.hidden = route.screen !== 'session';

    if (route.screen === 'session') {
        await openSession(route.sessionId);
    } else {
        dom['bar-title'].textContent = TITLES[route.screen];
        // Stop tailing a conversation nobody is looking at; the bridge polls the
        // transcript on a timer per subscriber, so this is not free.
        if (state.current) { state.current = null; await subscribe(); }
        // Every screen draws from state it already holds. The board in particular
        // must not wait for the next `overview` push to appear: the bridge sends
        // one only when the answer has changed, so a quiet minute would leave this
        // screen blank on arrival.
        if (route.screen === 'needs') renderNeeds();
        if (route.screen === 'sessions') renderSessions();
        if (route.screen === 'new') fillNewForm();
    }
}

// ---------------------------------------------------------------------------
// The live stream
// ---------------------------------------------------------------------------

let es = null;

function setConn(stateName) {
    dom.conn.dataset.state = stateName;
    dom.conn.title = {
        live: 'Connected to the bridge',
        connecting: 'Connecting to the bridge…',
        offline: 'Not connected to the bridge',
    }[stateName] || '';
}

function connect() {
    disconnect();
    setConn('connecting');
    es = new EventSource('/api/events');

    es.addEventListener('hello', async (e) => {
        const data = JSON.parse(e.data);
        state.clientId = data.clientId;
        setConn('live');
        // Nothing replays, so a reconnection re-reads rather than assuming the gap
        // was empty: the list, then whatever this client was following.
        await loadSessions();
        await subscribe();
        if (state.current) await catchUp();
    });

    es.addEventListener('overview', (e) => {
        state.board = JSON.parse(e.data);
        if (state.screen === 'needs') renderNeeds();
        updateBadge();
    });

    es.addEventListener('tail', (e) => {
        const data = JSON.parse(e.data);
        if (!state.current || data.sessionId !== state.current.sessionId) return;
        state.current.offset = data.offset;
        appendEvents(data.events);
    });

    es.addEventListener('reset', async (e) => {
        const data = JSON.parse(e.data);
        if (!state.current || data.sessionId !== state.current.sessionId) return;
        // The transcript was rewritten — compaction, or a fork. Start over.
        await openSession(data.sessionId, { force: true });
    });

    es.addEventListener('sessions-changed', () => { loadSessions(); });

    es.addEventListener('session-deleted', (e) => {
        const data = JSON.parse(e.data);
        if (state.current && state.current.sessionId === data.sessionId) {
            toast(`“${data.title || 'That session'}” was deleted`);
            go('sessions');
        }
    });

    es.addEventListener('runner-status', (e) => {
        const status = JSON.parse(e.data);
        if (!state.current || status.sessionId !== state.current.sessionId) return;
        state.current.runner = status;
        renderRunner();
    });

    es.addEventListener('permission-request', (e) => {
        const ask = JSON.parse(e.data);
        if (state.current && ask.sessionId === state.current.sessionId) renderAsk(ask);
        if (state.screen === 'needs') renderNeeds();
        updateBadge();
    });

    es.addEventListener('permission-resolved', (e) => {
        const data = JSON.parse(e.data);
        if (state.current && data.sessionId === state.current.sessionId) {
            resolveAsk(data.outcome);
        }
        updateBadge();
    });

    es.addEventListener('notice', (e) => {
        const n = JSON.parse(e.data);
        if (n.level === 'warn') toast(n.text);
    });

    es.addEventListener('turn-complete', (e) => {
        const r = JSON.parse(e.data);
        if (r.isError && state.current && r.sessionId === state.current.sessionId) {
            toast(r.detail || 'The turn ended with an error');
        }
    });

    es.addEventListener('send-failed', (e) => {
        const f = JSON.parse(e.data);
        toast(f.message || 'That message did not send');
        // The text is still the user's; hand it back rather than losing it.
        if (state.current && f.sessionId === state.current.sessionId
            && Array.isArray(f.unsent) && f.unsent.length && !dom.prompt.value) {
            dom.prompt.value = f.unsent.join('\n\n');
            growPrompt();
        }
    });

    es.addEventListener('session-forked', async (e) => {
        const { from, to } = JSON.parse(e.data);
        if (state.current && state.current.sessionId === from) go('session', to);
    });

    es.onerror = () => {
        // EventSource retries on its own; say so rather than looking broken.
        setConn(es && es.readyState === 2 ? 'offline' : 'connecting');
    };
}

function disconnect() {
    if (es) { es.close(); es = null; }
    state.clientId = null;
}

/** Tell the bridge what this client is following. */
async function subscribe() {
    if (!state.clientId) return;
    try {
        await post('/api/subscribe', {
            clientId: state.clientId,
            sessionId: state.current ? state.current.sessionId : null,
            offset: state.current ? state.current.offset : 0,
            // The board is wanted on every screen: the tab badge is drawn from it,
            // so it has to keep arriving while a conversation is open.
            overview: true,
        });
    } catch (err) {
        if (err.status === 404) connect(); // our clientId died with the stream
    }
}

/** Read whatever landed while we were away. */
async function catchUp() {
    if (!state.current) return;
    try {
        const data = await get(`/api/sessions/${encodeURIComponent(state.current.sessionId)}`
            + `/since?offset=${state.current.offset}`);
        if (data.reset) return openSession(state.current.sessionId, { force: true });
        state.current.offset = data.offset;
        if (data.events && data.events.length) appendEvents(data.events);
    } catch { /* the stream will bring it, or the next visibility change will */ }
}

// A backgrounded EventSource is not reliably alive, and on iOS it usually is not.
// Rather than trust it, drop it on the way out and rebuild on the way back — the
// `hello` handler already knows how to resynchronise, which is what makes this
// cheap to do.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        disconnect();
        setConn('offline');
    } else {
        connect();
    }
});

// ---------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------

const REASON_WHY = {
    ask: 'Waiting for you',
    error: 'Stopped with an error',
    here: 'Running',
    elsewhere: 'Running in a terminal',
    pinned: 'Pinned',
};

function renderNeeds() {
    const board = state.board;
    const list = dom['needs-list'];
    list.textContent = '';

    if (!board) {
        dom['needs-empty'].hidden = false;
        dom['needs-empty-detail'].textContent = 'Waiting for the bridge…';
        return;
    }

    const cards = board.sessions || [];
    dom['needs-empty'].hidden = cards.length > 0;
    if (!cards.length) {
        dom['needs-empty-detail'].textContent = board.hidden
            ? `${board.hidden} other session${board.hidden === 1 ? '' : 's'} idle.`
            : 'No sessions are running.';
        return;
    }

    // The bridge has already ordered these needs-you-first (bridge/overview.js);
    // re-sorting here would only be a second opinion about the same question.
    for (const card of cards) list.append(needsCard(card));
}

function needsCard(card) {
    const head = el('div', { class: 'card-head' },
        el('div', { class: 'card-title', text: card.title || 'Untitled session' }),
        el('span', { class: 'card-project', text: card.worktree ? card.worktree.name : (card.projectName || '') }));

    const kids = [head];

    const why = card.ask
        ? (card.ask.kind === 'plan' ? 'A plan to approve'
            : card.ask.kind === 'question' ? 'A question to answer'
            : `Wants to run ${card.ask.displayName || card.ask.tool}`)
        : (card.runner && card.runner.activity) || REASON_WHY[card.reason] || '';
    if (why) kids.push(el('div', { class: 'card-why', text: why }));

    // The last thing it was seen doing. Three headlines is the desktop's choice and
    // one is a phone's: the card is a nudge, not a transcript.
    const headline = (card.headlines || []).slice(-1)[0];
    if (headline && !card.ask) {
        kids.push(el('div', { class: 'card-activity', text: headline.text }));
    }

    if (card.tasks && card.tasks.total) {
        const t = card.tasks;
        kids.push(el('div', {
            class: 'card-tasks',
            text: `${t.done} of ${t.total} done${t.current ? ` · ${t.current}` : ''}`,
        }));
    }

    // A tool permission is answerable straight from the card. A plan or a question
    // is not, and deliberately so — web/app.js:2587 makes the argument, and it is
    // even truer on a phone: two buttons against a plan nobody has read is worse
    // than one button that goes and shows it.
    if (card.ask && card.ask.kind === 'tool') {
        kids.push(el('div', { class: 'ask-actions' },
            el('button', {
                class: 'ask-btn', dataset: { kind: 'yes' }, type: 'button',
                text: 'Allow',
                onclick: (e) => answerFrom(e.currentTarget, card.sessionId, card.ask.requestId, { decision: 'allow' }),
            }),
            el('button', {
                class: 'ask-btn', type: 'button',
                text: `Allow ${card.ask.displayName || card.ask.tool} all session`,
                onclick: (e) => answerFrom(e.currentTarget, card.sessionId, card.ask.requestId, { decision: 'allow-always' }),
            }),
            el('button', {
                class: 'ask-btn', dataset: { kind: 'no' }, type: 'button',
                text: 'Deny',
                onclick: (e) => answerFrom(e.currentTarget, card.sessionId, card.ask.requestId, { decision: 'deny' }),
            }),
            el('button', {
                class: 'ask-btn', type: 'button', text: 'Open the session',
                onclick: () => go('session', card.sessionId),
            })));
    } else {
        kids.push(el('div', { class: 'ask-actions' },
            el('button', {
                class: 'ask-btn', dataset: { kind: card.ask ? 'yes' : null }, type: 'button',
                text: card.ask ? 'Read it →' : 'Open',
                onclick: () => go('session', card.sessionId),
            })));
    }

    return el('div', { class: 'card', dataset: { reason: card.reason || '' } }, kids);
}

/** Answer an ask from a card, disabling its buttons so it cannot be double-sent. */
async function answerFrom(button, sessionId, requestId, payload) {
    const group = button.closest('.ask-actions');
    for (const b of group.querySelectorAll('button')) b.disabled = true;
    try {
        await post(`/api/sessions/${encodeURIComponent(sessionId)}/permission`,
            { requestId, ...payload });
    } catch (err) {
        // 409 means it was answered elsewhere — another window, or the desktop's
        // notification buttons. An ordinary outcome, not a failure.
        toast(err.status === 409 ? 'Already answered somewhere else' : `Could not answer: ${err.message}`);
        for (const b of group.querySelectorAll('button')) b.disabled = false;
    }
}

function updateBadge() {
    const waiting = state.board ? (state.board.waiting || 0) : 0;
    dom['needs-badge'].hidden = waiting === 0;
    dom['needs-badge'].textContent = String(waiting);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function loadSessions() {
    try {
        const data = await get('/api/sessions?limit=200');
        state.sessions = data.sessions || [];
        if (state.screen === 'sessions') renderSessions();
    } catch (err) {
        // A 401 is not a blip to wait out: this device is not signed in, and no
        // amount of retrying will change that. Everything else is worth ignoring —
        // the stream will nudge us again.
        if (err.status === 401) notPaired();
    }
}

function rowState(s) {
    const r = s.runner;
    if (r && r.pendingPermission) return 'ask';
    if (r && r.state === 'error') return 'error';
    if (r && (r.state === 'busy' || r.state === 'starting')) return 'busy';
    if (s.live && s.live.running) return 'live';
    return 'idle';
}

function renderSessions() {
    const needle = dom.filter.value.trim().toLowerCase();
    const list = dom['session-list'];
    list.textContent = '';

    const rows = state.sessions.filter((s) => {
        if (s.archived) return false;
        if (!needle) return true;
        return `${s.title || ''} ${s.projectName || ''} ${s.worktree ? s.worktree.name : ''}`
            .toLowerCase().includes(needle);
    });

    if (!rows.length) {
        list.append(el('p', { class: 'empty' },
            el('b', { text: needle ? 'Nothing matches' : 'No sessions yet' })));
        return;
    }

    for (const s of rows) {
        const bits = [
            s.worktree ? s.worktree.name : s.projectName,
            ago(s.lastTs),
            `${s.userMessages || 0} turn${s.userMessages === 1 ? '' : 's'}`,
        ].filter(Boolean);
        list.append(el('button', {
            class: 'row', type: 'button',
            onclick: () => go('session', s.sessionId),
        },
        el('span', { class: 'row-dot', dataset: { state: rowState(s) } }),
        el('span', { class: 'row-main' },
            el('span', { class: 'row-title', text: s.title || 'Untitled session' }),
            el('span', { class: 'row-meta', text: bits.join(' · ') }))));
    }
}

dom.filter.addEventListener('input', renderSessions);

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

// How much of a long transcript to fetch on open. Enough to have context, small
// enough to arrive over a relay before you give up on it — a 60-turn session is
// ~1,800 events and half a megabyte, and none of the first 1,500 is why you opened
// your phone. `?tail=` is served by the bridge, so the rest is never sent.
const TAIL = 120;

async function openSession(sessionId, { force = false } = {}) {
    if (!force && state.current && state.current.sessionId === sessionId) return;

    dom.log.textContent = '';
    dom['ask-slot'].textContent = '';
    dom['bar-title'].textContent = 'Loading…';

    let data;
    try {
        data = await get(`/api/sessions/${encodeURIComponent(sessionId)}?tail=${TAIL}`);
    } catch (err) {
        dom['bar-title'].textContent = 'Not found';
        dom.log.append(el('p', { class: 'empty' },
            el('b', { text: 'Could not open that session' }),
            el('span', { text: err.message })));
        return;
    }

    state.current = {
        sessionId,
        summary: data.summary,
        offset: data.offset,
        runner: data.runner,
        seen: new Set(),
    };

    dom['bar-title'].textContent = data.summary.title || 'Untitled session';

    if (data.truncated) {
        dom.log.append(el('button', {
            class: 'log-more', type: 'button',
            text: `${data.truncated.dropped} earlier events — load all`,
            onclick: (e) => { e.currentTarget.remove(); loadWholeTranscript(sessionId); },
        }));
    }

    appendEvents(data.events);
    renderRunner();

    // A card can be up already: the ask arrived before this screen opened, and the
    // runner's status is what remembers it.
    if (data.runner && data.runner.pendingPermission) {
        renderAsk({ sessionId, ...data.runner.pendingPermission });
    }

    await subscribe();
    scrollToEnd();
}

async function loadWholeTranscript(sessionId) {
    try {
        const data = await get(`/api/sessions/${encodeURIComponent(sessionId)}`);
        if (!state.current || state.current.sessionId !== sessionId) return;
        dom.log.textContent = '';
        state.current.seen = new Set();
        state.current.offset = data.offset;
        appendEvents(data.events);
        scrollToEnd();
    } catch (err) {
        toast(`Could not load the rest: ${err.message}`);
    }
}

function nearBottom() {
    const l = dom.log;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 120;
}

function scrollToEnd() {
    dom.log.scrollTop = dom.log.scrollHeight;
}

/**
 * Append events, skipping any already drawn.
 *
 * Idempotent by event id because the tail and a catch-up read can overlap: the
 * offset we hold is a byte position, and a reconnection asks from it again rather
 * than trying to prove nothing was double-counted.
 */
function appendEvents(events) {
    if (!state.current || !events || !events.length) return;
    const stick = nearBottom();
    const frag = document.createDocumentFragment();

    for (const ev of events) {
        if (ev.id && state.current.seen.has(ev.id)) {
            // A tool call arrives once as a call and again with its result.
            if (ev.kind === 'tool') patchTool(ev);
            continue;
        }
        if (ev.id) state.current.seen.add(ev.id);
        const node = renderEvent(ev);
        if (node) frag.append(node);
    }

    dom.log.append(frag);
    if (stick) scrollToEnd();
}

/** Redraw a tool row in place once its result lands. */
function patchTool(ev) {
    const existing = dom.log.querySelector(`[data-tool-id="${cssEscape(ev.id)}"]`);
    if (!existing) return;
    const fresh = renderEvent(ev);
    if (fresh) existing.replaceWith(fresh);
}

function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

function row(ev, kind, body, extra) {
    return el('div', {
        class: `ev ev-${kind}`,
        dataset: { ...(extra || {}), ...(ev.id ? { evId: ev.id } : {}) },
    }, el('div', { class: 'ev-body' }, body));
}

function renderEvent(ev) {
    switch (ev.kind) {
        case 'user': return renderUser(ev);
        case 'assistant': return renderAssistant(ev);
        case 'thinking': return row(ev, 'thinking', el('div', { text: ev.text || '' }));
        case 'tool': return renderTool(ev);
        case 'system': return renderSystem(ev);
        case 'agent-done': return row(ev, 'agent-done',
            el('div', { text: `Subagent ${ev.status || 'finished'}${ev.summary ? ` — ${ev.summary}` : ''}` }));
        case 'suggestion': return renderSuggestion(ev);
        case 'peer-message': return renderPeerMessage(ev);
        case 'compact': return row(ev, 'compact', el('div', { text: 'Conversation compacted' }));
        default: return null;
    }
}

function renderUser(ev) {
    // A slash command and an agent-authored turn are not the same thing as
    // something you typed, and on a small screen the distinction is easy to lose.
    const prefix = ev.origin && ev.origin !== 'human' ? `[${ev.origin}] ` : '';
    const text = `${prefix}${ev.command ? `/${ev.command} ` : ''}${ev.text || ''}`.trim();
    const body = el('div', { text });
    if (ev.images && ev.images.length) {
        body.append(el('div', {
            class: 'row-meta',
            text: `${ev.images.length} image${ev.images.length === 1 ? '' : 's'}`,
        }));
    }
    return row(ev, 'user', body);
}

function renderAssistant(ev) {
    return row(ev, 'assistant', el('div', { html: renderMarkdown(ev.text || '') }));
}

/**
 * Work an agent suggested and did not do.
 *
 * Read-only here, unlike the desktop. Starting one is a decision about where and
 * how a session runs — a directory, a permission mode — and this surface exists
 * for answering things away from the desk, not for setting work going with a
 * thumb. What matters is that it is visible, so it is not a surprise later.
 */
function renderSuggestion(ev) {
    const body = el('div', { text: ev.title || firstLine(ev.prompt || '') });
    body.append(el('div', { class: 'row-meta', text: ev.why || 'Suggested follow-up' }));
    return row(ev, 'suggestion', body);
}

/**
 * A message from another Claude session.
 *
 * Rendered at all, which is the point: these arrive flagged as meta, so before
 * this they were dropped and a session that had been messaged showed a gap.
 */
function renderPeerMessage(ev) {
    const who = ev.fromName || ev.from || 'another session';
    const body = el('div', { html: renderMarkdown(ev.text || '') });
    body.prepend(el('div', { class: 'row-meta', text: `Message from ${who}` }));
    return row(ev, 'peer-message', body);
}

function renderSystem(ev) {
    return row(ev, 'system', el('div', { html: inline(ev.text || '') }),
        { error: String(Boolean(ev.isError)) });
}

/**
 * A tool call as one line, opened on demand.
 *
 * The desktop renders every tool body inline. That is right at a desk and wrong
 * here: a Bash call's stdout is thirty lines that push the assistant's actual
 * sentence off the screen. So the summary is the default and the body is a tap —
 * and the body is built only when it is asked for, which also keeps a 1,800-event
 * transcript from building 1,200 code blocks nobody looks at.
 */
/**
 * The tool name, short enough to be worth reading on a phone.
 *
 * An MCP tool arrives as `mcp__<server>__<tool>`, and the identifying half is the
 * last one: `mcp__plugin_playwright_playwright__browser_navigate` is 43 characters
 * of which the first 35 are the server saying its own name twice. Truncating that
 * from the right — which is what the CSS would do — leaves you with the half that
 * tells you nothing, so it is trimmed here instead. The full name stays in the
 * title attribute.
 */
function toolLabel(name) {
    if (!name) return 'tool';
    const m = /^mcp__.+?__(.+)$/.exec(name);
    return m ? m[1] : name;
}

function renderTool(ev) {
    const ok = ev.status === 'ok' || ev.status === null || ev.status === undefined;
    const summary = el('button', { class: 'tool', type: 'button', title: ev.name || '' },
        el('span', { class: 'tool-name', text: toolLabel(ev.name) }),
        el('span', { class: 'tool-desc', text: toolDescription(ev) }),
        el('span', {
            class: 'tool-status', dataset: { ok: String(ok) },
            text: ev.status === 'error' ? 'failed' : (ev.status ? '' : '…'),
        }));

    const node = row(ev, 'tool', summary, { toolId: ev.id || '' });
    let open = null;
    summary.addEventListener('click', () => {
        if (open) { open.remove(); open = null; return; }
        open = el('div', { class: 'tool-open', text: toolBody(ev) });
        node.querySelector('.ev-body').append(open);
    });
    return node;
}

// What to show as a tool's one line, in the order a person would want it: what it
// said it was doing, then what it was doing it to.
const TOOL_FIELDS = ['description', 'command', 'file_path', 'path', 'pattern',
    'prompt', 'url', 'subject', 'query'];

/** The one line that says what this call was. */
function toolDescription(ev) {
    const input = ev.input || {};
    for (const field of TOOL_FIELDS) {
        if (typeof input[field] === 'string' && input[field].trim()) {
            return firstLine(input[field]);
        }
    }
    const keys = Object.keys(input);
    return keys.length ? firstLine(JSON.stringify(input)) : '';
}

function firstLine(text, max = 90) {
    const line = String(text == null ? '' : text).split('\n')[0].trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Everything about the call, as text. Plain on purpose: this is a phone. */
function toolBody(ev) {
    const parts = [];
    const input = ev.input || {};
    if (Object.keys(input).length) {
        parts.push(Object.entries(input)
            .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
            .join('\n'));
    }
    const r = ev.result;
    if (r) {
        const out = r.patch || r.text || r.stdout || '';
        if (out) parts.push(`— result —\n${out}`);
        if (r.stderr) parts.push(`— stderr —\n${r.stderr}`);
        if (r.interrupted) parts.push('(interrupted)');
    }
    if (ev.persistedPath) {
        parts.push('(the full output was written to a file; open this session on the '
            + 'desktop to read it)');
    }
    return parts.join('\n\n') || '(nothing recorded)';
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

function renderRunner() {
    const r = state.current && state.current.runner;
    const queued = r && r.queued ? r.queued : 0;
    dom['queue-note'].textContent = r
        ? [r.activity || '', queued ? `${queued} queued` : ''].filter(Boolean).join(' · ')
        : '';
    dom.stop.hidden = !(r && (r.state === 'busy' || r.state === 'starting'));

    // The mode belongs to the session in front of you, not to the window — same
    // rule as the desktop. A mode picked and not yet sent is remembered against the
    // session, but a newer decision from the bridge (approving a plan changes the
    // mode) wins over it.
    const sessionId = state.current && state.current.sessionId;
    const live = (r && r.permissionMode)
        || (state.current && state.current.summary && state.current.summary.permissionMode);
    if (live && state.pendingMode.get(sessionId) !== dom.mode.value) {
        state.pendingMode.delete(sessionId);
    }
    fillModes(dom.mode, state.pendingMode.get(sessionId) || live || 'auto');
}

const MODE_LABEL = {
    auto: 'auto — ask when it matters',
    acceptEdits: 'acceptEdits — edits go through',
    plan: 'plan — nothing changes',
    manual: 'manual — ask about everything',
    dontAsk: 'dontAsk',
    bypassPermissions: 'bypassPermissions — unguarded',
};

function fillModes(select, selected) {
    const wanted = state.modes;
    const already = [...select.options].map(o => o.value).join(',');
    if (already !== wanted.join(',')) {
        select.textContent = '';
        for (const mode of wanted) {
            select.append(el('option', { value: mode, text: MODE_LABEL[mode] || mode }));
        }
    }
    if (selected && wanted.includes(selected)) select.value = selected;
}

dom.mode.addEventListener('change', () => {
    if (!state.current) return;
    state.pendingMode.set(state.current.sessionId, dom.mode.value);
    toast('Takes effect on your next message');
});

function growPrompt() {
    dom.prompt.style.height = 'auto';
    dom.prompt.style.height = `${Math.min(dom.prompt.scrollHeight, window.innerHeight * 0.4)}px`;
}
dom.prompt.addEventListener('input', growPrompt);

dom.composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = dom.prompt.value.trim();
    if (!text || !state.current) return;

    const sessionId = state.current.sessionId;
    dom.send.disabled = true;
    // Clear optimistically: the transcript is the record, and holding the text in
    // the box while it is already sent invites sending it twice.
    dom.prompt.value = '';
    growPrompt();

    try {
        // Always send the mode the picker is showing, never only when it changed.
        // The bridge normalises an absent mode to `auto` (server.js normalizeMode),
        // so omitting it does not mean "leave it alone" — it means "set it to auto",
        // which would quietly drop a session out of acceptEdits on every message.
        await post(`/api/sessions/${encodeURIComponent(sessionId)}/send`,
            { text, permissionMode: dom.mode.value });
        state.pendingMode.delete(sessionId);
    } catch (err) {
        dom.prompt.value = text;
        growPrompt();
        toast(`Did not send: ${err.message}`);
    } finally {
        dom.send.disabled = false;
    }
});

dom.stop.addEventListener('click', async () => {
    if (!state.current) return;
    dom.stop.disabled = true;
    try {
        const out = await post(`/api/sessions/${encodeURIComponent(state.current.sessionId)}/stop`, {});
        toast(out.how === 'hard' ? 'Stopped the process' : 'Asked it to stop');
    } catch (err) {
        toast(`Could not stop: ${err.message}`);
    } finally {
        dom.stop.disabled = false;
    }
});

// ---------------------------------------------------------------------------
// Ask cards
// ---------------------------------------------------------------------------

let askTimer = null;

function renderAsk(ask) {
    clearInterval(askTimer);
    dom['ask-slot'].textContent = '';

    const card = el('div', { class: 'ask' });
    const kindWord = ask.kind === 'plan' ? 'Plan'
        : ask.kind === 'question' ? 'Question' : 'Permission needed';
    card.append(el('div', { class: 'ask-kind', text: kindWord }));

    if (ask.kind === 'plan') fillPlanAsk(card, ask);
    else if (ask.kind === 'question') fillQuestionAsk(card, ask);
    else fillToolAsk(card, ask);

    // How long it has been waiting, not how long is left: asks no longer expire.
    // The card stays until it is answered, which is the whole point — you should be
    // able to read a plan without a clock running. What is still worth knowing on a
    // phone is that something has been blocked for twenty minutes.
    const waited = el('div', { class: 'ask-expiry' });
    card.append(waited);
    const tick = () => { waited.textContent = waitingFor(ask.askedAt); };
    tick();
    // Once a minute is enough for a number measured in minutes.
    askTimer = setInterval(tick, 30_000);

    dom['ask-slot'].append(card);
    scrollToEnd();
}

function fillToolAsk(card, ask) {
    card.append(el('div', { class: 'ask-tool', text: ask.displayName || ask.tool }));
    if (ask.reason) card.append(el('div', { class: 'card-why', text: ask.reason }));
    card.append(el('div', { class: 'ask-detail', text: toolBody({ input: ask.input }) }));
    card.append(el('div', { class: 'ask-actions' },
        askButton('Allow', 'yes', ask, { decision: 'allow' }),
        askButton(`Allow ${ask.displayName || ask.tool} all session`, null, ask,
            { decision: 'allow-always' }),
        askButton('Deny', 'no', ask, { decision: 'deny' })));
}

function fillPlanAsk(card, ask) {
    card.append(el('div', { class: 'ask-tool', text: 'Ready to start' }));
    card.append(el('div', {
        class: 'ask-detail ask-plan',
        html: renderMarkdown((ask.input && ask.input.plan) || ''),
    }));

    // The mode rides along with the approval, and it has to: the session is *in*
    // plan mode while this card is up, so approving without changing it would agree
    // to the work and then refuse every edit in it.
    const actions = el('div', { class: 'ask-actions' },
        askButton('Approve', 'yes', ask, { decision: 'allow', mode: 'auto' }),
        askButton('Approve — auto-accept edits', null, ask,
            { decision: 'allow', mode: 'acceptEdits' }));

    const note = el('textarea', {
        class: 'ask-feedback', rows: '3',
        placeholder: 'A note to send with your answer (optional)',
    });

    actions.append(
        askButton('Approve with the note above', null, ask,
            () => ({ decision: 'allow', mode: 'auto', feedback: note.value.trim() })),
        askButton('Keep planning', 'no', ask,
            () => ({ decision: 'deny', feedback: note.value.trim() })));

    card.append(note, actions);
}

function fillQuestionAsk(card, ask) {
    const questions = (ask.input && ask.input.questions) || [];
    const readers = [];

    for (const q of questions) {
        const block = el('div', { class: 'ask-q' });
        block.append(el('div', { class: 'ask-q-text', text: q.question || '' }));

        const name = `q${readers.length}`;
        const type = q.multiSelect ? 'checkbox' : 'radio';
        const inputs = [];

        for (const opt of q.options || []) {
            const input = el('input', { type, name, value: opt.label });
            inputs.push(input);
            block.append(el('label', { class: 'ask-opt' }, input,
                el('span', { class: 'ask-opt-label' },
                    el('span', { text: opt.label }),
                    opt.description ? el('span', { class: 'ask-opt-desc', text: opt.description }) : null)));
        }

        // Every question gets an Other row, because the desktop gives one and a
        // question you cannot answer honestly is worse than no question.
        const other = el('input', { type, name, value: '__other__' });
        const otherText = el('input', {
            class: 'ask-other', type: 'text', placeholder: 'Something else…',
            oninput: () => { other.checked = true; update(); },
        });
        inputs.push(other);
        block.append(el('label', { class: 'ask-opt' }, other,
            el('span', { class: 'ask-opt-label', text: 'Other' })), otherText);

        for (const i of inputs) i.addEventListener('change', update);

        readers.push(() => {
            const picked = inputs.filter(i => i.checked)
                .map(i => (i.value === '__other__' ? otherText.value.trim() : i.value))
                .filter(Boolean);
            if (!picked.length) return null;
            return { question: q.question, answer: q.multiSelect ? picked : picked[0] };
        });

        card.append(block);
    }

    const submit = askButton('Send', 'yes', ask, () => {
        const answers = {};
        for (const read of readers) {
            const got = read();
            if (got) answers[got.question] = got.answer;
        }
        return { decision: 'allow', answers };
    });
    const skip = askButton('Skip', 'no', ask, { decision: 'deny' });
    card.append(el('div', { class: 'ask-actions' }, submit, skip));

    function update() {
        // Claude asked all of them; leaving some to guesswork is what this card
        // exists to avoid.
        submit.disabled = readers.some(read => read() === null);
    }
    update();
}

/** A button that answers an ask. `payload` may be an object or a function. */
function askButton(label, kind, ask, payload) {
    return el('button', {
        class: 'ask-btn', type: 'button', dataset: kind ? { kind } : {}, text: label,
        onclick: async (e) => {
            const card = e.currentTarget.closest('.ask');
            for (const b of card.querySelectorAll('button')) b.disabled = true;
            const body = typeof payload === 'function' ? payload() : payload;
            try {
                await post(`/api/sessions/${encodeURIComponent(ask.sessionId)}/permission`,
                    { requestId: ask.requestId, ...body });
            } catch (err) {
                toast(err.status === 409
                    ? 'Already answered somewhere else'
                    : `Could not answer: ${err.message}`);
                for (const b of card.querySelectorAll('button')) b.disabled = false;
            }
        },
    });
}

const OUTCOME_WORD = {
    allow: 'Allowed',
    'allow-always': 'Allowed for the session',
    deny: 'Denied',
    answered: 'Answered',
    dismissed: 'Dismissed',
    'plan-approved': 'Plan approved',
    'plan-approved-note': 'Plan approved, with a note',
    'plan-rejected': 'Sent back for more planning',
    'auto-denied': 'Nobody answered, so it was denied',
    superseded: 'Superseded',
    stopped: 'Stopped',
    cancelled: 'Withdrawn',
    abandoned: 'Abandoned',
};

function resolveAsk(outcome) {
    clearInterval(askTimer);
    dom['ask-slot'].textContent = '';
    dom['ask-slot'].append(el('div', {
        class: 'ask-done',
        text: OUTCOME_WORD[outcome] || outcome || 'Answered',
    }));
    setTimeout(() => {
        if (dom['ask-slot'].querySelector('.ask-done')) dom['ask-slot'].textContent = '';
    }, 6000);
}

// ---------------------------------------------------------------------------
// Start a session
// ---------------------------------------------------------------------------
//
// The directory comes from sessions that already exist rather than from a
// filesystem walk. /api/fs would work, but browsing a tree on a phone to find a
// path you already have twenty sessions in is the wrong shape for the input.

function recentDirs() {
    const seen = new Map();
    for (const s of state.sessions) {
        const dir = s.cwd || s.projectCwd;
        if (!dir || seen.has(dir)) continue;
        seen.set(dir, s.worktree ? `${s.projectName} · ${s.worktree.name}` : (s.projectName || dir));
    }
    return [...seen.entries()].slice(0, 40);
}

function fillNewForm() {
    const dirs = recentDirs();
    const chosen = dom['new-cwd'].value;
    dom['new-cwd'].textContent = '';
    for (const [dir, label] of dirs) {
        dom['new-cwd'].append(el('option', { value: dir, text: label }));
    }
    if (chosen && dirs.some(([d]) => d === chosen)) dom['new-cwd'].value = chosen;

    // Plan mode by default, exactly as the desktop's Start a session does: the
    // first message of a session is the one written with the least idea of what it
    // will touch.
    fillModes(dom['new-mode'], 'plan');
}

dom['new-form'].addEventListener('submit', async (e) => {
    e.preventDefault();
    const cwd = dom['new-cwd'].value;
    const prompt = dom['new-prompt'].value.trim();
    dom['new-error'].hidden = true;

    if (!cwd) return showNewError('Pick a directory first.');
    if (!prompt) return showNewError('A session needs a first message.');

    dom['new-go'].disabled = true;
    try {
        const out = await post('/api/sessions', {
            cwd,
            prompt,
            permissionMode: dom['new-mode'].value,
            test: dom['new-test'].checked,
        });
        dom['new-prompt'].value = '';
        go('session', out.sessionId);
    } catch (err) {
        showNewError(err.message);
    } finally {
        dom['new-go'].disabled = false;
    }
});

function showNewError(message) {
    dom['new-error'].textContent = message;
    dom['new-error'].hidden = false;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => go(tab.dataset.go));
}

dom.back.addEventListener('click', () => {
    // history.back() when there is somewhere to go back to, so the gesture and the
    // button agree; otherwise the list, which is where a deep link should land you.
    if (history.length > 1) history.back();
    else go('needs');
});

window.addEventListener('hashchange', applyRoute);

// The service worker is shared with the desktop and exists for one thing:
// notification action buttons that answer a permission without a window. On this
// origin that is worth more than it is there — the phone is the device that is not
// looking. It needs no fetch handler and deliberately has none.
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* not fatal */ });
    navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'reveal-session' && e.data.sessionId) {
            go('session', e.data.sessionId);
        }
    });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Say that this device is not signed in, and stop.
 *
 * This screen exists because of a failure mode that is worse than an error: the
 * static files need no token, so an unpaired phone gets the whole app shell, a
 * connection dot that says it is trying, and no data and no explanation. It looks
 * like the bridge is broken. It is not — this device simply has no cookie.
 *
 * Called at most once; a 401 on one call usually means a 401 on all of them.
 */
let saidNotPaired = false;
function notPaired() {
    if (saidNotPaired) return;
    saidNotPaired = true;
    disconnect();
    setConn('offline');

    document.body.dataset.screen = 'blocked';
    dom.main.textContent = '';
    dom['bar-title'].textContent = 'Not signed in';
    dom.back.hidden = true;
    dom.main.append(el('div', { class: 'screen' },
        el('p', { class: 'empty' },
            el('b', { text: 'This device is not paired' }),
            el('span', { text: 'The bridge is reachable — it is refusing these '
                + 'requests because this device has no token yet.' }),
            el('span', { text: 'On the desktop, press the phone button in the top '
                + 'bar for a pairing link, and open it here once.' }))));
}

async function boot() {
    try {
        // /api/health is deliberately open, so a 200 from it proves the bridge is
        // reachable and nothing at all about whether we are signed in. The probe
        // that answers that question has to be a route the token actually guards.
        const health = await get('/api/health');
        state.remote = Boolean(health.remote);

        // bypassPermissions and dontAsk are refused for remote callers by the
        // bridge; offering them would be a button that always fails. The refusal is
        // the bridge's to make — this only agrees with it.
        state.modes = (health.permissionModes || ['auto'])
            .filter(m => !(state.remote && (m === 'bypassPermissions' || m === 'dontAsk')));

        if (state.remote) {
            dom['remote-banner'].hidden = false;
            dom['remote-banner-text'].textContent =
                `Connected remotely — ${health.host || 'this machine'}`;
        }
        if (health.dev) document.title = 'Claude Sessions (dev)';
    } catch (err) {
        // health is unauthenticated, so a failure here is the bridge being
        // unreachable rather than us being unsigned. Carry on with a sensible mode
        // list; the probe below is what decides whether we are actually in.
        toast(`Could not reach the bridge: ${err.message}`);
        state.modes = ['auto', 'acceptEdits', 'plan', 'manual'];
    }

    // The real question, asked of a route the token guards. Without this an
    // unpaired device gets the whole shell and no data, which reads as a broken
    // bridge rather than as "you have not signed this device in".
    try {
        await get('/api/sessions?limit=1');
    } catch (err) {
        if (err.status === 401) return notPaired();
    }

    await loadSessions();
    await applyRoute();
    connect();
}

boot();
