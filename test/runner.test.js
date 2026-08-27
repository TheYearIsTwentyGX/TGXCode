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
    if (m.type !== 'user') return;
    const text = (m.message.content || [])
        .filter(b => b.type === 'text').map(b => b.text).join('\\n');
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ text, pid: process.pid }) + '\\n');
    if (/\\bHANG\\b/.test(text)) {
        return out({ type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } });
    }
    if (/\\bDIE0\\b/.test(text)) { setTimeout(() => process.exit(0), 120); return; }
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

const { Runner } = require('../bridge/runner.js');

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
})().then(() => finish(0)).catch((err) => {
    console.error(err && err.stack || err);
    finish(1);
});

async function finish(code) {
    for (const r of made) {
        try { await r.stop({ hard: true }); } catch { /* already gone */ }
    }
    await sleep(200);
    fs.rmSync(root, { recursive: true, force: true });
    if (!code) console.log(`\n${pass} runner checks passed`);
    process.exit(code);
}
