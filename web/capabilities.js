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
