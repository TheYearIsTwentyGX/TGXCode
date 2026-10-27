'use strict';

// The bridge's half of an agent driving the preview: what a session is given,
// and how its Playwright reaches the window.
//
//  - bridge/runner.js: the `preview` server and open_in_preview are in a
//    session's --mcp-config only when `preview.agentControl` is on.
//  - bridge/brief.js: the brief mentions them only then.
//  - bridge/preview-agent.js: the endpoint a window registers, and the
//    open handshake with the window.
//  - bridge/mcp.js: open_in_preview, spoken to over stdio, against a stub bridge.
//  - bridge/preview-mcp.js: the relay — through to the shell's endpoint when one
//    is registered, and a browser that says why not when none is.
//
// **Its own XDG_DATA_HOME**, so the token and the endpoint file are throwaways.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-preview-'));
process.env.XDG_DATA_HOME = home;
fs.mkdirSync(path.join(home, 'tgxcode'), { recursive: true });
fs.writeFileSync(path.join(home, 'tgxcode', 'token'), 'test-token\n');
process.env.TGXCODE_PREVIEW_OPEN_WAIT_MS = '150';
process.env.TGXCODE_PREVIEW_ASK_WAIT_MS = '400';
const RELAY_BRIDGE_PORT = 45977;
process.argv.push('--port', String(RELAY_BRIDGE_PORT));

const { mcpConfig, PREVIEW_TOOLS } = require('../bridge/runner.js');
const brief = require('../bridge/brief.js');
const previewAgent = require('../bridge/preview-agent.js');
const relay = require('../bridge/preview-mcp.js');
const { PreviewCdp } = require('../app/preview-cdp');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const later = (ms) => new Promise(r => setTimeout(r, ms));

function cdpClient(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const waiting = new Map();
        let n = 0;
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
        ws.onopen = () => resolve({
            ws,
            send: (method, params = {}) => new Promise((res) => { const id = ++n; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); }),
        });
        ws.onerror = () => reject(new Error('could not connect'));
    });
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }).on('error', reject);
    });
}

// The bridge's timers are unref'd, as they should be; this keeps the test alive
// while it waits on one.
setInterval(() => {}, 1000);

(async () => {
    // ── the session's --mcp-config ───────────────────────────────────────
    {
        const off = JSON.parse(mcpConfig('sid-1', null));
        assert.deepStrictEqual(Object.keys(off.mcpServers), ['tgxcode']);
        assert.ok(!off.mcpServers.tgxcode.args.includes('--preview'));
        const on = JSON.parse(mcpConfig('sid-1', 'worker', { preview: true }));
        assert.deepStrictEqual(Object.keys(on.mcpServers), ['tgxcode', 'preview']);
        assert.ok(on.mcpServers.tgxcode.args.includes('--preview'), 'tgxcode lists open_in_preview');
        assert.ok(on.mcpServers.tgxcode.args.includes('--role'), 'and keeps the role');
        assert.strictEqual(on.mcpServers.preview.command, process.execPath);
        assert.strictEqual(path.basename(on.mcpServers.preview.args[0]), 'preview-mcp.js');
        assert.deepStrictEqual(on.mcpServers.preview.args.slice(1), ['--port', String(require('../bridge/config').PORT)]);
        assert.doesNotMatch(mcpConfig('sid-1', null, { preview: true }), /token|[0-9a-f]{48}/,
            'no token on the command line');
        assert.deepStrictEqual(PREVIEW_TOOLS, ['mcp__preview', 'mcp__tgxcode__open_in_preview']);
        ok('the preview server and open_in_preview are in --mcp-config only when the setting is on');
    }

    // ── the brief ─────────────────────────────────────────────────────────
    {
        const compose = (on) => brief.compose({ features: brief.featuresFor({ prefs: { preview: { agentControl: on } } }) });
        const off = compose(false);
        assert.doesNotMatch(off.text, /open_in_preview/);
        assert.doesNotMatch(off.text, /^- preview: /m);
        assert.strictEqual(off.sections.find(s => s.id === 'preview').available, false);
        assert.match(brief.guide(off, 'preview').text, /not available to this session/);
        const on = compose(true);
        assert.deepStrictEqual(on.problems, []);
        assert.match(on.text, /^- open_in_preview: /m);
        assert.match(on.text, /^- preview: /m);
        const text = brief.guide(on, 'preview').text;
        assert.match(text, /Local pages \(localhost, 127\.0\.0\.1\) need no approval/);
        assert.match(text, /Any other site needs the user's yes, per site/);
        assert.match(text, /prompt stays open/);
        assert.match(text, /do not reconnect unless they ask/);
        assert.match(text, /only when they ask you to use the preview/);
        ok('the brief mentions the preview only when agents may drive it');
    }

    // ── the endpoint a window registers ──────────────────────────────────
    {
        const good = `http://127.0.0.1:53310/${'ab'.repeat(24)}`;
        for (const bad of ['http://10.0.0.5:53310/' + 'ab'.repeat(24), 'http://127.0.0.1:53310/short',
            'https://127.0.0.1:53310/' + 'ab'.repeat(24), `${good}/extra`, 'http://127.0.0.1:99999/' + 'ab'.repeat(24), null]) {
            assert.strictEqual(previewAgent.register(bad, { port: 1 }).ok, false, String(bad));
        }
        assert.ok(previewAgent.register(good, { port: 45001 }).ok);
        const file = previewAgent.fileFor(45001);
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'the file holding the token is the user\'s alone');
        const r = previewAgent.read({ port: 45001 });
        assert.deepStrictEqual([r.host, r.port, r.token], ['127.0.0.1', 53310, 'ab'.repeat(24)]);
        assert.strictEqual(previewAgent.read({ port: 45002 }), null, 'per bridge port');
        previewAgent.clear({ port: 45001 });
        assert.strictEqual(previewAgent.read({ port: 45001 }), null);
        assert.ok(previewAgent.checkOpenUrl('https://pcpartpicker.com/list').ok, 'any site may be asked for');
        assert.strictEqual(previewAgent.checkOpenUrl('http://localhost:5173/').local, true);
        for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@example.com/', 'nope']) {
            assert.strictEqual(previewAgent.checkOpenUrl(bad).ok, false, bad);
        }
        ok('only an endpoint the shell would mint is kept, in a 0600 file per bridge port');
    }

    // ── the open handshake ───────────────────────────────────────────────
    {
        assert.strictEqual((await previewAgent.requestOpen({ url: 'http://localhost:1/' }, () => {}, 0)).outcome, 'no-window');
        const silent = await previewAgent.requestOpen({ url: 'http://localhost:1/' }, () => {}, 1);
        assert.strictEqual(silent.outcome, 'no-window', 'a window that cannot drive the preview stays quiet');
        const sent = [];
        const asked = previewAgent.requestOpen({ url: 'https://pcpartpicker.com/', sessionId: 'S' },
            (event, data) => sent.push([event, data]), 1);
        assert.strictEqual(sent[0][0], 'preview-open');
        assert.deepStrictEqual(Object.keys(sent[0][1]), ['id', 'url', 'sessionId']);
        assert.ok(previewAgent.answerOpen(sent[0][1].id, { pending: true }));
        await later(250);
        assert.ok(previewAgent.answerOpen(sent[0][1].id, { ok: true, outcome: 'opened', url: 'https://pcpartpicker.com/' }),
            'still waiting past the short timeout, because the window said it was asking');
        assert.deepStrictEqual(await asked, { ok: true, outcome: 'opened', url: 'https://pcpartpicker.com/' });
        assert.strictEqual(previewAgent.answerOpen(sent[0][1].id, { ok: true }), false, 'answered once');
        // The window that was asking went away (reloaded) before it could answer.
        sent.length = 0;
        const orphaned = previewAgent.requestOpen({ url: 'https://www.iana.org/', sessionId: 'S' },
            (event, data) => sent.push([event, data]), 1);
        previewAgent.answerOpen(sent[0][1].id, { pending: true });
        assert.deepStrictEqual(await orphaned, { ok: false, outcome: 'waiting', error: previewAgent.waitingText('https://www.iana.org/') },
            'a window gone mid-ask means waiting, not "no window" — the ask is the shell\'s and outlives the page');
        const web = await import('../web/preview-open.js');
        assert.strictEqual(previewAgent.waitingText('https://www.iana.org/'), web.waitingText('www.iana.org'),
            'the bridge and the window say waiting in the same words');
        ok('the bridge waits briefly for a window, and longer for one that is asking the user');
    }

    // ── open_in_preview over stdio ───────────────────────────────────────
    {
        const seen = [];
        let answer = { status: 200, body: { ok: true, outcome: 'opened', url: 'http://localhost:5173/' } };
        const stub = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => { raw += c; });
            req.on('end', () => {
                seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
                res.writeHead(answer.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(answer.body));
            });
        });
        await new Promise(r => stub.listen(0, '127.0.0.1', r));
        const start = (extra) => {
            const child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'mcp.js'),
                '--port', String(stub.address().port), '--session', 'me', ...extra],
            { env: { ...process.env, XDG_DATA_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
            let buf = '';
            const waiting = new Map();
            let n = 0;
            child.stdout.on('data', (c) => {
                buf += c;
                let i;
                while ((i = buf.indexOf('\n')) !== -1) {
                    const m = JSON.parse(buf.slice(0, i));
                    buf = buf.slice(i + 1);
                    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
                }
            });
            const rpc = (method, params) => new Promise((res) => {
                const id = ++n; waiting.set(id, res);
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            });
            return { child, rpc };
        };
        const plain = start([]);
        const names = (await plain.rpc('tools/list', {})).result.tools.map(t => t.name);
        assert.ok(!names.includes('open_in_preview'), 'not listed without --preview');
        const refused = await plain.rpc('tools/call', { name: 'open_in_preview', arguments: { url: 'http://localhost:1/' } });
        assert.ok(refused.result.isError);
        plain.child.kill();

        const p = start(['--preview']);
        const tools = (await p.rpc('tools/list', {})).result.tools;
        const tool = tools.find(t => t.name === 'open_in_preview');
        assert.ok(tool, 'listed with --preview');
        assert.match(tool.description, /only when the user asks you to use it/);
        const call = (url) => p.rpc('tools/call', { name: 'open_in_preview', arguments: { url } });

        let r = await call('http://localhost:5173/');
        assert.deepStrictEqual(seen.at(-1).body, { url: 'http://localhost:5173/', sessionId: 'me' });
        assert.strictEqual(seen.at(-1).url, '/api/preview/open');
        assert.strictEqual(seen.at(-1).headers.authorization, 'Bearer test-token');
        assert.strictEqual(seen.at(-1).headers['x-tgxcode-client'], '1');
        assert.ok(!r.result.isError);
        assert.match(r.result.content[0].text, /^Opened http:\/\/localhost:5173\/ in the user's preview/);

        answer = { status: 202, body: { ok: false, outcome: 'waiting', error: 'Waiting for the user to approve amazon.com. …' } };
        r = await call('https://amazon.com/');
        assert.ok(!r.result.isError, 'waiting is not an error — an agent told "error" retries');
        assert.match(r.result.content[0].text, /^Waiting for the user to approve amazon\.com/);

        answer = { status: 403, body: { ok: false, outcome: 'denied', error: 'Not opened: the user denied example.com for agent control.' } };
        r = await call('https://example.com/');
        assert.ok(r.result.isError);
        assert.strictEqual(r.result.content[0].text, 'Not opened: the user denied example.com for agent control.');
        p.child.kill();
        stub.close();
        ok('open_in_preview is listed only with --preview, posts the URL and session, and reads back each outcome');
    }

    // ── the relay ─────────────────────────────────────────────────────────
    {
        await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${relay.server.address().port}/${relay.TOKEN}`;
        assert.strictEqual((await getJson(`http://127.0.0.1:${relay.server.address().port}/nope/json/version`)).status, 403);

        // Nothing registered: a browser that says why.
        let v = (await getJson(`${base}/json/version`)).body;
        let c = await cdpClient(v.webSocketDebuggerUrl);
        const refused = await c.send('Browser.getVersion');
        assert.strictEqual(refused.error.message, relay.UNAVAILABLE);
        assert.match(relay.UNAVAILABLE, /no browser preview to drive/);
        c.ws.close();

        // A window registered: straight through to it.
        const dbg = new EventEmitter();
        dbg.attached = false;
        Object.assign(dbg, {
            attach() { dbg.attached = true; }, detach() { dbg.attached = false; }, isAttached: () => dbg.attached,
            sendCommand: async (m) => (m === 'Target.getTargetInfo' ? { targetInfo: { targetId: 'REAL-1' } } : {}),
        });
        const guest = { id: 1, debugger: dbg, getURL: () => 'http://localhost:5173/', getTitle: () => 'App', isDestroyed: () => false };
        const cdp = new PreviewCdp({ guests: () => [guest], navigationRefusal: () => null, product: 'Chrome/126' });
        previewAgent.register(await cdp.start(), { port: RELAY_BRIDGE_PORT });
        v = (await getJson(`${base}/json/version`)).body;
        assert.strictEqual(v.Browser, 'Chrome/126');
        assert.ok(v.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${relay.server.address().port}/${relay.TOKEN}/`),
            'the WebSocket comes back through the relay');
        assert.deepStrictEqual((await getJson(`${base}/json/list`)).body.map(t => t.id), ['REAL-1']);
        c = await cdpClient(v.webSocketDebuggerUrl);
        assert.strictEqual((await c.send('Browser.getVersion')).result.product, 'Chrome/126');
        assert.deepStrictEqual((await c.send('Target.getTargets')).result.targetInfos.map(t => t.targetId), ['REAL-1']);
        assert.ok(cdp.state().connected);
        c.ws.close();

        // The window restarted with a new token: the next connection finds it.
        await cdp.stop();
        previewAgent.register(await cdp.start(), { port: RELAY_BRIDGE_PORT });
        c = await cdpClient((await getJson(`${base}/json/version`)).body.webSocketDebuggerUrl);
        assert.strictEqual((await c.send('Browser.getVersion')).result.product, 'Chrome/126');
        c.ws.close();

        // The window went away and left its file behind.
        await cdp.stop();
        c = await cdpClient((await getJson(`${base}/json/version`)).body.webSocketDebuggerUrl);
        assert.strictEqual((await c.send('Browser.getVersion')).error.message, relay.UNAVAILABLE);
        c.ws.close();
        relay.server.close();
        ok('the relay finds the window\'s current endpoint per connection, and says why when there is none');

        const env = relay.playwrightEnv('http://127.0.0.1:1/x', { PATH: '/bin', PLAYWRIGHT_MCP_HEADLESS: 'true', PLAYWRIGHT_MCP_EXTENSION: '1' });
        assert.deepStrictEqual(env, { PATH: '/bin', PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:1/x' });
        const [cmd, args] = relay.playwrightCommand({});
        assert.match(path.basename(cmd), /^npx/);
        assert.deepStrictEqual(args, ['-y', '@playwright/mcp@latest'], 'the package the Playwright plugin runs');
        assert.deepStrictEqual(relay.playwrightCommand({ TGXCODE_PLAYWRIGHT_MCP: '/opt/pw/cli.js' }), [process.execPath, ['/opt/pw/cli.js']]);
        ok('Playwright MCP is started with only the relay as its browser setting');
    }

    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${pass} preview-mcp checks passed`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
