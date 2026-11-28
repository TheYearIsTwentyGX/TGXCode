'use strict';

// A Codex hook that fails, from the wire to the transcript.
//
// Codex writes nothing about a hook into the rollout (measured on 0.172.0), so
// the only record is the `hook/completed` notification. Four steps have to hold
// for it to be a row: the adapter turns a failed run into an event, a real
// Runner emits it, bridge/codex/hook-log.js keeps it once, and a read of the
// session lays it back among the rollout's events.
//
// The runs below are the shapes recorded from 0.172.0, paths shortened. The
// Runner is driven by the replay walker over plain.ndjson with those
// notifications put after its `turn/started`.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const FIX = path.join(__dirname, 'fixtures', 'codex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-'));
const THREAD = '01a218f8-f9d0-7ea3-857e-f3b0b8756bbc';          // plain's
const SESSIONS = path.join(root, 'codex', 'sessions');
const walker = path.join(root, 'codex-walker.js');

process.env.TGXCODE_PORT = '45944';
process.env.TGXCODE_PROJECTS_DIR = path.join(root, 'projects');
process.env.TGXCODE_CODEX_SESSIONS_DIR = SESSIONS;
process.env.XDG_CACHE_HOME = path.join(root, 'cache');
process.env.XDG_DATA_HOME = path.join(root, 'data');
fs.writeFileSync(walker, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(FIX, 'walker.js'))});\n`,
    { mode: 0o755 });
process.env.TGXCODE_CODEX_BIN = walker;

const run = (over) => ({
    id: 'session-start:0:/h/hooks.json', eventName: 'sessionStart', handlerType: 'command',
    executionMode: 'sync', scope: 'thread', sourcePath: '/h/hooks.json', source: 'user', displayOrder: 0,
    status: 'failed', statusMessage: null, startedAt: 1795884744, completedAt: 1795884744, durationMs: 2,
    entries: [{ kind: 'error', text: 'hook exited with code 1' }], ...over,
});
const FAILED = run();
const FINE = run({ id: 'user-prompt-submit:1:/h', eventName: 'userPromptSubmit', status: 'completed',
    entries: [{ kind: 'context', text: 'ok-context' }] });
const BLOCKED = run({ id: 'user-prompt-submit:2:/h', eventName: 'userPromptSubmit', status: 'blocked',
    entries: [{ kind: 'feedback', text: 'no prompts today' }] });

// plain.ndjson, with the three runs reported inside its turn.
const fixture = path.join(root, 'hooks.ndjson');
{
    const lines = fs.readFileSync(path.join(FIX, 'plain.ndjson'), 'utf8').split('\n').filter(Boolean);
    const at = lines.findIndex(l => JSON.parse(l).msg.method === 'turn/started') + 1;
    const turnId = JSON.parse(lines[at - 1]).msg.params.turn.id;
    lines.splice(at, 0, ...[FAILED, FINE, BLOCKED].map(r => JSON.stringify(
        { dir: 'recv', t: 1000, msg: { method: 'hook/completed', params: { threadId: THREAD, turnId, run: r } } })));
    fs.writeFileSync(fixture, lines.join('\n') + '\n');
}
process.env.FAKE_CODEX_FIXTURE = fixture;

const { Runner } = require('../bridge/runner.js');
const codex = require('../bridge/runtimes/codex/process.js');
const hookLog = require('../bridge/codex/hook-log.js');
const { SessionIndex } = require('../bridge/sessions.js');
const { STATE_DIR } = require('../bridge/config.js');

assert.ok(STATE_DIR.startsWith(root), `refusing to run: ${STATE_DIR} is not inside ${root}`);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    {
        const a = new codex.Adapter({ rpc: async () => ({}) });
        const read = (r) => a.read({ method: 'hook/completed', params: { threadId: 't', turnId: 'u', run: r } });
        assert.deepStrictEqual(read(FAILED), [{ type: 'hook-run', run: FAILED, turnId: 'u' }]);
        assert.strictEqual(read(BLOCKED).length, 1);
        assert.strictEqual(read(run({ status: 'stopped' })).length, 1);
        assert.deepStrictEqual(read(FINE), [], 'a hook that ran cleanly is not news');
        assert.deepStrictEqual(a.read({ method: 'hook/started', params: { run: run({ status: 'running' }) } }), []);
        ok('the adapter reports only the runs that went wrong');
    }

    const heard = [];
    {
        const r = new Runner({ sessionId: randomUUID(), cwd: root, isNew: true, runtime: 'codex',
            permissionMode: 'acceptEdits' });
        r.hasViewer = () => true;
        r.on('hook-run', (h) => heard.push(h));
        r.send('Reply with exactly: pong');
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && !(r.state === 'idle' && r.lastResultText === 'pong')) await sleep(20);
        assert.strictEqual(r.lastResultText, 'pong', 'the turn still ends as it did');
        assert.deepStrictEqual(heard.map(h => [h.sessionId, h.run.status]),
            [[THREAD, 'failed'], [THREAD, 'blocked']]);
        r.stop({ hard: true });
        ok('a real Runner emits them under the minted session id');
    }

    {
        const first = hookLog.record(THREAD, { run: FAILED, turnId: 'u', offset: 100, now: 1000 });
        assert.deepStrictEqual([first.kind, first.subtype, first.isError], ['system', 'hook_failed', true]);
        assert.strictEqual(first.text, 'The `sessionStart` hook failed: hook exited with code 1\n\n`/h/hooks.json`');
        assert.strictEqual(hookLog.record(THREAD, { run: FAILED, turnId: 'u', offset: 900, now: 2000 }), null,
            'an adopted process replays its log; the run is noted once');
        const second = hookLog.record(THREAD, { run: BLOCKED, turnId: 'u', offset: 500, now: 3000 });
        assert.strictEqual(second.subtype, 'hook_blocked');
        assert.match(second.text, /blocked the turn: no prompts today/);
        assert.strictEqual(hookLog.record(THREAD, { run: FINE }), null);
        assert.strictEqual(hookLog.record('../../etc/passwd', { run: FAILED }), null);
        assert.strictEqual(hookLog.list(THREAD).length, 2);
        ok('a failure is kept once, as the row it will be');

        const rows = [{ id: 'a', ts: new Date(500).toISOString() }, { id: 'b', ts: new Date(2500).toISOString() }];
        const ids = (from, to) => hookLog.merge(rows, THREAD, from, to).map(e => e.id);
        assert.deepStrictEqual(ids(0, null), ['a', first.id, 'b', second.id], 'laid in by time');
        assert.deepStrictEqual(ids(0, 500), ['a', first.id, 'b'], 'a window takes only what falls inside it');
        assert.deepStrictEqual(ids(500, null), ['a', 'b', second.id]);
        assert.strictEqual(hookLog.merge(rows, randomUUID()), rows);
        ok('a windowed read carries the notes inside it');

        for (let i = 0; i < hookLog.MAX_NOTES + 5; i++) {
            hookLog.record('00000000-0000-0000-0000-000000000001', { run: run({ startedAt: i }) });
        }
        assert.strictEqual(hookLog.list('00000000-0000-0000-0000-000000000001').length, hookLog.MAX_NOTES);
        ok('a hook that fails every time does not grow the file for ever');
    }

    {
        const dir = path.join(SESSIONS, '2026', '11', '26');
        fs.mkdirSync(dir, { recursive: true });
        const rollout = path.join(dir, `rollout-2026-11-26T11-48-19-${THREAD}.jsonl`);
        fs.copyFileSync(path.join(FIX, 'plain.rollout.jsonl'), rollout);
        const index = new SessionIndex();
        await index.rescan();
        const whole = index.read(THREAD);
        assert.deepStrictEqual(whole.events.filter(e => /^hook_/.test(e.subtype || '')).map(e => e.subtype),
            ['hook_failed', 'hook_blocked']);
        const tail = index.readSince(THREAD, 600);
        assert.ok(!tail.events.some(e => e.subtype === 'hook_failed'), 'noted before that offset');
        const none = index.readSince(THREAD, whole.offset);
        assert.deepStrictEqual(none.events, [], 'an unchanged file is still no news');
        ok('a read of the session shows them');
    }

    console.log(`\n${passed} passed`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
