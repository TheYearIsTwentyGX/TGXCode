// What to call a session's agent, from the bridge's `agent` field.
//
// The bridge names each runtime (`{name, product}` beside `runtime` — "Codex" /
// "Codex", "Claude" / "Claude Code"; see bridge/runtimes/index.js), so no
// surface here keeps a table of runtime names. This is the one fallback: a
// bridge from before the field existed ran nothing but Claude, so no `agent` is
// Claude's. No imports, so test/agent-name.test.js loads it under node;
// web/capabilities.js's agentOf() is the reader every surface calls.

/**
 * `{name, product, resume}` from a bridge `agent` object, with Claude's for
 * none. `resume` is an argv prefix or null: an agent object that carries none
 * (a newer runtime with no such command, or a bridge from before the field) has
 * no resume command, but no agent object at all is Claude's.
 */
export function agentFrom(agent) {
    const argv = agent ? agent.resume : ['claude', '--resume'];
    return {
        name: (agent && typeof agent.name === 'string' && agent.name) || 'Claude',
        product: (agent && typeof agent.product === 'string' && agent.product) || 'Claude Code',
        resume: Array.isArray(argv) && argv.length && argv.every(a => typeof a === 'string' && a)
            ? [...argv] : null,
    };
}

/** One shell word, single-quoted unless it plainly needs no quoting. */
const word = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/**
 * The line that reopens a session in a POSIX shell, or null when its runtime
 * has no resume command. Starts with a `cd`, because `claude --resume` finds a
 * session through the directory it was run in, and a resume from anywhere else
 * says there is no such conversation.
 */
export function resumeLine(resume, id, cwd) {
    if (!resume || !id) return null;
    const cmd = [...resume, id].map(word).join(' ');
    return cwd ? `cd ${word(cwd)} && ${cmd}` : cmd;
}
