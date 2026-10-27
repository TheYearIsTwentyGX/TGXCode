// Is a press on a titlebar button a click or a window drag? The pure half of
// web/titlebar.js, which listens for the pointer and talks to the shell.
//
// The blank parts of the bar are `-webkit-app-region: drag` and the OS moves
// the window from them on its own. A button cannot be one — a drag region
// swallows the click — so a button carries the drag itself: press and let go
// where you pressed and it is a click, press and travel `threshold` pixels and
// it is a window drag, and the click that would follow the release is eaten.
//
// A reducer rather than an object with listeners, so the whole of what a
// sequence of pointer events means can be tested without a browser. The
// caller does the side effects the action names.
//
// States:   idle → pressed → dragging → idle
// Actions:  'drag-start'  start moving the window (once, on crossing the threshold)
//           'drag-end'    stop moving it; the click that follows must be eaten
//           'click'       released without moving: let the click through
//           null          nothing to do

export const DRAG_THRESHOLD = 4;

export const IDLE = Object.freeze({ phase: 'idle' });

/**
 * @param {{phase: string, id?: number, x?: number, y?: number}} st
 * @param {{type: 'down'|'move'|'up'|'cancel', id?: number, x?: number, y?: number,
 *          button?: number, draggable?: boolean}} ev
 *   `draggable` on a `down` says the press landed on something that may carry
 *   a drag: a button on the bar, not a text box, not an open menu, never the
 *   window controls (those are the OS's and the page never sees them).
 * @param {number} [threshold]
 * @returns {[object, string|null]} The next state and the action.
 */
export function pressStep(st, ev, threshold = DRAG_THRESHOLD) {
    switch (ev.type) {
    case 'down':
        // A second pointer while one is down is ignored rather than restarting:
        // a touch landing during a mouse drag must not jump the window.
        if (st.phase !== 'idle') return [st, null];
        if (!ev.draggable || ev.button !== 0) return [IDLE, null];
        return [{ phase: 'pressed', id: ev.id, x: ev.x, y: ev.y }, null];

    case 'move':
        if (st.phase !== 'pressed' || ev.id !== st.id) return [st, null];
        // Euclidean, so a diagonal drag starts at the same distance a straight one does.
        if (Math.hypot(ev.x - st.x, ev.y - st.y) < threshold) return [st, null];
        return [{ phase: 'dragging', id: st.id }, 'drag-start'];

    case 'up':
        if (ev.id !== st.id) return [st, null];
        if (st.phase === 'pressed') return [IDLE, 'click'];
        if (st.phase === 'dragging') return [IDLE, 'drag-end'];
        return [IDLE, null];

    case 'cancel':
        // Lost capture, a blurred window, Escape: a drag that was moving the
        // window stops where it is, and a press that had not moved yet becomes
        // nothing — not a click somebody did not finish.
        if (st.phase === 'dragging') return [IDLE, 'drag-end'];
        return [IDLE, null];

    default:
        return [st, null];
    }
}
