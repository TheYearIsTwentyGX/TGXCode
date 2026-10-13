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
import { loadEarlier } from './earlier.js';
import { markOutcome, openReview } from './review.js';
import { toolSummary } from './tools.js';
import { ensureAttached, layoutTop } from './window.js';
import { present } from '../motion.js';
import { html, render, useState } from '../vendor/preact.js';
import { clusterMarks, placeMarks, PRIORITY, turnAt, viewBand } from './minimap-layout.js';

// ── the minimap ──────────────────────────────────────────────────────────
// The rail down the right edge of the transcript is a map of the whole session:
// a line per thing you said, and a mark for every plan, question, file edit,
// subagent, failed tool call and pull request, each placed by turn so the rail
// is the conversation end to end (see minimap-layout.js). A band shows where the
// transcript is scrolled to. Hovering reads a mark back; clicking goes there —
// a plan or a question opens it (see openReview), a pull request opens the PR,
// and the empty track jumps to the turn at that height, or scrubs while dragged.
//
// Built from the bridge's turn index, so it is whole even when only the end of a
// long session is loaded, and from the rendered log after that, so a session
// streaming in a terminal grows its marks as it goes.
//
// Drawn with Preact (CLAUDE.md §Preact): the marks change under the pointer
// while a turn streams, and keying them by id is what keeps the one you are
// hovering. The band is its own component with its own state, because it moves
// every scroll frame and nothing else does.

/** The two tool calls that are a moment in the conversation rather than work. */
export const REVIEWABLE = { ExitPlanMode: 'plan', AskUserQuestion: 'question' };
/** Calls marked for what they did. bridge/turn-index.js keeps the same list. */
export const WORK = {
    Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
    Task: 'subagent', Agent: 'subagent',
};
// A refusal is somebody saying no, not something breaking — as in the index.
const DECLINED_RE = /^(The user doesn't want to proceed|Stopped from TGXCode|\[Request interrupted|User rejected)/;

const NOUN = {
    turn: ['Turn', 'turns'], plan: ['Plan', 'plans'], question: ['Question', 'questions'],
    edit: ['Edit', 'edits'], subagent: ['Subagent', 'subagents'],
    error: ['Failure', 'failures'], pr: ['Pull request', 'pull requests'],
};

export function turnText(ev) {
    if (ev.command) return `/${ev.command.name}${ev.command.args ? ' ' + ev.command.args : ''}`;
    return (ev.text || '').trim() || '(image only)';
}

/** Like clip(), but keeps line breaks — the popover renders them. */
export function clipLines(s, n) {
    const t = String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const firstLine = (s) => String(s || '').trim().split('\n')[0];

// The rail's marks in document order, and the clusters drawn from them. Kept
// between renders so a scroll frame and a resize redraw without rebuilding.
let marks = [];
let clusters = [];
let railH = 0;
let setBand = null;
let resizer = null;

/**
 * Build the rail.
 *
 * `state.turns` is still the messages and nothing else, because "Turn 3 of 12"
 * counts what *you said*, markActiveTurn binary-searches it, and the branch
 * composer numbers by it. `marks` is everything on the rail, in document order,
 * which is the order `state.nodes` is already in.
 *
 * Every mark carries `entry` — what jumping to it reveals, `{ev, node}`, a
 * loaded row or a stand-in holding the index's copy (see materialize) — and
 * `ev`, what its tooltip reads.
 */
export function renderTurns() {
    state.turns = [];
    marks = [];
    const starts = [];
    const ordinal = new Map();
    const addTurn = (entry, id, at) => {
        state.turns.push(entry);
        ordinal.set(id, state.turns.length - 1);
        starts.push(at);
        marks.push({ key: id, kind: 'turn', entry, ev: entry.ev, turn: state.turns.length - 1,
            no: state.turns.length, at });
    };
    const add = (m) => marks.push(m);
    const standIn = (mark, id = mark.id) => ({ ev: { ...mark, id }, node: null, mark });

    // The index first: it is the whole conversation up to when it was opened.
    // A mark whose row is loaded uses the row's event, which is the live one —
    // a plan answered since has its outcome there. One that is not stands in
    // with the index's own copy and no node; see materialize.
    const seen = new Set();
    let cur = -1;
    for (const mark of state.turnIndex) {
        // A kind from a newer bridge than this page: nothing to draw it as.
        if (!NOUN[mark.kind]) continue;
        seen.add(mark.id);
        const at = typeof mark.at === 'number' ? mark.at : mark.offset;
        if (mark.kind === 'turn') {
            addTurn(state.nodes.get(mark.id) || standIn(mark), mark.id, mark.offset);
            cur = state.turns.length - 1;
            continue;
        }
        if (mark.kind === 'error' || mark.kind === 'pr') {
            // An error is shown on the call that failed; a PR has no row at all.
            const tool = mark.toolId && (state.nodes.get(mark.toolId) || standIn(mark, mark.toolId));
            add({ key: mark.id, kind: mark.kind, entry: tool || null, ev: mark, turn: cur, at });
            continue;
        }
        const entry = state.nodes.get(mark.id) || standIn(mark);
        add({ key: mark.id, kind: mark.kind, entry, ev: entry.ev, turn: cur, at });
    }

    // Then whatever arrived after it, in document order. A loaded stretch begins
    // at a turn, so the turn a live mark belongs to is the last one walked past.
    cur = state.turnIndex.filter(m => m.kind === 'turn' && m.offset < state.windowStart).length - 1;
    for (const entry of state.nodes.values()) {
        const ev = entry.ev;
        if (ev.kind === 'user') {
            if (ordinal.has(ev.id)) cur = ordinal.get(ev.id);
            else { addTurn(entry, ev.id, null); cur = state.turns.length - 1; }
            continue;
        }
        if (ev.kind !== 'tool') continue;
        const kind = REVIEWABLE[ev.name] || WORK[ev.name];
        if (kind && !seen.has(ev.id)) {
            add({ key: ev.id, kind, entry, ev, turn: cur, at: null });
        }
        if (ev.status === 'error' && !REVIEWABLE[ev.name] && !seen.has(`${ev.id}:error`)
            && !DECLINED_RE.test(firstLine(ev.result && ev.result.text))) {
            add({ key: `${ev.id}:error`, kind: 'error', entry,
                ev: { kind: 'error', name: ev.name, ts: ev.resultTs || ev.ts,
                    text: firstLine(ev.result && ev.result.text) },
                turn: cur, at: null });
        }
    }
    state.activeTurn = -1;
    marks = placeMarks(marks, starts, state.offset || null);
    layout();
    // Now it is known whether this conversation has a rail at all, so the hold
    // from beginOpen can go: with turns the class changes nothing, and without
    // them `.turns:empty` takes the column out and the composer widens into it.
    dom.turns.classList.remove('holding');
    markActiveTurn();
}

/** Cluster the placed marks for the rail's current height and draw them. */
function layout() {
    if (!resizer) {
        // Clusters are a function of the rail's height, so a window resized
        // taller pulls them apart again.
        resizer = new ResizeObserver(([e]) => {
            const h = Math.round(e.contentRect.height);
            if (h === railH) return;
            railH = h;
            if (marks.length) layout();
        });
        resizer.observe(dom.turns);
        railH = Math.round(dom.turns.clientHeight);
    }
    clusters = clusterMarks(marks, railH || 1);
    paint();
}

/** Empty the rail: the Preact way, since a hand-cleared root confuses the next render. */
export function clearRail() {
    marks = [];
    clusters = [];
    setBand = null;
    render(null, dom.turns);
}

function paint() {
    if (!state.turns.length && !marks.length) { clearRail(); return; }
    const active = state.turns[state.activeTurn];
    render(html`
        <div class="mm-track" onPointerDown=${scrubStart}>
            <${Band} />
            ${clusters.map(c => html`
                <button key=${c.lead.key} type="button" class="mm-mark"
                    data-kind=${c.kind} data-lane=${c.lane}
                    data-status=${c.kind === 'plan' || c.kind === 'question'
                        ? (c.lead.ev.status || 'pending') : null}
                    data-many=${c.members.length > 1 ? 'true' : null}
                    aria-current=${active && c.members.some(m => m.entry === active) ? 'true' : null}
                    aria-label=${labelOf(c)}
                    style=${`top:${c.px}px`}
                    onClick=${() => act(c.lead)}
                    onMouseEnter=${(e) => showTurnPop(e.currentTarget, c)}
                    onMouseLeave=${hideTurnPop}
                    onFocus=${(e) => showTurnPop(e.currentTarget, c)}
                    onBlur=${hideTurnPop}
                    onContextMenu=${REVIEWABLE_KIND[c.kind] ? (e) => openMarkMenu(e, c.lead) : null}
                ></button>`)}
        </div>`, dom.turns);
}

const REVIEWABLE_KIND = { plan: true, question: true };

/** The viewport, as a band behind the marks. Moves every scroll frame. */
function Band() {
    const [b, set] = useState(null);
    setBand = set;
    if (!b) return null;
    const top = b[0] * railH;
    const h = Math.max(2, (b[1] - b[0]) * railH);
    return html`<div class="mm-band" aria-hidden="true" style=${`top:${top}px;height:${h}px`}></div>`;
}

/** What one mark says, for its tooltip and its label. */
function headOf(m) {
    const ev = m.ev;
    if (m.kind === 'turn') return `Turn ${m.no} of ${state.turns.length}`;
    if (m.kind === 'plan' || m.kind === 'question') return `${NOUN[m.kind][0]} · ${markOutcome(ev)}`;
    if (m.kind === 'error') return ev.name ? `Failed · ${ev.name}` : 'Failed tool call';
    if (m.kind === 'edit') return ev.name || 'Edit';
    return NOUN[m.kind][0];
}

function bodyOf(m) {
    const ev = m.ev;
    switch (m.kind) {
        case 'turn': return turnText(ev);
        case 'plan': case 'question': return toolSummary(ev) || '';
        case 'edit': return ev.path || (ev.input && (ev.input.file_path || ev.input.notebook_path)) || '';
        case 'subagent': return ev.text || (ev.input && (ev.input.description || '')) || '';
        case 'error': return ev.text || '';
        case 'pr': return `#${ev.number}${ev.repo ? ' · ' + ev.repo : ''}`;
        default: return '';
    }
}

/** "3 edits, 1 failure" — what a cluster of several holds, most first. */
function countsOf(c) {
    const counts = new Map();
    for (const x of c.members) counts.set(x.kind, (counts.get(x.kind) || 0) + 1);
    const s = [...counts].sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${n === 1 ? NOUN[k][0].toLowerCase() : NOUN[k][1]}`).join(', ');
    return s[0].toUpperCase() + s.slice(1);
}

function labelOf(c) {
    const m = c.lead;
    if (c.members.length > 1) return `${countsOf(c)}: ${clip(firstLine(bodyOf(m)), 60)}`;
    return `${headOf(m)}: ${clip(bodyOf(m), 60)}`;
}

/** Clicking a mark: what its kind is for. */
function act(m) {
    hideTurnPop();
    if (m.kind === 'pr') { if (m.ev.url) window.open(m.ev.url, '_blank', 'noreferrer'); return; }
    if (m.kind === 'plan' || m.kind === 'question') { reviewMark(m.entry); return; }
    if (m.entry) jumpToTurn(m.entry);
}

// ── scrubbing ────────────────────────────────────────────────────────────
// Pressing the empty track goes to the turn at that height; dragging reads the
// turns back as it passes them and goes on release. On release and not on each
// move, because a turn above the loaded part is a fetch, and a drag across the
// rail would otherwise be one per pixel.

function turnMarkAt(clientY) {
    const r = dom.turns.querySelector('.mm-track').getBoundingClientRect();
    const y = Math.min(1, Math.max(0, (clientY - r.top) / Math.max(1, r.height)));
    let best = null;
    for (const m of marks) {
        if (m.kind !== 'turn') continue;
        if (m.y <= y + 1e-9) best = m; else break;
    }
    return best || marks.find(m => m.kind === 'turn') || null;
}

/** How far a press on a mark has to travel before it is a drag, not a click. */
const DRAG_PX = 4;

function scrubStart(e) {
    if (e.button !== 0) return;
    const track = e.currentTarget;
    // A press on a mark is that mark's click until it moves; one on the empty
    // track is a scrub from the start.
    let dragging = e.target === track;
    const y0 = e.clientY;
    let target = null;
    const at = (ev) => {
        target = turnMarkAt(ev.clientY);
        if (!target) return;
        // Anchored to the pointer's height on the rail, not to a button: the turn
        // under it may be inside a cluster and have none of its own.
        const r = track.getBoundingClientRect();
        const y = Math.min(r.bottom, Math.max(r.top, ev.clientY));
        showTurnPop({ getBoundingClientRect: () => ({ top: y, height: 0, left: r.left }) },
            { lead: target, kind: 'turn', members: [target] });
    };
    const begin = () => {
        dragging = true;
        track.setPointerCapture(e.pointerId);
    };
    const move = (ev) => {
        if (!dragging && Math.abs(ev.clientY - y0) > DRAG_PX) begin();
        if (dragging) at(ev);
    };
    const done = (go) => {
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        track.removeEventListener('pointercancel', cancel);
        if (!dragging) return;
        // The click that follows a drag that began on a mark is not that mark's.
        // It is dispatched straight after pointerup or not at all, so the
        // swallow is taken down on the next task either way — left up, it
        // would eat the next real click.
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        track.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => track.removeEventListener('click', swallow, { capture: true }), 0);
        if (go && target) jumpToTurn(target.entry); else hideTurnPop();
    };
    const up = () => done(true);
    const cancel = () => done(false);
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', cancel);
    if (dragging) { e.preventDefault(); begin(); at(e); }
}

/**
 * The card beside the rail for a cluster: its lead mark read back, or for a
 * cluster of several, how many of what and the first few of them.
 */
function showTurnPop(tick, c) {
    if (!c || !c.lead) return;
    const m = c.lead;
    const pop = dom.turnPop;
    const many = c.members.length > 1;
    const isCmd = !many && m.kind === 'turn' && Boolean(m.ev.command);

    // `toolSummary` for a plan or a question rather than a second extraction:
    // it already reduces a plan to its first heading and a question set to its
    // headers, and it is what the collapsed transcript row says — so the rail
    // and the row cannot end up calling the same thing two different things.
    let head = headOf(m);
    let body = bodyOf(m);
    if (many) {
        head = countsOf(c);
        // The one the cluster is drawn as first, then the rest by the same
        // ranking, so a PR among a hundred edits is the line you read. A file
        // by its name alone: four full paths fill the card with one directory.
        const rest = c.members.filter(x => x !== m)
            .sort((a, b) => (PRIORITY[b.kind] || 0) - (PRIORITY[a.kind] || 0));
        const line = (x) => {
            const b = firstLine(bodyOf(x));
            return `${headOf(x)} — ${x.kind === 'edit' ? b.split('/').pop() : clip(b, 80)}`;
        };
        const shown = [m, ...rest].slice(0, 4).map(line);
        if (c.members.length > 4) shown.push(`and ${c.members.length - 4} more`);
        body = shown.join('\n');
    }

    pop.replaceChildren(
        el('div', { class: 'pop-head', 'data-kind': m.kind },
            el('span', {}, head),
            el('span', { class: 'when' }, `${dateOf(m.ev.ts)} ${clockOf(m.ev.ts)}`.trim()),
        ),
        el('div', { class: 'pop-text' + (isCmd ? ' cmd' : '') }, clipLines(body, 460)),
    );
    present(pop, true, { as: 'menu' });

    // Sits to the left of the rail, centred on its mark, kept on screen.
    const r = tick.getBoundingClientRect();
    const h = pop.offsetHeight;
    pop.style.top = `${Math.min(Math.max(8, r.top + r.height / 2 - h / 2),
        Math.max(8, window.innerHeight - h - 8))}px`;
    pop.style.left = `${Math.max(8, r.left - pop.offsetWidth - 10)}px`;
}

export function hideTurnPop() {
    present(dom.turnPop, false, { as: 'menu' });
}

export async function jumpToTurn(t) {
    hideTurnPop();
    const entry = await materialize(t);
    if (entry) revealNode(entry.node);
}

async function reviewMark(t) {
    const entry = await materialize(t);
    if (entry) openReview(entry.ev.id);
}

/**
 * The loaded entry for a rail mark, fetching the stretch it is in first if it is
 * above the loaded part of the log.
 */
async function materialize(t) {
    if (t.node) return t;
    const id = t.ev.id;
    if (!state.nodes.has(id) && t.mark) await loadEarlier({ through: t.mark });
    return state.nodes.get(id) || null;
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
    // A row the window took out of the document has no box at all. Put it back
    // first; its spacer was exactly its height, so nothing above it moves.
    if (view === SESSION_VIEW) ensureAttached(node);
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
 * Whichever turn the transcript is currently sitting in, and the band.
 *
 * Binary search rather than a walk from the top. The turns are in document
 * order, so "is this one above the edge" is monotonic, and the walk broke only
 * at the first turn *below* the viewport — meaning it measured every turn above
 * it. At the bottom of a long session that was one `getBoundingClientRect` per
 * turn, each a forced layout of the whole transcript, on every scroll event.
 * This is a fixed handful of measurements however long the session gets, and
 * the band's two edges are two more searches of the same kind.
 *
 * Reads layout and never writes scroll: it runs from the scroll handler, and
 * anything here that moved the transcript would fight the pin to the bottom
 * while a turn streams.
 */
export function markActiveTurn() {
    if (!state.turns.length) return;
    // Turns not loaded yet have no row to measure. They are all above the
    // loaded ones, so the search starts at the first that has one — and the
    // answer stays monotonic.
    const first = state.turns.findIndex(t => t.node);
    if (first === -1) { if (setBand) setBand(null); return; }
    const count = state.turns.length - first;
    // layoutTop, because a turn in a detached chunk has no box: it answers
    // with the chunk's top, which keeps the search monotonic.
    const topOf = (i) => layoutTop(state.turns[first + i].node);
    const view = dom.scroll.getBoundingClientRect();
    const endTop = dom.log.getBoundingClientRect().bottom;

    const active = first + Math.floor(Math.min(count - 1, turnAt(view.top + 60, count, topOf, endTop)));
    if (setBand) {
        setBand(viewBand({ viewTop: view.top, viewBottom: view.bottom, count, topOf, endTop,
            first, total: state.turns.length }));
    }
    if (active === state.activeTurn) return;
    state.activeTurn = active;
    paint();
}
