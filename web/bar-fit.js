// What the top bar gives up when the window is too narrow for it — the pure
// half of fitBar() in web/settings/toolbar.js, which measures and moves nodes.
//
// Two steps, in order. First the view buttons drop their words and keep their
// icons (`compact`): every button is still on the bar, just smaller. Only when
// that is not enough do buttons leave, from the end of the bar, into the More
// menu (`spill`). The order is the one somebody chose in Settings, so the end
// of the bar is what they put last — and a button that is not `spillable`
// (the quota pill, whose popover holds Restart bridge) stays whatever happens.
//
// Pure so the decision can be tested without a browser: the caller measures,
// this decides. No DOM here.
//
// Hysteresis. Widths are measured with the bar fully laid out, so the same
// window gives the same answer and there is no loop to break. What is left is
// the edge: a badge going from 9 to 10 widens a button by a few pixels, and a
// window resized a pixel at a time sits right on the line. So taking something
// *back* — dropping compact, or spilling fewer — needs `slack` pixels of room
// to spare, while giving something up needs none. Across that band the bar
// keeps whatever it last had.
//
// Only while the window holds still. The slack is for content that jitters at
// a fixed width — a badge ticking, the quota pill's countdown changing digits —
// and not for the window itself: a bar that compacted at 1500 and was then
// widened to 1600, where the words fit with 15 to spare, stayed compact for
// good, because 15 is not 24. That is what a window opening small and then
// maximising does, so the everyday window sat in icons at a width with room
// for its labels. When `avail` has moved since `prev` was decided the answer
// is the exact one, as a media query's would be; dragging across the line
// changes the bar once per crossing, which is all a breakpoint ever does.

/**
 * @param {object} o
 * @param {number} o.avail     The bar's content width.
 * @param {number} o.fixed     Everything that is not a placeable item: the
 *                             wordmark, the search box at its smallest, gaps.
 * @param {Array<{id: string, full: number, compact: number, spillable: boolean}>} o.items
 *                             On the bar, in bar order. Widths include the gap
 *                             after the item.
 * @param {number} o.more      The More button with its gap, paid once anything
 *                             spills unless it is already showing.
 * @param {boolean} [o.moreShown]  More is up already (Settings put things in it).
 * @param {{compact: boolean, spill: string[]}} [o.prev]  What the bar has now.
 * @param {number} [o.prevAvail]  The `avail` that `prev` was planned at. When
 *                             it differs, `prev` is not held on to.
 * @param {number} [o.slack]
 * @returns {{compact: boolean, spill: string[]}}
 */
export function planBar({ avail, fixed, items, more, moreShown = false, prev = null, prevAvail, slack = 0 }) {
    const best = plan(avail, fixed, items, more, moreShown);
    if (!prev || rank(best) >= rank(prev)) return best;
    if (prevAvail !== undefined && prevAvail !== avail) return best;
    // Giving something back, which takes room to spare. If there is not that
    // much, the bar stays as it is — provided what it is still describes the
    // bar: a button spilled earlier may since have been hidden or moved.
    const loose = plan(avail - slack, fixed, items, more, moreShown);
    if (rank(loose) < rank(prev)) return loose;
    const spillable = new Set(items.filter(i => i.spillable).map(i => i.id));
    return prev.spill.every(id => spillable.has(id))
        ? { compact: prev.compact, spill: prev.spill.slice() }
        : loose;
}

/** How much a plan gives up: 0 is the whole bar, 1 compact, then one per spill. */
function rank(p) {
    return (p.compact ? 1 : 0) + p.spill.length;
}

function plan(avail, fixed, items, more, moreShown) {
    const sum = (k) => items.reduce((n, i) => n + i[k], fixed + (moreShown ? more : 0));
    if (sum('full') <= avail) return { compact: false, spill: [] };
    let total = sum('compact');
    if (total <= avail) return { compact: true, spill: [] };

    if (!moreShown) total += more;
    const spill = [];
    for (let i = items.length - 1; i >= 0 && total > avail; i--) {
        if (!items[i].spillable) continue;
        total -= items[i].compact;
        spill.unshift(items[i].id);
    }
    return { compact: true, spill };
}
