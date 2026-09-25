// The open conversation: opening a session, its header, and appending events
// to the log — through a view (SESSION_VIEW or AGENT_VIEW), so the main log and
// the subagent pane render with the same code — plus folding runs of tool calls.
//
// The views share `nodes`, `tools` and `run` with state.js. AGENT_VIEW has no
// `plans` on purpose: a subagent cannot put a plan in front of you.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.
//
// One exception: SESSION_VIEW and AGENT_VIEW capture `state.*` at load. That is
// safe because state.js imports nothing, so it has always finished evaluating
// before this file runs. Do not extend the exception to any other import.

import { get } from '../api.js';
import { BOOT_PREFS } from '../boot.js';
import { loadChannels } from '../channels.js';
import { dom, el, toast } from '../dom.js';
import { ago, clip, clockOf, dateOf, dur, shortModel } from '../format.js';
import { icon, PR_ICON } from '../icons.js';
import * as keys from '../keys.js';
import { cvStaleFor } from '../quota.js';
import { state } from '../state.js';
import { loadCommands } from '../commands.js';
import { showTerm, termOpen } from '../term-pane.js';
import {
    applyRunner, grouping, loadAttach, loadDraft, loadSessions, markSessionNotesRead,
    paintPanels, prUnknownWhy, rememberView, renderPins, renderRail, saveDraft, scrollToEnd,
    showDash, showPreview, showTaskboard, subscribe, takePendingJump,
} from '../app.js';
import { clearAttach, renderAttach } from '../composer/attachments.js';
import { closeLater, renderLater } from '../composer/later.js';
import { autoGrow, clearPendingSend } from '../composer/send.js';
import { closeMenus, live } from '../composer/slash.js';
import { loadChangesIfStale, renderChanges, resetChanges } from './changes.js';
import { renderChecklist, resetChecklist } from './checklist.js';
import { findKey, markFindDirty, resetFind } from './find.js';
import { paneUp } from './layout.js';
import { closeReview, paintReview } from './review.js';
import { renderEvent, warmPeers } from './rows.js';
import { leaveAgent, loadAgents, renderAgents } from './subagents.js';
import { closeTaskDialog, loadTasks, loadTasksSoon, renderTasks } from './suggestions.js';
import { fillTool } from './tools.js';
import { hideTurnPop, renderTurns, REVIEWABLE } from './turn-rail.js';

// ── conversation ─────────────────────────────────────────────────────────

export async function openSession(id, { quiet = false, keepDash = false } = {}) {
    // Going to a conversation is what "I have dealt with this" looks like, so it
    // is what clears its notifications. Above the early return below rather than
    // after it: a history row for the chat you are already sitting in still has
    // to clear, and that is the one path that does not reach the rest of this.
    markSessionNotesRead(id);
    // Already here — but a history row may still have somewhere to put you.
    if (state.current && state.current.sessionId === id) { takePendingJump(); return true; }
    // Keep whatever is half-typed for the session being left behind.
    if (state.current) saveDraft(state.current.sessionId, dom.input.value);
    // The menu belongs to the directory being left, and the draft arriving in
    // the box is not something anybody typed.
    closeMenus(live);

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
        loadTasks();
        // Only when the drawer is up. It shells out to git, and a window that
        // never opens it should not pay for it on every session it visits.
        loadChangesIfStale();
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
    state.plans.clear();
    state.run.length = 0;
    state.prefs = null;     // the next session's project may answer differently
    state.turns = [];
    state.turnTicks = [];
    state.activeTurn = -1;
    state.pinned = true;
    state.agents = [];  // the previous session's agents are not this one's
    resetFind();
    state.prStatus = null;      // nor are its pull requests
    state.ask = null;   // approvals belong to the session that is blocked on them
    state.suggestions.clear();  // what was acted on belongs to the session it was raised in
    state.tasks.clear();        // and so do the offers themselves
    state.taskOpen.clear();
    closeTaskDialog();          // it was showing a task belonging to the old one
    closeReview();              // and so was the plan or question review
    // Going to a conversation is going to the conversation: a preview left up
    // would cover the one you just asked for. Its page stays loaded.
    if (state.preview.open) showPreview(false);
    // Empties the aside, but keeps its place in the row until loadTasks answers
    // for the new conversation — see renderChecklist for why.
    state.tasksPending = paneUp(dom.tasks);
    renderTasks();
    // A snippet scoped to a project appears and disappears as you move between
    // conversations, so the strip is rebuilt against the new directory rather than
    // only when the list itself changes.
    renderPins();
    resetChanges();             // and the files listed were the old session's
    renderChanges();            // which leaves the drawer saying it is looking
    resetChecklist();           // as was the task list — the push will refill it
    renderChecklist();
    // The whole list is already here, so this only has to be re-filtered — but it
    // does have to be, or the chips from the session you just left stay on the
    // composer of the one you just opened.
    state.laterOpen.clear();
    renderLater();
    closeLater();
    // A row drawn for one session is not evidence about another. The log is
    // replaced below in any case; this is what disarms the timer holding it.
    clearPendingSend();
    state.stopArmed = 0;
    leaveAgent();       // a subagent belongs to the session it was spawned by

    // Picking a session is done with the whole-screen boards, whichever way you
    // got there — including the roundabout way, where Start on a task board card
    // makes a session and then opens it. The live board is not a place you leave
    // — it docks under the conversation you just opened, which is the whole
    // point of it.
    if (state.dash.open && !keepDash) showDash(false);
    if (state.taskboard.open && !keepDash) showTaskboard(false);
    // Through paintPanels rather than by hand: opening a session is what turns a
    // full-height board into a docked one, and setting `conv.hidden` here
    // directly left the two disagreeing — the conversation drawn underneath a
    // board that still thought it had the window to itself.
    paintPanels();

    renderHeader();
    hideTurnPop();
    // Emptied, but keeping its 30px until renderTurns says whether the new
    // conversation has a rail — otherwise the column blinks out and back while
    // the switch is animating, and takes the composer 30px with it both ways.
    // Only if there is a rail to hold, so a conversation that never had one does
    // not gain a reserved strip.
    if (paneUp(dom.turns)) dom.turns.classList.add('holding');
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
    // The files staged against this session, from the same place. Cleared without
    // saving first, so switching away does not write the outgoing session's chips over
    // the incoming one's.
    clearAttach(live, { save: false });
    live.attach = loadAttach(summary.sessionId);
    renderAttach(live);
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
export async function openSessionSoon(id, { timeoutMs = 25000 } = {}) {
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

export function renderHeader() {
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
    // Only when this session's process predates the installed binary, which is
    // the case where a feature somebody just read about is not here yet.
    const oldClaude = cvStaleFor(s.sessionId);
    if (oldClaude) {
        bits.push(el('span', { class: 'sep' }, '·'));
        bits.push(el('span', { class: 'cv-old', title: `This session's process is Claude Code `
            + `${oldClaude.version}; ${state.cv.installed} is installed. It moves over when the process restarts.` },
        `Claude ${oldClaude.version} (older)`));
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
    const s = state.current;
    if (!s) return [];
    if (s.prs) return s.prs;
    // A bridge older than the `prs` field still sends one PR as `pr`, and that pairing
    // is not hypothetical — it is the normal state of this app for a while after every
    // merge. `npm run land` restarts the bridge only when bridge/ changed, and not at
    // all when the restart is refused or skipped, while web/ is read from disk per
    // request and so is new on the next refresh. Renaming
    // the field without this made the whole feature vanish in that window rather than
    // degrade, which is worse than the single unstyled link it replaced. Safe to delete
    // once no bridge that predates `prs` can still be running.
    return s.pr ? [s.pr] : [];
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
        // Why there is no colour. Only when there is genuinely nothing to say about
        // the PR — an expired token showed here as an unexplained grey glyph,
        // because this surface dropped the reason.
        status === 'unknown' ? prUnknownWhy() : null,
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
 * What became of this session's PRs, in the detail a header has room for.
 *
 * Its own request rather than part of the session payload, and rather than part of
 * the `prs-changed` push: this is per-PR detail for one session, and pushing every
 * session's detail to every window to serve the one conversation on screen is the
 * trade that made it a request in the first place. So the event says *that*
 * something moved and this asks *what* — off a store, so it costs no network call
 * to GitHub and no wait.
 *
 * Failure is silent for the same reason a missing channel strip is: the links are
 * already on screen and still work, they simply stay grey.
 */
export async function loadPrStatus() {
    if (!state.current) return;
    // No guard on the summary having PRs: a session that had none when it was
    // opened is exactly the one that raises its first mid-conversation, and the
    // bridge answers a session with none from its index without asking GitHub.
    const id = state.current.sessionId;
    try {
        const { prs, gh } = await get(`/api/sessions/${id}/prs`);
        if (!state.current || state.current.sessionId !== id) return;
        state.prStatus = new Map((prs || []).map(pr => [pr.url, pr]));
        if (gh && gh.error) state.prsError = gh.error;
        renderHeader();
    } catch {
        // Leaves whatever was known before, which is better than blanking it.
    }
}

export function renderHeaderActions() {
    const s = state.current;
    if (!s) return;
    dom.btnPin.classList.toggle('on', !!s.pinned);
    dom.btnPin.setAttribute('aria-pressed', String(!!s.pinned));
    dom.btnPin.title = s.pinned ? 'Unpin this session' : 'Pin this session to the top';
    dom.btnArchive.classList.toggle('on', !!s.archived);
    dom.btnArchive.title = s.archived ? 'Restore from archive' : 'Archive this session';
    dom.btnDelete.title = `Delete “${clip(s.title, 40)}” permanently`;
    dom.btnChecklist.classList.toggle('on', state.checklist.on);
    dom.btnChecklist.setAttribute('aria-pressed', String(state.checklist.on));
    dom.btnChecklist.title = state.checklist.on
        ? 'Hide this session’s task list' : 'This session’s own task list';
    dom.btnChanges.classList.toggle('on', state.changes.on);
    dom.btnChanges.setAttribute('aria-pressed', String(state.changes.on));
    dom.btnChanges.title = state.changes.on
        ? 'Hide what this session changed' : 'What this session changed';
    dom.btnFolder.title = `Show ${s.cwd} in File Explorer`;
    dom.btnTerm.title = keys.hint(
        dom.termPane.hidden ? `Open a terminal in ${s.cwd}` : 'Hide the terminal',
        'terminal.toggle');
}

// A session transcript and a subagent transcript render identically — they
// differ only in which nodes they own and which pane they live in. A view is
// that difference, so everything below can be written once.

export const SESSION_VIEW = {
    isAgent: false,
    nodes: state.nodes, tools: state.tools, plans: state.plans,
    get log() { return dom.log; },
    get scroll() { return dom.scroll; },
    // A getter, not the array: the run is emptied in place at four different
    // places, and a copy taken here would go stale at every one of them.
    get run() { return state.run; },
};

export const AGENT_VIEW = {
    isAgent: true,
    nodes: state.agentNodes, tools: state.agentTools,
    get log() { return dom.agentLog; },
    get scroll() { return dom.agentScroll; },
    get run() { return state.agentRun; },
};

// `live` marks events arriving on the tail rather than history being drawn. The
// only thing it changes is whether a new suggested follow-up schedules a refetch:
// openSession loads the panel from the bridge itself, straight after this, so
// asking again 1.2s later would be the same answer twice.
export function appendEvents(events, view = SESSION_VIEW, { live = false } = {}) {
    let frag = document.createDocumentFragment();
    // Closing a run wraps nodes that are already in the log around nodes that
    // are still in this fragment, so the fragment goes in first. Cheap: it
    // happens once per message, not once per event.
    const flush = () => {
        if (frag.childNodes.length) view.log.append(frag);
        frag = document.createDocumentFragment();
    };
    let newTurn = false;
    let newMark = false;
    let sawAgent = false;
    let newTasks = false;
    for (const ev of events) {
        if (ev.kind === 'tool-result') { patchTool(ev, view); continue; }
        // A suggested follow-up is not part of the conversation, it is an offer
        // about it — so it comes out here and is drawn in the aside instead.
        // Taken from either view: a subagent that suggests something has
        // suggested it to this session, and the panel is the session's.
        //
        // The panel's source is the bridge — see loadTasks — so this only fills
        // the gap in front of it. The index rescan is 500ms behind the file
        // watch and falls back to a 30s poll, and a card you are waiting for
        // must not be missing for either of those. The row and the event are the
        // same object from the same parse, so showing it early costs nothing and
        // the refetch below reconciles.
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
            if (view.plans && ev.name === 'ExitPlanMode') view.plans.add(ev.id);
            // A plan or a question is a rail marker as much as a message is.
            if (REVIEWABLE[ev.name]) newMark = true;
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
    if (newTasks) { renderTasks(); if (live) loadTasksSoon(); }
    if (!view.isAgent) {
        // Waiting for the next message to redraw would leave a plan's marker
        // missing for the whole of the work it authorised, which is the longest
        // gap in the session.
        if (newTurn || newMark) renderTurns();
        // A Task call that has only just appeared belongs on the strip now, not
        // after the next poll.
        if (sawAgent) { renderAgents(); loadAgents(); }
    }
    markFindDirty();
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
    // The searchable text is memoised off this object, and a result is often the
    // half worth searching.
    state.find.text.delete(findKey(view.isAgent ? state.agent : null, entry.ev.id));
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
    // A plan approved or a question answered changes what its tick says, and the
    // tick is the only place that outcome shows without opening anything.
    //
    // It is also the one thing here that *must* redraw rather than merely
    // wanting to. The swap above replaces `entry.node`, and the rail holds its
    // own list of those nodes — so without this the marker would point at a node
    // that is no longer in the document, markActiveTurn would measure it, and
    // "show it in the transcript" would scroll nowhere. Rebuilding reads the
    // fresh node back out of `view.nodes`, which is why it happens after the
    // `set` above and not before. Gated on the name because the rail is rebuilt
    // whole and a busy turn lands a tool result several times a second.
    if (!view.isAgent && REVIEWABLE[entry.ev.name]) {
        renderTurns();
        // And if that ask is the one on screen, it is now out of date too.
        if (state.review.evId === entry.ev.id) paintReview();
    }
    markFindDirty();
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
export function isBusy() {
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
export function closeRun(view) {
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
    markFindDirty();
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

    const runDate = dateOf(evs[0].ts);

    det.querySelector(':scope > summary').replaceChildren(
        el('div', { class: 'ev ev-trun' },
            // The clock is the row's, not the reader's: a screen reader
            // announcing it inside the button's label would be reading out the
            // gutter it is already skipping everywhere else.
            el('div', { class: 'ev-time', 'aria-hidden': 'true' },
                runDate ? el('span', { class: 'ev-date' }, runDate) : null,
                el('span', { class: 'ev-clock' }, clockOf(evs[0].ts)),
            ),
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
