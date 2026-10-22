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
// install_on_phone waits 90s for a phone; this test has no minute and a half.
process.env.TGXCODE_PHONE_INSTALL_WAIT_MS = '300';
process.env.TGXCODE_PHONE_INSTALL_POLL_MS = '20';

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

function startMcp(port, extra = []) {
    const child = spawn(process.execPath, [
        path.join(__dirname, '..', 'bridge', 'mcp.js'), '--port', String(port), '--session', 'me', ...extra,
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
            'tgxcode_guide', 'suggest_session', 'list_sessions', 'message_session',
            'find_tasks', 'start_task', 'set_task_status', 'schedule_session', 'install_on_phone',
            'phone_install_status',
        ]);
        for (const t of list.result.tools) {
            const modes = t.inputSchema.properties.permissionMode;
            if (modes) {
                assert.ok(!modes.enum.includes('bypassPermissions'),
                    `${t.name} does not offer bypassPermissions`);
            }
        }
        ok('tools/list has the ten tools, and none offers bypassPermissions');

        // tgxcode_guide: the bridge composes and gates; the tool passes where it
        // is and what it is, and turns a refusal into a tool error.
        answers.set('GET /api/brief/guide', { status: 200, body: { ok: true, text: '## Servers' } });
        let g = await mcp.call('tgxcode_guide', { topic: ' servers ' });
        assert.strictEqual(g.isError, false);
        assert.strictEqual(g.text, '## Servers');
        assert.strictEqual(seen[0].query.get('topic'), 'servers');
        assert.strictEqual(seen[0].query.get('cwd'), process.cwd());
        assert.strictEqual(seen[0].query.get('role'), null, 'no role, none sent');
        g = await mcp.call('tgxcode_guide', {});
        assert.strictEqual(seen[0].query.get('topic'), null, 'no topic lists them');
        answers.set('GET /api/brief/guide', { status: 200, body: { ok: false, text: 'switched off' } });
        g = await mcp.call('tgxcode_guide', { topic: 'phone' });
        assert.strictEqual(g.isError, true);
        assert.strictEqual(g.text, 'switched off');
        const wk = startMcp(port, ['--role', 'worker']);
        try {
            answers.set('GET /api/brief/guide', { status: 200, body: { ok: true, text: 'x' } });
            await wk.call('tgxcode_guide', { topic: 'orchestration' });
            assert.strictEqual(seen[0].query.get('role'), 'worker');
        } finally {
            wk.child.kill();
        }
        ok('tgxcode_guide asks the bridge with its cwd, role and topic, and a refusal is a tool error');

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

        // install_on_phone: files the APK with this session's id, then polls the
        // record until the phone settles it or the wait runs out.
        const REC = { id: 'inst-1', fileName: 'app-debug.apk', label: 'app-debug.apk', state: 'pending',
            message: null, packageName: null, versionName: null };
        const phone = async (later, args = { apk_path: 'app/build/app-debug.apk' }) => {
            answers.set('POST /api/phone-installs', { status: 201, body: REC });
            answers.set('GET /api/phone-installs/inst-1', { status: 200, body: { ...REC, ...later } });
            return mcp.call('install_on_phone', args);
        };
        r = await phone({ state: 'installed', packageName: 'com.foo', versionName: '1.2' },
            { apk_path: 'app/build/app-debug.apk', label: ' Notes ' });
        assert.strictEqual(r.isError, false, r.text);
        assert.deepStrictEqual(seen[0].body, {
            path: path.resolve('app/build/app-debug.apk'), label: 'Notes', sessionId: 'me',
        }, 'a relative path is resolved against the working directory');
        assert.strictEqual(seen[0].headers['x-tgxcode-client'], '1');
        assert.strictEqual(seen[1].route, '/api/phone-installs/inst-1');
        assert.match(r.text, /^Installed com\.foo 1\.2 on the phone\./);
        r = await phone({ state: 'needs_action', message: 'Tap Install' });
        assert.match(r.text, /^Waiting on the phone: the user has to tap Install/);
        r = await phone({ state: 'failed', message: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' });
        assert.match(r.text, /could not install app-debug\.apk: INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
        assert.match(r.text, /uninstall the existing app on the phone/);
        r = await phone({ state: 'failed', message: 'out of space' });
        assert.doesNotMatch(r.text, /uninstall/, 'only a signature failure says to uninstall');
        r = await phone({ state: 'pending' });
        assert.match(r.text, /^No phone picked it up within 90s — it stays queued for 24 hours/);
        assert.ok(seen.length > 2, 'it polled while it waited');
        r = await phone({ state: 'downloading', stalled: false, updatedAt: Date.now() });
        assert.match(r.text, /still working on app-debug\.apk \(downloading\) after 90s/);
        r = await phone({ state: 'downloading', stalled: true, updatedAt: Date.now() - 120_000,
            progress: { bytes: 1048576, total: 4194304 } });
        assert.match(r.text, /^Stalled: the phone claimed app-debug\.apk \(downloading \(25%, 1\.0 of 4\.0 MB\)\) but has not reported for 2m/);
        assert.match(r.text, /Retry/);
        r = await mcp.call('install_on_phone', {});
        assert.strictEqual(r.isError, true);
        assert.strictEqual(seen.length, 0, 'refused before the bridge is asked');
        answers.set('POST /api/phone-installs', { status: 400, body: { error: '/x.apk is not a zip' } });
        r = await mcp.call('install_on_phone', { apk_path: '/x.apk' });
        assert.strictEqual(r.isError, true);
        assert.strictEqual(r.text, '/x.apk is not a zip', 'the bridge\'s refusal, verbatim');
        ok('install_on_phone files the APK, waits for the phone, and says what happened');

        // phone_install_status: by id, or this session's latest from the list.
        answers.set('GET /api/phone-installs/inst-1', { status: 200, body: { ...REC, state: 'downloading',
            stalled: false, attempts: 1, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 2000,
            progress: { bytes: 524288, total: 1048576 } } });
        r = await mcp.call('phone_install_status', { id: ' inst-1 ' });
        assert.strictEqual(r.isError, false, r.text);
        assert.strictEqual(seen[0].route, '/api/phone-installs/inst-1');
        assert.strictEqual(seen[0].method, 'GET');
        assert.match(r.text, /^The phone is still working on app-debug\.apk \(downloading \(50%, 0\.5 of 1\.0 MB\)\)\. /);
        assert.doesNotMatch(r.text, /after 90s/, 'no wait happened here');
        assert.match(r.text, /install id: inst-1/);
        assert.match(r.text, /attempts: 1/);
        answers.set('GET /api/phone-installs', { status: 200, body: { installs: [
            { ...REC, id: 'other', sessionId: 'someone-else', state: 'installed' },
            { ...REC, id: 'mine-new', sessionId: 'me', state: 'pending', attempts: 1,
                message: 'Phone stopped responding; queued again', createdAt: Date.now() - 300_000 },
            { ...REC, id: 'mine-old', sessionId: 'me', state: 'installed' },
        ] } });
        r = await mcp.call('phone_install_status', {});
        assert.strictEqual(seen[0].route, '/api/phone-installs');
        assert.match(r.text, /install id: mine-new/, 'the newest of this session\'s, not anyone\'s');
        assert.match(r.text, /^Queued for the phone for 5m, not picked up yet \(Phone stopped responding; queued again\)/);
        answers.set('GET /api/phone-installs', { status: 200, body: { installs: [
            { ...REC, id: 'other', sessionId: 'someone-else', state: 'installed' }] } });
        r = await mcp.call('phone_install_status', {});
        assert.strictEqual(r.isError, true);
        assert.match(r.text, /has not filed a phone install/);
        r = await mcp.call('phone_install_status', { id: 'nope' });
        assert.strictEqual(r.isError, true);
        assert.match(r.text, /No phone install with id nope/);
        ok('phone_install_status reads one by id, or this session\'s latest, and says where it got to');

        // set_summary, as an orchestrator: the brief's structured fields are in the
        // schema, and only the ones the model passed reach the bridge — a field
        // left out must stay out, because the bridge reads absent as "keep it".
        const orch = startMcp(port, ['--role', 'orchestrator']);
        try {
            const tools = (await orch.rpc('tools/list', {})).result.tools;
            const ss = tools.find(t => t.name === 'set_summary');
            assert.ok(ss, 'an orchestrator has set_summary');
            assert.deepStrictEqual(Object.keys(ss.inputSchema.properties).sort(),
                ['decisions', 'goal', 'mergeOrder', 'text']);
            answers.set('POST /api/sessions/me/orchestrator/summary', { status: 200, body: { summary: {} } });
            r = await orch.call('set_summary', { text: 'brief', mergeOrder: [212, 213],
                decisions: [{ text: 'Ship it?', options: ['Yes', 'No'] }] });
            assert.strictEqual(r.isError, false);
            assert.deepStrictEqual(seen[0].body, { text: 'brief', mergeOrder: [212, 213],
                decisions: [{ text: 'Ship it?', options: ['Yes', 'No'] }] });
            r = await orch.call('set_summary', { text: 'prose only' });
            assert.deepStrictEqual(seen[0].body, { text: 'prose only' });

            // set_auto_resume: the orchestrator's own settings, by PUT, marked as
            // the agent's doing so the bridge stamps it so.
            assert.ok(tools.find(t => t.name === 'set_auto_resume'), 'an orchestrator has set_auto_resume');
            answers.set('PUT /api/sessions/me/orchestrator', { status: 200, body: {
                settings: { usageStop: { enabled: true, autoResume: true } },
                paused: { reason: 'five_hour at 91%', resumeAt: Date.now() + 3600_000 } } });
            r = await orch.call('set_auto_resume', { on: true, reason: '  user away  ' });
            assert.strictEqual(r.isError, false);
            assert.strictEqual(seen[0].method, 'PUT');
            assert.strictEqual(seen[0].route, '/api/sessions/me/orchestrator');
            assert.deepStrictEqual(seen[0].body, { settings: { usageStop: { autoResume: true } },
                by: 'agent', reason: 'user away' });
            assert.match(r.text, /Auto-resume on\. You are paused; you will be woken at/);
            r = await orch.call('set_auto_resume', { on: 'yes' });
            assert.strictEqual(r.isError, true);
            assert.strictEqual(seen.length, 0, 'refused before the bridge is asked');

            // get_usage says who set it, and how to change it.
            answers.set('GET /api/sessions/me/orchestrator/usage', { status: 200, body: { windows: [],
                cutoff: { enabled: true, percent: 90, window: 'five_hour', autoResume: true,
                    autoResumeBy: { by: 'agent', at: Date.now() - 120_000, reason: 'user away' } } } });
            r = await orch.call('get_usage', {});
            assert.match(r.text, /Set by you 2m ago \(user away\)\. set_auto_resume changes it\./);
            answers.set('GET /api/sessions/me/orchestrator/usage', { status: 200, body: { windows: [],
                cutoff: { enabled: true, percent: 90, window: 'five_hour', autoResume: false, autoResumeBy: null } } });
            r = await orch.call('get_usage', {});
            assert.match(r.text, /the default this orchestrator started with/);
        } finally {
            orch.child.kill();
        }
        ok('set_summary carries the brief\'s goal, decisions and merge order, and only when given');
        ok('set_auto_resume PUTs the orchestrator\'s own setting as the agent, and get_usage says who set it');
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
