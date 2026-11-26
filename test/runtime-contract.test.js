'use strict';

// The runner's process contract, widened for a runtime that is not Claude —
// bridge/runner.js against the contract in bridge/runtimes/claude/process.js.
//
// No bridge needed, and no Codex. A fake runtime is registered beside `claude`
// for the life of this process: its adapter is written here, and its process is
// a stub script that speaks a toy JSON-RPC shaped like `codex app-server`'s —
// refusing everything before `initialize`, minting the thread id at
// `thread/start`, answering turns as requests, refusing a steer that lost the
// race with the end of its turn, and asking with a list of decisions and with
// questions answered by id. Each of the seven places bridge/codex/README §Fit
// said the contract did not reach is one case below.
//
// The assertions come in the runner test's threes wherever a turn is involved,
// for the runner test's reason: nothing left in flight is the invariant, the next
// message actually reaching the stub is the symptom, and the stub's log is what
// shows nothing was delivered twice — or, for a stopped turn, delivered again.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-contract-'));
const stub = path.join(root, 'fake-runtime.js');
const logFile = path.join(root, 'wire.ndjson');

// Not 45888, and never reached: nothing here starts a bridge.
process.env.TGXCODE_PORT = '45941';

const STUB = `#!${process.execPath}
'use strict';
const readline = require('readline');
const fs = require('fs');
const { randomUUID } = require('crypto');
const LOG = process.env.STUB_LOG;
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...o }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const note = (method, params) => out({ method, params });
const reply = (id, result) => out({ id, result });
const fail = (id, message, code = -32600) => out({ id, error: { code, message } });
const textOf = (p) => (p.input || []).map(i => i.text).join('\\n');

let initialized = false, thread = null, turn = null, n = 0, srv = 0;
const asked = new Map();

function endTurn(status, text) {
    if (!turn) return;
    const t = turn; turn = null;
    note('turn/completed', { threadId: thread, turn: { id: t.id, status }, text: text == null ? t.text : text });
}

function run(t) {
    const text = t.text;
    if (/\\bHANG\\b/.test(text)) return;
    const tool = /\\b(?:TOOLS|RACE)(\\d+)\\b/.exec(text);
    if (tool) {
        const item = 'it-' + t.id;
        note('item/started', { item: { type: 'commandExecution', id: item, command: 'sleep' } });
        return setTimeout(() => {
            if (turn !== t) return;
            const folded = t.steers.splice(0);
            for (const f of folded) log({ m: 'folded', text: f });
            note('item/completed', { item: { type: 'commandExecution', id: item, status: 'completed' } });
            setTimeout(() => endTurn('completed', folded.length ? 'folded:' + folded.join('|') : text), 30);
        }, Number(tool[1]));
    }
    if (/\\bAPPROVE\\b/.test(text)) {
        const id = srv++;
        asked.set(id, 'approval');
        note('item/started', { item: { type: 'commandExecution', id: 'it-' + t.id, command: 'rm -rf build' } });
        return out({ id, method: 'item/commandExecution/requestApproval', params: {
            threadId: thread, turnId: t.id, itemId: 'it-' + t.id, command: 'rm -rf build', cwd: process.cwd(),
            availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm', '-rf'] } },
                'cancel'] } });
    }
    if (/\\bQUESTION\\b/.test(text)) {
        const id = srv++;
        asked.set(id, 'question');
        return out({ id, method: 'item/tool/requestUserInput', params: { threadId: thread, turnId: t.id,
            questions: [{ id: 'q_color', header: 'Colour', question: 'Which colour?',
                options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }],
                isOther: false, isSecret: false }] } });
    }
    setTimeout(() => endTurn('completed'), 20);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    // The answer to one of our requests: an approval or a question.
    if (m.method === undefined && m.id !== undefined) {
        const kind = asked.get(m.id);
        if (!kind) return;
        asked.delete(m.id);
        log({ m: 'answer', kind, id: m.id, result: m.result });
        note('serverRequest/resolved', { threadId: thread, requestId: m.id });
        if (kind === 'approval' && m.result && m.result.decision === 'cancel') return endTurn('interrupted');
        return setTimeout(() => endTurn('completed', 'answered'), 30);
    }
    const { id, method, params = {} } = m;
    if (!initialized && method !== 'initialize') {
        log({ m: method, refused: 'Not initialized' });
        return fail(id, 'Not initialized');
    }
    switch (method) {
        case 'initialize':
            log({ m: method });
            if (process.env.STUB_FAIL_INIT) return setTimeout(() => fail(id, 'this build will not talk to you'), 50);
            // Slow enough that a turn written before the answer would be refused.
            return setTimeout(() => { initialized = true; reply(id, { userAgent: 'stub/9.9.9' }); }, 150);
        case 'thread/start':
            thread = 'thr-' + randomUUID();
            log({ m: method, thread });
            return reply(id, { thread: { id: thread } });
        case 'thread/resume':
            thread = params.threadId;
            log({ m: method, thread });
            return reply(id, { thread: { id: thread } });
        case 'turn/start': {
            const text = textOf(params);
            if (!thread || params.threadId !== thread) { log({ m: method, text, refused: 'no thread' }); return fail(id, 'no thread'); }
            if (turn) { log({ m: method, text, refused: 'busy' }); return fail(id, 'a turn is running'); }
            log({ m: method, text });
            turn = { id: 'turn-' + (++n), text, steers: [], race: /\\bRACE\\d+\\b/.test(text) };
            reply(id, { turn: { id: turn.id } });
            note('turn/started', { threadId: thread, turn: { id: turn.id } });
            return run(turn);
        }
        case 'turn/steer': {
            const text = textOf(params);
            // The race, made certain: the turn ends just before the steer is read.
            if (turn && turn.race) endTurn('completed');
            if (!turn) { log({ m: method, text, refused: 'no active turn' }); return fail(id, 'no active turn to steer'); }
            log({ m: method, text });
            turn.steers.push(text);
            return reply(id, { turnId: turn.id });
        }
        case 'turn/interrupt':
            log({ m: method });
            reply(id, {});
            return endTurn('interrupted');
        default:
            return fail(id, 'unknown method ' + method, -32601);
    }
}).on('close', () => process.exit(0));
`;
fs.writeFileSync(stub, STUB, { mode: 0o755 });

const runtimes = require('../bridge/runtimes');
const { Runner, RunnerPool } = require('../bridge/runner.js');
const claude = runtimes.get('claude').adapter;

// --- the fake runtime's adapter -------------------------------------------------------------------
// Everything a Codex adapter has to do that the Claude one never did, and nothing
// else. Written against the contract only: if a case below needs this to reach
// into the runner, the contract is still too narrow.

const DECISION = {
    accept: { label: 'Allow', behavior: 'allow', scope: 'once' },
    acceptForSession: { label: 'Allow for this session', behavior: 'allow', scope: 'session' },
    acceptWithExecpolicyAmendment: { label: 'Always allow this command, from now on', behavior: 'allow', scope: 'always' },
    decline: { label: 'Deny', behavior: 'deny', scope: 'once' },
    cancel: { label: 'Deny and stop the turn', behavior: 'deny', scope: 'once', endsTurn: true },
};

class StubAdapter {
    constructor({ rpc }) {
        this.rpc = rpc;
        this.seq = 0;
        this.own = new Map();       // our ids -> {kind, uuid}
        this.verbs = new Map();     // the runner's ids -> verb
        this.rawIds = new Map();    // ask id (string) -> the integer the stub used
        this.answered = new Set();
        this.threadId = null;
        this.turnId = null;
        this.version = null;
        this.cwd = null;
    }

    get name() { return 'stub'; }
    get label() { return 'Stub'; }
    get product() { return 'Stub Runtime'; }
    get bin() { return stub; }
    get handshakeGates() { return true; }

    argv() { return []; }
    env() {
        return { ...process.env, STUB_LOG: logFile, ...(StubAdapter.failInit ? { STUB_FAIL_INIT: '1' } : {}) };
    }
    initialCaps() { return { permissionPrompt: true, interrupt: true }; }

    async handshake(o) {
        this.cwd = o.cwd;
        try {
            const r = await this.rpc('initialize', { clientInfo: { name: 'tgxcode' } });
            this.version = String(r.userAgent || '').split('/')[1] || null;
        } catch (err) {
            throw Object.assign(new Error(`Stub refused to start: ${err.message}`), { kind: 'stub-refused' });
        }
        // The answer to this one is read in `read`, where it becomes `init`.
        if (o.isNew) await this.rpc('thread/start', { cwd: o.cwd });
        else await this.rpc('thread/resume', { threadId: o.sessionId });
    }

    read(msg) {
        // A reply.
        if (msg.method === undefined && msg.id !== undefined) {
            const response = { type: 'response', id: msg.id, ok: !msg.error,
                result: msg.result || {}, error: msg.error ? msg.error.message : null };
            const mine = this.own.get(msg.id);
            if (mine) {
                this.own.delete(msg.id);
                // Returned anyway, to show the runner drops a reply it is not
                // waiting on; the contract says an adapter need not.
                if (mine.kind === 'start') {
                    if (msg.result && msg.result.turn) this.turnId = msg.result.turn.id;
                    return [response, { type: 'lifecycle', uuid: mine.uuid, state: 'started' }];
                }
                if (msg.error && /no active turn/.test(msg.error.message)) {
                    return [response, { type: 'lifecycle', uuid: mine.uuid, state: 'returned' }];
                }
                return [response, { type: 'lifecycle', uuid: mine.uuid, state: msg.error ? 'cancelled' : 'started' }];
            }
            const verb = this.verbs.get(msg.id);
            this.verbs.delete(msg.id);
            if ((verb === 'thread/start' || verb === 'thread/resume') && msg.result && msg.result.thread) {
                this.threadId = msg.result.thread.id;
                return [response, { type: 'init', version: this.version, sessionId: this.threadId,
                    minted: verb === 'thread/start', cwd: this.cwd, raw: null }];
            }
            return [response];
        }
        // A request of the stub's.
        if (msg.method && msg.id !== undefined) {
            const id = String(msg.id);
            this.rawIds.set(id, msg.id);
            const p = msg.params || {};
            if (msg.method === 'item/commandExecution/requestApproval') {
                const decisions = (p.availableDecisions || []).map((d) => {
                    const key = typeof d === 'string' ? d : Object.keys(d)[0];
                    return { id: key, ...(DECISION[key] || { label: key, behavior: 'deny', scope: 'once' }), raw: d };
                });
                return [{ type: 'ask', uninteractive: false, ask: { id, kind: 'tool', tool: 'commandExecution',
                    displayName: 'Command', input: { command: p.command, cwd: p.cwd }, secrets: null,
                    toolUseId: p.itemId || null, description: null, reason: null, blockedPath: null,
                    agentId: null, askedAt: Date.now(), decisions } }];
            }
            if (msg.method === 'item/tool/requestUserInput') {
                return [{ type: 'ask', uninteractive: false, ask: { id, kind: 'question', tool: 'requestUserInput',
                    displayName: 'Question', input: { questions: (p.questions || []).map(q => ({
                        id: q.id, header: q.header, question: q.question, options: q.options, multiSelect: false })) },
                    secrets: null, toolUseId: null, description: null, reason: null, blockedPath: null,
                    agentId: null, askedAt: Date.now() } }];
            }
            return [{ type: 'request', id: msg.id, method: msg.method }];
        }
        // A notification.
        const p = msg.params || {};
        switch (msg.method) {
            case 'item/started':
                return p.item && p.item.type === 'commandExecution'
                    ? [{ type: 'tool-start', id: p.item.id, name: 'commandExecution', label: `Running ${p.item.command}` }] : [];
            case 'item/completed':
                return [{ type: 'tools-done', ids: p.item ? [p.item.id] : [] }];
            case 'turn/completed':
                this.turnId = null;
                return [{ type: 'turn-end', result: { isError: p.turn && p.turn.status === 'failed',
                    text: p.text || '', costUsd: 0, durationMs: 0, numTurns: 1,
                    stopReason: p.turn ? p.turn.status : null } }];
            case 'serverRequest/resolved':
                // Sent after every answer too; only an unanswered ask is withdrawn.
                return this.answered.has(String(p.requestId)) ? [] : [{ type: 'ask-withdrawn', id: String(p.requestId) }];
            default:
                return [];
        }
    }

    turn(entry, { handOver }) {
        const id = `stub_${++this.seq}`;
        this.own.set(id, { kind: handOver ? 'steer' : 'start', uuid: entry.uuid });
        const input = [{ type: 'text', text: entry.text }];
        return handOver
            ? { id, method: 'turn/steer', params: { threadId: this.threadId, expectedTurnId: this.turnId, input } }
            : { id, method: 'turn/start', params: { threadId: this.threadId, input } };
    }

    request(id, verb, payload = {}) {
        this.verbs.set(id, verb);
        return { id, method: verb, params: payload };
    }

    answer(ask, { behavior, choice, answers }) {
        this.answered.add(ask.id);
        const id = this.rawIds.has(ask.id) ? this.rawIds.get(ask.id) : ask.id;
        if (ask.kind === 'question') {
            return { id, result: { answers: Object.fromEntries((behavior === 'allow' && answers || [])
                .map(a => [a.id, { answers: a.answers }])) } };
        }
        return { id, result: { decision: choice ? choice.raw : behavior === 'allow' ? 'accept' : 'decline' } };
    }

    refuse(ev) { return { id: ev.id, error: { code: -32601, message: `not handled: ${ev.method}` } }; }

    interrupt() { return this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); }
    async withdraw() { return false; }
    setPermissionMode() { return Promise.resolve({}); }
    classifyExit(stderr, code) { return { kind: 'unknown', message: stderr || `stub exited with ${code}` }; }
    argvRefusal() { return null; }
    usageLimit() { return null; }
}

runtimes.RUNTIMES.stub = {
    name: 'stub',
    capabilities: runtimes.CLAUDE_CAPABILITIES,
    tools: { asks: {}, edits: new Set(), alwaysAllow: new Set(), describe: () => null },
    adapter: { Adapter: StubAdapter },
};

// --- plumbing -------------------------------------------------------------------------------------

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const reset = () => fs.rmSync(logFile, { force: true });

/** Every line the stub logged, in order. */
function wire() {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}
/** The turns the stub started, by text — what was actually delivered as a turn. */
const started = () => wire().filter(l => l.m === 'turn/start' && !l.refused).map(l => l.text);

async function until(fn, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(20);
    }
    assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

function once(emitter, event, ms = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no "${event}" event within ${ms}ms`)), ms);
        emitter.once(event, (v) => { clearTimeout(timer); resolve(v); });
    });
}

const made = [];
const pools = [];
function runner({ viewer = true } = {}) {
    const r = new Runner({ sessionId: randomUUID(), cwd: root, isNew: true, runtime: 'stub' });
    r.hasViewer = () => viewer;
    made.push(r);
    return r;
}

/** The three assertions, after a case's own: nothing in flight, the next one lands, once. */
async function nextIsDelivered(r, expected, what) {
    assert.strictEqual(r.inFlight.length, 0, `${what}: nothing may be left in flight`);
    const text = `next after ${what}`;
    r.send(text);
    await until(() => r.lastResultText === text, 5000, `the message after ${what} to be answered`);
    assert.deepStrictEqual(started(), [...expected, text], `${what}: each turn delivered once, in order`);
    assert.strictEqual(r.inFlight.length, 0);
    assert.strictEqual(r._pending.size, 0, 'no request of the runner\'s left waiting');
}

// --- the Claude adapter's answers are what they were ----------------------------------------------
// The one place the runner hands an adapter something different now: a question's
// answers as a list rather than a ready-made updatedInput. Pinned to the exact line
// the runner wrote before, so Claude's wire is shown not to have moved.
{
    const r = new Runner({ sessionId: 's-claude', cwd: root });
    const lines = [];
    r._write = (o) => { lines.push(o); return true; };
    const input = { questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A' }], multiSelect: false },
        { question: 'And?', header: 'H2', options: [], multiSelect: false }] };
    r.pendingPermission = { id: 'cq1', kind: 'question', tool: 'AskUserQuestion', input, askedAt: 1 };
    assert.deepStrictEqual(r.answerPermission('cq1', 'allow', { answers: { 'And?': 'typed', 'Which?': 'A', nope: 'x' } }),
        { ok: true });
    assert.deepStrictEqual(lines, [{ type: 'control_response', response: { subtype: 'success', request_id: 'cq1',
        response: { behavior: 'allow', toolName: 'AskUserQuestion',
            updatedInput: { ...input, answers: { 'And?': 'typed', 'Which?': 'A' } } } } }]);

    lines.length = 0;
    r.pendingPermission = { id: 'ct1', kind: 'tool', tool: 'Bash', input: { command: 'ls' }, askedAt: 1 };
    assert.deepStrictEqual(r.answerPermission('ct1', 'allow-always'), { ok: true });
    assert.deepStrictEqual(lines[0].response.response, { behavior: 'allow', toolName: 'Bash',
        updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] });
    assert.strictEqual(r.answerPermission('x', 'allow', { choice: 'accept' }).error, 'nothing is waiting for approval');

    r.pendingPermission = { id: 'ct2', kind: 'tool', tool: 'Bash', input: {}, askedAt: 1 };
    const bad = r.answerPermission('ct2', null, { choice: 'accept' });
    assert.strictEqual(bad.invalid, true, 'a Claude ask has no decisions to choose from');
    assert.ok(r.pendingPermission, 'and an invalid answer leaves the card up');
    assert.strictEqual(claude.ClaudeAdapter.prototype.handshakeGates, false);
    ok('a Claude ask is answered on the wire exactly as before, and refuses a choice');
}

(async () => {
    // --- 1, 2, 3, 4: the handshake gates the queue, mints the id, synthesises init,
    // and turns are requests whose replies the runner does not claim -----------------
    {
        reset();
        const pool = new RunnerPool();
        pool.hasViewer = () => true;
        pools.push(pool);
        const placeholder = randomUUID();
        const events = { minted: [], forked: [], init: [] };
        for (const k of Object.keys(events)) pool.on(k, (e) => events[k].push(e));

        const r = pool.ensure(placeholder, { cwd: root, isNew: true, runtime: 'stub' });
        r.send('one');
        assert.strictEqual(r.state, 'starting', 'nothing goes out before the handshake has finished');
        assert.strictEqual(r.status().queued, 1, 'so the first message is still ours, on the queue');
        assert.strictEqual(r.inFlight.length, 0);

        await until(() => r.lastResultText === 'one', 5000, 'the first turn to be answered');
        assert.deepStrictEqual(wire().filter(l => l.refused), [],
            'no request reached the stub before it was introduced, and no turn before the thread existed');
        assert.deepStrictEqual(wire().map(l => l.m), ['initialize', 'thread/start', 'turn/start']);
        ok('a gated handshake holds the queue until it settles, and the first turn then goes');

        const minted = wire()[1].thread;
        assert.strictEqual(r.sessionId, minted, 'the runner follows the id the runtime minted');
        assert.deepStrictEqual(events.minted, [{ from: placeholder, to: minted }]);
        assert.deepStrictEqual(events.forked, [], 'and a minted id is not a fork');
        assert.strictEqual(pool.get(minted), r, 'the pool re-keys to it');
        assert.strictEqual(pool.get(placeholder), null);
        ok('an id minted by the runtime re-keys the runner, and is not announced as a fork');

        assert.strictEqual(r.status().claudeVersion, '9.9.9', 'the version came from an init built from replies');
        assert.strictEqual(events.init.length, 1);
        assert.strictEqual(events.init[0].init, null, 'with no Claude-shaped raw for the slash palette');
        assert.strictEqual(events.init[0].cwd, root);
        ok('init is synthesised from the handshake\'s replies, with no raw');

        assert.strictEqual(r._pending.size, 0, 'the turn\'s reply was not one of the runner\'s requests');
        await nextIsDelivered(r, ['one'], 'turns that are requests');
        ok('turns are requests whose replies the runner ignores, and each is delivered once');
    }

    // --- 1: a gated handshake that fails is fatal, and gives the queue back ------------------------
    {
        reset();
        StubAdapter.failInit = true;
        const r = runner();
        r.send('never sent');
        StubAdapter.failInit = false;
        const f = await once(r, 'failed');
        await until(() => r.state === 'error', 3000, 'the runner to land in error');
        assert.strictEqual(f.kind, 'stub-refused', 'the adapter\'s kind, not a guess from stderr');
        assert.match(f.message, /will not talk to you/);
        assert.deepStrictEqual(f.unsent, ['never sent'], 'the queued message is handed back');
        assert.strictEqual(r.errorKind, 'stub-refused');
        assert.strictEqual(r.queue.length, 0, 'handed back and still queued would send it twice');
        assert.strictEqual(r.proc, null, 'the process was ended');
        assert.deepStrictEqual(started(), [], 'and no turn was ever written');
        ok('a gated handshake that fails ends the process and hands the queue back');

        await nextIsDelivered(r, [], 'a failed handshake');
        assert.ok(wire().some(l => l.m === 'thread/resume'), 'a second start resumes rather than minting again');
        ok('the next message after a failed handshake starts afresh and is delivered once');
    }

    // --- 4: a message handed over mid-tool is a steer, and folds into the turn ----------------------
    {
        reset();
        const r = runner();
        let results = 0;
        r.on('turn-complete', () => results++);
        r.send('TOOLS400 work');
        await until(() => r._pendingTools.size, 5000, 'the tool call to start');
        r.send('also this');
        assert.strictEqual(r.status().queue[0].handed, true, 'handed to the running turn');
        await until(() => r.lastResultText === 'folded:also this', 5000, 'the fold');
        assert.strictEqual(results, 1, 'read inside the running turn, not as a turn of its own');
        assert.deepStrictEqual(wire().filter(l => l.m === 'turn/steer').map(l => l.text), ['also this']);
        await until(() => r.state === 'idle', 2000, 'idle after the fold');
        await nextIsDelivered(r, ['TOOLS400 work'], 'a steer');
        ok('a handed-over message is written as a steer and read by the running turn');
    }

    // --- 5: a refused steer is sent again as a turn of its own -------------------------------------
    {
        reset();
        const r = runner();
        let results = 0;
        r.on('turn-complete', () => results++);
        r.send('RACE2000 work');
        await until(() => r._pendingTools.size, 5000, 'the tool call to start');
        r.send('late');
        assert.strictEqual(r.status().queue[0].handed, true);
        await until(() => r.lastResultText === 'late', 5000, 'the refused steer to be answered as its own turn');
        assert.deepStrictEqual(wire().filter(l => l.m === 'turn/steer').map(l => l.refused),
            ['no active turn'], 'the steer lost the race');
        assert.deepStrictEqual(started(), ['RACE2000 work', 'late'], 'and went again as a turn/start, once');
        assert.strictEqual(results, 2);
        assert.strictEqual(r.queue.length, 0);
        await nextIsDelivered(r, ['RACE2000 work', 'late'], 'a refused steer');
        ok('a steer refused for having no turn is queued again and delivered once, as a turn');
    }

    // --- 6: an ask carries the runtime's decisions, and is answered with one -----------------------
    {
        reset();
        const r = runner();
        const resolved = [];
        r.on('permission-resolved', (p) => resolved.push(p));
        r.send('APPROVE a');
        await until(() => r.pendingPermission, 5000, 'the approval');
        const card = r.status().pendingPermission;
        assert.deepStrictEqual(card.decisions, [
            { id: 'accept', label: 'Allow', behavior: 'allow', scope: 'once', endsTurn: false },
            { id: 'acceptWithExecpolicyAmendment', label: 'Always allow this command, from now on',
                behavior: 'allow', scope: 'always', endsTurn: false },
            { id: 'cancel', label: 'Deny and stop the turn', behavior: 'deny', scope: 'once', endsTurn: true },
        ], 'the list as a card draws it, with the runtime\'s raw spelling kept in the bridge');

        const id = card.requestId;
        assert.strictEqual(r.answerPermission(id, 'allow-always').invalid, true,
            'there is no for-the-session entry, so the old button cannot be answered with a stronger one');
        assert.strictEqual(r.answerPermission(id, null, { choice: 'acceptForSession' }).invalid, true,
            'nor with one the ask did not offer');
        assert.ok(r.pendingPermission, 'the card is still up after both');

        assert.deepStrictEqual(r.answerPermission(id, null, { choice: 'acceptWithExecpolicyAmendment' }), { ok: true });
        await until(() => r.state === 'idle', 5000, 'the turn to end');
        const answer = wire().find(l => l.m === 'answer');
        assert.deepStrictEqual(answer.result,
            { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm', '-rf'] } } },
            'the runtime got its own decision back, exactly');
        assert.strictEqual(answer.id, 0, 'answered under the id the runtime used');
        assert.deepStrictEqual(resolved.map(p => [p.outcome, p.choice]), [['allow-always', 'acceptWithExecpolicyAmendment']]);
        assert.ok(!r._sessionAllow.has('commandExecution'), 'a rule the runtime keeps is not a session allow of ours');
        ok('an ask carries its runtime\'s decisions, and a choice from them is answered verbatim');

        // The old body still works: a deny is the nearest refusal on the list.
        r.send('APPROVE b');
        await until(() => r.pendingPermission, 5000, 'the second approval');
        assert.deepStrictEqual(r.answerPermission(r.pendingPermission.id, 'deny'), { ok: true });
        await until(() => r.state === 'idle', 5000, 'the cancelled turn to end');
        assert.deepStrictEqual(wire().filter(l => l.m === 'answer').map(l => l.result.decision).slice(1), ['cancel']);
        assert.strictEqual(r.lastResult.stopReason, 'interrupted', 'cancel ended the turn, as the entry said');
        await nextIsDelivered(r, ['APPROVE a', 'APPROVE b'], 'decisions');
        ok('the old decision words map onto the list, and a deny with no decline is the cancel');
    }

    // --- 6: the bridge's own answers pick from the list too ---------------------------------------
    {
        reset();
        const r = runner({ viewer: false });
        r.send('APPROVE nobody');
        await until(() => wire().some(l => l.m === 'answer'), 5000, 'the auto-deny');
        assert.strictEqual(wire().find(l => l.m === 'answer').result.decision, 'cancel',
            'auto-denied with nobody to ask, in the runtime\'s own words');
        await until(() => r.state === 'idle', 5000, 'the turn to end');
        await nextIsDelivered(r, ['APPROVE nobody'], 'an auto-deny');
        ok('an ask answered by the bridge itself is answered with an entry from its list');
    }

    // --- 7: a question is answered in its runtime's shape, by id or by text ----------------------
    {
        reset();
        const r = runner();
        r.send('QUESTION one');
        await until(() => r.pendingPermission, 5000, 'the question');
        const card = r.status().pendingPermission;
        assert.strictEqual(card.kind, 'question');
        assert.strictEqual(card.input.questions[0].id, 'q_color');
        assert.strictEqual(r.answerPermission(card.requestId, 'allow', { answers: { nope: 'x' } }).error,
            'no answers were given', 'a key naming no question is dropped');
        assert.deepStrictEqual(r.answerPermission(card.requestId, 'allow',
            { answers: { q_color: ['Red', 'Blue', ' '] } }), { ok: true });
        await until(() => r.state === 'idle', 5000, 'the turn to end');

        r.send('QUESTION two');
        await until(() => r.pendingPermission, 5000, 'the second question');
        assert.deepStrictEqual(r.answerPermission(r.pendingPermission.id, 'allow',
            { answers: { 'Which colour?': 'Blue' } }), { ok: true });
        await until(() => r.state === 'idle', 5000, 'the turn to end');
        assert.deepStrictEqual(wire().filter(l => l.m === 'answer').map(l => l.result), [
            { answers: { q_color: { answers: ['Red', 'Blue'] } } },
            { answers: { q_color: { answers: ['Blue'] } } },
        ], 'by id with several values, and by text with one');
        await nextIsDelivered(r, ['QUESTION one', 'QUESTION two'], 'questions');
        ok('a question is answered in its runtime\'s own shape, keyed by id or by text');
    }

    // --- and Stop, against a runtime that interrupts by request -----------------------------------
    {
        reset();
        const r = runner();
        r.send('HANG one');
        await until(() => started().length === 1 && r.state === 'busy', 5000, 'the turn to start');
        const out = await r.stop();
        assert.strictEqual(out.how, 'soft');
        await until(() => r.state === 'idle', 5000, 'the interrupted turn to end');
        assert.strictEqual(r.lastResult.stopReason, 'interrupted');
        await nextIsDelivered(r, ['HANG one'], 'a stop');
        ok('a stopped turn leaves nothing in flight and is not delivered again');
    }
})().then(() => finish(0)).catch((err) => {
    console.error(err && err.stack || err);
    finish(1);
});

async function finish(code) {
    for (const r of made) {
        try { await r.stop({ hard: true }); } catch { /* already gone */ }
    }
    for (const pool of pools) pool.shutdown({ force: true });
    delete runtimes.RUNTIMES.stub;
    await sleep(200);
    fs.rmSync(root, { recursive: true, force: true });
    if (!code) console.log(`\n${pass} runtime-contract checks passed`);
    process.exit(code);
}
