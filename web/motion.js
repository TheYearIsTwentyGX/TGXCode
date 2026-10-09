// Moving things on and off the page, so nothing appears or vanishes in a frame.
//
// Almost every surface here is shown and hidden by writing `hidden`, and CSS
// pairs that with `display: none` — which cannot be animated. A keyframe can
// play an element in, but nothing can play it out: by the time anything could
// run, it is already gone. So the exits are what this module is for. Each one
// keeps the element in the layout while it plays, and writes `hidden` (or
// removes the node) only once it has finished.
//
// What it decided:
//
//   - **The Web Animations API, not classes.** A `.m-off` class carrying a
//     `transition` would replace whatever `transition` the element already has
//     for its hover colours, since a property is one declaration. An animation
//     from `el.animate()` sits on top of the cascade and is gone when it ends,
//     so it borrows nothing and leaves nothing behind.
//   - **Durations come from CSS.** `--t-fast` and `--t-med` in base.css are
//     read at call time, and the reduced-motion block there sets both to 0 —
//     so a reduced-motion reader gets the old instant behaviour from every call
//     here, and no call has to ask.
//   - **A reversal starts from where the element is.** Opening something that
//     is half-way through closing cancels the exit and plays the entry from the
//     current frame, rather than snapping back to the start; `hidden` is never
//     written by an exit that was overtaken.
//   - **Height is animated in pixels, on the element itself.** `grow()` reads
//     the height the element has, or would have, and animates to it. A docked
//     element is `flex: none` in a column whose `.scroll` is `flex: 1`, so the
//     transcript above takes up exactly the room the dock gives back, frame by
//     frame — which is what makes it grow and shrink with it.
//
// Imports nothing, so anything can import it.

/** The animation running on each node, so a reversal can find and cancel it. */
const running = new WeakMap();

/** Nodes on their way out. Up to the caller whether that counts as gone. */
const leaving = new WeakSet();

/** `--t-fast` or `--t-med`, in ms. 0 under reduced motion — see base.css. */
export function dur(which = 'med') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--t-${which}`);
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) return 0;
    return v.trim().endsWith('ms') ? n : n * 1000;
}

const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/** How long this element's own CSS transition takes. 0 under reduced motion. */
export function transitionMs(node) {
    const cs = getComputedStyle(node);
    const d = cs.transitionDuration.split(',').map(s => Number.parseFloat(s) || 0);
    return Math.max(0, ...d) * 1000;
}

/** Whether a node is showing and not on its way out. */
export function isUp(node) {
    return !!node && !node.hidden && node.isConnected && !leaving.has(node);
}

/** Stop whatever is playing on a node and leave it as its CSS says. */
export function settle(node) {
    if (!node) return;
    stop(node);
    leaving.delete(node);
}

/** Whether a node is playing its exit. */
export function isLeaving(node) {
    return !!node && leaving.has(node);
}

function stop(node) {
    const a = running.get(node);
    running.delete(node);
    if (a) a.cancel();
}

// Every caller reads the frame it starts from *before* calling this, while any
// animation it is overtaking still applies — so a reversal starts where the
// element is, and nothing is ever committed to its inline style.
function play(node, frames, ms, done) {
    stop(node);
    if (ms <= 0 || !node.isConnected) {
        done && done();
        return null;
    }
    // `forwards`, and cancelled in the handler, so there is no frame between the
    // end of an exit and the `hidden` write where the element is back at full.
    const a = node.animate(frames, { duration: ms, easing: EASE, fill: 'forwards' });
    running.set(node, a);
    a.onfinish = () => {
        if (running.get(node) !== a) return;
        running.delete(node);
        done && done();
        a.cancel();
    };
    return a;
}

const KINDS = {
    fade: { opacity: 0 },
    pop:  { opacity: 0, transform: 'translateY(-4px) scale(0.98)' },
    rise: { opacity: 0, transform: 'translateY(6px)' },
    drop: { opacity: 0, transform: 'translateY(-6px)' },
    zoom: { opacity: 0, transform: 'scale(0.97)' },
};

function shown(node) {
    const cs = getComputedStyle(node);
    return { opacity: cs.opacity, transform: cs.transform === 'none' ? 'none' : cs.transform };
}

/**
 * Show or hide a node by its `hidden` attribute, with a fade or pop.
 *
 * @param {'fade'|'pop'|'rise'|'drop'|'zoom'} [o.kind]
 * @param {'fast'|'med'} [o.speed]
 * @param {Function} [o.onGone]  after the exit, once `hidden` is written
 */
export function present(node, show, { kind = 'fade', speed = 'fast', onGone } = {}) {
    if (!node) return;
    const off = KINDS[kind] || KINDS.fade;
    if (show) {
        const was = isUp(node);
        leaving.delete(node);
        if (was && !running.has(node)) return;
        const from = node.hidden ? off : shown(node);
        node.hidden = false;
        // One keyframe at 0: the end is whatever the element's own CSS says, so a
        // node dimmed by its stylesheet is not brightened for the length of this.
        play(node, [{ ...from, offset: 0 }], dur(speed));
        return;
    }
    if (node.hidden) { leaving.delete(node); return; }
    if (leaving.has(node)) return;
    leaving.add(node);
    play(node, [shown(node), off], dur(speed), () => {
        leaving.delete(node);
        node.hidden = true;
        onGone && onGone();
    });
}

/** Play a node out and remove it from the document. */
export function exit(node, { kind = 'fade', speed = 'fast', collapse = false, onGone } = {}) {
    if (!node || leaving.has(node)) return;
    if (!node.isConnected) { onGone && onGone(); return; }
    leaving.add(node);
    node.style.pointerEvents = 'none';
    const done = () => { leaving.delete(node); node.remove(); onGone && onGone(); };
    if (collapse) {
        const box = boxOf(node);
        play(node, [
            { ...box, ...shown(node), overflow: 'hidden' },
            { ...ZERO, ...(KINDS[kind] || KINDS.fade), overflow: 'hidden' },
        ], dur(speed), done);
    } else {
        play(node, [shown(node), KINDS[kind] || KINDS.fade], dur(speed), done);
    }
}

/** Play a node in that was just put into the document. */
export function enter(node, { kind = 'fade', speed = 'fast', collapse = false } = {}) {
    if (!node || !node.isConnected) return;
    const off = KINDS[kind] || KINDS.fade;
    if (collapse) {
        const box = boxOf(node);
        play(node, [
            { ...ZERO, ...off, overflow: 'hidden' },
            { ...box, opacity: 1, transform: 'none', overflow: 'hidden' },
        ], dur(speed));
    } else {
        play(node, [{ ...off, offset: 0 }], dur(speed));
    }
}

const ZERO = {
    height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px',
    borderTopWidth: '0px', borderBottomWidth: '0px', minHeight: '0px',
};

/** The vertical box an element has now, as keyframe values. */
function boxOf(node) {
    const cs = getComputedStyle(node);
    return {
        height: `${node.getBoundingClientRect().height}px`,
        paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
        marginTop: cs.marginTop, marginBottom: cs.marginBottom,
        borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth,
        // Off for the length of the animation, at both ends: a min-height would
        // stop a shrink at it and then drop the rest in a frame.
        minHeight: '0px',
    };
}

/** The box with any animation of ours taken off — where an entry is heading. */
function naturalBox(node) {
    stop(node);
    return boxOf(node);
}

/**
 * Grow a node open from nothing, or shrink it to nothing, by its height.
 *
 * Whatever shares its flex column moves with it each frame — that is the point:
 * the transcript lengthens as a dock below it closes. Padding and margin go with
 * the height, since a box at height 0 still shows them otherwise.
 *
 * @param {Function} [o.onGone]  after the shrink, once `hidden` is written —
 *   where to empty a node whose content should stay up while it closes
 */
export function grow(node, show, { speed = 'med', onGone } = {}) {
    if (!node) return;
    if (show) {
        // Height alone, no fade: a dock is opaque, and fading it in showed the
        // transcript through it for the length of the grow.
        const from = node.hidden ? ZERO : boxOf(node);
        const was = isUp(node) && !running.has(node);
        leaving.delete(node);
        if (was) return;
        node.hidden = false;
        const to = naturalBox(node);
        play(node, [
            { ...from, overflow: 'hidden' },
            { ...to, overflow: 'hidden' },
        ], dur(speed));
        return;
    }
    if (node.hidden) { leaving.delete(node); onGone && onGone(); return; }
    if (leaving.has(node)) return;
    leaving.add(node);
    play(node, [
        { ...boxOf(node), overflow: 'hidden' },
        { ...ZERO, overflow: 'hidden' },
    ], dur(speed), () => {
        leaving.delete(node);
        node.hidden = true;
        onGone && onGone();
    });
}

/**
 * Change what a node holds and animate its height from the old size to the new.
 * `mutate` runs synchronously; nothing is measured until it has.
 */
export function morph(node, mutate, { speed = 'med' } = {}) {
    if (!node || node.hidden || !node.isConnected || leaving.has(node)) { mutate(); return; }
    const from = boxOf(node).height;
    stop(node);
    mutate();
    if (node.hidden || leaving.has(node)) return;
    const to = boxOf(node).height;
    if (Math.abs(parseFloat(to) - parseFloat(from)) < 1) return;
    play(node, [{ height: from, overflow: 'hidden' }, { height: to, overflow: 'hidden' }], dur(speed));
}

/**
 * Animate a list's children from where they were to where they are after
 * `mutate` — the FLIP technique. Children are matched by `keyOf`, so it works
 * for a list Preact re-renders as well as one built by hand. New children fade
 * in; children that left are the caller's to play out.
 */
export function flip(container, keyOf, mutate, opts = {}) {
    flipAll(container, () => (container ? container.children : []), keyOf, mutate, opts);
}

/**
 * flip() for items anywhere under `root` rather than only its children — the
 * rail's rows, which sit inside the groups that hold them. `items` is asked for
 * the set before and again after.
 */
export function flipAll(root, items, keyOf, mutate, { speed = 'med', enterNew = true } = {}) {
    if (!root || dur(speed) <= 0) { mutate(); return; }
    const before = new Map();
    for (const c of items()) {
        const k = keyOf(c);
        if (k != null) before.set(k, c.getBoundingClientRect());
    }
    mutate();
    if (!before.size) return;      // a first paint is not a change
    for (const c of items()) {
        const k = keyOf(c);
        if (k == null) continue;
        const was = before.get(k);
        if (!was) { if (enterNew) enter(c, { kind: 'fade', speed: 'fast' }); continue; }
        const now = c.getBoundingClientRect();
        const dy = was.top - now.top, dx = was.left - now.left;
        if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
        // Only what the eye can follow: a row that crossed half the screen in a
        // re-sort reads better arriving than flying.
        if (Math.abs(dy) > window.innerHeight / 2) { enter(c, { kind: 'fade', speed: 'fast' }); continue; }
        play(c, [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: 'none' },
        ], dur(speed));
    }
}

/** Fade new content in where old content was, on the same node. */
export function swap(node, mutate, { speed = 'fast' } = {}) {
    if (!node) { mutate(); return; }
    mutate();
    if (node.hidden) return;
    play(node, [{ opacity: 0.25 }, { opacity: 1 }], dur(speed));
}

/**
 * Replace a strip's children, growing it open when it gains its first and
 * shrinking it shut when it loses its last.
 *
 * For the header strips — subagents, dev servers, command buttons — which hide
 * themselves with `:empty` rather than `hidden`. A strip being emptied keeps its
 * old children until it has closed, which is what makes the close visible.
 */
export function fill(node, kids) {
    if (!node) return;
    const had = node.childElementCount > 0 && !leaving.has(node);
    if (kids.length) {
        const from = node.childElementCount ? boxOf(node) : null;
        leaving.delete(node);
        if (had) { morph(node, () => node.replaceChildren(...kids)); return; }
        stop(node);
        node.replaceChildren(...kids);
        const to = boxOf(node);
        play(node, [
            { ...(from || ZERO), opacity: from ? 1 : 0, overflow: 'hidden' },
            { ...to, opacity: 1, overflow: 'hidden' },
        ], dur('med'));
        return;
    }
    if (!had) { if (!leaving.has(node)) node.replaceChildren(); return; }
    leaving.add(node);
    play(node, [
        { ...boxOf(node), opacity: 1, overflow: 'hidden' },
        { ...ZERO, opacity: 0, overflow: 'hidden' },
    ], dur('med'), () => { leaving.delete(node); node.replaceChildren(); });
}

/**
 * Play a one-off animation on a node that stays where it is — a dialog box
 * scaling with the scrim around it, say. The frames are ordinary keyframes; a
 * single frame with `offset: 0` animates from it to the node's own style.
 */
export function animate(node, frames, { speed = 'fast' } = {}) {
    if (!node) return;
    play(node, frames, dur(speed));
}
