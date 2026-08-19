'use strict';

// Authentication for the bridge, and the one place that decides whether a request
// arrived from this machine or from somewhere else.
//
// The bridge can start a Claude Code session with bypassPermissions in any
// directory on the machine. What stood in front of that before this file existed
// was an origin check that only fires when an Origin header is present — anything
// that is not a browser simply omits it — and a header whose value is the constant
// `1`, published in this repo. Both are real guards against a page in another tab
// driving Claude, and both are kept. Neither is authentication.
//
// So: one bearer token, required on every /api/ route but /api/health.
//
// Three things are worth knowing about the shape.
//
// **Loopback is not trusted.** It would be convenient — the Electron shell and
// `npm run dev` both talk over 127.0.0.1 — but "any local process" is exactly the
// hole this closes, and two rules are harder to reason about than one. What keeps
// the browser workflow free of a login step instead is `injectToken` below: the
// bridge serves its own UI, so it can hand the page the token in a <meta> tag when
// the page is being fetched over loopback. The cost is real and lands on the
// command line — a curl against the API now needs the header. CLAUDE.md and
// README.md carry the updated form.
//
// **The token is accepted three ways** — `Authorization: Bearer`, `?token=`, and a
// cookie — because EventSource cannot set headers, and two endpoints are SSE
// (/api/events and /api/terminals/:tid/stream). A query parameter is the documented
// workaround, but it lands in history and in referrers, so it is really only there
// for the pairing handshake: GET /pair?token=… trades it for an HttpOnly cookie
// once, and everything after that — fetches and both SSE streams — authenticates by
// cookie with no token in any URL. Any one of the three being valid is enough; see
// credentials() for why that is not the same as picking the first one present.
//
// **`remote` is a fact about the socket, not about the token.** A valid token says
// who you are; the peer address says where you are, and the two answer different
// questions. Being off-machine is what withholds the pty byte pipe and
// bypassPermissions from a phone, and it is what raises the banner in the UI. See
// the refusals in server.js.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cfg = require('./config');

const COOKIE = 'cs_token';

// A year. The point of pairing is that you do it once, from a device you keep.
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** @type {string|null} */
let token = null;

/**
 * The token for this machine, created on first run.
 *
 * Shared by every bridge on the machine, including development ones in worktrees:
 * it authenticates *you*, not a checkout, and a per-port token would mean pairing
 * a phone again every time a dev bridge moved.
 *
 * 32 random bytes rather than a UUID. A UUID is 122 bits of entropy spent on 36
 * characters, four of which are hyphens announcing that it is a UUID; base64url of
 * 32 bytes is 256 bits in 43. Neither is guessable and the shorter one is less
 * miserable to type into a phone once.
 */
function ensureToken() {
    if (token) return token;

    try {
        const raw = fs.readFileSync(cfg.TOKEN_FILE, 'utf8').trim();
        if (raw) {
            token = raw;
            // A file that arrived with loose permissions — copied in, or written
            // before this line existed — is worth tightening rather than warning
            // about, since the fix needs no decision from anybody.
            try { fs.chmodSync(cfg.TOKEN_FILE, 0o600); } catch { /* best effort */ }
            return token;
        }
    } catch { /* absent or unreadable: fall through and mint one */ }

    token = crypto.randomBytes(32).toString('base64url');
    try {
        fs.mkdirSync(cfg.STATE_DIR, { recursive: true });
        // Written to a temporary name and renamed, like flags.js, so a reader can
        // never see a half-written token. Created 0600 from the start rather than
        // chmod'd afterwards: the gap between the two is small but it is real, and
        // there is no reason to have one.
        const tmp = `${cfg.TOKEN_FILE}.tmp`;
        fs.writeFileSync(tmp, token, { mode: 0o600 });
        fs.renameSync(tmp, cfg.TOKEN_FILE);
        console.log(`[claude-sessions] created an access token at ${cfg.TOKEN_FILE}`);
    } catch (err) {
        // Keep the in-memory token so this bridge still works; say plainly that it
        // will not survive a restart, because a phone paired against it will stop
        // working for no visible reason.
        console.error(`[claude-sessions] could not save the access token: ${err.message}`);
        console.error('  This bridge will accept the token it generated, but it is '
            + 'not on disk, so restarting invalidates any paired device.');
    }
    return token;
}

/** The token, or null if ensureToken() has not run yet. */
function current() {
    return token;
}

/**
 * Constant-time comparison against the token.
 *
 * timingSafeEqual throws on a length mismatch rather than returning false, so the
 * length is checked first. That leaks the token's length, which is a published
 * constant of this file and not worth protecting.
 */
function tokenMatches(candidate) {
    if (!token || typeof candidate !== 'string' || !candidate) return false;
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(token, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/** Parse a Cookie header into a plain object. Absent or malformed reads as empty. */
function cookies(req) {
    const out = {};
    const raw = req.headers.cookie;
    if (!raw) return out;
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 1) continue;
        const key = part.slice(0, eq).trim();
        if (!key || key in out) continue; // first wins, like every other parser
        try { out[key] = decodeURIComponent(part.slice(eq + 1).trim()); }
        catch { out[key] = part.slice(eq + 1).trim(); }
    }
    return out;
}

/**
 * Every credential this request presents — header, query, cookie.
 *
 * All of them, not the first one found. Picking one and rejecting the request if it
 * fails sounds tidier and is worse: a phone that is already paired, opening a
 * pairing link from before the token was last rotated, presents a stale `?token=`
 * alongside a perfectly good cookie. Preferring the query logs it out; preferring
 * the cookie means a genuinely fresh link cannot re-pair a device whose cookie went
 * stale. Accepting any one of them does both, and gives nothing away — a caller
 * holding one valid credential is authenticated whichever slot it arrived in.
 */
function credentials(req, url) {
    const out = [];
    const header = req.headers.authorization;
    if (header) {
        const m = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
        if (m) out.push(m[1].trim());
    }
    const q = url.searchParams.get('token');
    if (q) out.push(q);
    const jar = cookies(req);
    if (jar[COOKIE]) out.push(jar[COOKIE]);
    return out;
}

/** Does this request present a valid token in any of the three places? */
function authenticate(req, url) {
    // No early return: every candidate is compared, so the work done does not
    // depend on which slot held the right one.
    let matched = false;
    for (const candidate of credentials(req, url)) {
        if (tokenMatches(candidate)) matched = true;
    }
    return matched;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Did this request come from this machine?
 *
 * WSL runs with networkingMode=mirrored, so the Windows-side shell reaching us on
 * 127.0.0.1 lands here as loopback exactly as a WSL-side curl does. Anything that
 * arrived through `tailscale serve` on the Windows host also arrives on loopback,
 * which is why `remote` is not derived from this alone — see classify().
 */
function isLoopback(req) {
    const addr = req.socket && req.socket.remoteAddress;
    if (!addr) return false;
    if (LOOPBACK.has(addr)) return true;
    // 127.0.0.0/8 is all loopback, not just .1.
    return /^(::ffff:)?127\./.test(addr);
}

/**
 * Was this request forwarded by a reverse proxy in front of us?
 *
 * `tailscale serve` and cloudflared both terminate TLS and then talk to the bridge
 * over loopback, so the peer address says "local" for a request that came from a
 * phone. The forwarding headers are what distinguish them — serve sets
 * x-forwarded-for, x-forwarded-proto and x-forwarded-host — and trusting them is
 * safe *only* because the socket is loopback: nothing off-machine can reach this
 * port to forge them. A bridge bound to a non-loopback interface must not trust
 * them, and does not — the check below requires loopback first.
 */
function forwarded(req) {
    if (!isLoopback(req)) return false;
    return Boolean(req.headers['x-forwarded-for']
        || req.headers['x-forwarded-proto']
        || req.headers['x-forwarded-host']);
}

/**
 * The hostname this request was addressed to, as the client wrote it.
 *
 * A proxy that rewrites Host to the backend it is talking to preserves the original
 * in x-forwarded-host, so that is preferred where present.
 */
function effectiveHost(req) {
    const raw = req.headers['x-forwarded-host'] || req.headers.host || '';
    // A comma-separated chain means it passed through more than one proxy; the
    // first entry is what the client asked for. Then strip the port.
    const first = String(raw).split(',')[0].trim();
    return first.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

/** Was this request addressed to this machine by a local name? */
function hostIsLocal(host) {
    return host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '';
}

/**
 * Did this request reach the client over HTTPS? Decides the cookie's Secure flag.
 *
 * A `.ts.net` name counts on its own: `tailscale serve` only publishes over HTTPS
 * with a real certificate, so a request addressed to one arrived securely whether
 * or not the proxy said so. That matters because a Secure cookie set over what the
 * browser thinks is plain HTTP is simply dropped, and the pairing would fail with
 * nothing to see.
 */
function isSecure(req) {
    const proto = req.headers['x-forwarded-proto'];
    if (proto && String(proto).split(',')[0].trim().toLowerCase() === 'https') return true;
    return /\.ts\.net$/.test(effectiveHost(req));
}

/**
 * Where a request came from, for logging and for the refusals.
 *
 * A forwarded loopback request reports the phone's address rather than 127.0.0.1,
 * because 127.0.0.1 is true and useless.
 */
function peer(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd && isLoopback(req)) return String(fwd).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Everything the request gate needs, in one object.
 *
 * `ok` is about the credential. `remote` is about where the request came from, and
 * stays true for a proxied connection even though its socket is loopback — a phone
 * behind `tailscale serve` is not at the desk, whatever the peer address says.
 *
 * Three independent signals, OR'd, because this decides what a caller is allowed to
 * do and the safe direction to fail in is "treat it as remote":
 *
 *   1. the socket is not loopback — a LAN bind, the plainest case;
 *   2. forwarding headers are present — the documented behaviour of the proxies we
 *      support;
 *   3. the request was addressed to a name that is not this machine — true of
 *      `https://host.ts.net` however the proxy handles Host, and independent of
 *      whether it sets any x-forwarded-* header at all.
 *
 * Any one of those alone would be enough today. Together, a proxy that stops
 * setting a header, or starts rewriting Host, degrades into withholding powers from
 * a phone rather than quietly handing it bypassPermissions. Only a request that
 * looks local by all three measures is treated as local.
 */
function classify(req, url) {
    const remote = !isLoopback(req)
        || forwarded(req)
        || !hostIsLocal(effectiveHost(req));
    return {
        ok: authenticate(req, url),
        remote,
        secure: isSecure(req),
        host: effectiveHost(req),
        peer: peer(req),
    };
}

/**
 * Is this a request for one of our own pages, made locally by a browser?
 *
 * The condition for handing the page the token. Loopback is necessary but not
 * sufficient: a cross-origin fetch from a page on another origin also arrives on
 * loopback, and it arrives carrying an Origin header, so requiring that header to
 * be absent is what separates "the user typed this into the address bar" from
 * "some other page asked for it". Navigations do not send Origin; fetches do.
 */
function localPageRequest(req) {
    return isLoopback(req)
        && !forwarded(req)
        && hostIsLocal(effectiveHost(req))
        && !req.headers.origin;
}

/**
 * Hand the page a value it needs before its first script runs.
 *
 * Inserted after <head> rather than appended, so it is in place before any
 * module script that might read it. Idempotent, because the same body can be
 * served through more than one path.
 *
 * `content` is percent-encoded rather than HTML-escaped: the first caller
 * interpolated a hex token and got away with quoting it, and the second passes
 * JSON, which does not. One rule that cannot be got wrong beats two.
 */
function injectMeta(html, name, content) {
    if (html.includes(`name="${name}"`)) return html;
    const tag = `<meta name="${name}" content="${encodeURIComponent(content)}">`;
    return html.replace(/<head([^>]*)>/i, (m) => `${m}\n${tag}`);
}

/**
 * Put the token in the page, so a loopback browser needs no login step.
 *
 * Only ever called for a request that passed localPageRequest().
 */
function injectToken(html) {
    return injectMeta(html, 'cs-token', ensureToken());
}

/** Set-Cookie value that pairs a device, and the one that unpairs it. */
function pairCookie(value, { secure }) {
    const bits = [
        `${COOKIE}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        // Lax, not Strict: the pairing redirect is a top-level navigation and
        // Strict would drop the cookie on the way to /m. Nothing here is a
        // cross-site form post, so Lax gives up nothing that matters.
        'SameSite=Lax',
        `Max-Age=${value ? COOKIE_MAX_AGE : 0}`,
    ];
    if (secure) bits.push('Secure');
    return bits.join('; ');
}

module.exports = {
    COOKIE,
    ensureToken, current, tokenMatches,
    credentials, authenticate, cookies,
    isLoopback, forwarded, isSecure, effectiveHost, hostIsLocal, peer,
    classify, localPageRequest,
    injectToken, injectMeta, pairCookie,
};
