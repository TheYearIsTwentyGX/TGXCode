'use strict';

// Codex's tool names, as the tables the rest of the bridge reads — the Codex
// column of what bridge/runtimes/claude/tools.js is for Claude.
//
// The names are the ones bridge/codex/items.js gives the `tool` events it makes
// out of Codex's thread items, which are in turn the tools the model calls
// (`exec_command`, `apply_patch`), so this table and that one move together.

const { TOOL } = require('../../codex/items');
const { toolDisplayName } = require('../../tool-name');

/**
 * The tool rows the turn rail marks, and as what. A Codex plan turn ends in a
 * `plan` item, and the blocking question tool is `request_user_input`, whose
 * arguments are AskUserQuestion's shape.
 * @type {Record<string, 'plan'|'question'>}
 */
const ASKS = { [TOOL.plan]: 'plan', request_user_input: 'question' };

// Everything that changes a file and says which, with a diff: a `fileChange`
// item. A command that edits a file says nothing about which file, so — exactly
// as with Claude's `Bash` — it is not on this list.
const EDITS = new Set([TOOL.patch]);

// Nothing is answered without asking on a runtime the bridge does not drive.
const ALWAYS_ALLOW = new Set();

/** A short phrase for what a tool call is doing, for status lines. */
function describeTool(block) {
    const input = block.input || {};
    switch (block.name) {
        case TOOL.command: return `Running: ${clip(input.command, 60)}`;
        case TOOL.patch: {
            const files = (input.changes || []).map(c => base(c.path));
            return files.length === 1 ? `Editing ${files[0]}` : `Editing ${files.length} files`;
        }
        case TOOL.plan: return 'Presenting a plan';
        case 'request_user_input': return 'Asking you a question';
        case TOOL.webSearch: return 'Searching the web';
        case TOOL.sleep: return 'Waiting';
        // Named the way a Claude session's call to the same tool is:
        // `Running TGXCode: Suggest Session`.
        case TOOL.mcp: return input.server && input.tool
            ? `Running ${toolDisplayName(`mcp__${input.server}__${input.tool}`)}` : 'Running an MCP tool';
        default: return `Running ${block.name}`;
    }
}

const base = (p) => (p ? String(p).split('/').pop() : '');
const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

module.exports = { ASKS, EDITS, ALWAYS_ALLOW, describeTool };
