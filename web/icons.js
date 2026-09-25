// The SVG glyphs every surface draws from, and the one function that turns a
// name into an element. Moved out of app.js so that a module can call icon()
// while it is itself being evaluated — web/settings/toolbar.js builds its
// TOOLBAR table that way, and it evaluates before app.js's body has run, when
// app.js's own `const ICON` would still be in its temporal dead zone.
// web/rail.js draws the same glyphs as vnodes; this is the DOM twin.

import { el } from './dom.js';

export const ICON = {
    pin: '<path d="M9 3h6l-.7 5.2 3 2.6V13H6.7v-2.2l3-2.6L9 3Z" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linejoin="round"/><path d="M12 13v8" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round"/>',
    pencil: '<path d="M4.5 19.5 5.3 15.6 15.6 5.3a1.9 1.9 0 0 1 2.7 0l.4.4a1.9 1.9 0 0 1 0 2.7'
        + 'L8.4 18.7l-3.9.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
        + '<path d="m13.8 7.1 3.1 3.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    archive: '<path d="M3.5 6.2h17V9h-17V6.2Z" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linejoin="round"/><path d="M5 9v9.3h14V9" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linejoin="round"/><path d="M10 12.5h4" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round"/>',
    unarchive: '<path d="M12 19V9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
        + '<path d="m8.5 12.5 3.5-3.5 3.5 3.5" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 5.5h15" '
        + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    caret: '<path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round"/>',
    power: '<path d="M12 3.4v7.2" stroke="currentColor" stroke-width="2.1" '
        + 'stroke-linecap="round"/><path d="M7.5 6.6a6.4 6.4 0 1 0 9 0" stroke="currentColor" '
        + 'stroke-width="2.1" stroke-linecap="round"/>',
    // The pull-request statuses. Drawn as three families so that the icon carries
    // the state on its own and the colour only reinforces it: the branch shape is
    // the PR's own lifecycle, a speech bubble is a human's verdict on it, and a
    // bare mark is CI's. Two reds and two yellows are otherwise indistinguishable
    // to anyone who cannot separate them by hue.
    pr: '<circle cx="6.5" cy="17.5" r="2.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<circle cx="17.5" cy="6.5" r="2.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<path d="M6.5 14.9V8.5a2 2 0 0 1 2-2h6.4" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round"/>',
    // The same branch, not joined up yet. Dotted rather than dashed: a dash pattern
    // on a path this short is invisible at 13px, where round caps with gaps wider
    // than the marks change the outline instead of just its texture — and the
    // outline is the only thing that still reads at this size.
    prDraft: '<circle cx="6.5" cy="17.5" r="2.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<circle cx="17.5" cy="6.5" r="2.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<path d="M6.5 14.9V8.5a2 2 0 0 1 2-2h6.4" stroke="currentColor" '
        + 'stroke-width="1.9" stroke-linecap="round" stroke-dasharray="0.1 3.5"/>',
    // Landed: an arrow arriving at the trunk. Deliberately not another two-dots-and-
    // an-elbow — a curve is all that separated it from `pr` and at 13px that is
    // nothing, so merged leaves the branch family and takes a silhouette of its own.
    // The two still-open states keep the family; the two settled ones each stand apart.
    prMerged: '<path d="M18.8 4.6v14.8" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round"/>'
        + '<path d="M4.4 12h9.8" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round"/>'
        + '<path d="m10.6 8.3 3.9 3.7-3.9 3.7" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round"/>',
    prClosed: '<circle cx="12" cy="12" r="7.6" stroke="currentColor" stroke-width="1.8"/>'
        + '<path d="M8.3 15.7 15.7 8.3" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round"/>',
    reviewOk: '<path d="M20 14.4a2.5 2.5 0 0 1-2.5 2.5H9.3L5 20.3V6.1a2.5 2.5 0 0 1 2.5-2.5h10A2.5 '
        + '2.5 0 0 1 20 6.1Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
        + '<path d="m9.4 10.1 2 2 3.5-3.7" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round"/>',
    reviewChanges: '<path d="M20 14.4a2.5 2.5 0 0 1-2.5 2.5H9.3L5 20.3V6.1a2.5 2.5 0 0 1 2.5-2.5h10A2.5 '
        + '2.5 0 0 1 20 6.1Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
        + '<path d="M9.3 10.2h6.4" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round"/>',
    checkFail: '<path d="m6.8 6.8 10.4 10.4" stroke="currentColor" stroke-width="2.2" '
        + 'stroke-linecap="round"/><path d="M17.2 6.8 6.8 17.2" stroke="currentColor" '
        + 'stroke-width="2.2" stroke-linecap="round"/>',
    checkWait: '<circle cx="12" cy="12" r="7.6" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-dasharray="3.3 2.9"/>',
    conflict: '<path d="M12 4.3 21 19.5H3Z" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linejoin="round"/><path d="M12 9.9v3.7" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round"/><path d="M12 16.6h.01" '
        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    trash: '<path d="M4.5 6.8h15" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round"/><path d="M6.6 6.8 7.7 19a1.5 1.5 0 0 0 1.5 1.4h5.6A1.5 1.5 0 0 0 '
        + '16.3 19l1.1-12.2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
        + '<path d="M9.6 6.8V4.6a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v2.2" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linejoin="round"/>',
    // Two sheets. The back one is only the edges of a sheet rather than a second
    // whole rectangle: at 14px two nested outlines 5px apart read as a smudge.
    copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.4" stroke="currentColor" '
        + 'stroke-width="1.8"/><path d="M6.2 15.5H5.8A2.3 2.3 0 0 1 3.5 13.2V5.8A2.3 2.3 '
        + '0 0 1 5.8 3.5h7.4a2.3 2.3 0 0 1 2.3 2.3v.4" stroke="currentColor" '
        + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    // The tick that says a copy landed. A glyph rather than the character, for the
    // reason .ev-copy gives: text in a row is text the find walker indexes and a
    // drag-selection of the message picks up.
    tick: '<path d="m5 12.8 4.4 4.4L19 6.6" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round"/>',
    // A card with two lines written on it, which is what a snippet is and what a
    // row in the popover shows. Deliberately not a lightning bolt or a pair of
    // scissors: every glyph in this map is the thing rather than a metaphor for it.
    snippets: '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.6" '
        + 'stroke="currentColor" stroke-width="1.8"/><path d="M7.6 9.6h8.8M7.6 13.4h5.8" '
        + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    // Wispr Flow, pared down to two lines of flowing air. It stands for the app it
    // hands the text to, the way a brand mark does, rather than for an action.
    wispr: '<path d="M3.5 9.5c2.2-2.6 4.6-2.6 7 0s5 2.6 7.2 0c.9-1 1.8-1.5 2.8-1.6'
        + 'M3.5 15.5c2.2-2.6 4.6-2.6 7 0s5 2.6 7.2 0c.9-1 1.8-1.5 2.8-1.6" '
        + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    // Six dots, the shape every drag handle in every list is. Used in the settings
    // editor, where a row can be dragged as well as walked with the arrow buttons.
    grip: '<path d="M9 6.5h.01M15 6.5h.01M9 12h.01M15 12h.01M9 17.5h.01M15 17.5h.01" '
        + 'stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
    // Three dots stacked, which is what an overflow menu is everywhere else and
    // so needs no label. `grip` above is the six-dot drag handle; they are
    // different things and are drawn differently on purpose.
    dots: '<path d="M12 6h.01M12 12h.01M12 18h.01" stroke="currentColor" '
        + 'stroke-width="2.6" stroke-linecap="round"/>',
};

// Which glyph says each PR status. `unknown` is gh being unreachable rather than a
// state a PR can be in, so it borrows the plain branch and the CSS leaves it grey:
// a header that cannot reach GitHub says no less than it used to, and claims no more.
export const PR_ICON = {
    open: 'pr',
    unknown: 'pr',
    draft: 'prDraft',
    merged: 'prMerged',
    closed: 'prClosed',
    approved: 'reviewOk',
    changes: 'reviewChanges',
    'checks-failed': 'checkFail',
    'checks-pending': 'checkWait',
    conflicting: 'conflict',
};

export function icon(name, size = 15) {
    return el('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': 'true', html: ICON[name],
    });
}
