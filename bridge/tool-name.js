'use strict';

// A tool's name as a person reads it — `mcp__tgxcode__set_summary` becomes
// "TGXCode: Set Summary" — for the strings the bridge composes itself: the
// activity line (`Running TGXCode: Set Summary`), approval and notification
// text. The Android app draws those strings as they arrive, so the name has to
// be friendly before it leaves here.
//
// The same function as web/tool-name.js, which says why there are two copies;
// test/tool-name.test.js fails if they disagree, so change them together.
// Display only: nothing here should match on what this returns.

// Servers whose name the general rule would get wrong. Keyed on the server as it
// appears in the tool name, and again on what is left after the `claude_ai_` or
// `plugin_<x>_` prefix comes off, so `plugin_design_figma` finds `figma`.
const SERVERS = {
    tgxcode: 'TGXCode',
    claude_ai_Claude_Docs: 'Claude Docs',
    github: 'GitHub',
    gitlab: 'GitLab',
    figma: 'Figma',
    'amplitude-eu': 'Amplitude EU',
    hubspot: 'HubSpot',
    devbrowser: 'DevBrowser',
};

// Words that read wrong in Title Case. A plural keeps its `s` lower: "List PRs".
const ACRONYMS = new Set(['api', 'url', 'pr', 'id', 'mcp', 'apk', 'ui', 'html', 'json', 'css',
    'sql', 'http', 'https', 'ai', 'ci', 'cli', 'ssh', 'pdf', 'csv', 'eu', 'uuid']);

/** Split snake_case, kebab-case and camelCase into Title Case words. */
function words(s) {
    return String(s)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map(w => {
            const lower = w.toLowerCase();
            if (ACRONYMS.has(lower)) return lower.toUpperCase();
            if (/s$/.test(lower) && ACRONYMS.has(lower.slice(0, -1))) return lower.slice(0, -1).toUpperCase() + 's';
            if (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
            return w[0].toUpperCase() + w.slice(1);
        })
        .join(' ');
}

function serverName(server) {
    if (SERVERS[server]) return SERVERS[server];
    const bare = server.replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '');
    return SERVERS[bare] || SERVERS[bare.toLowerCase()] || words(bare);
}

/**
 * The name to draw for a tool. Anything that is not `mcp__<server>__<tool>`
 * comes back untouched, built-ins included.
 */
function toolDisplayName(name) {
    if (typeof name !== 'string' || !name.startsWith('mcp__')) return name;
    const rest = name.slice(5);
    const at = rest.indexOf('__');
    if (at <= 0 || at + 2 >= rest.length) return name;
    return `${serverName(rest.slice(0, at))}: ${words(rest.slice(at + 2))}`;
}

module.exports = { toolDisplayName };
