// TGXCode — renderer.
//
// All state lives in the bridge; this file is a view over it. Transcript content
// arrives from one place only (the file tail, pushed over SSE), so a session
// running in somebody's terminal renders identically to one started here.

import { configurePaths } from './markdown.js';
import { TerminalPane } from './terminal.js';
import { PreviewPane } from './preview.js';
import * as keys from './keys.js';
import { drawRail } from './rail.js';
import { get, post, postFile, patch, put, del } from './api.js';
import { PREFS_FALLBACK, BOOT_PREFS, BOOT_HOST, pairToken } from './boot.js';
import { DEFAULT_PERM, state } from './state.js';
import { dom, el, toast, modalUp, closeOnClickOutside } from './dom.js';
import {
    pad, ago, dur, noteHome, shortPath, clip, hhmm,
} from './format.js';
import { loadChannels } from './channels.js';
import { PR_ICON, icon } from './icons.js';
import { pullAndRestart, closeRestart, startFixSession } from './restart.js';
import {
    noteRunner, announceTurn, announceSendFailure, announceAsk,
    askBody, clearAsk, registerWorker, openFromHash,
} from './notifications.js';
import {
    renderQuota, showQuota, loadQuota, applyQuotaSnapshot,
    applyCv, loadCv, showCv,
} from './quota.js';
import { claudeMayLeave, claudeTargetRow, loadClaudeConfig } from './settings/claude-config.js';
import { RAIL_SORTS, settingRow, SETTINGS } from './settings/general.js';
import {
    loadSettings, markSettingsToc, openSettingsAt, renderSettings, saveSetting, settingsProject,
    showSettings,
} from './settings/index.js';
import {
    closeMemoDialog, docsClearDraft, docsRow, loadClaudeDocs, paintMemoDialog, saveClaudeDocs,
} from './settings/memory.js';
import { wireNotifySettings } from './settings/notifications.js';
import { cmdClearDrafts, loadCmdConfig } from './settings/project-commands.js';
import { paintShortcutHints, wireShortcuts } from './settings/shortcuts.js';
import { paintToolbar, showBarMore, wireToolbar } from './settings/toolbar.js';
import {
    answerAsk, answerAskFor, ASK_HEAD, isTyping, openFeedback, refreshAsk, renderAsk,
    resolveAsk, setPlanAside,
} from './transcript/approvals.js';
import {
    closeDiff, collapseChanges, fetchDiff, jumpFromDiff, loadChanges, renderChanges,
    resetChanges, setDiffOpt, showChanges,
} from './transcript/changes.js';
import {
    collapseChecklist, renderChecklist, resetChecklist, showChecklist,
} from './transcript/checklist.js';
import { closeContextMenu, CTX_OWNERS, openContextMenu } from './transcript/context-menu.js';
import {
    AGENT_VIEW, appendEvents, closeRun, isBusy, loadPrStatus, openSession, openSessionSoon,
    renderHeaderActions, SESSION_VIEW,
} from './transcript/conversation.js';
import {
    closeFind, flushFind, gotoHit, hitFromHere, loadFindSubs, markFindDirty, openFind,
    paintFind, stepFind, syncFindSubs,
} from './transcript/find.js';
import { watchPaneInsets } from './transcript/layout.js';
import { closeReview } from './transcript/review.js';
import { renderUser, warmPeers } from './transcript/rows.js';
import {
    agentRows, closeAgent, leaveAgent, loadAgents, openAgent,
} from './transcript/subagents.js';
import {
    actOnSuggestion, closeTaskDialog, firstLine, openTaskDialog, renderTasks, showTasks,
    startSuggestion,
} from './transcript/suggestions.js';
import { toolSummary } from './transcript/tools.js';
import {
    clipLines, flashNode, hideTurnPop, jumpToTurn, markActiveTurn, revealNode,
} from './transcript/turn-rail.js';

// ── settings ─────────────────────────────────────────────────────────────

// Whether a Wispr Flow chord can reach anything from here: the bridge is on the
// Windows host and this page is on the same machine. Asked once at load by
// loadWisprAvailable(), and false until it answers, so nothing is drawn that
// might have to be taken away.
export let wisprAvailable = false;

configurePaths(BOOT_HOST);

// The shortcuts, before anything can be pressed. `keyboard` is user-level only
// (see USER_ONLY in bridge/prefs.js), so BOOT_PREFS is the whole answer and no
// project can move a binding under you mid-session.
keys.apply(BOOT_PREFS.keyboard);

/** The transcript settings in force — the open session's, or the user's own. */
export const grouping = () => (state.prefs || BOOT_PREFS).transcript;

/**
 * A stored hex accent, re-checked here because it is about to become a CSS rule.
 *
 * The bridge validates both of the places these come from — `isAccent` in
 * bridge/snippets.js, which bridge/prefs.js borrows for project colours — and
 * this is the second gate rather than the only one. It is cheap, and the cost of
 * being wrong is a value that closes a declaration and opens whatever follows.
 */
const hexAccent = (v) => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v || '') ? v : '');

/**
 * The colour somebody gave the project a directory belongs to, or ''.
 *
 * **Prefix at a path boundary, longest first.** The map is keyed by project
 * root, and what gets looked up is whatever is in the Start-a-session box — a
 * worktree under `<proj>/.claude/worktrees/`, a subdirectory, or a path that is
 * not a project at all. Matching on the prefix is what lets a worktree wear its
 * checkout's colour without the page needing `projectRootOf`, and it is the rule
 * bridge/snippets.js already argues for in matchesCwd(): the boundary is spelled
 * out so `/home/you/proj` cannot claim `/home/you/project`.
 *
 * Longest wins, so a worktree given a colour of its own keeps it.
 */
export function projectColor(dir) {
    const here = (dir || '').trim().replace(/\/+$/, '');
    if (!here.startsWith('/')) return '';
    let best = '';
    let deepest = -1;
    for (const [root, color] of Object.entries(BOOT_PREFS.projects.colors || {})) {
        if (here !== root && !here.startsWith(`${root}/`)) continue;
        if (root.length <= deepest) continue;
        deepest = root.length;
        best = hexAccent(color);
    }
    return best;
}

/**
 * The wash a project-scoped dialog's backdrop takes, from the user's settings.
 *
 * On the root rather than on #new-scrim, so a second dialog that ever wears a
 * project's colour gets the same answer without being told. Off is an attribute
 * rather than a strength of 0: a 0% mix still lands on the tinted rule's darker
 * `#000000c2`, and "no tint" should mean the plain dim every other dialog has.
 *
 * @param {number} [preview] a strength being dragged, not yet saved
 */
export function paintBackdropTint(preview) {
    const p = BOOT_PREFS.projects;
    const n = preview ?? p.backdropStrength;
    const root = document.documentElement;
    root.style.setProperty('--backdrop-tint', `${Number.isInteger(n) ? n : 13}%`);
    root.toggleAttribute('data-plain-backdrop', p.backdropTint === false);
}
paintBackdropTint();

/**
 * The board's settings — the user's own, and deliberately never `state.prefs`.
 *
 * `state.prefs` is the *open session's* answer, project overrides and all, and
 * the board is the one view that is not about one session: it draws cards from
 * every project on the machine at once. Reading it here would let whichever
 * conversation happens to be open decide how every other project's cards are
 * drawn, which is a setting that appears to change on its own.
 */
const liveCompact = () => BOOT_PREFS.live.compact;
const liveHideElsewhere = () => BOOT_PREFS.live.hideElsewhere;

// Here rather than beside its callers because paintPanels() asks it about
// visibility, and paintPanels runs during boot, well before the section that
// handles the preview's buttons would have been reached.
const previewPane = new PreviewPane({
    root: dom.preview,
    keepAliveMinutes: () => BOOT_PREFS.preview.keepAliveMinutes,
    toast: (text, kind) => toast(text, kind),
    onHome: () => showPreview(false),
    onOutput: (entry) => previewOutput(entry),
    onDevBrowser: (entry) => handToDevBrowser({ port: entry.port, title: entry.title }),
    showDevBrowser: () => devBrowserShown(),
    onMaximize: (on) => { state.preview.max = on; paintPanels(); },
});

// ── drafts ───────────────────────────────────────────────────────────────
// What is typed but not yet sent, and what was sent but never made it into a
// transcript. Neither should be lost to a reload or a failed turn.

const draftKey = (id) => `draft:${id}`;
// A sibling key rather than a richer value under the one above. That one has to stay
// a plain string: handleSendFailure writes into it for a session that is not on
// screen, and every caller there is handling text.
const attachKey = (id) => `attach:${id}`;

export function loadDraft(id) {
    try { return localStorage.getItem(draftKey(id)) || ''; } catch { return ''; }
}

export function saveDraft(id, text) {
    try {
        if (text) localStorage.setItem(draftKey(id), text);
        else localStorage.removeItem(draftKey(id));
    } catch { /* storage unavailable; drafts are best effort */ }
}

/**
 * The files staged against a session, as metadata.
 *
 * This is what makes a staged attachment survive a reload, and it is only possible
 * because the file went to disk before the chip appeared: there is a path to remember
 * instead of bytes to store. Nothing in flight and nothing failed is saved — a chip
 * that is still uploading has no path yet, and one that failed has nothing behind it.
 */
export function loadAttach(id) {
    try {
        const raw = localStorage.getItem(attachKey(id));
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.map(a => ({ ...a, status: 'ready' })) : [];
    } catch { return []; }
}

function saveAttach(id, list) {
    try {
        const keep = (list || [])
            .filter(a => a.status === 'ready')
            .map(({ name, path, relPath, mediaType, bytes }) =>
                ({ name, path, relPath, mediaType, bytes }));
        if (keep.length) localStorage.setItem(attachKey(id), JSON.stringify(keep));
        else localStorage.removeItem(attachKey(id));
    } catch { /* storage unavailable; same best-effort as drafts */ }
}

/**
 * Put text back in the composer without clobbering anything typed since.
 *
 * `files` is for the two callers that are handing a whole message back — a failed turn
 * and a queued chip being edited. Without it, editing a message you had attached a
 * screenshot to would give you the words and quietly drop the screenshot, which is the
 * kind of loss you only notice after sending.
 */
function restoreToComposer(text, files) {
    if (text) {
        const current = dom.input.value.trim();
        dom.input.value = current ? `${text}\n\n${current}` : text;
        autoGrow();
        dom.input.focus();
        dom.input.setSelectionRange(dom.input.value.length, dom.input.value.length);
        if (state.current) saveDraft(state.current.sessionId, dom.input.value);
    }
    if (files && files.length) adoptAttachments(live, files);
}

// ── rail ─────────────────────────────────────────────────────────────────

export async function loadSessions() {
    try {
        const q = state.query ? `?q=${encodeURIComponent(state.query)}` : '';
        const { sessions } = await get('/api/sessions' + q);
        state.sessions = sessions;
        rememberOrder(sessions);
        renderRail();
        // The glyphs are coloured from `state.railPrs`, which the bridge pushes
        // and which survives a re-render — so nothing is fetched here. This used
        // to call `loadRailPrs()` after the paint, which meant a `/api/prs` per
        // `sessions-changed` broadcast on a busy machine.
        // `live` rides on the session list, not on runner-status, so this is the
        // only moment the composer learns that a session started or stopped in a
        // terminal. The registry broadcasts sessions-changed for exactly this.
        paintLock();
    } catch (err) {
        toast(`Could not load sessions: ${err.message}`, 'error');
    }
}

/**
 * Take one word per session's pull requests and recolour the rail.
 *
 * A plain `renderRail()`: web/rail.js reconciles, so rows whose glyph did not
 * change keep their nodes, and hover and focus with them. It is also what moves
 * the Hide finished count, and with `hideDone` on what takes a landed PR's row
 * away.
 *
 * Called with the `prs-changed` payload the bridge pushes, and once at boot with
 * the body of `/api/prs`, which is the same shape — a window that has just opened
 * needs somewhere to start, because the next push may be twenty minutes away.
 */
function applyRailPrs(payload) {
    const before = state.railPrs;
    state.railPrs = new Map(Object.entries((payload && payload.sessions) || {}));
    state.prsError = (payload && payload.gh && payload.gh.error) || null;

    // `dynamic` with PR updates switched on: a session whose answer moved lifts
    // its card. Not on the boot fetch, which is a window catching up rather than
    // anything having happened.
    if (state.prsLoaded) {
        for (const [id, now] of state.railPrs) {
            if (JSON.stringify(now) === JSON.stringify(before.get(id))) continue;
            bumpGroup(state.sessions.find(s => s.sessionId === id), 'pr');
        }
    }
    state.prsLoaded = true;
    renderRail();
}

/** The one fetch of `/api/prs` a window makes: its first paint. */
async function loadRailPrs() {
    try {
        applyRailPrs(await get('/api/prs'));
    } catch {
        // Leaves whatever was known before, which is better than blanking it —
        // the same silence `loadPrStatus` keeps, and for the same reason.
    }
}

export const groupKeyOf = (s) => `project:${s.projectName || 'unknown'}`;

// The sessions that land in a project card, which are the only ones `hideDone`
// filters and the only ones a `dynamic` bump moves the card for. Shared with
// web/rail.js — two copies of this is how the rows and the ordering would come to
// disagree.
export const inProjectCard = (s) => !s.pinned && !s.archived && !s.test;

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
        const isNew = !state.order.has(s.sessionId);
        if (isNew) {
            state.order.set(s.sessionId, firstLoad ? state.order.size : --state.freshRank);
        }
        // Recorded for every session, pinned or not: unpinning one later has to
        // drop it back into a project card that already knows where it goes.
        const key = groupKeyOf(s);
        if (!state.groupOrder.has(key)) {
            state.groupOrder.set(key, firstLoad ? state.groupOrder.size : --state.freshRank);
        }

        // `dynamic` only, and only against what this window has already seen: a
        // first load has nothing to compare with, and is the static order.
        const seen = state.seenTs.get(s.sessionId);
        state.seenTs.set(s.sessionId, { user: s.lastUserTs || null, last: s.lastTs || null });
        if (firstLoad) continue;
        if (isNew) {
            // The search box re-lists too, and a session it turns up from last
            // month is new to this window without being new. Only one that began
            // a moment ago counts as created — and its first line is a message
            // from you, so either switch is enough.
            const born = Date.parse(s.firstTs || '') || s.mtimeMs || 0;
            if (Date.now() - born < FRESH_SESSION_MS) bumpGroup(s, 'create', 'user', 'any');
        } else if (seen) {
            if (tsAdvanced(s.lastUserTs, seen.user)) bumpGroup(s, 'user');
            if (tsAdvanced(s.lastTs, seen.last)) bumpGroup(s, 'any');
        }
    }
}

// How young a session first seen on a later load has to be to count as created
// rather than as found — see rememberOrder.
const FRESH_SESSION_MS = 5 * 60_000;

const tsAdvanced = (now, before) => !!now && (!before || Date.parse(now) > Date.parse(before));

// Which `projects.bumpOn*` switch each reason answers to.
const BUMP_PREF = {
    create: 'bumpOnCreate', user: 'bumpOnUser', any: 'bumpOnAny',
    turn: 'bumpOnTurn', pr: 'bumpOnPr',
};

/**
 * Lift a session's project card to the top of the rail, if the order is
 * `dynamic` and any of `reasons` is switched on.
 *
 * It is the fresh-rank rule rememberOrder already uses for a project nobody had
 * seen — take the next negative rank — so there is no second ordering to keep in
 * step with the first. Only a session drawn in its project card moves the card:
 * one that is pinned, archived or a test is shown somewhere else, and the card
 * jumping for it would be a card moving for no visible reason.
 *
 * Does not render. The callers do, once, after however many bumps they made.
 *
 * @returns {boolean} whether anything moved
 */
function bumpGroup(s, ...reasons) {
    const p = BOOT_PREFS.projects;
    if (p.sort !== 'dynamic' || !s || !inProjectCard(s)) return false;
    if (!reasons.some(r => p[BUMP_PREF[r]])) return false;
    const key = groupKeyOf(s);
    // Already on top: taking another rank would change nothing on screen.
    const top = Math.min(...state.groupOrder.values());
    if (state.groupOrder.get(key) === top) return false;
    state.groupOrder.set(key, --state.freshRank);
    return true;
}

export const rankOf = (s) => state.order.get(s.sessionId) ?? 0;

/**
 * Draw the rail, and the two things outside it that follow what it drew.
 *
 * The drawing is web/rail.js's, which reconciles against the last render rather
 * than rebuilding — so this is cheap to call, and the ~two dozen callers call it
 * whenever anything the rail shows may have changed, without patching rows by
 * hand. Synchronous: a caller can read the rail's DOM as soon as it returns.
 */
export function renderRail() {
    paintHideDone(drawRail());
    // The ⋮ menu is fixed and lives outside the rail, so a card that moved leaves
    // it pointing at where the button used to be.
    syncProjMenu();
}

/**
 * The Hide finished button's own state.
 *
 * `count` is how many sessions are finished, which is the same number whether the
 * filter is on or off — it reads as "hide those 12" before the press and "12 are
 * hidden" after it. Suppressed at zero rather than shown as 0, because nothing to
 * hide is not a quantity worth a glyph in a rail this narrow.
 *
 * Called from `renderRail`, with the number web/rail.js counted while drawing.
 */
function paintHideDone(count) {
    dom.hideDone.setAttribute('aria-pressed', String(state.hideDone));
    dom.hideDoneCount.textContent = String(count);
    dom.hideDoneCount.hidden = !count;
    // Stale while a search is running: the rail is showing everything regardless,
    // so the button says why rather than appearing to have stopped working.
    dom.hideDone.title = state.query && state.hideDone
        ? 'Showing finished sessions too, while the filter box has something in it'
        : 'Hide sessions whose pull requests are all merged or closed';
}

// --- `custom` order: dragging project cards ------------------------------
//
// The toolbar editor's idiom (onBarDragOver, commitBarOrder): the card under the
// cursor moves as the drag goes, and the order it reached is saved when it ends.
//
// The move goes through the render, not round it. `state.railDrag.order` is the
// order the drag has reached, orderGroups() in web/rail.js prefers it to the
// saved one, and each change re-renders — so a session writing mid-drag redraws
// the rail with the card still where the cursor put it, and the carried node is
// the same node throughout, which is what keeps the browser's drag alive. Moving
// the cards by hand here would leave the DOM disagreeing with what Preact last
// rendered.

export function onRailDragStart(e, cwd) {
    state.railDrag = { cwd, order: null };
    closeProjMenu();
    e.dataTransfer.effectAllowed = 'move';
    // Firefox starts no drag without data.
    e.dataTransfer.setData('text/plain', cwd);
    renderRail();   // the card takes `.dragging`
}

export function onRailDragEnd() {
    const drag = state.railDrag;
    state.railDrag = null;
    commitRailOrder(((drag && drag.order) || railCardOrder()).filter(Boolean));
}

function onRailDragOver(e) {
    if (!state.railDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cards = [...dom.rail.querySelectorAll(':scope > .rail-group[data-cwd]')];
    const moving = cards.find(n => n.dataset.cwd === state.railDrag.cwd);
    if (!moving) return;
    const others = cards.filter(n => n !== moving);
    if (!others.length) return;
    const before = others.find((n) => {
        const box = n.getBoundingClientRect();
        return e.clientY < box.top + box.height / 2;
    });
    // Kept among the project cards: past the last one is still above Test and
    // Archived, which never move.
    const order = others.map(n => n.dataset.cwd);
    order.splice(before ? others.indexOf(before) : order.length, 0, moving.dataset.cwd);
    if (order.join('\n') === cards.map(n => n.dataset.cwd).join('\n')) return;
    state.railDrag.order = order;
    renderRail();
}

/** The directories of the project cards on screen, top first. */
const railCardOrder = () => [...dom.rail.querySelectorAll(':scope > .rail-group[data-cwd]')]
    .map(n => n.dataset.cwd).filter(Boolean);

/**
 * Save `visible` — the project cards on screen, in their new order — into
 * `projects.order`.
 *
 * The saved list names more than the rail shows: a search narrows the rail, and
 * a project with no sessions left draws no card. Those keep their places; the
 * visible run goes back in where its first member was, so dragging in a filtered
 * rail rearranges what you can see and nothing else.
 */
function commitRailOrder(visible) {
    const p = BOOT_PREFS.projects;
    const saved = p.order || [];
    const vis = new Set(visible);
    const rest = saved.filter(d => !vis.has(d));
    const first = saved.findIndex(d => vis.has(d));
    const at = first < 0
        ? (p.newAt === 'bottom' ? rest.length : 0)
        : saved.slice(0, first).filter(d => !vis.has(d)).length;
    const next = [...rest.slice(0, at), ...visible, ...rest.slice(at)].slice(0, 500);
    if (next.join('\n') === saved.join('\n')) { renderRail(); return; }
    // Applied here rather than waiting for the `prefs` push, so the card does
    // not snap back for the length of a round trip.
    p.order = next;
    renderRail();
    saveRailPref('order', next);
}

/**
 * Save one `projects` key from the rail rather than from the Settings panel.
 *
 * Not saveSetting(): that writes to whichever scope the panel is showing, and
 * `projects` is user-only, so a panel left on a project would turn a drag into
 * a refusal. The `prefs` push that follows brings every other window — and an
 * open Settings panel — up to date.
 */
async function saveRailPref(key, value) {
    try {
        const answer = await put('/api/prefs', { scope: 'user', patch: { projects: { [key]: value } } });
        if (answer && answer.prefs && answer.prefs.projects) {
            Object.assign(BOOT_PREFS.projects, answer.prefs.projects);
        }
    } catch (err) {
        toast(`Could not save the project order: ${err.message}`, 'error');
    }
    renderRail();
}

/** The ⋮ menu's Move items: the keyboard way to do what dragging does. */
function moveRailCard(cwd, where) {
    const list = railCardOrder();
    const i = list.indexOf(cwd);
    if (i < 0) return;
    list.splice(i, 1);
    const j = where === 'top' ? 0 : Math.max(0, Math.min(list.length, i + where));
    list.splice(j, 0, cwd);
    commitRailOrder(list);
}

export function toggleGroup(key, open, nested) {
    if (nested) {
        state.schedOpen[open ? 'delete' : 'add'](key);
        saveCollapsed();
        return;
    }
    state.collapsed[open ? 'add' : 'delete'](key);
    saveCollapsed();
}

/**
 * The registry entry for a session running somewhere that is not us — a
 * terminal, VS Code, a background agent — or null.
 *
 * `runner` is the test for "ours": the bridge only reports one for a process it
 * started itself, so a session with a live registry entry and no runner is one
 * this window cannot send into without two processes appending to one file.
 */
export function elsewhere(s) {
    if (!s || !s.live || !s.live.running) return null;
    return s.runner ? null : s.live;
}

/** How to describe a session running outside this app, in a sentence. */
export function awayWords(live) {
    const where = WHERE[live.entrypoint] || (live.kind === 'bg' ? 'as a background agent' : null);
    return `Running ${where || `under ${live.entrypoint || 'another client'}`}`
        + ` (pid ${live.pid})`;
}

const WHERE = {
    cli: 'in a terminal',
    vscode: 'in VS Code',
    'sdk-cli': 'under the SDK',
    tgxcode: 'in another TGXCode window',
    // Sessions started before the rename still carry the old entrypoint.
    'claude-sessions': 'in another TGXCode window',
};

// A status in the few words a breakdown line wants — `resolveStatus`'s own labels,
// shortened where a count reads badly in front of them ("1 changes requested").
// Anything missing falls back to the status itself with its hyphen opened out,
// which is already a readable phrase for every status there is; the map exists for
// the two that are not, so a new one added to the bridge degrades rather than
// breaks. The *ranking* is not duplicated here — that stays on the bridge.
const PR_WORDS = {
    changes: 'awaiting changes',
    'checks-failed': 'failing',
    'checks-pending': 'still checking',
    unknown: 'unreachable',
};
export const prWords = (status) => PR_WORDS[status] || status.replace(/-/g, ' ');

/**
 * Why a PR has no status, which is two different things.
 *
 * `unknown` used to mean one: gh could not be reached. It now also covers a PR the
 * bridge has simply not resolved yet — a settled one it has yet to look up, which
 * on a first run is every merged PR on the machine and clears within a pass. So
 * `gh.error` decides, and a tooltip only claims GitHub is unreachable when GitHub
 * actually was. Saying so when it is merely early is the kind of wrong that sends
 * somebody to check their token.
 */
export const prUnknownWhy = () => state.prsError || 'not looked up yet';

function queuedBadge(queued) {
    return el('span', {
        class: 'wait',
        title: `${queued} message${queued === 1 ? '' : 's'} waiting to be sent`,
    }, `+${queued} queued`);
}

/**
 * Toggle pin/archive or set a name, updating in place so the rail doesn't jump
 * under the cursor. The answer's `title` is the name the session now shows —
 * with a name cleared, what the transcript calls it — so it can be copied as is.
 */
export async function setFlags(summary, change) {
    try {
        const r = await post(`/api/sessions/${summary.sessionId}/flags`, change);
        const next = {
            pinned: r.pinned, archived: r.archived, test: r.test,
            ...(r.title ? { title: r.title, titleSource: r.titleSource } : {}),
        };
        Object.assign(summary, next);
        if (state.current && state.current.sessionId === summary.sessionId) {
            Object.assign(state.current, next);
            // Not while a subagent is open: the header is naming the agent then,
            // and the back button picks the new name up on the way out.
            if (r.title && !state.agent) dom.convTitle.textContent = r.title;
            renderHeaderActions();
        }
        renderRail();
    } catch (err) {
        toast(`Could not update the session: ${err.message}`, 'error');
    }
}

// ── rename ───────────────────────────────────────────────────────────────
// A name given from the rail. The bridge keeps it beside the pin, not in the
// transcript, and an empty one hands the session back to what the transcript
// calls it. The draft lives in `state` because web/rail.js re-renders the row on
// every `sessions-changed`, and a draft held anywhere else would be typed over.

export function startRename(summary) {
    // Start from what the row says, so a small correction is a small edit.
    state.railRename = { id: summary.sessionId, draft: summary.title || '' };
    renderRail();
}

export function cancelRename() {
    if (!state.railRename) return;
    state.railRename = null;
    renderRail();
}

export async function commitRename(summary) {
    const r = state.railRename;
    if (!r || r.id !== summary.sessionId) return;
    // Cleared before the request, so the blur that follows Enter finds nothing
    // to commit a second time.
    state.railRename = null;
    const name = r.draft.replace(/\s+/g, ' ').trim();
    const unchanged = name === (summary.title || '').trim();
    renderRail();
    if (unchanged) return;
    // Empty clears the name; an unnamed session asked to be empty is a no-op.
    if (!name && summary.titleSource !== 'user') return;
    await setFlags(summary, { title: name || null });
}

function saveCollapsed() {
    try {
        localStorage.setItem('railCollapsed', JSON.stringify([...state.collapsed]));
        localStorage.setItem('railSchedOpen', JSON.stringify([...state.schedOpen]));
    } catch { /* private mode */ }
}

// ── delete ───────────────────────────────────────────────────────────────
// Archiving is the reversible one and is a click. This is not reversible, so it
// is a click plus an answer to a question that names what is about to go.

export function askDelete(summary) {
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
    saveAttach(sessionId, []);
    setTermOpen(sessionId, false);
    if (state.pendingDelete && state.pendingDelete.sessionId === sessionId) closeDelete();
    if (state.diff.open && state.diff.sessionId === sessionId) closeDiff();
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
    state.plans.clear();
    state.run.length = 0;
    state.prefs = null;     // the next session's project may answer differently
    state.turns = [];
    state.turnTicks = [];
    state.activeTurn = -1;
    state.agents = [];
    state.ask = null;
    clearPendingSend();   // the conversation it was drawn in is gone
    leaveAgent();
    clearInterval(state.busyTimer);
    state.busyTimer = null;
    resetChanges();
    renderChanges();        // hides the drawer: there is no session to be about
    resetChecklist();
    renderChecklist();      // and the same for the task list on the other side
    dom.log.replaceChildren();
    dom.turns.replaceChildren();
    dom.agents.replaceChildren();
    dom.channels.replaceChildren();
    hideTurnPop();
    closeContextMenu({ focus: false });
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
// The transcript itself — rows, tool calls, approvals, the changes drawer, the
// diff viewer, the session's task list, the subagent pane and the width the
// log lays itself out at — is in web/transcript/. It stays imperative on
// purpose: rows are append-only, streamed from SSE, with scroll, width and find
// marks managed by hand. See README.md §Layout for which file holds what.

// ── browser preview ──────────────────────────────────────────────────────
// Every "show me that port" in the app comes through openPreview(), which is
// where Settings → DevBrowser decides whether it means DevBrowser or the
// preview in this window. Before this there was only DevBrowser, and each chip
// posted to it on its own.

/** Whether DevBrowser is part of this app at all — Settings → DevBrowser → Show. */
export const devBrowserShown = () => BOOT_PREFS.devbrowser.show !== false;

/** Whether a click on a port means DevBrowser rather than the preview here. */
const opensInDevBrowser = () => devBrowserShown() && BOOT_PREFS.devbrowser.openIn === 'devbrowser';

/** What clicking a port chip will do, for its tooltip. */
export function openTitle(p) {
    const what = `:${p.port}${p.title ? ` (${p.title})` : ''}`;
    if (opensInDevBrowser()) return `Show ${what} in DevBrowser`;
    if (p.http === false) return `${what} does not answer HTTP — nothing to preview`;
    return `Preview ${what}`;
}

/**
 * Whether a port can be previewed here. The page's `localhost` is this
 * machine's only when the page is served over loopback; a remote browser
 * pointed at the bridge would preview a port on *its* own machine, which is
 * nothing, or worse, something else. DevBrowser is on the bridge's host and
 * would still be right, but the bridge refuses remote callers its routes.
 */
const previewAvailable = () => !state.remote;

/**
 * Show a port — in DevBrowser or here, by Settings.
 *
 * `http: false` is the bridge having asked the port and got no HTTP back; that
 * is a port with nothing a browser can show, so it goes to DevBrowser if
 * DevBrowser is how you look at things (it was always offered there) and
 * otherwise says so rather than opening a blank page.
 *
 * @param {{port:number, title?:string, path?:string, runId?:string,
 *   from?:'live'|'session', http?:boolean, devbrowserTitle?:string}} o
 */
export async function openPreview(o) {
    const db = BOOT_PREFS.devbrowser;
    if (opensInDevBrowser()) {
        const r = await handToDevBrowser({
            port: o.port, path: o.path,
            title: o.devbrowserTitle,
            ifClosed: db.whenClosed === 'launch' ? 'launch' : 'none',
        });
        if (r && r.running === false) {
            if (db.whenClosed === 'inline') return showPortInline(o);
            toast('DevBrowser is not running.', 'info');
        }
        return;
    }
    return showPortInline(o);
}

function showPortInline(o) {
    if (!previewAvailable()) {
        toast('Previews work only in a window on this machine.', 'info');
        return;
    }
    if (o.http === false) {
        toast(`:${o.port} is listening but does not answer HTTP, so there is nothing to preview.`, 'info');
        return;
    }
    previewPane.open({ port: o.port, title: o.title || null, path: o.path || null, runId: o.runId || null });
    showPreview(true, { from: o.from || 'session' });
}

/**
 * Put the preview on screen, or take it off. Off keeps the page loaded for
 * `preview.keepAliveMinutes` — that clock is web/preview.js's.
 */
export function showPreview(on, { from = 'session' } = {}) {
    if (on) {
        closeOtherPanels(null);
        // Decided now and kept: a preview opened from a session and one opened
        // from the board behave the same while you look at them, whatever the
        // setting is changed to underneath.
        state.preview.overLive = from === 'live' ? BOOT_PREFS.preview.overLive !== false : true;
    } else if (state.preview.max) {
        previewPane.setMaximized(false);
    }
    state.preview.open = on;
    paintPanels();
    syncBoardWatch();
    if (!on && liveVisible()) renderLive();
}

/** The task behind a preview, in its terminal tab. */
function previewOutput(entry) {
    if (!entry.runId) return;
    showPreview(false);
    showTerm(true);
    setTermTab(entry.runId);
}

/**
 * DevBrowser's half. Resolves with the bridge's answer, `{running: false}`
 * included, and toasts only what the caller will not.
 */
async function handToDevBrowser({ port, path, title, ifClosed = 'launch' }) {
    try {
        const r = await post('/api/devbrowser/open', {
            port, path: path || undefined, title: title || undefined, ifClosed,
        });
        if (r.launched) toast(`Started DevBrowser and switched to :${port}.`, 'ok');
        return r;
    } catch (err) {
        toast(`Could not switch DevBrowser to :${port}. ${err.message}`, 'error');
        return null;
    }
}

/**
 * Everything that says "DevBrowser" in the window, shown or not by Settings.
 * The pill's 20-second poll stops with it: asking after an app you said you
 * do not use is a request every 20 seconds for nothing.
 */
let devBrowserTimer = null;
export function paintDevBrowserPresence() {
    const on = devBrowserShown();
    paintToolbar();
    clearInterval(devBrowserTimer);
    devBrowserTimer = null;
    if (on) {
        refreshDevBrowser();
        devBrowserTimer = setInterval(refreshDevBrowser, 20_000);
    }
    previewPane.paintToolbar();
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
        state.remote = !!h.remote;
        // Only sent to a local caller, and only a local caller has any use for
        // it: it is the checkout the restart button pulls, and the cwd a session
        // started to sort that checkout out has to run in.
        state.root = h.root || '';
        // The other way in to `homeDir`, and the earlier one: noteHome() reads
        // it off the user prefs file, which arrives well after first paint, so
        // until now a path drawn before that showed all 18 leading characters
        // and then silently shortened. Health answers first and knows the
        // answer, so shortPath is reliable from here rather than eventually.
        if (h.home) noteHome(`${h.home}/.tgxcode/settings.json`);
        // Starting a session that only this instance will list is a development
        // affordance; offering it in the everyday window would be offering to
        // hide a real conversation from the window you are standing in.
        dom.newTestRow.hidden = !state.dev;
        // Restarting the bridge is refused to a remote caller at the route. Not
        // drawing the row is the courtesy on top of that. Rendered rather than
        // set here because the pill's own visibility now turns on `remote` too,
        // and this is the moment that answer arrives — first paint has already
        // happened by the time /api/health comes back.
        renderQuota();
        if (!h.dev) return;
        document.title = `TGXCode — dev :${h.port}`;
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
export function syncBoardWatch() {
    if (state.live.watching === state.live.open) return;
    state.live.watching = state.live.open;
    subscribe();
}

function showLive(on) {
    state.live.open = on;
    // The other way round from showDash: turning the board on gets the
    // whole-screen panels out of the way, since it cannot be read under one.
    // All of them, not just the dashboard — History had the same gap all along
    // and it only became visible once Ctrl+3 had to reach the live board past
    // whatever was already up.
    //
    // Except a panel set to keep the board up (`live.over*`): that one stays, and
    // the board docks beside or under it instead of taking the screen from it.
    if (on && !liveKeptOver()) {
        state.dash.open = false; state.notes.open = false;
        state.taskboard.open = false; state.drafts.open = false;
        state.sched.open = false;
    }
    paintPanels();
    syncBoardWatch();
    syncTaskboardWatch();

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
export function rememberView() {
    if (restoring) return;
    const q = new URLSearchParams();
    if (state.taskboard.open) {
        q.set('view', 'taskboard');
        if (state.live.open) q.set('live', '1');
    } else if (state.dash.open) {
        q.set('view', 'dashboard');
        if (state.live.open) q.set('live', '1');
    } else if (state.drafts.open) {
        q.set('view', 'drafts');
        if (state.live.open) q.set('live', '1');
    } else if (state.sched.open) {
        q.set('view', 'schedules');
        if (state.live.open) q.set('live', '1');
    } else if (state.settings.open) {
        q.set('view', 'settings');
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
    // Only the strip runs sideways. As a column, or with the window to itself, it
    // scrolls the ordinary way and the wheel needs no help at all.
    if (!liveStrip()) return;
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
    paintTaskboardBadge();
    // Not while the work-in-flight board is covering it: the cards would be
    // rebuilt once a second for nobody to look at.
    if (liveVisible()) renderLive();
}

/** Whether the board is actually on screen, rather than merely switched on. */
// Every whole-screen panel, not just the dashboard: a board left switched on
// under one of them is not on screen, and rebuilding it once a second while it
// cannot be seen is what `showDash`/`showTaskboard` catch it up from on the way
// out — unless that panel is one the settings keep the board up over.
export const liveVisible = () => state.live.open
    && (!PANELS.some(p => state[p].open) || Boolean(liveKeptOver()));

/**
 * Whether the board is the sideways strip under a conversation.
 *
 * `state.live.dock` is not this question. It remembers which side you docked to
 * and keeps saying 'bottom' when the board has the whole window, where nothing
 * runs sideways at all — so anything about the arrangement has to ask
 * `data-mode` as well. Both the stripped-down card and the jump's scroll axis
 * want this one.
 */
const liveStrip = () => dom.live.dataset.mode === 'dock' && state.live.dock === 'bottom';

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
export function paintLiveBadge() {
    const waiting = state.waiting.size;
    dom.liveBadge.hidden = !waiting;
    dom.liveBadge.textContent = String(waiting);
    dom.liveBadge.classList.toggle('urgent', waiting > 0);
    dom.btnLive.title = keys.hint(waiting
        ? `${waiting} session${waiting === 1 ? ' is' : 's are'} waiting for you`
        : 'Every session running right now', 'view.live');
}

/** Prime the badge at boot, for asks that were already outstanding. */
async function primeWaiting() {
    try {
        const d = await get('/api/overview');
        state.waiting = new Set(d.sessions.filter(s => s.ask).map(s => s.sessionId));
        paintLiveBadge();
        paintTaskboardBadge();
    } catch { /* the first permission event will start the count off anyway */ }
}

export function renderLive() {
    const d = state.live.data;

    if (!d) {
        dom.liveSub.textContent = 'Asking the bridge what is running…';
        dom.liveBody.replaceChildren(el('div', { class: 'live-note' },
            el('p', {}, 'Asking the bridge what is running…')));
        return;
    }

    // Every arrangement is grouped: "running" against "I merely touched this
    // today" is what makes the board pickable, and that is as true of the grid
    // with the window to itself as of the strip. It was the strip's idea first,
    // which is why it was once the strip's flag.
    //
    // What is still a question about the layout is density — only the bottom
    // strip is short of room. As a column, or full screen, there is height for a
    // fuller card.
    const strip = liveStrip();

    // `live.hideElsewhere`: drop the cards this window has no process for. The
    // test is the one the rail already uses, so the two views cannot disagree
    // about what "not ours" means. `recent` needs no filtering — a session the
    // bridge put in that group is one it found idle, and a session running in a
    // terminal is never idle.
    const sessions = liveHideElsewhere()
        ? d.sessions.filter(s => !elsewhere(s))
        : d.sessions;
    const hiddenAway = d.sessions.length - sessions.length;

    const bits = [];
    if (d.waiting) bits.push(`${d.waiting} waiting for you`);
    // Recounted rather than taken from the payload, which counted the cards
    // before any of them were hidden. Same two reasons the bridge counts.
    bits.push(`${sessions.filter(s => s.reason === 'here' || s.reason === 'elsewhere').length} running`);
    // What the other groups hold, and a way to get to them — the strip's
    // problem first. Five sessions working is 1650px of Live before Recent
    // activity even begins, so a group past the first is not so much missing as
    // unmentioned, and the first thing anybody says is that the section never
    // appeared. A count alone would still leave the scroll to be discovered, so
    // the count is the way there. Full screen the same run of cards is below the
    // fold rather than off the side, which is the same problem lying down.
    const recent = (d.recent || []).length;
    const pinned = sessions.filter(s => s.reason === 'pinned').length;
    if (recent) bits.push(jumpToGroup('recent', `${recent} recent`));
    if (pinned) bits.push(jumpToGroup('pinned', `${pinned} pinned`));
    if (d.hidden) bits.push(`${d.hidden} more not shown`);
    // Said out loud rather than left to look like an empty board — the same
    // promise the cap above makes. A setting that silently removes cards is
    // indistinguishable from a bridge that has stopped noticing them.
    if (hiddenAway) bits.push(`${hiddenAway} elsewhere, hidden`);
    // Interleaved rather than joined: some of these are buttons now.
    dom.liveSub.replaceChildren(...bits.flatMap((bit, i) => (i
        ? [el('span', { class: 'live-sep' }, ' · '), bit]
        : [bit])));

    // Nothing to draw at all — the recent group is a reason to draw the board
    // even with nothing running, and it is drawn in every arrangement now.
    if (!sessions.length && !recent) {
        dom.liveBody.replaceChildren(el('div', { class: 'live-note' },
            // The plain sentence claims the terminals too, so it must not be
            // said when `hideElsewhere` is the reason the board is empty.
            el('p', {}, hiddenAway
                ? `Nothing here is running. ${hiddenAway === 1 ? 'One session is' : `${hiddenAway} sessions are`} `
                    + 'running outside this window, and live.hideElsewhere keeps them off the board.'
                : 'Nothing is running. Every session on this machine is idle, '
                    + 'here and in every terminal.')));
        return;
    }

    // The board is pushed whenever anything moves, which is constantly while
    // agents are working — an activity line changing is enough. What changed is
    // almost always one card, so `liveCardFor` keeps the nodes for the rest and
    // `reconcile` moves only what actually differs. Somebody typing into a card
    // is then untouched in the ordinary case; the save-and-restore below stays
    // as the backstop for the passes that do have to rewrite a whole group.
    const active = document.activeElement;
    const typing = active && active.dataset && active.dataset.sendFor
        ? { id: active.dataset.sendFor, at: active.selectionStart, to: active.selectionEnd }
        : null;
    const scroll = { x: dom.liveBody.scrollLeft, y: dom.liveBody.scrollTop };

    freshCards = [];
    reconcile(dom.liveBody, liveGroups({ ...d, sessions }, strip));
    dom.liveBody.scrollLeft = scroll.x;
    dom.liveBody.scrollTop = scroll.y;

    // Anything not on the board any more, out of both caches — the same
    // discipline `keepOnly` applies on the bridge, and without it a day's worth
    // of cards is held alive by the map alone.
    const live = new Set([...d.sessions, ...(d.recent || [])].map(s => s.sessionId));
    for (const id of state.live.nodes.keys()) if (!live.has(id)) state.live.nodes.delete(id);

    if (typing && document.activeElement !== active) {
        const box = dom.liveBody.querySelector(
            `[data-send-for="${CSS.escape(typing.id)}"]`);
        if (box) {
            box.focus({ preventScroll: true });
            box.setSelectionRange(typing.at, typing.to);
        }
    }

    // Sizing a composer means writing a height, reading `scrollHeight` and
    // writing again — a forced synchronous layout, of a document that also
    // holds the whole open transcript. Doing that per card per second is what
    // made the board unusable beside a large session. Only a box that is both
    // newly built and carrying a restored draft needs it: an empty one is the
    // height its single row gives it, and one that survived the pass already
    // has its height. Reads are batched between the writes so the run costs one
    // layout rather than one each.
    const boxes = [];
    for (const node of freshCards) {
        const box = node.querySelector('.lsend-box');
        if (box && box.value) boxes.push(box);
    }
    if (boxes.length) {
        for (const box of boxes) box.style.height = 'auto';
        const heights = boxes.map(box => Math.max(30, Math.min(84, box.scrollHeight)));
        boxes.forEach((box, i) => { box.style.height = `${heights[i]}px`; });
    }
}

/**
 * The cards built during the current pass, for the one thing that has to
 * measure them after they are on screen.
 */
let freshCards = [];

/**
 * One card, reused when the bridge says it has not changed.
 *
 * Every card carries a `sig` — a hash of its own contents, from `fingerprint` in
 * bridge/overview.js. So a push where one agent moved is a push where every other
 * card is byte-identical to the one already on screen, and keeping those nodes is
 * most of what makes the board affordable: `liveCard` builds thirty-odd elements
 * with a listener on several of them, and building all of them once a second,
 * beside a document that also holds the whole open transcript, was the cost.
 *
 * `strip` is part of the key because it changes what `liveCard` draws — a dock
 * that has just been moved must not be served cards cut for the other shape.
 */
function liveCardFor(s, strip) {
    const prev = state.live.nodes.get(s.sessionId);
    if (prev && prev.sig === s.sig && prev.strip === strip) return prev.node;

    const node = liveCard(s, strip);
    state.live.nodes.set(s.sessionId, { sig: s.sig, strip, node });
    freshCards.push(node);
    return node;
}

/**
 * Put `next` into `parent`, moving as few nodes as possible.
 *
 * Deliberately not `replaceChildren`: re-parenting a node blurs anything focused
 * inside it, so a wholesale swap takes the caret out of a card composer on every
 * push. Where the only difference is that some positions hold a freshly built
 * node, those positions are swapped and the rest are left alone.
 *
 * A node already mounted in this parent turning up at a different index means
 * the order changed rather than the contents, and an in-place swap would drop a
 * card on the floor — so that falls back to the rewrite. It is rare, and when
 * the order changes the board has visibly moved anyway.
 */
function reconcile(parent, next) {
    const cur = parent.children;
    if (cur.length === next.length) {
        const swaps = [];
        let inPlace = true;
        for (let i = 0; i < next.length; i++) {
            if (cur[i] === next[i]) continue;
            if (next[i].parentNode === parent) { inPlace = false; break; }
            swaps.push([next[i], cur[i]]);
        }
        if (inPlace) {
            for (const [to, from] of swaps) parent.replaceChild(to, from);
            return;
        }
    }
    parent.replaceChildren(...next);
}

/**
 * A count in the subtitle that takes you to the group it counts.
 *
 * `scrollIntoView` along whichever axis the board is arranged in — the group is
 * off to the right in the strip and further down in the column or the
 * full-window grid, and asking for the wrong one moves nothing. Which is why
 * the axis comes from `liveStrip()` and not from `state.live.dock`: that still
 * reads 'bottom' with no conversation open, so an inline scroll was requested
 * down a board that only scrolls vertically.
 */
function jumpToGroup(key, label) {
    return el('button', {
        class: 'live-jump', type: 'button',
        title: `Show the ${label.replace(/^\d+ /, '')} group`,
        onclick: () => {
            const group = dom.liveBody.querySelector(`.live-group[data-group="${key}"]`);
            if (!group) return;
            group.scrollIntoView(liveStrip()
                ? { behavior: 'smooth', inline: 'start', block: 'nearest' }
                : { behavior: 'smooth', block: 'start', inline: 'nearest' });
        },
    }, label);
}

/**
 * The board in three parts — along the strip, down the column, or down the page.
 *
 * Pinned and running are already known — they are the reasons the bridge sorts
 * the board by — so those two groups are that one list cut in two rather than a
 * second opinion about it, and the needs-you-first order inside each survives
 * the cut. Recent is the array the bridge sends beside it.
 *
 * Empty groups are dropped rather than shown empty: three headings over one card
 * is mostly headings, and the strip has no room to spare for them.
 */
function liveGroups(d, strip) {
    const live = d.sessions.filter(s => s.reason !== 'pinned');
    const pinned = d.sessions.filter(s => s.reason === 'pinned');
    const recent = d.recent || [];

    const shown = [
        // Only `recent` carries its own overflow. `hidden` is the board's cap
        // biting, and it bites the bottom of the rank order — pinned before
        // running — so the payload cannot say which of these two groups lost a
        // card, and the subtitle above already reports the number for the board
        // as a whole.
        ['live', 'Live', live, 0],
        ['recent', 'Recent activity', recent, d.recentHidden],
        ['pinned', 'Pinned', pinned, 0],
    ].filter(([, , list]) => list.length);

    const sections = shown.map(([key, label, list, hidden]) =>
        liveGroup(key, label, list, hidden, strip));

    // A group that has emptied — the last thing you touched today falling out
    // of the recent window — must not keep its section and its cards alive.
    const keys = new Set(shown.map(([key]) => key));
    for (const key of state.live.groups.keys()) {
        if (!keys.has(key)) state.live.groups.delete(key);
    }
    return sections;
}

/**
 * One headed segment of the board, kept between passes.
 *
 * The section and its heading are built once and then written to, rather than
 * rebuilt: they are what the cards hang under, and a card that is re-parented
 * loses the focus inside it however unchanged it is. So the containers stay put
 * and `reconcile` decides what moves within them.
 */
function liveGroup(key, label, list, hidden, strip) {
    let g = state.live.groups.get(key);
    if (!g) {
        const count = el('span', { class: 'lgroup-count' });
        // Same promise the subtitle makes about the board as a whole: what fell
        // off the end is reported, because a list that silently stops reads as
        // the end of the list.
        const more = el('span', { class: 'lgroup-more' });
        const body = el('div', { class: 'lgroup-body' });
        g = {
            count,
            more,
            body,
            section: el('section', { class: 'live-group', 'data-group': key },
                el('h2', { class: 'lgroup-head' },
                    el('span', { class: 'lgroup-label' }, label), count, more),
                body),
        };
        state.live.groups.set(key, g);
    }

    g.count.textContent = String(list.length);
    g.more.textContent = hidden ? `+${hidden} more` : '';
    g.more.hidden = !hidden;
    reconcile(g.body, list.map(s => liveCardFor(s, strip)));
    return g.section;
}

/**
 * One session, as a card.
 *
 * Deliberately built from the same pieces as the rail row — queuedBadge, ago,
 * clip (web/rail.js keeps a vnode twin of the badge) — rather than a second
 * vocabulary for the same facts.
 * The risk with a view like this is two renderers of one state drifting apart,
 * and sharing the small parts is what keeps them honest.
 */
function liveCard(s, strip = false) {
    const r = s.runner;
    const busy = r && (r.state === 'busy' || r.state === 'starting');
    const away = s.live && s.live.running && !r;
    // In the bottom strip every row a card gives up is a row of transcript, so
    // it drops what is duplicated elsewhere: one line of history, and the Open
    // button — the title above it already opens the session, and the rail is
    // right there. Beside the conversation there is height to spare and the
    // fuller card is free.
    const lines = strip ? 2 : HEADLINES_SHOWN;
    // A different question, and a settings one rather than a layout one: how
    // much of a card there is to draw at all. Everything below the facts line
    // is optional, and `live.compact` says it is not wanted — in every
    // arrangement, strip or column or full screen. See liveCompact().
    const compact = liveCompact();

    return el('article', {
        class: 'lcard', 'data-reason': s.reason, 'data-id': s.sessionId,
        'data-compact': compact ? '1' : null,
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
            ...(s.devservers || []).map(d => devChip(d, s)),
            el('span', { class: 'lcard-ago' }, ago(s.lastTs)),
        ),

        // Below here is everything `live.compact` takes away — the approval row
        // with the rest of it. Losing that one is the real cost of the setting,
        // since answering is what the board is for; the card still says it is
        // asking, in its status words and in its coloured edge, and clicking it
        // goes to where the question can be answered.
        (compact || !s.ask) ? null : liveAsk(s),

        (compact || !s.headlines.length) ? null : el('ol', { class: 'lcard-log' },
            s.headlines.slice(-lines).map(h => el('li', { title: h.text }, clip(h.text, 74)))),

        compact ? null : cardComposer(s, busy, away),

        (!compact && (!strip || busy)) ? el('div', { class: 'lcard-acts' },
            strip ? null : el('button', {
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
    // The same rule as the main composer, from the same setting: a card's box is
    // a composer with less room, and having Enter mean two different things
    // depending on which box you are in would be worse than either mode.
    box.addEventListener('keydown', (e) => {
        if (!enterSends(e)) return;
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
 * A port this session has something answering on, as a chip that shows it —
 * in DevBrowser or in the preview, by Settings.
 *
 * Not the channel strip's `openInDevBrowser`, which writes progress into a
 * separate "Open" button it is given — handing it the chip's own label made a
 * successful click rename `:5006` to `Open`.
 */
function devChip(d, s) {
    return el('button', {
        class: 'lchip', type: 'button',
        title: openTitle(d),
        onclick: async (e) => {
            const chip = e.currentTarget;
            chip.classList.add('busy');
            chip.disabled = true;
            try {
                // Over the board, or over that card's session as though it had
                // been opened and the chip clicked there — preview.overLive.
                const overLive = BOOT_PREFS.preview.overLive !== false;
                if (!overLive && !opensInDevBrowser() && s && d.http !== false
                    && (!state.current || state.current.sessionId !== s.sessionId)) {
                    await openSession(s.sessionId);
                }
                await openPreview({
                    port: d.port,
                    title: d.title || null,
                    // Name the tab if the transcript knew what it was and
                    // DevBrowser did not.
                    devbrowserTitle: d.owned ? undefined : d.title || undefined,
                    http: d.http,
                    from: overLive ? 'live' : 'session',
                });
            } catch (err) {
                toast(`Could not open :${d.port}. ${err.message}`, 'error');
            } finally {
                chip.classList.remove('busy');
                chip.disabled = false;
            }
        },
    }, `:${d.port}`, d.title ? el('i', {}, clip(d.title, 16)) : null);
}

export function taskBar(t) {
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

// The whole-screen panels, named by the state slice each one lives in, in the
// order the bar and the Ctrl ladder read them. The live board is not one of
// them: it docks under the conversation and is *covered* by these rather than
// exclusive with them, which is why it is absent here and handled on its own
// below.
//
// One at a time, so every show…() has to close the rest. That used to be four
// assignments repeated inside five functions, which is exactly the shape that
// goes wrong when a sixth arrives: adding Settings would have meant editing
// five other functions, none of which would have complained about being missed.
const PANELS = ['taskboard', 'dash', 'notes', 'drafts', 'sched', 'settings'];

// Which `live.*` key says whether the board stays up over each panel.
const LIVE_OVER_KEY = {
    taskboard: 'overTasks', dash: 'overDashboard', notes: 'overHistory',
    drafts: 'overDrafts', sched: 'overSchedules', settings: 'overSettings',
};

/**
 * The open panel, if the settings keep the board on screen over it.
 *
 * Asked of the dock toggle as it stands, which is the point of `side` and
 * `stacked`: the one button in the board's header then decides whether the
 * board comes along to that panel as well as how it sits there. Answers whether
 * or not the board is switched on — showLive asks before turning it on.
 */
function liveKeptOver() {
    const panel = PANELS.find(p => state[p].open);
    if (!panel) return null;
    const rule = BOOT_PREFS.live[LIVE_OVER_KEY[panel]];
    const side = state.live.dock === 'side';
    const kept = rule === 'always' || (rule === 'side' && side) || (rule === 'stacked' && !side);
    return kept ? panel : null;
}

/** Shut every whole-screen panel but this one. */
export function closeOtherPanels(keep) {
    for (const p of PANELS) if (p !== keep) state[p].open = false;
}

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
export function paintPanels() {
    // The board docks under the conversation rather than replacing it: the
    // reason to watch five agents is usually that you are working in one of
    // them, and having to choose between the two made you keep switching. It
    // takes only the height its cards need — one row, scrolled sideways when
    // there are more than fit — and the conversation keeps everything else.
    //
    // With nothing open, or in focus mode, there is no conversation to share
    // with and the board has the floor.
    //
    // Six whole-screen panels, kept exclusive by closeOtherPanels, so "one of
    // them is up" is the only thing anything below has to ask. One of them
    // normally covers the board; a panel the `live.over*` settings keep it up
    // over gets the board docked beside or under it instead, exactly as a
    // conversation does — focus mode or not, since the panel is on screen.
    const covered = PANELS.some(p => state[p].open);
    const kept = state.live.open && Boolean(liveKeptOver());
    const docked = state.live.open && (kept || (Boolean(state.current) && !state.focus));
    const full = state.live.open && !docked;

    // What the board was drawn for, so that a panel opened over it with the
    // board kept can tell it has been re-arranged. The show…() functions only
    // catch the board up on the way *out* of a panel, and a board that goes
    // from the whole window to a column beside Tasks needs its cards rebuilt.
    const drawnFor = `${dom.live.hidden}/${dom.live.dataset.mode}/${dom.main.dataset.dock}`;

    // The preview sits between the two: it covers the conversation as a panel
    // would, and is itself covered by one. A docked board stays beside it unless
    // this preview was opened to go over the board (preview.overLive), and a
    // full-height board has nowhere to go but under it.
    const preview = state.preview.open && !covered;
    const liveUnder = preview && (state.preview.overLive || !docked || state.preview.max);

    for (const p of PANELS) dom[p].hidden = !state[p].open;
    dom.preview.hidden = !preview;
    dom.live.hidden = !state.live.open || (covered && !kept) || liveUnder;
    dom.live.dataset.mode = docked ? 'dock' : 'full';
    // The orientation lives on both: `main` has to change its flex direction,
    // and the board has to know whether it is a strip or a column.
    dom.live.dataset.dock = state.live.dock;
    dom.main.dataset.dock = docked && !liveUnder ? state.live.dock : 'bottom';
    // The conversation stays up under a docked board; a whole-screen panel
    // still covers it.
    dom.conv.hidden = covered || preview || full || !state.current;
    dom.placeholder.hidden = covered || preview || state.live.open || Boolean(state.current);
    // Maximize belongs to the preview being on screen, not to the preview
    // existing: opening Settings over it has to bring the rail back.
    if (preview && state.preview.max) dom.app.dataset.previewMax = '1';
    else delete dom.app.dataset.previewMax;
    previewPane.setVisible(preview);
    // Nothing to find in a conversation that is not on screen — and this is what
    // lets the Escape ladder put find below the panels without them overlapping.
    if (dom.conv.hidden) closeFind();

    for (const [btn, on] of [[dom.btnDash, state.dash.open], [dom.btnLive, state.live.open],
        [dom.btnNotes, state.notes.open], [dom.btnTaskboard, state.taskboard.open],
        [dom.btnDrafts, state.drafts.open], [dom.btnSched, state.sched.open],
        [dom.btnSettings, state.settings.open]]) {
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
    }
    // The conversation's box just changed height, and xterm only knows what it
    // is told.
    if (state.current && !dom.conv.hidden) termPane.refit();
    if (kept && drawnFor !== `${dom.live.hidden}/${dom.live.dataset.mode}/${dom.main.dataset.dock}`) {
        renderLive();
    }
}

export function showDash(on) {
    state.dash.open = on;
    if (on) closeOtherPanels('dash');
    // The live board is not closed by this, only covered. It is a strip you
    // leave up; the work-in-flight board is a whole screen you go and read and
    // then come back from, and coming back should find things as you left them.
    paintPanels();
    syncBoardWatch();
    syncTaskboardWatch();

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
export function paintDashBadge() {
    const d = state.dash.data;
    const rows = d ? d.projects.reduce((n, p) => n + p.workspaces.length, 0) : 0;
    dom.dashBadge.hidden = !rows;
    dom.dashBadge.textContent = String(rows);
    dom.btnDash.title = keys.hint(rows
        ? `${rows} ${rows === 1 ? 'place has' : 'places have'} uncommitted changes or an open pull request`
        : 'Uncommitted changes and open pull requests, by project', 'view.dashboard');
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

    const accent = projectColor(p.cwd);

    return el('section', {
        class: 'dproj',
        'data-tinted': accent ? '1' : null,
        style: accent ? `--proj-accent: ${accent}` : null,
    },
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

    // The same one word, glyph and colour the header and the rail use. This used
    // to read `draft` and `reviewDecision` off the raw record and draw its own
    // conclusions, which meant a merged PR, one conflicting with its base and one
    // with a failing build were three identical blue chips here while the other
    // two surfaces showed three different glyphs. The bridge resolves `status`
    // now, so there is one PR vocabulary in the app rather than two.
    for (const pr of w.prs) {
        const status = pr.status || 'unknown';
        signals.push(el('a', {
            class: 'sig pr', 'data-status': status,
            href: pr.url, target: '_blank', rel: 'noreferrer',
            title: [
                pr.label || prWords(status),
                pr.title,
                `${pr.url}\nopened by ${pr.author || 'someone'}, `
                    + `updated ${ago(pr.updatedAt)} ago`,
            ].filter(Boolean).join('\n'),
        },
            icon(PR_ICON[status] || 'pr', 12),
            el('span', { class: 'pr-num' }, `#${pr.number}`),
            el('span', { class: 'pr-title' }, clip(pr.title, 46)),
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

export function statusWord(xy) {
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
    handoff: 'Handed work',
    'schedule-findings': 'Scheduled review',
    'schedule-failed': 'Schedule failed',
    'schedule-missed': 'Schedule missed',
    // Both always carry a sessionId, unlike two of the three above: a scheduled
    // message is written against a session that exists, so there is always
    // somewhere for the row to open.
    'later-failed': 'Message not delivered',
    'later-missed': 'Message missed',
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
    if (on) closeOtherPanels('notes');
    else state.notes.mark = null;
    paintPanels();
    syncBoardWatch();
    syncTaskboardWatch();

    if (on) {
        // Opening History still means "I have seen all this" — but the rows have
        // to go on *looking* like what was new, or the unread marking is a state
        // no eye ever sees. So the watermarks are photographed on the way in and
        // the list renders against the photograph, while the badge clears from
        // the real thing. The photograph is thrown away on the way out.
        state.notes.mark = {
            all: state.notes.read.all,
            sessions: { ...state.notes.read.sessions },
        };
        // Marked *after* the fetch rather than alongside it. Fired together, the
        // two race, and a GET that lands second overwrites the badge the POST
        // just cleared — which reads as "opening History no longer clears it".
        if (Date.now() - state.notes.at > NOTES_STALE_MS) loadNotes().then(markNotesSeen);
        else { renderNotes(); markNotesSeen(); }
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
        state.notes.read = data.read || { all: 0, sessions: {} };
        state.notes.unread = data.unread || 0;
        state.notes.at = Date.now();
        await migrateNotesSeen();
        // Catch up the conversation already on screen.
        //
        // markSessionNotesRead can only act on rows it has, and at boot it has
        // none: restoreView opens a session immediately and the log is not
        // fetched until three seconds later. That gap is exactly the path that
        // matters most — a notification clicked when no window was open arrives
        // as `#/session/<id>` and opens the session before anything else runs, so
        // without this the one click that should certainly clear a row is the one
        // click that never did.
        markSessionNotesRead(state.current && state.current.sessionId);
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
 * Whether a row is still news.
 *
 * A watermark per conversation, with `all` as a floor under all of them. The
 * bridge computes the same thing and stamps `read` on every row it hands over —
 * this exists for the rows that arrive afterwards, over SSE, and for the moment
 * between a mark-read and the response landing.
 *
 * `marks` is which set to ask, and the two callers want different ones: the badge
 * wants the truth, and the open panel wants the snapshot taken when it opened.
 * See showNotes for why those differ.
 */
function noteUnread(row, marks = state.notes.read) {
    return row.at > Math.max(marks.all, marks.sessions[row.sessionId] || 0);
}

/**
 * How many things are still waiting to be dealt with.
 *
 * Counted over the loud rows only: a badge is an interruption in its own right,
 * and a six-second turn finishing is not one.
 *
 * The number comes from the bridge, which counts the whole log. Counting it here
 * is the fallback for the moment before the first fetch lands, and it is only a
 * fallback because it can only see the rows that were fetched — which is how this
 * badge used to work, and why it stopped being true past 300 rows.
 */
export function paintNotesBadge() {
    const n = state.notes.at
        ? state.notes.unread
        : state.notes.rows.filter(r => r.loud && noteUnread(r)).length;
    dom.notesBadge.hidden = !n;
    dom.notesBadge.textContent = String(n);
    dom.btnNotes.title = keys.hint(n
        ? `${n} ${n === 1 ? 'notification' : 'notifications'} you have not dealt with`
        : 'Everything that has reached out to you', 'view.history');
}

/**
 * Tell the bridge something has been seen, and take the new badge back.
 *
 * `{all: true}` is the History panel being opened; `{sessionId}` is a
 * conversation being opened. Applied locally before the round trip so the badge
 * moves with the click rather than a moment after it — the bridge's reply is
 * authoritative and overwrites this, but it agrees with it.
 *
 * Failure is deliberately quiet. The worst case is a badge that stays up, and a
 * toast about a badge would be a worse interruption than the badge is.
 */
async function markNotesRead(what) {
    const at = Date.now();
    if (what.all) state.notes.read.all = Math.max(state.notes.read.all, at);
    else state.notes.read.sessions[what.sessionId] = at;
    if (state.notes.open) renderNotes();
    paintNotesBadge();
    try {
        const r = await post('/api/notifications/read', what);
        state.notes.read = r.read;
        state.notes.unread = r.unread;
    } catch { /* the badge is not worth a toast */ }
    if (state.notes.open) renderNotes();
    paintNotesBadge();
}

/** Opening History says you have seen everything, and always has. */
const markNotesSeen = () => markNotesRead({ all: true });

/**
 * Going to a conversation says you have seen what it filed.
 *
 * Guarded on there being something to clear, because this hangs off openSession
 * and openSession is every navigation in the app — without the guard, clicking
 * down the rail would be one POST per row and one repaint in every other window.
 */
export function markSessionNotesRead(sessionId) {
    if (!sessionId) return;
    const rows = state.notes.rows;
    // Before the first fetch there are no rows to check, so nothing can be known
    // to be unread and nothing is posted. The badge is empty then anyway.
    if (!rows.some(r => r.loud && r.sessionId === sessionId && noteUnread(r))) return;
    markNotesRead({ sessionId });
}

/**
 * The one-time move off the old localStorage watermark.
 *
 * Read state used to be a single `notesSeenAt` in this browser. Without carrying
 * it over, the first load after the bridge took the job over shows every loud row
 * of the last fortnight as unread — a badge in the hundreds, for a log you have
 * already been through. Carried over once, then the key goes.
 */
async function migrateNotesSeen() {
    const legacy = Number(localStorage.getItem('notesSeenAt')) || 0;
    if (!legacy) return;
    localStorage.removeItem('notesSeenAt');
    if (legacy <= state.notes.read.all) return;
    try {
        const r = await post('/api/notifications/read', { all: legacy });
        state.notes.read = r.read;
        state.notes.unread = r.unread;
    } catch { /* it will simply look unread; the key is gone either way */ }
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
        // What the badge was counting when this panel opened, marked so the
        // number is traceable to rows. Quiet rows are never counted, so they are
        // never marked either.
        'data-unread': String(n.loud && noteUnread(n, state.notes.mark || state.notes.read)),
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
    // **Not every row is about a session.** A schedule that missed its slot, or
    // could not resolve its ref, never produced one — and those are the rows most
    // worth clicking. Sending `null` to openSession closed the panel and reported
    // "session not found", which reads as the notification being broken rather
    // than as there being nothing to open. The schedules panel is where the rest
    // of the story is, so go there instead.
    if (!n.sessionId) {
        if (String(n.type).startsWith('schedule-')) showSched(true);
        return;
    }
    pendingJump = n.anchorId || null;
    showNotes(false);
    openSession(n.sessionId);
}

export function takePendingJump() {
    const id = pendingJump;
    pendingJump = null;
    if (!id) return;
    const entry = state.tools.get(id);
    // Gone from the transcript, or never in it: the session is open and scrolled
    // to the end, which is the honest fallback rather than a guess.
    if (entry) jumpToTurn(entry);
}

// ── task board ───────────────────────────────────────────────────────────
// Everything outstanding, in four columns.
//
// The other three views each answer a narrower question and none of them
// answers this one. The rail is one conversation at a time. The live board is
// only what is running this second — a session that finished an hour ago has no
// card there and never will. A suggested follow-up used to be visible only while
// the conversation that raised it was open, which meant the app's own mechanism
// for handing work forward could only be read by going and looking for it.
//
// So: open tasks beside every un-archived session, grouped by what state it is
// in, with needs-you first because that is why you looked.
//
// **Nothing on it moves while you are reading.** This is the constraint that
// shapes the whole renderer, and it is the rail's rule for the rail's reason —
// see docs/manual.md, "The rail is sorted on load, and then left alone". A board of
// agents working would otherwise reshuffle every three seconds under the cursor
// of somebody trying to read one card. So position within a column is taken once
// and then held, and the only thing that moves a card is changing column, which
// is news rather than noise.
//
// **One payload for the whole board.** The `taskboard` SSE event, on a three-
// second tick the bridge only runs while somebody is watching, and only sends
// when the answer actually moved. Nothing here fetches per card.
//
// **Focus is the fifth state the board can be in**, and the only one the four
// columns cannot express. A backlog of suggested tasks outgrows its column long
// before any of the other three fills up — they are bounded by how many sessions
// exist, and that one is bounded by how many follow-ups every agent has ever
// raised. So the Suggested head carries a Focus button: press it and the other
// three columns go, and the tasks spread across the whole width one column per
// project, with a search box over them in the header.
//
// It borrows the drafts panel's machinery rather than growing its own, because
// that panel already answers the same question — a variable number of project
// columns built out of this board's `.tb-col` chrome. `tbFocusGroups` is
// `draftGroups` and `tbProjectColumn` is `draftColumn`; `.tb-body.cols` is
// `.dr-body.cols`. The one thing that is this board's and not that one's is that
// the rows still go through `tbHold` first, so a card cannot move under the
// cursor here either.

/** Tell the bridge whether this window is watching the task board. */
export function syncTaskboardWatch() {
    if (state.taskboard.watching === state.taskboard.open) return;
    state.taskboard.watching = state.taskboard.open;
    subscribe();
}

export function showTaskboard(on) {
    state.taskboard.open = on;
    if (on) closeOtherPanels('taskboard');
    paintPanels();
    syncBoardWatch();
    syncTaskboardWatch();

    if (on) {
        tbPaintTools();
        // The subscribe above brings the payload straight back, but only if the
        // stream is up. A window that has just booted, or one whose stream is
        // reconnecting, gets it the other way rather than an empty grid.
        if (state.taskboard.data) renderTaskboard();
        else loadTaskboard();
    } else if (state.live.open) {
        // The live board was left switched on underneath and has been ignoring
        // its pushes; catch it up before it comes back into view.
        renderLive();
        if (state.current) termPane.refit();
    } else if (state.current) {
        termPane.refit();
    }
    rememberView();
}

/** Is the board both open and not covered by something else? */
const taskboardVisible = () => state.taskboard.open;

/**
 * A payload arriving, from the stream or from a fetch.
 *
 * The badge is kept up to date whether or not the board is open — the same
 * bargain the live board strikes — but the drawing only happens when there is
 * something to draw on.
 */
function applyTaskboard(data, { all = false } = {}) {
    state.taskboard.data = data;
    state.taskboard.at = Date.now();
    state.taskboard.error = null;
    tbRememberOrder(data, all);
    paintTaskboardBadge();
    if (taskboardVisible()) renderTaskboard();
}

/**
 * Fetch the board once.
 *
 * Three callers, all of them one-offs: the Refresh button, a window opening the
 * board before its stream is up, and the Show-all button — which is the only one
 * that passes `all`, and the only reason this takes an argument at all. The
 * steady state is the push.
 */
async function loadTaskboard({ all = false } = {}) {
    if (state.taskboard.loading) return;
    state.taskboard.loading = true;
    if (taskboardVisible()) renderTaskboard();
    try {
        const data = await get(`/api/taskboard${all ? '?idle=all' : ''}`);
        // Held apart from the pushed payload rather than merged into it: the
        // push never carries the older idle sessions, so merging would have them
        // vanish again three seconds later.
        if (all) state.taskboard.allIdle = data.idle;
        state.taskboard.loading = false;
        applyTaskboard(data, { all });
    } catch (err) {
        state.taskboard.loading = false;
        state.taskboard.error = err.message;
        if (taskboardVisible()) renderTaskboard();
    }
}

/**
 * How many sessions are blocked on you, on the button that opens the board.
 *
 * From `state.waiting` and **not** from `counts.needs`, though the payload
 * carries it. The payload only arrives while the board is open — that is the
 * point of the watcher-gated tick — so a badge fed from it would freeze at
 * whatever the boot fetch happened to see and stay there all afternoon. The
 * live board learnt this already: `state.waiting` is maintained from the
 * permission events whether any board is open or not, which is exactly the
 * property a badge needs.
 *
 * It therefore says the same number as the live board's badge, and should: two
 * views of one fact, and that fact is the reason to open either of them. The
 * one thing it misses is a session in `error`, which is in the column but not in
 * `waiting`; being one short on something rare beats being frozen on everything.
 */
export function paintTaskboardBadge() {
    const n = state.waiting.size;
    dom.tbBadge.hidden = !n;
    dom.tbBadge.textContent = String(n);
    // The same red the live board's badge uses: it is the same news.
    dom.tbBadge.classList.toggle('urgent', n > 0);
    dom.btnTaskboard.title = keys.hint(n
        ? `${n} session${n === 1 ? ' is' : 's are'} waiting for you`
        : 'Everything outstanding, by state', 'view.tasks');
}

// ── holding the order ────────────────────────────────────────────────────
//
// The rail's mechanism (`rememberOrder`, and the comment on it), applied per
// column. Ranks from the first load count up from zero in the order the bridge
// sent them; anything first seen after that takes a negative rank, so it lands at
// the top of its column without moving anything already placed.
//
// **Keyed by column as well as by id**, which is what makes a session changing
// state the one thing that can move a card. Its key in the new column has never
// been seen, so it goes to the top of it — a session that has just become
// blocked on you appearing at the top of *Needs you* is exactly the behaviour
// wanted — while every card that did not change state keeps the rank it had.
//
// The old key is left behind rather than swept up. It is a few bytes per column
// per session, it costs nothing, and clearing it would mean a session that goes
// working → idle → working comes back at the top of *Working* having never left
// the board, which reads as a new session when it is not.

const tbKey = (col, id) => `${col}:${id}`;

function tbRememberOrder(data, all = false) {
    const first = state.taskboard.order.size === 0;
    const rows = [
        ...data.needs.map(c => tbKey('needs', c.sessionId)),
        ...data.working.map(c => tbKey('working', c.sessionId)),
        ...data.suggested.map(t => tbKey('task', t.id)),
        // Not on an `?idle=all` answer: `data.idle` is then every un-archived
        // session rather than today's, and putting all of it through the rule
        // below would rank the whole history as newly arrived and stand the
        // column on its head. The tail loop underneath is where those belong,
        // and the ones already placed are skipped there by id.
        ...(all ? [] : data.idle.map(c => tbKey('idle', c.sessionId))),
    ];
    for (const key of rows) {
        if (state.taskboard.order.has(key)) continue;
        state.taskboard.order.set(key,
            first ? state.taskboard.order.size : --state.taskboard.freshRank);
    }

    // Show-all is the exception, and it has to be, because it is the one thing
    // that adds rows which are *older* than everything already placed. Given the
    // rule above they would each be "new", take a negative rank, and land above
    // today's sessions — the column inverted, oldest first, and then held that
    // way. So they count up from the high-water mark instead, which puts them
    // under what is already there, in the order the bridge sent them.
    for (const c of state.taskboard.allIdle || []) {
        const key = tbKey('idle', c.sessionId);
        if (state.taskboard.order.has(key)) continue;
        // Above every rank handed out so far, whichever branch handed it out:
        // `order.size` counts the negative ranks too, so it is a high-water mark
        // that only ever rises, and taking the max of the two keeps this
        // monotonic across several presses.
        state.taskboard.tailRank =
            Math.max(state.taskboard.tailRank, state.taskboard.order.size);
        state.taskboard.order.set(key, state.taskboard.tailRank++);
    }
}

const tbRankOf = (col, id) => state.taskboard.order.get(tbKey(col, id)) ?? 0;

/** One column's rows, in the order they were first placed in. */
function tbHold(col, rows, idOf) {
    return [...rows].sort((a, b) => tbRankOf(col, idOf(a)) - tbRankOf(col, idOf(b)));
}

// ── drawing it ───────────────────────────────────────────────────────────

const TB_COLUMNS = [
    { key: 'needs', label: 'Needs you', empty: 'Nothing is blocked on you.' },
    { key: 'working', label: 'Working', empty: 'Nothing is running.' },
    { key: 'suggested', label: 'Suggested', empty: 'No open tasks.' },
    { key: 'idle', label: 'Idle', empty: 'Nothing here.' },
];

function renderTaskboard() {
    const d = state.taskboard.data;

    dom.tbRefresh.disabled = state.taskboard.loading;
    dom.tbRefresh.textContent = state.taskboard.loading ? 'Reading…' : 'Refresh';

    if (state.taskboard.error) {
        dom.tbBody.replaceChildren(el('div', { class: 'tb-note' },
            el('p', {}, `Could not read the board. ${state.taskboard.error}`)));
        return;
    }
    if (!d) {
        dom.tbBody.replaceChildren(el('div', { class: 'tb-note' },
            el('p', {}, 'Reading every session…')));
        return;
    }

    const focused = state.taskboard.focus;
    const groups = focused ? tbFocusGroups(d) : null;
    const shown = focused
        ? [...groups.values()].reduce((n, rows) => n + rows.length, 0) : 0;
    const cols = !focused ? TB_COLUMNS.map(c => tbColumn(c, d))
        : groups.size ? [...groups].map(([name, rows]) => tbProjectColumn(name, rows))
            : [tbFocusNote(d)];
    // A note is one wide block and not a row of columns, so it keeps the plain
    // grid — otherwise it would sit in a 300px lane with the rest of the board
    // blank beside it.
    dom.tbBody.classList.toggle('cols', focused && groups.size > 0);

    dom.tbSub.textContent = focused ? tbFocusWords(d, groups.size, shown) : [
        `${d.counts.needs} blocked on you`,
        `${d.counts.working} working`,
        `${d.counts.suggested} open ${d.counts.suggested === 1 ? 'task' : 'tasks'}`,
        `${d.counts.idle} idle`,
    ].join(' · ');

    // Each column scrolls on its own, and a rebuild would otherwise throw all
    // four scroll positions away every three seconds. Keyed by whichever of the
    // two things a column is — a state unfocused, a project focused — so that a
    // column keeps its own place in its own list rather than the neighbour's.
    const scrolls = new Map();
    for (const c of dom.tbBody.querySelectorAll('.tb-col-body')) {
        scrolls.set(c.dataset.col || c.dataset.project, c.scrollTop);
    }
    const bodyScroll = dom.tbBody.scrollLeft;

    // Somebody typing a task into the box at the foot of the Suggested column
    // would have it pulled out from under them mid-word, three seconds after
    // they started. The text itself survives in `state.taskboard.draft`, which
    // the box writes on every keystroke; this is the focus and the caret.
    const active = document.activeElement;
    const typing = active && active.classList.contains('tb-new-box')
        ? { at: active.selectionStart, to: active.selectionEnd }
        : null;

    dom.tbBody.replaceChildren(...cols);

    for (const c of dom.tbBody.querySelectorAll('.tb-col-body')) {
        const key = c.dataset.col || c.dataset.project;
        if (scrolls.has(key)) c.scrollTop = scrolls.get(key);
    }
    dom.tbBody.scrollLeft = bodyScroll;

    if (typing) {
        const box = dom.tbBody.querySelector('.tb-new-box');
        if (box) {
            box.focus({ preventScroll: true });
            box.setSelectionRange(typing.at, typing.to);
        }
    }
}

function tbColumn(col, d) {
    const cards = col.key === 'suggested'
        ? tbTaskCards(d)
        : tbSessionCards(col.key, d);

    return el('section', { class: 'tb-col', 'data-col': col.key },
        el('header', { class: 'tb-col-head' },
            el('h2', {}, col.label),
            el('span', { class: 'tb-count' }, String(d.counts[col.key])),
            // The way in to the focused view, and the only one. The way out is
            // the button in the board's header, because by then this column no
            // longer exists to hold a second copy of it.
            col.key === 'suggested' ? el('button', {
                // Not `aria-pressed`: it is not a switch that stays here and
                // lights up. Pressing it replaces the view this button is part
                // of, and the way back is the header's.
                class: 'tb-focus-btn', type: 'button',
                title: 'Suggested tasks only, one column per project',
                onclick: () => tbSetFocus(true),
            }, 'Focus') : null,
        ),
        el('div', { class: 'tb-col-body', 'data-col': col.key },
            cards.length ? cards : el('p', { class: 'tb-empty' }, col.empty),
            col.key === 'idle' ? tbShowAll(d) : null,
            col.key === 'suggested' ? tbComposer() : null,
        ),
    );
}

/**
 * The session columns.
 *
 * Idle is the one with a tail. When Show-all has been pressed, the older
 * sessions it fetched are drawn under the ones the push keeps current — filtered
 * against the two live columns, because a session that has started working since
 * that fetch is on the board twice otherwise, once truthfully and once as a
 * stale copy of itself.
 */
function tbSessionCards(key, d) {
    let rows = d[key];
    if (key === 'idle' && state.taskboard.allIdle) {
        const elsewhere = new Set([...d.needs, ...d.working].map(c => c.sessionId));
        const fresh = new Set(d.idle.map(c => c.sessionId));
        rows = [...d.idle, ...state.taskboard.allIdle.filter(
            c => !fresh.has(c.sessionId) && !elsewhere.has(c.sessionId))];
    }
    return tbHold(key, rows, c => c.sessionId).map(c => tbSessionCard(c));
}

/** Tasks, grouped by the project they were raised in, as the rail groups rows. */
function tbTaskCards(d) {
    const held = tbHold('task', d.suggested, t => t.id);

    const groups = new Map();
    for (const t of held) {
        const name = (t.session && t.session.projectName) || 'Elsewhere';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(t);
    }
    // One heading over the whole column says nothing. Grouping earns its keep
    // only once there is more than one group to tell apart.
    if (groups.size < 2) return held.map(tbTaskCard);

    const out = [];
    for (const [name, rows] of groups) {
        out.push(el('h3', { class: 'tb-sub-head' }, name,
            el('span', {}, String(rows.length))));
        out.push(...rows.map(tbTaskCard));
    }
    return out;
}

// ── the focused view ─────────────────────────────────────────────────────

/** Turn the focused view on or off, and remember which. */
function tbSetFocus(on) {
    state.taskboard.focus = on;
    localStorage.setItem('tbFocus', on ? '1' : '0');
    if (!on) {
        // The box goes away with the view, so a query left behind in it would
        // be invisible and still filtering the next time focus came on.
        state.taskboard.query = '';
        dom.tbSearch.value = '';
    }
    tbPaintTools();
    renderTaskboard();
    if (on) dom.tbSearch.focus({ preventScroll: true });
}

/** The header controls that belong to the focused view. */
function tbPaintTools() {
    const on = state.taskboard.focus;
    dom.tbSearch.hidden = !on;
    dom.tbUnfocus.hidden = !on;
}

/**
 * Does a task match what is in the search box?
 *
 * Every word has to appear somewhere, rather than any of them, so that a second
 * word narrows the board instead of widening it — which is what you reach for
 * when the first one still left forty cards. The prompt is searched as well as
 * the title because a task raised without a title is titled by its first line,
 * and the sentence you remember is usually further in than that. The
 * conversation's own title is in there too: "the one from the schedule work" is
 * how you look for a task you did not read at the time.
 */
function tbMatches(t) {
    const q = state.taskboard.query.trim().toLowerCase();
    if (!q) return true;
    const hay = [t.title, t.prompt, t.why, t.session && t.session.title]
        .filter(Boolean).join('\n').toLowerCase();
    return q.split(/\s+/).every(word => hay.includes(word));
}

/**
 * The open tasks, filtered, as one group per project.
 *
 * `tbHold` first and the filter second, so the search narrows an order that has
 * already been settled rather than deciding one of its own — a card keeps its
 * place in its column as words are typed and deleted.
 *
 * **The order of the keys is the order of the columns, and it needs no sort.**
 * `draftGroups` explains this at length and it is the same argument: the held
 * rows are newest-first, a Map keeps the order its keys were first seen in, so
 * walking them once lands the projects most-recently-suggested-in first. Held
 * thereafter, like everything else on this board.
 *
 * Grouped by `session.projectName` — the key the sub-headings in the unfocused
 * column already use — rather than by worktree, so that every task raised in a
 * repo arrives in one column instead of being scattered across however many
 * worktrees of it are live. The worktree is still on each card.
 */
function tbFocusGroups(d) {
    const groups = new Map();
    for (const t of tbHold('task', d.suggested, x => x.id)) {
        if (!tbMatches(t)) continue;
        const name = (t.session && t.session.projectName) || 'Elsewhere';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(t);
    }
    return groups;
}

/**
 * One project, as a column.
 *
 * `draftColumn`'s shape, for `draftColumn`'s reason: the chrome is this board's
 * already. No `data-col`, deliberately — that attribute colours a *state*, and
 * a project is not one. The cards keep `.tb-task`'s own stripe, which still says
 * the right thing.
 *
 * The head takes the project's own colour where it has one, on the argument
 * draftColumn spells out: a colour chosen for a project is not one this board
 * invented. `Elsewhere` is the group for tasks with no session behind them, and
 * it resolves to no directory and therefore no colour, which is right.
 */
function tbProjectColumn(name, rows) {
    const from = rows[0] && rows[0].session;
    const accent = projectColor((from && (from.projectCwd || from.cwd)) || '');
    return el('section', {
        class: 'tb-col tb-focus-col', 'data-project': name,
        'data-tinted': accent ? '1' : null,
        style: accent ? `--proj-accent: ${accent}` : null,
    },
        el('header', { class: 'tb-col-head' },
            el('h2', { title: name }, name),
            el('span', { class: 'tb-count' }, String(rows.length)),
        ),
        el('div', { class: 'tb-col-body', 'data-project': name },
            ...rows.map(tbTaskCard),
        ),
    );
}

/** Nothing to show: an empty board and a search that found nothing differ. */
function tbFocusNote(d) {
    const q = state.taskboard.query.trim();
    if (q) {
        return el('div', { class: 'tb-note' },
            el('p', {}, `No task matches “${q}”.`),
            el('p', { class: 'dim' }, `${d.counts.suggested} open `
                + `${d.counts.suggested === 1 ? 'task is' : 'tasks are'} hidden by it.`));
    }
    return el('div', { class: 'tb-note' },
        el('p', {}, 'No open tasks.'),
        el('p', { class: 'dim' }, 'Suggested tasks are raised by agents as they '
            + 'work, for the things they noticed and did not do.'));
}

/** The subtitle, focused. */
function tbFocusWords(d, projects, shown) {
    const total = d.counts.suggested;
    const where = `${projects} ${projects === 1 ? 'project' : 'projects'}`;
    if (state.taskboard.query.trim()) {
        return `${shown} of ${total} matching “${state.taskboard.query.trim()}”`
            + (projects ? ` · ${where}` : '');
    }
    return `${total} open ${total === 1 ? 'task' : 'tasks'}`
        + (projects ? ` · ${where}` : '');
}

/**
 * A suggested task, as a card.
 *
 * Every button on it is the one the tasks panel beside a transcript already
 * uses — `startSuggestion`, `openTaskDialog`, `actOnSuggestion` — because a task
 * started from here and a task started from there must do the same thing, and
 * two code paths for one gesture is how they stop doing it.
 */
function tbTaskCard(t) {
    const where = t.session || {};
    return el('article', {
        class: 'tb-card tb-task', 'data-archived': String(!!t.archived),
        onclick: (e) => { if (tbCardClickOpens(e)) openTaskDialog(t); },
    },
        el('header', { class: 'tb-card-head' },
            el('span', { class: 'tb-dot' }),
            el('button', {
                class: 'tb-card-title', type: 'button',
                title: 'Read this at full width',
                onclick: () => openTaskDialog(t),
            }, t.title || firstLine(t.prompt)),
        ),
        el('div', { class: 'tb-card-meta' },
            el('span', {}, 'Suggested'),
            el('span', { class: 'dot' }, '·'),
            el('span', {}, where.worktree ? where.worktree.name
                : (where.projectName || 'unknown')),
            el('span', { class: 'dot' }, '·'),
            el('span', { title: t.ts || '' }, ago(t.ts)),
        ),
        // Where it came from. The point of the column is that this is a task
        // from a conversation you are not in, so saying which one is not
        // decoration — it is how you judge the offer.
        el('div', { class: 'tb-from' },
            el('button', {
                class: 'linky', type: 'button',
                title: 'Open the conversation that raised this',
                onclick: () => { showTaskboard(false); openSession(t.sessionId); },
            }, clip(where.title || 'a conversation', 44)),
            t.archived ? el('span', { class: 'tb-tag' }, 'archived') : null,
            (t.session && t.session.test) ? el('span', { class: 'tb-tag' }, 'test') : null,
        ),
        el('div', { class: 'tb-acts' },
            el('button', {
                class: 'tb-btn primary', type: 'button',
                onclick: (e) => tbStartTask(t, e.currentTarget),
            }, 'Start'),
            el('button', {
                class: 'tb-btn', type: 'button',
                onclick: () => openTaskDialog(t),
            }, 'View task'),
            el('button', {
                class: 'tb-btn quiet', type: 'button', title: 'Not this one',
                onclick: () => tbDecide(t, 'dismissed'),
            }, 'Dismiss'),
        ),
    );
}

/**
 * A session, as a card.
 *
 * Deliberately the live board's vocabulary — `liveStatusWords`, `ASK_WORD`,
 * `taskBar`, `ago` — rather than a second set of words for the same states. A
 * session that says "Waiting for permission" on one board and something else on
 * the other is two boards disagreeing about one fact.
 */
function tbSessionCard(s) {
    const r = s.runner;
    const busy = r && (r.state === 'busy' || r.state === 'starting');
    const away = s.live && s.live.running && !r;

    return el('article', {
        class: 'tb-card tb-session', 'data-col': s.column, 'data-id': s.sessionId,
        onclick: (e) => { if (tbCardClickOpens(e)) tbOpen(s.sessionId); },
    },
        el('header', { class: 'tb-card-head' },
            el('span', { class: 'tb-dot' }),
            el('button', {
                class: 'tb-card-title', type: 'button',
                title: 'Open this conversation',
                onclick: () => tbOpen(s.sessionId),
            }, s.title),
            el('button', {
                class: 'mini', type: 'button', title: 'Archive',
                onclick: (e) => { e.stopPropagation(); tbArchive(s); },
            }, icon('archive')),
        ),
        el('div', { class: 'tb-card-meta' },
            s.pinned ? el('span', { class: 'tag-pin', title: 'Pinned' }, icon('pin', 11)) : null,
            s.test ? el('span', { class: 'tag-test' }, 'test') : null,
            el('span', {}, s.worktree ? s.worktree.name : s.projectName),
            el('span', { class: 'dot' }, '·'),
            el('span', { title: s.lastTs || '' }, ago(s.lastTs)),
            el('span', { class: 'dot' }, '·'),
            el('span', {}, `${s.userMessages} ${s.userMessages === 1 ? 'turn' : 'turns'}`),
            (r && r.queued) ? queuedBadge(r.queued) : null,
        ),
        // Nothing worth a line on an idle card: it has no runner to report an
        // activity and no task list asked for, so `liveStatusWords` can only say
        // "Idle" — under a column heading that already says it, to fifty-odd
        // cards at once.
        s.column === 'idle' ? null
            : el('div', { class: 'tb-card-line' }, liveStatusWords(s, busy, away)),
        s.tasks ? taskBar(s.tasks) : null,
        s.tasks ? el('div', { class: 'tb-card-meta' },
            el('span', {}, `${s.tasks.done} of ${s.tasks.total} tasks`)) : null,
        // What it is waiting on, said rather than answered. Answering an ask
        // from a tile is the live board's job and it does it well; this board is
        // the map, and two places to approve the same thing is one too many.
        s.ask ? el('p', { class: 'tb-ask' }, tbAskWords(s.ask)) : null,
        el('div', { class: 'tb-acts' },
            el('button', {
                // Filled only where the card is asking for something. A column
                // of fifty idle sessions each with a bright button is a wall
                // that says nothing about which of them matters.
                class: s.ask ? 'tb-btn primary' : 'tb-btn', type: 'button',
                onclick: () => tbOpen(s.sessionId),
            }, s.ask ? 'Answer it' : 'Open'),
            busy ? el('button', {
                class: 'tb-btn', type: 'button',
                title: 'Interrupt the turn this session is running',
                onclick: (e) => stopFromCard(s.sessionId, e.currentTarget),
            }, 'Stop') : null,
        ),
    );
}

/** What the session is blocked on, in one line. */
function tbAskWords(ask) {
    if (ask.kind === 'plan') return 'A plan is waiting to be approved.';
    if (ask.kind === 'question') return 'It asked you a question.';
    const what = toolSummary({ name: ask.tool, input: ask.input }) || ask.displayName;
    return `Wants to run ${clip(what, 60)}`;
}

/** The same rule the live board uses: a click on a control is not "take me there". */
function tbCardClickOpens(e) {
    if (e.target.closest('button, a, input, textarea, select, label')) return false;
    const picked = window.getSelection();
    return !(picked && picked.type === 'Range' && String(picked).trim());
}

/** Leaving the board for a conversation, which is what every card offers. */
function tbOpen(sessionId) {
    showTaskboard(false);
    openSession(sessionId);
}

/** The rest of the idle sessions, once, behind a button. */
function tbShowAll(d) {
    if (state.taskboard.allIdle) return null;
    if (!d.idleHidden) return null;
    return el('div', { class: 'tb-more' },
        el('button', {
            class: 'tb-btn', type: 'button',
            onclick: () => loadTaskboard({ all: true }),
        }, `Show all ${d.counts.idle}`),
        el('p', {}, `${d.idleHidden} older ${d.idleHidden === 1 ? 'session' : 'sessions'} `
            + 'are not shown. The column leads with what has moved today.'),
    );
}

/**
 * A line at the foot of the Suggested column for a task of your own.
 *
 * It opens the ordinary new-session dialog with what you typed already in it,
 * rather than starting anything: a task typed into a one-line box has had no
 * directory chosen for it, and guessing one is how a session ends up running in
 * the wrong checkout.
 */
function tbComposer() {
    const box = el('input', {
        class: 'tb-new-box', type: 'text', placeholder: 'Start a task…',
        value: state.taskboard.draft,
        oninput: (e) => { state.taskboard.draft = e.currentTarget.value; },
        onkeydown: (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            go(e.currentTarget);
        },
    });
    const go = (input) => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        state.taskboard.draft = '';
        showTaskboard(false);
        openNew({ prompt: text });
    };
    return el('div', { class: 'tb-new' }, box,
        el('button', {
            class: 'tb-btn', type: 'button',
            onclick: () => go(box),
        }, 'Start'),
    );
}

// ── acting on a card ─────────────────────────────────────────────────────
//
// Every one of these goes through the function the rest of the app already uses
// and then takes the card off the board itself. The push would do it within
// three seconds, but three seconds of a button that visibly did nothing is how a
// board teaches you to click twice.

async function tbStartTask(t, btn) {
    tbDropTask(t.id);
    await startSuggestion(t, btn);
}

async function tbDecide(t, status) {
    tbDropTask(t.id);
    await actOnSuggestion(t, status);
}

/**
 * Take one task off the board now.
 *
 * The column is open tasks only, so any decision removes it. Not rolled back on
 * failure: `actOnSuggestion` rolls back its own state and says so in a toast, and
 * the next push puts the row back where it belongs a moment later — which is
 * more honest than this guessing at which of the two it was.
 */
function tbDropTask(id) {
    const d = state.taskboard.data;
    if (!d) return;
    const before = d.suggested.length;
    d.suggested = d.suggested.filter(t => t.id !== id);
    if (d.suggested.length !== before) d.counts.suggested -= 1;
    if (taskboardVisible()) renderTaskboard();
}

function tbArchive(s) {
    const d = state.taskboard.data;
    if (d) {
        for (const key of ['needs', 'working', 'idle']) {
            const before = d[key].length;
            d[key] = d[key].filter(c => c.sessionId !== s.sessionId);
            if (d[key].length !== before) d.counts[key] -= 1;
        }
        if (state.taskboard.allIdle) {
            state.taskboard.allIdle =
                state.taskboard.allIdle.filter(c => c.sessionId !== s.sessionId);
        }
        if (taskboardVisible()) renderTaskboard();
    }
    setFlags(s, { archived: true });
    toast(`Archived “${clip(s.title, 40)}”.`, 'ok');
}

// ── drafts ───────────────────────────────────────────────────────────────
//
// Sessions set up but not started.
//
// Every other screen in this app is a view over something that already happened:
// a transcript, a running process, a task an agent raised, a notification that
// was sent. This one is the only one about work that has not begun — which is why
// it is a panel rather than a fifth column on the task board, and why the bridge
// keeps a file for it instead of deriving it from anything.
//
// **A draft is a whole create call, held back.** Not a note about a session: the
// same working directory, first message, model and permission mode that
// `POST /api/sessions` takes, validated the same way when it is saved, so
// pressing Start cannot fail for any reason you could have been told about
// earlier. That is also why there is no second form — the Start-a-session dialog
// already collects exactly these fields, so it grew a third and a fourth: Save as
// draft, and Schedule.
//
// **Nothing here moves on its own**, so none of the two boards' machinery is
// needed: no watcher-gated tick to subscribe to, and no `tbRememberOrder` ranks
// to stop a card sliding out from under the cursor. The bridge pushes the whole
// list on `drafts-changed` whenever somebody changes something, and this draws it
// in the order it arrived — newest-edited first.
//
// **The board is a column per project once there are two**, which is the task
// board's shape borrowed for a different question. Over there a column is a
// state; here it is a place, and the order of the columns is which project you
// touched last. It costs no sort — see `draftGroups` — and below two projects it
// stays the single readable column it has always been, because a column with
// nothing to be told apart from is just a narrower list.

function showDrafts(on) {
    state.drafts.open = on;
    if (on) closeOtherPanels('drafts');
    paintPanels();
    syncBoardWatch();
    // This panel has no watch of its own — the push is unconditional — but it
    // *closes* the task board, and the board's ~3s `taskboard.build` on the bridge
    // only stops when somebody says they have stopped watching. Leaving this out
    // let that tick run for the rest of the session.
    syncTaskboardWatch();

    if (on) {
        // Draw whatever is already held so the panel is never briefly empty, and
        // fetch behind it. Unlike the two boards there is no subscribe to wait
        // on: the push is unconditional, so a fetch is only needed for a window
        // that has not had one yet.
        renderDrafts();
        if (!state.drafts.at) loadDrafts();
    } else if (state.live.open) {
        // The live board was left switched on underneath and has been ignoring
        // its pushes; catch it up before it comes back into view.
        renderLive();
        if (state.current) termPane.refit();
    } else if (state.current) {
        termPane.refit();
    }
    rememberView();
}

const draftsVisible = () => state.drafts.open;

/**
 * A payload arriving, from the stream or from a fetch.
 *
 * The badge is kept current whether or not the panel is open, the same bargain
 * the other boards strike — and here it costs nothing, because the push is not
 * gated on anybody watching.
 */
function applyDrafts(data) {
    state.drafts.rows = data.drafts || [];
    state.drafts.at = data.at || Date.now();
    state.drafts.error = null;
    paintDraftsBadge();
    if (draftsVisible()) renderDrafts();
}

async function loadDrafts() {
    if (state.drafts.loading) return;
    state.drafts.loading = true;
    try {
        const data = await get('/api/drafts');
        state.drafts.loading = false;
        applyDrafts(data);
    } catch (err) {
        state.drafts.loading = false;
        state.drafts.error = err.message;
        if (draftsVisible()) renderDrafts();
    }
}

/**
 * How many drafts are waiting, on the button that opens the panel.
 *
 * Fed straight from the rows, unlike the task board's badge — which has to come
 * from `state.waiting` because its payload only arrives while it is being
 * watched. This payload always arrives, so the simple thing is also the correct
 * one.
 *
 * Never `urgent`: a draft is the one thing in this app that is explicitly not
 * asking for attention, and colouring it red would be arguing with the reason it
 * exists.
 */
export function paintDraftsBadge() {
    const n = state.drafts.rows.length;
    dom.drBadge.hidden = !n;
    dom.drBadge.textContent = String(n);
    dom.btnDrafts.title = keys.hint(n
        ? `${n} draft${n === 1 ? '' : 's'} waiting to be started`
        : 'Sessions set up but not started', 'view.drafts');
}

// ── drawing it ───────────────────────────────────────────────────────────

function renderDrafts() {
    const rows = state.drafts.rows;
    const groups = draftGroups(rows);
    // One project is one column, which is a column that says nothing — the same
    // threshold the sub-headings used to use, now deciding the whole layout.
    // Below it the panel stays the readable single column it has always been; at
    // two it becomes the task board's shape.
    const cols = groups.size >= 2;

    dom.drSub.textContent = !rows.length
        ? 'Sessions you have set up but not started.'
        : cols
            ? `${rows.length} drafts across ${groups.size} projects, newest edit first.`
            : `${rows.length} ${rows.length === 1 ? 'draft' : 'drafts'}, newest edit first.`;

    if (state.drafts.error) {
        dom.drBody.classList.remove('cols');
        dom.drBody.replaceChildren(el('div', { class: 'dr-note' },
            el('p', {}, `Could not read the drafts. ${state.drafts.error}`)));
        return;
    }

    if (!rows.length) {
        dom.drBody.classList.remove('cols');
        dom.drBody.replaceChildren(el('div', { class: 'dr-note' },
            el('p', {}, 'Nothing set up yet.'),
            el('p', { class: 'dim' }, 'A draft is a session with its directory, first '
                + 'message, model and permissions already chosen — for work that is '
                + 'ready to go but blocked on something else.'),
            el('button', {
                class: 'tb-btn primary', type: 'button',
                onclick: () => openNew(),
            }, 'New draft')));
        return;
    }

    if (!cols) {
        // The panel scrolls as one column, and a push would otherwise throw the
        // scroll position away mid-read every time anything changed.
        dom.drBody.classList.remove('cols');
        const scroll = dom.drBody.scrollTop;
        dom.drBody.replaceChildren(...rows.map(draftCard));
        dom.drBody.scrollTop = scroll;
        return;
    }

    // Each column scrolls on its own and the row of them scrolls sideways, so a
    // rebuild throws away as many positions as there are projects unless every
    // one of them is carried across — renderTaskboard's problem, and its answer.
    // Keyed by project rather than by position: a column that has just moved
    // left, because somebody edited a draft in it, should keep its own place in
    // its own list rather than inherit the neighbour's.
    const scrolls = new Map();
    for (const c of dom.drBody.querySelectorAll('.tb-col-body')) {
        scrolls.set(c.dataset.project, c.scrollTop);
    }
    const across = dom.drBody.scrollLeft;

    dom.drBody.classList.add('cols');
    dom.drBody.replaceChildren(
        ...[...groups].map(([name, list]) => draftColumn(name, list)));

    for (const c of dom.drBody.querySelectorAll('.tb-col-body')) {
        if (scrolls.has(c.dataset.project)) c.scrollTop = scrolls.get(c.dataset.project);
    }
    dom.drBody.scrollLeft = across;
}

/**
 * The drafts, by project.
 *
 * **The order of the keys is the order of the columns, and it needs no sort.**
 * The bridge hands the rows over newest-`updatedAt` first, and `updatedAt` moves
 * on a create as well as on an edit — so the first row of a project is its most
 * recently touched draft, and a Map keeps the order its keys were first seen in.
 * Walking the rows once therefore lands the projects in exactly the order the
 * board wants them: most recently added-or-edited first. Quietly load-bearing,
 * which is why it is written down here rather than left to be rediscovered — an
 * object keyed by name would not hold it, and neither would a second pass that
 * sorted the groups by anything else.
 *
 * `projectName` comes off the payload rather than being derived here, so every
 * client agrees about which project a directory belongs to.
 */
function draftGroups(rows) {
    const groups = new Map();
    for (const d of rows) {
        const name = d.projectName || 'unknown';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(d);
    }
    return groups;
}

/**
 * One project, as a column.
 *
 * The task board's own chrome — `tb-col`, `tb-col-head`, `tb-count`,
 * `tb-col-body` — rather than a second set of styles for a shape that already
 * exists, which is the borrowing `draftCard` below already does with `tb-card`.
 *
 * What differs is what a column *means*. Over there it is a state, and the
 * colour says which one; here it is a project. So no `data-col` — that attribute
 * is what colours a state, and a project is not one — and the cards keep
 * `.dr-card`'s quiet stripe, which is still the right one: a draft is the thing
 * in this app that is explicitly not asking for anything.
 *
 * The head *does* carry a colour now, and the two are not in tension. The rule
 * was never that a project has no colour; it was that this board must not invent
 * one, because an invented colour claims a meaning it cannot deliver. A colour
 * somebody chose for the project is not an invention, and it says the only thing
 * a project's colour ever says: which project. Absent for every project nobody
 * has coloured, which is most of them.
 */
function draftColumn(name, list) {
    const accent = projectColor((list[0] && list[0].cwd) || '');
    return el('section', {
        class: 'tb-col dr-col', 'data-project': name,
        'data-tinted': accent ? '1' : null,
        style: accent ? `--proj-accent: ${accent}` : null,
    },
        el('header', { class: 'tb-col-head' },
            el('h2', { title: name }, name),
            el('span', { class: 'tb-count' }, String(list.length)),
        ),
        el('div', { class: 'tb-col-body', 'data-project': name },
            ...list.map(draftCard),
        ),
    );
}

/**
 * One draft, as a card.
 *
 * Deliberately the task board's card vocabulary — `tb-card`, `tb-card-meta`,
 * `tb-acts`, `tb-btn` — rather than a second set of styles for the same shape.
 * The prompt is shown rather than only its first line: the whole point of coming
 * here is to read what you wrote before releasing it, and a draft is usually a
 * paragraph rather than a transcript.
 */
function draftCard(d) {
    return el('article', {
        class: 'tb-card dr-card', 'data-id': d.id,
        onclick: (e) => { if (tbCardClickOpens(e)) drEdit(d); },
    },
        el('header', { class: 'tb-card-head' },
            el('span', { class: 'tb-dot' }),
            el('button', {
                class: 'tb-card-title', type: 'button',
                title: 'Open this draft for editing',
                onclick: () => drEdit(d),
            }, d.title || firstLine(d.prompt)),
        ),
        el('div', { class: 'tb-card-meta' },
            d.test ? el('span', { class: 'tag-test' }, 'test') : null,
            el('span', { title: d.cwd }, d.projectName || 'unknown'),
            el('span', { class: 'dot' }, '·'),
            // `inherit` rather than nothing: a model the session will pick for
            // itself is a real answer, and a blank here would read as unset.
            el('span', {}, d.model || 'inherit'),
            el('span', { class: 'dot' }, '·'),
            el('span', {}, d.permissionMode),
            el('span', { class: 'dot' }, '·'),
            el('span', { title: new Date(d.updatedAt).toLocaleString() },
                ago(new Date(d.updatedAt).toISOString())),
        ),
        // `clipLines`, not `clip`: clip() flattens every run of whitespace to a
        // single space, which would turn a prompt written as a list of steps into
        // one long line — and the whole reason the message is on the card is to be
        // read back before it runs. The CSS clamps the height; this caps the text.
        el('p', { class: 'dr-prompt' }, clipLines(d.prompt, 600)),
        el('div', { class: 'tb-acts' },
            el('button', {
                class: 'tb-btn primary', type: 'button',
                title: 'Start this session now',
                onclick: (e) => drStart(d, e.currentTarget),
            }, 'Start'),
            el('button', {
                class: 'tb-btn', type: 'button',
                onclick: () => drEdit(d),
            }, 'Edit'),
            el('button', {
                class: 'tb-btn quiet', type: 'button', title: 'Delete this draft',
                onclick: () => drDelete(d),
            }, 'Delete'),
        ),
    );
}

// ── acting on a card ─────────────────────────────────────────────────────

/**
 * Start it.
 *
 * One call: the bridge starts the session and forgets the draft, in that order,
 * so a failure leaves the draft where it was. Doing it here as two calls would
 * mean this window deciding what happens if the second one fails — and the phone
 * and the Android client would each have to decide the same thing again.
 */
async function drStart(d, btn) {
    btn.disabled = true;
    btn.textContent = 'Starting';
    try {
        const r = await post(`/api/drafts/${d.id}/start`);
        toast('Session started.', 'ok');
        showDrafts(false);
        // The transcript only exists once `claude` has written its first line.
        openSessionSoon(r.sessionId);
    } catch (err) {
        toast(`Could not start the draft: ${err.message}`, 'error');
        btn.disabled = false;
        btn.textContent = 'Start';
    }
    // No re-enable on the happy path: the push takes the card off the board, and
    // a button that came back to life on a card about to vanish invites a second
    // press that would start the session twice.
}

/**
 * Open it in the dialog it was written in.
 *
 * The panel stays open behind the modal, so closing the dialog lands you back on
 * the board with the change already drawn — the `drafts-changed` push arrives
 * while it is still covered.
 */
function drEdit(d) {
    openNew({ draft: d });
}

/**
 * Delete it.
 *
 * No confirmation, unlike a session. `#del-scrim` exists because deleting a
 * transcript destroys a conversation that cannot be reconstructed; a draft is a
 * paragraph you wrote and can write again, and putting a dialog in front of it
 * would make tidying the board a chore.
 */
async function drDelete(d) {
    try {
        await del(`/api/drafts/${d.id}`);
    } catch (err) {
        toast(`Could not delete the draft: ${err.message}`, 'error');
    }
}

// ── snippets ─────────────────────────────────────────────────────────────
//
// Canned messages, and the buttons that send them.
//
// Drafts' machinery for the list itself — an unconditional `snippets-changed`
// push carrying the whole payload, held as sent, no watcher to gate — with one
// difference that shapes everything below: **this list is read while its editor
// is shut.** The pinned buttons live on the composer, so it loads at boot rather
// than when a panel opens, and every push repaints three places rather than one.
//
// **The bridge decides the order**, which is why nothing here sorts. `order` is a
// stored decision and `null` means alphabetical, and having the store settle that
// is what keeps the popover, the pinned strip and the editor from each arriving at
// a slightly different answer.
//
// The three questions this section has to get right, none of which is obvious:
//
// **Where the text goes when the snippet also sends itself.** `overwrite` plus
// `autoSubmit` is the shape the LGTM button had, and that button never touched the
// compose box — press it with a half-written message in there and the message is
// still there afterwards. Taking `overwrite` literally first and sending second
// would destroy it. So that one combination, on the live composer, goes straight
// to `sendMessage` with the text as an override and never writes to the box at
// all; `append` and `cursor` must go through it, because what is already in the
// box is part of what gets sent.
//
// **Where the caret was.** `insert: 'cursor'` needs the selection as it stood when
// you reached for the snippet, not as it stands when the text arrives — by then
// the popover has taken focus and the parameter dialog may have taken it again.
// It is recorded at the gesture, and both a pinned button and the right-click menu
// have to record it themselves because they open no popover on the way past.
//
// **What auto-submit means in a dialog with no Send.** See startFromSnippet.

/** What a parameter of each type is asked for with. */
const SNIP_INPUT = {
    text: { type: 'text' },
    integer: { type: 'number', step: '1', inputmode: 'numeric' },
    decimal: { type: 'number', step: 'any' },
    date: { type: 'date' },
    time: { type: 'time' },
    datetime: { type: 'datetime-local' },
};

/** The same expression the bridge substitutes with. Two would be one too many. */
const SNIP_PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

const snipById = (id) => state.snippets.rows.find(s => s.id === id) || null;

/**
 * Take the whole payload as the truth, and repaint everything drawn from it.
 *
 * Three places rather than drafts' one, because two of them are visible when the
 * editor is not: the pinned buttons on the composer, and a popover that may be
 * open over it while another window saves an edit.
 */
function applySnippets(data) {
    state.snippets.rows = data.snippets || [];
    state.snippets.groups = data.groups || [];
    state.snippets.at = data.at || Date.now();
    state.snippets.error = null;
    renderPins();
    for (const c of composers) if (!c.snips.node.hidden) drawSnips(c);
    if (state.settings.open) renderSnipSettings();
}

async function loadSnippets() {
    if (state.snippets.loading) return;
    state.snippets.loading = true;
    try {
        // Never with `?cwd=`, even though the route offers it. The event is not
        // filtered — one payload goes to every window — so a narrowed first load
        // would silently widen the moment anybody edited anything. The filter is
        // applied here instead, per composer, which is where the directory is
        // actually known.
        applySnippets(await get('/api/snippets'));
    } catch (err) {
        state.snippets.error = err.message;
    }
    state.snippets.loading = false;
}

/**
 * Does this snippet belong in a composer pointed at this directory?
 *
 * The bridge's `matchesCwd`, in the client because `web/` has no build step and
 * shares no code with `bridge/`. A prefix at a path boundary: `/a/b` covers
 * `/a/b/c` and not `/a/bc`, which is a different repository sharing five
 * characters.
 *
 * **Fails open when the directory is unknown.** A composer with no session in it
 * should show every snippet rather than none, and `state.current.cwd` is a cache
 * key rather than the authority — the bridge is what resolves a session to a
 * directory, through worktrees that have since been landed and removed.
 */
function snipVisible(s, cwd) {
    if (!s.projects || !s.projects.length) return true;
    if (!cwd) return true;
    const here = String(cwd).replace(/[/\\]+$/, '');
    return s.projects.some(p => here === p
        || here.startsWith(p + '/') || here.startsWith(p + '\\'));
}

/** The working directory a composer is pointed at, or null. */
function snipCwd(c) {
    if (c === live) return (state.current && state.current.cwd) || null;
    return dom.newCwd.value.trim() || null;
}

/** One line of what it says, for the row under the title. */
const snipPreview = (s) => clip(s.body, 120);

/** A group's stored accent, through the one gate the page has — see hexAccent. */
const snipAccent = (g) => (g ? hexAccent(g.accent) : '');

/**
 * The popover's contents: a card per group, then whatever is ungrouped.
 *
 * Ungrouped last rather than first. A group is drawn as a tinted card and the
 * loose ones are a plain list, so putting the plain list first would open the
 * popover on the part that looks like nothing.
 */
function snipCards(cwd) {
    const rows = state.snippets.rows.filter(s => snipVisible(s, cwd));
    const cards = state.snippets.groups
        .map(g => ({ group: g, rows: rows.filter(s => s.groupId === g.id) }))
        .filter(card => card.rows.length);
    const known = new Set(state.snippets.groups.map(g => g.id));
    // A snippet whose group this window cannot see draws loose rather than
    // vanishing — the bridge keeps that `groupId` on purpose, and a row nobody can
    // reach would be worse than one in the wrong place.
    const loose = rows.filter(s => !s.groupId || !known.has(s.groupId));
    if (loose.length) cards.push({ group: null, rows: loose });
    return cards;
}

/**
 * Fill a body from the answers, and leave alone what it cannot answer.
 *
 * The bridge's `fillBody`, and the rule it enforces is worth restating where it is
 * duplicated: a placeholder with no answer falls back to its default and then to
 * itself, **never to the empty string**. `{{` is not reserved punctuation in
 * prose, and blanking what this does not recognise would quietly delete part of a
 * message somebody wrote.
 */
function fillSnipBody(body, params, answers) {
    const known = new Map((params || []).map(p => [p.name, p.default]));
    return String(body).replace(SNIP_PLACEHOLDER, (whole, key) => {
        if (!known.has(key)) return whole;
        const given = answers[key];
        if (given !== undefined && given !== null && given !== '') return String(given);
        const fallback = known.get(key);
        return fallback === null || fallback === undefined ? whole : fallback;
    });
}

// ── the popover ──────────────────────────────────────────────────────────

const snipRows = (c) => [...c.snips.node.querySelectorAll('.snip-row')];

/**
 * Place it, in fixed coordinates, against the button rather than the box.
 *
 * `positionMenu` cannot be reused as it stands: it anchors to `c.input` and gives
 * the popover the box's width, and this one hangs off a button and is deliberately
 * *wider* than its anchor, because the groups sit side by side. That is where the
 * clamp comes from — right-aligned to the button, then held inside the viewport,
 * which an anchored popover never had to express.
 *
 * Fixed for both composers rather than only the dialog's. The dialog's has to be,
 * since `.modal` is `overflow: hidden`; doing the same for the live one costs
 * nothing and means the arithmetic above lives in one place instead of two.
 */
function positionSnips(c) {
    const m = c.snips;
    const r = m.btn.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - r.bottom - gap * 2;
    const above = r.top - gap * 2;
    const up = below < 260 && above > below;

    const width = Math.min(720, window.innerWidth - 24);
    m.node.classList.toggle('up', up);
    m.node.style.setProperty('--snip-max',
        `${Math.max(180, Math.min(460, up ? above : below))}px`);
    m.node.style.width = `${width}px`;
    m.node.style.left = `${Math.max(12, Math.min(r.right - width,
        window.innerWidth - width - 12))}px`;
    if (up) {
        m.node.style.top = 'auto';
        m.node.style.bottom = `${window.innerHeight - r.top + gap}px`;
    } else {
        m.node.style.bottom = 'auto';
        m.node.style.top = `${r.bottom + gap}px`;
    }
}

function drawSnips(c) {
    const m = c.snips;
    const cards = snipCards(snipCwd(c));
    m.node.replaceChildren();

    if (!state.snippets.rows.length) {
        m.node.append(el('div', { class: 'snip-empty' },
            'No snippets yet. Add some in Settings.'));
    } else if (!cards.length) {
        // Told rather than shown as an empty list: a snippet hidden because you
        // are in the wrong directory is otherwise indistinguishable from one you
        // deleted, and that is a bad ten minutes.
        m.node.append(el('div', { class: 'snip-empty' },
            `None of your ${state.snippets.rows.length} snippets apply in this `
            + 'directory. Their project list is in Settings.'));
    }

    let i = 0;
    for (const card of cards) {
        const accent = snipAccent(card.group);
        const node = el('section', {
            class: card.group ? 'snip-card' : 'snip-card is-loose',
            style: accent ? `--snip-accent: ${accent}` : null,
        });
        if (card.group) {
            node.append(el('h3', { class: 'snip-card-name', text: card.group.name }));
        }
        for (const s of card.rows) {
            const at = i++;
            node.append(el('button', {
                class: 'snip-row', type: 'button', role: 'option',
                'data-i': at, tabindex: at === 0 ? 0 : -1,
                title: snipTitleFor(s, isBusy() && !state.agent, c),
                onclick: () => chooseSnippet(c, s),
                oncontextmenu: (e) => openSnipMenu(e, c, s),
            },
            el('span', { class: 'snip-row-title', text: s.title }),
            el('span', { class: 'snip-row-preview', text: snipPreview(s) })));
        }
        m.node.append(node);
    }
    paintSnipSel(c);
}

/**
 * The highlight, and which row Tab would land on.
 *
 * A roving `tabindex` rather than the `aria-activedescendant` the slash and
 * mention menus use, and the difference is not cosmetic: those keep the caret in
 * the textarea because the list filters as you type, and this one is opened by a
 * button with nothing being typed, so it takes focus like any other menu.
 */
function paintSnipSel(c) {
    const rows = snipRows(c);
    rows.forEach((r, i) => {
        r.setAttribute('aria-selected', String(i === c.snips.index));
        r.tabIndex = i === c.snips.index ? 0 : -1;
    });
}

function focusSnipAt(c, i) {
    const rows = snipRows(c);
    if (!rows.length) return;
    c.snips.index = Math.max(0, Math.min(i, rows.length - 1));
    paintSnipSel(c);
    rows[c.snips.index].focus();
}

function showSnips(c, on) {
    if (!on) { closeSnips(c); return; }
    const m = c.snips;
    // Taken before anything moves the focus. A textarea keeps its selection across
    // a blur, but only until something writes to `.value`, and "mostly" is not a
    // contract to build `insert: 'cursor'` on.
    markSnipCaret(c);
    // Only ever one popover up, per composer and across them.
    closeMenus(c);
    c.closeOthers();
    for (const other of composers) if (other !== c) closeSnips(other);
    for (const other of composers) if (other.wispr) closeWispr(other.wispr);

    m.index = 0;
    m.node.hidden = false;
    m.btn.setAttribute('aria-expanded', 'true');
    drawSnips(c);
    positionSnips(c);
    focusSnipAt(c, 0);
}

function closeSnips(c, { focus = false } = {}) {
    const m = c.snips;
    if (m.node.hidden) return;
    m.node.hidden = true;
    m.node.replaceChildren();
    m.btn.setAttribute('aria-expanded', 'false');
    if (focus) m.btn.focus();
}

/**
 * Arrows walk the rows, and Left and Right step between the cards.
 *
 * Up and Down alone would be a poor map for a popover whose whole point is that
 * groups sit beside each other: they run down one card and then jump to the top of
 * the next, so reaching the third group means walking through the first two.
 */
function onSnipsKey(e, c) {
    const rows = snipRows(c);
    if (!rows.length) return;
    const at = c.snips.index;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        focusSnipAt(c, (at + step + rows.length) % rows.length);
        return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const cards = [...c.snips.node.querySelectorAll('.snip-card')];
        const mine = cards.findIndex(card => card.contains(rows[at]));
        const next = cards[mine + (e.key === 'ArrowRight' ? 1 : -1)];
        if (!next) return;
        // The same depth in the next card where there is one, so walking sideways
        // through a row of groups stays on that row.
        const inMine = [...cards[mine].querySelectorAll('.snip-row')].indexOf(rows[at]);
        const there = [...next.querySelectorAll('.snip-row')];
        focusSnipAt(c, rows.indexOf(there[Math.min(inMine, there.length - 1)]));
        return;
    }
    if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focusSnipAt(c, e.key === 'Home' ? 0 : rows.length - 1);
        return;
    }
    // Tab closes and lets the focus go on, which is the recent-menu's rule.
    // Escape is handled by the central ladder, deliberately not here.
    if (e.key === 'Tab') closeSnips(c);
}

// ── choosing one ─────────────────────────────────────────────────────────

/** Where the selection is right now, for an `insert: 'cursor'` that happens later. */
function markSnipCaret(c) {
    c.snips.caret = { start: c.input.selectionStart, end: c.input.selectionEnd };
}

/**
 * The one way in: a row, a pinned button, Enter on a row, or the right-click menu.
 *
 * The caret is captured here as well as in `showSnips` because a pinned button
 * opens no popover — it is the case that would otherwise silently insert at the
 * end of the box instead of where you were.
 *
 * @param {object|null} over `{insert, autoSubmit}` for this one use, from the
 *   right-click menu. Spread over a *copy*: the rows in `state.snippets.rows` are
 *   what the popover, the pinned strip and the editor all draw from, and a stored
 *   decision must not move because somebody departed from it once.
 */
function chooseSnippet(c, s, over = null) {
    // Not re-taken for an override: `openSnipMenu` took it at the gesture, before
    // the menu pulled the focus off the box, which is the only moment it is true.
    if (!over && c.snips.node.hidden) markSnipCaret(c);
    closeSnips(c);
    const use = over ? { ...s, ...over } : s;
    if (use.params && use.params.length) openSnipFill(c, use);
    else applySnippet(c, use, {});
}

/**
 * Right-click: use this snippet once, some other way than the way it is set up.
 *
 * `insert` and `autoSubmit` are stored decisions, and until this there was no way to
 * depart from one for a single use — an LGTM button that sends is an LGTM button that
 * sends, and getting its text into the box to edit meant a round trip through
 * Settings and back.
 *
 * Five of the six combinations. `cursor` + send is the one left out: it says "put
 * this in the middle of what I typed and send the lot", which reads as a mistake
 * rather than an intention. The editor can still store it and a left-click still
 * honours it — this menu is not the definition of what a snippet may do.
 *
 * `permissionMode` is deliberately not offered. It is orthogonal to placement and is
 * read only on the send path, so a snippet that says "run this in plan mode" still
 * means it whenever it sends, and the three non-sending rows leave `#perm` alone
 * exactly as they leave the transcript alone.
 */
function openSnipMenu(ev, c, s) {
    ev.preventDefault();
    // The pinned-button case: no popover opened, so nothing else has recorded where
    // the caret was, and `openContextMenu` is about to take the focus.
    if (c.snips.node.hidden) markSnipCaret(c);

    const send = c === live
        ? ['Send it now', 'Add it to the end and send']
        : ['Start with this', 'Add it to the end and start'];
    const items = [
        { label: 'Replace what is in the box', over: { insert: 'overwrite', autoSubmit: false } },
        { label: 'Add it to the end', over: { insert: 'append', autoSubmit: false } },
        { label: 'Insert at the cursor', over: { insert: 'cursor', autoSubmit: false } },
        { label: send[0], over: { insert: 'overwrite', autoSubmit: true } },
        { label: send[1], over: { insert: 'append', autoSubmit: true } },
    ];
    openContextMenu(ev, items.map(it => ({
        label: it.label,
        onClick: () => chooseSnippet(c, s, it.over),
    })));
}

function openSnipFill(c, s) {
    state.snippets.fill = { snippet: s, composer: c };
    dom.snipFillTitle.textContent = s.title;
    dom.snipFillForm.replaceChildren(...s.params.map((p, i) => el('div', { class: 'field' },
        el('label', { for: `snip-p-${i}` }, p.label || p.name),
        el('input', {
            id: `snip-p-${i}`, 'data-name': p.name, autocomplete: 'off',
            required: p.required || null, value: p.default || '',
            ...(SNIP_INPUT[p.type] || SNIP_INPUT.text),
        }))));
    dom.snipFillScrim.hidden = false;
    const first = dom.snipFillForm.querySelector('input');
    if (first) { first.focus(); first.select(); }
}

/**
 * @returns {object|null} the answers, or null having said which box is empty.
 *   A `default` pre-fills and nothing more, so a required parameter with one is
 *   still a box you can clear and must then refill.
 */
function snipFillValues() {
    const out = {};
    for (const input of dom.snipFillForm.querySelectorAll('input')) {
        const v = input.value.trim();
        if (!v && input.required) {
            toast(`${input.previousElementSibling.textContent} is needed.`, 'warn');
            input.focus();
            return null;
        }
        out[input.dataset.name] = v;
    }
    return out;
}

function confirmSnipFill() {
    const held = state.snippets.fill;
    if (!held) return;
    const values = snipFillValues();
    if (!values) return;
    closeSnipFill();
    applySnippet(held.composer, held.snippet, values);
}

function closeSnipFill() {
    dom.snipFillScrim.hidden = true;
    dom.snipFillForm.replaceChildren();
    state.snippets.fill = null;
}

/**
 * Put the resolved text where the snippet says, and send it if it says to.
 *
 * The `straight` case is the one worth reading twice. An overwriting snippet that
 * sends itself, on the live composer, never writes to the box: the text goes to
 * `sendMessage` as an override, which is exactly what the LGTM button did and why
 * pressing it has never cost anybody a half-typed message. `overwrite` there
 * describes what would have happened had you not also asked for a send.
 *
 * The dialog is excluded from it because `startNew()` reads `#new-prompt` — there
 * is no override path into it — so everything there goes through the box.
 */
function applySnippet(c, s, values) {
    const text = fillSnipBody(s.body, s.params, values);
    const straight = s.autoSubmit && s.insert === 'overwrite' && c === live;
    if (!straight) insertSnippet(c, text, s.insert);
    if (s.autoSubmit) submitSnippet(c, s, text, straight);
}

function insertSnippet(c, text, how) {
    const v = c.input.value;
    if (how === 'overwrite') { insertAt(c, 0, v.length, text); return; }
    if (how === 'append') {
        // A blank line between, unless the box already ends in a break. Two
        // paragraphs run together read as one, and this is a message.
        const lead = !v ? '' : (v.endsWith('\n') ? '' : '\n\n');
        insertAt(c, v.length, v.length, lead + text);
        return;
    }
    const at = c.snips.caret || {};
    const from = Math.min(at.start == null ? v.length : at.start, v.length);
    const to = Math.min(Math.max(at.end == null ? from : at.end, from), v.length);
    insertAt(c, from, to, text);
}

function submitSnippet(c, s, text, straight) {
    if (c !== live) { startFromSnippet(s); return; }
    if (s.permissionMode) setPermMode(s.permissionMode);
    // `canned` is not what leaves the box alone — `override` is. It says only that
    // the text is not worth holding on a failure, which is true exactly when it
    // never came out of the box. Once it did, what would be dropped is something
    // somebody typed.
    if (straight) { sendMessage({ text, canned: true }); return; }
    // The insert may have opened the slash menu over a box that is about to empty.
    closeMenus(c);
    sendMessage();
}

/**
 * Move the permission selector, and hold it there.
 *
 * Writing `permChoice` is not optional bookkeeping. `paintPerm()` runs inside
 * `applyRunner`, which fires on the `runner-status` the send provokes moments
 * later — so without this the selector would visibly snap back to its computed
 * answer a beat after a snippet moved it. It is the same thing the `#perm` change
 * listener does, for the same reason: a mode is chosen for the conversation in
 * front of you, so it is remembered against that session.
 */
function setPermMode(mode) {
    if (![...dom.perm.options].some(o => o.value === mode)) return;
    dom.perm.value = mode;
    if (state.current) state.permChoice.set(state.current.sessionId, mode);
}

// The modes Ctrl+P (and Ctrl+Shift+P, backwards) will land you on, in the
// order the dropdown lists them.
// `dontAsk` and `bypassPermissions` are deliberately not in it: both hand the
// agent something back, and a chord pressed one time too many is not a decision
// to do that. Neither is hidden — they are still in the dropdown, and a session
// already in one cycles *out* of it like any other, which is the direction that
// should be easy.
const CYCLE_PERM = ['acceptEdits', 'auto', 'manual', 'plan'];

/**
 * Advance a `<select>` to its next value, wrapping.
 *
 * @param {HTMLSelectElement} sel
 * @param {string[]|null} allow the values a cycle may stop on, or null for all
 * @param {1|-1} [step] which way to walk: 1 for the next value, -1 for the
 *   previous, which is what the Shift variant of each chord asks for
 *
 * Walks from where the select is now rather than from an index kept alongside
 * it, so the chord and the dropdown can never disagree about what "next" means
 * — including after the mouse has moved it, and after paintPerm/paintModel have
 * moved it on the window's behalf.
 *
 * Two things fall out of walking the options rather than the allow-list. A
 * value that is not in `allow` at all still has a next — `bypassPermissions`
 * wraps to `acceptEdits` — so there is always a way out of one. And a select
 * offering none of `allow` is left alone rather than blanked, which is the same
 * refusal paintPerm makes about a mode this build does not know.
 *
 * The `change` event is dispatched rather than the bookkeeping repeated here:
 * the listeners above are what remember a choice against a session, and a chord
 * that skipped them would be a second way to set these controls that forgets
 * what the first one records.
 *
 * `keyboard.cycleOrder` decides what "next" means. Alphabetical sorts by the
 * label rather than the value, since the label is what you are reading, and
 * keeps an empty value — the model's "inherit" — first, because it is the
 * absence of a choice rather than one more name to file among the others.
 */
function cycleSelect(sel, allow, step = 1) {
    const opts = [...sel.options];
    if (BOOT_PREFS.keyboard.cycleOrder === 'alphabetical') {
        const label = o => o.textContent.trim();
        opts.sort((a, b) => (b.value === '') - (a.value === '')
            || label(a).localeCompare(label(b), undefined, { sensitivity: 'base' }));
    }
    const n = opts.length;
    // A value the select does not list has no index; walking back from -1 would
    // skip the last option, so start that walk just past the end instead.
    let at = opts.findIndex(o => o.value === sel.value);
    if (at < 0 && step < 0) at = n;
    for (let i = 1; i <= n; i++) {
        const o = opts[((at + i * step) % n + n) % n];
        if (allow && !allow.includes(o.value)) continue;
        if (o.value === sel.value) break;    // nothing else to move to
        sel.value = o.value;
        sel.dispatchEvent(new Event('change'));
        flashNode(sel);
        return;
    }
}

/**
 * Auto-submit, in the dialog that has no Send.
 *
 * It presses Start. A snippet that says `autoSubmit` means "I do not want to look
 * at this again", and honouring that in one of the two places a snippet can be
 * used and not the other is the kind of difference nobody discovers until it has
 * cost them something.
 *
 * It is safe to be that literal because it refuses exactly where the Start button
 * refuses: `newDialogValues()` already toasts for a missing directory and an empty
 * message, so the only way to reach a process is from a dialog that was one click
 * from starting one anyway.
 *
 * The mode is written whether or not the start happens — "this prompt runs in plan
 * mode" is a fact about the snippet, worth seeing even when you are going to press
 * Start yourself. There is no `permChoice` here: `#new-perm` is the whole of that
 * control's state, and `openNew` rewrites it on every open.
 */
function startFromSnippet(s) {
    if (s.permissionMode
        && [...dom.newPerm.options].some(o => o.value === s.permissionMode)) {
        dom.newPerm.value = s.permissionMode;
    }
    if (!newDialogValues()) return;
    startNew();
}

// ── the pinned buttons ───────────────────────────────────────────────────

/**
 * What a button will actually do, said before the click rather than after.
 *
 * The two prefixes are what `LGTM_TITLE` and `LGTM_TITLE_BUSY` used to be, now
 * that the sentence after them comes from the snippet instead of from this file.
 * `hint` is that sentence where a snippet has one, because the first line of a
 * body is a guess and LGTM's wording was not.
 */
function snipTitleFor(s, busy, c = live) {
    const what = s.hint || snipPreview(s);
    const lead = !s.autoSubmit ? 'Put this in the message box'
        : c !== live ? 'Fill the message in and press Start'
            : busy ? 'Queue behind the running turn' : 'Send';
    // The override menu is otherwise undiscoverable: nothing about a button that
    // sends says the sending is a setting rather than the whole of what it is.
    return `${lead}: ${what}\nRight-click for other ways to use it.`;
}

/**
 * A button per pinned snippet, beside the snippets icon.
 *
 * Rebuilt whole rather than diffed: it is a handful of buttons, and it only
 * changes when somebody edits a snippet or the open session moves to a different
 * directory. That second one is why this is called from `openSession` as well —
 * a snippet scoped to a project appears and disappears as you switch conversations.
 *
 * Disabled from `dom.btnSend` rather than from state, so there is one answer to
 * "can this session be sent to" and a repaint cannot briefly draw a live button
 * into a window with no session in it.
 */
export function renderPins() {
    const cwd = state.current && state.current.cwd;
    const busy = isBusy() && !state.agent;
    // Already in display order: the bridge decides it, so the strip, the popover
    // and the editor cannot disagree.
    const rows = state.snippets.rows.filter(s => s.pinned && snipVisible(s, cwd));
    const group = new Map(state.snippets.groups.map(g => [g.id, g]));
    dom.pins.replaceChildren(...rows.map((s) => {
        const accent = snipAccent(group.get(s.groupId));
        return el('button', {
            class: 'btn-pin-snip', type: 'button', 'data-snip': s.id,
            style: accent ? `--snip-accent: ${accent}` : null,
            disabled: dom.btnSend.disabled || null,
            title: snipTitleFor(s, busy),
            onclick: () => chooseSnippet(live, s),
            oncontextmenu: (e) => openSnipMenu(e, live, s),
        }, s.title);
    }));
}

/** Re-say it when the runner state changes, without rebuilding the strip. */
function paintPinTitles(busy) {
    for (const b of dom.pins.children) {
        const s = snipById(b.dataset.snip);
        if (s) b.title = snipTitleFor(s, busy);
    }
}

// ── the editor, in Settings ──────────────────────────────────────────────
//
// A group in the settings panel rather than a panel of its own, using the `node`
// hatch `SETTINGS` already has for the two groups that are not backed by the
// settings file. This is a third such group, and the note in the markup says so
// out loud the way the Notifications one does: the scope picker at the top of the
// panel means nothing here.
//
// **`after` fires on every unrelated save**, twice — `renderSettings` runs before
// and after each `saveSetting` — so everything here has to be cheap and nothing
// may eat a half-typed value. That is why the inline name box commits on `change`
// rather than per keystroke, which is the rule `settingControl`'s `path` row
// already follows for its own reason.

/** How long a delete button offers to be sure. armForce's window and its idea. */
const SNIP_ARM_MS = 4000;

export function renderSnipSettings() {
    if (!dom.snipSettingsBody) return;
    const rows = state.snippets.rows;
    const groups = state.snippets.groups;
    const known = new Set(groups.map(g => g.id));
    dom.snipSettingsBody.replaceChildren();

    for (const g of groups) {
        dom.snipSettingsBody.append(
            snipSettingsGroup(g, rows.filter(s => s.groupId === g.id)));
    }
    const loose = rows.filter(s => !s.groupId || !known.has(s.groupId));
    // The ungrouped block is drawn even when it is empty, because it is where a
    // drag has to be able to drop a snippet to take it out of a group.
    dom.snipSettingsBody.append(snipSettingsGroup(null, loose));

    if (!rows.length && !groups.length) {
        dom.snipSettingsBody.append(el('p', { class: 'settings-group-note' },
            'Nothing yet. A snippet is a message you send often — the text, what to '
            + 'ask for before sending it, and whether it sends itself.'));
    }
}

function snipSettingsGroup(g, rows) {
    const accent = snipAccent(g);
    const head = el('div', { class: 'snip-set-head' });

    if (g) {
        head.append(
            el('span', { class: 'snip-grip', title: 'Drag to reorder' }, icon('grip', 14)),
            el('input', {
                class: 'snip-set-name', type: 'text', value: g.name,
                'aria-label': 'Group name',
                // On change, not on input: this is redrawn by every unrelated
                // settings save, and a per-keystroke commit would race that.
                onchange: (e) => saveSnipGroup(g.id, { name: e.target.value.trim() || g.name }),
            }),
            el('input', {
                class: 'snip-set-accent', type: 'color', value: accent || '#9aa0a6',
                'aria-label': 'Group colour', title: 'Group colour',
                onchange: (e) => saveSnipGroup(g.id, { accent: e.target.value }),
            }),
            ...snipMoveButtons('group', g.id),
            snipDeleteButton('Delete this group', () => deleteSnipGroup(g)));
    } else {
        head.append(el('span', { class: 'snip-set-loose', text: 'Ungrouped' }));
    }

    const list = el('div', {
        class: 'snip-set-list', 'data-group': g ? g.id : '',
        ondragover: (e) => onSnipDragOver(e, list),
        ondrop: (e) => e.preventDefault(),
    }, rows.map(s => snipSettingsRow(s)));

    return el('section', {
        class: g ? 'snip-set-group' : 'snip-set-group is-loose',
        style: accent ? `--snip-accent: ${accent}` : null,
    },
    head,
    list,
    el('div', { class: 'snip-set-foot' },
        el('button', {
            class: 'linkish', type: 'button',
            onclick: () => openSnipEditor(null, g ? g.id : null),
        }, 'Add a snippet here')));
}

function snipSettingsRow(s) {
    const badges = [];
    if (s.pinned) badges.push('pinned');
    if (s.autoSubmit) badges.push(s.permissionMode ? `sends · ${s.permissionMode}` : 'sends');
    if (s.insert !== 'overwrite') badges.push(s.insert);
    if (s.params.length) badges.push(`${s.params.length} to fill in`);
    if (s.projects.length) badges.push(`${s.projects.length} project${s.projects.length > 1 ? 's' : ''}`);
    // Reported rather than refused, in both directions — see the bridge's
    // scanPlaceholders. The editor is where it is explained; this is the hint that
    // sends you there.
    if (s.undeclared.length) badges.push(`${s.undeclared.length} unasked`);

    const row = el('div', {
        class: 'snip-set-row', draggable: 'true', 'data-snip': s.id,
        ondragstart: (e) => onSnipDragStart(e, s.id),
        ondragend: () => commitSnipOrder(),
    },
    el('span', { class: 'snip-grip', title: 'Drag to reorder' }, icon('grip', 14)),
    el('div', { class: 'snip-set-text' },
        el('div', { class: 'snip-set-title', text: s.title }),
        el('div', { class: 'snip-set-preview', text: snipPreview(s) })),
    el('div', { class: 'snip-set-badges' },
        ...badges.map(b => el('span', { class: 'snip-badge', text: b }))),
    ...snipMoveButtons('snippet', s.id),
    el('button', { class: 'btn small', type: 'button', onclick: () => openSnipEditor(s) }, 'Edit'),
    snipDeleteButton('Delete this snippet', () => deleteSnippet(s)));
    return row;
}

/**
 * The arrows, which do what the drag does and are the whole of it for a keyboard.
 *
 * They move the row in the DOM and then commit the arrangement the same way a
 * drop does, so there is one path to the bridge rather than two. Focus is put back
 * on the button after the redraw, so holding one keeps walking the same row rather
 * than pressing whatever landed underneath.
 */
function snipMoveButtons(kind, id) {
    return [-1, 1].map(step => el('button', {
        class: 'snip-move', type: 'button',
        'aria-label': step < 0 ? 'Move up' : 'Move down',
        title: step < 0 ? 'Move up' : 'Move down',
        onclick: () => moveSnipRow(kind, id, step),
    }, step < 0 ? '↑' : '↓'));
}

function moveSnipRow(kind, id, step) {
    const sel = kind === 'group' ? '.snip-set-group' : '.snip-set-row';
    const attr = kind === 'group' ? 'data-group' : 'data-snip';
    const node = kind === 'group'
        ? dom.snipSettingsBody.querySelector(`.snip-set-list[data-group="${CSS.escape(id)}"]`)
            .closest('.snip-set-group')
        : dom.snipSettingsBody.querySelector(`[${attr}="${CSS.escape(id)}"]`);
    if (!node) return;

    const siblings = [...node.parentElement.querySelectorAll(`:scope > ${sel}`)]
        // The ungrouped block is not a group anybody ordered, and it is always last.
        .filter(n => !n.classList.contains('is-loose') || kind !== 'group');
    const at = siblings.indexOf(node);
    const to = at + step;
    if (at < 0 || to < 0 || to >= siblings.length) return;

    if (step < 0) node.parentElement.insertBefore(node, siblings[to]);
    else node.parentElement.insertBefore(siblings[to], node);
    commitSnipOrder();
}

function onSnipDragStart(e, id) {
    state.snippets.drag = id;
    e.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag without something on the transfer.
    e.dataTransfer.setData('text/plain', id);
}

/**
 * Move the row under the cursor as the drag goes, rather than only on the drop.
 *
 * The queue's idiom, and its reason: the list you are looking at is the answer, so
 * you should be able to see it before you let go. Dropping into another group's
 * list is a move between groups as well as a reorder, which `commitSnipOrder`
 * picks up from where the row ends rather than from the drag itself.
 */
function onSnipDragOver(e, list) {
    const id = state.snippets.drag;
    if (!id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const moving = dom.snipSettingsBody.querySelector(`.snip-set-row[data-snip="${CSS.escape(id)}"]`);
    if (!moving) return;

    const after = [...list.querySelectorAll('.snip-set-row')]
        .filter(n => n !== moving)
        .find((n) => {
            const box = n.getBoundingClientRect();
            return e.clientY < box.top + box.height / 2;
        });
    if (after) list.insertBefore(moving, after);
    else list.append(moving);
}

/**
 * Tell the bridge what the DOM now says, and let the push redraw it.
 *
 * Read out of the DOM rather than tracked in state, which is `commitQueueOrder`'s
 * bargain: the thing on screen is what was arranged, so reading it back cannot
 * disagree with what somebody saw. A snippet that ended up in a different list is
 * patched first — its `groupId` is part of where it is, and reordering it into a
 * group it does not belong to would put it back on the next redraw.
 */
async function commitSnipOrder() {
    state.snippets.drag = null;
    const moves = [];
    const ids = [];
    for (const list of dom.snipSettingsBody.querySelectorAll('.snip-set-list')) {
        const groupId = list.dataset.group || null;
        for (const row of list.querySelectorAll('.snip-set-row')) {
            const s = snipById(row.dataset.snip);
            ids.push(row.dataset.snip);
            if (s && (s.groupId || null) !== groupId) moves.push({ id: s.id, groupId });
        }
    }
    const groups = [...dom.snipSettingsBody.querySelectorAll('.snip-set-group:not(.is-loose)')]
        .map(n => n.querySelector('.snip-set-list').dataset.group);

    try {
        for (const m of moves) await patch(`/api/snippets/${m.id}`, { groupId: m.groupId });
        await post('/api/snippets/reorder', { snippets: ids, groups });
    } catch (err) {
        toast(`Could not save the order: ${err.message}`, 'error');
        // Back to what the bridge has, rather than leaving the screen claiming an
        // arrangement that was refused.
        renderSnipSettings();
    }
}

/**
 * A delete that asks once, in the button, rather than behind a third dialog.
 *
 * `armForce`'s idea: the second press within a few seconds is the confirmation.
 * A scrim for this would be heavier than what is being deleted — a snippet is a
 * paragraph you can write again, which is drafts' argument for having no dialog at
 * all, and this is one step more careful than that because a snippet is one you
 * tuned rather than one you just wrote.
 */
export function snipDeleteButton(label, go) {
    let armed = 0;
    const b = el('button', {
        class: 'snip-del', type: 'button', 'aria-label': label, title: label,
        onclick: () => {
            if (Date.now() - armed < SNIP_ARM_MS) { go(); return; }
            armed = Date.now();
            b.textContent = 'Really?';
            b.classList.add('armed');
            setTimeout(() => {
                if (Date.now() - armed < SNIP_ARM_MS) return;
                b.replaceChildren(icon('trash', 13));
                b.classList.remove('armed');
            }, SNIP_ARM_MS + 50);
        },
    }, icon('trash', 13));
    return b;
}

async function deleteSnippet(s) {
    try { await del(`/api/snippets/${s.id}`); }
    catch (err) { toast(`Could not delete the snippet: ${err.message}`, 'error'); }
}

async function deleteSnipGroup(g) {
    try {
        const r = await del(`/api/snippet-groups/${g.id}`);
        // Said rather than left to be noticed: deleting a heading does not delete
        // what was under it, and a block of snippets moving to Ungrouped is a big
        // enough change to announce.
        if (r.orphaned) {
            toast(`${r.orphaned} snippet${r.orphaned > 1 ? 's' : ''} moved to Ungrouped.`);
        }
    } catch (err) {
        toast(`Could not delete the group: ${err.message}`, 'error');
    }
}

async function newSnipGroup() {
    try { await post('/api/snippet-groups', { name: 'New group', accent: '#a8c7fa' }); }
    catch (err) { toast(`Could not make the group: ${err.message}`, 'error'); }
}

async function saveSnipGroup(id, fields) {
    try { await patch(`/api/snippet-groups/${id}`, fields); }
    catch (err) { toast(`Could not save the group: ${err.message}`, 'error'); }
}

// ── one snippet, in the editor dialog ────────────────────────────────────

/** The parameter rows as they are being edited, before anything is saved. */
let snipDraftParams = [];
/** The project paths likewise. Held here so a redraw of the rows keeps them. */
let snipDraftProjects = [];

function openSnipEditor(s, groupId = null) {
    state.snippets.editing = s ? s.id : null;
    dom.snipEditTitle.textContent = s ? 'Edit snippet' : 'New snippet';
    dom.snipTitle.value = s ? s.title : '';
    dom.snipBody.value = s ? s.body : '';
    dom.snipInsert.value = s ? s.insert : 'overwrite';
    dom.snipAuto.checked = s ? s.autoSubmit : false;
    dom.snipPerm.value = s ? (s.permissionMode || '') : '';
    dom.snipPinned.checked = s ? s.pinned : false;
    snipDraftParams = s ? s.params.map(p => ({ ...p })) : [];
    snipDraftProjects = s ? [...s.projects] : [];

    dom.snipGroup.replaceChildren(
        el('option', { value: '', text: 'Ungrouped' }),
        ...state.snippets.groups.map(g => el('option', { value: g.id }, g.name)));
    dom.snipGroup.value = s ? (s.groupId || '') : (groupId || '');

    dom.snipProjectList.replaceChildren(...state.settings.projects
        .map(p => el('option', { value: p.cwd })));

    renderSnipParamRows();
    renderSnipProjects();
    paintSnipPerm();
    paintSnipPlaceholders();
    dom.snipEditScrim.hidden = false;
    dom.snipTitle.focus();
}

function closeSnipEditor() {
    dom.snipEditScrim.hidden = true;
    state.snippets.editing = null;
    snipDraftParams = [];
    snipDraftProjects = [];
}

/** The mode only means anything on a send, so it appears with one. */
function paintSnipPerm() {
    dom.snipPermRow.hidden = !dom.snipAuto.checked;
}

/**
 * What the body and the parameters say about each other.
 *
 * A note in both directions and a refusal in neither, which is the bridge's rule
 * restated where somebody can act on it: an undeclared `{{x}}` reaches the session
 * as itself, and a parameter nothing references is a field you have not wired up
 * yet. Saying so is the difference between a bug you can see and one you meet
 * three sessions later.
 */
function paintSnipPlaceholders() {
    const declared = new Set(snipDraftParams.map(p => p.name).filter(Boolean));
    const used = new Set();
    for (const m of dom.snipBody.value.matchAll(SNIP_PLACEHOLDER)) used.add(m[1]);
    const undeclared = [...used].filter(n => !declared.has(n));
    const unused = [...declared].filter(n => !used.has(n));

    const said = [];
    if (undeclared.length) {
        said.push(`${undeclared.map(n => `{{${n}}}`).join(', ')} `
            + `${undeclared.length > 1 ? 'are' : 'is'} in the message but not asked for — `
            + `${undeclared.length > 1 ? 'they' : 'it'} will be sent as written.`);
    }
    if (unused.length) {
        said.push(`${unused.join(', ')} ${unused.length > 1 ? 'are' : 'is'} asked for but `
            + 'never used in the message.');
    }
    dom.snipPlaceholders.hidden = !said.length;
    dom.snipPlaceholders.textContent = said.join(' ');
}

function renderSnipParamRows() {
    dom.snipParams.replaceChildren(...snipDraftParams.map((p, i) => el('div', { class: 'snip-param' },
        el('input', {
            class: 'snip-param-name', type: 'text', value: p.name, placeholder: 'name',
            'aria-label': 'Parameter name', spellcheck: 'false',
            oninput: (e) => { snipDraftParams[i].name = e.target.value.trim(); paintSnipPlaceholders(); },
        }),
        el('input', {
            class: 'snip-param-label', type: 'text', value: p.label || '', placeholder: 'Label',
            'aria-label': 'Parameter label',
            oninput: (e) => { snipDraftParams[i].label = e.target.value; },
        }),
        el('select', {
            class: 'snip-param-type', 'aria-label': 'Parameter type',
            onchange: (e) => { snipDraftParams[i].type = e.target.value; },
        }, ['text', 'integer', 'decimal', 'date', 'time', 'datetime'].map(t => el('option', {
            value: t, selected: t === p.type || null,
        }, t))),
        el('input', {
            class: 'snip-param-default', type: 'text', value: p.default || '',
            placeholder: 'Default', 'aria-label': 'Default value',
            oninput: (e) => { snipDraftParams[i].default = e.target.value; },
        }),
        el('label', { class: 'snip-check', title: 'Must not be left empty' },
            el('input', {
                type: 'checkbox', checked: p.required || null,
                onchange: (e) => { snipDraftParams[i].required = e.target.checked; },
            }),
            el('span', { class: 'settings-box' }),
            el('span', { class: 'snip-param-req', text: 'needed' })),
        el('button', {
            class: 'snip-del', type: 'button', 'aria-label': 'Remove this parameter',
            onclick: () => {
                snipDraftParams.splice(i, 1);
                renderSnipParamRows();
                paintSnipPlaceholders();
            },
        }, icon('trash', 13)))));
}

function renderSnipProjects() {
    dom.snipProjects.replaceChildren(...snipDraftProjects.map((p, i) => el('span', { class: 'snip-chip' },
        el('span', { text: shortPath(p) }),
        el('button', {
            class: 'snip-chip-x', type: 'button', 'aria-label': `Remove ${p}`,
            onclick: () => { snipDraftProjects.splice(i, 1); renderSnipProjects(); },
        }, '✕'))));
}

function addSnipProject() {
    const dir = dom.snipProject.value.trim();
    if (!dir) return;
    if (!snipDraftProjects.includes(dir)) snipDraftProjects.push(dir);
    dom.snipProject.value = '';
    renderSnipProjects();
}

/**
 * @returns {object|null} the body to send, or null having said what is wrong.
 *   The bridge refuses all of this too — this is so the answer arrives beside the
 *   box rather than as a toast about a request.
 */
function readSnipEditor() {
    const title = dom.snipTitle.value.trim();
    const body = dom.snipBody.value;
    if (!title) { toast('Give it a title.', 'warn'); dom.snipTitle.focus(); return null; }
    if (!body.trim()) { toast('Give it a message.', 'warn'); dom.snipBody.focus(); return null; }

    const seen = new Set();
    for (const p of snipDraftParams) {
        if (!/^[A-Za-z_]\w*$/.test(p.name || '')) {
            toast(`"${p.name || ''}" is not a usable parameter name — letters, digits `
                + 'and underscores, not starting with a digit.', 'warn');
            return null;
        }
        if (seen.has(p.name)) {
            toast(`Two parameters are both called "${p.name}".`, 'warn');
            return null;
        }
        seen.add(p.name);
    }

    return {
        title,
        body,
        groupId: dom.snipGroup.value || null,
        params: snipDraftParams,
        insert: dom.snipInsert.value,
        autoSubmit: dom.snipAuto.checked,
        // Only meaningful with a send, but kept either way, so unticking Send and
        // ticking it again does not lose the mode you picked.
        permissionMode: dom.snipPerm.value || null,
        pinned: dom.snipPinned.checked,
        projects: snipDraftProjects,
    };
}

async function saveSnipEditor() {
    const body = readSnipEditor();
    if (!body) return;
    const id = state.snippets.editing;
    dom.snipSave.disabled = true;
    try {
        if (id) await patch(`/api/snippets/${id}`, body);
        else await post('/api/snippets', body);
        closeSnipEditor();
    } catch (err) {
        toast(`Could not save the snippet: ${err.message}`, 'error');
    } finally {
        dom.snipSave.disabled = false;
    }
}

// ── schedules ────────────────────────────────────────────────────────────
//
// Sessions that start on a clock.
//
// Drafts' machinery throughout — an unconditional `schedules-changed` push, no
// watcher gate, no card ranks — because it is the same kind of thing: a create
// call the bridge is holding. The difference is only who presses Start.
//
// **What the card has to answer is not what a draft's card answers.** A draft is
// read to decide whether to release it, so its card shows the message. A schedule
// has already been released; you come here to find out whether it is still
// working. So the card leads with when it next runs and what the last run found,
// and the prompt is secondary — it is the one screen in this app whose job is to
// notice that something has quietly stopped happening.
//
// `nextRunAt`, `cronText` and `spent` are computed by the bridge, not here. Three
// clients read this API and none of them should be reimplementing a cron parser to
// draw a card — the one that runs the schedule is the one that should say when it
// runs, and whether it is ever going to again.
//
// **The panel is a column per project, each column stacked into Active, Paused
// and Done.** Drafts' column shape (`renderDrafts`) for the horizontal half, for
// the reason it gives — sub-headings inside one column read as one long list once
// the rows come from five worktrees. The stacking is what makes that safe here:
// the objection this panel used to carry, that splitting by directory would put
// two dead schedules in two different columns, only holds while a dead schedule is
// loose in a list. Under a counted heading it is the first thing the column says.

function showSched(on) {
    state.sched.open = on;
    if (on) closeOtherPanels('sched');
    paintPanels();
    syncBoardWatch();
    // As in showDrafts: this panel has no watch of its own, but it closes the
    // task board, whose ~3s tick on the bridge only stops when somebody says
    // they have stopped watching.
    syncTaskboardWatch();

    if (on) {
        renderSched();
        if (!state.sched.at) loadSched();
    } else if (state.live.open) {
        renderLive();
        if (state.current) termPane.refit();
    } else if (state.current) {
        termPane.refit();
    }
    rememberView();
}

const schedVisible = () => state.sched.open;

function applySched(data) {
    state.sched.rows = data.schedules || [];
    state.sched.at = data.at || Date.now();
    state.sched.error = null;
    paintSchedBadge();
    if (schedVisible()) renderSched();
}

async function loadSched() {
    if (state.sched.loading) return;
    state.sched.loading = true;
    try {
        const data = await get('/api/schedules');
        state.sched.loading = false;
        applySched(data);
    } catch (err) {
        state.sched.loading = false;
        state.sched.error = err.message;
        if (schedVisible()) renderSched();
    }
}

/**
 * How many schedules are armed.
 *
 * Armed, not stored: a paused schedule is a decision you already made and is not
 * news, and neither is one that has finished. `enabled` alone would count a row
 * whose expression can never match again — armed, and never going to fire — so
 * the badge and the Active band agree by asking the same question.
 *
 * Never `urgent` — a schedule that needs attention says so through a
 * notification, which is the surface that can reach you when this window is shut.
 */
export function paintSchedBadge() {
    const n = state.sched.rows.filter(s => s.enabled && !s.spent).length;
    dom.schedBadge.hidden = !n;
    dom.schedBadge.textContent = String(n);
    dom.btnSched.title = keys.hint(n
        ? `${n} schedule${n === 1 ? '' : 's'} armed`
        : 'Sessions that start on a clock', 'view.schedules');
}

// ── drawing it ───────────────────────────────────────────────────────────

function renderSched() {
    const rows = state.sched.rows;
    const groups = schedGroups(rows);
    // Below two projects a column is a column with nothing to be told apart from,
    // which is only a narrower list — the drafts board's threshold and its
    // argument. The bands stay either way: they are about the schedules, not
    // about how many directories they came out of.
    const cols = groups.size >= 2;

    dom.schedSub.textContent = rows.length
        ? schedSummary(rows, cols ? groups.size : 0)
        : 'Sessions that start on a clock.';

    if (state.sched.error) {
        dom.schedBody.classList.remove('cols');
        dom.schedBody.replaceChildren(el('div', { class: 'dr-note' },
            el('p', {}, `Could not read the schedules. ${state.sched.error}`)));
        return;
    }

    const scroll = dom.schedBody.scrollTop;

    if (!rows.length) {
        dom.schedBody.classList.remove('cols');
        dom.schedBody.replaceChildren(el('div', { class: 'dr-note' },
            el('p', {}, 'Nothing scheduled yet.'),
            el('p', { class: 'dim' }, 'A schedule is a session that starts on its own '
                + '— an overnight review, a nightly sweep. It can be told to run only '
                + 'when a branch has new commits, and the range since its last run is '
                + 'available to the prompt.'),
            el('button', {
                class: 'tb-btn primary', type: 'button',
                onclick: () => openNew({ schedule: true }),
            }, 'New schedule')));
        return;
    }

    if (!cols) {
        // One project, one scrolling column — and its own scroll position held,
        // because `schedules-changed` arrives while nobody has touched anything.
        dom.schedBody.classList.remove('cols');
        const [name] = [...groups.keys()];
        dom.schedBody.replaceChildren(...schedBands(rows, name));
        dom.schedBody.scrollTop = scroll;
        return;
    }

    // Each column scrolls on its own and the row of them scrolls sideways, so a
    // rebuild throws away as many positions as there are projects unless every
    // one is carried across — `renderDrafts`'s problem and its answer, and a
    // sharper version of it here: this payload is pushed when a run starts or an
    // outcome lands, so the rebuild that loses your place is one nobody asked
    // for. Keyed by project rather than by position, so a column that has just
    // moved left keeps its own place rather than inheriting its neighbour's.
    const scrolls = new Map();
    for (const c of dom.schedBody.querySelectorAll('.tb-col-body')) {
        scrolls.set(c.dataset.project, c.scrollTop);
    }
    const across = dom.schedBody.scrollLeft;

    dom.schedBody.classList.add('cols');
    dom.schedBody.replaceChildren(
        ...[...groups].map(([name, list]) => schedColumn(name, list)));

    for (const c of dom.schedBody.querySelectorAll('.tb-col-body')) {
        if (scrolls.has(c.dataset.project)) c.scrollTop = scrolls.get(c.dataset.project);
    }
    dom.schedBody.scrollLeft = across;
}

/**
 * The schedules, by project.
 *
 * **The order of the keys is the order of the columns, and it needs no sort** —
 * `draftGroups` makes the argument at length and it holds identically here:
 * `schedules.list()` is newest-`updatedAt` first, `updatedAt` moves on a create
 * as well as an edit, and a Map keeps the order its keys were first seen in. So
 * one walk lands the projects most-recently-touched first. An object keyed by
 * name would not hold that, and neither would a second pass sorting by anything
 * else.
 *
 * `projectName` comes off the payload rather than being derived here, so every
 * client agrees about which project a directory belongs to.
 */
function schedGroups(rows) {
    const groups = new Map();
    for (const s of rows) {
        const name = s.projectName || 'unknown';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(s);
    }
    return groups;
}

// The three stacks, in the order they are drawn. Active first because it is what
// the panel is for; Done last because it is the half that only grows.
const SCHED_BANDS = [
    { key: 'active', label: 'Active' },
    { key: 'paused', label: 'Paused' },
    { key: 'done', label: 'Done' },
];

/**
 * Which stack a schedule belongs in.
 *
 * `spent` before `enabled`, because a spent one-time schedule is *always*
 * disabled — the bridge clears the flag itself when the slot passes — so reading
 * `enabled` first would file every finished schedule under Paused and say it was
 * waiting for you.
 *
 * The sweep check is first and is not a nicety. A one-time `open-prs` schedule is
 * spent the moment its slot is taken, and then spends the next hour actually
 * reviewing pull requests; without this the only schedule in the app that is
 * doing something would be filed under Done and folded out of sight. `docs/api.md`
 * calls `enabled: false` with an open window a real, transient state, and this is
 * the client end of that.
 */
function schedBand(s) {
    if (s.reviewsInFlight || (s.sweepUntil && s.sweepUntil > Date.now())) return 'active';
    if (s.spent) return 'done';
    if (!s.enabled) return 'paused';
    return 'active';
}

/** The sub-line: what is in the panel, counted the way the bands count it. */
function schedSummary(rows, projects) {
    const n = { active: 0, paused: 0, done: 0 };
    for (const s of rows) n[schedBand(s)]++;
    // Only the non-zero clauses, so a healthy list reads "4 schedules — 4 active."
    // rather than carrying two zeroes it wants you to ignore.
    const parts = [
        n.active ? `${n.active} active` : null,
        n.paused ? `${n.paused} paused` : null,
        n.done ? `${n.done} finished` : null,
    ].filter(Boolean);
    const head = `${rows.length} schedule${rows.length === 1 ? '' : 's'}`
        + (projects ? ` across ${projects} projects` : '');
    return `${head} — ${parts.join(', ')}.`;
}

/**
 * One project, as a column.
 *
 * `draftColumn`'s chrome — `tb-col`, `tb-col-head`, `tb-count`, `tb-col-body` —
 * for the same reason it borrowed it from the task board: the shape exists, and a
 * column here means a place rather than a state, so it takes none of the board's
 * per-column colour. What is stacked inside it is this panel's own.
 */
function schedColumn(name, list) {
    return el('section', { class: 'tb-col sched-col', 'data-project': name },
        el('header', { class: 'tb-col-head' },
            el('h2', { title: name }, name),
            el('span', { class: 'tb-count' }, String(list.length)),
        ),
        el('div', { class: 'tb-col-body', 'data-project': name },
            ...schedBands(list, name),
        ),
    );
}

/**
 * One project's schedules, stacked Active / Paused / Done.
 *
 * **Headings are dropped when Active is the only band with anything in it**,
 * which is the ordinary case and the one where a heading says nothing — the same
 * argument the column threshold makes one level up. A column of only *paused* or
 * only *done* rows keeps its heading, because "everything here has stopped" is
 * exactly what this panel exists to make impossible to miss.
 *
 * Done is a button rather than a heading, shut by default and shut again on the
 * next render unless you opened it. It is the band that only grows: every spent
 * one-time schedule lands there and nothing takes it out, so left open it would
 * bury the two live rows above it within a month of use.
 */
function schedBands(list, project) {
    const filled = SCHED_BANDS
        .map(b => ({ ...b, rows: list.filter(s => schedBand(s) === b.key) }))
        .filter(b => b.rows.length);
    const bare = filled.length === 1 && filled[0].key === 'active';

    return filled.map((b) => {
        if (bare) return el('div', { class: 'sched-band', 'data-band': b.key }, b.rows.map(schedCard));
        if (b.key !== 'done') {
            return el('div', { class: 'sched-band', 'data-band': b.key },
                el('h3', { class: 'tb-sub-head' }, b.label, el('span', {}, String(b.rows.length))),
                b.rows.map(schedCard));
        }
        const open = state.sched.openDone.has(project);
        return el('div', { class: 'sched-band', 'data-band': 'done' },
            el('button', {
                class: 'tb-sub-head sched-band-head', type: 'button',
                'aria-expanded': String(open),
                title: open ? 'Hide the schedules that have finished'
                    : 'Show the schedules that have finished',
                onclick: () => {
                    state.sched.openDone[open ? 'delete' : 'add'](project);
                    renderSched();
                },
            },
                el('span', { class: 'twist' }, icon('caret', 12)),
                b.label,
                el('span', {}, String(b.rows.length)),
            ),
            open ? b.rows.map(schedCard) : null,
        );
    });
}

/**
 * What the last run did, as a phrase and a state.
 *
 * The state drives the dot's colour, and the phrase is the line you actually
 * read. `nothing-new` deserves saying out loud rather than being drawn as
 * nothing: a gated schedule that has been quiet for a week because the branch has
 * been quiet is working perfectly, and a card that showed a blank there would be
 * indistinguishable from one that has broken.
 */
function schedLast(s) {
    // A pull-request schedule mid-sweep is doing something right now, which is
    // more useful than whatever the last finished review said.
    if (s.reviewsInFlight) {
        return { state: 'ok',
            text: `reviewing ${s.reviewsInFlight} pull request${s.reviewsInFlight === 1 ? '' : 's'}` };
    }
    if (s.lastSkipReason === 'sweep-expired') {
        return { state: 'bad', text: s.lastError || 'the review window closed with work left' };
    }
    if (s.lastSkipReason === 'missed') {
        return { state: 'bad', text: s.lastError || 'a run was missed' };
    }
    if (s.lastSkipReason === 'error') {
        return { state: 'bad', text: `could not run — ${s.lastError || 'unknown error'}` };
    }
    if (s.lastSkipReason === 'rate-limited') {
        return { state: 'warn', text: 'skipped — too many sessions were starting at once' };
    }
    if (s.lastSkipReason === 'nothing-new') {
        return { state: 'quiet', text: 'nothing new to do' };
    }
    if (!s.lastFiredAt) return { state: 'quiet', text: 'has not run yet' };

    const when = ago(new Date(s.lastFiredAt).toISOString());
    if (s.lastOutcome === 'BLOCK') return { state: 'bad', text: `ran ${when} — BLOCK` };
    if (s.lastOutcome === 'CONCERNS') return { state: 'warn', text: `ran ${when} — CONCERNS` };
    if (s.lastOutcome === 'CLEAN') return { state: 'ok', text: `ran ${when} — clean` };
    if (s.lastOutcome === 'error') return { state: 'bad', text: `ran ${when} — ended in an error` };
    // Ran, finished, said nothing a verdict could be read out of. Most prompts
    // are like this, so it is the ordinary case and not a defect.
    if (s.lastOutcome === 'done') return { state: 'ok', text: `ran ${when}` };
    return { state: 'ok', text: `started ${when}` };
}

/**
 * `nextRunAt` as something worth reading, or why there is nothing to read.
 *
 * `spent` is asked first and the order is the whole point: a one-time schedule
 * that has fired is disabled by the bridge, so before this field existed the card
 * said "paused" about something that had finished — the one word that promises it
 * will run again when you press Resume.
 */
function schedNext(s) {
    if (s.spent) {
        return s.once ? 'no further runs — it ran its one slot'
            : 'never — the expression matches no real date';
    }
    if (!s.enabled) return 'paused';
    if (!s.nextRunAt) return 'never — the expression matches no real date';
    const d = new Date(s.nextRunAt);
    const soon = s.nextRunAt - Date.now();
    // Under a day, the clock time is what you want; past that, the date is.
    const when = soon < 24 * 3600e3
        ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `next ${when}`;
}

function schedCard(s) {
    const last = schedLast(s);
    return el('article', {
        class: `tb-card sched-card${s.enabled ? '' : ' is-off'}`, 'data-id': s.id,
        onclick: (e) => { if (tbCardClickOpens(e)) schedEdit(s); },
    },
        el('header', { class: 'tb-card-head' },
            el('span', { class: `tb-dot sched-dot is-${last.state}` }),
            el('button', {
                class: 'tb-card-title', type: 'button',
                title: 'Open this schedule for editing',
                onclick: () => schedEdit(s),
            }, s.title || firstLine(s.prompt)),
        ),
        el('div', { class: 'tb-card-meta' },
            s.test ? el('span', { class: 'tag-test' }, 'test') : null,
            // The expression in English. The raw text is the tooltip, for when
            // you do want to check what was typed.
            el('span', { class: 'sched-when', title: s.cron }, s.cronText || s.cron),
            el('span', { class: 'dot' }, '·'),
            el('span', {}, schedNext(s)),
            el('span', { class: 'dot' }, '·'),
            el('span', { title: s.cwd }, s.projectName || 'unknown'),
            el('span', { class: 'dot' }, '·'),
            el('span', {}, s.permissionMode),
            s.gate ? el('span', { class: 'dot' }, '·') : null,
            s.gate && s.gate.kind === 'git-commits'
                ? el('span', { title: `only runs when ${s.gate.ref} has new commits` },
                    `gated on ${s.gate.ref}`) : null,
            // A PR gate has no ref to name; what it has is a count of what it has
            // looked at, and whether it is posting.
            s.gate && s.gate.kind === 'open-prs'
                ? el('span', {
                    title: s.gate.post
                        ? 'reviews each open pull request and comments on it'
                        : 'reviews each open pull request; posting is switched off',
                }, s.reviewedCount
                    ? `open PRs · ${s.reviewedCount} reviewed`
                    : 'open PRs')
                : null,
            s.gate && s.gate.kind === 'open-prs' && !s.gate.post
                ? el('span', { class: 'tag-test', title: 'nothing is written to GitHub' },
                    'no posting') : null,
            s.gate && s.gate.kind === 'open-prs' && !s.gate.includeDrafts
                ? el('span', { title: 'draft pull requests are skipped' }, 'ready only') : null,
            // An agent made this one (`schedule_session`), so there is a
            // conversation that says why. Nobody remembers setting up a run
            // they asked for in passing a week ago.
            s.createdBy ? el('span', { class: 'dot' }, '·') : null,
            s.createdBy ? el('button', {
                class: 'sched-open', type: 'button',
                title: 'Open the session that set this up',
                onclick: () => { showSched(false); openSession(s.createdBy.sessionId); },
            }, `made by ${s.createdBy.title || 'a session'}`) : null,
        ),
        // The line the panel exists for. Its own row rather than another chip in
        // the meta line, because "this stopped working three days ago" should not
        // have to be found among six other things.
        el('p', { class: `sched-last is-${last.state}` },
            last.text,
            s.runs ? el('span', { class: 'dim' },
                ` · ${s.runs} run${s.runs === 1 ? '' : 's'}`) : null,
            s.lastSessionId ? el('button', {
                class: 'sched-open', type: 'button',
                title: 'Open the session the last run produced',
                onclick: () => { showSched(false); openSession(s.lastSessionId); },
            }, 'open') : null,
        ),
        el('p', { class: 'dr-prompt' }, clipLines(s.prompt, 400)),
        el('div', { class: 'tb-acts' },
            el('button', {
                class: 'tb-btn primary', type: 'button',
                title: 'Start a run now, whatever the clock says',
                onclick: (e) => schedRun(s, e.currentTarget),
            }, 'Run now'),
            el('button', {
                class: 'tb-btn', type: 'button',
                title: s.enabled ? 'Stop it firing, without deleting it' : 'Arm it again',
                onclick: () => schedToggle(s),
            }, s.enabled ? 'Pause' : 'Resume'),
            el('button', {
                class: 'tb-btn', type: 'button',
                onclick: () => schedEdit(s),
            }, 'Edit'),
            el('button', {
                class: 'tb-btn quiet', type: 'button', title: 'Delete this schedule',
                onclick: () => schedDelete(s),
            }, 'Delete'),
        ),
    );
}

// ── acting on a card ─────────────────────────────────────────────────────

/**
 * Run it now.
 *
 * The bridge runs the *same* function the clock runs, so what this produces is
 * what tonight would have produced — which is the only reason the button is
 * trustworthy as a way of checking a schedule before leaving it alone. It skips
 * the gate, since pressing a button should do something, and it advances the
 * marker exactly as a scheduled run does.
 */
async function schedRun(s, btn) {
    btn.disabled = true;
    btn.textContent = 'Starting';
    try {
        const r = await post(`/api/schedules/${s.id}/run`);
        toast('Session started.', 'ok');
        showSched(false);
        openSessionSoon(r.sessionId);
    } catch (err) {
        toast(`Could not run the schedule: ${err.message}`, 'error');
        btn.disabled = false;
        btn.textContent = 'Run now';
    }
}

/**
 * Pause or arm it.
 *
 * Not a delete, and that distinction is the whole reason the button exists: a
 * schedule you are switching off for a fortnight is one you still want, and
 * rebuilding it from memory afterwards is exactly the work this panel is meant to
 * save. Arming it again does not make it fire for every slot it slept through —
 * the bridge moves the cursor to now.
 */
async function schedToggle(s) {
    try {
        await patch(`/api/schedules/${s.id}`, { enabled: !s.enabled });
    } catch (err) {
        toast(`Could not ${s.enabled ? 'pause' : 'resume'} the schedule: ${err.message}`,
            'error');
    }
}

function schedEdit(s) {
    openNew({ schedule: s });
}

/**
 * Delete it.
 *
 * A confirmation, unlike a draft. Deleting a draft loses a paragraph you can
 * write again; deleting a schedule loses the run history with it — including the
 * marker that says which commits have already been reviewed — so recreating it
 * silently starts the next run's range from scratch. That is worth one press.
 */
async function schedDelete(s) {
    const label = s.title || firstLine(s.prompt);
    if (!window.confirm(`Delete the schedule “${clip(label, 60)}”?\n\n`
        + 'Its run history goes with it, including which commits it has already '
        + 'reviewed.')) return;
    try {
        await del(`/api/schedules/${s.id}`);
    } catch (err) {
        toast(`Could not delete the schedule: ${err.message}`, 'error');
    }
}

// ── project colours ──────────────────────────────────────────────────────
//
// A colour per project directory, and the two ways of setting one.
//
// **Why it exists.** Nearly every checkout on this machine is the same project
// in a different worktree, and the control that decides which one a session
// belongs to is a free-text box in a dialog reused for four jobs. A session
// scoped to the wrong directory was a mistake with no visual tell until it had
// already run. A colour gives it one.
//
// **Where it is stored** is `projects.colors` in `~/.tgxcode/settings.json` —
// see the header of bridge/prefs.js for why a preference rather than a store of
// its own, and USER_ONLY there for why a repository does not get to set it. The
// page therefore already holds the whole map in BOOT_PREFS, refreshed by the
// `prefs` SSE event, so resolving a directory to a colour costs no request and
// can happen on every keystroke. See projectColor().
//
// **Two ways in, one picker.** The ⋮ on a project's rail card is where you
// notice a colour is missing; the Projects group in Settings is where you set
// several at once. Both open #pcolor-scrim, because a picker that had to be
// both a popover and a panel row would be two pickers that drifted.

// The six the stylesheet already uses against these surfaces — see the palette
// at the top of web/styles.css. Read from the stylesheet rather than written out
// again here, so a restyle moves them and this list cannot go stale. A name
// beside each, because a radio group that announces "#a8c7fa" is no use to
// anybody listening to it.
const PCOLOR_PRESETS = [
    ['--blue', 'Blue'],
    ['--green', 'Green'],
    ['--yellow', 'Yellow'],
    ['--peach', 'Peach'],
    ['--red', 'Red'],
    ['--purple', 'Purple'],
];

/**
 * A `--token` from the stylesheet as the `#rrggbb` the bridge will accept.
 *
 * The palette is written as hex already, so this is a read and a trim rather
 * than a conversion — but it goes through hexAccent all the same, because what
 * comes back is whatever the stylesheet currently says and it is about to be
 * sent to a route that validates it.
 */
function paletteHex(token) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return hexAccent(v);
}

/** Which project the colour dialog is about. */
let pcolorFor = null;   // {cwd, name}

/**
 * Save one project's colour, or clear it.
 *
 * The whole map goes up, because `projects.colors` is one key whose value
 * happens to be a map and `PUT /api/prefs` replaces a key — the contract
 * bridge/prefs.js's save() spells out for `keyboard.bindings`. The page holds
 * the resolved map, so sending all of it says exactly what it means. `null` when
 * the last colour goes, so the section leaves the file rather than sitting in it
 * as `{}`.
 *
 * `scope: 'user'` always, never `state.settings.scope`: the section is
 * user-only, so a project scope would come back 403 `readonly`, and the Settings
 * group says as much above the list.
 *
 * The answer is taken as the truth rather than the value we sent — the rule
 * saveSetting() follows, and here it also hands back the directories spelled the
 * way the file spells them.
 *
 * @param {string} cwd  a project directory
 * @param {string|null} hex  `#rrggbb`, or null to clear it
 */
async function saveProjectColor(cwd, hex) {
    const next = { ...(BOOT_PREFS.projects.colors || {}) };
    if (hex) next[cwd] = hex; else delete next[cwd];
    try {
        const answer = await put('/api/prefs', {
            scope: 'user',
            patch: { projects: { colors: Object.keys(next).length ? next : null } },
        });
        BOOT_PREFS.projects.colors = (answer.prefs.projects || {}).colors || {};
    } catch (err) {
        toast(`Could not save that colour: ${err.message}`, 'error');
        return;
    }
    repaintProjectColors();
}

/**
 * Everything that wears a project's colour, after the map changed.
 *
 * One function rather than each caller remembering the list, because the map
 * changes from three directions — this window's picker, another window's, and a
 * hand-edit of the settings file — and the third has no caller to remember
 * anything. Each of these is a no-op when its surface is shut.
 */
function repaintProjectColors() {
    paintBackdropTint();
    renderRail();
    paintNewProject();
    paintPcolorDialog();
    if (state.settings.open) renderProjectColors();
    if (state.drafts.open) renderDrafts();
    if (state.taskboard.open) renderTaskboard();
    if (state.dash.open) renderDash();
}

// --- the dialog ----------------------------------------------------------

/**
 * Open the picker on one project.
 *
 * @param {{cwd: string, name: string}} project
 */
function openPcolor(project) {
    pcolorFor = { cwd: project.cwd, name: project.name };
    dom.pcolorScrim.hidden = false;
    paintPcolorDialog();
    dom.pcolorDone.focus();
}

function closePcolor() {
    dom.pcolorScrim.hidden = true;
    pcolorFor = null;
}

/**
 * Draw the swatch row against what is currently stored.
 *
 * Redrawn rather than patched, and called again after every save, because the
 * dialog holds no draft of its own: what is on screen is what is in the settings
 * file, which is the rule the settings panel states at length — a picker with a
 * Save button has a state where what you see and what is in force disagree. It
 * also makes the second-window case free, since repaintProjectColors() runs this
 * when the `prefs` event arrives.
 */
function paintPcolorDialog() {
    if (dom.pcolorScrim.hidden || !pcolorFor) return;
    const current = hexAccent((BOOT_PREFS.projects.colors || {})[pcolorFor.cwd]);

    dom.pcolorName.textContent = pcolorFor.name;
    dom.pcolorPath.textContent = pcolorFor.cwd;

    const swatch = (hex, label, on) => el('button', {
        class: 'pcolor-swatch' + (on ? ' on' : '') + (hex ? '' : ' none'),
        type: 'button', role: 'radio', 'aria-checked': String(on),
        'aria-label': label, title: label,
        style: hex ? `--pcolor: ${hex}` : null,
        onclick: () => saveProjectColor(pcolorFor.cwd, hex || null),
    }, on ? icon('tick', 13) : null);

    const presets = PCOLOR_PRESETS
        .map(([token, label]) => [paletteHex(token), label])
        .filter(([hex]) => hex);
    // A colour that is not one of the six still gets a place in the row, so the
    // ticked swatch is always the one in force. Otherwise picking your own would
    // leave nothing ticked, which reads as the save not having worked.
    const known = new Set(presets.map(([hex]) => hex.toLowerCase()));
    if (current && !known.has(current.toLowerCase())) presets.push([current, 'Your own']);

    dom.pcolorSwatches.replaceChildren(
        swatch('', 'No colour', !current),
        ...presets.map(([hex, label]) => swatch(hex, label,
            !!current && hex.toLowerCase() === current.toLowerCase())),
    );
    // The native picker opens on what is set, and falls back to the app's blue
    // rather than to its own black — which would make every uncoloured project
    // look like a decision somebody had made.
    dom.pcolorInput.value = current || paletteHex('--blue') || '#a8c7fa';
}

// --- the rail's ⋮ menu ---------------------------------------------------

/**
 * Open the one-item menu against a project card's ⋮.
 *
 * Fixed and placed by hand, for positionMenu()'s reason one step further on: the
 * rail scrolls and clips, and cards move when the order does. `state.projMenu`
 * remembers which card it belongs to, so a render can draw that card's ⋮ as
 * expanded and syncProjMenu() can follow it.
 *
 * @param {{key: string, cwd: string, name: string}} project
 */
export function showProjMenu(project, btn) {
    state.projMenu = { key: project.key, cwd: project.cwd, name: project.name };
    dom.projMenu.hidden = false;
    renderRail();   // the ⋮ draws itself expanded
    const row = (label, act, disabled) => el('button', {
        class: 'picker-row', type: 'button', role: 'menuitem', disabled: disabled || null,
        onclick: () => { closeProjMenu(); act(); },
    }, el('span', {}, label));
    // `custom` order only: the keyboard way to do what dragging the heading does.
    const cards = BOOT_PREFS.projects.sort === 'custom' ? railCardOrder() : [];
    const at = cards.indexOf(project.cwd);
    dom.projMenu.replaceChildren(
        el('div', { class: 'menu-note' }, clip(project.name, 30)),
        el('div', { class: 'sep' }),
        row('Set project colour', () => openPcolor(project)),
        ...(at < 0 ? [] : [
            el('div', { class: 'sep' }),
            row('Move to top', () => moveRailCard(project.cwd, 'top'), at === 0),
            row('Move up', () => moveRailCard(project.cwd, -1), at === 0),
            row('Move down', () => moveRailCard(project.cwd, 1), at === cards.length - 1),
        ]),
    );
    placeProjMenu(btn);
    dom.projMenu.querySelector('.picker-row').focus();
}

export function closeProjMenu() {
    if (!state.projMenu) return;
    state.projMenu = null;
    dom.projMenu.hidden = true;
    renderRail();
}

/** Under the button, or over it when there is more room that way. */
function placeProjMenu(btn) {
    const r = btn.getBoundingClientRect();
    const gap = 6;
    const h = dom.projMenu.offsetHeight || 96;
    const up = window.innerHeight - r.bottom - gap < h && r.top > h + gap;
    dom.projMenu.style.left = `${Math.max(8, r.right - PROJ_MENU_W)}px`;
    if (up) {
        dom.projMenu.style.top = 'auto';
        dom.projMenu.style.bottom = `${window.innerHeight - r.top + gap}px`;
    } else {
        dom.projMenu.style.bottom = 'auto';
        dom.projMenu.style.top = `${r.bottom + gap}px`;
    }
}

const PROJ_MENU_W = 220;

/**
 * Put the menu back against its button, or close it if there is nothing to put
 * it against.
 *
 * Called from two places, and *reposition rather than close* is the rule in
 * both — repositionFloatingMenus()' rule, for its reason: the button is still
 * there and the menu is still the answer, so a menu that vanished because
 * something moved a pixel would be the wrong reading of what happened.
 *
 * From renderRail(), because that runs whenever any session changes — several
 * times a minute in a busy window — and can move the card the menu belongs to;
 * a menu that shut itself that often would be unusable for the one thing it is
 * for.
 *
 * From the rail's `scroll`, because pressing a ⋮ that is only half on screen
 * makes the browser scroll it into view *first*, and that scroll lands after the
 * click. Closing on it meant the menu opened and shut again in one press, which
 * is a press that appears to do nothing.
 *
 * It does close when the button has gone — the card was filtered away or the
 * project's last session was deleted — or when it has scrolled out of the rail
 * entirely, since the menu is fixed and would otherwise be left pointing at a
 * card nobody can see.
 */
function syncProjMenu() {
    if (!state.projMenu) return;
    const btn = dom.rail.querySelector(
        `.rail-group[data-key="${cssEscape(state.projMenu.key)}"] .group-menu-btn`);
    if (!btn) { closeProjMenu(); return; }
    const b = btn.getBoundingClientRect();
    const rail = dom.rail.getBoundingClientRect();
    if (b.bottom < rail.top || b.top > rail.bottom) { closeProjMenu(); return; }
    placeProjMenu(btn);
}

/**
 * A group key inside an attribute selector.
 *
 * The key holds a project name, which is a path segment and can hold anything a
 * filesystem allows — a quote in it would end the selector early and throw.
 */
const cssEscape = (v) => (window.CSS && CSS.escape
    ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));

// --- the Settings group --------------------------------------------------

/**
 * Every project the bridge knows, with its colour.
 *
 * Drawn from `state.settings.projects`, which loadSettings() already fetches for
 * the scope picker, so this group costs no second request. A `render` rather
 * than rows in the SETTINGS table because these are not controls over a settings
 * *key* the way the rest of the panel's are: there is one key, and what varies
 * is which directories exist.
 */
export function renderProjectColors() {
    const colors = BOOT_PREFS.projects.colors || {};
    const projects = state.settings.projects || [];
    if (!projects.length) {
        dom.pcolorList.replaceChildren(el('div', { class: 'settings-row-note' },
            'No projects yet — a directory appears here once a session has run in it.'));
        return;
    }
    dom.pcolorList.replaceChildren(...projects.map((p) => {
        const hex = hexAccent(colors[p.cwd]);
        return el('div', {
            class: 'pcolor-row', 'data-tinted': hex ? '1' : null,
            style: hex ? `--proj-accent: ${hex}` : null,
        },
            el('button', {
                class: 'pcolor-swatch' + (hex ? '' : ' none'), type: 'button',
                style: hex ? `--pcolor: ${hex}` : null,
                'aria-label': `Set the colour for ${p.name}`,
                onclick: () => openPcolor({ cwd: p.cwd, name: p.name }),
            }),
            el('div', { class: 'pcolor-row-text' },
                el('div', { class: 'pcolor-row-name' }, p.name),
                el('div', { class: 'pcolor-row-path' }, p.cwd),
            ),
            hex
                ? el('button', {
                    class: 'btn small', type: 'button',
                    onclick: () => saveProjectColor(p.cwd, null),
                }, 'Clear')
                : null,
        );
    }));
}

/**
 * The two backdrop rows above the colour list.
 *
 * settingRow() rather than hand-built controls, so they get the Clear, the
 * "default" and the override line every other setting has. Locked at a project
 * scope like the rest of `projects` — the section is user-only in
 * bridge/prefs.js, and a control that saved would only earn a problem line.
 */
export function renderProjectOrder() {
    const group = SETTINGS.find(g => g.section === 'projects');
    const locked = state.settings.scope !== 'user';
    const data = state.settings.data;
    if (!data) { dom.pcolorOrder.replaceChildren(); return; }
    const mode = (data.projects && data.projects.sort) || 'recent';
    const custom = (data.projects && data.projects.order) || [];
    dom.pcolorOrder.replaceChildren(
        ...group.orderRows.map(row =>
            settingRow(group, row, locked || (row.mode && row.mode !== mode))),
        mode === 'custom' && custom.length
            ? el('div', { class: 'settings-row' },
                el('div', { class: 'settings-row-text' },
                    el('div', { class: 'settings-row-label', text: 'Custom order' }),
                    el('div', { class: 'settings-row-note',
                        text: `${custom.length} project${custom.length === 1 ? '' : 's'} placed by hand.` })),
                el('div', { class: 'settings-row-ctl' },
                    el('button', {
                        class: 'linkish', type: 'button', disabled: locked || null,
                        onclick: () => saveSetting('projects', 'order', []),
                    }, 'Reset custom order')))
            : null,
    );
}

export function renderProjectBackdrop() {
    const group = SETTINGS.find(g => g.section === 'projects');
    const locked = state.settings.scope !== 'user';
    if (!state.settings.data) { dom.pcolorBackdrop.replaceChildren(); return; }
    dom.pcolorBackdrop.replaceChildren(...group.rows.map(row => settingRow(group, row, locked)));
}

// --- wiring --------------------------------------------------------------

for (const n of dom.pcolorScrim.querySelectorAll('[data-close-pcolor]')) {
    n.addEventListener('click', closePcolor);
}
dom.pcolorDone.addEventListener('click', closePcolor);
// `input` rather than `change`: a native colour picker fires `input` as you drag
// and `change` only when it closes, and saving on the drag is what makes the
// rail behind the dialog a live preview. Each one is a small file write.
dom.pcolorInput.addEventListener('input', () => {
    const hex = hexAccent(dom.pcolorInput.value);
    if (hex && pcolorFor) saveProjectColor(pcolorFor.cwd, hex);
});
closeOnClickOutside(dom.pcolorScrim, closePcolor);

// The menu goes on a click outside it and on Escape. A rail scroll follows it
// instead — see syncProjMenu — because the browser scrolls a half-visible ⋮ into
// view before delivering the click that opened the menu. Capturing, so a click on
// some other control closes this before that control acts on it.
document.addEventListener('click', (e) => {
    if (!state.projMenu) return;
    if (dom.projMenu.contains(e.target) || e.target.closest('.group-menu-btn')) return;
    closeProjMenu();
}, true);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.projMenu) { e.stopPropagation(); closeProjMenu(); }
}, true);
dom.rail.addEventListener('scroll', syncProjMenu);
window.addEventListener('resize', syncProjMenu);
dom.rail.addEventListener('dragover', onRailDragOver);
dom.rail.addEventListener('drop', (e) => { if (state.railDrag) e.preventDefault(); });

// --- the rail head's order menu -------------------------------------------

// RAIL_SORTS is in web/settings/general.js: SETTINGS reads it while that module
// evaluates, which is before this file's body has run.

export function paintRailSort() {
    const mode = RAIL_SORTS.find(([v]) => v === BOOT_PREFS.projects.sort) || RAIL_SORTS[0];
    dom.railSort.title = `Project order: ${mode[1]}`;
    dom.railSort.setAttribute('aria-label', `Project order: ${mode[1]}`);
    dom.railSort.setAttribute('aria-expanded', String(state.sortMenu));
    dom.railSort.classList.toggle('on', mode[0] !== 'recent');
}

function openSortMenu() {
    state.sortMenu = true;
    const current = BOOT_PREFS.projects.sort;
    dom.sortMenu.hidden = false;
    dom.sortMenu.replaceChildren(
        el('div', { class: 'menu-note' }, 'Order projects by'),
        el('div', { class: 'sep' }),
        ...RAIL_SORTS.map(([v, label, note]) => el('button', {
            class: 'picker-row sort-row', type: 'button', role: 'menuitemradio',
            'aria-checked': String(v === current), title: note,
            onclick: () => {
                closeSortMenu();
                if (v === current) return;
                BOOT_PREFS.projects.sort = v;
                renderRail();
                paintRailSort();
                saveRailPref('sort', v);
            },
        }, el('span', { class: 'sort-tick' }, v === current ? icon('tick', 13) : null),
            el('span', {}, label))),
        el('div', { class: 'sep' }),
        el('button', {
            class: 'picker-row', type: 'button', role: 'menuitem',
            onclick: () => { closeSortMenu(); openSettingsAt('projects'); },
        }, el('span', {}, 'More in Settings…')),
    );
    const r = dom.railSort.getBoundingClientRect();
    dom.sortMenu.style.top = `${r.bottom + 6}px`;
    dom.sortMenu.style.left = `${Math.max(8, r.right - PROJ_MENU_W)}px`;
    paintRailSort();
    const on = dom.sortMenu.querySelector('[aria-checked="true"]');
    if (on) on.focus();
}

function closeSortMenu() {
    if (!state.sortMenu) return;
    state.sortMenu = false;
    dom.sortMenu.hidden = true;
    paintRailSort();
}

dom.railSort.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.sortMenu) closeSortMenu(); else openSortMenu();
});
document.addEventListener('click', (e) => {
    if (!state.sortMenu) return;
    if (dom.sortMenu.contains(e.target) || e.target.closest('#rail-sort')) return;
    closeSortMenu();
}, true);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.sortMenu) { e.stopPropagation(); closeSortMenu(); dom.railSort.focus(); }
}, true);
window.addEventListener('resize', closeSortMenu);
paintRailSort();

// The Settings panel and everything it draws are in web/settings/. These three
// wire listeners that used to be registered here, and run at the same point.
wireToolbar();
wireShortcuts();
wireNotifySettings();

// ── streaming ────────────────────────────────────────────────────────────

function connect() {
    const es = new EventSource('/api/events');

    es.addEventListener('hello', (e) => {
        state.clientId = JSON.parse(e.data).clientId;
        // A new client id knows nothing about what this window was following, so
        // the boards have to be asked for again — including when no session is
        // open, which is the ordinary case for a window left on one of them.
        //
        // This is also the *first* subscribe a window ever makes. `subscribe()`
        // does nothing without a client id, so a board opened by restoreView()
        // during boot — `?view=taskboard`, the address a refresh leaves behind —
        // has already asked to watch and been silently dropped. Both flags are
        // reset to false so the sync below is a change and actually sends.
        state.live.watching = false;
        state.taskboard.watching = false;
        if (state.current || state.live.open || state.taskboard.open) {
            state.live.watching = state.live.open;
            state.taskboard.watching = state.taskboard.open;
            subscribe();
        }
        // Every `sessions-changed` while the stream was down was missed, and
        // nothing replays them, so the rail is however it was when the stream
        // dropped — a bridge restart used to leave rows sitting there with the
        // turn counts and times they had beforehand. Reconnecting is exactly the
        // moment the list cannot be trusted. Harmless on the first connect: it
        // costs the one extra fetch that boot was going to make anyway.
        loadSessions();
        // And the drafts, for the same reason and one more: every
        // `drafts-changed` while the stream was down was missed too, so the panel
        // and its badge are however they were when it dropped. There is no
        // watching flag to reset here — the push is unconditional, so a
        // reconnected window starts receiving them again with no subscribe.
        loadDrafts();
        // And the snippets, which matter here a little more than the drafts do:
        // the pinned buttons are on screen whether or not any panel is open, so a
        // missed push leaves a wrong button sitting in the composer rather than a
        // stale card behind a panel nobody has opened.
        loadSnippets();
        // And the messages waiting on a clock, on the drafts' terms and for its
        // reasons — the chips are on screen whenever the session is.
        loadLater();
        // And the schedules, on the same terms. It matters a little more here:
        // the stream is most often down because the bridge restarted, and a
        // restart is exactly when the catch-up pass runs — so the changes this
        // window missed are the ones about runs that fired while it was away.
        loadSched();
        // And the quota, which matters here for a reason the others do not
        // share: every `quota` push while the stream was down was missed, and
        // the pill has been quietly ageing the whole time. A reconnect is the
        // one moment it can be brought back to the truth for free.
        loadQuota();
        // The version check has the same missed-push problem, and this is also
        // how the first answer arrives at all.
        loadCv();
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
        appendEvents(d.events, SESSION_VIEW, { live: true });
        // A plan belonging to a session running elsewhere is read out of these
        // events, so it arrives — and goes away once answered over there — with
        // the transcript rather than with a status tick.
        refreshAsk(state.runner && state.runner.pendingPermission);
        // The session pane keeps growing behind a subagent; don't yank the
        // subagent's scroll position around for it.
        if (stick && !state.agent && !state.find.open) scrollToEnd(false);
    });

    es.addEventListener('agent-tail', (e) => {
        const d = JSON.parse(e.data);
        if (!state.agent || d.toolUseId !== state.agent) return;
        if (!state.current || d.sessionId !== state.current.sessionId) return;
        state.agentOffset = d.offset;
        const sc = dom.agentScroll;
        const stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90;
        appendEvents(d.events, AGENT_VIEW, { live: true });
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
    es.addEventListener('taskboard', (e) => applyTaskboard(JSON.parse(e.data)));

    // The session's own task list, pushed on the transcript follow: once as soon
    // as a session is followed, and after that only when the list has moved.
    // It carries the whole payload, so there is nothing to refetch.
    //
    // Stored even when the panel is off or collapsed, so opening it paints
    // straight away rather than waiting up to 400ms for the next push — the
    // signature check in the bridge means a push that changed nothing never
    // arrives, so there would be no second chance to catch up on.
    es.addEventListener('task-list', (e) => {
        const d = JSON.parse(e.data);
        if (!state.current || d.sessionId !== state.current.sessionId) return;
        state.checklist.sessionId = d.sessionId;
        state.checklist.data = d;
        state.checklist.pending = false;   // answered, so the column can settle
        renderChecklist();
    });
    // The whole list, every time, and not gated on watching the panel — see the
    // drafts section. It carries the rows, so there is nothing to refetch: this
    // is also how a draft saved or started in another window disappears from
    // this one.
    es.addEventListener('drafts-changed', (e) => applyDrafts(JSON.parse(e.data)));
    es.addEventListener('snippets-changed', (e) => applySnippets(JSON.parse(e.data)));
    es.addEventListener('schedules-changed', (e) => applySched(JSON.parse(e.data)));
    // Fires without anybody having done anything, exactly as `schedules-changed`
    // does: a delivery, a miss and a failure all move it. That is how a chip
    // starts saying "sent 02:00" while nobody is looking at it.
    es.addEventListener('later-changed', (e) => applyLater(JSON.parse(e.data)));

    es.addEventListener('sessions-changed', () => loadSessions());

    // A pull request moved — a review landed, a build finished, somebody merged.
    // Nothing in a conversation says so, and this used to be three independent
    // sixty-second polls finding out: the header, the rail and the board, each
    // asking whether anything had changed and almost always being told no.
    //
    // The payload is the rail's whole answer, because one word per session is
    // small enough to send outright. The header's per-PR detail is not, so this
    // refetches the one session on screen — see `loadPrStatus`. The board is only
    // reloaded when it is actually open; it is a heavier payload and an invisible
    // panel does not need to be right.
    es.addEventListener('prs-changed', (e) => {
        applyRailPrs(JSON.parse(e.data));
        if (state.current) loadPrStatus();
        if (state.dash.open) loadDash();
    });

    // Settings were saved — possibly in another window, possibly this one. Two
    // are routinely open here (the Electron shell and a browser tab on the same
    // bridge), and a window sitting on a stale copy would keep drawing cards the
    // old way and answering the old shortcuts, with nothing to say why.
    //
    // The user-level answer only, which is what BOOT_PREFS holds. A project's
    // travels with the transcript, and re-reading it is openSession's job.
    es.addEventListener('prefs', (e) => {
        const p = JSON.parse(e.data);
        for (const block of Object.keys(PREFS_FALLBACK)) {
            if (block === 'version' || !p[block]) continue;
            Object.assign(BOOT_PREFS[block], p[block]);
        }
        keys.apply(BOOT_PREFS.keyboard);
        paintShortcutHints();
        paintComposerHint();
        paintToolbar();
        // `live.over*` may have changed whether the board is up over this panel.
        paintPanels();
        if (liveVisible()) renderLive();
        // Project colours are in that payload too, and everything wearing one has
        // to be redrawn — including the rail, which nothing else here touches.
        repaintProjectColors();
        paintRailSort();
        // The panel that did the saving already has the answer; one that is open
        // in *this* window while another saved does not.
        if (state.settings.open && !state.settings.saving) loadSettings();
    });

    // Claude Code's settings changed. The payload is the *fact* of a change and
    // not the content, unlike `prefs` above: nothing in this app behaves
    // differently because of those files, so there is no `<meta>` copy to keep
    // in sync, and pushing the contents of a file that route classifies as
    // local-only down every open channel would be a poor trade for saving a
    // fetch.
    es.addEventListener('claude-config', async () => {
        const s = state.claudeCfg;
        if (!state.settings.open || s.saving) return;
        // A draft in the JSON tab is never destroyed to show somebody what
        // somebody else typed. It gets a banner and keeps what it has.
        if (s.dirty) {
            // The data is reloaded around the draft even so — the same
            // keep-and-restore saveClaudeText() does on a 409 — because the
            // banner promises "what is below is the file as it is now" and
            // without this it would be showing the file as it was. That
            // promise is the whole content of the banner: the draft survives,
            // and `What is on disk` becomes something the reader can compare
            // against rather than an absent block.
            const keep = s.draft;
            await loadClaudeConfig();
            s.draft = keep;
            s.dirty = true;
            const row = claudeTargetRow();
            s.stale = { text: (row && row.text) || null };
            renderSettings();
            return;
        }
        // Nothing typed, so there is nothing to protect: reload, and point at
        // whatever moved. The JSON tab re-seeds itself from the new file
        // because it is clean — see claudeRawCard().
        loadClaudeConfig({ flash: true });
    });

    // The same, for a CLAUDE.md written elsewhere — another window, or `claude`
    // itself through a memory edit. The dirty guard matters more here than it
    // does above: the draft is not one key but a whole document somebody has
    // been writing.
    es.addEventListener('claude-docs', () => {
        const s = state.claudeDocs;
        if (!state.settings.open || s.saving) return;
        if (s.dirty) {
            s.stale = { text: null };
            renderSettings();
            if (!dom.memoScrim.hidden) paintMemoDialog();
            return;
        }
        loadClaudeDocs();
    });

    // A project's commands changed — another window's settings panel, or
    // somebody's text editor. Two things react, and the second is the point.
    es.addEventListener('commands-config', (e) => {
        const d = JSON.parse(e.data);
        const s = state.cmdCfg;
        if (state.settings.open && !s.saving) {
            // The same dirty guard the two groups above use: a draft here is a
            // whole document somebody has been editing, and replacing it to show
            // them somebody else's version is the one unforgivable move.
            if (s.dirty || s.rawDirty) {
                s.stale = { text: null };
                renderSettings();
            } else {
                loadCmdConfig();
            }
        }
        // And the buttons, which is the half that makes this a feature rather
        // than a file editor. Only when the directory on screen belongs to the
        // project that changed — `cmdDir()` is a session's own cwd, so it is
        // usually a worktree, and a worktree path starts with its project's.
        const here = cmdDir();
        if (here && d.project
            && (here === d.project || here.startsWith(`${d.project}/`))) {
            loadCommands();
        }
    });

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
        // The rail's own copy. The session list is only re-sent when the list
        // changes, and none of what moves while a turn runs changes it — the tool
        // being called, the queue behind it, the turn ending — so without this a
        // row would keep an activity line minutes stale and a finished turn still
        // breathing.
        const row = state.sessions.find(x => x.sessionId === s.sessionId);
        if (row) {
            row.runner = { state: s.state, activity: s.activity,
                detail: s.detail, queued: s.queued };
            renderRail();
        }
    });

    es.addEventListener('permission-request', (e) => {
        const p = JSON.parse(e.data);
        // Ahead of the early return, as with turn-complete: the asks worth
        // interrupting somebody for are the ones not already on screen.
        announceAsk(p);
        state.waiting.add(p.sessionId);
        paintLiveBadge();
        paintTaskboardBadge();
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
        paintTaskboardBadge();
        if (!state.ask || state.ask.requestId !== p.requestId) return;
        resolveAsk(p.outcome);
    });

    es.addEventListener('notice', (e) => {
        const n = JSON.parse(e.data);
        // Rate limits belong to the pill. `rate_limit_event` arrives on every
        // turn for as long as the limit holds, so as a toast this was a column
        // of identical warnings over the composer — each one dismissed, each one
        // back next turn — about something already drawn in the header. The
        // `quota` event the runner emits immediately before this one is what
        // flashes it; see quotaFlash().
        //
        // Dropped here rather than at the bridge on purpose. The Android client
        // in ~/Other/tgxcode-mobile has no header pill, so a toast is still the
        // right answer there, and silencing the notice on the wire would take
        // the signal away from a client with nowhere else to put it.
        if (n.kind === 'rate_limit') return;
        toast(n.text, n.level === 'warn' ? 'warn' : 'info', 7000);
    });

    // The whole snapshot, not a delta: it is a handful of windows and the
    // bridge only sends it when a reading actually moved.
    es.addEventListener('quota', (e) => {
        applyQuotaSnapshot(JSON.parse(e.data));
    });

    // The whole summary. Sent when it moved: an hourly registry check, an
    // update, or a process starting or ending on some other version.
    es.addEventListener('claude-version', (e) => {
        applyCv(JSON.parse(e.data));
    });

    // A process reported a command list that differs from the one we hold —
    // a plugin installed, a command file added. Dropped rather than refetched:
    // the list is only wanted when somebody presses `/`, and most windows never
    // will for this directory.
    es.addEventListener('slash-commands', (e) => {
        const d = JSON.parse(e.data);
        state.slashCommands.delete(d.cwd);
        for (const c of composers) if (menuOpen(c.slash)) updateSlashMenu(c);
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
        for (const c of composers) if (menuOpen(c.mention)) updateMentionMenu(c);
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
        if (typeof row.unread === 'number') state.notes.unread = row.unread;
        // A row filed against the conversation in front of you, in a window you
        // are looking at, is not news — you watched it happen. The same judgement
        // turnWorthSaying already makes about not raising a toast for it; without
        // it the badge lights up for a plan sitting on screen.
        const watching = document.hasFocus()
            && state.current && state.current.sessionId === row.sessionId;
        if (state.notes.scope !== 'notable' || row.loud) {
            state.notes.rows.unshift(row);
        }
        if (state.notes.open) { renderNotes(); markNotesSeen(); }
        else if (watching && row.loud) markNotesRead({ sessionId: row.sessionId });
        else paintNotesBadge();
    });

    // A watermark moved, here or in another window. This is what keeps two
    // windows agreed about a badge, and it is why the watermarks live in the
    // bridge at all.
    es.addEventListener('notification-read', (e) => {
        const { sessionId, at, unread } = JSON.parse(e.data);
        if (sessionId) state.notes.read.sessions[sessionId] = at;
        else state.notes.read.all = Math.max(state.notes.read.all, at);
        state.notes.unread = unread;
        if (state.notes.open) renderNotes();
        paintNotesBadge();
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
        // No rows left, so nothing unread — the watermarks are left alone,
        // because with nothing to apply to they cost nothing.
        state.notes.unread = 0;
        if (state.notes.open) renderNotes();
        paintNotesBadge();
    });

    es.addEventListener('turn-complete', (e) => {
        const r = JSON.parse(e.data);
        state.unsent.delete(r.sessionId);   // it is in the transcript now
        // Ahead of the early return below, which drops every session but the
        // open one — and those are precisely the ones worth being told about.
        announceTurn(r);
        if (bumpGroup(state.sessions.find(s => s.sessionId === r.sessionId), 'turn')) renderRail();
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

export async function subscribe() {
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
            taskboard: state.taskboard.open,
        });
    } catch { /* the SSE reconnect will re-subscribe */ }
}

export function applyRunner(s) {
    const wasBusy = isBusy();
    state.runner = s;
    const busy = s && (s.state === 'busy' || s.state === 'starting');
    const retrying = Boolean(s && s.retry);

    // A turn that ends without saying anything — stopped, or an error — leaves
    // its last run of tool calls with no message coming to close it. The turn
    // ending is the close. Harmless while one is still in flight: closeRun does
    // nothing when there is no run, and this is the only thing that reports the
    // end of a turn to the log at all.
    if (!busy) { closeRun(SESSION_VIEW); closeRun(AGENT_VIEW); }

    // A turn ending is when the file list is worth asking about again: the edits
    // it made are on disk and its subagents have finished writing. On the end of
    // a turn rather than on a timer, because between turns nothing changes and a
    // drawer left open all afternoon should not shell out to git all afternoon.
    if (wasBusy && !busy && state.changes.on && !state.changes.shut) loadChanges();

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
    // The same for the model, and note the guard is `s` rather than `s.model`:
    // null is what a process started without `--model` reports, and it is an
    // answer — "this one is inheriting" — not a missing field to skip over.
    if (s) {
        const model = s.model || '';
        const seen = state.runnerModel.has(s.sessionId);
        const moved = state.runnerModel.get(s.sessionId) !== model;
        state.runnerModel.set(s.sessionId, model);
        if (seen && moved) state.modelChoice.delete(s.sessionId);
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
    paintPinTitles(busy && !state.agent);
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
    paintModel();
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
        // Every send button, not just Send: a pinned snippet is an ordinary
        // message with a written-out text, so it goes into the same transcript
        // by the same path.
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
export function paintPerm() {
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

/**
 * The model selector, painted from the same kind of chain as paintPerm.
 *
 * This is newer than its twin and exists because the control it paints had no
 * state at all: `#model` was read at send time and never written to, so it kept
 * whatever you last picked for as long as the window was open and carried that
 * across every session you opened. That was survivable while changing it meant
 * a deliberate trip to the dropdown. Ctrl+M makes it a keystroke, so the
 * selector now answers for the conversation in front of you like the mode does.
 *
 * Two differences from paintPerm, both about `''`:
 *
 * `??` and `has()` rather than `||`, because `''` is a real choice here — it is
 * `inherit`, the default — and a `||` chain would fall straight through it to
 * whatever the transcript last said.
 *
 * And the fallback for a value this build does not offer is `''` rather than a
 * named model. `state.current.model` comes from the transcript and can be a
 * resolved id (`claude-opus-5-…`) that no option matches; `inherit` is the
 * honest thing to show for it, and — unlike blanking a `<select>`, which is the
 * failure the same guard in paintPerm is there to prevent — it is also a value
 * that means something when it is sent.
 */
function paintModel() {
    const id = state.current && state.current.sessionId;
    // Written as a ladder rather than a `??` chain: every rung's "no answer" is
    // a different test — a Map that may hold `''`, an object that may be null,
    // a field that may be absent — and one operator cannot say all three.
    let model = '';
    if (state.current && state.current.model) model = state.current.model;
    if (id && state.runnerModel.has(id)) model = state.runnerModel.get(id);
    if (state.runner) model = state.runner.model || '';
    if (id && state.modelChoice.has(id)) model = state.modelChoice.get(id);

    const known = [...dom.model.options].some(o => o.value === model);
    dom.model.value = known ? model : '';
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

export function scrollToEnd(instant) {
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

// ── turn rail, find in conversation ──────────────────────────────────────
// Both read the rendered log, so they live beside it: web/transcript/turn-rail.js
// and web/transcript/find.js.

// ── send later ───────────────────────────────────────────────────────────
// The same message, at a time you pick. A send held back rather than a schedule:
// there is no cron here and there is not going to be, because the thing this is
// for is one instruction that is only true at one hour — "you may now modify app
// data to get the screenshots" — and a repeating version of that sentence is not
// a thing anybody wants.
//
// **The mode is the feature, not a detail of it.** A permission ask raised while
// no window is open is denied on the spot and two of those stop the turn, so a
// message delivered at 02:00 in `auto` does not run unattended; it stalls. The
// popover therefore asks how to deliver, in the same breath as when, and remembers
// the answer. It is also why the mode is on the *face* of every chip: a message
// that will wake an agent with no permission gate at 2am is not something you
// should have to expand a row to discover.
//
// The whole list is held rather than this session's, because that is the shape
// `later-changed` carries and the rail wants all of it for its badges.

/** The modes worth offering, loudest first — see the note above about `auto`. */
const LATER_MODES = ['bypassPermissions', 'dontAsk', 'acceptEdits', 'auto', 'plan'];

/** What the popover last delivered in, so the choice survives the next message. */
let laterMode = (() => {
    try { return localStorage.getItem('laterMode') || 'bypassPermissions'; }
    catch { return 'bypassPermissions'; }
})();

/**
 * Take the bridge's whole list and repaint.
 *
 * The rail goes with it. Its badge is drawn from *this* list rather than from the
 * `later` field on the session summary, although that field exists and says the
 * same thing: the rail is rebuilt only when the session list changes, and none of
 * the things that move a scheduled message change it — so a badge read off the
 * summary would still say "02:00" an hour after the message had gone. The summary
 * field is for a client that fetches sessions and nothing else.
 */
function applyLater(payload) {
    state.later = (payload && payload.messages) || [];
    for (const id of state.laterOpen) {
        if (!state.later.some(m => m.id === id)) state.laterOpen.delete(id);
    }
    renderLater();
    renderRail();
}

/** Fetched once; the SSE event keeps it current from then on. */
async function loadLater() {
    try { applyLater(await get('/api/later')); } catch { /* the event will do it */ }
}

/**
 * "in 6h · 02:00" for something waiting, and what happened for something that is
 * not.
 *
 * Both halves on purpose. The relative one is what you actually think in when you
 * schedule something; the absolute one is what you check when you come back and
 * want to know whether it was before or after you went to bed.
 */
function laterWhen(m) {
    if (m.state === 'sent') return `sent ${hhmm(m.sentAt || m.at)}`;
    if (m.state === 'missed') return 'missed';
    if (m.state === 'failed') return 'failed';
    if (m.state === 'delivering') return 'sending…';
    const left = m.at - Date.now();
    if (left <= 0) return `due · ${hhmm(m.at)}`;
    const mins = Math.round(left / 60000);
    const rel = mins < 60 ? `in ${mins}m` : `in ${Math.round(mins / 60)}h`;
    return `${rel} · ${hhmm(m.at)}`;
}

/** The chips above the queue: this session's messages, soonest first. */
export function renderLater() {
    const mine = state.current
        ? state.later.filter(m => m.sessionId === state.current.sessionId)
        : [];
    // While a subagent is on screen the composer belongs to nothing you can send
    // to, so its chips are out of scope too — renderQueue's rule.
    const show = mine.length > 0 && !state.agent;
    dom.later.hidden = !show;
    if (!show) return dom.later.replaceChildren();

    dom.later.replaceChildren(...mine.map((m) => {
        const open = state.laterOpen.has(m.id);
        const done = m.state !== 'pending' && m.state !== 'delivering';
        const bad = m.state === 'missed' || m.state === 'failed';
        return el('div', {
            class: `later-chip${open ? ' open' : ''}${done ? ' done' : ''}${bad ? ' bad' : ''}`,
            'data-id': m.id,
        },
        el('span', { class: 'later-when', title: new Date(m.at).toLocaleString() },
            laterWhen(m)),
        el('span', {
            class: `later-mode${m.permissionMode === 'bypassPermissions'
                || m.permissionMode === 'dontAsk' ? ' loud' : ''}`,
            title: `It will be delivered in ${m.permissionMode}`,
        }, m.permissionMode),
        m.attachments.length
            ? el('span', { class: 'queue-files' }, `${m.attachments.length}📎`)
            : null,
        el('button', {
            class: 'later-text', type: 'button',
            title: open ? 'Collapse' : 'Show the whole message',
            onclick: () => {
                if (open) state.laterOpen.delete(m.id); else state.laterOpen.add(m.id);
                renderLater();
            },
        }, open ? m.text : clip(m.text, 120)),
        el('span', { class: 'queue-acts' },
            // Only while it is still waiting. "Send now" on a message already sent
            // would send it twice, and the bridge refuses that — better not to
            // offer it.
            m.state === 'pending'
                ? el('button', {
                    class: 'queue-act', type: 'button',
                    title: 'Deliver this message now instead of waiting',
                    onclick: (e) => sendLaterNow(m, e.currentTarget),
                }, 'Send now')
                : null,
            el('button', {
                class: 'queue-act danger', type: 'button',
                title: m.state === 'pending' ? 'Cancel this message' : 'Clear this row',
                'aria-label': m.state === 'pending' ? 'Cancel this message' : 'Clear this row',
                onclick: () => cancelLater(m),
            }, '×')));
    }));
}

/** Deliver one now. The bridge runs the same path its clock would. */
async function sendLaterNow(m, btn) {
    if (btn) btn.disabled = true;
    try {
        await post(`/api/later/${m.id}/send`, {});
        toast('Sent.', 'ok');
    } catch (err) {
        // 409 is the wait-for-idle refusal and is not a failure — the message is
        // untouched and pressing again in a minute is the right thing to do.
        toast(`Could not send it yet: ${err.message}`, 'warn');
        if (btn) btn.disabled = false;
    }
}

async function cancelLater(m) {
    try {
        await del(`/api/later/${m.id}`);
    } catch (err) {
        toast(`Could not cancel it: ${err.message}`, 'error');
    }
}

// The presets. Absolute times are resolved here rather than sent as offsets, so
// the row you picked and the row you get cannot disagree — the bridge's clock and
// this one are the same clock on this machine, but the message says a time and a
// time is what it should be stored as.
function atInMinutes(n) { return Date.now() + n * 60_000; }

/** The next time today or tomorrow that the wall clock reads `h:m`. */
function atClock(h, m) {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
}

function laterPresets() {
    return [
        { label: 'in 30 minutes', at: atInMinutes(30) },
        { label: 'in 2 hours', at: atInMinutes(120) },
        { label: 'tonight at 02:00', at: atClock(2, 0) },
        { label: 'tomorrow at 09:00', at: atClock(9, 0) },
    ];
}

/** `datetime-local` wants local wall-clock text, not an ISO instant. */
function localInputValue(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function showLater(on) {
    if (!on) return closeLater();
    // Only ever one popover up — the slash menu, the mentions and the snippets all
    // close each other, and this joins them rather than becoming the exception.
    closeMenus(live);
    closeSnips(live);
    if (live.wispr) closeWispr(live.wispr);
    state.laterPick = false;
    dom.laterMenu.hidden = false;
    dom.btnLater.setAttribute('aria-expanded', 'true');
    drawLater();
    positionLater();
}

export function closeLater({ focus = false } = {}) {
    if (dom.laterMenu.hidden) return;
    dom.laterMenu.hidden = true;
    dom.laterMenu.replaceChildren();
    dom.btnLater.setAttribute('aria-expanded', 'false');
    if (focus) dom.btnLater.focus();
}

/** positionSnips' arithmetic, on the one popover that is not a composer's. */
function positionLater() {
    const r = dom.btnLater.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - r.bottom - gap * 2;
    const above = r.top - gap * 2;
    const up = below < 260 && above > below;
    const width = Math.min(320, window.innerWidth - 24);

    dom.laterMenu.classList.toggle('up', up);
    dom.laterMenu.style.setProperty('--snip-max',
        `${Math.max(180, Math.min(460, up ? above : below))}px`);
    dom.laterMenu.style.width = `${width}px`;
    dom.laterMenu.style.left = `${Math.max(12, Math.min(r.right - width,
        window.innerWidth - width - 12))}px`;
    if (up) {
        dom.laterMenu.style.top = 'auto';
        dom.laterMenu.style.bottom = `${window.innerHeight - r.top + gap}px`;
    } else {
        dom.laterMenu.style.bottom = 'auto';
        dom.laterMenu.style.top = `${r.bottom + gap}px`;
    }
}

function drawLater() {
    const rows = laterPresets().map(p => el('button', {
        class: 'later-row', type: 'button', role: 'option',
        onclick: () => scheduleMessage(p.at),
    }, el('span', {}, p.label), el('span', { class: 'at' }, hhmm(p.at))));

    rows.push(el('button', {
        class: `later-row${state.laterPick ? ' on' : ''}`, type: 'button', role: 'option',
        onclick: () => { state.laterPick = !state.laterPick; drawLater(); },
    }, el('span', {}, 'Pick a time…')));

    rows.push(el('div', { class: 'later-sep' }));

    const modeSel = el('select', {
        'aria-label': 'Permission mode to deliver in',
        onchange: (e) => {
            laterMode = e.target.value;
            try { localStorage.setItem('laterMode', laterMode); } catch { /* private mode */ }
        },
    }, ...LATER_MODES.map(m => el('option', { value: m, selected: m === laterMode }, m)));

    const fields = [el('label', {}, el('span', {}, 'Deliver as'), modeSel)];

    if (state.laterPick) {
        const when = el('input', {
            type: 'datetime-local',
            value: localInputValue(atInMinutes(60)),
            min: localInputValue(Date.now()),
        });
        fields.push(el('label', {}, el('span', {}, 'At'), when));
        fields.push(el('button', {
            class: 'go', type: 'button',
            onclick: () => {
                // `datetime-local` gives wall-clock text with no zone; `new Date`
                // reads it as local, which is what was typed and what is meant.
                const at = new Date(when.value).getTime();
                if (!Number.isFinite(at)) return toast('Pick a date and a time.', 'warn');
                if (at <= Date.now()) return toast('That time has already passed.', 'warn');
                scheduleMessage(at);
            },
        }, 'Schedule'));
    }
    rows.push(el('div', { class: 'later-fields' }, ...fields));

    dom.laterMenu.replaceChildren(...rows);
}

/**
 * Hold the message back until `at`.
 *
 * sendMessage()'s body, minus the optimistic row and the unsent-text bookkeeping:
 * nothing is going to the process, so there is no turn to draw and nothing to hand
 * back. What it keeps is everything about *leaving the composer* — the same
 * attachments, the same emptying of the box and the strip, the same
 * restoreToComposer on failure — because from where you are sitting this is the
 * send button with a time on it.
 */
async function scheduleMessage(at) {
    const text = dom.input.value.trim();
    const files = readyAttachments(live);
    if ((!text && !files.length) || !state.current) {
        return toast('Write a message first.', 'warn');
    }

    // The lock is a rule, not a disabled button — sendMessage's words. It matters
    // more here: a message scheduled against a session another process is holding
    // is one that fails at 2am, when nobody is up to read the failure.
    if (lockedNow()) {
        toast('This session is running elsewhere, so a message scheduled here would '
            + 'not be delivered. Branch off a copy first.', 'warn');
        dom.lockFork.focus();
        return;
    }

    const sessionId = state.current.sessionId;
    const previews = files.length
        ? live.attach.filter(a => a.previewUrl).map(a => a.previewUrl) : [];

    dom.input.value = '';
    autoGrow();
    saveDraft(sessionId, '');
    clearAttach(live, { revoke: false });
    revokePreviews(previews);      // no row is drawn, so nothing hands these back
    closeLater();

    try {
        await post(`/api/sessions/${sessionId}/later`, {
            text,
            attachments: files,
            model: dom.model.value || null,
            permissionMode: laterMode,
            at,
        });
        // The chip arrives on the `later-changed` event, which the bridge pushes
        // before this resolves — so there is nothing to draw here.
        toast(`Scheduled for ${new Date(at).toLocaleString()}.`, 'ok');
    } catch (err) {
        restoreToComposer(text, files);
        toast(`Could not schedule it: ${err.message}`, 'error');
    }
}

// ── send queue ───────────────────────────────────────────────────────────
// Anything you write while an agent is working waits. The bridge holds those
// messages instead of pushing them straight down stdin, which is what makes them
// showable here: still yours, still editable, still droppable. When the agent
// starts a tool call the bridge hands them to the running turn, which reads them
// after that step, the way a terminal does. A chip marked `handed` is one of
// those: it can still be dropped (the bridge asks for it back, and a 409 means
// the turn got there first) but no longer reordered. Once the turn has read a
// message it leaves this list — nothing here pretends to cancel something that
// has already been sent.

/** Take the bridge's view of the queue and repaint. */
function applyQueue(s) {
    state.queue = (s && s.queue) || [];
    for (const id of state.queueOpen) {
        if (!state.queue.some(q => q.id === id)) state.queueOpen.delete(id);
    }
    renderQueue(s);
}

export function renderQueue(s) {
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
    // Once anything is handed over, the honest thing to say is when it will be
    // read, which is sooner than "when this turn finishes".
    const handed = q.some(x => x.handed);
    dom.queueCount.textContent = handed
        ? (q.length === 1 ? '1 message, read after the current step'
            : `${q.length} messages, read after the current step`)
        : q.length === 1
            ? (busy ? '1 message waiting for Claude\'s next step' : '1 message waiting')
            : `${q.length} messages waiting${busy ? ', in this order' : ''}`;
    dom.queueClear.textContent = q.length === 1 ? 'Drop it' : 'Drop all';

    // Runner status arrives every time the activity line moves, several times a
    // turn. Rebuilding the chips on each one would throw away focus, an expanded
    // message and any drag in progress, so only rebuild when the queue itself
    // actually changed.
    if (state.queueDrag) return;   // the drag owns the DOM until it ends
    const sig = q.map(x => x.id + (x.handed ? '*' : '')).join(',')
        + '|' + [...state.queueOpen].sort().join(',');
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
    const files = entry.attachments || [];
    const open = state.queueOpen.has(entry.id);
    const toggleOpen = () => {
        if (open) state.queueOpen.delete(entry.id);
        else state.queueOpen.add(entry.id);
        renderQueue(state.runner);
    };

    // Handed to the running turn: its place is fixed, so there is nothing to drag.
    const handed = !!entry.handed;
    const li = el('li', {
        class: 'queue-item' + (open ? ' open' : '') + (handed ? ' handed' : ''),
        'data-id': entry.id,
        draggable: handed ? 'false' : 'true',
        tabindex: entry.id === roving ? '0' : '-1',
        'aria-label': `${handed ? 'Message for the next step' : 'Waiting message'} `
            + `${i + 1} of ${state.queue.length}: ${clip(entry.text, 80)}`,
        onfocus: () => { state.queueFocus = entry.id; setRovingTab(); },
        onkeydown: (e) => onChipKey(e, entry, i, toggleOpen),
    },
        handed
            ? el('span', { class: 'queue-grip', title: 'Claude reads this after the current step' }, '↳')
            : el('span', { class: 'queue-grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⠿'),
        el('span', { class: 'queue-n' }, String(i + 1)),
        // A count, not the names. The chip is one line and the message is what it is
        // for; the point is only that Edit will bring files back with it, so dropping
        // this chip is dropping them too.
        files.length ? el('span', {
            class: 'queue-files',
            title: files.map(f => f.name || f.relPath).join('\n'),
        }, `📎${files.length > 1 ? files.length : ''}`) : null,
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
        if (handed) { e.preventDefault(); return; }
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
        // Escape leaves a subagent and closes the find bar; while a chip has the
        // focus it belongs to the chip.
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
        // The files come back with the words. The message was never written to the
        // process, so they are still staged rather than sent — and the alternative is
        // an edit that silently drops the screenshot the message was about.
        restoreToComposer(entry.text, (r.removed && r.removed.attachments) || entry.attachments);
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

// ── attachments ──────────────────────────────────────────────────────────
// Files pasted or dropped onto a composer.
//
// Under a live conversation each one is uploaded the moment it arrives, before the
// message is sent. That is what makes the rest of this simple: the chip shows the name
// the file really has on disk, a staged file survives a reload because only its path
// has to be remembered, and the send stays the same small JSON POST it always was — a
// list of paths, not a payload. The bridge writes them into attached_assets/ at the
// root of the session's checkout; see bridge/attachments.js for why there.
//
// **The Start-a-session dialog cannot do that, and holds its files instead.** Where a
// file lands is decided by the working directory, and that box is still editable after
// you have pasted — so uploading on arrival would put the screenshot in whichever
// project happened to be selected at the time, and leave it there when you browsed
// somewhere else and pressed Start. Held chips are committed by startNew, once the
// directory has stopped moving.
//
// Three things follow from holding them, and they are the price of it. A held chip
// shows the name you gave rather than the name on disk, because a collision has not
// renamed it yet. It does not survive a reload, since the bytes are in this page — and
// nothing is lost, because a reload closes the dialog anyway. And Start becomes two
// phases, which is why it refuses to start at all if an upload fails: a first message
// naming a file that was never written is worse than not starting.

// Matches the bridge, which is the side that enforces them. Checked here so that
// dropping a video says what the limit is instead of uploading 200MB to be refused.
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
const MAX_ATTACH_FILES = 5;

// The types the bridge will inline as an image, and so the ones a chip draws a
// thumbnail for.
const ATTACH_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A name for a file that arrived without a usable one.
 *
 * A pasted screenshot is `image.png` in Chromium and nameless everywhere else, so the
 * client always supplies something and the bridge always requires it — better here,
 * where the clock and the media type are both to hand, than invented server-side.
 */
function attachName(file) {
    if (file.name) return file.name;
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
        + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const ext = (file.type || '').split('/')[1] || 'bin';
    return `pasted-${stamp}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

/** Does this drag carry files, as opposed to one of our own chips? */
function dragHasFiles(dt) {
    return Boolean(dt && Array.from(dt.types || []).includes('Files'));
}

/**
 * Take files in — from a paste, a drop, or the paperclip. The single entry point.
 *
 * Uploaded one at a time rather than all at once. It keeps several 25MB bodies off the
 * wire together, and it makes the per-chip failure story true: four succeed and the
 * fifth goes red, instead of a batch that half-worked.
 */
async function attachFiles(c, list) {
    if (!c.ctx()) {
        // The dialog can be in this state — no directory chosen — and a file that
        // arrives now has nowhere to be described relative to.
        if (c.notReady) toast(c.notReady, 'warn');
        return;
    }
    const files = Array.from(list || []).filter(f => f && f.size !== undefined);
    if (!files.length) return;

    const room = MAX_ATTACH_FILES - c.attach.length;
    if (room <= 0) {
        toast(`${MAX_ATTACH_FILES} files is the limit for one message.`, 'warn');
        return;
    }
    if (files.length > room) {
        toast(`Only ${room} more file${room === 1 ? '' : 's'} fit on this message.`, 'warn');
    }

    for (const file of files.slice(0, room)) {
        // Refused here, with the number in it. The bridge refuses it too, but a 413
        // arriving after a 40MB upload is a worse way to learn the same thing.
        if (file.size > MAX_ATTACH_BYTES) {
            toast(`${file.name || 'That file'} is ${formatBytes(file.size)} — the limit `
                + `is ${formatBytes(MAX_ATTACH_BYTES)}.`, 'warn');
            continue;
        }
        if (!file.size) {
            toast(`${file.name || 'That file'} is empty.`, 'warn');
            continue;
        }

        const entry = {
            key: `a${++c.attachSeq}`,
            name: attachName(file),
            bytes: file.size,
            mediaType: file.type || 'application/octet-stream',
            // Cheaper than a FileReader and it never holds the bytes in a string.
            // Revoked on removal, on send and on leaving the session.
            previewUrl: ATTACH_IMAGE_TYPES.has(file.type) ? URL.createObjectURL(file) : null,
            path: null, relPath: null,
            // `held` is the deferred composer's resting state: on disk nowhere, and
            // waiting for a directory to stop moving.
            status: c.uploadMode === 'deferred' ? 'held' : 'uploading',
            error: null,
            file,
        };
        c.attach.push(entry);
        renderAttach(c);
        if (c.uploadMode !== 'deferred') await uploadAttachment(c, entry);
    }
}

/**
 * Where one file goes: this composer's session if it has one, its directory if not.
 *
 * The two routes are the same upload — the session in the path was only ever a way of
 * naming a working directory. See docs/api.md on POST /api/attachments.
 */
function attachUrl(c, name) {
    const at = c.ctx();
    if (!at) return null;
    const n = `name=${encodeURIComponent(name)}`;
    return at.sessionId
        ? `/api/sessions/${at.sessionId}/attachments?${n}`
        : `/api/attachments?cwd=${encodeURIComponent(at.cwd)}&${n}`;
}

async function uploadAttachment(c, entry) {
    const url = attachUrl(c, entry.name);
    if (!url || !entry.file) return;
    entry.status = 'uploading';
    entry.error = null;
    renderAttach(c);
    try {
        const r = await postFile(url, entry.file);
        // The name on disk wins. A collision made it `shot-2.png`, and a chip still
        // saying `shot.png` would name a file the message does not attach.
        entry.name = r.name;
        entry.path = r.path;
        entry.relPath = r.relPath;
        entry.mediaType = r.mediaType;
        entry.bytes = r.bytes;
        entry.status = 'ready';
        // Nothing needs the File once the bytes are on disk, and holding it keeps a
        // blob alive for as long as the chip does.
        entry.file = null;
        saveAttachFor(c);
    } catch (err) {
        entry.status = 'failed';
        entry.error = err.message;
    }
    renderAttach(c);
}

/**
 * Put every held file on disk, and answer with what a create call should carry —
 * or null, meaning do not start.
 *
 * Refusing on the first failure is the whole point. The alternative is a session
 * whose first message names a file that was never written, which reads to the agent
 * as a missing file and to the person as the feature being broken. The chip keeps its
 * File, so the Retry button on it still works.
 */
async function commitAttachments(c) {
    for (const a of c.attach) {
        if (a.status === 'ready') continue;
        await uploadAttachment(c, a);
        if (a.status !== 'ready') {
            toast(`Could not attach ${a.name}: ${a.error || 'upload failed'}`, 'error');
            return null;
        }
    }
    return readyAttachments(c);
}

/** Only a composer with somewhere to persist to — see the section header. */
function saveAttachFor(c) {
    const id = c.persistKey && c.persistKey();
    if (id) saveAttach(id, c.attach);
}

/** Chips for files the bridge already knows about — a restored draft, or an edit. */
function adoptAttachments(c, files) {
    for (const f of files || []) {
        if (c.attach.length >= MAX_ATTACH_FILES) break;
        if (c.attach.some(a => a.path && a.path === f.path)) continue;
        c.attach.push({
            key: `a${++c.attachSeq}`,
            name: f.name || String(f.relPath || '').split('/').pop(),
            bytes: f.bytes || 0,
            mediaType: f.mediaType || 'application/octet-stream',
            // No object URL: these files were never a File in this page. A restored
            // image chip draws the glyph rather than a broken img.
            previewUrl: null,
            path: f.path || null,
            relPath: f.relPath || null,
            status: 'ready',
            error: null,
            file: null,
        });
    }
    renderAttach(c);
    saveAttachFor(c);
}

function removeAttach(c, key) {
    const i = c.attach.findIndex(a => a.key === key);
    if (i < 0) return;
    const [gone] = c.attach.splice(i, 1);
    if (gone.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    // Deliberately not deleted from disk. A delete route is a second thing that
    // writes to a checkout and a second refusal to reason about, and an unsent file
    // in attached_assets/ is a harmless untracked file you can see — where a delete
    // that resolves the wrong path is not harmless. A held file was never written at
    // all, so there is nothing to say about it either way.
    renderAttach(c);
    saveAttachFor(c);
}

/**
 * Everything staged, gone — on a send, or on leaving the session.
 *
 * `revoke: false` is for the send path, and it is not an optimisation. The row drawn
 * at the foot of the log the instant you press Enter shows the thumbnails, and those
 * are these object URLs; revoking them here blanked the image in the same frame it
 * appeared. So the send hands them to the pending row, which revokes them when it
 * goes — and every path that does not draw one revokes them itself.
 */
export function clearAttach(c, { save = true, revoke = true } = {}) {
    if (revoke) revokePreviews(c.attach.map(a => a.previewUrl));
    c.attach = [];
    renderAttach(c);
    if (save) saveAttachFor(c);
}

function revokePreviews(urls) {
    for (const u of urls || []) if (u) URL.revokeObjectURL(u);
}

/** What a send may carry: the ones that made it to disk. */
const readyAttachments = (c) => c.attach
    .filter(a => a.status === 'ready' && a.path)
    .map(a => ({ path: a.path, relPath: a.relPath, mediaType: a.mediaType, name: a.name }));

// The extension, for the glyph on a non-image chip. Short enough to read at 10px.
export function attachExt(name) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
    return m ? m[1].toLowerCase() : 'file';
}

export function renderAttach(c) {
    const list = c.attach;
    c.attachNode.hidden = !list.length;
    c.attachNode.replaceChildren(...list.map((a) => {
        const bits = [];
        if (a.previewUrl) {
            bits.push(el('img', { class: 'attach-thumb', src: a.previewUrl, alt: '' }));
        } else {
            bits.push(el('span', { class: 'attach-glyph' }, attachExt(a.name)));
        }
        bits.push(el('span', { class: 'attach-name', title: a.relPath || a.name }, a.name));
        bits.push(el('span', { class: 'attach-size' },
            a.status === 'uploading' ? 'uploading…' : formatBytes(a.bytes)));
        if (a.status === 'failed') {
            bits.push(el('button', {
                class: 'attach-act', type: 'button', title: a.error || 'Upload failed',
                onclick: () => uploadAttachment(c, a),
            }, 'Retry'));
        }
        bits.push(el('button', {
            class: 'attach-act danger', type: 'button', 'aria-label': `Remove ${a.name}`,
            title: 'Remove', onclick: () => removeAttach(c, a.key),
        }, '×'));

        return el('div', {
            class: `attach-chip${a.status === 'ready' ? '' : ` ${a.status}`}`,
            title: a.status === 'failed' ? a.error : (a.relPath || a.name),
        }, ...bits);
    }));
    // An attachment on its own is a message, so whatever sends it has to follow the
    // strip and not only the box.
    if (c.afterRender) c.afterRender();
}

/**
 * A paste that carries files.
 *
 * The condition is narrow on purpose. Cancelling a paste that was only ever text is
 * the most likely way this feature breaks something that worked, and web/terminal.js
 * already carries a comment about the last time a paste handler in this codebase took
 * over more than it should have. A screenshot arrives with files and no `text/plain`;
 * a file copied out of a file manager brings `text/uri-list` alongside it; text
 * copied out of an editor brings `text/plain` and no files at all. So: files, and
 * either nothing textual or an actual image.
 */
function onComposerPaste(c, e) {
    const dt = e.clipboardData;
    if (!dt) return;
    const items = Array.from(dt.items || []);
    const files = Array.from(dt.files || []);
    if (!files.length && !items.some(i => i.kind === 'file')) return;

    const hasText = Array.from(dt.types || []).includes('text/plain');
    const anyImage = files.some(f => ATTACH_IMAGE_TYPES.has(f.type));
    if (hasText && !anyImage) return;

    e.preventDefault();
    attachFiles(c, files.length ? files
        : items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean));
}

/**
 * Dragging files over the composer.
 *
 * Both gates are before `preventDefault`, and that is what keeps the queue-chip drag
 * working without touching a line of it: a chip drag puts only `text/plain` on the
 * transfer, so `dragHasFiles` is false, this returns early, and #queue-list's own
 * dragover still sees the event exactly as it did before.
 */
function onComposerDragOver(c, e) {
    if (state.queueDrag) return;
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    c.dropZone.classList.add('drop-target');
}

function onComposerDragLeave(c, e) {
    // Only when the pointer has actually left the composer. Without the check the
    // highlight flickers off every time the drag crosses a child element.
    if (e.relatedTarget && c.dropZone.contains(e.relatedTarget)) return;
    c.dropZone.classList.remove('drop-target');
}

function onComposerDrop(c, e) {
    if (state.queueDrag) return;
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    c.dropZone.classList.remove('drop-target');
    attachFiles(c, e.dataTransfer.files);
}

/**
 * Everything a composer needs to take files: the strip, the picker, the drop zone.
 *
 * Separate from wireComposer because not every composer has one — a composer with no
 * `attachNode` simply never gets these listeners, and nothing else has to know.
 */
function wireAttachments(c) {
    if (!c.attachNode) return;
    c.input.addEventListener('paste', (e) => onComposerPaste(c, e));
    c.dropZone.addEventListener('dragover', (e) => onComposerDragOver(c, e));
    c.dropZone.addEventListener('dragleave', (e) => onComposerDragLeave(c, e));
    c.dropZone.addEventListener('drop', (e) => onComposerDrop(c, e));
    if (c.attachBtn) {
        c.attachBtn.addEventListener('click', () => c.attachInput.click());
    }
    if (c.attachInput) {
        c.attachInput.addEventListener('change', () => {
            attachFiles(c, c.attachInput.files);
            // So picking the same file twice in a row fires `change` the second time.
            c.attachInput.value = '';
        });
    }
}

/**
 * Open one of a turn's attachments in whatever this machine opens that kind of file
 * with. The bridge re-derives the path against the session's own attachments
 * directory before launching anything — see `attachmentPath` in bridge/server.js.
 */
export async function openAttachment(sessionId, relPath) {
    try {
        await post(`/api/sessions/${sessionId}/attachments/open`, { path: relPath });
    } catch (err) {
        toast(`Could not open ${relPath}: ${err.message}`, 'warn');
    }
}

// ── composer ─────────────────────────────────────────────────────────────

/**
 * Size a textarea to its contents.
 *
 * `height: auto` first so the box can shrink again — scrollHeight never reports
 * less than the height already set, so measuring without clearing it makes a
 * textarea that only ever grows.
 */
export function grow(ta, min, max) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(min, Math.min(max, ta.scrollHeight)) + 'px';
}

// Never below the button height, so an empty composer stays centred.
export const autoGrow = () => grow(dom.input, 38, 220);

// The dialog's own limits: two lines to start, and a ceiling low enough that a
// pasted-in briefing cannot push the Start button off the bottom of the modal.
const growPrompt = () => grow(dom.newPrompt, 62, 300);

/**
 * Every way of sending from this composer turns on and off together.
 *
 * The pinned snippets are in it because each one is an ordinary message with a
 * written-out text, so it goes into the same transcript by the same path — which
 * is the argument the LGTM button's line here used to make on its own, back when
 * there was exactly one of them.
 */
export function enableSend(on) {
    dom.btnSend.disabled = !on;
    dom.btnSnippets.disabled = !on;
    for (const b of dom.pins.children) b.disabled = !on;
    // Attaching needs a session for the same reason sending does — the file goes into
    // *that* session's checkout — so it turns on and off with them.
    dom.btnAttach.disabled = !on;
    // And so does scheduling, which is a send with a time on it.
    dom.btnLater.disabled = !on;
}

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
function showPendingSend(sessionId, text, files, previews) {
    if (state.pendingSend) return revokePreviews(previews);
    // The real renderer, so the swap when the transcript catches up is one node for
    // another and not a reflow. No `ts`: clockOf gives an empty gutter for a missing
    // one, and the marker on it says what that means. Sending the local clock
    // instead would print a time the transcript is then free to disagree with —
    // a cold start really does record the entry a second or more later.
    // The object URLs and the file list, so the row that appears the instant you press
    // Enter is the row the transcript will replace it with — thumbnail, cards and all —
    // rather than a bare line of text that grows a screenshot a second later.
    const node = renderUser({
        kind: 'user', text, ts: null,
        images: (previews || []).map(url => ({ dataUri: url })),
        files: (files || []).map(f => ({ relPath: f.relPath, name: f.name, size: null })),
    });
    node.dataset.pending = '1';
    dom.log.append(node);
    state.pendingSend = {
        sessionId, node, previews, timer: setTimeout(clearPendingSend, PENDING_MS),
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
export function clearPendingSend() {
    const p = state.pendingSend;
    if (!p) return;
    clearTimeout(p.timer);
    state.pendingSend = null;
    p.node.remove();
    // The row was the last thing holding these; the transcript's own copy of the
    // image comes from the transcript.
    revokePreviews(p.previews);
}

async function sendMessage({ fork = false, text: override = null, canned = false } = {}) {
    const text = override != null ? override : dom.input.value.trim();
    // Attachments only ride on a message that came out of the box. A canned send — a
    // snippet that sends itself, a follow-up card — must not walk off with a screenshot
    // you staged for something else, by the same argument that leaves the half-typed
    // text alone.
    const files = override == null ? readyAttachments(live) : [];
    // A screenshot with nothing typed under it is a message: "look at this" is the
    // whole content of it.
    if ((!text && !files.length) || !state.current) return;
    const sessionId = state.current.sessionId;

    // The lock is a rule, not a disabled button. Greying out the buttons left
    // Enter — and every internal caller, a snippet included — going straight past it
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
    // Taken before the strip is emptied, because emptying it is what would revoke them.
    const previews = files.length
        ? live.attach.filter(a => a.previewUrl).map(a => a.previewUrl)
        : [];

    if (override == null) {
        dom.input.value = '';
        autoGrow();
        saveDraft(sessionId, '');
        clearAttach(live, { revoke: false });
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
    if (!fork && !willQueue) showPendingSend(sessionId, text, files, previews);
    // No row was drawn, so nothing is going to hand these back.
    else revokePreviews(previews);

    enableSend(false);

    try {
        const r = await post(`/api/sessions/${sessionId}/send`, {
            text,
            // Paths, not bytes: every one of these is already on disk, written by the
            // attachments route before its chip appeared.
            attachments: files,
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
        // The files are still on disk, so handing their metadata back is enough to put
        // the chips where they were.
        if (!canned) restoreToComposer(text, files);
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

export async function loadCommands() {
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
    // What a click does, since it depends on the run: start it, show its log,
    // or show its page. See clickCommand().
    bits.push(runPreviewable(run) ? 'Click to show its page'
        : run && run.state !== 'exited' ? 'Click to show its output'
        : 'Click to start');

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
        // Up and serving pages: the page is what the button is for. The log is
        // one click away, on the preview's toolbar, and the pane is left as it
        // was rather than opened underneath where nobody can see it.
        if (runPreviewable(existing)) {
            openRunPreview(existing);
            return;
        }
        showTerm(true);
        setTermTab(existing.id);
        // Still coming up: show the page once it does. One-shot, and only for
        // the run this click was about.
        if (existing.port) state.previewWhenUp = existing.id;
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
        // Starting a server is asking to look at it: the log first, while it
        // compiles, and the page once it answers.
        if (run.port) state.previewWhenUp = run.id;
    } catch (err) {
        toast(`${cmd.label}: ${err.message}`, 'error');
    }
}

/**
 * Whether a task's page is worth showing yet: its port is taken, and either it
 * has answered HTTP or the command says it is a web app (`"web": true`). The
 * second is for a server whose first page takes longer than anyone wants to
 * wait for a probe: the preview goes up at once and the page loads in front of
 * you, rather than the button only showing the log.
 */
function runPreviewable(run) {
    return !!run && run.state === 'listening' && !!run.port
        && (run.http === true || run.web === true);
}

/** A task's page, by the same rule as any other port. */
function openRunPreview(run) {
    openPreview({
        port: run.port,
        title: run.label || null,
        runId: run.id,
        http: run.http || run.web,
    }).catch((err) => toast(`Could not open :${run.port}. ${err.message}`, 'error'));
}

/** A run's state changed somewhere — possibly in another window. */
function applyRunChange(e) {
    const known = state.runs.get(e.runId);
    if (known) {
        state.runs.set(e.runId, { ...known, state: e.state, port: e.port, http: e.http,
            exit: e.exit, stopped: e.stopped });
        const run = state.runs.get(e.runId);
        // The one-shot a click on a starting task left behind, now due. In this
        // window only: raising DevBrowser because a server finished compiling
        // is the window-on-the-Windows-host that bridge/runs.js name() refuses
        // to open, and a click that happened a minute ago is not consent to it.
        if (state.previewWhenUp === e.runId && runPreviewable(run)) {
            state.previewWhenUp = null;
            if (!opensInDevBrowser() && run.workspace === cmdDir()) openRunPreview(run);
        }
        // Its server is gone, so its kept page is a page of nothing.
        if (e.state === 'exited' && e.port) {
            if (state.previewWhenUp === e.runId) state.previewWhenUp = null;
            previewPane.discard(e.port);
        }
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

export const termPane = new TerminalPane({
    mount: dom.termBody,
    onOpen: (info) => paintTermHead(info),
    onError: (msg) => toast(`Terminal: ${msg}`, 'error'),
    // A function rather than a value, so toggling the setting reaches a shell
    // that is already open. `keyboard` is user-level only, which is why this
    // reads BOOT_PREFS and not the open session's answer.
    contextualCopy: () => BOOT_PREFS.keyboard.contextualTerminalCopy,
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

export function termOpen(id) {
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
    dom.termPreview.hidden = true;

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
        dom.termPreview.hidden = true;
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
    paintRunPreview(run, live);
}

/**
 * The run's Preview button, the one control that says out loud that a task's
 * page can be shown. Clicking the task's own header button does the same once
 * it is up, but nothing about a button that started something says so.
 *
 * Up and answering: it opens the page. Still coming up: it waits, and a click
 * arms the same one-shot a click on a starting task does, so the page opens
 * once the server answers. Never armed toward DevBrowser, for the reason
 * applyRunChange() gives, so in that mode it just waits.
 */
function paintRunPreview(run, live) {
    const b = dom.termPreview;
    b.hidden = !live || !run.port;
    if (b.hidden) return;
    const ready = runPreviewable(run);
    const toDevBrowser = opensInDevBrowser();
    const armed = !toDevBrowser && state.previewWhenUp === run.id;
    b.disabled = !ready && (armed || toDevBrowser);
    b.textContent = toDevBrowser ? 'Open in DevBrowser'
        : !ready && armed ? 'Preview when up' : 'Preview';
    b.title = ready ? openTitle({ port: run.port, title: run.label, http: true })
        : armed ? `Opens by itself once :${run.port} answers`
        : opensInDevBrowser() ? `Waiting for :${run.port} to answer`
        : `:${run.port} has not answered yet — open its page once it does`;
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
export function showTerm(on, { focus = false } = {}) {
    setTermOpen(state.current && state.current.sessionId, on);
    dom.termPane.hidden = !on;
    dom.btnTerm.classList.toggle('on', on);
    dom.btnTerm.setAttribute('aria-pressed', String(on));
    renderHeaderActions();
    if (!on) {
        // The focus was inside the thing that just disappeared — the shell, or
        // the Hide button that did it — so it would otherwise fall to <body> and
        // the next keystroke would go nowhere. The composer is where you were
        // going anyway.
        if (dom.termPane.contains(document.activeElement) && !dom.input.disabled) dom.input.focus();
        termPane.detach();
        return;
    }

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
        dom.termPreview.hidden = true;
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
 * The Start-a-session dialog, which is also the edit-a-draft dialog.
 *
 * @param {{cwd?: string, tab?: 'recent'|'browse', prompt?: string, draft?: object,
 *   schedule?: object|boolean, seed?: object}} [opts]
 *   `cwd` is a caller that has already answered "where" — the split menu passes
 *   the row you clicked. Without one the dialog opens where it always has: the
 *   session on screen, else the most recent project. `prompt` fills the first
 *   message, for a caller that has already written one — Edit first on a
 *   suggested follow-up, where the whole point is that the prompt exists and you
 *   want a look at it before it runs.
 *
 *   `draft` opens the dialog *as* that draft: every field prefilled, the title
 *   and the save button renamed, and Save writing back to it rather than making
 *   another. One dialog for both because a draft is exactly the set of fields
 *   this one already collects — a second form would be the same six controls
 *   with a different chance of drifting.
 *
 *   `schedule` is the same trick again: `true` for a new one, a row to edit that
 *   one. It shows the two rows only a schedule has, and swaps the footer.
 *
 *   `seed` is prefill for a schedule that has no row yet — what the Schedule
 *   button hands over when it converts what is on screen. It reads like a row
 *   here, so the prefills below take it as one; the difference is that it leaves
 *   `state.sched.editing` null, so the save is a POST rather than a PATCH. Its
 *   one extra key is `fromDraft`, the draft the save will consume.
 *
 * **Model and permission mode are written on every open, in both directions.**
 * They used to be left alone, which was harmless while the dialog only ever
 * started things: the selects kept your last choice, which was usually what you
 * wanted again. It stops being harmless once a draft can set them — opening a
 * `bypassPermissions` draft and then pressing Ctrl+N would offer that mode for a
 * brand-new session, having been asked for once, about something else.
 */
export async function openNew({ cwd = '', tab = null, prompt = '', draft = null,
    schedule = null, seed = null } = {}) {
    // `schedule: true` means "a new one"; a row means "edit that one". The two
    // have to be told apart because only the second has fields to prefill, and
    // both have to put the dialog in schedule mode.
    const sched = schedule && typeof schedule === 'object' ? schedule : null;
    const schedMode = Boolean(schedule);
    // A draft and a schedule are the same fields with a different owner, so one
    // local stands in for whichever is being edited and the prefill below reads
    // from it once instead of branching on every line. A `seed` joins them as a
    // third: the same fields again, from something that is not a stored row.
    const src = sched || seed || draft;

    state.drafts.editing = draft ? draft.id : null;
    // A seed is prefill, not an edit — the schedule it describes does not exist
    // yet — so `editing` stays null and schedSave still POSTs. What it does carry
    // is which draft it came from, if any.
    state.sched.editing = sched ? sched.id : null;
    state.sched.fromDraft = seed ? (seed.fromDraft || null) : null;

    // Ctrl+N over a live composer with `/rev` half-typed in it is reachable, and
    // a popover anchored to a box that is now behind a modal is nothing but
    // debris on screen.
    closeMenus(live);

    dom.newScrim.hidden = false;
    dom.newPrompt.value = src ? src.prompt : prompt;
    growPrompt();
    // Written on every open in both directions, the rule this docstring states:
    // a name left behind from the last draft you looked at would be attached to
    // the next thing you saved.
    dom.newName.value = src ? (src.title || '') : '';
    dom.newTest.checked = src ? !!src.test : false;
    dom.newModel.value = src ? (src.model || '') : '';
    // The dialog's own default, and deliberately not the composer's: the first
    // message of a session is the one written with the least idea of what it will
    // touch. Spelled out here rather than left to the `selected` attribute, which
    // only decides the very first open.
    //
    // A *new* schedule defaults to `dontAsk` instead, and that is the one place
    // this dialog's default depends on what is being made. `plan` is right for a
    // message you are about to watch run and wrong for one that runs at 2 AM: a
    // scheduled session in `plan` writes a plan nobody reads, and one in `auto`
    // stops at the first prompt and waits until morning. Editing an existing
    // schedule keeps whatever it already had.
    dom.newPerm.value = src ? src.permissionMode : (schedMode ? 'dontAsk' : 'plan');
    // **Only what somebody said.** A draft or schedule being edited carries its
    // own directory, and every caller that means a particular project passes
    // one — the suggested-task dialog, the rail's split button, the conversion
    // from a draft. What is gone is the guessing underneath that: the open
    // session's directory, and, below, the most recently active project. Both
    // scoped a session for you, and neither said so, which made the commonest
    // way to get this wrong "not noticing that it had been answered". Nothing
    // else has to change for the box to be empty: newDialogValues() has always
    // refused a dialog with no directory in it.
    setNewCwd((src && src.cwd) || cwd || '');

    // The two fields only a schedule has.
    dom.newCronRow.hidden = !schedMode;
    dom.newGateRow.hidden = !schedMode;
    // The picker rather than an expression, and filled from the bridge's own
    // reading of one: `cronForm` is what says which row an existing schedule
    // belongs on. A new schedule opens on Weekly, Tue–Sat at 02:00 — the same
    // suggestion the cron box used to open with, spelled as controls.
    // A seeded schedule opens on One time. It is the shape the conversion is
    // for — a draft is a thing you meant to do once, and the clock is only
    // standing in for the Start you would have pressed — and it is a choice you
    // can still change before saving, like every other preset here.
    setWhen(sched ? sched.cronForm : null, sched ? sched.cron : '',
        sched ? !!sched.once : false, { newRow: seed ? 'once' : 'weekly' });
    const gate = sched ? sched.gate : null;
    dom.newGateKind.value = gate ? gate.kind : '';
    dom.newGateRef.value = gate && gate.kind === 'git-commits' ? gate.ref : '';
    dom.newPrDrafts.checked = gate && gate.kind === 'open-prs'
        ? gate.includeDrafts !== false : true;
    dom.newPrPost.checked = gate && gate.kind === 'open-prs'
        ? gate.post !== false : true;
    paintGateFields();
    if (schedMode) describeCronSoon();

    // Schedule mode swaps Start and Save-as-draft for one button: a schedule you
    // have written has not run and is not meant to yet, so "keep this" and "do
    // this" are the same press.
    dom.newGo.hidden = schedMode;
    dom.newSave.hidden = schedMode;
    // Offered from Start-a-session as well as from a draft: the fields it needs
    // are the fields this dialog always collects, and refusing to schedule
    // something you had not saved first would be an extra step for no reason.
    dom.newSched.hidden = schedMode;
    dom.newSchedSave.hidden = !schedMode;
    dom.newSchedSave.textContent = sched ? 'Save changes' : 'Save schedule';

    // Only where the dialog is about to start a session. A draft and a schedule are
    // records of a create call, and neither store carries attachments — see
    // docs/api.md — so offering the control there would be offering something that
    // silently does not survive being saved.
    dom.newAttachRow.hidden = schedMode || Boolean(draft);
    clearAttach(newC);

    dom.newTitle.textContent = schedMode
        ? (sched ? 'Edit schedule'
            : (state.sched.fromDraft ? 'Schedule this draft' : 'Schedule a session'))
        : (draft ? 'Edit draft' : 'Start a session');
    dom.newSave.textContent = draft ? 'Save changes' : 'Save as draft';
    cancelMkdir();
    try {
        const projects = await loadProjects();
        dom.newPicker.replaceChildren(...projects.slice(0, 40).map((p) => {
            // A dot in the project's own colour, so what the dialog is about to
            // turn into is readable before the press rather than after it.
            const accent = projectColor(p.cwd);
            return el('button', {
                class: 'picker-row', type: 'button',
                'data-tinted': accent ? '1' : null,
                style: accent ? `--proj-accent: ${accent}` : null,
                onclick: () => { setNewCwd(p.cwd); dom.newPrompt.focus(); },
            },
                el('span', { class: 'pdot' }, ''),
                el('span', {}, p.name),
                el('span', { class: 'path' }, clip(p.cwd, 44)),
                p.active ? el('span', { class: 'tag' }, `${p.active} live`) : null,
            );
        }));
    } catch (err) {
        toast(`Could not list projects: ${err.message}`, 'error');
    }
    setPickerTab(tab || state.browse.tab, { load: true });
    dom.newPrompt.focus();
    // A prompt that arrived already written is there to be read and edited, so
    // put the caret at the end of it rather than in front of the first word.
    const written = dom.newPrompt.value;
    if (written) dom.newPrompt.setSelectionRange(written.length, written.length);
}

/**
 * Write the working-directory box, and repaint what hangs off it.
 *
 * The one way in, because three things used to write that input on their own —
 * openNew(), a row in the Recent list, and every step through the Browse tree —
 * and the dialog's colour and the project named in its head have to follow all
 * three. The `input` listener covers the fourth writer, which is a person typing.
 */
function setNewCwd(value) {
    dom.newCwd.value = value;
    paintNewProject();
}

/**
 * Which project the dialog is about, and the colour it wears for it.
 *
 * Two separate jobs, deliberately in one function: the chip names the project
 * whether or not it has a colour, and the colour is only ever an addition to
 * that. A dialog with no project at all says so rather than showing nothing,
 * because an empty box is exactly the state the head exists to make visible.
 *
 * `data-tinted` rather than a bare custom property is what keeps the uncoloured
 * dialog identical to the one this app has always drawn: every tint rule in
 * web/styles.css hangs off that attribute, so without it not one of them
 * applies — rather than all of them applying through a colour-mix that happens
 * to land near the blue they replace.
 */
function paintNewProject() {
    const cwd = dom.newCwd.value.trim();
    const accent = projectColor(cwd);
    const name = cwd ? (cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() || cwd) : '';

    if (accent) dom.newScrim.style.setProperty('--proj-accent', accent);
    else dom.newScrim.style.removeProperty('--proj-accent');
    dom.newScrim.toggleAttribute('data-tinted', !!accent);

    dom.newProject.replaceChildren(
        el('span', { class: 'pdot' }, ''),
        el('span', { class: 'new-project-name' }, name || 'No project selected'),
    );
    dom.newProject.classList.toggle('none', !cwd);
}

function closeNew() {
    dom.newScrim.hidden = true;
    // Hiding the scrim does not blur the box inside it, so the blur-to-close
    // never fires and a popover would still be up — fixed to the viewport, over
    // nothing — the next time the dialog opened.
    closeMenus(newC);
    closeSnips(newC);
    // Held files are bytes in this page and were never written anywhere, so closing
    // the dialog really does discard them — which is the whole benefit of holding
    // them rather than uploading on arrival.
    clearAttach(newC);
    // So a Save that somehow ran after this could not write to a draft the dialog
    // is no longer showing. openNew sets it on the way in either way.
    state.drafts.editing = null;
    state.sched.editing = null;
    // Otherwise a schedule saved later in this window would consume a draft that
    // an earlier, abandoned conversion had named.
    state.sched.fromDraft = null;
}

// ── the recent-directories menu ──────────────────────────────────────────

// Six, so the whole menu — including the way out of it — fits without
// scrolling. The dialog's Recent tab is still there for the long tail; this is
// meant to be the handful of directories you are actually in this week.
const NEW_MENU_MAX = 6;
let newMenuSeq = 0;

export function showNewMenu(on, { focusFirst = false } = {}) {
    dom.newMenu.hidden = !on;
    dom.btnNewMenu.setAttribute('aria-expanded', String(on));
    if (on) { showQuota(false); showBarMore(false); fillNewMenu({ focusFirst }); }
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
        // The same dot the dialog's Recent list carries, for the same reason: this
        // menu is the short way to scope a session, so it is the place a colour
        // has to be readable before the press.
        'data-tinted': projectColor(p.cwd) ? '1' : null,
        style: projectColor(p.cwd) ? `--proj-accent: ${projectColor(p.cwd)}` : null,
        onclick: () => { showNewMenu(false); openNew({ cwd: p.cwd }); },
        onkeydown: (e) => onNewMenuKey(e, i),
    },
        el('span', { class: 'pdot' }, ''),
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
    if (select) setNewCwd(data.path);
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

/**
 * What the dialog is currently describing, or null if it is not ready.
 *
 * Shared by the two buttons in the footer rather than copied into each: Start and
 * Save want exactly the same fields and exactly the same two complaints, and the
 * cost of having said them twice would be a save that accepted something a start
 * would refuse.
 *
 * Says so and returns null rather than throwing — the caller's next line is
 * always "then stop", and both callers are event handlers.
 */
function newDialogValues() {
    const cwd = dom.newCwd.value.trim();
    const prompt = dom.newPrompt.value.trim();
    if (!cwd) { toast('Pick a working directory first.', 'warn'); return null; }
    // A screenshot with nothing typed is a message — "look at this" is the whole
    // content of it — and the create route takes it that way too.
    if (!prompt && !newC.attach.length) {
        toast('Write a first message so the session has something to do.', 'warn');
        return null;
    }
    const body = {
        cwd, prompt,
        model: dom.newModel.value || null,
        permissionMode: dom.newPerm.value,
    };
    // `test` is only sent where the checkbox exists, which is the development
    // bridge alone — markInstance() hides the row otherwise. Sending it anyway
    // would be a silent lie in the one case that matters: a test-flagged draft
    // opened for editing in the everyday window would come back with
    // `test: false` from a control nobody could see, and the session it later
    // started would land in the user's real rail. PATCH leaves out what it is not
    // given, so omitting it preserves the flag; a create with it absent is
    // unflagged, which is right when the box was never offered.
    if (state.dev) body.test = dom.newTest.checked;
    return body;
}

/**
 * The name box, as the `title` field the two stores take.
 *
 * **Deliberately not part of `newDialogValues`.** That body is also the body of
 * `POST /api/sessions`, which takes no title — and the docstring above says why a
 * key a route ignores must not ride along on it. So the two callers that store a
 * title ask for it, and Start does not.
 *
 * `null` rather than `''`: a PATCH reads `null` as *clear this* and absence as
 * *leave it alone*, so emptying the box has to send something.
 */
function newDialogName() {
    return dom.newName.value.trim() || null;
}

// ── the trigger picker ──────────────────────────────────────────────────────
//
// One direction only: **the picker composes cron and never parses it.** Reading
// an expression back — which the dialog has to do to open an existing schedule
// on the right row — is the bridge's `cronForm`, arriving on the row as
// `cronForm` and from `/api/schedules/describe` as `form`. That keeps the rule
// docs/api.md states: the process that decides when a schedule runs is the only
// one that gets an opinion about what an expression means.
//
// Composing is safe to do here because it cannot disagree with anything. There
// is no expression to misread — five fields get built out of controls whose
// values are already numbers — and the sentence under the picker is still the
// bridge's answer about the result.

const WHEN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The selected row, or null before the dialog has ever been opened. */
function whenKind() {
    const on = dom.newCronRow.querySelector('input[name="new-when"]:checked');
    return on ? on.value : null;
}

/** The seven day checkboxes, in the order `whenBuild` made them. */
function whenDayBoxes() {
    return [...dom.newWhenDays.querySelectorAll('input')];
}

/**
 * `"14:30"` → `{hour: 14, minute: 30}`, and null for a box nobody filled in.
 *
 * A time input hands back `""` when it is empty or half-typed, which is a real
 * state the caller says out loud rather than defaulting to midnight — a schedule
 * silently set to 00:00 is the kind of thing you find out about at midnight.
 */
function whenClock(input) {
    const m = /^(\d{1,2}):(\d{2})$/.exec((input.value || '').trim());
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
}

/**
 * The picker as `{cron, once}`, or null after saying what is missing.
 *
 * Returns null and toasts rather than throwing — the same bargain
 * `newDialogValues` strikes, and for the same reason: every caller's next line
 * is "then stop".
 *
 * `quiet` is for the live preview, which composes on every keystroke and must
 * not shout about a row somebody is halfway through filling in. One composer
 * with a mute rather than two: the preview and the save have to agree about what
 * the controls mean, and that is exactly the kind of thing that drifts.
 */
function whenValues({ quiet = false } = {}) {
    const say = quiet ? () => {} : toast;
    const kind = whenKind();

    if (kind === 'custom') {
        const cron = dom.newCron.value.trim();
        if (!cron) {
            say('Say when it should run — five cron fields, like 0 2 * * 2-6.', 'warn');
            return null;
        }
        return { cron, once: false };
    }

    if (kind === 'every') {
        const n = Number(dom.newWhenCount.value);
        const hours = dom.newWhenUnit.value === 'hours';
        const max = hours ? 23 : 59;
        if (!Number.isInteger(n) || n < 1 || n > max) {
            say(`How often? A whole number of ${hours ? 'hours' : 'minutes'}, 1 to ${max}.`,
                'warn');
            return null;
        }
        return { cron: hours ? `0 */${n} * * *` : `*/${n} * * * *`, once: false };
    }

    if (kind === 'daily') {
        const t = whenClock(dom.newWhenDailyTime);
        if (!t) { say('Pick a time for it to run.', 'warn'); return null; }
        return { cron: `${t.minute} ${t.hour} * * *`, once: false };
    }

    if (kind === 'weekly') {
        const t = whenClock(dom.newWhenWeeklyTime);
        if (!t) { say('Pick a time for it to run.', 'warn'); return null; }
        const days = whenDayBoxes().filter(b => b.checked).map(b => Number(b.value));
        if (!days.length) {
            say('Tick at least one day, or make it a daily schedule.', 'warn');
            return null;
        }
        return { cron: `${t.minute} ${t.hour} * * ${days.join(',')}`, once: false };
    }

    if (kind === 'monthly') {
        const t = whenClock(dom.newWhenMonthlyTime);
        if (!t) { say('Pick a time for it to run.', 'warn'); return null; }
        return { cron: `${t.minute} ${t.hour} ${Number(dom.newWhenDom.value)} * *`, once: false };
    }

    if (kind === 'once') {
        const date = (dom.newWhenDate.value || '').trim();
        if (!date) { say('Pick the date it should run on.', 'warn'); return null; }
        const t = whenClock(dom.newWhenOnceTime);
        if (!t) { say('Pick a time for it to run.', 'warn'); return null; }
        const [y, mo, d] = date.split('-').map(Number);

        // **The one check the bridge cannot make.** `once` rides on a dated
        // expression, and a dated expression in the past still matches — next
        // year. So `scheduleFields` sees a perfectly good cron and the card would
        // sit there saying the next run is eleven months away. Refused here,
        // where the date somebody actually picked is still in front of us.
        if (new Date(y, mo - 1, d, t.hour, t.minute, 0, 0).getTime() <= Date.now()) {
            say('That moment has already passed — pick a date and time still to come.',
                'warn');
            return null;
        }
        return { cron: `${t.minute} ${t.hour} ${d} ${mo} *`, once: true };
    }

    say('Say when it should run.', 'warn');
    return null;
}

/**
 * Fill the picker in from a schedule, or from nothing.
 *
 * `form` is the bridge's `cronForm`; `cron` is the raw expression, needed for the
 * Custom row and as the fallback for a shape no row can draw.
 *
 * **Every control is written on every open, in both directions** — the rule
 * `openNew`'s docstring states, and it matters more here than anywhere else in
 * this dialog. A picker that left last time's ticked days behind would attach
 * them to the next schedule you opened, and Weekly is exactly the row where you
 * would not notice.
 */
function setWhen(form, cron, once, { newRow = 'weekly' } = {}) {
    const f = form || {};
    // `null` is "a schedule that does not exist yet", which is *not* the same as
    // `{kind: 'custom'}` — an existing schedule whose expression no row can draw.
    // The first opens on a suggestion, the second on its own raw expression, and
    // conflating them opened every new schedule on an empty cron box.
    const kind = form ? form.kind : 'new';

    // A dated expression is the One time row only when the row said so. Without
    // the flag it is an annual schedule, which no row draws — so it is Custom.
    //
    // `newRow` is which suggestion a *new* schedule opens on, and it is an
    // argument rather than a caller-supplied `cronForm` on purpose: a synthetic
    // `{kind: 'date'}` would reach the date maths below with no month and no day
    // and put `NaN-NaN-NaN` in the box.
    const row = kind === 'new' ? newRow
        : kind === 'date' ? (once ? 'once' : 'custom')
            : (kind === 'minutes' || kind === 'hours' ? 'every' : kind);

    const clock = f.hour === undefined ? '02:00' : `${pad(f.hour)}:${pad(f.minute)}`;

    dom.newCron.value = row === 'custom' ? (cron || '') : '';
    dom.newWhenCount.value = String(kind === 'minutes' || kind === 'hours' ? f.every : 15);
    dom.newWhenUnit.value = kind === 'hours' ? 'hours' : 'minutes';
    dom.newWhenDailyTime.value = clock;
    dom.newWhenWeeklyTime.value = clock;
    dom.newWhenMonthlyTime.value = clock;
    // The One time row's two controls are written together in the block below,
    // which has to decide a date and a time as one moment. This only leaves the
    // row something sane for the case where it is not the one selected.
    dom.newWhenOnceTime.value = '09:00';
    dom.newWhenDom.value = String(kind === 'monthly' ? f.day : 1);

    // Tue–Sat is the default week, which is what the cron box used to open on:
    // "review whatever landed overnight", on the days there was an overnight.
    const days = new Set(kind === 'weekly' ? f.days : [2, 3, 4, 5, 6]);
    for (const box of whenDayBoxes()) box.checked = days.has(Number(box.value));

    if (row === 'once' && kind === 'new') {
        // A suggestion, the way Weekly opens on Tue–Sat at 02:00, because the one
        // row that needs a *date* is the one row that says nothing at all until
        // it has one — a blank box means the preview underneath reads "fill in
        // the row you picked" and the first press of Save is a refusal.
        //
        // The next 09:00 still to come: this morning if it has not gone, else
        // tomorrow. Which also clears whenValues' one local check — a moment
        // already past is refused there, and offering one would be offering a
        // form that cannot be saved as it stands.
        const soon = new Date();
        soon.setHours(9, 0, 0, 0);
        if (soon.getTime() <= Date.now()) soon.setDate(soon.getDate() + 1);
        dom.newWhenOnceTime.value = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
        dom.newWhenDate.value =
            `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
    } else if (row === 'once') {
        // A dated expression carries no year, so an existing one-time schedule
        // can only be shown on the next date it matches — which is the date it
        // will actually run, and so the honest thing to put in the box.
        dom.newWhenOnceTime.value = clock;
        const now = new Date();
        const soon = new Date(now.getFullYear(), f.month - 1, f.day, f.hour, f.minute, 0, 0);
        if (soon.getTime() <= Date.now()) soon.setFullYear(now.getFullYear() + 1);
        dom.newWhenDate.value =
            `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
    } else {
        dom.newWhenDate.value = '';
    }

    const pick = document.getElementById(`new-when-${row}`);
    if (pick) pick.checked = true;
}

/** `1` → `"1st"`. The bridge says this too; here it is only ever a label. */
function ordinalDay(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Build the two lists too long to write out, and wire the picker. Called once.
 *
 * The day pills and the 1–31 select are generated because thirty-eight
 * hand-written controls in index.html is thirty-eight chances for a typo in a
 * value nobody would ever look at again.
 */
function whenBuild() {
    dom.newWhenDays.replaceChildren(...WHEN_DAYS.map((name, i) =>
        el('label', { class: 'when-day' },
            el('input', { type: 'checkbox', value: String(i), 'aria-label': name }),
            el('span', {}, name))));

    dom.newWhenDom.replaceChildren(...Array.from({ length: 31 }, (_, i) =>
        el('option', { value: String(i + 1) }, ordinalDay(i + 1))));

    // Touching a row's arguments selects that row. Without this you could set a
    // time on Weekly, press Save, and have Daily's time be what got stored — every
    // control filled in and only the radio saying which one counted.
    // `renderQuestionDock`'s "Other" box does the same, for the same reason.
    for (const opt of dom.newCronRow.querySelectorAll('.when-opt')) {
        const radio = opt.querySelector('input[type="radio"]');
        for (const arg of opt.querySelectorAll('.when-args input, .when-args select')) {
            arg.addEventListener('input', () => { radio.checked = true; describeCronSoon(); });
        }
        radio.addEventListener('change', () => describeCronSoon());
    }
    // The day ticks live outside `.when-args`, so they are wired separately —
    // and a day is only ever meaningful on Weekly, which is the row they are in.
    for (const box of whenDayBoxes()) {
        box.addEventListener('change', () => {
            document.getElementById('new-when-weekly').checked = true;
            describeCronSoon();
        });
    }
}

/**
 * What the dialog's footer may do while files are held.
 *
 * Save as draft is disabled rather than quietly dropping them. Both buttons are on
 * screen at once in start mode, a draft cannot carry a file, and a Save that
 * discarded a screenshot without saying so is the one outcome here worth refusing
 * outright. Start is unaffected: it is the button that can honour them.
 */
function paintNewAttach() {
    const held = newC.attach.length;
    // Both of the buttons that would keep this call rather than run it, because
    // neither store carries attachments — see docs/api.md. Saying so on the
    // button is the whole point: the files are bytes in this page and would
    // simply not be there afterwards, with nothing to say they had gone.
    dom.newSave.disabled = held > 0;
    dom.newSched.disabled = held > 0;
    dom.newSave.title = held
        ? 'A draft cannot carry attachments. Start the session, or remove the files.'
        : '';
    dom.newSched.title = held
        ? 'A schedule cannot carry attachments. Start the session, or remove the files.'
        : '';
}

/**
 * Show only the fields the chosen gate needs.
 *
 * A branch gate wants a ref and a PR gate does not — it watches whatever the
 * checkout's origin has open — so a single always-visible ref box would be a
 * field that silently means nothing half the time.
 */
function paintGateFields() {
    const kind = dom.newGateKind.value;
    dom.newGateRefRow.hidden = kind !== 'git-commits';
    dom.newPrRow.hidden = kind !== 'open-prs';
    dom.newGateNote.textContent = kind === 'open-prs'
        ? 'One review session per open pull request that has not been reviewed at '
            + 'its current commit.'
        : (kind === 'git-commits'
            ? 'One session per run, and only when the ref below has moved.'
            : 'A gated run that finds nothing new starts no session at all.');
}

/**
 * The two extra fields, on top of what every caller of this dialog needs.
 *
 * Separate from `newDialogValues` rather than folded into it, because the shared
 * function is shared with Start and Save-as-draft: a `cron` key riding along on a
 * `POST /api/sessions` body would be silently ignored today and would be a
 * puzzle the first time somebody added a field by that name.
 *
 * The expression is composed from the picker and never parsed here. The bridge's
 * parser is the one that will actually decide when this runs, so a second parser
 * in the page could only ever be a way for the two to disagree. What the page
 * does is ask for the English, which is `describeCronSoon` below.
 */
function schedDialogValues() {
    const body = newDialogValues();
    if (!body) return null;
    body.title = newDialogName();

    const when = whenValues();
    if (!when) return null;
    body.cron = when.cron;
    body.once = when.once;

    const kind = dom.newGateKind.value;
    if (kind === 'open-prs') {
        body.gate = {
            kind: 'open-prs',
            includeDrafts: dom.newPrDrafts.checked,
            post: dom.newPrPost.checked,
        };
    } else if (kind === 'git-commits') {
        const ref = dom.newGateRef.value.trim();
        if (!ref) {
            toast('Name the ref to watch, or choose "every time".', 'warn');
            return null;
        }
        body.gate = { kind: 'git-commits', ref, fetch: true };
    } else {
        // No gate is a real choice rather than an unfinished one.
        body.gate = null;
    }
    return body;
}

/**
 * Show what the expression means, as typed.
 *
 * Asked of the bridge rather than worked out here, for the reason above: the
 * process that will run the schedule is the one that should say when it runs. A
 * `POST` that only wants an opinion would be the wrong verb, so this leans on the
 * validator already in the create route — the dry-run flag exists so this can ask
 * without saving.
 *
 * Debounced because it fires per keystroke, and silent on failure: a half-typed
 * expression is not an error to report, it is an expression that is not finished.
 */
let cronNoteTimer = null;
function describeCronSoon() {
    clearTimeout(cronNoteTimer);
    cronNoteTimer = setTimeout(async () => {
        // Composed exactly the way a save composes it, so the sentence is about
        // the expression that would actually be stored rather than about the
        // controls' best guess at one.
        const when = whenValues({ quiet: true });
        if (!when) {
            dom.newCronNote.textContent = whenKind() === 'custom'
                ? 'Five fields, local time: minute hour day-of-month month day-of-week.'
                : 'Fill in the row you picked and this will say when it runs.';
            dom.newCronNote.classList.remove('bad');
            return;
        }
        try {
            const q = `cron=${encodeURIComponent(when.cron)}${when.once ? '&once=1' : ''}`;
            const r = await get(`/api/schedules/describe?${q}`);
            dom.newCronNote.textContent = r.next
                ? `${r.text} — next ${new Date(r.next).toLocaleString()}`
                : r.text;
            dom.newCronNote.classList.remove('bad');
        } catch (err) {
            dom.newCronNote.textContent = err.message;
            dom.newCronNote.classList.add('bad');
        }
    }, 250);
}

/**
 * Save the schedule.
 *
 * `drSave` for the other store, and a PATCH when the dialog was opened on an
 * existing row so editing one twice does not leave two.
 */
async function schedSave() {
    const body = schedDialogValues();
    if (!body) return;

    const editing = state.sched.editing;
    // The bridge is what consumes the draft, in one call, after the row is
    // written — see POST /api/schedules. Doing it here as a second call would
    // mean this window deciding what happens when the delete fails and the
    // Android client deciding it again, which is the argument
    // POST /api/drafts/:id/start already settled. Only on a create: converting a
    // draft happens once, so an edit never carries it.
    if (!editing && state.sched.fromDraft) body.fromDraft = state.sched.fromDraft;

    const label = dom.newSchedSave.textContent;
    dom.newSchedSave.disabled = true;
    dom.newSchedSave.textContent = 'Saving';
    try {
        if (editing) await patch(`/api/schedules/${editing}`, body);
        else await post('/api/schedules', body);
        closeNew();
        toast(editing ? 'Schedule saved.' : 'Scheduled.', 'ok');
        // Straight to the panel after making a new one, so the thing you just
        // set up is in front of you with its next run on it — the one fact you
        // want to check and cannot see from the dialog.
        if (!editing) showSched(true);
    } catch (err) {
        toast(`Could not save the schedule: ${err.message}`, 'error');
        dom.newSchedSave.textContent = label;
    } finally {
        dom.newSchedSave.disabled = false;
    }
}

/**
 * Hand what is in the dialog to the clock instead.
 *
 * Not a fourth form. A schedule is the same create call a draft is, plus a
 * trigger — so this reopens *this* dialog in schedule mode with the fields
 * carried across, and the two extra rows appear underneath. `openNew` is asked
 * for it rather than the dialog being half-rewritten in place, so there is one
 * path in and no second state for it to drift into.
 *
 * It reads the boxes rather than the stored draft, so edits you have not saved
 * come across too — which is the behaviour you want from a button sitting beside
 * Save changes.
 *
 * **Three presets, and they are presets rather than inheritance.** One time,
 * because a draft is a thing you meant to do once and the clock is only standing
 * in for the Start you would have pressed. `dontAsk`, because a session that
 * stops at the first question at 2 AM has wasted the night — this overrides
 * whatever the draft had, deliberately, since the draft's mode was chosen for a
 * run you would be watching. And 09:00 tomorrow, so the row is answerable rather
 * than blank. All three are still controls; none of them is a decision taken
 * away from you.
 */
function drToSchedule() {
    // The same validation Start and Save-as-draft get, and for the same reason:
    // a schedule you cannot run is worse than a refused save, because nobody is
    // there to read the failure.
    const body = newDialogValues();
    if (!body) return;

    openNew({
        schedule: true,
        seed: {
            cwd: body.cwd,
            prompt: body.prompt,
            title: newDialogName(),
            model: body.model,
            test: body.test,
            permissionMode: 'dontAsk',
            // Null from a plain Start-a-session dialog, where there is nothing to
            // consume. The save is what acts on it; see schedSave.
            fromDraft: state.drafts.editing,
        },
    });
}

/**
 * Keep it instead of running it.
 *
 * The same body Start would have sent, to the drafts route rather than the
 * sessions one — which is the whole idea, and why this is a button on that dialog
 * rather than a form of its own. A PATCH when the dialog was opened on an
 * existing draft, so editing one twice does not leave two.
 *
 * The label is not restored on success: `closeNew` has already hidden the dialog,
 * and the next `openNew` sets both the title and this button for whichever of the
 * two things it is about to be.
 */
async function drSave() {
    const body = newDialogValues();
    if (!body) return;
    body.title = newDialogName();

    const editing = state.drafts.editing;
    const label = dom.newSave.textContent;
    dom.newSave.disabled = true;
    dom.newSave.textContent = 'Saving';
    try {
        if (editing) await patch(`/api/drafts/${editing}`, body);
        else await post('/api/drafts', body);
        closeNew();
        toast(editing ? 'Draft saved.' : 'Saved as a draft.', 'ok');
    } catch (err) {
        toast(`Could not save the draft: ${err.message}`, 'error');
        dom.newSave.textContent = label;
    } finally {
        dom.newSave.disabled = false;
    }
}

/**
 * Run it.
 *
 * **If the dialog was opened on a draft, this consumes it** — the same press the
 * card's Start button is, so it has to leave the board the same way. The id goes
 * to the bridge as `fromDraft` and the delete happens there, after the session
 * spawns: the reasoning `drStart` and `schedSave` both give, which is that as two
 * calls from here, every client has to decide separately what a failed delete
 * means once a process is already running.
 *
 * What the dialog holds is what starts, and it is *not* written back to the draft
 * first. Editing the prompt and pressing Start runs the edit and drops the draft
 * unedited — Start is a decision not to keep it. Save changes is next to it for
 * the other answer.
 */
async function startNew() {
    const body = newDialogValues();
    if (!body) return;
    // Read before the post, because `closeNew` clears it and the panel close
    // below happens after. Null on every other way in: `openNew` writes this on
    // each open and `closeNew` clears it, so Ctrl+N and a Recent-directory open
    // carry nothing stale from the last draft you looked at. A snippet's
    // auto-submit *inside* an open draft does consume it, which is right — that
    // path presses this button.
    //
    // Set here rather than in `newDialogValues`, whose body is also `drSave`'s
    // and `schedSave`'s: a draft PATCHed with a key naming itself would be noise
    // on a route that ignores it.
    const fromDraft = state.drafts.editing;
    if (fromDraft) body.fromDraft = fromDraft;

    dom.newGo.disabled = true;
    dom.newGo.textContent = 'Starting';
    try {
        // Now, and not when they were pasted: this is the first moment the working
        // directory has stopped being editable, and it is what decides where they go.
        // A failure here stops the whole thing — see commitAttachments.
        if (newC.attach.length) {
            const files = await commitAttachments(newC);
            if (!files) return;
            body.attachments = files;
        }
        const r = await post('/api/sessions', body);
        closeNew();
        // Only when a draft was consumed, and the same move `drStart` makes: the
        // board has one fewer card and we are about to open a session behind it,
        // so leaving it up would put a list over the thing it just started. A
        // plain Ctrl+N from an open board is not that, and leaves it alone.
        if (fromDraft && draftsVisible()) showDrafts(false);
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

// The rail's other filter. `renderRail` repaints the button itself, because it is
// the thing that knows how many sessions the answer covers.
dom.hideDone.addEventListener('click', () => {
    state.hideDone = !state.hideDone;
    try { localStorage.setItem('railHideDone', state.hideDone ? '1' : '0'); }
    catch { /* private mode */ }
    renderRail();
});

// Find in conversation. The index and the count run on the debounce so the
// number keeps up with typing; the marks are painted on the frame after it.
dom.findInput.addEventListener('input', debounce(() => {
    // Not trimmed: a query with a space at either end is a query, and the
    // browser's own find does not second-guess it either.
    const q = dom.findInput.value.toLowerCase();
    if (q === state.find.q) return;
    state.find.q = q;
    state.find.at = -1;
    flushFind();
    if (state.find.hits.length) gotoHit(hitFromHere());
}, 130));

dom.findInput.addEventListener('keydown', (e) => {
    // Enter is handled here rather than in the central ladder, which has no Enter
    // clause — the composer's Enter-to-send sits behind a check that the target
    // is the composer, so nothing else wants it. Escape is deliberately *not*
    // handled here: the ladder already puts find above the subagent pane, and
    // answering it twice closed find and then the pane underneath it.
    if (e.key !== 'Enter') return;
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
});

dom.findNext.addEventListener('click', () => { stepFind(1); dom.findInput.focus(); });
dom.findPrev.addEventListener('click', () => { stepFind(-1); dom.findInput.focus(); });
dom.findClose.addEventListener('click', () => closeFind({ focus: true }));

dom.findSubs.addEventListener('change', () => {
    state.find.subagents = dom.findSubs.checked;
    state.find.at = -1;
    syncFindSubs();
    if (state.find.subagents) loadFindSubs();
    else flushFind();
    dom.findInput.focus();
});

// Opening or closing anything foldable moves rows about, and a range inside a
// row that moved is collapsed rather than wrong — so it repaints nothing and
// says nothing. `toggle` does not bubble, hence the capture phase; one listener
// per pane then covers both a tool block and the fold a run of them lives in.
for (const log of [dom.log, dom.agentLog]) {
    log.addEventListener('toggle', markFindDirty, true);
}

dom.btnSend.addEventListener('click', () => sendMessage());

// Paste, drop and the paperclip are wired where the composers are built, beside
// wireComposer — `live` is declared down there and cannot be touched from here.
// A file dropped anywhere else in the window would otherwise navigate away to it,
// which loses the conversation and every draft on screen. Gated exactly like the
// composer's own handlers, so a queue chip being dragged is still none of our
// business here.
for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (e) => {
        if (state.queueDrag) return;
        if (!dragHasFiles(e.dataTransfer)) return;
        if (dom.composer.contains(e.target)) return;   // handled above
        e.preventDefault();
    });
}
// One click, and no confirmation over the top of it: the click *is* the approval,
// and the session still asks for whatever its permission mode makes it ask for
// before anything is pushed or merged.
dom.btnSnippets.addEventListener('click', (e) => {
    e.stopPropagation();
    showSnips(live, dom.snipMenu.hidden);
});
dom.newBtnSnippets.addEventListener('click', (e) => {
    e.stopPropagation();
    showSnips(newC, dom.newSnipMenu.hidden);
});
dom.snipMenu.addEventListener('keydown', (e) => onSnipsKey(e, live));
dom.newSnipMenu.addEventListener('keydown', (e) => onSnipsKey(e, newC));

// Send later. Same gesture as the snippets button next to it, and the same
// stopPropagation, so the click-outside rule below does not close what it opened.
dom.btnLater.addEventListener('click', (e) => {
    e.stopPropagation();
    showLater(dom.laterMenu.hidden);
});
// A click inside the popover is not a click outside it. Needed because the fields
// at the foot of it are things you interact with for a while — picking a date,
// changing the mode — rather than one press that closes the menu anyway.
dom.laterMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeLater());
// Repositioned rather than closed: the popover is anchored to a button that moves
// when the composer grows, and closing on a resize would lose a half-typed time.
window.addEventListener('resize', () => { if (!dom.laterMenu.hidden) positionLater(); });

// ✕, Cancel and a whole click outside, on both — no Escape; see modalUp().
for (const n of dom.snipFillScrim.querySelectorAll('[data-close-fill]')) {
    n.addEventListener('click', closeSnipFill);
}
closeOnClickOutside(dom.snipFillScrim, closeSnipFill);
dom.snipFillGo.addEventListener('click', confirmSnipFill);
// Enter in a one-line box confirms. There is no textarea parameter type, so
// nothing in this form wants the key for itself.
dom.snipFillForm.addEventListener('submit', (e) => { e.preventDefault(); confirmSnipFill(); });

// The glyph goes in from script rather than being written into the markup,
// because every other icon in this app comes out of the ICON map.
dom.btnSnippets.append(icon('snippets', 17));

for (const n of dom.snipEditScrim.querySelectorAll('[data-close-snip]')) {
    n.addEventListener('click', closeSnipEditor);
}
closeOnClickOutside(dom.snipEditScrim, closeSnipEditor);
dom.snipSave.addEventListener('click', saveSnipEditor);
dom.snipAuto.addEventListener('change', paintSnipPerm);
dom.snipBody.addEventListener('input', paintSnipPlaceholders);
dom.snipParamAdd.addEventListener('click', () => {
    snipDraftParams.push({ name: '', label: '', type: 'text', required: false, default: '' });
    renderSnipParamRows();
    paintSnipPlaceholders();
    const last = dom.snipParams.querySelector('.snip-param:last-child .snip-param-name');
    if (last) last.focus();
});
dom.snipProjectGo.addEventListener('click', addSnipProject);
dom.snipProject.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addSnipProject();
});
dom.snipNew.addEventListener('click', () => openSnipEditor(null));
dom.snipGroupNew.addEventListener('click', newSnipGroup);
// Wrapped, not passed: openNew now takes an options bag, and a MouseEvent is
// not one.
dom.tasksCollapse.addEventListener('click', () => showTasks(false));
dom.tasksStrip.addEventListener('click', () => showTasks(true));

dom.changesCollapse.addEventListener('click', () => collapseChanges(true));
dom.changesStrip.addEventListener('click', () => collapseChanges(false));
dom.checklistCollapse.addEventListener('click', () => collapseChecklist(true));
dom.checklistStrip.addEventListener('click', () => collapseChecklist(false));
// Refresh means "ask git again about this directory", and only this one — the
// work-in-flight board's answers for forty other worktrees are not stale
// because you clicked here. See git.clearCache.
dom.changesRefresh.addEventListener('click', () => loadChanges({ refresh: true }));

// ✕, Cancel and a whole click outside — no Escape; see modalUp().
for (const n of dom.taskScrim.querySelectorAll('[data-close-task]')) {
    n.addEventListener('click', closeTaskDialog);
}
closeOnClickOutside(dom.taskScrim, closeTaskDialog);

// The full-height CLAUDE.md editor. Wired once, here, because the markup is in
// web/index.html rather than built by a render — see the "same file, full
// height" section above.
//
// The ✕, Close and a whole click outside are the ways out, and Escape is
// swallowed rather than answered: that is the rule modalUp() holds for every
// dialog on this page, and this one is the clearest case for it — what it holds
// is a whole CLAUDE.md somebody is part-way through writing.
for (const n of dom.memoScrim.querySelectorAll('[data-close-memo]')) {
    n.addEventListener('click', closeMemoDialog);
}
closeOnClickOutside(dom.memoScrim, closeMemoDialog);
dom.memoClose.addEventListener('click', closeMemoDialog);
dom.memoBig.addEventListener('input', () => {
    const s = state.claudeDocs;
    const row = docsRow();
    s.draft = dom.memoBig.value;
    s.dirty = s.draft !== (row && row.text !== null ? row.text : '');
    paintMemoDialog();
});
dom.memoSave.addEventListener('click', () => saveClaudeDocs());
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

dom.btnChanges.addEventListener('click', () => {
    if (state.current) showChanges(!state.changes.on);
});

dom.btnChecklist.addEventListener('click', () => {
    if (state.current) showChecklist(!state.checklist.on);
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
dom.termPreview.addEventListener('click', () => {
    const run = state.runs.get(state.termTab);
    if (!run) return;
    if (runPreviewable(run)) { openRunPreview(run); return; }
    state.previewWhenUp = run.id;
    paintRunHead();
});
dom.termGrip.addEventListener('pointerdown', startTermDrag);
// Keyboard equivalent of the drag, so the pane is not mouse-only.
dom.termGrip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 60 : 20;
    if (e.key === 'ArrowUp') { e.preventDefault(); setTermHeight(dom.termPane.offsetHeight + step); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setTermHeight(dom.termPane.offsetHeight - step); }
});

dom.newGo.addEventListener('click', startNew);
dom.newSave.addEventListener('click', drSave);
dom.newSched.addEventListener('click', drToSchedule);
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

// And the model, which until Ctrl+M existed was remembered against nothing at
// all — see paintModel.
dom.model.addEventListener('change', () => {
    if (state.current) state.modelChoice.set(state.current.sessionId, dom.model.value);
});

dom.input.addEventListener('input', autoGrow);
dom.input.addEventListener('input', debounce(() => {
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
}, 400));
// A reload or a crash should not eat a half-written message either.
window.addEventListener('beforeunload', () => {
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
});
/**
 * Does this Enter send, or break the line?
 *
 * `keyboard.composerSend` picks between two shapes. `'enter'` is the chat
 * convention and what this app has always done: Enter sends, Shift+Enter is a
 * newline. `'ctrl-enter'` swaps them, which is what you want when a message is
 * three paragraphs and Enter sending it halfway through is a real cost.
 *
 * Ctrl/Cmd+Enter sends in both. It used to be the only way and fingers
 * remember, and it is unambiguous under either mode.
 *
 * Alt+Enter is a newline throughout, and `isComposing` keeps an IME's Enter for
 * the IME — it is picking a candidate, not finishing a message.
 */
function enterSends(e) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return false;
    if (e.altKey) return false;
    if (e.ctrlKey || e.metaKey) return true;
    if (e.shiftKey) return false;
    return BOOT_PREFS.keyboard.composerSend !== 'ctrl-enter';
}

dom.input.addEventListener('keydown', (e) => {
    if (!enterSends(e)) return;
    e.preventDefault();
    sendMessage();
});

/** The strip under the composer, which says whichever mode is in force. */
export function paintComposerHint() {
    dom.composerHint.textContent = BOOT_PREFS.keyboard.composerSend === 'ctrl-enter'
        ? 'Ctrl+Enter to send · Enter for a newline'
        : 'Enter to send · Shift+Enter for a newline';
}

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

// Two popovers hang off each composer — `/` commands and `@` mentions — and they
// share everything except what opens them and what accepting one inserts. So the
// selection, the paging and the keyboard map below take a menu rather than
// reaching for one: `node` is the element it draws into, `id` prefixes its rows'
// DOM ids so aria-activedescendant can name one unambiguously, and `row` is what
// one of its rows looks like — which is a thing a menu knows about itself.
//
// **There are two composers now.** The one under a live conversation, and the
// first-message box in the Start-a-session dialog. What differs between them is
// *data* — where the working directory comes from, what else on screen has to be
// shut on the way up, whether Home and End belong to the menu — so this is a
// descriptor and deliberately not a closure over the functions below.
//
// A closure was the obvious shape and it is worse here. It would re-indent five
// hundred lines of comment-dense code into a diff where nothing is unchanged, in
// a file whose reviewable substance *is* those comments; it would make two copies
// of every function object, which quietly undoes the "one implementation" these
// comments keep claiming; and the callers outside this section would have to say
// `live.closeMenus()`, a factory-of-methods pattern that appears nowhere else in
// this file. So: data here, and every function below takes the composer it is
// acting on.
function makeComposer({ input, slashNode, mentionNode, id, ctx, container,
    closeOthers = () => {}, notReady = null, homeEnd = true, float = false,
    onInput = null,
    // The snippets popover and the button it hangs off. A third menu on the same
    // composer, which is what earns it the click-outside rule and the reposition
    // pass for nothing — but deliberately *not* a member of closeMenus(), because
    // that is what the textarea's blur calls and this popover takes focus.
    snipBtn = null, snipNode = null,
    // Attachments. A composer with no `attachNode` takes no files at all, and
    // wireAttachments simply skips it — nothing else has to know.
    attachNode = null, attachInput = null, attachBtn = null, dropZone = null,
    uploadMode = 'eager', persistKey = null, afterRender = null,
    // This composer's own Permissions and Model selects, so Ctrl+P and Ctrl+M
    // reach the box the caret is in rather than always the live one — the same
    // reason `snipBtn` is a member. A composer with neither simply has no chord,
    // which is what the handler's null check is for.
    perm = null, model = null }) {
    const c = { input, container, ctx, closeOthers, notReady, homeEnd, onInput,
        attachNode, attachInput, attachBtn, dropZone, uploadMode, persistKey,
        afterRender, perm, model,
        // Staged files, and the counter their keys come from. Per composer, because
        // a screenshot pasted into one box has nothing to do with the other.
        attach: [], attachSeq: 0 };
    c.slash = { rows: [], index: 0, seq: 0, node: slashNode,
        id: `${id}-slash`, row: slashRow, float, c };
    c.mention = { rows: [], index: 0, seq: 0, node: mentionNode,
        id: `${id}-mention`, row: mentionRow, float, c };
    // `caret` is where the selection was when the popover opened, which is what
    // `insert: 'cursor'` lands on — by the time the text arrives the focus has
    // moved at least once. See showSnips.
    c.snips = { node: snipNode, btn: snipBtn, id: `${id}-snips`, index: 0, caret: null, c };
    return c;
}

const menuOpen = (m) => !m.node.hidden;

/** The other popover on the same composer. */
const otherMenu = (m) => (m === m.c.slash ? m.c.mention : m.c.slash);

/**
 * Whichever of this composer's popovers is up, or null.
 *
 * Only ever one of the two — each closes the other on the way open. Per composer
 * rather than global: two composers can each have a menu up, which is what the
 * single `openMenu()` this replaces could not express.
 */
function openMenuOf(c) {
    if (menuOpen(c.slash)) return c.slash;
    if (menuOpen(c.mention)) return c.mention;
    return null;
}

// The composer under a live conversation. The dialog's is built beside the
// dialog's own wiring, further down.
export const live = makeComposer({
    input: dom.input,
    slashNode: dom.slashMenu,
    mentionNode: dom.mentionMenu,
    id: 'live',
    container: '.input-row',
    snipBtn: dom.btnSnippets,
    snipNode: dom.snipMenu,
    // Addressed by session id, and the cwd rides along only as a cache key: the
    // bridge is what resolves a session to a working directory, through a
    // worktree that has since been landed and removed. A client cannot, having no
    // way to ask whether a path still exists.
    ctx: () => (state.current
        ? { cwd: state.current.cwd, sessionId: state.current.sessionId }
        : null),
    // Main-window furniture that would otherwise sit over the popover. A
    // composer inside a modal has none of it, and passes nothing.
    closeOthers: () => { showQuota(false); showNewMenu(false); showBarMore(false); },

    // Attachments. The strip is above the input row and the drop zone is the whole
    // composer, so a file can be let go anywhere near the box rather than exactly on
    // it. Uploaded on arrival, because a live composer already knows the checkout its
    // files belong in.
    attachNode: dom.attach,
    attachInput: dom.attachInput,
    attachBtn: dom.btnAttach,
    dropZone: dom.composer,
    uploadMode: 'eager',
    // Which localStorage key its chips belong under, or null while no session is on
    // screen. Only the eager composer has one: a held file is bytes in this page, and
    // there is no path to write down.
    persistKey: () => state.current && state.current.sessionId,
    afterRender: () => enableSend(Boolean(state.current)),
    perm: dom.perm,
    model: dom.model,
});

// Filled by wireComposer below, live first. The keyboard map and the
// click-outside rule both walk this, so a composer that is not in it is a box
// whose popovers no key and no click can reach.
const composers = [];

/** The typed fragment after the slash, or null when this is not a command. */
function slashFragment(c) {
    const v = c.input.value;
    return SLASH_RE.test(v) ? v.slice(1) : null;
}

/**
 * Cached per working directory, because that is what decides the answer — every
 * session in a checkout shares a list, so one session's fetch warms the rest.
 */
async function loadSlashCommands(c) {
    const at = c.ctx();
    if (!at) return [];
    const key = at.cwd || at.sessionId;
    const hit = state.slashCommands.get(key);
    if (hit) return hit.commands;

    // By session where there is one and by path where there is not. The bridge
    // answers both, and says in its own comment that the second form exists for
    // exactly this caller — a dialog that has not started a session yet knows
    // only a path. Encoded because that path is typed by hand: a space, a `#` or
    // an `&` in it would otherwise reach the bridge truncated.
    const q = at.sessionId
        ? `session=${encodeURIComponent(at.sessionId)}`
        : `cwd=${encodeURIComponent(at.cwd)}`;
    const r = await get(`/api/slash-commands?${q}`);
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

/**
 * Hide one popover and forget what was highlighted in it.
 *
 * The combobox state is only given up when the *other* popover on the same
 * composer is not the one using it. That clause arrived with the mention menu and
 * belongs to both: `aria-expanded` describes the box, not the list. Closing the
 * slash menu used to clear it unconditionally, which would have lied the moment
 * both were somehow up — unreachable, and now unreachable by construction.
 */
function closeMenu(m) {
    if (m.node.hidden) return;
    m.node.hidden = true;
    m.node.replaceChildren();
    if (otherMenu(m).node.hidden) {
        m.c.input.setAttribute('aria-expanded', 'false');
        m.c.input.removeAttribute('aria-activedescendant');
    }
    m.rows = [];
    m.index = 0;
}

/** Both of one composer's popovers — what a blur or a session switch wants. */
export const closeMenus = (c) => { closeMenu(c.slash); closeMenu(c.mention); };

/** Re-read the composer and show, filter or hide the menu to match. */
async function updateSlashMenu(c) {
    const frag = slashFragment(c);
    if (frag === null) return closeMenu(c.slash);

    // No working directory to ask about yet. Only the dialog can be in this
    // state — a live composer with no session is not on screen — and it says so
    // rather than showing nothing, because a `/` that quietly does nothing reads
    // as a feature that is broken rather than as a field you have not filled in.
    const at = c.ctx();
    if (!at) {
        if (!c.notReady) return closeMenu(c.slash);
        return drawMenu(c.slash, null, c.notReady);
    }

    const seq = ++c.slash.seq;
    const key = at.cwd || at.sessionId;
    let items = state.slashCommands.has(key) ? state.slashCommands.get(key).commands : null;

    if (!items) {
        // First `/` in this directory. Show the box rather than nothing, so a
        // slow bridge reads as loading instead of as no commands.
        drawMenu(c.slash, null, 'Loading commands…');
        try {
            items = await loadSlashCommands(c);
        } catch {
            // Not a toast: the person pressed a key, they did not ask for this.
            if (seq === c.slash.seq) drawMenu(c.slash, null, 'Could not load commands.');
            return;
        }
        // Typed on, or moved away, while that was in flight.
        if (seq !== c.slash.seq) return;
        if (slashFragment(c) === null) return closeMenu(c.slash);
    }

    const rows = matchSlashCommands(items, slashFragment(c) || '');
    // Nothing matches, so there is nothing to choose: get out of the way
    // entirely rather than showing an empty box that also swallows Enter.
    if (!rows.length) return closeMenu(c.slash);

    c.slash.rows = rows;
    c.slash.index = 0;
    drawMenu(c.slash, rows, null);
}

/** One command. */
function slashRow(m, cmd, i) {
    return el('button', {
        class: 'picker-row', type: 'button', role: 'option',
        id: `${m.id}-row-${i}`, tabindex: -1,
        'aria-selected': String(i === m.index),
        // Keeps the caret in the textarea, so clicking a row neither blurs
        // the box nor fires the blur-to-close below.
        onmousedown: (e) => e.preventDefault(),
        onclick: () => acceptSlashCommand(m, i),
    },
    el('span', { class: 'name' }, `/${cmd.name}`),
    cmd.description ? el('span', { class: 'desc' }, clip(cmd.description, 90)) : null,
    cmd.argumentHint ? el('span', { class: 'hint' }, clip(cmd.argumentHint, 24)) : null,
    );
}

/**
 * Draw a popover: a list of rows, or a note in place of one.
 *
 * One function for both menus. They differed in the row builder — which now rides
 * on the menu, where it belongs — and in the group headings, which the `r.group &&`
 * below makes optional rather than a second copy of this whole loop.
 */
function drawMenu(m, rows, note) {
    // Two popovers on screen at once is nobody's intention. Only on the way
    // open: this redraws on every keystroke, and the others are already shut.
    if (m.node.hidden) { m.c.closeOthers(); closeMenu(otherMenu(m)); }

    // A note is a message, not a list. Clearing the rows behind it matters:
    // otherwise Enter during "Loading…" would accept whatever the *previous*
    // fragment had highlighted, which is not what is on screen.
    if (note) { m.rows = []; m.index = 0; }

    const kids = [];
    let group = null;
    (rows || []).forEach((r, i) => {
        // A row with no group — every slash command — skips this entirely, which
        // is what lets one loop serve both menus. Not a `.picker-row`,
        // deliberately: the shared selection code counts those, so a heading that
        // were one would be a row you could land on and press Enter at.
        if (r.group && r.group !== group) {
            group = r.group;
            kids.push(el('div', { class: 'menu-group', role: 'presentation' }, group));
        }
        kids.push(m.row(m, r, i));
    });

    m.node.replaceChildren(...(note ? [el('div', { class: 'menu-note' }, note)] : kids));
    m.node.hidden = false;
    // After it is on screen and before the highlight is painted: paintSelection
    // scrolls a row into view, and it should be scrolling inside a box that has
    // already been given its height.
    if (m.float) positionMenu(m);
    m.c.input.setAttribute('aria-expanded', 'true');
    if (rows && rows.length) paintSelection(m);
    else m.c.input.removeAttribute('aria-activedescendant');
}

/**
 * Put a floating popover under the box it belongs to, or over it when there is
 * more room that way.
 *
 * Fixed rather than absolute, and this is the whole reason the `float` flag
 * exists: the dialog's box lives inside `.modal-body`, which scrolls, inside
 * `.modal`, which is `overflow: hidden`. An absolutely positioned popover is
 * clipped by both, and that field is the last one in the dialog — so it would be
 * cut almost entirely. Fixed positioning leaves every ancestor's overflow out of
 * it, at the price of having to be told where to go.
 *
 * Measured on every redraw because the anchor moves: the textarea is sized from
 * its contents, so it grows under the popover as you type. Same show-then-place
 * idiom as showTurnPop, and the same z-index.
 *
 * `--menu-max` is the room actually available rather than the flat 400px the
 * anchored menu uses, so a short window gets a short menu instead of one running
 * off the screen. The floor stops it collapsing to nothing when the box is almost
 * at the bottom — better to overhang a little than to show two rows.
 */
function positionMenu(m) {
    const r = m.c.input.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - r.bottom - gap * 2;
    const above = r.top - gap * 2;
    const up = below < 220 && above > below;

    m.node.classList.toggle('up', up);
    m.node.style.setProperty('--menu-max', `${Math.max(140, Math.min(400, up ? above : below))}px`);
    m.node.style.left = `${r.left}px`;
    m.node.style.width = `${r.width}px`;
    if (up) {
        m.node.style.top = 'auto';
        m.node.style.bottom = `${window.innerHeight - r.top + gap}px`;
    } else {
        m.node.style.bottom = 'auto';
        m.node.style.top = `${r.bottom + gap}px`;
    }
}

/**
 * Keep a floating popover attached to its box when the page moves under it.
 *
 * Reposition rather than close: the caret is still in the box and the list is
 * still the answer, so a menu that vanished because the modal scrolled a pixel
 * would be the wrong reading of what happened. Cheap — one rect read per open
 * menu, and there is at most one.
 */
function repositionFloatingMenus() {
    for (const c of composers) {
        for (const m of [c.slash, c.mention]) {
            if (m.float && !m.node.hidden) positionMenu(m);
        }
        // Always fixed, both composers, so it always needs replacing — see
        // positionSnips on why it does not share positionMenu.
        if (c.snips.node && !c.snips.node.hidden) positionSnips(c);
    }
}

window.addEventListener('resize', repositionFloatingMenus);

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
    menu.c.input.setAttribute('aria-activedescendant', on.id);
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
function acceptSlashCommand(m, i) {
    const cmd = m.rows[i == null ? m.index : i];
    if (!cmd) return;
    const box = m.c.input;
    closeMenu(m);
    box.value = `/${cmd.name} `;
    box.setSelectionRange(box.value.length, box.value.length);
    box.dispatchEvent(new Event('input'));
    box.focus();
}

/**
 * Keys, on the document in the capture phase.
 *
 * Deliberately not a second listener on the textarea: those run in registration
 * order, so "register ours first" would work today and break silently the day
 * somebody moves a block in this file. Capturing on an ancestor provably runs
 * before any listener on the target, so stopping propagation here reliably keeps
 * Enter-to-send from also firing.
 *
 * **The target decides which composer this is about, and only then do we ask
 * whether that composer has a popover open.** The other way round — one global
 * "is any menu up" — stopped being answerable the moment there were two
 * composers. It is also the check that keeps this off every other box with an
 * Enter or Escape map of its own: the queue chips, #new-cwd, the New-folder name,
 * the terminal.
 */
document.addEventListener('keydown', (e) => {
    const c = composers.find(x => x.input === e.target);
    if (!c) return;
    const menu = openMenuOf(c);
    if (!menu) return;
    if (e.isComposing || e.keyCode === 229) return;

    // Above the rows check, deliberately. Escape is the one key that means
    // something even when there is nothing to choose: a note is still something
    // on screen, and something on screen is what Escape dismisses. Left below
    // that check, an Escape during "Loading commands…" fell through to the
    // central ladder, which used to close the whole Start-a-session dialog and
    // the first message you had written; the ladder swallows the key over a
    // modal now, but this is still the handler that makes it mean "never mind
    // the list". Leaves the text exactly as typed.
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(menu);
        return;
    }

    // Open but with nothing to choose — a note, or a list still loading. Every
    // other key belongs to the composer then; swallowing Enter here would lose a
    // message to a box that had no answer for it.
    if (!menu.rows.length) return;

    const accept = () => (menu === c.slash ? acceptSlashCommand(menu) : acceptMention(menu));

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        moveSelection(menu, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        e.stopPropagation();
        const step = menuPageSize(menu);
        jumpSelection(menu, menu.index + (e.key === 'PageDown' ? step : -step));
    } else if (c.homeEnd && (e.key === 'Home' || e.key === 'End')) {
        // Only worth taking while the menu is open, and only because the box it
        // sits on is one line: Home and End in a one-line composer move the
        // caret somewhere it already effectively is. A composer whose box is
        // several lines tall keeps them for the caret — see `homeEnd`.
        e.preventDefault();
        e.stopPropagation();
        jumpSelection(menu, e.key === 'Home' ? 0 : menu.rows.length - 1);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.shiftKey && e.key === 'Tab') return;   // still a way out of the box
        e.preventDefault();
        e.stopPropagation();
        accept();
    }
}, true);

/**
 * One listener feeding both popovers, because both are derived from the text
 * rather than from a keystroke — see the note above SLASH_RE. Order matters only
 * in that a composer holding one slash-word is never also holding an `@`
 * fragment.
 *
 * `onInput` runs first where a composer has one. The dialog's box is sized from
 * its contents, and a popover positioned against it has to be placed after that
 * has happened rather than against the height it had a keystroke ago.
 */
function wireComposer(c) {
    c.input.addEventListener('input', () => {
        if (c.onInput) c.onInput();
        updateSlashMenu(c);
        updateMentionMenu(c);
    });
    c.input.addEventListener('blur', () => closeMenus(c));
    composers.push(c);
}

wireComposer(live);
wireAttachments(live);

// A click anywhere outside a composer's own row closes that composer's popovers,
// and only that composer's. Per composer rather than "everything not in
// .input-row": clicking a row of the dialog's menu is outside the live composer,
// and shutting the live one there is harmless, but shutting the dialog's would
// cancel the click that was choosing something.
document.addEventListener('click', (e) => {
    for (const c of composers) {
        if (e.target.closest(c.container)) continue;
        closeMenus(c);
        // Closed here rather than in closeMenus(), which the textarea's blur
        // calls: clicking the snippets button blurs the box, so a popover in that
        // set would shut on the click that opened it.
        closeSnips(c);
    }
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
function mentionFragment(c) {
    const caret = c.input.selectionStart;
    // Only with no selection: `@` with a range selected is somebody about to
    // overtype it, not somebody addressing a session.
    if (caret !== c.input.selectionEnd) return null;
    const before = c.input.value.slice(0, caret);
    const m = MENTION_RE.exec(before);
    if (!m) return null;
    // m[0] may open with the whitespace that made the `@` a word boundary, and
    // that character is not part of what gets replaced.
    const lead = m[0].startsWith('@') ? 0 : 1;
    return { text: m[1], start: caret - m[0].length + lead };
}

/** Peers, from memory when the answer is fresh enough to still be true. */
export async function loadPeers() {
    if (Date.now() - state.peers.at < PEERS_TTL_MS) return state.peers.list;
    const r = await get('/api/peers');
    state.peers.list = r.peers || [];
    state.peers.at = Date.now();
    return state.peers.list;
}

/** A peer by the name that is also its address, or null. */
export function peerByName(name) {
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
 * telling an agent to message itself is never the intention. A composer that is
 * not *in* a session — the Start-a-session dialog — drops nothing, and that is
 * right rather than merely harmless: a session open behind the modal is a
 * perfectly good thing for the one you are about to start to go and talk to.
 */
function matchPeers(c, peers, frag) {
    const q = frag.trim().toLowerCase();
    const mine = (c.ctx() || {}).sessionId;
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

/**
 * Re-read the composer and show, filter or hide the menu to match.
 *
 * No check for a session here, unlike the slash menu's check for a directory:
 * peers are a fact about the machine rather than about this composer, so every
 * composer offers the same names and one with nothing behind it still has an
 * answer.
 */
async function updateMentionMenu(c) {
    const frag = mentionFragment(c);
    if (frag === null) return closeMenu(c.mention);

    const seq = ++c.mention.seq;
    let peers = (Date.now() - state.peers.at < PEERS_TTL_MS) ? state.peers.list : null;

    if (!peers) {
        // Something on screen straight away, because the fetch is a round trip and
        // an `@` that does nothing for a moment reads as an `@` that does nothing.
        drawMenu(c.mention, null, 'Looking for sessions…');
        try {
            peers = await loadPeers();
        } catch {
            if (seq === c.mention.seq) drawMenu(c.mention, null, 'Could not list sessions.');
            return;
        }
        // Typed on, or moved away, while that was in flight.
        if (seq !== c.mention.seq) return;
        if (mentionFragment(c) === null) return closeMenu(c.mention);
    }

    const now = mentionFragment(c);
    if (!now) return closeMenu(c.mention);

    const rows = matchPeers(c, peers, now.text);
    if (!rows.length) {
        // A bare `@` with nothing to offer is worth saying, because the reason is
        // interesting — one session running is a normal state, and the silent
        // alternative is a menu that mysteriously never appears. A fragment that
        // matches nothing is just a typo, and gets out of the way.
        if (!now.text.trim()) return drawMenu(c.mention, null, 'No other sessions are running.');
        return closeMenu(c.mention);
    }

    c.mention.rows = rows;
    c.mention.index = 0;
    drawMenu(c.mention, rows, null);
}

/**
 * One session.
 *
 * The title leads and the name follows, because the title is what you are looking
 * for and the name is what gets inserted — showing both is what stops the box
 * filling with something you did not expect. A session with no transcript indexed
 * here has no title, and shows its name alone rather than an empty row.
 */
function mentionRow(m, r, i) {
    const p = r.peer;
    return el('button', {
        class: 'picker-row', type: 'button', role: 'option',
        id: `${m.id}-row-${i}`, tabindex: -1,
        'aria-selected': String(i === m.index),
        onmousedown: (e) => e.preventDefault(),
        onclick: () => acceptMention(m, i),
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
function acceptMention(m, i) {
    const c = m.c;
    const r = m.rows[i == null ? m.index : i];
    const frag = mentionFragment(c);
    if (!r || !frag) return closeMenu(m);
    closeMenu(m);
    insertAt(c, frag.start, c.input.selectionStart, r.insert);
}

/**
 * Put a mention in the composer from somewhere other than the menu.
 *
 * Reply on a received message is the caller. It goes to the front rather than to
 * the caret: replying is the first thing the message is for, so the sentence
 * being written is the reply and the name belongs at the start of it.
 *
 * Hard-wired to the live composer, and staying that way. Its one caller means the
 * box under the conversation the message arrived in and could not mean anything
 * else, so a parameter here would only be a way to get it wrong.
 */
export function insertMention(name) {
    const text = `@[${name}] `;
    if (live.input.value.startsWith(text)) { live.input.focus(); return; }
    insertAt(live, 0, 0, text);
}

/**
 * Splice `text` over [from, to) in a composer, caret after it.
 *
 * Dispatching `input` rather than calling autoGrow() and saveDraft() by hand runs
 * the listeners already wired to the box, so every draft guarantee holds by
 * construction instead of by a second copy of the logic that can drift. It is
 * also what makes a second composer work for nothing: the dialog's box has its
 * own input listener, which sizes it, and this runs that too.
 */
function insertAt(c, from, to, text) {
    const v = c.input.value;
    c.input.value = v.slice(0, from) + text + v.slice(to);
    const caret = from + text.length;
    c.input.setSelectionRange(caret, caret);
    c.input.dispatchEvent(new Event('input'));
    c.input.focus();
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
        } else if (out.how === null) {
            // A runner with no process behind it — the route 404s when there is no
            // runner at all, so this is a session whose process has already gone.
            // There was nothing to kill, and saying otherwise is what this branch
            // exists to stop: the old wording claimed a kill and a transcript
            // entry for a turn that had ended minutes ago.
            state.stopArmed = 0;
            dom.btnStop.textContent = 'Stop';
            dom.btnStop.classList.remove('force');
            toast(back
                ? 'That session\u2019s process had already stopped.' + back
                : 'That session\u2019s process had already stopped — nothing to stop.', 'ok');
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
//
// Coalesced into one frame, and passive: `markActiveTurn` measures the document
// and scroll fires far faster than the screen can show the result, so running it
// per event was paying for work nobody sees. `passive` because this never calls
// preventDefault, and saying so lets the compositor scroll without waiting for
// the handler at all.
let scrollFrame = 0;
dom.scroll.addEventListener('scroll', () => {
    const sc = dom.scroll;
    state.pinned = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90;
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        markActiveTurn();
        // Marks are painted for the viewport, not the transcript — see paintFind
        // — so scrolling is what brings the rest of them into being.
        if (state.find.open) paintFind();
    });
}, { passive: true });

// The subagent pane scrolls separately and needs the same repaint. Nothing else
// here is about it: `pinned` and the turn rail are the session's alone.
let agentScrollFrame = 0;
dom.agentScroll.addEventListener('scroll', () => {
    if (agentScrollFrame || !state.find.open) return;
    agentScrollFrame = requestAnimationFrame(() => {
        agentScrollFrame = 0;
        if (state.find.open) paintFind();
    });
}, { passive: true });

// The tooltip is positioned against a tick, so it cannot follow one that moves.
dom.turns.addEventListener('scroll', hideTurnPop);

/**
 * The first-message box, as a composer.
 *
 * Everything that differs from the live one is here and nowhere else, which is
 * the point of the descriptor: where the working directory comes from, what to
 * say when there is not one yet, and the two things about the box itself — it is
 * several lines tall, so Home and End stay with the caret; and it is inside a
 * modal that clips, so its popovers are positioned from script.
 *
 * No `closeOthers`: the bell and the recent-directories menu are main-window
 * furniture, and this dialog is laid over both of them already.
 */
const newC = makeComposer({
    input: dom.newPrompt,
    slashNode: dom.newSlashMenu,
    mentionNode: dom.newMentionMenu,
    id: 'new',
    container: '.composer-field',
    snipBtn: dom.newBtnSnippets,
    snipNode: dom.newSnipMenu,
    // Read fresh on every keystroke, deliberately: the box below this one is a
    // text field, and walking into a folder in the picker writes it too, so the
    // directory can change while the menu is open. `sessionId: null` is what
    // sends the request as `?cwd=` and what leaves every running session in the
    // `@` menu rather than dropping the one you are in — there is not one yet.
    ctx: () => {
        const cwd = dom.newCwd.value.trim();
        return cwd ? { cwd, sessionId: null } : null;
    },
    notReady: 'Pick a working directory first.',
    homeEnd: false,
    float: true,

    // Held rather than uploaded, because where a file lands is decided by the box
    // above this one and that box is still editable. The drop zone is the field
    // rather than the whole modal: a file let go over the directory picker is much
    // more likely to be aimed at the picker than at the message.
    attachNode: dom.newAttach,
    attachInput: dom.newAttachInput,
    attachBtn: dom.newAttachBtn,
    dropZone: dom.newScrim.querySelector('.composer-field'),
    uploadMode: 'deferred',
    afterRender: () => paintNewAttach(),
    // Sizing the box is what this listener used to be for on its own. It stays
    // first: a popover placed against the box has to be placed against the height
    // it has now, not the height it had a keystroke ago.
    onInput: growPrompt,
    perm: dom.newPerm,
    model: dom.newModel,
});
wireComposer(newC);
wireAttachments(newC);

// ── Wispr Flow transforms ────────────────────────────────────────────────
//
// A button beside each message box lists the transforms set up under Settings →
// Wispr Flow. Picking one selects the text in the box, or keeps your selection
// if you made one, and asks the bridge to press the transform's chord. Wispr then
// rewrites the selection itself, and the textarea's own `input` listeners pick
// the change up the way they would a paste.
//
// The page cannot press the chord: a synthetic KeyboardEvent never leaves the
// renderer, and Wispr listens at the OS. So the bridge does it, by transform id,
// so a request can only ever press a chord the user set up. See bridge/wispr.js.

const WISPR = [
    { c: live, btn: dom.btnWispr, node: dom.wisprMenu, index: 0 },
    { c: newC, btn: dom.newBtnWispr, node: dom.newWisprMenu, index: 0 },
];
for (const w of WISPR) w.c.wispr = w;

dom.btnWispr.append(icon('wispr', 17));
dom.newBtnWispr.append(icon('wispr', 15));

/** Draw or hide everything Wispr, once the bridge has said whether a chord can land. */
function paintWisprAvailable() {
    for (const w of WISPR) {
        w.btn.parentElement.hidden = !wisprAvailable;
        if (!wisprAvailable) closeWispr(w);
    }
    if (state.settings.open) renderSettings();
}

/** Asked once at load. A Linux host and a remote caller both answer false. */
async function loadWisprAvailable() {
    try { wisprAvailable = Boolean((await get('/api/wispr')).available); }
    catch { wisprAvailable = false; }
    paintWisprAvailable();
}

function wisprRows(w) {
    return [...w.node.querySelectorAll('.later-row')];
}

function focusWisprAt(w, i) {
    const rows = wisprRows(w);
    if (!rows.length) return;
    w.index = Math.max(0, Math.min(i, rows.length - 1));
    rows[w.index].focus();
}

function showWispr(w, on) {
    if (!on) return closeWispr(w);
    // Only ever one popover up, the rule every other one here keeps.
    closeMenus(w.c);
    closeSnips(w.c);
    w.c.closeOthers();
    if (w.c === live) closeLater();
    for (const other of WISPR) if (other !== w) closeWispr(other);

    w.node.hidden = false;
    w.btn.setAttribute('aria-expanded', 'true');
    drawWispr(w);
    positionWispr(w);
    focusWisprAt(w, 0);
}

function closeWispr(w, { focus = false } = {}) {
    if (w.node.hidden) return;
    w.node.hidden = true;
    w.node.replaceChildren();
    w.btn.setAttribute('aria-expanded', 'false');
    if (focus) w.btn.focus();
}

/** positionLater's arithmetic, against this composer's button. */
function positionWispr(w) {
    const r = w.btn.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - r.bottom - gap * 2;
    const above = r.top - gap * 2;
    const up = below < 220 && above > below;
    const width = Math.min(300, window.innerWidth - 24);

    w.node.classList.toggle('up', up);
    w.node.style.setProperty('--snip-max', `${Math.max(160, Math.min(420, up ? above : below))}px`);
    w.node.style.width = `${width}px`;
    w.node.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - width - 12))}px`;
    if (up) {
        w.node.style.top = 'auto';
        w.node.style.bottom = `${window.innerHeight - r.top + gap}px`;
    } else {
        w.node.style.bottom = 'auto';
        w.node.style.top = `${r.bottom + gap}px`;
    }
}

function drawWispr(w) {
    const list = BOOT_PREFS.wispr.transforms || [];
    const rows = list.map(t => el('button', {
        class: 'later-row', type: 'button', role: 'option',
        // Before the click, so the textarea keeps the selection it had.
        // Pressing a button would otherwise blur the box, and the selection
        // is read back from the box after that.
        onmousedown: (e) => e.preventDefault(),
        onclick: () => runWispr(w, t),
    }, el('span', {}, t.title), el('kbd', { class: 'at' }, t.combo)));

    if (!rows.length) {
        rows.push(el('button', {
            class: 'later-row', type: 'button', role: 'option',
            onclick: () => { closeWispr(w); openWisprSettings(); },
        }, el('span', {}, 'Set up transforms in Settings…')));
    }
    w.node.replaceChildren(...rows);
}

/**
 * Select the text and have the bridge press the chord.
 *
 * The focus has to be back in the box before the press lands, because Wispr acts
 * on the focused window's selection. `select()` only when nothing is selected, so
 * a transform can be aimed at one paragraph of a longer message.
 */
async function runWispr(w, t) {
    closeWispr(w);
    const box = w.c.input;
    box.focus();
    if (box.selectionStart === box.selectionEnd) box.select();
    try {
        await post('/api/wispr/press', { id: t.id });
    } catch (err) {
        toast(`Could not run ${t.title}: ${err.message}`, 'error');
    }
}

function onWisprKey(e, w) {
    const rows = wisprRows(w);
    if (!rows.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        focusWisprAt(w, (w.index + step + rows.length) % rows.length);
        return;
    }
    if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focusWisprAt(w, e.key === 'Home' ? 0 : rows.length - 1);
        return;
    }
    // Escape is on the central ladder, like every other popover's.
    if (e.key === 'Tab') closeWispr(w);
}

for (const w of WISPR) {
    w.btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showWispr(w, w.node.hidden);
    });
    w.node.addEventListener('keydown', (e) => onWisprKey(e, w));
}
document.addEventListener('click', () => { for (const w of WISPR) closeWispr(w); });
window.addEventListener('resize', () => {
    for (const w of WISPR) if (!w.node.hidden) positionWispr(w);
});
dom.newScrim.querySelector('.modal-body').addEventListener('scroll', () => {
    if (!dom.newWisprMenu.hidden) positionWispr(WISPR[1]);
});

// ── the settings group ───────────────────────────────────────────────────

/**
 * The rows being edited, which can be ahead of what is saved: a transform you
 * have just added has no title or shortcut yet, and the bridge refuses a list
 * with a half-written entry in it. So an incomplete row stays here until both
 * fields are filled, and is sent with the rest once they are.
 */
let wisprDraft = null;

function wisprId(title) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
    return `${slug || 't'}-${Math.random().toString(36).slice(2, 8)}`;
}

function openWisprSettings() {
    if (!state.settings.open) showSettings(true);
    requestAnimationFrame(() => {
        if (dom.setGWispr.isConnected) dom.setGWispr.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

export function renderWisprSettings() {
    dom.setGWispr.hidden = !wisprAvailable;
    // Never rebuilt under a caret. A save elsewhere redraws the panel, and doing
    // that while you are typing a title would drop the focus and the half-word.
    if (dom.wisprList.contains(document.activeElement)) return;
    const saved = BOOT_PREFS.wispr.transforms || [];
    const pending = (wisprDraft || []).filter(r => !saved.some(s => s.id === r.id) && !r.saved);
    wisprDraft = saved.map(t => ({ ...t, saved: true })).concat(pending);
    drawWisprRows();
}

/**
 * @param {{keepFocus?: boolean}} [opts] put the caret back where it was. A save
 *   lands after the change that caused it, by which time Tab has usually moved
 *   the focus on to the next field, and a redraw must not throw it out of there.
 */
function drawWisprRows({ keepFocus = false } = {}) {
    const at = document.activeElement;
    const had = keepFocus && dom.wisprList.contains(at)
        ? { row: [...dom.wisprList.children].indexOf(at.parentElement), cls: at.className,
            start: at.selectionStart, end: at.selectionEnd }
        : null;
    paintWisprRows();
    if (!had) return;
    const row = dom.wisprList.children[had.row];
    const back = row && row.querySelector(`.${had.cls}`);
    if (!back) return;
    back.focus();
    try { back.setSelectionRange(had.start, had.end); } catch { /* not a text field */ }
}

function paintWisprRows() {
    if (!wisprDraft.length) {
        dom.wisprList.replaceChildren(el('div', { class: 'settings-row-note' },
            'No transforms yet. Add one for each Wispr Flow transform you want a button for.'));
        return;
    }
    dom.wisprList.replaceChildren(...wisprDraft.map((r) => {
        const title = el('input', {
            type: 'text', class: 'wispr-set-title', value: r.title || '',
            placeholder: 'Prompt engineer', maxlength: '60', 'aria-label': 'Title',
            onchange: () => { r.title = title.value.trim(); saveWispr(r); },
        });
        const combo = el('input', {
            type: 'text', class: 'wispr-set-combo', value: r.combo || '',
            placeholder: 'Win+Alt+2', spellcheck: 'false', 'aria-label': 'Shortcut',
            onchange: () => { r.combo = combo.value.trim(); saveWispr(r); },
        });
        return el('div', { class: 'wispr-set-row' },
            title, combo,
            snipDeleteButton(`Remove ${r.title || 'this transform'}`, () => {
                wisprDraft = wisprDraft.filter(x => x !== r);
                drawWisprRows();
                saveWispr(null);
            }),
            r.error ? el('div', { class: 'wispr-set-error' }, r.error) : null);
    }));
}

/**
 * Send every complete row. The array is replaced whole on the bridge, which is
 * what PUT /api/prefs does to any key, so the draft is the whole truth.
 *
 * @param {object|null} row the row that changed, which is where a refusal is shown.
 */
async function saveWispr(row) {
    if (row) row.error = null;
    // Named after its title the first time it is saved, so the settings file
    // reads `prompt-engineer-…` rather than an id made before there was a title.
    // After that it never changes: it is what the popover presses by.
    for (const r of wisprDraft) if (!r.saved && r.title) r.id = wisprId(r.title);
    const complete = wisprDraft.filter(r => r.title && r.combo);
    // A row still being written is not worth a round trip, and sending it would be refused.
    if (row && !complete.includes(row)) { drawWisprRows(); return; }
    try {
        const answer = await put('/api/prefs', {
            scope: 'user',
            patch: {
                wispr: {
                    transforms: complete.length
                        ? complete.map(r => ({ id: r.id, title: r.title, combo: r.combo }))
                        : null,
                },
            },
        });
        BOOT_PREFS.wispr.transforms = (answer.prefs.wispr || {}).transforms || [];
        // What the bridge kept is spelled the way it spells it — `win+alt+2`
        // comes back `Win+Alt+2` — and that is what the row should now show.
        for (const r of wisprDraft) {
            const kept = BOOT_PREFS.wispr.transforms.find(t => t.id === r.id);
            if (kept) Object.assign(r, kept, { saved: true });
        }
    } catch (err) {
        if (row) row.error = err.message.replace(/^wispr\.transforms: /, '');
        else toast(`Could not save the transforms: ${err.message}`, 'error');
    }
    drawWisprRows({ keepFocus: true });
}

dom.wisprAdd.addEventListener('click', () => {
    if (!wisprDraft) wisprDraft = [];
    const r = { id: wisprId(''), title: '', combo: '', saved: false };
    wisprDraft.push(r);
    drawWisprRows();
    const inputs = dom.wisprList.querySelectorAll('.wispr-set-title');
    if (inputs.length) inputs[inputs.length - 1].focus();
});

loadWisprAvailable();

// A popover positioned from script has to be told when the page moves under it.
// The modal body is the one scroll container between this box and the window.
dom.newScrim.querySelector('.modal-body')
    .addEventListener('scroll', repositionFloatingMenus);

// ✕, Cancel and a whole click outside — no Escape; see modalUp().
for (const n of dom.newScrim.querySelectorAll('[data-close]')) {
    n.addEventListener('click', closeNew);
}
closeOnClickOutside(dom.newScrim, closeNew);

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
    // The central ladder swallows Escape over a modal, so nothing further down
    // it is at risk — but this handler is what gives the key an answer at all,
    // and stopPropagation keeps that answer "never mind the folder" rather than
    // whatever the ladder grows next.
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
    // The head and the tint follow what is typed, not only what is picked — a
    // path pasted into the box is the same decision as a row pressed in the list.
    paintNewProject();
    if (state.browse.tab === 'browse') dom.newBrowseNote.textContent = browseNote(state.browse);
    // The commands on screen belong to the directory that was in this box when
    // `/` was pressed. Leaving them there while the directory changes underneath
    // is offering a list that will not run.
    if (menuOpen(newC.slash)) updateSlashMenu(newC);
});

// ✕, Cancel and a whole click outside — no Escape; see modalUp().
for (const n of dom.delScrim.querySelectorAll('[data-close-del]')) {
    n.addEventListener('click', closeDelete);
}
closeOnClickOutside(dom.delScrim, closeDelete);

// ── the plan/question review ─────────────────────────────────────────────

// ✕, Close and a whole click outside — see modalUp() for why there is no
// Escape here either.
for (const n of dom.reviewScrim.querySelectorAll('[data-close-review]')) {
    n.addEventListener('click', closeReview);
}
closeOnClickOutside(dom.reviewScrim, closeReview);
dom.reviewJump.addEventListener('click', () => {
    // Resolved now rather than held from the open, because a result landing in
    // between replaces the node this is aiming at.
    const entry = state.nodes.get(state.review.evId);
    closeReview();
    // revealNode opens an enclosing fold on the way, which a tool call in a
    // collapsed run always has.
    if (entry) revealNode(entry.node);
});

// ── the diff viewer ──────────────────────────────────────────────────────

for (const n of dom.diffScrim.querySelectorAll('[data-close-diff]')) {
    n.addEventListener('click', closeDiff);
}
// No Escape rung — see modalUp(). The click outside is the full-click kind for
// this dialog above all: a diff is the one thing here people drag-select, and a
// plain scrim click would close it on a drag released past the edge.
closeOnClickOutside(dom.diffScrim, closeDiff);

dom.diffUnified.addEventListener('click', () => setDiffOpt('split', false));
dom.diffSplit.addEventListener('click', () => setDiffOpt('split', true));
dom.diffWords.addEventListener('change', () => setDiffOpt('words', dom.diffWords.checked));
dom.diffWrap.addEventListener('change', () => setDiffOpt('wrap', dom.diffWrap.checked));
dom.diffSource.addEventListener('change', () => {
    state.diff.mode = dom.diffSource.value;
    fetchDiff();
});
dom.diffReload.addEventListener('click', () => {
    state.diff.stale = false;
    fetchDiff();
});
dom.diffCopy.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(state.diff.text || '');
        toast('Diff copied.', 'ok');
    } catch (err) {
        toast(`Could not copy: ${err.message}`, 'error');
    }
});
dom.diffJump.addEventListener('click', jumpFromDiff);

// ── the right-click menu ─────────────────────────────────────────────────

// `pointerdown` and not `click`, in the capture phase. A click listener would
// fire *after* the row underneath had taken its own click, so one right-click
// would close the menu and open the diff. The menu itself has to be excluded or
// its rows never receive the click that runs them.
document.addEventListener('pointerdown', (e) => {
    if (dom.ctxMenu.hidden) return;
    if (e.target.closest && e.target.closest('#ctx-menu')) return;
    closeContextMenu({ focus: false });
}, true);

// A right-click anywhere that has no menu of its own dismisses this and gets the
// browser's own menu, which is what right-clicking the transcript should do.
//
// The exceptions are the rows that *do* have one, named by CTX_OWNERS. This
// listener runs after the element's own handler, so without them it would close
// the menu that click had just opened, in the same event, and right-click would
// read as doing nothing at all.
document.addEventListener('contextmenu', (e) => {
    if (dom.ctxMenu.hidden) return;
    if (e.target.closest && e.target.closest(CTX_OWNERS)) return;
    closeContextMenu({ focus: false });
});

// Capture, because scroll does not bubble and the list this is anchored inside
// has its own scroller. #turn-pop can name its scroller; a menu opened from
// anywhere cannot.
document.addEventListener('scroll', () => closeContextMenu({ focus: false }),
    { capture: true, passive: true });
window.addEventListener('resize', () => closeContextMenu({ focus: false }));
// Not hypothetical: Open hands focus to Windows, and a menu still on screen
// when you come back is a menu you have forgotten you opened.
window.addEventListener('blur', () => closeContextMenu({ focus: false }));

// ── connect a phone ──────────────────────────────────────────────────────
//
// A group in the settings page, and a dialog off a bar button before that. The
// move is why `loadPairing` exists where `openPair` used to: nothing opens now,
// so the fetch hangs off the panel loading instead.
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

// Remembered because it is the one thing this dialog cannot work out for itself
// and the one thing that is tedious to retype. localStorage rather than the flags
// file: it is a property of this browser, not of the machine.
const PAIR_HOST_KEY = 'cs.pairHost';

export function refreshPairUrl() {
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
            + 'hostname to TGXCODE_ORIGINS if the origin check refuses it.';
    }
    return 'Plain HTTP: the Android app will connect, but nothing about the link '
        + 'is confidential in transit — anything on the path can read the token.';
}

/**
 * What this machine is reachable as, asked once per settings visit.
 *
 * Only ever real values in the list. An earlier version offered
 * `https://<machine>.<tailnet>.ts.net` as a datalist entry meaning "type your
 * name over this", and picking it from the dropdown produced a URL with literal
 * angle brackets in it. A suggestion you must correct is worse than none — so
 * the bridge is asked what this machine is actually called, and the list is
 * empty when it cannot say.
 *
 * Called from loadSettings rather than on a dialog opening, which is the only
 * thing that changed when this stopped being a dialog. Nothing focuses or
 * selects a field any more: a section of a page you scrolled to is not asking
 * for the caret the way a modal that just appeared was.
 */
export async function loadPairing() {
    if (!dom.pairHost.value) {
        dom.pairHost.value = localStorage.getItem(PAIR_HOST_KEY) || '';
    }
    refreshPairUrl();
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
    } catch { /* leave the field to be filled in by hand */ }
}

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
// ✕, Cancel and a whole click outside — no Escape; see modalUp().
for (const n of dom.restartScrim.querySelectorAll('[data-close-restart]')) {
    n.addEventListener('click', closeRestart);
}
closeOnClickOutside(dom.restartScrim, closeRestart);
dom.restartFix.addEventListener('click', startFixSession);
dom.restartGo.addEventListener('click', () => {
    // Skip the pull only if one was attempted and failed — watching it fail
    // twice tells nobody anything. A first-stage refusal never got as far as
    // pulling (`pulled` is null), and that one still should.
    const pulled = state.restart && state.restart.pulled;
    pullAndRestart({ force: true, pull: !(pulled && !pulled.ok) });
});

dom.btnLive.addEventListener('click', () => showLive(!state.live.open));
dom.liveSide.addEventListener('click', () => setDockSide(state.live.dock !== 'side'));
dom.liveFocus.addEventListener('click', () => setFocus(!state.focus));
dom.focusExit.addEventListener('click', () => setFocus(false));
// The dock runs sideways and a mouse wheel only goes up and down.
dom.liveBody.addEventListener('wheel', onDockWheel, { passive: false });
dom.btnTaskboard.addEventListener('click', () => showTaskboard(!state.taskboard.open));
dom.tbRefresh.addEventListener('click', () => loadTaskboard());
dom.tbUnfocus.addEventListener('click', () => tbSetFocus(false));
// Client-side, unlike the rail's filter next to it: the whole list of open
// tasks is already in hand, so a round trip would only add lag to a keystroke.
dom.tbSearch.addEventListener('input', debounce(() => {
    state.taskboard.query = dom.tbSearch.value;
    if (taskboardVisible()) renderTaskboard();
}, 120));
dom.tbSearch.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Clearing the box before leaving it: Escape on a full box is "show me
    // everything again", and only on an empty one is it "I am done here".
    if (dom.tbSearch.value) {
        e.stopPropagation();
        dom.tbSearch.value = '';
        state.taskboard.query = '';
        if (taskboardVisible()) renderTaskboard();
    }
});
dom.btnDash.addEventListener('click', () => showDash(!state.dash.open));
dom.dashRefresh.addEventListener('click', () => loadDash({ refresh: true }));

dom.btnNotes.addEventListener('click', () => showNotes(!state.notes.open));

dom.btnDrafts.addEventListener('click', () => showDrafts(!state.drafts.open));
// The dialog, with nothing in it — and no `draft`, so Save makes a new one. The
// panel is deliberately left open underneath: the dialog is a modal over the
// whole window, and closing it drops you back on the board with the new card
// already on it rather than on whatever was behind the board.
dom.drNew.addEventListener('click', () => openNew());

dom.btnSettings.addEventListener('click', () => showSettings(!state.settings.open));
// Which group you are in, on a frame rather than on every scroll event: this
// reads a bounding box per group and a settings page can be scrolled fast.
let tocFrame = 0;
dom.setShell.addEventListener('scroll', () => {
    if (tocFrame) return;
    tocFrame = requestAnimationFrame(() => { tocFrame = 0; markSettingsToc(); });
}, { passive: true });
// The pinned head's height, for the shell's scroll-padding: it grows when the
// file line picks up tags or wraps, and shrinks when the project picker hides.
if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
        dom.setShell.style.setProperty('--set-top-h', `${dom.setTop.offsetHeight}px`);
    }).observe(dom.setTop);
}
// Changing scope redraws off the answer already in hand — the chain came back
// whole, so there is nothing to fetch. Changing project does need a fetch,
// because it is a different chain.
dom.setScope.addEventListener('change', () => {
    state.settings.scope = dom.setScope.value;
    state.settings.recording = null;
    // Which groups read as chosen depends on the scope, so this is a fresh look
    // at the list rather than the same one redrawn.
    state.settings.groupOrder = null;
    renderSettings();
});
dom.setProject.addEventListener('change', () => {
    state.settings.project = dom.setProject.value;
    state.settings.recording = null;
    // Both groups are about the project that selector names, so both re-read.
    // A JSON draft is about a file in the *old* project, so it goes — with a
    // confirm, because it is somebody's typing.
    const cfg = state.claudeCfg;
    // The hooks draft too, which is the one that most needs asking about.
    if (!claudeMayLeave()) {
        dom.setProject.value = settingsProject();
        return;
    }
    // And the memory draft, which is about that project's CLAUDE.md for the
    // same reason and gets its own sentence — "the JSON you have edited" is not
    // what somebody who has been writing prose has been doing.
    const docs = state.claudeDocs;
    if (docs.dirty && !window.confirm('Discard the changes you have made to CLAUDE.md?')) {
        dom.setProject.value = settingsProject();
        return;
    }
    // And the command form, which is the third draft on this page and the one
    // most likely to be mid-edit: it is a form rather than a text box, so
    // "dirty" here can be a single checkbox somebody has just ticked.
    const cmds = state.cmdCfg;
    if ((cmds.dirty || cmds.rawDirty)
        && !window.confirm('Discard the changes to this project’s commands?')) {
        dom.setProject.value = settingsProject();
        return;
    }
    cfg.draft = null;
    cfg.dirty = false;
    cfg.jsonError = null;
    cfg.stale = null;
    docsClearDraft(docs);
    cmdClearDrafts(cmds);
    cmds.stale = null;
    loadSettings();
});

dom.btnSched.addEventListener('click', () => showSched(!state.sched.open));
// `schedule: true` rather than a row: a new one, so Save posts instead of
// patching. The panel stays open underneath for the reason drNew's does.
dom.schedNew.addEventListener('click', () => openNew({ schedule: true }));
dom.newSchedSave.addEventListener('click', () => schedSave());
// The English under the box, from the bridge's own parser. `input` rather than
// `change` so it keeps up with typing; the fetch behind it is debounced.
// Every control in the picker, `#new-cron` included, is wired inside this — on
// `input` rather than `change`, so the Custom row keeps up with typing and the
// debounced fetch behind it absorbs the rest.
whenBuild();
dom.newGateKind.addEventListener('change', () => paintGateFields());
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
    // The right-click menu is above even those: it is anchored to the pointer, so
    // it can be opened over any of them.
    if (e.key === 'Escape' && !dom.ctxMenu.hidden) { closeContextMenu({ focus: true }); return; }
    // A popover can sit over a modal dialog, so it answers Escape first.
    if (e.key === 'Escape' && !dom.quotaMenu.hidden) { showQuota(false); dom.quotaPill.focus(); return; }
    if (e.key === 'Escape' && !dom.cvMenu.hidden) { showCv(false); dom.cvPill.focus(); return; }
    if (e.key === 'Escape' && !dom.newMenu.hidden) { showNewMenu(false); dom.btnNewMenu.focus(); return; }
    if (e.key === 'Escape' && !dom.barMoreMenu.hidden) { showBarMore(false); dom.barMore.focus(); return; }
    // Both snippet popovers, and above the modal rung rather than below it — the
    // dialog's sits over #new-scrim while it is open, so a rung underneath would
    // never run and Escape would be swallowed with the popover still up.
    if (e.key === 'Escape' && !dom.snipMenu.hidden) { closeSnips(live, { focus: true }); return; }
    if (e.key === 'Escape' && !dom.newSnipMenu.hidden) { closeSnips(newC, { focus: true }); return; }
    // On the same rung, for the same reason.
    if (e.key === 'Escape' && !dom.laterMenu.hidden) { closeLater({ focus: true }); return; }
    if (e.key === 'Escape' && !dom.wisprMenu.hidden) { closeWispr(live.wispr, { focus: true }); return; }
    if (e.key === 'Escape' && !dom.newWisprMenu.hidden) { closeWispr(newC.wispr, { focus: true }); return; }
    // Below them, a modal dialog swallows Escape rather than closing on it —
    // see modalUp(). Swallowed rather than left out of this ladder: without a
    // rung the key falls through to the panel *behind* the dialog, so a stray
    // Escape over Start-a-session would quietly close Settings or the Taskboard
    // instead. This listener is the last of the three registered on the
    // document, so returning here really is the end of the road for the key.
    if (e.key === 'Escape' && modalUp()) return;
    if (e.key === 'Escape' && state.taskboard.open) { showTaskboard(false); return; }
    if (e.key === 'Escape' && state.dash.open) { showDash(false); return; }
    if (e.key === 'Escape' && state.notes.open) { showNotes(false); return; }
    if (e.key === 'Escape' && state.drafts.open) { showDrafts(false); return; }
    // Schedules was missing from this ladder — Escape closed the other four
    // whole-screen panels and left that one up, which reads as the key not
    // working rather than as a panel that is special.
    if (e.key === 'Escape' && state.sched.open) { showSched(false); return; }
    if (e.key === 'Escape' && state.settings.open) { showSettings(false); return; }
    // The preview, one step at a time: out of Maximize first, then Home. Keys
    // typed into the page itself go to the page and never reach here.
    if (e.key === 'Escape' && state.preview.open && state.preview.max) { previewPane.setMaximized(false); return; }
    if (e.key === 'Escape' && state.preview.open) { showPreview(false); return; }
    // Focus mode is a way of showing the board rather than a panel of its own, so
    // Escape leaves it without also taking the board away. Closing the board is
    // the Live button's alone — it is somewhere you go and stay, not something
    // laid over your work, and Escape was shutting it while you were reading it.
    if (e.key === 'Escape' && state.focus) { setFocus(false); return; }
    // Above the subagent pane it may be searching, below anything laid over the
    // whole window — and everything above this line closes find on the way up
    // (paintPanels, showPlan) or refuses to let it open (openFind), so the two
    // are never both on screen for the order to matter. A *docked* live board is
    // the one thing above that does not: it leaves the conversation on screen,
    // and searching it while the board runs beside you is the point.
    if (e.key === 'Escape' && state.find.open) { closeFind({ focus: true }); return; }
    if (e.key === 'Escape' && state.agent) { closeAgent(); return; }
    // Everything below is a *bound* shortcut, and web/keys.js decides which one
    // a keystroke is — so this reads as a list of commands rather than a list of
    // chords, and remapping one is a settings change instead of an edit here.
    //
    // Ctrl (or Alt) is on all of them because the composer is a textarea and
    // these have to work while it has the focus; bridge/keymap.js enforces that
    // rather than trusting it, so a binding that arrives here is safe to act on.
    // Not gated on isTyping for the same reason.
    //
    // The terminal gets its keys first when it has the focus: xterm passes
    // everything but its own copy chord straight through and it bubbles here as
    // well, so `inTerm` is the only thing stopping a shell from losing a Ctrl+F
    // it was meant to keep. Only the commands whose chord a shell has a use of
    // its own for yield — the two find ones, and the composer cycles in both
    // directions, whose Ctrl+P is readline's previous-history and the tmux prefix. A view shortcut
    // is not something a shell wants, and having Ctrl+3 stop working because the
    // cursor is in a terminal would be worse than the collision it avoids.
    // `terminal.toggle` reads `inTerm` for a third thing again — see there.
    const command = keys.match(e);
    if (!command) return;
    const inTerm = dom.termBody && dom.termBody.contains(e.target);

    // The eight things `main` can show, ordered by how wide a question each one
    // answers: the conversation in front of you, then everything outstanding,
    // then what is running this second, then what is unfinished in the working
    // trees, then what already reached you, then what has not begun, then what
    // starts on a clock, and last the settings — which are about the app rather
    // than about any work at all. The task board arriving is what made that an
    // ordering rather than the sequence they happened to be built in: Live and
    // Dashboard each moved along by one, which is a real cost and worth paying
    // once, not again. Settings going on the end rather than anywhere tidier is
    // the same reasoning still holding.
    const views = {
        'view.tasks': showTaskboard,
        'view.live': showLive,
        'view.dashboard': showDash,
        'view.history': showNotes,
        'view.drafts': showDrafts,
        'view.schedules': showSched,
        'view.settings': showSettings,
    };

    if (command === 'view.conversation') {
        e.preventDefault();
        for (const show of Object.values(views)) show(false);
        return;
    }
    if (views[command]) { e.preventDefault(); views[command](true); return; }

    if (command === 'find.open' && state.current && !inTerm) {
        e.preventDefault();
        openFind();
        return;
    }
    if ((command === 'find.next' || command === 'find.prev') && state.current && !inTerm) {
        e.preventDefault();
        stepFind(command === 'find.prev' ? -1 : 1);
        return;
    }
    if (command === 'rail.filter') { e.preventDefault(); dom.search.focus(); return; }
    // Three states rather than two, which is what Ctrl+` means in every editor
    // that has one: show it, then focus it, then put it away. So the chord is a
    // way *into* the terminal and not only a way to see it. The toolbar button
    // stays a plain show/hide — it cannot tell where the focus is, and a mouse
    // already puts the caret where it is going.
    //
    // This is why the `inTerm` guard above is not a blanket return: the hide
    // branch is the one case where a chord pressed inside the shell is meant for
    // the window rather than for the pty.
    if (command === 'terminal.toggle') {
        if (!state.current) return;   // no session, no shell — as the button does
        e.preventDefault();
        if (dom.termPane.hidden) showTerm(true, { focus: true });
        else if (!inTerm) termPane.focus();
        else showTerm(false);
        return;
    }
    // Whichever composer the caret is in, and the live one otherwise — so the
    // same chord works inside the Start-a-session dialog for nothing.
    if (command === 'composer.snippets') {
        const c = composers.find(x => x.input === document.activeElement) || live;
        if (c.snips.btn.disabled) return;
        e.preventDefault();
        showSnips(c, c.snips.node.hidden);
        return;
    }
    // Same resolution as the snippets chord above, and for the same reason: the
    // dialog has its own pair of these controls, so the chord should move the
    // ones next to the box you are typing in.
    //
    // `inTerm` is the one place these differ from every other composer command.
    // Ctrl+P is readline's previous-history and the default tmux prefix, so a
    // shell that has the focus keeps it — returning without preventDefault is
    // what leaves the keystroke to xterm.
    //
    // Each has a `…Prev` twin (Ctrl+Shift+P, Ctrl+Shift+M by default) that walks
    // the same list the other way, for the chord pressed one time too many.
    const cycles = {
        'composer.permissionMode': ['perm', 1], 'composer.permissionModePrev': ['perm', -1],
        'composer.model': ['model', 1], 'composer.modelPrev': ['model', -1],
    };
    if (cycles[command]) {
        if (inTerm) return;
        const [which, step] = cycles[command];
        const c = composers.find(x => x.input === document.activeElement) || live;
        const sel = c[which];
        if (!sel) return;
        e.preventDefault();
        cycleSelect(sel, which === 'model' ? null : CYCLE_PERM, step);
        return;
    }
    if (command === 'session.new') { e.preventDefault(); openNew(); }
});

// Copy buttons inside rendered markdown are delegated: the blocks are innerHTML.
// Everywhere else, a copy button carries its own click — see copyButton.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const block = btn.closest('.code-block');
    const code = decodeURIComponent(block.dataset.code || '');
    // Guarded rather than left to the `catch` below, which never ran: outside a
    // secure context — the plain-http LAN bind in docs/remote.md — the property
    // is undefined, so the call threw before there was a promise to reject and
    // the button was dead with nothing said about it.
    if (!navigator.clipboard) return toast('Could not copy to the clipboard.', 'error');
    navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1400);
    }).catch(() => toast('Could not copy to the clipboard.', 'error'));
});

// Paths in rendered markdown are delegated for the same reason, and intercepted
// for a different one: Chrome refuses an http: page a file: navigation and does
// it silently, so the href on the anchor would never fire. The href is still
// worth carrying — copy-link-address gives a UNC path somebody can paste into
// Explorer, and the title says what the Windows form is — but the click is ours.
document.addEventListener('click', (e) => {
    const a = e.target.closest('a.fs-path');
    if (!a) return;
    e.preventDefault();
    // Ctrl or Shift asks for the folder instead of the file. The other two ways a
    // click ends at a folder — the path is a directory, or Windows would run it —
    // are the bridge's to decide, being the only side that can see the disk.
    openPath(a.dataset.path, { reveal: e.ctrlKey || e.metaKey || e.shiftKey });
});

// Middle-click would open a tab on a file: URL Chrome refuses, i.e. a blank one.
document.addEventListener('auxclick', (e) => {
    if (e.button === 1 && e.target.closest('a.fs-path')) e.preventDefault();
});

/**
 * Open a path a transcript mentioned, on the Windows host.
 *
 * No session id: the route is about the machine rather than a conversation,
 * which is what lets a path on the board work with nothing in focus.
 */
async function openPath(p, { reveal = false } = {}) {
    try {
        const out = await post('/api/fs/open', { path: p, reveal });
        // The bridge answers what it actually did. A silent reveal when the click
        // asked for the file would look like the click had missed.
        if (!reveal && out.how === 'reveal') {
            toast(out.why === 'directory'
                ? `${p} is a folder — opened it in Explorer.`
                : `${p} is a program — showed it in Explorer rather than running it.`,
            'warn');
        }
    } catch (err) {
        toast(`Could not open ${p}: ${err.message}`, 'warn');
    }
}

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
    const tb = q.get('view') === 'taskboard';
    const dr = q.get('view') === 'drafts';
    const sc = q.get('view') === 'schedules';
    const st = q.get('view') === 'settings';
    if (q.get('view') === 'live' || q.get('live') === '1' || q.get('focus') === '1') showLive(true);
    if (dash) showDash(true);
    if (tb) showTaskboard(true);
    if (dr) showDrafts(true);
    if (sc) showSched(true);
    if (st) showSettings(true);
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
// At boot rather than when a panel opens, unlike the drafts and the schedules:
// the pinned buttons are part of the composer, so this list is on screen from the
// first paint.
loadSnippets();
markInstance();
registerWorker();
paintDockButton();      // the remembered arrangement, before anything is drawn
paintHideDone(0);       // and the remembered rail filter, lit before the rows arrive
watchPaneInsets();      // keep the composer over the transcript as columns come and go
// The chrome that names a shortcut, before anything can read it — the bar
// buttons' titles are built from a count, so their static markup carries no
// combo at all and this is what puts one there.
paintShortcutHints();
paintComposerHint();
restoreView();          // and where we were, from the address that survived the refresh
primeWaiting();
// The pill's first answer and its 20-second poll — or neither, when Settings
// says DevBrowser is not part of this app.
paintDevBrowserPresence();
// Nothing to restore here any more: the pane belongs to a session, and the
// first beginOpen is what shows it — for the session it was opened in. The
// window-wide flag this used to read is dropped so it cannot come back.
try { localStorage.removeItem('termOpen'); } catch { /* storage unavailable */ }
// Not while a chip is armed or working: rebuilding the strip there would either
// take back a stop the user is halfway through asking for, or drop the label off
// one already in flight.
setInterval(() => {
    if (state.current && !dom.channels.querySelector('[data-arm="true"], .busy')) loadChannels();
}, 25_000);

// One fetch, to have something to draw before the first push arrives. A PR
// changing under you — a review landing, checks finishing — reaches every surface
// on the `prs-changed` event now; there were three sixty-second polls here, none
// of them aware of the others, and between them they were the whole mechanism.
loadRailPrs();

// The count on the Dashboard button is the only thing that says there is
// anything to look at, so it is read once at startup — a few seconds in, where
// it cannot slow the first paint of the session list. After that it is `prs-changed`
// that reloads it, and only while it is on screen: a board nobody is looking at
// does not need to be right, and it is the heaviest of the three payloads.
setTimeout(() => loadDash(), 3000);

// Same reasoning for the History badge, and the same delay: the number of things
// that wanted you while this window was shut is the one piece of news the button
// carries, and nothing else would go and find it out.
setTimeout(() => loadNotes(), 3200);

// And for the task board's, which counts what is blocked on you. It doubles as
// the board's first load: the order every column holds is taken from whichever
// payload arrives first, so taking one at startup is what makes "sorted on load"
// mean the page load rather than the moment somebody happened to press Ctrl+2.
setTimeout(() => loadTaskboard(), 3400);

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
