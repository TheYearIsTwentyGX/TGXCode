// Claude Sessions — renderer.
//
// All state lives in the bridge; this file is a view over it. Transcript content
// arrives from one place only (the file tail, pushed over SSE), so a session
// running in somebody's terminal renders identically to one started here.

import { renderMarkdown, inline } from './markdown.js';
import { highlight, escapeHtml } from './highlight.js';

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

// ── state ────────────────────────────────────────────────────────────────

const state = {
    clientId: null,
    sessions: [],
    query: '',
    current: null,          // session summary
    offset: 0,
    nodes: new Map(),       // event id -> {ev, node}
    tools: new Map(),       // tool_use id -> {ev, node}
    turns: [],              // the user messages, in order, for the turn rail
    activeTurn: -1,
    runner: null,
    channels: [],
    pinned: true,           // stick to the bottom as new events arrive
    archiveOpen: (() => {
        try { return localStorage.getItem('archiveOpen') === '1'; } catch { return false; }
    })(),
    unsent: new Map(),      // sessionId -> text written to a process but not yet in a transcript
    busyTimer: null,        // ticks the elapsed-time readout while a turn runs
};

const $ = (id) => document.getElementById(id);
const dom = {};
for (const id of ['search', 'rail', 'conv', 'placeholder', 'conv-title', 'conv-sub',
    'channels', 'scroll', 'log', 'status-line', 'status-text', 'btn-stop', 'input',
    'btn-send', 'model', 'perm', 'btn-new', 'db-status', 'db-label', 'toasts',
    'btn-pin', 'btn-folder', 'btn-archive', 'turns', 'turn-pop',
    'new-scrim', 'new-cwd', 'new-picker', 'new-prompt', 'new-model', 'new-go']) {
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
        renderRail();
    } catch (err) {
        toast(`Could not load sessions: ${err.message}`, 'error');
    }
}

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

    const pinned = state.sessions.filter(s => s.pinned);
    const archived = state.sessions.filter(s => s.archived);
    const rest = state.sessions.filter(s => !s.pinned && !s.archived);

    // Pinned first, across every project — that is the point of pinning.
    if (pinned.length) {
        dom.rail.append(groupHead('Pinned', pinned));
        for (const s of pinned) dom.rail.append(strip(s));
    }

    const groups = new Map();
    for (const s of rest) {
        const key = s.projectName || 'unknown';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
    }
    for (const [project, list] of groups) {
        dom.rail.append(groupHead(project, list));
        for (const s of list) dom.rail.append(strip(s));
    }

    if (archived.length) {
        // Collapsed by default, but a filter that matches archived sessions
        // should not silently hide its own results.
        const open = state.archiveOpen || Boolean(state.query);
        dom.rail.append(el('button', {
            class: 'group-head archive-head',
            type: 'button',
            'aria-expanded': String(open),
            onclick: () => { state.archiveOpen = !open; saveArchiveOpen(); renderRail(); },
        },
            el('span', { class: 'twist' }, icon('caret', 13)),
            el('span', {}, 'Archived'),
            el('span', { class: 'count' }, String(archived.length)),
        ));
        if (open) for (const s of archived) dom.rail.append(strip(s));
    }
}

function groupHead(label, list) {
    const live = list.filter(s => s.active || (s.runner && s.runner.state === 'busy')).length;
    return el('div', { class: 'group-head' },
        el('span', {}, label),
        live ? el('span', { class: 'live' }, `${live} live`) : null,
        el('span', { class: 'count' }, String(list.length)),
    );
}

function strip(s) {
    const running = s.runner && (s.runner.state === 'busy' || s.runner.state === 'starting');
    const current = state.current && state.current.sessionId === s.sessionId;

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
                s.worktree ? el('span', { class: 'wt' }, s.worktree.name) : null,
                s.worktree ? el('span', { class: 'dot' }, '·') : null,
                // The time the list is ordered by, so the order reads as sorted.
                el('span', { title: `You last wrote here ${ago(s.lastUserTs || s.lastTs)} ago` },
                    ago(s.lastUserTs || s.lastTs)),
                el('span', { class: 'dot' }, '·'),
                el('span', {}, `${s.userMessages} ${s.userMessages === 1 ? 'turn' : 'turns'}`),
                running ? el('span', { class: 'dot' }, '·') : null,
                running ? el('span', { class: 'pulse' }, clip(s.runner.activity || 'Working', 22)) : null,
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
        ),
    );
}

/** Toggle pin/archive, updating in place so the rail doesn't jump under the cursor. */
async function setFlags(summary, change) {
    try {
        const r = await post(`/api/sessions/${summary.sessionId}/flags`, change);
        Object.assign(summary, { pinned: r.pinned, archived: r.archived });
        if (state.current && state.current.sessionId === summary.sessionId) {
            Object.assign(state.current, { pinned: r.pinned, archived: r.archived });
            renderHeaderActions();
        }
        renderRail();
    } catch (err) {
        toast(`Could not update the session: ${err.message}`, 'error');
    }
}

function saveArchiveOpen() {
    try { localStorage.setItem('archiveOpen', state.archiveOpen ? '1' : '0'); } catch { /* private mode */ }
}

// ── conversation ─────────────────────────────────────────────────────────

async function openSession(id, { quiet = false } = {}) {
    if (state.current && state.current.sessionId === id) return true;
    // Keep whatever is half-typed for the session being left behind.
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
    try {
        const data = await get(`/api/sessions/${id}`);
        state.current = data.summary;
        state.offset = data.offset;
        state.runner = data.runner;
        state.nodes.clear();
        state.tools.clear();
        state.pinned = true;

        dom.placeholder.hidden = true;
        dom.conv.hidden = false;

        renderHeader();
        dom.log.replaceChildren();
        hideTurnPop();
        appendEvents(data.events, false);
        renderTurns();      // a session with no turns of your own still clears the rail
        renderRail();
        applyRunner(state.runner);
        scrollToEnd(true);

        subscribe();
        loadChannels();

        // Anything typed here before, or handed back by a failed turn.
        dom.input.value = state.unsent.get(id) || loadDraft(id);
        autoGrow();
        dom.input.focus();
        return true;
    } catch (err) {
        if (!quiet) toast(`Could not open session: ${err.message}`, 'error');
        return false;
    }
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
    dom.btnFolder.title = `Show ${s.cwd} in File Explorer`;
}

function appendEvents(events, animate) {
    const frag = document.createDocumentFragment();
    let newTurn = false;
    for (const ev of events) {
        if (ev.kind === 'tool-result') { patchTool(ev); continue; }
        if (state.nodes.has(ev.id)) continue;
        const node = renderEvent(ev);
        if (!node) continue;
        state.nodes.set(ev.id, { ev, node });
        if (ev.kind === 'tool') state.tools.set(ev.id, { ev, node });
        if (ev.kind === 'user') newTurn = true;
        frag.append(node);
    }
    if (frag.childNodes.length) dom.log.append(frag);
    if (newTurn) renderTurns();
}

/** A tool call whose result arrived in a later chunk than the call itself. */
function patchTool(patch) {
    const entry = state.tools.get(patch.toolId);
    if (!entry) return;
    Object.assign(entry.ev, patch);
    if (entry.ev.ts && patch.resultTs) {
        entry.ev.durationMs = Date.parse(patch.resultTs) - Date.parse(entry.ev.ts);
    }
    const wasOpen = entry.node.querySelector('details') ?
        entry.node.querySelector('details').open : false;
    const fresh = renderEvent(entry.ev);
    if (!fresh) return;
    const det = fresh.querySelector('details');
    if (det && wasOpen) det.open = true;
    entry.node.replaceWith(fresh);
    entry.node = fresh;
    state.nodes.set(entry.ev.id, entry);
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

function renderSystem(ev) {
    const label = ev.subtype === 'permission_denied' ? 'Permission needed'
        : ev.subtype === 'away_summary' ? 'Summary'
        : ev.subtype.replace(/_/g, ' ');
    const body = [
        el('div', { class: 'ev-label' }, label),
        el('div', { class: 'prose', html: renderMarkdown(ev.text) }),
    ];
    if (ev.subtype === 'permission_denied') {
        body.push(el('div', { class: 'note', style: 'margin-top:6px; font-size:11.5px; color:var(--text-4)' },
            'This session\'s permission mode did not allow that tool. '
            + 'Change it below the composer and ask again.'));
    }
    return row(ev, 'system', ...body);
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

    det.append(el('div', { class: 'tool-body' }, ...toolBody(ev)));
    return row(ev, 'tool', det);
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
        const meta = [a.agentType, a.model && shortModel(a.model),
            a.toolUses && `${a.toolUses} tools`, dur(a.durationMs)].filter(Boolean).join(' · ');
        const wrap = el('div', { class: 'tool-section subagent' },
            el('h4', {}, 'Subagent'),
            el('div', { style: 'font:400 11.5px/1.6 var(--mono); color:var(--text-3)' }, meta));
        if (a.hasTranscript) {
            const btn = el('button', { class: 'more-btn', type: 'button' }, 'Show its transcript');
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
                    btn.textContent = 'Show its transcript';
                    toast(`Could not load the subagent transcript: ${err.message}`, 'error');
                }
            });
            wrap.append(btn);
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

function kvView(obj) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of Object.entries(obj)) {
        const text = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
        dl.append(el('dt', {}, k), el('dd', {}, clip(text, 600)));
    }
    return dl;
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
        appendEvents(d.events, true);
        if (stick) scrollToEnd(false);
    });

    es.addEventListener('reset', () => {
        if (state.current) {
            const id = state.current.sessionId;
            state.current = null;
            openSession(id);
        }
    });

    es.addEventListener('sessions-changed', () => loadSessions());

    es.addEventListener('runner-status', (e) => {
        const s = JSON.parse(e.data);
        if (state.current && s.sessionId === state.current.sessionId) applyRunner(s);
        const strip = dom.rail.querySelector(`[data-id="${CSS.escape(s.sessionId)}"]`);
        if (strip) {
            strip.dataset.state = (s.state === 'busy' || s.state === 'starting')
                ? 'running' : strip.dataset.state;
        }
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
    if (!state.clientId || !state.current) return;
    try {
        await post('/api/subscribe', {
            clientId: state.clientId,
            sessionId: state.current.sessionId,
            offset: state.offset,
        });
    } catch { /* the SSE reconnect will re-subscribe */ }
}

function applyRunner(s) {
    state.runner = s;
    const busy = s && (s.state === 'busy' || s.state === 'starting');
    const retrying = Boolean(s && s.retry);

    dom.statusLine.dataset.state = s
        ? (s.state === 'error' ? 'error' : retrying ? 'stalled' : busy ? 'busy' : 'idle')
        : 'idle';
    dom.btnStop.hidden = !busy;
    dom.btnSend.disabled = !state.current;

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

// ── composer ─────────────────────────────────────────────────────────────

function autoGrow() {
    dom.input.style.height = 'auto';
    // Never below the button height, so an empty composer stays centred.
    dom.input.style.height = Math.max(38, Math.min(220, dom.input.scrollHeight)) + 'px';
}

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
        // Held until the turn lands in the transcript. If the process dies first
        // — a session already running elsewhere is the common case — this is the
        // only surviving copy of what was typed.
        state.unsent.set(sessionId, text);
        applyRunner(r.status);
        state.pinned = true;
        scrollToEnd(false);
    } catch (err) {
        restoreToComposer(text);
        toast(`Could not send: ${err.message}`, 'error');
    } finally {
        dom.btnSend.disabled = !state.current;
    }
}

/** A turn that never started: give the text back, and offer the way forward. */
function handleSendFailure(f) {
    const text = (f.unsent && f.unsent[0]) || state.unsent.get(f.sessionId) || '';
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

// ── new session ──────────────────────────────────────────────────────────

async function openNew() {
    dom.newScrim.hidden = false;
    dom.newPrompt.value = '';
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
            permissionMode: dom.perm.value,
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
dom.newGo.addEventListener('click', startNew);
dom.dbStatus.addEventListener('click', refreshDevBrowser);

dom.input.addEventListener('input', autoGrow);
dom.input.addEventListener('input', debounce(() => {
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
}, 400));
// A reload or a crash should not eat a half-written message either.
window.addEventListener('beforeunload', () => {
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
});
dom.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
});

dom.btnStop.addEventListener('click', async () => {
    if (!state.current) return;
    try { await post(`/api/sessions/${state.current.sessionId}/stop`, {}); toast('Stopped.', 'ok'); }
    catch (err) { toast(`Could not stop: ${err.message}`, 'error'); }
});

// Stop auto-scrolling the moment the user scrolls away from the bottom.
dom.scroll.addEventListener('scroll', () => {
    const sc = dom.scroll;
    state.pinned = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90;
    markActiveTurn();
});

// The tooltip is positioned against a tick, so it cannot follow one that moves.
dom.turns.addEventListener('scroll', hideTurnPop);

for (const n of document.querySelectorAll('[data-close]')) n.addEventListener('click', closeNew);
dom.newScrim.addEventListener('click', (e) => { if (e.target === dom.newScrim) closeNew(); });

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dom.newScrim.hidden) { closeNew(); return; }
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
setInterval(refreshDevBrowser, 20_000);
setInterval(() => { if (state.current) loadChannels(); }, 25_000);
