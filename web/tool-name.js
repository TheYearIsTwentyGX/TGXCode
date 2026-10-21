// A tool's name as a person reads it: `mcp__tgxcode__set_summary` is drawn as
// "TGXCode: Set Summary", and `Bash` stays `Bash`.
//
// Display only. Everything that *matches* on a tool name — toolSummary's
// `__message_session` suffix, the orchestrator tools, REVIEWABLE, the hooks
// editor's matcher field — keeps reading the raw name, and every label drawn
// with this carries the raw name in its `title`, because the raw name is what a
// permission rule or a hook matcher is written against.
//
// bridge/tool-name.js is the same function for the strings the bridge composes
// (the activity line, notification text), which the Android app reads as-is.
// Two copies because web/ is ES modules served off disk and bridge/ is CommonJS
// with no build step between them; test/tool-name.test.js runs both over the
// same names and fails if they ever disagree, so change them together.

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
export function toolDisplayName(name) {
    if (typeof name !== 'string' || !name.startsWith('mcp__')) return name;
    const rest = name.slice(5);
    const at = rest.indexOf('__');
    if (at <= 0 || at + 2 >= rest.length) return name;
    return `${serverName(rest.slice(0, at))}: ${words(rest.slice(at + 2))}`;
}
