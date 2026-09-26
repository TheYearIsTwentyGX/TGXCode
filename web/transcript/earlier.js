// Opening a long conversation from its end, and fetching the rest on the way up.
//
// A session opens with its last OPEN_TURNS turns (`?turns=` on the transcript
// route) plus the bridge's turn index — every message, plan and question, with
// the byte offset it starts at. The rail is drawn from the index, so it is whole
// from the first frame; the log holds only what was loaded. Scrolling to the top
// of it, or clicking a tick above it, fetches an earlier stretch from `/range`
// and puts it in above what is there.
//
// Before this, opening a session drew every event it had ever produced — one
// DOM node and a markdown pass each, thousands on a long session — and that was
// the lag on open.
//
// What a prepended stretch has to get right, and why it is done here rather
// than through appendEvents on the real log:
//
// - **Order.** `state.nodes` and `state.tools` are Maps read in insertion order
//   as document order — find walks the first, the checklist and the diff viewer
//   the second. A stretch that is older than everything loaded has to go in
//   *front*, so both are rebuilt with it first. In place, because SESSION_VIEW
//   holds the Map objects themselves.
// - **Runs.** Built in a detached container with a run of its own, so folding
//   the stretch's tool calls cannot reach into the live run at the bottom. A
//   stretch always ends where a turn begins, so its last run is closed.
// - **Results that crossed the boundary.** A call near the end of an older
//   stretch can have its result in the newer one, which arrived first and had
//   nothing to patch. Those were kept in `state.orphanResults` and are applied
//   as their calls arrive.
// - **Scroll position.** Chromium does not anchor a scroller sitting at 0,
//   which is exactly where the sentinel fires, so anchoring is switched off and
//   the offset kept by hand — one mechanism, not two that might both apply.

import { get } from '../api.js';
import { dom, el, toast } from '../dom.js';
import { state } from '../state.js';
import { appendEvents, closeRun, patchTool } from './conversation.js';
import { renderTurns } from './turn-rail.js';

/** Turns loaded when a session is opened. */
export const OPEN_TURNS = 8;
/** Turns fetched each time you reach the top. */
const EARLIER_TURNS = 8;

let observer = null;

/** Called by openSession once the first window is in the log. */
export function mountEarlier() {
    if (observer) observer.disconnect();
    observer = null;
    if (!state.windowStart) return;
    const row = el('div', { class: 'load-earlier', role: 'status' },
        el('button', { class: 'more-btn', type: 'button', onclick: () => loadEarlier() },
            'Load earlier messages'));
    dom.log.prepend(row);
    // After the first scroll to the bottom, so a short window that fits the pane
    // does not fetch the next stretch before anybody asked.
    requestAnimationFrame(() => {
        if (!row.isConnected) return;
        observer = new IntersectionObserver((seen) => {
            if (seen.some(e => e.isIntersecting)) loadEarlier();
        }, { root: dom.scroll, rootMargin: '600px 0px 0px 0px' });
        observer.observe(row);
    });
}

function turnsAbove() {
    return state.turnIndex.filter(m => m.kind === 'turn' && m.offset < state.windowStart);
}

/**
 * Fetch the stretch before what is loaded. `through` is a mark to load down to
 * (a tick clicked above the loaded part); without it, the next EARLIER_TURNS.
 * Resolves when the stretch is in the log.
 */
export async function loadEarlier({ through = null } = {}) {
    while (state.loadingEarlier) await state.loadingEarlier;
    if (!state.windowStart || !state.current) return;
    if (through && through.offset >= state.windowStart) return;

    const above = turnsAbove();
    let from;
    if (through) from = through.offset;
    else from = above.length > EARLIER_TURNS ? above[above.length - EARLIER_TURNS].offset : 0;
    // The first turn is not the start of the file: whatever came before it — a
    // compaction summary, a system line — belongs to the first stretch too.
    if (above.length && from <= above[0].offset) from = 0;

    const sessionId = state.current.sessionId;
    const to = state.windowStart;
    const seq = state.openSeq;
    state.loadingEarlier = (async () => {
        try {
            const data = await get(`/api/sessions/${sessionId}/range?from=${from}&to=${to}`);
            if (seq !== state.openSeq || state.windowStart !== to) return;
            prependEvents(data.events || []);
            state.windowStart = from;
            if (!from) {
                if (observer) observer.disconnect();
                observer = null;
                dom.log.querySelector(':scope > .load-earlier')?.remove();
            }
            renderTurns();
        } catch (err) {
            toast(`Could not load earlier messages: ${err.message}`, 'error');
        }
    })();
    try { await state.loadingEarlier; } finally { state.loadingEarlier = null; }
}

/**
 * Everything above the loaded part, for the few readers that need the whole
 * conversation rather than what is on screen — the diff viewer's fallback,
 * which rebuilds a file's history from every edit the session made to it.
 */
export function loadAll() {
    return state.windowStart ? loadEarlier({ through: { offset: 0 } }) : Promise.resolve();
}

function prependEvents(events) {
    const box = document.createElement('div');
    const view = {
        isAgent: false, prepend: true,
        nodes: new Map(), tools: new Map(), plans: state.plans,
        log: box, scroll: dom.scroll, run: [],
    };
    appendEvents(events, view);
    closeRun(view);
    for (const id of view.tools.keys()) {
        const patch = state.orphanResults.get(id);
        if (!patch) continue;
        state.orphanResults.delete(id);
        patchTool(patch, view);
    }

    for (const [map, add] of [[state.nodes, view.nodes], [state.tools, view.tools]]) {
        const old = [...map];
        map.clear();
        for (const [k, v] of add) map.set(k, v);
        for (const [k, v] of old) if (!map.has(k)) map.set(k, v);
    }

    const sc = dom.scroll;
    const prevAnchor = sc.style.overflowAnchor;
    const prevBehavior = sc.style.scrollBehavior;
    sc.style.overflowAnchor = 'none';
    sc.style.scrollBehavior = 'auto';
    const before = sc.scrollHeight;
    const top = sc.scrollTop;
    const sentinel = dom.log.querySelector(':scope > .load-earlier');
    if (sentinel) sentinel.after(...box.childNodes);
    else dom.log.prepend(...box.childNodes);
    sc.scrollTop = top + (sc.scrollHeight - before);
    sc.style.overflowAnchor = prevAnchor;
    sc.style.scrollBehavior = prevBehavior;
}
