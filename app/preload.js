'use strict';

// The things the page cannot do for itself.
//
// Clicking a notification opens the right session — that is all renderer work
// and needs nothing from here. What the page cannot do is bring the window to
// the front: `window.focus()` from a renderer does not raise a background
// window on Windows, so the session opens behind whatever you were using and
// you find it only when you happen to look.
//
// The browser preview (web/preview.js) adds two more, both clipboard writes the
// page cannot make on its own: an image of a <webview> guest, which only the
// main process can capture, and the element picker's text, which is produced
// inside the guest after the click that would have granted clipboard access
// has already been swallowed. Neither returns anything but a status. A third
// tells the main process a site from a chat link may be loaded in a guest,
// which it otherwise refuses for anything but loopback.
//
// The titlebar (app/titlebar.js) adds the rest: the top bar is the window's
// titlebar, so the page tells the shell the colours and height for the native
// caption buttons, asks it to move the window when a drag starts on a button,
// and hears back whether the window is maximised or focused. The setting that
// puts the system frame back is stored by the shell, because on Windows the
// bridge's settings file is across WSL from it.
//
// And agent control of the preview (app/preview-cdp.js, app/preview-grants.js):
// turning the endpoint on and off, Stop, which page is on screen, and the
// per-site asks — raising one for open_in_preview, waiting on it, answering it.
// Two of these are pushed rather than asked for: the endpoint's state, for the
// toolbar's banner, and a new ask, for the notification.

// A preload is a hole in the wall between the page and the shell, and each door
// here is sized to the single thing on the other side of it. Anything the page
// can already do, it keeps doing itself. The main process checks every call
// came from the shell's own page — see app/main.js, fromShell().

const { contextBridge, ipcRenderer } = require('electron');

// `custom` or `system`, passed by main.js in additionalArguments; missing
// means the window was made with the system frame.
const TITLEBAR = (process.argv.find(a => a.startsWith('--tgx-titlebar=')) || '=system').split('=')[1];

contextBridge.exposeInMainWorld('claudeShell', {
    revealWindow: () => ipcRenderer.send('reveal-window'),
    capturePreview: (webContentsId) => ipcRenderer.invoke('preview-capture', webContentsId),
    copyText: (text) => ipcRenderer.invoke('preview-copy-text', String(text)),
    allowPreviewOrigin: (origin) => ipcRenderer.invoke('preview-allow-origin', String(origin)),
    titlebar: {
        style: TITLEBAR,
        platform: process.platform,
        setOverlay: (o) => ipcRenderer.send('titlebar-overlay', {
            color: String(o.color || ''), symbolColor: String(o.symbolColor || ''),
            cssHeight: Number(o.cssHeight) || 0,
        }),
        dragStart: (grabY) => ipcRenderer.send('titlebar-drag', 'start', Number(grabY) || 0),
        dragEnd: () => ipcRenderer.send('titlebar-drag', 'end'),
        onState: (cb) => {
            ipcRenderer.on('titlebar-state', (_e, st) => cb({ ...st }));
            ipcRenderer.send('titlebar-state-request');
        },
        getSetting: () => ipcRenderer.invoke('titlebar-get'),
        setSystem: (on) => ipcRenderer.invoke('titlebar-set-system', on === true),
    },
    previewAgent: {
        set: (on, origins) => ipcRenderer.invoke('preview-agent-set', {
            on: on === true,
            origins: Array.isArray(origins) ? origins.map(String) : [],
        }),
        state: () => ipcRenderer.invoke('preview-agent-state'),
        stop: () => ipcRenderer.invoke('preview-agent-stop'),
        setActive: (webContentsId) => ipcRenderer.invoke('preview-agent-active',
            Number.isInteger(webContentsId) ? webContentsId : null),
        request: (url, sessionId) => ipcRenderer.invoke('preview-agent-request',
            { url: String(url), sessionId: sessionId ? String(sessionId) : null }),
        wait: (origin, ms) => ipcRenderer.invoke('preview-agent-wait', { origin: String(origin), ms: Number(ms) }),
        answer: (origin, decision) => ipcRenderer.invoke('preview-agent-answer',
            { origin: String(origin), decision: String(decision) }),
        sessionGone: (sessionId) => ipcRenderer.invoke('preview-agent-session-gone', String(sessionId)),
        onState: (fn) => { ipcRenderer.on('preview-agent-state', (_e, s) => fn(s)); },
        onNotify: (fn) => { ipcRenderer.on('preview-agent-notify', (_e, a) => fn(a)); },
    },
});

// Marked on <html> as early as the preload can, so the bar's first paint
// already leaves room for the caption buttons. web/titlebar.js sets it again,
// which is what a page loaded before the element existed relies on.
function markFrame() {
    const root = document.documentElement;
    if (!root) return false;
    root.dataset.titlebar = TITLEBAR;
    root.dataset.platform = process.platform;
    return true;
}
if (!markFrame()) document.addEventListener('DOMContentLoaded', markFrame, { once: true });
