// Which links from chat open in the browser preview, and which go to the
// system browser as they always have.
//
// `preview.links` turns it on. `preview.list` is one list of patterns, and
// `preview.listMode` says what it is: 'block' opens everything in the preview
// except what matches, 'allow' opens only what matches. Nothing is refused
// outright — a link that is not for the preview goes where it went before this
// existed, so a wrong pattern costs a browser tab and never a lost link.
//
// A pattern is one of:
//   example.com         that host and any subdomain of it
//   *.example.com       subdomains only
//   github.com/org/     a URL prefix: anything with a `/` in it. The scheme is
//                       optional, and without one either http or https matches.
// Hosts compare case-insensitively; a path prefix compares as written. Blank
// entries and `#` comments are ignored, so a list pasted with notes in it
// still works.
//
// Pure, so test/link-policy.test.js imports it without a DOM.

/** A pattern, normalised, or null for a blank line, a comment or nonsense. */
export function cleanPattern(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || s.startsWith('#') || /\s/.test(s)) return null;
    const m = /^(?:(https?):\/\/)?([^/?#]+)(.*)$/i.exec(s);
    if (!m) return null;
    const scheme = m[1] ? m[1].toLowerCase() : null;
    let host = m[2].toLowerCase();
    const wild = host.startsWith('*.');
    if (wild) host = host.slice(2);
    // A port is part of the host as written: `localhost:5173`.
    if (!/^[a-z0-9.\-_:[\]]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) return null;
    return { scheme, host, wild, path: m[3] || '' };
}

/** Whether `url` (a string or a URL) matches one pattern string. */
export function matches(url, pattern) {
    const p = typeof pattern === 'string' ? cleanPattern(pattern) : pattern;
    if (!p) return false;
    let u;
    try { u = url instanceof URL ? url : new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (p.scheme && u.protocol !== `${p.scheme}:`) return false;
    const host = (p.host.includes(':') ? u.host : u.hostname).toLowerCase();
    const hostOk = p.wild
        ? host.endsWith(`.${p.host}`)
        : host === p.host || host.endsWith(`.${p.host}`);
    if (!hostOk) return false;
    if (!p.path) return true;
    return (u.pathname + u.search + u.hash).startsWith(p.path);
}

/**
 * Whether a link clicked in chat opens in the preview. `prefs` is the
 * `preview` settings section; anything missing reads as the default.
 */
export function opensInPreview(url, prefs = {}) {
    if (!prefs || prefs.links !== true) return false;
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const list = Array.isArray(prefs.list) ? prefs.list : [];
    const hit = list.some((p) => matches(u, p));
    return prefs.listMode === 'allow' ? hit : !hit;
}
