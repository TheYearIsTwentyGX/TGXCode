'use strict';

// A Codex approval across a bridge restart: the session host keeps the
// app-server running, the releasing bridge leaves a note holding the pending
// request — Codex's own integer id included — and the adopting bridge redraws
// the card and answers that id. docs/plans/23-codex.md, Phase 3, "Pending
// approvals across a bridge restart"; the Claude cases are in test/runner.test.js
// and test/host.test.js.
//
// The app-server is test/fixtures/codex/walker.js replaying a recording, so the
// answer is checked against what Codex was actually waiting for: the wrong id, or
// an answer from a process that is not the one that asked, is a mismatch in the
// walker's log. Each case asserts the runner test's three things as well —
// nothing left in flight, the next message delivered, nothing sent twice — plus
// that it is the same process on both sides of the restart.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const FIX = path.join(__dirname, 'fixtures', 'codex');
// Short on purpose: a Unix socket path has a 108-byte ceiling.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxh-'));
const walker = path.join(root, 'walker');
const logFile = path.join(root, 'wire.ndjson');

process.env.TGXCODE_PORT = '45944';
fs.writeFileSync(walker, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(FIX, 'walker.js'))});\n`,
    { mode: 0o755 });
process.env.TGXCODE_CODEX_BIN = walker;
process.env.FAKE_CODEX_LOG = logFile;

const hostClient = require('../bridge/host-client.js');
const { RunnerPool } = require('../bridge/runner.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let hostPid = null;

function wire() {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}
const got = () => wire().filter(l => l.got);
const turnStarts = () => got().filter(l => l.got.method === 'turn/start');
const decisions = () => got().filter(l => l.got.result && l.got.result.decision);

async function until(fn, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(20);
    }
    assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

const pools = [];
function bridge({ viewer = true } = {}) {
    for (const p of pools) p.shutdown({ force: true });
    const pool = new RunnerPool();
    pool.hasViewer = () => viewer;
    pools.push(pool);
    return pool;
}

function scenario(name) {
    fs.rmSync(logFile, { force: true });
    process.env.FAKE_CODEX_FIXTURE = path.join(FIX, `${name}.ndjson`);
}

(async () => {
    const up = await hostClient.ensureHost({ socketPath: path.join(root, 'h.sock'),
        logFile: path.join(root, 'host.log') });
    assert.ok(up, 'a session host for these cases');
    hostPid = hostClient.status().pid;

    // --- an approval pending when the bridge goes ------------------------------------------------
    {
        scenario('command-approval');
        const b1 = bridge();
        const r1 = b1.ensure(randomUUID(), { cwd: root, isNew: true, runtime: 'codex', permissionMode: 'manual' });
        r1.send('touch it');
        await until(() => r1.pendingPermission, 5000, 'the approval');
        assert.ok(r1.proc.hosted, 'the app-server is in the host');
        const id = r1.sessionId;
        assert.strictEqual(id, '01a218f9-0234-7a00-964a-d64c4cb5152e', 'the minted id is the one the note is under');
        assert.strictEqual(b1.shutdown().held, 1, 'released with the card up, not stopped');

        const b2 = bridge({ viewer: false });   // no window has reconnected yet
        assert.strictEqual(await b2.adoptHeld(), 1);
        const r2 = b2.get(id);
        assert.ok(r2, 'the next bridge has a runner for the minted id');
        assert.strictEqual(r2.runtime, 'codex', 'on Codex, from the note');
        const card = r2.status().pendingPermission;
        assert.ok(card, 'the card is redrawn, not auto-denied for want of a window');
        assert.strictEqual(card.tool, 'exec_command');
        assert.deepStrictEqual(card.decisions.map(d => d.id), ['accept', 'acceptWithExecpolicyAmendment', 'cancel']);
        assert.strictEqual(r2.pendingPermission.rpcId, 0, 'with Codex\'s integer id');
        assert.strictEqual(r2.state, 'busy');
        assert.deepStrictEqual(decisions(), [], 'nothing answered it in between');

        assert.deepStrictEqual(r2.answerPermission(card.requestId, null, { choice: 'accept' }), { ok: true });
        await until(() => r2.state === 'idle', 5000, 'the turn to end after the answer');
        assert.match(r2.lastResultText, /completed successfully/);
        assert.deepStrictEqual(decisions().map(l => l.got), [{ id: 0, result: { decision: 'accept' } }],
            'answered once, under the id Codex was waiting on');
        assert.strictEqual(new Set(got().map(l => l.pid)).size, 1, 'by the process that asked');
        assert.strictEqual(r2.inFlight.length, 0, 'nothing left in flight');

        r2.send('after the restart');
        await until(() => r2.state === 'idle' && r2.lastResultText === 'pong', 5000, 'the next message');
        assert.deepStrictEqual(turnStarts().map(l => l.got.params.input[0].text), ['touch it', 'after the restart'],
            'each turn delivered once');
        assert.strictEqual(new Set(got().map(l => l.pid)).size, 1, 'still the same app-server, not a resume');
        assert.deepStrictEqual(wire().filter(l => l.mismatch), []);
        ok('an approval pending across a restart is redrawn after adoption and answered under Codex\'s id');
        ok('and the session goes on in the same process, each message delivered once');
    }

    // --- the note alone is enough: the host's log has lost the request ----------------------------
    // A turn that out-talks the host's replay buffer loses the front of it. The
    // note carries the ask whole, so the card still comes back.
    {
        scenario('command-approval');
        const b1 = bridge();
        const r1 = b1.ensure(randomUUID(), { cwd: root, isNew: true, runtime: 'codex', permissionMode: 'manual' });
        r1.send('touch it');
        await until(() => r1.pendingPermission, 5000, 'the approval');
        const id = r1.sessionId;
        b1.shutdown();

        const b2 = bridge({ viewer: false });
        const adopt = hostClient.adopt;
        // The replay as a host with a full buffer would give it: nothing.
        hostClient.adopt = async (key) => ({ ...(await adopt(key)), records: [] });
        try {
            assert.strictEqual(await b2.adoptHeld(), 1);
        } finally {
            hostClient.adopt = adopt;
        }
        const r2 = b2.get(id);
        assert.ok(r2.pendingPermission, 'redrawn from the note');
        assert.strictEqual(r2.pendingPermission.rpcId, 0);
        r2.answerPermission(r2.pendingPermission.id, 'allow');
        await until(() => r2.state === 'idle', 5000, 'the turn to end');
        assert.deepStrictEqual(decisions().map(l => l.got), [{ id: 0, result: { decision: 'accept' } }]);
        r2.send('next');
        await until(() => r2.state === 'idle' && r2.lastResultText === 'pong', 5000, 'the next message');
        assert.strictEqual(r2.inFlight.length, 0);
        ok('a card whose request fell out of the host\'s log is redrawn from the note');
    }

    // --- an approval answered just before the restart is not asked again --------------------------
    {
        scenario('command-approval');
        const b1 = bridge();
        const r1 = b1.ensure(randomUUID(), { cwd: root, isNew: true, runtime: 'codex', permissionMode: 'manual' });
        r1.send('touch it');
        await until(() => r1.pendingPermission, 5000, 'the approval');
        const id = r1.sessionId;
        r1.answerPermission(r1.pendingPermission.id, null, { choice: 'accept' });
        b1.shutdown();

        const b2 = bridge();
        await b2.adoptHeld();
        const r2 = b2.get(id);
        assert.strictEqual(r2.pendingPermission, null, 'no card for an answered ask');
        await until(() => r2.state === 'idle', 5000, 'the turn to end');
        assert.strictEqual(decisions().length, 1, 'answered once');
        ok('an approval answered before the restart is not redrawn');
    }
})().then(() => finish(0)).catch((err) => {
    console.error(err && err.stack || err);
    finish(1);
});

async function finish(code) {
    for (const p of pools) p.shutdown({ force: true });
    await sleep(300);
    if (hostPid) { try { process.kill(hostPid, 'SIGTERM'); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
    if (!code) console.log(`\n${pass} codex-host checks passed`);
    process.exit(code);
}
