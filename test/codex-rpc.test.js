'use strict';

// The Codex JSON-RPC client — bridge/codex/rpc.js, client.js, protocol.js.
//
// No bridge and no real `codex`. Two halves:
//
//   - **The connection on its own**, over a pair of PassThrough streams, for the
//     rules that recordings rarely exercise: a server request nobody handles, a
//     handler that answers later, a line split across chunks, a close with
//     requests outstanding, and the notification called `error` — which is the
//     one that crashed the first signed-out recording, because EventEmitter
//     throws on an unheard `error`.
//   - **Every recording in test/fixtures/codex/ replayed** through the stub, with
//     TGXCODE_CODEX_BIN pointed at it before client.js is required (it reads the
//     variable at load, like CLAUDE_BIN). The driver sends what the recorder sent,
//     in the same order relative to what came back, and the stub's log must show
//     no mismatch and nothing unfinished. A new fixture is covered by dropping it
//     in the directory.
//
// It also checks that protocol.js's lists still match the committed schema, so a
// regenerated schema says which notification names moved.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const FIX = path.join(__dirname, 'fixtures', 'codex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rpc-test-'));
const bin = path.join(root, 'fake-codex');
// Shebanged with process.execPath, as in runner.test.js: a login shell here has
// no node on PATH.
fs.writeFileSync(bin, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(FIX, 'stub.js'))});\n`,
    { mode: 0o755 });
process.env.TGXCODE_CODEX_BIN = bin;

const { Connection, RpcError, RpcClosedError, DEFER, METHOD_NOT_FOUND } = require('../bridge/codex/rpc');
const { spawnAppServer, initialize, CODEX_BIN } = require('../bridge/codex/client');
const protocol = require('../bridge/codex/protocol');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const tick = () => new Promise(r => setImmediate(r));

/** A Connection whose far end is in the test's hands. */
function pair(opts = {}) {
    const toClient = new PassThrough();
    const fromClient = new PassThrough();
    const logged = [];
    const rpc = new Connection({ input: toClient, output: fromClient,
        log: (l) => logged.push(l), ...opts });
    const sent = [];
    let buf = '';
    fromClient.on('data', (b) => {
        buf += b;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { sent.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    });
    const server = (o) => toClient.write(JSON.stringify(o) + '\n');
    return { rpc, sent, logged, server, toClient };
}

async function unit() {
    {
        const { rpc, sent, server } = pair();
        const p = rpc.request('thread/start', { cwd: '/x' });
        await tick();
        assert.deepStrictEqual(sent[0], { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: '/x' } });
        server({ id: 1, result: { thread: { id: 't' } } });      // no jsonrpc, as Codex writes it
        assert.deepStrictEqual(await p, { thread: { id: 't' } });
        const q = rpc.request('turn/start', {});
        server({ id: 2, error: { code: -32600, message: 'bad', data: { k: 1 } } });
        await assert.rejects(q, (e) => e instanceof RpcError && e.code === -32600
            && /turn\/start: bad/.test(e.message) && e.data.k === 1);
        ok('a request resolves with its result and rejects with an RpcError');
    }
    {
        const { rpc, logged, server } = pair({ known: ['error', 'turn/started'] });
        const seen = [];
        rpc.onNotification('error', (p) => seen.push(['error', p.willRetry]));
        rpc.on('notification', (m) => seen.push(['any', m]));
        server({ method: 'error', params: { willRetry: true } });
        server({ method: 'turn/started', params: {} });
        server({ method: 'thread/brandNew', params: {} });
        server({ method: 'thread/brandNew', params: {} });
        await tick();
        assert.deepStrictEqual(seen, [['any', 'error'], ['error', true], ['any', 'turn/started']]);
        assert.strictEqual(logged.filter(l => l.includes('thread/brandNew')).length, 1);
        ok('the `error` notification is delivered, not thrown; an unknown one is logged once and dropped');
    }
    {
        const { rpc, sent, logged, server } = pair();
        server({ id: 'srv-1', method: 'item/tool/call', params: {} });
        server({ id: 'srv-2', method: 'item/tool/call', params: {} });
        await tick();
        assert.deepStrictEqual(sent.map(m => [m.id, m.error.code]),
            [['srv-1', METHOD_NOT_FOUND], ['srv-2', METHOD_NOT_FOUND]]);
        assert.strictEqual(logged.length, 1);
        assert.strictEqual(rpc.pendingRequests.size, 0);
        ok('a server request with no handler is refused, not left hanging');
    }
    {
        const { rpc, sent, server } = pair();
        rpc.handle('item/fileChange/requestApproval', () => ({ decision: 'decline' }));
        rpc.handle('item/commandExecution/requestApproval', async () => { throw new RpcError(-32000, 'no'); });
        rpc.handle('item/tool/call', () => { throw new Error('boom'); });
        server({ id: 7, method: 'item/fileChange/requestApproval', params: {} });
        server({ id: 8, method: 'item/commandExecution/requestApproval', params: {} });
        server({ id: 9, method: 'item/tool/call', params: {} });
        await tick(); await tick();
        const by = Object.fromEntries(sent.map(m => [m.id, m]));
        assert.deepStrictEqual(by[7].result, { decision: 'decline' });
        assert.strictEqual(by[8].error.code, -32000);
        assert.strictEqual(by[9].error.code, -32603);
        ok('a handler answers with its value, its RpcError, or -32603');
    }
    {
        const { rpc, sent, server } = pair();
        const resolved = [];
        rpc.handle('item/commandExecution/requestApproval', () => DEFER);
        rpc.on('resolved', (id, req) => resolved.push([id, req && req.method]));
        server({ id: 0, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } });
        server({ id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'rm' } });
        await tick();
        assert.strictEqual(sent.length, 0);
        assert.deepStrictEqual([...rpc.pendingRequests.keys()], [0, 1]);
        assert.strictEqual(rpc.respond(0, { decision: 'accept' }), true);
        assert.strictEqual(rpc.respond(0, { decision: 'accept' }), false, 'answered twice');
        assert.deepStrictEqual(sent[0], { jsonrpc: '2.0', id: 0, result: { decision: 'accept' } });
        server({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 1 } });
        await tick();
        assert.deepStrictEqual(resolved, [[1, 'item/commandExecution/requestApproval']]);
        assert.strictEqual(rpc.pendingRequests.size, 0);
        assert.strictEqual(rpc.respond(1, { decision: 'accept' }), false);
        ok('a deferred request is answered by id later, and withdrawn by serverRequest/resolved');
    }
    {
        const { rpc, logged, toClient } = pair();
        const p = rpc.request('model/list', {});
        toClient.write('{"id":1,"res');
        toClient.write('ult":{"data":[]}}\r\nnot json\n\n');
        assert.deepStrictEqual(await p, { data: [] });
        await tick();
        assert.ok(logged.some(l => /not JSON/.test(l)));
        ok('a line split across chunks and ending CRLF parses; a bad line is dropped');
    }
    {
        const { rpc, toClient } = pair();
        let closed = 0;
        rpc.on('close', () => closed++);
        const p = rpc.request('turn/start', {});
        toClient.end();
        await assert.rejects(p, RpcClosedError);
        await assert.rejects(rpc.request('x'), RpcClosedError);
        rpc.close();
        assert.strictEqual(closed, 1);
        ok('closing rejects what is outstanding, and anything asked after');
    }
    {
        const { rpc } = pair();
        // The timer is unref'd so a pending request never holds a bridge open on
        // its way out; so here something else has to hold the loop.
        const hold = setTimeout(() => {}, 1000);
        await assert.rejects(rpc.request('slow', {}, { timeoutMs: 20 }), /timed out/);
        clearTimeout(hold);
        assert.strictEqual(rpc.pending.size, 0);
        ok('a request times out when asked to');
    }
}

function schemaLists() {
    const dir = path.join(__dirname, '..', 'docs', 'codex-schema', protocol.TESTED.schema, 'experimental');
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'codex_app_server_protocol.schemas.json'), 'utf8'));
    const methods = (k) => s.definitions[k].oneOf.map(x => x.properties.method.enum[0]);
    assert.deepStrictEqual([...protocol.KNOWN_NOTIFICATIONS], methods('ServerNotification'),
        'protocol.js KNOWN_NOTIFICATIONS has drifted from the schema');
    assert.deepStrictEqual([...protocol.SERVER_REQUESTS], methods('ServerRequest'),
        'protocol.js SERVER_REQUESTS has drifted from the schema');
    ok(`protocol.js matches docs/codex-schema/${protocol.TESTED.schema}`);

    assert.strictEqual(protocol.inTestedRange('codex-cli 0.172.0'), true);
    assert.strictEqual(protocol.inTestedRange('codex-cli 0.172.9'), true);
    assert.strictEqual(protocol.inTestedRange('codex-cli 0.173.0'), false);
    assert.strictEqual(protocol.inTestedRange('0.160.1'), false);
    assert.strictEqual(protocol.inTestedRange('nonsense'), null);
    const readme = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'codex', 'README'), 'utf8');
    assert.ok(readme.includes(`>=${protocol.TESTED.min} <${protocol.TESTED.below}`),
        'bridge/codex/README states a different range from protocol.js');
    ok('the tested range reads versions, and the README agrees with it');
}

function readFixture(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/**
 * Drive a spawned stub with exactly what the recorder sent. Each `send` waits
 * until every `recv` recorded before it has arrived, which is the causal order
 * the recorder had. Server requests are deferred and answered with the recorded
 * result when the walk reaches that answer.
 */
async function replay(file) {
    const entries = readFixture(file);
    const log = path.join(root, path.basename(file) + '.log');
    const { child, rpc } = spawnAppServer({
        env: { ...process.env, FAKE_CODEX_FIXTURE: file, FAKE_CODEX_LOG: log },
        log: () => {},
    });
    let received = 0;
    const waiters = [];
    rpc.on('message', () => {
        received++;
        for (const w of waiters.splice(0)) w();
    });
    for (const m of protocol.SERVER_REQUESTS) rpc.handle(m, () => DEFER);
    const until = (n) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${path.basename(file)}: stalled at ${received}/${n} received`)), 5000);
        const check = () => { if (received >= n) { clearTimeout(t); resolve(); } else waiters.push(check); };
        check();
    });

    let recvBefore = 0;
    const outcomes = [];
    for (const e of entries) {
        if (e.dir === 'recv') { recvBefore++; continue; }
        await until(recvBefore);
        const m = e.msg;
        if (typeof m.method === 'string' && m.id !== undefined) {
            outcomes.push(rpc.request(m.method, m.params).then(() => 'ok', (x) => x.code));
        } else if (typeof m.method === 'string') {
            rpc.notify(m.method, m.params);
        } else if (m.error) {
            assert.ok(rpc.respondError(m.id, m.error.code, m.error.message), `request ${m.id} was not pending`);
        } else {
            assert.ok(rpc.respond(m.id, m.result), `request ${m.id} was not pending`);
        }
    }
    await until(recvBefore);
    const got = await Promise.all(outcomes);
    child.stdin.end();
    await new Promise(r => child.once('exit', r));
    const lines = fs.existsSync(log) ? readFixture(log) : [];
    const bad = lines.filter(l => l.mismatch || l.unfinished || l.extra || l.unparsable);
    assert.deepStrictEqual(bad, [], `${path.basename(file)}: the stub saw a different conversation`);

    // The recorded answers to our requests, in order, must be what we got back.
    const want = entries.filter(e => e.dir === 'recv' && e.msg.method === undefined
        && entries.some(s => s.dir === 'send' && s.msg.id === e.msg.id && typeof s.msg.method === 'string'))
        .map(e => (e.msg.error ? e.msg.error.code : 'ok'));
    assert.deepStrictEqual(got, want, `${path.basename(file)}: answers differ from the recording`);
    return entries;
}

async function replays() {
    assert.strictEqual(CODEX_BIN, bin);
    const files = fs.readdirSync(FIX).filter(f => f.endsWith('.ndjson')).sort();
    assert.ok(files.length > 0, 'no fixtures');
    for (const f of files) {
        await replay(path.join(FIX, f));
        ok(`replays ${f}`);
    }

    // What signed-in and signed-out look like. Measured on 0.172.0:
    // requiresOpenaiAuth is true either way (it says the provider needs OpenAI
    // auth, not that it is missing), so the sign-in banner keys on account null.
    const so = readFixture(path.join(FIX, 'signed-out.ndjson')).map(e => e.msg);
    const acct = so.find(m => m.result && 'requiresOpenaiAuth' in m.result).result;
    assert.deepStrictEqual([acct.account, acct.requiresOpenaiAuth], [null, true]);
    const done = so.find(m => m.method === 'turn/completed').params.turn;
    assert.strictEqual(done.status, 'failed');
    assert.strictEqual(done.error.codexErrorInfo.httpConnectionFailed.httpStatusCode, 401);
    const si = readFixture(path.join(FIX, 'plain.ndjson')).map(e => e.msg)
        .find(m => m.result && 'requiresOpenaiAuth' in m.result).result;
    assert.strictEqual(si.requiresOpenaiAuth, true);
    assert.strictEqual(si.account.type, 'chatgpt');
    ok('signed out is account null (requiresOpenaiAuth is true both ways), and the turn fails 401');
}

/**
 * Each fixture holds the thing it was recorded for. This is the plan's Phase 0
 * exit check written down: a re-recording that drifted (the model chose a
 * different tool, the turn ended early) fails here rather than going unnoticed.
 */
function coverage() {
    const msgs = (n) => readFixture(path.join(FIX, n + '.ndjson')).map(e => e.msg);
    const rollout = (n) => readFixture(path.join(FIX, n + '.rollout.jsonl'));
    const items = (n, type) => msgs(n).filter(m => m.method === 'item/completed'
        && m.params.item.type === type).map(m => m.params.item);
    const req = (n, method) => msgs(n).filter(m => m.method === method && m.id !== undefined);
    const lastTurn = (n) => msgs(n).filter(m => m.method === 'turn/completed').pop().params.turn;

    assert.ok(items('plain', 'agentMessage').some(i => i.text.toLowerCase().includes('pong')));
    assert.strictEqual(lastTurn('plain').status, 'completed');

    const [cmd] = req('command-approval', 'item/commandExecution/requestApproval');
    assert.ok(cmd.params.command && cmd.params.cwd && Array.isArray(cmd.params.availableDecisions));
    assert.ok(items('command-approval', 'commandExecution').some(i => i.exitCode === 0));

    const [fc] = req('file-change-approval', 'item/fileChange/requestApproval');
    assert.strictEqual(fc.params.availableDecisions, undefined, 'a file-change request carries no list');
    const change = items('file-change-approval', 'fileChange')[0];
    assert.ok(change.status === 'completed' && /\+second line/.test(change.changes[0].diff));

    assert.strictEqual(lastTurn('interrupt').status, 'interrupted');
    assert.ok(rollout('interrupt').some(l => l.payload.type === 'turn_aborted'
        && l.payload.reason === 'interrupted'));

    const fork = msgs('fork').find(m => m.result && m.result.thread && m.result.thread.forkedFromId);
    assert.ok(fork, 'no thread/fork response with forkedFromId');
    const child = rollout('fork.1')[0].payload;
    assert.strictEqual(child.forked_from_id, fork.result.thread.forkedFromId);
    assert.ok(child.history_base && child.history_base.end_byte_offset > 0,
        'a fork rollout points into its parent rather than copying it');

    const [rui] = req('request-user-input', 'item/tool/requestUserInput');
    assert.strictEqual(rui.params.isBlocking, true);
    assert.ok(rui.params.questions[0].id && rui.params.questions[0].options.length);
    assert.ok(items('request-user-input-default', 'agentMessage').some(i => i.delivery === 'async'
        && i.questions.length), 'default mode: the async question tool');
    const [feat] = req('request-user-input-feature', 'item/tool/requestUserInput');
    assert.strictEqual(feat.params.isBlocking, false);

    assert.ok(items('plan', 'plan').some(i => /README/.test(i.text)));

    const steer = msgs('steer');
    assert.ok(steer.some(m => m.result && m.result.turnId), 'turn/steer answered with its turnId');
    assert.ok(steer.some(m => m.error && /no active turn to steer/.test(m.error.message)));
    assert.ok(items('steer', 'agentMessage').some(i => /heron/i.test(i.text)), 'the steer was folded in');
    ok('each fixture shows what it was recorded for');
}

async function stubNoticesDivergence() {
    const log = path.join(root, 'diverge.log');
    const { child, rpc } = spawnAppServer({
        env: { ...process.env, FAKE_CODEX_FIXTURE: path.join(FIX, 'signed-out.ndjson'), FAKE_CODEX_LOG: log },
        log: () => {},
    });
    // The fixture starts with initialize; open with something else.
    rpc.request('thread/list', {}).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    child.stdin.end();
    await new Promise(r => child.once('exit', r));
    const lines = readFixture(log);
    assert.ok(lines.some(l => l.mismatch && l.mismatch.want === 'request:initialize' && l.mismatch.got === 'request:thread/list'));
    assert.ok(lines.some(l => l.unfinished));
    ok('the stub logs a conversation that is not the recorded one');
}

async function handshakeThroughClient() {
    const { child, rpc } = spawnAppServer({
        env: { ...process.env, FAKE_CODEX_FIXTURE: path.join(FIX, 'signed-out.ndjson') },
        log: () => {},
    });
    // initialize() is the first two sends of every fixture, so the client's own
    // handshake must be what the recorder sent.
    const r = await initialize(rpc, { version: '0.0.0-fixture' });
    assert.strictEqual(r.platformOs, 'linux');
    const a = await rpc.request('account/read', { refreshToken: false });
    assert.strictEqual(a.requiresOpenaiAuth, true);
    child.kill();
    ok('initialize() speaks the recorded handshake');
}

function rollouts() {
    const files = fs.readdirSync(FIX).filter(f => f.endsWith('.rollout.jsonl'));
    assert.ok(files.length > 0, 'no rollout files');
    for (const f of files) {
        const lines = readFixture(path.join(FIX, f));
        for (const l of lines) {
            assert.ok(l.timestamp && typeof l.type === 'string' && l.payload, `${f}: a line without the envelope`);
        }
        assert.strictEqual(lines[0].type, 'session_meta', `${f}: does not open with session_meta`);
        assert.strictEqual(lines[0].payload.originator, 'tgxcode', `${f}: originator`);
    }
    ok(`${files.length} rollout file(s) open with session_meta, originator tgxcode`);
}

(async () => {
    await unit();
    schemaLists();
    await stubNoticesDivergence();
    await handshakeThroughClient();
    await replays();
    coverage();
    rollouts();
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
