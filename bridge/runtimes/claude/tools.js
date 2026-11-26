'use strict';

// Claude Code's tool names, as the tables the rest of the bridge reads.
//
// Several modules make a decision on a tool's *name*: which calls changed a file
// (bridge/changes.js), which calls are a plan or a question rather than a request
// to run something (bridge/runner.js, bridge/turn-index.js), what to call a call
// in progress (`describe`). Each used to carry its own list. They are here now,
// one table per question, so that a second runtime answers the same questions
// with its own table instead of the bridge branching on which runtime it is
// looking at — see `tools` in bridge/runtimes/index.js.
//
// Deliberately dependency-free apart from bridge/tool-name.js: both the Claude
// transcript reader and the Claude process adapter read it, and either importing
// the other to get at these would be a cycle through bridge/attachments.js.

const { toolDisplayName } = require('../../tool-name');

/**
 * Which tools are a conversation rather than a permission question, and which
 * card each one is. A `can_use_tool` for one of these is answered with a plan or
 * an answer, not an allow; the turn rail marks one as a moment worth a tick.
 * @type {Record<string, 'plan'|'question'>}
 */
const ASKS = { ExitPlanMode: 'plan', AskUserQuestion: 'question' };

// Everything that changes a file on disk and reports a patch for it. `Bash`
// running `sed -i` is not here and cannot be: nothing in the transcript says
// which file it touched, which is exactly why the working tree is shown beside
// this rather than instead of it.
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Answered without asking anybody, in any mode, plan included. Filing a report
// in an orchestrator's inbox changes nothing outside the app, and a worker in
// plan mode that had to have it approved would send its permission prompt to
// the very inbox it was trying to write to.
const ALWAYS_ALLOW = new Set(['mcp__tgxcode__report_to_orchestrator']);

/** A short phrase for what a tool call is doing, for status lines. */
function describeTool(block) {
    const name = block.name;
    const input = block.input || {};
    switch (name) {
        case 'Bash': return `Running: ${clip(input.description || input.command, 60)}`;
        case 'Read': return `Reading ${base(input.file_path)}`;
        case 'Edit': return `Editing ${base(input.file_path)}`;
        case 'Write': return `Writing ${base(input.file_path)}`;
        case 'Glob': return `Searching ${clip(input.pattern, 40)}`;
        case 'Grep': return `Grepping ${clip(input.pattern, 40)}`;
        case 'Task':
        case 'Agent': return `Subagent: ${clip(input.description, 50)}`;
        case 'WebFetch': return `Fetching ${clip(input.url, 50)}`;
        case 'WebSearch': return `Searching the web`;
        case 'ExitPlanMode': return 'Presenting a plan';
        case 'AskUserQuestion': return 'Asking you a question';
        default: return `Running ${toolDisplayName(name)}`;
    }
}

const base = (p) => (p ? String(p).split('/').pop() : '');
const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

module.exports = { ASKS, EDITS, ALWAYS_ALLOW, describeTool };
