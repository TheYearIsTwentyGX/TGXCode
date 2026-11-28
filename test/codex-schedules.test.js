'use strict';

// Drafts, schedules and orchestrator workers carrying a `runtime`, and what
// changes when that runtime names its own sessions (docs/plans/23-codex.md,
// Phase 4).
//
//   node test/codex-schedules.test.js
//
// No bridge and no Codex. **Its own XDG_DATA_HOME, set before any require** —
// bridge/config.js builds STATE_DIR from it at load, and `drafts.json` and
// `schedules.json` there are shared with every other bridge on the machine,
// including the everyday one, whose older `clean()` would strip the field this
// test is about (CLAUDE.md, *Testing a schedule needs its own store*).
//
// The pool is a fake that behaves like a Codex start in the one way that
// matters here: `create` answers with the placeholder it was given, and the
// runner says `minted` with Codex's id a moment later.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-codex-sched-'));
// Inside the allowed roots, which a temp directory is not: the routes resolve it.
const REPO = path.join(__dirname, '..');
process.env.XDG_DATA_HOME = home;

const { Drafts, STATE_FILE: DRAFTS_FILE } = require('../bridge/drafts');
const { Schedules, STATE_FILE: SCHED_FILE } = require('../bridge/schedule');
const scheduler = require('../bridge/scheduler');
const { settled, mintedId } = require('../bridge/minted');
const { Orchestrators } = require('../bridge/orchestrators');
const { CodexAdapter } = require('../bridge/runtimes/codex/process');
const { verdictOf } = require('../bridge/schedule');
const { randomUUID } = require('crypto');

assert.ok(DRAFTS_FILE.startsWith(home) && SCHED_FILE.startsWith(home), 'the stores are this test\'s own');

let pass = 0;
const ok = (what) => { pass++; console.log(`  ok  ${what}`); };

/** A runner as the pool holds one: an emitter with the fields the callers read. */
function fakeRunner(id, runtime) {
    const r = new EventEmitter();
    r.sessionId = id;
    r.runtime = runtime;
    r.adapter = { product: runtime === 'codex' ? 'Codex' : 'Claude Code' };
    r.lastResultText = null;
    r.lastResultBody = null;
    r.status = () => ({ sessionId: r.sessionId, state: 'starting' });
    return r;
}

/**
 * A pool that starts Codex the way the real one does as far as ids go:
 * `create` returns the placeholder, and `minted` follows on the next tick with
 * the id Codex chose — on the runner and then on the pool, in that order.
 */
function fakePool({ fail = null } = {}) {
    const pool = new EventEmitter();
    pool.runners = new Map();
    pool.created = [];
    pool.get = (id) => pool.runners.get(id) || null;
    pool.create = (o) => {
        const placeholder = o.sessionId || randomUUID();
        pool.created.push({ ...o, sessionId: placeholder });
        const r = fakeRunner(placeholder, o.runtime || 'claude');
        pool.runners.set(placeholder, r);
        if ((o.runtime || 'claude') === 'codex') {
            setImmediate(() => {
                if (fail) { r.emit('failed', { message: fail, kind: 'codex-signed-out', unsent: [{ text: o.prompt }] }); return; }
                const to = `codex-${pool.created.length}`;
                r.sessionId = to;
                r.emit('minted', { from: placeholder, to });
                pool.runners.delete(placeholder);
                pool.runners.set(to, r);
                pool.emit('minted', { from: placeholder, to });
            });
        }
        return { sessionId: placeholder, status: r.status() };
    };
    return pool;
}

(async () => {
    // --- the stores ----------------------------------------------------------

    {
        const d = new Drafts();
        const claude = d.create({ cwd: '/p', prompt: 'one' });
        assert.strictEqual(claude.runtime, 'claude', 'a draft that names none is Claude\'s');
        const codex = d.create({ cwd: '/p', prompt: 'two', runtime: 'codex', model: 'gpt-6-luna' });
        assert.strictEqual(codex.runtime, 'codex', 'Save as draft with Codex picked keeps Codex');
        assert.strictEqual(d.update(codex.id, { prompt: 'two, edited' }).runtime, 'codex',
            'an edit that does not mention it leaves it alone');
        assert.strictEqual(d.update(codex.id, { runtime: 'claude' }).runtime, 'claude', 'and one that does changes it');
        d.update(codex.id, { runtime: 'codex' });
        d.flush();
        const back = new Drafts();
        assert.strictEqual(back.get(codex.id).runtime, 'codex', 'it survives the file');

        // A row written before the field existed reads as Claude.
        const data = JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8'));
        data.drafts.push({ id: 'old', cwd: '/p', prompt: 'from before', permissionMode: 'auto', createdAt: 1, updatedAt: 1 });
        fs.writeFileSync(DRAFTS_FILE, JSON.stringify(data));
        assert.strictEqual(new Drafts().get('old').runtime, 'claude');
        ok('a draft keeps its runtime through edits and the file, and an old one is Claude\'s');
    }

    {
        const s = new Schedules();
        const row = s.create({ cwd: '/p', prompt: 'review {{range}}', cron: '0 2 * * *', runtime: 'codex', test: true });
        assert.strictEqual(row.runtime, 'codex');
        assert.strictEqual(s.update(row.id, { cron: '0 3 * * *' }).runtime, 'codex');
        assert.strictEqual(s.create({ cwd: '/p', prompt: 'x', cron: '0 2 * * *' }).runtime, 'claude');
        s.flush();
        assert.strictEqual(new Schedules().get(row.id).runtime, 'codex', 'it survives the file');
        ok('a schedule row keeps its runtime');
    }

    // --- validation ------------------------------------------------------------

    {
        const { draftFields } = require('../bridge/routes/drafts');
        require('../bridge/routes/drafts').init({
            normalizeMode: (m) => m || 'auto', modeRefusal: () => null,
        });
        const who = { remote: false };
        const good = draftFields({ cwd: REPO, prompt: 'p', runtime: 'codex' }, who, { partial: false });
        assert.strictEqual(good.fields.runtime, 'codex');
        assert.strictEqual(draftFields({ cwd: REPO, prompt: 'p' }, who, { partial: false }).fields.runtime, 'claude',
            'absent is Claude, as POST /api/sessions reads it');
        const bad = draftFields({ cwd: REPO, prompt: 'p', runtime: 'gemini' }, who, { partial: false });
        assert.deepStrictEqual(bad, { error: 'unknown runtime: gemini', status: 400 },
            'refused at write time, as a start would refuse it');
        assert.ok(!('runtime' in draftFields({ prompt: 'q' }, who, { partial: true }).fields),
            'a PATCH that does not mention it does not set it');

        scheduler.init({ normalizeMode: (m) => m || 'auto', modeRefusal: () => null });
        const sf = scheduler.scheduleFields({ cwd: REPO, prompt: 'p', cron: '0 2 * * *', runtime: 'codex' }, who,
            { partial: false });
        assert.strictEqual(sf.fields.runtime, 'codex');
        assert.strictEqual(scheduler.scheduleFields({ cwd: REPO, prompt: 'p', cron: '0 2 * * *', runtime: 'x' }, who,
            { partial: false }).status, 400);
        ok('drafts and schedules refuse a runtime the bridge cannot start');
    }

    // --- waiting for the id ----------------------------------------------------

    {
        const pool = fakePool();
        const claude = pool.create({ cwd: '/p', prompt: 'p' });
        assert.deepStrictEqual(await settled(pool, claude, 'claude'), { out: claude },
            'a Claude start is answered at once, with the id we gave it');
        const codex = pool.create({ cwd: '/p', prompt: 'p', runtime: 'codex' });
        const got = await settled(pool, codex, 'codex');
        assert.strictEqual(got.out.sessionId, 'codex-2', 'a Codex start is answered with the id Codex chose');

        const failing = fakePool({ fail: 'Codex is not signed in.' });
        const f = await settled(failing, failing.create({ cwd: '/p', prompt: 'hello', runtime: 'codex' }), 'codex');
        assert.strictEqual(f.error, 'Codex is not signed in.');
        assert.strictEqual(f.kind, 'codex-signed-out');
        assert.deepStrictEqual(f.unsent, [{ text: 'hello' }], 'the message is handed back');

        const slow = fakeRunner('never', 'codex');
        const t = await mintedId(slow, 20);
        assert.ok(/did not open the conversation/.test(t.error), 'a start that never names itself is a failure');
        assert.strictEqual(slow.listenerCount('minted'), 0, 'and leaves no listener behind');
        ok('settled() answers with the minted id, the failure, or a timeout');
    }

    // --- a Codex schedule firing -------------------------------------------------

    {
        const s = new Schedules();
        const pool = fakePool();
        const labelled = new Map();
        const noted = [];
        const notes = [];
        scheduler.init({
            schedules: s, pool,
            flags: { set: (id, f) => labelled.set(id, f), get: () => ({}) },
            index: { note: (id) => noted.push(id) },
            notifications: { record: (e) => (notes.push(e), e) }, filed: () => {},
            normalizeMode: (m) => m || 'auto', modeRefusal: () => null,
            tooManyCreates: () => false, CREATE_LIMIT: { max: 10 },
        });
        const row = s.create({ cwd: REPO, prompt: 'Review the code. End with VERDICT: CLEAN, CONCERNS or BLOCK.',
            cron: '0 2 * * *', runtime: 'codex', test: true, permissionMode: 'dontAsk' });

        const out = await scheduler.runSchedule(row, { force: true });
        assert.ok(out.ok, out.error);
        assert.strictEqual(pool.created[0].runtime, 'codex', 'the run starts on Codex');
        assert.strictEqual(out.sessionId, 'codex-1', 'and is known by the id Codex minted');
        assert.ok(labelled.get('codex-1') && labelled.get('codex-1').test, 'the test label goes on that id');
        assert.ok(!labelled.has(pool.created[0].sessionId), 'not on the placeholder, which is never seen again');
        assert.deepStrictEqual(noted, ['codex-1']);

        // The turn ends. What the runner holds as its result text is what the
        // Codex adapter made of `turn/completed`: the last agentMessage.
        const adapter = new CodexAdapter({ rpc: async () => ({}) });
        const [end] = adapter.read({ method: 'turn/completed', params: { threadId: 'codex-1', turn: {
            id: 'turn-1', status: 'completed', durationMs: 900, items: [
                { type: 'agentMessage', id: 'm1', text: 'Looking at the range now.', phase: 'commentary' },
                { type: 'agentMessage', id: 'm2', text: 'One real problem.\n\nVERDICT: CONCERNS', phase: 'final_answer' },
            ] } } });
        assert.strictEqual(end.type, 'turn-end');
        assert.strictEqual(verdictOf(end.result.text), 'CONCERNS', 'the verdict is read from the last agentMessage');
        pool.get('codex-1').lastResultText = end.result.text;

        scheduler.noteScheduledOutcome({ sessionId: 'codex-1', isError: false });
        assert.strictEqual(s.get(row.id).lastOutcome, 'CONCERNS', 'and lands on the schedule that started it');
        assert.strictEqual(notes.length, 0, 'a test schedule files nothing');

        // A start that fails is a run that did not happen: an error on the row's
        // terms, nothing remembered, nothing labelled.
        const failing = fakePool({ fail: 'Codex is not signed in.' });
        scheduler.init({
            schedules: s, pool: failing, flags: { set: (id) => labelled.set(id, 'x'), get: () => ({}) },
            index: { note: () => {} }, notifications: { record: (e) => e }, filed: () => {},
            normalizeMode: (m) => m || 'auto', modeRefusal: () => null,
            tooManyCreates: () => false, CREATE_LIMIT: { max: 10 },
        });
        const before = labelled.size;
        const bad = await scheduler.runSchedule(row, { force: true });
        assert.deepStrictEqual({ ok: bad.ok, skip: bad.skip, error: bad.error },
            { ok: false, skip: 'error', error: 'Codex is not signed in.' });
        assert.strictEqual(labelled.size, before);
        ok('a runtime:"codex" schedule fires on Codex and reads its VERDICT: from the last agentMessage');
    }

    // --- orchestrator workers on Codex -------------------------------------------

    {
        const store = new Orchestrators({ file: path.join(home, 'orch.json') });
        store.enable('orch-1');
        store.addWorker('orch-1', { id: 'placeholder-w', title: 'w', cwd: '/p' });
        assert.strictEqual(store.roleOf('placeholder-w'), 'worker', 'the role is read off the placeholder at spawn');
        assert.ok(store.rekeyWorker('placeholder-w', 'thread-w'));
        assert.strictEqual(store.roleOf('thread-w'), 'worker', 'and off the minted id after it');
        assert.strictEqual(store.roleOf('placeholder-w'), null);
        assert.strictEqual(store.orchestratorOf('thread-w').id, 'orch-1',
            'a report from the minted id finds its orchestrator');
        assert.strictEqual(store.rekeyWorker('nobody', 'x'), false, 'a session that is no worker is left alone');
        store.flush();
        const again = new Orchestrators({ file: path.join(home, 'orch.json') });
        assert.strictEqual(again.roleOf('thread-w'), 'worker', 'the move is written down');
        ok('a worker is re-keyed to the id Codex minted');
    }

    {
        const { cleanTask, spawnOptsFromTask } = require('../bridge/orchestrators');
        const task = cleanTask({ prompt: 'p', cwd: '/w', runtime: 'codex', model: 'gpt-6-luna' });
        assert.strictEqual(task.runtime, 'codex', 'a task from a Codex draft remembers it');
        assert.strictEqual(spawnOptsFromTask(task, { model: 'opus' }).runtime, 'codex',
            'and the worker it becomes runs on Codex');
        assert.strictEqual(cleanTask({ prompt: 'p', cwd: '/w' }).runtime, 'claude');
        ok('a task carries the runtime its draft had');
    }

    {
        // The whole spawn, through bridge/orchestration.js, against the fake
        // pool: placed under a placeholder, re-keyed on `minted`, labelled and
        // answered under Codex's id.
        const orchestration = require('../bridge/orchestration');
        const store = new Orchestrators({ file: path.join(home, 'orch2.json') });
        const pool = fakePool();
        const labelled = new Map();
        orchestration.init({
            store, pool,
            index: { summary: () => ({ cwd: REPO }), note: () => {}, get: () => null },
            flags: { get: () => ({ test: true }), set: (id, f) => labelled.set(id, f) },
            prefs: { forCwd: () => ({}) }, usage: null,
            normalizeMode: (m) => m || 'auto', sessionCwd: (s) => s.cwd, tooManyCreates: () => false,
        });
        store.enable('orch-2');
        const item = store.push('orch-2', { kind: 'task', task: cleanTaskFor({ prompt: 'Do it on Codex', cwd: home,
            runtime: 'codex', test: true }) });
        const res = await orchestration.spawn('orch-2', { task: item.id, worktree: false, model: 'opus' });
        assert.strictEqual(pool.created[0].runtime, 'codex', 'the worker is started on Codex');
        assert.strictEqual(pool.created[0].model, null,
            'with Codex\'s default, not the Claude model the orchestrator named');
        assert.strictEqual(res.sessionId, 'codex-1', 'spawn_worker answers with the id Codex minted');
        assert.strictEqual(store.roleOf('codex-1'), 'worker');
        assert.strictEqual(store.roleOf(pool.created[0].sessionId), null, 'nothing is left under the placeholder');
        assert.ok(labelled.get('codex-1').test, 'a test orchestrator\'s worker is a test session, under its real id');
        ok('an orchestrator spawns a Codex worker from a Codex task');
    }

    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${pass} codex-schedules checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });

function cleanTaskFor(t) { return require('../bridge/orchestrators').cleanTask(t); }
