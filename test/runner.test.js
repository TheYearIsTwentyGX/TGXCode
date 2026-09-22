'use strict';

// The runner's message accounting — bridge/runner.js.
//
// No bridge needed, and no real `claude`: CLAUDE_BIN comes from
// CLAUDE_SESSIONS_CLAUDE_BIN, so a stub script standing in for the CLI is enough
// to drive the whole state machine. It has to be set *before* the module is
// required, because the constant is destructured at load.
//
// This file exists because of one bug and the shape of it. `inFlight` is both the
// record of the turn being answered and the gate in `_flushQueue` — while
// anything is in it, nothing is written. Two exit paths used to leave it
// populated, and the result was a session that accepted a message, drew a chip
// for it, reported `idle`, and never sent it. Nothing threw, nothing logged, and
// the runner looked healthy from every angle; the user saw a turn that was slow
// forever. That is the failure mode worth a test: the ones that are invisible.
//
// So the assertions come in threes. `inFlight.length` is the invariant; a message
// actually reaching the stub is the symptom, because the invariant could be
// satisfied by a fix that quietly drops the text instead of sending it; and the
// stub's log is what catches a fix that sends the message *twice*, which is the
// other way to get this wrong and the one that looks like success.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
const stub = path.join(root, 'fake-claude.js');
const logFile = path.join(root, 'turns.ndjson');

// Speaks just enough stream-json to move the runner between states: `system/init`
// on start, a `control_response` to anything asked of it (so `initialize` and
// `interrupt` never wait out the 8s timeout), and per user turn either a `result`
// or, for HANG, an assistant block and then silence. Every turn it reads is
// appended to a log, which is the only way to tell "delivered once" from
// "delivered twice" or "never delivered".
//
// Shebanged with process.execPath rather than `node`: a login shell on this
// machine has no node on PATH, which is the same reason bridge/launch.sh exists.
const STUB = `#!${process.execPath}
'use strict';
const readline = require('readline');
const fs = require('fs');
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i < 0 ? null : argv[i + 1]; };
const sessionId = at('--session-id') || at('--resume') || 'stub';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const LOG = process.env.FAKE_CLAUDE_LOG;

out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(),
      model: 'stub', tools: [], slash_commands: [] });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'control_request') {
        return out({ type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: {} } });
    }
    // The answer to an ASK below. The result follows after a pause, so a case can
    // restart the bridge between the answer and the end of the turn.
    if (m.type === 'control_response' && m.response && m.response.request_id === 'ask1') {
        const how = (m.response.response || {}).behavior;
        return setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false,
            result: 'answered:' + how, duration_ms: 1, num_turns: 1, total_cost_usd: 0,
            session_id: sessionId }), 300);
    }
    if (m.type !== 'user') return;
    const text = (m.message.content || [])
        .filter(b => b.type === 'text').map(b => b.text).join('\\n');
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ text, pid: process.pid }) + '\\n');
    if (/\\bHANG\\b/.test(text)) {
        return out({ type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } });
    }
    if (/\\bDIE0\\b/.test(text)) { setTimeout(() => process.exit(0), 120); return; }
    // A turn that takes a while: long enough to restart a bridge in the middle of.
    const slow = /\\bSLOW(\\d+)\\b/.exec(text);
    if (slow) {
        return setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false,
            result: text, duration_ms: 1, num_turns: 1, total_cost_usd: 0,
            session_id: sessionId }), Number(slow[1]));
    }
    // A turn that stops to ask, the way a real one blocks on can_use_tool.
    if (/\\bASK\\b/.test(text)) {
        return setTimeout(() => out({ type: 'control_request', request_id: 'ask1',
            request: { subtype: 'can_use_tool', tool_name: 'Write',
                input: { file_path: 'x' }, tool_use_id: 'tu1' } }), 150);
    }
    out({ type: 'result', subtype: 'success', is_error: false, result: text,
          duration_ms: 1, num_turns: 1, total_cost_usd: 0, session_id: sessionId });
}).on('close', () => process.exit(0));
`;

fs.writeFileSync(stub, STUB, { mode: 0o755 });

process.env.CLAUDE_SESSIONS_CLAUDE_BIN = stub;
process.env.FAKE_CLAUDE_LOG = logFile;
// Not 45888, and never actually reached: it only lands in the --mcp-config string
// the stub ignores, and sessionEnv() strips it from the child anyway.
process.env.CLAUDE_SESSIONS_PORT = '45939';

const { Runner, RunnerPool } = require('../bridge/runner.js');
const hostClient = require('../bridge/host-client.js');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Forget the turns so far, so each case can assert on an exact list. */
const reset = () => fs.rmSync(logFile, { force: true });

/** Every turn the stub has been handed, in order. */
function turns() {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

async function until(fn, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(25);
    }
    assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

function once(emitter, event, ms = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`no "${event}" event within ${ms}ms`)), ms);
        emitter.once(event, (v) => { clearTimeout(timer); resolve(v); });
    });
}

// Tracked so a failed assertion mid-turn cannot leave a stub behind: the runner
// spawns detached, so nothing else would clean them up.
const made = [];
const pools = [];
let hostPid = null;

/**
 * A bridge, as far as the runner is concerned: a pool with a window attached. A
 * restart is `shutdown()` on one of these and `adoptHeld()` on a fresh one, both
 * against the same session host — which is exactly what a new bridge process does,
 * minus the process.
 */
function bridge() {
    // One bridge per host at a time, as in life: whatever the last case left is
    // stopped for real, or the next adoptHeld() would take it over as well. A pool
    // that was already shut down normally has nothing left to stop.
    for (const p of pools) p.shutdown({ force: true });
    const pool = new RunnerPool();
    pool.hasViewer = () => true;
    pools.push(pool);
    return pool;
}
function runner() {
    const r = new Runner({ sessionId: randomUUID(), cwd: root, isNew: true });
    made.push(r);
    return r;
}

(async () => {
    // --- a hard stop must not swallow the next message --------------------
    // The bug, end to end. Force stop is the ordinary escalation, and killing the
    // CLI mid-turn is the exit that used to leave `inFlight` occupied for good.
    {
        reset();
        const r = runner();
        r.send('HANG one');
        await until(() => turns().length === 1, 5000, 'the stub to read the first turn');
        await r.stop({ hard: true });
        await once(r, 'exit');

        assert.strictEqual(r.state, 'stopped');
        assert.strictEqual(r.inFlight.length, 0,
            'a killed turn must not stay in flight — it is the gate on every later write');
        ok('a hard stop leaves nothing in flight');

        r.send('two');
        await until(() => r.lastResultText === 'two', 8000,
            'the message sent after a hard stop to actually be answered');
        ok('the message sent after a hard stop is delivered');

        assert.deepStrictEqual(turns().map(t => t.text), ['HANG one', 'two'],
            'the stopped turn must not be re-sent: it is already in the transcript');
        ok('and the stopped turn is not re-sent alongside it');

        assert.strictEqual(new Set(turns().map(t => t.pid)).size, 2,
            'the second message should have gone to a second process');
        ok('a fresh process answered it');
    }

    // --- a clean exit hands back what it never answered -------------------
    // `code === 0` was the other leaky branch, and worse: no `failed` fired, and
    // the client only keeps its own copy of a message it was told was *not*
    // queued — so a queued one died in both places at once.
    {
        reset();
        const r = runner();
        r.send('HANG a');
        await until(() => turns().length === 1, 5000, 'the first turn');
        r.send('b');
        assert.strictEqual(r.status().queued, 1, 'the second message should be waiting');

        // Written straight down the pipe rather than through send(), because
        // _flushQueue would hold it behind the turn in flight — and reaching the
        // stub while `inFlight` is occupied is the whole point of the case.
        r.proc.stdin.write(JSON.stringify({
            type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'DIE0' }] },
        }) + '\n');

        const f = await once(r, 'failed');
        assert.strictEqual(f.kind, 'exited');
        assert.ok(f.unsent.includes('b'), 'the queued message has to come back');
        assert.strictEqual(r.queue.length, 0,
            'handed back and still queued would send it twice');
        assert.strictEqual(r.inFlight.length, 0);
        ok('a clean exit hands back the messages it never answered, once');
    }

    // --- an EPIPE on a child's pipes must not take the bridge down --------
    // A broken pipe on a socket does not throw at the call site — `_write`'s
    // try/catch cannot see it — it arrives as an 'error' on the stream. An 'error'
    // with no listener is thrown by EventEmitter itself, and with no
    // uncaughtException handler in this bridge that ends the process and every
    // other session with it.
    //
    // The event is emitted directly rather than raced for. Getting a real EPIPE
    // out of the kernel needs the child dead, the stream not yet destroyed and the
    // pipe buffer full, and which of those is true when depends on the platform —
    // a test that only sometimes reaches the code it is about is worse than no
    // test. This is the same event by the same path, and if nothing is listening
    // the emit throws here and the case fails.
    {
        reset();
        const r = runner();
        r.send('HANG c');
        await until(() => turns().length === 1, 5000, 'the turn to be read');
        const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        for (const stream of [r.proc.stdin, r.proc.stdout, r.proc.stderr]) {
            stream.emit('error', epipe());
        }
        assert.strictEqual(r.state, 'busy', 'and it is not mistaken for the turn ending');
        ok('a broken pipe on a child stream is handled, not thrown');
    }

    // --- Stop with no process gives the queue back ------------------------
    // The recovery was itself broken: chips on the composer, Stop pressed, nothing
    // returned, and the UI announcing that it had killed something.
    {
        reset();
        const r = runner();
        r.send('HANG d');
        await until(() => turns().length >= 1, 5000, 'the turn to be read');
        await r.stop({ hard: true });
        await once(r, 'exit');
        assert.strictEqual(r.proc, null, 'the process is gone but the runner is not');

        // Straight onto the queue: with no process there is nothing for send() to
        // flush to, and this is exactly the state a wedged session sat in.
        r.queue.push({ id: 'q999', text: 'still waiting', at: Date.now(), attachments: [] });

        const out = await r.stop();
        assert.strictEqual(out.how, null, 'there was no process to stop');
        assert.deepStrictEqual(out.dropped.map(q => q.text), ['still waiting'],
            'a stop with no process still owes the user what it is holding');
        assert.strictEqual(r.queue.length, 0);
        ok('Stop with no process returns the queue instead of keeping it');
    }

    // --- the session host: a bridge restart in the middle of a turn -------
    // The reason bridge/host.js exists. Each case restarts the "bridge" at a
    // different point in a turn and asserts the same three things the cases above
    // do — nothing wrongly in flight, the next message delivered, nothing sent
    // twice — plus the one that is new: it is the *same process* on both sides.
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
        made.dir = dir;
        const up = await hostClient.ensureHost({ socketPath: path.join(dir, 'h.sock'),
            logFile: path.join(dir, 'host.log') });
        assert.ok(up, 'a session host for these cases');
        hostPid = hostClient.status().pid;
    }

    // A turn that ends while no bridge is up. The next bridge must see it as
    // finished, say so, and send what was queued behind it.
    {
        reset();
        const id = randomUUID();
        const b1 = bridge();
        const r1 = b1.ensure(id, { cwd: root, isNew: true });
        r1.send('SLOW400 first');
        await until(() => turns().length === 1, 5000, 'the first turn');
        assert.ok(r1.proc.hosted, 'the process is in the host');
        r1.send('second');
        assert.strictEqual(r1.status().queued, 1);
        assert.strictEqual(b1.shutdown().held, 1, 'the busy turn is left running');

        await sleep(700);   // the result lands with nobody listening

        const b2 = bridge();
        const done = once(b2, 'turn-complete');
        assert.strictEqual(await b2.adoptHeld(), 1);
        const r2 = b2.get(id);
        assert.ok(r2, 'the next bridge has a runner for it');
        await done;
        await until(() => r2.lastResultText === 'second', 5000, 'the queued message');
        assert.strictEqual(r2.inFlight.length, 0);
        assert.deepStrictEqual(turns().map(t => t.text), ['SLOW400 first', 'second'],
            'each message delivered once');
        assert.strictEqual(new Set(turns().map(t => t.pid)).size, 1,
            'by the process that was running before the restart');
        ok('a turn that finished while the bridge was down is picked up as finished');
        ok('and the message queued behind it survives the restart and is sent');
    }

    // A turn still running when the next bridge arrives. It must be adopted as
    // busy — so a new message waits behind it instead of being written into it.
    {
        reset();
        const id = randomUUID();
        const b1 = bridge();
        const r1 = b1.ensure(id, { cwd: root, isNew: true });
        r1.send('SLOW900 long');
        await until(() => turns().length === 1, 5000, 'the turn');
        b1.shutdown();

        const b2 = bridge();
        await b2.adoptHeld();
        const r2 = b2.get(id);
        assert.strictEqual(r2.state, 'busy', 'adopted mid-turn is busy');
        assert.strictEqual(r2.inFlight.length, 1, 'with the turn in flight');
        r2.send('after');
        assert.strictEqual(r2.status().queued, 1, 'a new message waits its turn');
        await until(() => r2.lastResultText === 'after', 5000, 'the message after');
        assert.deepStrictEqual(turns().map(t => t.text), ['SLOW900 long', 'after']);
        assert.strictEqual(new Set(turns().map(t => t.pid)).size, 1);
        ok('a turn still running is adopted busy, and the next message waits for it');
    }

    // An idle process is carried across too. Idle is not finished: a turn that
    // moved a command into the background reports idle while it runs, and
    // stopping idle processes at shutdown is what killed one in the first real run.
    {
        reset();
        const id = randomUUID();
        const b1 = bridge();
        const r1 = b1.ensure(id, { cwd: root, isNew: true });
        r1.send('quick');
        await until(() => r1.lastResultText === 'quick', 5000, 'the turn');
        assert.strictEqual(r1.state, 'idle');
        assert.strictEqual(b1.shutdown().held, 1, 'released, not stopped');

        const b2 = bridge();
        assert.strictEqual(await b2.adoptHeld(), 1);
        const r2 = b2.get(id);
        assert.strictEqual(r2.state, 'idle');
        r2.send('again');
        await until(() => r2.lastResultText === 'again', 5000, 'the next turn');
        assert.strictEqual(new Set(turns().map(t => t.pid)).size, 1,
            'the same process, not a --resume');
        ok('an idle process survives the restart as well, and is used again');
    }

    // An ask raised while no bridge was up. The CLI is blocked on it, so the
    // next bridge must put the card back — not deny it for want of a window.
    {
        reset();
        const id = randomUUID();
        const b1 = bridge();
        const r1 = b1.ensure(id, { cwd: root, isNew: true });
        r1.send('ASK c');
        await until(() => turns().length === 1, 5000, 'the turn');
        b1.shutdown();
        await sleep(400);   // the ask arrives now, to nobody

        const b2 = bridge();
        b2.hasViewer = () => false;   // no window has reconnected yet, either
        await b2.adoptHeld();
        const r2 = b2.get(id);
        assert.ok(r2.pendingPermission, 'the ask is waiting');
        assert.strictEqual(r2.pendingPermission.tool, 'Write');
        assert.strictEqual(r2.state, 'busy');
        assert.deepStrictEqual(r2.answerPermission(r2.pendingPermission.id, 'allow'), { ok: true });
        await until(() => r2.lastResultText === 'answered:allow', 5000, 'the answer to land');
        assert.strictEqual(r2.state, 'idle');
        ok('an ask raised while the bridge was down is shown again and can be answered');
    }

    // An ask answered just before the restart. It looks exactly like an open one
    // in the replay; only the note says otherwise, and a card for it would be a
    // question the CLI is no longer asking.
    {
        reset();
        const id = randomUUID();
        const b1 = bridge();
        const r1 = b1.ensure(id, { cwd: root, isNew: true });
        r1.send('ASK d');
        await until(() => r1.pendingPermission, 5000, 'the card');
        r1.answerPermission(r1.pendingPermission.id, 'allow');
        b1.shutdown();       // before the stub's result, 300ms after the answer

        const b2 = bridge();
        await b2.adoptHeld();
        const r2 = b2.get(id);
        assert.strictEqual(r2.pendingPermission, null, 'no card for an answered ask');
        assert.strictEqual(r2.state, 'busy', 'but the turn is still going');
        await until(() => r2.lastResultText === 'answered:allow', 5000, 'the turn to end');
        ok('an ask answered before the restart is not asked again');
    }
})().then(() => finish(0)).catch((err) => {
    console.error(err && err.stack || err);
    finish(1);
});

async function finish(code) {
    for (const r of made) {
        try { await r.stop({ hard: true }); } catch { /* already gone */ }
    }
    for (const pool of pools) {
        for (const r of pool.runners.values()) {
            try { await r.stop({ hard: true }); } catch { /* already gone */ }
        }
    }
    if (hostPid) { await sleep(200); try { process.kill(hostPid, 'SIGKILL'); } catch { /* gone */ } }
    if (made.dir) fs.rmSync(made.dir, { recursive: true, force: true });
    await sleep(200);
    fs.rmSync(root, { recursive: true, force: true });
    if (!code) console.log(`\n${pass} runner checks passed`);
    process.exit(code);
}
