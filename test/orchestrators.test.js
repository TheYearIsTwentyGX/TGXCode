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

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-orch-')));
process.env.XDG_DATA_HOME = home;
// The cap case makes real worktrees, which have to be inside the allowed roots,
// and commits, which need somebody to have made them.
process.env.TGXCODE_ROOTS = home;
Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
});
const { execFileSync } = require('child_process');

const {
    Orchestrators, sortInbox, shouldNudge, usageTrip, usageTrips, resumeAtFor, cleanSettings, describeCounts,
    DEFAULT_SETTINGS,
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
        { window: 'five_hour', usedPercent: 50, percent: 50, resetsAt: null });
    assert.strictEqual(usageTrip(cleanSettings({ usageStop: { enabled: false, percent: 1 } }),
        [{ type: 'five_hour', usedPercent: 100 }]), null, 'off is off');
    assert.ok(usageTrip(cleanSettings({ usageStop: { window: 'seven_day', percent: 90 } }), ws));
    assert.strictEqual(usageTrip(s, [{ type: 'five_hour', usedPercent: null }]), null, 'no reading, no trip');
    const nowS = Math.floor(Date.now() / 1000);
    assert.strictEqual(usageTrip(s, [{ type: 'five_hour', usedPercent: 92, resetsAt: nowS - 60 }]), null,
        'a reading from before the window reset does not count');
    assert.ok(usageTrip(s, [{ type: 'five_hour', usedPercent: 92, resetsAt: nowS + 600 }]));
    ok('the usage cutoff trips at the threshold of the chosen window, and not when off');
}

{
    const s = cleanSettings({ maxRunning: 99, worktree: 'yes', usageStop: { percent: 0, window: 'nope' } });
    assert.deepStrictEqual(s, { ...DEFAULT_SETTINGS, usageStop: { ...DEFAULT_SETTINGS.usageStop } });
    assert.strictEqual(describeCounts([{ kind: 'turn' }, { kind: 'plan' }, { kind: 'turn' }]),
        '2 turn reports, 1 plan to approve');
    ok('bad settings fall back field by field; a nudge counts what is waiting');
}

{
    // "All limits": each window against its own threshold, any one trips it.
    const all = cleanSettings({ usageStop: { window: 'all', limits: { five_hour: 90, seven_day: 95 } } });
    const at = (fh, wk) => [{ type: 'five_hour', usedPercent: fh }, { type: 'seven_day', usedPercent: wk }];
    assert.deepStrictEqual(usageTrips(all, at(89, 94)), [], 'under both');
    assert.deepStrictEqual(usageTrips(all, at(91, 94)).map(t => t.window), ['five_hour'], 'five-hour alone');
    assert.deepStrictEqual(usageTrips(all, at(50, 96)).map(t => t.window), ['seven_day'], 'weekly alone');
    assert.deepStrictEqual(usageTrips(all, at(91, 96)).map(t => t.window), ['five_hour', 'seven_day']);
    const noWeekly = cleanSettings({ usageStop: { window: 'all', limits: { five_hour: 90, seven_day: null } } });
    assert.deepStrictEqual(usageTrips(noWeekly, at(50, 100)), [], 'a window left empty is ignored');
    assert.strictEqual(usageTrips(all, [{ type: 'five_hour', usedPercent: 99 }])[0].window, 'five_hour',
        'a window with no reading is skipped, not tripped');
    assert.strictEqual(cleanSettings({ usageStop: { window: 'nope' } }).usageStop.window, 'five_hour');
    assert.strictEqual(cleanSettings({ usageStop: { limits: { five_hour: 0 } } }).usageStop.limits.five_hour, 90,
        'a bad threshold keeps the old one');

    // When a pause can lift by itself: after the *last* tripped window resets.
    assert.strictEqual(resumeAtFor([{ resetsAt: 1000 }, { resetsAt: 5000 }]), 5000);
    assert.strictEqual(resumeAtFor([{ resetsAt: 1000 }, { resetsAt: null }]), null, 'one unknown: wait for Resume');
    assert.strictEqual(resumeAtFor([]), null);
    ok('"all limits" trips on any window past its own threshold; a pause waits for the last reset');
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

{
    // The everyday bridge loaded X long ago and never touched it; a dev bridge
    // turned X off since. The everyday bridge writing for an unrelated reason
    // must not put X back.
    const file = fileOf('stale');
    const everyday = new Orchestrators({ file });
    everyday.enable('X');
    everyday.enable('Y');
    everyday.flush();
    const dev = new Orchestrators({ file });
    dev.disable('X');
    dev.flush();
    everyday.push('Y', { kind: 'note', text: 'unrelated' });
    everyday.flush();
    const after = new Orchestrators({ file });
    assert.strictEqual(after.get('X'), null, 'the disabled orchestrator stays disabled');
    assert.strictEqual(after.unread('Y').length, 1, 'and the unrelated write still landed');
    assert.strictEqual(everyday.get('X'), null, 'the writer adopts the removal too');
    ok('a bridge writes only what it changed, so another bridge\'s removal sticks');
}

{
    const s = new Orchestrators({ file: fileOf('trim') });
    s.enable('O');
    s.push('O', { workerId: 'W', kind: 'plan', text: 'the plan', requestId: 'r1' });
    s.pull('O', 1);   // read, not yet answered
    for (let i = 0; i < 305; i++) {
        const row = s.push('O', { workerId: 'W', kind: 'turn', text: `t${i}` });
        if (i % 2) s.settle('O', row.id);
    }
    assert.ok(s.get('O').inbox.some(i => i.requestId === 'r1'),
        'a read but unanswered plan is never trimmed');
    assert.ok(s.get('O').inbox.length <= 305);
    ok('trimming a full inbox drops settled items, never an ask still waiting');

    s.addWorker('O', { id: 'W' });
    s.closeWorker('O', 'W');
    assert.strictEqual(s.get('O').inbox.find(i => i.requestId === 'r1').status, 'stale',
        'closing a worker settles the asks it left behind');
    ok('a closed worker\'s unanswered asks go stale, so the inbox can be trimmed again');
}

{
    // A newer build, or a torn file: unreadable is not empty, and must not be
    // written over with only what this bridge just changed.
    const file = fileOf('newer');
    const s = new Orchestrators({ file });
    s.enable('A');
    s.flush();
    const theirs = JSON.stringify({ version: 2, orchestrators: { A: {}, B: {}, C: {} } });
    fs.writeFileSync(file, theirs);
    s.push('A', { kind: 'note', text: 'x' });
    s.flush();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), theirs, 'the newer file is left alone');
    assert.ok(s.get('A'), 'and what this bridge holds is kept in memory');
    fs.writeFileSync(file, '{"version": 1, "orchestr');
    s.push('A', { kind: 'note', text: 'y' });
    s.flush();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"version": 1, "orchestr', 'a torn file too');
    ok('an unreadable or newer-format file is never written over');
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
    handOverQueue(why) { this.handedBack = { why, texts: this.queue.map(q => q.text) }; this.queue = []; }
    hasViewer() { return !!this.viewer; }
    denyPending(reason) { if (!this.pendingPermission) return false; this.denied = reason; this.pendingPermission = null; return true; }
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
        // Wake the moment a window resets, so the cases need not wait a minute.
        resumeGraceMs: 0,
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
        w.queue = [{ id: 'q1', text: 'carry on with the tests' },
            { id: 'q2', text: '<orchestrator-message from="O">\nalso fix the lint\n</orchestrator-message>' }];
        h.setWindows([{ type: 'five_hour', usedPercent: 81 }]);
        orchestration.checkUsage();
        assert.ok(h.store.get('O').paused, 'paused past the cutoff');
        assert.strictEqual(orch.stopped, 1);
        assert.strictEqual(w.stopped, 1);
        assert.deepStrictEqual(w.handedBack.texts, ['carry on with the tests'],
            'a queued message is handed back, not dropped');
        const bounced = h.store.unread('O').find(i => i.kind === 'note');
        assert.ok(bounced && /Not delivered/.test(bounced.text) && /also fix the lint/.test(bounced.text),
            'the orchestrator\'s own queued instruction comes back to its inbox');
        assert.ok(!/orchestrator-message/.test(bounced.text), 'without the envelope');
        orchestration.checkUsage();
        assert.strictEqual(w.stopped, 1, 'and not stopped again while paused');
        await assert.rejects(orchestration.spawn('O', { prompt: 'x', worktree: false }), /paused/);
        assert.throws(() => orchestration.resume('O'), /still over the cutoff/, 'no Resume while still over');
        assert.ok(h.store.get('O').paused);
        h.setWindows([{ type: 'five_hour', usedPercent: 10 }]);
        orchestration.resume('O');
        assert.strictEqual(h.store.get('O').paused, null);

        // A settings change checks that orchestrator even with nothing of it
        // running here — the state just after a bridge restart.
        h.runners.clear();
        h.store.setSettings('O', { usageStop: { window: 'seven_day_opus', percent: 50 } });
        h.setWindows([{ type: 'seven_day_opus', usedPercent: 60 }]);
        orchestration.checkUsage();
        assert.strictEqual(h.store.get('O').paused, null, 'the clock skips what this bridge does not run');
        orchestration.checkUsage('O');
        assert.match(h.store.get('O').paused.reason, /^seven-day-opus usage at 60%/);
        ok('the usage cutoff stops everything once, hands queued messages back, and Resume waits for it');
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

    {
        // 3:15, five-hour at 92% against 90, resetting shortly: stop everything,
        // wake at the reset, and tell the orchestrator who was cut off.
        const h = harness('wake');
        orchestration.enable('O', { usageStop: { window: 'all', limits: { five_hour: 90, seven_day: 95 },
            autoResume: true } });
        const orch = h.pool.ensure('O');
        orch.state = 'busy';
        h.store.addWorker('O', { id: 'W', title: 'tests' });
        const w = h.pool.ensure('W');
        w.state = 'busy';
        const reset = Date.now() + 800;
        h.setWindows([{ type: 'five_hour', usedPercent: 92, resetsAt: reset },
            { type: 'seven_day', usedPercent: 40, resetsAt: Date.now() + 86_400_000 }]);
        orchestration.checkUsage();
        const p = h.store.get('O').paused;
        assert.ok(p, 'paused');
        assert.strictEqual(p.resumeAt, reset, 'wakes when the five-hour window resets');
        assert.deepStrictEqual(p.interrupted.sort(), ['O', 'W'], 'and remembers who it stopped');
        await sleep(1200);
        assert.strictEqual(h.store.get('O').paused, null, 'the timer lifted the pause');
        const note = h.store.unread('O').find(i => i.kind === 'note');
        assert.ok(note && /window has reset/.test(note.text) && /"tests"/.test(note.text)
            && /own turn was stopped/.test(note.text), 'and the orchestrator is told what to pick up');
        ok('past the cutoff with auto-resume: stop everything, wake at the reset, say who was cut off');
    }

    {
        // Two windows over: it waits for the later reset, not the first.
        const h = harness('wake-two');
        orchestration.enable('O', { usageStop: { window: 'all', limits: { five_hour: 90, seven_day: 95 },
            autoResume: true } });
        h.pool.ensure('O');
        const fiveReset = Date.now() + 60_000;
        const weekReset = Date.now() + 3_600_000;
        h.setWindows([{ type: 'five_hour', usedPercent: 92, resetsAt: fiveReset },
            { type: 'seven_day', usedPercent: 97, resetsAt: weekReset }]);
        orchestration.checkUsage();
        assert.strictEqual(h.store.get('O').paused.resumeAt, weekReset);

        // No reset time for a tripped window: wait for Resume.
        const h2 = harness('wake-unknown');
        orchestration.enable('O2', { usageStop: { autoResume: true, percent: 50 } });
        h2.pool.ensure('O2');
        h2.setWindows([{ type: 'five_hour', usedPercent: 60 }]);
        orchestration.checkUsage();
        assert.strictEqual(h2.store.get('O2').paused.resumeAt, null);

        // Auto-resume off: no wake time; turning it on while paused starts one.
        const h3 = harness('wake-off');
        orchestration.enable('O3', { usageStop: { percent: 50 } });
        h3.pool.ensure('O3');
        const r3 = Date.now() + 120_000;
        h3.setWindows([{ type: 'five_hour', usedPercent: 60, resetsAt: r3 }]);
        orchestration.checkUsage();
        assert.strictEqual(h3.store.get('O3').paused.resumeAt, null, 'off: waits for Resume');
        h3.store.setSettings('O3', { usageStop: { autoResume: true } });
        orchestration.rearmPause('O3');
        assert.strictEqual(h3.store.get('O3').paused.resumeAt, r3, 'turned on while paused: the clock starts');
        h3.store.setSettings('O3', { usageStop: { autoResume: false } });
        orchestration.rearmPause('O3');
        assert.strictEqual(h3.store.get('O3').paused.resumeAt, null, 'and off again stops it');
        ok('a pause waits for the last reset, or for Resume when there is none to wait for');
    }

    {
        // The reset came but another window is still over: pause again for that.
        const h = harness('wake-again');
        orchestration.enable('O', { usageStop: { window: 'all', limits: { five_hour: 90, seven_day: 95 },
            autoResume: true } });
        h.pool.ensure('O');
        const soon = Date.now() + 300;
        h.setWindows([{ type: 'five_hour', usedPercent: 92, resetsAt: soon }]);
        orchestration.checkUsage();
        const later = Date.now() + 600_000;
        h.setWindows([{ type: 'five_hour', usedPercent: 92, resetsAt: soon },
            { type: 'seven_day', usedPercent: 99, resetsAt: later }]);
        await sleep(600);
        const p = h.store.get('O').paused;
        assert.ok(p, 'still paused');
        assert.strictEqual(p.resumeAt, later, 'now waiting for the weekly reset');
        assert.match(p.reason, /seven-day usage at 99%/);
        ok('waking into another window still over pauses again until that one resets');

        orchestration.forget('W');
        assert.strictEqual(h.store.roleOf('W'), null, 'a deleted worker leaves the list');
        assert.strictEqual(h.store.get('O').workers.length, 0);
        orchestration.forget('O');
        assert.strictEqual(h.store.get('O'), null, 'a deleted orchestrator stops being one');
        ok('deleting a session takes its part in an orchestration with it');
    }

    {
        const h = harness('orphans');
        orchestration.enable('O', null);
        h.store.addWorker('O', { id: 'W1' });
        h.store.addWorker('O', { id: 'W2' });
        const w1 = h.pool.ensure('W1');
        const w2 = h.pool.ensure('W2');
        w1.pendingPermission = { id: 'a' };
        w2.pendingPermission = { id: 'b' };
        w2.viewer = true;
        orchestration.disable('O');
        assert.match(w1.denied, /orchestrator went away/, 'nobody left to answer: denied');
        assert.match(w2.denied, /orchestrator went away/,
            'an open window elsewhere is not somebody answering this worker');
        ok('turning an orchestrator off denies its workers\' held asks');
    }

    {
        // The race the cap used to lose: a worker has no runner until its
        // worktree exists, so parallel spawns and a drain all saw free slots.
        const h = harness('race');
        const repo = path.join(home, 'repo');
        fs.mkdirSync(repo);
        execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
        fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
        execFileSync('git', ['-C', repo, 'add', '.']);
        execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'first']);
        orchestration.enable('O', { maxRunning: 2, worktree: true });
        const out = await Promise.all([1, 2, 3, 4].map(n =>
            orchestration.spawn('O', { prompt: `job ${n}`, title: `job ${n}`, cwd: repo })));
        assert.strictEqual(out.filter(o => !o.queued).length, 2, 'two start');
        assert.strictEqual(out.filter(o => o.queued).length, 2, 'two wait');
        assert.strictEqual(h.created.length, 2);

        h.store.setSettings('O', { maxRunning: 1 });
        for (const c of h.created) h.runners.get(c.sessionId).state = 'idle';
        orchestration.onTurnComplete({ sessionId: h.created[0].sessionId });
        await sleep(1500);
        assert.strictEqual(h.created.length, 3, 'a drain with one free slot starts exactly one');
        ok('the cap holds across parallel spawns and a drain, while worktrees are being made');
    }

    {
        // The first start fails (no repository to make a worktree in) after the
        // second was queued behind its reservation. Nothing else would ever drain
        // that queue: no worker is running to end a turn.
        const h = harness('failed-start');
        orchestration.enable('O', { maxRunning: 1 });
        const [first, second] = await Promise.allSettled([
            orchestration.spawn('O', { prompt: 'doomed', cwd: home, worktree: true }),
            orchestration.spawn('O', { prompt: 'next', worktree: false }),
        ]);
        assert.strictEqual(first.status, 'rejected');
        assert.strictEqual(second.value.queued, true);
        await sleep(50);
        assert.strictEqual(h.created.length, 1, 'the queued one starts once the failed one lets go');
        assert.strictEqual(h.created[0].prompt, 'next');
        ok('a start that fails gives its slot to the next queued worker');
    }
})().then(() => {
    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${pass} orchestrator checks passed`);
    process.exit(0);
}).catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
