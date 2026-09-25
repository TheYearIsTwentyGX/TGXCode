// The send queue: messages typed while a turn is running, drawn as chips above
// the composer, which can be reordered, edited back into the box or dropped.
// Moved out of app.js as it was. What is queued is the bridge's — see
// bridge/runner.js's `inFlight` — and this only draws it and asks it to change.
// wireQueue() binds the list's listeners and is called by app.js where they ran.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { del, get, post } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { clip } from '../format.js';
import { state } from '../state.js';
import { applyRunner, restoreToComposer } from '../app.js';
import { sendMessage } from './send.js';

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
export function applyQueue(s) {
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


/** The list's own listeners, called by app.js where they always ran. */
export function wireQueue() {
    dom.queueClear.addEventListener('click', clearQueue);
    dom.queueList.addEventListener('dragover', onQueueDragOver);
    // Without this the browser treats the list as a non-target and the drag snaps
    // back instead of dropping.
    dom.queueList.addEventListener('drop', (e) => e.preventDefault());
}
