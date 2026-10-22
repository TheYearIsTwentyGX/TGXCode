// Whether the live board stays up over a whole-screen panel, and how it docks
// there — Settings › Live board › Live board visibility, the `live.over*` keys.
//
// `side` and `stacked` are layouts. They used to be conditions: keep the board
// only while the dock toggle happened to say the same thing, so the one toggle
// could bring the board along or leave it behind. Nobody reads a radio labelled
// *Stacked* that way. Set every screen to Stacked with the toggle on Side by
// side — the arrangement you want beside a conversation — and the board was
// covered on every screen, which is the setting not working as far as anyone
// looking at it can tell. So now Stacked means stacked under that screen,
// whatever the toggle says, and `always` is the one that follows the toggle.
//
// Pure, so test/live-over.test.js imports it without a DOM.

/**
 * How the board docks over a panel, or null when the panel covers it.
 *
 * @param {string} rule the panel's `live.over*` value; anything unknown is
 *   `hidden`, the default
 * @param {string} dock the board's dock toggle, `side` or `bottom`
 * @returns {'side'|'bottom'|null}
 */
export function liveOverDock(rule, dock) {
    if (rule === 'side') return 'side';
    if (rule === 'stacked') return 'bottom';
    if (rule === 'always') return dock === 'side' ? 'side' : 'bottom';
    return null;
}

/** Whether the rule decides the arrangement itself, leaving the toggle out of it. */
export const liveOverFixed = (rule) => rule === 'side' || rule === 'stacked';
