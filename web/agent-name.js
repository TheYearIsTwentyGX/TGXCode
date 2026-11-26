// What to call a session's agent, from the bridge's `agent` field.
//
// The bridge names each runtime (`{name, product}` beside `runtime` — "Codex" /
// "Codex", "Claude" / "Claude Code"; see bridge/runtimes/index.js), so no
// surface here keeps a table of runtime names. This is the one fallback: a
// bridge from before the field existed ran nothing but Claude, so no `agent` is
// Claude's. No imports, so test/agent-name.test.js loads it under node;
// web/capabilities.js's agentOf() is the reader every surface calls.

/** `{name, product}` from a bridge `agent` object, with Claude's for none. */
export function agentFrom(agent) {
    return {
        name: (agent && typeof agent.name === 'string' && agent.name) || 'Claude',
        product: (agent && typeof agent.product === 'string' && agent.product) || 'Claude Code',
    };
}
