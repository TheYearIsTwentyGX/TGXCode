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
//   - **Named presets, not raw numbers.** A call says what is moving — a
//     `menu`, a `dialog`, a `toast` — and PRESETS below says how: which frame
//     it comes from, how long it takes each way, and on which curve. Things
//     arrive on a decelerating curve and leave on an accelerating one, and an
//     exit is shorter than its entry, so a dismissed thing is gone before the
//     eye goes looking for it. The old `kind`/`speed` options still work; new
//     code passes `as`.
//   - **Durations and curves come from CSS.** `--dur-*` and `--ease-*` in
//     base.css are read at call time, so the motion scale lives in one place.
//   - **Reduced motion keeps the fade and drops the movement.** Under
//     `prefers-reduced-motion` a preset loses its travel, scale and height and
//     plays a short opacity change instead — a change you can still see happen
//     — or, for the ones whose whole content is movement (a dock growing, a
//     list re-sorting), happens at once. This module checks the query itself;
//     base.css no longer zeroes the durations for it.
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

const LEGACY_SPEED = { med: 'base' };

/** `--dur-<which>` from base.css, in ms: press, fast, base, slow. `med` is base. */
export function dur(which = 'base') {
    const name = LEGACY_SPEED[which] || which;
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--dur-${name}`);
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) return 0;
    return v.trim().endsWith('ms') ? n : n * 1000;
}

const STANDARD = 'cubic-bezier(0.2, 0, 0, 1)';

/** `--ease-<which>` from base.css: standard, out, in, linear. */
export function curve(which = 'standard') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--ease-${which}`).trim();
    return v || STANDARD;
}

const reducedQuery = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** Whether the reader asked for less motion. Read per call, so it can change live. */
export function reduced() {
    return !!reducedQuery && reducedQuery.matches;
}

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
function play(node, frames, { ms, easing = STANDARD }, done) {
    stop(node);
    if (ms <= 0 || !node.isConnected) {
        done && done();
        return null;
    }
    // `forwards`, and cancelled in the handler, so there is no frame between the
    // end of an exit and the `hidden` write where the element is back at full.
    const a = node.animate(frames, { duration: ms, easing, fill: 'forwards' });
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

/**
 * Every kind of thing that moves here, and how it moves. `from` is the frame it
 * arrives from and leaves to; `in` and `out` are [duration, curve] names from
 * base.css; `reduced` is what is left of it under prefers-reduced-motion —
 * `fade` (opacity only, short) or `instant`.
 *
 *   menu      a menu or popover opening off its trigger: the bar's menus, the
 *             project and sort menus, slash and snippet menus, hover cards
 *   drop      a bar that slides down from the top edge of its pane (find)
 *   dialog    the box of a modal; its scrim is `scrim`
 *   scrim     the dimmed backdrop behind a dialog
 *   toast     a notice at the foot of the window; collapses its gap on exit
 *   arrive    something new arriving in the flow: a panel switched in, a
 *             transcript entry, the plan pane, the subagent view
 *   reveal    content appearing where nothing moved: a fade in place
 *   dock      a docked pane or strip growing and shrinking by its height
 *   reorder   a list's items moving to their new places (FLIP)
 *   crossfade new content swapped in on the same node
 *   drawer    a panel sliding in over a column from that column's right edge —
 *             the orchestrator page's worker drawer. A short travel, not the
 *             panel's whole width: it says where it came from without making
 *             the eye follow it across the screen
 */
export const PRESETS = {
    menu:      { from: KINDS.pop,  in: ['base', 'out'], out: ['fast', 'in'], reduced: 'fade' },
    drop:      { from: KINDS.drop, in: ['base', 'out'], out: ['fast', 'in'], reduced: 'fade' },
    dialog:    { from: { opacity: 0, transform: 'translateY(8px) scale(0.98)' },
                 in: ['slow', 'out'], out: ['fast', 'in'], reduced: 'fade' },
    scrim:     { from: KINDS.fade, in: ['base', 'out'], out: ['fast', 'in'], reduced: 'fade' },
    toast:     { from: { opacity: 0, transform: 'translateY(8px)' },
                 in: ['base', 'out'], out: ['base', 'in'], reduced: 'fade' },
    arrive:    { from: KINDS.rise, in: ['base', 'out'], out: ['fast', 'in'], reduced: 'fade' },
    reveal:    { from: KINDS.fade, in: ['base', 'out'], out: ['fast', 'in'], reduced: 'fade' },
    dock:      { from: {},         in: ['base', 'standard'], out: ['base', 'standard'], reduced: 'instant' },
    reorder:   { from: {},         in: ['base', 'standard'], reduced: 'instant' },
    crossfade: { from: { opacity: 0.25 }, in: ['fast', 'standard'], reduced: 'fade' },
    drawer:    { from: { opacity: 0, transform: 'translateX(16px)' },
                 in: ['base', 'out'], out: ['fast', 'in'], reduced: 'fade' },
};

/**
 * What a call should play: the frame it moves from, for how long, on what curve.
 * `phase` is 'in' or 'out'. A call with `as` uses that preset; one with only
 * the older `kind`/`speed` gets the same shape with the new curves.
 */
function resolve({ as, kind, speed } = {}, phase = 'in') {
    const p = as ? PRESETS[as] : null;
    if (as && !p) console.warn(`motion: no preset "${as}"`);
    let from = p ? p.from : (KINDS[kind] || KINDS.fade);
    const [d, e] = p
        ? (phase === 'out' ? (p.out || p.in) : p.in)
        : [speed || 'fast', phase === 'out' ? 'in' : 'out'];
    let ms = dur(d), easing = curve(e);
    let still = false;
    if (reduced()) {
        still = true;
        if ((p && p.reduced === 'instant') || !('opacity' in from)) {
            ms = 0;
        } else {
            from = { opacity: from.opacity };
            ms = Math.min(ms, dur('fast'));
            easing = curve('standard');
        }
    }
    return { from, ms, easing, still };
}

function shown(node) {
    const cs = getComputedStyle(node);
    return { opacity: cs.opacity, transform: cs.transform === 'none' ? 'none' : cs.transform };
}

/** Only the properties a resolved `from` frame names, read off the node now. */
function shownAs(node, from) {
    const now = shown(node);
    if (!('transform' in from)) delete now.transform;
    if (!('opacity' in from)) delete now.opacity;
    return now;
}

/**
 * Show or hide a node by its `hidden` attribute.
 *
 * @param {string} [o.as]  a PRESETS name — `menu`, `drop`, `scrim`, `arrive`…
 * @param {'fade'|'pop'|'rise'|'drop'|'zoom'} [o.kind]  older form of `as`
 * @param {'fast'|'med'} [o.speed]  older form of `as`
 * @param {Function} [o.onGone]  after the exit, once `hidden` is written
 */
export function present(node, show, { as, kind = 'fade', speed = 'fast', onGone } = {}) {
    if (!node) return;
    if (show) {
        const was = isUp(node);
        leaving.delete(node);
        if (was && !running.has(node)) return;
        const r = resolve({ as, kind, speed }, 'in');
        const from = node.hidden ? r.from : shownAs(node, r.from);
        node.hidden = false;
        // One keyframe at 0: the end is whatever the element's own CSS says, so a
        // node dimmed by its stylesheet is not brightened for the length of this.
        play(node, [{ ...from, offset: 0 }], r);
        return;
    }
    if (node.hidden) { leaving.delete(node); return; }
    if (leaving.has(node)) return;
    leaving.add(node);
    const r = resolve({ as, kind, speed }, 'out');
    play(node, [shownAs(node, r.from), r.from], r, () => {
        leaving.delete(node);
        node.hidden = true;
        onGone && onGone();
    });
}

/**
 * Play a node out and remove it from the document. With `collapse` its height,
 * padding and margin go to nothing as it fades, so whatever is below it slides
 * up into the gap rather than jumping — except under reduced motion, where the
 * neighbours do jump, because the slide is the movement that query is about.
 */
export function exit(node, { as, kind = 'fade', speed = 'fast', collapse = false, onGone } = {}) {
    if (!node || leaving.has(node)) return;
    if (!node.isConnected) { onGone && onGone(); return; }
    leaving.add(node);
    node.style.pointerEvents = 'none';
    const done = () => { leaving.delete(node); node.remove(); onGone && onGone(); };
    const r = resolve({ as, kind, speed }, 'out');
    if (collapse && !r.still) {
        play(node, [
            { ...boxOf(node), ...shownAs(node, r.from), overflow: 'hidden' },
            { ...ZERO, ...r.from, overflow: 'hidden' },
        ], r, done);
    } else {
        play(node, [shownAs(node, r.from), r.from], r, done);
    }
}

/** Play a node in that was just put into the document. */
export function enter(node, { as, kind = 'fade', speed = 'fast', collapse = false } = {}) {
    if (!node || !node.isConnected) return;
    const r = resolve({ as, kind, speed }, 'in');
    if (collapse && !r.still) {
        const box = boxOf(node);
        play(node, [
            { ...ZERO, ...r.from, overflow: 'hidden' },
            { ...box, opacity: 1, transform: 'none', overflow: 'hidden' },
        ], r);
    } else {
        play(node, [{ ...r.from, offset: 0 }], r);
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
 * Grow a node open from nothing, or shrink it to nothing, by its height. The
 * `dock` preset; instant under reduced motion.
 *
 * Whatever shares its flex column moves with it each frame — that is the point:
 * the transcript lengthens as a dock below it closes. Padding and margin go with
 * the height, since a box at height 0 still shows them otherwise.
 *
 * @param {Function} [o.onGone]  after the shrink, once `hidden` is written —
 *   where to empty a node whose content should stay up while it closes
 */
export function grow(node, show, { as = 'dock', onGone } = {}) {
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
        ], resolve({ as }, 'in'));
        return;
    }
    if (node.hidden) { leaving.delete(node); onGone && onGone(); return; }
    if (leaving.has(node)) return;
    leaving.add(node);
    play(node, [
        { ...boxOf(node), overflow: 'hidden' },
        { ...ZERO, overflow: 'hidden' },
    ], resolve({ as }, 'out'), () => {
        leaving.delete(node);
        node.hidden = true;
        onGone && onGone();
    });
}

/**
 * Change what a node holds and animate its height from the old size to the new.
 * `mutate` runs synchronously; nothing is measured until it has.
 */
export function morph(node, mutate, { as = 'dock' } = {}) {
    if (!node || node.hidden || !node.isConnected || leaving.has(node)) { mutate(); return; }
    const from = boxOf(node).height;
    stop(node);
    mutate();
    if (node.hidden || leaving.has(node)) return;
    const to = boxOf(node).height;
    if (Math.abs(parseFloat(to) - parseFloat(from)) < 1) return;
    play(node, [{ height: from, overflow: 'hidden' }, { height: to, overflow: 'hidden' }], resolve({ as }, 'in'));
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
 * the set before and again after. The `reorder` preset; instant under reduced
 * motion, since moving is all it does.
 */
export function flipAll(root, items, keyOf, mutate, { as = 'reorder', enterNew = true } = {}) {
    const r = resolve({ as }, 'in');
    if (!root || r.ms <= 0) { mutate(); return; }
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
        if (!was) { if (enterNew) enter(c, { as: 'reveal' }); continue; }
        const now = c.getBoundingClientRect();
        const dy = was.top - now.top, dx = was.left - now.left;
        if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
        // Only what the eye can follow: a row that crossed half the screen in a
        // re-sort reads better arriving than flying.
        if (Math.abs(dy) > window.innerHeight / 2) { enter(c, { as: 'reveal' }); continue; }
        play(c, [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: 'none' },
        ], r);
    }
}

/** Fade new content in where old content was, on the same node. */
export function swap(node, mutate, { as = 'crossfade' } = {}) {
    if (!node) { mutate(); return; }
    mutate();
    if (node.hidden) return;
    const r = resolve({ as }, 'in');
    play(node, [{ ...r.from }, { opacity: 1 }], r);
}

/**
 * Replace a strip's children, growing it open when it gains its first and
 * shrinking it shut when it loses its last. The `dock` preset.
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
        ], resolve({ as: 'dock' }, 'in'));
        return;
    }
    if (!had) { if (!leaving.has(node)) node.replaceChildren(); return; }
    leaving.add(node);
    play(node, [
        { ...boxOf(node), opacity: 1, overflow: 'hidden' },
        { ...ZERO, opacity: 0, overflow: 'hidden' },
    ], resolve({ as: 'dock' }, 'out'), () => { leaving.delete(node); node.replaceChildren(); });
}

/**
 * Play a preset's entry or exit on a node that stays where it is — a dialog box
 * moving with the scrim around it, which is what writes `hidden`. Nothing is
 * hidden or removed here; `phase` says which way it goes.
 */
export function pose(node, phase, { as } = {}) {
    if (!node || !node.isConnected) return;
    const r = resolve({ as }, phase);
    if (!Object.keys(r.from).length) return;
    if (phase === 'in') play(node, [{ ...r.from, offset: 0 }], r);
    else play(node, [shownAs(node, r.from), r.from], r);
}

/**
 * Play a one-off animation on a node that stays where it is. The frames are
 * ordinary keyframes; a single frame with `offset: 0` animates from it to the
 * node's own style. Prefer a preset through pose(): frames written here are not
 * changed for reduced motion beyond the timing, so keep them to opacity.
 */
export function animate(node, frames, { speed = 'fast' } = {}) {
    if (!node) return;
    if (reduced()) frames = frames.map(({ transform, ...f }) => f);
    play(node, frames, { ms: reduced() ? Math.min(dur(speed), dur('fast')) : dur(speed), easing: curve('standard') });
}
