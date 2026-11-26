'use strict';

// The agent CLIs a session can run on, and what each one can do.
//
// Every session has a `runtime`. Today there is one, `claude`, and everything the
// bridge knows about Claude Code that is *about Claude Code* rather than about a
// coding agent in a directory sits behind three things this registry hands out
// per runtime (docs/plans/23-codex.md, D1):
//
//   adapter       the process adapter: argv, how a user turn is written, how the
//                 process's output becomes busy/idle/tool/ask, and the control
//                 verbs. bridge/runner.js holds one per conversation and keeps
//                 everything else — the queue, `inFlight`, the stall clock,
//                 eviction, notes and adoption. The contract is the header of
//                 bridge/runtimes/claude/process.js.
//   reader        the transcript reader, reached through `readerFor` in
//                 bridge/transcript.js. Content comes from the file a runtime
//                 writes, never from the process.
//   tools         the tool-name tables the rest of the bridge makes decisions on:
//                 `asks` (a plan or a question rather than a permission),
//                 `edits` (changed a file), `alwaysAllow`, and `describe` (what a
//                 call in progress is called).
//
// And one thing that is for clients: `capabilities`, the features a session on
// this runtime supports, sent on `GET /api/sessions/:id` and on the runner
// summaries so `web/` and the phone hide a control rather than ask which runtime
// they are looking at (D4). Every flag is true for Claude, because every feature
// was built for it; a runtime that lacks one says false, and the UI never offers
// it. docs/api.md §*`runtime` and `capabilities`* is the contract for clients.
//
// `adapter` and `reader` are getters so that requiring this registry stays cheap
// and acyclic: bridge/changes.js wants the tool tables, and the process adapter
// pulls in bridge/attachments.js, which pulls in bridge/transcript.js, which is
// one of this registry's own callers.

const claudeTools = require('./claude/tools');

const DEFAULT = 'claude';

/**
 * What a session can do, by feature. The names are the wire names; add a flag
 * here and to docs/api.md in the same commit, and keep it true for Claude.
 */
const CLAUDE_CAPABILITIES = Object.freeze({
    // Branch off a copy of the whole conversation (`fork` on a send).
    fork: true,
    // Edit an earlier turn and continue from there (`branch` on a send).
    branchFromTurn: true,
    // The `plan` permission mode, and the plan card that ends it.
    planMode: true,
    // A question card the model raises for you to answer (`kind: "question"` asks).
    askUser: true,
    // Messages between live sessions: peer messages, `@` mentions, SendMessage.
    peers: true,
    // The session's own checklist, and the task boards built from it.
    tasks: true,
    // A per-session scratch directory the agent is told about.
    scratchpad: true,
    // A slash-command palette, built from what the running process reports.
    slashCommands: true,
    // A message sent while a turn runs is handed to that turn, to be read at its
    // next step, rather than waiting for it to end (`handed` on a queue entry).
    steer: true,
    // Images attached to a turn are sent to the model inline.
    images: true,
    // "Allow always" on a tool ask: allowed for the rest of the session.
    allowForSession: true,
});

const RUNTIMES = {
    claude: {
        name: 'claude',
        capabilities: CLAUDE_CAPABILITIES,
        tools: {
            asks: claudeTools.ASKS,
            edits: claudeTools.EDITS,
            alwaysAllow: claudeTools.ALWAYS_ALLOW,
            describe: claudeTools.describeTool,
        },
        get adapter() { return require('./claude/process'); },
        get reader() { return require('./claude/transcript'); },
    },
};

/** The runtime called `name`, or the default one when no name is given. */
function get(name) {
    const r = RUNTIMES[name || DEFAULT];
    if (!r) throw new Error(`unknown runtime: ${name}`);
    return r;
}

/** Whether `name` names a runtime this bridge knows. */
function known(name) {
    return Object.prototype.hasOwnProperty.call(RUNTIMES, name);
}

/** The capabilities object clients get, for a runtime name. */
function capabilitiesOf(name) {
    return get(name).capabilities;
}

/** The tool tables for a runtime name. */
function toolsOf(name) {
    return get(name).tools;
}

module.exports = { DEFAULT, RUNTIMES, get, known, capabilitiesOf, toolsOf, CLAUDE_CAPABILITIES };
