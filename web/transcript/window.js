// Windowing the session log: settled stretches of the transcript are taken out
// of the document while they are far from the viewport, and put back before
// anything looks at them.
//
// Why at all. earlier.js stops a long session from being *opened* whole, but not
// from becoming whole: a tick near the top of the rail, or scrolling to the top a
// few times, loads every turn above, and a long autonomous turn is thousands of
// events inside the last eight turns anyway. On the longest sessions here that
// was 50 000 elements in the log and ~30ms a frame to scroll it, and every one of
// them stayed in the document for as long as the session was open.
//
// Why not `content-visibility: auto`. It was tried twice. Once tool bodies were
// built lazily it made scrolling slower (the note under `.ev` in
// css/transcript.css has the first numbers), and measured again for this change
// on real transcripts it improved the median frame but more than doubled the
// worst ones — unskipping a heavy row is a hitch the browser takes mid-scroll,
// and an estimated intrinsic size moves the scrollbar under you as rows render.
//
// **The unit is a chunk:** a `div.vchunk` wrapping up to CHUNK consecutive
// top-level children of the log — rows and `.trun` folds, so a fold is never
// split. A chunk stays in the log for good. Detaching one moves its children
// into a holder `<div>` that is not in the document and pins the wrapper's
// height; attaching moves them back and unpins it.
//
// **Heights are measured, never estimated.** A chunk is detached only after it
// has been laid out, and its `offsetHeight` is read at that moment — so the
// spacer is exactly as tall as what it replaced, for the width the log has.
// Rows vary from one line to hundreds and grow when a tool call is opened; any
// estimate by event kind would be wrong for most of them, and wrong heights
// above the viewport are what makes a scrollbar drift. The one way a held
// height goes stale is the log changing width while it is detached. That is
// left to scroll anchoring (`overflow-anchor` is on for `.scroll`): chunks are
// only ever attached off-screen, so the correction lands outside the viewport.
// `display: flow-root` on the wrapper keeps a child's margin from collapsing
// through it, which would otherwise make the measured height short.
//
// **Detached nodes stay alive, in a parent.** `state.nodes` keeps every row it
// ever had, so find's index, patchTool and the copy buttons' closures do not
// know or care. The holder is what makes that true: `replaceWith` on a node
// with no parent does nothing, and patchTool relies on it to swap a row.
//
// **What is never chunked** — the log's live end, where every append lands and
// where the code that checks DOM contiguity looks:
//   - the `.load-earlier` sentinel, which earlier.js observes and prepends after;
//   - everything from the first row of the open run on, because closeRun folds
//     only rows it finds as siblings directly under the log;
//   - while a turn is in flight, everything from the last message you sent on;
//   - the last TAIL_KEEP children whatever the state, which keeps stick-to-
//     bottom, the pending-send row and a permission card in plain sight.
// A single enormous turn still has its older part chunked: the run is folded
// every time a message closes it, and only the open one is protected.
//
// **Which chunks are attached** is an IntersectionObserver's answer, not a
// scroll handler's: each wrapper is observed with a margin of a screen and a
// half each way, and anything outside that is detached. Nothing measures on
// scroll. A chunk holding the selection or focus is left attached, so dragging a
// selection upward does not lose its anchor; and one attached on purpose —
// ensureAttached, before a jump — is held for a moment so a smooth scroll
// passing over the band edge does not take it away again before it arrives.
//
// **Anything that measures a row asks here first.** A detached row has no box,
// and zero rects break the binary searches in the turn rail and find. So:
// `layoutTop` stands in the chunk's top for a detached row (still monotonic down
// the log), and `ensureAttached` is called by revealNode and gotoHit before they
// aim at one.
//
// The subagent pane is not windowed. Its transcripts are a fraction of the
// length, and it has none of the rail machinery that makes this worth it.

import { dom } from '../dom.js';
import { state } from '../state.js';
import { isBusy } from './conversation.js';
import { markFindDirty } from './find.js';

/** Top-level children per chunk. */
const CHUNK = 40;
/** Children at the end of the log that are never chunked. */
const TAIL_KEEP = 60;
/** How long a chunk attached for a jump is kept, whatever the observer says. */
const HOLD_MS = 2000;

let observer = null;
let sealTimer = 0;
let sealIdle = 0;

function observe(chunk) {
    if (!observer) {
        observer = new IntersectionObserver(onSeen, {
            root: dom.scroll, rootMargin: '150% 0px 150% 0px',
        });
    }
    observer.observe(chunk);
}

/** Forget everything about the session being left. Called with the log emptied. */
export function resetWindow() {
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(sealTimer);
    if (sealIdle && window.cancelIdleCallback) cancelIdleCallback(sealIdle);
    sealTimer = 0;
    sealIdle = 0;
}

/**
 * Wrap settled rows into chunks, soon. Coalesced, and off the critical path:
 * the rows are already on screen, and wrapping them changes nothing you see.
 */
export function scheduleSeal() {
    if (sealTimer || sealIdle) return;
    const run = () => {
        clearTimeout(sealTimer);
        if (sealIdle && window.cancelIdleCallback) cancelIdleCallback(sealIdle);
        sealTimer = 0;
        sealIdle = 0;
        sealChunks();
    };
    if (window.requestIdleCallback) sealIdle = requestIdleCallback(run, { timeout: 1000 });
    sealTimer = setTimeout(run, 1000);
}

const isChunk = (n) => n.nodeType === 1 && n.classList.contains('vchunk');
const isUserRow = (n) => n.nodeType === 1 && n.classList.contains('ev-user');

/** Where the never-chunked end of the log begins, as an index into its children. */
function tailStart(kids) {
    let end = Math.max(0, kids.length - TAIL_KEEP);
    const first = state.run.length && state.nodes.get(state.run[0]);
    if (first && first.node) {
        const i = kids.indexOf(topLevel(first.node));
        if (i >= 0) end = Math.min(end, i);
    }
    if (isBusy()) {
        for (let i = kids.length - 1; i >= 0; i--) {
            if (isUserRow(kids[i])) { end = Math.min(end, i); break; }
        }
    }
    return end;
}

/** The child of the log a node sits under, or null if it is not under the log. */
function topLevel(node) {
    let n = node;
    while (n && n.parentNode !== dom.log) n = n.parentNode;
    return n;
}

export function sealChunks() {
    if (!state.current) return;
    const kids = [...dom.log.childNodes];
    const end = tailStart(kids);
    let loose = [];
    const flush = () => {
        // Cut at a message where there is one past the halfway mark, so a turn
        // tends to begin a chunk — it reads the same either way, but a chunk that
        // starts on a turn is one whose top is that turn's top.
        while (loose.length) {
            let n = Math.min(CHUNK, loose.length);
            if (loose.length > CHUNK) {
                for (let i = CHUNK - 1; i >= CHUNK / 2; i--) {
                    if (isUserRow(loose[i])) { n = i; break; }
                }
            }
            wrap(loose.splice(0, n));
        }
    };
    for (let i = 0; i < end; i++) {
        const n = kids[i];
        if (isChunk(n) || n.nodeType !== 1 || n.classList.contains('load-earlier')) {
            flush();
            continue;
        }
        loose.push(n);
    }
    // A short stretch at the end of the settled part waits for company rather
    // than becoming a chunk of three; the next seal picks it up.
    if (loose.length >= CHUNK) flush();
}

function wrap(nodes) {
    if (!nodes.length) return;
    const chunk = document.createElement('div');
    chunk.className = 'vchunk';
    nodes[0].before(chunk);
    chunk.append(...nodes);
    observe(chunk);
    // Moving rows collapses the ranges find painted over them.
    markFindDirty();
}

function onSeen(entries) {
    const out = [];
    for (const e of entries) {
        const chunk = e.target;
        if (!chunk.isConnected) continue;
        if (e.isIntersecting) {
            if (chunk._held) attach(chunk);
        } else if (!chunk._held) {
            if (pinned(chunk)) recheck(chunk);
            else out.push(chunk);
        }
    }
    if (!out.length) return;
    // Every height first and every write after, so this is one layout and not
    // one per chunk.
    const heights = out.map(c => c.offsetHeight);
    out.forEach((c, i) => detach(c, heights[i]));
}

/**
 * Ask about a chunk again later. The observer reports changes, not states, so a
 * chunk passed over while it was pinned — or while the pane was hidden and it
 * measured nothing — would otherwise stay attached until it next crossed the
 * band. Observing it afresh delivers its current state.
 */
function recheck(chunk) {
    clearTimeout(chunk._recheck);
    chunk._recheck = setTimeout(() => {
        if (!observer || !chunk.isConnected) return;
        observer.unobserve(chunk);
        observer.observe(chunk);
    }, HOLD_MS);
}

/** A chunk that must stay attached: held for a jump, or holding the caret. */
function pinned(chunk) {
    if (chunk._holdUntil && chunk._holdUntil > performance.now()) return true;
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed
        && (chunk.contains(sel.anchorNode) || chunk.contains(sel.focusNode))) return true;
    return chunk.contains(document.activeElement);
}

function detach(chunk, height) {
    // A held height of 0 is a chunk that has not been laid out — the pane is
    // hidden behind a panel. Detaching it would leave a spacer that is wrong
    // for the moment the pane comes back.
    if (!height) { recheck(chunk); return; }
    const held = chunk._held = document.createElement('div');
    held._vchunk = chunk;
    // Badges from a find repaint are cleared by a document-wide query, which
    // would not reach them here — and they would come back stale.
    for (const tag of chunk.querySelectorAll('.find-hits')) tag.remove();
    chunk.style.height = `${height}px`;
    held.append(...chunk.childNodes);
}

function attach(chunk) {
    const held = chunk._held;
    if (!held) return;
    chunk._held = null;
    chunk.append(...held.childNodes);
    chunk.style.height = '';
    markFindDirty();
}

/** The chunk wrapper a node belongs to, attached or not. */
function chunkOf(node) {
    let n = node;
    while (n.parentNode) n = n.parentNode;
    if (n._vchunk) return n._vchunk;
    return node.closest ? node.closest('.vchunk') : null;
}

/**
 * Put a row back in the document if it was taken out, and keep it there long
 * enough to be scrolled to. Returns whether anything changed.
 */
export function ensureAttached(node) {
    if (!node || node.isConnected) {
        const c = node && node.closest && node.closest('.vchunk');
        if (c) c._holdUntil = performance.now() + HOLD_MS;
        return false;
    }
    const chunk = chunkOf(node);
    if (!chunk || !chunk.isConnected) return false;
    chunk._holdUntil = performance.now() + HOLD_MS;
    attach(chunk);
    return true;
}

/**
 * The top of a row on screen, for a binary search down the log. A detached row
 * answers with its chunk's top, which keeps the answers in document order.
 */
export function layoutTop(node) {
    if (node.isConnected) return node.getBoundingClientRect().top;
    const chunk = chunkOf(node);
    return chunk && chunk.isConnected ? chunk.getBoundingClientRect().top : 0;
}

/** The box to measure for a node: itself, or the chunk standing in for it. */
export function layoutBox(node) {
    if (node.isConnected) return node.getBoundingClientRect();
    const chunk = chunkOf(node);
    return chunk && chunk.isConnected ? chunk.getBoundingClientRect() : node.getBoundingClientRect();
}
