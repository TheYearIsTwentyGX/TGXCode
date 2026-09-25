// TGXCode — renderer.
//
// All state lives in the bridge; this file is a view over it. Transcript content
// arrives from one place only (the file tail, pushed over SSE), so a session
// running in somebody's terminal renders identically to one started here.

import { configurePaths } from './markdown.js';
import { PreviewPane } from './preview.js';
import { opensInPreview } from './link-policy.js';
import * as keys from './keys.js';
import { drawRail } from './rail.js';
import { liveStrip, renderLive } from './boards/live.js';
import { html } from './vendor/preact.js';
import { paint, tickCardClocks } from './boards/parts.js';
import { loadDash, paintDashBadge, renderDash } from './boards/dashboard.js';
import { renderNotes } from './boards/history.js';
import { applyDrafts, loadDrafts, renderDrafts, showDrafts } from './drafts.js';
import { applySched, loadSched, showSched } from './schedules.js';
import { applySnippets, loadSnippets, wireSnippets } from './snippets/index.js';
import { paintPinTitles } from './snippets/pins.js';
import { closeSnips, showSnips } from './snippets/popover.js';
import {
    applyTaskboard, loadTaskboard, renderTaskboard, taskboardVisible,
    tbPaintTools, tbSetFocus,
} from './boards/taskboard.js';
// Still reached for through app.js by web/settings/, which predates the boards
// having modules of their own.
export { paintDashBadge, renderLive };
import { del, get, patch, post, put } from './api.js';
import { PREFS_FALLBACK, BOOT_PREFS, BOOT_HOST, pairToken } from './boot.js';
import { DEFAULT_PERM, state } from './state.js';
import { dom, el, toast, modalUp, closeOnClickOutside } from './dom.js';
import { ago, clip, dur, noteHome, setClock, shortPath } from './format.js';
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
    loadSettings, markSettingsToc, openSettingsAt, renderSettings, saveSetting, setSettingsNotes,
    settingsProject, showSettings,
} from './settings/index.js';
import {
    closeMemoDialog, docsClearDraft, docsRow, loadClaudeDocs, paintMemoDialog, saveClaudeDocs,
} from './settings/memory.js';
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
import { warmPeers } from './transcript/rows.js';
import {
    agentRows, closeAgent, leaveAgent, loadAgents, openAgent,
} from './transcript/subagents.js';
import {
    actOnSuggestion, closeTaskDialog, openTaskDialog, renderTasks, showTasks,
    startSuggestion,
} from './transcript/suggestions.js';
import { toolSummary } from './transcript/tools.js';
import {
    flashNode, hideTurnPop, jumpToTurn, markActiveTurn, revealNode,
} from './transcript/turn-rail.js';
import { applyRunChange, cmdDir, loadCommands, renderCommands } from './commands.js';
import { adoptAttachments, dragHasFiles, wireAttachments } from './composer/attachments.js';
import { applyLater, closeLater, loadLater, wireLater } from './composer/later.js';
import { updateMentionMenu } from './composer/mentions.js';
import { applyQueue, wireQueue } from './composer/queue.js';
import {
    autoGrow, clearPendingSend, enableSend, enterSends, grow, handleSendFailure,
    paintComposerHint, sendMessage,
} from './composer/send.js';
import {
    composers, live, menuOpen, updateSlashMenu, wireComposer, wireSlash,
} from './composer/slash.js';
import { closeWispr, wireWispr } from './composer/wispr.js';
import {
    newC, openNew, paintNewProject, wireNewDialog,
} from './new-session/dialog.js';
import { showNewMenu, wireNewMenu } from './new-session/recent.js';
import {
    drSave, drToSchedule, paintGateFields, schedSave, startNew, whenBuild,
} from './new-session/trigger.js';
import { setTermOpen, setTermTab, showTerm, termPane, wireTerm } from './term-pane.js';

// ── settings ─────────────────────────────────────────────────────────────

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
export const hexAccent = (v) => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v || '') ? v : '');

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
 * `transcript.clock`, told to web/format.js (which draws every clock but may
 * not read `state`) and to the root (whose `data-clock` widens the gutter a
 * 12-hour clock needs — see web/css/base.css). What is already drawn keeps the
 * old answer until it is drawn again; applyPrefsLive redraws for that.
 */
export function applyClock() {
    setClock(BOOT_PREFS.transcript.clock);
    document.documentElement.dataset.clock = BOOT_PREFS.transcript.clock === '12h' ? '12h' : '24h';
}
applyClock();

// Here rather than beside its callers because paintPanels() asks it about
// visibility, and paintPanels runs during boot, well before the section that
// handles the preview's buttons would have been reached.
export const previewPane = new PreviewPane({
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

export function saveAttach(id, list) {
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
export function restoreToComposer(text, files) {
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
export const opensInDevBrowser = () => devBrowserShown() && BOOT_PREFS.devbrowser.openIn === 'devbrowser';

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
 * A link clicked in chat, in the preview — when Settings says so for this URL
 * (web/link-policy.js). Anything the pane cannot show goes to the browser, which
 * is where it would have gone without the setting.
 */
async function openLinkInPreview(href) {
    const shown = previewAvailable() && await previewPane.openUrl(href);
    if (shown) showPreview(true);
    else window.open(href, '_blank', 'noreferrer');
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
// subscribes to a transcript. The cards are drawn by web/boards/live.js; what
// stays here is the view around them — turning the board on, the dock, focus
// mode, the address bar and the badge.

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

/**
 * A session's task list, as a bar — the DOM twin of web/boards/parts.js's
 * taskBar, for the checklist in web/transcript/checklist.js, which is still
 * built by hand.
 */
export function taskBar(t) {
    const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
    return el('div', {
        class: 'tbar', title: `${t.done} of ${t.total} tasks done`,
        role: 'progressbar', 'aria-valuenow': t.done, 'aria-valuemin': 0, 'aria-valuemax': t.total,
    }, el('span', { class: 'tbar-fill', style: `width:${pct}%` }));
}

// ── dashboard ────────────────────────────────────────────────────────────
// The rail answers "what have I been talking to". This answers "what have I
// left behind" — changes nobody committed, pull requests nobody merged — which
// is the thing a screen full of finished conversations hides. The fetch, the
// badge and the drawing are web/boards/dashboard.js; what stays here is the
// panel machinery every whole-screen panel shares.

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
//
// The list is drawn by web/boards/history.js. The read state stays here, because
// openSession and the stream both reach into it.

const NOTES_STALE_MS = 30_000;

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

export async function loadNotes() {
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
export function noteUnread(row, marks = state.notes.read) {
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

/**
 * Back to where it came from — which is the whole reason for the list.
 *
 * An ask carries the id of the tool call it was about, and that is a real node
 * in the transcript, so the row can put you on the exact line rather than at the
 * bottom of a long conversation. Where there is no anchor — a finished turn, a
 * subagent — opening the session at the end is the right answer anyway.
 */
export function openFromNote(n) {
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
// Everything outstanding, in four columns. The board itself — its held order,
// its drawing, the focused view and acting on a card — is web/boards/taskboard.js,
// and its header is where the reasoning is. What stays here is what the other
// panels and the stream reach for: opening it, the watch flag the `hello`
// handler re-subscribes with, and the badge.

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

// ── cycling a select ─────────────────────────────────────────────────────

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
// at the top of web/css/base.css. Read from the stylesheet rather than written out
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
//
// The group's card is markup in web/index.html (Settings hangs it in its tree
// as foreign DOM), but the three lists inside it are Preact renders into its
// three containers — the rows are Settings' own settingRow() vnodes, so they
// have to be.

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
        paint(dom.pcolorList, html`<div key="none" class="settings-row-note"
            >No projects yet — a directory appears here once a session has run in it.</div>`);
        return;
    }
    paint(dom.pcolorList, projects.map((p) => {
        const hex = hexAccent(colors[p.cwd]);
        return html`<div key=${p.cwd} class="pcolor-row" data-tinted=${hex ? '1' : undefined}
            style=${hex ? `--proj-accent: ${hex}` : undefined}>
            <button class=${'pcolor-swatch' + (hex ? '' : ' none')} type="button"
                style=${hex ? `--pcolor: ${hex}` : undefined}
                aria-label=${`Set the colour for ${p.name}`}
                onClick=${() => openPcolor({ cwd: p.cwd, name: p.name })}></button>
            <div class="pcolor-row-text">
                <div class="pcolor-row-name">${p.name}</div>
                <div class="pcolor-row-path">${p.cwd}</div>
            </div>
            ${hex ? html`<button class="btn small" type="button"
                onClick=${() => saveProjectColor(p.cwd, null)}>Clear</button>` : null}
        </div>`;
    }));
}

/**
 * The rail-order rows at the head of the group.
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
    if (!data) { paint(dom.pcolorOrder, null); return; }
    const mode = (data.projects && data.projects.sort) || 'recent';
    const custom = (data.projects && data.projects.order) || [];
    paint(dom.pcolorOrder, [
        ...group.orderRows.map(row =>
            settingRow(group, row, locked || (row.mode && row.mode !== mode))),
        mode === 'custom' && custom.length
            ? html`<div key="custom" class="settings-row">
                <div class="settings-row-text">
                    <div class="settings-row-label">Custom order</div>
                    <div class="settings-row-note">${
                        `${custom.length} project${custom.length === 1 ? '' : 's'} placed by hand.`}</div>
                </div>
                <div class="settings-row-ctl">
                    <button class="linkish" type="button" disabled=${locked}
                        onClick=${() => saveSetting('projects', 'order', [])}>Reset custom order</button>
                </div>
            </div>`
            : null,
    ]);
}

/** The two backdrop rows above the colour list — settingRow() for the same reason. */
export function renderProjectBackdrop() {
    const group = SETTINGS.find(g => g.section === 'projects');
    const locked = state.settings.scope !== 'user';
    if (!state.settings.data) { paint(dom.pcolorBackdrop, null); return; }
    paint(dom.pcolorBackdrop, group.rows.map(row => settingRow(group, row, locked)));
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

// The Settings panel and everything it draws are in web/settings/. These two
// wire listeners that used to be registered here, and run at the same point.
// (Notifications had a third; its controls carry their own handlers now.)
wireToolbar();
wireShortcuts();

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
export function lockedNow() {
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

// ── composer, new session ────────────────────────────────────────────────
// Sending — send later, the queue, attachments, the optimistic chips — and the
// `/`, `@` and Wispr popovers are in web/composer/; the Start-a-session dialog is
// in web/new-session/; the header's command buttons and the app's side of the
// terminal pane are web/commands.js and web/term-pane.js. What those sections
// registered at load is registered by the wire*() calls here and below, each at
// the point it always ran, so listeners on a shared target keep their order.

wireNewMenu();

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
// wireComposer — see web/composer/slash.js and wireSlash() below.
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
wireSnippets();
wireLater();

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
wireTerm();

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
dom.input.addEventListener('keydown', (e) => {
    if (!enterSends(e)) return;
    e.preventDefault();
    sendMessage();
});

wireSlash();

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

wireQueue();

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

// The Start-a-session dialog's first-message box, built in new-session/dialog.js.
wireComposer(newC);
wireAttachments(newC);

wireWispr();
wireNewDialog();

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
        toast(state.diff.kind === 'scratch' ? 'Copied.' : 'Diff copied.', 'ok');
    } catch (err) {
        toast(`Could not copy: ${err.message}`, 'error');
    }
});
dom.diffJump.addEventListener('click', jumpFromDiff);
dom.diffOpen.addEventListener('click', () => {
    if (state.diff.absPath) openPath(state.diff.absPath);
});

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
// Where a setting's description shows — a class flip, see paintSettingsNotes().
dom.setNotes.addEventListener('change', () => setSettingsNotes(dom.setNotes.value));
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
    // Ctrl or Shift asks for the folder straight away, skipping the menu below.
    if (e.ctrlKey || e.metaKey || e.shiftKey) return openPath(a.dataset.path, { reveal: true });
    choosePathAction(a, e);
});

/**
 * A plain click on a path: a folder opens, a file asks whether you want the file
 * or the folder it is in.
 *
 * Which of the two it is comes from the bridge, being the only side that can see
 * the disk — `Makefile` has no extension and `v1.2` is a folder. The probe opens
 * nothing. A file Windows would run keeps its Open row, greyed with the reason,
 * because the bridge would only reveal it anyway and a row that did the same
 * thing as the one under it would be a lie.
 */
async function choosePathAction(a, e) {
    const p = a.dataset.path;
    // Taken before the await: the event's coordinates are all a menu has to go
    // on, and a keyboard Enter reports 0,0, which openContextMenu answers with
    // the anchor's own rectangle.
    const at = { clientX: e.clientX, clientY: e.clientY, currentTarget: a };
    let probe;
    try {
        probe = await post('/api/fs/open', { path: p, probe: true });
    } catch (err) {
        return toast(`Could not open ${p}: ${err.message}`, 'warn');
    }
    // As a reveal, which for a folder is the same Explorer window, so openPath
    // does not toast that the folder you clicked turned out to be a folder.
    if (probe.kind === 'directory') return openPath(p, { reveal: true });
    if (!a.isConnected) return;
    openContextMenu(at, [
        {
            label: 'Open',
            onClick: () => openPath(p),
            disabled: probe.launchable
                ? 'Windows would run this file, so it is not opened from a link.' : false,
        },
        { label: 'Explore here...', onClick: () => openPath(p, { reveal: true }) },
    ]);
}

// A link in rendered markdown — a message, a plan, a review — goes to the
// preview when `preview.links` and its list say so. A modified or middle click
// is somebody asking for the browser, and never reaches here as a plain click.
document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('.prose a[href]');
    if (!a || a.classList.contains('fs-path')) return;
    if (!opensInPreview(a.href, BOOT_PREFS.preview)) return;
    e.preventDefault();
    openLinkInPreview(a.href);
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
export async function openPath(p, { reveal = false } = {}) {
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
