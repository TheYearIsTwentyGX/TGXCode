'use strict';

// Orchestrator sessions — bridge/orchestrators.js (the store) and
// bridge/orchestration.js (what moves), with no bridge and no `claude`.
//
// The pool is a fake: a map of runners that are nothing but a `state`, a
// `status()` and a list of what was sent to them. Everything worth checking here
// is a decision the bridge makes — what goes in the inbox, in what order, when
// the orchestrator is told, when a spawn waits — and none of it needs a process.
//
// What it guards is the feature's one promise, which fails silently: **nothing
// a worker says reaches the orchestrator mid-turn.** A nudge sent while it is
// busy would not throw or log; it would be folded into its turn exactly like the
// interruption the inbox exists to prevent, and look like the feature working.
//
// XDG_DATA_HOME is set before any require, for later.test.js's reason: config.js
// builds STATE_DIR once, at load, and this must not touch the user's real one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-orch-'));
process.env.XDG_DATA_HOME = home;

const {
    Orchestrators, sortInbox, shouldNudge, usageTrip, cleanSettings, describeCounts, DEFAULT_SETTINGS,
} = require('../bridge/orchestrators');
const orchestration = require('../bridge/orchestration');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fileOf = (n) => path.join(home, `orch-${n}.json`);

// --- pure ------------------------------------------------------------------

{
    const items = [
        { kind: 'turn', seq: 1 }, { kind: 'update', seq: 2 }, { kind: 'plan', seq: 3 },
        { kind: 'done', seq: 4 }, { kind: 'question', seq: 5 }, { kind: 'permission', seq: 6 },
    ];
    assert.deepStrictEqual(sortInbox(items).map(i => i.seq), [3, 5, 6, 1, 2, 4]);
    ok('the inbox puts what a worker is blocked on first, oldest first within each');
}

{
    const o = (inbox, extra = {}) => ({ inbox, lastNudgedSeq: 0, paused: null, ...extra });
    const fresh = [{ status: 'new', seq: 3 }];
    assert.strictEqual(shouldNudge(o(fresh), null), true, 'no process is idle');
    assert.strictEqual(shouldNudge(o(fresh), { state: 'idle', queued: 0 }), true);
    assert.strictEqual(shouldNudge(o(fresh), { state: 'busy', queued: 0 }), false, 'never mid-turn');
    assert.strictEqual(shouldNudge(o(fresh), { state: 'starting', queued: 0 }), false);
    assert.strictEqual(shouldNudge(o(fresh), { state: 'idle', queued: 1 }), false, 'not with a message waiting');
    assert.strictEqual(shouldNudge(o(fresh), { state: 'idle', queued: 0, pendingPermission: {} }), false);
    assert.strictEqual(shouldNudge(o(fresh, { paused: { reason: 'x' } }), null), false, 'not while paused');
    assert.strictEqual(shouldNudge(o(fresh, { lastNudgedSeq: 3 }), null), false, 'not twice for the same item');
    assert.strictEqual(shouldNudge(o([{ status: 'read', seq: 9 }]), null), false, 'nothing unread');
    ok('a nudge goes only to an idle, unpaused orchestrator with something new');
}

{
    const s = cleanSettings({ usageStop: { percent: 50 } });
    const ws = [{ type: 'five_hour', usedPercent: 49.9 }, { type: 'seven_day', usedPercent: 99 }];
    assert.strictEqual(usageTrip(s, ws), null);
    assert.deepStrictEqual(usageTrip(s, [{ type: 'five_hour', usedPercent: 50 }]),
        { window: 'five_hour', usedPercent: 50, percent: 50 });
    assert.strictEqual(usageTrip(cleanSettings({ usageStop: { enabled: false, percent: 1 } }),
        [{ type: 'five_hour', usedPercent: 100 }]), null, 'off is off');
    assert.ok(usageTrip(cleanSettings({ usageStop: { window: 'seven_day', percent: 90 } }), ws));
    assert.strictEqual(usageTrip(s, [{ type: 'five_hour', usedPercent: null }]), null, 'no reading, no trip');
    ok('the usage cutoff trips at the threshold of the chosen window, and not when off');
}

{
    const s = cleanSettings({ maxRunning: 99, worktree: 'yes', usageStop: { percent: 0, window: 'nope' } });
    assert.deepStrictEqual(s, { ...DEFAULT_SETTINGS, usageStop: { ...DEFAULT_SETTINGS.usageStop } });
    assert.strictEqual(describeCounts([{ kind: 'turn' }, { kind: 'plan' }, { kind: 'turn' }]),
        '2 turn reports, 1 plan to approve');
    ok('bad settings fall back field by field; a nudge counts what is waiting');
}

// --- the store ---------------------------------------------------------------

{
    const s = new Orchestrators({ file: fileOf('roles') });
    s.enable('O');
    s.addWorker('O', { id: 'W', title: 'w', cwd: '/x' });
    assert.strictEqual(s.roleOf('O'), 'orchestrator');
    assert.strictEqual(s.roleOf('W'), 'worker');
    assert.strictEqual(s.roleOf('Z'), null);
    assert.throws(() => s.enable('W'), /one level deep/, 'a worker cannot be an orchestrator');
    s.enable('O2');
    assert.throws(() => s.addWorker('O', { id: 'O2' }), /cannot be a worker/);
    s.closeWorker('O', 'W');
    assert.strictEqual(s.roleOf('W'), null, 'a closed worker has no role');
    assert.deepStrictEqual(s.forSummary('W').worker, { orchestratorId: 'O', title: 'w', closed: true });
    ok('roles are one level deep, and a closed worker loses its tools');
}

{
    const file = fileOf('persist');
    const s = new Orchestrators({ file });
    s.enable('O', { settings: { maxRunning: 2 } });
    s.addWorker('O', { id: 'W', title: 'w' });
    s.push('O', { workerId: 'W', kind: 'turn', text: 'hello' });
    s.setSummary('O', 'all good');
    s.flush();
    const again = new Orchestrators({ file });
    assert.strictEqual(again.get('O').settings.maxRunning, 2);
    assert.strictEqual(again.orchestratorOf('W').id, 'O');
    assert.strictEqual(again.unread('O')[0].text, 'hello');
    assert.strictEqual(again.get('O').summary.text, 'all good');

    // Another bridge's orchestrator survives this one's write, and this one's
    // removal is not undone by the copy on disk.
    const other = new Orchestrators({ file });
    other.enable('P');
    other.flush();
    again.disable('O');
    again.flush();
    const third = new Orchestrators({ file });
    assert.ok(third.get('P'), 'the other bridge\'s orchestrator is kept');
    assert.strictEqual(third.get('O'), null, 'and the removal sticks');
    ok('the store round-trips, merges with another bridge, and keeps a removal');
}

{
    const s = new Orchestrators({ file: fileOf('pull') });
    s.enable('O');
    s.push('O', { workerId: 'W', kind: 'turn', text: '1' });
    s.push('O', { workerId: 'W', kind: 'plan', text: '2', requestId: 'r1' });
    s.push('O', { workerId: 'W', kind: 'update', text: '3' });
    assert.deepStrictEqual(s.pull('O', 2).map(i => i.text), ['2', '1']);
    assert.deepStrictEqual(s.unread('O').map(i => i.text), ['3']);
    assert.strictEqual(s.byRequest('W', 'r1'), null, 'W is not a worker of O, so no lookup');
    assert.strictEqual(s.pull('O', 5).length, 1);
    assert.strictEqual(s.pull('O', 5).length, 0);
    ok('pull takes the most urgent first and marks what it took read');
}

// --- orchestration, against a fake pool ---------------------------------------

class FakeRunner extends EventEmitter {
    constructor(id) {
        super();
        this.sessionId = id;
        this.state = 'idle';
        this.sent = [];
        this.queue = [];
        this.pendingPermission = null;
        this.lastResultText = null;
        this.answered = [];
        this.stopped = 0;
    }
    status() {
        return { sessionId: this.sessionId, state: this.state, queued: this.queue.length,
            queue: this.queue, pendingPermission: this.pendingPermission };
    }
    send(text) { this.sent.push(text); const e = { id: `q${this.sent.length}` }; return e; }
    answerPermission(requestId, decision, extra) {
        if (!this.pendingPermission || this.pendingPermission.id !== requestId) {
            return { ok: false, error: 'gone' };
        }
        this.answered.push({ requestId, decision, extra });
        this.pendingPermission = null;
        return { ok: true };
    }
    async stop() { this.stopped++; this.state = 'idle'; return { how: 'soft' }; }
}

function harness(name) {
    const runners = new Map();
    const created = [];
    const pool = {
        runners,
        get: (id) => runners.get(id) || null,
        ensure: (id) => { if (!runners.has(id)) runners.set(id, new FakeRunner(id)); return runners.get(id); },
        create: ({ sessionId, prompt }) => {
            const r = new FakeRunner(sessionId);
            r.state = 'busy';
            runners.set(sessionId, r);
            created.push({ sessionId, prompt });
            return { sessionId };
        },
        recycle: () => true,
    };
    const flagRows = new Map();
    const store = new Orchestrators({ file: fileOf(name) });
    let windows = [];
    orchestration.init({
        store, pool,
        index: { summary: (id) => ({ sessionId: id, cwd: home, title: id, permissionMode: 'auto' }),
            get: () => null, note: () => {} },
        flags: { get: (id) => flagRows.get(id) || { test: false }, set: (id, v) => flagRows.set(id, v) },
        prefs: { forCwd: () => ({ orchestrator: {} }) },
        usage: { snapshot: () => ({ windows }) },
        normalizeMode: (m) => m || 'auto',
        sessionCwd: (s) => s.cwd,
        tooManyCreates: () => false,
    });
    return { pool, runners, created, store, flagRows, setWindows: (w) => { windows = w; } };
}

(async () => {
    {
        const h = harness('flow');
        orchestration.enable('O', null);
        const orch = h.pool.ensure('O');
        h.store.addWorker('O', { id: 'W', title: 'worker' });
        const w = h.pool.ensure('W');

        // Busy orchestrator: the turn report is filed, and nothing is sent.
        orch.state = 'busy';
        w.lastResultText = 'finished step one';
        orchestration.onTurnComplete({ sessionId: 'W' });
        assert.strictEqual(h.store.unread('O').length, 1);
        assert.strictEqual(h.store.unread('O')[0].kind, 'turn');
        await sleep(2200);
        assert.strictEqual(orch.sent.length, 0, 'nothing reaches a busy orchestrator');

        // Idle again: one nudge, naming what is waiting.
        orch.state = 'idle';
        orchestration.onStatus(orch.status());
        await sleep(2200);
        assert.strictEqual(orch.sent.length, 1);
        assert.match(orch.sent[0], /1 item waiting.*1 turn report/s);

        // Nothing newer: going idle again does not nudge again.
        orchestration.onStatus(orch.status());
        await sleep(2200);
        assert.strictEqual(orch.sent.length, 1, 'one nudge per arrival, not per idle');

        // A `done` report stands in for that turn's report.
        orchestration.report('W', 'done', 'all done, PR #12');
        orchestration.onTurnComplete({ sessionId: 'W' });
        const kinds = h.store.unread('O').map(i => i.kind);
        assert.deepStrictEqual(kinds, ['turn', 'done']);
        ok('turn reports and reports are filed, and the nudge waits for idle and fires once');
    }

    {
        const h = harness('asks');
        orchestration.enable('O', null);
        h.pool.ensure('O').state = 'busy';
        h.store.addWorker('O', { id: 'W', title: 'worker' });
        const w = h.pool.ensure('W');
        w.pendingPermission = { id: 'req1' };
        orchestration.onPermissionRequest({ sessionId: 'W', requestId: 'req1', kind: 'plan',
            tool: 'ExitPlanMode', input: { plan: '1. do it' } });
        const [item] = h.store.pull('O', 1);
        assert.strictEqual(item.kind, 'plan');
        assert.strictEqual(item.text, '1. do it');

        orchestration.answer('O', item.id, 'allow', {});
        assert.strictEqual(w.answered[0].extra.mode, 'auto', 'an approved plan leaves plan mode');
        orchestration.onPermissionResolved({ sessionId: 'W', requestId: 'req1', outcome: 'plan-approved' });
        assert.strictEqual(h.store.item('O', item.id).by, 'orchestrator');
        assert.throws(() => orchestration.answer('O', item.id, 'allow', {}), /already resolved/);

        // The user answers one the orchestrator has already read: it is told.
        w.pendingPermission = { id: 'req2' };
        orchestration.onPermissionRequest({ sessionId: 'W', requestId: 'req2', kind: 'tool',
            tool: 'Bash', displayName: 'Bash', input: { command: 'rm -rf build' } });
        const [p2] = h.store.pull('O', 1);
        assert.match(p2.text, /rm -rf build/);
        orchestration.onPermissionResolved({ sessionId: 'W', requestId: 'req2', outcome: 'allow' });
        assert.strictEqual(h.store.item('O', p2.id).by, 'user');
        assert.match(h.store.unread('O')[0].text, /user answered/);

        // A superseded ask goes stale, and answering it says so.
        w.pendingPermission = { id: 'req3' };
        orchestration.onPermissionRequest({ sessionId: 'W', requestId: 'req3', kind: 'tool', tool: 'Bash', input: {} });
        const p3 = h.store.unread('O').find(i => i.requestId === 'req3');
        w.pendingPermission = null;
        assert.throws(() => orchestration.answer('O', p3.id, 'allow', {}), /no longer waiting/);
        assert.strictEqual(h.store.item('O', p3.id).status, 'stale');
        ok('a worker\'s asks are filed, answered by the orchestrator, and settled whoever answers');
    }

    {
        const h = harness('cap');
        orchestration.enable('O', { maxRunning: 1, worktree: false });
        const a = await orchestration.spawn('O', { prompt: 'first', title: 'A', worktree: false });
        assert.strictEqual(a.queued, false);
        const b = await orchestration.spawn('O', { prompt: 'second', title: 'B', worktree: false });
        assert.strictEqual(b.queued, true, 'over the cap, it waits');
        assert.strictEqual(h.created.length, 1);
        assert.strictEqual(h.store.roleOf(a.sessionId), 'worker', 'filed before the spawn');

        h.runners.get(a.sessionId).state = 'idle';
        orchestration.onTurnComplete({ sessionId: a.sessionId });
        await sleep(20);
        assert.strictEqual(h.created.length, 2, 'and starts when a turn ends');
        assert.strictEqual(h.created[1].prompt, 'second');
        ok('spawns past the cap are queued and drained in order');
    }

    {
        const h = harness('cutoff');
        orchestration.enable('O', { usageStop: { enabled: true, percent: 80, window: 'five_hour' } });
        const orch = h.pool.ensure('O');
        orch.state = 'busy';
        h.store.addWorker('O', { id: 'W', title: 'w' });
        const w = h.pool.ensure('W');
        w.state = 'busy';
        h.setWindows([{ type: 'five_hour', usedPercent: 79 }]);
        orchestration.checkUsage();
        assert.strictEqual(h.store.get('O').paused, null);
        h.setWindows([{ type: 'five_hour', usedPercent: 81 }]);
        orchestration.checkUsage();
        assert.ok(h.store.get('O').paused, 'paused past the cutoff');
        assert.strictEqual(orch.stopped, 1);
        assert.strictEqual(w.stopped, 1);
        orchestration.checkUsage();
        assert.strictEqual(w.stopped, 1, 'and not stopped again while paused');
        await assert.rejects(orchestration.spawn('O', { prompt: 'x', worktree: false }), /paused/);
        orchestration.resume('O');
        assert.strictEqual(h.store.get('O').paused, null);
        ok('the usage cutoff stops the orchestrator and its workers once, and Resume lifts it');
    }

    {
        const h = harness('briefs');
        orchestration.enable('O', null);
        h.store.addWorker('O', { id: 'W' });
        assert.match(orchestration.roleOf('O').brief, /You are an orchestrator/);
        assert.match(orchestration.roleOf('W').brief, /You are a worker/);
        assert.strictEqual(orchestration.roleOf('nobody'), null);
        ok('each role gets its own brief, and a session with none gets nothing');
    }
})().then(() => {
    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${pass} orchestrator checks passed`);
    process.exit(0);
}).catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
