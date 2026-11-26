'use strict';

// The Codex process adapter (bridge/runtimes/codex/process.js) driven by a real
// Runner against recorded app-server conversations — the runner test's three
// invariants, against Codex rather than a stub `claude`:
//
//   1. nothing is left in flight once a turn is over, however it ended;
//   2. the next message is actually delivered — a turn/start reaches the
//      "server" and is answered;
//   3. nothing is delivered twice, and a stopped turn is not delivered again.
//
// No bridge, no network and no Codex: TGXCODE_CODEX_BIN points at a replay
// walker written below, set before anything requires bridge/codex/client.js
// (it reads the variable at load, as config.js does CLAUDE_BIN). The walker plays
// test/fixtures/codex/<scenario>.ndjson the way fixtures/codex/stub.js does — at
// each `send` it waits for the client's next message and checks it is the same
// kind of thing — and then, so that (2) can be asserted after any scenario, it
// answers every further `turn/start` with the turn from plain.ndjson. Ids are
// remapped for our requests and written verbatim for Codex's own, so an answer
// to the wrong server request is a mismatch in the log, not a pass.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const FIX = path.join(__dirname, 'fixtures', 'codex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-'));
const walker = path.join(root, 'codex-walker.js');
const logFile = path.join(root, 'wire.ndjson');

// Not 45888, and never reached: nothing here starts a bridge.
process.env.TGXCODE_PORT = '45943';

const WALKER = `#!${process.execPath}\nrequire(${JSON.stringify(path.join(FIX, 'walker.js'))});\n`;
fs.writeFileSync(walker, WALKER, { mode: 0o755 });
process.env.TGXCODE_CODEX_BIN = walker;
process.env.FAKE_CODEX_LOG = logFile;

const { Runner } = require('../bridge/runner.js');
const codex = require('../bridge/runtimes/codex/process.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function wire() {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}
const sent = (method) => wire().filter(l => l.got && l.got.method === method).map(l => l.got);
const turnTexts = () => sent('turn/start').map(m => m.params.input.map(i => i.text).join('\n'));
const mismatches = () => wire().filter(l => l.mismatch);

async function until(fn, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(20);
    }
    assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

const made = [];
function runner(fixture, { mode = 'acceptEdits', viewer = true } = {}) {
    fs.rmSync(logFile, { force: true });
    process.env.FAKE_CODEX_FIXTURE = path.join(FIX, `${fixture}.ndjson`);
    const r = new Runner({ sessionId: randomUUID(), cwd: root, isNew: true, runtime: 'codex', permissionMode: mode });
    r.hasViewer = () => viewer;
    made.push(r);
    return r;
}

/** The three assertions, after a case's own. */
async function nextIsDelivered(r, expected, what) {
    assert.strictEqual(r.inFlight.length, 0, `${what}: nothing may be left in flight`);
    const text = `next after ${what}`;
    r.send(text);
    await until(() => r.state === 'idle' && turnTexts().length === expected.length + 1
        && r.lastResultText === 'pong', 5000, `the message after ${what} to be answered`);
    assert.deepStrictEqual(turnTexts(), [...expected, text], `${what}: each turn delivered once, in order`);
    assert.strictEqual(r.inFlight.length, 0);
    assert.strictEqual(r.queue.length, 0);
    assert.deepStrictEqual(mismatches(), [], `${what}: the conversation was the recorded one`);
}

// --- read() on its own: the shapes that decide a card --------------------------------------------
{
    const a = new codex.Adapter({ rpc: async () => ({}) });
    assert.strictEqual(codex.unwrapCommand("/bin/bash -lc 'touch made-by-codex.txt'"), 'touch made-by-codex.txt');
    assert.strictEqual(codex.unwrapCommand("/bin/bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
    assert.strictEqual(codex.unwrapCommand('ls -la'), 'ls -la');
    const [ev] = a.read({ id: 0, method: 'item/commandExecution/requestApproval', params: {
        itemId: 'x', command: "/bin/bash -lc 'touch a'", cwd: '/tmp',
        availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'a'] } }, 'cancel'] } });
    assert.strictEqual(ev.type, 'ask');
    assert.strictEqual(ev.ask.id, '0');
    assert.strictEqual(ev.ask.rpcId, 0, 'the integer Codex used is kept, to answer with');
    assert.deepStrictEqual(ev.ask.decisions.map(d => [d.id, d.behavior, d.scope, d.endsTurn]), [
        ['accept', 'allow', 'once', false],
        ['acceptWithExecpolicyAmendment', 'allow', 'always', false],
        ['cancel', 'deny', 'once', true],
    ]);
    assert.match(ev.ask.decisions[1].label, /saved to Codex's rules/, 'the persistent one says it is persistent');
    assert.match(ev.ask.decisions[1].label, /touch a/);
    assert.deepStrictEqual(a.answer(ev.ask, { behavior: 'allow', choice: ev.ask.decisions[1] }),
        { id: 0, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'a'] } } } });
    assert.deepStrictEqual(a.read({ method: 'serverRequest/resolved', params: { requestId: 0 } }), [],
        'resolved after our own answer withdraws nothing');
    assert.deepStrictEqual(a.read({ method: 'serverRequest/resolved', params: { requestId: 7 } }),
        [{ type: 'ask-withdrawn', id: '7' }], 'and withdraws one we never answered');

    const [perm] = a.read({ id: 3, method: 'item/permissions/requestApproval', params: {
        itemId: 'p', cwd: '/tmp', permissions: { network: { enabled: true } } } });
    assert.deepStrictEqual(perm.ask.decisions.map(d => d.id), ['turn', 'session', 'decline']);
    assert.deepStrictEqual(a.answer(perm.ask, { behavior: 'allow', choice: perm.ask.decisions[1] }),
        { id: 3, result: { permissions: { network: { enabled: true } }, scope: 'session' } });
    assert.deepStrictEqual(a.answer(perm.ask, { behavior: 'deny', choice: perm.ask.decisions[2] }),
        { id: 3, result: { permissions: {}, scope: 'turn' } });

    const evs = a.read({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm1', text: 'Colour?',
        delivery: 'async', questions: [{ title: 'Colour preference', options: ['Red', 'Blue'] }] } } });
    const q = evs.find(e => e.type === 'ask').ask;
    assert.strictEqual(q.followUp, true, 'the async question has no request behind it');
    assert.deepStrictEqual(q.input.questions[0].options.map(o => o.label), ['Red', 'Blue']);
    assert.strictEqual(a.answer(q, { behavior: 'allow', answers: [] }), null, 'and writes nothing to answer it');

    const line = a.turn({ uuid: 'u1', text: 'look', attachments: [
        { path: '/tmp/x.png', relPath: 'x.png', bytes: 10, mediaType: 'image/png' }] }, { handOver: false });
    assert.deepStrictEqual(line.params.input[1], { type: 'localImage', path: '/tmp/x.png' }, 'images go by path');
    assert.match(line.params.input[0].text, /x\.png/, 'with the note naming the file');
    assert.ok(line.id.startsWith('cx_'), 'turn ids are ours, never the runner\'s req_');
    ok('asks carry Codex\'s decisions and ids, and the async question and images are shaped right');
}

// --- D5: every turn/start carries the three settings for the mode ---------------------------------
{
    const a = new codex.Adapter({ rpc: async () => ({}) });
    a.threadId = 't'; a.model = 'm';
    const expect = {
        manual: ['untrusted', 'readOnly', 'user'], acceptEdits: ['on-request', 'workspaceWrite', 'user'],
        auto: ['on-request', 'workspaceWrite', 'auto_review'], plan: ['on-request', 'readOnly', 'user'],
        dontAsk: ['never', 'workspaceWrite', 'user'], bypassPermissions: ['never', 'dangerFullAccess', 'user'],
    };
    for (const [mode, want] of Object.entries(expect)) {
        a.setPermissionMode(mode);
        const p = a.turn({ uuid: 'u', text: 't' }, { handOver: false }).params;
        assert.deepStrictEqual([p.approvalPolicy, p.sandboxPolicy.type, p.approvalsReviewer], want, mode);
        if (mode === 'plan') assert.deepStrictEqual(p.collaborationMode, { mode: 'plan', settings: { model: 'm' } });
        if (mode === 'dontAsk') {
            assert.deepStrictEqual(p.collaborationMode, { mode: 'default', settings: { model: 'm' } },
                'the turn after a plan turn says it has left plan mode');
        }
    }
    ok('each permission mode maps onto all three Codex settings, sent on every turn');
}

(async () => {
    // --- a plain turn: the handshake gates, Codex mints the id ------------------------------------
    {
        const r = runner('plain');
        const placeholder = r.sessionId;
        const minted = [];
        r.on('minted', (e) => minted.push(e));
        r.send('hello');
        assert.strictEqual(r.state, 'starting');
        await until(() => r.lastResultText === 'pong' && r.state === 'idle', 5000, 'the plain turn');
        assert.deepStrictEqual(wire().filter(l => l.got).map(l => l.got.method).slice(0, 5),
            ['initialize', 'initialized', 'account/read', 'thread/start', 'turn/start'], 'the recorded order');
        assert.strictEqual(minted.length, 1);
        assert.strictEqual(minted[0].from, placeholder);
        assert.strictEqual(r.sessionId, '01a218f8-f9d0-7ea3-857e-f3b0b8756bbc', 'the id Codex minted');
        assert.strictEqual(r.claudeVersion, '0.172.0', 'the version, from initialize');
        await nextIsDelivered(r, ['hello'], 'a plain turn');
        assert.ok(wire().some(l => l.tail), 'the second turn was played past the recording');
        ok('a plain turn: gated handshake, minted id, and the next message delivered once');
    }

    // --- a command approval, answered from the card's own decisions -------------------------------
    {
        const r = runner('command-approval', { mode: 'manual' });
        const asked = [];
        r.on('permission-request', (p) => asked.push(p));
        r.send('touch it');
        await until(() => r.pendingPermission, 5000, 'the approval');
        const card = r.status().pendingPermission;
        assert.strictEqual(card.tool, 'exec_command');
        assert.strictEqual(card.input.command, 'touch made-by-codex.txt');
        assert.deepStrictEqual(card.decisions.map(d => d.id), ['accept', 'acceptWithExecpolicyAmendment', 'cancel']);
        assert.ok(!('raw' in card.decisions[0]), 'raw stays in the bridge');
        assert.strictEqual(r.answerPermission(card.requestId, 'allow-always').invalid, true,
            'no for-the-session entry, so the old button is refused rather than strengthened');
        assert.deepStrictEqual(r.answerPermission(card.requestId, null, { choice: 'accept' }), { ok: true });
        await until(() => r.state === 'idle', 5000, 'the turn to end');
        assert.match(r.lastResultText, /completed successfully/);
        const answer = wire().find(l => l.got && l.got.result && l.got.result.decision);
        assert.deepStrictEqual(answer.got, { id: 0, result: { decision: 'accept' } }, 'answered under Codex\'s id');
        assert.strictEqual(r.pendingPermission, null, 'resolved after our answer took nothing else down');
        await nextIsDelivered(r, ['touch it'], 'a command approval');
        ok('a command approval is drawn from availableDecisions and answered with Codex\'s own id and value');
    }

    // --- a file change after a command: two asks, two ids, in order --------------------------------
    {
        const r = runner('file-change-approval', { mode: 'manual' });
        r.send('edit notes');
        await until(() => r.pendingPermission, 5000, 'the command approval');
        assert.strictEqual(r.pendingPermission.tool, 'exec_command');
        r.answerPermission(r.pendingPermission.id, 'allow');
        await until(() => r.pendingPermission && r.pendingPermission.tool === 'apply_patch', 5000, 'the file change');
        const card = r.status().pendingPermission;
        assert.deepStrictEqual(card.decisions.map(d => d.id), ['accept', 'acceptForSession', 'decline', 'cancel']);
        assert.match(card.input.changes[0].diff, /\+second line/, 'the diff, from the item that started it');
        r.answerPermission(card.requestId, 'allow');
        await until(() => r.state === 'idle', 5000, 'the turn to end');
        assert.deepStrictEqual(wire().filter(l => l.got && l.got.result && l.got.result.decision).map(l => l.got),
            [{ id: 0, result: { decision: 'accept' } }, { id: 1, result: { decision: 'accept' } }]);
        await nextIsDelivered(r, ['edit notes'], 'a file-change approval');
        ok('a file-change approval carries its diff and the schema\'s four decisions');
    }

    // --- an approval nobody is there for is auto-denied in Codex's words --------------------------
    {
        const r = runner('command-approval', { mode: 'manual', viewer: false });
        r.send('touch it');
        await until(() => wire().some(l => l.got && l.got.result && l.got.result.decision), 5000, 'the auto-deny');
        assert.strictEqual(wire().find(l => l.got && l.got.result && l.got.result.decision).got.result.decision,
            'cancel', 'no decline on the list, so the refusal that ends the turn');
        // The recording goes on as though accepted — it is a recording — so what
        // matters is that the runner comes to rest with nothing held.
        await until(() => r.state === 'idle', 5000, 'the turn to end');
        await nextIsDelivered(r, ['touch it'], 'an auto-deny');
        ok('an ask with no window is denied with an entry from its own list');
    }

    // --- Stop: turn/interrupt, and the stopped turn is not sent again ------------------------------
    {
        const r = runner('interrupt');
        r.send('sleep 60');
        await until(() => r._pendingTools.size === 1, 5000, 'the command to start');
        const out = await r.stop();
        assert.strictEqual(out.how, 'soft', 'stopped by request, not by signal');
        await until(() => r.state === 'idle', 5000, 'the interrupted turn to end');
        assert.strictEqual(r.lastResult.stopReason, 'interrupted');
        assert.strictEqual(sent('turn/interrupt').length, 1);
        assert.deepStrictEqual(sent('turn/interrupt')[0].params, { threadId: '01a218f9-7a02-7642-9557-49c5f719d818',
            turnId: '01a218f9-7a13-7460-8c7f-874c65eaeafe' }, 'naming the thread and the turn');
        assert.ok(r.caps.interrupt, 'interrupt still on');
        await nextIsDelivered(r, ['sleep 60'], 'a stop');
        ok('a stopped turn ends interrupted, leaves nothing in flight, and is not delivered again');
    }

    // --- steer: a message typed while a command runs joins that turn -------------------------------
    {
        const r = runner('steer', { mode: 'dontAsk' });
        let results = 0;
        r.on('turn-complete', () => results++);
        r.send('sleep 8');
        r.send('Change of plan');
        await until(() => sent('turn/steer').length === 1, 5000, 'the steer');
        await until(() => r.state === 'idle', 5000, 'the folded turn to end');
        assert.strictEqual(r.lastResultText, 'heron', 'read by the running turn');
        assert.strictEqual(results, 1, 'one turn, not two');
        assert.deepStrictEqual(turnTexts(), ['sleep 8'], 'the steered message was not also sent as a turn');
        assert.strictEqual(sent('turn/steer')[0].params.expectedTurnId, '01a218ff-eff8-7231-a3e1-b30e2408418c');
        await nextIsDelivered(r, ['sleep 8'], 'a steer');
        ok('a message handed over mid-command is a turn/steer into the same turn');
    }

    // --- the blocking question, in plan mode ------------------------------------------------------
    {
        const r = runner('request-user-input', { mode: 'plan' });
        r.send('ask me');
        await until(() => r.pendingPermission, 5000, 'the question');
        const card = r.status().pendingPermission;
        assert.strictEqual(card.kind, 'question');
        assert.ok(!card.followUp, 'this one is a request Codex is blocked on');
        assert.strictEqual(card.input.questions[0].id, 'colour');
        assert.deepStrictEqual(r.answerPermission(card.requestId, 'allow', { answers: { colour: 'Red' } }), { ok: true });
        await until(() => r.state === 'idle', 5000, 'the turn to end');
        assert.deepStrictEqual(wire().find(l => l.got && l.got.result && l.got.result.answers).got,
            { id: 0, result: { answers: { colour: { answers: ['Red'] } } } });
        assert.deepStrictEqual(sent('turn/start')[0].params.collaborationMode,
            { mode: 'plan', settings: { model: 'gpt-6-luna' } }, 'plan mode names the thread\'s model');
        await nextIsDelivered(r, ['ask me'], 'a blocking question');
        ok('requestUserInput is a question card answered by id, in Codex\'s shape');
    }

    // --- the async question: a card with nothing blocked on it, answered by the next turn ---------
    {
        const r = runner('request-user-input-default');
        r.send('ask me');
        await until(() => r.pendingPermission && r.state === 'idle', 8000, 'the turn to end with a card up');
        const card = r.status().pendingPermission;
        assert.strictEqual(card.followUp, true);
        assert.strictEqual(card.kind, 'question');
        assert.strictEqual(r.state, 'idle', 'the session is not waiting on it');
        assert.strictEqual(r.inFlight.length, 0);
        assert.deepStrictEqual(r.answerPermission(card.requestId, 'allow', { answers: { [card.input.questions[0].question]: 'Blue' } }),
            { ok: true });
        await until(() => r.state === 'idle' && r.lastResultText === 'pong', 5000, 'the answer, as a turn');
        assert.deepStrictEqual(turnTexts(), ['ask me', 'Colour preference\nBlue'], 'the answer went as the next turn, once');
        assert.strictEqual(r.pendingPermission, null);
        ok('an async question is a follow-up card: answering it sends the next turn');
    }

    // --- plan mode: the plan item becomes a card, and Approve implements it ------------------------
    {
        const r = runner('plan', { mode: 'plan' });
        r.send('plan it');
        await until(() => r.pendingPermission && r.state === 'idle', 8000, 'the plan card');
        const card = r.status().pendingPermission;
        assert.strictEqual(card.kind, 'plan');
        assert.strictEqual(card.followUp, true);
        assert.match(card.input.plan, /scratch-space README/);
        assert.deepStrictEqual(r.answerPermission(card.requestId, 'allow', { mode: 'acceptEdits' }), { ok: true });
        await until(() => turnTexts().length === 2 && r.state === 'idle', 5000, 'the implementing turn');
        assert.strictEqual(turnTexts()[1], 'Implement the plan.');
        assert.strictEqual(r.permissionMode, 'acceptEdits');
        const p = sent('turn/start')[1].params;
        assert.deepStrictEqual([p.approvalPolicy, p.sandboxPolicy.type], ['on-request', 'workspaceWrite']);
        assert.deepStrictEqual(p.collaborationMode, { mode: 'default', settings: { model: 'gpt-6-luna' } },
            'and it says it has left plan mode');
        assert.strictEqual(r.inFlight.length, 0);
        ok('a plan card\'s Approve switches mode and sends "Implement the plan." as the next turn');

        // Revise stays in plan mode and sends the feedback.
        r._setPermissionMode('plan');
        r._onEvent({ type: 'ask', ask: { id: 'plan-x', kind: 'plan', tool: 'plan', displayName: 'Plan',
            input: { plan: 'p' }, followUp: true, askedAt: Date.now() } });
        assert.deepStrictEqual(r.answerPermission('plan-x', 'deny', { feedback: 'Fewer steps' }), { ok: true });
        await until(() => turnTexts().length === 3 && r.state === 'idle', 5000, 'the revising turn');
        assert.strictEqual(turnTexts()[2], 'Fewer steps');
        assert.strictEqual(r.permissionMode, 'plan');
        ok('Revise sends the feedback as another plan turn');
    }

    // --- signed out: the handshake fails before a turn is spent ------------------------------------
    {
        const r = runner('signed-out');
        const failed = new Promise((resolve) => r.once('failed', resolve));
        r.send('pong?');
        const f = await failed;
        assert.strictEqual(f.kind, 'codex-signed-out');
        assert.match(f.message, /codex login/);
        assert.deepStrictEqual(f.unsent, ['pong?'], 'the message comes back');
        assert.deepStrictEqual(sent('turn/start'), [], 'and no turn was spent learning it');
        ok('a signed-out Codex fails the start with its own kind and hands the message back');
    }
})().then(() => finish(0)).catch((err) => {
    console.error(err && err.stack || err);
    finish(1);
});

async function finish(code) {
    for (const r of made) {
        try { await r.stop({ hard: true }); } catch { /* gone */ }
    }
    await sleep(200);
    fs.rmSync(root, { recursive: true, force: true });
    if (!code) console.log(`\n${pass} codex-runner checks passed`);
    process.exit(code);
}
