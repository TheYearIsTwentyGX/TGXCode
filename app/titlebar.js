'use strict';

// The window's titlebar, which is the app's top bar.
//
// A native titlebar is a 30-odd pixel row that says "TGXCode" above a 52 pixel
// bar that also says TGXCode. So the native one goes (`titleBarStyle: 'hidden'`)
// and the top bar in web/index.html takes its jobs: it is where the window is
// dragged from, and the minimise / maximise / close buttons sit at its right end
// — on macOS, the traffic lights at its left.
//
// **The window controls stay native.** `titleBarOverlay` asks Electron to draw
// the real caption buttons over the page, which is what keeps Windows' Snap
// Layouts flyout on hovering maximise, the buttons' accessibility names, and the
// OS's own hit-testing. Drawing three buttons in HTML would lose all of that, and
// the only thing it would win — styling — is covered by `color` and
// `symbolColor`, which the page sends from its theme tokens (web/titlebar.js).
// The overlay's height is in DIP while the bar's is in CSS pixels, so the page
// sends the CSS height and this multiplies by the zoom factor, again on every
// zoom change, so Ctrl + and Ctrl - keep the buttons the height of the bar.
//
// **Drag-through.** Blank parts of the bar are `-webkit-app-region: drag`, which
// is the OS's own window move: Aero Snap, double-click to maximise, the system
// menu on right-click. A button cannot be a drag region and still be clicked, so
// for those the page runs a small state machine (web/titlebar-drag.js): press and
// release is a click; press and move 4px is a window drag, which arrives here as
// drag-start and is done by polling the cursor and moving the window until
// drag-end. That path is JavaScript and cannot reach the OS's move loop, so it
// has no Snap Layouts, no edge snapping beyond the top-edge maximise emulated in
// endDrag(), and no Aero Shake. docs/manual.md §The titlebar says the same to the
// user.
//
// **The way back.** `systemTitlebar` in shell-prefs.json (in the shell's
// userData — this is a property of the window, not of the bridge, and on Windows
// the shell cannot read the bridge's ~/.tgxcode across WSL anyway) puts the
// native frame back on the next start. TGXCODE_SYSTEM_TITLEBAR=1 does the same
// without a file, for the day the custom bar is what is broken.

const fs = require('fs');
const path = require('path');

const PREFS_FILE = 'shell-prefs.json';

// The bar is 52 CSS pixels (web/css/base.css, `.app`); this is what the overlay
// starts at before the page has said anything. Clamped so a zoomed-out window
// still has buttons you can hit and a zoomed-in one does not grow caption
// buttons the size of a thumb.
const DEFAULT_CSS_HEIGHT = 52;
const MIN_HEIGHT = 28;
const MAX_HEIGHT = 72;

// How often the drag loop reads the cursor. 8 ms is a little above a 120 Hz
// display, and each tick that has not moved costs one comparison.
const DRAG_TICK_MS = 8;
// A drag the page never ended — a pointerup lost to a crashed renderer — must
// not leave the window glued to the cursor for good.
const DRAG_LIMIT_MS = 120_000;

function readPrefs(userData) {
    try {
        const raw = fs.readFileSync(path.join(userData, PREFS_FILE), 'utf8');
        const v = JSON.parse(raw.replace(/^﻿/, ''));
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

function writePrefs(userData, patch) {
    const next = { ...readPrefs(userData), ...patch };
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, PREFS_FILE), JSON.stringify(next, null, 2) + '\n');
    return next;
}

/** Custom unless the setting or the environment asks for the system frame. */
function wantsCustom(prefs, env = process.env) {
    if (/^(1|true|yes)$/i.test(String(env.TGXCODE_SYSTEM_TITLEBAR || ''))) return false;
    return prefs.systemTitlebar !== true;
}

function clampHeight(cssHeight, zoomFactor) {
    const h = Math.round((Number(cssHeight) || DEFAULT_CSS_HEIGHT) * (Number(zoomFactor) || 1));
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));
}

/**
 * The BrowserWindow options for each platform. Pure: what the window is
 * created with is the one part of this that a test can see without Electron.
 *
 * macOS keeps its traffic lights and moves them down to sit in the middle of
 * the bar; `titleBarOverlay: true` there is what turns on the Window Controls
 * Overlay geometry (env(titlebar-area-x) and friends) the page reads to leave
 * room for them.
 */
function windowOptions(platform, custom, colors = {}) {
    if (!custom) return {};
    if (platform === 'darwin') {
        return {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 18, y: Math.round((DEFAULT_CSS_HEIGHT - 14) / 2) },
            titleBarOverlay: true,
        };
    }
    return {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: colors.color || '#131314',
            symbolColor: colors.symbolColor || '#c4c7c5',
            height: DEFAULT_CSS_HEIGHT,
        },
    };
}

/**
 * Where a maximised window goes when it is dragged off the top of the screen:
 * its restored size, placed so the cursor holds the same fraction of the
 * window's width it held before — grab the bar three-quarters of the way along
 * and you are still three-quarters of the way along a window half the width —
 * and the same distance below its top edge.
 *
 * @param {{x: number, y: number}} cursor  Screen point, DIP.
 * @param {{x: number, y: number, width: number, height: number}} from  The maximised bounds.
 * @param {{width: number, height: number}} normal  What it restores to.
 * @param {number} grabY  The cursor's distance below the window's top, DIP.
 */
function restoredBounds(cursor, from, normal, grabY) {
    const frac = from.width > 0 ? (cursor.x - from.x) / from.width : 0.5;
    const ratio = Math.max(0, Math.min(1, frac));
    const y = Math.max(0, Math.min(normal.height - 1, Math.round(grabY)));
    return {
        x: Math.round(cursor.x - ratio * normal.width),
        y: Math.round(cursor.y - y),
        width: normal.width,
        height: normal.height,
    };
}

/** A colour string Electron's parser takes; anything else is refused. */
function cleanColor(v) {
    return typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(v.trim())
        ? v.trim() : null;
}

// The IPC is registered once for the process — ipcMain.handle throws on a
// second registration, and macOS's `activate` can make a second window — and
// always speaks to the window attached most recently.
let current = null;
let registered = false;

function registerIpc(ipcMain, fromShell, userData) {
    if (registered) return;
    registered = true;
    ipcMain.on('titlebar-overlay', (event, o) => {
        const c = current;
        if (!c || !fromShell(event) || !o || typeof o !== 'object') return;
        const color = cleanColor(o.color);
        const symbolColor = cleanColor(o.symbolColor);
        if (color) c.overlay.color = color;
        if (symbolColor) c.overlay.symbolColor = symbolColor;
        if (Number.isFinite(o.cssHeight) && o.cssHeight > 0) c.overlay.cssHeight = o.cssHeight;
        c.applyOverlay();
    });
    ipcMain.on('titlebar-drag', (event, phase, grabY) => {
        const c = current;
        if (!c || !fromShell(event) || !c.custom) return;
        if (phase === 'start') c.startDrag(Number.isFinite(grabY) ? grabY : 16);
        else c.endDrag();
    });
    ipcMain.on('titlebar-state-request', (event) => { if (current && fromShell(event)) current.send(); });
    ipcMain.handle('titlebar-get', (event) => {
        if (!current || !fromShell(event)) return { ok: false, error: 'refused' };
        return {
            ok: true,
            custom: current.custom,
            systemTitlebar: readPrefs(userData).systemTitlebar === true,
            forcedByEnv: !wantsCustom({}),
        };
    });
    ipcMain.handle('titlebar-set-system', (event, on) => {
        if (!current || !fromShell(event) || typeof on !== 'boolean') return { ok: false, error: 'refused' };
        try {
            writePrefs(userData, { systemTitlebar: on });
            return { ok: true, systemTitlebar: on, restartNeeded: on === current.custom };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });
}

/**
 * Wire one window to its page. `fromShell(event)` is main.js's check that an
 * IPC call came from the shell's own page and not a <webview> guest.
 */
function attach({ win, ipcMain, screen, fromShell, custom, userData, platform }) {
    const overlay = { color: null, symbolColor: null, cssHeight: DEFAULT_CSS_HEIGHT };
    let drag = null;

    const send = () => {
        if (win.isDestroyed()) return;
        win.webContents.send('titlebar-state', {
            maximized: win.isMaximized(),
            fullscreen: win.isFullScreen(),
            focused: win.isFocused(),
            zoom: win.webContents.getZoomFactor(),
        });
    };

    const applyOverlay = () => {
        if (!custom || platform === 'darwin' || win.isDestroyed()) return;
        if (typeof win.setTitleBarOverlay !== 'function') return;
        const opts = { height: clampHeight(overlay.cssHeight, win.webContents.getZoomFactor()) };
        if (overlay.color) opts.color = overlay.color;
        if (overlay.symbolColor) opts.symbolColor = overlay.symbolColor;
        // Not every Linux build of Electron implements it; the overlay then
        // keeps the colours it was created with, which is a cosmetic loss.
        try { win.setTitleBarOverlay(opts); } catch { /* see above */ }
    };

    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
        win.on(ev, send);
    }
    win.webContents.on('did-finish-load', send);
    win.webContents.on('zoom-changed', () => setImmediate(() => { applyOverlay(); send(); }));

    const stopDrag = () => {
        if (!drag) return null;
        clearInterval(drag.timer);
        const done = drag;
        drag = null;
        return done;
    };

    const startDrag = (grabY) => {
        stopDrag();
        if (win.isFullScreen()) return;
        const cursor = screen.getCursorScreenPoint();
        let bounds = win.getBounds();
        if (win.isMaximized()) {
            const next = restoredBounds(cursor, bounds, win.getNormalBounds(),
                grabY * win.webContents.getZoomFactor());
            win.unmaximize();
            win.setBounds(next);
            bounds = next;
        }
        const off = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
        const size = { width: bounds.width, height: bounds.height };
        let last = cursor;
        const started = Date.now();
        drag = {
            timer: setInterval(() => {
                if (win.isDestroyed() || Date.now() - started > DRAG_LIMIT_MS) { stopDrag(); return; }
                const c = screen.getCursorScreenPoint();
                if (c.x === last.x && c.y === last.y) return;
                last = c;
                // setBounds, not setPosition: across monitors with different
                // scale factors setPosition alone lets Windows resize the window.
                win.setBounds({ x: c.x - off.x, y: c.y - off.y, ...size });
            }, DRAG_TICK_MS),
        };
    };

    const endDrag = () => {
        if (!stopDrag() || win.isDestroyed()) return;
        // The one piece of Aero Snap the JS path can give back: let go at the
        // top edge of the screen and the window maximises, as it would have from
        // the blank part of the bar. Not on macOS, where nothing does that.
        if (platform === 'darwin' || !win.isResizable()) return;
        const c = screen.getCursorScreenPoint();
        const { workArea } = screen.getDisplayNearestPoint(c);
        if (c.y <= workArea.y + 1) win.maximize();
    };

    current = { custom, overlay, applyOverlay, startDrag, endDrag, send };
    registerIpc(ipcMain, fromShell, userData);

    // A reload or navigation mid-drag leaves no page to send drag-end.
    // Electron 31 puts the details on the event and still passes them
    // positionally (deprecated); read whichever is there.
    win.webContents.on('did-start-navigation', (e, _url, inPlace, isMain) => {
        const main = typeof e?.isMainFrame === 'boolean' ? e.isMainFrame : isMain;
        const same = typeof e?.isSameDocument === 'boolean' ? e.isSameDocument : inPlace;
        if (main && !same) stopDrag();
    });
    win.on('closed', stopDrag);

    return { applyOverlay, send };
}

module.exports = {
    DEFAULT_CSS_HEIGHT, MIN_HEIGHT, MAX_HEIGHT,
    readPrefs, writePrefs, wantsCustom, clampHeight, windowOptions, restoredBounds, cleanColor, attach,
};
