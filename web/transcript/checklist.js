// The session's own task list — the column on the left of the transcript that
// the agent keeps with TodoWrite or TaskCreate/TaskUpdate.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { dom, el, toast } from '../dom.js';
import { state } from '../state.js';
import { taskBar } from '../app.js';
import { renderHeaderActions } from './conversation.js';
import { paneUp, slidePane, syncPaneInsets } from './layout.js';
import { jumpToTurn } from './turn-rail.js';

// ── the session's own task list ────────────────────────────────────────────
//
// The list the agent keeps for itself, on the left of the transcript. Nothing
// here fetches: the bridge pushes `task-list` on the same follow the transcript
// arrives on, because the list moves *during* a turn and that is the only time
// anybody is watching it. So there is no stale window, no loading state and no
// refresh button — the three things the changes drawer above needs.
//
// Ids and classes say `checklist` while the panel says "Tasks", because `tasks`
// in app.js already meant suggested follow-ups (see suggestions.js).

/** `✓`, `▸` or `○`. Shared with todoView, so the transcript and the panel agree. */
export function statusMark(status) {
    return status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○';
}

/** Put the panel in the layout, or take it out. Remembered across sessions. */
export function showChecklist(on) {
    state.checklist.on = on;
    localStorage.setItem('checklistOn', on ? '1' : '0');
    // Asking for it from the header means wanting to see it, not wanting a 34px
    // strip — the same promise the Changed button makes.
    if (on) collapseChecklist(false, { render: false });
    renderChecklist();   // slidePane inside it moves the column and the composer
    renderHeaderActions();
}

/** Collapse it to its strip, or bring it back. */
export function collapseChecklist(shut, { render = true } = {}) {
    state.checklist.shut = shut;
    localStorage.setItem('checklistShut', shut ? '1' : '0');
    if (!render) return;
    renderChecklist();
    // In this frame, not the next one. This is the one direction that animates —
    // a panel coming *back* into the layout starts at its full width and has
    // nothing to animate — and the composer's transition has to start on the
    // same frame as the column's or it spends the animation a frame behind. The
    // observer would get here eventually, and eventually is what that looks like.
    syncPaneInsets();
    // Focus follows whatever replaced the thing that was clicked.
    (shut ? dom.checklistStrip : dom.checklistCollapse).focus();
}

/** Forget what is on screen — the conversation it was about has changed. */
export function resetChecklist() {
    state.checklist.data = null;
    state.checklist.sessionId = null;
    // Hold the column's place while the new conversation's list is on the wire,
    // but only if there is a column there to hold: setting this for a column
    // that is down would slide an empty one in and straight back out. Cleared by
    // the `task-list` handler, which the bridge sends the moment a session is
    // followed — including for a session with no list, which is what takes the
    // column back out.
    state.checklist.pending = paneUp(dom.checklist);
}

/**
 * The call that last touched this item, or null.
 *
 * One backwards walk over the tools in this conversation, first hit wins — which
 * *is* "last touched", because a TaskUpdate always follows its TaskCreate in
 * document order, so no preference rule is needed on top of the order.
 *
 * The three clauses are the three ways an item can be reached, and they are not
 * symmetrical. `TaskUpdate` carries `taskId`, so it matches by id. `TaskCreate`
 * carries no id at all — only `{subject, description, activeForm}` — so it can
 * only be matched by subject, which is why the bridge sends `subject` as one
 * field rather than leaving the client to pick between four. And a TodoWrite
 * list came from exactly one call which rewrote every item in it, so that call
 * is the answer for any item without matching anything.
 *
 * Resolved here rather than sent by the bridge on purpose: on the directory path
 * the bridge never opens the transcript, so supplying an event id would mean a
 * transcript scan every 400ms to produce something this page already holds
 * indexed by tool_use id.
 */
function callForTask(item) {
    const entries = [...state.tools.values()];
    for (let n = entries.length - 1; n >= 0; n--) {
        const ev = entries[n].ev;
        const input = ev.input || {};
        if (ev.name === 'TaskUpdate' && item.id && String(input.taskId) === item.id) {
            return entries[n];
        }
        if (ev.name === 'TaskCreate' && input.subject && input.subject === item.subject) {
            return entries[n];
        }
        if (ev.name === 'TodoWrite') return entries[n];
    }
    return null;
}

/** One task. Clicking jumps to the call that last touched it. */
function checklistRow(item) {
    const entry = callForTask(item);

    // More than the description, the way an edit row's tooltip is more than the
    // path. Left off entirely when it would only repeat the line already on
    // screen — a todo-sourced item has no description, and a tooltip that says
    // what you can already read is noise.
    const extra = [item.description,
        item.status === 'in_progress' && item.activeForm,
        item.blockedBy.length && `blocked by ${item.blockedBy.join(', ')}`,
    ].filter(Boolean);
    const tip = extra.length ? [item.subject, ...extra].join('\n\n') : null;

    return el('li', {},
        el('button', {
            // A button either way. An item nothing matches yet may match later
            // once the call lands, and a row that is sometimes a button is worse
            // than one that always is and sometimes says why not.
            class: `cl-row${entry ? '' : ' flat'}`,
            type: 'button',
            'data-status': item.status,
            ...(tip ? { title: tip, 'data-desc': item.description || '' } : {}),
            onclick: () => {
                if (entry) return jumpToTurn(entry);
                toast('No call in this conversation has touched that item.', 'warn');
            },
        },
        el('span', { class: 'cl-mark', 'aria-hidden': 'true' }, statusMark(item.status)),
        el('span', { class: 'cl-name' }, item.subject)));
}

/** The whole panel, rebuilt from state.checklist. Cheap: there are never many. */
export function renderChecklist() {
    const d = state.checklist.data;
    const items = (d && d.items) || [];

    // Off, no conversation, or a session that never kept a list: no box at all
    // rather than an empty one. Most sessions keep no list, and a permanently
    // empty column would be worse than no column.
    //
    // `pending` is the exception, and it is what makes switching between two
    // conversations that both keep a list move nothing at all. The new one's
    // list arrives a moment after the switch, and without this the column left
    // the row and came back — so it held its place while the answer was on the
    // wire, showing an empty box rather than the last conversation's tasks.
    // `resetChecklist` only sets it for a column that is already up, so this
    // never slides an empty column *in*.
    const present = !!state.checklist.on && !!state.current
        && (items.length > 0 || state.checklist.pending);
    slidePane(dom.checklist, present);
    if (!present || !items.length) {
        // Emptied rather than just hidden. The rows and the count belonged to
        // whichever session was here before, and a hidden panel holding another
        // conversation's list is the kind of thing that resurfaces later looking
        // like a bug in whatever reveals it.
        dom.checklistBody.replaceChildren();
        dom.checklistCount.textContent = present ? '…' : '';
        dom.checklistStripCount.textContent = present ? '…' : '';
        return;
    }

    const label = `${d.done}/${d.total}`;
    dom.checklistCount.textContent = label;
    dom.checklistStripCount.textContent = label;

    dom.checklistStrip.hidden = !state.checklist.shut;
    dom.checklistOpen.hidden = state.checklist.shut;
    dom.checklist.classList.toggle('shut', state.checklist.shut);
    if (state.checklist.shut) return;   // nothing behind the strip needs building

    const body = [taskBar(d)];
    // The step it is on, spelled out. `current` is the in-progress task's
    // activeForm, which is written for exactly this.
    if (d.current) body.push(el('div', { class: 'cl-current' }, d.current));
    body.push(el('ul', { class: 'cl-list' }, ...items.map(checklistRow)));
    // The cap is a bug somewhere else, but say so rather than showing a short
    // list as if it were the whole one.
    if (d.truncated) {
        body.push(el('div', { class: 'cl-note' },
            `and ${d.truncated} more not shown`));
    }
    dom.checklistBody.replaceChildren(...body);
}
