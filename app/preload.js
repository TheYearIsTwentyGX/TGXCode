'use strict';

// The one thing the page cannot do for itself.
//
// Clicking a notification opens the right session — that is all renderer work
// and needs nothing from here. What the page cannot do is bring the window to
// the front: `window.focus()` from a renderer does not raise a background
// window on Windows, so the session opens behind whatever you were using and
// you find it only when you happen to look.
//
// So exactly one door, taking no arguments and returning nothing. A preload is
// a hole in the wall between the page and the shell, and this one is sized to
// the single thing on the other side of it. Anything the page can already do,
// it keeps doing itself.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeShell', {
    revealWindow: () => ipcRenderer.send('reveal-window'),
});
