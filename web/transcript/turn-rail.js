// The turn rail down the right edge of the transcript, and revealing and
// flashing a row — which find, the checklist and the diff viewer also use to
// jump to something in the log.
//
// This imports app.js and sibling modules here, which import it back. That is
// safe only because nothing in this file reads an imported binding while the
// module is evaluating — every use is inside a function called later. Keep it
// that way: a top-level `const X = someImport(...)` runs before app.js's body
// and throws in the temporal dead zone, and only loading the page shows it.

import { dom, el } from '../dom.js';
import { clip, clockOf, dateOf } from '../format.js';
import { state } from '../state.js';
import { openContextMenu } from './context-menu.js';
import { SESSION_VIEW } from './conversation.js';
import { markOutcome, openReview } from './review.js';
import { toolSummary } from './tools.js';

// ── turn rail ────────────────────────────────────────────────────────────
// A tick per thing you said, down the right edge of the transcript, and one for
// each plan and each question — the other two moments the conversation stopped
// and waited for you. Hovering reads it back; clicking a message jumps to it and
// clicking a plan or a question opens it (see openReview). Built from the
// rendered log, so a session streaming in a terminal grows its rail as it goes.

/** The two tool calls that are a moment in the conversation rather than work. */
export const REVIEWABLE = { ExitPlanMode: 'plan', AskUserQuestion: 'question' };

export function turnText(ev) {
    if (ev.command) return `/${ev.command.name}${ev.command.args ? ' ' + ev.command.args : ''}`;
    return (ev.text || '').trim() || '(image only)';
}

/** Like clip(), but keeps line breaks — the popover renders them. */
export function clipLines(s, n) {
    const t = String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * Build the rail.
 *
 * Two lists come out of one walk, and keeping them apart is the point.
 * `state.turns` is still the messages and nothing else, because "Turn 3 of 12"
 * counts what *you said* and markActiveTurn binary-searches it — a plan in that
 * list would renumber every turn after it and mean the search was answering a
 * different question from the one it is asked. `marks` is everything in the
 * rail, in document order, which is the order `state.nodes` is already in.
 *
 * `state.turnTicks` is the third thing and exists because of the same split:
 * markActiveTurn used to index `dom.turns.children` by turn number, which stops
 * being true the moment anything that is not a turn is in the column.
 */
export function renderTurns() {
    state.turns = [];
    state.turnTicks = [];
    const marks = [];
    for (const entry of state.nodes.values()) {
        const ev = entry.ev;
        if (ev.kind === 'user') {
            state.turns.push(entry);
            marks.push({ entry, kind: 'turn', no: state.turns.length });
        } else if (ev.kind === 'tool' && REVIEWABLE[ev.name]) {
            marks.push({ entry, kind: REVIEWABLE[ev.name] });
        }
    }
    state.activeTurn = -1;

    const total = state.turns.length;
    dom.turns.replaceChildren(...marks.map((m) => {
        const ev = m.entry.ev;
        const turn = m.kind === 'turn';
        const tick = el('button', {
            class: 'turn-tick',
            type: 'button',
            // Both only ever set for a plan or a question. A message is the
            // rail's default and stays unmarked, so every `[data-kind]` rule in
            // the stylesheet is about the two new kinds and cannot reach a turn
            // tick by accident — which a `data-kind="turn"` would have let it.
            'data-kind': turn ? null : m.kind,
            'data-status': turn ? null : (ev.status || 'pending'),
            'aria-label': turn
                ? `Turn ${m.no} of ${total}: ${clip(turnText(ev), 60)}`
                : `${m.kind === 'plan' ? 'Plan' : 'Question'}, ${markOutcome(ev)}: `
                    + clip(toolSummary(ev) || '', 60),
            onclick: () => (turn ? jumpToTurn(m.entry) : openReview(ev.id)),
            onmouseenter: (e) => showTurnPop(e.currentTarget, m),
            onmouseleave: hideTurnPop,
            onfocus: (e) => showTurnPop(e.currentTarget, m),
            onblur: hideTurnPop,
        });
        // A message's tick does what its menu would say, so it does not get one:
        // a single-item menu offering the click you just made is noise.
        if (!turn) tick.oncontextmenu = (e) => openMarkMenu(e, m);
        if (turn) state.turnTicks.push(tick);
        return tick;
    }));
    // Now it is known whether this conversation has a rail at all, so the hold
    // from beginOpen can go: with turns the class changes nothing, and without
    // them `.turns:empty` takes the column out and the composer widens into it.
    dom.turns.classList.remove('holding');
    markActiveTurn();
}

/** Right-clicking a plan or a question: read it here, or go to it in the log. */
function openMarkMenu(e, m) {
    e.preventDefault();
    const what = m.kind === 'plan' ? 'plan' : 'question';
    openContextMenu(e, [
        { label: `Open the ${what}`, onClick: () => openReview(m.entry.ev.id) },
        { label: 'Show it in the transcript', onClick: () => jumpToTurn(m.entry) },
    ]);
}

function showTurnPop(tick, m) {
    if (!m || !m.entry) return;
    const ev = m.entry.ev;
    const pop = dom.turnPop;
    const turn = m.kind === 'turn';
    const isCmd = turn && Boolean(ev.command);

    // `toolSummary` for the two new kinds rather than a second extraction: it
    // already reduces a plan to its first heading and a question set to its
    // headers, and it is what the collapsed transcript row says — so the rail
    // and the row cannot end up calling the same thing two different things.
    const head = turn ? `Turn ${m.no} of ${state.turns.length}`
        : `${m.kind === 'plan' ? 'Plan' : 'Question'} · ${markOutcome(ev)}`;
    const body = turn ? turnText(ev) : (toolSummary(ev) || '');

    pop.replaceChildren(
        el('div', { class: 'pop-head' },
            el('span', {}, head),
            el('span', { class: 'when' }, `${dateOf(ev.ts)} ${clockOf(ev.ts)}`.trim()),
        ),
        el('div', { class: 'pop-text' + (isCmd ? ' cmd' : '') }, clipLines(body, 460)),
    );
    pop.hidden = false;

    // Sits to the left of the rail, centred on its tick, kept on screen.
    const r = tick.getBoundingClientRect();
    const h = pop.offsetHeight;
    pop.style.top = `${Math.min(Math.max(8, r.top + r.height / 2 - h / 2),
        Math.max(8, window.innerHeight - h - 8))}px`;
    pop.style.left = `${Math.max(8, r.left - pop.offsetWidth - 10)}px`;
}

export function hideTurnPop() {
    dom.turnPop.hidden = true;
}

export function jumpToTurn(t) {
    hideTurnPop();
    revealNode(t.node);
}

/**
 * Scroll a row of the transcript into view and say so.
 *
 * Everything that jumps somewhere goes through here — a turn tick, the
 * notification history, an edited message, a search hit — because the awkward
 * parts are the same every time and were not, before this was one function.
 *
 * `range` aims at a match inside the row rather than at the row: a hit 300 lines
 * into a Bash stdout is inside `.io`, which stops at 420px and scrolls on its
 * own, and a long diff line is inside a horizontal scroller. Moving `view.scroll`
 * alone lands on the `pre` with the match still off its edge, and `Range` has no
 * `scrollIntoView` of its own, so each scrollable ancestor is centred first.
 *
 * `instant` is for stepping: `.scroll` is `scroll-behavior: smooth`, so holding
 * Enter down through thirty matches otherwise queues thirty interrupted
 * animations and arrives nowhere. A single jump stays smooth.
 */
export function revealNode(node, { view = SESSION_VIEW, range = null,
    instant = false, flash = true } = {}) {
    const sc = view.scroll;
    // A row inside a folded run has no box to measure, so the jump would land
    // near the top of the pane instead of on it. Turns are never in a fold —
    // a message is what ends one — but the notification history jumps to tool
    // calls, and those are exactly what folds.
    const fold = node.closest('.trun');
    if (fold) fold.open = true;

    if (range) scrollInnerTo(range, sc);
    const r = range ? range.getBoundingClientRect() : node.getBoundingClientRect();
    // A zero rect means no layout to aim at — the row is in the pane that is
    // currently hidden, or inside something still shut. Scrolling on that
    // measurement lands at the top of the transcript, which is worse than
    // staying put, so leave the scroll alone and let the flash do the work.
    if (r.height || r.width) {
        const box = sc.getBoundingClientRect();
        // A match is put a third of the way down, where the eye already is; a
        // whole row is put at the top, because the rest of it is what you want.
        const pad = range ? Math.max(40, box.height / 3) : 14;
        setScrollTop(sc, Math.max(0, sc.scrollTop + r.top - box.top - pad), instant);
    }
    if (view === SESSION_VIEW) state.pinned = false;
    if (flash) flashNode(node);
}

function setScrollTop(sc, top, instant) {
    if (!instant) { sc.scrollTop = top; return; }
    const prev = sc.style.scrollBehavior;
    sc.style.scrollBehavior = 'auto';
    sc.scrollTop = top;
    sc.style.scrollBehavior = prev;
}

/**
 * Centre a range inside every box between it and the pane that scrolls.
 *
 * Innermost outwards, re-measuring after each step: moving an outer box changes
 * where the range is, so a rect taken once and reused would be wrong by the
 * second box. Two or three forced layouts, once per keypress and never in a
 * loop.
 */
function scrollInnerTo(range, outer) {
    const boxes = [];
    for (let n = range.commonAncestorContainer; n && n !== outer; n = n.parentNode) {
        if (n.nodeType !== 1) continue;
        const y = n.scrollHeight > n.clientHeight + 1;
        const x = n.scrollWidth > n.clientWidth + 1;
        if (y || x) boxes.push({ n, y, x });
    }
    for (const { n, y, x } of boxes) {
        const r = range.getBoundingClientRect();
        if (!r.height && !r.width) return;
        const b = n.getBoundingClientRect();
        if (y) n.scrollTop += (r.top - b.top) - (b.height - r.height) / 2;
        if (x) n.scrollLeft += (r.left - b.left) - (b.width - r.width) / 2;
    }
}

export function flashNode(node) {
    node.classList.remove('flash');
    void node.offsetWidth;      // restart the animation when the same row is picked twice
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1400);
}

/**
 * Whichever turn the transcript is currently sitting in.
 *
 * Binary search rather than a walk from the top. The turns are in document
 * order, so "is this one above the edge" is monotonic, and the walk broke only
 * at the first turn *below* the viewport — meaning it measured every turn above
 * it. At the bottom of a long session that was one `getBoundingClientRect` per
 * turn, each a forced layout of the whole transcript, on every scroll event.
 * This is a fixed handful of measurements however long the session gets.
 */
export function markActiveTurn() {
    if (!state.turns.length) return;
    const edge = dom.scroll.getBoundingClientRect().top + 60;
    let lo = 0;
    let hi = state.turns.length - 1;
    let active = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (state.turns[mid].node.getBoundingClientRect().top > edge) {
            hi = mid - 1;
        } else {
            active = mid;
            lo = mid + 1;
        }
    }
    if (active === state.activeTurn) return;
    state.activeTurn = active;

    // state.turnTicks and not dom.turns.children: the rail also holds plan and
    // question markers, so the nth child stopped being the nth turn.
    const ticks = state.turnTicks;
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
