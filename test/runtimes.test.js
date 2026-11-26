'use strict';

// The runtime seam — bridge/runtimes/.
//
// No bridge needed. Three things are pinned here, each for a different reader:
//
//   - **The wire fields** `runtime` and `capabilities`, on a runner's status and
//     on the narrow row a session list carries. The phone reads docs/api.md and
//     nothing else, so the field names and the flag set are a contract, and a
//     flag that quietly went missing would read as "this session cannot".
//   - **The adapter's event mapping.** The runner never parses a stream-json line
//     any more; it acts on what `read` returns. The runner and host tests drive
//     the whole of that end to end against a stub, and this is the table one level
//     down, so a change to the mapping fails here with the line that caused it
//     rather than as a session that never goes idle.
//   - **The tool tables and the reader seam**, which the rest of the bridge now
//     reaches through the registry rather than through lists of its own.

const assert = require('assert');

const runtimes = require('../bridge/runtimes');
const { Runner, rowStatus } = require('../bridge/runner');
const transcript = require('../bridge/transcript');
const changes = require('../bridge/changes');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

// --- the registry ---------------------------------------------------------------------------------
{
    const FLAGS = ['fork', 'branchFromTurn', 'planMode', 'askUser', 'peers', 'tasks', 'scratchpad',
        'slashCommands', 'steer', 'images', 'allowForSession'];
    const caps = runtimes.capabilitiesOf('claude');
    assert.deepStrictEqual(Object.keys(caps).sort(), FLAGS.slice().sort(), 'the documented flags, no more and no fewer');
    for (const f of FLAGS) assert.strictEqual(caps[f], true, `${f} is true for claude`);
    assert.ok(Object.isFrozen(caps), 'one object shared by every runner, so nobody may edit it');
    assert.strictEqual(runtimes.get().name, 'claude', 'claude when no runtime is named');
    assert.strictEqual(runtimes.DEFAULT, 'claude');
    assert.ok(runtimes.known('claude') && !runtimes.known('codex'));
    assert.throws(() => runtimes.get('nope'), /unknown runtime/);
    ok('claude is the default runtime, and every capability is true for it');
}

{
    const tools = runtimes.toolsOf('claude');
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.ok(tools.edits.has(t), t);
    assert.ok(!tools.edits.has('Bash'), 'nothing in the transcript says which file a Bash call touched');
    assert.deepStrictEqual(tools.asks, { ExitPlanMode: 'plan', AskUserQuestion: 'question' });
    assert.ok(tools.alwaysAllow.has('mcp__tgxcode__report_to_orchestrator'));
    assert.strictEqual(tools.describe({ name: 'Read', input: { file_path: '/a/b/c.js' } }), 'Reading c.js');
    assert.strictEqual(changes.EDIT_TOOLS, tools.edits, 'changes.js reads the table, it does not keep one');
    assert.strictEqual(transcript.describeTool, tools.describe, 'one describeTool, wherever it is imported from');
    ok('the tool tables come from the runtime, and the old names are the same objects');
}

{
    const edit = { kind: 'tool', id: 'e1', name: 'Edit', status: 'ok',
        input: { file_path: '/repo/a.js', old_string: 'a', new_string: 'b' } };
    const plain = changes.summarize(changes.fromEvents([edit]), { root: '/repo' });
    const named = changes.summarize(changes.fromEvents([edit], { runtime: 'claude' }), { root: '/repo' });
    assert.deepStrictEqual(named, plain, 'naming the runtime that is the default changes nothing');
    ok('changes.fromEvents takes a runtime, and claude\'s is the default');
}

// --- the transcript reader seam -------------------------------------------------------------------
{
    const reader = transcript.readerFor('claude');
    assert.strictEqual(transcript.readerFor(), reader, 'claude\'s when none is named');
    for (const name of transcript.READER) {
        assert.strictEqual(typeof reader[name], 'function', `the reader has ${name}`);
        assert.strictEqual(transcript[name], reader[name], `the facade's ${name} is claude's`);
    }
    ok('readerFor answers with the reader, and the facade\'s names are that reader\'s');
}

// --- the wire fields ------------------------------------------------------------------------------
{
    const r = new Runner({ sessionId: 's1', cwd: '/tmp' });
    const st = r.status();
    assert.strictEqual(st.runtime, 'claude');
    assert.strictEqual(st.capabilities, runtimes.capabilitiesOf('claude'));
    assert.strictEqual(st.capabilities.fork, true);
    assert.strictEqual(new Runner({ sessionId: 's2', cwd: '/tmp', runtime: 'claude' }).status().runtime, 'claude');
    assert.throws(() => new Runner({ sessionId: 's3', cwd: '/tmp', runtime: 'nope' }), /unknown runtime/);

    const row = rowStatus(st);
    assert.deepStrictEqual(Object.keys(row),
        ['state', 'activity', 'detail', 'queued', 'claudeVersion', 'stalled', 'runtime', 'capabilities'],
        'the six documented fields, then runtime and capabilities');
    assert.strictEqual(row.runtime, 'claude');
    assert.strictEqual(row.capabilities.askUser, true);
    assert.ok(!('pendingPermission' in row), 'a row is still narrow');
    ok('a runner reports runtime and capabilities, and a session-list row carries both');
}

// --- the adapter: reading -------------------------------------------------------------------------
const adapterModule = runtimes.get('claude').adapter;
const sent = [];
const adapter = new adapterModule.Adapter({ rpc: (verb, payload) => { sent.push({ verb, payload }); return Promise.resolve({ cancelled: true }); } });
const read = (msg) => adapter.read(msg);

{
    assert.deepStrictEqual(read({ type: 'system', subtype: 'init', session_id: 'abc', cwd: '/w',
        claude_code_version: '2.1.280' }).map(({ raw, ...e }) => e),
    [{ type: 'init', version: '2.1.280', sessionId: 'abc', cwd: '/w' }]);
    assert.strictEqual(read({ type: 'system', subtype: 'init' })[0].version, null);

    assert.deepStrictEqual(read({ type: 'assistant', message: { content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: '   ' },
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/y.md' } },
    ] } }), [
        { type: 'thinking' },
        { type: 'writing' },
        { type: 'tool-start', id: 'tu1', name: 'Read', label: 'Reading y.md' },
    ], 'blocks in order; blank text is not writing');

    assert.deepStrictEqual(read({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'tu1' }, { type: 'text', text: 'x' },
    ] } }), [{ type: 'tools-done', ids: ['tu1'] }]);
    assert.deepStrictEqual(read({ type: 'user', message: { content: 'plain' } }),
        [{ type: 'tools-done', ids: [] }], 'every user line ends a call, even one that names none');

    assert.deepStrictEqual(read({ type: 'result', is_error: true, result: 'boom', total_cost_usd: 0.5,
        duration_api_ms: 9, num_turns: 2, stop_reason: 'end_turn' }),
    [{ type: 'turn-end', result: { isError: true, text: 'boom', costUsd: 0.5, durationMs: 9,
        numTurns: 2, stopReason: 'end_turn' } }]);
    assert.deepStrictEqual(read({ type: 'result' })[0].result,
        { isError: false, text: '', costUsd: 0, durationMs: 0, numTurns: 0, stopReason: null });
    ok('init, blocks, tool results and a result read as the events the contract names');
}

{
    const [ev] = read({ type: 'control_request', request_id: 'r1', request: {
        subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'p' }, tool_use_id: 'tu9' } });
    assert.strictEqual(ev.type, 'ask');
    assert.strictEqual(ev.uninteractive, false);
    assert.strictEqual(ev.ask.id, 'r1');
    assert.strictEqual(ev.ask.kind, 'plan');
    assert.strictEqual(ev.ask.tool, 'ExitPlanMode');
    assert.strictEqual(ev.ask.toolUseId, 'tu9');
    assert.deepStrictEqual(ev.ask.input, { plan: 'p' });

    const [mcp] = read({ type: 'control_request', request_id: 'r2', request: {
        subtype: 'can_use_tool', tool_name: 'mcp__x__y', requires_user_interaction: true } });
    assert.strictEqual(mcp.ask.kind, 'tool');
    assert.strictEqual(mcp.uninteractive, true);

    assert.deepStrictEqual(read({ type: 'control_request', request_id: 'r3', request: { subtype: 'hook_callback' } }),
        [{ type: 'request', id: 'r3', method: 'hook_callback' }]);
    assert.deepStrictEqual(read({ type: 'control_cancel_request', request_id: 'r1' }),
        [{ type: 'ask-withdrawn', id: 'r1' }]);
    assert.deepStrictEqual(read({ type: 'control_cancel_request', request: { request_id: 'r4' } }),
        [{ type: 'ask-withdrawn', id: 'r4' }]);
    assert.deepStrictEqual(read({ type: 'control_response', response: { subtype: 'success', request_id: 'q1', response: { a: 1 } } }),
        [{ type: 'response', id: 'q1', ok: true, result: { a: 1 }, error: null }]);
    assert.deepStrictEqual(read({ type: 'control_response', response: { subtype: 'error', request_id: 'q2', error: 'no' } }),
        [{ type: 'response', id: 'q2', ok: false, result: {}, error: 'no' }]);
    assert.deepStrictEqual(read({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' }),
        [{ type: 'lifecycle', uuid: 'u1', state: 'started' }]);
    ok('asks, refusals, withdrawals, responses and lifecycle frames');
}

{
    assert.deepStrictEqual(read({ type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_bash' }),
        [{ type: 'task', id: 't1', state: 'started', taskType: 'local_bash' }]);
    assert.deepStrictEqual(read({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } }), []);
    assert.deepStrictEqual(read({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed' } }),
        [{ type: 'task', id: 't1', state: 'done' }]);
    assert.deepStrictEqual(read({ type: 'system', subtype: 'task_notification', task_id: 't2', tool_use_id: 'tu',
        summary: 's', usage: { duration_ms: 5 } }), [
        { type: 'task', id: 't2', state: 'done' },
        { type: 'agent-done', taskId: 't2', toolUseId: 'tu', status: 'completed', summary: 's', durationMs: 5 },
    ]);
    const [r1] = read({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 529 });
    assert.strictEqual(r1.type, 'retry');
    assert.deepStrictEqual([r1.attempt, r1.max, r1.status], [1, 10, 529]);
    assert.strictEqual(r1.notice.kind, 'api_retry');
    assert.strictEqual(read({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10 })[0].notice, null, 'one notice, not ten');
    assert.deepStrictEqual(read({ type: 'system', subtype: 'permission_denied', content: 'nope' }),
        [{ type: 'notice', notice: { level: 'warn', kind: 'permission_denied', text: 'nope' } }]);

    const info = { status: 'rejected', resetsAt: 1, rateLimitType: 'five_hour' };
    assert.deepStrictEqual(read({ type: 'rate_limit_event', rate_limit_info: info }),
        [{ type: 'quota', info, rejected: true, notice: { level: 'warn', kind: 'rate_limit', text: 'Rate limit: rejected' } }]);
    assert.strictEqual(read({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })[0].notice, null);
    assert.deepStrictEqual(read({ type: 'rate_limit_event' }), []);

    assert.deepStrictEqual(read({ type: 'something_new' }), [], 'a newer CLI\'s line is nothing, not an error');
    assert.deepStrictEqual(read({ type: 'system', subtype: 'something_new' }), []);
    ok('background tasks, retries, notices and quota; unknown lines are empty');
}

// --- the adapter: writing and verbs ---------------------------------------------------------------
(async () => {
    assert.deepStrictEqual(adapter.turn({ uuid: 'u1', text: 'hello' }),
        { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
    assert.deepStrictEqual(adapter.request('req_1', 'interrupt', { cancel_queued: true }),
        { type: 'control_request', request_id: 'req_1', request: { subtype: 'interrupt', cancel_queued: true } });

    const ask = { id: 'r1', tool: 'Bash' };
    assert.deepStrictEqual(adapter.answer(ask, { behavior: 'deny' }),
        { type: 'control_response', response: { subtype: 'success', request_id: 'r1',
            response: { behavior: 'deny', toolName: 'Bash', message: 'Denied from TGXCode.' } } });
    assert.deepStrictEqual(adapter.answer(ask, { behavior: 'allow', updatedInput: { command: 'ls' }, allowSession: true }).response.response,
        { behavior: 'allow', toolName: 'Bash', updatedInput: { command: 'ls' },
            updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] });
    assert.deepStrictEqual(adapter.answer(ask, { behavior: 'allow', updatedInput: null }).response.response,
        { behavior: 'allow', toolName: 'Bash' }, 'nothing it was not asked to say');
    assert.deepStrictEqual(adapter.refuse({ id: 'r3', method: 'hook_callback' }).response,
        { subtype: 'error', request_id: 'r3', error: 'tgxcode does not handle the "hook_callback" control request' });

    sent.length = 0;
    await adapter.handshake();
    await adapter.interrupt();
    await adapter.setPermissionMode('acceptEdits');
    assert.strictEqual(await adapter.withdraw('u9'), true, 'true when the process says it was taken back');
    assert.deepStrictEqual(sent, [
        { verb: 'initialize', payload: {} },
        { verb: 'interrupt', payload: { cancel_queued: true } },
        { verb: 'set_permission_mode', payload: { mode: 'acceptEdits' } },
        { verb: 'cancel_async_message', payload: { message_uuid: 'u9' } },
    ]);
    ok('turns, requests, answers and refusals are written as stream-json; the verbs go through rpc');

    assert.strictEqual(adapter.classifyExit('add --fork-session to branch', 1).kind, 'busy-elsewhere');
    assert.strictEqual(adapter.classifyExit('', 3).message, 'claude exited with code 3');
    const refused = adapter.argvRefusal('error: unknown option --permission-prompt-tool', { permissionPrompt: true });
    assert.strictEqual(refused.cap, 'permissionPrompt');
    assert.strictEqual(refused.notice.kind, 'no_permission_prompt');
    assert.strictEqual(adapter.argvRefusal('error: unknown option --permission-prompt-tool', { permissionPrompt: false }), null,
        'a cap already off is not refused twice');
    assert.deepStrictEqual(adapter.initialCaps(), { permissionPrompt: true, interrupt: true });
    assert.deepStrictEqual(adapter.usageLimit({ resetsAt: 2, rateLimitType: 'seven_day' }, true, ''),
        { resetsAt: 2000, window: 'seven_day' });
    assert.strictEqual(adapter.usageLimit(null, false, "You've hit your limit"), null);
    assert.strictEqual(adapter.name, 'claude');
    assert.strictEqual(adapter.label, 'Claude');
    ok('exits, a refused flag, initial caps and the usage limit are the adapter\'s to read');

    const args = adapter.argv({ sessionId: 'S', cwd: '/w', permissionMode: 'plan', model: 'opus', effort: 'high',
        isNew: true, fork: false, branch: null, role: null, preview: false, systemPrompt: 'brief',
        caps: { permissionPrompt: true } });
    assert.deepStrictEqual(args.slice(0, 9), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--verbose', '--permission-mode', 'plan', '--permission-prompt-tool']);
    const at = (f) => args[args.indexOf(f) + 1];
    assert.strictEqual(at('--session-id'), 'S');
    assert.strictEqual(at('--append-system-prompt'), 'brief');
    assert.strictEqual(at('--model'), 'opus');
    assert.strictEqual(at('--effort'), 'high');
    assert.ok(!args.includes('--resume') && !args.includes('--fork-session'));
    const resumed = adapter.argv({ sessionId: 'S', permissionMode: 'auto', isNew: false, fork: true,
        branch: { parent: 'P', fromUuid: 'F', guard: true }, caps: { permissionPrompt: false } });
    assert.ok(resumed.includes('--resume') && resumed.includes('--fork-session'));
    assert.ok(resumed.includes('--resume-session-at=P') && resumed.includes('--resume-drops-turn=F'));
    assert.ok(!resumed.includes('--permission-prompt-tool') && !resumed.includes('--append-system-prompt'));
    ok('argv is built from what the runner hands over');

    console.log(`\n${pass} groups passed`);
})().catch((err) => { console.error(err); process.exit(1); });
