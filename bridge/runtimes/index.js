'use strict';

// The agent CLIs a session can run on, and what each one can do.
//
// Every session has a `runtime`: `claude`, or `codex` for a Codex thread, which
// the bridge reads (Phase 2 of docs/plans/23-codex.md) and drives over
// `codex app-server` (Phase 3). Everything the bridge knows about one CLI that is
// *about that CLI* rather than about a coding agent in a directory sits behind
// three things this registry hands out per runtime (docs/plans/23-codex.md, D1):
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
//
// **Two tables, one of them empty now.** `RUNTIMES` is what a session can be
// *run* on: a process adapter and a reader. `READ_ONLY` is what the bridge can
// read and never start — Codex was there for Phase 2, and moved across when
// Phase 3 gave it an adapter. The table stays for the next runtime that is read
// before it is driven. `get` and `known` answer for the first table only, so a
// Runner asked for a read-only runtime is refused by name ("unknown runtime: …")
// instead of failing on a missing adapter. Everything that only reads —
// `capabilitiesOf`, `toolsOf`, `describe` and the reader seam — answers for both.

const claudeTools = require('./claude/tools');
const codexTools = require('./codex/tools');

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
    // A message can be sent at all: the composer, `POST …/send`, `…/later`, a
    // wake, a handoff to it. False is a session the bridge can only show.
    send: true,
    // Deleting the session's transcript (`DELETE /api/sessions/:id`).
    delete: true,
});

/**
 * Codex, driven (docs/plans/23-codex.md, Phase 3): sent to, steered, stopped,
 * with its approvals, questions, plans and images. Everything still false is
 * Phase 4's (fork, branch, the checklist, the slash palette) or has no Codex
 * equivalent (peers, the scratchpad).
 *
 * `allowForSession` is false because a Codex ask carries its own `decisions`,
 * and a card draws those instead of the generic "Allow always" button. `delete`
 * stays false: a rollout is Codex's store, with projections of it in Codex's own
 * databases, and removing the file behind Codex's back would leave those
 * pointing at nothing. A Codex thread is deleted through Codex.
 */
const CODEX_CAPABILITIES = Object.freeze({
    fork: false,
    branchFromTurn: false,
    planMode: true,
    askUser: true,
    peers: false,
    tasks: false,
    scratchpad: false,
    slashCommands: false,
    steer: true,
    images: true,
    allowForSession: false,
    send: true,
    delete: false,
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
    codex: {
        name: 'codex',
        capabilities: CODEX_CAPABILITIES,
        // Codex names the session at `thread/start`, so what a runner is created
        // with is a placeholder until its `init` says `minted`. The create route
        // waits for that rather than answering with the placeholder.
        mintsId: true,
        tools: {
            asks: codexTools.ASKS,
            edits: codexTools.EDITS,
            alwaysAllow: codexTools.ALWAYS_ALLOW,
            describe: codexTools.describeTool,
        },
        get adapter() { return require('./codex/process'); },
        get reader() { return require('./codex/transcript'); },
    },
};

// Read, never run. Empty since Phase 3 moved Codex into RUNTIMES.
const READ_ONLY = {};

/** A runtime by name from either table, or undefined. */
function lookup(name) {
    const n = name || DEFAULT;
    if (Object.prototype.hasOwnProperty.call(RUNTIMES, n)) return RUNTIMES[n];
    if (Object.prototype.hasOwnProperty.call(READ_ONLY, n)) return READ_ONLY[n];
    return undefined;
}

/** The runtime called `name` that a session can be run on, or the default one. */
function get(name) {
    const r = RUNTIMES[name || DEFAULT];
    if (!r) throw new Error(`unknown runtime: ${name}`);
    return r;
}

/** Whether `name` names a runtime this bridge can run a session on. */
function known(name) {
    return Object.prototype.hasOwnProperty.call(RUNTIMES, name);
}

/** Whether `name` names a runtime this bridge can read, run or not. */
function readable(name) {
    return known(name) || Object.prototype.hasOwnProperty.call(READ_ONLY, name);
}

/** Any runtime this bridge can read — run or read-only. Throws for an unknown name. */
function describe(name) {
    const r = lookup(name);
    if (!r) throw new Error(`unknown runtime: ${name}`);
    return r;
}

/** The capabilities object clients get, for a runtime name. */
function capabilitiesOf(name) {
    return describe(name).capabilities;
}

/** The tool tables for a runtime name. */
function toolsOf(name) {
    return describe(name).tools;
}

/** Whether a runtime names its own sessions (the create route waits for the id). */
function mintsId(name) {
    return !!get(name).mintsId;
}

module.exports = {
    DEFAULT, RUNTIMES, READ_ONLY, get, known, readable, describe, capabilitiesOf, toolsOf, mintsId,
    CLAUDE_CAPABILITIES, CODEX_CAPABILITIES,
};
