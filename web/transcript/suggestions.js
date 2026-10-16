// Suggested follow-ups: the panel of tasks the conversation raised, the dialog
// that shows one at a readable width, and starting or dismissing one.
//
// The list, `#tasks-list`, and the dialog's action row, `#task-dlg-acts`, are
// drawn with Preact the way web/rail.js draws the rail. Both re-render on the
// suggestions push and on every decision, and a rebuild folded the card you had
// open, dropped the hover, and swallowed a click on a button that was replaced
// between mousedown and mouseup. Cards are keyed by the task's tool_use id. A
// card's `open` comes from `state.taskOpen`, which its `toggle` keeps in step,
// so a render never fights what you did with the caret. The Start button's
// "Starting" is `state.taskStarting` rather than a write to the button — which
// also means the card and the dialog say it together. Everything else in the
// dialog (title, why, the rendered prompt, cwd) and the counts and strip are
// outside the render containers and stay hand-written.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { get, post } from '../api.js';
import { html, render } from '../vendor/preact.js';
import { dom, closeModal, openModal, toast } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { state } from '../state.js';
import { openNew } from '../new-session/dialog.js';
import { openSession, openSessionSoon } from './conversation.js';
import { slidePane, syncPaneInsets } from './layout.js';

// ── suggested follow-ups ─────────────────────────────────────────────────
//
// Work an agent noticed and did not do, drawn beside the conversation rather
// than in it.
//
// The agent files these through a tool this app gives it (bridge/mcp.js),
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
// collapses on its own too, and every one of them starts folded — the panel is
// for seeing what is on offer, and a prompt written to brief an agent with none
// of your context runs to paragraphs, so a single open body fills the column.
// Opening one, or the ⤢ dialog, is how you read it.

/** The whole aside, rebuilt from state.tasks. Cheap: there are never many. */
export function renderTasks() {
    // In the order they were raised, oldest first, which is how the aside has
    // always read. Sorted rather than left to insertion order: the panel's rows
    // now come from /api/suggestions, which answers newest-first because that is
    // what a list spanning every session wants, and a card arriving on the tail
    // is merged in beside them.
    const tasks = [...state.tasks.values()]
        .sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
    // `tasksPending` holds an already-open aside in place while the new
    // conversation's suggestions are still being fetched, for the reason
    // renderChecklist gives: leaving the row and coming back a moment later is
    // what switching between two conversations used to look like.
    const present = tasks.length > 0 || state.tasksPending;
    slidePane(dom.tasks, present);
    if (!tasks.length) {
        render(null, dom.tasksList);
        dom.tasksCount.textContent = present ? '…' : '';
        dom.tasksStripCount.textContent = present ? '…' : '';
        return;
    }

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

    render(tasks.map(taskCard), dom.tasksList);
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
    // Folded unless you opened it yourself, and then only until you leave the
    // conversation. `acted` is still wanted below for the tint.
    const open = state.taskOpen.get(ev.id) === true;

    // A button inside the summary, which is legal and works — but the click has
    // to be stopped, or it reaches the summary and folds the card at the same
    // moment the dialog opens over it.
    //
    // The prompt in full. It is the thing being offered and the only way to
    // judge the offer; a preview would mean starting a session on a message you
    // have not read.
    //
    // The cwd only when it is somewhere other than where this conversation is
    // happening. Almost every task runs in the session's own directory, and
    // repeating that path down the panel is three lines of noise saying nothing
    // — but a task pointed at a *different* checkout is worth knowing about
    // before you start it.
    const elsewhere = ev.cwd && ev.cwd !== (state.current && state.current.cwd);
    return html`<details key=${ev.id} class="task"
        data-status=${acted ? acted.status : 'open'} data-task=${ev.id} open=${open}
        onToggle=${(e) => state.taskOpen.set(ev.id, e.currentTarget.open)}>
        <summary><span class="caret">▶</span><span class="task-name">${
            ev.title || firstLine(ev.prompt)}</span><button class="task-open" type="button"
            title="Read this at full width" aria-label="Read this at full width"
            onClick=${(e) => { e.preventDefault(); e.stopPropagation(); openTaskDialog(ev); }}
            >⤢</button></summary>
        <div class="task-body">
            ${ev.why ? html`<div class="task-why">${ev.why}</div>` : null}
            <div class="task-prompt prose"
                dangerouslySetInnerHTML=${{ __html: renderMarkdown(ev.prompt) }}></div>
            ${elsewhere ? html`<div class="task-cwd">${ev.cwd}</div>` : null}
            ${taskActions(ev)}
        </div>
    </details>`;
}

/**
 * What you can do about a task: the same three buttons wherever it is shown.
 *
 * A fresh vnode for each place rather than one set of nodes moved between the
 * card and the dialog, so the two can be on screen at once and neither steals
 * the other's controls.
 */
function taskActions(ev) {
    const acted = state.suggestions.get(ev.id) || null;
    const openIt = () => { closeTaskDialog(); openSession(acted.startedId); };
    const linky = (label, onClick) =>
        html`<button class="linky" type="button" onClick=${onClick}>${label}</button>`;

    // "offer again" is an undo, because a task that has gone quiet with no way
    // back is a task that lies once the session it names has been deleted.
    if (acted && acted.status === 'started') {
        return html`<div class="task-done">
            <span>Started</span>
            ${acted.startedId ? linky('open it', openIt) : null}
            ${linky('offer again', () => actOnSuggestion(ev, null))}
        </div>`;
    }
    // Said by whoever did the work, usually an agent through `set_task_status`,
    // with a note that is most often the pull request. A URL is made a link and
    // anything else is shown as text: the note came off an agent, not a person.
    if (acted && acted.status === 'completed') {
        const note = acted.note || '';
        const url = /^https?:\/\/\S+$/.test(note) ? note : null;
        return html`<div class="task-done">
            <span>Done</span>
            ${url ? html`<a class="linky" href=${url} target="_blank" rel="noopener">${url}</a>`
                : (note ? html`<span>${note}</span>` : null)}
            ${acted.startedId ? linky('open it', openIt) : null}
            ${linky('offer again', () => actOnSuggestion(ev, null))}
        </div>`;
    }
    if (acted && acted.status === 'dismissed') {
        return html`<div class="task-done">
            <span>Dismissed</span>
            ${acted.note ? html`<span>${acted.note}</span>` : null}
            ${linky('undo', () => actOnSuggestion(ev, null))}
        </div>`;
    }
    const starting = state.taskStarting.has(ev.id);
    return html`<div class="task-btns">
        <button class="more-btn primary" type="button" disabled=${starting}
            onClick=${() => startSuggestion(ev)}>${starting ? 'Starting' : 'Start'}</button>
        <button class="more-btn" type="button"
            onClick=${() => { closeTaskDialog(); openNew({ cwd: ev.cwd || '', prompt: ev.prompt }); }}
            >Edit first</button>
        <button class="more-btn" type="button"
            onClick=${() => actOnSuggestion(ev, 'dismissed')}>Dismiss</button>
    </div>`;
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
export function openTaskDialog(ev) {
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
    openModal(dom.taskScrim);
    dom.taskDlgCopy.focus();
}

/** Rebuild just the buttons, for a decision taken while the dialog is open. */
function paintTaskDialogActions(ev) {
    render(taskActions(ev), dom.taskDlgActs);
}

export function closeTaskDialog() {
    if (dom.taskScrim.hidden) return;
    closeModal(dom.taskScrim);
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
export async function startSuggestion(ev) {
    const sessionId = taskSessionId(ev);
    if (!sessionId || state.taskStarting.has(ev.id)) return;
    // Held in state rather than written to the button, which Preact owns: the
    // card and the dialog both say "Starting", and a render mid-request keeps it.
    state.taskStarting.add(ev.id);
    paintStarting(ev);
    try {
        // One call that starts the session *and* records it, so a failure
        // cannot leave the task offered beside the session already doing it —
        // the route's comment in bridge/server.js has the rest.
        const r = await post(`/api/suggestions/${sessionId}/${ev.id}/start`, {
            cwd: ev.cwd || (state.current && state.current.cwd),
            // Only used when the bridge has not indexed the task yet.
            prompt: ev.prompt,
            permissionMode: 'plan',
            // A task raised inside a test session is scratch work too. The
            // bridge knows that from the source session's flag; this covers a
            // suggestion event read off a tail before the index has the flag.
            test: state.dev && !!(ev.session ? ev.session.test
                : (state.current && state.current.test)),
        });
        state.suggestions.set(ev.id, {
            status: 'started', startedId: r.sessionId, via: 'session', at: Date.now(),
        });
        state.taskOpen.delete(ev.id);
        state.taskStarting.delete(ev.id);
        renderTasks();
        closeTaskDialog();
        toast('Session started.', 'ok');
        openSessionSoon(r.sessionId);
    } catch (err) {
        state.taskStarting.delete(ev.id);
        paintStarting(ev);
        toast(`Could not start it: ${err.message}`, 'error');
    }
}

/** Redraw both places a task's Start button can be. */
function paintStarting(ev) {
    renderTasks();
    if (state.taskDialog === ev.id) paintTaskDialogActions(ev);
}

/**
 * Which conversation a task belongs to.
 *
 * A row from `GET /api/suggestions` names its own session, and that is the whole
 * reason the task board can act on a task raised in a conversation nobody has
 * open. A `suggestion` event off the transcript tail carries no `sessionId`,
 * because it could only ever have come from the session being read.
 */
const taskSessionId = (ev) =>
    ev.sessionId || (state.current && state.current.sessionId) || null;

/**
 * Record what happened to a task, and redraw the panel.
 *
 * `status` of null undoes — the task goes back to offering itself. Optimistic,
 * then put back if the bridge refuses, because these are single clicks on
 * something already on screen and a round trip before anything moves reads as a
 * dead button.
 */
export async function actOnSuggestion(ev, status, startedId = null) {
    const sessionId = taskSessionId(ev);
    if (!sessionId) return;
    const before = state.suggestions.get(ev.id) || null;

    if (status) state.suggestions.set(ev.id, { status, startedId, at: Date.now() });
    else state.suggestions.delete(ev.id);
    // Deciding about a task is also finishing with it, so a card you had opened
    // folds away. Dropped rather than set false so it goes back to the default,
    // which is the one place the remembered state would be actively unhelpful.
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
export function firstLine(text, max = 70) {
    const line = String(text || '').split('\n').find(l => l.trim()) || '';
    return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Put the panel away, or bring it back. Remembered across sessions. */
export function showTasks(on) {
    state.tasksShut = !on;
    localStorage.setItem('tasksShut', state.tasksShut ? '1' : '0');
    renderTasks();
    syncPaneInsets();   // this frame, so the composer starts moving with it
    // Focus follows the thing that replaced what was clicked, so the keyboard
    // does not land on the body after either direction.
    (state.tasksShut ? dom.tasksStrip : dom.tasksCollapse).focus();
}

// ── refetching the follow-ups ────────────────────────────────────────────

/**
 * The suggested follow-ups raised in the open conversation.
 *
 * From the bridge rather than from the event stream, which is what lets a task
 * be answered without the transcript it lives in being parsed here. It is the
 * same index /api/suggestions answers about every session with; this asks it for
 * one, so the panel and a cross-session view read the same rows through the same
 * code. Scoped to the open conversation deliberately — a list of everything
 * outstanding is a place of its own, not a longer aside.
 */
export async function loadTasks() {
    if (!state.current) return;
    const id = state.current.sessionId;
    try {
        const { suggestions } = await get(`/api/suggestions?session=${id}`);
        if (!state.current || state.current.sessionId !== id) return;
        const next = new Map((suggestions || []).map(t => [t.id, t]));
        // A card the tail brought in that the rescan has not reached yet stays.
        // Replacing the map outright would take it away again and put it back a
        // rescan later, which is a card blinking out of the aside while somebody
        // is reading it. The bridge wins for everything it does know about.
        for (const [tid, task] of state.tasks) if (!next.has(tid)) next.set(tid, task);
        state.tasks = next;
        state.tasksPending = false;
        renderTasks();
    } catch {
        // The cards already showing came off the transcript tail and are still
        // true. Interrupting somebody over a panel that is merely not fresher
        // than it was would be worse than the staleness.
        //
        // But the aside must not be left holding its place for ever on the
        // strength of a request that failed, so the hold ends either way and the
        // column settles to whatever there actually is.
        state.tasksPending = false;
        renderTasks();
    }
}

// Coalesced, because a turn can file several offers in a row and the rescan they
// are waiting on is debounced anyway — one refetch shortly after the last of
// them is the whole need.
let taskLoadTimer = null;
export function loadTasksSoon() {
    if (taskLoadTimer) return;
    taskLoadTimer = setTimeout(() => { taskLoadTimer = null; loadTasks(); }, 1200);
}
