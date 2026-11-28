'use strict';

// A Codex session taking part in TGXCode's own machinery (docs/plans/23-codex.md,
// Phase 4): our MCP server in the thread `config`, the session's id reaching
// bridge/mcp.js and the session's shells, and the calls it makes read back as
// the suggestion cards and tool rows a Claude session's are.
//
//   node test/codex-mcp.test.js
//
// No bridge and no Codex. mcp.js is run for real, against a stub bridge on a
// port the kernel hands out, with its own XDG_DATA_HOME so the token it reads is
// ours and not the everyday bridge's — the same reason threadConfig passes that
// variable on to the server.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-codex-mcp-'));
process.env.XDG_DATA_HOME = home;

const { CodexAdapter, threadConfig } = require('../bridge/runtimes/codex/process');
const { mcpCall, isOurs, parseSuggestion } = require('../bridge/mcp-calls');
const reader = require('../bridge/runtimes/codex/transcript');
const codexTools = require('../bridge/runtimes/codex/tools');
const { sessionOf } = require('../bridge/devservers');
const cfg = require('../bridge/config');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

(async () => {
    // --- the thread config ---------------------------------------------------

    {
        const fresh = threadConfig({ sessionId: 'placeholder-1', isNew: true });
        const srv = fresh['mcp_servers.tgxcode'];
        assert.ok(srv, 'a new thread gets our server');
        assert.strictEqual(srv.command, process.execPath, 'the node already running us, as for Claude');
        assert.strictEqual(path.basename(srv.args[0]), 'mcp.js');
        assert.strictEqual(srv.args[srv.args.indexOf('--port') + 1], String(cfg.PORT));
        assert.ok(srv.args.includes('--session-from-call'), 'it learns the id from the call');
        assert.ok(!srv.args.includes('--session'),
            'a placeholder is never handed over as the session id: Codex mints the real one');
        assert.strictEqual(srv.default_tools_approval_mode, 'approve',
            'our tools run unasked, as --allowedTools makes them under Claude');
        assert.deepStrictEqual(srv.env, { XDG_DATA_HOME: home },
            'the state root goes with it, or mcp.js reads another bridge\'s token');
        assert.ok(!('shell_environment_policy.set.TGXCODE_SESSION_ID' in fresh),
            'no id to give a new thread\'s shells (Codex sets CODEX_THREAD_ID itself)');
        assert.ok(!('mcp_servers.preview' in fresh));
        ok('a new thread gets mcp.js with the id taken from each call, and nothing claiming an id');
    }

    {
        const resumed = threadConfig({ sessionId: 'thread-9', isNew: false, role: 'worker', preview: true });
        const args = resumed['mcp_servers.tgxcode'].args;
        assert.strictEqual(args[args.indexOf('--session') + 1], 'thread-9');
        assert.ok(args.includes('--session-from-call'));
        assert.strictEqual(args[args.indexOf('--role') + 1], 'worker', 'the role lists the role\'s tools');
        assert.ok(args.includes('--preview'));
        assert.strictEqual(resumed['shell_environment_policy.set.TGXCODE_SESSION_ID'], 'thread-9',
            'a resumed thread\'s commands are attributed to it');
        const preview = resumed['mcp_servers.preview'];
        assert.ok(preview && path.basename(preview.args[0]) === 'preview-mcp.js');
        assert.strictEqual(preview.default_tools_approval_mode, 'approve');
        // Dotted keys, so the user's own servers and shell policy are left alone.
        for (const k of Object.keys(resumed)) assert.ok(k.includes('.'), `${k} is a dotted key`);
        ok('a resumed thread gets its id, its role, the preview server and TGXCODE_SESSION_ID');
    }

    {
        // A fork's sessionId is its parent's; the copy is named by thread/fork.
        const fork = threadConfig({ sessionId: 'parent', isNew: false, fork: true });
        assert.ok(!fork['mcp_servers.tgxcode'].args.includes('--session'),
            'a fork\'s server is not told the parent\'s id');
        assert.ok(fork['mcp_servers.tgxcode'].args.includes('--session-from-call'));
        assert.ok(!('shell_environment_policy.set.TGXCODE_SESSION_ID' in fork),
            'nor are its shells: their servers belong to the copy');
        ok('a fork learns its own id from the call, like a new thread');
    }

    {
        // The handshake sends it on thread/start and on thread/resume.
        const sent = [];
        const rpc = async (method, params) => {
            sent.push({ method, params });
            if (method === 'account/read') return { account: { type: 'chatgpt' } };
            if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 't' } };
            return {};
        };
        await new CodexAdapter({ rpc }).handshake({ cwd: '/w', isNew: true, sessionId: 'p' });
        await new CodexAdapter({ rpc }).handshake({ cwd: '/w', isNew: false, sessionId: 'thread-2', role: 'worker' });
        const start = sent.find(s => s.method === 'thread/start');
        const resume = sent.find(s => s.method === 'thread/resume');
        assert.ok(start.params.config['mcp_servers.tgxcode'], 'thread/start carries it');
        assert.ok(resume.params.config['mcp_servers.tgxcode'], 'thread/resume carries it');
        assert.ok(resume.params.config['mcp_servers.tgxcode'].args.includes('worker'));
        assert.strictEqual(resume.params.config['shell_environment_policy.set.TGXCODE_SESSION_ID'], 'thread-2');
        ok('the handshake puts the config on both thread/start and thread/resume');
    }

    // --- mcp.js learning its session from the call ----------------------------

    {
        const token = 'codex-mcp-test-token';
        fs.mkdirSync(path.dirname(cfg.TOKEN_FILE), { recursive: true });
        fs.writeFileSync(cfg.TOKEN_FILE, token, { mode: 0o600 });
        const seen = [];
        const bridge = http.createServer((req, res) => {
            seen.push({ url: req.url, auth: req.headers.authorization });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ wakes: [] }));
        });
        await new Promise(r => bridge.listen(0, '127.0.0.1', r));
        const port = bridge.address().port;

        const call = (extra, meta) => new Promise((resolve, reject) => {
            const child = spawn(process.execPath,
                [path.join(__dirname, '..', 'bridge', 'mcp.js'), '--port', String(port), ...extra],
                { env: { ...process.env, XDG_DATA_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
            let buf = '';
            child.stdout.on('data', (b) => {
                buf += b;
                const line = buf.split('\n').find(l => l.includes('"id":2'));
                if (line) { child.kill(); resolve(JSON.parse(line)); }
            });
            child.on('error', reject);
            const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
            send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
                name: 'wake_me_up', arguments: { action: 'list' }, ...(meta ? { _meta: meta } : {}) } });
            setTimeout(() => { child.kill(); reject(new Error('mcp.js did not answer')); }, 10_000);
        });

        // What Codex sends, measured on 0.172.0: the thread id on every call.
        const meta = { threadId: 'minted-thread', sessionId: 'minted-thread',
            'x-codex-turn-metadata': { thread_id: 'minted-thread' } };

        const a = await call(['--session-from-call'], meta);
        assert.ok(!a.result.isError, 'answered');
        assert.strictEqual(seen.pop().url, '/api/sessions/minted-thread/wake',
            'a new Codex thread\'s server reaches the bridge as the thread Codex minted');

        const b = await call(['--session', 'given', '--session-from-call'], meta);
        assert.ok(!b.result.isError);
        assert.strictEqual(seen.pop().url, '/api/sessions/minted-thread/wake',
            'the call\'s id wins over the one it was started with — a fork reports its own');

        const c = await call(['--session', 'claude-session'], meta);
        assert.ok(!c.result.isError);
        assert.strictEqual(seen.pop().url, '/api/sessions/claude-session/wake',
            'without the flag nothing changes: a Claude session keeps --session');

        const d = await call(['--session-from-call'], null);
        assert.ok(d.result.isError, 'no id from anywhere is said, not guessed');
        assert.ok(/does not know its own id/.test(d.result.content[0].text));
        assert.ok(seen.every(s => s.auth === `Bearer ${token}`), 'with the token off this test\'s disk');
        bridge.close();
        ok('mcp.js takes its session from _meta.threadId only under --session-from-call');
    }

    // --- reading the calls back --------------------------------------------------

    const codexItem = {
        type: 'mcpToolCall', id: 'exec-1', server: 'tgxcode', tool: 'suggest_session',
        arguments: { prompt: '  Tidy the scheduler  ', why: 'It drifted', title: 'Scheduler tidy' },
        status: 'completed',
    };

    {
        assert.deepStrictEqual(mcpCall(codexItem),
            { server: 'tgxcode', tool: 'suggest_session', input: codexItem.arguments });
        assert.deepStrictEqual(mcpCall({ name: 'mcp_tool_call', input: { server: 'tgxcode', tool: 'x', arguments: null } }),
            { server: 'tgxcode', tool: 'x', input: {} }, 'the tool event items.js makes reads the same');
        assert.deepStrictEqual(mcpCall({ name: 'mcp__tgxcode__message_session', input: { a: 1 } }),
            { server: null, tool: 'message_session', input: { a: 1 } });
        assert.strictEqual(mcpCall({ name: 'Bash', input: {} }), null);
        assert.ok(isOurs(codexItem, 'suggest_session'));
        assert.ok(!isOurs({ ...codexItem, server: 'someone_else' }, 'suggest_session'),
            'another server\'s suggest_session is not ours');
        assert.ok(isOurs({ name: 'mcp__claude-sessions__suggest_session' }, 'suggest_session'),
            'Claude names are matched on the suffix, as they always were');
        ok('an MCP call reads the same from a Claude block and a Codex item');
    }

    {
        const card = parseSuggestion(codexItem, { timestamp: '2026-11-26T10:00:00Z', cwd: '/proj' });
        assert.deepStrictEqual(card, {
            id: 'exec-1', kind: 'suggestion', ts: '2026-11-26T10:00:00Z',
            prompt: 'Tidy the scheduler', why: 'It drifted', title: 'Scheduler tidy', cwd: '/proj',
        });
        const claude = parseSuggestion({ type: 'tool_use', id: 'tu1', name: 'mcp__tgxcode__suggest_session',
            input: codexItem.arguments }, { timestamp: 't', cwd: '/proj' });
        assert.deepStrictEqual({ ...claude, id: 'exec-1', ts: '2026-11-26T10:00:00Z' }, card,
            'the same card whichever CLI made the call');
        assert.strictEqual(parseSuggestion({ ...codexItem, arguments: { prompt: ' ' } }, {}), null,
            'an empty prompt is no card');
        ok('parseSuggestion makes the same card from either shape');
    }

    {
        // A rollout as Codex 0.172.0 writes one (the shapes are copied from a
        // recorded probe thread): the item on disk is PascalCase, its fields as
        // the wire's for an MCP call.
        const thread = '01a2197a-39a3-72e0-86e5-5eac065169e0';
        const lines = [
            { timestamp: '2026-11-26T20:09:30.617Z', type: 'session_meta',
                payload: { id: thread, cwd: '/home/me/proj', cli_version: '0.172.0', originator: 'tgxcode' } },
            { timestamp: '2026-11-26T20:09:34.000Z', type: 'turn_context',
                payload: { turn_id: 'turn-1', cwd: '/home/me/proj', model: 'gpt-6-luna', approval_policy: 'never' } },
            { timestamp: '2026-11-26T20:09:34.022Z', type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look around' }],
                    internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
            { timestamp: '2026-11-26T20:09:37.302Z', type: 'event_msg', payload: { type: 'item_completed',
                thread_id: thread, turn_id: 'turn-1',
                item: { type: 'McpToolCall', id: 'exec-01d1', server: 'tgxcode', tool: 'suggest_session',
                    arguments: { prompt: 'Write the docs' }, status: 'completed',
                    result: { content: [{ type: 'text', text: 'Recorded.' }] }, duration: { secs: 0, nanos: 860305 } },
                started_at_ms: 1795723777301, completed_at_ms: 1795723777302 } },
            { timestamp: '2026-11-26T20:09:38.302Z', type: 'event_msg', payload: { type: 'item_completed',
                thread_id: thread, turn_id: 'turn-1',
                item: { type: 'McpToolCall', id: 'exec-02', server: 'tgxcode', tool: 'message_session',
                    arguments: { sessionId: 'other', text: 'over to you' }, status: 'completed',
                    result: { content: [{ type: 'text', text: 'Sent.' }] } },
                started_at_ms: 1795723778301, completed_at_ms: 1795723778302 } },
        ];
        const file = path.join(home, `rollout-2026-11-26T14-09-30-${thread}.jsonl`);
        fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

        const { events } = reader.buildEvents(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
        const card = events.find(e => e.kind === 'suggestion');
        assert.ok(card, 'the call is a card');
        assert.deepStrictEqual(card, { id: 'exec-01d1', kind: 'suggestion', ts: '2026-11-26T20:09:37.302Z',
            prompt: 'Write the docs', why: null, title: null, cwd: '/home/me/proj' },
            'with the thread\'s directory, since the call named none');
        assert.ok(!events.some(e => e.kind === 'tool' && e.id === 'exec-01d1'), 'and not a tool row as well');
        const handoff = events.find(e => e.kind === 'tool' && e.id === 'exec-02');
        assert.strictEqual(handoff.name, 'mcp_tool_call', 'any other call stays a tool row');
        assert.deepStrictEqual(handoff.input,
            { server: 'tgxcode', tool: 'message_session', arguments: { sessionId: 'other', text: 'over to you' } });

        const meta = reader.scanMeta(file);
        assert.strictEqual(meta.suggestions.length, 1, 'the index has it, so the Tasks board does');
        assert.strictEqual(meta.suggestions[0].id, 'exec-01d1');
        assert.strictEqual(meta.suggestions[0].cwd, '/home/me/proj');
        ok('a Codex rollout\'s suggest_session is a card in the view and a task in the index');
    }

    {
        assert.strictEqual(
            codexTools.describeTool({ name: 'mcp_tool_call', input: { server: 'tgxcode', tool: 'message_session' } }),
            'Running TGXCode: Message Session', 'the activity line names the tool as a Claude one\'s does');
        assert.strictEqual(codexTools.describeTool({ name: 'mcp_tool_call', input: {} }), 'Running an MCP tool');
        ok('the activity line names a Codex MCP call by its tool');
    }

    // --- dev-server attribution ------------------------------------------------

    if (process.platform === 'linux') {
        const run = (env) => new Promise((resolve) => {
            const child = spawn('sleep', ['5'], { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' });
            setTimeout(() => { const id = sessionOf(child.pid); child.kill(); resolve(id); }, 100);
        });
        assert.strictEqual(await run({ CODEX_THREAD_ID: 'thread-a', CLAUDE_CODE_SESSION_ID: 'claude-b' }), 'thread-a',
            'a Codex command\'s thread, over a Claude id inherited from whatever started the bridge');
        assert.strictEqual(await run({ TGXCODE_SESSION_ID: 'ours', CODEX_THREAD_ID: 'thread-a' }), 'ours',
            'ours first, as for the terminal pane');
        assert.strictEqual(await run({ CLAUDE_CODE_SESSION_ID: 'claude-b' }), 'claude-b', 'a Claude command as before');
        ok('a dev server a Codex command started is attributed to its thread');
    }

    {
        const { codexEnv } = require('../bridge/runtimes/codex/process');
        const before = process.env.CLAUDE_CODE_SESSION_ID;
        process.env.CLAUDE_CODE_SESSION_ID = 'the-bridges-own';
        process.env.TGXCODE_SESSION_ID = 'a-pane';
        const env = codexEnv();
        assert.ok(!('CLAUDE_CODE_SESSION_ID' in env) && !('TGXCODE_SESSION_ID' in env),
            'neither id the bridge carries reaches a Codex process');
        if (before === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = before;
        delete process.env.TGXCODE_SESSION_ID;
        ok('a Codex process inherits no other session\'s id');
    }

    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${pass} codex-mcp checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
