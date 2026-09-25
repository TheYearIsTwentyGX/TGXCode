'use strict';

// `/pair` and `/pair/forget`: turning a pasted link into a cookie.
//
// A section of server.js until the rest of it was split up, and it came out on
// its own because it needs nothing the bridge builds — only bridge/auth.js,
// which already owns the token and both cookies. It is kept apart from auth.js
// rather than folded into it because this is a response a person reads on a
// phone, and auth.js has no business writing HTML. The router still decides
// when to call it; the reasoning for the handshake is below, as it was.

const auth = require('./auth');

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
//
// The handshake that gets a browser onto the bridge from off-machine. You open one
// long URL — the token in the query — and it comes back as an HttpOnly cookie and a
// redirect to /. Afterwards nothing carries the token in a URL: fetches send the
// cookie, and so does EventSource, which is the point. EventSource cannot set
// headers, so without a cookie the only way to authenticate a stream is `?token=`
// on the stream's URL, in the page, forever.
//
// The native Android app does not come through here — it stores the token and sends
// `Authorization: Bearer`. It still depends on this URL's *shape*, because pasting
// the link the desktop's "Connect a phone" dialog generates is how the token gets
// onto the device. So the link is the contract even where the handshake is not.
//
// The router's gate in server.js has already validated the token — /pair is not
// under /api/, so it is checked here rather than there.

function pair(req, res, url, pathname, who) {
    if (pathname === '/pair/forget') {
        res.writeHead(303, {
            Location: '/',
            'Set-Cookie': auth.forgetCookies({ secure: who.secure }),
            'Cache-Control': 'no-store',
        });
        return res.end();
    }

    if (!who.ok) {
        // Deliberately plain, and deliberately not a JSON error: this is a page a
        // person just opened on a phone, and "unauthorized" in a monospace blob
        // tells them nothing about what to do.
        const body = Buffer.from('<!DOCTYPE html><meta charset="utf-8">'
            + '<meta name="viewport" content="width=device-width,initial-scale=1">'
            + '<title>TGXCode — pairing failed</title>'
            + '<style>body{font:16px/1.5 system-ui;margin:0;padding:2rem;'
            + 'background:#131314;color:#e8e8e8}code{background:#232325;padding:.15em .4em;'
            + 'border-radius:4px;font-size:.9em}</style>'
            + '<h1>That link did not work</h1>'
            + '<p>The token is missing, mistyped, or from before the bridge last '
            + 'created one.</p>'
            + '<p>Get a fresh link from <b>Connect a phone</b> in the desktop window, '
            + 'or read the token with <code>cat ~/.local/share/tgxcode/token</code>.</p>',
            'utf8');
        res.writeHead(401, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
        });
        return res.end(body);
    }

    console.log(`[tgxcode] paired ${who.peer} via ${who.host}`);
    res.writeHead(303, {
        // 303 with the token stripped, so the address bar and history keep the
        // bare / rather than the credential.
        Location: '/',
        'Set-Cookie': auth.pairCookie(auth.current(), { secure: who.secure }),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
    });
    res.end();
}

module.exports = { pair };
