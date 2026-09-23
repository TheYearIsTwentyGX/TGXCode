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
// has already been swallowed. Neither returns anything but a status.
//
// A preload is a hole in the wall between the page and the shell, and each door
// here is sized to the single thing on the other side of it. Anything the page
// can already do, it keeps doing itself. The main process checks every call
// came from the shell's own page — see app/main.js, fromShell().

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeShell', {
    revealWindow: () => ipcRenderer.send('reveal-window'),
    capturePreview: (webContentsId) => ipcRenderer.invoke('preview-capture', webContentsId),
    copyText: (text) => ipcRenderer.invoke('preview-copy-text', String(text)),
});
