// The send queue: messages typed while a turn is running, drawn as chips above
// the composer, which can be reordered, edited back into the box or dropped.
// What is queued is the bridge's — see bridge/runner.js's `inFlight` — and this
// only draws it and asks it to change. wireQueue() binds the list's listeners and
// is called by app.js where they ran.
//
// **Drawn with Preact**, the way web/rail.js settled. `runner-status` arrives
// every time the activity line moves, several times a turn, and the hand-built
// list answered by emptying #queue-list and building every chip again — which
// lost the focus a keyboard user was on, the hover under the cursor and any click
// that straddled the rebuild, and needed a signature gate, a "the drag owns the
// DOM" early return and a focus re-finder to get away with it. Chips are keyed by
// queue id, so a render keeps their nodes. Markup and class names are what el()
// built, so the CSS did not change. What it decided:
//
//   - **The roving tab stop is rendered, not written.** `state.queueFocus` names
//     the chip holding it and the render gives that one `tabindex="0"`; focusing
//     a chip updates the state and renders again.
//   - **A drag goes through the render.** `state.queueDrag` is `{id, order}`, the
//     shape of `state.railDrag`: dragover works out the order the cursor has
//     reached, stores it, and renders — so a status push mid-drag redraws with the
//     carried chip still where the pointer put it, and the carried node is the same
//     node throughout, which keeps the browser's drag alive. The bridge is told
//     once, on drop, from that order rather than from the DOM.
//   - **Morph and flip only when the queue changed.** morph() stops whatever is
//     playing on #queue, so wrapping every status push in it would cut a grow off
//     half-way. `state.queueSig` decides when a render is worth animating; the
//     rest render plainly, which is a no-op when nothing changed.
//   - **Focus is still put back after a reorder.** Chromium 126 has no
//     `moveBefore`, so a chip Preact moves (Alt+↑/↓) loses focus. The restore only
//     calls focus(); it writes nothing to the nodes.
//
// Imports app.js and its siblings, which import it back. That is safe only
// because nothing here reads an imported binding while the module evaluates —
// every use is inside a function called later. Keep it that way: a top-level
// `const X = someImport(...)` runs before app.js's body and throws in the
// temporal dead zone, and only loading the page shows it. state.js, dom.js,
// api.js, boot.js and format.js import nothing, and icons.js only dom.js, so
// reading those at load is fine; nothing else here is.

import { html, render } from '../vendor/preact.js';
import { del, get, post } from '../api.js';
import { dom, toast } from '../dom.js';
import { clip } from '../format.js';
import { state } from '../state.js';
import { applyRunner, restoreToComposer } from '../app.js';
import { sendMessage } from './send.js';
import { flip, grow, morph } from '../motion.js';

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
    // Grown and shrunk, so the transcript above moves with it — see motion.js.
    // The chips stay in it while it closes and are cleared once it has.
    grow(dom.queue, show, { onGone: () => { if (!state.queue.length) render(null, dom.queueList); } });
    if (!show) {
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

    drawQueue();
}

/** Render the chips, animating only when what they show actually changed. */
function drawQueue() {
    const list = orderedQueue();
    const roving = rovingId();
    const tree = list.map((entry, i) => queueItem(entry, i, list.length, roving));

    // Mid-drag the order follows the pointer, and sliding behind it would lag.
    if (state.queueDrag) {
        render(tree, dom.queueList);
        return;
    }

    const sig = state.queue.map(x => x.id + (x.handed ? '*' : '')).join(',')
        + '|' + [...state.queueOpen].sort().join(',');
    if (sig === state.queueSig && dom.queueList.children.length === list.length) {
        render(tree, dom.queueList);
        return;
    }
    state.queueSig = sig;

    // Keep the keyboard where it was: reordering with Alt+arrows moves the very
    // chip being used, and a moved node loses focus.
    const active = document.activeElement;
    const held = active && active.closest && active.closest('.queue-item');
    const holdId = held && dom.queueList.contains(held) ? held.dataset.id : null;
    const holdPart = holdId ? active.dataset.part : null;

    // Chips that stay slide to their new places — a reorder, or the one above
    // them sent — and the box eases to its new height rather than jumping.
    morph(dom.queue, () => flip(dom.queueList, (n) => n.dataset.id,
        () => render(tree, dom.queueList)));

    if (holdId) {
        const back = chipNode(holdId);
        const target = back && (holdPart ? back.querySelector(`[data-part="${holdPart}"]`) : back);
        if (target && document.activeElement !== target) target.focus();
    }
}

/**
 * The queue in the order to draw it: the bridge's, or mid-drag the order the
 * pointer has reached — with anything sent meanwhile left out and anything queued
 * meanwhile on the end.
 */
function orderedQueue() {
    const order = state.queueDrag && state.queueDrag.order;
    if (!order) return state.queue;
    const byId = new Map(state.queue.map(x => [x.id, x]));
    return orderOf(order).map(id => byId.get(id));
}

function chipNode(id) {
    return dom.queueList.querySelector(`.queue-item[data-id="${CSS.escape(id)}"]`);
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

function focusChipAt(i) {
    const entry = orderedQueue()[i];
    if (!entry) return false;
    state.queueFocus = entry.id;
    drawQueue();
    const li = chipNode(entry.id);
    if (!li) return false;
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
function queueItem(entry, i, total, roving) {
    const files = entry.attachments || [];
    const open = state.queueOpen.has(entry.id);
    const toggleOpen = () => {
        if (open) state.queueOpen.delete(entry.id);
        else state.queueOpen.add(entry.id);
        renderQueue(state.runner);
    };

    // Handed to the running turn: its place is fixed, so there is nothing to drag.
    const handed = !!entry.handed;
    const dragging = !!state.queueDrag && state.queueDrag.id === entry.id;
    // The 📎 is a count, not the names. The chip is one line and the message is
    // what it is for; the point is only that Edit will bring files back with it,
    // so dropping this chip is dropping them too.
    const cls = 'queue-item' + (open ? ' open' : '') + (handed ? ' handed' : '')
        + (dragging ? ' dragging' : '');
    return html`<li key=${entry.id} class=${cls} data-id=${entry.id}
        draggable=${handed ? 'false' : 'true'}
        tabindex=${entry.id === roving ? '0' : '-1'}
        aria-label=${`${handed ? 'Message for the next step' : 'Waiting message'} `
            + `${i + 1} of ${total}: ${clip(entry.text, 80)}`}
        onFocus=${() => {
            if (state.queueFocus === entry.id) return;
            state.queueFocus = entry.id;
            drawQueue();
        }}
        onKeyDown=${(e) => onChipKey(e, entry, i, toggleOpen)}
        onDragStart=${(e) => onChipDragStart(e, entry)}
        onDragEnd=${onChipDragEnd}>
        ${handed
            ? html`<span class="queue-grip" title="Claude reads this after the current step">↳</span>`
            : html`<span class="queue-grip" title="Drag to reorder" aria-hidden="true">⠿</span>`}
        <span class="queue-n">${String(i + 1)}</span>
        ${files.length ? html`<span class="queue-files"
            title=${files.map(f => f.name || f.relPath).join('\n')}>${`📎${files.length > 1 ? files.length : ''}`}</span>` : null}
        <button class="queue-text" type="button" data-part="text" tabindex="-1"
            title=${open ? 'Show less' : 'Show the whole message'}
            onClick=${toggleOpen}>${open ? entry.text : clip(entry.text, 110)}</button>
        <div class="queue-acts">
            <button class="queue-act" type="button" data-part="edit" tabindex="-1"
                title="Take it out of the queue and back into the box"
                onClick=${() => editQueued(entry)}>Edit</button>
            <button class="queue-act danger" type="button" data-part="drop" tabindex="-1"
                title="Drop this message" aria-label=${`Drop waiting message ${i + 1}`}
                onClick=${() => dropQueued(entry)}>×</button>
        </div>
    </li>`;
}

function onChipDragStart(e, entry) {
    if (entry.handed) { e.preventDefault(); return; }
    state.queueDrag = { id: entry.id, order: null };
    e.dataTransfer.effectAllowed = 'move';
    // Firefox ignores a drag with nothing on the transfer.
    e.dataTransfer.setData('text/plain', entry.id);
    drawQueue();   // the chip takes `.dragging`
}

function onChipDragEnd() {
    const drag = state.queueDrag;
    state.queueDrag = null;
    const ids = drag && drag.order ? orderOf(drag.order) : null;
    const changed = ids && ids.join() !== state.queue.map(q => q.id).join();
    // The order just reached is the one to show until the bridge answers, so the
    // chip does not jump back for the length of the request.
    if (changed) {
        const byId = new Map(state.queue.map(x => [x.id, x]));
        state.queue = ids.map(id => byId.get(id));
    }
    renderQueue(state.runner);   // and the chip loses `.dragging`
    if (changed) commitQueueOrder(ids);
}

/** A drag order made whole: ids sent meanwhile out, ids queued meanwhile on the end. */
function orderOf(order) {
    const have = new Set(state.queue.map(x => x.id));
    const out = order.filter(id => have.has(id));
    for (const x of state.queue) if (!out.includes(x.id)) out.push(x.id);
    return out;
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
 * is the list you get. The positions are read off the chips and the order goes
 * into state; the render moves the node. Nothing renders unless the order the
 * pointer reached is a different one — dragover fires continuously.
 */
function onQueueDragOver(e) {
    if (!state.queueDrag) return;
    e.preventDefault();
    const chips = [...dom.queueList.querySelectorAll(':scope > .queue-item')];
    const dragged = chips.find(n => n.dataset.id === state.queueDrag.id);
    const over = e.target.closest && e.target.closest('.queue-item');
    if (!dragged || !over || over === dragged || !dom.queueList.contains(over)) return;
    const box = over.getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    const order = chips.filter(n => n !== dragged).map(n => n.dataset.id);
    order.splice(order.indexOf(over.dataset.id) + (after ? 1 : 0), 0, dragged.dataset.id);
    if (order.join('\n') === chips.map(n => n.dataset.id).join('\n')) return;
    state.queueDrag.order = order;
    drawQueue();
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
        state.queueFocus = id;
        drawQueue();
        const moved = chipNode(id);
        if (moved && document.activeElement !== moved) moved.focus();
    } catch (err) {
        toast(`Could not reorder the queue: ${err.message}`, 'error');
    }
}

/** Tell the bridge the order a drag ended on. state.queue already shows it. */
async function commitQueueOrder(ids) {
    if (!state.current) return;
    try {
        const r = await post(`/api/sessions/${state.current.sessionId}/queue/reorder`, { ids });
        applyRunner(r.status);
    } catch (err) {
        toast(`Could not reorder the queue: ${err.message}`, 'error');
        refreshQueue();   // back to what the bridge actually has
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
