// How the transcript and the columns beside it share the row: the insets that
// keep the composer over the log, the width the log lays itself out at, and
// sliding a side column in and out.
//
// `paneInsets`, `logW`, `logTarget`, `logGrow` and `logSettle` are written only
// here; an import is read-only, so they cannot move out of this file.
//
// Imports nothing from app.js, so it is not part of the app.js import cycle,
// and nothing in it reads an import at top level. test/logwidth.test.js lifts
// LOG_MAX and nextLogWidth out of it as text: dom.js, which this imports, reads
// the document on the way in, so Node cannot import this file.

import { dom } from '../dom.js';

/** The last insets written, so an unchanged recompute stays a no-op. */
let paneInsets = ['', ''];

/**
 * How much of the row the side columns are using, on each side of the transcript.
 *
 * Each column's width is read from its own `--pane-w` rather than measured or
 * copied. Measuring gives whatever the box is *partway through* its width
 * transition, and the composer's padding cannot be animated from a moving
 * target without trailing a frame behind it; a custom property is not animated,
 * so `--pane-w` is where the column is heading and both can be given the same
 * transition and set off together. Copying the numbers into this file instead
 * would put 300/240/34/0 and the two media queries in a second place.
 *
 * Everything in the row that is not a transcript pane counts, `#turns`
 * included, and left or right is decided by which side of the pane it sits on.
 * That is what makes a *future* column work without touching this: give it a
 * `--pane-w` in the row and it is counted.
 *
 * Its own function because two things read it now, and the second — the
 * transcript's width, below — has a timer that has to be able to ask again
 * after the fact without re-entering the writing half.
 */
function paneEdges() {
    if (!dom.convBody) return null;
    const kids = [...dom.convBody.children];
    const pane = kids.findIndex(k => k.classList.contains('scroll'));
    if (pane === -1) return null;

    let left = 0;
    let right = 0;
    for (const [i, k] of kids.entries()) {
        if (k.classList.contains('scroll')) {
            // The transcript's own scrollbar. It sits inside the pane, so the
            // log centres itself in what is left over from it while the composer
            // knows nothing about it — a standing ~6px lean that predates the
            // side columns and would be easy to mistake for this not working.
            // Measured, not declared: its width is the platform's, and it is 0
            // on a machine with overlay scrollbars.
            if (k.offsetParent !== null) right += k.offsetWidth - k.clientWidth;
            continue;
        }
        // A column that is not in the layout contributes nothing, whatever its
        // `--pane-w` computes to. That is not belt-and-braces: `--pane-w` is set
        // by several rules across two media queries, and the narrow-window rule
        // that removes a panel is *less* specific than the one that sets it to
        // 240px, so under 900px the variable still reads 240 while the box is
        // gone. Asking the layout is the only answer that cannot be outranked.
        if (k.offsetParent === null) continue;
        const w = Number.parseFloat(getComputedStyle(k).getPropertyValue('--pane-w')) || 0;
        if (i < pane) left += w; else right += w;
    }

    return { left, right };
}

/**
 * Keep the composer and the ask dock over the transcript, not over the pane —
 * and tell the transcript how wide to lay itself out while we are here.
 *
 * The log, the ask dock and the composer are each a 1000px box centred in its
 * container, and their containers were not the same one: the log is centred in
 * `#scroll`, which every side column squeezes, while the two below it were
 * centred in the whole of `.conv-main`. So opening the task list moved the
 * transcript and left the composer where it was, and the composer read as
 * crooked. Now both are inset by whatever the columns are actually using, and
 * the three are one column down the middle.
 *
 * `instant` is for a column that arrives or leaves rather than one that widens:
 * `display` cannot be animated, so the transcript reflows in one frame, and the
 * composer easing into place over the next hundred would be the crooked composer
 * again in miniature. The composer's transition is declared in CSS and suppressed
 * for that one write, the way `setScrollTop` suppresses smooth scrolling.
 *
 * `live` says the caller may be one of a run — the pane observer during a window
 * drag, rather than a click that opened a column. It reaches `syncLogWidth` and
 * nothing else, because that is the only thing here a run of calls costs
 * anything.
 */
export function syncPaneInsets({ instant = false, live = false } = {}) {
    const edges = paneEdges();
    if (!edges) return;

    const next = [`${Math.round(edges.left)}px`, `${Math.round(edges.right)}px`];
    // Nothing to do is the common case, and here it is also load-bearing. The
    // observer fires on every frame of a width animation and recomputes the same
    // target each time; writing it again would be harmless, but the `instant`
    // dance below is not — cancelling and restoring the transition mid-flight
    // would leave the composer where the animation had got to.
    //
    // A guard rather than the early return it used to be, because the log width
    // below has to be reached either way: a window resize changes how wide the
    // transcript is without moving a single column, so it is the one case where
    // these two numbers are identical and the one under them is not.
    const shifted = next[0] !== paneInsets[0] || next[1] !== paneInsets[1];
    if (shifted) {
        paneInsets = next;

        const moved = [dom.composer, dom.askDock].filter(Boolean);
        if (instant) for (const n of moved) n.style.transition = 'none';

        dom.convMain.style.setProperty('--pane-left', next[0]);
        dom.convMain.style.setProperty('--pane-right', next[1]);

        if (instant) {
            void dom.composer.offsetWidth;   // land the new padding before the transition is back
            for (const n of moved) n.style.transition = '';
        }
    }

    // Last, and after that flush: it is there to land the composer's padding
    // before its transition comes back, and has no business dragging a
    // transcript reflow in with it.
    syncLogWidth(edges, { paneMoving: shifted, live });
}

// ── how wide the transcript lays itself out ──────────────────────────────────
//
// `.log` used to be `max-width: 1000px` on an automatic width, which is to say
// it was as wide as the pane whenever the pane was narrower than that — and the
// pane is what every side column squeezes and every window resize changes. So a
// column sliding in re-laid-out all 2000 rows of a long session, once per frame
// of its 110ms transition, and dragging the window between two monitors did it
// for the length of the drag. That is the lag this exists to remove.
//
// Measured on a 2022-row transcript, one width change of the pane:
//
//     max-width, pane above 1000px     41-46ms
//     max-width, pane below 1000px     38-117ms
//     an explicit width, either        0.1ms
//
// The middle row is the one the arithmetic predicts — below 1000px every
// paragraph re-wraps — but the first is the surprise and the reason this is
// written as a width rather than left to the cap. An automatic width *depends*
// on the space around it, so Blink cannot reuse what it laid out last time even
// when the number comes out the same; an explicit one is independent of it, and
// the whole subtree is skipped. Both cases collapse to nothing.
//
// So the log is told a number instead of asked to fill a box. `margin: 0 auto`
// is untouched — it is still centred in the real pane, and the columns still
// animate — but the thing 2000 grid rows and their text are laid out against
// holds still between updates, and what the pane does around it costs a
// repositioning rather than a reflow.
//
// The CSS keeps `100%` in its `min()` as a floor this can never overhang, which
// is what makes every rule below a performance decision rather than a
// correctness one: whatever is written here, and however stale it is, the log
// cannot end up wider than the pane and cannot clip a word.
//
//   shrink        at once. The pane is the wider of the two either way, and a
//                 log centred in a box a few pixels too wide is a few pixels of
//                 extra gutter.
//   grow, a
//   column
//   moving        held until it has finished. Written at once it would be wider
//                 than a pane that is still half open, the floor would catch it,
//                 and every frame would re-wrap — this bug, with extra steps.
//   grow, a
//   drag          held until the drag stops. A log narrower than its pane is a
//                 little extra gutter, so opening a window out costs nothing at
//                 all until the last frame.
//   grow,
//   neither       at once. There is nothing to wait for.
//
// And every shrink the observer reports is quantized down to LOG_STEP, so a
// window dragged narrower costs one reflow per LOG_STEP of travel rather than
// one per frame, with the exact width written once it stops. Being a step narrow
// is invisible: the log is centred, so it is half a step of extra gutter a side.

const LOG_MAX = 1000;     // the 1000px `.log` and the composer inner share
const LOG_STEP = 48;      // a drag is at most this much narrow, centred, briefly
const LOG_SETTLE = 180;   // past --t-fast (110ms), with a frame in hand

/**
 * The width to lay the log out at, given the space it has. Pure, and separate
 * so it can be tested without a browser — see test/logwidth.test.js, which
 * lifts these three constants and this function straight out of this file.
 */
function nextLogWidth(avail, { live = false } = {}) {
    const exact = Math.min(LOG_MAX, Math.floor(avail));
    if (!live || exact >= LOG_MAX) return exact;
    return Math.max(LOG_STEP, Math.floor(exact / LOG_STEP) * LOG_STEP);
}

let logW = 0;         // what `--log-w` says now
let logTarget = 0;    // the exact width the space last asked for
let logGrow = 0;      // a grow waiting for a column to finish moving
let logSettle = 0;    // a drag waiting to stop

function writeLogWidth(w) {
    if (w === logW || !dom.convMain) return;
    logW = w;
    dom.convMain.style.setProperty('--log-w', `${w}px`);
}

/** Whatever the space last asked for, exactly, now. Both timers land here. */
function applyLogTarget() {
    clearTimeout(logGrow);
    clearTimeout(logSettle);
    logGrow = 0;
    logSettle = 0;
    writeLogWidth(logTarget);
}

function syncLogWidth({ left, right }, { paneMoving = false, live = false } = {}) {
    if (!dom.convBody || !dom.convMain) return;
    const avail = dom.convBody.clientWidth - left - right;
    if (!(avail > 0)) return;   // no conversation in the layout yet

    // The same space as last time is nothing to do — and while a column is
    // sliding it is *all* the observer ever sees, because these edges come from
    // `--pane-w` and that is at its target from the first frame. Without this
    // the quantized value below would land on top of the exact one the click
    // that opened the column has already written.
    const exact = nextLogWidth(avail);
    if (exact === logTarget) return;
    logTarget = exact;

    if (live) {
        clearTimeout(logSettle);
        logSettle = setTimeout(applyLogTarget, LOG_SETTLE);
    }

    const want = live ? nextLogWidth(avail, { live: true }) : exact;

    // Narrowing has to be written now, and not because of the clipping the floor
    // already rules out: once the pane is narrower than `--log-w` it is `100%`
    // that binds, and a width that resolves from the pane is the automatic width
    // this whole thing replaced. Staying under the pane is what keeps the floor
    // out of it.
    if (want <= logW) {
        clearTimeout(logGrow);
        logGrow = 0;
        return writeLogWidth(want);
    }

    // Widening can always wait, and while somebody is dragging it should: a log
    // narrower than its pane is a little extra gutter, so a drag that only opens
    // the window out costs no reflow at all until it stops.
    if (live) return;

    // A column still on its way out is the other wait. Read the duration off the
    // column rather than writing 110 twice, the way `slidePane` does — which
    // also makes reduced motion, where it is 0, the immediate behaviour.
    if (paneMoving) {
        clearTimeout(logGrow);
        const col = dom.convBody.querySelector('.tasks');
        logGrow = setTimeout(applyLogTarget, (col ? transitionMs(col) : 0) + 30);
        return;
    }

    clearTimeout(logGrow);
    logGrow = 0;
    writeLogWidth(want);
}

/**
 * Watch the columns rather than every place that opens one.
 *
 * Three render functions can put a column in or take it out, a window resize can
 * cross either of the two media queries that change how wide one is, and a
 * transcript growing past its pane can add a scrollbar — six places that would
 * each have to remember to call `syncPaneInsets`, one of them not a user action
 * at all. Observing the row covers all of them and a seventh nobody has written
 * yet.
 *
 * The travelling-together is not this: that is the shared transition on
 * `.composer`, driven by the target width `syncPaneInsets` reads. This only has
 * to notice, and it is allowed to notice a frame late.
 *
 * The composer is not observed, only the row, and its padding cannot change
 * anything inside the row — so this cannot feed itself.
 */
// `instant`, and not just because the callback's first argument is a list of
// entries rather than an options bag. What is left for this to be the first to
// notice — a window resize crossing a media query, a transcript growing a
// scrollbar — changes the layout in one frame with no animation to keep step
// with, so easing after it would be the lag this whole thing is about. A column
// sliding in or out is not one of those: `slidePane` has already written the
// target by the time this runs, so it recomputes the same numbers and stops at
// the no-op above without touching the transition in flight.
//
// `live` is the other half of that, and it is about the log rather than the
// composer: this is the one caller that can fire every frame for as long as
// somebody keeps dragging, so it is the one that gets the quantized width and
// the settle. Every other caller is a click, and gets the exact width at once.
const paneObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => syncPaneInsets({ instant: true, live: true })) : null;

export function watchPaneInsets() {
    if (!paneObserver || !dom.convBody) return;
    // Every child, the transcript panes included: their *content* box changes
    // when a scrollbar appears, which is the one thing above that no side column
    // moving would tell us about. Their border box is fixed by the row, and the
    // composer's padding cannot reach inside the row, so watching them still
    // cannot feed this back into itself.
    for (const k of dom.convBody.children) paneObserver.observe(k);
    syncPaneInsets();
}

/** Pending `hidden` writes, one per column, so a reversal cancels the last. */
const paneExits = new WeakMap();

/** Whether a column is in the row now — not gone, and not on its way out. */
export function paneUp(node) {
    return !!node && !node.hidden && !node.classList.contains('gone');
}

/** How long this element says it takes to move. 0 under reduced motion. */
function transitionMs(node) {
    const secs = getComputedStyle(node).transitionDuration.split(',')[0];
    return (Number.parseFloat(secs) || 0) * 1000;
}

/**
 * Put a column in the row or take it out, as a slide rather than a jump.
 *
 * `display` cannot be animated, so toggling `hidden` moved the transcript and
 * the composer the whole width of a column in one frame. Switching between two
 * conversations did it four times: `beginOpen` emptied both asides, which took
 * them out, and then each one's answer arriving put it back.
 *
 * So a column that is leaving keeps its place in the layout at zero width until
 * the transition has run, and only then goes `hidden`; one arriving is put in at
 * zero width and widened on the next frame. The composer follows either way,
 * because `--pane-w` is what `syncPaneInsets` reads and `.gone` sets it to 0.
 *
 * The `hidden` write is deferred by however long the element says its transition
 * takes — read from it rather than written here, so reduced motion reports 0 and
 * this becomes the instant behaviour it used to have, and so the number cannot
 * drift from the CSS. `transitionend` would be more precise and does not fire at
 * all when the transition is `none`, which is the case that would then leave a
 * column in the layout for ever.
 */
export function slidePane(node, present) {
    if (!node) return;
    clearTimeout(paneExits.get(node));
    const was = paneUp(node);
    if (present === was) {
        // Already where it belongs. Still worth clearing a half-finished exit:
        // a column re-shown mid-slide has the class on and would otherwise stay
        // at zero width with nothing left to take it off.
        if (present) node.classList.remove('gone');
        return;
    }

    if (present) {
        node.hidden = false;
        node.classList.add('gone');
        void node.offsetWidth;      // commit the narrow state before widening
        node.classList.remove('gone');
    } else {
        node.classList.add('gone');
        const done = () => { node.hidden = true; paneExits.delete(node); };
        const ms = transitionMs(node);
        if (ms > 0) paneExits.set(node, setTimeout(done, ms + 30)); else done();
    }
    syncPaneInsets();
}
