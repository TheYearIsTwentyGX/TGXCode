'use strict';

// Restart process — `POST /api/sessions/:id/restart` and RunnerPool#restart.
//
// A session's `claude` reads bridge/mcp.js's tool list once, at launch, and the
// session host keeps it alive across bridge restarts, so this is the one way to
// give a running session a tool TGXCode gained since. What can go wrong is the
// replacement itself: a new process that starts a *new* conversation instead of
// resuming, one that starts in the directory the runner was made in rather than
// the one the session now resumes from (#230's override), a queue left behind on
// the old runner, or a turn or an approval card cut short by a restart nobody
// meant to be destructive.
//
// The route is driven directly, as test/session-title.test.js drives its own,
// against a real pool and a stub `claude` (runner.test.js's approach, smaller):
// the stub logs every start with its argv and cwd, and every turn it is handed.
//
// **XDG_DATA_HOME and the stub before the require.** CLAUDE_BIN is destructured
// at load, and STATE_DIR is built once — and with a fresh one there is no session
// host to find, so every process here is the test's own child.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { randomUUID } = require('crypto');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restart-process-')));
const stub = path.join(root, 'fake-claude.js');
const logFile = path.join(root, 'log.ndjson');

// `system/init` on start, a `control_response` to anything asked, and per turn a
// `result` — or, for SLOW<n>, one after n ms; for ASK, a `can_use_tool` that is
// never answered; for BG<n>, a background task that finishes n ms after the turn.
const STUB = `#!${process.execPath}
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i < 0 ? null : argv[i + 1]; };
const sessionId = at('--session-id') || at('--resume') || 'stub';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const log = (o) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...o }) + '\\n');
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text,
    duration_ms: 1, num_turns: 1, total_cost_usd: 0, session_id: sessionId });
log({ start: true, argv });
out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(),
      model: 'stub', tools: [], slash_commands: [] });
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'control_request') {
        return out({ type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: {} } });
    }
    if (m.type !== 'user') return;
    const text = (m.message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\\n');
    log({ text });
    const slow = /\\bSLOW(\\d+)\\b/.exec(text);
    if (slow) return setTimeout(() => result(text), Number(slow[1]));
    if (/\\bASK\\b/.test(text)) {
        return out({ type: 'control_request', request_id: 'ask1',
            request: { subtype: 'can_use_tool', tool_name: 'Write',
                input: { file_path: 'x' }, tool_use_id: 'tu1' } });
    }
    const bg = /\\bBG(\\d+)\\b/.exec(text);
    if (bg) {
        out({ type: 'system', subtype: 'task_started', task_id: 'bg1', task_type: 'local_bash',
            is_backgrounded: true, session_id: sessionId });
        result(text);
        return setTimeout(() => out({ type: 'system', subtype: 'task_notification', task_id: 'bg1',
            status: 'completed', summary: 'done', session_id: sessionId }), Number(bg[1]));
    }
    result(text);
}).on('close', () => process.exit(0));
`;
fs.writeFileSync(stub, STUB, { mode: 0o755 });

process.env.XDG_DATA_HOME = path.join(root, 'data');
process.env.TGXCODE_CLAUDE_BIN = stub;
process.env.FAKE_CLAUDE_LOG = logFile;
// Never reached: it only lands in the --mcp-config string the stub ignores.
process.env.TGXCODE_PORT = '45941';

const { RunnerPool } = require('../bridge/runner');
const sessionRoute = require('../bridge/routes/session');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(25);
    }
    assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

const reset = () => fs.rmSync(logFile, { force: true });
const lines = () => (fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const starts = () => lines().filter(l => l.start);
const turns = () => lines().filter(l => l.text !== undefined);

const pool = new RunnerPool();
pool.hasViewer = () => true;

// What the route asks the index and sessionCwd: a summary per session, and an
// override per session standing in for #230's, which is what sessionCwd honours.
const summaries = new Map();
const overrides = new Map();
sessionRoute.init({
    index: { summary: (id) => summaries.get(id) || null },
    pool,
    sessionCwd: (s) => overrides.get(s.sessionId) || s.cwd,
});

const LOCAL = { remote: false, peer: 'test', host: null };

async function restart(id, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    let status = 0;
    let payload = '';
    const res = {
        writeHead(s) { status = s; },
        end(b) { payload = b ? b.toString() : ''; },
    };
    const pathname = `/api/sessions/${id}/restart`;
    await sessionRoute.handle(req, res, new URL(`http://127.0.0.1${pathname}`), pathname,
        pathname.split('/').filter(Boolean), LOCAL);
    return { status, body: payload ? JSON.parse(payload) : null };
}

/** A session with a live, idle process that has answered one turn. */
async function live(cwd = root) {
    const id = randomUUID();
    summaries.set(id, { sessionId: id, cwd });
    const r = pool.ensure(id, { cwd, isNew: true, model: 'sonnet', effort: 'high',
        permissionMode: 'acceptEdits' });
    r.send('hello');
    await until(() => turns().length === 1 && r.state === 'idle', 5000, 'the first turn');
    return { id, r };
}

(async () => {
    {
        reset();
        const { id, r } = await live();
        const seen = [];
        pool.on('status', (s) => { if (s.sessionId === id) seen.push(s); });
        const out = await restart(id);
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.body.ok, true);
        assert.strictEqual(out.body.restarted, true);
        const fresh = pool.get(id);
        assert.notStrictEqual(fresh, r, 'a new runner in its place');
        assert.ok(fresh.proc, 'started at once, not on the next message');
        assert.strictEqual(out.body.status.sessionId, id);
        await until(() => starts().length === 2, 5000, 'the second process');
        const [first, second] = starts();
        assert.notStrictEqual(second.pid, first.pid, 'a new process');
        assert.strictEqual(second.argv[second.argv.indexOf('--resume') + 1], id,
            'resuming the same conversation');
        assert.ok(!second.argv.includes('--session-id'), 'not minting a new one');
        assert.strictEqual(second.cwd, root, 'in the same directory');
        assert.strictEqual(second.argv[second.argv.indexOf('--model') + 1], 'sonnet');
        assert.strictEqual(second.argv[second.argv.indexOf('--effort') + 1], 'high');
        assert.strictEqual(second.argv[second.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
        assert.ok(seen.length > 0, 'a status event for the window');
        await until(() => fresh.state === 'idle', 3000, 'the new process to be ready');
        fresh.send('after');
        await until(() => turns().length === 2, 5000, 'the next message');
        assert.strictEqual(turns()[1].pid, second.pid, 'delivered to the new process');
        ok('a restart starts a new process at once, with --resume, in the same cwd and settings');
    }

    {
        reset();
        const { id, r } = await live();
        r.queue.push({ id: 'qcarried', uuid: randomUUID(), text: 'carried', at: Date.now(), attachments: [] });
        const out = await restart(id);
        assert.strictEqual(out.body.restarted, true);
        await until(() => turns().length === 2, 5000, 'the carried message');
        assert.strictEqual(turns()[1].text, 'carried');
        assert.strictEqual(turns()[1].pid, starts()[1].pid, 'sent by the new process');
        assert.strictEqual(turns().filter(t => t.text === 'carried').length, 1, 'once');
        ok('a queued message carries across a restart and is sent once');
    }

    {
        reset();
        const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(root, 'home-')));
        const { id } = await live();
        overrides.set(id, elsewhere);
        const out = await restart(id);
        assert.strictEqual(out.body.restarted, true);
        assert.strictEqual(pool.get(id).cwd, elsewhere);
        await until(() => starts().length === 2, 5000, 'the second process');
        assert.strictEqual(starts()[1].cwd, elsewhere, 'where the session now resumes from');
        ok('a restart uses sessionCwd, so a moved orchestrator restarts at home');
    }

    {
        reset();
        const { id, r } = await live();
        r.pendingSettings = { model: 'haiku', effort: 'low' };
        await restart(id, { force: true });
        const fresh = pool.get(id);
        assert.strictEqual(fresh.model, 'haiku', 'the held model change is applied, not lost');
        assert.strictEqual(fresh.effort, 'low');
        assert.strictEqual(fresh.pendingSettings, null);
        ok('a model change held for background work is applied by the restart');
    }

    // --- the refusals ---------------------------------------------------------
    {
        reset();
        const out = await restart(randomUUID());
        assert.strictEqual(out.status, 404);

        const id = randomUUID();
        summaries.set(id, { sessionId: id, cwd: root });
        const none = await restart(id);
        assert.strictEqual(none.status, 200);
        assert.deepStrictEqual(none.body, { ok: true, restarted: false, status: null });

        // A runner with no process — what a relocate or a model change leaves.
        const { id: id2 } = await live();
        pool.relocate(id2, root);
        const idle = await restart(id2);
        assert.strictEqual(idle.status, 200);
        assert.strictEqual(idle.body.restarted, false);
        assert.strictEqual(idle.body.status.state, 'stopped');
        assert.ok(!pool.get(id2).proc, 'and nothing was started');
        ok('no live process: 404 for an unknown session, otherwise 200 restarted:false');
    }

    {
        reset();
        const { id, r } = await live();
        r.send('SLOW800 busy');
        await until(() => r.state === 'busy', 3000, 'the turn to start');
        const out = await restart(id);
        assert.strictEqual(out.status, 409);
        assert.strictEqual(out.body.busy, true);
        assert.ok(/wait for the turn to finish, or stop it first/.test(out.body.error));
        const forced = await restart(id, { force: true });
        assert.strictEqual(forced.status, 409, 'force does not cut a turn short');
        assert.strictEqual(pool.get(id), r, 'nothing replaced');
        await until(() => r.state === 'idle', 3000, 'the turn to end');
        ok('a turn in progress: 409 busy, force or not');
    }

    {
        reset();
        const { id, r } = await live();
        r.send('ASK');
        await until(() => r.pendingPermission, 3000, 'the card');
        const out = await restart(id);
        assert.strictEqual(out.status, 409);
        assert.strictEqual(out.body.busy, true);
        assert.strictEqual(pool.get(id), r);
        assert.ok(r.pendingPermission, 'the card is still there');
        await r.stop({ hard: true });
        ok('a pending approval card: 409 busy, and the card survives');
    }

    {
        reset();
        const { id, r } = await live();
        r.send('BG60000 background');
        await until(() => r.state === 'idle' && r.hasBackground, 3000, 'the background task');
        const out = await restart(id);
        assert.strictEqual(out.status, 409);
        assert.strictEqual(out.body.background, 1);
        assert.ok(!out.body.busy);
        assert.strictEqual(pool.get(id), r, 'nothing replaced');
        const forced = await restart(id, { force: true });
        assert.strictEqual(forced.status, 200);
        assert.strictEqual(forced.body.restarted, true);
        assert.notStrictEqual(pool.get(id), r);
        ok('background work: 409 with the count, and force restarts anyway');
    }
})().then(() => finish(0)).catch((err) => {
    console.error(err && err.stack || err);
    finish(1);
});

async function finish(code) {
    for (const r of pool.runners.values()) {
        try { await r.stop({ hard: true }); } catch { /* already gone */ }
    }
    pool.shutdown({ force: true });
    await sleep(200);
    fs.rmSync(root, { recursive: true, force: true });
    if (!code) console.log(`\n${pass} restart-process checks passed`);
    process.exit(code);
}
