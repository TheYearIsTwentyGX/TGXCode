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

// What the composer falls back to for a session nothing is known about. Matches
// the `selected` option in index.html and the bridge's own default, so all three
// agree about what "no mode was chosen" means.
const DEFAULT_PERM = 'auto';

// ── settings ─────────────────────────────────────────────────────────────

// What the user's own ~/.tgxcode/settings.json says, handed to the page in a
// <meta> tag by bridge/server.js. In the page rather than behind a fetch
// because restoreView() opens a session synchronously at startup: a transcript
// drawn before an answer arrived would stay drawn the wrong way, since nothing
// re-renders history. A project may override any of it, and that answer travels
// with the transcript instead — see openSession.
const BOOT_PREFS = (() => {
    const fallback = {
        transcript: { groupToolCalls: true, groupMinCalls: 3, groupIncludesThinking: true },
    };
    try {
        const m = document.querySelector('meta[name="cs-prefs"]');
        if (!m) return fallback;
        const d = JSON.parse(decodeURIComponent(m.content));
        return { ...fallback, ...d, transcript: { ...fallback.transcript, ...(d.transcript || {}) } };
    } catch { return fallback; }
})();

/** The transcript settings in force — the open session's, or the user's own. */
const grouping = () => (state.prefs || BOOT_PREFS).transcript;

const state = {
    clientId: null,
    dev: false,             // talking to a development bridge
    pairInfo: null,         // what /api/pairing said this machine is reachable as
    sessions: [],
    query: '',
    current: null,          // session summary
    offset: 0,
    openSeq: 0,             // bumped per open; a slow fetch checks it before drawing
    nodes: new Map(),       // event id -> {ev, node}
    tools: new Map(),       // tool_use id -> {ev, node}
    // Settings for the open session's directory, from the bridge. Null until a
    // session is opened, when BOOT_PREFS is the answer.
    prefs: null,
    // Ids of the tool (and thinking) events seen since the last message, in
    // order — the run that is still being worked on. Ids and not nodes: a node
    // is replaced whenever a result lands, so a held reference goes stale.
    run: [],
    agentRun: [],
    turns: [],              // the user messages, in order, for the turn rail
    activeTurn: -1,
    agents: [],             // subagent records for this session, from the bridge
    agent: null,            // the subagent being viewed, if any
    agentOffset: 0,
    agentNodes: new Map(),  // the viewed subagent's own event id -> {ev, node}
    agentTools: new Map(),
    runner: null,
    // A permission mode picked here and not yet sent, per session. Deliberately
    // not persisted: after a reload the transcript is the better answer, and this
    // only exists so that looking away and back does not quietly drop a choice.
    permChoice: new Map(),
    channels: [],
    // url -> {status, label, detail, title, updatedAt} from /api/sessions/:id/prs.
    // Null until that answers; the header draws its PRs from the summary either way.
    prStatus: null,
    // What the session's directory declares in .tgxcode/, and what is running
    // from it. Keyed by nothing — there is only ever one conversation on screen,
    // and the payload is re-fetched when it changes. `cmdsFor` is the directory
    // they were read for, so a late answer for a session you have left is
    // dropped rather than drawn.
    cmds: null,
    cmdsFor: null,
    runs: new Map(),        // run id -> the bridge's record
    termTab: 'shell',       // 'shell', or the id of a run whose output is shown
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
    // The one message drawn in the log before the transcript has it:
    // {sessionId, node, timer}. Kept out of state.nodes on purpose — renderTurns
    // builds the turn rail from there, and a tick whose node is about to be
    // thrown away is worse than a tick that arrives one poll late.
    pendingSend: null,
    pendingDelete: null,    // the session the confirm dialog is asking about
    busyTimer: null,        // ticks the elapsed-time readout while a turn runs
    queue: [],              // the current session's waiting messages, from the bridge
    queueDrag: null,        // id of the chip being dragged
    queueOpen: new Set(),   // ids of chips expanded to their full text
    // Slash commands the composer can complete, per working directory — the
    // bridge keys them that way because that is what decides them. Held here so
    // that pressing `/` draws from memory rather than waiting on a fetch; the
    // `slash-commands` SSE event drops an entry when a process reports a new
    // list. Not `commands`, which is `cmds` above — the project's own.
    slashCommands: new Map(),   // cwd -> {commands, at, exact}
    // Sessions an agent here could message, from GET /api/peers. One list for
    // the whole window rather than one per session, because it is a fact about
    // the machine — every composer offers the same names.
    //
    // Refetched when the rail changes rather than held forever: a peer that has
    // exited cannot be messaged, and offering its name would be offering a
    // failure. `at` is when it was answered, so opening the picker twice in a
    // row does not ask twice.
    peers: { list: [], at: 0 },
    // What has already been done about each suggested follow-up in the open
    // conversation, keyed by the id of the tool call that raised it. Arrives
    // whole on the session payload; changes arrive over SSE.
    suggestions: new Map(),   // toolUseId -> {status, startedId, at}
    // The suggestions themselves, in the order they were raised. They are pulled
    // out of the transcript on the way past — see appendEvents — because they are
    // drawn in the aside beside the log rather than in it.
    tasks: new Map(),         // toolUseId -> ev
    // Which task bodies are open. Only the ones you have actually toggled: the
    // default is worked out per task in taskCard, so an offer you have not dealt
    // with opens itself and one you have dealt with does not.
    taskOpen: new Map(),      // toolUseId -> bool
    // Whether the aside is showing at all. A property of the window rather than
    // of a session, like the terminal pane's height — you either want these in
    // view while you work or you do not.
    tasksShut: localStorage.getItem('tasksShut') === '1',
    // The task the big dialog is showing, if it is open. Held by id rather than
    // by object so a decision taken inside it can find its way back to the same
    // task after the panel behind has been rebuilt.
    taskDialog: null,
    queueSig: '',           // what the chips were last built from, to avoid churn
    queueFocus: null,       // the chip holding the queue's single tab stop
    ask: null,              // the approval this session is blocked on, if any
    planAside: false,       // the plan view is collapsed to its one-line bar
    planFor: null,          // which requestId that was decided about
    // The mode the bridge last reported, per session, so that a mode which moves
    // under a session can be told apart from one being seen for the first time.
    runnerMode: new Map(),
    stopArmed: 0,           // when a soft Stop happened, for the force escalation
    // Sessions where "Send anyway" was clicked past the live-elsewhere lock.
    // Per session and not persisted: the next window, and this one after a
    // reload, should ask again rather than inherit somebody's earlier gamble.
    lockOverride: new Set(),
    // The board of unfinished work. `at` is when the bridge last answered, so
    // opening it again does not re-run git over every worktree on the machine.
    dash: { open: false, data: null, at: 0, loading: false, error: null, files: new Set() },
    // The notification log. `seen` is when the view was last opened, kept in
    // localStorage so the badge does not come back full after a reload — the
    // rows themselves live in the bridge, which is the whole point of them.
    notes: { open: false, rows: [], at: 0, loading: false, error: null,
        scope: 'notable', seen: Number(localStorage.getItem('notesSeenAt')) || 0 },
    // The live board. `watching` is what the bridge has been told, kept apart
    // from `open` so that a re-subscribe for some other reason does not turn the
    // board's timer on for a window that closed it.
    live: { open: false, watching: false, data: null, at: 0, clock: null,
        // Half-written messages per card, held here rather than in the DOM so
        // they outlive the redraws the board does while agents work.
        drafts: new Map(),
        // Which way the board and the conversation divide the window:
        // 'bottom' stacks them, 'side' puts them next to each other. A property
        // of the window rather than of a session, like the terminal pane, so it
        // is remembered and every session you move to keeps it.
        dock: localStorage.getItem('liveDock') === 'side' ? 'side' : 'bottom' },
    // Sessions blocked on an answer, kept whether or not the board is open, so
    // the badge on a shut board still says how many people are waiting.
    waiting: new Set(),
    // A second-monitor window: no rail, no composer, just cards.
    focus: false,
    // The Browse tab of the new-session picker. `dir` is the folder on screen,
    // which is also the folder Start will use — walking into one is how you pick
    // it, and #new-cwd is written on every step. `seq` is the openSeq trick:
    // clicking down a tree faster than the listings come back would otherwise let
    // an older one paint over a newer one.
    browse: {
        tab: localStorage.getItem('newPickerTab') === 'browse' ? 'browse' : 'recent',
        dir: null, parent: null, roots: [], entries: [],
        truncated: false, error: null, seq: 0,
        known: new Map(),   // cwd -> project, from /api/projects, for the row tags
        focus: null,        // path holding the tree's single tab stop
        naming: false,      // the New folder name box is open
    },
};

const $ = (id) => document.getElementById(id);
const dom = {};
for (const id of ['search', 'rail', 'conv', 'placeholder', 'conv-title', 'conv-sub',
    'channels', 'scroll', 'log', 'status-line', 'status-text', 'btn-stop', 'input',
    'btn-send', 'btn-lgtm', 'slash-menu', 'mention-menu', 'queue', 'queue-list', 'queue-count', 'queue-clear',
    'model', 'perm', 'btn-new', 'btn-new-menu', 'new-menu', 'db-status', 'db-label', 'toasts',
    'btn-bell', 'bell-menu', 'opt-desktop', 'opt-sound', 'bell-note', 'bell-try',
    'btn-pin', 'btn-folder', 'btn-term', 'btn-archive', 'btn-delete', 'turns', 'turn-pop',
    'term-pane', 'term-grip', 'term-dir', 'term-moved', 'term-body', 'term-restart', 'term-close',
    'term-tabs', 'term-stop', 'cmds',
    'tasks', 'tasks-strip', 'tasks-strip-count', 'tasks-open', 'tasks-count',
    'tasks-collapse', 'tasks-list',
    'task-scrim', 'task-dlg-title', 'task-dlg-why', 'task-dlg-prompt', 'task-dlg-cwd',
    'task-dlg-copy', 'task-dlg-acts',
    'agents', 'agent-scroll', 'agent-log', 'btn-back', 'btn-back-label',
    'ask-dock', 'plan-pane', 'plan-bar', 'plan-aside', 'plan-agent', 'plan-title',
    'plan-body', 'plan-doc', 'plan-foot',
    'btn-dash', 'dash-badge', 'dash', 'dash-sub', 'dash-body', 'dash-refresh',
    'btn-notes', 'notes-badge', 'notes', 'notes-sub', 'notes-body',
    'notes-notable', 'notes-all', 'notes-clear',
    'lock', 'lock-text', 'lock-fork', 'lock-anyway',
    'btn-live', 'live-badge', 'live', 'live-sub', 'live-body', 'live-focus', 'focus-exit',
    'live-side', 'live-side-label', 'live-side-a', 'live-side-b',
    'new-scrim', 'new-cwd', 'new-picker', 'new-prompt', 'new-model', 'new-perm',
    'new-test', 'new-test-row', 'new-go',
    'new-tab-recent', 'new-tab-browse', 'new-browse', 'new-roots', 'new-crumbs',
    'new-tree', 'new-mkdir', 'new-mkdir-name', 'new-mkdir-go', 'new-browse-note',
    'del-scrim', 'del-what', 'del-meta', 'del-go',
    'btn-pair', 'pair-scrim', 'pair-url', 'pair-host', 'pair-hosts', 'pair-note',
    'pair-copy']) {
    dom[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id);
}
// The two containers that carry layout state as data attributes rather than
// holding content of their own, so they have classes instead of ids.
dom.main = document.querySelector('.main');
dom.app = document.querySelector('.app');

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
        // `live` rides on the session list, not on runner-status, so this is the
        // only moment the composer learns that a session started or stopped in a
        // terminal. The registry broadcasts sessions-changed for exactly this.
        paintLock();
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
    power: '<path d="M12 3.4v7.2" stroke="currentColor" stroke-width="2.1" '
        + 'stroke-linecap="round"/><path d="M7.5 6.6a6.4 6.4 0 1 0 9 0" stroke="currentColor" '
        + 'stroke-width="2.1" stroke-linecap="round"/>',
    // The pull-request statuses. Drawn as three families so that the icon carries
    // the state on its own and the colour only reinforces it: the branch shape is
    // the PR's own lifecycle, a speech bubble is a human's verdict on it, and a
    // bare mark is CI's. Two reds and two yellows are otherwise indistinguishable
    // to anyone who cannot separate them by hue.
    pr: '<circle cx="6.5" cy="17.5" r="2.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<circle cx="17.5" cy="6.5" r="2.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<path d="M6.5 14.9V8.5a2 2 0 0 1 2-2h6.4" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round"/>',
    // The same branch, not joined up yet. Dotted rather than dashed: a dash pattern
    // on a path this short is invisible at 13px, where round caps with gaps wider
    // than the marks change the outline instead of just its texture — and the
    // outline is the only thing that still reads at this size.
    prDraft: '<circle cx="6.5" cy="17.5" r="2.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<circle cx="17.5" cy="6.5" r="2.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<path d="M6.5 14.9V8.5a2 2 0 0 1 2-2h6.4" stroke="currentColor" '
        + 'stroke-width="1.9" stroke-linecap="round" stroke-dasharray="0.1 3.5"/>',
    // Landed: an arrow arriving at the trunk. Deliberately not another two-dots-and-
    // an-elbow — a curve is all that separated it from `pr` and at 13px that is
    // nothing, so merged leaves the branch family and takes a silhouette of its own.
    // The two still-open states keep the family; the two settled ones each stand apart.
    prMerged: '<path d="M18.8 4.6v14.8" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round"/>'
        + '<path d="M4.4 12h9.8" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round"/>'
        + '<path d="m10.6 8.3 3.9 3.7-3.9 3.7" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round"/>',
    prClosed: '<circle cx="12" cy="12" r="7.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<path d="M8.3 15.7 15.7 8.3" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round"/>',
    reviewOk: '<path d="M20 14.4a2.5 2.5 0 0 1-2.5 2.5H9.3L5 20.3V6.1a2.5 2.5 0 0 1 2.5-2.5h10A2.5 '
        + '2.5 0 0 1 20 6.1Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
        + '<path d="m9.4 10.1 2 2 3.5-3.7" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round"/>',
    reviewChanges: '<path d="M20 14.4a2.5 2.5 0 0 1-2.5 2.5H9.3L5 20.3V6.1a2.5 2.5 0 0 1 2.5-2.5h10A2.5 '
        + '2.5 0 0 1 20 6.1Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
        + '<path d="M9.3 10.2h6.4" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round"/>',
    checkFail: '<path d="m6.8 6.8 10.4 10.4" stroke="currentColor" stroke-width="2.2" '
        + 'stroke-linecap="round"/><path d="M17.2 6.8 6.8 17.2" stroke="currentColor" '
        + 'stroke-width="2.2" stroke-linecap="round"/>',
    checkWait: '<circle cx="12" cy="12" r="7.6" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-dasharray="3.3 2.9"/>',
    conflict: '<path d="M12 4.3 21 19.5H3Z" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linejoin="round"/><path d="M12 9.9v3.7" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round"/><path d="M12 16.6h.01" '
        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    trash: '<path d="M4.5 6.8h15" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round"/><path d="M6.6 6.8 7.7 19a1.5 1.5 0 0 0 1.5 1.4h5.6A1.5 1.5 0 0 0 '
        + '16.3 19l1.1-12.2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
        + '<path d="M9.6 6.8V4.6a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v2.2" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linejoin="round"/>',
};

// Which glyph says each PR status. `unknown` is gh being unreachable rather than a
// state a PR can be in, so it borrows the plain branch and the CSS leaves it grey:
// a header that cannot reach GitHub says no less than it used to, and claims no more.
const PR_ICON = {
    open: 'pr',
    unknown: 'pr',
    draft: 'prDraft',
    merged: 'prMerged',
    closed: 'prClosed',
    approved: 'reviewOk',
    changes: 'reviewChanges',
    'checks-failed': 'checkFail',
    'checks-pending': 'checkWait',
    conflicting: 'conflict',
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
    const away = elsewhere(s);

    // A row, not a button: it holds its own pin and archive controls, and
    // nesting buttons is not allowed.
    return el('div', {
        class: 'strip',
        'data-id': s.sessionId,
        'data-state': stripState(s),
        title: away ? awayWords(away) : null,
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
                // A background agent is a different sort of thing from a session
                // somebody is sitting in front of, and only the registry knows.
                (s.live && s.live.kind === 'bg')
                    ? el('span', { class: 'tag-bg', title: 'A background agent' }, 'bg') : null,
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
 * The registry entry for a session running somewhere that is not us — a
 * terminal, VS Code, a background agent — or null.
 *
 * `runner` is the test for "ours": the bridge only reports one for a process it
 * started itself, so a session with a live registry entry and no runner is one
 * this window cannot send into without two processes appending to one file.
 */
function elsewhere(s) {
    if (!s || !s.live || !s.live.running) return null;
    return s.runner ? null : s.live;
}

/** Three states where there used to be two. `active` is the mtime fallback. */
function stripState(s) {
    if (s.runner && (s.runner.state === 'busy' || s.runner.state === 'starting')) return 'running';
    if (elsewhere(s)) return 'elsewhere';
    return s.active ? 'active' : 'idle';
}

/** How to describe a session running outside this app, in a sentence. */
function awayWords(live) {
    const where = WHERE[live.entrypoint] || (live.kind === 'bg' ? 'as a background agent' : null);
    return `Running ${where || `under ${live.entrypoint || 'another client'}`}`
        + ` (pid ${live.pid})`;
}

const WHERE = {
    cli: 'in a terminal',
    vscode: 'in VS Code',
    'sdk-cli': 'under the SDK',
    'claude-sessions': 'in another Claude Sessions window',
};

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
    stripEl.dataset.state = stripState(s);
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
    setTermOpen(sessionId, false);
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
    state.run.length = 0;
    state.prefs = null;     // the next session's project may answer differently
    state.turns = [];
    state.activeTurn = -1;
    state.agents = [];
    state.ask = null;
    clearPendingSend();   // the conversation it was drawn in is gone
    leaveAgent();
    clearInterval(state.busyTimer);
    state.busyTimer = null;
    dom.log.replaceChildren();
    dom.turns.replaceChildren();
    dom.agents.replaceChildren();
    dom.channels.replaceChildren();
    hideTurnPop();
    dom.conv.hidden = true;
    // Not while a panel is up: the empty state would sit under it, and the
    // session that went away is not what you are looking at anyway.
    paintPanels();
    enableSend(false);
    // The pane lives inside .conv, so it goes with it; the shell keeps running
    // and is there again the moment the session is.
    termPane.detach();
    // The buttons belonged to a conversation that is gone. The runs themselves
    // are untouched — they belong to a directory, not to a session, and the next
    // session opened there picks them up again from /api/commands.
    state.cmds = null;
    state.cmdsFor = null;
    state.runs.clear();
    state.termTab = 'shell';
    renderCommands();
    subscribe();            // stop the bridge tailing a file that is gone
    rememberView();         // and the address stops naming it too
}

// ── conversation ─────────────────────────────────────────────────────────

async function openSession(id, { quiet = false, keepDash = false } = {}) {
    // Already here — but a history row may still have somewhere to put you.
    if (state.current && state.current.sessionId === id) { takePendingJump(); return true; }
    // Keep whatever is half-typed for the session being left behind.
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
    // The menu belongs to the directory being left, and the draft arriving in
    // the box is not something anybody typed.
    closeSlashMenu();
    closeMentionMenu();

    // Switching should feel like switching, not like waiting: a long transcript
    // is megabytes and the fetch is most of the delay. The rail summary is the
    // same object the transcript endpoint returns, so the header is drawn for
    // real straight away and only the body stands in until the events land.
    // A session we hold no summary for — a fork still being written, which
    // openSessionSoon() retries against — has nothing to draw from, so it keeps
    // the old behaviour of arriving all at once.
    const known = state.sessions.find(s => s.sessionId === id) || null;
    const seq = ++state.openSeq;
    if (known) beginOpen(known, { keepDash });

    try {
        const data = await get(`/api/sessions/${id}`);
        // Another session was opened while this was in flight; that one owns the
        // pane now and must not be overwritten by this late arrival.
        if (seq !== state.openSeq) return true;

        if (known) state.current = data.summary;   // the index may have moved on
        else beginOpen(data.summary, { keepDash }); // nothing was drawn yet
        state.offset = data.offset;
        // Before appendEvents, because a suggestion card reads this as it is
        // built — a card drawn first and corrected afterwards would offer to
        // start something that was started days ago.
        state.suggestions = new Map(Object.entries(data.suggestions || {}));
        state.tasks.clear();
        state.taskOpen.clear();
        // Also before appendEvents, and for the same reason: what this project
        // says about folding runs of tool calls has to be known before the
        // transcript is built from it. Nothing re-renders history, so an answer
        // that arrived afterwards would be an answer for the next session.
        state.prefs = data.prefs || BOOT_PREFS;
        // applyRunner runs below, after the log is drawn — but the log needs to
        // know whether a turn is in flight, because the run of tool calls at the
        // end of a busy session is the work you are watching and must not fold.
        state.runner = data.runner || null;

        renderHeader();
        // Drops the skeleton — and with it a row drawn at Send while this fetch was
        // still in flight, which is reachable because the composer is live over a
        // skeleton. Forget it rather than re-append it: the transcript that is about
        // to be drawn may already contain the message, and putting the row back
        // would be guessing about where in this fetch it belongs. The message is
        // safe either way, and the state has to agree with the log.
        dom.log.replaceChildren();
        clearPendingSend();
        appendEvents(data.events);
        warmPeers();        // not awaited: it only adds a name and a link
        renderTurns();      // a session with no turns of your own still clears the rail
        renderRail();
        applyRunner(data.runner);
        scrollToEnd(true);
        // After the scroll, not before: it would be undone by it.
        takePendingJump();

        subscribe();
        loadChannels();
        loadPrStatus();
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
 *
 * `keepDash` is for a restore, where the session is not being picked but put
 * back: a window that was on the work-in-flight board over an open conversation
 * should return to the board, not be walked off it by the conversation arriving.
 */
function beginOpen(summary, { keepDash = false } = {}) {
    state.current = summary;
    state.offset = 0;
    state.runner = null;
    state.nodes.clear();
    state.tools.clear();
    state.run.length = 0;
    state.prefs = null;     // the next session's project may answer differently
    state.turns = [];
    state.activeTurn = -1;
    state.pinned = true;
    state.agents = [];  // the previous session's agents are not this one's
    state.prStatus = null;      // nor are its pull requests
    state.ask = null;   // approvals belong to the session that is blocked on them
    state.suggestions.clear();  // what was acted on belongs to the session it was raised in
    state.tasks.clear();        // and so do the offers themselves
    state.taskOpen.clear();
    closeTaskDialog();          // it was showing a task belonging to the old one
    renderTasks();              // empties the aside, and hides it
    // A row drawn for one session is not evidence about another. The log is
    // replaced below in any case; this is what disarms the timer holding it.
    clearPendingSend();
    state.stopArmed = 0;
    leaveAgent();       // a subagent belongs to the session it was spawned by

    // Picking a session is done with the work-in-flight board, whichever way you
    // got there. The live board is not a place you leave — it docks under the
    // conversation you just opened, which is the whole point of it.
    if (state.dash.open && !keepDash) showDash(false);
    // Through paintPanels rather than by hand: opening a session is what turns a
    // full-height board into a docked one, and setting `conv.hidden` here
    // directly left the two disagreeing — the conversation drawn underneath a
    // board that still thought it had the window to itself.
    paintPanels();

    renderHeader();
    hideTurnPop();
    dom.turns.replaceChildren();
    dom.log.replaceChildren(skeleton());
    dom.scroll.scrollTop = 0;
    renderRail();       // the clicked row takes the current-session mark now
    applyRunner(null);
    // Back to the shell: a run tab belongs to the directory it was started in,
    // and carrying it across to another session would show one project's dev
    // server under another project's name.
    state.termTab = 'shell';
    // Whether the pane is open is this session's answer, not the last one's —
    // and showTerm syncs it, so an open one still arrives on its own directory.
    showTerm(termOpen(summary.sessionId));
    // Not awaited: the buttons appear a moment after the header, and nothing
    // else in the open is waiting on them.
    loadCommands();

    // Anything typed here before, or handed back by a failed turn — but only what
    // is genuinely still owed to the composer. state.unsent is insurance against a
    // process dying mid-turn, not a draft: reading it here put the message you had
    // just sent back in the box every time you looked away and back, and leaving
    // again then saved that copy as a real draft, which outlived the turn.
    // handleSendFailure and editQueued are the two things that hand text back.
    dom.input.value = loadDraft(summary.sessionId);
    autoGrow();
    dom.input.focus();

    // Last, and here rather than in openSession: this is the one place both
    // paths through openSession converge on a session, so every way of getting
    // to a conversation — a rail row, a card, the dashboard, a notification, a
    // fork still being written — writes the address once, with everything the
    // showDash above may have changed on the way already settled.
    rememberView();
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
    for (const pr of headerPrs()) {
        bits.push(el('span', { class: 'sep' }, '·'));
        bits.push(prLink(pr));
    }
    bits.push(el('span', { class: 'sep' }, '·'));
    bits.push(el('span', { class: 'cwd', title: s.cwd }, clip(s.cwd, 42)));

    dom.convSub.replaceChildren(...bits);
    renderHeaderActions();
}

/**
 * Which pull requests the header draws.
 *
 * The status fetch wins over the summary where it has an answer, because the two
 * are not equally fresh: `state.current` is the summary from the moment the session
 * was opened and nothing refreshes it in place, while the bridge reads its index
 * per request. A PR raised during the conversation reaches the header this way and
 * no other. The summary is what makes the first paint instant, and the fallback
 * whenever the fetch has not answered or could not.
 */
function headerPrs() {
    if (state.prStatus && state.prStatus.size) return [...state.prStatus.values()];
    return (state.current && state.current.prs) || [];
}

/**
 * One of the session's pull requests, with its status as an icon and a colour.
 *
 * Drawn from the transcript, so it appears with the header rather than after a
 * round trip to GitHub — `status` starts as `unknown` and the fetch below fills it
 * in. The status is spelled out in the tooltip because an icon can be recognised
 * without being read, and these get small.
 */
function prLink(pr) {
    const live = (state.prStatus && state.prStatus.get(pr.url)) || null;
    const status = (live && live.status) || 'unknown';

    const tip = [
        live && live.label,
        live && live.title,
        ...((live && live.detail) || []),
        [`#${pr.number}`, pr.repo, live && live.updatedAt && `updated ${ago(live.updatedAt)} ago`]
            .filter(Boolean).join(' · '),
    ].filter(Boolean).join('\n');

    return el('a', {
        class: 'pr', 'data-status': status, title: tip,
        href: pr.url, target: '_blank', rel: 'noreferrer',
    }, icon(PR_ICON[status] || 'pr', 13), `PR #${pr.number}`);
}

/**
 * Ask GitHub what became of this session's PRs.
 *
 * Its own request rather than part of the session payload, because that one is
 * also the rail's and must not wait on a network call. Failure is silent for the
 * same reason a missing channel strip is: the links are already on screen and
 * still work, they simply stay grey.
 */
async function loadPrStatus() {
    if (!state.current) return;
    // No guard on the summary having PRs: a session that had none when it was
    // opened is exactly the one that raises its first mid-conversation, and the
    // bridge answers a session with none from its index without asking GitHub.
    const id = state.current.sessionId;
    try {
        const { prs } = await get(`/api/sessions/${id}/prs`);
        if (!state.current || state.current.sessionId !== id) return;
        state.prStatus = new Map((prs || []).map(pr => [pr.url, pr]));
        renderHeader();
    } catch {
        // Leaves whatever was known before, which is better than blanking it.
    }
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
    // A getter, not the array: the run is emptied in place at four different
    // places, and a copy taken here would go stale at every one of them.
    get run() { return state.run; },
};

const AGENT_VIEW = {
    isAgent: true,
    nodes: state.agentNodes, tools: state.agentTools,
    get log() { return dom.agentLog; },
    get scroll() { return dom.agentScroll; },
    get run() { return state.agentRun; },
};

function appendEvents(events, view = SESSION_VIEW) {
    let frag = document.createDocumentFragment();
    // Closing a run wraps nodes that are already in the log around nodes that
    // are still in this fragment, so the fragment goes in first. Cheap: it
    // happens once per message, not once per event.
    const flush = () => {
        if (frag.childNodes.length) view.log.append(frag);
        frag = document.createDocumentFragment();
    };
    let newTurn = false;
    let sawAgent = false;
    let newTasks = false;
    for (const ev of events) {
        if (ev.kind === 'tool-result') { patchTool(ev, view); continue; }
        // A suggested follow-up is not part of the conversation, it is an offer
        // about it — so it comes out here and is drawn in the aside instead.
        // Taken from either view: a subagent that suggests something has
        // suggested it to this session, and the panel is the session's.
        if (ev.kind === 'suggestion') {
            if (!state.tasks.has(ev.id)) { state.tasks.set(ev.id, ev); newTasks = true; }
            continue;
        }
        if (view.nodes.has(ev.id)) continue;
        const node = renderEvent(ev);
        if (!node) continue;
        view.nodes.set(ev.id, { ev, node });
        // Where the run of tool calls begins and ends. Decided here rather than
        // at the top of the loop because the three `continue`s above never
        // produce a node — a tool-result patches one that exists, a suggestion
        // is drawn in the aside, a repeat is already on screen — and treating
        // any of them as the end of a run would split it for a reason nothing
        // on screen accounts for.
        if (ev.kind === 'tool' || (ev.kind === 'thinking' && grouping().groupIncludesThinking)) {
            view.run.push(ev.id);
        } else {
            flush();
            closeRun(view);
        }
        if (ev.kind === 'tool') {
            view.tools.set(ev.id, { ev, node });
            if (ev.name === 'Task' || ev.name === 'Agent') sawAgent = true;
        }
        if (ev.kind === 'user') {
            newTurn = true;
            // The transcript has caught up with the row drawn at Send, so that row
            // gives way to this one. Which entry it is cannot be checked and must
            // not be guessed at: `claude` mints the uuid, and rewrites the text on
            // the way in often enough — a slash command arrives parsed, an envelope
            // is stripped — that matching on it would fail exactly when it mattered
            // and leave the message on screen twice. What is reliable is the order.
            // One user entry lands per send, sends are strictly ordered, and only
            // one row is ever pending, so the entry that arrives is the row that is
            // waiting. Retiring it here rather than after the append is what keeps
            // the swap invisible: both happen before the next frame is painted.
            // A subagent's own prompt is not ours — different transcript, different
            // pane — so the session view is the only one that reconciles.
            if (!view.isAgent && state.pendingSend && state.current
                && state.pendingSend.sessionId === state.current.sessionId) {
                clearPendingSend();
            }
        }
        frag.append(node);
    }
    flush();
    // A transcript that ends in tool calls has no message coming to close the
    // last run — openSession replays a finished conversation in one call, and
    // that run would otherwise stay unfolded forever. Only when nothing is
    // running: mid-turn, the calls on screen are the work you are watching.
    if (!isBusy()) closeRun(view);
    if (newTasks) renderTasks();
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
    // Read before the swap: `fresh` is not in the document yet, so asking it
    // what it belongs to answers nothing.
    const fold = entry.node.closest('.trun');
    entry.node.replaceWith(fresh);
    entry.node = fresh;
    // A result landing on a run that has already folded moves its clock on and
    // may be the error the row has to own up to.
    if (fold) paintRunSummary(fold);
    view.nodes.set(entry.ev.id, entry);
    // A result landing on a Task call is a subagent finishing: the strip says so.
    if (!view.isAgent && entry.ev.agent) renderAgents();
}

// ── runs of tool calls ───────────────────────────────────────────────────
//
// Between one message and the next an agent may make thirty tool calls, and the
// transcript printed every one of them. Scrolling back through a long session
// meant scrolling past walls of Read/Bash/Edit to find the sentences that say
// what actually happened.
//
// So a run of them folds into a single row once a message closes it — the same
// row a tool call draws, with "16 tool calls" where the name goes and a tally
// where the command goes. Only once it is *closed*: while the calls are still
// arriving they are the work you are watching, and folding them as they land
// would be taking the transcript away mid-turn.
//
// The rows are moved into the fold, not redrawn. That is what keeps patchTool
// and redrawEvent working — they replace a node wherever it happens to be — and
// it is why a tool block you had opened is still open when you open the fold.

/** Is a turn in flight? While one is, the last run is still being written. */
function isBusy() {
    const r = state.runner;
    return Boolean(r && (r.state === 'busy' || r.state === 'starting'));
}

/**
 * Fold the run of tool calls that has just ended.
 *
 * Contiguity is checked against the DOM rather than assumed, because three
 * things append straight to the log without going through appendEvents: the
 * line left behind when you answer a permission, the message row drawn at Send
 * before the transcript has it, and the permission card itself. Any of them can
 * land in the middle of a run, and wrapping first-to-last would swallow it and
 * reorder the conversation. Each contiguous stretch folds on its own instead,
 * so what is on screen keeps the order it was written in.
 */
function closeRun(view) {
    const ids = view.run;
    if (!ids.length) return;
    const opts = grouping();
    if (!opts.groupToolCalls) { ids.length = 0; return; }

    let run = [];
    const runs = [];
    for (const id of ids) {
        const entry = view.nodes.get(id);
        const node = entry && entry.node;
        if (!node || node.parentNode !== view.log) {
            if (run.length) runs.push(run);
            run = [];
            continue;
        }
        if (run.length && run[run.length - 1].node.nextElementSibling !== node) {
            runs.push(run);
            run = [];
        }
        run.push(entry);
    }
    if (run.length) runs.push(run);
    ids.length = 0;

    for (const r of runs) {
        if (r.filter(e => e.ev.kind === 'tool').length < opts.groupMinCalls) continue;
        foldRun(r);
    }
}

/** Wrap one contiguous stretch of rows in a fold, in place. */
function foldRun(entries) {
    const det = el('details', { class: 'trun' });
    det.append(el('summary', {}));
    entries[0].node.before(det);
    for (const e of entries) det.append(e.node);
    // The events themselves, so a result arriving after the fold can redraw the
    // row. patchTool assigns into the event object rather than replacing it, so
    // this list stays true without being rebuilt.
    det.runEvents = entries.map(e => e.ev);
    paintRunSummary(det);
    return det;
}

/**
 * Draw the fold's own row.
 *
 * `.trow` wears the same clothes as a collapsed tool call's summary,
 * deliberately: this is one more row of the same kind, and the only thing it
 * says differently is how many.
 */
function paintRunSummary(det) {
    const evs = det.runEvents || [];
    if (!evs.length) return;
    const tools = evs.filter(e => e.kind === 'tool');
    const thoughts = evs.length - tools.length;

    // In the order they were first used, which reads as an account of the run.
    // Sorting by count would put the same three names at the front every time
    // and say nothing about what the agent actually did first.
    const byName = new Map();
    for (const e of tools) byName.set(e.name, (byName.get(e.name) || 0) + 1);
    const parts = [...byName].map(([name, n]) => (n > 1 ? `${name} \u00d7${n}` : name));
    if (thoughts) parts.push(thoughts > 1 ? `${thoughts} thoughts` : '1 thought');

    // Wall time across the run, which is what you would have watched. A call
    // that was interrupted has no result and no end; the ones either side of it
    // still bound the span.
    const start = Date.parse(evs[0].ts);
    let end = start;
    for (const e of evs) {
        const t = Date.parse(e.resultTs || e.ts);
        if (Number.isFinite(t) && t > end) end = t;
    }
    const span = Number.isFinite(start) && end > start ? end - start : 0;

    // Never 'pending': a closed run has nothing still running, and the dot for
    // that one breathes.
    const status = evs.some(e => e.status === 'error' || e.isError) ? 'error' : 'ok';

    det.querySelector(':scope > summary').replaceChildren(
        el('div', { class: 'ev ev-trun' },
            // The clock is the row's, not the reader's: a screen reader
            // announcing it inside the button's label would be reading out the
            // gutter it is already skipping everywhere else.
            el('div', { class: 'ev-time', 'aria-hidden': 'true' }, clockOf(evs[0].ts)),
            el('div', { class: 'ev-body' },
                el('div', { class: 'trow', 'data-status': status },
                    el('span', { class: 'caret' }, '\u25b6'),
                    el('span', { class: 'tname' },
                        `${tools.length} tool call${tools.length === 1 ? '' : 's'}`),
                    el('span', { class: 'targ' }, parts.join(' \u00b7 ')),
                    el('span', { class: 'tmeta' }, dur(span)),
                ),
            ),
        ),
    );
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
        case 'peer-message': return renderPeerMessage(ev);
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

// ── suggested follow-ups ─────────────────────────────────────────────────
//
// Work an agent noticed and did not do, drawn beside the conversation rather
// than in it.
//
// The agent files these through a tool this app gives it (bridge/suggest-mcp.js),
// so an offer is a tool call in the transcript like any other — which is why it
// survives a reload, appears in a second window, and can be read out of a
// session this bridge does not own. Nothing about the offer is stored here; only
// what you decided about it, which is the bridge's suggestions.json.
//
// **An aside, not part of the log.** The transcript is a record of what
// happened, and an offer is the one thing in the pane that has not happened yet
// — it is a decision waiting on you. Inline, it interrupted the reading and
// scrolled away from you; here it stays put and stays optional. appendEvents
// lifts these out of the event stream on the way past, so the log never sees one.
//
// The panel collapses to a strip, because a session that suggested six things
// should not be permanently narrower than one that suggested none. Each task
// collapses on its own too, and the default is per task rather than global: an
// offer you have not dealt with opens itself, one you have opens to a line.

/** What a task's body should do when nothing has been said about it. */
const taskOpenByDefault = (acted) => !acted;

/** The whole aside, rebuilt from state.tasks. Cheap: there are never many. */
function renderTasks() {
    const tasks = [...state.tasks.values()];
    dom.tasks.hidden = !tasks.length;
    if (!tasks.length) return;

    // Only the ones still on offer are counted. A count that includes things you
    // have already dealt with is a number that never goes down, which is the
    // opposite of what a count on a to-do list is for.
    const open = tasks.filter(t => !state.suggestions.get(t.id)).length;
    const label = open ? String(open) : '✓';
    dom.tasksCount.textContent = label;
    dom.tasksStripCount.textContent = label;

    dom.tasksStrip.hidden = !state.tasksShut;
    dom.tasksOpen.hidden = state.tasksShut;
    dom.tasks.classList.toggle('shut', state.tasksShut);
    if (state.tasksShut) return;   // nothing behind the strip needs building

    dom.tasksList.replaceChildren(...tasks.map(taskCard));
}

/**
 * One task.
 *
 * A `details`, which is the same thing a tool call is in the log, so the caret
 * and the keyboard behaviour are the browser's rather than ours. The summary is
 * the title alone; everything that would make the panel wide lives inside.
 */
function taskCard(ev) {
    const acted = state.suggestions.get(ev.id) || null;
    const remembered = state.taskOpen.get(ev.id);
    const open = remembered === undefined ? taskOpenByDefault(acted) : remembered;

    const det = el('details', {
        class: 'task', 'data-status': acted ? acted.status : 'open',
        'data-task': ev.id,
        open,
        ontoggle: (e) => state.taskOpen.set(ev.id, e.currentTarget.open),
    },
    el('summary', {},
        el('span', { class: 'caret' }, '▶'),
        el('span', { class: 'task-name' }, ev.title || firstLine(ev.prompt)),
        // A button inside the summary, which is legal and works — but the click
        // has to be stopped, or it reaches the summary and folds the card at the
        // same moment the dialog opens over it.
        el('button', {
            class: 'task-open', type: 'button', title: 'Read this at full width',
            'aria-label': 'Read this at full width',
            onclick: (e) => { e.preventDefault(); e.stopPropagation(); openTaskDialog(ev); },
        }, '⤢'),
    ));

    const body = el('div', { class: 'task-body' });
    if (ev.why) body.append(el('div', { class: 'task-why' }, ev.why));
    // The prompt in full. It is the thing being offered and the only way to
    // judge the offer; a preview would mean starting a session on a message you
    // have not read.
    body.append(el('div', { class: 'task-prompt prose', html: renderMarkdown(ev.prompt) }));
    // Only when it is somewhere other than where this conversation is happening.
    // Almost every task runs in the session's own directory, and repeating that
    // path down the panel is three lines of noise saying nothing — but a task
    // pointed at a *different* checkout is worth knowing about before you start it.
    if (ev.cwd && ev.cwd !== (state.current && state.current.cwd)) {
        body.append(el('div', { class: 'task-cwd' }, ev.cwd));
    }

    body.append(taskActions(ev));

    det.append(body);
    return det;
}

/**
 * What you can do about a task: the same three buttons wherever it is shown.
 *
 * Built fresh each time rather than moved between the card and the dialog, so
 * the two can be on screen at once and neither steals the other's controls.
 */
function taskActions(ev) {
    const acted = state.suggestions.get(ev.id) || null;

    if (acted && acted.status === 'started') {
        return el('div', { class: 'task-done' },
            el('span', {}, 'Started'),
            acted.startedId
                ? el('button', { class: 'linky', type: 'button',
                    onclick: () => { closeTaskDialog(); openSession(acted.startedId); } }, 'open it')
                : null,
            // Undo, because a task that has gone quiet with no way back is a task
            // that lies once the session it names has been deleted.
            el('button', { class: 'linky', type: 'button',
                onclick: () => actOnSuggestion(ev, null) }, 'offer again'),
        );
    }
    if (acted && acted.status === 'dismissed') {
        return el('div', { class: 'task-done' },
            el('span', {}, 'Dismissed'),
            el('button', { class: 'linky', type: 'button',
                onclick: () => actOnSuggestion(ev, null) }, 'undo'),
        );
    }
    return el('div', { class: 'task-btns' },
        el('button', { class: 'more-btn primary', type: 'button',
            onclick: (e) => startSuggestion(ev, e.currentTarget) }, 'Start'),
        el('button', { class: 'more-btn', type: 'button',
            onclick: () => { closeTaskDialog(); openNew({ cwd: ev.cwd || '', prompt: ev.prompt }); } },
        'Edit first'),
        el('button', { class: 'more-btn', type: 'button',
            onclick: () => actOnSuggestion(ev, 'dismissed') }, 'Dismiss'),
    );
}

// ── a task at a readable width ───────────────────────────────────────────
//
// The panel is 300px, which is right for scanning a list and wrong for reading
// a prompt written to brief an agent that has none of your context — those run
// to paragraphs, and judging one means reading all of it rather than the first
// two lines. So the panel keeps the list, and this is where you read the thing.
//
// The same three buttons are here as well as there. A dialog you have to close
// before you can act on what it told you is a dialog that made you read twice.

/** Show one task in the dialog. */
function openTaskDialog(ev) {
    state.taskDialog = ev.id;
    dom.taskDlgTitle.textContent = ev.title || 'Suggested follow-up';

    dom.taskDlgWhy.textContent = ev.why || '';
    dom.taskDlgWhy.hidden = !ev.why;

    dom.taskDlgPrompt.innerHTML = renderMarkdown(ev.prompt);

    // Named unconditionally here, unlike on the card. The card leaves it out when
    // it is the obvious directory because three copies of one path down a narrow
    // column is noise; this is the place you came to read the whole thing, and
    // "where would this run" is part of that.
    dom.taskDlgCwd.textContent = ev.cwd || '';
    dom.taskDlgCwd.hidden = !ev.cwd;

    paintTaskDialogActions(ev);
    dom.taskScrim.hidden = false;
    dom.taskDlgCopy.focus();
}

/** Rebuild just the buttons, for a decision taken while the dialog is open. */
function paintTaskDialogActions(ev) {
    dom.taskDlgActs.replaceChildren(taskActions(ev));
}

function closeTaskDialog() {
    if (dom.taskScrim.hidden) return;
    dom.taskScrim.hidden = true;
    const id = state.taskDialog;
    state.taskDialog = null;
    // Back to the summary the dialog was opened from, so the keyboard does not
    // land on the body. It may have been rebuilt underneath — find it by id.
    const back = id && dom.tasksList.querySelector(`[data-task="${CSS.escape(id)}"] summary`);
    if (back) back.focus();
}

/**
 * Start the session a task describes, exactly as the dialog would.
 *
 * `plan` rather than the mode this session is in: a prompt written by an agent
 * for an agent has had no human read it as an instruction yet, and the first
 * thing the new session should do is say what it intends. It is also what the
 * Start dialog defaults to.
 */
async function startSuggestion(ev, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Starting'; }
    try {
        const r = await post('/api/sessions', {
            cwd: ev.cwd || (state.current && state.current.cwd),
            prompt: ev.prompt,
            permissionMode: 'plan',
            // A task raised inside a test session is scratch work too.
            test: state.dev && !!(state.current && state.current.test),
        });
        await actOnSuggestion(ev, 'started', r.sessionId);
        closeTaskDialog();
        toast('Session started.', 'ok');
        openSessionSoon(r.sessionId);
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Start'; }
        toast(`Could not start it: ${err.message}`, 'error');
    }
}

/**
 * Record what happened to a task, and redraw the panel.
 *
 * `status` of null undoes — the task goes back to offering itself. Optimistic,
 * then put back if the bridge refuses, because these are single clicks on
 * something already on screen and a round trip before anything moves reads as a
 * dead button.
 */
async function actOnSuggestion(ev, status, startedId = null) {
    const sessionId = state.current && state.current.sessionId;
    if (!sessionId) return;
    const before = state.suggestions.get(ev.id) || null;

    if (status) state.suggestions.set(ev.id, { status, startedId, at: Date.now() });
    else state.suggestions.delete(ev.id);
    // Deciding about a task is also finishing with it, so it folds away — and
    // undoing opens it again. Left to the default rather than remembered, which
    // is the one place the remembered state would be actively unhelpful.
    state.taskOpen.delete(ev.id);
    renderTasks();
    if (state.taskDialog === ev.id) paintTaskDialogActions(ev);

    try {
        await post(`/api/sessions/${sessionId}/suggestions/${ev.id}`, { status, startedId });
    } catch (err) {
        if (before) state.suggestions.set(ev.id, before);
        else state.suggestions.delete(ev.id);
        renderTasks();
        if (state.taskDialog === ev.id) paintTaskDialogActions(ev);
        toast(`Could not save that: ${err.message}`, 'error');
    }
}

/** The first line of a block of text, for a row with room for one. */
function firstLine(text, max = 70) {
    const line = String(text || '').split('\n').find(l => l.trim()) || '';
    return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Put the panel away, or bring it back. Remembered across sessions. */
function showTasks(on) {
    state.tasksShut = !on;
    localStorage.setItem('tasksShut', state.tasksShut ? '1' : '0');
    renderTasks();
    // Focus follows the thing that replaced what was clicked, so the keyboard
    // does not land on the body after either direction.
    (state.tasksShut ? dom.tasksStrip : dom.tasksCollapse).focus();
}

/**
 * Replace one already-rendered event's node with a freshly built one.
 *
 * Almost everything in the log is a fact about the transcript and never moves.
 * The exception is anything naming another session: a peer message and a
 * `SendMessage` block both want the peer list, which is fetched lazily, so they
 * are drawn once without it and again once it lands. See warmPeers.
 *
 * Both views are searched, because a subagent's transcript is a pane of its own.
 * Which one holds the node is not worth asking about — the id is unique either
 * way, and both panes stay mounted.
 */
function redrawEvent(ev) {
    for (const nodes of [state.nodes, state.agentNodes]) {
        const entry = nodes.get(ev.id);
        if (!entry || !entry.node.isConnected) continue;
        const next = renderEvent(ev);
        if (!next) return;
        entry.node.replaceWith(next);
        nodes.set(ev.id, { ev, node: next });
        return;
    }
}

/**
 * Put names to the sessions this conversation talked to.
 *
 * A message card and a `SendMessage` block both want to say *which* session,
 * and to offer a way into it — which needs the peer list, which is fetched
 * lazily because most conversations never mention another session at all. So
 * the cards draw without it and are redrawn once it lands, rather than every
 * conversation paying for a request it does not need.
 *
 * Only when something in the log actually refers to a peer, and only when the
 * fetch told us something new: a list already in hand means the cards were
 * drawn right the first time and redrawing them would collapse a tool block
 * somebody had just opened.
 */
async function warmPeers() {
    const cards = [...state.nodes.values()].filter(({ ev }) =>
        ev.kind === 'peer-message' || (ev.kind === 'tool' && ev.name === 'SendMessage'));
    if (!cards.length) return;
    const before = state.peers.at;
    try { await loadPeers(); } catch { return; }
    if (state.peers.at === before) return;
    for (const { ev } of cards) redrawEvent(ev);
}

/**
 * A message from another Claude session.
 *
 * Claude Code delivers one as a user message, because a conversation still has
 * no other channel — so left alone it renders as though somebody had pasted it
 * at you. It is marked meta as well, which is why until now it rendered as
 * nothing at all: a session that got messaged showed an empty gap.
 *
 * The sender's name is also its address — `SendMessage` takes a name and there
 * is no other way to say who you mean — so Reply seeds the composer with it
 * rather than trying to send anything itself. What happens next is the agent's
 * to decide, which is the point of the feature.
 */
function renderPeerMessage(ev) {
    const who = ev.fromName || ev.from || 'another session';
    const peer = ev.fromName ? peerByName(ev.fromName) : null;

    const body = [el('div', { class: 'ev-label' }, `Message from ${who}`)];
    if (peer && peer.title && peer.title !== who) {
        body.push(el('div', { class: 'peer-sub' }, peer.title));
    }
    body.push(el('div', { class: 'prose', html: renderMarkdown(ev.text || '') }));

    const btns = [];
    // Only when that session is one this app can show. A peer is often a
    // background agent with no transcript indexed here, and a button that
    // 404s is worse than no button.
    if (peer && peer.sessionId) {
        btns.push(el('button', { class: 'more-btn', type: 'button',
            onclick: () => openSession(peer.sessionId) }, 'Open that session'));
    }
    if (ev.fromName) {
        btns.push(el('button', { class: 'more-btn', type: 'button',
            onclick: () => insertMention(ev.fromName) }, 'Reply'));
    }
    if (btns.length) body.push(el('div', { class: 'subagent-btns' }, ...btns));

    return row(ev, 'peer-message', ...body);
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
// A blocked turn, never a toast: toasts are dismissible and this is not — the
// turn is waiting on the answer.
//
// Three things arrive down this channel and only one of them is a permission,
// so each gets the surface its answer actually needs:
//
//   tool      may I run this? — yes, yes-always, or no. One line about one
//             call, and where in the transcript it happened is part of what
//             you are judging, so it stays a card at the foot of the log.
//   question  a multiple-choice question, or several. Docked above the
//             composer, one at a time, everything about each option open.
//   plan      a document. It takes the conversation over, because reading one
//             through a card-sized porthole is how plans get approved unread.
//             Turning it down is feedback, not a refusal, so there is
//             somewhere to say what was wrong with it.
//
// One ask per session at a time — the bridge guarantees that — so exactly one
// of the three surfaces is ever up, and renderAsk clears all of them first.

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

/** Don't fire single-key shortcuts at somebody who is writing a sentence. */
const isTyping = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

/**
 * A plan waiting in the transcript of a session this bridge does not own.
 *
 * `ExitPlanMode` is a tool call like any other, so the moment Claude asks the
 * question the call — plan text and all — is in the JSONL, and it stays
 * `pending` until the answer produces a result. Any window reading the file can
 * therefore *read* a plan belonging to a session running somewhere else: the
 * everyday window, a second window, an agent's dev bridge.
 *
 * Answering is a different matter and deliberately not attempted here. The
 * control request lives in the process that raised it, and only the bridge that
 * owns that process can respond — which is why what comes back is marked
 * read-only and the view drops its buttons.
 *
 * A live runner here is the authority on what it is blocked on, so this is only
 * consulted when there is no runner. Otherwise a plan just approved would
 * reappear read-only for the moment between the answer and its tool result.
 */
function transcriptPlan() {
    if (!state.current || state.runner) return null;
    let found = null;
    for (const { ev } of state.tools.values()) {
        if (ev.name !== 'ExitPlanMode' || ev.status !== 'pending') continue;
        if (!found || Date.parse(ev.ts) >= Date.parse(found.ts)) found = ev;
    }
    if (!found) return null;
    return {
        // Stable across ticks, and unmistakable for a real request id — nothing
        // may be POSTed against it.
        requestId: `transcript:${found.id}`,
        kind: 'plan',
        tool: 'ExitPlanMode',
        displayName: 'ExitPlanMode',
        input: found.input || {},
        readOnly: true,
    };
}

/**
 * Settle what the session is blocked on: the live ask if we own the process,
 * and otherwise whatever the transcript says is still waiting.
 */
function refreshAsk(runnerAsk) {
    const ask = runnerAsk || transcriptPlan();
    const same = ask && state.ask && ask.requestId === state.ask.requestId;
    // Redraw on any change, and also when the surface should be up but is not —
    // coming back from a subagent leaves the pane without one. Never otherwise:
    // this runs on every status tick and every tail, and rebuilding the question
    // dock would throw away answers that are half typed.
    if (!same || (ask && !askShowing())) {
        state.ask = ask;
        renderAsk();
    }
}

/** Is the surface for the ask on screen already? */
const askShowing = () => Boolean(
    dom.log.querySelector('.perm') || !dom.askDock.hidden || !dom.planPane.hidden);

/** Whichever element is currently carrying the ask, for disabling and dimming. */
function askRoot() {
    const kind = state.ask && state.ask.kind;
    if (kind === 'plan') return dom.planPane;
    if (kind === 'question') return dom.askDock;
    return dom.log.querySelector('.perm');
}

/** Show, replace or clear whatever the session is blocked on. */
function renderAsk() {
    const old = dom.log.querySelector('.perm');
    if (old) old.remove();
    dom.askDock.hidden = true;
    delete dom.askDock.dataset.pending;
    dom.planPane.hidden = true;
    delete dom.planPane.dataset.pending;

    // The dock's controls are where the answers live, so it is emptied only
    // once it is no longer the dock for the ask in hand. Going to read a
    // subagent hides it, and must not cost you the options you had picked.
    const ask = state.ask;
    const keep = ask && ask.kind === 'question' && dom.askDock.dataset.request === ask.requestId;
    if (!keep) {
        dom.askDock.replaceChildren();
        delete dom.askDock.dataset.request;
    }

    if (!ask || state.agent) return;

    const kind = ask.kind || 'tool';
    if (kind === 'plan') renderPlanPane(ask);
    else if (kind === 'question') {
        if (keep) dom.askDock.hidden = false;
        else renderQuestionDock(ask);
    } else renderToolCard(ask);
}

/** "May I run this?" — the original card, in the original place. */
function renderToolCard(ask) {
    const card = el('div', { class: 'perm perm-tool-ask', tabindex: '0', role: 'group',
        'aria-label': `Permission needed for ${ask.displayName}` });

    card.append(el('div', { class: 'perm-head' },
        el('span', { class: 'perm-tool' }, ask.displayName),
        el('span', { class: 'perm-title' }, 'permission needed')));

    if (ask.agentId) card.append(el('div', { class: 'perm-why' }, 'Asked by a subagent.'));

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

    dom.log.append(card);

    // Taking focus makes the single-key answers work without a click, but only
    // when the user is actually here — stealing focus from another window, or
    // from something being typed, would be worse than a click.
    if (document.hasFocus() && !dom.input.matches(':focus')) card.focus({ preventScroll: true });
    if (state.pinned) scrollToEnd(false);
}

/**
 * A plan, and the two things approving one actually decides: that the work
 * starts, and what it is allowed to do once it has.
 *
 * The session is in plan mode while this is up, so approving without changing
 * the mode would agree to the plan and then refuse every edit in it. That is
 * why these are one button and not two steps.
 *
 * The pane itself is markup, not built here — it persists across renders, so
 * its listeners are wired once at the foot of this file rather than stacked up
 * one deep per status tick.
 */
function renderPlanPane(ask) {
    dom.planDoc.innerHTML = renderMarkdown((ask.input && ask.input.plan) || ask.description || '');
    dom.planAgent.hidden = !ask.agentId;
    dom.planTitle.textContent = ask.readOnly ? 'waiting in another window' : 'ready to start';
    dom.planPane.dataset.readonly = ask.readOnly ? '1' : '';
    if (!ask.readOnly) delete dom.planPane.dataset.readonly;

    // A new plan always arrives open. Setting one aside is a decision about
    // that plan, and it should not carry over to the next one.
    if (state.planFor !== ask.requestId) {
        state.planFor = ask.requestId;
        state.planAside = false;
    }

    dom.planFoot.replaceChildren(...(ask.readOnly
        // Read here, answered there. Which window is not something that can be
        // said — the registry names the process, not the bridge in front of it —
        // so it says what is true and stops.
        ? [el('div', { class: 'plan-elsewhere' },
            el('span', { class: 'plan-elsewhere-mark' }, '◇'),
            'This session is running in another window. The plan can be read here,'
            + ' and has to be approved where it is running.')]
        : [planButtons(), el('div', { class: 'perm-why' },
            'Approving leaves plan mode and sets the permission mode under the composer.')]));

    dom.planPane.hidden = false;
    setPlanAside(state.planAside);
    if (!state.planAside) dom.planBody.scrollTop = 0;
}

/** `auto` is the default because it is how these sessions run when you are
 *  sitting in front of one: Claude judges each call and asks when a call
 *  warrants it. Blanket-accepting edits is the deliberate second choice. */
function planButtons() {
    return el('div', { class: 'perm-btns' },
        el('button', { class: 'perm-btn allow', type: 'button',
            title: 'Start work, asking about calls that warrant it',
            onclick: () => answerAsk({ decision: 'allow', mode: 'auto' }) },
            'Approve ', el('kbd', {}, 'Y')),
        el('button', { class: 'perm-btn', type: 'button',
            title: 'Start work, and let file edits through without asking',
            onclick: () => answerAsk({ decision: 'allow', mode: 'acceptEdits' }) },
            'Approve — auto-accept edits ', el('kbd', {}, 'A')),
        el('button', { class: 'perm-btn', type: 'button',
            title: 'Approve the plan, with something to bear in mind while doing it',
            onclick: () => openFeedback(dom.planFoot, 'approve') },
            'Approve with feedback ', el('kbd', {}, 'F')),
        el('button', { class: 'perm-btn deny', type: 'button',
            onclick: () => openFeedback(dom.planFoot, 'reject') },
            'Keep planning ', el('kbd', {}, 'N')),
    );
}

/**
 * Fold the plan away to a line, or open it back up.
 *
 * Set aside, the ask is still outstanding — this is not an answer and does not
 * tell the bridge anything. It is for the times the plan only makes sense
 * against what was said before it, which is directly underneath.
 */
function setPlanAside(aside) {
    state.planAside = aside;
    if (aside) dom.planPane.dataset.collapsed = '1';
    else delete dom.planPane.dataset.collapsed;
    // Focus so Y/A/F/N answer without a click — same rule as everywhere else,
    // never taking it from another window or from something being typed.
    if (!aside && document.hasFocus() && !dom.input.matches(':focus')) {
        dom.planPane.focus({ preventScroll: true });
    }
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
 * It swaps the button row in place, wherever that row lives — the plan view's
 * pinned footer today — so the answer stays where the eye already is.
 *
 * @param {HTMLElement} host the element holding the `.perm-btns` row
 * @param {'approve'|'reject'} how
 */
function openFeedback(host, how) {
    const btns = host.querySelector('.perm-btns');
    if (!btns || host.querySelector('.perm-feedback')) return;
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
    const cancel = () => {
        box.remove();
        btns.hidden = false;
        const back = host.closest('[tabindex]') || host;
        back.focus({ preventScroll: true });
    };

    const box = el('div', { class: 'perm-feedback' }, ta,
        el('div', { class: 'perm-btns' },
            el('button', { class: `perm-btn ${approving ? 'allow' : 'deny'}`, type: 'button',
                onclick: send },
                approving ? 'Approve with this note ' : 'Send it back ', el('kbd', {}, '⏎')),
            el('button', { class: 'perm-btn', type: 'button', onclick: cancel }, 'Cancel')));

    ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' && !(e.key === 'Enter' && !e.shiftKey)) return;
        e.preventDefault();
        // The surface behind this box answers Escape too — by setting a plan
        // aside. Closing the box must not also do that, and cancel() has
        // already removed the box the surface would have tested for.
        e.stopPropagation();
        if (e.key === 'Escape') cancel(); else send();
    });

    btns.hidden = true;
    btns.after(box);
    ta.focus();
}

/**
 * A multiple-choice question, or several, docked above the composer.
 *
 * Native radios and checkboxes rather than clickable divs: arrow keys, space,
 * groups and labels all work without being reimplemented, and a question is
 * exactly the moment not to have reinvented a form control. Every question has
 * an "Other" row, because the honest answer is often none of the above.
 *
 * All of them are built at once and all of them stay in the DOM — only the one
 * you are on is shown. That is what makes browsing free: the controls hold the
 * answers, so there is nothing to save and restore on the way past.
 */
function renderQuestionDock(ask) {
    const questions = (ask.input && ask.input.questions) || [];
    const readers = [];
    const groups = [];
    const dots = [];
    // A question moves you on once. Coming back to change an answer must not
    // fling you forward again — that is the moment you wanted to stay.
    const advanced = new Set();
    let at = 0;

    const body = el('div', { class: 'ask-dock-body' }, el('div', { class: 'perm-qs' }));
    const wrap = body.firstChild;

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
            box.addEventListener('change', () => picked(qi, q));
            picks.push({ box, label: opt.label || '' });
            group.append(el('label', { class: 'perm-opt', for: `${name}-o${oi}` }, box,
                el('span', { class: 'perm-opt-body' },
                    el('span', { class: 'perm-opt-label' }, opt.label || ''),
                    opt.description ? el('span', { class: 'perm-opt-desc' }, opt.description) : null,
                    // Simply there. A preview is what you are comparing, and one
                    // that only appears under the pointer cannot be compared.
                    opt.preview ? el('pre', { class: 'perm-opt-preview' }, opt.preview) : null)));
        }

        const otherBox = el('input', { type, name, id: `${name}-other` });
        const otherText = el('input', { type: 'text', class: 'perm-other', autocomplete: 'off',
            'aria-label': `A different answer to "${q.question || ''}"`, placeholder: 'Something else…' });
        // Choosing "Other" is the one pick that never moves you on: the answer
        // is the sentence you are about to type, not the radio.
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

        groups.push(group);
        wrap.append(group);
    });

    // ── the answer row ───────────────────────────────────────────────────
    const submit = el('button', { class: 'perm-btn allow', type: 'button',
        onclick: () => answerAsk({ decision: 'allow', answers: collect() }) },
        questions.length > 1 ? 'Send answers ' : 'Send answer ', el('kbd', {}, '⏎'));
    const remain = el('span', { class: 'ask-remain' });
    const btns = el('div', { class: 'perm-btns' }, submit,
        el('button', { class: 'perm-btn deny', type: 'button',
            title: 'Answer nothing and let Claude decide for itself',
            onclick: () => answerAsk({ decision: 'deny' }) },
            'Skip'),
        remain);

    // ── browsing ─────────────────────────────────────────────────────────
    const prev = el('button', { class: 'ask-step', type: 'button',
        'aria-label': 'The question before this one', onclick: () => show(at - 1) }, '‹');
    const next = el('button', { class: 'ask-step', type: 'button',
        'aria-label': 'The next question', onclick: () => show(at + 1) }, '›');
    const count = el('span', { class: 'ask-nav-count' });
    const dotWrap = el('div', { class: 'ask-dots' });
    questions.forEach((q, qi) => {
        const dot = el('button', { class: 'ask-dot', type: 'button',
            title: q.header || clip(q.question || '', 60) || `Question ${qi + 1}`,
            'aria-label': `Question ${qi + 1}: ${q.header || q.question || ''}`,
            onclick: () => show(qi) });
        dots.push(dot);
        dotWrap.append(dot);
    });
    const nav = el('div', { class: 'ask-nav' }, prev, dotWrap, count, next);

    function show(i) {
        if (i < 0 || i >= groups.length) return;
        at = i;
        groups.forEach((g, gi) => { g.hidden = gi !== i; });
        body.scrollTop = 0;
        update();
        // Landing on the first control makes the arrow keys pick options and
        // Enter send, so a set of questions can be answered without the mouse.
        const first = groups[i].querySelector('input');
        if (first && document.hasFocus() && !dom.input.matches(':focus')) {
            first.focus({ preventScroll: true });
        }
    }

    /** The next question with no answer yet, wrapping — or -1 if there is none. */
    function nextOpen(from) {
        for (let n = 1; n < readers.length; n++) {
            const i = (from + n) % readers.length;
            if (!readers[i]().answer) return i;
        }
        return -1;
    }

    function picked(qi, q) {
        update();
        if (q.multiSelect || advanced.has(qi)) return;
        advanced.add(qi);
        // Long enough that the option you chose is seen to be chosen before the
        // question changes under you — at half this it read as the question
        // being yanked away rather than as an answer landing.
        setTimeout(() => {
            if (at !== qi) return;
            const to = nextOpen(qi);
            if (to >= 0) show(to);
        }, 450);
    }

    function collect() {
        const out = {};
        for (const read of readers) {
            const { question, answer } = read();
            if (answer) out[question] = answer;
        }
        return out;
    }

    // Claude asked all of them; answering some and leaving the rest to guesswork
    // is the outcome this dock exists to avoid. Which ones are still open is on
    // the dots and spelled out beside the button — it used to be a tooltip on a
    // disabled control, which is to say nowhere.
    function update() {
        const done = Object.keys(collect()).length;
        submit.disabled = done !== readers.length;
        dots.forEach((dot, di) => {
            if (readers[di]().answer) dot.dataset.done = '1';
            else delete dot.dataset.done;
            dot.setAttribute('aria-current', di === at ? 'true' : 'false');
        });
        count.textContent = `${at + 1} of ${groups.length}`;
        prev.disabled = at === 0;
        next.disabled = at === groups.length - 1;
        const left = readers.length - done;
        remain.textContent = left ? `${left} still to answer` : '';
    }

    const inner = el('div', { class: 'ask-dock-inner' },
        el('div', { class: 'ask-dock-head' },
            el('span', { class: 'perm-tool' }, 'Question'),
            el('span', { class: 'perm-title' },
                ask.agentId ? 'from a subagent' : 'waiting on you'),
            el('span', { class: 'spacer' }),
            questions.length > 1 ? nav : null),
        body, btns);

    inner.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            if (submit.disabled) return;
            e.preventDefault();
            submit.click();
        // Plain arrows belong to the radio group under the cursor; the modifier
        // is what makes these about the set rather than the options.
        } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            show(at + (e.key === 'ArrowRight' ? 1 : -1));
        }
    });

    dom.askDock.replaceChildren(inner);
    dom.askDock.dataset.request = ask.requestId;
    dom.askDock.hidden = false;
    dom.askDock.setAttribute('aria-label', 'A question waiting for your answer');
    show(0);
}

/**
 * Send an answer to a named ask, wherever it is being answered from.
 *
 * Takes the session and the request rather than reading `state.current`, because
 * the live board answers asks belonging to sessions that are not open — which is
 * the point of that view. Throws; the caller decides what to say about it.
 *
 * @param {{decision:'allow'|'allow-always'|'deny', mode?:string,
 *          answers?:object, feedback?:string}} payload
 */
function answerAskFor(sessionId, requestId, payload) {
    return post(`/api/sessions/${sessionId}/permission`, { requestId, ...payload });
}

/**
 * Send an answer for the session on screen.
 *
 * @param {{decision:'allow'|'allow-always'|'deny', mode?:string,
 *          answers?:object, feedback?:string}} payload
 */
async function answerAsk(payload) {
    const ask = state.ask;
    if (!ask || !state.current) return;
    // Read out of a transcript, not raised by a process here: there is nothing
    // on this bridge to answer, and its requestId is not one.
    if (ask.readOnly) return;
    const root = askRoot();
    if (root) {
        for (const b of root.querySelectorAll('button')) b.disabled = true;
        root.dataset.pending = '1';
    }
    try {
        await answerAskFor(state.current.sessionId, ask.requestId, payload);
        if (payload.mode) adoptMode(payload.mode);
    } catch (err) {
        // 409 means another window got there first; the resolved event that
        // follows takes the surface down with the right reason on it.
        toast(`Could not answer: ${err.message}`, 'error');
        if (root) {
            delete root.dataset.pending;
            for (const b of root.querySelectorAll('button')) b.disabled = false;
        }
    }
}

/**
 * Approving a plan decides the mode the work runs in, so the selector has to
 * agree at once rather than after the next status tick — and to keep agreeing
 * once the process behind it has gone.
 *
 * Three caches, and all three have to move together: a mode picked from the
 * dropdown before the plan arrived is spent and must not win afterwards; the
 * per-session record of what a bridge last reported is the only lasting
 * evidence the switch happened; and the summary is corrected so a repaint
 * before the next tick does not flicker back.
 */
function adoptMode(mode) {
    const id = state.current && state.current.sessionId;
    if (!id || !mode) return;
    state.permChoice.delete(id);
    state.runnerMode.set(id, mode);
    state.current.permissionMode = mode;
    paintPerm();
}

/** Take the surface down and leave a line in the transcript saying how it ended. */
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
        // The recipient is a peer's name, which is its address but not always
        // what you call it — so the row shows the session's title when this app
        // knows one, and the raw name when it does not.
        case 'SendMessage': {
            const to = i.to || i.recipient || '?';
            const peer = peerByName(to);
            const who = peer && peer.title && peer.title !== to ? `${to} — ${peer.title}` : to;
            const said = typeof i.message === 'string' ? i.message : (i.summary || '');
            return said ? `to ${who}: ${clip(said, 60)}` : `to ${who}`;
        }
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
    } else if (ev.name === 'SendMessage') {
        // One half of a conversation between two sessions. Rendered as prose
        // rather than as a key-value dump because it is a message somebody
        // wrote, and the other half — the arrival — renders that way too.
        const said = typeof i.message === 'string' ? i.message : JSON.stringify(i.message, null, 2);
        if (i.summary) out.push(section('Summary', el('div', { class: 'prose' }, i.summary)));
        out.push(section('Message', el('div', { class: 'prose', html: renderMarkdown(said || '') })));
        const peer = peerByName(i.to || i.recipient || '');
        // Only when that session is one this app can show. Peers are often
        // background agents with no transcript indexed here, and a button that
        // 404s is worse than no button.
        if (peer && peer.sessionId) {
            out.push(el('div', { class: 'subagent-btns' },
                el('button', { class: 'more-btn', type: 'button',
                    onclick: () => openSession(peer.sessionId) }, 'Open that session')));
        }
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

/**
 * Switch the conversation pane over to one subagent's transcript.
 *
 * `quiet` is for a restore. A subagent is a detail of a session rather than a
 * place of its own, so an id that has gone should drop you back into the parent
 * transcript without saying anything — the session itself is fine, and the
 * address stops naming the subagent a moment later.
 */
async function openAgent(toolUseId, { quiet = false } = {}) {
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
    } catch (err) {
        if (!quiet) toast(`Could not open the subagent: ${err.message}`, 'error');
        // state.agent is still null, so this drops the id that did not work
        // rather than leaving the next refresh to try it again.
        else rememberView();
    }
}

/** Reset subagent state without touching the DOM — for switching sessions. */
function leaveAgent() {
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
}

/** Back to the session that spawned it. */
function closeAgent() {
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
    } else {
        enableSend(Boolean(state.current));
        applyRunner(state.runner);   // paints the lock, which owns the send buttons after this
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
    dom.channels.replaceChildren(...state.channels.map(channelChip));
}

/**
 * One port: most of the chip switches DevBrowser to it, and — while it is still
 * answering — a button on the end shuts it down.
 */
function channelChip(p) {
    const go = el('span', { class: 'go' }, p.listening ? 'Open' : 'Gone');
    const chip = el('div', {
        class: 'channel',
        'data-live': String(p.listening),
        title: p.evidence ? `${p.evidence.from}: ${p.evidence.command}` : '',
    },
        el('button', {
            class: 'chan-open', type: 'button',
            title: `Switch DevBrowser to :${p.port}`,
            onclick: () => openInDevBrowser(p, chip, go),
        },
            el('span', { class: 'led' }),
            el('span', { class: 'port' }, ':' + p.port),
            p.title ? el('span', { class: 'name' }, p.title) : null,
            go,
        ),
    );
    if (p.listening) chip.append(stopButton(p, chip, go));
    return chip;
}

/**
 * Killing a server is a click too cheap to leave unguarded: the chips sit side by
 * side, all the same size, and the one you meant is usually the neighbour of the
 * one you hit. So the first click only arms — the chip says what is about to
 * happen — and the second signals. Leaving the chip, or waiting, calls it off.
 */
function stopButton(p, chip, go) {
    let timer = null;
    const disarm = () => {
        clearTimeout(timer);
        if (chip.dataset.arm !== 'true') return;
        chip.dataset.arm = 'false';
        go.textContent = 'Open';
    };
    const btn = el('button', {
        class: 'chan-stop', type: 'button',
        title: `Stop the server on :${p.port}`,
        'aria-label': `Stop the server on :${p.port}`,
        onclick: () => {
            if (chip.dataset.arm === 'true') { disarm(); stopChannel(p, chip, go); return; }
            chip.dataset.arm = 'true';
            go.textContent = 'Stop?';
            timer = setTimeout(disarm, 4000);
            nameOwner(p, chip, btn);
        },
    }, icon('power', 13));
    chip.addEventListener('mouseleave', disarm);
    return btn;
}

/**
 * While a chip is armed, its tooltip stops describing the command that *started*
 * the server and describes the process that holds the port now. Ports get reused
 * across worktrees, so the pid and command line are the only things that say the
 * server is still the one the transcript found.
 */
async function nameOwner(p, chip, btn) {
    try {
        const r = await get(`/api/devservers/owner?port=${p.port}`);
        if (chip.dataset.arm !== 'true') return;   // disarmed while we asked
        btn.title = r.owners.length
            ? r.owners.map(o => `Stop pid ${o.pid} — ${o.command}`).join('\n')
            : `Nothing on this side owns :${p.port}`;
    } catch { /* the confirmation stands without it */ }
}

async function stopChannel(p, chip, go) {
    chip.classList.add('busy');
    go.textContent = 'Stopping';
    try {
        const r = await post('/api/devservers/stop', { port: p.port });
        const who = `:${p.port} (pid ${r.pids.join(', ')})`;
        toast(r.escalated
            ? `Stopped ${who} — it ignored SIGTERM, so it was killed.`
            : `Stopped ${who}.`, 'ok');
        // The chip's own state is now stale in more ways than one — the port is
        // dead, and its rank against the others has changed. Ask again.
        loadChannels();
    } catch (err) {
        chip.classList.remove('busy');
        go.textContent = 'Open';
        toast(err.message, 'error');
    }
}

async function openInDevBrowser(p, chip, go) {
    chip.classList.add('busy');
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
        chip.classList.remove('busy');
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

// ── live ─────────────────────────────────────────────────────────────────
// The rail is one conversation at a time, which is the right shape for reading
// one and the wrong shape for an afternoon with five agents working. This is
// the other view: a card per running session, needs-you first, so that "which
// one is stuck" is a glance rather than a round of clicking.
//
// Everything on a card arrives in a single `overview` event. Nothing here
// subscribes to a transcript.

/** Tell the bridge whether this window is watching the board. */
function syncBoardWatch() {
    if (state.live.watching === state.live.open) return;
    state.live.watching = state.live.open;
    subscribe();
}

function showLive(on) {
    state.live.open = on;
    // The other way round from showDash: turning the board on gets the
    // whole-screen board out of the way, since the two cannot both be read.
    if (on) state.dash.open = false;
    paintPanels();
    syncBoardWatch();

    // The turn clocks count up between pushes rather than with them: a board of
    // sessions all doing something slow would otherwise be perfectly still, and
    // a still clock is how a stuck turn looks.
    clearInterval(state.live.clock);
    state.live.clock = on ? setInterval(tickCardClocks, 1000) : null;

    if (liveVisible()) renderLive();
    // Coming back to a conversation: the terminal was display:none and xterm
    // cannot size itself to a box it could not measure. paintPanels refits when
    // the conversation is up; this covers the board closing entirely.
    else if (state.current) termPane.refit();
    // Closing the board is also leaving focus mode; there is nothing focused on.
    if (!on && state.focus) setFocus(false);
    else rememberView();
}

/**
 * Which way the window divides between the board and the conversation.
 *
 * Under it, the cards are a strip and the transcript keeps the full width — good
 * for reading one session while the others tick along. Beside it, the cards are
 * a column: fewer of them fit across, but many more fit down, which is the
 * arrangement for an afternoon spent watching rather than reading.
 */
function setDockSide(side) {
    state.live.dock = side ? 'side' : 'bottom';
    localStorage.setItem('liveDock', state.live.dock);
    paintDockButton();
    paintPanels();
    // A card is built differently for a strip than for a column — the strip is
    // short of height and the column is short of width — so this is a rebuild.
    if (liveVisible()) renderLive();
    rememberView();
}

function paintDockButton() {
    const side = state.live.dock === 'side';
    dom.liveSide.setAttribute('aria-pressed', String(side));
    dom.liveSide.classList.toggle('on', side);
    dom.liveSideLabel.textContent = side ? 'Side by side' : 'Stacked';
    dom.liveSide.title = side
        ? 'Put the board under the conversation'
        : 'Put the board beside the conversation';
    // The icon is the arrangement itself: two boxes above one another, or two
    // next to each other.
    const [a, b] = [dom.liveSideA, dom.liveSideB];
    if (side) {
        a.setAttribute('x', '3.5'); a.setAttribute('y', '4');
        a.setAttribute('width', '7'); a.setAttribute('height', '16');
        b.setAttribute('x', '13.5'); b.setAttribute('y', '4');
        b.setAttribute('width', '7'); b.setAttribute('height', '16');
    } else {
        a.setAttribute('x', '3.5'); a.setAttribute('y', '4');
        a.setAttribute('width', '17'); a.setAttribute('height', '7');
        b.setAttribute('x', '3.5'); b.setAttribute('y', '13');
        b.setAttribute('width', '17'); b.setAttribute('height', '7');
    }
}

/**
 * Focus mode: the board with the window to itself.
 *
 * It began as a URL — `?view=live&focus=1`, for a browser left open on a second
 * monitor — which made it unreachable from the app, whose window has no address
 * bar. So it is a toggle, and the URL follows it: what is on screen is what you
 * would get by opening the address the button leaves behind, and that address
 * can be copied into a browser on the other screen.
 */
function setFocus(on) {
    state.focus = on;
    if (on) dom.app.dataset.focus = '1';
    else delete dom.app.dataset.focus;

    // Focus mode hides the rail, and with it the menu — but not its state, which
    // would come back open and out of step with the caret.
    if (on) showNewMenu(false);

    dom.liveFocus.setAttribute('aria-pressed', String(on));
    dom.liveFocus.classList.toggle('on', on);
    // Focus mode is the board, full height, so turning it on turns the board on.
    if (on && !state.live.open) { showLive(true); return; }

    paintPanels();
    // Full and docked cards are built differently — the density changes with the
    // room available — so this is a rebuild, not just a resize.
    if (liveVisible()) renderLive();
    else if (state.current) termPane.refit();
    rememberView();
}

// What the address last said, so that a redraw on a timer does not touch history
// sixty times a minute to write down the same thing. Starts as null rather than
// the empty string, because the empty string is a real view — nothing open — and
// starting there would swallow the write that clears a session which has gone.
let lastView = null;

// Set while restoreView is putting the window back together at boot. Turning the
// board on is a view change like any other, so it would write the address — but
// the session it names has not been fetched yet, and the write would drop it
// from the very address still being read. Nothing needs writing during a restore
// in any case: the address is already what we are trying to reproduce.
let restoring = false;

/**
 * Keep the address bar honest, so the view can be reopened or copied — and so a
 * refresh lands where you were.
 *
 * The address is the whole of the memory here. Ctrl+R reloads the document URL,
 * and replaceState has been keeping that URL current all along, so a refresh
 * restores everything for free. A fresh shell launch loads the bare origin
 * (app/main.js) and therefore starts clean, which is the intended difference:
 * opening the app is not the same gesture as refreshing it.
 *
 * `view` is the panel with the screen. `live=1` is the one thing it cannot say:
 * the work-in-flight board covers the live board without closing it, so a board
 * left switched on underneath has to be written down separately or closing the
 * dashboard would reveal nothing where there was something.
 */
function rememberView() {
    if (restoring) return;
    const q = new URLSearchParams();
    if (state.dash.open) {
        q.set('view', 'dashboard');
        if (state.live.open) q.set('live', '1');
    } else if (state.live.open) {
        q.set('view', 'live');
    }
    if (state.focus) q.set('focus', '1');
    if (state.current) q.set('session', state.current.sessionId);
    if (state.agent) q.set('agent', state.agent);
    // Only while the board is up. The arrangement is not part of where you are
    // when there is no board to arrange, and a ?dock= hanging off a plain
    // conversation is noise in an address somebody might read.
    if (state.live.open) q.set('dock', state.live.dock);

    const search = q.toString();
    if (search === lastView) return;
    lastView = search;
    history.replaceState(null, '', search ? `${location.pathname}?${search}` : location.pathname);
}

/**
 * A wheel over the docked strip scrolls it along.
 *
 * A mouse only reports vertical movement, and the dock only scrolls sideways, so
 * without this the wheel did nothing at all over the one part of the screen the
 * cards are on. Down is right, which is the direction the row runs.
 */
function onDockWheel(e) {
    // Only the strip runs sideways. As a column it scrolls the ordinary way and
    // the wheel needs no help at all.
    if (dom.live.dataset.mode !== 'dock' || state.live.dock !== 'bottom') return;
    // A trackpad swiped sideways already says so; leave that alone.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

    const strip = dom.liveBody;
    const max = strip.scrollWidth - strip.clientWidth;
    if (max <= 0) return;

    // Wheels that report lines rather than pixels would otherwise creep.
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const before = strip.scrollLeft;
    strip.scrollLeft = Math.max(0, Math.min(max, before + step));
    // Only swallow the gesture when it actually moved something — at either end
    // the wheel should go back to doing whatever it would have done.
    if (strip.scrollLeft !== before) e.preventDefault();
}

function tickCardClocks() {
    for (const n of dom.liveBody.querySelectorAll('.lcard-clock[data-since]')) {
        n.textContent = dur(Date.now() - Number(n.dataset.since));
    }
}

function applyOverview(data) {
    state.live.data = data;
    state.live.at = Date.now();
    // The board is authoritative while it is open: it can see an ask that was
    // already outstanding when this window connected, which no event would have
    // told us about.
    state.waiting = new Set(data.sessions.filter(s => s.ask).map(s => s.sessionId));
    paintLiveBadge();
    // Not while the work-in-flight board is covering it: the cards would be
    // rebuilt once a second for nobody to look at.
    if (liveVisible()) renderLive();
}

/** Whether the board is actually on screen, rather than merely switched on. */
const liveVisible = () => state.live.open && !state.dash.open;

/**
 * How many sessions are waiting on you, on the button that opens the board.
 *
 * Counted in people-blocking things, not in running ones: five agents working
 * is the normal state of this machine and not news, and one of them stopped
 * with a question is the whole reason to look.
 *
 * Kept from the `permission-request` and `permission-resolved` broadcasts rather
 * than from the board's own payload, because the badge's whole job is to be
 * right when the board is *shut* — reading it from a channel nobody is
 * subscribed to left it blank until first opened and frozen ever after. Those
 * events already reach every window; this only counts them.
 */
function paintLiveBadge() {
    const waiting = state.waiting.size;
    dom.liveBadge.hidden = !waiting;
    dom.liveBadge.textContent = String(waiting);
    dom.liveBadge.classList.toggle('urgent', waiting > 0);
    dom.btnLive.title = waiting
        ? `${waiting} session${waiting === 1 ? ' is' : 's are'} waiting for you (Ctrl+2)`
        : 'Every session running right now (Ctrl+2)';
}

/** Prime the badge at boot, for asks that were already outstanding. */
async function primeWaiting() {
    try {
        const d = await get('/api/overview');
        state.waiting = new Set(d.sessions.filter(s => s.ask).map(s => s.sessionId));
        paintLiveBadge();
    } catch { /* the first permission event will start the count off anyway */ }
}

function renderLive() {
    const d = state.live.data;

    if (!d) {
        dom.liveSub.textContent = 'Asking the bridge what is running…';
        dom.liveBody.replaceChildren(el('div', { class: 'live-note' },
            el('p', {}, 'Asking the bridge what is running…')));
        return;
    }

    const bits = [];
    if (d.waiting) bits.push(`${d.waiting} waiting for you`);
    bits.push(`${d.running} running`);
    if (d.hidden) bits.push(`${d.hidden} more not shown`);
    dom.liveSub.textContent = bits.join(' · ');

    // Two separate questions about the layout, which were one flag until the
    // groups arrived.
    //
    // Grouped: both docked arrangements are. Docked, the board is the thing you
    // pick from while reading something else, and "running" against "I merely
    // touched this today" is the distinction that makes it pickable. With the
    // window to itself it is already a sorted grid of everything and reads as
    // one list, so it stays one.
    //
    // Compact: only the bottom strip is short of room. As a column, or full
    // screen, there is height for a fuller card.
    const grouped = dom.live.dataset.mode === 'dock';
    const compact = grouped && state.live.dock === 'bottom';

    // Nothing to draw. `recent` counts here only where it is drawn, or the
    // full-screen board would answer "is anything running" with an empty box on
    // a morning when the answer is no.
    if (!d.sessions.length && !(grouped && (d.recent || []).length)) {
        dom.liveBody.replaceChildren(el('div', { class: 'live-note' },
            el('p', {}, 'Nothing is running. Every session on this machine is idle, '
                + 'here and in every terminal.')));
        return;
    }

    // The board is rebuilt whenever anything moves, which is constantly while
    // agents are working — an activity line changing is enough. Somebody typing
    // into a card would have the box pulled out from under them mid-word, so
    // where the cursor was is noted and put back. The text itself survives in
    // `drafts`; this is about the focus and the caret.
    const active = document.activeElement;
    const typing = active && active.dataset && active.dataset.sendFor
        ? { id: active.dataset.sendFor, at: active.selectionStart, to: active.selectionEnd }
        : null;
    const scroll = { x: dom.liveBody.scrollLeft, y: dom.liveBody.scrollTop };

    dom.liveBody.replaceChildren(...(grouped
        ? liveGroups(d, compact)
        : d.sessions.map(s => liveCard(s, false))));
    dom.liveBody.scrollLeft = scroll.x;
    dom.liveBody.scrollTop = scroll.y;

    if (typing) {
        const box = dom.liveBody.querySelector(
            `[data-send-for="${CSS.escape(typing.id)}"]`);
        if (box) {
            box.focus({ preventScroll: true });
            box.setSelectionRange(typing.at, typing.to);
        }
    }
    for (const box of dom.liveBody.querySelectorAll('.lsend-box')) grow(box, 30, 84);
}

/**
 * The docked board, in three parts — along the strip, or down the column.
 *
 * Pinned and running are already known — they are the reasons the bridge sorts
 * the board by — so those two groups are that one list cut in two rather than a
 * second opinion about it, and the needs-you-first order inside each survives
 * the cut. Recent is the array the bridge sends beside it.
 *
 * Empty groups are dropped rather than shown empty: three headings over one card
 * is mostly headings, and neither arrangement has room to spare.
 */
function liveGroups(d, compact) {
    const live = d.sessions.filter(s => s.reason !== 'pinned');
    const pinned = d.sessions.filter(s => s.reason === 'pinned');
    const recent = d.recent || [];

    return [
        // Only `recent` carries its own overflow. `hidden` is the board's cap
        // biting, and it bites the bottom of the rank order — pinned before
        // running — so the payload cannot say which of these two groups lost a
        // card, and the subtitle above already reports the number for the board
        // as a whole.
        ['live', 'Live', live, 0],
        ['recent', 'Recent activity', recent, d.recentHidden],
        ['pinned', 'Pinned', pinned, 0],
    ].filter(([, , list]) => list.length)
        .map(([key, label, list, hidden]) => liveGroup(key, label, list, hidden, compact));
}

/** One headed segment of the board. */
function liveGroup(key, label, list, hidden, compact) {
    return el('section', { class: 'live-group', 'data-group': key },
        el('h2', { class: 'lgroup-head' },
            el('span', { class: 'lgroup-label' }, label),
            el('span', { class: 'lgroup-count' }, String(list.length)),
            // Same promise the subtitle makes about the board as a whole: what
            // fell off the end is reported, because a list that silently stops
            // reads as the end of the list.
            hidden ? el('span', { class: 'lgroup-more' }, `+${hidden} more`) : null),
        el('div', { class: 'lgroup-body' }, list.map(s => liveCard(s, compact))));
}

/**
 * One session, as a card.
 *
 * Deliberately built from the same pieces as the rail row — activityBits,
 * queuedBadge, ago, clip — rather than a second vocabulary for the same facts.
 * The risk with a view like this is two renderers of one state drifting apart,
 * and sharing the small parts is what keeps them honest.
 */
function liveCard(s, compact = false) {
    const r = s.runner;
    const busy = r && (r.state === 'busy' || r.state === 'starting');
    const away = s.live && s.live.running && !r;
    // In the bottom strip every row a card gives up is a row of transcript, so
    // it drops what is duplicated elsewhere: one line of history, and the Open
    // button — the title above it already opens the session, and the rail is
    // right there. Beside the conversation there is height to spare and the
    // fuller card is free.
    const lines = compact ? 2 : HEADLINES_SHOWN;

    return el('article', {
        class: 'lcard', 'data-reason': s.reason, 'data-id': s.sessionId,
        onclick: (e) => { if (cardClickOpens(e)) openSession(s.sessionId); },
    },
        el('header', { class: 'lcard-head' },
            el('span', { class: 'lcard-dot' }),
            // Still a button, though the whole card now opens the session: it is
            // what a keyboard reaches and what a screen reader announces, and
            // the card around it is a mouse affordance layered over the top.
            el('button', {
                class: 'lcard-title', type: 'button',
                title: 'Open this conversation',
                onclick: () => openSession(s.sessionId),
            }, clip(s.title, 60)),
            el('span', { class: 'lcard-where' },
                s.worktree ? s.worktree.name : s.projectName),
        ),

        el('div', { class: 'lcard-line' }, liveStatusWords(s, busy, away)),

        s.tasks ? taskBar(s.tasks) : null,

        el('div', { class: 'lcard-facts' },
            s.tasks ? el('span', {}, `${s.tasks.done} of ${s.tasks.total} tasks`) : null,
            el('span', {}, `${s.toolCalls} tool${s.toolCalls === 1 ? '' : 's'}`),
            (r && r.queued) ? queuedBadge(r.queued) : null,
            // A port something is answering on right now. The overview refreshes
            // these on its own slow cycle, so a chip is at most ~15s old.
            ...(s.devservers || []).map(devChip),
            el('span', { class: 'lcard-ago' }, ago(s.lastTs)),
        ),

        s.ask ? liveAsk(s) : null,

        s.headlines.length ? el('ol', { class: 'lcard-log' },
            s.headlines.slice(-lines).map(h => el('li', { title: h.text }, clip(h.text, 74)))) : null,

        cardComposer(s, busy, away),

        (!compact || busy) ? el('div', { class: 'lcard-acts' },
            compact ? null : el('button', {
                class: 'lbtn', type: 'button',
                onclick: () => openSession(s.sessionId),
            }, 'Open'),
            busy ? el('button', {
                class: 'lbtn', type: 'button',
                title: 'Interrupt the turn this session is running',
                onclick: (e) => stopFromCard(s.sessionId, e.currentTarget),
            }, 'Stop') : null,
        ) : null,
    );
}

// How much history a card carries when it has the screen to itself.
const HEADLINES_SHOWN = 3;

/**
 * Whether a click on a card was meant as "open this session".
 *
 * The card is one big target, which is what you want when the alternative is
 * hitting a line of text — but everything on it that does something of its own
 * has to keep doing it. Allowing, denying, stopping a turn or opening a dev
 * server are not "take me there", and neither is putting the cursor in the
 * message box or dragging across a line to copy it.
 */
function cardClickOpens(e) {
    if (e.target.closest('button, a, input, textarea, select, label, .lsend, .lask')) return false;
    // Selecting text on a card ends in a click; that should leave the selection
    // alone rather than navigating away from it.
    const picked = window.getSelection();
    return !(picked && picked.type === 'Range' && String(picked).trim());
}

/**
 * A line to write back to the session, on the card.
 *
 * The common thing to want from this view is a sentence — "yes, carry on",
 * "try the other one" — to a session you are not reading. Making that a trip
 * through the conversation and back is most of the reason the view would go
 * unused.
 *
 * A session running under something that is not this bridge does not get one.
 * That is the same rule as the composer lock, and for the same reason: sending
 * would put a second process on one transcript. The card says so and hands over
 * to the conversation, where the branch is offered properly — a fork is too big
 * a thing to do from a tile by accident.
 */
function cardComposer(s, busy, away) {
    if (away) {
        return el('div', {
            class: 'lsend locked',
            title: 'Sending from here would put a second process on this '
                + 'session\'s transcript. Open it to branch off a copy.',
        }, el('span', {}, 'Running elsewhere — open to branch.'));
    }

    const box = el('textarea', {
        class: 'lsend-box', rows: 1, placeholder: busy ? 'Queue a message…' : 'Send a message…',
        'aria-label': `Message ${s.title}`,
        // Named so that a re-render can put the focus and the caret back where
        // the typing was; the board redraws whenever anything moves.
        'data-send-for': s.sessionId,
    });
    box.value = state.live.drafts.get(s.sessionId) || '';
    box.addEventListener('input', () => {
        state.live.drafts.set(s.sessionId, box.value);
        grow(box, 30, 84);
    });
    box.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        if (e.shiftKey || e.altKey) return;
        e.preventDefault();
        sendFromCard(s, box);
    });

    return el('div', { class: 'lsend' },
        box,
        el('button', {
            class: 'lbtn ok lsend-go', type: 'button',
            title: busy ? 'Add to this session\'s queue' : 'Send to this session',
            onclick: () => sendFromCard(s, box),
        }, busy ? 'Queue' : 'Send'),
    );
}

async function sendFromCard(s, box) {
    const text = box.value.trim();
    if (!text) return;

    const go = box.parentElement.querySelector('.lsend-go');
    box.disabled = true;
    go.disabled = true;
    try {
        const r = await post(`/api/sessions/${s.sessionId}/send`, {
            text,
            // Carried, not defaulted. The send route turns a missing mode into
            // `auto`, and pool.ensure replaces the process when the mode it is
            // given differs from the one it is in — so saying nothing here would
            // restart a session that was running in acceptEdits or plan.
            permissionMode: s.permissionMode || undefined,
        });
        state.live.drafts.delete(s.sessionId);
        box.value = '';
        grow(box, 30, 84);
        // Same rule as the composer: only a message that reached the process
        // needs holding, since a queued one is on the bridge and comes back by
        // itself if the process dies.
        if (!r.queued) state.unsent.set(s.sessionId, text);
        toast(r.queued
            ? `Queued for “${clip(s.title, 32)}”.`
            : `Sent to “${clip(s.title, 32)}”.`, 'ok', 3000);
    } catch (err) {
        toast(`Could not send: ${err.message}`, 'error');
    } finally {
        box.disabled = false;
        go.disabled = false;
    }
}

/** The one line under the title: what it is doing, and for how long. */
function liveStatusWords(s, busy, away) {
    const r = s.runner;
    if (s.ask) {
        return [el('span', { class: 'lstate ask' }, ASK_WORD[s.ask.kind] || 'Waiting for you')];
    }
    if (r && r.state === 'error') {
        return [el('span', { class: 'lstate err' }, clip(r.error || 'The turn failed.', 68))];
    }
    if (busy) {
        return [
            el('span', { class: r.retry ? 'lstate warn' : 'lstate' },
                clip(r.activity || 'Working…', 52)),
            r.busySince ? el('span', { class: 'lcard-clock', 'data-since': r.busySince },
                dur(Date.now() - r.busySince)) : null,
        ];
    }
    if (away) {
        // No activity line to give: the runner that would report one belongs to
        // whoever is driving the session, not to us. The headlines say the rest.
        return [el('span', { class: 'lstate quiet' }, lower(awayWords(s.live)))];
    }
    if (s.tasks && s.tasks.current) {
        return [el('span', { class: 'lstate quiet' }, clip(s.tasks.current, 60))];
    }
    return [el('span', { class: 'lstate quiet' }, 'Idle')];
}

const ASK_WORD = {
    tool: 'Waiting for permission',
    plan: 'Waiting on a plan',
    question: 'Waiting on a question',
};

/**
 * A port this session has something answering on, as a chip that switches
 * DevBrowser to it.
 *
 * Its own request rather than the channel strip's `openInDevBrowser`, which
 * writes progress into a separate "Open" button it is given — handing it the
 * chip's own label made a successful click rename `:5006` to `Open`.
 */
function devChip(d) {
    return el('button', {
        class: 'lchip', type: 'button',
        title: `Show :${d.port}${d.title ? ` (${d.title})` : ''} in DevBrowser`,
        onclick: async (e) => {
            const chip = e.currentTarget;
            chip.classList.add('busy');
            chip.disabled = true;
            try {
                const r = await post('/api/devbrowser/open', {
                    port: d.port,
                    // Name the tab if the transcript knew what it was and
                    // DevBrowser did not.
                    title: d.owned ? undefined : d.title || undefined,
                });
                if (r.launched) toast(`Started DevBrowser and switched to :${d.port}.`, 'ok');
            } catch (err) {
                toast(`Could not switch to :${d.port}. ${err.message}`, 'error');
            } finally {
                chip.classList.remove('busy');
                chip.disabled = false;
            }
        },
    }, `:${d.port}`, d.title ? el('i', {}, clip(d.title, 16)) : null);
}

function taskBar(t) {
    const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
    return el('div', {
        class: 'tbar', title: `${t.done} of ${t.total} tasks done`,
        role: 'progressbar', 'aria-valuenow': t.done, 'aria-valuemin': 0, 'aria-valuemax': t.total,
    }, el('span', { class: 'tbar-fill', style: `width:${pct}%` }));
}

/**
 * The ask, on the card.
 *
 * A tool ask is answered here — that is the single best reason for this view to
 * exist, and it is the common case by a wide margin. A plan or a set of
 * questions is not: the answer is a choice made against text that does not fit
 * in a tile, and offering two buttons against a plan nobody has read is worse
 * than a button that goes and shows it. Same judgement the notification actions
 * already make.
 */
function liveAsk(s) {
    const ask = s.ask;
    const kind = ask.kind || 'tool';
    const what = kind === 'tool'
        ? (toolSummary({ name: ask.tool, input: ask.input }) || ask.displayName)
        : askBody(ask, kind);

    return el('div', { class: `lask lask-${kind}` },
        el('div', { class: 'lask-what' },
            el('b', {}, kind === 'tool' ? ask.displayName : ASK_HEAD[kind].name),
            what ? el('span', {}, clip(what, 90)) : null),
        el('div', { class: 'lask-acts' },
            kind === 'tool' ? [
                el('button', {
                    class: 'lbtn ok', type: 'button',
                    onclick: (e) => answerFromCard(s, { decision: 'allow' }, e.currentTarget),
                }, 'Allow'),
                el('button', {
                    class: 'lbtn', type: 'button',
                    title: `Allow ${ask.displayName} for the rest of this session`,
                    onclick: (e) => answerFromCard(s, { decision: 'allow-always' }, e.currentTarget),
                }, 'Always'),
                el('button', {
                    class: 'lbtn no', type: 'button',
                    onclick: (e) => answerFromCard(s, { decision: 'deny' }, e.currentTarget),
                }, 'Deny'),
            ] : el('button', {
                class: 'lbtn ok', type: 'button',
                onclick: () => openSession(s.sessionId),
            }, 'Answer →'),
        ),
    );
}

async function answerFromCard(s, payload, btn) {
    const card = btn.closest('.lcard');
    for (const b of card.querySelectorAll('.lask button')) b.disabled = true;
    try {
        await answerAskFor(s.sessionId, s.ask.requestId, payload);
    } catch (err) {
        toast(`Could not answer: ${err.message}`, 'error');
        for (const b of card.querySelectorAll('.lask button')) b.disabled = false;
    }
}

/**
 * Stop a turn from the card. Always the soft stop — the escalation to a kill is
 * armed by pressing Stop twice in the conversation, and a single button on a
 * card several sessions away from the one you are reading is not the place to
 * offer it.
 */
async function stopFromCard(sessionId, btn) {
    btn.disabled = true;
    btn.textContent = 'Stopping…';
    try {
        const r = await post(`/api/sessions/${sessionId}/stop`, {});
        // Whatever never reached the process comes back, exactly as it does in
        // the conversation view — otherwise a queue would vanish silently. One
        // draft holds all of them, joined the way the composer restores them;
        // saving each in turn would leave only the last.
        const dropped = r.dropped || [];
        if (dropped.length) {
            const held = loadDraft(sessionId);
            saveDraft(sessionId, [held, dropped.join('\n\n')].filter(Boolean).join('\n\n'));
            toast(`Stopped. ${dropped.length} unsent message${dropped.length === 1
                ? ' is' : 's are'} waiting in that session's composer.`, 'info');
        }
    } catch (err) {
        toast(`Could not stop: ${err.message}`, 'error');
        btn.disabled = false;
        btn.textContent = 'Stop';
    }
}

// ── dashboard ────────────────────────────────────────────────────────────
// The rail answers "what have I been talking to". This answers "what have I
// left behind" — changes nobody committed, pull requests nobody merged — which
// is the thing a screen full of finished conversations hides.

// How old an answer may be before opening the board goes and asks again. The
// bridge caches underneath this, so a re-ask is usually free anyway.
const DASH_STALE_MS = 45_000;

/**
 * Which of the things `main` can hold is on screen.
 *
 * Three full-height panels now cover the conversation — Live, Work in flight and
 * History — and they used to each set `conv.hidden` themselves, which meant
 * whichever closed last decided what the other was doing. One function owns it
 * instead: the panels say what they want, this works out the consequences.
 *
 * The conversation is covered, never closed. Its tail keeps running, its scroll
 * position is untouched, and coming back out lands exactly where it was.
 */
function paintPanels() {
    // The board docks under the conversation rather than replacing it: the
    // reason to watch five agents is usually that you are working in one of
    // them, and having to choose between the two made you keep switching. It
    // takes only the height its cards need — one row, scrolled sideways when
    // there are more than fit — and the conversation keeps everything else.
    //
    // With nothing open, or in focus mode, there is no conversation to share
    // with and the board has the floor.
    const docked = state.live.open && Boolean(state.current) && !state.focus;
    const full = state.live.open && !docked;

    // Two whole-screen panels, and showDash/showNotes keep them exclusive, so
    // "one of them is up" is the only thing anything below has to ask.
    const covered = state.dash.open || state.notes.open;

    dom.dash.hidden = !state.dash.open;
    dom.notes.hidden = !state.notes.open;
    dom.live.hidden = !state.live.open || covered;
    dom.live.dataset.mode = docked ? 'dock' : 'full';
    // The orientation lives on both: `main` has to change its flex direction,
    // and the board has to know whether it is a strip or a column.
    dom.live.dataset.dock = state.live.dock;
    dom.main.dataset.dock = docked ? state.live.dock : 'bottom';
    // The conversation stays up under a docked board; a whole-screen panel
    // still covers it.
    dom.conv.hidden = covered || full || !state.current;
    dom.placeholder.hidden = covered || state.live.open || Boolean(state.current);

    for (const [btn, on] of [[dom.btnDash, state.dash.open], [dom.btnLive, state.live.open],
        [dom.btnNotes, state.notes.open]]) {
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
    }
    // The conversation's box just changed height, and xterm only knows what it
    // is told.
    if (state.current && !dom.conv.hidden) termPane.refit();
}

function showDash(on) {
    state.dash.open = on;
    if (on) state.notes.open = false;   // two whole screens; one at a time
    // The live board is not closed by this, only covered. It is a strip you
    // leave up; the work-in-flight board is a whole screen you go and read and
    // then come back from, and coming back should find things as you left them.
    paintPanels();
    syncBoardWatch();

    if (on) {
        if (Date.now() - state.dash.at > DASH_STALE_MS) loadDash();
        else renderDash();
    } else if (state.live.open) {
        // The board was left switched on underneath and has been ignoring its
        // pushes; catch it up before it comes back into view.
        renderLive();
        if (state.current) termPane.refit();
    } else if (state.current) {
        // The terminal was display:none while the board was up, and xterm sizes
        // itself to a box it could not measure then.
        termPane.refit();
    }
    rememberView();
}

async function loadDash({ refresh = false } = {}) {
    if (state.dash.loading) return;
    state.dash.loading = true;
    state.dash.error = null;
    renderDash();
    try {
        const data = await get('/api/dashboard' + (refresh ? '?refresh=1' : ''));
        state.dash.data = data;
        state.dash.at = Date.now();
    } catch (err) {
        state.dash.error = err.message;
    } finally {
        state.dash.loading = false;
        renderDash();
        paintDashBadge();
    }
}

/**
 * How much is outstanding, on the button that opens the board. Counted in
 * places rather than in files or PRs: "eleven" meaning eleven modified files in
 * one worktree and "eleven" meaning eleven worktrees are different news.
 */
function paintDashBadge() {
    const d = state.dash.data;
    const rows = d ? d.projects.reduce((n, p) => n + p.workspaces.length, 0) : 0;
    dom.dashBadge.hidden = !rows;
    dom.dashBadge.textContent = String(rows);
    dom.btnDash.title = rows
        ? `${rows} ${rows === 1 ? 'place has' : 'places have'} uncommitted changes or an open pull request`
        : 'Uncommitted changes and open pull requests, by project';
}

function renderDash() {
    const d = state.dash.data;
    dom.dashRefresh.disabled = state.dash.loading;
    dom.dashRefresh.textContent = state.dash.loading ? 'Checking…' : 'Refresh';

    if (d) {
        const when = ago(d.checkedAt);
        dom.dashSub.textContent = [
            `${d.dirty} ${d.dirty === 1 ? 'directory' : 'directories'} with uncommitted changes`,
            `${d.open} pull ${d.open === 1 ? 'request' : 'requests'} still open`,
            when === 'now' ? 'checked just now' : `checked ${when} ago`,
        ].join(' · ');
    } else {
        dom.dashSub.textContent = 'Uncommitted changes, and pull requests that are '
            + 'open but not merged.';
    }

    const body = dom.dashBody;
    if (state.dash.error) {
        body.replaceChildren(el('div', { class: 'dash-note error' },
            el('p', {}, `Could not read the working trees: ${state.dash.error}`),
            el('button', { class: 'more-btn', type: 'button', onclick: () => loadDash() },
                'Try again')));
        return;
    }
    if (!d) {
        body.replaceChildren(el('div', { class: 'dash-note' },
            el('p', {}, 'Reading working trees and asking GitHub…')));
        return;
    }

    const nodes = [];
    // gh failing is worth saying outright rather than quietly listing no PRs:
    // an empty board would otherwise read as "nothing open".
    if (!d.gh.ok) {
        nodes.push(el('div', { class: 'dash-note warn' },
            el('p', {}, `Pull requests could not be listed — ${d.gh.error}. `
                + 'Uncommitted changes below are unaffected.')));
    }
    if (!d.projects.length) {
        nodes.push(el('div', { class: 'dash-note' },
            el('p', {}, 'Nothing uncommitted, and no pull request left open. '
                + 'Every worktree on this machine is clean.')));
    }
    for (const p of d.projects) nodes.push(dashProject(p));
    body.replaceChildren(...nodes);
}

function dashProject(p) {
    const counts = [];
    if (p.dirty) counts.push(`${p.dirty} dirty`);
    if (p.open) counts.push(`${p.open} open PR${p.open === 1 ? '' : 's'}`);

    return el('section', { class: 'dproj' },
        el('header', { class: 'dproj-head' },
            el('span', { class: 'dproj-name' }, p.name),
            p.repo ? el('span', { class: 'dproj-repo' }, p.repo) : null,
            el('span', { class: 'dproj-counts' }, counts.join(' · ')),
        ),
        el('div', { class: 'dproj-body' }, p.workspaces.map(w => dashRow(p, w))),
    );
}

function dashRow(project, w) {
    const g = w.git || {};
    const filesId = `${project.cwd}::${w.dir || (w.prs[0] && w.prs[0].url) || w.name}`;
    const showFiles = state.dash.files.has(filesId);

    const signals = [];
    if (g.dirty) {
        signals.push(el('button', {
            class: 'sig dirty' + (showFiles ? ' on' : ''),
            type: 'button',
            'aria-expanded': String(showFiles),
            title: dirtyTitle(g),
            onclick: () => {
                state.dash.files[showFiles ? 'delete' : 'add'](filesId);
                renderDash();
            },
        }, `${g.files} uncommitted`));
    }
    // Only where there is an upstream to be ahead of; a worktree branch that was
    // never pushed has nothing to compare against and says nothing here.
    if (g.ahead) signals.push(el('span', { class: 'sig quiet' }, `${g.ahead} unpushed`));
    if (g.conflicts) signals.push(el('span', { class: 'sig bad' }, `${g.conflicts} conflicted`));

    for (const pr of w.prs) {
        signals.push(el('a', {
            class: 'sig pr' + (pr.draft ? ' draft' : ''),
            href: pr.url, target: '_blank', rel: 'noreferrer',
            title: `${pr.title}\n${pr.url}\nopened by ${pr.author || 'someone'}, `
                + `updated ${ago(pr.updatedAt)} ago`,
        },
            el('span', { class: 'pr-num' }, `#${pr.number}`),
            el('span', { class: 'pr-title' }, clip(pr.title, 46)),
            pr.draft ? el('span', { class: 'pr-tag' }, 'draft') : null,
            pr.reviewDecision === 'APPROVED' ? el('span', { class: 'pr-tag ok' }, 'approved') : null,
            pr.reviewDecision === 'CHANGES_REQUESTED'
                ? el('span', { class: 'pr-tag bad' }, 'changes requested') : null,
        ));
    }

    return el('article', { class: 'wsrow', 'data-kind': w.kind },
        el('div', { class: 'wsrow-head' },
            el('span', { class: 'ws-name' }, w.name),
            w.kind === 'gone'
                ? el('span', { class: 'ws-note' }, 'no working directory left')
                : el('span', { class: 'ws-branch', title: w.dir || '' },
                    g.branch || (g.detached ? 'detached HEAD' : '—')),
            el('span', { class: 'wsrow-signals' }, signals),
        ),
        showFiles && g.sample ? el('ul', { class: 'ws-files' },
            g.sample.map(f => el('li', {},
                el('span', { class: 'fstat', 'data-s': f.status }, statusWord(f.status)),
                el('span', { class: 'fpath' }, f.path))),
            g.files > g.sample.length
                ? el('li', { class: 'more' }, `and ${g.files - g.sample.length} more`)
                : null,
        ) : null,
        el('div', { class: 'ws-sessions' },
            w.sessions.map(s => dashSession(s)),
            w.moreSessions
                ? el('span', { class: 'ws-more' }, `+${w.moreSessions} older`)
                : null,
        ),
    );
}

function dashSession(s) {
    const running = s.runner && (s.runner.state === 'busy' || s.runner.state === 'starting');
    return el('button', {
        class: 'schip',
        type: 'button',
        'data-state': running ? 'running' : (s.active ? 'active' : 'idle'),
        title: `${s.title}\n${s.userMessages} turns · last message ${ago(s.lastTs)} ago`,
        onclick: () => { showDash(false); openSession(s.sessionId); },
    },
        el('span', { class: 'schip-dot' }),
        el('span', { class: 'schip-title' }, clip(s.title, 40)),
        el('span', { class: 'schip-ago' }, ago(s.lastTs)),
    );
}

function dirtyTitle(g) {
    const bits = [];
    if (g.staged) bits.push(`${g.staged} staged`);
    if (g.unstaged) bits.push(`${g.unstaged} modified`);
    if (g.untracked) bits.push(`${g.untracked} untracked`);
    if (g.conflicts) bits.push(`${g.conflicts} conflicted`);
    return bits.join(' · ') + ' — click to list them';
}

function statusWord(xy) {
    if (xy === '??') return 'new';
    if (xy === 'UU') return 'conflict';
    if (xy[0] === 'D' || xy[1] === 'D') return 'deleted';
    if (xy[0] === 'A') return 'added';
    if (xy[0] === 'R' || xy[1] === 'R') return 'renamed';
    return xy[0] !== '.' ? 'staged' : 'modified';
}

// ── notification history ─────────────────────────────────────────────────
//
// The section below is what reaches you. This is what you read afterwards to
// find out what it was.
//
// A toast lives as long as Windows feels like letting it, and on this machine
// that is not long or reliable — so "something pinged me and I have no idea
// where from" was the normal experience rather than the rare one. The rows come
// from the bridge, not from anything this page kept, because the page only
// exists while a window is open and the hours you were away are exactly the ones
// worth having a record of. See bridge/notifications.js.
//
// Two things follow from recording there. The bridge cannot know you were
// looking straight at a session when its turn landed, so `loud` means "cleared
// the bar for interrupting somebody", not "a toast definitely appeared" — which
// is why the filter is called Notable and not something that claims more. And a
// row survives its session being renamed or deleted, because the title was
// copied onto it when it was filed.

const NOTES_STALE_MS = 30_000;

const NOTE_LABEL = {
    permission: 'Permission',
    plan: 'Plan to review',
    question: 'Question',
    finished: 'Finished',
    failed: 'Failed',
    'agent-done': 'Subagent done',
    'peer-message': 'From another session',
};

// The runner's vocabulary for how an ask ended, said the way a person would.
const NOTE_OUTCOME = {
    allow: 'allowed',
    'allow-always': 'allowed for the session',
    deny: 'denied',
    answered: 'answered',
    'plan-approved': 'approved',
    'plan-approved-note': 'approved with a note',
    'plan-rejected': 'kept planning',
    dismissed: 'dismissed',
    'auto-denied': 'denied — no window was open',
    superseded: 'replaced by a later ask',
    cancelled: 'withdrawn',
    abandoned: 'abandoned — the bridge stopped',
    stopped: 'the turn was stopped',
};

// Set just before openSession by a history row that knows which tool call it is
// about, and consumed once the transcript has been drawn. Module-level rather
// than an argument because openSession is called from a dozen places that have
// no business knowing about this.
let pendingJump = null;

function showNotes(on) {
    state.notes.open = on;
    if (on) state.dash.open = false;
    paintPanels();
    syncBoardWatch();

    if (on) {
        markNotesSeen();
        if (Date.now() - state.notes.at > NOTES_STALE_MS) loadNotes();
        else renderNotes();
    } else if (state.live.open) {
        // The board was left switched on underneath and has been ignoring its
        // pushes; catch it up before it comes back into view.
        renderLive();
        if (state.current) termPane.refit();
    } else if (state.current) {
        termPane.refit();
    }
}

async function loadNotes() {
    if (state.notes.loading) return;
    state.notes.loading = true;
    state.notes.error = null;
    renderNotes();
    try {
        const data = await get(`/api/notifications?scope=${state.notes.scope}&limit=300`);
        state.notes.rows = data.notifications;
        state.notes.at = Date.now();
    } catch (err) {
        state.notes.error = err.message;
    } finally {
        state.notes.loading = false;
        renderNotes();
        paintNotesBadge();
    }
}

function setNotesScope(scope) {
    if (state.notes.scope === scope) return;
    state.notes.scope = scope;
    dom.notesNotable.setAttribute('aria-pressed', String(scope === 'notable'));
    dom.notesAll.setAttribute('aria-pressed', String(scope === 'all'));
    state.notes.at = 0;   // the other scope is a different set of rows
    loadNotes();
}

/**
 * How many things have wanted you since you last looked.
 *
 * Counted over the loud rows only, whichever scope is showing: a badge is an
 * interruption in its own right, and a six-second turn finishing is not one.
 */
function paintNotesBadge() {
    const n = state.notes.rows.filter(r => r.loud && r.at > state.notes.seen).length;
    dom.notesBadge.hidden = !n;
    dom.notesBadge.textContent = String(n);
    dom.btnNotes.title = n
        ? `${n} ${n === 1 ? 'notification' : 'notifications'} since you last looked`
        : 'Everything that has reached out to you (Ctrl+4)';
}

function markNotesSeen() {
    state.notes.seen = Date.now();
    localStorage.setItem('notesSeenAt', String(state.notes.seen));
    paintNotesBadge();
}

function renderNotes() {
    const rows = state.notes.rows;
    dom.notesClear.disabled = state.notes.loading || !rows.length;

    const body = dom.notesBody;
    if (state.notes.error) {
        body.replaceChildren(el('div', { class: 'dash-note error' },
            el('p', {}, `Could not read the notification log: ${state.notes.error}`),
            el('button', { class: 'more-btn', type: 'button', onclick: () => loadNotes() },
                'Try again')));
        return;
    }
    if (state.notes.loading && !rows.length) {
        body.replaceChildren(el('div', { class: 'dash-note' }, el('p', {}, 'Reading the log…')));
        return;
    }
    if (!rows.length) {
        body.replaceChildren(el('div', { class: 'dash-note' },
            el('p', {}, state.notes.scope === 'notable'
                ? 'Nothing has wanted you. Everything switches to the quiet rows too — '
                    + 'short turns, subagents finishing.'
                : 'Nothing yet. Anything that wants you from now on is written down here, '
                    + 'whether or not a window was open to hear it.')));
        return;
    }

    dom.notesSub.textContent = `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`
        + (state.notes.scope === 'notable' ? ' worth interrupting you for.' : ', including the quiet ones.');
    body.replaceChildren(...rows.map(noteRow));
}

function noteRow(n) {
    const meta = [n.project, n.outcome ? (NOTE_OUTCOME[n.outcome] || n.outcome) : null]
        .filter(Boolean);
    return el('div', {
        class: 'note-row',
        'data-type': n.type,
        'data-loud': String(n.loud),
        'data-id': n.id,
    },
        el('button', {
            class: 'note-main', type: 'button',
            title: `Open ${n.title}`,
            onclick: () => openFromNote(n),
        },
            el('span', { class: 'note-head' },
                el('span', { class: 'note-kind' }, NOTE_LABEL[n.type] || n.type),
                el('span', { class: 'note-title' }, n.title),
                el('span', { class: 'note-when', title: new Date(n.at).toLocaleString() },
                    ago(n.at)),
            ),
            el('span', { class: 'note-summary' }, n.summary || ''),
            meta.length
                ? el('span', { class: 'note-meta' },
                    n.outcome
                        ? el('span', { class: 'note-outcome', 'data-outcome': n.outcome },
                            NOTE_OUTCOME[n.outcome] || n.outcome)
                        : null,
                    n.project ? el('span', { class: 'note-project' }, n.project) : null)
                : null,
        ));
}

/**
 * Back to where it came from — which is the whole reason for the list.
 *
 * An ask carries the id of the tool call it was about, and that is a real node
 * in the transcript, so the row can put you on the exact line rather than at the
 * bottom of a long conversation. Where there is no anchor — a finished turn, a
 * subagent — opening the session at the end is the right answer anyway.
 */
function openFromNote(n) {
    pendingJump = n.anchorId || null;
    showNotes(false);
    openSession(n.sessionId);
}

function takePendingJump() {
    const id = pendingJump;
    pendingJump = null;
    if (!id) return;
    const entry = state.tools.get(id);
    // Gone from the transcript, or never in it: the session is open and scrolled
    // to the end, which is the honest fallback rather than a guess.
    if (entry) jumpToTurn(entry);
}

// ── notifications ────────────────────────────────────────────────────────
//
// A turn can run for minutes, and the point of leaving one going is that you go
// and do something else meanwhile. The rail already says what happened — but
// only once you look at it. This is the part that reaches you when you are not
// looking.
//
// It lives in the page rather than in the Electron shell, which has two
// consequences worth knowing. The good one: the same behaviour comes with the
// browser UI, and a sound has nowhere else to come from anyway. The bad one: a
// window that is closed hears nothing, because the only subscriber to the
// bridge's events went with it. Fixing that means the shell holding an
// EventSource of its own — see docs/plans/02-notifications-and-shell.md.

const NOTIFY = {
    // Under this and you were almost certainly still sitting in front of it.
    minTurnMs: 30_000,
    // One per session per this, so a draining queue is not a stack of toasts.
    perSessionMs: 10_000,
};

const notify = {
    desktop: localStorage.getItem('notifyDesktop') !== '0',
    sound: localStorage.getItem('notifySound') !== '0',
    sw: null,           // the worker registration, once it is ready — see sw.js
    fired: new Map(),   // sessionId -> when something last fired for it
    busy: new Map(),    // sessionId -> when its running turn started
    audio: null,
};

/**
 * How long the turn kept somebody waiting, measured here rather than taken
 * from the result.
 *
 * The result's own duration is usually the same number — measured against a
 * one-minute turn the two agreed to within 10ms. But it is assembled in
 * runner.js as `duration_ms || duration_api_ms`, and that second field is API
 * time only, so a CLI that ever omits the first quietly starts reporting a
 * fraction of the wall clock. Deciding "long enough to have walked away from"
 * on a number that can change meaning is not worth the coupling.
 *
 * The bridge stamps `busySince` on every status it broadcasts, so this app's
 * own measure is already on the wire. Keep the last one seen per session and
 * subtract when the turn lands; the reported duration is the fallback, for a
 * window that opened after the turn had already started.
 */
function noteRunner(s) {
    if (s.busySince) notify.busy.set(s.sessionId, s.busySince);
}

function waitedMs(r) {
    const started = notify.busy.get(r.sessionId);
    notify.busy.delete(r.sessionId);
    return started ? Date.now() - started : (r.durationMs || 0);
}

const notifyPermission = () =>
    (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/**
 * Whether a finished turn is worth interrupting somebody for.
 *
 * Being strict here is the whole game: notifications that fire too often get
 * switched off, and then the one that mattered is lost with them.
 *
 *   - A turn that ended badly always counts. Every other kind of ending you
 *     find out about by waiting; this one leaves you waiting forever.
 *   - Nothing is said about the session you are looking at in a focused
 *     window. You watched it land.
 *   - Half a minute is the line between a turn you sat through and one you
 *     walked away from.
 *   - At most one per session per ten seconds, whatever the reason.
 *
 * Returns false for a normal finish, true for a bad one, null for silence.
 */
function turnWorthSaying(r, waited) {
    const bad = Boolean(r.isError);
    if (!bad) {
        const watching = document.hasFocus()
            && state.current && state.current.sessionId === r.sessionId;
        if (watching || waited < NOTIFY.minTurnMs) return null;
    }
    if (!allowedNow(r.sessionId)) return null;
    return bad;
}

function allowedNow(sessionId) {
    const last = notify.fired.get(sessionId) || 0;
    if (Date.now() - last < NOTIFY.perSessionMs) return false;
    notify.fired.set(sessionId, Date.now());
    return true;
}

const sessionTitle = (id) => {
    const row = state.sessions.find(s => s.sessionId === id);
    return (row && row.title) || 'A session';
};

function announceTurn(r) {
    // Read before the decision either way: the stamp has to be cleared whether
    // or not this one gets said out loud, or the next turn inherits it.
    const waited = waitedMs(r);
    const bad = turnWorthSaying(r, waited);
    if (bad === null) return;
    announce(
        `${clip(sessionTitle(r.sessionId), 60)} — ${bad ? 'turn failed' : 'finished'}`,
        bad ? clip(r.detail || 'The turn ended with an error.', 160)
            : `Ran for ${dur(waited)}.`,
        bad ? 'fail' : 'done', r.sessionId,
    );
}

// A send that never became a turn: the session is finished in the sense that
// matters, because nothing more is coming and nobody is going to be told. The
// composer's toast covers the window that did the sending — this covers the
// queued message you walked away from.
function announceSendFailure(f) {
    const watching = document.hasFocus()
        && state.current && state.current.sessionId === f.sessionId;
    if (watching || !allowedNow(f.sessionId)) return;
    announce(
        `${clip(sessionTitle(f.sessionId), 60)} — could not run`,
        clip(f.message || 'The message never reached Claude.', 160),
        'fail', f.sessionId,
    );
}

/**
 * A blocked turn, said out loud.
 *
 * Three things arrive down this channel and only one is a permission — see the
 * approvals section for the vocabulary. What they share is the thing that
 * matters here: the turn does not move until you answer, so unlike a finished
 * turn there is no duration to wait for and nothing to be gained by holding
 * back. If you are not looking at the card, you want to know.
 *
 * A tool and a plan get two buttons, because yes and no are the whole answer
 * for a tool and are approve-or-keep-planning for a plan. A question gets
 * none: its answer is a choice among options that will not fit on a toast, so
 * it can only invite you to come and read it.
 */
function announceAsk(p) {
    const watching = document.hasFocus()
        && state.current && state.current.sessionId === p.sessionId;
    if (watching) return;

    const kind = p.kind || 'tool';
    const head = ASK_TITLE[kind] || `${p.displayName} needs permission`;
    // Deliberately not gated on allowedNow: the toast carries a tag, so a
    // second ask replaces the first rather than stacking, and suppressing it
    // would leave the old one on screen offering to answer a dead request.
    // Only the noise is rationed, below.
    showAsk(`${clip(sessionTitle(p.sessionId), 60)} — ${head}`, askBody(p, kind), p, kind);
    if (allowedNow(p.sessionId)) chime('ask');
}

const ASK_TITLE = {
    plan: 'a plan to approve',
    question: 'a question for you',
};

function askBody(p, kind) {
    if (kind === 'plan') {
        return clip((p.input && p.input.plan) || p.description || 'A plan is ready.', 160);
    }
    if (kind === 'question') {
        const qs = (p.input && p.input.questions) || [];
        return clip(qs.length ? qs[0].question : 'A question is waiting.', 160);
    }
    return clip(toolSummary({ name: p.tool, input: p.input }) || p.description || '', 160);
}

const ASK_ACTIONS = {
    tool: [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }],
    plan: [{ action: 'allow', title: 'Approve' }, { action: 'deny', title: 'Keep planning' }],
    question: [],
};

/**
 * Shown through the service-worker registration rather than `new
 * Notification`, because that is the only kind the platform will put buttons
 * on. With no worker — registration failed, or the browser has none — this
 * falls back to a plain notification, which still says what is waiting and
 * still opens the card when clicked. Only the buttons are lost.
 */
function showAsk(title, body, p, kind) {
    if (!notify.desktop || notifyPermission() !== 'granted') return;
    const opts = {
        body,
        tag: askTag(p.sessionId),
        silent: true,
        requireInteraction: true,   // a blocked turn should not time out on screen
        data: { sessionId: p.sessionId, requestId: p.requestId },
        actions: ASK_ACTIONS[kind] || [],
    };
    if (notify.sw) {
        notify.sw.showNotification(title, opts).catch(() => {});
        return;
    }
    announce(title, body, null, p.sessionId);
}

const askTag = (sessionId) => `claude-ask:${sessionId}`;

/**
 * Take the toast down once the ask is no longer waiting — answered in a
 * window, answered from another toast, or resolved by the turn being stopped.
 * A notification offering to allow something that has already been decided is
 * worse than no notification at all.
 */
function clearAsk(sessionId) {
    if (!notify.sw) return;
    notify.sw.getNotifications({ tag: askTag(sessionId) })
        .then(list => list.forEach(n => n.close()))
        .catch(() => {});
}

function announce(title, body, tone, sessionId) {
    chime(tone);
    if (!notify.desktop || notifyPermission() !== 'granted') return;
    let n;
    try {
        n = new Notification(title, {
            body,
            // A second one for the same session replaces the first rather than
            // piling up behind it.
            tag: sessionId ? `claude-session:${sessionId}` : 'claude-session',
            // chime() is the only thing here allowed to make a noise, so that
            // the sound checkbox means what it says.
            silent: true,
        });
    } catch { return; /* some engines expose Notification but refuse `new` */ }
    n.onclick = () => {
        // Raising the window is the shell's job — a renderer cannot get past
        // the Windows foreground lock on its own — so ask it if it is there.
        // In a browser tab it is not, and window.focus() is what that
        // environment gives us; it works from a notification click, which is
        // a user gesture.
        if (window.claudeShell) window.claudeShell.revealWindow();
        else window.focus();
        if (sessionId) openSession(sessionId);
        n.close();
    };
}

/**
 * Three sounds, because they mean three different things and the whole point
 * of a sound is to be understood without looking.
 *
 *   done  two notes up — finished, nothing wanted from you.
 *   fail  one flat low note — over, and it went wrong.
 *   ask   two notes on the same pitch, like a knock. Something is waiting on
 *         you, and repetition rather than melody is what reads as a request.
 *
 * Synthesised rather than shipped as a file: it is a few oscillators' worth of
 * code against binary assets in a repo that has none, and it keeps the sounds
 * tunable in the same place as everything else.
 *
 * Short and quiet on purpose. This fires in a room where somebody is working.
 * An unrecognised tone is silence, so a caller that has already made its own
 * noise can pass none.
 */
const CHIME = {
    done: [[587.33, 0, 0.16, 0.11], [880, 0.11, 0.34, 0.1]],   // D5 → A5
    fail: [[311.13, 0, 0.44, 0.09]],                            // E♭4, alone
    ask: [[698.46, 0, 0.11, 0.1], [698.46, 0.17, 0.22, 0.1]],   // F5, twice
};

function chime(tone) {
    if (!notify.sound) return;
    const notes = CHIME[tone];
    if (!notes) return;
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.01;
    for (const [hz, at, len, peak] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        const s = t0 + at;
        // Ramped, not switched: a square-edged gain change is a click.
        gain.gain.setValueAtTime(0.0001, s);
        gain.gain.exponentialRampToValueAtTime(peak, s + 0.014);
        gain.gain.exponentialRampToValueAtTime(0.0001, s + len);
        osc.connect(gain).connect(ctx.destination);
        osc.start(s);
        osc.stop(s + len + 0.03);
    }
}

function audioContext() {
    if (notify.audio) return notify.audio;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try { notify.audio = new Ctor(); } catch { return null; }
    return notify.audio;
}

// A context built before the page has been touched starts suspended and stays
// that way, so the first chime after a fresh load would be silent. Build it on
// the first interaction of any kind instead — including, below, the click that
// turns the sound on.
function wakeAudio() {
    const ctx = audioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, () => { if (notify.sound) wakeAudio(); }, { once: true });
}

// ── the worker that carries the buttons ──────────────────────────────────
//
// Registered for one capability — actions on a notification — and holding no
// cache and no fetch handler, so it changes nothing else about how the page
// loads. If it fails to register, asks fall back to a plain notification with
// no buttons; everything else carries on.

async function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
        await navigator.serviceWorker.register('./sw.js');
        notify.sw = await navigator.serviceWorker.ready;
    } catch { /* no buttons, then — showAsk falls back */ }
}

// The worker cannot open a session itself; it can only say which one a click
// was about. Raising the window is the shell's job, and the preload bridge for
// that lives here rather than there.
navigator.serviceWorker?.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type !== 'reveal-session') return;
    if (window.claudeShell) window.claudeShell.revealWindow();
    if (msg.sessionId) openSession(msg.sessionId);
});

/**
 * `#/session/<id>` on load, which is how a click that had to open a window
 * gets to the right conversation. Deliberately the same shape plan 02 gives
 * the deep links, so a `claude-sessions://` handler can route into the page
 * without inventing a second vocabulary.
 */
function openFromHash() {
    const m = /^#\/session\/([0-9a-f-]{8,})$/i.exec(location.hash || '');
    if (!m) return false;
    // The hash is a click that happened once, not a place: consume it so a
    // refresh does not keep re-opening the same session forever. What a refresh
    // lands on instead is the query string, which the open below is about to
    // write through rememberView. Only the hash goes — the search is the durable
    // half and dropping it here would undo the view restored a moment ago.
    history.replaceState(null, '', location.pathname + location.search);
    openSession(m[1]);
    return true;
}

// ── the bell ─────────────────────────────────────────────────────────────

const NOTE = {
    unsupported: 'This browser has no desktop notifications, so the sound is all '
        + 'there is here.',
    denied: 'The browser is blocking notifications for this page. Allow them in '
        + 'its site settings and this will come back.',
    rules: 'A plan, a question or a permission always speaks up — the turn is '
        + 'stopped until you answer. A turn finishing only does if it ran over '
        + '30 seconds. Never for the session already in front of you.',
};

function renderBell() {
    const perm = notifyPermission();
    const desktopOn = notify.desktop && perm === 'granted';
    // Struck through only when nothing at all would fire.
    dom.btnBell.dataset.on = String(desktopOn || notify.sound);
    dom.btnBell.title = desktopOn || notify.sound
        ? 'Notifications on' : 'Notifications off';

    // The checkbox shows what will actually happen, not what was asked for: a
    // ticked box that the browser is quietly overruling is worse than an
    // unticked one, and unticked is also what invites the click that asks.
    dom.optDesktop.checked = desktopOn;
    dom.optDesktop.disabled = perm === 'denied' || perm === 'unsupported';
    dom.optSound.checked = notify.sound;

    const stuck = perm === 'denied' ? NOTE.denied : perm === 'unsupported' ? NOTE.unsupported : '';
    dom.bellNote.textContent = stuck || NOTE.rules;
    dom.bellNote.className = 'bell-note' + (stuck ? ' warn' : '');
}

function showBell(on) {
    dom.bellMenu.hidden = !on;
    dom.btnBell.setAttribute('aria-expanded', String(on));
    // Both triggers stop the click from reaching the document, so neither
    // popover's outside-click listener sees the other one being opened. Without
    // this the two sit on screen together.
    if (on) { renderBell(); showNewMenu(false); }
}

dom.btnBell.addEventListener('click', (e) => {
    e.stopPropagation();
    showBell(dom.bellMenu.hidden);
});

dom.optDesktop.addEventListener('change', async () => {
    notify.desktop = dom.optDesktop.checked;
    localStorage.setItem('notifyDesktop', notify.desktop ? '1' : '0');
    // Asking here and nowhere else is deliberate: a permission prompt no
    // gesture invited is the one people press Block on, and some browsers
    // refuse to show it at all.
    if (notify.desktop && notifyPermission() === 'default') {
        try { await Notification.requestPermission(); } catch { /* renders as denied */ }
    }
    renderBell();
});

dom.optSound.addEventListener('change', () => {
    notify.sound = dom.optSound.checked;
    localStorage.setItem('notifySound', notify.sound ? '1' : '0');
    // This click is a gesture, which is what an AudioContext has been waiting
    // for if the page has not been touched yet.
    if (notify.sound) { wakeAudio(); chime('done'); }
    renderBell();
});

// Worth having: Focus Assist and Do Not Disturb drop notifications without a
// word, so "did that work" is otherwise unanswerable until a turn ends.
dom.bellTry.addEventListener('click', () => {
    announce('Claude Sessions', 'This is what a finished turn will look like.', 'done', null);
    if (!notify.sound && (!notify.desktop || notifyPermission() !== 'granted')) {
        toast('Both switches are off, so nothing would fire.', 'warn');
    }
});

document.addEventListener('click', (e) => {
    if (!dom.bellMenu.hidden && !e.target.closest('.bell-wrap')) showBell(false);
});

// ── streaming ────────────────────────────────────────────────────────────

function connect() {
    const es = new EventSource('/api/events');

    es.addEventListener('hello', (e) => {
        state.clientId = JSON.parse(e.data).clientId;
        // A new client id knows nothing about what this window was following, so
        // the board has to be asked for again — including when no session is
        // open, which is the ordinary case for a window left on the board.
        state.live.watching = false;
        if (state.current || state.live.open) { state.live.watching = state.live.open; subscribe(); }
        // Every `sessions-changed` while the stream was down was missed, and
        // nothing replays them, so the rail is however it was when the stream
        // dropped — a bridge restart used to leave rows sitting there with the
        // turn counts and times they had beforehand. Reconnecting is exactly the
        // moment the list cannot be trusted. Harmless on the first connect: it
        // costs the one extra fetch that boot was going to make anyway.
        loadSessions();
        // Same reasoning for the status line, which onerror left reading
        // "Reconnecting to the bridge…". applyRunner derives it from what we
        // already know, so an idle session says Ready again and a busy one is
        // left alone until its next status arrives.
        applyRunner(state.runner);
    });

    es.addEventListener('tail', (e) => {
        const d = JSON.parse(e.data);
        if (!state.current || d.sessionId !== state.current.sessionId) return;
        state.offset = d.offset;
        const stick = state.pinned;
        appendEvents(d.events, SESSION_VIEW);
        // A plan belonging to a session running elsewhere is read out of these
        // events, so it arrives — and goes away once answered over there — with
        // the transcript rather than with a status tick.
        refreshAsk(state.runner && state.runner.pendingPermission);
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
            // openSession only redraws immediately for a session we hold a summary
            // for; otherwise beginOpen waits on the fetch, and until then the row
            // is standing in a log about to be rebuilt from a file that shrank.
            clearPendingSend();
            openSession(id);
        }
    });

    es.addEventListener('overview', (e) => applyOverview(JSON.parse(e.data)));

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
        noteRunner(s);   // when this turn started, for the notification rules
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
        // Ahead of the early return, as with turn-complete: the asks worth
        // interrupting somebody for are the ones not already on screen.
        announceAsk(p);
        state.waiting.add(p.sessionId);
        paintLiveBadge();
        if (!state.current || p.sessionId !== state.current.sessionId) return;
        state.ask = p;
        renderAsk();
    });

    es.addEventListener('permission-resolved', (e) => {
        const p = JSON.parse(e.data);
        // However it was answered — here, in another window, from the toast
        // itself, or by the two-minute auto-deny — the toast has to go.
        clearAsk(p.sessionId);
        state.waiting.delete(p.sessionId);
        paintLiveBadge();
        if (!state.ask || state.ask.requestId !== p.requestId) return;
        resolveAsk(p.outcome);
    });

    es.addEventListener('notice', (e) => {
        const n = JSON.parse(e.data);
        toast(n.text, n.level === 'warn' ? 'warn' : 'info', 7000);
    });

    // A process reported a command list that differs from the one we hold —
    // a plugin installed, a command file added. Dropped rather than refetched:
    // the list is only wanted when somebody presses `/`, and most windows never
    // will for this directory.
    es.addEventListener('slash-commands', (e) => {
        const d = JSON.parse(e.data);
        state.slashCommands.delete(d.cwd);
        if (slashMenuOpen()) updateSlashMenu();
    });

    // A message arrived from another session — possibly at the conversation on
    // screen, possibly at one three projects away.
    //
    // The message itself is not in here and does not need to be: it is in the
    // transcript, and a session being watched is already tailing it, so it has
    // drawn itself by now. What this is for is everything that is not the open
    // pane — the rail's counts, and the peer list, whose usefulness depends on
    // being about sessions that are still running.
    es.addEventListener('peer-message', () => {
        // The sender may be a session this window has never heard of, and the
        // card that has just drawn itself off the transcript wants its name.
        state.peers.at = 0;
        warmPeers();
        if (mentionMenuOpen()) updateMentionMenu();
    });

    // A suggested follow-up was started or waved away, here or in another
    // window. The card is drawn from the transcript and the decision is not, so
    // this is the only thing that would tell a second window about it.
    es.addEventListener('suggestion-changed', async (e) => {
        const d = JSON.parse(e.data);
        if (!state.current || state.current.sessionId !== d.sessionId) return;
        try {
            const r = await get(`/api/sessions/${d.sessionId}/suggestions`);
            state.suggestions = new Map(Object.entries(r.suggestions || {}));
        } catch { return; }
        // The whole aside, which is a handful of nodes — the transcript beside
        // it is untouched, because none of this was ever in it.
        renderTasks();
    });

    // A declared command started, took its port, or ended — possibly in another
    // window. State only; the output has its own stream.
    es.addEventListener('run-changed', (e) => applyRunChange(JSON.parse(e.data)));

    // The bridge filed a row. Kept up to date rather than re-fetched, so a
    // history left open in a second window stays live.
    es.addEventListener('notification', (e) => {
        const row = JSON.parse(e.data);
        if (state.notes.scope === 'notable' && !row.loud) return;
        state.notes.rows.unshift(row);
        if (state.notes.open) { renderNotes(); markNotesSeen(); }
        else paintNotesBadge();
    });

    es.addEventListener('notification-resolved', (e) => {
        const { id, outcome, outcomeAt } = JSON.parse(e.data);
        const row = state.notes.rows.find(r => r.id === id);
        if (!row) return;
        // The answer belongs on the question, not on a second row underneath it.
        row.outcome = outcome;
        row.outcomeAt = outcomeAt;
        if (state.notes.open) renderNotes();
    });

    es.addEventListener('notifications-cleared', () => {
        state.notes.rows = [];
        if (state.notes.open) renderNotes();
        paintNotesBadge();
    });

    es.addEventListener('turn-complete', (e) => {
        const r = JSON.parse(e.data);
        state.unsent.delete(r.sessionId);   // it is in the transcript now
        // Ahead of the early return below, which drops every session but the
        // open one — and those are precisely the ones worth being told about.
        announceTurn(r);
        if (!state.current || r.sessionId !== state.current.sessionId) return;
        // The dev servers a turn started only become visible once it finishes.
        loadChannels();
        // A finished turn is the likeliest moment for a PR to have been raised, or
        // for a review to have landed on one. This is where a PR opened during the
        // conversation first appears — see headerPrs.
        loadPrStatus();
        loadAgents();
    });

    es.addEventListener('send-failed', (e) => {
        const f = JSON.parse(e.data);
        announceSendFailure(f);
        handleSendFailure(f);
    });

    es.addEventListener('session-forked', (e) => {
        const { from, to } = JSON.parse(e.data);
        state.unsent.delete(from);
        // The turn went to the copy, so the original's transcript will never show
        // it. openSessionSoon below can retry for a while, and the row must not sit
        // there through that.
        if (state.pendingSend && state.pendingSend.sessionId === from) clearPendingSend();
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
            // Orthogonal to the session follow: the board stays up while you
            // read a conversation, and the conversation keeps tailing while the
            // board is on screen.
            overview: state.live.open,
        });
    } catch { /* the SSE reconnect will re-subscribe */ }
}

function applyRunner(s) {
    state.runner = s;
    const busy = s && (s.state === 'busy' || s.state === 'starting');
    const retrying = Boolean(s && s.retry);

    // A turn that ends without saying anything — stopped, or an error — leaves
    // its last run of tool calls with no message coming to close it. The turn
    // ending is the close. Harmless while one is still in flight: closeRun does
    // nothing when there is no run, and this is the only thing that reports the
    // end of a turn to the log at all.
    if (!busy) { closeRun(SESSION_VIEW); closeRun(AGENT_VIEW); }

    // The status carries the pending ask too, so a window opening onto a session
    // that is already blocked draws the card without having seen the event.
    const ask = (s && s.pendingPermission) || null;
    refreshAsk(ask);

    // Approving a plan changes the mode out from under the selector, so a change
    // the bridge reports outranks a mode picked here and not yet sent: what the
    // work continues in was just decided, by the same person who would have made
    // that choice anyway. Learning a session's mode for the first time is not
    // such a change, or opening a session would drop the choice made for it.
    if (s && s.permissionMode) {
        const seen = state.runnerMode.has(s.sessionId);
        const moved = state.runnerMode.get(s.sessionId) !== s.permissionMode;
        state.runnerMode.set(s.sessionId, s.permissionMode);
        if (seen && moved) state.permChoice.delete(s.sessionId);
    }

    dom.statusLine.dataset.state = s
        ? (s.state === 'error' ? 'error' : ask ? 'ask' : retrying ? 'stalled' : busy ? 'busy' : 'idle')
        : 'idle';
    // While a subagent is on screen the composer belongs to nothing you can
    // send to, so its controls stay out of the way.
    dom.btnStop.hidden = !busy || Boolean(state.agent);
    enableSend(Boolean(state.current) && !state.agent);
    // Say what the button will actually do. While a turn is running the message
    // joins the queue rather than going anywhere, and that is worth admitting
    // before the click, not after.
    dom.btnSend.textContent = busy && !state.agent ? 'Queue' : 'Send';
    dom.btnLgtm.title = busy && !state.agent ? LGTM_TITLE_BUSY : LGTM_TITLE;
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
    paintPerm();
    paintLock();
    paintStatus(s);
}

/**
 * The offer to branch, when this session already has a process somewhere else.
 *
 * The recovery for this exists and works — `claude` refuses to resume, the
 * bridge classifies the refusal as `busy-elsewhere`, and handleSendFailure puts
 * the message back and offers the fork. But it only happens *after* the send,
 * and it rests on matching an error string. The registry says the same thing
 * beforehand, so the choice can be offered while it is still a choice.
 *
 * The composer is disabled rather than removed, and "Send anyway" is always
 * there: the registry can be wrong — a file left by a crash mid-write, a setup
 * nobody anticipated — and being locked out of your own session by a bad guess
 * is worse than the risk of the thing it is guarding against.
 */
/**
 * The registry entry holding the composer shut, or null.
 *
 * One function rather than a flag, because the answer has to be the same for the
 * banner, the send button and `sendMessage` — a lock that only the button knew
 * about was a lock Enter walked straight through.
 */
function lockedNow() {
    if (state.agent || !state.current) return null;
    if (state.lockOverride.has(state.current.sessionId)) return null;
    const s = state.sessions.find(x => x.sessionId === state.current.sessionId);
    return s ? elsewhere(s) : null;
}

function paintLock() {
    const away = lockedNow();
    dom.lock.hidden = !away;

    if (away) {
        dom.lockText.textContent = `This session is ${lower(awayWords(away))}.`;
        // Both buttons, not just Send: LGTM is an ordinary message with a canned
        // text, so it goes into the same transcript by the same path.
        // Not `readonly` on the box itself — a message can still be written
        // while deciding, and the fork carries whatever is in it.
        enableSend(false);
        dom.btnSend.textContent = 'Send';
        return;
    }

    // The lock clearing has to give the buttons back here. Nothing else will: a
    // session running in a terminal has no runner of ours, so its finishing
    // produces no runner-status event, and Send would stay grey for good.
    if (state.current && !state.agent && dom.btnSend.disabled && !state.runner) {
        enableSend(true);
    }
}

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Which permission mode the composer shows for the session it is pointing at.
 *
 * One control is shared by every session, so it has to be set on every open
 * rather than left where it was: inheriting the last session's value is how a
 * conversation gets sent in a mode that was picked for a different one, and
 * `Pool.ensure` then restarts its process to honour it. In order of authority —
 * a choice made here and not yet sent, the mode the live process is really in,
 * and the mode the transcript was last seen in.
 */
function paintPerm() {
    const id = state.current && state.current.sessionId;
    const mode = (id && state.permChoice.get(id))
        || (state.runner && state.runner.permissionMode)
        // The last mode a bridge actually reported, which outranks the file:
        // the transcript records the mode each *message* was sent in, and
        // approving a plan sends no message, so a session approved out of plan
        // mode reads as `plan` from the file for as long as it exists.
        || (id && state.runnerMode.get(id))
        || (state.current && state.current.permissionMode)
        || DEFAULT_PERM;
    // A mode this build does not offer — an older CLI's vocabulary, or a newer
    // one's — must not leave the control blank, because "" is what would then be
    // sent. Fall back rather than inventing an option for it.
    const known = [...dom.perm.options].some(o => o.value === mode);
    dom.perm.value = known ? mode : DEFAULT_PERM;
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
    // A row inside a folded run has no box to measure, so the jump would land
    // near the top of the pane instead of on it. Turns are never in a fold —
    // a message is what ends one — but the notification history jumps to tool
    // calls, and those are exactly what folds.
    const fold = t.node.closest('.trun');
    if (fold) fold.open = true;
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

/** Send and LGTM are enabled together: both are ways of sending to the session. */
function enableSend(on) {
    dom.btnSend.disabled = !on;
    dom.btnLgtm.disabled = !on;
}

/**
 * What LGTM says.
 *
 * The button sends this as an ordinary message, which is the point: approving
 * work is a thing worth having in the transcript in words, and "LGTM" on its own
 * is not an instruction — it does not say whether the branch is already on a PR,
 * or what counts as done.
 *
 * It ends by naming what should stop the merge, because the failure this replaces
 * is not a bad merge, it is a green one reported over the top of a red check.
 * Repositories with no remote are the normal case on this machine, so the PR is
 * described by what it is for rather than assumed to exist.
 */
const LGTM_PROMPT = `LGTM — take it from here and land it.

- If this work is not on a pull request yet, commit whatever is outstanding on a
  branch of its own and open one. If the repository has no remote, merging that
  branch into the main branch is the equivalent — do that instead.
- Run the checks this project expects of a change: its tests, lint, typecheck,
  build, whatever it has. Fix what they turn up.
- Once they pass, merge it.

If something genuinely blocks the merge — checks you cannot fix, conflicts, a
review asking for changes — stop and tell me instead of working around it.

If you noticed work along the way that this change is not the place for, file it
with your suggest_session tool before you finish, one call each — the refactor
you left alone, the test that should exist, the thing you had to work around. If
you noticed nothing, say nothing; this is not a box to fill.`;

const LGTM_TITLE = 'Send: open a PR for this work if there is not one, run the '
    + 'checks, and merge it once they pass.';
const LGTM_TITLE_BUSY = 'Queue behind the running turn: open a PR for this work '
    + 'if there is not one, run the checks, and merge it once they pass.';

// ── optimistic sends ─────────────────────────────────────────────────────
// A message you have just sent is not in the transcript yet, and cannot be: the
// bridge never writes transcripts, `claude` appends the user entry itself, and the
// bridge only learns of it on the next poll of the file. On a cold start — spawning
// the process and resuming a long transcript before it reads its first line — that
// is seconds, which looks exactly like a Send that did nothing. So the row is drawn
// here at the click, and the real one takes its place when it arrives.

// How long a drawn-but-unconfirmed row may stand. Long enough to clear a cold start
// and a poll; erring long costs nothing, because the row is right and only
// unconfirmed.
const PENDING_MS = 30000;

/**
 * Draw the message that has just been sent, ahead of the transcript.
 *
 * Only ever one at a time: pressing Enter twice in the same moment sends a second
 * message the bridge queues, and a queued message is already shown as a chip.
 */
function showPendingSend(sessionId, text) {
    if (state.pendingSend) return;
    // The real renderer, so the swap when the transcript catches up is one node for
    // another and not a reflow. No `ts`: clockOf gives an empty gutter for a missing
    // one, and the marker on it says what that means. Sending the local clock
    // instead would print a time the transcript is then free to disagree with —
    // a cold start really does record the entry a second or more later.
    const node = renderUser({ kind: 'user', text, ts: null });
    node.dataset.pending = '1';
    dom.log.append(node);
    state.pendingSend = {
        sessionId, node, timer: setTimeout(clearPendingSend, PENDING_MS),
    };
    state.pinned = true;
    scrollToEnd(false);
}

/**
 * Take the pending row down, however it ended.
 *
 * Nothing here has to hand the text back: a row that is retired because the
 * transcript arrived has been replaced by the real thing, and every other route —
 * a refused POST, a send-failed, a session that went away — either restores the
 * composer itself or still holds the text in state.unsent.
 */
function clearPendingSend() {
    const p = state.pendingSend;
    if (!p) return;
    clearTimeout(p.timer);
    state.pendingSend = null;
    p.node.remove();
}

async function sendMessage({ fork = false, text: override = null, canned = false } = {}) {
    const text = override != null ? override : dom.input.value.trim();
    if (!text || !state.current) return;
    const sessionId = state.current.sessionId;

    // The lock is a rule, not a disabled button. Greying out the buttons left
    // Enter — and every internal caller, LGTM included — going straight past it
    // into the two-writers case the whole thing exists to prevent. Branching is
    // exempt: a fork is the way out, and it writes to a new transcript rather
    // than this one.
    if (!fork && lockedNow()) {
        toast('This session is running elsewhere. Branch off a copy, or choose '
            + '“Send anyway”.', 'warn');
        dom.lockFork.focus();
        return;
    }

    // Only a message that came out of the box empties the box — and only then is
    // the saved draft gone with it. A canned send leaves a half-written message
    // where it was, rather than dropping it on the way past.
    if (override == null) {
        dom.input.value = '';
        autoGrow();
        saveDraft(sessionId, '');
    }

    // Drawn in the same frame the box empties, so the message moves from one to the
    // other rather than vanishing. Only a message that goes straight to the process,
    // though: one the bridge queues must not appear at the foot of the log, because
    // the foot of the log is *after* output that is still streaming above it — and a
    // queued message already has somewhere to be seen, as a chip on the composer.
    // The runner state is the same thing the button reads to decide whether it says
    // Queue or Send. The bridge's own answer is better, but it only arrives after
    // the await, and waiting for it is the delay this exists to remove. A fork is
    // left out because the copy gets its own transcript, and this log with it.
    const runner = state.runner;
    const willQueue = Boolean(runner
        && (runner.state === 'busy' || runner.state === 'starting'));
    if (!fork && !willQueue) showPendingSend(sessionId, text);

    enableSend(false);

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
        // queue back on failure. Canned text is not worth holding at all — it is
        // a button press away, and it is long.
        if (!r.queued && !canned) state.unsent.set(sessionId, text);
        applyRunner(r.status);
        if (!r.queued) {
            state.pinned = true;
            scrollToEnd(false);
        } else {
            // Our reading of the runner was behind the bridge's — another window
            // sent a moment ago, or the session is being held somewhere else. The
            // chip is the honest home for a queued message, so the row gives way.
            clearPendingSend();
        }
    } catch (err) {
        clearPendingSend();   // it never reached the bridge; the log must not claim it did
        if (!canned) restoreToComposer(text);
        toast(`Could not send: ${err.message}`, 'error');
    } finally {
        enableSend(Boolean(state.current));
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
    // The turn never started, so nothing is coming to replace the row. This arrives
    // as an event rather than as a refused POST — a process that died on the write,
    // a session already held in a terminal — and can be about a session that is not
    // the one on screen, hence the check.
    if (state.pendingSend && state.pendingSend.sessionId === f.sessionId) {
        clearPendingSend();
    }

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

// ── project commands ─────────────────────────────────────────────────────
// What the session's directory declares in .tgxcode/, as a button each. The
// directory is the session's own, so a session inside a worktree gets that
// worktree's dev server on its own port rather than the main checkout's.
//
// Nothing here ever starts anything on its own — the declaration is read on
// open, and a command runs when it is clicked and not before. The exact string
// that will run is on every button's tooltip, because a checked-in file can
// change what a familiar button does and the honest answer to that is to show
// it rather than to ask about it every time.

/** Where commands for the session on screen are read from. */
function cmdDir() {
    return (state.current && state.current.cwd) || null;
}

const runFor = (commandId) => {
    const dir = cmdDir();
    if (!dir) return null;
    for (const run of state.runs.values()) {
        if (run.workspace === dir && run.commandId === commandId) return run;
    }
    return null;
};

const liveRuns = () => [...state.runs.values()].filter(r => r.workspace === cmdDir());

async function loadCommands() {
    const dir = cmdDir();
    state.cmdsFor = dir;
    if (!dir) { state.cmds = null; renderCommands(); return; }
    let payload;
    try {
        payload = await get(`/api/commands?cwd=${encodeURIComponent(dir)}`);
    } catch {
        // A directory outside the allowed roots, or a bridge that has gone
        // away. Either way there is nothing to offer and no news in saying so.
        payload = null;
    }
    // The session moved while this was in flight.
    if (state.cmdsFor !== dir) return;
    state.cmds = payload;
    // Replaced, not merged. The bridge drops a run's record when the same button
    // is clicked again, and merging kept the dead one alive on this side — which
    // showed as two tabs for one command, one of them a run that no longer
    // existed. The payload is the whole truth about this directory.
    state.runs = new Map();
    if (payload) {
        for (const c of payload.commands) if (c.run) state.runs.set(c.run.id, c.run);
    }
    renderCommands();
}

/**
 * A command's button, coloured by what its run is doing.
 *
 * Green is reserved in this UI for something actually running, so it goes on
 * `listening` and on `running` — not on `starting`, where the honest answer is
 * "asked for, not there yet".
 */
function commandButton(cmd) {
    const run = runFor(cmd.id);
    const state_ = run ? run.state : 'idle';
    // Red is for something that fell over, not for something you stopped.
    const failed = !!run && run.state === 'exited' && !run.stopped
        && !!run.exit && !!(run.exit.code || run.exit.signal);
    const up = state_ === 'listening' || state_ === 'running';

    const bits = [`${cmd.command}`, `in ${cmd.cwd}`];
    if (run && run.port) bits.push(up ? `on port ${run.port}` : `port ${run.port}`);
    if (failed) bits.push(`exited ${run.exit.signal || run.exit.code}`);

    return el('button', {
        class: `cmd-btn${up ? ' on' : ''}${failed ? ' failed' : ''}`
            + (state_ === 'starting' || state_ === 'stopping' ? ' pending' : ''),
        type: 'button',
        title: bits.join('\n'),
        'data-id': cmd.id,
        onclick: () => clickCommand(cmd),
    },
    el('span', { class: 'cmd-dot' }),
    el('span', { class: 'cmd-label' }, cmd.label),
    up && run.port ? el('span', { class: 'cmd-port' }, `:${run.port}`) : null);
}

function renderCommands() {
    const payload = state.cmds;
    const list = payload ? payload.commands : [];
    dom.cmds.replaceChildren(...list.map(commandButton));

    // Problems go on the container rather than into a row of their own: a
    // config file with a typo in it should be findable, not shouty.
    const problems = (payload && payload.problems) || [];
    const loud = problems.filter(p => !p.informational);
    dom.cmds.classList.toggle('has-problems', loud.length > 0);
    if (loud.length) {
        dom.cmds.title = loud.map(p =>
            `${p.file || ''}${p.id ? ` [${p.id}]` : ''}: ${p.message}`).join('\n');
    } else {
        dom.cmds.removeAttribute('title');
    }
    renderTermTabs();
}

/**
 * Start it, or show what it is already doing.
 *
 * A live run is never restarted by clicking its button — that would take a dev
 * server down because somebody meant to look at its log. Stopping is a separate,
 * labelled button in the pane.
 */
async function clickCommand(cmd) {
    const existing = runFor(cmd.id);
    if (existing && existing.state !== 'exited') {
        showTerm(true);
        setTermTab(existing.id);
        return;
    }
    try {
        const { run } = await post('/api/commands/run', { cwd: cmdDir(), id: cmd.id });
        // One run per command per directory, the same rule the bridge enforces:
        // whatever was here before has just been replaced, record and log alike.
        const stale = runFor(cmd.id);
        if (stale) state.runs.delete(stale.id);
        state.runs.set(run.id, run);
        renderCommands();
        showTerm(true);
        setTermTab(run.id);
    } catch (err) {
        toast(`${cmd.label}: ${err.message}`, 'error');
    }
}

/** A run's state changed somewhere — possibly in another window. */
function applyRunChange(e) {
    const known = state.runs.get(e.runId);
    if (known) {
        state.runs.set(e.runId,
            { ...known, state: e.state, port: e.port, exit: e.exit, stopped: e.stopped });
    } else if (e.workspace === cmdDir()) {
        // Started from another window, in the directory on screen. Ask for the
        // whole record rather than inventing one from a state change.
        loadCommands();
        return;
    } else {
        return;
    }
    renderCommands();
    if (state.termTab === e.runId) paintTermHead(termPane.info);
}

// ── terminal ─────────────────────────────────────────────────────────────

// The pane is a property of the session, not of the window: a shell is opened
// to do something in one conversation's directory, and a session you never
// wanted one in should not inherit it just because the last one had it open.
// So the open flag is remembered per session, the way a draft is.
//
// The height is the other way round — that really is a property of the window,
// and a pane that resized itself as you moved between sessions would be worse
// than one that did not.
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

// Only a session with the pane open holds a key, so closing it leaves nothing
// behind and the storage grows with shells you are actually using.
const termKey = (id) => `term:${id}`;

function termOpen(id) {
    try { return !!id && localStorage.getItem(termKey(id)) === '1'; } catch { return false; }
}

function setTermOpen(id, on) {
    if (!id) return;
    try {
        if (on) localStorage.setItem(termKey(id), '1');
        else localStorage.removeItem(termKey(id));
    } catch { /* storage unavailable; the pane is still right for this window */ }
}

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
    // A run tab describes a command, not a directory, and has its own controls.
    if (state.termTab !== 'shell') return paintRunHead();

    dom.termRestart.hidden = false;
    dom.termStop.hidden = true;

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

/**
 * The head, when the pane is showing a run.
 *
 * The command itself goes where the shell's directory would be, because that is
 * what the tab is: not "a place" but "this exact string, which you can read
 * before and after it runs".
 */
function paintRunHead() {
    const run = state.runs.get(state.termTab);
    dom.termRestart.hidden = true;
    if (!run) {
        dom.termDir.textContent = '';
        dom.termMoved.hidden = true;
        dom.termStop.hidden = true;
        return;
    }

    dom.termDir.textContent = run.command;
    dom.termDir.title = `${run.command}\nin ${run.cwd}`;

    const live = run.state !== 'exited';
    const bits = [];
    if (run.port) bits.push(`port ${run.port}`);
    if (run.state === 'starting') bits.push('starting…');
    if (!live) {
        // A run somebody stopped just says so. The signal it actually died of is
        // a detail of how hard the bridge had to insist, not something that
        // happened to it.
        if (run.stopped) bits.push('stopped');
        else if (run.exit && run.exit.signal) bits.push(`killed (${run.exit.signal})`);
        else if (run.exit) bits.push(`exited ${run.exit.code}`);
        else bits.push('gone');
    }
    // Said out loud rather than discovered: a run belongs to the bridge that
    // started it, and there is no way to make one outlive its process.
    if (live) bits.push('stops when the bridge restarts');
    dom.termMoved.hidden = !bits.length;
    dom.termMoved.textContent = bits.length ? `· ${bits.join(' · ')}` : '';
    dom.termMoved.removeAttribute('title');

    dom.termStop.hidden = false;
    dom.termStop.textContent = live ? 'Stop' : 'Start again';
    dom.termStop.title = live
        ? `Stop ${run.label} — SIGHUP to the whole job, then SIGKILL`
        : `Run ${run.command} again`;
}

/**
 * The tab strip: the shell, then a tab per run in this directory.
 *
 * Absent entirely when there are no runs, so a session in a project that
 * declares nothing sees exactly the pane it saw before.
 */
function renderTermTabs() {
    const runs = liveRuns().sort((a, b) => a.startedAt - b.startedAt);
    if (!runs.length) {
        dom.termTabs.replaceChildren();
        dom.termTabs.hidden = true;
        if (state.termTab !== 'shell') setTermTab('shell');
        return;
    }
    dom.termTabs.hidden = false;

    const tab = (key, label, extra) => el('button', {
        class: `term-tab${state.termTab === key ? ' on' : ''}${extra || ''}`,
        type: 'button', role: 'tab',
        'aria-selected': String(state.termTab === key),
        onclick: () => setTermTab(key),
    }, label);

    dom.termTabs.replaceChildren(
        tab('shell', 'Shell'),
        ...runs.map((r) => {
            const up = r.state === 'listening' || r.state === 'running';
            const label = r.port && up ? `${r.label} :${r.port}` : r.label;
            return tab(r.id, label, up ? ' on-air' : (r.state === 'exited' ? ' dead' : ''));
        }),
    );
}

/** Point the pane at a tab. The other tab's process is untouched either way. */
function setTermTab(key) {
    state.termTab = key;
    renderTermTabs();
    if (dom.termPane.hidden) return;
    syncTerm();
}

/** Show or hide the pane. The shell itself is unaffected either way. */
function showTerm(on, { focus = false } = {}) {
    setTermOpen(state.current && state.current.sessionId, on);
    dom.termPane.hidden = !on;
    dom.btnTerm.classList.toggle('on', on);
    dom.btnTerm.setAttribute('aria-pressed', String(on));
    renderHeaderActions();
    if (!on) { termPane.detach(); return; }

    setTermHeight(termHeight());
    syncTerm();
    if (focus) termPane.focus();
}

/** Point the pane at whatever session — or run — is on screen. */
function syncTerm() {
    if (dom.termPane.hidden) return;
    if (!state.current) { termPane.detach(); paintTermHead(null); return; }

    if (state.termTab !== 'shell') {
        paintRunHead();
        termPane.attachRun(state.termTab);
        return;
    }

    // Already attached: the shell is known, so the head can be right now rather
    // than after a round trip. Otherwise stand in with where it is about to open.
    if (termPane.info && termPane.sessionId === state.current.sessionId) {
        paintTermHead(termPane.info);
    } else {
        dom.termRestart.hidden = false;
        dom.termStop.hidden = true;
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

/**
 * Every directory a session has run in, newest first — the one list the dialog's
 * Recent tab and the rail's split menu both answer from.
 */
async function loadProjects() {
    const { projects } = await get('/api/projects');
    // The same list, keyed by path, so a browsed row can say "you have worked
    // here" without a second request. It quietly joins the two tabs together.
    state.browse.known = new Map(projects.map(p => [p.cwd, p]));
    return projects;
}

/**
 * @param {{cwd?: string, tab?: 'recent'|'browse', prompt?: string}} [opts] `cwd`
 *   is a caller that has already answered "where" — the split menu passes the
 *   row you clicked. Without one the dialog opens where it always has: the
 *   session on screen, else the most recent project. `prompt` fills the first
 *   message, for a caller that has already written one — Edit first on a
 *   suggested follow-up, where the whole point is that the prompt exists and
 *   you want a look at it before it runs.
 */
async function openNew({ cwd = '', tab = null, prompt = '' } = {}) {
    dom.newScrim.hidden = false;
    dom.newPrompt.value = prompt;
    growPrompt();
    dom.newTest.checked = false;
    dom.newCwd.value = cwd || (state.current
        ? (state.current.worktree ? state.current.worktree.originalCwd : state.current.cwd)
        : '');
    cancelMkdir();
    try {
        const projects = await loadProjects();
        dom.newPicker.replaceChildren(...projects.slice(0, 40).map(p =>
            el('button', {
                class: 'picker-row', type: 'button',
                onclick: () => { dom.newCwd.value = p.cwd; dom.newPrompt.focus(); },
            },
                el('span', {}, p.name),
                el('span', { class: 'path' }, clip(p.cwd, 44)),
                p.active ? el('span', { class: 'tag' }, `${p.active} live`) : null,
            )));
        // Only for a dialog that opened with nothing in the box. A caller that
        // named a directory has already answered this, and the box was filled
        // before the await precisely so this cannot overwrite it.
        if (!dom.newCwd.value && projects[0]) dom.newCwd.value = projects[0].cwd;
    } catch (err) {
        toast(`Could not list projects: ${err.message}`, 'error');
    }
    setPickerTab(tab || state.browse.tab, { load: true });
    dom.newPrompt.focus();
    // A prompt that arrived already written is there to be read and edited, so
    // put the caret at the end of it rather than in front of the first word.
    if (prompt) dom.newPrompt.setSelectionRange(prompt.length, prompt.length);
}

function closeNew() { dom.newScrim.hidden = true; }

// ── the recent-directories menu ──────────────────────────────────────────

// Six, so the whole menu — including the way out of it — fits without
// scrolling. The dialog's Recent tab is still there for the long tail; this is
// meant to be the handful of directories you are actually in this week.
const NEW_MENU_MAX = 6;
let newMenuSeq = 0;

function showNewMenu(on, { focusFirst = false } = {}) {
    dom.newMenu.hidden = !on;
    dom.btnNewMenu.setAttribute('aria-expanded', String(on));
    if (on) { showBell(false); fillNewMenu({ focusFirst }); }
}

/**
 * Asked for on every open rather than cached.
 *
 * The endpoint is one pass over an index already in memory; the ordering is the
 * whole point of the menu and moves whenever a session writes a line; and
 * `state.browse.known` — the only list this page holds — is filled solely by
 * openNew(), so a cache-first menu would be empty on a fresh load where the
 * dialog has never been opened. That is the one click that has to work.
 */
async function fillNewMenu({ focusFirst = false } = {}) {
    const seq = ++newMenuSeq;
    dom.newMenu.replaceChildren(el('div', { class: 'menu-note' }, 'Loading…'));

    let projects;
    try {
        projects = await loadProjects();
    } catch (err) {
        if (seq === newMenuSeq) {
            dom.newMenu.replaceChildren(
                el('div', { class: 'menu-note' }, `Could not list projects: ${err.message}`));
        }
        return;
    }
    // Closed, or opened again behind this request.
    if (seq !== newMenuSeq || dom.newMenu.hidden) return;

    const rows = projects.slice(0, NEW_MENU_MAX).map((p, i) => el('button', {
        class: 'picker-row', type: 'button', role: 'menuitem', tabindex: -1,
        onclick: () => { showNewMenu(false); openNew({ cwd: p.cwd }); },
        onkeydown: (e) => onNewMenuKey(e, i),
    },
        el('span', {}, clip(p.name, 26)),
        // Green stays reserved for something actually running, as everywhere
        // else; the session count is the quieter fact.
        p.active
            ? el('span', { class: 'tag' }, `${p.active} live`)
            : el('span', { class: 'tag dim' }, String(p.sessions)),
        el('span', { class: 'path' }, clip(p.cwd, 44)),
    ));

    // The way out of a short list, for a directory with no history. It writes
    // `newPickerTab`, so the dialog opens on Browse next time too — which is
    // right: the app already remembers your last tab, and asking for Browse is
    // a statement about where you are working now.
    const browse = el('button', {
        class: 'picker-row', type: 'button', role: 'menuitem', tabindex: -1,
        onclick: () => { showNewMenu(false); openNew({ tab: 'browse' }); },
        onkeydown: (e) => onNewMenuKey(e, rows.length),
    }, el('span', {}, 'Another directory…'));

    // Flat, so every menuitem is a direct child of the menu.
    dom.newMenu.replaceChildren(
        ...(rows.length ? rows : [el('div', { class: 'menu-note' }, 'No directories yet.')]),
        el('div', { class: 'sep' }),
        browse,
    );
    const first = setNewMenuTab(0);
    if (focusFirst && first) first.focus();
}

// One tab stop for the whole menu, arrows to move within it — the folder tree's
// shape (setTreeTab), with wrapping, because a menu is a ring and a tree is not.
const newMenuRows = () => [...dom.newMenu.querySelectorAll('.picker-row')];

function setNewMenuTab(i = 0) {
    const rows = newMenuRows();
    rows.forEach((r, n) => { r.tabIndex = n === i ? 0 : -1; });
    return rows[i] || null;
}

function focusNewMenuAt(i) {
    const rows = newMenuRows();
    if (!rows.length) return;
    const n = ((i % rows.length) + rows.length) % rows.length;
    setNewMenuTab(n);
    rows[n].focus();
}

/** Escape is deliberately absent — the central ladder closes the menu. */
function onNewMenuKey(e, i) {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusNewMenuAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusNewMenuAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusNewMenuAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusNewMenuAt(-1); }
    else if (e.key === 'Tab') showNewMenu(false);
}

dom.btnNewMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    showNewMenu(dom.newMenu.hidden);
});

// Down on the caret is the keyboard's "open this and start choosing". The fill
// is async, so the intent is carried into it rather than acted on here.
dom.btnNewMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (dom.newMenu.hidden) showNewMenu(true, { focusFirst: true });
    else focusNewMenuAt(e.key === 'ArrowDown' ? 0 : -1);
});

document.addEventListener('click', (e) => {
    if (!dom.newMenu.hidden && !e.target.closest('.new-wrap')) showNewMenu(false);
});

// ── the directory picker ─────────────────────────────────────────────────
//
// Two tabs over one decision. *Recent* is the list this app has always had —
// every directory a session has ever run in. *Browse* is for the case it cannot
// answer: a directory with no history, or one that does not exist yet.
//
// The rule that keeps the two from fighting is that **walking into a folder is
// how you choose it**. There is no select-versus-descend distinction, no
// checkmark, and no second click: every navigation writes #new-cwd, and #new-cwd
// stays the single answer to "where will this run". So "how do I pick the folder
// I am looking at?" answers itself — you already have, and the box above says so.

function setPickerTab(tab, { load = false } = {}) {
    const browsing = tab === 'browse';
    state.browse.tab = browsing ? 'browse' : 'recent';
    try { localStorage.setItem('newPickerTab', state.browse.tab); } catch { /* private mode */ }

    dom.newTabRecent.setAttribute('aria-selected', String(!browsing));
    dom.newTabBrowse.setAttribute('aria-selected', String(browsing));
    dom.newPicker.hidden = browsing;
    dom.newBrowse.hidden = !browsing;
    if (!browsing) cancelMkdir();
    if (browsing && (load || !state.browse.dir)) browseTo(startDir());
}

/** Where Browse should open: whatever the box says, else wherever we were. */
function startDir() {
    return dom.newCwd.value.trim() || state.browse.dir || '';
}

/** Strip a trailing slash so a typed path can be compared with a listed one. */
const tidyPath = (p) => String(p || '').trim().replace(/(?!^)\/+$/, '');

/**
 * List a directory and — because navigating is selecting — point #new-cwd at it.
 *
 * `select: false` is for the one case where that would be wrong: a first load
 * that lands somewhere other than where the box already says.
 */
async function browseTo(dir, { select = true, fromKeyboard = false } = {}) {
    const seq = ++state.browse.seq;
    let data;
    try {
        data = await get(`/api/fs?path=${encodeURIComponent(dir)}`);
    } catch (err) {
        // A 403 for a path outside the roots is the bridge's call, not ours to
        // predict — the roots live in one place. Say what it said and stay put.
        toast(`Could not open that folder: ${err.message}`, 'error');
        if (!state.browse.dir && dir) browseTo('', { select: false });
        return;
    }
    if (seq !== state.browse.seq) return;   // a later click already won

    Object.assign(state.browse, {
        dir: data.path,
        parent: data.parent || null,
        roots: data.roots || [],
        entries: data.entries || [],
        truncated: !!data.truncated,
        // A readdir that failed comes back 200 with this set — the path and the
        // way back up are still good, so the pane keeps working around it.
        error: data.error || null,
        focus: null,
    });
    if (select) dom.newCwd.value = data.path;
    cancelMkdir();
    renderBrowse();
    if (fromKeyboard) focusRowAt(0);
}

function renderBrowse() {
    const b = state.browse;

    // More than one root configured means the second one is otherwise unreachable
    // from here: the trail stops at the top of whichever root you are inside.
    dom.newRoots.hidden = b.roots.length < 2;
    if (b.roots.length >= 2) {
        dom.newRoots.replaceChildren(
            el('span', {}, 'Roots:'),
            ...b.roots.map(r => el('button', {
                class: 'crumb', type: 'button', onclick: () => browseTo(r),
            }, homely(r))));
    }

    dom.newCrumbs.replaceChildren(...crumbsFor(b));

    // The way back up is rendered whatever happened below it, so an unreadable
    // folder is somewhere you can leave rather than somewhere you are stuck.
    const rows = b.parent ? [upRow()] : [];
    if (b.error) {
        rows.push(el('div', { class: 'picker-msg' }, `Cannot read this folder — ${b.error}`));
    } else {
        rows.push(...b.entries.map((e, i) => treeRow(e, i)));
        if (!b.entries.length) {
            // The sentence that answers "so how do I pick where I am?", at the
            // moment somebody standing in an empty folder asks it.
            rows.push(el('div', { class: 'picker-msg' },
                'No sub-folders here. Start uses this one.'));
        }
    }
    dom.newTree.replaceChildren(...rows);
    setTreeTab();

    dom.newMkdir.textContent = `New folder in ${clip(baseName(b.dir), 24)}`;
    dom.newBrowseNote.textContent = browseNote(b);
}

function baseName(p) {
    const parts = String(p || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '/';
}

/** What the pane wants to say under itself, if anything. */
function browseNote(b) {
    const typed = tidyPath(dom.newCwd.value);
    if (typed && b.dir && typed !== b.dir) {
        return `Showing ${homely(b.dir)} — press Enter in the box to browse to what you typed.`;
    }
    if (b.truncated) return `Showing the first 500 folders — type a path to go straight there.`;
    return '';
}

/**
 * The trail, stopping at the top of whichever root contains this directory
 * rather than walking on to `/` — every crumb has to be somewhere you may go.
 */
function crumbsFor(b) {
    if (!b.dir) return [];
    const root = b.roots
        .filter(r => b.dir === r || b.dir.startsWith(`${r}/`))
        .sort((x, y) => y.length - x.length)[0] || '/';

    const rest = b.dir.slice(root.length).split('/').filter(Boolean);
    const out = [crumb(homely(root), root, !rest.length)];
    let at = root === '/' ? '' : root;
    rest.forEach((seg, i) => {
        at += `/${seg}`;
        const here = at;
        out.push(el('span', {}, '/'), crumb(seg, here, i === rest.length - 1));
    });
    return out;
}

function crumb(label, target, current) {
    return el('button', {
        class: 'crumb', type: 'button',
        // The last crumb re-lists rather than doing nothing, which doubles as the
        // refresh you want after making a folder outside the app.
        'aria-current': current ? 'page' : null,
        onclick: () => browseTo(target),
    }, label);
}

function upRow() {
    return el('button', {
        class: 'picker-row up', type: 'button', 'data-path': state.browse.parent,
        onclick: () => browseTo(state.browse.parent),
        onkeydown: (e) => onTreeKey(e, -1),
    }, el('span', {}, '↑ ..'), el('span', { class: 'path' }, homely(state.browse.parent)));
}

function treeRow(entry, i) {
    const seen = state.browse.known.get(entry.path);
    // Having worked here is the stronger signal, so it wins the one tag slot.
    // Green is kept for a session actually running, as it is everywhere else —
    // "you have been here before" is a quieter fact than "something is happening".
    const tag = seen
        ? (seen.active
            ? el('span', { class: 'tag' }, `${seen.active} live`)
            : el('span', { class: 'tag dim' }, 'seen'))
        : (entry.git ? el('span', { class: 'tag dim' }, 'git') : null);
    return el('button', {
        class: 'picker-row', type: 'button', 'data-path': entry.path,
        'aria-current': entry.path === tidyPath(dom.newCwd.value) ? 'true' : null,
        onclick: () => browseTo(entry.path),
        onkeydown: (e) => onTreeKey(e, i),
    }, el('span', {}, clip(entry.name, 48)), tag);
}

// One tab stop for the whole list, arrows to move within it — the same shape as
// the send queue, which is the only other long list of buttons in this file.
function setTreeTab() {
    const rows = [...dom.newTree.querySelectorAll('.picker-row')];
    const want = rows.find(r => r.dataset.path === state.browse.focus) || rows[0];
    for (const r of rows) r.tabIndex = r === want ? 0 : -1;
}

function focusRowAt(i) {
    const rows = [...dom.newTree.querySelectorAll('.picker-row')];
    const row = rows[Math.max(0, Math.min(i, rows.length - 1))];
    if (!row) { dom.newTree.focus?.(); return false; }
    state.browse.focus = row.dataset.path;
    setTreeTab();
    row.focus({ preventScroll: false });
    return true;
}

/**
 * `i` is the row's index, or -1 for the Up row that sits above them all.
 *
 * Escape is deliberately absent: a row has nothing of its own to cancel, so the
 * central ladder should get it and close the dialog. The only thing here that
 * stops Escape is the New folder box.
 */
function onTreeKey(e, i) {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRowAt(rowIndex(i) + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusRowAt(rowIndex(i) - 1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        if (!state.browse.parent) return;
        e.preventDefault();
        browseTo(state.browse.parent, { fromKeyboard: true });
        return;
    }
    if (e.key === 'ArrowRight') {
        e.preventDefault();
        const target = i < 0 ? state.browse.parent : state.browse.entries[i]?.path;
        if (target) browseTo(target, { fromKeyboard: true });
    }
    // Enter and Space are a button's own job — the click handler navigates.
}

/** Position in the rendered list, where the Up row (i === -1) is index 0. */
function rowIndex(i) {
    const offset = state.browse.parent ? 1 : 0;
    return i < 0 ? 0 : i + offset;
}

// ── new folder ───────────────────────────────────────────────────────────

function startMkdir() {
    state.browse.naming = true;
    dom.newMkdir.hidden = true;
    dom.newMkdirName.hidden = false;
    dom.newMkdirGo.hidden = false;
    dom.newMkdirName.value = '';
    dom.newMkdirName.focus();
}

function cancelMkdir() {
    state.browse.naming = false;
    dom.newMkdir.hidden = false;
    dom.newMkdirName.hidden = true;
    dom.newMkdirGo.hidden = true;
    dom.newMkdirName.value = '';
}

async function submitMkdir() {
    const name = dom.newMkdirName.value.trim();
    const parent = state.browse.dir;
    if (!name) { dom.newMkdirName.focus(); return; }
    if (!parent) return;

    // Pre-empt the duplicate the pane can already see. The server still answers
    // for the one it cannot — something else may have created it meanwhile.
    if (state.browse.entries.some(e => e.name === name)) {
        toast(`${name} is already here.`, 'warn');
        return;
    }

    dom.newMkdirGo.disabled = true;
    try {
        const r = await post('/api/fs/mkdir', { parent, name });
        cancelMkdir();
        // Walking in is what selects it, so this is also the pick.
        await browseTo(r.path);
        toast(r.created ? `Created ${name}.` : `${name} was already there.`, 'ok');
        dom.newPrompt.focus();
    } catch (err) {
        // The name box stays open with the text in it — retyping a rejected name
        // is the one thing that should not be part of fixing it.
        toast(`Could not create the folder: ${err.message}`, 'error');
        dom.newMkdirName.focus();
    } finally {
        dom.newMkdirGo.disabled = false;
    }
}

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
// One click, and no confirmation over the top of it: the click *is* the approval,
// and the session still asks for whatever its permission mode makes it ask for
// before anything is pushed or merged.
dom.btnLgtm.addEventListener('click', () => sendMessage({ text: LGTM_PROMPT, canned: true }));
// Wrapped, not passed: openNew now takes an options bag, and a MouseEvent is
// not one.
dom.tasksCollapse.addEventListener('click', () => showTasks(false));
dom.tasksStrip.addEventListener('click', () => showTasks(true));

for (const n of dom.taskScrim.querySelectorAll('[data-close-task]')) {
    n.addEventListener('click', closeTaskDialog);
}
dom.taskScrim.addEventListener('click', (e) => {
    if (e.target === dom.taskScrim) closeTaskDialog();
});
// The prompt is the thing worth having elsewhere — pasted into a terminal, into
// another tool, into a message to somebody. The rendered markdown is not it, so
// the source is what goes on the clipboard.
dom.taskDlgCopy.addEventListener('click', async () => {
    const ev = state.tasks.get(state.taskDialog);
    if (!ev) return;
    try {
        await navigator.clipboard.writeText(ev.prompt);
        toast('Prompt copied.', 'ok');
    } catch {
        toast('Could not reach the clipboard.', 'error');
    }
});

dom.btnNew.addEventListener('click', () => openNew());

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
// Stop, or start again — the same button, because for a run those are the two
// halves of one question and the label says which one it is asking.
dom.termStop.addEventListener('click', async () => {
    const run = state.runs.get(state.termTab);
    if (!run) return;
    if (run.state !== 'exited') {
        try { await post(`/api/runs/${run.id}/stop`, {}); }
        catch (err) { toast(`Stopping ${run.label}: ${err.message}`, 'error'); }
        return;
    }
    const cmd = (state.cmds && state.cmds.commands.find(c => c.id === run.commandId));
    if (!cmd) { toast(`${run.label} is no longer declared here`, 'warn'); return; }
    // The old record goes as the new one takes its place: same button, same tab
    // slot, and the bridge has already dropped the log with it.
    state.runs.delete(run.id);
    clickCommand(cmd);
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

// The plan view outlives any one plan, so its listeners are bound here once
// rather than in the render — bound there they would stack up one deep per
// status tick, and every key would answer the ask several times over.
dom.planAside.addEventListener('click', () => setPlanAside(true));
dom.planBar.addEventListener('click', () => setPlanAside(false));
dom.planPane.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // While the feedback box is open it owns the keyboard: Enter sends it, Esc
    // closes it, and Y/A/F/N are letters somebody is in the middle of typing.
    if (dom.planFoot.querySelector('.perm-feedback')) return;
    if (e.key === 'Escape') { e.preventDefault(); setPlanAside(true); return; }
    if (isTyping(e.target)) return;
    // Setting a plan aside is about this window. Answering one is not ours to do
    // when the process raising it belongs to another.
    if (state.ask && state.ask.readOnly) return;
    const k = e.key.toLowerCase();
    if (k === 'y') { e.preventDefault(); answerAsk({ decision: 'allow', mode: 'auto' }); }
    else if (k === 'a') { e.preventDefault(); answerAsk({ decision: 'allow', mode: 'acceptEdits' }); }
    else if (k === 'f') { e.preventDefault(); openFeedback(dom.planFoot, 'approve'); }
    else if (k === 'n') { e.preventDefault(); openFeedback(dom.planFoot, 'reject'); }
});

// A mode is picked for the conversation in front of you, so it is remembered
// against that session rather than against the window — see paintPerm.
dom.perm.addEventListener('change', () => {
    if (state.current) state.permChoice.set(state.current.sessionId, dom.perm.value);
});

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

// ── slash-command completion ─────────────────────────────────────────────
//
// Typing `/` in the composer offers the commands this session can actually run.
// The list comes from the bridge, which gets it from the CLI's own init message
// — so it covers built-ins, plugins, skills and the project's own commands
// without this file knowing anything about how any of them resolve.
//
// What is inserted is plain text: `/name `. Claude Code expands it on the way
// in, and the transcript comes back with the command already parsed, which is
// why renderUser has drawn these properly since long before you could type one.

// The menu is open **iff** the whole composer is one slash-word. Not "a `/` was
// pressed": deriving it from the text rather than from a keystroke means paste,
// IME and autocorrect all behave, backspacing from `/revi` to `/re` re-opens it
// with no special case, and there is no open/closed flag to fall out of sync
// with what is on screen.
//
// Anchoring to the *whole* value rather than to a line start is not a
// simplification — it is the rule the CLI enforces. Its dispatch tests
// `text.startsWith("/")` on the last text block, untrimmed, so a `/command` on
// line three of a message is sent as prose. A menu that offered one there would
// be promising something that will not happen.
const SLASH_RE = /^\/[A-Za-z0-9_:-]*$/;

// Two popovers now hang off the composer — `/` commands and `@` mentions — and
// they share everything except what opens them and what accepting one inserts.
// So the selection, the paging and the keyboard map below take a menu rather
// than reaching for one: `node` is the element it draws into, `id` prefixes its
// rows' DOM ids so aria-activedescendant can name one unambiguously.
const slashMenu = { rows: [], index: 0, seq: 0, node: dom.slashMenu, id: 'slash' };
const mentionMenu = { rows: [], index: 0, seq: 0, node: dom.mentionMenu, id: 'mention' };

const menuOpen = (m) => !m.node.hidden;
const slashMenuOpen = () => menuOpen(slashMenu);
const mentionMenuOpen = () => menuOpen(mentionMenu);

/** Whichever popover is up, or null. Only ever one — each closes the other. */
function openMenu() {
    if (slashMenuOpen()) return slashMenu;
    if (mentionMenuOpen()) return mentionMenu;
    return null;
}

/** The typed fragment after the slash, or null when this is not a command. */
function slashFragment() {
    const v = dom.input.value;
    return SLASH_RE.test(v) ? v.slice(1) : null;
}

/**
 * Cached per working directory, because that is what decides the answer — every
 * session in a checkout shares a list, so one session's fetch warms the rest.
 */
async function loadSlashCommands() {
    const cur = state.current;
    if (!cur) return [];
    const key = cur.cwd || cur.sessionId;
    const hit = state.slashCommands.get(key);
    if (hit) return hit.commands;

    const r = await get(`/api/slash-commands?session=${cur.sessionId}`);
    const entry = { commands: r.commands || [], at: r.at, exact: r.exact };
    state.slashCommands.set(key, entry);
    // The bridge resolves a cwd that no longer exists to the project directory,
    // so its answer can differ from the summary's. Store both, and the SSE
    // event — which speaks in the bridge's cwd — invalidates the right one.
    if (r.cwd) state.slashCommands.set(r.cwd, entry);
    return entry.commands;
}

// By the name as displayed, rather than by anything cleverer. Sorting a list on
// a key the reader cannot see is how a sorted list comes to look broken — so a
// namespaced command files under its plugin, where the text says it is, and not
// under the command's own name.
const bySlashName = (a, b) => a.name.localeCompare(b.name);

/**
 * Prefix matches first, then anything containing the fragment; alphabetical
 * within each of those.
 *
 * Every match is returned, not a first handful: a bare `/` is a request to see
 * what there is, and a list that stops at eight answers a different question.
 * The menu scrolls, and the keys page through it.
 *
 * The CLI reports its commands in an order of its own — roughly by where each
 * came from — which is no order at all to somebody looking for one. Alphabetical
 * is the only arrangement you can search without reading every row.
 *
 * The two groups are kept apart rather than sorted as one, because ranking a
 * command you are part-way through typing above one that merely contains those
 * letters is worth more than a single unbroken A-to-Z: `/co` should offer
 * `/compact` before `/autocompact`.
 */
function matchSlashCommands(items, frag) {
    if (!frag) return items.slice().sort(bySlashName);
    const q = frag.toLowerCase();
    const pre = [];
    const sub = [];
    for (const c of items) {
        const name = c.name.toLowerCase();
        // Also match the part after the namespace: a plugin command reads as
        // `code-review:code-review` but everyone thinks of it as `/code-review`.
        const tail = name.slice(name.lastIndexOf(':') + 1);
        if (name.startsWith(q) || tail.startsWith(q)) pre.push(c);
        else if (name.includes(q)) sub.push(c);
    }
    return pre.sort(bySlashName).concat(sub.sort(bySlashName));
}

function closeSlashMenu() {
    if (dom.slashMenu.hidden) return;
    dom.slashMenu.hidden = true;
    dom.slashMenu.replaceChildren();
    dom.input.setAttribute('aria-expanded', 'false');
    dom.input.removeAttribute('aria-activedescendant');
    slashMenu.rows = [];
    slashMenu.index = 0;
}

/** Re-read the composer and show, filter or hide the menu to match. */
async function updateSlashMenu() {
    const frag = slashFragment();
    if (frag === null || !state.current) return closeSlashMenu();

    const seq = ++slashMenu.seq;
    const key = state.current.cwd || state.current.sessionId;
    let items = state.slashCommands.has(key) ? state.slashCommands.get(key).commands : null;

    if (!items) {
        // First `/` in this directory. Show the box rather than nothing, so a
        // slow bridge reads as loading instead of as no commands.
        drawSlashMenu(null, 'Loading commands…');
        try {
            items = await loadSlashCommands();
        } catch {
            // Not a toast: the person pressed a key, they did not ask for this.
            if (seq === slashMenu.seq) drawSlashMenu(null, 'Could not load commands.');
            return;
        }
        // Typed on, or moved away, while that was in flight.
        if (seq !== slashMenu.seq) return;
        if (slashFragment() === null) return closeSlashMenu();
    }

    const rows = matchSlashCommands(items, slashFragment() || '');
    // Nothing matches, so there is nothing to choose: get out of the way
    // entirely rather than showing an empty box that also swallows Enter.
    if (!rows.length) return closeSlashMenu();

    slashMenu.rows = rows;
    slashMenu.index = 0;
    drawSlashMenu(rows, null);
}

function drawSlashMenu(rows, note) {
    // Two popovers on screen at once is nobody's intention. Only on the way
    // open: this redraws on every keystroke, and the others are already shut.
    if (dom.slashMenu.hidden) { showBell(false); showNewMenu(false); closeMentionMenu(); }

    // A note is a message, not a list. Clearing the rows behind it matters:
    // otherwise Enter during "Loading…" would accept whatever the *previous*
    // fragment had highlighted, which is not what is on screen.
    if (note) { slashMenu.rows = []; slashMenu.index = 0; }

    dom.slashMenu.replaceChildren(...(note
        ? [el('div', { class: 'menu-note' }, note)]
        : rows.map((c, i) => el('button', {
            class: 'picker-row', type: 'button', role: 'option',
            id: `slash-row-${i}`, tabindex: -1,
            'aria-selected': String(i === slashMenu.index),
            // Keeps the caret in the textarea, so clicking a row neither blurs
            // the box nor fires the blur-to-close below.
            onmousedown: (e) => e.preventDefault(),
            onclick: () => acceptSlashCommand(i),
        },
        el('span', { class: 'name' }, `/${c.name}`),
        c.description ? el('span', { class: 'desc' }, clip(c.description, 90)) : null,
        c.argumentHint ? el('span', { class: 'hint' }, clip(c.argumentHint, 24)) : null,
        ))));

    dom.slashMenu.hidden = false;
    dom.input.setAttribute('aria-expanded', 'true');
    if (rows && rows.length) paintSelection(slashMenu);
    else dom.input.removeAttribute('aria-activedescendant');
}

/**
 * The highlight is a property of the list, never of focus — see below.
 *
 * `.picker-row` and nothing else, so a group heading in the mention menu can sit
 * among the rows without becoming one you can land on.
 */
function paintSelection(menu) {
    const rows = [...menu.node.querySelectorAll('.picker-row')];
    rows.forEach((r, i) => r.setAttribute('aria-selected', String(i === menu.index)));
    const on = rows[menu.index];
    if (!on) return;
    dom.input.setAttribute('aria-activedescendant', on.id);
    on.scrollIntoView({ block: 'nearest' });
}

function moveSelection(menu, delta) {
    const n = menu.rows.length;
    if (!n) return;
    menu.index = ((menu.index + delta) % n + n) % n;   // a menu is a ring
    paintSelection(menu);
}

/**
 * How many rows a Page key should travel: what is actually on screen, less one.
 *
 * Measured rather than assumed, because the menu's height is a CSS decision and
 * a row's height depends on the font — hard-coding a number here would drift
 * from what the eye sees the moment either changes. The overlap of one row is
 * the usual paging convention: it leaves something recognisable behind.
 */
function menuPageSize(menu) {
    const first = menu.node.querySelector('.picker-row');
    if (!first) return 1;
    const rowH = first.offsetHeight || 32;
    return Math.max(1, Math.floor(menu.node.clientHeight / rowH) - 1);
}

/**
 * Page and Home/End clamp rather than wrap.
 *
 * Deliberately unlike the arrows: pressing Page Down at the foot of a long list
 * should settle on the last command, not reappear at the top having skipped
 * everything in between. Wrapping is a nicety when you are stepping one at a
 * time and a way to lose your place when you are moving in chunks.
 */
function jumpSelection(menu, to) {
    const n = menu.rows.length;
    if (!n) return;
    menu.index = Math.max(0, Math.min(n - 1, to));
    paintSelection(menu);
}

/**
 * Put the command in the box — and never send it.
 *
 * One behaviour for every command, including those that take no arguments: a
 * menu that sometimes sends is a menu that fires `/clear` on a mistyped Enter.
 * The trailing space is so that arguments can be typed straight on.
 *
 * The whole value is replaced, which is safe precisely because the menu is only
 * open when the whole value was the fragment. Dispatching `input` rather than
 * calling autoGrow() and saveDraft() by hand runs the listeners that are already
 * wired to the box, so every draft guarantee holds by construction instead of by
 * a second copy of the logic that can drift from the first.
 */
function acceptSlashCommand(i) {
    const c = slashMenu.rows[i == null ? slashMenu.index : i];
    if (!c) return;
    closeSlashMenu();
    dom.input.value = `/${c.name} `;
    dom.input.setSelectionRange(dom.input.value.length, dom.input.value.length);
    dom.input.dispatchEvent(new Event('input'));
    dom.input.focus();
}

/**
 * Keys, on the document in the capture phase.
 *
 * Deliberately not a second listener on the textarea: those run in registration
 * order, so "register ours first" would work today and break silently the day
 * somebody moves a block in this file. Capturing on an ancestor provably runs
 * before any listener on the target, so stopping propagation here reliably keeps
 * Enter-to-send from also firing. The target check keeps this off the queue
 * chips, whose own Enter/Escape map is a few hundred lines up.
 */
document.addEventListener('keydown', (e) => {
    const menu = openMenu();
    if (!menu || e.target !== dom.input) return;
    if (e.isComposing || e.keyCode === 229) return;
    // Open but with nothing to choose — a note, or a list still loading. Every
    // key belongs to the composer then; swallowing Enter here would lose a
    // message to a box that had no answer for it.
    if (!menu.rows.length) return;

    const accept = () => (menu === slashMenu ? acceptSlashCommand() : acceptMention());
    const close = () => (menu === slashMenu ? closeSlashMenu() : closeMentionMenu());

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        moveSelection(menu, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        e.stopPropagation();
        const step = menuPageSize(menu);
        jumpSelection(menu, menu.index + (e.key === 'PageDown' ? step : -step));
    } else if (e.key === 'Home' || e.key === 'End') {
        // Only worth taking while the menu is open, and only because the box it
        // sits on is one line: Home and End in a one-line composer move the
        // caret somewhere it already effectively is.
        e.preventDefault();
        e.stopPropagation();
        jumpSelection(menu, e.key === 'Home' ? 0 : menu.rows.length - 1);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.shiftKey && e.key === 'Tab') return;   // still a way out of the box
        e.preventDefault();
        e.stopPropagation();
        accept();
    } else if (e.key === 'Escape') {
        // Leaves the text exactly as typed. Stopped so it closes the menu rather
        // than whatever Escape means to the panel behind it.
        e.preventDefault();
        e.stopPropagation();
        close();
    }
}, true);

// One listener feeding both, because both are derived from the text rather than
// from a keystroke — see the note above SLASH_RE. Order matters only in that a
// composer holding one slash-word is never also holding an `@` fragment.
dom.input.addEventListener('input', () => { updateSlashMenu(); updateMentionMenu(); });
dom.input.addEventListener('blur', () => { closeSlashMenu(); closeMentionMenu(); });
document.addEventListener('click', (e) => {
    if (e.target.closest('.input-row')) return;
    closeSlashMenu();
    closeMentionMenu();
});

// ── @ mentions ───────────────────────────────────────────────────────────
//
// Typing `@` offers the other Claude sessions running on this machine, so you
// can name one to the agent you are talking to.
//
// Claude Code gives every session a name and an inbox of its own, and an agent
// reaches another with `SendMessage({to: "<name>"})`. **The name is the whole
// address — there is no separate addressing syntax.** So what this menu is for
// is not sending anything; it is getting the exact name into the message,
// because a name spelt approximately reaches nobody and an agent cannot guess
// which of your fourteen sessions you meant.
//
// What is inserted is `@[name]`, and the brackets are load-bearing. They are not
// CLI syntax — nothing parses them, and the agent reads them as prose — but they
// keep session mentions from colliding with `@path/to/file`, which the CLI *does*
// resolve on its own. That leaves the file half of the menu free to insert the
// bare path the CLI already understands, which is why the group headings exist
// before there is a second group to head.
//
// Anchored to the caret rather than to the whole composer value, which is the one
// real difference from the slash menu above. `/` is anchored to the whole value
// because the CLI dispatches on `text.startsWith("/")`, so a command anywhere else
// is prose; `@` carries no such rule and belongs mid-sentence — "ask @[importer]
// whether it has finished" is the normal shape of it.

// The fragment under the caret: an `@` at a word boundary, then the name being
// typed. Spaces are allowed inside the brackets — derived names have none, but
// they are permitted, and a menu that stopped matching at the first space would
// be unusable for one that did.
const MENTION_RE = /(?:^|[\s(])@\[?([^\]\n]*)$/;

// How stale the peer list may be before the picker refetches. Short, because the
// answer is "which sessions are running", and offering one that has since exited
// is offering a message that will not arrive.
const PEERS_TTL_MS = 5_000;

/**
 * The typed fragment and where it starts, or null when the caret is not in one.
 *
 * `start` is the index of the `@`, so accepting can replace exactly the fragment
 * and leave everything either side of it alone.
 */
function mentionFragment() {
    const caret = dom.input.selectionStart;
    // Only with no selection: `@` with a range selected is somebody about to
    // overtype it, not somebody addressing a session.
    if (caret !== dom.input.selectionEnd) return null;
    const before = dom.input.value.slice(0, caret);
    const m = MENTION_RE.exec(before);
    if (!m) return null;
    // m[0] may open with the whitespace that made the `@` a word boundary, and
    // that character is not part of what gets replaced.
    const lead = m[0].startsWith('@') ? 0 : 1;
    return { text: m[1], start: caret - m[0].length + lead };
}

/** Peers, from memory when the answer is fresh enough to still be true. */
async function loadPeers() {
    if (Date.now() - state.peers.at < PEERS_TTL_MS) return state.peers.list;
    const r = await get('/api/peers');
    state.peers.list = r.peers || [];
    state.peers.at = Date.now();
    return state.peers.list;
}

/** A peer by the name that is also its address, or null. */
function peerByName(name) {
    return state.peers.list.find(p => p.name === name) || null;
}

/**
 * Rows for a fragment, as a flat list where each carries the group it belongs to.
 *
 * Flat rather than nested so that the index arithmetic in the shared keyboard map
 * keeps working untouched — headings are drawn between rows but are not rows, and
 * `.picker-row` is what the selection counts.
 *
 * The session you are in is dropped: it is running, so the bridge lists it, but
 * telling an agent to message itself is never the intention.
 */
function matchPeers(peers, frag) {
    const q = frag.trim().toLowerCase();
    const mine = state.current && state.current.sessionId;
    const usable = peers.filter(p => p.sessionId !== mine);

    // Matched on the title and the project as well as the name, because the title
    // is what you remember a session by and the name is what has to be sent.
    // Looking one up by the thing you know is the entire job of this menu.
    const hit = (p) => !q
        || p.name.toLowerCase().includes(q)
        || (p.title || '').toLowerCase().includes(q)
        || (p.project || '').toLowerCase().includes(q);

    // Prefix on the name first — you may be part-way through typing one — then
    // everything else that matches, each alphabetical by what the row shows.
    const byLabel = (a, b) => (a.title || a.name).localeCompare(b.title || b.name);
    const pre = [];
    const rest = [];
    for (const p of usable) {
        if (!hit(p)) continue;
        (q && p.name.toLowerCase().startsWith(q) ? pre : rest).push(p);
    }
    return [...pre.sort(byLabel), ...rest.sort(byLabel)]
        .map(p => ({ group: 'Sessions', peer: p, insert: `@[${p.name}] ` }));
}

function closeMentionMenu() {
    if (dom.mentionMenu.hidden) return;
    dom.mentionMenu.hidden = true;
    dom.mentionMenu.replaceChildren();
    // Only give up the combobox state if the other menu is not the one using it.
    if (!slashMenuOpen()) {
        dom.input.setAttribute('aria-expanded', 'false');
        dom.input.removeAttribute('aria-activedescendant');
    }
    mentionMenu.rows = [];
    mentionMenu.index = 0;
}

/** Re-read the composer and show, filter or hide the menu to match. */
async function updateMentionMenu() {
    const frag = mentionFragment();
    if (frag === null || !state.current) return closeMentionMenu();

    const seq = ++mentionMenu.seq;
    let peers = (Date.now() - state.peers.at < PEERS_TTL_MS) ? state.peers.list : null;

    if (!peers) {
        // Something on screen straight away, because the fetch is a round trip and
        // an `@` that does nothing for a moment reads as an `@` that does nothing.
        drawMentionMenu(null, 'Looking for sessions…');
        try {
            peers = await loadPeers();
        } catch {
            if (seq === mentionMenu.seq) drawMentionMenu(null, 'Could not list sessions.');
            return;
        }
        // Typed on, or moved away, while that was in flight.
        if (seq !== mentionMenu.seq) return;
        if (mentionFragment() === null) return closeMentionMenu();
    }

    const now = mentionFragment();
    if (!now) return closeMentionMenu();

    const rows = matchPeers(peers, now.text);
    if (!rows.length) {
        // A bare `@` with nothing to offer is worth saying, because the reason is
        // interesting — one session running is a normal state, and the silent
        // alternative is a menu that mysteriously never appears. A fragment that
        // matches nothing is just a typo, and gets out of the way.
        if (!now.text.trim()) return drawMentionMenu(null, 'No other sessions are running.');
        return closeMentionMenu();
    }

    mentionMenu.rows = rows;
    mentionMenu.index = 0;
    drawMentionMenu(rows, null);
}

function drawMentionMenu(rows, note) {
    if (dom.mentionMenu.hidden) { showBell(false); showNewMenu(false); closeSlashMenu(); }
    if (note) { mentionMenu.rows = []; mentionMenu.index = 0; }

    const kids = [];
    let group = null;
    (rows || []).forEach((r, i) => {
        if (r.group !== group) {
            group = r.group;
            // Not a `.picker-row`, deliberately: the shared selection code counts
            // those, so a heading that were one would be a row you could land on
            // and press Enter at.
            kids.push(el('div', { class: 'menu-group', role: 'presentation' }, group));
        }
        kids.push(mentionRow(r, i));
    });

    dom.mentionMenu.replaceChildren(...(note ? [el('div', { class: 'menu-note' }, note)] : kids));
    dom.mentionMenu.hidden = false;
    dom.input.setAttribute('aria-expanded', 'true');
    if (rows && rows.length) paintSelection(mentionMenu);
    else dom.input.removeAttribute('aria-activedescendant');
}

/**
 * One session.
 *
 * The title leads and the name follows, because the title is what you are looking
 * for and the name is what gets inserted — showing both is what stops the box
 * filling with something you did not expect. A session with no transcript indexed
 * here has no title, and shows its name alone rather than an empty row.
 */
function mentionRow(r, i) {
    const p = r.peer;
    return el('button', {
        class: 'picker-row', type: 'button', role: 'option',
        id: `mention-row-${i}`, tabindex: -1,
        'aria-selected': String(i === mentionMenu.index),
        onmousedown: (e) => e.preventDefault(),
        onclick: () => acceptMention(i),
    },
    el('span', { class: 'name' }, p.title || p.name),
    el('span', { class: 'desc' }, p.name),
    el('span', { class: 'hint' }, p.project || p.kind || ''),
    );
}

/**
 * Replace the fragment under the caret with the mention, and never send.
 *
 * A splice rather than the whole-value replace the slash menu does, because a
 * mention belongs mid-sentence: the words either side of it are the message.
 */
function acceptMention(i) {
    const r = mentionMenu.rows[i == null ? mentionMenu.index : i];
    const frag = mentionFragment();
    if (!r || !frag) return closeMentionMenu();
    closeMentionMenu();
    insertAt(frag.start, dom.input.selectionStart, r.insert);
}

/**
 * Put a mention in the composer from somewhere other than the menu.
 *
 * Reply on a received message is the caller. It goes to the front rather than to
 * the caret: replying is the first thing the message is for, so the sentence
 * being written is the reply and the name belongs at the start of it.
 */
function insertMention(name) {
    const text = `@[${name}] `;
    if (dom.input.value.startsWith(text)) { dom.input.focus(); return; }
    insertAt(0, 0, text);
}

/**
 * Splice `text` over [from, to) in the composer, caret after it.
 *
 * Dispatching `input` rather than calling autoGrow() and saveDraft() by hand runs
 * the listeners already wired to the box, so every draft guarantee holds by
 * construction instead of by a second copy of the logic that can drift.
 */
function insertAt(from, to, text) {
    const v = dom.input.value;
    dom.input.value = v.slice(0, from) + text + v.slice(to);
    const caret = from + text.length;
    dom.input.setSelectionRange(caret, caret);
    dom.input.dispatchEvent(new Event('input'));
    dom.input.focus();
}

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

dom.newTabRecent.addEventListener('click', () => setPickerTab('recent'));
dom.newTabBrowse.addEventListener('click', () => setPickerTab('browse', { load: true }));

// Two tabs, so both stay in the tab order and the arrows activate on move —
// a roving rule would be machinery for a pair of buttons.
for (const [tab, other] of [[dom.newTabRecent, 'browse'], [dom.newTabBrowse, 'recent']]) {
    tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        setPickerTab(other, { load: other === 'browse' });
        (other === 'browse' ? dom.newTabBrowse : dom.newTabRecent).focus();
    });
}

dom.newMkdir.addEventListener('click', startMkdir);
dom.newMkdirGo.addEventListener('click', submitMkdir);
dom.newMkdirName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitMkdir(); return; }
    // Without stopPropagation the central Escape ladder closes the whole dialog,
    // when all this key meant was "never mind the folder".
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelMkdir(); dom.newMkdir.focus(); }
});

// Typing a path does not walk the tree on every keystroke — that is a request per
// character, and it fights the typist. Enter is the commit, and until it comes the
// pane says plainly that it is showing somewhere else.
dom.newCwd.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    setPickerTab('browse');
    browseTo(dom.newCwd.value.trim());
});
dom.newCwd.addEventListener('input', () => {
    if (state.browse.tab === 'browse') dom.newBrowseNote.textContent = browseNote(state.browse);
});

for (const n of dom.delScrim.querySelectorAll('[data-close-del]')) {
    n.addEventListener('click', closeDelete);
}
dom.delScrim.addEventListener('click', (e) => { if (e.target === dom.delScrim) closeDelete(); });

// ── connect a phone ──────────────────────────────────────────────────────
//
// The bridge hands this page the token in a <meta> tag when the page was fetched
// over loopback (bridge/auth.js injectToken), which is the only reason a link can
// be built here at all — the cookie that actually authenticates is HttpOnly and
// deliberately unreadable.
//
// The host is a guess, and says so. This page is being served on 127.0.0.1, and
// 127.0.0.1 is the one address that is useless to a phone; the bridge cannot know
// what name a proxy in front of it answers to. So: offer the shapes that are
// likely, let them be edited, and explain rather than pretend.

function pairToken() {
    const meta = document.querySelector('meta[name="cs-token"]');
    return meta ? meta.content : null;
}

// Remembered because it is the one thing this dialog cannot work out for itself
// and the one thing that is tedious to retype. localStorage rather than the flags
// file: it is a property of this browser, not of the machine.
const PAIR_HOST_KEY = 'cs.pairHost';

function refreshPairUrl() {
    const token = pairToken();
    const base = dom.pairHost.value.trim().replace(/\/+$/, '');
    if (!token) {
        dom.pairUrl.value = '';
        dom.pairNote.textContent = 'This page was not served over loopback, so it '
            + 'was not given the token. Open the desktop window on 127.0.0.1.';
        return;
    }
    if (!base) {
        dom.pairUrl.value = '';
        dom.pairNote.textContent = 'Enter the address the phone will use.';
        return;
    }
    dom.pairUrl.value = `${base}/pair?token=${token}`;
    dom.pairNote.textContent = pairNote(base);
}

/**
 * What is true about this address, rather than what is generally true.
 *
 * The useful thing to say is almost never "here is how tunnels work" — it is the
 * one step still missing. Reaching a .ts.net name does nothing until
 * `tailscale serve` is pointed at this port, and that is the step people forget,
 * so it is the step this says out loud.
 */
function pairNote(base) {
    const info = state.pairInfo || {};
    const ts = info.tailscale;
    const isTailnet = /^https:\/\/[^/]+\.ts\.net/.test(base);

    // Already proxying to this port, so there is no next step to nag about.
    if (info.served && base === info.served) {
        return 'Already published to your tailnet and pointing at this bridge. The '
            + 'phone needs the Tailscale app and the same tailnet.';
    }

    if (isTailnet && ts && ts.name && base.includes(ts.name)) {
        if (!ts.https) {
            return 'HTTPS certificates are not enabled for this tailnet yet — turn '
                + 'them on in the admin console (DNS → HTTPS Certificates), or the '
                + 'link will not resolve.';
        }
        return 'Publish it first, from a Windows shell: tailscale serve --bg '
            + `--https=443 http://127.0.0.1:${location.port || 45888}`;
    }
    if (isTailnet) {
        return 'A tailnet address. The phone needs the Tailscale app and the same '
            + 'tailnet, and `tailscale serve` must point at this port.';
    }
    if (/^https:/.test(base)) {
        return 'Anything terminating TLS in front of the bridge works. Add its '
            + 'hostname to CLAUDE_SESSIONS_ORIGINS if the origin check refuses it.';
    }
    return 'Plain HTTP: the phone view will work, but it cannot be installed as an '
        + 'app and the service worker will not run.';
}

async function openPair() {
    dom.pairScrim.hidden = false;

    // Only ever real values here. An earlier version offered
    // `https://<machine>.<tailnet>.ts.net` as a datalist entry meaning "type your
    // name over this", and picking it from the dropdown produced a URL with
    // literal angle brackets in it. A suggestion you must correct is worse than
    // none — so the bridge is asked what this machine is actually called, and the
    // list is empty when it cannot say.
    if (!dom.pairHost.value) {
        dom.pairHost.value = localStorage.getItem(PAIR_HOST_KEY) || '';
    }
    refreshPairUrl();
    dom.pairHost.focus();

    try {
        const info = await get('/api/pairing');
        dom.pairHosts.replaceChildren(
            ...info.hosts.map(h => el('option', { value: h.url })));
        // Prefill only if the user has no preference yet: a host they typed and
        // used before is a better answer than a detected one they rejected.
        if (!dom.pairHost.value && info.hosts.length) {
            dom.pairHost.value = info.hosts[0].url;
        }
        state.pairInfo = info;
        refreshPairUrl();
        if (dom.pairHost.value) { dom.pairUrl.focus(); dom.pairUrl.select(); }
    } catch { /* leave the field to be filled in by hand */ }
}

function closePair() { dom.pairScrim.hidden = true; }

dom.btnPair.addEventListener('click', openPair);
dom.pairHost.addEventListener('input', refreshPairUrl);
dom.pairCopy.addEventListener('click', async () => {
    if (!dom.pairUrl.value) { dom.pairHost.focus(); return; }
    // Remembered on use rather than on every keystroke, so a half-typed host does
    // not become the default.
    try { localStorage.setItem(PAIR_HOST_KEY, dom.pairHost.value.trim()); } catch { /* private mode */ }
    dom.pairUrl.select();
    try {
        await navigator.clipboard.writeText(dom.pairUrl.value);
        toast('Pairing link copied');
    } catch {
        // Clipboard access can be refused; the text is selected either way, so
        // Ctrl+C still works and saying so beats a silent failure.
        toast('Could not copy — the link is selected, press Ctrl+C');
    }
});
for (const n of dom.pairScrim.querySelectorAll('[data-close-pair]')) {
    n.addEventListener('click', closePair);
}
dom.pairScrim.addEventListener('click', (e) => { if (e.target === dom.pairScrim) closePair(); });

dom.btnLive.addEventListener('click', () => showLive(!state.live.open));
dom.liveSide.addEventListener('click', () => setDockSide(state.live.dock !== 'side'));
dom.liveFocus.addEventListener('click', () => setFocus(!state.focus));
dom.focusExit.addEventListener('click', () => setFocus(false));
// The dock runs sideways and a mouse wheel only goes up and down.
dom.liveBody.addEventListener('wheel', onDockWheel, { passive: false });
dom.btnDash.addEventListener('click', () => showDash(!state.dash.open));
dom.dashRefresh.addEventListener('click', () => loadDash({ refresh: true }));

dom.btnNotes.addEventListener('click', () => showNotes(!state.notes.open));
dom.notesNotable.addEventListener('click', () => setNotesScope('notable'));
dom.notesAll.addEventListener('click', () => setNotesScope('all'));
dom.notesClear.addEventListener('click', async () => {
    // No confirm: this throws away a record of things that already happened, not
    // the things themselves, and everything in it is derived from transcripts
    // that are still there.
    try {
        await del('/api/notifications');
    } catch (err) {
        toast(`Could not clear the history: ${err.message}`, 'error');
    }
});

// The safe way past the lock: a copy of the conversation with a process of its
// own. sendMessage already does the whole thing — the original keeps running
// wherever it is, and the window follows the fork.
dom.lockFork.addEventListener('click', () => sendMessage({ fork: true }));
dom.lockAnyway.addEventListener('click', () => {
    if (!state.current) return;
    state.lockOverride.add(state.current.sessionId);
    applyRunner(state.runner);   // re-enables the send button, then repaints the lock
    toast('Sending into a session that is running elsewhere. If Claude Code refuses '
        + 'to resume it, your message comes back and the branch is offered again.', 'warn', 8000);
    dom.input.focus();
});

document.addEventListener('keydown', (e) => {
    // The confirm sits over the new-session dialog, so it answers Escape first.
    if (e.key === 'Escape' && !dom.bellMenu.hidden) { showBell(false); dom.btnBell.focus(); return; }
    if (e.key === 'Escape' && !dom.newMenu.hidden) { showNewMenu(false); dom.btnNewMenu.focus(); return; }
    if (e.key === 'Escape' && !dom.delScrim.hidden) { closeDelete(); return; }
    if (e.key === 'Escape' && !dom.pairScrim.hidden) { closePair(); dom.btnPair.focus(); return; }
    if (e.key === 'Escape' && !dom.taskScrim.hidden) { closeTaskDialog(); return; }
    if (e.key === 'Escape' && !dom.newScrim.hidden) { closeNew(); return; }
    if (e.key === 'Escape' && state.dash.open) { showDash(false); return; }
    if (e.key === 'Escape' && state.notes.open) { showNotes(false); return; }
    // Out of focus mode before out of the board: focus mode is the deeper state,
    // and leaving it should not also take the board away.
    if (e.key === 'Escape' && state.focus) { setFocus(false); return; }
    if (e.key === 'Escape' && state.live.open) { showLive(false); return; }
    if (e.key === 'Escape' && state.agent) { closeAgent(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); dom.search.focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); openNew(); }

    // The four things `main` can show. Ctrl rather than a bare digit because
    // the composer is a textarea and these have to work while it has the focus.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && '1234'.includes(e.key)) {
        e.preventDefault();
        if (e.key === '1') { showLive(false); showDash(false); showNotes(false); }
        else if (e.key === '2') showLive(true);
        else if (e.key === '3') showDash(true);
        else showNotes(true);
    }
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

/**
 * Open the window on whatever the address says, which after a refresh is
 * wherever you were.
 *
 * `?view=live` opens on the board and `&focus=1` strips the window down to it —
 * the second-monitor address, a browser window left up all afternoon showing
 * what every agent is doing, with no rail, no composer and no chrome to click
 * past. `session` and `agent` are what make a refresh land where it left off;
 * rememberView has been writing them all along.
 *
 * Deliberately not async. The boot block below is a list of synchronous
 * statements and the first paint must not wait on a transcript fetch, so the
 * session is started and left to arrive.
 */
function restoreView() {
    const q = new URLSearchParams(location.search);
    restoring = true;

    // The arrangement first, so the board is painted once into the shape it is
    // going to keep. setDockSide writes it through to liveDock, which is what a
    // launch at the bare origin reads, so the two cannot be found disagreeing
    // after this. renderLive inside it is a no-op — the board is not open yet.
    if (q.has('dock')) setDockSide(q.get('dock') === 'side');

    // Focus mode has nothing else to show, so it implies the board. Order
    // matters: showLive first, then setFocus, or setFocus turns the board on
    // itself and paints twice. And when the work-in-flight board is up over a
    // live board that was left switched on, the live board has to go on first —
    // showLive clears dash.open, so the other order loses it.
    const dash = q.get('view') === 'dashboard';
    if (q.get('view') === 'live' || q.get('live') === '1' || q.get('focus') === '1') showLive(true);
    if (dash) showDash(true);
    if (q.get('focus') === '1') setFocus(true);

    // The panels are up and the address they came from is untouched, so from
    // here on the ordinary bookkeeping applies: opening the session below runs
    // through beginOpen, which writes the address exactly as it found it.
    restoring = false;

    // Three things can name a conversation and they are not equals. A
    // `#/session/<id>` is a click that happened a second ago — someone pressed a
    // notification — so it beats the address, which is only where this window
    // happened to be before the refresh.
    if (openFromHash()) {
        // A deep link asks for a conversation and focus mode is the one view
        // with none in it, so staying would open the session into a pane
        // paintPanels keeps hidden, and the click would look like it did nothing.
        if (state.focus) setFocus(false);
        return;
    }

    const id = q.get('session');
    if (!id) return;
    const agentId = q.get('agent');
    // Not quiet: the address is the only thing being restored from, and it is in
    // front of you. A conversation that has gone should say so rather than leave
    // an empty window with no account of itself. And keepDash, because the
    // session arriving is the restore finishing, not a session being chosen.
    const opening = openSession(id, { keepDash: true });
    opening.then((ok) => {
        // A failed open never reached beginOpen, so nothing has written the
        // address down; drop the dead id rather than retry it every refresh.
        if (!ok && !state.current) rememberView();
        // `ok` alone is not enough. openSession also answers true when a newer
        // open overtook it, which is exactly what a click during the fetch looks
        // like — and that click's session is not the one this subagent belongs to.
        if (ok && agentId && state.current && state.current.sessionId === id) {
            openAgent(agentId, { quiet: true });
        }
    });
}

// ── go ───────────────────────────────────────────────────────────────────

connect();
loadSessions();
markInstance();
renderBell();
registerWorker();
paintDockButton();      // the remembered arrangement, before anything is drawn
restoreView();          // and where we were, from the address that survived the refresh
primeWaiting();
refreshDevBrowser();
// Nothing to restore here any more: the pane belongs to a session, and the
// first beginOpen is what shows it — for the session it was opened in. The
// window-wide flag this used to read is dropped so it cannot come back.
try { localStorage.removeItem('termOpen'); } catch { /* storage unavailable */ }
setInterval(refreshDevBrowser, 20_000);
// Not while a chip is armed or working: rebuilding the strip there would either
// take back a stop the user is halfway through asking for, or drop the label off
// one already in flight.
setInterval(() => {
    if (state.current && !dom.channels.querySelector('[data-arm="true"], .busy')) loadChannels();
}, 25_000);

// A PR changes under you — a review lands, checks finish — with nothing in this
// session to say so. Matched to the bridge's own minute of cache, so a window left
// open on a conversation costs one `gh pr list` a minute at most.
setInterval(loadPrStatus, 60_000);

// The count on the Dashboard button is the only thing that says there is
// anything to look at, so it is read once at startup — a few seconds in, where
// it cannot slow the first paint of the session list — and then only while the
// board is actually on screen.
setTimeout(() => loadDash(), 3000);
setInterval(() => { if (state.dash.open) loadDash(); }, 60_000);

// Same reasoning for the History badge, and the same delay: the number of things
// that wanted you while this window was shut is the one piece of news the button
// carries, and nothing else would go and find it out.
setTimeout(() => loadNotes(), 3200);

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
