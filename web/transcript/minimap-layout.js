// Where things go on the minimap — web/transcript/turn-rail.js draws it.
//
// Pure: no DOM, no state, no imports, so test/minimap.test.js can import it
// under Node and pin the arithmetic that a screen would only ever show as "a
// mark looks slightly wrong".
//
// Decided:
//
// - **Positioned by turn, not by bytes or by pixels.** Every message you sent
//   gets an equal share of the rail, so "a third of the way down" means a third
//   of the conversation as you had it, whether the turn in the middle wrote 4KB
//   or 40MB. A byte-proportional map is one huge turn with a smear at each end.
//   Inside its turn a mark is placed by byte offset (`at`), which is the only
//   measure the index has of things it has not drawn.
// - **Marks that arrived live have no offset.** The rendered log does not know
//   bytes, so those are spread by order over the part of their turn after the
//   last mark that has one. Reopening the session puts them where the index says.
// - **Clustered per lane, by pixels.** A busy session has thousands of edits and
//   a rail of a few hundred pixels. Marks in the same lane closer than a few
//   pixels become one, which keeps the most telling kind (an error over an edit)
//   and a count, so the rail still says what is there and the tooltip says how
//   many.

/**
 * Which column of the rail a kind is drawn in. Failures get a lane to
 * themselves: a long session has a hundred of them, and anything sharing their
 * lane would be clustered under one. A pull request goes with the work instead,
 * where it outranks every edit near it.
 */
export const LANE = {
    turn: 'mid', plan: 'mid', question: 'mid',
    edit: 'left', subagent: 'left', pr: 'left',
    error: 'right',
};

/** When marks share a cluster, the kind it is drawn as. Higher wins. */
export const PRIORITY = {
    edit: 1, turn: 2, subagent: 3, question: 4, plan: 5, pr: 6, error: 7,
};

/**
 * The closest two marks in a lane may be, in pixels. It is also how tall a
 * mark's button is (`.mm-mark` in transcript.css), and the two have to agree:
 * buttons closer than they are tall overlap, and the later one takes the click
 * meant for the one under it.
 */
export const MARK_GAP = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Give every mark a position `y` in [0, 1].
 *
 * `marks` are in document order, each `{ kind, turn, at }`: `turn` is the
 * ordinal of the message it belongs to (-1 before the first), `at` its byte
 * offset or null if it arrived live. `starts[i]` is turn i's byte offset, or
 * null for a turn that arrived live; `end` is where the file ended when the
 * index was read. Returns new objects with `y` added, in the same order.
 */
export function placeMarks(marks, starts, end) {
    const total = Math.max(1, starts.length);
    const byTurn = new Map();
    for (const m of marks) {
        const t = m.turn < 0 ? -1 : m.turn;
        if (!byTurn.has(t)) byTurn.set(t, []);
        byTurn.get(t).push(m);
    }
    const out = new Map();
    for (const [t, group] of byTurn) {
        if (t < 0) { for (const m of group) out.set(m, 0); continue; }
        const start = starts[t];
        let stop = null;
        for (let j = t + 1; j < starts.length && stop === null; j++) stop = starts[j];
        if (stop === null) stop = end;
        const span = start != null && stop != null && stop > start ? stop - start : 0;
        // Never quite the next turn's line: a mark at 0.999 drawn on top of the
        // next message reads as belonging to it.
        const fracOf = (m) => (m.kind === 'turn' ? 0
            : span && m.at != null ? clamp((m.at - start) / span, 0, 0.95) : null);
        let last = 0;
        const live = [];
        for (const m of group) {
            const f = fracOf(m);
            if (f === null) live.push(m);
            else { out.set(m, f); last = Math.max(last, f); }
        }
        live.forEach((m, k) => out.set(m, last + (0.95 - last) * (k + 1) / (live.length + 1)));
        for (const m of group) out.set(m, (t + out.get(m)) / total);
    }
    return marks.map(m => ({ ...m, y: clamp(out.get(m), 0, 1) }));
}

/**
 * Merge marks in the same lane that would sit within `gap` pixels of each
 * other on a rail `height` pixels tall. Each cluster is
 * `{ lane, kind, px, lead, members }`: drawn as its highest-priority kind
 * (`lead`), at its first member's position. The first and not the lead's,
 * because clusters start at least `gap` apart and only their starts are known
 * to be — drawing at the lead could put two buttons on top of each other.
 */
export function clusterMarks(placed, height, gap = MARK_GAP) {
    const lanes = new Map();
    for (const m of placed) {
        const lane = LANE[m.kind] || 'mid';
        if (!lanes.has(lane)) lanes.set(lane, []);
        lanes.get(lane).push(m);
    }
    const out = [];
    for (const [lane, list] of lanes) {
        const sorted = list.slice().sort((a, b) => a.y - b.y);
        let cur = null;
        for (const m of sorted) {
            const px = m.y * height;
            if (cur && px - cur.from < gap) { cur.members.push(m); continue; }
            cur = { lane, from: px, members: [m] };
            out.push(cur);
        }
    }
    return out.map(({ lane, from, members }) => {
        let lead = members[0];
        for (const m of members) if ((PRIORITY[m.kind] || 0) > (PRIORITY[lead.kind] || 0)) lead = m;
        return { lane, kind: lead.kind, px: from, lead, members };
    }).sort((a, b) => a.px - b.px);
}

/**
 * The fractional turn at page position `p`, given the loaded turns' tops.
 *
 * `count` loaded turns, `topOf(i)` the top of the i'th, `endTop` the bottom of
 * the log. Binary search, because the caller runs this every scroll frame and
 * each `topOf` is a layout read. Above the first loaded turn is 0; past the
 * end is `count`.
 */
export function turnAt(p, count, topOf, endTop) {
    if (!count) return 0;
    if (p < topOf(0)) return 0;
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (topOf(mid) <= p) lo = mid; else hi = mid - 1;
    }
    const top = topOf(lo);
    const next = lo + 1 < count ? topOf(lo + 1) : endTop;
    const frac = next > top ? clamp((p - top) / (next - top), 0, 1) : 0;
    return lo + frac;
}

/**
 * The viewport as `[y0, y1]` in the minimap's coordinates. `first` is the
 * ordinal of the first loaded turn and `total` the number of turns there are;
 * the rest is `turnAt`'s.
 */
export function viewBand({ viewTop, viewBottom, count, topOf, endTop, first, total }) {
    const n = Math.max(1, total);
    const y0 = (first + turnAt(viewTop, count, topOf, endTop)) / n;
    const y1 = (first + turnAt(viewBottom, count, topOf, endTop)) / n;
    return [clamp(y0, 0, 1), clamp(Math.max(y0, y1), 0, 1)];
}
