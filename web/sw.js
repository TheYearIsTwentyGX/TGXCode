'use strict';

// A service worker, for one reason only: buttons on a notification.
//
// The Notifications API will not put actions on a plain `new Notification()`.
// They exist solely on the persistent kind, shown through a registration —
// which means a worker, even though there is nothing here to work on. Nothing
// else about this app goes through it. In particular there is no `fetch`
// handler: this worker never serves a request, so it cannot serve a stale one,
// and editing web/ and refreshing behaves exactly as it did before.
//
// What it buys is real, though. A button press is handled here rather than in
// the page, so answering a permission does not depend on the window being
// open, focused, or even still on that session.
//
// Chromium allows two actions (`Notification.maxActions`), which is why
// "Allow all session" is not among them — it is the rarest of the three and
// the one most worth reading the card before choosing. Body-click opens the
// card, where all three live.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
    const data = event.notification.data || {};
    event.notification.close();

    // Only the two answering actions are handled without the window; anything
    // else — including a click on the body — is a request to go and look.
    if (event.action === 'allow' || event.action === 'deny') {
        event.waitUntil(answer(data, event.action));
    } else {
        event.waitUntil(reveal(data));
    }
});

/**
 * Answer over the same route the card uses.
 *
 * A failure here is quiet on purpose. Losing the race — the ask already
 * answered in a window, or the turn stopped out from under it — comes back
 * 409, and that is an ordinary outcome, not something to shout about from a
 * worker with nowhere to shout. The card is the durable surface either way.
 */
async function answer(data, decision) {
    if (!data.sessionId || !data.requestId) return;
    try {
        await fetch(`/api/sessions/${encodeURIComponent(data.sessionId)}/permission`, {
            method: 'POST',
            headers: {
                'X-Claude-Sessions-Client': '1',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ requestId: data.requestId, decision }),
        });
    } catch { /* nothing here can usefully recover; the card still can */ }
}

/**
 * Bring a window to this session.
 *
 * `client.focus()` is the standard move and is enough in a browser. In the
 * packaged shell it is not — raising a window past the Windows foreground
 * lock is the main process's job — so the page is asked to do the rest, since
 * it is the side holding the preload bridge.
 */
async function reveal(data) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
        client.postMessage({ type: 'reveal-session', sessionId: data.sessionId || null });
        try { await client.focus(); } catch { /* focus is best effort */ }
        return;
    }
    // No window left to talk to — open one. The session it should land on
    // rides in the hash, which app.js reads on load.
    const url = data.sessionId ? `/#/session/${encodeURIComponent(data.sessionId)}` : '/';
    await self.clients.openWindow(url);
}
