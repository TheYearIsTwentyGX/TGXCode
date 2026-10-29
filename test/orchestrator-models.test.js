'use strict';

// Which model an orchestrator and its workers run with — bridge/models.js (the
// list), resolveWorkerModel in bridge/orchestrators.js (the precedence) and the
// wiring in bridge/orchestration.js and the runner pool.
//
// What it guards fails quietly in both directions. A fixed worker model that a
// spawn_worker argument slips past spends the quota the user fixed it to save;
// an orchestrator model the composer's next send quietly undoes looks like the
// setting saved and did nothing. And a model name nobody offers used to reach
// argv, where it is a worker that never starts rather than a refusal.
//
// The orchestrator's own model is checked against a real RunnerPool — the
// override lives in `ensure` and `_replace`, and a fake pool would test the
// fake. No process is started: a runner only spawns `claude` on its first send.
//
// XDG_DATA_HOME is set before any require, for orchestrators.test.js's reason.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tgx-orch-models-')));
process.env.XDG_DATA_HOME = home;
process.env.TGXCODE_ROOTS = home;

const models = require('../bridge/models');
const {
    Orchestrators, cleanSettings, resolveWorkerModel, DEFAULT_SETTINGS,
} = require('../bridge/orchestrators');
const orchestration = require('../bridge/orchestration');
const { RunnerPool } = require('../bridge/runner');

let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };
const S = (patch) => cleanSettings({ ...DEFAULT_SETTINGS, ...patch });

// --- the list ----------------------------------------------------------------
{
    assert.deepStrictEqual(models.MODEL_IDS, ['opus', 'sonnet', 'haiku', 'fable']);
    assert.ok(models.MODELS.every(m => m.note), 'each model has a line on when to use it');
    assert.deepStrictEqual(models.payload().efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepStrictEqual(require('../bridge/runner').EFFORTS, models.EFFORTS, 'the runner enforces the same levels');
    const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<option value="opus">/, 'the page does not keep a second list');
    ok('one list of models and efforts, which the runner and the page share');
}

// --- settings ------------------------------------------------------------------
{
    const d = cleanSettings({});
    assert.strictEqual(d.orchestratorModel, null);
    assert.strictEqual(d.orchestratorEffort, null);
    assert.strictEqual(d.workerModel, 'choose');
    assert.strictEqual(d.workerEffort, 'choose');
    assert.strictEqual(d.workerDefaultModel, null);
    assert.strictEqual(d.workerDefaultEffort, null);

    const s = cleanSettings({ orchestratorModel: 'opus', orchestratorEffort: 'high', workerModel: 'haiku',
        workerEffort: 'low', workerDefaultModel: 'sonnet', workerDefaultEffort: 'medium' });
    assert.deepStrictEqual([s.orchestratorModel, s.orchestratorEffort, s.workerModel, s.workerEffort,
        s.workerDefaultModel, s.workerDefaultEffort], ['opus', 'high', 'haiku', 'low', 'sonnet', 'medium']);

    // A bad value keeps what was there; null clears where null means something.
    const bad = cleanSettings({ orchestratorModel: 'gpt-5', workerModel: null, workerEffort: 'turbo',
        workerDefaultModel: null }, s);
    assert.strictEqual(bad.orchestratorModel, 'opus', 'an unknown model changes nothing');
    assert.strictEqual(bad.workerModel, 'haiku', 'workerModel has no null: it stays');
    assert.strictEqual(bad.workerEffort, 'low');
    assert.strictEqual(bad.workerDefaultModel, null, 'null clears a default');

    // Through the store, its merge and a reload from disk.
    const file = path.join(home, 'orch-settings.json');
    const store = new Orchestrators({ file });
    store.enable('O', { settings: cleanSettings({}) });
    store.setSettings('O', { orchestratorModel: 'sonnet', workerModel: 'haiku', workerDefaultEffort: 'low' });
    store.setSettings('O', { maxRunning: 2 });
    store.flush();
    const back = new Orchestrators({ file }).get('O').settings;
    assert.strictEqual(back.orchestratorModel, 'sonnet', 'a later PUT of another field keeps it');
    assert.strictEqual(back.workerModel, 'haiku');
    assert.strictEqual(back.workerDefaultEffort, 'low');
    assert.strictEqual(back.maxRunning, 2);
    store.setSettings('O', { orchestratorModel: null, workerModel: 'choose' });
    assert.strictEqual(store.get('O').settings.orchestratorModel, null, 'null hands it back to the composer');
    assert.strictEqual(store.get('O').settings.workerModel, 'choose');
    ok('the model settings default, validate, merge and survive a reload');
}

// --- worker model resolution -----------------------------------------------------
{
    const choose = S({});
    const withDefault = S({ workerDefaultModel: 'sonnet', workerDefaultEffort: 'low' });
    const fixed = S({ workerModel: 'haiku', workerEffort: 'medium' });

    let r = resolveWorkerModel(choose, { model: 'opus', effort: 'high' });
    assert.deepStrictEqual([r.model, r.effort, r.source.model, r.source.effort], ['opus', 'high', 'orchestrator', 'orchestrator']);
    assert.deepStrictEqual(r.overridden, { model: null, effort: null });

    r = resolveWorkerModel(choose, {});
    assert.deepStrictEqual([r.model, r.effort, r.source.model, r.source.effort], [null, null, 'inherit', 'inherit']);

    r = resolveWorkerModel(withDefault, {});
    assert.deepStrictEqual([r.model, r.effort, r.source.model], ['sonnet', 'low', 'default']);
    r = resolveWorkerModel(withDefault, { model: 'opus' });
    assert.deepStrictEqual([r.model, r.effort, r.source.model, r.source.effort], ['opus', 'low', 'orchestrator', 'default'],
        'an explicit choice beats the default, field by field');

    r = resolveWorkerModel(fixed, { model: 'opus', effort: 'high' });
    assert.deepStrictEqual([r.model, r.effort, r.source.model], ['haiku', 'medium', 'fixed']);
    assert.deepStrictEqual(r.overridden, { model: 'opus', effort: 'high' }, 'the reply can say what it overrode');
    r = resolveWorkerModel(fixed, { model: 'haiku' });
    assert.strictEqual(r.overridden.model, null, 'asking for the fixed one is not an override');
    r = resolveWorkerModel(fixed, {});
    assert.deepStrictEqual([r.model, r.overridden.model], ['haiku', null]);

    // A user task keeps the user's explicit picks under either policy, and
    // only where they made one.
    const task = { model: 'opus', effort: null };
    r = resolveWorkerModel(fixed, { model: 'sonnet' }, task);
    assert.deepStrictEqual([r.model, r.source.model, r.overridden.model], ['opus', 'user', null]);
    assert.deepStrictEqual([r.effort, r.source.effort], ['medium', 'fixed'], 'a gap the user left is the policy\'s');
    r = resolveWorkerModel(choose, { model: 'sonnet', effort: 'low' }, task);
    assert.deepStrictEqual([r.model, r.effort, r.source.effort], ['opus', 'low', 'orchestrator']);
    r = resolveWorkerModel(withDefault, {}, { model: null, effort: null });
    assert.deepStrictEqual([r.model, r.source.model], ['sonnet', 'default'], 'a task on inherit takes the default');
    ok('worker model: the user\'s task, then a fixed setting, then the orchestrator, then the default, then inherit');
}

// --- spawn, against a fake pool ----------------------------------------------------
function harness(name) {
    const created = [];
    const runners = new Map();
    const fake = (id) => ({ sessionId: id, state: 'busy', model: null, effort: null, queue: [],
        status() { return { state: this.state, queue: [], queued: 0, pendingPermission: null }; },
        send() { return { id: 'q' }; } });
    const pool = {
        get: (id) => runners.get(id) || null,
        ensure: (id) => { if (!runners.has(id)) runners.set(id, fake(id)); return runners.get(id); },
        create: (args) => {
            created.push(args);
            const r = fake(args.sessionId);
            Object.assign(r, { model: args.model, effort: args.effort });
            runners.set(args.sessionId, r);
            return { sessionId: args.sessionId };
        },
        recycle: () => true,
        emit: () => {},
    };
    const store = new Orchestrators({ file: path.join(home, `orch-${name}.json`) });
    const flagRows = new Map();
    orchestration.init({
        store, pool,
        index: { summary: (id) => ({ sessionId: id, cwd: home, title: id, permissionMode: 'auto' }),
            get: () => null, note: () => {} },
        flags: { get: (id) => flagRows.get(id) || {}, set: (id, v) => flagRows.set(id, v) },
        prefs: { forCwd: () => ({ orchestrator: {} }) },
        usage: { snapshot: () => ({ windows: [] }) },
        normalizeMode: (m) => m || 'auto',
        sessionCwd: (s) => s.cwd,
        tooManyCreates: () => false,
    });
    return { created, store, pool };
}

(async () => {
    {
        const h = harness('spawn-choose');
        orchestration.enable('O', { worktree: false, maxRunning: 5, workerDefaultModel: 'sonnet' });
        const a = await orchestration.spawn('O', { prompt: 'design', model: 'opus', effort: 'high' });
        assert.deepStrictEqual([h.created[0].model, h.created[0].effort], ['opus', 'high']);
        assert.deepStrictEqual(a.modelSource, { model: 'orchestrator', effort: 'orchestrator' });
        const b = await orchestration.spawn('O', { prompt: 'docs' });
        assert.deepStrictEqual([h.created[1].model, h.created[1].effort], ['sonnet', null]);
        assert.deepStrictEqual(b.modelSource, { model: 'default', effort: 'inherit' });

        const rows = orchestration.payload('O').workers;
        assert.deepStrictEqual(rows.map(w => [w.model, w.effort]), [['opus', 'high'], ['sonnet', null]],
            'the payload shows each worker\'s model');
        assert.deepStrictEqual(h.store.worker('O', b.sessionId).modelSource, { model: 'default', effort: 'inherit' });
        ok('let it choose: its model is used, and the default fills a gap');
    }

    {
        const h = harness('spawn-fixed');
        orchestration.enable('O', { worktree: false, maxRunning: 1, workerModel: 'haiku' });
        const a = await orchestration.spawn('O', { prompt: 'rename', model: 'opus' });
        assert.strictEqual(h.created[0].model, 'haiku', 'the fixed model wins');
        assert.deepStrictEqual(a.overridden, { model: 'opus', effort: null });
        // Queued: the reply already says what it will run on, and the start uses it.
        const q = await orchestration.spawn('O', { prompt: 'more', model: 'sonnet' });
        assert.strictEqual(q.queued, true);
        assert.strictEqual(q.model, 'haiku');
        assert.strictEqual(q.overridden.model, 'sonnet');
        h.pool.get(a.sessionId).state = 'idle';
        orchestration.drainSpawns('O');
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(h.created[1].model, 'haiku', 'a queued spawn starts with what was decided');

        // A task the user handed over keeps the user's model under a fixed policy.
        h.pool.get(h.created[1].sessionId).state = 'idle';
        const filed = orchestration.fileTask('O', { prompt: 'their task', cwd: home, model: 'fable', effort: 'max' });
        const t = await orchestration.spawn('O', { task: filed.item.id, model: 'haiku', worktree: false });
        assert.strictEqual(t.queued, false);
        const c = h.created.find(x => x.sessionId === t.sessionId);
        assert.deepStrictEqual([c.model, c.effort], ['fable', 'max']);
        assert.deepStrictEqual(t.modelSource, { model: 'user', effort: 'user' });
        ok('a fixed model overrides the orchestrator and says so, but not the user\'s own task');
    }

    {
        const h = harness('spawn-refuse');
        orchestration.enable('O', { worktree: false });
        await assert.rejects(orchestration.spawn('O', { prompt: 'x', model: 'gpt-5' }),
            (e) => e.status === 400 && /use one of: opus, sonnet, haiku, fable/.test(e.message));
        await assert.rejects(orchestration.spawn('O', { prompt: 'x', effort: 'turbo' }),
            (e) => e.status === 400 && /low, medium, high, xhigh, max/.test(e.message));
        assert.strictEqual(h.created.length, 0, 'nothing started');
        // A typo does not use up the user's task.
        const filed = orchestration.fileTask('O', { prompt: 'keep me', cwd: home });
        await assert.rejects(orchestration.spawn('O', { task: filed.item.id, model: 'sonet' }), (e) => e.status === 400);
        assert.strictEqual(h.store.item('O', filed.item.id).status !== 'resolved', true, 'the task is still open');
        ok('an unknown model or effort is refused with the list, before anything is claimed');
    }

    {
        // The brief lists the models and says whether the user fixed them.
        harness('brief');
        orchestration.enable('O', { worktree: false, workerModel: 'sonnet' });
        const brief = orchestration.roleOf('O').brief;
        for (const m of models.MODEL_IDS) assert.match(brief, new RegExp(`- ${m}: `));
        assert.match(brief, /Model: fixed by the user to sonnet/);
        assert.match(brief, /Effort: yours to choose per worker/);
        ok('the orchestrator\'s brief lists the models and the policy');
    }

    {
        // The orchestrator's own model, against a real pool.
        const store = new Orchestrators({ file: path.join(home, 'orch-own.json') });
        const pool = new RunnerPool();
        orchestration.init({
            store, pool,
            index: { summary: (id) => ({ sessionId: id, cwd: home, title: id, permissionMode: 'auto' }),
                get: () => null, note: () => {} },
            flags: { get: () => ({}), set: () => {} },
            prefs: { forCwd: () => ({ orchestrator: {} }) },
            usage: { snapshot: () => ({ windows: [] }) },
            normalizeMode: (m) => m || 'auto', sessionCwd: (s) => s.cwd, tooManyCreates: () => false,
        });
        orchestration.enable('O', { orchestratorModel: 'opus', orchestratorEffort: 'high' });

        // A send from the composer asking for something else still gets the setting.
        let r = pool.ensure('O', { cwd: home, model: 'sonnet', effort: 'low' });
        assert.deepStrictEqual([r.model, r.effort], ['opus', 'high'], 'the setting wins over a send');
        assert.strictEqual(pool.ensure('O', { cwd: home, model: 'haiku' }), r, 'and is not replaced for asking');

        // Changed while idle: replaced now, with the new model.
        store.setSettings('O', { orchestratorModel: 'haiku' });
        assert.strictEqual(orchestration.applyOwnModel('O'), 'now');
        r = pool.get('O');
        assert.deepStrictEqual([r.model, r.effort], ['haiku', 'high']);
        assert.strictEqual(orchestration.applyOwnModel('O'), null, 'nothing to do when it already matches');

        // Changed mid-turn: when the turn ends.
        r.state = 'busy';
        store.setSettings('O', { orchestratorModel: 'sonnet' });
        assert.strictEqual(orchestration.applyOwnModel('O'), 'after-turn');
        assert.strictEqual(pool.get('O').model, 'haiku', 'a turn in progress is not cut off');
        r.state = 'idle';
        pool.recycle('O');
        assert.strictEqual(pool.get('O').model, 'sonnet');

        // Only the effort set: the model is the composer's again.
        store.setSettings('O', { orchestratorModel: null });
        r = pool.ensure('O', { cwd: home, model: 'opus', effort: 'low' });
        assert.deepStrictEqual([r.model, r.effort], ['opus', 'high']);

        // Unset entirely: an ordinary session, as before.
        store.setSettings('O', { orchestratorEffort: null });
        r = pool.ensure('O', { cwd: home, model: 'haiku', effort: 'low' });
        assert.deepStrictEqual([r.model, r.effort], ['haiku', 'low']);
        assert.strictEqual(pool.settingsFor('W-not-an-orchestrator'), null);
        pool.shutdown({ force: true });
        ok('the orchestrator\'s own model is applied to its runner, now or after the turn, and steps aside when unset');
    }
})().then(() => {
    fs.rmSync(home, { recursive: true, force: true });
    console.log(`\n${pass} orchestrator model checks passed`);
    process.exit(0);
}).catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
