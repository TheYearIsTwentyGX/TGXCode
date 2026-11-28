'use strict';

// An MCP tool call, read the same way whichever CLI made it.
//
// The tools bridge/mcp.js gives a session reach the transcript in two shapes:
//
//   Claude Code  a `tool_use` block named `mcp__<server>__<tool>`, its `input`
//                the arguments — `mcp__tgxcode__suggest_session`.
//   Codex        an `mcpToolCall` item (`mcp_tool_call` once bridge/codex/items.js
//                has made a `tool` event of it) carrying `server`, `tool` and
//                `arguments` as separate fields — `{server: "tgxcode",
//                tool: "suggest_session"}` (docs/plans/23-codex.md, Phase 4).
//
// `mcpCall` reads either as `{server, tool, input}`, so everything that asks
// "is this one of ours, and which" asks it once. The suffix rule stays: a Claude
// name is matched on its last segment, because the middle one is the server's
// name in `--mcp-config`, which is ours to choose and could be namespaced
// differently tomorrow. A Codex call names its server outright, so it is matched
// on `tgxcode` — or on the pre-rename `claude-sessions`, which no Codex session
// was ever started with but costs nothing to accept.

const OUR_SERVERS = new Set(['tgxcode', 'claude-sessions']);

/**
 * `{server, tool, input}` for an MCP tool call in either shape, or null for any
 * other block. `server` is null for a Claude name, whose middle segment is not
 * read (see above).
 */
function mcpCall(block) {
    if (!block || typeof block !== 'object') return null;
    // Codex: the wire/rollout item, or the tool event items.js makes of it.
    if (block.type === 'mcpToolCall' || block.name === 'mcp_tool_call') {
        const src = block.type === 'mcpToolCall' ? block : (block.input || {});
        if (typeof src.tool !== 'string' || !src.tool) return null;
        const args = src.arguments;
        return {
            server: typeof src.server === 'string' ? src.server : null,
            tool: src.tool,
            input: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
        };
    }
    const name = typeof block.name === 'string' ? block.name : '';
    const m = /^mcp__.+__([^_].*)$/.exec(name);
    if (!m) return null;
    return { server: null, tool: m[1], input: block.input || {} };
}

/** Is `block` a call to `tool` on our own MCP server? */
function isOurs(block, tool) {
    const c = mcpCall(block);
    if (!c || c.tool !== tool) return false;
    return c.server === null || OUR_SERVERS.has(c.server);
}

/**
 * A `suggest_session` call as a card, or null for any other tool.
 *
 * `cwd` falls back to the entry's own working directory rather than being left
 * empty: the agent is being asked for the exception, not the rule, and a card
 * with nowhere to run is a card with a broken button.
 *
 * @param {object} block  a Claude `tool_use` block, or a Codex `mcpToolCall` item
 *   (or the `mcp_tool_call` tool event made of one); `id` is the card's id
 * @param {{timestamp?: string, cwd?: string}} entry  where and when it was said
 */
function parseSuggestion(block, entry = {}) {
    if (!isOurs(block, 'suggest_session')) return null;
    const input = mcpCall(block).input;
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const prompt = str(input.prompt);
    // Structurally not one of these after all. The tool refuses an empty prompt,
    // so this is a call that never should have been written — rendering an
    // offer with nothing behind it would be worse than rendering the tool block.
    if (!prompt) return null;
    return {
        id: block.id,
        kind: 'suggestion',
        ts: entry.timestamp,
        prompt,
        why: str(input.why),
        title: str(input.title),
        cwd: str(input.cwd) || (typeof entry.cwd === 'string' ? entry.cwd : null),
    };
}

module.exports = { mcpCall, isOurs, parseSuggestion, OUR_SERVERS };
