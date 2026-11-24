#!/usr/bin/env node
'use strict';

// A stand-in for the `claude` CLI, so the screenshot run never starts the real
// one — no login, no network, no API usage.
//
// The bridge starts `claude` through TGXCODE_CLAUDE_BIN, and this is what that
// variable points at for the run. It speaks only as much of the stream-json
// protocol as it takes to put a session into a state the UI can draw:
//
//   working     a turn that has started a tool call and not finished it
//   permission  a turn blocked on a `can_use_tool` request (the approval card)
//   plan        the same, for ExitPlanMode (a plan waiting for approval)
//   question    the same, for AskUserQuestion
//
// Which one a session gets is read from the JSON file named by
// TGXCODE_STUB_SCRIPT: `{ "<session id>": { kind, … } }`. Anything the file does
// not name just ends its turn with a short answer. It never writes a transcript —
// the transcripts the page shows were seeded on disk before the bridge started.

const fs = require('fs');
const readline = require('readline');

const argv = process.argv.slice(2);

// The bridge asks for these when it checks the installed version, and a beacon
// starts an interactive session to read the quota. Neither needs an answer.
if (argv.includes('--version') || argv[0] === '-v') {
    console.log('2.1.322 (Claude Code)');
    process.exit(0);
}
if (!argv.includes('--input-format')) process.exit(0);

const at = (flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };
const sessionId = at('--session-id') || at('--resume') || 'stub';

let plan = {};
try { plan = JSON.parse(fs.readFileSync(process.env.TGXCODE_STUB_SCRIPT, 'utf8')); } catch { /* none */ }
const mine = plan[sessionId] || null;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const assistant = (content) => out({ type: 'assistant', session_id: sessionId,
    message: { role: 'assistant', model: 'claude-sonnet-5-5', content } });

out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(),
    model: 'claude-sonnet-5-5', tools: [], slash_commands: [] });

function ask(tool, input, toolUseId) {
    out({ type: 'control_request', request_id: `ask-${Date.now()}`,
        request: { subtype: 'can_use_tool', tool_name: tool, input,
            tool_use_id: toolUseId || `toolu_demo_${Math.random().toString(36).slice(2, 10)}` } });
}

function turn() {
    if (!mine) {
        return out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.',
            duration_ms: 1, num_turns: 1, total_cost_usd: 0, session_id: sessionId });
    }
    if (mine.kind === 'working') {
        if (mine.text) assistant([{ type: 'text', text: mine.text }]);
        return assistant([{ type: 'tool_use', id: mine.toolUseId || 'toolu_demo_work',
            name: mine.tool || 'Bash', input: mine.input || {} }]);
    }
    if (mine.kind === 'permission') return ask(mine.tool, mine.input, mine.toolUseId);
    if (mine.kind === 'plan') return ask('ExitPlanMode', { plan: mine.plan }, mine.toolUseId);
    if (mine.kind === 'question') return ask('AskUserQuestion', { questions: mine.questions }, mine.toolUseId);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'control_request') {
        return out({ type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: {} } });
    }
    if (m.type === 'user') turn();
}).on('close', () => process.exit(0));
