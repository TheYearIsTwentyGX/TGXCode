// The preview's pages, as words and lists — the decisions without the DOM.
//
// web/preview.js holds the pages; this is what it says about them, on its own so
// test/preview-pages.test.js can run it in node. Imports nothing.
//
//  - **The address bar.** It used to be a fixed `http://` label, a host and a
//    path box, built for `localhost:<port>` and wrong for every other site:
//    https://pcpartpicker.com read as http://. Now it shows the page's real URL
//    by one rule — the scheme is shown only when it is worth a second look:
//
//        https://example.com/a?b   ->  example.com/a?b
//        http://example.com/a      ->  http://example.com/a
//        http://localhost:5173/x   ->  localhost:5173/x
//        https://example.com/      ->  example.com
//
//    https is the expected case and plain http on a public host is the one to
//    notice, which is Chrome's rule. Loopback is the exception: a dev server is
//    plain http by nature and nothing is wrong with it, so it reads as
//    `localhost:5173/x`, the way it is spoken. Editing shows the whole URL, so
//    nothing is hidden from someone who goes to change it.
//
//  - **What you type.** `:5173` or `5173/path` is a local port, a leading `/` is
//    a path on the page you are on, `localhost:…` is http, and anything with a
//    dot in its first segment is a site, https unless you said http. What is
//    left — `path/to/page`, the old box's placeholder — is a path on the page
//    you are on, as it always was.
//
//  - **The list of pages.** Every page the pane holds, port or site, with who
//    opened it and whether an agent is on it — the way back to a page you left,
//    which for a site had none: a dev server is in its session's port strip, and
//    a site an agent opened was nowhere once you looked away.
//
//  - **Keep-alive.** A page an agent is attached to, or one whose site is waiting
//    on your answer, is not dropped by the keep-alive clock. Dropping it would
//    leave the agent holding a page that no longer exists.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// A first segment that is a file rather than a host: `index.html` typed into a
// dev server's bar means the page, not a site called index.html.
const FILEISH = /\.(html?|php|m?js|json|css|txt|xml|svg|png|jpe?g|gif|webp|ico|map)$/i;

export function isLoopback(hostname) {
    return LOOPBACK.has(String(hostname || '').toLowerCase());
}

export function originOf(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch { return null; }
}

export function hostOf(url) {
    try { return new URL(url).host; } catch { return String(url || ''); }
}

/** A URL as the bar shows it while nobody is editing it. See the header. */
export function displayAddress(url) {
    let u;
    try { u = new URL(url); } catch { return String(url || ''); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href;
    const scheme = u.protocol === 'http:' && !isLoopback(u.hostname) ? 'http://' : '';
    const rest = u.pathname + u.search + u.hash;
    return scheme + u.host + (rest === '/' ? '' : rest);
}

/**
 * What a typed address means. `current` is the URL of the page on screen, for
 * paths; `localHost` is the loopback name the pane uses for ports (web/preview.js
 * says why it is not always `localhost`).
 *
 * @returns {{url: string, port: number|null}|null}  `port` for a local port,
 *   null for anything else; null overall when it is not an http(s) address.
 */
export function parseAddress(text, current = null, localHost = 'localhost') {
    const t = String(text || '').trim();
    if (!t) return null;
    const http = (url) => {
        let u;
        try { u = new URL(url); } catch { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        const port = u.protocol === 'http:' && isLoopback(u.hostname) && u.port ? Number(u.port) : null;
        return { url: u.href, port };
    };

    const port = /^:?(\d{1,5})([/?#].*)?$/.exec(t);
    if (port) {
        const n = Number(port[1]);
        if (n < 1 || n > 65535) return null;
        const rest = port[2] || '/';
        return http(`http://${localHost}:${n}${rest.startsWith('/') ? '' : '/'}${rest}`);
    }
    if (/^https?:\/\//i.test(t)) return http(t);
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(t)) return http(`http://${t}`);

    const first = t.split(/[/?#]/)[0];
    if (t.startsWith('/') || t.startsWith('?') || t.startsWith('#')) {
        return current ? http(new URL(t, current).href) : null;
    }
    if (/\s/.test(first)) return null;
    if (first.includes('.') && !FILEISH.test(first)) return http(`https://${t}`);
    // Anything else with a scheme-like prefix (`javascript:`, `file:`) is not ours.
    if (/^[a-z][a-z0-9+.-]*:/i.test(first)) return null;
    return current ? http(new URL(`/${t}`, current).href) : null;
}

/**
 * Whether the keep-alive clock must leave a page alone. `page` is
 * `{wcId, url, base}`; `agent` is the shell's state for the preview
 * ({connected, pages: [{webContentsId, url}], asks: [{origin}]}).
 */
export function pinnedPage(page, agent) {
    if (!page || !agent) return false;
    if (agent.connected && page.wcId != null
        && (agent.pages || []).some(p => p.webContentsId === page.wcId)) return true;
    const mine = new Set([originOf(page.url), page.base].filter(Boolean));
    return (agent.asks || []).some(a => mine.has(a.origin));
}

/**
 * The pane's pages as a list a menu can draw, in the order they were opened.
 *
 * @param {Iterable<object>} entries   web/preview.js's entries
 * @param {object} o
 * @param {object} [o.agent]           as for pinnedPage
 * @param {*} [o.activeKey]            the page on screen, if the pane is
 * @param {(id: string) => string|null} [o.sessionName]
 */
export function pageRows(entries, { agent = null, activeKey = null, sessionName = () => null } = {}) {
    const rows = [];
    for (const e of entries) {
        const host = hostOf(e.url || e.base) || `localhost:${e.port}`;
        const controlled = Boolean(agent && agent.connected && e.wcId != null
            && (agent.pages || []).some(p => p.webContentsId === e.wcId));
        const mine = new Set([originOf(e.url), e.base].filter(Boolean));
        rows.push({
            key: e.key,
            kind: e.port ? 'port' : 'site',
            label: e.pageTitle || e.title || host,
            host,
            address: displayAddress(e.url || e.base || ''),
            url: e.url || e.base || '',
            sessionId: e.sessionId || null,
            session: e.sessionId ? (sessionName(e.sessionId) || null) : null,
            agent: controlled,
            asking: Boolean(agent && (agent.asks || []).some(a => mine.has(a.origin))),
            active: e.key === activeKey,
        });
    }
    return rows;
}

/**
 * The pages an agent is on that are not on screen, for the "Agent is using the
 * preview" chip in a conversation: those this session opened, and those nobody
 * is known to have opened (a page reached by the agent navigating, or opened
 * from a chat link before it was taken over), which every session shows.
 */
export function agentAway(rows, { sessionId = null, onScreenKey = null } = {}) {
    return rows.filter(r => r.agent && r.key !== onScreenKey
        && (!r.sessionId || r.sessionId === sessionId));
}
