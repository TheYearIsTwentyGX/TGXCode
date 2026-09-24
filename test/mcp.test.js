'use strict';

// The agent tools (bridge/mcp.js), spoken to over stdio as `claude` would,
// against a stub bridge that records what it was asked.
//
// What this pins down is the wire each tool puts on the bridge — method, route,
// body, the token and the CSRF header — and what the model reads back. The
// bridge's side of those routes is tested where it lives; a mismatch between
// the two is the bug that only shows up as a tool that "does nothing".
//
// **Its own XDG_DATA_HOME**, so the token the tools read is a throwaway one and
// the stub can tell it apart from the user's.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mcp-'));
fs.mkdirSync(path.join(home, 'tgxcode'), { recursive: true });
fs.writeFileSync(path.join(home, 'tgxcode', 'token'), 'test-token\n');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// What the stub answers, per `METHOD path-without-query`, and what it was sent.
const answers = new Map();
const seen = [];

const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const [route, query = ''] = req.url.split('?');
        seen.push({
            method: req.method, route, query: new URLSearchParams(query),
            headers: req.headers, body: raw ? JSON.parse(raw) : null,
        });
        const a = answers.get(`${req.method} ${route}`) || { status: 404, body: { error: 'stub: no answer' } };
        res.writeHead(a.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(a.body));
    });
});

function startMcp(port) {
    const child = spawn(process.execPath, [
        path.join(__dirname, '..', 'bridge', 'mcp.js'), '--port', String(port), '--session', 'me',
    ], { env: { ...process.env, XDG_DATA_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const waiting = new Map();
    child.stdout.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            const w = waiting.get(msg.id);
            if (w) { waiting.delete(msg.id); w(msg); }
        }
    });
    let next = 1;
    const rpc = (method, params) => new Promise((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const call = async (name, args) => {
        seen.length = 0;
        const r = await rpc('tools/call', { name, arguments: args });
        return { text: r.result.content[0].text, isError: !!r.result.isError };
    };
    return { child, rpc, call };
}

const TASK = {
    id: 'toolu_1', sessionId: 'src', title: 'Split app.js', prompt: 'Move the core out.',
    why: 'too big', cwd: '/p', status: 'open', startedId: null,
    session: { title: 'Port to Preact', projectName: 'p' },
};

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const mcp = startMcp(port);

    try {
        const list = await mcp.rpc('tools/list', {});
        assert.deepStrictEqual(list.result.tools.map(t => t.name), [
            'suggest_session', 'list_sessions', 'message_session',
            'find_tasks', 'start_task', 'set_task_status', 'schedule_session',
        ]);
        for (const t of list.result.tools) {
            const modes = t.inputSchema.properties.permissionMode;
            if (modes) {
                assert.ok(!modes.enum.includes('bypassPermissions'),
                    `${t.name} does not offer bypassPermissions`);
            }
        }
        ok('tools/list has the seven tools, and none offers bypassPermissions');

        // find_tasks: the query string, the headers, and oldest first.
        answers.set('GET /api/suggestions', { status: 200, body: {
            ready: true,
            suggestions: [{ ...TASK, id: 'toolu_2', title: 'Second' }, TASK],
        } });
        let r = await mcp.call('find_tasks', { session: 'self', status: ['open'], query: 'split' });
        assert.strictEqual(r.isError, false);
        const got = seen[0];
        assert.strictEqual(got.headers.authorization, 'Bearer test-token');
        assert.strictEqual(got.query.get('session'), 'me', '"self" is this session');
        assert.strictEqual(got.query.get('status'), 'open');
        assert.strictEqual(got.query.get('q'), 'split');
        assert.ok(r.text.indexOf('Split app.js') < r.text.indexOf('Second'), 'oldest first');
        assert.match(r.text, /task: src:toolu_1/);
        assert.match(r.text, /Move the core out\./, 'three or fewer: prompts in full');
        ok('find_tasks sends session, status and q, and prints refs oldest first');

        // start_task as a session: one call to the start route.
        answers.set('POST /api/suggestions/src/toolu_1/start',
            { status: 200, body: { sessionId: 'new-1' } });
        r = await mcp.call('start_task', { task: 'src:toolu_1', as: 'session', extra: 'Open a PR.',
            permissionMode: 'auto' });
        assert.strictEqual(r.isError, false, r.text);
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].headers['x-tgxcode-client'], '1', 'the CSRF header');
        assert.deepStrictEqual(seen[0].body,
            { extra: 'Open a PR.', permissionMode: 'auto', cwd: null, from: 'me' });
        assert.match(r.text, /new-1/);
        ok('start_task as a session posts to the start route');

        // start_task as a subagent: read, claim with ifOpen, hand the prompt back.
        answers.set('POST /api/sessions/src/suggestions/toolu_1',
            { status: 200, body: { ok: true } });
        r = await mcp.call('start_task', { task: 'src:toolu_1', as: 'subagent', extra: 'Stack it.' });
        assert.strictEqual(r.isError, false, r.text);
        assert.deepStrictEqual(seen.map(s => `${s.method} ${s.route}`), [
            'GET /api/suggestions', 'POST /api/sessions/src/suggestions/toolu_1',
        ]);
        assert.deepStrictEqual(seen[1].body,
            { status: 'started', startedId: 'me', via: 'subagent', ifOpen: true });
        assert.match(r.text, /Move the core out\.\n\n---\n\nStack it\./);
        assert.match(r.text, /Agent tool/);
        ok('start_task as a subagent claims it for this session and returns the prompt');

        // A task that is not open is refused before anything is written.
        answers.set('GET /api/suggestions', { status: 200, body: {
            ready: true, suggestions: [{ ...TASK, status: 'started', startedId: 'other' }],
        } });
        r = await mcp.call('start_task', { task: 'src:toolu_1', as: 'subagent' });
        assert.strictEqual(r.isError, true);
        assert.match(r.text, /already started \(session other\)/);
        assert.strictEqual(seen.length, 1, 'no claim was sent');
        r = await mcp.call('start_task', { task: 'nonsense', as: 'subagent' });
        assert.strictEqual(r.isError, true);
        ok('start_task refuses a taken task and a malformed ref');

        // set_task_status: open is the undo, spelled null on the wire.
        r = await mcp.call('set_task_status', { task: 'src:toolu_1', status: 'completed',
            note: 'https://github.com/x/y/pull/1' });
        assert.strictEqual(r.isError, false);
        assert.deepStrictEqual(seen[0].body,
            { status: 'completed', note: 'https://github.com/x/y/pull/1' });
        await mcp.call('set_task_status', { task: 'src:toolu_1', status: 'open' });
        assert.strictEqual(seen[0].body.status, null);
        ok('set_task_status posts completed with its note, and open as null');

        // schedule_session: at, from, and the mode refusal.
        answers.set('POST /api/schedules', { status: 200, body: { schedule: {
            id: 'sch-1', title: 'Work the list', cron: '0 9 25 9 *', once: true,
            cronText: 'once, 25 September at 9:00 AM', nextRunAt: Date.now() + 1e6,
            cwd: '/p', permissionMode: 'auto', test: false,
        } } });
        r = await mcp.call('schedule_session', { prompt: 'Work the list', at: '2026-09-25T09:00' });
        assert.strictEqual(r.isError, false, r.text);
        assert.strictEqual(seen[0].body.at, '2026-09-25T09:00');
        assert.strictEqual(seen[0].body.cron, null);
        assert.strictEqual(seen[0].body.from, 'me');
        assert.strictEqual(seen[0].body.permissionMode, 'auto');
        assert.match(r.text, /sch-1/);
        assert.match(r.text, /once, 25 September/);

        r = await mcp.call('schedule_session', { prompt: 'x', at: '2026-09-25T09:00',
            permissionMode: 'bypassPermissions' });
        assert.strictEqual(r.isError, true);
        assert.strictEqual(seen.length, 0, 'refused before the bridge is asked');
        r = await mcp.call('schedule_session', { prompt: 'x' });
        assert.strictEqual(r.isError, true, 'needs at or cron');
        r = await mcp.call('schedule_session', { prompt: 'x', at: 'a', cron: '0 2 * * *' });
        assert.strictEqual(r.isError, true, 'not both');

        // The bridge's refusal reaches the model verbatim.
        answers.set('POST /api/schedules', { status: 400, body: { error: 'x is in the past' } });
        r = await mcp.call('schedule_session', { prompt: 'x', at: '2020-01-01T00:00' });
        assert.strictEqual(r.isError, true);
        assert.strictEqual(r.text, 'x is in the past');
        ok('schedule_session sends at and from, and refuses bypass, neither, and both');
    } finally {
        mcp.child.kill();
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
    console.log(`\n${pass} groups passed`);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
