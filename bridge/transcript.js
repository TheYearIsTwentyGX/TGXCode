'use strict';

// What the bridge imports to read a transcript.
//
// This file used to *be* the Claude transcript reader. That reader now lives in
// bridge/runtimes/claude/transcript.js, as one side of the seam a second runtime
// plugs into (docs/plans/23-codex.md, D1), and this is the facade over it. Every
// name it exported before it still exports, from the same place, so no caller
// had to change; the names come from four modules now:
//
//   bridge/runtimes/claude/transcript.js   reading Claude Code's `.jsonl`
//   bridge/places.js                       which checkout or worktree a directory is
//   bridge/envelopes.js                    the wrappers the bridge writes into a turn
//   bridge/jsonl.js                        reading a JSONL file still being written
//
// **The top-level reader names are Claude's.** `scanMeta`, `buildEvents` and the
// rest below read Claude Code's format, because every session the index knows
// about is a Claude session. Code that has a session in hand and wants *its*
// reader asks `readerFor(runtime)`, which answers with an object carrying the
// READER names — the same functions, for Claude — and is how a second reader is
// reached without the caller branching on which runtime it is.

const places = require('./places');
const envelopes = require('./envelopes');
const claude = require('./runtimes/claude/transcript');
const runtimes = require('./runtimes');

/**
 * What a transcript reader provides. A reader for another runtime implements
 * these with the same signatures and return shapes — `buildEvents` in particular
 * returns the event kinds `web/` already draws — or leaves one out where the
 * runtime has no such thing (a subagent index, say), and the caller then gets
 * `undefined` rather than a Claude answer to a Codex question.
 */
const READER = [
    'parseLines', 'scanMeta', 'buildEvents', 'branchPoint',
    'readSubagentIndex', 'readSubagentTranscript', 'toolResultImage',
    'lastActivity', 'recentActivity', 'todoProgress', 'todoList', 'describeTool',
];

/** The transcript reader for a runtime (`"claude"` when none is named). */
function readerFor(runtime) {
    return runtimes.get(runtime).reader;
}

module.exports = {
    parseLines: claude.parseLines, scanMeta: claude.scanMeta, buildEvents: claude.buildEvents,
    branchPoint: claude.branchPoint, readSubagentIndex: claude.readSubagentIndex,
    readSubagentTranscript: claude.readSubagentTranscript,
    toolResultImage: claude.toolResultImage,
    // For bridge/sessions.js, which reports the main checkout's branch for an
    // orchestrator moved out of a worktree rather than the worktree's.
    branchOf: places.branchOf,
    lastActivity: claude.lastActivity, recentActivity: claude.recentActivity,
    todoProgress: claude.todoProgress, describeTool: claude.describeTool,
    stripEnvelope: claude.stripEnvelope, firstLine: claude.firstLine,
    stripCommandTags: claude.stripCommandTags, parseCommand: claude.parseCommand,
    commandText: claude.commandText,
    // The three parts of the TodoWrite format: what shape it arrived in
    // (`todoInput`), the list itself (`todoList`) and the count over it
    // (`todoProgress`). Exported together for the handoff pair's reason below —
    // bridge/tasks.js renders the list and the boards count it, and neither
    // should be re-deriving what the shape is.
    todoList: claude.todoList, todoInput: claude.todoInput,
    // For bridge/notifications.js, which decides whether a message from another
    // session is worth interrupting you for, and needs to recognise one first.
    parsePeerMessage: claude.parsePeerMessage,
    // The two halves of the handoff wrapper. `handoffEnvelope` is written by the
    // handoff route in bridge/routes/session.js and read back by `parseHandoff`,
    // so they are exported together — one format, one file (bridge/envelopes.js),
    // the same rule the attachment note follows below.
    handoffEnvelope: envelopes.handoffEnvelope, parseHandoff: envelopes.parseHandoff,
    isHandoff: envelopes.isHandoff, HANDOFF_TAG: envelopes.HANDOFF_TAG,
    // The orchestrator's two wrappers, written by bridge/orchestration.js and
    // read back by the reader — exported in pairs for the handoff's reason.
    orchestratorInboxEnvelope: envelopes.orchestratorInboxEnvelope,
    parseOrchestratorInbox: envelopes.parseOrchestratorInbox,
    isOrchestratorInbox: envelopes.isOrchestratorInbox, ORCH_INBOX_TAG: envelopes.ORCH_INBOX_TAG,
    orchestratorMessageEnvelope: envelopes.orchestratorMessageEnvelope,
    parseOrchestratorMessage: envelopes.parseOrchestratorMessage,
    isOrchestratorMessage: envelopes.isOrchestratorMessage, ORCH_MESSAGE_TAG: envelopes.ORCH_MESSAGE_TAG,
    // Exported for bridge/commands.js, which has to answer the same question
    // about a directory that scanMeta answers about a transcript: which checkout
    // is this, and is it a worktree of one.
    projectRootOf: places.projectRootOf, worktreeNameOf: places.worktreeNameOf,
    worktreeBaseOf: places.worktreeBaseOf, isCheckout: places.isCheckout,
    workspaceOf: places.workspaceOf,
    // For bridge/sessions.js, for an orchestrator moved somewhere by the bridge.
    placeOf: places.placeOf, worktreeRootOf: places.worktreeRootOf,
    // Written by bridge/attachments.js, read back by the reader. Shared so the
    // two halves of one format cannot drift apart.
    ATTACHMENT_NOTE_HEAD: envelopes.ATTACHMENT_NOTE_HEAD,
    parseAttachmentNote: envelopes.parseAttachmentNote,
    // The seam.
    readerFor, READER,
};
