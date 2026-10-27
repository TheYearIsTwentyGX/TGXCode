'use strict';

// Where an agent finds the preview it may drive, and how it asks for a page.
//
// The page the user sees is held by the desktop shell (a <webview>, see
// web/preview.js), which may be on the other side of a WSL boundary, and the
// endpoint that lets Playwright drive it lives there too: app/preview-cdp.js.
// This module is the bridge's two small parts of that arrangement.
//
// **The endpoint.** When `preview.agentControl` is on, the window starts the
// shell's endpoint and posts its URL here (POST /api/preview/agent), and it is
// written to `preview-agent-<port>.json` in STATE_DIR, mode 0600. A file rather
// than memory so a bridge restart does not strand the sessions it adopts, and per
// port so a development window never hands its preview to the everyday one's
// agents. bridge/preview-mcp.js reads the file each time Playwright connects,
// which is why a window that restarted with a new port and token is picked up by
// sessions that were already running. The URL carries the shell's token; nothing
// here puts it on a command line.
//
// It is validated as exactly what app/preview-cdp.js produces — loopback, a port,
// one hex token — because whatever is in that file is where every session's
// Playwright connects.
//
// **Opening a page.** open_in_preview (bridge/mcp.js) asks for a URL; the bridge
// broadcasts `preview-open` and waits for a window to say how it went. A window
// that cannot hold an agent-driven page (a plain browser, a shell too old to have
// the endpoint) stays quiet rather than saying no, so a browser tab left open
// beside the desktop app cannot answer for it.
//
// A local page opens at once. Any other site has to be approved by the user, per
// origin, in the preview pane (app/preview-grants.js holds the grants and the
// asks), and the user may be away from the desk. The ask itself never times out;
// the window waits a minute for it and then answers `waiting`, and the page opens
// by itself if the user allows it later. So a window that is asking says so first
// (`{pending: true}`), which stretches this side's wait from the few seconds that
// detect "no window" to a little over the window's minute.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = require('./config');

const ENDPOINT_RE = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})\/([0-9a-f]{32,128})$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const OPEN_WAIT_MS = Number(process.env.TGXCODE_PREVIEW_OPEN_WAIT_MS) || 8000;
// The window's minute (web/preview-agent.js), and a little for the answer to travel.
const ASK_WAIT_MS = Number(process.env.TGXCODE_PREVIEW_ASK_WAIT_MS) || 75_000;

const fileFor = (port = cfg.PORT, dir = cfg.STATE_DIR) => path.join(dir, `preview-agent-${port}.json`);

/** The endpoint as a URL object, or null when it is not one the shell would mint. */
function parseEndpoint(s) {
    const m = ENDPOINT_RE.exec(String(s || ''));
    if (!m) return null;
    const port = Number(m[2]);
    if (!(port > 0 && port < 65536)) return null;
    return { endpoint: m[0], host: m[1], port, token: m[3] };
}

function register(endpoint, { port, dir } = {}) {
    const p = parseEndpoint(endpoint);
    if (!p) return { ok: false, error: 'not a preview endpoint' };
    const file = fileFor(port, dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ endpoint: p.endpoint, at: Date.now() }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true };
}

function clear({ port, dir } = {}) {
    try { fs.unlinkSync(fileFor(port, dir)); } catch { /* already gone */ }
}

/** {endpoint, host, port, token, at} or null. */
function read({ port, dir } = {}) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(fileFor(port, dir), 'utf8')); } catch { return null; }
    const p = raw && parseEndpoint(raw.endpoint);
    return p ? { ...p, at: Number(raw.at) || null } : null;
}

/**
 * A URL an agent may ask to open: http(s), no credentials. Whether it opens at
 * once or asks the user first is the window's decision, not this one's.
 */
function checkOpenUrl(url) {
    let u;
    try { u = new URL(String(url || '')); } catch { return { ok: false, error: 'not a URL' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'only http and https URLs open in the preview' };
    if (u.username || u.password) return { ok: false, error: 'a URL with credentials in it is not opened' };
    return { ok: true, url: u.href, local: LOOPBACK.has(u.hostname) };
}

// ── open requests ────────────────────────────────────────────────────────

/** web/preview-open.js's `waitingText`, word for word; test/preview-mcp.test.js holds them together. */
function waitingText(url) {
    let host;
    try { host = new URL(url).host; } catch { host = String(url); }
    return `Waiting for the user to approve ${host}. The prompt stays open until they `
        + 'answer, and the page opens in the preview by itself when they allow it. Check back later, or call '
        + 'open_in_preview again to see the outcome.';
}

const pending = new Map();   // id -> {resolve, timer}

/**
 * Ask the windows to open a URL and wait for one to say how it went.
 *
 * @param {{url: string, sessionId?: string|null}} req
 * @param {(event: string, data: object) => void} broadcast
 * @param {number} listeners  how many windows are connected at all
 * @returns {Promise<{ok: boolean, error?: string, title?: string}>}
 */
function requestOpen({ url, sessionId = null }, broadcast, listeners) {
    if (!listeners) {
        return Promise.resolve({ ok: false, outcome: 'no-window', error: 'no TGXCode window is open to show it in' });
    }
    const id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
        const p = { resolve, timer: null };
        // Once a window has said it is asking, silence means it went away mid-ask —
        // reloaded, most likely. The ask itself is the shell's and outlives the page
        // (app/preview-grants.js), and a yes still opens the URL, so the agent is
        // told it is waiting, which is true, rather than that nobody answered.
        p.arm = (ms, asking) => {
            clearTimeout(p.timer);
            p.timer = setTimeout(() => {
                pending.delete(id);
                resolve(asking
                    ? { ok: false, outcome: 'waiting', error: waitingText(url) }
                    : {
                        ok: false,
                        outcome: 'no-window',
                        error: 'no window answered. The desktop app may be closed or built before agent '
                            + 'control existed, or TGXCode is open only in a plain browser, which cannot be driven.',
                    });
            }, ms);
            p.timer.unref?.();
        };
        p.arm(OPEN_WAIT_MS, false);
        pending.set(id, p);
        broadcast('preview-open', { id, url, sessionId });
    });
}

/**
 * A window's answer to a `preview-open`: `{pending: true}` while it asks the
 * user, then `{ok, outcome?, error?}`. False when nobody was waiting.
 */
function answerOpen(id, result) {
    const p = pending.get(id);
    if (!p) return false;
    if (result && result.pending === true) { p.arm(ASK_WAIT_MS, true); return true; }
    pending.delete(id);
    clearTimeout(p.timer);
    const r = { ok: Boolean(result && result.ok) };
    if (result && typeof result.outcome === 'string') r.outcome = result.outcome.slice(0, 40);
    if (result && typeof result.error === 'string') r.error = result.error.slice(0, 400);
    if (result && typeof result.url === 'string') r.url = result.url.slice(0, 2000);
    p.resolve(r);
    return true;
}

module.exports = { parseEndpoint, register, clear, read, fileFor, checkOpenUrl, requestOpen, answerOpen, waitingText };
