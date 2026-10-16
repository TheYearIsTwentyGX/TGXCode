// Keeping a textarea's caret in sight after a splice the browser did not type.
//
// A composer at its max height scrolls inside itself, and nothing brought that
// scroll to the caret after an insertion from code. The edit lands, the `input`
// listener re-sizes the box (`grow()` in send.js, through a `height: auto` pass),
// and the box is left scrolled wherever it was before: measured on the live
// composer, a twenty-five-line snippet expanded at the end of a full box put the
// caret at 1221px and left `scrollTop` at 456, so the box showed its own middle.
// Typing does not have the problem because the browser reveals the caret on each
// keystroke; a splice is one keystroke that moves the caret a thousand pixels.
//
// A textarea has no caret rect, so the caret's line is measured with a mirror: an
// off-screen div given the box's width, padding and type, holding the text up to
// the caret and a marker after it. The marker's offset is the line's top in the
// box's own scroll coordinates. The arithmetic after that is `revealTop`, which is
// pure, so test/caret.test.js can pin it under node. Nothing here imports, for the
// same reason.

/**
 * The scrollTop that shows [top, bottom) in a viewport `height` tall, moving as
 * little as it can: unchanged when the line is already in view, else just far
 * enough that it sits at the nearer edge.
 *
 * @returns {number}
 */
export function revealTop({ top, bottom, scrollTop, height, max = Infinity }) {
    let next = scrollTop;
    if (bottom > scrollTop + height) next = bottom - height;
    if (top < next) next = top;
    return Math.max(0, Math.min(next, max));
}

// What has to match for text to wrap in the mirror where it wraps in the box.
const MIRRORED = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent',
    'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
];

/**
 * The caret's line in `ta`'s scroll coordinates, as {top, bottom}.
 */
export function caretLine(ta, at = ta.selectionEnd) {
    const cs = getComputedStyle(ta);
    const m = document.createElement('div');
    for (const k of MIRRORED) m.style[k] = cs[k];
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    Object.assign(m.style, {
        position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px',
        boxSizing: 'content-box', border: '0', overflow: 'hidden',
        whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: cs.wordBreak,
        // clientWidth leaves the scrollbar out, which is the width text wraps in.
        width: `${Math.max(0, ta.clientWidth - pad)}px`,
    });
    m.textContent = ta.value.slice(0, at);
    const mark = document.createElement('span');
    mark.textContent = '​';
    m.appendChild(mark);
    document.body.appendChild(m);
    const top = mark.offsetTop;
    const bottom = top + mark.offsetHeight;
    m.remove();
    return { top, bottom };
}

/**
 * Scroll `ta` so the caret's line is visible. Call it after the box has been
 * sized: before that its height, and so what "visible" means, is still moving.
 */
export function revealCaret(ta) {
    if (!ta || !ta.isConnected || ta.scrollHeight <= ta.clientHeight) return;
    const { top, bottom } = caretLine(ta);
    // The box's bottom padding too, so a caret on the last line sits where typing
    // would leave it rather than flush against the edge.
    const pad = parseFloat(getComputedStyle(ta).paddingBottom) || 0;
    ta.scrollTop = revealTop({
        top, bottom: bottom + pad, scrollTop: ta.scrollTop, height: ta.clientHeight,
        max: ta.scrollHeight - ta.clientHeight,
    });
}
