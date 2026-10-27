// An agent driving the browser preview — this window's part of it.
//
// The endpoint Playwright connects to is the shell's (app/preview-cdp.js), and
// the grants and the asks live there too (app/preview-grants.js), in the main
// process, so that they survive a reload of this page. What is left for the page:
//
//  - **Turning it on.** `preview.agentControl` is a setting, and the page is what
//    reads settings, so the page tells the shell to start or stop the endpoint
//    and registers the URL it gets with the bridge (POST /api/preview/agent),
//    where a session's Playwright finds it (bridge/preview-mcp.js). The sites the
//    user always allows (`preview.agentOrigins`) go to the shell the same way.
//  - **open_in_preview.** The bridge broadcasts `preview-open`; this asks the
//    shell whether the URL may open, opens it or raises the ask, and tells the
//    bridge how it went. A window that cannot do any of this stays quiet, so a
//    plain browser tab cannot answer for the desktop app.
//  - **What the user sees.** Under the preview's toolbar: one bar per open ask —
//    "An agent wants to open example.com — Allow once / Always allow / Deny" —
//    and, while an agent is connected, "Agent is controlling this page" with the
//    page's site and a Stop button. Drawn with Preact; see web/rail.js for why.
//
// An ask never times out (app/preview-grants.js says why). open_in_preview waits
// a minute for it and then reports `waiting`; a yes that comes later opens the
// page here, because the shell hands back the URL to open with the answer.

import { html, render } from './vendor/preact.js';
import { del, post, put } from './api.js';
import { BOOT_PREFS } from './boot.js';
import { announce } from './notifications.js';
import { hostOf, openForAgent } from './preview-open.js';

const shell = window.claudeShell && window.claudeShell.previewAgent;

let o = null;          // {root, pane, showPreview, previewOpen, toast}
let st = { enabled: false, connected: false, active: false, pages: [], asks: [] };
let registered = null; // the endpoint this bridge was last told

/** Whether this window can be driven at all: the desktop shell, new enough. */
export const canDrivePreview = Boolean(shell);

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root         the bar under the preview's toolbar
 * @param {object} opts.pane              the PreviewPane
 * @param {(on: boolean) => void} opts.showPreview
 * @param {() => boolean} opts.previewOpen
 * @param {(text: string, kind?: string) => void} opts.toast
 */
export function wirePreviewAgent(opts) {
    o = opts;
    if (!shell) return;
    shell.onState((s) => { if (s) { st = s; paint(); } });
    shell.onNotify((ask) => announceAsk(ask));
    shell.state().then((s) => { if (s) { st = s; paint(); } }).catch(() => {});
    syncPreviewAgent();
}

/**
 * Make the shell and the bridge agree with the settings. Called at start-up and
 * whenever `preview` changes, from this window or another.
 */
export async function syncPreviewAgent() {
    if (!shell) return;
    const p = BOOT_PREFS.preview || {};
    const on = p.agentControl === true;
    const r = await shell.set(on, p.agentOrigins || []).catch(() => null);
    if (!r || !r.ok) {
        if (on && r && r.error) o.toast(`Could not let agents drive the preview: ${r.error}`, 'error');
        return;
    }
    try {
        if (r.endpoint && r.endpoint !== registered) {
            await post('/api/preview/agent', { endpoint: r.endpoint });
            registered = r.endpoint;
        } else if (!r.endpoint && registered !== false) {
            await del('/api/preview/agent');
            registered = false;
        }
    } catch { registered = null; /* the next sync tries again */ }
}

/** The bridge came back after a restart: tell it again, in case it lost the file. */
export function previewAgentReconnected() {
    registered = null;
    syncPreviewAgent();
}

/** The page on screen changed; the endpoint lists it first. */
export function previewAgentActive(webContentsId) {
    if (shell) shell.setActive(Number.isInteger(webContentsId) ? webContentsId : null).catch(() => {});
}

/** A session's process went away: asks only it wanted end with it. */
export function previewAgentRunner(s) {
    if (shell && s && s.state === 'stopped' && s.sessionId) shell.sessionGone(s.sessionId).catch(() => {});
}

/** Show a URL in the preview pane. */
async function show(url) {
    o.showPreview(true);
    return o.pane.openUrl(url);
}

/** The bridge's `preview-open`: open_in_preview, from an agent. See web/preview-open.js. */
export async function previewAgentOpen(req) {
    if (!shell || !req || !req.id || BOOT_PREFS.preview.agentControl !== true) return;
    await openForAgent(req, {
        shell,
        answer: (body) => post(`/api/preview/open/${encodeURIComponent(req.id)}`, body).catch(() => {}),
        show,
        reveal: () => { if (!o.previewOpen()) o.showPreview(true); },
    });
}

/** The user's answer to one ask. */
async function decide(ask, decision) {
    const r = await shell.answer(ask.origin, decision).catch(() => null);
    if (!r || !r.ok) { o.toast('Could not answer that — the request may have gone.', 'error'); return; }
    if (decision === 'always') await rememberAlways(ask.origin);
    if (r.open) show(r.open);
}

/** Add an origin to `preview.agentOrigins`, which is where Always is kept. */
async function rememberAlways(origin) {
    const list = [...new Set([...(BOOT_PREFS.preview.agentOrigins || []), origin])];
    try {
        const answer = await put('/api/prefs', { scope: 'user', patch: { preview: { agentOrigins: list } } });
        Object.assign(BOOT_PREFS.preview, (answer.prefs && answer.prefs.preview) || {});
    } catch (err) {
        o.toast(`Allowed for now, but could not save it for next time: ${err.message}`, 'error');
    }
}

/**
 * A new ask, or one still open ten minutes on (the shell decides which, and
 * never sends a third). On screen, the bar is enough; away, a notification.
 */
function announceAsk(ask) {
    if (!o.previewOpen()) o.showPreview(true);
    if (document.hasFocus()) return;
    announce(`An agent wants to open ${ask.host}`,
        'It is asking to drive that site in the TGXCode preview. Allow or deny it there.', 'ask', null);
}

// ── drawing ──────────────────────────────────────────────────────────────

function controlledSite() {
    if (!st.connected || !st.pages.length) return null;
    const active = o.pane.activeWebContentsId && o.pane.activeWebContentsId();
    const page = st.pages.find(p => p.webContentsId === active) || st.pages[0];
    return page && page.url ? hostOf(page.url) : null;
}

function AskBar({ ask }) {
    return html`<div class="pv-ask" role="alert">
        <span class="pv-ask-text">Agent wants to open <strong>${ask.host}</strong></span>
        <span class="pv-ask-url" title=${ask.url}>${ask.url}</span>
        <button class="pv-ask-btn" type="button" onClick=${() => decide(ask, 'once')}>Allow once</button>
        <button class="pv-ask-btn" type="button" onClick=${() => decide(ask, 'always')}>Always allow</button>
        <button class="pv-ask-btn deny" type="button" onClick=${() => decide(ask, 'deny')}>Deny</button>
    </div>`;
}

function Banner() {
    const site = controlledSite();
    return html`<div class=${`pv-driving${st.active ? ' active' : ''}`} role="status">
        <span class="pv-driving-dot" aria-hidden="true"></span>
        <span class="pv-driving-text">Agent is controlling this page${site ? html` — <strong>${site}</strong>` : ''}</span>
        <button class="pv-ask-btn" type="button" title="Disconnect the agent from the preview. The page stays as it is."
            onClick=${() => shell.stop().then(() => o.toast('Agent disconnected from the preview.')).catch(() => {})}>Stop</button>
    </div>`;
}

function paint() {
    if (!o) return;
    const asks = st.asks || [];
    o.root.hidden = !(st.connected || asks.length);
    render(html`${asks.map(a => html`<${AskBar} key=${a.origin} ask=${a} />`)}
        ${st.connected ? html`<${Banner} key="banner" />` : null}`, o.root);
}

/** Redraw after the page on screen changed: the banner names its site. */
export function paintPreviewAgent() { paint(); }
