// The top bar as the window's titlebar — the page's half of app/titlebar.js.
//
// Only in the desktop app, and only when it was started with the custom frame
// (`window.claudeShell.titlebar.style`, from app/preload.js). In a browser, or
// in a shell packaged before this existed, nothing here runs and the bar is the
// bar it always was: `web/` is served live and goes out ahead of the shell, so
// "no titlebar API" is a state this file has to treat as ordinary.
//
// Three jobs:
//
//   - **Room for the window controls.** The caption buttons are the OS's,
//     drawn over the page; the Window Controls Overlay rect says where they are
//     not, and the bar's padding (`--tb-left`, `--tb-right` in base.css) is set
//     from it so nothing on the bar sits under them. Without the API the CSS
//     falls back to a measured width per platform.
//   - **Their colours.** `color` and `symbolColor` are read from the theme
//     tokens and sent again whenever the theme, the zoom or the window's focus
//     changes, so the buttons are the bar's colour rather than a grey box, and
//     dim with it when the window is in the background.
//   - **Drag-through.** A press on a bar button that travels four pixels moves
//     the window instead of clicking — web/titlebar-drag.js decides, the shell
//     moves it. The blank parts of the bar need none of this: they are
//     `-webkit-app-region: drag`, and the OS moves the window from them itself.

import { IDLE, pressStep } from './titlebar-drag.js';

const shell = window.claudeShell && window.claudeShell.titlebar;

/** Whether the top bar is the window's titlebar in this window. */
export const customTitlebar = !!shell && shell.style === 'custom';

// What a press on the bar may start a drag from. Text boxes are left out on
// purpose: dragging across one selects text, and that has to keep working.
const CARRIERS = 'button, a[href], label, [role="button"], .quota-wrap, .bar-more-wrap';
const NOT_CARRIERS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), '
    + '.bar-more-menu, .quota-menu, [role="menu"], [role="dialog"]';

export function initTitlebar() {
    if (!shell) return;
    const root = document.documentElement;
    root.dataset.titlebar = shell.style;
    root.dataset.platform = shell.platform;
    if (!customTitlebar) return;

    const bar = document.querySelector('.bar');
    if (!bar) return;

    let focused = document.hasFocus();
    let fullscreen = false;
    let sent = '';

    const push = () => {
        const o = {
            color: tokenColor('--bg'),
            symbolColor: tokenColor(focused ? '--text-2' : '--text-4'),
            cssHeight: Math.round(bar.getBoundingClientRect().height) || 52,
        };
        const key = JSON.stringify(o);
        if (key === sent) return;
        sent = key;
        shell.setOverlay(o);
    };

    const wco = navigator.windowControlsOverlay;
    const geometry = () => {
        // Full screen has no caption buttons to leave room for.
        if (fullscreen) {
            root.style.setProperty('--tb-left', '0px');
            root.style.setProperty('--tb-right', '0px');
            return;
        }
        if (!wco || !wco.visible) {
            root.style.removeProperty('--tb-left');
            root.style.removeProperty('--tb-right');
            return;
        }
        const r = wco.getTitlebarAreaRect();
        root.style.setProperty('--tb-left', `${Math.max(0, Math.round(r.x))}px`);
        root.style.setProperty('--tb-right',
            `${Math.max(0, Math.round(window.innerWidth - r.x - r.width))}px`);
    };

    if (wco) wco.addEventListener('geometrychange', geometry);
    window.addEventListener('resize', () => { geometry(); push(); });

    shell.onState((st) => {
        focused = !!st.focused;
        fullscreen = !!st.fullscreen;
        root.dataset.windowFocus = focused ? 'on' : 'off';
        root.toggleAttribute('data-window-max', !!st.maximized);
        root.toggleAttribute('data-window-full', fullscreen);
        geometry();
        push();
    });

    // A theme is tokens on :root, so a change to it is a change to <html>'s
    // attributes or inline style — or the OS's scheme, for a theme that follows it.
    new MutationObserver(push).observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', push);
    // The bar's own height can change with a stylesheet edit or a narrow layout.
    new ResizeObserver(push).observe(bar);

    geometry();
    push();
    wireDrag(bar);
}

/** A theme token as `#rrggbb`, which is what the overlay's colour parser wants. */
function tokenColor(name) {
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    const m = rgb.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return '';
    return '#' + m.slice(0, 3).map(v => Math.round(Number(v)).toString(16).padStart(2, '0')).join('');
}

function wireDrag(bar) {
    let st = IDLE;
    let carrier = null;
    let eatClick = false;
    let grabY = 0;   // how far below the window's top the press was, CSS px
    const root = document.documentElement;

    const act = (action, ev) => {
        if (action === 'drag-start') {
            // Captured so the release still reaches us while the window, and the
            // page with it, is moving under the pointer.
            try { carrier.setPointerCapture(ev.pointerId); } catch { /* best effort */ }
            root.setAttribute('data-window-dragging', '');
            shell.dragStart(grabY);
        } else if (action === 'drag-end') {
            shell.dragEnd();
            root.removeAttribute('data-window-dragging');
            // The click that follows this release is the drag's, not the button's.
            eatClick = true;
            setTimeout(() => { eatClick = false; }, 0);
        }
        if (st.phase === 'idle') carrier = null;
    };

    const step = (ev, domEv) => {
        const [next, action] = pressStep(st, ev);
        st = next;
        act(action, domEv);
    };

    bar.addEventListener('pointerdown', (e) => {
        const t = e.target instanceof Element ? e.target : null;
        const r = bar.getBoundingClientRect();
        const onBar = !!t && e.clientY >= r.top && e.clientY <= r.bottom;
        const draggable = onBar && e.pointerType === 'mouse'
            && !t.closest(NOT_CARRIERS) && !!t.closest(CARRIERS);
        if (draggable) carrier = t.closest(CARRIERS);
        step({ type: 'down', id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button, draggable }, e);
        if (st.phase === 'pressed') grabY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
        if (st.phase !== 'pressed') return;
        step({ type: 'move', id: e.pointerId, x: e.clientX, y: e.clientY }, e);
    }, true);
    window.addEventListener('pointerup', (e) => {
        if (st.phase === 'idle') return;
        step({ type: 'up', id: e.pointerId }, e);
    }, true);
    const cancel = (e) => { if (st.phase !== 'idle') step({ type: 'cancel' }, e); };
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel(e); }, true);
    bar.addEventListener('lostpointercapture', cancel);

    // First in line for every click on the page, so nothing downstream sees it.
    window.addEventListener('click', (e) => {
        if (!eatClick) return;
        eatClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);
}
