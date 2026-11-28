// The pure half of the rail's bulk controls and the keyboard walks — no DOM.
//
// Collapse/Expand all decides from what is drawn, not from everything that could
// be: a key for a project with no rows left is not a card on screen, and a
// button that said "Expand all" because some long-gone project was shut would
// be wrong about the rail you are looking at.
//
// The walks (next or previous session, next or previous turn) take the list in
// the order it is drawn and return the neighbour, or null at an end. They stop
// at the ends rather than wrap: Alt+Down from the last row landing on the first
// is a jump across the whole rail that looks like nothing happened.

/** True when every key in `keys` is shut. `shut(key)` answers for one. */
export function allShut(keys, shut) {
    return keys.length > 0 && keys.every(shut);
}

/**
 * The id `step` places from `current` in `ids`, or null past an end.
 * With no current one, Down starts at the top and Up at the bottom.
 */
export function stepId(ids, current, step) {
    if (!ids.length) return null;
    const i = ids.indexOf(current);
    if (i < 0) return step > 0 ? ids[0] : ids[ids.length - 1];
    const j = i + step;
    return j >= 0 && j < ids.length ? ids[j] : null;
}

/**
 * The turn to jump to from `active` (an index into the turns, or -1 when none
 * is marked), or -1 when there is none that way.
 */
export function stepTurn(count, active, step) {
    if (!count) return -1;
    if (active < 0) return step > 0 ? 0 : count - 1;
    const j = active + step;
    return j >= 0 && j < count ? j : -1;
}
