// What a session can do, by feature — the client's half of `capabilities`
// (docs/api.md §*`runtime` and `capabilities`*, bridge/runtimes/index.js).
//
// **Hide a control whose capability is false; never ask which runtime it is.**
// That is the whole rule, and this one function is how every surface follows it:
// a Codex session the bridge can only read says `send: false`, and the composer,
// the Edit-and-resend buttons and the rest go away because of the flag, not
// because something here knows what Codex is. A runtime added later works with no
// change here as long as it states its flags.
//
// A flag that is missing means true. An older bridge sends no `capabilities` at
// all, and Claude's object predates some flags (`send`, `delete`), so "absent"
// has to read as "it can", or every Claude session would lose its composer.

import { state } from './state.js';
import { agentFrom } from './agent-name.js';

/**
 * Whether `summary`'s session supports `flag`. Reads the live runner's object
 * first — it is the one the bridge built for the process — then the summary's.
 * Defaults to the open session.
 */
export function can(flag, summary = state.current) {
    const fromRunner = summary && state.current && summary.sessionId === state.current.sessionId
        && state.runner && state.runner.capabilities;
    const caps = fromRunner || (summary && summary.capabilities) || null;
    return !caps || caps[flag] !== false;
}

/**
 * What to call the agent behind `summary`'s session — `{name, product}`, the
 * bridge's `agent` field ("Codex" / "Codex", "Claude" / "Claude Code"). Read the
 * same way as `can`: the live runner's first, then the summary's. An older
 * bridge sends none, and then it is Claude, the only agent such a bridge ran.
 * Used for every label that names the agent, so no surface keeps a table of
 * runtime names.
 */
export function agentOf(summary = state.current) {
    const fromRunner = summary && state.current && summary.sessionId === state.current.sessionId
        && state.runner && state.runner.agent;
    return agentFrom(fromRunner || (summary && summary.agent) || null);
}
